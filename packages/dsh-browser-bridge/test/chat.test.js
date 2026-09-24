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
  findRows,
  searchableText,
  textBlocks,
  titleFrom,
  toolFailed,
  toolFailure,
  toolSummary,
} from '../lib/chat.js'

/**
 * The host's search cap, mirrored here.
 *
 * Not imported, because the module does not export it: the cap is an internal
 * decision and the tests below are about the *behaviour* at the boundary. If
 * the cap moves, these tests should have to be read rather than silently
 * re-scale.
 */
const SEARCH_LIMIT = 30

/**
 * Compare rows to what is expected, ignoring the timestamp.
 *
 * The fixtures below number their events `1, 2, 3 …` rather than carrying real
 * clock values, because a test should read as a sequence. That makes `at` — the
 * epoch milliseconds every row records so the panel can draw a day separator — an
 * artefact of the fixture, and asserting it in every row expectation would mean
 * editing a dozen of them whenever a fixture gains an event.
 *
 * It is not ignored silently: `at` is asserted directly by the tests that are
 * *about* it, so a row that loses its stamp fails there rather than everywhere.
 *
 * @param {object[]} rows - What `describeEvents` produced.
 * @returns {object[]} The rows with `at` removed, for `deepEqual`.
 */
function withoutStamps(rows) {
  return rows.map(({ at, ...rest }) => rest)
}

/** A user message as the harness logs it. */
function userEvent(text, plugin = undefined) {
  const source = plugin === undefined
    ? { kind: 'user' }
    : { kind: 'plugin', plugin, form: 'snapshot' }
  return { seq: 1, time: 1, type: 'user/message', data: { content: [{ type: 'text', text }], source } }
}

/**
 * A message the machine sent to the model rather than one the reader typed.
 *
 * Real ones measured on this machine, by kind: `goal` 114, `plugin` 319,
 * `team-message` 42, `subagent-settled` 18, `agent-message` 6. None of them is
 * shown as its own row — this fixture exists so the *turn* they open can be
 * labelled without their words being pasted into the transcript.
 */
function injectedEvent(kind, text = 'injected') {
  return { seq: 1, time: 1, type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind } } }
}

/** An assistant message. Note the extra `message` level. */
function assistantEvent(content) {
  return { seq: 3, time: 3, type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content } } }
}

/** A tool call as the harness logs it. */
function callEvent(callId, name, args) {
  return { seq: 4, time: 4, type: 'tool/call', data: { turn: 1, step: 1, callId, name, arguments: args } }
}

/**
 * A tool result. The call id lives on the message's source, not on the event.
 *
 * The content is a `tool-result` block wrapping its own blocks — the real
 * shape, which nests: `screenshot.test.js` walks into it the same way, and the
 * host's own `collectImageRefs` recurses for the same reason. A fixture that
 * put the text directly on the message would make a non-recursive reader look
 * correct.
 */
function resultEvent(callId, options = {}) {
  const { isError = false, text = 'ok' } = options
  return {
    seq: 5,
    time: 5,
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        source: { callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text, isError }] }],
      },
    },
  }
}

/** The surface API as `loadPeer` resolves it, or null for the local rule. */
const SURFACE = { isAppendSurfaceEvent: (event) => event.surfaceOp === undefined || event.surfaceOp === 'append' }

/** A turn ending. `reason` is absent on a turn that simply ran out of work. */
function turnEndEvent(reason, turn = 1) {
  return { seq: 9, time: 9, type: 'turn/end', data: { turn, ...(reason === undefined ? {} : { reason }) } }
}

/**
 * A turn opening. `seq` defaults below any fixture that follows it.
 *
 * The ordering this fixture encodes was read off a real session log rather than
 * invented: `turn/start` comes **first**, and the question arrives inside the
 * turn it opened. From `~/.dsh/sessions` (16749 events, decoded frame by frame —
 * the file is a series of independent zstd frames, one per append):
 *
 *   seq 2857  turn/start        turn=3
 *   seq 2871  user/message      source.kind='user'   ← the question the reader typed
 *   seq 2873  assistant/message turn=3
 *
 * `user/message` carries no turn of its own — only `content`/`id`/`role`/`source`
 * — so the open turn is the only thing that links the two.
 */
function turnStartEvent(turn) {
  return { seq: 2, time: 2, type: 'turn/start', data: { turn } }
}

/**
 * The exact `turn/end` a refused provider request produced.
 *
 * Taken from a real failing turn on a probe instance with no provider key: the
 * step ended in a `MISSING_CREDENTIAL` LlmError, so the turn carried this
 * reason and **no** `assistant/message` was ever appended.
 */
const FAILED_TURN = turnEndEvent({
  kind: 'error',
  error: {
    message: 'llm-deepseek: no API key for provider route "deepseek-official"',
    code: 'MISSING_CREDENTIAL',
  },
})

// ---------------------------------------------------------------------------
// Rendering one event stream
// ---------------------------------------------------------------------------

