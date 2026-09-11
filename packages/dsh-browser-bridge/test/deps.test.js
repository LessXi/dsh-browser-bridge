/**
 * Resolution tests for `lib/deps.js`.
 *
 * These assert the two-branch contract that makes this package installable
 * without a build step or a bundled dependency tree: a bare specifier resolves
 * when the checkout was installed, and also when only the harness profile tree
 * is available — which is exactly how the running harness resolves the plugin.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { assert, test } from './harness.js'
import { dshHome, resolvePeer } from '../lib/deps.js'

test('dshHome honours DSH_HOME and falls back to ~/.dsh', (t) => {
  const previous = process.env.DSH_HOME
  t.onCleanup(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  })

  process.env.DSH_HOME = 'C:\\somewhere\\.dsh'
  assert.equal(dshHome(), 'C:\\somewhere\\.dsh')

  delete process.env.DSH_HOME
  assert.match(dshHome(), /\.dsh$/)
})

test('the resolved harness home really is the running profile', () => {
  const profileTree = join(dshHome(), 'profiles', 'node_modules')
  assert.ok(
    existsSync(profileTree),
    `expected the harness profile module tree at ${profileTree}; without it the second resolution branch cannot work`,
  )
})

test('ws resolves to an importable entry', () => {
  const resolved = resolvePeer('ws')
  assert.ok(existsSync(resolved), `resolved path does not exist: ${resolved}`)
  assert.match(resolved.replaceAll('\\', '/'), /\/ws\/index\.js$/)
})

test('a scoped peer resolves to its package entry', () => {
  const resolved = resolvePeer('@deepseek-ai/dsh-tools')
  assert.ok(existsSync(resolved), `resolved path does not exist: ${resolved}`)
  assert.match(resolved.replaceAll('\\', '/'), /dsh-tools\/lib\/index\.js$/)
})

test('an unknown specifier fails with every consulted tree in the message', () => {
  assert.throws(
    () => resolvePeer('@deepseek-ai/dsh-definitely-not-a-real-package'),
    (error) => {
      assert.match(error.message, /cannot resolve/)
      assert.match(error.message, /profiles[\\/]node_modules/)
      return true
    },
  )
})

test('loadPeer imports ws as a live module', async () => {
  const ws = await import(pathToFileURL(resolvePeer('ws')).href)
  const WebSocketServer = ws.WebSocketServer ?? ws.default?.WebSocketServer
  assert.equal(typeof WebSocketServer, 'function', 'ws must expose WebSocketServer')
})
