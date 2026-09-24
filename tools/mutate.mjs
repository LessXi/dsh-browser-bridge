/**
 * Mutation checking, as a tool rather than a habit.
 *
 * Every round of work on this panel has ended with a mutation run — edit the
 * source into a specific wrong shape, run the suite, and confirm it goes red —
 * and every round has re-implemented that harness from scratch in a gitignored
 * scratch file. The same mistakes came back each time, because the discipline
 * lived in the person rather than in the repository:
 *
 *   - a mutation whose anchor was not found *looks exactly like* a mutation that
 *     was correctly not caught, so an unnoticed typo silently becomes an
 *     "equivalent mutation" (v36);
 *   - matching a test name anywhere in the output counts the passing line
 *     `✔ <name>` as a hit, which reported 8 of 15 mutations as caught when they
 *     were not (v78);
 *   - a script that restores the source it edited but not the *images* it
 *     overwrote leaves a PNG full of text (v82);
 *   - a mutation inserted *before* the code it was meant to disable changes
 *     nothing, and then every "not caught" reading is meaningless (v36).
 *
 * This tool exists so those four are checked mechanically instead of remembered.
 *
 * A mutation is described as data:
 *
 *   { name, file, from, to, suite, expect: 'red' | 'green', why }
 *
 * `expect: 'red'` is a real defect: the suite must fail. `expect: 'green'` is an
 * equivalence the author has argued for — two spellings of the same behaviour —
 * and it must *not* fail, or the argument was wrong.
 *
 * @module tools/mutate
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const TESTS = join(REPO, 'packages', 'dsh-browser-bridge', 'test')

/**
 * Run one suite and report whether it failed.
 *
 * The suite is loaded by a one-line runner in this process's `-e` argument rather
 * than through a scratch file. A scratch runner is one more thing that can be
 * missing, and when it is, every mutation reads as "not caught" — a whole run of
 * meaningless readings that looks like a passing run.
 *
 * The verdict comes from a failed *test* line, not from the exit code alone and
 * not from the presence of a name. `✔ name` contains the same name as `✖ name`,
 * so a check that greps for the name is true whether the test passed or failed —
 * it cannot report a mutation as caught, and cannot report one as missed either.
 *
 * @param {string} suite - Suite file name without the extension.
 * @returns {{failed: boolean, ranSomething: boolean, summary: string, output: string}}
 */
export function runSuite(suite) {
  // Import the one suite, then run whatever it registered. `harness.js` reports
  // through `runTests()`, and a suite file on its own registers without running —
  // running it directly prints nothing at all, which is why this does not simply
  // spawn the suite file.
  const script = `
    const { pathToFileURL } = await import('node:url')
    const { join } = await import('node:path')
    await import(pathToFileURL(join(${JSON.stringify(TESTS)}, ${JSON.stringify(`${suite}.test.js`)})).href)
    const { runTests } = await import(pathToFileURL(join(${JSON.stringify(TESTS)}, 'harness.js')).href)
    const failed = await runTests()
    if (failed > 0) process.exitCode = 1
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 900_000,
  })
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  // A suite that never ran is not a suite that passed. Without this, a typo in a
  // suite name reads as "the mutation was correctly not caught", and a missing
  // file reads the same way.
  const ranSomething = /passed,/.test(output)
  return {
    failed: /^\s*✖/m.test(output),
    ranSomething,
    summary: output.trim().split('\n').filter((line) => /passed,/.test(line)).slice(-1)[0] ?? '(no summary line)',
    output,
  }
}

/**
 * Apply one mutation, run its suite, restore the file, and judge the result.
 *
 * @param {object} mutation - See the module comment for the shape.
 * @returns {object} The reading, including whether the mutation was decisive.
 */
function checkOne(mutation) {
  const path = join(REPO, mutation.file)
  const original = readFileSync(path, 'utf8')

  if (!original.includes(mutation.from)) {
    return {
      name: mutation.name,
      outcome: 'ANCHOR NOT FOUND',
      // This is the failure mode that hides as an equivalence: nothing was
      // changed, so nothing went red, so it reads as "correctly not caught".
      ok: false,
      detail: `the anchor is not in ${mutation.file}; this mutation changed nothing`,
    }
  }
  const mutated = original.replace(mutation.from, mutation.to)
  if (mutated === original) {
    return { name: mutation.name, outcome: 'NO-OP', ok: false, detail: 'the replacement produced identical text' }
  }

  writeFileSync(path, mutated, 'utf8')
  let reading
  try {
    reading = runSuite(mutation.suite)
  } finally {
    writeFileSync(path, original, 'utf8')
  }

  const restored = readFileSync(path, 'utf8') === original
  if (!restored) {
    return { name: mutation.name, outcome: 'NOT RESTORED', ok: false, detail: `wrote the file back and it differs from the original` }
  }
  if (!reading.ranSomething) {
    return { name: mutation.name, outcome: 'SUITE DID NOT RUN', ok: false, detail: `${mutation.suite}: ${reading.summary}` }
  }

  const wanted = mutation.expect === 'green' ? false : true
  const ok = reading.failed === wanted
  return {
    name: mutation.name,
    outcome: reading.failed ? 'red' : 'green',
    expected: mutation.expect ?? 'red',
    ok,
    suite: mutation.suite,
    detail: ok
      ? (reading.failed ? 'caught, as intended' : 'stayed green, as argued')
      : (reading.failed
        ? 'went red but was argued to be equivalent: the argument needs revisiting'
        : 'stayed green: nothing in the suite separates this wrong shape from the right one'),
  }
}

/**
 * Check a list of mutations and print a report.
 *
 * @param {Array<object>} mutations - The mutations to check.
 * @returns {number} The number that did not behave as declared.
 */
export function checkMutations(mutations) {
  const results = mutations.map(checkOne)
  const wrong = results.filter((result) => !result.ok)

  process.stdout.write(`${JSON.stringify({
    results,
    total: results.length,
    asDeclared: results.length - wrong.length,
    wrong: wrong.map((result) => `${result.name}: ${result.outcome} — ${result.detail}`),
    verdict: wrong.length === 0
      ? `every mutation behaved as declared, and every file was restored`
      : `${wrong.length} of ${results.length} mutation(s) did not behave as declared`,
  }, null, 2)}\n`)

  return wrong.length
}
