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
  'action.find': '查找',
  'action.find.title': '在对话里查找',
  'action.find.prev': '上一个',
  'action.find.next': '下一个',
  'action.find.close': '关闭查找',
  'action.settings': '设置',
  'action.send': '发送',
  'action.send.title': '发送',
  'action.stop': '停止',
  'action.stop.title': '停下这一轮',
  'action.toBottom': '回到底部',
  'action.drop': '移除',
  'action.copy': '复制',
  'action.copied': '已复制',
  // The table scroller is the third focusable region, so it needs a name too.
  'table.region': '表格，可横向滚动',
  // The two scrolling regions, which are focusable and therefore need a name.
  'stage.transcript': '对话内容',
  'stage.history': '会话列表',

  // The history view.
  'history.empty': '还没有会话',
  // The bucket for sessions whose directory is not a registered workspace. DSH's
  // own sidebar has the same bucket and names it 「未分组」, so this is its word
  // rather than one of ours.
  'history.ungrouped': '未分组',
  // The section that answers a different question from the list above it: not
  // "which chat is this" but "which chat was that thing said in".
  'history.inConversations': '对话正文里提到',
  // Shown when the search could not run. Deliberately not the same sentence as
  // 「无结果」: an absent index and a genuine miss draw the same empty list, and
  // only one of them means the word is nowhere in the reader's history.
  'history.noSearch': '这个配置没有会话检索',
  'tabs.title': '受控标签页',
  'tabs.none': '没有受控标签页',
  'tabs.untitled': '（无标题）',

  // Session rows.
  'session.untitled': '未命名会话',
  'session.new': '新会话',
  'session.running': '正在运行',
  // A workspace with a hundred sessions is a workspace nobody scrolls to the
  // end of. Both sentences are the harness's own, from its session list.
  'sessions.expand': '展开其余 {count} 个会话',
  'sessions.collapse': '收起',

  // The composer and its attachments.
  'composer.placeholder': '问点什么…',
  // Shown instead of the invitation when there is no session to send to. The send
  // button is disabled in that state, and the field used to keep asking for a
  // question anyway — a reader could type a sentence and watch it go nowhere.
  'composer.needsSession': '先新建一个会话…',
  // And the one for a host that is not answering. Creating a session cannot work
  // either in that state, so the field must not send the reader to do it.
  'composer.needsHost': 'dsh web 没在运行…',
  // How full the context is, beside the composer. Two forms because the log does
  // not always state a window size: with one, the pair; without it, the count
  // alone, which is a smaller truth rather than a made-up percentage.
  'composer.occupancy': '{used} / {window}',
  // The same reading with no denominator — a *different* string rather than the
  // pair template with an empty second half. Substituting `''` into `{used} / {window}`
  // leaves a trailing slash: measured on screen as `461k /`, which reads as a
  // label that failed to finish rather than as a count.
  'composer.occupancy.count': '{used} tokens',
  'composer.occupancy.title': '本轮上下文 {used} / {window} tokens',
  'composer.occupancy.countOnly': '本轮上下文 {used} tokens，无窗口记录',
  // The way back into a conversation longer than one window. A long session is
  // not unusual — one of the author's own is 6969 rows, of which the panel used
  // to show the last 60 with no indication that anything was missing.
  'transcript.earlier': '更早的内容',
  'transcript.loading': '加载中…',
  // Searching the whole conversation rather than the window on screen. The
  // count says which match the reader is on, because that is the answer to the
  // question they asked: "is this the only one?".
  'find.placeholder': '查找…',
  // 同一个框在会话列表里筛的是标题，说清楚比让读者猜好。
  'find.placeholder.sessions': '按标题查找…',
  'find.count': '{position}/{count}{more}',
  'find.none': '无结果',
  'find.searching': '查找中…',
  'find.more': '+',
  // Over the session list the count is sessions rather than matches, so it is
  // its own word: "{count} 个会话" answers "how much is left" without implying
  // there is a first-of-several to step through.
  'find.sessions': '{count} 个会话',
  'context.tab': '当前标签页',
  'context.selection': '选中内容',
  // Shown on the attachment chip only while the extension is not attached to the
  // harness, because in that state the chip would otherwise promise a context
  // the send cannot actually carry.
  //
  // It names what is offline rather than the whole panel: measured on a fresh
  // install with no token, the chat routes still answer (only the websocket needs
  // the token), so the transcript renders and the composer works. 「未连接」 alone
  // read as "this panel is broken".
  'context.offline': '浏览器工具未连接',
  // The way out of that state, on the same chip. A label, not a sentence — the
  // panel's rule is that a dictionary value names a thing or an action, and only
  // the blocked pane may explain (see `panel-i18n.test.js`). This chip is not
  // that pane: the conversation is fine and one control is missing.
  'context.offlineAction': '设置',
  // The toolbar badge's tooltip, shown while the debugger is attached to that
  // tab. The badge dot itself is a glyph and needs no words; this is what a
  // person reads when they hover it to ask "what is that dot?".
  'action.controlled': 'DSH 正在操作这个标签页',
  // Shown while a question is waiting and the panel is closed — the only place
  // it can appear, since a shut panel is not running and cannot say anything.
  'action.awaiting': 'DSH 等你批准',
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
  // Spoken aloud when an answer finishes. Not one line by construction: the
  // opening is the answer's own first sentence, so it carries the answer's
  // punctuation. See the exempt list in `panel-i18n.test.js`.
  'row.answerAnnounce': '{opening}（其余 {rest} 字）',
  // Compaction. The count is the range the checkpoint replaced, so the row can
  // say how much of the conversation it stands in for.
  'row.compaction': '上下文已压缩',
  'row.compaction.count': '{count} 条历史记录',
  // What started a turn the reader did not start. Their own words are the
  // question; these name everything else, mirroring the harness's own wording
  // (`message.trigger.*`) so the same event reads the same way in both UIs.
  // Agreement matters here: a reader who sees 「收到团队消息」 in the harness and
  // something different in the panel would be looking at two names for one event.
  'trigger.request': '收到执行请求',
  'trigger.goal': '继续执行目标',
  'trigger.agent': '收到任务消息',
  'trigger.team': '收到团队消息',
  'trigger.subagent': '子任务状态更新',
  'trigger.github': '收到 GitHub 事件',
  'trigger.webhook': '收到外部事件',
  'trigger.schedule': '定时任务',
  'trigger.job': '后台任务状态更新',
  'trigger.plugin': '插件状态更新',
  'trigger.skill': '技能目录已更新',
  'trigger.other': '收到一条消息',
  'row.compaction.unknown': '更早的内容已折叠',

  // A picture the reader sent. The alt text is used only when the message
  // carries no filename of its own.
  'image.alt': '图片',
  'image.open': '点击查看原图',
  'image.unavailable': '图片无法显示',

  // Relative time, for a session row's trailing label.
  'time.now': '刚刚',
  'time.minutes': '{count} 分钟前',
  'time.hours': '{count} 小时前',
  'time.days': '{count} 天前',

  // Drawn between messages when a conversation crosses midnight. The panel holds
  // sixty rows of a log that can span days, so "this was yesterday" is a fact the
  // reader cannot get from the scroll position.
  'day.today': '今天',
  'day.yesterday': '昨天',

  // Only ever shown when something failed.
  'error.generic': '出错了：{reason}',
  'error.notSent': '未发送：{reason}',
  // Stays on screen until the reader acts, so it is a label rather than a
  // sentence: the dictionary is capped at six words and has no full stops.
  'send.failed': '没发出去（{reason}），文字还在',
  'error.notStopped': '没能停下：{reason}',
  'error.loadFailed': '读取失败：{error}',
  // Standing, not transient: a read that failed stays failed until one works.
  'read.failed': '这段对话没能读到（{reason}），下面是上次读到的内容',
  'error.startedFailed': '面板启动失败：{error}',
  'error.noSession': '先选择一个会话',
  // The panel and the host ship separately: reloading the extension is one
  // click, replacing the host's code means restarting `dsh web`. When the two
  // disagree, every route answers a shape the panel does not understand, which
  // would otherwise read as "no sessions" and a bare 400.
  'error.restartHost': '请重启 dsh web（宿主是旧版本）',
  // The reason a request failed because nothing answered on the port. It is its
  // own key rather than reusing the offline chip's label: that one now names the
  // browser tools, and a switch that could not be sent failed because the whole
  // host was unreachable — a different fact with a different remedy.
  'error.unreachable': '连不上 dsh web',
  // The blocked surface: a title, what to do, and the button that does it.
  // Two states share it — no host, and no sessions. The second one is the first
  // thing a new reader sees: measured at 380x720 the transcript was 559px of
  // nothing, the composer still said 「问点什么…」, and the send button was
  // disabled with nothing on screen saying why.
  'blocked.hostTitle': '连不上 dsh web',
  'blocked.hostBody': '先启动 dsh web，再重试。',
  'blocked.retry': '重试',
  'blocked.retrying': '重试中…',
  'blocked.emptyTitle': '还没有会话',
  'blocked.emptyBody': '新建一个，就可以开始问了。',
  'blocked.emptyAction': '新建会话',
  'blocked.creating': '新建中…',
  // The third state of the same surface. Without it a host running older code
  // lands in the empty state above: the panel offers 「新建会话」 and then refuses
  // to create one, so the reader presses a button that answers with nothing.
  // The title says what is wrong and the body says the one thing that fixes it —
  // restarting is the reader's move, so the action is gone rather than disabled.
  'blocked.staleTitle': 'dsh web 需要重启',
  'blocked.staleBody': '面板比宿主新：重启 dsh web 之后就能用。',
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
  // The recourse a failed turn offers. Not a retry: the host cannot re-run a
  // turn, so a button that said 「重试」 would promise something no code path can
  // deliver. This one puts the question back in the box and lets the reader
  // decide — the only action that neither writes to the conversation behind
  // their back nor pretends to know whether the original message carried
  // attachments.
  'failure.putBack': '把问题放回输入框',
  'failure.putBack.title': '问题回到输入框，你可以改完再发',
  // The one place the panel asks instead of reporting. The harness's other
  // answerer is the graphical client, so this card is often the only thing
  // standing between a running turn and one that waits forever.
  'approval.asking': '需要你确认',
  'approval.wants': '要用 {tool}',
  'approval.wantsSite': '要在 {site} 上使用 {tool}',
  'approval.sensitive': '这一步会改动页面或花钱，不只是读',
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
  'action.find': 'Find',
  'action.find.title': 'Find in this conversation',
  'action.find.prev': 'Previous match',
  'action.find.next': 'Next match',
  'action.find.close': 'Close find',
  'action.settings': 'Settings',
  'action.send': 'Send',
  'action.send.title': 'Send',
  'action.stop': 'Stop',
  'action.stop.title': 'Stop this turn',
  'action.toBottom': 'Jump to latest',
  'action.drop': 'Remove',
  'action.copy': 'Copy',
  'table.region': 'Table, scrolls sideways',
  'action.copied': 'Copied',
  'stage.transcript': 'Conversation',
  'stage.history': 'Chats',

  'history.empty': 'No chats yet',
  'history.ungrouped': 'Ungrouped',
  'history.inConversations': 'Mentioned in conversations',
  // Not the same sentence as "no results": an absent index and a genuine miss
  // draw the same empty list, and only one of them means the word is nowhere.
  'history.noSearch': 'No session search in this profile',
  'tabs.title': 'Controlled tabs',
  'tabs.none': 'No controlled tabs',
  'tabs.untitled': '(untitled)',

  'session.untitled': 'Untitled chat',
  'session.new': 'New chat',
  'session.running': 'Working',
  'sessions.expand': 'Show {count} more sessions',
  'sessions.collapse': 'Show less',

  'composer.placeholder': 'Ask anything…',
  'composer.needsSession': 'Create a chat first…',
  'composer.needsHost': 'dsh web is not running…',
  'composer.occupancy': '{used} / {window}',
  'composer.occupancy.count': '{used} tokens',
  // Titles, so they are held to the same short-string rule as every other entry:
  // the exact numbers are the point, and a sentence in a tooltip is read once.
  'composer.occupancy.title': '{used} of {window} tokens',
  'composer.occupancy.countOnly': '{used} tokens, no window recorded',
  'transcript.earlier': 'Earlier messages',
  'transcript.loading': 'Loading…',
  'find.placeholder': 'Find…',
  'find.placeholder.sessions': 'Find by title…',
  'find.count': '{position}/{count}{more}',
  'find.none': 'No results',
  'find.searching': 'Searching…',
  'find.more': '+',
  'find.sessions': '{count} sessions',
  'context.tab': 'this tab',
  'context.selection': 'the selection',
  'context.offline': 'Browser tools offline',
  'context.offlineAction': 'Settings',
  'action.controlled': 'DSH is operating this tab',
  'action.awaiting': 'DSH needs your approval',
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
  'row.answerAnnounce': '{opening} ({rest} more characters)',
  'row.compaction': 'Context compacted',
  'row.compaction.count': '{count} history items',
  'trigger.request': 'Execution requested',
  'trigger.goal': 'Continuing goal',
  'trigger.agent': 'Task message received',
  'trigger.team': 'Team message received',
  'trigger.subagent': 'Subtask status updated',
  'trigger.github': 'GitHub event received',
  'trigger.webhook': 'External event received',
  'trigger.schedule': 'Scheduled task',
  'trigger.job': 'Background task updated',
  'trigger.plugin': 'Plugin status updated',
  'trigger.skill': 'Skill catalog updated',
  'trigger.other': 'Message received',
  'row.compaction.unknown': 'Earlier content folded away',

  'image.alt': 'Image',
  'image.open': 'Click to open the original',
  'image.unavailable': 'Image unavailable',

  'time.now': 'just now',
  'time.minutes': '{count}m ago',
  'time.hours': '{count}h ago',
  'time.days': '{count}d ago',

  'day.today': 'Today',
  'day.yesterday': 'Yesterday',

  'error.generic': 'Something went wrong: {reason}',
  'error.notSent': 'Not sent: {reason}',
  'send.failed': 'Not sent ({reason}), text kept',
  'error.notStopped': 'Could not stop: {reason}',
  'error.loadFailed': 'Could not load: {error}',
  'read.failed': 'Showing older rows: {reason}',
  'error.startedFailed': 'Panel failed to start: {error}',
  'error.noSession': 'Pick a chat first',
  'error.restartHost': 'Restart dsh web (host is older)',
  'error.unreachable': 'Cannot reach dsh web',
  'blocked.hostTitle': 'dsh web is not running',
  'blocked.hostBody': 'Start dsh web, then retry.',
  'blocked.retry': 'Retry',
  'blocked.retrying': 'Retrying…',
  'blocked.emptyTitle': 'No chats yet',
  'blocked.emptyBody': 'Start one, and ask away.',
  'blocked.emptyAction': 'New chat',
  'blocked.creating': 'Starting…',
  'blocked.staleTitle': 'dsh web needs a restart',
  'blocked.staleBody': 'The panel is newer than the host. Restart dsh web and it will work.',
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
  // See the zh entry: this is not a retry, because the host cannot re-run a turn.
  'failure.putBack': 'Put the question back',
  'failure.putBack.title': 'Edit it before sending',
  'approval.asking': 'Needs your call',
  'approval.wants': 'Wants to use {tool}',
  'approval.wantsSite': 'Wants to use {tool} on {site}',
  'approval.sensitive': 'Changes the page or spends money',
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
    tokenHint: '通常留空即可：扩展会自己去 harness 取令牌。只有想手动指定时，才把令牌粘贴进来。',
    tokenShow: '显示',
    tokenHide: '隐藏',
    // The token is 64 hex characters, and pasting one is the step this page
    // exists for. Naming the expected shape is what turns "it did not work" into
    // "I pasted half of it" without a round trip to the harness.
    tokenShape: '令牌看起来是完整的（{length} 位十六进制）。',
    tokenShapeWrong: '令牌应当是 {length} 位十六进制字符，粘贴的不对。',
    // Automatic enrolment. Every failure names the one thing the person would
    // have to change, because the alternative — one "could not get the token"
    // for a stopped harness, a switched-off bridge and a broken answer — sends
    // them to check three things that are each already known here.
    tokenFetching: '正在从 harness 取令牌…',
    tokenFetched: '已从 harness 取到令牌。',
    tokenFetchNoHarness: '没有 harness 在 {port} 端口应答。先启动 dsh web（并确认端口一致），再点「连接」。',
    tokenFetchOff: '桥接在 DSH「设置 → 插件」里被关掉了，所以没有取令牌。想用就先在那里打开它。',
    tokenFetchMalformed: 'harness 应答了，但没有给出令牌。请手动粘贴一个。',
    autoPushLabel: '把每次划词自动同步进 DSH 上下文',
    autoPushHint: '默认关闭。关闭时由你从右键菜单决定送什么，所以只是划词去复制一段文字，永远不会进模型。',
    save: '连接',
    test: '测试连接',
    refetch: '重新取令牌',
    filesTitle: '文件上传',
    filesBody: '要让 DSH 通过页面上传文件，需要 Chrome 里一个本扩展自己无法授予的设置：打开 chrome://extensions，找到本扩展，点「详情」，打开「允许访问文件网址」。',
    controlTitle: '它怎样始终由你掌控',
    control1: '桥接只监听本机回环地址，扩展用令牌证明自己的身份。',
    control2: '每个新站点都需要你批准，DSH 才能读取或操作它。',
    control3: '提交表单、付款、删除会再问一次。',
    control4: '浏览历史永远不会被记成「已允许」——每次读取都要重新问。',
    control5: '页面内容除了送进你自己的 harness，不会发往任何地方。',
    noToken: '还没有令牌。点「连接」让扩展自己去 harness 取，或者手动粘贴一个。',
    connected: '已连接到 {port} 端口上的 harness。',
    cannotConnect: '连不上 {port} 端口。',
    checkIntro: '请检查：',
    check1: 'harness 在运行（dsh web），且端口与它的网址一致；',
    check2: '令牌是 harness 当前的那一个——点「重新取令牌」可以自动同步；',
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
    tokenHint: 'Usually leave this empty — the extension fetches the token from the harness itself. Fill it in only to set one by hand.',
    tokenShow: 'Show',
    tokenHide: 'Hide',
    tokenShape: 'The token looks complete ({length} hexadecimal characters).',
    tokenShapeWrong: 'A token is {length} hexadecimal characters — this is not one.',
    tokenFetching: 'Getting the token from the harness…',
    tokenFetched: 'The token came from the harness.',
    tokenFetchNoHarness: 'No harness answered on port {port}. Start dsh web (and check the port matches), then press Connect again.',
    tokenFetchOff: 'The bridge is switched off in DSH Settings → Plugins, so no token was requested. Turn it on there to use it.',
    tokenFetchMalformed: 'The harness answered without a token. Paste one by hand.',
    autoPushLabel: 'Sync every text selection into DSH context automatically',
    autoPushHint: 'Off by default. With it off, you choose what to send from the right-click menu, so merely highlighting text to copy it never reaches the model.',
    save: 'Connect',
    test: 'Test connection',
    refetch: 'Get the token again',
    filesTitle: 'File uploads',
    filesBody: 'To let DSH upload a file through a page, Chrome needs one setting this extension cannot grant for itself: open chrome://extensions, find this extension, choose Details, and turn on Allow access to file URLs.',
    controlTitle: 'How this stays under your control',
    control1: 'The bridge listens on loopback only, and this extension proves itself with a token.',
    control2: 'Every new site needs your approval before DSH may read or act on it.',
    control3: 'Submitting forms, purchasing, and deleting ask a second time.',
    control4: 'Browser history is never remembered as allowed — every read asks again.',
    control5: 'No page content is ever sent anywhere except to your own harness.',
    noToken: 'No token yet. Press Connect and the extension will get one from the harness, or paste one by hand.',
    connected: 'Connected to the harness on port {port}.',
    cannotConnect: 'Could not connect on port {port}.',
    checkIntro: 'Check that:',
    check1: 'the harness is running (dsh web) and the port matches its URL;',
    check2: 'the token is the harness\'s current one — "Get the token again" syncs it;',
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
 * Past a week, though, a count of days stops answering that question. "61 days
 * ago" is not a distance anyone computes — it is a date they want, and the
 * arithmetic to get there is work the label should have done. So this hands the
 * calendar the job at that point and prints the day itself.
 *
 * A week is the boundary because it is where the two readings cross: below it a
 * count is easier to compare against "am I in the middle of this", above it the
 * count is a number nobody converts. It also keeps the label short — dates with
 * a year are wider than anything the minutes branch ever prints.
 *
 * @param {(key: string, params?: Record<string, unknown>) => string} t - The translator.
 * @param {number} when - Epoch milliseconds.
 * @param {number} [now] - The reference time, for tests.
 * @param {'zh' | 'en'} [locale] - Which calendar conventions to print with.
 * @returns {string} The label, or an empty string when there is no timestamp.
 */
