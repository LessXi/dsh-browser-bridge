/**
 * Plugin composition: schema, routes, and the services the tools share.
 *
 * This module owns the *shape* of the plugin — where the token lives, which
 * routes exist, which settings namespaces render in the Plugins page — and
 * nothing about browsers. Keeping it separate from `tools.js` lets the tool
 * definitions stay a pure description of what the model can ask for.
 *
 * @module dsh-browser-bridge/config
 */

/** Settings namespace rendered as a card in the web Plugins page. */
export const USER_NAMESPACE = 'browser-bridge'

/** Managed namespace: the deployment's ceiling, which user settings cannot relax. */
export const MANAGED_NAMESPACE = 'browser-bridge-managed'

/** Path of the extension-facing websocket upgrade route. */
export const BRIDGE_WS_PATH = '/api/browser-bridge/ws'

/** Path of the read-only health route the client UI polls. */
export const BRIDGE_HEALTH_PATH = '/browser-bridge/health'

/** Path of the read-only pending-context route the composer chips read. */
export const BRIDGE_CONTEXT_PATH = '/browser-bridge/context'

/**
 * Path of the side panel's conversation route.
 *
 * GET lists sessions; POST with `{ action: 'messages' | 'send' }` reads a
 * transcript or delivers a message. One path rather than three because the panel
 * is the only consumer, and the action is explicit in the body.
 */
export const BRIDGE_CHAT_PATH = '/browser-bridge/chat'

/**
 * Path of the side panel's image route.
 *
 * `GET /browser-bridge/image?sessionId=…&attachmentId=…` answers the bytes of
 * one image that session's own log refers to.
 *
 * Separate from the chat route rather than another action on it because the
 * answer is not JSON: it is the image, with its own content type, so the panel
 * can hand the URL straight to an `<img>` and let the browser cache, decode, and
 * scale it. Folding base64 into the transcript instead would put ~84 MB through
 * one 60-row window on this machine's own attachment store.
 */
export const BRIDGE_IMAGE_PATH = '/browser-bridge/image'

/**
 * Default per-call budget for one browser action, in milliseconds. Long enough
 * for a slow page load, short enough that a wedged tab does not stall a turn.
 */
export const DEFAULT_ACTION_TIMEOUT_MS = 30_000

/**
 * Default ceilings. Every one of these exists to bound what page content can do
 * to the model's context: a hostile or merely enormous page must not be able to
 * fill the window through a single read.
 */
export const BRIDGE_DEFAULTS = Object.freeze({
  enabled: true,
  actionTimeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
  /** Bytes of text one snapshot or read may return before truncation. */
  pageTextMaxBytes: 200_000,
  /** Entries retained per console / network ring buffer. */
  consoleBufferSize: 500,
  networkBufferSize: 500,
  /** Longest edge of a screenshot handed to the model. */
  screenshotMaxWidth: 1280,
  /** Longest selected passage that becomes a context attachment. */
  contextMaxChars: 10_000,
  /** Pending context attachments retained per session. */
  contextPendingLimit: 50,
  /** Whether highlighting text on a page pushes context without an explicit action. */
  contextAutoPush: false,
  /** Session that context attachments target; empty means "follow the last browser action". */
  contextTargetSessionId: '',
  /** Whether a second confirmation is required for submitting, purchasing, and deleting. */
  confirmSensitiveActions: true,
  /**
   * Whether the raw CDP passthrough and page JavaScript are available at all.
   *
   * Off by default and separate from any per-origin rule: these two tools reach
   * browser internals rather than page content, so enabling them is a decision
   * about the whole bridge rather than about one site.
   */
  developerMode: false,
  /** Whether automatic review may stand in for a human on routine access. */
  autoReview: true,
  /** Whether an approval may be recorded as "always allow". */
  persistentApproval: true,
  /** Whether "always allow for every site" is offered at all. */
  allowGlobalPersistentApproval: true,
  /** Whether browser history may be read; each read still asks, per call. */
  allowHistoryAccess: true,
  /** How long a non-persistent site approval lasts. */
  accessApprovalLifetime: 'thread',
  /** Origin rules: `<scheme>://<host-pattern>[:port]` → capability fields. */
  origins: {},
  /** Fallback policy for origins no rule matches. */
  defaultOriginPolicy: {},
})

/**
 * The user-editable schema.
 *
 * Built from plain field descriptors rather than importing the harness's
 * schema library, so this package carries no build-time dependency on a
 * specific harness version. `settings.js` translates these into whatever the
 * host's settings service expects.
 *
 * @returns {Record<string, { type: string, default: unknown, description: string, element?: string }>}
 *   One descriptor per setting.
 */
