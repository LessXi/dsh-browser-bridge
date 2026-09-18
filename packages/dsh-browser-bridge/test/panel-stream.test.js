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

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { test, assert } from './harness.js'
import { makeDocument } from './dom-shim.js'
import { zh } from '../../../extension/locales.js'

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
  /** Every `POST {action:'approval'}` body, in order. */
  approvals: [],
  /** The answer `approval` gets, mutated per test. */
  approval: { status: 200, payload: { answered: true } },
  /** Every `POST {action:'create'}` body, in order. */
  created: [],
  /** The answer `create` gets, mutated per test. */
  create: { status: 200, payload: { created: true, sessionId: 'session-new' } },
  /** When set, a `create` hangs until `releaseCreate` is called. */
  holdCreate: null,
  /** Set while a held `create` is waiting; calling it answers. */
  releaseCreate: null,
  /** The active tab the panel sees. `icon` is swapped per test. */
  tab: {
    id: 7,
    url: 'https://dl.acm.org/doi/10.1145/3809166',
    title: 'Network Edge Inference for Large Language Models',
    active: true,
    groupId: 3,
    favIconUrl: 'https://dl.acm.org/favicon.ico',
  },
  /** Extra fields for the health body; `approvalPending` is set per test. */
  health: {},
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
// `start` registers a focus listener, so a panel run without `window` throws
// partway through and never arms a single interval. Omitting it did not make
// these tests stricter — it silently truncated the thing under test.
//
// Aliasing `globalThis` is not enough: Node's global has no `addEventListener`.
// The panel touches exactly three members, so the stub is those three, and the
// focus listeners are recorded rather than dropped so a test can fire one.
/** @type {(() => unknown)[]} */
const focusListeners = []
globalThis.window = {
  addEventListener: (type, listener) => {
    if (type === 'focus') focusListeners.push(listener)
  },
  innerWidth: 400,
  innerHeight: 800,
}
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
    // A tab with an icon, so the context chip has something to draw. The panel
    // reads the active tab from the second `query` call, so the same fixture
    // answers both.
    query: async (filter) => (filter?.active === true ? [host.tab] : [host.tab]),
    // The reply a live content script sends. Returning `{}` here instead was
    // caught by the startup assertion: the panel reads a reply without a string
    // `text` as a dead reporter and tells the user to reload the page, which is
    // the right behaviour and the wrong fixture.
    sendMessage: async () => ({ text: '', url: host.tab.url, title: host.tab.title }),
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
    if (body.action === 'approval') {
      host.approvals.push(body)
      return respond(host.approval.payload, host.approval.status)
    }
    if (body.action === 'create') {
      host.created.push(body)
      // A create can be held open, which is the only way to observe the window
      // where the request is in flight. Every other route here answers at once,
      // and a state that exists for one microtask cannot be asserted on.
      if (host.holdCreate !== null) {
        return new Promise((resolve) => {
          host.releaseCreate = () => resolve(respond(host.create.payload, host.create.status))
        })
      }
      return respond(host.create.payload, host.create.status)
    }
    return respond({ accepted: true })
  }
  if (address.includes('/browser-bridge/health')) return respond({ connected: true, ...host.health })
  return realFetch === undefined ? respond({}) : realFetch(url, options)
}

// Intervals are captured but never run: the panel arms four of them in `start`,
// and a five-second poll firing mid-test would rewrite the transcript under an
// assertion. Recording the callbacks is what lets a test drive one on purpose —
// the health poll is the only way a panel that was not listening when a
// question was asked can still learn about it.
const realSetInterval = globalThis.setInterval
/** @type {(() => unknown)[]} */
const clocks = []
globalThis.setInterval = (body) => {
  clocks.push(body)
  return clocks.length
}

/**
 * Run the panel's health poll once, the way the interval would.
 *
 * @returns {Promise<void>} Resolves once the refresh has settled.
 */
async function pollHealth() {
  if (typeof clocks[1] !== 'function') {
    throw new Error(`health clock missing: captured ${startupClocks}; start said "${startupToast}"`)
  }
  // `start` arms them in order: groups, health, tabs, transcript.
  await clocks[1]()
  await settle()
}

/** Let the panel's promise chains run to a standstill. */
async function settle(turns = 40) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve()
}

/** Hand the panel a message, the way the service worker would. */
function deliver(payload) {
  for (const listener of inbox) listener({ type: 'dsh-assistant-delta', payload })
}

/** Hand the panel any forwarded notification, the way the worker would. */
function post(type, payload) {
  for (const listener of inbox) listener({ type, payload })
}

/** The approval card currently on screen, if any. */
const approvalCard = () => transcript.querySelector('.approval')

