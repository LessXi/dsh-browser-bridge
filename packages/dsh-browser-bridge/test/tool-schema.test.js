/**
 * Tests the tool definitions against the harness's REAL schema compiler.
 *
 * Why this file exists: a schema that merely *exists* can still be rejected when
 * the tool registers. `dsh-tools` compiles the declared output and parameter
 * schemas at `defineTool` time and throws on unsupported vocabulary — and that
 * throw happens while the plugin is loading, so one bad schema takes the entire
 * plugin tree down instead of failing one tool.
 *
 * That is exactly what happened: `meta: { type: 'object' }` without an explicit
 * `additionalProperties` is rejected, and the earlier suites — which only
 * asserted that a schema object was present — passed the whole time.
 *
 * The test skips (rather than fails) when the harness module tree is not
 * reachable, so a bare checkout can still run the rest of the suite.
 */

import { assert, test } from './harness.js'
import { loadPeer } from '../lib/deps.js'
import { buildTools } from '../lib/tools.js'
import { buildPageTools } from '../lib/page-tools.js'
import { BridgeRegistry } from '../lib/bridge.js'
import { GrantTable } from '../lib/grants.js'
import { ContextAttachments } from '../lib/context.js'
import { resolveSettings } from '../lib/config.js'

/** A settings reader over defaults plus overrides. */
function settingsWith(overrides = {}) {
  return () => resolveSettings(overrides)
}

/**
 * Build the full tool set with inert ports.
 * @returns {object[]} The raw definitions.
 */
function allDefinitions() {
  const bridge = new BridgeRegistry()
  const ports = {
    bridge,
    settings: settingsWith(),
    connectionStatus: () => ({ connected: false }),
    grants: new GrantTable(),
    contextAttachments: new ContextAttachments({
      settings: settingsWith(),
      makeMessage: () => ({}),
      path: 'C:\\nonexistent\\dsh-browser-bridge-test-state.json',
    }),
    approval: undefined,
    tabOrigin: async () => undefined,
    policyLayers: () => ({ origins: {}, defaultOriginPolicy: {} }),
  }
  return [...buildTools(ports), ...buildPageTools(ports)]
}

test('every tool definition compiles under the harness schema compiler', async (t) => {
  let defineTool
  try {
    const module = await loadPeer('@deepseek-ai/dsh-tools')
    defineTool = module.defineTool
  } catch (error) {
    t.skip(`the harness tool runtime is not reachable (${error.code ?? error.message})`)
    return
  }
  assert.equal(typeof defineTool, 'function', 'dsh-tools must export defineTool')

  const definitions = allDefinitions()
  assert.ok(definitions.length >= 20, `expected the full tool surface, saw ${definitions.length}`)

  const rejected = []
  for (const definition of definitions) {
    try {
      const compiled = defineTool(definition)
      assert.equal(compiled.name, definition.name, `${definition.name} must survive compilation unchanged`)
    } catch (error) {
      rejected.push(`${definition.name}: ${error.message}`)
    }
  }
  assert.deepEqual(rejected, [], `the harness rejected these definitions:\n${rejected.join('\n')}`)
})

test('every output schema declares additionalProperties on each object node', async (t) => {
  let defineTool
  try {
    const module = await loadPeer('@deepseek-ai/dsh-tools')
    defineTool = module.defineTool
  } catch {
    t.skip('the harness tool runtime is not reachable')
    return
  }

  /**
   * Walk a schema, collecting object nodes that omit `additionalProperties`.
   * @param {unknown} node - The schema node.
   * @param {string} path - Where it sits, for the message.
   * @returns {string[]} The offending paths.
   */
  const offenders = (node, path) => {
    if (typeof node !== 'object' || node === null) return []
    const found = []
    if (node.type === 'object' && node.additionalProperties === undefined) found.push(path)
    for (const [key, child] of Object.entries(node)) {
      if (key === 'properties' || key === 'items' || key === 'oneOf' || key === 'anyOf') {
        found.push(...offenders(child, `${path}.${key}`))
      } else if (typeof child === 'object' && child !== null && !Array.isArray(child)) {
        found.push(...offenders(child, `${path}.${key}`))
      } else if (Array.isArray(child)) {
        for (const [index, entry] of child.entries()) found.push(...offenders(entry, `${path}.${key}[${index}]`))
      }
    }
    return found
  }

  const offendersByTool = []
  for (const definition of allDefinitions()) {
    const compiled = defineTool(definition)
    const schema = definition.output?.schema
    const found = offenders(schema, definition.name)
    if (found.length > 0) offendersByTool.push(...found)
    assert.ok(compiled !== undefined)
  }
  assert.deepEqual(offendersByTool, [], `these object nodes need an explicit additionalProperties: ${offendersByTool.join(', ')}`)
})
