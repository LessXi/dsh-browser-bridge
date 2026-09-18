/**
 * Live-output relay tests.
 *
 * The relay is the only part of this plugin that carries data nobody asked for:
 * the harness streams a model attempt through `agent/assistant-stream`, and the
 * panel renders it before the committed message exists. Two failure modes are
 * worth locking down, because neither is visible from the panel side:
 *
 *   - Per-token forwarding. Frames arrive once per token, and a reply that
 *     sends a websocket frame per token is a different product from one that
 *     sends twenty. The coalescing is asserted by counting notifications, not
 *     by inspecting the buffer.
 *   - A silent relay. `dropped` climbing while `frames` is zero and `frames`
 *     climbing while `notifications` is zero look identical from the panel —
 *     both are "no text appeared" — so the counters are asserted separately.
 *
 * The last block is structural: the host half and the extension half are two
 * files with no shared type, so the notification name and the routing key are
 * checked against each other rather than trusted.
 *
 * @module dsh-browser-bridge/test/stream.test
 */

import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { test, assert } from './harness.js'
import {
  AssistantStreamRelay,
  DEFAULT_FLUSH_MS,
  createStreamRelay,
  deltaOfFrame,
  sessionOfAttempt,
} from '../lib/stream.js'
import { BrowserConnection } from '../lib/bridge.js'
import { NOTIFICATIONS } from '../lib/protocol.js'

const here = dirname(fileURLToPath(import.meta.url))
const extensionDir = join(here, '..', '..', '..', 'extension')

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** A recording stand-in for a live bridge connection. */
function recordingBridge(options = {}) {
  const sent = []
  return {
    sent,
    bridge: {
      connection: {
        notify(name, payload) {
          if (options.refuse === true) return false
          sent.push({ name, payload })
          return true
        },
      },
    },
  }
}

/**
 * Timers under test control, so a flush is a step rather than a wait.
 * @returns {{ timers: object, run: () => void, handles: object[] }} The clock.
 */
function manualClock() {
  const handles = []
  return {
    handles,
    timers: {
      set: (fn) => {
        const handle = { fn, cleared: false }
        handles.push(handle)
        return handle
      },
      clear: (handle) => {
        handle.cleared = true
      },
    },
    run() {
      for (const handle of handles.splice(0)) if (!handle.cleared) handle.fn()
    },
  }
}

/** A start frame for attempt `n` of `sessionId`. */
function startFrame(sessionId, attempt = 1) {
  return { type: 'start', attemptId: `${sessionId}:${attempt}`, revision: 1, turn: 1, step: 1 }
}

/** A chunk frame carrying `chunk`. */
function chunkFrame(sessionId, chunk, attempt = 1) {
  return { type: 'chunk', attemptId: `${sessionId}:${attempt}`, revision: 1, index: 0, time: 0, chunk }
}

/** An end frame for a committed attempt. */
function endFrame(sessionId, attempt = 1) {
  return {
    type: 'end',
    attemptId: `${sessionId}:${attempt}`,
    revision: 1,
    index: 0,
    outcome: { kind: 'committed', eventType: 'assistant/message', seq: 12 },
  }
}

/**
 * An end frame for an attempt that threw.
 *
 * Measured against a real failing turn, this is **not** what a refused provider
 * request arrives as — see {@link failureFrame}. It is kept because the shape
 * exists in `AssistantStreamAttempt.abandon()` and a reduction that threw on an
 * unfamiliar outcome would be worse than one that ignores it.
 */
function abandonedFrame(sessionId, attempt = 1) {
  return {
    type: 'end',
    attemptId: `${sessionId}:${attempt}`,
    revision: 1,
    index: 0,
    outcome: { kind: 'abandoned' },
  }
}

/**
 * The frame a refused provider request actually produces.
 *
 * Copied from a real failing turn: a probe instance with no provider key sent
 * one message and the session log held `assistant/attempt` whose `stream` was a
 * single `finish` chunk with `reason.kind === 'error'` and
 * `code === 'MISSING_CREDENTIAL'`. No `assistant/message` was appended.
 *
 * `dsh-agent-loop` settles an `assistant/attempt` event *before* the throw
 * reaches its `abandon()` call, and settling marks the attempt terminal, so the
 * `end` frame for this same turn reports `outcome: {kind:'committed'}` —
 * byte-identical to a turn that succeeded. The failure signal therefore lives
 * here, in the chunk, and not in `outcome`.
 */
