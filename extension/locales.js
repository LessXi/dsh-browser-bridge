/**
 * Side panel copy, in one place.
 *
 * `zh` is the key-set source of truth: a key that exists only in `en` is a key
 * that will render in the wrong language the moment someone adds it, so the
 * tests check the two dictionaries for the same key set.
 *
 * The list is deliberately short, and every entry in it is a *label*. The panel
 * that this replaced carried fifteen sentences explaining itself — "将附带：",
 * "发送时会带上当前标签页的标题和网址…", role captions, an empty-state paragraph —
 * and the complaint that produced this rewrite was that the panel was mostly
 * explanation. A control says what it does; a state shows itself; neither needs
 * a paragraph. The original Codex side panel has no hint/description/helper
 * style class at all, which is the same conclusion reached from the other end.
 *
 * MV3's own `_locales/` + `chrome.i18n.getMessage` was the other option and was
 * rejected: it needs `default_locale` in the manifest plus a message file per
 * language, it cannot express parameters without a placeholder table, and — the
 * deciding reason — none of it can be exercised from the Node test suite that
 * the rest of this project is verified by. A plain module has none of those
 * problems and matches the shape the host half already uses for its settings
 * card (`ctx.locale.register(namespace, { zh, en })` in `lib/client.js`).
 *
 * @module extension/locales
 */

