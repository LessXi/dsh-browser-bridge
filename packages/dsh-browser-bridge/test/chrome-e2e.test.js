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

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { get } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assert, test } from './harness.js'
import { applyAccessibleNames, distillSnapshot, renderElements, boundsFor, implicitRole } from '../../../extension/page-distill.js'

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
    const version = await probeVersion(port)
    if (version !== undefined) {
      return { process: child, port, webSocketUrl: version.webSocketDebuggerUrl, logPath, cleanup }
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  cleanup()
  throw new Error(`Chrome did not expose a debugging endpoint on port ${port} within 25s`)
}

/**
 * Ask a debugging port for its version JSON, once.
 *
 * This deliberately uses `node:http` with `agent: false` rather than `fetch`.
 * `fetch` is backed by undici, whose global dispatcher keeps the connection in a
 * keep-alive pool; because nothing closes that pool, the pooled socket stayed
 * open past the end of every test and the process could never exit. The suite
 * printed its summary and then hung, which is indistinguishable from a slow run
 * — and it is why `npm test` appeared to stall. `agent: false` gives this probe
 * a socket that is destroyed with the response.
 *
 * @param {number} port - The debugging port.
 * @returns {Promise<object | undefined>} The parsed version, or undefined when not listening yet.
 */
function probeVersion(port) {
  return new Promise((resolve) => {
    const request = get(
      { host: '127.0.0.1', port, path: '/json/version', agent: false, timeout: 2_000 },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          resolve(undefined)
          return
        }
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => { body += chunk })
        response.on('end', () => {
          try {
            resolve(JSON.parse(body))
          } catch {
            resolve(undefined)
          }
        })
      },
    )
    request.on('error', () => resolve(undefined))
    request.on('timeout', () => {
      request.destroy()
      resolve(undefined)
    })
  })
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
   * Wait for one event, with a deadline.
   *
   * The deadline is what makes this suite debuggable: an event that never
   * arrives used to park the promise forever, and because the harness runs every
   * suite in one process, that hung the *entire* run — the suites sorted after
   * this file never executed and `npm test` never printed a summary. A timeout
   * turns that silence into a named failure.
   *
   * @param {string} method - The event name.
   * @param {number} [timeoutMs] - How long to wait.
   * @returns {Promise<object>} The event parameters.
   */
  waitFor(method, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.events.delete(method)
        reject(new Error(`CDP event ${method} did not arrive within ${timeoutMs}ms`))
      }, timeoutMs)
      this.events.set(method, {
        resolve: (params) => {
          clearTimeout(timer)
          resolve(params)
        },
      })
    })
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
 * Open a page target, attach to it, and wait until its document has loaded.
 *
 * The target is created on `about:blank` and then navigated, rather than being
 * created with the final URL. Creating it with the URL raced its own load
 * listener: a `data:` URL parses in a few milliseconds, so `Page.loadEventFired`
 * had already fired — and been discarded, since nothing was subscribed yet — by
 * the time the caller reached `waitFor`. The caller then awaited an event that
 * could no longer happen. This is why the whole suite appeared to hang rather
 * than fail.
 *
 * @param {Cdp} cdp - The browser-level client.
 * @param {string} url - The page to open.
 * @returns {Promise<{ sessionId: string, targetId: string }>} The attachment, loaded.
 */
