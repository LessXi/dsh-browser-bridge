/**
 * Site grants: what the user has allowed, for how long, and for which capability.
 *
 * This exists because the harness's approval service answers exactly one
 * question — "may I do this, right now?" — and returns a one-shot verdict. The
 * four choices a person expects from a browser agent (*once*, *for this site*,
 * *for every site*, *never*) are three different kinds of memory, and none of
 * them is a single yes. Keeping that memory here, layered on top of the
 * one-shot verdict, is what lets the approval prompt stay a real prompt instead
 * of a button that silently grants more than it says.
 *
 * Lifetime semantics, and one honest approximation:
 *
 *   - `thread` — for the rest of the session. Exact: it is keyed by session id.
 *   - `turn` — for the current turn. A turn boundary is not observable from a
 *     tool's context, so this is approximated by an idle gap: a grant expires
 *     once {@link TURN_IDLE_MS} passes with no browser action in that session.
 *     That is close to the intent (a turn ends when the agent stops acting) and
 *     errs toward asking again, never toward a longer grant.
 *
 * @module dsh-browser-bridge/grants
 */

/**
 * How long a `turn` grant survives without browser activity, in milliseconds.
 *
 * Five minutes is chosen to be comfortably longer than any single tool call and
 * far shorter than the gap between two things a person would call separate
 * turns. The direction of the error matters: expiring early costs one extra
 * prompt, expiring late would grant access the user did not intend.
 */
export const TURN_IDLE_MS = 5 * 60_000

/** The capability a grant can cover, matching the per-origin policy fields. */
export const GRANT_CAPABILITIES = Object.freeze(['access', 'uploads', 'downloads', 'full_cdp_access'])

/**
 * In-memory grant table.
 *
 * Deliberately not persisted. A grant is a statement about the session that
 * asked for it, and a harness restart has no way to verify the user is still
 * watching the same task — asking again is the safe default, and the cost is
 * one prompt.
 */
export class GrantTable {
  /** @type {Map<string, { origin: string, sessionId: string, capabilities: Set<string>, lifetime: 'turn' | 'thread', persistent: boolean, grantedAt: number, lastUsedAt: number }>} */
  #grants = new Map()
  /** @type {() => number} */
  #now

  /**
   * @param {{ now?: () => number }} [options] - Clock injection for tests.
   */
  constructor(options = {}) {
    this.#now = options.now ?? (() => Date.now())
  }

  /**
   * Compose the table key.
   * @param {string} sessionId - The session the grant belongs to.
   * @param {string} origin - The normalized origin.
   * @param {string} capability - One of {@link GRANT_CAPABILITIES}.
   * @returns {string} The key.
   */
  static key(sessionId, origin, capability) {
    return `${sessionId}\u0000${origin}\u0000${capability}`
  }

  /**
   * Drop every grant that is no longer valid.
   *
   * Called before each lookup rather than on a timer: a grant's validity only
   * matters when something asks, and a background timer in a plugin is one more
   * thing that can leak.
   *
   * @returns {number} How many grants were dropped.
   */
  sweep() {
    const now = this.#now()
    let dropped = 0
    for (const [key, grant] of this.#grants) {
      if (grant.lifetime === 'thread') continue
      if (now - grant.lastUsedAt <= TURN_IDLE_MS) continue
      this.#grants.delete(key)
      dropped += 1
    }
    return dropped
  }

  /**
   * Find a grant covering one capability on one origin.
   *
   * A grant for `access` also covers the capabilities that sit behind it, which
   * mirrors the policy engine's cascade: releasing uploads without releasing
   * access would ask the user to approve reading a site they just approved.
   *
   * @param {string} sessionId - The session asking.
   * @param {string} origin - The normalized origin.
   * @param {string} capability - The capability needed.
   * @returns {{ origin: string, capability: string, lifetime: 'turn' | 'thread', persistent: boolean, grantedAt: number } | undefined}
   *   The covering grant, if any.
   */
  find(sessionId, origin, capability) {
    this.sweep()
    const direct = this.#grants.get(GrantTable.key(sessionId, origin, capability))
    if (direct !== undefined) {
      direct.lastUsedAt = this.#now()
      return { ...direct, capability }
    }
    if (capability !== 'access') {
      const viaAccess = this.#grants.get(GrantTable.key(sessionId, origin, 'access'))
      if (viaAccess !== undefined) {
        viaAccess.lastUsedAt = this.#now()
        return { ...viaAccess, capability }
      }
    }
    return undefined
  }

  /**
   * Whether any grant covers this capability.
   * @param {string} sessionId - The session asking.
   * @param {string} origin - The normalized origin.
   * @param {string} capability - The capability needed.
   * @returns {boolean} True when a grant covers it.
   */
  covers(sessionId, origin, capability) {
    return this.find(sessionId, origin, capability) !== undefined
  }

