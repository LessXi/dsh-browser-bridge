/**
 * A real Chrome, with the real extension loaded, driven from the test process.
 *
 * ## Why this exists
 *
 * The handover recorded "Chrome 137 removed `--load-extension`, so this project
 * cannot be tested against a real extension" (README line 1423, HANDOVER line
 * 3529, measured on stable Chrome 153). That measurement is correct *for the
 * stable channel* and was generalised too far. Measured again across every
 * browser binary on this machine (`.tmp-run/probe-load-extension-matrix.mjs`):
 *
 *   | binary                          | worker | options page |
 *   |---------------------------------|--------|--------------|
 *   | Playwright Chromium 153         | yes    | yes          |
 *   | Puppeteer Chrome for Testing 148| yes    | yes          |
 *   | chrome-headless-shell 153       | no     | no           |
 *   | stable Chrome 153               | no     | no           |
 *
 * So the switch was not removed from Chromium; it was removed from the stable
 * channel, which is the channel that cares about users' extension installs.
 * Chromium keeps it because every browser-automation project's extension tests
 * depend on it.
 *
 * That reopens the whole extension: `chrome.debugger`, `chrome.tabs`,
 * `chrome.action`, the side panel document, and the content script's isolated
 * world all become reachable from a test.
 *
 * ## What this deliberately does not do
 *
 * It does not pick stable Chrome. A test that silently ran against a browser
 * where `--load-extension` is a no-op would report "0 tests, all skipped" and
 * look healthy; the binary discovery here treats Chromium and Chrome for
 * Testing as the *only* usable ones and skips loudly when neither exists.
 *
 * @module dsh-browser-bridge/test/extension-host
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, get as req } from 'node:http'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'

/**
 * Where a Chromium that still honours `--load-extension` may live, in order.
 *
 * Chrome for Testing is listed alongside Playwright's because it is the same
 * thing under a different install path — both are the non-stable channel.
 *
 * The version-numbered directory is why these are roots rather than finished
 * paths: Playwright and Chrome for Testing both install into
 * `…/chromium-<build>/…` and `…/win64-<version>/…`, so a literal path would pin
 * the suite to one build and silently skip on the next upgrade. Pinning one is
 * how this file first read, and it resolved for exactly one machine.
 */
const CHROMIUM_ROOTS = [
  // Playwright: `chromium-<build>/chrome-<platform>/chrome`.
  { root: join(homedir(), 'AppData', 'Local', 'ms-playwright'), pattern: /^chromium-\d+$/, inside: ['chrome-win64', 'chrome-linux', 'chrome-mac'], binary: ['chrome.exe', 'chrome'] },
  { root: join(homedir(), 'Library', 'Caches', 'ms-playwright'), pattern: /^chromium-\d+$/, inside: ['chrome-mac'], binary: ['Chromium'] },
  { root: join(homedir(), '.cache', 'ms-playwright'), pattern: /^chromium-\d+$/, inside: ['chrome-linux'], binary: ['chrome'] },
  // Puppeteer and Chrome for Testing: `chrome/<platform>-<version>/chrome-<platform>/chrome`.
  { root: join(homedir(), '.cache', 'puppeteer', 'chrome'), pattern: /^(win64|mac-arm64|mac-x64|linux64)-\d+/, inside: ['chrome-win64', 'chrome-mac-arm64', 'chrome-mac-x64', 'chrome-linux64'], binary: ['chrome.exe', 'Google Chrome for Testing', 'chrome'] },
  { root: join(homedir(), 'AppData', 'Local', 'Google', 'Chrome for Testing'), pattern: /^chrome$/, inside: ['chrome-win64'], binary: ['chrome.exe'] },
]

/**
 * A plain-install Chromium, last because it is the one most likely to be a
 * stable build where `--load-extension` is a no-op. It is still tried: a
 * distribution's `chromium` package is a real Chromium, and refusing to look
 * would skip the suite on Linux for no reason.
 */
