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
const autoPushInput = document.getElementById('autopush')
const result = document.getElementById('result')
const saveButton = document.getElementById('save')
const testButton = document.getElementById('test')

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
}

/**
 * Persist the form.
 * @returns {Promise<{ port: string, token: string, autoPushSelection: boolean }>} What was saved.
 */
async function save() {
  const settings = {
    port: String(portInput.value || '3080').trim(),
    token: tokenInput.value.trim(),
    autoPushSelection: autoPushInput.checked,
  }
  await chrome.storage.local.set(settings)
  return settings
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
      // One line per remedy, joined by newlines: the strip is `white-space:
      // pre-wrap`, so this is three bullets rather than one run-on sentence.
      finish({
        ok: false,
        detail: [
          say('cannotConnect', { port: settings.port }),
          say('checkIntro'),
          `  • ${say('check1')}`,
          `  • ${say('check2')}`,
          `  • ${say('check3')}`,
        ].join('\n'),
      })
    })
    socket.addEventListener('close', (event) => {
      if (event.code === 1006) {
        finish({ ok: false, detail: say('refused') })
      }
    })
    setTimeout(() => finish({ ok: false, detail: say('timeout') }), 8000)
  })
}

saveButton.addEventListener('click', async () => {
  const settings = await save()
  show(say('saved'))
  const outcome = await probe(settings)
  show(outcome.detail, outcome.ok ? 'ok' : 'bad')
})

testButton.addEventListener('click', async () => {
  const settings = await save()
  show(say('testing'))
  const outcome = await probe(settings)
  show(outcome.detail, outcome.ok ? 'ok' : 'bad')
})

load().catch((error) => show(say('loadFailed', { reason: error.message }), 'bad'))
