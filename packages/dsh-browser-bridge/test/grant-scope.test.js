/**
 * What a button actually grants.
 *
 * The panel used to offer one affirmative button reading 「允许一次」 and record
 * a grant lasting the whole session, because the duration came from a config
 * default (`persistentApproval: true`, `accessApprovalLifetime: 'thread'`)
 * rather than from what the person pressed. A button whose label and effect
 * disagree is worse than a missing button: it takes an informed decision and
 * quietly makes a different one.
 *
 * These cases drive the real `askApproval` through a page tool, so the wiring
 * from the button through the relay into the grant table is what is under test —
 * not a stub of it.
 *
 * @module dsh-browser-bridge/test/grant-scope
 */

import { test, assert } from './harness.js'
import { buildPageTools } from '../lib/page-tools.js'
import { GrantTable } from '../lib/grants.js'
import { resolveSettings } from '../lib/config.js'

const ORIGIN = 'https://example.com'
const SESSION = 'session-scope-test'

/**
 * A page tool whose gate has to ask, with the answer scripted.
 *
 * @param {object} [options] - Fixture knobs.
 * @param {string} [options.scope] - What the answering surface reports back.
 * @param {string} [options.verdict] - What the harness's approval service returns.
 * @param {object} [options.settings] - Settings overrides.
 * @returns {object} The tool, the grant table, and the exec stub.
 */
function fixture(options = {}) {
  const grants = new GrantTable()
  const asked = []
  const released = []

  const approval = {
    /**
     * Stand in for `dsh-user-approval`. The scope is not an argument here on
     * purpose: the harness cannot carry one, so the relay is the only route back.
     * @param {object} request - The approval request.
     * @returns {Promise<string>} The harness outcome.
     */
    request: async (request) => {
      asked.push(request)
      // The real relay records the scope when the panel answers, which happens
      // while `request` is awaiting. This is that moment.
      if (options.scope !== undefined) released.push(options.scope)
      return options.verdict ?? 'allowed-once'
    },
  }

  const ports = {
    bridge: { connection: { call: async () => ({}) } },
    settings: () => resolveSettings(options.settings ?? {}),
    connectionStatus: () => ({ connected: true }),
    grants,
    contextAttachments: undefined,
    attachmentStore: () => undefined,
    approval,
    tabOrigin: async () => ORIGIN,
    policyLayers: () => ({ origins: {}, defaultOriginPolicy: {} }),
    // The relay's read-back. The tool asks by call id at the moment it decides.
    approvalScope: () => released.shift(),
  }

  const tool = buildPageTools(ports).find((definition) => definition.name === (options.call ?? 'browser_click'))
  assert.ok(tool !== undefined, `${options.call ?? 'browser_click'} must exist in the page tool set`)
  return { tool, grants, asked, released, exec: { agent: { id: SESSION }, callId: 'call-1' } }
}

test('a tool call gated on approval reaches the grant table with the chosen scope', async () => {
  const { tool, grants, asked, exec } = fixture({ scope: 'conversation' })
  await tool.execute({ tab_id: 7, selector: '#go' }, exec)

  assert.equal(asked.length, 1, 'the tool never asked')
  assert.equal(asked[0].origin, ORIGIN)
  assert.equal(grants.covers(SESSION, ORIGIN, 'access'), true, 'the grant was not recorded')
  const grant = grants.find(SESSION, ORIGIN, 'access')
  assert.equal(grant.lifetime, 'thread', 'a session-wide answer did not last the session')
  assert.equal(grant.persistent, true)
})

test('「only this once」 really is once, however the deployment is configured', async () => {
  // This is the defect. The shipped defaults were `persistentApproval: true` and
  // `accessApprovalLifetime: 'thread'`, so answering "once" recorded a grant
  // that covered every later call in the session — and nothing ever asked again.
  const { tool, grants, exec } = fixture({ scope: 'once' })
  await tool.execute({ tab_id: 7, selector: '#go' }, exec)

  assert.equal(grants.covers(SESSION, ORIGIN, 'access'), false, '「once」 recorded a site-wide grant')
  const grant = grants.find(SESSION, ORIGIN, 'access')
  assert.equal(grant, undefined, `a once-grant was recorded anyway: ${JSON.stringify(grant)}`)
})

test('a once-grant expires rather than lasting the session', async () => {
  // `lifetime: 'turn'` is what the grant table sweeps on an idle gap, so the
  // distinction has to reach the table and not just the return value.
  let now = 1_000_000
  const grants = new GrantTable({ now: () => now })
  grants.record({
    sessionId: SESSION,
    origin: ORIGIN,
    capabilities: ['access'],
    lifetime: 'turn',
    persistent: false,
  })
  assert.equal(grants.covers(SESSION, ORIGIN, 'access'), true)
  now += 6 * 60_000
  assert.equal(grants.covers(SESSION, ORIGIN, 'access'), false, 'a turn grant outlived its turn')
})

