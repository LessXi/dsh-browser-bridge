/**
 * Audit every panel scenario and print one table.
 *
 * Running `preview.mjs --audit` by hand for each scenario is slow and, worse,
 * easy to misread: a scenario whose audit threw still prints an `audit:` line,
 * and a caller that parses it sees zeros. This script runs each scenario, treats
 * a missing or failed audit as a hard failure, and exits non-zero if any
 * scenario reports a finding — so "clean" always means measured-and-clean.
 *
 * Usage: node tools/audit.mjs [--width 380] [--json] [--only a,b] [--page sidepanel|options]
 *        node tools/audit.mjs --scheme dark          # one scheme only
 */

import { execFileSync, spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * The preview tool, which sits beside this script.
 *
 * This one line is why the script moved here. It used to live in the scratch
 * directory and aim at `join(HERE, 'preview.mjs')` — a *copy* of the tool that was
 * left behind when the real one moved into `tools/` in v82. Every audit since then
 * measured a preview twenty-one versions old: 68 KB against the real 127 KB, with
 * no `--reduced-motion` and none of the twenty-four scenarios added after that day.
 *
 * It did not fail. It invented two findings for the `working` row that the real
 * tool does not produce — `div.working` at `ratio: 1` with `color: rgba(0, 0, 0, 0)`
 * — because the old tool never emulated reduced motion, so the row kept the sweep
 * animation's transparent colour. Measured through the real tool the same row is
 * `color: var(--tertiary)` at 6.41:1, stable across forty frames.
 *
 * A runner aimed at the wrong binary is indistinguishable from a product defect.
 * Living in the same directory as the tool is what makes the mistake impossible
 * rather than merely corrected.
 */
const PREVIEW = join(HERE, 'preview.mjs')

/**
 * Every scenario the preview tool knows, read from the tool itself.
 *
 * This used to be a hand-written list, and its own comment recorded the cost: some
 * states only exist after a click, they were missing, and the defect they would have
 * shown was found by looking at a screenshot instead. The list was then extended by
 * hand — and rotted again, because the tool grew from 20 scenarios to 43 while this
 * file kept naming the same 20. Every screen added since — the comparison table, the
 * trigger row, the compaction marker, cross-session search, the link states — was
 * never audited at all.
 *
 * Asking the tool is the version that cannot go stale: adding a scenario to
 * `preview.mjs` puts it in this audit on the same commit.
 */
function allScenarios() {
  const out = execFileSync(process.execPath, [PREVIEW, '--list'], { encoding: 'utf8' })
  return out.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
}

const args = process.argv.slice(2)
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null
const SCENARIOS = only === null
  ? allScenarios()
  : only.split(',').map((name) => name.trim()).filter((name) => name.length > 0)

const widthIndex = args.indexOf('--width')
const width = widthIndex === -1 ? 380 : Number(args[widthIndex + 1])
const schemeIndex = args.indexOf('--scheme')
const schemes = schemeIndex === -1 ? ['dark', 'light'] : [args[schemeIndex + 1]]
const asJson = args.includes('--json')

// Which surfaces get audited. The settings page was added after it turned out to
// have been rendered exactly once and audited never: this runner only ever knew
// about the side panel, so the page someone must pass to paste the token could
// carry a failing target and a broken light scheme indefinitely. Both surfaces
// ship in the same extension and share the same colour vocabulary, so neither is
// a reason to trust the other.
const pageIndex = args.indexOf('--page')
const pages = pageIndex === -1 ? ['sidepanel', 'options'] : [args[pageIndex + 1]]

/**
 * Where each scenario's screenshot goes.
 *
 * Under a `.tmp-` name so the repository's ignore rule covers it. The audit writes
 * one image per scenario per scheme — 88 files — and a directory of PNGs beside a
 * checked-in tool is exactly the kind of thing `git add -A` sweeps into a commit.
 * This repository has done that once already with a stray image whose name came
 * from a mis-parsed flag.
 */
const SHOTS = join(HERE, '.tmp-audit-shots')

/** Run one scenario and return its parsed audit, or a failure record. */
const runOne = (scenario, scheme, page) =>
  new Promise((resolve) => {
    const label = page === 'options' ? 'options' : scenario
    const child = spawn(process.execPath, [
      PREVIEW, scenario, join(SHOTS, `audit-${label}-${scheme}.png`),
      '--width', String(width), '--scheme', scheme, '--audit', '--page', page,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })

    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    // A preview that hangs is a failure, not a reason to wait forever.
    const timer = setTimeout(() => {
      child.kill()
      resolve({ scenario, scheme, page, error: 'timed out after 90s' })
    }, 90_000)

    child.on('close', (code) => {
      clearTimeout(timer)
      if (out.includes('AUDIT FAILED')) {
        const detail = out.split('AUDIT FAILED:')[1]?.split('\n')[0]?.trim() ?? 'unknown'
        resolve({ scenario, scheme, error: `audit threw: ${detail}` })
        return
      }
      const marker = out.indexOf('  audit: ')
      if (marker === -1) {
        // The byte count and the tail distinguish the two ways this can happen:
        // nothing was written at all (0 bytes), or the write was cut short
        // (partial output ending mid-object). Guessing between them cost a
        // round of blind fixes.
        const tail = out.slice(-80).replace(/\n/g, '\\n')
        // The first line of the child's own report, not the last: the stack
        // ends in Node internals and the sentence naming the failure is at the
        // top.
        const head = out.split('\n').filter((l) => l.includes('PREVIEW FAILED') || l.trim().startsWith('Error') || l.includes('Error:'))[0]?.trim() ?? ''
        resolve({
          scenario,
          scheme,
          page,
          error: `no audit output (exit ${code}, ${out.length}B) ${head} ${err.split('\n')[0] ?? ''}`.trim(),
        })
        return
      }
      // Everything after the marker is the JSON object the audit returned.
      const body = out.slice(marker + '  audit: '.length)
      try {
        resolve({ scenario, scheme, page, audit: JSON.parse(body) })
      } catch (parseError) {
        resolve({ scenario, scheme, page, error: `audit JSON unparseable: ${parseError.message}` })
      }
    })
  })

const results = []
// Serial by default, and deliberately so.
//
// The scenarios are independent processes with their own Chrome, port and
// profile, so running them one at a time looks like pure latency — but on this
// machine concurrency traded that latency for flakiness that looked like product
// failures: at four at once CDP calls timed out, and at two they still did
// occasionally when a previous batch's Chromes were still shutting down. A
// verification tool that reports phantom defects is worse than a slow one, so
// the default is the setting that never lies. Pass `--concurrency N` to trade
// the other way on a machine with cores to spare.
const CONCURRENCY = Number(args[args.indexOf('--concurrency') + 1]) || 1
const jobs = []
for (const scheme of schemes) {
  for (const page of pages) {
    // The settings page has no scenarios: it renders the same form whatever the
    // panel's state is, so running it once per scenario would render the same
    // page 28 times and call it coverage.
    const forPage = page === 'options' ? ['normal'] : SCENARIOS
    for (const scenario of forPage) jobs.push({ scheme, scenario, page })
  }
}

const done = []
let nextJob = 0
const worker = async () => {
  while (nextJob < jobs.length) {
    const job = jobs[nextJob]
    nextJob += 1
    done.push(await runOne(job.scenario, job.scheme, job.page))
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker))

// Printed in a stable order: concurrency decides when a result arrives, not how
// it reads.
for (const scheme of schemes) {
  process.stdout.write(`\n=== ${scheme} ===\n`)
  for (const page of pages) {
    for (const scenario of (page === 'options' ? ['normal'] : SCENARIOS)) {
      const result = done.find((r) => r.scenario === scenario && r.scheme === scheme && r.page === page)
      if (result === undefined) continue
      results.push(result)
      const label = `${page === 'options' ? 'options' : scenario}/${scheme}`
      if (result.error !== undefined) {
        process.stdout.write(`${label.padEnd(20)} ERROR  ${result.error}\n`)
        continue
      }
      const a = result.audit
      const total = a.contrast.length + a.targets.length + a.overflow.length + a.clipped.length + a.overlaps.length + (a.occlusions ?? []).length + a.tinyText.length
      const coverage = `checked ${a.coverage.contrastElementsChecked} text / ${a.coverage.targetsChecked} targets`
      process.stdout.write(`${label.padEnd(20)} ${String(total).padStart(2)} findings   ${coverage}\n`)
      for (const c of a.contrast) {
        process.stdout.write(`               contrast ${c.ratio} < ${c.required}  ${c.element} (${c.fontSize}px)${c.fadedByAncestor ? ' [faded]' : ''}\n`)
      }
      for (const t of a.targets) {
        process.stdout.write(`               target   ${t.width}x${t.height}  ${t.element}${t.hiddenUntilHover ? ' [hover-only]' : ''}${t.measured === 'wrapping label' ? ' [label]' : ''}\n`)
      }
      for (const o of a.overflow) {
        process.stdout.write(`               overflow ${o.left}..${o.right} vs ${o.viewport}  ${o.element}\n`)
      }
      for (const c of a.clipped) {
        process.stdout.write(`               clipped  ${c.scrollHeight} > ${c.clientHeight}  ${c.element}\n`)
      }
      for (const o of a.overlaps) {        process.stdout.write(`               overlap  ${o.overlap.width}x${o.overlap.height}  ${o.first} over ${o.second} in ${o.parent} (display:${o.parentDisplay} direction:${o.parentDirection})\n`)      }
      for (const o of a.occlusions ?? []) {
        process.stdout.write(`               occluded ${o.overlap} (${o.overlapArea}px²)  ${o.layer} over ${o.covered} "${o.coveredText}" [${o.scroller} ${o.scrollerScrollHeight}=${o.scrollerClientHeight}]\n`)
      }
      for (const t of a.tinyText) {
        process.stdout.write(`               tiny     ${t.fontSize}px  ${t.element}\n`)
      }
      if (a.coverage.unreadableColours.length > 0) {
        process.stdout.write(`               UNREADABLE COLOURS: ${JSON.stringify(a.coverage.unreadableColours)}\n`)
      }
    }
  }
}

if (asJson) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)

const broken = results.filter((r) => r.error !== undefined || r.audit?.coverage.unreadableColours.length > 0)
const findings = results.reduce((sum, r) =>
  sum + (r.audit === undefined ? 0
    : r.audit.contrast.length + r.audit.targets.length + r.audit.overflow.length
      + r.audit.clipped.length + r.audit.overlaps.length + (r.audit.occlusions ?? []).length
      + r.audit.tinyText.length), 0)
process.stdout.write(`\n${results.length} scenarios, ${findings} findings, ${broken.length} broken\n`)
// Findings must fail the run too. Exiting non-zero only for `broken` meant a
// viewport that produced 30 findings still reported success, and it only stayed
// hidden because the first viewport measured happened to produce none.
process.exit(broken.length > 0 || findings > 0 ? 1 : 0)
