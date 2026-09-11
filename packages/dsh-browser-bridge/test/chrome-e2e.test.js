/**
 * End-to-end test: the page pipeline against a real Chrome.
 *
 * This runs the *actual* `extension/page-distill.js` over a real
 * `DOMSnapshot.captureSnapshot` result, drives real input events, and captures a
 * real screenshot. The mocked tests above cannot tell whether the snapshot
 * fields are read correctly, whether a synthesized click lands on the element,
 * or whether `Input.insertText` reaches a page — and a wrong field name there
 * produces a silently empty element list rather than an error.
 *
 * The test is skipped, not failed, when Chrome is absent: this package must be
 * testable on a machine without it.
 *
 * Chrome's remote debugging endpoint is privileged, so `Target.*`-style domain
 * access is not available; the connection is made straight to the page target
 * from `/json/list`, which is the same shape a browser-level client would give.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assert, test } from './harness.js'
import { distillSnapshot, renderElements, boundsFor, implicitRole } from '../../../extension/page-distill.js'

/** Where Chrome usually lives, in the order worth trying. */
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

/** A page with enough structure to exercise every distilled field. */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Distill Fixture</title></head>
<body style="font:14px sans-serif;margin:0;padding:20px">
  <h1>Checkout fixture</h1>
  <p id="prose">The quick brown fox jumps over the lazy dog.</p>
  <label for="email">Email address</label>
  <input id="email" name="email" type="text" placeholder="you@example.com" style="display:block;width:200px;height:24px">
  <input id="agree" type="checkbox" style="width:18px;height:18px">
  <input id="bare" type="text" placeholder="no name attribute" style="display:block;width:180px;height:24px">
  <button id="go" type="button" style="width:120px;height:32px">Submit order</button>
  <a id="link" href="https://example.com/next">Next page</a>
  <div id="hidden" style="display:none"><button>Invisible</button></div>
  <div id="result">idle</div>
  <script>
    document.getElementById('go').addEventListener('click', () => { document.getElementById('result').textContent = 'clicked'; });
    document.getElementById('email').addEventListener('input', (event) => { document.getElementById('result').textContent = 'typed:' + event.target.value; });
  </script>
</body></html>`

/**
 * Find a usable Chrome binary.
 * @returns {string | undefined} The path, when one exists.
 */
function findChrome() {
  return CHROME_CANDIDATES.find((candidate) => existsSync(candidate))
}

/**
 * Start headless Chrome with remote debugging.
 *
 * Two constraints shape this:
 *
 *   - Piped stdio for a spawned program is denied in some sandboxes, so Chrome's
 *     own output is not captured through a pipe. A fixed port plus polling the
 *     HTTP endpoint avoids needing to read the "DevTools listening on" line, and
 *     stderr is redirected to a file on disk so a startup failure is still
 *     diagnosable.
 *   - `--remote-debugging-port=0` would ask the OS to choose, which is only
 *     discoverable from that same captured line; a fixed port is simpler.
 *
 * @param {string} binary - The Chrome executable.
 * @returns {Promise<{ process: object, port: number, webSocketUrl: string, logPath: string, cleanup: () => void }>} The handle.
 */
async function startChrome(binary) {
  const profile = mkdtempSync(join(tmpdir(), 'dsh-bb-chrome-'))
  const logPath = join(profile, 'chrome.log')
  const port = 9_000 + Math.floor(Math.random() * 20_000)

  const child = spawn(binary, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-features=Translate,MediaRouter',
    'about:blank',
  ], {
    // stdout and stderr go to files, not pipes: a pipe here is denied by some
    // sandboxes, and the log is only read when something fails.
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: false,
  })

  const cleanup = () => {
    try {
      child.kill()
    } catch {
      // A process that already exited needs no killing.
    }
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {
      // A profile directory still held open is not worth failing a test over.
    }
  }

  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      cleanup()
      throw new Error(`Chrome exited with code ${child.exitCode} before its debugging endpoint came up (see ${logPath})`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) {
        const version = await response.json()
        return { process: child, port, webSocketUrl: version.webSocketDebuggerUrl, logPath, cleanup }
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  cleanup()
  throw new Error(`Chrome did not expose a debugging endpoint on port ${port} within 25s`)
}

/**
 * A minimal CDP client over the browser-level websocket.
 *
 * `Target.*` is reachable here only because this connects to the browser
 * endpoint directly, which an extension cannot; the page-level commands below
 * are the ones the extension actually uses.
 */
class Cdp {
  /**
   * @param {string} url - The browser websocket URL.
   */
  constructor(url) {
    this.socket = new WebSocket(url)
    this.nextId = 1
    /** @type {Map<number, { resolve: Function, reject: Function }>} */
    this.pending = new Map()
    /** @type {Map<string, { resolve: Function }>} */
    this.events = new Map()
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve())
      this.socket.addEventListener('error', () => reject(new Error('CDP socket failed to open')))
    })
    this.socket.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data))
      if (frame.id !== undefined) {
        const entry = this.pending.get(frame.id)
        if (entry === undefined) return
        this.pending.delete(frame.id)
        if (frame.error !== undefined) entry.reject(new Error(`${frame.error.message} (${frame.error.code})`))
        else entry.resolve(frame.result)
        return
      }
      const waiter = this.events.get(frame.method)
      if (waiter !== undefined) {
        this.events.delete(frame.method)
        waiter.resolve(frame.params)
      }
    })
  }

  /**
   * Send one command.
   * @param {string} method - The CDP method.
   * @param {object} [params] - Its parameters.
   * @param {number} [sessionId] - The target session, when attached.
   * @returns {Promise<object>} The result.
   */
  send(method, params = {}, sessionId) {
    const id = this.nextId
    this.nextId += 1
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP ${method} timed out`))
      }, 15_000)
    })
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
    return promise
  }

  /**
   * Wait for one event.
   * @param {string} method - The event name.
   * @returns {Promise<object>} The event parameters.
   */
  waitFor(method) {
    return new Promise((resolve) => this.events.set(method, { resolve }))
  }

  /** Close the socket. */
  close() {
    try {
      this.socket.close()
    } catch {
      // Already gone.
    }
  }
}

