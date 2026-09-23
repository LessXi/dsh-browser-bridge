/**
 * Render the DSH side panel in a real Chrome and screenshot it.
 *
 * Why this exists: the panel is the product's whole visible surface, and every
 * defect this project has shipped in the UI was found by *looking at it* — the
 * right-click menu stayed English for thirty rounds because Chrome paints it
 * outside any panel screenshot. A DOM shim cannot find those: it has no CSS, no
 * layout, no fonts, and no scrollbars. This drives the real `sidepanel.html`
 * (same file the extension loads) in headless Chrome, against a fake host that
 * answers the panel's own HTTP protocol, and writes PNGs.
 *
 * Usage:
 *   node tools\preview.mjs <scenario> <out.png> [--width 380] [--height 720]
 *   node tools\preview.mjs <scenario> <out.png> --audit
 *   node tools\preview.mjs <scenario> <out.png> --probe <file.js>
 *   node tools\preview.mjs <scenario> <out.png> --scheme light
 *   node tools\preview.mjs <scenario> <out.png> --locale zh-CN
 *   node tools\preview.mjs <scenario> <out.png> --keys "Tab,PageDown"
 *   node tools\preview.mjs <scenario> <out.png> --ax-tree "#transcript"
 *   node tools\preview.mjs --list
 *
 * `tools/gallery.mjs` drives this to regenerate `docs/screenshots/`, which is
 * the set the README shows. This file is checked in for the same reason those
 * images are: every UI defect this project has shipped was found by looking at a
 * rendered panel, and a tool that exists on one machine only means the next
 * person has to rebuild it before they can look.
 *
 * `--probe` evaluates any file in the page and prints what it returns, which is
 * how a question about the panel gets answered by measurement instead of by
 * reading the stylesheet and guessing.
 *
 * `--scheme light|dark` picks which side of `color-scheme: light dark` the panel
 * renders. Chrome's default is light, but the panel's `Canvas`/`CanvasText`
 * resolve against whatever is emulated, and the two modes have genuinely
 * different contrast — a palette that passes in one can fail in the other, so
 * both are worth rendering deliberately.
 *
 * Scenarios are named states the panel can be in. Each one is a fixture the
 * panel has no way to reach on its own, which is exactly why they are worth
 * rendering: `firstRun` (extension installed, host never started) was invisible
 * for thirty-three rounds.
 *
 * @module dsh-browser-bridge/tools/preview
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { findRows } from '../packages/dsh-browser-bridge/lib/chat.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const EXTENSION = join(REPO, 'extension')

/** The in-page measurement script, kept in its own file so it can be read. */
const AUDIT_SOURCE = readFileSync(join(HERE, 'audit-in-page.js'), 'utf8')

/**
 * Where Chrome lives, in the order worth trying.
 *
 * The same list the e2e suite carries, and for the same reason: this tool is
 * checked in, so it has to run on someone else's machine. It was Windows-only
 * when it lived in a scratch directory that only this checkout had.
 */
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

/**
 * Everything this script prints, buffered until the end.
 *
 * `process.stdout` to a pipe is asynchronous: a forced exit truncates a large
 * pending write, and the audit JSON is a few KB — that is how one run in three
 * came back with no output. Waiting for the drain instead lets the loop live on
 * for ~20s, because the CDP websocket's handle outlives its own close
 * handshake. Writing the whole report synchronously with `writeSync` satisfies
 * both: nothing is dropped, and the process ends the moment the work does.
 */
const OUTPUT = []
const emit = (text) => { OUTPUT.push(text) }
let flushed = false
/**
 * Write the buffered report, resolving once the bytes have been handed off.
 *
 * Not `writeSync`: fd 1 is a pipe when `audit-all.mjs` runs several previews at
 * once, Node puts that pipe in non-blocking mode, and a sync write of a few KB
 * into a full pipe fails with EAGAIN — which is exactly how a scenario that
 * audits cleanly on its own came back with no output under concurrency. The
 * async form queues the whole buffer and calls back once it is out.
 *
 * @returns {Promise<void>} Resolves after the write completes.
 */
function flush() {
  if (flushed) return Promise.resolve()
  flushed = true
  if (OUTPUT.length === 0) return Promise.resolve()
  return new Promise((done) => process.stdout.write(OUTPUT.join(''), done))
}

/**
 * A CDP client, copied in spirit from the e2e suite: browser websocket, one
 * pending map, events with deadlines so a missing event is a named failure
 * instead of a hang.
 */
class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url)
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    this.ready = new Promise((ok, no) => {
      this.socket.addEventListener('open', () => ok())
      this.socket.addEventListener('error', () => no(new Error('CDP socket failed')))
    })
    this.socket.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data))
      if (frame.id !== undefined) {
        const entry = this.pending.get(frame.id)
        if (entry === undefined) return
        this.pending.delete(frame.id)
        if (frame.error !== undefined) entry.reject(new Error(`${frame.error.message} (${frame.error.code})`))
        else entry.resolve(frame.result)
        return
      }
      for (const fn of this.listeners.get(frame.method) ?? []) fn(frame.params)
    })
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, [])
    this.listeners.get(method).push(fn)
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId
    this.nextId += 1
    const promise = new Promise((ok, no) => {
      this.pending.set(id, { resolve: ok, reject: no })
      setTimeout(() => {
        if (this.pending.delete(id)) no(new Error(`CDP ${method} timed out`))
        // Generous on purpose. `audit-all.mjs` runs several of these at once and
        // each one is a whole Chrome, so a screenshot that takes 200ms alone can
        // take seconds while four of them encode PNGs at the same time. A tight
        // deadline here turned CPU contention into a phantom product failure.
      }, 60_000)
    })
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
    return promise
  }

  close() {
    try { this.socket.close() } catch { /* already gone */ }
  }
}

/** Poll a debugging port via node:http (fetch's keep-alive pool would leak a socket and hang the process). */
function probeVersion(port) {
  return new Promise((done) => {
    import('node:http').then(({ get }) => {
      const request = get(
        { host: '127.0.0.1', port, path: '/json/version', agent: false, timeout: 2_000 },
        (response) => {
          let body = ''
          response.setEncoding('utf8')
          response.on('data', (chunk) => { body += chunk })
          response.on('end', () => {
            try { done(JSON.parse(body)) } catch { done(undefined) }
          })
        },
      )
      request.on('error', () => done(undefined))
      request.on('timeout', () => { request.destroy(); done(undefined) })
    })
  })
}

/**
 * The fake host.
 *
 * The panel talks to the harness over same-origin HTTP on the configured port.
 * Reimplementing those five responses is what makes every panel state reachable
 * without a live DSH, and it is the reason a screenshot can be taken at all.
 */
