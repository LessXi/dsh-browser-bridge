/**
 * Tests for the bridge protocol in `lib/bridge.js`.
 *
 * These drive a fake socket instead of a real websocket, so they assert the
 * parts that are easy to get wrong and expensive to debug in a live browser:
 * request correlation, timeouts, cancellation, and — most importantly — that a
 * dead socket fails every outstanding call instead of leaving a tool call
 * hanging forever.
 */

import { EventEmitter } from 'node:events'

import { assert, test } from './harness.js'
import { BRIDGE_ERRORS, BridgeError, BridgeRegistry, parseFrame } from '../lib/bridge.js'
import { NOTIFICATIONS } from '../lib/protocol.js'

/**
 * A minimal stand-in for a `ws` socket: an event emitter that records what the
 * bridge sent and can play an inbound frame back.
 */
class FakeSocket extends EventEmitter {
  /** @type {string[]} */
  sent = []
  readyState = 1
  closed = false

  constructor() {
    super()
    // The connection compares against the socket's own OPEN constant, mirroring
    // the `ws` API where OPEN is an instance property.
    this.OPEN = 1
  }

  send(text) {
    this.sent.push(text)
  }

  close() {
    this.closed = true
    this.readyState = 3
    this.emit('close')
  }

  /** Deliver one extension→host frame. */
  deliver(object) {
    this.emit('message', Buffer.from(JSON.stringify(object)), false)
  }

  /** Deliver one raw extension→host frame. */
  deliverRaw(text) {
    this.emit('message', Buffer.from(text), false)
  }

  /** The last request the bridge sent, parsed. */
  lastRequest() {
    return JSON.parse(this.sent[this.sent.length - 1])
  }
}

test('parseFrame separates answers from events and rejects junk', () => {
  assert.deepEqual(parseFrame('{"event":"tabs/changed","payload":{"n":1}}'), {
    kind: 'event',
    event: 'tabs/changed',
    payload: { n: 1 },
  })
  assert.deepEqual(parseFrame('{"id":4,"ok":true,"value":42}'), { kind: 'answer', id: 4, ok: true, value: 42 })
  assert.deepEqual(parseFrame('{"id":5,"ok":false,"code":"cdp-failed","message":"boom"}'), {
    kind: 'answer',
    id: 5,
    ok: false,
    code: 'cdp-failed',
    message: 'boom',
  })
  assert.equal(parseFrame('{').kind, 'invalid')
  assert.equal(parseFrame('[]').kind, 'invalid')
  assert.equal(parseFrame('{"ok":true}').kind, 'invalid')
  assert.equal(parseFrame(7).kind, 'invalid')
})

test('an answer without a code still produces a typed remote failure', () => {
  const frame = parseFrame('{"id":1,"ok":false}')
  assert.equal(frame.kind, 'answer')
  assert.equal(frame.code, BRIDGE_ERRORS.remote)
  assert.equal(typeof frame.message, 'string')
})

test('registry starts disconnected and adopts a connection', () => {
  const registry = new BridgeRegistry()
  assert.equal(registry.connected, false)
  assert.equal(registry.connection, undefined)

  const connection = registry.adopt(new FakeSocket())
  assert.equal(registry.connected, true)
  assert.equal(registry.connection, connection)

  registry.dispose()
  assert.equal(registry.connected, false)
})

test('registry notifies observers on connect and disconnect, and stops after dispose', () => {
  const registry = new BridgeRegistry()
  let transitions = 0
  const unsubscribe = registry.onChange(() => {
    transitions += 1
  })

  const socket = new FakeSocket()
  registry.adopt(socket)
  assert.equal(transitions, 1, 'adopting a socket is a transition')

  socket.close()
  assert.equal(transitions, 2, 'losing the socket is a transition')

  unsubscribe()
  registry.adopt(new FakeSocket())
  assert.equal(transitions, 2, 'an unsubscribed observer must stop hearing about transitions')
  registry.dispose()
})

