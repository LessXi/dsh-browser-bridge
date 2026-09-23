/**
 * What happens to work already running when the host stops waiting.
 *
 * The host rejects a cancelled call the moment a turn is stopped, but that only
 * ends *its* wait. The extension used to keep going regardless: `page.waitFor`
 * polls until its own timeout and `page.navigate` waits up to twenty seconds for
 * a load — so pressing Stop left the browser still driving the page, which is
 * the one thing the button promises to end. None of that is visible in a
 * screenshot or in a transcript: it is a frame that does or does not arrive on a
 * socket, which is why it needs this suite.
 *
 * The assertion that matters is not "a notification was sent" but "the polling
 * stopped early". A test that only checked the wire would pass against a worker
 * that recorded the cancellation and ignored it.
 *
 * @module dsh-browser-bridge/test/call-cancel
 */

import { test, assert } from './harness.js'
import { awaitConnection, loadServiceWorker, fakeHost, listener, until } from './service-worker.js'

/**
 * A `chrome` stand-in whose page never satisfies a wait.
 *
 * `Runtime.evaluate` always answers `false`, so a poll can only end by timing out
 * or by being cancelled — there is no third way for it to stop, which is what
 * makes a short run proof of cancellation rather than proof of success.
 *
 * @param {object} [options] - Fixture knobs.
 * @param {() => void} [options.onEvaluate] - Called on every poll, so a test can
 *   count how long the worker kept working.
 * @returns {object} The fake namespace.
 */