function failureFrame(sessionId, attempt = 1, code = 'MISSING_CREDENTIAL') {
  return chunkFrame(sessionId, {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        message: `llm-deepseek: no API key for provider route "deepseek-official"`,
        code,
      },
    },
  }, attempt)
}

/** The frame a deliberately stopped turn produces: `aborted`, not `error`. */
function abortedFrame(sessionId, attempt = 1) {
  return chunkFrame(
    sessionId,
    { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } } },
    attempt,
  )
}

/** A finish chunk for an attempt that simply ended its turn. */
function completedFrame(sessionId, attempt = 1) {
  return chunkFrame(sessionId, { type: 'finish', reason: { kind: 'completed' } }, attempt)
}

const SESSION = 'session-16ac81ea-14e0-4086-922a-57c74a66818c'

// ─────────────────────────────────────────────────────────────────────────────
// Frame reduction
// ─────────────────────────────────────────────────────────────────────────────

test('an attempt id carries its session in front of the colon', () => {
  assert.equal(sessionOfAttempt(`${SESSION}:7`), SESSION)
  // The session id itself may contain dashes; only the last colon separates.
  assert.equal(sessionOfAttempt('a-b-c:12'), 'a-b-c')
  assert.equal(sessionOfAttempt(':7'), undefined)
  assert.equal(sessionOfAttempt('nocolon'), undefined)
  assert.equal(sessionOfAttempt(undefined), undefined)
  assert.equal(sessionOfAttempt(42), undefined)
})

test('the renderable chunk kinds become deltas, and chatty ones do not', () => {
  assert.deepEqual(deltaOfFrame(startFrame(SESSION)), { kind: 'start' })
  assert.deepEqual(deltaOfFrame(endFrame(SESSION)), { kind: 'end' })
  assert.deepEqual(deltaOfFrame(chunkFrame(SESSION, { type: 'text-delta', index: 0, text: '你' })), {
    kind: 'text',
    text: '你',
  })
  assert.deepEqual(deltaOfFrame(chunkFrame(SESSION, { type: 'reasoning-delta', index: 0, text: '想' })), {
    kind: 'reasoning',
    text: '想',
  })
  assert.deepEqual(
    deltaOfFrame(chunkFrame(SESSION, { type: 'tool-call-delta', index: 1, id: 'c1', name: 'pwsh' })),
    { kind: 'tool', text: 'pwsh' },
  )
})

test('an attempt that threw says so, instead of looking like an empty answer', () => {
  // The failure reason lives in the `finish` chunk. Both it and the end frame
  // used to be dropped: the panel stopped its shimmer and re-read a transcript
  // that had not changed, so a refused provider request looked exactly like a
  // model with nothing to say.
  assert.deepEqual(deltaOfFrame(failureFrame(SESSION)), {
    kind: 'failed',
    text: 'llm-deepseek: no API key for provider route "deepseek-official"',
  })

  // A finish chunk with no message still reports a failure; the panel falls back
  // to its own wording rather than showing an empty reason.
  assert.deepEqual(
    deltaOfFrame(chunkFrame(SESSION, { type: 'finish', reason: { kind: 'error', failure: {} } })),
    { kind: 'failed', text: '' },
  )

  // Stopping a turn on purpose is not a failure — the panel already shows that
  // as its own action, and reporting it as a crash would be a lie.
  assert.equal(deltaOfFrame(abortedFrame(SESSION)), undefined)
  // Nor is an ordinary completion.
  assert.equal(deltaOfFrame(completedFrame(SESSION)), undefined)

  // An end frame is never a failure, whatever its outcome says. A real failing
  // turn reports `committed` here, so reading `outcome` for the failure would be
  // reading a field that cannot carry the answer.
  assert.deepEqual(deltaOfFrame(abandonedFrame(SESSION)), { kind: 'end' })
  assert.deepEqual(deltaOfFrame(endFrame(SESSION)), { kind: 'end' })

  // A frame with no outcome at all is not a failure — older harnesses simply do
  // not say, and inventing a failure would be worse than saying nothing.
  assert.deepEqual(deltaOfFrame({ type: 'end', attemptId: `${SESSION}:1`, revision: 1, index: 0 }), {
    kind: 'end',
  })
})

