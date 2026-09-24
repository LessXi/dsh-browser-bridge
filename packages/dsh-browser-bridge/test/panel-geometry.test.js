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
 *   3. The "earlier messages" pill floated over a message with a measured
 *      2617px² overlap. That was fixed by reserving room — as `padding-top` on
 *      the scroller, which is the wrong side of the boundary: padding is inside
 *      the scrollable content, so it scrolls away, and the reader who scrolls is
 *      the one the pill exists for. Measured on that fix: no overlap at
 *      `scrollTop: 0`, 3093px² once scrolled. It is a margin on the scroller now,
 *      which shrinks the scroller's own box instead.
 *
 * Point 3 is the reason this file asserts *where* the reservation is rather than
 * only that one exists. The first version of that assertion required
 * `padding-top`, so it passed against the broken fix and would have failed
 * against a correct one — a test that pins a defect in place is worse than no
 * test, because it turns a fix into a regression.
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

/**
 * The stylesheet with its `@media` blocks removed.
 *
 * Rules inside a media query describe a *conditional* render, so a lookup of
 * what a property is in the ordinary one has to skip them. Removing the blocks
 * by bracket matching rather than by a regular expression, because the block
 * contains braces of its own and any greedy-or-lazy pattern cuts in the wrong
 * place.
 *
 * @param {string} source - CSS text, comments already stripped.
 * @returns {string} The same text without its `@media` blocks.
 */
function withoutMediaQueries(source) {
  let out = ''
  let index = 0
  for (;;) {
    const at = source.indexOf('@media', index)
    if (at < 0) return out + source.slice(index)
    out += source.slice(index, at)
    const open = source.indexOf('{', at)
    if (open < 0) return out
    let depth = 1
    let cursor = open + 1
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === '{') depth += 1
      else if (source[cursor] === '}') depth -= 1
      cursor += 1
    }
    index = cursor
  }
}

/**
 * Every `@media` block whose condition text matches, concatenated.
 *
 * Plural on purpose. A condition is not a location: this stylesheet has two
 * `prefers-reduced-motion: reduce` blocks, one stopping the waiting row's sweep
 * and one stopping motion by property. Returning only the first meant a test
 * that asked "does reduced motion stop transitions" read the sweep block, found
 * no `transition-property` in it, and reported a defect that was not there — the
 * same shape of mistake as a probe reading the wrong element, which this project
 * has recorded more than once.
 *
 * Brace-matched rather than pattern-matched: these blocks hold nested rules, and
 * a lazy `[\s\S]*?` stops at the first `}` it meets — the same reason
 * `withoutMediaQueries` counts braces.
 *
 * @param {string} condition - Text inside the parentheses, e.g. `prefers-reduced-motion: reduce`.
 * @returns {string} The contents of every matching block, concatenated; empty when there are none.
 */
function mediaBlock(condition) {
  const needle = `@media (${condition})`
  let out = ''
  let index = 0
  for (;;) {
    const at = css.indexOf(needle, index)
    if (at < 0) return out
    const open = css.indexOf('{', at)
    if (open < 0) return out
    let depth = 1
    let cursor = open + 1
    while (cursor < css.length && depth > 0) {
      if (css[cursor] === '{') depth += 1
      else if (css[cursor] === '}') depth -= 1
      cursor += 1
    }
    out += `${css.slice(open + 1, cursor - 1)}\n`
    index = cursor
  }
}

/**
 * Every selector in a block that declares a given property, with its value.
 *
 * @param {string} block - CSS text of a rule list.
 * @param {string} property - Property name to look for, e.g. `transition`.
 * @returns {Array<{selectors: string[], value: string}>} One entry per matching declaration.
 */
function declarationsOf(block, property) {
  const pattern = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'i')
  const found = []
  for (const match of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declaration = match[2].match(pattern)
    if (declaration === null) continue
    found.push({
      selectors: match[1].split(',').map((part) => part.trim()),
      value: declaration[1].trim(),
    })
  }
  return found
}

/**
 * The declaration block of one rule, by exact selector text.
 *
 * The selector is matched as a whole item in the rule's selector list, not as a
 * substring of the stylesheet. The earlier version searched for the selector
 * followed by `{`, which cannot tell a rule that *is* `#composer` from a rule
 * that merely *lists* it — so the moment a group rule named it, every lookup for
 * `#composer` returned that group's declarations instead, and two tests about
 * the composer's radius and padding failed while both declarations were intact
 * on disk. Splitting the list is what makes the two cases different.
 *
 * Media queries are excluded so that a conditional override cannot shadow the
 * base rule; the forced-colours tests read that block directly.
 *
 * @param {string} selector - One exact selector, e.g. `#composer`.
 * @returns {string|null} The declarations inside, or null when no such rule.
 */
function ruleBody(selector) {
  const base = withoutMediaQueries(css)
  for (const match of base.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(',').map((part) => part.trim())
    if (selectors.includes(selector)) return match[2]
  }
  return null
}

/** One property's value inside one rule, or null when either is absent. */
function declarationOf(selector, property) {
  const body = ruleBody(selector)
  if (body === null) return null
  const match = body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]+)`))
  return match === null ? null : match[1].trim()
}

/** The raw markup, comments removed, for asking what the document contains. */
const html = readExtensionFile('sidepanel.html').replace(/<!--[\s\S]*?-->/g, '')

/**
 * The `id` and classes of each direct child of an element, read from the markup.
 *
 * The overlays are found by enumerating what the document actually holds instead
 * of by naming them, so a chip added later is covered by the same assertion
 * without anyone remembering to add it here.
 *
 * @param {string} parentId - The `id` of the parent element.
 * @returns {{id: string, classes: string[]}[]} Each direct child that has an `id`.
 */
function markupOf(parentId) {
  const open = html.indexOf(`id="${parentId}"`)
  if (open === -1) return []
  // Walk from the opening tag to its matching close, counting depth so that a
  // nested element with children of its own does not end the scan early.
  const tag = html.slice(open).match(/^id="[^"]+"[^>]*>/)
  if (tag === null) return []
  const bodyStart = open + tag[0].length

  const children = []
  const depth = { value: 0 }
  const token = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|[^>"])*)>/g
  token.lastIndex = bodyStart
  for (let match = token.exec(html); match !== null; match = token.exec(html)) {
    const [whole, closing, tagName, attributes] = match
    // Void elements never nest.
    const isVoid = /^(br|hr|img|input|meta|link|source|path|circle|rect|use)$/i.test(tagName)
    if (closing === '/') {
      if (depth.value === 0) break
      depth.value -= 1
      continue
    }
    if (depth.value === 0) {
      const id = attributes.match(/id="([^"]+)"/)
      if (id !== null) {
        const classAttribute = attributes.match(/class="([^"]+)"/)
        children.push({
          id: id[1],
          classes: classAttribute === null ? [] : classAttribute[1].split(/\s+/).filter(Boolean),
        })
      }
    }
    if (!isVoid && !whole.endsWith('/>')) depth.value += 1
  }
  return children
}

/**
 * One property's value, from the element's own rule or from a class it carries.
 *
 * `#transcript` is a scroller because of the `.scroll` class rather than because
 * of anything in its own rule, so resolving only `#id` rules reads it as a
 * non-scroller and the check below then proves nothing.
 *
 * @param {{id: string, classes: string[]}} element - A child from `markupOf`.
 * @param {string} property - The property to look up.
 * @returns {string|null} The first declaration found, or null.
 */
