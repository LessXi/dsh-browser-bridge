/**
 * Static checks on the side panel's copy, layout and scroll rule.
 *
 * The panel was English-only inside a Chinese UI, and the fix is only durable if
 * a regression fails a test rather than waiting for someone to notice a stray
 * "Reload" in a screenshot. Five things are checked, in increasing order of how
 * much they would catch:
 *
 *   1. the two dictionaries have the same keys, so neither can drift;
 *   2. every `t()` key the panel uses exists, so a typo is a failure and not a
 *      key rendered literally into the UI;
 *   3. no literal UI text is left in either file — checked structurally for the
 *      HTML, and by assignment target for the script;
 *   4. no dictionary entry is a *sentence*. The complaint that produced this
 *      rewrite was that the panel was mostly explanation, so "short enough to be
 *      a label" is a property a test can hold;
 *   5. the transcript restores its scroll position on a redraw that happens
 *      while somebody is reading further up, which is the bug that was reported
 *      as "我想看上面的内容，它就自己滚下去了".
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assert, test } from './harness.js'
import { DICTIONARIES, en, options, optionsTranslator, pickLocale, relativeTime, translator, zh } from '../../../extension/locales.js'

const here = dirname(fileURLToPath(import.meta.url))
const extensionDir = join(here, '..', '..', '..', 'extension')

/** @param {string} name - A file in `extension/`. @returns {string} Its text. */
function readExtensionFile(name) {
  return readFileSync(join(extensionDir, name), 'utf8')
}

/** The English translator, for the label tests below. */
const t_en = translator('en')

test('the dictionaries carry the same keys, and neither is empty', (t) => {
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  assert.ok(zhKeys.length > 30, `expected a real dictionary, got ${zhKeys.length} keys`)
  assert.deepEqual(zhKeys, enKeys)
  assert.deepEqual(Object.keys(DICTIONARIES).sort(), ['en', 'zh'])
})

test('every t() key the panel uses exists in both dictionaries', (t) => {
  const used = new Set([
    ...readExtensionFile('sidepanel.js').matchAll(/\bt\(\s*'([^']+)'/g),
    // `relativeTime` builds its labels from the same translator, so its keys are
    // the panel's keys too.
    ...readExtensionFile('locales.js').matchAll(/\bt\(\s*'([^']+)'/g),
  ].map((match) => match[1]))
  assert.ok(used.size > 20, `expected the panel to be localized, found ${used.size} keys`)

  const missing = [...used].filter((key) => !(key in zh) || !(key in en))
  assert.deepEqual(missing, [])
})

test('no dictionary entry is a sentence', (t) => {
  // A label says what a control does or what a thing is. Anything longer is the
  // explanatory copy this rewrite removed, and it is the reason a 360px panel
  // read as a help page. The original Codex side panel has no hint/description/
  // helper style class at all, which is the same rule from the other direction.
  //
  // One surface is exempt, and it is named here rather than inferred so the rule
  // keeps its teeth everywhere else: the blocked pane. When the panel cannot work
  // at all, the sentence *is* the content — the original does the same thing in
  // its status surface ("Install the app to use ChatGPT in {browser}"), and a
  // label there would say nothing. The list is counted so it cannot grow quietly.
  const ALLOWED = [
    'blocked.hostTitle',
    'blocked.hostBody',
  ]
  assert.equal(ALLOWED.length, 2, 'the exempt list grew; was that intentional?')

  const offenders = []
  for (const [locale, dictionary] of Object.entries(DICTIONARIES)) {
    for (const [key, value] of Object.entries(dictionary)) {
      if (ALLOWED.includes(key)) continue
      const words = value.replace(/\{[^}]*\}/g, ' ').trim().split(/\s+/).filter(Boolean)
      if (words.length > 6) offenders.push(`${locale}:${key} has ${words.length} words`)
      if (/\.\s|\u3002/.test(value) || /\.$/.test(value)) offenders.push(`${locale}:${key} is punctuated as a sentence`)
    }
  }
  assert.deepEqual(offenders, [])
})

test('no literal UI text is left in the panel HTML', (t) => {
  const stripped = readExtensionFile('sidepanel.html')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<style>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    // The document title is a brand name, not copy: it is what a tab shows
    // before any script has run, and `paintStaticCopy` overwrites it.
    .replace(/<title>[\s\S]*?<\/title>/gi, '')
    .replace(/<[^>]*>/g, '')
    .trim()
  // Glyphs are controls (the title's chevron), not copy. Anything word-shaped
  // left behind is a string that escaped the dictionaries.
  const words = stripped.replace(/[^\p{L}\p{N}]/gu, '')
  assert.equal(words, '', `the HTML still carries copy: ${JSON.stringify(stripped.slice(0, 120))}`)
})

