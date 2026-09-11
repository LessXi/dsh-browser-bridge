/**
 * Ingest: the browser's own "add this to context" gestures, turned into pending
 * attachments.
 *
 * This is the half of the attachment pipeline that faces the user rather than
 * the model. `context.js` owns the queue, the deduplication and the injection
 * hook; the `browser_context` tool lets the model see and prune that queue. What
 * was missing was the way in: the extension pushes `context/menu` when the user
 * picks a right-click item and `selection/captured` when a highlight arrives,
 * and nothing was subscribed to either, so every one of those clicks was
 * dropped and the queue stayed empty forever.
 *
 * The shape here is dictated by what the extension actually holds. A highlight
 * arrives as text; a tab arrives as a URL and a title. A page *body* is neither:
 * reading one is a browser action, and browser actions are gated on the user's
 * approval — which needs an agent to own the question, and an unsolicited menu
 * click has none. So a page attachment is built only where the session already
 * holds an `access` grant for that origin, and an ungranted site falls back to
 * the identity-only attachment. Guessing instead — reading first and asking
 * later, or asking into a void — would either read a site the user never
 * approved or silently produce nothing.
 *
 * @module lib/ingest
 */

import { ATTACHMENT_KINDS, createAttachment } from './context.js'
import { EVENTS, METHODS } from './protocol.js'

/**
 * Build the ingest handlers over a set of ports.
 *
 * @param {object} ports - The collaborators.
 * @param {import('./context.js').ContextAttachments} ports.attachments - The pending-attachment store.
 * @param {import('./grants.js').GrantTable} ports.grants - What this session was already allowed to do.
 * @param {import('./bridge.js').BridgeRegistry} ports.bridge - For the live connection, when there is one.
 * @param {() => Record<string, unknown>} ports.settings - Effective settings, resolved fresh.
 * @param {(tabId: number) => Promise<string | undefined>} ports.tabOrigin - Resolves a tab's origin.
 * @param {(message: string) => void} [ports.log] - Where to note a click that could not be honoured.
 * @returns {{ stageContextAction: (payload: unknown) => Promise<object>, stageSelection: (payload: unknown) => object, stageRequested: (list: unknown, sessionId: string) => { staged: number, refused: string[] }, listenToExtension: (connection: object) => void }} The handlers.
 */