  /**
   * Record a grant.
   *
   * @param {object} input - What was granted.
   * @param {string} input.sessionId - The session the grant belongs to.
   * @param {string} input.origin - The normalized origin.
   * @param {string[]} [input.capabilities] - Capabilities; defaults to `['access']`.
   * @param {'turn' | 'thread'} [input.lifetime] - How long it lasts.
   * @param {boolean} [input.persistent] - Whether it was recorded as "always allow".
   * @returns {void}
   */
  record(input) {
    const capabilities = input.capabilities ?? ['access']
    const lifetime = input.lifetime ?? 'thread'
    const now = this.#now()
    for (const capability of capabilities) {
      if (!GRANT_CAPABILITIES.includes(capability)) continue
      this.#grants.set(GrantTable.key(input.sessionId, input.origin, capability), {
        origin: input.origin,
        sessionId: input.sessionId,
        capabilities: new Set([capability]),
        lifetime,
        persistent: input.persistent === true,
        grantedAt: now,
        lastUsedAt: now,
      })
    }
  }

  /**
   * Revoke every grant for one origin in one session.
   * @param {string} sessionId - The session.
   * @param {string} origin - The normalized origin.
   * @returns {number} How many grants were removed.
   */
  revoke(sessionId, origin) {
    let removed = 0
    for (const capability of GRANT_CAPABILITIES) {
      if (this.#grants.delete(GrantTable.key(sessionId, origin, capability))) removed += 1
    }
    return removed
  }

  /**
   * List the live grants, for the settings panel.
   * @param {string} [sessionId] - Restrict to one session.
   * @returns {object[]} One row per grant, newest first.
   */
  list(sessionId) {
    this.sweep()
    const rows = []
    for (const grant of this.#grants.values()) {
      if (sessionId !== undefined && grant.sessionId !== sessionId) continue
      rows.push({
        sessionId: grant.sessionId,
        origin: grant.origin,
        capabilities: [...grant.capabilities],
        lifetime: grant.lifetime,
        persistent: grant.persistent,
        grantedAt: grant.grantedAt,
      })
    }
    return rows.sort((left, right) => right.grantedAt - left.grantedAt)
  }

  /** Remove everything. Used on plugin disposal. */
  clear() {
    this.#grants.clear()
  }
}

/**
 * The user's choices at an approval prompt, in the order they are offered.
 *
 * A closed union rather than free strings so the prompt, the grant table, and
 * the tests cannot drift apart on a spelling.
 */
export const APPROVAL_CHOICES = Object.freeze([
  'allow-once',
  'allow-for-site',
  'allow-for-all-sites',
  'decline',
])

/**
 * Classify an action for the second-confirmation tier.
 *
 * The host asks a second time for these even inside an approved origin: a site
 * the user allowed to *read* is not a site they allowed to *spend money on*.
 *
 * @param {{ tool: string, args?: Record<string, unknown> }} action - The pending action.
 * @returns {{ sensitive: boolean, reason?: string }} The verdict.
 */
export function classifySensitivity(action) {
  const tool = action.tool ?? ''
  if (tool === 'browser_upload') {
    return { sensitive: true, reason: 'uploads a file from your computer' }
  }
  if (tool === 'browser_eval' || tool === 'browser_cdp') {
    return { sensitive: true, reason: 'runs code in the page through the debugger' }
  }
  if (tool === 'browser_click') {
    const text = String(action.args?.text ?? '').toLowerCase()
    const selector = String(action.args?.selector ?? '').toLowerCase()
    const haystack = `${text} ${selector}`
    const words = SENSITIVE_WORDS.filter((word) => haystack.includes(word))
    if (words.length > 0) {
      return { sensitive: true, reason: `looks like it submits or spends ("${words[0]}")` }
    }
  }
  if (tool === 'browser_type') {
    const selector = String(action.args?.selector ?? '').toLowerCase()
    const words = SENSITIVE_WORDS.filter((word) => selector.includes(word))
    if (words.length > 0) {
      return { sensitive: true, reason: `types into a control that looks like "${words[0]}"` }
    }
  }
  return { sensitive: false }
}

/**
 * Words that mark a control as consequential.
 *
 * Intentionally mechanical and visible rather than clever: the model is told
 * which of its actions will ask twice, so it can route around the extra prompt
 * when the action is genuinely harmless.
 */
export const SENSITIVE_WORDS = Object.freeze([
  'submit', 'purchase', 'buy', 'pay', 'checkout', 'order', 'confirm', 'delete',
  'remove', 'transfer', 'send money', 'subscribe', 'unsubscribe', 'cancel',
  'publish', 'post', 'grant', 'permission', 'settings', 'password', 'sign out',
  'logout', 'revoke',
])