const PLAIN_CHROMIUM = [
  'C:\\Program Files\\Chromium\\Application\\chrome.exe',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
]

/** Newest directory name first, so a machine with several builds uses the latest. */
function byVersionDescending(a, b) {
  const number = (name) => Number(name.match(/(\d+)/)?.[1] ?? 0)
  return number(b) - number(a)
}

/**
 * Every Chromium binary under the known install roots, newest first.
 *
 * Directory listing rather than a glob library: this package has no
 * dependencies, and the shape being matched is two levels deep.
 *
 * @returns {string[]} Existing binaries, in the order worth trying.
 */
function discoverChromium() {
  const found = []
  for (const entry of CHROMIUM_ROOTS) {
    let versions
    try {
      versions = readdirSync(entry.root).filter((name) => entry.pattern.test(name)).sort(byVersionDescending)
    } catch {
      continue
    }
    for (const version of versions) {
      for (const inner of entry.inside) {
        for (const binary of entry.binary) {
          const candidate = join(entry.root, version, inner, binary)
          if (existsSync(candidate)) found.push(candidate)
        }
      }
    }
  }
  for (const candidate of PLAIN_CHROMIUM) {
    if (existsSync(candidate)) found.push(candidate)
  }
  return found
}

/**
 * Find a Chromium that can load an unpacked extension.
 *
 * `DSH_BB_CHROMIUM` overrides the search, which is how a machine that keeps its
 * browser somewhere else runs these tests. An override that does not exist
 * returns undefined rather than falling through to the search: silently testing
 * against a different browser than the one that was asked for is worse than
 * skipping.
 *
 * @returns {string | undefined} The binary, or undefined when none is present.
 */
export function findChromium() {
  const override = process.env.DSH_BB_CHROMIUM
  if (typeof override === 'string' && override.length > 0) {
    return existsSync(override) ? override : undefined
  }
  return discoverChromium()[0]
}

/**
 * The id Chrome derives for an unpacked extension: the first 16 bytes of the
 * SHA-256 of its absolute path, with each hex digit mapped 0-f to a-p.
 *
 * Windows hashes the path as UTF-16LE. This is an implementation detail of
 * Chrome rather than anything documented, so {@link ExtensionHost} verifies the
 * value against the browser's own answer and fails when they disagree — a
 * silent mismatch would make every extension-page navigation 404 in a way that
 * looks like a missing file.
 *
 * @param {string} absolutePath - Path to the unpacked extension directory.
 * @returns {string} The 32-character extension id.
 */
export function extensionIdFor(absolutePath) {
  const bytes = process.platform === 'win32'
    ? Buffer.from(absolutePath, 'utf16le')
    : Buffer.from(absolutePath, 'utf8')
  const digest = createHash('sha256').update(bytes).digest().subarray(0, 16)
  return [...digest]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .split('')
    .map((c) => String.fromCharCode(parseInt(c, 16) + 'a'.charCodeAt(0)))
    .join('')
}

/**
 * One HTTP request against Chrome's debugging endpoint.
 *
 * `agent: false` rather than `fetch`: undici's global dispatcher keeps a pooled
 * socket alive, and a pooled socket to a killed Chrome keeps the test process
 * from exiting — the same trap `chrome-e2e.test.js` documents.
 *
 * @param {number} port - The debugging port.
 * @param {string} path - Request path, e.g. `/json/version`.
 * @param {string} [method] - HTTP method; `/json/new` requires PUT.
 * @returns {Promise<string>} The response body.
 */
export function probe(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = req(
      { host: '127.0.0.1', port, path, method, agent: false, timeout: 2_000 },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => { body += chunk })
        response.on('end', () => resolve(body))
      },
    )
    request.on('error', reject)
    request.on('timeout', () => {
      request.destroy()
      reject(new Error(`timed out: ${path}`))
    })
    request.end()
  })
}

