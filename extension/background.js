/**
 * DSH Browser Bridge — extension service worker.
 *
 * One responsibility: be the thin executor half of the bridge. It connects to
 * the harness, runs the method it is asked to run, and answers. It holds no
 * policy of its own — every access decision (is this origin allowed, does this
 * action need approval) belongs to the harness, because splitting that logic
 * across two processes is how the two halves drift out of agreement.
 *
 * The only decisions made here are the ones only this process *can* make:
 *
 *   - which CDP domains are reachable at all (see `CDP_DENIED_DOMAINS`);
 *   - whether a tab's debugger session is ours to attach;
 *   - refusing to close a tab the user opened.
 *
 * An MV3 service worker is evicted when idle, which kills the websocket. The
 * reconnect ladder plus a keepalive alarm is what makes that invisible instead
 * of a daily "the bridge stopped working".
 *
 * @module extension/background
 */

import { fetchBridgeToken } from './bootstrap.js'
import { applyAccessibleNames, distillSnapshot, renderElements } from './page-distill.js'
import { browserTranslator, optionsTranslator, pickLocale } from './locales.js'

// The right-click menu is drawn by Chrome, on every page, in front of whatever
// the person was reading. English labels there were the last surface still in one
// language only, and the service worker has no panel to borrow a translator from.
// `globalThis.chrome` rather than a bare `chrome`: optional chaining does not
// rescue an undeclared identifier, so the bare form would throw outright in any
// context that has no `chrome` — including a test that ever imports this module.
const menuSay = optionsTranslator(
  pickLocale(globalThis.chrome?.i18n?.getUILanguage?.() ?? 'en'),
)

/** Method names, kept in sync with the host's `lib/protocol.js` by hand. */
const METHODS = {
  status: 'bridge.status',
  browserInfo: 'browser.info',
  tabsList: 'tabs.list',
  tabsOpen: 'tabs.open',
  tabsSelect: 'tabs.select',
  tabsClose: 'tabs.close',
  tabsClaim: 'tabs.claim',
  tabsRelease: 'tabs.release',
  pageNavigate: 'page.navigate',
  pageInfo: 'page.info',
  pageSnapshot: 'page.snapshot',
  pageRead: 'page.read',
  pageScreenshot: 'page.screenshot',
  pageClick: 'page.click',
  pageType: 'page.type',
  pagePress: 'page.press',
  pageScroll: 'page.scroll',
  pageFill: 'page.fill',
  pageWaitFor: 'page.waitFor',
  pageEval: 'page.eval',
  pageConsole: 'page.console',
  pageNetwork: 'page.network',
  pageDialogs: 'page.dialogs',
  pageDismissDialog: 'page.dismissDialog',
  debuggerAttach: 'debugger.attach',
  debuggerDetach: 'debugger.detach',
  cdpSend: 'cdp.send',
  historySearch: 'history.search',
}

/** Events pushed to the harness without being asked. */
const EVENTS = {
  tabsChanged: 'tabs/changed',
  debuggerDetached: 'debugger/detached',
  selection: 'selection/captured',
  contextMenu: 'context/menu',
}

/** Stable failure codes the host knows how to phrase. */
const ERRORS = {
  unknownMethod: 'unknown-method',
  invalidParams: 'invalid-params',
  tabNotFound: 'tab-not-found',
  attachFailed: 'attach-failed',
  notAttached: 'not-attached',
  cdpFailed: 'cdp-failed',
  cdpDenied: 'cdp-denied',
  chromeApiFailed: 'chrome-api-failed',
  unsupported: 'unsupported',
}

/**
 * CDP domains that can reach beyond the page the user approved: other tabs,
 * other profiles, stored credentials, extensions, and the browser process
 * itself. Refused here as well as on the host, so a bug in the host's check is
 * not by itself enough to reach them.
 */
const CDP_DENIED_DOMAINS = new Set([
  'Browser',
  'Target',
  'Storage',
  'SystemInfo',
  'Cast',
  'Extensions',
  'ServiceWorker',
  'WebAuthn',
])

/** The `chrome.debugger` protocol version this build speaks. */
const DEBUGGER_VERSION = '1.3'

/**
 * How the "this is what I am acting on" box looks.
 *
 * Tuned against a real page rather than invented: the accent blue at 40% keeps
 * the element's own text readable through the tint, and a solid border is what
 * makes the box findable when the content under it is busy. `showInfo` is
 * DevTools' own chip — the element's selector and size — which is the part that
 * answers "which one?" rather than just "somewhere here".
 */
const HIGHLIGHT_CONFIG = {
  showInfo: true,
  contentColor: { r: 66, g: 98, b: 240, a: 0.4 },
  borderColor: { r: 66, g: 98, b: 240, a: 0.9 },
}

/** The box drawn when the element at a point cannot be named. */
const HIGHLIGHT_RECT = { width: 120, height: 32 }

/**
 * How long the box stays on screen after the action that drew it.
 *
 * Measured, not guessed. Drawing the box, pressing, and hiding it takes about
 * 24ms end to end — under the ~100ms a person needs to register that something
 * flashed, let alone read which element it was. The first version of this
 * feature finished the click faster than the eye could follow, so it did nothing
 * for the person it was built for.
 *
 * Long enough to read the DevTools chip, short enough that it reads as "just
 * now" rather than as a selection the person made. A following action redraws
 * and restarts the clock, so a run of clicks moves the box along rather than
 * blinking it on and off.
 */
const HIGHLIGHT_DWELL_MS = 900

/** @type {Map<number, ReturnType<typeof setTimeout>>} Pending removals, one per tab. */
const highlightTimers = new Map()

/**
 * Badge colours: the panel's own accent for "being operated", its danger red
 * for "the turn is blocked on you". Literals because the panel's palette lives
 * in CSS, and a badge is painted by the browser, outside any stylesheet.
 */
const BADGE_CONTROLLED_COLOR = '#4262f0'
const BADGE_APPROVAL_COLOR = '#d1453b'

/**
 * Approval questions that are still open, by question id.
 *
 * A set of ids rather than a count: one turn can hit two gated tools, and
 * answering the second must leave the first one's badge standing. The ids are
 * the same ones `approval/settled` carries back, which is what makes the badge
 * come down on *every* path that can settle a question — answered in the panel,
 * answered in the graphical client, or cancelled with the turn.
 *
 * @type {Set<string>}
 */
const openApprovals = new Set()

/**
 * Mark a tab as one the model can currently act on.
 *
 * The box answers "which element, just now" and fades, which is the right shape
 * for one action and the wrong shape for twenty: during a run of tool calls the
 * person sees a series of flashes and has no way to answer the question they
 * actually have, which is "is it still driving this tab at all?".
 *
 * The toolbar badge answers that one. It lives in the browser's own chrome
 * rather than in the page, so no site can cover it, hide it, or style it away,
 * and it is visible while the person is looking anywhere in the window. It is
 * keyed to the real debugger attachment — the same thing that decides whether a
 * tool call can reach this tab — rather than to a timer, so it cannot claim a
 * control that does not exist.
 *
 * Per-tab rather than global on purpose: the badge shows on the tab it is about,
 * which is the only reading that survives several tabs being open at once.
 *
 * @param {number} tabId - The tab.
 * @param {boolean} controlled - Whether the debugger is attached.
 * An open question outranks this one. Both facts can be true of the same tab at
 * the same moment, and the badge holds one of them: "a request is waiting on
 * you" is the one that has to win, because a person who cannot see it cannot
 * act, while a person who cannot see "being operated" has simply lost a status
 * line. The count is the same number the global badge shows.
 *
 * @param {number} tabId - The tab.
 * @param {boolean} controlled - Whether the debugger is attached.
 * @returns {Promise<void>} Resolves once the badge is set.
 */
async function markControlled(tabId, controlled) {
  const waiting = openApprovals.size
  try {
    await chrome.action.setBadgeText({ tabId, text: controlled ? waiting > 0 ? String(waiting) : '•' : '' })
    if (!controlled) {
      await chrome.action.setTitle({ tabId, title: 'DSH' })
      return
    }
    // `browserTranslator`, not `chrome.i18n.getMessage`: this project keeps its
    // dictionaries in `locales.js`, and the module comment there records why
    // MV3's own `_locales/` mechanism was rejected — it cannot be exercised
    // from the Node suite. Using it here would have produced an empty tooltip
    // in every language, silently, which is the failure mode that choice
    // avoids.
    const t = browserTranslator()
    await chrome.action.setBadgeBackgroundColor({ tabId, color: waiting > 0 ? BADGE_APPROVAL_COLOR : BADGE_CONTROLLED_COLOR })
    await chrome.action.setTitle({ tabId, title: waiting > 0 ? t('action.awaiting') : t('action.controlled') })
  } catch {
    // A tab that closed between the attach and this call has no badge to set.
    // Cosmetic, and never a reason for the tool call to fail.
  }
}

/**
 * Repaint the toolbar badge after the set of open questions changed.
 *
 * This is the only warning that reaches someone whose side panel is closed, and
 * closed is the default: the panel is a separate document, so its
 * `chrome.runtime.onMessage` listener does not exist while it is shut. Measured
 * before this was written — the `approval/asked` frame is sent, nothing renders,
 * and the turn waits with no visible reason anywhere.
 *
 * Two placements, because a tab carrying a badge of its own does not
 * necessarily show the global one. The global badge (no `tabId`) is what every
 * tab without one of its own displays, including windows with no DSH tab in
 * them; the per-tab repaint stops a controlled tab from hiding the question
 * behind its own mark. Which placement Chrome prefers is not something this
 * project can measure — Chrome 137 removed `--load-extension`, so no test
 * browser can carry the extension — so both are set to that placement's correct
 * value, and the per-tab pass runs last so a controlled tab's tooltip ends up
 * describing control again once the questions are gone.
 *
 * @returns {Promise<void>} Resolves once every badge has been repainted.
 */
async function refreshApprovalBadges() {
  const waiting = openApprovals.size
  const t = browserTranslator()
  try {
    await chrome.action.setBadgeText({ text: waiting > 0 ? String(waiting) : '' })
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_APPROVAL_COLOR })
    await chrome.action.setTitle({ title: waiting > 0 ? t('action.awaiting') : 'DSH' })
  } catch {
    // A badge is a courtesy. It rides on the frame that carries the question,
    // and a browser that refuses to paint it must not stop the question.
  }
  for (const tabId of attachedTabs) await markControlled(tabId, true)
}

/**
 * Take the overlay down once the dwell has elapsed.
 *
 * The action must not wait for this. The box explains a click that has already
 * happened, and holding the click open for most of a second would make every
 * tool call slower to buy an animation.
 *
 * An evicted service worker leaves the timer unfired and the box up. That
 * failure mode is survivable in a way the alternative is not: eviction also
 * drops the debugger session, and the overlay goes with it. So the worst case is
 * a box that leaves a moment late, never one that stays forever.
 *
 * @param {number} tabId - The tab.
 * @returns {void}
 */
function scheduleHighlightClear(tabId) {
  const pending = highlightTimers.get(tabId)
  if (pending !== undefined) clearTimeout(pending)
  const timer = setTimeout(() => {
    highlightTimers.delete(tabId)
    clearHighlight(tabId).catch(() => {})
  }, HIGHLIGHT_DWELL_MS)
  highlightTimers.set(tabId, timer)
}

