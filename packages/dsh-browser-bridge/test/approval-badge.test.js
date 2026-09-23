/**
 * The badge that says a question is waiting, for someone whose panel is shut.
 *
 * The side panel is a separate document. While it is closed its JavaScript is
 * not running, so `chrome.runtime.onMessage` has no listener and the
 * `approval/asked` frame the host sends reaches nobody. Measured before this was
 * written: the frame goes out, nothing renders, and the turn waits with no
 * visible reason anywhere on screen. The panel already recovers the question
 * when it does open, so what was missing was not the answer — it was knowing
 * that there was anything to answer.
 *
 * The toolbar badge is where that can be said. It is painted by the browser, so
 * no page can cover it, and it is on screen while the person looks anywhere in
 * the window. It is also the one thing no screenshot in `.tmp-run/` can see,
 * which is why this is a suite and not a screenshot: the module is the real
 * `extension/background.js`, the frames come over a real socket, and the
 * assertions are about the calls it made to `chrome.action.*`.
 *
 * @module dsh-browser-bridge/test/approval-badge
 */
import { assert, test } from './harness.js'
import { awaitConnection, fakeHost, loadServiceWorker, listener, until } from './service-worker.js'

/** Every `action.*` call the extension made, in order. */
const badgeCalls = (chrome) => chrome.log.filter((entry) => entry.api.startsWith('action.'))

/** The most recent `setBadgeText` call, for the tab or for the whole browser. */
const lastText = (chrome, tabId) =>
  badgeCalls(chrome)
    .filter((entry) => entry.api === 'action.setBadgeText' && entry.args[0].tabId === tabId)
    .at(-1)

/**
 * A `chrome` stand-in that records what the extension asked it to do.
 *
 * `sendMessage` is recorded rather than ignored: one of the properties under
 * test is that the badge is added *without* breaking the existing delivery
 * attempt to the panel, which still works whenever the panel happens to be open.
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
      sendMessage: record('runtime.sendMessage'),
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

/**
 * Start a worker connected to a fake host, with a tab already under control.
 *
 * The controlled tab is the interesting case: it is the tab a browser tool call
 * is about to touch, so it is the tab the question concerns, and it already
 * carries a mark of its own that the question has to displace.
 *
 * @param {object} t - The test context, for cleanup registration.
 * @returns {Promise<{ host: object, chrome: object }>} The loaded pair.
 */
async function connectedWorker(t) {
  const host = await fakeHost('test-token')
  t.onCleanup(() => host.close())

  const chrome = fakeChrome()
  // The module connects on import, so the settings it reads must point at the
  // fake host before it is loaded.
  chrome.storage.local.get = () => Promise.resolve({ port: host.port, token: 'test-token' })

  const teardown = await loadServiceWorker(chrome)
  t.onCleanup(() => teardown())
  await awaitConnection(host)

  host.send({ id: 1, method: 'debugger.attach', params: { tabId: 7 } })
  await until(() => lastText(chrome, 7)?.args[0].text === '•', 'tab 7 to be marked as controlled')
  return { host, chrome }
}

test('a question asked while no panel is open still reaches the person', async (t) => {
  const { host, chrome } = await connectedWorker(t)

  host.send({
    notify: 'approval/asked',
    payload: { id: 'q1', sessionId: 's1', toolName: 'browser_eval', options: ['allowed-once', 'rejected'] },
  })

  // The global badge is the placement every tab without one of its own shows,
  // which includes every window that has no DSH tab in it at all.
  await until(
    () => lastText(chrome, undefined)?.args[0].text === '1',
    'the browser-wide badge to report one open question',
  )

  // A count, not a dot: two gated tools in one turn must read as two.
  assert.equal(lastText(chrome, 7)?.args[0].text, '1', 'a controlled tab shows the question, not its own dot')

  const colours = badgeCalls(chrome)
    .filter((entry) => entry.api === 'action.setBadgeBackgroundColor' && entry.args[0].tabId === 7)
    .map((entry) => entry.args[0].color)
  assert.equal(colours.at(-1), '#d1453b', 'a question is not the same event as control and must not share its colour')

  // The tooltip is the only place with room to say what the number means.
  const titled = badgeCalls(chrome)
    .filter((entry) => entry.api === 'action.setTitle' && entry.args[0].tabId === 7)
    .at(-1)
  assert.match(titled.args[0].title, /approval/i, 'the tooltip has to name what is being waited for')
  assert.notEqual(titled.args[0].title, 'DSH is operating this tab', 'control and a question are different states')

  // The delivery attempt to the panel is still made: it works whenever the panel
  // happens to be open, and the badge is the addition, not the replacement.
  assert.ok(
    chrome.log.some(
      (entry) => entry.api === 'runtime.sendMessage' && entry.args[0]?.type === 'dsh-approval-asked',
    ),
    'the panel is still offered the question when it is open',
  )
})

test('the badge comes down whichever surface answered', async (t) => {
  const { host, chrome } = await connectedWorker(t)

  host.send({ notify: 'approval/asked', payload: { id: 'q1', sessionId: 's1', toolName: 'browser_eval' } })
  await until(() => lastText(chrome, undefined)?.args[0].text === '1', 'the question to be reported')

  // Settled by the panel, by the graphical client, or by the turn being
  // cancelled: the host reports all three the same way, and every one of them
  // means the question is no longer open.
  host.send({ notify: 'approval/settled', payload: { id: 'q1', outcome: 'allowed-once' } })

  await until(() => lastText(chrome, undefined)?.args[0].text === '', 'the question to stop being reported')
  assert.equal(lastText(chrome, 7)?.args[0].text, '•', 'the controlled tab goes back to its own mark')
})

test('one answered question does not clear another that is still open', async (t) => {
  // A turn can hit two gated tools. Clearing the badge when the first is
  // answered would tell the person they are done while a second question is
  // still blocking the run.
  const { host, chrome } = await connectedWorker(t)

  host.send({ notify: 'approval/asked', payload: { id: 'q1', sessionId: 's1', toolName: 'browser_eval' } })
  await until(() => lastText(chrome, undefined)?.args[0].text === '1', 'the first question')
  host.send({ notify: 'approval/asked', payload: { id: 'q2', sessionId: 's1', toolName: 'browser_cdp' } })
  await until(() => lastText(chrome, undefined)?.args[0].text === '2', 'the second question')

  host.send({ notify: 'approval/settled', payload: { id: 'q1', outcome: 'allowed-once' } })
  await until(() => lastText(chrome, undefined)?.args[0].text === '1', 'the count to drop back to one')

  host.send({ notify: 'approval/settled', payload: { id: 'q2', outcome: 'rejected' } })
  await until(() => lastText(chrome, undefined)?.args[0].text === '', 'the count to reach zero')
})

test('a question does not outlive the harness that asked it', async (t) => {
  // A question is answered over the socket. When the harness goes away the
  // question can no longer be answered, and `approval/settled` — which is what
  // normally clears the badge — can never arrive. Leaving the badge up would
  // send the person to a panel that cannot help them, and it would stay there
  // for as long as the browser lived.
  const { host, chrome } = await connectedWorker(t)

  host.send({ notify: 'approval/asked', payload: { id: 'q1', sessionId: 's1', toolName: 'browser_eval' } })
  await until(() => lastText(chrome, undefined)?.args[0].text === '1', 'the question to be reported')

  await host.close()
  await until(() => lastText(chrome, undefined)?.args[0].text === '', 'the badge to come down with the connection')
})
