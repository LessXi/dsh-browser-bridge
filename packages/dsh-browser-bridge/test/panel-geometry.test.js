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