function styleOf(element, property) {
  const own = declarationOf(`#${element.id}`, property)
  if (own !== null) return own
  for (const className of element.classes) {
    const fromClass = declarationOf(`.${className}`, property)
    if (fromClass !== null) return fromClass
  }
  return null
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
  //
  // Looked up by one selector the rule lists, not by the whole list: `ruleBody`
  // matches a selector *item*, so asking for `button:focus-visible, a:focus-visible`
  // asks for a rule whose list is that single string — which no rule is. Reading
  // it through the first item also keeps the assertion honest if a third control
  // joins the rule.
  const shared = ruleBody('button:focus-visible')
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

/**
 * A short conversation rests on the composer instead of floating at the top of
 * an empty panel.
 *
 * Measured on the `normal` scene before the fix: four rows, and 234px of empty
 * panel between the last one and the composer. Every chat surface the reader
 * already uses stacks from the bottom, because the message they just sent
 * belongs directly above the box they typed it in.
 *
 * The interesting half of this test is what it *forbids*. The obvious way to
 * bottom-align a flex column is `justify-content: flex-end`, and it is wrong:
 * alignment is applied after overflow, so a container taller than its scroller
 * pushes its first rows somewhere scrolling cannot reach. Measured with 60 rows
 * in the panel, `flex-end` reported `overflows: false` — the layout had
 * swallowed everything above the fold, and the start of the conversation became
 * unreachable. That failure is invisible in a short conversation, which is
 * exactly why it is asserted here rather than left to the next person's
 * judgement.
 */
test('a short conversation sits on the composer, and a long one still scrolls', (t) => {
  const base = ruleBody('#transcript')
  assert.ok(base !== null, '#transcript must have a base rule')

  // The mechanism. An automatic top margin on the first row collapses to zero
  // when there is no free space, so the two states do not fight.
  const firstRow = declarationOf('#transcript > :first-child', 'margin-top')
  assert.ok(
    firstRow !== null && firstRow.trim() === 'auto',
    `the first row must take the slack above it, found ${JSON.stringify(firstRow)}`,
  )

  // The trap. `flex-end` reads as the tidier spelling of the same intent and
  // silently makes a long conversation's start unreachable.
  assert.ok(
    !/justify-content\s*:\s*(flex-end|end)\b/.test(base),
    'the transcript must not bottom-align with justify-content: alignment is applied '
    + 'after overflow, so the rows above the fold become unreachable',
  )

  // And the choice of margin over padding is the same one the pill's reservation
  // makes, for the same reason: padding belongs to the content and scrolls,
  // while an automatic margin is space the first row only holds while there is
  // slack. A padding-top large enough to push a short conversation down would
  // indent every long one permanently.
  const padding = declarationOf('#transcript', 'padding')
  assert.ok(
    padding !== null && !/\bauto\b/.test(padding),
    `the transcript's padding must stay a fixed value, found ${JSON.stringify(padding)}`,
  )
})

test('the earlier-content pill states its height once', (t) => {
  // The transcript reserves room for the pill, so the reservation and the pill
  // are two places that must agree about one number. Written twice they drift;
  // written as a token they cannot.
  const pills = css.match(/--pill-height\s*:\s*([^;]+);/)
  assert.ok(pills !== null, 'the pill height must be a token so both places read one value')

  // `min-height` and not `height`: the pill holds a label, so it has to be able
  // to grow past this when the reader enlarges the font. A fixed `height` here
  // would clip the label — measured at a 32px root, the 26px box held a 52px
  // two-line label. The token still states the resting size, which is what the
  // reservation needs, so the contract this test is about is unchanged.
  const pillHeight = declarationOf('#earlier', 'min-height')
  assert.ok(
    pillHeight !== null && pillHeight.includes('--pill-height'),
    `#earlier must take its height from the token, found ${JSON.stringify(pillHeight)}`,
  )
  assert.equal(
    declarationOf('#earlier', 'height'),
    null,
    'the pill must not pin its own height, or the label is clipped when the font grows',
  )

  const reservation = declarationOf('#stage:has(#earlier:not([hidden])) #transcript', 'margin-top')
  assert.ok(
    reservation !== null,
    'the transcript must reserve room while the pill is up, or the pill covers a row',
  )
  assert.ok(
    reservation.includes('--pill-height'),
    `the reservation must use the same token as the pill, found ${JSON.stringify(reservation)}`,
  )
})

test('the pill reservation is outside the scrollable content', (t) => {
  // This is the invariant the padding version broke, and it is worth stating as
  // its own rule because the two look interchangeable and are not.
  //
  // `#earlier` is absolutely positioned against `#stage`, so it stays at the top
  // of the viewport. Padding on `#transcript` belongs to the *content*, so it
  // scrolls away — and the reader who scrolls is exactly the reader the pill
  // exists for. Measured on the padding version: 0px² overlap at `scrollTop: 0`
  // and 3093px² once scrolled, covering whichever row was passing the top,
  // including the reader's own messages. As a margin on the scroller it shrinks
  // the scroller's own box (the cross axis of the `#stage` flex row) and the
  // reserved strip never becomes content, so no scroll position can move it.
  //
  // Asserted as "not padding" rather than "is margin", so the panel keeps room to
  // reserve the space some other way that has the same property.
  const guard = '#stage:has(#earlier:not([hidden])) #transcript'
  assert.equal(
    declarationOf(guard, 'padding-top'),
    null,
    'reserving room as padding on the scroller puts the reservation inside the content, where scrolling removes it',
  )

  const reservation = declarationOf(guard, 'margin-top')
  assert.ok(
    reservation !== null,
    'the reservation must be on the scroller’s own box rather than in its content',
  )
})

/** The `id` each element is bound to in the renderer, e.g. `to-bottom` → `toBottom`. */
function variableNames(script) {
  const names = new Map()
  const binding = /const\s+(\w+)\s*=\s*document\.getElementById\('([^']+)'\)/g
  for (let match = binding.exec(script); match !== null; match = binding.exec(script)) {
    names.set(match[2], match[1])
  }
  return names
}

/**
 * Whether an element is only ever shown in the chat view.
 *
 * Read from each `<variable>.hidden = …` assignment's own right-hand side, and
 * from the definition of a single named flag when the right-hand side is one.
 * Both parts are needed because the renderer states the same condition three
 * ways: `view !== 'chat'` inline, `next !== 'chat'` after a view switch, and
 * `!wanted` where `wanted` is computed a line above from `view === 'chat' && …`.
 *
 * The right-hand side has to be isolated to the end of its own line: `#transcript`
 * and `#history` are hidden on adjacent lines, so any window wide enough to
 * include a neighbouring line reads `#history` as chat-gated too.
 *
 * @param {string} script - The renderer source.
 * @param {string} variable - The element's binding name.
 * @returns {boolean} True when every assignment that shows it gates on the chat view.
 */
function chatViewOnly(script, variable) {
  const assignments = [...script.matchAll(new RegExp(`${variable}\\.hidden\\s*=\\s*([^\\n]+)`, 'g'))]
  if (assignments.length === 0) return false
  return assignments.every((match) => {
    const expression = match[1]
    if (expression.includes("'chat'")) return true
    // A bare flag: find where it was computed in the preceding lines.
    const flag = expression.match(/^!?\s*(\w+)\s*$/)?.[1]
    if (flag === undefined) return false
    const before = script.slice(0, match.index)
    const definition = [...before.matchAll(new RegExp(`${flag}\\s*=\\s*([^\\n]+)`, 'g'))].at(-1)
    return definition !== undefined && definition[1].includes("'chat'")
  })
}

