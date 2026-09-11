/**
 * Request authorization for the extension-facing routes.
 *
 * The webserver binds loopback and carries no authentication of its own, and an
 * HTTP request is not subject to the same-origin policy. Without a check, any
 * page open in any browser on this machine could open the bridge socket or read
 * the token route, and through it drive the user's signed-in Chrome. These
 * helpers are the whole of that boundary, so they are pure functions with their
 * own tests rather than inline expressions in a handler.
 *
 * @module dsh-browser-bridge/auth
 */

import { tokenMatches } from './token.js'

/**
 * Addresses that mean "this machine", in every spelling Node may report.
 *
 * Both loopback forms are accepted because a socket bound to `127.0.0.1` may
 * still see an `::ffff:127.0.0.1` peer, and rejecting that would break a working
 * setup for no security gain.
 */
const LOOPBACK = Object.freeze([
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
  'localhost',
])

/**
 * Whether a request arrived over a loopback connection.
 *
 * This is defense in depth, not the primary control: `remoteAddress` is
 * trustworthy for a loopback-bound server, and the managed host setting narrows
 * it further for deployments that bind a wider interface.
 *
 * @param {import('node:http').IncomingMessage} req - The request.
 * @returns {boolean} True when the peer is this machine.
 */
export function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress
  if (typeof address !== 'string') return false
  return LOOPBACK.includes(address)
}

/**
 * Extract the offered token from an upgrade request.
 *
 * Two carriers are accepted because neither works everywhere: browser
 * `WebSocket` construction cannot set arbitrary headers, so the query string is
 * the practical option, while `Sec-WebSocket-Protocol` is available and keeps
 * the value out of request logs. A query value wins when both are present so a
 * debugging client can override a stale subprotocol entry.
 *
 * @param {string | undefined} url - The request URL, as seen on the socket.
 * @param {Record<string, string | string[] | undefined>} headers - The request headers.
 * @returns {string | undefined} The offered token, when one was supplied.
 */
export function offeredToken(url, headers) {
  if (typeof url === 'string' && url.length > 0) {
    const query = url.indexOf('?')
    if (query !== -1) {
      for (const pair of url.slice(query + 1).split('&')) {
        const equals = pair.indexOf('=')
        if (equals === -1) continue
        if (pair.slice(0, equals) !== 'token') continue
        try {
          const value = decodeURIComponent(pair.slice(equals + 1))
          if (value.length > 0) return value
        } catch {
          // A malformed escape sequence is a failure to authenticate, not a throw.
        }
      }
    }
  }

  const raw = headers['sec-websocket-protocol']
  const header = Array.isArray(raw) ? raw[0] : raw
  if (typeof header === 'string' && header.length > 0) {
    // The client may offer several comma-separated protocols; the bridge's own
    // is the one carrying the token.
    for (const candidate of header.split(',')) {
      const value = candidate.trim()
      if (value.startsWith('dsh-bridge-token.')) return value.slice('dsh-bridge-token.'.length)
    }
    const [first] = header.split(',')
    if (typeof first === 'string' && first.trim().length > 0) return first.trim()
  }
  return undefined
}

/**
 * The exact `Origin` value a browser extension service worker sends.
 *
 * A Chrome extension's origin is `chrome-extension://<id>`. The id is not known
 * ahead of time for an unpacked install, so the shape is checked rather than
 * the value — a web page cannot forge this header, which is what makes the
 * check meaningful as a CSRF control.
 *
 * @param {string | undefined} origin - The request's `Origin` header.
 * @returns {boolean} True when the origin is an extension origin.
 */
export function isExtensionOrigin(origin) {
  if (typeof origin !== 'string') return false
  return /^chrome-extension:\/\/[a-p]{32}$/.test(origin)
}

/**
 * Decide whether to accept one browser-facing request.
 *
 * The token is the load-bearing control and is always required. The origin
 * check is applied only when an `Origin` header is present: a service worker
 * may omit it in some Chrome versions, and rejecting a token-bearing request
 * for a missing header would break a legitimate connection while adding
 * nothing — an attacker cannot suppress the header the browser sends on a
 * cross-origin request.
 *
 * @param {import('node:http').IncomingMessage} req - The request.
 * @param {{ token: string, requireLoopback?: boolean }} policy - The current token and bind posture.
 * @returns {{ ok: true } | { ok: false, status: number, reason: string }} The verdict.
 */
export function authorizeBridgeRequest(req, policy) {
  if (policy.requireLoopback === true && !isLoopbackRequest(req)) {
    return { ok: false, status: 403, reason: 'the browser bridge is reachable only from this machine' }
  }
  const origin = req.headers.origin
  if (origin !== undefined && !isExtensionOrigin(origin)) {
    return { ok: false, status: 403, reason: 'the browser bridge accepts requests only from a browser extension' }
  }
  const offered = offeredToken(req.url, req.headers)
  if (!tokenMatches(policy.token, offered)) {
    return { ok: false, status: 401, reason: 'missing or incorrect bridge token' }
  }
  return { ok: true }
}

/**
 * Decide whether to accept one upgrade request.
 *
 * Same policy as {@link authorizeBridgeRequest}, kept separate because an
 * upgrade has only a raw socket: the rejection must be written by hand and the
 * socket destroyed, so the shape of the answer differs.
 *
 * @param {import('node:http').IncomingMessage} req - The upgrade request.
 * @param {{ token: string, requireLoopback?: boolean }} policy - The current token and bind posture.
 * @returns {boolean} True when the upgrade may proceed.
 */
export function authorizeUpgrade(req, policy) {
  return authorizeBridgeRequest(req, policy).ok
}
