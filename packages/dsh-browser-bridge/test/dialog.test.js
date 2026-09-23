/**
 * What the extension does about a page's own alert/confirm/prompt.
 *
 * Measured in a real Chrome, a JavaScript dialog stops the tab it belongs to
 * dead: `Runtime.evaluate`, `DOM.getDocument` and `Page.captureScreenshot` each
 * went from a 4ms baseline to not answering at all within four seconds of an
 * `alert()` appearing. The extension had no handling for this whatsoever, while
 * `lib/tools.js` already told the model "a dialog may be open" as a possible
 * cause of a timeout — a sentence that admitted the problem without anything
 * acting on it.
 *
 * The fix has three parts and each needs its own assertion, because any one of
 * them alone leaves the tab stuck:
 *
 *   1. `Page.javascriptDialogOpening` is subscribed to at all, and the record it
 *      builds is the one the rest of the file reads.
 *   2. `page.dialogs` reports it **without touching the page**, since a page with
 *      a dialog up cannot answer a CDP command.
 *   3. `page.dismissDialog` answers it, and dismissing is the default branch.
 *
 * The subscription half is invisible to every other kind of test: it is an event
 * the browser sends over a socket, which no screenshot and no transcript shows.
 *
 * @module dsh-browser-bridge/test/dialog
 */

import { test, assert } from './harness.js'
import { awaitConnection, loadServiceWorker, fakeHost, listener } from './service-worker.js'

/**
 * Attach the worker to tab 7, which is what a real session does before any page
 * command and what issues the observers' CDP enables.
 *
 * Every test here needs it for the same reason: `Page.enable` arrives with the
 * attach, and without it Chrome never sends `Page.javascriptDialogOpening`, so a
 * test that skipped this would be measuring a worker that cannot hear the event
 * under test.
 *
 * @param {object} host - The fake host.
 * @param {object} chrome - The fake namespace.
 * @returns {Promise<string[]>} The commands the attach issued, before they are
 *   cleared, so a caller can assert on them.
 */
async function attachTab(host, chrome) {
  const answered = new Promise((resolve) => host.answers.set(1, resolve))
  host.send({ id: 1, method: 'debugger.attach', params: { tabId: 7 } })
  const answer = await answered
  assert.equal(answer.ok, true, `debugger.attach failed: ${answer.message ?? ''}`)
  const issued = [...chrome.__cdp]
  // Cleared so a later assertion counts only what the call under test issued.
  chrome.__cdp.length = 0
  return issued
}

/**
 * A `chrome` stand-in whose debugger records every command it is sent.
 *
 * `sendCommand` answers `Runtime.evaluate` with a value the test can steer, so
 * "the poll succeeded", "the poll was blocked" and "the poll was cancelled" are
 * three distinguishable outcomes rather than one timeout.
 *
 * @param {object} [options] - Fixture knobs.
 * @param {() => void} [options.onEvaluate] - Called on each `Runtime.evaluate`.
 * @returns {object} The fake namespace.
 */
