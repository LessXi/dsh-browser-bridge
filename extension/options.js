/**
 * Options page behaviour: read and write connection settings, and probe the
 * harness so a wrong token is reported here rather than discovered mid-task.
 *
 * The page's copy comes from `locales.js` rather than from the markup, and it is
 * written into every element carrying `data-i18n` before anything else runs — so
 * a language that is missing a key shows English rather than an empty box, and
 * the failure mode of a forgotten key is visible rather than silent.
 *
 * @module extension/options
 */

import { fetchBridgeToken } from './bootstrap.js'
import { optionsTranslator, pickLocale } from './locales.js'

// `chrome.i18n.getUILanguage()` is the browser's own language, which is what a
// settings page should follow: it is not the panel. Someone reading the security
// warning below should read it in the language they read everything else in.
const locale = pickLocale(
  globalThis.chrome?.i18n?.getUILanguage?.() ?? globalThis.navigator?.language ?? 'en',
)
const say = optionsTranslator(locale)

/** Fill every element that names a key, before the page can be read. */
function paint() {
  for (const node of document.querySelectorAll('[data-i18n]')) {
    const key = node.dataset.i18n
    if (typeof key !== 'string' || key.length === 0) continue
    node.textContent = say(key)
  }
  document.documentElement.lang = locale === 'zh' ? 'zh' : 'en'
}

paint()

const portInput = document.getElementById('port')
const tokenInput = document.getElementById('token')
const revealButton = document.getElementById('reveal')
const shapeNote = document.getElementById('shape')
const autoPushInput = document.getElementById('autopush')
const result = document.getElementById('result')
const saveButton = document.getElementById('save')
const testButton = document.getElementById('test')
const refetchButton = document.getElementById('refetch')

/**
 * The token's real length, as the harness mints it.
 *
 * `lib/token.js` builds it from `randomBytes(32).toString('hex')`, so it is
 * always 64 characters. The host also reports `tokenLength` on its health route,
 * and the panel could adopt that; this page does not depend on the harness being
 * reachable, because the moment someone needs this hint is the moment the
 * connection is failing.
 */
const TOKEN_LENGTH = 64

/**
 * Say whether the pasted token has the right shape.
 *
 * The field is a password input by design — a token on screen in a shared window
 * is a credential on screen — but that leaves someone who pasted half of one
 * with no feedback at all: the connection fails and the message blames the
 * harness. Reporting the shape is the cheapest way to turn that into "the paste
 * was truncated", and it is deliberately advisory: this checks the *shape*, not
 * whether the harness accepts it, which is what the connection test is for.
 *
 * Lowercase only, and that is not pedantry: `lib/token.js` mints the token with
 * `randomBytes(32).toString('hex')`, which never produces uppercase, and the host
 * compares it byte for byte. A 64-character string of uppercase letters is
 * therefore never a token — it is what a copy from the wrong field looks like —
 * and accepting it was a bug this check had until a probe caught it.
 *
 * @returns {void}
 */
function reportShape() {
  const value = tokenInput.value.trim()
  // Nothing typed yet is not a mistake, and an empty field with a red note under
  // it would greet every first visit with an error.
  if (value.length === 0) {
    shapeNote.hidden = true
    shapeNote.textContent = ''
    shapeNote.removeAttribute('data-state')
    return
  }
  const correct = value.length === TOKEN_LENGTH && /^[0-9a-f]+$/.test(value)
  shapeNote.hidden = false
  shapeNote.dataset.state = correct ? 'good' : 'bad'
  // The length is appended only when it disagrees, so the reader sees one number
  // and it is the one that is wrong.
  shapeNote.textContent = correct
    ? say('tokenShape', { length: TOKEN_LENGTH })
    : `${say('tokenShapeWrong', { length: TOKEN_LENGTH })} (${value.length})`
}

/**
 * Show or hide the token.
 *
 * `aria-pressed` rather than a changing label alone: the label says what the
 * button will do, and the pressed state says what the field currently is, which
 * is the pair a screen reader needs to describe one control with two states.
 *
 * Both labels are named literally rather than picked by a ternary inside the
 * `say` call. The dictionary test scans for `say('key')` to prove no entry is
 * dead weight, and a computed key is invisible to it — the suite caught exactly
 * that, reporting `tokenHide` as defined and never drawn.
 *
 * @returns {void}
 */
function toggleReveal() {
  const revealed = tokenInput.type === 'text'
  tokenInput.type = revealed ? 'password' : 'text'
  revealButton.textContent = revealed ? say('tokenShow') : say('tokenHide')
  revealButton.setAttribute('aria-pressed', String(!revealed))
}

revealButton.addEventListener('click', toggleReveal)
tokenInput.addEventListener('input', () => {
  // A real keystroke or paste, which is the only thing that makes this field a
  // manual override. See `tokenEdited`.
  tokenEdited = true
  reportShape()
})

