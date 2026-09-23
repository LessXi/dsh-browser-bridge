/**
 * Regenerate `docs/screenshots/` — the images the README shows.
 *
 * Why this is checked in rather than run once by hand: a screenshot is a claim
 * about what the product looks like, and a claim that nothing regenerates goes
 * stale silently. Twenty rounds of UI work had accumulated in this repository
 * with `git ls-files` showing eight images, all of them extension icons — the
 * panel itself was invisible to anyone reading the README, which is where a
 * person decides whether to install the thing.
 *
 * So the set is declared here, once, with the reason each shot is in it, and
 * `node tools/gallery.mjs` reproduces all of them. Adding a state worth showing
 * means adding a line below, and the fact that the line has to name a scenario
 * that exists is what keeps the gallery honest: a screenshot of a state the
 * panel can no longer reach fails loudly instead of sitting in the README.
 *
 * Usage:
 *   node tools/gallery.mjs            # write docs/screenshots/
 *   node tools/gallery.mjs --check    # fail if any image is missing
 *
 * Requires Chrome, found the same way the e2e suite finds it.
 *
 * @module dsh-browser-bridge/tools/gallery
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const OUT = join(REPO, 'docs', 'screenshots')

/**
 * The gallery.
 *
 * `scenario` names a state in `tools/preview.mjs`; `probe` optionally runs in
 * the page first and its result is the `--after-probe` capture, which is how a
 * shot shows a state a scenario cannot reach by itself (a typed query, a jumped
 * search). `locale` is zh-CN where the panel is being judged as a product for
 * its actual reader, and en-US where the shot is about the chrome of the panel
 * rather than the conversation.
 *
 * Every entry states why it is here. A shot nobody can justify is a shot that
 * will be wrong in a year and still in the README.
 */
const SHOTS = [
  {
    file: 'conversation.png',
    scenario: 'normal',
    scheme: 'dark',
    locale: 'zh-CN',
    why: 'The hero: a real exchange with prose, a code block and a tool row. This is the whole product in one frame.',
  },
  {
    file: 'conversation-light.png',
    scenario: 'normal',
    scheme: 'light',
    locale: 'zh-CN',
    why: 'The same state in light. Both modes are supported, so both are shown; a palette that passes in one can fail in the other.',
  },
  {
    file: 'search.png',
    scenario: 'findJumped',
    scheme: 'dark',
    locale: 'zh-CN',
    probe: 'showcase-find.js',
    why: 'Search over a 600-row session: the count, the outlined row, and the matched word itself highlighted. The probe types the query, because the interesting frame is after the host has answered.',
  },
  {
    file: 'approval.png',
    scenario: 'approval',
    scheme: 'dark',
    locale: 'zh-CN',
    why: 'The one place the panel asks a question instead of reporting. Three equal buttons, no default.',
  },
  {
    file: 'model-menu.png',
    scenario: 'modelMenu',
    scheme: 'dark',
    locale: 'zh-CN',
    why: 'Effort and model in one popup, with focus and selection drawn as the two different things they are.',
  },
  {
    file: 'sessions.png',
    // The real scale rather than the three-row fixture: a workspace holding a
    // hundred sessions is where folding matters, and it is also what the picture
    // is for — the small fixture shows a list that never has this problem, which
    // is not the list a reader has.
    scenario: 'historyFull',
    scheme: 'dark',
    locale: 'zh-CN',
    why: 'Sessions grouped by workspace, folded to a handful each with the rest one button away. Minutes for the ones just used, a day for the older ones, and a running indicator that is never folded away.',
  },
  {
    file: 'reasoning.png',
    scenario: 'longReasoningOpen',
    scheme: 'dark',
    locale: 'zh-CN',
    why: 'A reasoning row opened inside a long session, which is the state the row-identity fix was about.',
  },
  {
    file: 'tool-failure.png',
    scenario: 'toolFailure',
    scheme: 'dark',
    locale: 'zh-CN',
    why: 'A failed tool call with its reason revealed: a failure that says what happened without becoming a stack trace.',
  },
  {
    file: 'working.png',
    scenario: 'working',
    scheme: 'dark',
    locale: 'zh-CN',
    why: 'A turn in flight: the waiting row, and the send button turned into stop.',
  },
  {
    file: 'failure-recourse.png',
    scenario: 'failed',
    scheme: 'dark',
    locale: 'zh-CN',
    why: 'A turn that died offers the reader their question back — the one recourse the host can actually keep, because it cannot re-run a turn.',
  },
  {
    file: 'picture.png',
    scenario: 'picture',
    scheme: 'dark',
    locale: 'zh-CN',
    why: 'Pictures the reader sent, drawn in the conversation. The bare one — no caption — used to produce no row at all, so the reply below it read as an answer to nothing.',
  },
  {
    file: 'host-down.png',
    scenario: 'hostDown',
    scheme: 'dark',
    locale: 'zh-CN',
    why: 'The host is not running. A dead panel that explains itself and offers the one action that helps.',
  },
  {
    file: 'high-contrast.png',
    scenario: 'normal',
    scheme: 'dark',
    locale: 'zh-CN',
    forcedColors: 'active',
    why: 'Windows High Contrast, where the system repaints every colour. Structure has to survive it, which is what several rounds of fixes were for.',
  },
]

/** Write one image by driving `preview.mjs`. */
function shoot(entry) {
  const args = [
    join(HERE, 'preview.mjs'),
    entry.scenario,
    join(OUT, entry.file),
    '--width', '380',
    '--height', '720',
    '--scheme', entry.scheme,
    '--locale', entry.locale,
    '--forced-colors', entry.forcedColors ?? 'none',
  ]
  if (entry.probe !== undefined) {
    // The probe runs before the capture, so `--after-probe` is the frame that
    // shows what it changed. The first path is still required and is thrown
    // away — `preview.mjs` always writes its main capture.
    args.push('--probe', join(HERE, entry.probe))
    args.push('--after-probe', join(OUT, entry.file))
  }
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(-6).join('\n')
    throw new Error(`${entry.scenario} -> ${entry.file} failed:\n${detail}`)
  }
  // A scenario that renders an empty panel still exits 0, so the file has to be
  // checked rather than trusted: a 2KB PNG means the panel drew nothing, and a
  // blank image in a README is worse than a missing one.
  const size = statSync(join(OUT, entry.file)).size
  if (size < 8_000) {
    throw new Error(`${entry.file} is only ${size} bytes — the panel probably did not render`)
  }
  return size
}

const checking = process.argv.includes('--check')

if (checking) {
  const missing = SHOTS.filter((entry) => !existsSync(join(OUT, entry.file)))
  if (missing.length > 0) {
    process.stderr.write(`missing screenshots: ${missing.map((entry) => entry.file).join(', ')}\n`)
    process.stderr.write('run `node tools/gallery.mjs` to regenerate them\n')
    process.exit(1)
  }
  process.stdout.write(`${SHOTS.length} screenshots present in docs/screenshots/\n`)
} else {
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })
  for (const entry of SHOTS) {
    const size = shoot(entry)
    process.stdout.write(`${entry.file.padEnd(24)} ${String(Math.round(size / 1024)).padStart(4)} KB\n`)
  }
  process.stdout.write(`\n${SHOTS.length} screenshots written to docs/screenshots/\n`)
}
