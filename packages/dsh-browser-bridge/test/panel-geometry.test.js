/**
 * The panel's geometry invariants, asserted against its stylesheet.
 *
 * Three defects were found by rendering the panel and measuring it, and all three
 * had shipped clean through 525 tests because every existing test asks what the
 * panel *says*, and none asked where it draws things. This file is the cheapest
 * thing that makes each of them fail loudly if it returns:
 *
 *   1. The editor was the only box in the panel with no corner radius, and it
 *      drew a square focus ring inside a 16px rounded card. Measured radius 0
 *      against the card's 16, with `outline: 2px solid` on the textarea.
 *   2. The editor's text started 8px left of the toolbar's text beneath it,
 *      because the card's 12px padding was the whole inset on one line while the
 *      toolbar's first control added 8px of its own on the other. Measured 22
 *      against 30.
 *   3. The "earlier messages" pill floated over the first message with a
 *      measured 2617px² overlap, and because that state has no overflow there is
 *      no scroll position that reveals the covered line.
 *
 * These are written against the *shape* of the fix rather than against the pixel
 * values it happens to use now, so the panel keeps room to be redesigned. The
 * point of each assertion is the invariant: the editor's focus ring follows the
 * card's radius, the two lines of the composer agree on where "left" is, and the
 * pill's height is stated once rather than twice.
 */

import { assert, test } from './harness.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const extensionDir = join(here, '..', '..', '..', 'extension')

/** @param {string} name - A file in `extension/`. @returns {string} Its text. */
function readExtensionFile(name) {
  return readFileSync(join(extensionDir, name), 'utf8')
}

/** The panel's stylesheet, comments removed so assertions cannot match prose. */
const css = readExtensionFile('sidepanel.html')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')

/** The declaration block of one rule, by exact selector text. */
function ruleBody(selector) {
  // Escaped, because selectors here contain `.`, `#`, `:`, `(` and `)`.
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`(?:^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`))
  return match === null ? null : match[1]
}

/** One property's value inside one rule, or null when either is absent. */
function declarationOf(selector, property) {
  const body = ruleBody(selector)
  if (body === null) return null
  const match = body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]+)`))
  return match === null ? null : match[1].trim()
}

test('the editor draws no focus ring of its own', (t) => {
  // A ring on the bare textarea is a rectangle: the editor has no radius to
  // follow. It has to be the card that lights up, because the card is the shape
  // the reader sees.
  const outline = declarationOf('textarea:focus-visible', 'outline')
  assert.ok(
    outline !== null && /^none\b/.test(outline),
    `textarea:focus-visible must not draw its own outline, found ${JSON.stringify(outline)}`,
  )
  // Buttons and links keep theirs: the defect was specific to a control with no
  // radius, and stripping the ring everywhere would trade a visual bug for a
  // keyboard-accessibility one. Asserted by selector rather than by scanning the
  // whole sheet for `solid`, which would fail on the rule that must stay.
  const shared = ruleBody('button:focus-visible, a:focus-visible')
  assert.ok(
    shared !== null && /outline\s*:\s*2px solid var\(--accent\)/.test(shared),
    'buttons and links must keep a visible focus ring',
  )
  // And the textarea must not also be in that shared selector list, or its own
  // `none` would be a specificity coin-flip rather than a decision.
  assert.ok(
    !/button:focus-visible[^{]*textarea/.test(css),
    'the textarea must be excluded from the shared ring rule, not fighting it',
  )
})

test('the focus ring is drawn on the rounded card, not the editor', (t) => {
  // Conditional on the editor having focus, and expressed with `:has()` because
  // the pill and the editor are siblings: no descendant selector can say it.
  const selector = '#composer:has(textarea:focus-visible)'
  const shadow = declarationOf(selector, 'box-shadow')
  assert.ok(
    shadow !== null,
    `${selector} must carry the focus ring; without it the panel has no visible keyboard focus at all`,
  )
  // The ring has to be added to the card's existing elevation rather than
  // replacing it, or focusing the editor makes the card lose its shadow.
  assert.ok(
    shadow.includes('var(--elevation)'),
    'the focus ring must keep the card elevation, not replace it',
  )
  assert.ok(
    shadow.includes('var(--accent)'),
    'the focus ring must be the accent colour',
  )
  // And the card must actually have a radius for the ring to follow.
  const radius = declarationOf('#composer', 'border-radius')
  assert.ok(
    radius !== null && radius !== '0',
    `#composer must keep a radius for the ring to follow, found ${JSON.stringify(radius)}`,
  )
})

