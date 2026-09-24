/**
 * A minimal Markdown renderer for the side panel.
 *
 * The panel has no bundler and no dependencies, so this is deliberately a
 * subset rather than a Markdown implementation: fenced code, headings, lists,
 * tables, quotes, rules, and the four inline spans that actually appear in a
 * coding session's replies. Anything it does not understand survives as literal
 * text, which is the failure mode you want — a rendering gap must never eat
 * words.
 *
 * Split in two on purpose:
 *
 *   - `parseMarkdown` is pure and returns plain data, so the grammar is testable
 *     under `node --test` with no DOM shim.
 *   - `renderBlocks` is the only half that touches `document`, and it builds
 *     nodes rather than HTML strings. Nothing here ever assigns `innerHTML`, so
 *     a message containing markup is displayed, not executed.
 *
 * @module extension/markdown
 */

/** A run of inline content: literal text, or one styled span. */
const INLINE_PATTERN = /(!?\[[^\]\n]*\]\([^()\s]+\)|`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_)/g

/** Schemes a message is allowed to turn into a clickable link. */
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

/**
 * Read a fenced code block's opening line.
 * @param {string} line - The source line.
 * @returns<string | undefined> The info string, when this line opens a fence.
 */
function fenceInfo(line) {
  const match = /^\s*```+\s*([^\s`]*)/.exec(line)
  return match === null ? undefined : match[1]
}

/** Stands in for a literal `|` while a row is being split. */
const PIPE_PLACEHOLDER = '\u0000'

/**
 * Split one table row into cells.
 *
 * A backslash-escaped pipe is data, not a delimiter, so it is parked on a
 * placeholder before splitting — a cell containing `\|` must not widen the row.
 *
 * @param {string} line - The source line.
 * @returns {string[]} The trimmed cells.
 */
function splitCells(line) {
  const guarded = String(line).trim().replace(/\\\|/g, PIPE_PLACEHOLDER)
  const body = guarded.startsWith('|') ? guarded.slice(1) : guarded
  const trimmed = body.endsWith('|') ? body.slice(0, -1) : body
  return trimmed.split('|').map((cell) => cell.replaceAll(PIPE_PLACEHOLDER, '|').trim())
}

/**
 * Whether a line is a table's delimiter row (`|---|:--:|`).
 * @param {string} line - The source line.
 * @returns {boolean} True when the line separates a header from its body.
 */
function isDelimiterRow(line) {
  const text = String(line).trim()
  if (text.length === 0 || !text.includes('-')) return false
  const cells = splitCells(text)
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell))
}

/**
 * Read a table starting at `index`, if one starts there.
 *
 * Recognised the way GitHub recognises one: a row containing a pipe, immediately
 * followed by a delimiter row. Without that second line the text stays an
 * ordinary paragraph, which is what keeps a stray `a | b` in prose from being
 * mistaken for a table. Replies from a coding session routinely carry a
 * comparison table, and printing its pipes literally is the difference between
 * a readable answer and a wall of vertical bars.
 *
 * @param {string[]} lines - All source lines.
 * @param {number} index - Where to look.
 * @returns {{ block: object, next: number } | undefined} The table and the first line after it.
 */
function tableAt(lines, index) {
  const header = lines[index]
  const delimiter = lines[index + 1]
  if (delimiter === undefined || !header.includes('|') || !isDelimiterRow(delimiter)) return undefined

  const columns = splitCells(header)
  const align = splitCells(delimiter).map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return null
  })

  const rows = []
  let cursor = index + 2
  while (cursor < lines.length && lines[cursor].trim().length > 0 && lines[cursor].includes('|')) {
    // Cells are padded or truncated to the header's width so the columns line
    // up; a short row is a formatting slip, not a reason to drop the table.
    const cells = splitCells(lines[cursor])
    rows.push(columns.map((_, column) => cells[column] ?? ''))
    cursor += 1
  }

  return { block: { type: 'table', header: columns, align, rows }, next: cursor }
}

/**
 * Parse Markdown into blocks.
 *
 * @param {string} text - The message body.
 * @returns {object[]} The blocks, in document order.
 */
export function parseMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (line.trim().length === 0) {
      index += 1
      continue
    }

    const fence = fenceInfo(line)
    if (fence !== undefined) {
      const body = []
      index += 1
      // An unterminated fence runs to the end rather than dropping the code:
      // a streamed reply can be read before its closing fence arrives.
      while (index < lines.length && fenceInfo(lines[index]) === undefined) {
        body.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      blocks.push({ type: 'code', lang: fence, text: body.join('\n') })
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() })
      index += 1
      continue
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: 'rule' })
      index += 1
      continue
    }

    if (/^\s*>/.test(line)) {
      const body = []
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        body.push(lines[index].replace(/^\s*>\s?/, ''))
        index += 1
      }
      blocks.push({ type: 'quote', text: body.join('\n') })
      continue
    }

    const bullet = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (bullet !== null) {
      const ordered = /\d/.test(bullet[1])
      const items = []
      while (index < lines.length) {
        const next = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index])
        if (next === null || /\d/.test(next[1]) !== ordered) break
        items.push(next[2])
        index += 1
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }

    const table = tableAt(lines, index)
    if (table !== undefined) {
      blocks.push(table.block)
      index = table.next
      continue
    }

    const body = []
    while (index < lines.length && lines[index].trim().length > 0) {
      const candidate = lines[index]
      if (fenceInfo(candidate) !== undefined) break
      if (/^(#{1,6})\s+/.test(candidate)) break
      if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(candidate)) break
      if (/^\s*>/.test(candidate)) break
      if (tableAt(lines, index) !== undefined) break
      body.push(candidate)
      index += 1
    }
    blocks.push({ type: 'paragraph', text: body.join('\n') })
  }

  return blocks
}

/**
 * Whether a link target may become a clickable href.
 *
 * The target has to name its own scheme. `renderInline` already said what to do
 * with one that does not — 「An unsafe or relative target stays visible as text:
 * the words matter, the click does not」 — and this function did the opposite for
 * relative paths, by resolving them against a placeholder origin to read their
 * scheme. Resolving is the one thing that makes a relative path look absolute:
 * `/docs/extensions/reference/api/tabs` came back `https:`, passed, and was then
 * written into `href`, where the browser resolved it a second time — against the
 * document, which in a side panel is the extension's own origin.
 *
 * Measured across this machine's sessions: 258 links of exactly that shape, and
 * clicking one lands on a path inside the extension rather than on a site.
 *
 * @param {string} href - The raw target from the message.
 * @returns {boolean} True when the scheme is safe and the target is absolute.
 */
export function isSafeHref(href) {
  const target = href.trim()
  // Scheme first, so the URL constructor is only asked about targets that carry
  // their own origin. Without this, `//example.com/x` and `/x` are both resolved
  // — or rejected — for reasons that have nothing to do with the target.
  //
  // The harness's own renderer answers it the same way: its `sanitizeUrl` calls
  // `new URL(url)` with no base and lets a relative path throw, and its comment
  // records that fragment-only targets are meant to fail the allowlist and render
  // as plain text. `mailto:` is on its list as well as the two web schemes.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) return false
  try {
    return SAFE_SCHEMES.has(new URL(target).protocol)
  } catch {
    return false
  }
}

/**
 * Render one line of inline Markdown into a fragment.
 *
 * @param {Document} document - The document to build nodes with.
 * @param {string} text - The line.
 * @returns {DocumentFragment} The fragment.
 */
export function renderInline(document, text) {
  const fragment = document.createDocumentFragment()
  const source = String(text ?? '')
  let cursor = 0

  INLINE_PATTERN.lastIndex = 0
  let match = INLINE_PATTERN.exec(source)
  while (match !== null) {
    if (match.index > cursor) fragment.append(source.slice(cursor, match.index))
    const token = match[0]
    cursor = match.index + token.length

    if (token.startsWith('`')) {
      const node = document.createElement('code')
      node.textContent = token.slice(1, -1)
      fragment.append(node)
    } else if (token.startsWith('**') || token.startsWith('__')) {
      const node = document.createElement('strong')
      node.textContent = token.slice(2, -2)
      fragment.append(node)
    } else if (token.startsWith('![')) {
      // A markdown image is its own thing, and it used to be read as a link: the
      // pattern matched from the `[`, so the `!` stayed on the line as literal
      // text and the picture became a clickable link to its own file — measured
      // across this machine's sessions, 162 images in real answers, 48 of them
      // remote and therefore rendered as `!alt` pointing at an image file.
      //
      // The panel cannot show a remote picture: it renders a conversation, and the
      // message's own images arrive through the harness as attachments with a
      // content-addressed id, not as markdown. So the honest thing is the alt text
      // — that is what the author wrote for a reader who cannot see the picture —
      // with the source beside it, the same way a declined link is drawn. When the
      // alt is empty the source is the only thing the message ever said.
      const split = token.indexOf('](')
      const alt = token.slice(2, split)
      const src = token.slice(split + 2, -1)
      const label = alt.length > 0 ? alt : src
      fragment.append(document.createTextNode(label))
      if (alt.length > 0) {
        const address = document.createElement('span')
        address.className = 'image-src'
        address.textContent = ` (${src})`
        fragment.append(address)
      }
    } else if (token.startsWith('[')) {
      const split = token.indexOf('](')
      const label = token.slice(1, split)
      const href = token.slice(split + 2, -1)
      // The words matter even when the click cannot happen, so a target that may
      // not become an href is shown as its label followed by the address it
      // named. Printing the source instead — `[tabs 参考](/docs/…/tabs)` — reads
      // as a renderer that gave up rather than as a link that was declined.
      if (!isSafeHref(href)) {
        fragment.append(document.createTextNode(label.length > 0 ? label : href))
        if (label.length > 0) {
          const address = document.createElement('span')
          address.className = 'href-raw'
          address.textContent = ` (${href})`
          fragment.append(address)
        }
      } else {
        const node = document.createElement('a')
        node.href = href
        // A new tab is what an http(s) target means. `mailto:` is handed to the
        // browser as it is — and the harness's own renderer draws the same line,
        // setting `target` and intercepting the click for the web schemes alone.
        const external = /^https?:/i.test(href)
        if (external) node.target = '_blank'
        node.rel = 'noreferrer noopener'
        node.textContent = label.length > 0 ? label : href
        fragment.append(node)
      }
    } else {
      const node = document.createElement('em')
      node.textContent = token.slice(1, -1)
      fragment.append(node)
    }
    match = INLINE_PATTERN.exec(source)
  }

  if (cursor < source.length) fragment.append(source.slice(cursor))
  return fragment
}

/**
 * Render parsed blocks into a fragment.
 *
 * @param {Document} document - The document to build nodes with.
 * @param {object[]} blocks - Blocks from `parseMarkdown`.
 * @param {object} [options] - Rendering labels.
 * @param {string} [options.copy] - Label for a code block's copy button.
 * @returns {DocumentFragment} The fragment.
 */
export function renderBlocks(document, blocks, options = {}) {
  const fragment = document.createDocumentFragment()

  for (const block of blocks) {
    if (block.type === 'code') {
      // A code block is a card with a head row: the language on the left, a
      // copy button on the right. Without the button the only way to take a
      // snippet is to drag-select it, and that is friction the reader meets
      // every single time. The button is deliberately inert — the panel
      // delegates the click — so this renderer stays a pure function.
      const card = document.createElement('div')
      card.className = 'code-block'
      const head = document.createElement('div')
      head.className = 'code-head'
      const label = document.createElement('span')
      label.className = 'code-lang'
      label.textContent = typeof block.lang === 'string' ? block.lang : ''
      head.append(label)
      const copy = document.createElement('button')
      copy.type = 'button'
      copy.className = 'copy'
      copy.dataset.copy = 'code'
      copy.textContent = typeof options.copy === 'string' ? options.copy : ''
      head.append(copy)
      card.append(head)
      const pre = document.createElement('pre')
      const code = document.createElement('code')
      code.textContent = block.text
      if (typeof block.lang === 'string' && block.lang.length > 0) pre.dataset.lang = block.lang
      pre.append(code)
      card.append(pre)
      fragment.append(card)
      continue
    }

    if (block.type === 'heading') {
      const level = Math.min(6, Math.max(1, block.level))
      const node = document.createElement(`h${level}`)
      node.append(renderInline(document, block.text))
      fragment.append(node)
      continue
    }

    if (block.type === 'rule') {
      fragment.append(document.createElement('hr'))
      continue
    }

    if (block.type === 'list') {
      const list = document.createElement(block.ordered ? 'ol' : 'ul')
      for (const item of block.items) {
        const node = document.createElement('li')
        node.append(renderInline(document, item))
        list.append(node)
      }
      fragment.append(list)
      continue
    }

    if (block.type === 'table') {
      // The scroller is the part that matters on a narrow side panel: a wide
      // table scrolls sideways instead of squeezing its columns into slivers.
      //
      // Two things make that reachable, and neither is decoration. A scrollable
      // region that cannot be focused is a region a keyboard cannot scroll — the
      // panel already made this call for the conversation and the session list,
      // and a table is the third scroller, which was missed. Measured on a
      // four-column table before this: 242px of content sat to the right of the
      // panel and the keyboard could reach none of it.
      //
      // And `tabindex` alone would put a stop in the tab order that announces
      // nothing — the reader lands on it and is told only "group". A named
      // region says which table they are in.
      const scroller = document.createElement('div')
      scroller.className = 'table-scroll'
      scroller.tabIndex = 0
      scroller.setAttribute('role', 'region')
      if (typeof options.tableRegion === 'string' && options.tableRegion.length > 0) {
        scroller.setAttribute('aria-label', options.tableRegion)
      }
      const table = document.createElement('table')
      const head = document.createElement('thead')
      const headRow = document.createElement('tr')
      for (const [column, cell] of block.header.entries()) {
        const th = document.createElement('th')
        const align = block.align?.[column]
        if (align !== null && align !== undefined) th.style.textAlign = align
        th.append(renderInline(document, cell))
        headRow.append(th)
      }
      head.append(headRow)
      table.append(head)
      if (block.rows.length > 0) {
        const body = document.createElement('tbody')
        for (const row of block.rows) {
          const tr = document.createElement('tr')
          for (const [column, cell] of row.entries()) {
            const td = document.createElement('td')
            const align = block.align?.[column]
            if (align !== null && align !== undefined) td.style.textAlign = align
            td.append(renderInline(document, cell))
            tr.append(td)
          }
          body.append(tr)
        }
        table.append(body)
      }
      scroller.append(table)
      // The shades that mark a continuing edge live on a positioned parent, not on
      // the scroller: a pseudo-element inside a scroll container is in flow, and
      // the pair of them (with the margins needed to collapse them onto each other)
      // pulled the scroller's own height to zero, which hid the table they were
      // meant to annotate.
      //
      // The two attributes are how the shades know where the reader is, because CSS
      // cannot read `scrollLeft`. They are maintained by the panel's scroll
      // handler; here they start in the position every table starts in.
      const box = document.createElement('div')
      box.className = 'table-box'
      scroller.setAttribute('data-scrolled', 'no')
      scroller.setAttribute('data-at-end', 'no')
      box.append(scroller)
      fragment.append(box)
      continue
    }

    if (block.type === 'quote') {
      const node = document.createElement('blockquote')
      node.append(renderInline(document, block.text))
      fragment.append(node)
      continue
    }

    const paragraph = document.createElement('p')
    paragraph.append(renderInline(document, block.text))
    fragment.append(paragraph)
  }

  return fragment
}

/**
 * Render a Markdown string straight to nodes.
 * @param {Document} document - The document to build nodes with.
 * @param {string} text - The message body.
 * @param {object} [options] - Rendering labels; see `renderBlocks`.
 * @returns {DocumentFragment} The fragment.
 */
export function renderMarkdown(document, text, options) {
  return renderBlocks(document, parseMarkdown(text), options)
}
