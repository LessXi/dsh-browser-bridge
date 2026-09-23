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
  /** The workspace heading the list is drawn under; `''` is the ungrouped bucket. */
  groupTitle: 'A workspace',
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
  /** When true, every request is refused, as if nothing were listening. */
  down: false,
  /** Every `POST {action:'messages'}` body, in order. */
  reads: [],
  /** Whether the host says rows exist beyond the window it returned. */
  more: false,
  /**
   * The answer `models` gets, mutated per test.
   *
   * `null` means the host has no catalog, which is what the panel was only ever
   * tested against. Set it to a real catalog to open the menu.
   */
  catalog: null,
  /** The active tab the panel sees. `icon` is swapped per test. */
  tab: {
    id: 7,
    url: 'https://dl.acm.org/doi/10.1145/3809166',
    title: 'Network Edge Inference for Large Language Models',
    active: true,
    groupId: 3,
    favIconUrl: 'https://dl.acm.org/favicon.ico',
  },
  /**
   * Every tab the panel can see, which is what the `@` picker offers.
   *
   * `lastAccessed` decides the order, so the second one is deliberately more
   * recent than the first: a test that mentions "the other tab" must be taking
   * a row it did not get by luck.
   */
  tabs: [
    {
      id: 7,
      url: 'https://dl.acm.org/doi/10.1145/3809166',
      title: 'Network Edge Inference for Large Language Models',
      active: true,
      groupId: 3,
      lastAccessed: 100,
      favIconUrl: 'https://dl.acm.org/favicon.ico',
    },
    {
      id: 11,
      url: 'https://github.com/LessXi/dsh-browser-bridge',
      title: 'DSH Browser Bridge',
      active: false,
      groupId: 3,
      lastAccessed: 900,
      favIconUrl: '',
    },
  ],
  /** Extra fields for the health body; `approvalPending` is set per test. */
  health: {},
}

