/**
 * A minimal DOM for loading the side panel outside a browser.
 *
 * `sidepanel.js` is a real ES module, so it can be imported and driven in Node —
 * it only needs a `document` and a `chrome`. That is worth the ~200 lines here:
 * everything the panel does with live model output happens between a message
 * arriving and a node changing, and no amount of string matching over the source
 * proves that path works.
 *
 * The shim implements what the panel actually calls, and asserts nothing. It is
 * deliberately not a general DOM: selectors are single class / id / tag names,
 * layout is three numbers that tests set directly, and there is no CSS engine.
 *
 * Two globals are replaced for the whole run and `fetch` is chained rather than
 * replaced, so a later suite that reaches the network still can.
 *
 * @module dsh-browser-bridge/test/dom-shim
 */

/** One node. Children are a plain array; `textContent` is either text or children. */
class Element {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase()
    this.className = ''
    this.id = ''
    this.dataset = {}
    this.style = {}
    this.hidden = false
    this.value = ''
    this.type = ''
    this.placeholder = ''
    this.title = ''
    this.disabled = false
    this.selected = false
    this.scrollTop = 0
    this.scrollHeight = 0
    this.clientHeight = 0
    this.offsetHeight = 0
    this.parentNode = null
    this.listeners = new Map()
    this.#text = ''
    this.#children = []
  }

  #text
  #children

  get children() {
    return this.#children
  }

  get firstElementChild() {
    return this.#children[0] ?? null
  }

  get textContent() {
    if (this.#children.length > 0) return this.#children.map((child) => child.textContent).join('')
    return this.#text
  }

  set textContent(value) {
    this.#children = []
    this.#text = String(value ?? '')
  }

  get classList() {
    const owner = this
    return {
      add: (...names) => {
        const set = new Set(owner.className.split(' ').filter(Boolean))
        for (const name of names) set.add(name)
        owner.className = [...set].join(' ')
      },
      remove: (...names) => {
        const set = new Set(owner.className.split(' ').filter(Boolean))
        for (const name of names) set.delete(name)
        owner.className = [...set].join(' ')
      },
      contains: (name) => owner.className.split(' ').includes(name),
      toggle: (name, force) => {
        const has = owner.className.split(' ').includes(name)
        const want = force === undefined ? !has : force
        if (want) owner.classList.add(name)
        else owner.classList.remove(name)
        return want
      },
    }
  }

  append(...nodes) {
    for (const node of nodes) this.#adopt(node)
  }

  appendChild(node) {
    this.append(node)
    return node
  }

  insertBefore(node, reference) {
    if (reference === null || reference === undefined) {
      this.append(node)
      return node
    }
    reference.before(node)
    return node
  }

  removeChild(node) {
    node.remove()
    return node
  }

  get childNodes() {
    return this.#children
  }

  prepend(...nodes) {
    for (const node of nodes) {
      this.#detach(node)
      node.parentNode = this
      this.#children.unshift(node)
    }
  }

  /** Insert this node directly before `reference` in its parent. */
  before(...nodes) {
    const parent = this.parentNode
    if (parent === null) return
    const at = parent.#children.indexOf(this)
    for (const node of nodes) {
      parent.#detach(node)
      node.parentNode = parent
      parent.#children.splice(at, 0, node)
    }
  }

  remove() {
    this.parentNode?.#detach(this)
    this.parentNode = null
  }

  replaceChildren(...nodes) {
    for (const child of this.#children) child.parentNode = null
    this.#children = []
    this.#text = ''
    for (const node of nodes) this.#adopt(node)
  }

  setAttribute(name, value) {
    if (name === 'id') this.id = String(value)
    else if (name === 'class') this.className = String(value)
    else if (name === 'aria-expanded') this.ariaExpanded = String(value)
    else this[name] = String(value)
  }

  getAttribute(name) {
    if (name === 'id') return this.id
    if (name === 'class') return this.className
    return this[name] ?? null
  }

  removeAttribute(name) {
    if (name === 'id') this.id = ''
    else if (name === 'class') this.className = ''
    else delete this[name]
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(listener)
  }

  removeEventListener(type, listener) {
    const list = this.listeners.get(type) ?? []
    const at = list.indexOf(listener)
    if (at !== -1) list.splice(at, 1)
  }

  /** Fire the listeners registered for `type`. Handlers may read `event`. */
  emit(type, event = {}) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }

  /** Reset scroll metrics, for tests that drive the follow-the-bottom rule. */
  measure({ scrollTop = 0, scrollHeight = 0, clientHeight = 0 } = {}) {
    this.scrollTop = scrollTop
    this.scrollHeight = scrollHeight
    this.clientHeight = clientHeight
  }

  /** Every descendant, in document order. */
  descendants() {
    const out = []
    const walk = (node) => {
      for (const child of node.#children) {
        out.push(child)
        walk(child)
      }
    }
    walk(this)
    return out
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector) {
    return this.descendants().filter((node) => matches(node, selector))
  }

  closest(selector) {
    let node = this
    while (node !== null) {
      if (matches(node, selector)) return node
      node = node.parentNode
    }
    return null
  }

  focus() {}
  blur() {}
  click() {
    this.emit('click', {})
  }
  scrollIntoView() {}
  getBoundingClientRect() {
    return { top: 0, left: 0, width: 320, height: this.offsetHeight, bottom: this.offsetHeight, right: 320 }
  }

  #adopt(node) {
    if (node instanceof Fragment) {
      for (const child of [...node.children]) this.#adopt(child)
      return
    }
    const adopted = typeof node === 'string' || typeof node === 'number' ? new TextNode(node) : node
    this.#text = ''
    this.#detach(adopted)
    adopted.parentNode = this
    this.#children.push(adopted)
  }

  #detach(node) {
    const at = this.#children.indexOf(node)
    if (at !== -1) this.#children.splice(at, 1)
  }
}

