/**
 * Does an index from a snapshot still mean the same element later?
 *
 * `resolveTarget` takes an integer index, takes a *fresh* snapshot, and looks the
 * index up in it. But an index is a DOM node position, so it is only meaningful
 * against the snapshot it came from: anything added or removed in between shifts
 * every index after it.
 *
 * Measured on a real page whose cookie banner and promo strip arrive a moment
 * after load, the Pay button moved from index 19 to 29 — and where the churn
 * differs it lands on a *different* element, which is worse than landing on
 * none, because the click goes somewhere the model never chose. The fix resolves
 * the stable `backendNodeId` first and falls back to the position only when that
 * is impossible; these tests pin both halves, since the fallback is what a
 * page that has not changed still depends on.
 *
 * The wire is where this lives — a CDP method sequence and a click point — so
 * nothing about it is visible in a screenshot or a transcript.
 *
 * @module dsh-browser-bridge/test/target-index
 */

import { test, assert } from './harness.js'
import { awaitConnection, loadServiceWorker, fakeHost, listener } from './service-worker.js'

/**
 * A `chrome` stand-in that answers snapshots and records where clicks land.
 *
 * `DOMSnapshot.captureSnapshot` is answered from a table the test sets, so the
 * same index can name different elements at two moments — which is the whole
 * subject. Every command is recorded, so "did it take the stable path or the
 * positional one" is a question about the sequence rather than a guess.
 *
 * @param {object} [options] - Fixture knobs.
 * @param {() => object} [options.snapshot] - The snapshot to answer with.
 * @param {object} [options.boxModel] - What `DOM.getBoxModel` returns.
 * @param {boolean} [options.pushFails] - Make the backend-id resolve fail.
 * @returns {object} The fake namespace.
 */
function fakeChrome(options = {}) {
  const tabs = [
    { id: 7, windowId: 1, active: true, url: 'https://shop.example/cart', title: 'Cart', groupId: -1, status: 'complete' },
  ]
  const sent = []
  const clicks = []

  return {
    __cdp: sent,
    __clicks: clicks,
    __emit(method, params, tabId = 7) {
      for (const fn of options.eventListeners ?? []) fn({ tabId }, method, params)
    },
    storage: {
      local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      onChanged: listener(),
    },
    runtime: {
      id: 'index-test',
      getManifest: () => ({ version: '0.0.0-test' }),
      getBrowserInfo: () => Promise.resolve({ name: 'Chrome', version: '153' }),
      onMessage: listener(),
      onConnect: listener(),
      onInstalled: listener(),
      onStartup: listener(),
      sendMessage: () => Promise.resolve(),
      openOptionsPage: () => {},
      lastError: undefined,
    },
    tabs: {
      query: () => Promise.resolve(tabs),
      get: (id) => Promise.resolve(tabs.find((tab) => tab.id === id) ?? tabs[0]),
      create: () => Promise.resolve(tabs[0]),
      update: () => Promise.resolve(tabs[0]),
      remove: () => Promise.resolve(),
      group: () => Promise.resolve(1),
      onUpdated: listener(),
      onRemoved: listener(),
      onActivated: listener(),
      onCreated: listener(),
    },
    tabGroups: { query: () => Promise.resolve([]), update: () => Promise.resolve({}), onUpdated: listener() },
    debugger: {
      getTargets: () => Promise.resolve([{ tabId: 7, attached: true }]),
      attach: () => Promise.resolve(),
      detach: () => Promise.resolve(),
      sendCommand: (_target, method, params) => {
        sent.push(method)
        if (method === 'DOMSnapshot.captureSnapshot') return Promise.resolve(options.snapshot?.() ?? { documents: [], strings: [] })
        if (method === 'Accessibility.getFullAXTree') return Promise.resolve({ nodes: [] })
        if (method === 'DOM.pushNodesByBackendIdsToFrontend') {
          if (options.pushFails === true) return Promise.reject(new Error('Node with given id does not belong to the document'))
          return Promise.resolve({ nodeIds: [options.resolvedNodeId ?? 55] })
        }
        if (method === 'DOM.getBoxModel') {
          return Promise.resolve({ model: { border: options.boxModel ?? [100, 200, 260, 200, 260, 236, 100, 236] } })
        }
        if (method === 'DOM.getDocument') return Promise.resolve({ root: { nodeId: 1 } })
        if (method === 'Input.dispatchMouseEvent') {
          clicks.push({ type: params.type, x: params.x, y: params.y })
          return Promise.resolve({})
        }
        if (method === 'Page.getLayoutMetrics') {
          return Promise.resolve({ cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } })
        }
        return Promise.resolve({})
      },
      onEvent: {
        addListener: (fn) => {
          options.eventListeners = options.eventListeners ?? []
          options.eventListeners.push(fn)
        },
        removeListener: () => {},
      },
      onDetach: listener(),
    },
    windows: { getLastFocused: () => Promise.resolve({ id: 1 }), update: () => Promise.resolve({}), onFocusChanged: listener() },
    action: {
      setBadgeText: () => Promise.resolve(),
      setBadgeBackgroundColor: () => Promise.resolve(),
      setTitle: () => Promise.resolve(),
      onClicked: listener(),
    },
    alarms: { create: () => {}, clear: () => Promise.resolve(), onAlarm: listener() },
    scripting: { executeScript: () => Promise.resolve([]) },
    i18n: { getUILanguage: () => 'en-US' },
    sidePanel: { open: () => Promise.resolve(), setPanelBehavior: () => Promise.resolve() },
    contextMenus: { create: () => {}, removeAll: () => Promise.resolve(), onClicked: listener() },
    history: { search: () => Promise.resolve([]) },
    downloads: { download: () => Promise.resolve(1), onChanged: listener() },
    permissions: { contains: () => Promise.resolve(true) },
  }
}

