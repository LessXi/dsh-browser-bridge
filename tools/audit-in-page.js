/**
 * Measure the panel's rendered geometry and colour, inside the page.
 *
 * This runs in the panel's own context and returns numbers, not opinions. Every
 * check here is something a person would eventually notice but that no amount of
 * reading the source reveals: the actual painted contrast, the actual pixel size
 * of a tap target, the actual element that overflows its box. The panel is
 * mostly text at 12–14px, where "it looks a bit light" and "it fails WCAG" are
 * the same fact measured two ways.
 *
 * Colours are rasterised through a canvas rather than parsed from the computed
 * string. This panel builds its palette with `color-mix(in oklab, …)`, which
 * computes to `oklab(0.99 0.00004 0.00002 / 0.45)` — a colour no hand-written
 * `rgba()` regex reads. An earlier version of this file regex-parsed them, and
 * every `--faint`/`--muted`/`--tertiary` element silently failed to parse and
 * was skipped, so "contrast: []" meant "nothing was measured", not "nothing is
 * wrong". The canvas knows how to resolve every CSS colour the engine does, so
 * the measurement cannot drift from what is actually painted. Anything that
 * still fails to resolve is reported by name instead of being dropped.
 *
 * Evaluated with `awaitPromise: true`, so it returns a JSON string.
 */
