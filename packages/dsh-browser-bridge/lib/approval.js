/**
 * Carry an approval question to the side panel, and carry the answer back.
 *
 * The harness composes its answerers from whatever is attached, and the only
 * one that ships is the graphical client's. So a turn that starts in the side
 * panel and then touches a gated tool blocks on a question rendered in a window
 * the person has no reason to be looking at: the turn waits, the panel spins,
 * and nothing anywhere says why. That is not a cosmetic problem — the turn
 * never finishes.
 *
 * A host plugin is allowed to be an answerer too; `dsh-acp` is one, and this is
 * the same shape. The two rules that make it safe:
 *
 *   - **Never take the question away from the client.** The panel is asked and
 *     the rest of the waterfall is asked, and whoever answers first decides.
 *     Someone working in the harness's own window keeps the surface they
 *     already had.
 *   - **`unavailable` is not a decision.** It is the harness's word for "no
 *     answerer took this", which is exactly what the downstream chain returns
 *     when no graphical client is attached. Treating it as an answer would
 *     refuse every question the moment the panel is the only surface — so the
 *     race ignores it and keeps waiting.
 *
 * The answer travels over the panel's own HTTP route rather than the bridge
 * socket, because that socket only carries requests in one direction and this
 * reply has to come back the other way.
 *
 * @module dsh-browser-bridge/approval
 */

import { NOTIFICATIONS } from './protocol.js'

/**
 * Every outcome the harness accepts, per `dsh-user-approval`'s `OUTCOMES`.
 *
 * A rogue or stale value is normalized to `unavailable` by the service, so
 * anything outside this list is a bug on our side, not a decision.
 */
export const APPROVAL_OUTCOMES = Object.freeze(['allowed-once', 'rejected', 'cancelled', 'unavailable'])

/**
 * The outcomes the panel is offered.
 *
 * Two, deliberately. The harness grants `allowed-once` and nothing else —
 * whether that becomes "for this site, for the rest of the session" is the
 * bridge's own `persistentApproval` decision, made after the fact. Offering a
 * third button that says "always allow" would be a lie about what the harness
 * can promise. `dsh-acp`, the other non-graphical client, offers the same two.
 */
export const PANEL_OPTIONS = Object.freeze(['allowed-once', 'rejected'])

/** A promise that never settles, for "this branch has nothing to say yet". */
const NEVER = new Promise(() => {})

/**
 * Relay approval questions between the harness and the side panel.
 *
 * The relay is deliberately transport-agnostic about the answer: it hands out
 * an id when it asks, and `answer(id, outcome)` is what settles the question.
 * The HTTP route in `lib/index.js` is just a caller.
 */
export class ApprovalRelay {
  #bridge
  #log
  /** @type {Map<string, { resolve: (outcome: string) => void, sessionId: string, toolName: string }>} */
  #pending = new Map()
  #seq = 0
  #stats = { asked: 0, delivered: 0, undeliverable: 0, byPanel: 0, byOther: 0, refused: 0 }

  /**
   * @param {{ bridge?: { connection?: { notify: (name: string, payload: unknown) => boolean } }, log?: (message: string) => void }} [options] - Relay ports.
   */
  constructor(options = {}) {
    this.#bridge = options.bridge
    this.#log = options.log ?? (() => {})
  }