/**
 * Open a page target and attach to it.
 * @param {Cdp} cdp - The browser-level client.
 * @param {string} url - The page to open.
 * @returns {Promise<{ sessionId: string, targetId: string }>} The attachment.
 */
async function openPage(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  return { sessionId, targetId }
}

/** The fixture page as a data URL. */
function pageUrl() {
  return `data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`
}

const chromeBinary = findChrome()

test('the DOM snapshot pipeline works against a real Chrome page', async (t) => {
  if (chromeBinary === undefined) {
    t.skip('no Chrome binary on this machine')
    return
  }
  const chrome = await startChrome(chromeBinary)
  t.onCleanup(() => chrome.cleanup())

  const cdp = new Cdp(chrome.webSocketUrl)
  t.onCleanup(() => cdp.close())
  await cdp.ready

  const { sessionId } = await openPage(cdp, pageUrl())
  const load = cdp.waitFor('Page.loadEventFired')
  await cdp.send('Page.enable', {}, sessionId)
  await load

  // ── the browser sees the page ──────────────────────────────────────────────
  const identity = await cdp.send('Runtime.evaluate', {
    expression: '({ title: document.title, text: document.body.innerText, url: location.href })',
    returnByValue: true,
  }, sessionId)
  assert.equal(identity.result.value.title, 'Distill Fixture')
  assert.match(identity.result.value.text, /quick brown fox/)

  // ── the snapshot the extension takes ───────────────────────────────────────
  await cdp.send('DOM.enable', {}, sessionId)
  await cdp.send('CSS.enable', {}, sessionId)
  const snapshot = await cdp.send('DOMSnapshot.captureSnapshot', {
    computedStyles: ['display', 'visibility', 'opacity', 'cursor'],
    includePaintOrder: false,
    includeDOMRects: true,
  }, sessionId)

  assert.ok(Array.isArray(snapshot.documents) && snapshot.documents.length === 1, 'the snapshot must describe one document')
  assert.ok(Array.isArray(snapshot.strings), 'the snapshot must carry its string table')

  const elements = distillSnapshot(snapshot, { interactiveOnly: true })
  assert.ok(elements.length > 0, 'the fixture has actionable elements; an empty list means the field names are wrong')

  /**
   * Find one distilled element by a predicate.
   *
   * The failure message dumps every distilled row, because "the element was not
   * found" is the same symptom for a wrong tag, a wrong name source, and a
   * dropped element — and only the list distinguishes them.
   *
   * @param {(element: object) => boolean} predicate - The test.
   * @param {string} what - For the failure message.
   * @returns {object} The element.
   */
  const pick = (predicate, what) => {
    const found = elements.find(predicate)
    assert.ok(
      found !== undefined,
      `distillation missed ${what}. Distilled rows: ${JSON.stringify(elements, null, 2)}`,
    )
    return found
  }

  const button = pick((element) => element.tag === 'BUTTON' && element.name === 'Submit order', 'the submit button')
  assert.equal(button.role, 'button')
  assert.ok(button.bounds !== undefined, 'an actionable element must carry bounds, or it cannot be clicked')
  assert.ok(button.bounds.width > 50 && button.bounds.height > 10, `implausible button bounds: ${JSON.stringify(button.bounds)}`)

  const email = pick((element) => element.tag === 'INPUT' && element.type === 'text' && element.name === 'email', 'the labelled text input')
  assert.equal(email.role, 'textbox')
  assert.equal(email.name, 'email', 'an explicit name attribute outranks the placeholder')

  // The fallback order matters: with no name, the placeholder is the name.
  const bare = pick((element) => element.tag === 'INPUT' && element.name === 'no name attribute', 'the placeholder-only input')
  assert.equal(bare.role, 'textbox')

  const checkbox = pick((element) => element.tag === 'INPUT' && element.type === 'checkbox', 'the checkbox')
  assert.equal(checkbox.role, 'checkbox')

  const link = pick((element) => element.tag === 'A', 'the link')
  assert.equal(link.role, 'link')
  assert.match(link.href, /example\.com\/next/)

  // A hidden control has no box, so it must not appear as something to click.
  assert.ok(
    !elements.some((element) => element.name === 'Invisible'),
    'a display:none element must not be offered as actionable',
  )

  // ── the rendered text lines ────────────────────────────────────────────────
  const rendered = renderElements(elements, { maxBytes: 100_000 })
  assert.equal(rendered.truncated, false)
  assert.match(rendered.text, /#\d+ button "Submit order"/)
  assert.match(rendered.text, /type=text/)

  // Truncation must cut on a line boundary, never mid-element.
  const tiny = renderElements(elements, { maxBytes: 40 })
  assert.equal(tiny.truncated, true)
  assert.ok(tiny.text.endsWith('characters)'), 'the truncation notice must be present')
  for (const line of tiny.text.split('\n').slice(0, -1)) {
    assert.ok(line.startsWith('#') || line.length === 0, `a truncated line was cut mid-element: ${line}`)
  }
})

test('a synthesized click lands on the element the snapshot named', async (t) => {
  if (chromeBinary === undefined) {
    t.skip('no Chrome binary on this machine')
    return
  }
  const chrome = await startChrome(chromeBinary)
  t.onCleanup(() => chrome.cleanup())
  const cdp = new Cdp(chrome.webSocketUrl)
  t.onCleanup(() => cdp.close())
  await cdp.ready

  const { sessionId } = await openPage(cdp, pageUrl())
  const load = cdp.waitFor('Page.loadEventFired')
  await cdp.send('Page.enable', {}, sessionId)
  await load
  await cdp.send('DOM.enable', {}, sessionId)

  const snapshot = await cdp.send('DOMSnapshot.captureSnapshot', { computedStyles: [], includeDOMRects: true }, sessionId)
  const button = distillSnapshot(snapshot).find((element) => element.name === 'Submit order')
  assert.ok(button?.bounds !== undefined, 'the button must be found to click it')

  // The extension's click path, exactly: bounds → centre → dispatch press and
  // release. Using the real input pipeline is the point; a JS `.click()` would
  // pass even if the coordinates were wrong.
  const x = button.bounds.x + button.bounds.width / 2
  const y = button.bounds.y + button.bounds.height / 2
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: 1 }, sessionId)
  }

  const result = await cdp.send('Runtime.evaluate', {
    expression: 'document.getElementById("result").textContent',
    returnByValue: true,
  }, sessionId)
  assert.equal(result.result.value, 'clicked', 'a click at the snapshot bounds must reach the element')
})

