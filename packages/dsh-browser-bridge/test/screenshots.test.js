/**
 * The screenshots the README shows, and the tools that regenerate them.
 *
 * A README is where someone decides whether to install the thing, and until this
 * round it had **no images at all**: `git ls-files` showed eight tracked PNGs,
 * every one of them an extension icon. Twenty rounds of panel work — search,
 * approval, the model menu, High Contrast — were described in 2743 lines of
 * prose and visible in none of them.
 *
 * The failure mode this file guards is not "the screenshots are ugly". It is that
 * a README image rots silently: delete the file, rename it, move the directory,
 * and every renderer shows a broken-image box while every existing test stays
 * green. Nothing in the repository compared the README against the filesystem,
 * so nothing could notice.
 *
 *   - every image the README references exists, and is a real PNG rather than a
 *     placeholder or an LFS pointer;
 *   - every image the gallery declares has been generated, so the gallery and the
 *     directory cannot drift apart;
 *   - the gallery's scenarios still exist in the preview tool, because a
 *     screenshot of a state the panel can no longer reach is a claim about the
 *     product that quietly stopped being true.
 *
 * @module dsh-browser-bridge/test/screenshots
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assert, test } from './harness.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..', '..')
const SHOTS = join(root, 'docs', 'screenshots')

/** The 8-byte PNG signature, so a file is checked for being an image at all. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Every `src="..."` the README points at, as repo-relative paths. */
function readmeImages(readme) {
  return [...readme.matchAll(/<img\s+src="([^"]+)"/g)].map((match) => match[1])
}

/** The `file:` names the gallery declares, read without importing it. */
function galleryFiles(source) {
  return [...source.matchAll(/^\s*file: '([^']+)',$/gm)].map((match) => match[1])
}

/** The `scenario:` names the gallery declares. */
function galleryScenarios(source) {
  return [...source.matchAll(/^\s*scenario: '([^']+)',$/gm)].map((match) => match[1])
}

/** The `file:` names the poster tool declares. */
function posterFiles(source) {
  return [...source.matchAll(/^\s*file: '([^']+)',$/gm)].map((match) => match[1])
}

/** The `shot:` names the poster tool draws from, which must be gallery output. */
function posterShots(source) {
  return [...source.matchAll(/^\s*shot: '([^']+)',$/gm)].map((match) => match[1])
}

test('every screenshot the README shows is a real file', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const images = readmeImages(readme)

  // The project's own bar: the panel is the product, so the README has to show
  // it. A count assertion is what makes deleting the whole gallery a failure
  // rather than a README that is subtly poorer than it was.
  assert.ok(images.length >= 8, `the README shows ${images.length} images; the panel gallery was gutted`)

  const broken = []
  const notPng = []
  for (const relative of images) {
    const full = join(root, relative)
    if (!existsSync(full)) {
      broken.push(relative)
      continue
    }
    const head = readFileSync(full).subarray(0, PNG_MAGIC.length)
    if (!head.equals(PNG_MAGIC)) notPng.push(relative)
  }

  assert.deepEqual(broken, [], `the README references images that do not exist: ${broken.join(', ')}`)
  assert.deepEqual(notPng, [], `these README images are not PNGs: ${notPng.join(', ')}`)
})

test('every image the gallery declares has been generated', () => {
  const gallery = readFileSync(join(root, 'tools', 'gallery.mjs'), 'utf8')
  const declared = galleryFiles(gallery)
  assert.ok(declared.length >= 8, `the gallery declares ${declared.length} shots; expected the full set`)

  const missing = declared.filter((name) => !existsSync(join(SHOTS, name)))
  assert.deepEqual(missing, [], `these gallery shots are declared but not generated: ${missing.join(', ')}; run \`node tools/gallery.mjs\``)

  // A capture that drew nothing still writes a valid PNG, so size is checked as
  // well: a blank panel in the README is worse than a missing one, because it
  // looks deliberate.
  const blank = declared.filter((name) => statSync(join(SHOTS, name)).size < 8_000)
  assert.deepEqual(blank, [], `these gallery shots are too small to contain a rendered panel: ${blank.join(', ')}`)
})