test('a user message becomes a user row, and injected context does not', () => {
  const rows = describeEvents([
    userEvent('11'),
    userEvent('You are an AI agent powered by DeepSeek Harness.', '@deepseek-ai/dsh-system-prompt'),
    userEvent('<skills>…</skills>', '@deepseek-ai/dsh-skill-catalog'),
  ], SURFACE)
  assert.deepEqual(withoutStamps(rows), [{ kind: 'user', text: '11' }])
})

test('a turn the reader never started says what did start it', () => {
  // The words of a goal round are not the conversation and are not shown. The
  // turn they open is, and without a name for it the panel shows the model
  // answering nothing — 112 of the 243 turns in this machine's real sessions.
  const rows = describeEvents([
    turnStartEvent(1),
    injectedEvent('goal', '<goal_round>Objective: keep improving the panel'),
    assistantEvent([{ type: 'text', text: 'Round 42.' }]),
  ], SURFACE)
  assert.deepEqual(withoutStamps(rows), [
    { kind: 'trigger', text: 'goal' },
    { kind: 'assistant', text: 'Round 42.' },
  ])
})

test('an injected message does not paste its own words into the transcript', () => {
  // A skill catalog is 9 KB. Showing the trigger names the cause; showing the
  // cause's body would bury the conversation the reader came for.
  const rows = describeEvents([
    turnStartEvent(1),
    injectedEvent('skill-catalog', '<system-reminder>A skill is a reusable set of…</system-reminder>'),
  ], SURFACE)
  assert.deepEqual(withoutStamps(rows), [{ kind: 'trigger', text: 'skill-catalog' }])
})

test('a turn is labelled once, however many notifications join it', () => {
  // Real turns carry several: a goal round, a runtime-context snapshot and an
  // acp nudge can all arrive in the same one. One label per turn is what keeps
  // the transcript about the conversation instead of about the plumbing.
  const rows = describeEvents([
    turnStartEvent(7),
    injectedEvent('goal'),
    injectedEvent('runtime-context'),
    injectedEvent('plugin:acp-nudge'),
  ], SURFACE)
  assert.deepEqual(withoutStamps(rows), [{ kind: 'trigger', text: 'goal' }])
})

test('a question the reader typed is not labelled as a trigger', () => {
  // The reader's own message is the turn's opening row; adding a trigger above
  // it would say the turn was started by something other than them.
  const rows = describeEvents([
    turnStartEvent(1),
    userEvent('帮我看一下这个页面'),
    assistantEvent([{ type: 'text', text: '好。' }]),
  ], SURFACE)
  assert.deepEqual(withoutStamps(rows), [
    { kind: 'user', text: '帮我看一下这个页面' },
    { kind: 'assistant', text: '好。' },
  ])
})

test('each turn gets its own label, and the label does not leak into the next', () => {
  const rows = describeEvents([
    turnStartEvent(1),
    injectedEvent('goal'),
    turnEndEvent(),
    turnStartEvent(2),
    injectedEvent('team-message'),
    turnEndEvent(),
  ], SURFACE)
  assert.deepEqual(withoutStamps(rows), [
    { kind: 'trigger', text: 'goal' },
    { kind: 'trigger', text: 'team-message' },
  ])
})

test('a turn number that comes round again is still labelled again', () => {
  // Turn numbers are not unique for the life of a session — a resumed or
  // truncated log can count from a number it has used before. Closing a turn has
  // to forget its label, or the next turn carrying that number is taken for one
  // already named and gets no row at all: the model answers nothing, which is
  // the failure this whole row exists to prevent.
  //
  // Found by mutation: dropping the `labelledTurns.delete(turn)` in `turn/end`
  // turned no test red. Reproduced with the probe first — same number reused
  // across a completed turn drew one label where there should be two — so this
  // is a test gap rather than an equivalent mutation.
  const rows = describeEvents([
    turnStartEvent(5),
    injectedEvent('goal'),
    turnEndEvent(undefined, 5),
    turnStartEvent(5),
    injectedEvent('team-message'),
    turnEndEvent(undefined, 5),
  ], SURFACE)
  assert.deepEqual(withoutStamps(rows), [
    { kind: 'trigger', text: 'goal' },
    { kind: 'trigger', text: 'team-message' },
  ])
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
  assert.deepEqual(withoutStamps(rows), [{ kind: 'context', text: '当前标签页 · Example' }])
})

