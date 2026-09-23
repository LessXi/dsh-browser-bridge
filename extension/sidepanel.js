/**
 * Side panel: the conversation surface for the DSH session you are browsing
 * with.
 *
 * This is the piece that makes the extension worth opening rather than a status
 * read-out. It talks to the harness over the bridge's own loopback routes —
 * guarded by the same origin policy as everything else, carrying the panel's
 * conversation rather than browser commands. The service worker stays a pure
 * executor.
 *
 * Four deliberate limits, all recorded in the README:
 *
 *   - **Live output arrives as text, not as markdown.** The host relays the
 *     agent's own stream frames (see `lib/stream.js`), and this panel draws them
 *     as plain text with a caret. A half-finished table or code fence parses
 *     into something different on every frame, so the parsed row arrives with
 *     the commit — which is also why the live block is replaced rather than
 *     appended to. `@`-mention and attachment state mid-send is still a poll.
 *   - **The session is chosen, not guessed.** A message goes to the session
 *     named in the header. Restoring the last session you looked at is not a
 *     guess — the name is on screen before you type — but silently picking a
 *     *different* one because it happened to be active would be, and is not
 *     done.
 *   - **Attachments ride the send, not a separate event.** The tab's identity
 *     and the shown selection travel in the `send` request body, so the host
 *     stages them in the same handler that delivers the prompt. Staging them as
 *     an unsolicited event first — the shape the right-click menu uses — would
 *     race the prompt across two sockets and occasionally attach the context to
 *     the *next* message.
 *   - **Nothing is redrawn that has not changed.** Every refresh compares the
 *     rows it would draw against the rows already on screen. The previous panel
 *     rebuilt the whole list on an eight-second timer, which is half of why the
 *     view jumped; the other half was that it then scrolled to the bottom
 *     unconditionally.
 *
 * @module extension/sidepanel
 */

import { pickLocale, relativeTime, translator } from './locales.js'
import { modelLabel, modelMenuModel } from './model-menu.js'
import { mentionAt, mentionMenu, mentionRows } from './mention.js'
import { renderMarkdown } from './markdown.js'
import { failureDetail, failureSentence } from './failure.js'

const locale = pickLocale(globalThis.chrome?.i18n?.getUILanguage?.())
const t = translator(locale)
document.documentElement.lang = locale

/**
 * How close to the bottom counts as "following along".
 *
 * The official side panel uses 24px for the same judgement. The number matters
 * more than it looks: too small and a reply streamed while you read the last one
 * yanks the view away, too large and scrolling up to re-read does nothing.
 */
const NEAR_BOTTOM_PX = 24

/** How long the transcript poll waits between reads while a turn runs. */
const POLL_MS = 8000

/**
 * How many rows of a conversation the panel keeps on screen.
 *
 * Reads are windowed from the newest row, and this number grows by one page each
 * time the reader asks for earlier rows. It is not a cache: the host returns the
 * window and the panel replaces what it has, so a poll and a "load earlier" are
 * the same request at two sizes.
 */
const PAGE_ROWS = 60

/**
 * Rows drawn below a search match, so it can be centred rather than pinned.
 *
 * A window that ends on the match puts it in the bottom row of the screen —
 * flush against the composer, with nothing after it. Photographed, that reads as
 * the end of the conversation rather than as a place inside it, and the reader
 * loses the answer that followed the question they searched for. These rows cost
 * nothing to fetch (they are in the same window) and give the browser something
 * to centre the match against.
 */
const MATCH_CONTEXT_ROWS = 12

const backButton = document.getElementById('back')
const titleButton = document.getElementById('title')
const titleText = document.getElementById('title-text')
const newButton = document.getElementById('new')
const findOpenButton = document.getElementById('find-open')
const findBar = document.getElementById('find')
const findInput = document.getElementById('find-input')
const findCount = document.getElementById('find-count')
const findPrev = document.getElementById('find-prev')
const findNext = document.getElementById('find-next')
const findClose = document.getElementById('find-close')
const transcript = document.getElementById('transcript')
const history = document.getElementById('history')
const toBottom = document.getElementById('to-bottom')
const earlierButton = document.getElementById('earlier')
const toast = document.getElementById('toast')
const announcer = document.getElementById('announcer')
const surface = document.getElementById('blocked')
const blockedTitle = document.getElementById('blocked-title')
const blockedBody = document.getElementById('blocked-body')
const blockedAction = document.getElementById('blocked-action')
const contexts = document.getElementById('contexts')
const input = document.getElementById('input')
const sendButton = document.getElementById('send')
const modelButton = document.getElementById('model')
const modelText = document.getElementById('model-text')
const modelMenu = document.getElementById('model-menu')
const atMenu = document.getElementById('at-menu')

/** @type {{ text: string, url: string, title: string }} */
let currentSelection = { text: '', url: '', title: '' }
/** @type {{ id?: number, url: string, title: string, icon: string }} */
let currentTab = { url: '', title: '', icon: '' }
/** Tabs the bridge has grouped, listed in the history view. */
let controlledTabs = []
/**
 * Every tab the panel can see, which is what the `@` picker offers.
 *
 * Module level rather than local to `refreshTabs`: the picker is drawn from a
 * keystroke, and it must not be the case that opening `@` before the first poll
 * has landed shows an empty menu.
 *
 * @type {object[]}
 */
let tabs = []
/** Whether the harness answered at all, and whether the extension is attached to it. */
let hostReachable = false
let bridgeConnected = false
/** Whether a retry from the blocked surface is in flight. */
let retrying = false
/** Whether the host says older rows exist beyond the window on screen. */
let hasEarlier = false
/** How many rows of the current conversation the panel is showing. */
let depth = PAGE_ROWS
/**
 * The absolute row index the window ends at, or null while it ends at the newest row.
 *
 * A count back from the end is the right way to name "the newest 60 rows", and
 * the wrong way to name a position in a conversation that is still being written
 * to: search, jump to a match, and then let the model append a reply, and the
 * reader slides forward by exactly the rows that arrived. So a jump names its
 * window by absolute index and keeps naming it that way until the reader returns
 * to the end.
 *
 * @type {number | null}
 */
let anchorEnd = null
/**
 * How many rows the session has in all, as the host last reported it.
 *
 * The panel's window is a slice, and without the session's own size there is no
 * way to tell "the bottom of the window" from "the bottom of the conversation".
 * Zero until a read answers, which reads as "nothing below" — the safe default,
 * because it never promises rows that may not exist.
 */
let windowTotal = 0
/** Whether a "load earlier" request is in flight. */
let loadingEarlier = false
/**
 * Set by `loadEarlier` so the next `drawTranscript` holds the reading position.
 *
 * A one-shot flag rather than a parameter because the redraw happens inside
 * `refreshTranscript`, which the poll and the send path also call — threading it
 * through would give those two a meaningless argument to pass.
 */
let grewEarlier = false
/** Whether the host answered, but with a shape this panel does not understand. */
let hostStale = false
/**
 * The open search field's text, or an empty string when search is closed.
 *
 * Held as state rather than read off the input because the poll re-renders, and
 * a search that only existed in the DOM would be cleared by a repaint the reader
 * never asked for.
 */
let searchQuery = ''
/** The matches the host returned for `searchQuery`, newest first. */
let searchHits = []
/** How many rows the searched session has in all, for the position line. */
let searchTotal = 0
/** Whether the host's cap cut the match list short. */
let searchTruncated = false
/** Whether a search request is in flight. */
let searching = false
/** Whether the find bar is open. */
let findOpen = false
/** Which match the reader is on, as an index into `searchHits`. */
let searchPosition = 0
/** Whether the shown selection should travel with the next send. */
let selectionAttached = false
/** Port of the running harness, mirrored from the options page. */
let harnessPort = '3080'
/** True while a send is in flight, so the poll does not fight the button. */
let sending = false
/** True while a stop request is in flight. */
let stopping = false
/**
 * True while a create request is in flight.
 *
 * Creating is the one action here that makes something rather than reads it, so
 * a second click is not a repeated read — it is a second session. The host mints
 * a fresh id every time and this panel can only show one of them, so without
 * this the extra one is orphaned in the list with nothing to explain it. The
 * window is small but the button is right where a hurried reader's finger is.
 */
let creating = false
/** `'chat'` or `'history'`. */
let view = 'chat'
/**
 * The approval question the panel is currently showing, if any.
 *
 * The harness asks its answerers in parallel, so this can be answered here or
 * in the graphical client, whichever comes first — and when the other one wins,
 * `dsh-approval-settled` arrives and the card goes away. Holding the id is what
 * lets the answer name the question it belongs to instead of guessing at "the
 * current one", which would be wrong the moment two turns overlap.
 *
 * @type {{ id: string, sessionId: string, toolName: string, reason?: string } | null}
 */
let pendingApproval = null
/** True while an approval answer is in flight, so the buttons cannot double-fire. */
let answering = false
/**
 * What the approval card currently on screen represents.
 *
 * `renderApproval` is called from paths that repaint the transcript, so it has
 * to know whether the card it would draw is the one already there. Keeping the
 * key here rather than reading it back off the DOM is what lets the busy state
 * count as a difference.
 */
let drawnApproval = ''
/**
 * The `tabId:url` whose reporter was last found unreachable.
 *
 * Kept so the panel says it once per page instead of on every focus change —
 * repeating it would be nagging about something the user cannot act on twice.
 */
let staleReporter = ''

/** @type {{ id: string|null, title: string, sessions: object[] }[]} */
let groups = []
/** @type {string} */
let currentSessionId = ''
/** Whether the session on screen is one the harness reports as still blank. */
let currentSessionBlank = false
/** Whether the session on screen has a turn running. */
let currentSessionRunning = false
/**
 * What the reader has typed and not sent, by session id.
 *
 * Read back from storage on the way up and written on every keystroke, so it
 * spans one opening of the panel and the next — see `setDraft`.
 *
 * @type {Map<string, string>}
 */
const drafts = new Map()
/**
 * Where one session's draft lives between openings of the panel.
 *
 * One key per session rather than one key holding the whole map. Two windows can
 * have a panel open at once, and a single record would have each of them writing
 * back every *other* session's draft from its own stale copy — so typing in one
 * window would quietly revert what was typed in the other.
 */
const DRAFT_PREFIX = 'panelDraft:'
/** Reasoning rows the user opened, by row name. See `rowKey`. */
const expandedReasoning = new Set()
/**
 * Failed tool rows the user opened, by row name. See `rowKey`.
 *
 * Separate from `expandedReasoning` because a row is only ever one kind, and
 * sharing one set would make opening a failure also open whatever reasoning row
 * happened to carry the same name.
 */
const expandedFailures = new Set()
/** The last drawn transcript, for the "did anything change" comparison. */
let drawnSignature = ''
/**
 * The row nodes currently on screen, in draw order.
 *
 * Kept so a redraw can reuse the node a row already has instead of building a
 * new one. Rebuilding is what `replaceChildren` did, and it threw away more than
 * the node: the element holding keyboard focus was destroyed, so the browser
 * moved focus to `<body>` — from a row thirty tab stops down, the reader had to
 * walk the whole transcript again — and any text they had selected was gone.
 * Both happen on the two most ordinary interactions there are: clicking a row
 * open, and a poll landing while they read.
 */
let drawnRows = []
/** True while the view is pinned to the newest row. */
let stickToBottom = true
/** The deployment's model catalog, or null until it has been read. */
let catalog = null
/** Why the catalog is missing, when it is. */
let catalogReason = ''
/** Whether the picker is open. */
let menuOpen = false

/**
 * The picker contents currently on screen, as a signature.
 *
 * Rebuilding rows that are already right is not free. `drawModel` runs on every
 * `renderChrome`, which runs on every five-second `refreshGroups` — so an open
 * menu was torn down and rebuilt every five seconds whether or not the catalog
 * had changed. Measured in a real browser: a `MutationObserver` on the menu
 * recorded five nodes removed and five added per poll while the reader sat
 * still, and `document.activeElement` went from the focused level to `body`.
 * A keyboard user walking the list lost their place twice a minute.
 *
 * The rows are a pure function of the catalog and the current selection, so
 * comparing what *would* be drawn against this is enough to know whether the
 * DOM already says it.
 */
let drawnMenuSignature = ''
/**
 * The open `@` picker, or null.
 *
 * `start` is where the `@` sits in the composer, so accepting a candidate can
 * replace exactly the word that was typed and leave the rest of the line alone.
 * `index` is the highlighted row, which the arrow keys move and Enter takes.
 *
 * @type {{ start: number, index: number, options: object[] } | null}
 */
let mention = null
/**
 * The last health answer, kept so a question can be adopted on demand.
 *
 * The adoption is skipped while the history is the visible view, so the answer
 * that arrived during that time is the only record of it. Without this the
 * panel would have to wait up to five seconds — one poll — to notice, and the
 * conversation would look frozen in the meantime.
 *
 * @type {object | null}
 */
let lastHealth = null
/**
 * The tab picked with `@`, or null.
 *
 * Separate from `currentTab` because they answer different questions: that one
 * is "the page in front of you", this one is "the page this message is about".
 * Both can be attached, and the chip row shows them apart.
 *
 * @type {{ id?: number, title: string, url: string, icon: string } | null}
 */
let mentioned = null
/**
 * The attempt currently streaming into this panel, or null.
 *
 * The host relays live model output over its own socket and the service worker
 * hands each frame on, which is the only reason a reply can be read as it is
 * written: the session log has no delta events, only whole messages. A panel
 * opened in the middle of a turn never sees `start`, so it simply renders
 * nothing live and waits for the committed rows like before.
 *
 * @type {{ sessionId: string, text: string, reasoning: string, tool: number, done: boolean } | null}
 */
let live = null

/**
 * Which "nothing to show" surface was last announced, so the poll does not repeat
 * it. `''` means nothing is on screen.
 */
let announcedOffline = ''

/**
 * Whether a first request has come back yet.
 *
 * Before that, `hostReachable` is `false` and `groups` is empty — the initial
 * values, not findings — so the surface is up for a moment on every ordinary
 * start. Announcing that would tell a reader "cannot reach dsh web" every time
 * the panel opened, including when the host is healthy, which is worse than
 * saying nothing.
 */
let loadedOnce = false

/**
 * Show a short-lived failure message. There is no success channel: a send that
 * worked is visible as the message appearing, and a notice saying so would be
 * one more line of chrome.
 *
 * `#toast` is a live region (`role="status"`) and is never `hidden`. That is the
 * fix for a real defect rather than a style choice: a live region has to be in
 * the accessibility tree *before* the change it announces, and the element used
 * to be hidden whenever it was empty — which is exactly when a message arrives.
 * Measured, writing text into it while hidden leaves `inTree: false`, so the
 * twenty-odd failures reported through here were announced unreliably or not at
 * all. It is hidden by `:empty` in the stylesheet instead, which costs no height
 * and keeps it observable.
 *
 * Clearing removes the text; the stylesheet collapses the element from there.
 *
 * @param {string} text - The message, or an empty string to clear it.
 * @returns {void}
 */
function say(text) {
  toast.textContent = text
  if (text.length === 0) return
  setTimeout(() => {
    if (toast.textContent === text) toast.textContent = ''
  }, 6000)
}

/**
 * Say something a screen reader has no other way to learn.
 *
 * `#toast` covers failures, but three things the panel does happen silently to a
 * reader who cannot see them: a question appears that blocks the turn until it is
 * answered, the host goes away so nothing can be sent, and an answer finishes
 * arriving. The visible evidence for all three is text appearing somewhere in a
 * transcript that is rebuilt wholesale on every poll — which is why the
 * transcript cannot be a live region itself, and why this separate sentence is
 * needed rather than an attribute on what is already there.
 *
 * The text is written on a later task on purpose. A live region announces a
 * *change*, and two announcements in a row that differ only by content can be
 * coalesced into one; clearing first guarantees the region is observably empty
 * before the new sentence lands.
 *
 * @param {string} text - What to announce.
 * @returns {void}
 */
function announce(text) {
  announcer.textContent = ''
  setTimeout(() => {
    announcer.textContent = text
  }, 0)
}

