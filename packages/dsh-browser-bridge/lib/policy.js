/**
 * Browser origin policy: the per-origin capability rules and how they resolve.
 *
 * The contract mirrors Codex's `browser_use` configuration, whose Rust schema
 * (`codex-rs/config/src/browser_use.rs`) admits exactly three fields —
 * `allow_history_access`, `default_origin_policy`, and `origins` — with a
 * per-origin policy limited to `access`, `downloads`, `uploads`, and
 * `full_cdp_access`. Copying that shape rather than inventing an allow-list
 * means the two systems answer "may the agent touch this site?" the same way,
 * and it keeps the settings UI honest: one rule table with two sides, not a
 * separate allow-list whose precedence would have to be re-derived.
 *
 * Three resolution rules, all measured against the published reference:
 *
 *   - Rule keys are `"<scheme>://<host-pattern>[:<port>]"` with `http` or
 *     `https`; exact hosts, `*.example.com` for subdomains only, and
 *     `**.example.com` for the apex plus subdomains. All other `*` wildcards
 *     span dots, so `region*.example.com` also matches `region.api.example.com`.
 *   - When several patterns match, the most restrictive value wins per
 *     capability: `deny` over `allow`, `false` over `true`, `turn` over `thread`.
 *   - `access = deny` also denies uploads, downloads, and full CDP access, and
 *     disables automatic review, on that origin.
 *
 * @module dsh-browser-bridge/policy
 */

/** Capabilities a per-origin policy can carry, in the schema's own order. */
export const CAPABILITIES = Object.freeze(['access', 'downloads', 'uploads', 'full_cdp_access'])

/** The two allow/deny values. */
export const DIRECTIONS = Object.freeze(['allow', 'deny'])

/** How long a non-persistent site approval lasts. */
export const LIFETIMES = Object.freeze(['turn', 'thread'])

/** Thrown when a rule key or policy value cannot be honoured as written. */
export class PolicySyntaxError extends Error {
  /**
   * @param {string} message - What is wrong, naming the exact offending value.
   */
  constructor(message) {
    super(message)
    this.name = 'PolicySyntaxError'
  }
}

/**
 * An origin policy with every field resolved. `access` is always present
 * because it is the gate every other capability sits behind; the rest default
 * to allowing ordinary approval and policy checks to continue, exactly as the
 * reference documents `allow`.
 *
 * @typedef {object} ResolvedPolicy
 * @property {'allow' | 'deny'} access
 * @property {'allow' | 'deny'} downloads
 * @property {'allow' | 'deny'} uploads
 * @property {'allow' | 'deny'} fullCdpAccess
 * @property {boolean} autoReview - Whether automatic review may run here.
 * @property {boolean} persistentApproval - Whether `Always allow` may be saved.
 * @property {'turn' | 'thread'} accessApprovalLifetime
 */

/**
 * The permissive default: normal approval flow, automatic review available,
 * persistent approval available, approvals scoped to the thread (the
 * documented product default).
 *
 * @returns {ResolvedPolicy} A fresh default policy object.
 */
export function defaultPolicy() {
  return {
    access: 'allow',
    downloads: 'allow',
    uploads: 'allow',
    fullCdpAccess: 'allow',
    autoReview: true,
    persistentApproval: true,
    accessApprovalLifetime: 'thread',
  }
}

/**
 * Map a rule's snake_case capability names onto the resolved policy's keys.
 * @param {string} capability - One of {@link CAPABILITIES}.
 * @returns {keyof ResolvedPolicy} The corresponding resolved field.
 */
function fieldOf(capability) {
  return capability === 'full_cdp_access' ? 'fullCdpAccess' : capability
}

/**
 * Strip an explicit default port, so `https://example.com:443` and
 * `https://example.com` are one origin. A non-default port is significant.
 *
 * @param {string} scheme - `http` or `https`.
 * @param {string} host - Hostname without a port.
 * @param {string | undefined} port - Port as written, when present.
 * @returns {string} The normalized `scheme://host[:port]` authority.
 */
function normalizeAuthority(scheme, host, port) {
  if (port === undefined || port.length === 0) return `${scheme}://${host}`
  const isDefault = (scheme === 'https' && port === '443') || (scheme === 'http' && port === '80')
  return isDefault ? `${scheme}://${host}` : `${scheme}://${host}:${port}`
}

/**
 * Parse a rule key into its scheme, host pattern, and port.
 *
 * The port is returned rather than absorbed so matching can require it to agree
 * with the target origin: a non-default port is significant, and
 * `http://localhost:8080` must not govern `http://localhost:5173`.
 *
 * Rejects everything the reference declares invalid — a non-http(s) scheme, a
 * wildcard scheme or port, embedded credentials, and any path, query, or
 * fragment — because a silently-ignored rule is an unenforced rule.
 *
 * @param {string} key - A rule key such as `https://**.example.com` or `http://localhost:5173`.
 * @returns {{ scheme: 'http' | 'https', hostPattern: string, port: string | undefined }} The parsed pattern.
 * @throws {PolicySyntaxError} When the key is not a valid origin pattern.
 */
