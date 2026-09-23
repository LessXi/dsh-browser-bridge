/**
 * Shared harness for tests that drive the real service worker.
 *
 * `extension/background.js` is a module with no exports: everything interesting
 * happens behind the WebSocket frame handler it installs on import. Two suites
 * now need to drive it that way — the toolbar badge, which no screenshot can
 * see, and the tab list, whose wire shape no screenshot can see either — and
 * both need the same three things: a fake `chrome`, a fake host to dial, and a
 * way to load the module fresh against them.
 *
 * It cannot be a real-Chrome test. Chrome 137 removed `--load-extension`, so an
 * unpacked extension cannot be loaded into a test browser at all; that was
 * measured on Chrome 153, in both headed and headless mode, not assumed.
 *
 * @module dsh-browser-bridge/test/service-worker
 */

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { resolvePeer } from '../lib/deps.js'

/** The extension directory, resolved from this file rather than the cwd. */
const extensionDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'extension')

/**
 * The peer websocket implementation, resolved the same way the host resolves it.
 *
 * `ws` is CommonJS, so its classes hang off the default export rather than the
 * module namespace — a named destructure would be silently `undefined`, which is
 * how this was first written and how it failed.
 *
 * @returns {Promise<{ WebSocketServer: Function }>} The class.
 */
async function wsModule() {
  const namespace = await import(pathToFileURL(resolvePeer('ws')).href)
  const module = namespace.default ?? namespace
  return { WebSocketServer: module.WebSocketServer }
}

/**
 * A listener list that remembers nothing, for the events a test does not drive.
 * @returns {object} The add/remove pair Chrome expects.
 */
export const listener = () => ({ addListener: () => {}, removeListener: () => {} })

/** How many times the service worker has been loaded in this process. */
let loadCount = 0

/**
 * Load the real service worker module against a fake `chrome`.
 *
 * The module's own top-level `connect()` runs on import and will try to open a
 * socket; it is pointed at the fake host the caller starts, so that attempt is
 * the connection under test rather than a stray dial-out.
 *
 * Each call must produce a *distinct* module URL. `import()` caches by URL, so a
 * second test would otherwise silently receive the first test's module — still
 * holding the first test's `chrome`, and already past its listener registration.
 * That is not hypothetical: it is exactly how the second badge test first
 * failed, reporting that the worker had never registered a detach listener when
 * the truth was that this function had handed back the previous instance.
 *
 * A teardown hook is appended to the source. The worker retries a dropped
 * connection with `setTimeout` — correct in a browser, where that is how an
 * evicted worker comes back — but in Node an armed `setTimeout` keeps the
 * process alive, so a suite that loaded this module would print its results and
 * then never exit. The hook is appended rather than edited in because it is
 * purely a way to stop the loop from outside; nothing in the shipped file
 * changes.
 *
 * @param {object} chrome - The fake namespace.
 * @returns {Promise<() => void>} Resolves with this instance's teardown.
 */
export async function loadServiceWorker(chrome) {
  // The module reads `globalThis.chrome` (see its own comment about optional
  // chaining), so this assignment is the whole injection — and it has to be
  // undone afterwards. The suites share one process and run in filename order,
  // so a suite that installs this stub would otherwise replace the next suite's:
  // that leak showed up as seven unrelated panel tests failing on a missing
  // `openOptionsPage`, in a file the offending test never touches.
  const previousChrome = globalThis.chrome
  globalThis.chrome = chrome
  const source = readFileSync(join(extensionDir, 'background.js'), 'utf8')
    // Its relative imports have to resolve, so they are rewritten to absolute
    // file URLs rather than being stripped — the real dictionaries, the real
    // distiller and the real enrolment are part of what is being exercised.
    .replace(
      /from '\.\/(page-distill|locales|bootstrap)\.js'/g,
      (_whole, name) => `from '${pathToFileURL(join(extensionDir, `${name}.js`)).href}'`,
    )
  // A trailing statement carrying a unique marker is what makes the URL new. It
  // has to be part of the source rather than a query string, because a `data:`
  // URL is matched on its whole text.
  const unique = (loadCount += 1)
  const epilogue = `
globalThis.__dshTeardown${unique} = () => {
  if (reconnectTimer !== undefined) clearTimeout(reconnectTimer)
  reconnectTimer = undefined
  reconnectDelay = RECONNECT_MAX_MS
  scheduleReconnect = () => {}
  try { socket?.close() } catch {}
  socket = undefined
}
`
  await import(`data:text/javascript;base64,${Buffer.from(source + epilogue).toString('base64')}`)
  const instanceTeardown = globalThis[`__dshTeardown${unique}`]
  delete globalThis[`__dshTeardown${unique}`]
  // The fake stays installed for the duration of the test, because the module
  // resolves `chrome` against the global at each call rather than capturing it:
  // restoring it here would mean the frame under test reached the *previous*
  // suite's stub. It is put back in the teardown, which runs after the test body.
  return () => {
    instanceTeardown()
    globalThis.chrome = previousChrome
  }
}