/**
 * Call one bridge route on the harness.
 *
 * @param {string} path - The route path, with any query already applied.
 * @param {{ method?: string, body?: unknown }} [options] - Request shaping.
 * @returns {Promise<{ ok: boolean, status: number, payload: any }>} The outcome.
 */
async function bridge(path, options = {}) {
  const method = options.method ?? 'GET'
  try {
    const response = await fetch(`http://127.0.0.1:${harnessPort}${path}`, {
      method,
      cache: 'no-store',
      ...(options.body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.body) }),
    })
    let payload
    try {
      payload = await response.json()
    } catch {
      payload = undefined
    }
    return { ok: response.ok, status: response.status, payload }
  } catch (error) {
    return { ok: false, status: 0, payload: { error: error.message } }
  }
}

/**
 * Paint the panel's own static copy.
 *
 * Called once, from `start`: everything else here is data, so this is the whole
 * list of strings that are not a `t()` call at the point of use.
 *
 * @returns {void}
 */
function paintStaticCopy() {
  backButton.textContent = '‹'
  backButton.title = t('action.back.title')
  backButton.setAttribute('aria-label', t('action.back'))
  newButton.textContent = '＋'
  newButton.title = t('action.new.title')
  newButton.setAttribute('aria-label', t('action.new'))
  findOpenButton.textContent = '⌕'
  findOpenButton.title = t('action.find.title')
  findOpenButton.setAttribute('aria-label', t('action.find'))
  findPrev.textContent = '↑'
  findPrev.setAttribute('aria-label', t('action.find.prev'))
  findNext.textContent = '↓'
  findNext.setAttribute('aria-label', t('action.find.next'))
  findClose.textContent = '✕'
  findClose.setAttribute('aria-label', t('action.find.close'))
  findInput.setAttribute('aria-label', t('action.find'))
  findInput.placeholder = t('find.placeholder')
  toBottom.textContent = '↓'
  toBottom.setAttribute('aria-label', t('action.toBottom'))
  input.placeholder = t('composer.placeholder')
  drawSend()
  drawNew()
  modelButton.setAttribute('aria-label', t('model.select'))
  document.title = t('panel.title')
  blockedTitle.textContent = t('blocked.hostTitle')
  blockedBody.textContent = t('blocked.hostBody')
  blockedAction.textContent = t('blocked.retry')
}

/**
 * Show or hide the surface for a panel that has no conversation to show.
 *
 * Two states land here and they are the two ways the content area can be empty
 * through no fault of the reader:
 *
 * 1. No host: nothing to read, nothing to send, no error to report. The panel
 *    looked broken — a blank transcript and a dead send button. The one line
 *    that said so used to be an eleven-pixel grey footnote under the content,
 *    which is where a footnote belongs rather than an explanation of why nothing
 *    works.
 * 2. No sessions: measured at 380x720 the transcript was 559px of nothing at all
 *    (`childCount: 0`, no visible text), while the composer invited typing with
 *    「问点什么…」 and the send button sat disabled with nothing on screen
 *    explaining why. Typing a first message and pressing send could not work,
 *    and that is the most likely thing a new reader tries. The `＋` in the header
 *    was the whole answer, rendered as an unlabelled glyph.
 *
 * Both are the same shape the original uses for the same moment — a title, the
 * sentence that says what to do, and the button that does it — so they share the
 * surface rather than growing a second one that would drift from it.
 *
 * It clears itself on the next successful request, so it is a state and never a
 * warning to dismiss.
 *
 * @returns {void}
 */
function renderOffline() {
  // The host is the more fundamental failure: with no port answering there is
  // nothing to say about sessions, because the list on screen cannot be trusted
  // to be current.
  const hostDown = !hostReachable
  const noSessions = !hostDown && groups.length === 0
  const shown = hostDown || noSessions
  surface.hidden = !shown
  // Announced only when the surface appears, because this runs on every poll and
  // the host can stay away for minutes: a reader told "cannot reach dsh web" once
  // per three seconds would turn the announcement off along with the panel. The
  // `loadedOnce` guard covers the other end — the first paint happens before any
  // request has answered, so without it every ordinary start announces a problem
  // that is not there.
  if (shown && loadedOnce && announcedOffline !== (hostDown ? 'host' : 'empty')) {
    announcedOffline = hostDown ? 'host' : 'empty'
    announce(t(hostDown ? 'blocked.hostTitle' : 'blocked.emptyTitle'))
  } else if (!shown && announcedOffline !== '') {
    // The surface went away, so the sentence in the announcer is now stale.
    // Leaving it there is not merely untidy: anything that reads the region later
    // — including a screen reader asked to repeat itself — would be told the
    // panel still cannot work when it is working.
    announcedOffline = ''
    announce('')
  }
  if (!shown) return
  if (hostDown) {
    blockedTitle.textContent = t('blocked.hostTitle')
    blockedBody.textContent = t('blocked.hostBody')
    // The retry is the panel's whole startup, so it is the same work the first
    // load did rather than a second, thinner path that could drift from it.
    blockedAction.disabled = retrying
    blockedAction.textContent = retrying ? t('blocked.retrying') : t('blocked.retry')
    return
  }
  blockedTitle.textContent = t('blocked.emptyTitle')
  blockedBody.textContent = t('blocked.emptyBody')
  blockedAction.disabled = creating
  blockedAction.textContent = creating ? t('blocked.creating') : t('blocked.emptyAction')
}

/**
 * Record whether anything answered on the harness port.
 *
 * Every request the panel makes learns this, so it goes through one place: the
 * three callers each used to assign the flag and only one of them remembered to
 * repaint anything.
 *
 * @param {boolean} reachable - Whether a request got an answer.
 * @returns {void}
 */
function setHostReachable(reachable) {
  hostReachable = reachable
  // A request came back, so from here on an empty panel is a finding rather than
  // the state before the first answer. Set before the repaint, because
  // `renderOffline` is what reads it.
  loadedOnce = true
  renderOffline()
}

/** The session row on screen, when the listing knows it. */
function currentSession() {
  for (const group of groups) {
    const found = group.sessions.find((session) => session.id === currentSessionId)
    if (found !== undefined) return found
  }
  return undefined
}

/** The workspace group the session on screen belongs to. */
function currentGroup() {
  return groups.find((group) => group.sessions.some((session) => session.id === currentSessionId))
}

/** Repaint the header title from the current session. */
function renderTitle() {
  const session = currentSession()
  // An unreachable host is not an empty account. Saying 「还没有会话」 there is a
  // claim about the person's own data that this panel has no way to check —
  // their sessions are all still there, on a port nothing is answering.
  //
  // The header falls back to the product's own name rather than to the error
  // sentence: the blocked surface below already says it, and said twice in one
  // screen it reads as a stutter rather than as emphasis.
  // The header names the conversation on screen. With none selected there is no
  // name to show, and the two sentences that used to fill the gap both said
  // something the panel is not in a position to assert — 「还没有会话」 is a claim
  // about the reader's own data, and the blocked surface below now makes that
  // claim itself, properly, with the button that fixes it. Said in both places it
  // reads as a stutter rather than as emphasis.
  const label = !hostReachable || groups.length === 0
    ? t('panel.title')
    : currentSessionId.length === 0
      ? t('history.empty')
      : currentSessionBlank && session === undefined
        ? t('session.new')
        : session?.title || (session?.blank === true ? t('session.new') : t('session.untitled'))
  titleText.textContent = label
  titleButton.title = label
  titleButton.setAttribute('aria-expanded', String(view === 'history'))
  titleButton.hidden = view === 'history'
  backButton.hidden = view !== 'history'
}

/**
 * Read the deployment's model catalog.
 *
 * The deployment, not the session: which models are routable is a property of
 * the host's credentials, so it does not change between two refreshes of a
 * panel. A failure is retried on the next open, because the reason a catalog is
 * missing is usually a key someone has just added.
 *
 * @returns {Promise<void>} Resolves once the trigger has been repainted.
 */
async function refreshCatalog() {
  const { status, payload } = await bridge('/browser-bridge/chat', {
    method: 'POST',
    body: { action: 'models' },
  })
  if (status === 0) return
  catalog = payload?.catalog ?? null
  catalogReason = typeof payload?.reason === 'string' ? payload.reason : ''
  drawModel()
}

/**
 * The model the session on screen would use.
 *
 * It comes out of the listing, which carries each session's own selection — so
 * switching sessions switches the trigger with no request at all, and that is
 * what makes the choice belong to the session rather than to the panel.
 *
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | null} The selection, or null.
 */
function currentModel() {
  return currentSession()?.model ?? null
}

/**
 * Repaint the trigger from the current session's model.
 *
 * It carries no caption: the control names itself through `aria-label` and then
 * shows its value. That is also what the original does — its model dropdown
 * ships its "Model" category with `display:none`.
 *
 * @returns {void}
 */
function drawModel() {
  const label = modelLabel(catalog, currentModel())
  // With no host there is no catalog to read, so the picker's "no models" line
  // would state a second failure beside the blocked surface's first one — two
  // different-sounding errors for one cause, which reads as two broken things.
  const shown = !hostReachable ? t('model.select') : label.length > 0 ? label : t('model.unavailable')
  modelText.textContent = shown
  modelButton.title = shown
  modelButton.disabled = currentSessionId.length === 0 || !hostReachable
  modelButton.setAttribute('aria-label', label.length > 0 ? `${t('model.select')} · ${label}` : t('model.select'))
  modelButton.setAttribute('aria-expanded', String(menuOpen))
  if (menuOpen) drawModelMenu()
}

/**
 * Build the picker's contents.
 *
 * One popover with the effort levels on top and the models grouped beneath,
 * rather than the two-pane drill-down the harness's own selector uses. Someone
 * who opens this already knows what they want; making them walk through a second
 * page to reach it is a click this panel does not have to charge.
 *
 * @returns {void}
 */
function drawModelMenu() {
  const { error, efforts, groups: modelGroups } = modelMenuModel(catalog, currentModel())
  // What the menu would say, before any of it is built. The rows are a function
  // of the catalog and the selection, so two calls with the same inputs produce
  // the same list — and the second one has nothing to do.
  const signature = JSON.stringify({ error, efforts, groups: modelGroups, reason: error.length > 0 ? catalogReason : '' })
  if (signature === drawnMenuSignature) return
  drawnMenuSignature = signature

  // This runs while the reader may be standing in the menu: `drawModel` is
  // reached from every `renderChrome`, which the five-second `refreshGroups`
  // calls. Where focus was is recorded before the rebuild and put back after,
  // because the node holding it is about to stop existing — measured, focus went
  // to `body` on each poll, so walking the list with a keyboard lost the place.
  const active = document.activeElement
  const standing = active !== null && active !== undefined && containsNode(modelMenu, active)
  const control = standing
    ? String(active.className ?? '').split(' ').filter(Boolean)[0]
    : undefined
  const label = standing ? active.textContent.trim() : ''

  modelMenu.replaceChildren()

  if (error.length > 0) {
    // Nothing to choose from, so this is not a menu yet — it is one sentence
    // saying why. Leaving the role on would announce a list of choices with
    // nothing in it, immediately before the sentence explaining why.
    modelMenu.setAttribute('role', 'none')
    modelMenu.removeAttribute('aria-labelledby')
    const note = document.createElement('p')
    note.className = 'menu-note'
    // The code is the module's; the sentence and the host's reason are ours to show.
    note.textContent = catalogReason.length > 0
      ? `${t('model.unavailable')}：${catalogReason}`
      : t('model.unavailable')
    modelMenu.append(note)
    return
  }
  // Set here rather than in the markup so the role and the rows it owns are
  // written by the same code, and cannot describe different things. `role="menu"`
  // also requires an accessible name; `aria-labelledby` takes it from the button
  // that opens the picker, which is the name a reader already heard on the way in.
  modelMenu.setAttribute('role', 'menu')
  modelMenu.setAttribute('aria-labelledby', 'model')

  if (efforts.length > 0) {
    const caption = document.createElement('p')
    caption.className = 'menu-label'
    caption.textContent = t('model.effort')
    const row = document.createElement('div')
    row.className = 'menu-efforts'
    row.setAttribute('role', 'radiogroup')
    row.setAttribute('aria-label', t('model.effort'))
    for (const effort of efforts) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'menu-effort'
      button.setAttribute('role', 'radio')
      button.setAttribute('aria-checked', String(effort.checked))
      // The chosen level carries a glyph, not only a colour.
      //
      // The tinted pill was the whole difference between chosen and unchosen,
      // and it is made of `background` — which Windows High Contrast replaces,
      // leaving the two levels pixel-identical. Measured with the forced-colours
      // feature emulated: the only surviving difference was
      // `rgba(0,0,0,.15)` against `rgba(0,0,0,.11)`, two near-identical blacks,
      // so a person using that mode could not tell which effort was selected.
      //
      // The model rows below already solved this with a `✓`; this reuses it
      // rather than inventing a second convention. Marked `aria-hidden` because
      // the state is already carried by `aria-checked` on the radio, and a
      // screen reader announcing both would say it twice.
      const mark = document.createElement('span')
      mark.className = 'check'
      mark.textContent = effort.checked ? '✓' : ''
      mark.setAttribute('aria-hidden', 'true')
      button.append(mark)
      const label = document.createElement('span')
      label.className = 'name'
      label.textContent = effort.label || t('model.default')
      button.append(label)
      button.addEventListener('click', () => {
        chooseModel({ reasoningEffort: effort.id }).catch(() => {})
      })
      row.append(button)
    }
    modelMenu.append(caption, row)
  }

  for (const group of modelGroups) {
    const caption = document.createElement('p')
    caption.className = 'menu-label'
    caption.textContent = group.title
    modelMenu.append(caption)
    for (const option of group.options) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'menu-option'
      button.setAttribute('role', 'menuitemradio')
      button.setAttribute('aria-checked', String(option.checked))
      const name = document.createElement('span')
      name.className = 'name'
      name.textContent = option.label
      const check = document.createElement('span')
      check.className = 'check'
      check.textContent = option.checked ? '✓' : ''
      check.setAttribute('aria-hidden', 'true')
      button.append(name, check)
      button.addEventListener('click', () => {
        chooseModel({ provider: option.provider, model: option.model }).catch(() => {})
      })
      modelMenu.append(button)
    }
  }

  if (control === undefined) return
  // The same row, by the class it had and the text it read — the two things the
  // reader was looking at. When the row is gone the model or the level went with
  // it and there is nowhere honest to put focus, so it stays where the rebuild
  // left it rather than jumping to a row that is not the one being walked.
  const again = [...modelMenu.querySelectorAll(`.${control}`)].find(
    (node) => node.textContent.trim() === label,
  )
  if (again !== undefined) again.focus()
}

/**
 * Place the picker against the trigger, flipping when there is no room above.
 *
 * `position:fixed` because every container between here and the body scrolls or
 * clips, and a menu that is half cut off is worse than one that flips.
 *
 * @returns {void}
 */
function positionMenu() {
  const anchor = modelButton.getBoundingClientRect()
  const margin = 8
  // Measure after `hidden` was cleared, so this is the size it will be drawn at.
  const width = modelMenu.offsetWidth
  const height = modelMenu.offsetHeight
  modelMenu.style.left = `${Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin))}px`
  if (anchor.top - margin >= height + 6) {
    modelMenu.style.top = 'auto'
    modelMenu.style.bottom = `${window.innerHeight - anchor.top + 6}px`
  } else {
    modelMenu.style.bottom = 'auto'
    modelMenu.style.top = `${anchor.bottom + 6}px`
  }
}

/**
 * Open or close the picker.
 *
 * Opening moves focus to the first item, which is what a menu does and what
 * `role="menu"` describes. Leaving it on the trigger looks equivalent — Tab does
 * reach the rows from there — but the arrow keys would not: they are handled on
 * the menu, and an event fired on the button never reaches it. Measured before
 * this, ArrowDown on a freshly opened picker left focus on the trigger.
 *
 * @param {boolean} [next] - The state to force; omitted toggles it.
 * @returns {void}
 */
