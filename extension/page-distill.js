/**
 * DOM snapshot distillation.
 *
 * Split out of the service worker so a test can exercise the *same* function
 * against a real page: a snapshot pipeline that only the extension runs cannot
 * be verified without a browser and a human, and the failure mode there is a
 * quietly useless element list rather than an error.
 *
 * Pure: takes a `DOMSnapshot.captureSnapshot` result, returns rows. No Chrome
 * APIs, no globals.
 *
 * @module extension/page-distill
 */

/** Tags whose elements are actionable without an explicit role. */
const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'SUMMARY', 'LABEL'])

/**
 * Tags that hold a value rather than words.
 *
 * Used when reading a `<label>`: the words next to a field are the label's own
 * text, and a control nested inside it contributes its value instead — which is
 * how「onI agree to the terms」and「ChinaJapanKorea」reached the model as the
 * accessible names of a checkbox and a select.
 */
const CONTROL_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'BUTTON', 'PROGRESS', 'METER'])

/**
 * Whether a tag holds a value rather than a label's words.
 * @param {string} tag - The uppercased tag name.
 * @returns {boolean} True for form controls.
 */
function isControlTag(tag) {
  return CONTROL_TAGS.has(tag)
}

/**
 * The implicit ARIA role for a tag, enough for a model to reason about.
 * @param {string} tag - The uppercased tag name.
 * @param {Record<string, string>} attributes - The element's attributes.
 * @returns {string} The role.
 */
export function implicitRole(tag, attributes) {
  switch (tag) {
    case 'A': return attributes.href === undefined ? 'generic' : 'link'
    case 'BUTTON': return 'button'
    case 'INPUT':
      if (attributes.type === 'checkbox') return 'checkbox'
      if (attributes.type === 'radio') return 'radio'
      if (attributes.type === 'submit' || attributes.type === 'button') return 'button'
      return 'textbox'
    case 'TEXTAREA': return 'textbox'
    case 'SELECT': return 'combobox'
    case 'OPTION': return 'option'
    case 'SUMMARY': return 'button'
    case 'LABEL': return 'label'
    default: return 'generic'
  }
}

/**
 * Read one node's bounds out of a document's layout table.
 *
 * Two formats have to be tolerated, because the protocol and the wire disagree:
 * `DOM.getBoxModel` returns an eight-number quad, while
 * `DOMSnapshot.captureSnapshot`'s `layout.bounds` carries four numbers —
 * `[x, y, width, height]`. Requiring the quad here silently produced `undefined`
 * bounds for every element, which reads as "the page has nothing clickable".
 *
 * The table is ascending by node index in practice, so this binary-searches it:
 * a page with thousands of nodes would otherwise be quadratic.
 *
 * @param {object} layout - The document's layout table.
 * @param {number} nodeIndex - The node index to find.
 * @returns {{ x: number, y: number, width: number, height: number } | undefined} The rect, when present.
 */
export function boundsFor(layout, nodeIndex) {
  const indices = layout?.nodeIndex
  if (!Array.isArray(indices)) return undefined
  let low = 0
  let high = indices.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const value = indices[middle]
    if (value === nodeIndex) {
      const rect = layout.bounds?.[middle]
      if (!Array.isArray(rect)) return undefined
      if (rect.length >= 8) {
        const xs = [rect[0], rect[2], rect[4], rect[6]]
        const ys = [rect[1], rect[3], rect[5], rect[7]]
        const x = Math.min(...xs)
        const y = Math.min(...ys)
        return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
      }
      if (rect.length >= 4) {
        return { x: Number(rect[0]), y: Number(rect[1]), width: Number(rect[2]), height: Number(rect[3]) }
      }
      return undefined
    }
    if (value < nodeIndex) low = middle + 1
    else high = middle - 1
  }
  return undefined
}

