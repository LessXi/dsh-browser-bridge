/**
 * Enrol this extension with the harness — the step that used to be a
 * copy-and-paste.
 *
 * The bridge token is 64 hexadecimal characters stored under the harness home,
 * and until now the only way into this extension was to copy it out of the DSH
 * settings card and paste it into the options page. That is a real barrier: two
 * windows, a field that shows nothing back, and a failure mode that blames the
 * harness when the paste was short.
 *
 * It is also unnecessary. The harness already serves the token from
 * `/api/browser-bridge/token` for exactly this purpose, and what protects that
 * route is not secrecy from this extension — it is the browser's same-origin
 * policy. The route carries no CORS header, so an ordinary page that fetches it
 * gets an opaque response it cannot read; this extension can read it, because
 * its manifest claims `http://127.0.0.1/*` as a host permission.
 *
 * That distinction is the whole security argument for this module, so it is
 * worth stating plainly: enrolling automatically does not widen who can read the
 * token. The harness binds loopback and the route answers any loopback peer,
 * which is why it is documented as readable from this machine only. What changes
 * is that the person who owns the browser stops being a courier for a value
 * their own machine already has.
 *
 * The health route is read first, and only to respect the off switch. Someone
 * who turned the bridge off in DSH Settings meant it, and an extension that
 * silently reconnected anyway would make that control a lie — so `enabled:
 * false` is reported as its own outcome rather than as a failure to connect.
 *
 * @module extension/bootstrap
 */

/** How long a single probe may take before it counts as unanswered. */
const TIMEOUT_MS = 4000

/**
 * The outcome of one enrolment attempt.
 *
 * Every failure names what the *person* would have to change, because that is
 * what the settings page has to print: `disabled` is a switch they flipped,
 * `unreachable` is a harness that is not running, and `malformed` is a harness
 * answering with something that is not a token.
 *
 * @typedef {object} Enrolment
 * @property {boolean} ok - Whether a usable token came back.
 * @property {string} [token] - The token, when `ok`.
 * @property {'disabled' | 'unreachable' | 'malformed'} [reason] - Why not, when not `ok`.
 * @property {number} [tokenLength] - The length the harness reports, for the shape note.
 */

/**
 * Fetch one JSON document from the harness, or `undefined` if it did not answer.
 *
 * The timeout is not decoration. A service worker that is evicted mid-probe, or
 * a port with a listener that accepts and never writes, would otherwise leave
 * the promise pending until the browser tears the worker down — and the settings
 * page would sit on "getting the token" forever with no way to tell that from a
 * slow answer.
 *
 * @param {typeof fetch} ask - The fetch implementation.
 * @param {string} url - Where to read.
 * @returns {Promise<any | undefined>} The parsed body, or undefined.
 */
async function readJson(ask, url) {
  try {
    const response = await ask(url, { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (response.ok !== true) return undefined
    return await response.json()
  } catch {
    // A refused connection, a timeout, an opaque response and a body that is not
    // JSON all mean the same thing to the caller: this route did not answer with
    // something usable. The caller's message names the remedy, and the remedy is
    // the same for all four.
    return undefined
  }
}

/**
 * Ask the harness for the bridge token.
 *
 * @param {string} port - The harness port, as configured.
 * @param {object} [options] - Injection points for tests.
 * @param {typeof fetch} [options.fetch] - Fetch implementation; defaults to the global.
 * @returns {Promise<Enrolment>} The outcome.
 */
export async function fetchBridgeToken(port, options = {}) {
  const ask = options.fetch ?? globalThis.fetch
  if (typeof ask !== 'function') return { ok: false, reason: 'unreachable' }

  const base = `http://127.0.0.1:${port}`

  const health = await readJson(ask, `${base}/browser-bridge/health`)
  if (health === undefined) return { ok: false, reason: 'unreachable' }
  if (health.enabled === false) return { ok: false, reason: 'disabled' }

  const answer = await readJson(ask, `${base}/api/browser-bridge/token`)
  if (answer === undefined) return { ok: false, reason: 'unreachable' }
  if (typeof answer.token !== 'string' || answer.token.length === 0) {
    return { ok: false, reason: 'malformed' }
  }
  return {
    ok: true,
    token: answer.token,
    // Reported by the health route so the shape note can describe the harness's
    // own token rather than a length this module assumes.
    tokenLength: typeof health.tokenLength === 'number' ? health.tokenLength : answer.token.length,
  }
}