/** Simplified Chinese. The key set every other dictionary is checked against. */
export const zh = Object.freeze({
  'panel.title': 'DSH',

  // Header. Two controls only: the session title opens the history view, and
  // `+` starts a session.
  'action.back': '返回',
  'action.back.title': '回到对话',
  'action.new': '新建会话',
  'action.new.title': '在当前工作区新建会话',
  'action.settings': '设置',
  'action.send': '发送',
  'action.send.title': '发送',
  'action.stop': '停止',
  'action.stop.title': '停下这一轮',
  'action.toBottom': '回到底部',
  'action.drop': '移除',
  'action.copy': '复制',
  'action.copied': '已复制',
  // Both copy buttons draw the same short word, so the accessible name is what
  // tells them apart — Chrome's tree carried two controls named 「复制」.
  'action.copyCode': '复制代码',
  'action.copyAnswer': '复制整条回答',

  // The history view.
  'history.empty': '还没有会话',
  // The bucket for sessions whose directory is not a registered workspace. DSH's
  // own sidebar has the same bucket and names it 「未分组」, so this is its word
  // rather than one of ours.
  'history.ungrouped': '未分组',
  'tabs.title': '受控标签页',
  'tabs.none': '没有受控标签页',
  'tabs.untitled': '（无标题）',

  // Session rows.
  'session.untitled': '未命名会话',
  'session.new': '新会话',
  'session.running': '正在运行',

  // The composer and its attachments.
  'composer.placeholder': '问点什么…',
  // The way back into a conversation longer than one window. A long session is
  // not unusual — one of the author's own is 6969 rows, of which the panel used
  // to show the last 60 with no indication that anything was missing.
  'transcript.earlier': '更早的内容',
  'transcript.loading': '加载中…',
  'context.tab': '当前标签页',
  'context.selection': '选中内容',
  // Shown on the attachment chip only while the extension is not attached to the
  // harness, because in that state the chip would otherwise promise a context
  // the send cannot actually carry.
  'context.offline': '未连接',
  'bridge.noToken': '没填令牌',
  'bridge.fix': '点击让它重新连接',
  'error.bridgeRefused': '连不上宿主：{reason}',
  // The `@` picker. `at.empty` and `at.none` are two different nothings: one
  // means the browser has no page this panel could read, the other means the
  // typing has not matched one yet. Saying the same thing for both would send
  // someone hunting for a tab that was never offerable.
  'at.list': '标签页',
  'at.empty': '没有可读取的标签页',
  'at.none': '没有匹配的标签页',

  // The model picker. It is a control, so it names itself once and then shows
  // its value — the trigger carries no "model" caption, which is also what the
  // original does: its `_ComposerDropdownLabelCategory` ships `display:none`.
  'model.select': '选择模型',
  'model.effort': '推理等级',
  'model.default': '默认',
  'model.unavailable': '模型列表不可用',
  'model.failed': '切换失败：{reason}',

  // Transcript rows. One line each, by construction.
  'row.reasoning': '思考',
  'row.context': '已附带',
  'row.working': '思考中…',

  // Relative time, for a session row's trailing label.
  'time.now': '刚刚',
  'time.minutes': '{count} 分钟前',
  'time.hours': '{count} 小时前',
  'time.days': '{count} 天前',

  // Only ever shown when something failed.
  'error.generic': '出错了：{reason}',
  'error.notSent': '未发送：{reason}',
  'error.notStopped': '没能停下：{reason}',
  'error.loadFailed': '读取失败：{error}',
  'error.startedFailed': '面板启动失败：{error}',
  'error.noSession': '先选择一个会话',
  // The panel and the host ship separately: reloading the extension is one
  // click, replacing the host's code means restarting `dsh web`. When the two
  // disagree, every route answers a shape the panel does not understand, which
  // would otherwise read as "no sessions" and a bare 400.
  'error.restartHost': '请重启 dsh web（宿主是旧版本）',
  // The blocked surface: a title, what to do, and the button that does it.
  'blocked.hostTitle': '连不上 dsh web',
  'blocked.hostBody': '先启动 dsh web，再重试。',
  'blocked.retry': '重试',
  'blocked.retrying': '重试中…',
  // The host answers every send with what it staged and what it refused. A
  // refusal used to be invisible: the chip promised an attachment, the message
  // went out without it, and nothing said so.
  'error.attachmentRefused': '有附件没被接受：{reason}',
  // A page whose reporter cannot be reached looks exactly like a page with
  // nothing selected, and the user's question — "will this be attached?" — has
  // opposite answers in the two cases. Reloading installs a fresh reporter.
  'error.reportStale': '请刷新页面',
  'error.notCopied': '复制失败',
  'error.notAnswered': '没能作答：{reason}',
  'error.turnFailed': '这一轮没能跑起来',
  // Why the turn failed, said in the reader's language. The provider's own
  // message is a log line — it names environment variables and points at config
  // files — so it becomes the detail, and these decide the headline. Each is
  // written as something a person can act on, not as a restatement of the code.
  'error.code.credential': '模型还没配置密钥',
  'error.code.quota': '额度用完了',
  'error.code.rateLimited': '请求太频繁，稍后再试',
  'error.code.tooLong': '这段对话超出模型长度',
  'error.code.noImages': '这个模型看不了图片',
  'error.code.reasoning': '这个模型不支持该推理强度',
  'error.code.unreachable': '连不上模型服务',
  'error.code.empty': '模型没有返回内容',
  // The one place the panel asks instead of reporting. The harness's other
  // answerer is the graphical client, so this card is often the only thing
  // standing between a running turn and one that waits forever.
  'approval.asking': '需要你确认',
  'approval.wants': '要用 {tool}',
  'approval.wantsSite': '要在 {site} 上使用 {tool}',
  'approval.sensitive': '这一步会改动页面或花钱，不只是读',
  'approval.spends': '这一步可能会提交、购买或删除',
  'approval.uploads': '这一步会从你的电脑上传文件',
  'approval.runsCode': '这一步会在页面里执行代码',
  'approval.eachTime': '这一步每次都要重新确认',
  'approval.aTool': '一个工具',
  'approval.allow': '本会话允许',
  'approval.once': '只允许一次',
  'approval.reject': '拒绝',
  'approval.detail': '技术详情',
})

