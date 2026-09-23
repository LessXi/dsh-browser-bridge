/**
 * Automatic enrolment, from the service worker's side.
 *
 * The options page can fetch the token, but the worker is what actually dials —
 * and it is the half that runs with nobody watching, on a fresh install, before
 * any page has been opened. If it cannot enrol itself, a new person still has to
 * find the settings card and paste, which is the barrier this removes.
 *
 * The case worth the most care is not the happy path. It is the ordinary
 * ordering of events: someone installs the extension and *then* starts the
 * harness. A worker that gives up on its first attempt never notices `dsh web`
 * coming up, and the bridge looks broken until the browser is restarted — so the
 * retry is asserted, not assumed.
 *
 * `bootstrap.js` is exercised for real against real HTTP servers. Its import is
 * rewritten to an absolute URL by `loadServiceWorker`, because the module is
 * loaded from a `data:` URL and a relative specifier cannot resolve against one.
 */
import { createServer } from 'node:http'
import { connect } from 'node:net'

import { assert, test } from './harness.js'
import { awaitConnection, fakeHost, listener, loadServiceWorker } from './service-worker.js'

const TOKEN = '00112233445566778899aabbccddeeff'.repeat(2)

/**
 * The real `fetch`, captured while this module is imported.
 *
 * `run.js` imports every suite before running a single test, and
 * `panel-stream.test.js` replaces `globalThis.fetch` at module scope without ever
 * putting it back. Its stub answers `/browser-bridge/health` with a payload that
 * has no `enabled` field — so a worker enrolling through it never sees the off
 * switch, proceeds to the token route, and the stub forwards that one to the
 * real server. The result is a token request from a bridge the test had
 * deliberately switched off.
 *
 * The worker resolves `fetch` at call time (by design — see the note in
 * `options.js` about a stale captured global), so there is no way to inject one
 * from here. The fix is the same one `options.test.js` uses: put the real
 * function back for the duration of these tests, and prove it is the real one
 * first so a reordering fails loudly instead of quietly testing a stub.
 */
const realFetch = globalThis.fetch

{
  const port = await closedPort()
  let rejected = false
  try {
    await realFetch(`http://127.0.0.1:${port}/browser-bridge/health`, { mode: 'no-cors' })
  } catch {
    rejected = true
  }
  if (!rejected) {
    throw new Error(
      'globalThis.fetch was already replaced when bootstrap.test.js was imported, so the enrolment '
      + 'tests would run against another suite\'s stub. Another suite mutates it at module scope — fix '
      + 'that, or import this suite before it.',
    )
  }
}

/**
 * Run the rest of a test with the real `fetch` installed, restoring afterwards.
 *
 * @param {object} t - The test context, for cleanup registration.
 * @returns {void}
 */
function useRealFetch(t) {
  const previous = globalThis.fetch
  globalThis.fetch = realFetch
  t.onCleanup(() => {
    globalThis.fetch = previous
  })
}

/**
 * Wait for a condition, or give up and let the caller's assertion report it.
 *
 * A fixed sleep cannot support a negative assertion: "no token request happened"
 * is indistinguishable from "the worker had not got there yet" once the test
 * simply outwaits the delay. Waiting on the positive signal instead — the health
 * read that always precedes the enrolment decision — makes the negative one
 * mean something.
 *
 * @param {() => boolean} predicate - The liveness signal.
 * @param {number} [timeoutMs] - How long to wait.
 * @returns {Promise<void>} Resolves once the condition holds, or the budget ends.
 */
async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !predicate()) {
    await new Promise((ok) => setTimeout(ok, 25))
  }
}

/**
 * Serve the two routes the worker enrols through, over real HTTP.
 *
 * Both shapes are copied from `lib/index.js`: health carries `enabled` and
 * `tokenLength`, and the token route carries the token. Neither carries an
 * `access-control-allow-origin` header, and that absence is load-bearing — it is
 * what stops an ordinary page from reading the token while leaving the extension
 * able to.
 *
 * @param {object} [options] - What to serve.
 * @param {boolean} [options.enabled] - The bridge switch.
 * @param {string} [options.token] - The token to hand out.
 * @param {boolean} [options.serveToken] - Whether the token route exists at all.
 * @returns {Promise<object>} The server handle.
 */
async function enrollingServer(options = {}) {
  const state = {
    enabled: options.enabled !== false,
    token: options.token ?? TOKEN,
    serveToken: options.serveToken !== false,
    tokenRequests: 0,
    healthRequests: 0,
    upgrades: 0,
  }
  const server = createServer((req, res) => {
    const url = req.url ?? ''
    if (url.startsWith('/browser-bridge/health')) {
      state.healthRequests += 1
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ enabled: state.enabled, tokenLength: state.token.length }))
      return
    }
    if (url.startsWith('/api/browser-bridge/token') && state.serveToken) {
      state.tokenRequests += 1
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ token: state.token }))
      return
    }
    // The websocket upgrade is answered with a 401, the way `lib/index.js`
    // answers a token it does not accept. That keeps `connect()` on the
    // reconnect ladder instead of settling, which is what makes the retry
    // observable here.
    if (url.startsWith('/api/browser-bridge/ws')) {
      state.upgrades += 1
      res.writeHead(401).end()
      return
    }
    res.writeHead(404).end()
  })
  server.on('upgrade', (_req, socket) => {
    state.upgrades += 1
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    socket.destroy()
  })
  // A fixed port when the caller needs to start the harness *after* the worker,
  // which requires knowing the address in advance. `listen(0)` is the default
  // because a random port cannot collide with anything else in the suite.
  await new Promise((ok) => server.listen(options.port ?? 0, '127.0.0.1', ok))
  return {
    port: server.address().port,
    state,
    setEnabled: (value) => {
      state.enabled = value
    },
    close: () => new Promise((ok) => server.close(ok)),
  }
}