export function parseRuleKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new PolicySyntaxError(`origin rule key must be a non-empty string, got ${JSON.stringify(key)}`)
  }
  const separator = key.indexOf('://')
  if (separator === -1) {
    throw new PolicySyntaxError(`origin rule ${JSON.stringify(key)} needs an http or https scheme, e.g. "https://example.com"`)
  }
  const scheme = key.slice(0, separator).toLowerCase()
  if (scheme !== 'http' && scheme !== 'https') {
    throw new PolicySyntaxError(`origin rule ${JSON.stringify(key)} uses scheme "${scheme}"; only http and https are supported`)
  }
  const rest = key.slice(separator + 3)
  if (rest.length === 0) {
    throw new PolicySyntaxError(`origin rule ${JSON.stringify(key)} has an empty host`)
  }
  if (rest.includes('/') || rest.includes('?') || rest.includes('#')) {
    throw new PolicySyntaxError(`origin rule ${JSON.stringify(key)} must not contain a path, query, or fragment`)
  }
  if (rest.includes('@')) {
    throw new PolicySyntaxError(`origin rule ${JSON.stringify(key)} must not embed credentials`)
  }
  if (rest.startsWith(':')) {
    throw new PolicySyntaxError(`origin rule ${JSON.stringify(key)} has a wildcard or missing host`)
  }

  const colon = rest.lastIndexOf(':')
  let hostPattern = rest
  /** @type {string | undefined} */
  let port
  if (colon !== -1) {
    const rawPort = rest.slice(colon + 1)
    hostPattern = rest.slice(0, colon)
    if (!/^\d{1,5}$/.test(rawPort)) {
      throw new PolicySyntaxError(`origin rule ${JSON.stringify(key)} has an invalid port; wildcard ports are not supported`)
    }
    // An explicit default port normalizes away, exactly as it does for a URL.
    const isDefault = (scheme === 'https' && rawPort === '443') || (scheme === 'http' && rawPort === '80')
    port = isDefault ? undefined : rawPort
  }
  if (hostPattern.length === 0 || hostPattern.includes(':')) {
    throw new PolicySyntaxError(`origin rule ${JSON.stringify(key)} has an invalid host pattern`)
  }
  return { scheme, hostPattern, port }
}

/**
 * Compile one host pattern into an anchored regular expression.
 *
 * The wildcards are translated over the whole host string rather than label by
 * label. A label-wise compiler cannot express `region*.example.com` matching
 * `region.api.example.com`, because that wildcard consumes a separator; working
 * on the string keeps each wildcard's own rule intact.
 *
 * The three rules, matching the reference's stated semantics:
 *   - `**.example.com` matches the apex and any subdomain: it compiles to
 *     `(?:label\.)*example\.com`, so zero repetitions reach the apex.
 *   - `*.example.com` matches subdomains only. A single `*` owns one whole label
 *     and may not cross a separator, so the apex — whose dot is the pattern's own
 *     literal one — cannot match.
 *   - Any other `*` spans separators, so `region*.example.com` reaches
 *     `region.api.example.com` while still requiring the wildcard to consume at
 *     least one character, which is why it does not match a bare `region`.
 *
 * @param {string} pattern - The host pattern from a rule key.
 * @returns {RegExp} An anchored matcher over a lowercased hostname.
 */