function setMenu(next) {
  const open = next ?? !menuOpen
  if (open === menuOpen) return
  menuOpen = open
  modelButton.setAttribute('aria-expanded', String(open))
  // Closing from inside the menu would otherwise leave focus on a row that is
  // about to be taken away, so it lands back on the button the reader opened it
  // from — where they were before, and where the next Tab continues from.
  const standing = document.activeElement
  if (!open && standing !== null && standing !== undefined && containsNode(modelMenu, standing)) {
    modelButton.focus()
  }
  modelMenu.hidden = !open
  if (!open) return
  if (catalog === null) refreshCatalog().catch(() => {})
  drawModelMenu()
  positionMenu()
  // Focus goes to the first item, however the menu was opened — the menu
  // keyboard pattern puts it there, and doing it only for a keyboard opening
  // would make the arrow keys work for one input method and not the other.
  // `:focus-visible` still keeps the ring off a mouse click, because the browser
  // decides that from the interaction that led here, not from this call.
  modelMenu.querySelector('button')?.focus()
}

/**
 * Draw the `@` picker for whatever is being typed at the caret.
 *
 * Called on every keystroke. It reads the composer rather than tracking state,
 * so the menu cannot disagree with the text: what is offered is always what the
 * caret is inside.
 *
 * @returns {void}
 */
function drawMention() {
  const caret = typeof input.selectionStart === 'number' ? input.selectionStart : input.value.length
  const found = mentionAt(input.value.slice(0, caret))
  if (found === null) {
    closeMention()
    return
  }

  const menu = mentionMenu(tabs, found.query)
  if (menu.state !== 'listed') {
    // Kept open with a reason rather than vanishing: an `@` that makes the
    // picker disappear reads as a broken key, and the two nothings mean
    // different things.
    mention = { start: found.start, index: 0, options: [] }
    drawMentionRows([], menu.state)
    positionMention()
    return
  }

  const options = mentionRows(menu.options)
  // The highlight is kept across keystrokes when the row still exists, so the
  // arrow keys and then more typing do not fight each other.
  const previous = mention?.options[mention.index]
  const keep = previous === undefined
    ? 0
    : Math.max(0, options.findIndex((option) => option.id === previous.id))
  mention = { start: found.start, index: keep, options }
  drawMentionRows(options, 'listed')
  positionMention()
}

/** Take the picker away, and forget what it was offering. */
function closeMention() {
  if (mention === null && atMenu.hidden) return
  mention = null
  atMenu.hidden = true
  atMenu.replaceChildren()
}

/**
 * Paint the picker's rows.
 *
 * @param {object[]} options - Rows from `mentionRows`.
 * @param {'listed'|'empty'|'none'} state - What there is to say.
 * @returns {void}
 */
function drawMentionRows(options, state) {
  atMenu.replaceChildren()
  if (state !== 'listed') {
    // No rows to own, so the listbox role goes: a `listbox` with a paragraph
    // inside it is a list of options that are not there.
    atMenu.setAttribute('role', 'none')
    const note = document.createElement('p')
    note.className = 'at-empty'
    note.textContent = state === 'empty' ? t('at.empty') : t('at.none')
    atMenu.append(note)
    atMenu.hidden = false
    return
  }
  // The rows below carry `role="option"`, which WAI-ARIA lets exist only inside
  // a `listbox`. Written here so the role and the rows it owns come from one
  // place; measured before this, the options owned nothing at all.
  atMenu.setAttribute('role', 'listbox')
  atMenu.setAttribute('aria-label', t('at.list'))

  const label = document.createElement('p')
  label.className = 'at-label'
  label.textContent = t('at.list')
  atMenu.append(label)

  options.forEach((option, at) => {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'at-option'
    row.setAttribute('role', 'option')
    row.setAttribute('aria-selected', String(at === mention?.index))
    if (option.icon.length > 0) {
      const icon = document.createElement('img')
      icon.className = 'site'
      icon.src = option.icon
      icon.alt = ''
      icon.addEventListener('error', () => icon.remove())
      row.append(icon)
    }
    const text = document.createElement('span')
    text.className = 'text'
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = option.title
    text.append(name)
    if (option.showUrl) {
      const where = document.createElement('span')
      where.className = 'where'
      where.textContent = option.where
      text.append(where)
    }
    row.append(text)
    // `mousedown` rather than `click`: the click would blur the textarea first,
    // and a menu that closes on blur cannot be clicked at all.
    row.addEventListener('mousedown', (event) => {
      event.preventDefault()
      acceptMention(at)
    })
    row.addEventListener('mouseenter', () => {
      if (mention === null) return
      mention.index = at
      for (const [index, node] of [...atMenu.querySelectorAll('button')].entries()) {
        node.setAttribute('aria-selected', String(index === at))
      }
    })
    atMenu.append(row)
  })
  atMenu.hidden = false
}

/** Put the picker above the composer, where the caret is. */
function positionMention() {
  const anchor = input.getBoundingClientRect()
  const margin = 8
  const height = atMenu.offsetHeight
  atMenu.style.left = `${margin}px`
  atMenu.style.width = `${Math.max(200, anchor.width)}px`
  if (anchor.top - margin >= height + 6) {
    atMenu.style.top = 'auto'
    atMenu.style.bottom = `${window.innerHeight - anchor.top + 6}px`
  } else {
    atMenu.style.bottom = 'auto'
    atMenu.style.top = `${anchor.bottom + 6}px`
  }
}

/**
 * Take one candidate, replacing the `@word` that opened the picker.
 *
 * A mention is a reference, so accepting one puts the tab where the current-tab
 * chip already lives — the message carries it as an attachment. The `@word`
 * itself is removed: leaving `@net` in the prompt would send the model a word
 * that means nothing to it, and the attachment already names the page.
 *
 * @param {number} at - Which candidate.
 * @returns {void}
 */
function acceptMention(at) {
  const open = mention
  const option = open?.options[at]
  if (open === undefined || option === undefined) return
  const caret = typeof input.selectionStart === 'number' ? input.selectionStart : input.value.length
  const before = input.value.slice(0, open.start)
  const after = input.value.slice(caret)
  input.value = `${before}${after}`
  const target = before.length
  input.setSelectionRange?.(target, target)
  // One mention is one page: a second replaces the first rather than stacking,
  // because two tabs in one message is something the chip row cannot show.
  mentioned = option
  closeMention()
  input.style.height = 'auto'
  input.style.height = `${Math.min(140, input.scrollHeight)}px`
  setDraft(currentSessionId, input.value)
  renderContexts()
  input.focus()
}

/**
 * Install one selection for the session on screen.
 *
 * A patch is merged into what the session already has, so picking an effort
 * keeps the model and picking a model keeps whatever level that model prefers.
 *
 * The effort only travels when the model is unchanged: a level belongs to a
 * model, and carrying the old one across to a new model is a request the host
 * would have to reject.
 *
 * @param {{ provider?: string, model?: string, reasoningEffort?: string }} patch - The change.
 * @returns {Promise<void>} Resolves once the host has answered.
 */
async function chooseModel(patch) {
  const before = currentModel()
  const provider = patch.provider ?? before?.provider ?? ''
  const model = patch.model ?? before?.model ?? ''
  if (provider.length === 0 || model.length === 0) {
    say(t('model.failed', { reason: t('model.unavailable') }))
    return
  }
  const keepingModel = patch.model === undefined || patch.model === before?.model
  const effort = patch.reasoningEffort ?? (keepingModel ? before?.reasoningEffort : undefined)
  const { status, payload } = await bridge('/browser-bridge/chat', {
    method: 'POST',
    body: {
      action: 'select-model',
      sessionId: currentSessionId,
      provider,
      model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    },
  })
  if (status === 0) {
    say(t('model.failed', { reason: t('error.unreachable') }))
    return
  }
  const selected = payload?.selected
  if (selected === false || selected === undefined || selected === null) {
    say(t('model.failed', { reason: typeof payload?.reason === 'string' ? payload.reason : '' }))
    return
  }
  // The listing is this panel's copy of the host's state, so keeping it in step
  // here is what lets the trigger repaint without a full refresh. No toast: the
  // trigger changing is the confirmation, and a panel that says "done" every
  // time is the panel this one replaced.
  const session = currentSession()
  if (session !== undefined) session.model = selected
  setMenu(false)
  drawModel()
}

/**
 * The tab's icon, when it is one the panel can actually load.
 *
 * `favIconUrl` is absent for a page that never declared one, and Chrome reports
 * an internal `chrome://` or `chrome-extension://` URL on its own pages — which
 * a side panel cannot fetch, and which would render as a broken-image box. Both
 * cases degrade to no icon, and the chip then shows the title alone.
 *
 * `data:` is allowed because a page may declare an inline icon, and refusing it
 * would be refusing a perfectly loadable image. The list is an allow-list rather
 * than a deny-list of `chrome:` so a scheme nobody thought of degrades to "no
 * icon" instead of to a broken image.
 *
 * @param {{ favIconUrl?: string }} tab - A tab from `chrome.tabs.query`.
 * @returns {string} A loadable icon URL, or an empty string.
 */
function faviconOf(tab) {
  const url = typeof tab?.favIconUrl === 'string' ? tab.favIconUrl : ''
  return /^(https?|data):/.test(url) ? url : ''
}

/**
 * Repaint the chips that say what will travel with the next send.
 *
 * The tab's identity is a standing fact while the panel is open, so it is shown
 * as a chip rather than a control; the selection is shown only while it would be
 * sent, and can be dropped for this send. What the row shows is what leaves —
 * including when the extension is not attached to the harness, in which case the
 * chip says so rather than quietly promising an attachment that cannot be made.
 *
 * @returns {void}
 */
function renderContexts() {
  contexts.replaceChildren()
  // Nothing can be attached while nothing is reachable, so the row would only
  // repeat the blocked surface's error in a second voice — 「未连接」 beside
  // 「连不上 dsh web」 is one cause told twice, which reads as two faults.
  if (!hostReachable) {
    contexts.hidden = true
    return
  }

  // The host answers but this extension is not attached to it. That is a
  // different state from the one above and it used to get the same six words:
  // 「未连接」 in a pill that was not a button, while the transcript rendered
  // normally and the composer worked. Nothing on screen named the token or the
  // settings page, and the only route there was to open the history view and
  // scroll to its footer — so a fresh install with no token could not be fixed
  // from the panel that was asking to be fixed.
  //
  // It is a control now, because there is exactly one thing to do about it. The
  // wording says what still works rather than what is broken: the conversation
  // is intact and the browser tools are the part that is missing (the chat
  // routes need no token; only the websocket does).
  if (!bridgeConnected) {
    const chip = document.createElement('span')
    chip.className = 'chip'
    chip.dataset.warn = 'true'
    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = t('context.offline')
    const open = document.createElement('button')
    open.type = 'button'
    open.textContent = t('context.offlineAction')
    open.title = t('context.offlineAction')
    open.addEventListener('click', () => {
      chrome.runtime.openOptionsPage()
    })
    chip.title = t('context.offline')
    chip.setAttribute('aria-label', `${t('context.offline')} — ${t('context.offlineAction')}`)
    chip.append(label, open)
    contexts.hidden = false
    contexts.append(chip)
    return
  }

  const chips = []

  if (mentionAddsSomething()) {
    // Styled like a decision, because it is one: this page is attached because
    // someone asked for it, not because it happened to be in front.
    const chip = document.createElement('span')
    chip.className = 'chip'
    chip.dataset.attached = 'true'
    if (mentioned.icon.length > 0) {
      const icon = document.createElement('img')
      icon.className = 'site'
      icon.src = mentioned.icon
      icon.alt = ''
      icon.addEventListener('error', () => icon.remove())
      chip.append(icon)
    }
    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = mentioned.title
    chip.title = `${t('at.list')} · ${mentioned.title}`
    chip.setAttribute('aria-label', chip.title)
    const drop = document.createElement('button')
    drop.type = 'button'
    drop.textContent = '×'
    drop.title = t('action.drop')
    drop.setAttribute('aria-label', t('action.drop'))
    drop.addEventListener('click', () => {
      mentioned = null
      renderContexts()
    })
    chip.append(label, drop)
    chips.push(chip)
  }

  if (currentTab.url.length > 0) {
    const chip = document.createElement('span')
    chip.className = 'chip'
    const title = currentTab.title || currentTab.url
    // The icon carries "this is the current tab", which is what the words
    // 「当前标签页 · 」 used to say. Measured at 392px: the label gets 360px and
    // this title wants 400px, so the prefix was costing exactly the width the
    // title needed — the chip rendered `当前标签页 · Network Edge Inference for
    // Large Language Mo…`, spending its space on a label and then truncating the
    // thing the reader came for. The official panel does the same: its compact
    // source renders an icon and hides the words.
    if (currentTab.icon.length > 0) {
      const icon = document.createElement('img')
      icon.className = 'site'
      icon.src = currentTab.icon
      icon.alt = ''
      // A favicon that 404s must not leave a broken-image box in the row.
      icon.addEventListener('error', () => icon.remove())
      chip.append(icon)
    }
    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = title
    // The chip is a fact, not a control, so its full name is carried here rather
    // than spelled out on screen.
    chip.title = `${t('context.tab')} · ${title}`
    chip.setAttribute('aria-label', chip.title)
    chip.append(label)
    chips.push(chip)
  }

  if (selectionAttached && currentSelection.text.length > 0) {
    const chip = document.createElement('span')
    chip.className = 'chip'
    // Styled as an active decision rather than another fact: this is the one
    // line in the panel that answers "will my highlight be sent?".
    chip.dataset.attached = 'true'
    const mark = document.createElement('span')
    mark.className = 'mark'
    mark.textContent = '“'
    mark.setAttribute('aria-hidden', 'true')
    const label = document.createElement('span')
    label.className = 'label'
    // The text itself is the label. `选中内容 ·` used to lead here, and it cost
    // the same 60px it cost the tab chip — while the quote mark beside it and
    // the accent fill already say what this is. Measured on a 56-glyph Chinese
    // selection, that prefix was a fifth of what the row could show.
    //
    // No character-count clamp: the width is what decides, and CSS already does
    // that with `max-width` plus `text-overflow`. A clamp at 39 characters is
    // 39 CJK glyphs, roughly twice the width of 39 Latin ones, so it never fit
    // the chip it was written for and only made the truncation happen twice.
    label.textContent = currentSelection.text
    // The whole selection is still reachable: the chip names itself for a
    // screen reader, and hovering shows the beginning of what will be sent.
    chip.title = `${t('context.selection')} · ${currentSelection.text}`
    chip.setAttribute('aria-label', chip.title)
    const drop = document.createElement('button')
    drop.type = 'button'
    drop.textContent = '×'
    drop.title = t('action.drop')
    drop.setAttribute('aria-label', t('action.drop'))
    drop.addEventListener('click', () => {
      selectionAttached = false
      renderContexts()
    })
    chip.append(mark, label, drop)
    chips.push(chip)
  }

  contexts.hidden = chips.length === 0
  if (chips.length > 0) contexts.append(...chips)
}

/**
 * A stable name for one transcript row, for remembering what the reader opened.
 *
 * The open sets used to be keyed by **array position**, and a position is not an
 * identity in this panel: the transcript is a window counted back from the newest
 * row (`refreshTranscript` sends `limit: depth`), so loading earlier content
 * widens the window and puts the older rows at the *front*. Every row already on
 * screen moves down by a page, and a set of positions then describes different
 * rows than the ones the reader touched. Reproduced in `panel-stream.test.js`:
 * opening a failed row and then asking for earlier content left the row open four
 * rows above where the reader had put it.
 *
 * A tool row is named by its `callId`, which the host already sends and which is
 * unique per call. The other kinds have no id from the host, so what the reader
 * can see stands in: two rows with the same kind and the same visible text are
 * indistinguishable to the reader as well, so treating them as one row costs
 * nothing that was ever observable. The kind is part of the name because a
 * reasoning row and the answer quoting it can hold the same text, and opening one
 * must not open the other.
 *
 * A tool row with no `callId` falls back to the same visible text, which for a
 * tool row is its name and arguments. Falling back to the empty string instead
 * would name every such row alike, and opening one would open all of them — the
 * exact failure this function exists to prevent.
 *
 * @param {object} row - A row from the host's `messages` action.
 * @returns {string} The row's name.
 */
