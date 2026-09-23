/**
 * The browser bridge plugin: node half.
 *
 * Mounted as a host row in the web profile. It wires five layers together and
 * owns none of their logic:
 *
 *   - `bridge.js` — the socket and its request/response protocol;
 *   - `auth.js` / `token.js` — who may connect;
 *   - `policy.js` / `grants.js` — what may be done, and what was already allowed;
 *   - `tools.js` / `page-tools.js` — what the model can ask for;
 *   - `context.js` — what the user chose to hand over.
 *
 * The browser half of this package is a separate client bundle discovered from
 * `dsh.client`; it renders status and attachment chips and decides nothing.
 *
 * @module dsh-browser-bridge
 */

import { authorizeBridgeRequest, isLoopbackRequest } from './auth.js'
import { BridgeRegistry } from './bridge.js'
import {
  BRIDGE_CHAT_PATH,
  BRIDGE_CONTEXT_PATH,
  BRIDGE_HEALTH_PATH,
  BRIDGE_WS_PATH,
  policyLayers,
  resolveSettings,
} from './config.js'
import { ContextAttachments } from './context.js'
import { createChat } from './chat.js'
import { createApprovalRelay } from './approval.js'
import { loadPeer } from './deps.js'
import { GrantTable } from './grants.js'
import { createIngest } from './ingest.js'
import { buildPageTools } from './page-tools.js'
import { normalizeOrigin } from './policy.js'
import { registerSettings } from './settings.js'
import { createStreamRelay } from './stream.js'
import { buildTools } from './tools.js'
import { loadOrCreateToken } from './token.js'

/** Plugin name, as it appears in loader diagnostics. */
export const name = 'browser-bridge'

/** Tool registration needs the shared tool registry to exist first. */
export const inject = ['tools']

/**
 * Last known connection facts, for the status tool and the client panel.
 *
 * A tool that cannot connect should say *why* it cannot connect, which means
 * remembering how the last connection ended rather than only whether one
 * exists.
 */
class StatusTracker {
  /** @type {Record<string, unknown>} */
  #value = { connected: false, connections: 0 }

  /** Mark a connection as live. */
  onConnected() {
    // `lastError` is removed rather than set to `undefined`: a present-but-empty
    // key reads as "there is an error" to any consumer that checks for the key,
    // and a JSON round-trip would strip it anyway.
    const { lastError: _dropped, ...rest } = this.#value
    this.#value = {
      ...rest,
      connected: true,
      connectedAt: Date.now(),
      connections: Number(this.#value.connections ?? 0) + 1,
    }
  }

  /**
   * Mark the connection as gone.
   * @param {string} reason - Why it ended, for the diagnostic.
   */
  onDisconnected(reason) {
    this.#value = { ...this.#value, connected: false, lastSeenAt: Date.now(), lastError: reason }
  }

  /**
   * Record facts the extension reported about itself.
   * @param {Record<string, unknown>} info - Extension and Chrome identity.
   */
  onHello(info) {
    this.#value = { ...this.#value, hello: info }
  }

