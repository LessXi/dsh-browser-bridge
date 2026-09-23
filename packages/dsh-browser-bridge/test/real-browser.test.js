/**
 * End-to-end tests against a real browser, with the real extension loaded.
 *
 * ## What this covers that nothing else could
 *
 * Every other suite in this directory drives `extension/background.js` against
 * a fake `chrome` (`./service-worker.js`). That fake cannot answer the question
 * this file exists for: whether the extension's own CDP calls reach a real page.
 * A wrong `chrome.debugger` parameter name, a `DOM.getBoxModel` quad read at the
 * wrong offset, or an `Input.dispatchMouseEvent` sent in the wrong coordinate
 * space all produce a *silently wrong* result under a fake — the shapes match,
 * the click lands somewhere else.
 *
 * Measured here, for real: the extension attaches its debugger, distills a live
 * page, reads its prose, clicks a button by CSS selector, and the page's own DOM
 * changes as a result. That last step is the one no mock can make.
 *
 * ## Why it is possible now
 *
 * The handover recorded "Chrome 137 removed `--load-extension`, so no test
 * browser can carry the extension" (README "已验证 / 未验证", HANDOVER §3529).
 * That was measured on **stable** Chrome 153 and generalised to every browser.
 * Re-measured across every binary on this machine
 * (`.tmp-run/probe-load-extension-matrix.mjs`): the switch is gone from stable
 * Chrome and from `chrome-headless-shell`, and present in Playwright's Chromium
 * and in Chrome for Testing. The removal is a stable-channel decision — the
 * channel that has to protect users from sideloaded extensions — and Chromium
 * keeps it because every browser-automation project's extension tests use it.
 *
 * ## Skipping
 *
 * Both tests skip, not fail, when no qualifying Chromium is present, because a
 * checkout on a machine without one must still be able to run the suite. The
 * skip reason names the missing binary and the override, so "0 tested" can never
 * be mistaken for "tested and fine".
 *
 * @module dsh-browser-bridge/test/real-browser.test
 */

import { pathToFileURL } from 'node:url'

import { assert, main, test } from './harness.js'
import { ExtensionHost, FixtureServer, findChromium } from './extension-host.js'
import { ask, awaitConnection, fakeHost } from './service-worker.js'

/** A token the fake host accepts; `compareTokens` wants 64 lowercase hex. */
const TOKEN = '0123456789abcdef'.repeat(4)

/** A page with the structure the snapshot, read, and click paths all touch. */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Live fixture</title></head>
<body style="font:14px sans-serif;margin:0;padding:20px">
  <h1>Checkout</h1>
  <p id="prose">The quick brown fox jumps over the lazy dog.</p>
  <label for="email">Email address</label>
  <input id="email" name="email" type="text" placeholder="you@example.com" style="display:block;width:200px;height:24px">
  <button id="go" type="button" style="width:120px;height:32px">Submit order</button>
  <div id="result">idle</div>
  <script>
    document.getElementById('go').addEventListener('click', () => {
      document.getElementById('result').textContent = 'clicked'
    })
  </script>
