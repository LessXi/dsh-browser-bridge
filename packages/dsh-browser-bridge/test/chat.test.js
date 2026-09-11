/**
 * Tests for the side panel's chat surface.
 *
 * The fixtures use the shapes the harness actually writes, not convenient ones.
 * That matters here more than usual, because every defect this file guards
 * against was a *shape* mistake that produced plausible output rather than an
 * error: rendering a block with no `text` as `[type]` printed `[tool-result]`
 * into the middle of somebody's conversation, and listing sessions from two
 * sources put archived sessions and subagent UUIDs in the same picker.
 *
 * @module dsh-browser-bridge/test/chat
 */

import { assert, test } from './harness.js'
import {
  collapseToolRuns,
  createChat,
  describeEvents,
  textBlocks,
  titleFrom,
  toolFailed,
  toolSummary,
} from '../lib/chat.js'

/** A user message as the harness logs it. */
function userEvent(text, plugin = undefined) {
  const source = plugin === undefined
    ? { kind: 'user' }
    : { kind: 'plugin', plugin, form: 'snapshot' }
  return { seq: 1, time: 1, type: 'user/message', data: { content: [{ type: 'text', text }], source } }
}

/** An assistant message. Note the extra `message` level. */
function assistantEvent(content) {
  return { seq: 3, time: 3, type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content } } }
}

/** A tool call as the harness logs it. */
function callEvent(callId, name, args) {
  return { seq: 4, time: 4, type: 'tool/call', data: { turn: 1, step: 1, callId, name, arguments: args } }
}

/** A tool result. The call id lives on the message's source, not on the event. */
function resultEvent(callId, options = {}) {
  const { isError = false, text = 'ok' } = options
  return {
    seq: 5,
    time: 5,
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: { role: 'tool', source: { callId }, content: [{ type: 'tool-result', text, isError }] },
    },
  }
}

/** The surface API as `loadPeer` resolves it, or null for the local rule. */
const SURFACE = { isAppendSurfaceEvent: (event) => event.surfaceOp === undefined || event.surfaceOp === 'append' }

// ---------------------------------------------------------------------------
// Rendering one event stream
// ---------------------------------------------------------------------------

test('a user message becomes a user row, and injected context does not', () => {
  const rows = describeEvents([
    userEvent('11'),
    userEvent('You are an AI agent powered by DeepSeek Harness.', '@deepseek-ai/dsh-system-prompt'),
    userEvent('<skills>…</skills>', '@deepseek-ai/dsh-skill-catalog'),
  ], SURFACE)
  assert.deepEqual(rows, [{ kind: 'user', text: '11' }])
})

test('this bridge’s own attachment shows as a notice carrying its summary', () => {
  const rows = describeEvents([{
    seq: 9,
    time: 9,
    type: 'user/message',
    data: {
      content: [{ type: 'text', text: 'the whole page body…' }],
      source: { kind: 'plugin', plugin: 'browser-bridge', form: 'notice', summary: '当前标签页 · Example' },
    },
  }], SURFACE)
  assert.deepEqual(rows, [{ kind: 'context', text: '当前标签页 · Example' }])
})

test('an assistant message reads its prose and folds its reasoning, in order', () => {
  const rows = describeEvents([
    assistantEvent([
      { type: 'reasoning', text: 'The user just sent "11".' },
      { type: 'text', text: 'Sure — here you go.' },
    ]),
  ], SURFACE)
  assert.deepEqual(rows, [
    { kind: 'reasoning', text: 'The user just sent "11".' },
    { kind: 'assistant', text: 'Sure — here you go.' },
  ])
})

test('tool-call blocks inside a message do not become rows; the event does', () => {
  const rows = describeEvents([
    assistantEvent([{ type: 'tool-call', id: 'c1', name: 'pwsh', arguments: '{"command":"npm test"}' }]),
    callEvent('c1', 'pwsh', '{"command":"npm test"}'),
    resultEvent('c1'),
  ], SURFACE)
  assert.deepEqual(rows, [{ kind: 'tool', callId: 'c1', name: 'pwsh', summary: 'npm test', status: 'ok' }])
})