test('the panel assigns no literal sentences to user-visible fields', (t) => {
  const assignments = [
    ...readExtensionFile('sidepanel.js').matchAll(/\.(textContent|placeholder|innerText|title|aria-label)\s*=\s*'([^']*)'/g),
  ].map((match) => match[2])
  // A single glyph is a control, not copy: the chevrons, the send arrow, the
  // status marks, the chip's remove cross. Anything word-shaped has to come from
  // a dictionary.
  const words = assignments.filter((value) => /[A-Za-z\u4e00-\u9fff]{2,}/.test(value))
  assert.deepEqual(words, [])
})

test('every element the panel reaches for exists in its HTML', (t) => {
  // The panel is a plain page with no build step, so a renamed id is a silent
  // `null` at runtime and a blank control on screen. This is the cheapest
  // possible guard against that.
  const html = readExtensionFile('sidepanel.html')
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]))
  const wanted = [...readExtensionFile('sidepanel.js').matchAll(/getElementById\('([^']+)'\)/g)]
    .map((match) => match[1])
  assert.ok(wanted.length > 8, `expected the panel to bind real elements, found ${wanted.length}`)
  assert.deepEqual(wanted.filter((id) => !ids.has(id)), [])
  assert.ok(ids.has('stage'), 'the transcript and history share a positioned stage')
})

test('the retired keys and the retired copy are gone', (t) => {
  // The keys, not the values: a value can legitimately reappear under a new name
  // (`未连接` is now the attachment chip's offline label, not a header status).
  const retiredKeys = [
    'state.connected', 'state.connecting', 'state.disconnected', 'state.title',
    'tabs.heading', 'tabs.count', 'tabs.none.short', 'tabs.grouped',
    'session.label', 'session.title', 'session.none', 'session.option.none',
    'role.you', 'role.model', 'role.system',
    'context.attached', 'context.hint',
    'empty.noSession', 'empty.noMessages', 'empty.coldLoading',
    'toast.sent', 'toast.reloaded', 'toast.reloadFailed', 'toast.sendFailed',
    'toast.noSession', 'toast.pickTextFirst', 'toast.selectionStaged',
    'toast.tabStaged', 'toast.stageFailed', 'toast.startedFailed', 'toast.contextDropped',
    'panel.subtitle', 'action.reload', 'action.reload.title',
  ]
  const present = retiredKeys.filter((key) => key in zh || key in en)
  assert.deepEqual(present, [], 'these keys were removed by the v4 rewrite')

  const files = [readExtensionFile('sidepanel.js'), readExtensionFile('sidepanel.html')]
  const retiredCopy = [
    "'Reload'", "'Send'", "'Ask about this page", '"Add this page to context"',
    "'PAGE AND CONNECTION'", "'Page and connection'", "'Automatic sync'",
    "'No messages in this session yet", "'No tabs grouped for DSH yet",
    "'Highlight text on the page", "'Controlled tabs'", "'Connection to DSH'",
    '将附带', '发送时会带上', '看受控标签页',
  ]
  for (const text of retiredCopy) {
    for (const [index, source] of files.entries()) {
      assert.ok(!source.includes(text), `${index === 0 ? 'sidepanel.js' : 'sidepanel.html'} still contains ${text}`)
    }
  }
})

test('the panel no longer owns an auto-sync switch', (t) => {
  // The switch duplicated the options page; whether a highlight becomes context
  // is decided there, and by the host's own master switch.
  for (const name of ['sidepanel.js', 'sidepanel.html']) {
    const text = readExtensionFile(name)
    assert.ok(!text.includes('autoPushSelection'), `${name} still reads the auto-push setting`)
    assert.ok(!text.includes('autopush'), `${name} still has an auto-push control`)
  }
})