test('every floating overlay over the transcript reserves its own room', (t) => {
  // The class rule, rather than a rule about the pill.
  //
  // The pill's occlusion was found and fixed as an isolated defect — the assert
  // above required `padding-top` and nothing else. But the pill was not special:
  // `#to-bottom` is the same shape, and it was covering seven characters
  // (`"：Type，来"`, measured per character) while the suite stayed green. Fixing
  // instances one at a time is how the second one gets missed, so this asserts
  // the property that makes them the same defect:
  //
  //   an absolutely positioned overlay drawn over a scroll container, where the
  //   two are siblings, cannot be reserved for by anything inside that container.
  //
  // Enumerated from the markup rather than hardcoded, so an overlay added later
  // has to answer this too. Two things are excluded, and each is excluded for a
  // structural reason rather than to make the test pass:
  //
  //   - `#blocked` is `inset: 0` with an opaque background: it replaces the panel
  //     on purpose rather than floating a chip over text.
  //   - `#history` never shares the screen with an overlay. Both overlays are
  //     chat-view only and `#history` is shown outside it, so asserting a
  //     reservation across the two would ask for room that can never be needed.
  const stageChildren = markupOf('stage')
  assert.ok(stageChildren.length > 0, 'expected to find the children of #stage in the markup')

  const script = readExtensionFile('sidepanel.js')
  const names = variableNames(script)
  const chatGated = (child) => names.has(child.id) && chatViewOnly(script, names.get(child.id))

  const scrollContainers = stageChildren.filter((child) => {
    const overflow = styleOf(child, 'overflow-y')
    return overflow === 'auto' || overflow === 'scroll'
  })
  assert.ok(
    scrollContainers.length > 0,
    'expected #stage to contain the scroller the overlays float over',
  )

  const chatScroller = scrollContainers.filter(chatGated)
  assert.equal(
    chatScroller.length,
    1,
    `expected exactly one scroller shown in the chat view, found ${JSON.stringify(chatScroller.map((c) => c.id))}`,
  )

  const overlays = stageChildren.filter((child) => {
    const position = styleOf(child, 'position')
    if (position !== 'absolute' && position !== 'fixed') return false
    // A full-cover panel replaces what is under it on purpose.
    const inset = styleOf(child, 'inset')
    if (inset !== null && inset.replace(/\s/g, '') === '0') return false
    return chatGated(child)
  })
  assert.ok(
    overlays.length > 0,
    'expected to find the chat-view overlays in #stage — if this is 0 the check below proves nothing',
  )

  for (const overlay of overlays) {
    for (const scroller of chatScroller) {
      const guard = `#stage:has(#${overlay.id}:not([hidden])) #${scroller.id}`
      const body = ruleBody(guard)
      assert.ok(
        body !== null,
        `#${overlay.id} floats over #${scroller.id} with no reservation rule; measured, that covers the characters passing underneath it`,
      )
      // And the reservation must be outside the content — see the test above for
      // why padding on the scroller does not work.
      const inside = declarationOf(guard, 'padding-top') ?? declarationOf(guard, 'padding-bottom')
      assert.equal(
        inside,
        null,
        `#${overlay.id} reserves its room inside #${scroller.id}'s content, where scrolling removes it`,
      )
      const outside = declarationOf(guard, 'margin-top') ?? declarationOf(guard, 'margin-bottom')
      assert.ok(
        outside !== null,
        `#${overlay.id} must reserve its room on #${scroller.id}'s own box`,
      )
    }
  }
})

test('the pill reservation is conditional, not permanent', (t) => {
  // An unconditional strip of empty space at the top of every conversation would
  // be a worse defect than the occlusion it fixes. The `:has()` guard is what
  // makes the reservation appear only when the pill does.
  const guarded = '#stage:has(#earlier:not([hidden])) #transcript'
  assert.ok(
    ruleBody(guarded) !== null,
    'the reservation must be guarded by the pill actually being visible',
  )
  // The base rule must keep only its own padding and margin: if the guard were
  // dropped and the rule written unconditionally, this is where it would show.
  const base = declarationOf('#transcript', 'padding')
  assert.ok(
    base !== null && !base.includes('--pill-height'),
    'the transcript must not reserve room for a pill that is not on screen',
  )
})

/**
 * Every surface that floats over the conversation keeps an edge under Windows
 * High Contrast.
 *
 * `--elevation` opens with `0 0 0 1px #0000000a` — a hairline drawn *as a
 * shadow* — and that mode discards `box-shadow` while repainting every
 * background as `Canvas`. A surface that separates itself with nothing else
 * therefore ends up the same colour as what is behind it, with no boundary:
 * measured with the feature emulated, `#earlier`, `#to-bottom`, `#model-menu`
 * and `#composer` each reported no separator at all, and the model picker's rows
 * read as part of the conversation behind them.
 *
 * `#at-menu` came through that measurement untouched, on the `border` it already
 * had — which is the whole finding, since a border is the one separator this
 * mode keeps. The fix is therefore a border, applied to every floating surface
 * in the mode rather than to the four that failed, so that the next one added
 * inherits it.
 *
 * The surfaces are found by *property* — a drawn box that separates itself with
 * a shadow and no border — rather than by their `id`s, the same way the overlay
 * test above finds its own, so a surface added later is covered without anyone
 * remembering to extend this list. Read from the markup because these are real
 * elements in the document; asserted on the stylesheet because that is where the
 * mode's rules live.
 */
/**
 * Whether a bordered selector in the mode's block covers this element.
 *
 * `#composer:has(textarea:focus-visible)` and `#composer` are the same element
 * seen in two states, so a border declared for either one reaches it. Comparing
 * the selector strings alone reads those as two different things and reports the
 * composer as unprotected — which is how the first version of this test failed.
 * The comparison is therefore on the element part of the selector, up to the
 * first `:` or `[`, so state and attribute qualifiers do not hide a match.
 *
 * @param {Set<string>} bordered - Selectors the mode gives a border to.
 * @param {string} selector - The surface being checked.
 * @returns {boolean} True when one of the bordered selectors names this element.
 */
function borderedUnder(bordered, selector) {
  /** The element a selector names, with its state qualifiers dropped. */
  const elementOf = (text) => text.split(/[:\[]/)[0].trim()
  const wanted = elementOf(selector)
  for (const candidate of bordered) {
    if (elementOf(candidate) === wanted) return true
  }
  return false
}

test('the search hit is outlined on the message, not on the row', (t) => {
  // Measured in a real browser on the "zebra" hit: an outline on `.row` drew a
  // 360px box around 248px of ink, because a row is a full-width flex container
  // and a user message is an end-aligned bubble inside it. 100px of blank space
  // was boxed on the left of the message the reader was being shown.
  //
  // The signal has to be the size of the thing it points at, so the outline
  // belongs on the message. Asserted through the selector text because that is
  // what decides which element the browser paints.
  const outlineRule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => /outline\s*:\s*2px solid var\(--accent\)/.test(match[2]))
    .flatMap((match) => match[1].split(',').map((part) => part.trim()))

  assert.ok(outlineRule.length > 0, 'the hit outline must exist; this test reads it to know what the browser paints')

  // Named by the element that carries the ink, never by the row container alone.
  const messageKinds = ['.bubble', '.answer', '.failure', '.reasoning-toggle']
  for (const kind of messageKinds) {
    assert.ok(
      outlineRule.some((selector) => selector.endsWith(`> ${kind}`)),
      `a hit on a row holding ${kind} must outline ${kind} itself, not the whole row`,
    )
  }

  // And each of those has to be gated on the class the panel actually sets.
  // `endsWith('> .bubble')` alone is satisfied by `#transcript .row.found >
  // .bubble` — a rule that would never match, since `drawFindFocus` adds `hit`.
  // Measured: renaming only that one selector left every test in this file
  // green while the user bubble lost its highlight entirely.
  for (const kind of messageKinds) {
    assert.ok(
      outlineRule.some((selector) => selector.endsWith(`> ${kind}`) && /\.hit\b/.test(selector)),
      `${kind} must be outlined under the \`hit\` class the panel adds, not some other one`,
    )
  }

  // And no rule may outline the bare row for a kind that holds a message, which
  // is the shape the defect had.
  assert.ok(
    !outlineRule.includes('#transcript .row.hit'),
    'outlining the bare row is the defect: it boxes the empty half of an end-aligned message',
  )
})