/**
 * Build a snapshot holding one button at a chosen node index.
 *
 * The arrays run to `spec.index` because the reader walks `nodeType` by
 * position: a short array with a long index does not produce an element at that
 * index, it produces nothing at all, and a test built on that would be asserting
 * against an empty list.
 *
 * @param {{ index: number, name: string, backendNodeId?: number, withBackendId?: boolean, inFrame?: boolean }} spec - The element.
 * @returns {object} A `DOMSnapshot.captureSnapshot` result.
 */
function snapshotWith(spec) {
  const strings = ['', 'html', 'body', 'button', spec.name, 'display', 'block']
  const at = (text) => strings.indexOf(text)
  const length = spec.index + 1
  const nodeType = new Array(length).fill(0)
  const nodeName = new Array(length).fill(0)
  const nodeValue = new Array(length).fill(0)

  nodeType[0] = 9
  nodeName[0] = at('html')
  for (let index = 1; index < length; index += 1) {
    nodeType[index] = 1
    nodeName[index] = at('body')
  }
  nodeType[spec.index] = 1
  nodeName[spec.index] = at('button')

  // The id table is per position, exactly as the browser reports it: the field
  // has to be present for a row to carry one, which is what the fallback test
  // relies on.
  const backendNodeId = spec.withBackendId === false
    ? undefined
    : new Array(length).fill(0).map((_zero, index) => (index === spec.index ? spec.backendNodeId : 0))

  // A row inside a frame is a row in a *second* document, and the reader marks
  // each document's rows as it walks them. `inFrame` is derived from position in
  // the list, so an empty lead document would shift it — the empty entries keep
  // the frame in second place the way a real snapshot has it.
  const documents = spec.inFrame === true
    ? [{ nodes: { parentIndex: [], nodeType: [], nodeName: [], nodeValue: [] }, layout: {} }, {
      nodes: {
        parentIndex: new Array(length).fill(0),
        nodeType,
        nodeName,
        nodeValue,
        attributes: {
          [spec.index]: [at('display'), at('block')],
        },
        ...(backendNodeId === undefined ? {} : { backendNodeId }),
      },
      layout: { nodeIndex: [spec.index], bounds: [[10, 10, 120, 30]] },
    }]
    : [{
      nodes: {
        parentIndex: new Array(length).fill(0),
        nodeType,
        nodeName,
        nodeValue,
        attributes: {
          [spec.index]: [at('display'), at('block')],
        },
        ...(backendNodeId === undefined ? {} : { backendNodeId }),
      },
      layout: { nodeIndex: [spec.index], bounds: [[10, 10, 120, 30]] },
    }]

  return { strings, documents }
}

