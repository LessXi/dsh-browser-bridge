/**
 * The options page's token diagnosis.
 *
 * This page is the gate: nothing works until someone pastes a token here, and
 * the only thing that tells them whether they pasted it right is the strip at
 * the bottom. That strip used to answer "wrong token" and "dsh web is not
 * running" with the same sentence — `cannotConnect` plus three checks, one of
 * which is "is the harness running" — and it sent the reader to go restart a
 * harness that was running perfectly well. The branch that said "the harness
 * refused the connection, most often a wrong or stale token" was unreachable.
 *
 * It was unreachable for a reason worth writing down, because it is invisible
 * from the source: the WebSocket API does not expose an HTTP status code, so a
 * 401 arrives as a bare `error` event followed by `close` with code 1006 — and
 * `error` always fires first, while the `finish` guard lets only the first
 * result through. The `close` handler's `refused` line was therefore dead code
 * that read like the important half.
 *
 * These tests drive the real `extension/options.js` against a fake `chrome` and
 * real HTTP servers, in three genuinely different situations:
 *
 *   - a port with a server that rejects the upgrade → "refused … token"
 *   - a port with nothing on it                     → "could not connect" + 3 checks
 *   - no token saved                                 → the copy-it hint
 *
 * The middle case is the one the old code could not distinguish, so a test that
 * only asserted "some error appears" would have passed before the fix. Each test
 * therefore names the sentence it expects *and* the sentence it must not see.
 * The remedies list is checked for the absence of "is dsh web running", because
 * offering that remedy while a port demonstrably answers is the specific wrong
 * advice this change removes.
 */
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { assert, test } from './harness.js'

const here = dirname(fileURLToPath(import.meta.url))
const extensionDir = join(here, '..', '..', '..', 'extension')

/**
 * A port that is genuinely closed, verified by an actual connection attempt.
 *
 * Binding a port, releasing it and probing the number is a race, and the full
 * suite loses it: `badge.test.js` and `bridge-e2e.test.js` both bind real HTTP
 * servers with `listen(0)`, so the OS can hand out the number this test just
 * released — at which point the port answers, the page correctly reports a
 * refusal, and the test fails with `expected the cannot-connect diagnosis, got:
 * The harness refused the connection`. That is precisely how this test first
 * failed when it ran with the others, while passing on its own.
 *
 * Holding the port open instead does not work either: a bound socket accepts
 * connections, so it *is* an answer, and the branch under test would flip.
 *
 * So the candidate ports are fixed and chosen above the ephemeral range this
 * machine actually uses, which is where `listen(0)` draws from — on Windows that
 * is 1024-15000 (`netsh int ipv4 show dynamicport tcp`: start 1024, 13977
 * ports), so nothing else in this suite can be handed these numbers. Each
 * candidate is then confirmed closed by opening a socket and requiring the
 * refusal, so a machine that does have something there fails loudly rather than
 * silently testing the wrong branch.
 *
 * @returns {Promise<number>} The port number.
 */