test('no row ever contains a bracketed block type', () => {
  // The literal text a user saw in their own panel: blocks with no `text` were
  // rendered as `[tool-result]`, `[tool-call]` and `[reasoning]`.
  const rows = describeEvents([
    userEvent('11'),
    assistantEvent([{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'done' }]),
    callEvent('c1', 'pwsh', '{"command":"ls"}'),
    resultEvent('c1', { text: 'a\nb' }),
    { seq: 6, time: 6, type: 'system/message', data: { message: { role: 'system', content: [{ type: 'text', text: 'sys' }] } } },
    { seq: 7, time: 7, type: 'turn/start', data: { turn: 1 } },
    { seq: 8, time: 8, type: 'step/end', data: { turn: 1, step: 1 } },
  ], SURFACE)
  const rendered = JSON.stringify(rows)
  for (const banned of ['[tool-result]', '[tool-call]', '[reasoning]', '[image]', 'system/message', 'turn/start']) {
    assert.equal(rendered.includes(banned), false, `rows must not contain ${banned}`)
  }
  assert.deepEqual(rows.map((row) => row.kind), ['user', 'reasoning', 'assistant', 'tool'])
})

test('a failed tool result marks its own row rather than adding one', () => {
  const rows = describeEvents([callEvent('c1', 'pwsh', '{"command":"false"}'), resultEvent('c1', { isError: true })], SURFACE)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'error')
})

test('a result with no matching call is dropped', () => {
  assert.deepEqual(describeEvents([resultEvent('nowhere')], SURFACE), [])
})

test('a replaced message is not replayed as new conversation', () => {
  const replaced = { ...userEvent('compacted away'), surfaceOp: 'replace' }
  assert.deepEqual(describeEvents([replaced, userEvent('still here')], SURFACE), [{ kind: 'user', text: 'still here' }])
})

test('the local surface rule agrees with the peer’s on these events', () => {
  const events = [userEvent('a'), { ...userEvent('b'), surfaceOp: 'replace' }]
  assert.deepEqual(describeEvents(events, null), describeEvents(events, SURFACE))
})

test('an empty or unreadable event list produces no rows', () => {
  assert.deepEqual(describeEvents([], SURFACE), [])
  assert.deepEqual(describeEvents([null, {}, { type: 'user/message' }], SURFACE), [])
})

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