/**
 * Show one message in the result strip.
 * @param {string} text - The message.
 * @param {'ok' | 'bad' | 'busy'} state - How to style it.
 */
function show(text, state = 'busy') {
  result.hidden = false
  result.textContent = text
  if (state === 'busy') result.removeAttribute('data-state')
  else result.dataset.state = state
}

/** Load saved settings into the form. */
async function load() {
  const stored = await chrome.storage.local.get({ port: '3080', token: '', autoPushSelection: false })
  portInput.value = String(stored.port)
  tokenInput.value = String(stored.token)
  autoPushInput.checked = stored.autoPushSelection === true
  // Showing the stored token is not the same as someone typing one. Without
  // this, a fetched token would be written into the field, read back as
  // non-empty, and recorded as a manual override on the next save — so merely
  // pressing Connect once would silently pin the value, and a harness that later
  // reissued its token would leave the extension connecting with a stale one and
  // no way to notice.
  tokenEdited = false
}

/**
 * Whether a person has touched the token field since the page loaded.
 *
 * The distinction this carries is "a value is in the box" versus "a person put
 * it there". Only the second is a manual override: the field is also where a
 * fetched token is displayed, and treating that as deliberate would pin the
 * first token the page ever saw.
 *
 * @type {boolean}
 */
let tokenEdited = false

/**
 * Persist the form.
 *
 * An empty token field is a *choice*, not an omission: it means "get it from the
 * harness", and it is recorded as such so the service worker's own enrolment
 * does not fight the person. A field someone actually edited is a manual
 * override, and `manualToken` is what stops a later automatic attempt from
 * replacing a value they deliberately set.
 *
 * @returns {Promise<{ port: string, token: string, autoPushSelection: boolean, manualToken: boolean }>} What was saved.
 */
async function save() {
  const typed = tokenInput.value.trim()
  const settings = {
    port: String(portInput.value || '3080').trim(),
    token: typed,
    // `tokenEdited` rather than `typed.length > 0`: clearing a fetched token to
    // disconnect is also an edit, and it has to stick.
    manualToken: tokenEdited,
    autoPushSelection: autoPushInput.checked,
  }
  await chrome.storage.local.set(settings)
  return settings
}

/**
 * Produce a token for the probe: the typed one when there is one, otherwise ask
 * the harness.
 *
 * Without this, an empty field meant the page could only say "no token saved"
 * and hand the person back to the copy-and-paste it exists to remove. The
 * harness serves the token on loopback for exactly this purpose, and the
 * settings page is the place that should notice it is available.
 *
 * @param {{ port: string, token: string }} settings - What the form holds.
 * @returns {Promise<string>} The token, or an empty string when none could be had.
 */
async function tokenFor(settings) {
  if (settings.token.length > 0) return settings.token

  show(say('tokenFetching'))
  const outcome = await fetchBridgeToken(settings.port)
  if (outcome.ok !== true) {
    // One remedy per sentence, picked by what actually happened. A single
    // "could not get the token" would send the reader to check a stopped
    // harness, a switched-off bridge and a malformed answer all at once, when
    // this page already knows which of the three it is.
    //
    // Written as a branch chain rather than a lookup table because the
    // dictionary test finds a key by scanning for `say('key')` — a table of
    // key names is invisible to it, and these three would read as entries
    // defined and never drawn.
    if (outcome.reason === 'unreachable') show(say('tokenFetchNoHarness', { port: settings.port }), 'bad')
    else if (outcome.reason === 'disabled') show(say('tokenFetchOff'), 'bad')
    else show(say('tokenFetchMalformed'), 'bad')
    return ''
  }

  await chrome.storage.local.set({ token: outcome.token, manualToken: false })
  // Written into the field so the page shows what is actually in use, rather
  // than reporting a success above an empty box.
  tokenInput.value = outcome.token
  reportShape()
  show(say('tokenFetched'), 'ok')
  return outcome.token
}

/**
 * Whether anything at all is listening on the harness port.
 *
 * The WebSocket API does not expose *why* a connection failed. A token the
 * harness rejected and a harness that is not running both arrive as a bare
 * `error` event followed by `close` with code 1006 — one signal, two problems
 * with opposite remedies. The page used to tell everyone to go check whether
 * `dsh web` is running, which is the wrong instruction for a stale token, and
 * the branch that said "your token was refused" was unreachable because
 * `error` always beats `close` and the first result wins.
 *
 * A `no-cors` fetch separates the two cases. It is deliberately opaque: the
 * only fact used is that *something* answered. That keeps the harness from
 * needing a CORS header, which matters — the health response carries harness
 * state, and this page has no business reading it.
 *
 * @param {string} port - The port to probe.
 * @returns {Promise<boolean>} True when a server answered, whatever it said.
 */
