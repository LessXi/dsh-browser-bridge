/**
 * The side panel, driven for real.
 *
 * `test/stream.test.js` proves the host coalesces tokens and the wire carries
 * the notification. It cannot prove the panel does anything useful with it, and
 * the gap between those two points is where a feature would actually be broken:
 * a delta for the wrong session, a second live block per token, text that never
 * gives way to the committed row, markdown parsed mid-stream.
 *
 * So the panel module is imported into the DOM shim in `test/dom-shim.js` and
 * the messages the service worker would forward are handed to it directly.
 *
 * The second half covers the composer's one action — the button that starts a
 * turn has to become the button that stops it — which is the other end of the
 * same story and equally invisible to a host-side test.
 *
 * Both live in one file because the panel is a stateful module: a second suite
 * importing `extension/sidepanel.js` would be handed the cached instance and
 * its own host stub would never be called. That failure is not subtle, but it
 * is confusing, and the runner imports every suite before running any of them.
 *
 * @module dsh-browser-bridge/test/panel-stream.test
 */

import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { test, assert } from './harness.js'
import { makeDocument } from './dom-shim.js'

const here = dirname(fileURLToPath(import.meta.url))
const extensionDir = join(here, '..', '..', '..', 'extension')

const SESSION = 'session-16ac81ea-14e0-4086-922a-57c74a66818c'
const OTHER = 'session-0f1e2d3c-4b5a-4c6d-8e7f-901234567890'

// ─────────────────────────────────────────────────────────────────────────────
// The browser, as far as the panel can tell
// ─────────────────────────────────────────────────────────────────────────────

/** What the harness routes answer with, mutated per test. */
const host = {
  messages: [],
  title: 'A session',
  running: false,
  requests: [],
  /** Every `POST {action:'send'}` body, in order. */
  sent: [],
  /** Every `POST {action:'cancel'}` body, in order. */
  cancelled: [],
  /** The answer `cancel` gets, mutated per test. */
  cancel: { status: 200, payload: { cancelled: true } },
}

const groupsPayload = () => ({
  groups: [
    {
      id: 'workspace-1',
      title: 'A workspace',
      sessions: [{ id: SESSION, title: 'A session', updatedAt: 0, running: host.running, blank: false }],
    },
  ],
})

function respond(payload, status = 200) {
  return { ok: status < 400, status, json: async () => payload }
}

const { document, registry } = makeDocument()
const inbox = []

globalThis.document = document
globalThis.chrome = {
  i18n: { getUILanguage: () => 'zh-CN' },
  runtime: {
    onMessage: { addListener: (listener) => inbox.push(listener) },
    sendMessage: async () => {},
    openOptionsPage: async () => {},
    getManifest: () => ({ version: '0.3.0' }),
    lastError: undefined,
  },
  tabs: {
    query: async () => [],
    sendMessage: async () => ({}),
    onActivated: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
  },
  storage: {
    local: {
      get: async (defaults) => ({ ...defaults }),
      set: async () => {},
    },
  },
}

const realFetch = globalThis.fetch
globalThis.fetch = async (url, options = {}) => {
  const address = String(url)
  host.requests.push({ url: address, method: options.method ?? 'GET' })
  if (address.includes('/browser-bridge/chat')) {
    if ((options.method ?? 'GET') === 'GET') return respond(groupsPayload())
    const body = options.body === undefined ? {} : JSON.parse(options.body)
    if (body.action === 'messages') return respond({ sessionId: body.sessionId, messages: host.messages, title: host.title })
    if (body.action === 'models') return respond({ error: 'empty-catalog' })
    if (body.action === 'send') {
      host.sent.push(body)
      return respond({ accepted: true })
    }
    if (body.action === 'cancel') {
      host.cancelled.push(body)
      return respond(host.cancel.payload, host.cancel.status)
    }
    return respond({ accepted: true })
  }
  if (address.includes('/browser-bridge/health')) return respond({ connected: true })
  return realFetch === undefined ? respond({}) : realFetch(url, options)
}

// Intervals are not stubbed out of caution: the panel arms four of them in
// `start`, and a five-second poll firing mid-test would rewrite the transcript
// under an assertion. Nothing else in this run uses them.
const realSetInterval = globalThis.setInterval
globalThis.setInterval = () => 0

