/**
 * Tests what `browser_screenshot` actually hands the model.
 *
 * Why this file exists: the tool used to build its image block as
 * `{ type: 'image', mediaType, data }`. That is not the harness's `ImageBlock`
 * — which is `{ type: 'image', attachment: ImageAttachmentRef }` — and the
 * DeepSeek adapter's `collectImageRefs` dereferences
 * `block.attachment.attachmentId` before it can price or serialize a picture.
 * Nothing caught it: the output schema compiled, the tool reported "captured",
 * and the only symptom was a screenshot that never arrived. These tests pin the
 * block to the harness contract and pin the base64 bytes to the attachment
 * call, so a later edit cannot quietly put inline image data back into a
 * durable tool value.
 */

import { assert, test } from './harness.js'
import { buildPageTools } from '../lib/page-tools.js'
import { GrantTable } from '../lib/grants.js'
import { METHODS } from '../lib/protocol.js'
import { resolveSettings } from '../lib/config.js'

const ORIGIN = 'https://example.com'
const SESSION = 'session-screenshot-test'
/** A small canonical base64 payload standing in for a real capture. */
const PAYLOAD = Buffer.from('not-really-a-jpeg').toString('base64')
const BYTES = Buffer.from(PAYLOAD, 'base64').byteLength

/**
 * Build the screenshot tool over a scripted extension connection.
 *
 * The gate is satisfied by a pre-recorded `access` grant rather than a stub
 * approval answerer: that is the path a real run takes on the second capture of
 * a session, and it keeps `askApproval` out of the fixture entirely, so a
 * change in approval wiring surfaces here as a failure rather than as a
 * silently permissive stub.
 *
 * @param {object} [options] - Fixture knobs.
 * @param {object} [options.shot] - What `page.screenshot` resolves to.
 * @param {boolean} [options.captureFails] - Make the capture reject instead.
 * @param {boolean} [options.deny] - Deny the origin in the site rules.
 * @param {() => object} [options.attachmentStore] - Override the store port.
 * @returns {object} The tool, the recorded calls, and the exec stub.
 */
function fixture(options = {}) {
  const calls = []
  const admitted = []
  const shot = options.shot ?? {
    tabId: 7,
    format: 'jpeg',
    mediaType: 'image/jpeg',
    data: PAYLOAD,
    truncatedTo: 1280,
  }

  const bridge = {
    connection: {
      call: async (method, params) => {
        calls.push({ method, params })
        if (method === METHODS.pageScreenshot) {
          if (options.captureFails === true) throw Object.assign(new Error('capture blew up'), { code: 'PAGE_ERROR' })
          return shot
        }
        if (method === METHODS.tabsList) return [{ id: 7, url: `${ORIGIN}/page`, title: 'Example' }]
        throw new Error(`unexpected method ${method}`)
      },
    },
  }

  const grants = new GrantTable()
  grants.record({ sessionId: SESSION, origin: ORIGIN, capabilities: ['access'], lifetime: 'turn' })

  const store = {
    admitPromptContent: async (parts) => {
      admitted.push(parts)
      return parts.map((part, index) => ({
        type: 'image',
        attachment: {
          attachmentId: `att-${index}`,
          mediaType: part.mediaType,
          bytes: Buffer.from(part.data, 'base64').byteLength,
          width: 1280,
          height: 800,
        },
      }))
    },
  }

  const ports = {
    bridge,
    settings: () => resolveSettings({ confirmSensitiveActions: false }),
    connectionStatus: () => ({ connected: true }),
    grants,
    contextAttachments: undefined,
    attachmentStore: options.attachmentStore ?? (() => store),
    approval: undefined,
    tabOrigin: async (tabId) => (tabId === 7 ? ORIGIN : undefined),
    policyLayers: () => ({
      origins: options.deny === true ? { [ORIGIN]: { access: 'deny' } } : {},
      defaultOriginPolicy: {},
    }),
  }

  const tool = buildPageTools(ports).find((definition) => definition.name === 'browser_screenshot')
  assert.ok(tool !== undefined, 'browser_screenshot must exist in the page tool set')
  return { tool, calls, admitted, exec: { agent: { id: SESSION } } }
}

test('the screenshot value carries an attachment reference, not the pixels', async () => {
  const { tool, calls, admitted, exec } = fixture()
  const value = await tool.execute({ tab_id: 7 }, exec)

  assert.equal(value.attachment.attachmentId, 'att-0', 'the durable value must name the stored image')
  assert.ok(
    !('data' in value),
    `the base64 payload must not reach the tool value (saw keys ${Object.keys(value).join(', ')})`,
  )
  assert.equal(value.width, 1280)
  assert.equal(value.height, 800)
  assert.equal(value.bytes, BYTES)
  assert.equal(value.url, `${ORIGIN}/page`, 'the screenshot should be labelled with the tab it came from')

  assert.equal(admitted.length, 1, 'the bytes must be handed to the attachment service exactly once')
  assert.deepEqual(admitted[0], [{ type: 'image', data: PAYLOAD, mediaType: 'image/jpeg', name: 'screenshot-7' }])

  const capture = calls.find((entry) => entry.method === METHODS.pageScreenshot)
  assert.equal(capture.params.maxWidth, 1280, 'the configured screenshot width must reach the browser')
  assert.equal(capture.params.format, 'jpeg')
})