test('an assistant message reads its prose and folds its reasoning, in order', () => {
  const rows = describeEvents([
    assistantEvent([
      { type: 'reasoning', text: 'The user just sent "11".' },
      { type: 'text', text: 'Sure — here you go.' },
    ]),
  ], SURFACE)
  assert.deepEqual(withoutStamps(rows), [
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
  assert.deepEqual(withoutStamps(rows), [{ kind: 'tool', callId: 'c1', name: 'pwsh', summary: 'npm test', status: 'ok' }])
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
  assert.deepEqual(withoutStamps(describeEvents([resultEvent('nowhere')], SURFACE)), [])
})

test('a failed tool call carries the reason it gave', () => {
  // The row used to keep the arguments and throw the result away, so a failed
  // browser call reached the panel as `✕ browser_click #save` with no word on
  // why. The model could read the reason and correct itself; the person
  // watching could not tell a missed selector from a blocked tab from a page
  // that never answered.
  const rows = describeEvents([
    callEvent('c1', 'browser_click', '{"selector":"#save"}'),
    resultEvent('c1', { isError: true, text: 'no element matches #save' }),
  ], SURFACE)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'error')
  assert.equal(rows[0].failure, 'no element matches #save')
})

test('a successful tool call carries no reason', () => {
  // A snapshot's output is the page, not an explanation. Putting it on the row
  // would turn every successful read into a wall of text, and the row is one
  // line by design.
  const rows = describeEvents([
    callEvent('c1', 'browser_snapshot', '{}'),
    resultEvent('c1', { text: '<html>a very long page</html>' }),
  ], SURFACE)
  assert.equal(rows[0].status, 'ok')
  assert.equal('failure' in rows[0], false, 'a successful call carried a failure reason')
})

test('toolFailure prefers the result text, then the thrown error', () => {
  assert.equal(toolFailure(resultEvent('c', { isError: true, text: 'selector not found' }).data), 'selector not found')
  // A tool that throws has no text block, and its message is the only carrier.
  assert.equal(toolFailure({ error: { message: 'the tab is gone' } }).length > 0, true)
  assert.equal(toolFailure({ error: 'plain string failure' }), 'plain string failure')
  assert.equal(toolFailure({}), '')
  // Whitespace is collapsed and the budget is enforced, because the row is one
  // line and a multi-line diagnostic would otherwise push the layout around.
  assert.equal(toolFailure({ error: 'a\n\nb   c' }), 'a b c')
  assert.ok(toolFailure({ error: 'x'.repeat(500) }).length <= 200)
})

test('a merged run keeps the reason from the call that decided its status', () => {
  // Consecutive identical calls become one row with a count, and the last call's
  // status stands for the run. Its reason has to come with it: a merged row
  // showing a cross and no explanation is the bare-cross defect again, one level
  // up.
  const failedLast = collapseToolRuns([
    { kind: 'tool', name: 'browser_click', summary: '#save', status: 'ok' },
    { kind: 'tool', name: 'browser_click', summary: '#save', status: 'error', failure: 'no element matches #save' },
  ])
  assert.equal(failedLast.length, 1)
  assert.equal(failedLast[0].count, 2)
  assert.equal(failedLast[0].failure, 'no element matches #save')

  // And the other direction: a run that ended successfully must not keep the
  // reason from an earlier failure, or the row would explain a status it no
  // longer has.
  const okLast = collapseToolRuns([
    { kind: 'tool', name: 'browser_click', summary: '#save', status: 'error', failure: 'no element matches #save' },
    { kind: 'tool', name: 'browser_click', summary: '#save', status: 'ok' },
  ])
  assert.equal(okLast[0].status, 'ok')
  assert.equal('failure' in okLast[0], false, 'a successful run kept a stale reason')
})

test('a turn that died leaves a lasting row, not just a live toast', () => {
  // A failed turn commits no assistant message. Without this row the stored
  // transcript is the user's message and then nothing, so reloading the panel
  // made a crash look like a conversation that simply stopped.
  assert.deepEqual(withoutStamps(describeEvents([userEvent('probe'), FAILED_TURN], SURFACE)), [
    { kind: 'user', text: 'probe' },
    {
      kind: 'failed',
      text: 'llm-deepseek: no API key for provider route "deepseek-official"',
      // The code is what lets the panel say "no model key is set" instead of
      // pasting the provider's paragraph about which variable to export.
      code: 'MISSING_CREDENTIAL',
    },
  ])
})

test('a failed turn carries the question that started it', () => {
  // The host has no way to re-run a turn, so the only recourse the panel can
  // offer is to put the question back in the composer. That needs the question
  // to travel with the failure — and it cannot be recovered from the rows,
  // because by then the row above the failure is the assistant's first sentence
  // rather than anything the reader typed.
  const rows = describeEvents([
    turnStartEvent(1),
    userEvent('为什么保存按钮点不动'),
    assistantEvent([{ type: 'text', text: '我先看一眼。' }]),
    FAILED_TURN,
  ], SURFACE)

  assert.deepEqual(rows.map((row) => row.kind), ['user', 'assistant', 'failed'])
  // The question that opened the turn, not the assistant's reply above it.
  assert.equal(rows[2].question, '为什么保存按钮点不动')
})

test('a failure with no question of its own offers nothing to restore', () => {
  // A goal round or a scheduled wake-up opens a turn nobody typed into. Handing
  // back the last thing the reader said — possibly many turns ago — would put
  // words in their mouth, which is worse than offering no recourse at all.
  const rows = describeEvents([
    { seq: 1, time: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'wake up' }], source: { kind: 'goal' } } },
    turnStartEvent(1),
    FAILED_TURN,
  ], SURFACE)

  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'failed')
  assert.equal('question' in rows[0], false, 'injected context must not become a retry')
})

