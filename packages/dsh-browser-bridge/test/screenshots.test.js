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

test('the preview host answers every action the real host does', () => {
  // The preview's fake host is an instrument, and an instrument that answers a
  // different set of questions than the real host reports a defect where there is
  // none. That has now happened twice, in the same file:
  //
  //   - `chrome.storage.local.remove` was missing, so every step of a send after
  //     it silently never ran (see the storage check below).
  //   - the `approval` action had no branch, so answering a card fell through to
  //     the catch-all and came back as a bare `{}`. The panel, correctly, treats
  //     anything but `answered: true` as a failure — so the reader allowed a tool
  //     once and was told 「没能作答：HTTP 200」. The request had succeeded.
  //
  // Both were invisible to the suite, because neither is a panel defect: the panel
  // was right both times, and only the measurement was wrong.
  //
  // The assertion is set equality between the two hosts' branches, so adding an
  // action to one and not the other fails here rather than being discovered later
  // as a phantom failure on screen.
  const real = readFileSync(join(root, 'packages', 'dsh-browser-bridge', 'lib', 'index.js'), 'utf8')
  const preview = readFileSync(join(root, 'tools', 'preview.mjs'), 'utf8')

  const actions = (source) => new Set(
    [...source.matchAll(/parsed\.action === '([a-z-]+)'/g)].map((match) => match[1]),
  )

  const realActions = actions(real)
  const previewActions = actions(preview)
  assert.ok(realActions.size >= 6, `only ${realActions.size} actions found in the real host; this check has gone stale`)

  const missing = [...realActions].filter((action) => !previewActions.has(action)).sort()
  assert.deepEqual(
    missing,
    [],
    `the preview's fake host does not answer ${missing.join(', ')}, so those requests fall through to its catch-all and every probe that exercises them measures the wrong thing`,
  )
  const extra = [...previewActions].filter((action) => !realActions.has(action)).sort()
  assert.deepEqual(
    extra,
    [],
    `the preview answers ${extra.join(', ')}, which the real host does not: a probe would be measuring a host that does not exist`,
  )
})

