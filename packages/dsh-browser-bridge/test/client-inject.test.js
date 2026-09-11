/**
 * Contract tests for the browser half's dependency declaration.
 *
 * `lib/client.js` runs inside a Cordis fiber whose service reads are gated by
 * the plugin's own `inject` list: reading `ctx.<name>` for a service the list
 * omits throws `cannot get property "<name>" without inject` at apply time,
 * which surfaces as a failed loader entry and takes the whole package down.
 *
 * The bundle is a plain script that registers itself with the module loader, so
 * the declaration can be read without a browser: evaluate it against a stub
 * `window.__ModuleLoader__`, then compare the services `apply` actually reaches
 * against `exports.inject`. A service added without its declaration is the
 * exact regression this suite exists to catch.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assert, test } from './harness.js'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'lib', 'client.js')
const source = readFileSync(clientPath, 'utf8')

/**
 * Evaluate the bundle and return the plugin it registers.
 *
 * The bundle touches `document` while building its styles, so the stubs cover
 * the small DOM surface it uses; nothing here renders React.
 *
 * @returns {{ id: string, plugin: { inject?: string[], apply: (ctx: object) => void } }}
 */
function loadPlugin() {
  let registration
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')

  globalThis.window = { __ModuleLoader__: { load: (value) => { registration = value } } }
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: () => {} },
  }

  try {
    new Function(source)()
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else Object.defineProperty(globalThis, 'window', previousWindow)
    if (previousDocument === undefined) delete globalThis.document
    else Object.defineProperty(globalThis, 'document', previousDocument)
  }

  assert.ok(registration, 'client bundle did not register with window.__ModuleLoader__')
  const plugin = registration.factory((name) => {
    if (name === 'react') return { createElement: (...args) => ({ type: 'stub', args }) }
    throw new Error(`unexpected require: ${name}`)
  })
  return { id: registration.id, plugin }
}

/**
 * Build a ctx that mirrors the Cordis gate, recording every service read.
 *
 * A read of a provided service that the declaration omits throws the runtime's
 * own message, so a test can assert both the reachable set and the failure.
 *
 * @param {string[]} declared - The plugin's inject list.
 * @param {string[]} provided - Services this simulated deployment provides.
 * @returns {{ ctx: object, reads: string[], denied: string[] }}
 */
function gatedCtx(declared, provided) {
  const declaredSet = new Set(declared)
  const providedSet = new Set(provided)
  const reads = []
  const denied = []

  const services = {
    slots: { inject: () => () => {}, register: () => () => {} },
    locale: { register: () => () => {}, bind: () => () => {} },
    theme: { overrideTokens: () => () => {} },
  }

  const plain = {
    // Cordis runs the effect body synchronously and lets a throw escape; the
    // recorded failure therefore lands exactly where the browser reports it.
    effect: (fn) => fn(),
    on: () => () => {},
  }

  const ctx = new Proxy(plain, {
    get(target, prop) {
      if (typeof prop !== 'string') return Reflect.get(target, prop)
      if (Reflect.has(target, prop)) return Reflect.get(target, prop)
      reads.push(prop)
      if (providedSet.has(prop) && !declaredSet.has(prop)) {
        denied.push(prop)
        throw new Error(`cannot get property "${prop}" without inject`)
      }
      return services[prop]
    },
  })

  return { ctx, reads, denied }
}

test('the browser half declares every service its apply reaches', () => {
  const { plugin } = loadPlugin()
  assert.ok(Array.isArray(plugin.inject), 'client plugin must export an inject array')

  const provided = ['slots', 'locale', 'theme', 'timer']
  const { ctx, reads, denied } = gatedCtx(plugin.inject, provided)

  plugin.apply(ctx)
  assert.deepEqual(denied, [], `apply read undeclared service(s): ${denied.join(', ')}`)

  const services = reads.filter((name) => provided.includes(name))
  assert.ok(services.length > 0, 'expected apply to reach at least one service')
  for (const name of new Set(services)) {
    assert.ok(
      plugin.inject.includes(name),
      `apply reaches "${name}" but the inject list omits it — this is the failure that takes the package down`,
    )
  }
})

test('the settings card registers its locale dictionary', () => {
  const { plugin } = loadPlugin()
  assert.ok(plugin.inject.includes('locale'), 'the card calls ctx.locale.register, so locale must be injected')
})

test('the inject declaration is a string array with no duplicates', () => {
  const { plugin } = loadPlugin()
  assert.ok(plugin.inject.every((name) => typeof name === 'string' && name.length > 0))
  assert.equal(new Set(plugin.inject).size, plugin.inject.length, 'inject must not repeat a service')
})

test('the dsh.client manifest names packaged dependencies, not service names', () => {
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  const inject = pkg.dsh?.client?.inject
  assert.ok(Array.isArray(inject), 'dsh.client.inject must be an array')
  // This field lists browser packages the boot graph must mount first, so its
  // entries are package names. A bare service name like "slots" matches no
  // package and silently does nothing.
  for (const entry of inject) {
    assert.ok(
      entry.includes('/') || entry.startsWith('@'),
      `dsh.client.inject entry "${entry}" is not a package specifier`,
    )
  }
})