/** English. Same keys as {@link zh}. */
export const en = Object.freeze({
  'panel.title': 'DSH',

  'action.back': 'Back',
  'action.back.title': 'Back to the conversation',
  'action.new': 'New chat',
  'action.new.title': 'New chat in this workspace',
  'action.settings': 'Settings',
  'action.send': 'Send',
  'action.send.title': 'Send',
  'action.stop': 'Stop',
  'action.stop.title': 'Stop this turn',
  'action.toBottom': 'Jump to latest',
  'action.drop': 'Remove',
  'action.copy': 'Copy',
  'action.copied': 'Copied',
  'action.copyCode': 'Copy code',
  'action.copyAnswer': 'Copy the whole answer',

  'history.empty': 'No chats yet',
  'history.ungrouped': 'Ungrouped',
  'tabs.title': 'Controlled tabs',
  'tabs.none': 'No controlled tabs',
  'tabs.untitled': '(untitled)',

  'session.untitled': 'Untitled chat',
  'session.new': 'New chat',
  'session.running': 'Working',

  'composer.placeholder': 'Ask anything…',
  'transcript.earlier': 'Earlier messages',
  'transcript.loading': 'Loading…',
  'context.tab': 'this tab',
  'context.selection': 'the selection',
  'context.offline': 'Offline',
  'bridge.noToken': 'No token',
  'bridge.fix': 'Click to reconnect',
  'error.bridgeRefused': 'Cannot reach the host: {reason}',
  'at.list': 'Tabs',
  'at.empty': 'No readable tabs',
  'at.none': 'No matching tabs',

  'model.select': 'Select model',
  'model.effort': 'Reasoning',
  'model.default': 'Default',
  'model.unavailable': 'No model list',
  'model.failed': 'Could not switch: {reason}',

  'row.reasoning': 'Thinking',
  'row.context': 'Attached',
  'row.working': 'Thinking…',

  'time.now': 'just now',
  'time.minutes': '{count}m ago',
  'time.hours': '{count}h ago',
  'time.days': '{count}d ago',

  'error.generic': 'Something went wrong: {reason}',
  'error.notSent': 'Not sent: {reason}',
  'error.notStopped': 'Could not stop: {reason}',
  'error.loadFailed': 'Could not load: {error}',
  'error.startedFailed': 'Panel failed to start: {error}',
  'error.noSession': 'Pick a chat first',
  'error.restartHost': 'Restart dsh web (host is older)',
  'blocked.hostTitle': 'dsh web is not running',
  'blocked.hostBody': 'Start dsh web, then retry.',
  'blocked.retry': 'Retry',
  'blocked.retrying': 'Retrying…',
  'error.attachmentRefused': 'Attachment refused: {reason}',
  'error.reportStale': 'Reload the page',
  'error.notCopied': 'Could not copy',
  'error.notAnswered': 'Could not answer: {reason}',
  'error.turnFailed': 'The turn did not run',
  'error.code.credential': 'No model key is set',
  'error.code.quota': 'The quota is used up',
  'error.code.rateLimited': 'Too many requests, try later',
  'error.code.tooLong': 'This chat is too long',
  'error.code.noImages': 'This model cannot see images',
  'error.code.reasoning': 'This model lacks that effort',
  'error.code.unreachable': 'Cannot reach the model service',
  'error.code.empty': 'The model returned nothing',
  'approval.asking': 'Needs your call',
  'approval.wants': 'Wants to use {tool}',
  'approval.wantsSite': 'Wants to use {tool} on {site}',
  'approval.sensitive': 'Changes the page or spends money',
  'approval.spends': 'May submit, buy, or delete',
  'approval.uploads': 'Uploads a file from your computer',
  'approval.runsCode': 'Runs code in the page',
  'approval.eachTime': 'This one is confirmed every time',
  'approval.aTool': 'a tool',
  'approval.allow': 'Allow this session',
  'approval.once': 'Allow once',
  'approval.reject': 'Deny',
  'approval.detail': 'Technical detail',
})

/** Every dictionary, by locale tag. */
export const DICTIONARIES = Object.freeze({ zh, en })

/**
 * The options page, whose copy is a different shape on purpose.
 *
 * The panel's rule is that an entry is a *label* — a control says what it does,
 * a state shows itself, and nothing explains itself in a paragraph, because a
 * 360px column has no room for prose. An options page is the opposite kind of
 * surface: it is read once, sitting still, at full width, and it is where
 * someone decides whether to hand over the `debugger` permission at all. The
 * security paragraph there is not noise, it is the point.
 *
 * So this is a second dictionary rather than more keys in the first, and the
 * sentence-length test stays scoped to the panel's — widening that rule to cover
 * this file would either fail on copy that belongs on screen or force the
 * warning into a fragment that no longer explains anything.
 *
 * `zh` is still the key-set source of truth.
 */