/** Let the panel's promise chains run to a standstill. */
async function settle(turns = 40) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve()
}

/** Hand the panel a message, the way the service worker would. */
function deliver(payload) {
  for (const listener of inbox) listener({ type: 'dsh-assistant-delta', payload })
}

const liveNode = () => transcript.querySelector('.live')
const liveBody = () => transcript.querySelector('.live-body')

/** Start a fresh attempt and return nothing; the assertions read the DOM. */
function startAttempt(sessionId = SESSION) {
  deliver({ sessionId, kind: 'start' })
}

// Assigned after the import, because the panel is what mints these nodes.
let transcript
let sendButton
let input
let toast
let turn = 0

/**
 * Put the panel where a finished turn leaves it: one committed row on screen
 * and no live block.
 *
 * The module keeps the live attempt private, so the only honest way to clear it
 * is the panel's own rule — a settled stream gives way once the transcript it
 * belongs to actually changes. Each call therefore commits a row the previous
 * one did not have, which is also what happens for real.
 *
 * @returns {Promise<void>} Resolves once the panel has re-read the transcript.
 */
async function idle() {
  turn += 1
  host.messages = [{ kind: 'assistant', text: `idle ${turn}` }]
  deliver({ sessionId: SESSION, kind: 'end' })
  await settle()
}

await import(pathToFileURL(join(extensionDir, 'sidepanel.js')).href)
await settle()
globalThis.setInterval = realSetInterval
transcript = registry.get('transcript')
sendButton = registry.get('send')
input = registry.get('input')
toast = registry.get('toast')

// The import must have reached the host: if it did not, every assertion below
// would be testing a panel that never selected a session and would pass
// vacuously on the "ignored" cases.
assert.ok(
  host.requests.some((request) => request.url.includes('/browser-bridge/chat')),
  'the panel never called the host, so this suite cannot observe anything',
)

// ─────────────────────────────────────────────────────────────────────────────

test('a start frame shows the waiting line and no empty live block', async () => {
  await idle()
  assert.equal(liveNode(), null, 'a live block was on screen before a turn began')

  startAttempt()

  // An empty live block with a caret in it would sit on top of the waiting
  // line and say the same thing twice.
  assert.equal(liveNode(), null, 'a start frame drew an empty live block')
  const working = transcript.querySelector('.working')
  assert.ok(working !== null, 'the waiting line is missing, so the panel looks idle')

  deliver({ sessionId: SESSION, kind: 'text', text: 'F' })

  const node = liveNode()
  assert.ok(node !== null, 'the first token produced no live block')
  assert.ok(
    transcript.children.indexOf(node) < transcript.children.indexOf(working),
    'the live block was appended under the waiting line',
  )
})

test('a burst of deltas grows one text node instead of one node per token', async () => {
  await idle()
  startAttempt()

  for (const piece of ['The ', 'answer ', 'is ', '42.']) {
    deliver({ sessionId: SESSION, kind: 'text', text: piece })
  }

  assert.equal(transcript.querySelectorAll('.live').length, 1, 'a live block was created per delta')
  assert.equal(liveBody().textContent, 'The answer is 42.')
})

test('reasoning is shown while it is the only thing there, and gives way to the answer', async () => {
  await idle()
  startAttempt()
  deliver({ sessionId: SESSION, kind: 'reasoning', text: 'weighing it up' })

  const think = transcript.querySelector('.live-think')
  assert.ok(think !== null, 'the live block has no reasoning line')
  assert.equal(think.textContent, 'weighing it up')
  assert.equal(think.hidden, false)

  deliver({ sessionId: SESSION, kind: 'text', text: 'Here.' })

  assert.equal(transcript.querySelector('.live-think').hidden, true, 'reasoning stayed up beside the answer')
  assert.equal(liveBody().textContent, 'Here.')
})

test('a delta for another session is ignored, not filed under this one', async () => {
  await idle()
  startAttempt()
  deliver({ sessionId: SESSION, kind: 'text', text: 'mine' })

  deliver({ sessionId: OTHER, kind: 'text', text: 'theirs' })
  deliver({ sessionId: OTHER, kind: 'reasoning', text: 'theirs' })

  assert.equal(liveBody().textContent, 'mine')
  assert.equal(transcript.querySelector('.live-think').textContent, '')
})