function rowKey(row) {
  if (row.kind === 'tool') {
    if (typeof row.callId === 'string' && row.callId.length > 0) return `tool\u0000${row.callId}`
    return `tool\u0000${row.name ?? ''}\u0000${row.summary ?? ''}`
  }
  return `${row.kind}\u0000${typeof row.text === 'string' ? row.text : ''}`
}

/**
 * Render one transcript row.
 *
 * @param {object} row - A row from the host's `messages` action.
 * @returns {HTMLElement} The node.
 */
function renderRow(row) {
  const key = rowKey(row)
  if (row.kind === 'user') {
    const wrapper = document.createElement('div')
    wrapper.className = 'row'
    wrapper.dataset.kind = 'user'
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    bubble.textContent = row.text
    wrapper.append(bubble)
    return wrapper
  }

  if (row.kind === 'assistant') {
    const wrapper = document.createElement('div')
    wrapper.className = 'row'
    wrapper.dataset.kind = 'assistant'
    const answer = document.createElement('div')
    answer.className = 'answer'
    answer.append(renderMarkdown(document, row.text, { copy: t('action.copy') }))
    wrapper.append(answer)
    // Copying the whole answer lives here rather than in the header: it acts on
    // one row, and the row is where the reader is looking. It stays invisible
    // until the row is hovered or something inside it takes focus, so a panel
    // full of answers is not a panel full of buttons.
    const actions = document.createElement('div')
    actions.className = 'answer-actions'
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'copy'
    copy.dataset.copy = 'answer'
    copy.textContent = t('action.copy')
    actions.append(copy)
    wrapper.append(actions)
    return wrapper
  }

  if (row.kind === 'reasoning') {
    const wrapper = document.createElement('div')
    wrapper.className = 'reasoning'
    const open = expandedReasoning.has(key)
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'reasoning-toggle'
    toggle.textContent = `${t('row.reasoning')} ${open ? '⌃' : '⌄'}`
    toggle.setAttribute('aria-expanded', String(open))
    wrapper.append(toggle)
    if (open) {
      const body = document.createElement('div')
      body.className = 'reasoning-body'
      body.textContent = row.text
      wrapper.append(body)
    }
    toggle.addEventListener('click', () => {
      if (expandedReasoning.has(key)) expandedReasoning.delete(key)
      else expandedReasoning.add(key)
      drawTranscript(rows)
    })
    return wrapper
  }

  if (row.kind === 'tool') {
    const wrapper = document.createElement('div')
    wrapper.className = 'row'
    wrapper.dataset.kind = 'tool'

    // A failure carries the reason the tool gave, and the row has to be able to
    // show it. Without this a broken call read as a bare cross next to its
    // arguments: the model could see why it failed and correct itself, while the
    // person watching could not tell a missed selector from a blocked tab from a
    // page that never answered — and so could not tell whether to intervene.
    const reason = typeof row.failure === 'string' ? row.failure : ''
    const open = reason !== '' && expandedFailures.has(key)

    // A real `<button>` when there is something to reveal, and a plain `div`
    // otherwise. The first version made the div clickable, which is a control
    // only a mouse can reach: no tab stop, no focus ring, no Enter. The panel
    // already solves this for the reasoning row with a button, so this follows
    // that rather than inventing a second way.
    const line = document.createElement(reason === '' ? 'div' : 'button')
    if (reason !== '') line.type = 'button'
    line.className = 'tool'
    line.dataset.status = row.status ?? 'pending'
    const mark = document.createElement('span')
    mark.className = 'mark'
    mark.textContent = row.status === 'ok' ? '✓' : row.status === 'error' ? '✕' : '·'
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = row.name
    const args = document.createElement('span')
    args.className = 'args'
    args.textContent = row.summary ?? ''
    const calls = document.createElement('span')
    calls.className = 'calls'
    if (Number.isInteger(row.count) && row.count > 1) calls.textContent = `×${row.count}`
    line.append(mark, name, args, calls)

    if (reason !== '') {
      line.classList.add('has-reason')
      line.setAttribute('aria-expanded', String(open))
      line.addEventListener('click', () => {
        if (expandedFailures.has(key)) expandedFailures.delete(key)
        else expandedFailures.add(key)
        drawTranscript(rows)
      })
    }

    wrapper.append(line)
    if (open) {
      const detail = document.createElement('div')
      detail.className = 'tool-failure'
      detail.textContent = reason
      wrapper.append(detail)
    }
    return wrapper
  }

  if (row.kind === 'failed') {
    // A durable record that a turn died. It is what the live toast leaves
    // behind: without it, reloading the panel turned a failed turn back into a
    // conversation that simply stopped after the user's message.
    //
    // The sentence is chosen by the harness's failure code, not by the
    // provider's message. That message is a log line — environment variables,
    // config paths, a paragraph of remediation — and it was being painted here
    // in red at 12px, which read as a stack trace rather than an explanation.
    const wrapper = document.createElement('div')
    wrapper.className = 'row'
    wrapper.dataset.kind = 'failed'
    const line = document.createElement('div')
    line.className = 'failure'
    line.textContent = failureSentence(row.code, t)
    wrapper.append(line)
    // The provider's own words stay reachable, but demoted: they are the detail
    // behind the sentence, and they are what someone pastes into a search when
    // the sentence is not specific enough.
    const detail = failureDetail(row.text)
    if (detail !== '' && row.code !== undefined) {
      const more = document.createElement('div')
      more.className = 'failure-detail'
      more.textContent = detail
      wrapper.append(more)
    }
    return wrapper
  }

  const wrapper = document.createElement('div')
  wrapper.className = 'row'
  wrapper.dataset.kind = 'context'
  const notice = document.createElement('div')
  notice.className = 'notice'
  notice.textContent = `${t('row.context')} · ${row.text}`
  wrapper.append(notice)
  return wrapper
}

/** The rows currently on screen. */
let rows = []

/** Whether the transcript is pinned to the newest row right now. */
function atBottom() {
  return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <= NEAR_BOTTOM_PX
}

/** Show or hide the way back down. */
function updateToBottom() {
  // A search jump parks the window inside the conversation. The scrollbar can sit
  // at the bottom of that window while the conversation continues far below, so
  // "is the scrollbar at the bottom" is the wrong question here — measured, a
  // reader who searched and then scrolled down had the only control that leaves
  // the window hide itself, and the newest rows were unreachable.
  const parked = anchorEnd !== null && anchorEnd < windowTotal
  toBottom.hidden = view !== 'chat'
    || (stickToBottom && !parked)
    || (!parked && transcript.scrollHeight <= transcript.clientHeight)
}

/**
 * Draw the transcript, touching the DOM only when the rows actually changed.
 *
 * The scroll rule is the important part, and it is the original's:
 *
 *   - After a redraw, if the view was already within `NEAR_BOTTOM_PX` of the
 *     bottom — or a send just happened — follow the newest row.
 *   - Otherwise put the scroll position back exactly where it was. A poll that
 *     fires while somebody is reading must not move their view, and the previous
 *     panel scrolled to the bottom on every one of its ticks.
 *
 * @param {object[]} next - The rows to draw.
 * @returns {void}
 */
function drawTranscript(next) {
  rows = next
  const signature = JSON.stringify(next) + JSON.stringify([...expandedReasoning]) + JSON.stringify([...expandedFailures])
  // A settled stream gives way to the real rows the moment they actually
  // change. Doing it here rather than on the `end` frame is what keeps the
  // text on screen if the re-read raced the append.
  if (live !== null && live.done && signature !== drawnSignature) live = null
  if (signature === drawnSignature) {
    renderWorking()
    renderLive()
    renderApproval()
    updateToBottom()
    return
  }
  drawnSignature = signature

  const keep = transcript.scrollTop
  const followed = stickToBottom
  // Loading earlier rows grows the list above the reader. Without measuring what
  // was added, `scrollTop` would keep pointing at the same offset from the top of
  // a now-taller list, which scrolls the text they were reading off the bottom of
  // the screen — the same jump the poll used to cause, arriving by a new route.
  const before = transcript.scrollHeight
  reconcileRows(next)
  renderWorking()
  renderLive()
  // After `renderWorking`, because both append to the transcript and the
  // question belongs below the row that says the turn is still running.
  renderApproval()

  if (followed) transcript.scrollTop = transcript.scrollHeight
  else if (grewEarlier) transcript.scrollTop = keep + (transcript.scrollHeight - before)
  else transcript.scrollTop = keep
  grewEarlier = false
  stickToBottom = atBottom()
  updateToBottom()
}

/**
 * Whether a row draws itself open, which is a fact about the open sets rather
 * than about the row.
 *
 * The row's own fields do not carry it: clicking a reasoning row open changes
 * nothing about the row, only about the set that says it is open.
 *
 * @param {object} row - A row from the host's `messages` action.
 * @param {string} key - The row's name, from `rowKey`.
 * @returns {boolean} True when the row should draw its detail.
 */
function rowIsOpen(row, key) {
  // Mirrors the two `open` computations in `renderRow`: a reasoning row opens on
  // its name alone, and a tool row only when there is a reason to reveal.
  if (row.kind === 'reasoning') return expandedReasoning.has(key)
  if (row.kind === 'tool') {
    return (
      typeof row.failure === 'string' && row.failure !== '' && expandedFailures.has(key)
    )
  }
  return false
}

/**
 * Show or hide a row's detail on the node already on screen.
 *
 * Opening a row is a click on a control inside that row, so the node holding
 * focus is the node this has to keep. Rebuilding the row instead moved focus off
 * it: measured in a real browser, clicking a reasoning row put focus on `<body>`,
 * and getting back to that button meant walking past every focusable thing above
 * it — thirty-three tab stops on a 470-row transcript.
 *
 * @param {object} node - The row's node, from `renderRow`.
 * @param {object} row - The row it was drawn from.
 * @param {boolean} open - Whether the detail belongs on screen.
 * @returns {void}
 */
function applyRowOpen(node, row, open) {
  if (row.kind === 'reasoning') {
    const toggle = node.querySelector('.reasoning-toggle')
    if (toggle === null) return
    toggle.textContent = `${t('row.reasoning')} ${open ? '⌃' : '⌄'}`
    toggle.setAttribute('aria-expanded', String(open))
    const body = node.querySelector('.reasoning-body')
    if (open && body === null) {
      const detail = document.createElement('div')
      detail.className = 'reasoning-body'
      detail.textContent = row.text
      node.append(detail)
    } else if (!open) {
      body?.remove()
    }
    return
  }
  if (row.kind === 'tool') {
    const line = node.querySelector('.tool')
    if (line === null) return
    // A row with no reason never had a control, so there is nothing to update.
    if (typeof row.failure !== 'string' || row.failure === '') return
    line.setAttribute('aria-expanded', String(open))
    const detail = node.querySelector('.tool-failure')
    if (open && detail === null) {
      const reason = document.createElement('div')
      reason.className = 'tool-failure'
      reason.textContent = row.failure
      node.append(reason)
    } else if (!open) {
      detail?.remove()
    }
  }
}

/**
 * Whether `node` sits inside `outer`, walking up rather than down.
 *
 * `Node.contains` exists in a browser but not in the test document, and the walk
 * is three lines, so the walk is what both get.
 *
 * @param {object} outer - The presumed ancestor.
 * @param {object} node - The node to look for.
 * @returns {boolean} True when `node` is `outer` or below it.
 */
function containsNode(outer, node) {
  let walk = node
  while (walk !== null && walk !== undefined) {
    if (walk === outer) return true
    walk = walk.parentNode
  }
  return false
}

/**
 * Bring the transcript's row nodes in line with `next`, reusing the ones already
 * on screen.
 *
 * This replaced a `replaceChildren` of every row. Rebuilding was not merely
 * expensive — 18ms against a 16.7ms frame on a 470-row transcript, almost all of
 * it layout — it destroyed the reader's place in the page. Both of the most
 * ordinary interactions rebuild: clicking a row open changes what that row
 * draws, and a poll that returns different rows redraws the lot. Measured in a
 * real browser, opening a reasoning row put focus on `<body>`, thirty-three tab
 * stops above the button that had just been pressed, and a redraw with text
 * selected left the selection empty. Neither shows up in a screenshot; both are
 * the panel discarding what the person was doing.
 *
 * A row keeps its node while its name and its data are unchanged, and an open
 * set that changed only patches that node — so the control the reader just
 * pressed is still the control holding focus afterwards. A row whose text is
 * still arriving builds a new node, because it has to.
 *
 * @param {object[]} next - The rows to draw, oldest first.
 * @returns {void}
 */
function reconcileRows(next) {
  // Focus is about to be at the mercy of node replacement. Where it was is
  // recorded by row and by control, because the node holding it may not survive;
  // a row that keeps its node needs none of this.
  const active = document.activeElement
  let carried = null
  if (active !== null && active !== undefined && containsNode(transcript, active)) {
    const owner = drawnRows.find((entry) => containsNode(entry.node, active))
    const control = String(active.className ?? '')
      .split(' ')
      .filter(Boolean)[0]
    if (owner !== undefined && control !== undefined) carried = { key: owner.key, control }
  }

  const previous = drawnRows
  drawnRows = next.map((row) => {
    const key = rowKey(row)
    return { row, key, data: JSON.stringify(row), open: rowIsOpen(row, key) }
  })

  // Claim a node per row, in order. A name can repeat — two rows the reader
  // cannot tell apart — so matches are handed out one at a time rather than
  // through a one-to-one map that would drop the second.
  const spare = new Map()
  for (const entry of previous) {
    if (!spare.has(entry.key)) spare.set(entry.key, [])
    spare.get(entry.key).push(entry)
  }
  const kept = new Set()
  for (const entry of drawnRows) {
    const candidates = spare.get(entry.key)
    const match = candidates?.find((candidate) => candidate.data === entry.data)
    if (match === undefined) continue
    candidates.splice(candidates.indexOf(match), 1)
    entry.node = match.node
    kept.add(entry.node)
    // Only the open sets moved, so only the open sets are redrawn. This is the
    // path a click takes, and it is why the control that was pressed is still the
    // control that holds focus afterwards.
    if (match.open !== entry.open) applyRowOpen(entry.node, entry.row, entry.open)
  }
  for (const entry of drawnRows) {
    if (entry.node === undefined) entry.node = renderRow(entry.row)
  }

  // Whatever the new window no longer holds goes, and it goes before anything is
  // placed: the rows that stay keep their relative order, so taking the discarded
  // ones out first leaves the placement below with nothing to move except the
  // rows that are genuinely new. Only nodes this function owns are touched — the
  // transient rows belong to their own renderers, which run next.
  for (const entry of previous) {
    if (!kept.has(entry.node)) entry.node.remove()
  }

  // Row nodes are always a prefix of the transcript's children, because
  // `.working`, `.live` and `.approval` append behind them, so walking the two in
  // step puts each row where it belongs and never moves a transient node.
  let at = 0
  for (const entry of drawnRows) {
    const children = transcript.children
    if (children[at] !== entry.node) transcript.insertBefore(entry.node, children[at] ?? null)
    at += 1
  }

  // The row that held focus was rebuilt rather than patched, so focus is on
  // `<body>` now. Put it back on the control the reader was actually on, found by
  // the name it goes by rather than by identity, since identity is what was lost.
  if (carried !== null && !containsNode(transcript, active)) {
    drawnRows
      .find((entry) => entry.key === carried.key)
      ?.node.querySelector(`.${carried.control}`)
      ?.focus()
  }
}

/**
 * Search the whole conversation, or clear the results.
 *
 * The query goes to the host because the rows are not here: this panel holds a
 * window (60 rows by default) of a conversation that may have thousands, so
 * answering from what is on screen would report a word as absent from the
 * reader's own conversation — the most misleading thing a search box can do.
 *
 * @returns {Promise<void>} Resolves once the results have been drawn.
 */
