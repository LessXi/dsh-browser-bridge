/**
 * Translation from this package's settings descriptors into the host's schema.
 *
 * `config.js` describes settings as plain data so nothing here needs a build
 * step or a hard import of a specific harness version. This module turns those
 * descriptors into whatever the settings service accepts, and falls back to
 * plain defaults when the service is absent — which is what happens in the
 * headless and TUI profiles.
 *
 * @module dsh-browser-bridge/settings
 */

import { MANAGED_NAMESPACE, USER_NAMESPACE, managedSchemaFields, userSchemaFields } from './config.js'

/**
 * Build a schema object for one descriptor using an injected schema factory.
 *
 * The factory is passed in rather than imported so the caller decides which
 * schema library is authoritative; this package only describes intent.
 *
 * @param {object} schemastery - The host's schema library (`z`).
 * @param {{ type: string, default: unknown, description: string }} field - One descriptor.
 * @returns {unknown} A schema node for that field.
 */
function fieldSchema(schemastery, field) {
  const description = field.description
  switch (field.type) {
    case 'boolean':
      return schemastery.boolean().default(Boolean(field.default)).description(description)
    case 'number':
      return schemastery.number().default(Number(field.default)).description(description)
    case 'string':
      return schemastery.string().default(String(field.default)).description(description)
    case 'object':
      return schemastery.dict(schemastery.any()).default(field.default).description(description)
    default:
      return schemastery.any().default(field.default).description(description)
  }
}

/**
 * Build a full object schema from a descriptor map.
 *
 * @param {object} schemastery - The host's schema library.
 * @param {Record<string, { type: string, default: unknown, description: string }>} fields - The descriptors.
 * @returns {unknown} The object schema.
 */
export function objectSchema(schemastery, fields) {
  const shape = {}
  for (const [key, field] of Object.entries(fields)) shape[key] = fieldSchema(schemastery, field)
  return schemastery.object(shape)
}

/**
 * Register both settings namespaces and return a reader for the resolved values.
 *
 * Registration is best-effort: when the settings service is absent, the reader
 * still answers with the schema defaults so tools behave identically and only
 * the settings card is missing. The returned `registered` flag exists so that
 * absence is *visible* — the health route reports it, because a silently absent
 * settings card is otherwise indistinguishable from a UI bug.
 *
 * @param {object} ctx - The plugin context, which must already carry `settings`.
 * @param {object} schemastery - The host's schema library.
 * @returns {{ read: () => { user: Record<string, unknown>, managed: Record<string, unknown> }, registered: boolean, dispose: () => void }}
 *   The reader, whether registration happened, and a disposer.
 * @throws {Error} When a registration fails for a reason other than absence —
 *   a malformed origin rule must surface at load, not at first tool call.
 */
export function registerSettings(ctx, schemastery) {
  const userFields = userSchemaFields()
  const managedFields = managedSchemaFields()
  const defaults = {
    user: Object.fromEntries(Object.entries(userFields).map(([key, field]) => [key, field.default])),
    managed: Object.fromEntries(Object.entries(managedFields).map(([key, field]) => [key, field.default])),
  }

  // `ctx.get(name)` is the optional-read form: reading `ctx.settings` directly
  // THROWS when the service is absent, so a guard written as
  // `ctx.settings !== undefined` throws before it can evaluate.
  //
  // This branch is a fallback, not the primary wiring. The caller reaches here
  // from inside `ctx.inject(['settings'], ...)`, because the settings provider
  // only becomes injectable after its document loads — a plugin composed before
  // that would find nothing here and lose its settings card with no error.
  const service = ctx.get?.('settings')
  if (service === undefined || typeof service.register !== 'function') {
    return { read: () => defaults, registered: false, dispose: () => {} }
  }

  const disposers = []
  let userScope
  let managedScope

  try {
    userScope = service.register(USER_NAMESPACE, objectSchema(schemastery, userFields))
    disposers.push(() => userScope?.dispose?.())
  } catch (error) {
    // A registration failure here means a stored section does not satisfy the
    // schema. Surfacing it at load is the point: silently falling back to
    // defaults would hide a misconfigured origin rule that decides access.
    throw new Error(`dsh-browser-bridge: could not register settings namespace "${USER_NAMESPACE}": ${error.message}`)
  }
  try {
    managedScope = service.register(MANAGED_NAMESPACE, objectSchema(schemastery, managedFields))
    disposers.push(() => managedScope?.dispose?.())
  } catch {
    // The managed namespace is optional: a deployment that does not expose it
    // simply keeps the schema defaults, which is the permissive ceiling.
    managedScope = undefined
  }

  const readScope = (scope, fallback) => {
    if (scope === undefined) return fallback
    try {
      const value = scope.value
      if (typeof value !== 'object' || value === null) return fallback
      return { ...fallback, ...value }
    } catch {
      return fallback
    }
  }

  return {
    read: () => ({
      user: readScope(userScope, defaults.user),
      managed: readScope(managedScope, defaults.managed),
    }),
    registered: true,
    dispose: () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          // A registration that is already gone is not an error worth raising.
        }
      }
    },
  }
}