test('a panel opened mid-turn shows nothing live rather than a truncated tail', async () => {
  await idle()
  // No `start` was ever seen, which is exactly the case for a panel that was
  // opened after the turn began.
  deliver({ sessionId: SESSION, kind: 'text', text: 'half a sentence' })

  assert.equal(liveNode(), null, 'a delta without a start invented a live block')
})

test('the end frame stops the animation but keeps the text until the real row lands', async () => {
  await idle()
  startAttempt()
  deliver({ sessionId: SESSION, kind: 'text', text: 'Done.' })

  deliver({ sessionId: SESSION, kind: 'end' })

  assert.equal(liveNode().dataset.done, 'true')
  assert.equal(liveBody().textContent, 'Done.', 'the text vanished the moment the attempt settled')
})

test('the committed row replaces the live block instead of joining it', async () => {
  await idle()
  startAttempt()
  deliver({ sessionId: SESSION, kind: 'text', text: 'Done.' })
  host.messages = [{ kind: 'assistant', text: 'Done.' }]
  // The turn is over as far as the host is concerned, which is what the panel
  // re-reads when the attempt settles.
  host.running = false
  deliver({ sessionId: SESSION, kind: 'end' })
  await settle()

  assert.equal(liveNode(), null, 'the live block outlived the row that replaced it')
  assert.equal(transcript.querySelectorAll('.live-body').length, 0, 'the live text was left behind as a second row')
  const answers = transcript.querySelectorAll('.answer')
  assert.equal(answers.at(-1).textContent, 'Done.')
  assert.equal(transcript.querySelector('.working'), null, 'the waiting line outlived the turn')
})

test('the waiting line reflects the host, not the last frame received', async () => {
  await idle()
  host.running = true
  startAttempt()
  deliver({ sessionId: SESSION, kind: 'text', text: 'thinking out loud' })
  assert.ok(transcript.querySelector('.working') !== null, 'a running turn showed no waiting line')

  // A step ended but the turn has not: the host still reports the session as
  // running, so the panel must keep saying so.
  host.running = true
  deliver({ sessionId: SESSION, kind: 'end' })
  await settle()
  assert.ok(
    transcript.querySelector('.working') !== null,
    'the waiting line vanished between two steps of the same turn',
  )
  host.running = false
})

test('a live block never survives into the next attempt', async () => {
  await idle()
  startAttempt()
  deliver({ sessionId: SESSION, kind: 'text', text: 'first' })
  host.messages = [{ kind: 'assistant', text: 'first' }]
  deliver({ sessionId: SESSION, kind: 'end' })
  await settle()

  startAttempt()
  assert.equal(liveNode(), null, 'the previous attempt was still on screen at the start of the next')
  deliver({ sessionId: SESSION, kind: 'text', text: 'second' })
  assert.equal(liveBody().textContent, 'second', 'the new attempt inherited the old text')
})

test('the panel tolerates every frame the relay can send, including an unknown kind', async () => {
  await idle()
  startAttempt()
  // A tool announcement carries a name; the panel keeps the turn alive without
  // rendering arguments that stream in character by character.
  deliver({ sessionId: SESSION, kind: 'tool', text: 'pwsh' })
  assert.equal(liveNode(), null, 'a tool-only frame drew a live block with nothing in it')

  // Forward compatibility: a kind this build does not know must not throw, and
  // must not wipe what is already there.
  deliver({ sessionId: SESSION, kind: 'text', text: 'kept' })
  deliver({ sessionId: SESSION, kind: 'something-new', text: 'ignored' })
  deliver({})
  deliver(null)
  assert.equal(liveBody().textContent, 'kept')
})

// ─────────────────────────────────────────────────────────────────────────────
// The composer's one action
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run one composer interaction with the clock stopped.
 *
 * The panel arms a five-step transcript re-read after every send and a
 * six-second auto-clear behind every message. Real timers would hold this
 * process open for fifteen seconds after the last assertion and fire a refresh
 * into the middle of a later suite, so they are stubbed for the duration of one
 * call and put back before anything else can run.
 *
 * @param {() => Promise<void>} body - The interaction to run.
 * @returns {Promise<void>} Resolves when the body and the restore are done.
 */