test('a reasoning row can be highlighted at all', (t) => {
  // A reasoning row is not a `.row` — `renderRow` gives it `className =
  // 'reasoning'` — so `#transcript .row.hit` could never match one, and a search
  // hit on a reasoning row drew no outline at all. Nothing caught it because the
  // search fixture holds only user and assistant rows.
  //
  // The rule is read here as "some selector reaches a reasoning row", not by
  // restating the selector, so a rename of the container does not silently
  // disable the highlight.
  const outlineRule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => /outline\s*:\s*2px solid var\(--accent\)/.test(match[2]))
    .flatMap((match) => match[1].split(',').map((part) => part.trim()))
  assert.ok(
    outlineRule.some((selector) => /\.reasoning\.hit/.test(selector)),
    'a reasoning row is `.reasoning`, so `.row.hit` alone leaves it unhighlighted',
  )

  // The claim rests on the class the renderer actually sets, so it is read from
  // the source rather than assumed here.
  const script = readExtensionFile('sidepanel.js')
  assert.ok(
    /wrapper\.className = 'reasoning'/.test(script),
    'if the reasoning row ever becomes a `.row`, this rule needs revisiting rather than keeping a second one',
  )
})

test('the needle is painted on the accent, in white, in both schemes', (t) => {
  // The search marks the matched characters, not only the row that holds them.
  // The rows are drawn from `drawNeedle` registering ranges, and the colour comes
  // from this rule; a missing rule means the ranges paint nothing, which no DOM
  // assertion in the stream suite can see.
  const body = ruleBody('::highlight(dsh-needle)')
  assert.notEqual(body, null, 'the needle has to have a rule to paint it')
  assert.match(
    body,
    /background-color:\s*var\(--accent\)/,
    'the fill is the accent, which is what the search marks a match with',
  )

  // White on the accent is 4.96:1 — measured — and passes the 4.5:1 body text
  // needs. `Canvas` reads like the more careful choice because it follows the
  // scheme, and it is the wrong one: the fill is the accent in *both* schemes, so
  // the colour sitting on it is a fact about the accent, and as `Canvas` on the
  // accent the pair is 2.74:1 in the dark scheme. Asserted as the literal rather
  // than as "not Canvas" so that picking a different near-white still has to say
  // which one, and cannot drift silently.
  assert.match(body, /color:\s*#ffffff/, 'white is the colour the accent was calibrated for')

  // And no High Contrast branch is needed, which is worth stating because the
  // obvious fix for "the system took my colours away" is to add one: the mode
  // repaints `::highlight()` itself and ignores these declarations — measured,
  // changing them left the forced-colors screenshot byte-identical.
  //
  // The block's body is read by brace matching rather than by slicing to the end
  // of the file: the first version of this assertion did the latter, and the
  // `::highlight` rule that lives *after* the block made it fail. A slice to EOF
  // is not a block.
  const forcedStart = css.indexOf('@media (forced-colors: active)')
  assert.notEqual(forcedStart, -1, 'the High Contrast block has to exist')
  const forcedOpen = css.indexOf('{', forcedStart)
  let depth = 0
  let forcedEnd = forcedOpen
  for (let index = forcedOpen; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1
    else if (css[index] === '}') {
      depth -= 1
      if (depth === 0) {
        forcedEnd = index
        break
      }
    }
  }
  assert.ok(
    !/::highlight/.test(css.slice(forcedStart, forcedEnd)),
    'High Contrast paints the highlight itself, so a branch here would be dead code that looks live',
  )
})

test('every surface that floats over the page keeps an edge in High Contrast', (t) => {
  // The mode's own block, brace-matched rather than pattern-matched: it holds
  // nested rules, and a lazy `[\s\S]*?` stops at the first `}` it meets.
  const forcedStart = css.indexOf('@media (forced-colors: active)')
  assert.ok(
    forcedStart >= 0,
    'the stylesheet needs a `@media (forced-colors: active)` block; this test reads it to know what the mode keeps',
  )
  const open = css.indexOf('{', forcedStart)
  let depth = 1
  let cursor = open + 1
  while (cursor < css.length && depth > 0) {
    if (css[cursor] === '{') depth += 1
    else if (css[cursor] === '}') depth -= 1
    cursor += 1
  }
  const forced = css.slice(open + 1, cursor - 1)
  /** Selectors the mode's block gives a border to. */
  const bordered = new Set()
  for (const match of forced.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/(?:^|;)\s*border\s*:/.test(match[2])) continue
    for (const part of match[1].split(',')) bordered.add(part.trim())
  }

  // A drawn box that separates itself with the elevation shadow. These are the
  // surfaces this mode can strip an edge from, so they are what has to be
  // checked.
  //
  // This scan does not care whether a rule sits inside a media query: it selects
  // rules by their declarations, and the mode's own rules carry none of this
  // shadow. `bordered` below is where the mode's borders are read, so the two
  // halves cannot be confused for one another.
  const shadowed = []
  for (const match of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const body = match[2]
    if (!/(?:^|;)\s*box-shadow\s*:\s*[^;]*var\(--elevation\)/.test(body)) continue
    for (const part of match[1].split(',')) {
      const selector = part.trim()
      if (selector.startsWith('@')) continue
      if (!shadowed.includes(selector)) shadowed.push(selector)
    }
  }
  assert.ok(
    shadowed.length > 0,
    'expected at least one surface to separate itself with `--elevation`; if this is 0 the check below proves nothing',
  )

  for (const selector of shadowed) {
    // A surface with its own border is already safe in this mode.
    const ownBorder = declarationOf(selector, 'border')
    if (ownBorder !== null && !/^\s*none\b/.test(ownBorder)) continue
    assert.ok(
      bordered.has(selector) || borderedUnder(bordered, selector),
      `${selector} separates itself with a shadow and no border, so under \`forced-colors: active\` it loses every edge it has and reads as part of what is behind it`,
    )
  }
})