test('insertText reaches a page and fires its input listener', async (t) => {
  if (chromeBinary === undefined) {
    t.skip('no Chrome binary on this machine')
    return
  }
  const chrome = await startChrome(chromeBinary)
  t.onCleanup(() => chrome.cleanup())
  const cdp = new Cdp(chrome.webSocketUrl)
  t.onCleanup(() => cdp.close())
  await cdp.ready

  const { sessionId } = await openPage(cdp, pageUrl())
  const load = cdp.waitFor('Page.loadEventFired')
  await cdp.send('Page.enable', {}, sessionId)
  await load

  // Focus by selector, which is what `page.type` with a selector does.
  await cdp.send('Runtime.evaluate', { expression: 'document.getElementById("email").focus()' }, sessionId)
  await cdp.send('Input.insertText', { text: 'hello@example.com' }, sessionId)

  const result = await cdp.send('Runtime.evaluate', {
    expression: '({ value: document.getElementById("email").value, fired: document.getElementById("result").textContent })',
    returnByValue: true,
  }, sessionId)
  assert.equal(result.result.value.value, 'hello@example.com')
  assert.equal(result.result.value.fired, 'typed:hello@example.com', 'the input event must reach the page')
})

test('a screenshot comes back as a real image payload', async (t) => {
  if (chromeBinary === undefined) {
    t.skip('no Chrome binary on this machine')
    return
  }
  const chrome = await startChrome(chromeBinary)
  t.onCleanup(() => chrome.cleanup())
  const cdp = new Cdp(chrome.webSocketUrl)
  t.onCleanup(() => cdp.close())
  await cdp.ready

  const { sessionId } = await openPage(cdp, pageUrl())
  const load = cdp.waitFor('Page.loadEventFired')
  await cdp.send('Page.enable', {}, sessionId)
  await load

  for (const format of ['jpeg', 'png']) {
    const shot = await cdp.send('Page.captureScreenshot', {
      format,
      ...(format === 'jpeg' ? { quality: 80 } : {}),
      captureBeyondViewport: false,
      fromSurface: true,
    }, sessionId)
    assert.equal(typeof shot.data, 'string')
    assert.ok(shot.data.length > 1000, `${format} payload looks too small: ${shot.data.length}`)
    const bytes = Buffer.from(shot.data, 'base64')
    const isJpeg = bytes[0] === 0xFF && bytes[1] === 0xD8
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50
    assert.equal(format === 'jpeg' ? isJpeg : isPng, true, `${format} payload has the wrong magic bytes`)
  }
})

