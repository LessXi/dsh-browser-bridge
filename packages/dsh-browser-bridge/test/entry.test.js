/**
 * Entry-point tests for `lib/index.js`.
 *
 * HANDOVER §5 records that this module is never imported by the suite — every
 * other suite reaches around it and tests the pieces — and that two real defects
 * were found there by hand. Two more were found the same way, and both are
 * locked here:
 *
 *   1. the peer load was a `Promise.all`, which makes the ESM loader race
 *      `cosmokit`'s dual entry and fail with "Cannot require() ES Module ...
 *      because it is not yet fully loaded". It is deterministic on a cold cache
 *      and invisible on a warm one, which is why it survived.
 *   2. the health route echoed the first eight characters of the token, from the
 *      one route that authenticates nothing.
 *
 * The plugin can only be applied where the harness profile tree exists, because
 * that is where `loadPeer` resolves its peers. That is the same dependency
 * `deps.test.js` already asserts, so a checkout that can run this suite at all
 * can run these.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

import { assert, test } from './harness.js'

const require = createRequire(import.meta.url)

/** The repository root, from this file's location. */
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** The real harness home, which is where the peer module trees live. */
function realHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * A throwaway `DSH_HOME` with the real module tree linked in.
 *
 * `apply` mints a token file under `DSH_HOME`, so pointing it at the user's own
 * home would rewrite a live credential. Linking the real `node_modules` keeps
 * `loadPeer` resolving exactly the way it does in production while the token
 * lands somewhere disposable.
 *
 * @param {import('./harness.js').TestContext} t - The test context, for cleanup.
 * @returns {string} The temporary home.
 */
function temporaryHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'bb-entry-test-'))
  mkdirSync(join(home, 'profiles'), { recursive: true })
  const tree = join(realHome(), 'profiles', 'node_modules')
  if (existsSync(tree)) symlinkSync(tree, join(home, 'profiles', 'node_modules'), 'junction')

  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.onCleanup(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  })
  return home
}

/** Import the entry point fresh. */
async function loadEntry() {
  return import(pathToFileURL(join(repo, 'packages', 'dsh-browser-bridge', 'lib', 'index.js')).href)
}

/**
 * A context that lets `apply` run to completion and records what it registers.
 *
 * `effect` calls its function immediately and keeps the result as the disposer,
 * because that is what an effect is. A stub that only returns a function
 * registers nothing, and the routes then look absent on a working plugin.
 *
 * @returns {{ ctx: object, routes: Map<string, Function>, tools: string[] }}
 */
function fakeHost() {
  const routes = new Map()
  const tools = []
  const services = {
    webServer: {
      host: '127.0.0.1',
      register(spec) {
        routes.set(spec.path, spec.handler)
        return () => {}
      },
      registerUpgrade(spec) {
        routes.set(spec.path, spec.handler)
        return () => {}
      },
    },
    approval: {},
  }
  const ctx = {
    tools: { register: (tool) => { tools.push(tool.name); return () => {} } },
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    on: () => {},
    get: (name) => services[name],
    logger: { debug: () => {}, warn: () => {}, error: () => {} },
    inject: (names, fn) => fn({ ...ctx, ...services }),
  }
  return { ctx, routes, tools, services }
}

/**
 * Call one registered route from a given peer address.
 * @param {Map<string, Function>} routes - Registered handlers.
 * @param {string} path - The route path.
 * @param {{ address?: string, method?: string }} [options] - Request shape.
 * @returns {Promise<{ status: number | null, body: string, json: any }>} The answer.
 */
async function callRoute(routes, path, { address = '127.0.0.1', method = 'GET' } = {}) {
  const handler = routes.get(path)
  assert.ok(handler !== undefined, `expected ${path} to be registered`)
  const out = { status: null, body: '' }
  const res = {
    writeHead(status) { out.status = status },
    end(chunk) { out.body = chunk === undefined ? '' : String(chunk) },
    write(chunk) { out.body += String(chunk) },
  }
  await handler({ socket: { remoteAddress: address }, method, url: path, headers: {} }, res)
  let json
  try { json = JSON.parse(out.body) } catch { json = undefined }
  return { status: out.status, body: out.body, json }
}

