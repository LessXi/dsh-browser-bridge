/**
 * The host ↔ extension wire contract.
 *
 * Both halves of this bridge are plain JavaScript with no shared build step, so
 * the method list is defined here once and read by both sides. Naming is
 * dotted and stable; changing a name is a breaking change for an installed
 * extension, so new capabilities are added as new methods instead.
 *
 * Parameters and results must be lossless JSON. Anything richer — a Blob, a
 * function, a cycle — is the extension's job to reduce before it answers.
 *
 * @module dsh-browser-bridge/protocol
 */

/**
 * Method names, grouped by the capability they serve.
 *
 * `browser_status` and `browser_tabs` are the S1 slice: they prove the whole
 * path end to end (upgrade, auth, RPC, Chrome API access) without touching the
 * debugger, so a failure there is never ambiguous about which layer broke.
 */
export const METHODS = Object.freeze({
  /** Connection and capability report. No parameters. */
  status: 'bridge.status',
  /** Chrome's own version and profile identity. No parameters. */
  browserInfo: 'browser.info',

  /** All tabs the extension can see. Params: `{ groupTitle?: string }`. */
  tabsList: 'tabs.list',
  /** Open one URL. Params: `{ url, groupTitle?, active?, reuseTabId? }`. */
  tabsOpen: 'tabs.open',
  /** Focus one tab. Params: `{ tabId }`. */
  tabsSelect: 'tabs.select',
  /** Close one tab, or release it from the session group. Params: `{ tabId }`. */
  tabsClose: 'tabs.close',
  /** Bring a user-opened tab under this session's group. Params: `{ tabId, groupTitle }`. */
  tabsClaim: 'tabs.claim',
  /** Give a claimed tab back to the user and drop it from the group. Params: `{ tabId }`. */
  tabsRelease: 'tabs.release',

  /** Navigate an attached tab. Params: `{ tabId, url, waitUntil? }`. */
  pageNavigate: 'page.navigate',
  /** Page geometry and identity. Params: `{ tabId }`. */
  pageInfo: 'page.info',
  /** CDP `DOMSnapshot.captureSnapshot` plus a distilled interactive list. Params: `{ tabId, maxBytes? }`. */
  pageSnapshot: 'page.snapshot',
  /** Readable text of the page. Params: `{ tabId, maxBytes? }`. */
  pageRead: 'page.read',
  /** PNG/JPEG screenshot. Params: `{ tabId, maxWidth?, format?, quality? }`. */
  pageScreenshot: 'page.screenshot',
  /** Click by selector or element index. Params: `{ tabId, selector?, index?, button? }`. */
  pageClick: 'page.click',
  /** Type into the focused element. Params: `{ tabId, selector?, text, submit? }`. */
  pageType: 'page.type',
  /** Press a key or chord. Params: `{ tabId, key, modifiers? }`. */
  pagePress: 'page.press',
  /** Scroll. Params: `{ tabId, deltaX?, deltaY?, selector? }`. */
  pageScroll: 'page.scroll',
  /** Fill a form control by role/name. Params: `{ tabId, selector, value }`. */
  pageFill: 'page.fill',
  /** Wait for a selector or text. Params: `{ tabId, selector?, text?, timeoutMs? }`. */
  pageWaitFor: 'page.waitFor',
  /** Run read-only inspection JavaScript. Params: `{ tabId, expression, awaitPromise? }`. */
  pageEval: 'page.eval',
  /** Console and uncaught-error entries. Params: `{ tabId, sinceSeq?, limit? }`. */
  pageConsole: 'page.console',
  /** Network entries. Params: `{ tabId, sinceSeq?, limit? }`. */
  pageNetwork: 'page.network',
  /** Raw CDP passthrough, Developer mode only. Params: `{ tabId, method, params? }`. */
  cdpSend: 'cdp.send',
  /** Attach the debugger. Params: `{ tabId }`. */
  debuggerAttach: 'debugger.attach',
  /** Detach the debugger. Params: `{ tabId }`. */
  debuggerDetach: 'debugger.detach',
  /** Browser history search. Params: `{ query?, limit? }`. */
  historySearch: 'history.search',

  /**
   * Sessions the side panel may continue, newest first. No parameters.
   *
   * The `chat/*` group runs the other direction from the rest of this table:
   * every other method asks the browser to do something, while these carry the
   * side panel's conversation. They share the bridge socket because it is
   * already authenticated and already open, not because they belong to the
   * browser.
   */
  chatSessions: 'chat/sessions',
  /** One session's transcript. Params: `{ sessionId, limit? }`. */
  chatMessages: 'chat/messages',
  /** Deliver a message into a session. Params: `{ sessionId, text }`. */
  chatSend: 'chat/send',
})