function fakeChrome(options = {}) {
  const tabs = [
    { id: 7, windowId: 1, active: true, url: 'https://shop.example/cart', title: 'Cart', groupId: -1, status: 'complete' },
  ]
  const sent = []

  return {
    /** Every CDP command the worker issued, in order. */
    __cdp: sent,
    /** Fire one debugger event, the way Chrome does. */
    __emit(method, params, tabId = 7) {
      for (const fn of options.eventListeners ?? []) fn({ tabId }, method, params)
    },
    storage: {
      local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      onChanged: listener(),
    },
    runtime: {
      id: 'dialog-test',
      getManifest: () => ({ version: '0.0.0-test' }),
      getBrowserInfo: () => Promise.resolve({ name: 'Chrome', version: '153' }),
      onMessage: listener(),
      onConnect: listener(),
      onInstalled: listener(),
      onStartup: listener(),
      sendMessage: () => Promise.resolve(),
      openOptionsPage: () => {},
      lastError: undefined,
    },
    tabs: {
      query: () => Promise.resolve(tabs),
      get: (id) => Promise.resolve(tabs.find((tab) => tab.id === id) ?? tabs[0]),
      create: () => Promise.resolve(tabs[0]),
      update: () => Promise.resolve(tabs[0]),
      remove: () => Promise.resolve(),
      group: () => Promise.resolve(1),
      onUpdated: listener(),
      onRemoved: listener(),
      onActivated: listener(),
      onCreated: listener(),
    },
    tabGroups: { query: () => Promise.resolve([]), update: () => Promise.resolve({}), onUpdated: listener() },
    debugger: {
      getTargets: () => Promise.resolve([{ tabId: 7, attached: true }]),
      attach: () => Promise.resolve(),
      detach: () => Promise.resolve(),
      sendCommand: (_target, method) => {
        sent.push(method)
        if (method === 'Runtime.evaluate') {
          options.onEvaluate?.()
          return Promise.resolve({ result: { type: 'boolean', value: options.evaluateValue === true } })
        }
        return Promise.resolve({})
      },
      onEvent: {
        addListener: (fn) => {
          options.eventListeners = options.eventListeners ?? []
          options.eventListeners.push(fn)
        },
        removeListener: () => {},
      },
      onDetach: listener(),
    },
    windows: { getLastFocused: () => Promise.resolve({ id: 1 }), update: () => Promise.resolve({}), onFocusChanged: listener() },
    action: {
      setBadgeText: () => Promise.resolve(),
      setBadgeBackgroundColor: () => Promise.resolve(),
      setTitle: () => Promise.resolve(),
      onClicked: listener(),
    },
    alarms: { create: () => {}, clear: () => Promise.resolve(), onAlarm: listener() },
    scripting: { executeScript: () => Promise.resolve([]) },
    i18n: { getUILanguage: () => 'en-US' },
    sidePanel: { open: () => Promise.resolve(), setPanelBehavior: () => Promise.resolve() },
    contextMenus: { create: () => {}, removeAll: () => Promise.resolve(), onClicked: listener() },
    history: { search: () => Promise.resolve([]) },
    downloads: { download: () => Promise.resolve(1), onChanged: listener() },
    permissions: { contains: () => Promise.resolve(true) },
  }
}

/** Distinguishes this file's fake hosts; the module-load counter is the harness's. */
let tokenCount = 0

/**
 * Start a worker against a fake host.
 *
 * @param {object} [options] - Passed through to {@link fakeChrome}.
 * @returns {Promise<{ host: object, chrome: object, teardown: () => void }>} The trio.
 */
async function start(options = {}) {
  const token = `dialog-token-${(tokenCount += 1)}`
  const host = await fakeHost(token)
  const chrome = fakeChrome(options)
  chrome.storage.local.get = () => Promise.resolve({ port: host.port, token })
  const teardown = await loadServiceWorker(chrome)
  await awaitConnection(host)
  return { host, chrome, teardown }
}

test('the extension subscribes to the dialog event, and records what it says', async (t) => {
  // Without the subscription the other two halves have nothing to read, and the
  // failure is silent: no error, no event, just a tab that never answers.
  const { host, chrome, teardown } = await start()
  t.onCleanup(() => {
    teardown()
    return host.close()
  })
  const issued = await attachTab(host, chrome)

  // `Page.enable` is what makes Chrome send `Page.javascriptDialogOpening` at
  // all, so a worker that attached without it never hears about a dialog. This is
  // the half of the subscription that no event-driven test can see.
  assert.ok(
    issued.includes('Page.enable'),
    `attaching did not enable the Page domain, so no dialog event can arrive: ${JSON.stringify(issued)}`,
  )

  chrome.__emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'delete everything?' })

  const answered = new Promise((resolve) => host.answers.set(11, resolve))
  host.send({ id: 11, method: 'page.dialogs', params: { tabId: 7 } })
  const answer = await answered

  assert.equal(answer.ok, true, `page.dialogs failed: ${answer.message ?? ''}`)
  assert.equal(answer.value?.dialog?.type, 'confirm', 'the recorded dialog type is wrong')
  assert.equal(answer.value?.dialog?.message, 'delete everything?', 'the recorded message is wrong')
})