async function closedPort() {
  for (const candidate of [45671, 45672, 45673, 45674, 45675]) {
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
  throw new Error('every candidate port is occupied; pick another range for this test')
}

/**
 * A harness stand-in that refuses the websocket upgrade, the way the real one
 * answers a bad token — `lib/index.js` writes a 401 before the upgrade.
 *
 * @returns {Promise<{ port: number, upgrades: () => number, close: () => Promise<void> }>}
 */
async function rejectingHost() {
  const state = { upgrades: 0 }
  const server = createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  server.on('upgrade', (_req, socket) => {
    state.upgrades += 1
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    socket.destroy()
  })
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  return {
    port: server.address().port,
    upgrades: () => state.upgrades,
    close: () => new Promise((ok) => server.close(ok)),
  }
}

/** How many times the page has been loaded; each `import()` must be a new module. */
let loadCount = 0

// The real `fetch`, captured during the import phase.
//
// `run.js` imports every suite before running a single test, and
// `panel-stream.test.js` replaces `globalThis.fetch` at module scope without
// ever putting it back. So by the time any test body runs, the global is its
// stub — and that stub answers *every* URL, including a port with nothing on it.
// The discrimination this file exists to check then silently inverts: the page
// sees an answer where there was none and reports a refused token.
//
// It has to be the real one, not a stand-in. The page's whole question is "did
// anything answer on this port", which is a fact about the network; a stub that
// decided the answer in advance would be asserting against itself. Capturing it
// here works because this suite is imported before that one — and the guard
// below makes a reordering fail loudly instead of quietly testing the wrong
// branch.
const realFetch = globalThis.fetch

{
  // Proof that the captured function is the real one: a real fetch rejects on a
  // port that is closed. If a suite imported earlier had already replaced it,
  // this says so by name rather than letting three later tests report a
  // plausible-looking wrong string.
  const port = await closedPort()
  let rejected = false
  try {
    await realFetch(`http://127.0.0.1:${port}/browser-bridge/health`, { mode: 'no-cors' })
  } catch {
    rejected = true
  }
  if (!rejected) {
    throw new Error(
      'globalThis.fetch was already replaced when options.test.js was imported, so the port '
      + 'probe cannot be tested here. Another suite mutates it at module scope — fix that, or '
      + 'import this suite before it.',
    )
  }
}

/**
 * Load the real options page script against a fake `chrome` and a minimal DOM.
 *
 * `options.js` reads its nodes by id at import time and registers its click
 * listeners then, so the stubs have to exist before the import — and they have
 * to *stay* in place until the test is done, because the module resolves
 * `chrome` inside `save()`, not at import. Restoring the globals right after the
 * import is the mistake this comment exists to prevent: it made `save()` throw
 * `Cannot read properties of undefined (reading 'storage')` from inside a
 * `data:` URL, which reads as a base64 blob and tells you nothing. The restore
 * is registered with `t.onCleanup` so it runs when the test ends, not when the
 * import does.
 *
 * The page's own `querySelectorAll` returns nothing rather than being faked:
 * this page's copy lives in `options.html`, and that markup is covered by
 * `panel-i18n.test.js`. What is under test here is the probe.
 *
 * `WebSocket` and `fetch` are Node's real ones, aimed at real loopback servers.
 * The discrimination under test is "did anything answer on this port", and a
 * stubbed fetch could not answer that honestly.
 *
 * @param {object} options - What `chrome.storage.local` should return.
 * @param {object} options.stored - The saved settings.
 * @param {object} t - The test context, for cleanup registration.
 * @param {string} [options.locale] - The browser UI language.
 * @returns {Promise<{ nodes: Map<string, object>, click: (id: string) => Promise<string> }>}
 */
async function loadOptionsPage({ stored, locale = 'en-US' }, t) {
  const nodes = new Map()

  /**
   * The `type` each input declares in the real markup.
   *
   * Read from `options.html` rather than hardcoded, because the page's own
   * behaviour depends on it: the reveal control asks whether the field is
   * already `type: 'text'`, and a fixture that left `type` undefined would make
   * that branch untestable — the first click would look like a reveal whether
   * or not the markup ever said `password`.
   *
   * @returns {Map<string, string>} Element id to declared type.
   */
  const declaredTypes = () => {
    const markup = readFileSync(join(extensionDir, 'options.html'), 'utf8')
    const found = new Map()
    for (const tag of markup.matchAll(/<input\b[^>]*>/g)) {
      const id = /\bid="([^"]+)"/.exec(tag[0])
      const type = /\btype="([^"]+)"/.exec(tag[0])
      if (id !== null && type !== null) found.set(id[1], type[1])
    }
    return found
  }
  const types = declaredTypes()

  const makeNode = () => {
    const listeners = new Map()
    const node = {
      dataset: {},
      style: {},
      hidden: false,
      disabled: false,
      checked: false,
      value: '',
      textContent: '',
      className: '',
      id: '',
      lang: '',
      /**
       * Attributes by name.
       *
       * Kept rather than stubbed, because the reveal control reports its state
       * through `aria-pressed` and a no-op `setAttribute` would make "it says
       * what it is doing" indistinguishable from "it never said anything".
       */
      attributes: {},
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, [])
        listeners.get(type).push(fn)
      },
      removeAttribute(name) {
        delete node.attributes[name]
        delete node.dataset[name]
      },
      setAttribute(name, value) {
        node.attributes[name] = String(value)
      },
      getAttribute(name) {
        return node.attributes[name] ?? null
      },
      click() {
        for (const fn of listeners.get('click') ?? []) fn({})
      },
      /** Fire one DOM event, the way the browser does for a paste or a keystroke. */
      fire(type) {
        for (const fn of listeners.get(type) ?? []) fn({ target: node })
      },
    }
    return node
  }
  const byId = (id) => {
    if (!nodes.has(id)) {
      const node = makeNode()
      node.id = id
      // The declared type, so the page's own branch on it is exercised rather
      // than short-circuited by an undefined field.
      if (types.has(id)) node.type = types.get(id)
      nodes.set(id, node)
    }
    return nodes.get(id)
  }

  const previousChrome = globalThis.chrome
  const previousDocument = globalThis.document
  // The page resolves `globalThis.fetch` when it needs it, so the real one has
  // to be in place for as long as the test runs — see the note on `realFetch`.
  // This is the whole reason that note exists: without it the page would be
  // asking a stub whether a port answered.
  const previousFetch = globalThis.fetch
  globalThis.fetch = realFetch
  // A storage that actually stores. The page now writes what it fetched — the
  // token, and the `manualToken` flag — and reads it back, so a `set` that threw
  // the value away would make every enrol test report an empty field while the
  // page behaved correctly.
  const store = { ...stored }
  globalThis.chrome = {
    runtime: { id: 'test' },
    i18n: { getUILanguage: () => locale },
    storage: {
      local: {
        get: (defaults) => Promise.resolve({ ...defaults, ...store }),
        set: (values) => {
          Object.assign(store, values)
          return Promise.resolve()
        },
      },
    },
  }
  globalThis.document = {
    documentElement: makeNode(),
    body: makeNode(),
    getElementById: byId,
    querySelectorAll: () => [],
  }
  t.onCleanup(() => {
    globalThis.chrome = previousChrome
    globalThis.document = previousDocument
    globalThis.fetch = previousFetch
  })

  const source = readFileSync(join(extensionDir, 'options.js'), 'utf8')
    // Both relative imports have to resolve from a `data:` URL, which has no
    // base scheme to resolve against — so they are rewritten to absolute file
    // URLs. The real `bootstrap.js` is kept in the graph deliberately: what it
    // does with a real HTTP answer is the thing the auto-enrol tests below are
    // about, and a stub would be asserting against itself.
    .replace(
      /from '\.\/(locales|bootstrap)\.js'/g,
      (_whole, name) => `from '${pathToFileURL(join(extensionDir, `${name}.js`)).href}'`,
    )
  // A distinct URL per load: `import()` caches by URL, so without this a second
  // test silently receives the first test's module, still holding the first
  // test's `chrome` and already past its listener registration.
  const unique = (loadCount += 1)
  await import(`data:text/javascript;base64,${Buffer.from(`${source}\n// ${unique}`).toString('base64')}`)

  return {
    nodes,
    /**
     * Click a button and wait for the page's async probe chain to settle.
     *
     * The handler awaits `save()` and then `probe()`, and `probe()` awaits a
     * fetch on the failure path, so the wait has to be real rather than a fixed
     * microtask count. It returns as soon as the strip reaches a verdict, and
     * gives up after a generous bound so a hang reports as a wrong string
     * instead of a hung suite.
     *
     * @param {string} id - The button's id.
     * @returns {Promise<string>} The text the result strip ended up with.
     */
    async click(id) {
      byId(id).click()
      const strip = byId('result')
      for (let i = 0; i < 60; i += 1) {
        await new Promise((ok) => setTimeout(ok, 25))
        if (strip.dataset.state === 'ok' || strip.dataset.state === 'bad') break
      }
      return strip.textContent
    },
    /**
     * Paste a value into the token field and let the page react.
     *
     * The paste is the gesture that matters: `input` is what a real paste fires,
     * and the shape note is driven by it rather than by the connection test.
     *
     * @param {string} value - What was pasted.
     * @returns {{ hidden: boolean, state: string | undefined, text: string }} The note.
     */
    pasteToken(value) {
      const input = byId('token')
      input.value = value
      input.fire('input')
      const note = byId('shape')
      return { hidden: note.hidden, state: note.dataset.state, text: note.textContent }
    },
  }
}

