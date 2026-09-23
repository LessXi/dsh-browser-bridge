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
