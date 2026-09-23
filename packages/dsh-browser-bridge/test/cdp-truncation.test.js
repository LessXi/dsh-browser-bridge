/**
 * `browser_cdp` hands back a raw CDP result, and the cap that keeps one call
 * from filling the context used to cut it off without saying so.
 *
 * The failure this guards against is not a crash. A JSON document sliced at
 * 20 000 characters still reads like a document — it just ends mid-token, and a
 * model that receives it cannot tell whether the browser said that or whether
 * something upstream stopped listening. `DOMSnapshot.captureSnapshot` on an
 * ordinary page crosses the line, so this is a normal call, not an exotic one.
 *
 * The tool is exercised through its real registration, including the approval
 * gate, because the truncation lives after the gate and a fixture that skipped
 * it would test a path the model never takes.
 */

import { assert, test } from './harness.js'
import { buildPageTools } from '../lib/page-tools.js'

/**
 * Build the page tools against a bridge that answers `cdp.send` with `payload`.
 *
 * The ports are the ones the real composition root supplies; the approval stub
 * resolves to the bare outcome string, which is what `askApproval` compares
 * against.
 *
 * @param {unknown} payload - What the fake CDP call returns.
 * @returns {Map<string, object>} Tools by name.
 */
function toolsWith(payload) {
  const ports = {
    bridge: {
      connection: {
        status: () => ({ connected: true }),
        call: async (method) => (method === 'cdp.send' ? payload : {}),
      },
    },
    settings: () => ({
      enabled: true,
      developerMode: true,
      confirmSensitiveActions: false,
      pageTextMaxBytes: 200_000,
      actionTimeoutMs: 15_000,
      screenshotMaxWidth: 1_200,
      consoleBufferSize: 200,
      networkBufferSize: 200,
      origins: ['https://example.com = allow'],
    }),
    connectionStatus: () => ({ connected: true }),
    grants: { find: () => undefined, record: () => {}, has: () => true },
    contextAttachments: { noteBrowserSession: () => {} },
    attachmentStore: () => undefined,
    approval: { request: async () => 'allowed-once' },
    tabOrigin: async () => 'https://example.com',
    policyLayers: () => [{ origins: { 'https://example.com': { access: 'allow', full_cdp_access: 'allow' } } }],
  }
  const tools = buildPageTools(ports)
  return new Map(tools.map((tool) => [tool.name, tool]))
}

/** An execution carrying an agent, which the approval gate requires. */
const exec = { agent: { id: 'fixture-session' }, callId: 'fixture-call', signal: undefined }

/** A CDP-shaped payload whose JSON serialization is at least `chars` long. */
function payloadOfAtLeast(chars) {
  const strings = []
  let size = 0
  while (size < chars) {
    const next = `string-${strings.length}-with-some-body-text`
    strings.push(next)
    size += next.length + 8
  }
  return { strings, documents: [{ nodes: { nodeType: [1], nodeName: [0] } }] }
}

test('a small CDP result is handed back whole', async (t) => {
  const payload = { ok: true, value: 42 }
  const tool = toolsWith(payload).get('browser_cdp')
  const out = await tool.execute({ method: 'Runtime.evaluate', params: {}, tab_id: 1 }, exec)

  // The body is wrapped in the untrusted-content boundary, so the assertion is
  // that the payload survives intact *inside* it rather than that the text is
  // byte-identical to the serialisation.
  assert.ok(out.text.includes(JSON.stringify(payload, null, 2)), 'the real answer must survive whole')
  assert.match(out.text, /content read from a web page/i, 'the answer must carry its provenance')
  assert.notEqual(out.meta?.truncated, true, 'a complete answer must not claim truncation')
})

test('a result past the cap says it was cut, and by how much', async (t) => {
  const payload = payloadOfAtLeast(40_000)
  const full = JSON.stringify(payload, null, 2)
  assert.ok(full.length > 20_000, `fixture must exceed the cap, got ${full.length}`)

  const tool = toolsWith(payload).get('browser_cdp')
  const out = await tool.execute({ method: 'DOMSnapshot.captureSnapshot', params: {}, tab_id: 1 }, exec)

  // The marker is the whole point: without it the reader sees a JSON document
  // that merely stops, which is indistinguishable from a complete one.
  assert.match(out.text, /truncated/i, 'a truncated result must say so')
  assert.match(out.text, new RegExp(String(full.length)), 'the marker must state the real total length')
  assert.ok(
    out.text.startsWith(full.slice(0, 200)) || out.text.includes(full.slice(0, 200)),
    'the surviving prefix must be the real answer, not a rewrite',
  )
  // The boundary is written before the cap, so it cannot be the part that was
  // cut away — a provenance marker that truncation can remove is not one.
  assert.match(out.text, /content read from a web page/i, 'the provenance marker must survive the cut')

  assert.equal(out.meta?.truncated, true)
  assert.equal(out.meta?.fullLength, full.length)
  assert.equal(out.meta?.method, 'DOMSnapshot.captureSnapshot')
})

test('the truncation marker cannot be confused with the payload ending', async (t) => {
  // A payload that itself contains the word "truncated" must not be mistaken for
  // the marker, so the assertion above is made on a payload that does not.
  const clean = payloadOfAtLeast(40_000)
  const serialized = JSON.stringify(clean, null, 2)
  assert.ok(!/truncated/i.test(serialized), 'fixture must not contain the marker word')

  const tool = toolsWith(clean).get('browser_cdp')
  const out = await tool.execute({ method: 'Network.getResponseBody', params: {}, tab_id: 1 }, exec)
  assert.match(out.text, /result truncated/i)
})

test('the cut happens after the gate, so a refused call is never described as truncated', async (t) => {
  const ports = {
    bridge: {
      connection: {
        status: () => ({ connected: true }),
        call: async () => payloadOfAtLeast(40_000),
      },
    },
    settings: () => ({ enabled: false }),
    connectionStatus: () => ({ connected: true }),
    grants: { find: () => undefined, record: () => {}, has: () => true },
    contextAttachments: { noteBrowserSession: () => {} },
    attachmentStore: () => undefined,
    approval: { request: async () => 'allowed-once' },
    tabOrigin: async () => 'https://example.com',
    policyLayers: () => [],
  }
  const tool = buildPageTools(ports).find((entry) => entry.name === 'browser_cdp')
  const out = await tool.execute({ method: 'Runtime.evaluate', params: {}, tab_id: 1 }, exec)

  assert.match(out.text, /switched off/i)
  assert.notEqual(out.meta?.truncated, true, 'a call that never ran has nothing to truncate')
})
