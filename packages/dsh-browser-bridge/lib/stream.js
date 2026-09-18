/**
 * Live assistant-output relay: agent stream frames → coalesced notifications.
 *
 * The harness commits an `assistant/message` to the session log only once a
 * whole model attempt finishes, so anything that reads the transcript sees
 * nothing until a step lands — which is why the panel used to answer a prompt
 * with silence and then a finished paragraph.
 *
 * The agent loop also publishes every raw provider chunk as it arrives, on the
 * agent-scoped `agent/assistant-stream` event (`dsh-agent-loop/lib/index.js`
 * around line 1031 emits `{ frame }`; `dsh-tool-cordis` declares the signature
 * as `'agent/assistant-stream'(this: Scoped<Agent>, payload: { agent, frame })`).
 * That is the same channel the harness's own web UI renders as typing.
 *
 * Two shape details decide the whole module:
 *
 *   - A frame carries an `attemptId`, not a session id. The attempt id is
 *     `${sessionId}:${attempt}`, so the session is recovered from the prefix and
 *     the panel can ignore output belonging to other sessions.
 *   - Frames arrive once per token. Forwarding each one would put thousands of
 *     websocket frames per reply on the wire, so text accumulates per
 *     session-and-kind and is flushed on a short timer.
 *
 * The frames themselves are transient: nothing here is durable, and a dropped
 * notification costs at most the rest of the current animation because the
 * committed transcript is still the source of truth.
 *
 * @module dsh-browser-bridge/stream
 */

import { NOTIFICATIONS } from './protocol.js'

/** How long output accumulates before it is flushed. */
export const DEFAULT_FLUSH_MS = 80

/**
 * Recover the session id from an attempt id.
 *
 * @param {unknown} attemptId - `${sessionId}:${attempt}`, or anything else.
 * @returns {string | undefined} The session id, when the shape matches.
 */
export function sessionOfAttempt(attemptId) {
  if (typeof attemptId !== 'string') return undefined
  const at = attemptId.indexOf(':')
  if (at <= 0) return undefined
  return attemptId.slice(0, at)
}

/**
 * Reduce one stream frame to what the panel can use.
 *
 * Only three chunk kinds render as text: assistant text, reasoning, and the name
 * of a tool the model just started calling. Everything else in the chunk union
 * (`block-end`, provider-specific frames) is already represented by the
 * committed transcript the panel polls — **except `finish`**, which carries the
 * only live word on whether the attempt failed.
 *
 * @param {unknown} frame - An `AssistantStreamFrame`.
 * @returns {{ kind: 'text' | 'reasoning' | 'tool', text: string } | { kind: 'start' | 'end', failed?: boolean } | undefined} The delta, or undefined when nothing should be sent.
 */
export function deltaOfFrame(frame) {
  if (typeof frame !== 'object' || frame === null) return undefined
  if (frame.type === 'start') return { kind: 'start' }
  if (frame.type === 'end') {
    // `outcome` is NOT the word on failure, and treating it as one was wrong.
    // `AssistantStreamAttempt.settle()` marks the attempt terminal *before* the
    // agent loop's catch can call `abandon()`, and the failing path settles an
    // `assistant/attempt` event first (`dsh-agent-loop/lib/index.js:1081`), so a
    // turn that died still reports `{kind:'committed'}` here — identical to a
    // turn that succeeded. Measured: a `MISSING_CREDENTIAL` turn produced
    // `ends:1, failed:0`. The failure signal lives in the `finish` chunk below.
    return { kind: 'end' }
  }
  if (frame.type !== 'chunk') return undefined

  const chunk = frame.chunk
  if (typeof chunk !== 'object' || chunk === null) return undefined

  // Field names come from the harness's own assembler
  // (`dsh-llm/lib/types/assembler.js`): deltas accumulate `chunk.text`, and a
  // tool call announces itself through `chunk.name` before its arguments
  // stream in through `argumentsDelta`.
  if (chunk.type === 'text-delta' && typeof chunk.text === 'string') return { kind: 'text', text: chunk.text }
  if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') return { kind: 'reasoning', text: chunk.text }
  if (chunk.type === 'tool-call-delta' && typeof chunk.name === 'string' && chunk.name !== '') {
    return { kind: 'tool', text: chunk.name }
  }
  if (chunk.type === 'finish') {
    // `adapterFailureChunk` (`dsh-llm/lib/index.js:2337`) converts an adapter
    // throw into a terminal `finish` whose reason is `error` or `aborted`; a
    // missing API key, a rejected route or an unreachable provider all arrive
    // here. This is the ONLY live frame that says a turn died — the durable
    // `turn/end` event says it too, but only after the turn is over, so the
    // panel would sit on a dead shimmer in between.
    //
    // `aborted` means the turn was stopped on purpose, which the panel already
    // shows as its own action, so it must not be reported as a failure.
    const reason = chunk.reason
    if (typeof reason === 'object' && reason !== null && reason.kind === 'error') {
      const message = reason.failure?.message
      return { kind: 'failed', text: typeof message === 'string' ? message : '' }
    }
  }
  return undefined
}

/**
 * Turns agent stream frames into coalesced notifications for the extension.
 *
 * Delivery is best-effort by design: no extension connected means the text is
 * discarded, not buffered, because the panel will re-read the committed
 * transcript anyway and a stale animation would only be wrong.
 */
export class AssistantStreamRelay {
  #bridge
  #log
  #flushMs
  #setTimer
  #clearTimer
  /** @type {Map<string, { sessionId: string, kind: string, text: string }>} */
  #buffers = new Map()
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #timer
  #stats = { frames: 0, ignored: 0, flushes: 0, notifications: 0, dropped: 0, ends: 0, failed: 0 }