test('the two lines of the composer agree on where the text starts', (t) => {
  // The card pads 12px on the left. The toolbar's first control adds its own
  // padding, so the editor has to inset its text by the same amount or the two
  // lines disagree — measured 8px apart before the fix, which reads as a mistake
  // because it is one.
  const cardPadding = declarationOf('#composer', 'padding')
  assert.ok(cardPadding !== null, '#composer must declare its padding')
  const cardLeft = Number.parseFloat(cardPadding.split(/\s+/)[1] ?? cardPadding)
  assert.ok(Number.isFinite(cardLeft), `#composer padding is not readable: ${cardPadding}`)

  const modelPadding = declarationOf('#model', 'padding')
  assert.ok(modelPadding !== null, '#model must declare its padding')
  // `0 6px 0 8px` — the two-value shorthand would make this unreadable, and the
  // toolbar's first control is exactly where the alignment comes from.
  const modelParts = modelPadding.split(/\s+/)
  const modelLeft = Number.parseFloat(modelParts[3] ?? modelParts[1] ?? modelParts[0])
  assert.ok(Number.isFinite(modelLeft), `#model padding is not readable: ${modelPadding}`)

  const editorPadding = declarationOf('#input', 'padding')
  assert.ok(editorPadding !== null, '#input must declare its padding')
  const editorParts = editorPadding.split(/\s+/)
  const editorLeft = Number.parseFloat(editorParts[3] ?? editorParts[1] ?? editorParts[0])

  // The invariant, not the numbers: whatever the three values become, text on
  // the editor's line and text on the toolbar's line must start at the same x.
  const editorTextX = cardLeft + editorLeft
  const modelTextX = cardLeft + modelLeft
  assert.equal(
    editorTextX,
    modelTextX,
    `the editor's text starts at ${editorTextX}px and the toolbar's at ${modelTextX}px; `
    + 'the two lines of one composer have to agree',
  )
})

test('the editor keeps a focus ring under forced colours', (t) => {
  // The fourth geometry defect, and the first one that is not about position.
  //
  // `textarea:focus-visible { outline: none }` above moves the ring onto the
  // card, and the card draws it with `box-shadow`. Windows High Contrast
  // discards `box-shadow` — that is what the mode is — so in that mode the ring
  // is not painted while the browser's own outline has already been switched
  // off. Measured with the emulated feature: all seven focusable controls lose
  // their shadow, six survive on the browser's outline, and the editor ends up
  // with no visible focus at all — the control the panel focuses as it opens.
  //
  // The fix is scoped to `forced-colors` on purpose, and both halves are
  // asserted: a rule for that mode, and *no* unconditional outline on the
  // textarea. An outline declared outside the media query would put the square
  // ring back inside the rounded card in the ordinary render, which is the
  // defect this file's first test exists to prevent.
  const forced = css.match(/@media\s*\(forced-colors:\s*active\)\s*\{([\s\S]*?)\n\s*\}/)
  assert.ok(
    forced !== null,
    'the stylesheet needs a `@media (forced-colors: active)` block for the editor focus ring',
  )
  // An outline, not a shadow: forced colours repaint outlines in the system
  // highlight colour and keep them, which is the whole reason this works.
  assert.ok(
    /textarea:focus-visible\s*\{[^}]*outline\s*:\s*[^;]*\bHighlight\b/.test(forced[1]),
    `the editor must regain an outline under forced colours, found ${JSON.stringify(forced[1].trim().slice(0, 120))}`,
  )

  // And the ordinary render must be untouched: the textarea's own rule still
  // says `none`, so the ring is still the card's business everywhere else.
  const own = declarationOf('textarea:focus-visible', 'outline')
  assert.ok(
    own !== null && /^none\b/.test(own),
    `the unconditional textarea rule must stay \`outline: none\`, found ${JSON.stringify(own)}`,
  )
})

test('the earlier-content pill states its height once', (t) => {
  // The transcript reserves room for the pill, so the reservation and the pill
  // are two places that must agree about one number. Written twice they drift;
  // written as a token they cannot.
  const pills = css.match(/--pill-height\s*:\s*([^;]+);/)
  assert.ok(pills !== null, 'the pill height must be a token so both places read one value')

  const pillHeight = declarationOf('#earlier', 'height')
  assert.ok(
    pillHeight !== null && pillHeight.includes('--pill-height'),
    `#earlier must take its height from the token, found ${JSON.stringify(pillHeight)}`,
  )

  // And the rule that reserves the space must exist, or the pill floats over the
  // first message again — a measured 2617px² occlusion with no way to scroll it
  // into view.
  const reservation = declarationOf('#stage:has(#earlier:not([hidden])) #transcript', 'padding-top')
  assert.ok(
    reservation !== null,
    'the transcript must reserve room while the pill is up, or the pill covers the first message',
  )
  assert.ok(
    reservation.includes('--pill-height'),
    `the reservation must use the same token as the pill, found ${JSON.stringify(reservation)}`,
  )
})

test('the pill reservation is conditional, not permanent', (t) => {
  // An unconditional strip of empty space at the top of every conversation would
  // be a worse defect than the occlusion it fixes. The `:has()` guard is what
  // makes the padding appear only when the pill does.
  const guarded = '#stage:has(#earlier:not([hidden])) #transcript'
  assert.ok(
    ruleBody(guarded) !== null,
    'the reservation must be guarded by the pill actually being visible',
  )
  // The base rule must stay at its own padding: if the guard were dropped and the
  // rule written unconditionally, this is where it would show.
  const base = declarationOf('#transcript', 'padding')
  assert.ok(
    base !== null && !base.includes('--pill-height'),
    'the transcript must not reserve room for a pill that is not on screen',
  )
})