  /**
   * Become one of the harness's approval answerers.
   *
   * @param {{ on: (event: string, listener: (request: unknown, next: () => Promise<string>) => unknown) => (() => void) | undefined }} ctx - A Cordis context whose `on` returns an unsubscribe function.
   * @returns {() => void} Detach the subscription.
   */
  attach(ctx) {
    const off = ctx.on('approval/request', (request, next) => this.#handle(request, next))
    return () => {
      if (typeof off === 'function') off()
    }
  }

  /**
   * Answer one question the panel was asked.
   *
   * @param {unknown} id - The id from the `approval/asked` notification.
   * @param {unknown} outcome - One of {@link PANEL_OPTIONS}.
   * @returns {{ answered: boolean, reason?: string, id?: string, outcome?: string }} The result.
   */
  answer(id, outcome) {
    const entry = typeof id === 'string' ? this.#pending.get(id) : undefined
    if (entry === undefined) {
      this.#stats.refused += 1
      // Two ordinary reasons to land here: the question was already answered at
      // the other surface, or the turn was cancelled while the panel was
      // deciding. Both mean the same thing to the panel — take the card away.
      return { answered: false, reason: 'that question is no longer open' }
    }
    if (!PANEL_OPTIONS.includes(outcome)) {
      this.#stats.refused += 1
      return { answered: false, reason: `the panel may only answer ${PANEL_OPTIONS.join(' or ')}` }
    }
    this.#pending.delete(id)
    entry.resolve(outcome)
    this.#stats.byPanel += 1
    this.#withdraw(id, outcome)
    return { answered: true, id, outcome }
  }

  /** Questions still waiting for an answer. For the health route. */
  pending() {
    return [...this.#pending.entries()].map(([id, entry]) => ({ id, sessionId: entry.sessionId, toolName: entry.toolName }))
  }

  /** Counters, so a relay that never fires is distinguishable from one that is idle. */
  stats() {
    return { ...this.#stats, open: this.#pending.size }
  }

  /**
   * Ask the panel, and let the rest of the waterfall answer in parallel.
   *
   * @param {unknown} request - The harness's approval request.
   * @param {() => Promise<string>} next - Continue the waterfall (the graphical client).
   * @returns {Promise<string>} The winning outcome, or the downstream result.
   */
  async #handle(request, next) {
    const question = this.#question(request)
    if (question === undefined) return next()

    const id = `panel-${(this.#seq += 1)}`
    const payload = { ...question, id, options: [...PANEL_OPTIONS] }
    const delivered = this.#notify(NOTIFICATIONS.approvalAsked, payload)
    if (!delivered) {
      // No extension is attached, so nobody can answer this here. Staying out
      // of the way is the whole point: the client's own answerer still runs.
      this.#stats.undeliverable += 1
      return next()
    }

    this.#stats.asked += 1
    this.#stats.delivered += 1
    const viaPanel = new Promise((resolve) => {
      this.#pending.set(id, { resolve, sessionId: payload.sessionId, toolName: payload.toolName })
    })

    const downstream = Promise.resolve()
      .then(() => next())
      // `unavailable` is "nobody downstream took it", not "the user said no".
      .then((outcome) => (outcome === 'unavailable' ? NEVER : outcome), () => NEVER)

    let winner
    try {
      winner = await Promise.race([viaPanel, downstream])
    } finally {
      if (this.#pending.delete(id)) {
        // The question was settled somewhere else — most often in the graphical
        // client. The panel has a card on screen for it, so it is told to drop
        // it rather than left offering buttons for a decision already made.
        this.#notify(NOTIFICATIONS.approvalSettled, { id, outcome: 'answered-elsewhere' })
      }
    }
    if (winner !== undefined) this.#stats.byOther += 1
    return winner
  }

  /**
   * Reduce a harness approval request to what the panel needs.
   *
   * @param {unknown} request - The approval request.
   * @returns {{ sessionId: string, toolName: string, reason?: string, callId?: string } | undefined} The question, or undefined when it cannot be addressed.
   */
  #question(request) {
    if (typeof request !== 'object' || request === null) return undefined
    const sessionId = request.agent?.session?.id
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    const toolName = typeof request.toolName === 'string' && request.toolName.length > 0 ? request.toolName : 'a tool'
    return {
      sessionId,
      toolName,
      ...(typeof request.reason === 'string' && request.reason.length > 0 ? { reason: request.reason } : {}),
      ...(typeof request.callId === 'string' ? { callId: request.callId } : {}),
    }
  }

  /**
   * Tell the panel a question is over, whoever answered it.
   *
   * @param {string} id - The question id.
   * @param {string} outcome - What it was settled with.
   * @returns {void}
   */
  #withdraw(id, outcome) {
    this.#notify(NOTIFICATIONS.approvalSettled, { id, outcome })
  }

  /**
   * Best-effort delivery, counted rather than thrown.
   *
   * @param {string} name - The notification name.
   * @param {unknown} payload - Its body.
   * @returns {boolean} Whether it went out.
   */
  #notify(name, payload) {
    const connection = this.#bridge?.connection
    if (connection === undefined || typeof connection.notify !== 'function') return false
    try {
      return connection.notify(name, payload) === true
    } catch (error) {
      this.#log(`approval relay could not notify: ${error?.message ?? error}`)
      return false
    }
  }
}

/**
 * Build a relay.
 *
 * @param {ConstructorParameters<typeof ApprovalRelay>[0]} [options] - Relay ports.
 * @returns {ApprovalRelay} The relay.
 */
export function createApprovalRelay(options = {}) {
  return new ApprovalRelay(options)
}