test('a frame that carries nothing renderable is ignored rather than guessed at', () => {
  // A tool call announces its name once and then streams only arguments. The
  // argument frames must not each turn into a notification.
  assert.equal(deltaOfFrame(chunkFrame(SESSION, { type: 'tool-call-delta', index: 1, id: 'c1', argumentsDelta: '{"' })), undefined)
  assert.equal(deltaOfFrame(chunkFrame(SESSION, { type: 'text-delta', index: 0, text: 42 })), undefined)
  assert.equal(deltaOfFrame(chunkFrame(SESSION, { type: 'block-end', index: 0, block: { type: 'text' } })), undefined)
  assert.equal(deltaOfFrame(chunkFrame(SESSION, { type: 'finish' })), undefined)
  assert.equal(deltaOfFrame({ type: 'something-else' }), undefined)
  assert.equal(deltaOfFrame(undefined), undefined)
  assert.equal(deltaOfFrame(null), undefined)
  assert.equal(deltaOfFrame('chunk'), undefined)
})

// ─────────────────────────────────────────────────────────────────────────────
// Coalescing
// ─────────────────────────────────────────────────────────────────────────────

test('a start frame is delivered immediately, because the panel must know a turn began', () => {
  const clock = manualClock()
  const { bridge, sent } = recordingBridge()
  const relay = createStreamRelay({ bridge, timers: clock.timers })

  relay.acceptFrame(startFrame(SESSION))

  assert.equal(sent.length, 1, 'start was buffered instead of sent')
  assert.deepEqual(sent[0], {
    name: NOTIFICATIONS.assistantDelta,
    payload: { sessionId: SESSION, kind: 'start' },
  })
  assert.equal(relay.stats().flushes, 0)
})

test('a burst of tokens becomes one notification, not one per token', () => {
  const clock = manualClock()
  const { bridge, sent } = recordingBridge()
  const relay = createStreamRelay({ bridge, timers: clock.timers })

  for (const piece of ['The ', 'answer ', 'is ', '42.']) {
    relay.acceptFrame(chunkFrame(SESSION, { type: 'text-delta', index: 0, text: piece }))
  }

  assert.equal(sent.length, 0, 'text was sent before the flush timer ran')
  assert.equal(relay.buffered(), 17)
  assert.equal(clock.handles.length, 1, 'a timer was armed per token instead of once')

  clock.run()

  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].payload, { sessionId: SESSION, kind: 'text', text: 'The answer is 42.' })
  assert.equal(relay.stats().notifications, 1)
  assert.equal(relay.buffered(), 0)
})

test('text and reasoning accumulate apart, in the order they are flushed', () => {
  const clock = manualClock()
  const { bridge, sent } = recordingBridge()
  const relay = createStreamRelay({ bridge, timers: clock.timers })

  relay.acceptFrame(chunkFrame(SESSION, { type: 'reasoning-delta', index: 0, text: 'let me ' }))
  relay.acceptFrame(chunkFrame(SESSION, { type: 'text-delta', index: 1, text: 'Hi' }))
  relay.acceptFrame(chunkFrame(SESSION, { type: 'reasoning-delta', index: 0, text: 'think' }))
  clock.run()

  assert.deepEqual(
    sent.map((frame) => frame.payload),
    [
      { sessionId: SESSION, kind: 'reasoning', text: 'let me think' },
      { sessionId: SESSION, kind: 'text', text: 'Hi' },
    ],
  )
})

test('two sessions in flight at once never share a buffer', () => {
  const clock = manualClock()
  const { bridge, sent } = recordingBridge()
  const relay = createStreamRelay({ bridge, timers: clock.timers })
  const other = 'session-0f1e2d3c-4b5a-4c6d-8e7f-901234567890'

  relay.acceptFrame(chunkFrame(SESSION, { type: 'text-delta', index: 0, text: 'mine' }))
  relay.acceptFrame(chunkFrame(other, { type: 'text-delta', index: 0, text: 'theirs' }))
  clock.run()

  assert.deepEqual(
    sent.map((frame) => frame.payload).sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
    [
      { sessionId: other, kind: 'text', text: 'theirs' },
      { sessionId: SESSION, kind: 'text', text: 'mine' },
    ],
  )
})