/**
 * Drop a pending removal without calling into the tab.
 *
 * Used from the two teardown paths — the tab closed, or the debugger detached —
 * where the tab is gone or no longer ours. Firing the timer there would send
 * `Overlay.hideHighlight` to a session that no longer exists, and would also
 * re-attach: `raw()` attaches on demand, so a stray clear after a detach would
 * silently re-open a debugger session on a tab the person or DevTools had just
 * taken from us.
 *
 * @param {number} tabId - The tab.
 * @returns {void}
 */
function cancelHighlightClear(tabId) {
  const pending = highlightTimers.get(tabId)
  if (pending === undefined) return
  clearTimeout(pending)
  highlightTimers.delete(tabId)
}

/** Keepalive alarm name; fires periodically to defeat service-worker eviction. */
const KEEPALIVE_ALARM = 'dsh-bridge-keepalive'

const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 30_000

/** Console/network ring buffers, keyed by tab id. Bounded so a noisy page cannot grow them forever. */
const RING_LIMIT = 500

/**
 * How many links `page.read` sends, and the reason the reply also carries
 * `linkCount`.
 *
 * The host renders far fewer than this, so the bound exists to keep one page's
 * link list from dominating a frame rather than to match what gets displayed. A
 * page with more than this still reports its true total, because "60 links"
 * arriving with no total is what makes a model state that a page has no
 * checkout link when it does.
 */
const LINK_MAX = 200

/**
 * How many elements a snapshot ships, and how many it renders.
 *
 * One number for both halves on purpose: the text names the indexes the wire
 * carries, so a model that reads `#250` can click `#250`. Two different caps
 * here is what produced indexes that were visible and unclickable.
 */
const ELEMENT_MAX = 400
/** @type {Map<number, object[]>} */
const consoleRing = new Map()
/** @type {Map<number, object[]>} */
const networkRing = new Map()
/** @type {Set<number>} Tab ids whose Network/Log domains we have enabled. */
const observing = new Set()

/** @type {WebSocket | undefined} */
let socket
/** @type {number} */
let reconnectDelay = RECONNECT_BASE_MS
/** @type {ReturnType<typeof setTimeout> | undefined} */
let reconnectTimer
/** @type {string} */
let lastError = ''
/** @type {number | undefined} */
let connectedAt
let connectionCount = 0

// ─────────────────────────────────────────────────────────────────────────────
// Connection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read the connection settings the user saved in the options page.
 * @returns {Promise<{ port: string, token: string, autoPushSelection: boolean, manualToken: boolean }>} The settings.
 */
async function readSettings() {
  const stored = await chrome.storage.local.get({
    port: '3080',
    token: '',
    autoPushSelection: false,
    manualToken: false,
  })
  return {
    port: String(stored.port ?? '3080'),
    token: String(stored.token ?? ''),
    autoPushSelection: stored.autoPushSelection === true,
    // Whether the token on file was typed or pasted by a person rather than
    // fetched. Clearing the field is how someone disconnects this extension on
    // purpose, and an automatic enrolment that helpfully put a token back would
    // undo that decision a second later — so a manual token is never replaced.
    manualToken: stored.manualToken === true,
  }
}

/**
 * Fetch the token from the harness and store it.
 *
 * Split out of `connect()` so the settings page can offer the same action as a
 * button: a person who pasted a stale token wants to go back to automatic, and
 * the only honest way to offer that is the same code path the first run uses.
 *
 * @param {string} port - The harness port to ask.
 * @returns {Promise<{ ok: boolean, reason?: string }>} The outcome.
 */
async function enrol(port) {
  const outcome = await fetchBridgeToken(port)
  if (outcome.ok !== true) {
    lastError = {
      unreachable: `no harness answered on port ${port} — start DSH with \`dsh web\`, or set the port and token by hand in the extension options`,
      disabled: 'the bridge is switched off in DSH Settings → Plugins, so no token was requested — turn it back on there, or paste a token by hand in the extension options',
      malformed: `the harness on port ${port} answered without a token — set the token by hand in the extension options`,
    }[outcome.reason] ?? 'could not get the bridge token from the harness'
    return { ok: false, reason: outcome.reason }
  }
  await chrome.storage.local.set({ token: outcome.token, manualToken: false })
  return { ok: true }
}

/** Open the bridge socket, if it is not already open. */
async function connect() {
  if (socket !== undefined && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return

  const settings = await readSettings()
  const { port } = settings
  let { token } = settings

  if (token.length === 0 && !settings.manualToken) {
    // First run. The token is on this machine already, and the extension is
    // allowed to read it (see `bootstrap.js` for what that does and does not
    // widen), so the person is not sent to copy sixty-four characters between
    // two windows before anything can work.
    const enrolled = await enrol(port)
    if (!enrolled.ok) {
      // The enrol has to be retried on the same ladder a dropped socket uses.
      // The common ordering is "install the extension, then start the harness",
      // and without this the worker would give up on the first attempt and never
      // notice `dsh web` coming up — the bridge would look broken until the
      // browser was restarted. It also arms the keepalive alarm, which is the
      // only one of the two paths that survives the worker being evicted.
      scheduleReconnect()
      return
    }
    token = (await readSettings()).token
    if (token.length === 0) return
  }

  if (token.length === 0) {
    lastError = 'no token saved — open the extension options and paste the token from DSH Settings → Plugins'
    return
  }

  const url = `ws://127.0.0.1:${port}/api/browser-bridge/ws?token=${encodeURIComponent(token)}`
  let next
  try {
    next = new WebSocket(url)
  } catch (error) {
    lastError = `could not open the bridge socket: ${error.message}`
    scheduleReconnect()
    return
  }
  socket = next

  next.addEventListener('open', () => {
    lastError = ''
    reconnectDelay = RECONNECT_BASE_MS
    connectedAt = Date.now()
    connectionCount += 1
    announce().catch(() => {})
    refreshContextMenus().catch(() => {})
  })

  next.addEventListener('message', (event) => {
    handleFrame(String(event.data)).catch((error) => {
      // A handler that throws must still answer, or the host's call hangs until
      // its timeout. The catch is inside `handleFrame`; this is the last resort.
      lastError = `unhandled frame error: ${error?.message ?? error}`
    })
  })

  next.addEventListener('close', (event) => {
    socket = undefined
    // 1006 is an abnormal closure: the harness is down or the token was refused.
    lastError = event.code === 1006
      ? 'the connection closed abnormally — the harness may be stopped, or the token may be wrong'
      : `the connection closed (code ${event.code})`
    // A question cannot outlive the harness that asked it. Keeping the badge up
    // would send someone to a panel that can no longer answer, and the count
    // would never come down, because `approval/settled` arrives on this socket.
    if (openApprovals.size > 0) {
      openApprovals.clear()
      refreshApprovalBadges().catch(() => {})
    }
    scheduleReconnect()
  })

  next.addEventListener('error', () => {
    lastError = 'the bridge socket reported an error before it opened'
  })
}

/** Retry with exponential backoff, capped, scheduled through an alarm so an evicted worker still comes back. */
function scheduleReconnect() {
  if (reconnectTimer !== undefined) clearTimeout(reconnectTimer)
  const delay = reconnectDelay
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
  reconnectTimer = setTimeout(() => {
    connect().catch(() => {})
  }, delay)
  // The alarm is the durable path: a setTimeout does not survive eviction.
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 })
}

/**
 * Send one frame to the host.
 * @param {object} frame - The frame to send.
 * @returns {boolean} Whether it reached an open socket.
 */
function send(frame) {
  if (socket === undefined || socket.readyState !== WebSocket.OPEN) return false
  try {
    socket.send(JSON.stringify(frame))
    return true
  } catch (error) {
    lastError = `could not send a frame: ${error.message}`
    return false
  }
}

/**
 * Push an event the host did not ask for.
 * @param {string} event - One of {@link EVENTS}.
 * @param {object} payload - The event payload; must be JSON-serializable.
 */
function emit(event, payload) {
  send({ event, payload })
}

/**
 * Fan one host-initiated notification out to the side panel.
 *
 * The panel is a separate document and cannot hold the bridge socket itself, so
 * live model output has to travel through this worker. A notification has no
 * backlog and no acknowledgement: with no panel open it is simply dropped,
 * which is correct, because a transcript can always be re-read and a half
 * finished token stream cannot.
 *
 * The approval pair is the exception that needs care. Dropping an
 * `approval/asked` costs more than a lost frame: the harness is sitting on that
 * question, and if nobody answers it the turn never finishes. It is still
 * forwarded best-effort — the graphical client can always answer, and the
 * panel closing must not strand a turn — but the panel is told, so it can show
 * the question instead of spinning.
 *
 * @param {string} notify - The notification name; see `NOTIFICATIONS` in `lib/protocol.js`.
 * @param {object} payload - Its payload.
 * @returns {void}
 */
function relayNotification(notify, payload) {
  if (notify === 'assistant/delta') {
    chrome.runtime.sendMessage({ type: 'dsh-assistant-delta', payload }).catch(() => {})
    return
  }
  if (notify === 'approval/asked') {
    // Tracked before the frame is relayed, so the badge is already up when the
    // panel's own copy of the question renders — and so it is up even when
    // there is no panel to render it at all, which is the case this exists for.
    if (typeof payload?.id === 'string') {
      openApprovals.add(payload.id)
      refreshApprovalBadges().catch(() => {})
    }
    chrome.runtime.sendMessage({ type: 'dsh-approval-asked', payload }).catch(() => {})
    return
  }
  if (notify === 'approval/settled') {
    // Removed by id, and the repaint happens whether or not this set had the id:
    // a question settled while the worker was asleep is one it never saw added,
    // and the host is the only authority on what is still open.
    if (typeof payload?.id === 'string') openApprovals.delete(payload.id)
    refreshApprovalBadges().catch(() => {})
    chrome.runtime.sendMessage({ type: 'dsh-approval-settled', payload }).catch(() => {})
    return
  }
  if (notify === 'call/cancelled') {
    // Recorded rather than acted on: the request's own loop is the only thing
    // that knows how to stop cleanly, and it is already awaiting. See
    // `cancelledCalls` for why an unrecognised id is harmless.
    if (typeof payload?.id === 'number') cancelledCalls.add(payload.id)
  }
}

/**
 * Route one inbound frame: answer a request, ignore anything else.
 * @param {string} text - The raw frame.
 * @returns {Promise<void>} Resolves after the answer is sent.
 */
async function handleFrame(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return
  }
  if (typeof parsed !== 'object' || parsed === null) return

  // The third direction on this socket: the host speaking without being asked
  // and expecting no answer. It carries no `id`, so it has to be routed before
  // the request path below returns early on a missing id.
  if (typeof parsed.notify === 'string') {
    relayNotification(parsed.notify, parsed.payload)
    return
  }

  const id = parsed.id
  if (typeof id !== 'number') return

  const method = typeof parsed.method === 'string' ? parsed.method : ''
  const params = typeof parsed.params === 'object' && parsed.params !== null ? parsed.params : {}

  try {
    const value = await dispatch(method, params, id)
    send({ id, ok: true, value: value ?? null })
  } catch (error) {
    send({
      id,
      ok: false,
      code: typeof error?.code === 'string' ? error.code : ERRORS.chromeApiFailed,
      message: error?.message ?? String(error),
    })
  } finally {
    // Whether it answered or threw, this request is no longer in flight, so a
    // cancellation arriving afterwards has nothing to stop and must not be
    // remembered — the next request could take the same number.
    cancelledCalls.delete(id)
  }
}