export const options = Object.freeze({
  zh: Object.freeze({
    heading: 'DSH 浏览器桥接',
    lede: '这个扩展让 DeepSeek Harness 的会话读取并操作你自己 Chrome 里的页面，包括你已经登录的站点。',
    warnTitle: '连接之前',
    warnBody: 'debugger 权限等同于可以在所有站点上读取和修改你的数据，包括已登录的会话。Harness 在接触每个新站点之前都会先问你，你也可以在 DSH 的「设置 → 插件」里彻底关掉这个桥接。',
    connTitle: '连接',
    portLabel: 'Harness 端口',
    portHint: 'Harness 网址里的那个端口，通常是 3080。',
    tokenLabel: '桥接令牌',
    tokenHint: '打开 DSH，进入「设置 → 插件 → browser-bridge」，复制令牌。它只保存在这个浏览器配置文件里。',
    autoPushLabel: '把每次划词自动同步进 DSH 上下文',
    autoPushHint: '默认关闭。关闭时由你从右键菜单决定送什么，所以只是划词去复制一段文字，永远不会进模型。',
    save: '保存并连接',
    test: '测试连接',
    filesTitle: '文件上传',
    filesBody: '要让 DSH 通过页面上传文件，需要 Chrome 里一个本扩展自己无法授予的设置：打开 chrome://extensions，找到本扩展，点「详情」，打开「允许访问文件网址」。',
    controlTitle: '它怎样始终由你掌控',
    control1: '桥接只监听本机回环地址，扩展用令牌证明自己的身份。',
    control2: '每个新站点都需要你批准，DSH 才能读取或操作它。',
    control3: '提交表单、付款、删除会再问一次。',
    control4: '浏览历史永远不会被记成「已允许」——每次读取都要重新问。',
    control5: '页面内容除了送进你自己的 harness，不会发往任何地方。',
    noToken: '还没有保存令牌。请从 DSH「设置 → 插件 → browser-bridge」复制。',
    connected: '已连接到 {port} 端口上的 harness。',
    cannotConnect: '连不上 {port} 端口。',
    checkIntro: '请检查：',
    check1: 'harness 在运行（dsh web），且端口与它的网址一致；',
    check2: '令牌与 DSH「设置 → 插件 → browser-bridge」里的一致；',
    check3: '没有别的程序占着这个端口。',
    refused: 'harness 拒绝了连接——最常见的原因是令牌不对或已过期。',
    timeout: 'harness 8 秒内没有回应。',
    saved: '已保存，正在连接…',
    testing: '正在测试…',
    socketFailed: '打不开连接：{reason}',
    loadFailed: '读不到已保存的设置：{reason}',
    // Chrome draws these in its own right-click menu, in front of whatever page
    // the person is reading. They are short because a context menu row is.
    'menu.addSelection': '把选中内容加入 DSH 上下文',
    'menu.addPage': '把本页加入 DSH 上下文',
    'menu.addTab': '把本标签页加入 DSH 上下文',
    'menu.autoPush': '自动同步划词',
  }),
  en: Object.freeze({
    heading: 'DSH Browser Bridge',
    lede: 'This extension lets a DeepSeek Harness session read and operate pages in your own Chrome — including sites you are already signed in to.',
    warnTitle: 'Before you connect',
    warnBody: 'The debugger permission is equivalent to being able to read and change your data on every site, including signed-in sessions. The harness asks you before it touches each new site, and you can switch the bridge off entirely from DSH Settings → Plugins.',
    connTitle: 'Connection',
    portLabel: 'Harness port',
    portHint: 'The port shown in the harness URL, usually 3080.',
    tokenLabel: 'Bridge token',
    tokenHint: 'Open DSH, go to Settings → Plugins → browser-bridge, and copy the token. It is stored only in this browser profile.',
    autoPushLabel: 'Sync every text selection into DSH context automatically',
    autoPushHint: 'Off by default. With it off, you choose what to send from the right-click menu, so merely highlighting text to copy it never reaches the model.',
    save: 'Save and connect',
    test: 'Test connection',
    filesTitle: 'File uploads',
    filesBody: 'To let DSH upload a file through a page, Chrome needs one setting this extension cannot grant for itself: open chrome://extensions, find this extension, choose Details, and turn on Allow access to file URLs.',
    controlTitle: 'How this stays under your control',
    control1: 'The bridge listens on loopback only, and this extension proves itself with a token.',
    control2: 'Every new site needs your approval before DSH may read or act on it.',
    control3: 'Submitting forms, purchasing, and deleting ask a second time.',
    control4: 'Browser history is never remembered as allowed — every read asks again.',
    control5: 'No page content is ever sent anywhere except to your own harness.',
    noToken: 'No token saved. Copy it from DSH Settings → Plugins → browser-bridge.',
    connected: 'Connected to the harness on port {port}.',
    cannotConnect: 'Could not connect on port {port}.',
    checkIntro: 'Check that:',
    check1: 'the harness is running (dsh web) and the port matches its URL;',
    check2: 'the token matches DSH Settings → Plugins → browser-bridge;',
    check3: 'nothing else on this machine is holding that port.',
    refused: 'The harness refused the connection — most often a wrong or stale token.',
    timeout: 'The harness did not answer within 8 seconds.',
    saved: 'Saved. Connecting…',
    testing: 'Testing…',
    socketFailed: 'Could not open the socket: {reason}',
    loadFailed: 'Could not read saved settings: {reason}',
    'menu.addSelection': 'Add selection to DSH context',
    'menu.addPage': 'Add this page to DSH context',
    'menu.addTab': 'Add this tab to DSH context',
    'menu.autoPush': 'Sync selections automatically',
  }),
})