test('a failure does not inherit a question from an earlier turn', () => {
  // Two turns, one question. The second turn is a goal round that failed; the
  // reader's question belongs to the first and must not be offered again.
  const rows = describeEvents([
    turnStartEvent(1),
    userEvent('把表格抓下来'),
    turnEndEvent(),
    turnStartEvent(2),
    FAILED_TURN,
  ], SURFACE)

  const failed = rows.filter((row) => row.kind === 'failed')
  assert.equal(failed.length, 1)
  assert.equal('question' in failed[0], false)
})

test('a turn that took several messages hands back the one that opened it', () => {
  // Real sessions queue messages into a running turn — one log has three in a
  // single turn, and its shape is `turn3:[user,user,user,plugin]`. Only the
  // first one started the turn, so only the first one is the question this
  // failure is the answer to. Restoring the last would offer to resend something
  // that was never sent on its own.
  const rows = describeEvents([
    turnStartEvent(1),
    userEvent('先看一眼保存按钮'),
    userEvent('顺便看下控制台'),
    userEvent('还有网络请求'),
    FAILED_TURN,
  ], SURFACE)

  const failure = rows.filter((row) => row.kind === 'failed')
  assert.equal(failure.length, 1)
  assert.equal(failure[0].question, '先看一眼保存按钮')
})

test('a turn stopped on purpose is not recorded as a failure', () => {
  // The person pressed stop; the panel already showed that as their own action.
  // Writing it into the transcript as a crash would be a lie that persists.
  assert.deepEqual(withoutStamps(describeEvents([turnEndEvent({ kind: 'aborted', reason: 'user' })], SURFACE)), [])
})

test('an ordinary turn end adds nothing', () => {
  // Most turns end with no reason at all, and none of them are failures.
  assert.deepEqual(withoutStamps(describeEvents([turnEndEvent(undefined)], SURFACE)), [])
  assert.deepEqual(withoutStamps(describeEvents([turnEndEvent({ kind: 'completed' })], SURFACE)), [])
})

test('a failure reason is clipped to something a row can hold', () => {
  const long = turnEndEvent({ kind: 'error', error: { message: 'x'.repeat(400) } })
  const [row] = describeEvents([long], SURFACE)
  assert.equal(row.kind, 'failed')
  assert.equal(row.text.length, 160)
})

test('a failure with no message still becomes a row', () => {
  // The panel needs a row either way; it supplies its own wording when the
  // reason is empty, but the row has to exist for that to be reachable.
  assert.deepEqual(withoutStamps(describeEvents([turnEndEvent({ kind: 'error', error: {} })], SURFACE)), [
    { kind: 'failed', text: '' },
  ])
})

test('a replaced message is not replayed as new conversation', () => {
  const replaced = { ...userEvent('compacted away'), surfaceOp: 'replace' }
  assert.deepEqual(withoutStamps(describeEvents([replaced, userEvent('still here')], SURFACE)), [{ kind: 'user', text: 'still here' }])
})

test('a compaction checkpoint becomes a row that says how much it covers', () => {
  // Compaction is the event that *removes* the conversation it summarizes, so it
  // arrives as a replacement — the very thing the guard above is there to skip.
  // Handled after that guard it would never draw, and a reader scrolling up would
  // find the conversation starting mid-thought with nothing to explain why.
  //
  // The count comes from the checkpoint's own range rather than from counting
  // rows here: rows are what survived, the range is what was replaced.
  const checkpoint = {
    seq: 462,
    time: 9,
    type: 'user/message',
    surfaceOp: { op: 'replace', startSeq: 19, endSeq: 311 },
    data: {
      content: [{ type: 'text', text: 'The discussion covered the panel and its search.' }],
      source: { kind: 'compact-checkpoint', compactionId: 'b3f1c0a2' },
    },
  }
  assert.deepEqual(withoutStamps(describeEvents([checkpoint], SURFACE)), [{
    kind: 'compaction',
    text: 'The discussion covered the panel and its search.',
    shadowed: 293,
    compactionId: 'b3f1c0a2',
  }])
})

test('a compaction row survives the guard that skips replacements', () => {
  // The same event with the surface rule that rejects replacements: the guard is
  // what makes the ordering load-bearing, so this is the reading that would have
  // caught the row being placed after it. `SURFACE` is the peer's own append test.
  const checkpoint = {
    seq: 462,
    time: 9,
    type: 'user/message',
    surfaceOp: { op: 'replace', startSeq: 19, endSeq: 311 },
    data: {
      content: [{ type: 'text', text: 'summary' }],
      source: { kind: 'compact-checkpoint', compactionId: 'x' },
    },
  }
  const rows = describeEvents([checkpoint], SURFACE)
  assert.equal(rows.length, 1, 'the checkpoint was dropped — it is being read after the guard')
  assert.equal(rows[0].kind, 'compaction')
})