export function relativeTime(t, when, now = Date.now(), locale = 'en') {
  if (!Number.isFinite(when) || when <= 0) return ''
  const seconds = Math.max(0, Math.round((now - when) / 1000))
  if (seconds < 90) return t('time.now')
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t('time.minutes', { count: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t('time.hours', { count: hours })
  const days = Math.round(hours / 24)
  if (days < 7) return t('time.days', { count: days })
  return calendarDate(when, locale, now)
}

/**
 * The day a timestamp falls on, written the way its language writes days.
 *
 * The year appears only when it differs from the reference year. A session list
 * is mostly same-year, and repeating the year on every row spends the width the
 * session title needs to say the one thing that separates the rows from each
 * other. Across a year boundary the year is the fact, so it is shown.
 *
 * `Intl` rather than a hand-written format: the two languages disagree about
 * order, separator and whether the month is a number or a name, and this project
 * has no business re-deriving CLDR. Both environments that load this module —
 * the panel and the test runner — resolve `zh` and `en` identically (verified
 * across 18 format/output pairs), so the tests guard what the reader sees.
 *
 * @param {number} when - Epoch milliseconds.
 * @param {'zh' | 'en'} locale - Which conventions to print with.
 * @param {number} now - The reference time, for the year comparison.
 * @returns {string} The formatted day.
 */
function calendarDate(when, locale, now) {
  const sameYear = new Date(when).getFullYear() === new Date(now).getFullYear()
  return new Intl.DateTimeFormat(locale, {
    ...(sameYear ? {} : { year: 'numeric' }),
    month: 'short',
    day: 'numeric',
  }).format(when)
}

/**
 * Whether two instants fall on different calendar days, in the reader's zone.
 *
 * Compared by local calendar day rather than by elapsed hours, because that is
 * what the reader means by "yesterday". A conversation that runs from 23:50 to
 * 00:10 crosses a day boundary in twenty minutes; one that runs from 09:00 to
 * 20:00 does not cross one in eleven hours. An hour-based rule gets both of those
 * backwards, and the panel is meant to answer the reader's question, not the
 * clock's.
 *
 * @param {number | null} earlier - Epoch milliseconds of the earlier row.
 * @param {number | null} later - Epoch milliseconds of the later row.
 * @returns {boolean} True when a date separator belongs between them.
 */
export function crossedDay(earlier, later) {
  if (!Number.isFinite(earlier) || !Number.isFinite(later)) return false
  const before = new Date(earlier)
  const after = new Date(later)
  return before.getFullYear() !== after.getFullYear()
    || before.getMonth() !== after.getMonth()
    || before.getDate() !== after.getDate()
}

/**
 * The label for a day separator: "Today", "Yesterday", or a written date.
 *
 * The two words exist because they are the two days a reader can name without
 * looking anything up, and the panel is mostly read on the day it was written.
 * Beyond that the date is the honest answer, and it is the same `calendarDate`
 * the session list already prints, so one reader sees one convention.
 *
 * @param {number} when - Epoch milliseconds of the row that opens the day.
 * @param {number} now - The reference time.
 * @param {'zh' | 'en'} locale - Which conventions to print with.
 * @param {(key: string, values?: object) => string} t - The translator.
 * @returns {string} The separator's label.
 */
export function dayLabel(when, now, locale, t) {
  const today = new Date(now)
  const day = new Date(when)
  const sameDay = today.getFullYear() === day.getFullYear()
    && today.getMonth() === day.getMonth()
    && today.getDate() === day.getDate()
  if (sameDay) return t('day.today')
  const yesterday = new Date(now - 24 * 60 * 60 * 1000)
  const isYesterday = yesterday.getFullYear() === day.getFullYear()
    && yesterday.getMonth() === day.getMonth()
    && yesterday.getDate() === day.getDate()
  if (isYesterday) return t('day.yesterday')
  return calendarDate(when, locale, now)
}
