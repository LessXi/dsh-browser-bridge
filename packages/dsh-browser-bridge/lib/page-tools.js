/**
 * Page tools: everything that touches a page, behind one gate.
 *
 * Every tool here resolves "which origin is this acting on" and runs it through
 * the same three checks before it does anything:
 *
 *   1. **Policy** — the origin's rules decide whether the capability exists at
 *      all. A denied origin is refused here, before the model is even asked,
 *      and the refusal names the rule so it is not mistaken for a bug.
 *   2. **Grant** — an earlier approval may already cover this session.
 *   3. **Approval** — otherwise the user is asked, with the four choices they
 *      expect, and the answer is recorded as a grant or not at all.
 *
 * Two capabilities are deliberately outside the grant system: browser history
 * (which is never remembered as allowed) and Developer-mode passthrough (which
 * re-asks every time, because a page-inspection grant is not a grant to run
 * arbitrary protocol calls against it). Sensitivity is a *second* prompt on top
 * of a granted origin, so approving a site to read never implies approving it
 * to spend money.
 *
 * @module dsh-browser-bridge/page-tools
 */

import { BRIDGE_ERRORS } from './bridge.js'
import { APPROVAL_SCOPES } from './approval.js'
import { classifySensitivity } from './grants.js'
import { METHODS } from './protocol.js'
import { normalizeOrigin, PolicySyntaxError, resolveOriginPolicy } from './policy.js'
import { failureText, provenanceNote, squashOneLine, textOutput, untrusted } from './tools.js'

/** Capabilities a tool requires from the site's policy. */
const NEEDS_ACCESS = 'access'
const NEEDS_UPLOADS = 'uploads'
const NEEDS_DOWNLOADS = 'downloads'
const NEEDS_FULL_CDP = 'full_cdp_access'

/**
 * Characters of a raw CDP result `browser_cdp` will hand back.
 *
 * The raw passthrough exists for the calls the purpose-built tools do not cover,
 * and those are exactly the ones that return whole documents —
 * `DOMSnapshot.captureSnapshot` on an ordinary page runs to tens of thousands of
 * characters. The cap keeps one call from filling the context, and the marker
 * that accompanies it is what keeps the cap from lying.
 */
const CDP_RESULT_MAX = 20_000

/**
 * How many links `browser_read` lists before it says it stopped.
 *
 * The bound is about a page's worth of reading, not about correctness: the
 * count that goes unshown is reported, so a page with more is still legible as
 * "there are more" rather than as "this is all there is".
 */
const LINK_LIST_MAX = 60

/**
 * Build the page tools.
 *
 * @param {object} ports - Injected dependencies.
 * @param {object} ports.bridge - The bridge registry.
 * @param {() => Record<string, unknown>} ports.settings - Effective settings.
 * @param {() => Record<string, unknown>} ports.connectionStatus - Last connection facts.
 * @param {object} ports.grants - A {@link import('./grants.js').GrantTable}.
 * @param {object} ports.contextAttachments - A {@link import('./context.js').ContextAttachments}.
 * @param {() => object} ports.attachmentStore - Resolves the harness attachment store, or
 *   `undefined` in a profile that mounts none. Called per screenshot rather than captured,
 *   because the store registers later than this plugin activates.
 * @param {object} ports.approval - The harness approval service, or a stub.
 * @param {(url: string) => Promise<string>} ports.tabOrigin - Resolves the origin of a tab.
 * @returns {object[]} Tool definitions.
 */