test('a checkpoint with no usable range still draws, without a count', () => {
  // A row that cannot say how much it covers is still the only mark that the
  // conversation was ever longer than it looks, so it is worth drawing. A
  // malformed range must not become a negative or NaN count on screen.
  const draw = (surfaceOp) => describeEvents([{
    seq: 1,
    time: 1,
    type: 'user/message',
    ...(surfaceOp === undefined ? {} : { surfaceOp }),
    data: { content: [{ type: 'text', text: 's' }], source: { kind: 'compact-checkpoint', compactionId: 'x' } },
  }], SURFACE)[0]

  assert.equal(draw(undefined).shadowed, 0, 'no range must read as zero, not undefined')
  assert.equal(draw({ op: 'replace' }).shadowed, 0, 'a range with no endpoints must read as zero')
  assert.equal(draw({ op: 'replace', startSeq: 311, endSeq: 19 }).shadowed, 0, 'an inverted range must not go negative')
  assert.equal(draw({ op: 'replace', startSeq: 5, endSeq: 5 }).shadowed, 1, 'a one-event range covers one event')
})

test('a checkpoint with no summary is still a row', () => {
  // The host cannot promise the summary arrived — it is model-written prose. The
  // row is what tells the reader the conversation was longer, and that fact does
  // not depend on the prose being present.
  const rows = describeEvents([{
    seq: 1,
    time: 1,
    type: 'user/message',
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 10 },
    data: { content: [], source: { kind: 'compact-checkpoint', compactionId: 'x' } },
  }], SURFACE)
  assert.deepEqual(withoutStamps(rows), [{ kind: 'compaction', text: '', shadowed: 10, compactionId: 'x' }])
})

test('two checkpoints with no summary are still two rows', () => {
  // The panel names rows by `compactionId` when it has one; the fallback key is
  // the text, and a summary-less checkpoint has none. Without the id two of them
  // would be one row name, which is how an empty `callId` once made every tool
  // row the same row.
  const checkpoint = () => ({
    seq: 1,
    time: 1,
    type: 'user/message',
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 10 },
    data: { content: [], source: { kind: 'compact-checkpoint', compactionId: 'x' } },
  })
  const first = checkpoint()
  const second = checkpoint()
  second.data.source.compactionId = 'y'
  const rows = describeEvents([first, second], SURFACE)
  assert.deepEqual(rows.map((row) => row.compactionId), ['x', 'y'])
})

test('a plugin snapshot is still a context row, not a compaction row', () => {
  // Both arrive on `user/message` and both are the host's own injections rather
  // than something the person typed, so the two branches sit next to each other
  // and a change to one can absorb the other.
  assert.deepEqual(withoutStamps(describeEvents([userEvent('snapshot', 'browser-bridge')], SURFACE)), [
    { kind: 'context', text: 'snapshot' },
  ])
})

test('the local surface rule agrees with the peer’s on these events', () => {
  const events = [userEvent('a'), { ...userEvent('b'), surfaceOp: 'replace' }]
  assert.deepEqual(describeEvents(events, null), describeEvents(events, SURFACE))
})

test('an empty or unreadable event list produces no rows', () => {
  assert.deepEqual(withoutStamps(describeEvents([], SURFACE)), [])
  assert.deepEqual(withoutStamps(describeEvents([null, {}, { type: 'user/message' }], SURFACE)), [])
})

test('every conversational row carries when it happened', () => {
  // The panel draws a day separator from this, and it cannot draw one from a row
  // that will not say when it happened. Measured on this machine: all 18010
  // message events carry a usable time, none missing, and the longest session
  // spans 37.9 hours across three calendar days — so a sixty-row window can hold
  // more than one day and nothing else in the row says which.
  const events = [
    { seq: 1, time: 1_700_000_000_000, type: 'user/message', data: { content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } } },
    { seq: 2, time: 1_700_000_001_000, type: 'turn/start', data: { turn: 1 } },
    { seq: 3, time: 1_700_000_002_000, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'r' }] } } },
    { seq: 4, time: 1_700_000_003_000, type: 'tool/call', data: { turn: 1, callId: 'c1', name: 'pwsh', arguments: '{}' } },
    { seq: 5, time: 1_700_000_004_000, type: 'tool/result', data: { turn: 1, callId: 'c1', content: [{ type: 'text', text: 'ok' }] } },
    { seq: 6, time: 1_700_000_005_000, type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'X', message: 'boom' } } } },
  ]
  const rows = describeEvents(events, SURFACE)
  const conversational = rows.filter((row) => ['user', 'assistant', 'reasoning', 'tool', 'failed'].includes(row.kind))
  assert.ok(conversational.length >= 5, `expected the fixture to produce conversational rows, got ${rows.length}`)
  const stamps = new Set(events.map((event) => event.time))
  for (const row of conversational) {
    assert.ok(
      stamps.has(row.at),
      `a ${row.kind} row carries at=${String(row.at)}, which is not one of the fixture's instants; the day separator needs the real one`,
    )
  }
  // Distinct instants in, distinct instants out: a stamp that came out the same
  // for every row would satisfy the check above and still draw one day.
  assert.ok(
    new Set(conversational.map((row) => row.at)).size > 1,
    'every row got the same timestamp; the separator would never see a day boundary',
  )
})