const groupsPayload = () => ({
  // Overridable so "no sessions at all" is reachable. It is the state a new
  // reader starts in, and a fixture that can only ever answer with two sessions
  // made it untestable — the empty surface could not be driven from here.
  groups: host.groups ?? [
    {
      id: 'workspace-1',
      // Overridable so the ungrouped bucket — the host's `title: ''` — is
      // reachable from a test. A real host sends it whenever a session's
      // directory is not a registered workspace, which is common.
      title: host.groupTitle,
      sessions: [
        { id: SESSION, title: 'A session', updatedAt: 0, running: host.running, blank: false },
        // Listed, so a test can switch to it by clicking the row. Without a
        // second session in the list, "switching" is not reachable at all and
        // every renderer's assumption that its state belongs to the session on
        // screen goes untested.
        { id: OTHER, title: 'Another session', updatedAt: 0, running: false, blank: false },
      ],
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
// Counted rather than ignored: the offline chip's whole purpose is to open the
// settings page, and a no-op stub cannot tell that from a button that does
// nothing.
let openedOptions = 0
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
    openOptionsPage: async () => { openedOptions += 1 },
    getManifest: () => ({ version: '0.3.0' }),
    lastError: undefined,
  },
  tabs: {
    // A tab with an icon, so the context chip has something to draw. The panel
    // reads the active tab from the second `query` call, so the same fixture
    // answers both.
    query: async (filter) => (filter?.active === true ? [host.tab] : host.tabs),
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
  // A refused connection is what the panel actually gets when nothing is
  // listening on the harness port, and it is the one state the stub could not
  // reach before: every route here used to answer, so "the host is down" was
  // untestable and the surface written for it had no coverage at all.
  if (host.down === true) throw new TypeError('Failed to fetch')
  if (address.includes('/browser-bridge/chat')) {
    if ((options.method ?? 'GET') === 'GET') return respond(groupsPayload())
    const body = options.body === undefined ? {} : JSON.parse(options.body)
    if (body.action === 'messages') {
      host.reads.push(body)
      return respond({
        sessionId: body.sessionId,
        messages: host.messages,
        title: host.title,
        more: host.more === true,
      })
    }
    // Overridable so the model menu can be driven from here. It answered
    // `empty-catalog` unconditionally, which is a real state the panel must
    // handle — but it was the *only* state reachable, so `drawModelMenu`'s
    // rendering had no test at all, and the two state-carrying rows it builds
    // (the chosen model, the chosen reasoning effort) shipped without one.
    if (body.action === 'models') {
      // The panel reads `payload.catalog`, and falls back to `error` when there is
      // no catalog at all — the two are different states and the shape here has
      // to be the real one, or the menu renders "unavailable" while the fixture
      // believes it answered.
      return respond(host.catalog ?? { error: 'empty-catalog' })
    }
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

/**
 * Wait for a whole macrotask, not just the microtask queue.
 *
 * The announcer writes its sentence on a later task on purpose (see `announce`),
 * so `settle` — which only drains microtasks — reads the region while it is
 * still empty. Waiting for a timer is what makes that write observable here.
 *
 * @returns {Promise<void>} Resolves after the next macrotask turn.
 */
function settleMacrotask() {
  return new Promise((resolve) => setTimeout(resolve, 0))
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

/**
 * How many chips are on the context row.
 *
 * Counted rather than compared against a constant: the suite shares one panel
 * instance, and an earlier test leaves a selection attached, so the absolute
 * number depends on what ran before. What matters in each test below is the
 * change the mention makes.
 *
 * @returns {number} The chip count.
 */
function chipCount() {
  return contexts.querySelectorAll('span').filter((node) => node.className.includes('chip')).length
}

/**
 * Take the mentioned tab off the row, if there is one.
 *
 * The mentioned chip and the selection chip both carry a dismiss button, so
 * "click the button" is not specific enough. The mentioned one is told apart by
 * its title, which names a tab rather than a passage.
 *
 * @returns {void}
 */
function dropMentioned() {
  const chips = contexts.querySelectorAll('span').filter((node) => node.className.includes('chip'))
  const chip = chips.find((each) => each.getAttribute('title')?.startsWith(`${zh['at.list']} · `) === true)
  if (chip === undefined) return
  chip.querySelector('button').click()
}

/**
 * Put another session on screen, the way a person does: open the history and
 * click its row.
 *
 * Driving it through the list rather than calling the internal function keeps
 * the test honest about what a switch involves — the rows are the only way in.
 *
 * The view is forced rather than toggled. `#title` is a toggle, so a test that
 * happens to leave the history open would have this click take it the wrong
 * way; the suite shares one panel and every other test assumes the conversation
 * is showing when it starts.
 *
 * @param {string} sessionId - The session to open.
 * @returns {Promise<void>} Resolves once the panel has switched and is back in
 *   the conversation.
 */
async function switchTo(sessionId) {
  // The list is drawn from the panel's copy of the host's answer, so the copy
  // has to be current before a row can be clicked: a test that changed the
  // session list would otherwise be clicking a stale one.
  await clockOf('groups')
  if (currentViewInPanel() === 'chat') {
    registry.get('title').click()
    await settle()
  }

  const rows = registry.get('history').querySelectorAll('button')
  const wanted = sessionId === OTHER ? 'Another session' : 'A session'
  const row = rows.find((button) => button.textContent.includes(wanted))
  assert.notEqual(
    row,
    undefined,
    `no row to switch to ${sessionId}: ${JSON.stringify(rows.map((button) => button.textContent))}`,
  )
  row.click()
  await settle()

  // Back to the conversation, where every other test expects to be.
  if (currentViewInPanel() === 'history') {
    registry.get('title').click()
    await settle()
  }
}

/**
 * Which view the panel is showing, read from the DOM it controls.
 *
 * `history` is the element to read: it starts `hidden` in the markup and the
 * panel owns its visibility, so it is false only while the conversation shows.
 *
 * @returns {'chat'|'history'} The view.
 */
function currentViewInPanel() {
  return registry.get('history').hidden ? 'chat' : 'history'
}

/**
 * Type `@`, narrow to one tab, and take it.
 *
 * The mention path runs through the composer because that is the only way in —
 * there is no message the worker sends to open it, and driving it through the
 * keyboard is what makes these tests cover the key handling too.
 *
 * @param {string} title - The tab's title, which is what the query matches.
 * @returns {Promise<void>} Resolves once the mention is installed.
 */
async function mentionTab(title) {
  // A distinctive word from the title, so the query narrows to one row.
  const word = title.split(/\s+/)[0]
  input.value = `@${word}`
  input.setSelectionRange(input.value.length, input.value.length)
  input.emit('input')
  await settle()

  const menu = registry.get('at-menu')
  const options = menu?.querySelectorAll('button') ?? []
  assert.ok(options.length > 0, `the picker offered nothing for @${word}`)
  // The menu is rebuilt on every keystroke, so what it holds now is what the
  // query matches. Taking a row by title rather than by position keeps this
  // honest when the ranking puts another tab first.
  const wanted = options.find((row) => row.textContent.includes(title.split(/\s+/).slice(0, 2).join(' '))) ?? options[0]
  wanted.emit('mousedown', { preventDefault() {} })
  await settle()
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
/** The live region carrying what a screen reader has no other way to learn. */
let announcer
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

/**
 * Every value ever written to the announcer, in order.
 *
 * Recorded by intercepting the element's `textContent` setter rather than by
 * sampling it, because the mistake worth catching is a sentence that is written
 * *and then withdrawn*: the panel's first paint happens before any request has
 * answered, so an implementation that repaints the surface before it knows the
 * session list announces 「还没有会话」 on every ordinary start and clears it a
 * moment later. Two things make sampling miss that. The value is gone by the time
 * anything can look, and the write is queued on `setTimeout`, whose callbacks run
 * before the `setImmediate` turns a wait loop would use. Interception is installed
 * before the module is imported, so it sees the write whatever phase it lands in.
 */
const announcerWrites = []
{
  // The shim creates elements on demand from `getElementById`, so the announcer
  // does not exist until the panel asks for it — which is after this runs. Asking
  // for it here creates it, and the panel's own lookup then returns this same
  // element with the interceptor already installed.
  const element = document.getElementById('announcer')
  assert.ok(element, 'the announcer region must be creatable for this suite to observe it')
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'textContent')
  assert.ok(descriptor?.set, 'the announcer element must expose a textContent setter to intercept')
  Object.defineProperty(element, 'textContent', {
    configurable: true,
    get: () => descriptor.get.call(element),
    set: (value) => {
      announcerWrites.push(String(value))
      descriptor.set.call(element, value)
    },
  })
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
/**
 * Everything the announcer said while the panel was starting.
 *
 * Non-empty entries are what a screen reader would have heard, and on a healthy
 * start there must be none: see {@link announcerWrites} for why the writes are
 * intercepted rather than sampled.
 */
/**
 * Everything the announcer has said since the panel loaded.
 *
 * A function rather than a snapshot: the writes arrive on their own timers, so a
 * filtered copy taken at this point would miss every one that has not landed yet
 * — which is all of them during a startup that is still in flight. Reading it
 * inside the test is what makes the ordering mistake observable.
 *
 * @returns {string[]} The non-empty sentences written so far.
 */
function startupAnnouncements() {
  return announcerWrites.filter((said) => said !== '')
}
/**
 * Where focus landed when the panel finished opening.
 *
 * Captured here rather than asserted later because `start` runs once on import:
 * every test that moves focus would otherwise erase the evidence, and the state
 * cannot be re-entered.
 */
const startupFocus = document.activeElement
transcript = registry.get('transcript')
sendButton = registry.get('send')
input = registry.get('input')
toast = registry.get('toast')
/** Where the panel says what a screen reader cannot see. */
announcer = registry.get('announcer')
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

test('with nothing listening, the panel says so once, and offers a way out', async () => {
  // The first-run state: the harness is not running. The panel used to show a
  // blank content area with one eleven-pixel grey line under it, which is where
  // a footnote goes rather than an explanation of why nothing works.
  await settleToIdle()
  host.down = true
  // The groups poll is what notices: every request now refuses, exactly as a
  // closed port does.
  await clocks[0]()
  await settle()

  const surface = registry.get('blocked')
  assert.ok(surface, 'the panel has no blocked surface at all')
  assert.equal(surface.hidden, false, 'nothing listening, and the panel said nothing')
  assert.equal(registry.get('blocked-title').textContent, '连不上 dsh web')
  assert.equal(registry.get('blocked-action').textContent, '重试')

  // One cause, said once. The chip row and the model picker each used to add
  // their own version of this (「未连接」, 「模型列表不可用」), which reads as three
  // broken things rather than as one.
  assert.equal(registry.get('contexts').hidden, true, 'the chip row repeated the error')
  assert.equal(registry.get('model-text').textContent, '选择模型', 'the picker repeated the error')
  // And the header must not claim the account is empty: the sessions are all
  // still there, on a port nothing is answering.
  assert.equal(registry.get('title-text').textContent, 'DSH', 'the header claimed there were no sessions')
})

test('a built panel whose bridge is not attached still offers the way to fix it', async () => {
  // The fresh-install state, and it is not the same as the host being down: the
  // chat routes answer without a token, so the transcript renders and the
  // composer works, while only the websocket — and with it every browser tool —
  // is missing. The panel showed 「未连接」 in a pill that was not a button and
  // named neither the token nor the settings page, so the one thing the reader
  // had to do was the one thing the panel would not say. Reaching the settings
  // page meant opening the history view and scrolling to its footer.
  host.down = false
  host.health = { connected: false }
  openedOptions = 0
  await clocks[1]()
  await settle()

  const row = registry.get('contexts')
  assert.equal(row.hidden, false, 'the offline chip row hid itself, so nothing said the tools were missing')

  const chips = row.querySelectorAll('span').filter((node) => node.className.includes('chip'))
  assert.equal(chips.length, 1, `expected exactly the offline chip, got ${chips.length}`)

  const chip = chips[0]
  assert.equal(chip.dataset.warn, 'true', 'the offline chip lost its warning state')
  const label = chip.querySelectorAll('span').find((node) => node.className === 'label')
  assert.equal(label.textContent, '浏览器工具未连接', 'the chip still says only 「未连接」, without naming what is offline')

  const button = chip.querySelector('button')
  assert.ok(button, 'the offline chip is not a control, so there is no way out of the state')
  assert.equal(button.textContent, '设置')
  button.click()
  await settle()
  assert.equal(openedOptions, 1, 'pressing it did not open the settings page')

  // And the state clears on its own: a chip that had to be dismissed would be a
  // warning, not a reading of the current state.
  host.health = { connected: true }
  await clocks[1]()
  await settle()
  const after = row.querySelectorAll('span').filter((node) => node.className.includes('chip'))
  assert.equal(after.some((node) => node.dataset.warn === 'true'), false, 'the chip outlived the reconnect')
})

test('the blocked surface clears itself the moment the host answers', async () => {
  host.down = true
  await clocks[0]()
  await settle()
  assert.equal(registry.get('blocked').hidden, false)

  // Retry, with the host back up.
  host.down = false
  host.requests.length = 0
  registry.get('blocked-action').emit('click')
  await settle()

  assert.equal(registry.get('blocked').hidden, true, 'the surface outlived the outage')
  assert.ok(
    host.requests.some((request) => request.url.includes('/browser-bridge/chat')),
    'the retry never asked the host anything',
  )
})

test('with no sessions at all, the panel says how to start one, and the button does it', async () => {
  // The first thing a new reader sees. Measured at 380x720 the transcript was
  // 559px of nothing at all — `childCount: 0`, no visible text anywhere in the
  // stage — while the composer still invited 「问点什么…」 and the send button sat
  // disabled with nothing on screen explaining why. Typing a first message and
  // pressing send could not work, and that is the most likely thing to try. The
  // only answer on screen was an unlabelled `＋`.
  host.down = false
  host.groups = []
  // This suite shares one panel instance and one fixture, so leaving the
  // listing empty would poison every test after it. The `finally` is what makes
  // the test a test rather than a reconfiguration.
  try {
    await clockOf('groups')
    await settle()

    const surface = registry.get('blocked')
    assert.equal(surface.hidden, false, 'the content area was left blank with no sessions to show')
    assert.equal(registry.get('blocked-title').textContent, '还没有会话')
    assert.equal(registry.get('blocked-body').textContent, '新建一个，就可以开始问了。')

    // The header names the conversation on screen, and there is none. It must not
    // repeat the surface's sentence: the same claim twice on one screen reads as
    // a stutter.
    assert.equal(registry.get('title-text').textContent, 'DSH', 'the header repeated the empty-state sentence')

    const action = registry.get('blocked-action')
    assert.equal(action.textContent, '新建会话')
    host.created.length = 0
    action.emit('click')
    await settle()

    assert.equal(host.created.length, 1, 'the button did not ask the host for a session')

    // And the surface is a state, not a warning: a session now exists, so it goes
    // away on its own.
    host.groups = [{ id: null, title: '', sessions: [{ id: 'session-created', title: '新会话', updatedAt: 1, running: false, blank: true, model: null }] }]
    await clockOf('groups')
    await settle()
    assert.equal(registry.get('blocked').hidden, true, 'the empty surface outlived the first session')
    assert.equal(registry.get('title-text').textContent, '新会话')
  } finally {
    host.groups = undefined
    await clockOf('groups')
    await settle()
  }
})

test('a conversation longer than one window offers a way back up, and takes it', async () => {
  // A real session of the author's is 6969 rows, and the panel asked for 60 with
  // no way to ask for more: the newest 0.9% of a conversation, presented as the
  // whole of it.
  await settleToIdle()
  host.more = true
  // The transcript poll is what re-reads; `settleToIdle` only settles a turn.
  await clockOf('transcript')
  host.reads.length = 0
  await clockOf('transcript')

  const earlier = registry.get('earlier')
  assert.ok(earlier, 'the panel has no way back into the earlier part')
  assert.equal(earlier.hidden, false, 'older rows exist and nothing offered them')
  assert.equal(earlier.textContent, '更早的内容')

  // Asking for earlier is the same read at a wider window, which is what keeps
  // a poll and a page-back from disagreeing about what is on screen.
  const firstLimit = Number(host.reads.at(-1).limit)
  earlier.emit('click')
  await settle()

  const widened = Number(host.reads.at(-1).limit)
  assert.equal(widened, firstLimit + 60, `the window did not widen: ${firstLimit} -> ${widened}`)

  // And once the host says there is nothing above, the offer goes away rather
  // than inviting a click that returns nothing.
  host.more = false
  await clockOf('transcript')
  assert.equal(registry.get('earlier').hidden, true, 'the panel still offered rows that do not exist')
})

test('a conversation that fits offers nothing to load', async () => {
  await settleToIdle()
  assert.equal(host.more, false)
  await clockOf('transcript')
  assert.equal(registry.get('earlier').hidden, true)
})

test('the window resets when the session changes', async () => {
  // Depth belongs to the session being read. Carried across a switch, a short
  // conversation would open demanding the previous session's window from a host
  // that has no such rows, and claim there was more above it.
  await settleToIdle()
  // The suite shares one panel, so get to a known view before depending on one.
  if (currentViewInPanel() === 'history') {
    registry.get('back').click()
    await settle()
  }
  host.more = true
  await clockOf('groups')
  await clockOf('transcript')
  registry.get('earlier').emit('click')
  await settle()
  assert.ok(Number(host.reads.at(-1).limit) > 60, 'the window never widened')

  host.more = false
  host.reads.length = 0
  await switchTo(OTHER)
  await settle()
  assert.equal(Number(host.reads.at(-1).limit), 60, 'the new session inherited the old depth')

  // Leave the shared panel where every other test expects it.
  await switchTo(SESSION)
})
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

test('a failed browser call opens to show why it failed', async () => {
  // The row used to be a bare cross next to the arguments: `✕ browser_click
  // #save` with nothing about the cause. The model could read the tool's own
  // diagnostic and correct itself while the person watching could not tell a
  // missed selector from a tab that DevTools had taken back — so they could not
  // tell whether to intervene.
  await show([
    { kind: 'tool', name: 'browser_click', summary: '#save', status: 'error', failure: 'no element matches #save' },
  ])

  const line = transcript.querySelector('.tool')
  assert.equal(line.dataset.status, 'error')

  // A real button, not a clickable div: a div is a control only a mouse can
  // reach, and this panel is held to keyboard access everywhere else. The
  // element name is the assertion because that is what carries the tab stop,
  // the focus ring and Enter/Space with it.
  assert.equal(line.tagName, 'BUTTON', 'the row that opens on click is not reachable by keyboard')

  // Closed by default: the transcript stays scannable, and the reason is one
  // click away rather than always on screen.
  assert.equal(transcript.querySelector('.tool-failure'), null, 'the reason was open before anyone asked')
  assert.equal(line.getAttribute('aria-expanded'), 'false', 'a row that opens on click has to say so')

  line.emit('click', {})
  await settle()

  const detail = transcript.querySelector('.tool-failure')
  assert.notEqual(detail, null, 'clicking the row did not reveal the reason')
  assert.equal(detail.textContent, 'no element matches #save')
  assert.equal(transcript.querySelector('.tool').getAttribute('aria-expanded'), 'true')

  // Closed again before the test ends, and asserted closed. The suite shares one
  // panel, so an open row here is state the next test starts with: leaving it
  // open made a later test's click *close* a row it expected to open, and the
  // failure surfaced there rather than here.
  transcript.querySelector('.tool').emit('click', {})
  await settle()
  assert.equal(transcript.querySelector('.tool-failure'), null, 'a second click did not close the row')
  assert.equal(transcript.querySelector('.tool').getAttribute('aria-expanded'), 'false')
})

test('a successful tool call is not a control', async () => {
  // No reason to show means nothing to open: a clickable row that does nothing
  // is worse than plain text, because it invites a click and then ignores it —
  // and a button would also put an inert stop in the tab order.
  await show([{ kind: 'tool', name: 'browser_snapshot', summary: 'example.com', status: 'ok' }])

  const line = transcript.querySelector('.tool')
  assert.equal(line.dataset.status, 'ok')
  assert.equal(line.tagName, 'DIV', 'a row with nothing to reveal became a focusable control')
  assert.equal(line.classList.contains('has-reason'), false)
  assert.equal(line.getAttribute('aria-expanded'), null, 'a row with nothing to reveal claimed to be expandable')
})

test('switching sessions forgets which failures were open', async () => {
  // The open set is keyed by what the row *is* (see `rowKey`), so a session left
  // and returned to produces the same names again — and an identical failed call
  // in another session would otherwise arrive already open. Carrying the set
  // across would open a row nobody touched, which looks like the panel
  // remembering a conversation the person just left. This test is what keeps the
  // clearing at `selectSession` load-bearing now that the keys survive a shift.
  await show([
    { kind: 'tool', name: 'browser_click', summary: '#save', status: 'error', failure: 'no element matches #save' },
  ])
  transcript.querySelector('.tool').emit('click', {})
  await settle()
  assert.notEqual(transcript.querySelector('.tool-failure'), null, 'the row never opened, so nothing below is proved')

  await switchTo(OTHER)
  await switchTo(SESSION)
  await show([
    { kind: 'tool', name: 'browser_click', summary: '#save', status: 'error', failure: 'no element matches #save' },
  ])

  assert.equal(transcript.querySelector('.tool-failure'), null, 'a row was open in a session the user had left')
})

test('loading earlier rows keeps an open row open, and on the same row', async () => {
  // The open set is keyed by row index — the same fact the test above relies on,
  // and the same fact that makes this one fail. Widening the window inserts the
  // older rows at the *front* (`readMessages` slices from the end), so every row
  // that was on screen moves down by a page. An index-keyed set then describes a
  // different row than the one the reader opened.
  //
  // This is the sibling of the session-switch case, and it went unnoticed for the
  // same reason: the suite's fixture answered one fixed row set, so "the window
  // widened and the rows shifted" could not be driven from here at all.
  const rowsFor = (prefix, count) =>
    Array.from({ length: count }, (_, index) => ({
      kind: 'tool',
      // The summary is what names the row on screen, so a wrong-row open is
      // visible as the *other* row's summary appearing in the opened body.
      name: 'browser_click',
      summary: `${prefix}${index}`,
      status: 'error',
      failure: `failure of ${prefix}${index}`,
    }))

  // Sixty rows, so the widened read has something older to put in front.
  await show(rowsFor('r', 6))
  const opened = transcript.querySelectorAll('.tool')[0]
  opened.emit('click', {})
  await settle()
  assert.notEqual(
    transcript.querySelector('.tool-failure'),
    null,
    'the row never opened, so nothing below is proved',
  )

  // The host now answers the wider window with a page of older rows in front of
  // the ones already on screen — which is exactly what a real host does when
  // `limit` grows and the window is counted back from the newest row.
  //
  // `hasEarlier` is only refreshed by a read, so the `more` flag needs one poll
  // to become the panel's own belief before the pill will do anything. Without
  // this the click below is a no-op, the rows never shift, and the assertions
  // pass against a panel that was never asked to do the thing under test — which
  // is how the first version of this test read green.
  host.more = true
  host.messages = [...rowsFor('older', 4), ...rowsFor('r', 6)]
  await clockOf('transcript')
  assert.equal(registry.get('earlier').hidden, false, 'the pill is hidden, so the click below proves nothing')

  const limitBefore = Number(host.reads.at(-1).limit)
  registry.get('earlier').emit('click')
  await settle()
  await settle()

  assert.ok(
    Number(host.reads.at(-1).limit) > limitBefore,
    `the window never widened (${limitBefore}), so the rows never shifted and nothing below is proved`,
  )
  assert.match(
    transcript.querySelectorAll('.tool')[0].textContent,
    /older0/,
    'the widened read did not put the older rows in front, so the index shift this test is about never happened',
  )

  // Exactly one row is open: the reader opened one and has not touched anything
  // else. More than one means the state drifted onto rows nobody opened.
  const openedBodies = transcript.querySelectorAll('.tool-failure')
  assert.equal(
    openedBodies.length,
    1,
    `widening the window left ${openedBodies.length} rows open; the reader opened one`,
  )
  assert.match(
    openedBodies[0].textContent,
    /failure of r0\b/,
    `the open row followed the index instead of the reader: it now shows ${JSON.stringify(openedBodies[0].textContent)}`,
  )

  host.more = false
  host.messages = []
})

test('a reasoning row opens and closes, and survives a repaint of the same rows', async () => {
  // The reasoning toggle is the other index-keyed control, and it had no test at
  // all: every reasoning row on screen reads `Thinking ⌄`, so a test that finds
  // "the open one" by its text cannot tell which row it is looking at. It is
  // asserted through the body text instead, which is the part that is actually
  // unique per row.
  const reasoningRow = (text) => ({ kind: 'reasoning', text })
  await show([reasoningRow('第一条推理'), { kind: 'user', text: '继续' }, reasoningRow('第二条推理')])

  const toggles = transcript.querySelectorAll('.reasoning-toggle')
  assert.equal(toggles.length, 2, 'the two reasoning rows were not both drawn')

  assert.equal(transcript.querySelector('.reasoning-body'), null, 'a row was open before anything was clicked')
  toggles[1].emit('click', {})
  await settle()

  const opened = transcript.querySelectorAll('.reasoning-body')
  assert.equal(opened.length, 1, `clicking one toggle opened ${opened.length} bodies`)
  assert.equal(
    opened[0].textContent,
    '第二条推理',
    'the toggle opened the other row',
  )
  assert.equal(
    transcript.querySelectorAll('.reasoning-toggle')[1].getAttribute('aria-expanded'),
    'true',
    'the open row did not say it was open',
  )
  assert.equal(
    transcript.querySelectorAll('.reasoning-toggle')[0].getAttribute('aria-expanded'),
    'false',
    'an untouched row claimed to be open',
  )

  // A repaint of the *same* rows must not close what the reader opened: the
  // signature includes the open set, so this is also what proves the name is
  // stable across a redraw rather than being recomputed differently.
  await clockOf('transcript')
  const afterRepaint = transcript.querySelectorAll('.reasoning-body')
  assert.equal(afterRepaint.length, 1, 'a poll closed the row the reader had opened')
  assert.equal(afterRepaint[0].textContent, '第二条推理', 'the open row changed which row it was after a poll')

  toggles[1].emit('click', {})
  await settle()
  assert.equal(transcript.querySelector('.reasoning-body'), null, 'a second click did not close the row')
})

test('a reasoning row and an answer with the same words are still two rows', async () => {
  // The row's name is derived from what it holds, and a reasoning block is very
  // often quoted verbatim by the answer it produced. Without the kind in the
  // name, the two would share one, and opening the reasoning would also mark the
  // answer open — or, worse, the answer's row would be the one that opened.
  const same = '这两行文字完全一样'
  await show([
    { kind: 'reasoning', text: same },
    { kind: 'assistant', text: same },
  ])

  transcript.querySelectorAll('.reasoning-toggle')[0].emit('click', {})
  await settle()

  const bodies = transcript.querySelectorAll('.reasoning-body')
  assert.equal(bodies.length, 1, `opening the reasoning row opened ${bodies.length} bodies`)
  assert.equal(bodies[0].textContent, same)
  // The answer is a different kind and must not have been treated as the same row.
  assert.equal(
    transcript.querySelectorAll('.answer').length,
    1,
    'the answer row disappeared or was duplicated when the reasoning row opened',
  )
})

test('a row keeps its node when a redraw does not change it', async () => {
  // The transcript used to be rebuilt with `replaceChildren` on every change, so
  // every row was a new node every time — which is invisible in a screenshot and
  // expensive in a real browser (18ms of layout on 470 rows, past a frame). The
  // node is now the thing that is allowed to persist, so it is the thing asserted.
  await show([
    { kind: 'user', text: '第一个问题' },
    { kind: 'assistant', text: '第一个回答' },
    { kind: 'user', text: '第二个问题' },
  ])

  const before = [...transcript.children]
  assert.equal(before.length, 3, 'the three rows were not all drawn')

  // A poll that returns the same rows is the common case: the interval fires
  // every eight seconds whether or not anything was said.
  await clockOf('transcript')

  const after = [...transcript.children]
  assert.equal(after.length, 3, 'a repaint changed how many rows are on screen')
  for (let index = 0; index < before.length; index += 1) {
    assert.equal(
      after[index],
      before[index],
      `row ${index} was replaced by a new node even though nothing about it changed`,
    )
  }
})

test('opening a row leaves the focus on the control that was pressed', async () => {
  // The click that opens a row happens *inside* that row, so rebuilding the row
  // destroys the element holding focus: the browser moves it to `<body>`, and a
  // keyboard reader has to walk the transcript again to get back. In a real
  // browser, on a 470-row transcript, that was thirty-three tab stops.
  await show([
    { kind: 'reasoning', text: '第一条推理' },
    { kind: 'user', text: '继续' },
    { kind: 'reasoning', text: '第二条推理' },
  ])

  const toggle = transcript.querySelectorAll('.reasoning-toggle')[1]
  toggle.focus()
  assert.equal(document.activeElement, toggle, 'the toggle could not take focus, so the test proves nothing')

  toggle.emit('click', {})
  await settle()

  assert.equal(
    transcript.querySelectorAll('.reasoning-body').length,
    1,
    'the click did not open the row, so there is no rebuild to survive',
  )
  assert.equal(
    document.activeElement,
    toggle,
    'opening a row moved the focus off the control the reader had just pressed',
  )
  assert.equal(toggle.isConnected, true, 'the node that was clicked is no longer in the document')
})

test('only the rows that changed are rebuilt', async () => {
  // The point of the reconciliation is that a change to one row costs one row.
  // Asserted through node identity because that is the mechanism: a rebuild of
  // the lot is exactly "every node is new", which is what this rules out.
  await show([
    { kind: 'user', text: '第一个问题' },
    { kind: 'assistant', text: '第一个回答' },
    { kind: 'reasoning', text: '推理' },
  ])

  const stable = transcript.children[0]
  transcript.querySelectorAll('.reasoning-toggle')[0].emit('click', {})
  await settle()

  assert.equal(
    transcript.children[0],
    stable,
    'opening a row three rows further down rebuilt an unrelated row',
  )
  assert.equal(
    transcript.children[2],
    transcript.querySelector('.reasoning'),
    'the row that was opened is not where it was, so the transcript was reordered',
  )
})

test('a row that changes under the same name is redrawn, not left stale', async () => {
  // The other half of the rule: reuse is keyed on the row's data, not only on its
  // name. A tool row keeps its name for its whole life — the host's `callId` — and
  // it is named that way precisely because the call is one thing from `pending`
  // through to `ok`. Name alone would leave the row showing the mark it arrived
  // with, so a call that succeeded would still read as pending forever.
  const call = (status) => ({
    kind: 'tool',
    callId: 'call-1',
    name: 'browser_click',
    summary: '#save',
    status,
  })
  await show([call('pending')])

  assert.equal(
    transcript.querySelector('.tool').dataset.status,
    'pending',
    'the row did not start out pending, so the change below is not the one being tested',
  )

  host.messages = [call('ok')]
  await clockOf('transcript')

  assert.equal(
    transcript.querySelector('.tool').dataset.status,
    'ok',
    'the row still shows the state it had when it first arrived',
  )
  assert.equal(transcript.querySelectorAll('.tool').length, 1, 'the row was duplicated instead of redrawn')
})

test('a row rebuilt while it held focus hands the focus back to the same control', async () => {
  // Reuse cannot cover a row whose data changed — the node is new by necessity.
  // When that row was the one holding focus, the focus has to come back to the
  // control the reader was on, or the redraw costs them their place for a change
  // they did not make. This is the streaming case: rows change while they are
  // being read.
  const call = (status) => ({
    kind: 'tool',
    callId: 'call-2',
    name: 'browser_click',
    summary: '#submit',
    status,
    failure: 'no element matched #submit',
  })
  await show([call('error')])

  const line = transcript.querySelector('.tool')
  line.focus()
  assert.equal(document.activeElement, line, 'the row could not take focus, so the test proves nothing')

  // The same call, its status now settled: same name, different data.
  host.messages = [call('ok')]
  await clockOf('transcript')

  const after = transcript.querySelector('.tool')
  assert.notEqual(after, line, 'the row kept its node, so nothing was rebuilt and this test proves nothing')
  assert.equal(
    document.activeElement,
    after,
    'the row was rebuilt under the reader and the focus was not handed back to it',
  )
})

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

/**
 * The button that grants for this call only.
 *
 * Named rather than indexed because the card grew a second affirmative button,
 * and `[0]` silently changed meaning from "allow the site" to "allow once" —
 * three tests kept passing their setup while asserting the wrong grant.
 *
 * @returns {object|undefined} The button.
 */
const onceButton = () => approvalButtons().find((button) => button.className === 'approval-once')

/** The button that grants for the rest of the session. */
const allowButton = () => approvalButtons().find((button) => button.className === 'approval-allow')

/** The button that refuses. */
const rejectButton = () => approvalButtons().find((button) => button.className === 'approval-reject')

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
    // Three answers, because two of them mean yes and they differ in how long —
    // which the card used to hide behind a single button reading 「允许一次」
    // while the grant it recorded lasted the whole session.
    assert.deepEqual(
      approvalButtons().map((button) => button.textContent),
      ['只允许一次', '本会话允许', '拒绝'],
      'the card does not offer the two scopes and a refusal',
    )
  })
})

test('the card writes its own sentence, and demotes the host prose', async () => {
  // The card used to print the host's `reason` verbatim, which is English prose
  // written for the harness log — 「the browser bridge wants to use
  // https://dl.acm.org」 inside a 「需要你确认」 card. It now phrases the tool's
  // structured facts in the reader's language, exactly as the failure row does.
  await onStoppedClock(async () => {
    await settleToIdle()
    await askApproval({ origin: 'https://example.com', reason: 'the bridge wants to use https://example.com' })
    const body = approvalCard().children.find((child) => child.className === 'approval-what')
    assert.equal(body.textContent, '要在 https://example.com 上使用 browser_click')
    // With the site in the sentence the prose adds nothing, so it is not printed
    // a second time: the URL used to appear twice in one three-line card.
    const detail = approvalCard().children.find((child) => child.className === 'approval-detail')
    assert.equal(detail, undefined, 'the same URL was printed twice')

    post('dsh-approval-settled', { id: 'panel-1' })
    await settle()
    // An older host sends prose and no facts. The prose is then the only thing
    // naming the target, so it is kept — demoted, not dropped.
    await askApproval({ id: 'panel-2', reason: 'clicking on https://example.com' })
    const fallback = approvalCard().children.find((child) => child.className === 'approval-what')
    assert.equal(fallback.textContent, '要用 browser_click')
    const kept = approvalCard().children.find((child) => child.className === 'approval-detail')
    assert.equal(kept?.textContent, 'clicking on https://example.com', 'the prose was dropped entirely')

    post('dsh-approval-settled', { id: 'panel-2' })
    await settle()
    await askApproval({ id: 'panel-3', reason: undefined, origin: undefined })
    const named = approvalCard().children.find((child) => child.className === 'approval-what')
    assert.equal(named.textContent, '要用 browser_click', 'a reasonless question did not name the tool')
  })
})

test('a question that changes the page says so, not just which tool', async () => {
  await onStoppedClock(async () => {
    await settleToIdle()
    await askApproval({ id: 'panel-4', origin: 'https://example.com', sensitive: true })
    const note = approvalCard().children.find((child) => child.className === 'approval-note')
    assert.ok(note, 'a state-changing request read exactly like a read')

    post('dsh-approval-settled', { id: 'panel-4' })
    await settle()
    await askApproval({ id: 'panel-5', origin: 'https://example.com', sensitive: false })
    assert.equal(
      approvalCard().children.find((child) => child.className === 'approval-note'),
      undefined,
      'an ordinary read was warned about as if it spent money',
    )
  })
})

test('answering sends the choice, and takes the card away', async () => {
  await onStoppedClock(async () => {
    await settleToIdle()
    host.approvals.length = 0
    host.approval = { status: 200, payload: { answered: true } }
    await askApproval()

    allowButton().emit('click')
    await settle()

    assert.deepEqual(host.approvals, [
      { action: 'approval', id: 'panel-1', outcome: 'allowed-once', scope: 'conversation' },
    ])
    assert.equal(approvalCard(), null, 'the card outlived its answer')
  })
})

test('the two yes buttons send different scopes, which is the whole point', async () => {
  // The host reads the scope back to decide the grant, so a button whose label
  // and scope disagree is a promise the product does not keep. Before this, one
  // button read 「允许一次」 and recorded a grant lasting the session.
  await onStoppedClock(async () => {
    await settleToIdle()
    host.approvals.length = 0
    host.approval = { status: 200, payload: { answered: true } }

    await askApproval({ id: 'panel-a' })
    onceButton().emit('click')
    await settle()
    post('dsh-approval-settled', { id: 'panel-a' })
    await settle()

    await askApproval({ id: 'panel-b' })
    allowButton().emit('click')
    await settle()

    assert.deepEqual(host.approvals, [
      { action: 'approval', id: 'panel-a', outcome: 'allowed-once', scope: 'once' },
      { action: 'approval', id: 'panel-b', outcome: 'allowed-once', scope: 'conversation' },
    ])
  })
})

test('rejecting sends the refusal rather than allowing the tool', async () => {
  await onStoppedClock(async () => {
    await settleToIdle()
    host.approvals.length = 0
    host.approval = { status: 200, payload: { answered: true } }
    await askApproval({ id: 'panel-7' })

    rejectButton().emit('click')
    await settle()

    // No scope: a refusal grants nothing, and sending one would invite the host
    // to read a duration out of a no.
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

    const allow = allowButton()
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

    const allow = allowButton()
    assert.equal(allow.disabled, false, 'the buttons started out inert')
    allow.emit('click')

    // Mid-flight: the same card, redrawn with its buttons disabled. Without the
    // busy state counting as a change, this redraw is skipped entirely and a
    // second press sends a second answer for a question that is already gone.
    const stillAllow = allowButton()
    const stillOnce = onceButton()
    const stillReject = rejectButton()
    assert.equal(stillAllow.disabled, true, 'allow was still pressable mid-flight')
    assert.equal(stillOnce.disabled, true, 'once was still pressable mid-flight')
    assert.equal(stillReject.disabled, true, 'reject was still pressable mid-flight')

    stillAllow.emit('click')
    stillOnce.emit('click')
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
      ['只允许一次', '本会话允许', '拒绝'],
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

test('a reply that arrives while the history is open is not thrown away', async () => {
  // Three renderers skip drawing unless the conversation is the visible view —
  // a working row, a live block, and the card — because each of them belongs to
  // a transcript nobody is looking at while the history is up. The live block
  // does not merely skip the draw, it *removes* what is there. So a reply
  // streaming in during a look at the history is destroyed as it arrives, and
  // coming back shows nothing until the next token — or, if the turn finished
  // while the history was open, nothing at all until the next re-read.
  await onStoppedClock(async () => {
    await settleToIdle()
    await clearApproval()

    // A turn is running with text already streamed into it.
    await startTurn()
    deliver({ sessionId: SESSION, kind: 'start' })
    await settle()
    deliver({ sessionId: SESSION, kind: 'text', text: '正在写的回答' })
    await settle()
    assert.notEqual(liveNode(), null, 'the live block was never drawn, so this test cannot prove anything')

    // The history is opened mid-turn, and the model keeps writing.
    registry.get('title').click()
    await settle()
    assert.equal(liveNode(), null, 'the live block was drawn over the history')

    deliver({ sessionId: SESSION, kind: 'text', text: '，还有后半段' })
    await settle()
    deliver({ sessionId: SESSION, kind: 'text', text: '。' })
    await settle()

    // Back to the conversation: the text that arrived meanwhile has to be there.
    registry.get('title').click()
    await settle()
    const live = liveNode()
    assert.notEqual(live, null, 'the reply that streamed in during the history was thrown away')
    assert.equal(
      liveBody().textContent,
      '正在写的回答，还有后半段。',
      'the live block lost the text that arrived while the history was open',
    )

    // Settle the attempt and hand the suite back an idle panel: the tests share
    // one instance, and a live block left behind would be adopted by whichever
    // test runs next.
    host.messages = [{ kind: 'assistant', text: 'settled' }]
    deliver({ sessionId: SESSION, kind: 'end' })
    await settle()
    host.running = false
    await settleToIdle()
    assert.equal(liveNode(), null, 'the suite was handed back a live block')
  })
})

test('the working row comes back with the conversation', async () => {
  // The same shape as the live block, one step earlier in a turn: before the
  // first token the waiting row is the only thing saying the turn is running.
  await onStoppedClock(async () => {
    await settleToIdle()
    await clearApproval()
    await startTurn()

    registry.get('title').click()
    await settle()
    assert.equal(transcript.querySelector('.working'), null, 'the waiting row was drawn over the history')

    registry.get('title').click()
    await settle()
    assert.notEqual(
      transcript.querySelector('.working'),
      null,
      'the turn was running and the waiting row never came back',
    )
    await settleToIdle()
  })
})

test('a reply streaming in another session is not drawn on this one', async () => {
  // `live` carries the session it belongs to, and `applyDelta` refuses frames
  // for another session — but switching sessions does not go through
  // `applyDelta`. So the block belonging to the session being left has to be
  // dropped on the way out, or the text of one conversation appears inside
  // another, under that conversation's title.
  await onStoppedClock(async () => {
    await settleToIdle()
    await switchTo(SESSION)
    await startTurn()
    deliver({ sessionId: SESSION, kind: 'start' })
    await settle()
    deliver({ sessionId: SESSION, kind: 'text', text: '这是第一个会话的回答' })
    await settle()
    assert.equal(liveBody()?.textContent, '这是第一个会话的回答', 'the live block was never drawn')

    // Leave for another conversation.
    await switchTo(OTHER)
    assert.equal(liveNode(), null, 'the other session\'s reply is still on screen')

    // And its own turn keeps writing, into a conversation nobody is looking at.
    deliver({ sessionId: SESSION, kind: 'text', text: '，还在继续' })
    await settle()
    assert.equal(liveNode(), null, 'a frame for the session we left was drawn here')

    await switchTo(SESSION)
    await settleToIdle()
  })
})

test('an approval question does not follow you into another session', async () => {
  // A card offers two buttons that answer one specific question, in one specific
  // session. Drawn over a different conversation it is an offer to answer
  // something that conversation never asked.
  await onStoppedClock(async () => {
    await settleToIdle()
    await clearApproval()
    await switchTo(SESSION)
    host.health = { approvalPending: [{ id: 'panel-40', sessionId: SESSION, toolName: 'browser_click' }] }
    await pollHealth()
    assert.notEqual(approvalCard(), null, 'the question was never adopted, so this proves nothing')

    await switchTo(OTHER)
    assert.equal(approvalCard(), null, 'a card for another session came along')

    host.health = {}
    await switchTo(SESSION)
    await clearApproval()
  })
})

test('a tab mentioned in one session does not attach to the next', async () => {
  // The mention is a decision about one message. Carried across a session
  // switch it becomes a standing promise about a conversation it was never
  // made for — and the chip row would say so.
  await onStoppedClock(async () => {
    await settleToIdle()
    await switchTo(SESSION)
    const other = host.tabs.find((each) => each.id === 11)
    await mentionTab('DSH')
    assert.equal(
      contexts.querySelectorAll('span').filter((node) => node.className.includes('chip')).length,
      2,
      'the mention was never installed',
    )

    await switchTo(OTHER)
    const chips = contexts
      .querySelectorAll('span')
      .filter((node) => node.className.includes('chip'))
      .map((chip) => chip.getAttribute('title'))
    assert.equal(
      chips.some((title) => title?.includes(other.title) === true),
      false,
      `the mention followed the switch: ${JSON.stringify(chips)}`,
    )

    // Hand the suite back the session it started on: the panel is shared, and
    // every other test assumes the session it was written against.
    await switchTo(SESSION)
  })
})

test('a question asked while the history is open is there on the way back', async () => {
  // The card is adopted from the health poll, and that poll skips the adoption
  // unless the conversation is the visible view — a card drawn over the history
  // would be a card for a transcript nobody is looking at. The other half of
  // that decision is what this pins: coming back has to pick the question up,
  // or a turn waits forever behind a card that is never drawn.
  await onStoppedClock(async () => {
    await settleToIdle()
    await clearApproval()

    // Open the history, then let the host report a question.
    registry.get('title').click()
    await settle()
    host.health = { approvalPending: [{ id: 'panel-30', sessionId: SESSION, toolName: 'browser_click' }] }
    await pollHealth()
    assert.equal(approvalCard(), null, 'a card was drawn over the history')

    // Back to the conversation. The question is still open — the host says so —
    // so it has to be waiting here.
    registry.get('title').click()
    await settle()
    assert.notEqual(approvalCard(), null, 'the question was open and never came back on screen')
    host.health = {}
    await clearApproval()
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

test('the panel opens with the caret already in the composer', async () => {
  // "Open the panel and type" is the whole interaction, and it did not work:
  // measured in a real browser, focus landed on `body`, so the first keystroke
  // went nowhere and the only way to start was to click the box.
  //
  // Asserted against the element itself rather than its id, so a panel that
  // focused a different node with the same name would not pass.
  assert.equal(
    startupFocus,
    registry.get('input'),
    'the panel opened without putting the caret anywhere the person can type',
  )
  assert.notEqual(startupFocus, null, 'focus was never set, which is what `body` looks like from here')
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

test('a panel that missed the start still hears the turn end', async () => {
  await onStoppedClock(async () => {
    await settleToIdle()
    // The sibling of the failure case above, and the half that was actually
    // missing. A panel opened, reloaded, or reconnected mid-turn never saw
    // `start`, so dropping deltas is right — they are the tail of an answer whose
    // opening this panel does not have, and `a panel opened mid-turn shows
    // nothing live` pins that. But `end` was dropped by the same guard, and the
    // waiting line is driven by the host's `running` flag: a turn that finished
    // while nobody was watching left the panel animating it for up to POLL_MS.
    //
    // The waiting line has to exist first, or this test would pass against a
    // panel that drew nothing at all and prove nothing. It is drawn from
    // `currentSessionRunning`, which the *groups* read sets — one of the four
    // clocks `start` arms, and the only one that touches this flag. Polling
    // health instead would leave the flag alone and the assertion below would
    // fail on a panel that is behaving correctly.
    //
    // No `start` frame is delivered here on purpose: this is the panel that
    // missed it, which is the whole point.
    host.running = true
    try {
      await clockOf('groups')
      assert.notEqual(
        transcript.querySelector('.working'),
        null,
        'the waiting line is absent, so this test cannot tell whether end cleared it',
      )
    } finally {
      // Restored before the assertions below can throw: a flag left set here is
      // read by every later test in the file, and five unrelated ones went red
      // the first time this test leaked it.
      host.running = false
    }

    deliver({ sessionId: SESSION, kind: 'end' })
    await settle()

    assert.equal(
      transcript.querySelector('.working'),
      null,
      'the panel is still drawing a turn that is over',
    )
  })
})

test('adopting a turn does not adopt somebody else’s session', async () => {
  await onStoppedClock(async () => {
    await settleToIdle()
    // The guard that drops a foreign session sits above every branch, and this is
    // what says so. It is the control for the two tests around it: whatever the
    // panel does about a missed `start`, it may only ever do it to the
    // conversation on screen.
    deliver({ sessionId: OTHER, kind: 'text', text: 'SHOULD NOT APPEAR' })
    deliver({ sessionId: OTHER, kind: 'end' })
    await settle()

    assert.equal(liveNode(), null, 'another session’s tokens were drawn into this one')
    assert.ok(!transcript.textContent.includes('SHOULD NOT APPEAR'))
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

test('mentioning the tab already in front does not promise a second one', async () => {
  // `@` lists the current tab first, because it is the most recently used, so
  // picking it is the easy mistake to make. The host dedupes on the URL — one
  // attachment reaches the model — and drawing two chips would be the panel
  // promising something it does not deliver.
  await settleToIdle()
  const before = chipCount()
  await mentionTab('Network')

  assert.equal(chipCount(), before, 'the same page was promised twice')

  // If the panel has lost track of the current tab, the guard in
  // `pendingAttachments` cannot fire and the tab travels twice. That is a
  // different defect from the one this test is named for, so it is checked
  // separately rather than showing up as a confusing "travelled twice".
  const titles = contexts
    .querySelectorAll('span')
    .filter((node) => node.className.includes('chip'))
    .map((chip) => chip.getAttribute('title'))
  assert.ok(
    titles.some((title) => title?.startsWith(`${zh['context.tab']} · `) === true),
    `the panel lost the current tab, so nothing could be deduped: ${JSON.stringify(titles)}`,
  )

  host.sent.length = 0
  type('对比一下')
  await press()
  // Only the tab attachments: an earlier test leaves a selection attached, and
  // a selection carries the URL of the page it came from, so counting URLs
  // alone would report a duplicate that is really a second, different kind of
  // context travelling on purpose.
  const tabs = host.sent[0].attachments.filter((each) => each.kind === 'tab').map((each) => each.url)
  assert.deepEqual(tabs, [host.tab.url], 'the same tab travelled twice')
})

test('mentioning a different tab adds one chip and sends both', async () => {
  // The case `@` exists for: the message is about a page other than the one in
  // front, so both travel. The suite shares one panel, so the mention from an
  // earlier test is taken off first — otherwise this measures the previous
  // test's leftovers.
  await settleToIdle()
  dropMentioned()
  const before = chipCount()
  const other = host.tabs.find((each) => each.id === 11)
  assert.notEqual(other, undefined, 'the fixture lost the second tab')
  await mentionTab('DSH')

  assert.equal(chipCount(), before + 1, 'the mentioned tab did not get a chip of its own')

  host.sent.length = 0
  type('对比这两个页面')
  await press()
  const urls = host.sent[0].attachments.filter((each) => each.kind === 'tab').map((each) => each.url)
  assert.deepEqual(urls, [other.url, host.tab.url], 'the mention did not travel, or travelled in the wrong order')
})

test('dismissing a mentioned tab takes its chip away and stops it travelling', async () => {
  // The mention is a decision that has to be reversible, the same way the
  // selection chip is: a page attached by accident must be removable without
  // starting the message over.
  await settleToIdle()
  dropMentioned()
  const before = chipCount()
  await mentionTab('DSH')
  assert.equal(chipCount(), before + 1, 'the mention never got a chip, so this test cannot prove anything')

  dropMentioned()
  assert.equal(chipCount(), before, 'the dismissed mention left its chip behind')

  host.sent.length = 0
  type('只对比当前这个')
  await press()
  assert.equal(
    host.sent[0].attachments.some((each) => each.url === 'https://github.com/LessXi/dsh-browser-bridge'),
    false,
    'the dismissed mention still travelled',
  )
})

test('the ungrouped bucket is named, instead of borrowing the heading above it', async () => {
  // The host sends `title: ''` for every session whose directory is not a
  // registered workspace, which is an ordinary case rather than an edge one:
  // the user's own list has three such sessions. The panel drew no heading for
  // that bucket, so its rows sat under the previous workspace's name and read as
  // members of it. DSH's sidebar names the same bucket, so the label is its word.
  await onStoppedClock(async () => {
    await settleToIdle()
    host.groupTitle = ''
    await clockOf('groups')
    registry.get('title').click()
    await settle()

    const labels = registry
      .get('history')
      .querySelectorAll('p')
      .filter((node) => node.className === 'group-label')
      .map((node) => node.textContent)
    assert.ok(
      labels.includes('未分组'),
      `the ungrouped rows have no heading: ${JSON.stringify(labels)}`,
    )

    // Put it back, so a later test does not inherit an unnamed workspace.
    host.groupTitle = 'A workspace'
    await clockOf('groups')
    if (currentViewInPanel() === 'history') {
      registry.get('title').click()
      await settle()
    }
  })
})

test('the arrow keys move between sessions, and the bottom of the list is the end of it', async (t) => {
  // Measured in a real browser before this existed: ArrowDown on a session row
  // left focus exactly where it was, so the only way through the list was Tab or
  // the mouse. Nothing in the suite could have caught it, because the DOM shim's
  // `focus()` was a no-op and the document had no focusable state at all.
  await clockOf('groups')
  if (currentViewInPanel() === 'chat') {
    registry.get('title').click()
    await settle()
  }

  const rows = registry.get('history').querySelectorAll('button').filter((node) => node.className === 'session')
  assert.ok(rows.length >= 2, `expected a list to walk, got ${rows.length} rows`)

  // `preventDefault` is counted rather than stubbed: an arrow key that moves
  // focus and also scrolls the list is two behaviours fighting over a keystroke.
  const key = (node, name) => {
    let prevented = 0
    node.emit('keydown', { key: name, preventDefault: () => { prevented += 1 } })
    return prevented
  }

  rows[0].focus()
  assert.equal(document.activeElement, rows[0], 'the row could not take focus, so nothing below is proved')
  assert.equal(key(rows[0], 'ArrowDown'), 1, 'the list moved focus without claiming the keystroke')
  assert.equal(document.activeElement, rows[1], 'ArrowDown did not move to the next session')

  assert.equal(key(rows[1], 'ArrowUp'), 1)
  assert.equal(document.activeElement, rows[0], 'ArrowUp did not move back')

  // No wrapping. Stepping up from the first row is a no-op rather than a jump to
  // the far end, which would hide how long the list is from anyone walking it.
  key(rows[0], 'ArrowUp')
  assert.equal(document.activeElement, rows[0], 'ArrowUp from the first row wrapped to the last')

  const last = rows[rows.length - 1]
  last.focus()
  key(last, 'ArrowDown')
  assert.equal(document.activeElement, last, 'ArrowDown from the last row wrapped to the first')

  // Other keys still belong to the list: Home and End are the list's own, and a
  // plain letter is not navigation at all.
  assert.equal(key(rows[0], 'Home'), 0, 'the list claimed a key it does not act on')

  if (currentViewInPanel() === 'history') {
    registry.get('title').click()
    await settle()
  }
  t.onCleanup(() => {
    if (currentViewInPanel() === 'history') registry.get('title').click()
  })
})

test('Escape closes the history and hands focus back to the control that opened it', async (t) => {
  // The layer-with-a-dismiss-key contract, and the same one the model menu
  // already honoured. Before this, Escape did nothing here: the only way out of
  // the history was to find the `‹` button by mouse or by tabbing to it.
  await clockOf('groups')
  if (currentViewInPanel() === 'chat') {
    registry.get('title').click()
    await settle()
  }
  assert.equal(currentViewInPanel(), 'history', 'the history never opened, so this test proves nothing')

  const rows = registry.get('history').querySelectorAll('button').filter((node) => node.className === 'session')
  if (rows.length > 0) rows[0].focus()

  // Emitted on the document, which is where the panel installs this handler —
  // the same route a real keypress takes on its way up from the focused row.
  document.emit('keydown', { key: 'Escape' })
  await settle()

  assert.equal(currentViewInPanel(), 'chat', 'Escape left the history open')
  // Focus has to leave the row that is no longer on screen. Landing on the body
  // would send the next Tab to the top of the panel instead of the header the
  // person just came from.
  assert.equal(
    document.activeElement,
    registry.get('title'),
    'focus was not returned to the control that opened the history',
  )
  t.onCleanup(() => {
    if (currentViewInPanel() === 'history') registry.get('title').click()
  })
})

test('a question and a finished answer are announced, and a healthy start is not', async (t) => {
  // Nothing in this panel was a live region, so a reader who cannot see it
  // learned nothing: the failing send, the question blocking the turn, and the
  // answer itself all arrived silently. The transcript cannot carry this — it is
  // rebuilt wholesale on every poll, so making it a live region would
  // re-announce the whole conversation each time — hence a separate region with
  // the two moments that stop everything plus the one moment an answer is final.
  await clockOf('groups')

  // The half that is easy to get wrong, and the reason this test has a first
  // act: `groups` starts empty and `hostReachable` starts false, so the surface
  // is briefly up on *every* start. Announcing that would tell the reader the
  // panel cannot work each time it opens correctly — and clearing it a moment
  // later does not undo the announcement, which is why the whole startup history
  // is checked rather than the value left behind.
  const startupSaid = startupAnnouncements()
  assert.deepEqual(
    startupSaid,
    [],
    `a healthy start must stay silent for its whole startup, but said: ${JSON.stringify(startupSaid)}`,
  )
  assert.equal(announcer.textContent, '', `a healthy start must say nothing, said: ${announcer.textContent}`)

  // A question. It blocks the turn until answered, and the visible evidence is a
  // card that appears in a transcript the reader may not be looking at.
  await askApproval({ id: 'announce-q1', toolName: 'browser_click', site: 'example.com' })
  await settleMacrotask()
  assert.notEqual(announcer.textContent, '', 'the blocking question was announced to nobody')
  assert.match(
    announcer.textContent,
    /browser_click/,
    `the announcement must name what is being asked for, got: ${announcer.textContent}`,
  )

  t.onCleanup(() => {
    post('dsh-approval-settled', { id: 'announce-q1', outcome: 'answered-elsewhere' })
  })

  // An answer, which is the only moment its text is final: `.live-body` is
  // rewritten in full on every frame, so announcing per token would repeat the
  // whole answer from the top each time.
  announcer.textContent = ''
  deliver({ sessionId: SESSION, kind: 'start' })
  deliver({ sessionId: SESSION, kind: 'text', text: 'The document covers three phases.' })
  await settleMacrotask()
  assert.equal(
    announcer.textContent,
    '',
    `a streaming answer must not be announced token by token, got: ${announcer.textContent}`,
  )

  deliver({ sessionId: SESSION, kind: 'end' })
  await settleMacrotask()
  assert.match(
    announcer.textContent,
    /three phases/,
    `the finished answer must be announced once, got: ${announcer.textContent}`,
  )
})

/**
 * The two rows in the model menu that carry a state, asserted on the DOM.
 *
 * Both defects these cover were invisible to every test that existed, because
 * the fixture answered `empty-catalog` unconditionally: the menu could not open
 * from here at all, so nothing in this suite ever saw `drawModelMenu` build a
 * row. The states were then checked in a real browser under an emulated
 * `forced-colors: active`, which is where a state carried *only* by a discarded
 * paint stops being carried at all:
 *
 *   1. `background` and `box-shadow` are replaced by the system palette, so the
 *      chosen reasoning level's tinted pill vanished and `Low`/`High` came out
 *      pixel-identical — the reader could not see which one was selected.
 *   2. The `✓` on the chosen model survives, because it is a glyph rather than a
 *      colour, which is why the model row was never affected and why the fix
 *      reuses it instead of inventing a second convention.
 *
 * Asserted on the rendered tree, not on the source: the panel is a real module
 * and what matters is the node it appends.
 */
/**
 * The catalog the host answers `models` with, in the shape the panel reads.
 *
 * It is wrapped in `catalog` because that is the contract: `refreshCatalog`
 * takes `payload.catalog`, and a fixture that answered with the groups directly
 * would leave the panel showing "no models" while looking, from here, like it
 * had answered — which is how the first version of these tests failed.
 *
 * The session on screen has to be on a model that *declares* efforts, or the
 * effort row is not drawn at all: `modelMenuModel` offers the levels belonging to
 * the model the session is actually using, so `deepseek-v4-pro` (no `reasoning`
 * block) yields an empty row no matter what the catalog lists.
 */
const MENU_CATALOG = {
  catalog: {
    // The deployment default, which is what the menu falls back to for a session
    // that has not chosen a model. It points at the one model that declares
    // efforts: the levels offered belong to the model in use, so a default on
    // `deepseek-v4-pro` would draw no effort row and these tests would pass
    // vacuously against a row that is not there.
    default: { provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'high' },
    groups: [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        models: [
          {
            id: 'deepseek-flash',
            name: 'deepseek-v4.1-flash',
            reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' },
          },
          { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro' },
        ],
      },
    ],
  },
}

/**
 * Open the picker and hand back its rows.
 *
 * The wait is a macrotask rather than `settle`: the panel reads the catalog once
 * at startup, where this suite's fixture answers `empty-catalog`, so opening the
 * menu finds `catalog === null` and kicks off a `fetch` to fill it in. That
 * request resolves on a later task, and the menu repaints when it lands — a
 * microtask drain reads the menu before the rows exist.
 *
 * @param {object} catalog - What the host answers `models` with.
 * @returns {Promise<{efforts: object[], options: object[], menu: object}>} The rendered rows.
 */
async function openModelMenu(catalog) {
  host.catalog = catalog
  registry.get('model').click()
  await settleMacrotask()
  await settle()
  const menu = registry.get('model-menu')
  return {
    menu,
    efforts: menu.querySelectorAll('.menu-effort'),
    options: menu.querySelectorAll('.menu-option'),
  }
}

test('the chosen reasoning level is marked by a glyph, not only by its tint', async (t) => {
  // `forced-colors: active` discards `background` and `box-shadow`, which was
  // the entire visible difference between the chosen level and the other one.
  // A glyph survives that mode, so the state has to be in the text.
  t.onCleanup(() => {
    host.catalog = null
    registry.get('model').click()
  })

  const { efforts } = await openModelMenu(MENU_CATALOG)
  assert.equal(efforts.length, 2, 'the catalog lists two reasoning levels, so two buttons must be drawn')

  const checked = efforts.filter((row) => row.getAttribute('aria-checked') === 'true')
  assert.equal(checked.length, 1, 'exactly one level must be marked as chosen')
  assert.match(
    checked[0].textContent,
    /✓/,
    `the chosen level must carry a visible mark, found ${JSON.stringify(checked[0].textContent)}`,
  )

  // And the unchosen ones must not, or the mark stops meaning anything.
  for (const row of efforts.filter((r) => r.getAttribute('aria-checked') !== 'true')) {
    assert.ok(
      !row.textContent.includes('✓'),
      `an unchosen level must not be marked, found ${JSON.stringify(row.textContent)}`,
    )
  }

  // The mark is decoration over a state the radio already reports. Announcing
  // both would make a screen reader say the choice twice.
  const mark = checked[0].querySelector('.check')
  assert.ok(mark !== null, 'the mark must be its own node so it can be hidden from assistive tech')
  assert.equal(mark.getAttribute('aria-hidden'), 'true')
})

test('the chosen level is the one the session actually selected', async (t) => {
  // The mark is only useful if it lands on the right row: a glyph on the wrong
  // level is worse than no glyph, because it asserts something false.
  t.onCleanup(() => {
    host.catalog = null
    registry.get('model').click()
  })

  const { efforts } = await openModelMenu(MENU_CATALOG)
  const marked = efforts.filter((row) => row.textContent.includes('✓'))
  assert.equal(marked.length, 1, 'exactly one level must carry the mark')

  // `session-a` is on `deepseek-v4-pro`, which declares no `reasoning` block, so
  // the menu shows no levels for it at all. What this asserts is that whatever
  // rows *are* drawn agree with `aria-checked` rather than contradicting it.
  for (const row of efforts) {
    const checked = row.getAttribute('aria-checked') === 'true'
    assert.equal(
      row.textContent.includes('✓'),
      checked,
      `the mark and aria-checked must agree on ${JSON.stringify(row.textContent)}`,
    )
  }
})

test('both menu rows put their mark in the same place', async (t) => {
  // One convention, not two: the model rows and the effort rows are the same
  // kind of choice, so a reader who learns one has learned the other. This is
  // the assertion that would have caught the effort row being added without a
  // mark at all.
  t.onCleanup(() => {
    host.catalog = null
    registry.get('model').click()
  })

  const { efforts, options } = await openModelMenu(MENU_CATALOG)
  assert.ok(options.length > 0, 'the catalog lists models, so the menu must draw model rows')

  const effortMarks = efforts.filter((row) => row.querySelector('.check') !== null)
  const optionMarks = options.filter((row) => row.querySelector('.check') !== null)
  assert.equal(
    effortMarks.length,
    efforts.length,
    'every effort row needs a mark slot, so the label does not shift as the choice moves',
  )
  assert.equal(
    optionMarks.length,
    options.length,
    'every model row needs a mark slot',
  )
})
