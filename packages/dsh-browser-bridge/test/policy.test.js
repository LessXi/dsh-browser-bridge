/**
 * Tests for `lib/policy.js`.
 *
 * The behaviour under test is the site-permission contract this bridge exposes
 * to the model: which origin a call is attributed to, which rules match it, and
 * how several matching rules combine. Getting the combine rule wrong is the
 * dangerous direction — a too-permissive result silently grants access the user
 * denied — so the most-restrictive cases are asserted from both sides.
 */

import { assert, test } from './harness.js'
import {
  PolicySyntaxError,
  compileHostPattern,
  defaultPolicy,
  normalizeOrigin,
  parseRuleKey,
  resolveOriginPolicy,
} from '../lib/policy.js'

test('normalizeOrigin drops the scheme default port but keeps a real one', () => {
  assert.equal(normalizeOrigin('https://example.com:443/a/b?c#d'), 'https://example.com')
  assert.equal(normalizeOrigin('http://example.com:80/'), 'http://example.com')
  assert.equal(normalizeOrigin('http://localhost:5173/page'), 'http://localhost:5173')
  assert.equal(normalizeOrigin('HTTPS://Example.COM/Path'), 'https://example.com')
})

test('normalizeOrigin refuses everything that is not an http(s) URL', () => {
  assert.throws(() => normalizeOrigin('file:///C:/secret.txt'), PolicySyntaxError)
  assert.throws(() => normalizeOrigin('chrome://settings'), PolicySyntaxError)
  assert.throws(() => normalizeOrigin('about:blank'), PolicySyntaxError)
  assert.throws(() => normalizeOrigin('not a url'), PolicySyntaxError)
})

test('parseRuleKey accepts the documented pattern shapes', () => {
  assert.deepEqual(parseRuleKey('https://example.com'), { scheme: 'https', hostPattern: 'example.com', port: undefined })
  assert.deepEqual(parseRuleKey('http://localhost:5173'), { scheme: 'http', hostPattern: 'localhost', port: '5173' })
  assert.deepEqual(parseRuleKey('https://**.example.com'), { scheme: 'https', hostPattern: '**.example.com', port: undefined })
  assert.deepEqual(parseRuleKey('HTTPS://*.Example.com'), { scheme: 'https', hostPattern: '*.Example.com', port: undefined })
})

test('parseRuleKey normalizes an explicit default port away', () => {
  assert.equal(parseRuleKey('https://example.com:443').port, undefined)
  assert.equal(parseRuleKey('http://example.com:80').port, undefined)
  assert.equal(parseRuleKey('https://example.com:8443').port, '8443')
})

test('a URL with an explicit default port matches a rule written without one', () => {
  const policy = resolveOriginPolicy('https://example.com:443', {
    origins: { 'https://example.com': { access: 'deny' } },
  })
  assert.equal(policy.access, 'deny')
})

test('parseRuleKey rejects what the reference declares invalid', () => {
  for (const bad of [
    'example.com',
    'ftp://example.com',
    'https://*.example.com/path',
    'https://example.com?q=1',
    'https://example.com#f',
    'https://user:pw@example.com',
    'https://example.com:*',
    'https://:8080',
    'https://',
    '',
  ]) {
    assert.throws(() => parseRuleKey(bad), PolicySyntaxError, `expected ${JSON.stringify(bad)} to be rejected`)
  }
})

test('`**.example.com` covers the apex and every subdomain', () => {
  const pattern = compileHostPattern('**.example.com')
  assert.ok(pattern.test('example.com'), 'apex must match')
  assert.ok(pattern.test('www.example.com'))
  assert.ok(pattern.test('a.b.example.com'))
  assert.ok(!pattern.test('example.com.evil.test'), 'must not match a suffix-spoofed host')
  assert.ok(!pattern.test('notexample.com'))
})

test('`*.example.com` covers subdomains only, never the apex', () => {
  const pattern = compileHostPattern('*.example.com')
  assert.ok(pattern.test('www.example.com'))
  assert.ok(pattern.test('a.b.example.com'))
  assert.ok(!pattern.test('example.com'), 'the apex must not match a subdomains-only pattern')
  assert.ok(!pattern.test('notexample.com'))
})

test('a bare `*` matches every host', () => {
  for (const host of ['example.com', 'localhost', 'a.b.c.d.e']) {
    assert.ok(compileHostPattern('*').test(host), `${host} should match`)
  }
})

test('an inner `*` spans dots, per the documented example', () => {
  const pattern = compileHostPattern('region*.example.com')
  assert.ok(pattern.test('region.example.com'))
  assert.ok(pattern.test('region1.example.com'))
  assert.ok(pattern.test('region.api.example.com'), '`region*.example.com` must also match `region.api.example.com`')
  assert.ok(!pattern.test('area.example.com'))
})

test('a `**` after literal text still repeats whole labels', () => {
  const pattern = compileHostPattern('foo.**.example.com')
  assert.ok(pattern.test('foo.example.com'), 'zero repeated labels')
  assert.ok(pattern.test('foo.a.example.com'))
  assert.ok(pattern.test('foo.a.b.example.com'))
  assert.ok(!pattern.test('bar.foo.example.com'), 'the literal head is anchored at the start')
  assert.ok(!pattern.test('foo.bar.test'))
})

test('adjacent wildcards do not manufacture a phantom label', () => {
  // `split('**')` splits a leading run into an empty fragment; feeding that back
  // as a lone `*` once demanded an extra label and broke the apex case.
  assert.ok(compileHostPattern('**.example.com').test('example.com'))
  assert.ok(compileHostPattern('****.example.com').test('example.com'))
  assert.ok(compileHostPattern('****.example.com').test('a.b.example.com'))
})