test('textBlocks reads text blocks and ignores every other kind', () => {
  assert.equal(textBlocks([{ type: 'text', text: 'a' }, { type: 'tool-result', text: 'x' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(textBlocks([{ type: 'tool-result' }]), '')
  assert.equal(textBlocks(undefined), '')
})

test('toolSummary prefers the noun the call acted on', () => {
  assert.equal(toolSummary({ arguments: '{"command":"npm test"}' }), 'npm test')
  assert.equal(toolSummary({ arguments: { file_path: 'lib/chat.js' } }), 'lib/chat.js')
  assert.equal(toolSummary({ arguments: 'not json at all' }), 'not json at all')
  assert.equal(toolSummary({}), '')
  assert.equal(toolSummary({ arguments: `{"command":"${'x'.repeat(200)}"}` }).length, 80)
})

test('toolFailed finds the flag on the content or on the envelope', () => {
  assert.equal(toolFailed(resultEvent('c', { isError: true }).data), true)
  assert.equal(toolFailed(resultEvent('c').data), false)
  assert.equal(toolFailed({ error: { code: 'x' } }), true)
})

test('titleFrom uses the first thing the person said', () => {
  assert.equal(titleFrom([{ kind: 'tool' }, { kind: 'user', text: '  explain   the parser ' }]), 'explain the parser')
  assert.equal(titleFrom([{ kind: 'assistant', text: 'hi' }]), '')
  assert.equal(titleFrom([]), '')
  assert.equal(titleFrom([{ kind: 'user', text: 'x'.repeat(200) }]).length, 60)
})

test('consecutive identical tool calls collapse into one row with a count', () => {
  const rows = collapseToolRuns([
    { kind: 'tool', name: 'pwsh', summary: 'ls', status: 'ok' },
    { kind: 'tool', name: 'pwsh', summary: 'ls', status: 'ok' },
    { kind: 'tool', name: 'pwsh', summary: 'ls', status: 'error' },
    { kind: 'tool', name: 'read', summary: 'ls', status: 'ok' },
  ])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].count, 3)
  assert.equal(rows[0].status, 'error', 'a run is only finished when its last call is')
  assert.equal(rows[1].count, 1)
})

// ---------------------------------------------------------------------------
// The session list
// ---------------------------------------------------------------------------

/** Two workspaces with distinct spellings, for grouping tests. */
const REGISTRY = {
  archivedSessionIds: ['session-archived'],
  list: () => [
    { id: 'w-daily', path: 'E:\\work\\daily', title: 'daily' },
    { id: 'w-plugin', path: 'E:\\work\\plugin', title: 'plugin' },
  ],
}

/**
 * One list item, shaped like `ApiSessionList.summaryFor`'s output.
 * @param {string} id - The session id.
 * @param {object} [fields] - Overrides.
 * @returns {object} The item.
 */
function item(id, fields = {}) {
  return {
    sessionId: id,
    updatedAt: 100,
    running: false,
    blank: false,
    cwd: 'E:\\work\\daily',
    projections: { asOfSeq: 0, values: { title: 'Numeric input session' } },
    ...fields,
  }
}

/**
 * A chat surface over a fixed list and event stream.
 * @param {object[]} items - The list items.
 * @param {object} [extra] - Port and fixture overrides.
 * @returns {{ chat: object, calls: object }} The surface and the recorded calls.
 */
function chatWith(items, extra = {}) {
  const calls = { inspect: [], create: [] }
  const chat = createChat({
    sessions: { get: () => undefined },
    workspaces: REGISTRY,
    commands: {
      list: async () => ({ items }),
      inspect: async (sessionId) => {
        calls.inspect.push(sessionId)
        return { meta: extra.meta ?? { title: 'from the header' }, events: extra.events ?? [] }
      },
      create: async (request) => {
        calls.create.push(request)
        return extra.createResult ?? { sessionId: 'session-new' }
      },
      prompt: extra.prompt ?? (async () => undefined),
    },
    ...extra.ports,
  })
  return { chat, calls }
}

test('the list comes from the controller and is grouped by workspace', async () => {
  const { chat } = chatWith([
    item('session-a', { updatedAt: 10 }),
    item('session-b', { updatedAt: 30, cwd: 'E:\\work\\plugin', projections: { values: { title: 'A plugin project' } } }),
    item('session-archived', { updatedAt: 99 }),
    item('session-sub', { updatedAt: 99, origin: 'subagent', projections: { values: { title: 'Research task (web research only…' } } }),
    item('session-c', { updatedAt: 20, cwd: 'E:\\work\\daily\\' }),
    item('session-elsewhere', { updatedAt: 40, cwd: 'E:\\other', projections: { values: { title: 'Elsewhere' } } }),
  ])
  const { groups } = await chat.listSessions()

  assert.deepEqual(groups.map((group) => group.id), ['w-daily', 'w-plugin', null])
  assert.deepEqual(groups[0].sessions.map((s) => s.id), ['session-c', 'session-a'])
  assert.deepEqual(groups[1].sessions.map((s) => s.id), ['session-b'])
  assert.deepEqual(groups[2].sessions.map((s) => s.id), ['session-elsewhere'])

  const all = groups.flatMap((group) => group.sessions)
  assert.equal(all.some((s) => s.id === 'session-sub'), false, 'subagent sessions must not be listed')
  assert.equal(all.some((s) => s.id === 'session-archived'), false, 'archived sessions must not be listed')
})

test('a session with no title keeps an empty one rather than a slice of its id', async () => {
  const { chat } = chatWith([item('session-0f1e2d3c-4b5a-4c6d-8e7f-901234567890', { projections: { values: {} } })])
  const { groups } = await chat.listSessions()
  assert.equal(groups[0].sessions[0].title, '')
})

test('grouping survives a differently spelled path', async () => {
  const { chat } = chatWith([item('session-a', { cwd: 'e:/WORK/DAILY/' })])
  const { groups } = await chat.listSessions()
  assert.equal(groups[0].id, 'w-daily')
})

test('a missing workspace registry degrades to one ungrouped list', async () => {
  const { chat } = chatWith([item('session-a'), item('session-b', { updatedAt: 5 })], { ports: { workspaces: undefined } })
  const { groups } = await chat.listSessions()
  assert.equal(groups.length, 1)
  assert.equal(groups[0].id, null)
  assert.deepEqual(groups[0].sessions.map((s) => s.id), ['session-a', 'session-b'])
})

test('a missing session service lists nothing instead of throwing', async () => {
  const chat = createChat({ commands: () => undefined })
  assert.deepEqual(await chat.listSessions(), { groups: [] })
})

// ---------------------------------------------------------------------------
// Reading a transcript
// ---------------------------------------------------------------------------

test('a read reports a title and a bounded number of rows', async () => {
  const events = [userEvent('11'), callEvent('c1', 'pwsh', '{"command":"npm test"}'), assistantEvent([{ type: 'text', text: 'ok' }])]
  const { chat } = chatWith([item('session-a')], { events })
  const { title, messages } = await chat.readMessages('session-a', 2)
  assert.equal(title, 'from the header')
  assert.deepEqual(messages.map((row) => row.kind), ['tool', 'assistant'])
})

test('a title falls back from the header to the listing to the transcript', async () => {
  const header = chatWith([item('session-a')], { events: [userEvent('explain the parser')] })
  assert.equal((await header.chat.readMessages('session-a')).title, 'from the header')

  const listed = chatWith([item('session-a')], { meta: {}, events: [userEvent('explain the parser')] })
  await listed.chat.listSessions()
  assert.equal((await listed.chat.readMessages('session-a')).title, 'Numeric input session')

  const derived = chatWith([item('session-a', { projections: { values: {} } })], { meta: {}, events: [userEvent('explain the parser')] })
  await derived.chat.listSessions()
  assert.equal((await derived.chat.readMessages('session-a')).title, 'explain the parser')
})

test('a cold session is replayed once; a live one is re-read every time', async () => {
  const cold = chatWith([item('cold-1')])
  await cold.chat.readMessages('cold-1')
  await cold.chat.readMessages('cold-1')
  assert.deepEqual(cold.calls.inspect, ['cold-1'], 'a cold session cannot change while it is cold')

  const seen = []
  const live = createChat({
    sessions: { get: (id) => (id === 'live-1' ? { id } : undefined) },
    commands: {
      inspect: async (id) => {
        seen.push(id)
        return { meta: {}, events: [] }
      },
    },
  })
  await live.readMessages('live-1')
  await live.readMessages('live-1')
  assert.deepEqual(seen, ['live-1', 'live-1'], 'a live session is still being written')
})

test('sending invalidates the cached replay', async () => {
  let seen = 0
  const chat = createChat({
    sessions: { get: () => undefined },
    commands: {
      inspect: async () => {
        seen += 1
        return { meta: {}, events: [] }
      },
      prompt: async () => undefined,
    },
  })
  await chat.readMessages('cold-1')
  await chat.send('cold-1', 'hello')
  await chat.readMessages('cold-1')
  assert.equal(seen, 2)
})

test('a read falls back to the older reader when inspect fails', async () => {
  const chat = createChat({
    commands: {
      inspect: async () => {
        throw new Error('no such event shape')
      },
      readSessionState: async () => ({ header: { title: 'fallback reader' }, events: [] }),
    },
  })
  assert.equal((await chat.readMessages('session-a')).title, 'fallback reader')
})

test('a read returns an empty transcript rather than throwing', async () => {
  const chat = createChat({
    commands: {
      inspect: async () => {
        throw new Error('gone')
      },
      readSessionState: async () => {
        throw new Error('gone too')
      },
    },
  })
  assert.deepEqual(await chat.readMessages('session-a'), { title: '', messages: [] })
})

// ---------------------------------------------------------------------------
// Creating and sending
// ---------------------------------------------------------------------------

test('creating a session passes the workspace through', async () => {
  const { chat, calls } = chatWith([])
  assert.deepEqual(await chat.createSession({ workspaceId: 'w-daily' }), { created: true, sessionId: 'session-new' })
  assert.deepEqual(calls.create, [{ workspaceId: 'w-daily' }])
  await chat.createSession({})
  assert.deepEqual(calls.create[1], {})
})

test('creating a session reports a failure rather than throwing', async () => {
  const chat = createChat({ commands: { create: async () => { throw new Error('workspace "w" not found') } } })
  const result = await chat.createSession({ workspaceId: 'w' })
  assert.equal(result.created, false)
  assert.match(result.reason, /workspace "w" not found/)
  assert.equal((await createChat({ commands: undefined }).createSession({})).created, false)
})

test('sending supplies a signal, because the controller dereferences it', async () => {
  // `SessionController.prompt(request, signal)` calls `signal.throwIfAborted()`
  // unconditionally, so passing `undefined` threw the wire error
  // "Cannot read properties of undefined (reading 'throwIfAborted')".
  let received = 'never called'
  const chat = createChat({
    commands: {
      prompt: async (request, signal) => {
        received = signal
        signal.throwIfAborted()
        assert.equal(request.mode, 'queue')
        assert.deepEqual(request.content, [{ type: 'text', text: 'hello' }])
        return undefined
      },
    },
  })
  assert.deepEqual(await chat.send('session-a', 'hello'), { accepted: true, sessionId: 'session-a' })
  assert.equal(typeof received?.throwIfAborted, 'function')
})

test('an empty message and an absent service both report a reason', async () => {
  const chat = createChat({ commands: { prompt: async () => undefined } })
  assert.deepEqual(await chat.send('s', '   '), { accepted: false, reason: 'the message is empty' })
  const absent = createChat({ commands: undefined })
  const result = await absent.send('s', 'hi')
  assert.equal(result.accepted, false)
  assert.match(result.reason, /session-command service is unavailable/)
})

test('a rejected prompt reports the harness’s own error', async () => {
  const chat = createChat({
    commands: { prompt: async () => ({ error: { code: 'session/busy', message: 'a turn is already running' } }) },
  })
  assert.deepEqual(await chat.send('s', 'hi'), { accepted: false, reason: 'session/busy: a turn is already running' })
})

test('the service report names exactly what is reachable', () => {
  const chat = createChat({
    sessions: { get: () => undefined },
    workspaces: REGISTRY,
    commands: {
      prompt: async () => undefined,
      inspect: async () => undefined,
      list: async () => ({ items: [] }),
      create: async () => ({}),
    },
  })
  const services = chat.services()
  assert.equal(services.sessions, true)
  assert.equal(services.list, true)
  assert.equal(services.inspect, true)
  assert.equal(services.create, true)
  assert.equal(services.workspaces, true)
  assert.equal(services.readSessionState, false)
  assert.equal(services.modelCatalog, false)
  assert.equal(services.selectModel, false)
  assert.ok(
    ['untried', true, false].includes(services.surfaceRules),
    `surfaceRules is a tri-state, got ${services.surfaceRules}`,
  )
})

test('a port that throws is treated as an absent service', async () => {
  const chat = createChat({ commands: () => { throw new Error('not up yet') } })
  assert.deepEqual(await chat.listSessions(), { groups: [] })
  assert.equal(chat.services().prompt, false)
})

// ---------------------------------------------------------------------------
// The model picker's host side
// ---------------------------------------------------------------------------

/**
 * One list item carrying a session-local model selection.
 * @param {string} id - The session id.
 * @param {object} modelSelection - The projection's wire view.
 * @returns {object} The item.
 */
function withModel(id, modelSelection) {
  return item(id, {
    projections: { asOfSeq: 0, values: { title: 'Numeric input session', modelSelection } },
  })
}

test('each session’s own model travels with the listing', async () => {
  const { chat } = chatWith([
    withModel('session-a', { lastUsed: null, next: { provider: 'p', model: 'm', reasoningEffort: 'max' } }),
    withModel('session-b', { lastUsed: { provider: 'p', model: 'other' }, next: null }),
  ])
  const { groups } = await chat.listSessions()
  const byId = new Map(groups.flatMap((group) => group.sessions).map((session) => [session.id, session.model]))
  // `next` is what the next request will use, so it is what the panel shows.
  assert.deepEqual(byId.get('session-a'), { provider: 'p', model: 'm', reasoningEffort: 'max' })
  // A consumed pending value leaves `lastUsed` as the only answer, which is the
  // ordinary case straight after a turn finishes.
  assert.deepEqual(byId.get('session-b'), { provider: 'p', model: 'other' })
})

test('a session that never chose a model says so with null', async () => {
  const { chat } = chatWith([item('session-a')])
  const { groups } = await chat.listSessions()
  assert.equal(groups[0].sessions[0].model, null)
})

test('a malformed selection is refused rather than half-rendered', async () => {
  const { chat } = chatWith([
    withModel('session-a', { next: { provider: 'p' } }),
    withModel('session-b', { next: 'not-an-object' }),
  ])
  const { groups } = await chat.listSessions()
  assert.deepEqual(groups[0].sessions.map((session) => session.model), [null, null])
})

test('the catalog is awaited, read once, and a failure is a reason string', async () => {
  let reads = 0
  const catalog = { default: { provider: 'p', model: 'm' }, groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M' }] }] }
  // `async` on purpose: the harness's own `modelCatalog` returns a promise
  // (`types/catalog.js:8`), and a synchronous stub here hid the real defect —
  // the promise passed the `typeof === 'object'` check, was cached, and reached
  // the panel as `{}` with no models in it.
  const chat = createChat({
    commands: {
      modelCatalog: async () => {
        reads += 1
        return catalog
      },
    },
  })
  assert.equal((await chat.readModels()).catalog.groups.length, 1)
  await chat.readModels()
  assert.equal(reads, 1, 'the catalog must not be re-read on every panel refresh')

  const absent = createChat({ commands: {} })
  const missing = await absent.readModels()
  assert.equal(missing.catalog, null)
  assert.match(missing.reason, /does not expose a model catalog/)

  const throwing = createChat({ commands: { modelCatalog: async () => { throw new Error('no credentials') } } })
  assert.deepEqual(await throwing.readModels(), { catalog: null, reason: 'no credentials' })
})

test('a catalog that resolves to a non-object is refused, not cached', async () => {
  for (const value of [undefined, null, 'nope', 7]) {
    const chat = createChat({ commands: { modelCatalog: async () => value } })
    const result = await chat.readModels()
    assert.equal(result.catalog, null, `${String(value)} must not become a catalog`)
    assert.match(result.reason, /returned no model catalog/)
  }
})

test('selecting a model forwards the session and normalises the answer', async () => {
  const seen = []
  const chat = createChat({
    commands: {
      selectModel: async (request) => {
        seen.push(request)
        return { selected: { provider: request.provider, model: request.model, reasoningEffort: 'max' } }
      },
    },
  })
  assert.deepEqual(
    await chat.selectModel({ sessionId: 's', provider: 'p', model: 'm', reasoningEffort: 'low' }),
    { selected: { provider: 'p', model: 'm', reasoningEffort: 'max' } },
  )
  assert.deepEqual(seen[0], { sessionId: 's', provider: 'p', model: 'm', reasoningEffort: 'low' })

  // An omitted effort stays omitted rather than travelling as `undefined`, which
  // the harness's own schema rejects at the boundary.
  await chat.selectModel({ sessionId: 's', provider: 'p', model: 'm' })
  assert.equal(Object.hasOwn(seen[1], 'reasoningEffort'), false)
})

test('a refused selection reports the harness’s reason instead of throwing', async () => {
  const chat = createChat({
    commands: { selectModel: async () => { throw new Error('session/model-unavailable: no such model') } },
  })
  assert.deepEqual(
    await chat.selectModel({ sessionId: 's', provider: 'p', model: 'nope' }),
    { selected: false, reason: 'session/model-unavailable: no such model' },
  )
})

test('an incomplete request is refused before it reaches the wire', async () => {
  let called = 0
  const chat = createChat({
    commands: { selectModel: async () => { called += 1; return {} } },
  })
  assert.deepEqual(await chat.selectModel({ sessionId: '', provider: 'p', model: 'm' }), { selected: false, reason: 'no session was named' })
  assert.deepEqual(await chat.selectModel({ sessionId: 's', provider: '', model: '' }), { selected: false, reason: 'the request named no provider and model' })
  // A resolved-but-empty answer is a failure too, not an installed selection.
  assert.deepEqual(await chat.selectModel({ sessionId: 's', provider: 'p', model: 'm' }), { selected: false, reason: 'the harness returned no selection' })
  assert.equal(called, 1)
})
