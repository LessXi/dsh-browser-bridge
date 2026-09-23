/**
 * The toolbar badge, driven through the extension's real entry point.
 *
 * This exists because the badge is the one thing this project ships that no
 * screenshot can catch. It is painted by the browser's own chrome, above the
 * page, so every tool in `.tmp-run/` — the headless renderer, the audit script,
 * the pixel comparisons — is blind to it. That is the same trap the v31 notes
 * describe from the other side ("only an interface that can be screenshotted
 * gets found by a screenshot"), and the answer is the same: prove it with
 * something that can see it.
 *
 * It cannot be a real-Chrome test. Chrome 137 removed `--load-extension`, so an
 * unpacked extension cannot be loaded into a test browser any more; that was
 * measured on Chrome 153 here, in both headed and headless mode, not assumed.
 *
 * So the module is loaded for real — the actual `extension/background.js`, with
 * its actual `attach`/`detach`/`markControlled` — against a fake `chrome`, and
 * driven through the actual entry point: a WebSocket frame from the host. What
 * is under test is the wiring, which is exactly where a badge bug lives: a badge
 * set on attach but never cleared is the defect this guards, and it is invisible
 * in every screenshot the project takes.
 */
import { assert, test } from './harness.js'
import { awaitConnection, fakeHost, loadServiceWorker, listener, until } from './service-worker.js'

/** The badge calls the extension made, in order. */
const badgeCalls = (chrome) => chrome.log.filter((entry) => entry.api.startsWith('action.'))

/**
 * A `chrome` stand-in that records what the extension asked for.
 *
 * Deliberately records rather than returns useful values: the assertions are
 * about which calls were made with which arguments, and a stub that invented
 * plausible answers would hide a wrong `tabId` — the one mistake that matters
 * here, because a badge on the wrong tab is worse than no badge.
 *
 * @returns {object} The fake namespace, with a `log` of `{api, args}` entries.
 */
function fakeChrome() {
  const log = []
  const record = (api) => (...args) => {
    log.push({ api, args })
    return Promise.resolve(undefined)
  }
  return {
    log,
    runtime: {
      id: 'test-extension-id',
      getManifest: () => ({ name: 'DSH', version: '0.0.0-test' }),
      onMessage: listener(),
      onInstalled: listener(),
      onStartup: listener(),
      sendMessage: () => Promise.resolve(),
      lastError: undefined,
    },
    debugger: {
      attach: record('debugger.attach'),
      detach: record('debugger.detach'),
      sendCommand: record('debugger.sendCommand'),
      getTargets: () => Promise.resolve([]),
      onDetach: listener(),
      onEvent: listener(),
    },
    tabs: {
      query: () => Promise.resolve([]),
      get: () => Promise.resolve({ id: 1, url: 'https://example.com', title: 'Example' }),
      create: () => Promise.resolve({ id: 1 }),
      onCreated: listener(),
      onRemoved: listener(),
      onUpdated: listener(),
      onActivated: listener(),
    },
    action: {
      setBadgeText: record('action.setBadgeText'),
      setBadgeBackgroundColor: record('action.setBadgeBackgroundColor'),
      setTitle: record('action.setTitle'),
      onClicked: listener(),
    },
    alarms: { create: record('alarms.create'), onAlarm: listener() },
    storage: {
      local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      onChanged: listener(),
    },
    contextMenus: { removeAll: () => Promise.resolve(), create: record('contextMenus.create'), onClicked: listener() },
    sidePanel: { open: record('sidePanel.open'), setPanelBehavior: () => Promise.resolve() },
    scripting: { executeScript: () => Promise.resolve([]) },
    i18n: { getUILanguage: () => 'en-US' },
  }
}

test('the debugger attachment is announced on the toolbar badge, and taken down again', async (t) => {
  const token = 'test-token'
  const host = await fakeHost(token)
  t.onCleanup(() => host.close())

  const chrome = fakeChrome()
  // The module connects on import, so the settings it reads have to point at the
  // fake host before it is loaded.
  chrome.storage.local.get = () => Promise.resolve({ port: host.port, token })

  const teardown = await loadServiceWorker(chrome)
  t.onCleanup(() => teardown())
  await awaitConnection(host)

  // ── nothing is claimed before anything is attached ──
  assert.deepEqual(badgeCalls(chrome), [], 'the badge was touched before any tab was controlled')

  // ── attach, through the real frame path ──
  host.send({ id: 1, method: 'debugger.attach', params: { tabId: 7 } })
  await until(
    () => badgeCalls(chrome).some((entry) => entry.api === 'action.setBadgeText' && entry.args[0].tabId === 7),
    'the badge to be set for tab 7',
  )

  const drawn = badgeCalls(chrome).find((entry) => entry.api === 'action.setBadgeText')
  assert.equal(drawn.args[0].text, '•', 'a controlled tab shows a mark, not an empty badge')
  assert.equal(drawn.args[0].tabId, 7, 'the badge must be set on the tab it is about, never globally')

  const coloured = badgeCalls(chrome).find((entry) => entry.api === 'action.setBadgeBackgroundColor')
  assert.ok(coloured !== undefined, 'a default-coloured badge is hard to pick out of the toolbar')
  assert.equal(coloured.args[0].tabId, 7)

  // The tooltip has to say what the dot means: a bare • is a puzzle.
  const titled = badgeCalls(chrome).find((entry) => entry.api === 'action.setTitle' && entry.args[0].tabId === 7)
  assert.ok(titled !== undefined, 'the badge is never explained')
  assert.match(titled.args[0].title, /DSH/, 'the tooltip must name what is operating the tab')

  // ── detach clears it ──
  const before = badgeCalls(chrome).length
  host.send({ id: 2, method: 'debugger.detach', params: { tabId: 7 } })
  await until(() => badgeCalls(chrome).length > before, 'the badge to be cleared on detach')

  const cleared = badgeCalls(chrome).filter((entry) => entry.api === 'action.setBadgeText').at(-1)
  assert.equal(cleared.args[0].text, '', 'a tab that is no longer controlled must stop claiming it is')
  assert.equal(cleared.args[0].tabId, 7)
})

test('a tab the person takes back stops claiming to be controlled', async (t) => {
  // The badge must come down on the path a *person* takes, not only on the one
  // the extension takes. Opening DevTools on a controlled tab detaches the
  // debugger; if the badge survived that it would be asserting a control that
  // no longer exists — the precise lie the badge is there to prevent.
  const token = 'test-token-detach'
  const host = await fakeHost(token)
  t.onCleanup(() => host.close())

  const chrome = fakeChrome()
  chrome.storage.local.get = () => Promise.resolve({ port: host.port, token })

  // Capture the detach listener so the test can fire it the way Chrome would.
  let onDetach
  chrome.debugger.onDetach = { addListener: (fn) => { onDetach = fn }, removeListener: () => {} }

  const teardown = await loadServiceWorker(chrome)
  t.onCleanup(() => teardown())
  await awaitConnection(host)

  host.send({ id: 1, method: 'debugger.attach', params: { tabId: 11 } })
  await until(
    () => badgeCalls(chrome).some((entry) => entry.api === 'action.setBadgeText' && entry.args[0].text === '•'),
    'the badge to be set',
  )

  assert.equal(typeof onDetach, 'function', 'the service worker must still listen for detach')
  onDetach({ tabId: 11 }, 'target_closed')

  await until(
    () => badgeCalls(chrome).some((entry) => entry.api === 'action.setBadgeText' && entry.args[0].text === ''),
    'the badge to be cleared when the debugger detaches on its own',
  )
})