test('a rejected token is reported as a rejected token, not as a missing harness', async (t) => {
  const host = await rejectingHost()
  t.onCleanup(() => host.close())
  const page = await loadOptionsPage(
    { stored: { port: String(host.port), token: 'stale-token', autoPushSelection: false } },
    t,
  )
  const shown = await page.click('test')

  assert.match(shown, /refused the connection/i, `expected the refusal diagnosis, got: ${shown}`)
  assert.match(shown, /token/i)
  // The wrong instruction, and the whole point of the change: the harness is up,
  // so telling the reader to check whether it is running sends them to inspect a
  // healthy process. The old code said this in every failure case.
  assert.ok(
    !/harness is running/i.test(shown),
    `a rejection must not suggest the harness might be down, got: ${shown}`,
  )
  // It really did try: the server saw the upgrade attempt.
  assert.ok(host.upgrades() >= 1, 'the page never attempted the websocket upgrade')
})

test('a harness that is not running is still reported as not running', async (t) => {
  const port = await closedPort()
  const page = await loadOptionsPage(
    { stored: { port: String(port), token: 'any-token', autoPushSelection: false } },
    t,
  )
  const shown = await page.click('test')

  assert.match(shown, /could not connect/i, `expected the cannot-connect diagnosis, got: ${shown}`)
  assert.match(shown, /harness is running/i, 'the port is dead, so checking the harness is the right advice')
  // And the converse: a dead port never refused anything, because there was
  // nothing there to refuse it.
  assert.ok(!/refused the connection/i.test(shown), `nothing was listening, so nothing refused: ${shown}`)
})

