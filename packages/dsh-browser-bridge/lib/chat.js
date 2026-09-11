/**
 * Chat delivery for the browser side panel.
 *
 * The side panel is a conversation surface, so three things have to work: list
 * the sessions a person could continue, read one session's transcript back as
 * something a human wants to read, and get a typed message into that session
 * through the same path the web composer uses.
 *
 * Three deliberate rules, each of which fixes a specific way this used to be
 * wrong:
 *
 *   - **One listing source.** The list comes from the session controller's own
 *     `list()`, which is the exact call the DSH sidebar makes. The previous
 *     version merged the durable session query with the live session store and
 *     filled gaps with `lastMessage` text, which is how archived sessions, bare
 *     subagent UUIDs and truncated `[tool-result]` fragments ended up as rows in
 *     a picker. Two sources cannot be kept consistent; one source cannot drift.
 *   - **A transcript is what a person said, not what the model saw.** Rows are
 *     built from the session's own events with an explicit allow-list. The
 *     model-visible message list (`deriveMessages()`) is *not* used: it carries
 *     the system prompt and every injected context block, so reading it painted
 *     the whole system prompt into the panel as a "system" message.
 *   - **Nothing is invented for display.** A block with no text produces no
 *     row — not `[tool-result]`, not `[tool-call]`. A session with no title
 *     shows as untitled rather than as a slice of its id.
 *
 * Delivery deliberately goes through the harness's own session-command service
 * rather than constructing a message here. Building a `UserMessage` by hand
 * would mean inventing a message source the session log and compaction have
 * never seen, and the durable record would then misattribute who said what —
 * the transcript is the audit trail, so it has to be produced by the layer that
 * owns it.
 *
 * Every harness object is treated as unknown and narrowed defensively: these
 * are live internal objects, their fields are not a public contract, and a
 * wrong guess here must degrade to "no messages" rather than take down the
 * plugin. A silent empty transcript is a bug to be seen, not a crash.
 *
 * @module dsh-browser-bridge/chat
 */

import { loadPeer } from './deps.js'

/** How much transcript one read may return, before the caller's own limit. */
const DEFAULT_LIMIT = 40

/** The plugin identity the harness records for this bridge's own notices. */
const PLUGIN_ID = 'browser-bridge'

/** Longest a tool row's one-line summary may be. */
const TOOL_SUMMARY_MAX = 80

/** Longest a derived fallback title may be. */
const TITLE_MAX = 60

/** Longest an attachment notice may be before it is clipped. */
const CONTEXT_LABEL_MAX = 60

/**
 * Argument keys worth showing in a tool row, most specific first.
 *
 * A tool row is a single line, so the useful thing is the noun the call acted
 * on — the command, the file, the pattern — not the serialized argument object.
 */
const SUMMARY_KEYS = [
  'command', 'cmd', 'file_path', 'filePath', 'path', 'pattern', 'query', 'url', 'prompt', 'description',
]

/**
 * Narrow one value to a non-empty string.
 * @param {unknown} value - The candidate.
 * @returns {string} The value, or an empty string.
 */
function asText(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * Collapse whitespace and clip to a budget, on one line.
 * @param {string} value - The source text.
 * @param {number} maximum - The longest allowed result.
 * @returns {string} The one-line form.
 */
function oneLine(value, maximum) {
  const collapsed = String(value).replace(/\s+/g, ' ').trim()
  return collapsed.length > maximum ? `${collapsed.slice(0, maximum - 1)}…` : collapsed
}

/**
 * Join the `text` blocks of a message content array.
 *
 * Only blocks that are actually text contribute. A block carrying no `text` —
 * a tool result, an image, a failed attempt — is *not* something a person wrote,
 * and rendering a `[type]` placeholder for it is what put `[tool-result]` into
 * the middle of the transcript.
 *
 * @param {unknown} content - The message's content array.
 * @returns {string} The joined text, or an empty string.
 */
export function textBlocks(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (typeof block !== 'object' || block === null) continue
    if (block.type !== 'text') continue
    const text = asText(block.text)
    if (text.length > 0) parts.push(text)
  }
  return parts.join('\n').trim()
}