/**
 * The translator for the options page.
 *
 * Same `locale → en → key` fallback as {@link translator}, over the options
 * dictionary instead of the panel's.
 *
 * @param {'zh' | 'en'} locale - Which dictionary to prefer.
 * @returns {(key: string, params?: Record<string, unknown>) => string} The translator.
 */
export function optionsTranslator(locale) {
  const primary = options[locale] ?? options.en
  return (key, params = {}) => {
    const template = primary[key] ?? options.en[key] ?? key
    return template.replace(/\{(\w+)\}/g, (whole, name) => (
      params[name] === undefined ? whole : String(params[name])
    ))
  }
}

/**
 * Which dictionary a UI language should use.
 *
 * @param {string} [language] - A BCP-47 tag, e.g. `chrome.i18n.getUILanguage()`.
 * @returns {'zh' | 'en'} The locale to render.
 */
export function pickLocale(language) {
  return /^zh\b/i.test(String(language ?? '')) ? 'zh' : 'en'
}

/**
 * Build a translator over one locale.
 *
 * Falls back `locale → English → the key itself`, the same three-step order the
 * host half uses: a missing translation shows English rather than a blank, and
 * a key missing from both shows the key, which is a bug report rather than a
 * hole in the panel.
 *
 * @param {'zh' | 'en'} locale - Which dictionary to prefer.
 * @returns {(key: string, params?: Record<string, unknown>) => string} The translator.
 */
export function translator(locale) {
  const primary = DICTIONARIES[locale] ?? en
  return (key, params = {}) => {
    const template = primary[key] ?? en[key] ?? key
    return template.replace(/\{(\w+)\}/g, (whole, name) => (
      Object.hasOwn(params, name) ? String(params[name]) : whole
    ))
  }
}

/**
 * The translator for the browser's own UI language.
 *
 * @returns {(key: string, params?: Record<string, unknown>) => string} The translator.
 */
export function browserTranslator() {
  const language = globalThis.chrome?.i18n?.getUILanguage?.()
  return translator(pickLocale(language))
}

/**
 * A relative-time label, using the coarsest unit that still reads as recent.
 *
 * A session list is scanned, not read: the exact minute is noise, and the only
 * question a person asks of that column is "is this the thing I was just in".
 *
 * @param {(key: string, params?: Record<string, unknown>) => string} t - The translator.
 * @param {number} when - Epoch milliseconds.
 * @param {number} [now] - The reference time, for tests.
 * @returns {string} The label, or an empty string when there is no timestamp.
 */
export function relativeTime(t, when, now = Date.now()) {
  if (!Number.isFinite(when) || when <= 0) return ''
  const seconds = Math.max(0, Math.round((now - when) / 1000))
  if (seconds < 90) return t('time.now')
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t('time.minutes', { count: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t('time.hours', { count: hours })
  return t('time.days', { count: Math.round(hours / 24) })
}