test('a separator drawn with a background keeps a line in High Contrast', (t) => {
  // The scan above finds surfaces that separate themselves with `--elevation`.
  // It cannot find a separator drawn as a **background** — a pseudo-element one
  // pixel tall, which is how the compaction rule is drawn — and that category
  // fails in this mode for the same reason: `forced-colors` repaints every
  // background as `Canvas`, so the line comes out the colour of the page behind
  // it. Measured under the emulated feature, both halves of the compaction rule
  // composited to `rgb(0, 0, 0)` over a `rgb(0, 0, 0)` backdrop: 8% of black over
  // black, which is black. The label survived and the boundary it exists to draw
  // did not.
  //
  // Found here rather than by the eye, because the row still *said* 「上下文已压缩」
  // — it was the line that had gone.
  const forcedStart = css.indexOf('@media (forced-colors: active)')
  assert.ok(forcedStart >= 0, 'the stylesheet needs a `@media (forced-colors: active)` block')
  const open = css.indexOf('{', forcedStart)
  let depth = 1
  let cursor = open + 1
  while (cursor < css.length && depth > 0) {
    if (css[cursor] === '{') depth += 1
    else if (css[cursor] === '}') depth -= 1
    cursor += 1
  }
  const forced = css.slice(open + 1, cursor - 1)

  // Separators: a rule whose only job is to paint a one-pixel line, which it can
  // only do with `background` or a border. Height-pinned and content-empty, so
  // this does not sweep up cards and badges that happen to have a background.
  const separators = []
  for (const match of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const body = match[2]
    if (!/content:\s*''/.test(body)) continue
    if (!/(?:^|;)\s*height:\s*1px/.test(body)) continue
    if (!/(?:^|;)\s*background:/.test(body)) continue
    for (const part of match[1].split(',')) {
      const selector = part.trim()
      if (selector.length > 0 && !separators.includes(selector)) separators.push(selector)
    }
  }
  assert.ok(
    separators.length > 0,
    'expected at least one separator drawn as a one-pixel background; if this is 0 the check below proves nothing',
  )

  for (const selector of separators) {
    // `ruleBody` cannot read a pseudo-element rule out of the mode's block, so
    // the block is searched directly for a border on the same selector.
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const inMode = new RegExp(`${escaped}\\s*(?:,[^{}]*)?\\{[^{}]*border`).test(forced)
    assert.ok(
      inMode,
      `${selector} draws its line with a background, which \`forced-colors: active\` repaints as \`Canvas\` — the line becomes the colour of the page behind it and the boundary disappears while the label stays`,
    )
  }
})

/**
 * One attribute's value on a tag in the markup.
 *
 * Reads the source rather than the live DOM because the panel's test document
 * never parses this file: `getElementById` mints a bare stub per id, so anything
 * only the markup declares is invisible to a DOM test. The two suites divide
 * along that line — behavior is proved against the running panel, and what the
 * markup promises is read here.
 *
 * @param {string} id - The element's id.
 * @param {string} attribute - The attribute name.
 * @returns {string|null} The value, or null when absent.
 */
function attributeOf(id, attribute) {
  const at = html.indexOf(`id="${id}"`)
  if (at === -1) return null
  // Back up to the tag's own `<` so the scan cannot pick up a preceding element.
  const open = html.lastIndexOf('<', at)
  const close = html.indexOf('>', at)
  if (open === -1 || close === -1) return null
  const tag = html.slice(open, close)
  const match = tag.match(new RegExp(`\\s${attribute}="([^"]*)"`))
  return match === null ? null : match[1]
}

test('a trigger that promises a menu opens something that is one', () => {
  // `aria-haspopup="menu"` is a claim about what appears when the control is
  // pressed, and the container has to answer it. Measured in a real browser
  // before this, the trigger said `menu` and the container it opened had no role
  // at all — so the rows inside were never announced as the choices they are.
  //
  // The container's role is set by the renderer rather than written here,
  // because it depends on whether there is anything to choose; the promise on
  // the trigger is static, so the two are checked where each one lives.
  const promised = attributeOf('model', 'aria-haspopup')
  assert.equal(promised, 'menu', '#model must declare what kind of thing it opens')

  const renderer = readExtensionFile('sidepanel.js')
  assert.match(
    renderer,
    /modelMenu\.setAttribute\('role',\s*'menu'\)/,
    'the picker must take the role the trigger promised it',
  )
  assert.match(
    renderer,
    /modelMenu\.setAttribute\('aria-labelledby',\s*'model'\)/,
    'and a menu must be named, by the button that opens it',
  )
})

test('both scrolling regions can be reached and scrolled from the keyboard', () => {
  // Measured in a real browser before this, with real keystrokes rather than
  // synthetic events: tabbing out of the composer went `#model` → `body` →
  // `#title` → `#find-open` → `#new` → the *copy button of the oldest row in the
  // window*, and that last step took `scrollTop` from 4521 to 0. The reader was
  // thrown from the newest message to the oldest one to land on a button they had
  // not asked for, and rows holding no control at all could not be reached.
  //
  // `PageDown` with focus on a header button scrolled nothing, which is the other
  // half of the same defect: a scrollable region a keyboard cannot focus is a
  // region a keyboard cannot scroll.
  //
  // `tabindex="0"` and not `-1`: the point is to be reachable by Tab. It does not
  // reorder anything, because the element keeps its place in the document.
  for (const id of ['transcript', 'history']) {
    assert.equal(
      attributeOf(id, 'tabindex'),
      '0',
      `#${id} scrolls, so a keyboard has to be able to reach and scroll it`,
    )
  }

  // A focusable region with no name is announced as an unlabelled group: the
  // reader is told they are somewhere without being told where. The names are
  // applied with the rest of the panel's copy, so they are checked where they live.
  const renderer = readExtensionFile('sidepanel.js')
  assert.match(
    renderer,
    /transcript\.setAttribute\('aria-label',\s*t\('stage\.transcript'\)\)/,
    'the conversation must say what it is when focus lands on it',
  )
  assert.match(
    renderer,
    /history\.setAttribute\('aria-label',\s*t\('stage\.history'\)\)/,
    'and so must the session list',
  )
})

test('a focused scroller draws its ring in the one colour High Contrast keeps', () => {
  // The ring is drawn inside the box rather than outside it: this element's edges
  // *are* the panel's edges, so an outline with a positive offset would be clipped
  // and a focused scroller would look exactly like an unfocused one.
  //
  // `Highlight` and not `--accent`, for the reason the overlays already learned:
  // High Contrast discards `--accent` and repaints system colours, so a ring
  // declared in the accent disappears in precisely the mode where a visible focus
  // indicator matters most.
  const body = ruleBody('.scroll:focus-visible')
  assert.ok(body !== null, 'a focusable scroller needs a focus indicator')
  assert.match(body, /outline:\s*2px solid Highlight/, 'and it must survive High Contrast')
  assert.match(body, /outline-offset:\s*-2px/, 'and be drawn inside the box it rings')
})

test('the conversation is a list and the landmark is not spent to make it one', () => {
  // Roles are read from the markup because that is where the pair is decided, and
  // the pair is the whole point: an explicit `role` overrides an element's
  // implicit one, so `role="list"` on `<main id="transcript">` was measured to
  // remove `main` from the computed roles. A reader would have gained somewhere to
  // move between messages and lost "skip to the content", which is not a trade.
  assert.equal(
    attributeOf('transcript', 'role'),
    'list',
    'the conversation must expose itself as a list, or it stays one flat run of text',
  )
  assert.equal(
    attributeOf('stage', 'role'),
    'main',
    'the landmark has to be declared explicitly once the list role is in play',
  )
  // `#history` deliberately is NOT a list: a `list` may own only `listitem`s, and
  // this view also holds the workspace headings and the settings footer. It is a
  // named `<section>`, which the platform gives a `region` role on its own.
  assert.equal(
    attributeOf('history', 'role'),
    null,
    'the session view holds headings and a footer, so it cannot be a list itself',
  )
})

test('the list item and the control inside it are two elements', () => {
  // Measured in a real browser: `role="listitem"` written on the session button
  // removed `button` from the computed roles — the sessions stopped being
  // announced as activatable. Every item must therefore be a wrapper, and the
  // button inside must carry no role of its own.
  const body = ruleBody('.session-item')
  assert.ok(body !== null, 'the wrapper the list owns needs a box of its own')
  assert.match(body, /display:\s*block/, 'and it must take the width the button used to take')
})