/**
 * Build a memoized text reader over one document's node tables.
 *
 * The snapshot's shape drives this, and getting it wrong is silent: a Chrome
 * `DOMSnapshot.captureSnapshot` result has NO `childNodeIndexes`. It has
 * `parentIndex`, one entry per node, so the tree is reconstructed here rather
 * than walked downwards. Without that, every element reports an empty name and
 * the snapshot looks like a working page with nothing actionable on it.
 *
 * The text stored per node also varies by node type: a `#text` node's string is
 * in `nodeValue`, whereas an element's own label lives in `textValue` (and a
 * form control's current contents in `inputValue`). A wrapper element such as
 * `<button>` carries neither and must aggregate its descendants.
 *
 * @param {object} nodes - The document's `nodes` table.
 * @param {(index: unknown) => string} stringAt - String-table reader.
 * @param {number} maxChars - Per-node text cap.
 * @returns {(index: number) => string} The reader.
 */
function makeTextReader(nodes, stringAt, maxChars, options = {}) {
  const nodeCount = Array.isArray(nodes.nodeType) ? nodes.nodeType.length : 0
  // A wrapping `<label>` reads as "onI agree to the terms" when its control's
  // own value is included, and as "ChinaJapanKorea" when a `<select>`'s options
  // are. Both were reaching the model as names. The label's job is the words the
  // page prints next to the field, so a nested control contributes nothing.
  const skipControls = options.skipControlValues === true

  /** Children per parent index, built once from `parentIndex`. */
  const children = new Map()
  const parents = nodes.parentIndex
  if (Array.isArray(parents)) {
    for (let index = 0; index < nodeCount; index += 1) {
      const parent = parents[index]
      if (!Number.isInteger(parent) || parent < 0 || parent === index) continue
      const bucket = children.get(parent)
      if (bucket === undefined) children.set(parent, [index])
      else bucket.push(index)
    }
  }

  /**
   * Read one sparse `{ index, value }` string table, if present.
   * @param {unknown} table - The table.
   * @param {number} index - The node index.
   * @returns {string} The value, or an empty string.
   */
  const sparseAt = (table, index) => {
    const positions = table?.index
    const values = table?.value
    if (!Array.isArray(positions) || !Array.isArray(values)) return ''
    for (let position = 0; position < positions.length; position += 1) {
      if (positions[position] === index) return stringAt(values[position])
    }
    return ''
  }

  /** @type {Map<number, string>} */
  const cache = new Map()

  /**
   * Read one node's text.
   * @param {number} index - The node index.
   * @param {number} depth - Remaining recursion budget.
   * @returns {string} The normalized text.
   */
  const read = (index, depth, isRoot) => {
    const cached = cache.get(index)
    if (cached !== undefined && isRoot !== true) return cached
    if (depth <= 0) return ''

    const type = nodes.nodeType?.[index]
    let text = ''
    if (type === 3 || type === 4) {
      text = nodes.nodeValue?.[index] === undefined ? '' : stringAt(nodes.nodeValue[index])
    } else if (type === 1 || type === 9) {
      const tag = index === 0 ? '' : stringAt(nodes.nodeName?.[index]).toUpperCase()
      // A control *below* the node being named contributes nothing: its value
      // would be read as part of the label, which is how "onI agree to the
      // terms" and "ChinaJapanKorea" became accessible names.
      //
      // The check is on the descent rather than on the node itself, because the
      // rule it must not break is the one just below: an input's own value *is*
      // its name once the page has filled it in, and skipping the root would
      // take that away.
      if (skipControls && isRoot !== true && isControlTag(tag)) {
        cache.set(index, '')
        return ''
      }
      // The element's own label, then a control's current value — an input's
      // accessible name is often its value once filled.
      const own = sparseAt(nodes.textValue, index) || sparseAt(nodes.inputValue, index)
      if (own.length > 0) {
        text = own
      } else {
        let joined = ''
        for (const child of children.get(index) ?? []) {
          joined += read(child, depth - 1, false)
          if (joined.length > maxChars * 2) break
        }
        text = joined
      }
    }

    const normalised = text.replace(/\s+/g, ' ').trim().slice(0, maxChars)
    cache.set(index, normalised)
    return normalised
  }

  return (index) => read(index, 64, true)
}