test('a path that always re-asks never records a session grant', async () => {
  // `browser_eval`, `browser_cdp`, and `browser_upload` ask on every call by
  // design, and a sensitive action is a second question inside an approved site
  // by design. A card offering 「本会话允许」 on those paths was the same defect
  // as a 「允许一次」 lasting a session: a button promising what the host will
  // not do. The scope is clamped here as well, so an older panel cannot widen it.
  // `browser_upload` rather than `browser_eval`: eval is *also* sensitive, so it
  // cannot isolate the always-ask rule on its own. Upload's gate is plain
  // always-ask, which is the single fact under test here.
  const { tool, grants, asked, exec } = fixture({ scope: 'conversation', call: 'browser_upload' })
  await tool.execute({ tab_id: 7, selector: '#file', files: ['C:\\tmp\\a.txt'] }, exec)

  assert.equal(asked.length, 1, 'the tool never asked')
  assert.equal(asked[0].rememberable, false, 'the panel was not told a session grant is impossible')
  assert.equal(
    grants.covers(SESSION, ORIGIN, 'access'),
    false,
    'an always-ask path recorded a session grant',
  )
})

test('an ordinary tool on the same fixture does record one', async () => {
  // The control. Without it the case above would pass on a fixture that simply
  // never records anything — which is exactly what happened when this test used
  // `browser_eval`: it was sensitive, so it recorded nothing for that reason
  // while the assertion claimed the always-ask rule did it.
  const { tool, grants, asked, exec } = fixture({ scope: 'conversation' })
  await tool.execute({ tab_id: 7, selector: '#go' }, exec)

  assert.equal(asked[0].rememberable, undefined, 'a plain tool claimed it cannot remember')
  assert.equal(grants.covers(SESSION, ORIGIN, 'access'), true, 'the control recorded nothing either')
})

test('a sensitive action is asked every time, whatever the answer said', async () => {
  const { tool, grants, asked, exec } = fixture({ scope: 'conversation', args: { text: 'submit order' } })
  await tool.execute({ tab_id: 7, selector: '#buy', text: 'submit order' }, exec)

  assert.equal(asked[0].sensitive, true)
  assert.equal(asked[0].rememberable, false, 'the panel offered a session grant for a spend')
  assert.equal(grants.covers(SESSION, ORIGIN, 'access'), false, 'a sensitive action was remembered')
})

test('the kind of danger travels, so the panel is not stuck with one sentence', async () => {
  // The panel test asserts the wording it draws, but it feeds the question in
  // directly — so it cannot notice the host forgetting to forward the reason,
  // which is exactly what the first falsification of this showed.
  const { tool, asked, exec } = fixture({ args: { text: 'submit order' } })
  await tool.execute({ tab_id: 7, selector: '#buy', text: 'submit order' }, exec)

  assert.equal(typeof asked[0].sensitiveReason, 'string', 'the host kept the kind to itself')
  assert.match(asked[0].sensitiveReason, /submits or spends/, 'the wrong kind was forwarded')
})

test('an ordinary read carries no danger note at all', async () => {
  const { tool, asked, exec } = fixture({})
  await tool.execute({ tab_id: 7, selector: '#go' }, exec)

  assert.equal(asked[0].sensitive, undefined, 'a plain read was reported as dangerous')
  assert.equal(asked[0].sensitiveReason, undefined)
})

test('a surface that says nothing falls back to the configured default', async () => {
  // An older panel, or the graphical client, reports no scope. The setting is
  // what that case is for, and it must keep working.
  const { tool, grants, exec } = fixture({})
  await tool.execute({ tab_id: 7, selector: '#go' }, exec)

  const grant = grants.find(SESSION, ORIGIN, 'access')
  assert.notEqual(grant, undefined, 'the fallback stopped recording anything')
  assert.equal(grant.lifetime, 'thread', 'the configured default was not applied')
})

test('a deployment that shortened the lifetime still shortens it', async () => {
  const { tool, grants, exec } = fixture({ settings: { accessApprovalLifetime: 'turn' } })
  await tool.execute({ tab_id: 7, selector: '#go' }, exec)

  const grant = grants.find(SESSION, ORIGIN, 'access')
  assert.equal(grant.lifetime, 'turn', 'accessApprovalLifetime was ignored')
})

test('a refusal grants nothing at all', async () => {
  const { tool, grants, exec } = fixture({ verdict: 'rejected' })
  const value = await tool.execute({ tab_id: 7, selector: '#go' }, exec)

  assert.equal(grants.covers(SESSION, ORIGIN, 'access'), false, 'a refusal recorded a grant')
  // A gated tool reports a refusal as prose and no value; `ok` is only present
  // on the success shape, so its absence is the signal.
  assert.equal(value.ok, undefined, 'a refused click reported success')
  assert.match(value.text ?? '', /did not run: you declined/, 'the refusal was not explained')
})