test('an empty token still never opens a socket with nothing in it', async (t) => {
  // The page no longer refuses to act on an empty field — it asks the harness
  // for the token instead (see the auto-enrol tests below). What must not change
  // is that an *empty string* is never presented as a credential: the guard is
  // about what goes on the wire, and this host answers neither route, so there
  // is nothing to enrol with.
  const host = await rejectingHost()
  t.onCleanup(() => host.close())
  const page = await loadOptionsPage(
    { stored: { port: String(host.port), token: '', autoPushSelection: false } },
    t,
  )
  const shown = await page.click('test')

  assert.match(shown, /no harness answered/i, `expected the cannot-enrol diagnosis, got: ${shown}`)
  assert.equal(host.upgrades(), 0, 'an empty token must not open a socket at all')
})

test('the same two situations read correctly in Chinese', async (t) => {
  // The probe's branches pick different dictionary keys, so a translation that
  // was only ever wired for one branch would show English here rather than
  // failing loudly — `translator()` falls back to English, then to the key.
  const host = await rejectingHost()
  t.onCleanup(() => host.close())
  const page = await loadOptionsPage(
    { stored: { port: String(host.port), token: 'stale-token', autoPushSelection: false }, locale: 'zh-CN' },
    t,
  )
  const shown = await page.click('test')

  assert.match(shown, /拒绝了连接/, `expected the Chinese refusal line, got: ${shown}`)
  assert.ok(!/harness is running/i.test(shown), 'the Chinese refusal must not carry the English remedy')
})

test('the token can be revealed, and says which state it is in', async (t) => {
  // Pasting sixty-four characters from another window into a field that shows
  // nothing back is the step this page exists for, and it was the one field with
  // no way to check what landed. The reveal is a real control, not decoration.
  const page = await loadOptionsPage(
    { stored: { port: '3080', token: '', autoPushSelection: false } },
    t,
  )

  const input = page.nodes.get('token')
  const reveal = page.nodes.get('reveal')
  assert.equal(reveal.tagName, undefined, 'the fixture is not asserting the element name; the page builds it in markup')

  // Hidden by default: a token on screen in a shared window is a credential on
  // screen, which is why the field is a password input at all.
  assert.equal(input.type, 'password', 'the token was visible before anyone asked')

  reveal.click()
  assert.equal(input.type, 'text', 'the reveal did not reveal')
  assert.equal(reveal.getAttribute('aria-pressed'), 'true', 'the pressed state does not say what the field is')

  reveal.click()
  assert.equal(input.type, 'password', 'the hide did not hide')
  assert.equal(reveal.getAttribute('aria-pressed'), 'false')
})