test('adopting a second socket closes the first', () => {
  const registry = new BridgeRegistry()
  const first = new FakeSocket()
  registry.adopt(first)
  const firstConnection = registry.connection

  registry.adopt(new FakeSocket())
  assert.equal(first.closed, true, 'the stale socket must be closed so one connection stays authoritative')
  assert.notEqual(registry.connection, firstConnection)
  registry.dispose()
})

test('call sends a correlated request and resolves with the answer', async () => {
  const socket = new FakeSocket()
  const registry = new BridgeRegistry()
  const connection = registry.adopt(socket)

  const pending = connection.call('tabs.list', { group: 'dsn' })
  const request = socket.lastRequest()
  assert.equal(request.method, 'tabs.list')
  assert.deepEqual(request.params, { group: 'dsn' })
  assert.equal(typeof request.id, 'number')

  socket.deliver({ id: request.id, ok: true, value: [{ id: 7 }] })
  assert.deepEqual(await pending, [{ id: 7 }])
  assert.equal(connection.pendingCount, 0)
  registry.dispose()
})

test('a remote failure rejects with its code and message', async () => {
  const socket = new FakeSocket()
  const connection = new BridgeRegistry().adopt(socket)

  const pending = connection.call('cdp.send', {})
  socket.deliver({ id: socket.lastRequest().id, ok: false, code: 'cdp-failed', message: 'cannot attach' })

  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof BridgeError)
    assert.equal(error.code, 'cdp-failed')
    assert.match(error.message, /cannot attach/)
    return true
  })
})

test('an unknown answer id is ignored rather than resolving a stranger', async () => {
  const socket = new FakeSocket()
  const connection = new BridgeRegistry().adopt(socket)

  const pending = connection.call('tabs.list', {})
  socket.deliver({ id: 999_999, ok: true, value: 'not yours' })
  assert.equal(connection.pendingCount, 1, 'the real call must still be waiting')
  socket.deliver({ id: socket.lastRequest().id, ok: true, value: 'yours' })
  assert.equal(await pending, 'yours')
})

test('a malformed frame does not break the connection', async () => {
  const socket = new FakeSocket()
  const connection = new BridgeRegistry().adopt(socket)
  const seen = []
  socket.on('bridge-protocol-error', (reason) => seen.push(reason))

  const pending = connection.call('tabs.list', {})
  socket.deliverRaw('}{ not json')
  assert.equal(seen.length, 1, 'the malformed frame must be reported')

  socket.deliver({ id: socket.lastRequest().id, ok: true, value: 'ok' })
  assert.equal(await pending, 'ok', 'a later well-formed answer must still settle the call')
})

test('calls time out with a diagnostic naming the method', async () => {
  const socket = new FakeSocket()
  const connection = new BridgeRegistry().adopt(socket)

  const pending = connection.call('page.snapshot', {}, { timeoutMs: 10 })
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, BRIDGE_ERRORS.timeout)
    assert.match(error.message, /page\.snapshot/)
    return true
  })
})

test('an already-aborted signal rejects without sending', async () => {
  const socket = new FakeSocket()
  const connection = new BridgeRegistry().adopt(socket)

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    connection.call('tabs.list', {}, { signal: controller.signal }),
    (error) => error.code === BRIDGE_ERRORS.cancelled,
  )
  assert.equal(socket.sent.length, 0, 'nothing should reach the wire for an aborted call')
})

test('aborting mid-flight rejects the call and settles once', async () => {
  const socket = new FakeSocket()
  const connection = new BridgeRegistry().adopt(socket)

  const controller = new AbortController()
  const pending = connection.call('page.click', {}, { signal: controller.signal })
  const id = socket.lastRequest().id
  controller.abort()
  await assert.rejects(pending, (error) => error.code === BRIDGE_ERRORS.cancelled)
  assert.equal(connection.pendingCount, 0)

  // A late answer for the abandoned id must be a no-op, not a double settle.
  socket.deliver({ id, ok: true, value: 'late' })
  assert.equal(connection.pendingCount, 0)
})

