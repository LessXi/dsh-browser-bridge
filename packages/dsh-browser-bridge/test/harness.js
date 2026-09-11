/**
 * A minimal in-process test harness.
 *
 * Node's built-in runner is unusable here: `node --test` always executes each
 * suite in a forked child whose stdio is a pipe, and a sandbox that denies pipe
 * creation fails that fork with `spawn EPERM` before a single assertion runs —
 * regardless of `NODE_TEST_ISOLATION`, `NODE_TEST_PARALLEL`, or how the parent
 * was launched. Escalating an environment permission to run `assert.equal` is
 * not a trade worth making, so this harness runs suites in one process and
 * spawns nothing.
 *
 * It deliberately offers only what these suites use: synchronous `test(name,
 * fn)`, a `beforeEach`, and `assert` re-exported from `node:assert/strict`.
 * Async bodies are awaited by the runner, so a suite may be `async`.
 *
 * @module dsh-browser-bridge/test/harness
 */

import assert from 'node:assert/strict'

/** @type {{ name: string, body: (t: TestContext) => unknown, skip: boolean }[]} */
const registered = []

/** @type {((t: TestContext) => unknown)[]} */
let beforeEachHooks = []

/**
 * Per-test context handed to a suite body. Kept intentionally tiny: enough to
 * express setup and a soft skip without inventing a framework.
 */
class TestContext {
  /** @type {(() => void | Promise<void>)[]} */
  #cleanups = []
  /** @type {string | undefined} */
  skipReason

  /**
   * Register a teardown that runs even when the body throws.
   *
   * A teardown may be async, which matters for this suite: a test that opens a
   * listening socket or a websocket must close it, or the process never exits
   * and the whole run appears to hang.
   *
   * @param {() => void | Promise<void>} dispose - The cleanup to run.
   */
  onCleanup(dispose) {
    this.#cleanups.push(dispose)
  }

  /** Run every registered teardown, collecting failures rather than stopping. */
  async runCleanups() {
    /** @type {unknown[]} */
    const failures = []
    for (const dispose of this.#cleanups.reverse()) {
      try {
        await dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    this.#cleanups = []
    return failures
  }

  /**
   * Mark this test as skipped.
   * @param {string} [reason] - Why the test cannot run here.
   */
  skip(reason) {
    this.skipReason = reason ?? 'skipped'
  }
}

/**
 * Register one test.
 * @param {string} name - Human-readable test name.
 * @param {(t: TestContext) => unknown} body - The test body; may be async.
 */
export function test(name, body) {
  registered.push({ name, body, skip: false })
}

/** Register a hook that runs before each test. */
export function beforeEach(hook) {
  beforeEachHooks.push(hook)
}

export { assert }

/**
 * Run every registered test and report to the console.
 *
 * A body may return a promise; the runner awaits it. Cleanup failures are
 * reported as test failures so a leaking temp file cannot pass silently.
 *
 * @returns {Promise<number>} The number of failed tests.
 */
export async function runTests() {
  let passed = 0
  let failed = 0
  let skipped = 0

  for (const entry of registered) {
    const context = new TestContext()
    try {
      for (const hook of beforeEachHooks) await hook(context)
      await entry.body(context)
    } catch (error) {
      const cleanups = await context.runCleanups()
      failed += 1
      process.stdout.write(`✖ ${entry.name}\n`)
      process.stdout.write(`  ${error?.message ?? error}\n`)
      for (const cleanupError of cleanups) {
        process.stdout.write(`  cleanup also failed: ${cleanupError?.message ?? cleanupError}\n`)
      }
      continue
    }

    const cleanups = await context.runCleanups()
    if (context.skipReason !== undefined) {
      skipped += 1
      process.stdout.write(`○ ${entry.name} — ${context.skipReason}\n`)
      continue
    }
    if (cleanups.length > 0) {
      failed += 1
      process.stdout.write(`✖ ${entry.name}\n`)
      for (const cleanupError of cleanups) {
        process.stdout.write(`  cleanup failed: ${cleanupError?.message ?? cleanupError}\n`)
      }
      continue
    }
    passed += 1
    process.stdout.write(`✔ ${entry.name}\n`)
  }

  process.stdout.write(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`)
  return failed
}

/**
 * Run the suite and set the process exit code, for use as a module footer.
 * @returns {Promise<void>} Resolves once the process exit code is set.
 */
export async function main() {
  const failed = await runTests()
  if (failed > 0) process.exitCode = 1
}
