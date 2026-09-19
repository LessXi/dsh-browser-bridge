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
const INLINE_PATTERN = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]*\]\([^()\s]+\))/g

/** Schemes a message is allowed to turn into a clickable link. */
const SAFE_SCHEMES = new Set(['http:', 'https:'])

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
 * @param {string} href - The raw target from the message.
 * @returns {boolean} True when the scheme is safe.
 */
export function isSafeHref(href) {
  try {
    return SAFE_SCHEMES.has(new URL(href, 'https://example.invalid/').protocol)
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
    } else if (token.startsWith('[')) {
      const split = token.indexOf('](')
      const label = token.slice(1, split)
      const href = token.slice(split + 2, -1)
      // An unsafe or relative target stays visible as text: the words matter,
      // the click does not.
      if (!isSafeHref(href)) {
        fragment.append(token)
      } else {
        const node = document.createElement('a')
        node.href = href
        node.target = '_blank'
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
 * @param {string} [options.copyCode] - Accessible name for that button, which says
 *   it copies the code rather than the answer. Both buttons draw the same short
 *   word, so without this Chrome's accessibility tree carries two controls named
 *   「复制」 with nothing to tell them apart.
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
      if (typeof options.copyCode === 'string' && options.copyCode.length > 0) {
        copy.setAttribute('aria-label', options.copyCode)
        copy.title = options.copyCode
      }
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
      // The Codex panel makes the same call (`_TableScroller` is `overflow-x:
      // auto` with a thin scrollbar).
      const scroller = document.createElement('div')
      scroller.className = 'table-scroll'
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
      fragment.append(scroller)
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
