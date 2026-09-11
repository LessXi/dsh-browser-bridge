/**
 * Bridge token: the shared secret the browser extension presents to prove it is
 * the one this harness enrolled.
 *
 * Why a token exists at all: the webserver binds loopback and carries no
 * authentication of its own, and a websocket upgrade is not subject to the
 * same-origin policy. Any page open in any browser on this machine could
 * otherwise open the bridge socket and drive the user's signed-in Chrome. The
 * token is the only thing standing between "the user's extension" and "any
 * local page", so it is compared in constant time and never logged.
 *
 * It lives beside the harness home rather than in user settings, because the
 * settings document is meant to be readable and editable by hand.
 *
 * @module dsh-browser-bridge/token
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { dshHome } from './deps.js'

/**
 * Absolute path of the bridge's own state file.
 * @returns {string} `$DSH_HOME/storages/dsh-browser-bridge.json`.
 */
export function tokenStatePath() {
  return join(dshHome(), 'storages', 'dsh-browser-bridge.json')
}

/**
 * Read the stored token, or `undefined` when the file is absent or unreadable.
 * A malformed file is treated as absent so a half-written state cannot brick
 * startup; the next write repairs it.
 *
 * @param {string} [path] - State file path; defaults to {@link tokenStatePath}.
 * @returns {{ token: string } | undefined} The parsed state, when valid.
 */
export function readTokenState(path = tokenStatePath()) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    return typeof parsed.token === 'string' && parsed.token.length > 0 ? { token: parsed.token } : undefined
  } catch {
    return undefined
  }
}

/**
 * Persist the token atomically: a temporary file in the same directory, then a
 * rename. A reader therefore sees either the previous state or the new one,
 * never a truncated document.
 *
 * @param {string} token - The token to store.
 * @param {string} [path] - State file path; defaults to {@link tokenStatePath}.
 */
export function writeTokenState(token, path = tokenStatePath()) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ token }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
}

/**
 * Read the existing token or mint one, so the value is stable across restarts
 * and the user pastes it into the extension exactly once.
 *
 * @param {string} [path] - State file path; defaults to {@link tokenStatePath}.
 * @returns {string} The current token.
 */
export function loadOrCreateToken(path = tokenStatePath()) {
  const existing = readTokenState(path)
  if (existing !== undefined) return existing.token
  const token = randomBytes(32).toString('hex')
  writeTokenState(token, path)
  return token
}

/**
 * Constant-time token comparison.
 *
 * Length is compared first because `timingSafeEqual` throws on differing
 * lengths; that leaks only the length, which is fixed at 64 hex characters for
 * every real token and is not secret.
 *
 * @param {string} expected - The stored token.
 * @param {string | undefined} offered - The value presented by a client.
 * @returns {boolean} Whether the offered value is the expected token.
 */
export function tokenMatches(expected, offered) {
  if (typeof offered !== 'string' || offered.length === 0) return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(offered, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