/** A document fragment is an element that never becomes a node. */
class Fragment extends Element {
  constructor() {
    super('#fragment')
  }
}

/**
 * A text node.
 *
 * `append('some text')` is idiomatic DOM and the renderer uses it, so a shim
 * that only accepts elements does not merely fail — it fails inside a promise
 * the panel swallows, which looks exactly like "the transcript did not change".
 */
class TextNode extends Element {
  constructor(data) {
    super('#text')
    this.textContent = String(data)
  }
}

/**
 * Match one node against a single simple selector.
 * Supports `.class`, `#id`, `tag`, and `.class[data-x="y"]`-free combinations.
 *
 * @param {Element} node - The candidate.
 * @param {string} selector - `.cls`, `#id`, or a tag name.
 * @returns {boolean} Whether it matches.
 */
function matches(node, selector) {
  const trimmed = selector.trim()
  if (trimmed.startsWith('.')) return node.className.split(' ').includes(trimmed.slice(1))
  if (trimmed.startsWith('#')) return node.id === trimmed.slice(1)
  return node.tagName === trimmed.toUpperCase()
}

/**
 * Build a document whose `getElementById` mints one stable stub per id.
 *
 * The panel fetches its nodes once, at module load, so identity is all that
 * matters — but the stubs have to persist, because later lookups inside the
 * panel walk `transcript` after a `replaceChildren`.
 *
 * @returns {{ document: object, registry: Map<string, Element> }} The document and its nodes.
 */
function makeDocument() {
  const registry = new Map()
  const byId = (id) => {
    if (!registry.has(id)) {
      const element = new Element('div')
      element.id = id
      registry.set(id, element)
    }
    return registry.get(id)
  }

  const documentElement = new Element('html')
  const document = {
    documentElement,
    body: new Element('body'),
    // `head` is not decoration: the plugin's browser half injects a style tag
    // through it, and a document without one turns a skipped step into a
    // TypeError in whichever suite runs next.
    head: new Element('head'),
    hidden: false,
    getElementById: byId,
    createElement: (tagName) => new Element(tagName),
    createTextNode: (data) => new TextNode(data),
    createDocumentFragment: () => new Fragment(),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  return { document, registry }
}

export { Element, Fragment, makeDocument }