/**
 * Turn a CDP DOM snapshot into interactive elements with stable indices.
 *
 * The index is the snapshot's own node index, so a later click can resolve the
 * same element by asking the page again rather than by re-deriving a CSS path
 * that may not exist for a component-framework node.
 *
 * A snapshot holds **one document per frame**, and each numbers its nodes from
 * zero. Reporting the raw position therefore hands the model two different
 * elements with the same `#n` as soon as a page contains an iframe — measured on
 * a checkout whose card form sits in a frame: four of seven rows collided, and
 * `#13` was both "Apply coupon" on the page and the card-number field inside the
 * frame. `resolveTarget` looks an index up with `find`, so it would have clicked
 * the coupon. Each row's `index` is therefore made unique across the whole
 * snapshot by offsetting every frame's positions past the previous ones, while
 * the per-document position is kept as `nodeIndex` for anything that needs it.
 *
 * @param {object} snapshot - The `DOMSnapshot.captureSnapshot` result.
 * @param {{ interactiveOnly?: boolean, maxNameChars?: number, requireBounds?: boolean }} [options] - Shaping.
 * @returns {object[]} The distilled elements, in document order.
 */
export function distillSnapshot(snapshot, options = {}) {
  const interactiveOnly = options.interactiveOnly !== false
  // An interactive list is only useful if every row can actually be acted on.
  // `display:none` and detached-but-parsed elements have no layout box at all,
  // so their bounds come back `undefined`; offering them would invite a click
  // that can never land.
  const requireBounds = options.requireBounds ?? interactiveOnly
  const maxNameChars = Number.isInteger(options.maxNameChars) ? options.maxNameChars : 200
  const documents = Array.isArray(snapshot?.documents) ? snapshot.documents : []
  const strings = Array.isArray(snapshot?.strings) ? snapshot.strings : []
  const elements = []

  /**
   * Read a string-table entry by index.
   * @param {unknown} index - The index into `strings`.
   * @returns {string} The string, or an empty string.
   */
  const stringAt = (index) => (Number.isInteger(index) && index >= 0 ? strings[index] ?? '' : '')

  // Each document numbers its nodes from zero, so the offset is what keeps the
  // reported indices unique across the whole snapshot. It advances by the
  // document's own node count whatever happens below, so a frame's numbers can
  // never land on the previous document's even when every one of its rows is
  // filtered out.
  let frameOffset = 0

  for (const [documentIndex, document] of documents.entries()) {
    const nodes = document?.nodes ?? {}
    const layout = document?.layout ?? {}
    const nodeCount = Array.isArray(nodes.nodeType) ? nodes.nodeType.length : 0
    if (nodeCount === 0) continue
    const base = frameOffset
    frameOffset += nodeCount
    const textFor = makeTextReader(nodes, stringAt, maxNameChars, { skipControlValues: true })

    for (let index = 0; index < nodeCount; index += 1) {
      if (nodes.nodeType[index] !== 1) continue
      const tag = stringAt(nodes.nodeName?.[index]).toUpperCase()

      /** @type {Record<string, string>} */
      const attributes = {}
      const raw = nodes.attributes?.[index]
      if (Array.isArray(raw)) {
        for (let pair = 0; pair + 1 < raw.length; pair += 2) {
          attributes[stringAt(raw[pair])] = stringAt(raw[pair + 1])
        }
      }

      const hasRole = attributes.role !== undefined
      const actionable = INTERACTIVE_TAGS.has(tag)
        || hasRole
        || attributes.tabindex !== undefined
        || attributes.onclick !== undefined
        || attributes.contenteditable !== undefined
      if (interactiveOnly && !actionable) continue

      // The accessible name, in the order a screen reader would compute it:
      // an explicit label first, then the visible text from descendants.
      const explicit = (attributes['aria-label'] ?? attributes.name ?? attributes.placeholder ?? attributes.title ?? '').trim()
      const name = explicit.length > 0 ? explicit : textFor(index)
      const bounds = boundsFor(layout, index)

      // A zero-area element cannot be clicked and is not useful to report.
      if (bounds !== undefined && (bounds.width === 0 || bounds.height === 0)) continue
      if (bounds === undefined && requireBounds) continue

      elements.push({
        // Unique across every document in the snapshot, which is what makes it a
        // usable address. `nodeIndex` keeps the position inside its own document
        // for anything that has to talk to that document directly.
        index: base + index,
        nodeIndex: index,
        // `layout.bounds` is measured against **its own** document's viewport.
        // For the top document that is the page viewport, which is the space a
        // synthetic click uses; for a frame it is not, and a caller that treated
        // the numbers as page coordinates would click wherever they happen to
        // land on the top page. Measured: a button 8px into a frame that sits at
        // page y=50 reported y=8, and clicking (83, 23) hit the page's own
        // button. The `backendNodeId` path is unaffected — `DOM.getBoxModel`
        // already converts into page space.
        inFrame: documentIndex > 0,
        tag,
        role: attributes.role ?? implicitRole(tag, attributes),
        name: name.slice(0, maxNameChars),
        type: attributes.type,
        value: attributes.value,
        href: attributes.href,
        disabled: attributes.disabled !== undefined,
        bounds,
        // Carried so `applyAccessibleNames` can join Chrome's accessibility tree
        // onto this row: the AX node identifies itself by `backendDOMNodeId`, and
        // the snapshot writes the same id per node. Verified against a real
        // snapshot rather than assumed — the field is there.
        ...(Number.isInteger(nodes.backendNodeId?.[index]) ? { backendNodeId: nodes.backendNodeId[index] } : {}),
      })
    }
  }

  return elements
}