/**
 * A port nothing is listening on, chosen at random and confirmed by an actual
 * connection attempt.
 *
 * Random rather than one of a small fixed set, and that is a correctness fix,
 * not a preference. The retry test below *binds* its port partway through, so a
 * fixed candidate would be released back to the OS at teardown and could be
 * handed to a later `listen(0)` in this same file — at which point the previous
 * test's worker, still walking its reconnect ladder, would dial into the next
 * test's server and inflate its counters. That is exactly how this suite first
 * failed when run with the others: "a bridge switched off" saw one token request
 * it never made.
 *
 * Drawn from above the ephemeral range this machine uses (`listen(0)` takes
 * 1024-15000 here), so a collision with another suite's server is not plausible
 * either.
 *
 * @returns {Promise<number>} A port that refused a connection.
 */
async function closedPort() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = 45_000 + Math.floor(Math.random() * 5_000)
    const refused = await new Promise((resolve) => {
      const probe = connect({ port: candidate, host: '127.0.0.1' })
      probe.once('connect', () => {
        probe.destroy()
        resolve(false)
      })
      probe.once('error', () => {
        probe.destroy()
        resolve(true)
      })
    })
    if (refused) return candidate
  }
  throw new Error('every candidate port is occupied; this machine is unusually busy')
}

/**
 * A fake `chrome` with a working storage, which is what the worker writes to.
 *
 * `set` has to persist rather than resolve into nothing: the worker enrolls,
 * writes, reads back, and only then dials. A stub that dropped the value would
 * make a correct worker look like one that never got a token.
 *
 * `reads()` counts storage reads, which is the liveness signal the tests need.
 * Every path through `connect()` begins with `readSettings()`, so a read having
 * happened proves the worker reached its decision — and that is what makes a
 * later "no token request" mean "it declined" rather than "it had not started".
 * Without it, a negative assertion can only be supported by sleeping and hoping,
 * which passes for the wrong reason.
 *
 * @param {object} stored - The initial settings.
 * @returns {object} The namespace, with a `reads()` counter.
 */
function chromeWithStorage(stored) {
  const store = { ...stored }
  let readCount = 0
  return {
    reads: () => readCount,
    runtime: {
      id: 'test',
      getManifest: () => ({ version: '0.0.0' }),
      onInstalled: listener(),
      onStartup: listener(),
      onMessage: listener(),
    },
    i18n: { getUILanguage: () => 'en-US' },
    storage: {
      local: {
        get: (defaults) => {
          readCount += 1
          return Promise.resolve({ ...defaults, ...store })
        },
        set: (values) => {
          Object.assign(store, values)
          return Promise.resolve()
        },
      },
      onChanged: listener(),
    },
    alarms: { create: () => {}, onAlarm: listener() },
    action: { onClicked: listener() },
    contextMenus: { removeAll: () => Promise.resolve(), create: () => {}, onClicked: listener() },
    sidePanel: { open: () => Promise.resolve(), setPanelBehavior: () => Promise.resolve() },
    tabs: { query: () => Promise.resolve([]), get: () => Promise.resolve(undefined), onCreated: listener(), onRemoved: listener(), onUpdated: listener(), onActivated: listener() },
    debugger: { getTargets: () => Promise.resolve([]), onDetach: listener(), onEvent: listener() },
  }
}

test('a worker with no token enrols itself and dials without anyone pasting', async (t) => {
  useRealFetch(t)
  const server = await enrollingServer()
  t.onCleanup(() => server.close())
  const chrome = chromeWithStorage({ port: String(server.port), token: '', autoPushSelection: false })
  const teardown = await loadServiceWorker(chrome)
  t.onCleanup(() => teardown())

  // The proof is the token route being read at all: without enrolment the worker
  // never asks, because the old code returned early on an empty token.
  await waitFor(() => server.state.tokenRequests > 0)
  assert.ok(server.state.tokenRequests >= 1, 'the worker never asked the harness for a token')

  const stored = await chrome.storage.local.get({ token: '' })
  assert.equal(stored.token, TOKEN, 'the fetched token was not stored, so the dial would have nothing to present')
})

