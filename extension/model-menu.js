/**
 * What the model picker shows, decided without a DOM.
 *
 * This lives on the extension side rather than beside the host's chat service
 * because the panel cannot reach it: the side panel runs from a
 * `chrome-extension://` origin and can only load files inside the extension
 * directory, so a module under `packages/` is not importable no matter how
 * convenient it would be to keep both halves together.
 *
 * It is still a plain module with no DOM access, which is the point: the menu is
 * otherwise DOM code that the Node test runner cannot exercise, and grouping,
 * the checked flags and every empty case are the parts that actually break.
 *
 * @module extension/model-menu
 */

/**
 * A trimmed string, or an empty one.
 *
 * @param {unknown} value - Anything the host sent.
 * @returns {string} The text, or ''.
 */
function asText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Find one model in a catalog.
 *
 * @param {object|null} catalog - The catalog from the host's `models` action.
 * @param {string} provider - The provider id.
 * @param {string} model - The provider-owned model id.
 * @returns {object|undefined} The catalog entry.
 */
function findModel(catalog, provider, model) {
  for (const group of Array.isArray(catalog?.groups) ? catalog.groups : []) {
    if (asText(group?.id) !== provider) continue
    for (const entry of Array.isArray(group?.models) ? group.models : []) {
      if (asText(entry?.id) === model) return entry
    }
  }
  return undefined
}

/**
 * The deployment's own selection, used when a session has not chosen one.
 *
 * A session that has never had a model picked for it still runs *something*, and
 * this is how the trigger can say what that is instead of going blank.
 *
 * @param {object|null} catalog - The catalog.
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | null} A selection-shaped value, or null.
 */
function catalogDefault(catalog) {
  const fallback = catalog?.default
  if (fallback === null || typeof fallback !== 'object') return null
  const provider = asText(fallback.provider)
  const model = asText(fallback.model)
  if (provider.length === 0 || model.length === 0) return null
  const reasoningEffort = asText(fallback.reasoningEffort)
  return { provider, model, ...(reasoningEffort.length > 0 ? { reasoningEffort } : {}) }
}

/**
 * The text a composer trigger shows for one session's model.
 *
 * The effort is appended only when the selection carries one, so a model that
 * offers no effort levels reads as a bare name rather than a dangling separator.
 * A selection naming a model the catalog does not list — a model that was
 * removed, or a session last used on another machine — still renders its raw id
 * rather than nothing, because the session really is using it.
 *
 * @param {object|null} catalog - The catalog from the host's `models` action.
 * @param {{ provider: string, model: string, reasoningEffort?: string } | null} selection - The session's selection.
 * @returns {string} The label, empty when there is nothing to say.
 */
export function modelLabel(catalog, selection) {
  const current = selection ?? catalogDefault(catalog)
  if (current === null) return ''
  const entry = findModel(catalog, current.provider, current.model)
  const name = asText(entry?.name) || current.model
  if (current.reasoningEffort === undefined) return name
  const level = (Array.isArray(entry?.reasoning?.efforts) ? entry.reasoning.efforts : [])
    .find((effort) => asText(effort?.id) === current.reasoningEffort)
  return `${name} · ${asText(level?.name) || current.reasoningEffort}`
}

/**
 * Flatten the catalog into exactly what a menu draws.
 *
 * The effort row is offered for whichever model the session is actually on — a
 * model carries its own effort levels, and offering another model's would let a
 * person pick a level the next request would reject. Choosing a different model
 * therefore re-reads this with the new selection, and whatever level that model
 * prefers arrives with it.
 *
 * @param {object|null} catalog - The catalog from the host's `models` action.
 * @param {{ provider: string, model: string, reasoningEffort?: string } | null} selection - The session's selection.
 * @returns {{ error: string, efforts: object[], groups: object[] }} The menu model; `error` is a code, not a sentence.
 */
export function modelMenuModel(catalog, selection) {
  const current = selection ?? catalogDefault(catalog)
  const grouped = Array.isArray(catalog?.groups) ? catalog.groups : []
  if (grouped.length === 0) return { error: 'empty-catalog', efforts: [], groups: [] }
  const entry = current === null ? undefined : findModel(catalog, current.provider, current.model)
  const efforts = (Array.isArray(entry?.reasoning?.efforts) ? entry.reasoning.efforts : []).map((level) => ({
    id: asText(level?.id),
    label: asText(level?.name) || asText(level?.id),
    checked: current?.reasoningEffort === asText(level?.id),
  }))
  const groups = []
  for (const group of grouped) {
    const provider = asText(group?.id)
    const options = (Array.isArray(group?.models) ? group.models : []).map((model) => {
      const id = asText(model?.id)
      return {
        key: `${provider}\u0000${id}`,
        provider,
        model: id,
        label: asText(model?.name) || id,
        checked: current !== null && current.provider === provider && current.model === id,
      }
    })
    if (options.length > 0) groups.push({ title: asText(group?.name) || provider, options })
  }
  return { error: '', efforts, groups }
}