test('the transcript restores its scroll position instead of always following', (t) => {
  const source = readExtensionFile('sidepanel.js')
  assert.ok(source.includes('const NEAR_BOTTOM_PX = 24'), 'the near-bottom threshold is part of the design')
  assert.ok(
    source.includes('transcript.scrollTop = keep'),
    'a redraw while somebody is reading further up must put the position back',
  )
  assert.ok(
    source.includes('const followed = stickToBottom'),
    'whether to follow is decided before the redraw, not after it',
  )
  // The old panel's defect, in one line: an unconditional jump to the end after
  // rebuilding the list.
  assert.ok(
    !/replaceChildren\([^)]*\)\s*\n\s*transcript\.scrollTop = transcript\.scrollHeight/.test(source),
    'the redraw must not be followed by an unconditional scroll to the end',
  )
})

test('the panel reads its connection state from names that mean what they say', (t) => {
  const source = readExtensionFile('sidepanel.js')
  // `connected` on the health route means the *service worker* holds a socket to
  // the host. Reading it as "the panel is disconnected" is what put a red
  // 未连接 in the header of a panel that was listing sessions fine.
  assert.ok(!source.includes('connectionState'), 'the header no longer owns a connection state')
  assert.ok(source.includes('bridgeConnected'), 'the attachment chip owns it instead')
  assert.ok(source.includes("'/browser-bridge/health'"), 'and it comes from the health route')
  assert.ok(
    source.includes('payload?.connected === true'),
    'and from the host’s own answer about this extension',
  )
  assert.ok(
    !/^\s*bridgeConnected = false\s*$/m.test(source),
    'it must never be assigned a constant — a chip that always says 未连接 is worse than no chip',
  )
})

test('a host older than the panel is named, not shown as an empty list', (t) => {
  // The extension reloads with one click; the host is replaced by restarting
  // `dsh web`. When the two disagree every route answers a shape this panel does
  // not understand, which would otherwise read as "no sessions yet" plus a bare
  // HTTP 400 from the new-chat button.
  const source = readExtensionFile('sidepanel.js')
  assert.ok(source.includes('hostStale'), 'the panel tracks the shape mismatch')
  assert.ok(source.includes('Array.isArray(payload?.groups)'), 'and detects it by the missing groups')
  assert.ok('error.restartHost' in zh && 'error.restartHost' in en, 'and can say what to do about it')
})

test('the locale picker and the translator behave as documented', (t) => {
  assert.equal(pickLocale('zh-CN'), 'zh')
  assert.equal(pickLocale('zh'), 'zh')
  assert.equal(pickLocale('ZH-Hans'), 'zh')
  assert.equal(pickLocale('en-US'), 'en')
  assert.equal(pickLocale(''), 'en')
  assert.equal(pickLocale(undefined), 'en')

  assert.equal(translator('zh')('action.send'), zh['action.send'])
  assert.equal(translator('en')('action.send'), en['action.send'])
  // Parameters are substituted, and an unknown name is left visible rather than
  // silently becoming "undefined" or an empty string.
  assert.equal(translator('en')('time.minutes', { count: 3 }), '3m ago')
  assert.equal(translator('en')('time.minutes', {}), '{count}m ago')
  // A key that exists in neither dictionary renders as the key: a visible bug.
  assert.equal(translator('zh')('nope.not.a.key'), 'nope.not.a.key')
})

test('relative time uses the coarsest unit that still reads as recent', (t) => {
  const now = 1_700_000_000_000
  assert.equal(relativeTime(t_en, now - 30_000, now), 'just now')
  assert.equal(relativeTime(t_en, now - 5 * 60_000, now), '5m ago')
  assert.equal(relativeTime(t_en, now - 5 * 3600_000, now), '5h ago')
  assert.equal(relativeTime(t_en, now - 3 * 86_400_000, now), '3d ago')
  assert.equal(relativeTime(t_en, 0, now), '')
  assert.equal(relativeTime(t_en, Number.NaN, now), '')
})

test('every dictionary entry is free of placeholder spelling mistakes', (t) => {
  const problems = []
  for (const [locale, dictionary] of Object.entries(DICTIONARIES)) {
    for (const [key, value] of Object.entries(dictionary)) {
      if (value.trim().length === 0) problems.push(`${locale}:${key} is empty`)
      // The translator's substitution syntax is `{name}`; a stray lone brace is
      // almost always a typo that renders literally.
      const braces = (value.match(/\{/g) ?? []).length
      const closes = (value.match(/\}/g) ?? []).length
      if (braces !== closes) problems.push(`${locale}:${key} has unbalanced braces`)
    }
  }
  assert.deepEqual(problems, [])
})