/** Events the extension pushes without being asked. */
export const EVENTS = Object.freeze({
  /** Tab set or focus changed. Payload: `{ tabs: [...] }`. */
  tabsChanged: 'tabs/changed',
  /** A debugger session ended, with `{ tabId, reason }`. */
  debuggerDetached: 'debugger/detached',
  /** One console entry, for live tails. Payload: `{ tabId, entry }`. */
  consoleEntry: 'console/entry',
  /** The user highlighted text. Payload: `{ text, url, title, favicon, ts }`. */
  selection: 'selection/captured',
  /** The user picked a context-menu action. Payload: `{ action, tabId, text?, url?, title? }`. */
  contextMenu: 'context/menu',
})

/**
 * Notifications the host pushes without being asked.
 *
 * The mirror image of {@link EVENTS}, and the only host→extension traffic that
 * is not a reply: nothing is waiting on an answer, and a notification that
 * cannot be delivered is dropped rather than queued. Payloads are shaped for
 * one consumer — the side panel — so they stay small and self-describing.
 */
export const NOTIFICATIONS = Object.freeze({
  /**
   * One coalesced slice of the model's live output, forwarded from the agent's
   * `agent/assistant-stream` frames.
   *
   * Payload: `{ sessionId, kind, text? }` where `kind` is `text`, `reasoning`,
   * `tool`, or `end`. `end` carries no text and marks the attempt settled, at
   * which point the panel re-reads the committed transcript.
   */
  assistantDelta: 'assistant/delta',

  /**
   * One pending approval, carried to the surface the person is actually looking
   * at.
   *
   * The harness composes its answerers from the client, and the only one that
   * ships is the graphical client's. A turn started from the side panel that
   * touches a gated tool therefore blocks on a question rendered in a window the
   * person has no reason to be looking at: the turn waits, the panel shows a
   * spinner, and nothing anywhere says why. This notification is the question,
   * addressed to the panel; the answer comes back over the HTTP routes, because
   * the socket's request direction is extension→host only.
   *
   * Payload: `{ id, sessionId, toolName, reason?, callId?, options }`.
   * `options` is the closed vocabulary the panel is allowed to answer with, so
   * a stale or hostile panel cannot invent an outcome the harness never
   * accepts.
   */
  approvalAsked: 'approval/asked',

  /**
   * One question that is no longer open, so the panel drops its card.
   *
   * A question can be settled at either surface, and the loser has to be told:
   * a card still offering buttons for a decision already made is worse than no
   * card, because pressing one does nothing and looks like a broken panel.
   *
   * Payload: `{ id, outcome }`, where `outcome` is the winning outcome or the
   * literal `answered-elsewhere`.
   */
  approvalSettled: 'approval/settled',
})

/**
 * CDP domains the extension must refuse unless Developer mode is on and the
 * origin has been granted `full_cdp_access`.
 *
 * The allow-list is expressed as a deny-list of whole domains because the
 * debugger API can reach far beyond page inspection: `Browser`, `Target`, and
 * `Storage` can enumerate and manipulate other tabs, profiles, and credentials,
 * which is well outside what "inspect this page" means to a user who approved
 * it.
 */
export const CDP_DENIED_DOMAINS = Object.freeze([
  'Browser',
  'Target',
  'Storage',
  'SystemInfo',
  'Cast',
  'Extensions',
  'ServiceWorker',
  'WebAuthn',
])

/**
 * Failure codes the extension may return. They are part of the wire contract so
 * the host can phrase an actionable message instead of echoing a stack.
 */
export const EXTENSION_ERRORS = Object.freeze({
  unknownMethod: 'unknown-method',
  invalidParams: 'invalid-params',
  tabNotFound: 'tab-not-found',
  attachFailed: 'attach-failed',
  notAttached: 'not-attached',
  cdpFailed: 'cdp-failed',
  cdpDenied: 'cdp-denied',
  chromeApiFailed: 'chrome-api-failed',
  noFileAccess: 'no-file-access',
  unsupported: 'unsupported',
})

/**
 * Whether a CDP method is allowed through the Developer-mode passthrough.
 *
 * @param {string} method - A CDP method name such as `Page.captureScreenshot`.
 * @returns {{ allowed: true } | { allowed: false, reason: string }} The verdict.
 */
export function checkCdpMethod(method) {
  if (typeof method !== 'string' || !/^[A-Za-z]+\.[A-Za-z]+$/.test(method)) {
    return { allowed: false, reason: `"${String(method)}" is not a CDP method name` }
  }
  const domain = method.slice(0, method.indexOf('.'))
  if (CDP_DENIED_DOMAINS.includes(domain)) {
    return {
      allowed: false,
      reason: `${domain} is outside page inspection and is never available through the bridge`,
    }
  }
  return { allowed: true }
}
