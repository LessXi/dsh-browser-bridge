/**
 * The approval relay's rules.
 *
 * Every case here is a way a turn could end up waiting forever, which is the
 * failure this relay exists to remove: the panel was never asked, the question
 * was asked and then withdrawn, or the relay mistook "nobody downstream took
 * the question" for a decision and refused it on the user's behalf.
 *
 * @module dsh-browser-bridge/test/approval
 */

import { test, assert } from './harness.js'
import { createApprovalRelay, PANEL_OPTIONS } from '../lib/approval.js'
import { NOTIFICATIONS } from '../lib/protocol.js'

/**
 * A relay wired to an in-memory socket, plus the traffic it produced.
 *
 * @param {{ delivered?: boolean }} [options] - `delivered: false` makes every
 *   notification fail, standing in for "no extension is attached".
 * @returns {object} The fixture.
 */
function fixture(options = {}) {
  const attempts = []
  const sent = []
  const listeners = []
  const delivered = options.delivered !== false
  const relay = createApprovalRelay({
    bridge: {
      connection: {
        notify(name, payload) {
          // Attempts and deliveries are counted apart on purpose: "the relay
          // tried to ask and nothing was listening" is a different fact from
          // "the relay never tried", and tests need to tell them apart.
          attempts.push({ name, payload })
          if (!delivered) return false
          sent.push({ name, payload })
          return true
        },
      },
    },
  })
  relay.attach({
    on(event, listener) {
      listeners.push({ event, listener })
      return () => {
        const at = listeners.findIndex((entry) => entry.listener === listener)
        if (at >= 0) listeners.splice(at, 1)
      }
    },
  })

  return {
    relay,
    sent,
    attempts,
    listeners,
    /** Run the registered answerer for one request. */
    ask: (req, next) => listeners[0].listener(req, next),
    /** The most recent question put to the panel. */
    lastAsked: () => [...sent].reverse().find((entry) => entry.name === NOTIFICATIONS.approvalAsked)?.payload,
    /** Whether the panel was told a question closed. */
    settled: () => sent.filter((entry) => entry.name === NOTIFICATIONS.approvalSettled),
  }
}

/**
 * A harness approval request.
 *
 * @param {object} [overrides] - Fields to replace.
 * @returns {any} The request.
 */
function request(overrides = {}) {
  return {
    agent: { session: { id: 'session-1' } },
    toolName: 'browser_click',
    reason: 'clicking on https://example.com',
    callId: 'call-1',
    ...overrides,
  }
}

/** The downstream answerer for a harness with no graphical client attached. */
const unavailable = () => Promise.resolve('unavailable')

/**
 * Settle-or-not, without hanging if the answer never comes.
 *
 * @param {Promise<unknown>} promise - The relay's answer.
 * @returns {Promise<unknown>} `'pending'` when it has not settled.
 */
function race(promise) {
  return Promise.race([
    promise.then((value) => value, (error) => error),
    new Promise((resolve) => {
      setTimeout(() => resolve('pending'), 0)
    }),
  ])
}

test('a question reaches the panel with the options it may answer with', async () => {
  const { ask, lastAsked, relay } = fixture()
  const promise = ask(request(), unavailable)

  const asked = lastAsked()
  assert.ok(asked, 'the panel was never asked')
  assert.deepEqual(asked.options, [...PANEL_OPTIONS])
  assert.equal(asked.sessionId, 'session-1')
  assert.equal(asked.toolName, 'browser_click')
  assert.equal(asked.reason, 'clicking on https://example.com')
  assert.equal(typeof asked.id, 'string')

  assert.deepEqual(relay.answer(asked.id, 'allowed-once'), {
    answered: true,
    id: asked.id,
    outcome: 'allowed-once',
  })
  assert.equal(await promise, 'allowed-once')
})

test('the tool structured facts travel with the question, not just its prose', async () => {
  // The panel writes its own sentence in the reader's language, so it needs the
  // facts rather than the English line `page-tools.js` passes to
  // `approval.request()`. Without these it can only echo the prose.
  const { ask, lastAsked } = fixture()
  ask(request({ origin: 'https://dl.acm.org', capability: 'access' }), unavailable)

  const asked = lastAsked()
  assert.equal(asked.origin, 'https://dl.acm.org')
})

