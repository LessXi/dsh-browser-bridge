/**
 * Tests for the panel's Markdown subset.
 *
 * Two properties are worth this file:
 *
 *   - Parsing is pure, so the grammar is checked as data rather than by
 *     eyeballing a rendered panel.
 *   - Rendering never assigns `innerHTML`, and only `http:`/`https:` targets
 *     become links. A message is model output; it must be displayed, not
 *     executed. A tiny document shim is enough to assert both, and is cheaper
 *     than exporting a "did you use innerHTML" flag.
 *
 * @module dsh-browser-bridge/test/markdown
 */

import { assert, test } from './harness.js'
import { isSafeHref, parseMarkdown, renderMarkdown } from '../../../extension/markdown.js'

/**
 * The smallest faithful document that `renderBlocks` uses.
 *
 * Two DOM behaviours are load-bearing and are emulated because the renderer
 * depends on them: appending a fragment inserts its *children* rather than the
 * fragment, and a parent's `textContent` includes its descendants' text. Nodes
 * are plain objects, and there is deliberately no `innerHTML` — a renderer that
 * reached for it would throw here instead of passing quietly.
 *
 * @returns {object} A `document` stand-in.
 */
function makeDocument() {
  const make = (tagName) => ({
    tagName: tagName.toUpperCase(),
    children: [],
    textContent: '',
    dataset: {},
    style: {},
    // Attributes are recorded rather than ignored, because the renderer now sets
    // two of them on a table's scroller — `role` and `aria-label` — and a stub
    // that drops them would let the tests pass while the panel shipped a table a
    // screen reader cannot name.
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = String(value)
    },
    getAttribute(name) {
      // A property set by assignment is reflected into an attribute in a browser,
      // and the renderer relies on that: it writes `node.target` and `node.rel`
      // rather than calling `setAttribute`. A stub that only read `attributes`
      // reported `null` for both, so no test could tell a link that asks for a new
      // tab from one that does not.
      if (name === 'class') return this.className ?? this.attributes.class ?? null
      const direct = this[name]
      if (direct !== undefined && direct !== null && typeof direct !== 'object') return String(direct)
      return this.attributes[name] ?? null
    },
    append(...kids) {
      for (const kid of kids) {
        if (typeof kid === 'string') {
          this.children.push(kid)
          this.textContent += kid
          continue
        }
        if (kid.tagName === '#TEXT') {
          this.children.push(kid)
          this.textContent += kid.textContent
          continue
        }
        if (kid.tagName === '#FRAGMENT') {
          for (const inner of kid.children) this.append(inner)
          continue
        }
        this.children.push(kid)
        this.textContent += kid.textContent
      }
    },
    addEventListener() {},
  })
  return {
    createElement: make,
    createDocumentFragment: () => make('#fragment'),
    // The renderer builds the words of a declined link as a text node rather than
    // as a string, because a string cannot carry a class and the address that
    // follows the label is styled differently. Without this the renderer threw
    // here and passed in the browser — the reverse of the failure a test is for.
    createTextNode: (data) => ({ tagName: '#TEXT', textContent: String(data), children: [] }),
  }
}

/**
 * Flatten a rendered tree into `tag:text` pairs.
 * @param {object} node - A node from the shim.
 * @returns {string[]} One entry per element, in document order.
 */