test('a row whose event has no usable time records nothing rather than 1970', () => {
  // Epoch zero is a real instant in 1970, and a day separator claiming it would be
  // worse than no separator: the reader would be told the conversation is
  // fifty-five years old. `0`, a negative, a string of nonsense and a missing
  // field must all read as "unknown".
  for (const bad of [0, -1, Number.NaN, 'whenever', null, undefined]) {
    const event = { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } } }
    if (bad !== undefined) event.time = bad
    const [row] = describeEvents([event], SURFACE)
    assert.equal(
      row.at,
      null,
      `time ${JSON.stringify(bad)} produced at=${String(row.at)}; an unusable time must be null`,
    )
  }
})

test('an ISO date in the time field parses to the same instant', () => {
  // The field is not schema-pinned in the logs this reads, and a string is what a
  // JSON writer reaches for when it does not want to think about epoch units.
  const iso = '2023-11-14T22:13:20.000Z'
  const event = { seq: 1, time: iso, type: 'user/message', data: { content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } } }
  assert.equal(describeEvents([event], SURFACE)[0].at, Date.parse(iso))
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

test('a long transcript can be walked backwards, one screen at a time', async () => {
  // A real session of the author's is 6969 rows and the panel asked for 60, so
  // 99% of the conversation was unreachable with no way to ask for more. `before`
  // is how many rows to skip from the end, which is what makes paging back
  // possible without renumbering anything.
  const events = []
  for (let at = 0; at < 12; at += 1) events.push(userEvent(`line ${at}`))
  const { chat } = chatWith([item('session-a')], { events })

  const newest = await chat.readMessages('session-a', 4)
  assert.deepEqual(newest.messages.map((row) => row.text), ['line 8', 'line 9', 'line 10', 'line 11'])
  assert.equal(newest.more, true, 'older rows exist and the panel was not told')

  const earlier = await chat.readMessages('session-a', 4, 4)
  assert.deepEqual(earlier.messages.map((row) => row.text), ['line 4', 'line 5', 'line 6', 'line 7'])
  assert.equal(earlier.more, true)

  const oldest = await chat.readMessages('session-a', 4, 8)
  assert.deepEqual(oldest.messages.map((row) => row.text), ['line 0', 'line 1', 'line 2', 'line 3'])
  assert.equal(oldest.more, false, 'the start of the transcript still claimed more')

  // Past the beginning is empty, not an error and not a wrapped-around tail.
  const beyond = await chat.readMessages('session-a', 4, 40)
  assert.deepEqual(beyond.messages, [])
  assert.equal(beyond.more, false)
})

test('a transcript that fits is not advertised as having more', async () => {
  const { chat } = chatWith([item('session-a')], { events: [userEvent('only')] })
  const page = await chat.readMessages('session-a', 60)
  assert.equal(page.more, false, 'the panel would offer to load rows that do not exist')
})

test('a window named by an absolute end does not move when the session grows', async () => {
  // This is why `end` exists beside `before`. A count from the end is not a
  // position in a conversation that is still being written to: search, jump to a
  // match, and then have the model append a reply, and the reader slides forward
  // by exactly the number of rows that arrived.
  //
  // The session has to report as live for this to be a real scenario at all: a
  // cold session's log is cached, because rows that are not being written cannot
  // arrive. Growth means a turn in flight.
  const events = []
  for (let index = 0; index < 12; index += 1) events.push(userEvent(`line ${index}`))
  const { chat } = chatWith([item('session-a')], { events, ports: { sessions: { get: () => ({}) } } })

  // Rows 2..5 counted from a twelve-row end.
  const jumped = await chat.readMessages('session-a', 4, undefined, 6)
  assert.deepEqual(jumped.messages.map((row) => row.text), ['line 2', 'line 3', 'line 4', 'line 5'])
  assert.equal(jumped.total, 12)

  // The same window addressed the old way, for comparison.
  const byCount = await chat.readMessages('session-a', 4, 6)
  assert.deepEqual(byCount.messages.map((row) => row.text), jumped.messages.map((row) => row.text))

  // Now the conversation grows by three rows. The counted window slides; the
  // absolute one stays on the rows the reader was sent to.
  events.push(userEvent('line 12'), userEvent('line 13'), userEvent('line 14'))
  const afterGrowth = await chat.readMessages('session-a', 4, undefined, 6)
  assert.deepEqual(afterGrowth.messages.map((row) => row.text), ['line 2', 'line 3', 'line 4', 'line 5'])
  assert.equal(afterGrowth.total, 15)

  const slid = await chat.readMessages('session-a', 4, 6)
  assert.deepEqual(
    slid.messages.map((row) => row.text),
    ['line 5', 'line 6', 'line 7', 'line 8'],
    'the counted window is the one that drifts; this is the defect `end` avoids',
  )
})

test('an absolute end past the last row is clamped, not empty', async () => {
  // A queued jump can outlive the rows it named: the reader searches, the
  // session is compacted or replaced, and the position is now beyond the end.
  // Returning nothing would show a blank transcript with no way back.
  const events = [userEvent('one'), userEvent('two')]
  const { chat } = chatWith([item('session-a')], { events })
  const past = await chat.readMessages('session-a', 10, undefined, 99)
  assert.deepEqual(past.messages.map((row) => row.text), ['one', 'two'])
  assert.equal(past.more, false)
  assert.equal(past.total, 2)
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
  assert.deepEqual(await chat.readMessages('session-a'), {
    title: '',
    messages: [],
    more: false,
    total: 0,
    // A session whose log cannot be read states nothing about occupancy, and null
    // is how the panel is told "no denominator" — it then prints the used count
    // alone rather than inventing a percentage from a window nobody reported.
    occupancy: { usedTokens: null, contextWindow: null, model: '' },
  })
})

// ---------------------------------------------------------------------------
// Searching a whole conversation
// ---------------------------------------------------------------------------

test('a search answers from the whole session, not from the window on screen', async () => {
  // The panel holds 60 rows of a session that may have thousands, so a search
  // answered from what it holds would report a word as absent from a
  // conversation that contains it. The host reads the session in full.
  const events = [userEvent('the first thing'), assistantEvent([{ type: 'text', text: 'a needle early on' }])]
  for (let index = 0; index < 200; index += 1) {
    events.push(userEvent(`filler ${index}`))
  }
  const { chat } = chatWith([], { events })

  // The window the panel actually holds: the newest 60 rows, which do not
  // contain the needle at all.
  const window = await chat.readMessages('session-a', 60)
  assert.equal(findRows(window.messages, 'needle').length, 0, 'the window must not contain it, or this proves nothing')

  const found = await chat.searchMessages('session-a', 'needle')
  assert.equal(found.matches.length, 1)
  assert.equal(found.matches[0].row.text, 'a needle early on')
  assert.equal(found.total, 202, 'the total is what lets a position become a `before`')
})

test('a search is literal, so regex punctuation does not throw or over-match', async () => {
  const events = [
    userEvent('call filter( on the array'),
    userEvent('a.b matches only itself'),
    userEvent('axb is a different string'),
  ]
  const { chat } = chatWith([], { events })

  // `filter(` and `a.b` are ordinary things to search for in a transcript of
  // code. As regexes the first throws (unbalanced paren) and the second matches
  // `axb`, which is not what the reader typed.
  const paren = await chat.searchMessages('session-a', 'filter(')
  assert.equal(paren.matches.length, 1)
  assert.match(paren.matches[0].row.text, /call filter\(/)

  const dot = await chat.searchMessages('session-a', 'a.b')
  assert.equal(dot.matches.length, 1, 'a literal dot must not match any character')
  assert.equal(dot.matches[0].row.text, 'a.b matches only itself')
})

test('a search is case-insensitive and answers newest first', async () => {
  const events = [
    userEvent('Needle at the start'),
    userEvent('nothing here'),
    userEvent('a needle near the end'),
  ]
  const { chat } = chatWith([], { events })
  const found = await chat.searchMessages('session-a', 'NEEDLE')
  assert.equal(found.matches.length, 2)
  // Newest first: the end of a conversation is where someone scrolling back is
  // looking, and a list starting at the beginning of a long session is one
  // nobody reads to the bottom of.
  assert.equal(found.matches[0].row.text, 'a needle near the end')
  assert.equal(found.matches[1].row.text, 'Needle at the start')
  assert.ok(found.matches[0].index > found.matches[1].index)
})

test('a search finds the reason a tool call failed', async () => {
  // The reason is on screen but in a different field from `text`, so a search
  // that only read `text` would fail to find a visible word.
  const events = [
    callEvent('c1', 'browser_click', { selector: '#save' }),
    resultEvent('c1', { isError: true, text: 'the element is not interactable' }),
  ]
  const { chat } = chatWith([], { events })
  const found = await chat.searchMessages('session-a', 'not interactable')
  assert.equal(found.matches.length, 1)
  assert.equal(found.matches[0].row.kind, 'tool')
})

test('a search does not reach ids the reader cannot see', async () => {
  // `callId` is in the row but never on screen. Searching it would return a row
  // that does not appear to contain the word the reader typed — a result that
  // contradicts the query that produced it, which reads as a broken search
  // rather than as a hidden field.
  const events = [
    callEvent('call-9f3a-hidden', 'browser_click', { selector: '#save' }),
    resultEvent('call-9f3a-hidden', { isError: false, text: 'clicked' }),
  ]
  const { chat } = chatWith([], { events })
  const found = await chat.searchMessages('session-a', 'call-9f3a-hidden')
  assert.equal(found.matches.length, 0, 'an invisible id must not be searchable')

  // The control: the same row is still reachable by a field it does put on
  // screen, so this asserts an exclusion rather than a search that returns
  // nothing. The tool's *name* is the field to use — a successful call's output
  // is deliberately not on the row (only a failure carries a reason), so
  // searching the output text would test a second exclusion by accident.
  const visible = await chat.searchMessages('session-a', 'browser_click')
  assert.equal(visible.matches.length, 1)
})

test('a search for nothing finds nothing rather than everything', async () => {
  const { chat } = chatWith([], { events: [userEvent('something')] })
  for (const query of ['', '   ', '\t\n']) {
    const found = await chat.searchMessages('session-a', query)
    assert.equal(found.matches.length, 0, `a blank query must not match every row: ${JSON.stringify(query)}`)
  }
})

test('a search past the cap says so instead of reading as complete', async () => {
  const events = []
  for (let index = 0; index < 40; index += 1) events.push(userEvent(`repeated word ${index}`))
  const { chat } = chatWith([], { events })
  const found = await chat.searchMessages('session-a', 'repeated')
  assert.equal(found.matches.length, SEARCH_LIMIT)
  // A capped list that reads as complete is how someone concludes their
  // conversation does not contain a word that it does contain.
  assert.equal(found.truncated, true)
  assert.equal(found.total, 40, 'the total still reports the real size')
})

test('a search that reaches exactly the cap is not reported as cut short', async () => {
  // The boundary is the interesting case: `truncated` is `matches.length >=
  // SEARCH_MAX`, which cannot tell "there were exactly thirty" from "there were
  // more". This pins what the panel actually shows for the exact fit.
  const events = []
  for (let index = 0; index < SEARCH_LIMIT; index += 1) events.push(userEvent(`exact word ${index}`))
  const { chat } = chatWith([], { events })
  const found = await chat.searchMessages('session-a', 'exact')
  assert.equal(found.matches.length, SEARCH_LIMIT)
  assert.equal(found.truncated, true)
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

test('a session search goes through the harness index, and says so when there is none', async () => {
  // The list filter could only compare titles, and a title is derived from the
  // opening words of a conversation — so a reader who remembered a phrase from
  // the middle of one had nothing to type. Measured on this machine: four words
  // that appear in real transcripts matched zero rows, while a word taken from a
  // title matched sixteen. The filter worked; it looked in the wrong place.
  //
  // The harness already answers this question, so this is a port rather than a
  // second index over the same logs. What is asserted here is that the port is
  // actually used, and that a profile without it is reported as *unavailable*
  // rather than as an empty result — the two draw the same list, and only one of
  // them means the word is nowhere in the reader's history.
  const seen = []
  const { chat } = chatWith([], {
    ports: {
      sessionQuery: {
        searchSessions: async (request) => {
          seen.push(request)
          return {
            items: [
              { sessionId: 'session-b', seq: 412, snippet: 'a line with zstdDecompressSync in it' },
              // A hit with no excerpt still names a session, and dropping it
              // would answer "which chats" with fewer chats than there are.
              { sessionId: 'session-c', seq: 88, snippet: '' },
            ],
            nextCursor: 'more-please',
          }
        },
      },
    },
  })

  const found = await chat.searchEverySession('zstdDecompressSync')
  assert.equal(found.available, true)
  assert.deepEqual(seen, [{ query: 'zstdDecompressSync', limit: 20 }])
  assert.deepEqual(
    found.hits.map((hit) => hit.sessionId),
    ['session-b', 'session-c'],
    'every hit names a session, including one whose excerpt could not be taken',
  )
  // The excerpt is the service's own, chosen around the match — that is the part
  // the reader is looking for, and re-deriving it here would be a second answer.
  assert.equal(found.hits[0].snippet, 'a line with zstdDecompressSync in it')
  assert.equal(found.hits[0].seq, 412)
  // A cursor is the service saying there is more. Reported rather than dropped:
  // a capped list that reads as complete is how someone concludes their history
  // lacks a word it contains.
  assert.equal(found.more, true)

  // A blank query is not a search for everything.
  seen.length = 0
  const blank = await chat.searchEverySession('   ')
  assert.deepEqual(blank.hits, [])
  assert.deepEqual(seen, [], 'a blank query must not reach the index at all')
})

test('a missing session index reads as unavailable, not as nothing found', async () => {
  // Absent service is a state, not a crash: this plugin has to run in profiles
  // that do not mount the harness's query service, and the panel must be able to
  // tell the reader which of the two empty lists they are looking at.
  const { chat } = chatWith([])
  const answer = await chat.searchEverySession('anything')
  assert.equal(answer.available, false)
  assert.deepEqual(answer.hits, [])
  // The reason is a sentence for a reader, not a service name for a log.
  assert.ok(
    answer.reason.length > 0 && !answer.reason.includes('sessionQuery'),
    `the reason is shown in the panel, so it must not name the service: ${answer.reason}`,
  )
})