test('a question with no facts invents none', async () => {
  // A tool this plugin does not own supplies no origin, and a fabricated one
  // would name the wrong site in a card whose whole job is naming the site.
  const { ask, lastAsked } = fixture()
  ask(request(), unavailable)

  const asked = lastAsked()
  assert.equal(typeof asked.origin, 'undefined')
  assert.equal(typeof asked.sensitive, 'undefined')
})

test('a state-changing question is marked as more than a read', async () => {
  const { ask, lastAsked } = fixture()
  ask(request({ sensitive: true }), unavailable)
  assert.equal(lastAsked().sensitive, true)
})

test('the scope the panel chose survives the harness, which has no room for it', async () => {
  // `approval.request()` resolves to an outcome and nothing else, so how long a
  // yes lasts cannot come back that way. The relay answered the question, so it
  // carries the scope and the asking tool reads it back by call id.
  const { ask, lastAsked, relay } = fixture()
  const promise = ask(request({ callId: 'call-scope' }), unavailable)
  const asked = lastAsked()

  assert.equal(relay.scopeOf('call-scope'), undefined, 'a scope existed before anyone chose one')
  assert.deepEqual(relay.answer(asked.id, 'allowed-once', 'once'), {
    answered: true,
    id: asked.id,
    outcome: 'allowed-once',
    scope: 'once',
  })
  assert.equal(await promise, 'allowed-once')
  assert.equal(relay.scopeOf('call-scope'), 'once', 'the chosen scope did not survive the answer')
  // Read-once: a scope belongs to the one decision it was given for, so a later
  // question about the same call cannot inherit it.
  assert.equal(relay.scopeOf('call-scope'), undefined, 'the scope was handed out twice')
})

test('an unknown scope is not recorded, and the answer still lands', async () => {
  const { ask, lastAsked, relay } = fixture()
  const promise = ask(request({ callId: 'call-bad' }), unavailable)
  const result = relay.answer(lastAsked().id, 'allowed-once', 'always')

  // The button that would promise "always" does not exist, because the grant
  // table is in memory and a restart drops it.
  assert.equal(result.answered, true)
  assert.equal(result.scope, undefined)
  assert.equal(relay.scopeOf('call-bad'), undefined)
  assert.equal(await promise, 'allowed-once')
})

test('a refusal carries no scope at all', async () => {
  const { ask, lastAsked, relay } = fixture()
  const promise = ask(request({ callId: 'call-no' }), unavailable)
  relay.answer(lastAsked().id, 'rejected')

  assert.equal(relay.scopeOf('call-no'), undefined, 'a duration was read out of a no')
  assert.equal(await promise, 'rejected')
})

test('two questions on one session keep their own scopes', async () => {
  const { ask, relay, sent } = fixture()
  const first = ask(request({ callId: 'call-1' }), unavailable)
  const asked1 = sent.filter((entry) => entry.name === NOTIFICATIONS.approvalAsked).at(-1).payload
  relay.answer(asked1.id, 'allowed-once', 'once')
  await first

  const second = ask(request({ callId: 'call-2' }), unavailable)
  const asked2 = sent.filter((entry) => entry.name === NOTIFICATIONS.approvalAsked).at(-1).payload
  relay.answer(asked2.id, 'allowed-once', 'conversation')
  await second

  assert.equal(relay.scopeOf('call-1'), 'once')
  assert.equal(relay.scopeOf('call-2'), 'conversation')
})

test('nobody downstream taking the question is not a decision', async () => {
  // The load-bearing case. `unavailable` is the harness's word for "no answerer
  // took this", and the graphical client returns exactly that when it is not
  // attached. Reading it as an answer would refuse every question the instant
  // the panel is the only surface — turning "the panel can answer" into "the
  // panel must answer immediately or the tool is denied".
  const { ask, lastAsked, relay } = fixture()
  const promise = ask(request(), unavailable)

  assert.equal(await race(promise), 'pending', 'the downstream "no answerer" settled the question')

  relay.answer(lastAsked().id, 'rejected')
  assert.equal(await promise, 'rejected')
})

test('the graphical client still wins when it answers first', async () => {
  const { ask, settled } = fixture()
  const promise = ask(request(), () => Promise.resolve('allowed-once'))
  assert.equal(await promise, 'allowed-once')

  // The panel is told to drop its card: a card still offering buttons for a
  // decision already made looks like a broken panel.
  const told = settled()
  assert.equal(told.length, 1, 'the panel was never told the question closed')
  assert.equal(told[0].payload.outcome, 'answered-elsewhere')
})