export function compileHostPattern(pattern) {
  const host = pattern.toLowerCase()
  if (host === '*') return /^.*$/

  /** One whole label. */
  const label = '[a-z0-9-]+'
  /** One label plus its separating dot — the unit `**` repeats. */
  const labelAndDot = `${label}\\.`
  /** What a `*` may reach: characters, separators, further labels. */
  const span = '[a-z0-9-]*(?:[.-][a-z0-9-]*)*'
  const escape = (literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  /**
   * Expand single `*` wildcards in a `**`-free fragment.
   *
   * A leading `*` owns a whole label and may not cross a separator — that is
   * exactly what keeps the apex out of `*.example.com`, since the apex's dot is
   * the pattern's own literal one. Every later `*` may cross separators but must
   * consume at least one character, which is why `region*.example.com` reaches
   * `region.api.example.com` without also matching a bare `region`.
   *
   * @param {string} fragment - Pattern text containing no `**`.
   * @returns {string} The fragment with each `*` replaced by its matcher.
   */
  const expandSingles = (fragment) => {
    const parts = fragment.split('*')
    let compiled = ''
    for (let index = 0; index < parts.length; index += 1) {
      const literal = escape(parts[index] ?? '')
      if (index === 0) {
        // `*` at the head of a fragment contributes the label its `**` repeats;
        // a non-empty literal already supplies those characters.
        compiled += literal.length > 0 ? literal : label
        continue
      }
      compiled += `${span}${literal}`
    }
    return compiled
  }

  // `**` means "zero or more labels". The cleanest reading is a prefix group
  // that repeats `label + dot`, made optional so the zero-label case reaches the
  // apex. The trick that keeps it correct is requiring at least one character
  // per repetition: a repetition that could match the empty string would let an
  // optional group satisfy a separator using the suffix's own dot.
  const parts = host.split('**')
  if (parts.length === 1) {
    const source = expandSingles(parts[0] ?? '')
    try {
      return new RegExp(`^${source}$`)
    } catch (error) {
      throw new PolicySyntaxError(`host pattern ${JSON.stringify(pattern)} did not compile: ${error.message}`)
    }
  }

  // Only non-empty `**`-separated fragments carry literal text. An adjacent `**`
  // or a leading one splits off an empty fragment, and feeding that empty string
  // back through `expandSingles` would manufacture a lone `*` — a mandatory
  // extra label the pattern never asked for. The substring before the last `**`
  // is expanded in one piece so its own wildcards keep their semantics.
  //
  // A `**` becomes zero or more `label + dot` repetitions. The tail must NOT
  // start with an escaped dot of its own: `split('**')` leaves that separator
  // inside the tail fragment, so `**.example.com` tails as `.example.com` and the
  // leading dot is dropped here before the tail is expanded.
  const headFragments = parts.slice(0, -1).filter((fragment) => fragment.length > 0)
  const head = headFragments.length > 0 ? expandSingles(headFragments.join('**')) : ''
  const rawTail = parts[parts.length - 1] ?? ''
  const tail = expandSingles(rawTail.startsWith('.') ? rawTail.slice(1) : rawTail)
  const source = `${head}(?:${labelAndDot})*${tail}`

  try {
    return new RegExp(`^${source}$`)
  } catch (error) {
    throw new PolicySyntaxError(`host pattern ${JSON.stringify(pattern)} did not compile: ${error.message}`)
  }
}

/**
 * Normalize the origin a tool call is acting on.
 *
 * @param {string} url - Any absolute http(s) URL.
 * @returns {string} The normalized `scheme://host[:port]` origin.
 * @throws {PolicySyntaxError} When the URL is not an http(s) URL.
 */
export function normalizeOrigin(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new PolicySyntaxError(`not an absolute URL: ${JSON.stringify(url)}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new PolicySyntaxError(`unsupported scheme ${JSON.stringify(parsed.protocol)}; only http and https are supported`)
  }
  const scheme = parsed.protocol.slice(0, -1)
  return normalizeAuthority(scheme, parsed.hostname.toLowerCase(), parsed.port.length > 0 ? parsed.port : undefined)
}

/**
 * Fold one rule's fields into an accumulating policy using the
 * most-restrictive-wins rule. Missing fields leave the accumulator untouched,
 * which is what lets a broad `**.example.com` rule and a narrow
 * `https://admin.example.com` rule compose.
 *
 * @param {ResolvedPolicy} accumulator - The policy built so far; mutated in place.
 * @param {Record<string, unknown>} rule - The rule's raw fields.
 * @param {string} origin - The origin being resolved, for error messages.
 */
function foldRule(accumulator, rule, origin) {
  for (const capability of CAPABILITIES) {
    const raw = rule[capability]
    if (raw === undefined) continue
    if (raw !== 'allow' && raw !== 'deny') {
      throw new PolicySyntaxError(
        `origin rule for ${origin}: "${capability}" must be "allow" or "deny", got ${JSON.stringify(raw)}`,
      )
    }
    const field = fieldOf(capability)
    // `deny` outranks `allow`, so an existing deny is never relaxed.
    if (accumulator[field] === 'deny') continue
    accumulator[field] = raw
  }

  if (rule.auto_review !== undefined) {
    if (typeof rule.auto_review !== 'boolean') {
      throw new PolicySyntaxError(`origin rule for ${origin}: "auto_review" must be a boolean, got ${JSON.stringify(rule.auto_review)}`)
    }
    // `false` outranks `true`.
    if (rule.auto_review === false) accumulator.autoReview = false
  }
  if (rule.persistent_approval !== undefined) {
    if (typeof rule.persistent_approval !== 'boolean') {
      throw new PolicySyntaxError(`origin rule for ${origin}: "persistent_approval" must be a boolean, got ${JSON.stringify(rule.persistent_approval)}`)
    }
    if (rule.persistent_approval === false) accumulator.persistentApproval = false
  }
  if (rule.access_approval_lifetime !== undefined) {
    const value = rule.access_approval_lifetime
    if (value !== 'turn' && value !== 'thread') {
      throw new PolicySyntaxError(`origin rule for ${origin}: "access_approval_lifetime" must be "turn" or "thread", got ${JSON.stringify(value)}`)
    }
    // `turn` outranks `thread`: the shorter grant is the safer one.
    if (value === 'turn') accumulator.accessApprovalLifetime = 'turn'
  }

  // A denied origin also loses every capability that sits behind access.
  if (accumulator.access === 'deny') {
    accumulator.downloads = 'deny'
    accumulator.uploads = 'deny'
    accumulator.fullCdpAccess = 'deny'
    accumulator.autoReview = false
  }
}

/**
 * Validate a whole rule table and resolve the policy for one origin.
 *
 * Both layers are accepted: the user layer carries only the four capability
 * fields, while the managed layer may add `auto_review`,
 * `persistent_approval`, and `access_approval_lifetime`. Every layer is folded
 * with most-restrictive-wins, so a user layer can tighten a managed allow but
 * can never relax a managed deny.
 *
 * Unknown fields are rejected rather than ignored, matching the reference's
 * `deny_unknown_fields` — a typo must fail loudly, not silently leave a rule
 * unenforced.
 *
 * @param {string} origin - A normalized origin, or any http(s) URL to normalize.
 * @param {object} [config] - The policy layers.
 * @param {Record<string, Record<string, unknown>>} [config.origins] - Rule table keyed by origin pattern.
 * @param {Record<string, unknown>} [config.defaultOriginPolicy] - Fallback fields.
 * @returns {ResolvedPolicy} The resolved policy for that origin.
 * @throws {PolicySyntaxError} When any consulted rule is malformed.
 */
export function resolveOriginPolicy(origin, config = {}) {
  const normalized = normalizeOrigin(origin)
  const parsedOrigin = new URL(normalized)
  const scheme = parsedOrigin.protocol.slice(0, -1)
  const host = parsedOrigin.hostname
  const port = parsedOrigin.port.length > 0 ? parsedOrigin.port : undefined

  const origins = config.origins ?? {}
  if (typeof origins !== 'object' || origins === null || Array.isArray(origins)) {
    throw new PolicySyntaxError('origins must be a table keyed by origin pattern')
  }

  const resolved = defaultPolicy()

  // A rule replaces the fallback for each field it defines, and several rules
  // combine with most-restrictive-wins. Deterministic evaluation order: keys
  // are sorted so a table rebuilt from JSON in a different key order resolves
  // identically.
  let matchedAny = false
  for (const key of Object.keys(origins).sort()) {
    const parsed = parseRuleKey(key)
    if (parsed.scheme !== scheme) continue
    if (parsed.port !== port) continue
    if (!compileHostPattern(parsed.hostPattern).test(host)) continue
    const rule = origins[key]
    if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) {
      throw new PolicySyntaxError(`origin rule ${JSON.stringify(key)} must be a table`)
    }
    assertKnownFields(rule, key)
    foldRule(resolved, rule, `${key} (matched ${normalized})`)
    matchedAny = true
  }

  // The fallback only governs origins no rule matched. Folding it unconditionally
  // would let a fallback `deny` outrank a rule that says `allow`, which is the
  // opposite of the documented "a matching origin rule replaces the fallback".
  if (!matchedAny) {
    const fallback = config.defaultOriginPolicy
    if (fallback !== undefined) {
      if (typeof fallback !== 'object' || fallback === null || Array.isArray(fallback)) {
        throw new PolicySyntaxError('defaultOriginPolicy must be a table of capability fields')
      }
      assertKnownFields(fallback, 'defaultOriginPolicy')
      foldRule(resolved, fallback, 'defaultOriginPolicy')
    }
  }

  return resolved
}

/**
 * The fields a rule may carry. The user layer and the managed layer admit
 * different subsets; this is their union, and `assertKnownFields` reports the
 * offending name so a typo is obvious.
 *
 * @param {Record<string, unknown>} rule - The rule to check.
 * @param {string} label - Where the rule came from, for the message.
 */
function assertKnownFields(rule, label) {
  const known = new Set([
    ...CAPABILITIES,
    'auto_review',
    'persistent_approval',
    'access_approval_lifetime',
  ])
  for (const field of Object.keys(rule)) {
    if (!known.has(field)) {
      throw new PolicySyntaxError(
        `origin rule ${JSON.stringify(label)} has unknown field ${JSON.stringify(field)}; expected one of ${[...known].join(', ')}`,
      )
    }
  }
}