  /**
   * @param {{ bridge?: { connection?: { notify: (name: string, payload: unknown) => boolean } }, log?: (message: string) => void, flushMs?: number, timers?: { set?: typeof setTimeout, clear?: typeof clearTimeout } }} [options] - Relay ports.
   */
  constructor(options = {}) {
    this.#bridge = options.bridge
    this.#log = options.log ?? (() => {})
    this.#flushMs = Number.isFinite(options.flushMs) ? Math.max(0, options.flushMs) : DEFAULT_FLUSH_MS
    this.#setTimer = options.timers?.set ?? setTimeout
    this.#clearTimer = options.timers?.clear ?? clearTimeout
  }

  /**
   * Subscribe to the agent loop's stream frames.
   *
   * @param {{ on: (event: string, listener: (payload: unknown) => void) => (() => void) | undefined }} ctx - A Cordis context whose `on` returns an unsubscribe function.
   * @returns {() => void} Detach the subscription.
   */
  attach(ctx) {
    const off = ctx.on('agent/assistant-stream', (payload) => {
      this.accept(payload)
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }

  /**
   * Accept one `agent/assistant-stream` payload.
   *
   * Exposed separately from {@link attach} so tests can drive the relay
   * without a Cordis context.
   *
   * @param {unknown} payload - `{ agent, frame }`.
   */
  accept(payload) {
    if (typeof payload !== 'object' || payload === null) {
      this.#stats.ignored += 1
      return
    }
    this.acceptFrame(payload.frame)
  }

  /**
   * Accept one stream frame.
   *
   * @param {unknown} frame - An `AssistantStreamFrame`.
   */
  acceptFrame(frame) {
    this.#stats.frames += 1
    const delta = deltaOfFrame(frame)
    if (delta === undefined) {
      this.#stats.ignored += 1
      return
    }

    const sessionId = sessionOfAttempt(frame?.attemptId)
    if (sessionId === undefined) {
      // Without a session the panel could not tell whose text this is, and
      // showing it under the wrong conversation would be worse than not
      // animating at all.
      this.#stats.ignored += 1
      return
    }

    if (delta.kind === 'start') {
      this.#send({ sessionId, kind: 'start' })
      return
    }

    if (delta.kind === 'failed') {
      // The turn is over and it died. Counted apart from `ends` so a failed turn
      // shows up in the health payload — a failure reported only to the person
      // watching is still invisible to whoever is diagnosing the install.
      this.#stats.failed += 1
      // Flush first: the buffered tail belongs to this attempt, and the panel
      // stops animating on `failed` just as it does on `end`.
      this.flush()
      this.#send({ sessionId, kind: 'failed', ...(delta.text === '' ? {} : { text: delta.text }) })
      return
    }

    if (delta.kind === 'end') {
      this.#stats.ends += 1
      // Flush first: the buffered tail belongs to this attempt, and `end` tells
      // the panel to stop animating and re-read the committed transcript.
      this.flush()
      this.#send({ sessionId, kind: 'end' })
      return
    }

    const key = `${sessionId}\u0000${delta.kind}`
    const entry = this.#buffers.get(key)
    if (entry === undefined) this.#buffers.set(key, { sessionId, kind: delta.kind, text: delta.text })
    else entry.text += delta.text

    this.#schedule()
  }

  /** Send whatever has accumulated, right now. */
  flush() {
    if (this.#timer !== undefined) {
      this.#clearTimer(this.#timer)
      this.#timer = undefined
    }
    if (this.#buffers.size === 0) return
    const entries = [...this.#buffers.values()]
    this.#buffers.clear()
    this.#stats.flushes += 1
    for (const entry of entries) this.#send(entry)
  }

  /** Flush, drop the timer, and stop counting. */
  dispose() {
    this.flush()
    if (this.#timer !== undefined) {
      this.#clearTimer(this.#timer)
      this.#timer = undefined
    }
    this.#buffers.clear()
  }

  /** How many bytes of text are waiting to go out. For tests and diagnostics. */
  buffered() {
    let total = 0
    for (const entry of this.#buffers.values()) total += entry.text.length
    return total
  }

  /** Counters, so a silent relay is distinguishable from an idle one. */
  stats() {
    return { ...this.#stats, buffered: this.#buffers.size }
  }

  /** Arm the flush timer unless one is already pending. */
  #schedule() {
    if (this.#timer !== undefined) return
    this.#timer = this.#setTimer(() => {
      this.#timer = undefined
      this.flush()
    }, this.#flushMs)
    // A pending flush must never hold the process open: the panel re-reads the
    // transcript anyway, so the last few milliseconds of animation do not
    // justify delaying shutdown.
    if (typeof this.#timer?.unref === 'function') this.#timer.unref()
  }

  /**
   * Deliver one notification, counting what could not be delivered.
   *
   * @param {{ sessionId: string, kind: string, text?: string }} payload - Notification body.
   */
  #send(payload) {
    const connection = this.#bridge?.connection
    if (connection === undefined || typeof connection.notify !== 'function') {
      this.#stats.dropped += 1
      return
    }
    const sent = connection.notify(NOTIFICATIONS.assistantDelta, payload)
    if (sent) this.#stats.notifications += 1
    else this.#stats.dropped += 1
  }
}

/**
 * Build a relay.
 *
 * @param {ConstructorParameters<typeof AssistantStreamRelay>[0]} [options] - Relay ports.
 * @returns {AssistantStreamRelay} The relay.
 */
export function createStreamRelay(options = {}) {
  return new AssistantStreamRelay(options)
}
