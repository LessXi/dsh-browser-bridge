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

/**
 * Longest the reason behind a failed tool call may be.
 *
 * Longer than a call's summary on purpose: a summary names what was asked for
 * (`#save`), and the reason is the sentence explaining why it did not happen —
 * clipping that to a selector's width is what would leave it unread.
 */
const TOOL_FAILURE_MAX = 200

/** Longest a derived fallback title may be. */
const TITLE_MAX = 60

/**
 * Most search results one query may return.
 *
 * A cap rather than a page: the matches are a *map* of where the word appears,
 * so the reader wants them all at once. Thirty is enough to show the shape of a
 * conversation without turning the list into a second transcript, and the panel
 * says when the cap was reached rather than pretending it found everything.
 */
const SEARCH_MAX = 30

/** Longest an attachment notice may be before it is clipped. */
const CONTEXT_LABEL_MAX = 60

/**
 * Longest a failure reason may be before it is clipped.
 *
 * Provider failures are written for a developer reading a log, and some are
 * several lines of remediation advice. The panel shows one line; the full text
 * stays in the session log and in the live toast, which is where someone who
 * wants to act on it will look.
 */
const FAILURE_TEXT_MAX = 160

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
 * Collect the images a message content array carries.
 *
 * `textBlocks` deliberately drops everything that is not text, so a picture the
 * reader sent was dropped with it: the panel showed a conversation the reader
 * never had, and a message that was only a picture produced no row at all,
 * because the caller skips an empty text.
 *
 * Only the *reference* is collected. The harness stores images
 * content-addressed on disk — the object store on this machine holds 231 of
 * them, median 99 KB and up to 3.6 MB — and one 60-row window of pictures would
 * be ~84 MB of base64, re-sent on every poll. So a row names its images and the
 * bytes are fetched one at a time, by a route that checks the id against the
 * session it is being asked about.
 *
 * The harness defines an image block as `{ type: 'image', attachment: ref }`,
 * and the ref is what carries `attachmentId`/`mediaType`/`width`/`height`. A
 * block whose bytes are inline instead has no `attachment`, so it is skipped
 * rather than half-read: there is no id to fetch it by later.
 *
 * `depth` exists because the two callers nest differently, and the difference is
 * measurable rather than stylistic. A reader's own message carries its images at
 * the top level — 191 of the 254 image blocks in this machine's logs sit as a
 * sibling of the text block, `[text, image]`. A tool result wraps them one level
 * deeper, inside the `tool-result` block that `toolResultText` already descends
 * into for the same reason; 63 of the 254 are there. Reading only the top level
 * would silently find three quarters of them.
 *
 * @param {unknown} content - The message's content array.
 * @param {number} [depth] - Levels to descend through nested content arrays.
 * @returns {object[]} One entry per referenced image, in the order written.
 */
export function imageBlocks(content, depth = 1) {
  if (!Array.isArray(content) || depth <= 0) return []
  const found = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    if (block.type !== 'image') {
      if (Array.isArray(block.content)) found.push(...imageBlocks(block.content, depth - 1))
      continue
    }
    const attachment = block.attachment
    if (typeof attachment !== 'object' || attachment === null) continue
    const attachmentId = asText(attachment.attachmentId)
    if (attachmentId.length === 0) continue
    // Dimensions and byte count come from the reference, so the panel can hold
    // the right space before the bytes arrive. A missing one is left out rather
    // than defaulted: a made-up aspect ratio would shift the transcript when the
    // picture loads, which is the jump this is here to avoid.
    const width = Number.isFinite(attachment.width) ? attachment.width : 0
    const height = Number.isFinite(attachment.height) ? attachment.height : 0
    const name = asText(attachment.name)
    found.push({
      attachmentId,
      mediaType: asText(attachment.mediaType) || 'application/octet-stream',
      bytes: Number.isFinite(attachment.bytes) ? attachment.bytes : 0,
      width,
      height,
      ...(name.length > 0 ? { name } : {}),
    })
  }
  return found
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
  if (hasErrorBlock(content)) return true
  return data?.error !== undefined && data?.error !== null
}

/**
 * Whether an error flag appears anywhere in a content array, including inside a
 * `tool-result` block's own content.
 *
 * The nesting is the same one `toolResultText` follows, and missing it here is
 * worse than missing a reason: a failed call would be drawn as a success, so the
 * one row that should stand out would be coloured like the ones that worked.
 *
 * @param {unknown} content - A content array, possibly nested.
 * @param {number} [depth] - Remaining levels to descend.
 * @returns {boolean} True when any block carries `isError`.
 */
