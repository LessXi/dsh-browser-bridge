import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createChat, imageBlocks, textBlocks } from '../lib/chat.js'

/** An image block exactly as the harness writes one into a session log. */
function imageBlock(attachmentId, extra = {}) {
  return {
    type: 'image',
    attachment: {
      attachmentId,
      mediaType: 'image/png',
      bytes: 112836,
      width: 760,
      height: 1440,
      name: 'shot.png',
      ...extra,
    },
  }
}

/** A user message carrying whatever blocks are given. */
function userEvent(content) {
  return { seq: 1, time: 1, type: 'user/message', data: { content, source: { kind: 'user' } } }
}

/** A chat surface whose only session holds the given events. */
function chatWith(events, attachments) {
  return createChat({
    sessions: { get: () => undefined },
    workspaces: { list: async () => ({ groups: [] }) },
    commands: {
      list: async () => ({ items: [] }),
      inspect: async () => ({ meta: { title: 't' }, events }),
      create: async () => ({ sessionId: 's' }),
      prompt: async () => undefined,
    },
    attachments,
  })
}

const ID = 'sha256:bb6f47048c0e73b3277ddeecbd5818ab85922b4fa1c0c8caf5dbda6997d84eba'

test('a message that is only a picture is still a message', async () => {
  const chat = chatWith([userEvent([imageBlock(ID)])])
  const { messages } = await chat.readMessages('s')
  assert.equal(messages.length, 1, 'the row exists at all')
  assert.equal(messages[0].kind, 'user')
  assert.equal(messages[0].text, '')
  assert.equal(messages[0].images.length, 1)
  assert.equal(messages[0].images[0].attachmentId, ID)
})

test('a caption and its picture both survive', async () => {
  const chat = chatWith([userEvent([{ type: 'text', text: '看这个' }, imageBlock(ID)])])
  const { messages } = await chat.readMessages('s')
  assert.equal(messages[0].text, '看这个')
  assert.deepEqual(messages[0].images.map((i) => i.attachmentId), [ID])
})

test('the order the pictures were sent in is the order they come back', async () => {
  const a = `sha256:${'a'.repeat(64)}`
  const b = `sha256:${'b'.repeat(64)}`
  const chat = chatWith([userEvent([imageBlock(a), { type: 'text', text: 'x' }, imageBlock(b)])])
  const { messages } = await chat.readMessages('s')
  assert.deepEqual(messages[0].images.map((i) => i.attachmentId), [a, b])
})

test('a row with no pictures carries no images field at all', async () => {
  const chat = chatWith([userEvent([{ type: 'text', text: 'just words' }])])
  const { messages } = await chat.readMessages('s')
  assert.equal('images' in messages[0], false, 'absent, not an empty array')
})

test('an image block with inline bytes instead of a reference is skipped', () => {
  // No `attachment`, so there is no id to fetch it by later. Half-reading it
  // would put a picture in the row that no route can ever serve.
  const found = imageBlocks([{ type: 'image', data: 'AAAA', mediaType: 'image/png' }])
  assert.deepEqual(found, [])
})

test('a reference with no id is skipped rather than guessed at', () => {
  assert.deepEqual(imageBlocks([{ type: 'image', attachment: { mediaType: 'image/png' } }]), [])
  assert.deepEqual(imageBlocks([{ type: 'image', attachment: { attachmentId: '' } }]), [])
})

test('a missing dimension is left out rather than defaulted', () => {
  // A made-up aspect ratio would shift the transcript when the picture loads,
  // which is the jump the reserved box exists to prevent.
  const found = imageBlocks([imageBlock(ID, { width: undefined, height: undefined })])
  assert.equal(found[0].width, 0)
  assert.equal(found[0].height, 0)
})

test('the media type falls back rather than reaching the wire empty', () => {
  const found = imageBlocks([imageBlock(ID, { mediaType: undefined })])
  assert.equal(found[0].mediaType, 'application/octet-stream')
})

test('a picture injected by a plugin is not treated as something the reader sent', async () => {
  const event = userEvent([imageBlock(ID)])
  event.data.source = { kind: 'plugin', plugin: 'x', form: 'snapshot' }
  const chat = chatWith([event])
  const { messages } = await chat.readMessages('s')
  assert.equal(messages.length, 0, 'context is not a question')
})

test('reading an image the session never mentioned is refused', async () => {
  const chat = chatWith([userEvent([{ type: 'text', text: 'no pictures here' }])], {
    readImage: async () => ({ data: new Uint8Array([1, 2, 3]) }),
  })
  await assert.rejects(
    () => chat.readImage('s', ID),
    /not part of this session/,
    'an opaque id is still a capability',
  )
})