async function onStoppedClock(body) {
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = () => 0
  try {
    await body()
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
}

/** Type into the composer the way a person does, redraw included. */
function type(text) {
  input.value = text
  input.emit('input')
}

/** Press the one button and let the panel finish reacting. */
async function press() {
  sendButton.click()
  await settle()
}

/**
 * Put the panel back on an idle session, whatever ran before this.
 *
 * The stream tests above leave the panel mid-turn on purpose — one of them
 * asserts the waiting line survives between two steps — so the composer has to
 * be given a clean slate rather than assumed to have one.
 *
 * @returns {Promise<void>} Resolves once a turn is either absent or cancelled.
 */
async function settleToIdle() {
  type('')
  if (sendButton.dataset.mode !== 'stop') return
  host.running = false
  host.cancel = { status: 200, payload: { cancelled: true } }
  await press()
}

/** Get the panel into the state a running turn leaves it in. */
async function startTurn() {
  await settleToIdle()
  type('go')
  await press()
  assert.equal(sendButton.dataset.mode, 'stop', 'a send left the composer without a stop button')
}

test('an empty composer keeps the button inert, and typing arms it', async () => {
  await onStoppedClock(() => settleToIdle())

  assert.equal(sendButton.dataset.mode, undefined, 'an idle composer was not drawn as send')
  assert.equal(sendButton.disabled, true, 'send was live with nothing to send')

  type('hello')
  assert.equal(sendButton.disabled, false, 'text in the box did not arm the button')
  assert.equal(sendButton.textContent, '↑', 'the send glyph was replaced by something else')
  assert.equal(sendButton.dataset.mode, undefined, 'typing alone switched the button to stop')

  type('')
})

test('sending swaps the same slot to stop, and the send reached the host', async () => {
  await onStoppedClock(async () => {
    await startTurn()

    assert.equal(host.sent.length, 1, 'the send never reached the host')
    assert.equal(host.sent[0].sessionId, SESSION)
    assert.equal(sendButton.textContent, '■', 'the running button kept the send glyph')
    assert.equal(sendButton.disabled, false, 'the stop button was left disabled')
    assert.equal(input.value, '', 'the box kept the text it had already sent')
  })
})

test('pressing stop cancels that session, and cancels rather than sends', async () => {
  await onStoppedClock(async () => {
    host.cancel = { status: 200, payload: { cancelled: true } }
    const sent = host.sent.length
    const cancelled = host.cancelled.length
    await press()

    assert.equal(host.cancelled.length, cancelled + 1, 'stop did not reach the host')
    assert.equal(host.cancelled.at(-1).action, 'cancel')
    assert.equal(host.cancelled.at(-1).sessionId, SESSION, 'stop cancelled the wrong session')
    assert.equal(host.sent.length, sent, 'pressing stop sent the box contents instead')
  })
})

test('a cancelled turn hands the slot back to send and clears the waiting line', async () => {
  await onStoppedClock(async () => {
    host.running = false
    host.cancel = { status: 200, payload: { cancelled: true } }
    await startTurn()
    assert.ok(transcript.querySelector('.working') !== null, 'the running turn showed no waiting line')

    await press()

    assert.equal(sendButton.dataset.mode, undefined, 'the button stayed on stop after the turn ended')
    assert.equal(sendButton.textContent, '↑')
    assert.equal(transcript.querySelector('.working'), null, 'the waiting line outlived the cancelled turn')
  })
})

test('a refused stop says why and leaves stopping on the table', async () => {
  await onStoppedClock(async () => {
    host.running = true
    host.cancel = { status: 409, payload: { cancelled: false, reason: 'nobody is running here' } }
    await startTurn()
    toast.textContent = ''

    await press()

    assert.equal(sendButton.dataset.mode, 'stop', 'a failed stop pretended the turn was over')
    assert.equal(sendButton.disabled, false, 'the button was left disabled after a refusal')
    assert.ok(
      toast.textContent.includes('nobody is running here'),
      `the refusal reason never reached the user: ${JSON.stringify(toast.textContent)}`,
    )

    // Leave the panel idle for whatever runs next.
    host.running = false
    host.cancel = { status: 200, payload: { cancelled: true } }
    await press()
  })
})

test('return still queues while a turn runs, because the button is not the only way in', async () => {
  await onStoppedClock(async () => {
    host.running = false
    await startTurn()
    const before = host.sent.length

    type('a follow-up')
    input.emit('keydown', { key: 'Enter', shiftKey: false, preventDefault() {} })
    await settle()

    assert.equal(host.sent.length, before + 1, 'Enter was swallowed while a turn was running')
    assert.equal(host.sent.at(-1).text, 'a follow-up')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Copying what the model wrote
// ─────────────────────────────────────────────────────────────────────────────

/** Everything the fake clipboard was handed, in order. */
const clipped = []
/** Flipped to make the clipboard refuse, which a browser is allowed to do. */
let clipRefuses = false

// Node has a `navigator` but no clipboard on it, and nothing else in this run
// reads one, so a single definition here is additive rather than a stub that
// has to be put back.
Object.defineProperty(globalThis.navigator, 'clipboard', {
  configurable: true,
  value: {
    writeText: async (text) => {
      if (clipRefuses) throw new Error('the clipboard said no')
      clipped.push(text)
    },
  },
})

/**
 * Put a given transcript on screen through the path a finished turn takes.
 *
 * A live attempt, then the settled read that replaces it: the panel only gives
 * its live block up once the rows underneath actually changed, so a test that
 * skipped the first half would be asserting against a redraw that never came.
 *
 * @param {object[]} messages - Rows for the host to answer with.
 * @returns {Promise<void>} Resolves once the panel has redrawn.
 */
async function show(messages) {
  turn += 1
  startAttempt()
  deliver({ sessionId: SESSION, kind: 'text', text: `streaming ${turn}` })
  host.messages = messages
  host.running = false
  deliver({ sessionId: SESSION, kind: 'end' })
  await settle()
}

/** The transcript's copy button for `scope`, by class rather than by position. */
function copyButtonIn(scope) {
  return transcript.querySelector(scope).querySelector('.copy')
}

test('a code block can be copied without selecting it by hand', async () => {
  await show([{ kind: 'assistant', text: 'Run this:\n\n```sh\nls -la\n```\n' }])

  const head = transcript.querySelector('.code-block').querySelector('.code-head')
  assert.equal(head.querySelector('.code-lang').textContent, 'sh', 'the head does not name the language')
  const copy = head.querySelector('.copy')
  assert.equal(copy.dataset.copy, 'code')
  assert.equal(copy.textContent, '复制', 'the button has no label, so there is nothing to click')

  clipped.length = 0
  transcript.emit('click', { target: copy })
  await settle()

  assert.deepEqual(clipped, ['ls -la'], 'the code never reached the clipboard')
  assert.equal(copy.textContent, '已复制', 'nothing on screen said the copy had happened')
})

test('copying an answer copies what is rendered, not the markdown behind it', async () => {
  await show([{ kind: 'assistant', text: 'Use **bold** and `code` here.' }])

  const copy = copyButtonIn('.answer-actions')
  assert.equal(copy.dataset.copy, 'answer')

  clipped.length = 0
  transcript.emit('click', { target: copy })
  await settle()

  assert.deepEqual(clipped, ['Use bold and code here.'], 'the reader would have got asterisks and backticks')
})

test('a click that is not on a copy button copies nothing', async () => {
  await show([{ kind: 'assistant', text: 'just words' }])
  clipped.length = 0

  // The transcript is one big delegated target, so anything that bubbles
  // through it arrives here: a click on a link, on the reasoning toggle, or on
  // nothing at all must not put the message on the clipboard.
  transcript.emit('click', { target: sendButton })
  transcript.emit('click', {})
  await settle()

  assert.deepEqual(clipped, [], 'a stray click was treated as a copy')
})

test('a refused clipboard says so instead of looking like it worked', async () => {
  await show([{ kind: 'assistant', text: '```\nnope\n```' }])
  const copy = copyButtonIn('.code-block')
  toast.textContent = ''
  clipRefuses = true
  try {
    transcript.emit('click', { target: copy })
    await settle()
  } finally {
    clipRefuses = false
  }

  assert.equal(copy.textContent, '复制', 'a refused copy announced itself as copied')
  assert.equal(copy.dataset.state, undefined, 'the button was left in its copied state')
  assert.equal(toast.textContent, '复制失败', 'a refused clipboard failed silently')
})
