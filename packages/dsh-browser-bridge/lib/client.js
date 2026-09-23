/**
 * Browser bridge — browser half.
 *
 * Three contributions, all read-only against the host:
 *
 *   - the **settings card**, registered into `settings.plugin.item` under this
 *     package's own namespace key. That slot is how a plugin outside the harness
 *     repository contributes configuration UI: the host registers the namespace,
 *     the browser registers a card under the same key, and the Plugins tab pairs
 *     them. Registering the namespace alone produces no card, which is why one
 *     was missing.
 *   - the **composer chips** showing what the user staged as context, so it can
 *     be removed before anything reaches the model.
 *   - the **footer status action** with a small diagnostic panel.
 *
 * Written without a build step, as the harness requires of client bundles: the
 * `__ModuleLoader__.load` wrapper below, `React.createElement` instead of JSX,
 * and only seed-table modules required. `react` is the one dependency, provided
 * by the shell rather than bundled here, so this file can be edited in place on
 * a running harness.
 *
 * @module dsh-browser-bridge/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-browser-bridge',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const react = require('react')

    /**
     * The shared primitives a client plugin may use, when present.
     *
     * Guarded because a failed `require` here would take the whole bundle down
     * before any contribution registers — and this package is loaded by the
     * shell, not by us, so its presence is the shell's decision rather than a
     * build-time fact. The chevron falls back to a text glyph when absent; the
     * card still works, it just draws its own arrow.
     */
    let primitives
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      primitives = undefined
    }
    const IconChevron = primitives?.IconChevronDownOutline14

    /** Services this plugin needs before it can contribute. */
    const inject = ['slots', 'locale']

    /** The settings namespace this card edits; must match the host's registration. */
    const NAMESPACE = 'browser-bridge'

    /**
     * The card's own copy.
     *
     * A card supplies its own strings: the built-in cards read from a dictionary
     * compiled into the harness, and a plugin outside that repository has no
     * entry there. Without this the card renders the raw namespace and English
     * field labels inside an otherwise Chinese interface — which is what
     * happened.
     *
     * Simplified Chinese is the key-set source of truth, as elsewhere in the
     * harness; English mirrors it key for key.
     */
    const ZH = {
      title: '浏览器桥接',
      description: '让本会话读取并操作你已登录的 Chrome，按站点审批。',
      bridge: '桥接',
      extension: '扩展',
      connections: '本轮连接次数',
      inFlight: '在途调用',
      originRules: '站点规则',
      namespace: '设置命名空间',
      token: '扩展令牌',
      copyToken: '复制令牌',
      copied: '已复制',
      copyFailed: '复制失败',
      registered: '已注册',
      notRegistered: '未注册',
      enabled: '已启用',
      disabled: '已停用',
      connected: '已连接',
      notConnected: '未连接',
      unreachable: '无法访问',
      unknown: '未知',
      lastError: '上次错误',
      limitation: '限制',
      note: '把令牌和端口（本页 URL 里的数字）一起填进 DSH Browser Bridge 扩展的选项页。其余设置——站点规则、Developer mode、附件上限——都在 settings.yaml 的 browser-bridge 键下，点本页右上角按钮打开。',
      connectHint: '连接方法：把 extension/ 作为「已解压的扩展程序」载入 Chrome，填入令牌后点保存并连接。',
      warning: '这个桥接能读取并操作你已登录的任何站点。它会在访问新站点前询问、在提交或支付前再问一次，并且永远不会为浏览历史记住授权。',
      expand: '展开',
      collapse: '收起',
      browserUnavailable: '浏览器：不可用',
      browserConnected: '浏览器：已连接',
      browserNotConnected: '浏览器：未连接',
      statusPanel: '浏览器桥接状态',
      removeChip: '从上下文移除',
      removeChipHint: '发送前移除——什么都还没发出去',
      chipSelection: '选中内容',
      chipPage: '整页',
      chipTab: '标签页',
      chipChars: '{count} 字',
    }

    /** English copy, key-identical to the Chinese source of truth. */
    const EN = {
      title: 'Browser bridge',
      description: 'Let this session read and operate your signed-in Chrome, with per-site approval.',
      bridge: 'Bridge',
      extension: 'Extension',
      connections: 'Connections this run',
      inFlight: 'In-flight calls',
      originRules: 'Origin rules',
      namespace: 'Settings namespace',
      token: 'Extension token',
      copyToken: 'Copy token',
      copied: 'Copied',
      copyFailed: 'Copy failed',
      registered: 'registered',
      notRegistered: 'not registered',
      enabled: 'enabled',
      disabled: 'disabled',
      connected: 'connected',
      notConnected: 'not connected',
      unreachable: 'unreachable',
      unknown: 'unknown',
      lastError: 'Last error',
      limitation: 'Limitation',
      note: 'Paste the token into the DSH Browser Bridge extension options together with the harness port (the number in this page’s URL). Everything else — origin rules, Developer mode, attachment limits — lives in settings.yaml under the browser-bridge key; open it with the button at the top of this page.',
      connectHint: 'To connect: load extension/ as an unpacked extension in Chrome, paste the token there, and press Save and connect.',
      warning: 'This bridge can read and operate any site you are signed in to. It asks before each new site, asks again before submitting or spending, and never remembers an approval for browser history.',
      expand: 'Show settings',
      collapse: 'Hide settings',
      browserUnavailable: 'browser: unavailable',
      browserConnected: 'browser: connected',
      browserNotConnected: 'browser: not connected',
      statusPanel: 'Browser bridge status',
      removeChip: 'Remove from context',
      removeChipHint: 'Remove before sending — nothing has been sent yet',
      chipSelection: 'selected text',
      chipPage: 'page',
      chipTab: 'tab',
      chipChars: '{count} chars',
    }

    /** Locale namespace owned by this plugin. */
    const LOCALE_NS = 'browser-bridge'

    /**
     * Build a translator for one contribution.
     *
     * A slot only receives `t` when its registration declares `locale`, and a
     * missing dictionary entry must never render as a bare key — so this falls
     * back to the English copy and then to the key itself.
     *
     * @param {{ t?: (key: string) => string }} props - Slot props.
     * @returns {(key: string) => string} The translator.
     */
    function makeTranslator(props) {
      return (key) => {
        if (typeof props?.t === 'function') {
          const value = props.t(key)
          if (typeof value === 'string' && value.length > 0 && value !== key) return value
        }
        return EN[key] ?? key
      }
    }

    /** Poll interval for the read-only views, in milliseconds. */
    const POLL_MS = 3000

    const CSS = `
.dshbb-root{position:relative;display:inline-flex;align-items:center;gap:6px}
.dshbb-trigger{display:inline-flex;align-items:center;gap:6px;min-height:28px;padding:3px 6px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:pointer}
.dshbb-trigger:hover,.dshbb-trigger:focus-visible{color:var(--dsw-alias-label-primary)}
.dshbb-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}
.dshbb-dot[data-state="connected"]{background:#2f9e63}
.dshbb-dot[data-state="disconnected"]{background:#d1453b}
.dshbb-panel{position:absolute;bottom:calc(100% + 6px);left:0;z-index:200;width:min(330px,calc(100vw - 24px));box-sizing:border-box;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-specific-menu);box-shadow:var(--dsw-elevation-prominent);font-size:12px;line-height:1.5}
.dshbb-row{display:flex;gap:8px;align-items:baseline;padding:4px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dshbb-row:last-child{border-bottom:0}
.dshbb-muted{color:var(--dsw-alias-label-tertiary)}
.dshbb-grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshbb-btn{padding:4px 8px;min-height:24px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:inherit;font:inherit;cursor:pointer;flex:none}
.dshbb-chips{display:flex;flex-wrap:wrap;gap:6px;padding:2px 0}
.dshbb-chip{display:inline-flex;align-items:center;gap:6px;max-width:min(340px,calc(100vw - 24px));padding:3px 4px 3px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-fill-l2);font-size:12px;line-height:18px}
.dshbb-chip-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshbb-chip-x{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;margin:-3px -2px -3px 0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1;cursor:pointer;flex:none}
.dshbb-chip-x:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-fill-l1)}
.dshbb-code{font-family:var(--dsw-font-mono);font-size:11px;word-break:break-all}
/* Card shell and field rows mirror the harness's own PluginCard and fields
   stylesheets token for token. They are copied rather than imported because both
   are internal to dsh-client-ui-settings-plugins and not exported; matching the
   tokens is what makes a contributed card sit in the same list without looking
   foreign. Reference: PluginCard.module.css and fields.module.css. */
.dshbb-card{list-style:none;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;transition:border-color .16s,background .16s}
.dshbb-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.dshbb-card-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.dshbb-card-header{appearance:none;display:flex;align-items:center;gap:12px;width:100%;padding:14px 16px;border:0;border-radius:12px;background:0 0;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dshbb-card-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dshbb-card-headtext{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}
.dshbb-card-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.dshbb-card-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
/* Secondary, which is what the host uses for the majority of its disclosure
   chevrons (18 rules named chevron/expand are secondary, 13 tertiary). The card
   description above stays tertiary, matching the host's own cardDesc — but a
   chevron is the affordance that opens the card, so it belongs with the controls. */
.dshbb-card-chevron{flex:none;color:var(--dsw-alias-label-secondary);transition:transform .16s}
.dshbb-card-chevron-open{transform:rotate(180deg)}
.dshbb-card-body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
/* Fields are a vertical stack in the harness, not label/value columns. */
.dshbb-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}
.dshbb-field+.dshbb-field{border-top:.5px solid var(--dsw-alias-border-l2)}
.dshbb-field-head{display:flex;align-items:center;gap:8px}
.dshbb-field-label{min-width:0;flex:1;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}
/* The value half is the data: the enabled state, the connection state, and the
   token itself. It used to be label-tertiary, which measured 3.71:1 against the
   card's white in the light theme — under the 4.5:1 that 12px text needs, and the
   token is a 64-character string the reader has to compare against the extension
   options. Both of this file's surfaces now agree: the popover's .dshbb-line-value
   already used label-primary, and the host's own settings rows do the same
   (entryValue and value in dsh-client-ui-settings-plugin-inventory and
   dsh-client-ui-theme). The description above stays tertiary on purpose: the host
   paints its own card description the same way (.cardDesc, 13px, tertiary), so a
   heavier one here would stand out from every sibling card rather than be read. */
.dshbb-field-value{min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;word-break:break-word}
/* The status popover keeps the compact row shape: it is a small panel, not a
   settings card, and twelve-pixel padding per row would make it unwieldy. */
.dshbb-line{display:flex;gap:10px;align-items:baseline;padding:5px 0}
.dshbb-line-label{flex:none;min-width:110px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dshbb-line-value{min-width:0;color:var(--dsw-alias-label-primary);font-size:12px;word-break:break-word}
/* The one manual step in the whole product. It used to be label-tertiary, which
   measures 3.71:1 in the light theme; the host's own instructional copy at this
   size uses secondary (its guideNote and help rules), and reading this paragraph
   is what makes the extension work at all. */
.dshbb-note{margin:8px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55}
.dshbb-note code{font-family:var(--dsw-font-mono);font-size:11.5px}
.dshbb-warn{border-left:3px solid #d9971f;padding-left:10px;margin:10px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55}
`

    /**
     * Install the plugin stylesheet once.
     * @returns {void}
     */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      const id = 'dsh-browser-bridge/styles'
      if (document.querySelector(`style[data-plugin-css="${id}"]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-browser-bridge'
      tag.dataset.pluginCss = id
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /**
     * Fetch the bridge's read-only health payload.
     * @returns {Promise<object | undefined>} The payload, when reachable.
     */
    async function fetchHealth() {
      try {
        const response = await fetch('/browser-bridge/health', { cache: 'no-store' })
        if (!response.ok) return undefined
        return await response.json()
      } catch {
        return undefined
      }
    }

    /**
     * Fetch the bridge token, for the copy affordance.
     * @returns {Promise<string>} The token, or an empty string when unavailable.
     */
    async function fetchToken() {
      try {
        const response = await fetch('/api/browser-bridge/token', { cache: 'no-store' })
        if (!response.ok) return ''
        const payload = await response.json()
        return typeof payload?.token === 'string' ? payload.token : ''
      } catch {
        return ''
      }
    }

    /**
     * Fetch the staged context attachments for one session.
     * @param {string} sessionId - The session whose attachments to read.
     * @returns {Promise<object[]>} The attachments.
     */
    async function fetchAttachments(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return []
      try {
        const response = await fetch(`/browser-bridge/context?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
        if (!response.ok) return []
        const payload = await response.json()
        return Array.isArray(payload?.attachments) ? payload.attachments : []
      } catch {
        return []
      }
    }

    /**
     * Remove one staged attachment on the host.
     *
     * Goes through the host rather than only dropping it from local state: a chip
     * that disappears on screen but is still queued would attach to the next
     * message, which is exactly the surprise the chip exists to prevent.
     *
     * @param {string} sessionId - The session holding the attachment.
     * @param {string} attachmentId - The attachment to remove.
     * @returns {Promise<boolean>} Whether the host removed it.
     */
    async function removeAttachment(sessionId, attachmentId) {
      try {
        const response = await fetch(
          `/browser-bridge/context?sessionId=${encodeURIComponent(sessionId)}&attachmentId=${encodeURIComponent(attachmentId)}`,
          { method: 'DELETE', cache: 'no-store' },
        )
        if (!response.ok) return false
        const payload = await response.json()
        return payload?.removed === true
      } catch {
        return false
      }
    }

    /**
     * Poll a reader on an interval, ignoring a superseded run.
     *
     * @param {() => Promise<unknown>} read - The reader.
     * @param {(value: unknown) => void} apply - Applies the value.
     * @param {unknown[]} deps - Effect dependencies.
     * @returns {void}
     */
    function usePolled(read, apply, deps) {
      react.useEffect(() => {
        let cancelled = false
        /**
         * Read once unless this effect was superseded.
         * @returns {Promise<void>} Resolves after the state update.
         */
        const tick = async () => {
          const value = await read()
          if (!cancelled) apply(value)
        }
        tick()
        const timer = setInterval(tick, POLL_MS)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller owns the dependency list
      }, deps)
    }

    /**
     * One line describing an attachment.
     *
     * The host owns the `kind` and the character count; only the words around
     * them are ours, and they are translated — a chip reading
     * `github.com · selected text · 1234 chars` sat in Chinese and English
     * interfaces alike before this.
     *
     * @param {object} attachment - The attachment row.
     * @param {(key: string) => string} translate - The locale translator.
     * @returns {string} The label.
     */
    function chipLabel(attachment, translate) {
      // A label names a *site*, so the scheme is stripped: `origin` holds a full
      // origin (`https://github.com`) while the chip wants `github.com`. The
      // host's own `describeAttachment` in `context.js` does the same thing for
      // the same reason, and the two must agree — the chip is the compact
      // rendering of a record that describer already names.
      const hostOf = (value) => {
        if (typeof value !== 'string' || value.length === 0) return ''
        try {
          return new URL(value).host
        } catch {
          return value
        }
      }
      let host = hostOf(attachment.origin) || hostOf(attachment.url)
      const kind = attachment.kind === 'selection'
        ? translate('chipSelection')
        : attachment.kind === 'page' ? translate('chipPage') : translate('chipTab')
      const count = attachment.chars > 0 ? ` · ${translate('chipChars').replace('{count}', String(attachment.chars))}` : ''
      return `${host.length > 0 ? host : translate('chipPage')} · ${kind}${count}`
    }

    /**
     * The composer chips: what is staged, and how to drop it.
     *
     * Renders nothing at all when nothing is staged, so a session that never
     * touches the browser grows no furniture.
     *
     * @param {object} props - Slot props supplied by the conversation surface.
     * @returns {unknown} The rendered element, or null.
     */
    function ContextChips(props) {
      const sessionId = props?.sessionId ?? props?.session?.id ?? ''
      const [staged, setStaged] = react.useState([])
      usePolled(() => fetchAttachments(sessionId), setStaged, [sessionId])
      const translate = makeTranslator(props)

      if (!Array.isArray(staged) || staged.length === 0) return null

      return react.createElement(
        'div',
        { className: 'dshbb-chips' },
        ...staged.map((attachment) => react.createElement(
          'span',
          { key: attachment.id, className: 'dshbb-chip', title: attachment.preview ?? '' },
          react.createElement('span', { className: 'dshbb-chip-text' }, chipLabel(attachment, translate)),
          react.createElement(
            'button',
            {
              type: 'button',
              className: 'dshbb-chip-x',
              'aria-label': `${translate('removeChip')}: ${chipLabel(attachment, translate)}`,
              title: translate('removeChipHint'),
              onClick: async () => {
                const removed = await removeAttachment(sessionId, attachment.id)
                // On failure the chip stays: a stale chip that is still queued is
                // a smaller problem than a hidden one that still attaches.
                if (removed) setStaged((current) => current.filter((row) => row.id !== attachment.id))
              },
            },
            '×',
          ),
        )),
      )
    }

    /**
     * One labelled value.
     *
     * Two shapes, because the harness uses two: a settings-card field is a
     * vertical stack (label above, value below, `.5px` separator between
     * siblings — see `fields.module.css`), while the status popover is a small
     * panel where that much padding per row would make it unwieldy.
     *
     * @param {{ label: string, value: unknown, mono?: boolean, variant?: 'field' | 'line' }} props - The row.
     * @returns {unknown} The rendered row.
     */
    function Field(props) {
      const line = props.variant === 'line'
      const rowClass = line ? 'dshbb-line' : 'dshbb-field'
      const labelClass = line ? 'dshbb-line-label' : 'dshbb-field-label'
      const valueClass = [
        line ? 'dshbb-line-value' : 'dshbb-field-value',
        props.mono === true ? 'dshbb-code' : undefined,
      ].filter((name) => name !== undefined).join(' ')

      return react.createElement(
        'div',
        { className: rowClass },
        line
          // The compact shape keeps the label and value on one baseline.
          ? [
            react.createElement('span', { key: 'label', className: labelClass }, props.label),
            react.createElement('span', { key: 'value', className: valueClass }, String(props.value ?? '—')),
          ]
          // The card shape has room for the label to own its own line, which is
          // what the harness's own fields do.
          : [
            react.createElement(
              'span',
              { key: 'head', className: 'dshbb-field-head' },
              react.createElement('span', { className: labelClass }, props.label),
            ),
            react.createElement('span', { key: 'value', className: valueClass }, String(props.value ?? '—')),
          ],
      )
    }

    /**
     * A copy-to-clipboard button that reports what it did.
     * @param {{ text: () => Promise<string>, label: string, doneLabel: string, failedLabel?: string }} props - The button.
     * @returns {unknown} The rendered button.
     */
    function CopyButton(props) {
      const [state, setState] = react.useState('idle')
      return react.createElement(
        'button',
        {
          type: 'button',
          className: 'dshbb-btn',
          onClick: async () => {
            const text = await props.text()
            if (text.length === 0) {
              setState('failed')
              return
            }
            try {
              if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
                await navigator.clipboard.writeText(text)
                setState('copied')
                setTimeout(() => setState('idle'), 2500)
                return
              }
            } catch {
              // Falling through reports the failure below.
            }
            setState('failed')
          },
        },
        state === 'copied' ? props.doneLabel : state === 'failed' ? (props.failedLabel ?? 'Copy failed') : props.label,
      )
    }

    /**
     * The settings card.
     *
     * Registered under this package's own namespace key, which is how the
     * Plugins tab pairs it with the host's registration. It shows the live
     * connection state and the token — the two things a person comes here for.
     * The rule and limit settings are edited in `settings.yaml` through the gear
     * button at the top of the page, so this card adds no second write path that
     * could drift from the settings service.
     *
     * The collapsible shell is built here rather than reused: the built-in
     * `PluginCard` component is internal to the settings package and not
     * exported, so a contributed card matches the list by rendering the same
     * shape — a disclosure whose header carries the name and description.
     *
     * @param {{ t?: (key: string, params?: Record<string, unknown>) => string }} props - Locale props from the slot.
     * @returns {unknown} The rendered card.
     */
    function BridgeCard(props) {
      const [open, setOpen] = react.useState(false)
      const [health, setHealth] = react.useState(undefined)
      const [token, setToken] = react.useState('')
      usePolled(fetchHealth, setHealth, [])
      react.useEffect(() => {
        let cancelled = false
        fetchToken().then((value) => {
          if (!cancelled) setToken(value)
        })
        return () => {
          cancelled = true
        }
      }, [])

      /**
       * Translate one key, falling back to the English copy and then the key.
       *
       * The `t` prop only arrives when the registration declares a locale, and a
       * missing dictionary entry must not render as a bare key in the interface.
       *
       * @param {string} key - The copy key.
       * @returns {string} The translated string.
       */
      const translate = (key) => {
        if (typeof props?.t === 'function') {
          const value = props.t(key)
          if (typeof value === 'string' && value.length > 0 && value !== key) return value
        }
        return EN[key] ?? key
      }

      const connected = health?.connected === true
      const title = translate('title')

      return react.createElement(
        'li',
        { className: `dshbb-card${open ? ' dshbb-card-open' : ''}` },
        react.createElement(
          'button',
          {
            type: 'button',
            className: 'dshbb-card-header',
            'aria-expanded': open,
            'aria-label': `${translate(open ? 'collapse' : 'expand')}: ${title}`,
            onClick: () => setOpen((current) => !current),
          },
          react.createElement(
            'span',
            { className: 'dshbb-card-headtext' },
            react.createElement('span', { className: 'dshbb-card-name' }, title),
            react.createElement('span', { className: 'dshbb-card-description' }, translate('description')),
          ),
          IconChevron === undefined
            ? react.createElement('span', { className: `dshbb-card-chevron${open ? ' dshbb-card-chevron-open' : ''}` }, '⌄')
            : react.createElement(IconChevron, { className: `dshbb-card-chevron${open ? ' dshbb-card-chevron-open' : ''}` }),
        ),
        open
          ? react.createElement(
            'div',
            { className: 'dshbb-card-body' },
            react.createElement(Field, {
              label: translate('bridge'),
              value: health === undefined
                ? translate('unreachable')
                : health.enabled === false ? translate('disabled') : translate('enabled'),
            }),
            react.createElement(Field, {
              label: translate('extension'),
              value: health === undefined
                ? translate('unknown')
                : connected ? translate('connected') : translate('notConnected'),
            }),
            react.createElement(Field, { label: translate('connections'), value: health?.status?.connections ?? 0 }),
            react.createElement(Field, { label: translate('inFlight'), value: health?.pendingCalls ?? 0 }),
            react.createElement(Field, { label: translate('originRules'), value: health?.originRuleCount ?? 0 }),
            react.createElement(Field, {
              label: translate('namespace'),
              value: health?.settingsRegistered === true ? translate('registered') : translate('notRegistered'),
            }),

            react.createElement(
              'div',
              { className: 'dshbb-field' },
              // Label and action share one line, the value sits below it — the
              // same head/body shape the harness's own fields use.
              react.createElement(
                'span',
                { className: 'dshbb-field-head' },
                react.createElement('span', { className: 'dshbb-field-label' }, translate('token')),
                react.createElement(CopyButton, {
                  text: async () => (token.length > 0 ? token : await fetchToken()),
                  label: translate('copyToken'),
                  doneLabel: translate('copied'),
                  failedLabel: translate('copyFailed'),
                }),
              ),
              react.createElement('span', { className: 'dshbb-field-value dshbb-code' }, token.length > 0 ? token : '—'),
            ),

            typeof health?.status?.lastError === 'string' && health.status.lastError.length > 0
              ? react.createElement(Field, { label: translate('lastError'), value: health.status.lastError })
              : null,

            react.createElement('p', { className: 'dshbb-note' }, translate('note')),
            connected ? null : react.createElement('p', { className: 'dshbb-note' }, translate('connectHint')),
            react.createElement('div', { className: 'dshbb-warn' }, translate('warning')),
          )
          : null,
      )
    }

    /**
     * The footer status action and its panel.
     * @param {{ t?: (key: string) => string }} props - Locale props from the slot.
     * @returns {unknown} The rendered element.
     */
    function StatusAction(props) {
      const [open, setOpen] = react.useState(false)
      const [health, setHealth] = react.useState(undefined)
      const [token, setToken] = react.useState('')
      usePolled(fetchHealth, setHealth, [])

      const translate = makeTranslator(props)

      const connected = health?.connected === true
      const state = health === undefined ? 'unknown' : connected ? 'connected' : 'disconnected'
      const label = health === undefined
        ? translate('browserUnavailable')
        : connected ? translate('browserConnected') : translate('browserNotConnected')

      const limitations = Array.isArray(health?.status?.hello?.limitations) ? health.status.hello.limitations : []

      return react.createElement(
        'div',
        { className: 'dshbb-root' },
        react.createElement(
          'button',
          {
            type: 'button',
            className: 'dshbb-trigger',
            'aria-expanded': open,
            onClick: () => setOpen((current) => !current),
          },
          react.createElement('span', { className: 'dshbb-dot', 'data-state': state }),
          react.createElement('span', null, label),
        ),
        open
          ? react.createElement(
            'div',
            { className: 'dshbb-panel', role: 'dialog', 'aria-label': translate('statusPanel') },
            react.createElement(Field, { variant: 'line', label: translate('bridge'), value: health?.enabled === false ? translate('disabled') : translate('enabled') }),
            react.createElement(Field, { variant: 'line', label: translate('extension'), value: connected ? translate('connected') : translate('notConnected') }),
            react.createElement(Field, { variant: 'line', label: translate('inFlight'), value: health?.pendingCalls ?? 0 }),
            react.createElement(Field, { variant: 'line', label: translate('originRules'), value: health?.originRuleCount ?? 0 }),
            typeof health?.status?.lastError === 'string' && health.status.lastError.length > 0
              ? react.createElement(Field, { variant: 'line', label: translate('lastError'), value: health.status.lastError })
              : null,
            // `limitation`, not `note`: `note` is the paragraph below the fields,
            // and a paragraph used as a label does not fit beside a value — it
            // was 1150px inside a 308px row, which pushed the popover 4x wide.
            ...limitations.map((item) => react.createElement(Field, { key: String(item), variant: 'line', label: translate('limitation'), value: item })),
            react.createElement(
              'div',
              { className: 'dshbb-line' },
              react.createElement('span', { className: 'dshbb-line-label' }, translate('token')),
              react.createElement(CopyButton, {
                text: async () => {
                  const value = await fetchToken()
                  setToken(value)
                  return value
                },
                label: translate('copyToken'),
                doneLabel: translate('copied'),
                failedLabel: translate('copyFailed'),
              }),
            ),
            token.length > 0
              ? react.createElement('div', { className: 'dshbb-row' }, react.createElement('span', { className: 'dshbb-code' }, token))
              : null,
          )
          : null,
      )
    }

    /**
     * Register every contribution.
     * @param {object} ctx - The client root context.
     * @returns {void}
     */
    function apply(ctx) {
      ensureStyles()

      // The card's copy. A `locale` option on the registration is what brings the
      // `t` translator into a contribution's props; without a dictionary a
      // foreign namespace renders raw keys inside an otherwise translated
      // interface. Registered once and shared by both contributions below.
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh: ZH, en: EN }), 'browser-bridge: client copy')

      // The settings card. `key` is the pairing contract: the Plugins tab
      // dispatches only cards whose key a served namespace matches, so this one
      // appears exactly when the host registered `browser-bridge`.
      ctx.effect(() => ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item',
        key: NAMESPACE,
        locale: LOCALE_NS,
      }, BridgeCard)), 'browser-bridge: settings card')

      // `locale` here as well as on the other two: without it the slot receives no
      // `t` translator, so the chip's label and its remove button rendered fixed
      // English inside an otherwise translated interface. The chips sit on the
      // composer, which is the one surface every message passes through.
      ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'browser-context',
        order: 30,
        locale: LOCALE_NS,
      }, ContextChips)), 'browser-bridge: context chips')

      // `locale` here too: the popover carries field labels, so it needs the same
      // translator the card gets rather than its own hardcoded strings.
      ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'browser-bridge',
        order: 40,
        locale: LOCALE_NS,
      }, StatusAction)), 'browser-bridge: status action')
    }

    exports.apply = apply
    exports.inject = inject
    exports.ContextChips = ContextChips
    exports.StatusAction = StatusAction
    exports.BridgeCard = BridgeCard
    exports.NAMESPACE = NAMESPACE
    return module.exports
  },
})