/**
 * Start a host-side websocket server that accepts the extension's dial-out.
 *
 * @param {string} token - The token the extension will present.
 * @returns {Promise<{ port: number, send: (frame: object) => void, connected: Promise<void>, close: () => void }>} The server.
 */
export async function fakeHost(token) {
  const { WebSocketServer } = await wsModule()
  const wss = new WebSocketServer({ noServer: true })
  const server = createServer((request, response) => response.writeHead(404).end())
  let socket
  let announce
  const connected = new Promise((resolve) => {
    announce = resolve
  })
  /** Answers to request frames, keyed by the id the caller chose. */
  const answers = new Map()
  /**
   * Frames the worker sent on its own, in arrival order.
   *
   * Request frames carry an `id` and are matched to `answers`; everything else is
   * the worker speaking unprompted — `bridge/hello` on connect, for instance. That
   * traffic had no reader here, so a payload the worker stopped sending looked
   * the same as one it sent correctly.
   */
  const notifications = []

  server.on('upgrade', (request, raw) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname !== '/api/browser-bridge/ws' || url.searchParams.get('token') !== token) {
      raw.destroy()
      return
    }
    wss.handleUpgrade(request, raw, Buffer.alloc(0), (ws) => {
      socket = ws
      ws.on('message', (raw) => {
        let parsed
        try {
          parsed = JSON.parse(raw.toString())
        } catch {
          return
        }
        const settle = answers.get(parsed?.id)
        if (settle !== undefined) {
          answers.delete(parsed.id)
          settle(parsed)
          return
        }
        if (typeof parsed?.event === 'string') notifications.push(parsed)
      })
      announce()
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  return {
    port,
    connected,
    answers,
    notifications,
    send: (frame) => socket.send(JSON.stringify(frame)),
    /**
     * Stop the fake host.
     *
     * Every client is terminated before `wss.close()` is called, because
     * `WebSocketServer.close()` does not invoke its callback while any client is
     * still connected — it only stops accepting new ones and waits. The
     * extension reconnects on its own (a settings change, a keepalive alarm, or
     * the worker being restarted all dial again), so at teardown there is
     * routinely a live socket here. Awaiting the callback in that state hangs
     * the cleanup, and because the whole suite runs in one process, one hung
     * cleanup stops every test after it from ever running.
     *
     * Measured: `.tmp-run/probe-wss-close.js` — the callback never fired in 3s
     * with a client connected, and fired immediately once the client was
     * terminated.
     */
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) {
          try {
            client.terminate()
          } catch {
            // A client that is already gone needs no terminating.
          }
        }
        try {
          socket?.close()
        } catch {
          // Already gone; closing the servers is what matters.
        }
        wss.close(() => server.close(() => resolve()))
      }),
  }
}

/**
 * Wait for a condition, or fail the test rather than hanging it.
 *
 * A suite that parks forever is worse than one that fails: the project's runner
 * executes every suite in one process, so an unresolved promise here would stop
 * the 400-odd tests after this file from ever running.
 *
 * @param {() => boolean} predicate - The condition.
 * @param {string} description - What is being waited for.
 * @param {number} [timeoutMs] - How long to wait.
 * @returns {Promise<void>} Resolves once the condition holds.
 */
export async function until(predicate, description, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${description}`)
}

/**
 * Wait for the extension to dial in, or fail the test rather than hang it.
 *
 * The module's `connect()` runs on import, so nothing dials if the import was
 * not actually executed. Without a deadline that is not a failed test but a
 * stalled run: every suite after this file stops executing. It was exactly how
 * this harness first broke, when two suites each counted module loads from
 * their own zero.
 *
 * The deadline is generous on purpose. A cached `data:` URL and a machine too
 * busy to finish the import look the same from here, and the original 5s made
 * the second one fail under parallel load — a validation tool that reports a
 * product defect when its own deadline slipped is worse than a slow one, so the
 * budget is set to miss only a genuine stall.
 *
 * @param {{ connected: Promise<void>, port: number }} host - The fake host.
 * @param {number} [timeoutMs] - How long to wait.
 * @returns {Promise<void>} Resolves once the extension has connected.
 */
export async function awaitConnection(host, timeoutMs = 15000) {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `the service worker never connected to the fake host on port ${host.port} within ${timeoutMs}ms. ` +
              'Two causes look identical here, so check both: the module URL was served from cache ' +
              '(two suites generating the same `data:` text — see `loadCount`), or the machine was too ' +
              'loaded to finish the import inside the deadline.',
          ),
        ),
      timeoutMs,
    )
  })
  try {
    await Promise.race([host.connected, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Ask the loaded worker one question over the socket and wait for its answer.
 *
 * The worker answers every request frame with `{ id, ok, value }`, so the answer
 * is the only way to read what it computed. Waiting on the id rather than on a
 * timer keeps the test deterministic on a loaded machine.
 *
 * @param {object} host - The fake host from {@link fakeHost}.
 * @param {object} frame - The request frame, without the id.
 * @returns {Promise<object>} The decoded answer.
 */
export function ask(host, frame, id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer to ${frame.method} within 3000ms`)), 3000)
    host.answers.set(id, (answer) => {
      clearTimeout(timer)
      resolve(answer)
    })
    host.send({ id, ...frame })
  })
}