/**
 * Build a typed failure.
 * @param {string} code - One of {@link ERRORS}.
 * @param {string} message - The diagnostic.
 * @returns {Error} The error, carrying `code`.
 */
function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run one method.
 * @param {string} method - The method name.
 * @param {object} params - Its parameters.
 * @param {number} [id] - The host's request id, so the methods that wait can
 *   notice when the host has stopped waiting.
 * @returns {Promise<unknown>} The value to answer with.
 * @throws {Error} With a `code` from {@link ERRORS}.
 */
async function dispatch(method, params, id) {
  switch (method) {
    case METHODS.status: return status()
    case METHODS.browserInfo: return browserInfo()

    case METHODS.tabsList: return tabsList(params)
    case METHODS.tabsOpen: return tabsOpen(params, id)
    case METHODS.tabsSelect: return tabsSelect(params)
    case METHODS.tabsClose: return tabsClose(params)
    case METHODS.tabsClaim: return tabsClaim(params)
    case METHODS.tabsRelease: return tabsRelease(params)

    case METHODS.debuggerAttach: return attach(requireTabId(params))
    case METHODS.debuggerDetach: return detach(requireTabId(params))
    case METHODS.cdpSend: return cdpSend(requireTabId(params), params)

    case METHODS.pageNavigate: return pageNavigate(requireTabId(params), params, id)
    case METHODS.pageInfo: return pageInfo(requireTabId(params))
    case METHODS.pageSnapshot: return pageSnapshot(requireTabId(params), params)
    case METHODS.pageRead: return pageRead(requireTabId(params), params)
    case METHODS.pageScreenshot: return pageScreenshot(requireTabId(params), params)
    case METHODS.pageClick: return pageClick(requireTabId(params), params)
    case METHODS.pageType: return pageType(requireTabId(params), params)
    case METHODS.pagePress: return pagePress(requireTabId(params), params)
    case METHODS.pageScroll: return pageScroll(requireTabId(params), params)
    case METHODS.pageFill: return pageFill(requireTabId(params), params)
    case METHODS.pageWaitFor: return pageWaitFor(requireTabId(params), params, id)
    case METHODS.pageEval: return pageEval(requireTabId(params), params)
    case METHODS.pageConsole: return pageConsole(requireTabId(params), params)
    case METHODS.pageNetwork: return pageNetwork(requireTabId(params), params)
    case METHODS.pageDialogs: return pageDialogs(requireTabId(params))
    case METHODS.pageDismissDialog: return dismissDialog(requireTabId(params), params.promptText)

    case METHODS.historySearch: return historySearch(params)

    default:
      throw fail(ERRORS.unknownMethod, `the extension does not implement "${method}"`)
  }
}

/**
 * Require a numeric tab id.
 * @param {object} params - The method parameters.
 * @returns {number} The tab id.
 * @throws {Error} When it is missing or not an integer.
 */
function requireTabId(params) {
  const tabId = params.tabId
  if (!Number.isInteger(tabId)) throw fail(ERRORS.invalidParams, `this method needs an integer tabId; received ${JSON.stringify(tabId)}`)
  return tabId
}

// ─────────────────────────────────────────────────────────────────────────────
// Identity and tabs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What this install cannot do, in the terms the person can act on.
 *
 * Only a limitation that was actually checked is listed. The row this feeds
 * exists to explain a failure the person just hit, and a note that shows whether
 * or not the problem is real teaches people to stop reading the row — so "could
 * not tell" is reported as nothing rather than as a warning.
 *
 * @returns {Promise<string[]>} The notes; empty when nothing is known to be limited.
 */
async function limitations() {
  const notes = []

  // Uploads need a Chrome-side opt-in that no extension can grant for itself,
  // and `isAllowedFileSchemeAccess` is the very switch the sentence points at.
  // Anything other than a definite "no" reports nothing: a host without the API,
  // or a rejection, leaves us unable to say the problem is real. This never
  // throws, because the greeting that carries it also carries the version.
  let allowed
  try {
    allowed = await chrome.extension?.isAllowedFileSchemeAccess?.()
  } catch {
    allowed = undefined
  }
  if (allowed === false) {
    notes.push('File uploads require "Allow access to file URLs" on this extension\u2019s details page.')
  }

  return notes
}

/**
 * Greet the host that just accepted the socket.
 *
 * The limitations ride the hello rather than a message of their own because this
 * is the only description of the install the host ever sees: the health route is
 * answered from state it already holds, and the request direction is
 * extension→host only, so the host cannot ask for them later.
 *
 * @returns {Promise<void>} Resolves once the greeting is sent.
 */
async function announce() {
  send({
    event: 'bridge/hello',
    payload: { version: chrome.runtime.getManifest().version, limitations: await limitations() },
  })
}

/** @returns {Promise<object>} What the harness shows on its status panel. */
async function status() {
  const tabs = await chrome.tabs.query({})
  const attached = await chrome.debugger.getTargets()

  return {
    version: chrome.runtime.getManifest().version,
    tabCount: tabs.length,
    attachedCount: attached.filter((target) => target.attached === true).length,
    connectedAt: connectedAt ?? null,
    connectionCount,
    lastError: lastError.length > 0 ? lastError : null,
    limitations: await limitations(),
  }
}

/** @returns {Promise<object>} Chrome's own identity, for the status line. */
async function browserInfo() {
  let version = 'unknown'
  try {
    const info = await chrome.runtime.getBrowserInfo?.()
    if (info !== undefined) version = `${info.name} ${info.version}`
  } catch {
    // `getBrowserInfo` is Firefox-only in some builds; falling back is fine.
  }
  let profileName = '(default)'
  try {
    const stored = await chrome.storage.local.get({ profileLabel: '' })
    if (typeof stored.profileLabel === 'string' && stored.profileLabel.length > 0) profileName = stored.profileLabel
  } catch {
    // Profile labelling is cosmetic.
  }
  return { name: 'Chrome', version, profileName, userAgent: navigator.userAgent }
}

/**
 * Describe one tab for the host, including whether its debugger session is ours.
 *
 * `active` alone cannot answer "which tab is the user looking at", and that
 * matters because the host picks a tab from this list without any way to ask
 * Chrome itself. Chrome marks one tab active *per window*, so three open windows
 * mean three rows with `active: true` — and the host, taking the first match,
 * named whichever window happened to sort first. The user asks about the page in
 * front of them and is told about a tab in another window.
 *
 * So the row carries the fact that disambiguates them: whether the tab's window
 * is the one the user is actually looking at. It is computed once per list call
 * rather than per row, hence the caller passing it in.
 *
 * @param {chrome.tabs.Tab} tab - A tab from the Chrome API.
 * @param {number | undefined} dshGroupId - The group id reserved for DSH sessions.
 * @param {number | undefined} focusedWindowId - The window the user is looking at.
 * @returns {object} The wire row.
 */
function tabRow(tab, dshGroupId, focusedWindowId) {
  return {
    id: tab.id,
    url: tab.url ?? '',
    title: tab.title ?? '',
    active: tab.active === true,
    // `undefined` when the window could not be determined at all, so the host
    // can tell "not the focused window" apart from "no idea" and say so rather
    // than guessing confidently.
    windowFocused: focusedWindowId === undefined ? undefined : tab.windowId === focusedWindowId,
    highlighted: tab.highlighted === true,
    pinned: tab.pinned === true,
    windowId: tab.windowId,
    groupId: typeof tab.groupId === 'number' ? tab.groupId : -1,
    groupTitle: typeof tab.groupId === 'number' && tab.groupId >= 0 && tab.groupId === dshGroupId ? 'DSH' : undefined,
    status: tab.status,
    discarded: tab.discarded === true,
  }
}

/**
 * The window the user is looking at, or `undefined` when Chrome will not say.
 *
 * `getLastFocused` needs no extra permission beyond `tabs` here, and its failure
 * is tolerated on purpose: a browser that refuses it must degrade to the old
 * behaviour rather than break tab listing entirely.
 *
 * @returns {Promise<number | undefined>} The window id.
 */
async function focusedWindowId() {
  try {
    const window = await chrome.windows?.getLastFocused?.({})
    return typeof window?.id === 'number' ? window.id : undefined
  } catch {
    return undefined
  }
}

/**
 * The one group this extension owns. Tabs in it are the ones DSH may drive.
 * @returns {Promise<number | undefined>} The group id, when one exists.
 */
async function dshGroupId() {
  const stored = await chrome.storage.local.get({ groupId: -1 })
  const groupId = Number(stored.groupId)
  if (!Number.isInteger(groupId) || groupId < 0) return undefined
  try {
    await chrome.tabGroups.get(groupId)
    return groupId
  } catch {
    // The group was closed by the user; forget it so a new one can be made.
    await chrome.storage.local.set({ groupId: -1 })
    return undefined
  }
}

/**
 * List tabs.
 * @param {{ includeAll?: boolean }} params - `includeAll: false` limits the answer to the DSH group.
 * @returns {Promise<object[]>} The rows.
 */
async function tabsList(params) {
  const groupId = await dshGroupId()
  const focused = await focusedWindowId()
  const tabs = await chrome.tabs.query({})
  const rows = tabs.map((tab) => tabRow(tab, groupId, focused))
  if (params.includeAll === false) return rows.filter((row) => row.groupId === groupId)
  // Grouped tabs first, then the rest, both in the order Chrome reports.
  return rows.sort((left, right) => Number(right.groupId === groupId) - Number(left.groupId === groupId))
}

/**
 * Open a URL, grouping it so the work is separable from the user's own tabs.
 * @param {{ url?: string, newTab?: boolean, waitForLoad?: boolean, active?: boolean }} params - The request.
 * @param {number} [id] - The host's request id, for cancellation.
 * @returns {Promise<object>} The opened tab plus a short text preview.
 */
async function tabsOpen(params, id) {
  const url = typeof params.url === 'string' ? params.url : ''
  if (!/^https?:/i.test(url)) throw fail(ERRORS.invalidParams, `tabs.open needs an absolute http(s) url; received ${JSON.stringify(url)}`)

  const groupId = await dshGroupId()
  let tab
  const reuse = params.newTab !== true && groupId !== undefined
    ? (await chrome.tabs.query({ groupId })).find((candidate) => candidate.id !== undefined)
    : undefined

  if (reuse?.id !== undefined) {
    tab = await chrome.tabs.update(reuse.id, { url, active: params.active !== false })
  } else {
    tab = await chrome.tabs.create({ url, active: params.active !== false })
  }
  if (tab.id === undefined) throw fail(ERRORS.chromeApiFailed, 'Chrome did not return an id for the new tab')

  if (params.newTab !== true || groupId === undefined) {
    await addToDshGroup(tab.id)
  }
  if (params.waitForLoad !== false) await waitForLoad(tab.id, id)
  const fresh = await chrome.tabs.get(tab.id)
  return {
    tabId: tab.id,
    url: fresh.url ?? url,
    title: fresh.title ?? '',
    text: await previewText(tab.id),
  }
}

