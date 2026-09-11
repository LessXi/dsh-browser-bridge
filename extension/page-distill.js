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
function makeTextReader(nodes, stringAt, maxChars) {
  const nodeCount = Array.isArray(nodes.nodeType) ? nodes.nodeType.length : 0

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
  const read = (index, depth) => {
    const cached = cache.get(index)
    if (cached !== undefined) return cached
    if (depth <= 0) return ''

    const type = nodes.nodeType?.[index]
    let text = ''
    if (type === 3 || type === 4) {
      text = nodes.nodeValue?.[index] === undefined ? '' : stringAt(nodes.nodeValue[index])
    } else if (type === 1 || type === 9) {
      // The element's own label, then a control's current value — an input's
      // accessible name is often its value once filled.
      const own = sparseAt(nodes.textValue, index) || sparseAt(nodes.inputValue, index)
      if (own.length > 0) {
        text = own
      } else {
        let joined = ''
        for (const child of children.get(index) ?? []) {
          joined += read(child, depth - 1)
          if (joined.length > maxChars * 2) break
        }
        text = joined
      }
    }

    const normalised = text.replace(/\s+/g, ' ').trim().slice(0, maxChars)
    cache.set(index, normalised)
    return normalised
  }

  return (index) => read(index, 64)
}

/**
 * Turn a CDP DOM snapshot into interactive elements with stable indices.
 *
 * The index is the snapshot's own node index, so a later click can resolve the
 * same element by asking the page again rather than by re-deriving a CSS path
 * that may not exist for a component-framework node.
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

  for (const document of documents) {
    const nodes = document?.nodes ?? {}
    const layout = document?.layout ?? {}
    const nodeCount = Array.isArray(nodes.nodeType) ? nodes.nodeType.length : 0
    if (nodeCount === 0) continue
    const textFor = makeTextReader(nodes, stringAt, maxNameChars)

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
        index,
        tag,
        role: attributes.role ?? implicitRole(tag, attributes),
        name: name.slice(0, maxNameChars),
        type: attributes.type,
        value: attributes.value,
        href: attributes.href,
        disabled: attributes.disabled !== undefined,
        bounds,
      })
    }
  }

  return elements
}

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