async function portAnswers(port) {
  // Resolved at call time rather than captured at module load, the same way the
  // panel reaches for `globalThis.navigator?.clipboard`. A `fetch` captured at
  // load would keep pointing at whatever was global when this module was first
  // imported, which is stale in a re-imported context and is not something the
  // caller can see.
  const ask = globalThis.fetch
  if (typeof ask !== 'function') return false
  try {
    await ask(`http://127.0.0.1:${port}/browser-bridge/health`, {
      mode: 'no-cors',
      cache: 'no-store',
    })
    return true
  } catch {
    return false
  }
}

/**
 * Probe the harness websocket with the saved token.
 *
 * A successful upgrade and an immediate clean close is the pass condition: the
 * harness answers a bad token with HTTP 401 before the upgrade completes, which
 * the browser surfaces as a failed connection rather than a protocol error.
 *
 * @param {{ port: string, token: string }} settings - What to probe with.
 * @returns {Promise<{ ok: boolean, detail: string }>} The outcome.
 */
function probe(settings) {
  return new Promise((resolve) => {
    if (settings.token.length === 0) {
      resolve({ ok: false, detail: say('noToken') })
      return
    }
    const url = `ws://127.0.0.1:${settings.port}/api/browser-bridge/ws?token=${encodeURIComponent(settings.token)}`
    let settled = false
    /** @type {WebSocket | undefined} */
    let socket

    const finish = (value) => {
      if (settled) return
      settled = true
      try {
        socket?.close()
      } catch {
        // Closing an already-failed socket is not an error.
      }
      resolve(value)
    }

    try {
      socket = new WebSocket(url)
    } catch (error) {
      resolve({ ok: false, detail: say('socketFailed', { reason: error.message }) })
      return
    }

    socket.addEventListener('open', () => {
      finish({ ok: true, detail: say('connected', { port: settings.port }) })
    })
    socket.addEventListener('error', () => {
      // The socket event says only "that failed", so ask the port whether there
      // was a listener behind the failure. Nothing listening means there was
      // nothing to reject the token, so the harness is the problem; something
      // listening means it answered and rejected what we sent.
      portAnswers(settings.port).then((answered) => {
        // One line per remedy, joined by newlines: the strip is `white-space:
        // pre-wrap`, so this is a list rather than one run-on sentence. Which
        // remedies are listed depends on the branch — "is dsh web running" is
        // already answered once we know a port answered, and offering it there
        // would send the reader to check a thing that is demonstrably fine.
        const remedies = answered
          ? [say('check2'), say('check3')]
          : [say('check1'), say('check2'), say('check3')]
        finish({
          ok: false,
          detail: [
            answered ? say('refused') : say('cannotConnect', { port: settings.port }),
            say('checkIntro'),
            ...remedies.map((line) => `  • ${line}`),
          ].join('\n'),
        })
      })
    })
    socket.addEventListener('close', (event) => {
      if (event.code === 1006) {
        // Reached only when the socket failed without an `error` event, which
        // the browser may do. Same discrimination, same reason.
        portAnswers(settings.port).then((answered) => {
          finish({ ok: false, detail: answered ? say('refused') : say('cannotConnect', { port: settings.port }) })
        })
      }
    })
    setTimeout(() => finish({ ok: false, detail: say('timeout') }), 8000)
  })
}

saveButton.addEventListener('click', async () => {
  const settings = await save()
  const token = await tokenFor(settings)
  if (token.length === 0) return
  show(say('saved'))
  const outcome = await probe({ ...settings, token })
  show(outcome.detail, outcome.ok ? 'ok' : 'bad')
})

testButton.addEventListener('click', async () => {
  const settings = await save()
  const token = await tokenFor(settings)
  if (token.length === 0) return
  show(say('testing'))
  const outcome = await probe({ ...settings, token })
  show(outcome.detail, outcome.ok ? 'ok' : 'bad')
})

/**
 * Fetch the token on demand and put it in the field.
 *
 * The same action the first run performs, offered as a button for the case that
 * actually happens: someone pasted a token, the harness was reinstalled or its
 * home moved, and the token on file is now stale. Before this, their only route
 * back was to clear the field, find the settings card, and copy again.
 */
refetchButton.addEventListener('click', async () => {
  // Cleared first, because `tokenFor` treats a filled field as a manual
  // override — and the entire point of this button is to override that.
  tokenInput.value = ''
  // The clearing above is the page's doing, not the person's, so the flag is set
  // explicitly rather than left to the `input` listener — assigning `.value` from
  // script fires no event, and a lingering `true` here would record the fetched
  // token as a manual one, which is the exact opposite of what this button does.
  tokenEdited = false
  reportShape()
  const settings = await save()
  await tokenFor(settings)
})

load().catch((error) => show(say('loadFailed', { reason: error.message }), 'bad'))
