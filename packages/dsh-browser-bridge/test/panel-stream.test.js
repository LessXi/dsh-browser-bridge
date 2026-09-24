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
import { findRows } from '../lib/chat.js'

const here = dirname(fileURLToPath(import.meta.url))
const extensionDir = join(here, '..', '..', '..', 'extension')

const SESSION = 'session-16ac81ea-14e0-4086-922a-57c74a66818c'
const OTHER = 'session-0f1e2d3c-4b5a-4c6d-8e7f-901234567890'

/**
 * The browser's storage, kept between the "openings" a test simulates.
 *
 * Shared rather than rebuilt per test because that is the point of it: a draft
 * written while one panel was open is read back when the next one starts, and
 * a per-test store could never show that.
 */
const storage = makeStorage()

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
  /** The answer `send` gets, mutated per test that cares about a refusal. */
  send: { status: 200, payload: { accepted: true } },
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
  /**
   * What the host answers about context occupancy, or undefined for "the log
   * never said". Mutated per test that cares.
   */
  occupancy: undefined,
  /** Every `POST {action:'search'}` body, in order. */
  searches: [],
  /**
   * Every `POST {action:'search-sessions'}` body, in order.
   *
   * Kept apart from `searches` because they are two different questions: one
   * finds a phrase inside the conversation on screen, the other finds which
   * conversation it was said in. A shared array could not tell them apart, and
   * the panel sends both from the same text field depending on the view.
   */
  sessionSearches: [],
  /**
   * What the host answers a cross-session search with.
   *
   * `null` means this profile has no index, which is a real state — the harness's
   * query service is optional — and the panel draws it differently from an empty
   * result. Defaulting to an empty-but-available answer would make every test
   * claim an index the stub does not stand for.
   */
  sessionSearch: null,
  /**
   * How many requests have reached the chat endpoint, counted at the door.
   *
   * The polls are the subject of their own tests: whether a tick starts a
   * second request while the first is unanswered is exactly the question, so it
   * has to be counted on arrival rather than inferred from what the panel drew.
   */
  chatRequests: 0,
  /**
   * A promise the next chat request waits on before it answers.
   *
   * Same purpose as `holdSearch`, for the polls: it takes the timing of an
   * answer into the test's hands so "the host is slower than the interval" is a
   * fact the test controls rather than a race it hopes for. `null` answers
   * immediately.
   */
  holdNextChat: null,
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
  /**
   * Answer the groups poll with a 200 whose body has no `groups` key.
   *
   * That is what a host running older code looks like from here: it understood
   * the request well enough to answer, but not well enough to include the list.
   * The panel cannot tell that apart from an empty conversation list by the
   * status code alone, which is exactly why the distinction needs a fixture —
   * without one, "the host is older than the panel" is not reachable from a test.
   */
  staleHost: false,
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

/**
 * The session the panel is already on, as a row a test can put in its own list.
 *
 * A test that replaces `host.groups` with a list that does not contain the
 * current session is not just changing what is displayed: the panel adopts a
 * session it finds and keeps it, so every later test runs against a session it
 * never chose. Measured the hard way — the draft test forty tests further down
 * failed because its draft was written under `panelDraft:session-poll-0`.
 * Including this row keeps the panel where it was.
 *
 * @returns {object} A session row with the suite's current session id.
 */
function sessionRow() {
  return { id: SESSION, title: 'A session', updatedAt: 0, running: false, blank: false }
}

const { document, registry } = makeDocument()
const inbox = []

globalThis.document = document
// The CSS Custom Highlight registry, which the search marks the needle with. It
// is a Map on the real platform too, so recording what the panel registers is the
// same shape as asking it — and without a registry here, `drawNeedle` returns
// early and every assertion about the marking would be about nothing.
globalThis.CSS = { highlights: new Map() }
/** The ranges the panel most recently registered under a name. */
const highlightOf = (name) => [...(globalThis.CSS.highlights.get(name) ?? [])]
globalThis.Highlight = class Highlight {
  constructor(...ranges) {
    this.ranges = ranges
  }
  [Symbol.iterator]() {
    return this.ranges[Symbol.iterator]()
  }
}
// `start` registers a focus listener, so a panel run without `window` throws
// partway through and never arms a single interval. Omitting it did not make
// these tests stricter — it silently truncated the thing under test.
//
// Aliasing `globalThis` is not enough: Node's global has no `addEventListener`.
// The panel touches three members, so the stub is those three, and the listeners
// are recorded by type rather than dropped, so a test can fire one.
/** @type {(() => unknown)[]} */
const focusListeners = []
/**
 * Every other kind of window listener, by event name.
 *
 * This used to keep `focus` and discard the rest, which made a `resize` handler
 * unreachable from a test: the panel could register one, or stop registering
 * one, and no assertion could tell the difference. A stub that drops the thing
 * under test is worse than no stub, because the suite still reports green.
 *
 * @type {Map<string, ((event?: unknown) => unknown)[]>}
 */
