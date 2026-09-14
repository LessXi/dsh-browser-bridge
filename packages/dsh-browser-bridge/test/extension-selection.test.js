/**
 * Structural checks on the selection chain: page → service worker → panel.
 *
 * This chain had no tests, and three separate defects shipped through it at
 * once. Each one was silent — the page looked fine, the panel looked fine, and
 * nothing arrived:
 *
 *   1. The panel asked the tab for its current selection and then **discarded
 *      the answer**, so a highlight made before the panel opened never showed.
 *   2. Clearing a highlight was never reported, so the chip that answers "will
 *      this be attached?" stayed on screen describing a selection that no longer
 *      existed.
 *   3. Reloading the extension leaves the reporter in every open tab alive with
 *      a dead extension context: it still listens, and its messages go nowhere.
 *      Nothing detected it, and nothing recovered.
 *
 * These are static checks rather than behavioural ones, and that is a real
 * limitation: the chain spans a content script, a service worker and a side
 * panel, none of which exists outside Chrome. What they can do is pin the shape
 * of the wiring, which is exactly where all three defects lived.
 *
 * The reporter itself is the exception. It is a self-contained IIFE over
 * `globalThis`, `window`, `document` and `chrome`, so `new Function` can run a
 * real copy against a sandbox — which is how the fourth defect is caught by
 * behaviour rather than by string matching: re-injecting the file was supposed
 * to recover a page whose extension context had died, and the install guard it
 * shipped with made that recovery a no-op, because the dead copy already held
 * the flag.
 *
 * @module dsh-browser-bridge/test/extension-selection
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assert, test } from './harness.js'

const here = dirname(fileURLToPath(import.meta.url))
const extensionDir = join(here, '..', '..', '..', 'extension')

/** @param {string} name - A file in `extension/`. @returns {string} Its text. */
function readExtensionFile(name) {
  return readFileSync(join(extensionDir, name), 'utf8')
}

const reporterSource = readExtensionFile('content-selection.js')

