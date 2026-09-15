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

  // The history view.
  'history.empty': '还没有会话',
  'tabs.title': '受控标签页',
  'tabs.none': '没有受控标签页',
  'tabs.untitled': '（无标题）',

  // Session rows.
  'session.untitled': '未命名会话',
  'session.new': '新会话',
  'session.running': '正在运行',

  // The composer and its attachments.
  'composer.placeholder': '问点什么…',
  'context.tab': '当前标签页',
  'context.selection': '选中内容',
  // Shown on the attachment chip only while the extension is not attached to the
  // harness, because in that state the chip would otherwise promise a context
  // the send cannot actually carry.
  'context.offline': '未连接',

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
  // The host answers every send with what it staged and what it refused. A
  // refusal used to be invisible: the chip promised an attachment, the message
  // went out without it, and nothing said so.
  'error.attachmentRefused': '有附件没被接受：{reason}',
  // A page whose reporter cannot be reached looks exactly like a page with
  // nothing selected, and the user's question — "will this be attached?" — has
  // opposite answers in the two cases. Reloading installs a fresh reporter.
  'error.reportStale': '请刷新页面',
  'error.notCopied': '复制失败',
  'error.hostDown': '连不上 dsh web',
  'error.notAnswered': '没能作答：{reason}',
  // The one place the panel asks instead of reporting. The harness's other
  // answerer is the graphical client, so this card is often the only thing
  // standing between a running turn and one that waits forever.
  'approval.asking': '需要你确认',
  'approval.wants': '要用 {tool}',
  'approval.aTool': '一个工具',
  'approval.allow': '允许一次',
  'approval.reject': '拒绝',
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

  'history.empty': 'No chats yet',
  'tabs.title': 'Controlled tabs',
  'tabs.none': 'No controlled tabs',
  'tabs.untitled': '(untitled)',

  'session.untitled': 'Untitled chat',
  'session.new': 'New chat',
  'session.running': 'Working',

  'composer.placeholder': 'Ask anything…',
  'context.tab': 'this tab',
  'context.selection': 'the selection',
  'context.offline': 'Offline',

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
  'error.attachmentRefused': 'Attachment refused: {reason}',
  'error.reportStale': 'Reload the page',
  'error.notCopied': 'Could not copy',
  'error.hostDown': 'dsh web is not running',
  'error.notAnswered': 'Could not answer: {reason}',
  'approval.asking': 'Needs your call',
  'approval.wants': 'Wants to use {tool}',
  'approval.aTool': 'a tool',
  'approval.allow': 'Allow once',
  'approval.reject': 'Reject',
})

/** Every dictionary, by locale tag. */
export const DICTIONARIES = Object.freeze({ zh, en })

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