async function runSearch() {
  const query = searchQuery.trim()
  // A blank query clears the results rather than searching for nothing: an empty
  // needle matches every row, and a count of "600 of 600" is not an answer to
  // anything.
  if (query.length === 0 || currentSessionId.length === 0) {
    searchHits = []
    searchTotal = 0
    searchTruncated = false
    searchPosition = 0
    searching = false
    renderFind()
    return
  }
  searching = true
  // The previous query's matches are dropped before the request goes out, not
  // when the answer lands. Left in place they are the count shown for a query
  // that has not been answered yet, so "zebra 1/1" stands while the reader is
  // typing "aardvark" — and if the new query matches nothing, the old count is
  // the one that stays.
  searchHits = []
  searchTotal = 0
  searchTruncated = false
  searchPosition = 0
  renderFind()
  try {
    const { payload } = await bridge('/browser-bridge/chat', {
      method: 'POST',
      body: { action: 'search', sessionId: currentSessionId, query },
    })
    // A reply that arrives after the reader has typed on is about a query they
    // have already left; adopting it would flash stale results under the caret.
    if (searchQuery.trim() !== query) return
    searchHits = Array.isArray(payload?.matches) ? payload.matches : []
    searchTotal = typeof payload?.total === 'number' ? payload.total : 0
    searchTruncated = payload?.truncated === true
  } finally {
    searching = false
    renderFind()
  }
}

/**
 * Show one match, by moving the window to it.
 *
 * The window is named by an absolute row index rather than by a count from the
 * end, so the model appending a reply while the reader is reading a match from
 * ten turns ago does not carry them off it.
 *
 * @param {number} position - Index into `searchHits`, newest match first.
 * @returns {Promise<void>} Resolves once the match is on screen.
 */
async function goToMatch(position) {
  const hit = searchHits[position]
  if (hit === undefined) return
  const index = typeof hit.index === 'number' ? hit.index : 0
  // The window ends a little *past* the match rather than on it. Ending on the
  // match puts it in the last row of the screen, pressed against the composer
  // with nothing after it — photographed, and it reads as the end of the
  // conversation rather than as a place inside it. These rows below are what let
  // the browser centre the match when it scrolls to it.
  anchorEnd = index + 1 + MATCH_CONTEXT_ROWS
  depth = Math.max(PAGE_ROWS, depth)
  // Not `stickToBottom`: the reader asked for this row, not for the newest one.
  stickToBottom = false
  grewEarlier = false
  await refreshTranscript()
  drawFindFocus(index)
}

/**
 * Put the reader's eye on the matched row, without moving their keyboard focus.
 *
 * Focus stays in the search field: the reader is stepping through matches with
 * Enter, and moving focus onto the row would make the next Enter do nothing.
 *
 * @param {number} index - The row's absolute index.
 * @returns {void}
 */
function drawFindFocus(index) {
  for (const entry of drawnRows) entry.node.classList.remove('hit')
  // The rows on screen are a window ending at `anchorEnd`, so the match is
  // found by the name the window itself is built from rather than by counting.
  const key = findHitKey(index)
  if (key === null) return
  const entry = drawnRows.find((candidate) => candidate.key === key)
  if (entry === undefined) return
  entry.node.classList.add('hit')
  entry.node.scrollIntoView({ block: 'center' })
}

/**
 * The row key of an absolute row index, or null when it is off screen.
 *
 * @param {number} index - The absolute row index.
 * @returns {string | null} The key, or null.
 */
function findHitKey(index) {
  // `rows` is the drawn window and `anchorEnd` is where it ends, so the offset
  // into the window is arithmetic on the two — no second index to keep in sync.
  const end = anchorEnd ?? rows.length
  const offset = index - (end - rows.length)
  const row = rows[offset]
  if (row === undefined) return null
  return rowKey(row)
}

/** Draw the find bar. */
function renderFind() {
  findBar.hidden = !findOpen
  // The button is a toggle, and a toggle has to say which way it is set. This is
  // the same declaration `#model` and `#title` make for their own layers, and it
  // is also the only place the open state is stated in terms a test can read:
  // the `hidden` attribute in the markup is not carried by the DOM shim, so a
  // test asking "is the bar open" would otherwise read the same value whether it
  // was or not — and a guard built on that asks nothing.
  findOpenButton.setAttribute('aria-expanded', String(findOpen))
  if (!findOpen) return
  if (findInput.value !== searchQuery) findInput.value = searchQuery
  const count = searchHits.length
  findCount.textContent = count === 0
    ? (searching ? t('find.searching') : t('find.none'))
    : t('find.count', {
      position: String(searchPosition + 1),
      count: String(count),
      // Always supplied, even when empty: the translator leaves an unmatched
      // `{name}` in the string as-is, so a placeholder passed only in the
      // truncated case renders the literal text `1/2{more}` on every ordinary
      // search. Measured in a real browser before this line existed.
      more: searchTruncated ? t('find.more') : '',
    })
  findPrev.disabled = count === 0
  findNext.disabled = count === 0
}

/**
 * Load one more page of older rows, keeping the reader where they were.
 *
 * `grewEarlier` tells `drawTranscript` to hold the reading position rather than
 * restore the raw scroll offset, which is the difference between "the page above
 * me appeared" and "the text I was reading jumped off the screen".
 *
 * @returns {Promise<void>} Resolves once the older page has been drawn.
 */
async function loadEarlier() {
  if (loadingEarlier || !hasEarlier) return
  loadingEarlier = true
  renderEarlier()
  const wanted = depth + PAGE_ROWS
  try {
    // The read is the same request the poll makes, one page wider; the drawn
    // position is held by `grewEarlier` rather than by remembering a row.
    grewEarlier = true
    depth = wanted
    await refreshTranscript()
  } finally {
    loadingEarlier = false
    renderEarlier()
  }
}

/** Show or hide the way back into the earlier part of the conversation. */
function renderEarlier() {
  const wanted = view === 'chat' && hasEarlier
  earlierButton.hidden = !wanted
  if (!wanted) return
  earlierButton.disabled = loadingEarlier
  earlierButton.textContent = loadingEarlier ? t('transcript.loading') : t('transcript.earlier')
}

/** Show the waiting row while the session has a turn in flight. */
function renderWorking() {
  const existing = transcript.querySelector('.working')
  // The row is for the gap before the first token arrives. Once the model has
  // produced anything, that text is itself the evidence that it is working, and
  // keeping the row would put two lines on screen saying the same thing — which
  // is what 「思考中…」 sitting under an answer that is already streaming is.
  const hasContent = live !== null && (live.text.length > 0 || live.reasoning.length > 0)
  const wanted = view === 'chat' && (currentSessionRunning || sending) && !hasContent
  if (!wanted) {
    existing?.remove()
  } else if (existing === null) {
    const line = document.createElement('div')
    line.className = 'working'
    line.textContent = t('row.working')
    transcript.append(line)
    if (stickToBottom && !sending) transcript.scrollTop = transcript.scrollHeight
  }
  // The composer's action depends on the same fact this row does, so they are
  // drawn together: there is no path that shows "running" without offering stop.
  drawSend()
}

/**
 * Draw the pending approval question, or take it away.
 *
 * The waiting row says a turn is running; this says *why nothing is happening*,
 * which is the fact the person actually needs. It is drawn at the end of the
 * transcript because that is where the eye already is, and it is the only place
 * in the panel that asks a question — everything else reports.
 *
 * @returns {void}
 */
function renderApproval() {
  const existing = transcript.querySelector('.approval')
  const wanted = view === 'chat' && pendingApproval !== null
  if (!wanted) {
    existing?.remove()
    drawnApproval = ''
    return
  }
  // What is on screen is compared as a whole, not by id alone: the busy state
  // changes the buttons, and an early return that ignored it would leave them
  // live while a request is already in flight.
  // The whole card is in the key, not just the id. Keying on the id alone meant a
  // question whose facts arrived later — the health poll catching up with a
  // notification, or the same id redelivered with more fields — kept the card
  // drawn from the earlier, poorer payload, and the redraw was skipped.
  const key = `${pendingApproval.id}:${answering}:${pendingApproval.site ?? ''}:${pendingApproval.sensitive === true}:${pendingApproval.reason ?? ''}`
  if (existing !== null && drawnApproval === key) return
  existing?.remove()
  drawnApproval = key

  const card = document.createElement('div')
  card.className = 'approval'
  card.dataset.approvalId = pendingApproval.id

  const head = document.createElement('div')
  head.className = 'approval-head'
  head.textContent = t('approval.asking')
  card.append(head)

  const what = document.createElement('div')
  what.className = 'approval-what'
  // The panel writes this sentence, because `reason` is English prose written
  // for the harness log — 「the browser bridge wants to use https://dl.acm.org」
  // was landing verbatim inside a 「需要你确认」 card, which is the same defect
  // the failure row had and reads just as wrong in a Chinese panel. The facts
  // come from the asking tool (`lib/approval.js` `factsFor`), so the sentence is
  // in the reader's language and names the site on its own terms.
  const site = typeof pendingApproval.site === 'string' ? pendingApproval.site : ''
  const tool = pendingApproval.toolName === 'a tool' ? t('approval.aTool') : pendingApproval.toolName
  what.textContent = site.length > 0
    ? t('approval.wantsSite', { tool, site })
    : t('approval.wants', { tool })
  card.append(what)

  // Its own row rather than a line inside the sentence: nesting it would make
  // `approval-what` read as 「要在 … 上使用 browser_click 这一步会改动页面或花钱」,
  // one run-on sentence doing two jobs.
  if (pendingApproval.sensitive === true) {
    const warn = document.createElement('div')
    warn.className = 'approval-note'
    warn.textContent = t('approval.sensitive')
    card.append(warn)
  }

  // The host's own wording stays reachable, but only when it still carries
  // information. With the site in hand the sentence above already says what the
  // prose said, and printing both put the same URL on screen twice — three lines
  // to say one thing, which is the noise this card exists to avoid. Without a
  // site the prose is the only thing naming the target, so it is kept, demoted
  // the way a failure's detail is.
  const detail = site.length === 0 ? failureDetail(pendingApproval.reason) : ''
  if (detail !== '') {
    const more = document.createElement('div')
    more.className = 'approval-detail'
    more.textContent = detail
    more.title = t('approval.detail')
    card.append(more)
  }

  const actions = document.createElement('div')
  actions.className = 'approval-actions'
  // Two ways to say yes, because they mean different things and the old card hid
  // that: one button reading 「允许一次」 recorded a grant lasting the whole
  // session, which is a promise the label did not make. The official card offers
  // the same distinction (`approvalRequestCard.allowOnce` next to
  // `approvalRequestCard.allowConversation`), and only one of them asks again.
  //
  // There is no "always allow": the grant table is in memory and a harness
  // restart drops it, so the button could not keep its word.
  const once = document.createElement('button')
  once.type = 'button'
  once.className = 'approval-once'
  once.textContent = t('approval.once')
  once.disabled = answering
  once.addEventListener('click', () => answerApproval('allowed-once', 'once'))
  const always = document.createElement('button')
  always.type = 'button'
  always.className = 'approval-allow'
  always.textContent = t('approval.allow')
  always.disabled = answering
  always.addEventListener('click', () => answerApproval('allowed-once', 'conversation'))
  const reject = document.createElement('button')
  reject.type = 'button'
  reject.className = 'approval-reject'
  reject.textContent = t('approval.reject')
  reject.disabled = answering
  reject.addEventListener('click', () => answerApproval('rejected'))
  // Narrowest grant first, which is how a permission dialog is ordered — Chrome
  // asks 「仅这次访问时允许」 before 「每次访问时都允许」, and Android does the
  // same. The narrowest answer is the one the eye and the hand reach first, and
  // widening the grant costs a deliberate move. The buttons carry no emphasis
  // of their own: see `.approval-actions` in sidepanel.html for why none of the
  // three is allowed to look like the default.
  actions.append(once, always, reject)
  card.append(actions)

  transcript.append(card)
  if (stickToBottom) transcript.scrollTop = transcript.scrollHeight
  // The card is the one thing in this panel that stops everything until it is
  // answered, and it appears with no other trace: a reader who is not watching
  // the transcript has no way to know the turn is waiting on them. Reuses the
  // sentence the card itself shows rather than inventing a second one to drift.
  announce(what.textContent)
}

/**
 * Answer the question on screen, at this surface.
 *
 * A refusal is ordinary — the graphical client may have answered first, or the
 * turn may have been cancelled while the card was up — and in every one of
 * those cases the card is stale, so it goes away rather than staying to imply
 * the answer was lost.
 *
 * @param {'allowed-once' | 'rejected'} outcome - Which answer the user chose.
 * @param {'once' | 'conversation'} [scope] - How long a yes lasts. Only the
 *   duration differs between the two affirmative buttons, so it travels with the
 *   answer rather than being re-derived at the host from a config default —
 *   which is how 「允许一次」 came to record a session-wide grant.
 * @returns {Promise<void>} Resolves once the host has been told.
 */