test('every scenario the gallery names still exists in the preview tool', () => {
  // The screenshots are claims about reachable states. If a scenario is renamed
  // or removed, the image stays on disk and keeps making its claim, so the
  // gallery has to be checked against the tool that produces it rather than
  // trusted.
  const gallery = readFileSync(join(root, 'tools', 'gallery.mjs'), 'utf8')
  const preview = readFileSync(join(root, 'tools', 'preview.mjs'), 'utf8')

  const scenarios = new Set(galleryScenarios(gallery))
  assert.ok(scenarios.size >= 8, `the gallery names ${scenarios.size} scenarios; expected the full set`)

  const unknown = [...scenarios].filter((name) => !new RegExp(`^\\s{2}${name}: \\{`, 'm').test(preview))
  assert.deepEqual(unknown, [], `the gallery renders scenarios the preview tool does not define: ${unknown.join(', ')}`)
})

test('every poster the front page shows has been generated', () => {
  // The posters are the images a reader meets first, and they are the ones with
  // the furthest to fall: they are rendered by a second tool, from the gallery's
  // output, into a second directory. A missing one leaves a broken-image box at
  // the top of the README while every other test stays green.
  const posters = readFileSync(join(root, 'tools', 'poster.mjs'), 'utf8')
  const declared = posterFiles(posters)
  assert.ok(declared.length >= 3, `the poster tool declares ${declared.length} posters; expected the front-page set`)

  const missing = declared.filter((name) => !existsSync(join(root, 'docs', 'posters', name)))
  assert.deepEqual(missing, [], `these posters are declared but not generated: ${missing.join(', ')}; run \`node tools/poster.mjs\``)
})

test('every poster is drawn from a screenshot the gallery actually produces', () => {
  // A poster places a gallery PNG on a stage. Point it at a file the gallery no
  // longer writes and the tool fails at render time — but only for whoever next
  // runs it. This says so at test time, and names the file.
  const gallery = readFileSync(join(root, 'tools', 'gallery.mjs'), 'utf8')
  const posters = readFileSync(join(root, 'tools', 'poster.mjs'), 'utf8')

  const produced = new Set(galleryFiles(gallery))
  const used = posterShots(posters)
  assert.ok(used.length >= 3, `the poster tool draws from ${used.length} screenshots; expected the front-page set`)

  const unknown = used.filter((name) => !produced.has(name))
  assert.deepEqual(unknown, [], `the posters are drawn from files the gallery does not produce: ${unknown.join(', ')}`)
})

test('the preview tool keeps its scratch directory somewhere git ignores', () => {
  // The tool creates a Chrome profile next to itself and removes it on the way
  // out — so a run that is *killed* leaves it behind, and the process that knew
  // about it is the one that died. While the tool lived in `.tmp-run/`, the
  // repository's `.tmp-*` ignore rule covered that leak by accident. It moved to
  // `tools/` for the README, the rule stopped applying, and one cancelled probe
  // left an 11.6 MB directory that `git add -A` would have committed.
  //
  // Two things have to hold, and they fail independently: the directory must sit
  // under an ignored name, and the tool must reap what earlier runs abandoned.
  const ignore = readFileSync(join(root, '.gitignore'), 'utf8')
  const patterns = ignore.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'))
  assert.ok(patterns.includes('.tmp-*'), 'the ignore rule the scratch directory relies on is gone from .gitignore')

  const preview = readFileSync(join(root, 'tools', 'preview.mjs'), 'utf8')
  // The profile directory is built in two steps: a `.tmp-` parent anchored at
  // HERE, then the per-run directory inside it. Match that pair, not any
  // `join(HERE, ...)` — the tool has several, and the first one (`audit-in-page.js`)
  // is a file it reads, not scratch space.
  const parent = /const (\w+) = join\(HERE, '([^']+)'\)/.exec(preview)
  assert.ok(parent !== null, 'the preview tool no longer builds its scratch path with join(HERE, ...)')
  assert.ok(
    parent[2].startsWith('.tmp-'),
    `the preview tool's scratch directory is ${parent[2]}, which git does not ignore`,
  )
  assert.ok(
    new RegExp(`join\\(${parent[1]}, \`chrome-profile-`).test(preview),
    `the chrome profile is no longer created inside ${parent[1]}`,
  )
  // The *call*, not the name: matching `/reapOrphanProfiles\(/` would also hit the
  // function's own definition and stay green with the call deleted.
  assert.ok(
    /^\s+reapOrphanProfiles\(/m.test(preview),
    'the preview tool no longer collects profiles an interrupted run left behind',
  )
})