/**
 * Re-read the tab list, which is what repaints the context chips.
 *
 * The chips are drawn from `chrome.tabs.query`, so a test that swaps
 * `host.tab.favIconUrl` has to make the panel look again. `start` arms this as
 * one of its four polls; driving the captured callback is the same call the
 * interval would make.
 *
 * @returns {Promise<void>} Resolves once the chips have been repainted.
 */
async function refreshChips() {
  await pollHealth()
  // `refreshTabs` is not one of the four captured clocks, so the status-button
  // refresh is driven directly through the same path the panel uses.
  await clockOf('tabs')
}

/**
 * Run one captured poll by position.
 *
 * `start` arms them in order: groups, health, tabs, transcript.
 *
 * @param {'groups'|'health'|'tabs'|'transcript'} name - Which poll.
 * @returns {Promise<void>} Resolves once that poll has settled.
 */
async function clockOf(name) {
  const at = { groups: 0, health: 1, tabs: 2, transcript: 3 }[name]
  const body = clocks[at]
  if (typeof body !== 'function') throw new Error(`${name} poll was never armed`)
  await body()
  await settle()
}

const liveNode = () => transcript.querySelector('.live')
const liveBody = () => transcript.querySelector('.live-body')

/**
 * The chip describing the current tab.
 *
 * Told apart from the selection chip by its content: the selection chip is the
 * one with a drop button. `querySelectorAll` is used rather than the shorthand
 * `contexts.querySelector('.chip')` because the shim's matcher reads a compound
 * selector as one node's own classes, so a descendant selector like
 * `.chip .label` never matches anything.
 *
 * @returns {object|null} The chip, or null when there is none.
 */
function tabChip() {
  const chips = contexts.querySelectorAll('span')
  return chips.find((chip) => chip.className.includes('chip') && chip.querySelector('button') === null) ?? null
}

/**
 * The chip describing the highlighted text.
 *
 * Told apart from the tab chip by its dismiss button, which is the control that
 * makes "not this time" possible.
 *
 * @returns {object|null} The chip, or null when there is none.
 */
function selectionChip() {
  const chips = contexts.querySelectorAll('span')
  return chips.find((chip) => chip.className.includes('chip') && chip.querySelector('button') !== null) ?? null
}

/** Start a fresh attempt and return nothing; the assertions read the DOM. */
function startAttempt(sessionId = SESSION) {
  deliver({ sessionId, kind: 'start' })
}

// Assigned after the import, because the panel is what mints these nodes.
let transcript
let sendButton
let input
let toast
let newButton
let contexts
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
// `start` arms its intervals only after its opening round of fetches resolves,
// which takes macrotask turns, not just microtask ones. Waiting for the count
// rather than for a duration keeps the stub in place exactly as long as needed.
for (let attempt = 0; attempt < 60 && clocks.length < 4; attempt += 1) {
  await new Promise((resolve) => setImmediate(resolve))
}
globalThis.setInterval = realSetInterval
/** Whatever `start` reported on its way up, captured before tests overwrite it. */
const startupToast = registry.get('toast')?.textContent ?? ''
const startupClocks = clocks.length
transcript = registry.get('transcript')
sendButton = registry.get('send')
input = registry.get('input')
toast = registry.get('toast')
newButton = registry.get('new')
contexts = registry.get('contexts')

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
  // The waiting line is gone once there is text, because the text is now what
  // says the model is working. Keeping both put 「思考中…」 under an answer that
  // was already being written.
  assert.equal(
    transcript.querySelector('.working'),
    null,
    'the waiting line survived into the answer, saying the same thing twice',
  )
  assert.ok(node !== null, 'the first token produced no live block')
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
  // The label and the preview are separate nodes on one line, the way the
  // official panel draws `Thinking` followed by what it is thinking about.
  assert.equal(think.querySelector('.live-think-label').textContent, zh['row.reasoning'])
  assert.equal(think.querySelector('.live-think-text').textContent, 'weighing it up')
  assert.equal(think.hidden, false)
  assert.equal(
    transcript.querySelector('.working'),
    null,
    'the waiting line is still under a preview that already says the model is working',
  )

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
  assert.equal(transcript.querySelector('.live-think').hidden, true)
  assert.equal(transcript.querySelector('.live-think-text').textContent, '')
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
  // A running turn with nothing on screen yet is the case the waiting line
  // exists for, so this is where its liveness is checked.
  assert.ok(transcript.querySelector('.working') !== null, 'a running turn showed no waiting line')

  // A step ended but the turn has not: the host still reports the session as
  // running, so the panel must keep saying so — the live block is dropped on
  // `end`, which puts the waiting line back as the only word.
  host.running = true
  host.messages = [{ kind: 'assistant', text: 'step one' }]
  deliver({ sessionId: SESSION, kind: 'text', text: 'thinking out loud' })
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