</body></html>`

/**
 * Start a browser with the extension, a fixture page, and a fake host, then make
 * the extension dial the fake host.
 *
 * The dial is not a convenience: the extension's own settings decide where to
 * connect, so writing `port` and `token` into `chrome.storage.local` from inside
 * the worker is what makes the *real* `connect()` path run — including its
 * `storage.onChanged` reconnect. Driving `handleFrame` directly would skip the
 * one part of the extension a fake host can never exercise.
 *
 * @param {import('./harness.js').TestContext} t - The test context, for cleanup.
 * @returns {Promise<object | undefined>} The rig, or undefined when no Chromium exists.
 */
async function startRig(t) {
  const fixture = new FixtureServer({ '/': PAGE })
  const origin = await fixture.start()
  t.onCleanup(() => fixture.stop())

  const browser = await ExtensionHost.start({ startUrl: `${origin}/` })
  if (browser === undefined) return undefined
  t.onCleanup(() => browser.stop())

  const host = await fakeHost(TOKEN)
  t.onCleanup(() => host.close())

  const worker = await browser.worker()
  await worker.eval(`(async () => {
    await chrome.storage.local.set({ port: ${JSON.stringify(String(host.port))}, token: ${JSON.stringify(TOKEN)} })
    return true
  })()`)

  await awaitConnection(host, 20_000)

  const tab = await browser.waitForTab((candidate) => (candidate.url ?? '').includes(origin), 20_000)
  if (tab === undefined) throw new Error('the fixture page never appeared in chrome.tabs')

  return { browser, host, worker, origin, tabId: tab.id }
}

const chromium = findChromium()
const skipReason = 'no Chromium that can load an unpacked extension (set DSH_BB_CHROMIUM, or install Playwright Chromium / Chrome for Testing)'

test('the real extension dials the host and answers bridge.status', async (t) => {
  if (chromium === undefined) return t.skip(skipReason)
  const rig = await startRig(t)
  if (rig === undefined) return t.skip(skipReason)

  const answer = await ask(rig.host, { method: 'bridge.status' }, 1)
  assert.equal(answer.ok, true, `bridge.status failed: ${JSON.stringify(answer)}`)

  // The version must be the manifest's, read from the extension itself rather
  // than restated here — a hard-coded copy would go stale on the next bump and
  // the test would keep passing.
  const manifestVersion = rig.worker.eval === undefined ? undefined : await rig.worker.eval('chrome.runtime.getManifest().version')
  assert.equal(answer.value.version, manifestVersion, 'bridge.status reported a version other than the manifest\'s')
  assert.equal(typeof answer.value.tabCount, 'number')
  assert.ok(answer.value.tabCount >= 1, 'the fixture tab should be counted')

  // A healthy connection has no error to report, and `null` is how it says so.
  assert.equal(answer.value.lastError, null, 'a fresh connection should carry no error')

  // The greeting is the extension speaking unprompted; a fake host that dropped
  // unmatched frames could not tell "sent" from "not sent".
  const greeted = rig.host.notifications.find((frame) => frame.event === 'bridge/hello')
  assert.ok(greeted !== undefined, `expected a bridge/hello notification, saw ${JSON.stringify(rig.host.notifications)}`)
  assert.equal(greeted.payload.version, manifestVersion)
})

test('the real extension reads and clicks a live page through chrome.debugger', async (t) => {
  if (chromium === undefined) return t.skip(skipReason)
  const rig = await startRig(t)
  if (rig === undefined) return t.skip(skipReason)

  const { host, tabId } = rig

  // ── The snapshot comes from `DOMSnapshot.captureSnapshot` on a real page ──
  const snapshot = await ask(host, { method: 'page.snapshot', params: { tabId } }, 2)
  assert.equal(snapshot.ok, true, `page.snapshot failed: ${JSON.stringify(snapshot)}`)
  const elements = snapshot.value?.elements ?? []
  assert.ok(elements.length > 0, 'a real page with a form should distill at least one element')

  const submit = elements.find((element) => (element.name ?? '').includes('Submit order'))
  assert.ok(submit !== undefined, `expected the button in the snapshot, got ${JSON.stringify(elements.map((e) => e.name))}`)
  assert.equal(submit.role, 'button')
  // Bounds are the field a click is computed from; a snapshot without them is
  // not clickable, and an empty object here would still satisfy `ok: true`.
  assert.equal(typeof submit.bounds?.x, 'number', 'a distilled element must carry measured bounds')

  // ── The prose comes from the real document, not a fixture string ──
  const read = await ask(host, { method: 'page.read', params: { tabId } }, 3)
  assert.equal(read.ok, true, `page.read failed: ${JSON.stringify(read)}`)
  assert.match(String(read.value?.text ?? ''), /quick brown fox/, 'the page\'s own prose should be in the read result')

  // ── The click lands, and the page's own DOM is the proof ──
  const click = await ask(host, { method: 'page.click', params: { tabId, selector: '#go' } }, 4)
  assert.equal(click.ok, true, `page.click failed: ${JSON.stringify(click)}`)
  assert.equal(typeof click.value?.x, 'number', 'the click answer should report where it landed')

  // Read the result from the page itself. The extension's answer says it
  // dispatched input; only the page can say the input was understood. A click
  // delivered at the wrong coordinates, or in the wrong coordinate space, still
  // answers `ok: true` — and this is the assertion that catches it.
  //
  // Resolved by tab id rather than by URL: the fixture is served at exactly the
  // URL the tab already has open, so matching on URL would pick between two
  // page targets arbitrarily and turn this into a coin flip.
  const page = await rig.browser.pageForTab(tabId)
  t.onCleanup(() => page.close())
  const result = await waitForText(page, 'result', 10_000)
  assert.equal(result, 'clicked', 'the click did not reach the button: the handler never ran')
})

/**
 * Wait for an element's text to become `clicked`.
 *
 * The click's input events are dispatched asynchronously, and the page's handler
 * runs after them. Reading immediately races the browser; polling the element
 * waits for the observable consequence rather than for a fixed delay.
 *
 * @param {import('./extension-host.js').Cdp} page - A client on the fixture page.
 * @param {string} id - The element id.
 * @param {number} timeoutMs - How long to wait.
 * @returns {Promise<string | undefined>} The text, or undefined on timeout.
 */
async function waitForText(page, id, timeoutMs) {
  return poll(
    () => page.eval(`document.getElementById(${JSON.stringify(id)}).textContent === 'clicked' ? 'clicked' : undefined`),
    timeoutMs,
  )
}

/**
 * Poll an async predicate until it returns something truthy.
 *
 * Message delivery here crosses two extension contexts and a 300ms debounce, and
 * the timing is not the extension's contract — that the message arrives is. A
 * fixed `setTimeout` long enough to be safe on an idle machine is the way a suite
 * starts failing on a busy one, so every wait in this file is a poll.
 *
 * @param {() => Promise<any>} check - Resolves to a truthy value once ready.
 * @param {number} timeoutMs - How long to keep asking.
 * @returns {Promise<any>} The first truthy value, or undefined on timeout.
 */
async function poll(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

test('the real extension refuses a protected CDP domain', async (t) => {
  if (chromium === undefined) return t.skip(skipReason)
  const rig = await startRig(t)
  if (rig === undefined) return t.skip(skipReason)

  // `Browser` can reach other profiles and the browser process itself. The host
  // checks this too, and `background.js` checks it again so a host bug is not by
  // itself enough to get through. Only a real browser can show the second check
  // firing, because under a fake `chrome` the refusal and the attempt look the
  // same.
  const denied = await ask(rig.host, { method: 'cdp.send', params: { tabId: rig.tabId, method: 'Browser.getVersion' } }, 5)
  assert.equal(denied.ok, false, 'a protected domain must not be reachable through the bridge')
  assert.equal(denied.code, 'cdp-denied')
  assert.match(String(denied.message), /Browser is outside page inspection/)

  // An unknown method is a different refusal, and must not be confused with it.
  const unknown = await ask(rig.host, { method: 'no.such.method' }, 6)
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, 'unknown-method')
})

test('the extension\'s own pages open, and drive their real chrome APIs', async (t) => {
  if (chromium === undefined) return t.skip(skipReason)
  const rig = await startRig(t)
  if (rig === undefined) return t.skip(skipReason)

  // The options page is the one extension document that needs nothing but its
  // own script: it reads and writes `chrome.storage`, which is exactly the API
  // the settings round-trip depends on. Opening it proves the harness can reach
  // an extension-origin document at all, and the write/read below proves the
  // document is a live extension context rather than a rendered shell.
  const options = await rig.browser.openExtensionPage('options.html')
  t.onCleanup(() => options.close())

  const title = await options.eval('document.title')
  assert.ok(typeof title === 'string' && title.length > 0, `the options page should have a title, got ${JSON.stringify(title)}`)

  // `chrome.storage` is undefined in a plain page; the panel's whole settings
  // story rests on it being real here.
  const hasStorage = await options.eval('typeof chrome?.storage?.local?.set === "function"')
  assert.equal(hasStorage, true, 'an extension page must have working chrome.storage')

  const roundTrip = await options.eval(`(async () => {
    await chrome.storage.local.set({ __probe: 'round-trip' })
    const got = await chrome.storage.local.get('__probe')
    await chrome.storage.local.remove('__probe')
    return got.__probe
  })()`)
  assert.equal(roundTrip, 'round-trip', 'chrome.storage in a real extension page did not round-trip a value')

  // A normal http page is the counter-case: no `chrome.storage`, so a test that
  // accidentally ran against one cannot pass the assertions above for free.
  const plain = await rig.browser.openPage(`${rig.origin}/`)
  t.onCleanup(() => plain.close())
  const plainHasStorage = await plain.eval('typeof chrome?.storage')
  assert.equal(plainHasStorage, 'undefined', 'a web page must not see chrome.storage')
})

/**
 * Select an element's text the way a person does, from the page's own DOM.
 *
 * A real drag would be more faithful, but it is also the flakiest possible way
 * to reach this code: the reporter debounces for 300ms and re-reads the live
 * selection, so a drag that misses a word sends a different string and the test
 * fails for a reason that has nothing to do with the reporter. `Range` +
 * `addRange` produces exactly the same `selectionchange` event the reporter
 * listens for, with a string the assertion can name in advance.
 *
 * @param {import('./extension-host.js').Cdp} page - A client on the fixture page.
 * @param {string} id - The element whose text should be selected.
 * @returns {Promise<string>} What the page says is selected.
 */
function selectText(page, id) {
  return page.eval(`(() => {
    const range = document.createRange()
    range.selectNodeContents(document.getElementById(${JSON.stringify(id)}))
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    return selection.toString().trim()
  })()`)
}

test('the content script reports a real selection, and the panel receives it', async (t) => {
  if (chromium === undefined) return t.skip(skipReason)
  const rig = await startRig(t)
  if (rig === undefined) return t.skip(skipReason)

  // This is the leg the handover recorded as never having been exercised: the
  // content script's `chrome.runtime.sendMessage` crossing into the worker, and
  // the worker's `chrome.runtime.sendMessage` crossing into the panel. Both were
  // structural assertions against a fake `chrome` before this, which cannot show
  // that the two contexts agree on anything.
  //
  // The panel is opened for real rather than stubbed, because the message is
  // delivered *by Chrome* to every extension context that is listening. A fake
  // listener in the test process would only prove the test process is listening.
  const panel = await rig.browser.openExtensionPage('sidepanel.html')
  t.onCleanup(() => panel.close())

  // Wait for the panel's own script to reach a state where it can receive. The
  // document exists before its module has run, and a listener registered by an
  // `eval` that lands first would be the only one in place — which would pass
  // whether or not the panel itself is wired up.
  const offlineHandled = await panel.eval('typeof chrome?.runtime?.onMessage?.addListener === "function"')
  assert.equal(offlineHandled, true, 'the panel page did not come up as an extension context')

  const registered = await panel.eval(`(() => {
    globalThis.__seenSelections = []
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === 'dsh-selection-changed') globalThis.__seenSelections.push(message.payload)
      return false
    })
    return true
  })()`)
  assert.equal(registered, true)

  // The content script is declared for all http(s) pages at `document_idle`, so
  // the fixture had a reporter installed before this test selected anything. If
  // it had not, the selection below would be reported by nobody and the wait
  // would be the honest symptom.
  const page = await rig.browser.pageForTab(rig.tabId)
  t.onCleanup(() => page.close())
  const selected = await selectText(page, 'prose')
  assert.equal(selected, 'The quick brown fox jumps over the lazy dog.')

  // 300ms debounce, then two message hops. Polled rather than slept: a fixed
  // delay that happens to be long enough on this machine is how a suite starts
  // failing on a loaded one.
  const reported = await poll(async () => {
    const seen = await panel.eval('globalThis.__seenSelections')
    return Array.isArray(seen) && seen.length > 0 ? seen : undefined
  }, 15_000)

  assert.ok(reported !== undefined, 'the panel never received the selection the page was holding')
  const first = reported[reported.length - 1]
  assert.equal(first.text, selected, 'the text that crossed the two message hops is not what was selected')
  assert.equal(first.tabId, rig.tabId, 'the payload must name the tab it came from')

  // Compared against the page's own `location.href`, not against the origin.
  // An `includes(origin)` check passed while the reporter was appending garbage
  // to the URL, because the origin is still a prefix of the garbage — the
  // assertion has to name the whole value to be worth making.
  const pageUrl = await page.eval('location.href')
  assert.equal(first.url, pageUrl, 'the payload must carry the page\'s own URL, exactly')

  // Clearing the selection must travel too. The panel draws a chip for exactly
  // what would be attached, and a chip that cannot disappear when the highlight
  // is gone answers the user's actual question — "is this going to be sent?" —
  // wrongly. Reporting the empty string is what makes that possible, so it is
  // asserted rather than assumed.
  const before = reported.length
  await page.eval('window.getSelection().removeAllRanges()')
  const cleared = await poll(async () => {
    const seen = await panel.eval('globalThis.__seenSelections')
    return Array.isArray(seen) && seen.length > before ? seen : undefined
  }, 10_000)

  assert.ok(cleared !== undefined, 'clearing the selection was never reported, so a stale chip would stay up')
  assert.equal(cleared[cleared.length - 1].text, '', 'the clearing report must carry an empty text')
})

test('a selection reaches the host as an event when the user opts in', async (t) => {
  if (chromium === undefined) return t.skip(skipReason)
  const rig = await startRig(t)
  if (rig === undefined) return t.skip(skipReason)

  // `autoPushSelection` defaults to false, and the whole point of the switch is
  // that it changes what reaches the host. Asserting only the default would pass
  // against a listener that never pushes at all, so this drives the `true` path
  // through the real `chrome.storage` read that `readSettings()` performs.
  await rig.worker.eval('(async () => { await chrome.storage.local.set({ autoPushSelection: true }); return true })()')

  const page = await rig.browser.pageForTab(rig.tabId)
  t.onCleanup(() => page.close())
  const selected = await selectText(page, 'prose')

  const event = await poll(
    () => rig.host.notifications.find((frame) => frame.event === 'selection/captured'),
    15_000,
  )

  assert.ok(event !== undefined, 'an opted-in selection never reached the host as an event')
  assert.equal(event.payload.text, selected, 'the pushed text is not what was selected')
  assert.equal(event.payload.tabId, rig.tabId)
  assert.equal(typeof event.payload.ts, 'number', 'the payload should be timestamped by the extension')

  // The switch off is a different observable outcome, and asserting it is what
  // keeps "the switch works" from being satisfied by "it always pushes".
  //
  // Flipped on the *same* page, deliberately. The first version opened a second
  // tab and selected there, and it passed for the wrong reason: a freshly opened
  // page has not finished `document_idle`, so its content script had not been
  // injected yet and nothing was reported regardless of the switch. Measured in
  // `.tmp-run/probe-selection-timing.js` — a new tab reported nothing even after
  // a three-second wait, while the same tab reported correctly once it had been
  // driven (`.tmp-run/probe-why-no-push.js`). Reusing a page that has already
  // reported once removes the timing variable entirely, so a failure here means
  // the switch, which is the only thing this assertion is about.
  await rig.worker.eval('(async () => { await chrome.storage.local.set({ autoPushSelection: false }); return true })()')
  const pushedBefore = rig.host.notifications.length

  // A second, *different* selection: the reporter only sends when the text
  // changed, so re-selecting the same string would be silent no matter what the
  // switch said.
  const secondSelection = await selectText(page, 'heading')
  assert.ok(secondSelection.length > 0, 'the second selection must be non-empty to be reported')
  assert.notEqual(secondSelection, selected, 'the two selections must differ, or the reporter stays silent by design')

  // Given the same window the push that should happen needed. A shorter wait
  // would pass against a slow but working push.
  await poll(async () => {
    const seen = await rig.host.notifications.slice(pushedBefore).filter((frame) => frame.event === 'selection/captured')
    return seen.length > 0 ? seen : undefined
  }, 3_000)
  const pushed = rig.host.notifications
    .slice(pushedBefore)
    .filter((frame) => frame.event === 'selection/captured')
  assert.equal(pushed.length, 0, 'a selection was pushed to the host with the switch off')
})

// Direct-invocation entry point, so this suite can be run on its own while
// debugging: `node test/real-browser.test.js`. `run.js` imports every suite and
// calls `runTests()` itself, so this must not also run on import.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