test('long-form text has a reading measure, and it survives a wider panel', () => {
  // Measured in a real browser with a deliberately long paragraph, against a
  // control that has always been capped: the reader's own bubble. At a 1400px
  // panel the answer ran to 1347px — 96 Han characters on one line — and at
  // 1800px to 1652px / 118, while the bubble held at 420px throughout. The
  // answer's width came from its content, so the panel's width *was* the line's
  // width; past roughly 40 Han characters the eye loses the start of the next
  // line, which is the entire reason a reading measure exists.
  //
  // `--measure` is in px and not `ch`, and this assertion is what keeps it
  // that way: a `ch` inside a custom property resolves against the font of
  // whichever element uses it, so one `52ch` token measured 427px on an answer
  // (14px prose) and 343px on a tool's error output (12px monospace) — two
  // widths from one number, the narrow one cutting the error output below the
  // width it already had at the sidebar's usual size.
  const measure = css.match(/--measure\s*:\s*([^;]+);/)
  assert.ok(measure !== null, 'the reading measure must exist as a token, or two surfaces drift apart')
  const value = measure[1].trim()
  assert.match(
    value,
    /^\d+px$/,
    `it must be an absolute length: a \`ch\` resolves against each user's own font and gives them different widths, found ${JSON.stringify(value)}`,
  )

  // Both surfaces that hold long-form text, named because each was measured to
  // overflow: an answer, and a tool's own quoted error output (208 monospace
  // characters on one line at 1400px).
  for (const selector of ['.answer', '.tool-failure']) {
    assert.equal(
      declarationOf(selector, 'max-width'),
      'var(--measure)',
      `${selector} must be capped by the shared measure, not by a number of its own`,
    )
  }

  const pixels = Number.parseInt(value, 10)

  // The cap must not bind at the width the panel is actually used at. The
  // transcript is 360px in a 380px sidebar, so a measure below that would start
  // reflowing text the reader was already reading comfortably.
  assert.ok(
    pixels > 360,
    `a ${pixels}px measure is narrower than the 360px transcript at the sidebar's usual width, so it would reflow text that was never too wide`,
  )

  // And it has to stay wide enough for the other thing this column holds, which
  // is the assertion that matters most here: an earlier 427px attempt satisfied
  // every prose measurement above and still regressed code. The code face
  // measures 6.00px per character and `pre` ends up 2px narrower than this box
  // once its own border is counted, so 80 columns needs 485px — measured in a
  // real browser by stepping the cap until `pre.clientWidth` reached 480px, not
  // derived by adding padding, because the border is written somewhere else.
  //
  // 80 is not a convention borrowed for the occasion: across this repository's
  // own 40,409 source lines the 90th percentile is 81 columns.
  assert.ok(
    pixels >= 485,
    `an ${pixels}px measure leaves less than the 80 columns code is written to (measured floor: 485px)`,
  )
})

test('the reader’s own font size reaches the text, and the boxes grow with it', () => {
  // Chrome's font-size setting works by changing the root font size. A step
  // written in `px` ignores it completely: measured, a root of 16px and a root of
  // 32px both painted 14px body text, so the setting was a control that did
  // nothing in this panel — and text that cannot be enlarged is text some readers
  // cannot read.
  // Read straight from the declaration rather than through `ruleBody`: the file
  // has two `:root` blocks (colours in the second, sizes in the first) and the
  // helper returns only the first rule it finds for a selector, which is the
  // token block today and would silently become the wrong one if they were
  // reordered.
  const sizes = { '--text-xs': 12, '--text-sm': 13, '--text-base': 14 }
  for (const [name, pixels] of Object.entries(sizes)) {
    const match = css.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))
    assert.ok(match !== null, `${name} must be declared`)
    const value = match[1].trim()
    assert.ok(
      /^[\d.]+rem$/.test(value),
      `${name} is ${value}; it must be a rem value so the reader's font-size setting reaches it`,
    )
    // A `rem` written against the wrong denominator silently changes every
    // screen in the panel. The default root is 16px, so the conversion has to be
    // exact or the panels that were measured are not the panels that ship.
    const rem = Number.parseFloat(value)
    assert.equal(
      rem * 16,
      pixels,
      `${name} is ${value}, which is ${rem * 16}px at the default root rather than ${pixels}px`,
    )
  }

  // Enlarged text inside boxes that stay put is text that collides. The two
  // shapes that did, measured at a 32px root (200%, WCAG 1.4.4): the header's
  // fixed 44px put the caret on the last three characters of the title, and the
  // copy button's fixed 24px painted 「复制」 over the language label beside it.
  // Both are floors now, so they grow with what they contain.
  const floors = {
    header: { property: 'min-height', value: '44px' },
    '.icon': { property: 'min-height', value: '1.75rem' },
    '.copy': { property: 'min-height', value: '1.5rem' },
    '#send': { property: 'min-height', value: '1.75rem' },
  }
  for (const [selector, { property, value }] of Object.entries(floors)) {
    const height = declarationOf(selector, 'height')
    assert.equal(
      height,
      null,
      `${selector} still has a fixed height (${height}); the text inside it grows and the box would not`,
    )
    assert.equal(
      declarationOf(selector, property),
      value,
      `${selector} must carry ${property}: ${value}`,
    )
  }

  // A floor written in `rem` grows with the reader's setting; one written in `px`
  // does not, and would reintroduce the collision it was added to fix.
  for (const selector of ['.icon', '.copy', '#send']) {
    const value = declarationOf(selector, 'min-height')
    assert.ok(
      /rem$/.test(value),
      `${selector}'s floor is ${value}; it must be a rem value for the same reason the text is`,
    )
  }

  // The glyph inside each of these is a character, so it has to be sized in a
  // unit that follows the reader. A literal px here pins the arrow at 14px while
  // the circle around it grows, which is the same mismatch one level down.
  const glyphSizes = { '.icon': '0.9375rem', '#send': '0.875rem' }
  for (const [selector, expected] of Object.entries(glyphSizes)) {
    assert.equal(
      declarationOf(selector, 'font-size'),
      expected,
      `${selector}'s glyph must be sized in rem so it grows with its box`,
    )
  }

  // Every other control that holds a line of text needs the same treatment, and
  // the failure mode is specific: a frozen `line-height` in `px` while the font
  // grows makes the lines paint on top of each other. Measured at a 32px root,
  // the editor's font reached 28px inside a 20px line — three typed lines
  // overlapped and the reader could not read back what they were writing.
  const textBoxes = ['#input', '#model', '#find-input', '.approval-actions button', '.menu-effort', '#blocked-action']
  for (const selector of textBoxes) {
    const lineHeight = declarationOf(selector, 'line-height')
    assert.ok(
      lineHeight === null || !/px$/.test(lineHeight),
      `${selector} freezes its line height at ${lineHeight}; the font inside grows and the lines would land on each other`,
    )
    const height = declarationOf(selector, 'height')
    assert.equal(
      height,
      null,
      `${selector} still has a fixed height (${height}); its text follows the reader and the box would not`,
    )
  }

  // "Not a pixel value" is not enough on its own: a ratio written against the
  // wrong denominator is still not a pixel value, and it still resizes the
  // control. `calc(20em / 14)` on the editor is the 20px the design had;
  // `calc(20em / 13)` is 21.5px, which no reading of the stylesheet reveals.
  //
  // And it must be a length, not a bare `20 / 14` ratio: a unitless ratio is
  // inherited as a ratio, so each child re-resolves it against its own font size.
  // Measured, that moved the model trigger's caret — set in 12px — from a 20px
  // line box to 18.46px, which is the whole of the 61 pixels that changed in
  // `docs/screenshots/model-menu.png` and looks exactly like antialiasing.
  assert.equal(
    declarationOf('#input', 'line-height'),
    'calc(20em / 14)',
    '#input is set in 14px, so its 20px line is 20em/14 — and a length, so children keep 20px',
  )
  assert.equal(
    declarationOf('#model', 'line-height'),
    'calc(20em / 13)',
    '#model is set in 13px, so its 20px line is 20em/13; a bare ratio would shrink its caret',
  )

  // A floor written against the wrong denominator silently resizes the control.
  // `em` and a unitless ratio both resolve against the element they are written
  // on, so `#model` — set in 13px, not the editor's 14px — needed `calc(28em / 13)`
  // to stay 28px. Measured: `2em` there gave 26px and `20 / 14` gave 18.57px, and
  // neither is visible in the stylesheet.
  const distinctFloors = { '#input': ['2em', '10em'], '#model': ['calc(28em / 13)'] }
  for (const [selector, expected] of Object.entries(distinctFloors)) {
    const values = expected.map((_, index) => {
      const property = index === 0 ? 'min-height' : 'max-height'
      return declarationOf(selector, property)
    })
    assert.deepEqual(
      values,
      expected,
      `${selector} must carry floors that resolve to the sizes it was measured at`,
    )
  }
  assert.equal(
    declarationOf('#find-input', 'min-height'),
    '2em',
    '#find-input is set in 13px, so 2em is the 26px it was',
  )
  for (const selector of ['.approval-actions button', '.menu-effort']) {
    const value = declarationOf(selector, 'min-height')
    assert.ok(
      /^calc\(\d+em \/ 12\)$/.test(value ?? ''),
      `${selector}'s floor is ${value}; it is set in 12px, so the denominator must be 12`,
    )
  }

  // The retry button is the same shape as the rest of this group and was missed
  // when the others were done. Measured at a 32px root: a frozen 32px held a 26px
  // font on a 39px line, so `scrollHeight - clientHeight` was 7px and the label
  // painted past its own edge — 33px of text in a 32px box.
  assert.equal(
    declarationOf('#blocked-action', 'min-height'),
    'calc(32em / 13)',
    '#blocked-action is set in 13px, so its 32px floor is 32em/13',
  )

  // The two pills. They are the pair that made this a rule rather than a fix:
  // both are positioned with `left: 50%`, which leaves *half the panel* as their
  // available width, so at a 32px root the 26px pill wrapped its label onto two
  // lines (measured: 2 line boxes, 66.5px of text in a 26px box) and clipped it.
  //
  // The unit is the load-bearing part. These tokens are read in two places — the
  // pill, set in 12px, and the reservation on `#transcript`, set in 13px — and
  // `em` resolves against whichever element reads it, so one number would become
  // 26px and 28.2px. At the default root that is a 2px drift and invisible; it is
  // only the enlarged sizes that show it. `rem` resolves against the root.
  for (const [token, value] of [['--pill-height', '1.625rem'], ['--to-bottom-size', '1.75rem']]) {
    const declared = css.match(new RegExp(`${token}\\s*:\\s*([^;]+);`))
    assert.ok(declared !== null, `${token} must exist`)
    assert.equal(
      declared[1].trim(),
      value,
      `${token} is ${declared[1].trim()}; it must be a root-relative length so the pill and the reservation resolve it alike`,
    )
  }

  // A pill that pins its own height cannot grow, and its label is clipped rather
  // than moved — the failure is silent in every screenshot taken at the default
  // font size.
  for (const selector of ['#earlier', '#to-bottom']) {
    assert.equal(
      declarationOf(selector, 'height'),
      null,
      `${selector} pins its own height (${declarationOf(selector, 'height')}); the label inside must be able to grow`,
    )
    assert.ok(
      (declarationOf(selector, 'min-height') ?? '').includes('var(--'),
      `${selector} must take its resting height from the shared token`,
    )
  }

  // `left: 50%` is what starved the pill of width in the first place. Stretching
  // the box edge to edge and centring with `margin: 0 auto` gives it the whole
  // panel, and the pill still sits exactly in the middle — verified by measurement
  // (`offCentreBy: 0` at 16/24/32px roots, equal gaps either side).
  for (const selector of ['#earlier', '#to-bottom']) {
    assert.equal(
      declarationOf(selector, 'left'),
      '0',
      `${selector} must stretch edge to edge; 'left: 50%' leaves it half the panel to grow into`,
    )
    assert.equal(
      declarationOf(selector, 'right'),
      '0',
      `${selector} must stretch edge to edge so its available width is the panel, not half of it`,
    )
    assert.ok(
      (declarationOf(selector, 'margin') ?? '').includes('auto'),
      `${selector} centres with an automatic margin now that it stretches`,
    )
  }
})

