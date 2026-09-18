/**
 * Tests for the ingest half of the attachment pipeline — the browser's own
 * "add this to context" gestures.
 *
 * The gap this module closes was invisible from both ends: `context.js` had the
 * queue and its injection hook, the extension emitted the events, and nothing
 * was subscribed in between. So the assertions here are mostly about *arrival*
 * — that a right-click item ends up as a pending attachment for the right
 * session — plus the one place where arriving would be wrong: a page body must
 * not be read for a site this session was never allowed to read.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assert, test } from './harness.js'
import { ContextAttachments, renderAttachment } from '../lib/context.js'
import { EVENTS } from '../lib/protocol.js'
import { createIngest } from '../lib/ingest.js'

/**
 * Build an ingest over stubs, with a real attachment store.
 *
 * @param {object} [options] - Overrides.
 * @param {Record<string, unknown>} [options.settings] - Settings overrides.
 * @param {string[]} [options.granted] - Origins this session may already read.
 * @param {object} [options.connection] - A stand-in for the browser connection.
 * @param {string} [options.origin] - What `tabOrigin` resolves to.
 * @returns {object} The fixture.
 */
function fixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bb-ingest-'))
  const settings = {
    enabled: true,
    contextAutoPush: false,
    contextMaxChars: 10_000,
    contextPendingLimit: 50,
    contextTargetSessionId: 's1',
    pageTextMaxBytes: 200_000,
    ...options.settings,
  }
  const attachments = new ContextAttachments({
    settings: () => settings,
    makeMessage: (input) => ({ kind: 'message', ...input }),
    path: join(dir, 'context.json'),
  })
  attachments.registerAgent({ id: 's1', session: { id: 's1' } })

  const notes = []
  const calls = []
  const ingest = createIngest({
    attachments,
    grants: { find: (sessionId, origin) => (options.granted ?? []).includes(origin) ? { sessionId, origin } : undefined },
    bridge: {
      connection: options.connection ?? {
        call: async (method, params) => {
          calls.push({ method, params })
          return { text: 'the readable page', title: 'Page', url: 'https://example.com/page' }
        },
      },
    },
    settings: () => settings,
    tabOrigin: async () => options.origin ?? 'https://example.com',
    log: (message) => notes.push(message),
  })

  return {
    ingest,
    attachments,
    settings,
    calls,
    notes,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('a right-click "add selection" becomes a pending attachment', async (t) => {
  const f = fixture()
  t.onCleanup(f.cleanup)
  const result = await f.ingest.stageContextAction({
    action: 'add-selection',
    url: 'https://example.com/page',
    title: 'Page',
    tabId: 7,
    text: 'the passage the user picked',
  })
  assert.equal(result.added, true)
  assert.equal(result.sessionId, 's1')

  const [pending] = f.attachments.list('s1')
  assert.equal(pending.kind, 'selection')
  assert.equal(pending.text, 'the passage the user picked')
  assert.equal(pending.origin, 'https://example.com')
})

test('a selection action with no text stages nothing', async (t) => {
  const f = fixture()
  t.onCleanup(f.cleanup)
  const result = await f.ingest.stageContextAction({ action: 'add-selection', text: '' })
  assert.equal(result.added, false)
  assert.equal(f.attachments.list('s1').length, 0)
})

test('an unknown action is refused rather than guessed at', async (t) => {
  const f = fixture()
  t.onCleanup(f.cleanup)
  const result = await f.ingest.stageContextAction({ action: 'add-everything' })
  assert.equal(result.added, false)
  assert.match(result.reason, /add-everything/)
})

test('the extension\'s own auto-push toggle does not bypass the host gate', async (t) => {
  const f = fixture()
  t.onCleanup(f.cleanup)
  const result = await f.ingest.stageContextAction({ action: 'auto-push', enabled: true })
  assert.equal(result.added, false)
  assert.equal(f.attachments.list('s1').length, 0)
})

test('a highlight is staged only when contextAutoPush is on', async (t) => {
  const off = fixture({ settings: { contextAutoPush: false } })
  t.onCleanup(off.cleanup)
  assert.equal(off.ingest.stageSelection({ text: 'copied text' }).added, false)
  assert.equal(off.attachments.list('s1').length, 0)

  const on = fixture({ settings: { contextAutoPush: true } })
  t.onCleanup(on.cleanup)
  assert.equal(on.ingest.stageSelection({ text: 'deliberate highlight' }).added, true)
  assert.equal(on.attachments.list('s1')[0].text, 'deliberate highlight')
})

test('a disabled bridge stages nothing, whatever the gesture', async (t) => {
  const f = fixture({ settings: { enabled: false } })
  t.onCleanup(f.cleanup)
  const result = await f.ingest.stageContextAction({
    action: 'add-selection',
    url: 'https://example.com/page',
    text: 'x',
  })
  assert.equal(result.added, false)
  assert.equal(f.attachments.list('s1').length, 0)
})

test('"add this page" reads the body when the site was already allowed', async (t) => {
  const f = fixture({ granted: ['https://example.com'] })
  t.onCleanup(f.cleanup)
  const result = await f.ingest.stageContextAction({
    action: 'add-page',
    url: 'https://example.com/page',
    title: 'Page',
    tabId: 7,
  })
  assert.equal(result.added, true)
  const [pending] = f.attachments.list('s1')
  assert.equal(pending.kind, 'page')
  assert.equal(pending.text, 'the readable page')
  assert.deepEqual(f.calls.map((call) => call.method), ['page.read'])
})

test('"add this page" never reads a site the session was not allowed to read', async (t) => {
  const f = fixture({ granted: [] })
  t.onCleanup(f.cleanup)
  const result = await f.ingest.stageContextAction({
    action: 'add-page',
    url: 'https://bank.test/pay',
    title: 'Pay',
    tabId: 7,
  })
  // The user still gets something they asked for — the identity — and the page
  // body is not read at all, which is the assertion that matters.
  assert.equal(result.added, true)
  assert.equal(f.calls.length, 0)
  const [pending] = f.attachments.list('s1')
  assert.equal(pending.kind, 'tab')
  assert.equal(pending.text, '')
  assert.equal(pending.url, 'https://bank.test/pay')
})

test('an unreadable page degrades to the identity instead of failing', async (t) => {
  const f = fixture({
    granted: ['https://example.com'],
    connection: { call: async () => { throw new Error('the tab is gone') } },
  })
  t.onCleanup(f.cleanup)
  const result = await f.ingest.stageContextAction({
    action: 'add-page',
    url: 'https://example.com/page',
    tabId: 7,
  })
  assert.equal(result.added, true)
  assert.equal(f.attachments.list('s1')[0].kind, 'tab')
})

test('with no session to attach to, the gesture is refused with a reason', async (t) => {
  const f = fixture({ settings: { contextTargetSessionId: '' } })
  t.onCleanup(f.cleanup)
  f.attachments.forgetAgent({ id: 's1', session: { id: 's1' } })
  const result = await f.ingest.stageContextAction({
    action: 'add-selection',
    url: 'https://example.com/page',
    text: 'x',
  })
  assert.equal(result.added, false)
  assert.match(result.reason, /No DSH session/)
})

test('the same passage twice is one attachment', async (t) => {
  const f = fixture()
  t.onCleanup(f.cleanup)
  const click = { action: 'add-selection', url: 'https://example.com/page', text: 'same words' }
  assert.equal((await f.ingest.stageContextAction(click)).added, true)
  assert.equal((await f.ingest.stageContextAction(click)).added, false)
  assert.equal(f.attachments.list('s1').length, 1)
})

test('listenToExtension subscribes to both events and survives a throwing handler', async (t) => {
  // `contextAutoPush` is on so the selection path actually reaches the payload:
  // with the gate off it short-circuits before reading a field that throws.
  const f = fixture({ settings: { contextAutoPush: true } })
  t.onCleanup(f.cleanup)
  const listeners = new Map()
  f.ingest.listenToExtension({
    on: (event, listener) => {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
  })
  assert.deepEqual([...listeners.keys()], [EVENTS.contextMenu, EVENTS.selection])

  listeners.get(EVENTS.contextMenu)({ action: 'add-tab', url: 'https://example.com/page', title: 'Page' })
  // The handler is fire-and-forget, so the assertion waits for the microtask
  // queue rather than for a returned promise.
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(f.attachments.list('s1')[0].kind, 'tab')

  // A handler that throws must not reject into the socket that carries the
  // rest of the session.
  listeners.get(EVENTS.selection)({ get text() { throw new Error('hostile payload') } })
  await Promise.resolve()
  await Promise.resolve()
  assert.ok(f.notes.some((note) => /hostile payload/.test(note)))
})

test('a send can carry the tab in front and a mentioned one at once', () => {
  // What the `@` picker produces: the panel attaches the page in front of you
  // *and* the page the message is about. They are both `kind: 'tab'`, so the
  // only thing keeping them apart is the URL — and the store dedupes on
  // `kind + url + text`, which means two different pages survive and the same
  // page twice does not.
  const f = fixture()
  try {
    const result = f.ingest.stageRequested([
      { kind: 'tab', url: 'https://github.com/LessXi/dsh-browser-bridge', title: 'DSH Browser Bridge', tabId: 11 },
      { kind: 'tab', url: 'https://dl.acm.org/doi/10.1145/3809166', title: 'Network Edge Inference', tabId: 7 },
    ], 's1')

    assert.deepEqual(result, { staged: 2, refused: [] })
    const stored = f.attachments.list('s1')
    assert.equal(stored.length, 2, 'only one of the two tabs was kept')
    assert.deepEqual(
      stored.map((each) => each.title),
      ['DSH Browser Bridge', 'Network Edge Inference'],
    )
    // The model needs to tell them apart, and the header alone does not do it:
    // both render as `tab from <host>`. The Source line is what carries the
    // identity, so it has to be there for both.
    const rendered = stored.map((each) => renderAttachment(each)).join('\n')
    assert.ok(rendered.includes('Source: https://github.com/LessXi/dsh-browser-bridge'), 'the mentioned tab has no source line')
    assert.ok(rendered.includes('Source: https://dl.acm.org/doi/10.1145/3809166'), 'the current tab has no source line')
  } finally {
    f.cleanup()
  }
})

test('the same page named twice is one attachment, not two', () => {
  // Mentioning the tab you are already on must not double it. This is what the
  // dedupe key is for, and it is the case a user hits by typing `@` and picking
  // the page already in front of them.
  const f = fixture()
  try {
    const result = f.ingest.stageRequested([
      { kind: 'tab', url: 'https://example.com/page', title: 'Page', tabId: 7 },
      { kind: 'tab', url: 'https://example.com/page', title: 'Page', tabId: 7 },
    ], 's1')
    assert.equal(result.staged, 1, 'the same page was staged twice')
    assert.equal(f.attachments.list('s1').length, 1)
  } finally {
    f.cleanup()
  }
})

test('stageRequested reports what it could not take, and takes the rest', () => {
  // A refusal has to be visible: an attachment that was promised by a chip and
  // silently dropped is the failure this reporting exists for.
  const f = fixture()
  try {
    const result = f.ingest.stageRequested([
      { kind: 'selection', text: '', url: 'https://example.com/page' },
      { kind: 'tab', url: 'https://example.com/other', title: 'Other' },
    ], 's1')
    assert.equal(result.staged, 1, 'the usable attachment was dropped along with the bad one')
    assert.deepEqual(result.refused, ['a selection attachment with no text'])
  } finally {
    f.cleanup()
  }
})

test('stageRequested refuses everything when there is no session to attach to', () => {
  const f = fixture()
  try {
    const result = f.ingest.stageRequested([{ kind: 'tab', url: 'https://example.com/page' }], '')
    assert.deepEqual(result, { staged: 0, refused: ['no session to attach to'] })
    assert.equal(f.attachments.list('').length, 0)
  } finally {
    f.cleanup()
  }
})

test('an unknown kind is stored as a tab rather than rejected', () => {
  // A newer panel may send a kind this host has never heard of. Storing it as
  // `tab` keeps the attachment reachable; refusing it would lose the context
  // with nothing said.
  const f = fixture()
  try {
    const result = f.ingest.stageRequested([{ kind: 'screenshot', url: 'https://example.com/page' }], 's1')
    assert.equal(result.staged, 1)
    assert.equal(f.attachments.list('s1')[0].kind, 'tab')
  } finally {
    f.cleanup()
  }
})