/**
 * Build a snapshot holding `count` clickable buttons.
 *
 * The cap under test is on the *array* the wire carries, not on the rendered
 * text, so a fixture with a single element cannot express it: the two only
 * diverge once the page has more elements than the cap.
 *
 * @param {number} count - How many buttons the page has.
 * @returns {object} A `DOMSnapshot.captureSnapshot` result.
 */
function snapshotMany(count) {
  const strings = ['', 'html', 'body', 'button', 'Save', 'display', 'block']
  const at = (text) => strings.indexOf(text)
  const length = count + 1
  const nodeType = new Array(length).fill(1)
  const nodeName = new Array(length).fill(at('button'))
  const nodeValue = new Array(length).fill(at('Save'))
  const parentIndex = new Array(length).fill(0)
  const attributes = new Array(length).fill(null).map(() => [[], []])
  const backendNodeId = new Array(length).fill(0).map((_zero, index) => 1000 + index)
  nodeType[0] = 9
  nodeName[0] = at('html')
  parentIndex[0] = -1
  backendNodeId[0] = 0

  const indexes = new Array(count).fill(0).map((_zero, index) => index + 1)
  const bounds = indexes.map((index) => [10, 10 + index * 2, 200, 10 + index * 2, 200, 30 + index * 2, 10, 30 + index * 2])

  return {
    strings,
    documents: [{
      nodes: { parentIndex, nodeType, nodeName, nodeValue, attributes, backendNodeId },
      layout: { nodeIndex: indexes, bounds },
    }],
  }
}

/** Distinguishes this file's fake hosts; the module-load counter is the harness's. */
let tokenCount = 0

/**
 * Start a worker against a fake host and attach it to tab 7.
 *
 * @param {object} [options] - Passed through to {@link fakeChrome}.
 * @returns {Promise<{ host: object, chrome: object, teardown: () => void }>} The trio.
 */
async function start(options = {}) {
  const token = `index-token-${(tokenCount += 1)}`
  const host = await fakeHost(token)
  const chrome = fakeChrome(options)
  chrome.storage.local.get = () => Promise.resolve({ port: host.port, token })
  const teardown = await loadServiceWorker(chrome)
  await awaitConnection(host)
  const attached = new Promise((resolve) => host.answers.set(1, resolve))
  host.send({ id: 1, method: 'debugger.attach', params: { tabId: 7 } })
  assert.equal((await attached).ok, true, 'the worker would not attach, so nothing below is proved')
  chrome.__cdp.length = 0
  return { host, chrome, teardown }
}

test('a click by index resolves the stable node id rather than the position', async (t) => {
  // The defect: the index is looked up in a *fresh* snapshot, so a page that
  // gained a cookie banner since the model saw it shifts every index after the
  // insertion point. The stable id is what survives that, and it is already on
  // the wire.
  const { host, chrome, teardown } = await start({
    snapshot: () => snapshotWith({ index: 21, name: 'Pay now', backendNodeId: 23 }),
  })
  t.onCleanup(() => {
    teardown()
    return host.close()
  })

  const answered = new Promise((resolve) => host.answers.set(20, resolve))
  host.send({ id: 20, method: 'page.click', params: { tabId: 7, index: 21 } })
  const answer = await answered

  assert.equal(answer.ok, true, `the click failed: ${answer.message ?? ''}`)
  assert.ok(
    chrome.__cdp.includes('DOM.pushNodesByBackendIdsToFrontend'),
    `the stable id was not used, so the click was placed by position: ${JSON.stringify(chrome.__cdp)}`,
  )
  // The point comes from the resolved node's own box, not from the snapshot's
  // bounds — that is the difference between "the element that was there" and
  // "whatever is at that position now".
  const pressed = chrome.__clicks.find((click) => click.type === 'mousePressed')
  assert.equal(pressed?.x, 180, 'the click x did not come from the resolved box')
  assert.equal(pressed?.y, 218, 'the click y did not come from the resolved box')
})

