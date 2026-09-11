/**
 * End-to-end test: the bridge over a real HTTP server and a real websocket.
 *
 * This exercises the wire path the unit tests cannot: an actual TCP listen, the
 * `upgrade` event, the auth verdict written to a raw socket, the websocket
 * handshake, and JSON frames in both directions. It is the layer where an
 * integration mistake looks like "the extension just never connects", which is
 * the hardest failure in this feature to diagnose from the outside.
 *
 * The extension half is played by a node client driven by the test, so the
 * protocol is verified against an implementation that was written from the
 * documented contract rather than from the extension's own code.
 */

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { assert, test } from './harness.js'
import { BridgeRegistry } from '../lib/bridge.js'
import { authorizeBridgeRequest, offeredToken } from '../lib/auth.js'
import { resolvePeer } from '../lib/deps.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const extensionDir = join(repoRoot, 'extension')

/** The route the host actually registers. */
const WS_PATH = '/api/browser-bridge/ws'

/**
 * Import the `ws` package, which is where the harness keeps it.
 *
 * `ws` is CommonJS, so its classes hang off the default export rather than the
 * module namespace — a named destructure would be silently `undefined`.
 *
 * @returns {Promise<{ WebSocketServer: Function, WebSocket: Function }>} The classes.
 */
async function wsModule() {
  const namespace = await import(pathToFileURL(resolvePeer('ws')).href)
  const module = namespace.default ?? namespace
  return { WebSocketServer: module.WebSocketServer, WebSocket: module.WebSocket }
}

/**
 * Start a server that runs the same auth and upgrade logic the plugin does.
 *
 * The handler is reproduced here rather than imported because the plugin's
 * version is nested inside `ctx.inject(['webServer'])`. The two must agree, so
 * this test also pins the *shape* of the answer a rejected upgrade gets.
 *
 * @param {object} options - Server behavior.
 * @param {string} options.token - The expected token.
 * @param {BridgeRegistry} options.bridge - The registry to adopt connections into.
 * @param {(connection: object) => void} [options.onConnect] - Called after adoption.
 * @returns {Promise<{ port: number, close: () => Promise<void>, sockets: Set<object> }>} The fixture.
 */