test('a truncated or wrong-shaped token is caught before it reaches the harness', async (t) => {
  // The field is a password input, so someone who pasted half of a token sees
  // nothing wrong — they press Save, the connection fails, and the message
  // blames the harness. The note is what turns that into "the paste was short".
  const page = await loadOptionsPage(
    { stored: { port: '3080', token: '', autoPushSelection: false } },
    t,
  )

  // Nothing typed is not a mistake, and an empty field with a red note under it
  // would greet every first visit with an error.
  const empty = page.pasteToken('')
  assert.equal(empty.hidden, true, 'an empty field was reported as wrong')
  assert.equal(empty.state, undefined)

  const short = page.pasteToken('a'.repeat(20))
  assert.equal(short.hidden, false, 'a truncated paste said nothing')
  assert.equal(short.state, 'bad')
  assert.match(short.text, /64/, 'the note does not name the length it wants')
  assert.match(short.text, /20/, 'the note does not say how long the paste actually was')

  const good = page.pasteToken('0123456789abcdef'.repeat(4))
  assert.equal(good.state, 'good', `a real token was rejected: ${good.text}`)

  // Right length, wrong alphabet. `lib/token.js` mints the token with
  // `randomBytes(32).toString('hex')`, which never produces uppercase, and the
  // host compares byte for byte — so this is what copying from the wrong field
  // looks like, and it must not be reported as fine.
  const upper = page.pasteToken('A'.repeat(64))
  assert.equal(upper.state, 'bad', 'a 64-character uppercase string was accepted as a token')

  // And clearing it again takes the note away rather than leaving an accusation
  // under an empty box.
  const cleared = page.pasteToken('')
  assert.equal(cleared.hidden, true, 'the note stayed after the field was cleared')
})

/**
 * A harness stand-in that serves the real token and health routes.
 *
 * The shapes matter: `lib/index.js` answers health on `/browser-bridge/health`
 * and the token on `/api/browser-bridge/token`, and both carry
 * `cache-control: no-store`. Reading the token route is what the settings page
 * now does on its own, so the fixture has to be the shape it will actually meet.
 *
 * Deliberately **no** `access-control-allow-origin`: that absent header is the
 * entire reason a web page cannot read this route while the extension can, and a
 * fixture that helpfully added one would test a configuration the harness does
 * not have.
 *
 * @param {object} [options] - What the routes should say.
 * @param {string} [options.token] - The token to serve.
 * @param {boolean} [options.enabled] - The bridge switch on the health route.
 * @returns {Promise<{ port: number, tokenRequests: number, close: () => Promise<void>, setEnabled: (v: boolean) => void }>}
 */
async function enrollingHost(options = {}) {
  const state = {
    enabled: options.enabled !== false,
    token: options.token ?? '0123456789abcdef'.repeat(4),
    tokenRequests: 0,
  }
  const server = createServer((req, res) => {
    const url = req.url ?? ''
    if (url.startsWith('/browser-bridge/health')) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ enabled: state.enabled, connected: false, tokenLength: state.token.length }))
      return
    }
    if (url.startsWith('/api/browser-bridge/token')) {
      state.tokenRequests += 1
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ token: state.token }))
      return
    }
    res.writeHead(404).end()
  })
  // The websocket upgrade is accepted, so the connection test that follows a
  // successful enrol gets a pass rather than a confusing refusal.
  server.on('upgrade', (_req, socket) => socket.destroy())
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  return {
    port: server.address().port,
    get tokenRequests() {
      return state.tokenRequests
    },
    setEnabled: (value) => {
      state.enabled = value
    },
    close: () => new Promise((ok) => server.close(ok)),
  }
}