test('an image the session does refer to is read through the store', async () => {
  const asked = []
  const bytes = new Uint8Array([137, 80, 78, 71])
  const chat = chatWith([userEvent([imageBlock(ID)])], {
    readImage: async (ref) => {
      asked.push(ref.attachmentId)
      return { ref, data: bytes }
    },
  })
  const image = await chat.readImage('s', ID)
  assert.deepEqual(asked, [ID])
  assert.deepEqual([...image.data], [...bytes])
  assert.equal(image.mediaType, 'image/png')
})

test('a harness with no attachment store says so instead of throwing a type error', async () => {
  const chat = chatWith([userEvent([imageBlock(ID)])])
  await assert.rejects(() => chat.readImage('s', ID), /does not expose an attachment store/)
})

test('a store that returns no bytes is refused, not rendered as a broken picture', async () => {
  const chat = chatWith([userEvent([imageBlock(ID)])], { readImage: async () => ({ data: undefined }) })
  await assert.rejects(() => chat.readImage('s', ID), /returned no image bytes/)
})

test('a message that is only a picture offers no question to put back', async () => {
  // `failure.putBack` fills the composer with the question the turn opened
  // with. A turn that opened with a bare picture has no such text, and
  // inventing one would put words in the reader's mouth.
  const events = [
    { seq: 1, time: 1, type: 'turn/start', data: { turn: 1 } },
    userEvent([imageBlock(ID)]),
    { seq: 3, time: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'error', code: 'X', message: 'boom' } } },
  ]
  const chat = chatWith(events)
  const { messages } = await chat.readMessages('s')
  const failed = messages.find((row) => row.kind === 'failed')
  assert.ok(failed !== undefined, 'the turn still failed')
  assert.equal('question' in failed, false)
})

test('textBlocks and imageBlocks split one content array without overlap', () => {
  const content = [{ type: 'text', text: 'words' }, imageBlock(ID), { type: 'reasoning', text: 'why' }]
  assert.equal(textBlocks(content), 'words')
  assert.deepEqual(imageBlocks(content).map((i) => i.attachmentId), [ID])
})

// ── The route ───────────────────────────────────────────────────────────────
//
// Authorization lives at the HTTP layer, not in `readImage`: the route is what
// decides who may ask at all, and it is where the headers that keep a stored
// image from being treated as a document are set. None of that is reachable
// through `createChat`, so it is exercised here against the real entry point.

const REPO = join(import.meta.dirname, '..', '..', '..')

/** A temporary harness home with the real module tree linked in. */
function temporaryHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-image-home-'))
  // `apply` reaches the harness through `loadPeer`, which resolves from
  // `DSH_HOME`. Linking the real tree keeps that resolution exactly as it is in
  // production while the state it writes lands somewhere disposable.
  mkdirSync(join(home, 'profiles'), { recursive: true })
  const real = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const tree = join(real, 'profiles', 'node_modules')
  if (existsSync(tree)) symlinkSync(tree, join(home, 'profiles', 'node_modules'), 'junction')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  })
  return home
}

/**
 * A host that lets `apply` finish and keeps what it registered.
 * @param {object} [services] - Extra services the entry point may reach for.
 * @returns {object} The context and the recorded registrations.
 */
function fakeHost(services = {}) {
  const routes = new Map()
  const tools = []
  const provided = {
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
    ...services,
  }
  const ctx = {
    tools: { register: (tool) => { tools.push(tool.name); return () => {} } },
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    on: () => {},
    get: (name) => provided[name],
    logger: { debug: () => {}, warn: () => {}, error: () => {} },
    inject: (names, fn) => fn({ ...ctx, ...provided }),
  }
  return { ctx, routes, tools }
}

/**
 * Call one registered route and collect its answer.
 * @param {Map<string, Function>} routes - What `apply` registered.
 * @param {string} url - The path and query, as the request line would carry it.
 * @param {{ address?: string, method?: string }} [options] - Request shape.
 * @returns {Promise<{ status: number|null, body: string, headers: object, bytes: Buffer|null }>} The answer.
 */
async function callRoute(routes, url, { address = '127.0.0.1', method = 'GET' } = {}) {
  const path = url.split('?')[0]
  const handler = routes.get(path)
  assert.ok(handler !== undefined, `expected ${path} to be registered`)
  const out = { status: null, body: '', headers: {}, bytes: null }
  const res = {
    writeHead(status, headers) {
      out.status = status
      Object.assign(out.headers, headers ?? {})
    },
    end(chunk) {
      if (chunk === undefined) return
      if (Buffer.isBuffer(chunk)) out.bytes = chunk
      else out.body += String(chunk)
    },
    write(chunk) { out.body += String(chunk) },
  }
  await handler({ socket: { remoteAddress: address }, method, url, headers: {} }, res)
  // The registered handler is synchronous and dispatches the real work onto a
  // promise it only catches — so returning from it does not mean the response
  // has been written. Without this wait every route test would read
  // `status: null` and pass its negative assertions for the wrong reason.
  await new Promise((resolve) => setTimeout(resolve, 0))
  return out
}

/** The bytes a fake store hands back for one id. */
const BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