test('a screenshot is a function of the code, not of when it was taken', () => {
  // The working row animates, so two renders of that scene were *different
  // images* — the same code produced 100983 bytes one run and 101026 the next,
  // and they hashed differently. Both were "the product", which is the problem:
  // a picture that changes on its own cannot show a regression, because every
  // run is one, and every `node tools/gallery.mjs` churned the diff with byte
  // noise that no reviewer can read.
  //
  // The fix is to render what a reader who asked their system for less motion
  // sees. The panel already honours that setting — it drops the working row's
  // gradient for a flat colour — so this is a rendering the product genuinely
  // has, not a test-only mode.
  //
  // Two independent ways to lose that, so both are pinned: the emulated feature
  // must be `reduce` by default, and it must be wired into the media emulation
  // at all (a flag nothing reads is worse than no flag, because it looks fixed).
  const preview = readFileSync(join(root, 'tools', 'preview.mjs'), 'utf8')
  const fallback = /const reducedMotion = textOf\('reduced-motion', '([^']+)'\)/.exec(preview)
  assert.ok(fallback !== null, 'the preview tool no longer decides a reduced-motion value')
  assert.equal(
    fallback[1],
    'reduce',
    `the default render is '${fallback[1]}', so the working scene is not reproducible`,
  )
  assert.ok(
    /name: 'prefers-reduced-motion', value: reducedMotion/.test(preview),
    'the reduced-motion value is never handed to the browser, so the default does nothing',
  )
  // And the panel must keep the row readable under that setting: dropping the
  // gradient without naming a colour would render transparent text, which looks
  // exactly like a scene that legitimately has nothing to say.
  const html = readFileSync(join(root, 'extension', 'sidepanel.html'), 'utf8')
  const reduceBlock = /@media \(prefers-reduced-motion: reduce\) \{\s*\.working \{([^}]*)\}/.exec(html)
  assert.ok(reduceBlock !== null, 'the reduced-motion rule for the working row is gone')
  assert.ok(
    /color:\s*var\(--/.test(reduceBlock[1]),
    'the working row drops its gradient without naming a colour, so it renders invisible',
  )

  // A second, independent source of the same churn, found later and by accident:
  // the composer's caret. The textarea holds focus as the panel opens, so
  // Chromium blinks its insertion point on a wall-clock timer. Rendering the same
  // code four times gave 0, 0, 70 and 0 differing pixels — the 70 sitting in a
  // 17px-tall line at CSS (30, 645..662), which is that caret. Eight of the
  // fifteen scenes carried it, so `node tools/gallery.mjs` rewrote eight images
  // for no reason and the README's pictures depended on when they were taken.
  //
  // `prefers-reduced-motion` does not cover it — the blink is the browser's, not
  // an animation the panel declares — so it needs its own pin.
  assert.ok(
    /caret-color:\s*transparent\s*!important/.test(preview),
    'the caret blink is no longer pinned, so screenshots vary with the clock',
  )
  // Pinned by colouring the caret, not by dropping focus. Several scenes exist to
  // show what focus looks like (`#composer:has(textarea:focus-visible)` draws the
  // card ring), and a render that blurred focus would be a picture of a different
  // state rather than a stable picture of this one.
  assert.ok(
    /textarea,\s*input\s*\{\s*caret-color/.test(preview),
    'the caret is pinned on the wrong selector, so a scene with another field still flickers',
  )
})

test('the screenshots were rendered from the code that is here now', () => {
  // Every guard above asks whether an image *exists*. None asked whether it still
  // shows the product, and it stopped doing so: the commit that gave the answer
  // its reading measure changed the panel's layout and did not regenerate the
  // gallery, and neither did the three panel-style commits that followed.
  // `picture.png` spent four commits — 661756 differing pixels of 1094400 —
  // showing a layout the product no longer had, with this whole file green.
  //
  // Existence is not freshness. This recomputes the fingerprint from the working
  // tree here rather than reading the tool's own function, so a change to what
  // the gallery hashes cannot quietly keep both sides in agreement.
  const record = JSON.parse(readFileSync(join(SHOTS, 'SOURCES.json'), 'utf8'))
  const files = readdirSync(join(root, 'extension'))
    .filter((name) => name.endsWith('.js') || name.endsWith('.html') || name.endsWith('.css'))
    .map((name) => join(root, 'extension', name))
  files.push(join(root, 'tools', 'preview.mjs'))

  const hash = createHash('sha256')
  for (const file of files.sort()) {
    hash.update(file.slice(root.length).replaceAll('\\', '/'))
    hash.update('\0')
    hash.update(readFileSync(file))
    hash.update('\0')
  }
  const actual = hash.digest('hex')

  assert.equal(
    actual,
    record.fingerprint,
    'the panel or the preview tool changed since the screenshots were rendered — '
    + 'run `node tools/gallery.mjs` and commit the images with the change that moved them',
  )
  // The file list is asserted too, so a new extension file cannot join the panel
  // without the fingerprint covering it: a hash over a list that quietly shrank
  // is a hash that stops noticing.
  assert.deepEqual(
    record.files,
    files.map((file) => file.slice(root.length).replaceAll('\\', '/')),
    'the set of files the screenshots depend on changed',
  )
})

test('the header shrinks to fit a narrow panel instead of pushing controls off it', () => {
  // The panel's width is the reader's choice — Chrome's side panel can be dragged
  // from very narrow to very wide — so "it breaks at some width" is not an edge
  // case, it is a state a reader can create at any time. This repository had
  // already met two width defects by accident (a menu pinned at `min-width: 200px`
  // that hung 8px past the edge of a 200px panel; a reading-measure cap) and had
  // no criterion that swept the axis, which is why both were found by stumbling.
  //
  // This pins the two properties that carry the header at every width, both
  // proven load-bearing by mutation against a real browser:
  //
  //   - `#title { min-width: 0 }` — without it the four header items refuse to
  //     shrink and leave the panel entirely: measured at 200px, `#new` sat 67px
  //     past the right edge and `#find-open` 37px, so the two buttons a reader
  //     needs to start a chat or search for one were simply not on screen. A
  //     flex item's default `min-width: auto` floors it at its content width,
  //     which is the whole reason this line exists.
  //   - `#title-text` keeps `overflow: hidden` with an ellipsis — the title is
  //     the session's own text and can be any length, so the only stable layout
  //     is one that cuts it. Without the ellipsis the text still does not escape
  //     (the `min-width: 0` above absorbs it) but the cut is silent: the reader
  //     sees a title that just stops, with nothing saying more was there.
  const html = readFileSync(join(root, 'extension', 'sidepanel.html'), 'utf8')
  const header = ruleBody(html, 'header')
  assert.ok(header !== null, 'the panel no longer styles its header')

  const title = ruleBody(html, '#title')
  assert.ok(title !== null, 'the panel no longer styles the session title')
  assert.ok(
    /min-width:\s*0/.test(title),
    'the title can no longer shrink, so a narrow panel pushes the header controls off screen',
  )
  // `flex: 1` is what gives the title the leftover space; a fixed basis would
  // make it either overflow or leave a gap, depending on the title's length.
  assert.ok(
    /flex:\s*1\b/.test(title),
    'the title no longer takes the leftover width, so the header stops adapting',
  )

  const titleText = ruleBody(html, '#title-text')
  assert.ok(titleText !== null, 'the panel no longer styles the title text')
  assert.ok(
    /text-overflow:\s*ellipsis/.test(titleText),
    'a long session title is cut with no ellipsis, so the reader cannot tell it was cut',
  )
  assert.ok(
    /overflow:\s*hidden/.test(titleText),
    'the title text no longer clips, so it can spill over the icons beside it',
  )
  // The caret sits after the text inside the same flex row. It must not shrink,
  // or a long title squeezes the affordance down to a sliver.
  const caret = ruleBody(html, '#title .caret')
  assert.ok(caret !== null, 'the panel no longer styles the title caret')
  assert.ok(
    /flex:\s*none/.test(caret),
    'the caret can be squeezed by a long title, so the history affordance disappears',
  )
})

test('the preview tool can carry a real answer into the page, and does not invent one', () => {
  // A probe that asks "how long does the panel take to draw an answer" is only
  // answering a real question when the answer is one a person actually received.
  // A generated sample measures the structure its author thought of, which is the
  // one shape already known to work — measured across this machine's 11261
  // assistant messages, the median is 90 characters and the longest is 35159, so
  // the interesting cases are the ones a fixture would never contain.
  //
  // The reader's own text is read from a file rather than committed, because it is
  // their conversation. That makes the flag's plumbing load-bearing, and this is a
  // channel that fails *silently* in both directions: a flag never read leaves
  // `window.__realAnswers` undefined and the probe reports "no data" rather than
  // failing, and a flag that leaks into runs without it would make every other
  // probe measure a page carrying somebody's answers.
  const preview = readFileSync(join(root, 'tools', 'preview.mjs'), 'utf8')

  // The flag exists and reads the file it names.
  assert.ok(
    /rest\.indexOf\('--real-answers'\)/.test(preview),
    'the preview tool no longer accepts --real-answers, so no probe can measure a real answer',
  )
  assert.ok(
    /realAnswers = readFileSync\(resolve\(rest\[realIndex \+ 1\]\), 'utf8'\)/.test(preview),
    'the preview tool parses --real-answers but does not read the file it names',
  )

  // The read has to happen *before* `bootstrapSource` is called with the value.
  // Reading it later left the injection empty while the flag still parsed — the
  // exact silent failure this assertion exists for.
  const readAt = preview.indexOf("rest.indexOf('--real-answers')")
  const callAt = preview.indexOf('bootstrapSource(hostPort, scenario,')
  assert.ok(readAt !== -1 && callAt !== -1 && readAt < callAt, 'the real answers are read after the bootstrap script that carries them was already built')

  // And the value has to reach the page through the bootstrap's parameter, since
  // that function has its own scope.
  assert.ok(
    /function bootstrapSource\(port, scenario, tabUrl, realAnswers = ''\)/.test(preview),
    'bootstrapSource must take the real answers as a parameter; a free variable there is a ReferenceError at runtime',
  )

  // A run without the flag must inject nothing. The default is the guard: a
  // non-empty fallback would put sample text into every screenshot.
  assert.ok(
    /let realAnswers = ''\n/.test(preview),
    'the real answers must default to empty, or every run without the flag injects whatever came before',
  )
})

test('every floating surface can be opened and dismissed, so it never hides the conversation', () => {
  // Overlapping the page is what a floating surface is for; hiding a row the
  // reader can never uncover is the defect. This repository fixed that once — a
  // pill pinned over the scroller covered up to 24 characters of the row that
  // scrolled under it, permanently — so the distinction is recorded here: an
  // overlay is acceptable when the reader can dismiss it, and the way to say
  // that in markup is a real role.
  //
  // `role="menu"` / `role="listbox"` are the machine-readable form of "the
  // reader opened this and can close it". A floating layer with no role has no
  // such promise, which is exactly the state the two menus were in before this
  // was looked at.
  const html = readFileSync(join(root, 'extension', 'sidepanel.html'), 'utf8')
  const script = readFileSync(join(root, 'extension', 'sidepanel.js'), 'utf8')

  // The roles are applied by the code that fills the rows, not written in the
  // markup: an empty list has to give the role up, because a `listbox` whose only
  // child is a sentence makes a screen reader announce an option list that is not
  // there. So the assertion looks for the setter, not for a literal attribute.
  assert.ok(
    /setMenu\(false\)|closeMenu\(/.test(script),
    'the model menu can no longer be dismissed',
  )
  for (const [name, role] of [['modelMenu', 'menu'], ['atMenu', 'listbox']]) {
    assert.ok(
      new RegExp(`${name}\\.setAttribute\\('role', '${role}'\\)`).test(script),
      `${name} is never given role="${role}", so it is an overlay with no way to say it can be closed`,
    )
  }
})

/**
 * The declaration block for a selector, without any `@media` wrapper.
 *
 * Splitting on braces rather than matching with a regex: an at-rule's body
 * contains braces of its own, so a regex that stops at the first `}` returns
 * half a media query instead of the rule inside it.
 *
 * @param {string} source - The stylesheet text.
 * @param {string} selector - Exact selector to find.
 * @returns {string|null} The declarations, or null when the rule is absent.
 */
function ruleBody(source, selector) {
  const without = stripAtRules(source)
  const pattern = new RegExp(`(?:^|[},])\\s*${selector.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*\\{([^}]*)\\}`, 'm')
  const match = pattern.exec(without)
  return match === null ? null : match[1]
}

/**
 * Remove every at-rule body, keeping top-level rules only.
 *
 * @param {string} source - The stylesheet text.
 * @returns {string} The text with `@media`/`@supports` bodies removed.
 */
function stripAtRules(source) {
  let out = ''
  let index = 0
  while (index < source.length) {
    const at = source.indexOf('@', index)
    const brace = source.indexOf('{', index)
    if (brace === -1) { out += source.slice(index); break }
    if (at !== -1 && at < brace) {
      // Copy up to the at-rule, then skip its whole body by counting braces
      out += source.slice(index, at)
      let depth = 0
      let cursor = brace
      for (; cursor < source.length; cursor += 1) {
        if (source[cursor] === '{') depth += 1
        else if (source[cursor] === '}') {
          depth -= 1
          if (depth === 0) { cursor += 1; break }
        }
      }
      index = cursor
    } else {
      const close = source.indexOf('}', brace)
      if (close === -1) { out += source.slice(index); break }
      out += source.slice(index, close + 1)
      index = close + 1
    }
  }
  return out
}