function makeHost(scenario, state) {
  return createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      const send = (status, payload) => {
        response.writeHead(status, {
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'content-type',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
        })
        response.end(JSON.stringify(payload))
      }
      if (request.method === 'OPTIONS') return send(204, {})

      if (scenario.hostDown === true) {
        // Nothing listens: the panel's own fetch fails, which is the point.
        response.destroy()
        return
      }

      if (url.pathname === '/browser-bridge/health') {
        return send(200, {
          connected: scenario.bridgeConnected !== false,
          chrome: scenario.chromeVersion ?? '141.0.7390.65',
          controlledTabs: scenario.controlledTabs ?? 1,
          ...(scenario.healthExtra ?? {}),
        })
      }

      if (url.pathname === '/browser-bridge/chat') {
        if (request.method === 'GET') {
          // `running: true` on the open session is what makes the panel draw the
          // `.working` row. Marking session-b instead would do nothing: the row
          // is only wanted for the session that is on screen, and session-a is
          // the one the panel opens.
          const groups = scenario.groups ?? (scenario.running === true
            ? DEFAULT_GROUPS.map((group) => ({
              ...group,
              sessions: group.sessions.map((session) =>
                session.id === 'session-a' ? { ...session, running: true } : session),
            }))
            : DEFAULT_GROUPS)
          return send(200, { groups: [...groups, ...state.created] })
        }
        const parsed = body.length > 0 ? JSON.parse(body) : {}
        state.requests.push({ url: url.pathname, body: parsed })
        if (parsed.action === 'models') {
          if (scenario.catalogReason !== undefined) {
            return send(200, { catalog: null, reason: scenario.catalogReason })
          }
          return send(200, { catalog: scenario.catalog ?? DEFAULT_CATALOG })
        }
        if (parsed.action === 'messages') {
          const rows = scenario.messages ?? DEFAULT_MESSAGES
          // Sliced exactly the way the host slices, from the end and by an
          // absolute index. The mock used to answer every request with the whole
          // fixture, so a scenario with 470 rows drew 470 rows and the panel's
          // window — the thing `loadEarlier`, `depth` and a search jump are all
          // about — was invisible to every screenshot and probe. An instrument
          // that cannot show the state cannot check it.
          const limit = Number.isInteger(parsed.limit) && parsed.limit > 0 ? parsed.limit : 40
          const stop = Number.isInteger(parsed.end) && parsed.end >= 0
            ? Math.min(parsed.end, rows.length)
            : rows.length
          const start = Math.max(0, stop - limit)
          return send(200, {
            messages: rows.slice(start, stop),
            // `scenario.more` still wins where a scenario means to pin the pill
            // on regardless of the window: it is a state fixture, not a claim
            // about arithmetic.
            more: scenario.more ?? start > 0,
            total: rows.length,
          })
        }
        if (parsed.action === 'search') {
          const rows = scenario.messages ?? DEFAULT_MESSAGES
          // The real matcher, imported rather than re-implemented: the mock
          // stands in for the host, and a second copy of the matching rule is
          // the copy that drifts from the one under test.
          const matches = findRows(rows, typeof parsed.query === 'string' ? parsed.query : [])
          return send(200, { matches, total: rows.length, truncated: matches.length >= 30 })
        }
        if (parsed.action === 'send') return send(200, { accepted: true })
        if (parsed.action === 'cancel') return send(200, { cancelled: true })
        if (parsed.action === 'create') {
          // A created session joins the list, which is what a real host does and
          // what lets the panel leave its empty state. A fixture that kept
          // answering with an empty listing made the button look inert.
          state.created.push({
            id: 'session-new',
            title: '',
            sessions: [{ id: 'session-new', title: '新会话', updatedAt: Date.now(), running: false, blank: true, model: null }],
          })
          return send(200, { created: true, sessionId: 'session-new' })
        }
        if (parsed.action === 'select-model') return send(200, { selected: true })
        return send(200, {})
      }

      send(404, { error: 'not found' })
    })
  })
}

