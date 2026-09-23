/**
 * Test entry point: `npm test` / `node test/run.js`.
 *
 * Imports every `*.test.js` under `test/` into this process, then runs them
 * through `./harness.js`. Nothing is spawned — see the harness header for why
 * Node's built-in runner is not usable in a pipe-denying sandbox.
 *
 * A suite file may also be run directly (`node test/deps.test.js`) because each
 * one ends with a `main()` call guarded by a direct-invocation check.
 *
 * @module dsh-browser-bridge/test/run
 */

import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { registeredCount, runTests } from './harness.js'

const here = dirname(fileURLToPath(import.meta.url))

const suites = readdirSync(here)
  .filter((name) => name.endsWith('.test.js'))
  .sort()

if (suites.length === 0) {
  process.stderr.write('test/run: no *.test.js suites found\n')
  process.exitCode = 1
} else {
  process.stdout.write(`test/run: ${suites.length} suite(s): ${suites.join(', ')}\n\n`)
  // A suite that registers nothing is not a suite that passed. A file importing
  // `node:test` instead of this harness runs under a runner nobody is listening
  // to: it imports cleanly, contributes zero tests, and its assertions are never
  // evaluated — which is how 32 tests of the image route sat green for a round
  // while `npm test` reported a number that did not include them.
  const silent = []
  for (const name of suites) {
    const before = registeredCount()
    await import(pathToFileURL(join(here, name)).href)
    if (registeredCount() === before) silent.push(name)
  }
  if (silent.length > 0) {
    process.stderr.write(
      `test/run: ${silent.length} suite(s) registered no tests: ${silent.join(', ')}\n`
      + 'Each *.test.js must import { test } from the local harness, not node:test.\n',
    )
    process.exitCode = 1
  }
  const failed = await runTests()
  if (failed > 0) process.exitCode = 1
}