async function answerApproval(outcome, scope) {
  const question = pendingApproval
  if (question === null || answering) return
  answering = true
  renderApproval()
  try {
    const stored = await chrome.storage.local.get({ port: '3080' })
    const port = String(stored.port ?? '3080')
    const result = await fetch(`http://127.0.0.1:${port}/browser-bridge/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'approval', id: question.id, outcome, ...(scope === undefined ? {} : { scope }) }),
    })
    const payload = await result.json().catch(() => ({}))
    if (payload?.answered !== true) {
      say(t('error.notAnswered', { reason: payload?.reason ?? `HTTP ${result.status}` }))
    }
  } catch (error) {
    say(t('error.notAnswered', { reason: error?.message ?? String(error) }))
  } finally {
    // Either it was answered, or it is no longer open. Both mean this card has
    // nothing left to offer.
    if (pendingApproval?.id === question.id) pendingApproval = null
    answering = false
    renderApproval()
    refreshTranscript().catch(() => {})
  }
}

/**
 * Draw the streaming block, or take it away.
 *
 * It lives outside the row list on purpose: `drawTranscript` compares a
 * signature to decide whether to touch the DOM at all, and a block that changes
 * several times a second has no business invalidating that comparison.
 *
 * @returns {void}
 */
function renderLive() {
  const existing = transcript.querySelector('.live')
  const wanted = view === 'chat' && live !== null && (live.text.length > 0 || live.reasoning.length > 0)
  if (!wanted) {
    existing?.remove()
    return
  }

  let node = existing
  if (node === null) {
    node = document.createElement('div')
    node.className = 'live'
    const think = document.createElement('div')
    think.className = 'live-think'
    // The label is what says the model is working once the preview is on
    // screen. Before this, the separate waiting row said it — and once tokens
    // arrived the two were on screen together, both saying the same thing.
    const label = document.createElement('span')
    label.className = 'live-think-label'
    const preview = document.createElement('span')
    preview.className = 'live-think-text'
    think.append(label, preview)
    const body = document.createElement('div')
    body.className = 'answer live-body'
    node.append(think, body)
    // Above the waiting line, which `renderWorking` keeps as the last child.
    const anchor = transcript.querySelector('.working')
    if (anchor === null) transcript.append(node)
    else anchor.before(node)
  }

  node.dataset.done = String(live.done)
  const [think, body] = node.children
  const [label, preview] = think.children
  // Reasoning is superseded by the answer, exactly as a reasoning row is.
  const showThink = live.reasoning.length > 0 && live.text.length === 0
  label.textContent = t('row.reasoning')
  preview.textContent = live.reasoning
  think.hidden = !showThink
  body.textContent = live.text

  // The row that only says "working" is for the gap before the first token.
  // Once there is something to read, that text is the evidence — and a second
  // line repeating it is what made a live turn look like a pile of noise.
  renderWorking()

  if (stickToBottom) transcript.scrollTop = transcript.scrollHeight
}

/**
 * Fold one relayed `assistant/delta` frame into the live block.
 *
 * @param {object} payload - `{ sessionId, kind, text? }`, as `lib/stream.js` sends it.
 * @returns {void}
 */
function applyDelta(payload) {
  if (payload === null || typeof payload !== 'object') return
  // Another panel's session, or a turn the user has already navigated away from.
  if (payload.sessionId !== currentSessionId || currentSessionId.length === 0) return

  if (payload.kind === 'start') {
    live = { sessionId: currentSessionId, text: '', reasoning: '', tool: 0, done: false }
    currentSessionRunning = true
    // Draw the waiting line first: the live block is inserted before it, so
    // without this the first tokens would land under a line that is not there.
    renderWorking()
    renderLive()
    return
  }
  // Checked before the `live` guard below, because a failure has to be reported
  // whether or not this panel happened to see the attempt start. A panel opened
  // mid-turn misses `start` entirely and would otherwise drop the only word that
  // the turn died — the same silence, one layer deeper.
  if (payload.kind === 'failed') {
    currentSessionRunning = false
    live = null
    renderWorking()
    // The attempt committed no assistant message, so re-reading finds the same
    // transcript as before and the shimmer would simply stop — an empty answer
    // with no explanation, which reads as the model having nothing to say.
    //
    // The sentence comes from the failure code, not from the provider's message:
    // that message is a log line, and a toast is the worst possible place for
    // one because it is gone in seconds and cannot be re-read or searched.
    say(failureSentence(payload.code, t))
    refreshTranscript().catch(() => {})
    refreshGroups().catch(() => {})
    return
  }
  if (payload.kind === 'end' && payload.failed === true) {
    // Older hosts reported a failed attempt as an ordinary `end` carrying
    // `failed: true`. Kept so a panel that has been reloaded before the host is
    // restarted still speaks.
    currentSessionRunning = false
    live = null
    renderWorking()
    say(t('error.turnFailed'))
    refreshTranscript().catch(() => {})
    refreshGroups().catch(() => {})
    return
  }
  // A panel opened mid-turn never saw `start`, and a delta without one must not
  // invent a live block: the tokens that arrive from here are the *tail* of an
  // answer whose opening this panel never received, so rendering them would show
  // a fragment that looks like a whole reply. That is worse than the waiting line
  // it replaces, because nothing on screen would say the beginning is missing.
  //
  // The cost is silence for the rest of the attempt, and it is bounded: the host
  // commits the assistant message at the end of it, so the next `end` re-reads
  // the transcript and the complete answer appears. `stream.js` records the same
  // trade — a dropped notification costs at most the rest of the animation.
  //
  // `failed` is hoisted above this guard for the same reason in reverse: a turn
  // that died commits nothing, so there is no later read to recover it and the
  // failure has to be reported whether or not this panel saw the start.
  if (live === null) {
    // `end` still has to land: the waiting line is driven by the host's `running`
    // flag, and swallowing the end left the panel animating a turn that was over
    // for up to `POLL_MS`. Nothing is adopted — there is nothing to adopt.
    if (payload.kind === 'end') {
      currentSessionRunning = false
      renderWorking()
      refreshTranscript().catch(() => {})
      refreshGroups().catch(() => {})
    }
    return
  }

  const text = typeof payload.text === 'string' ? payload.text : ''
  if (payload.kind === 'text') live.text += text
  else if (payload.kind === 'reasoning') live.reasoning += text
  else if (payload.kind === 'tool') live.tool += text.length
  else if (payload.kind === 'end') {
    live.done = true
    renderLive()
    // `end` follows the commit, so the committed row is in the log by now and
    // this re-read swaps the block for the real, parsed markdown row.
    refreshTranscript().catch(() => {})
    // The waiting line is drawn from the host's `running` flag, so without this
    // it would sit under the finished answer until the next five-second poll.
    refreshGroups().catch(() => {})
    // The answer is the one moment its text is final, and until now a reader
    // heard nothing while it streamed in: `.live-body` is rewritten in full on
    // every frame, so it cannot be a live region — each token would re-announce
    // the whole answer from the top. Announcing the finished text once is the
    // shape that matches how the panel actually builds it.
    if (live.text.length > 0) announce(live.text)
    return
  } else return

  renderLive()
}

/**
 * Read the selected session's transcript.
 * @returns {Promise<void>} Resolves once the transcript is drawn.
 */
async function refreshTranscript() {
  if (currentSessionId.length === 0) {
    drawnSignature = ''
    rows = []
    drawnRows = []
    hasEarlier = false
    transcript.replaceChildren()
    renderEarlier()
    return
  }
  const { payload, status } = await bridge('/browser-bridge/chat', {
    method: 'POST',
    body: {
      action: 'messages',
      sessionId: currentSessionId,
      // How many rows to show, counted from the newest. The panel asks for a
      // window rather than for a page plus an offset, so a poll and a "load
      // earlier" are the same request at two sizes and there is no overlap to
      // de-duplicate: the window slides, and the reader's depth is the only
      // state that grows.
      limit: depth,
      // Except after a search jump, where the window is named by an absolute row
      // index so that rows arriving underneath cannot carry the reader off the
      // match they asked for. `null` is "the newest rows", which is the ordinary
      // case and the one every other caller wants.
      ...(anchorEnd === null ? {} : { end: anchorEnd }),
    },
  })
  if (status === 0) {
    setHostReachable(false)
    renderContexts()
    return
  }
  setHostReachable(true)
  const messages = Array.isArray(payload?.messages) ? payload.messages : []
  const session = currentSession()
  if (session !== undefined && typeof payload?.title === 'string' && payload.title.length > 0) {
    session.title = payload.title
    renderTitle()
  }
  hasEarlier = payload?.more === true
  if (typeof payload?.total === 'number') windowTotal = payload.total
  drawTranscript(messages)
  renderEarlier()
}

/**
 * Rebuild the history view from the workspace groups.
 * @returns {void}
 */
function drawHistory() {
  history.replaceChildren()
  const fragment = document.createDocumentFragment()
  const now = Date.now()

  if (groups.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'group-label'
    empty.textContent = t('history.empty')
    fragment.append(empty)
  }

  for (const group of groups) {
    // A blank session is a session nobody has said anything in. The harness's
    // own sidebar keeps exactly one of them per workspace as its "new session"
    // row; keeping the one on screen is enough here, because `+` is always
    // available and a list of empty rows is what made this unreadable.
    const visible = group.sessions.filter((session) => session.blank !== true || session.id === currentSessionId)
    if (visible.length === 0) continue

    if (group.title.length > 0) {
      const label = document.createElement('p')
      label.className = 'group-label'
      label.textContent = group.title
      fragment.append(label)
    } else {
      // The bucket for sessions whose directory is not a registered workspace.
      // It used to draw no label at all, so a run of rows appeared under the
      // previous workspace's heading and read as belonging to it. DSH's own
      // sidebar shows the same bucket under 「未分组」, so the word is the
      // harness's rather than one this panel invented.
      const label = document.createElement('p')
      label.className = 'group-label'
      label.textContent = t('history.ungrouped')
      fragment.append(label)
    }

    for (const session of visible) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'session'
      button.setAttribute('aria-current', String(session.id === currentSessionId))
      const title = document.createElement('span')
      title.className = 'session-title'
      title.textContent = session.title || (session.blank ? t('session.new') : t('session.untitled'))
      button.append(title)
      if (session.running) {
        const dot = document.createElement('span')
        dot.className = 'session-dot'
        // A six-pixel dot is the whole message, so it needs a name to be
        // readable at all: without one the row says "busy" only to someone who
        // already knows what the dot means.
        dot.title = t('session.running')
        dot.setAttribute('aria-label', t('session.running'))
        button.append(dot)
      }
      const time = document.createElement('span')
      time.className = 'session-time'
      time.textContent = relativeTime(t, session.updatedAt, now)
      button.append(time)
      button.addEventListener('click', () => {
        selectSession(session.id)
        showView('chat')
      })
      // The arrow keys are how anyone who lists sessions with a keyboard moves
      // between them; measured before this, ArrowDown on a session row left
      // focus exactly where it was. `focus()` rather than a scroll offset, so
      // the browser's own scroll-into-view follows the row and the panel does
      // not have to know where it landed.
      //
      // Only up and down. Home and End belong to the textarea, and the list has
      // no text cursor of its own to move.
      button.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        const rows = [...history.querySelectorAll('.session')]
        const index = rows.indexOf(button)
        if (index === -1) return
        // No wrapping: the list is a position in a longer sequence, and
        // jumping from the last row to the first hides how long it is.
        const next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)]
        if (next === undefined) return
        event.preventDefault()
        next.focus()
      })
      fragment.append(button)
    }
  }

  const foot = document.createElement('div')
  foot.className = 'session-foot'

  const settings = document.createElement('button')
  settings.type = 'button'
  settings.className = 'row-button'
  settings.textContent = t('action.settings')
  settings.addEventListener('click', () => {
    chrome.runtime.openOptionsPage()
  })
  foot.append(settings)

  const tabsLabel = document.createElement('p')
  tabsLabel.className = 'section-label'
  tabsLabel.textContent = t('tabs.title')
  foot.append(tabsLabel)

  if (controlledTabs.length === 0) {
    const none = document.createElement('p')
    none.className = 'tab-row'
    none.textContent = t('tabs.none')
    foot.append(none)
  } else {
    for (const tab of controlledTabs) {
      const row = document.createElement('p')
      row.className = 'tab-row'
      const label = document.createElement('span')
      label.className = 'tab-title'
      label.textContent = tab.title || tab.url || t('tabs.untitled')
      row.append(label)
      foot.append(row)
    }
  }

  fragment.append(foot)
  history.append(fragment)
}

/** Repaint the header and the history view. */
function renderChrome() {
  renderTitle()
  renderContexts()
  drawModel()
  if (view === 'history') drawHistory()
  // The session list decides whether the content area has anything to show, so
  // this belongs with the other repaints rather than only on the reachability
  // edge it used to hang off.
  renderOffline()
  drawSend()
  renderWorking()
}

/**
 * Switch between the conversation and the history.
 * @param {'chat'|'history'} next - The view to show.
 * @returns {void}
 */
function showView(next) {
  view = next
  transcript.hidden = next !== 'chat'
  history.hidden = next !== 'history'
  renderTitle()
  titleButton.setAttribute('aria-expanded', String(next === 'history'))
  if (next === 'history') {
    drawHistory()
  } else {
    adoptFromLastHealth()
  }
  // Three renderers skip drawing unless the conversation is the visible view,
  // and the live block removes what is already on screen rather than leaving it
  // hidden. So a switch in either direction has to repaint all three: leaving
  // without this leaves the waiting row and the live block sitting on a hidden
  // transcript, and coming back without it drops the nodes a reply streamed into
  // while the history was open. `renderEarlier` belongs to that set as well —
  // it is positioned over the stage, so it would float above the history list.
  renderLive()
  renderWorking()
  renderApproval()
  renderEarlier()
  updateToBottom()
}

/**
 * Pick up an open question from the health answer the panel already has.
 *
 * `adoptOpenApproval` skips the adoption while the history is the visible view,
 * because a card belongs to a transcript nobody is looking at then. The other
 * half of that decision is here: coming back has to look again, or a turn waits
 * forever behind a card that is never drawn. Health is polled every five
 * seconds, so waiting for the next tick would be up to five seconds of a frozen
 * conversation — visible, and long enough to look broken.
 *
 * @returns {void}
 */
function adoptFromLastHealth() {
  if (lastHealth === null) return
  adoptOpenApproval(lastHealth)
}

/**
 * Ask the host two separate questions.
 *
 * `hostReachable` is "did anything answer on this port"; `bridgeConnected` is
 * "is this extension attached to that host". They are deliberately distinct
 * facts, and the second one is what the attachment chip reports — reading the
 * first as if it were the second is what put a permanent 未连接 in the header of
 * a panel that was working fine.
 *
 * @returns {Promise<void>} Resolves once the state is updated.
 */
async function refreshHealth() {
  const { payload, status } = await bridge('/browser-bridge/health')
  setHostReachable(status !== 0)
  bridgeConnected = hostReachable && payload?.connected === true
  // Kept, not just used: a question reported while the history was open has to
  // be adoptable the moment the conversation comes back, and the next poll can
  // be five seconds away.
  lastHealth = payload ?? null
  adoptOpenApproval(payload)
  renderContexts()
  drawSend()
}

/**
 * Pick up a question that was asked before this panel was listening.
 *
 * `approval/asked` is a notification: it is delivered to whatever is connected
 * at that instant and never replayed. So a panel that opens, reloads, or was
 * closed while the question went out would show a spinning turn with no way to
 * answer it — the exact stuck turn the relay exists to remove, just reached by
 * a different route. The health route carries the open questions, which is what
 * makes the panel's view of them recoverable rather than dependent on having
 * been present at the right moment.
 *
 * A question already on screen is left alone: re-adopting it would rebuild the
 * card under the pointer every 5 seconds.
 *
 * @param {any} payload - The health body.
 * @returns {void}
 */
function adoptOpenApproval(payload) {
  if (view !== 'chat') return
  // A host from before this feature sends no `approvalPending` at all. That is
  // "cannot say", not "nothing is open", and treating it as the latter would
  // take away a card the notification path had legitimately put up.
  if (!Array.isArray(payload?.approvalPending)) return
  const open = payload.approvalPending
  if (pendingApproval !== null) {
    // Already showing one. If it is no longer open, the answer landed
    // somewhere else and the settled notification was missed.
    if (!open.some((entry) => entry?.id === pendingApproval.id)) {
      pendingApproval = null
      renderApproval()
    }
    return
  }
  // Only the question belonging to the conversation on screen. The host reports
  // every open one, and a card offers two buttons that answer one specific
  // question: drawn over a conversation that never asked it, it is an offer to
  // answer something else — and answering it would settle a decision the reader
  // cannot see the context for.
  const next = open.find(
    (entry) => typeof entry?.id === 'string' && entry?.sessionId === currentSessionId,
  )
  if (next === undefined) return
  pendingApproval = approvalQuestion(next)
  renderApproval()
}

/**
 * Keep the half of a question the card draws.
 *
 * Two paths receive a question — the live notification and the health poll that
 * catches one asked before the panel opened — and they used to build this object
 * separately. They drifted: when the card learned to phrase the site itself, only
 * one of them carried `origin`, so the same question read differently depending
 * on which path delivered it. Reading it once is the fix.
 *
 * @param {unknown} question - A question from either path.
 * @returns {{ id: string, sessionId: string, toolName: string, reason?: string, site?: string, sensitive?: boolean }} The fields the card uses.
 */
function approvalQuestion(question) {
  const entry = question ?? {}
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    toolName: typeof entry.toolName === 'string' ? entry.toolName : t('approval.aTool'),
    ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {}),
    // The facts the card phrases in the reader's language. The host calls the
    // site `origin`; the card calls it `site`, because that is what the person
    // is being asked about.
    ...(typeof entry.origin === 'string' ? { site: entry.origin } : {}),
    ...(typeof entry.sensitive === 'boolean' ? { sensitive: entry.sensitive } : {}),
  }
}

/**
 * Read the harness's session list and repaint.
 * @returns {Promise<void>} Resolves once the list is drawn.
 */
async function refreshGroups() {
  const stored = await chrome.storage.local.get({ port: '3080', panelSessionId: '' })
  harnessPort = String(stored.port ?? '3080')
  const { payload, status } = await bridge('/browser-bridge/chat')

  // A 200 whose body has no `groups` is not an empty list: it is a host running
  // code from before this panel existed. Saying so once is far better than
  // showing "还没有会话" and letting every button fail with a bare status code.
  const understood = status === 200 && Array.isArray(payload?.groups)
  if (status === 200 && !understood && !hostStale) {
    hostStale = true
    say(t('error.restartHost'))
  }
  if (understood) hostStale = false

  groups = understood ? payload.groups : []
  // Recorded after the list, not before it. `setHostReachable` repaints the
  // "nothing to show" surface, and it reads `groups` to decide which state that
  // is — so calling it first painted the empty state from the *previous* list,
  // announced 「还没有会话」 to a reader on every ordinary start, and corrected
  // itself a moment later. A screen reader cannot un-hear that.
  setHostReachable(status !== 0)

  const ids = new Set(groups.flatMap((group) => group.sessions.map((session) => session.id)))
  const remembered = typeof stored.panelSessionId === 'string' ? stored.panelSessionId : ''
  // Restoring the last session is safe because its name is in the header before
  // anything can be typed. Falling back to the most recently active one is the
  // panel opening on something rather than on nothing — and it is visible, not
  // silent: the header names it.
  const next = ids.has(remembered) ? remembered : (groups[0]?.sessions[0]?.id ?? '')
  if (next !== currentSessionId) {
    currentSessionId = next
    expandedReasoning.clear()
    expandedFailures.clear()
    drawnSignature = ''
    restoreDraft()
  }
  const session = currentSession()
  currentSessionBlank = session?.blank === true
  currentSessionRunning = session?.running === true
  renderChrome()
}

/**
 * Put one session on screen and remember it.
 * @param {string} sessionId - The session to show.
 * @returns {void}
 */
function selectSession(sessionId) {
  if (sessionId !== currentSessionId) {
    // The composer still holds what was typed for the session being left, and
    // `restoreDraft` below is about to replace it. Saving it here is what keeps
    // a half-written message from being lost by looking at another conversation.
    setDraft(currentSessionId, input.value)
    currentSessionId = sessionId
    expandedReasoning.clear()
    expandedFailures.clear()
    drawnSignature = ''
    transcript.replaceChildren()
    drawnRows = []
    stickToBottom = true
    // Everything below belongs to the session being left, and none of it is
    // reachable through `applyDelta`'s session check, because a switch does not
    // go through `applyDelta`. Carried across, the text of one conversation is
    // drawn inside another, a card offers to answer a question that the visible
    // conversation never asked, and a mentioned tab attaches to a message it was
    // never chosen for.
    live = null
    pendingApproval = null
    mentioned = null
    // Windowed state belongs to the session too: carried across, a conversation
    // would open already scrolled to some other session's depth, showing rows
    // that the new session does not have and claiming there is more above them.
    depth = PAGE_ROWS
    hasEarlier = false
    grewEarlier = false
    loadingEarlier = false
    // A match belongs to the conversation it was found in. Kept across a switch,
    // the count would describe rows in a session that is no longer on screen, and
    // stepping through them would jump the new conversation to an index that
    // means something else there.
    anchorEnd = null
    searchHits = []
    searchTotal = 0
    searchTruncated = false
    searchPosition = 0
    restoreDraft()
  }
  const session = currentSession()
  currentSessionBlank = session?.blank === true
  currentSessionRunning = session?.running === true
  if (sessionId.length > 0) chrome.storage.local.set({ panelSessionId: sessionId })
  renderChrome()
  refreshTranscript().catch(() => {})
}

/** Put the selected session's draft back in the composer. */
function restoreDraft() {
  input.value = drafts.get(currentSessionId) ?? ''
  input.style.height = 'auto'
  input.style.height = `${Math.min(140, input.scrollHeight)}px`
  drawSend()
}

/**
 * Hold one session's draft, in memory and where the next opening will find it.
 *
 * The in-memory map is what `restoreDraft` reads, and it is updated in the same
 * call so the two can never disagree — every write goes through here rather
 * than to `drafts` directly.
 *
 * Storage is written on every keystroke, deliberately not debounced. A timer
 * would have to be flushed by an unload event, and the panel cannot promise one
 * arrives: the side panel is closed by the browser, by a window closing, or by a
 * switch to another side panel, and a draft that missed its timer is gone with
 * no trace. Writing each keystroke has no such window, and it is affordable — a
 * write measures 0.2ms for a short draft and 0.3ms for a 4000-character one,
 * both far under a frame.
 *
 * The write is not awaited, and it does not need to be: `chrome.storage.local`
 * applies writes in the order they were issued, so the last keystroke is the one
 * that lands even with several in flight. Measured with 250 unawaited writes in
 * a row, the value read back was the 250th.
 *
 * @param {string} sessionId - The session the text belongs to.
 * @param {string} text - What the composer holds for it.
 * @returns {void}
 */
function setDraft(sessionId, text) {
  if (sessionId.length === 0) return
  if (text.length === 0) {
    clearDraft(sessionId)
    return
  }
  drafts.set(sessionId, text)
  chrome.storage.local.set({ [DRAFT_PREFIX + sessionId]: text }).catch(() => {})
}

/**
 * Forget one session's draft, in memory and in storage.
 *
 * Sent messages and emptied composers both land here. Removing the key rather
 * than storing an empty string keeps storage holding only what is really
 * pending, instead of one record per session ever visited.
 *
 * @param {string} sessionId - The session to forget.
 * @returns {void}
 */
function clearDraft(sessionId) {
  if (sessionId.length === 0) return
  drafts.delete(sessionId)
  chrome.storage.local.remove(DRAFT_PREFIX + sessionId).catch(() => {})
}

/**
 * What travels with this send: the tab's identity always, the shown selection
 * only while it is still attached.
 *
 * @returns {object[]} Attachment inputs for the host to stage.
 */
function pendingAttachments() {
  const attachments = []
  if (mentionAddsSomething()) {
    // A mentioned tab travels as its own attachment rather than replacing the
    // current-tab one: the message may well be about a page other than the one
    // in front, which is the whole reason `@` exists.
    attachments.push({
      kind: 'tab',
      url: mentioned.url,
      title: mentioned.title,
      ...(mentioned.id === undefined ? {} : { tabId: mentioned.id }),
    })
  }
  if (currentTab.url.length > 0) {
    attachments.push({
      kind: 'tab',
      url: currentTab.url,
      title: currentTab.title,
      ...(currentTab.id === undefined ? {} : { tabId: currentTab.id }),
    })
  }
  if (selectionAttached && currentSelection.text.length > 0) {
    attachments.push({
      kind: 'selection',
      url: currentSelection.url || currentTab.url,
      title: currentSelection.title || currentTab.title,
      ...(currentTab.id === undefined ? {} : { tabId: currentTab.id }),
      text: currentSelection.text,
    })
  }
  return attachments
}

/**
 * Draw the composer's one action.
 *
 * Send and stop are the same slot in two states rather than two buttons: a
 * running turn has nothing to send and everything to stop, and a stop control
 * kept anywhere else is something the user has to hunt for while the thing it
 * stops is still running.
 *
 * @returns {void}
 */
function drawSend() {
  // `sending` counts as busy. The request is in flight and the turn it starts
  // is already past the point of being recalled by the time the answer lands,
  // so offering stop immediately is honest rather than optimistic.
  const busy = sending || currentSessionRunning
  if (busy) {
    sendButton.dataset.mode = 'stop'
    sendButton.textContent = '■'
    sendButton.title = t('action.stop.title')
    sendButton.setAttribute('aria-label', t('action.stop'))
  } else {
    delete sendButton.dataset.mode
    sendButton.textContent = '↑'
    sendButton.title = t('action.send.title')
    sendButton.setAttribute('aria-label', t('action.send'))
  }
  // While busy, only its own in-flight request disables it: whether there is
  // text in the box stopped mattering the moment the turn started.
  sendButton.disabled = busy
    ? stopping
    : !hostReachable || currentSessionId.length === 0 || input.value.trim().length === 0
}

/**
 * Stop the running turn.
 *
 * `cancel` drops the turn, not the inbox: anything the user queued while it ran
 * still goes through. That is the host's semantics and the one a user expects
 * from a stop button in a client where sending while busy is allowed.
 *
 * @returns {Promise<void>}
 */
async function stopTurn() {
  if (stopping || currentSessionId.length === 0) return
  stopping = true
  drawSend()
  const result = await bridge('/browser-bridge/chat', {
    method: 'POST',
    body: { action: 'cancel', sessionId: currentSessionId },
  })
  stopping = false
  const payload = result.payload ?? {}
  if (payload.cancelled === true) {
    // Re-read rather than trim the transcript: what a stopped turn leaves
    // behind is the host's decision, and a cancelled attempt may still be
    // recorded. `renderWorking` redraws the button on its way out.
    currentSessionRunning = false
    renderWorking()
    refreshGroups().catch(() => {})
    refreshTranscript().catch(() => {})
    return
  }
  say(t('error.notStopped', { reason: payload.reason ?? `HTTP ${result.status}` }))
  drawSend()
}

/**
 * Whether the mention says anything the current tab does not.
 *
 * Mentioning the page already in front of you is the easy mistake to make —
 * `@` lists it first, because it is the most recently used — and the two are
 * the same attachment. The host dedupes on the URL, so sending both would put
 * one attachment in the prompt while the chip row showed two, which is the
 * panel promising something it does not deliver.
 *
 * A mention with no URL can never equal the current tab, so it always counts:
 * an attachment with nothing to identify it is not silently dropped.
 *
 * @returns {boolean} True when the mention should be staged on its own.
 */
function mentionAddsSomething() {
  if (mentioned === null) return false
  if (currentTab.url.length === 0) return true
  return mentioned.url !== currentTab.url
}

/**
 * Deliver the composed message into the selected session.
 * @returns {Promise<void>} Resolves once the send has been acknowledged.
 */
async function sendMessage() {
  const text = input.value.trim()
  if (text.length === 0) return
  if (currentSessionId.length === 0) {
    say(t('error.noSession'))
    return
  }
  sending = true
  drawSend()
  stickToBottom = true
  // Sending is the reader saying they are done looking at the past. While a
  // search has the window parked, the reply — and their own message — arrives
  // outside it, so leaving the anchor set means asking a question and never
  // seeing the answer. Measured: after a jump, a send left the last row at
  // 「第 11 个问题」 of 600.
  //
  // Clearing the anchor is not enough on its own. The echo below appends to
  // `rows`, and `rows` is still the parked window — so the message would be
  // drawn after row 22 of 600 while the reply lands at the end. The read comes
  // first, which is what makes `rows` the newest window again.
  const wasParked = anchorEnd !== null
  anchorEnd = null
  if (wasParked) await refreshTranscript()
  const result = await bridge('/browser-bridge/chat', {
    method: 'POST',
    body: { action: 'send', sessionId: currentSessionId, text, attachments: pendingAttachments() },
  })
  if (result.payload?.accepted === true) {
    input.value = ''
    input.style.height = 'auto'
    clearDraft(currentSessionId)
    // The mention was for that message. Keeping it would silently attach the
    // same page to the next one, which is exactly the kind of standing promise
    // this panel works to avoid.
    mentioned = null
    closeMention()
    renderContexts()
    // The host reports what it actually took. A refused attachment used to be
    // silent: the chip promised it, the message left without it, and the only
    // way to find out was to wonder.
    const refused = Array.isArray(result.payload?.context?.refused) ? result.payload.context.refused : []
    if (refused.length > 0) say(t('error.attachmentRefused', { reason: refused.join('; ') }))
    // The turn is running now, and the transcript has no stream to show it.
    //
    // The previous attempt's live block is dropped here rather than waiting for
    // its `end` frame: a turn can die without the panel hearing about it (a host
    // restart, a reload mid-turn), and a stale block would both show the wrong
    // text and suppress the waiting row, because the row is drawn only when the
    // stream has nothing to say yet.
    live = null
    currentSessionRunning = true
    renderLive()
    renderWorking()
    // Put the message on screen now. Until this, the panel emptied the composer
    // and showed 「思考中…」 while the sent line existed nowhere: the transcript
    // is only re-read after 800ms, and a turn that dies before then left the
    // message looking as though it had never been typed.
    //
    // It is an echo, not a record. `rows` still holds what the host last sent,
    // so the next `refreshTranscript` replaces the whole list and the echo goes
    // with it — which is why it cannot drift, and why a send the host quietly
    // drops does not leave a message on screen that was never delivered.
    drawTranscript([...rows, { kind: 'user', text }])
    for (const delay of [800, 2000, 4000, 8000, 15000]) {
      setTimeout(() => {
        refreshTranscript().catch(() => {})
      }, delay)
    }
  } else {
    const reason = result.payload?.reason ?? result.payload?.error ?? `HTTP ${result.status}`
    say(t('error.notSent', { reason }))
  }
  sending = false
  drawSend()
}

/**
 * Start a session in the workspace the panel is showing.
 * @returns {Promise<void>} Resolves once the session exists.
 */
async function newSession() {
  // On an older host this route does not exist and the answer is a bare 400,
  // which reads as "the button is broken" rather than "the host is old".
  if (hostStale) {
    say(t('error.restartHost'))
    return
  }
  if (creating) return
  creating = true
  drawNew()
  // The same control lives on the empty surface, and it has to show the same
  // work there — otherwise pressing it looks like nothing happened.
  renderOffline()
  try {
    await createSession()
  } finally {
    creating = false
    drawNew()
    renderOffline()
  }
}

/**
 * Draw the new-session button for the work it is doing.
 *
 * The click starts a round trip, and the button is the only thing that can say
 * so: the panel has nothing else to change until the host answers. It goes
 * inert for the duration rather than staying open, because a second press is a
 * second session and not a repeat of the same one.
 *
 * @returns {void}
 */
function drawNew() {
  newButton.disabled = creating
  newButton.setAttribute('aria-busy', String(creating))
}

/**
 * Ask the host for a session and adopt it.
 * @returns {Promise<void>} Resolves once the new session is on screen.
 */
async function createSession() {
  const workspaceId = currentGroup()?.id
  const result = await bridge('/browser-bridge/chat', {
    method: 'POST',
    body: { action: 'create', ...(typeof workspaceId === 'string' && workspaceId.length > 0 ? { workspaceId } : {}) },
  })
  if (result.payload?.created !== true) {
    const reason = result.payload?.reason ?? `HTTP ${result.status}`
    say(t('error.generic', { reason }))
    return
  }
  setDraft(currentSessionId, input.value)
  currentSessionId = result.payload.sessionId
  expandedReasoning.clear()
  expandedFailures.clear()
  drawnSignature = ''
  rows = []
  transcript.replaceChildren()
  drawnRows = []
  stickToBottom = true
  currentSessionBlank = true
  currentSessionRunning = false
  chrome.storage.local.set({ panelSessionId: currentSessionId })
  restoreDraft()
  await refreshGroups()
  showView('chat')
  input.focus()
}

/** Refresh the tab list and the current-tab summary. */
async function refreshTabs() {
  try {
    tabs = await chrome.tabs.query({})
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (active !== undefined) {
      currentTab = { id: active.id, url: active.url ?? '', title: active.title ?? '', icon: faviconOf(active) }
    }
  } catch {
    tabs = []
  }
  controlledTabs = tabs.filter((tab) => typeof tab.groupId === 'number' && tab.groupId >= 0)
  renderContexts()
  if (view === 'history') drawHistory()
}

titleButton.addEventListener('click', () => {
  showView(view === 'history' ? 'chat' : 'history')
})

backButton.addEventListener('click', () => {
  showView('chat')
})

newButton.addEventListener('click', () => {
  newSession().catch((error) => say(t('error.generic', { reason: error.message })))
})

/**
 * Open or close the find bar.
 *
 * Closing clears the query rather than only hiding the field: the next `⌕` is a
 * fresh search, and a field that reopens holding the previous word makes the
 * panel look like it is still filtering the transcript in the background.
 *
 * @param {boolean} next - Whether the bar should be open.
 * @returns {void}
 */
function setFind(next) {
  findOpen = next
  if (!next) {
    searchQuery = ''
    searchHits = []
    searchTotal = 0
    searchTruncated = false
    searchPosition = 0
    findInput.value = ''
  }
  renderFind()
  if (next) findInput.focus()
  else if (document.activeElement === findInput) findOpenButton.focus()
}

findOpenButton.addEventListener('click', () => {
  setFind(!findOpen)
})

findClose.addEventListener('click', () => {
  setFind(false)
})

findInput.addEventListener('input', () => {
  searchQuery = findInput.value
  // Back to the newest match: the reader has asked a new question, and holding
  // the old position would open the results at a match they did not search for.
  searchPosition = 0
  runSearch().catch((error) => say(t('error.generic', { reason: error.message })))
})

/**
 * Step to another match, wrapping at both ends.
 *
 * @param {number} step - `1` for the next match, `-1` for the previous.
 * @returns {void}
 */
function stepMatch(step) {
  if (searchHits.length === 0) return
  searchPosition = (searchPosition + step + searchHits.length) % searchHits.length
  renderFind()
  goToMatch(searchPosition).catch((error) => say(t('error.generic', { reason: error.message })))
}

findNext.addEventListener('click', () => {
  stepMatch(1)
})

findPrev.addEventListener('click', () => {
  stepMatch(-1)
})

findInput.addEventListener('keydown', (event) => {
  // Enter is how a reader steps through matches without leaving the field: the
  // caret is where they are typing, and reaching for a button would cost them
  // the position in their query. Shift+Enter goes back.
  if (event.key === 'Enter') {
    event.preventDefault()
    stepMatch(event.shiftKey ? -1 : 1)
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    setFind(false)
  }
})

modelButton.addEventListener('click', (event) => {
  // The document listener below closes the picker on any outside click, and
  // without stopping here the click that opens it would be the one that shuts
  // it. Clicks inside the menu stop at the menu for the same reason.
  event.stopPropagation()
  setMenu()
})

modelMenu.addEventListener('click', (event) => {
  event.stopPropagation()
})

// The menu role is a promise about the keyboard, and this is where it is kept:
// with `role="menu"` on the container, a reader who opens it with the keyboard
// expects the arrow keys to walk it and Escape to hand focus back to the button
// they came from. Before this the only way through the list was Tab — which
// leaves the menu, because the rows come after it in the document — and Escape
// closed the picker while leaving focus on a row that had just been removed,
// which put it on `body` and made the next Tab start from the top of the panel.
modelMenu.addEventListener('keydown', (event) => {
  const items = [...modelMenu.querySelectorAll('button')]
  const index = items.indexOf(document.activeElement)
  if (index === -1) return

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const step = event.key === 'ArrowDown' ? 1 : -1
    // No wrapping, matching the session list: the ends of a list are information,
    // and jumping from the last row to the first hides how long it is.
    const next = items[index + step]
    if (next !== undefined) next.focus()
    return
  }
  if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault()
    const end = event.key === 'Home' ? items[0] : items[items.length - 1]
    end?.focus()
  }
})

document.addEventListener('click', () => {
  setMenu(false)
})

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  setMenu(false)
  // The history is a layer over the conversation, and Escape is how a keyboard
  // user dismisses a layer. Without this the only way out was to find the `‹`
  // button with the mouse or tab to it, while every other overlay in the panel
  // already answered Escape.
  //
  // It closes rather than toggles: `#title` opens *and* closes, so making
  // Escape toggle would let it open the history, which is not what dismissing a
  // layer means.
  if (view === 'history') {
    showView('chat')
    // Focus has to leave the row that is disappearing, or it lands on `body` and
    // the next Tab starts from the top of the panel.
    titleButton.focus()
  }
})

sendButton.addEventListener('click', () => {
  const action = sendButton.dataset.mode === 'stop' ? stopTurn() : sendMessage()
  action.catch((error) => say(t('error.generic', { reason: error.message })))
})

input.addEventListener('keydown', (event) => {
  // The picker owns the navigation keys while it is open, or the arrow keys
  // would move the caret and Enter would send a message that is half a mention.
  if (mention !== null) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const count = mention.options.length
      if (count > 0) {
        const step = event.key === 'ArrowDown' ? 1 : -1
        mention.index = (mention.index + step + count) % count
        for (const [index, node] of [...atMenu.querySelectorAll('button')].entries()) {
          node.setAttribute('aria-selected', String(index === mention.index))
        }
      }
      return
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      if (event.isComposing === true || event.keyCode === 229) return
      event.preventDefault()
      acceptMention(mention.index)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      closeMention()
      return
    }
  }
  if (event.key !== 'Enter' || event.shiftKey) return
  // An IME commits its candidate with Enter. Sending on that keystroke would
  // turn "type 你好 and accept it" into "type 你好 and send a half-finished
  // line", which is the normal way to write Chinese, Japanese, or Korean — so
  // the guard is not an edge case for those users, it is every message.
  // `keyCode === 229` is the older signal for the same thing.
  if (event.isComposing === true || event.keyCode === 229) return
  event.preventDefault()
  sendMessage().catch((error) => say(t('error.generic', { reason: error.message })))
})