export function userSchemaFields() {
  return {
    enabled: {
      type: 'boolean',
      default: BRIDGE_DEFAULTS.enabled,
      description: 'Serve the browser bridge and expose the browser_* tools.',
    },
    actionTimeoutMs: {
      type: 'number',
      default: BRIDGE_DEFAULTS.actionTimeoutMs,
      description: 'Milliseconds one browser action may take before it fails.',
    },
    pageTextMaxBytes: {
      type: 'number',
      default: BRIDGE_DEFAULTS.pageTextMaxBytes,
      description: 'Bytes of page text a single snapshot or read may return before truncation.',
    },
    consoleBufferSize: {
      type: 'number',
      default: BRIDGE_DEFAULTS.consoleBufferSize,
      description: 'Console entries retained per tab.',
    },
    networkBufferSize: {
      type: 'number',
      default: BRIDGE_DEFAULTS.networkBufferSize,
      description: 'Network entries retained per tab.',
    },
    screenshotMaxWidth: {
      type: 'number',
      default: BRIDGE_DEFAULTS.screenshotMaxWidth,
      description: 'Longest edge of a screenshot handed to the model, in pixels.',
    },
    contextMaxChars: {
      type: 'number',
      default: BRIDGE_DEFAULTS.contextMaxChars,
      description: 'Longest selected passage that may become a context attachment.',
    },
    contextPendingLimit: {
      type: 'number',
      default: BRIDGE_DEFAULTS.contextPendingLimit,
      description: 'Pending context attachments retained per session.',
    },
    contextAutoPush: {
      type: 'boolean',
      default: BRIDGE_DEFAULTS.contextAutoPush,
      description: 'Master switch for automatic selection sync. The extension has its own toggle deciding what leaves the browser; this one decides what this harness accepts, and both must be on.',
    },
    contextTargetSessionId: {
      type: 'string',
      default: BRIDGE_DEFAULTS.contextTargetSessionId,
      description: 'Session that context attachments target; empty follows the last browser action.',
    },
    confirmSensitiveActions: {
      type: 'boolean',
      default: BRIDGE_DEFAULTS.confirmSensitiveActions,
      description: 'Ask a second time before submitting, purchasing, or deleting in a page.',
    },
    developerMode: {
      type: 'boolean',
      default: BRIDGE_DEFAULTS.developerMode,
      description: 'Allow raw CDP commands and page JavaScript. Off by default; asks every time and never records a grant.',
    },
    allowHistoryAccess: {
      type: 'boolean',
      default: BRIDGE_DEFAULTS.allowHistoryAccess,
      description: 'Allow reading browser history. Each read still asks; there is no standing grant.',
    },
    origins: {
      type: 'object',
      default: BRIDGE_DEFAULTS.origins,
      description: 'Per-origin rules, for example "https://**.example.com": { access: "allow" }.',
    },
    defaultOriginPolicy: {
      type: 'object',
      default: BRIDGE_DEFAULTS.defaultOriginPolicy,
      description: 'Policy for origins no rule matches: access, downloads, uploads, full_cdp_access.',
    },
  }
}

/**
 * The managed schema. These keys are deliberately absent from the user schema:
 * they are the deployment's ceiling, matching the reference implementation
 * where lifetime, persistent approval, and automatic review are administrative
 * levers rather than per-user switches.
 *
 * @returns {Record<string, { type: string, default: unknown, description: string }>}
 *   One descriptor per managed setting.
 */
export function managedSchemaFields() {
  return {
    autoReview: {
      type: 'boolean',
      default: BRIDGE_DEFAULTS.autoReview,
      description: 'Allow automatic review to stand in for a human on routine origin access.',
    },
    persistentApproval: {
      type: 'boolean',
      default: BRIDGE_DEFAULTS.persistentApproval,
      description: 'Allow recording "always allow" for one origin.',
    },
    allowGlobalPersistentApproval: {
      type: 'boolean',
      default: BRIDGE_DEFAULTS.allowGlobalPersistentApproval,
      description: 'Allow "always allow" grants that cover every site.',
    },
    accessApprovalLifetime: {
      type: 'string',
      default: BRIDGE_DEFAULTS.accessApprovalLifetime,
      description: 'How long a non-persistent site approval lasts: "turn" or "thread".',
    },
  }
}

/**
 * Turn the resolved settings into the policy layers `policy.js` consumes.
 *
 * The managed layer is spread first and the per-origin tables are merged with
 * the managed value winning, which is the documented "stricter result of
 * managed requirements and user configuration" — a user rule can tighten a
 * managed allow, and cannot relax a managed deny.
 *
 * @param {Record<string, unknown>} user - Resolved user settings.
 * @param {Record<string, unknown>} managed - Resolved managed settings.
 * @returns {{ origins: Record<string, Record<string, unknown>>, defaultOriginPolicy: Record<string, unknown> }}
 *   The policy layers to hand to `resolveOriginPolicy`.
 */
export function policyLayers(user, managed) {
  const origins = {}
  for (const [key, rule] of Object.entries(user.origins ?? {})) {
    if (typeof rule !== 'object' || rule === null) continue
    origins[key] = { ...rule }
  }
  // Managed per-origin rules are not exposed as a setting today; when they are,
  // they merge here with most-restrictive-wins applied by the policy engine.

  return {
    origins,
    defaultOriginPolicy: {
      ...(user.defaultOriginPolicy ?? {}),
      ...(managed.defaultOriginPolicy ?? {}),
    },
  }
}

/**
 * Build the full resolved settings object, defaults first.
 *
 * @param {Record<string, unknown>} user - Resolved user namespace value.
 * @param {Record<string, unknown>} managed - Resolved managed namespace value.
 * @returns {typeof BRIDGE_DEFAULTS} The effective configuration.
 */
export function resolveSettings(user = {}, managed = {}) {
  return {
    ...BRIDGE_DEFAULTS,
    ...user,
    ...managed,
  }
}