test('a first run with no token gets one from the harness instead of asking for a paste', async (t) => {
  // This is the barrier the page used to be: two windows, sixty-four characters,
  // and a field that shows nothing back. The harness already serves the token on
  // loopback, and the extension is allowed to read it, so the only thing the
  // paste accomplished was making the person a courier for a value their own
  // machine already had.
  const host = await enrollingHost()
  t.onCleanup(() => host.close())
  const page = await loadOptionsPage(
    { stored: { port: String(host.port), token: '', autoPushSelection: false } },
    t,
  )

  const shown = await page.click('test')

  assert.match(shown, /refused the connection/i, `the enrol should have produced a token and then reached the socket path, got: ${shown}`)
  assert.ok(host.tokenRequests >= 1, 'the page never asked the harness for a token')
  assert.equal(
    page.nodes.get('token').value,
    '0123456789abcdef'.repeat(4),
    'the token was fetched but not shown in the field, so the page would report a success above an empty box',
  )
})

test('a typed token is used as-is, and the harness is not asked', async (t) => {
  // The manual path has to keep working: a harness whose token route is blocked,
  // an unusual port, or simply a person who wants to pin the value. Asking the
  // harness anyway would overwrite a deliberate choice.
  const host = await enrollingHost({ token: 'f'.repeat(64) })
  t.onCleanup(() => host.close())
  const page = await loadOptionsPage(
    { stored: { port: String(host.port), token: 'a'.repeat(64), autoPushSelection: false } },
    t,
  )

  await page.click('test')

  assert.equal(host.tokenRequests, 0, 'a token was already supplied, so nothing needed fetching')
})

test('a bridge switched off in DSH is reported as switched off, not as a broken harness', async (t) => {
  // The off switch lives in DSH Settings, and someone who flipped it meant it.
  // Telling them "no harness answered" would send them to check a process that
  // is running perfectly well, and would also be false.
  const host = await enrollingHost({ enabled: false })
  t.onCleanup(() => host.close())
  const page = await loadOptionsPage(
    { stored: { port: String(host.port), token: '', autoPushSelection: false } },
    t,
  )

  const shown = await page.click('test')

  assert.match(shown, /switched off/i, `expected the switched-off diagnosis, got: ${shown}`)
  assert.ok(!/no harness answered/i.test(shown), `a switched-off bridge is not a missing harness: ${shown}`)
  assert.equal(host.tokenRequests, 0, 'the token must not be fetched from a bridge the person turned off')
})

test('a harness that answers without a token is its own diagnosis', async (t) => {
  // A third state, and the one that would otherwise be indistinguishable from a
  // stopped harness: something answered, so "is dsh web running" is the wrong
  // thing to go and check.
  const server = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/browser-bridge/health')) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ enabled: true }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ hint: 'no token here' }))
  })
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  t.onCleanup(() => new Promise((ok) => server.close(ok)))

  const page = await loadOptionsPage(
    { stored: { port: String(server.address().port), token: '', autoPushSelection: false } },
    t,
  )
  const shown = await page.click('test')

  assert.match(shown, /without a token/i, `expected the malformed-answer diagnosis, got: ${shown}`)
})

test('the shape note is advisory, so a wrong-looking token can still be tested', async (t) => {
  // The note judges the *shape*; only the harness can judge the value. If it
  // disabled the buttons, a token from an older harness with a different length
  // would become impossible to test — the page would refuse to check the very
  // thing it exists to check.
  const host = await rejectingHost()
  t.onCleanup(() => host.close())
  const page = await loadOptionsPage(
    { stored: { port: String(host.port), token: '', autoPushSelection: false } },
    t,
  )

  page.pasteToken('too-short')
  const shown = await page.click('test')

  assert.ok(host.upgrades() >= 1, 'a short token was blocked from reaching the harness')
  assert.match(shown, /refused the connection/i, `expected the probe to still run, got: ${shown}`)
})

/**
 * The settings page is the second surface this extension ships, and it was
 * outside the text-scaling work the panel went through: every size on it was an
 * absolute `px`, so a reader who asked their system for larger text got a page
 * that did not move at all — measured at 200%, all 23 text elements were frozen
 * and the screenshot was byte-identical to the 100% one. WCAG 1.4.4 asks for
 * 200%.
 *
 * These two tests read the declared CSS rather than a rendered page, because the
 * suite has no layout engine. That is enough to catch the failure mode that
 * actually happened: a `px` length written where a relative one belongs. The
 * measurement lives in `tools/preview.mjs` probes; what is asserted here is the
 * unit and the value, and both — asserting only "is not px" would pass for a
 * `rem` with the wrong numerator, which is the trap this repository already
 * recorded when a line-height was checked for its unit but not its scale.
 */