/**
 * Roles worth taking from Chrome instead of the derived guess.
 *
 * The AX tree speaks in roles the model cannot use: a `<label>` comes back as
 * `LabelText`, a plain `<span>` as `none`, and a presentational `<label>` as
 * `none` too. Adopting those verbatim made the rendering worse than the derived
 * roles it replaced, which was the opposite of the point.
 *
 * So Chrome is trusted only where it adds something the derivation cannot know:
 * whether an `<a>` without `href` is a link, whether a `<div role="button">` is
 * a button, whether an input is a searchbox rather than a textbox. Anything
 * outside this set keeps the role derived from the tag, which is a word chosen
 * for this rendering rather than for assistive technology.
 */
const AX_ROLE_ALLOWLIST = new Set([
  'link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox',
  'listbox', 'option', 'switch', 'slider', 'spinbutton', 'tab', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'heading', 'img', 'image', 'table',
  'list', 'listitem', 'dialog', 'alert', 'alertdialog', 'progressbar',
  'textbox', 'treeitem', 'gridcell', 'columnheader', 'rowheader', 'cell',
])

/**
 * Overlay Chrome's own accessible names onto distilled elements.
 *
 * The reader in this file derives a name from a flat snapshot array, which is a
 * subset of the accessible-name computation — a W3C specification with a
 * reference implementation, and one Chrome already runs. A probe against a
 * realistic page showed exactly what the subset costs, against what Chrome
 * answers for the same nodes:
 *
 *   | element                        | derived here          | Chrome        |
 *   |--------------------------------|-----------------------|---------------|
 *   | `<label for>` + `<input>`       | *(empty)*             | Email address |
 *   | `<select>` with two options     | ChinaJapanKorea       | Country       |
 *   | wrapping `<label>` + checkbox   | onI agree to the terms| I agree…      |
 *   | `aria-label` icon button        | Close the panel       | Close the panel|
 *
 * An empty name is the worst of those: the model cannot tell the email field
 * from the card field, so it guesses. The fix is not to finish writing the
 * specification here — it is to ask the browser that already implements it.
 * `Accessibility.getFullAXTree` answers for the whole page in one call
 * (measured: 8ms, 16.6KB on a page with 33 AX nodes).
 *
 * The derivation stays as the fallback rather than being deleted: it works on a
 * snapshot alone, which is what the unit tests have and what a Chrome that
 * refuses the AX domain would leave behind. A merge, not a replacement.
 *
 * @param {object[]} elements - Rows from {@link distillSnapshot}.
 * @param {object} tree - An `Accessibility.getFullAXTree` result.
 * @returns {{ elements: object[], matched: number }} The merged rows.
 */