test('the model picker is wired to the module that decides its contents', (t) => {
  const script = readExtensionFile('sidepanel.js')
  // Importing the module is the only thing that connects the two halves, and a
  // picker that quietly stops being drawn is the failure this catches: the panel
  // has no other symptom, because nothing errors when a control is simply absent.
  assert.match(script, /from '\.\/model-menu\.js'/)
  for (const name of ['refreshCatalog', 'drawModel', 'drawModelMenu', 'setMenu', 'chooseModel']) {
    assert.match(script, new RegExp(`function ${name}\\b`), `${name} must exist in the panel`)
  }
  const html = readExtensionFile('sidepanel.html')
  assert.match(html, /id="model-menu"/)
  // It belongs to the composer's own bar — the model is a property of the next
  // send, not of the conversation being read, so it must not drift up to the header.
  assert.match(html, /class="composer-bar"[\s\S]{0,400}id="model"/)
  // And the old one-row composer must be gone, or the bar would render beside the
  // textarea rather than under it.
  assert.equal(/<div id="composer">\s*<textarea[^>]*><\/textarea>\s*<button id="send"/.test(html), false)
})

test('the menu module reports a code and leaves every word to the panel', (t) => {
  const source = readExtensionFile('model-menu.js')
  assert.match(source, /'empty-catalog'/)
  // It cannot reach the panel's translator, so a sentence baked in here would
  // render English inside a Chinese panel. `\b` keeps this from tripping over
  // helper names like `asText(`.
  assert.equal(/\bt\(['"]/.test(source), false, 'the menu module must not translate')
})

test('the copy affordance is wired on both sides of the DOM', () => {
  // The panel tests drive a DOM with no CSS engine, so a class the renderer
  // emits and the stylesheet never defines renders as a working button there
  // and as an invisible one in Chrome — and `.copy` is reached by delegation,
  // which means a rename on either side fails silently rather than loudly.
  const html = readExtensionFile('sidepanel.html')
  const markdown = readExtensionFile('markdown.js')
  const script = readExtensionFile('sidepanel.js')

  assert.match(markdown, /className = 'code-block'/, 'the renderer no longer builds a code card')
  assert.match(markdown, /dataset\.copy = 'code'/)
  assert.match(script, /copy\.dataset\.copy = 'answer'/, 'the answer has no copy button')
  assert.match(script, /navigator\?\.clipboard/, 'the panel no longer uses the async clipboard')

  for (const selector of ['.code-block', '.code-head', '.code-lang', '.answer-actions']) {
    assert.ok(html.includes(selector), `sidepanel.html never styles ${selector}`)
  }
  assert.ok(html.includes(".copy[data-state='copied']"), 'a finished copy would show no feedback')
  assert.ok(
    html.includes(".row[data-kind='assistant']:hover .answer-actions"),
    'the answer button is never revealed, so it cannot be clicked',
  )
  assert.match(html, /^\s*\.copy \{/m, 'the delegated target has to be styled under exactly that name')
})

test('the reading column is capped, so a wide panel does not stretch prose', (t) => {
  // Measured before this: at a 1000px panel one paragraph box was 832px wide,
  // which is past the point where the eye loses the start of the next line. The
  // official panel caps the same thing at `--thread-content-max-width`, whose
  // desktop value is `48rem`.
  const html = readExtensionFile('sidepanel.html')
  assert.match(html, /--thread-content-max-width:\s*48rem/, 'the column has no width cap')
  assert.ok(
    /#transcript > \* \{[^}]*max-width: var\(--thread-content-max-width\)/.test(html.replace(/\n\s*/g, ' ')),
    'the cap is declared but never applied to the rows',
  )
  // Centred rather than left-aligned: a column pinned to the left of a very wide
  // panel leaves the empty space all on one side and reads as a rendering fault.
  assert.ok(
    /#transcript > \* \{[^}]*margin-inline: auto/.test(html.replace(/\n\s*/g, ' ')),
    'the column hugs the left edge instead of centring',
  )
})

test('the palette colours clear AA in both schemes, not just the light one', (t) => {
  // The panel flips with `color-scheme: light dark`, and every colour except
  // these three is a `color-mix` of `CanvasText`, so it flips for free. A single
  // hardcoded value cannot clear WCAG AA for small text on both a white and a
  // near-black Canvas: `--bad: #d1453b` measured 4.54 on light and 3.79 on dark,
  // and the failure rows it colours are 12-13px.
  const html = readExtensionFile('sidepanel.html')
  const token = (name) => {
    const found = new RegExp(`--${name}:\\s*light-dark\\(([^)]+)\\)`).exec(html)
    assert.ok(found, `--${name} is not scheme-aware`)
    return found[1].split(',').map((part) => part.trim())
  }
  const srgb = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  const lum = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b)
  const hex = (value) => [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16))
  const ratio = (a, b) => {
    const [hi, lo] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)]
    return (hi + 0.05) / (lo + 0.05)
  }
  // Chrome's two Canvas values, which the panel draws on.
  const CANVAS = { light: hex('#ffffff'), dark: hex('#1b1b1d') }
  for (const name of ['accent', 'ok', 'bad', 'on-accent']) {
    const [light, dark] = token(name)
    // `on-accent` is drawn ON the accent fill, so it is measured against that.
    const against = name === 'on-accent'
      ? { light: hex(token('accent')[0]), dark: hex(token('accent')[1]) }
      : CANVAS
    for (const scheme of ['light', 'dark']) {
      const got = ratio(hex(scheme === 'light' ? light : dark), against[scheme])
      assert.ok(got >= 4.5, `--${name} in ${scheme} is ${got.toFixed(2)}, below AA for small text`)
    }
  }
})

