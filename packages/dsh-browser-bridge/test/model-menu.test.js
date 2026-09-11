/**
 * Tests for what the model picker shows.
 *
 * The picker itself is DOM code and cannot run here; that is exactly why the
 * decisions it makes — which model is checked, whether an effort row is offered
 * at all, what happens when the catalog is empty or names a model that is no
 * longer listed — live in a pure module and are checked as data. Those are the
 * cases that broke in the rest of this panel's history: not the drawing, the
 * deciding.
 *
 * @module dsh-browser-bridge/test/model-menu
 */

import { assert, test } from './harness.js'
import { modelLabel, modelMenuModel } from '../../../extension/model-menu.js'

/**
 * A catalog shaped like the one `SessionController.modelCatalog()` returns.
 *
 * Two providers on purpose: one with a model that offers effort levels and one
 * without, plus an empty group, because each of those exercises a different
 * branch of the menu builder.
 */
const CATALOG = {
  default: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
  groups: [
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        {
          id: 'deepseek-flash',
          name: 'DeepSeek-V41-Flash',
          reasoning: { efforts: [{ id: 'low', name: 'Light' }, { id: 'max', name: 'Max' }], defaultEffort: 'max' },
        },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    },
    { id: 'empty', name: 'Nothing Here', models: [] },
  ],
}

test('a label names the model, and appends the effort only when one is set', () => {
  assert.equal(modelLabel(CATALOG, { provider: 'deepseek-official', model: 'deepseek-flash' }), 'DeepSeek-V41-Flash')
  assert.equal(
    modelLabel(CATALOG, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' }),
    'DeepSeek-V41-Flash · Max',
  )
})

test('an effort id the catalog does not name still renders as itself', () => {
  // A level can outlive its catalog entry when a provider renames one; showing
  // the raw id is better than showing a bare model name that hides the choice.
  assert.equal(
    modelLabel(CATALOG, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'turbo' }),
    'DeepSeek-V41-Flash · turbo',
  )
})

test('a session that never chose a model falls back to the deployment default', () => {
  assert.equal(modelLabel(CATALOG, null), 'DeepSeek-V41-Flash · Max')
})

test('a model the catalog does not list renders as its raw id rather than nothing', () => {
  assert.equal(modelLabel(CATALOG, { provider: 'gone', model: 'retired-model' }), 'retired-model')
})

test('no catalog and no selection is an empty label, not a placeholder', () => {
  assert.equal(modelLabel(null, null), '')
  assert.equal(modelLabel({ default: null, groups: [] }, null), '')
  assert.equal(modelLabel(null, { provider: 'deepseek-official', model: 'deepseek-flash' }), 'deepseek-flash')
})

test('an empty catalog is reported as a code, not as a sentence', () => {
  // The panel translates it; a module that shipped English here would render
  // English inside a Chinese panel.
  assert.deepEqual(modelMenuModel(null, null), { error: 'empty-catalog', efforts: [], groups: [] })
  assert.deepEqual(modelMenuModel({ groups: [] }, null), { error: 'empty-catalog', efforts: [], groups: [] })
})

test('the menu checks the session\'s own model, and only that one', () => {
  const menu = modelMenuModel(CATALOG, { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  assert.equal(menu.error, '')
  const options = menu.groups.flatMap((group) => group.options)
  assert.deepEqual(options.map((option) => option.checked), [false, true])
  assert.deepEqual(options.map((option) => option.label), ['DeepSeek-V41-Flash', 'DeepSeek-V4-Pro'])
})

test('a group with no models is dropped rather than drawn as a bare heading', () => {
  const menu = modelMenuModel(CATALOG, null)
  assert.deepEqual(menu.groups.map((group) => group.title), ['DeepSeek'])
})

test('each option carries the pair the host needs, under a collision-free key', () => {
  const menu = modelMenuModel(CATALOG, null)
  const first = menu.groups[0].options[0]
  assert.deepEqual({ provider: first.provider, model: first.model }, { provider: 'deepseek-official', model: 'deepseek-flash' })
  // A separator that cannot appear in either half, so two providers offering the
  // same model id stay distinguishable when the panel keys rows by it.
  assert.equal(first.key, 'deepseek-official\u0000deepseek-flash')
})

test('the effort row belongs to the model the session is on', () => {
  const onFlash = modelMenuModel(CATALOG, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' })
  assert.deepEqual(onFlash.efforts.map((effort) => [effort.label, effort.checked]), [['Light', true], ['Max', false]])
  // `deepseek-v4-pro` declares no reasoning levels, so the row disappears rather
  // than offering levels the next request would refuse.
  const onPro = modelMenuModel(CATALOG, { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  assert.deepEqual(onPro.efforts, [])
})

test('with no selection the effort row follows the deployment default', () => {
  const menu = modelMenuModel(CATALOG, null)
  assert.deepEqual(menu.efforts.map((effort) => [effort.id, effort.checked]), [['low', false], ['max', true]])
})