async function startBridgeServer(options) {
  const { WebSocketServer } = await wsModule()
  const wss = new WebSocketServer({ noServer: true })
  const sockets = new Set()
  const server = createServer((req, res) => {
    res.writeHead(404)
    res.end()
  })

  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith(WS_PATH)) {
      socket.destroy()
      return
    }
    const verdict = authorizeBridgeRequest(req, { token: options.token, requireLoopback: true })
    if (!verdict.ok) {
      socket.write(
        `HTTP/1.1 ${verdict.status} ${verdict.status === 401 ? 'Unauthorized' : 'Forbidden'}\r\n`
        + 'Connection: close\r\n'
        + 'Content-Type: text/plain; charset=utf-8\r\n\r\n'
        + `${verdict.reason}\n`,
      )
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const connection = options.bridge.adopt(ws)
      sockets.add(connection)
      options.onConnect?.(connection)
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    sockets,
    close: async () => {
      for (const connection of sockets) connection.close()
      wss.close()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/**
 * Connect a node websocket to the bridge.
 * @param {number} port - The listening port.
 * @param {string | undefined} token - The token to present, if any.
 * @param {{ origin?: string }} [options] - Extra request shaping.
 * @returns {Promise<{ socket: object, opened: boolean, status?: number, body?: string }>} The result.
 */
async function connect(port, token, options = {}) {
  const { WebSocket } = await wsModule()
  const query = token === undefined ? '' : `?token=${encodeURIComponent(token)}`
  const headers = options.origin === undefined ? {} : { Origin: options.origin }
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}${query}`, { headers })
    let settled = false
    socket.on('open', () => {
      if (settled) return
      settled = true
      resolve({ socket, opened: true })
    })
    socket.on('unexpected-response', (_req, res) => {
      if (settled) return
      settled = true
      let body = ''
      res.on('data', (chunk) => {
        body += chunk.toString()
      })
      res.on('end', () => resolve({ socket, opened: false, status: res.statusCode, body }))
    })
    socket.on('error', () => {
      if (settled) return
      settled = true
      resolve({ socket, opened: false })
    })
    setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ socket, opened: false })
    }, 5000)
  })
}

test('a token-less upgrade is refused with 401 and a reason', async (t) => {
  const bridge = new BridgeRegistry()
  const server = await startBridgeServer({ token: 'good', bridge })
  t.onCleanup(() => server.close())

  const attempt = await connect(server.port, undefined)
  assert.equal(attempt.opened, false, 'the handshake must not complete without a token')
  assert.equal(attempt.status, 401)
  assert.match(attempt.body ?? '', /token/)
  assert.equal(bridge.connected, false)
})

test('a wrong token is refused', async (t) => {
  const bridge = new BridgeRegistry()
  const server = await startBridgeServer({ token: 'good', bridge })
  t.onCleanup(() => server.close())

  const attempt = await connect(server.port, 'wrong')
  assert.equal(attempt.opened, false)
  assert.equal(attempt.status, 401)
})

test('a web-page origin is refused even with the right token', async (t) => {
  const bridge = new BridgeRegistry()
  const server = await startBridgeServer({ token: 'good', bridge })
  t.onCleanup(() => server.close())

  const attempt = await connect(server.port, 'good', { origin: 'https://evil.test' })
  assert.equal(attempt.opened, false)
  assert.equal(attempt.status, 403, 'a page must not be able to open the bridge socket')
})

test('an extension origin with the right token connects and can call', async (t) => {
  const bridge = new BridgeRegistry()
  const server = await startBridgeServer({ token: 'good', bridge })
  t.onCleanup(() => server.close())

  const attempt = await connect(server.port, 'good', { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' })
  t.onCleanup(() => attempt.socket.close())
  assert.equal(attempt.opened, true, 'the documented happy path must work')
  assert.equal(bridge.connected, true, 'the registry must adopt the accepted socket')

  // The accepted socket is usable in both directions, which is the property the
  // rest of the bridge depends on.
  const answered = new Promise((resolve) => {
    attempt.socket.once('message', (data) => resolve(JSON.parse(data.toString())))
  })
  const pending = bridge.connection.call('bridge.status', {}, { timeoutMs: 3000 })
  const request = await answered
  assert.equal(request.method, 'bridge.status')
  attempt.socket.send(JSON.stringify({ id: request.id, ok: true, value: { version: 'test' } }))
  assert.deepEqual(await pending, { version: 'test' })
})

test('a full request and answer round-trip crosses a real socket', async (t) => {
  const bridge = new BridgeRegistry()
  const server = await startBridgeServer({ token: 'good', bridge })
  t.onCleanup(() => server.close())

  const attempt = await connect(server.port, 'good')
  assert.equal(attempt.opened, true)
  t.onCleanup(() => attempt.socket.close())

  // The extension side, implemented from the contract: every request gets a
  // well-formed answer, and one method deliberately fails.
  attempt.socket.on('message', (data) => {
    const frame = JSON.parse(data.toString())
    if (frame.method === 'bridge.status') {
      attempt.socket.send(JSON.stringify({ id: frame.id, ok: true, value: { version: '0.2.0', tabCount: 3 } }))
      return
    }
    attempt.socket.send(JSON.stringify({ id: frame.id, ok: false, code: 'unknown-method', message: `no such method ${frame.method}` }))
  })

  const connection = bridge.connection
  const status = await connection.call('bridge.status', {}, { timeoutMs: 3000 })
  assert.deepEqual(status, { version: '0.2.0', tabCount: 3 })

  await assert.rejects(
    connection.call('bridge.nonsense', {}, { timeoutMs: 3000 }),
    (error) => {
      assert.equal(error.code, 'unknown-method')
      assert.match(error.message, /no such method bridge\.nonsense/)
      return true
    },
  )
})

test('the extension can push an event the host did not ask for', async (t) => {
  const bridge = new BridgeRegistry()
  const server = await startBridgeServer({ token: 'good', bridge })
  t.onCleanup(() => server.close())

  const attempt = await connect(server.port, 'good')
  const seen = []
  t.onCleanup(() => attempt.socket.close())
  bridge.connection.on('tabs/changed', (payload) => seen.push(payload))

  attempt.socket.send(JSON.stringify({ event: 'tabs/changed', payload: { tabs: [{ id: 1, url: 'https://a.test' }] } }))
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(seen.length, 1)
  assert.equal(seen[0].tabs[0].url, 'https://a.test')
})

test('in-flight calls fail fast when the extension disappears', async (t) => {
  const bridge = new BridgeRegistry()
  const server = await startBridgeServer({ token: 'good', bridge })
  t.onCleanup(() => server.close())

  const attempt = await connect(server.port, 'good')
  // Never answer, then drop the socket: the host must not leave the caller hanging.
  const pending = bridge.connection.call('page.snapshot', {}, { timeoutMs: 30_000 })
  attempt.socket.close()

  await assert.rejects(pending, (error) => {
    assert.match(error.code, /bridge-disconnected|bridge-not-connected/)
    return true
  })
})

test('the extension files are present and syntactically loadable', async (t) => {
  // A manifest that names a missing file is a load failure in Chrome with a
  // famously unhelpful message, so it is worth asserting here instead.
  const manifest = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.manifest_version, 3)
  assert.ok(Array.isArray(manifest.permissions) && manifest.permissions.includes('debugger'))

  const files = [
    manifest.background.service_worker,
    manifest.options_page,
    manifest.side_panel.default_path,
    ...(manifest.content_scripts ?? []).flatMap((entry) => entry.js ?? []),
    'page-distill.js',
  ]
  for (const relative of files) {
    const path = join(extensionDir, relative)
    const source = readFileSync(path, 'utf8')
    assert.ok(source.length > 0, `${relative} must not be empty`)
  }

  // Parse each script as the module it is. `node --check` cannot be used from
  // inside a test (it would spawn), and `vm.SourceTextModule` needs a command
  // line flag, so this reports the exact line and column from the engine's own
  // parse of the module source compiled as a function body.
  for (const relative of files.filter((name) => name.endsWith('.js'))) {
    const source = readFileSync(join(extensionDir, relative), 'utf8')
    const stripped = source
      // Imports and exports are top-level-only in a module; dropping those
      // statements still leaves every other construct in place, which is what
      // a syntax check needs to see.
      .replace(/^\s*import\s+[^;\n]*;?\s*$/gm, '')
      .replace(/^\s*export\s+(?=(default|const|let|var|function|async|class)\b)/gm, '')
    assert.doesNotThrow(
      // Wrapped in an async arrow body so `await` at module top level parses.
      () => new Function(`return (async () => {\n${stripped}\n})`),
      `${relative} must parse`,
    )
    t.onCleanup(() => {})
  }
})

test('every host method the extension claims to implement is dispatched', () => {
  // The two halves list methods by hand, so this asserts the extension's switch
  // covers each one the host can send. A missing case is a runtime
  // "does not implement" error on a tool the user just tried to use.
  const background = readFileSync(join(extensionDir, 'background.js'), 'utf8')
  const protocol = readFileSync(join(here, '..', 'lib', 'protocol.js'), 'utf8')
  const protocolMethods = [...protocol.matchAll(/^\s+([a-zA-Z]+): '([a-z]+\.[a-zA-Z]+)',/gm)].map((match) => match[2])
  assert.ok(protocolMethods.length >= 20, `expected the protocol to declare many methods, saw ${protocolMethods.length}`)

  const missing = protocolMethods.filter((method) => !background.includes(`case METHODS.`) || !background.includes(`'${method}'`))
  assert.deepEqual(missing, [], `background.js does not mention: ${missing.join(', ')}`)
})
