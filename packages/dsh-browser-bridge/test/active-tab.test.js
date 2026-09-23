/**
 * Which tab is "the current page" when more than one window is open?
 *
 * Chrome keeps one active tab *per window*. With three windows open, `tabs.list`
 * returns three rows with `active: true`, and the host used to answer
 * `browser_selection` with `tabs.find((tab) => tab.active === true)` — the first
 * active row in list order. That is a tab in some window, but not necessarily
 * the window the person is looking at: they ask about the page in front of them
 * and the model is told about a page somewhere else, with no hedge at all.
 *
 * The extension is the only party that can ask Chrome which window is focused,
 * so it now marks each row `windowFocused`, and these tests pin both halves:
 * that the host picks that row rather than the first active one, and that when
 * the mark is absent it says so instead of asserting a guess.
 *
 * `browser_selection` had no test coverage at all before this file, which is how
 * a `find` over a multi-window-shaped list survived in the first place.
 *
 * @module dsh-browser-bridge/test/active-tab
 */

import { test, assert } from './harness.js'
import { buildPageTools } from '../lib/page-tools.js'
import { buildTools } from '../lib/tools.js'
import { METHODS } from '../lib/protocol.js'
import { resolveSettings } from '../lib/config.js'

const SESSION = 'session-active-tab-test'

/**
 * Three windows, each with its own active tab, as Chrome really reports them.
 *
 * The user is looking at window 2 (`Cart`). Window 1 sorts first, so a
 * first-active-row rule picks the wrong tab — which is the whole defect.
 */
const THREE_WINDOWS = [
  { id: 11, windowId: 1, active: true, windowFocused: false, title: 'News', url: 'https://news.example/a' },
  { id: 12, windowId: 1, active: false, windowFocused: false, title: 'Inbox', url: 'https://mail.example/inbox' },
  { id: 21, windowId: 2, active: true, windowFocused: true, title: 'Cart', url: 'https://shop.example/cart' },
  { id: 31, windowId: 3, active: true, windowFocused: false, title: 'Spec', url: 'https://docs.example/spec' },
]

/**
 * Build the page tools over a scripted `tabs.list`.
 *
 * @param {object[]} tabs - The rows the extension answers with.
 * @returns {object} The tool and its exec stub.
 */
function pageFixture(tabs) {
  const calls = []
  const ports = {
    bridge: {
      connection: {
        call: async (method, params) => {
          calls.push({ method, params })
          if (method === METHODS.tabsList) return tabs
          return {}
        },
      },
    },
    settings: () => resolveSettings({}),
    connectionStatus: () => ({ connected: true }),
    grants: undefined,
    contextAttachments: undefined,
    attachmentStore: () => undefined,
    approval: { request: async () => 'allowed-once' },
    tabOrigin: async () => 'https://shop.example',
    policyLayers: () => ({ origins: {}, defaultOriginPolicy: {} }),
    approvalScope: () => undefined,
  }
  const tool = buildPageTools(ports).find((definition) => definition.name === 'browser_selection')
  assert.ok(tool !== undefined, 'browser_selection must exist in the page tool set')
  return { tool, calls, exec: { agent: { id: SESSION }, callId: 'call-1' } }
}

/**
 * Build `browser_tabs` over a scripted `tabs.list`.
 *
 * @param {object[]} tabs - The rows the extension answers with.
 * @returns {object} The tool and its exec stub.
 */
function tabsFixture(tabs) {
  const ports = {
    bridge: {
      connection: {
        call: async (method) => {
          if (method === METHODS.tabsList) return tabs
          return {}
        },
      },
    },
    settings: () => resolveSettings({}),
    connectionStatus: () => ({ connected: true }),
  }
  const tool = buildTools(ports).find((definition) => definition.name === 'browser_tabs')
  assert.ok(tool !== undefined, 'browser_tabs must exist in the tool set')
  return { tool, exec: { agent: { id: SESSION }, callId: 'call-1' } }
}