/**
 * Open a new tab and return it.
 *
 * `/json/new` is `PUT`-only, and has been since Chrome 111: a `GET` answers
 * `405 Using unsafe HTTP verb GET to invoke /json/new. This action supports only
 * PUT verb.` Measured on all three binaries on this machine. A `GET` here
 * therefore opened no tab at all, and a caller that then searched `/json/list`
 * for a page it had just asked for would either wait out its timeout or — when
 * the URL happened to already be open — silently return the wrong tab. Both
 * failure modes are invisible in a green test run, which is why this is one
 * function rather than a URL built at each call site.
 *
 * @param {number} port - The debugging port.
 * @param {string} url - The URL to open.
 * @returns {Promise<any>} The new target, as Chrome describes it.
 */
export async function openTarget(port, url) {
  const body = await probe(port, `/json/new?${encodeURIComponent(url)}`, 'PUT')
  try {
    return JSON.parse(body)
  } catch {
    throw new Error(`opening ${url} did not return a target: ${body.slice(0, 200)}`)
  }
}

/**
 * A CDP client over one target's websocket.
 *
 * Small on purpose: `send` resolves with the whole reply so a caller can assert
 * on `error` and `exceptionDetails` rather than having them thrown away, and
 * `on` collects events for the cases where a push is the only observation.
 */
export class Cdp {
  /** @param {string} url - The target's `webSocketDebuggerUrl`. */
  constructor(url) {
    this.url = url
    /** @type {Map<number, (message: any) => void>} */
    this.pending = new Map()
    /** @type {Set<(message: any) => void>} */
    this.listeners = new Set()
    /** @type {any[]} */
    this.events = []
    this.nextId = 1
  }