export function createIngest(ports) {
  const { attachments, grants, bridge, settings, tabOrigin } = ports
  const log = ports.log ?? (() => {})

  /**
   * Put one attachment in the queue for whichever session owns the browser.
   *
   * @param {object} input - A {@link createAttachment} input.
   * @returns {{ added: boolean, reason?: string, pending?: number, sessionId?: string }} The outcome.
   */
  const stage = (input) => {
    const target = attachments.targetSession()
    if (target.error !== undefined) return { added: false, reason: target.error }
    return { ...attachments.add(createAttachment(input), target.sessionId), sessionId: target.sessionId }
  }

  /**
   * Read a page body for a context-menu attachment — but only for a site this
   * session has already been allowed to read.
   *
   * @param {number} tabId - The tab whose readable text to fetch.
   * @param {string} sessionId - The session the attachment belongs to.
   * @returns {Promise<string | undefined>} The text, when it was permitted.
   */
  const grantedPageText = async (tabId, sessionId) => {
    const connection = bridge?.connection
    if (connection === undefined) return undefined
    const origin = await tabOrigin(tabId)
    if (origin === undefined) return undefined
    if (grants.find(sessionId, origin, 'access') === undefined) return undefined
    try {
      const page = await connection.call(
        METHODS.pageRead,
        { tabId, maxBytes: Number(settings().pageTextMaxBytes) },
        { timeoutMs: 20_000 },
      )
      return typeof page?.text === 'string' && page.text.length > 0 ? page.text : undefined
    } catch {
      // An unreadable page is not worth surfacing: the identity-only attachment
      // below is still something the user asked for.
      return undefined
    }
  }

  /**
   * Turn one browser-side context action into a pending attachment.
   *
   * The extension sends these without waiting for an answer, so every path
   * returns a verdict rather than throwing: a click that cannot be honoured
   * leaves the queue untouched and says why, instead of rejecting into the
   * socket that carries the rest of the session.
   *
   * @param {unknown} payload - The `context/menu` payload.
   * @returns {Promise<{ added: boolean, reason?: string }>} The outcome.
   */
  const stageContextAction = async (payload) => {
    if (settings().enabled === false) return { added: false, reason: 'the browser bridge is switched off' }
    const action = typeof payload?.action === 'string' ? payload.action : ''
    const url = typeof payload?.url === 'string' ? payload.url : ''
    const title = typeof payload?.title === 'string' ? payload.title : ''
    const tabId = Number.isInteger(payload?.tabId) ? payload.tabId : undefined

    if (action === 'add-selection') {
      const text = typeof payload?.text === 'string' ? payload.text : ''
      if (text.length === 0) return { added: false, reason: 'the menu click carried no selected text' }
      return stage({ kind: 'selection', url, title, tabId, text })
    }

    if (action === 'add-tab') return stage({ kind: 'tab', url, title, tabId })

    if (action === 'add-page') {
      const target = attachments.targetSession()
      if (target.error !== undefined) return { added: false, reason: target.error }
      const text = tabId === undefined ? undefined : await grantedPageText(tabId, target.sessionId)
      // `page` means "the readable text of a page"; without a permitted read
      // there is no text, so the honest kind is the identity-only one.
      const input = { kind: text === undefined ? 'tab' : 'page', url, title, tabId, text: text ?? '' }
      return { ...attachments.add(createAttachment(input), target.sessionId), sessionId: target.sessionId }
    }

    // `auto-push` only reports the extension's own switch, which decides
    // whether a highlight leaves the browser at all. The host gate is applied
    // when one arrives, in `stageSelection`.
    return { added: false, reason: `unknown context action ${action}` }
  }

  /**
   * A highlight the browser reported, staged only when the host's own master
   * switch agrees.
   *
   * Two switches, one meaning: the extension's toggle decides what leaves the
   * browser, and `contextAutoPush` decides what this harness accepts. Both
   * default to off, so highlighting text to copy it never reaches the model
   * unless it was asked for in both places.
   *
   * @param {unknown} payload - The `selection/captured` payload.
   * @returns {{ added: boolean, reason?: string, pending?: number, sessionId?: string }} The outcome.
   */
  const stageSelection = (payload) => {
    if (settings().contextAutoPush !== true) return { added: false, reason: 'contextAutoPush is off' }
    const text = typeof payload?.text === 'string' ? payload.text : ''
    if (text.length === 0) return { added: false, reason: 'the highlight was empty' }
    return stage({
      kind: 'selection',
      url: typeof payload?.url === 'string' ? payload.url : '',
      title: typeof payload?.title === 'string' ? payload.title : '',
      tabId: Number.isInteger(payload?.tabId) ? payload.tabId : undefined,
      text,
    })
  }

  /**
   * Subscribe one connection to the events the extension pushes unasked.
   *
   * Registered per connection: each socket gets its own listener set, and both
   * die with the socket.
   *
   * @param {object} connection - The new {@link import('./bridge.js').BrowserConnection}.
   * @returns {void}
   */
  const listenToExtension = (connection) => {
    /**
     * Fire-and-forget, and defended twice over: the dispatch happens inside the
     * socket's message handler, so a throw here would escape into the code that
     * carries the rest of the session. Once for the read, once for the await.
     */
    const report = (run) => {
      try {
        Promise.resolve(run()).then((result) => {
          if (result?.added === false && result.reason !== undefined) log(result.reason)
        }).catch((error) => {
          log(`could not stage a context attachment: ${error.message}`)
        })
      } catch (error) {
        log(`could not read a browser event: ${error.message}`)
      }
    }
    connection.on(EVENTS.contextMenu, (payload) => report(() => stageContextAction(payload)))
    connection.on(EVENTS.selection, (payload) => report(() => stageSelection(payload)))
  }

  /**
   * Stage the attachments a side-panel send carried in its request body.
   *
   * The panel's send is one request so that its context and its prompt land
   * together. Sending the context as a separate event first — the shape the
   * right-click menu uses, where nothing is racing it — would let the prompt
   * overtake it across two sockets, and the context would then attach to the
   * *next* message instead of the one it was chosen for.
   *
   * Everything is re-validated here rather than trusted: this arrives over
   * loopback from an authenticated extension, but it is still a request body,
   * and the store it feeds is the one that decides what reaches the model.
   *
   * @param {unknown} list - The request body's `attachments`.
   * @param {string} sessionId - The session the send is going to.
   * @returns {{ staged: number, refused: string[] }} What was accepted.
   */
  const stageRequested = (list, sessionId) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return { staged: 0, refused: ['no session to attach to'] }
    }
    const cap = Number(settings().contextMaxChars)
    const refused = []
    let staged = 0
    for (const input of Array.isArray(list) ? list : []) {
      const kind = ATTACHMENT_KINDS.includes(input?.kind) ? input.kind : 'tab'
      const text = typeof input?.text === 'string' ? input.text : ''
      if (kind !== 'tab' && text.length === 0) {
        refused.push(`a ${kind} attachment with no text`)
        continue
      }
      const result = attachments.add(createAttachment({
        kind,
        url: typeof input?.url === 'string' ? input.url : '',
        title: typeof input?.title === 'string' ? input.title : '',
        text,
        tabId: Number.isInteger(input?.tabId) ? input.tabId : undefined,
        ...(Number.isInteger(cap) ? { maxChars: cap } : {}),
      }), sessionId)
      if (result.added) staged += 1
    }
    return { staged, refused }
  }

  return { stageContextAction, stageSelection, stageRequested, listenToExtension }
}