test('orphan wildcards are treated literally rather than matching everything', () => {
  assert.ok(!compileHostPattern('*.example.com').test('evil.test'))
  assert.ok(!compileHostPattern('**.example.com').test('evil.test'))
})

test('the default policy is permissive but explicit', () => {
  const policy = resolveOriginPolicy('https://example.com')
  assert.deepEqual(policy, defaultPolicy())
  assert.equal(policy.accessApprovalLifetime, 'thread', 'the documented product default')
})

test('a matching rule replaces the fallback field by field', () => {
  const policy = resolveOriginPolicy('https://app.example.com', {
    defaultOriginPolicy: { access: 'deny' },
    origins: { 'https://app.example.com': { access: 'allow' } },
  })
  assert.equal(policy.access, 'allow')
  // Downloads were never mentioned anywhere, so they keep the schema default.
  assert.equal(policy.downloads, 'allow')
})

test('an unmatched origin falls through to the fallback', () => {
  const policy = resolveOriginPolicy('https://other.test', {
    defaultOriginPolicy: { downloads: 'deny' },
    origins: { 'https://app.example.com': { access: 'deny' } },
  })
  assert.equal(policy.access, 'allow')
  assert.equal(policy.downloads, 'deny')
})

test('deny wins over allow when several patterns match', () => {
  const policy = resolveOriginPolicy('https://admin.example.com', {
    origins: {
      'https://**.example.com': { access: 'allow' },
      'https://admin.example.com': { access: 'deny' },
    },
  })
  assert.equal(policy.access, 'deny', 'the stricter of two matching rules must win')
})

test('deny wins regardless of key order', () => {
  const reversed = resolveOriginPolicy('https://admin.example.com', {
    origins: {
      'https://admin.example.com': { access: 'deny' },
      'https://**.example.com': { access: 'allow' },
    },
  })
  assert.equal(reversed.access, 'deny', 'resolution must not depend on key order')
})

test('a denied origin loses uploads, downloads, full CDP, and auto-review', () => {
  const policy = resolveOriginPolicy('https://bank.example', {
    origins: {
      'https://bank.example': { access: 'deny', uploads: 'allow', downloads: 'allow', full_cdp_access: 'allow', auto_review: true },
    },
  })
  assert.equal(policy.access, 'deny')
  assert.equal(policy.uploads, 'deny', 'access denial must cascade to uploads')
  assert.equal(policy.downloads, 'deny', 'access denial must cascade to downloads')
  assert.equal(policy.fullCdpAccess, 'deny', 'access denial must cascade to full CDP')
  assert.equal(policy.autoReview, false, 'access denial must disable automatic review')
})

test('a capability can be denied on its own, without denying access', () => {
  const policy = resolveOriginPolicy('https://files.example', {
    origins: { 'https://files.example': { uploads: 'deny' } },
  })
  assert.equal(policy.access, 'allow')
  assert.equal(policy.uploads, 'deny')
  assert.equal(policy.downloads, 'allow')
})

test('`turn` beats `thread` and `false` beats `true`', () => {
  const policy = resolveOriginPolicy('https://example.com', {
    origins: {
      'https://**.example.com': { access_approval_lifetime: 'thread', persistent_approval: true, auto_review: true },
      'https://example.com': { access_approval_lifetime: 'turn', persistent_approval: false, auto_review: false },
    },
  })
  assert.equal(policy.accessApprovalLifetime, 'turn')
  assert.equal(policy.persistentApproval, false)
  assert.equal(policy.autoReview, false)
})

test('a later permissive rule cannot relax an earlier deny', () => {
  const policy = resolveOriginPolicy('https://example.com', {
    origins: {
      'https://**.example.com': { full_cdp_access: 'deny' },
      'https://example.com': { full_cdp_access: 'allow' },
    },
  })
  assert.equal(policy.fullCdpAccess, 'deny')
})

test('rule fields are validated, not coerced', () => {
  for (const rule of [
    { access: 'yes' },
    { access: true },
    { auto_review: 'no' },
    { persistent_approval: 1 },
    { access_approval_lifetime: 'forever' },
  ]) {
    assert.throws(
      () => resolveOriginPolicy('https://example.com', { origins: { 'https://example.com': rule } }),
      PolicySyntaxError,
      `expected ${JSON.stringify(rule)} to be rejected`,
    )
  }
})

test('an unknown rule field fails loudly instead of being ignored', () => {
  assert.throws(
    () => resolveOriginPolicy('https://example.com', { origins: { 'https://example.com': { acess: 'deny' } } }),
    (error) => {
      assert.ok(error instanceof PolicySyntaxError)
      assert.match(error.message, /acess/, 'the message must name the offending field')
      return true
    },
  )
})

test('a malformed defaultOriginPolicy shape is rejected', () => {
  assert.throws(() => resolveOriginPolicy('https://example.com', { defaultOriginPolicy: [] }), PolicySyntaxError)
  assert.throws(() => resolveOriginPolicy('https://example.com', { origins: [] }), PolicySyntaxError)
  assert.throws(() => resolveOriginPolicy('https://example.com', { origins: { 'https://example.com': 'deny' } }), PolicySyntaxError)
})

test('a scheme mismatch never matches', () => {
  const policy = resolveOriginPolicy('http://example.com', {
    origins: { 'https://example.com': { access: 'deny' } },
  })
  assert.equal(policy.access, 'allow', 'an https rule must not govern http')
})

test('a non-default port is significant', () => {
  const policy = resolveOriginPolicy('http://localhost:5173', {
    origins: { 'http://localhost:8080': { access: 'deny' } },
  })
  assert.equal(policy.access, 'allow')
  const matched = resolveOriginPolicy('http://localhost:5173', {
    origins: { 'http://localhost:5173': { access: 'deny' } },
  })
  assert.equal(matched.access, 'deny')
})