/**
 * Take down whatever question is on screen, and forget it on the host too.
 *
 * A card left over from an earlier test would be mistaken for one this test
 * adopted, and the health poll would then be judging the wrong question.
 *
 * @returns {Promise<void>} Resolves once the card is gone.
 */
async function clearApproval() {
  host.health = { approvalPending: [] }
  await pollHealth()
  host.health = {}
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

test('the message is on screen the moment it is sent, not 800ms later', async () => {
  // The panel emptied the composer and showed the waiting row while the sent
  // line existed nowhere. The transcript is re-read on a [800, 2000, 4000,
  // 8000, 15000] ladder, so for the first 800ms — and forever, if the turn died
  // before the first read — the person's own message was simply gone.
  await onStoppedClock(async () => {
    await settleToIdle()
    type('那再帮我列一下常见的坑')
    await press()

    const bubbles = transcript.querySelectorAll('.bubble')
    const shown = bubbles.map((node) => node.textContent)
    assert.ok(
      shown.includes('那再帮我列一下常见的坑'),
      `the sent message is not on screen yet: ${JSON.stringify(shown)}`,
    )
    // And the row it was appended to is a normal user row, so it looks like the
    // record it is standing in for rather than like a special case.
    const row = transcript.querySelectorAll('.row').find((node) => node.dataset.kind === 'user')
    assert.notEqual(row, undefined, 'the echo was drawn outside a user row')
  })
})

test('the echo is replaced by the host\'s own rows, so it cannot become a lie', async () => {
  // The echo is a stand-in. `rows` still holds what the host last sent, so the
  // next read replaces the whole list — which is what keeps a message the host
  // never accepted from lingering on screen as though it had been.
  await onStoppedClock(async () => {
    await settleToIdle()
    type('这一句不会出现在宿主的记录里')
    await press()

    assert.equal(
      transcript.querySelectorAll('.bubble').map((node) => node.textContent).includes('这一句不会出现在宿主的记录里'),
      true,
      'the echo was never drawn, so this test cannot prove anything',
    )

    // The host's transcript does not contain it, and the next read says so.
    host.messages = [{ kind: 'assistant', text: '宿主记得的是别的' }]
    await clockOf('transcript')

    const shown = transcript.querySelectorAll('.bubble').map((node) => node.textContent)
    assert.equal(
      shown.includes('这一句不会出现在宿主的记录里'),
      false,
      'the echo outlived the read that should have replaced it',
    )
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

test('a failed turn is still visible after the panel is reloaded', async () => {
  // The live toast is gone the moment the panel is rebuilt. The host puts the
  // failure in the transcript so a reload, a cold replay, or a second window
  // all still explain why the conversation stops after the user's message.
  //
  // What it says is the sentence for the code, not the provider's message: that
  // message names environment variables and tells the reader to edit a config
  // file, and painting it into a 360px panel is what made a failed turn look
  // like a stack trace left on the screen.
  await show([
    { kind: 'user', text: 'probe' },
    {
      kind: 'failed',
      code: 'MISSING_CREDENTIAL',
      text: 'no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service',
    },
  ])

  const row = transcript.querySelector('.row[data-kind="failed"]')
  assert.notEqual(row, null, 'the failed turn left no row behind')
  assert.equal(row.querySelector('.failure').textContent, zh['error.code.credential'])
  // The provider's words are still reachable, one step down.
  assert.equal(
    row.querySelector('.failure-detail').textContent,
    'no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service',
  )
})

test('a failure the panel has no words for still says something', async () => {
  // An empty row would be the same silence, just harder to notice.
  await show([{ kind: 'failed', text: '' }])

  const row = transcript.querySelector('.row[data-kind="failed"]')
  assert.equal(row.querySelector('.failure').textContent, zh['error.turnFailed'])
})

test('a failure with no code does not paste the provider message', async () => {
  // The case the translation cannot cover. A generic sentence is worse than the
  // provider's own — but it is short, it is in the reader's language, and it
  // does not trail off mid-file-path, and that is the trade this makes.
  await show([{ kind: 'failed', text: 'Some provider wrote a paragraph with no code at all.' }])

  const row = transcript.querySelector('.row[data-kind="failed"]')
  assert.equal(row.querySelector('.failure').textContent, zh['error.turnFailed'])
  assert.equal(row.querySelector('.failure-detail'), null, 'a message with no code was still pasted in')
})

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

// The approval card.
//
// This is the fix for a turn that waits forever: the harness's only shipped
// answerer renders the question in the graphical client, so a turn started from
// the panel and then stopped on an approval question had nobody to answer it
// while the person worked in Chrome. These cases hold the two halves of that
// fix in place — the question arrives and is answerable, and it goes away when
// it is settled at the other surface instead of sitting there looking broken.

/** The buttons on the card, in the order they are drawn. */
function approvalButtons() {
  const card = approvalCard()
  const actions = card?.children.find((child) => child.className === 'approval-actions')
  return actions?.children ?? []
}

/** Put one question on screen the way the worker would. */
async function askApproval(overrides = {}) {
  post('dsh-approval-asked', {
    id: 'panel-1',
    sessionId: SESSION,
    toolName: 'browser_click',
    reason: 'clicking on https://example.com',
    options: ['allowed-once', 'rejected'],
    ...overrides,
  })
  await settle()
}

test('a pending approval is shown as a question with exactly two answers', async () => {
  await onStoppedClock(async () => {
    await settleToIdle()
    host.approvals.length = 0
    await askApproval()

    const card = approvalCard()
    assert.ok(card, 'a waiting turn showed no approval card')
    assert.equal(card.dataset.approvalId, 'panel-1')
    const buttons = approvalButtons()
    assert.deepEqual(
      buttons.map((button) => button.textContent),
      ['允许一次', '拒绝'],
      'the card does not offer exactly allow-once and reject',
    )
  })
})

test('the card says why, and names the tool when there is no reason', async () => {
  await onStoppedClock(async () => {
    await settleToIdle()
    await askApproval()
    const body = approvalCard().children.find((child) => child.className === 'approval-what')
    assert.equal(body.textContent, 'clicking on https://example.com', 'the reason was dropped')

    post('dsh-approval-settled', { id: 'panel-1' })
    await settle()
    await askApproval({ id: 'panel-2', reason: undefined })
    const named = approvalCard().children.find((child) => child.className === 'approval-what')
    assert.equal(named.textContent, '要用 browser_click', 'a reasonless question did not name the tool')
  })
})

test('answering sends the choice, and takes the card away', async () => {
  await onStoppedClock(async () => {
    await settleToIdle()
    host.approvals.length = 0
    host.approval = { status: 200, payload: { answered: true } }
    await askApproval()

    const [allow] = approvalButtons()
    allow.emit('click')
    await settle()

    assert.deepEqual(host.approvals, [{ action: 'approval', id: 'panel-1', outcome: 'allowed-once' }])
    assert.equal(approvalCard(), null, 'the card outlived its answer')
  })
})

test('rejecting sends the refusal rather than allowing the tool', async () => {
  await onStoppedClock(async () => {
    await settleToIdle()
    host.approvals.length = 0
    host.approval = { status: 200, payload: { answered: true } }
    await askApproval({ id: 'panel-7' })

    const [, reject] = approvalButtons()
    reject.emit('click')
    await settle()

    assert.deepEqual(host.approvals, [{ action: 'approval', id: 'panel-7', outcome: 'rejected' }])
    assert.equal(approvalCard(), null)
  })
})

test('a question settled at the other surface takes the card away', async () => {
  await onStoppedClock(async () => {
    await settleToIdle()
    await askApproval({ id: 'panel-9' })
    assert.ok(approvalCard(), 'the card was never drawn')

    // The graphical client answered first. A card still offering buttons for a
    // decision already made is worse than no card: pressing one does nothing,
    // which reads as a broken panel.
    post('dsh-approval-settled', { id: 'panel-9', outcome: 'answered-elsewhere' })
    await settle()

    assert.equal(approvalCard(), null, 'a settled question left its card on screen')
  })
})

test('an answer the host refuses says so and drops the stale card', async () => {
  await onStoppedClock(async () => {
    await settleToIdle()
    host.approval = { status: 409, payload: { answered: false, reason: 'that question is no longer open' } }
    await askApproval({ id: 'panel-11' })

    const [allow] = approvalButtons()
    allow.emit('click')
    await settle()

    assert.match(toast.textContent, /没能作答/, 'a refused answer was silent')
    assert.match(toast.textContent, /no longer open/, 'the host reason was dropped')
    // Stale either way: the question is gone, so nothing is left to answer.
    assert.equal(approvalCard(), null, 'a card for a closed question was left up')
    host.approval = { status: 200, payload: { answered: true } }
  })
})

test('a malformed question is ignored instead of drawn as dead buttons', async () => {
  await onStoppedClock(async () => {
    await settleToIdle()
    post('dsh-approval-asked', { toolName: 'browser_click' })
    await settle()
    assert.equal(approvalCard(), null, 'a question with no id was drawn anyway')

    post('dsh-approval-asked', { id: 'panel-12', sessionId: 42 })
    await settle()
    assert.equal(approvalCard(), null, 'a question with no session was drawn anyway')
  })
})

test('the buttons go inert while an answer is in flight, so one click is one answer', async () => {
  await onStoppedClock(async () => {
    await settleToIdle()
    host.approvals.length = 0
    host.approval = { status: 200, payload: { answered: true } }
    await askApproval({ id: 'panel-13' })

    const [allow] = approvalButtons()
    assert.equal(allow.disabled, false, 'the buttons started out inert')
    allow.emit('click')

    // Mid-flight: the same card, redrawn with its buttons disabled. Without the
    // busy state counting as a change, this redraw is skipped entirely and a
    // second press sends a second answer for a question that is already gone.
    const [stillAllow, stillReject] = approvalButtons()
    assert.equal(stillAllow.disabled, true, 'allow was still pressable mid-flight')
    assert.equal(stillReject.disabled, true, 'reject was still pressable mid-flight')

    stillAllow.emit('click')
    stillReject.emit('click')
    await settle()
    assert.equal(host.approvals.length, 1, 'a second press answered twice')
  })
})

test('a panel opened after the question learns about it from health', async () => {
  await onStoppedClock(async () => {
    await settleToIdle()
    assert.equal(approvalCard(), null, 'the card was on screen before the question existed')

    // `approval/asked` is a notification: delivered to whoever is connected at
    // that instant, never replayed. A panel that opened, reloaded, or was closed
    // while it went out would otherwise show a spinning turn with no way to
    // answer — the same stuck turn, reached by a different route.
    await clearApproval()
    host.health = {
      approvalPending: [{ id: 'panel-20', sessionId: SESSION, toolName: 'browser_click' }],
    }
    await pollHealth()

    const card = approvalCard()
    assert.ok(card, 'a question open on the host was invisible to a freshly opened panel')
    assert.equal(card.dataset.approvalId, 'panel-20')
    assert.deepEqual(
      approvalButtons().map((button) => button.textContent),
      ['允许一次', '拒绝'],
    )
    host.health = {}
  })
})

test('a card is taken away when the host says the question closed', async () => {
  await onStoppedClock(async () => {
    await settleToIdle()
    await clearApproval()
    host.health = { approvalPending: [{ id: 'panel-21', sessionId: SESSION, toolName: 'browser_click' }] }
    await pollHealth()
    assert.ok(approvalCard(), 'the question was never adopted')

    // Answered in the graphical client, and the settled notification was missed
    // because the panel was not the one listening. Health is the recovery path.
    host.health = { approvalPending: [] }
    await pollHealth()
    assert.equal(approvalCard(), null, 'a settled question was left on screen')
    host.health = {}
  })
})

test('a host too old to report open questions does not have its card taken away', async () => {
  await onStoppedClock(async () => {
    await settleToIdle()
    await askApproval({ id: 'panel-22' })
    assert.ok(approvalCard(), 'the card was never drawn')

    // No `approvalPending` field at all is "this host cannot say", not "nothing
    // is open". Reading it as the latter would pull down a card the
    // notification path had legitimately put up.
    host.health = {}
    await pollHealth()
    assert.ok(approvalCard(), 'an older host silently withdrew a live question')

    post('dsh-approval-settled', { id: 'panel-22' })
    await settle()
    assert.equal(approvalCard(), null)
  })
})

test('the panel finishes starting up, with every poll armed', async () => {
  // `start` is a chain of awaits, and a missing global aborts it partway. The
  // panel still drew a transcript, so every test that only touched the
  // transcript passed while all four intervals went unarmed and the focus
  // listener was never registered — the failure was invisible for want of an
  // assertion that startup reached the end at all.
  assert.equal(startupToast, '', 'startup reported a failure')
  assert.equal(startupClocks, 4, `start armed ${startupClocks} poll(s), expected 4`)
  assert.equal(focusListeners.length, 1, 'the focus listener that refreshes the chip was not registered')
})

test('a turn that died says so, rather than going quiet', async () => {
  await onStoppedClock(async () => {
    await settleToIdle()
    await startTurn()
    toast.textContent = ''

    // What a refused provider request looks like by the time it reaches the
    // panel: a `failed` frame carrying the code and the provider's own words.
    // Nothing was committed, so the re-read that normally swaps the live block
    // for parsed markdown finds the same transcript as before — left alone, the
    // shimmer just stops and the person watching is told nothing.
    deliver({
      sessionId: SESSION,
      kind: 'failed',
      code: 'MISSING_CREDENTIAL',
      text: 'no API key for provider route "deepseek-official"',
    })
    await settle()

    // The toast says the translated sentence. A toast is the worst possible
    // place for the raw message: it is gone in seconds and cannot be re-read,
    // selected, or searched for the variable it names.
    assert.equal(
      toast.textContent,
      zh['error.code.credential'],
      `the panel did not translate the failure (toast was "${toast.textContent}")`,
    )
    assert.equal(
      transcript.querySelector('.working'),
      null,
      'the panel is still drawing a turn that is over',
    )
    assert.equal(sendButton.dataset.mode, undefined, 'the composer still offers a stop for a dead turn')
  })
})

test('a failure with no reason of its own still gets words', async () => {
  await onStoppedClock(async () => {
    await settleToIdle()
    await startTurn()
    toast.textContent = ''

    // The host omits `text` when the provider said nothing useful. An empty
    // toast would be the same silence this whole path exists to remove.
    deliver({ sessionId: SESSION, kind: 'failed' })
    await settle()

    assert.equal(
      toast.textContent,
      zh['error.turnFailed'],
      `a reasonless failure said nothing (toast was "${toast.textContent}")`,
    )
  })
})

test('a panel that missed the start is still told the turn died', async () => {
  await onStoppedClock(async () => {
    await settleToIdle()
    // No `start` frame: this is a panel opened, reloaded, or reconnected while
    // the turn was already running. The `live` guard used to swallow the end
    // that followed, so the failure had to be reported before it, not after.
    toast.textContent = ''
    deliver({ sessionId: SESSION, kind: 'failed' })
    await settle()

    assert.equal(
      toast.textContent,
      zh['error.turnFailed'],
      `a panel that missed the start was told nothing (toast was "${toast.textContent}")`,
    )
  })
})

test('a panel built before the host changed still reads the older failure shape', async () => {
  await onStoppedClock(async () => {
    await settleToIdle()
    await startTurn()
    toast.textContent = ''

    // An earlier host reported a dead attempt as an ordinary `end` carrying
    // `failed: true`. A panel is reloaded independently of the host, so both
    // shapes have to be understood or the two halves desynchronise into
    // silence — exactly the class of bug this reporting exists to fix.
    deliver({ sessionId: SESSION, kind: 'end', failed: true })
    await settle()

    assert.equal(
      toast.textContent,
      zh['error.turnFailed'],
      `the older failure shape went unheard (toast was "${toast.textContent}")`,
    )
    assert.equal(transcript.querySelector('.working'), null, 'the panel is still drawing a turn that is over')
  })
})

test('a live turn says it is working once, not twice', async () => {
  // The waiting row and the live block are two renderers for one fact. They
  // used to be on screen together from the first token onward, so a turn in
  // flight read as 「思考中…」 stacked under an answer that was already being
  // written. Each phase now has exactly one thing saying it is working.
  await onStoppedClock(async () => {
    await settleToIdle()
    await startTurn()

    // Phase one: nothing yet. The waiting row is the only word.
    deliver({ sessionId: SESSION, kind: 'start' })
    await settle()
    assert.equal(transcript.querySelectorAll('.working').length, 1, 'the gap before the first token went silent')
    assert.equal(transcript.querySelector('.live'), null, 'a live block was drawn before there was anything to put in it')

    // Phase two: reasoning only. The label carries it, the waiting row goes.
    deliver({ sessionId: SESSION, kind: 'reasoning', text: '看看 markdown.js 认不认分隔行。' })
    await settle()
    assert.equal(transcript.querySelector('.working'), null, 'the waiting row is still there under a live preview')
    const think = transcript.querySelector('.live-think')
    assert.notEqual(think, null, 'the reasoning preview was not drawn')
    assert.equal(think.querySelector('.live-think-label').textContent, zh['row.reasoning'])
    assert.equal(think.querySelector('.live-think-text').textContent, '看看 markdown.js 认不认分隔行。')

    // Phase three: the answer starts. Reasoning gives way to it, exactly as a
    // committed reasoning row does, and the waiting row stays gone.
    deliver({ sessionId: SESSION, kind: 'text', text: '看完了。' })
    await settle()
    assert.equal(transcript.querySelector('.working'), null, 'the waiting row came back when the answer started')
    assert.equal(transcript.querySelector('.live-think').hidden, true, 'reasoning and the answer were on screen together')
    assert.equal(transcript.querySelector('.live-body').textContent, '看完了。')
  })
})

test('the reasoning preview is one line, so it cannot push the answer down', async () => {
  // The official panel renders `Thinking` and its preview on the same line. A
  // label above a paragraph pushes the answer off screen for text the reader is
  // about to stop needing.
  const html = readFileSync(join(here, '..', '..', '..', 'extension', 'sidepanel.html'), 'utf8')
  const rule = html.match(/\.live-think \{([^}]*)\}/)
  assert.notEqual(rule, null, 'the reasoning preview has no style of its own')
  assert.match(rule[1], /white-space:\s*nowrap/, 'the reasoning preview can wrap onto several lines')
  assert.match(rule[1], /text-overflow:\s*ellipsis/, 'a long preview would run off the edge instead of being cut')
  assert.equal(/max-height\s*:\s*4\.5em/.test(rule[1]), false, 'the old multi-line clamp is still there')

  // A caret on an empty line is a cursor with nothing to point at.
  assert.match(html, /\.live-body:empty::after\s*\{\s*display:\s*none/, 'the caret shows during the reasoning phase')
})

test('an IME candidate committed with Enter does not send the message', async () => {
  await onStoppedClock(async () => {
    await settleToIdle()
    host.sent.length = 0
    type('逐字节一致')

    // Writing Chinese, Japanese, or Korean means pressing Enter to accept a
    // candidate. Sending on that keystroke turns every such message into a
    // half-finished line, so this is not an edge case for those users.
    input.emit('keydown', { key: 'Enter', isComposing: true, preventDefault() {} })
    await settle()
    assert.equal(host.sent.length, 0, 'an IME Enter sent the message')

    // The legacy signal for the same thing, for IMEs that do not set the flag.
    input.emit('keydown', { key: 'Enter', keyCode: 229, preventDefault() {} })
    await settle()
    assert.equal(host.sent.length, 0, 'keyCode 229 was treated as a send')

    // A real Enter still sends, so the guard is not simply eating the key.
    input.emit('keydown', { key: 'Enter', preventDefault() {} })
    await settle()
    assert.equal(host.sent.length, 1, 'a plain Enter no longer sends')
    assert.equal(host.sent[0].text, '逐字节一致')
  })
})

test('a second press of new-session cannot orphan a session', async () => {
  // Creating is the one action here that makes something rather than reads it.
  // The host mints a fresh id on every call while the panel can only adopt one,
  // so a double press leaves the extra session in the list with nothing to
  // explain where it came from. Measured against a real host: two calls, two
  // ids, two rows.
  await settleToIdle()
  host.created.length = 0
  host.holdCreate = true
  newButton.click()
  await settle()
  assert.equal(host.created.length, 1, 'the first press never reached the host')

  // The window is the round trip, which is why the request is held open here.
  assert.equal(newButton.disabled, true, 'the button stayed live while a create was in flight')
  assert.equal(newButton.getAttribute('aria-busy'), 'true')

  newButton.click()
  await settle()
  assert.equal(host.created.length, 1, 'a second press asked the host for another session')

  host.releaseCreate()
  await settle()
  host.holdCreate = null
  assert.equal(newButton.disabled, false, 'the button stayed inert after the host answered')
  assert.equal(newButton.getAttribute('aria-busy'), 'false')
})

test('a create the host refuses gives the button back', async () => {
  // The inert state has to be released on every path out, or a refused create
  // leaves the panel with a button nobody can press again.
  await settleToIdle()
  host.created.length = 0
  host.holdCreate = true
  host.create = { status: 500, payload: { created: false, reason: 'no workspace' } }
  toast.textContent = ''
  newButton.click()
  await settle()

  host.releaseCreate()
  await settle()
  host.holdCreate = null
  host.create = { status: 200, payload: { created: true, sessionId: 'session-new' } }

  assert.equal(newButton.disabled, false, 'a refused create left the button inert')
  assert.ok(
    toast.textContent.includes('no workspace'),
    `the refusal never reached the user: ${JSON.stringify(toast.textContent)}`,
  )
})

test('a stale host says so instead of a bare failure', async () => {
  // On a host from before this route existed, `create` answers 400 with no
  // shape the panel understands. That reads as "the button is broken" rather
  // than "the host is old", and the fix is a restart the panel can name.
  await settleToIdle()
  host.create = { status: 400, payload: { error: 'unknown action "create"' } }
  toast.textContent = ''
  newButton.click()
  await settle()
  host.create = { status: 200, payload: { created: true, sessionId: 'session-new' } }

  assert.equal(newButton.disabled, false, 'the button was left inert after a stale-host refusal')
  assert.notEqual(toast.textContent, '', 'a refused create said nothing')
})

test('the current-tab chip leads with the site icon instead of a label', async () => {
  // Measured at 392px with the reported title: the label got 360px and the
  // title wanted 400px, so 「当前标签页 · 」 cost exactly the width the title
  // needed and the chip read `…Large Language Mo…`. The icon says the same
  // thing in 14px.
  await settleToIdle()
  await refreshChips()

  const chip = tabChip()
  assert.notEqual(chip, null, 'the tab chip is gone')

  const label = chip.querySelector('.label')
  assert.notEqual(label, null, 'the tab chip lost its label')
  assert.equal(label.textContent, host.tab.title, 'the chip is still spending its width on a text prefix')
  assert.equal(label.textContent.includes('当前标签页'), false, 'the words came back')

  const icon = chip.querySelector('img')
  assert.notEqual(icon, null, 'the chip draws no site icon')
  assert.equal(icon.getAttribute('src'), host.tab.favIconUrl)
  // The whole name survives on the chip even though the words left the screen,
  // which is what keeps it readable on hover and to a screen reader.
  assert.equal(chip.getAttribute('title'), `${zh['context.tab']} · ${host.tab.title}`)
  assert.equal(chip.getAttribute('aria-label'), `${zh['context.tab']} · ${host.tab.title}`)
})

test('a page with no usable icon still names its tab', async () => {
  // `favIconUrl` is absent on a page that declares none, and Chrome reports an
  // internal URL on its own pages. Neither can be drawn, and neither may leave
  // a broken-image box or an unlabelled chip behind.
  await settleToIdle()
  for (const icon of ['', 'chrome://theme/IDR_EXTENSIONS_FAVICON', undefined, 'chrome-extension://abc/icon.png']) {
    host.tab = { ...host.tab, favIconUrl: icon }
    await refreshChips()
    const chip = tabChip()
    assert.equal(chip.querySelector('img'), null, `an unusable icon was drawn for ${JSON.stringify(icon)}`)
    assert.equal(chip.querySelector('.label')?.textContent, host.tab.title, 'the title was dropped along with the icon')
  }
  host.tab = { ...host.tab, favIconUrl: 'https://dl.acm.org/favicon.ico' }
})

test('an inline data icon is used, because a page may declare one', async () => {
  // The allow-list is by scheme: refusing `data:` would refuse a perfectly
  // loadable image, and this is the case that caught it.
  await settleToIdle()
  host.tab = { ...host.tab, favIconUrl: 'data:image/svg+xml,%3Csvg%2F%3E' }
  await refreshChips()
  assert.equal(
    tabChip().querySelector('img')?.getAttribute('src'),
    'data:image/svg+xml,%3Csvg%2F%3E',
    'a data-URL icon was refused',
  )
  host.tab = { ...host.tab, favIconUrl: 'https://dl.acm.org/favicon.ico' }
  await refreshChips()
})

test('the selection chip shows the text itself, with the whole of it reachable', async () => {
  // The panel sends `currentSelection.text` in full. What is on screen is a
  // truncated view of it, and before this the full text was nowhere at all —
  // the chip had no `title`, so there was no way to read what was about to be
  // sent without sending it. Measured on a 56-glyph Chinese selection at 392px:
  // 27 glyphs visible, and this is what makes the other 29 reachable.
  await settleToIdle()
  const long = '这种剪枝方式会移除模型中的整套架构单元，例如多层感知机中的神经元或通道、注意力头，甚至整层，而非仅针对单个权重。'
  post('dsh-selection-changed', { text: long, url: host.tab.url, title: host.tab.title })
  await settle()

  const chip = selectionChip()
  assert.notEqual(chip, null, 'the selection chip was not drawn')
  const label = chip.querySelector('.label')
  assert.equal(label.textContent, long, 'the chip is not showing the selection text itself')
  assert.equal(
    label.textContent.includes('选中内容'),
    false,
    'the prefix is back, and it costs the width the selection needs',
  )
  assert.equal(chip.getAttribute('title'), `${zh['context.selection']} · ${long}`)
  assert.equal(chip.getAttribute('aria-label'), `${zh['context.selection']} · ${long}`)
  // The mark says what the chip is, so the words do not have to.
  assert.equal(chip.querySelector('.mark')?.textContent, '“')
  assert.equal(chip.querySelector('.mark')?.getAttribute('aria-hidden'), 'true')

  // And the drop control is still there, because it is the only way to say
  // "not this time" short of re-selecting on the page.
  const drop = chip.querySelector('button')
  assert.notEqual(drop, null, 'the selection chip lost its dismiss button')
  assert.equal(drop.getAttribute('aria-label'), zh['action.drop'])
})

test('dismissing the selection takes the chip away, without touching the tab chip', async () => {
  await settleToIdle()
  post('dsh-selection-changed', { text: '结构化剪枝', url: host.tab.url, title: host.tab.title })
  await settle()
  assert.notEqual(selectionChip(), null, 'the selection chip was not drawn')

  selectionChip().querySelector('button').click()
  await settle()
  assert.equal(selectionChip(), null, 'the dismissed chip came back')
  assert.notEqual(tabChip(), null, 'dismissing the selection also removed the tab chip')
})

test('the whole selection survives on the chip, so nothing is sent unseen', async () => {
  // A character-count clamp lived here and was removed: `slice(0, 39)` is 39 CJK
  // glyphs, about twice the width of 39 Latin ones, so it never matched the box
  // it was written for and only made the truncation happen twice — once in JS,
  // once in CSS. The width decides, and CSS is what knows the width.
  await settleToIdle()
  const long = '一二三四五六七八九十'.repeat(12)
  post('dsh-selection-changed', { text: long, url: host.tab.url, title: host.tab.title })
  await settle()
  assert.equal(
    selectionChip().querySelector('.label').textContent,
    long,
    'the chip is clamping the text in JS instead of letting the width decide',
  )
})
