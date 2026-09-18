/**
 * The `@` mention picker's data model.
 *
 * Typing `@` in the composer should let a message point at a tab other than the
 * one that happens to be in front — the reported case is twenty tabs open and
 * the third one is the interesting one, which today means switching to it and
 * losing the page you were reading.
 *
 * The shape follows the official panel's, which is the only first-hand account
 * of how this is meant to behave. Its candidates are
 * `{ faviconUrl, browserFamily, lastOpened, tabId, snapshot: { title, url }, source }`
 * and its menu is grouped, with `Tabs` among the groups. Two things it does that
 * are worth copying exactly:
 *
 *   - Candidates are ranked by recency, because the tab you want is usually the
 *     one you were just on.
 *   - A `query` filters them (the official scorer is a fuzzy matcher; a
 *     substring match over the title and the URL is what a bridge-sized panel
 *     can afford, and it behaves the same for the typing people actually do).
 *
 * Pure functions only, so the ranking and the filtering can be tested without a
 * document. The DOM half lives in `sidepanel.js`, because the panel runs on a
 * `chrome-extension://` origin and cannot import anything outside this folder.
 *
 * @module mention
 */

/** How many candidates to show. The official panel asks the host for a limit. */
export const MENTION_LIMIT = 8

/**
 * The `@word` being typed at the caret, if there is one.
 *
 * A mention starts at an `@` that begins a word — `foo@bar` is an email
 * address, not a mention — and runs to the caret without crossing a space. The
 * caller passes the text before the caret, so what follows the caret cannot
 * affect what is being completed.
 *
 * @param {string} before - The composer's text up to the caret.
 * @returns {{ query: string, start: number } | null} The mention, or null.
 */
export function mentionAt(before) {
  if (typeof before !== 'string') return null
  const at = before.lastIndexOf('@')
  if (at === -1) return null
  // `@` must start the text or follow whitespace, or it is part of a word.
  if (at > 0 && !/\s/.test(before[at - 1])) return null
  const query = before.slice(at + 1)
  // A mention is one word. A space closes the picker rather than leaving it
  // open over text the user is no longer completing.
  if (/\s/.test(query)) return null
  return { query, start: at }
}

/**
 * Whether a tab is one a mention could point at.
 *
 * The panel cannot read a `chrome://` page and neither can the host, so offering
 * one would be offering something that fails after it is sent. The check is by
 * scheme, so a scheme nobody thought of is offered rather than silently dropped
 * — the host refuses it with a reason, which is better than a menu that lies
 * about what is reachable.
 *
 * @param {{ url?: string }} tab - A tab from `chrome.tabs.query`.
 * @returns {boolean} Whether it can be mentioned.
 */
