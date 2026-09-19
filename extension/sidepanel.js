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

const backButton = document.getElementById('back')
const titleButton = document.getElementById('title')
const titleText = document.getElementById('title-text')
const newButton = document.getElementById('new')
const transcript = document.getElementById('transcript')
const history = document.getElementById('history')
const toBottom = document.getElementById('to-bottom')
const earlierButton = document.getElementById('earlier')
const toast = document.getElementById('toast')
const announceUrgent = document.getElementById('announce-urgent')
const announcePolite = document.getElementById('announce')
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
/**
 * Why the extension is not attached, as a code from the worker.
 *
 * `''` while connected. `'no-token'` and `'connecting'` are the two the panel
 * acts differently on: the first sends the reader to the options page, the
 * second just needs a moment.
 *
 * @type {string}
 */
let bridgeReason = ''
/** Whether a retry request is in flight, so the chip cannot be pressed twice. */
let retryingBridge = false
/** Whether a retry from the blocked surface is in flight. */
let retrying = false
/** Whether the host says older rows exist beyond the window on screen. */
let hasEarlier = false
/** How many rows of the current conversation the panel is showing. */
let depth = PAGE_ROWS
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
/** @type {Map<string, string>} */
const drafts = new Map()
/** Reasoning rows the user opened, by row index. */
const expandedReasoning = new Set()
/** The last drawn transcript, for the "did anything change" comparison. */
let drawnSignature = ''
/** True while the view is pinned to the newest row. */
let stickToBottom = true
/** The deployment's model catalog, or null until it has been read. */
let catalog = null
/** Why the catalog is missing, when it is. */
let catalogReason = ''
/** Whether the picker is open. */
let menuOpen = false
/**
 * Which option the arrow keys are on, or -1 for none.
 *
 * The options themselves carry the highlight rather than DOM focus, so this is
 * the only record of where the keyboard is. Reset every time the menu closes, so
 * reopening always starts from nothing rather than from a stale position in a
 * list that may have been rebuilt.
 *
 * @type {number}
 */
let menuFocus = -1
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
 * Show a short-lived failure message. There is no success channel: a send that
 * worked is visible as the message appearing, and a notice saying so would be
 * one more line of chrome.
 *
 * @param {string} text - The message, or an empty string to clear it.
 * @returns {void}
 */
function say(text) {
  toast.textContent = text
  toast.hidden = text.length === 0
  if (text.length === 0) return
  // The toast is a visual flash at the bottom of the panel; a screen reader gets
  // the same sentence through the polite region.
  announce(text)
  setTimeout(() => {
    if (toast.textContent === text) {
      toast.textContent = ''
      toast.hidden = true
    }
  }, 6000)
}

/**
 * Say something to a screen reader, which cannot see the transcript.
 *
 * The panel puts everything in the transcript, and the transcript is not a live
 * region — so a question that stops a turn, or a failure, or a refusal, was
 * silent to anyone not looking at the screen. This is the announcement path.
 *
 * Re-announcing identical text is deliberate: a second approval question carrying
 * the same wording as the first is a second event, and a live region only speaks
 * when its content changes. Clearing first is what makes the repeat audible.
 *
 * @param {string} text - What to announce. Empty strings are ignored.
 * @param {{ urgent?: boolean }} [options] - `urgent` interrupts; otherwise it waits for a pause.
 * @returns {void}
 */