test('the preview host answers every chrome.storage method the panel calls', () => {
  // The panel calls `get`, `set` and `remove`. The preview's fake host had the
  // first two, and the third was missing — which is a small omission with a large
  // effect, because `clearDraft` removes the saved draft *after* the host has
  // accepted a send. The missing method threw there, so every step after it
  // silently never ran: the composer kept its text, the mention stayed attached,
  // and the message the reader had just sent was never drawn. Sending looked
  // broken in the preview while it worked in Chrome, and the 712-test suite could
  // not see it, because the *test* double implements all three.
  //
  // So the assertion is parity between the two doubles and the panel's usage. A
  // stub is an instrument, and an instrument that answers two of three questions
  // is one that reports a defect where there is none — or, as here, hides the
  // behaviour being measured.
  const script = readFileSync(join(root, 'extension', 'sidepanel.js'), 'utf8')
  const used = new Set([...script.matchAll(/chrome\.storage\.local\.(\w+)\(/g)].map((match) => match[1]))
  assert.ok(used.size > 0, 'the panel no longer calls chrome.storage.local at all; this check has gone stale')
  assert.deepEqual(
    [...used].sort(),
    ['get', 'remove', 'set'],
    `the panel now calls ${[...used].sort().join(', ')} on chrome.storage.local; update this expectation deliberately rather than by accident`,
  )

  const preview = readFileSync(join(root, 'tools', 'preview.mjs'), 'utf8')
  for (const method of used) {
    assert.ok(
      new RegExp(`\\b${method}: async`).test(preview),
      `the preview's fake chrome.storage.local has no ${method}(), so anything the panel does after calling it is invisible to every probe`,
    )
  }

  // And the test double, which is the one that *did* have it — kept in the same
  // check so the two cannot drift apart in opposite directions next time.
  const stream = readFileSync(join(here, 'panel-stream.test.js'), 'utf8')
  for (const method of used) {
    assert.ok(
      new RegExp(`\\b${method}: async`).test(stream),
      `the test double has no ${method}(), so the panel's behaviour after that call is untestable`,
    )
  }
})

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

test('the audit runner aims at the tool that is actually here', () => {
  // The runner reads its scenario list from `preview.mjs --list`, so it is always
  // in step with the tool it runs — that much was fixed by making the list derived
  // rather than hand-written.
  //
  // What was not fixed is *which* `preview.mjs` it ran. The runner used to live in
  // the scratch directory and resolve the tool as a sibling there, and a copy of the
  // tool had been left behind when the real one moved into `tools/`. So it ran a
  // preview twenty-one versions old and reportable findings came out of it that the
  // real tool does not produce — `div.working` at `ratio: 1` in a transparent colour,
  // because the old tool had no `--reduced-motion` and the row kept its sweep
  // animation.
  //
  // Asserting the shape of the path is the point: a runner pointed at a stale copy
  // is indistinguishable from a product defect, and nothing else here would notice.
  const runner = readFileSync(join(root, 'tools', 'audit.mjs'), 'utf8')
  assert.ok(
    /const PREVIEW = join\(HERE, 'preview\.mjs'\)/.test(runner),
    'the audit runner no longer resolves the preview tool as its own sibling, which is what keeps it from running a stale copy',
  )
  assert.ok(
    !/join\(HERE, '\.\.', 'tools', 'preview/.test(runner),
    'the audit runner reaches outside its own directory for the tool; living beside it is what makes a stale copy impossible',
  )
  // And the scenario list must stay derived: the hand-written version it replaced
  // named twenty scenarios while the tool had grown to forty-four, so every screen
  // added in between was never audited.
  assert.ok(
    /execFileSync\(process\.execPath, \[PREVIEW, '--list'\]/.test(runner),
    'the audit runner went back to a list of its own; a hand-written list goes stale silently while the tool keeps growing',
  )
})

test('the preview host can lose the host and get it back, so recovery is testable', () => {
  // A harness restart is ordinary here rather than hypothetical: the user's own
  // instance changed process four times in one working session — 59968, 54204,
  // 70332, 34100 — while the port stayed at 3080. The panel is supposed to notice
  // both the outage and the recovery through nothing but its five-second poll.
  //
  // That cannot be measured unless the fixture can produce both halves. The tool
  // already had `hostDownAfterFirst`, which is one-way: the host answers once and
  // is gone for good, so anything about *coming back* was untestable — including
  // the failure that matters most, a panel that stays stuck on a "cannot connect"
  // surface after the host is healthy again.
  //
  // The outage is timed rather than counted on purpose. The panel's recovery is a
  // clock; if the fixture decided when the panel noticed, the measurement would
  // replace the behaviour it is supposed to observe.
  const preview = readFileSync(join(root, 'tools', 'preview.mjs'), 'utf8')

  assert.ok(
    /if \(scenario\.hostDown === true\)/.test(preview),
    'the always-down fixture is gone; the "never connected" state is no longer reachable',
  )
  assert.ok(
    /scenario\.hostRestartsAfterMs/.test(preview),
    'the preview host cannot go away and come back, so nothing about recovery after a restart is testable',
  )
  // Timed, not request-counted: a count would let the fixture decide when the
  // panel finds out.
  assert.ok(
    /Date\.now\(\) - hostStartedAt/.test(preview),
    'the scripted outage is not measured against a clock, so the fixture would be driving the panel instead of observing it',
  )
  assert.ok(
    /hostRestarts: \{ hostRestartsAfterMs/.test(preview),
    'the scenario that exercises a restart is gone, so the recovery path has no way to be run',
  )
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

test('the preview host can serve a real conversation, not only a fixture', () => {
  // Every fixture in the tool was written by whoever was fixing something at the
  // time, so it holds the shapes that person thought of — and those are the shapes
  // already known to work. One real segment measured here has 76 rows, 30 tool
  // calls, 22 reasoning blocks, 114 fenced blocks, 10 tables and 2 failure rows.
  // No fixture author invents that mixture, and it is exactly the mixture that
  // breaks layout.
  //
  // The rows have to be handed to the HTTP host rather than to the page, and that
  // is the part worth asserting: the in-page `chrome` stand-in never handles
  // `messages` — the panel reaches a real Node HTTP server — so putting the
  // conversation on a browser global reaches nobody. The first attempt at this did
  // exactly that and rendered the old fixture with `rows: 4`, which looks like the
  // flag being ignored rather than like a layer being wrong.
  const preview = readFileSync(join(root, 'tools', 'preview.mjs'), 'utf8')

  assert.ok(
    /scenario\.messages = realConversationRows/.test(preview),
    'the real conversation must reach the host through the scenario; a page global never gets to the HTTP server',
  )
  assert.ok(
    /rest\.indexOf\('--real-conversation'\)/.test(preview),
    'the flag that supplies a real conversation is gone',
  )
  // And the host must be able to answer a window narrower than the conversation:
  // the reader's own history is 6969 rows, so a tool that can only show all of it
  // or none of it cannot show the panel the reader actually sees.
  assert.ok(
    /const start = Math\.max\(0, stop - limit\)/.test(preview),
    'the host no longer slices the window, so a real 76-row conversation cannot be shown as the panel would show it',
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

test('the preview tool records the first frames, before the panel has anything to say', () => {
  // A probe cannot answer "how long was the panel blank". `--probe` is evaluated
  // after the load settles, and by then the answer is gone: measured, a probe
  // asking that question reported `msSinceNavigation: 1356` with four rows already
  // drawn, and could say only that content *had* arrived.
  //
  // The blank interval is the part a screenshot cannot show at all and a settled
  // reading cannot recover, so the tool samples it per frame through
  // `Page.addScriptToEvaluateOnNewDocument` — the same mechanism the `chrome`
  // stand-in already uses to exist before the panel's own script does.
  //
  // This assertion guards the instrument, not the product: with the recorder gone,
  // the question cannot be asked at all, and nothing else in the suite would
  // notice. It is also what keeps the honest reading possible — the measurement
  // came back negative (about two frames, 60ms, in every state tried), and a
  // negative result is only worth anything while the instrument that produced it
  // still works.
  const preview = readFileSync(join(root, 'tools', 'preview.mjs'), 'utf8')

  assert.ok(
    /window\.__previewStartup = samples/.test(preview),
    'the preview tool no longer records the startup frames, so "how long was the panel blank" is unanswerable',
  )
  // Per frame, not on a timer: the question is what a reader saw, and the
  // compositor is what decides that. A sampler on `setTimeout` would measure the
  // clock rather than the screen.
  assert.ok(
    /requestAnimationFrame\(sample\)/.test(preview),
    'the startup sampler must run per frame: a timer measures the clock, not what was painted',
  )
  // And it must record the panel, not one element of it. Watching only the
  // transcript called a fully explained "cannot connect" screen unexplained,
  // because the blocked surface is the transcript's sibling rather than its child.
  assert.ok(
    /document\.getElementById\('stage'\)/.test(preview),
    'the startup sampler must record the whole panel: the blocked surface is not inside the transcript',
  )
})

test('every floating surface can be opened and dismissed, so it never hides the conversation', () => {
  // Overlapping the page is what a floating surface is for; hiding a row the
  // reader can never uncover is the defect. This repository fixed that once — a
  // pill pinned over the scroller covered up to 24 characters of the row that
  // scrolled under it, permanently — so the distinction is recorded here: an
  // overlay is acceptable when the reader can dismiss it.
  //
  // This used to say that the way to express that in markup is a real role, and
  // the audit proved it wrong by disagreeing with itself. The model picker gives
  // up `role="menu"` in the "no catalog" state on purpose — a `listbox` whose only
  // child is a sentence makes a screen reader announce an option list that is not
  // there — so the same layer was reported as a permanent occlusion in one state
  // and clean in the other. A role is one way to say "the reader opened this", not
  // the only one, and the property that matters is dismissal.
  const html = readFileSync(join(root, 'extension', 'sidepanel.html'), 'utf8')
  const script = readFileSync(join(root, 'extension', 'sidepanel.js'), 'utf8')

  // The roles are applied by the code that fills the rows, not written in the
  // markup: an empty list has to give the role up, as described above.
  for (const [name, role] of [['modelMenu', 'menu'], ['atMenu', 'listbox']]) {
    assert.ok(
      new RegExp(`${name}\\.setAttribute\\('role', '${role}'\\)`).test(script),
      `${name} is never given role="${role}" in the state where it holds rows`,
    )
  }

  // What every dismissible surface has to have: a code path that closes it, and a
  // way for a reader to reach that path. Each of these was one of the mechanisms
  // the audit had to learn before it stopped reporting the menus.
  assert.ok(
    /document\.addEventListener\('click', \(\) => \{\s*setMenu\(false\)/.test(script),
    'the model menu no longer closes when the reader clicks away from it',
  )
  assert.ok(
    /event\.key !== 'Escape'[\s\S]{0,200}?setMenu\(false\)/.test(script),
    'the model menu no longer closes on Escape, so a keyboard reader cannot dismiss it',
  )
  assert.ok(
    /closeMention\(\)/.test(script),
    'the @ picker has no code path that takes it away',
  )
  // And the @ picker is driven by the text, which is the mechanism that has no
  // control and no role to key on: deleting the `@` has to close it.
  assert.ok(
    /mentionAt\([\s\S]{0,200}?closeMention\(\)/.test(script),
    'the @ picker no longer closes when the mention text is deleted',
  )

  // The pill that started all this must NOT gain a dismissal role: it is not
  // something the reader opens, and pretending otherwise is how the audit came to
  // accept any layer with a role as harmless.
  assert.ok(
    !/earlierButton\.setAttribute\('role'/.test(script),
    'the "earlier content" pill is not a surface the reader opens; giving it a role would make the audit treat a permanent occlusion as dismissible',
  )
  assert.ok(
    html.includes('#earlier'),
    'the pill the occlusion check exists for is gone from the stylesheet',
  )
})

test('the audit judges overflow, occlusion and small text by what a reader can do, not by tag', () => {
  // Three judgements were rewritten because they were reporting things a reader
  // has no problem with: 60 table findings that scrolling resolves, four menus the
  // reader opened themselves, and a stop glyph that is not text. Each rewrite has
  // a matching exemption asserted below, so the rule cannot quietly widen into
  // "nothing is ever wrong" — a judge that always passes is a judge that cannot
  // fail, and this suite would not notice.
  const audit = readFileSync(join(root, 'tools', 'audit-in-page.js'), 'utf8')

  // Overflow: reachable by scrolling is not a finding, and the reachability is
  // computed from geometry rather than assumed from the presence of a scroller.
  assert.ok(
    /const reachableByScrolling = \(element\) =>/.test(audit),
    'the overflow check no longer asks whether a scroll can bring the element into view',
  )
  // Defined *and called*. Asserting only the definition left a hole: replacing the
  // call with a comment keeps the definition, and the suite stayed green while the
  // audit went back to reporting 60 tables. That is the shape this repository keeps
  // recording — an assertion about a name instead of about the work.
  assert.ok(
    /if \(reachableByScrolling\(element\)\) continue/.test(audit),
    'the reachability rule is defined but never applied, so anything past the viewport is reported again',
  )
  assert.ok(
    /scrollToShowRightEdge <= maximum \+ 1/.test(audit),
    'the overflow check no longer compares what scrolling is needed against what the scroller allows',
  )
  assert.ok(
    /if \(contentLeft < -0\.5\) return false/.test(audit),
    'scrolling cannot go negative, so an element starting left of the content origin is not reachable by it',
  )
  // …and the check still exists. Deleting the loop would make the suite green and
  // the audit blind.
  assert.ok(
    /overflowFindings\.push\(\{/.test(audit),
    'the overflow check no longer reports anything at all',
  )

  // Occlusion: a layer the reader opened is not an occlusion.
  assert.ok(
    /if \(openedBy\) continue/.test(audit),
    'the occlusion check reports layers the reader opened themselves',
  )
  assert.ok(
    /openMenus\) continue/.test(audit),
    'the occlusion check reports the @ picker, which closes when the mention text is deleted',
  )
  assert.ok(
    /occlusionFindings\.push\(\{/.test(audit),
    'the occlusion check no longer reports anything at all',
  )

  // Small text: a glyph recognised through an accessible name is not small text.
  assert.ok(
    /const isGlyph = text\.length <= 2 && !\/\\p\{L\}\/u\.test\(text\) && named\.length > 0/.test(audit),
    'the small-text check counts glyphs as text; a symbol is recognised, not read, and its meaning comes from its accessible name',
  )
  assert.ok(
    /if \(!isGlyph\) tiny\.push\(\{/.test(audit),
    'the small-text check no longer reports real words below the size floor',
  )
})

test('no fixture timestamp can change its own label while a gallery run is happening', () => {
  // `relativeTime` rounds, so a timestamp sitting on a band edge renders one label
  // and then another as the clock moves. The gallery is supposed to be
  // reproducible, and a fixture age on an edge makes that false: `sessions.png`
  // grew 187 differing pixels on its own between two runs of the same code,
  // measured at CSS 345,214 — a session's age label. `historyFull` had already
  // been fixed for exactly this at the week boundary; the generator that feeds the
  // session list was never checked and six of its rows sat half a minute from
  // flipping.
  //
  // The question is not "will this label ever change" — every relative label will,
  // that is what relative means. It is whether it changes *inside one run*, so the
  // assertion is a budget of slack rather than permanence.
  const preview = readFileSync(join(root, 'tools', 'preview.mjs'), 'utf8')

  const unitLine = /const unitMs = (.+)\n/.exec(preview)
  const agoLine = /const ago = (.+)\n/.exec(preview)
  assert.ok(unitLine !== null, 'the age generator no longer states a unit; this test cannot judge its slack')
  assert.ok(agoLine !== null, 'the age generator no longer computes `ago`; this test cannot judge its slack')
  // The fixture has to place ages away from a band edge, which is what the extra
  // half unit does. Asserted on the expression rather than on the rendered result,
  // because the rendered result is only wrong for part of every minute.
  assert.match(
    agoLine[1],
    /unitMs \/ 2|\+ *unitMs *\/ *2/,
    `the fixture places ages on a rounding boundary (${agoLine[1].trim()}); every tier of relativeTime rounds, so such a row labels itself differently as the clock moves and the gallery diff stops being reproducible`,
  )

  // And the hand-written ages, which have to keep the same rule. The arithmetic is
  // stated here rather than checked by reading the clock, because the failure is
  // intermittent by nature: an age on a band edge renders correctly and then stops
  // rendering correctly a few seconds later.
  //
  // `relativeTime`'s bands, measured: a whole number of minutes sits *on* the edge
  // (`8 * 60_000` holds its label for 30 seconds), while half past a minute sits in
  // the middle (`8.5 * 60_000` holds for 60). So a fixture age in the minutes tier
  // must be half-past a minute, and an age in the `now` tier must not be an exact
  // whole number of minutes either.
  const boundaryAges = [...preview.matchAll(/Date\.now\(\) - ([0-9_.* ]+)/g)].map((match) => match[1].trim())
  assert.ok(boundaryAges.length > 0, 'the preview tool has no timestamped fixtures; this test proves nothing')
  for (const expression of boundaryAges) {
    // Only the ages small enough to land in the rounding tiers matter; the day and
    // year ones are stable for hours either side of their band.
    const minutes = /^([\d.]+) \* 60_000$/.exec(expression)
    const raw = /^([\d_]+)$/.exec(expression)
    const asMinutes = minutes !== null ? Number.parseFloat(minutes[1])
      : raw !== null ? Number.parseInt(raw[1].replace(/_/g, ''), 10) / 60_000
        : null
    if (asMinutes === null || asMinutes >= 60) continue
    assert.notEqual(
      Number.isInteger(asMinutes),
      true,
      `a fixture age of ${expression} is a whole number of minutes, which is a band edge for relativeTime: the label flips after 30 seconds and the screenshot stops being reproducible`,
    )
  }
})

test('the mutation tool refuses to read an unchanged file as a caught mutation', async () => {
  // Mutation checking is how every round argues that its test would notice the
  // bug it is about. It was re-implemented from scratch each round in a scratch
  // file, so the same two mistakes came back: an anchor that was not found
  // changes nothing, and "nothing changed" is indistinguishable from "the suite
  // correctly did not catch it"; and a test name matched anywhere in the output
  // counts the passing line `✔ <name>` as a hit, which once reported 8 of 15
  // mutations as caught when they were not.
  //
  // `tools/mutate.mjs` is that discipline written down once. This test is about
  // the honest failure mode rather than the happy path: given a mutation whose
  // anchor is not in the file, it must say so, and must not count it as caught.
  const { checkMutations } = await import('../../../tools/mutate.mjs')

  const original = readFileSync(join(root, 'tools', 'mutate.mjs'), 'utf8')
  assert.equal(typeof checkMutations, 'function', 'the mutation tool no longer exports a checker')
  assert.ok(original.includes('ANCHOR NOT FOUND'), 'an anchor that is not found must be reported as its own outcome')

  // Swallow the report: the point is the returned failure count, not the print.
  const written = []
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk, ...rest) => { written.push(String(chunk)); return true }
  let wrong
  try {
    wrong = checkMutations([{
      name: 'anchor-that-is-not-in-the-file',
      file: 'tools/mutate.mjs',
      from: 'this text does not appear anywhere in the repository at all',
      to: 'replacement',
      suite: 'screenshots',
      expect: 'red',
    }])
  } finally {
    process.stdout.write = write
  }

  assert.equal(wrong, 1, 'a mutation whose anchor is absent changed nothing and must be reported as a failure, not as a caught mutation')
  const report = written.join('')
  assert.ok(report.includes('ANCHOR NOT FOUND'), 'the report must name the reason, so a typo is not mistaken for an equivalent mutation')
  assert.equal(
    readFileSync(join(root, 'tools', 'mutate.mjs'), 'utf8'),
    original,
    'the tool must leave the file it was pointed at untouched',
  )
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
