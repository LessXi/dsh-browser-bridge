/**
 * The settings card and the composer chips are React components, and nothing in
 * this repository had ever rendered them.
 *
 * `client-inject.test.js` evaluates the bundle and calls `apply` against a stub
 * `ctx`, which proves the service declarations are right — but its `react` stub
 * returns `{ type: 'stub', args }` for every `createElement`, so no component
 * body ever ran. That is how a fully localized card shipped with fixed English
 * strings, and how the composer chips shipped with no translator at all: both
 * are only observable once something renders.
 *
 * These tests render for real, against a small hook runtime that implements just
 * enough of React to settle a component: state with a working setter, effects
 * that run and whose cleanups run at teardown, and a re-render once the polled
 * fetch resolves. The tree is then walked, so assertions are about what a person
 * would actually see rather than about the source text.
 *
 * Two disciplines this file has to keep, because both have bitten this project
 * before. Effect cleanups must run — `usePolled` starts a `setInterval`, and a
 * discarded cleanup leaves a timer holding the process open, which the runner
 * shows as a silent hang rather than a failure. And globals must be restored to
 * their previous descriptor rather than deleted, or a later suite inherits a
 * missing `fetch`.
 */

import { assert, test } from './harness.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/** The Chinese copy, mirrored so assertions can name real words. */
const ZH_KEYS = {
  browserUnavailable: '浏览器：不可用',
  browserConnected: '浏览器：已连接',
  browserNotConnected: '浏览器：未连接',
  statusPanel: '浏览器桥接状态',
  limitation: '限制',
  removeChip: '从上下文移除',
  removeChipHint: '发送前移除——什么都还没发出去',
  chipSelection: '选中内容',
  chipPage: '整页',
  chipTab: '标签页',
  chipChars: '{count} 字',
}

/** A translator over `ZH_KEYS`, standing in for the harness's. */
const zhT = (key) => ZH_KEYS[key] ?? key

/**
 * Temporarily replace a global, restoring the exact previous descriptor.
 *
 * Not `delete`: another suite may have installed its own `fetch`, and removing
 * it would surface as an unrelated failure several files later.
 *
 * @param {string} name - The global.
 * @param {unknown} value - The temporary value.
 * @returns {() => void} The restore function.
 */
function withGlobal(name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: true })
  return () => {
    if (previous === undefined) delete globalThis[name]
    else Object.defineProperty(globalThis, name, previous)
  }
}

/**
 * The smallest React that can settle a component: state, effects, re-render.
 *
 * Cleanups returned by effects are collected and run by `unmount`, which the
 * caller must invoke: without it a component that polls keeps its interval alive
 * and the test process never exits.
 *
 * @returns {{ react: object, render: Function, unmount: () => void }}
 */
function miniReact() {
  const hooks = []
  const cleanups = []
  let cursor = 0
  let dirty = false
  let pendingEffects = []

  const react = {
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((child) => child !== null && child !== undefined),
    }),
    useState: (initial) => {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
      return [hooks[index], (next) => {
        hooks[index] = typeof next === 'function' ? next(hooks[index]) : next
        dirty = true
      }]
    },
    useEffect: (fn, deps) => {
      const index = cursor++
      const key = JSON.stringify(deps ?? null)
      const slot = hooks[`e${index}`]
      if (slot === undefined || slot.key !== key) {
        hooks[`e${index}`] = { key }
        pendingEffects.push(fn)
      }
    },
    useRef: (initial) => {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = { current: initial }
      return hooks[index]
    },
    Fragment: 'fragment',
  }

  /**
   * Render `fn`, running effects and any state updates they cause.
   * @param {Function} fn - The component.
   * @param {object} props - Its props.
   * @returns {Promise<object>} The settled tree.
   */
  const render = async (fn, props) => {
    let tree
    for (let pass = 0; pass < 5; pass += 1) {
      cursor = 0
      pendingEffects = []
      dirty = false
      tree = fn(props)
      for (const effect of pendingEffects) {
        const cleanup = effect()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      }
      // Let a polled promise settle before deciding whether another pass is due;
      // one pass would only ever read the empty first state.
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (!dirty) break
    }
    return tree
  }

  /** Run every effect cleanup, so no interval outlives the test. */
  const unmount = () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop()
      try {
        cleanup()
      } catch {
        // A cleanup that throws must not mask the assertion that ran before it.
      }
    }
  }

  return { react, render, unmount }
}

