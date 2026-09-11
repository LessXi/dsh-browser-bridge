/**
 * Tests for the site-grant table and the sensitivity classifier.
 *
 * The direction of every error here matters: a grant that lasts longer than the
 * user agreed to hands a site more access than they approved, so the cases that
 * assert *expiry* are the ones that must never silently pass.
 */

import { assert, test } from './harness.js'
import {
  APPROVAL_CHOICES,
  GrantTable,
  SENSITIVE_WORDS,
  TURN_IDLE_MS,
  classifySensitivity,
} from '../lib/grants.js'

/** A controllable clock. */
function clock() {
  let now = 1_000_000
  return {
    now: () => now,
    advance: (ms) => {
      now += ms
    },
  }
}

test('the approval choices are the four a user expects', () => {
  assert.deepEqual([...APPROVAL_CHOICES], ['allow-once', 'allow-for-site', 'allow-for-all-sites', 'decline'])
})

test('a recorded grant covers the capability it names', () => {
  const grants = new GrantTable()
  grants.record({ sessionId: 's1', origin: 'https://example.com', capabilities: ['access'], lifetime: 'thread' })
  assert.equal(grants.covers('s1', 'https://example.com', 'access'), true)
})

test('a grant is scoped to one session', () => {
  const grants = new GrantTable()
  grants.record({ sessionId: 's1', origin: 'https://example.com', capabilities: ['access'], lifetime: 'thread' })
  assert.equal(grants.covers('s2', 'https://example.com', 'access'), false, 'another session must not inherit it')
})

test('a grant is scoped to one origin', () => {
  const grants = new GrantTable()
  grants.record({ sessionId: 's1', origin: 'https://example.com', capabilities: ['access'], lifetime: 'thread' })
  assert.equal(grants.covers('s1', 'https://other.test', 'access'), false)
})

test('an access grant covers the capabilities behind it', () => {
  const grants = new GrantTable()
  grants.record({ sessionId: 's1', origin: 'https://example.com', capabilities: ['access'], lifetime: 'thread' })
  // Approving a site to read is not a reason to ask again before an upload the
  // user separately allowed; the policy engine still gates the capability.
  assert.equal(grants.covers('s1', 'https://example.com', 'uploads'), true)
  assert.equal(grants.covers('s1', 'https://example.com', 'downloads'), true)
})

test('a narrower grant does not imply access', () => {
  const grants = new GrantTable()
  grants.record({ sessionId: 's1', origin: 'https://example.com', capabilities: ['uploads'], lifetime: 'thread' })
  assert.equal(grants.covers('s1', 'https://example.com', 'uploads'), true)
  assert.equal(grants.covers('s1', 'https://example.com', 'access'), false, 'an upload grant is not a read grant')
})

test('separate records keep their own capability sets', () => {
  const grants = new GrantTable()
  grants.record({ sessionId: 's1', origin: 'https://example.com', capabilities: ['access'], lifetime: 'thread' })
  grants.record({ sessionId: 's1', origin: 'https://example.com', capabilities: ['uploads'], lifetime: 'thread' })
  const rows = grants.list('s1')
  const origins = rows.map((row) => row.capabilities)
  assert.ok(origins.some((caps) => caps.length === 1 && caps[0] === 'access'))
  assert.ok(origins.some((caps) => caps.length === 1 && caps[0] === 'uploads'))
})

test('a thread grant survives arbitrarily long use', () => {
  const time = clock()
  const grants = new GrantTable({ now: time.now })
  grants.record({ sessionId: 's1', origin: 'https://example.com', capabilities: ['access'], lifetime: 'thread' })
  time.advance(TURN_IDLE_MS * 20)
  assert.equal(grants.covers('s1', 'https://example.com', 'access'), true)
})

test('a turn grant expires once the session goes quiet', () => {
  const time = clock()
  const grants = new GrantTable({ now: time.now })
  grants.record({ sessionId: 's1', origin: 'https://example.com', capabilities: ['access'], lifetime: 'turn' })
  assert.equal(grants.covers('s1', 'https://example.com', 'access'), true, 'it must hold immediately after being granted')

  time.advance(TURN_IDLE_MS + 1)
  assert.equal(grants.covers('s1', 'https://example.com', 'access'), false, 'a quiet session must fall back to asking')
})