test('browser_selection reports the tab in the focused window, not the first active one', async () => {
  const { tool, exec, calls } = pageFixture(THREE_WINDOWS)
  const result = await tool.execute({}, exec)

  // Window 1's News sorts first and is active; it is the wrong answer.
  assert.match(result.text, /Cart/, 'the focused window\u2019s tab is the one to report')
  assert.doesNotMatch(result.text, /News/, 'a tab in another window must not be reported as the active one')
  assert.equal(result.meta.active.id, 21)
  assert.equal(result.meta.via, 'focused-window')
  // No caveat when the answer is actually known.
  assert.doesNotMatch(result.text, /Several windows/, 'no hedge is needed when the window is known')
  assert.equal(calls.filter((call) => call.method === METHODS.tabsList).length, 1)
})

test('with no focused-window mark, browser_selection says the choice was a guess', async () => {
  // An older extension build, or a Chrome that refused `windows.getLastFocused`.
  const unmarked = THREE_WINDOWS.map(({ windowFocused: _drop, ...rest }) => rest)
  const { tool, exec } = pageFixture(unmarked)
  const result = await tool.execute({}, exec)

  assert.equal(result.meta.via, 'first-active', 'the fallback must be labelled as such')
  // It still answers — degrading is better than refusing — but it does not
  // present row order as if it were knowledge.
  assert.match(result.text, /News/, 'the old behaviour still answers')
  assert.match(result.text, /Several windows are open/, 'and it must admit the tab is a guess')
  assert.match(result.text, /browser_tabs/, 'the caveat should name the tool that settles it')
})

test('a single window needs no caveat even without the mark', async () => {
  // One window open: row order and the focused window agree, so there is
  // nothing ambiguous to warn about and the warning would be noise.
  const oneWindow = [
    { id: 11, windowId: 1, active: true, title: 'News', url: 'https://news.example/a' },
    { id: 12, windowId: 1, active: false, title: 'Inbox', url: 'https://mail.example/inbox' },
  ]
  const { tool, exec } = pageFixture(oneWindow)
  const result = await tool.execute({}, exec)

  assert.match(result.text, /News/)
  assert.doesNotMatch(result.text, /Several windows/, 'one window is not ambiguous')
})

test('no active tab at all is reported as such', async () => {
  const { tool, exec } = pageFixture([
    { id: 11, windowId: 1, active: false, windowFocused: false, title: 'News', url: 'https://news.example/a' },
  ])
  const result = await tool.execute({}, exec)
  assert.equal(result.text.split('\n')[0], 'No active tab.')
  assert.equal(result.meta.via, 'none')
})

test('a contradictory windowFocused flag falls back instead of picking arbitrarily', async () => {
  // Two rows claiming to be the focused window's active tab cannot both be
  // right. Answering confidently from a contradiction would be worse than the
  // old behaviour, so it degrades to it — and says so.
  const contradictory = THREE_WINDOWS.map((tab) => ({ ...tab, windowFocused: tab.active === true }))
  const { tool, exec } = pageFixture(contradictory)
  const result = await tool.execute({}, exec)

  assert.equal(result.meta.via, 'first-active')
  assert.match(result.text, /Several windows are open/)
})

test('browser_tabs marks the focused window so a model can tell the rows apart', async () => {
  const { tool, exec } = tabsFixture(THREE_WINDOWS)
  const result = await tool.execute({}, exec)

  const lines = result.text.split('\n').filter((line) => line.startsWith('['))
  assert.equal(lines.length, 4, 'every tab is listed')
  const focused = lines.filter((line) => line.includes('focused window'))
  assert.equal(focused.length, 1, 'exactly one row is in the focused window')
  assert.match(focused[0], /\[21\]/, 'and it is the cart tab')
  // The rows in other windows must not carry the mark.
  for (const line of lines.filter((candidate) => !candidate.includes('[21]'))) {
    assert.doesNotMatch(line, /focused window/)
  }
})
