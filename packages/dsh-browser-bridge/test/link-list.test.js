/**
 * `browser_read` lists a page's links, and the list is capped twice — once by
 * the extension at 200, once here at 60.
 *
 * Both caps used to be silent, which turns a truncated list into a factual
 * claim about the page: a model reading 60 links with no note concludes the page
 * has 60, and then reports that the checkout link it needs does not exist. The
 * page had 400. The count is the cheapest thing to keep, and the one the reader
 * actually needs.
 *
 * The second trap is subtler and is why the extension sends `linkCount`: by the
 * time the host sees the array it has already been cut, so counting it would
 * report the cap as the page's size.
 */

import { assert, test } from './harness.js'
import { buildPageTools } from '../lib/page-tools.js'

/**
 * Build the page tools against a bridge answering `page.read` with a link list.
 *
 * @param {{ returned: number, total?: number }} spec - How many links arrive,
 *   and what the extension said the page really has.
 * @returns {Map<string, object>} Tools by name.
 */
function toolsWithLinks({ returned, total }) {
  const ports = {
    bridge: {
      connection: {
        status: () => ({ connected: true }),
        call: async (method) => {
          if (method !== 'page.read') return {}
          return {
            tabId: 1,
            url: 'https://example.com/shop',
            title: 'Shop',
            text: 'A page with many links.',
            truncated: false,
            ...(total === undefined ? {} : { linkCount: total }),
            links: Array.from({ length: returned }, (_, index) => ({
              text: `Link ${index + 1}`,
              href: `https://example.com/p/${index + 1}`,
            })),
          }
        },
      },
    },
    settings: () => ({
      enabled: true,
      developerMode: false,
      confirmSensitiveActions: false,
      pageTextMaxBytes: 200_000,
      actionTimeoutMs: 15_000,
      screenshotMaxWidth: 1_200,
      consoleBufferSize: 200,
      networkBufferSize: 200,
      origins: ['https://example.com = allow'],
    }),
    connectionStatus: () => ({ connected: true }),
    grants: { find: () => undefined, record: () => {}, has: () => true },
    contextAttachments: { noteBrowserSession: () => {} },
    attachmentStore: () => undefined,
    approval: { request: async () => 'allowed-once' },
    tabOrigin: async () => 'https://example.com',
    policyLayers: () => [{ origins: { 'https://example.com': { access: 'allow' } } }],
  }
  return new Map(buildPageTools(ports).map((tool) => [tool.name, tool]))
}

/** An execution carrying an agent, which the approval gate requires. */
const exec = { agent: { id: 'fixture-session' }, callId: 'fixture-call', signal: undefined }

/** How many link lines the rendered text actually carries. */
function renderedLines(text) {
  return String(text)
    .split('\n')
    .filter((line) => line.startsWith('- ')).length
}

test('a page whose links all fit is listed without a note', async (t) => {
  const tool = toolsWithLinks({ returned: 12, total: 12 }).get('browser_read')
  const out = await tool.execute({ tab_id: 1 }, exec)

  assert.equal(renderedLines(out.text), 12)
  assert.ok(!/showing/i.test(out.text), 'a complete list must not claim it was cut')
  assert.equal(out.meta?.links, 12)
})

test('a list that was cut says how many it left out', async (t) => {
  const tool = toolsWithLinks({ returned: 400, total: 400 }).get('browser_read')
  const out = await tool.execute({ tab_id: 1 }, exec)

  assert.equal(renderedLines(out.text), 60, 'the cap still applies')
  assert.match(out.text, /showing 60 of 400 links/, 'the reader must learn the real size')
  assert.equal(out.meta?.links, 400)
})

test('exactly at the cap is not reported as truncated', async (t) => {
  // The boundary is where an off-by-one turns every full page into a lie.
  const tool = toolsWithLinks({ returned: 60, total: 60 }).get('browser_read')
  const out = await tool.execute({ tab_id: 1 }, exec)

  assert.equal(renderedLines(out.text), 60)
  assert.ok(!/showing/i.test(out.text), 'a list that fits exactly must not be described as cut')
})

test('the total comes from the wire, not from counting the array', async (t) => {
  // The extension cuts at 200 before the host ever sees the list, so counting
  // what arrived would report 200 as the page's size and understate the page.
  const tool = toolsWithLinks({ returned: 200, total: 400 }).get('browser_read')
  const out = await tool.execute({ tab_id: 1 }, exec)

  assert.match(out.text, /showing 60 of 400 links/)
  assert.equal(out.meta?.links, 400, 'the reported size must be the page, not the frame')
})

test('an extension that sends no total still gets an honest count', async (t) => {
  // Older frames have no `linkCount`; falling back to the array is right there,
  // and it is still better than saying nothing.
  const tool = toolsWithLinks({ returned: 200 }).get('browser_read')
  const out = await tool.execute({ tab_id: 1 }, exec)

  assert.match(out.text, /showing 60 of 200 links/)
  assert.equal(out.meta?.links, 200)
})
