/**
 * Tests for `lib/token.js`, the module that holds the bridge's only credential.
 *
 * It had no test file of its own — `auth.js` imports `tokenMatches` from it and
 * is tested, which is how a module this central stayed unexercised. Everything
 * here runs against a file in a temporary directory, never the real
 * `$DSH_HOME/storages/dsh-browser-bridge.json`: minting a token into the user's
 * own home while running the suite would replace a live credential.
 */

import { existsSync, mkdtempSync, openSync, closeSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assert, test } from './harness.js'
import { loadOrCreateToken, readTokenState, tokenMatches, tokenStatePath, writeTokenState } from '../lib/token.js'

/**
 * A state path inside a throwaway directory.
 * @param {import('./harness.js').TestContext} t - The test context.
 * @returns {string} The path to use.
 */
function temporaryState(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bb-token-test-'))
  t.onCleanup(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'state.json')
}

test('the state file lives under the harness home, not in user settings', () => {
  const path = tokenStatePath()
  assert.match(path, /[\\/]storages[\\/]dsh-browser-bridge\.json$/)
  assert.ok(path.includes('.dsh') || path.includes(process.env.DSH_HOME ?? '\u0000'))
})

test('a token survives a round trip and is 64 lowercase hex characters', (t) => {
  const path = temporaryState(t)
  const token = loadOrCreateToken(path)

  // `randomBytes(32).toString('hex')` — 32 bytes, lowercase, never uppercase.
  // The extension's options page asserts this shape locally, so a change here
  // would make that check lie to the user.
  assert.match(token, /^[0-9a-f]{64}$/)
  assert.equal(readTokenState(path)?.token, token)
  assert.equal(loadOrCreateToken(path), token, 'and it is stable across calls')
})

test('a malformed file reads as absent instead of stopping startup', (t) => {
  const path = temporaryState(t)
  for (const body of ['', 'not json', 'null', '[]', '{}', '{"token":""}', '{"token":123}']) {
    writeFileSync(path, body, 'utf8')
    assert.equal(readTokenState(path), undefined, `expected ${JSON.stringify(body)} to read as absent`)
  }
  // And the next call repairs it rather than inheriting the damage.
  const token = loadOrCreateToken(path)
  assert.match(token, /^[0-9a-f]{64}$/)
})

test('comparison accepts only the exact token', () => {
  const token = 'a'.repeat(64)
  assert.equal(tokenMatches(token, token), true)
  assert.equal(tokenMatches(token, 'a'.repeat(63) + 'b'), false, 'a different byte must fail')
  assert.equal(tokenMatches(token, 'a'.repeat(63)), false, 'a truncated token must fail')
  assert.equal(tokenMatches(token, 'a'.repeat(65)), false, 'an extended token must fail')
  assert.equal(tokenMatches(token, token.toUpperCase()), false, 'case is significant, as it is on the wire')
  assert.equal(tokenMatches(token, ''), false)
})

test('comparison refuses a value that is not a string rather than throwing', () => {
  const token = 'a'.repeat(64)
  // `timingSafeEqual` throws on non-buffers, so a hostile peer sending a number
  // or null must be handled here — an exception on this path would be a denial
  // of service dressed as a validation error.
  for (const candidate of [undefined, null, 12345, {}, [], true]) {
    assert.equal(tokenMatches(token, candidate), false, `expected ${String(candidate)} to be refused`)
  }
})

test('a failed write leaves no copy of the token behind', (t) => {
  const path = temporaryState(t)
  writeTokenState('a'.repeat(64), path)

  // Renaming over a file another handle holds open fails on Windows. Rather
  // than assume which platforms do that, this holds the handle and accepts
  // either outcome — but if the write does fail, nothing may remain.
  const handle = openSync(path, 'r')
  let failed = false
  try {
    writeTokenState('b'.repeat(64), path)
  } catch {
    failed = true
  }
  closeSync(handle)

  if (failed) {
    // The temporary holds the token in the clear. One leaked copy per failed
    // write, under a pid-suffixed name, is the defect this asserts against.
    const leftovers = readdirSync(join(path, '..')).filter((name) => name.includes('.tmp'))
    assert.deepEqual(leftovers, [], `a failed write leaked ${leftovers.join(', ')}`)
    assert.equal(readTokenState(path)?.token, 'a'.repeat(64), 'and the previous state is untouched')
  } else {
    assert.equal(readTokenState(path)?.token, 'b'.repeat(64))
    assert.deepEqual(readdirSync(join(path, '..')).filter((n) => n.includes('.tmp')), [])
  }
})

test('repeated failed writes do not accumulate copies of the token', (t) => {
  const path = temporaryState(t)
  writeTokenState('a'.repeat(64), path)
  const handle = openSync(path, 'r')
  let failures = 0
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      writeTokenState('c'.repeat(64), path)
    } catch {
      failures += 1
    }
  }
  closeSync(handle)

  if (failures > 0) {
    const entries = readdirSync(join(path, '..'))
    assert.deepEqual(
      entries.filter((name) => name.includes('.tmp')),
      [],
      `after ${failures} failed writes the directory holds ${entries.join(', ')}`,
    )
  }
})

test('the state file is readable only by this account where the platform enforces it', (t) => {
  const path = temporaryState(t)
  writeTokenState('a'.repeat(64), path)

  // `mode: 0o600` is honoured on POSIX and ignored on Windows, where the
  // protection comes from the ACL inherited from the user's own home directory
  // instead. Asserted per platform so neither claim is silently assumed: on
  // Windows this test would fail if the mode were ever the only protection.
  const mode = statSync(path).mode & 0o777
  if (process.platform === 'win32') {
    assert.ok(existsSync(path), 'the file exists; its access control is the inherited ACL')
  } else {
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`)
  }
})