input.addEventListener('input', () => {
  input.style.height = 'auto'
  input.style.height = `${Math.min(140, input.scrollHeight)}px`
  setDraft(currentSessionId, input.value)
  drawMention()
  drawSend()
})

transcript.addEventListener('scroll', () => {
  stickToBottom = atBottom()
  updateToBottom()
})

/**
 * Put text on the clipboard.
 *
 * `navigator.clipboard` is the whole implementation on purpose: the panel is an
 * extension page, which is a secure context, and a click is a user gesture, so
 * the API is available exactly when the button is. The deprecated
 * `document.execCommand('copy')` fallback is left out because it would be a
 * path that never runs in production and therefore never gets tested; a refusal
 * is reported instead of swallowed.
 *
 * @param {string} text - What to copy.
 * @returns {Promise<boolean>} Whether the clipboard took it.
 */
async function copyText(text) {
  const clipboard = globalThis.navigator?.clipboard
  if (clipboard === undefined || typeof clipboard.writeText !== 'function') return false
  try {
    await clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/**
 * One delegated handler for every copy button in the transcript.
 *
 * Rows are rebuilt whenever the transcript's data changes, so per-button
 * listeners would need re-attaching on every draw. Delegation survives a
 * redraw — which is also what lets the "copied" label sit there for a moment
 * without the next poll wiping it.
 */
transcript.addEventListener('click', (event) => {
  const button = event.target?.closest?.('.copy')
  if (button === null || button === undefined) return
  const scope = button.dataset.copy === 'code' ? button.closest('.code-block') : button.closest('.row')
  const source = button.dataset.copy === 'code' ? scope?.querySelector('code') : scope?.querySelector('.answer')
  const text = typeof source?.textContent === 'string' ? source.textContent : ''
  if (text.length === 0) return
  copyText(text).then((ok) => {
    if (!ok) {
      say(t('error.notCopied'))
      return
    }
    button.dataset.state = 'copied'
    button.textContent = t('action.copied')
    setTimeout(() => {
      delete button.dataset.state
      button.textContent = t('action.copy')
    }, 1400)
  })
})

toBottom.addEventListener('click', () => {
  stickToBottom = true
  // Scrolling is not enough once a search has parked the window: the newest rows
  // are not in it, so reaching the bottom of the scrollbar lands on the last row
  // of the window and the conversation appears to end there. Measured before
  // this: after a jump, "jump to latest" left the last row at 「第 11 个问题」 of
  // 600 and the real newest content was unreachable. Clearing the anchor is what
  // returns the panel to the newest rows; the scroll then follows the redraw.
  if (anchorEnd !== null) {
    anchorEnd = null
    refreshTranscript().catch((error) => say(t('error.generic', { reason: error.message })))
    return
  }
  transcript.scrollTop = transcript.scrollHeight
  updateToBottom()
})

earlierButton.addEventListener('click', () => {
  loadEarlier().catch((error) => say(t('error.generic', { reason: error.message })))
})

/**
 * Adopt one selection report, from either the event channel or a direct request.
 *
 * A fresh highlight is a fresh decision: it is attached until dropped. A report
 * with no text is equally meaningful — it clears the chip, which is the whole
 * answer to "will this be attached?".
 *
 * @param {object} payload - `{ text, url, title }` from the page.
 * @returns {void}
 */
function applySelection(payload) {
  const text = typeof payload?.text === 'string' ? payload.text : ''
  currentSelection = {
    text,
    url: typeof payload?.url === 'string' ? payload.url : '',
    title: typeof payload?.title === 'string' ? payload.title : '',
  }
  selectionAttached = text.length > 0
  renderContexts()
}

/**
 * Ask the active tab's reporter for the selection it is already holding.
 *
 * A selection made before the panel opened is invisible otherwise, and so is one
 * made while the panel was closed. The retry is the important half: reloading
 * the extension leaves the reporter in every open tab alive but with a dead
 * extension context, so it still listens and its messages go nowhere. That
 * failure is completely silent — the page looks fine, the panel looks fine, and
 * nothing ever arrives — so the panel detects it by the request failing and
 * re-injects its own reporter, which touches nothing of the page.
 *
 * @returns {Promise<void>} Resolves once the panel reflects the page.
 */
async function requestSelectionFromPage() {
  let tab
  try {
    ;[tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  } catch {
    return
  }
  if (tab?.id === undefined) return

  /**
   * Ask the page, and treat anything that is not the promised shape as failure.
   *
   * A dead message port resolves with `undefined` instead of rejecting, so the
   * shape of the answer is the only reliable signal — and the first version read
   * that `undefined` as "this page has no selection", which is the same picture
   * as success with nothing to show.
   *
   * @returns {Promise<object|undefined>} The reply, or undefined if it never came.
   */
  const ask = async () => {
    const reply = await chrome.tabs.sendMessage(tab.id, { type: 'dsh-selection-request' })
    return reply !== null && typeof reply === 'object' && typeof reply.text === 'string' ? reply : undefined
  }

  let reply
  try {
    reply = await ask()
  } catch {
    reply = undefined
  }

  if (reply === undefined) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content-selection.js'] })
      reply = await ask()
    } catch {
      // Chrome injects only where the extension holds host permission; anywhere
      // else this throws and there is no recovery to attempt.
      reply = undefined
    }
  }

  if (reply !== undefined) {
    staleReporter = ''
    applySelection(reply)
    return
  }

  // Say it once per page rather than showing nothing. "No chip" is otherwise the
  // same picture whether the page has no selection or cannot be reached, and
  // that question is the only reason the chip is on screen at all.
  const url = String(tab.url ?? '')
  if (!/^https?:/i.test(url)) return
  const key = `${tab.id}:${url}`
  if (staleReporter === key) return
  staleReporter = key
  say(t('error.reportStale'))
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'dsh-assistant-delta') {
    applyDelta(message.payload ?? {})
    return false
  }
  if (message?.type === 'dsh-approval-asked') {
    const question = message.payload ?? {}
    // Only the shape this panel can answer is kept; anything else would render
    // buttons that cannot say what they are answering.
    if (typeof question.id === 'string' && typeof question.sessionId === 'string') {
      pendingApproval = approvalQuestion(question)
      renderApproval()
      // The question is about a turn, and the turn may be in a session the
      // panel is not showing; following it is what makes the card reachable
      // instead of appearing on a different session's transcript.
      // `selectSession` is synchronous and already handles its own failures, so
      // there is nothing to await or catch here.
      if (question.sessionId !== currentSessionId && hostReachable) {
        selectSession(question.sessionId)
      }
    }
    return false
  }
  if (message?.type === 'dsh-approval-settled') {
    const id = message.payload?.id
    if (pendingApproval !== null && (id === undefined || id === pendingApproval.id)) {
      pendingApproval = null
      renderApproval()
    }
    return false
  }
  if (message?.type !== 'dsh-selection-changed') return false
  applySelection(message.payload ?? {})
  return false
})