/**
 * Put a tab in the DSH group, creating the group when needed.
 * @param {number} tabId - The tab to group.
 * @returns {Promise<void>} Resolves once the tab is grouped.
 */
async function addToDshGroup(tabId) {
  const groupId = await chrome.tabs.group({ tabIds: [tabId] })
  await chrome.tabGroups.update(groupId, { title: 'DSH', color: 'blue' })
  await chrome.storage.local.set({ groupId })
}

/**
 * Remove a tab from the DSH group, leaving it open for the user.
 * @param {number} tabId - The tab to ungroup.
 * @returns {Promise<void>} Resolves once the tab is ungrouped.
 */
async function removeFromDshGroup(tabId) {
  try {
    await chrome.tabs.ungroup([tabId])
  } catch {
    // A tab that is already ungrouped, or was closed, needs no further action.
  }
}

/**
 * Focus one tab.
 * @param {{ tabId?: number }} params - The tab.
 * @returns {Promise<object>} The focused tab's row.
 */
async function tabsSelect(params) {
  const tabId = requireTabId(params)
  const tab = await chrome.tabs.get(tabId).catch(() => undefined)
  if (tab === undefined) throw fail(ERRORS.tabNotFound, `no tab with id ${tabId}`)
  await chrome.tabs.update(tabId, { active: true })
  if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true })
  return tabRow(await chrome.tabs.get(tabId), await dshGroupId(), await focusedWindowId())
}

/**
 * Bring a user-opened tab into the session group.
 * @param {{ tabId?: number }} params - The tab.
 * @returns {Promise<object>} The claimed tab's row.
 */
async function tabsClaim(params) {
  const tabId = requireTabId(params)
  const tab = await chrome.tabs.get(tabId).catch(() => undefined)
  if (tab === undefined) throw fail(ERRORS.tabNotFound, `no tab with id ${tabId}`)
  await addToDshGroup(tabId)
  return tabRow(await chrome.tabs.get(tabId), await dshGroupId(), await focusedWindowId())
}

/**
 * Hand a tab back to the user.
 * @param {{ tabId?: number }} params - The tab; defaults to the active grouped tab.
 * @returns {Promise<object>} The released tab's row.
 */
async function tabsRelease(params) {
  let tabId = params.tabId
  if (!Number.isInteger(tabId)) {
    const groupId = await dshGroupId()
    const candidate = groupId === undefined ? undefined : (await chrome.tabs.query({ groupId, active: true }))[0]
    tabId = candidate?.id
  }
  if (!Number.isInteger(tabId)) throw fail(ERRORS.invalidParams, 'no tab to release: pass tabId or keep one tab active in the DSH group')
  await removeFromDshGroup(tabId)
  return tabRow(await chrome.tabs.get(tabId), await dshGroupId(), await focusedWindowId())
}

/**
 * Close a tab, refusing to close one the user opened unless told to.
 *
 * The refusal is the point: a mis-scoped `browser_close_tab` that silently
 * closed a user's tab would destroy unsaved work with no undo.
 *
 * @param {{ tabId?: number, force?: boolean }} params - The request.
 * @returns {Promise<object>} The closed tab, or a refusal record.
 */
async function tabsClose(params) {
  const tabId = requireTabId(params)
  const tab = await chrome.tabs.get(tabId).catch(() => undefined)
  if (tab === undefined) throw fail(ERRORS.tabNotFound, `no tab with id ${tabId}`)

  const groupId = await dshGroupId()
  const inGroup = typeof tab.groupId === 'number' && tab.groupId >= 0 && tab.groupId === groupId
  if (!inGroup && params.force !== true) {
    return { refused: true, tabId, title: tab.title ?? '', url: tab.url ?? '', reason: 'not-opened-by-session' }
  }

  await detach(tabId).catch(() => {})
  await chrome.tabs.remove(tabId)
  return { tabId, title: tab.title ?? '', url: tab.url ?? '', closed: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// Debugger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tabs whose debugger session we opened.
 *
 * The number reported for a dialog is the `alert`/`confirm`/`prompt` a page
 * opened on its own — measured at 4014ms against a 4ms baseline before this
 * existed, because a JavaScript dialog suspends the renderer's command queue.
 * `Page.handleJavaScriptDialog` answers in 2ms, so the fix is cheap; the cost of
 * not having it was that one `alert()` on a page silently broke every browser
 * tool until its timeout, and the only hint the model got was `lib/tools.js`
 * saying a dialog *might* be open.
 *
 * @type {Set<number>}
 */
const attachedTabs = new Set()

/**
 * The dialog currently holding up a tab, if any.
 *
 * Kept per tab rather than as a single flag: several tabs can be attached at
 * once, and "is there a dialog" has to be answerable about the one a tool is
 * acting on. The entry is written when Chrome says a dialog opened and removed
 * when it says one closed, so it cannot go stale on its own.
 *
 * @type {Map<number, { type: string, message: string, defaultPrompt?: string }>}
 */
const openDialogs = new Map()

/**
 * Whether a tab has a JavaScript dialog blocking it.
 * @param {number} tabId - The tab.
 * @returns {boolean} True when a dialog is up.
 */
function hasOpenDialog(tabId) {
  return openDialogs.has(tabId)
}

/**
 * Report the dialog blocking a tab, without asking the page.
 *
 * Answered from the worker's own record plus `chrome.tabs`, and that is the
 * whole point: a tab with a dialog up cannot run a CDP command — measured, the
 * first command stops answering entirely — so a report that went through `raw`
 * (`Page.getLayoutMetrics`, as `pageInfo` does) would time out in exactly the
 * situation it exists to explain. `chrome.tabs.get` talks to the browser process
 * rather than the suspended renderer, so it still answers.
 *
 * @param {number} tabId - The tab.
 * @returns {Promise<object>} The dialog, or null when nothing is blocking.
 */
async function pageDialogs(tabId) {
  const dialog = openDialogs.get(tabId)
  const tab = await chrome.tabs.get(tabId).catch(() => undefined)
  if (tab === undefined) throw fail(ERRORS.tabNotFound, `no tab with id ${tabId}`)
  return {
    tabId,
    dialog: dialog === undefined ? null : { ...dialog },
    url: tab.url ?? '',
    title: tab.title ?? '',
  }
}

/**
 * Answer the dialog blocking a tab, so its command queue runs again.
 *
 * `accept: false` dismisses, which is what a person does when they did not ask
 * for the dialog: a page that calls `confirm()` gets "no", and one that calls
 * `alert()` simply goes away. Accepting on the user's behalf would be the
 * extension clicking "OK" on a question it did not read.
 *
 * @param {number} tabId - The tab.
 * @param {string} [promptText] - The answer to a `prompt()`, when accepting one.
 * @returns {Promise<{ tabId: number, dismissed: boolean, type: string }>} The outcome.
 * @throws {Error} With a code from {@link ERRORS}.
 */
async function dismissDialog(tabId, promptText) {
  const dialog = openDialogs.get(tabId)
  if (dialog === undefined) {
    // Not an error: the dialog may have been answered in the page or by Chrome
    // between the tool's decision and this call, and the useful answer is still
    // "nothing is blocking this tab now".
    return { tabId, dismissed: false, type: 'none' }
  }
  const params = { accept: typeof promptText === 'string' }
  if (typeof promptText === 'string') params.promptText = promptText
  await raw(tabId, 'Page.handleJavaScriptDialog', params)
  openDialogs.delete(tabId)
  return { tabId, dismissed: true, type: dialog.type }
}

/**
 * Attach the debugger to one tab.
 *
 * Chrome permits one debugger session per tab, so an open DevTools window makes
 * this fail. The failure is reported as guidance rather than a code, because
 * the fix is something the user does in another window.
 *
 * @param {number} tabId - The tab.
 * @returns {Promise<{ tabId: number, attached: boolean }>} The outcome.
 * @throws {Error} With a code from {@link ERRORS}.
 */
async function attach(tabId) {
  if (attachedTabs.has(tabId)) return { tabId, attached: true }
  try {
    await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION)
  } catch (error) {
    const message = String(error?.message ?? error)
    const hint = /Another debugger|already attached|DevTools/i.test(message)
      ? ` Close that tab's DevTools window and try again (Chrome allows one debugger per tab). Original error: ${message}`
      : ''
    throw fail(ERRORS.attachFailed, `could not attach to tab ${tabId}.${hint}`)
  }
  attachedTabs.add(tabId)
  await enableObservers(tabId).catch(() => {})
  await markControlled(tabId, true)
  return { tabId, attached: true }
}

/**
 * Detach the debugger from one tab.
 * @param {number} tabId - The tab.
 * @returns {Promise<{ tabId: number, detached: boolean }>} The outcome.
 */
async function detach(tabId) {
  if (!attachedTabs.has(tabId)) return { tabId, detached: false }
  try {
    await chrome.debugger.detach({ tabId })
  } catch {
    // Already detached by Chrome, the user, or a tab close.
  }
  attachedTabs.delete(tabId)
  observing.delete(tabId)
  consoleRing.delete(tabId)
  networkRing.delete(tabId)
  openDialogs.delete(tabId)
  await markControlled(tabId, false)
  return { tabId, detached: true }
}

/**
 * Turn on the CDP domains whose data the host reads from ring buffers.
 * @param {number} tabId - The tab.
 * @returns {Promise<void>} Resolves once the domains are enabled.
 */
async function enableObservers(tabId) {
  if (observing.has(tabId)) return
  await raw(tabId, 'Runtime.enable', {})
  await raw(tabId, 'Log.enable', {}).catch(() => {})
  await raw(tabId, 'Network.enable', {})
  // `Page.enable` is what makes `Page.javascriptDialogOpening` arrive at all.
  // Navigation already enables it lazily, but a tab attached to without ever
  // navigating would otherwise never report the dialog that is blocking it.
  await raw(tabId, 'Page.enable', {}).catch(() => {})
  observing.add(tabId)
}

/**
 * Send one CDP command, without the domain guard. Internal callers only.
 * @param {number} tabId - The tab.
 * @param {string} method - The CDP method.
 * @param {object} params - Its parameters.
 * @returns {Promise<unknown>} The CDP result.
 */
async function raw(tabId, method, params) {
  if (!attachedTabs.has(tabId)) await attach(tabId)
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params)
  } catch (error) {
    throw fail(ERRORS.cdpFailed, `CDP ${method} failed on tab ${tabId}: ${error?.message ?? error}`)
  }
}

/**
 * The Developer-mode passthrough.
 *
 * The host is responsible for requiring Developer mode and a per-origin
 * `full_cdp_access` grant before it calls this; the extension enforces only the
 * hard domain boundary, so that a bug in either half is not sufficient to reach
 * the browser process itself.
 *
 * @param {number} tabId - The tab.
 * @param {{ method?: string, params?: object }} params - The CDP call.
 * @returns {Promise<unknown>} The CDP result.
 * @throws {Error} With `cdp-denied` when the method is out of bounds.
 */
async function cdpSend(tabId, params) {
  const method = typeof params.method === 'string' ? params.method : ''
  if (!/^[A-Za-z]+\.[A-Za-z]+$/.test(method)) throw fail(ERRORS.invalidParams, `"${method}" is not a CDP method name`)
  const domain = method.slice(0, method.indexOf('.'))
  if (CDP_DENIED_DOMAINS.has(domain)) {
    throw fail(ERRORS.cdpDenied, `${domain} is outside page inspection and is never available through the bridge`)
  }
  return raw(tabId, method, params.params ?? {})
}

chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId
  if (tabId === undefined) return
  attachedTabs.delete(tabId)
  observing.delete(tabId)
  cancelHighlightClear(tabId)
  // A dialog only exists while the session that observed it does. Detaching
  // dismisses whatever was up — Chrome answers it when the debugger lets go —
  // so keeping the entry would leave a tool believing a tab is still blocked.
  openDialogs.delete(tabId)
  // The badge has to come down here as well as in `detach`: this is the path a
  // person takes when *they* take the tab back by opening DevTools, and a badge
  // that kept claiming control after that would be the exact lie the badge
  // exists to prevent.
  markControlled(tabId, false).catch(() => {})
  emit(EVENTS.debuggerDetached, { tabId, reason })
})

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId
  if (tabId === undefined) return

  // A JavaScript dialog suspends the tab's entire command queue: measured in a
  // real Chrome, `Runtime.evaluate`, `DOM.getDocument` and
  // `Page.captureScreenshot` all stop answering within milliseconds of an
  // `alert()` appearing, against a 4ms baseline. Nothing else in this file can
  // run for that tab until the dialog is answered, so knowing about it is what
  // makes every other tool able to say why it is stuck.
  if (method === 'Page.javascriptDialogOpening') {
    openDialogs.set(tabId, {
      type: typeof params.type === 'string' ? params.type : 'alert',
      message: typeof params.message === 'string' ? params.message : '',
      ...(typeof params.defaultPrompt === 'string' ? { defaultPrompt: params.defaultPrompt } : {}),
    })
    emit(EVENTS.dialogOpened, { tabId, type: params.type, message: params.message })
    return
  }
  if (method === 'Page.javascriptDialogClosed') {
    openDialogs.delete(tabId)
    emit(EVENTS.dialogClosed, { tabId })
    return
  }

  if (method === 'Runtime.consoleAPICalled') {
    pushRing(consoleRing, tabId, {
      seq: nextSeq(consoleRing, tabId),
      ts: Date.now(),
      level: params.type ?? 'log',
      text: (params.args ?? []).map(describeRemoteObject).join(' '),
    })
    return
  }
  if (method === 'Runtime.exceptionThrown') {
    const details = params.exceptionDetails ?? {}
    const description = details.exception?.description ?? details.text ?? 'uncaught exception'
    pushRing(consoleRing, tabId, { seq: nextSeq(consoleRing, tabId), ts: Date.now(), level: 'error', text: description })
    return
  }
  if (method === 'Log.entryAdded') {
    const entry = params.entry ?? {}
    pushRing(consoleRing, tabId, {
      seq: nextSeq(consoleRing, tabId),
      ts: entry.timestamp ?? Date.now(),
      level: entry.level ?? 'info',
      text: entry.text ?? '',
      url: entry.url,
    })
    return
  }
  if (method === 'Network.requestWillBeSent') {
    pushRing(networkRing, tabId, {
      seq: nextSeq(networkRing, tabId),
      ts: Date.now(),
      requestId: params.requestId,
      method: params.request?.method ?? 'GET',
      url: params.request?.url ?? '',
      type: params.type,
      status: undefined,
    })
    return
  }
  if (method === 'Network.responseReceived') {
    const entry = findRing(networkRing, tabId, (row) => row.requestId === params.requestId)
    if (entry !== undefined) {
      entry.status = params.response?.status
      entry.mimeType = params.response?.mimeType
    }
    return
  }
  if (method === 'Network.loadingFailed') {
    const entry = findRing(networkRing, tabId, (row) => row.requestId === params.requestId)
    if (entry !== undefined) entry.failure = params.errorText
  }
})

/**
 * Render a CDP remote object as text, without asking for anything remote.
 * @param {object} object - A `Runtime.RemoteObject`.
 * @returns {string} Its textual form.
 */
function describeRemoteObject(object) {
  if (object === null || typeof object !== 'object') return String(object)
  if (typeof object.value === 'string') return object.value
  if (object.value !== undefined) {
    try {
      return JSON.stringify(object.value)
    } catch {
      return String(object.value)
    }
  }
  return object.description ?? object.type ?? 'unknown'
}

/**
 * Append to a bounded ring buffer.
 * @param {Map<number, object[]>} ring - The buffer table.
 * @param {number} tabId - The tab.
 * @param {object} entry - The entry.
 */
function pushRing(ring, tabId, entry) {
  const rows = ring.get(tabId) ?? []
  rows.push(entry)
  if (rows.length > RING_LIMIT) rows.splice(0, rows.length - RING_LIMIT)
  ring.set(tabId, rows)
}

/**
 * Continue a ring's sequence numbering.
 * @param {Map<number, object[]>} ring - The buffer table.
 * @param {number} tabId - The tab.
 * @returns {number} The next sequence number.
 */
function nextSeq(ring, tabId) {
  const rows = ring.get(tabId)
  return rows === undefined || rows.length === 0 ? 0 : rows[rows.length - 1].seq + 1
}

/**
 * Find one ring entry.
 * @param {Map<number, object[]>} ring - The buffer table.
 * @param {number} tabId - The tab.
 * @param {(row: object) => boolean} predicate - The test.
 * @returns {object | undefined} The entry.
 */
function findRing(ring, tabId, predicate) {
  const rows = ring.get(tabId)
  if (rows === undefined) return undefined
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (predicate(rows[index])) return rows[index]
  }
  return undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Navigate an attached tab and wait for the load event.
 * @param {number} tabId - The tab.
 * @param {{ url?: string, waitForLoad?: boolean }} params - The request.
 * @param {number} [id] - The host's request id, for cancellation.
 * @returns {Promise<object>} The resulting page identity.
 */
async function pageNavigate(tabId, params, id) {
  const url = typeof params.url === 'string' ? params.url : ''
  if (!/^https?:/i.test(url)) throw fail(ERRORS.invalidParams, `page.navigate needs an absolute http(s) url; received ${JSON.stringify(url)}`)
  await raw(tabId, 'Page.enable', {}).catch(() => {})
  await raw(tabId, 'Page.navigate', { url })
  if (params.waitForLoad !== false) await waitForLoad(tabId, id)
  return pageInfo(tabId)
}

/**
 * Requests the host has stopped waiting for, by id.
 *
 * The host rejects a cancelled call locally the moment the turn is stopped, but
 * this worker had no way to hear about it: it kept polling or waiting for a load
 * until its own deadline, which is what made Stop a lie for the slow methods.
 * The host now sends `call/cancelled`, and this set is how a running request
 * finds out.
 *
 * Ids are removed when the request finishes, however it finishes, so the set
 * only ever holds work that is genuinely in flight. An id that arrives for
 * something already done is ignored rather than remembered: guessing would risk
 * aborting a *later* call that happened to reuse the number.
 *
 * @type {Set<number>}
 */
const cancelledCalls = new Set()

/**
 * Stop waiting when the host says the call is over.
 *
 * Deliberately a check rather than a thrown signal: every waiter here already
 * loops on a deadline, so the cheapest correct thing is to ask whether it should
 * stop looping. What each caller does when it sees `true` is its own decision —
 * a poll reports that it was cancelled, while a load wait simply stops waiting.
 *
 * @param {number | undefined} id - The request id, absent when a call was made
 *   by something other than a host frame (there is no such path today, but the
 *   waiters are also reachable from tests).
 * @returns {boolean} Whether the host has given up on this request.
 */
function wasCancelled(id) {
  return typeof id === 'number' && cancelledCalls.has(id)
}

/**
 * Wait for a tab to finish loading, with a ceiling so a hanging page cannot
 * stall a tool call indefinitely.
 *
 * Stops as soon as the host gives up. Waiting out the full 20 seconds for a
 * navigation nobody is listening for any more leaves the browser working on
 * behalf of a turn that has already been stopped.
 *
 * @param {number} tabId - The tab.
 * @param {number} [id] - The host's request id, for cancellation.
 * @returns {Promise<void>} Resolves when the tab reports `complete`, the host
 *   cancels, or the ceiling passes.
 */
async function waitForLoad(tabId, id) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (wasCancelled(id)) return
    // A dialog suspends the tab, so the load event can never arrive while one is
    // up. Returning immediately is better than waiting out twenty seconds and
    // reporting a timeout, because the caller can then name the actual reason.
    if (hasOpenDialog(tabId)) return
    const tab = await chrome.tabs.get(tabId).catch(() => undefined)
    if (tab === undefined) throw fail(ERRORS.tabNotFound, `tab ${tabId} disappeared while loading`)
    if (tab.status === 'complete') return
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
}

/**
 * Page identity and geometry.
 * @param {number} tabId - The tab.
 * @returns {Promise<object>} The identity.
 */
async function pageInfo(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined)
  if (tab === undefined) throw fail(ERRORS.tabNotFound, `no tab with id ${tabId}`)
  const metrics = await raw(tabId, 'Page.getLayoutMetrics', {}).catch(() => undefined)
  return {
    tabId,
    url: tab.url ?? '',
    title: tab.title ?? '',
    status: tab.status,
    viewport: metrics?.cssLayoutViewport === undefined
      ? undefined
      : { width: metrics.cssLayoutViewport.clientWidth, height: metrics.cssLayoutViewport.clientHeight },
  }
}

/**
 * A short text preview, used by `open` so the model sees something immediately.
 * @param {number} tabId - The tab.
 * @returns {Promise<string>} The preview, possibly empty.
 */
async function previewText(tabId) {
  try {
    const result = await raw(tabId, 'Runtime.evaluate', {
      expression: 'document.body ? document.body.innerText : ""',
      returnByValue: true,
    })
    const text = typeof result?.result?.value === 'string' ? result.result.value : ''
    return text.slice(0, 2000)
  } catch {
    return ''
  }
}

/**
 * A DOM snapshot: the primary page representation.
 *
 * `DOMSnapshot.captureSnapshot` returns structure, computed styles, and text in
 * one round trip, which is why it leads: a screenshot per step costs a vision
 * pass and loses the element identity that makes a click reproducible. The
 * distillation below keeps what an action needs — role, name, value, bounds,
 * and an index used to address the element later.
 *
 * @param {number} tabId - The tab.
 * @param {{ maxBytes?: number, interactiveOnly?: boolean }} params - The request.
 * @returns {Promise<object>} The distilled snapshot and its text rendering.
 */