test('the entry point applies, and registers every route and tool', async (t) => {
  temporaryHome(t)
  const plugin = await loadEntry()
  const { ctx, routes, tools } = fakeHost()

  await plugin.apply(ctx, undefined)

  // The four browser-facing routes plus the token route. Asserted as a set so a
  // route that stops being registered fails here rather than in production.
  assert.deepEqual([...routes.keys()].sort(), [
    '/api/browser-bridge/token',
    '/api/browser-bridge/ws',
    '/browser-bridge/chat',
    '/browser-bridge/context',
    '/browser-bridge/health',
  ])
  assert.equal(tools.length, 25, `expected 25 tools, got ${tools.length}`)
  assert.ok(routes.has('/api/browser-bridge/ws'), 'and the upgrade route is one of them')
})

test('the peers load sequentially, so a cold cache cannot race them', async (t) => {
  temporaryHome(t)
  const plugin = await loadEntry()

  // A fresh process is the only true cold cache, and this suite runs in one
  // already-warm process — so the race is asserted structurally instead. The
  // behaviour it protects was reproduced five times out of five: `Promise.all`
  // over these three specifiers throws on a cold cache, and a sequential loop
  // does not. The error comes from the loader itself, which is why a structural
  // check is the honest one available here.
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(join(repo, 'packages', 'dsh-browser-bridge', 'lib', 'index.js'), 'utf8')
  const applyBody = source.slice(source.indexOf('export async function apply'))

  assert.ok(
    !/Promise\.all\(\s*\[\s*\n\s*loadPeer/.test(applyBody),
    'the peer load must not be a Promise.all: cosmokit\'s dual entry races and the loader throws "not yet fully loaded"',
  )
  for (const specifier of ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-llm']) {
    assert.ok(applyBody.includes(`await loadPeer('${specifier}')`), `expected a sequential await for ${specifier}`)
  }

  // And it still applies, which is what the sequential form is for.
  const { ctx } = fakeHost()
  await plugin.apply(ctx, undefined)
})

test('the health route carries no fragment of the token', async (t) => {
  temporaryHome(t)
  const plugin = await loadEntry()
  const { ctx, routes } = fakeHost()
  await plugin.apply(ctx, undefined)

  const health = await callRoute(routes, '/browser-bridge/health')
  assert.equal(health.status, 200)

  // This route authenticates nothing — no token, no loopback check — because the
  // client UI and the extension both poll it before they can authenticate. So
  // the assertion is about the whole body, not one field: nothing that matches
  // the shape of the token may appear anywhere in it.
  const tokenShape = /^[0-9a-f]{8,64}$/
  const offenders = Object.entries(health.json)
    .filter(([, value]) => typeof value === 'string' && tokenShape.test(value))
    .map(([key]) => key)
  assert.deepEqual(offenders, [], `the health body leaks ${offenders.join(', ')}`)

  assert.ok(
    !Object.keys(health.json).some((key) => /hint/i.test(key)),
    'no field may hint at the token, even a truncated one',
  )
  // The length is a shape, not a secret, and the extension's options page
  // documents it as the check it performs.
  assert.equal(health.json.tokenLength, 64)
})

test('a request from the network is refused where the route reads user data', async (t) => {
  temporaryHome(t)
  const plugin = await loadEntry()
  const { ctx, routes } = fakeHost()
  await plugin.apply(ctx, undefined)

  const network = '203.0.113.9'

  // The token and the transcript both refuse a non-loopback peer. The health
  // route deliberately does not, which is why it is asserted the other way.
  assert.equal((await callRoute(routes, '/api/browser-bridge/token', { address: network })).status, 403)
  assert.equal((await callRoute(routes, '/browser-bridge/chat', { address: network })).status, 403)

  // The context route is split on purpose: reading what is staged is open, and
  // removing an attachment is not. A `DELETE` from the network must not land.
  const removal = await callRoute(routes, '/browser-bridge/context', { address: network, method: 'DELETE' })
  assert.equal(removal.status, 403, 'removing an attachment must be loopback-only')
})