/** An entry point wired to a session that refers to exactly one image. */
async function entryWithImage(t, extra = {}) {
  temporaryHome(t)
  const plugin = await import(`${pathToFileURL(join(REPO, 'packages', 'dsh-browser-bridge', 'lib', 'index.js')).href}?image=${Math.random()}`)
  const read = []
  const host = fakeHost({
    sessions: { get: () => undefined },
    workspaceRegistry: { list: async () => ({ groups: [] }) },
    sessionController: {
      list: async () => ({ items: [{ id: 's', cwd: 'E:\\work', projections: { asOfSeq: 0, values: {} } }] }),
      inspect: async () => ({ meta: { title: 't' }, events: [userEvent([imageBlock(ID)])] }),
      commands: { readSessionState: async () => ({ events: [userEvent([imageBlock(ID)])] }) },
    },
    attachments: {
      readImage: async (ref) => {
        read.push(ref.attachmentId)
        return { ref, data: BYTES }
      },
    },
    ...extra.services,
  })
  await plugin.apply(host.ctx, undefined)
  return { host, read }
}

test('the image route answers the bytes with the reference’s own media type', async (t) => {
  const { host, read } = await entryWithImage(t)
  const answer = await callRoute(host.routes, `/browser-bridge/image?sessionId=s&attachmentId=${encodeURIComponent(ID)}`)
  assert.equal(answer.status, 200)
  assert.equal(answer.headers['content-type'], 'image/png')
  assert.deepEqual([...answer.bytes], [...BYTES], 'the exact bytes, not a re-encoding')
  assert.deepEqual(read, [ID], 'read through the harness store')
})

test('a stored image is never served as a document', async (t) => {
  // An SVG in the reader's own conversation would otherwise be an inline
  // document on this origin — the panel's own origin, which can reach the
  // bridge. The bytes are content-addressed and the media type is the store's,
  // so the only thing standing between them and script execution is this.
  const { host } = await entryWithImage(t)
  const answer = await callRoute(host.routes, `/browser-bridge/image?sessionId=s&attachmentId=${encodeURIComponent(ID)}`)
  assert.equal(answer.headers['x-content-type-options'], 'nosniff')
  assert.match(String(answer.headers['content-security-policy']), /default-src 'none'/, 'no document capabilities')
  assert.match(String(answer.headers['content-security-policy']), /sandbox/)
})

test('the bytes may be cached forever, because the id is a content address', async (t) => {
  const { host } = await entryWithImage(t)
  const answer = await callRoute(host.routes, `/browser-bridge/image?sessionId=s&attachmentId=${encodeURIComponent(ID)}`)
  assert.match(String(answer.headers['cache-control']), /immutable/)
  assert.equal(answer.headers['content-length'], String(BYTES.byteLength))
})

test('an image the session never refers to is refused, not served', async (t) => {
  const { host, read } = await entryWithImage(t)
  const other = `sha256:${'9'.repeat(64)}`
  const answer = await callRoute(host.routes, `/browser-bridge/image?sessionId=s&attachmentId=${encodeURIComponent(other)}`)
  assert.equal(answer.status, 404, 'a refusal, not a server fault')
  assert.deepEqual(read, [], 'and the store is never reached')
})

test('the image route is reachable only from this machine', async (t) => {
  const { host } = await entryWithImage(t)
  const answer = await callRoute(
    host.routes,
    `/browser-bridge/image?sessionId=s&attachmentId=${encodeURIComponent(ID)}`,
    { address: '10.0.0.7' },
  )
  assert.equal(answer.status, 403)
})

test('a request naming one thing and not the other is refused before any read', async (t) => {
  const { host, read } = await entryWithImage(t)
  const noId = await callRoute(host.routes, '/browser-bridge/image?sessionId=s')
  assert.equal(noId.status, 400)
  const noSession = await callRoute(host.routes, `/browser-bridge/image?attachmentId=${encodeURIComponent(ID)}`)
  assert.equal(noSession.status, 400)
  assert.deepEqual(read, [], 'nothing is looked up for a request that cannot name an image')
})

test('HEAD answers the headers without the bytes', async (t) => {
  const { host } = await entryWithImage(t)
  const answer = await callRoute(
    host.routes,
    `/browser-bridge/image?sessionId=s&attachmentId=${encodeURIComponent(ID)}`,
    { method: 'HEAD' },
  )
  assert.equal(answer.status, 200)
  assert.equal(answer.headers['content-length'], String(BYTES.byteLength), 'the size is still stated')
  assert.equal(answer.bytes, null, 'and no body is sent')
})

test('can this image be written to is refused rather than treated as a read', async (t) => {
  const { host } = await entryWithImage(t)
  const answer = await callRoute(
    host.routes,
    `/browser-bridge/image?sessionId=s&attachmentId=${encodeURIComponent(ID)}`,
    { method: 'POST' },
  )
  assert.equal(answer.status, 405)
  assert.equal(answer.headers.allow, 'GET, HEAD')
})

