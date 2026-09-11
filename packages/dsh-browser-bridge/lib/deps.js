/**
 * Runtime resolution of peer dependencies for a third-party DSH profile plugin.
 *
 * A plugin installed with `dsh plugin --profile web add <path>` is linked into
 * `$DSH_HOME/profiles/node_modules`, where it shares one hoisted module tree
 * with the harness itself. This package deliberately declares nothing beyond
 * `ws`, and resolves everything else at runtime so the source tree can be read
 * and edited without a build step:
 *
 *   1. the ordinary specifier first — this hits in a checkout that ran pnpm
 *      install, so editors and tests see the real modules;
 *   2. otherwise the harnesses own module tree, located from `$DSH_HOME`
 *      (`DSH_HOME`, else `~/.dsh`).
 *
 * Both branches use the same `file:` URL derived from `createRequire`, so a
 * resolution failure is reported once, in one place, with the profile path in
 * the message.
 *
 * @module dsh-browser-bridge/deps
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Resolver anchored at this module. */
const require = createRequire(import.meta.url)

/**
 * The harness home directory: `DSH_HOME`, else `~/.dsh`.
 * @returns {string} Absolute path of the harness home.
 */
export function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.length > 0) return configured
  return join(homedir(), '.dsh')
}

/**
 * Candidate module trees, in resolution order.
 *
 * The first entry is the ordinary specifier (no base). The profile trees follow
 * so an uninstalled or partially linked dependency still resolves the way the
 * running harness resolves it.
 *
 * @returns {string[]} Absolute `node_modules` directories, most specific first.
 */
function moduleTrees() {
  const home = dshHome()
  return [
    join(home, 'profiles', 'node_modules'),
    join(home, 'profiles', 'web', 'node_modules'),
    join(home, 'node_modules'),
  ]
}

/**
 * Locate one package inside a module tree, tolerating both a flat tree and the
 * `@scope/name` nesting every registry uses.
 *
 * @param {string} tree - Absolute `node_modules` directory.
 * @param {string} specifier - Bare package name, optionally `@scope/name`.
 * @returns {string | undefined} Absolute package directory, when present.
 */
function locateInTree(tree, specifier) {
  const candidate = join(tree, ...specifier.split('/'))
  return existsSync(join(candidate, 'package.json')) ? candidate : undefined
}

/**
 * Resolve a bare specifier to an importable URL.
 *
 * @param {string} specifier - Bare package name, optionally `@scope/name`.
 * @returns {string} A `file:` URL safe to pass to a dynamic `import()`.
 * @throws {Error} When the specifier resolves in neither branch, naming every
 *   tree that was consulted so the fix (install the plugin, or run pnpm install
 *   in this checkout) is obvious from the message alone.
 */
export function resolvePeer(specifier) {
  try {
    return require.resolve(specifier)
  } catch {
    // Fall through to the harness trees below.
  }
  const trees = moduleTrees()
  for (const tree of trees) {
    const dir = locateInTree(tree, specifier)
    if (dir === undefined) continue
    try {
      return require.resolve(dir)
    } catch {
      return dir
    }
  }
  throw new Error(
    `dsh-browser-bridge: cannot resolve "${specifier}". Looked for the ordinary specifier, then: ${trees.join(', ')}. `
    + 'Install the plugin into a profile (`dsh plugin --profile web add <path>`) or run pnpm install in this checkout.',
  )
}

/**
 * Import a peer dependency by specifier.
 *
 * @param {string} specifier - Bare package name, optionally `@scope/name`.
 * @returns {Promise<Record<string, unknown>>} The module namespace object.
 */
export async function loadPeer(specifier) {
  return import(pathToFileURL(resolvePeer(specifier)).href)
}

/**
 * Import one subpath of a peer dependency.
 *
 * Subpath exports of a package resolve relative to the package directory, but
 * those directories sit inside a module tree whose siblings Node cannot see
 * from a bare absolute path. Resolving the subpath through the tree's own
 * resolver first keeps `exports` maps (and their conditions) authoritative.
 *
 * @param {string} specifier - Bare package name, optionally `@scope/name`.
 * @param {string} subpath - Exported subpath, without a leading `./`.
 * @returns {Promise<Record<string, unknown>>} The module namespace object.
 */
export async function loadPeerSubpath(specifier, subpath) {
  const spec = `${specifier}/${subpath}`
  return loadPeer(spec)
}