const DEFAULT_GROUPS = [
  {
    id: 'ws-1',
    title: 'dsh-bridge',
    sessions: [
      {
        id: 'session-a',
        title: '打造类似codex的dsh网页插件',
        updatedAt: Date.now() - 90_000,
        running: false,
        blank: false,
        model: { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
      },
      {
        id: 'session-b',
        title: 'Fix the snapshot pipeline',
        updatedAt: Date.now() - 8 * 60_000,
        running: true,
        blank: false,
        model: { provider: 'deepseek', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' },
      },
      {
        id: 'session-c',
        title: 'Untitled thread',
        updatedAt: 0,
        running: false,
        blank: true,
        model: null,
      },
    ],
  },
]

const DEFAULT_CATALOG = {
  groups: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      models: [
        {
          id: 'deepseek-v4-pro',
          name: 'deepseek-v4-pro',
          reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
        },
        {
          id: 'deepseek-v4.1-flash',
          name: 'deepseek-v4.1-flash',
          reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
        },
      ],
    },
  ],
  default: { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
}

const DEFAULT_MESSAGES = [
  { kind: 'user', text: '帮我看看这个页面为什么点不动保存按钮' },
  {
    kind: 'assistant',
    text: '按钮被一个透明的遮罩层挡住了。快照里它的 bounds 是 `0,0,1280,800`，而真正的按钮在 `1180,742,96,32`。\n\n用 `browser_click` 指定选择器 `#save` 可以直接命中：\n\n```json\n{ "selector": "#save" }\n```\n\n要我改完再截一张图确认吗？',
  },
  // `status` is `ok` or `error` — the panel's own palette keys off exactly
  // those two, and a fixture that invents a third value renders the neutral
  // mark for every row, so the success and failure colours never appear in any
  // screenshot and never get audited.
  { kind: 'tool', callId: 'c1', name: 'browser_snapshot', summary: 'github.com/lessxi/dsh-browser-bridge', status: 'ok' },
  { kind: 'reasoning', text: '先看快照里哪个元素覆盖在按钮上方，再判断是不是 pointer-events 的问题。' },
]

/**
 * A short conversation around one failed tool call that carries a reason.
 *
 * Kept apart from `DEFAULT_MESSAGES` so the failure is on screen without a long
 * transcript above it: the row is what is being judged, and a fixture that buries
 * it below the fold renders a screenshot of something else.
 */
const TOOL_FAILURE_MESSAGES = [
  { kind: 'user', text: '帮我把保存按钮点一下' },
  { kind: 'tool', callId: 'c1', name: 'browser_snapshot', summary: 'example.com/settings', status: 'ok' },
  {
    kind: 'tool',
    callId: 'c2',
    name: 'browser_click',
    summary: '#save',
    status: 'error',
    failure: 'no element matches #save — the button is inside a shadow root, so querySelector cannot reach it',
  },
  { kind: 'tool', callId: 'c3', name: 'browser_eval', summary: 'querySelector("#save")', status: 'ok' },
]

/**
 * A conversation long enough that the window is a real question.
 *
 * `more: true` is what makes the "earlier content" pill appear; without rows to
 * fill the screen above it the pill would float over nothing.
 */
const LONG_MESSAGES = [  { kind: 'user', text: '先看一下这个仓库的结构' },
  { kind: 'assistant', text: '分三层：`extension/` 是 MV3 扩展，`packages/dsh-browser-bridge/` 是宿主插件，根上是 workspace 配置。' },
  { kind: 'tool', callId: 'c1', name: 'browser_snapshot', summary: 'github.com/lessxi/dsh-browser-bridge', status: 'ok' },
  { kind: 'user', text: '那宿主插件都暴露了哪些工具？' },
  { kind: 'assistant', text: '一共 21 个 `browser_*` 工具，按能力位分成 access、downloads、uploads、full_cdp_access 四组。' },
  { kind: 'reasoning', text: '先把工具表列全，再按能力位分组说明。' },
  { kind: 'user', text: '点不动保存按钮，帮我看看' },
  { kind: 'assistant', text: '按钮被一个透明的遮罩层挡住了。用 `browser_click` 指定选择器 `#save` 可以直接命中。' },
  { kind: 'tool', callId: 'c2', name: 'browser_click', summary: '#save', status: 'ok' },
  // One failed call, so the error colour is rendered and therefore measured.
  // It carries a reason, which is what the row opens to show: a fixture without
  // one cannot tell an expandable row from a plain one.
  {
    kind: 'tool',
    callId: 'c3',
    name: 'browser_eval',
    summary: 'SyntaxError: Unexpected token',
    status: 'error',
    failure: 'browser_eval failed: SyntaxError: Unexpected token } in JSON at position 24',
  },
  { kind: 'user', text: '很好，顺便看看控制台有没有报错' },
  { kind: 'assistant', text: '控制台有一条未捕获异常：`TypeError: Cannot read properties of null`，来自 `app.js:214`。' },
  { kind: 'user', text: '这个页面为什么点不动保存按钮' },
  {
    kind: 'assistant',
    text: '按钮被一个透明的遮罩层挡住了。快照里它的 bounds 是 `0,0,1280,800`，而真正的按钮在 `1180,742,96,32`。\n\n用 `browser_click` 指定选择器 `#save` 可以直接命中：\n\n```json\n{ "selector": "#save" }\n```\n\n要我改完再截一张图确认吗？',
  },
]

/**
 * A conversation the length of a few days of real use.
 *
 * Built rather than written out, because the point is the *length*: the panel
 * rebuilds the entire transcript whenever the rows change, so whether that is a
 * problem depends on how many rows a person actually accumulates. The mix is
 * deliberate — every fourth turn carries a tool row and every tenth a reasoning
 * row, because those cost the most nodes, and a fixture of bare question/answer
 * pairs would understate the cost.
 *
 * @param {number} turns - Question/answer pairs.
 * @returns {object[]} Rows in the shape the host sends.
 */
function dayMessages(turns) {
  const messages = []
  for (let index = 0; index < turns; index += 1) {
    messages.push({ kind: 'user', text: `第 ${index + 1} 个问题：这个页面上的保存按钮为什么点不动？` })
    if (index % 10 === 9) {
      messages.push({ kind: 'reasoning', text: `先看快照里哪个元素覆盖在按钮上方，再按 bounds 判断是不是遮罩层。这是第 ${index + 1} 次。` })
    }
    messages.push({
      kind: 'assistant',
      text: `按钮被一个透明的遮罩层挡住了。快照里它的 bounds 是 \`0,0,1280,800\`，而真正的按钮在 \`1180,742,96,32\`。\n\n用 \`browser_click\` 指定选择器 \`#save\` 可以直接命中。这是第 ${index + 1} 个回答。`,
    })
    if (index % 4 === 3) {
      messages.push({
        kind: 'tool',
        callId: `day-c${index}`,
        name: 'browser_snapshot',
        summary: `github.com/lessxi/dsh-browser-bridge (${index + 1})`,
        status: index % 12 === 11 ? 'error' : 'ok',
      })
    }
  }
  return messages
}

/** Two hundred turns: a few days of real use, and long enough to show a trend. */
const DAY_MESSAGES = dayMessages(200)

/**
 * A long conversation with a word buried near the start of it.
 *
 * The point of searching is the part that is *not* on screen: the panel opens on
 * the newest sixty rows, so a needle in the first rows of a three-hundred-row
 * session is the case a search-from-the-window implementation gets wrong — it
 * reports the word as absent. `zebra` appears exactly three times and nowhere
 * else in the fixture.
 *
 * @returns {object[]} Rows with the needle placed early, middle and late.
 */
function searchableMessages() {
  const rows = []
  for (let index = 0; index < 300; index += 1) {
    const buried = index === 4 ? ' 关于 zebra 的第一个结论。' : ''
    const later = index === 150 ? ' zebra 又出现了一次。' : ''
    rows.push({ kind: 'user', text: `第 ${index + 1} 个问题${buried}${later}` })
    rows.push({ kind: 'assistant', text: `这是第 ${index + 1} 个回答，正文足够长以便占满一行的高度。` })
    // One reasoning row, and it carries the needle. A reasoning row is not a
    // `.row` — `renderRow` gives it `className = 'reasoning'` — so the first
    // version of the hit outline (`#transcript .row.hit`) could never match one,
    // and a search that landed here drew no highlight at all. The fixture held
    // only user and assistant rows, which is why nothing caught it.
    if (index === 60) rows.push({ kind: 'reasoning', text: '这里也有一个 zebra，出现在推理里。' })
  }
  return rows
}

/**
 * A long conversation whose needle is entirely outside the opening window.
 *
 * `zebra` appears exactly twice, at rows 8 and 300 of 600. The panel opens on
 * the newest 60 (rows 540..599), so the word is on screen **nowhere** when the
 * bar is opened. An implementation that searched only the rows it holds would
 * report "no results" — and that is the failure this fixture exists to catch.
 */
const SEARCH_MESSAGES = searchableMessages()

/**
 * A turn that failed, rendered through `failureSentence`.
 *
 * `failure.js` exists because a raw provider message is written for the harness
 * log — it names environment variables and runs to a paragraph — and reading it
 * in a 360px panel is what made a failed turn look like a stack trace left on
 * the screen. The panel shows the mapped sentence and demotes the raw text to a
 * detail line. That whole path had never been rendered in a preview.
 */
const FAILED_MESSAGES = [
  { kind: 'user', text: '帮我把这个页面上的表格抓下来' },
  { kind: 'assistant', text: '好，我先建一个会话。' },
  // `code` decides the sentence; `text` is the provider's own words, kept
  // reachable behind it.
  //
  // `question` is what the host attaches to a failed row: the message that
  // opened the turn. It is here rather than recoverable from the rows above,
  // which is why the assistant line stays between them — the question this
  // failure answers is two rows up, and reading upward would be a guess.
  {
    kind: 'failed',
    code: 'MISSING_CREDENTIAL',
    question: '帮我把这个页面上的表格抓下来',
    text: 'No API key found for provider "deepseek". Set DEEPSEEK_API_KEY in the environment, or run `dsh auth login` and pick a profile. The request was not sent.',
  },
  { kind: 'user', text: '那我换一种方式' },
  // An unmapped code, so the generic sentence and the detail line are both on
  // screen — the case where the panel has to stay useful without a mapping.
  {
    kind: 'failed',
    code: 'SOMETHING_NEW',
    question: '那我换一种方式',
    text: 'upstream returned 502 from the gateway after 3 retries',
  },
]

/** The chrome.* surface the panel actually touches, backed by the fake host. */
function chromeStub(port, state, scenario) {
  return {
    storage: {
      local: {
        // The port must win over the panel's own default (3080), or the preview
        // talks to whatever real harness happens to be listening there — which
        // is both a wrong render and a side effect on the user's live session.
        //
        // The settings page is the exception: it is a form, not a client, and it
        // shows whatever the field holds. Injecting the ephemeral fake-host port
        // there drew `5758` in the port box right beside the hint that says
        // 「通常是 3080」 — a contradiction that existed only in the preview and
        // took a screenshot to notice.
        get: async (defaults) => ({
          ...defaults,
          ...state.stored,
          port: location.pathname.endsWith('options.html')
            ? String(state.stored.port ?? defaults.port ?? '3080')
            : String(port),
        }),
        set: async (values) => { Object.assign(state.stored, values) },
      },
    },
    runtime: {
      openOptionsPage: () => { state.requests.push({ url: 'openOptionsPage' }) },
      // The panel registers exactly one listener here and everything the service
      // worker pushes — assistant deltas, approval questions — arrives through
      // it. Keeping a handle lets a scenario deliver one.
      onMessage: {
        addListener: (fn) => { state.onMessage = fn },
      },
      lastError: undefined,
      getURL: (path) => `chrome-extension://dsh/${path}`,
    },
    // Top level, not under `runtime`: the panel reads
    // `chrome.i18n.getUILanguage()`, and nesting it under `runtime` left it
    // undefined, which silently rendered every scenario in English.
    i18n: { getUILanguage: () => scenario.locale ?? 'en-US' },
    tabs: {
      query: async () => state.tabs,
      // A page with nothing highlighted answers with empty text, which is a
      // legitimate answer and not a dead port: returning `undefined` here made
      // the panel report "Reload the page", a state that did not exist.
      sendMessage: async () => (scenario.hasSelection === true
        ? { text: state.selectionText, url: state.tabs[0].url, title: state.tabs[0].title }
        : { text: '', url: state.tabs[0].url, title: state.tabs[0].title }),
      onActivated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
    },
    scripting: { executeScript: async () => [] },
    contextMenus: { create: () => {}, removeAll: () => {} },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
    sidePanel: { setPanelBehavior: async () => {} },
  }
}

/**
 * Scenarios. Each names a state, plus anything it needs injected before the
 * panel's module runs.
 */
const SCENARIOS = {
  /** The ordinary case: connected, one conversation, chips visible. */
  normal: {},
  /** A page with a highlighted passage, so the selection chip is on screen. */
  selection: {
    hasSelection: true,
    selectionText: 'The debugger permission is equivalent to reading and writing data on every site you are signed in to.',
  },
  /** Extension installed, host never started. The state that was invisible for 33 rounds. */
  hostDown: { hostDown: true },
  /** Host is up, extension is not connected. */
  noBridge: { bridgeConnected: false },
  /** Long conversation, so the "earlier" pill is reachable. */
  more: { more: true },
  /** No sessions at all. */
  empty: { groups: [] },
  /** Model catalog refused. */
  noCatalog: { catalogReason: 'no model service in this profile' },
  /**
   * Model catalog refused, picker open.
   *
   * The two states are separate on purpose. A reader who never opens the picker
   * only ever sees the trigger, and the trigger is where the state has to be
   * legible; opening it is the second chance to say so. Rendering only the
   * closed one leaves "is the explanation anywhere at all" unanswered.
   */
  noCatalogMenu: { catalogReason: 'no model service in this profile', click: '#model' },
  /** An approval card is waiting. */
  approval: { approval: true },
  /** Mid-stream assistant output. */
  streaming: { streaming: true },
  /** The session list, open. */
  historyOpen: { click: '#title' },
  /** The model menu, open. */
  modelMenu: { click: '#model' },
  /** The at-mention menu, open over typed text. */
  mentionMenu: { click: '#input', type: '@gi' },
  /** A conversation longer than one screen, with the "earlier" pill. */
  earlier: { more: true, messages: LONG_MESSAGES },
  /**
   * A conversation the length of a real working day.
   *
   * `earlier` is fourteen rows, which is enough to see a scrollbar but not enough
   * to show what a long session *costs*. The panel rebuilds the whole transcript
   * whenever the rows change (`drawTranscript` → `replaceChildren`), so the
   * question "is this a problem" is only answerable at a length a person actually
   * reaches. Two hundred turns is a few days of real use.
   */
  long: { messages: DAY_MESSAGES },
  /**
   * The find bar, open on a long conversation, with a word typed in.
   *
   * `scenario.click` opens the bar and `scenario.type` targets `#input` — the
   * composer — so the query is typed by the probe instead of by the scenario
   * runner. That is deliberate here: the query has to arrive *after* the search
   * bar is open and the panel has answered a first request, which is what the
   * probe's own sequencing controls.
   */
  findBar: { messages: SEARCH_MESSAGES, click: '#find-open' },
  /**
   * A search that matched, with the panel sent to a match deep in the session.
   *
   * The row that gets the `hit` outline is nine hundred rows above the window
   * the panel opens on, which is the whole claim: the search reached rows the
   * panel has never held.
   */
  findJumped: { messages: SEARCH_MESSAGES, click: '#find-open' },
  /**
   * A long conversation with one reasoning row opened.
   *
   * The open state is what the reader pays for and what the row-name fix is
   * about, and it is invisible in every other scenario: the body only exists
   * while open, so a plain render of `long` shows twenty collapsed `Thinking ⌄`
   * rows and nothing about whether opening one works.
   *
   * `click` takes the first selector that matches, which is the topmost reasoning
   * row — and `scrollIntoView` cannot be expressed here, so the capture shows
   * whatever the panel decides to do with the viewport, which is itself worth
   * photographing.
   */
  longReasoningOpen: { click: '.reasoning-toggle', messages: DAY_MESSAGES },
  /** A turn that failed: the mapped sentence plus the provider's own words. */
  failed: { messages: FAILED_MESSAGES },
  /**
   * The failed tool call with its reason opened.
   *
   * The row opens on click, so a plain render only ever shows it closed — and a
   * closed row cannot be judged for readability. This clicks it the way a person
   * would.
   */
  toolFailure: { click: '.tool.has-reason', messages: TOOL_FAILURE_MESSAGES },
  /**
   * The turn is running and nothing has arrived yet.
   *
   * This is the state every question passes through, and no scenario rendered
   * it: `streaming` sends a delta immediately, so `.working` was already gone
   * by the time the frame was captured. The row is built by `renderWorking()`
   * in `sidepanel.js`, and while it was unrendered nobody could see that its
   * only paint is `color: transparent` over a gradient clipped to the glyphs —
   * which Windows High Contrast discards, leaving the row invisible at exactly
   * the moment it is the only thing on screen.
   */
  working: { running: true },
}

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate.length > 0 && existsSync(candidate)) return candidate
  }
  throw new Error('Chrome not found')
}