test('the tail is flushed before the attempt is declared over', () => {
  const clock = manualClock()
  const { bridge, sent } = recordingBridge()
  const relay = createStreamRelay({ bridge, timers: clock.timers })

  relay.acceptFrame(chunkFrame(SESSION, { type: 'text-delta', index: 0, text: 'last words' }))
  relay.acceptFrame(endFrame(SESSION))

  assert.deepEqual(
    sent.map((frame) => frame.payload.kind),
    ['text', 'end'],
    'the end frame overtook the text it settles',
  )
  assert.equal(sent[0].payload.text, 'last words')
  assert.equal(relay.stats().ends, 1)
  // The timer that was armed for the text must not fire again afterwards.
  clock.run()
  assert.equal(sent.length, 2)
})

// ─────────────────────────────────────────────────────────────────────────────
// Degradation
// ─────────────────────────────────────────────────────────────────────────────

test('with no extension connected the text is discarded and counted, never queued', () => {
  const clock = manualClock()
  const relay = createStreamRelay({ timers: clock.timers })

  relay.acceptFrame(chunkFrame(SESSION, { type: 'text-delta', index: 0, text: 'nobody is listening' }))
  clock.run()

  const stats = relay.stats()
  assert.equal(stats.dropped, 1)
  assert.equal(stats.notifications, 0)
  assert.equal(relay.buffered(), 0)
})

test('a connection that refuses the frame counts as dropped, not as sent', () => {
  const clock = manualClock()
  const { bridge } = recordingBridge({ refuse: true })
  const relay = createStreamRelay({ bridge, timers: clock.timers })

  relay.acceptFrame(startFrame(SESSION))

  assert.equal(relay.stats().dropped, 1)
  assert.equal(relay.stats().notifications, 0)
})

test('a frame whose attempt id names no session is ignored', () => {
  const clock = manualClock()
  const { bridge, sent } = recordingBridge()
  const relay = createStreamRelay({ bridge, timers: clock.timers })

  relay.acceptFrame({ type: 'chunk', attemptId: undefined, chunk: { type: 'text-delta', text: 'orphan' } })
  relay.acceptFrame({ type: 'chunk', attemptId: 'no-colon', chunk: { type: 'text-delta', text: 'orphan' } })
  clock.run()

  assert.equal(sent.length, 0)
  assert.equal(relay.stats().ignored, 2)
  assert.equal(relay.stats().frames, 2)
})

test('disposing flushes what is pending instead of dropping it', () => {
  const clock = manualClock()
  const { bridge, sent } = recordingBridge()
  const relay = createStreamRelay({ bridge, timers: clock.timers })

  relay.acceptFrame(chunkFrame(SESSION, { type: 'text-delta', index: 0, text: 'half a th' }))
  relay.dispose()

  assert.equal(sent.length, 1)
  assert.equal(sent[0].payload.text, 'half a th')
  assert.equal(relay.buffered(), 0)
})

// ─────────────────────────────────────────────────────────────────────────────
// Subscription
// ─────────────────────────────────────────────────────────────────────────────

test('attach subscribes to the agent stream and detaches again', () => {
  const clock = manualClock()
  const { bridge, sent } = recordingBridge()
  const relay = new AssistantStreamRelay({ bridge, timers: clock.timers })

  const listeners = new Map()
  const off = relay.attach({
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
  })

  assert.ok(listeners.has('agent/assistant-stream'), 'the relay subscribed to the wrong event')
  // The harness delivers `{ agent, frame }`, not a bare frame.
  listeners.get('agent/assistant-stream')({ agent: {}, frame: startFrame(SESSION) })
  assert.equal(sent.length, 1)

  off()
  assert.equal(listeners.size, 0)
  // Detaching twice must not throw: the plugin tears this down from an effect.
  off()
})

test('stats name every way a frame can end up going nowhere', () => {
  const clock = manualClock()
  const relay = createStreamRelay({ timers: clock.timers })
  const stats = relay.stats()

  for (const key of ['frames', 'ignored', 'flushes', 'notifications', 'dropped', 'ends', 'buffered']) {
    assert.equal(typeof stats[key], 'number', `${key} is missing from the health counters`)
  }
  assert.equal(relay.stats().buffered, 0)
  assert.equal(DEFAULT_FLUSH_MS, 80)
})