/**
 * Read a tool call's arguments, whether they arrive as JSON text or an object.
 * @param {unknown} value - The `arguments` field of a `tool/call` event.
 * @returns {Record<string, unknown> | undefined} The parsed arguments.
 */
function parseArguments(value) {
  if (typeof value === 'object' && value !== null) return value
  if (typeof value !== 'string' || value.length === 0) return undefined
  try {
    const parsed = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * A one-line summary of what a tool call did.
 * @param {unknown} data - A `tool/call` event's data.
 * @returns {string} The summary, possibly empty.
 */
export function toolSummary(data) {
  const args = parseArguments(data?.arguments)
  if (args !== undefined) {
    for (const key of SUMMARY_KEYS) {
      const value = asText(args[key])
      if (value.length > 0) return oneLine(value, TOOL_SUMMARY_MAX)
    }
  }
  const raw = asText(data?.arguments)
  return raw.length > 0 ? oneLine(raw, TOOL_SUMMARY_MAX) : ''
}

/**
 * Whether one `tool/result` reports a failure.
 *
 * The result carries its own error flag on the message content, and some
 * failures only carry a code. Either is enough to mark the row.
 *
 * @param {unknown} data - A `tool/result` event's data.
 * @returns {boolean} True when the call failed.
 */
export function toolFailed(data) {
  const message = data?.message
  if (message?.isError === true) return true
  const content = Array.isArray(message?.content) ? message.content : []
  if (content.some((block) => block?.isError === true)) return true
  return data?.error !== undefined && data?.error !== null
}

/**
 * Collapse consecutive calls to the same tool into one row with a count.
 *
 * A turn that runs a dozen shell commands is one step, not a dozen events, and
 * reading it as a dozen lines is what makes a transcript unscannable. Same rule
 * the original side panel applies: merge only an *unbroken* run of identical
 * calls, and let the last call's status stand for the run — it is only finished
 * when its final call is.
 *
 * @param {object[]} rows - Rows from `describeEvents`.
 * @returns {object[]} The rows, with runs collapsed.
 */
export function collapseToolRuns(rows) {
  const out = []
  for (const row of rows) {
    const previous = out[out.length - 1]
    if (
      row.kind === 'tool'
      && previous?.kind === 'tool'
      && previous.name === row.name
      && previous.summary === row.summary
    ) {
      previous.count += 1
      previous.status = row.status
      continue
    }
    out.push(row.kind === 'tool' ? { ...row, count: 1 } : row)
  }
  return out
}

/**
 * Normalize a model selection, whichever side of the wire it came from.
 *
 * @param {unknown} value - A `{ provider, model, reasoningEffort? }` shape.
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | null} The selection, or null.
 */
export function normalizeSelection(value) {
  if (value === null || typeof value !== 'object') return null
  const provider = asText(value.provider)
  const model = asText(value.model)
  if (provider.length === 0 || model.length === 0) return null
  const reasoningEffort = asText(value.reasoningEffort)
  return { provider, model, ...(reasoningEffort.length > 0 ? { reasoningEffort } : {}) }
}

/**
 * Normalize one listing item's model-selection projection.
 *
 * The projection's wire view is `{ lastUsed, next }`, where `next` is the
 * pending selection or — once a request has consumed it — the last used one
 * (`@deepseek-ai/dsh-api-session-controller/lib/types/model-selection-projection.js:47-50`).
 * `next` is therefore the single value a panel should show, and a session that
 * has never selected anything reports none.
 *
 * @param {object} item - One item from `SessionController.list`.
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | null} The selection, or null.
 */
export function selectionOf(item) {
  const view = item?.projections?.values?.modelSelection
  return normalizeSelection(view?.next ?? view?.lastUsed)
}

/**
 * Describe one session's events as the rows a panel should draw.
 *
 * The allow-list is the whole contract:
 *
 *   - `user/message` with `source.kind === 'user'` is something the person
 *     typed. Every other user message — the system-prompt snapshot, the skill
 *     catalog, any other plugin's injection — is context, not conversation.
 *   - This bridge's own attachments are the one exception: they are shown as a
 *     faint notice because the person asked for the page to be attached.
 *   - `assistant/message` carries its message one level deeper than a user
 *     message does (`data.message`, not `data`); its `text` blocks are prose and
 *     its `reasoning` blocks are folded to a single collapsible line. Its
 *     `tool-call` blocks are skipped because the paired `tool/call` event is the
 *     copy that carries the id a result can be matched against.
 *   - `tool/call` opens a row; the matching `tool/result` fills in its status and
 *     never becomes a row of its own.
 *   - Everything else — turn and step boundaries, request headers, titles,
 *     permission and policy records — is trace data and produces nothing.
 *
 * @param {unknown[]} events - The session's events, oldest first.
 * @param {{ isAppendSurfaceEvent: (event: unknown) => boolean } | null} api - The surface API, when it loaded.
 * @returns {object[]} The rows, newest last.
 */
export function describeEvents(events, api) {
  const rows = []
  /** @type {Map<string, object>} */
  const toolRows = new Map()

  /**
   * Whether this event belongs on the current surface.
   *
   * A missing `surfaceOp` means the event never replaced anything — either it
   * predates surface operations in the log or it simply appended — and it is on
   * the current surface by definition. Consulting the peer predicate first is
   * what a previous version did, and its predicate wants envelope fields this
   * reader does not need; asking it about a minimal event dropped the event
   * silently, which erased whole transcripts.
   *
   * @param {object} event - One session event.
   * @returns {boolean} True when the event belongs on the current surface.
   */
  const appended = (event) => {
    if (event.surfaceOp === undefined) return true
    if (api !== null) return api.isAppendSurfaceEvent(event) === true
    return event.surfaceOp === 'append'
  }

  for (const event of events) {
    if (typeof event?.type !== 'string') continue
    const data = event.data

    switch (event.type) {
      case 'user/message': {
        // A replacement carries a compaction summary, not something the person
        // said at this point in the conversation.
        if (!appended(event)) break
        const source = data?.source
        if (source?.kind === 'user') {
          const text = textBlocks(data?.content)
          if (text.length > 0) rows.push({ kind: 'user', text })
          break
        }
        if (source?.plugin === PLUGIN_ID) {
          const label = oneLine(asText(source.summary) || textBlocks(data?.content), CONTEXT_LABEL_MAX)
          rows.push({ kind: 'context', text: label })
        }
        break
      }

      case 'assistant/message': {
        if (!appended(event)) break
        const content = data?.message?.content
        if (!Array.isArray(content)) break
        for (const block of content) {
          if (typeof block !== 'object' || block === null) continue
          if (block.type === 'text') {
            // Prose blocks are joined per block so a message that interleaves
            // reasoning and text still reads in the order it was produced.
            const text = asText(block.text).trim()
            if (text.length > 0) rows.push({ kind: 'assistant', text })
            continue
          }
          if (block.type === 'reasoning') {
            const text = asText(block.text).trim()
            if (text.length > 0) rows.push({ kind: 'reasoning', text })
          }
        }
        break
      }

      case 'tool/call': {
        const callId = asText(data?.callId)
        const row = {
          kind: 'tool',
          callId,
          name: asText(data?.name) || 'tool',
          summary: toolSummary(data),
          status: 'pending',
        }
        rows.push(row)
        if (callId.length > 0) toolRows.set(callId, row)
        break
      }

      case 'tool/result': {
        // Both appends and replacements count here: a replacement finalizes a
        // result that was previously only partially known, and the row wants the
        // latest word either way.
        const callId = asText(data?.message?.source?.callId) || asText(data?.callId)
        const row = callId.length > 0 ? toolRows.get(callId) : undefined
        if (row !== undefined) row.status = toolFailed(data) ? 'error' : 'ok'
        break
      }

      default:
        break
    }
  }

  return rows
}

/**
 * Build the chat surface over the harness's session services.
 *
 * Listing goes through the **session controller**, which is the same object the
 * web GUI reads: `list()` returns the visible sessions already ordered by
 * activity and already filtered of subagent and unattached rows by the harness
 * itself. Reading a transcript goes through `inspect()`, the controller's own
 * reader, which answers from memory for a live session and from the log for a
 * cold one — so both cases take exactly one code path here.
 *
 * @param {object} ports - Injected dependencies.
 * @param {object|Function} [ports.sessions] - The session store, used only to ask whether a session is live.
 * @param {object|Function} [ports.commands] - The session command surface (`inspect`, `list`, `create`, `prompt`).
 * @param {object|Function} [ports.workspaces] - The workspace registry, for grouping and archive state.
 * @returns {object} The chat surface.
 */
export function createChat(ports) {
  // Each port is either the service itself or a getter for it.
  //
  // The getter form is load-bearing. These services are not up when a plugin
  // activates — the session controller in particular registers later — so
  // resolving them once during `apply` captured `undefined` permanently, and the
  // panel then showed an empty transcript and refused every send with "the
  // session-command service is unavailable" while the services were running the
  // whole time. Resolving per call costs a property lookup and cannot go stale.
  const sessionsOf = () => resolvePort(ports.sessions)
  const commandsOf = () => resolvePort(ports.commands)
  const workspacesOf = () => resolvePort(ports.workspaces)

  /**
   * An abort signal that never aborts.
   *
   * The controller's readers call `signal.throwIfAborted()` unconditionally, and
   * passing `undefined` threw `Cannot read properties of undefined (reading
   * 'throwIfAborted')`. The HTTP route has no cancellation of its own to
   * forward, so "no cancellation" has to be spelled as a signal that never
   * fires.
   */
  const never = () => new AbortController().signal

  /**
   * Replays of cold sessions, kept for the life of the plugin.
   *
   * A cold session cannot change while it is cold: nothing in this process is
   * writing to it. So one replay per id is enough, and the alternative — the
   * panel re-reads its transcript every eight seconds — would replay the whole
   * log off disk twelve times a minute to draw the same rows. `send` and
   * `create` drop the entry, because they are the things that make it stale.
   *
   * @type {Map<string, Promise<{ messages: object[], title: string }>>}
   */
  const coldCache = new Map()
  // The routable model set is a property of the deployment, not of a session or
  // a refresh, and `buildModelCatalog` walks every provider — so it is read once.
  let catalogCache = null

  /**
   * Session titles learned from the last listing, so a transcript read does not
   * have to resolve one again.
   * @type {Map<string, string>}
   */
  const knownTitles = new Map()

  /**
   * Whether a session is attached in this process.
   *
   * Used purely as a cache gate: a live session is re-read every time because it
   * is still being written, a cold one is not. `ctx.sessions.get` is the same
   * non-attaching check the harness's own list uses.
   *
   * @param {string} sessionId - The session.
   * @returns {boolean} True when the session is live here.
   */
  const isLive = (sessionId) => {
    const sessions = sessionsOf()
    if (sessions === undefined || typeof sessions.get !== 'function') return false
    try {
      return sessions.get(sessionId) !== undefined
    } catch {
      return false
    }
  }

  /**
   * Read one session's header and events through the controller.
   * @param {string} sessionId - The session.
   * @returns {Promise<{ meta?: object, header?: object, events: unknown[] } | undefined>} Its state.
   */
  const inspectState = async (sessionId) => {
    const commands = commandsOf()
    if (commands === undefined) return undefined
    if (typeof commands.inspect === 'function') {
      try {
        const state = await commands.inspect(sessionId, never())
        if (state !== undefined && state !== null) return state
      } catch {
        // Fall through to the older reader rather than losing the transcript.
      }
    }
    if (typeof commands.readSessionState === 'function') {
      try {
        return await commands.readSessionState(sessionId)
      } catch {
        return undefined
      }
    }
    return undefined
  }

  /**
   * Replay one session and cache the result when it cannot change underneath us.
   * @param {string} sessionId - The session.
   * @returns {Promise<{ messages: object[], title: string }>} Its rows and title.
   */
  const readThrough = async (sessionId) => {
    const cached = coldCache.get(sessionId)
    if (cached !== undefined) return cached
    const pending = (async () => {
      const state = await inspectState(sessionId)
      const events = Array.isArray(state?.events) ? state.events : []
      const messages = describeEvents(events, await surfaceApi())
      const meta = state?.meta ?? state?.header
      const title = asText(meta?.title)
      return { messages: collapseToolRuns(messages), title }
    })()
    if (!isLive(sessionId)) coldCache.set(sessionId, pending)
    return pending
  }

  /**
   * List the sessions a person could continue, grouped the way the harness
   * groups them.
   *
   * Filtering is delegated wherever the harness already does it: `list()` skips
   * subagent rows and cold sessions with no working directory on its own. What is
   * left for this layer is the archive list, which the web GUI also applies
   * itself, and the grouping, which the GUI does by workspace.
   *
   * @returns {Promise<{ groups: object[] }>} Workspace groups, newest activity first.
   */
  const listSessions = async () => {
    const commands = commandsOf()
    if (commands === undefined || typeof commands.list !== 'function') return { groups: [] }

    /** @type {object[]} */
    let items = []
    try {
      const result = await commands.list(undefined, never())
      items = Array.isArray(result?.items) ? result.items : []
    } catch {
      return { groups: [] }
    }

    const archived = archivedIds(workspacesOf())
    const workspaces = workspaceList(workspacesOf())
    /** @type {Map<string, object[]>} */
    const buckets = new Map()
    for (const workspace of workspaces) buckets.set(workspace.id, [])
    buckets.set('', [])

    knownTitles.clear()
    for (const item of items) {
      const id = asText(item?.sessionId)
      if (id.length === 0) continue
      if (item?.origin === 'subagent') continue
      if (archived.has(id)) continue
      const title = asText(item?.projections?.values?.title)
      knownTitles.set(id, title)
      const bucket = buckets.get(workspaceIdFor(asText(item?.cwd), workspaces)) ?? buckets.get('')
      bucket.push({
        id,
        title,
        updatedAt: Number.isFinite(item?.updatedAt) ? item.updatedAt : 0,
        running: item?.running === true,
        blank: item?.blank === true,
        // The Session's own model selection travels with the listing, so the
        // panel can draw its trigger without a second read.
        model: selectionOf(item),
      })
    }

    const groups = []
    for (const workspace of workspaces) {
      const sessions = (buckets.get(workspace.id) ?? []).sort(byActivity)
      if (sessions.length > 0) groups.push({ id: workspace.id, title: workspace.title, sessions })
    }
    const loose = (buckets.get('') ?? []).sort(byActivity)
    if (loose.length > 0) groups.push({ id: null, title: '', sessions: loose })
    return { groups }
  }

  /**
   * Read one session's transcript.
   *
   * @param {string} sessionId - The session.
   * @param {number} [limit] - Maximum rows.
   * @returns {Promise<{ title: string, messages: object[] }>} The title and rows, newest last.
   */
  const readMessages = async (sessionId, limit) => {
    const maximum = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT
    const replay = await readThrough(sessionId)
    const derived = titleFrom(replay.messages)
    return {
      // The listing is the authority on titles; a session that is not in the
      // list (a brand-new one, say) falls back to the transcript's own words.
      title: replay.title || knownTitles.get(sessionId) || derived,
      messages: replay.messages.slice(-maximum),
    }
  }

  /**
   * Read the deployment's model catalog.
   *
   * Cached for the life of the plugin: the routable set changes when a provider
   * gains or loses credentials, which is not something that happens between two
   * refreshes of a side panel.
   *
   * `modelCatalog` is `async` on the harness side
   * (`@deepseek-ai/dsh-api-session-controller/lib/types/catalog.js:8`), so the
   * await is load-bearing: without it this caches a Promise, and a Promise
   * survives `typeof === 'object'` and then serialises to `{}` — a catalog that
   * looks loaded and has no models in it.
   *
   * @returns {Promise<{ catalog: object|null, reason: string }>} The catalog, or why there is none.
   */
  const readModels = async () => {
    const commands = commandsOf()
    if (commands === undefined || typeof commands.modelCatalog !== 'function') {
      return { catalog: null, reason: 'the harness does not expose a model catalog' }
    }
    if (catalogCache !== null) return { catalog: catalogCache, reason: '' }
    try {
      const catalog = await commands.modelCatalog()
      if (catalog === null || typeof catalog !== 'object') {
        return { catalog: null, reason: 'the harness returned no model catalog' }
      }
      catalogCache = catalog
      return { catalog, reason: '' }
    } catch (error) {
      return { catalog: null, reason: error?.message ?? String(error) }
    }
  }

  /**
   * Install one Session-local model selection.
   *
   * The harness resolves the pair against the live adapters, so an unknown or
   * unroutable model is refused here rather than at the next prompt. It is also
   * Session-local: this is the whole of "each session keeps its own model", and
   * no other session is touched.
   *
   * `SessionController.selectModel` additionally saves the choice as the
   * deployment default. That is the harness's behaviour for every caller of it,
   * including its own GUI, and bypassing it would mean appending `model/selection`
   * by hand and letting the Session log disagree with the projection.
   *
   * @param {{ sessionId?: string, provider?: string, model?: string, reasoningEffort?: string }} input - The requested selection.
   * @returns {Promise<{ selected: object } | { selected: false, reason: string }>} The installed selection, or why it was refused.
   */
  const selectModel = async (input) => {
    const commands = commandsOf()
    if (commands === undefined || typeof commands.selectModel !== 'function') {
      return { selected: false, reason: 'the harness does not expose model selection' }
    }
    const sessionId = asText(input?.sessionId)
    const provider = asText(input?.provider)
    const model = asText(input?.model)
    if (sessionId.length === 0) return { selected: false, reason: 'no session was named' }
    if (provider.length === 0 || model.length === 0) {
      return { selected: false, reason: 'the request named no provider and model' }
    }
    /** @type {Record<string, string>} */
    const request = { sessionId, provider, model }
    const effort = asText(input?.reasoningEffort)
    if (effort.length > 0) request.reasoningEffort = effort
    try {
      const result = await commands.selectModel(request)
      const selected = normalizeSelection(result?.selected)
      if (selected === null) return { selected: false, reason: 'the harness returned no selection' }
      // A cold session's transcript is cached; a selection does not change it,
      // but nothing about this session should be served from a stale copy now.
      coldCache.delete(sessionId)
      return { selected }
    } catch (error) {
      return { selected: false, reason: error?.message ?? String(error) }
    }
  }

  /**
   * Create one ordinary session through the harness's own creator.
   *
   * `workspaceId` and `cwd` are mutually exclusive on the harness side and both
   * may be omitted, in which case the deployment's default directory is used.
   *
   * @param {{ workspaceId?: string }} [input] - The requested location.
   * @returns {Promise<{ created: true, sessionId: string } | { created: false, reason: string }>} The outcome.
   */
  const createSession = async (input = {}) => {
    const commands = commandsOf()
    if (commands === undefined || typeof commands.create !== 'function') {
      return {
        created: false,
        reason: 'the harness session-command service is unavailable, so the bridge cannot start a session',
      }
    }
    const workspaceId = asText(input?.workspaceId)
    try {
      const result = await commands.create(workspaceId.length > 0 ? { workspaceId } : {})
      const sessionId = asText(result?.sessionId)
      if (sessionId.length === 0) {
        return { created: false, reason: 'the harness did not return a session identity' }
      }
      coldCache.delete(sessionId)
      return { created: true, sessionId }
    } catch (error) {
      return { created: false, reason: error?.message ?? String(error) }
    }
  }

  /**
   * Send one message into a session through the harness's own command service.
   *
   * @param {string} sessionId - The target session.
   * @param {string} text - The message body.
   * @param {AbortSignal} [signal] - Cancellation from the caller.
   * @returns {Promise<{ accepted: true, sessionId: string } | { accepted: false, reason: string }>} The outcome.
   */
  const send = async (sessionId, text, signal) => {
    const commands = commandsOf()
    if (typeof text !== 'string' || text.trim().length === 0) {
      return { accepted: false, reason: 'the message is empty' }
    }
    if (commands === undefined || typeof commands.prompt !== 'function') {
      return {
        accepted: false,
        reason: 'the harness session-command service is unavailable, so the bridge cannot deliver a message',
      }
    }
    try {
      const result = await commands.prompt({
        requestId: crypto.randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, signal ?? never())
      if (result !== undefined && result !== null && typeof result === 'object' && 'error' in result) {
        const error = result.error
        return { accepted: false, reason: `${error?.code ?? 'session/prompt-failed'}: ${error?.message ?? 'the session rejected the message'}` }
      }
      // The session is about to have new events, so any replay of it is stale.
      coldCache.delete(sessionId)
      return { accepted: true, sessionId }
    } catch (error) {
      return { accepted: false, reason: error?.message ?? String(error) }
    }
  }

  /**
   * Which session services this surface actually got.
   *
   * All of them are read with `ctx.get` rather than injected, deliberately: a
   * profile that mounts no session services must still get a working browser
   * bridge. The cost is that "this service was not up yet when the plugin
   * activated" and "there is nothing to show" look identical from the panel, so
   * the health route reports this to tell them apart.
   *
   * @returns {object} Service availability.
   */
  const services = () => {
    const sessions = sessionsOf()
    const commands = commandsOf()
    const workspaces = workspacesOf()
    return {
      sessions: typeof sessions?.get === 'function',
      list: typeof commands?.list === 'function',
      inspect: typeof commands?.inspect === 'function',
      readSessionState: typeof commands?.readSessionState === 'function',
      create: typeof commands?.create === 'function',
      prompt: typeof commands?.prompt === 'function',
      modelCatalog: typeof commands?.modelCatalog === 'function',
      selectModel: typeof commands?.selectModel === 'function',
      workspaces: typeof workspaces?.list === 'function',
      // `untried` until a read has needed the surface rules; `false` means the
      // narrower local rule is in use, which is worth knowing because it is the
      // copy that can drift.
      surfaceRules: surfaceModule === undefined ? 'untried' : surfaceModule !== null,
    }
  }

  return { listSessions, readMessages, createSession, send, readModels, selectModel, services }
}

/**
 * Order two session rows by activity, newest first.
 * @param {{ updatedAt: number }} left - One row.
 * @param {{ updatedAt: number }} right - The other.
 * @returns {number} The comparator result.
 */
function byActivity(left, right) {
  return right.updatedAt - left.updatedAt
}

/**
 * Resolve one port, which may be a service or a getter for it.
 *
 * A getter that throws is treated as an absent service: `ctx.get` does not
 * throw, but a caller's own resolver might, and losing a transcript must never
 * be worse than losing the plugin.
 *
 * @param {unknown} value - The service, or a function returning it.
 * @returns {any} The service, or undefined.
 */
function resolvePort(value) {
  if (typeof value !== 'function') return value
  try {
    return value()
  } catch {
    return undefined
  }
}

/**
 * Read the workspace registry's archive list.
 *
 * `list()` already excludes subagent sessions, so archiving is the one filter
 * this layer has to apply — the web GUI applies the same one from the same
 * source.
 *
 * @param {unknown} registry - The workspace registry, when mounted.
 * @returns {Set<string>} The archived session ids.
 */
function archivedIds(registry) {
  if (registry === undefined || typeof registry !== 'object') return new Set()
  try {
    const ids = registry.archivedSessionIds
    return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

/**
 * The registered workspaces, in registry order.
 * @param {unknown} registry - The workspace registry, when mounted.
 * @returns {{ id: string, path: string, title: string }[]} The workspaces.
 */
function workspaceList(registry) {
  if (registry === undefined || typeof registry.list !== 'function') return []
  try {
    const entities = registry.list()
    if (!Array.isArray(entities)) return []
    return entities
      .filter((entity) => typeof entity?.id === 'string')
      .map((entity) => ({
        id: entity.id,
        path: asText(entity.path),
        title: asText(entity.title) || asText(entity.path),
      }))
  } catch {
    return []
  }
}

/**
 * Normalize a directory for comparison.
 *
 * Windows registries and session headers disagree about separators and trailing
 * slashes for the same directory, and a case-sensitive comparison would drop
 * every session into the ungrouped bucket.
 *
 * @param {string} value - The path.
 * @returns {string} The comparison form.
 */
function normalizePath(value) {
  return String(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * Which workspace group a session's directory belongs to.
 * @param {string} cwd - The session's working directory.
 * @param {{ id: string, path: string }[]} workspaces - The registered workspaces.
 * @returns {string} The workspace id, or `''` for ungrouped.
 */
function workspaceIdFor(cwd, workspaces) {
  if (cwd.length === 0) return ''
  const target = normalizePath(cwd)
  for (const workspace of workspaces) {
    if (workspace.path.length > 0 && normalizePath(workspace.path) === target) return workspace.id
  }
  return ''
}

/**
 * A title derived from a transcript, for a session that has none of its own.
 *
 * A session's first user message is a far better label in a picker than its id.
 *
 * @param {object[]} rows - Transcript rows.
 * @returns {string} The title, or an empty string when there is nothing to use.
 */
export function titleFrom(rows) {
  const first = rows.find((row) => row.kind === 'user')
  if (first === undefined) return ''
  const text = oneLine(first.text, TITLE_MAX)
  return text.length > 0 ? text : ''
}

/**
 * The harness's own surface rules, resolved once on first need.
 *
 * Deliberately lazy and deliberately optional. The bridge already reaches into
 * the harness tree for `ws` the same way, and this module's contract is that a
 * missing piece costs a transcript rather than the plugin — so a tree where
 * `dsh-session` cannot be resolved falls back to reading `surfaceOp` directly
 * instead of failing to load.
 *
 * @type {object | null | undefined} `undefined` until the first attempt.
 */
let surfaceModule

/**
 * Load the surface API, or settle on `null`.
 * @returns {Promise<{ isAppendSurfaceEvent: (event: unknown) => boolean } | null>} The API, or null.
 */
async function surfaceApi() {
  if (surfaceModule !== undefined) return surfaceModule
  try {
    const loaded = await loadPeer('@deepseek-ai/dsh-session')
    // Both, and neither preferred: this package's default export is its
    // `SessionStore` class, so taking `.default` first — as the `ws` resolution
    // elsewhere in this plugin correctly does, because there the default *is*
    // the module — threw away the namespace carrying this function and silently
    // fell back to the local rule.
    const candidates = [loaded, loaded?.default]
    surfaceModule = candidates.find((candidate) => (
      typeof candidate?.isAppendSurfaceEvent === 'function'
    )) ?? null
  } catch {
    surfaceModule = null
  }
  return surfaceModule
}