/**
 * Build the page the panel runs in.
 *
 * The real `sidepanel.html` is loaded from `file://`-style disk access via a
 * local http server rooted at `extension/`, so relative imports of
 * `locales.js`/`markdown.js` resolve exactly as they do in the extension.
 */
function makeStaticServer() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }
  return createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const name = url.pathname === '/' ? '/sidepanel.html' : url.pathname
    const file = join(EXTENSION, name)
    if (!file.startsWith(EXTENSION) || !existsSync(file)) {
      response.writeHead(404)
      response.end('not found')
      return
    }
    const ext = name.slice(name.lastIndexOf('.'))
    response.writeHead(200, { 'content-type': types[ext] ?? 'application/octet-stream' })
    response.end(readFileSync(file))
  })
}

/**
 * Inject the `chrome` stub and the scenario's initial DOM state *before* the
 * panel module runs, so `start()` sees a coherent world on its first paint.
 */
function bootstrapSource(port, scenario, tabUrl) {
  return `
    (() => {
      const state = { stored: {}, requests: [], selectionText: ${JSON.stringify(scenario.selectionText ?? '')}, tabs: ${JSON.stringify([
        { id: 7, title: 'Example Domain', url: tabUrl, active: true, favIconUrl: '' },
      ])} };
      window.__previewState = state;
      window.chrome = ${JSON.stringify({})};
      const stub = (${chromeStub.toString()})(${port}, state, ${JSON.stringify({
        hasSelection: scenario.hasSelection === true,
        approval: scenario.approval === true,
        streaming: scenario.streaming === true,
        // Serialised explicitly: the stub is stringified and evaluated in the
        // page, so anything not written out here does not exist over there.
        locale: scenario.locale ?? 'en-US',
      })});
      window.chrome = stub;
      // A handle on the stub for probes: the panel's runtime listener and its
      // storage live here, and a probe that wants to drive a real frame has no
      // other way to reach them.
      globalThis.__previewState = state;
      ${scenario.approval === true ? `
      // The approval card arrives through the service worker's runtime message,
      // which is the channel the panel actually listens on.
      setTimeout(() => {
        state.onMessage?.({
          type: 'dsh-approval-asked',
          payload: {
            id: 'q1', sessionId: 'session-a', toolName: 'browser_read',
            origin: 'https://github.com', sensitive: false,
            reason: 'Read the issue page you pointed at'
          }
        });
      }, 400);
      ` : ''}
      ${scenario.streaming === true ? `
      setTimeout(() => {
        state.onMessage?.({
          type: 'dsh-assistant-delta',
          payload: { sessionId: 'session-a', text: '先看快照里哪个元素覆盖在按钮上方' }
        });
      }, 400);
      ` : ''}
    })();
  `
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--list')) {
    emit(`${Object.keys(SCENARIOS).join('\n')}\n`)
    return
  }
  const [name, outArg, ...rest] = args
  const hasFlag = (flag) => rest.includes(`--${flag}`)
  const valueOf = (flag, fallback) => {
    const index = rest.indexOf(`--${flag}`)
    if (index === -1) return fallback
    const value = Number(rest[index + 1])
    return Number.isFinite(value) ? value : fallback
  }
  const textOf = (flag, fallback) => {
    const index = rest.indexOf(`--${flag}`)
    if (index === -1) return fallback
    return rest[index + 1] ?? fallback
  }
  const scheme = textOf('scheme', 'dark')
  if (scheme !== 'light' && scheme !== 'dark') throw new Error(`--scheme must be light or dark, got ${scheme}`)
  // `--forced-colors active` renders the panel the way Windows High Contrast
  // does. It is a separate axis from the colour scheme on purpose: a person
  // running high contrast may also be in either scheme, and the two are decided
  // by different things (the OS theme and the forced-colour setting).
  //
  // This exists because the panel leans on paint that forced colours discard —
  // `box-shadow` for every card's 1px edge and for the composer's focus ring,
  // and `color: transparent` with `background-clip: text` for the working
  // indicator. None of that is visible in an ordinary render, and the audit
  // skips fully transparent subtrees rather than measuring them, so the failure
  // mode is "nothing draws and nothing reports".
  const forcedColors = textOf('forced-colors', 'none')
  if (forcedColors !== 'none' && forcedColors !== 'active') {
    throw new Error(`--forced-colors must be none or active, got ${forcedColors}`)
  }
  // A side panel is narrow, and narrow is where layouts break. 380 is a
  // mid-range Chrome side panel; pass --width 300 for the tightest real case.
  const width = valueOf('width', 380)
  const height = valueOf('height', 720)
  const scenario = SCENARIOS[name]
  if (scenario === undefined) throw new Error(`unknown scenario ${name}; try --list`)
  // The dictionary the panel will pick. Chinese labels are the longest ones the
  // panel draws, so `--locale zh` is the honest width test.
  scenario.locale = textOf('locale', 'en-US')

  const out = resolve(outArg ?? join(HERE, `${name}.png`))
  const state = { requests: [], created: [] }
  const host = makeHost(scenario, state)
  await new Promise((ok) => host.listen(0, '127.0.0.1', ok))
  const hostPort = host.address().port

  const staticServer = makeStaticServer()
  await new Promise((ok) => staticServer.listen(0, '127.0.0.1', ok))
  const staticPort = staticServer.address().port

  const profile = join(HERE, `chrome-profile-${Date.now()}-${process.pid}`)
  mkdirSync(profile, { recursive: true })
  // A crashed audit must not exit 0. `audit-all.mjs` treats a non-zero code as a
  // hard failure, and this is what lets it: without it a broken instrument and
  // a clean run are indistinguishable from the outside.
  let exitCode = 0
  // Derived from the pid rather than picked at random: `audit-all.mjs` runs
  // several previews at once, and two of them drawing the same random port is
  // how one Chrome ends up talking to another's debugging endpoint (observed as
  // a 157s run and a spurious "Chrome never exposed its debugging endpoint").
  // Spreading by pid keeps concurrent previews in disjoint bands.
  const debugPort = 9200 + ((process.pid * 7) % 400) * 25
  const chrome = spawn(findChrome(), [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    `--no-first-run`,
    `--no-default-browser-check`,
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=2',
    `--window-size=${width},${height}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'] })

  let cdp
  const t0 = Date.now()
  let tBoot = t0
  let tNav = t0
  let tSettle = t0
  let tMeasure = t0
  try {
    let version
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline && version === undefined) {
      version = await probeVersion(debugPort)
      if (version === undefined) await new Promise((r) => setTimeout(r, 200))
    }
    if (version === undefined) throw new Error('Chrome never exposed its debugging endpoint')
    tBoot = Date.now()

    cdp = new Cdp(version.webSocketDebuggerUrl)
    await cdp.ready
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Runtime.enable', {}, sessionId)
    // `--window-size` is a window hint and headless still laid the page out at
    // the default width, so the emulation override is what actually decides the
    // viewport. A side panel's whole design problem is its width, so this has to
    // be exact rather than approximate.
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: false,
    }, sessionId)
    // Decide the light/dark side of `color-scheme: light dark` explicitly. The
    // panel's `Canvas`/`CanvasText` tokens resolve against this, so leaving it
    // to the headless default means one of the two palettes is never measured.
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-color-scheme', value: scheme },
        { name: 'forced-colors', value: forcedColors },
      ],
    }, sessionId)

    // Errors in the panel are the single most useful thing a preview can report.
    const consoleErrors = []
    cdp.on('Runtime.exceptionThrown', (params) => {
      consoleErrors.push(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? 'unknown')
    })
    cdp.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') {
        consoleErrors.push((params.args ?? []).map((a) => a.value ?? a.description).join(' '))
      }
    })

    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: bootstrapSource(hostPort, scenario, 'https://github.com/LessXi/dsh-browser-bridge'),
    }, sessionId)

    const load = new Promise((ok) => cdp.on('Page.loadEventFired', ok))
    // `--page options` renders the settings page instead of the side panel.
    // Both are surfaces of the same product, and the settings page is the gate
    // someone passes to paste the token at all — yet only the panel had ever
    // been rendered, which is how it kept a second accent colour for a whole
    // version after the panel's was recalibrated.
    const page = textOf('page', 'sidepanel')
    const pageFile = page === 'options' ? 'options.html' : 'sidepanel.html'
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${staticPort}/${pageFile}` }, sessionId)
    await load
    tNav = Date.now()

    // The panel's first paint is asynchronous: `start()` awaits several reads.
    await new Promise((r) => setTimeout(r, 1200))
    tSettle = Date.now()

    // A scenario may name one interaction, so states that only exist after a
    // click are reachable. These are the surfaces no screenshot has ever caught:
    // they are menus, and they exist only while open.
    if (typeof scenario.click === 'string') {
      // The outcome is kept and reported. A scenario that clicks a selector
      // which is not there used to render an ordinary screenshot and say
      // nothing, so "the click did not apply" and "the click applied and the
      // state looks the same" were indistinguishable — which is exactly the
      // difference between a broken preview and a broken product.
      const clicked = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(scenario.click)});
          if (el === null) return 'missing';
          el.click();
          return 'clicked';
        })()`,
        returnByValue: true,
      }, sessionId)
      if (clicked.result?.value !== 'clicked') {
        emit(`  WARNING scenario.click ${JSON.stringify(scenario.click)} -> ${clicked.result?.value}\n`)
        exitCode = 1
      }
      await new Promise((r) => setTimeout(r, 400))
    }
    if (typeof scenario.type === 'string') {
      await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const el = document.querySelector('#input');
          if (el === null) return 'missing';
          el.focus();
          el.value = ${JSON.stringify(scenario.type)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return 'typed';
        })()`,
        returnByValue: true,
      }, sessionId)
      await new Promise((r) => setTimeout(r, 400))
    }

    // `--focus <selector>` puts the keyboard focus on an element *before* the
    // screenshot, which is the only way to photograph a focus indicator: the
    // screenshot is taken here, and a probe runs after it. Without this, every
    // capture of "what does focus look like" was really a capture of "what does
    // the unfocused panel look like", and the two differ exactly where it matters.
    //
    // `:focus-visible` is what the panel's rules key on, and a synthetic
    // `.focus()` alone does not always match it — the browser decides based on
    // how the focus was reached. Dispatching a real Tab first is what makes the
    // state the one a keyboard user gets, so that is what this does when the
    // caller asks for keyboard focus rather than programmatic focus.
    const focusSelector = textOf('focus', '')
    if (focusSelector.length > 0) {
      const focused = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(focusSelector)});
          if (el === null) return 'missing';
          // Tab-navigation semantics: focus the element the way a keyboard
          // reaches it, so rules written for :focus-visible actually apply.
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
          el.focus({ focusVisible: true });
          return document.activeElement === el ? 'focused' : 'refused';
        })()`,
        returnByValue: true,
      }, sessionId)
      if (focused.result.value !== 'focused') {
        process.stdout.write(`  focus: ${focused.result.value} for ${focusSelector}\n`)
      }
      await new Promise((r) => setTimeout(r, 250))
    }

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, Buffer.from(shot.data, 'base64'))

    const problems = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        toast: document.getElementById('toast')?.textContent ?? '',
        blocked: document.getElementById('blocked')?.hidden === false,
        title: document.getElementById('title-text')?.textContent ?? '',
        rows: document.getElementById('transcript')?.children.length ?? 0,
        contexts: document.getElementById('contexts')?.hidden === false,
        model: document.getElementById('model-text')?.textContent ?? '',
        body: document.body.scrollHeight,
        requests: window.__previewState.requests.length
      })`,
      returnByValue: true,
    }, sessionId)

    // `--probe <file>` runs arbitrary in-page code, so a question about the
    // panel can be answered by measuring it rather than by re-reading its CSS.
    const probeIndex = rest.indexOf('--probe')
    let probe = undefined