const optionsPageCss = () => readFileSync(join(extensionDir, 'options.html'), 'utf8')

test('every text size on the settings page is relative to the reader', (t) => {
  const css = optionsPageCss()
  const declarations = [...css.matchAll(/font-size:\s*([^;]+);/g)].map((match) => match[1].trim())

  assert.ok(declarations.length >= 4, `expected the page to state several text sizes, found ${declarations.length}`)

  for (const value of declarations) {
    assert.ok(
      /(?:var\(--text-|rem)/.test(value),
      `a text size is absolute and will ignore the reader's setting: ${value}`,
    )
  }

  // The `font` shorthand carries a size too, and a `px` in it freezes the text
  // just as surely as a `font-size` declaration — but the loop above cannot see
  // it. A mutation that put `14px` back into the body's shorthand stayed green
  // until this check existed, which is the same shape of gap this repository
  // recorded when a test asserted a line-height's unit but not its scale.
  const shorthands = [...css.matchAll(/font:\s*([^;]+);/g)].map((match) => match[1].trim())
  assert.ok(shorthands.length > 0, 'expected the page to use the font shorthand somewhere')
  let sized = 0
  for (const value of shorthands) {
    // `font: inherit` states no size at all — it is a reset on a form control,
    // and taking its size from the element around it is exactly right. Only the
    // shorthands that carry a size are judged.
    if (!value.includes('/')) continue
    sized += 1
    // `font: <size>/<line-height> <family>` — the size is what precedes the
    // slash, and it is the only part of the shorthand that has to be relative.
    // Either spelling is fine: a `rem` length, or a `var()` reference to one of
    // the tokens pinned to `rem` above. What is not fine is an absolute length,
    // which is what a mutation put back here.
    const size = value.split('/')[0].trim().split(/\s+/).pop()
    assert.ok(
      /rem/.test(size) || /^var\(--text-/.test(size),
      `the font shorthand pins its size and will ignore the reader's setting: ${value}`,
    )
  }
  assert.ok(sized > 0, 'no font shorthand on the page states a size, so this check proved nothing')

  // The tokens are the other half: a relative `font-size` pointing at a `px`
  // token is still frozen. These are the three the page uses, at the values that
  // equal what they replaced (12.5 / 13 / 14px at the default 16px root), so a
  // reader who has not changed anything sees no movement.
  for (const [name, expected] of [['--text-xs', '0.78125rem'], ['--text-sm', '0.8125rem'], ['--text-base', '0.875rem']]) {
    const declared = new RegExp(`${name}:\\s*([^;]+);`).exec(css)
    assert.ok(declared !== null, `${name} is not declared in options.html`)
    assert.equal(declared[1].trim(), expected, `${name} should be ${expected}`)
  }
})

test('the settings page does not pin its measure or its controls to pixels', (t) => {
  const css = optionsPageCss()

  // A reading measure in px halves its characters per line once the text grows.
  const body = /body\s*\{[\s\S]*?\}/.exec(css)
  assert.ok(body !== null, 'options.html has no body rule')
  const measure = /max-width:\s*([^;]+);/.exec(body[0])
  assert.ok(measure !== null, 'the body states no max-width')
  assert.equal(measure[1].trim(), '40rem', `the reading measure should be relative, found ${measure[1].trim()}`)

  // A checkbox does not inherit `font-size`, so it has to be told in `rem` or it
  // stays 13px while the label beside it grows — one row, two rates.
  const checkbox = /label\.check\s+input\[type="checkbox"\]\s*\{[\s\S]*?\}/.exec(css)
  assert.ok(checkbox !== null, 'options.html does not size the checkbox in its label row')
  // 0.8125rem is exactly the 13px Chrome draws by default, so the default view
  // is unchanged; the value is asserted, not just the unit.
  assert.match(checkbox[0], /inline-size:\s*0\.8125rem;/, 'the checkbox inline size should be 0.8125rem')
  assert.match(checkbox[0], /block-size:\s*0\.8125rem;/, 'the checkbox block size should be 0.8125rem')
})

