/**
 * What the extension tells the host about itself when it connects.
 *
 * The status popover renders a "note" row per entry in `status.hello.limitations`,
 * and that greeting is the only place the host ever learns anything about the
 * install: the health route is answered from state the host already holds, and
 * the request direction is extension→host only, so the host cannot ask later.
 *
 * The row used to be unreachable. The greeting carried `{ version }` alone while
 * the card read `status.hello.limitations`, so a limitation the panel was built
 * to explain could not appear on it — and no test noticed, because the host's
 * fake in `service-worker.js` dropped unprompted frames on the floor. It records
 * them now, which is what lets these tests read the real payload.
 *
 * The other half matters as much: the note must be silent when the limitation is
 * not real. A row that shows whether or not the problem exists teaches people to
 * ignore it, so an API that is missing, that rejects, or that answers "yes" all
 * produce no note.
 *
 * @module dsh-browser-bridge/test/hello-wire
 */

import { test, assert } from './harness.js'
import { awaitConnection, loadServiceWorker, fakeHost, until } from './service-worker.js'

let tokenCount = 0

/**
 * A `chrome` stand-in that can answer the file-access question.
 *
 * @param {object} [options] - Fixture knobs.
 * @param {boolean|undefined} [options.fileAccess] - What the API answers; `undefined` omits it.
 * @param {boolean} [options.fileAccessRejects] - Make the call reject.
 * @returns {object} The fake namespace.
 */
function fakeChrome(options = {}) {
  const extension = options.fileAccess === undefined && options.fileAccessRejects !== true
    ? undefined
    : {
        isAllowedFileSchemeAccess: () =>
          options.fileAccessRejects === true
            ? Promise.reject(new Error('not implemented'))
            : Promise.resolve(options.fileAccess),
      }

  return {
    extension,
    runtime: {
      id: 'test-extension-id',
      getManifest: () => ({ name: 'DSH', version: '0.0.0-test' }),
      onMessage: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      sendMessage: () => Promise.resolve(),
      lastError: undefined,
    },
    debugger: {
      attach: () => Promise.resolve(),
      detach: () => Promise.resolve(),
      sendCommand: () => Promise.resolve({}),
      getTargets: () => Promise.resolve([]),
      onDetach: { addListener: () => {} },
      onEvent: { addListener: () => {} },
    },
    tabs: {
      query: () => Promise.resolve([]),
      get: () => Promise.resolve(undefined),
      create: () => Promise.resolve({ id: 99 }),
      update: () => Promise.resolve({}),
      group: () => Promise.resolve(1),
      onCreated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
      onActivated: { addListener: () => {} },
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
      onClicked: { addListener: () => {} },
    },
    alarms: { create: () => Promise.resolve(), onAlarm: { addListener: () => {} } },
    storage: {
      local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      onChanged: { addListener: () => {} },
    },
    contextMenus: {
      removeAll: () => Promise.resolve(),
      create: () => Promise.resolve(),
      onClicked: { addListener: () => {} },
    },
    sidePanel: { open: () => Promise.resolve(), setPanelBehavior: () => Promise.resolve() },
    scripting: { executeScript: () => Promise.resolve([]) },
    i18n: { getUILanguage: () => 'en-US' },
  }
}

/**
 * Load the real worker and return the greeting it sent on connect.
 *
 * @param {object} [options] - Fixture knobs, see {@link fakeChrome}.
 * @returns {Promise<{ hello: object, notes: string[] }>} The payload and its notes.
 */
async function connectAndGreet(options = {}) {
  const token = `test-token-hello-${(tokenCount += 1)}`
  const host = await fakeHost(token)
  const chrome = fakeChrome(options)
  chrome.storage.local.get = () => Promise.resolve({ port: host.port, token })
  const teardown = await loadServiceWorker(chrome)
  try {
    await awaitConnection(host)
    await until(
      () => host.notifications.some((frame) => frame.event === 'bridge/hello'),
      'the greeting to arrive',
    )
    const greeting = host.notifications.find((frame) => frame.event === 'bridge/hello')
    const notes = Array.isArray(greeting?.payload?.limitations) ? greeting.payload.limitations : null
    return { hello: greeting?.payload ?? null, notes }
  } finally {
    teardown()
    await host.close()
  }
}

test('the greeting carries the limitations the panel reads, not just the version', async (t) => {
  const { hello, notes } = await connectAndGreet({ fileAccess: false })

  assert.ok(hello !== null, 'the worker never sent a bridge/hello frame')
  assert.equal(typeof hello.version, 'string', 'the version must still ride the greeting')
  assert.ok(Array.isArray(notes), `limitations must be an array, got ${JSON.stringify(hello.limitations)}`)
  assert.equal(notes.length, 1, `expected exactly one note when file access is off, got ${JSON.stringify(notes)}`)
  assert.match(notes[0], /Allow access to file URLs/, `the note must name the setting to change, got: ${notes[0]}`)
})

test('a limitation that is not real produces no note', async (t) => {
  // The switch is on, so uploads work and there is nothing to warn about. A note
  // here would be the panel telling people to fix something that is not broken.
  const { notes } = await connectAndGreet({ fileAccess: true })

  assert.ok(Array.isArray(notes), 'limitations must still be an array')
  assert.deepEqual(notes, [], `file access is allowed, so there must be no note, got ${JSON.stringify(notes)}`)
})

test('a browser that cannot answer the question is not reported as a limitation', async (t) => {
  // Two ways to be unable to tell: the namespace is absent (an older host), and
  // the call itself rejects. Neither is evidence that uploads are broken, so
  // neither may produce a note — an unknown reported as a warning is exactly the
  // false alarm that makes the row unreadable.
  const absent = await connectAndGreet({})
  assert.deepEqual(absent.notes, [], `a missing API must not produce a note, got ${JSON.stringify(absent.notes)}`)

  const rejected = await connectAndGreet({ fileAccessRejects: true })
  assert.deepEqual(rejected.notes, [], `a rejecting API must not produce a note, got ${JSON.stringify(rejected.notes)}`)
})

test('a greeting that cannot be built still reports the version', async (t) => {
  // `limitations()` catches its own failures because the same frame carries the
  // version the host displays. If the check could throw, one unavailable API
  // would take the whole greeting with it and the panel would show no extension
  // version at all.
  const { hello, notes } = await connectAndGreet({ fileAccessRejects: true })

  assert.equal(hello.version, '0.0.0-test', 'the version must survive a failing limitation check')
  assert.deepEqual(notes, [], 'a failing check reports no notes')
})