export function buildPageTools(ports) {
  const { bridge, settings, connectionStatus, grants, contextAttachments, attachmentStore, approval, tabOrigin } = ports
  /**
   * Which answer scope the person chose, read back from the relay.
   *
   * The harness's approval outcome has no room for a duration, so the surface
   * that answered records it and this asks for it. Absent means an older panel
   * or the graphical client, and the configured default applies.
   *
   * @param {unknown} callId - The tool call the question was about.
   * @returns {string | undefined} `'once'`, `'conversation'`, or undefined.
   */
  const scopeOf = (callId) => (typeof ports.approvalScope === 'function' ? ports.approvalScope(callId) : undefined)

  /**
   * Resolve the normalized origin a call is acting on.
   * @param {Record<string, unknown>} args - The tool arguments.
   * @returns {Promise<{ origin: string } | { error: string }>} The origin or a diagnostic.
   */
  const originOf = async (args) => {
    const url = typeof args.url === 'string' ? args.url : ''
    if (url.length > 0) {
      try {
        return { origin: normalizeOrigin(url) }
      } catch (error) {
        return { error: `${error.message}. Pass an absolute http(s) URL.` }
      }
    }
    if (Number.isInteger(args.tab_id)) {
      try {
        const origin = await tabOrigin(Number(args.tab_id))
        if (origin === undefined) return { error: `could not determine which site tab ${args.tab_id} is on; call browser_tabs first` }
        return { origin }
      } catch (error) {
        return { error: `could not determine which site tab ${args.tab_id} is on: ${error.message}` }
      }
    }
    return { error: 'this call needs either a url or a tab_id so the site policy can be applied' }
  }

  /**
   * Ask the configured approval answerer, mapping its verdict onto the four
   * user-facing choices.
   *
   * The harness answers a one-shot question; "for this site" and "for all
   * sites" are expressed by *what the caller records afterwards*, not by the
   * answer itself. This function therefore only decides grant duration, and
   * leaves recording to the caller.
   *
   * @param {object} input - The pending decision.
   * @param {string} input.toolName - The tool being approved.
   * @param {string} input.origin - The normalized origin.
   * @param {string} input.capability - The capability needed.
   * @param {string} input.reason - Why it is being asked.
   * @param {object} input.exec - The tool execution (supplies agent, callId, signal).
   * @returns {Promise<{ outcome: 'allowed' | 'denied' | 'unavailable', choice: string, lifetime: 'turn' | 'thread' }>}
   *   The decision.
   */
  const askApproval = async (input) => {
    const effective = settings()
    const enabled = effective.confirmSensitiveActions !== false
    if (approval === undefined || typeof approval.request !== 'function' || input.exec?.agent === undefined) {
      // Without an answerer the harness policy is fail-closed, so matching that
      // is the only safe reading: refuse and say why.
      return { outcome: 'unavailable', choice: 'decline', lifetime: effective.accessApprovalLifetime === 'turn' ? 'turn' : 'thread' }
    }
    if (enabled === false) {
      return { outcome: 'allowed', choice: 'allow-once', lifetime: 'turn' }
    }

    let verdict
    try {
      verdict = await approval.request({
        agent: input.exec.agent,
        toolName: input.toolName,
        callId: input.exec.callId,
        reason: input.reason,
        // `reason` is prose for a log; these are the facts behind it. The
        // harness passes the request object through the waterfall untouched
        // (`dsh-user-approval/lib/index.js` forwards `req` verbatim), so a
        // surface that wants to write its own sentence — the side panel, in the
        // reader's language — can do that instead of echoing this English line.
        origin: input.origin,
        capability: input.capability,
        ...(input.sensitive === true ? { sensitive: true } : {}),
        signal: input.exec.signal,
      })
    } catch (error) {
      return { outcome: 'unavailable', choice: 'decline', lifetime: 'thread', error }
    }

    if (verdict === 'allowed-once') {
      // The harness has exactly one grant word, `allowed-once`, so the duration
      // has to be decided here. It is read from what the answering surface
      // actually offered rather than from a config default: the panel now shows
      // three buttons that say what they do ("Allow once" / "Allow this
      // conversation" / "Always allow"), and a config knob that silently widened
      // "once" into "for this session" is how a button labelled 「允许一次」 was
      // recording a session-wide grant.
      //
      // `approval.request` resolves to the outcome alone, so the chosen scope
      // travels back on the relay and is read from there. An older panel, or the
      // graphical client, sends nothing — then the configured default applies,
      // which is what that setting is for.
      const asked = typeof input.approvalScope === 'function' ? input.approvalScope() : undefined
      const wanted = APPROVAL_SCOPES.includes(asked) ? asked : undefined
      const persistent = effective.persistentApproval !== false
      if (wanted === 'once') {
        // "Once" means once, so nothing is recorded and the next call asks
        // again. It used to fall through to the configured default, so the
        // button labelled 「允许一次」 recorded a site grant lasting the session.
        //
        // `record: false` rather than `lifetime: 'turn'`: a turn grant is swept
        // on an idle gap, which means it still covers every call for the next
        // five minutes — a real grant the label did not promise. Not recording
        // is the only reading of "once" that keeps the button honest.
        return { outcome: 'allowed', choice: 'allow-once', lifetime: 'turn', record: false }
      }
      if (wanted === 'conversation') {
        return { outcome: 'allowed', choice: 'allow-for-site', lifetime: 'thread' }
      }
      return {
        outcome: 'allowed',
        // `thread` is the product default, so an approved site does not re-ask
        // for the rest of the session unless the deployment shortened it.
        choice: persistent ? 'allow-for-site' : 'allow-once',
        lifetime: effective.accessApprovalLifetime === 'turn' ? 'turn' : 'thread',
      }
    }
    if (verdict === 'rejected' || verdict === 'cancelled') return { outcome: 'denied', choice: 'decline', lifetime: 'thread' }
    return { outcome: 'unavailable', choice: 'decline', lifetime: 'thread' }
  }

  /**
   * Run the policy, grant, and approval checks for one call.
   *
   * @param {object} input - The gate input.
   * @param {string} input.toolName - The tool being called.
   * @param {Record<string, unknown>} input.args - The tool arguments.
   * @param {object} input.exec - The tool execution.
   * @param {string} [input.capability] - The capability needed; defaults to access.
   * @param {boolean} [input.alwaysAsk] - Skip the grant lookup, and never record one.
   * @param {boolean} [input.requireDeveloperMode] - Require the passthrough switch.
   * @returns {Promise<{ ok: true, origin: string } | { ok: false, text: string }>} The verdict.
   */
  const gate = async (input) => {
    const effective = settings()
    if (effective.enabled === false) {
      return { ok: false, text: `${input.toolName} is switched off: the browser bridge is disabled in DSH Settings → Plugins.` }
    }
    if (input.requireDeveloperMode === true && effective.developerMode !== true) {
      return {
        ok: false,
        text: `${input.toolName} needs Developer mode. Turn on "developerMode" in DSH Settings → Plugins → browser-bridge, and allow it per site. It is off by default because it reaches browser internals beyond reading a page.`,
      }
    }

    const resolved = await originOf(input.args)
    if ('error' in resolved) return { ok: false, text: `${input.toolName} cannot run: ${resolved.error}` }
    const origin = resolved.origin

    const capability = input.capability ?? NEEDS_ACCESS
    let policy
    try {
      policy = resolveOriginPolicy(origin, ports.policyLayers())
    } catch (error) {
      if (error instanceof PolicySyntaxError) {
        return { ok: false, text: `${input.toolName} cannot run: the site rules are misconfigured — ${error.message}` }
      }
      throw error
    }

    const field = capability === NEEDS_FULL_CDP ? 'fullCdpAccess' : capability
    if (policy[field] === 'deny' || policy.access === 'deny') {
      const rule = policy.access === 'deny' && capability !== NEEDS_ACCESS ? 'access = deny' : `${capability} = deny`
      return {
        ok: false,
        text: `${input.toolName} refused for ${origin}: your site rules set ${rule}. Change it in DSH Settings → Plugins → browser-bridge → origins if this was not intended.`,
      }
    }

    const sessionId = typeof input.exec?.agent?.id === 'string' ? input.exec.agent.id : ''
    contextAttachments?.noteBrowserSession?.(sessionId)

    // Sensitivity is a second prompt even inside an allowed site, so a read
    // grant never silently becomes a spend grant.
    const sensitivity = effective.confirmSensitiveActions === false
      ? { sensitive: false }
      : classifySensitivity({ tool: input.toolName, args: input.args })

    const alreadyGranted = input.alwaysAsk === true ? undefined : grants.find(sessionId, origin, capability)
    if (alreadyGranted !== undefined && !sensitivity.sensitive) return { ok: true, origin }

    const reason = sensitivity.sensitive
      ? `${origin}: this action ${sensitivity.reason}, which is more than reading the page`
      : `the browser bridge wants to use ${origin}`
    const decision = await askApproval({
      toolName: input.toolName,
      origin,
      capability,
      reason,
      // The structural twin of the sentence above, so a surface can state the
      // consequence without parsing prose.
      sensitive: sensitivity.sensitive === true,
      // Which of the two affirmative buttons was pressed, read back from the
      // relay. Resolved as a function so the answer is read after the question
      // settles, not before it is asked.
      approvalScope: () => scopeOf(input.exec?.callId),
      exec: input.exec,
    })

    if (decision.outcome !== 'allowed') {
      const detail = decision.outcome === 'denied'
        ? 'you declined'
        : 'no approval answerer is available (the session may be unattended), and the harness fails closed'
      return { ok: false, text: `${input.toolName} did not run: ${detail}.` }
    }
    if (decision.record !== false && input.alwaysAsk !== true && sensitivity.sensitive !== true) {
      grants.record({ sessionId, origin, capabilities: [capability], lifetime: decision.lifetime, persistent: decision.choice === 'allow-for-site' })
    }
    return { ok: true, origin }
  }

  /**
   * Run one extension method with the configured budget.
   * @param {string} method - A {@link METHODS} member.
   * @param {unknown} params - Its parameters.
   * @param {object} [exec] - The tool execution.
   * @returns {Promise<unknown>} The extension's value.
   */
  const call = (method, params, exec) => {
    const connection = bridge.connection
    if (connection === undefined) {
      const error = new Error('no extension connection')
      error.code = BRIDGE_ERRORS.notConnected
      return Promise.reject(error)
    }
    return connection.call(method, params, {
      timeoutMs: Number(settings().actionTimeoutMs) + 15_000,
      signal: exec?.signal,
    })
  }

  /**
   * Require an integer tab id.
   * @param {Record<string, unknown>} args - The tool arguments.
   * @param {string} toolName - For the diagnostic.
   * @returns {{ tabId: number } | { text: string }} The id or a diagnostic.
   */
  const tabIdOf = (args, toolName) => {
    if (Number.isInteger(args.tab_id)) return { tabId: Number(args.tab_id) }
    return { text: `${toolName} needs an integer tab_id. Call browser_tabs or browser_open first.` }
  }

  const tools = []

  tools.push({
    name: 'browser_navigate',
    description: 'Navigate a tab to a URL, or go back, forward, or reload. Returns the resulting page identity.',
    parameters: {
      tab_id: { type: 'integer', required: true, description: 'The tab to navigate.' },
      url: { type: 'string', description: 'Absolute http(s) URL. Omit to use action instead.' },
      action: { type: 'string', description: 'One of back, forward, reload — used when url is omitted.' },
    },
    isConcurrencySafe: () => false,
    output: textOutput('navigated'),
    async execute(args, exec) {
      const hole = tabIdOf(args, 'browser_navigate')
      if ('text' in hole) return { text: hole.text }
      const check = await gate({ toolName: 'browser_navigate', args, exec })
      if (!check.ok) return { text: check.text }
      try {
        if (typeof args.url === 'string' && args.url.length > 0) {
          const info = await call(METHODS.pageNavigate, { tabId: hole.tabId, url: args.url }, exec)
          return { text: `Navigated tab [${hole.tabId}] to ${info?.url ?? args.url}${info?.title === undefined ? '' : ` — ${info.title}`}.`, meta: { page: info } }
        }
        const expression = args.action === 'back'
          ? 'history.back()'
          : args.action === 'forward' ? 'history.forward()' : 'location.reload()'
        await call(METHODS.pageEval, { tabId: hole.tabId, expression }, exec)
        const info = await call(METHODS.pageInfo, { tabId: hole.tabId }, exec)
        return { text: `Ran ${args.action ?? 'reload'} on tab [${hole.tabId}]; now at ${info?.url ?? ''}.`, meta: { page: info } }
      } catch (error) {
        return { text: failureText('browser_navigate', error, connectionStatus()), meta: { code: error?.code } }
      }
    },
  })

  tools.push({
    name: 'browser_snapshot',
    description:
      'The page as structured data: interactive elements with their role, accessible name, value, and bounds, each with an index you can pass to browser_click. Prefer this over browser_screenshot to decide what to act on — it is exact and cheap.',
    parameters: {
      tab_id: { type: 'integer', required: true, description: 'The tab to snapshot.' },
      interactive_only: { type: 'boolean', description: 'Restrict to elements that can be acted on (defaults to true).' },
    },
    isConcurrencySafe: () => true,
    output: textOutput('page snapshot'),
    async execute(args, exec) {
      const hole = tabIdOf(args, 'browser_snapshot')
      if ('text' in hole) return { text: hole.text }
      const check = await gate({ toolName: 'browser_snapshot', args, exec })
      if (!check.ok) return { text: check.text }
      try {
        const snapshot = await call(METHODS.pageSnapshot, {
          tabId: hole.tabId,
          interactiveOnly: args.interactive_only !== false,
          maxBytes: Number(settings().pageTextMaxBytes),
        }, exec)
        const header = [
          `Page: ${snapshot?.title ?? '(untitled)'}`,
          `URL: ${snapshot?.url ?? ''}`,
          // Both numbers when they differ: the page's real total, then how many
          // the list below actually names. A single count left the reader to
          // assume the list was complete, so an index past the wire cap looked
          // like one that should work.
          `${snapshot?.elementCount ?? 0} actionable element(s)${
            Number.isInteger(snapshot?.listedCount) && snapshot.listedCount < snapshot.elementCount
              ? `, ${snapshot.listedCount} listed below`
              : ''
          }${snapshot?.truncated === true ? ', truncated' : ''}`,
          '',
        ]
        return {
          text: `${header.join('\n')}${untrusted(String(snapshot?.text ?? ''), { url: snapshot?.url, title: snapshot?.title })}`,
          meta: { elements: snapshot?.elements ?? [] },
        }
      } catch (error) {
        return { text: failureText('browser_snapshot', error, connectionStatus()), meta: { code: error?.code } }
      }
    },
  })

  tools.push({
    name: 'browser_read',
    description:
      'Read the visible text of a page, with its links. Use it when you need what the page says, rather than what can be clicked.',
    parameters: {
      tab_id: { type: 'integer', required: true, description: 'The tab to read.' },
    },
    isConcurrencySafe: () => true,
    output: textOutput('page text'),
    async execute(args, exec) {
      const hole = tabIdOf(args, 'browser_read')
      if ('text' in hole) return { text: hole.text }
      const check = await gate({ toolName: 'browser_read', args, exec })
      if (!check.ok) return { text: check.text }
      try {
        const page = await call(METHODS.pageRead, { tabId: hole.tabId, maxBytes: Number(settings().pageTextMaxBytes) }, exec)
        // The extension caps `links` before this ever sees it, and this cap is
        // lower still. Either one silently drops links the page really has, and
        // a list that just stops looks like the page ran out of links — the
        // model then reports "there is no checkout link" about a page that has
        // one. Saying how many were left out costs a line and removes that.
        //
        // The total comes from the extension's `linkCount` where it is present,
        // because by then the array is already the capped one: counting it would
        // report 200 as the page's size when the page has 400.
        const all = Array.isArray(page?.links) ? page.links : []
        const total = Number.isInteger(page?.linkCount) ? page.linkCount : all.length
        const shown = all.slice(0, LINK_LIST_MAX)
        const linkLines = shown.length > 0
          ? [
              '',
              'Links:',
              ...shown.map((link) => `- ${link.text} → ${link.href}`),
              ...(total > shown.length ? [`… (showing ${shown.length} of ${total} links)`] : []),
            ]
          : []
        return {
          text: untrusted(`${page?.title ?? ''}\n\n${page?.text ?? ''}${linkLines.join('\n')}`, { url: page?.url, title: page?.title }),
          meta: { url: page?.url, truncated: page?.truncated, links: total },
        }
      } catch (error) {
        return { text: failureText('browser_read', error, connectionStatus()), meta: { code: error?.code } }
      }
    },
  })

  tools.push({
    name: 'browser_dialog',
    description:
      'Report and clear the JavaScript dialog (alert, confirm, prompt) blocking a tab. A dialog suspends everything else that tab could be asked to do, so when other browser tools stop responding, check this first. Calling it with only tab_id reports; adding accept answers it.',
    parameters: {
      tab_id: { type: 'integer', required: true, description: 'The tab to check.' },
      accept: {
        type: 'boolean',
        description: 'Answer the dialog. Omit to report it without answering. Dismissing is the default because the extension did not read a question the page asked you.',
      },
      prompt_text: {
        type: 'string',
        description: 'What to type into a prompt() when accepting one. Ignored for alert and confirm.',
      },
    },
    isConcurrencySafe: () => true,
    output: textOutput('dialog state'),
    async execute(args, exec) {
      const hole = tabIdOf(args, 'browser_dialog')
      if ('text' in hole) return { text: hole.text }
      // `gate` already asks for the second confirmation when the action is
      // classified sensitive, and `classifySensitivity` marks this tool that way
      // only when `accept` is set — so reporting a dialog is cheap and answering
      // one is a decision the person is asked about.
      const check = await gate({ toolName: 'browser_dialog', args, exec })
      if (!check.ok) return { text: check.text }

      const answering = args.accept === true || typeof args.prompt_text === 'string'
      try {
        // Read before clearing, so the report is true either way: reporting
        // "none" after answering would hide what was actually there.
        const before = await call(METHODS.pageDialogs, { tabId: hole.tabId }, exec)
        const dialog = before?.dialog ?? null
        if (answering) {
          await call(METHODS.pageDismissDialog, {
            tabId: hole.tabId,
            ...(typeof args.prompt_text === 'string' ? { promptText: args.prompt_text } : {}),
          }, exec)
        }
        if (dialog === null) {
          return { text: 'No JavaScript dialog is blocking this tab.', meta: { tabId: hole.tabId, dialog: null } }
        }
        const lines = [
          `${dialog.type ?? 'dialog'} is blocking this tab${answering ? ' and was just answered' : ''}:`,
          `  ${untrusted(String(dialog.message ?? ''), { url: before?.url })}`,
        ]
        if (answering) {
          lines.push('', 'Dismissing is the default, so the page took its "no" branch.')
        } else {
          lines.push('', 'Every other tool for this tab will time out until this is answered. Call browser_dialog again with accept: true to clear it.')
        }
        return { text: lines.join('\n'), meta: { tabId: hole.tabId, dialog, answered: answering } }
      } catch (error) {
        return { text: failureText('browser_dialog', error, connectionStatus()), meta: { code: error?.code } }
      }
    },
  })

  tools.push({
    name: 'browser_screenshot',
    description:
      'Capture the rendered page as an image. Use it to judge layout, styling, or anything visual; use browser_snapshot to decide what to click.',
    parameters: {
      tab_id: { type: 'integer', required: true, description: 'The tab to capture.' },
      format: { type: 'string', description: 'jpeg (default) or png.' },
    },
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          url: { type: 'string' },
          format: { type: 'string' },
          mediaType: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          bytes: { type: 'integer' },
          attachment: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => {
        const blocks = [{ type: 'text', text: `Screenshot of ${value?.url ?? 'the page'} (${value?.format ?? 'jpeg'}).` }]
        // A screenshot reaches the model as a durable attachment reference, never
        // as inline bytes. The harness defines `ImageBlock` as
        // `{ type: 'image', attachment: ImageAttachmentRef }`, and the DeepSeek
        // adapter's `collectImageRefs` reads `block.attachment.attachmentId`. An
        // image block carrying `data`/`mediaType` instead has no `attachment`, so
        // the first image-capable model to receive one dereferences `undefined`
        // rather than seeing the picture — the tool looked like it "returned no
        // image" while the bytes were in fact already in the durable value.
        if (value?.attachment !== undefined) blocks.push({ type: 'image', attachment: value.attachment })
        return blocks
      },
    },
    async execute(args, exec) {
      const hole = tabIdOf(args, 'browser_screenshot')
      if ('text' in hole) return { text: hole.text }
      const check = await gate({ toolName: 'browser_screenshot', args, exec })
      if (!check.ok) return { text: check.text }
      try {
        const shot = await call(METHODS.pageScreenshot, {
          tabId: hole.tabId,
          maxWidth: Number(settings().screenshotMaxWidth),
          format: args.format === 'png' ? 'png' : 'jpeg',
        }, exec)
        const encoded = typeof shot?.data === 'string' ? shot.data : ''
        if (encoded.length === 0) {
          return { text: 'the browser returned an empty screenshot for that tab', meta: { code: 'EMPTY_SCREENSHOT' } }
        }
        const mediaType = shot?.mediaType === 'image/png' ? 'image/png' : 'image/jpeg'
        const store = typeof attachmentStore === 'function' ? attachmentStore() : undefined
        if (store === undefined || typeof store.admitPromptContent !== 'function') {
          return {
            text: 'the screenshot was captured but the harness attachment service is unavailable, so its pixels cannot reach the model',
            meta: { code: 'ATTACHMENT_STORE_UNAVAILABLE' },
          }
        }
        const [admitted] = await store.admitPromptContent([
          { type: 'image', data: encoded, mediaType, name: `screenshot-${hole.tabId}` },
        ])
        const ref = admitted?.attachment
        if (ref === undefined) {
          return {
            text: 'the harness attachment service returned no reference for the screenshot',
            meta: { code: 'ATTACHMENT_REF_MISSING' },
          }
        }
        // Best effort only: the capture already succeeded, so a tab lookup that
        // fails must not turn a usable screenshot into an error. The label exists
        // to make the picture easy to talk about, not to gate it.
        const tab = await call(METHODS.tabsList, { includeAll: true }, exec)
          .then((rows) => (Array.isArray(rows) ? rows : []).find((row) => Number(row?.id ?? row?.tabId) === hole.tabId))
          .catch(() => undefined)
        return {
          url: typeof tab?.url === 'string' ? tab.url : undefined,
          format: shot?.format,
          mediaType,
          width: ref.width,
          height: ref.height,
          bytes: ref.bytes,
          attachment: ref,
          text: 'captured',
        }
      } catch (error) {
        return { text: failureText('browser_screenshot', error, connectionStatus()), meta: { code: error?.code } }
      }
    },
  })

  tools.push({
    name: 'browser_click',
    description:
      'Click an element, addressed either by the index from a recent browser_snapshot or by a CSS selector. Actions whose label looks consequential (submit, buy, delete) ask you a second time.',
    parameters: {
      tab_id: { type: 'integer', required: true, description: 'The tab.' },
      index: { type: 'integer', description: 'Element index from browser_snapshot.' },
      selector: { type: 'string', description: 'CSS selector, used when index is absent.' },
      text: { type: 'string', description: 'The visible label, for the confirmation prompt and audit trail.' },
      button: { type: 'string', description: 'left (default), right, or middle.' },
    },
    isConcurrencySafe: () => false,
    output: textOutput('clicked'),
    async execute(args, exec) {
      const hole = tabIdOf(args, 'browser_click')
      if ('text' in hole) return { text: hole.text }
      if (!Number.isInteger(args.index) && typeof args.selector !== 'string') {
        return { text: 'browser_click needs either an index from a snapshot or a CSS selector.' }
      }
      const check = await gate({ toolName: 'browser_click', args, exec })
      if (!check.ok) return { text: check.text }
      try {
        const result = await call(METHODS.pageClick, {
          tabId: hole.tabId,
          index: args.index,
          selector: args.selector,
          button: args.button,
          text: args.text,
        }, exec)
        const target = result?.clicked?.name ?? result?.clicked?.selector ?? `(${result?.x}, ${result?.y})`
        return { text: `Clicked ${target} in tab [${hole.tabId}]. Take a new snapshot to see what changed.`, meta: { result } }
      } catch (error) {
        return { text: failureText('browser_click', error, connectionStatus()), meta: { code: error?.code } }
      }
    },
  })

  tools.push({
    name: 'browser_type',
    description: 'Type text into an element or into the focused control. Optionally submit with Enter.',
    parameters: {
      tab_id: { type: 'integer', required: true, description: 'The tab.' },
      text: { type: 'string', required: true, description: 'The text to insert.' },
      selector: { type: 'string', description: 'Focus this element first.' },
      clear: { type: 'boolean', description: 'Clear the control before typing.' },
      submit: { type: 'boolean', description: 'Press Enter after typing.' },
    },
    isConcurrencySafe: () => false,
    output: textOutput('typed'),
    async execute(args, exec) {
      const hole = tabIdOf(args, 'browser_type')
      if ('text' in hole) return { text: hole.text }
      const text = typeof args.text === 'string' ? args.text : ''
      if (text.length === 0) return { text: 'browser_type needs non-empty text.' }
      const check = await gate({ toolName: 'browser_type', args, exec })
      if (!check.ok) return { text: check.text }
      try {
        await call(METHODS.pageType, {
          tabId: hole.tabId,
          text,
          selector: args.selector,
          clear: args.clear === true,
          submit: args.submit === true,
        }, exec)
        const where = typeof args.selector === 'string' ? ` into ${args.selector}` : ''
        return { text: `Typed ${text.length} character(s)${where} in tab [${hole.tabId}]${args.submit === true ? ' and pressed Enter' : ''}.`, meta: { typed: text.length } }
      } catch (error) {
        return { text: failureText('browser_type', error, connectionStatus()), meta: { code: error?.code } }
      }
    },
  })

  tools.push({
    name: 'browser_press',
    description: 'Press a key or a chord such as ctrl+a, in the focused element.',
    parameters: {
      tab_id: { type: 'integer', required: true, description: 'The tab.' },
      key: { type: 'string', required: true, description: 'Key name: Enter, Tab, Escape, ArrowDown, a single character…' },
      modifiers: { type: 'array', description: 'Any of ctrl, alt, shift, meta.' },
    },
    isConcurrencySafe: () => false,
    output: textOutput('pressed'),
    async execute(args, exec) {
      const hole = tabIdOf(args, 'browser_press')
      if ('text' in hole) return { text: hole.text }
      const check = await gate({ toolName: 'browser_press', args, exec })
      if (!check.ok) return { text: check.text }
      try {
        await call(METHODS.pagePress, { tabId: hole.tabId, key: args.key, modifiers: args.modifiers }, exec)
        const chord = [...(Array.isArray(args.modifiers) ? args.modifiers : []), args.key].join('+')
        return { text: `Pressed ${chord} in tab [${hole.tabId}].`, meta: { chord } }
      } catch (error) {
        return { text: failureText('browser_press', error, connectionStatus()), meta: { code: error?.code } }
      }
    },
  })

  tools.push({
    name: 'browser_scroll',
    description: 'Scroll the page, or bring an element into view.',
    parameters: {
      tab_id: { type: 'integer', required: true, description: 'The tab.' },
      delta_y: { type: 'number', description: 'Pixels down (negative scrolls up). Defaults to 600.' },
      selector: { type: 'string', description: 'Scroll this element into view instead.' },
    },
    isConcurrencySafe: () => true,
    output: textOutput('scrolled'),
    async execute(args, exec) {
      const hole = tabIdOf(args, 'browser_scroll')
      if ('text' in hole) return { text: hole.text }
      const check = await gate({ toolName: 'browser_scroll', args, exec })
      if (!check.ok) return { text: check.text }
      try {
        const result = await call(METHODS.pageScroll, { tabId: hole.tabId, deltaY: args.delta_y, selector: args.selector }, exec)
        return {
          text: typeof args.selector === 'string'
            ? `Scrolled ${args.selector} into view in tab [${hole.tabId}].`
            : `Scrolled tab [${hole.tabId}] by ${result?.deltaY ?? args.delta_y ?? 600}px.`,
          meta: { result },
        }
      } catch (error) {
        return { text: failureText('browser_scroll', error, connectionStatus()), meta: { code: error?.code } }
      }
    },
  })

  tools.push({
    name: 'browser_fill',
    description:
      'Set a form control\u2019s value directly, firing input and change. Prefer it over browser_type when a page ignores synthetic keystrokes.',
    parameters: {
      tab_id: { type: 'integer', required: true, description: 'The tab.' },
      selector: { type: 'string', required: true, description: 'The control to fill.' },
      value: { type: 'string', required: true, description: 'The value to set.' },
    },
    isConcurrencySafe: () => false,
    output: textOutput('filled'),
    async execute(args, exec) {
      const hole = tabIdOf(args, 'browser_fill')
      if ('text' in hole) return { text: hole.text }
      const check = await gate({ toolName: 'browser_fill', args, exec })
      if (!check.ok) return { text: check.text }
      try {
        await call(METHODS.pageFill, { tabId: hole.tabId, selector: args.selector, value: args.value }, exec)
        return { text: `Filled ${args.selector} in tab [${hole.tabId}].`, meta: { selector: args.selector } }
      } catch (error) {
        return { text: failureText('browser_fill', error, connectionStatus()), meta: { code: error?.code } }
      }
    },
  })

  tools.push({
    name: 'browser_wait_for',
    description: 'Wait until a selector appears or the page text contains a fragment. Use it after an action that loads content.',
    parameters: {
      tab_id: { type: 'integer', required: true, description: 'The tab.' },
      selector: { type: 'string', description: 'Wait for this selector.' },
      text: { type: 'string', description: 'Or wait for this text.' },
      timeout_ms: { type: 'integer', description: 'Give up after this long. Defaults to 15000.' },
    },
    isConcurrencySafe: () => true,
    output: textOutput('waited'),
    async execute(args, exec) {
      const hole = tabIdOf(args, 'browser_wait_for')
      if ('text' in hole) return { text: hole.text }
      const check = await gate({ toolName: 'browser_wait_for', args, exec })
      if (!check.ok) return { text: check.text }
      try {
        const result = await call(METHODS.pageWaitFor, {
          tabId: hole.tabId,
          selector: args.selector,
          text: args.text,
          timeoutMs: args.timeout_ms,
        }, exec)
        const what = typeof args.selector === 'string' ? args.selector : JSON.stringify(args.text)
        return result?.satisfied === true
          ? { text: `${what} appeared in tab [${hole.tabId}] after ${result.waitedMs}ms.`, meta: { result } }
          : { text: `${what} did not appear in tab [${hole.tabId}] within ${result?.timedOutMs ?? args.timeout_ms ?? 15_000}ms. The page may be slow, or waiting on something else.`, meta: { result } }
      } catch (error) {
        return { text: failureText('browser_wait_for', error, connectionStatus()), meta: { code: error?.code } }
      }
    },
  })

  tools.push({
    name: 'browser_console',
    description: 'Read console output and uncaught errors the page has produced since the tab was attached.',
    parameters: {
      tab_id: { type: 'integer', required: true, description: 'The tab.' },
      since_seq: { type: 'integer', description: 'Only entries after this sequence number, for incremental reads.' },
    },
    isConcurrencySafe: () => true,
    output: textOutput('console output'),
    async execute(args, exec) {
      const hole = tabIdOf(args, 'browser_console')
      if ('text' in hole) return { text: hole.text }
      const check = await gate({ toolName: 'browser_console', args, exec })
      if (!check.ok) return { text: check.text }
      try {
        const result = await call(METHODS.pageConsole, {
          tabId: hole.tabId,
          sinceSeq: args.since_seq,
          limit: Number(settings().consoleBufferSize),
        }, exec)
        const entries = Array.isArray(result?.entries) ? result.entries : []
        if (entries.length === 0) return { text: `No console entries in tab [${hole.tabId}].`, meta: { entries: [] } }
        const body = entries.map((entry) => `[${entry.seq}] ${entry.level}: ${entry.text}`).join('\n')
        return { text: untrusted(body, { url: `tab ${hole.tabId} console` }), meta: { entries } }
      } catch (error) {
        return { text: failureText('browser_console', error, connectionStatus()), meta: { code: error?.code } }
      }
    },
  })

  tools.push({
    name: 'browser_network',
    description: 'Read the network requests a page has made. Headers and bodies are not captured.',
    parameters: {
      tab_id: { type: 'integer', required: true, description: 'The tab.' },
      since_seq: { type: 'integer', description: 'Only entries after this sequence number.' },
    },
    isConcurrencySafe: () => true,
    output: textOutput('network activity'),
    async execute(args, exec) {
      const hole = tabIdOf(args, 'browser_network')
      if ('text' in hole) return { text: hole.text }
      const check = await gate({ toolName: 'browser_network', args, exec })
      if (!check.ok) return { text: check.text }
      try {
        const result = await call(METHODS.pageNetwork, {
          tabId: hole.tabId,
          sinceSeq: args.since_seq,
          limit: Number(settings().networkBufferSize),
        }, exec)
        const entries = Array.isArray(result?.entries) ? result.entries : []
        if (entries.length === 0) return { text: `No network activity recorded in tab [${hole.tabId}].`, meta: { entries: [] } }
        const body = entries
          .map((entry) => `[${entry.seq}] ${entry.method} ${entry.status ?? '…'} ${entry.url}${entry.failure === undefined ? '' : ` (${entry.failure})`}`)
          .join('\n')
        return { text: untrusted(body, { url: `tab ${hole.tabId} network` }), meta: { entries } }
      } catch (error) {
        return { text: failureText('browser_network', error, connectionStatus()), meta: { code: error?.code } }
      }
    },
  })

  tools.push({
    name: 'browser_upload',
    description:
      'Attach a file from this computer to a file input. Always asks for confirmation. Requires "Allow access to file URLs" on the extension.',
    parameters: {
      tab_id: { type: 'integer', required: true, description: 'The tab.' },
      selector: { type: 'string', required: true, description: 'The file input to fill.' },
      files: { type: 'array', required: true, description: 'Absolute paths of the files to attach.' },
    },
    isConcurrencySafe: () => false,
    output: textOutput('uploaded'),
    async execute(args, exec) {
      const hole = tabIdOf(args, 'browser_upload')
      if ('text' in hole) return { text: hole.text }
      const files = Array.isArray(args.files) ? args.files.filter((entry) => typeof entry === 'string') : []
      if (files.length === 0) return { text: 'browser_upload needs at least one absolute file path.' }
      const check = await gate({ toolName: 'browser_upload', args, exec, capability: NEEDS_UPLOADS })
      if (!check.ok) return { text: check.text }
      try {
        await call(METHODS.cdpSend, {
          tabId: hole.tabId,
          method: 'DOM.setFileInputFiles',
          params: { files, ...(await selectorNodeId(hole.tabId, args.selector, call, exec)) },
        }, exec)
        return { text: `Attached ${files.length} file(s) to ${args.selector} in tab [${hole.tabId}].`, meta: { files } }
      } catch (error) {
        return { text: failureText('browser_upload', error, connectionStatus()), meta: { code: error?.code } }
      }
    },
  })

  tools.push({
    name: 'browser_history',
    description:
      'Search this browser\u2019s history. Asks for permission every single time — there is no standing grant for history, by design.',
    parameters: {
      query: { type: 'string', description: 'Text to search for; empty lists recent visits.' },
      limit: { type: 'integer', description: 'Maximum entries, up to 100.' },
    },
    isConcurrencySafe: () => true,
    output: textOutput('history'),
    async execute(args, exec) {
      const effective = settings()
      if (effective.enabled === false) return { text: 'browser_history is switched off with the rest of the bridge.' }
      if (effective.allowHistoryAccess === false) {
        return { text: 'browser_history is disabled: "allowHistoryAccess" is off in DSH Settings → Plugins → browser-bridge.' }
      }
      // No `alwaysAsk` shortcut exists for this capability: history is read on
      // request and the answer is never remembered.
      const decision = await askApproval({
        toolName: 'browser_history',
        origin: 'browser history',
        capability: 'access',
        reason: 'reading your browsing history, which can include internal URLs and search terms',
        exec,
      })
      if (decision.outcome !== 'allowed') {
        return { text: 'browser_history did not run: reading history needs your approval each time, and it was not given.' }
      }
      try {
        const result = await call(METHODS.historySearch, { query: args.query, limit: args.limit }, exec)
        const entries = Array.isArray(result?.entries) ? result.entries : []
        if (entries.length === 0) return { text: 'No history entries matched.', meta: { entries: [] } }
        const body = entries
          .map((entry) => `- ${entry.title ?? '(no title)'}\n  ${entry.url}${entry.visitCount === undefined ? '' : ` (${entry.visitCount} visits)`}`)
          .join('\n')
        return { text: untrusted(body, { url: 'browser history' }), meta: { entries } }
      } catch (error) {
        return { text: failureText('browser_history', error, connectionStatus()), meta: { code: error?.code } }
      }
    },
  })

  tools.push({
    name: 'browser_eval',
    description:
      'Run JavaScript in the page and return its value. Needs Developer mode and asks every time. Use it for inspection the structured snapshot cannot express.',
    parameters: {
      tab_id: { type: 'integer', required: true, description: 'The tab.' },
      expression: { type: 'string', required: true, description: 'The expression to evaluate.' },
      await_promise: { type: 'boolean', description: 'Await the result when it is a promise.' },
    },
    isConcurrencySafe: () => false,
    output: textOutput('evaluation result'),
    async execute(args, exec) {
      const hole = tabIdOf(args, 'browser_eval')
      if ('text' in hole) return { text: hole.text }
      const check = await gate({ toolName: 'browser_eval', args, exec, requireDeveloperMode: true, alwaysAsk: true })
      if (!check.ok) return { text: check.text }
      try {
        const result = await call(METHODS.pageEval, {
          tabId: hole.tabId,
          expression: args.expression,
          awaitPromise: args.await_promise === true,
        }, exec)
        const rendered = result?.value === undefined
          ? String(result?.description ?? result?.type ?? '(no value)')
          : JSON.stringify(result.value)
        return { text: untrusted(rendered, { url: `tab ${hole.tabId}` }), meta: { result } }
      } catch (error) {
        return { text: failureText('browser_eval', error, connectionStatus()), meta: { code: error?.code } }
      }
    },
  })

  tools.push({
    name: 'browser_cdp',
    description:
      'Send a raw Chrome DevTools Protocol command. Needs Developer mode and asks every time. Browser, Target, Storage, and a few other domains are refused outright.',
    parameters: {
      tab_id: { type: 'integer', required: true, description: 'The tab.' },
      method: { type: 'string', required: true, description: 'A CDP method such as Performance.getMetrics.' },
      params: { type: 'object', additionalProperties: true, description: 'The CDP parameters.' },
    },
    isConcurrencySafe: () => false,
    output: textOutput('cdp result'),
    async execute(args, exec) {
      const hole = tabIdOf(args, 'browser_cdp')
      if ('text' in hole) return { text: hole.text }
      const check = await gate({
        toolName: 'browser_cdp',
        args,
        exec,
        capability: NEEDS_FULL_CDP,
        requireDeveloperMode: true,
        alwaysAsk: true,
      })
      if (!check.ok) return { text: check.text }
      try {
        const result = await call(METHODS.cdpSend, { tabId: hole.tabId, method: args.method, params: args.params }, exec)
        const body = JSON.stringify(result ?? null, null, 2)
        // The answer is page-derived content, even though it arrives through a
        // protocol call rather than through `browser_read`. `Network.getResponseBody`
        // returns whatever the server sent, `DOM.getOuterHTML` returns the page's
        // own markup, and both are strings an attacker controls end to end. Every
        // other tool that carries page text wraps it; this one is the most
        // capable tool in the set, so leaving it as the single unwrapped path
        // made the strongest channel the one with no boundary on it.
        //
        // Wrapped before the cap so the marker is never what gets cut — a
        // boundary that can be truncated away is not a boundary.
        const marked = untrusted(body, { url: `tab ${hole.tabId}`, title: `CDP ${args.method}` })
        // A cut-off JSON document is not a smaller answer, it is an unparseable
        // one: the text ends mid-token and the reader has no way to tell that
        // the rest exists. `DOMSnapshot.captureSnapshot` and
        // `Network.getResponseBody` cross this line on ordinary pages, so the
        // marker is the difference between "this is what the browser said" and
        // "this is the first 20000 characters of what the browser said".
        if (marked.length <= CDP_RESULT_MAX) return { text: marked, meta: { method: args.method } }
        return {
          text: `${marked.slice(0, CDP_RESULT_MAX)}\n\n… (result truncated: ${body.length} characters of CDP output, showing the first part. Narrow the call — a more specific domain, or a depth-limiting parameter — to see the rest.)`,
          meta: { method: args.method, truncated: true, fullLength: body.length },
        }
      } catch (error) {
        return { text: failureText('browser_cdp', error, connectionStatus()), meta: { code: error?.code } }
      }
    },
  })

  tools.push({
    name: 'browser_context',
    description:
      'See, remove, or clear the attachments you (or the user) have staged for the next message. Attachments are not visible to you until the user sends a message; use this to check what is queued.',
    parameters: {
      action: { type: 'string', description: 'list (default), remove, or clear.' },
      attachment_id: { type: 'string', description: 'Required for remove.' },
    },
    isConcurrencySafe: () => true,
    output: textOutput('attachments'),
    async execute(args, exec) {
      const sessionId = typeof exec?.agent?.id === 'string' ? exec.agent.id : ''
      const action = typeof args.action === 'string' ? args.action : 'list'
      if (action === 'clear') {
        const dropped = contextAttachments.clear(sessionId)
        return { text: `Cleared ${dropped} staged attachment(s).`, meta: { dropped } }
      }
      if (action === 'remove') {
        if (typeof args.attachment_id !== 'string') return { text: 'browser_context remove needs an attachment_id.' }
        const removed = contextAttachments.remove(sessionId, args.attachment_id)
        return { text: removed ? `Removed ${args.attachment_id}.` : `No staged attachment with id ${args.attachment_id}.`, meta: { removed } }
      }
      const pending = contextAttachments.list(sessionId)
      if (pending.length === 0) return { text: 'No attachments are staged for this session.', meta: { attachments: [] } }
      const body = pending
        .map((attachment) => `- [${attachment.id}] ${attachment.chars} chars — ${attachment.url}\n${attachment.text.slice(0, 400)}${attachment.text.length > 400 ? '…' : ''}`)
        .join('\n\n')
      return {
        text: `${pending.length} staged attachment(s). These reach you in the same request as the user's next message.\n\n${untrusted(body)}`,
        meta: { attachments: pending.map(({ text: _body, ...rest }) => rest) },
      }
    },
  })

  tools.push({
    name: 'browser_selection',
    description: 'Read the text the user currently has highlighted in the browser, if any.',
    parameters: {},
    isConcurrencySafe: () => true,
    output: textOutput('current selection'),
    async execute(_args, exec) {
      try {
        const result = await call(METHODS.tabsList, { includeAll: true }, exec)
        const tabs = Array.isArray(result) ? result : []
        const { tab: active, via } = activeTabOf(tabs)
        // A selection lives in a page, so this reports the active tab's page and
        // asks the caller to use browser_context for anything already staged.
        const headline =
          active === undefined
            ? 'No active tab.'
            : `Active tab: ${squashOneLine(active.title) || '(untitled)'} — ${squashOneLine(active.url)}`
        const lines = [headline, '', provenanceNote('the title and URL above')]
        // Only worth saying when it is a caveat. With several windows open, a
        // tab picked from row order may well be in a window the user is not
        // looking at, and a model that reads this as authoritative will answer
        // about the wrong page with full confidence.
        if (via === 'first-active' && tabs.filter((tab) => tab.active === true).length > 1) {
          lines.push(
            '',
            'Several windows are open and this extension could not tell which one you are looking at, so the tab above is simply the first active row. Confirm it with browser_tabs before relying on it.',
          )
        }
        lines.push('', 'Highlighted text is reported to DSH as a context chip; use browser_context to list what is staged.')
        return { text: lines.join('\n'), meta: { active, via } }
      } catch (error) {
        return { text: failureText('browser_selection', error, connectionStatus()), meta: { code: error?.code } }
      }
    },
  })

  return tools
}