test('the options page keeps its palette in one place, and it flips', (t) => {
  // The options page hit the same defect as the panel: it declares
  // `color-scheme: light dark`, so a hex written at the point of use is the only
  // thing that can fail in one scheme. Measured before this: the warning stripe
  // was 2.50 against a white Canvas, below the 3.0 a border needs.
  const html = readExtensionFile('options.html')
  const root = /:root \{([\s\S]*?)\}/.exec(html)
  assert.ok(root, 'the options page has no :root block to hold its palette')
  // Every hex must live in the token block, and each must be scheme-aware.
  const body = html.replace(root[0], '')
  const strays = body.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
  assert.deepEqual(strays, [], 'a colour is written at the point of use instead of as a token')
  for (const name of ['accent', 'on-accent', 'ok', 'bad', 'warn']) {
    assert.match(root[1], new RegExp(`--${name}:\\s*light-dark\\(`), `--${name} does not flip with the scheme`)
  }
  // And the tokens are actually consumed, or they are decoration.
  for (const name of ['accent', 'on-accent', 'ok', 'bad', 'warn']) {
    assert.ok(body.includes(`var(--${name})`), `--${name} is declared but never used`)
  }
})

test('a short panel keeps both a conversation and a composer', (t) => {
  // Measured before this: at a 260px-tall panel, `stage=392x0` while the chip row
  // and composer kept their full height — the conversation was gone. Flooring the
  // stage alone then collapsed the footer to 10px and the composer with it, so
  // the panel could be read but not typed into. Both floors have to exist, and
  // the body has to be the scroller that absorbs the remainder.
  const html = readExtensionFile('sidepanel.html').replace(/\n\s*/g, ' ')
  assert.match(html, /#stage \{[^}]*min-height: 96px/, 'the stage has no floor and can reach zero')
  assert.match(html, /#stage \{[^}]*flex: 1 1 0/, 'a content-sized basis makes the stage steal height from the footer')
  assert.match(html, /#composer \{[^}]*flex: none/, 'the composer can shrink away')
  assert.match(html, /body \{[^}]*overflow-y: auto/, 'nothing absorbs the shortfall, so the send key gets clipped')
  // Declared once. There were briefly two `#composer` blocks, and the earlier
  // `{ flex: none; }` satisfied this assertion while the later, fuller rule — the
  // one that actually wins — was free to shrink. Falsifying the composer's floor
  // passed because of it, which is how the duplicate was found.
  assert.equal(
    (html.match(/#composer \{/g) ?? []).length,
    1,
    'the composer is declared more than once, so one rule can be shadowed',
  )
  // And the very short case lowers the floor rather than hiding anything: the
  // chip row is the only place that answers "will my highlight be sent?", so
  // dropping it would be trading a layout bug for a trust bug.
  assert.match(html, /@media \(max-height: 340px\)/, 'the short-panel case is not handled')
  assert.ok(
    !/@media \(max-height: 340px\)[^}]*\{[^}]*#contexts \{ display: none/.test(html),
    'the chip row is hidden on a short panel',
  )
})

test('the composer fits a narrow panel instead of overflowing it', (t) => {
  // Measured on a 240px panel: the footer's content came to 252px while the
  // footer was 240px, and the 12px was `#model`'s intrinsic width. A flex item
  // refuses to shrink below its content without `min-width: 0`, so the
  // `max-width: 224px` on that button did nothing and the `text-overflow` on the
  // label inside it never engaged — the overflow simply ran off the panel edge.
  const html = readExtensionFile('sidepanel.html').replace(/\n\s*/g, ' ')
  assert.match(html, /#model \{[^}]*min-width: 0/, '#model cannot shrink, so it overflows a narrow panel')
  assert.match(html, /#model \{[^}]*flex: 0 1 auto/, '#model is not shrinkable in its bar')
  // The text inside has to be the thing that gives, and it needs a basis to
  // shrink against.
  assert.match(html, /#model-text \{[^}]*text-overflow: ellipsis/, 'the model name has no ellipsis')
})

test('no dictionary entry is dead weight', () => {
  // A key nothing reads is either a leftover from a control that was removed
  // (the header's reload button) or a label that was meant to be wired and
  // never was — which is how the running dot stayed unlabelled. Every key is
  // reached through a literal `t('…')`, and `relativeTime` builds its own from
  // inside `locales.js`, so that file is part of the search.
  const names = [
    'locales.js', 'sidepanel.js', 'failure.js', 'background.js', 'options.js',
    'markdown.js', 'model-menu.js', 'content-selection.js', 'page-distill.js',
  ]
  const sources = names.map((name) => readExtensionFile(name)).join('\n')
  const used = new Set([...sources.matchAll(/\bt\(\s*'([^']+)'/g)].map((match) => match[1]))
  const dead = Object.keys(zh).filter((key) => !used.has(key))
  assert.deepEqual(dead, [], 'these keys are defined and never read')
})

test('the options page carries no copy of its own, and every key it names exists', () => {
  // The options page is the gate someone passes to paste the token at all, so
  // leaving it in one language while the panel speaks another was the largest
  // remaining hole. It reads its copy from `data-i18n`, which means two things
  // are worth holding: the markup holds no English, and every name in it is real.
  const html = readExtensionFile('options.html')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<style>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<title>[\s\S]*?<\/title>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
  const words = html.split(/\s+/).filter((word) => /[A-Za-z]{2,}/.test(word))
  assert.deepEqual(words, [], 'the options markup still carries literal copy')

  const named = [...readExtensionFile('options.html').matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1])
  assert.ok(named.length >= 20, `expected a localized page, found ${named.length} named nodes`)
  const missing = named.filter((key) => !(key in options.zh) || !(key in options.en))
  assert.deepEqual(missing, [], 'the markup names keys the dictionary does not have')

  // And the other direction: a key nothing draws is either a leftover or a
  // string someone meant to wire and never did. Keys used at run time (the probe
  // results, in `options.js`, and the context menu, in `background.js`) are not
  // in the markup, so the scripts count too.
  const drawn = new Set([
    ...named,
    ...[...readExtensionFile('options.js').matchAll(/say\(\s*'([^']+)'/g)].map((m) => m[1]),
    ...[...readExtensionFile('background.js').matchAll(/menuSay\(\s*'([^']+)'/g)].map((m) => m[1]),
  ])
  const dead = Object.keys(options.zh).filter((key) => !drawn.has(key))
  assert.deepEqual(dead, [], 'these options keys are defined and never drawn')
})

test('the right-click menu is localized, not English inside Chrome', () => {
  // These rows are drawn by Chrome on every page, in front of whatever the person
  // was reading, so English here was the last surface in one language only.
  const source = readExtensionFile('background.js')
  const titles = [...source.matchAll(/title:\s*(?:menuSay\('([^']+)'\)|'([^']{4,})')/g)]
  const english = titles.filter((match) => match[2] !== undefined).map((match) => match[2])
  assert.deepEqual(english, [], 'a context-menu row still carries fixed English')
  assert.ok(titles.length >= 4, `expected four localized menu rows, found ${titles.length}`)
})

test('the two options dictionaries carry the same keys', () => {
  assert.deepEqual(Object.keys(options.zh).sort(), Object.keys(options.en).sort())
  // The panel's rule is that an entry is a label, and it stays scoped to the
  // panel: this page is read once, sitting still, and its warning is the point.
  const t = optionsTranslator('zh')
  assert.equal(t('save'), '保存并连接')
  assert.equal(t('cannotConnect', { port: '3080' }), '连不上 3080 端口。')
  assert.equal(optionsTranslator('en')('missing.key'), 'missing.key')
})