/** Let the promise callbacks the reporter attached run to completion. */
function settle() {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * Build the globals `content-selection.js` expects, and let copies be installed.
 *
 * Each `install()` returns the bucket that *that copy alone* reports into. A
 * count of listeners cannot tell a takeover from a refusal — both leave one
 * listener in place — so the tests have to ask which copy is listening, and a
 * per-copy bucket is the only way to tell.
 *
 * @returns {object} A page whose `install`, `fire`, `flush` and `dead` expose
 *   the reporter's behaviour.
 */
function makePage() {
  /** @param {Map<string, Set<Function>>} bag - One event target's listeners. */
  const target = (bag) => ({
    addEventListener(type, listener) {
      if (!bag.has(type)) bag.set(type, new Set())
      bag.get(type).add(listener)
    },
    removeEventListener(type, listener) {
      bag.get(type)?.delete(listener)
    },
  })

  const timers = new Map()
  let nextTimer = 1

  const page = {
    /** Flipped once the extension context is invalidated. */
    dead: false,
    /** What `window.getSelection()` reports. */
    text: '',
    documentListeners: new Map(),
    windowListeners: new Map(),
    messageListeners: new Set(),
  }

  page.document = { ...target(page.documentListeners), title: 'A page' }
  page.window = target(page.windowListeners)
  page.window.getSelection = () =>
    page.text.length === 0 ? null : { isCollapsed: false, toString: () => page.text }
  page.location = { href: 'https://example.test/article' }

  page.setTimeout = (fn) => {
    const id = nextTimer++
    timers.set(id, fn)
    return id
  }
  page.clearTimeout = (id) => {
    timers.delete(id)
  }
  /** Run whatever the debounce queued. */
  page.flush = () => {
    for (const [id, fn] of [...timers]) {
      timers.delete(id)
      fn()
    }
  }
  /** Fire a DOM event the reporter subscribed to. */
  page.fire = (bag, type) => {
    for (const fn of [...(bag.get(type) ?? [])]) fn()
  }

  /**
   * Install one copy of the reporter, exactly as Chrome would.
   * @returns {object[]} The messages this copy sent, and only this copy.
   */
  page.install = () => {
    /** @type {object[]} */
    const sent = []
    const chrome = {
      runtime: {
        sendMessage(message) {
          // This is the shape that hid the defect: a dead context *rejects*, it
          // does not throw, so a try/catch around the call never sees it.
          if (page.dead) {
            const failure = Promise.reject(new Error('Extension context invalidated.'))
            // A script that ignores this rejection leaves it unhandled — which
            // is the defect, and in Chrome it is a console error. Here it would
            // take the runner down, so the page absorbs its own copy while
            // handing the script the same rejected promise.
            failure.catch(() => {})
            return failure
          }
          sent.push(message)
          return Promise.resolve()
        },
        onMessage: {
          addListener(listener) {
            page.messageListeners.add(listener)
          },
          removeListener(listener) {
            page.messageListeners.delete(listener)
          },
        },
      },
    }
    // eslint-disable-next-line no-new-func
    const run = new Function(
      'globalThis',
      'window',
      'document',
      'chrome',
      'location',
      'setTimeout',
      'clearTimeout',
      reporterSource,
    )
    run(page, page.window, page.document, chrome, page.location, page.setTimeout, page.clearTimeout)
    return sent
  }
  return page
}

test('a re-injected reporter takes over from the copy already installed', async (t) => {
  const page = makePage()
  const first = page.install()
  const second = page.install()
  assert.equal(
    page.documentListeners.get('selectionchange').size,
    1,
    'a document never ends up with two live reporters',
  )

  page.text = 'hello'
  page.fire(page.documentListeners, 'selectionchange')
  page.flush()
  await settle()
  assert.equal(second.length, 1, 'the newest copy is the one that reports')
  assert.equal(first.length, 0, 'and the copy it replaced has been detached')
})

test('a reporter whose extension context died is replaced, not obeyed', async (t) => {
  const page = makePage()
  const dead = page.install()

  // The extension is reloaded: this copy keeps listening and keeps failing.
  page.dead = true
  page.text = '逐字节一致'
  page.fire(page.documentListeners, 'selectionchange')
  page.flush()
  await settle()
  assert.equal(dead.length, 0, 'the dead copy cannot report anything')

  // The panel re-injects. The old copy held the install flag, so before this
  // change the new copy returned immediately and the page stayed silent for the
  // rest of its life — which is what the user saw: a highlight, and no chip.
  page.dead = false
  const live = page.install()
  page.fire(page.documentListeners, 'selectionchange')
  page.flush()
  await settle()
  assert.equal(live.length, 1, 'the replacement reports the selection it was re-injected for')
  assert.equal(live[0].text, '逐字节一致')
})

test('a report that failed is retried instead of being remembered as sent', async (t) => {
  const page = makePage()
  const sent = page.install()

  page.dead = true
  page.text = 'retry me'
  page.fire(page.documentListeners, 'selectionchange')
  page.flush()
  await settle()
  assert.equal(sent.length, 0, 'nothing got through while the context was dead')

  // The same selection, now that the context is live again. The cache has to
  // have been rolled back, or the text counts as already reported and never
  // leaves the page.
  page.dead = false
  page.fire(page.documentListeners, 'pointerup')
  page.flush()
  await settle()
  assert.equal(sent.length, 1, 'the same text is reported again after a failure')
  assert.equal(sent[0].text, 'retry me')
})

test('clearing a highlight is reported, so the chip can go away', async (t) => {
  const page = makePage()
  const sent = page.install()

  page.text = 'selected'
  page.fire(page.documentListeners, 'selectionchange')
  page.flush()
  await settle()
  assert.equal(sent.length, 1)

  page.text = ''
  page.fire(page.documentListeners, 'selectionchange')
  page.flush()
  await settle()
  assert.equal(sent.length, 2, 'an empty selection must reach the service worker')
  assert.equal(sent[1].text, '')
  assert.equal(sent[1].url, 'https://example.test/article')
})

test('the manifest lets the panel inject into every page the reporter covers', (t) => {
  const manifest = JSON.parse(readExtensionFile('manifest.json'))
  const patterns = manifest.content_scripts.flatMap((entry) => entry.matches ?? [])
  const hosts = manifest.host_permissions ?? []
  // `chrome.scripting.executeScript` needs a *host permission*; declaring a
  // content script does not grant one. Without the scheme listed here the
  // recovery path throws on every real page and only ever worked on loopback.
  const schemes = [...new Set(patterns.map((pattern) => pattern.split('://')[0]))]
  assert.ok(schemes.length > 0, 'the reporter is declared for some scheme')
  for (const scheme of schemes) {
    assert.ok(
      hosts.some((host) => host.startsWith(`${scheme}://`)),
      `content scripts match ${scheme}:// but host_permissions are ${JSON.stringify(hosts)}`,
    )
  }
})

test('the service worker forwards an empty selection to the panel but never to the host', (t) => {
  const source = readExtensionFile('background.js')
  assert.ok(
    !source.includes('if (payload.text.length === 0) return false'),
    'an empty selection is news for the panel',
  )
  assert.ok(
    source.includes("chrome.runtime.sendMessage({ type: 'dsh-selection-changed', payload })"),
    'the panel is told about every transition',
  )
  assert.ok(
    /if \(payload\.text\.length > 0\) \{/.test(source),
    'but the host is only told about a selection it could actually attach',
  )
})

test('the panel uses the answer it asked the page for', (t) => {
  const source = readExtensionFile('sidepanel.js')
  assert.ok(
    source.includes("chrome.tabs.sendMessage(tab.id, { type: 'dsh-selection-request' })"),
    'the request is still made',
  )
  assert.ok(source.includes('applySelection(reply)'), 'and its answer is adopted, not dropped')
  assert.ok(source.includes("message?.type !== 'dsh-selection-changed'"), 'the event channel still feeds the same place')
  assert.ok(source.includes('function applySelection('), 'one adopted shape for both paths')
})

test('the panel recovers a reporter whose extension context was invalidated', (t) => {
  const source = readExtensionFile('sidepanel.js')
  assert.ok(source.includes('chrome.scripting.executeScript'), 'a dead reporter is detected and replaced')
  assert.ok(source.includes("files: ['content-selection.js']"), 'by re-injecting the same file')
  assert.ok(
    source.indexOf('chrome.scripting.executeScript') < source.indexOf('applySelection(reply)'),
    'the recovery happens before adopting the answer',
  )
})

test('the reported file name matches the one the manifest declares', (t) => {
  // A rename on either side would silently break recovery, which is the failure
  // mode this whole suite exists for.
  const manifest = JSON.parse(readExtensionFile('manifest.json'))
  const declared = manifest.content_scripts.flatMap((entry) => entry.js ?? [])
  const injected = readExtensionFile('sidepanel.js').match(/files: \['([^']+)'\]/)
  assert.ok(injected !== null, 'the panel injects a file by name')
  assert.ok(
    declared.includes(injected[1]),
    `${injected[1]} is injected but the manifest declares ${JSON.stringify(declared)}`,
  )
  assert.ok(
    (manifest.permissions ?? []).includes('scripting'),
    'executeScript needs the scripting permission',
  )
})

test('a refused attachment is reported rather than silently dropped', (t) => {
  // The host answers every send with `context: { staged, refused }`. Reading it
  // is the difference between "your highlight was attached" and "your highlight
  // was promised by a chip and then discarded".
  const source = readExtensionFile('sidepanel.js')
  assert.ok(source.includes('payload?.context?.refused'), 'the send path reads the host’s answer')
  assert.ok(source.includes("t('error.attachmentRefused'"), 'and says so when something was refused')
  const locales = readExtensionFile('locales.js')
  assert.ok(locales.includes("'error.attachmentRefused'"), 'with copy in both dictionaries')
})

test('the panel re-reads the selection when the active tab changes', (t) => {
  const source = readExtensionFile('sidepanel.js')
  assert.ok(
    source.includes('chrome.tabs.onActivated.addListener'),
    'without this the chip keeps describing the tab the panel was opened on',
  )
})
