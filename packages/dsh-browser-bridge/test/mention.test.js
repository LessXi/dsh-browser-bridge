/**
 * The `@` picker's data model.
 *
 * The behaviour being pinned is the behaviour a person notices: `@` opens a
 * list of the pages they could point at, typing narrows it, and the one they
 * were just looking at is at the top. Everything here is a pure function, so
 * none of it needs a document.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { test } from './harness.js'
import { mentionAt, mentionMenu, mentionRows, mentionable, rankTabs, shortUrl } from '../../../extension/mention.js'

const here = dirname(fileURLToPath(import.meta.url))

/** A tab, with only the fields the picker reads. */
const tab = (over) => ({
  id: 1,
  url: 'https://example.com/a',
  title: 'Example',
  lastAccessed: 1000,
  ...over,
})

test('a mention is one word, starting at an @ that begins it', () => {
  assert.deepEqual(mentionAt('@'), { query: '', start: 0 })
  assert.deepEqual(mentionAt('look at @net'), { query: 'net', start: 8 })
  assert.deepEqual(mentionAt('见 @转化'), { query: '转化', start: 2 })

  // An email address is not a mention. `foo@bar` would otherwise open a picker
  // in the middle of typing an address.
  assert.equal(mentionAt('foo@bar'), null)
  // A space closes it: the picker must not hover over text nobody is completing.
  assert.equal(mentionAt('@two words'), null)
  assert.equal(mentionAt('nothing here'), null)
  assert.equal(mentionAt(''), null)
  assert.equal(mentionAt(undefined), null)
})

test('only pages the bridge could read are offered', () => {
  // Offering a `chrome://` page would offer something that fails after it is
  // sent, which is worse than not offering it.
  assert.equal(mentionable(tab()), true)
  assert.equal(mentionable(tab({ url: 'http://localhost:3080/' })), true)
  assert.equal(mentionable(tab({ url: 'chrome://extensions' })), false)
  assert.equal(mentionable(tab({ url: 'chrome-extension://abc/sidepanel.html' })), false)
  assert.equal(mentionable(tab({ url: 'about:blank' })), false)
  assert.equal(mentionable(tab({ url: '' })), false)
  assert.equal(mentionable({}), false)
})

test('a URL is shortened to what identifies it', () => {
  // The host is what tells two tabs apart; the path only disambiguates two
  // pages on the same host, and a side panel has no room for the rest.
  assert.equal(shortUrl('https://dl.acm.org/doi/10.1145/3809166#sec-3'), 'dl.acm.org/doi/…')
  assert.equal(shortUrl('https://www.example.com/'), 'example.com')
  assert.equal(shortUrl('http://localhost:3080/?token=abc'), 'localhost:3080')
  assert.equal(shortUrl(''), '')
  assert.equal(shortUrl(undefined), '')
})

test('the tab you were just on comes first', () => {
  // `chrome.tabs.query` returns tabs in no useful order, and the interesting
  // one is almost always one that was just in front of you.
  const tabs = [
    tab({ id: 1, title: 'older', lastAccessed: 100 }),
    tab({ id: 2, title: 'newest', lastAccessed: 900 }),
    tab({ id: 3, title: 'middle', lastAccessed: 500 }),
  ]
  assert.deepEqual(rankTabs(tabs, '').map((each) => each.id), [2, 3, 1])
})

test('a tab that never reported recency sorts last, not first', () => {
  // An absent `lastAccessed` must not read as the beginning of time and win.
  const tabs = [tab({ id: 1, title: 'known', lastAccessed: 5 }), tab({ id: 2, title: 'unknown', lastAccessed: undefined })]
  assert.deepEqual(rankTabs(tabs, '').map((each) => each.id), [1, 2])
})

test('typing narrows the list, and a title match beats a URL match', () => {
  const tabs = [
    tab({ id: 1, title: 'Unrelated', url: 'https://pruning.example.com/', lastAccessed: 900 }),
    tab({ id: 2, title: 'Pruning notes', url: 'https://notes.example.com/', lastAccessed: 100 }),
  ]
  // Both contain "pruning", but one has it in the title, which is the stronger
  // signal — and it wins even though the other tab is more recent.
  assert.deepEqual(rankTabs(tabs, 'pruning').map((each) => each.id), [2, 1])
  assert.deepEqual(rankTabs(tabs, 'PRUNING').map((each) => each.id), [2, 1], 'the match is case-insensitive')

  // A word in neither drops the tab rather than showing everything.
  assert.deepEqual(rankTabs(tabs, 'kokoro').map((each) => each.id), [])
})