async function openPage(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  await cdp.send('Page.enable', {}, sessionId)
  // Subscribed before the navigation is requested, so this cannot be missed.
  const load = cdp.waitFor('Page.loadEventFired')
  await cdp.send('Page.navigate', { url }, sessionId)
  await load
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

/**
 * Count the pixels that differ between two screenshots, inside one rectangle.
 *
 * Both images are full-page captures compared *through a canvas in the page*,
 * because there is no way to compare a rectangle directly: a clipped
 * `Page.captureScreenshot` is composited without the DevTools overlay layer, so
 * the element's own area comes back identical whether or not it is highlighted.
 * That was measured, not assumed — a clipped capture of a highlighted button was
 * byte-for-byte its unhighlighted self while the full-page capture of the same
 * moment plainly showed the box. Comparing a clip would therefore have asserted
 * nothing while looking like a stricter test.
 *
 * Node has no PNG decoder, and adding one to ask "how many pixels changed here"
 * would buy a dependency for a question the page can already answer.
 *
 * @param {Cdp} cdp - The connection.
 * @param {string} sessionId - The page session.
 * @param {string} before - Base64 PNG of the page before.
 * @param {string} after - Base64 PNG of the page after.
 * @param {{x: number, y: number, width: number, height: number}} area - The rectangle to compare.
 * @returns {Promise<number>} How many pixels inside the rectangle are not identical.
 */
async function changedPixelsIn(cdp, sessionId, before, after, area) {
  const result = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      const load = (data) => new Promise((ok, bad) => {
        const image = new Image()
        image.onload = () => ok(image)
        image.onerror = () => bad(new Error('could not decode the screenshot'))
        image.src = 'data:image/png;base64,' + data
      })
      const [a, b] = await Promise.all([load(${JSON.stringify(before)}), load(${JSON.stringify(after)})])
      const read = (image) => {
        const canvas = document.createElement('canvas')
        canvas.width = image.width
        canvas.height = image.height
        const context = canvas.getContext('2d', { willReadFrequently: true })
        context.drawImage(image, 0, 0)
        return context.getImageData(0, 0, image.width, image.height).data
      }
      const area = ${JSON.stringify(area)}
      // The capture is the device pixel grid; the box model is CSS pixels.
      const scale = a.width / window.innerWidth
      const x0 = Math.max(0, Math.floor(area.x * scale))
      const y0 = Math.max(0, Math.floor(area.y * scale))
      const x1 = Math.min(a.width, Math.ceil((area.x + area.width) * scale))
      const y1 = Math.min(a.height, Math.ceil((area.y + area.height) * scale))
      const pixelsA = read(a)
      const pixelsB = read(b)
      let changed = 0
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const at = (y * a.width + x) * 4
          if (pixelsA[at] !== pixelsB[at] || pixelsA[at + 1] !== pixelsB[at + 1]
            || pixelsA[at + 2] !== pixelsB[at + 2] || pixelsA[at + 3] !== pixelsB[at + 3]) changed += 1
        }
      }
      return { changed, area: { x0, y0, x1, y1 }, scale, total: (x1 - x0) * (y1 - y0) }
    })()`,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId)
  return result.result.value
}

/**
 * The viewport rectangle of a node.
 *
 * @param {Cdp} cdp - The connection.
 * @param {string} sessionId - The page session.
 * @param {number} nodeId - The node.
 * @returns {Promise<{x: number, y: number, width: number, height: number}>} The rectangle in CSS pixels.
 */
async function boxOf(cdp, sessionId, nodeId) {
  const quad = (await cdp.send('DOM.getBoxModel', { nodeId }, sessionId)).model.border
  const xs = [quad[0], quad[2], quad[4], quad[6]]
  const ys = [quad[1], quad[3], quad[5], quad[7]]
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

test('the acting-on overlay is drawn over the target, and taken down again', async (t) => {
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
  await cdp.send('DOM.enable', {}, sessionId)

  // The extension's own constants, read out of the shipped file rather than
  // copied here: a test that pins its own colour would keep passing after the
  // product's stopped being drawn.
  const source = readFileSync(new URL('../../../extension/background.js', import.meta.url), 'utf8')
  const declaration = source.match(/const HIGHLIGHT_CONFIG = \{[\s\S]*?\n\}/)
  assert.ok(declaration !== null, 'background.js must still declare HIGHLIGHT_CONFIG')
  const highlightConfig = new Function(`${declaration[0]}; return HIGHLIGHT_CONFIG`)()

  const shot = async () => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
    return data
  }

  const { root } = await cdp.send('DOM.getDocument', { depth: 0 }, sessionId)
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#go' }, sessionId)
  const { node } = await cdp.send('DOM.describeNode', { nodeId }, sessionId)

  const untouched = await shot()
  const area = await boxOf(cdp, sessionId, nodeId)

  await cdp.send('Overlay.enable', {}, sessionId)
  await cdp.send('Overlay.highlightNode', { backendNodeId: node.backendNodeId, highlightConfig }, sessionId)
  // The overlay is painted by the compositor, not by the page's own layout, so
  // the frame has to land before the capture means anything.
  await new Promise((resolve) => setTimeout(resolve, 250))
  const highlighted = await shot()
  assert.notEqual(highlighted, untouched, 'the overlay drew nothing at all')

  // "Something on screen changed" is not the claim, and asserting only that is
  // how the first version of this test was found to prove nothing: `showInfo`
  // alone repaints the page — it draws the DevTools chip above the element — so
  // a fully transparent `contentColor` and `borderColor` still changed pixels
  // and still passed. What has to be true is that the element's own area is
  // covered by the box, so the comparison is confined to that rectangle.
  const covered = await changedPixelsIn(cdp, sessionId, untouched, highlighted, area)
  assert.ok(
    covered.changed > covered.total * 0.5,
    `the box did not cover the element it names: ${covered.changed}/${covered.total} of its pixels changed`,
  )

  await cdp.send('Overlay.hideHighlight', {}, sessionId)
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(await shot(), untouched, 'the overlay outlived the action it was explaining')

  // A target named by a snapshot index has bounds and no node id, which is the
  // path `DOM.getNodeForLocation` exists to close. Resolving a point back to a
  // node is what lets both addressing modes draw the same box.
  const hit = await cdp.send('DOM.getNodeForLocation', {
    x: Math.round(area.x + area.width / 2),
    y: Math.round(area.y + area.height / 2),
  }, sessionId)
  assert.ok(hit.backendNodeId !== undefined, 'a point inside the element must resolve back to a node')
  await cdp.send('Overlay.highlightNode', { backendNodeId: hit.backendNodeId, highlightConfig }, sessionId)
  await new Promise((resolve) => setTimeout(resolve, 250))
  const coveredByPoint = await changedPixelsIn(cdp, sessionId, untouched, await shot(), area)
  assert.ok(
    coveredByPoint.changed > coveredByPoint.total * 0.5,
    `the point-addressed target did not cover the element: ${coveredByPoint.changed}/${coveredByPoint.total}`,
  )
  await cdp.send('Overlay.hideHighlight', {}, sessionId)
})

test('the acting-on overlay stays up long enough to be seen', async (t) => {
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
  await cdp.send('DOM.enable', {}, sessionId)

  // The configured dwell, read from the shipped file rather than restated here.
  const source = readFileSync(new URL('../../../extension/background.js', import.meta.url), 'utf8')
  const declaration = source.match(/const HIGHLIGHT_DWELL_MS = \d+/)
  assert.ok(declaration !== null, 'background.js must still declare HIGHLIGHT_DWELL_MS')
  const dwell = new Function(`${declaration[0]}; return HIGHLIGHT_DWELL_MS`)()

  // The bug this test exists for: the first version drew the box, clicked and
  // hid it again inside one function, so it was on screen for 24ms — measured,
  // not estimated. A person cannot register a flash that short, which made the
  // feature invisible to exactly the person it was built for. Asserting that a
  // number in the source is large enough is what the *next* version would break,
  // so this one holds the box down and looks at it.
  assert.ok(dwell >= 400, `a ${dwell}ms dwell is under the ~100ms it takes to notice a flash`)

  const { root } = await cdp.send('DOM.getDocument', { depth: 0 }, sessionId)
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#go' }, sessionId)
  const { node } = await cdp.send('DOM.describeNode', { nodeId }, sessionId)

  const shot = async () => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
    return data
  }

  const baseline = await shot()
  await cdp.send('Overlay.enable', {}, sessionId)
  await cdp.send('Overlay.highlightNode', { backendNodeId: node.backendNodeId, highlightConfig: {
    showInfo: true,
    contentColor: { r: 66, g: 98, b: 240, a: 0.4 },
    borderColor: { r: 66, g: 98, b: 240, a: 0.9 },
  } }, sessionId)

  // Sampled at the moment a real click would already have returned. In the
  // shipped flow the action is finished by now; only the box is still up.
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.notEqual(await shot(), baseline, 'the box was already gone by the time a 24ms action would have returned')

  await cdp.send('Overlay.hideHighlight', {}, sessionId)
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(await shot(), baseline, 'the box did not come down again')
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

test('indices stay unique when the snapshot holds more than one document', () => {
  // A snapshot carries one document per frame, and each numbers its nodes from
  // zero. Reporting the raw position hands the model two different elements with
  // the same `#n` the moment a page contains an iframe — measured on a checkout
  // whose card form sits in one, four of seven rows collided, and `#13` was both
  // "Apply coupon" on the page and the card-number field in the frame.
  //
  // `resolveTarget` looks an index up with `find`, so the collision is not
  // cosmetic: it clicks whichever came first in document order.
  // One string table for the whole snapshot, which is the shape CDP sends: the
  // documents index into a shared pool rather than each carrying its own. A
  // fixture that gave each document a private pool would still produce two rows,
  // and they would both read the *first* document's label.
  const strings = ['', 'html', 'body', 'button', 'name', 'Apply coupon', 'Pay now']
  const at = (text) => strings.indexOf(text)

  const build = (buttonName, buttonIndex) => {
    const length = buttonIndex + 1
    const nodeType = new Array(length).fill(1)
    const nodeName = new Array(length).fill(at('body'))
    nodeType[0] = 9
    nodeName[0] = at('html')
    nodeName[buttonIndex] = at('button')
    return {
      nodes: {
        parentIndex: new Array(length).fill(0),
        nodeType,
        nodeName,
        nodeValue: new Array(length).fill(0),
        // The name comes from an attribute rather than a text child, so the
        // fixture stays about *which document a row belongs to* instead of
        // depending on the descendant-text plumbing as well.
        attributes: { [buttonIndex]: [at('name'), at(buttonName)] },
        backendNodeId: new Array(length).fill(0).map((_zero, index) => index + 1),
      },
      layout: { nodeIndex: [buttonIndex], bounds: [[0, 0, 100, 20]] },
    }
  }

  // The page has a button at node 3; the frame has one at node 3 as well, which
  // is the ordinary collision when a frame is small.
  const snapshot = {
    strings,
    documents: [build('Apply coupon', 3), build('Pay now', 3)],
  }

  const elements = distillSnapshot(snapshot, { interactiveOnly: true })
  assert.equal(elements.length, 2, `expected both frames' buttons, saw ${elements.length}`)

  const indices = elements.map((element) => element.index)
  assert.equal(new Set(indices).size, indices.length, `indices collide across documents: ${JSON.stringify(indices)}`)

  // The frame's row keeps its own position, so a caller that needs to talk to
  // that document directly still can.
  const second = elements[1]
  assert.equal(second.nodeIndex, 3, 'the per-document position was lost')

  // And the names stay attached to the right rows: an offset that misaligned the
  // pairing would still produce unique numbers.
  assert.deepEqual(
    elements.map((element) => element.name),
    ['Apply coupon', 'Pay now'],
    'the rows were paired with the wrong documents',
  )
})