function announce(text, options = {}) {
  if (typeof text !== 'string' || text.length === 0) return
  const region = options.urgent === true ? announceUrgent : announcePolite
  // Write synchronously. A deferred write is not merely harder to test — a live
  // region announces on mutation, and the same sentence twice in a row is a
  // second event that a timer would let a reader miss. The clear-then-set below
  // happens in one tick and still produces the mutation that fires it.
  if (region.textContent === text) region.textContent = ''
  region.textContent = text
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
 * Show or hide the surface for a panel that cannot work at all.
 *
 * With no host there is nothing to read, nothing to send and no error to report,
 * so the panel looked broken: a blank transcript and a dead send button. The one
 * line that said so used to be an eleven-pixel grey footnote under the content,
 * which is where a footnote belongs rather than an explanation of why nothing
 * works — the empty region above it is the largest thing on screen and said
 * nothing at all. This is the shape the original uses for the same moment: a
 * title, the sentence that says what to do, and the button that does it.
 *
 * It clears itself on the next successful request, so it is a state and never a
 * warning to dismiss.
 *
 * @returns {void}
 */
function renderOffline() {
  const blocked = !hostReachable
  surface.hidden = !blocked
  if (!blocked) return
  // The retry is the panel's whole startup, so it is the same work the first
  // load did rather than a second, thinner path that could drift from it.
  blockedAction.disabled = retrying
  blockedAction.textContent = retrying ? t('blocked.retrying') : t('blocked.retry')
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
  const label = !hostReachable
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
  modelMenu.replaceChildren()
  const { error, efforts, groups: modelGroups } = modelMenuModel(catalog, currentModel())
  // The menu is rebuilt from scratch, so any highlight from a previous open now
  // points at a node that is gone.
  menuFocus = -1

  if (error.length > 0) {
    const note = document.createElement('p')
    note.className = 'menu-note'
    // The code is the module's; the sentence and the host's reason are ours to show.
    note.textContent = catalogReason.length > 0
      ? `${t('model.unavailable')}：${catalogReason}`
      : t('model.unavailable')
    modelMenu.append(note)
    return
  }

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
      button.textContent = effort.label || t('model.default')
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
 * @param {boolean} [next] - The state to force; omitted toggles it.
 * @returns {void}
 */
function setMenu(next) {
  const open = next ?? !menuOpen
  if (open === menuOpen) return
  menuOpen = open
  modelButton.setAttribute('aria-expanded', String(open))
  modelMenu.hidden = !open
  if (!open) {
    menuFocus = -1
    // The pointer into the menu has to go with it. Leaving it set means the
    // trigger names an option id that is no longer in the DOM, which a screen
    // reader reports as a broken relationship.
    modelButton.removeAttribute('aria-activedescendant')
    return
  }
  if (catalog === null) refreshCatalog().catch(() => {})
  drawModelMenu()
  positionMenu()
}

/**
 * The options the picker is currently offering, in the order they are drawn.
 *
 * The effort chips and the models are one flat list, because that is how the
 * arrow keys should walk it: the panel draws a single popover rather than the
 * two-pane drill-down the harness's own selector uses, so up/down has to cross
 * both sections in the order they appear on screen.
 *
 * @returns {HTMLButtonElement[]} The focusable options.
 */
function menuOptions() {
  return [...modelMenu.querySelectorAll('button')]
}

/**
 * Paint the highlight without moving DOM focus.
 *
 * Focus stays on the trigger: moving it into the menu would fight the document's
 * click-away handler and, in a side panel, would scroll the conversation. The
 * options are marked with `aria-selected` and a class instead, which is what the
 * `@` menu does for the same reason.
 *
 * @param {number} index - Which option to mark, or -1 for none.
 * @returns {void}
 */
function paintMenuFocus(index) {
  const options = menuOptions()
  menuFocus = index >= 0 && index < options.length ? index : -1
  for (const [at, node] of options.entries()) {
    node.setAttribute('aria-selected', String(at === menuFocus))
    node.dataset.focused = at === menuFocus ? 'true' : 'false'
  }
  // Focus never leaves the trigger, so the option the keyboard is on has to be
  // announced through the trigger: without this a screen reader reads the button
  // and never learns that the arrow keys moved anything.
  const active = options[menuFocus]
  if (active !== undefined) {
    if (active.id === '') active.id = `model-option-${menuFocus}`
    modelButton.setAttribute('aria-activedescendant', active.id)
    active.scrollIntoView({ block: 'nearest' })
  } else {
    modelButton.removeAttribute('aria-activedescendant')
  }
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
    const note = document.createElement('p')
    note.className = 'at-empty'
    note.textContent = state === 'empty' ? t('at.empty') : t('at.none')
    atMenu.append(note)
    atMenu.hidden = false
    return
  }

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
  drafts.set(currentSessionId, input.value)
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
    say(t('model.failed', { reason: t('context.offline') }))
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

  if (!bridgeConnected && hostReachable) {
    // Why it is offline, and a way to act on it — shown beside the site chip
    // rather than instead of it, because "which page is in front" and "is the
    // bridge attached" are two different facts and the reader may want either.
    //
    // The chip used to be the site chip, recoloured red and relabelled 「未连接」,
    // which made three different problems identical: no token saved, a host that
    // is not running, and a worker that has not woken up. The first is fixed in
    // the options page, the second by starting dsh web, the third by waiting a
    // second — so the panel asks the worker which one it is and offers the one
    // action that applies.
    //
    // Only while the host is reachable: a host that is down already has its own
    // blocked surface with a retry, and two retry buttons for one problem is
    // worse than one.
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'chip'
    chip.id = 'bridge-chip'
    chip.dataset.warn = 'true'
    chip.textContent = bridgeReason === 'no-token' ? t('bridge.noToken') : t('context.offline')
    chip.title = t('bridge.fix')
    chip.setAttribute('aria-label', chip.title)
    chip.disabled = retryingBridge
    chip.addEventListener('click', () => retryBridge())
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
 * Render one transcript row.
 *
 * @param {object} row - A row from the host's `messages` action.
 * @param {number} index - Its position, which is the identity of an expanded reasoning row.
 * @returns {HTMLElement} The node.
 */
function renderRow(row, index) {
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
    answer.append(renderMarkdown(document, row.text, { copy: t('action.copy'), copyCode: t('action.copyCode') }))
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
    // The visible word is the same on both copy buttons — one per code block, one
    // per answer — and Chrome's accessibility tree reported two controls named
    // exactly 「复制」 in one conversation. A screen reader user hears the same
    // label twice with nothing to tell them apart, so the accessible name says
    // which one it is while the drawn label stays short.
    copy.textContent = t('action.copy')
    copy.setAttribute('aria-label', t('action.copyAnswer'))
    copy.title = t('action.copyAnswer')
    actions.append(copy)
    wrapper.append(actions)
    return wrapper
  }

  if (row.kind === 'reasoning') {
    const wrapper = document.createElement('div')
    wrapper.className = 'reasoning'
    const open = expandedReasoning.has(index)
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'reasoning-toggle'
    // The glyph is drawn, not spoken. As text it became part of the button's
    // accessible name — a screen reader read 「思考 ⌄」, pronouncing a decoration —
    // and this is the shape the rest of the panel already uses for its other
    // arrows (`#new` is 「＋」 with an `aria-label`, `#to-bottom` likewise).
    const label = document.createElement('span')
    label.textContent = t('row.reasoning')
    const caret = document.createElement('span')
    caret.className = 'caret'
    caret.setAttribute('aria-hidden', 'true')
    caret.textContent = open ? '⌃' : '⌄'
    toggle.append(label, caret)
    toggle.setAttribute('aria-expanded', String(open))
    wrapper.append(toggle)
    if (open) {
      const body = document.createElement('div')
      body.className = 'reasoning-body'
      body.textContent = row.text
      wrapper.append(body)
    }
    toggle.addEventListener('click', () => {
      if (expandedReasoning.has(index)) expandedReasoning.delete(index)
      else expandedReasoning.add(index)
      drawTranscript(rows)
    })
    return wrapper
  }

  if (row.kind === 'tool') {
    const wrapper = document.createElement('div')
    wrapper.className = 'row'
    wrapper.dataset.kind = 'tool'
    const line = document.createElement('div')
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
    wrapper.append(line)
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
  // Write the sentence here rather than printing the host's.
  //
  // `row.text` is the host's English summary — 「selected text from
  // dl.acm.org, 5 chars」 — and it was rendered verbatim after 「已附带 · 」,
  // so the one line explaining what had been attached was in a language the
  // rest of the panel does not use. The host now sends the facts and this
  // reads them; a row with no facts (an older host, or another plugin using
  // the same id) still has `row.text` and still renders.
  //
  // The three literals are written out rather than looked up in a table
  // because `panel-i18n.test.js` proves there are no dead dictionary entries by
  // matching literal translation calls — a key reached through a variable reads
  // as unreferenced. That test caught this exact thing, and it also reads
  // comments, so this one names no keys.
  const what = row.attach === 'selection'
    ? t('attached.selection')
    : row.attach === 'page'
      ? t('attached.page')
      : row.attach === 'tab'
        ? t('attached.tab')
        : ''
  const parts = what.length > 0 ? [what] : []
  if (parts.length > 0 && typeof row.host === 'string' && row.host.length > 0) {
    parts.push(t('attached.from', { host: row.host }))
  }
  if (parts.length > 0 && Number.isFinite(row.chars) && row.chars > 0) {
    parts.push(t('attached.chars', { count: row.chars }))
  }
  const sentence = parts.length > 0 ? parts.join(' · ') : row.text
  notice.textContent = `${t('row.context')} · ${sentence}`
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
  toBottom.hidden = view !== 'chat' || stickToBottom || transcript.scrollHeight <= transcript.clientHeight
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
  const signature = JSON.stringify(next) + JSON.stringify([...expandedReasoning])
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
  const fragment = document.createDocumentFragment()
  next.forEach((row, index) => fragment.append(renderRow(row, index)))

  transcript.replaceChildren(fragment)
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
 * Which sentence describes a sensitive action.
 *
 * `classifySensitivity` (`lib/grants.js`) sorts these into three kinds and the
 * host now forwards which one fired, because one generic line would misdescribe
 * two of them: "runs code in the page" is not "spends money", and the person
 * deciding needs the one that is true.
 *
 * Matched on the host's own wording, with the generic sentence as the fallback
 * rather than a guess: an unrecognised reason is a new kind, and claiming it
 * spends money would be worse than saying less.
 *
 * @param {unknown} reason - The host's `sensitivity.reason`.
 * @returns {string} The sentence, already translated.
 */
function sensitiveKey(reason) {
  // Read through the translator at each site rather than returning a key for the
  // caller to translate: the dead-key check in `panel-i18n.test.js` looks for
  // translator call sites, so a key reached only through a returned string looks
  // unused and the dictionary entry would be deleted as dead weight while still
  // in use.
  if (typeof reason === 'string') {
    if (reason.includes('uploads a file')) return t('approval.uploads')
    if (reason.includes('runs code in the page')) return t('approval.runsCode')
    if (reason.includes('submits or spends') || reason.includes('types into a control')) return t('approval.spends')
  }
  return t('approval.sensitive')
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
  const key = `${pendingApproval.id}:${answering}:${pendingApproval.site ?? ''}:${pendingApproval.sensitive === true}:${pendingApproval.sensitiveReason ?? ''}:${pendingApproval.rememberable === false}:${pendingApproval.reason ?? ''}`

  // Announced before the redraw guard below, which returns early when the card is
  // already drawn. Placing this after that guard meant the question was announced
  // only on the draw that happened to win: a question redrawn with more facts, or
  // re-delivered by the health poll, stayed silent — and the guard is exactly the
  // case that fires most often, because the poll and the notification race.
  const site = typeof pendingApproval.site === 'string' ? pendingApproval.site : ''
  const tool = pendingApproval.toolName === 'a tool' ? t('approval.aTool') : pendingApproval.toolName
  const sentence = site.length > 0
    ? t('approval.wantsSite', { tool, site })
    : t('approval.wants', { tool })
  // A turn is blocked until this is answered, so it interrupts rather than
  // waiting for a pause. Without this the panel said nothing at all: the card
  // appears in the transcript, which is not a live region.
  announce(`${t('approval.asking')}：${sentence}`, { urgent: true })

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
  what.textContent = sentence
  card.append(what)

  // Its own row rather than a line inside the sentence: nesting it would make
  // `approval-what` read as 「要在 … 上使用 browser_click 这一步会改动页面或花钱」,
  // one run-on sentence doing two jobs.
  if (pendingApproval.sensitive === true) {
    const warn = document.createElement('div')
    warn.className = 'approval-note'
    warn.textContent = sensitiveKey(pendingApproval.sensitiveReason)
    card.append(warn)
  }
  // Said once, where the missing button would have been: otherwise a card with
  // one fewer answer reads as a rendering fault rather than as a rule. Shown
  // alongside the sensitive note rather than instead of it — for `browser_eval`
  // both are true, and they answer different questions ("why is this serious"
  // versus "why can I not just allow it for the session").
  if (pendingApproval.rememberable === false) {
    const note = document.createElement('div')
    note.className = 'approval-note'
    note.textContent = t('approval.eachTime')
    card.append(note)
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
  // The session button is withheld where the host cannot remember a grant: three
  // tools re-ask by design (eval, CDP, upload) and a sensitive action is a second
  // question inside an approved site by design. Offering it there was the same
  // defect as a 「允许一次」 that lasted a session — the button promising more
  // than the host will do. The fact comes from the asking tool.
  const rememberable = pendingApproval.rememberable !== false
  const allow = document.createElement('button')
  allow.type = 'button'
  allow.className = 'approval-allow'
  allow.textContent = rememberable ? t('approval.allow') : t('approval.once')
  allow.disabled = answering
  allow.addEventListener('click', () => answerApproval('allowed-once', rememberable ? 'conversation' : 'once'))
  const reject = document.createElement('button')
  reject.type = 'button'
  reject.className = 'approval-reject'
  reject.textContent = t('approval.reject')
  reject.disabled = answering
  reject.addEventListener('click', () => answerApproval('rejected'))
  if (rememberable) actions.append(once, allow, reject)
  else actions.append(allow, reject)
  card.append(actions)

  transcript.append(card)
  if (stickToBottom) transcript.scrollTop = transcript.scrollHeight
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
  if (live === null) return

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
  drawSend()
  renderWorking()
}

/**
 * Switch between the conversation and the history.
 * @param {'chat'|'history'} next - The view to show.
 * @returns {void}
 */
function showView(next) {
  const was = document.activeElement
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
  // The control that was pressed has just hidden itself — the header swaps
  // between the title button and the back button — so the browser drops focus to
  // <body> and the next Tab restarts from the top of the panel. Measured in a
  // real browser: `before: active=title`, then `after: active=BODY`.
  //
  // Read back from the browser rather than guessing which case applies: an
  // element hides itself directly, but a history row is taken away by its
  // container, and both lose focus the same way. Asking `document.activeElement`
  // covers each without enumerating them.
  if (was !== null && was !== document.body && document.activeElement === document.body) {
    const fallback = next === 'history' ? backButton : titleButton
    if (fallback !== undefined && fallback.hidden !== true) fallback.focus()
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
  // The host can only say *whether* the extension is attached. Why it is not is
  // knowledge the worker holds, so the panel asks it directly — one round trip
  // through the extension's own message channel, no network.
  bridgeReason = bridgeConnected ? '' : await askBridgeReason()
  // Kept, not just used: a question reported while the history was open has to
  // be adoptable the moment the conversation comes back, and the next poll can
  // be five seconds away.
  lastHealth = payload ?? null
  adoptOpenApproval(payload)
  renderContexts()
  drawSend()
}

/**
 * Ask the worker why the bridge is not up.
 *
 * Returns `''` when it cannot be asked at all, which is itself a state: with no
 * service worker to answer, the chip falls back to the plain 「未连接」 rather
 * than inventing a reason. `chrome.runtime.sendMessage` rejects when there is
 * nothing listening, and a worker that is merely asleep is woken by the call —
 * so this doubles as the cheapest possible reconnect attempt.
 *
 * @returns {Promise<string>} `'no-token'`, `'connecting'`, `'refused'`, or `''`.
 */
async function askBridgeReason() {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'dsh-bridge-state' })
    return typeof state?.state?.reason === 'string' ? state.state.reason : ''
  } catch {
    return ''
  }
}

/**
 * Press the chip: ask the worker to connect now, and report what came back.
 *
 * Nothing here opens a socket — the panel cannot, because the socket belongs to
 * the worker. So the button is a request and the honest answer is the state
 * afterwards, which is what the chip redraws.
 *
 * @returns {Promise<void>} Resolves once the state has been re-read.
 */
async function retryBridge() {
  if (retryingBridge) return
  retryingBridge = true
  renderContexts()
  try {
    const result = await chrome.runtime.sendMessage({ type: 'dsh-bridge-retry' })
    const reason = typeof result?.state?.reason === 'string' ? result.state.reason : ''
    if (reason === 'no-token') {
      // The one case with a real destination: the token is pasted in the options
      // page, so send them there rather than telling them to find it.
      chrome.runtime.openOptionsPage()
    } else if (result?.state?.open !== true) {
      say(t('error.bridgeRefused', { reason: result?.state?.detail || t('context.offline') }))
    }
  } catch (error) {
    say(t('error.bridgeRefused', { reason: error?.message ?? String(error) }))
  } finally {
    retryingBridge = false
    // The host's own view is the authority on `connected`, so re-read it rather
    // than trusting the worker's answer twice.
    await refreshHealth().catch(() => {})
    renderContexts()
  }
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
    ...(typeof entry.sensitiveReason === 'string' ? { sensitiveReason: entry.sensitiveReason } : {}),
    // Explicitly false only: a question that does not say is not claiming the
    // button is unavailable.
    ...(entry.rememberable === false ? { rememberable: false } : {}),
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
  setHostReachable(status !== 0)

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
    drafts.set(currentSessionId, input.value)
    currentSessionId = sessionId
    expandedReasoning.clear()
    drawnSignature = ''
    transcript.replaceChildren()
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
  const result = await bridge('/browser-bridge/chat', {
    method: 'POST',
    body: { action: 'send', sessionId: currentSessionId, text, attachments: pendingAttachments() },
  })
  if (result.payload?.accepted === true) {
    input.value = ''
    input.style.height = 'auto'
    drafts.delete(currentSessionId)
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
  try {
    await createSession()
  } finally {
    creating = false
    drawNew()
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
  drafts.set(currentSessionId, input.value)
  currentSessionId = result.payload.sessionId
  expandedReasoning.clear()
  drawnSignature = ''
  rows = []
  transcript.replaceChildren()
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

modelButton.addEventListener('click', (event) => {
  // The document listener below closes the picker on any outside click, and
  // without stopping here the click that opens it would be the one that shuts
  // it. Clicks inside the menu stop at the menu for the same reason.
  event.stopPropagation()
  setMenu()
})

/**
 * Walk the picker with the keyboard.
 *
 * The options have always declared `role="menuitemradio"` and `role="radio"`,
 * which is a promise that the arrow keys work — a screen reader announces a radio
 * group and then no key moves within it. Only Escape was handled, so the roles
 * described a menu that the keyboard could not actually use.
 *
 * The trigger keeps DOM focus and the highlight is painted onto the options.
 * Moving real focus into the menu would hand it to the document's click-away
 * handler and, in a side panel, would scroll the conversation out from under the
 * reader.
 *
 * @param {KeyboardEvent} event - The key.
 * @returns {void}
 */
modelButton.addEventListener('keydown', (event) => {
  const options = menuOpen ? menuOptions() : []
  if (event.key === 'Escape' && menuOpen) {
    event.preventDefault()
    setMenu(false)
    return
  }
  // Alt+ArrowDown opens, matching the ARIA menu-button pattern; ArrowDown alone
  // does it too, because in a one-control composer there is nothing else the key
  // could mean.
  if (event.key === 'ArrowDown' && !menuOpen) {
    event.preventDefault()
    setMenu(true)
    paintMenuFocus(0)
    return
  }
  if (event.key === 'ArrowUp' && !menuOpen) {
    event.preventDefault()
    setMenu(true)
    paintMenuFocus(options.length - 1)
    return
  }
  if (!menuOpen || options.length === 0) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const step = event.key === 'ArrowDown' ? 1 : -1
    // From "nothing chosen", either direction enters the list at its own end.
    const from = menuFocus === -1 ? (step === 1 ? -1 : 0) : menuFocus
    paintMenuFocus((from + step + options.length) % options.length)
    return
  }
  if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault()
    paintMenuFocus(event.key === 'Home' ? 0 : options.length - 1)
    return
  }
  if (event.key === 'Enter' || event.key === ' ') {
    const chosen = options[menuFocus]
    if (chosen === undefined) return
    event.preventDefault()
    chosen.click()
  }
})

modelMenu.addEventListener('click', (event) => {
  event.stopPropagation()
})

document.addEventListener('click', () => {
  setMenu(false)
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setMenu(false)
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
  drafts.set(currentSessionId, input.value)
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

/** Start the panel and keep the slow-moving parts fresh. */
async function start() {
  paintStaticCopy()
  await loadEverything()
  await requestSelectionFromPage().catch(() => {})
  blockedAction.addEventListener('click', () => {
    retry().catch(() => {})
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
