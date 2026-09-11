/**
 * Options page behaviour: read and write connection settings, and probe the
 * harness so a wrong token is reported here rather than discovered mid-task.
 *
 * @module extension/options
 */

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
      resolve({ ok: false, detail: 'No token saved. Copy it from DSH Settings → Plugins → browser-bridge.' })
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
      resolve({ ok: false, detail: `Could not open the socket: ${error.message}` })
      return
    }

    socket.addEventListener('open', () => {
      finish({ ok: true, detail: `Connected to the harness on port ${settings.port}.` })
    })
    socket.addEventListener('error', () => {
      finish({
        ok: false,
        detail: [
          `Could not connect on port ${settings.port}.`,
          'Check that:',
          '  • the harness is running (dsh web) and the port matches its URL;',
          '  • the token matches DSH Settings → Plugins → browser-bridge;',
          '  • nothing else on this machine is holding that port.',
        ].join('\n'),
      })
    })
    socket.addEventListener('close', (event) => {
      if (event.code === 1006) {
        finish({ ok: false, detail: 'The harness refused the connection — most often a wrong or stale token.' })
      }
    })
    setTimeout(() => finish({ ok: false, detail: 'The harness did not answer within 8 seconds.' }), 8000)
  })
}

saveButton.addEventListener('click', async () => {
  const settings = await save()
  show('Saved. Connecting…')
  const outcome = await probe(settings)
  show(outcome.detail, outcome.ok ? 'ok' : 'bad')
})

testButton.addEventListener('click', async () => {
  const settings = await save()
  show('Testing…')
  const outcome = await probe(settings)
  show(outcome.detail, outcome.ok ? 'ok' : 'bad')
})

load().catch((error) => show(`Could not read saved settings: ${error.message}`, 'bad'))
