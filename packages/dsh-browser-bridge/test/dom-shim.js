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
    /**
     * The DOM's element node type.
     *
     * Read by anything that walks a subtree looking for text: a range can only
     * address a text node, so "which children are text" is a question the search
     * marking has to ask. `TextNode` overrides it with 3.
     *
     * @type {number}
     */
    this.nodeType = 1
    this.className = ''
    this.id = ''
    this.dataset = {}
    this.style = {}
    this.hidden = false
    this.#value = ''
    this.selectionStart = 0
    this.selectionEnd = 0
    this.type = ''
    this.placeholder = ''
    this.title = ''
    this.disabled = false
    this.selected = false
    this.scrollTop = 0
    this.scrollHeight = 0
    this.clientHeight = 0
    this.offsetHeight = 0
    /**
     * Where this element's box starts, in the viewport.
     *
     * A plain assignable field rather than a real layout engine: a test that
     * needs a row to sit at a particular place, or to move when something
     * reflows, sets this. Defaults to 0, which is where every element used to be
     * pinned.
     */
    this.rectTop = 0
    this.parentNode = null
    this.listeners = new Map()
    /** Attributes set by name, read back by the same name. See `setAttribute`. */
    this.attributes = {}
    this.#text = ''
    this.#children = []
  }

  #text
  #children
  #value

  get children() {
    // Elements only, as in a browser. `childNodes` is the one that includes text.
    return this.#children.filter((child) => child.nodeType === 1)
  }

  get firstElementChild() {
    return this.#children.find((child) => child.nodeType === 1) ?? null
  }

  get textContent() {
    if (this.#children.length > 0) return this.#children.map((child) => child.textContent).join('')
    return this.#text
  }

  set textContent(value) {
    for (const child of this.#children) child.parentNode = null
    this.#children = []
    this.#text = value === null || value === undefined ? '' : String(value)
    // A browser replaces the children with a single text node, and it does so for
    // an empty string too. Code that walks the tree looking for text depends on
    // that: the search marks the matched characters by addressing a text node, so
    // with text kept in a field instead, the marking was unreachable from the
    // suite and every test of it asserted nothing. `TextNode` overrides this
    // setter, which is what stops the node from nesting inside itself.
    this.#children.push(new TextNode(this.#text))
    this.#children[0].parentNode = this
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
    // Stored under the name it was set with, because `getAttribute` reads that
    // same name back. The previous version wrote camel-cased keys here while
    // reading the dashed name there, so every `aria-*` read came back `null` —
    // which is indistinguishable from "never set", and is how a row that does
    // announce itself looked like one that does not.
    else this.attributes[name] = String(value)
  }

  getAttribute(name) {
    if (name === 'id') return this.id
    if (name === 'class') return this.className
    // A plain property wins when it holds something, because the panel sets
    // `src`, `hidden` and the rest by assignment rather than by attribute, and
    // the browser reflects those into attributes for exactly this reason.
    const direct = this[name]
    if (direct !== undefined && direct !== null && typeof direct !== 'object') return String(direct)
    return this.attributes[name] ?? null
  }

  removeAttribute(name) {
    if (name === 'id') this.id = ''
    else if (name === 'class') this.className = ''
    else {
      delete this.attributes[name]
      if (name in this) delete this[name]
    }
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

  /**
   * Fire the listeners registered for `type`, then let it bubble.
   *
   * Bubbling is not a nicety here: the panel installs its Escape handling on the
   * document and its `@`-picker handling on the textarea, and the picker's own
   * Escape branch means the two must be able to disagree about one keystroke. A
   * shim that stopped at the element could not tell a fix from a regression in
   * exactly that case.
   *
   * It walks every ancestor rather than jumping to the document, because that is
   * what a browser does and the difference is load-bearing: a `role="menu"` keeps
   * its arrow keys with a handler on the container, so a shim that skipped the
   * middle of the path could not tell a working menu from one whose keys go
   * nowhere — the handler simply never ran.
   *
   * Root stubs (`getElementById`'s elements, which have no parent) still reach
   * the document listeners through `ownerDocument`, because in a browser they
   * hang off the document and the document is on the path.
   *
   * `event.preventDefault` is provided when the caller did not, because every
   * handler under test calls it and a shim that throws on its absence reports a
   * TypeError instead of the behaviour.
   *
   * @param {string} type - The event name.
   * @param {object} [event] - The event object the handlers read.
   * @returns {void}
   */
  emit(type, event = {}) {
    if (typeof event.preventDefault !== 'function') event.preventDefault = () => {}
    let stopped = false
    if (typeof event.stopPropagation !== 'function') {
      event.stopPropagation = () => { stopped = true }
    } else {
      const original = event.stopPropagation
      event.stopPropagation = () => { stopped = true; original() }
    }
    let node = this
    while (node !== null && node !== undefined) {
      // The document has its own `emit` that does not bubble, so reaching it
      // terminates the walk rather than recursing.
      if (node.isDocument === true) {
        node.emit(type, event)
        return
      }
      for (const listener of [...(node.listeners?.get(type) ?? [])]) listener(event)
      if (stopped) return
      if (node.parentNode === null || node.parentNode === undefined) {
        const root = this.ownerDocument
        if (root !== undefined && typeof root.emit === 'function') root.emit(type, event)
        return
      }
      node = node.parentNode
    }
  }

  /**
   * The caret, which is where a real textarea puts it.
   *
   * The `@` picker reads `selectionStart` to know which word is being completed
   * and writes it back after removing that word, so a shim without these makes
   * every mention test fail with a TypeError that says nothing about the picker.
   */
  setSelectionRange(start, end = start) {
    this.selectionStart = start
    this.selectionEnd = end
  }

  /**
   * Read or write the control's text, moving the caret to the end on a write.
   *
   * A real textarea does exactly that, and the `@` picker depends on it: it
   * reads the text before the caret, so a shim that left the caret where it was
   * would have the picker complete a word nobody is typing any more.
   */
  get value() {
    return this.#value ?? ''
  }

  set value(next) {
    this.#value = String(next ?? '')
    this.selectionStart = this.#value.length
    this.selectionEnd = this.#value.length
  }

  /** Reset scroll metrics, for tests that drive the follow-the-bottom rule. */
  measure({ scrollTop = 0, scrollHeight = 0, clientHeight = 0 } = {}) {
    this.scrollTop = scrollTop
    this.scrollHeight = scrollHeight
    this.clientHeight = clientHeight
  }

  /**
   * Whether `node` is this element or sits inside it.
   *
   * The real API walks the tree; the panel uses it to ask "is the row I
   * remembered still on screen", which a poll can answer either way. Without it
   * a caller that guards on it throws instead of taking the guarded branch, so
   * the test would fail on the shim rather than on the behaviour.
   */
  contains(node) {
    if (node === null || node === undefined) return false
    for (let walk = node; walk !== null && walk !== undefined; walk = walk.parentNode) {
      if (walk === this) return true
    }
    return false
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

  /**
   * Move focus here.
   *
   * This used to be a no-op, which meant the document had no `activeElement`
   * that ever changed and *every* focus behaviour was untestable — including
   * where focus lands when a layer closes, and whether the arrow keys move
   * between rows at all. The contract kept here is the one the panel relies on:
   * focusing an attached element makes it the document's `activeElement`, and
   * focusing a detached one does nothing, because a node that is not in the
   * tree cannot hold focus in a browser either.
   *
   * @returns {void}
   */
  focus() {
    const document = this.ownerDocument
    if (document === undefined) return
    document.activeElement = this
  }

  blur() {
    const document = this.ownerDocument
    if (document?.activeElement === this) document.activeElement = null
  }

  /**
   * The document this node belongs to, found by walking to the root.
   *
   * Two roots have to be recognised, because this shim builds its tree in a way
   * a browser does not. Elements handed out by `getElementById` are created on
   * demand and are the *roots* of their own subtrees — they have no `parentNode`
   * — yet they are exactly the nodes a browser would consider in the document.
   * So those carry a `documentRef`, and the walk accepts either that or a node
   * marked `isDocument` at the top of the tree.
   *
   * A genuinely detached subtree has neither, and returns `undefined`: a node
   * that is not in the document cannot hold focus in a browser either, and a
   * shim that let it would make "focus stayed where it was" look like "focus
   * moved".
   *
   * @returns {object|undefined} The document, when this node belongs to one.
   */
  get ownerDocument() {
    let node = this
    while (node !== null && node !== undefined) {
      if (node.documentRef !== undefined) return node.documentRef
      if (node.isDocument === true) return node
      node = node.parentNode
    }
    return undefined
  }
  /**
   * Fire a click at this node, the way a browser does.
   *
   * `target` is the load-bearing part. Delegated handlers find the control that
   * was clicked by walking up from `event.target` — `closest('.failure-again')`
   * and the whole copy-button handler work that way — so a shim that emitted a
   * bare `{}` made every delegated handler silently do nothing. That reads as
   * "the feature was never implemented" rather than "the event had no target",
   * which is the worst way for a test double to be wrong.
   */
  click() {
    this.emit('click', { target: this })
  }
  /**
   * Whether this node is in a document, which a browser answers natively.
   *
   * The panel asks it to tell "the row I clicked is still on screen" from "it was
   * rebuilt underneath me", and a shim that left it `undefined` made that
   * question unanswerable — every read came back falsy, so a test asserting the
   * node survived would fail on a correct implementation rather than on the
   * behaviour it was written for.
   *
   * @returns {boolean} True when the node has a document.
   */
  get isConnected() {
    return this.ownerDocument !== undefined
  }
  scrollIntoView() {}
  /**
   * The element's box, at whatever position the test has placed it.
   *
   * `top` used to be the constant 0, which made every element sit at the same
   * place: a test could not say "this row is 40px below the viewport's top edge"
   * or "the reflow pushed it down", so anything measured *between two elements*
   * — an anchor's distance from the top of the scroller, which is what keeps a
   * reader's place when a sidebar is resized — was unrepresentable.
   */
  getBoundingClientRect() {
    return {
      top: this.rectTop,
      left: 0,
      width: 320,
      height: this.offsetHeight,
      bottom: this.rectTop + this.offsetHeight,
      right: 320,
    }
  }

  #adopt(node) {
    if (node instanceof Fragment) {
      // `childNodes`, not `children`: a fragment is where the markdown renderer
      // puts its output, and that output is mostly text nodes. Splicing by
      // `children` silently dropped every piece of text in it.
      for (const child of [...node.childNodes]) this.#adopt(child)
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
    this.nodeType = 3
    this.textContent = String(data)
  }

  /**
   * A text node holds its text, it does not contain it.
   *
   * `Element`'s setter replaces the children with a text node, which is right for
   * an element and would nest a node inside itself here.
   *
   * @param {unknown} value - The text.
   * @returns {void}
   */
  set textContent(value) {
    this.#own = value === null || value === undefined ? '' : String(value)
  }

  get textContent() {
    return this.#own
  }

  #own = ''
}

/**
 * Match one node against a single simple selector.
 * Supports `.class`, `#id`, `tag`, and `.class[data-x="y"]`-free combinations.
 *
 * @param {Element} node - The candidate.
 * @param {string} selector - `.cls`, `#id`, or a tag name.
 * @returns {boolean} Whether it matches.
 */
/**
 * Whether one node matches a selector.
 *
 * Deliberately small, but it has to cover the shapes the panel actually queries,
 * because a selector the shim cannot understand returns *no match* rather than
 * an error — so a missing branch here turns an assertion about behaviour into an
 * assertion about nothing. Supported: `tag`, `.class`, `#id`, `[attr]`,
 * `[attr="value"]`, and any combination of them on one compound selector.
 *
 * @param {object} node - The node to test.
 * @param {string} selector - A single compound selector.
 * @returns {boolean} True when the node matches.
 */
function matches(node, selector) {
  const trimmed = selector.trim()
  // Split a compound selector into its tag / class / id / attribute parts. The
  // attribute values in this project never contain `]` or quotes, so a simple
  // scan is enough and a full CSS parser would be more code than it is worth.
  const parts = trimmed.match(/^[a-zA-Z][\w-]*|\.[\w-]+|#[\w-]+|\[[^\]]+\]/g)
  if (parts === null || parts.join('') !== trimmed) return false
  for (const part of parts) {
    if (part.startsWith('.')) {
      if (!node.className.split(' ').includes(part.slice(1))) return false
    } else if (part.startsWith('#')) {
      if (node.id !== part.slice(1)) return false
    } else if (part.startsWith('[')) {
      const body = part.slice(1, -1)
      const equals = body.indexOf('=')
      const name = (equals === -1 ? body : body.slice(0, equals)).trim()
      // `dataset` is the live source: the panel writes `dataset.kind`, and
      // `setAttribute` mirrors into it, so one read covers both paths.
      const actual = node.dataset?.[camel(name)] ?? node.getAttribute?.(name) ?? node[name]
      if (equals === -1) {
        if (actual === undefined || actual === null) return false
      } else {
        const wanted = body.slice(equals + 1).trim().replace(/^["']|["']$/g, '')
        if (String(actual) !== wanted) return false
      }
    } else if (node.tagName !== part.toUpperCase()) {
      return false
    }
  }
  return true
}

/** `data-kind` → `kind`, so a selector can be looked up on `dataset`. */
function camel(name) {
  return name.replace(/^data-/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
}

/**
 * The tag each id really has, for the ids whose tag something asks about.
 *
 * `byId` mints every element as a `div`, which is right for identity — the panel
 * fetches its nodes once and only their identity matters — but wrong for the
 * handful of questions whose answer *is* the tag. `active.tagName === 'TEXTAREA'`
 * is how a shortcut tells "the reader is typing" from "the reader is reading",
 * and a shim that calls a textarea a `div` makes that branch unreachable: the
 * guard reads false, the shortcut fires inside the composer, and the test fails
 * for a reason that is the shim's rather than the panel's.
 *
 * Only the ids a test asks about are listed. A browser learns this from the
 * markup, which this shim deliberately does not parse; inventing a parser here
 * would be a second implementation of HTML to keep correct.
 */
const TAGS = new Map([
  ['input', 'TEXTAREA'],
  ['find-input', 'INPUT'],
])

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
      const element = new Element(TAGS.get(id) ?? 'div')
      element.id = id
      // These elements are roots — nothing is their parent — but in a browser
      // they would be in the document, so they have to say which document they
      // belong to. Without this, focus on a row inside one walks to a null
      // parent and finds no document, so `focus()` becomes a no-op again and
      // every focus assertion silently reads "nothing moved".
      //
      // Read through a getter rather than assigned here: `byId` is defined
      // before the document object it refers to, and a plain assignment would
      // capture a value that does not exist yet.
      Object.defineProperty(element, 'documentRef', { get: () => document })
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
    /**
     * Whether the page is on screen, as the panel reads it before deciding
     * whether a poll is worth running.
     *
     * Mutable and separate from `hidden` because the panel reads this one — a
     * browser keeps the two consistent, and a test needs to drive them the way a
     * browser would. Without it, `document.visibilityState` was `undefined` in
     * every suite, so a guard written against it silently took the "visible"
     * branch and the skipping was untestable.
     *
     * @type {string}
     */
    visibilityState: 'visible',
    /**
     * What currently holds focus.
     *
     * The shim keeps this so focus behaviour is testable at all: without it,
     * "where does focus go when a layer closes" and "do the arrow keys move
     * between rows" are questions no test can ask. `null` before anything has
     * been focused, which is what a browser reports when focus is on the body.
     *
     * @type {Element|null}
     */
    activeElement: null,
    getElementById: byId,
    createElement: (tagName) => new Element(tagName),
    createTextNode: (data) => new TextNode(data),
    createDocumentFragment: () => new Fragment(),
    querySelector: () => null,
    querySelectorAll: () => [],
    /**
     * Document-level listeners, kept so they can be fired.
     *
     * These used to be no-ops, which made every shortcut the panel installs on
     * the document untestable — and the panel installs its Escape handling
     * there. A test can now reach that code by emitting on the document, which
     * is the same path a real keypress takes.
     *
     * @type {Map<string, Function[]>}
     */
    listeners: new Map(),
    addEventListener(type, listener) {
      if (!document.listeners.has(type)) document.listeners.set(type, [])
      document.listeners.get(type).push(listener)
    },
    removeEventListener(type, listener) {
      const list = document.listeners.get(type) ?? []
      const index = list.indexOf(listener)
      if (index !== -1) list.splice(index, 1)
    },
    /**
     * Fire the document listeners registered for `type`.
     * @param {string} type - The event name.
     * @param {object} [event] - The event object the handlers read.
     * @returns {void}
     */
    emit(type, event = {}) {
      for (const listener of [...(document.listeners.get(type) ?? [])]) listener(event)
    },
    /**
     * A range over two offsets, as much of one as the panel uses.
     *
     * The search marks the matched characters with the CSS Custom Highlight API,
     * which addresses a text node by offset — so `createRange` is the only way to
     * name what to paint, and without it the marking is untestable and the tests
     * that claim to cover it assert nothing.
     *
     * `toString` reconstructs the text from the endpoints rather than storing it,
     * so a range cannot disagree with the node it points at.
     *
     * @returns {object} A range with `setStart`, `setEnd`, `toString`.
     */
    createRange: () => {
      const range = {
        startContainer: null,
        startOffset: 0,
        endContainer: null,
        endOffset: 0,
        setStart(node, offset) {
          range.startContainer = node
          range.startOffset = offset
        },
        setEnd(node, offset) {
          range.endContainer = node
          range.endOffset = offset
        },
        toString() {
          if (range.startContainer === null || range.startContainer !== range.endContainer) return ''
          const value = String(range.startContainer.textContent ?? '')
          return value.slice(range.startOffset, range.endOffset)
        },
      }
      return range
    },
  }
  // Marks this object as the root `focus()` walks up to. A flag rather than a
  // class check, because the document here is a plain object.
  Object.defineProperty(document, 'isDocument', { value: true })
  documentElement.parentNode = document
  document.body.parentNode = document
  document.head.parentNode = document
  return { document, registry }
}

export { Element, Fragment, makeDocument }