test('the console ring buffer commands yield what the extension expects', async (t) => {
  if (chromeBinary === undefined) {
    t.skip('no Chrome binary on this machine')
    return
  }
  const chrome = await startChrome(chromeBinary)
  t.onCleanup(() => chrome.cleanup())
  const cdp = new Cdp(chrome.webSocketUrl)
  t.onCleanup(() => cdp.close())
  await cdp.ready

  const { sessionId } = await openPage(cdp, 'about:blank')
  await cdp.send('Runtime.enable', {}, sessionId)

  const captured = new Promise((resolve) => {
    const listener = (event) => {
      const frame = JSON.parse(String(event.data))
      if (frame.method === 'Runtime.consoleAPICalled') resolve(frame.params)
    }
    cdp.socket.addEventListener('message', listener)
  })
  await cdp.send('Runtime.evaluate', { expression: 'console.log("bridge-fixture-marker", 42)' }, sessionId)
  const params = await captured
  assert.equal(params.type, 'log')
  assert.ok(Array.isArray(params.args) && params.args.length >= 2, 'a console entry must carry its arguments')
})

test('the pure helpers behave without a browser', () => {
  assert.equal(implicitRole('A', { href: 'https://x' }), 'link')
  assert.equal(implicitRole('A', {}), 'generic')
  assert.equal(implicitRole('INPUT', { type: 'checkbox' }), 'checkbox')
  assert.equal(implicitRole('DIV', {}), 'generic')

  // Bounds lookup is a binary search over the index table, and it has to accept
  // both the four-number form the snapshot emits and the eight-number quad
  // `DOM.getBoxModel` returns. Requiring the quad silently produced `undefined`
  // for every element, which reads as "nothing on this page is clickable".
  const four = { nodeIndex: [1, 5, 9, 20], bounds: [[10, 10, 100, 20], [0, 0, 1, 1], [5, 5, 2, 3], [7, 7, 4, 4]] }
  assert.deepEqual(boundsFor(four, 1), { x: 10, y: 10, width: 100, height: 20 }, 'a [x,y,w,h] rect must be read as-is')
  assert.deepEqual(boundsFor(four, 9), { x: 5, y: 5, width: 2, height: 3 })
  assert.equal(boundsFor(four, 999), undefined, 'a missing node has no bounds')
  assert.equal(boundsFor({}, 1), undefined, 'a document with no layout table has no bounds')

  const quad = { nodeIndex: [3], bounds: [[0, 0, 20, 0, 20, 10, 0, 10]] }
  assert.deepEqual(boundsFor(quad, 3), { x: 0, y: 0, width: 20, height: 10 }, 'an eight-number quad is reduced to a rect')

  // An empty or malformed snapshot must degrade to "nothing", not throw.
  assert.deepEqual(distillSnapshot({}), [])
  assert.deepEqual(distillSnapshot({ documents: [{ nodes: {}, layout: {} }], strings: [] }), [])
})