function fakeChrome(options = {}) {
  const tabs = [
    { id: 7, windowId: 1, active: true, url: 'https://example.com/', title: 'Example', groupId: -1, status: 'complete' },
  ]

  return {
    storage: {
      local: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve(),
      },
      onChanged: listener(),
    },
    runtime: {
      id: 'cancel-test',
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
    tabGroups: {
      query: () => Promise.resolve([]),
      update: () => Promise.resolve({}),
      onUpdated: listener(),
    },
    debugger: {
      getTargets: () => Promise.resolve([]),
      attach: () => Promise.resolve(),
      detach: () => Promise.resolve(),
      sendCommand: (_target, method) => {
        if (method === 'Runtime.evaluate') {
          options.onEvaluate?.()
          return Promise.resolve({ result: { type: 'boolean', value: false } })
        }
        return Promise.resolve({})
      },
      onEvent: listener(),
      onDetach: listener(),
    },
    windows: {
      getLastFocused: () => Promise.resolve({ id: 1 }),
      update: () => Promise.resolve({}),
      onFocusChanged: listener(),
    },
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

/**
 * Start a worker against a fake host and return both.
 *
 * @param {object} [options] - Passed through to {@link fakeChrome}.
 * @returns {Promise<{ host: object, teardown: () => void }>} The pair.
 */
async function start(options = {}) {
  const token = `cancel-token-${(tokenCount += 1)}`
  const host = await fakeHost(token)
  const chrome = fakeChrome(options)
  // The worker reads the port and token from storage at import time, so the
  // fixture has to answer with the host it is about to dial.
  chrome.storage.local.get = () => Promise.resolve({ port: host.port, token })
  const teardown = await loadServiceWorker(chrome)
  await awaitConnection(host)
  return { host, teardown }
}

/** Distinguishes this file's fake hosts; the module-load counter is the harness's. */
let tokenCount = 0

test('a cancelled page.waitFor stops polling instead of finishing its budget', async (t) => {
  // The defect this pins: the host gives up, and the browser keeps asking the
  // page the same question for the rest of a fifteen-second budget.
  let polls = 0
  const { host, teardown } = await start({ onEvaluate: () => { polls += 1 } })
  t.onCleanup(() => {
    teardown()
    return host.close()
  })

  // A long budget, so a worker that ignored the cancellation would still be
  // polling when this test asserted.
  const answered = new Promise((resolve) => {
    host.answers.set(42, resolve)
  })
  host.send({
    id: 42,
    method: 'page.waitFor',
    params: { tabId: 7, selector: '#never', timeoutMs: 60_000 },
  })

  // Let it get going, then stop it the way the host does.
  await until(() => polls >= 1, 'the first poll')
  host.send({ notify: 'call/cancelled', payload: { id: 42 } })

  const answer = await answered
  const pollsAtAnswer = polls

  assert.equal(answer.ok, true, 'a cancelled wait answered with a failure instead of reporting the cancellation')
  assert.equal(answer.value?.cancelled, true, 'the wait ended without saying it was cancelled')

  // The real assertion: it stopped. A worker that recorded the cancellation and
  // ignored it would keep polling, and this is what would catch that.
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(
    polls,
    pollsAtAnswer,
    `polling continued after cancellation: ${pollsAtAnswer} polls at the answer, ${polls} 500ms later`,
  )
})

test('a cancellation for one call does not stop a different one', async (t) => {
  // Ids are handed out per call and a stale cancellation must not be applied to
  // whatever happens to be running now. Without the id check this is exactly the
  // shape of bug that would make one stopped turn silently kill the next one.
  let polls = 0
  const { host, teardown } = await start({ onEvaluate: () => { polls += 1 } })
  t.onCleanup(() => {
    teardown()
    return host.close()
  })

  let answered = false
  host.answers.set(50, () => { answered = true })
  host.send({
    id: 50,
    method: 'page.waitFor',
    params: { tabId: 7, selector: '#never', timeoutMs: 1200 },
  })

  await until(() => polls >= 1, 'the first poll')
  // A cancellation for a request that is not this one.
  host.send({ notify: 'call/cancelled', payload: { id: 999 } })

  // Give it long enough that a worker which ignored the id would have stopped.
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(answered, false, 'a cancellation for another id ended this call')
  assert.ok(polls >= 2, `the uncancelled call stopped polling (${polls} polls)`)

  // Let it finish on its own so the cleanup is not waiting on a live timer.
  await until(() => answered, 'the uncancelled call to finish')
})

test('a completed call is forgotten, so a late cancellation cannot hit the next one', async (t) => {
  // The set only holds work genuinely in flight. A request that has already
  // answered must not leave its id behind for a later call to inherit — the next
  // request could take the same number, and it would then be stopped by a
  // cancellation meant for something that finished long ago.
  const { host, teardown } = await start()
  t.onCleanup(() => {
    teardown()
    return host.close()
  })

  // A call that answers immediately.
  const first = new Promise((resolve) => host.answers.set(60, resolve))
  host.send({ id: 60, method: 'bridge.status', params: {} })
  const answer = await first
  assert.equal(answer.ok, true, 'the first call did not answer, so nothing below is proved')

  // The host gives up on it after the fact.
  host.send({ notify: 'call/cancelled', payload: { id: 60 } })

  // Now the same id is reused, and must run to completion.
  let answered = false
  host.answers.set(60, () => { answered = true })
  host.send({
    id: 60,
    method: 'page.waitFor',
    params: { tabId: 7, selector: '#never', timeoutMs: 600 },
  })

  await until(() => answered, 'the reused id to finish on its own')
  assert.equal(answered, true, 'a late cancellation for a finished call stopped a later one')
})

test('a cancellation for an unknown id is ignored rather than remembered', async (t) => {
  // Nothing is in flight, and the worker must not start collecting ids it cannot
  // match: an unbounded set would be a slow leak, and remembering an id that was
  // never used is how a later call gets stopped for no reason.
  const { host, teardown } = await start()
  t.onCleanup(() => {
    teardown()
    return host.close()
  })

  host.send({ notify: 'call/cancelled', payload: { id: 12345 } })
  host.send({ notify: 'call/cancelled', payload: { id: 'not-a-number' } })
  host.send({ notify: 'call/cancelled', payload: null })

  // The worker is still healthy: a normal call answers.
  const answered = new Promise((resolve) => host.answers.set(70, resolve))
  host.send({ id: 70, method: 'bridge.status', params: {} })
  const answer = await answered
  assert.equal(answer.ok, true, `the worker stopped answering after stray cancellations: ${JSON.stringify(answer)}`)
})