test('the list is capped, and the cap is the best of them', () => {
  const tabs = Array.from({ length: 20 }, (_, at) => tab({ id: at, title: `tab ${at}`, lastAccessed: at }))
  const top = rankTabs(tabs, '', 3)
  assert.equal(top.length, 3)
  assert.deepEqual(top.map((each) => each.id), [19, 18, 17], 'the cap kept the wrong end')
})

test('the two different nothings are told apart', () => {
  // No readable page at all is not the same as nothing matching: the first will
  // not improve with more typing, and saying so stops someone hunting for a tab
  // that was never offerable.
  assert.equal(mentionMenu([], '').state, 'empty')
  assert.equal(mentionMenu([tab({ url: 'chrome://extensions' })], '').state, 'empty')
  assert.equal(mentionMenu([tab({ title: 'Example' })], 'zzz').state, 'none')
  assert.equal(mentionMenu([tab({ title: 'Example' })], '').state, 'listed')
})

test('a URL is only drawn when two candidates would read the same', () => {
  // Two tabs of the same page at different anchors are common, and eight
  // identical rows are worse than no menu.
  const distinct = mentionRows([tab({ id: 1, title: 'Alpha' }), tab({ id: 2, title: 'Beta' })])
  assert.deepEqual(distinct.map((row) => row.showUrl), [false, false])

  const same = mentionRows([
    tab({ id: 1, title: 'Pruning', url: 'https://a.example.com/one' }),
    tab({ id: 2, title: 'Pruning', url: 'https://b.example.com/two' }),
  ])
  assert.deepEqual(same.map((row) => row.showUrl), [true, true], 'two rows read the same and nothing told them apart')
  // The drawn URL is shortened; the one that travels is not. Keeping them in
  // separate fields is what lets the panel compare a chosen tab against the
  // current one and notice they are the same page.
  assert.equal(same[0].where, 'a.example.com/one')
  assert.equal(same[1].where, 'b.example.com/two')
  assert.equal(same[0].url, 'https://a.example.com/one', 'the row lost the real URL')
  assert.equal(same[1].url, 'https://b.example.com/two')
})

test('a candidate carries the icon only when it is one the panel can load', () => {
  assert.equal(mentionRows([tab({ favIconUrl: 'https://example.com/f.ico' })])[0].icon, 'https://example.com/f.ico')
  assert.equal(mentionRows([tab({ favIconUrl: 'data:image/png;base64,AA' })])[0].icon, 'data:image/png;base64,AA')
  // The same allow-list the tab chip uses: an internal URL cannot be drawn, and
  // drawing it would leave a broken-image box in the menu.
  assert.equal(mentionRows([tab({ favIconUrl: 'chrome://theme/x' })])[0].icon, '')
  assert.equal(mentionRows([tab({ favIconUrl: undefined })])[0].icon, '')
})

test('a candidate with no title falls back to its URL', () => {
  // A page that has not set a title yet is still one you can point at.
  const rows = mentionRows([tab({ title: '', url: 'https://example.com/untitled' })])
  assert.equal(rows[0].title, 'https://example.com/untitled')
})

test('nothing here needs a document', () => {
  // The panel runs on a `chrome-extension://` origin, and this module has to be
  // importable by a suite that never builds a DOM — which is what makes the
  // ranking testable at all. The check is on the source rather than on
  // `globalThis.document`, because the runner shares one process and
  // `panel-stream.test.js` installs a document for its own suite.
  const source = readFileSync(join(here, '..', '..', '..', 'extension', 'mention.js'), 'utf8')
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const forbidden of ['document', 'window', 'chrome', 'fetch']) {
    assert.equal(
      new RegExp(`\\b${forbidden}\\b`).test(withoutComments),
      false,
      `mention.js reaches for ${forbidden}, so it cannot be tested without one`,
    )
  }
})
