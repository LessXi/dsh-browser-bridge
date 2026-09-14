/**
 * The side panel's live-output path, driven for real.
 *
 * `test/stream.test.js` proves the host coalesces and the wire carries the
 * notification. It cannot prove the panel does anything useful with it, and the
 * gap between those two points is where this feature would actually be broken:
 * a delta for the wrong session, a second live block per token, text that never
 * gives way to the committed row, markdown parsed mid-stream.
 *
 * So the panel module is imported into the DOM shim in `test/dom-shim.js` and
 * the messages the service worker would forward are handed to it directly.
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
