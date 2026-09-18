/**
 * The failure vocabulary.
 *
 * A failed model request carries a message and a code. The message is written
 * for whoever reads the harness log, and it was being painted into the panel
 * verbatim — a paragraph naming environment variables, in red, at 12px. These
 * tests pin the rule that replaced it: the code picks the sentence, the message
 * is only ever the detail.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { test } from './harness.js'
import { failureDetail, failureSentence } from '../../../extension/failure.js'
import { DICTIONARIES, en, pickLocale, translator, zh } from '../../../extension/locales.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..', '..')
const read = (relative) => readFileSync(join(root, relative), 'utf8')

/** Every code the harness can put on a failure, taken from `dsh-llm`. */
const KNOWN_CODES = [
  'MISSING_CREDENTIAL',
  'INVALID_CREDENTIAL',
  'QUOTA',
  'RATE_LIMIT',
  'CONTEXT_WINDOW_EXCEEDED',
  'IMAGE_OFFLOAD_REQUIRED',
  'UNSUPPORTED_CONTENT',
  'UNSUPPORTED_REASONING_EFFORT',
  'TRANSPORT',
  'TIMEOUT',
  'SERVER',
  'EMPTY_RESPONSE',
]

test('every failure code becomes a sentence, not the provider message', () => {
  const t = translator('zh')
  for (const code of KNOWN_CODES) {
    const sentence = failureSentence(code, t)
    assert.equal(typeof sentence, 'string')
    assert.notEqual(sentence, '', `${code} produced an empty sentence`)
    // The whole point: the sentence is ours, so it is never the raw key.
    assert.notEqual(sentence, code, `${code} fell through to the code itself`)
  }
})

test('the credential failure says what to do, not which variable to export', () => {
  const t = translator('zh')
  const sentence = failureSentence('MISSING_CREDENTIAL', t)
  assert.equal(sentence, zh['error.code.credential'])
  // `DEEPSEEK_API_KEY` is what the provider's message names, and it is exactly
  // what must not be the headline: it is an instruction for whoever deployed
  // the harness, not for the person looking at a chat panel.
  assert.equal(sentence.includes('DEEPSEEK'), false)
  assert.equal(sentence.includes('_'), false)
})

test('an unknown code falls back to the panel’s own wording, never to the message', () => {
  const t = translator('zh')
  // "Some provider said something we have no words for" is a worse sentence
  // than the provider's own — but it is in the reader's language, it is short,
  // and it cannot trail off mid-file-path. The detail line keeps the original.
  assert.equal(failureSentence('SOMETHING_NEW', t), zh['error.turnFailed'])
  assert.equal(failureSentence('', t), zh['error.turnFailed'])
  assert.equal(failureSentence(undefined, t), zh['error.turnFailed'])
})

test('both languages answer every code, and neither falls back to the key', () => {
  for (const code of KNOWN_CODES) {
    const zhSentence = failureSentence(code, translator('zh'))
    const enSentence = failureSentence(code, translator('en'))
    // A missing key comes back as the key itself through the translator's
    // fallback chain, which is how a localization gap hides in plain sight.
    assert.equal(zhSentence.startsWith('error.'), false, `zh:${code} is a missing key`)
    assert.equal(enSentence.startsWith('error.'), false, `en:${code} is a missing key`)
    // English and Chinese must be genuinely different text, or one of them was
    // left as a copy of the other.
    assert.notEqual(zhSentence, enSentence, `${code} has the same text in both languages`)
  }
  // An unknown code is the one case where the two legitimately agree, because
  // both fall back to the same generic sentence.
  assert.equal(failureSentence('SOMETHING_NEW', translator('zh')), zh['error.turnFailed'])
  assert.equal(failureSentence('SOMETHING_NEW', translator('en')), en['error.turnFailed'])
})

test('the detail keeps the provider’s words but flattens them to one line', () => {
  assert.equal(failureDetail('a\nb\tc'), 'a b c')
  assert.equal(failureDetail('  padded  '), 'padded')
  assert.equal(failureDetail(''), '')
  assert.equal(failureDetail(undefined), '')
  assert.equal(failureDetail(42), '')
})

test('a failure row shows the sentence and demotes the message', () => {
  const panel = read('extension/sidepanel.js')
  // The row has to be built from the code. Reading it from `row.text` alone is
  // the version that painted a log line into the transcript.
  assert.match(panel, /line\.textContent = failureSentence\(row\.code, t\)/)
  assert.match(panel, /failureDetail\(row\.text\)/)
})

test('the live failure toast is translated too', () => {
  const panel = read('extension/sidepanel.js')
  // The toast is the worst place for a raw log line: it is gone in seconds and
  // cannot be re-read, selected, or searched.
  assert.match(panel, /say\(failureSentence\(payload\.code, t\)\)/)
})

test('the failure row is laid out as a column', () => {
  const html = read('extension/sidepanel.html')
  // `.row` is a flex row, so without an explicit column the sentence and its
  // detail sit side by side and the sentence is squeezed into a sliver a
  // character wide. This was fixed once already and is easy to lose.
  assert.match(html, /\.row\[data-kind="failed"\]\s*\{[^}]*flex-direction:\s*column/)
})

test('the host carries the failure code all the way to the panel', () => {
  // Two hops drop it easily and silently: the frame reduction, and the relay
  // rebuilding its payload from `kind` alone.
  const stream = read('packages/dsh-browser-bridge/lib/stream.js')
  assert.match(stream, /kind: 'failed',\s*\n\s*text: typeof message === 'string' \? message : '',/)
  assert.match(stream, /\.\.\.\(delta\.code === undefined \? \{\} : \{ code: delta\.code \}\)/)

  const chat = read('packages/dsh-browser-bridge/lib/chat.js')
  assert.match(chat, /rows\.push\(\{ kind: 'failed', text, \.\.\.\(code !== '' \? \{ code \} : \{\}\) \}\)/)
})

test('the picker and the failure vocabulary agree on the locale', () => {
  assert.equal(pickLocale('zh-CN'), 'zh')
  assert.equal(pickLocale('en-US'), 'en')
  // Every failure sentence exists in both dictionaries with the same keys.
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
})