/**
 * Evaluate the bundle and return the plugin plus a renderer bound to it.
 *
 * @returns {{ plugin: object, render: Function, unmount: () => void }} The plugin and driver.
 */
function loadPlugin() {
  let registration
  const { react, render, unmount } = miniReact()

  const restoreWindow = withGlobal('window', { __ModuleLoader__: { load: (value) => { registration = value } } })
  const restoreDocument = withGlobal('document', {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: () => {} },
  })

  try {
    new Function(source)()
  } finally {
    restoreDocument()
    restoreWindow()
  }

  assert.ok(registration, 'client bundle did not register with window.__ModuleLoader__')
  const plugin = registration.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require: ${name}`)
  })
  return { plugin, render, unmount }
}

/**
 * Register every contribution, returning what each slot received.
 *
 * @param {object} plugin - The loaded plugin.
 * @returns {Map<string, { component: Function, options: object }>} By slot name.
 */
function registrationsOf(plugin) {
  const found = new Map()
  const services = {
    slots: {
      inject: (_name, fn) => fn(),
      register: (options, component) => {
        found.set(options.name, { component, options })
        return () => {}
      },
    },
    locale: { register: () => () => {}, bind: () => () => {} },
    theme: { overrideTokens: () => () => {} },
  }
  const ctx = new Proxy({ effect: (fn) => fn(), on: () => () => {} }, {
    get(target, prop) {
      if (typeof prop !== 'string') return Reflect.get(target, prop)
      if (Reflect.has(target, prop)) return Reflect.get(target, prop)
      return services[prop]
    },
  })
  plugin.apply(ctx)
  return found
}

/** Walk a rendered tree, visiting every node. */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

/** Every string a person would read (text children, not props). */
function texts(node) {
  const out = []
  walk(node, (n) => {
    for (const child of n.children ?? []) if (typeof child === 'string') out.push(child)
  })
  return out
}

/** Every props object in the tree. */
function propsIn(node) {
  const out = []
  walk(node, (n) => out.push(n.props ?? {}))
  return out
}

/** The dictionary keys a name declares. */
function dictionaryKeys(name) {
  const start = source.indexOf(`const ${name} = {`)
  const end = source.indexOf('\n    }', start)
  return [...source.slice(start, end).matchAll(/^\s{6}([A-Za-z][A-Za-z0-9]*):\s*'/gm)].map((m) => m[1])
}

/** Answer every fetch with the same attachment payload. */
function stagedAttachments(rows) {
  return async () => ({ ok: true, json: async () => ({ attachments: rows }) })
}

test('the dictionaries stay key-for-key', (t) => {
  const zh = dictionaryKeys('ZH').sort()
  const en = dictionaryKeys('EN').sort()
  assert.ok(zh.length > 20, `expected a real dictionary, found ${zh.length} keys`)
  assert.deepEqual(zh, en, 'the two dictionaries must carry the same keys')
})

test('no dictionary key is dead: every one is drawn somewhere', (t) => {
  // The dead-key direction. `statusPanel` sat in both dictionaries unused while
  // the popover's aria-label carried fixed English — the key existed, was
  // translated, and nothing reached for it.
  const dead = dictionaryKeys('ZH').filter(
    (key) => (source.match(new RegExp(`['"\`]${key}['"\`]`, 'g')) ?? []).length === 0,
  )
  assert.deepEqual(dead, [], `these keys are defined but nothing draws them: ${dead.join(', ')}`)
})

test('no user-visible label in the card is a fixed English string', (t) => {
  // Attribute-level copy is invisible to a text walk — an aria-label on a remove
  // button is read aloud and never appears as a child node. The dictionaries are
  // stripped first, because their entries look identical (`title: 'Browser
  // bridge'`) and matching those would make the assertion meaningless.
  const withoutDictionaries = source
    .replace(/const ZH = \{[\s\S]*?\n    \}/, '')
    .replace(/const EN = \{[\s\S]*?\n    \}/, '')

  const literals = []
  for (const match of withoutDictionaries.matchAll(/(aria-label|title):\s*'([^']*)'/g)) {
    const [, prop, value] = match
    // A glyph-only value carries no words; those are controls, not copy.
    if (/[A-Za-z]{2,}/.test(value)) literals.push(`${prop}: '${value}'`)
  }
  assert.deepEqual(literals, [], `these labels bypass the dictionary: ${literals.join(' | ')}`)
})

