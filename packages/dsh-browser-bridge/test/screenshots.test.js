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

import { existsSync, readFileSync, statSync } from 'node:fs'
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
})