// ─────────────────────────────────────────────────────────────────────────────
// The wire, end to end through a real connection object
// ─────────────────────────────────────────────────────────────────────────────

/** A recording stand-in for a `ws` socket, matching what the bridge compares against. */
class FakeSocket extends EventEmitter {
  OPEN = 1
  readyState = 1
  sent = []

  send(text) {
    if (this.readyState !== this.OPEN) throw new Error('socket is not open')
    this.sent.push(JSON.parse(text))
  }

  close() {
    this.readyState = 3
    this.emit('close')
  }
}

test('the failure survives the relay, not just the frame reduction', () => {
  // Reducing the frame and then rebuilding the payload from `kind` alone
  // dropped the reason a second time, one hop later — where no test of
  // `deltaOfFrame` could see it. This asserts on what actually reaches the
  // socket, including the provider's own words.
  const socket = new FakeSocket()
  const connection = new BrowserConnection(socket)
  const clock = manualClock()
  const relay = createStreamRelay({ bridge: { connection }, timers: clock.timers })

  relay.acceptFrame(failureFrame(SESSION))
  clock.run()

  assert.deepEqual(
    socket.sent.map((entry) => entry.payload),
    [
      {
        sessionId: SESSION,
        kind: 'failed',
        text: 'llm-deepseek: no API key for provider route "deepseek-official"',
      },
    ],
  )
  assert.equal(relay.stats().failed, 1, 'the failed turn was not counted apart from ordinary ends')
  assert.equal(relay.stats().ends, 0, 'a failure was counted as an ordinary end')
})

test('a failure with no message still reaches the panel as one', () => {
  const socket = new FakeSocket()
  const connection = new BrowserConnection(socket)
  const clock = manualClock()
  const relay = createStreamRelay({ bridge: { connection }, timers: clock.timers })

  relay.acceptFrame(chunkFrame(SESSION, { type: 'finish', reason: { kind: 'error', failure: {} } }))
  clock.run()

  assert.deepEqual(
    socket.sent.map((entry) => entry.payload),
    [{ sessionId: SESSION, kind: 'failed' }],
  )
  assert.equal(relay.stats().failed, 1)
})

test('an ordinary end is not counted as a failure', () => {
  const socket = new FakeSocket()
  const connection = new BrowserConnection(socket)
  const clock = manualClock()
  const relay = createStreamRelay({ bridge: { connection }, timers: clock.timers })

  relay.acceptFrame(endFrame(SESSION))
  clock.run()

  assert.deepEqual(
    socket.sent.map((entry) => entry.payload),
    [{ sessionId: SESSION, kind: 'end' }],
  )
  assert.equal(relay.stats().failed, 0, 'an ordinary end was counted as a failure')
  assert.equal(relay.stats().ends, 1)
})

test('a failed turn still ends, so the panel stops animating either way', () => {
  // The failure is not a replacement for `end`: the attempt really is over, and
  // a panel that only heard `failed` would leave its shimmer running.
  const socket = new FakeSocket()
  const connection = new BrowserConnection(socket)
  const clock = manualClock()
  const relay = createStreamRelay({ bridge: { connection }, timers: clock.timers })

  relay.acceptFrame(startFrame(SESSION))
  relay.acceptFrame(failureFrame(SESSION))
  relay.acceptFrame(endFrame(SESSION, 2))
  clock.run()

  assert.deepEqual(
    socket.sent.map((entry) => entry.payload),
    [{ sessionId: SESSION, kind: 'start' }, { sessionId: SESSION, kind: 'failed', text: 'llm-deepseek: no API key for provider route "deepseek-official"' }, { sessionId: SESSION, kind: 'end' }],
  )
  assert.equal(relay.stats().failed, 1)
  assert.equal(relay.stats().ends, 1)
})

test('a notification reaches the socket under its own key, with no id', () => {
  const socket = new FakeSocket()
  const connection = new BrowserConnection(socket)
  const clock = manualClock()
  const relay = createStreamRelay({ bridge: { connection }, timers: clock.timers })

  assert.equal(connection.live, true)
  relay.acceptFrame(chunkFrame(SESSION, { type: 'text-delta', index: 0, text: 'hello' }))
  clock.run()

  assert.equal(socket.sent.length, 1)
  assert.deepEqual(socket.sent[0], {
    notify: 'assistant/delta',
    payload: { sessionId: SESSION, kind: 'text', text: 'hello' },
  })
  // The whole point of the third shape: no `id`, so the extension must not try
  // to answer it, and no `event`, so the host must not read it as one.
  assert.equal('id' in socket.sent[0], false)
  assert.equal('event' in socket.sent[0], false)
})