export function applyAccessibleNames(elements, tree) {
  const nodes = Array.isArray(tree?.nodes) ? tree.nodes : []
  if (nodes.length === 0) return { elements, matched: 0 }

  /** AX facts by backend node id, which is what the snapshot also carries. */
  const byBackendId = new Map()
  for (const node of nodes) {
    const id = node?.backendDOMNodeId
    if (!Number.isInteger(id)) continue
    byBackendId.set(id, node)
  }

  let matched = 0
  let dropped = 0
  const merged = []
  for (const element of elements) {
    if (!Number.isInteger(element.backendNodeId)) {
      merged.push(element)
      continue
    }
    const node = byBackendId.get(element.backendNodeId)
    if (node === undefined) {
      merged.push(element)
      continue
    }
    matched += 1
    const name = typeof node.name?.value === 'string' ? node.name.value : ''
    const role = typeof node.role?.value === 'string' ? node.role.value : ''
    const row = {
      ...element,
      // Whitespace is collapsed for the same reason the reader collapses it: a
      // wrapping label arrives with the leading space of its text node, and the
      // row is rendered inside JSON quotes where that reads as a mistake.
      name: name.replace(/\s+/g, ' ').trim(),
      // Chrome's role wins only when it is one this rendering has a word for.
      role: AX_ROLE_ALLOWLIST.has(role) ? role : element.role,
    }

    // A row with nothing in it is a row the model pays for and learns nothing
    // from. Giving a control its `<label>`'s words is right, but it leaves the
    // label behind as `#68 label` — measured on a checkout page, four of those
    // plus one unnamed button were five of thirty-two rows, sixteen per cent of
    // the list.
    //
    // The two halves of that are not the same thing and are not treated the
    // same. A `<label>` is a *proxy*: its words now live on the control, so
    // dropping it removes nothing. An unnamed `<button>` is a real target — it
    // is clickable, and a list that hides it hides a capability — so it stays,
    // empty name and all.
    if (isInformationless(row) && PROXY_ROLES.has(row.role)) {
      dropped += 1
      continue
    }
    merged.push(row)
  }

  return { elements: merged, matched, dropped }
}

/**
 * Whether a row carries nothing a reader could act on or learn from.
 *
 * Name, value, href and type are the four things `renderElements` prints, so a
 * row missing all four renders as `#index role` and nothing else.
 *
 * @param {object} element - A distilled row.
 * @returns {boolean} True when nothing would be printed after the role.
 */
function isInformationless(element) {
  return element.name === ''
    && (element.value === undefined || element.value === '')
    && element.href === undefined
    && element.type === undefined
}

/**
 * Roles that exist only to point at another node.
 *
 * A `<label>` names a control; Chrome agrees, reporting it as `LabelText` with
 * an empty name because the words have already been given to the thing it
 * labels. Once this rendering has done the same, the label row is a duplicate
 * with the information removed.
 */
const PROXY_ROLES = new Set(['label', 'LabelText'])

/**
 * Render distilled elements as the text a model reads.
 *
 * One line per element, `#index role "name"` plus only the attributes that
 * change what an action would do — a dense list is the point, since the model
 * pays for every line and needs enough to choose one.
 *
 * @param {object[]} elements - Rows from {@link distillSnapshot}.
 * @param {{ maxBytes?: number }} [options] - Shaping.
 * @returns {{ text: string, truncated: boolean }} The rendering and whether it was cut.
 */
export function renderElements(elements, options = {}) {
  const maxBytes = Number.isInteger(options.maxBytes) ? options.maxBytes : 200_000
  const lines = elements.map((element) => [
    `#${element.index}`,
    element.role,
    element.name === '' ? undefined : JSON.stringify(element.name),
    element.type === undefined ? undefined : `type=${element.type}`,
    element.value === undefined || element.value === '' ? undefined : `value=${JSON.stringify(element.value)}`,
    element.href === undefined ? undefined : `href=${element.href}`,
    element.disabled ? 'disabled' : undefined,
  ].filter((part) => part !== undefined).join(' '))

  let text = lines.join('\n')
  if (text.length <= maxBytes) return { text, truncated: false }
  // Cut on a line boundary so the last entry is not a half-rendered element.
  const cut = text.lastIndexOf('\n', maxBytes)
  text = `${text.slice(0, cut === -1 ? maxBytes : cut)}\n… (snapshot truncated at ${maxBytes} characters)`
  return { text, truncated: true }
}