test('a worker that finds no harness keeps trying, so starting dsh web later still connects', async (t) => {
  useRealFetch(t)
  // The ordering that actually happens: install the extension first, start the
  // harness second. A worker that gave up on attempt one would never notice — the
  // bridge would look broken until the browser was restarted.
  //
  // The harness really is absent here, rather than present-and-refusing, because
  // that is the situation the retry exists for.
  const port = await closedPort()
  const chrome = chromeWithStorage({ port: String(port), token: '', autoPushSelection: false })
  const teardown = await loadServiceWorker(chrome)
  t.onCleanup(() => teardown())

  // Let the first attempts fail against the closed port.
  await waitFor(() => chrome.reads() > 0)
  await new Promise((ok) => setTimeout(ok, 500))

  // Now bring the harness up, on the port the worker has been trying.
  const server = await enrollingServer({ port })
  t.onCleanup(() => server.close())

  await waitFor(() => server.state.tokenRequests > 0, 15000)
  assert.ok(
    server.state.tokenRequests >= 1,
    'the worker stopped retrying, so a harness started after the extension would never be found',
  )
})

test('a bridge switched off in DSH is not enrolled against', async (t) => {
  // Someone who turned the bridge off in DSH Settings meant it. Fetching a token
  // anyway would make that switch a decoration.
  useRealFetch(t)
  const server = await enrollingServer({ enabled: false })
  t.onCleanup(() => server.close())
  const chrome = chromeWithStorage({ port: String(server.port), token: '', autoPushSelection: false })
  const teardown = await loadServiceWorker(chrome)
  t.onCleanup(() => teardown())

  // The health read is the liveness signal, and waiting for it is what makes the
  // negative assertion below mean something: a fixed sleep cannot tell "the
  // worker declined" apart from "the worker had not got there yet".
  //
  // It stays a stable assertion because the worker keeps retrying a bridge it
  // cannot enrol with, so every retry re-reads health and never reads the token.
  await waitFor(() => server.state.healthRequests > 0)
  assert.ok(server.state.healthRequests >= 1, 'the health route was never read, so the switch was never consulted')

  await new Promise((ok) => setTimeout(ok, 300))
  assert.equal(server.state.tokenRequests, 0, 'a token was fetched from a bridge the person had switched off')
})

test('a token cleared by a person is not put back by the automatic path', async (t) => {
  // Clearing the field is how someone disconnects this extension on purpose, and
  // it leaves `manualToken` set with an empty token — which is the *only* state
  // where the two code paths disagree. A non-empty manual token never reaches
  // the enrolment branch at all (`token.length === 0` is already false), so a
  // test that used one would pass whether or not the guard existed. Measured
  // exactly that: with the `!settings.manualToken` condition removed, this test
  // is the one that goes red.
  useRealFetch(t)
  const server = await enrollingServer({ token: 'f'.repeat(64) })
  t.onCleanup(() => server.close())
  const chrome = chromeWithStorage({
    port: String(server.port),
    token: '',
    manualToken: true,
    autoPushSelection: false,
  })
  const teardown = await loadServiceWorker(chrome)
  t.onCleanup(() => teardown())

  // Reading the settings proves the worker reached its decision; without that,
  // "no token request" would also hold for a worker that never started.
  await waitFor(() => chrome.reads() > 0)
  await new Promise((ok) => setTimeout(ok, 300))

  assert.equal(server.state.tokenRequests, 0, 'a token was put back after the person cleared it to disconnect')
  const stored = await chrome.storage.local.get({ token: '' })
  assert.equal(stored.token, '', 'the cleared token was restored behind the person\'s back')
})

test('a token typed by a person is used instead of fetching another', async (t) => {
  // The steady state for anyone who pasted by hand. Nothing here should reach
  // the token route: the worker already holds what it needs.
  useRealFetch(t)
  const server = await enrollingServer({ token: 'f'.repeat(64) })
  t.onCleanup(() => server.close())
  const chrome = chromeWithStorage({
    port: String(server.port),
    token: 'a'.repeat(64),
    manualToken: true,
    autoPushSelection: false,
  })
  const teardown = await loadServiceWorker(chrome)
  t.onCleanup(() => teardown())

  // It dials immediately with what it holds, so the upgrade attempt is the proof
  // that it got past `readSettings` without asking for a token.
  await waitFor(() => server.state.upgrades > 0)
  assert.ok(server.state.upgrades >= 1, 'the worker never tried to dial, so this proves nothing')
  assert.equal(server.state.tokenRequests, 0, 'a manually set token was replaced by an automatic one')

  const stored = await chrome.storage.local.get({ token: '' })
  assert.equal(stored.token, 'a'.repeat(64), 'the manual token was changed')
})

test('enrolment does not interfere with a worker that already has a token', async (t) => {
  // The ordinary steady state. The worker must dial the token it holds rather
  // than re-fetching one on every start.
  useRealFetch(t)
  const host = await fakeHost(TOKEN)
  t.onCleanup(() => host.close())
  const chrome = chromeWithStorage({
    port: String(host.port),
    token: TOKEN,
    autoPushSelection: false,
  })
  const teardown = await loadServiceWorker(chrome)
  t.onCleanup(() => teardown())

  await awaitConnection(host)
  assert.equal(chrome.reads() > 0, true, 'the worker never read its settings')
})