function hasErrorBlock(content, depth = 4) {
  if (!Array.isArray(content) || depth <= 0) return false
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    if (block.isError === true) return true
    if (block.type === 'tool-result' && hasErrorBlock(block.content, depth - 1)) return true
  }
  return false
}

/**
 * Why a tool call failed, in the tool's own words.
 *
 * A failed browser call used to reach the panel as a bare cross: the row kept
 * the arguments (`#save`) but threw the result away, so a person watching the
 * model work saw `✕ browser_click #save` and nothing about *why*. The model was
 * the only reader of the reason, which meant someone who needed to decide
 * whether to intervene — close the DevTools window, grant the origin, stop the
 * run — had no way to tell a mis-aimed selector from a blocked tab from a page
 * that never answered.
 *
 * The reason is taken from the result's text, and from the error's message when
 * there is no text, because the two carriers are used by different failure
 * paths: a tool that returns a diagnostic string, and one that throws.
 *
 * @param {unknown} data - A `tool/result` event's data.
 * @returns {string} One line, or an empty string when nothing explains it.
 */
export function toolFailure(data) {
  const message = data?.message
  const content = Array.isArray(message?.content) ? message.content : []
  const fromContent = toolResultText(content)
  if (fromContent.length > 0) return oneLine(fromContent, TOOL_FAILURE_MAX)
  const error = data?.error
  if (typeof error === 'string') return oneLine(error, TOOL_FAILURE_MAX)
  const fromError = asText(error?.message) || asText(message?.error)
  return fromError.length > 0 ? oneLine(fromError, TOOL_FAILURE_MAX) : ''
}

/**
 * Join the text inside a tool result, following the nesting the harness writes.
 *
 * A `tool/result` message does not carry its text directly: it holds one
 * `tool-result` block whose own `content` is the blocks the tool produced. The
 * host's `collectImageRefs` recurses into it for exactly this reason, and a
 * reader that stops at the outer block finds nothing — which is how a failure
 * reason silently came back empty and left the row with a bare cross.
 *
 * Recursion is bounded rather than trusting the shape: this runs on whatever a
 * session's log contains, and a cycle would hang the read that draws the panel.
 *
 * @param {unknown} content - A content array, possibly nested.
 * @param {number} [depth] - Remaining levels to descend.
 * @returns {string} The joined text, or an empty string.
 */