test('a document is requested before the backend id is pushed', async (t) => {
  // `DOM.pushNodesByBackendIdsToFrontend` resolves into the frontend document
  // the session currently holds, and there is none until `DOM.getDocument` asks
  // for one. Without it the call fails with "Document needs to be requested
  // first" — which the resolve then swallows, silently falling back to the
  // positional path this change exists to avoid.
  const { host, chrome, teardown } = await start({
    snapshot: () => snapshotWith({ index: 21, name: 'Pay now', backendNodeId: 23 }),
  })
  t.onCleanup(() => {
    teardown()
    return host.close()
  })

  const answered = new Promise((resolve) => host.answers.set(21, resolve))
  host.send({ id: 21, method: 'page.click', params: { tabId: 7, index: 21 } })
  await answered

  const documentAt = chrome.__cdp.indexOf('DOM.getDocument')
  const pushAt = chrome.__cdp.indexOf('DOM.pushNodesByBackendIdsToFrontend')
  assert.notEqual(documentAt, -1, 'the document was never requested')
  assert.notEqual(pushAt, -1, 'the backend id was never pushed')
  assert.ok(documentAt < pushAt, `the push came before the document: ${JSON.stringify(chrome.__cdp)}`)
})

test('an element with no stable id still clicks, by its measured bounds', async (t) => {
  // The fallback is not dead code: a snapshot the AX domain refused, or a node
  // the browser will not push, still has to be clickable. Its bounds are in the
  // snapshot, and that is what a page that has not changed needs.
  const { host, chrome, teardown } = await start({
    // A button whose row carries no backend id at all.
    snapshot: () => snapshotWith({ index: 21, name: 'Pay now', withBackendId: false }),
  })
  t.onCleanup(() => {
    teardown()
    return host.close()
  })

  const answered = new Promise((resolve) => host.answers.set(22, resolve))
  host.send({ id: 22, method: 'page.click', params: { tabId: 7, index: 21 } })
  const answer = await answered

  assert.equal(answer.ok, true, `the fallback click failed: ${answer.message ?? ''}`)
  const pressed = chrome.__clicks.find((click) => click.type === 'mousePressed')
  // Centre of [10, 10, 120, 30] from the snapshot's own layout table.
  assert.equal(pressed?.x, 70, 'the fallback did not use the snapshot bounds')
  assert.equal(pressed?.y, 25, 'the fallback did not use the snapshot bounds')
  assert.equal(
    chrome.__cdp.includes('DOM.pushNodesByBackendIdsToFrontend'),
    false,
    'a push was attempted for an element with no stable id',
  )
})

test('a stable id the browser will not resolve falls back instead of failing', async (t) => {
  // Pushing can legitimately fail: the node was replaced, the document
  // navigated, or the id belongs to a frame that is gone. An outright error
  // would turn "the page moved on" into "the tool is broken", when the position
  // is still usable.
  const { host, chrome, teardown } = await start({
    snapshot: () => snapshotWith({ index: 21, name: 'Pay now', backendNodeId: 23 }),
    pushFails: true,
  })
  t.onCleanup(() => {
    teardown()
    return host.close()
  })

  const answered = new Promise((resolve) => host.answers.set(23, resolve))
  host.send({ id: 23, method: 'page.click', params: { tabId: 7, index: 21 } })
  const answer = await answered

  assert.equal(answer.ok, true, `a failed resolve broke the click: ${answer.message ?? ''}`)
  const pressed = chrome.__clicks.find((click) => click.type === 'mousePressed')
  assert.equal(pressed?.x, 70, 'the fallback point is wrong after a failed push')
})

test('an index that is not in the page any more says so', async (t) => {
  // The other failure the positional lookup produced: the element is simply not
  // there. The old code reported "does not name an element with visible bounds",
  // which reads like a rendering quirk; what happened is that the page moved on.
  const { host, teardown } = await start({
    snapshot: () => snapshotWith({ index: 5, name: 'Send', backendNodeId: 9 }),
  })
  t.onCleanup(() => {
    teardown()
    return host.close()
  })

  const answered = new Promise((resolve) => host.answers.set(24, resolve))
  host.send({ id: 24, method: 'page.click', params: { tabId: 7, index: 999 } })
  const answer = await answered

  assert.equal(answer.ok, false, 'an index that no longer exists was clicked anyway')
  assert.match(
    String(answer.message ?? ''),
    /not in this page any more/,
    `the error does not say the page moved on: ${answer.message}`,
  )
  assert.match(String(answer.message ?? ''), /fresh snapshot/, 'the error does not say what to do about it')
})