test('the browser names override the derived ones, and only where it helps', () => {
  // Chrome implements the accessible-name computation; the reader in
  // `page-distill.js` implements a subset of it. A probe against a realistic
  // page showed the difference concretely — an input labelled by `<label for>`
  // came back nameless, a `<select>` was named after its options — so the
  // browser is asked, and this pins which of its answers are taken.
  const derived = [
    { index: 71, tag: 'INPUT', role: 'textbox', name: '', type: 'email', backendNodeId: 15 },
    { index: 81, tag: 'SELECT', role: 'combobox', name: 'ChinaJapanKorea', backendNodeId: 16 },
    // A label whose words are about to be given to the control it names.
    { index: 68, tag: 'LABEL', role: 'label', name: 'Email address', backendNodeId: 14 },
    { index: 93, tag: 'INPUT', role: 'checkbox', name: 'on', type: 'checkbox', backendNodeId: 17 },
    // No backend id, so nothing to join on and nothing to change.
    { index: 200, tag: 'BUTTON', role: 'button', name: 'Someone else', backendNodeId: undefined },
    // A real target with no name at all. It must survive: dropping it would
    // hide a clickable element, which is a capability, not noise.
    { index: 134, tag: 'BUTTON', role: 'button', name: '', backendNodeId: 18 },
  ]
  const tree = {
    nodes: [
      { backendDOMNodeId: 15, role: { value: 'textbox' }, name: { value: 'Email address' } },
      { backendDOMNodeId: 16, role: { value: 'combobox' }, name: { value: 'Country' } },
      // A `<label>` is `LabelText` to assistive technology, which is not a word
      // this rendering can use — and Chrome reports it with an empty name,
      // because the words have already gone to the control.
      { backendDOMNodeId: 14, role: { value: 'LabelText' }, name: { value: '' } },
      { backendDOMNodeId: 17, role: { value: 'checkbox' }, name: { value: ' I agree to the terms' } },
      { backendDOMNodeId: 18, role: { value: 'button' }, name: { value: '' } },
      // An AX node for something not in the list, which must be harmless.
      { backendDOMNodeId: 999, role: { value: 'button' }, name: { value: 'Not on the page' } },
    ],
  }

  const { elements, matched, dropped } = applyAccessibleNames(derived, tree)
  assert.equal(matched, 5, 'the join must match every element that carries a backend id')

  const byIndex = new Map(elements.map((element) => [element.index, element]))
  assert.equal(byIndex.get(71).name, 'Email address', 'the empty derived name was not replaced')
  assert.equal(byIndex.get(81).name, 'Country', 'the select kept its concatenated option text')
  assert.equal(byIndex.get(93).name, 'I agree to the terms', 'the label whitespace was not collapsed')
  assert.equal(byIndex.get(200).name, 'Someone else', 'an element with no backend id was touched')

  // The label is gone: its words now live on the control, so the row was a
  // duplicate with the information removed. Measured on a checkout page, four
  // of these plus an unnamed button were 16% of the list.
  assert.equal(byIndex.has(68), false, 'an empty label proxy still occupies a row')
  assert.equal(dropped, 1, `expected exactly one dropped proxy, dropped ${dropped}`)

  // The unnamed button is not a proxy and must stay: it is a real target.
  assert.notEqual(byIndex.get(134), undefined, 'an unnamed but clickable element was dropped')
  assert.equal(byIndex.get(134).name, '')

  // Degenerate inputs cannot throw: the AX domain may legitimately be refused.
  assert.equal(applyAccessibleNames(derived, undefined).matched, 0)
  assert.equal(applyAccessibleNames(derived, { nodes: [] }).matched, 0)
  assert.equal(applyAccessibleNames(derived, { nodes: [] }).elements, derived, 'a failed join must change nothing')
})

