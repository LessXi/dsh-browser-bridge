/**
 * What the extension actually puts on the wire for a tab.
 *
 * `windowFocused` is the field that lets the host answer "which page does the
 * user mean" when several windows are open. It is computed by the service worker
 * from `chrome.windows.getLastFocused`, and nothing about it is visible in any
 * screenshot: it is a field in a JSON frame. The host-side tests in
 * `active-tab.test.js` pin what the host does *given* the field; this file pins
 * that the field is produced at all, with the right value, by the real module.
 *
 * The failure this guards is specific: `active` is true for one tab per window,
 * so a worker that reported only `active` would look entirely correct while
 * making the host's answer depend on row order.
 *
 * @module dsh-browser-bridge/test/tab-wire
 */

import { test, assert } from './harness.js'
import { awaitConnection, loadServiceWorker, fakeHost, listener, ask } from './service-worker.js'

/**
 * A `chrome` stand-in with three windows, each holding one active tab.
 *
 * The user is looking at window 2. `getLastFocused` reports it, the way Chrome
 * does; the tabs list is in an order where window 1 sorts first, so anything
 * that ignores the focused window picks the wrong tab.
 *
 * @param {object} [options] - Fixture knobs.
 * @param {boolean} [options.getLastFocusedFails] - Make Chrome refuse the call.
 * @param {boolean} [options.noWindowsApi] - Omit the namespace, as an older build would.
 * @returns {object} The fake namespace.
 */
function fakeChrome(options = {}) {
  const tabs = [
    { id: 11, windowId: 1, active: true, url: 'https://news.example/a', title: 'News', groupId: -1, status: 'complete' },
    { id: 12, windowId: 1, active: false, url: 'https://mail.example/inbox', title: 'Inbox', groupId: -1, status: 'complete' },
    { id: 21, windowId: 2, active: true, url: 'https://shop.example/cart', title: 'Cart', groupId: -1, status: 'complete' },
    { id: 31, windowId: 3, active: true, url: 'https://docs.example/spec', title: 'Spec', groupId: -1, status: 'complete' },
  ]

  const windows = options.noWindowsApi === true
    ? undefined
    : {
        getLastFocused: () =>
          options.getLastFocusedFails === true
            ? Promise.reject(new Error('no permission'))
            : Promise.resolve({ id: 2 }),
        update: () => Promise.resolve({}),
        onFocusChanged: listener(),
      }

  return {
    windows,
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
      attach: () => Promise.resolve(),
      detach: () => Promise.resolve(),
      sendCommand: () => Promise.resolve({}),
      getTargets: () => Promise.resolve([]),
      onDetach: listener(),
      onEvent: listener(),
    },
    tabs: {
      query: () => Promise.resolve(tabs),
      get: (id) => Promise.resolve(tabs.find((tab) => tab.id === id)),
      create: () => Promise.resolve({ id: 99 }),
      update: () => Promise.resolve({}),
      group: () => Promise.resolve(1),
      onCreated: listener(),
      onRemoved: listener(),
      onUpdated: listener(),
      onActivated: listener(),
    },
    tabGroups: {
      query: () => Promise.resolve([]),
      get: () => Promise.reject(new Error('no such group')),
      update: () => Promise.resolve({}),
    },
    action: {
      setBadgeText: () => Promise.resolve(),
      setBadgeBackgroundColor: () => Promise.resolve(),
      setTitle: () => Promise.resolve(),
      onClicked: listener(),
    },
    alarms: { create: () => Promise.resolve(), onAlarm: listener() },
    storage: {
      local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      onChanged: listener(),
    },
    contextMenus: { removeAll: () => Promise.resolve(), create: () => Promise.resolve(), onClicked: listener() },
    sidePanel: { open: () => Promise.resolve(), setPanelBehavior: () => Promise.resolve() },
    scripting: { executeScript: () => Promise.resolve([]) },
    i18n: { getUILanguage: () => 'en-US' },
  }
}

/**
 * Load the real worker against the fixture and list its tabs.
 *
 * @param {object} [options] - Fixture knobs, see {@link fakeChrome}.
 * @returns {Promise<object[]>} The rows the worker puts on the wire.
 */
async function listTabs(options = {}) {
  const token = `test-token-tabs-${(tokenCount += 1)}`
  const host = await fakeHost(token)
  const chrome = fakeChrome(options)
  chrome.storage.local.get = () => Promise.resolve({ port: host.port, token })
  const teardown = await loadServiceWorker(chrome)
  try {
    await awaitConnection(host)
    const answer = await ask(host, { method: 'tabs.list', params: { includeAll: true } }, 1)
    assert.equal(answer.ok, true, `tabs.list failed: ${answer.message ?? ''}`)
    return answer.value
  } finally {
    teardown()
    await host.close()
  }
}

/** Distinguishes this file's fake hosts; the module-load counter is the harness's. */
let tokenCount = 0

test('each wire row says whether its window is the one the user is looking at', async () => {
  const rows = await listTabs()
  assert.equal(rows.length, 4, 'every tab is listed')

  // This is the fact the host cannot get any other way.
  const focused = rows.filter((row) => row.windowFocused === true)
  assert.equal(focused.length, 1, 'exactly one row is in the focused window')
  assert.equal(focused[0].id, 21, 'and it is the tab in the window Chrome named')

  // The three active rows are still all present and still all active: the new
  // field adds information, it does not redefine `active`.
  assert.equal(rows.filter((row) => row.active === true).length, 3, 'one active tab per window survives')
  for (const row of rows.filter((candidate) => candidate.windowId !== 2)) {
    assert.equal(row.windowFocused, false, `[${row.id}] is in another window`)
  }
})

test('when Chrome will not name the focused window, the field is absent rather than false', async () => {
  // The distinction matters: `false` asserts "not the focused window", which is
  // a claim the worker cannot support when the call failed. Leaving it out lets
  // the host tell "no" apart from "no idea" and say so.
  const rows = await listTabs({ getLastFocusedFails: true })
  assert.equal(rows.length, 4)
  for (const row of rows) {
    assert.equal(row.windowFocused, undefined, `[${row.id}] must not claim to know`)
  }
})

test('a browser without the windows API still lists tabs', async () => {
  // `chrome.windows` is not in this extension's manifest, so an environment
  // where it is missing must degrade to the old behaviour rather than break the
  // tab list — which is what a permission failure would look like here.
  const rows = await listTabs({ noWindowsApi: true })
  assert.equal(rows.length, 4, 'tab listing survives a missing windows API')
  for (const row of rows) {
    assert.equal(row.windowFocused, undefined)
  }
})

test('tab rows keep the fields the host already depends on', async () => {
  // `windowFocused` was added to a row shape that other tools read. A refactor
  // that dropped one of these would break tab selection silently.
  const rows = await listTabs()
  const cart = rows.find((row) => row.id === 21)
  assert.equal(typeof cart.url, 'string')
  assert.equal(typeof cart.title, 'string')
  assert.equal(typeof cart.windowId, 'number')
  assert.equal(typeof cart.groupId, 'number')
  assert.equal(cart.active, true)
  assert.equal(cart.windowFocused, true)
})