test('a question with no extension attached stays out of the waterfall', async () => {
  const { ask, sent, attempts, relay } = fixture({ delivered: false })
  const promise = ask(request(), () => Promise.resolve('rejected'))

  // The downstream answer decides, and nothing is left waiting on a panel that
  // was never asked — which is what keeps the harness's own client working when
  // the extension is not installed.
  assert.equal(await promise, 'rejected')
  // It tried once and gave up: the question is never put to a panel that cannot
  // receive it, and no card is left on screen.
  assert.equal(attempts.length, 1)
  assert.equal(sent.length, 0)
  assert.equal(relay.stats().undeliverable, 1)
})

test('an outcome the panel may not choose is refused, not passed on', async () => {
  const { ask, lastAsked, relay } = fixture()
  const promise = ask(request(), unavailable)
  const id = lastAsked().id

  // `cancelled` is the harness's own abort and `unavailable` means "no
  // answerer". Neither is a button in this panel, so neither may be sent.
  for (const outcome of ['cancelled', 'unavailable', '', undefined]) {
    const refused = relay.answer(id, outcome)
    assert.equal(refused.answered, false, `${JSON.stringify(outcome)} was accepted`)
    assert.match(refused.reason, /may only answer/)
  }
  assert.equal(relay.pending().length, 1, 'a refused answer closed the question anyway')

  relay.answer(id, 'allowed-once')
  assert.equal(await promise, 'allowed-once')
})

test('answering a question twice is refused the second time', async () => {
  const { ask, lastAsked, relay } = fixture()
  const promise = ask(request(), unavailable)
  const id = lastAsked().id

  assert.equal(relay.answer(id, 'allowed-once').answered, true)
  const again = relay.answer(id, 'rejected')
  assert.equal(again.answered, false)
  assert.match(again.reason, /no longer open/)
  assert.equal(await promise, 'allowed-once')
})

test('an unknown question id is refused with a reason', () => {
  const { relay } = fixture()
  const refused = relay.answer('panel-999', 'allowed-once')
  assert.equal(refused.answered, false)
  assert.match(refused.reason, /no longer open/)
  assert.equal(relay.stats().refused, 1)
})

test('a request with no session to address is passed straight through', async () => {
  const { ask, attempts } = fixture()
  const promise = ask(request({ agent: undefined }), () => Promise.resolve('allowed-once'))
  assert.equal(await promise, 'allowed-once')
  // A question that cannot be attributed to a session would have to be guessed
  // at, and guessing which session a click belongs to is worse than not asking.
  assert.equal(attempts.length, 0)
})

test('a nameless tool is still a question the panel can render', async () => {
  const { ask, lastAsked, relay } = fixture()
  const promise = ask(request({ toolName: '' }), unavailable)
  assert.equal(lastAsked().toolName, 'a tool')
  relay.answer(lastAsked().id, 'rejected')
  assert.equal(await promise, 'rejected')
})

test('stats distinguish a relay that never fired from one that is idle', () => {
  const { relay } = fixture({ delivered: false })
  assert.deepEqual(relay.stats(), {
    asked: 0,
    delivered: 0,
    undeliverable: 0,
    byPanel: 0,
    byOther: 0,
    refused: 0,
    open: 0,
  })
  assert.deepEqual(relay.pending(), [])
})

test('a delivered question is counted while it is open', async () => {
  const { ask, lastAsked, relay } = fixture()
  const promise = ask(request(), unavailable)
  assert.deepEqual(relay.stats(), {
    asked: 1,
    delivered: 1,
    undeliverable: 0,
    byPanel: 0,
    byOther: 0,
    refused: 0,
    open: 1,
  })
  assert.deepEqual(relay.pending(), [{ id: lastAsked().id, sessionId: 'session-1', toolName: 'browser_click' }])

  relay.answer(lastAsked().id, 'allowed-once')
  assert.equal(await promise, 'allowed-once')
  assert.equal(relay.stats().byPanel, 1)
  assert.equal(relay.stats().open, 0)
})

test('detaching stops the relay from answering for the harness', () => {
  const listeners = []
  const relay = createApprovalRelay()
  const off = relay.attach({
    on(event, listener) {
      listeners.push(listener)
      return () => listeners.splice(0, listeners.length)
    },
  })
  assert.equal(listeners.length, 1)
  off()
  assert.equal(listeners.length, 0)
})