test('a dead socket makes notify report failure instead of throwing', () => {
  const socket = new FakeSocket()
  const connection = new BrowserConnection(socket)
  socket.close()

  assert.equal(connection.live, false)
  assert.equal(connection.notify('assistant/delta', { sessionId: SESSION, kind: 'end' }), false)
  assert.equal(socket.sent.length, 0)
})

// ─────────────────────────────────────────────────────────────────────────────
// The two halves must agree
// ─────────────────────────────────────────────────────────────────────────────

const background = readFileSync(join(extensionDir, 'background.js'), 'utf8')
const sidepanel = readFileSync(join(extensionDir, 'sidepanel.js'), 'utf8')
const sidepanelHtml = readFileSync(join(extensionDir, 'sidepanel.html'), 'utf8')

test('the service worker routes notifications before it looks for a request id', () => {
  const notifyAt = background.indexOf('parsed.notify')
  const idAt = background.indexOf('const id = parsed.id')
  assert.ok(notifyAt !== -1, 'background.js never looks at the notify key')
  assert.ok(idAt !== -1, 'the request path changed shape; this test is now blind')
  assert.ok(
    notifyAt < idAt,
    'notifications are routed after the id guard, so every one of them is dropped',
  )
})

test('the extension and the host agree on every notification name', () => {
  // These two files cannot share a constant, so the literals are checked
  // instead. The extension half names each one in `relayNotification`.
  //
  // The check is "filters on the name", not "filters on the name with `!==`":
  // the relay now carries more than one kind, so a filter is still required and
  // its shape is not. What must stay true is that an unrecognized notification
  // is not forwarded to the panel, because the panel would have to guess at it.
  const names = Object.values(NOTIFICATIONS)
  assert.ok(names.length > 1, 'this test is blind now that notifications collapsed to one name')

  for (const name of names) {
    assert.ok(
      background.includes(`'${name}'`),
      `background.js does not mention "${name}", so it never reaches the panel`,
    )
    assert.ok(
      background.includes(`notify === '${name}'`),
      `relayNotification does not filter on "${name}"; an unknown notification would be forwarded`,
    )
  }

  // And the panel has to be listening for what the worker forwards.
  for (const type of ['dsh-assistant-delta', 'dsh-approval-asked', 'dsh-approval-settled']) {
    assert.ok(
      sidepanel.includes(`'${type}'`),
      `sidepanel.js does not listen for "${type}"`,
    )
  }
})

test('the panel listens for the forwarded deltas and folds them into one live block', () => {
  assert.ok(
    sidepanel.includes("'dsh-assistant-delta'"),
    'sidepanel.js does not listen for the forwarded deltas',
  )
  assert.ok(sidepanel.includes('function applyDelta('), 'applyDelta is gone')
  assert.ok(sidepanel.includes('function renderLive('), 'renderLive is gone')
  // The stream must sit outside the signature-compared row list, or every token
  // would rebuild the whole transcript.
  assert.ok(
    sidepanelHtml.includes('.live-body::after'),
    'the streaming caret is missing from the panel stylesheet',
  )
  assert.ok(sidepanelHtml.includes("@media (prefers-reduced-motion: reduce) {\n        .live-body::after"), 
    'the streaming caret must stop moving under prefers-reduced-motion')
})

test('the panel never renders a partial stream as markdown', () => {
  // A half-finished table or fence parses differently on every frame, so the
  // live block is plain text and the parsed row arrives with the commit.
  const live = sidepanel.slice(sidepanel.indexOf('function renderLive('))
  const body = live.slice(0, live.indexOf('\n}'))
  assert.ok(
    body.includes('body.textContent = live.text'),
    'renderLive no longer assigns plain text',
  )
  assert.equal(
    body.includes('renderMarkdown'),
    false,
    'renderLive parses markdown mid-stream, which reflows on every frame',
  )
})