test('activity keeps a turn grant alive', () => {
  const time = clock()
  const grants = new GrantTable({ now: time.now })
  grants.record({ sessionId: 's1', origin: 'https://example.com', capabilities: ['access'], lifetime: 'turn' })

  // Three intervals that are each shorter than the idle window, with a lookup
  // in each: continuous work must not be interrupted by an expiry.
  for (let index = 0; index < 3; index += 1) {
    time.advance(TURN_IDLE_MS - 1_000)
    assert.equal(grants.covers('s1', 'https://example.com', 'access'), true, `lookup ${index} must still be covered`)
  }
})

test('sweep reports what it dropped, and only for the idle half', () => {
  const time = clock()
  const grants = new GrantTable({ now: time.now })
  grants.record({ sessionId: 's1', origin: 'https://a.test', capabilities: ['access'], lifetime: 'turn' })
  grants.record({ sessionId: 's1', origin: 'https://b.test', capabilities: ['access'], lifetime: 'thread' })
  time.advance(TURN_IDLE_MS + 1)
  assert.equal(grants.sweep(), 1, 'only the turn grant should expire')
  assert.equal(grants.list('s1').length, 1)
  assert.equal(grants.list('s1')[0].origin, 'https://b.test')
})

test('revoking removes every capability for one origin', () => {
  const grants = new GrantTable()
  grants.record({ sessionId: 's1', origin: 'https://example.com', capabilities: ['access'], lifetime: 'thread' })
  grants.record({ sessionId: 's1', origin: 'https://example.com', capabilities: ['uploads'], lifetime: 'thread' })
  assert.equal(grants.revoke('s1', 'https://example.com'), 2)
  assert.equal(grants.covers('s1', 'https://example.com', 'access'), false)
})

test('an unknown capability is ignored rather than stored', () => {
  const grants = new GrantTable()
  grants.record({ sessionId: 's1', origin: 'https://example.com', capabilities: ['superuser'], lifetime: 'thread' })
  assert.equal(grants.list('s1').length, 0)
  assert.equal(grants.covers('s1', 'https://example.com', 'superuser'), false)
})

test('clear empties the table', () => {
  const grants = new GrantTable()
  grants.record({ sessionId: 's1', origin: 'https://example.com', capabilities: ['access'], lifetime: 'thread' })
  grants.clear()
  assert.deepEqual(grants.list(), [])
})

test('consequential clicks are classified as sensitive', () => {
  for (const label of ['Submit order', 'Buy now', 'Delete account', 'Confirm payment', 'Sign out']) {
    const verdict = classifySensitivity({ tool: 'browser_click', args: { text: label } })
    assert.equal(verdict.sensitive, true, `${label} must ask twice`)
    assert.equal(typeof verdict.reason, 'string')
  }
})

test('ordinary clicks are not sensitive', () => {
  for (const label of ['Next page', 'Open settings menu', 'Load more', 'Show details']) {
    // "settings" IS in the word list, so this asserts the classifier is reading
    // the label rather than defaulting to sensitive.
    const verdict = classifySensitivity({ tool: 'browser_click', args: { text: label } })
    if (label.includes('settings')) assert.equal(verdict.sensitive, true, label)
    else assert.equal(verdict.sensitive, false, label)
  }
})

test('a selector that names a consequential control is sensitive', () => {
  const verdict = classifySensitivity({ tool: 'browser_click', args: { selector: '#confirm-delete' } })
  assert.equal(verdict.sensitive, true)
})

test('upload, eval, and cdp are always sensitive', () => {
  assert.equal(classifySensitivity({ tool: 'browser_upload', args: {} }).sensitive, true)
  assert.equal(classifySensitivity({ tool: 'browser_eval', args: {} }).sensitive, true)
  assert.equal(classifySensitivity({ tool: 'browser_cdp', args: {} }).sensitive, true)
})

test('reading tools are never sensitive', () => {
  for (const tool of ['browser_read', 'browser_snapshot', 'browser_screenshot', 'browser_tabs', 'browser_console']) {
    assert.equal(classifySensitivity({ tool, args: {} }).sensitive, false, tool)
  }
})

test('the sensitive word list is exposed so the model can route around it', () => {
  assert.ok(SENSITIVE_WORDS.includes('submit'))
  assert.ok(SENSITIVE_WORDS.length > 10)
})