test('aborting mid-flight tells the extension to stop working', async () => {
  // Rejecting here only ends the host's wait. The extension keeps polling or
  // waiting for a load, so for the slow methods — `page.waitFor` polls for
  // fifteen seconds and `page.navigate` waits twenty for a load — pressing Stop
  // left the browser still driving the page. This is the frame that ends it, and
  // the id is what lets the extension find the work it still has in flight.
  const socket = new FakeSocket()
  const connection = new BridgeRegistry().adopt(socket)

  const controller = new AbortController()
  const pending = connection.call('page.waitFor', { tabId: 7 }, { signal: controller.signal })
  const id = socket.lastRequest().id
  controller.abort()
  await assert.rejects(pending, (error) => error.code === BRIDGE_ERRORS.cancelled)

  // `sent` holds the raw frame text, the same thing the `ws` socket would have
  // written, so it is parsed rather than read as an object.
  const frames = socket.sent.map((text) => JSON.parse(text))
  const notification = frames.find((frame) => frame.notify === NOTIFICATIONS.callCancelled)
  assert.notEqual(notification, undefined, 'the extension was never told the call was over')
  assert.equal(notification.payload?.id, id, 'the cancellation named a different request')
})

test('a call that is never aborted sends no cancellation', async () => {
  // The notification is emitted from the abort path only. A call that simply
  // answers must not leave a stray frame behind, or the extension would be told
  // to stop work that already finished — and, worse, the id would be free to be
  // reused while the extension still remembered it.
  const socket = new FakeSocket()
  const connection = new BridgeRegistry().adopt(socket)

  const pending = connection.call('page.waitFor', { tabId: 7 }, {})
  const id = socket.lastRequest().id
  socket.deliver({ id, ok: true, value: { satisfied: true } })
  await pending

  assert.equal(
    socket.sent.map((text) => JSON.parse(text)).some((frame) => frame.notify === NOTIFICATIONS.callCancelled),
    false,
    'a call that answered on its own still sent a cancellation',
  )
})

test('closing the socket fails every outstanding call', async () => {
  const socket = new FakeSocket()
  const registry = new BridgeRegistry()
  const connection = registry.adopt(socket)

  const first = connection.call('page.click', {})
  const second = connection.call('page.type', {})
  assert.equal(connection.pendingCount, 2)

  socket.close()

  for (const pending of [first, second]) {
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, BRIDGE_ERRORS.disconnected)
      assert.match(error.message, /while awaiting (page\.click|page\.type)/, 'the message must name the stranded method')
      return true
    })
  }
  assert.equal(connection.pendingCount, 0)
  assert.equal(registry.connected, false)
})

test('a call on a disposed registry rejects as not connected, not as a hang', async () => {
  const socket = new FakeSocket()
  const connection = new BridgeRegistry().adopt(socket)
  socket.close()

  await assert.rejects(
    connection.call('tabs.list', {}),
    (error) => {
      assert.equal(error.code, BRIDGE_ERRORS.notConnected)
      assert.match(error.message, /extension is not connected/)
      return true
    },
  )
})

test('events reach subscribers and a throwing subscriber is contained', () => {
  const socket = new FakeSocket()
  const connection = new BridgeRegistry().adopt(socket)
  const seen = []

  const unsubscribe = connection.on('console/entry', (payload) => seen.push(payload))
  connection.on('console/entry', () => {
    throw new Error('subscriber blew up')
  })

  socket.deliver({ event: 'console/entry', payload: { text: 'hello' } })
  socket.deliver({ event: 'console/entry', payload: { text: 'again' } })
  assert.equal(seen.length, 2, 'a throwing subscriber must not stop delivery to the others')

  unsubscribe()
  socket.deliver({ event: 'console/entry', payload: { text: 'third' } })
  assert.equal(seen.length, 2)
})