(async () => {
  // A 1x1 canvas is the colour model: fill it, read the pixel back.
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const SENTINEL = '#010203'

  const unreadable = []

  /**
   * Composite a stack of CSS colours bottom-to-top and return the resulting
   * opaque sRGB pixel. `null` means at least one colour could not be resolved.
   */
  const rasterize = (colors, label) => {
    ctx.clearRect(0, 0, 1, 1)
    for (const color of colors) {
      // An unrecognised value is ignored by the engine, leaving the previous
      // fill in place, so a sentinel is the only way to notice the rejection.
      ctx.fillStyle = SENTINEL
      ctx.fillStyle = color
      if (ctx.fillStyle === SENTINEL && String(color).toLowerCase() !== SENTINEL) {
        unreadable.push({ label, color: String(color).slice(0, 60) })
        return null
      }
      ctx.fillRect(0, 0, 1, 1)
    }
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
    return { r, g, b, a: 1 }
  }

  const luminance = ({ r, g, b }) => {
    const channel = (value) => {
      const v = value / 255
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  }

  const contrast = (fore, back) => {
    const a = luminance(fore)
    const b = luminance(back)
    const [hi, lo] = a > b ? [a, b] : [b, a]
    return (hi + 0.05) / (lo + 0.05)
  }

  const describe = (element) => {
    const id = element.id.length > 0 ? `#${element.id}` : ''
    const cls = typeof element.className === 'string' && element.className.length > 0
      ? `.${element.className.split(/\s+/).filter(Boolean).join('.')}`
      : ''
    const text = (element.textContent ?? '').trim().slice(0, 40)
    return `${element.tagName.toLowerCase()}${id}${cls}${text.length > 0 ? ` "${text}"` : ''}`
  }

  /** Product of every ancestor's opacity, ending at the element itself. */
  const effectiveOpacity = (element) => {
    let node = element
    let acc = 1
    while (node !== null && node !== document.documentElement) {
      const style = getComputedStyle(node)
      if (style.display === 'none' || style.visibility === 'hidden') return 0
      acc *= Number(style.opacity)
      if (acc === 0) return 0
      node = node.parentElement
    }
    return acc
  }

  const rectOf = (element) => {
    const rect = element.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
  }

  // The page's own backdrop, which every translucent layer eventually sits on.
  //
  // Not `getComputedStyle(document.body).backgroundColor`: that is `transparent`
  // on the settings page, and rasterising "transparent" yields transparent black,
  // so every measurement composited onto black. In the dark scheme that was
  // accidentally right; in the light one it reported black text on black —
  // a full page of `ratio: 1` that did not exist. The browser's actual canvas is
  // the `Canvas` system colour, which flips with `prefers-color-scheme`, so it is
  // read from a real element that asks for it.
  const pageBackdrop = (() => {
    const painted = getComputedStyle(document.body).backgroundColor
    if (painted !== 'rgba(0, 0, 0, 0)' && painted !== 'transparent') {
      return rasterize([painted], 'body background') ?? { r: 255, g: 255, b: 255, a: 1 }
    }
    const probe = document.createElement('div')
    probe.style.backgroundColor = 'Canvas'
    probe.style.position = 'absolute'
    probe.style.visibility = 'hidden'
    document.body.append(probe)
    const canvas = rasterize([getComputedStyle(probe).backgroundColor], 'Canvas')
    probe.remove()
    return canvas ?? { r: 255, g: 255, b: 255, a: 1 }
  })()

  /**
   * The colours behind an element, outermost first, so the last opaque one and
   * everything translucent above it can be composited in the right order.
   */
  const backgroundStack = (element) => {
    const stack = []
    let node = element
    while (node !== null) {
      const color = getComputedStyle(node).backgroundColor
      if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') stack.unshift(color)
      node = node.parentElement
    }
    return stack
  }

  const all = [...document.querySelectorAll('body *')]

  // 1. Contrast, for every element that paints its own text. Fully transparent
  //    subtrees are skipped rather than measured: a hidden stage is not a
  //    contrast failure, and reporting one makes the real findings harder to
  //    see. Disabled controls are skipped too, which WCAG 1.4.3 exempts
  //    explicitly (inactive components).
  const contrastFindings = []
  let contrastChecked = 0
  let contrastSkipped = 0
  for (const element of all) {
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent.trim())
      .join('')
      .trim()
    if (ownText.length === 0) continue
    const size = Number.parseFloat(getComputedStyle(element).fontSize)
    if (!(size > 0)) continue
    if (element.disabled === true || element.closest('[hidden]') !== null) {
      contrastSkipped += 1
      continue
    }

    const style = getComputedStyle(element)
    // An ancestor at `opacity: 0` hides the whole subtree — `#blocked` sits at
    // zero and would otherwise contribute six impossible "ratio: 1" findings.
    const opacity = effectiveOpacity(element)
    if (opacity === 0) {
      contrastSkipped += 1
      continue
    }

    // An empty stack means nothing between the element and the root paints a
    // background — the settings page sets `background: transparent` on both
    // `html` and `body`. Rasterising nothing leaves the cleared canvas, which
    // reads back as transparent black, so every one of its elements was measured
    // against black: accidentally correct in the dark scheme, and a whole page of
    // impossible black-on-black (`ratio: 1`) in the light one.
    //
    // The bottom of the stack is the browser's canvas, which `pageBackdrop`
    // already resolved — through an element that is *in* the document, so it
    // inherits `color-scheme`. Rasterising the literal `'Canvas'` here instead
    // would not: this canvas node is detached, so it has no inherited
    // `color-scheme` and resolves the system colour to light every time.
    const stack = backgroundStack(element)
    const back = stack.length === 0 ? pageBackdrop : rasterize(stack, describe(element))
    if (back === null) continue

    const fore = rasterize([`rgba(${back.r},${back.g},${back.b},1)`, style.color], describe(element))
    if (fore === null) continue

    // Ancestor opacity blends the whole subtree toward the page backdrop.
    const seenBack = opacity < 1
      ? {
          r: pageBackdrop.r + (back.r - pageBackdrop.r) * opacity,
          g: pageBackdrop.g + (back.g - pageBackdrop.g) * opacity,
          b: pageBackdrop.b + (back.b - pageBackdrop.b) * opacity,
          a: 1,
        }
      : back
    const seenFore = opacity < 1
      ? {
          r: seenBack.r + (fore.r - seenBack.r) * opacity,
          g: seenBack.g + (fore.g - seenBack.g) * opacity,
          b: seenBack.b + (fore.b - seenBack.b) * opacity,
          a: 1,
        }
      : fore

    contrastChecked += 1
    const ratio = contrast(seenFore, seenBack)
    const weight = Number(style.fontWeight) || 400
    // WCAG 2.2: large text is 18.66px bold or 24px regular.
    const large = size >= 24 || (size >= 18.66 && weight >= 700)
    const required = large ? 3 : 4.5
    if (ratio < required) {
      contrastFindings.push({
        element: describe(element),
        ratio: Math.round(ratio * 100) / 100,
        required,
        fontSize: size,
        weight,
        color: style.color,
        fadedByAncestor: opacity < 1,
      })
    }
  }

  // 2. Tap targets. WCAG 2.2 AA asks for 24x24 CSS px (2.5.8). The check covers
  //    anything the panel makes clickable, not just form controls: the header
  //    title and the model trigger are clickable divs, and a tag filter walked
  //    straight past them. Only the outermost clickable node is measured, so a
  //    button's own label span is not reported as a second failure.
  const targetFindings = []
  let targetsChecked = 0
  const clickable = (element) => {
    if (['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) return true
    if (element.getAttribute('role') === 'button') return true
    return getComputedStyle(element).cursor === 'pointer'
  }
  for (const element of all) {
    if (!clickable(element)) continue
    if (element.parentElement !== null && clickable(element.parentElement)) continue
    // Hidden-until-hover actions are still measured: the pointer reveals them in
    // the same place, so the target is just as small when it counts.
    if (effectiveOpacity(element) === 0 && getComputedStyle(element).display === 'none') continue
    const { width, height } = rectOf(element)
    if (width === 0 || height === 0) continue
    // A checkbox inside its own `<label>` is not a 13px target: the whole label
    // activates it, so that is the box a finger has to hit. Measuring the input
    // alone reported `input#autopush 13x13` on the settings page, where the label
    // is a 298x22 row — a finding that a screenshot cannot reproduce and that
    // would have been "fixed" by padding a control with nothing wrong with it.
    const label = element.closest('label')
    const hit = element.tagName === 'INPUT' && label !== null && label.htmlFor === element.id
      ? rectOf(label)
      : { width, height }
    targetsChecked += 1
    if (hit.width < 24 || hit.height < 24) {
      targetFindings.push({
        element: describe(element),
        width: Math.round(hit.width),
        height: Math.round(hit.height),
        // Reported so the reader knows the measurement was of the label, not the
        // control, and does not go looking for a 13px box in the screenshot.
        measured: hit.width === width && hit.height === height ? 'element' : 'wrapping label',
        // Still in layout but invisible until hover, so it is a real target the
        // moment the pointer arrives.
        hiddenUntilHover: effectiveOpacity(element) === 0,
      })
    }
  }

  // A visually-hidden element is meant to be 1px and clipped. Checking the
  // computed style rather than the class name is what keeps this narrow: a real
  // element that merely carries the class would have to be 1x1 and clipped to
  // qualify, which is already the defect being looked for. Announcing text to a
  // screen reader requires the element to stay in the accessibility tree, so
  // `display:none` is not an option and this pattern is the correct one.
  const isVisuallyHidden = (element) => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return (
      rect.width <= 1 &&
      rect.height <= 1 &&
      style.overflow === 'hidden' &&
      (style.clipPath !== 'none' || style.clip !== 'auto')
    )
  }

  // 3. Anything wider than the viewport, which shows up as a horizontal scroll.
  const overflowFindings = []
  for (const element of all) {
    if (effectiveOpacity(element) === 0) continue
    if (isVisuallyHidden(element)) continue
    const rect = element.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) continue
    if (rect.right > window.innerWidth + 0.5 || rect.left < -0.5) {
      overflowFindings.push({
        element: describe(element),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        viewport: window.innerWidth,
      })
    }
  }

  // 4. Content clipped by a fixed height, which hides text with no scrollbar.
  const clippedFindings = []
  for (const element of all) {
    if (isVisuallyHidden(element)) continue
    const style = getComputedStyle(element)
    if (style.overflow === 'visible' || style.overflowY === 'visible') continue
    if (element.scrollHeight > element.clientHeight + 2 && style.overflowY === 'hidden') {
      clippedFindings.push({
        element: describe(element),
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      })
    }
  }

  // 5. A flex row whose children do not fit side by side.
  //
  // A row told to hold two stacked pieces of content while still being a flex
  // *row* lays them out beside each other instead: the first child is squeezed
  // to a sliver and its text is cut off, and the second is pushed out of the
  // row's own box. Both the `failed` row and the tool row with a reason were
  // written that way once, and no check above sees it — the text is not clipped
  // by an overflow rule, nothing exceeds the viewport, the contrast is fine, and
  // every box is individually the right size. It is only wrong in the picture,
  // which is exactly what an audit is supposed to replace.
  //
  // Written against the measured symptom rather than against overlapping boxes:
  // the row has a single child, so a sibling-intersection test can never fire
  // here. What is measurable is that a horizontal flex container's children
  // together want more width than the container has, and that something inside
  // ends up cut.
  const overlapFindings = []
  for (const parent of all) {
    if (effectiveOpacity(parent) === 0) continue
    const style = getComputedStyle(parent)
    if (style.display !== 'flex') continue
    if ((style.flexDirection ?? 'row') !== 'row') continue
    const children = [...parent.children].filter((child) => {
      if (effectiveOpacity(child) === 0) return false
      const position = getComputedStyle(child).position
      return position !== 'absolute' && position !== 'fixed'
    })
    if (children.length === 0) continue

    const parentRect = parent.getBoundingClientRect()
    if (parentRect.width === 0) continue

    // Does any child escape the container horizontally, or sit outside it
    // vertically while being laid out as a row?
    let escapes = false
    for (const child of children) {
      const rect = child.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      if (rect.right > parentRect.right + 1 || rect.bottom > parentRect.bottom + 1) escapes = true
    }

    // And is any child's own text being cut, which is the visible consequence?
    // Two deliberate kinds of truncation are excluded, because counting them
    // would drown the real finding in noise: a container that is *meant* to
    // scroll (the transcript), and text clipped with `text-overflow: ellipsis`,
    // which announces its own truncation with a visible "…" and is a design
    // decision rather than a layout accident.
    let cut = false
    for (const child of children) {
      for (const inner of [child, ...child.querySelectorAll('*')]) {
        const innerStyle = getComputedStyle(inner)
        if (innerStyle.overflow === 'auto' || innerStyle.overflowY === 'auto') continue
        if (innerStyle.overflow === 'scroll' || innerStyle.overflowY === 'scroll') continue
        if (innerStyle.overflow === 'visible' && innerStyle.overflowX === 'visible') continue
        if (innerStyle.textOverflow === 'ellipsis') continue
        if (inner.scrollWidth > inner.clientWidth + 1 && inner.clientWidth >= 0) cut = true
      }
    }

    if (!escapes && !cut) continue

    overlapFindings.push({
      parent: describe(parent),
      children: children.map((child) => describe(child)),
      parentDirection: style.flexDirection ?? 'row',
      parentWidth: Math.round(parentRect.width),
      parentHeight: Math.round(parentRect.height),
      // The measured symptom, so a reader can tell which of the two conditions
      // fired without re-running the audit.
      childEscapesContainer: escapes,
      childTextIsCut: cut,
      childRects: children.map((child) => {
        const rect = child.getBoundingClientRect()
        return {
          element: describe(child),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          widthFractionOfParent: Number((rect.width / parentRect.width).toFixed(2)),
        }
      }),
    })
  }

  // 7. Occlusion: a floating layer covering conversation content.
  //
  // This is its own check because nothing above can see it. `overlaps` looks
  // *inside* a flex row for children that do not fit side by side; an absolutely
  // positioned element covering a scroller's content shares no parent with it, so
  // no container-based test can express it. The defect this exists for — the
  // "earlier content" pill sitting on top of the first message, measured at
  // 2617px² — survived a clean audit across 15 scenarios and both colour schemes,
  // because the audit had never asked who is drawn over whom.
  //
  // Deliberately narrow, because a tool that cries wolf gets ignored:
  //   - only real floating layers are candidates (`absolute`/`fixed`), so ordinary
  //     in-flow layout can never be reported here;
  //   - only a scroller's own children are targets, so a menu opening over the
  //     *composer* — which is what menus are for — is not a finding;
  //   - rectangle intersection is not enough. `elementFromPoint` is asked who is
  //     actually painted on top at the centre of the shared area, so a layer that
  //     merely overlaps in z-order-below is not a finding either;
  //   - a layer covering most of the viewport is a full-screen state page
  //     (`#blocked`), which is *supposed* to cover everything.
  const occlusionFindings = []
  const viewportArea = window.innerWidth * window.innerHeight
  for (const selector of ['#transcript', '#history']) {
    const scroller = document.querySelector(selector)
    if (scroller === null) continue
    const scrollerStyle = getComputedStyle(scroller)
    if (scrollerStyle.display === 'none' || effectiveOpacity(scroller) === 0) continue
    // Whether the covered line can be scrolled out from under the layer. When the
    // content does not overflow there is no scroll position that reveals it, and
    // the occlusion is permanent — which is a different severity from a pill
    // floating over a long conversation.
    const scrollable = scroller.scrollHeight > scroller.clientHeight + 2

    for (const target of scroller.children) {
      const targetRect = target.getBoundingClientRect()
      if (targetRect.width === 0 || targetRect.height === 0) continue
      if ((target.textContent ?? '').trim().length === 0) continue
      // Nothing off-screen is being hidden from anyone.
      if (targetRect.bottom < 0 || targetRect.top > window.innerHeight) continue

      for (const layer of all) {
        const layerStyle = getComputedStyle(layer)
        if (layerStyle.position !== 'absolute' && layerStyle.position !== 'fixed') continue
        if (layerStyle.visibility === 'hidden' || layerStyle.display === 'none') continue
        if (effectiveOpacity(layer) === 0) continue
        const layerRect = layer.getBoundingClientRect()
        if (layerRect.width * layerRect.height > viewportArea * 0.8) continue

        const sharedWidth = Math.min(layerRect.right, targetRect.right) - Math.max(layerRect.left, targetRect.left)
        const sharedHeight = Math.min(layerRect.bottom, targetRect.bottom) - Math.max(layerRect.top, targetRect.top)
        if (sharedWidth <= 0 || sharedHeight <= 0) continue
        const area = sharedWidth * sharedHeight
        // Sub-pixel touch is a rounding artefact, not a design defect.
        if (area < 4) continue

        // Only an occlusion the reader cannot escape by scrolling is a finding.
        //
        // A floating pill over a scroller covers whatever happens to pass beneath
        // it — that is what floating over a scroller means, and it is how the
        // "back to bottom" control has always worked. The reader scrolls, the
        // covered line moves out from under the pill, and nothing is lost. When
        // the content does *not* overflow there is no such scroll position: the
        // covered text is simply gone, and that is a defect rather than a design.
        //
        // Measured both ways on the same panel: `more` (559px of content in a
        // 559px scroller) reported a permanent 2617px² occlusion, while `earlier`
        // (925px in 559px) reported an escapable 1725px² one. Reporting the second
        // would be the "cries wolf" failure that gets a whole audit ignored.
        if (scrollable) continue

        const hit = document.elementFromPoint(
          Math.max(layerRect.left, targetRect.left) + sharedWidth / 2,
          Math.max(layerRect.top, targetRect.top) + sharedHeight / 2,
        )
        if (hit === null) continue
        if (hit !== layer && !layer.contains(hit)) continue

        occlusionFindings.push({
          layer: describe(layer),
          covered: describe(target),
          coveredText: (target.textContent ?? '').trim().slice(0, 40),
          overlapArea: Math.round(area),
          overlap: `${Math.round(sharedWidth)}x${Math.round(sharedHeight)}`,
          scroller: selector,
          // Both numbers, because the check above is "does this scroller
          // overflow" and a reader should be able to confirm it without
          // re-running anything: equal values mean the content exactly fits,
          // which is the state where the covered line is unreachable.
          scrollerScrollHeight: scroller.scrollHeight,
          scrollerClientHeight: scroller.clientHeight,
          // Where the hit test landed, so a reader can re-run it.
          topmostAtOverlapCentre: describe(hit),
        })
        break
      }
    }
  }

  // 6. Text sizes, so the scale can be read off rather than guessed.
  const sizes = {}
  const tiny = []
  for (const element of all) {
    const ownText = [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim().length > 0)
    if (!ownText) continue
    const size = Number.parseFloat(getComputedStyle(element).fontSize)
    if (!(size > 0)) continue
    sizes[size] = (sizes[size] ?? 0) + 1
    if (size < 12) tiny.push({ element: describe(element), fontSize: size })
  }

  return JSON.stringify({
    contrast: contrastFindings,
    targets: targetFindings,
    overflow: overflowFindings,
    clipped: clippedFindings,
    overlaps: overlapFindings,
    occlusions: occlusionFindings,
    tinyText: tiny,
    sizes,
    // The instrument's own health. A silent parse failure used to disable the
    // entire contrast check while still reporting a clean result.
    coverage: {
      contrastElementsChecked: contrastChecked,
      contrastSkippedHiddenOrDisabled: contrastSkipped,
      targetsChecked,
      unreadableColours: unreadable,
    },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    documentHeight: document.documentElement.scrollHeight,
  }, null, 2)
})()