const windowListeners = new Map()
// Counted rather than ignored: the offline chip's whole purpose is to open the
// settings page, and a no-op stub cannot tell that from a button that does
// nothing.
let openedOptions = 0
globalThis.window = {
  addEventListener: (type, listener) => {
    if (type === 'focus') focusListeners.push(listener)
    const existing = windowListeners.get(type) ?? []
    existing.push(listener)
    windowListeners.set(type, existing)
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
  storage: { local: storage },
}

/**
 * `chrome.storage.local`, as far as the panel can tell.
 *
 * A store that actually keeps things, because the panel persists the composer's
 * draft and the question that matters is whether it is still there afterwards.
 * An answer-everything stub cannot be asked that: it hands back the defaults it
 * was given, so a draft that was never written reads back the same as one that
 * was — which is how the composer's text came to be lost on every reopening of
 * the panel with the suite green.
 *
 * Enough of the real contract to catch the mistakes that matter: `get` with
 * defaults returns the stored value when there is one, `remove` deletes.
 *
 * @param {Record<string, unknown>} [initial] - Keys already in storage.
 * @returns {object} The double.
 */
function makeStorage(initial = {}) {
  /** @type {Record<string, unknown>} */
  const records = { ...initial }
  return {
    /**
     * What is really in storage, which is what a reopening of the panel reads.
     *
     * @returns {Promise<Record<string, unknown>>} A copy of the store.
     */
    snapshot: async () => ({ ...records }),
    get: async (defaults) => ({ ...(defaults ?? {}), ...records }),
    set: async (values) => {
      Object.assign(records, values)
    },
    remove: async (keys) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete records[key]
    },
  }
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
    host.chatRequests += 1
    // Counted before the answer, and gated before it too: a poll's overlapping
    // request is the thing under test, so it has to be observed on arrival
    // rather than after a response the test itself is holding open.
    if (host.holdNextChat !== null) {
      const gate = host.holdNextChat
      host.holdNextChat = null
      // The gate has to respect the request's signal, the way `fetch` does. A
      // plain `await gate` models a promise that ignores cancellation, which is
      // not a state a real request can be in — and the difference is exactly
      // what a timeout test is asking about: if the stub cannot be aborted, a
      // working timeout looks like a timeout that never fired.
      await new Promise((resolve, reject) => {
        const signal = options.signal
        if (signal === undefined || signal === null) {
          gate.then(resolve, reject)
          return
        }
        if (signal.aborted) {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
          return
        }
        signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
        gate.then(resolve, reject)
      })
    }
    if ((options.method ?? 'GET') === 'GET') {
      // A host older than the panel answers 200 with a body this panel cannot
      // read. Modelled at the response rather than at the panel's flag, so the
      // test drives the same detection the real host would.
      if (host.staleHost) return respond({})
      return respond(groupsPayload())
    }
    const body = options.body === undefined ? {} : JSON.parse(options.body)
    if (body.action === 'messages') {
      host.reads.push(body)
      // Sliced the way the host slices, and for the same reason: this stub used
      // to answer every request with the whole fixture, so the panel's window —
      // the thing `depth`, `loadEarlier` and a search jump are all about — was
      // invisible to every test here. A harness that cannot show the state cannot
      // check it, and the search jump would have shipped its window protocol
      // against a mock that accepts any `end` at all.
      const all = host.messages
      const limit = Number.isInteger(body.limit) && body.limit > 0 ? body.limit : 40
      const stop = Number.isInteger(body.end) && body.end >= 0
        ? Math.min(body.end, all.length)
        : all.length
      const start = Math.max(0, stop - limit)
      return respond({
        sessionId: body.sessionId,
        messages: all.slice(start, stop),
        title: host.title,
        more: host.more === true || start > 0,
        total: all.length,
        // Absent unless a test asks for it, because that is what the real host
        // does: only 77 of this machine's logs carry a `request/context` event,
        // so "the log never stated a window" is a state a reader can genuinely be
        // in. A stub that always answered would make the panel's honest fallback
        // unreachable from the suite.
        ...(host.occupancy === undefined ? {} : { occupancy: host.occupancy }),
      })
    }
    if (body.action === 'search') {
      host.searches.push(body)
      // The real matcher, not a second copy of it.
      const matches = findRows(host.messages, body.query)
      const answer = {
        sessionId: body.sessionId,
        matches,
        total: host.messages.length,
        truncated: matches.length >= 30,
      }
      // A search of a long session is not instantaneous, and the reader can type
      // the next word before it answers. `host.holdSearch` is how a test takes
      // the timing into its own hands instead of hoping the mock is slower than
      // the next keystroke.
      if (host.holdSearch !== null && host.holdSearch !== undefined) {
        const gate = host.holdSearch
        host.holdSearch = null
        return gate.then(() => respond(answer))
      }
      return respond(answer)
    }
    if (body.action === 'search-sessions') {
      host.sessionSearches.push(body)
      // `null` is "this profile mounts no index", which the panel must draw as
      // *could not search* rather than as *found nothing*. A stub that always
      // answered would make that state unreachable, and the two draw the same
      // empty list on screen.
      if (host.sessionSearch === null) {
        return respond({ available: false, hits: [], more: false, reason: 'this profile has no session search' })
      }
      return respond({ available: true, more: false, reason: '', hits: host.sessionSearch })
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
      // A real host can answer "no" — `accepted: false` with a reason — and the
      // panel has a whole branch for it. It could not be reached from the suite
      // while this line hard-coded acceptance.
      return respond(host.send.payload, host.send.status)
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

/**
 * Run the panel's transcript poll once, the way its interval would.
 *
 * `settle` only drains microtasks, so a test that sets `host.messages` and calls
 * `settle` is still looking at the previous fixture: nothing has asked the host
 * for the new rows. The clocks are armed in `start` in the order groups, health,
 * tabs, transcript.
 *
 * @returns {Promise<void>} Resolves once the re-read has settled.
 */
async function readTranscript() {
  if (typeof clocks[3] !== 'function') {
    throw new Error(`transcript clock missing: captured ${startupClocks}; start said "${startupToast}"`)
  }
  await clocks[3]()
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
 * What the announcer region held when the panel finished starting.
 *
 * Captured here for the same reason `startupToast` and `startupFocus` are: the
 * region is one element shared by every test in this file, so its value at the
 * point the announcements test happens to run says nothing about startup. Read
 * live, it reported whatever test last wrote there — measured, it read
 * 「streaming 29」, a sentence a streaming test had queued earlier and that only
 * landed because the tests in between awaited a macrotask.
 */
const startupAnnouncer = registry.get('announcer')?.textContent ?? ''
/**
 * Everything the announcer said while the panel was starting.
 *
 * Non-empty entries are what a screen reader would have heard, and on a healthy
 * start there must be none: see {@link announcerWrites} for why the writes are
 * intercepted rather than sampled.
 *
 * The boundary is the import plus the wait above, and it has to be a *boundary*
 * rather than "everything so far": `announcerWrites` is never reset, and
 * announcements are written on a later task, so a later test that settles the
 * clock can land a queued write from an earlier one. Reading the whole array made
 * this test's verdict depend on how much settling happened ahead of it — it
 * passed only while the tests before it happened to leave their writes pending,
 * and reported a startup defect as soon as one of them awaited a macrotask the
 * write needed. Measured: two unrelated tests added ahead of this one made it
 * fail with a list of sentences those tests had produced.
 *
 * @returns {string[]} The non-empty sentences written before the panel finished
 * starting.
 */
const startupWriteCount = announcerWrites.length
function startupAnnouncements() {
  return announcerWrites.slice(0, startupWriteCount).filter((said) => said !== '')
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

  // The composer says the same thing, and it has to be *this* reason. The field
  // names the missing step, and with nothing listening the step is not "create a
  // session" — that cannot work either, so naming it would send the reader to a
  // second thing that also fails. The panel's own surface already says what to do
  // here; the field must not contradict it with a different next move.
  assert.equal(
    registry.get('input').placeholder,
    'dsh web 没在运行…',
    'the field pointed at a step that cannot work while nothing is listening',
  )
  assert.notEqual(
    registry.get('input').placeholder,
    '先新建一个会话…',
    'the field told the reader to create a session against a host that is not answering',
  )
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

  // What the surface covers is unreachable, so the keyboard must not be able to
  // reach it either. An overlay only covers pixels: the elements behind it stayed
  // in the tab order, so Tab moved focus onto them, the ring was painted beneath an
  // opaque surface, and their keys went nowhere. Measured on the real panel with
  // the surface showing: eight focusable elements behind it, and pressing Enter on
  // one sent no request and changed nothing.
  assert.equal(
    registry.get('transcript').inert,
    true,
    'the conversation is still in the tab order behind the blocking surface',
  )
  // The conversation is only one of the two groups the surface disables, and the
  // two are wired separately: the stage's own children, and the things beside the
  // stage (`headerBar`, the find bar, `footer`). Asserting on one of them left the
  // other free to stop working — measured, a mutation that dropped the second
  // group entirely was not caught by the assertion above.
  assert.equal(
    registry.get('find').inert,
    true,
    'the find bar is beside the stage, and it is still reachable behind the blocking surface',
  )
  // The surface itself must stay reachable: its retry button is the reader's only
  // way out, and a fix that also disabled the way out would be worse than the bug.
  assert.notEqual(
    registry.get('blocked').inert,
    true,
    'the blocking surface disabled itself, taking the retry button out of the tab order with it',
  )

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
  // And the panel comes back. `inert` that is set and never cleared would leave a
  // panel that looks normal, cannot be clicked, and cannot be tabbed into — a fix
  // that trades one unusable state for another.
  assert.equal(
    registry.get('transcript').inert,
    false,
    'the panel never became usable again: everything is still inert after the host answered',
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

    // The composer is the other half of that screen, and it had the same problem
    // the surface did. The send button was disabled — correctly, there is no
    // session to send to — while the field kept inviting 「问点什么…」 and stayed
    // writable. A reader could type a whole question, press send, and watch
    // nothing happen with the text still sitting there: two entries on one
    // screen, one of them silently dead.
    //
    // The field is not disabled instead. The screen already says what to do first
    // and the field is where the question goes once it is done; a greyed-out box
    // with no explanation tells the reader less than the sentence they were about
    // to type. What it must not do is ask for something it cannot accept.
    const composer = registry.get('input')
    assert.equal(
      composer.placeholder,
      '先新建一个会话…',
      'the field invited a question that the disabled send button could not send',
    )
    assert.notEqual(
      composer.placeholder,
      '问点什么…',
      'the field is still asking for a question with nowhere to send it',
    )

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
    // The invitation comes back with the session. A field that kept saying
    // 「先新建一个会话…」 after one exists would be wrong in the other direction,
    // and that is the failure a one-way fix would have shipped.
    assert.equal(
      composer.placeholder,
      '问点什么…',
      'the field still asks for a session after one exists',
    )
  } finally {
    host.groups = undefined
    await clockOf('groups')
    await settle()
  }
})

test('a host older than the panel says so, and offers nothing it cannot do', async () => {
  // The host answers 200 without a `groups` list. The panel cannot create a
  // session against that host — `newSession` refuses on the same flag — but the
  // surface only knew two states, so this fell into the empty one and said
  // 「还没有会话」 next to a 「新建会话」 button. Pressing it sent no request,
  // changed nothing on screen, and repeated a toast that had already faded:
  // measured on an emulated old host, `anythingChanged: false`,
  // `createRequestsSent: 0`, `persistentNoticeCount: 0`.
  //
  // An interface that instructs the reader to press a button it will not honour
  // is worse than one that stays quiet, so what this test is really pinning is
  // the absence of the invitation.
  host.down = false
  host.staleHost = true
  host.groups = undefined
  try {
    await clockOf('groups')
    await settle()

    assert.equal(registry.get('blocked').hidden, false, 'an unreadable host left the area blank')
    // Not the empty state's sentence. The reader has not been told there are no
    // sessions, because nobody knows whether there are.
    assert.equal(registry.get('blocked-title').textContent, 'dsh web 需要重启')
    assert.equal(registry.get('blocked-body').textContent, '面板比宿主新：重启 dsh web 之后就能用。')

    // The load-bearing assertion. Restarting `dsh web` happens outside the panel,
    // so there is no button here that could work; a disabled one would still be
    // an offer, which is why this asks for hidden rather than disabled.
    const action = registry.get('blocked-action')
    assert.equal(action.hidden, true, 'the panel still offered an action it cannot carry out')

    host.created.length = 0
    action.emit('click')
    await settle()
    assert.equal(host.created.length, 0, 'a click on a hidden action still reached the host')

    // And the reader who is not looking at the screen hears the same thing the
    // screen says. Without this the surface could be announced as 「还没有会话」
    // while showing 「dsh web 需要重启」 — the two channels disagreeing, which is
    // the failure this whole branch exists to prevent, moved from the eye to the
    // ear. Mutation `stale-not-announced` survived until this assertion existed.
    //
    // `settleMacrotask` rather than `settle`, because `announce` writes on a
    // later task on purpose: a microtask drain reads the region while it is
    // still empty and would report the defect this is here to catch.
    await settleMacrotask()
    assert.ok(
      announcerWrites.includes('dsh web 需要重启'),
      `the stale state was never announced; the announcer said ${JSON.stringify(announcerWrites)}`,
    )
    // Read from the end: the surface's earlier states wrote their own sentences,
    // and the assertion is about what the reader is told *now*.
    assert.ok(
      !announcerWrites.slice(announcerWrites.lastIndexOf('dsh web 需要重启')).includes('还没有会话'),
      'the announcer contradicted the surface after the stale state appeared',
    )
  } finally {
    // Every test after this one shares the same panel instance, so an unreachable
    // host left behind would poison the rest of the file.
    host.staleHost = false
    await clockOf('groups')
    await settle()
    assert.equal(registry.get('blocked').hidden, true, 'the stale surface outlived the old host')
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

/**
 * Run `body` with the panel's timers recorded instead of scheduled.
 *
 * The composer's toast clears itself after six seconds, and the assertion that
 * matters is about what survives that clearing — so the expiry has to be
 * reachable without waiting six seconds, and reachable *deliberately* rather than
 * as a side effect of some other test's clock. Each callback is kept with the
 * delay it was scheduled for, so a test can fire exactly the ones it means to.
 */
async function withRecordedTimers(body) {
  const realSetTimeout = globalThis.setTimeout
  const recorded = []
  globalThis.setTimeout = (callback, delay) => {
    recorded.push({ callback, delay })
    return recorded.length
  }
  try {
    await body(recorded)
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
  // A test that made the host refuse a send must not leave that answer behind:
  // the panel instance is shared, so the next test's send would be refused too
  // and fail for a reason that has nothing to do with it.
  host.send = { status: 200, payload: { accepted: true } }
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

test('a table that fits says so, and one that does not says which way it continues', async () => {
  // The edge shades are driven by two attributes the stylesheet reads, because CSS
  // cannot see `scrollLeft`. The failure this test exists for is specific: those
  // attributes were only ever refreshed from the scroll handler, and a table that
  // fits is never scrolled, so it kept the `at-end="no"` the renderer writes —
  // which the stylesheet reads as "there is more table to the right". Measured in
  // the browser on a fitting table: both shades visible, on the one table where
  // the reader can see the whole thing at once.
  //
  // Both cases are asserted, because a fix that made every table say "nothing to
  // the right" would pass the fitting half and silently drop the hint from the
  // tables that need it.
  await settleToIdle()
  host.messages = [
    { kind: 'user', text: '这两个哪个快' },
    {
      kind: 'assistant',
      text: '实测：\n\n| 做法 | 中位耗时 |\n| --- | ---: |\n| 直写 | 2.4ms |\n| 批量 | 0.3ms |',
    },
  ]
  // `settle` only drains microtasks; nothing has asked the host for the new rows
  // until the transcript clock runs. Setting the fixture and settling reads the
  // *previous* one, which is how this test first reported that the fixture
  // rendered no table at all.
  await readTranscript()

  const scrollers = transcript.querySelectorAll('.table-scroll')
  assert.equal(scrollers.length, 1, 'the fixture did not render a table, so this test proves nothing')

  // The panel measured this table when it drew it, and the shim has no layout —
  // so the width it reported is the shim's default of zero, which is the fitting
  // case. That is the case under test: a table that fits must say the end is here.
  //
  // Ordering is the lesson from writing this twice. Setting the widths *after* the
  // draw and reading the attributes asserts nothing about the panel: it reads back
  // whatever the last measurement concluded, which is the zero-width answer. The
  // widths have to be in place before the pass that decides.
  const narrow = scrollers[0]
  assert.equal(
    narrow.getAttribute('data-scrolled'),
    'no',
    'a table narrower than the panel must not claim content to its left',
  )
  assert.equal(
    narrow.getAttribute('data-at-end'),
    'yes',
    'a table that fits must report the end, or the stylesheet draws a shade promising content that is not there',
  )

  // And the same element, once it is genuinely wider than its box, has to say the
  // opposite — otherwise a fix that marked every table as "nothing to the right"
  // would pass the half above and quietly drop the hint from the tables that need
  // it most. The scroll handler is what re-decides, so it is driven directly.
  narrow.measure({ scrollWidth: 574, clientWidth: 332, scrollLeft: 0 })
  narrow.emit('scroll', { target: narrow })
  assert.equal(
    narrow.getAttribute('data-at-end'),
    'no',
    'a table wider than its box has more to the right, and must say so',
  )
})

test('scrolling a table moves the shades to match where the reader is', async () => {
  await settleToIdle()
  host.messages = [
    { kind: 'user', text: '这两个哪个快' },
    {
      kind: 'assistant',
      text: '实测：\n\n| 做法 | 中位耗时 |\n| --- | ---: |\n| 直写 | 2.4ms |\n| 批量 | 0.3ms |',
    },
  ]
  await readTranscript()

  const scroller = transcript.querySelectorAll('.table-scroll')[0]
  assert.notEqual(scroller, undefined, 'the fixture did not render a table')

  // The scroll handler is the only thing that keeps these current while the reader
  // moves, so it is driven here exactly as the browser drives it: set the position,
  // dispatch the event, read what the panel decided.
  scroller.measure({ scrollWidth: 574, clientWidth: 332, scrollLeft: 0 })
  scroller.emit('scroll', { target: scroller })
  assert.equal(scroller.getAttribute('data-scrolled'), 'no', 'at the left edge there is nothing to the left')
  assert.equal(scroller.getAttribute('data-at-end'), 'no', 'and 242px of table is still to the right')

  scroller.measure({ scrollWidth: 574, clientWidth: 332, scrollLeft: 121 })
  scroller.emit('scroll', { target: scroller })
  assert.equal(scroller.getAttribute('data-scrolled'), 'yes', 'past the left edge the leading shade belongs on screen')
  assert.equal(scroller.getAttribute('data-at-end'), 'no', 'the middle is not the end')

  // `scrollLeft` lands on 573.5 for a 574 maximum in a real browser, so the end has
  // to be recognised within a pixel — an exact comparison would leave the trailing
  // shade lit with nothing left to show.
  scroller.measure({ scrollWidth: 574, clientWidth: 332, scrollLeft: 573.5 })
  scroller.emit('scroll', { target: scroller })
  assert.equal(
    scroller.getAttribute('data-at-end'),
    'yes',
    'a sub-pixel short of the end is the end; otherwise the shade stays lit over an empty margin',
  )
  assert.equal(scroller.getAttribute('data-scrolled'), 'yes', 'the leading shade stays while there is table behind')
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

test('a send the host refuses is still on screen after the toast expires', async () => {
  // The failure used to be a toast and nothing else, and a toast is a moment
  // rather than a record — it clears itself after six seconds. Measured on a
  // refused send, everything the failure added to the screen was inside that
  // toast, so once it expired the panel looked exactly like a message that had
  // been typed and not yet sent. Text in the composer and no explanation reads as
  // "you have not pressed send", which is the one reading that is wrong.
  //
  // The clock is recorded rather than waited on: the assertion is about what
  // survives the toast's expiry, and sleeping six seconds to find out would make
  // the suite slower without making the reading truer.
  await withRecordedTimers(async (timers) => {
    await settleToIdle()
    toast.textContent = ''
    host.send = { status: 200, payload: { accepted: false, reason: 'the host said no' } }
    type('这一句发不出去')

    await press()

    assert.equal(host.sent.length > 0, true, 'the send never reached the host, so no refusal was exercised')
    assert.ok(
      toast.textContent.includes('the host said no'),
      `the refusal was never announced: ${JSON.stringify(toast.textContent)}`,
    )
    const note = registry.get('send-note')
    assert.equal(note.hidden, false, 'nothing persistent records the refusal')
    assert.ok(
      note.textContent.includes('the host said no'),
      `the standing notice does not say why: ${JSON.stringify(note.textContent)}`,
    )
    assert.equal(input.value, '这一句发不出去', 'the message was taken out of the composer by a failed send')

    // Let the toast expire exactly as its own timer would, and confirm the record
    // is not on it. Firing the real callbacks is what makes this a fact about the
    // toast rather than a restatement of the assertion above.
    const expiries = timers.filter((entry) => entry.delay === 6000)
    assert.ok(expiries.length > 0, 'the toast scheduled no expiry, so this proves nothing about what survives it')
    for (const entry of expiries) entry.callback()
    assert.equal(toast.textContent, '', 'the toast did not clear, so the next assertion is not about survival')
    assert.equal(
      registry.get('send-note').hidden,
      false,
      'the notice left with the toast, so a reader who looked away learns nothing',
    )

    // A send that works is what ends it. A notice that outlived the problem would
    // be a standing lie about the message sitting in the composer.
    host.send = { status: 200, payload: { accepted: true } }
    await press()
    assert.equal(
      registry.get('send-note').hidden,
      true,
      'the notice is still there after a send that worked',
    )

    // Put the panel back where the next test expects it. The send above started a
    // turn, and `settleToIdle` would have restored everything except the refusal
    // answer this test replaced.
    await settleToIdle()
  })
})

test('a refusal notice does not follow the reader into another session', async () => {
  // The notice names a failure that belongs to one composer. `restoreDraft` puts
  // another session's text in that composer, so leaving the notice up would
  // attach 「没发出去」 to a message that was never sent and never failed — the
  // panel accusing itself of something that did not happen.
  //
  // Mutation-checked: dropping the clearing call from `restoreDraft` left the
  // whole suite green until this test existed.
  await onStoppedClock(async () => {
    await settleToIdle()
    host.send = { status: 200, payload: { accepted: false, reason: 'the host said no' } }
    type('这一句发不出去')
    await press()
    assert.equal(registry.get('send-note').hidden, false, 'no notice was raised, so nothing below is proved')

    await switchTo(OTHER)

    assert.equal(
      registry.get('send-note').hidden,
      true,
      'the refusal notice is still on screen in a session whose message never failed',
    )
    host.send = { status: 200, payload: { accepted: true } }
    // Leave the panel on the session the rest of the suite expects. The panel
    // instance is shared, so a test that walks away mid-switch breaks whichever
    // test runs next rather than the one that caused it.
    await switchTo(SESSION)
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

test('a turn nobody typed a question for is labelled with what started it', async () => {
  // Measured on this machine: 112 of 243 turns across 156 real sessions were
  // opened by something other than the reader. Without a row for them the panel
  // drew the model answering nothing, and the reader had no way to find out why
  // it had started talking. The injected words stay out of the transcript — a
  // skill catalog is 9 KB — so only the label is asserted here.
  await show([
    { kind: 'user', text: '帮我看一下这个页面' },
    { kind: 'assistant', text: '好。' },
    { kind: 'trigger', text: 'goal' },
    { kind: 'assistant', text: '继续检查剩下的部分。' },
  ])

  const labels = transcript.querySelectorAll('.trigger-label')
  assert.equal(labels.length, 1, 'the turn with no question was not labelled')
  assert.equal(
    labels[0].textContent,
    '继续执行目标',
    `the label did not name the trigger: ${JSON.stringify(labels[0].textContent)}`,
  )
  // The label is not a control. Giving it a `pointer` cursor, a tab stop or a
  // click handler would promise the reader that something happens when they
  // click it, and nothing does. The shim has neither `tabIndex` nor an `onclick`
  // that defaults to null — real Chromium reports -1 and null, which the
  // affordance probe checks — so this holds what the shim can answer: it is not
  // a button, and nothing was attached to it.
  assert.equal(labels[0].tagName, 'SPAN', 'a trigger label must not be a button')
  assert.equal(
    labels[0].listeners.get('click'),
    undefined,
    'a trigger label must have no click handler: it is a caption, not a control',
  )
})

test('a GitHub event is named as one rather than as a generic webhook', async () => {
  // The harness distinguishes them by `source.provider`, not by a kind of their
  // own. A panel that invented a `github` kind would name an event nothing
  // sends, and would call the real one by the wrong name.
  await show([
    { kind: 'trigger', text: 'webhook', provider: 'github' },
    { kind: 'trigger', text: 'webhook' },
    { kind: 'trigger', text: 'schedule' },
  ])

  const labels = [...transcript.querySelectorAll('.trigger-label')].map((node) => node.textContent)
  assert.deepEqual(labels, ['收到 GitHub 事件', '收到外部事件', '定时任务'])
})

test('an unrecognised trigger still gets a label rather than silence', async () => {
  // A notification kind the panel has never heard of is exactly the case where
  // it must say something: a new kind of event should read as "something else
  // started this turn", which is true, not as nothing at all.
  await show([{ kind: 'trigger', text: 'some-future-kind' }])

  const labels = transcript.querySelectorAll('.trigger-label')
  assert.equal(labels.length, 1, 'an unknown trigger drew nothing at all')
  assert.ok(
    (labels[0].textContent ?? '').length > 0,
    'an unknown trigger produced an empty label',
  )
})

test('a compaction row says how much conversation it stands in for', async () => {
  // Compaction removes the conversation it summarizes from the surface, so
  // without this row the transcript simply begins: the discussion starts
  // mid-thought and nothing says it was ever longer. Measured across this
  // machine's sessions, 30 of 156 have been compacted.
  await show([
    { kind: 'user', text: '第一个问题' },
    { kind: 'compaction', compactionId: 'c-compaction-count', shadowed: 293, text: '这一段被压缩了' },
    { kind: 'user', text: '第二个问题' },
  ])

  const lines = transcript.querySelectorAll('.compaction-line')
  assert.equal(lines.length, 1, 'the compaction row was not drawn')
  // The count is the reading that makes the row worth having: it is the
  // difference between "the conversation starts here" and "the conversation was
  // longer than this".
  assert.match(
    lines[0].textContent,
    /293/,
    `the row did not state how much it covers: ${JSON.stringify(lines[0].textContent)}`,
  )
})

test('a compaction row opens to show its summary, and the caret follows', async () => {
  // The summary is the only surviving account of the part that was removed, and
  // it is real prose — 1.3k to 6.1k characters on this machine. Closed by
  // default, because a row that opens to that much text would be most of a screen.
  await show([
    { kind: 'compaction', compactionId: 'c-compaction-open', shadowed: 12, text: '被折叠的那一段' },
  ])

  assert.equal(
    transcript.querySelector('.compaction-body'),
    null,
    'the summary was drawn before anything was clicked',
  )
  const line = transcript.querySelector('.compaction-line')
  assert.equal(line.getAttribute('aria-expanded'), 'false', 'a closed row did not say it was closed')

  line.emit('click', {})
  await settle()

  const bodies = transcript.querySelectorAll('.compaction-body')
  assert.equal(bodies.length, 1, `clicking the row opened ${bodies.length} summaries`)
  assert.equal(bodies[0].textContent, '被折叠的那一段', 'the row opened a different summary')
  assert.equal(
    transcript.querySelector('.compaction-line').getAttribute('aria-expanded'),
    'true',
    'the open row did not say it was open',
  )
  // The caret is the visible half of the same fact, and it has its own element:
  // a redraw that updated the attribute but not the caret would leave the row
  // claiming to be closed while it showed its summary.
  assert.match(transcript.querySelector('.compaction-caret').textContent, /⌃/, 'the caret still points closed')

  transcript.querySelector('.compaction-line').emit('click', {})
  await settle()
  assert.equal(transcript.querySelector('.compaction-body'), null, 'a second click did not close the row')
})

test('a checkpoint with no summary is still drawn, and is not a control', async () => {
  // The host cannot promise the summary arrived — it is model-written prose. The
  // fact the row exists to tell does not depend on it, so the row is drawn either
  // way; but a button that reveals nothing is a tab stop that costs the reader a
  // press, so with no summary it is not a button.
  await show([{ kind: 'compaction', compactionId: 'c-compaction-bare', shadowed: 7, text: '' }])

  const lines = transcript.querySelectorAll('.compaction-line')
  assert.equal(lines.length, 1, 'a summary-less checkpoint was dropped entirely')
  assert.equal(lines[0].tagName, 'DIV', 'a row with nothing to reveal was still made focusable')
  assert.match(lines[0].textContent, /7/, 'the row did not state how much it covers')
})

test('two checkpoints that read the same open one at a time', async () => {
  // Their key falls back to the text, and two checkpoints *can* carry the same
  // text — a model summarizing two ranges in the same words is enough. Sharing a
  // name is how an empty `callId` once made every tool row the same row, and here
  // the damage is in the open set: opening one would open both.
  //
  // The rows must carry a summary, or there is nothing to open and the shared key
  // costs nothing observable.
  const same = '两段被压缩的对话摘要文字完全相同'
  await show([
    { kind: 'compaction', compactionId: 'c-compaction-twin-1', shadowed: 1, text: same },
    { kind: 'user', text: '中间' },
    { kind: 'compaction', compactionId: 'c-compaction-twin-1-2', shadowed: 2, text: same },
  ])

  const lines = transcript.querySelectorAll('.compaction-line')
  assert.equal(lines.length, 2, 'the two checkpoints were not both drawn')
  lines[0].emit('click', {})
  await settle()

  const bodies = transcript.querySelectorAll('.compaction-body')
  assert.equal(
    bodies.length,
    1,
    `opening one checkpoint opened ${bodies.length} of them — they share a row name`,
  )
})

test('switching sessions forgets which compaction rows were open', async () => {
  // A compaction id is only unique within its own session, so an open row carried
  // across a switch would open whatever row in the *next* conversation happened to
  // share its name. The sibling sets are cleared for this reason, and so is this
  // one — leaving it out is invisible until two sessions happen to share an id.
  const checkpoint = (text) => ({ kind: 'compaction', compactionId: 'c-compaction-switch', shadowed: 3, text })
  await show([checkpoint('第一个会话的摘要')])
  transcript.querySelector('.compaction-line').emit('click', {})
  await settle()
  assert.equal(
    transcript.querySelectorAll('.compaction-body').length,
    1,
    'the row never opened, so nothing below is proved',
  )

  await switchTo(OTHER)
  await switchTo(SESSION)
  await show([checkpoint('第二个会话的摘要')])

  assert.equal(
    transcript.querySelector('.compaction-body'),
    null,
    'a compaction row was open in a session the reader had left',
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

test('the composer leaves with the conversation it writes to', async () => {
  // Every control in the composer acts on `currentSessionId`: the field composes a
  // message for it, the button delivers it, and the model picker changes the model
  // *that session* runs on. Over the session list there is no such session on
  // screen — `renderTitle` hides the one element that names it — so a live
  // composer there changes a conversation the reader cannot see.
  //
  // Measured in a real browser with the list open, choosing a model really did
  // send `{action: 'select-model', sessionId: 'session-a'}` while the screen showed
  // only sessions. The panel already states the rule, about the find bar: a control
  // that cannot act on what is on screen lies about what is possible.
  //
  // The round trip is the point. A one-way fix that hides the composer and never
  // brings it back is worse than the defect: the reader returns to the
  // conversation and finds the field gone.
  await settleToIdle()
  const composer = registry.get('composer')

  assert.equal(currentViewInPanel(), 'chat', 'this test needs to start in the conversation')
  assert.equal(composer.hidden, false, 'the composer was already hidden in the conversation')

  registry.get('title').click()
  await settle()
  assert.equal(currentViewInPanel(), 'history', 'the click did not open the session list')
  assert.equal(
    composer.hidden,
    true,
    'the composer stayed live over the session list, where its controls act on a conversation that is not on screen',
  )

  registry.get('title').click()
  await settle()
  assert.equal(currentViewInPanel(), 'chat', 'the click did not come back to the conversation')
  assert.equal(
    composer.hidden,
    false,
    'the composer did not come back with the conversation, so the field the reader composes in is gone',
  )
})

test('a staged context does not ride under the session list', async () => {
  // The chips above the field are pages waiting to be sent with the next message.
  // Over a list there is no next message, and a chip sitting under a list of
  // sessions reads as something that will be attached to whichever one is opened.
  //
  // This is the same shape as the composer and is asserted separately because it
  // has its own writer: `renderContexts` owns that element's visibility and runs
  // on its own schedule, so a repaint that ignored the view rule would pop the
  // chips back under the list.
  await settleToIdle()
  const contexts = registry.get('contexts')

  // Stage one through the panel's own path rather than by writing to the DOM, so
  // the test drives what a reader's action drives. The chips come from
  // `chrome.tabs.query`, and `refreshChips` runs that poll.
  //
  // Spread the fixture's own tab rather than substituting one: this suite shares a
  // single panel instance, so a fabricated page left behind changes what the tests
  // after this one see — inventing `Example Domain` here made the icon test look
  // for an icon that page never had, and made a later mention look like a second
  // promise of the same tab.
  const originalTab = host.tab
  const originalUrls = host.tabUrls
  host.tab = { ...originalTab, title: 'Example Domain', url: 'https://example.com/' }
  if (Array.isArray(originalUrls)) host.tabUrls = [host.tab.url]
  await refreshChips()
  assert.equal(currentViewInPanel(), 'chat', 'this test needs to start in the conversation')
  assert.equal(contexts.children.length > 0, true, 'no chip was staged, so this test cannot prove anything')
  assert.equal(contexts.hidden, false, 'the staged chip was not drawn in the conversation')

  registry.get('title').click()
  await settle()
  assert.equal(
    contexts.hidden,
    true,
    'the staged chip stayed visible under the session list, where there is no message to send it with',
  )

  registry.get('title').click()
  await settle()
  assert.equal(contexts.hidden, false, 'the staged chip did not come back with the conversation')

  // Hand the suite back the fixture's own tab, for the reason noted above.
  host.tab = originalTab
  if (originalUrls === undefined) delete host.tabUrls
  else host.tabUrls = originalUrls
  await refreshChips()
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

test('an IME Escape cancels the composition, not the layer behind it', async () => {
  await settleToIdle()
  await openFindBar()
  assert.equal(
    registry.get('find-open').getAttribute('aria-expanded'),
    'true',
    'the find bar is open to begin with',
  )

  // Escape is how an IME closes its candidate window, and it is also how this
  // panel dismisses a layer. Measured in Chromium with a real composition, the
  // keystroke arrives with `key: 'Escape'` *and* `isComposing: true` — so a
  // handler that reads only `key` cannot tell the two apart, and the reader who
  // meant "cancel that candidate" watched the find bar vanish instead.
  document.emit('keydown', { key: 'Escape', isComposing: true, preventDefault() {} })
  await settle()
  assert.equal(
    registry.get('find-open').getAttribute('aria-expanded'),
    'true',
    'an IME Escape closed the find bar',
  )

  // The legacy signal, for IMEs that report no key.
  document.emit('keydown', { key: 'Escape', keyCode: 229, preventDefault() {} })
  await settle()
  assert.equal(
    registry.get('find-open').getAttribute('aria-expanded'),
    'true',
    'keyCode 229 was treated as a dismiss',
  )

  // And a real Escape still closes it, so the guard is not eating the key.
  document.emit('keydown', { key: 'Escape', preventDefault() {} })
  await settle()
  assert.equal(
    registry.get('find-open').getAttribute('aria-expanded'),
    'false',
    'a plain Escape no longer closes the find bar',
  )
})

test('an IME Enter in the find field commits the word instead of jumping', async () => {
  await searchForZebra()
  const before = registry.get('find-count').textContent

  // The find field is a field an IME composes in, exactly like the composer:
  // accepting the candidate 「斑马」 would step to the next match mid-word.
  registry.get('find-input').emit('keydown', {
    key: 'Enter',
    isComposing: true,
    preventDefault() {},
  })
  await settle()
  assert.equal(
    registry.get('find-count').textContent,
    before,
    'an IME Enter stepped to another match',
  )

  registry.get('find-input').emit('keydown', {
    key: 'Enter',
    keyCode: 229,
    preventDefault() {},
  })
  await settle()
  assert.equal(
    registry.get('find-count').textContent,
    before,
    'keyCode 229 stepped to another match',
  )

  // A real Enter still steps, so the guard is not eating the key. Measured
  // against `longTranscript`, whose zebra rows sit at known positions.
  registry.get('find-input').emit('keydown', { key: 'Enter', preventDefault() {} })
  await settle()
  assert.notEqual(
    registry.get('find-count').textContent,
    before,
    'a plain Enter no longer steps through matches',
  )

  // Left as the rest of the file expects to find it. A bar still open would
  // swallow the next test's Escape; a window still parked around a match would
  // leave the panel drawing a different part of the conversation than the next
  // test asked for, and would put the needle on screen for the search tests that
  // assert it starts off screen. Closing the bar clears the query but *not* the
  // window — `#to-bottom` is what returns the panel to the newest rows.
  //
  // Not by sending a message, which is how the file's later cleanup does it:
  // that produces a reply, and the announcements test below asserts the announcer
  // has been silent since startup. Sending here would turn this test's leftovers
  // into a failure reported against that one.
  //
  // `host.searches` is reset too, because the search tests that follow count the
  // requests: this test's own query would make their `length === 1` mean
  // something other than what they wrote it to mean.
  closeFindBar()
  registry.get('to-bottom').emit('click')
  await settle()
  await settleToIdle()
  host.searches.length = 0
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
  // `startupAnnouncer`, not the live value: this region is shared with every
  // other test in the file, so what it holds now is whatever ran most recently.
  assert.equal(
    startupAnnouncer,
    '',
    `a healthy start must say nothing, said: ${startupAnnouncer}`,
  )

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
 * Drive one whole turn — start, text, end — and read back what was announced.
 *
 * The three frames have to be delivered in order: `applyDelta` returns early
 * unless it is the session on screen, and the text only accumulates once
 * `kind: 'start'` has made a live block. A test that sends the text alone
 * measures nothing, and passes for it.
 *
 * @param {string} body - The answer text.
 * @returns {Promise<string>} What the live region held once the turn ended.
 */
async function announcedFor(body) {
  announcer.textContent = ''
  deliver({ sessionId: SESSION, kind: 'start' })
  deliver({ sessionId: SESSION, kind: 'text', text: body })
  deliver({ sessionId: SESSION, kind: 'end' })
  await settleMacrotask()
  return announcer.textContent
}

/**
 * An answer of exactly `length` characters, built from numbered sentences.
 *
 * Two off-by-ones live here, both the fixture's rather than the panel's, and both
 * were reported as the panel failing:
 *
 *  - The padding loop must run past the requested length before slicing. The
 *    sentence is 34 characters, so a buffer that stopped at the request returned
 *    one short.
 *  - The requested length must not land on a space. `announceableAnswer` trims,
 *    which is right — a trailing space is not something to read aloud — so a
 *    241-character answer ending in `" "` is legitimately announced as 240. The
 *    fixture was measuring the trim, not the ceiling.
 *
 * @param {number} length - Exact character count of a trimmed answer.
 * @returns {string} An answer of that length.
 */
function answerOfLength(length) {
  let out = ''
  let index = 1
  while (out.length < length + 40) {
    out += `Sentence ${index} explains the thing. `
    index += 1
  }
  return out.slice(0, length).trimEnd()
}

test('a long answer is announced in part, and says how much it left out', async () => {
  // A live region cannot be skipped, scrolled or interrupted, so everything put
  // in one is time the reader has to sit through. Announcing the finished answer
  // whole meant a 5612-character answer held the region for ~22 minutes of
  // speech — and that length is ordinary here: across 10885 assistant messages on
  // the author's machine, p99 is 2116 characters and the longest is 35159.
  const long = answerOfLength(2116)
  const heard = await announcedFor(long)

  assert.ok(
    heard.length < long.length / 2,
    `a 2116-character answer must not be announced whole, got ${heard.length} characters`,
  )
  // The count has to be *about this answer*. Asserting that a number appears
  // proves nothing: the fixture's own sentences are numbered, so `/\d/` matches
  // the text the panel never wrote. The announcement has to name the number of
  // characters it dropped, and that number is arithmetic, not a guess.
  const dropped = long.length - (heard.length - (heard.match(/（其余 (\d+) 字）/) ?? [])[0]?.length ?? 0)
  const claimed = Number.parseInt((heard.match(/（其余 (\d+) 字）/) ?? [])[1] ?? '', 10)
  assert.ok(
    Number.isInteger(claimed),
    `the announcement must say how much was left out, got: ${heard}`,
  )
  assert.ok(
    dropped > 0 && claimed > 0 && Math.abs(claimed - dropped) <= 2,
    `the count must match what was dropped (claimed ${claimed}, dropped about ${dropped})`,
  )
  // The opening really is the answer's opening, not a summary the panel wrote.
  assert.ok(
    long.startsWith(heard.slice(0, 40)),
    `the announcement must open with the answer's own words, got: ${heard.slice(0, 40)}`,
  )
})

test('an ordinary answer is announced whole, because bounding it would cost more', async () => {
  // The median answer on that same machine is 89 characters, p75 is 136. If the
  // ceiling changed the shape of those, the fix would trade most readers' case
  // for the long tail's — which is not a fix.
  //
  // The boundary matters more than the round numbers. Two lengths sit just above
  // the ceiling: 250 characters, where bounding saves about 25 and the count
  // sentence is not yet worth it, and 280, where the saving has overtaken the
  // cost and the answer is abbreviated. Measured: 280 comes out at 225. A test
  // that only checked "under 240 is verbatim" cannot see the ceiling move at all,
  // which is how the first version of this file let two mutations through.
  for (const length of [89, 136, 240, 250]) {
    const body = answerOfLength(length)
    const heard = await announcedFor(body)
    assert.equal(
      heard,
      body,
      `an answer of ${length} characters must be announced verbatim; got ${heard.length} characters`,
    )
  }
  const worthCutting = answerOfLength(280)
  const shortened = await announcedFor(worthCutting)
  assert.ok(
    shortened.length < worthCutting.length,
    `at 280 characters the saving is worth the count sentence, so it must be shortened; got ${shortened.length}`,
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
  const model = registry.get('model')
  // The click toggles, so a picker left open by the previous test is *closed* by
  // this one — and every assertion below would then be reading rows out of a
  // menu nobody has open. `aria-expanded` is the panel's own statement of
  // whether its popup is showing, which is what makes this deterministic; a
  // test that read `menu.hidden` instead would be reading the DOM, and the two
  // disagree at startup because the stub is not built from the markup.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (model.getAttribute('aria-expanded') === 'true') break
    model.click()
    await settle()
  }
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

// ─────────────────────────────────────────────────────────────────────────────
// The picker is a menu, and says so
// ─────────────────────────────────────────────────────────────────────────────

test('the picker declares the role its rows require, and is named', async (t) => {
  // `menuitemradio` and `option` are owned roles: WAI-ARIA lets them exist only
  // inside a known parent role, and with none the browser has no widget to
  // describe. Measured in a real browser before this, both rows reported their
  // owner as nothing at all — the role was written on one side of a boundary
  // and the other side never answered.
  //
  // The trigger was already promising it: `aria-haspopup="menu"` is a claim
  // about the thing that appears when you press it. That attribute is in the
  // markup, which this suite's document never parses, so the promise is checked
  // against the trigger's own word here and the markup itself in
  // `panel-geometry.test.js`.
  t.onCleanup(() => {
    host.catalog = null
    registry.get('model').click()
  })

  const { menu, options, efforts } = await openModelMenu(MENU_CATALOG)
  assert.equal(menu.getAttribute('role'), 'menu', 'the container the rows are owned by')

  // A menu also has to be nameable, or a screen reader announces an unnamed
  // list of choices.
  assert.equal(menu.getAttribute('aria-labelledby'), 'model', 'the menu is named by the button that opens it')

  // Every row a menu owns has to be focusable, or the arrow keys have nowhere
  // to go. The two kinds differ because they answer different questions: which
  // model is in force, and which level it runs at.
  const roles = [...efforts, ...options].map((row) => row.getAttribute('role'))
  assert.deepEqual(
    [...new Set(roles)].sort(),
    ['menuitemradio', 'radio'],
    `every row must be owned by the container, got ${JSON.stringify(roles)}`,
  )
})

test('opening the picker puts a reachable row under the keyboard', async (t) => {
  // A menu moves focus into itself when it opens; that is what makes the arrow
  // keys work, because they are handled on the menu and an event aimed at the
  // trigger never reaches it. Measured in a real browser before this, ArrowDown
  // on a freshly opened picker left focus exactly where it was.
  t.onCleanup(() => {
    host.catalog = null
    registry.get('model').click()
  })

  const { menu } = await openModelMenu(MENU_CATALOG)
  const rows = menu.querySelectorAll('button')
  assert.ok(rows.length > 0, 'the catalog lists choices, so there is something to focus')
  assert.equal(
    document.activeElement,
    rows[0],
    'the first row must hold focus, or the arrow keys have nothing to move from',
  )
})

test('the arrow keys walk the picker and stop at its ends', async (t) => {
  t.onCleanup(() => {
    host.catalog = null
    registry.get('model').click()
  })

  const { menu } = await openModelMenu(MENU_CATALOG)
  const rows = menu.querySelectorAll('button')
  assert.ok(rows.length >= 3, `expected a list to walk, got ${rows.length} rows`)

  // Counted rather than stubbed: a key that moves focus and also scrolls is two
  // behaviours fighting over one keystroke.
  const key = (name) => {
    let prevented = 0
    document.activeElement.emit('keydown', { key: name, preventDefault: () => { prevented += 1 } })
    return prevented
  }

  rows[0].focus()
  assert.equal(key('ArrowDown'), 1, 'the menu moved focus without claiming the keystroke')
  assert.equal(document.activeElement, rows[1], 'ArrowDown did not move to the next choice')
  assert.equal(key('ArrowUp'), 1)
  assert.equal(document.activeElement, rows[0], 'ArrowUp did not move back')

  // No wrapping, matching the session list: the ends of a list are information.
  key('ArrowUp')
  assert.equal(document.activeElement, rows[0], 'ArrowUp from the first row wrapped to the last')
  const last = rows[rows.length - 1]
  last.focus()
  key('ArrowDown')
  assert.equal(document.activeElement, last, 'ArrowDown from the last row wrapped to the first')

  // Home and End are the list's own, and a plain letter is not navigation.
  assert.equal(key('Home'), 1)
  assert.equal(document.activeElement, rows[0], 'Home did not reach the first choice')
  assert.equal(key('End'), 1)
  assert.equal(document.activeElement, last, 'End did not reach the last choice')
  assert.equal(key('a'), 0, 'the menu claimed a key it does not act on')
})

test('closing the picker hands focus back to the button it came from', async (t) => {
  // Closing while standing in the list would leave focus on a row that no longer
  // exists, which puts it on `body` and makes the next Tab start from the top of
  // the panel.
  t.onCleanup(() => {
    host.catalog = null
    registry.get('model').click()
  })

  const model = registry.get('model')
  const { menu } = await openModelMenu(MENU_CATALOG)
  assert.ok(menu.querySelectorAll('button').length > 0, 'the menu has rows to stand on')

  document.activeElement.emit('keydown', { key: 'Escape', preventDefault: () => {} })
  await settle()

  assert.equal(menu.hidden, true, 'Escape closed the picker')
  assert.equal(document.activeElement, model, 'focus must return to the button that opened it')
})

test('a repaint leaves a reader standing in the picker where they were', async (t) => {
  // The picker is repainted from `renderChrome`, which the five-second
  // `refreshGroups` calls — so an open menu used to be rebuilt on every poll
  // whether or not anything had changed. Measured in a real browser with a
  // `MutationObserver` on the container: five nodes removed and five added per
  // poll while the reader sat still, and focus went to `body`.
  //
  // The poll is driven through `clockOf('groups')` rather than by awaiting a
  // settle, and that is the whole difference between this test proving something
  // and proving nothing: the rebuild only happens when `refreshGroups` actually
  // runs, which nothing but an armed clock does. The first version of this test
  // awaited a macrotask, and the mutation that removes the signature check
  // altogether left it green.
  t.onCleanup(() => {
    host.catalog = null
    registry.get('model').click()
  })

  const { menu } = await openModelMenu(MENU_CATALOG)
  const rows = menu.querySelectorAll('button')
  rows[1].focus()

  // The guard that makes the rest mean something. `drawModelMenu` is reached
  // through `drawModel`, and `drawModel` only calls it while `menuOpen` is true
  // — so if the picker is not actually open, the poll below proves nothing at
  // all about whether a repaint rebuilds it. The mutation that removes the
  // signature check outright leaves this test green without this assertion.
  assert.equal(menu.hidden, false, 'the picker must be open, or the poll below never reaches it')

  // A poll answering with the same catalog: the rows are identical, so the DOM
  // already says everything this repaint would say.
  await clockOf('groups')
  assert.equal(menu.hidden, false, 'the poll must leave the picker open')

  const after = menu.querySelectorAll('button')
  assert.equal(after.length, rows.length, 'the same catalog must draw the same rows')
  assert.equal(after[1], rows[1], 'the row must be the same node, not a replacement of it')
  assert.equal(document.activeElement, rows[1], 'focus must still be on the row it was on')
})

// ─────────────────────────────────────────────────────────────────────────────
// The draft outlives the panel
// ─────────────────────────────────────────────────────────────────────────────

/** Put text in the composer the way a person typing would. */
function typeDraft(text) {
  input.value = text
  input.emit('input', {})
}

/**
 * Wait for the panel's unawaited writes to reach the store.
 *
 * The writes are deliberately not awaited by the panel — awaiting them would put
 * a storage round trip inside the keystroke — so a test that reads storage has
 * to let the microtask queue drain first.
 *
 * @returns {Promise<void>} Resolves once queued writes have landed.
 */
async function letWritesLand() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
}

/** Show one session the way a person does, by clicking its row in the history. */
function selectSession(title) {
  registry.get('title').click()
  const history = registry.get('history')
  const row = [...history.querySelectorAll('button')].find((button) =>
    button.textContent.includes(title),
  )
  assert.ok(row, `the history must list a row for ${title}`)
  row.click()
}

test('what was typed is still in storage when the panel is closed and reopened', async (t) => {
  // The defect this covers: `drafts` was a plain in-memory `Map`, while
  // `panelSessionId` was persisted. So the panel remembered *which conversation*
  // you were reading and forgot *what you had written in it* — the one thing a
  // closed side panel must not lose, and the commonest way to lose it, because
  // closing and reopening the side panel is how the thing is used.
  //
  // Confirmed in a real Chrome before it was fixed: type, reload the panel, and
  // the composer came back empty while the header still named the session.
  t.onCleanup(() => typeDraft(''))

  const typed = 'half a question I have not sent yet'
  typeDraft(typed)
  await letWritesLand()

  const stored = await storage.snapshot()
  assert.equal(
    stored[`panelDraft:${SESSION}`],
    typed,
    'the composer must be written where the next opening of the panel will look',
  )
})

test('an emptied composer leaves no draft behind', async (t) => {
  // Deleting the text is not the same as having an empty draft. Keeping the key
  // would leave a row in storage for every session ever visited.
  t.onCleanup(() => typeDraft(''))

  typeDraft('something')
  await letWritesLand()
  typeDraft('')
  await letWritesLand()

  const stored = await storage.snapshot()
  assert.equal(
    stored[`panelDraft:${SESSION}`],
    undefined,
    'clearing the composer must remove the key rather than store an empty string',
  )
})

test('a draft is sent, not kept', async (t) => {
  // The other half of persistence: text that has been sent is not a draft any
  // more, and a reopening that put it back would offer to send it twice.
  t.onCleanup(() => {
    host.sent.length = 0
    typeDraft('')
  })

  // Counted from the current total rather than from zero: another test in this
  // file may already have sent something, and the runner decides the order.
  const sentBefore = host.sent.length
  typeDraft('send me')
  await letWritesLand()
  assert.equal(
    (await storage.snapshot())[`panelDraft:${SESSION}`],
    'send me',
    'the draft must be stored while it is still a draft',
  )

  sendButton.click()
  await settle()
  await letWritesLand()

  assert.equal(host.sent.length, sentBefore + 1, 'the click must have sent the message')
  assert.equal(input.value, '', 'a sent message leaves the composer empty')
  assert.equal(
    (await storage.snapshot())[`panelDraft:${SESSION}`],
    undefined,
    'a sent message must not come back as a draft on the next opening',
  )
})

// ---------------------------------------------------------------------------
// Finding a word in a long conversation
// ---------------------------------------------------------------------------
//
// These live here, before the two tests below load a *second* copy of the panel
// module to get a genuinely fresh instance. Those copies attach their own
// listeners to the same stub elements, so from that point on one emitted click
// reaches two or three live panels and every count in these tests doubles. The
// first version of them ran at the end of the file and read `3 !== 1` on
// `host.searches.length` for exactly that reason — the assertion was right and
// its position was wrong.

/**
 * A long transcript with a needle far outside the panel's opening window.
 *
 * The point of search is the part that is *not* on screen. `PAGE_ROWS` is 60, so
 * a needle at row 10 of 600 is invisible when the panel opens — which is exactly
 * the case an implementation that searched the rows it held would get wrong,
 * reporting the word as absent from the reader's own conversation.
 *
 * @param {number} turns - How many turns to build.
 * @returns {object[]} The rows.
 */
function longTranscript(turns) {
  const rows = []
  for (let index = 0; index < turns; index += 1) {
    rows.push({ kind: 'user', text: `question ${index}` })
    rows.push({ kind: 'assistant', text: `answer ${index}` })
    if (index === 4) rows.push({ kind: 'assistant', text: 'the zebra conclusion' })
    // A row whose match is *hidden* until it is opened, and the only one here.
    // Without it this fixture held nothing but user and assistant rows, whose
    // text is on screen the moment the window moves — so "the reader was taken to
    // a row that shows none of their word" could not be driven from these tests
    // at all. A reasoning row draws as 「思考中 ⌄」 and keeps its text behind the
    // toggle, which is the shape the defect needs.
    if (index === 40) rows.push({ kind: 'reasoning', text: 'a zebra in the reasoning' })
  }
  return rows
}

/**
 * How many matches the fixture holds, as a `1/N` pattern for the count on screen.
 *
 * Asked of the host's own matcher rather than written as a literal. The count is
 * a fact about the fixture, and a literal here is a second copy of it: adding one
 * reasoning row to `longTranscript` broke three tests that had hardcoded `1/1`,
 * for a reason none of them was about.
 */
function countOf(needle) {
  return new RegExp(`1/${findRows(host.messages, needle).length}`)
}

/**
 * Is the find bar open?
 *
 * Read from `aria-expanded`, which the panel writes, and not from `hidden` on the
 * bar. The DOM shim does not carry the markup's `hidden` attribute — it fabricates
 * an element per id on first use — so `#find.hidden` reads `false` whether the bar
 * is open or not. A guard written on it skipped the click and then passed, which is
 * a guard that asks nothing.
 *
 * @returns {boolean} True while the bar is showing.
 */
function findBarOpen() {
  return registry.get('find-open').getAttribute('aria-expanded') === 'true'
}

/**
 * Close the find bar however the previous test left it.
 *
 * `#find-open` is a *toggle*, so clicking it unconditionally does the opposite of
 * what a caller means whenever the bar was already open. Going through this
 * helper is what makes "start from a closed bar" idempotent rather than a bet on
 * the previous test's ending state.
 *
 * @returns {void}
 */
function closeFindBar() {
  if (findBarOpen()) registry.get('find-open').emit('click')
}

/**
 * Put the session list on screen however the previous test left the view.
 *
 * `#title` is a toggle, and the suite shares one panel — so a test that clicked it
 * unconditionally *closed* a list the previous test had left open, and the
 * failure surfaced there rather than here. Same hazard, same fix, as
 * `closeFindBar` one screen up.
 *
 * @returns {Promise<void>} Resolves once the view has settled.
 */
async function openHistory() {
  if (currentViewInPanel() === 'chat') registry.get('title').click()
  await settle()
}

/**
 * Put the conversation on screen however the previous test left the view.
 *
 * The counterpart to `openHistory`, and needed for the same reason: a test that
 * means to type "over the conversation" has to know it is looking at one, or it
 * types the word into the session list on the other side of the toggle.
 *
 * @returns {Promise<void>} Resolves once the view has settled.
 */
async function openChat() {
  if (currentViewInPanel() === 'history') registry.get('title').click()
  await settle()
}

/** Put a long transcript on screen and open the find bar, with no query yet. */
async function openFindBar() {
  // An earlier test can leave a turn running, and while one is the send button is
  // a *stop* button — disabled, so the send assertions below would be driving a
  // control that cannot act. This helper is the file's own way of clearing that.
  await settleToIdle()
  host.messages = longTranscript(300)
  // Read once first: `hasEarlier`, `windowTotal` and the drawn rows are all
  // refreshed by a read, so a test that skipped this would be driving a panel
  // that still believes it holds the previous fixture.
  await settle()
  // Opened only if it is not already: an unconditional click *closes* a bar an
  // earlier test left open, and then the count on screen is the previous query's
  // and the assertions fail for a reason that has nothing to do with searching.
  // Same mistake the browser probe made.
  if (!findBarOpen()) {
    registry.get('find-open').emit('click')
    await settleMacrotask()
  }
  assert.equal(findBarOpen(), true, 'the find bar must be open for this to mean anything')
  return registry.get('find-input')
}

/**
 * Open the bar and search for `zebra`.
 *
 * Typing a query is also a request to be taken to the first match, so this
 * settles a window read as well as the search itself.
 */
async function searchForZebra() {
  const field = await openFindBar()
  field.value = 'zebra'
  field.emit('input')
  await settle()
  return field
}

test('a search reaches rows the panel has never held', async (t) => {
  const field = await openFindBar()

  // The premise, asserted rather than assumed: `PAGE_ROWS` rows of 600 do not
  // contain the needle, so a search answered from the window would find nothing.
  // Checked before the query is typed, because typing one is itself a request to
  // go to the match — after it, the needle is on screen by design and this
  // premise would read as a failure of the feature it is here to protect.
  assert.equal(host.reads.at(-1).limit, 60, 'the panel opens on one page')
  assert.ok(
    !registry.get('transcript').textContent.includes('zebra'),
    'the needle must start off screen, or this test proves nothing',
  )

  field.value = 'zebra'
  field.emit('input')
  await settle()

  assert.equal(host.searches.length, 1, 'the panel must ask the host, which holds every row')
  assert.equal(host.searches[0].query, 'zebra')
  // The count is asked of the real matcher rather than written here, so adding a
  // row to the fixture moves this test and the panel together.
  assert.match(registry.get('find-count').textContent, countOf('zebra'))

  // The window moved, named by an absolute row rather than a count from the end,
  // because a count from the end is not a position in a conversation that is
  // still being written to.
  const jumped = host.reads.at(-1)
  assert.ok(Number.isInteger(jumped.end), `the jump must name an absolute row, got ${JSON.stringify(jumped)}`)
  assert.ok(jumped.end < host.messages.length, 'and it must not be the end of the session')
  assert.ok(registry.get('transcript').textContent.includes('zebra'), 'the match is on screen')
})

test('typing a query goes to the match, not just counts it', async (t) => {
  const field = await openFindBar()
  const before = host.reads.at(-1)

  field.value = 'zebra'
  field.emit('input')
  await settle()

  // Measured in a real browser: the count read `1/3` and the first match was on
  // screen nowhere — the panel had answered the question but not moved, so the
  // reader's next act was to guess which arrow to press. Typing a query is a
  // request to be taken to it.
  assert.notEqual(host.reads.at(-1), before, 'the window must have moved')
  assert.ok(Number.isInteger(host.reads.at(-1).end), 'and it must move by absolute row')
  assert.ok(
    registry.get('transcript').textContent.includes('zebra'),
    'the match the count names must be the match on screen',
  )
})

test('a match inside a closed row is opened, so the reader sees their word', async (t) => {
  // The fixture's reasoning row carries the needle and draws as 「思考中 ⌄」, so
  // this is the shape the reader complained about: taken to a row whose entire
  // visible text is that toggle.
  await openFindBar()
  const field = registry.get('find-input')
  field.value = 'zebra'
  field.emit('input')
  await settle()

  const body = registry.get('transcript').querySelector('.reasoning-body')
  assert.notEqual(body, null, 'the row hiding the match must be opened')
  assert.ok(
    body.textContent.includes('zebra'),
    `and it must be the row that holds the match, got ${JSON.stringify(body.textContent)}`,
  )
  assert.equal(
    registry.get('transcript').querySelector('.reasoning-toggle').getAttribute('aria-expanded'),
    'true',
    'the control must say it is open, not only look it',
  )
})

test('a row matched on what it already draws is not opened', async (t) => {
  const field = await openFindBar()
  // The needle is in the name and in the arguments — both of which a closed tool
  // row draws — while the failure behind the click has none of it. So there is
  // nothing to reveal, and the row must be left exactly as the reader had it.
  host.messages = [
    { kind: 'user', text: 'go' },
    { kind: 'tool', callId: 'c1', name: 'read_zebra', summary: 'zebra.txt', status: 'error', failure: 'permission denied' },
  ]
  await clockOf('transcript')

  field.value = 'zebra'
  field.emit('input')
  await settle()

  assert.ok(
    registry.get('transcript').textContent.includes('zebra'),
    'the match is on screen without any help',
  )
  // Not "was something opened" but "was this row left alone": the check that
  // decides it is whether the needle is in the part the row hides, and a version
  // that opened every row it landed on would satisfy the reveal test above.
  assert.equal(
    registry.get('transcript').querySelector('.tool-failure'),
    null,
    'a row whose match is already visible must not be opened',
  )
  assert.equal(
    registry.get('transcript').querySelector('.tool').getAttribute('aria-expanded'),
    'false',
    'and its control must still say it is closed',
  )
})

test('a repaint leaves the match marked', async (t) => {
  const field = await openFindBar()
  // A row that is still changing, which is what makes a repaint rebuild it:
  // `reconcileRows` keeps the node of a row whose data is unchanged, so a poll
  // over an idle transcript replaces nothing and this test would pass against a
  // panel that never restored anything. A tool call completing under the reader's
  // eye is the ordinary case that does replace a node.
  host.messages = [
    { kind: 'user', text: 'go' },
    { kind: 'tool', callId: 'c1', name: 'read_file', summary: 'zebra.txt', status: 'pending' },
  ]
  await clockOf('transcript')

  field.value = 'zebra'
  field.emit('input')
  await settle()
  assert.equal(registry.get('transcript').querySelectorAll('.hit').length, 1, 'the search marks its match')
  assert.equal(highlightOf('dsh-needle').length, 1, 'and paints the needle')

  // The call finishes. The row's text is the same but its status is not, so the
  // node is rebuilt — and the outline and the ranges were on the node that went.
  host.messages = [
    { kind: 'user', text: 'go' },
    { kind: 'tool', callId: 'c1', name: 'read_file', summary: 'zebra.txt', status: 'ok' },
  ]
  await clockOf('transcript')

  assert.equal(
    registry.get('transcript').querySelectorAll('.hit').length,
    1,
    'the row the reader was sent to must still be marked after it was rebuilt',
  )
  // The ranges address text nodes, so a rebuilt row leaves them pointing at nodes
  // that are no longer in the document — the paint would simply stop.
  assert.equal(highlightOf('dsh-needle').length, 1, 'and the needle must be painted again')
})

test('the needle itself is marked, not the whole row', async (t) => {
  await openFindBar()
  const field = registry.get('find-input')
  field.value = 'zebra'
  field.emit('input')
  await settle()

  // The outline says which row; on an answer taller than the screen it does not
  // say where in it, and the reader hunts inside a box they were already told is
  // the right one. Chrome's own find marks the characters.
  const ranges = highlightOf('dsh-needle')
  assert.equal(ranges.length, 1, `exactly the match must be marked, got ${ranges.length}`)
  // The text of the range, not the fact that a range exists: a range spanning the
  // whole row would satisfy "something was marked" while painting the entire
  // answer and making the needle harder to find than before.
  assert.equal(ranges[0].toString(), 'zebra', 'the marked text must be the needle')
})

test('every row of the conversation is one item of one list', async () => {
  // Measured in a real browser before this test existed: `#transcript` exposed 72
  // nodes at depth 7 with no list, no listitem and no heading — one flat run of
  // `StaticText`. Everything was *present* and nothing was *navigable*: a screen
  // reader user could read the conversation from the top and had no way to move
  // between messages, which is the difference between a document and a pile.
  //
  // The assertion walks the row kinds rather than naming one, because the defect
  // this guards against is a kind being forgotten. A reasoning row's element is
  // `.reasoning` and not `.row` — that is how it escaped the search outline a
  // round earlier — and the transient rows are direct children of the list too.
  //
  // The container's own `role="list"` is not asserted here: it is written in the
  // markup, and this file drives the module against a shim that does not parse
  // markup. `panel-geometry.test.js` reads the source and checks that half.
  await show([
    { kind: 'user', text: '第一个问题' },
    { kind: 'reasoning', text: '想一想' },
    { kind: 'tool', callId: 'c1', name: 'read_file', summary: 'a.md', status: 'ok' },
    { kind: 'assistant', text: '第一个回答' },
    { kind: 'failed', code: 'MISSING_CREDENTIAL', text: 'no key' },
    { kind: 'context', text: 'workspace' },
  ])

  const children = transcript.children
  assert.ok(children.length >= 6, `the fixture did not draw six rows, got ${children.length}`)
  const untagged = children
    .filter((child) => child.getAttribute('role') !== 'listitem')
    .map((child) => child.className)
  assert.deepEqual(
    untagged,
    [],
    'a direct child of the list with no item role is a list that only claims to be one',
  )
  // The reasoning row is named explicitly, because a walk that filters on `.row`
  // silently omits it and would report a clean result for an incomplete check.
  assert.equal(
    transcript.querySelector('.reasoning').getAttribute('role'),
    'listitem',
    'the reasoning row is a `.reasoning`, not a `.row`, and must not be skipped',
  )
})

test('the waiting and streaming rows are items of the same list', async () => {
  // They are drawn by renderers of their own and appended behind the rows, which
  // is exactly why a rule written inside `reconcileRows` would miss them. The
  // static fixtures never show these states, so the gap would only ever appear
  // for someone watching a turn run.
  await idle()
  host.running = true
  startAttempt()

  const working = transcript.querySelector('.working')
  assert.notEqual(working, null, 'the waiting row was not drawn, so this proves nothing')
  assert.equal(working.getAttribute('role'), 'listitem', 'the waiting row is part of the conversation')

  // The streaming preview is the other transient child, and it is drawn by a
  // third renderer — the two would go out of step if either were left out.
  deliver({ sessionId: SESSION, kind: 'text', text: 'streaming now' })
  await settle()
  const live = transcript.querySelector('.live')
  assert.notEqual(live, null, 'the streaming row was not drawn, so this proves nothing')
  assert.equal(live.getAttribute('role'), 'listitem', 'the streaming row is part of the conversation')

  host.running = false
})

test('a session is an item that still announces itself as a button', async (t) => {
  // The trap this test exists for: a role *overrides* the element's own. Writing
  // `role="listitem"` straight onto the session button was measured in a real
  // browser and dropped `button` from the computed roles — the row kept its place
  // in the list and stopped being announced as something that can be activated.
  // The item and the control therefore have to be two elements.
  await clockOf('groups')
  if (currentViewInPanel() === 'chat') {
    registry.get('title').click()
    await settle()
  }

  const items = registry.get('history').querySelectorAll('.session-item')
  assert.ok(items.length >= 1, `expected a session list, got ${items.length} items`)
  for (const item of items) {
    assert.equal(item.getAttribute('role'), 'listitem', 'the wrapper is the item the list owns')
  }
  const buttons = registry.get('history').querySelectorAll('.session')
  assert.equal(buttons.length, items.length, 'every item must still hold its session control')
  for (const button of buttons) {
    assert.equal(button.tagName, 'BUTTON', 'the control inside the item must still be a button')
    assert.equal(
      button.getAttribute('role'),
      null,
      'and it must not carry the item role, which would replace its own button role',
    )
  }

  // Back to the conversation, where every other test expects to be. Leaving the
  // panel on the session list hid the way back to the newest rows and failed a
  // test three hundred lines further down — a leak that looks like someone else's
  // defect.
  registry.get('title').click()
  await settle()
})

test('a closed row that hides the match is opened, and its failure shown', async (t) => {
  // The same shape as the reasoning row, on the other kind that hides text: a
  // tool row draws its name and arguments and keeps the failure behind a click.
  const field = await openFindBar()
  // Set after the bar is open, because `openFindBar` loads its own fixture — and
  // the poll is what makes the panel hold these rows rather than the old ones.
  host.messages = [
    { kind: 'user', text: 'go' },
    { kind: 'tool', callId: 'c1', name: 'read_file', summary: 'a.txt', status: 'error', failure: 'no such file: zebra.txt' },
  ]
  await clockOf('transcript')

  field.value = 'zebra'
  field.emit('input')
  await settle()

  const failure = registry.get('transcript').querySelector('.tool-failure')
  assert.notEqual(failure, null, 'the row hiding the match must be opened')
  assert.ok(
    failure.textContent.includes('zebra'),
    `and it must hold the match, got ${JSON.stringify(failure.textContent)}`,
  )
  assert.equal(
    registry.get('transcript').querySelector('.tool').getAttribute('aria-expanded'),
    'true',
    'the control must say it is open',
  )
})

test('jump to latest leaves the window a search parked it in', async (t) => {
  await searchForZebra()
  registry.get('find-next').emit('click')
  await settle()
  assert.ok(Number.isInteger(host.reads.at(-1).end), 'the window is parked')

  // Measured in a real browser before this test existed: "jump to latest" scrolled
  // the *window* to its bottom, the last row stayed at 「第 11 个问题」 of 600, and
  // the newest content was unreachable. A scrollbar at the bottom is not the same
  // fact as the newest rows being on screen, and only the second is what the
  // control promises.
  registry.get('to-bottom').emit('click')
  await settle()

  assert.equal(host.reads.at(-1).end, undefined, 'returning to the newest rows drops the anchor')
  assert.ok(
    registry.get('transcript').textContent.includes('answer 299'),
    'the newest row must actually be on screen after "jump to latest"',
  )
})

test('the way back to the newest rows stays on screen while parked', async (t) => {
  await searchForZebra()
  registry.get('find-next').emit('click')
  await settle()
  assert.ok(Number.isInteger(host.reads.at(-1).end), 'the window is parked')

  // Measured in a real browser: the control that leaves the window hid itself
  // once the scrollbar reached the bottom of the *window* — because visibility
  // was decided by "is the scrollbar at the bottom", which is true while the
  // conversation continues far below. The reader was then stranded in the past
  // with no way back, which is the one failure this control exists to prevent.
  //
  // The DOM shim reports `scrollHeight` and `clientHeight` as 0, so "at the
  // bottom" is true here by construction: the parked window is the *only*
  // reason this button can be visible, which is exactly the fact under test.
  registry.get('transcript').measure({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 })
  registry.get('transcript').emit('scroll')
  await settle()

  assert.equal(registry.get('to-bottom').hidden, false, 'the only way back must not hide itself')
})

test('sending leaves the window a search parked it in', async (t) => {
  await searchForZebra()
  registry.get('find-next').emit('click')
  await settle()
  assert.ok(Number.isInteger(host.reads.at(-1).end), 'the window is parked')

  // Asking a question is the reader saying they are done looking at the past.
  // Parked, the reply arrives outside the window and they never see the answer to
  // the message they just sent.
  const composer = registry.get('input')
  composer.value = 'and now?'
  registry.get('send').emit('click')
  await settle()

  assert.equal(host.reads.at(-1).end, undefined, 'a send must return to the newest rows')
})

test('closing the find bar clears the query and hands focus back', async (t) => {
  const field = await searchForZebra()
  assert.equal(registry.get('transcript').querySelectorAll('.hit').length, 1, 'a match is marked')
  assert.equal(highlightOf('dsh-needle').length, 1, 'and the needle is painted')
  registry.get('find-close').emit('click')
  await settleMacrotask()

  assert.equal(field.value, '', 'reopening must be a fresh search, not the previous word')
  // Read from the button's own declaration, not `#find.hidden`: the shim does
  // not carry the markup's `hidden` attribute, so that property reads `true`
  // here whether the bar was closed or never opened at all.
  assert.equal(registry.get('find-open').getAttribute('aria-expanded'), 'false')
  // The marks are the search's own annotation, and they go with it. Left behind,
  // a row stays looking selected with nothing on screen to say what selected it —
  // and the needle keeps a word painted that no query any more explains.
  assert.equal(registry.get('transcript').querySelectorAll('.hit').length, 0, 'the outline must go')
  assert.equal(highlightOf('dsh-needle').length, 0, 'and the needle with it')
  // The same contract the model picker keeps: closing returns focus to the
  // control that opened it, so the next Tab does not start from the top.
  assert.equal(document.activeElement?.id, 'find-open')
  // This test is also the one that leaves the bar shut for whatever runs next,
  // which `searchForZebra` relies on: it opens only when the bar is closed, so a
  // test that left the bar open would be toggling it shut.
})

test('the find count never leaks a placeholder', async (t) => {
  await searchForZebra()

  // Measured in a real browser: the translator leaves an unmatched `{name}` in
  // the string verbatim, so passing `more` only when the list was truncated
  // rendered the literal text `1/1{more}` to the reader.
  //
  // Asserted as the exact finished string, not as "contains no braces". The
  // translator substitutes any key it is *given*, including one given as
  // `undefined` — so the other obvious way to get this wrong renders `1/1undefined`,
  // which has no braces in it and sailed through a braces-only check.
  assert.equal(
    registry.get('find-count').textContent,
    zh['find.count'].replace('{position}', '1').replace('{count}', String(findRows(host.messages, 'zebra').length)).replace('{more}', ''),
  )
})

test('a query with no matches does not keep the previous count', async (t) => {
  const field = await searchForZebra()
  assert.match(registry.get('find-count').textContent, countOf('zebra'))

  field.value = 'aardvark'
  field.emit('input')
  await settle()
  assert.equal(
    registry.get('find-count').textContent,
    zh['find.none'],
    'the previous query\'s count must not stand in for this one',
  )
})

test('a reply to a query the reader has left is not adopted', async (t) => {
  // The answer to `zebra` is held in flight while the reader types `aardvark`,
  // which is the ordinary case rather than a contrived one: searching a
  // 6969-row session takes long enough to type the next word into.
  //
  // `zebra` and `aardvark` are chosen so the two answers differ — one match
  // against none. A held reply that happens to say the same thing as the current
  // query's would make the assertion below true whether the late answer was
  // adopted or not, which is a test that cannot fail.
  let release = null
  host.holdSearch = new Promise((resolve) => { release = resolve })
  const field = await searchForZebra()
  assert.equal(host.searches.at(-1).query, 'zebra', 'the held request must be the one being left behind')

  field.value = 'aardvark'
  field.emit('input')
  await settle()
  assert.equal(host.searches.at(-1).query, 'aardvark')

  release()
  await settle()
  assert.equal(
    registry.get('find-count').textContent,
    zh['find.none'],
    'the late answer to `zebra` must not be drawn under the `aardvark` query',
  )
})

test('Ctrl+F opens the find bar from the conversation', async () => {
  // Measured in a real browser with real keystrokes before this existed: the
  // keystroke did nothing at all. A side panel has no native find for arbitrary
  // page content, so the reader got no bar, no error, and no way to learn the
  // panel had a search — the button in the header was the only entry point, and
  // it is a control they have to already know about.
  await settleToIdle()
  host.messages = longTranscript(60)
  await settle()

  // From a known-closed bar, so "it opened" means the keystroke opened it and not
  // that an earlier test left it open.
  closeFindBar()
  assert.equal(findBarOpen(), false, 'the bar must start closed, or this test proves nothing')

  // Focus on the conversation rather than on a text box: the shortcut is defined
  // to step aside while the reader is typing, and that is proved separately below.
  registry.get('transcript').focus()
  const prevented = []
  document.emit('keydown', {
    key: 'f',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault: () => prevented.push('ctrl+f'),
  })
  await settleMacrotask()

  assert.equal(findBarOpen(), true, 'Ctrl+F must open the panel’s own find bar')
  assert.deepEqual(prevented, ['ctrl+f'], 'and it must claim the keystroke it handled')
})

test('the shortcut steps aside while the reader is typing', async () => {
  // A shortcut that fires inside a text field is an obstacle, not a feature: the
  // composer, the find bar's own input, and the options form all take printable
  // keystrokes, and taking `Ctrl+F` away from a field the reader is in is how a
  // convenience becomes an interruption.
  await settleToIdle()
  host.messages = longTranscript(60)
  await settle()
  // Closed from wherever the previous test left it.
  closeFindBar()
  assert.equal(findBarOpen(), false, 'the bar must start closed, or this test proves nothing')

  const field = registry.get('input')
  field.focus()
  assert.equal(document.activeElement, field, 'focus must be in the composer for this to mean anything')

  const prevented = []
  document.emit('keydown', {
    key: 'f',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault: () => prevented.push('ctrl+f'),
  })
  await settleMacrotask()

  assert.equal(
    findBarOpen(),
    false,
    'Ctrl+F inside the composer must not steal the keystroke',
  )
  assert.deepEqual(prevented, [], 'and it must not claim it either')
})

test('a failed turn hands its question back to the composer', async () => {
  // A failed turn used to be a sentence and nothing else, and three of the
  // sentences this panel can write end in 「稍后再试」. There is no retry to
  // offer — the host cannot re-run a turn — so the recourse is to give the
  // reader their words back and let them decide.
  //
  // The question comes from the row, which is the host's answer to "which
  // message opened this turn". Reading upward instead would pick the assistant
  // line: the fixture deliberately puts one between the question and the failure.
  await settleToIdle()
  await show([
    { kind: 'user', text: '帮我把表格抓下来' },
    { kind: 'assistant', text: '好，我先建一个会话。' },
    { kind: 'failed', code: 'MISSING_CREDENTIAL', question: '帮我把表格抓下来', text: 'no key' },
  ])

  const button = transcript.querySelector('.failure-again')
  assert.notEqual(button, null, 'a failed turn that knows its question must offer a way out')
  assert.equal(registry.get('input').value, '', 'the box starts empty, or this proves nothing')
  assert.equal(
    button.closest('.row')?.dataset?.question,
    '帮我把表格抓下来',
    'the row must carry the question, or the click handler has nothing to restore',
  )

  button.click()
  await settle()

  assert.equal(registry.get('input').value, '帮我把表格抓下来')
  assert.equal(
    registry.get('send').disabled,
    false,
    'handing the question back is pointless if the send button stays disabled',
  )
})

test('a failed turn with no question of its own offers nothing', async () => {
  // A goal round or a scheduled wake-up opens a turn nobody typed into. Drawing
  // the button anyway would put words in the reader's mouth — and the words
  // would be from some earlier turn, since there is no question to find.
  await settleToIdle()
  await show([{ kind: 'failed', code: 'RATE_LIMIT', text: '429' }])

  assert.equal(transcript.querySelector('.failure') !== null, true, 'the failure itself must still be drawn')
  assert.equal(transcript.querySelector('.failure-again'), null)
})

test('handing the question back does not overwrite what the reader typed', async () => {
  // The second failure in the fixture. The reader has started typing again; the
  // restored question must not clobber it, and it must not be appended after it
  // either — the question came first in the conversation, so it reads first.
  await settleToIdle()
  await show([
    { kind: 'user', text: '先看看这个' },
    { kind: 'failed', code: 'MISSING_CREDENTIAL', question: '先看看这个', text: 'no key' },
  ])

  const field = registry.get('input')
  field.value = '我再补充一句'
  // `emit`, not `dispatchEvent`: the shim's elements have no `dispatchEvent`, and
  // the panel listens with `addEventListener`/`emit` throughout. Using the wrong
  // one throws rather than quietly failing, which is why this is worth saying.
  field.emit('input', { target: field })
  await settle()

  transcript.querySelector('.failure-again').click()
  await settle()

  assert.equal(field.value, '先看看这个\n\n我再补充一句')
  assert.equal(
    field.selectionStart,
    field.value.length,
    'the caret belongs at the end, so the reader keeps typing rather than retyping',
  )
})

test('Escape closes the find bar and hands focus back', async () => {
  // The bar is the layer a keyboard user is most likely to have opened with
  // `Ctrl+F` and then want gone. Escape answered the model menu and the history
  // but not this one, so the only way out was Tab to `#find-close`.
  await searchForZebra()
  assert.equal(findBarOpen(), true, 'the bar must be open, or this test proves nothing')

  document.emit('keydown', { key: 'Escape' })
  await settle()

  assert.equal(findBarOpen(), false, 'Escape must close the find bar')
  assert.equal(
    document.activeElement,
    registry.get('find-open'),
    'and focus must go back to the control that opened it, not to the body',
  )
})

test('the session list narrows with the find bar instead of searching the conversation', async (t) => {
  await settleToIdle()
  // The suite's own fixture is used as-is: two sessions titled "A session" and
  // "Another session". No fixture surgery — an earlier version of this test
  // replaced `host.groups`, and that changed which session the panel considered
  // current, breaking an unrelated test much later in the file. A test that
  // reconfigures the shared fixture is not testing this behaviour, it is editing
  // every test after it.
  t.onCleanup(() => closeFindBar())
  closeFindBar()
  await openHistory()

  const rows = () => registry.get('history').querySelectorAll('button.session')
  assert.equal(rows().length, 2, 'both sessions are listed before anything is typed')

  registry.get('find-open').click()
  await settle()
  assert.equal(findBarOpen(), true, 'the bar must be open, or this proves nothing')

  const field = registry.get('find-input')
  field.value = 'another'
  field.emit('input', { target: field })
  await settle()

  assert.equal(rows().length, 1, 'only the session whose title matches stays')
  assert.ok(
    rows()[0].textContent.includes('Another session'),
    'and the row kept is the matching one, not merely the first',
  )
  assert.equal(
    registry.get('find-count').textContent,
    '1 个会话',
    'the count is sessions, because sessions are what the reader is narrowing',
  )
  // The step-through arrows belong to the conversation: they walk matches inside
  // one session, and over a list of sessions there is no second match to step to.
  // Leaving them visible offers a control that cannot act on what is on screen.
  assert.equal(registry.get('find-prev').hidden, true, 'no match arrows over a session list')
  assert.equal(registry.get('find-next').hidden, true, 'in either direction')
  // The box names its subject. Guessing wrong is not recoverable by looking:
  // both views have a find bar that looks identical.
  assert.equal(field.placeholder, '按标题查找…', 'the box says what it searches')

  // Clearing restores the list rather than leaving it short for no visible reason.
  field.value = ''
  field.emit('input', { target: field })
  await settle()
  assert.equal(rows().length, 2, 'clearing the query brings the whole list back')
})

test('a query typed over a conversation does not filter the session list', async (t) => {
  await settleToIdle()
  t.onCleanup(() => closeFindBar())
  closeFindBar()
  // Over the conversation, where the bar searches the transcript. Said explicitly
  // rather than assumed: the previous test leaves the session list on screen, and
  // typing "over the conversation" while looking at the list writes the word into
  // the wrong view — which then reads as a product bug when it is the test's.
  await openChat()
  await openFindBar()
  const field = registry.get('find-input')
  field.value = 'zzzznothingmatchesthis'
  field.emit('input', { target: field })
  await settle()
  assert.equal(registry.get('find-count').textContent, '无结果', 'nothing in the conversation matches')

  // Now cross into the list with the bar open. The word was a question about the
  // conversation and means nothing here; left in force it empties a list of two
  // sessions the reader can see, which is the failure mode that makes a filter
  // untrustworthy — a list that is short for a reason nobody can see.
  await openHistory()
  assert.equal(currentViewInPanel(), 'history', 'the list is on screen')
  assert.equal(findBarOpen(), true, 'the bar is still open, so a stale value would be visible')
  assert.equal(
    registry.get('find-input').value,
    '',
    'the other view\'s query is dropped on the way in',
  )
  assert.equal(
    registry.get('history').querySelectorAll('button.session').length,
    2,
    'so the whole list is drawn',
  )
  // And the count describes what is on screen rather than what the conversation
  // answered: measured, a repaint skipped here left 「无结果」 above two rows that
  // were plainly there.
  assert.equal(registry.get('find-count').textContent, '2 个会话', 'the count follows the view')
  assert.equal(field.placeholder, '按标题查找…', 'and so does the box')
})

test('a long workspace folds its tail away, and one button brings it back', async (t) => {
  await settleToIdle()
  // The suite's own fixture is replaced here, which the find test above warns
  // against — but that warning is about replacing it *casually*. A list of two
  // sessions cannot fold, so the behaviour is unreachable from the shared
  // fixture, and restoring it in cleanup is what keeps the difference from
  // leaking into every test after this one.
  const many = Array.from({ length: 40 }, (_, index) => ({
    id: `session-many-${index}`,
    title: `Session number ${index}`,
    updatedAt: 0,
    running: false,
    blank: false,
  }))
  host.groups = [{ id: 'workspace-many', title: 'A workspace', sessions: [{ ...sessionRow() }, ...many] }]
  t.onCleanup(() => { host.groups = undefined })

  await clockOf('groups')
  await settle()
  await openHistory()

  const rows = () => registry.get('history').querySelectorAll('button.session')
  const more = () => registry.get('history').querySelectorAll('button.session-more')
  // `sessionRow()` is the 41st. Asserted as "a handful" rather than as five: what
  // matters is that a workspace this long does not draw all of it, not which
  // small number the panel settled on.
  const folded = rows().length
  assert.ok(folded > 0 && folded < 10, `a long workspace should draw a handful of rows, drew ${folded}`)
  assert.equal(more().length, 1, 'and offers the rest behind one control')
  assert.equal(more()[0].textContent, `展开其余 ${41 - folded} 个会话`, 'which says how many it is holding back')
  assert.equal(more()[0].getAttribute('aria-expanded'), 'false', 'and says which way it is set')

  more()[0].click()
  await settle()
  assert.equal(rows().length, 41, 'every session is reachable')
  assert.equal(more()[0].getAttribute('aria-expanded'), 'true', 'the control reports the list is open')
  assert.equal(more()[0].textContent, '收起', 'and offers the way back')

  more()[0].click()
  await settle()
  assert.equal(rows().length, folded, 'and folding again puts it back')
})

test('a running session is never folded away, whatever its position', async (t) => {
  await settleToIdle()
  // The harness's rule, which this mirrors: running sessions do not count against
  // the budget. A running session is the one whose row a reader is most likely to
  // be looking for, and folding it away would hide the session that is visibly
  // changing — the one thing that cannot be found anywhere else in the list.
  const many = Array.from({ length: 20 }, (_, index) => ({
    id: `session-run-${index}`,
    title: `Session number ${index}`,
    updatedAt: 0,
    running: index === 15,
    blank: false,
  }))
  host.groups = [{ id: 'workspace-run', title: 'A workspace', sessions: [{ ...sessionRow() }, ...many] }]
  t.onCleanup(() => { host.groups = undefined })

  await clockOf('groups')
  await settle()
  await openHistory()

  const running = registry.get('history')
    .querySelectorAll('button.session')
    .filter((row) => row.querySelectorAll('.session-dot').length > 0)
  assert.equal(running.length, 1, 'the running session is on screen')
  assert.ok(
    running[0].textContent.includes('Session number 15'),
    'and it is the one that was running, not merely a row that happens to be drawn',
  )
})

test('a session folded out of sight can still be found by its title', async (t) => {
  await settleToIdle()
  // Folding is only safe while the folded rows remain reachable. If the find bar
  // searched what is drawn rather than what exists, folding would not shorten a
  // list — it would lose sessions, and the reader would have no way to tell a
  // session they cannot find from one that is no longer there.
  const many = Array.from({ length: 30 }, (_, index) => ({
    id: `session-fold-${index}`,
    title: index === 29 ? 'The needle only lives in the tail' : `Session number ${index}`,
    updatedAt: 0,
    running: false,
    blank: false,
  }))
  host.groups = [{ id: 'workspace-fold', title: 'A workspace', sessions: [{ ...sessionRow() }, ...many] }]
  t.onCleanup(() => { host.groups = undefined })
  t.onCleanup(() => closeFindBar())

  await clockOf('groups')
  await settle()
  await openHistory()
  closeFindBar()
  await openHistory()

  // The needle is in the row folding removes, so it is not on screen to begin with.
  const drawn = registry.get('history').querySelectorAll('button.session')
  assert.ok(
    !drawn.some((row) => row.textContent.includes('The needle')),
    'the needle has to start off screen, or this proves nothing',
  )

  registry.get('find-open').click()
  await settle()
  const field = registry.get('find-input')
  field.value = 'needle'
  field.emit('input', { target: field })
  await settle()

  const found = registry.get('history').querySelectorAll('button.session')
  assert.equal(found.length, 1, 'the folded session is found')
  assert.ok(found[0].textContent.includes('The needle only lives in the tail'), 'and it is the right one')
})

test('a folded workspace stays folded through the poll that redraws the view', async (t) => {
  await settleToIdle()
  // `renderChrome` runs on every poll and redraws this view. An expansion held
  // anywhere but in the panel's own state folds itself back up while the reader
  // is looking at it — measured in this suite's sibling for the transcript's open
  // rows, and the same shape of bug here.
  const many = Array.from({ length: 20 }, (_, index) => ({
    id: `session-poll-${index}`,
    title: `Session number ${index}`,
    updatedAt: 0,
    running: false,
    blank: false,
  }))
  host.groups = [{ id: 'workspace-poll', title: 'A workspace', sessions: [{ ...sessionRow() }, ...many] }]
  t.onCleanup(() => { host.groups = undefined })

  await clockOf('groups')
  await settle()
  await openHistory()
  registry.get('history').querySelectorAll('button.session-more')[0].click()
  await settle()
  assert.equal(registry.get('history').querySelectorAll('button.session').length, 21, 'expanded first')

  await clockOf('groups')
  await openHistory()
  assert.equal(
    registry.get('history').querySelectorAll('button.session').length,
    21,
    'the poll repainted the list and it is still expanded',
  )
})

test('closing the find bar over the list stops narrowing it', async (t) => {
  await settleToIdle()
  // Two pieces of state sit behind one box. `setFind(false)` cleared the
  // transcript's query and left the list's, so closing the bar left the session
  // list short for a reason nothing on screen stated — measured, 152 rows where
  // the folded list would have drawn 20, and no visible cause for the missing
  // ones. A list that is short for an invisible reason is the failure mode this
  // panel's own comments call out by name.
  const many = Array.from({ length: 30 }, (_, index) => ({
    id: `session-close-${index}`,
    title: `Session number ${index}`,
    updatedAt: 0,
    running: false,
    blank: false,
  }))
  host.groups = [{ id: 'workspace-close', title: 'A workspace', sessions: [{ ...sessionRow() }, ...many] }]
  t.onCleanup(() => { host.groups = undefined })
  t.onCleanup(() => closeFindBar())

  await clockOf('groups')
  await settle()
  closeFindBar()
  await openHistory()

  const rows = () => registry.get('history').querySelectorAll('button.session')
  const unfiltered = rows().length

  registry.get('find-open').click()
  await settle()
  assert.equal(findBarOpen(), true, 'the bar must be open, or this proves nothing')
  const field = registry.get('find-input')
  field.value = 'number 1'
  field.emit('input', { target: field })
  await settle()
  assert.ok(rows().length !== unfiltered, 'the query has to narrow the list, or this proves nothing')

  registry.get('find-close').click()
  await settle()
  assert.equal(findBarOpen(), false, 'the bar is gone')
  assert.equal(
    rows().length,
    unfiltered,
    'and the list it was narrowing is whole again, rather than short for no visible reason',
  )
})

test('a phrase that is only in a conversation finds the session that holds it', async (t) => {
  // The list filter compares titles, and a title is derived from the opening
  // words of a conversation — so a reader who remembered a phrase from the middle
  // of one had nothing to type. Measured against the real corpus: four words that
  // appear in transcripts matched zero rows, while a word from a title matched
  // sixteen.
  await settleToIdle()
  t.onCleanup(() => { host.groups = undefined; host.sessionSearch = null })
  t.onCleanup(() => closeFindBar())
  host.groups = [{ id: 'workspace-hit', title: 'A workspace', sessions: [sessionRow()] }]
  await clockOf('groups')
  await settle()
  closeFindBar()
  await openHistory()

  registry.get('find-open').click()
  await settle()
  assert.equal(findBarOpen(), true, 'the bar must be open, or this proves nothing')
  const field = registry.get('find-input')
  field.value = 'zstdDecompressSync'
  field.emit('input', { target: field })
  await settle()

  // The title filter is what the panel can answer without a round trip, and on
  // this query it finds nothing — which is exactly the state that used to be the
  // end of the story.
  assert.equal(
    registry.get('history').querySelectorAll('button.session:not(.session-hit)').length,
    0,
    'no title contains this word, so the fast filter must come up empty — otherwise this proves nothing',
  )
  // The suite shares one panel, so `host.sessionSearches` already holds whatever
  // earlier tests typed. Only this test's query is asserted — and the assertion is
  // that the reader's word reached the host at all, which is what makes the row
  // below an answer rather than a coincidence.
  assert.ok(
    host.sessionSearches.some((body) => body.query === 'zstdDecompressSync'),
    `the host is asked which sessions contain the phrase; it was asked about ${JSON.stringify(host.sessionSearches.map((body) => body.query))}`,
  )

  // A hit is drawn once the host answers, with the excerpt that says *why* this
  // session — the part a title cannot carry.
  host.sessionSearch = [
    { sessionId: sessionRow().id, snippet: 'a line with zstdDecompressSync in it', seq: 12 },
  ]
  field.value = 'zstdDecompressSync '
  field.emit('input', { target: field })
  await settle()
  const hits = () => registry.get('history').querySelectorAll('button.session-hit')
  assert.equal(hits().length, 1, 'the session the host named is on screen')
  const drawn = hits()[0]
  const hitTitle = drawn.querySelector('.session-title')?.textContent ?? ''
  assert.ok(
    hitTitle.length > 0,
    'a hit names the session it belongs to; a row that cannot say which chat it is answers nothing',
  )
  // Not just "some text": the name has to come from the session list, or the row
  // is showing the reader an opaque id. Measured by mutation, replacing the title
  // with `hit.sessionId` left the suite green — so the assertion asks for the name
  // the panel actually holds for that session.
  assert.equal(
    hitTitle,
    sessionRow().title,
    `the row must show the session's own name, not its id (drew ${JSON.stringify(hitTitle)})`,
  )
  assert.equal(
    drawn.querySelector('.session-snippet')?.textContent,
    'a line with zstdDecompressSync in it',
    'the excerpt the host chose is the reason the row is there, so it is drawn as given',
  )
})

test('a search that could not run does not read as a search that found nothing', async (t) => {
  // An absent index and a genuine miss draw the same empty list. Only one of them
  // means the word is nowhere in the reader's history, so the panel has to say
  // which one happened — it cannot be left to the absence.
  await settleToIdle()
  t.onCleanup(() => { host.groups = undefined })
  t.onCleanup(() => closeFindBar())
  host.groups = [{ id: 'workspace-nosearch', title: 'A workspace', sessions: [sessionRow()] }]
  await clockOf('groups')
  await settle()
  closeFindBar()
  await openHistory()

  registry.get('find-open').click()
  await settle()
  const field = registry.get('find-input')
  field.value = 'zzzz'
  field.emit('input', { target: field })
  await settle()

  const notes = [...registry.get('history').querySelectorAll('.search-note')]
    .map((node) => node.textContent.trim())
  assert.equal(notes.length, 1, 'the reader is told something, rather than shown an empty list')
  assert.ok(
    notes[0].length > 0 && !notes[0].includes('sessionQuery'),
    `the note is for a reader, so it must not name a service: ${notes[0]}`,
  )
  assert.equal(
    registry.get('history').querySelectorAll('button.session-hit').length,
    0,
    'a search that did not run must not draw hits',
  )
})

test('a picture the reader sent is drawn, and its bytes are fetched by URL', async () => {  await settleToIdle()
  const id = `sha256:${'c'.repeat(64)}`
  host.messages = [
    {
      kind: 'user',
      text: '看这张图',
      images: [{ attachmentId: id, mediaType: 'image/png', bytes: 4096, width: 760, height: 1440, name: 'shot.png' }],
    },
    { kind: 'assistant', text: '看到了。' },
  ]
  await readTranscript()

  const shots = registry.get('transcript').querySelectorAll('.shot')
  assert.equal(shots.length, 1, 'the picture is on screen')
  const img = shots[0].querySelectorAll('img')[0]
  assert.ok(img !== undefined, 'drawn as a real image element')
  // The bytes travel by URL rather than inside the transcript: this machine's
  // own store holds images up to 3.6 MB, and the panel polls.
  assert.match(img.getAttribute('src'), /\/browser-bridge\/image\?/, 'fetched from the image route')
  assert.match(img.getAttribute('src'), new RegExp(encodeURIComponent(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'naming this exact attachment')
  assert.equal(img.getAttribute('alt'), 'shot.png', 'the reader’s own filename is the alt text')
  // Space is reserved before the bytes arrive, from the reference's own numbers,
  // or the transcript jumps when the picture loads.
  assert.equal(shots[0].style.aspectRatio, String(760 / 1440), 'the box is sized from the reference')
})

test('a message that is only a picture draws no empty bubble', async () => {
  await settleToIdle()
  const id = `sha256:${'d'.repeat(64)}`
  host.messages = [
    { kind: 'user', text: '', images: [{ attachmentId: id, mediaType: 'image/png', bytes: 10, width: 100, height: 50 }] },
  ]
  await readTranscript()

  const transcript = registry.get('transcript')
  assert.equal(transcript.querySelectorAll('.shot').length, 1, 'the picture is there')
  assert.equal(
    transcript.querySelectorAll('.bubble').length,
    0,
    'and no message-shaped hole above it: a captionless picture has nothing to put in a bubble',
  )
})

test('two picture-only messages do not collide as one row', async () => {
  // `rowKey` used to be the visible text alone, and a picture-only message has
  // none — so two of them would share a key, and the open sets (which are keyed
  // by it) would treat them as the same row.
  await settleToIdle()
  const first = `sha256:${'e'.repeat(64)}`
  const second = `sha256:${'f'.repeat(64)}`
  host.messages = [
    { kind: 'user', text: '', images: [{ attachmentId: first, mediaType: 'image/png', bytes: 10, width: 10, height: 10 }] },
    { kind: 'assistant', text: 'ok' },
    { kind: 'user', text: '', images: [{ attachmentId: second, mediaType: 'image/png', bytes: 10, width: 10, height: 10 }] },
  ]
  await readTranscript()

  const transcript = registry.get('transcript')
  const shots = transcript.querySelectorAll('.shot')
  assert.equal(shots.length, 2, 'both messages are on screen')
  const sources = shots.map((shot) => shot.querySelectorAll('img')[0].getAttribute('src'))
  assert.notEqual(sources[0], sources[1], 'and they are two different pictures, not one drawn twice')
})

test('narrowing the panel does not move the row being read', async () => {
  // The sidebar is resized by dragging its edge, and the panel is live while that
  // happens. A narrower column reflows every row — the same sentence needs more
  // lines — so the content above the viewport gets taller and everything below it
  // slides down. Measured in a real browser: reading an answer at 380px and
  // narrowing to 260px grew the transcript from 5109px to 6159px, left
  // `scrollTop` untouched, and put the reader eight rows further back, on a
  // question they had already read.
  //
  // `drawTranscript` already compensates for a *redraw*, by measuring what was
  // added. A resize is not a redraw, so that path never runs and nothing
  // compensated. The panel turns off the browser's own scroll anchoring
  // (`overflow-anchor` in `sidepanel.html`, because it fights that manual
  // restore), so this case is the panel's to handle.
  // `openChat` first: an earlier test in this file can leave the panel showing
  // the session list, where `view` is not `'chat'` and the resize handler returns
  // early. Without this the test drives a panel that is not in the state it is
  // about — measured, `view` was `history` and the transcript held three rows.
  await openChat()
  await settleToIdle()
  // And an earlier test can leave a *search* parked, which shows a window around
  // a match rather than the newest rows: `host.reads` still carried `end: 96`, so
  // the panel drew three rows of a different part of the conversation. Closing
  // the bar clears the query; the window itself is left behind, so the send path
  // is what returns the panel to the newest rows.
  closeFindBar()
  const composer = registry.get('input')
  composer.value = 'back to the newest rows'
  registry.get('send').emit('click')
  await settle()

  host.messages = longTranscript(300)
  await settle()

  const transcript = registry.get('transcript')
  const rows = transcript.children
  assert.ok(rows.length > 4, 'the fixture has to be long enough to scroll')

  // The reader is in the middle of the conversation, not at either end.
  transcript.measure({ scrollTop: 600, scrollHeight: 2000, clientHeight: 500 })
  // The scroller's own top edge sits 30px down the viewport, so "how far below the
  // top of the scroller is this row" is a real subtraction. With everything at
  // zero, an implementation that forgot to subtract it would still pass.
  transcript.rectTop = 30
  for (const [index, row] of rows.entries()) {
    row.offsetHeight = 100
    row.rectTop = 30 + (index - 2) * 100 + 40
  }
  // The scroll is what records the anchor, and it names the node the reader is on
  // rather than an index — which is what lets it survive a window that grows
  // upwards.
  transcript.emit('scroll')

  const anchorRow = rows[2]
  assert.equal(
    anchorRow.getBoundingClientRect().top - transcript.getBoundingClientRect().top,
    40,
    'the fixture has to put the anchor where this test then asks about it',
  )

  // The drag, as a reflow: every row needs more lines, so the text above the
  // viewport pushes the anchor down — and the transcript as a whole gets taller
  // with it. Both happen together, and the second is what makes "just add the
  // difference in `scrollHeight`" look like a reasonable implementation. It is
  // not: the two numbers are unrelated, and only the anchor's own movement says
  // how far the text under the reader actually went.
  for (const row of rows) row.rectTop += 75
  transcript.scrollHeight = 2200

  for (const listener of windowListeners.get('resize') ?? []) listener()

  assert.equal(
    transcript.scrollTop,
    675,
    'the offset must take up exactly what the anchor moved by, not the height change',
  )
})

test('a panel pinned to the bottom stays at the bottom when it is resized', async () => {
  // The other half of the same gesture, and the one that is wrong in the opposite
  // direction. Somebody at the newest message is anchored to the *end* of the
  // transcript, not to a row: a reflow moves that end further away, so keeping
  // `scrollTop` unchanged drops them behind the newest message they were reading.
  // Same reason as the test above: this one is also about the chat view.
  await openChat()
  await settleToIdle()
  host.messages = longTranscript(300)
  await settle()
  await openChat()

  const transcript = registry.get('transcript')
  transcript.measure({ scrollTop: 1500, scrollHeight: 2000, clientHeight: 500 })
  transcript.emit('scroll')

  for (const listener of windowListeners.get('resize') ?? []) listener()

  assert.equal(
    transcript.scrollTop,
    transcript.scrollHeight,
    'a reader at the bottom must be sent back to the bottom, not left where the offset was',
  )
})

test('the context reading shows the whole truth or a smaller one, never a made-up one', async () => {
  // The panel had no token accounting at all before this, so a reader could not
  // tell a fresh conversation from one about to be compacted. The host now
  // reports what the log says, and the panel draws it.
  //
  // The assertion that matters is the *second* one. The window comes from a
  // `request/context` event, and only 77 of this machine's logs carry one — so a
  // session with usage and no recorded window is a real state. Dividing by a
  // window nobody stated would put a number on screen that no evidence supports,
  // which is the failure this test exists to prevent: the reading must degrade to
  // the count alone rather than invent a denominator.
  const readout = registry.get('occupancy')

  await settleToIdle()
  host.messages = [{ kind: 'user', text: 'hi' }, { kind: 'assistant', text: 'hello' }]
  await settle()

  // With a window, both halves.
  host.occupancy = { usedTokens: 461234, contextWindow: 1000000, model: 'deepseek-v4.1-flash' }
  await readTranscript()
  assert.equal(readout.hidden, false, 'the reading has to be on screen when the host reports it')
  assert.equal(readout.textContent, '461k / 1M', 'both halves, abbreviated to what the bar has room for')
  // The exact numbers have to survive somewhere: the visible form is an
  // abbreviation, and "461k" read aloud is not a number anyone can use.
  assert.match(readout.title, /461234/, 'the title must carry the exact used count, not the abbreviation')
  assert.match(readout.title, /1000000/, 'the title must carry the exact window, not the abbreviation')

  // Without one, the count alone — and specifically no trailing separator. The
  // pair template substituted with an empty second half renders `461k /`, which
  // on screen reads as a label that failed to finish.
  host.occupancy = { usedTokens: 461234, contextWindow: null, model: '' }
  await readTranscript()
  assert.equal(readout.hidden, false, 'a count with no window is still worth showing')
  assert.equal(
    readout.textContent.includes('/'),
    false,
    `the reading shows a separator with nothing after it: "${readout.textContent}"`,
  )
  assert.match(readout.textContent, /461k/, 'the count itself must still be there')

  // A session with no usage at all must clear it, not inherit the last one. This
  // is the defect class this panel has hit before — remembered state keyed by
  // nothing, so it describes whatever was on screen a moment ago. A reading that
  // said 461k while the reader looked at a brand-new conversation would be a
  // number about a different conversation.
  host.occupancy = { usedTokens: null, contextWindow: null, model: '' }
  await readTranscript()
  assert.equal(
    readout.hidden,
    true,
    'the reading must clear when the session in front of the reader has no usage of its own',
  )
})

/**
 * Every row's `data-day`, paired with its message text.
 *
 * The marker is an attribute rather than an element, so this is the only way to
 * read it — and reading it rather than the CSS is deliberate: a rule that draws
 * nothing still leaves the attribute behind, so the assertions below also check
 * that the stylesheet actually paints what the attribute names.
 *
 * @returns {Array<{ day: string, text: string, kind: string }>} One entry per row.
 */
function dayMarks() {
  return [...registry.get('transcript').children].map((node) => ({
    day: node.getAttribute('data-day') ?? '',
    text: (node.textContent ?? '').trim().slice(0, 20),
    kind: node.dataset.kind ?? '',
  }))
}

const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE

/** Two messages a day apart, then one an hour after the second. */
function messagesAcrossDays() {
  const noon = new Date()
  noon.setHours(14, 0, 0, 0)
  const base = noon.getTime()
  return [
    { kind: 'user', text: 'two days ago', at: base - 2 * DAY },
    { kind: 'assistant', text: 'answer from two days ago', at: base - 2 * DAY + MINUTE },
    { kind: 'user', text: 'yesterday', at: base - DAY },
    { kind: 'assistant', text: 'answer from yesterday', at: base - DAY + MINUTE },
    { kind: 'user', text: 'today', at: base },
    { kind: 'assistant', text: 'answer from today', at: base + MINUTE },
  ]
}

test('a day marker lands on the row that opens each day, and only there', async () => {
  await openChat()
  host.messages = messagesAcrossDays()
  await readTranscript()

  const marks = dayMarks()
  assert.equal(marks.length, 6, `expected six rows, got ${marks.length}`)

  // The marker belongs to the first row of a day, not to every row of it. Six
  // rows across three days is three markers; a rule that marked each row would
  // put a date above every single line.
  const marked = marks.map((mark) => mark.day)
  assert.deepEqual(
    marked.filter((day) => day !== '').length,
    3,
    `expected three markers, got ${JSON.stringify(marked)}`,
  )
  assert.equal(marks[0].day !== '', true, 'the first row of the window must name its day')
  assert.equal(marks[2].day !== '', true, 'the row that opens the second day must be marked')
  assert.equal(marks[4].day !== '', true, 'the row that opens the third day must be marked')
  // And the ones inside a day are bare, which is what makes the markers mean
  // something rather than being decoration on every row.
  assert.equal(marks[1].day, '', 'the answer inside the same day must carry no marker')
  assert.equal(marks[3].day, '', 'the answer inside the same day must carry no marker')
  assert.equal(marks[5].day, '', 'the answer inside the same day must carry no marker')

  // The window's first row opens the window whether or not it opens a day. If the
  // top of the transcript is unlabelled, a reader who pages back cannot tell
  // whether what they just revealed is from an hour ago or from last week.
  host.messages = [
    { kind: 'user', text: 'no stamp at all' },
    { kind: 'assistant', text: 'the first stamped row opens the window', at: new Date().setHours(14, 0, 0, 0) },
  ]
  await readTranscript()
  const after = dayMarks()
  assert.equal(
    after[1].day !== '',
    true,
    'the first row that can say when it happened must name its day, even mid-conversation',
  )
  assert.equal(
    after[0].day,
    '',
    'a row the host could not time must not claim a day',
  )
})

test('a marker is cleared when the window grows under the row that had it', async () => {
  // The failure this guards is the one the keyed repaint makes possible: a node
  // is reused across reads, so a marker written on one pass is still on that node
  // on the next unless it is taken off again. When the window grows upward the
  // rows shift, and a stale marker would sit above a message from a different
  // day — the one thing a date must never do.
  await openChat()
  host.messages = messagesAcrossDays()
  await readTranscript()
  const before = dayMarks().map((mark) => `${mark.day}|${mark.text}`)

  // A row arrives above everything, one day earlier: every marker moves down one.
  const older = { kind: 'user', text: 'three days ago', at: new Date().setHours(14, 0, 0, 0) - 3 * DAY }
  host.messages = [older, ...messagesAcrossDays()]
  await readTranscript()

  const after = dayMarks()
  assert.equal(after.length, 7, `expected seven rows after paging back, got ${after.length}`)
  const markedTexts = after.filter((mark) => mark.day !== '').map((mark) => mark.text)
  assert.deepEqual(
    markedTexts,
    ['three days ago', 'two days ago', 'yesterday', 'today'],
    `markers must sit on the four day-openers, got ${JSON.stringify(markedTexts)}`,
  )
  // The answer rows that once had no marker still have none, and the row that was
  // first is no longer first — so nothing kept the old label by accident.
  assert.notDeepEqual(after.map((mark) => `${mark.day}|${mark.text}`), before)
})

test('a row that stops opening a day loses its marker', async () => {
  // A node is reused across reads whenever its row is the same row, so a marker
  // written on one pass is still on that node on the next unless it is taken off
  // again. Every other case here moves markers onto rows that want one; this is
  // the case where a row that *had* one no longer should.
  //
  // The way to produce it is to widen the window upward by exactly one row and
  // land on a stamp inside the same day: the old first row keeps its node and its
  // place, and the day it used to open is now opened by the row above it.
  const noon = new Date()
  noon.setHours(14, 0, 0, 0)
  const base = noon.getTime()

  await openChat()
  // The window opens on the second day, so that row is marked.
  host.messages = [
    { kind: 'user', text: 'yesterday', at: base - DAY },
    { kind: 'assistant', text: 'answer from yesterday', at: base - DAY + MINUTE },
  ]
  await readTranscript()
  const before = dayMarks()
  assert.equal(before[0].day !== '', true, 'the window opener must name its day to start with')

  // One row arrives above it, from the same day: the marker belongs to that new
  // row now, and the row that used to carry it must not keep it.
  host.messages = [
    { kind: 'user', text: 'earlier the same day', at: base - DAY - MINUTE },
    ...host.messages,
  ]
  await readTranscript()
  const after = dayMarks()
  assert.equal(after.length, 3, `expected three rows, got ${after.length}`)
  assert.equal(
    after[0].day !== '',
    true,
    'the new first row must name the day it opens',
  )
  assert.equal(
    after[1].day,
    '',
    `the row that used to open the day still carries "${after[1].day}"; two rows in the same day cannot both open it`,
  )
  assert.equal(after[2].day, '', 'the answer inside the day carries no marker')
})


test('reopening the panel puts the draft back in the composer', async () => {
  // Writing the draft down is only half of it. The other half is reading it back
  // *before* the first session is drawn, and asserting that here needs a panel
  // that is really starting for the first time — a second `import` of the same
  // module returns the instance that is already running and re-runs nothing, so
  // the module is loaded under a fresh URL to get a genuinely new one.
  //
  // This is the assertion that fails if `loadDrafts` is dropped, or if it is
  // moved after `loadEverything` — in that order the composer is drawn empty,
  // the header names a session, and the text arrives a frame later (or never).
  const typed = 'a draft that must survive the panel being closed'
  typeDraft(typed)
  await letWritesLand()
  assert.equal(
    (await storage.snapshot())[`panelDraft:${SESSION}`],
    typed,
    'the draft has to be in storage before the reopening can be asked about it',
  )

  // The clock stub is put back for the duration of the import. `start` arms four
  // intervals, and the first panel's were captured so a five-second poll could
  // not rewrite the transcript mid-assertion; a second panel arming real ones
  // would keep the runner's process alive forever after the last test.
  globalThis.setInterval = (body) => {
    clocks.push(body)
    return clocks.length
  }
  try {
    const reopened = await import(
      `${pathToFileURL(join(extensionDir, 'sidepanel.js')).href}?reopened=${turn += 1}`
    )
    assert.ok(reopened, 'a fresh copy of the panel must load')
    // `start` is asynchronous, and its first act is the storage read.
    await settle()
  } finally {
    globalThis.setInterval = realSetInterval
  }

  assert.equal(
    input.value,
    typed,
    'a reopened panel must put back what was typed into it',
  )
})

test('an empty picker is not a menu, because it holds no choices', async (t) => {
  // The one state where the role is wrong rather than merely absent: with no
  // catalog there is a single sentence saying why, and announcing that as a list
  // of choices describes something that is not there.
  //
  // The panel reads the catalog once and keeps it, so this cannot be driven by
  // `openModelMenu`: by the time this test runs an earlier one has filled the
  // cache and the panel has no reason to ask again. A fresh panel is the honest
  // way to reach the state — it is what someone gets when they open the side
  // panel on a deployment whose models cannot be read.
  //
  // It sits at the end of the file for a reason worth recording: importing the
  // module again attaches a **second** set of listeners to the same elements,
  // because `getElementById` hands back the same stubs. A test that dispatches a
  // keystroke after this one runs every handler twice and counts two
  // `preventDefault` calls where the panel made one.
  t.onCleanup(() => {
    host.catalog = null
    registry.get('model').click()
  })

  host.catalog = { catalog: null, reason: 'no model service in this profile' }
  globalThis.setInterval = (body) => {
    clocks.push(body)
    return clocks.length
  }
  try {
    await import(`${pathToFileURL(join(extensionDir, 'sidepanel.js')).href}?no-catalog=${turn += 1}`)
    await settle()
  } finally {
    globalThis.setInterval = realSetInterval
  }

  registry.get('model').click()
  await settleMacrotask()
  await settle()

  const menu = registry.get('model-menu')
  const options = menu.querySelectorAll('.menu-option')
  const efforts = menu.querySelectorAll('.menu-effort')
  assert.equal(options.length + efforts.length, 0, 'there is nothing to choose in this state')
  assert.notEqual(
    menu.getAttribute('role'),
    'menu',
    'a list with no items must not claim to be a menu',
  )
  assert.match(menu.textContent, /no model service in this profile/, 'and it must still say why')
})

test('a slow host does not make the polls stack up on each other', async () => {
  // `setInterval` does not wait for its callback, and every poll awaits a
  // request. A host slower than the interval therefore used to build a stack
  // that never came back down: measured against a host answering in 12s, five
  // requests were in flight at once and all five were still pending when the
  // window closed.
  //
  // This test drives the intervals by hand, which is what makes the overlap
  // reachable at all — with real timers the assertion would be a race.
  await settleToIdle()
  const before = host.chatRequests
  let resolveHeld
  const held = new Promise((resolve) => { resolveHeld = resolve })
  host.holdNextChat = held

  // Three ticks in a row, with the first request deliberately unresolved.
  const groups = clocks[0]
  groups()
  await settle()
  groups()
  groups()
  await settle()

  const started = host.chatRequests - before
  assert.equal(
    started,
    1,
    'while one poll is unanswered the next tick must not start another, '
      + `but the panel sent ${started} requests`,
  )

  // And the guard has to let go once the answer lands, or the poll would be
  // dead from here on — the failure mode a bare `if (running) return` has.
  //
  // Released and drained through a whole macrotask, not just the microtask
  // queue: the held request has to travel stub → bridge → `refreshGroups` →
  // `.finally` before the lease is actually clear, and `settle` alone leaves it
  // still held, which would make the next tick look skipped for the wrong
  // reason and pass this assertion on a broken guard.
  resolveHeld()
  await settleMacrotask()
  await settle()
  const afterRelease = host.chatRequests
  groups()
  await settle()
  assert.ok(
    host.chatRequests > afterRelease,
    'once the held answer arrives the poll must run again, not stay stopped',
  )
  host.holdNextChat = null
})

test('one request that never comes back does not stop the poll for good', async () => {
  // The lease in `runOneAtATime` exists for this, and it is not hypothetical:
  // `bridge()` sets no timeout of its own, so a request against a suspended host
  // never settles. With a bare flag the first such request owns the slot forever
  // and that poll stops running — measured over 22 seconds, exactly one request
  // was sent and no second one ever followed.
  //
  // Time is moved rather than waited: the lease is 30s and the request timeout
  // is 20s, so a real-time test would take a minute to say one thing.
  await settleToIdle()
  const before = host.chatRequests
  host.holdNextChat = new Promise(() => {})

  const groups = clocks[0]
  groups()
  await settle()
  assert.equal(host.chatRequests - before, 1, 'the first tick is held')

  // Another tick inside the lease window is skipped, which is the pile-up guard.
  groups()
  await settle()
  assert.equal(host.chatRequests - before, 1, 'a tick inside the lease is skipped')

  // Past the lease the slot is taken back. `Date.now` is the clock the guard
  // reads, so it is the one moved here.
  const realNow = Date.now
  Date.now = () => realNow() + 31_000
  try {
    host.holdNextChat = null
    groups()
    await settle()
  } finally {
    Date.now = realNow
  }
  assert.ok(
    host.chatRequests - before > 1,
    'past the lease the poll must be allowed through again, '
      + 'otherwise a host that never answers silently kills it',
  )
})

test('a late answer does not clear a lease that a newer poll now owns', async () => {
  // `runOneAtATime` clears the slot in `finally`, and `finally` runs whenever
  // the request settles — including long after a later tick took the lease over.
  // Clearing unconditionally there deletes the *newer* run's lease, and the tick
  // after that starts a second request while the newer one is still in flight:
  // the pile-up this guard exists to prevent, let back in from underneath.
  //
  // Two requests are held at once here, which is what makes the two leases
  // distinguishable at all — with one held request there is only ever one lease
  // and both implementations behave the same, which is why this went unnoticed.
  await settleToIdle()
  const before = host.chatRequests
  const groups = clocks[0]

  let releaseFirst
  host.holdNextChat = new Promise((resolve) => { releaseFirst = resolve })
  groups()
  await settle()
  assert.equal(host.chatRequests - before, 1, 'the first tick is held')

  // Move past the first lease so a second run is allowed to start.
  const realNow = Date.now
  Date.now = () => realNow() + 31_000
  let releaseSecond
  host.holdNextChat = new Promise((resolve) => { releaseSecond = resolve })
  groups()
  await settle()
  const afterSecond = host.chatRequests
  assert.equal(afterSecond - before, 2, 'past the lease a second tick is let through')

  // Now the first answer arrives, late, while the second is still unanswered.
  releaseFirst()
  await settleMacrotask()
  await settle()

  // A third tick must still be refused: the second request owns the lease now.
  host.holdNextChat = null
  groups()
  await settle()
  assert.equal(
    host.chatRequests,
    afterSecond,
    'the late answer must not release a lease the newer poll is holding — '
      + `the panel sent ${host.chatRequests - afterSecond} extra request(s)`,
  )

  Date.now = realNow
  releaseSecond()
  await settleMacrotask()
  await settle()
})

test('a request that never lands still ends, so its slot is not held forever', async () => {
  // Two mechanisms can free the slot and they overlap, which is deliberate but
  // makes each one individually invisible to a test that only watches the poll
  // recover: the lease alone would do it at 30s, so "did the request time out?"
  // cannot be answered by waiting for recovery.
  //
  // The window where they differ is between the two thresholds. At 25s the lease
  // is still held, so recovery there can only have come from the request itself
  // ending — which is what `REQUEST_TIMEOUT_MS` is for.
  await settleToIdle()
  const before = host.chatRequests
  const groups = clocks[0]

  // Shorten the real timeout rather than changing the panel: `AbortSignal.timeout`
  // is what the panel calls, and the behaviour under test is what happens when it
  // fires. Time itself is what is being compressed, not the code path.
  const realTimeout = AbortSignal.timeout
  AbortSignal.timeout = (ms) => realTimeout(Math.min(ms, 40))
  const realNow = Date.now
  let release
  host.holdNextChat = new Promise((resolve) => { release = resolve })
  try {
    groups()
    await settle()
    assert.equal(host.chatRequests - before, 1, 'the first tick is held')

    // Let the request's timeout actually fire. A macrotask alone is not enough:
    // the abort has to travel through the fetch stub's rejection, `bridge`'s
    // catch and `runOneAtATime`'s `finally`, so this waits on real time and then
    // drains what that produced.
    await new Promise((resolve) => setTimeout(resolve, 80))
    await settle()

    Date.now = () => realNow() + 25_000

    const afterTimeout = host.chatRequests
    host.holdNextChat = null
    groups()
    await settle()
    assert.equal(
      host.chatRequests - afterTimeout,
      1,
      'a request that timed out must free its slot before the lease expires, '
        + 'otherwise a hung host holds it for the full lease on every attempt',
    )
    release()
  } finally {
    AbortSignal.timeout = realTimeout
    Date.now = realNow
    host.holdNextChat = null
  }
})

test('a panel nobody is looking at stops asking, and asks again when looked at', async () => {
  // Four timers at 5s and 8s is roughly 62,640 requests a day, and measured, the
  // panel sent them at the same rate while hidden as while watched — 40/minute
  // against 50. A side panel left open in a background window is an ordinary
  // thing to do, and this is what kept a core awake to redraw something nobody
  // could see.
  await settleToIdle()
  const before = host.chatRequests
  const groups = clocks[0]

  // Which state the document reports is the whole input to this decision, so the
  // test drives it directly rather than pretending a window was minimised.
  document.visibilityState = 'hidden'
  try {
    groups()
    await settle()
    assert.equal(
      host.chatRequests - before,
      0,
      'a hidden panel must not spend a request on a question nobody is looking at',
    )

    // And it must not be a one-way door: returning to visibility is when the
    // stale answers get replaced, so the skip has to lift.
    document.visibilityState = 'visible'
    document.emit('visibilitychange', { type: 'visibilitychange' })
    await settle()
    assert.ok(
      host.chatRequests - before > 0,
      'coming back into view must catch the panel up, not leave it frozen on '
        + 'whatever was true when the reader looked away',
    )
  } finally {
    document.visibilityState = 'visible'
  }
})

