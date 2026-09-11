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
 *   - **No streaming.** The transcript is re-read after a send and on a slow
 *     poll while a turn runs. Streaming would need a second protocol for
 *     marginal benefit in a panel this size, and a wrong guess about the event
 *     shape would be worse than a short delay.
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
import { renderMarkdown } from './markdown.js'

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

const backButton = document.getElementById('back')
const titleButton = document.getElementById('title')
const titleText = document.getElementById('title-text')
const newButton = document.getElementById('new')
const transcript = document.getElementById('transcript')
const history = document.getElementById('history')
const toBottom = document.getElementById('to-bottom')
const toast = document.getElementById('toast')
const contexts = document.getElementById('contexts')
const input = document.getElementById('input')
const sendButton = document.getElementById('send')
const modelButton = document.getElementById('model')
const modelText = document.getElementById('model-text')
const modelMenu = document.getElementById('model-menu')

/** @type {{ text: string, url: string, title: string }} */
let currentSelection = { text: '', url: '', title: '' }
/** @type {{ id?: number, url: string, title: string }} */
let currentTab = { url: '', title: '' }
/** Tabs the bridge has grouped, listed in the history view. */
let controlledTabs = []
/** Whether the harness answered at all, and whether the extension is attached to it. */
let hostReachable = false
let bridgeConnected = false
/** Whether the host answered, but with a shape this panel does not understand. */
let hostStale = false
/** Whether the shown selection should travel with the next send. */
let selectionAttached = false
/** Port of the running harness, mirrored from the options page. */
let harnessPort = '3080'
/** True while a send is in flight, so the poll does not fight the button. */
let sending = false
/** `'chat'` or `'history'`. */
let view = 'chat'

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
  setTimeout(() => {
    if (toast.textContent === text) {
      toast.textContent = ''
      toast.hidden = true
    }
  }, 6000)
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
  sendButton.textContent = '↑'
  sendButton.title = t('action.send.title')
  sendButton.setAttribute('aria-label', t('action.send'))
  modelButton.setAttribute('aria-label', t('model.select'))
  document.title = t('panel.title')
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
  const label = currentSessionId.length === 0
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
  const shown = label.length > 0 ? label : t('model.unavailable')
  modelText.textContent = shown
  modelButton.title = shown
  modelButton.disabled = currentSessionId.length === 0
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
  if (!open) return
  if (catalog === null) refreshCatalog().catch(() => {})
  drawModelMenu()
  positionMenu()
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
  const chips = []

  if (currentTab.url.length > 0) {
    const chip = document.createElement('span')
    chip.className = 'chip'
    if (!bridgeConnected) chip.dataset.warn = 'true'
    const label = document.createElement('span')
    label.className = 'label'
    const title = currentTab.title || currentTab.url
    label.textContent = bridgeConnected
      ? `${t('context.tab')} · ${title}`
      : t('context.offline')
    chip.title = bridgeConnected ? title : t('context.offline')
    chip.append(label)
    chips.push(chip)
  }

  if (selectionAttached && currentSelection.text.length > 0) {
    const chip = document.createElement('span')
    chip.className = 'chip'
    // Styled as an active decision rather than another fact: this is the one
    // line in the panel that answers "will my highlight be sent?".
    chip.dataset.attached = 'true'
    const label = document.createElement('span')
    label.className = 'label'
    const text = currentSelection.text
    label.textContent = `${t('context.selection')} · ${text.length > 40 ? `${text.slice(0, 39)}…` : text}`
    const drop = document.createElement('button')
    drop.type = 'button'
    drop.textContent = '×'
    drop.title = t('action.drop')
    drop.setAttribute('aria-label', t('action.drop'))
    drop.addEventListener('click', () => {
      selectionAttached = false
      renderContexts()
    })
    chip.append(label, drop)
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
    answer.append(renderMarkdown(document, row.text))
    wrapper.append(answer)
    return wrapper
  }

  if (row.kind === 'reasoning') {
    const wrapper = document.createElement('div')
    wrapper.className = 'reasoning'
    const open = expandedReasoning.has(index)
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
  if (signature === drawnSignature) {
    renderWorking()
    updateToBottom()
    return
  }
  drawnSignature = signature

  const keep = transcript.scrollTop
  const followed = stickToBottom
  const fragment = document.createDocumentFragment()
  next.forEach((row, index) => fragment.append(renderRow(row, index)))

  transcript.replaceChildren(fragment)
  renderWorking()

  if (followed) transcript.scrollTop = transcript.scrollHeight
  else transcript.scrollTop = keep
  stickToBottom = atBottom()
  updateToBottom()
}

/** Show the waiting row while the session has a turn in flight. */
function renderWorking() {
  const existing = transcript.querySelector('.working')
  const wanted = view === 'chat' && (currentSessionRunning || sending)
  if (!wanted) {
    existing?.remove()
    return
  }
  if (existing !== null) return
  const line = document.createElement('div')
  line.className = 'working'
  line.textContent = t('row.working')
  transcript.append(line)
  if (stickToBottom && !sending) transcript.scrollTop = transcript.scrollHeight
}