function toolResultText(content, depth = 4) {
  if (!Array.isArray(content) || depth <= 0) return ''
  const parts = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    if (block.type === 'tool-result') {
      const nested = toolResultText(block.content, depth - 1)
      if (nested.length > 0) parts.push(nested)
      continue
    }
    if (block.type === 'text') {
      const text = asText(block.text)
      if (text.length > 0) parts.push(text)
    }
  }
  return parts.join('\n').trim()
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
      // The last call's status stands for the run, and its reason has to travel
      // with it: taking the status without the reason would draw a merged row
      // with a cross on it and nothing to explain the cross, which is the exact
      // shape this row exists to avoid. A call that succeeded clears the reason,
      // because the run's final word is that it worked.
      previous.status = row.status
      if (typeof row.failure === 'string' && row.failure.length > 0) previous.failure = row.failure
      else delete previous.failure
      // Pictures are carried across the merge for the same reason the reason is:
      // the row now stands for every call in the run, so a picture produced by
      // the third one belongs to it. Dropping them here would be the same defect
      // this row was fixed for, one level down — a thing that exists and is not
      // drawn. Measured on this machine's logs, an image-producing call never
      // merges (254 of them, every summary distinct), so this guards a shape
      // rather than a case that has been seen.
      if (Array.isArray(row.images) && row.images.length > 0) {
        const images = Array.isArray(previous.images) ? previous.images : []
        const seen = new Set(images.map((image) => image.attachmentId))
        for (const image of row.images) {
          if (seen.has(image.attachmentId)) continue
          seen.add(image.attachmentId)
          images.push(image)
        }
        previous.images = images
      }
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
   * The question each turn was started with, by the harness's turn number.
   *
   * A failed turn leaves the person with a sentence and nothing to do about it.
   * The host has no way to re-run a turn, so the only honest recourse the panel
   * can offer is to put the question back in the composer — which means the
   * panel has to know what that question was.
   *
   * It cannot be found by looking upward from the failed row: a turn's reply can
   * run for hundreds of rows, and the row directly above the failure is usually
   * an assistant line or a `llm/retry`, not the question. The turn number is
   * what links them, and the link is positional.
   *
   * Read off a real session log rather than the fixtures, because the two
   * disagree and only one of them is evidence (`~/.dsh/sessions`, a 16749-event
   * log, decoded frame by frame — the file is a sequence of independent zstd
   * frames, one per append, so reading only the first yields the header):
   *
   *   seq 2857  turn/start        turn=3
   *   seq 2871  user/message      source.kind='user'  ← the question
   *   seq 2873  assistant/message turn=3
   *
   * So the question arrives *inside* the turn it starts and carries no turn of
   * its own — `user/message` has only `content`/`id`/`role`/`source`. The open
   * turn is the link, and it is the last `turn/start` seen.
   *
   * @type {Map<number, string>}
   */
  const questionByTurn = new Map()
  /** The turn currently accepting a question, or null before the first one. */
  let openTurn = null
  /**
   * Turns that already carry a trigger row, so a turn that several
   * notifications arrive for is labelled once.
   *
   * @type {Set<number>}
   */
  const labelledTurns = new Set()

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

  /**
   * The turn an event belongs to, or null when it does not say.
   *
   * Not every event carries one — `user/message` is written before the turn it
   * starts has a number, and older logs may not have them at all — so this
   * returns null rather than a guess. A wrong turn number would hand the reader
   * someone else's question.
   *
   * @param {object} event - One session event.
   * @returns {number | null} The turn number.
   */
  const turnOf = (event) => {
    const turn = event?.data?.turn
    return typeof turn === 'number' && Number.isInteger(turn) ? turn : null
  }

  for (const event of events) {
    if (typeof event?.type !== 'string') continue
    const data = event.data

    switch (event.type) {
      case 'user/message': {
        const source = data?.source
        // Compaction is handled before the `appended` guard below, and that
        // ordering is the point rather than an accident. A checkpoint is a
        // *replacement* — it is the event that removes the range it summarizes —
        // so the guard, whose whole job is to skip replacements, would drop the
        // one event that explains why the conversation got shorter.
        //
        // Without a row here the transcript simply begins: a reader who scrolls
        // up finds the discussion starting mid-thought, with nothing to say it
        // was ever longer. Measured across this machine's sessions, that is not
        // hypothetical — 30 of 156 sessions have been compacted, one of them 77
        // times.
        if (source?.kind === 'compact-checkpoint') {
          // The interval is the honest count of what this checkpoint covers. It
          // comes from the event's own `surfaceOp` rather than from counting rows
          // here, because rows are what survived; the range is what was replaced.
          const op = event.surfaceOp
          const from = op?.startSeq
          const to = op?.endSeq
          const shadowed = Number.isInteger(from) && Number.isInteger(to) && to >= from
            ? to - from + 1
            : 0
          // The summary is shown rather than dropped: it is the only surviving
          // account of the part of the conversation just removed, and it is
          // written for a reader — real ones on this machine run 1.3k–6.1k
          // characters of prose.
          rows.push({
            kind: 'compaction',
            text: textBlocks(data?.content),
            shadowed,
            // Carried so the panel can name the row. Its key falls back to the
            // text, and a checkpoint whose summary failed to arrive has none —
            // which would make every such row the same row, the way an empty
            // `callId` once made every tool row the same row.
            compactionId: typeof source.compactionId === 'string' ? source.compactionId : '',
          })
          break
        }
        if (!appended(event)) break
        if (source?.kind === 'user') {
          const text = textBlocks(data?.content)
          const images = imageBlocks(data?.content)
          // A message that is only a picture is still a message. Skipping the
          // row because its text is empty meant a reader who sent a screenshot
          // with no caption saw nothing at all — the panel showed a turn that
          // began with no question.
          if (text.length > 0 || images.length > 0) {
            rows.push({ kind: 'user', text, ...(images.length > 0 ? { images } : {}) })
            // The question belongs to the turn it arrived in; see
            // `questionByTurn`. Only a question the reader typed can be handed
            // back, so injected context — goal rounds, compaction notices, the
            // nudge — never becomes a retry offer.
            // First question wins: it is the one the turn opened with. A second
            // queued message belongs to the same turn but did not start it, and
            // joining the two would fabricate a message nobody wrote.
            if (text.length > 0 && openTurn !== null && !questionByTurn.has(openTurn)) {
              questionByTurn.set(openTurn, text)
            }
          }
          break
        }
        // Everything else that opens a turn is a machine talking to the model:
        // goal rounds, team messages, subagent notifications, plugin nudges.
        // Their words are not shown — they are not part of the conversation, and
        // pasting a 9 KB skill catalog into the transcript would bury it.
        //
        // But the turn they open is shown, and without a row here it reads as
        // the model answering nothing. Measured across this machine's 156 real
        // sessions, that is 112 of 243 turns — 46% — where the reader's own
        // message is nowhere on screen and something else started the reply.
        // "Why is it talking" is a question the panel has to be able to answer.
        //
        // Only the first message of a turn is labelled, so this names what
        // started the turn rather than listing every notification that joined
        // it. `labelledTurns` is what keeps it to one row per turn.
        if (typeof source?.kind === 'string' && source.kind.length > 0
          && openTurn !== null && !labelledTurns.has(openTurn)) {
          labelledTurns.add(openTurn)
          // `provider` travels with the kind because the harness tells GitHub
          // events apart from other webhooks by it rather than by a kind of
          // their own (`turnTriggerDetails` reads `source.provider`). Sending
          // only the kind would leave the panel unable to make the same
          // distinction the other surface makes.
          const provider = asText(source.provider)
          rows.push({ kind: 'trigger', text: source.kind, ...(provider.length > 0 ? { provider } : {}) })
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

      case 'turn/start': {
        // Opens the turn the next question will arrive in. Kept as the turn
        // number the log itself uses, so the failure at the end of the turn
        // finds the same one.
        openTurn = turnOf(event)
        break
      }

      case 'turn/end': {
        // A turn that died commits no assistant message, so without this the
        // transcript of a failed turn is just the user's message and then
        // nothing — the same silence the live `failed` frame exists to break,
        // except this one survives a reload and a cold replay. Only `error` is
        // reported: `aborted` means the turn was stopped on purpose, which the
        // person did themselves, and a normal turn ends with no reason at all.
        //
        // The turn is closed here either way, and the question it started with
        // is taken out of the map as it is read: it is only ever wanted by the
        // failure at the end of its own turn, and a question arriving after this
        // point belongs to the next one.
        const turn = turnOf(event) ?? openTurn
        openTurn = null
        const question = turn === null ? undefined : questionByTurn.get(turn)
        if (turn !== null) questionByTurn.delete(turn)
        // Taken out here for the same reason the question is: a turn that has
        // ended cannot accept another notification, so keeping its label around
        // would only grow the set for the life of the session.
        if (turn !== null) labelledTurns.delete(turn)

        if (data?.reason?.kind !== 'error') break
        const text = oneLine(asText(data.reason.error?.message), FAILURE_TEXT_MAX)
        const code = asText(data.reason.error?.code)
        // The code is what the panel turns into a sentence; the message is the
        // developer's own wording and only reaches the screen when the code is
        // one the panel has no words for.
        //
        // The question travels with the row so the panel can offer the only
        // recourse that is honest: giving it back to the reader. It is carried
        // only when this turn really was started by one — a goal round or a
        // scheduled wake-up has no question of the reader's to restore.
        rows.push({
          kind: 'failed',
          text,
          ...(code !== '' ? { code } : {}),
          ...(question === undefined ? {} : { question }),
        })
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
        if (row !== undefined) {
          const failed = toolFailed(data)
          row.status = failed ? 'error' : 'ok'
          // Only a failure carries a reason. A successful call's output is the
          // page, not an explanation, and putting it on the row would turn every
          // snapshot into a wall of text.
          if (failed) {
            const reason = toolFailure(data)
            if (reason.length > 0) row.failure = reason
            else delete row.failure
          } else {
            delete row.failure
          }
          // Images accumulate where the status does not, because the two say
          // different kinds of thing. A status is a property of the call and the
          // latest word settles it; a picture is something the call *produced*,
          // and a later result carrying no picture does not unproduce it. Adding
          // rather than assigning is also the only choice that cannot lose one:
          // `browser_screenshot` is exactly this row, and a screenshot that never
          // appears is the bug this row exists to fix.
          //
          // Each distinct image is kept once. An id is a content address, so the
          // same one twice is the same bytes, and showing it twice would be a
          // visible duplicate rather than two findings.
          const produced = imageBlocks(data?.message?.content, 2)
          if (produced.length > 0) {
            const images = Array.isArray(row.images) ? row.images : []
            const seen = new Set(images.map((image) => image.attachmentId))
            for (const image of produced) {
              if (seen.has(image.attachmentId)) continue
              seen.add(image.attachmentId)
              images.push(image)
            }
            row.images = images
          }
        }
        break
      }

      default:
        break
    }
  }

  return rows
}

/**
 * The text a row shows, for searching.
 *
 * Every field a row can put on screen, and nothing else. Searching `callId`
 * would match a string the reader cannot see, which turns a search result into
 * a row that does not appear to contain the word.
 *
 * @param {object} row - A transcript row.
 * @returns {string} Its searchable text.
 */
export function searchableText(row) {
  const parts = [row.text, row.name, row.summary, row.failure]
  return parts.filter((part) => typeof part === 'string').join(' ')
}

/**
 * Find rows whose visible text contains `query`, newest first.
 *
 * Case-insensitive and literal. Deliberately not a regex: a transcript is full
 * of `.`, `(`, `[` and `\`, so a search for `filter(` would throw and one for
 * `a.b` would match `axb`. Someone searching their own conversation means the
 * characters they typed.
 *
 * Matching is per row rather than per line, because a row is the unit the
 * transcript draws and the unit a result can scroll to.
 *
 * @param {object[]} rows - Transcript rows, oldest first.
 * @param {string} query - What to look for.
 * @param {number} [maximum] - Most matches to return.
 * @returns {{ index: number, row: object }[]} Matches, each with its position in `rows`.
 */
export function findRows(rows, query, maximum = SEARCH_MAX) {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return []
  const found = []
  // Walked backwards so the newest match comes first: the end of a
  // conversation is where someone scrolling back is looking, and a result list
  // starting at the beginning of a 6969-row session is not one anybody reads to
  // the bottom of.
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (searchableText(rows[index]).toLowerCase().includes(needle)) {
      found.push({ index, row: rows[index] })
      if (found.length >= maximum) break
    }
  }
  return found
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
 * @param {object|Function} [ports.attachments] - The harness attachment store, for reading images a session refers to.
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
  const attachmentsOf = () => resolvePort(ports.attachments)

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
   * `limit` is how many rows to return and `before` is how many rows to skip
   * from the end, so the panel can walk backwards through a conversation that
   * does not fit on screen. A long session is not unusual — one of the author's
   * own is 6969 rows — and returning only the tail with no way to ask for more
   * meant 99% of a conversation was unreachable.
   *
   * @param {string} sessionId - The session.
   * @param {number} [limit] - Maximum rows.
   * @param {number} [before] - Rows to drop from the end first.
   * @param {number} [end] - Absolute row index to end the window at; wins over `before`.
   * @returns {Promise<{ title: string, messages: object[], more: boolean, total: number }>} The title, rows, whether anything older remains, and how many rows the session has in all.
   */
  const readMessages = async (sessionId, limit, before, end) => {
    const maximum = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT
    const skip = Number.isInteger(before) && before > 0 ? before : 0
    const replay = await readThrough(sessionId)
    const derived = titleFrom(replay.messages)
    const size = replay.messages.length
    // Sliced from the end, so `before` walks back through the conversation and
    // the newest row is always the last one returned.
    //
    // `end` is the same window named by an absolute row index, and it exists
    // because a count from the end is not a position in a conversation that is
    // still being written to: searching, jumping to a match, and then having the
    // model append a reply would slide the reader forward by exactly the number
    // of rows that arrived. An absolute index does not move when the end does.
    const stop = Number.isInteger(end) && end >= 0 ? Math.min(end, size) : Math.max(0, size - skip)
    const start = Math.max(0, stop - maximum)
    return {
      // The listing is the authority on titles; a session that is not in the
      // list (a brand-new one, say) falls back to the transcript's own words.
      title: replay.title || knownTitles.get(sessionId) || derived,
      messages: replay.messages.slice(start, stop),
      more: start > 0,
      // The row count, because a search result is a position and the caller has
      // to turn that position into a window. Without it the panel can only count
      // what it was already given, which is the window it is trying to move away
      // from.
      total: size,
    }
  }

  /**
   * Search one session's whole transcript.
   *
   * Searched on the host rather than in the panel because the panel only ever
   * holds a window — 60 rows of 6969 — and a search that answered "not found"
   * from the rows on screen would be **lying about the reader's own
   * conversation**. The host reads the session in full and can answer for all
   * of it.
   *
   * @param {string} sessionId - The session.
   * @param {string} query - What to look for.
   * @returns {Promise<{ matches: object[], total: number, truncated: boolean }>} Matches, the row count, and whether the cap cut the list short.
   */
  const searchMessages = async (sessionId, query) => {
    const replay = await readThrough(sessionId)
    const matches = findRows(replay.messages, typeof query === 'string' ? query : '')
    return {
      matches,
      total: replay.messages.length,
      // Said out loud rather than implied: a capped list that reads as complete
      // is how someone concludes their conversation does not contain a word it
      // does contain.
      truncated: matches.length >= SEARCH_MAX,
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
   * Stop the turn a session is running.
   *
   * The harness's `cancel` is deliberately narrow: it cancels the *active turn*
   * and keeps the agent's pending inbox (`agent.cancel({ kind: 'user' }, {
   * keepInbox: true })` in `dsh-api-session-controller/lib/index.js:876`). That
   * is the meaning the button needs — a person pressing stop wants the model to
   * stop talking, not to have the message they queued behind it thrown away.
   *
   * It throws `session/not-found` when nothing is attached, which is the common
   * case for a session that is not running at all, so that comes back as a
   * refusal rather than an error.
   *
   * @param {string} sessionId - The session whose turn should stop.
   * @returns {Promise<{ cancelled: true, sessionId: string } | { cancelled: false, reason: string }>} The outcome.
   */
  const cancel = async (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return { cancelled: false, reason: 'no session was named' }
    }
    const commands = commandsOf()
    if (commands === undefined || typeof commands.cancel !== 'function') {
      return {
        cancelled: false,
        reason: 'the harness does not expose turn cancellation, so the bridge cannot stop this turn',
      }
    }
    try {
      await commands.cancel({ sessionId })
      // Whatever was streaming is now abandoned; the panel is about to get an
      // `end` frame with an `abandoned` outcome and re-read the transcript.
      coldCache.delete(sessionId)
      return { cancelled: true, sessionId }
    } catch (error) {
      return { cancelled: false, reason: error?.message ?? String(error) }
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
      cancel: typeof commands?.cancel === 'function',
      workspaces: typeof workspaces?.list === 'function',
      // `untried` until a read has needed the surface rules; `false` means the
      // narrower local rule is in use, which is worth knowing because it is the
      // copy that can drift.
      surfaceRules: surfaceModule === undefined ? 'untried' : surfaceModule !== null,
    }
  }

  /**
   * Read one image a session's own log refers to.
   *
   * The panel needs the bytes one at a time rather than in the transcript: the
   * object store here holds 231 images, median 99 KB and up to 3.6 MB, so a
   * 60-row window of pictures would be ~84 MB of base64 — and the panel polls,
   * so it would be that again every eight seconds.
   *
   * The id is checked against *this* session before any bytes are read. An
   * `attachmentId` is documented as "opaque storage identifier; never a
   * filesystem path or bearer URL", so the panel never learns a path — but an
   * opaque id is still a capability, and without this check any id would fetch
   * any image from the whole store, including ones belonging to conversations
   * the reader has not opened. The harness's own remote route draws the same
   * line (`referencedImage(source.events, attachmentId)`, then
   * `ATTACHMENT_NOT_REFERENCED`).
   *
   * `readImage` verifies the stored bytes against the reference — sha256, byte
   * length, media type, and both dimensions — so a corrupt or substituted
   * object fails here rather than rendering as a broken picture.
   *
   * @param {string} sessionId - The session the image must belong to.
   * @param {string} attachmentId - The id as it appeared in that session's log.
   * @returns {Promise<{ data: Uint8Array, mediaType: string }>} The verified bytes.
   */
  const readImage = async (sessionId, attachmentId) => {
    const replay = await readThrough(sessionId)
    const ref = replay.messages
      .flatMap((row) => row.images ?? [])
      .find((image) => image.attachmentId === attachmentId)
    if (ref === undefined) {
      throw new Error('that image is not part of this session')
    }
    const store = attachmentsOf()
    if (store === undefined || typeof store.readImage !== 'function') {
      throw new Error('the harness does not expose an attachment store')
    }
    const stored = await store.readImage(ref, never())
    const data = stored?.data
    if (!(data instanceof Uint8Array) && !ArrayBuffer.isView(data)) {
      throw new Error('the attachment store returned no image bytes')
    }
    return {
      data: data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      mediaType: asText(ref.mediaType) || 'application/octet-stream',
    }
  }

  return { listSessions, readMessages, searchMessages, createSession, send, cancel, readModels, selectModel, readImage, services }
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