test('the composer states its ceiling once, in the stylesheet', () => {
  // The editor has to be measured and given a height, because a textarea does not
  // grow on its own — `height: auto` leaves it at its `rows` attribute, one line.
  // What it must not be *given* is a ceiling.
  //
  // It was. The panel wrote `Math.min(140, scrollHeight)` in five places while the
  // stylesheet said `max-height: 10em` — the same 140px at the default text size,
  // and 280px once the reader doubles it. An inline height beats a stylesheet's
  // `max-height`, so the 140 was final: measured at a 32px root, the reader saw
  // 3.5 lines where the default size shows 7. Enlarging the text because it was
  // hard to read left less of it visible.
  //
  // The assertion is on the *absence* of a number in the script, because that is
  // what the defect was. Any ceiling written there has to be kept in step with the
  // stylesheet by hand, and it was not.
  const script = readExtensionFile('sidepanel.js')
  const ceilings = [...script.matchAll(/Math\.min\(\s*(\d+)\s*,\s*input\.scrollHeight\s*\)/g)]
  assert.deepEqual(
    ceilings.map((match) => match[1]),
    [],
    'the composer caps its own height in the script; the stylesheet already states the ceiling and it follows the reader\'s font size',
  )
  // And it grows by measurement rather than by a fixed step: the point of reading
  // `scrollHeight` is that it is the content's own height.
  assert.ok(
    /input\.style\.height = `\$\{input\.scrollHeight\}px`/.test(script),
    'the composer grows by handing its content height to the element; other expressions there are a second ceiling by another name',
  )
  // The one place the height is still assigned from a literal is the reset after a
  // send, where the field is empty and `auto` is the honest answer.
  assert.ok(
    /input\.value = ''\s*\n\s*input\.style\.height = 'auto'/.test(script),
    'the composer must return to its own resting height after a send',
  )

  // The stylesheet keeps the ceiling, and keeps it relative — `10em` resolves
  // against the element's own font size, which is what makes it follow the reader.
  const ceiling = declarationOf('#input', 'max-height')
  assert.ok(
    (ceiling ?? '').endsWith('em'),
    `#input's ceiling is ${ceiling}; it must be relative so it grows with the text`,
  )
})