async function pageSnapshot(tabId, params) {
  await raw(tabId, 'DOM.enable', {}).catch(() => {})
  await raw(tabId, 'CSS.enable', {}).catch(() => {})

  const snapshot = await raw(tabId, 'DOMSnapshot.captureSnapshot', {
    computedStyles: ['display', 'visibility', 'opacity', 'cursor'],
    includePaintOrder: false,
    includeDOMRects: true,
  })

  const distilled = distillSnapshot(snapshot, { interactiveOnly: params.interactiveOnly !== false })

  // Ask the browser for the accessible names rather than deriving them.
  //
  // The derivation in `page-distill.js` is a subset of a W3C specification, and
  // a probe against a realistic page showed what the subset misses: an input
  // labelled by `<label for>` came back with an empty name, a `<select>` was
  // named after its options, and a wrapping label read as "onI agree to the
  // terms". Chrome is the reference implementation — it is what a screen reader
  // reads — and it answers for the whole page in one call (measured: 8ms,
  // 16.6KB for 33 AX nodes).
  //
  // A failure here is not a failed snapshot: the derived names are still there,
  // and they were good enough to ship for several rounds. This only ever
  // improves them.
  let elements = distilled
  let namesFrom = 'derived'
  try {
    const tree = await raw(tabId, 'Accessibility.getFullAXTree', {})
    const applied = applyAccessibleNames(distilled, tree)
    elements = applied.elements
    if (applied.matched > 0) namesFrom = 'browser'
  } catch {
    // The AX domain can be refused on some channels, and a snapshot without it
    // is still a usable snapshot.
  }

  const maxBytes = Number.isInteger(params.maxBytes) ? params.maxBytes : 200_000
  // Render and ship the same list.
  //
  // The text used to be built from every element while only the first 400 went
  // on the wire, and `resolveTarget` looks an index up in the shipped array. So
  // on a page with 450 actionable elements the model read `#450` and could never
  // click it, and the refusal it got said the element was "not in this page any
  // more" — accusing the page of changing when the frame had been cut. A cap is
  // fine; a cap whose two halves disagree is a lie about what the page contains.
  //
  // `elementCount` stays the page's real total, because that is what it has
  // always meant and what the header reports; `listedCount` is how many the text
  // below actually names, which is the number an index has to stay under.
  const shippable = elements.slice(0, ELEMENT_MAX)
  const rendered = renderElements(shippable, { maxBytes })
  const info = await pageInfo(tabId)

  return {
    tabId,
    url: info.url,
    title: info.title,
    elementCount: elements.length,
    listedCount: shippable.length,
    truncated: rendered.truncated || shippable.length < elements.length,
    text: rendered.text,
    elements: shippable,
    namesFrom,
  }
}




/**
 * Readable page text.
 * @param {number} tabId - The tab.
 * @param {{ maxBytes?: number }} params - The request.
 * @returns {Promise<object>} The text and its provenance.
 */
async function pageRead(tabId, params) {
  const maxBytes = Number.isInteger(params.maxBytes) ? params.maxBytes : 200_000
  const result = await raw(tabId, 'Runtime.evaluate', {
    expression: READ_EXPRESSION,
    returnByValue: true,
    awaitPromise: false,
  })
  const value = result?.result?.value
  const body = typeof value?.text === 'string' ? value.text : ''
  const links = Array.isArray(value?.links) ? value.links : []
  const truncated = body.length > maxBytes
  return {
    tabId,
    url: value?.url ?? '',
    title: value?.title ?? '',
    text: truncated ? `${body.slice(0, maxBytes)}\n… (truncated at ${maxBytes} characters)` : body,
    truncated,
    // The host caps this list again at a lower number, and both caps are
    // reported to the model rather than left to look like the page's real size.
    // `linkCount` is the count before this slice, which is the number the model
    // needs: without it "60 links" reads as the whole page.
    linkCount: links.length,
    links: links.slice(0, LINK_MAX),
  }
}

/**
 * The read expression.
 *
 * Deliberately a string evaluated in the page rather than a `Runtime.evaluate`
 * with a function argument: the debugger API takes an expression, and keeping
 * it here makes the exact code the bridge runs reviewable in one place. It only
 * reads — no writes, no navigation, no storage access.
 */
const READ_EXPRESSION = `(() => {
  const clean = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
  const remove = document.querySelectorAll('script, style, noscript, template, svg');
  for (const node of remove) node.setAttribute('data-dsh-hidden', '1');
  const text = clean(document.body ? document.body.innerText : '');
  for (const node of remove) node.removeAttribute('data-dsh-hidden');
  const links = [];
  for (const anchor of document.querySelectorAll('a[href]')) {
    const label = clean(anchor.textContent);
    if (label.length === 0) continue;
    links.push({ text: label.slice(0, 120), href: anchor.href });
  }
  return { url: location.href, title: document.title, text, links };
})()`

/**
 * Capture a screenshot, sized for a model request rather than a monitor.
 * @param {number} tabId - The tab.
 * @param {{ maxWidth?: number, format?: string, quality?: number }} params - The request.
 * @returns {Promise<object>} The base64 payload and its media type.
 */
async function pageScreenshot(tabId, params) {
  const format = params.format === 'png' ? 'png' : 'jpeg'
  const maxWidth = Number.isInteger(params.maxWidth) && params.maxWidth > 0 ? params.maxWidth : 1280
  const quality = Number.isInteger(params.quality) ? Math.min(100, Math.max(1, params.quality)) : 80

  const metrics = await raw(tabId, 'Page.getLayoutMetrics', {}).catch(() => undefined)
  const viewportWidth = metrics?.cssLayoutViewport?.clientWidth ?? 0
  const captureBeyondViewport = viewportWidth > 0 && viewportWidth <= maxWidth

  const result = await raw(tabId, 'Page.captureScreenshot', {
    format,
    ...(format === 'jpeg' ? { quality } : {}),
    captureBeyondViewport,
    fromSurface: true,
  })
  return {
    tabId,
    format,
    mediaType: format === 'png' ? 'image/png' : 'image/jpeg',
    data: result?.data ?? '',
    truncatedTo: maxWidth,
  }
}

/**
 * Show the person which element is being acted on.
 *
 * The `debugger` permission means this extension can read and change every site
 * the user is logged into, and every mitigation for that lived inside the side
 * panel: a token, a per-origin prompt, a second confirmation for sensitive
 * actions. On the page itself there was nothing at all — a click landed, a field
 * was filled, and the only way to know which element it was is to read the tool
 * row in the panel and map it back to the page by hand.
 *
 * DevTools' own overlay is the same mechanism a person already reads when they
 * inspect an element, so it needs no explaining: a box on the element, and the
 * DevTools chip naming it (`button#save  120 × 32`). It is drawn by the browser
 * process, so it cannot be hidden by the page's own CSS, and it is not part of
 * the page's DOM — a site cannot see it, and no script of ours runs in the page
 * to draw it.
 *
 * Deliberately best-effort: a highlight is an explanation, not a step in the
 * action. A target with no addressable node (an element inside a shadow root, a
 * detached node) still gets clicked, and a tab the person has since closed still
 * gets its result. Every failure here is swallowed for the same reason — the
 * alternative is that turning on a visual aid makes clicking stop working.
 *
 * @param {number} tabId - The tab.
 * @param {{ nodeId?: number, backendNodeId?: number, x: number, y: number }} target - What to outline.
 * @returns {Promise<void>} Resolves once the overlay is drawn, or was not possible.
 */
async function highlightTarget(tabId, target) {
  try {
    await raw(tabId, 'Overlay.enable', {})
    let backendNodeId = target.backendNodeId
    if (backendNodeId === undefined && target.nodeId !== undefined) {
      // `highlightNode` takes either id, but `backendNodeId` survives a document
      // update between the lookup and the call, and the panel's own reads can
      // navigate. Asking for it here costs one call and removes that race.
      const described = await raw(tabId, 'DOM.describeNode', { nodeId: target.nodeId })
      backendNodeId = described?.node?.backendNodeId
    }
    if (backendNodeId === undefined) {
      // An index-addressed target has bounds and no node. Recovering the node
      // from the point keeps one highlight path instead of two that drift: it is
      // the same element the click will land on, because it is the same point.
      const hit = await raw(tabId, 'DOM.getNodeForLocation', {
        x: Math.round(target.x),
        y: Math.round(target.y),
        includeUserAgentShadowDOM: false,
      })
      backendNodeId = hit?.backendNodeId
    }
    if (backendNodeId !== undefined) {
      await raw(tabId, 'Overlay.highlightNode', {
        backendNodeId,
        highlightConfig: HIGHLIGHT_CONFIG,
      })
      return
    }
    // Nothing addressable at that point: an element the DOM cannot name still
    // gets shown, because a box on the right pixels is most of the value.
    await raw(tabId, 'Overlay.highlightRect', {
      x: Math.round(target.x - HIGHLIGHT_RECT.width / 2),
      y: Math.round(target.y - HIGHLIGHT_RECT.height / 2),
      ...HIGHLIGHT_RECT,
      color: HIGHLIGHT_CONFIG.contentColor,
      outlineColor: HIGHLIGHT_CONFIG.borderColor,
    })
  } catch {
    // Explained in the doc comment: never a reason for the action to fail.
  }
}

/**
 * Show a selector's element without resolving a click point.
 *
 * `pageFill` changes a field through page JavaScript and never needs
 * coordinates, so it has no resolved target to hand `highlightTarget`. Looking
 * the node up is a few lines and keeps the two paths drawing the same box.
 *
 * @param {number} tabId - The tab.
 * @param {string} selector - The CSS selector to outline.
 * @returns {Promise<void>} Resolves once the overlay is drawn, or was not possible.
 */
async function highlightSelector(tabId, selector) {
  try {
    await raw(tabId, 'DOM.enable', {})
    const document = await raw(tabId, 'DOM.getDocument', { depth: 0 })
    const root = document?.root?.nodeId
    if (root === undefined) return
    const found = await raw(tabId, 'DOM.querySelector', { nodeId: root, selector })
    if (found?.nodeId === undefined || found.nodeId === 0) return
    const described = await raw(tabId, 'DOM.describeNode', { nodeId: found.nodeId })
    const backendNodeId = described?.node?.backendNodeId
    if (backendNodeId === undefined) return
    await raw(tabId, 'Overlay.enable', {})
    await raw(tabId, 'Overlay.highlightNode', { backendNodeId, highlightConfig: HIGHLIGHT_CONFIG })
  } catch {
    // See `highlightTarget`: an explanation must never break the action.
  }
}

/**
 * Remove the overlay.
 *
 * Called after each action rather than left up: a box that stays on the page
 * after the model has moved on stops meaning "this is happening now" and starts
 * meaning "this happened once", which is a different and less useful claim.
 *
 * @param {number} tabId - The tab.
 * @returns {Promise<void>} Resolves once the overlay is gone.
 */
async function clearHighlight(tabId) {
  try {
    await raw(tabId, 'Overlay.hideHighlight', {})
  } catch {
    // See `highlightTarget`.
  }
}

/**
 * Resolve a click target and press it with real input events.
 *
 * Coordinates come from CDP's own box model rather than from page JavaScript,
 * so a click lands where the browser paints the element — a distinction that
 * matters on transformed or scrolled content.
 *
 * @param {number} tabId - The tab.
 * @param {{ selector?: string, index?: number, button?: string, clickCount?: number }} params - The target.
 * @returns {Promise<object>} What was clicked.
 */
async function pageClick(tabId, params) {
  const { x, y, target, nodeId } = await resolveTarget(tabId, params)
  const button = params.button === 'right' ? 'right' : params.button === 'middle' ? 'middle' : 'left'
  const clickCount = Number.isInteger(params.clickCount) ? params.clickCount : 1

  // Drawn before the press, so the box is on screen as the click lands rather
  // than appearing afterwards at a place the page may have already changed.
  await highlightTarget(tabId, { nodeId, x, y })

  for (const type of ['mousePressed', 'mouseReleased']) {
    await raw(tabId, 'Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button,
      clickCount,
      buttons: button === 'left' ? 1 : button === 'right' ? 2 : 4,
    })
  }
  scheduleHighlightClear(tabId)
  return { tabId, clicked: target, x, y, button }
}