/**
 * Pick the tab the user means by "the current page", and say how it was chosen.
 *
 * `tab.active` cannot answer this on its own. Chrome marks one tab active *per
 * window*, so with three windows open there are three active rows and taking the
 * first one reports a tab in a window the user is not looking at — while the
 * page they actually asked about sits in another window, unmentioned. The
 * extension resolves the ambiguity because only it can ask Chrome, and puts the
 * answer on each row as `windowFocused`.
 *
 * When nothing is marked focused the extension could not tell (an older build,
 * or a Chrome that refused `windows.getLastFocused`), and the old behaviour is
 * the only thing left. That fallback is reported as `via: 'first-active'` rather
 * than passed off as knowledge, so a caller can tell the two apart.
 *
 * @param {object[]} tabs - Tab rows from the extension.
 * @returns {{ tab: object | undefined, via: string }} The chosen row and the rule used.
 */
function activeTabOf(tabs) {
  const active = tabs.filter((tab) => tab.windowFocused === true && tab.active === true)
  // Exactly one window is focused, so more than one match means the extension
  // reported something contradictory; fall back rather than pick arbitrarily.
  if (active.length === 1) return { tab: active[0], via: 'focused-window' }
  const first = tabs.find((tab) => tab.active === true)
  return { tab: first, via: first === undefined ? 'none' : 'first-active' }
}

/**
 * Resolve a selector to a DOM node id, for CDP calls that need one.
 *
 * @param {number} tabId - The tab.
 * @param {string} selector - The CSS selector.
 * @param {(method: string, params: unknown, exec: object) => Promise<unknown>} call - The bridge caller.
 * @param {object} exec - The tool execution.
 * @returns {Promise<{ nodeId: number }>} The node id.
 * @throws {Error} When nothing matches.
 */
async function selectorNodeId(tabId, selector, call, exec) {
  const document = await call(METHODS.cdpSend, { tabId, method: 'DOM.getDocument', params: { depth: 0 } }, exec)
  const root = document?.root?.nodeId
  const found = await call(METHODS.cdpSend, { tabId, method: 'DOM.querySelector', params: { nodeId: root, selector } }, exec)
  if (!Number.isInteger(found?.nodeId) || found.nodeId === 0) {
    throw new Error(`no element matches the selector ${JSON.stringify(selector)}`)
  }
  return { nodeId: found.nodeId }
}