  /** @returns {Promise<Cdp>} This client, once open. */
  async connect() {
    this.socket = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve(undefined), { once: true })
      this.socket.addEventListener('error', () => reject(new Error('websocket error')), { once: true })
      setTimeout(() => reject(new Error('websocket open timed out')), 10_000)
    })
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined) {
        const settle = this.pending.get(message.id)
        if (settle !== undefined) {
          this.pending.delete(message.id)
          settle(message)
        }
        return
      }
      this.events.push(message)
      for (const listener of this.listeners) listener(message)
    })
    return this
  }

  /**
   * Send one command.
   * @param {string} method - CDP method.
   * @param {object} [params] - Parameters.
   * @returns {Promise<any>} The reply message.
   */
  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve)
      this.socket.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`))
      }, 20_000)
    })
  }

  /**
   * Subscribe to pushed events.
   * @param {(message: any) => void} listener - Called for each event.
   */
  on(listener) {
    this.listeners.add(listener)
  }

  /**
   * Evaluate an expression and return its value.
   *
   * Thrown exceptions and protocol errors come back as strings rather than
   * being raised, because a test asserting "this throws" needs the text.
   *
   * @param {string} expression - The expression; wrap in an IIFE when it needs statements.
   * @returns {Promise<any>} The value, or a `THREW:`/`CDP-ERROR:` string.
   */
  async eval(expression) {
    const message = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (message.error !== undefined) return `CDP-ERROR:${JSON.stringify(message.error)}`
    if (message.result?.exceptionDetails !== undefined) {
      const detail = message.result.exceptionDetails
      return `THREW:${detail.text} ${detail.exception?.description ?? ''}`.slice(0, 400)
    }
    return message.result?.result?.value
  }

  /** Close the socket. */
  close() {
    try {
      this.socket.close()
    } catch {
      // A socket that is already gone needs no closing.
    }
  }
}

/** Poll until `check` returns a truthy value, or the deadline passes. */
async function waitFor(check, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/**
 * Wait until a client's document has actually parsed.
 *
 * Connecting to a target happens the moment the browser creates it, which is
 * measurably before its document is parsed — the target exists, the socket
 * opens, and `Runtime.evaluate` happily returns `""` for `document.title`. That
 * is not an error, so nothing retries: a caller asserting on the page's content
 * fails on an empty string and the failure reads like a missing `<title>`, not
 * like a race. Waiting for `readyState` is what makes the difference.
 *
 * `document_idle` content scripts add a second reason: they run after parse, so
 * anything a page's own script installs is absent at `interactive`.
 *
 * @param {Cdp} client - A connected client.
 * @param {number} [timeoutMs] - How long to wait.
 */
async function waitForDocument(client, timeoutMs = 15_000) {
  await waitFor(async () => {
    const state = await client.eval('document.readyState')
    return state === 'complete' || state === 'interactive'
  }, timeoutMs, 100)
}

/**
 * A running Chromium with this repository's extension installed.
 *
 * Use {@link ExtensionHost.start} rather than the constructor so the caller can
 * skip cleanly when no usable browser exists.
 */
export class ExtensionHost {
  /**
   * @param {object} parts - The started pieces.
   * @param {import('node:child_process').ChildProcess} parts.process - The browser process.
   * @param {number} parts.port - The debugging port.
   * @param {string} parts.profile - The temporary profile directory.
   * @param {string} parts.extensionId - The id the browser actually assigned.
   * @param {string} parts.binary - The executable that was started.
   */
  constructor(parts) {
    Object.assign(this, parts)
    /** @type {Map<string, Cdp>} */
    this.clients = new Map()
  }

  /**
   * Start Chromium with the extension loaded, and wait until its service worker
   * is up.
   *
   * @param {object} [options] - Startup options.
   * @param {string} [options.extensionPath] - The unpacked extension; defaults to `<repo>/extension`.
   * @param {string[]} [options.flags] - Extra browser flags.
   * @param {string} [options.startUrl] - Page to open; defaults to `about:blank`.
   * @returns {Promise<ExtensionHost | undefined>} The host, or undefined when no Chromium is present.
   */
  static async start(options = {}) {
    const binary = findChromium()
    if (binary === undefined) return undefined

    const extensionPath = options.extensionPath ?? join(process.cwd(), 'extension')
    const profile = mkdtempSync(join(tmpdir(), 'dsh-bb-ext-'))
    const port = 9_500 + Math.floor(Math.random() * 1_500)
    const startUrl = options.startUrl ?? 'about:blank'
    const expectedId = extensionIdFor(extensionPath)

    const child = spawn(binary, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--load-extension=${extensionPath}`,
      `--disable-extensions-except=${extensionPath}`,
      // Headless, always. A visible window steals focus from whatever the user
      // is doing, and this suite starts several browsers per run — running
      // windowed means the machine is unusable while tests run. `new` (rather
      // than the old `chrome-headless-shell`) is the full browser: same
      // renderer, same extension support, same CDP surface, no window.
      //
      // It is also what makes `--load-extension` work at all here: the
      // separately-shipped headless shell ignores the switch entirely.
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--no-sandbox',
      `--window-size=1280,900`,
      ...(options.flags ?? []),
      startUrl,
    ], { stdio: ['ignore', 'ignore', 'ignore'] })

    const host = new ExtensionHost({
      process: child,
      port,
      profile,
      extensionId: expectedId,
      binary,
      extensionPath,
    })

    const ready = await waitFor(async () => {
      if (child.exitCode !== null) return false
      try {
        await probe(port, '/json/version')
        return true
      } catch {
        return false
      }
    }, 30_000)

    if (!ready) {
      host.stop()
      throw new Error(`Chromium did not expose a debugging endpoint (exit ${child.exitCode})`)
    }

    // MV3 workers start lazily; the extension's own `onStartup`/module body is
    // what wakes it, so give it a moment before concluding it is absent.
    const worker = await waitFor(() => host.findWorker(), 20_000)
    if (worker === undefined) {
      host.stop()
      throw new Error('the extension loaded but its service worker never appeared')
    }

    // The computed id is Chrome's internal algorithm; confirm rather than trust.
    host.reportedId = worker.url.split('/')[2]
    if (host.reportedId !== expectedId) {
      host.stop()
      throw new Error(`extension id mismatch: computed ${expectedId}, browser reported ${host.reportedId}`)
    }

    // A target in `/json/list` is not yet a target that answers. The worker's
    // entry appears as soon as the browser creates the target, measurably before
    // its default execution context exists — and a `Runtime.evaluate` sent into
    // that window does not fail, it *hangs* until the client's own timeout.
    // This was the first thing the protocol probe hit. Waiting for a real answer
    // is what separates "the worker exists" from "the worker is usable", and
    // only the second is a precondition for anything that follows.
    const responsive = await waitFor(async () => {
      const client = await host.worker()
      const answer = await Promise.race([
        client.eval('typeof chrome === "object" && typeof chrome.runtime?.id === "string" ? chrome.runtime.id : "NOT-READY"'),
        new Promise((resolve) => setTimeout(() => resolve('TIMED-OUT'), 1_500)),
      ])
      return answer === expectedId ? true : undefined
    }, 20_000, 400)

    if (!responsive) {
      host.stop()
      throw new Error('the extension service worker never answered on its CDP target')
    }

    return host
  }

  /**
   * List every target the browser currently has.
   * @returns {Promise<any[]>} Targets, or an empty list when the browser is gone.
   */
  async targets() {
    try {
      return JSON.parse(await probe(this.port, '/json/list'))
    } catch {
      return []
    }
  }

  /**
   * The extension's own service worker target.
   * @returns {Promise<any | undefined>} The target, when it is running.
   */
  async findWorker() {
    const targets = await this.targets()
    return targets.find(
      (target) => target.type === 'service_worker'
        && typeof target.url === 'string'
        && target.url.includes(this.extensionId),
    )
  }

  /**
   * Connect a client to the extension's service worker.
   *
   * This is the console into the extension: anything the extension can do to
   * the browser is reachable from here.
   *
   * @param {string} [name] - Cache key, so one test can hold several clients.
   * @returns {Promise<Cdp>} A connected client.
   */
  async worker(name = 'worker') {
    const cached = this.clients.get(name)
    if (cached !== undefined) return cached
    const target = await this.findWorker()
    if (target === undefined) throw new Error('the extension service worker is not running')
    const client = await new Cdp(target.webSocketDebuggerUrl).connect()
    this.clients.set(name, client)
    return client
  }

  /** The extension's own pages, e.g. the side panel or the options page. */
  async extensionPages() {
    const targets = await this.targets()
    return targets.filter(
      (target) => target.type === 'page' && typeof target.url === 'string'
        && target.url.startsWith(`chrome-extension://${this.extensionId}/`),
    )
  }

  /**
   * Open one of the extension's own pages and connect to it.
   *
   * This is how the side panel and the options page get exercised for real: the
   * panel is a document with its own `chrome.*` access, and the only honest way
   * to test it is to let the browser render it.
   *
   * @param {string} page - File name under `extension/`, e.g. `sidepanel.html`.
   * @returns {Promise<Cdp>} A client on the new page.
   */
  async openExtensionPage(page) {
    const url = `chrome-extension://${this.extensionId}/${page}`
    const created = await openTarget(this.port, url)
    const target = await waitFor(async () => {
      const targets = await this.targets()
      return targets.find((candidate) => candidate.id === created.id)
    }, 15_000)
    if (target === undefined) throw new Error(`the extension page never opened: ${page}`)
    const client = await new Cdp(target.webSocketDebuggerUrl).connect()
    await waitForDocument(client)
    return client
  }

  /**
   * Connect a CDP client to the page behind one `chrome.tabs` tab id.
   *
   * Matching on URL is not enough: a test that opens its fixture at the same URL
   * as the tab it just acted on gets two targets with identical URLs, and
   * `targets().find(...)` then returns whichever the browser happens to list
   * first. That is a coin flip that reads as a flaky assertion — and worse, when
   * it picks the untouched tab the assertion fails for a reason that has nothing
   * to do with the code under test.
   *
   * `chrome.debugger.getTargets()` is the extension's own tabId → targetId map,
   * so this resolves the ambiguity at its source instead of guessing.
   *
   * @param {number} tabId - A `chrome.tabs` id.
   * @returns {Promise<Cdp>} A client on that tab's page.
   */
  async pageForTab(tabId) {
    const worker = await this.worker()
    const targetId = await worker.eval(
      `(async () => {
        const targets = await chrome.debugger.getTargets()
        const match = targets.find((t) => t.tabId === ${Number(tabId)})
        return match === undefined ? null : match.id
      })()`,
    )
    if (targetId === null || typeof targetId !== 'string') {
      throw new Error(`no debugger target for tab ${tabId}`)
    }
    const target = await waitFor(async () => {
      const targets = await this.targets()
      return targets.find((candidate) => candidate.id === targetId)
    }, 15_000)
    if (target === undefined) throw new Error(`target ${targetId} (tab ${tabId}) is not in /json/list`)
    const client = await new Cdp(target.webSocketDebuggerUrl).connect()
    await waitForDocument(client)
    return client
  }

  /**
   * Open a normal http page and connect to it.
   *
   * Returns the target Chrome created, not a URL match, so a URL that is already
   * open elsewhere cannot shadow the new tab.
   *
   * @param {string} url - The page URL.
   * @returns {Promise<Cdp>} A client on the new page.
   */
  async openPage(url) {
    const created = await openTarget(this.port, url)
    const target = await waitFor(async () => {
      const targets = await this.targets()
      return targets.find((candidate) => candidate.id === created.id)
    }, 15_000)
    if (target === undefined) throw new Error(`the page never opened: ${url}`)
    const client = await new Cdp(target.webSocketDebuggerUrl).connect()
    await waitForDocument(client)
    return client
  }

  /**
   * Wait until a tab matching `predicate` exists, then return it.
   *
   * @param {(tab: any) => boolean} predicate - Test applied to each `chrome.tabs` row.
   * @param {number} [timeoutMs] - How long to wait.
   * @returns {Promise<any | undefined>} The tab row, when one appears.
   */
  async waitForTab(predicate, timeoutMs = 15_000) {
    const client = await this.worker()
    return waitFor(async () => {
      const tabs = await client.eval(
        '(async () => (await chrome.tabs.query({})).map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active })))()',
      )
      if (!Array.isArray(tabs)) return undefined
      return tabs.find(predicate)
    }, timeoutMs)
  }

  /** Kill the browser and remove its temporary profile. */
  stop() {
    for (const client of this.clients.values()) client.close()
    this.clients.clear()
    try {
      this.process.kill()
    } catch {
      // A process that already exited needs no killing.
    }
    try {
      rmSync(this.profile, { recursive: true, force: true })
    } catch {
      // A profile directory still held open is not worth failing a test over.
    }
  }
}

/**
 * A tiny static file server for page fixtures.
 *
 * Each test that needs a page serves one from memory rather than reaching the
 * network, so the suite stays offline and deterministic.
 */
export class FixtureServer {
  /**
   * @param {Record<string, string>} routes - Path to HTML body.
   */
  constructor(routes) {
    this.routes = routes
    this.server = createServer((request, response) => {
      const path = request.url ?? '/'
      const body = this.routes[path]
      if (body === undefined) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('not found')
        return
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(body)
    })
  }

  /**
   * Start listening on a free loopback port.
   * @returns {Promise<string>} The origin, e.g. `http://127.0.0.1:8123`.
   */
  async start() {
    const port = 8_000 + Math.floor(Math.random() * 900)
    await new Promise((resolve) => this.server.listen(port, '127.0.0.1', resolve))
    this.origin = `http://127.0.0.1:${port}`
    return this.origin
  }

  /** Stop listening. */
  stop() {
    try {
      this.server.close()
    } catch {
      // Closing a server that never listened is not a failure.
    }
  }
}