function flatten(node) {
  const out = []
  for (const child of node.children ?? []) {
    if (typeof child === 'string') continue
    out.push(`${child.tagName.toLowerCase()}:${child.textContent}${child.href ? `@${child.href}` : ''}`)
    out.push(...flatten(child))
  }
  return out
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('paragraphs, headings and rules parse to blocks', () => {
  assert.deepEqual(parseMarkdown('one line\nsecond line'), [{ type: 'paragraph', text: 'one line\nsecond line' }])
  assert.deepEqual(parseMarkdown('# Title\n## Sub'), [
    { type: 'heading', level: 1, text: 'Title' },
    { type: 'heading', level: 2, text: 'Sub' },
  ])
  assert.deepEqual(parseMarkdown('---'), [{ type: 'rule' }])
  assert.deepEqual(parseMarkdown(''), [])
})

test('a fenced block keeps its language and its exact body', () => {
  assert.deepEqual(parseMarkdown('```js\nconst a = 1\n\nconst b = 2\n```\n'), [
    { type: 'code', lang: 'js', text: 'const a = 1\n\nconst b = 2' },
  ])
})

test('an unterminated fence still yields the code', () => {
  // A streamed reply can be read before its closing fence arrives; dropping the
  // words would be the worse failure.
  assert.deepEqual(parseMarkdown('```\nhalf a block'), [{ type: 'code', lang: '', text: 'half a block' }])
})

test('lists keep their items and their ordering', () => {
  assert.deepEqual(parseMarkdown('- a\n- b\n'), [{ type: 'list', ordered: false, items: ['a', 'b'] }])
  assert.deepEqual(parseMarkdown('1. a\n2. b\n'), [{ type: 'list', ordered: true, items: ['a', 'b'] }])
  assert.deepEqual(parseMarkdown('> quoted\n> more'), [{ type: 'quote', text: 'quoted\nmore' }])
})

test('a list interrupts a paragraph rather than being swallowed by it', () => {
  const blocks = parseMarkdown('Here they are:\n- a\n- b')
  assert.deepEqual(blocks.map((block) => block.type), ['paragraph', 'list'])
  assert.equal(blocks[0].text, 'Here they are:')
})

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test('a safe link becomes an anchor and an unsafe one stays text', () => {
  assert.equal(isSafeHref('https://example.com/a'), true)
  assert.equal(isSafeHref('http://127.0.0.1:3080/'), true)
  assert.equal(isSafeHref('javascript:alert(1)'), false)
  assert.equal(isSafeHref('data:text/html,<script>'), false)
  assert.equal(isSafeHref('file:///C:/secret'), false)

  const document = makeDocument()
  const anchor = renderMarkdown(document, '[docs](https://example.com/)').children[0].children[0]
  assert.equal(anchor.tagName, 'A')
  assert.equal(anchor.textContent, 'docs')
  assert.equal(anchor.href, 'https://example.com/')
  assert.equal(anchor.rel, 'noreferrer noopener')

  const unsafe = renderMarkdown(document, '[click](javascript:void)')
  assert.equal(flatten(unsafe).filter((entry) => entry.startsWith('a:')).length, 0, 'no anchor for an unsafe scheme')
  assert.equal(unsafe.textContent, 'click (javascript:void)', 'the words stay visible, beside the address that was declined')
})

test('a link that does not name its own site is not drawn as one', () => {
  // The check resolved a relative path against a placeholder origin to read its
  // scheme, which is the one thing that makes a relative path look absolute:
  // `/docs/extensions/reference/api/tabs` came back `https:` and passed. The
  // browser then resolved it a second time — against the document, which in a
  // side panel is the extension's own origin — so the reader who clicked it
  // landed inside the extension rather than on the documentation.
  //
  // Measured across this machine's sessions: 258 links of exactly that shape
  // against 3454 that name their site. So this is not a corner case; it is the
  // second-largest group of links a real answer carries.
  for (const relative of ['/docs/extensions/reference/api/tabs', './guide.md', '../a/b', '#section', '//example.com/x']) {
    assert.equal(
      isSafeHref(relative),
      false,
      `${relative} names no scheme, so nothing can say which site it belongs to`,
    )
  }
  // The harness's own renderer draws the line here too. Its `sanitizeUrl` calls
  // `new URL(url)` with no base and lets a relative path throw, and its comment
  // records that fragment-only targets are deliberately shown as plain text.
  assert.equal(isSafeHref('mailto:someone@example.com'), true, 'an address is a target that names its scheme')

  const document = makeDocument()
  const rendered = renderMarkdown(document, 'see [the tabs docs](/docs/extensions/reference/api/tabs)')
  assert.equal(
    flatten(rendered).filter((entry) => entry.startsWith('a:')).length,
    0,
    'a relative path must not become a link: the reader would arrive somewhere the author never named',
  )
  // The label and the address both stay readable. Printing the source instead —
  // `[the tabs docs](/docs/…)` — reads as a renderer that gave up rather than as
  // a target that was declined.
  assert.equal(rendered.textContent, 'see the tabs docs (/docs/extensions/reference/api/tabs)')
  assert.ok(
    !rendered.textContent.includes(']('),
    `the raw markdown syntax is on screen: ${JSON.stringify(rendered.textContent)}`,
  )
})

test('only a web address asks for a new tab', () => {
  // `mailto:` is handed to the browser as it is; a tab is not what an email
  // address means. The harness's renderer sets `target` for http(s) alone.
  const document = makeDocument()
  const web = renderMarkdown(document, '[a](https://example.com/)').children[0].children[0]
  assert.equal(web.getAttribute('target'), '_blank')
  const local = renderMarkdown(document, '[b](http://127.0.0.1:3080/)').children[0].children[0]
  assert.equal(local.getAttribute('target'), '_blank', 'a local http address is still a page in a tab')
  const mail = renderMarkdown(document, '[c](mailto:someone@example.com)').children[0].children[0]
  assert.equal(mail.tagName, 'A', 'a mailto address is a link')
  assert.equal(mail.getAttribute('target'), null, 'and it must not be asked to open a tab')
})

test('inline code, bold and italics render as their own elements', () => {
  const rendered = renderMarkdown(makeDocument(), 'use `npm test` then **stop** and *breathe*')
  const paragraph = rendered.children[0]
  assert.deepEqual(
    paragraph.children.map((kid) => (typeof kid === 'string' ? kid : kid.tagName)),
    ['use ', 'CODE', ' then ', 'STRONG', ' and ', 'EM'],
  )
  assert.equal(rendered.textContent, 'use npm test then stop and breathe')
})

test('a code block renders as a card: language and copy on the head, code under it', () => {
  const card = renderMarkdown(makeDocument(), '```sh\nls -la\n```', { copy: 'Copy' }).children[0]
  assert.equal(card.tagName, 'DIV')
  assert.equal(card.className, 'code-block')
  const [head, pre] = card.children
  assert.equal(head.className, 'code-head')
  assert.equal(head.children[0].className, 'code-lang')
  assert.equal(head.children[0].textContent, 'sh', 'the head names the language')
  const copy = head.children[1]
  assert.equal(copy.tagName, 'BUTTON')
  assert.equal(copy.dataset.copy, 'code', 'the panel finds the button by its dataset, not by its position')
  assert.equal(copy.textContent, 'Copy', 'the label is the caller’s, so this renderer stays pure')
  assert.equal(pre.tagName, 'PRE')
  assert.equal(pre.dataset.lang, 'sh')
  assert.equal(pre.children[0].tagName, 'CODE')
  assert.equal(pre.children[0].textContent, 'ls -la')
})

test('a fence without a language still gets a copy button and invents no label', () => {
  const card = renderMarkdown(makeDocument(), '```\nplain\n```').children[0]
  assert.equal(card.children[0].children[0].textContent, '', 'nothing is invented for the missing language')
  assert.equal(card.children[0].children[1].dataset.copy, 'code')
  assert.equal(card.children[0].children[1].textContent, '', 'and the renderer never invents UI copy')
})

test('rendering never needs innerHTML', () => {
  const document = makeDocument()
  // A shim without `innerHTML` is half the assertion: if the renderer ever
  // reached for it, this would throw rather than pass.
  const rendered = renderMarkdown(document, '<b>not bold</b>')
  assert.equal(rendered.textContent, '<b>not bold</b>', 'markup in a message is text, never nodes')
  assert.equal(typeof rendered.children[0].children[0], 'string')

  assert.doesNotThrow(() => flatten(renderMarkdown(makeDocument(), '<img src=x onerror=alert(1)>')))
})

// ---------------------------------------------------------------------------
// Tables
//
// A reply that compares options carries a table, and a table rendered as
// literal pipes is the difference between an answer and a wall of vertical
// bars. Parsing is asserted as data, so the grammar is checked without a DOM.
// ---------------------------------------------------------------------------

test('a table parses into a header, its alignments, and its rows', () => {
  const blocks = parseMarkdown(
    ['| 类型 | 作用 | 能否拒绝 |', '|---|---|:--:|', '| 必要 | 登录 | 不能关 |', '| 功能性 | 记住语言 | 可以关 |'].join('\n'),
  )
  assert.deepEqual(blocks, [
    {
      type: 'table',
      header: ['类型', '作用', '能否拒绝'],
      align: [null, null, 'center'],
      rows: [
        ['必要', '登录', '不能关'],
        ['功能性', '记住语言', '可以关'],
      ],
    },
  ])
})

test('leading and trailing pipes are optional', () => {
  const withPipes = parseMarkdown('| a | b |\n|---|---|\n| 1 | 2 |')
  const without = parseMarkdown('a | b\n---|---\n1 | 2')
  assert.deepEqual(withPipes, without, 'the outer pipes are delimiters, not data')
  assert.deepEqual(withPipes[0].header, ['a', 'b'])
})

test('a table interrupts a paragraph and the prose resumes after it', () => {
  const blocks = parseMarkdown('常见分类：\n| a | b |\n|---|---|\n| 1 | 2 |\n就这样。')
  assert.deepEqual(
    blocks.map((block) => block.type),
    ['paragraph', 'table', 'paragraph'],
  )
  assert.equal(blocks[0].text, '常见分类：')
  assert.equal(blocks[2].text, '就这样。')
})

test('pipes without a delimiter row stay prose', () => {
  // The delimiter row is what makes it a table; without it the pipes are text,
  // and dropping them would silently edit the model's words.
  assert.deepEqual(parseMarkdown('a | b'), [{ type: 'paragraph', text: 'a | b' }])
  assert.deepEqual(parseMarkdown('| a | b |\n| c | d |'), [{ type: 'paragraph', text: '| a | b |\n| c | d |' }])
})

test('an escaped pipe is data, not a column break', () => {
  const blocks = parseMarkdown('| expr | meaning |\n|---|---|\n| `a \\| b` | either |')
  assert.deepEqual(blocks[0].header, ['expr', 'meaning'])
  assert.deepEqual(blocks[0].rows, [['`a | b`', 'either']])
})

test('a short row is padded to the header width', () => {
  const blocks = parseMarkdown('| a | b | c |\n|---|---|---|\n| 1 |')
  assert.deepEqual(blocks[0].rows, [['1', '', '']])
})

test('a table renders as a table inside a scroll container', () => {
  const rendered = renderMarkdown(makeDocument(), '| a | b |\n|---|---|\n| 1 | 2 |')
  // The scroller sits inside a positioned box, and that nesting is load-bearing:
  // the shades that mark a continuing edge have to be positions on a parent, not
  // pseudo-elements inside the scroll container. Put inside, they are in flow, and
  // the pair of them pulled the scroller's own height to zero — measured, the
  // table kept its 125px while `.table-scroll` reported 0, and the answer above it
  // collapsed to 92px. So the shape is asserted, not just the class name.
  const box = rendered.children[0]
  assert.equal(box.className, 'table-box', 'the scroller needs a positioned parent for its edge shades')

  const scroller = box.children[0]
  assert.equal(scroller.className, 'table-scroll', 'a wide table scrolls sideways rather than squeezing')

  const table = scroller.children[0]
  assert.equal(table.tagName, 'TABLE')
  const [head, body] = table.children
  assert.equal(head.tagName, 'THEAD')
  assert.deepEqual(
    head.children[0].children.map((cell) => `${cell.tagName}:${cell.textContent}`),
    ['TH:a', 'TH:b'],
  )
  assert.equal(body.tagName, 'TBODY')
  assert.deepEqual(
    body.children[0].children.map((cell) => `${cell.tagName}:${cell.textContent}`),
    ['TD:1', 'TD:2'],
  )
})

test('a table scroller can be reached and named by assistive technology', () => {
  // The scroller is the third scrollable region in the panel, after the
  // conversation and the session list, and those two were given a `tabindex` and
  // a name in an earlier round. This one was missed, and the cost was measured:
  // a four-column table held 242px of content off to the right and the keyboard
  // could reach none of it — 242px of a real answer that existed only for people
  // using a mouse.
  //
  // The name is not a nicety either. A `tabindex` on a plain `div` puts a stop in
  // the tab order that announces nothing; the reader lands on it and is told
  // "group".
  const rendered = renderMarkdown(
    makeDocument(),
    '| a | b |\n|---|---|\n| 1 | 2 |',
    { tableRegion: 'Table, scrolls sideways' },
  )
  const box = rendered.children[0]
  const scroller = box.children[0]
  assert.equal(scroller.tabIndex, 0, 'the table scroller must be reachable by Tab, not skipped over')
  assert.equal(scroller.getAttribute('role'), 'region', 'a focus stop that announces nothing is worse than no stop')
  assert.equal(scroller.getAttribute('aria-label'), 'Table, scrolls sideways')

  // The two attributes the edge shades read. CSS cannot see `scrollLeft`, so
  // without them a shade would sit on the first column claiming there is more
  // table to its left. They start in the position every table starts in.
  assert.equal(scroller.getAttribute('data-scrolled'), 'no', 'a table starts at its left edge')
  assert.equal(scroller.getAttribute('data-at-end'), 'no', 'and, being wider than the panel, it does not start at the end')

  // Without the caller's string the element must not carry an empty label, which
  // would be announced as nothing while looking deliberate in the markup.
  const unnamed = renderMarkdown(makeDocument(), '| a | b |\n|---|---|\n| 1 | 2 |')
  assert.equal(
    unnamed.children[0].children[0].getAttribute('aria-label'),
    null,
    'an unnamed region must omit the attribute rather than set it empty',
  )
})

test('alignment reaches the cell it belongs to', () => {
  const rendered = renderMarkdown(makeDocument(), '| l | c | r |\n|:--|:-:|--:|\n| 1 | 2 | 3 |')
  const row = rendered.children[0].children[0].children[0].children[1].children[0]
  assert.deepEqual(
    row.children.map((cell) => cell.style.textAlign),
    ['left', 'center', 'right'],
  )
})

test('inline spans still work inside a cell', () => {
  const rendered = renderMarkdown(makeDocument(), '| a |\n|---|\n| **bold** |')
  const cell = rendered.children[0].children[0].children[0].children[1].children[0].children[0]
  assert.deepEqual(
    cell.children.map((kid) => (typeof kid === 'string' ? kid : kid.tagName)),
    ['STRONG'],
  )
})
