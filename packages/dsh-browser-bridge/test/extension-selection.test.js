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

test('the reporter installs once per document, so re-injection is safe', (t) => {
  const source = readExtensionFile('content-selection.js')
  assert.ok(
    source.includes('globalThis.__dshSelectionReporter === true'),
    'a second copy would double every listener in the shared isolated world',
  )
  assert.ok(source.includes('globalThis.__dshSelectionReporter = true'))
})

test('clearing a highlight is reported, so the chip can go away', (t) => {
  const source = readExtensionFile('content-selection.js')
  // The old shape: set the cache, then bail on empty before sending.
  assert.ok(
    !/lastReported = text\s*\n\s*if \(text\.length === 0\) return/.test(source),
    'an empty selection must reach the service worker',
  )
  assert.ok(/lastReported = text\s*\n\s*try \{/.test(source), 'the send must follow the cache update directly')
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