/** Set when `--after-probe` writes a second capture. */
let outAfterProbe = undefined
    if (probeIndex !== -1 && typeof rest[probeIndex + 1] === 'string') {
      const source = readFileSync(resolve(rest[probeIndex + 1]), 'utf8')
      // A probe sometimes has to ask about a *different* port than the one it
      // is served from — e.g. "is anything listening on the harness port at
      // all?", which is how the options page can tell a rejected token apart
      // from a harness that is not running. Hand it the real ports rather than
      // letting it guess, and hand it a port that is definitely dead so the
      // negative case is measured rather than assumed.
      const deadPort = await new Promise((ok) => {
        const s = createServer()
        s.listen(0, '127.0.0.1', () => {
          const p = s.address().port
          s.close(() => ok(p))
        })
      })
      await cdp.send('Runtime.evaluate', {
        expression: `globalThis.__probeUpPort = ${hostPort}; globalThis.__probeDownPort = ${deadPort}`,
        returnByValue: true,
      }, sessionId)
      const probed = await cdp.send('Runtime.evaluate', {
        expression: source,
        returnByValue: true,
        awaitPromise: true,
      }, sessionId)
      if (probed.exceptionDetails !== undefined) {
        probe = `PROBE FAILED: ${probed.exceptionDetails.exception?.description ?? probed.exceptionDetails.text}`
      } else {
        probe = probed.result.value
      }
    }

    // `--keys "Tab,Tab,PageDown"` sends *real* keystrokes through CDP, which is
    // the only way to ask a question about the keyboard.
    //
    // An in-page probe cannot answer those: `dispatchEvent` makes an untrusted
    // event, so the browser's own default actions — moving focus on Tab,
    // scrolling on PageDown, and which of the two a given element gets — never
    // run, and a probe that measured them would be measuring its own synthetic
    // event. `--probe` also runs *after* the main capture, so its keystrokes
    // could not appear in any screenshot anyway.
    //
    // Keys are sent before `--after-probe`, so the capture shows the keyboard's
    // result rather than the state the scenario started in.
    //
    // One reading per step, because the question is a sequence — "where did focus
    // go, and did the transcript move" — and a single end state cannot tell a
    // panel that scrolled from one that merely moved focus.
    const keysIndex = rest.indexOf('--keys')
    let keySteps = undefined
    if (keysIndex !== -1 && typeof rest[keysIndex + 1] === 'string') {
      const MODIFIERS = { alt: 1, ctrl: 2, control: 2, meta: 4, shift: 8 }
      const NAMED = {
        Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
        Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
        Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
        PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
        PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
        End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
        Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
        ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
        ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
        ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
        ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
      }
      const describeKey = (spec) => {
        const parts = spec.split('+')
        const name = parts.pop()
        let modifiers = 0
        for (const part of parts) {
          const bit = MODIFIERS[part.toLowerCase()]
          if (bit === undefined) throw new Error(`--keys: unknown modifier "${part}" in "${spec}"`)
          modifiers |= bit
        }
        const named = NAMED[name]
        if (named !== undefined) return { ...named, modifiers }
        if (/^[a-zA-Z]$/.test(name)) {
          // A bare letter needs `text` to be typed; a modified one is a shortcut
          // and must not insert anything, so it carries no text at all.
          const upper = name.toUpperCase()
          return {
            key: name,
            code: `Key${upper}`,
            windowsVirtualKeyCode: upper.charCodeAt(0),
            modifiers,
            ...(modifiers === 0 ? { text: name } : {}),
          }
        }
        throw new Error(`--keys: unknown key "${name}" in "${spec}"`)
      }
      const READ_STATE = `JSON.stringify((() => {
        const active = document.activeElement
        const transcript = document.getElementById('transcript')
        const history = document.getElementById('history')
        // Whichever scroller is the visible one: the two views are alternatives,
        // and the history is hidden while the conversation is showing.
        const scroller = transcript !== null && transcript.hidden !== true && transcript.offsetParent !== null
          ? transcript
          : history
        const name = (element) => element === null || element === undefined
          ? 'none'
          : (element.id === '' ? element.tagName.toLowerCase() : '#' + element.id)
        // Where the focused element actually sits, and which row holds it: a
        // scroll reading alone cannot tell "the browser scrolled to a button at
        // the top" from "something reset the scroller".
        const box = active === null || active === document.body ? null : active.getBoundingClientRect()
        const row = active === null ? null : active.closest?.('.row, .reasoning, .working, .approval, .live') ?? null
        const rows = transcript === null ? [] : [...transcript.children]
        return {
          active: name(active),
          activeClass: active === null || typeof active.className !== 'string' ? '' : active.className,
          activeTop: box === null ? null : Math.round(box.top),
          activeRowIndex: row === null ? null : rows.indexOf(row),
          activeRowClass: row === null ? null : row.className,
          focusedInTranscript: active !== null && transcript !== null && transcript.contains(active),
          focusedInHistory: active !== null && history !== null && history.contains(active),
          rowCount: rows.length,
          scrollTop: scroller === null || scroller === undefined ? null : Math.round(scroller.scrollTop),
          scrollHeight: scroller === null || scroller === undefined ? null : scroller.scrollHeight,
          clientHeight: scroller === null || scroller === undefined ? null : scroller.clientHeight,
          findOpen: document.getElementById('find-open')?.getAttribute('aria-expanded') ?? null,
        }
      })())`
      const readState = async () => {
        const result = await cdp.send('Runtime.evaluate', {
          expression: READ_STATE,
          returnByValue: true,
        }, sessionId)
        return JSON.parse(result.result.value)
      }
      keySteps = [{ spec: null, state: await readState() }]
      for (const spec of rest[keysIndex + 1].split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')) {
        const params = describeKey(spec)
        // `rawKeyDown` for the press and `keyUp` for the release: `keyDown` would
        // additionally require a `text` field and would insert a character for
        // keys that must not type one.
        await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params }, sessionId)
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params }, sessionId)
        // A frame, because Tab's focus move and PageDown's scroll are both
        // applied by the browser rather than by the page's own handlers.
        await new Promise((ok) => setTimeout(ok, 80))
        keySteps.push({ spec, state: await readState() })
      }
    }

    // `--after-probe <out.png>` photographs the page *after* the probe has run.
    //
    // The screenshot above is taken before the probe, so everything a probe
    // changes — a search that has been typed and jumped, a row it opened, a menu
    // it walked — was invisible to every capture. Reviewing those states meant
    // either duplicating the interaction as a scenario (a second copy that
    // drifts from the probe) or judging them from readings alone, which is how a
    // styling mistake ships: the readings said the row was `hit` and correct,
    // and nothing ever showed what `hit` looks like.
    if (hasFlag('after-probe')) {
      const afterOut = resolve(textOf('after-probe'))
      const afterShot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId)
      mkdirSync(dirname(afterOut), { recursive: true })
      writeFileSync(afterOut, Buffer.from(afterShot.data, 'base64'))
      outAfterProbe = afterOut
    }

    // `--ax` asks the browser what it actually exposes to assistive technology.
    //
    // This is the only authority on ARIA: an attribute whose role does not
    // support it is dropped silently — `aria-checked` on a plain `<button>`
    // reads as progress to the author and as nothing at all to a screen
    // reader, and no amount of reading the source shows the difference. The
    // partial tree per element is deliberate: the full tree is enormous and
    // mostly `<div>`s, and the only question here is what these specific
    // attributes compute to.
    let ax = undefined
    if (hasFlag('ax')) {
      const { root } = await cdp.send('DOM.getDocument', { depth: 0 }, sessionId)
      const selector = '[aria-selected], [aria-checked], [aria-current], [aria-expanded], [aria-label], [aria-busy], [role]'
      const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector }, sessionId)
      ax = []
      for (const nodeId of nodeIds) {
        const described = await cdp.send('DOM.describeNode', { nodeId }, sessionId)
        const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false }, sessionId)
        const node = nodes.find((candidate) => candidate.backendDOMNodeId === described.node.backendNodeId)
        if (node === undefined) continue
        // What the author wrote, and what the platform kept.
        const { outerHTML } = await cdp.send('DOM.getOuterHTML', { nodeId }, sessionId)
        ax.push({
          tag: described.node.nodeName.toLowerCase(),
          authored: outerHTML.slice(0, 160).replace(/\s+/g, ' '),
          computedRole: node.role?.value ?? null,
          computedName: node.name?.value ?? null,
          ignored: node.ignored === true,
          ignoredReasons: (node.ignoredReasons ?? []).map((reason) => reason.name),
          properties: Object.fromEntries((node.properties ?? []).map((p) => [p.name, p.value?.value ?? null])),
        })
      }
    }

    // `--ax-tree <selector>` dumps the accessibility subtree the platform builds
    // under one element.
    //
    // Different question from `--ax`, and the difference is the point. `--ax` asks
    // "of the attributes the author wrote, what did the platform keep" — it starts
    // from the author's own annotations and so can only ever confirm or deny them.
    // This starts from the *content* and asks what a screen reader is handed: the
    // roles the platform computed on its own, and whether subtrees were dropped.
    //
    // A conversation is the case that needs it. Whether a reader can move from
    // message to message is decided by roles nobody wrote down, and "the text is
    // all there in the DOM" is exactly the claim that a single flat run of text
    // satisfies while being unusable.
    let axTree = undefined
    const axTreeIndex = rest.indexOf('--ax-tree')
    if (axTreeIndex !== -1 && typeof rest[axTreeIndex + 1] === 'string') {
      const selector = rest[axTreeIndex + 1]
      const { root } = await cdp.send('DOM.getDocument', { depth: 0 }, sessionId)
      const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector }, sessionId)
      if (nodeIds.length === 0) {
        axTree = { selector, found: false, note: 'selector matched nothing' }
      } else {
        const described = await cdp.send('DOM.describeNode', { nodeId: nodeIds[0] }, sessionId)
        const backendId = described.node.backendNodeId
        const full = await cdp.send('Accessibility.getFullAXTree', {}, sessionId)
        const nodes = full.nodes

        // The subtree under the element, found by walking `childIds` from it. The
        // full tree is one flat array with parent/child links, so containment is
        // expressed by those links rather than by order.
        const byId = new Map(nodes.map((node) => [node.nodeId, node]))
        const anchor = nodes.find((node) => node.backendDOMNodeId === backendId)
        const collected = []
        const walk = (node, depth) => {
          if (node === undefined) return
          collected.push({
            depth,
            role: node.role?.value ?? null,
            name: (node.name?.value ?? '').slice(0, 60),
            /** `StaticText` carrying the conversation itself, or a node with a value */
            value: typeof node.value?.value === 'string' ? node.value.value.slice(0, 60) : null,
            ignored: node.ignored === true,
            ignoredReasons: (node.ignoredReasons ?? []).map((reason) => reason.name),
            childCount: (node.childIds ?? []).length,
          })
          for (const childId of node.childIds ?? []) walk(byId.get(childId), depth + 1)
        }
        walk(anchor, 0)

        // Roles that give a reader somewhere to move *between* pieces of content.
        // A list, a log, headings, or a table: navigation by structure rather than
        // by reading every character in order.
        const NAVIGABLE = new Set(['list', 'listitem', 'log', 'article', 'heading', 'table', 'row', 'group'])
        const roles = collected.map((entry) => entry.role).filter((role) => role !== null)
        axTree = {
          selector,
          found: true,
          nodeCount: collected.length,
          /** How deep the exposed structure goes; 1 means "one flat blob". */
          maxDepth: collected.reduce((deepest, entry) => Math.max(deepest, entry.depth), 0),
          roleCounts: roles.reduce((counts, role) => ({ ...counts, [role]: (counts[role] ?? 0) + 1 }), {}),
          navigableRoles: [...new Set(roles.filter((role) => NAVIGABLE.has(role)))],
          ignoredCount: collected.filter((entry) => entry.ignored).length,
          /** ★ Can a reader move between messages, or is it one run of text? */
          hasMessageStructure: roles.some((role) => NAVIGABLE.has(role)),
          /** The first two levels, which is what "where am I" is answered from. */
          outline: collected.slice(0, 24),
        }
      }
    }

    let audit = undefined
    let auditFailed = false
    tMeasure = Date.now()
    if (hasFlag('audit')) {
      const auditResult = await cdp.send('Runtime.evaluate', {
        expression: AUDIT_SOURCE,
        returnByValue: true,
        awaitPromise: true,
      }, sessionId)
      if (auditResult.exceptionDetails !== undefined) {
        // A crashed audit must not look like a clean one. Printing `audit: {}`
        // for a thrown ReferenceError is how a broken instrument reports health.
        auditFailed = true
        exitCode = 1
        emit(`  AUDIT FAILED: ${auditResult.exceptionDetails.exception?.description ?? auditResult.exceptionDetails.text}\n`)
      }
      audit = auditResult.result.value
    }

    emit(`scenario ${name} (${scheme}) -> ${out}\n`)
    emit(`  dom: ${problems.result.value}\n`)
    if (consoleErrors.length > 0) {
      emit(`  CONSOLE ERRORS (${consoleErrors.length}):\n`)
      for (const e of consoleErrors.slice(0, 8)) emit(`    ${e.split('\n')[0]}\n`)
    }
    emit(`  host requests: ${JSON.stringify(state.requests.slice(0, 6))}\n`)
    if (audit !== undefined) {
      emit(`  audit: ${typeof audit === 'string' ? audit : JSON.stringify(audit, null, 2)}\n`)
    }
    if (probe !== undefined) {
      emit(`  probe: ${typeof probe === 'string' ? probe : JSON.stringify(probe, null, 2)}\n`)
    }
    if (keySteps !== undefined) {
      emit(`  keys: ${JSON.stringify(keySteps, null, 2)}\n`)
    }
    if (outAfterProbe !== undefined) {
      emit(`  after-probe: ${outAfterProbe}\n`)
    }
    if (ax !== undefined) {
      const dropped = ax.filter((row) => row.ignored || row.computedRole === null || row.computedRole === 'generic')
      emit(`  ax: ${ax.length} nodes with ARIA, ${dropped.length} expose no specific role\n`)
      for (const row of ax) {
        emit(`    <${row.tag}> role=${row.computedRole ?? '(none)'}${row.ignored ? ' IGNORED' : ''} name=${JSON.stringify(row.computedName)}\n`)
        emit(`      ${row.authored}\n`)
        if (Object.keys(row.properties).length > 0) emit(`      props: ${JSON.stringify(row.properties)}\n`)
        if (row.ignoredReasons.length > 0) emit(`      ignoredReasons: ${row.ignoredReasons.join(', ')}\n`)
      }
    }
    if (axTree !== undefined) {
      if (!axTree.found) {
        emit(`  ax-tree ${axTree.selector}: ${axTree.note}\n`)
      } else {
        emit(`  ax-tree ${axTree.selector}: ${axTree.nodeCount} nodes, depth ${axTree.maxDepth},`)
        emit(` ${axTree.ignoredCount} ignored, structure=${axTree.hasMessageStructure}\n`)
        emit(`    roleCounts: ${JSON.stringify(axTree.roleCounts)}\n`)
        emit(`    navigable: ${JSON.stringify(axTree.navigableRoles)}\n`)
        for (const row of axTree.outline) {
          const indent = '  '.repeat(row.depth + 2)
          const name = row.name.length > 0 ? ` ${JSON.stringify(row.name)}` : ''
          const value = row.value !== null ? ` value=${JSON.stringify(row.value)}` : ''
          emit(`${indent}${row.role ?? '(none)'}${name}${value}${row.ignored ? ' [ignored]' : ''}\n`)
        }
      }
    }
    if (process.env.PREVIEW_TIMING === '1') {
      emit(`  TIMING boot=${(tBoot - t0).toFixed(0)}ms nav=${(tNav - tBoot).toFixed(0)}ms settle=${(tSettle - tNav).toFixed(0)}ms measure=${(tMeasure - tSettle).toFixed(0)}ms\n`)
    }
  } catch (error) {
    // Without this the `finally` below exited 0 on the way out and swallowed the
    // reason: `process.exit` never returns, so a thrown "Chrome never exposed its
    // debugging endpoint" reached the caller as `no audit output (exit 0, 0B)`.
    // A tool that hides why it failed costs more than the failure.
    emit(`  PREVIEW FAILED: ${error.stack ?? error.message}\n`)
    exitCode = 1
  } finally {
    const tTeardown = Date.now()
    cdp?.close()
    try { chrome.kill() } catch { /* already gone */ }
    const tKill = Date.now()
    // `server.close()` only stops accepting new connections — it waits for the
    // ones already open, and the panel's own keep-alive requests to these two
    // servers are exactly that. Leaving them open kept the event loop alive for
    // ~20s after all work was finished (measured: 1.8s of real work, 21.9s
    // wall clock). Tearing the connections down is what makes the process end
    // when the work does.
    host.closeAllConnections()
    staticServer.closeAllConnections()
    host.close()
    staticServer.close()
    // The CDP websocket is undici's, and its close handshake leaves the
    // underlying handle behind (two `Socket`s survived teardown in a probe).
    // Once every measurement is written, nothing is left to wait for.
    try { cdp?.socket?.close() } catch { /* already gone */ }
    // Wait for Chrome to actually be gone before deleting its profile.
    // `kill()` only delivers the signal; Chrome keeps its profile files open
    // while it shuts down, so removing the directory straight away lost the race
    // and the error was swallowed as "held open". The cost was silent: 1,323
    // orphaned profile directories had accumulated in `.tmp-run/`.
    await new Promise((done) => {
      if (chrome.exitCode !== null || chrome.signalCode !== null) { done(); return }
      const give_up = setTimeout(done, 5_000)
      chrome.once('exit', () => { clearTimeout(give_up); done() })
    })
    try { rmSync(profile, { recursive: true, force: true }) } catch { /* still held */ }
    if (process.env.PREVIEW_TIMING === '1') {
      emit(`  TEARDOWN kill=${tKill - tTeardown}ms rmProfile=${Date.now() - tKill}ms totalAlive=${Date.now() - t0}ms\n`)
    }
    // `process.exitCode`, not `process.exit()`: the audit JSON is a few KB, and a
    // forced exit truncates a large async write to a pipe. `audit-all.mjs` pipes
    // this stdout, so it saw an empty result about one run in three — a flaky
    // instrument reporting on itself.
    //
    // Both halves are needed: the flush so the JSON is not truncated, and the
    // exit because the CDP websocket's underlying handle survives its own close
    // handshake (a probe caught two live `Socket`s after teardown) and would
    // otherwise hold the loop open for ~20s after the work is done.
    await flush()
    process.exit(exitCode)
  }
}

await main()
// `--list` and the early-return paths never enter the try above, so the buffer
// is flushed here too. `flush` is idempotent, so the normal path having already
// written it costs nothing.
await flush()