test('a frame-relative index is refused rather than clicked at the wrong point', async (t) => {
  // `layout.bounds` is measured against its own document's viewport, and a
  // synthetic click is in page coordinates. For a row inside a frame those are
  // different spaces, and the numbers are not obviously wrong — measured on a
  // checkout, a button 8px into a frame sitting at page y=50 reported y=8, and
  // clicking (70, 25) pressed whatever sits there on the *top* page.
  //
  // So an element with no stable id inside a frame must not be clicked by
  // position. The primary path is unaffected: `DOM.getBoxModel` converts into
  // page space itself, which the test above covers.
  const { host, chrome, teardown } = await start({
    snapshot: () => snapshotWith({ index: 21, name: 'Pay now', withBackendId: false, inFrame: true }),
  })
  t.onCleanup(() => {
    teardown()
    return host.close()
  })

  const answered = new Promise((resolve) => host.answers.set(25, resolve))
  host.send({ id: 25, method: 'page.click', params: { tabId: 7, index: 21 } })
  const answer = await answered

  assert.equal(answer.ok, false, 'a frame row was clicked at frame-relative coordinates')
  assert.equal(
    chrome.__clicks.length,
    0,
    `a click was dispatched into the wrong coordinate space: ${JSON.stringify(chrome.__clicks)}`,
  )
  assert.match(
    String(answer.message ?? ''),
    /inside a frame/,
    `the error does not say why the index cannot be used: ${answer.message}`,
  )
  assert.match(String(answer.message ?? ''), /fresh snapshot/, 'the error does not say what to do about it')
})

test('a page with more elements than the wire cap still names the ones it lists', async (t) => {
  // `pageSnapshot` renders every element into the text but ships only the first
  // 400 on the wire, and `resolveTarget` looks the index up in that shipped
  // array. So on a page past the cap there is a band of indexes the model can
  // read and cannot click — and the message it gets says the element is "not in
  // this page any more", which is false: the page has not moved, the frame was
  // cut. Either the two agree or the reader is being told something untrue.
  const count = 450
  const { host, chrome, teardown } = await start({ snapshot: () => snapshotMany(count) })
  t.onCleanup(() => {
    teardown()
    return host.close()
  })

  const snapped = new Promise((resolve) => host.answers.set(30, resolve))
  host.send({ id: 30, method: 'page.snapshot', params: { tabId: 7, interactiveOnly: true, maxBytes: 200000 } })
  const answer = await snapped
  assert.equal(answer.ok, true, `the snapshot failed: ${answer.message ?? ''}`)

  const shipped = answer.value.elements.length
  const named = answer.value.elementCount
  assert.equal(named, count, `the page reports ${named} elements, expected ${count}`)

  // The cap is allowed to exist; what is not allowed is naming an index the wire
  // cannot address. The strongest way to say that is to press the last index the
  // text mentions: a number the model can read is a number it will try to use.
  const highestNamed = Math.max(
    ...String(answer.value.text)
      .split('\n')
      .map((line) => Number(line.trim().match(/^#(\d+)/)?.[1] ?? -1)),
  )
  assert.ok(highestNamed > 0, 'the fixture rendered no indexed rows, so nothing below is proved')

  const clicked = new Promise((resolve) => host.answers.set(31, resolve))
  host.send({ id: 31, method: 'page.click', params: { tabId: 7, index: highestNamed } })
  const result = await clicked
  assert.equal(
    result.ok,
    true,
    `index ${highestNamed} was named in the text but could not be clicked: ${result.message ?? ''}`,
  )
  assert.ok(chrome.__clicks.length > 0, 'the click resolved to no point at all')
  assert.ok(chrome.__cdp.includes('DOMSnapshot.captureSnapshot'), 'the snapshot path did not run')
})