test('every slot that renders copy declares the locale, so it receives a translator', (t) => {
  const { plugin } = loadPlugin()
  const found = registrationsOf(plugin)

  assert.ok(found.size >= 3, `expected three contributions, found ${found.size}`)
  // A slot that draws words without declaring `locale` gets no `t` prop and
  // silently falls back to English in every language. That is how the composer
  // chips shipped: `github.com · selected text · 1234 chars` in a Chinese UI.
  for (const [name, entry] of found) {
    assert.equal(
      entry.options.locale,
      'browser-bridge',
      `${name} draws copy but its registration omits \`locale\`, so it never receives a translator`,
    )
  }
})

test('no text in the card is painted in the weakest label level', (t) => {
  // `--dsw-alias-label-tertiary` measures 3.71:1 against the card's own background
  // in the light theme, under the 4.5:1 that 12–13px text needs. The card used it
  // for every field value — the enabled state, the connection state, and the
  // 64-character token the reader has to compare against the extension options —
  // plus its note, its chip remove button, and its footer trigger. None of those
  // pixels had ever been measured, because this bundle only draws inside the DSH
  // app and the UI audit in `.tmp-run/` renders `extension/` pages.
  //
  // One rule is exempt and named here rather than inferred: the card description,
  // because the host paints its own card description with the same token at the
  // same size and measures the same ratio. Going heavier here would make this card
  // stand out from every sibling card rather than be more readable. The exemption
  // is counted so it cannot grow quietly.
  const EXEMPT = ['dshbb-card-description']
  assert.equal(EXEMPT.length, 1, 'the exempt list grew; was that deliberate?')

  const css = /const CSS = `([\s\S]*?)`/.exec(source)?.[1]
  assert.ok(css, 'the card stylesheet must be a template literal in this file')

  const offenders = []
  for (const match of css.matchAll(/\.([a-z-]+)\{([^}]*)\}/g)) {
    const [, name, body] = match
    if (!/color:var\(--dsw-alias-label-tertiary\)/.test(body)) continue
    if (EXEMPT.includes(name)) continue
    // A rule with no font-size inherits it, so it is still text unless it is
    // purely a shape — a dot or a border draws no glyphs.
    if (/font-size:/.test(body) || /line-height/.test(body)) offenders.push(`.${name}`)
  }
  assert.deepEqual(offenders, [],
    `these rules paint text in the faintest label level (3.71:1 in light): ${offenders.join(', ')}`)
})

test('no surface wider than the sidebar is pinned to a fixed width', (t) => {
  // The footer popover shipped as `width:330px` and the composer chip as
  // `max-width:340px`. Both are wider than a narrow sidebar, and neither had ever
  // been rendered: the popover only exists after a click, and the UI audit in
  // `.tmp-run/` renders `extension/` pages while this bundle draws inside the DSH
  // app. Measured in a 300px viewport, the popover ran 62px past the right edge
  // and the five field rows inside it went with it.
  //
  // The panel solved this shape in v36 with `min(<size>, calc(100vw - 24px))`,
  // and that is the pattern required here. A fixed width smaller than the margin
  // would technically fit, but it would waste the space on a wide sidebar, so the
  // rule is the clamp rather than a smaller number.
  const WIDE = ['dshbb-panel', 'dshbb-chip']
  assert.equal(WIDE.length, 2, 'a wide surface was added; give it the same clamp')

  const unclamped = []
  for (const name of WIDE) {
    const rule = new RegExp(`\\.${name}\\{([^}]*)\\}`).exec(source)
    assert.ok(rule, `.${name} must have a rule in the card stylesheet`)
    const body = rule[1]
    const declared = /(?:^|;)(width|max-width):(\d+)px/.exec(body)
    if (declared !== null) unclamped.push(`.${name} has a fixed ${declared[2]}px ${declared[1]}`)
    if (!/calc\(100vw\s*-\s*\d+px\)/.test(body)) {
      unclamped.push(`.${name} does not clamp to the viewport`)
    }
  }
  assert.deepEqual(unclamped, [],
    `these surfaces can overflow a narrow sidebar: ${unclamped.join('; ')}`)
})