  /** @returns {Record<string, unknown>} A snapshot copy. */
  read() {
    return { ...this.#value }
  }
}

/**
 * Plugin body.
 *
 * @param {object} ctx - The host context. `ctx.tools` is guaranteed by
 *   {@link inject}. The settings, web-server, and approval services are
 *   optional and are therefore read with `ctx.get(...)`, never as `ctx.<name>`:
 *   an undeclared service read throws in Cordis, so a profile that mounts only
 *   some of them must degrade rather than fail to load.
 * @param {unknown} _config - Row config. This plugin is configured through its
 *   settings namespaces, so the row carries none.
 * @returns {Promise<void>} Resolves once routes and tools are registered.
 * @throws {Error} When the harness cannot supply a required peer, or when a
 *   stored settings section does not satisfy its schema.
 */
export async function apply(ctx, _config) {
  // Loaded one at a time, not with `Promise.all`. These three packages share
  // `cosmokit`, which publishes both an ESM and a CJS entry; importing the set
  // concurrently can make the CJS side `require()` the ESM side while it is
  // still being evaluated, and the loader then throws "Cannot require() ES
  // Module ... because it is not yet fully loaded". It is deterministic, not
  // rare: five fresh processes in a row failed on the concurrent form and five
  // succeeded on this one.
  //
  // The sequential form costs nothing measurable: 27-29ms across five cold-cache
  // runs, against 28-30ms for the concurrent form that fails. Module loading is
  // serialized inside the loader either way, so `Promise.all` was never buying
  // parallelism here — only the race.
  const schemasteryModule = await loadPeer('@deepseek-ai/schemastery')
  const toolsModule = await loadPeer('@deepseek-ai/dsh-tools')
  const llmModule = await loadPeer('@deepseek-ai/dsh-llm')
  const schemastery = schemasteryModule.default ?? schemasteryModule
  const { defineTool } = toolsModule
  const { createUserMessage, boundContextSummary } = llmModule

  /**
   * Settings access, wired inside the injection below.
   *
   * Declared as a mutable holder rather than assigned once: the registration
   * must happen on a context that already carries the `settings` service, and
   * until that injection fires these readers answer with the schema defaults.
   * @type {{ read: () => { user: Record<string, unknown>, managed: Record<string, unknown> }, registered: boolean, dispose: () => void }}
   */
  let settingsAccess = {
    read: () => ({ user: {}, managed: {} }),
    registered: false,
    dispose: () => {},
  }

  /**
   * Effective settings for this call, resolved fresh so a settings edit applies
   * without a reload.
   * @returns {Record<string, unknown>} The merged configuration.
   */
  const settings = () => {
    const { user, managed } = settingsAccess.read()
    return resolveSettings(user, managed)
  }

  /**
   * The policy layers derived from current settings.
   * @returns {{ origins: Record<string, object>, defaultOriginPolicy: object }} The layers.
   */
  const layers = () => {
    const { user, managed } = settingsAccess.read()
    return policyLayers(user, managed)
  }

  let token
  try {
    token = loadOrCreateToken()
  } catch (error) {
    throw new Error(
      `dsh-browser-bridge: could not read or create its token file: ${error.message}. `
      + 'Check that DSH_HOME is writable.',
    )
  }

  const bridge = new BridgeRegistry()
  const status = new StatusTracker()
  bridge.onChange(() => {
    if (bridge.connected) status.onConnected()
    else status.onDisconnected('the extension disconnected')
  })
  ctx.effect(() => () => {
    bridge.dispose()
  }, 'browser-bridge: extension connection')

  const grants = new GrantTable()
  ctx.effect(() => () => {
    grants.clear()
  }, 'browser-bridge: site grants')

  // The agent loop publishes every provider chunk as it arrives, one frame per
  // token. Relaying them is what turns the panel from "silence, then a finished
  // paragraph" into something that reads as typing; the committed transcript
  // stays the source of truth, so a dropped frame costs only animation.
  const stream = createStreamRelay({
    bridge,
    log: (message) => ctx.logger?.debug?.(`browser-bridge: ${message}`),
  })
  const detachStream = stream.attach(ctx)
  ctx.effect(() => () => {
    detachStream()
    stream.dispose()
  }, 'browser-bridge: assistant stream relay')

  // A turn started from the side panel can stop on an approval question, and
  // the harness's only shipped answerer renders that question in the graphical
  // client — a window the person is not looking at while they work in Chrome.
  // The relay asks the panel too, and lets whichever surface answers first win.
  //
  // Held in a ref because the tool ports are built below and need to read back
  // the scope of the answer; the relay itself needs the bridge, which is already
  // available here.
  /** @type {{ current?: import('./approval.js').ApprovalRelay }} */
  const approvalRelayRef = {}
  const approvalRelay = createApprovalRelay({
    bridge,
    log: (message) => ctx.logger?.debug?.(`browser-bridge: ${message}`),
  })
  approvalRelayRef.current = approvalRelay
  const detachApproval = approvalRelay.attach(ctx)
  ctx.effect(() => () => detachApproval(), 'browser-bridge: approval relay')

  const attachments = new ContextAttachments({
    settings,
    /**
     * Build the plugin-form message that carries one attachment into context.
     * @param {{ summary: string, text: string }} input - The attachment body.
     * @returns {unknown} A user-role message the agent can inject.
     */
    makeMessage: (input) => createUserMessage({
      content: [{ type: 'text', text: input.text }],
      source: {
        kind: 'plugin',
        plugin: 'browser-bridge',
        form: 'notice',
        summary: boundContextSummary(input.summary),
      },
    }),
  })

  // Live agents, so an attachment has somewhere to go the moment the user sends.
  ctx.on('agent/created', (payload) => {
    // Registration is also the last chance to deliver: a cold session reaches
    // this point before `turn/start`, which is earlier than the `session/event`
    // fallback can ever fire.
    attachments.adoptAgent(payload?.agent)
  })
  ctx.on('agent/disposed', (payload) => {
    attachments.forgetAgent(payload?.agent)
  })
  ctx.on('session/event', (session, event) => {
    try {
      attachments.observeSessionEvent(session, event)
    } catch (error) {
      ctx.logger?.warn?.(`browser-bridge: could not deliver context attachments: ${error.message}`)
    }
  })

  /**
   * Resolve a tab's origin through the extension.
   * @param {number} tabId - The tab.
   * @returns {Promise<string | undefined>} The normalized origin, when known.
   */
  const tabOrigin = async (tabId) => {
    const connection = bridge.connection
    if (connection === undefined) return undefined
    const info = await connection.call('page.info', { tabId }, { timeoutMs: 10_000 })
    if (typeof info?.url !== 'string' || info.url.length === 0) return undefined
    try {
      return normalizeOrigin(info.url)
    } catch {
      return undefined
    }
  }

  // The browser's own context gestures — right-click items and highlights —
  // arrive as events rather than calls, and are staged into the queue above.
  const ingest = createIngest({
    attachments,
    grants,
    bridge,
    settings,
    tabOrigin,
    log: (message) => ctx.logger?.debug?.(`browser-bridge: ${message}`),
  })

  const ports = {
    bridge,
    settings,
    connectionStatus: () => status.read(),
    grants,
    contextAttachments: attachments,
    // The harness attachment store, read **per call** for the same reason the
    // chat ports are: a screenshot only becomes a durable `ImageAttachmentRef`
    // if the tool can reach the store at the moment it runs, and a store captured
    // at activation would freeze `undefined` whenever it registers later.
    attachmentStore: () => ctx.get?.('attachments'),
    tabOrigin,
    policyLayers: layers,
    // The relay is built below this object, so it is reached by a late-bound
    // reference rather than captured. It carries back which of the two
    // affirmative buttons the person pressed, because the harness's
    // `approval.request()` resolves to an outcome and has no room for a duration.
    approvalScope: (callId) => approvalRelayRef.current?.scopeOf(callId),
  }

  // Settings, the tool surface, and the approval handle all wait for the
  // settings service.
  //
  // `ctx.inject` is the declaration, not `ctx.get`. The settings provider only
  // becomes injectable after its document loads, and this plugin's row can be
  // composed before that — probing with `ctx.get('settings')` therefore found
  // nothing at activation, so the namespace never registered and the Plugins
  // page showed no card while the websocket still worked. That combination is
  // what made a load-order bug look like a UI problem.
  //
  // `approval` is read from this context too: it is a root-plane service in the
  // base bundle, but reading an undeclared service throws, so it is taken from
  // the context that declares it rather than probed on the outer one.
  ctx.inject(['settings', 'approval'], (readyCtx) => {
    settingsAccess = registerSettings(readyCtx, schemastery)
    readyCtx.effect(() => settingsAccess.dispose, 'browser-bridge: settings namespaces')

    ports.approval = readyCtx.approval
    const definitions = [...buildTools(ports), ...buildPageTools(ports)]
    const disposers = []
    for (const definition of definitions) {
      disposers.push(readyCtx.tools.register(defineTool(definition)))
    }
    readyCtx.effect(() => () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose?.()
        } catch {
          // A tool that is already gone needs no second removal.
        }
      }
    }, 'browser-bridge: browser tools')
  })

  // The side panel's conversation surface.
  //
  // Read through `ctx.get` rather than injected, and **resolved per call**: the
  // browser tools must keep working in a profile that mounts no session
  // services, and the session controller registers later than this plugin
  // activates. Reading it once here captured `undefined` forever, which is why
  // the panel showed no transcript and refused every send while the services
  // were running the whole time. `chatServices` on the health route reports what
  // is actually reachable.
  const chat = createChat({
    // Only a liveness oracle now, never a listing source: `chat` asks it whether
    // a session is attached here so it knows whether a replay may be cached. The
    // old version also listed from the store and merged the result with a second
    // source, which is how the picker filled up with rows that were not sessions
    // a person could continue.
    sessions: () => ctx.get?.('sessions'),
    workspaces: () => ctx.get?.('workspaceRegistry'),
    // `prompt` is the controller's own Remote-exposed method — the same one the
    // web composer reaches — so a panel message travels that exact path, and
    // `create`/`list`/`inspect` are the controller's own readers, so the panel
    // sees the same sessions, in the same order, as the DSH sidebar.
    // `readSessionState` is not re-exported on the controller: it lives on the
    // command sub-object (`dsh-api-session-controller/lib/index.js:799`, `:899`)
    // and is kept only as the fallback reader for a harness without `inspect`.
    commands: () => {
      const controller = ctx.get?.('sessionController')
      if (controller === undefined) return undefined
      const bind = (target, name) => (
        typeof target?.[name] === 'function' ? target[name].bind(target) : undefined
      )
      return {
        prompt: bind(controller, 'prompt'),
        inspect: bind(controller, 'inspect'),
        list: bind(controller, 'list'),
        create: bind(controller, 'create'),
        // Both live on the controller itself, unlike `readSessionState`.
        modelCatalog: bind(controller, 'modelCatalog'),
        selectModel: bind(controller, 'selectModel'),
        // The only way to stop a turn. It cancels the active turn and keeps the
        // agent's pending inbox, which is what the panel's stop button means:
        // "stop what you are doing", not "forget what I already queued".
        cancel: bind(controller, 'cancel'),
        readSessionState: bind(controller.commands, 'readSessionState'),
      }
    },
  })
  ports.chat = chat

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer
    if (webServer === undefined) return

    /**
     * Whether the socket is bound to loopback only. A wider bind means the
     * routes are reachable from the network, so the peer check becomes load
     * bearing rather than defense in depth.
     * @returns {boolean} True when only this machine can reach the routes.
     */
    const loopbackOnly = () => webServer.host === undefined || webServer.host === '127.0.0.1'

    webCtx.effect(() => webServer.registerUpgrade({
      path: BRIDGE_WS_PATH,
      handler: (req, socket, head) => {
        const verdict = authorizeBridgeRequest(req, { token, requireLoopback: !loopbackOnly() })
        if (!verdict.ok) {
          // A failed handshake must be answered, not silently dropped: the
          // extension surfaces this text in its options page.
          socket.write(
            `HTTP/1.1 ${verdict.status} ${verdict.status === 401 ? 'Unauthorized' : 'Forbidden'}\r\n`
            + 'Connection: close\r\n'
            + 'Content-Type: text/plain; charset=utf-8\r\n\r\n'
            + `${verdict.reason}\n`,
          )
          socket.destroy()
          return
        }

        loadPeer('ws')
          .then((wsModule) => {
            // `ws` is CommonJS: everything lives on the default export, so a
            // named destructure of the module namespace silently yields
            // `undefined` and fails only when the first extension connects.
            const { WebSocketServer } = wsModule.default ?? wsModule
            const wss = new WebSocketServer({ noServer: true })
            wss.handleUpgrade(req, socket, head, (ws) => {
              const connection = bridge.adopt(ws)
              // The extension announces itself once; until then the panel shows a
              // plain connected state rather than waiting on a round trip.
              connection.on('bridge/hello', (payload) => {
                status.onHello(typeof payload === 'object' && payload !== null ? payload : {})
              })
              // The user's own "add this to context" clicks and highlights
              // arrive here as events, not calls: nothing is waiting on an
              // answer, so they are staged as they land.
              ingest.listenToExtension(connection)
              ws.on('bridge-protocol-error', (reason) => {
                webCtx.logger?.warn?.(`browser-bridge: malformed frame from the extension: ${reason}`)
              })
            })
          })
          .catch((error) => {
            webCtx.logger?.warn?.(`browser-bridge: could not accept the extension connection: ${error.message}`)
            socket.destroy()
          })
      },
    }), 'browser-bridge: extension upgrade route')

    webCtx.effect(() => webServer.register({
      kind: 'exact',
      path: BRIDGE_HEALTH_PATH,
      handler: (req, res) => {
        // Read-only and secret-free, so the client UI can poll it. The token is
        // deliberately absent: the bridge's own page is same-origin, but this
        // response is also reachable by any local process.
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify({
          enabled: settings().enabled !== false,
          connected: bridge.connected,
          pendingCalls: bridge.connection?.pendingCount ?? 0,
          status: status.read(),
          // Reported so a missing settings card is diagnosable from outside the
          // GUI: `false` here means the namespace never registered.
          settingsRegistered: settingsAccess.registered,
          // Services this plugin reads with `ctx.get` rather than `inject`. A
          // `false` here is the difference between "no sessions" and "the
          // service was not up yet when the plugin activated", which look
          // identical in the panel.
          chatServices: chat.services(),
          // Whether `browser_screenshot` can turn a capture into a durable image
          // reference. `false` means the tool still captures but can only send a
          // text label, because the harness attachment service is not reachable
          // from this profile — a state that otherwise looks exactly like "the
          // screenshot worked".
          attachmentService: typeof ctx.get?.('attachments')?.admitPromptContent === 'function',
          // Counters for the live-output relay. `frames: 0` while a turn is
          // running means the agent event never reached this plugin, which is a
          // different problem from `dropped` climbing, which just means no
          // extension was connected to receive it.
          stream: stream.stats(),
          // Counters for the approval relay. `delivered: 0` during a turn that
          // is visibly waiting means the question never reached this plugin;
          // `delivered` climbing while `byPanel` stays 0 means the panel is
          // being asked and nobody is answering.
          approval: approvalRelay.stats(),
          approvalPending: approvalRelay.pending(),
          contextDiagnostics: {
            agents: attachments.agentIds(),
            pending: attachments.pendingSessions(),
            diag: attachments.diagnostics(),
          },
          originRuleCount: Object.keys(layers().origins ?? {}).length,
          // No `tokenHint` here. This route is the one surface that answers
          // without a token and without a loopback check, because the client UI
          // and the extension both poll it before they can authenticate. The
          // first eight characters of the token used to be echoed back from it,
          // which is a credential fragment on the one route chosen to have no
          // authentication at all — and nothing read it. `tokenLength` stays:
          // it is a shape, not a secret, and the extension's options page
          // documents it as the length check it performs locally.
          tokenLength: token.length,
        }))
      },
    }), 'browser-bridge: health route')

    /**
     * Answer one chat request for the side panel.
     *
     * These carry the panel's conversation rather than a browser action, so they
     * are served here instead of being forwarded to the extension: the panel
     * then needs exactly one authenticated origin, and the browser half stays a
     * pure executor.
     *
     * Loopback-only for every method, including the reads. The panel runs on this
     * machine, so a wider bind is no reason to expose the user's transcripts to
     * the network.
     *
     * @param {import('node:http').IncomingMessage} req - The request.
     * @param {import('node:http').ServerResponse} res - The response.
     * @returns {Promise<void>} Resolves once the response is written.
     */
    const serveChatRoute = async (req, res) => {
      /**
       * Write one JSON answer.
       * @param {number} status - The HTTP status.
       * @param {unknown} payload - The body.
       */
      const json = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(payload))
      }

      if (!isLoopbackRequest(req)) {
        json(403, { error: 'the bridge chat surface is reachable only from this machine' })
        return
      }

      if (req.method === 'GET') {
        // Already grouped by workspace, in the registry's own order, because the
        // panel and the DSH sidebar must not disagree about what exists.
        const { groups } = await chat.listSessions()
        json(200, { groups })
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'GET, POST', 'content-type': 'text/plain; charset=utf-8' })
        res.end('method not allowed\n')
        return
      }

      let body = ''
      for await (const chunk of req) {
        body += chunk
        // A panel message is text; anything larger is not one.
        if (body.length > 100_000) {
          json(413, { error: 'the message is too large' })
          return
        }
      }

      /** @type {Record<string, unknown>} */
      let parsed
      try {
        parsed = JSON.parse(body.length > 0 ? body : '{}')
      } catch {
        json(400, { error: 'the request body is not JSON' })
        return
      }

      if (parsed.action === 'messages') {
        const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
        // One reader for both cases: the controller answers from memory for a
        // live session and from the log for a cold one, so there is no second
        // code path to drift.
        const { messages, title, more } = await chat.readMessages(sessionId, parsed.limit, parsed.before)
        json(200, { sessionId, messages, title, more })
        return
      }
      if (parsed.action === 'create') {
        // The workspace is named by the caller, so a new session lands beside
        // the one the panel is showing rather than wherever the default is.
        const result = await chat.createSession({ workspaceId: parsed.workspaceId })
        json(200, result)
        return
      }
      if (parsed.action === 'models') {
        // The catalog is deployment-wide; the session only decides which entry
        // is marked as chosen, and that travels with the listing instead.
        json(200, await chat.readModels())
        return
      }
      if (parsed.action === 'select-model') {
        const result = await chat.selectModel({
          sessionId: parsed.sessionId,
          provider: parsed.provider,
          model: parsed.model,
          reasoningEffort: parsed.reasoningEffort,
        })
        json(result.selected === false ? 409 : 200, result)
        return
      }
      if (parsed.action === 'cancel') {
        const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
        const result = await chat.cancel(sessionId)
        // A refusal is the normal outcome for a session that is not running
        // here, so it is a 409 with the harness's own wording rather than a 500.
        json(result.cancelled ? 200 : 409, result)
        return
      }
      if (parsed.action === 'approval') {
        // The panel answering a question it was asked, on the way back. The
        // bridge socket carries requests one way only, so the reply rides the
        // panel's own HTTP route.
        const result = approvalRelay.answer(parsed.id, parsed.outcome, parsed.scope)
        // A refusal is ordinary — the question was answered in the graphical
        // client first, or the turn was cancelled — so it is a 409 carrying the
        // reason rather than a 500.
        json(result.answered ? 200 : 409, result)
        return
      }
      if (parsed.action === 'send') {
        const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
        const text = typeof parsed.text === 'string' ? parsed.text : ''
        // Staged first, in the same request as the prompt it belongs to, then
        // delivered *before* the prompt so the notice is in the agent's inbox
        // for the first step rather than the one after it.
        const context = ingest.stageRequested(parsed.attachments, sessionId)
        attachments.deliverBeforePrompt(sessionId)
        const result = await chat.send(sessionId, text, undefined)
        json(result.accepted ? 200 : 409, { ...result, context })
        return
      }
      json(400, { error: `unknown action ${JSON.stringify(parsed.action)}` })
    }

    webCtx.effect(() => webServer.register({
      kind: 'exact',
      path: BRIDGE_CHAT_PATH,
      handler: (req, res) => {
        serveChatRoute(req, res).catch((error) => {
          try {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: error.message }))
          } catch {
            // The response is already out; nothing further can be reported.
          }
        })
      },
    }), 'browser-bridge: chat route')

    webCtx.effect(() => webServer.register({
      kind: 'exact',
      path: BRIDGE_CONTEXT_PATH,
      handler: (req, res) => {
        // Read-only view of what the composer chips show, plus the one removal
        // the chip needs. The token never appears here, and nothing here can
        // *create* an attachment: staging is the user's action through the
        // extension, so this route cannot be used to feed the model.
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const sessionId = url.searchParams.get('sessionId') ?? ''

        if (req.method === 'DELETE') {
          const attachmentId = url.searchParams.get('attachmentId') ?? ''
          // Loopback-only unconditionally: the composer is on this machine by
          // definition, so a wider bind is no reason to accept the request.
          if (!isLoopbackRequest(req)) {
            res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('removing an attachment is allowed only from this machine\n')
            return
          }
          const removed = sessionId.length > 0
            && attachmentId.length > 0
            && attachments.remove(sessionId, attachmentId)
          res.writeHead(removed ? 200 : 404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ removed }))
          return
        }

        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD, DELETE', 'content-type': 'text/plain; charset=utf-8' })
          res.end('method not allowed\n')
          return
        }

        const pending = sessionId.length > 0 ? attachments.list(sessionId) : []
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify({
          sessionId,
          attachments: pending.map(({ text, ...rest }) => ({ ...rest, preview: text.slice(0, 200) })),
        }))
      },
    }), 'browser-bridge: context route')

    webCtx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/browser-bridge/token',
      handler: (req, res) => {
        // The one route that returns the token, so a person can copy it into the
        // extension. Loopback-only unconditionally, even when the harness binds
        // wider: the browser GUI is on this machine by definition.
        if (!isLoopbackRequest(req)) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('the bridge token is readable only from this machine\n')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ token, hint: 'paste this into the DSH Browser Bridge extension options' }))
      },
    }), 'browser-bridge: token route')
  })
}

export { isLoopbackRequest }