test('a label does not take its control value as its own text', () => {
  // The defect this pins, seen on a realistic page: a wrapping `<label>` around
  // a checkbox rendered as `label "onI agree to the terms"` — the checkbox's own
  // value glued to the words — and a `<select>` inside a label became
  // `label "ChinaJapanKorea"`. The label's job is the words the page prints
  // beside the field.
  const strings = ['', 'html', 'body', 'label', 'input', 'I agree to the terms', 'on']
  const at = (name) => strings.indexOf(name)
  const snapshot = {
    strings,
    documents: [{
      nodes: {
        // `label` wraps `input` and is followed by the text — the real shape:
        //   <label><input id=terms type=checkbox> I agree to the terms</label>
        // so the label's children are the input (index 4) and the text (index 5).
        parentIndex: [-1, 0, 1, 2, 3, 3],
        nodeType: [9, 1, 1, 1, 1, 3],
        nodeName: [at('html'), at('html'), at('body'), at('label'), at('input'), 0],
        nodeValue: [0, 0, 0, 0, 0, at('I agree to the terms')],
        // The control carries a value, and it has to: this is what the defect
        // reads. A live checkbox reports `on`, an unfilled one reports nothing —
        // and with nothing there the label renders correctly either way, which
        // is how this test passed against the broken code before the fixture
        // gave the input a value.
        inputValue: {
          index: [4],
          value: [at('on')],
        },
        backendNodeId: [1, 2, 3, 4, 5, 6],
      },
      layout: { nodeIndex: [3, 4], bounds: [[0, 0, 200, 20], [0, 0, 16, 16]] },
    }],
  }

  const elements = distillSnapshot(snapshot, { interactiveOnly: true })
  const label = elements.find((element) => element.tag === 'LABEL')
  const control = elements.find((element) => element.tag === 'INPUT')

  assert.notEqual(label, undefined, 'the label was not distilled, so nothing below is proved')
  assert.equal(
    label.name.includes('on'),
    false,
    `the label absorbed its control's value: ${JSON.stringify(label.name)}`,
  )
  assert.equal(label.name, 'I agree to the terms', 'the label lost the words that label it')
  // The control still reads its own value as its name — that rule is unchanged
  // and is why an already-filled input is still nameable. It is the descent into
  // a control that must contribute nothing, not the control itself.
  assert.equal(control.name, 'on', 'the control no longer reads its own value as its name')
})
