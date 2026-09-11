/**
 * The browser bridge: one websocket the extension connects to, and a request /
 * response and event protocol over it.
 *
 * The host owns this socket; the extension is the client. The direction matters
 * for the failure mode that hurts most — a tool call that never settles. Every
 * in-flight request is settled when the socket closes, so a closed Chrome, a
 * reloaded extension, or a crash all surface as an ordinary tool error rather
 * than a hung turn.
 *
 * Protocol (JSON text frames, one message per frame):
 *   host → extension   `{ id, method, params }`      a request
 *   extension → host   `{ id, ok: true, value }`     its answer
 *   extension → host   `{ id, ok: false, code, message }`
 *   extension → host   `{ event, payload }`          an unsolicited event
 *
 * @module dsh-browser-bridge/bridge
 */

/** Stable failure codes, so a tool can phrase its own diagnostic. */
export const BRIDGE_ERRORS = Object.freeze({
  notConnected: 'bridge-not-connected',
  disconnected: 'bridge-disconnected',
  timeout: 'bridge-timeout',
  cancelled: 'bridge-cancelled',
  transport: 'bridge-transport',
  remote: 'bridge-remote',
})

/** Thrown for every bridge failure; callers switch on `code`. */
export class BridgeError extends Error {
  /**
   * @param {string} code - One of {@link BRIDGE_ERRORS}.
   * @param {string} message - Human-readable diagnostic.
   * @param {Record<string, unknown>} [details] - Extra context for the message.
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.details = details
  }
}

/** Default per-call budget when the caller names none. */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Parse one inbound frame into either an answer or an event.
 *
 * Malformed input is reported rather than thrown, so one bad frame cannot take
 * the socket down and strand every other call.
 *
 * @param {unknown} data - The frame's text.
 * @returns {{ kind: 'answer', id: number, ok: boolean, value?: unknown, code?: string, message?: string }
 *   | { kind: 'event', event: string, payload: unknown }
 *   | { kind: 'invalid', reason: string }} The parsed frame.
 */
export function parseFrame(data) {
  if (typeof data !== 'string') return { kind: 'invalid', reason: 'frame is not a text payload' }
  let parsed
  try {
    parsed = JSON.parse(data)
  } catch {
    return { kind: 'invalid', reason: 'frame is not valid JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null) return { kind: 'invalid', reason: 'frame is not a JSON object' }

  if (typeof parsed.event === 'string') {
    return { kind: 'event', event: parsed.event, payload: parsed.payload }
  }
  if (typeof parsed.id !== 'number') return { kind: 'invalid', reason: 'frame has neither a numeric id nor an event name' }
  if (parsed.ok === true) return { kind: 'answer', id: parsed.id, ok: true, value: parsed.value }
  if (parsed.ok === false) {
    return {
      kind: 'answer',
      id: parsed.id,
      ok: false,
      code: typeof parsed.code === 'string' ? parsed.code : BRIDGE_ERRORS.remote,
      message: typeof parsed.message === 'string' ? parsed.message : 'the extension reported a failure',
    }
  }
  return { kind: 'invalid', reason: 'frame has no boolean "ok"' }
}

/**
 * One live connection to the extension.
 *
 * Owns the pending-request table, the timeout budgets, and the settlement of
 * every outstanding call when the socket dies.
 */
export class BrowserConnection {
  /** @type {Map<number, { resolve: (value: unknown) => void, reject: (error: Error) => void, timer: NodeJS.Timeout, method: string }>} */
  #pending = new Map()
  #nextId = 1
  #closed = false
  /** @type {Map<string, Set<(payload: unknown) => void>>} */
  #listeners = new Map()

  /**
   * @param {import('ws').WebSocket} socket - The accepted socket.
   * @param {{ onClose?: (connection: BrowserConnection) => void, describe?: () => string }} [options] - Lifecycle hooks.
   */
  constructor(socket, options = {}) {
    this.socket = socket
    this.id = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
    this.openedAt = Date.now()
    this.describe = options.describe ?? (() => 'unknown')
    this.onClose = options.onClose

    socket.on('message', (data, isBinary) => {
      this.#ingest(isBinary ? data : data.toString())
    })
    socket.on('close', () => this.#settleAll(BRIDGE_ERRORS.disconnected, 'the extension closed the connection'))
    socket.on('error', (error) => {
      this.#settleAll(BRIDGE_ERRORS.transport, `bridge transport error: ${error.message}`)
    })
  }

  /** Whether this connection can still carry calls. */
  get live() {
    return !this.#closed && this.socket.readyState === this.socket.OPEN
  }

  /** How many calls are waiting for an answer. */
  get pendingCount() {
    return this.#pending.size
  }

  /**
   * Subscribe to an extension-pushed event.
   * @param {string} event - Event name.
   * @param {(payload: unknown) => void} listener - Called per event.
   * @returns {() => void} Unsubscribe.
   */
  on(event, listener) {
    const listeners = this.#listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.#listeners.set(event, listeners)
    return () => listeners.delete(listener)
  }

  /**
   * Ask the extension to run one method.
   *
   * @param {string} method - Method name, e.g. `tabs.list`.
   * @param {unknown} [params] - Method parameters; must be JSON-serializable.
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] - Budget and cancellation.
   * @returns {Promise<unknown>} The extension's value.
   * @throws {BridgeError} On disconnect, timeout, cancellation, or a remote failure.
   */
  call(method, params, options = {}) {
    if (!this.live) {
      return Promise.reject(new BridgeError(
        BRIDGE_ERRORS.notConnected,
        'the browser extension is not connected; open Chrome with the extension installed and confirm its port and token',
      ))
    }
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs) : DEFAULT_TIMEOUT_MS
    const signal = options.signal
    if (signal?.aborted === true) {
      return Promise.reject(new BridgeError(BRIDGE_ERRORS.cancelled, 'the call was cancelled before it was sent'))
    }

    const id = this.#nextId
    this.#nextId += 1

    return new Promise((resolve, reject) => {
      /**
       * Unregister this call and clear its timer. Exactly one of the paths
       * below runs per call, so the map entry and the timer never leak.
       * @param {Error | undefined} error - Non-null to reject.
       * @param {unknown} [value] - The resolution value.
       */
      const settle = (error, value) => {
        const entry = this.#pending.get(id)
        if (entry === undefined) return
        this.#pending.delete(id)
        clearTimeout(entry.timer)
        signal?.removeEventListener('abort', onAbort)
        if (error !== undefined) reject(error)
        else resolve(value)
      }

      const onAbort = () => settle(new BridgeError(BRIDGE_ERRORS.cancelled, `the ${method} call was cancelled`))
      signal?.addEventListener('abort', onAbort, { once: true })

      const timer = setTimeout(() => {
        settle(new BridgeError(BRIDGE_ERRORS.timeout, `the extension did not answer ${method} within ${timeoutMs} ms`))
      }, timeoutMs)

      this.#pending.set(id, { resolve, reject, timer, method })

      try {
        this.socket.send(JSON.stringify({ id, method, params: params ?? null }))
      } catch (error) {
        settle(new BridgeError(BRIDGE_ERRORS.transport, `could not send ${method}: ${error.message}`))
      }
    })
  }

  /** Close the socket and settle every outstanding call. */
  close() {
    this.#settleAll(BRIDGE_ERRORS.disconnected, 'the bridge connection was closed')
    try {
      this.socket.close()
    } catch {
      // A socket that is already gone is not an error worth surfacing.
    }
  }

  /**
   * Route one inbound frame.
   * @param {string | Buffer} data - Raw frame text.
   */
  #ingest(data) {
    const text = typeof data === 'string' ? data : data.toString('utf8')
    const frame = parseFrame(text)
    if (frame.kind === 'invalid') {
      this.socket.emit('bridge-protocol-error', frame.reason)
      return
    }
    if (frame.kind === 'event') {
      for (const listener of this.#listeners.get(frame.event) ?? []) {
        try {
          listener(frame.payload)
        } catch {
          // A misbehaving listener must not break the socket's read loop.
        }
      }
      return
    }

    const entry = this.#pending.get(frame.id)
    if (entry === undefined) return
    this.#pending.delete(frame.id)
    clearTimeout(entry.timer)
    if (frame.ok) {
      entry.resolve(frame.value)
      return
    }
    entry.reject(new BridgeError(
      frame.code ?? BRIDGE_ERRORS.remote,
      frame.message ?? `the extension failed ${entry.method}`,
    ))
  }

  /**
   * Fail every outstanding call with one reason, then mark the connection dead.
   * Idempotent: the close and error handlers both call it.
   *
   * @param {string} code - A {@link BRIDGE_ERRORS} member.
   * @param {string} message - The reason given to every waiter.
   */
  #settleAll(code, message) {
    if (this.#closed) return
    this.#closed = true
    const pending = [...this.#pending.values()]
    this.#pending.clear()
    for (const entry of pending) {
      clearTimeout(entry.timer)
      entry.reject(new BridgeError(code, `${message} (while awaiting ${entry.method})`))
    }
    this.onClose?.(this)
  }
}

/**
 * Holds the single active extension connection.
 *
 * Single-slot on purpose: this bridge drives one browser profile, and a second
 * connection would make "which tab does the model mean" ambiguous.
 */
export class BridgeRegistry {
  /** @type {BrowserConnection | undefined} */
  #connection
  /** @type {Set<() => void>} */
  #changeListeners = new Set()

  /** The active connection, when one is live. */
  get connection() {
    return this.#connection?.live === true ? this.#connection : undefined
  }

  /** Whether an extension is currently connected. */
  get connected() {
    return this.connection !== undefined
  }

  /**
   * Adopt a freshly accepted socket, replacing any previous connection.
   * @param {import('ws').WebSocket} socket - The accepted socket.
   * @param {{ describe?: () => string }} [options] - Identity for status output.
   * @returns {BrowserConnection} The adopted connection.
   */
  adopt(socket, options = {}) {
    const previous = this.#connection
    if (previous !== undefined) {
      // A reloaded extension reconnects before the old socket's close event
      // arrives; closing it here keeps `connection` single-valued.
      previous.close()
    }
    const connection = new BrowserConnection(socket, {
      describe: options.describe,
      onClose: (closed) => {
        if (this.#connection === closed) this.#connection = undefined
        this.#notify()
      },
    })
    this.#connection = connection
    this.#notify()
    return connection
  }

  /**
   * Observe connect/disconnect transitions.
   * @param {() => void} listener - Called after every transition.
   * @returns {() => void} Unsubscribe.
   */
  onChange(listener) {
    this.#changeListeners.add(listener)
    return () => this.#changeListeners.delete(listener)
  }

  /** Drop the active connection, if any. */
  dispose() {
    this.#connection?.close()
    this.#connection = undefined
    this.#changeListeners.clear()
  }

  /** Notify observers, containing each one's failure. */
  #notify() {
    for (const listener of [...this.#changeListeners]) {
      try {
        listener()
      } catch {
        // Observers are informational; one failing must not break the others.
      }
    }
  }
}