/**
 * Read the selected session's transcript.
 * @returns {Promise<void>} Resolves once the transcript is drawn.
 */
async function refreshTranscript() {
  if (currentSessionId.length === 0) {
    drawnSignature = ''
    rows = []
    transcript.replaceChildren()
    return
  }
  const { payload, status } = await bridge('/browser-bridge/chat', {
    method: 'POST',
    body: { action: 'messages', sessionId: currentSessionId, limit: 60 },
  })
  if (status === 0) {
    hostReachable = false
    renderContexts()
    return
  }
  hostReachable = true
  const messages = Array.isArray(payload?.messages) ? payload.messages : []
  const session = currentSession()
  if (session !== undefined && typeof payload?.title === 'string' && payload.title.length > 0) {
    session.title = payload.title
    renderTitle()
  }
  drawTranscript(messages)
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
  sendButton.disabled = !hostReachable || currentSessionId.length === 0
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
  if (next === 'history') drawHistory()
  updateToBottom()
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
  hostReachable = status !== 0
  bridgeConnected = hostReachable && payload?.connected === true
  renderContexts()
  sendButton.disabled = !hostReachable || currentSessionId.length === 0 || input.value.trim().length === 0
}

/**
 * Read the harness's session list and repaint.
 * @returns {Promise<void>} Resolves once the list is drawn.
 */
async function refreshGroups() {
  const stored = await chrome.storage.local.get({ port: '3080', panelSessionId: '' })
  harnessPort = String(stored.port ?? '3080')
  const { payload, status } = await bridge('/browser-bridge/chat')
  hostReachable = status !== 0

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
  sendButton.disabled = !hostReachable || currentSessionId.length === 0
}

/**
 * What travels with this send: the tab's identity always, the shown selection
 * only while it is still attached.
 *
 * @returns {object[]} Attachment inputs for the host to stage.
 */
function pendingAttachments() {
  const attachments = []
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
  sendButton.disabled = true
  stickToBottom = true
  const result = await bridge('/browser-bridge/chat', {
    method: 'POST',
    body: { action: 'send', sessionId: currentSessionId, text, attachments: pendingAttachments() },
  })
  if (result.payload?.accepted === true) {
    input.value = ''
    input.style.height = 'auto'
    drafts.delete(currentSessionId)
    // The host reports what it actually took. A refused attachment used to be
    // silent: the chip promised it, the message left without it, and the only
    // way to find out was to wonder.
    const refused = Array.isArray(result.payload?.context?.refused) ? result.payload.context.refused : []
    if (refused.length > 0) say(t('error.attachmentRefused', { reason: refused.join('; ') }))
    // The turn is running now, and the transcript has no stream to show it.
    currentSessionRunning = true
    renderWorking()
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
  sendButton.disabled = input.value.trim().length === 0
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
  let tabs = []
  try {
    tabs = await chrome.tabs.query({})
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (active !== undefined) {
      currentTab = { id: active.id, url: active.url ?? '', title: active.title ?? '' }
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
  sendMessage().catch((error) => say(t('error.generic', { reason: error.message })))
})

input.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey) return
  event.preventDefault()
  sendMessage().catch((error) => say(t('error.generic', { reason: error.message })))
})

input.addEventListener('input', () => {
  input.style.height = 'auto'
  input.style.height = `${Math.min(140, input.scrollHeight)}px`
  drafts.set(currentSessionId, input.value)
  sendButton.disabled = !hostReachable || currentSessionId.length === 0 || input.value.trim().length === 0
})

transcript.addEventListener('scroll', () => {
  stickToBottom = atBottom()
  updateToBottom()
})

toBottom.addEventListener('click', () => {
  stickToBottom = true
  transcript.scrollTop = transcript.scrollHeight
  updateToBottom()
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

  let reply
  try {
    reply = await chrome.tabs.sendMessage(tab.id, { type: 'dsh-selection-request' })
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content-selection.js'] })
      reply = await chrome.tabs.sendMessage(tab.id, { type: 'dsh-selection-request' })
    } catch {
      // A page Chrome will not let us into — a store page, a PDF viewer, an
      // internal URL. There is no selection to report and nothing to say.
      return
    }
  }
  applySelection(reply)
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'dsh-selection-changed') return false
  applySelection(message.payload ?? {})
  return false
})

/** Start the panel and keep the slow-moving parts fresh. */
async function start() {
  paintStaticCopy()
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

  // Ask the page for a selection it already holds, so the panel is not blank.
  // Ask the page for the selection it already holds, so the panel is not blank
  // until the user happens to highlight something again.
  await requestSelectionFromPage().catch(() => {})

  // Switching tabs is a new page, and with it a new selection — or none. Without
  // this the chip keeps describing the tab the panel was opened on.
  chrome.tabs.onActivated.addListener(() => {
    refreshTabs().catch(() => {})
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