/**
 * Read everything the panel shows, in one place.
 *
 * Split out of `start` so the blocked surface's retry runs the same work as the
 * first load. A second, thinner path written for the retry would be the one that
 * drifts — it is the copy nobody exercises, and the retry is exactly the moment
 * the panel is already known to be wrong.
 *
 * @returns {Promise<void>} Resolves once every read has been attempted.
 */
async function loadEverything() {
  try {
    await refreshGroups()
    await refreshHealth()
  } catch (error) {
    say(t('error.startedFailed', { error: error.message }))
  }
  try {
    await refreshTranscript()
  } catch (error) {
    say(t('error.loadFailed', { error: error.message }))
  }
  await refreshTabs().catch(() => {})
  // Not awaited into the failure path above: a missing catalog is a state the
  // picker reports on its own, not a reason to tell the person the panel broke.
  await refreshCatalog().catch(() => {})
}

/** Try the whole load again, from the blocked surface. */
async function retry() {
  if (retrying) return
  retrying = true
  renderOffline()
  try {
    await loadEverything()
    await requestSelectionFromPage().catch(() => {})
  } finally {
    retrying = false
    renderOffline()
  }
}

/**
 * Put the caret where someone who just opened the panel expects it.
 *
 * Opening the panel is an explicit act, and the overwhelmingly common reason
 * for it is to type something. Measured before this, focus landed on `body`:
 * the first keystroke went nowhere, and the only way to begin was to click the
 * box or tab to it.
 *
 * Two states are excluded, and both are cases where focus already has a better
 * home. A waiting question is why someone who followed the badge opened the
 * panel at all, so aiming them at the composer points at the wrong control. And
 * the blocked surface has no composer to type into — focusing a box that is not
 * on screen leaves `document.activeElement` on a hidden node and sends the next
 * Tab somewhere unpredictable.
 *
 * `preventScroll`, because the panel is short: letting the browser scroll the
 * focused element into view would move the transcript under someone who just
 * opened it.
 *
 * A named function rather than three lines inside `start`, because `start` runs
 * once at import: as inline code the excluded branches would be unreachable from
 * the suite, which is how the arrow-key gap survived in the first place.
 *
 * @returns {void}
 */
function focusComposer() {
  if (pendingApproval !== null || !surface.hidden) return
  input.focus({ preventScroll: true })
}

/**
 * Read back every draft the previous opening of the panel left behind.
 *
 * Done once, before the first `restoreDraft`, and held in memory afterwards:
 * switching sessions must not be a storage round trip, because `restoreDraft`
 * runs on a click and the composer has to be correct in that same frame.
 *
 * @returns {Promise<void>} Resolves once the drafts are in memory.
 */
async function loadDrafts() {
  const everything = await chrome.storage.local.get(null)
  for (const [key, value] of Object.entries(everything)) {
    if (!key.startsWith(DRAFT_PREFIX)) continue
    if (typeof value !== 'string') continue
    drafts.set(key.slice(DRAFT_PREFIX.length), value)
  }
}

/** Start the panel and keep the slow-moving parts fresh. */
async function start() {
  paintStaticCopy()
  // Before `loadEverything`, which selects a session and restores its draft: a
  // draft read back after that would arrive one frame late, and the composer
  // would be seen empty and then fill in.
  await loadDrafts().catch(() => {})
  await loadEverything()
  await requestSelectionFromPage().catch(() => {})
  focusComposer()
  // One surface, two jobs. Which one the button does is the same decision that
  // chose its label, so it is read back from the state rather than from a flag
  // set by whichever branch drew last.
  blockedAction.addEventListener('click', () => {
    if (!hostReachable) {
      retry().catch(() => {})
      return
    }
    newSession().catch((error) => say(t('error.generic', { reason: error.message })))
  })

  // Switching tabs is a new page, and with it a new selection — or none. Without
  // this the chip keeps describing the tab the panel was opened on.
  chrome.tabs.onActivated.addListener(() => {
    refreshTabs().catch(() => {})
    requestSelectionFromPage().catch(() => {})
  })

  // Highlighting text moves focus to the page, so coming back to the panel is
  // the moment the chip has to be right — and the moment a reporter killed by an
  // extension reload gets its one chance to be replaced.
  window.addEventListener('focus', () => {
    requestSelectionFromPage().catch(() => {})
  })

  setInterval(() => {
    refreshGroups().catch(() => {})
  }, 5000)
  // The attachment chip's state is the host's answer about *this extension*, and
  // it changes independently of the session list — the service worker sleeps and
  // wakes on its own schedule.
  setInterval(() => {
    refreshHealth().catch(() => {})
  }, 5000)
  setInterval(() => {
    refreshTabs().catch(() => {})
  }, 5000)
  // The transcript refreshes on its own, so a turn started in the DSH window
  // shows up here without pressing reload — except mid-send, where a concurrent
  // read could race the reply into a half-drawn list.
  setInterval(() => {
    if (sending) return
    refreshTranscript().catch(() => {})
  }, POLL_MS)
}

start().catch((error) => say(t('error.startedFailed', { error: error.message })))
