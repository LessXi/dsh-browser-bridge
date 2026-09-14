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

import { distillSnapshot, renderElements } from './page-distill.js'

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

/** Keepalive alarm name; fires periodically to defeat service-worker eviction. */
const KEEPALIVE_ALARM = 'dsh-bridge-keepalive'

const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 30_000

/** Console/network ring buffers, keyed by tab id. Bounded so a noisy page cannot grow them forever. */
const RING_LIMIT = 500
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
 * @returns {Promise<{ port: string, token: string, autoPushSelection: boolean }>} The settings.
 */
async function readSettings() {
  const stored = await chrome.storage.local.get({
    port: '3080',
    token: '',
    autoPushSelection: false,
  })
  return {
    port: String(stored.port ?? '3080'),
    token: String(stored.token ?? ''),
    autoPushSelection: stored.autoPushSelection === true,
  }
}

/** Open the bridge socket, if it is not already open. */
async function connect() {
  if (socket !== undefined && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return

  const { port, token } = await readSettings()
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
    send({ event: 'bridge/hello', payload: { version: chrome.runtime.getManifest().version } })
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
 * @param {string} notify - The notification name; see `NOTIFICATIONS` in `lib/protocol.js`.
 * @param {object} payload - Its payload.
 * @returns {void}
 */
function relayNotification(notify, payload) {
  if (notify !== 'assistant/delta') return
  chrome.runtime.sendMessage({ type: 'dsh-assistant-delta', payload }).catch(() => {})
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
    const value = await dispatch(method, params)
    send({ id, ok: true, value: value ?? null })
  } catch (error) {
    send({
      id,
      ok: false,
      code: typeof error?.code === 'string' ? error.code : ERRORS.chromeApiFailed,
      message: error?.message ?? String(error),
    })
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
 * @returns {Promise<unknown>} The value to answer with.
 * @throws {Error} With a `code` from {@link ERRORS}.
 */
async function dispatch(method, params) {
  switch (method) {
    case METHODS.status: return status()
    case METHODS.browserInfo: return browserInfo()

    case METHODS.tabsList: return tabsList(params)
    case METHODS.tabsOpen: return tabsOpen(params)
    case METHODS.tabsSelect: return tabsSelect(params)
    case METHODS.tabsClose: return tabsClose(params)
    case METHODS.tabsClaim: return tabsClaim(params)
    case METHODS.tabsRelease: return tabsRelease(params)

    case METHODS.debuggerAttach: return attach(requireTabId(params))
    case METHODS.debuggerDetach: return detach(requireTabId(params))
    case METHODS.cdpSend: return cdpSend(requireTabId(params), params)

    case METHODS.pageNavigate: return pageNavigate(requireTabId(params), params)
    case METHODS.pageInfo: return pageInfo(requireTabId(params))
    case METHODS.pageSnapshot: return pageSnapshot(requireTabId(params), params)
    case METHODS.pageRead: return pageRead(requireTabId(params), params)
    case METHODS.pageScreenshot: return pageScreenshot(requireTabId(params), params)
    case METHODS.pageClick: return pageClick(requireTabId(params), params)
    case METHODS.pageType: return pageType(requireTabId(params), params)
    case METHODS.pagePress: return pagePress(requireTabId(params), params)
    case METHODS.pageScroll: return pageScroll(requireTabId(params), params)
    case METHODS.pageFill: return pageFill(requireTabId(params), params)
    case METHODS.pageWaitFor: return pageWaitFor(requireTabId(params), params)
    case METHODS.pageEval: return pageEval(requireTabId(params), params)
    case METHODS.pageConsole: return pageConsole(requireTabId(params), params)
    case METHODS.pageNetwork: return pageNetwork(requireTabId(params), params)

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

/** @returns {Promise<object>} What the harness shows on its status panel. */
async function status() {
  const tabs = await chrome.tabs.query({})
  const attached = await chrome.debugger.getTargets()
  const limitations = []

  // Uploads need a Chrome-side opt-in that no extension can grant for itself.
  limitations.push('File uploads require "Allow access to file URLs" on this extension\u2019s details page.')

  return {
    version: chrome.runtime.getManifest().version,
    tabCount: tabs.length,
    attachedCount: attached.filter((target) => target.attached === true).length,
    connectedAt: connectedAt ?? null,
    connectionCount,
    lastError: lastError.length > 0 ? lastError : null,
    limitations,
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
 * @param {chrome.tabs.Tab} tab - A tab from the Chrome API.
 * @param {number | undefined} dshGroupId - The group id reserved for DSH sessions.
 * @returns {object} The wire row.
 */
function tabRow(tab, dshGroupId) {
  return {
    id: tab.id,
    url: tab.url ?? '',
    title: tab.title ?? '',
    active: tab.active === true,
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
  const tabs = await chrome.tabs.query({})
  const rows = tabs.map((tab) => tabRow(tab, groupId))
  if (params.includeAll === false) return rows.filter((row) => row.groupId === groupId)
  // Grouped tabs first, then the rest, both in the order Chrome reports.
  return rows.sort((left, right) => Number(right.groupId === groupId) - Number(left.groupId === groupId))
}

/**
 * Open a URL, grouping it so the work is separable from the user's own tabs.
 * @param {{ url?: string, newTab?: boolean, waitForLoad?: boolean, active?: boolean }} params - The request.
 * @returns {Promise<object>} The opened tab plus a short text preview.
 */
async function tabsOpen(params) {
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
  if (params.waitForLoad !== false) await waitForLoad(tab.id)
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
  return tabRow(await chrome.tabs.get(tabId), await dshGroupId())
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
  return tabRow(await chrome.tabs.get(tabId), await dshGroupId())
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
  return tabRow(await chrome.tabs.get(tabId), await dshGroupId())
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

/** @type {Set<number>} Tabs whose debugger session we opened. */
const attachedTabs = new Set()

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
  emit(EVENTS.debuggerDetached, { tabId, reason })
})

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId
  if (tabId === undefined) return

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
 * @returns {Promise<object>} The resulting page identity.
 */
async function pageNavigate(tabId, params) {
  const url = typeof params.url === 'string' ? params.url : ''
  if (!/^https?:/i.test(url)) throw fail(ERRORS.invalidParams, `page.navigate needs an absolute http(s) url; received ${JSON.stringify(url)}`)
  await raw(tabId, 'Page.enable', {}).catch(() => {})
  await raw(tabId, 'Page.navigate', { url })
  if (params.waitForLoad !== false) await waitForLoad(tabId)
  return pageInfo(tabId)
}

/**
 * Wait for a tab to finish loading, with a ceiling so a hanging page cannot
 * stall a tool call indefinitely.
 * @param {number} tabId - The tab.
 * @returns {Promise<void>} Resolves when the tab reports `complete` or the ceiling passes.
 */
async function waitForLoad(tabId) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
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

  const elements = distillSnapshot(snapshot, { interactiveOnly: params.interactiveOnly !== false })
  const maxBytes = Number.isInteger(params.maxBytes) ? params.maxBytes : 200_000
  const rendered = renderElements(elements, { maxBytes })
  const info = await pageInfo(tabId)

  return {
    tabId,
    url: info.url,
    title: info.title,
    elementCount: elements.length,
    truncated: rendered.truncated,
    text: rendered.text,
    elements: elements.slice(0, 400),
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
    links: links.slice(0, 200),
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
  const { x, y, target } = await resolveTarget(tabId, params)
  const button = params.button === 'right' ? 'right' : params.button === 'middle' ? 'middle' : 'left'
  const clickCount = Number.isInteger(params.clickCount) ? params.clickCount : 1

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
 * @returns {Promise<{ x: number, y: number, target: object }>} The viewport point.
 * @throws {Error} When the target cannot be resolved.
 */
async function resolveTarget(tabId, params) {
  if (Number.isInteger(params.index)) {
    const snapshot = await pageSnapshot(tabId, {})
    const element = snapshot.elements.find((candidate) => candidate.index === params.index)
    if (element?.bounds === undefined) {
      throw fail(ERRORS.invalidParams, `snapshot index ${params.index} does not name an element with visible bounds; take a fresh snapshot`)
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
    }
  }

  throw fail(ERRORS.invalidParams, 'this call needs either an integer index from a snapshot or a CSS selector')
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
    const { x, y } = await resolveTarget(tabId, { selector: params.selector })
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
  if (value2.ok !== true) throw fail(ERRORS.invalidParams, `could not fill ${JSON.stringify(selector)}: ${value2.reason}`)
  return { tabId, selector, filled: true }
}

/**
 * Wait for a selector or a text fragment to appear.
 * @param {number} tabId - The tab.
 * @param {{ selector?: string, text?: string, timeoutMs?: number }} params - The request.
 * @returns {Promise<object>} Whether the condition was met.
 */
async function pageWaitFor(tabId, params) {
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
    title: 'Add selection to DSH context',
    contexts: ['selection'],
  })
  chrome.contextMenus.create({
    id: 'dsh-add-page',
    title: 'Add this page to DSH context',
    contexts: ['page'],
  })
  chrome.contextMenus.create({
    id: 'dsh-add-tab',
    title: 'Add this tab to DSH context',
    contexts: ['tab'],
  })
  chrome.contextMenus.create({ id: 'dsh-sep', type: 'separator', contexts: ['selection', 'page', 'tab'] })
  chrome.contextMenus.create({
    id: 'dsh-toggle-autopush',
    type: 'checkbox',
    title: 'Sync selections automatically',
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