/**
 * Find the element a call is addressing.
 *
 * Two addressing modes exist because neither is sufficient alone: a snapshot
 * index is exact for elements that have no usable selector (component-framework
 * output), while a CSS selector is what a person reads in the page source.
 *
 * @param {number} tabId - The tab.
 * @param {{ selector?: string, index?: number, text?: string }} params - The target description.
 * @returns {Promise<{ x: number, y: number, target: object, nodeId?: number }>} The viewport point, and the DOM node when the selector named one.
 * @throws {Error} When the target cannot be resolved.
 */
async function resolveTarget(tabId, params) {
  if (Number.isInteger(params.index)) {
    const snapshot = await pageSnapshot(tabId, {})
    const element = snapshot.elements.find((candidate) => candidate.index === params.index)
    if (element === undefined) {
      throw fail(ERRORS.invalidParams, `snapshot index ${params.index} is not in this page any more; take a fresh snapshot`)
    }

    // The index is a DOM node position, and a position is only meaningful
    // against the snapshot it came from. Measured on a page whose cookie banner
    // and promo strip appear a moment after load: the Pay button moved from
    // index 19 to index 29, so the old number named **nothing at all** — and
    // where the intervening nodes differ, it names a different element, which is
    // worse than naming none because the click lands somewhere the model never
    // chose.
    //
    // `backendNodeId` survives exactly that churn: it is stable for the life of
    // the document, and the payload carries it. Resolving through it is what
    // makes the index a durable reference rather than a guess about position.
    if (Number.isInteger(element.backendNodeId)) {
      const resolved = await resolveBackendNode(tabId, element.backendNodeId)
      if (resolved !== undefined) {
        return {
          x: resolved.x,
          y: resolved.y,
          target: { index: params.index, role: element.role, name: element.name },
          nodeId: resolved.nodeId,
        }
      }
    }

    if (element.bounds === undefined) {
      throw fail(ERRORS.invalidParams, `snapshot index ${params.index} does not name an element with visible bounds; take a fresh snapshot`)
    }

    // A row inside a frame carries bounds measured against *that frame's*
    // viewport, and a synthetic click is in page coordinates. Using them
    // verbatim does not fail — it lands wherever those numbers fall on the top
    // page. Measured on a checkout: a button 8px into a frame sitting at page
    // y=50 reported y=8, and clicking (83, 23) pressed the page's own "Apply
    // coupon" button. Naming a different element than the model chose is worse
    // than naming none, which is the same reason this function prefers
    // `backendNodeId` above.
    //
    // Refusing is the honest answer: the caller can ask for a fresh snapshot, and
    // the primary path resolves frame rows through `DOM.getBoxModel`, which does
    // convert into page space.
    if (element.inFrame === true) {
      throw fail(ERRORS.invalidParams, `snapshot index ${params.index} is inside a frame, and its bounds are relative to that frame; take a fresh snapshot and retry`)
    }

    return { x: element.bounds.x + element.bounds.width / 2, y: element.bounds.y + element.bounds.height / 2, target: element }
  }

  if (typeof params.selector === 'string' && params.selector.length > 0) {
    await raw(tabId, 'DOM.enable', {}).catch(() => {})
    const document = await raw(tabId, 'DOM.getDocument', { depth: 0 })
    const root = document?.root?.nodeId
    if (root === undefined) throw fail(ERRORS.cdpFailed, 'could not read the page document')
    const found = await raw(tabId, 'DOM.querySelector', { nodeId: root, selector: params.selector })
    if (found?.nodeId === undefined || found.nodeId === 0) {
      throw fail(ERRORS.invalidParams, `no element matches the selector ${JSON.stringify(params.selector)}`)
    }
    const box = await raw(tabId, 'DOM.getBoxModel', { nodeId: found.nodeId })
    const quad = box?.model?.border
    if (!Array.isArray(quad) || quad.length < 8) {
      throw fail(ERRORS.invalidParams, `the element matching ${JSON.stringify(params.selector)} has no visible box`)
    }
    return {
      x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
      y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
      target: { selector: params.selector },
      nodeId: found.nodeId,
    }
  }

  throw fail(ERRORS.invalidParams, 'this call needs either an integer index from a snapshot or a CSS selector')
}

/**
 * Turn a stable backend node id into a live node and its centre point.
 *
 * `backendNodeId` is assigned by the browser and survives siblings coming and
 * going, which is exactly what a snapshot index does not do. Turning it back
 * into something clickable takes two steps: `DOM.getDocument` to make the
 * session hold a frontend document at all (without it the push fails with
 * "Document needs to be requested first"), then the push itself.
 *
 * Returns `undefined` rather than throwing when the node is gone. A caller that
 * asked for index 19 on a page that has since replaced that element should fall
 * back to whatever it can still measure, not fail outright — and the fallback is
 * the old, position-based behaviour, which is correct for a page that has not
 * changed.
 *
 * @param {number} tabId - The tab.
 * @param {number} backendNodeId - The stable id from the snapshot.
 * @returns {Promise<{ nodeId: number, x: number, y: number } | undefined>} The node and point.
 */
async function resolveBackendNode(tabId, backendNodeId) {
  try {
    await raw(tabId, 'DOM.enable', {}).catch(() => {})
    await raw(tabId, 'DOM.getDocument', { depth: 0 })
    const pushed = await raw(tabId, 'DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [backendNodeId] })
    const nodeId = pushed?.nodeIds?.[0]
    if (!Number.isInteger(nodeId) || nodeId === 0) return undefined
    const box = await raw(tabId, 'DOM.getBoxModel', { nodeId })
    const quad = box?.model?.border
    // A zero-area or hidden element has no usable box, and the position fallback
    // is no better, so this is where the caller gets to decide.
    if (!Array.isArray(quad) || quad.length < 8) return undefined
    return {
      nodeId,
      x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
      y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
    }
  } catch {
    // Detached node, a document that navigated away, or a CDP refusal. All of
    // them mean "cannot resolve this way", which is what the caller handles.
    return undefined
  }
}

/**
 * Insert text into the focused element.
 *
 * `Input.insertText` is preferred over per-character key events because it is
 * one round trip and behaves like a paste: autocomplete and framework listeners
 * see a normal input event. Per-character dispatch is kept for the case where a
 * page ignores synthetic insertion.
 *
 * @param {number} tabId - The tab.
 * @param {{ selector?: string, text?: string, submit?: boolean, clear?: boolean }} params - The request.
 * @returns {Promise<object>} What was typed.
 */
async function pageType(tabId, params) {
  const text = typeof params.text === 'string' ? params.text : ''
  if (text.length === 0) throw fail(ERRORS.invalidParams, 'page.type needs non-empty text')

  if (typeof params.selector === 'string' && params.selector.length > 0) {
    const { x, y, nodeId } = await resolveTarget(tabId, { selector: params.selector })
    await highlightTarget(tabId, { nodeId, x, y })
    for (const type of ['mousePressed', 'mouseReleased']) {
      await raw(tabId, 'Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: 1 })
    }
    if (params.clear === true) {
      await raw(tabId, 'Runtime.evaluate', {
        expression: 'document.activeElement && document.activeElement.select && document.activeElement.select()',
      })
      await pagePress(tabId, { key: 'Backspace' })
    }
  }

  await raw(tabId, 'Input.insertText', { text })
  if (params.submit === true) await pagePress(tabId, { key: 'Enter' })
  scheduleHighlightClear(tabId)
  return { tabId, typed: text.length, selector: params.selector }
}

/**
 * Press a key or a modifier chord.
 * @param {number} tabId - The tab.
 * @param {{ key?: string, modifiers?: string[] }} params - The key and modifiers.
 * @returns {Promise<object>} What was pressed.
 */
async function pagePress(tabId, params) {
  const key = typeof params.key === 'string' && params.key.length > 0 ? params.key : ''
  if (key.length === 0) throw fail(ERRORS.invalidParams, 'page.press needs a key name')

  const modifiers = Array.isArray(params.modifiers) ? params.modifiers : []
  let mask = 0
  if (modifiers.includes('alt')) mask |= 1
  if (modifiers.includes('ctrl')) mask |= 2
  if (modifiers.includes('meta')) mask |= 4
  if (modifiers.includes('shift')) mask |= 8

  const descriptor = keyDescriptor(key, modifiers)
  for (const type of ['keyDown', 'keyUp']) {
    await raw(tabId, 'Input.dispatchKeyEvent', {
      type,
      ...descriptor,
      modifiers: mask,
      autoRepeat: false,
    })
  }
  return { tabId, key, modifiers }
}

/**
 * Map a key name onto the fields `Input.dispatchKeyEvent` needs.
 *
 * CDP wants four pieces for a key that produces text — the DOM key, the
 * physical code, the virtual key code, and the text itself — and a wrong
 * combination silently does nothing, which is the worst failure mode to debug.
 *
 * @param {string} key - The key name or single character.
 * @param {string[]} modifiers - Active modifiers.
 * @returns {Record<string, unknown>} The dispatch fields.
 */
function keyDescriptor(key, modifiers) {
  const named = {
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
    Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, text: '\t' },
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
    Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
    Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
    Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
    End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
    PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
    PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
    Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  }
  if (named[key] !== undefined) return named[key]

  if (key.length === 1) {
    const upper = key.toUpperCase()
    const isLetter = /^[A-Za-z]$/.test(key)
    const isDigit = /^[0-9]$/.test(key)
    const shifted = modifiers.includes('shift')
    return {
      key: shifted && isLetter ? upper : key,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${key}` : undefined,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      text: shifted || !isLetter ? key : key,
    }
  }

  // Unrecognized names still dispatch, so a page-specific shortcut can be tried.
  return { key, code: key }
}

/**
 * Scroll the page or an element into view.
 * @param {number} tabId - The tab.
 * @param {{ deltaX?: number, deltaY?: number, selector?: string }} params - The request.
 * @returns {Promise<object>} What was scrolled.
 */
async function pageScroll(tabId, params) {
  if (typeof params.selector === 'string' && params.selector.length > 0) {
    await raw(tabId, 'Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(params.selector)})?.scrollIntoView({ block: 'center', inline: 'center' })`,
    })
    return { tabId, scrolledTo: params.selector }
  }
  const deltaX = Number.isFinite(params.deltaX) ? params.deltaX : 0
  const deltaY = Number.isFinite(params.deltaY) ? params.deltaY : 600
  const info = await pageInfo(tabId)
  const x = (info.viewport?.width ?? 800) / 2
  const y = (info.viewport?.height ?? 600) / 2
  await raw(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY })
  return { tabId, deltaX, deltaY }
}

/**
 * Fill a form control.
 * @param {number} tabId - The tab.
 * @param {{ selector?: string, value?: string }} params - The request.
 * @returns {Promise<object>} The outcome.
 */