test('every interactive control in the card is at least 24 by 24', (t) => {
  // WCAG 2.2 AA (2.5.8) puts the floor at 24x24 CSS pixels, and this card is the
  // one surface the UI audit in `.tmp-run/` cannot reach: the audit renders
  // `extension/` pages, while this bundle only ever draws inside the DSH app.
  // So the floor is held here, on the stylesheet, rather than measured.
  //
  // The list is the interactive selectors in `CSS`. It is counted so that adding
  // a fifth control forces a decision rather than slipping in unmeasured.
  const interactive = ['dshbb-trigger', 'dshbb-btn', 'dshbb-chip-x', 'dshbb-card-header']
  assert.equal(interactive.length, 4, 'a control was added to the card; give it a size check too')

  const tooSmall = []
  for (const name of interactive) {
    const rule = new RegExp(`\\.${name}\\{([^}]*)\\}`).exec(source)
    assert.ok(rule, `.${name} must have a rule in the card stylesheet`)
    const body = rule[1]

    // Height comes from an explicit size or from padding plus line-height. Both
    // shapes appear in this file, so take whichever the rule actually declares.
    const height = /min-height:(\d+(?:\.\d+)?)px/.exec(body)?.[1]
      ?? /height:(\d+(?:\.\d+)?)px/.exec(body)?.[1]
    const width = /min-width:(\d+(?:\.\d+)?)px/.exec(body)?.[1]
      ?? /width:(\d+(?:\.\d+)?)px/.exec(body)?.[1]

    // A control may derive its height from vertical padding when no explicit
    // height is set; the computed floor is then padding + one line box.
    const paddingY = /padding:(\d+(?:\.\d+)?)px/.exec(body)?.[1]

    if (height !== undefined && Number(height) < 24) tooSmall.push(`.${name} height ${height}px`)
    else if (height === undefined && paddingY !== undefined && Number(paddingY) * 2 + 18 < 24) {
      tooSmall.push(`.${name} padding-only height ${Number(paddingY) * 2 + 18}px`)
    }
    // Width only has to clear the floor on controls that are not full-width rows.
    if (width !== undefined && Number(width) < 24 && name !== 'dshbb-card-header') {
      tooSmall.push(`.${name} width ${width}px`)
    }
  }
  assert.deepEqual(tooSmall, [], `below the 24x24 floor: ${tooSmall.join(', ')}`)
})

test('the composer chip speaks the reader’s language', async (t) => {
  const { plugin, render, unmount } = loadPlugin()
  t.onCleanup(unmount)
  const chips = registrationsOf(plugin).get('conversation.input.dock')
  assert.ok(chips, 'the chips slot must register')

  // `origin` is a full origin, not a bare host: `describeAttachment` in
  // `lib/context.js` fills it with `new URL(input.url).origin`. A fixture that
  // passes `github.com` here takes the same branch as the real record and so
  // never exercises the scheme-stripping step — which is exactly how the chip
  // shipped reading `https://github.com · 选中内容 · 1234 字`.
  const restore = withGlobal('fetch', stagedAttachments([
    { id: 'a1', kind: 'selection', origin: 'https://github.com', chars: 1234, preview: '' },
  ]))
  try {
    const tree = await render(chips.component, { sessionId: 's1', t: zhT })
    const text = texts(tree).join('|')

    assert.match(text, /选中内容/, `the chip must name the kind in the reader's language, got: ${text}`)
    assert.match(text, /1234 字/, `the size must be localized too, got: ${text}`)
    assert.ok(!/selected text|chars/.test(text), `English leaked into a Chinese chip: ${text}`)
    // A pill names a site, so it must not carry a scheme. The host's own
    // describer strips it for the same reason.
    assert.ok(!text.includes('://'), `the chip must not show a scheme, got: ${text}`)
    assert.match(text, /github\.com/, `the chip must still name the host, got: ${text}`)

    const labels = propsIn(tree).map((props) => props['aria-label']).filter(Boolean)
    assert.ok(
      labels.some((label) => label.includes('从上下文移除')),
      `the remove button must be announced in the reader's language, got: ${labels.join(' | ')}`,
    )
    assert.ok(
      labels.every((label) => !/Remove from context/.test(label)),
      `English leaked into an aria-label: ${labels.join(' | ')}`,
    )
  } finally {
    restore()
  }
})

