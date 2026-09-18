/**
 * Turn a provider failure into a sentence, without showing the log line.
 *
 * A failed model request arrives with two things: a `message`, written for
 * whoever reads the harness log, and a `code`. The message is not copy — it
 * names environment variables, tells the reader to go and edit a config file,
 * and can run to a paragraph. Rendering it in a 360px panel is what made a
 * failed turn look like a stack trace that someone had left on the screen, and
 * it is unreadable in the exact moment a person wants to know one thing: did my
 * message go through, and if not, why not.
 *
 * So the code decides the sentence, and the message becomes the detail behind
 * it — still reachable, but no longer the headline.
 *
 * The `t` translator is injected rather than imported so this module stays a
 * pure function and the mapping can be tested without a DOM or a locale.
 *
 * @module failure
 */

/**
 * The sentence for a failure code.
 *
 * Unknown codes fall back to the panel's generic wording rather than to the
 * raw message: "something went wrong" is a worse sentence than the provider's
 * own, but it is in the reader's language and it never trails off mid-file-path.
 * The raw message is not discarded — {@link failureDetail} keeps it.
 *
 * @param {string} code - The harness's failure code, possibly empty.
 * @param {(key: string) => string} t - The panel's translator.
 * @returns {string} A short sentence naming what went wrong.
 */
export function failureSentence(code, t) {
  if (code === 'MISSING_CREDENTIAL' || code === 'INVALID_CREDENTIAL') return t('error.code.credential')
  if (code === 'QUOTA') return t('error.code.quota')
  if (code === 'RATE_LIMIT') return t('error.code.rateLimited')
  if (code === 'CONTEXT_WINDOW_EXCEEDED') return t('error.code.tooLong')
  if (code === 'IMAGE_OFFLOAD_REQUIRED' || code === 'UNSUPPORTED_CONTENT') return t('error.code.noImages')
  if (code === 'UNSUPPORTED_REASONING_EFFORT') return t('error.code.reasoning')
  if (code === 'TRANSPORT' || code === 'NETWORK' || code === 'TIMEOUT' || code === 'SERVER') {
    return t('error.code.unreachable')
  }
  if (code === 'EMPTY_RESPONSE') return t('error.code.empty')
  return t('error.turnFailed')
}

/**
 * The provider's own words, for the detail line under a failure.
 *
 * Kept because a generic sentence is not enough to act on when the case is one
 * this module has no code for — the reader still needs something to search for.
 * Whitespace is collapsed because the messages are multi-line prose and the row
 * is one line.
 *
 * @param {unknown} text - The provider's message.
 * @returns {string} One line, or an empty string when there is nothing to show.
 */
export function failureDetail(text) {
  if (typeof text !== 'string') return ''
  return text.replace(/\s+/g, ' ').trim()
}