test('reporting a dialog never asks the page, which cannot answer', async (t) => {
  // The subtle half. A report built on `Page.getLayoutMetrics` — which is what
  // `pageInfo` does — would time out in exactly the situation it exists to
  // explain, because the renderer is suspended while the dialog is up.
  const { host, chrome, teardown } = await start()
  t.onCleanup(() => {
    teardown()
    return host.close()
  })
  await attachTab(host, chrome)

  chrome.__emit('Page.javascriptDialogOpening', { type: 'alert', message: 'are you sure?' })
  const before = chrome.__cdp.length

  const answered = new Promise((resolve) => host.answers.set(12, resolve))
  host.send({ id: 12, method: 'page.dialogs', params: { tabId: 7 } })
  const answer = await answered

  assert.equal(answer.value?.dialog?.message, 'are you sure?')
  assert.deepEqual(
    chrome.__cdp.slice(before),
    [],
    'reporting the dialog issued a CDP command, which is the one thing a blocked tab cannot serve',
  )
})

test('answering the dialog uses the dismissal branch and clears the record', async (t) => {
  const { host, chrome, teardown } = await start()
  t.onCleanup(() => {
    teardown()
    return host.close()
  })
  await attachTab(host, chrome)

  chrome.__emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'delete everything?' })
  const before = chrome.__cdp.length

  const answered = new Promise((resolve) => host.answers.set(13, resolve))
  host.send({ id: 13, method: 'page.dismissDialog', params: { tabId: 7 } })
  const answer = await answered

  assert.equal(answer.ok, true, `page.dismissDialog failed: ${answer.message ?? ''}`)
  assert.deepEqual(
    chrome.__cdp.slice(before),
    ['Page.handleJavaScriptDialog'],
    'answering did not issue exactly the one command that unblocks a tab',
  )

  // And the record is gone, so a later report does not keep accusing the tab.
  const after = new Promise((resolve) => host.answers.set(14, resolve))
  host.send({ id: 14, method: 'page.dialogs', params: { tabId: 7 } })
  assert.equal((await after).value?.dialog, null, 'the dialog record survived being answered')
})

test('a dialog makes a wait stop early and say why, instead of timing out', async (t) => {
  // The payoff, and the reason this is worth a whole feature: without it, a
  // `page.waitFor` polls for its full fifteen-second budget on a tab that cannot
  // possibly answer, and reports a timeout that names nothing.
  let polls = 0
  const { host, chrome, teardown } = await start({ onEvaluate: () => { polls += 1 } })
  t.onCleanup(() => {
    teardown()
    return host.close()
  })
  await attachTab(host, chrome)

  chrome.__emit('Page.javascriptDialogOpening', { type: 'alert', message: 'stuck' })

  const answered = new Promise((resolve) => host.answers.set(15, resolve))
  host.send({ id: 15, method: 'page.waitFor', params: { tabId: 7, selector: '#never', timeoutMs: 30_000 } })
  const answer = await answered

  assert.equal(answer.ok, true, `page.waitFor failed: ${answer.message ?? ''}`)
  assert.equal(answer.value?.blockedByDialog?.type, 'alert', 'the wait did not report the dialog blocking it')
  assert.equal(answer.value?.blockedByDialog?.message, 'stuck')
  assert.equal(
    polls,
    0,
    `the wait polled a blocked tab ${polls} time(s), which cannot succeed and burns the whole budget`,
  )
})

test('a dialog that closes stops blocking, so the next wait polls again', async (t) => {
  // The record is what every other check reads, so a stale entry would keep
  // tools refusing to work on a tab that is perfectly healthy — the same class
  // of lie the toolbar badge exists to avoid.
  const { host, chrome, teardown } = await start()
  t.onCleanup(() => {
    teardown()
    return host.close()
  })
  await attachTab(host, chrome)

  chrome.__emit('Page.javascriptDialogOpening', { type: 'alert', message: 'brief' })
  chrome.__emit('Page.javascriptDialogClosed', { result: false })

  const answered = new Promise((resolve) => host.answers.set(16, resolve))
  host.send({ id: 16, method: 'page.dialogs', params: { tabId: 7 } })
  const answer = await answered

  assert.equal(answer.value?.dialog, null, 'a closed dialog was still reported as blocking')
})