test('a wide table asks for the width it needs instead of crushing its columns', () => {
  // `overflow-x: auto` on the wrapper was correct and never once ran. A table
  // defaults to `table-layout: auto`, which settles the conflict by shrinking
  // columns rather than by asking for room — so the table rendered at exactly the
  // container's width and the scroller had nothing to scroll.
  //
  // Measured on a four-column fixture: the table was 332px, its columns were 62,
  // 53, 53, 72 and 92px, and every cell wrapped mid-phrase — 「崩溃可接受」 broke
  // across two lines as 「崩溃可接」/「受」. Told to size itself the same table
  // asked for 574px and the scroller scrolled. This is worth a test because the
  // symptom is silent: nothing overflows, nothing is clipped, and the screenshot
  // looks like a table that is merely a bit cramped.
  //
  // Not an edge case: across the 437 tables in this machine's real sessions, the
  // median needs 269px of sideways travel.
  const rule = /\.answer table\s*\{([^}]*)\}/.exec(css)
  assert.ok(rule !== null, 'the `.answer table` rule is gone; a wide table has nothing telling it to size itself')

  assert.ok(
    /width:\s*max-content/.test(rule[1]),
    'the table must ask for its content width; without it the columns are crushed to fit and the scroller never engages',
  )
  // `min-width: 100%` keeps a narrow table filling the column, so the borders do
  // not stop short of the prose above it.
  assert.ok(
    /min-width:\s*100%/.test(rule[1]),
    'a narrow table must still fill the reading column',
  )

  // And the per-cell cap: 45% of real tables have a single column wider than the
  // panel, so one runaway cell would otherwise stretch the table into a ribbon.
  const cell = /\.answer th,\s*\.answer td\s*\{([^}]*)\}/.exec(css)
  assert.ok(cell !== null, 'the cell rule is gone')
  assert.ok(
    /max-width:\s*\d+ch/.test(cell[1]),
    'each cell needs a reading measure in `ch`; a single long value must not become a ribbon',
  )

  // The scroller itself keeps the horizontal affordance, and says so visibly —
  // a table that continues off-screen with no sign of it reads as a table that
  // ends mid-column.
  // The scroller is declared in two rules — the scroll behaviour in one, the fade
  // in another — so every match has to be considered. Matching only the first and
  // asserting the fade is there fails on a file where the fade is present, which
  // is a test bug that reads like a product bug.
  const scrollers = [...css.matchAll(/\.answer \.table-scroll\s*\{([^}]*)\}/g)].map((match) => match[1])
  assert.ok(scrollers.length > 0, 'the table scroller rule is gone')
  const scrollerCss = scrollers.join(' ')
  assert.ok(/overflow-x:\s*auto/.test(scrollerCss), 'the scroller must still scroll')

  // The edge shades must live on a positioned parent, not inside the scroll
  // container. Two failed attempts stand behind this. A `background` gradient on
  // the scroller is painted below the cells, so a table that fills its own padding
  // covers it completely — read off the pixels, the right edge was `#121212` end to
  // end with no gradient anywhere in it. Sticky pseudo-elements *inside* the
  // scroller then flattened it: both are in flow, and the margins needed to
  // collapse them onto each other pulled the wrapper's height to zero, so the table
  // kept its 125px while `.table-scroll` reported 0 and the answer above collapsed
  // to 92px. A hint that hides the content it annotates is worse than no hint.
  // The two shades share one rule for their common geometry and split for their
  // gradients, so the declaration of `position` and `pointer-events` may appear
  // once for the pair. What must hold is that both selectors are covered by rules
  // that carry them — counting only the split rules would fail on a file where the
  // shades are correct.
  const shadeSelectors = [...css.matchAll(/\.answer \.table-box::(before|after)\b/g)].map((match) => match[1])
  assert.ok(
    shadeSelectors.includes('before') && shadeSelectors.includes('after'),
    'both edges need a shade: with only one, the reader is told the table continues in one direction and not the other',
  )
  assert.ok(
    /\.answer \.table-box::before,\s*\n?\s*\.answer \.table-box::after\s*\{[^}]*position:\s*absolute/.test(css),
    'a shade must be positioned against its parent rather than placed in flow inside the scroller',
  )
  assert.ok(
    /\.answer \.table-box::before,\s*\n?\s*\.answer \.table-box::after\s*\{[^}]*pointer-events:\s*none/.test(css),
    'a shade that takes pointer events swallows the drag-selection of the cells underneath it',
  )
  assert.ok(
    /\.answer \.table-box\s*\{[^}]*position:\s*relative/.test(css),
    'the shades are absolutely positioned, so their parent must establish the containing block',
  )

  // The shades key off where the reader has scrolled to, which CSS cannot read.
  // Both directions matter: without the first, the leading shade would claim there
  // is more table to the left of the first column; without the second, the trailing
  // shade would stay lit after the reader reached the end — a hint that lies.
  assert.ok(
    /\.table-scroll\[data-scrolled='yes'\]/.test(css),
    'the leading shade must appear only once the reader has moved off the start',
  )
  assert.ok(
    /\.table-scroll\[data-at-end='yes'\]/.test(css),
    'the trailing shade must go once there is nothing left to the right',
  )

  // High Contrast repaints every background to `Canvas`, which erases the fade and
  // leaves the edge drawn as a flat block. That mode draws a border instead — the
  // same correction the panel already makes for the compaction rule and the
  // trigger label, and the third instance of this mechanism.
  //
  // Both edges are required, and named individually. Asserting "some border is
  // 1px solid CanvasText in that block" passes while the other edge is missing,
  // because the surviving one satisfies the pattern — measured: dropping
  // `border-left` alone kept the test green. An assertion that a mutation cannot
  // break is not an assertion.
  const forcedColors = mediaBlock('forced-colors: active')
  const tableInHighContrast = /\.answer \.table-scroll\s*\{([^}]*)\}/.exec(forcedColors)
  assert.ok(
    tableInHighContrast !== null,
    'the fade disappears in High Contrast; the scroller needs a border there so a table that continues still says so',
  )
  for (const side of ['border-left', 'border-right']) {
    assert.ok(
      new RegExp(`${side}:\\s*1px solid CanvasText`).test(tableInHighContrast[1]),
      `High Contrast needs ${side} on the table scroller: the fade is repainted away there, and a table that continues must still say so`,
    )
  }
})

test('reduced motion stops the motion, not the fades, and not by naming elements', (t) => {
  const block = mediaBlock('prefers-reduced-motion: reduce')
  assert.ok(
    block.trim().length > 0,
    'the stylesheet needs a `@media (prefers-reduced-motion: reduce)` block; a reader who asks their system for less motion has nowhere else to be heard',
  )

  // The rule has to reach elements the block cannot know about. Naming elements
  // is what let this rot: `#model .caret` turns through `transition: transform`,
  // and the two rules that used to live here named `.working` and
  // `.live-body::after` instead — so the caret kept spinning for a reader who
  // had asked it not to. Measured in a real browser, it passed through 6
  // intermediate frames with the preference on, the same 6 as with it off.
  const universal = declarationsOf(block, 'transition-property')
    .filter((entry) => entry.selectors.some((selector) => selector.includes('*')))
  assert.ok(
    universal.length > 0,
    'reduced motion must stop transitions by *property* over a universal selector; a rule that names its elements leaves the next transition in this file uncovered, which is how the caret was missed',
  )

  // `none` would stop the fades too. An opacity fade is what a movement is
  // usually replaced with — it is not itself motion — and removing it makes
  // surfaces appear in a flash instead of settling, which is worse for the very
  // reader who asked for less.
  //
  // The value is compared on its own, without the property name in front of it.
  // The first version of this check ran `/transition-property\s*:\s*none/`
  // against the *values* it had just collected, which never contain the property
  // name — so it could not fail, and a mutation that replaced `opacity` with
  // `none` went undetected while every assertion stayed green.
  for (const entry of universal) {
    assert.ok(
      !/^(?:none|initial|inherit)$/i.test(entry.value.replace(/\s*!important\s*$/i, '')),
      `reduced motion sets \`transition-property: ${entry.value}\`, which stops the fades as well as the motion`,
    )
  }

  // The panes' blink is an `animation`, so it stops like every other one. The
  // caret that types has to be stopped by the same rule rather than by a rule
  // that remembers its selector.
  const animations = declarationsOf(block, 'animation')
  assert.ok(
    animations.length > 0,
    'reduced motion must also stop `animation`, which is what the looping ones are',
  )
  assert.ok(
    animations.some((entry) => entry.selectors.some((selector) => selector.includes('*'))),
    'the animation stop must be property-wide too, for the same reason as the transition stop',
  )
})