async function pageFill(tabId, params) {
  const selector = typeof params.selector === 'string' ? params.selector : ''
  const value = typeof params.value === 'string' ? params.value : ''
  if (selector.length === 0) throw fail(ERRORS.invalidParams, 'page.fill needs a selector')
  // Filling a field is the action most worth showing: it is how a password or a
  // payment form changes, and it happens through `Runtime.evaluate` rather than
  // a click, so there is no input event for the person to notice.
  await highlightSelector(tabId, selector)
  const result = await raw(tabId, 'Runtime.evaluate', {
    expression: `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (element === null) return { ok: false, reason: 'no element matches the selector' };
      const tag = element.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
          ?? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(element, ${JSON.stringify(value)});
      } else if (tag === 'SELECT') {
        element.value = ${JSON.stringify(value)};
      } else if (element.isContentEditable) {
        element.textContent = ${JSON.stringify(value)};
      } else {
        return { ok: false, reason: 'the element is not a form control' };
      }
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    })()`,
    returnByValue: true,
  })
  const value2 = result?.result?.value ?? { ok: false, reason: 'no result' }
  scheduleHighlightClear(tabId)
  if (value2.ok !== true) throw fail(ERRORS.invalidParams, `could not fill ${JSON.stringify(selector)}: ${value2.reason}`)
  return { tabId, selector, filled: true }
}

/**
 * Wait for a selector or a text fragment to appear.
 *
 * The longest-running method the host can call, and the one where cancellation
 * matters most: the default budget is fifteen seconds of polling, and before the
 * host could say "stop" this kept going for all of them after the turn had
 * already been stopped.
 *
 * @param {number} tabId - The tab.
 * @param {{ selector?: string, text?: string, timeoutMs?: number }} params - The request.
 * @param {number} [id] - The host's request id, for cancellation.
 * @returns {Promise<object>} Whether the condition was met.
 */
async function pageWaitFor(tabId, params, id) {
  const selector = typeof params.selector === 'string' ? params.selector : ''
  const text = typeof params.text === 'string' ? params.text : ''
  if (selector.length === 0 && text.length === 0) {
    throw fail(ERRORS.invalidParams, 'page.waitFor needs a selector or text to wait for')
  }
  const timeoutMs = Number.isInteger(params.timeoutMs) ? params.timeoutMs : 15_000
  const deadline = Date.now() + timeoutMs
  const expression = selector.length > 0
    ? `document.querySelector(${JSON.stringify(selector)}) !== null`
    : `document.body !== null && document.body.innerText.includes(${JSON.stringify(text)})`

  while (Date.now() < deadline) {
    // Checked before each poll, so a stopped turn stops polling rather than
    // finishing its budget first. `cancelled` is reported rather than thrown:
    // the host has already abandoned this call, so this answer is discarded, but
    // a test can see which path ended the wait.
    if (wasCancelled(id)) return { tabId, satisfied: false, cancelled: true }
    // A dialog stops this poll from ever succeeding — the page cannot run the
    // expression while one is up — so it is reported now rather than after the
    // whole budget. Naming it is the difference between "it timed out" and "a
    // confirm() box is waiting for you".
    if (hasOpenDialog(tabId)) {
      const dialog = openDialogs.get(tabId)
      return { tabId, satisfied: false, blockedByDialog: { type: dialog?.type, message: dialog?.message } }
    }
    const result = await raw(tabId, 'Runtime.evaluate', { expression, returnByValue: true })
    if (result?.result?.value === true) return { tabId, satisfied: true, waitedMs: timeoutMs - (deadline - Date.now()) }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return { tabId, satisfied: false, timedOutMs: timeoutMs }
}

/**
 * Run inspection JavaScript in the page.
 *
 * The host requires Developer mode and a per-origin `full_cdp_access` grant
 * before it reaches this. The extension cannot verify that the expression is
 * read-only, so it states plainly in its answer that it did not try.
 *
 * @param {number} tabId - The tab.
 * @param {{ expression?: string, awaitPromise?: boolean }} params - The request.
 * @returns {Promise<object>} The returned value and its type.
 */
async function pageEval(tabId, params) {
  const expression = typeof params.expression === 'string' ? params.expression : ''
  if (expression.length === 0) throw fail(ERRORS.invalidParams, 'page.eval needs an expression')
  const result = await raw(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: params.awaitPromise === true,
  })
  if (result?.exceptionDetails !== undefined) {
    const details = result.exceptionDetails
    throw fail(ERRORS.cdpFailed, `the expression threw: ${details.exception?.description ?? details.text ?? 'unknown error'}`)
  }
  return {
    tabId,
    type: result?.result?.type,
    value: result?.result?.value,
    description: result?.result?.description,
    note: 'The extension does not verify that an expression is read-only.',
  }
}

/**
 * Read the console ring buffer.
 * @param {number} tabId - The tab.
 * @param {{ sinceSeq?: number, limit?: number }} params - The request.
 * @returns {Promise<object>} The entries.
 */
async function pageConsole(tabId, params) {
  await enableObservers(tabId).catch(() => {})
  const sinceSeq = Number.isInteger(params.sinceSeq) ? params.sinceSeq : -1
  const limit = Number.isInteger(params.limit) ? Math.min(500, params.limit) : 200
  const rows = (consoleRing.get(tabId) ?? []).filter((row) => row.seq > sinceSeq)
  return { tabId, entries: rows.slice(-limit), buffered: consoleRing.get(tabId)?.length ?? 0 }
}

/**
 * Read the network ring buffer.
 * @param {number} tabId - The tab.
 * @param {{ sinceSeq?: number, limit?: number }} params - The request.
 * @returns {Promise<object>} The entries.
 */
async function pageNetwork(tabId, params) {
  await enableObservers(tabId).catch(() => {})
  const sinceSeq = Number.isInteger(params.sinceSeq) ? params.sinceSeq : -1
  const limit = Number.isInteger(params.limit) ? Math.min(500, params.limit) : 200
  const rows = (networkRing.get(tabId) ?? []).filter((row) => row.seq > sinceSeq)
  return { tabId, entries: rows.slice(-limit), buffered: networkRing.get(tabId)?.length ?? 0 }
}

/**
 * Search browser history.
 *
 * The host requires a fresh approval for every call — there is no standing
 * grant, which is why nothing about this is cached here either.
 *
 * @param {{ query?: string, limit?: number }} params - The request.
 * @returns {Promise<object>} The matching entries.
 */
async function historySearch(params) {
  if (!chrome.history?.search) throw fail(ERRORS.unsupported, 'the history API is unavailable in this browser build')
  const query = typeof params.query === 'string' ? params.query : ''
  const limit = Number.isInteger(params.limit) ? Math.min(100, params.limit) : 25
  const items = await chrome.history.search({ text: query, maxResults: limit })
  return {
    entries: items.map((item) => ({
      url: item.url,
      title: item.title,
      lastVisitTime: item.lastVisitTime,
      visitCount: item.visitCount,
    })),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab lifecycle and menus
// ─────────────────────────────────────────────────────────────────────────────

chrome.tabs.onCreated.addListener(() => emitTabsChanged())
chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId)
  observing.delete(tabId)
  consoleRing.delete(tabId)
  networkRing.delete(tabId)
  cancelHighlightClear(tabId)
  emitTabsChanged()
})
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status !== undefined || changeInfo.url !== undefined || changeInfo.title !== undefined) emitTabsChanged()
})
chrome.tabs.onActivated.addListener(() => emitTabsChanged())

/** Announce that the tab set changed, rate-limited so a fast page cannot spam the host. */
let tabsChangedTimer
function emitTabsChanged() {
  if (tabsChangedTimer !== undefined) return
  tabsChangedTimer = setTimeout(async () => {
    tabsChangedTimer = undefined
    try {
      emit(EVENTS.tabsChanged, { tabs: await tabsList({}) })
    } catch {
      // A tab set that cannot be read is not worth reporting.
    }
  }, 250)
}

/**
 * Build the right-click menu.
 *
 * The items are context-sensitive rather than always-on because
 * `info.selectionText` only exists for a `selection` context: a single "add to
 * context" item would silently send nothing when the user right-clicked white
 * space.
 */
async function refreshContextMenus() {
  await chrome.contextMenus.removeAll()
  chrome.contextMenus.create({
    id: 'dsh-add-selection',
    title: menuSay('menu.addSelection'),
    contexts: ['selection'],
  })
  chrome.contextMenus.create({
    id: 'dsh-add-page',
    title: menuSay('menu.addPage'),
    contexts: ['page'],
  })
  chrome.contextMenus.create({
    id: 'dsh-add-tab',
    title: menuSay('menu.addTab'),
    contexts: ['tab'],
  })
  chrome.contextMenus.create({ id: 'dsh-sep', type: 'separator', contexts: ['selection', 'page', 'tab'] })
  chrome.contextMenus.create({
    id: 'dsh-toggle-autopush',
    type: 'checkbox',
    title: menuSay('menu.autoPush'),
    checked: (await readSettings()).autoPushSelection,
    contexts: ['selection', 'page', 'tab'],
  })
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'dsh-toggle-autopush') {
    const next = info.checked === true
    await chrome.storage.local.set({ autoPushSelection: next })
    await refreshContextMenus()
    emit(EVENTS.contextMenu, { action: 'auto-push', enabled: next })
    return
  }

  const base = {
    tabId: tab?.id,
    url: info.pageUrl ?? tab?.url ?? '',
    title: tab?.title ?? '',
  }
  if (info.menuItemId === 'dsh-add-selection') {
    emit(EVENTS.contextMenu, {
      ...base,
      action: 'add-selection',
      text: typeof info.selectionText === 'string' ? info.selectionText : '',
    })
    return
  }
  if (info.menuItemId === 'dsh-add-page') {
    emit(EVENTS.contextMenu, { ...base, action: 'add-page' })
    return
  }
  if (info.menuItemId === 'dsh-add-tab') {
    emit(EVENTS.contextMenu, { ...base, action: 'add-tab' })
  }
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'dsh-selection') return false
  const tabId = sender.tab?.id
  const payload = {
    text: typeof message.text === 'string' ? message.text : '',
    url: message.url ?? '',
    title: message.title ?? '',
    tabId,
    ts: Date.now(),
  }
  if (payload.text.length === 0 && tabId === undefined) return false

  // The side panel always sees the current selection — including the transition
  // back to none, so the chip it draws for "what will be attached" can go away.
  // Whether a selection becomes context is the user's switch, not this
  // listener's decision.
  chrome.runtime.sendMessage({ type: 'dsh-selection-changed', payload }).catch(() => {})
  // An empty selection is never pushed to the host: there would be nothing to
  // attach, and the host refuses an empty selection attachment anyway.
  if (payload.text.length > 0) {
    readSettings()
      .then((settings) => {
        if (settings.autoPushSelection) emit(EVENTS.selection, payload)
      })
      .catch(() => {})
  }
  sendResponse({ ok: true })
  return true
})

// ─────────────────────────────────────────────────────────────────────────────
// Entry points
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  refreshContextMenus().catch(() => {})
  connect().catch(() => {})
})

chrome.runtime.onStartup.addListener(() => {
  connect().catch(() => {})
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return
  if (socket === undefined || socket.readyState !== WebSocket.OPEN) connect().catch(() => {})
})

chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.windowId === undefined) return
  await chrome.sidePanel.open({ windowId: tab.windowId })
})

chrome.storage.onChanged.addListener((changes) => {
  if (changes.port !== undefined || changes.token !== undefined) {
    // Reconnect against the new settings rather than waiting for the old socket
    // to notice.
    socket?.close()
    socket = undefined
    reconnectDelay = RECONNECT_BASE_MS
    connect().catch(() => {})
  }
})

chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {})

connect().catch(() => {})