export function mentionable(tab) {
  const url = typeof tab?.url === 'string' ? tab.url : ''
  if (!/^https?:\/\//i.test(url)) return false
  return true
}

/**
 * Shorten a URL to what identifies it in a menu.
 *
 * `https://dl.acm.org/doi/10.1145/3809166#sec-3` becomes `dl.acm.org/doi/…`:
 * the host is what tells two tabs apart, and the path is there only to
 * disambiguate two pages on the same host. The official panel shows
 * `{title} {url}` on one line, which only works because its menu is wider than
 * a side panel.
 *
 * @param {string} url - The tab's URL.
 * @returns {string} Something short enough for one line.
 */
export function shortUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return ''
  let rest = url.replace(/^[a-z]+:\/\//i, '')
  rest = rest.replace(/^www\./i, '')
  const cut = rest.search(/[?#]/)
  if (cut !== -1) rest = rest.slice(0, cut)
  if (rest.endsWith('/')) rest = rest.slice(0, -1)
  // Keep the host and at most one path segment; the rest is noise in a menu.
  const parts = rest.split('/')
  if (parts.length > 2) rest = `${parts[0]}/${parts[1]}/…`
  return rest
}

/**
 * Rank the tabs a query could mean.
 *
 * Recency decides, because `chrome.tabs.query` returns tabs in no useful order
 * and the interesting one is almost always one you were just looking at.
 * `lastAccessed` is the browser's own answer to that; tabs that never reported
 * one sort last rather than first.
 *
 * A match on the title beats a match on the URL: typing a word you remember
 * seeing on the page is the common case, and the URL is what you type when the
 * title is not memorable.
 *
 * @param {object[]} tabs - Tabs from `chrome.tabs.query`.
 * @param {string} query - What was typed after the `@`, possibly empty.
 * @param {number} [limit] - How many to return.
 * @returns {object[]} The candidates, best first.
 */
export function rankTabs(tabs, query, limit = MENTION_LIMIT) {
  const needle = String(query ?? '').toLowerCase()
  const scored = []
  for (const tab of Array.isArray(tabs) ? tabs : []) {
    if (!mentionable(tab)) continue
    const title = String(tab.title ?? '')
    const url = String(tab.url ?? '')
    let score = 0
    if (needle.length > 0) {
      const inTitle = title.toLowerCase().indexOf(needle)
      const inUrl = url.toLowerCase().indexOf(needle)
      if (inTitle === -1 && inUrl === -1) continue
      // A title match is the stronger signal; a match at the start of either is
      // stronger still, which is what makes typing the first word work.
      if (inTitle === 0) score += 4
      else if (inTitle !== -1) score += 3
      if (inUrl === 0) score += 1
      else if (inUrl !== -1) score += 1
    }
    const at = Number(tab.lastAccessed)
    scored.push({ tab, score, at: Number.isFinite(at) ? at : 0 })
  }
  scored.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score
    if (left.at !== right.at) return right.at - left.at
    // A stable last resort, so the menu does not reshuffle between keystrokes.
    return String(left.tab.id ?? '').localeCompare(String(right.tab.id ?? ''))
  })
  return scored.slice(0, limit).map((entry) => entry.tab)
}

/**
 * What the picker should show, as data.
 *
 * Returns a code rather than a sentence for the empty case, so the panel owns
 * the wording and each language can say it its own way.
 *
 * @param {object[]} tabs - Tabs from `chrome.tabs.query`.
 * @param {string} query - What was typed after the `@`.
 * @param {{ title: string, url: string }} [t] - The translator.
 * @returns {{ state: 'empty'|'none'|'listed', options: object[] }} The menu.
 */
export function mentionMenu(tabs, query) {
  const options = rankTabs(tabs, query)
  if (options.length > 0) return { state: 'listed', options }
  // Two different nothings: no tab matches, or there was nothing to match. The
  // second is worth saying differently because no amount of typing will fix it.
  const any = (Array.isArray(tabs) ? tabs : []).filter(mentionable)
  return { state: any.length === 0 ? 'empty' : 'none', options: [] }
}

/**
 * Text to show for one candidate.
 *
 * The title is the label; the shortened URL is the second line, shown only when
 * two candidates would otherwise read the same. Two tabs of the same page at
 * different anchors are common, and a menu of eight identical rows is worse
 * than no menu.
 *
 * @param {object[]} tabs - The candidates, in menu order.
 * @returns {{ id: number|undefined, title: string, url: string, icon: string, group: string, showUrl: boolean }[]} Rows.
 */
export function mentionRows(tabs) {
  const titled = (Array.isArray(tabs) ? tabs : []).map((tab) => String(tab?.title ?? '') || String(tab?.url ?? ''))
  const counts = new Map()
  for (const title of titled) counts.set(title, (counts.get(title) ?? 0) + 1)
  return (Array.isArray(tabs) ? tabs : []).map((tab, at) => ({
    id: tab?.id,
    title: titled[at],
    url: shortUrl(tab?.url),
    icon: typeof tab?.favIconUrl === 'string' && /^(https?|data):/.test(tab.favIconUrl) ? tab.favIconUrl : '',
    group: 'tabs',
    showUrl: (counts.get(titled[at]) ?? 0) > 1,
  }))
}