test('the rendered block is an ImageBlock the DeepSeek adapter can resolve', async () => {
  const { tool, exec } = fixture()
  const args = { tab_id: 7 }
  const blocks = tool.output.render(args, await tool.execute(args, exec))

  assert.equal(blocks.length, 2, 'a text label followed by the image')
  assert.equal(blocks[0].type, 'text')
  const image = blocks[1]
  assert.equal(image.type, 'image')
  assert.equal(image.attachment.attachmentId, 'att-0')
  assert.ok(!('data' in image), 'inline base64 is not part of ImageBlock')
  assert.ok(!('mediaType' in image), 'the media type lives on the attachment reference, not on the block')

  // The exact walk the harness performs. `contentHasImage` descends into
  // `tool-result` blocks and `collectImageRefs` then dereferences
  // `block.attachment.attachmentId`, so a block that merely *looks* like an
  // image has to fail here rather than inside the adapter mid-request.
  const images = []
  const walk = (content) => {
    for (const block of content) {
      if (block.type === 'image') images.push(block)
      else if (block.type === 'tool-result') walk(block.content)
    }
  }
  walk([{ type: 'tool-result', toolCallId: 'call-1', content: blocks }])

  assert.equal(images.length, 1, 'the harness must find exactly one nested image')
  for (const block of images) {
    assert.equal(
      typeof block.attachment?.attachmentId,
      'string',
      'collectImageRefs reads block.attachment.attachmentId, so every image block needs one',
    )
  }
  assert.deepEqual(images.map((block) => block.attachment.attachmentId), ['att-0'])
})

test('without an attachment service the tool says so instead of inventing a block', async () => {
  const { tool, exec } = fixture({ attachmentStore: () => undefined })
  const value = await tool.execute({ tab_id: 7 }, exec)

  assert.equal(value.attachment, undefined)
  assert.equal(value.meta.code, 'ATTACHMENT_STORE_UNAVAILABLE')
  assert.ok(value.text.includes('unavailable'), `the diagnostic must name the cause, saw: ${value.text}`)

  const blocks = tool.output.render({ tab_id: 7 }, value)
  assert.equal(blocks.length, 1, 'a label with no picture is honest; a picture-less image block is not')
  assert.equal(blocks[0].type, 'text')
})

test('an empty capture is reported, not stored', async () => {
  const { tool, admitted, exec } = fixture({
    shot: { tabId: 7, format: 'jpeg', mediaType: 'image/jpeg', data: '' },
  })
  const value = await tool.execute({ tab_id: 7 }, exec)

  assert.equal(value.meta.code, 'EMPTY_SCREENSHOT')
  assert.equal(admitted.length, 0, 'an empty payload must not become a durable attachment')
})

test('a png capture keeps its media type on both sides of the boundary', async () => {
  const { tool, admitted, exec } = fixture({
    shot: { tabId: 7, format: 'png', mediaType: 'image/png', data: PAYLOAD },
  })
  const value = await tool.execute({ tab_id: 7, format: 'png' }, exec)

  assert.equal(value.format, 'png')
  assert.equal(value.attachment.mediaType, 'image/png')
  assert.equal(admitted[0][0].mediaType, 'image/png')
})

test('a refused capture never reaches the attachment service', async () => {
  const { tool, calls, admitted, exec } = fixture({ deny: true })
  const value = await tool.execute({ tab_id: 7 }, exec)

  assert.equal(value.attachment, undefined)
  assert.ok(value.text.includes('deny'), `the refusal must name the rule, saw: ${value.text}`)
  assert.equal(admitted.length, 0, 'a refused origin must not store pixels')
  assert.equal(calls.length, 0, 'nothing may be asked of the browser once the site rules refuse it')
})

test('a capture failure is reported with its code and stores nothing', async () => {
  const { tool, admitted, exec } = fixture({ captureFails: true })
  const value = await tool.execute({ tab_id: 7 }, exec)

  assert.equal(value.meta.code, 'PAGE_ERROR')
  assert.ok(value.text.length > 0, 'the failure must carry a diagnostic')
  assert.equal(admitted.length, 0)
})

test('a non-integer tab id is refused before anything else runs', async () => {
  const { tool, calls, admitted, exec } = fixture()
  const value = await tool.execute({}, exec)

  assert.ok(value.text.includes('integer tab_id'), `saw: ${value.text}`)
  assert.equal(calls.length, 0)
  assert.equal(admitted.length, 0)
})