test('the chip falls back to the English dictionary, never to a bare key', async (t) => {
  // The other direction, and the reason `makeTranslator` exists: a slot that
  // receives no `t` at all must still show words rather than `chipSelection`.
  const { plugin, render, unmount } = loadPlugin()
  t.onCleanup(unmount)
  const chips = registrationsOf(plugin).get('conversation.input.dock')

  const restore = withGlobal('fetch', stagedAttachments([
    { id: 'a1', kind: 'page', origin: 'example.com', chars: 40, preview: '' },
  ]))
  try {
    const tree = await render(chips.component, { sessionId: 's1' })
    const text = texts(tree).join('|')
    assert.match(text, /page/, `a missing translator must fall back to English, got: ${text}`)
    assert.ok(!/chipSelection|chipPage|chipChars/.test(text), `a bare key reached the interface: ${text}`)
  } finally {
    restore()
  }
})

test('the footer status trigger speaks the reader’s language', async (t) => {
  const { plugin, render, unmount } = loadPlugin()
  t.onCleanup(unmount)
  const action = registrationsOf(plugin).get('sidebar.footer.action')
  assert.ok(action, 'the footer status action must register')

  const restore = withGlobal('fetch', async () => ({ ok: true, json: async () => ({ connected: true, enabled: true }) }))
  try {
    const tree = await render(action.component, { t: zhT })
    const text = texts(tree).join('|')
    assert.match(text, /浏览器/, `the trigger must speak the reader's language, got: ${text}`)
    assert.ok(!/browser:/.test(text), `English leaked into the trigger: ${text}`)
  } finally {
    restore()
  }
})

test('a limitation the extension reports reaches the popover as its own row', async (t) => {
  // `StatusAction` renders one row per `status.hello.limitations`, and that row
  // could not appear for two independent reasons at once. The extension's
  // greeting carried `{ version }` alone, so `limitations` was never in the
  // health payload at all; and the row took its label from `note`, which is the
  // paragraph under the fields, so even a present limitation rendered a
  // 1150px label inside a 308px row. `hello-wire.test.js` pins the first half
  // against the real service worker; this pins the second, which is only
  // visible once something renders.
  const { plugin, render, unmount } = loadPlugin()
  t.onCleanup(unmount)
  const action = registrationsOf(plugin).get('sidebar.footer.action')
  assert.ok(action, 'the footer status action must register')

  const limitation = 'File uploads require "Allow access to file URLs" on this extension’s details page.'
  const health = {
    connected: true,
    enabled: true,
    originRuleCount: 2,
    status: { connected: true, connections: 1, hello: { version: '0.5.0', limitations: [limitation] } },
  }
  const restore = withGlobal('fetch', async () => ({ ok: true, json: async () => health }))
  try {
    const tree = await render(action.component, { t: zhT })

    // The popover starts closed, so its rows must be opened to be examined —
    // asserting against a closed trigger would pass no matter what the panel
    // contains. The click comes from the component's own handler, so this opens
    // it the way a person does rather than by reaching into state.
    let trigger = null
    walk(tree, (node) => {
      if (String(node.props?.className ?? '').includes('dshbb-trigger')) trigger = node
    })
    assert.ok(trigger, 'the trigger must exist to open the popover')
    trigger.props.onClick()

    const opened = await render(action.component, { t: zhT })

    // The rows are `<Field>` elements. This renderer builds the element tree
    // without invoking function components, so a row's computed class name is
    // not in the tree — the node carries the props `Field` was called with, and
    // `Field` renders exactly `label` and `value` from those. Reading them here
    // is therefore reading the row, not a guess at one.
    const rows = []
    walk(opened, (node) => {
      if (typeof node.type === 'function' && node.props && 'label' in node.props) {
        rows.push({ label: node.props.label, value: node.props.value })
      }
    })

    assert.ok(
      rows.some((row) => String(row.value).includes('Allow access to file URLs')),
      `the reported limitation must appear as a row, got: ${JSON.stringify(rows)}`,
    )

    // The label must be a label. `note` is a full sentence, and reusing it here
    // put a paragraph in a label's slot — 1150px inside a 308px row.
    const limitationRow = rows.find((row) => String(row.value).includes('Allow access to file URLs'))
    assert.equal(
      limitationRow.label,
      '限制',
      `the row must carry its own short label rather than the note paragraph, got: ${limitationRow.label}`,
    )
  } finally {
    restore()
  }
})
