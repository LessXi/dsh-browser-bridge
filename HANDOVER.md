# 交接工作单：DSH 浏览器桥接插件

> **当前状态：v45 已交付。** 下一节就是最新的一轮改动；下面标 v34/v33/v32/v31/v30/v29/v28/v27/v14/v13/v12/v11/v10/v9/v8/v3/v4/v5/… 的段落是历史层，越往下越旧。
> 只想知道「现在能做什么、下一步做什么」，读到 v45 那一段为止即可。
>
> **环境前提：本仓库不需要 `pnpm install`。** 全新克隆后 `npm test`（438 条）与
> `npm run check:extension` 都能直接跑通——测试是零依赖的自建 runner
> （`packages/dsh-browser-bridge/test/run.js`），宿主 peer 依赖只在真实 dsh 进程里解析。
>
> **`<repo>` 是本仓库在你机器上的位置**——文档里凡是出现 `<repo>\...` 的路径，
> 换成你自己克隆它的目录即可（例：`cd <repo>`）。

> ### v45：用键盘切一次视图，焦点就掉到 body（扩展侧，本次修复）
>
> v44 接上方向键后，下一步是**按 Tab 能不能走到那个控件**。
>
> **真实浏览器实测**（页内探针）：`before: active=title` →
> `after switching to history: active=BODY`。
> **根因**：页头在「标题按钮」与「返回按钮」之间互换，**按下的那个按钮把自己隐藏了** ⇒
> 浏览器把焦点丢回 `<body>` ⇒ 键盘用户**每次切换视图都丢位置**，下次 `Tab` 从面板顶部重来。
>
> **修法（两条规则，缺一不可）**
> ① **焦点交给「撤销这次切换」的控件**：进历史→聚焦返回键，回对话→聚焦标题键。
> ② **只在焦点真的被丢掉时才动**：点列表行时焦点在**行**上，行的处理器切回对话，
> 而行**还在 DOM 里** ⇒ 焦点从未丢失 ⇒ **无条件重新聚焦会把键盘从用户正站着的列表里拽走**。
> 判定不猜「谁隐藏了」，而是**回读浏览器** `document.activeElement === document.body` ——
> 元素可能自己隐藏、也可能被容器移除，两种情况都掉焦点，**问一次覆盖全部**。
>
> **实测（两个方向）**：`active=title` → 切历史 → `active=back`；`active=back` → 返回 → `active=title`。
>
> **测试基础设施必须一起修（关键）**：`dom-shim.js` 的 `focus()` **原本是空函数**、
> `hidden` 是普通属性、`activeElement` **不存在** ⇒ **「焦点在哪」在测试里完全不可观测**，
> 这正是它能上线的原因。现在：`focus()`/`blur()` 真实记录；
> **`hidden` 变成访问器**，隐藏持有焦点的元素时把焦点丢回 `<body>`（复刻浏览器）；
> 节点与 `registry` 的桩都带 `ownerDocument`（否则 `focus()` 找不到文档）；
> 文档初始 `activeElement = body`。
>
> **测试 438 条**（436→438）；新增 2 条（两个方向各保住焦点 / 不夺走行的焦点）。
> **证伪两次，各命中一边**：去掉恢复逻辑 → 1 红；改成「无条件重新聚焦」→ 1 红（正是第二条）。
> **交付要求**：只改 `extension/` → **重载 Chrome 扩展**。

> ### v44：模型选择器声明了「可以用方向键」，但方向键没接（扩展侧，本次修复）
>
> **怎么发现的**：换了一条从没测过的轴 —— **纯键盘操作**。`@` 提及菜单支持方向键，
> 照着它去查模型选择器，发现**声明与实现不一致**：
>
> ```
> drawModelMenu sets role:  true                                        ← 声明了 menuitemradio / radio
> document keydown handler: if (event.key === 'Escape') setMenu(false)  ← 只有 Escape
> ```
>
> 每个选项都带 `role="menuitemradio"`，屏幕阅读器会念成可导航的单选组 ——
> 键盘用户于是去按方向键，**什么都不会发生**，然后以为面板坏了。
> **这类缺陷比「没做」更糟：要么真的接上，要么别声明。**
>
> **修法**：触发按钮接管键盘（`ArrowDown`/`ArrowUp` 进出与循环、`Home`/`End`、
> `Enter`/空格选择、`Escape` 关闭）；**DOM 焦点留在触发按钮上**，高亮画在选项上
> （`.menu-option[data-focused="true"]` + `--accent` 内描边）—— 理由与 `@` 菜单相同：
> 焦点进菜单会交给 document 的「点外部关闭」，在侧栏里还会把对话滚走。
> 焦点不在选项上，位置就必须由触发按钮宣告：`aria-activedescendant`；
> 菜单容器原先**没有 `role`**，补 `role="menu"`（否则 activedescendant 无所依附）；
> 关闭时**一并清掉**该属性（否则指向已不存在的节点）。
>
> **实测（真实浏览器）**：无头 Chrome 打开选择器按三次 `ArrowDown`，页内探针回报
> `labels=["Off","Light","High","Max","DeepSeek-V41-Flash","DeepSeek-V4-Pro"]`、
> `focused=2`、`activedescendant=model-option-2` —— **索引与绘制顺序一致**。
>
> **测试 436 条**（431→436）。行为测试 4 条在 `panel-stream.test.js`；
> **静态断言 1 条必须放 `panel-i18n.test.js`** —— DOM shim **在 JS 里造元素、
> 不解析 `sidepanel.html`**，写在标签里的 `role="menu"` 运行时根本看不见。
>
> **证伪四次，第四次抓出一个假测试**：只把「关闭时清 `menuFocus`」与
> 「重建菜单时清 `menuFocus`」**分别**改坏，测试**全绿** —— 两者互相兜底。
> 真正可观测的是那个**指针**，于是改断言 `aria-activedescendant`，
> **两处一起改坏才变红**。**能互相兜底的实现，必须用它们共同的可见结果来测。**
>
> **夹具**：会话原先**没有 `model` 字段** ⇒ `chooseModel` 以 `model.unavailable`
> 提前返回（**正确行为**），所以选择器测试必须先给会话一个模型。
> 新增 `host.sessionModel` 与 `host.catalog`（默认 `null`，让多数用例仍走「不可用」分支）。
>
> **交付要求**：只改 `extension/` → **重载 Chrome 扩展**。

> ### v43：面板拖窄到 240px 时，底部溢出 12px（扩展侧，本次修复）
>
> v42 量高度，这轮量**宽度谱**（侧栏最窄约 240px）。**外观完全看不出来**，
> 靠给探针加两件事定位：① 报告右边缘超出面板的节点；② 报告每个 body 子节点的 `宽度` vs `scrollWidth`。
>
> **第一次结果是假警报**：`CODE w=405` 是代码块里的**行内 `<code>`**，
> 被外层 `<pre>`（`overflow-x: auto`）正常滚动着 —— **`pageOverflowX=0` 始终成立**。
> 加「祖先里是否有滚动容器」的过滤后，真凶只剩一个：
> `BODYCHILD FOOTER w=240 scrollW=252` + `OVERFLOW BUTTON#send right=252`。
>
> **根因**：`#model` 是 flex 子项，而 **flex 子项默认不肯缩到内容宽度以下** ⇒
> 它的 `max-width: 224px` **没生效**，里面 `#model-text` 的 `text-overflow: ellipsis`
> **永远没机会触发**，多出的 12px 跑到面板外。
> **修法**：`#model` 加 `min-width: 0` + `flex: 0 1 auto`（**两条缺一不可**）。
>
> **实测**：`footer` 的 `w` vs `scrollW` —— 240px 修复前 `240/252` ❌、修复后 `240/240` ✅；
> 260/300/392px 全部 `w == scrollW`；`bodyOverflowX` 四个宽度**全为 0**；
> 240px 下模型名正常显示为 `DeepSeek-V41-Flas…`（**被省略号收掉，不是被裁掉**）。
>
> **测试 431 条**；新增 1 条断言（`#model` 必须 `min-width: 0` 且 `flex: 0 1 auto`，
> `#model-text` 必须有省略号）。证伪：去掉那两行 → 1 红。
>
> **两个坑（务必记住）**：
> ① **pwsh 的 `Set-Content` 截断了 `preview.mjs`**（丢掉结尾 `})`），
> 并在仓库里留下一个 **0 字节的 `preview.mjs`** —— 因为那次 `Set-Location` 没生效、
> 相对路径落到工作区。**改文件一律用 edit 工具 + 绝对路径。**
> ② 探针第一版「溢出检测」**没排除滚动容器内部的元素**，把「正常滚动的代码块」报成缺陷。
> **测量工具报出的第一个结果，先质疑工具本身。**
>
> **交付要求**：只改 `extension/` → **重载 Chrome 扩展**。

> ### v42：面板拖矮之后，对话整块消失（扩展侧，本次修复）
>
> **怎么发现的**：v39 量宽度，这回量**高度**（侧栏也能往下拖）。量的是**结构**不是外观：
>
> | 面板高度 | `stage`（对话区） | `footer`（chip 行 + 输入区） |
> |---|---|---|
> | 812px | 529px | 144px |
> | 420px | 137px | 144px |
> | **260px** | **0px** | **144px** |
>
> **`stage=392x0`** —— 对话区被压成零，chip 行和输入区一格都没让。
> **根因**：`#stage { flex: 1 }` + `min-height: 0` 配 `footer { flex: none }` ⇒ 只有 stage 会缩，一直缩到 0。
>
> **三次尝试，前两次都错（两个失败都要留下）**：
> ① 只给 stage 地板 ⇒ footer 被压到 **10px**，**输入框消失**（能读不能打字）；
> ② 再让 footer 自己滚动 ⇒ 320px 时 49px 的 footer 装着 78px 的输入框，
> 被**自己的 overflow 裁掉**；③ 两个地板 + **body 是唯一滚动容器** ⇒ ✅
>
> **最终**：`#stage { flex: 1 1 0; min-height: 96px }`（**basis 必须是 0**，
> 用 `auto` 时 stage 先要内容高度，再把差额摊给 footer —— 实测普通高度下 footer 被削 10px 并裁掉 composer）、
> `#composer { flex: none }`、`body { overflow-y: auto }`。
> 矮到地板之和超过窗口（约 300px 以下）时由 body 滚动承担 ——
> **发送键滑到折叠线以下，而不是被裁掉**。
>
> **低于 340px 时降低地板，不隐藏任何东西**：一度写了 `#contexts { display: none }` 然后**删掉** ——
> chip 行是**唯一**回答「我的划词会不会被送出去」的地方，而这个问题这面板**已经失败过一次**
> （用户原话「我也不知道会不会被加进上下文」）。**用一个布局 bug 换一个信任 bug，不划算。**
> 改成 `#stage { min-height: 72px }`；260px 的算术：`44 + 72 + 56 + 88 = 260`，一个控件都不消失。
>
> **实测**（body 滚到底后量发送键）：812px `send.bottom=699 / viewportH=717` ✅ 无需滚动；
> 420px `307/325` ✅；340px `227/245` ✅（滚 15px）；260px `147/165` ✅（滚 95px）。
>
> **顺带删掉一条重复规则**：`#composer` 被声明了**两次**，**是证伪时抓出来的** ——
> 把 composer 的 `flex: none` 改坏，测试**照样通过**，因为断言匹配到了前面那条孤立规则，
> 而真正生效的是后面那条。现在断言 `#composer` **只能声明一次**。
>
> **测试 430 条**；证伪两次（composer 可缩 → 1 红；stage 地板 0 → 1 红）。
>
> **踩到的坑**：pwsh 的 `Set-Content` 会把该文件的 **LF 静默换成 CRLF**，
> 而 `stream.test.js` 有一条断言要求字面 LF 形式，于是它红了 ——
> 看起来像改坏了样式，实际是行尾符被换。**改本仓库文件优先用 edit 工具。**
> **交付要求**：只改 `extension/` → **重载 Chrome 扩展**。

> ### v41：设置页有和侧边栏一模一样的毛病（扩展侧，本次修复）
>
> **怎么发现的**：v40 修侧边栏调色板时，把同一条判据（`color-scheme: light dark` 下
> **硬编码色值是唯一会失守的东西**）也用到设置页。它中招更重：
> `#d9971f` 警告竖条浅色 **2.50 ❌**（边框需要 3.0，它是一条 3px 左边框，
> 用户靠它认出「这里有安全提醒」）；`#2f9e63` 3.39 ⚠️；`#4d6bfe` 填充 4.33 ⚠️；
> `#fff` 在主按钮上 4.33 ⚠️。
>
> **修法**：与侧边栏同一套规则 —— `:root` 一次性声明，**任何地方都不写字面色值**。
> `--accent #4a63e7/#3a83f7`、`--on-accent #ffffff/#10101a`、`--ok #2f7d52/#3fae74`、
> `--bad #d1453b/#fa423e`、`--warn #8a5a00/#e5b567`（全部 ≥4.5，边框类 ≥3）。
> 四处字面色值（`button.primary` 的 `#fff`、`#result` 两个边框、`.warn` 竖条）改读 token。
>
> **像素级验证**：预览宿主新增对**字面页面**（`path:options.html`）注入 dark 声明的能力 ——
> 此前静态文件读不到 query 参数，**两次截图字节完全相同**。
> **这本身是个陷阱**：看起来像「深色没生效」，实际是「深色请求压根没送进去」。
> 改后实测主按钮填充：浅色 `74,99,231`（`#4a63e7`）、深色 `58,131,247`（`#3a83f7`），逐字节符合。
>
> **测试 429 条**；新增 1 条断言（`:root` 之外不许有字面色值、五个 token 必须 `light-dark()`、
> 且每个都必须被真正用到）。证伪：`.warn` 竖条改回 `#d9971f` → 1 红。
> **交付要求**：只改 `extension/` → **重载 Chrome 扩展**。

> ### v40：暗色模式下，红色的字太淡（扩展侧，本次修复）
>
> **怎么发现的**：面板声明了 `color-scheme: light dark`，除三个颜色外**全部**是
> `color-mix(… CanvasText …)`，所以它们自动跟着方案翻转 —— **只有硬编码的三个会失守**。
> 按 WCAG 算：`--bad #d1453b` 浅色 4.54 ✅ / **深色 3.79 ❌**（失败行文字 12–13px）；
> `--accent #4d6bfe` 浅色 4.33 ⚠️ / **深色 3.97 ❌**；`#fff` 放 accent 填充上 4.33 ⚠️。
> **一个值不可能同时过两个方案的 AA** —— 算术问题。官方用按主题解析的 `var(--red-500)` 印证了这点。
>
> **修法**：`light-dark()`（面板已声明 `color-scheme`，浏览器自己解析；Chrome 116+，
> 与 `minimum_chrome_version` 一致）。数值**量出来的**：
> `--bad` `#d1453b`/`#fa423e`、`--accent` `#4a63e7`/`#3a83f7`、`--ok` `#2f7d52`/`#3fae74`、
> **新增 `--on-accent`** `#ffffff`/`#10101a`（白字在深色 accent 上只有 3.64，
> 而「本会话允许」按钮字只有 12px ⇒「填充色上的字」是独立 token）。
> 原先两处写死 `#fff`（`#send`、`.approval-allow`）都改用它。
>
> **像素级验证**：浅/深 `failed` 各截一张，解码 PNG 取失败文字实际颜色 ——
> 浅色 `209,69,59`（`#d1453b`）、深色 `250,66,62`（`#fa423e`），与预期逐字节一致。
>
> **陷阱（务必记住）**：无头 Chrome 的 `--force-dark-mode` **不能**验证此事 ——
> 它产出浅色图（面板用系统色，不是 `prefers-color-scheme` 强制反转）。
> 正确做法：预览宿主 `?dark=1` 声明 `color-scheme: dark` + 给 Canvas 深色值，
> 再用**像素直方图**判定（浅色 mean=239/92% 亮，深色 mean=41/4%）。
>
> **测试 428 条**；新增 1 条断言（四个 token 必须都是 `light-dark()` 且每方案 ≥4.5）。
> **证伪两次**：退回硬编码 → 1 红；写成 `light-dark(#d1453b, #d1453b)` → 1 红（dark 3.79）。
> **交付要求**：只改 `extension/` → **重载 Chrome 扩展**。

> ### v39：面板拖宽之后，一段话横跨整个屏（扩展侧，本次修复）
>
> **怎么发现的**：Chrome 侧栏宽度**可以拖**，而我此前所有截图都在 392px。
> 拖到 1000px 量了一次：段落盒子 **832px** —— 眼睛读完一行回到下一行**找不到行首**。
> 实测表：392px→344px、760px→706px、**1000px→832px**。
>
> **一手依据（官方原版）**：`chrome-extension-sidepanel-aQf-8vya.css` 里有专门的
> `--thread-content-max-width`，桌面端默认 **`48rem` = 768px**；
> 它还用一个 `_Probe_` 元素量列宽，并把宽块（表格/宽代码）放在
> `max(--thread-content-max-width, --markdown-wide-block-max-width + 8rem)` 的**另一列**里。
>
> **修法**：新增 token `--thread-content-max-width: 48rem`，加在**行**上
> （`#transcript > * { width:100%; max-width:var(…); margin-inline:auto }`）：
> 加在行上 ⇒ 滚动条仍贴面板边缘、`#transcript` 仍是整高滚动容器；
> **居中**而非左贴 ⇒ 宽面板下空白不会全堆一侧；
> **表头/chip 行/输入区不跟着收窄**（它们是 chrome，官方也只收窄 thread）。
>
> **实测（改后）**：392px→372/344（不变）、760px→740/706（不变）、
> **1000px→行 768px / 段落 733px**（原本 832px）。
>
> **已知差异（如实记录）**：官方正文列与宽块列**分开**，本实现**一列覆盖两者**。
> 差异只在面板宽于约 1150px 时可见，那条额外规则会是**永不执行的复杂度**，故不写。
>
> **测试 427 条**（新增 1 条静态断言：token 存在、真用在行上、且是居中）。
> **交付要求**：只改 `extension/` → **重载 Chrome 扩展**。

> ### v38：三个不同的问题，长得一模一样（扩展侧，本次修复）
>
> **症状**：扩展没连上宿主时，面板只在 chip 上写一个红色的「未连接」。
> **为什么是缺陷**：这一个词同时代表**三件解法互不相同**的事 ——
> 从没填过令牌（去设置页粘贴）/ `dsh web` 没在跑（启动它）/ worker 还没醒（等一秒）。
> 扩展**一直知道**原因（`background.js` 的 `lastError = 'no token saved'`），
> **只是从来没告诉过面板**。
>
> **修法**：宿主说「是不是」，worker 说「为什么」，面板说人话。
> - `extension/background.js` 新增 `bridgeState()` → `{ open, connecting, reason: 'no-token'|'connecting'|'refused', detail, version }`
>   （**代码不是句子**：措辞属于知道读者语言的面板）。
> - 新增面板→worker 消息 `dsh-bridge-state` 与 `dsh-bridge-retry`。
>   **面板自己开不了 socket**（socket 属于 worker），所以只能请求、不能重连。
> - chip 变成按钮：「没填令牌」/「未连接」，点击让 worker 重连；
>   `no-token` 直接 `openOptionsPage()`。与站点 chip **并列**（两件不同的事），
>   **只在宿主可达时显示**（宿主不可达已有整块状态面 + 重试按钮）。
>
> **顺带修掉一个真会卡死的分支**：`connect()` 在「没令牌」时**直接 return** ——
> 不但不重连，还**不挂 keepalive 闹钟**，worker 可能在用户去填令牌前就被回收，
> **面板的重试按钮将没有东西应答它**。现在也走 `scheduleReconnect()`。
>
> **测试 426 条**。**夹具教训**：`sendMessage` 此前恒返回 `{}`、`openOptionsPage` 是空函数，
> **所以这两条路径根本不可测**。新增 `host.bridgeConnected` / `host.bridgeState` /
> `host.runtimeMessages` / `host.openedOptions`；`bridgeConnected` 与 `bridgeState` **故意分开** ——
> 宿主只知道「是否连上」，worker 才知道「为什么」，合成一个字段就表达不出「连着但 worker 说没令牌」。
>
> **证伪三次**：worker 不应答 `dsh-bridge-state` → 1 红；没令牌时不挂重连 → 1 红；
> chip 退回只说「未连接」 → 2 红（含死键检查）。
> **交付要求**：只改 `extension/` → **重载 Chrome 扩展**（不需要重启 `dsh web`）。

> ### v37：量了 7000 行会话的性能 —— 没有找到缺陷（无代码改动）
>
> v33 让长会话能往回读，`depth` 会一直涨。这轮**量**了涨到 7000 行时的代价：
> **宿主读一次**（线上 3080 会话 `session-44c33409`，只读）：`limit=60` → 26ms、
> `limit=1000` → 36ms、`limit=20000`（7510 行）→ **168ms** —— 翻到最开头约 170ms，
> **只在你点「更早的内容」时付一次**，不是每次轮询。
> **面板侧**：`JSON.stringify(rows)`（6969 行/487KB）**1.3ms**；
> `parseMarkdown`（512KB/21624 块）**9.1ms**。
> ⇒ 两处都不是瓶颈，`drawTranscript` 也只在签名变化时才碰 DOM。**不为此改代码。**
> 顺带确认：助手回答正文**不裁剪**（400KB 的 text 块原样到达）——
> 这就是上面 9.1ms 的出处，可预见规模内不需要上限。
> **目的**：避免下一轮重复测同一个轴。
> ### v36：一个「拒绝」带着授权时长回来了（宿主侧，本次修复）
>
> **怎么发现的**：v34/v35 把「按钮说的话 = 实际发生的事」当不变量之后，
> 把这条不变量拿到**协议边界**上再试：`relay.answer(id, 'rejected', 'conversation')`
> → `{"answered":true,"outcome":"rejected","scope":"conversation"}`，
> **`scopeOf('c1')` 读出了 `"conversation"`** —— 从一个「不」里读出了一个时长。
>
> **为什么还没造成损害**：记授权那行同时检查 `sensitive`/`alwaysAsk`，
> 而拒绝走 `outcome:'denied'` 分支、根本不记授权 —— 所以它**到不了授予表**。
> 但它**已经躺在中继里**，同一个 `callId` 的下一个问题会读走它。
> **靠下游恰好也拦住来掩盖上游的错误记录，不是想要的形状。**
>
> **修法**：只有「是」才可能带时长 ——
> `const granted = outcome === 'allowed-once' && APPROVAL_SCOPES.includes(scope)`；
> 拒绝带 scope 是调用方 bug，返回里也不再回显。
>
> **顺带修掉一条我自己写的坏测试**：`answer(id,'cancelled','once')` + `await promise`
> —— `PANEL_OPTIONS` 只允许 `allowed-once`/`rejected`，所以 `cancelled` 被拒、
> 那个 promise **按设计永不 settle**，测试挂死在顶层 await
> （runner 报 `Detected unsettled top-level await`）。
> **这本身是好信号**：协议边界确实拒绝了这个值。改成断言「被拒绝」而不是等它。
>
> **测试 422 条**；证伪：`granted` 退回只看 `APPROVAL_SCOPES.includes(scope)` → 1 红。
> **交付要求**：只改 `lib/` → **重启 `dsh web`**（扩展侧无改动）。

> ### v35：删掉两个「说了不算数」的按钮（宿主 + 扩展，本次修复）
>
> **背景**：v34 让按钮说的话等于实际发生的事。但还有**两条路径**上
> 「本会话允许」**根本不可能兑现**：`browser_eval`/`browser_cdp`/`browser_upload`
> 每次都重问（`alwaysAsk: true`），敏感操作在已授权站点里也再问一次（读 ≠ 花钱）。
> **量出来的**：`ordinary click -> asked again = false`；`sensitive (submit) -> asked again = true`。
>
> **修法**：宿主在请求里带 `rememberable`（= `!alwaysAsk && !sensitive`，
> **它就是那条记录规则本身**，所以面板与宿主不可能各说各话）；
> 面板拿到 `rememberable: false` 只画 `只允许一次`，并补一句 `这一步每次都要重新确认`。
> **没有加第二道 clamp**：先写了「旧面板硬发 conversation 也不记录」的防护，
> **用证伪证明它不可达**（`rememberable === false` 恰好等价于那两个条件，它们本来就各自阻断记录）
> —— 看起来像安全网却永不执行的代码已删。
>
> **顺带**：敏感提示原本一句通用话，但 `classifySensitivity` 分三类，
> `browser_eval` 是「在页面里执行代码」，既不花钱也不改页面。
> 现在宿主把**类别**一起送来，面板分别说（认不出来就回退通用句，**不猜**）。
> `browser_eval` 会同时显示两条 —— 它们回答的是不同问题（多危险 / 为什么不能一次放过）。
>
> **测试 421 条。本轮的教训是「假通过」**：第一版 always-ask 用例驱动 `browser_eval`，
> 断言它不记录授权 —— **通过了但理由错了**（eval 同时敏感，因敏感而不记录，与 always-ask 无关）；
> **证伪时删掉 guard，测试全绿**，才暴露。改法：换成 `browser_upload` 并**补一条对照用例**
> （同夹具下普通工具**必须**记录），否则用例会在「什么都不记录」的坏夹具上照样绿。
> 另：面板用例直接喂问题、不经过宿主，**抓不到宿主忘了转发** → 补了宿主侧断言。
>
> **证伪四次**：宿主不标记 `rememberable` → 2 红；面板不扣下按钮 → 1 红；
> 面板退回通用句 → 1 红；宿主不转发危险类别 → 1 红。
>
> **交付要求**：`lib/` + `extension/` 都改了 → **重启 `dsh web` + 重载 Chrome 扩展**。

> ### v34：按钮写着「允许一次」，实际给了整个会话（宿主 + 扩展，本次修复）
>
> **缺陷**：审批卡只有一个肯定按钮「允许一次」，按下去之后同一站点在本次会话里再也不问。
> **量出来的**（真实模块，非推断）：
> `persistentApproval=true` + `accessApprovalLifetime='thread'` ⇒ 宿主回 `allowed-once` 后
> 记的是 `choice=allow-for-site, lifetime=thread` ⇒ **30 天不活动仍然有效**（进程不停就是永久）。
> **根因**：harness 的审批**只有一个授予词** `allowed-once`，时长语义根本不在它的返回里；
> 桥是用**配置默认值**猜的，于是「一次」被放大成「本会话」。
>
> **一手依据**：官方扩展产物里的 `approvalRequestCard.*` 分别是
> `allowOnce` = `Allow once` / `allowConversation` = `Allow this conversation` /
> `alwaysAllow` = `Always allow` / `deny` = `Deny` —— **三个**答案，我们只有一个且标签是错的。
>
> **修法**：面板两个肯定按钮 `只允许一次`(`scope:'once'`) / `本会话允许`(`scope:'conversation'`)；
> scope 经**中继**回到 `lib/page-tools.js`（`approval.request()` 的返回值装不下它），
> 宿主据此决定授予，**不再看配置默认值**；`once` **什么都不记录**
> （不是 `lifetime:'turn'` —— 那是真授予，5 分钟空闲窗口内一直覆盖后续调用）。
> 没有 `always`：授予表在内存里、重启即失，按钮无法兑现（已记入 README 差距表）。
>
> **实测（真实模块端到端）**：`只允许一次` → **`granted=false`**；`本会话允许` → `granted=true`；
> 旧面板不带 scope → 回退配置默认值，行为不变。
>
> **测试 412 条**；新增 `test/grant-scope.test.js`（6 条，**直接驱动真实 `askApproval`**）。
> **教训**：`screenshot.test.js` 绕开 `askApproval`（用预置授权），所以这条链路一直没被测过。
> 另外**三条按索引取按钮的测试必须改成按类名命名**：卡片多一个按钮后 `approvalButtons()[0]`
> 从「本会话允许」悄悄变成「只允许一次」，设置还在、断言的意思已经错了。
>
> **证伪三次**：宿主忽略 scope → 1 红；中继不带回 scope → 2 红；两个按钮发同一 scope → 1 红。
>
> **交付要求**：`lib/` + `extension/` 都改了 → **重启 `dsh web` + 重载 Chrome 扩展**。

>
> **量出来的事实**：用户自己的会话 `session-44c33409`（标题「打造类似codex的dsh网页插件」）
> 向线上 3080 请求 `limit: 60` 返回 60 行，`limit: 20000` 返回 **6969 行**。
> 面板写死 `limit: 60` 且**没有任何「上面还有」的提示，也没有办法往回走** ——
> 99.1% 的对话在面板里根本不存在。
>
> **修法：把「页码」换成「窗口」**
> - 宿主 `readMessages(sessionId, limit, before)` 新增 `before`，返回 `more`。
>   切片**从末尾算起**，所以最新的一行永远是返回的最后一行。
> - 面板请求「从最新往回数的 N 行」，`depth` 从 60 起、点一次加 60 ——
>   **轮询和翻页是同一个请求的两种尺寸**，不会出现两段数据重叠或对不上。
> - 顶部胶囊 `#earlier`「更早的内容」，**只在 `more` 为真时出现**。
>
> **必须记住的坑**：翻页把新行插在读者**上方**，只恢复原 `scrollTop` 会把读者
> 正在读的那段顶出屏幕 —— 就是当初轮询那个「自己滚下去了」，换了一条路。
> `drawTranscript` 量 `scrollHeight` 增量，用一次性标记 `grewEarlier` 补偿。
>
> **实测**：`npm test` **401 passed / 0 failed**；`check:extension` exit 0。
> 探针（真实宿主 3199）：`limit=1`→1 行 `more=True`；**逐行往回走到头再拼起来，
> 与一次性读到的全文逐字节相等（`TILES EXACTLY: True`）**；`before=999`→0 行 `more=False`。
> **证伪三次**：窗口不增长 → 3 红；宿主忽略 `before` → 1 红；切换会话不重置窗口 → 6 红。
>
> **夹具教训**：桩此前**永远返回全部行且没有 `more` 字段**，所以「会话比一屏长」
> 是不可测的 —— 这就是它活了 33 轮的原因。新增 `host.down` / `host.reads` / `host.more`。
>
> **交付要求**：`lib/` + `extension/` 都改了 → **重启 `dsh web` + 重载 Chrome 扩展**。

>
> **`<repo>` 是本仓库在你机器上的位置**——文档里凡是出现 `<repo>\...` 的路径，
> 换成你自己克隆它的目录即可（例：`cd <repo>`）。

> ### v33：一个会话有 6969 行，面板只给你看最后 60 行（宿主 + 扩展，本次修复）
>
> **量出来的事实**：用户自己的会话 `session-44c33409`（标题「打造类似codex的dsh网页插件」）
> 向线上 3080 请求 `limit: 60` 返回 60 行，`limit: 20000` 返回 **6969 行**。
> 面板写死 `limit: 60` 且**没有任何「上面还有」的提示，也没有办法往回走** ——
> 99.1% 的对话在面板里根本不存在。
>
> **修法：把「页码」换成「窗口」**
> - 宿主 `readMessages(sessionId, limit, before)` 新增 `before`，返回 `more`。
>   切片**从末尾算起**，所以最新的一行永远是返回的最后一行。
> - 面板请求「从最新往回数的 N 行」，`depth` 从 60 起、点一次加 60 ——
>   **轮询和翻页是同一个请求的两种尺寸**，不会出现两段数据重叠或对不上。
> - 顶部胶囊 `#earlier`「更早的内容」，**只在 `more` 为真时出现**。
>
> **必须记住的坑**：翻页把新行插在读者**上方**，只恢复原 `scrollTop` 会把读者
> 正在读的那段顶出屏幕 —— 就是当初轮询那个「自己滚下去了」，换了一条路。
> `drawTranscript` 量 `scrollHeight` 增量，用一次性标记 `grewEarlier` 补偿。
>
> **实测**：`npm test` **401 passed / 0 failed**；`check:extension` exit 0。
> 探针（真实宿主 3199）：`limit=1`→1 行 `more=True`；**逐行往回走到头再拼起来，
> 与一次性读到的全文逐字节相等（`TILES EXACTLY: True`）**；`before=999`→0 行 `more=False`。
> **证伪三次**：窗口不增长 → 3 红；宿主忽略 `before` → 1 红；切换会话不重置窗口 → 6 红。
>
> **夹具教训**：桩此前**永远返回全部行且没有 `more` 字段**，所以「会话比一屏长」
> 是不可测的 —— 这就是它活了 33 轮的原因。新增 `host.down` / `host.reads` / `host.more`。
>
> **交付要求**：`lib/` + `extension/` 都改了 → **重启 `dsh web` + 重载 Chrome 扩展**。

>
> **`<repo>` 是本仓库在你机器上的位置**——文档里凡是出现 `<repo>\...` 的路径，
> 换成你自己克隆它的目录即可（例：`cd <repo>`）。

> ### v32：连不上宿主时，面板把最大的一块区域留成了空白（扩展侧，本次修复）
>
> **症状**（**造出「刚装好扩展、还没启动 `dsh web`」这个状态**才看见）：屏幕最大的
> 那块消息区是空的，唯一的解释是一行 11px 灰字「连不上 dsh web」贴在输入框上方；
> 页头还写着**「还没有会话」**（对用户数据的谎报 —— 会话都在，只是没人应答）；
> 输入框旁又有「模型列表不可用」。**一个原因被说成三件坏掉的事。**
>
> **一手依据**：Codex 有专门的 status surface，一律是「标题 + 一句话 + 按钮」，
> 例如 `Install the app to use ChatGPT in {browser}` / `Try again`。
>
> **修法**：新增 `#blocked` 状态面（标题+一句话+按钮，居中占 `#stage`）；
> `renderTitle()` 不可达时显示产品名而**不再谎报「还没有会话」**；
> `renderContexts()` 整行隐藏、`drawModel()` 显示中性「选择模型」——
> **一个原因只说一次**；`start` 拆出 `loadEverything()` 让重试走**完全相同**的路径。
> 删掉 `error.hostDown` 键与 `#offline` 元素。
>
> **注意**：`no dictionary entry is a sentence` 有**一处具名豁免**（`blocked.hostTitle`/`blocked.hostBody`），
> 因为状态面里那句话就是内容本身；豁免写成数组并断言长度为 2，不会悄悄扩张。
>
> **实测**：无头 Chrome → `[chat] blocked hidden` / `[firstRun] blocked 显示、contexts hidden`；
> `npm test` **396 passed / 0 failed**；`check:extension` exit 0。
> **证伪三次**：状态面永不出现 → 5 红；页头改回谎报 → 1 红；模型行改回重复报错 → 1 红。
>
> **交付：只改 `extension/` → 重载 Chrome 扩展即可。**
>
> **可复用的能力（本轮新增）**：预览宿主支持 `hostDown` / `bridgeConnected: false` 两个场景开关
> （`?s=firstRun`、`?s=noBridge`），**首次运行与「宿主在但扩展没连上」这两个状态现在可截图**。

>
> **`<repo>` 是本仓库在你机器上的位置**——文档里凡是出现 `<repo>\...` 的路径，
> 换成你自己克隆它的目录即可（例：`cd <repo>`）。

> ### v31：右键菜单在中文浏览器里是英文（扩展侧，本次修复）
>
> Chrome 右键菜单里四行英文，出现在**每个页面、每次右键**：
> `Add selection to DSH context` / `Add this page…` / `Add this tab…` / `Sync selections automatically`。
>
> **为什么最后才发现**：面板、设置页、动态提示都能靠截图看到，
> **而右键菜单由 Chrome 画在浏览器自己的 UI 里，任何面板截图都照不到** ——
> 它只存在于 `background.js` 的 `chrome.contextMenus.create({ title })` 里。
> **教训：能被截图的界面才会被截图发现。**
>
> **修法**：service worker 里没有面板可借翻译器，直接 import `optionsTranslator` + `pickLocale`
> （v30 为设置页建的那本字典），四行改用 `menuSay('menu.*')`。
> **用 `globalThis.chrome` 而不是裸 `chrome`** —— 可选链**救不了未声明的标识符**，
> 裸 `chrome?.i18n` 在没有 `chrome` 的环境里直接抛错而不是回退英文。
>
> **实测**：`npm test` **394 passed / 0 failed**；`check:extension` exit 0。
> **证伪**：一行标题改回英文 → 2 红（该行 + 该键变成死键）。
>
> **交付：只改 `extension/` → 重载 Chrome 扩展即可。**

>
> **`<repo>` 是本仓库在你机器上的位置**——文档里凡是出现 `<repo>\...` 的路径，
> 换成你自己克隆它的目录即可（例：`cd <repo>`）。

> ### v30：设置页是纯英文，而面板是中文（扩展侧，本次修复）
>
> 侧边栏全中文，而**设置页 141 行 HTML + 126 行 JS 里没有一个中文字符**。
> 设置页不是角落 —— **它是粘贴桥接令牌的必经之门**，也是唯一讲清
> 「`debugger` 权限等于什么」的地方。
>
> **为什么一直没被发现**：整套 i18n 纪律**全部只扫 `sidepanel.*`**；
> `options.js` 只在「死键」那条的搜索名单里出现，而它一个 `t()` 都没有，所以永远通过。
> **一个文件被纳入检查名单，不等于被检查。**
>
> **修法**：给设置页**单独一本字典**（`locales.js` 的 `options` + `optionsTranslator`），
> 不往面板字典里加键 —— 两种界面的文案形状本来就不同（面板每条都是标签；
> 设置页读一次、静止、全宽，安全警告就是重点，不是噪声）。
> HTML 里不留任何文案：22 个 `data-i18n` 节点在脚本运行前填好，缺键回退英文而不是空框。
>
> **实测**：无头 Chrome 以 `zh-CN` 渲染设置页，整页中文、22 节点无空框；
> `npm test` **393 passed / 0 failed**；`check:extension` exit 0。
> **证伪两次**：标记里留一个英文词 → 1 红；加一个没人画的键 → 2 红。
>
> **交付：只改 `extension/` → 重载 Chrome 扩展即可。**
>
> **可复用的能力（本轮扩展）**：`%TEMP%\panel-preview\shoot.mjs` 现在支持
> `["path:options-probe.html",760]` 这种场景 —— **任意静态页**都能走同一条
> 「起服务 → 无头 Chrome 截图 → 收尾」管线。**不要自己写新的 in-process 服务器**：
> Chrome 保持 keep-alive 连接会让 `server.close()` 永不 settle，进程挂死（本轮踩了两次）。

>
> **`<repo>` 是本仓库在你机器上的位置**——文档里凡是出现 `<repo>\...` 的路径，
> 换成你自己克隆它的目录即可（例：`cd <repo>`）。

> ### v29：未分组的会话借用了上一个工作区的标题（扩展侧，本次修复）
>
> 列表里有一批行**没有自己的分组标题**，排在「daily」那些行下面，读起来就是 daily 的一部分。
> 线上实例只读拉一次就知道这不是边缘情况：
> `title='daily'`(7) / `title='打造dsh插件'`(2) / **`title=''`(3)** —— 三行零标题。
>
> **一手依据**：`dsh-client-ui-workspace/lib/client.js:842` 是
> `const label = row.workspaceId === void 0 ? t("group.ungrouped") : row.label`，
> `:2719` 的 `"group.ungrouped"` = **`"未分组"`**。DSH 自己的侧栏给这个桶起了名字，我们的 `drawHistory()` 什么都不画。
>
> **修法**：画上 `history.ungrouped`（`未分组`/`Ungrouped`），**用宿主的词，不自己发明**。
> 同时修正预览夹具：两个分组的 `title` 原本写的是**路径**，而宿主发的是**注册标题** ——
> **夹具比产品难看，恰好掩盖了这个缺陷在截图里的样子**。
>
> **实测**：无头 Chrome 截图三个分组标题各自正确；`npm test` **391 passed / 0 failed**。
> **证伪**：把 `label.textContent` 置空 → 2 红。
>
> **交付：只改 `extension/` → 重载 Chrome 扩展即可。**

>
> **`<repo>` 是本仓库在你机器上的位置**——文档里凡是出现 `<repo>\...` 的路径，
> 换成你自己克隆它的目录即可（例：`cd <repo>`）。

> ### v28：审批卡把英文开发者日志当正文念给用户（宿主 + 扩展，本次修复）
>
> **症状**：中文面板的「需要你确认」卡片正文是
> `the browser bridge wants to use https://dl.acm.org`，敏感类还会更长：
> `https://dl.acm.org: this action spends money or changes state, which is more than reading the page`。
> 这是 **v16 修过的同一个缺陷**（写给日志的英文散文被当作界面文案）长在 v16 没覆盖的**另一条路径**上：
> v16 只修了回合失败行（`extension/failure.js`），审批卡一直在 `extension/sidepanel.js` 里原样渲染宿主的 `reason`。
>
> **为什么之前看不见**：预览夹具里的审批**没有 `reason` 字段**，走的是
> `t('approval.wants', { tool })` 回退分支，渲染出干净的中文。
> 而生产里 `packages/dsh-browser-bridge/lib/page-tools.js` **总是**设 `reason`。
> **夹具比产品干净，所以截图里看不见** —— 与 v24「`chrome.tabs.query` 返回空数组导致 chip 零覆盖」同类。
>
> **修法：宿主送事实，面板自己写句子。**
> 1. `lib/page-tools.js` 的 `approval.request({...})` 多送 `origin` 与 `sensitive`
>    （宿主把请求对象原样透传，加字段不用改宿主）。
> 2. `lib/approval.js` 的 `#question()` 经新的 `factsFor(request)` 把它们带进面板通知；
>    **`sensitive` 优先读结构字段**，只有拿不到才从 reason 措辞回退推断——结构字段不会漂移。
> 3. `extension/sidepanel.js` 自己组句：`approval.wantsSite` = `要在 {site} 上使用 {tool}`，
>    `approval.note` = `这一步会改动页面或花钱，不只是读`（仅 `sensitive` 为真时出现）。
> 4. 宿主英文原话降级为 `.approval-detail`，**且只在没有 `site` 时显示**——否则同一个 URL 在一张卡里出现两次。
>
> **顺带修掉一个我自己引入的缺陷**：`renderApproval` 的去重键原本只有 `id:answering`，
> 于是**同一个 id 带更完整字段再次到达时（健康轮询追上通知）重绘被跳过**，卡片停在信息更少的那版；
> 键现包含 `site`/`sensitive`/`reason`。**这条是写新测试时抓出来的，不是事后想到的。**
>
> **实测**：探针 3199 上用 `page-tools.js` 真实构造的请求驱动中继 →
> `origin:"https://dl.acm.org"` / `sensitive:true` 到达面板，作答 `{"answered":true,...,"outcome":"allowed-once"}`；
> 无头 Chrome 截图三个场景（有新事实 / 只有英文原话 / 两者都没有）各自正确；
> `npm test` **390 passed / 0 failed**；`check:extension` exit 0。
> **证伪三次**：宿主不转发 origin → 1 红；面板改回渲染 `reason` → 2 红；去重键退回 `id:answering` → 1 红。
>
> **交付：`lib/` + `extension/` 都改了 → 重启 `dsh web` + 重载 Chrome 扩展。**
>
> **可复用的排查手段（本轮新增）**：`%TEMP%\panel-preview\shoot.mjs` ——
> 一个自持生命周期的截图/量测工具（自己起 `preview.mjs`、跑无头 Chrome、读 `#geometry` 探针、最后收尾）。
> **必须自持**：从 pwsh 后台任务起的预览服务会在任务结束时被杀，之后每次量测都静默得到空 DOM（本轮在这上面白跑了一轮）。

> ### v27：切换会话时，上一个会话的东西跟着过来了（扩展侧，本次修复）
>
> **v26 的结论是「状态切换时不重绘是系统性缺陷来源」，那轮查 `view` 维度；这轮查**会话切换**。**
> `selectSession()` 清了 `expandedReasoning`/`drawnSignature`/`transcript`/`stickToBottom`，
> 但没清三样属于**被离开的那个会话**的东西：
>
> | 没清的状态 | 后果 |
> |---|---|
> | `live`（流式块） | **上一个会话正在输出的文字，画在新会话的转写稿上** |
> | `pendingApproval`（审批卡） | 卡片跟过来，两个按钮要回答新会话**从没问过**的问题 |
> | `mentioned`（`@` 提及） | 那条提及会挂到**下一条消息**上，而它从没被选中过 |
>
> `applyDelta` 有会话守卫，**但切换会话不经过 `applyDelta`** ⇒ `live` 原样留着，守卫形同虚设。
> **为什么会漏**：`live` 是唯**一带着 `sessionId` 字段的状态**，而**没有任何渲染器比对它** ——
> 字段存在、没人读，与 v23/v24「短 URL 当成了 URL」是同一类：
> **看起来在传递身份的信息，其实没被任何判据使用。**
>
> **修法两层**：① `selectSession()` 清 `live`/`pendingApproval`/`mentioned`；
> ② **`adoptOpenApproval` 只采纳当前会话的问题** —— 只做 ① 不够，宿主的 health 报告**所有**
> 未决问题，切换后 `adoptFromLastHealth` 会**立刻把别会话的卡重新领养回来**。
> **第 ② 层是证伪 `scope` 那次才逼出来的。**
>
> **测试**：会话切换此前**零覆盖**（夹具的会话列表只有一个会话，「切换」不可达）。
> 已加第二个会话，并用**点击历史列表的行**来切换（唯一入口）。
>
> **证伪五次，每次红的组合都不同**：全部不清 → 5 红；只不清 `live` → 1 红；
> 只不清 `pendingApproval` → 1 红；只不清 `mentioned` → 3 红；采纳不按会话过滤 → 1 红。
> **测试 383 → 386**。
>
> **顺带踩到的测试坑（值得记住）**：`#title` 是**切换**（toggle），不是「打开历史」。
> 第一版 `switchTo` 助手按「当前是否在对话」决定点不点，测试若恰好停在历史视图就会**往反方向切** ——
> 三个新测试 + 两个既有测试同时变红，看起来像产品坏了，实际是助手把面板留在了错误视图。
> **切换型控件不能用「条件点击」伪装成「设为某值」；要么先读状态再决定点几次，要么直接断言最终状态。**
>
> **交付：只改 `extension/` ⇒ 重载 Chrome 扩展即可。**

> ### v26：看着「历史」视图时，正在流式输出的回答被丢掉（扩展侧，本次修复）
>
> **v25 只修了一半。** 同样的形状在面板里**一共四处** —— 凡是 `view === 'chat'` 才画的东西，
> 在历史视图下都不画，而 `showView()` 不重绘：
>
> | 渲染器 | 历史视图下 | 后果 |
> |---|---|---|
> | `renderWorking`（等待行） | `existing?.remove()` | 切回来「思考中…」不见 |
> | `renderLive`（流式块） | **`existing?.remove()`** | **正在流式输出的回答被丢掉** |
> | `renderApproval`（审批卡） | `existing?.remove()` | v25 已修 |
> | `updateToBottom`（回到底部键） | `hidden = true` | 见下（**量过，不用改**） |
>
> **最严重的是 `renderLive`**：它不只**不画**，而是**删掉已在屏幕上的节点**。
> 历史视图打开期间模型流进来的每个字都被丢弃 ⇒ 回合还在跑时要等下一个 token 才重现；
> **回合已结束时 `refreshTranscript` 之前什么都看不到**。
>
> **修法**：`showView()` 在**两个方向**都重绘这三个渲染器。
> **为什么两个方向都要**：进入历史时若不重绘，节点会**留在 DOM 里**
> （`transcript.hidden = true` 只隐藏、不删除），切回来时与新画的重复。
> **这一点是证伪抓到的** —— 第一版只修「返回」方向，`noLeave` 证伪红了 2 条。
>
> **顺带量掉一个我担心的问题（结论：不用改）**：`updateToBottom` 读
> `transcript.scrollHeight` / `clientHeight`，历史视图下它们是 0，我担心切回来时布局未就绪。
> **真实浏览器实测**：`un-hide 后同一 tick: 599x529；强制回流后: 599x529` ⇒ 同一 tick 布局即可用，
> **没有为它做任何改动**。
>
> **证伪**：完全不重绘 → 3 红；不重绘等待行 → 2 红；只重绘「返回」方向 → 2 红。
> **三个测试各红各的**，说明钉的是不同东西。
>
> **测试 381 → 383**。**交付：只改 `extension/` ⇒ 重载 Chrome 扩展即可。**

> ### v25：看着「历史」视图时被问到审批，回合永远卡住（扩展侧，本次修复）
>
> **症状**：这正是用户最早报的「dsh 在等待审批…然后就卡住了」。v13 把审批卡片做进了侧边栏，
> 但**只要当时面板停在「历史」视图，卡片永远不会出现**。
>
> **根因**：卡片由健康轮询里的 `adoptOpenApproval()` 领养，而它第一行是
> `if (view !== 'chat') return`。**这个判断是对的**（卡片属于对话，画在历史上没有意义），
> **错的是另一半**：切回对话时 `showView()` **什么都不做**。健康轮询 5 秒一次 ⇒
> 下一次领养要等最多 5 秒，**在那之前对话是冻结的**。
>
> **修法**：新增 `lastHealth`（留住最后一次健康回答），`showView('chat')` 时立刻
> `adoptFromLastHealth()` 重新领养一次。
> **为什么不留着等下一次轮询**：5 秒的冻结对话与「坏了」不可区分。
>
> **测试写法（视图切换此前零覆盖）**：点 `#title` 打开历史 → 宿主报告未决问题 →
> 断言**历史下没有卡片**（确认那个判断仍生效）→ 再点一次切回 → 断言**卡片在**。
>
> **证伪**：`showView` 不重新领养 → 1 红；`refreshHealth` 不保留回答 → 1 红。
> **测试 380 → 381**。
>
> **本轮验证目标被环境挡住，如实记录**（探针**没有 provider 凭据**、**没有扩展连着**）：
> - **审批**：需要一个真调用需审批工具的回合，探针上做不到（回合在调用工具前就因
>   `MISSING_CREDENTIAL` 失败；`#notify` 必然失败走 `undeliverable`）⇒
>   `asked`/`delivered`/`byPanel` 永远是 0。**能验的防御分支已验**：
>   不存在的 id 与非法 outcome 都返回 `409 {"answered":false,…}`，`refused` 由 0 正确涨到 2。
> - **停止（实测到的边界，不是缺陷）**：对**没有回合在跑**的会话按停止，宿主返回
>   `{"cancelled": true}` —— `cancel(request)` 里 `agent.cancel(...)` 之后**无条件**
>   `return {accepted:true}`。面板据此切回发送键、清掉「思考中…」。
>   **「宿主说停下了」≠「刚才确实有回合在跑」**，别再当 bug 修。
>
> **交付：只改 `extension/` ⇒ 重载 Chrome 扩展即可。**

> ### v24：`@` 提及之后的三个缺陷（扩展侧，本次修复）
>
> v23 让一条**此前只有单一来源**的路径变成了两个来源。这一轮把它走到底，发现三个缺陷，
> **三个都是同一类：面板说的话和它做的事不一致。**
>
> **① 提及的正是当前标签页时，面板画两个 chip，宿主只收一个。**
> `@` 候选按 recency 排序，而**当前标签页就是最近访问的那个** —— 所以「选到当前页」是顺手就会犯的错。
> 宿主去重键是 `kind + url + text`，同 URL 只留一条 ⇒ **面板承诺 2 个、实际送 1 个**。
> 修法：新增 `mentionAddsSomething()`，`renderContexts` 与 `pendingAttachments`
> **共用它**（「显示什么」与「送什么」不可能分叉）；**提及 URL 为空时算「有内容」**。
>
> **② 候选行把「显示用的短 URL」当成了 URL 本身（这是 ① 修不好的原因）。**
> `mentionRows` 返回的 `url` 曾是 `shortUrl()` 的结果（`dl.acm.org/doi/…`），
> `acceptMention` 把它整个存进 `mentioned` ⇒ ① 的比较**永远不相等**，守卫形同虚设。
> 修法：拆成 `url`（**真实 URL**，会跟着消息走）与 `where`（**画出来的短形式**）。
>
> **③ `stageRequested` 零测试覆盖** —— 补 5 条（两附件都到达、同页只留一条、
> 拒绝时报告原因且不牵连其它、无会话全拒、未知 `kind` 降级为 `tab`）。
>
> **端到端实测**：发两个 `kind:'tab'` 附件 ⇒ `staged: 2, refused: []`；
> 解开会话日志确认**模型真的收到两条**（各带 `Source:` 行）。
> **日志解码手法**：多个 zstd frame 拼接，**必须按 magic `28 B5 2F FD` 切分逐帧解压**。
>
> **一个「不修」的判断（数字难看但留着）**：每个附件 **342 字符里 338 是样板**
> （`[Attached from the browser by the user]` + 三行「这是数据不是指令」+ 分隔线），
> 真正内容只有 `tab from github.com` 那一行。**不修的理由**：上下文窗口 1,000,000 tokens，
> 这段约 100 tokens；而它是**提示词注入防护** —— 页面内容是用户指过来的不可信数据。
>
> **证伪**：`pendingAttachments` 去守卫 → 1 红；`renderContexts` 去守卫 → 1 红；
> 候选行用短 URL 当 `url` → 3 红。
>
> **测试 372 → 380**。**顺带修好测试基础设施两处盲区**：
> ① `test/dom-shim.js` 没有 `selectionStart` / `setSelectionRange`，也没让写 `value` 移动光标 ——
> 而 `@` 提及全靠读「光标前那段文字」，缺了它们每条提及测试都报一个与提及无关的 `TypeError`；
> ② 测试**共享一个面板实例**，前面留下的选区让 chip 数从 2 起步 ⇒
> 断言改成**比较增减量**而非绝对值。
>
> **交付：只改 `extension/` ⇒ 重载 Chrome 扩展即可。**

> ### v23：`@` 提及 —— 不用切标签页也能引用别的页面（扩展侧，本次新增）
>
> **要解决的问题**：在此之前能挂进消息的只有**当前标签页**。开着二十个标签页、想引用第三个时，
> 唯一办法是切过去——而切过去就丢掉了你正在读的那一页。
>
> **一手依据**：官方候选是
> `{ faviconUrl, browserFamily, lastOpened, tabId, snapshot: { title, url }, source: 'extension' }`，
> 菜单**分组**（`Tabs` / `Sites` / `Files` / `ChatGPT conversations`…），文案含 `{title} {url}`。
> 排序走一个完整的 fuzzy scorer（`score-query-match`，9762 字节的 VS Code fuzzy matcher）。
> **抄判据不抄算法** —— 侧栏负担不起 9.7KB 打分器，而子串匹配对真实输入行为相同。
>
> **新增 `extension/mention.js`**（纯函数，可脱离 DOM 测试）：
> `mentionAt(before)`（`foo@bar` **不算**提及；空格**关闭**它）、
> `mentionable(tab)`（**按协议白名单**：`chrome://`/`chrome-extension://`/`about:` 不提供 ——
> **提供一个是「发出去才发现读不了」，比不提供更糟**）、
> `rankTabs(tabs, query, limit)`（**按 `lastAccessed` 降序**；**标题命中优先于 URL**；
> 没有 `lastAccessed` 的排**最后**而非当成时间起点冲上去）、
> `shortUrl(url)`、`mentionMenu(tabs, query)`（**`'empty'` 与 `'none'` 分开** ——
> 区别是「再打几个字也没用」）、
> `mentionRows(tabs)`（**两个同名候选时才显示 URL**；八行一样的菜单比没有更糟）。
>
> **`sidepanel.js` 的接线要点**：`drawMention()` **读输入框而不是跟踪状态**
> （菜单因此不可能和文字不一致）；菜单打开时方向键/Enter/Tab/Escape **归它管**
> （否则 Enter 会发出「半截提及」的消息）；`acceptMention()` 把 `@word` **整段删掉**
> （留 `@net` 会让模型收到看不懂的词，附件已说清是哪个页面）；
> `mentioned` 与 `currentTab` **分开**（「你面前的页」vs「这条消息说的页」），两个都能挂；
> **发送后清空**（否则同一页会静默挂到下一条上）。
>
> **实测（无头 Chrome 截图 + `--dump-dom`）**：`@` 空查询 6 条按 recency；
> **`chrome://extensions` 不出现**；两个同名 `Pruning notes` **都带 URL**、其余**不带**；
> `@prun` 收窄到 2 条；`@zzzz` 显示「没有匹配的标签页」且**菜单不关闭**。
>
> **证伪**：去掉协议白名单 → 2 红；去掉 recency → 2 红；`showUrl` 恒 false → 1 红。
>
> **测试 360 → 372**（新增 `test/mention.test.js` 12 条）。其中一条断言
> `mention.js` **不引用 `document`/`window`/`chrome`/`fetch`** ——
> 面板跑在 `chrome-extension://` 源、无法 import 扩展目录外的文件，纯净才能被测。
>
> **交付：只改 `extension/` ⇒ 重载 Chrome 扩展即可。**

> ### v22：量了端到端延迟 —— **没有找到缺陷**（本轮无代码改动）
>
> **本轮目标**：量「按下发送 → 看到第一个字」的实际耗时。**结论是宿主不是瓶颈，
> 我没有找到值得修的东西**，如实记录，不硬造改动。
>
> **宿主路由实测**（探针实例，每条 7 次取分布）：
>
> | 路由 | 触发 | 最小 | 中位 | 最大 |
> |---|---|---|---|---|
> | `GET /chat`（会话列表，5s） | 每 5s | 8.6ms | 10.3ms | 40.4ms |
> | `GET /health`（5s） | 每 5s | 1.1ms | 1.2ms | 2.6ms |
> | `POST messages`（8s） | 每 8s | 1.2ms | 1.4ms | 18.6ms |
> | `POST models`（开面板一次） | 一次 | 1.1ms | 1.2ms | 2.0ms |
>
> ⇒ 全部毫秒级，**「到第一个字」的时间几乎全部来自模型本身**。
>
> **一次发送引起 7 次 transcript 重读**（实测 `at=0,1200,3200,6436,7200,14200,14436`）：
> 5 个定时器 `[800,2000,4000,8000,15000]` + `end` 帧一次 + 发送被接受时一次。
> **但它不造成可见影响**：`drawTranscript` 在 `signature === drawnSignature` 时
> **直接 return 不碰 DOM**。**不建议为省请求删掉这 5 个定时器** ——
> 它们是「旧宿主没有流式」时的唯一更新途径。
>
> **本轮真正留下的东西是工具**（都在 `%TEMP%\panel-preview\`，不进仓库）：
> - `measure.mjs` —— 量各路由的最小/中位/最大。
> - 预览场景 `?s=cost` —— 数「一次发送读了几次 transcript」，结果写进 `#cost` 供 `--dump-dom` 读。
> - **`preview.mjs` 新增 `assertNoBackticks()` 守卫**：`stub` 是模板字符串，
>   在里面写反引号会让整个文件不可解析 —— 这个错误**犯过 7 次**，每次都让我在
>   **半渲染的页面上量了好几轮**（body 只剩 `⌄ ⌄`）。
>   守卫的细节值得记住：它读**源码行**而不是构造后的字符串
>   （构造后 `${...}` 已被替换，而场景表里的 Markdown 含代码围栏，是数据不是语法），
>   而且**必须 `split(/\r?\n/)`** —— 文件是 CRLF，闭合行是 `` `\r ``，
>   用 `indexOf('`')` 永远找不到。
>
> **交付**：本轮只改文档，**不需要重载扩展或重启宿主**。
>
> ### v21：按下发送后，自己那句话消失了（扩展侧，本次修复）
>
> **症状**：按下发送，输入框清空、按钮变停止、显示「思考中…」——
> **而刚打的那句话在屏幕上不存在**。
>
> **怎么发现的**：本轮本想量端到端延迟，追发送路径时读到
> `input.value = ''` 之后紧跟 `for (const delay of [800, 2000, 4000, 8000, 15000])` ——
> **中间 800ms 没有任何东西把用户的消息画到屏幕上**。而且不只是延迟：
> 宿主在这 800ms 内没答上（回合失败、宿主重启）⇒ **那句话再也不出现**。
>
> **实测手法（可复用）**：预览宿主新增 `?s=gapsend` 场景，让宿主**接受发送但 transcript 不变**，
> 精确复现那个窗口；对照 1200ms 时刻的真实渲染，修复前消息不存在、修复后有气泡。
> **静态场景看不见这个状态，只有真按一次发送才能。**
>
> **修法：乐观回显** —— 发送被接受后立刻
> `drawTranscript([...rows, { kind: 'user', text }])`。
>
> **为什么这不是说谎（承重设计）**：`rows` 仍只保存**宿主上次给的行**，回显只进这一帧绘制、
> 不进 `rows`；下一次 `refreshTranscript` 用宿主列表**整体替换**，回显随之消失
> ⇒ 宿主没真的收下时，回显活不过一次重读，**不可能变成假记录**。
> 有测试钉住：写回显 → 宿主列表不含它 → 触发重读 → 断言它已消失。
>
> **证伪**：去掉 `drawTranscript([...rows, ...])` → 2 红。
>
> **测试 358 → 360**。既有 `sending swaps the same slot to stop` 断言了输入框清空、
> 按钮变停止、消息到达宿主，**唯独没有断言消息出现在屏幕上**——这就是缺陷活到现在的原因。
>
> **交付：只改 `extension/` ⇒ 重载 Chrome 扩展即可。**

> ### v20：选区的完整文本在面板里根本读不到（扩展侧，本次修复）
>
> **症状**：第二个 chip 写着 `选中内容 · 这种剪枝方式会移除…`。发送时送的是**全文**，
> 但屏幕上只有一段截断，而**旧 chip 没有 `title`** —— 想知道「会送出去什么」，
> 只有真的发出去这一条路。
>
> **本轮最该记住的：我原本以为的问题，和实测出来的是两回事。**
> 我上轮说「去掉前缀能多显示一截」，量完发现：
>
> | 版本 | label 宽 | 字符数 | 可见 | 真实内容 | 悬停看全文 |
> |---|---|---|---|---|---|
> | 改前 | 337px | 47 | **30** | 25 字（5 字前缀） | **不能** |
> | 改后 | 328px | 56 | **27** | **26 字** | **能** |
>
> **宽度收益没兑现，可见字符还少了 3 个**：旧版硬截 39 字再交给 CSS，新版把全文交给 CSS，
> 前缀省下的 60px 被「多出来的 17 个字」吃光，净效果只有 1 个字。
> **所以真正的修复是 `title` / `aria-label` 带全文 —— 那 29 个看不见的字从此可达。**
>
> **顺带删掉双重截断**：`text.slice(0, 39)` 是按**字符数**截，而 39 个 CJK 字形宽度约是
> 39 个拉丁的两倍，这个数字从没对上它所在的框，结果是 JS 截一次、CSS 再截一次。
> 现在只有 CSS 截，因为只有 CSS 知道宽度。
>
> **改动**：label 直接放 `currentSelection.text`；前缀的意思交给 `<span class="mark">“`（`aria-hidden`）；
> `chip.title` / `aria-label` = `${t('context.selection')} · ${全文}`；
> `.chip .mark { flex:none; color:var(--tertiary); font-family:Georgia,serif; line-height:1 }`。
> **`×` 保留**——它是唯一明确的「这次不送选区」途径。
>
> **证伪**：前缀加回来 → 3 红；去掉 `chip.title` → 2 红。
>
> **测试 355 → 358**。**选区 chip 此前零覆盖**（夹具让 `chrome.tabs.query` 返回空数组，
> 两个 chip 都没被测过；v19 修了 tab chip，本轮补选区 chip）。
>
> **交付：只改 `extension/` ⇒ 重载 Chrome 扩展即可。**
>
> **本轮的方法教训（浪费了约 8 轮工具调用）**：`%TEMP%\panel-preview\preview.mjs` 里
> `stub` 是一个模板字符串，**我加注释时在里面写了反引号**，`node --check` 报语法错，
> 但我用 `$LASTEXITCODE` 判断时**在错误的时机读它**（赋值语句之后读到的是别的命令的退出码），
> 于是以为语法没问题。症状是**页面半渲染**（body 只有 `⌄ ⌄`），而我继续在坏页面上量了多轮。
> **判据：`$r = node --check f 2>&1; if ($LASTEXITCODE -ne 0) { $r }` —— 先存输出再判。**
> 另外**杀预览服务要按 `CommandLine -match 'preview\.mjs'` 杀**，
> `Get-NetTCPConnection` 报的 owner 可能是另一个我起的实例 —— 我因此量了很久的旧代码。

> ### v19：那个 chip 把宽度花在标签上，然后截断标题（扩展侧，本次修复）
>
> **症状**：底部 chip 在每个截图里都是
> `当前标签页 · Network Edge Inference for Large Language Mo…` ——
> **宽度花在「当前标签页 · 」上，然后截断读者真正要看的标题。**
>
> **量化**（`--dump-dom` + 探针量，不是目测）：392px 面板下 label 拿到 **360px**、
> 标题需要 **400px**，前缀正好吃掉缺的那 40px。
>
> **一手依据**：官方 `at-mention-list-D3gGVteY.css` 全文只有 154 字节：
> `._CompactSource_3pdaq_2{display:var(--display-icon-compact,contents)}` /
> `._LeadingSource_3pdaq_6{display:var(--display-icon-leading,none)}`，
> 而 `--icon-leading-size: calc(var(--spacing) * 5)` = 16px。**它用图标代替文字。**
>
> **修法**：`currentTab` 加 `icon`（取 `active.favIconUrl`）；新增 `faviconOf(tab)`
> **按协议白名单**（`^(https?|data):`）而非黑名单 `chrome:` —— 想不到的协议降级成
> 「没图标」而不是「破图」；chip 有图标时先放 `<img class="site">`，label 只放标题，
> **完整名字移到 `title` 与 `aria-label`**；favicon `error` 时自我移除；
> CSS `.chip .site{width:14px;height:14px}` —— **14 而非官方的 16**：
> chip 文字 12px，16px 图标比行高更高会让胶囊鼓包。
>
> **实测**：label 文本由 `当前标签页 · Network Edge…` 变为 `Network Edge…`；
> 可用/需要 由 360/400 变为 **300/325**；渲染由 `…Language Mo…` 变为
> **`…Language Models`（完整）**；320px 窄面板同样正常（chip 共 300px）。
>
> **被自己的守卫挡住的真 bug**：`faviconOf` 第一版只认 `http(s)`，于是 `data:` 图标被丢，
> `<img>` 一个都没渲染。真实 Chrome 里 `favIconUrl` 确实可能是 `data:`（页面声明内联图标），
> **所以这是真的过窄**，不是预览的人造问题。
>
> **证伪**：图标分支短路 → 2 红；白名单收窄回 `http(s)` → 1 红（正是 `data:` 那条）。
>
> **测试 352 → 355**。顺带发现桩的不真实处：`chrome.tabs.query` 原本返回空数组，
> **chip 从来没被测过**；给上 tab 后 `start()` 会去问页面要选区，而桩的 `sendMessage`
> 返回 `{}` ⇒ 面板正确判定「上报脚本失联」并提示刷新。**行为对、桩错**，
> 改成返回 `{ text: '', url, title }`。
>
> **交付：只改 `extension/` ⇒ 重载 Chrome 扩展即可。**

> ### v18：连点两次「＋」会建出两个会话，其中一个变成孤儿（扩展侧，本次修复）
>
> **症状**：`＋` 发起一个网络往返，但**期间按钮不禁用、也没有 in-flight 状态**。
> 连点两次 ⇒ 宿主建出**两个会话**，面板只认领一个，另一个留在列表里、
> **没有任何东西解释它是哪来的**。
>
> **实测**（探针，隔离 `DSH_HOME`）：连发两次 `POST {action:'create'}` ⇒ 两个不同 sessionId，
> 列表从 2 个会话变成 4 个。
>
> **为什么这个修、模型切换的同类竞态不修**——判据是**副作用是否永久**：
>
> | 动作 | 重复的后果 | 自愈？ |
> |---|---|---|
> | `＋` 新建会话 | 多出一个会话（宿主每次 mint 新 id） | **否**，孤儿永久留下 |
> | 切换模型 | 面板本地记下过期的那次响应 | **是**，`refreshGroups` 每 5 秒从宿主读回真实状态 |
>
> 模型切换确有竞态（面板按「谁先回来谁写本地」，宿主按「谁后完成谁生效」，
> 顺序相反时短暂显示错值），但 5 秒内自愈，加互斥会让本该即时的操作多一层等待。
> **没有证据表明它有害，就不加。**
>
> **修法**：`let creating = false` + `newSession()` 里 `if (creating) return`，
> 用 **`try/finally`** 释放（宿主拒绝时若不释放，按钮就再也按不动了）；
> 新增 `drawNew()` 与既有 `drawSend()` 对称（**谁决定状态谁负责画**）：
> `newButton.disabled = creating` + `aria-busy`；拆出 `createSession()` 承载原逻辑。
> 视觉沿用既有 `.icon:disabled { opacity: .4 }`，不新增样式。
>
> **证伪**：去掉 `if (creating) return` → 1 红；`drawNew` 不设 `disabled` → 1 红（同一条）。
>
> **测试 349 → 352**。新增 3 条；为此给测试宿主加了 `holdCreate`/`releaseCreate`
> ——**这是唯一能观察到 in-flight 窗口的办法**，其他路由都立即返回，
> 只存在一个 microtask 的状态无法断言。
>
> **交付：只改 `extension/` ⇒ 重载 Chrome 扩展即可。**

> ### v17：一个回合进行中，面板把「它在干活」说了两遍（扩展侧，本次修复）
>
> **症状**（用户最早那句「怎么跳出来这么多莫名其妙的东西」的最后一块）：
> 一个回合进行中，**两处在同时报告状态**——
> 推理阶段是「思考 ⌄」+「思考中…」两行；回答开始流式输出后是 `看完了。▌` + 「思考中…」，
> 即**回答已经在写了，下面还说它在思考**。
>
> **为什么前几轮看不见**：v16 之前只看**已提交的行**。重叠只存在于流**打开的时候**，
> 一提交就消失。本轮先在预览宿主加了三个真实时序场景
> （`?s=waiting|thinking|streaming`，用 `dsh-assistant-delta` 按 160ms 逐条投递）才看到。
> **教训：静态场景看不见时序缺陷。**
>
> **根因**：`renderWorking()` 与 `renderLive()` 是**两个渲染器报告同一个事实**，
> 前者只看 `currentSessionRunning`，不知道后者已经有话可说。
>
> **修法（每阶段只有一个东西在说话）**：
> 1. `renderWorking` 只在 `live` **还没有任何内容**（`text` 与 `reasoning` 都空）时画等待行。
> 2. 推理阶段交给 live 块自己说：`.live-think` 由「标签 + 段落」改为**一行**
>    （`nowrap` + `ellipsis`）。**一手依据**：官方面板把 `Thinking` 与预览放同一行，
>    其推理预览 `maxHeightByState` 三态都是 `8.75rem`——是**限高**不是另起一行。
> 3. `.live-body:empty::after { display: none }`：推理阶段 body 无文本，
>    闪烁竖线是**空行上的光标**，指不到任何东西。
>
> **顺带修掉我自己引入的真缺陷**（证伪时抓到）：`sendMessage()` 设
> `currentSessionRunning = true` 后调 `renderWorking()`，**却没清上一轮的 `live`**。
> 上一轮的 live 靠 `end` 帧或 `done` 清，而用户主动发新消息时两条路都不走
> （宿主重启、中途重载面板都会留下 stale `live`）。残块既显示**上一轮的文字**，
> 又因 `hasContent` 为真而**压掉等待行** ⇒「发了消息却看不出在跑」。
> 修法：`sendMessage` 里显式 `live = null; renderLive()`。
>
> **实测（无头 Chrome 截图）**：`waiting` 一行「思考中…」且**无空光标**；
> `thinking` **一行**「思考」+ 预览（超长省略号截断）；`streaming` 只有 `看完了。▌`。
>
> **证伪**：`renderWorking` 判据去掉 `&& !hasContent` → 3 红；
> `sendMessage` 去掉 `live = null` → **2 红，红的正是 stop 路径那两条**（残留 live 会压掉等待行）。
>
> **测试 347 → 349 passed / 0 failed**（新增 3 条，改写 4 条钉住「两行同显」的旧断言）。
>
> **交付：只改 `extension/` ⇒ 重载 Chrome 扩展即可，不需要重启 `dsh web`。**

> ### v16：失败信息把 provider 的开发者日志原样贴给用户（宿主 + 扩展，本次修复）
>
> **症状**：v15 让失败回合开口了，但说的是 `llm-deepseek: no API key for provider route
> "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service, or export
> DEEPSEEK_API_KEY in the launching environment` —— 在 360px 面板里红字铺满四行，
> 英文、含环境变量名、教用户改配置文件。**这不是提示，是日志**，正是用户抱怨的
> 「为什么有这么多提示性文字」的最糟形态。
>
> **怎么发现的**：本轮第一次把面板真的渲染出来看（无头 Chrome 截图 + `read_image`），
> `failed` 场景一眼就是那样。**此前的轮次只靠用户截图，看不见自己造的东西。**
>
> **根因**：失败信息带两样东西 —— `message`（写给读日志的人）与 `code`（机器可判断）。
> 原实现**只带 `message`**，`code` 在**三个地方各丢一次**：
> `deltaOfFrame` 只取 `reason.failure?.message`；relay 的 `#send({sessionId, kind:'failed'})`
> **按 `kind` 重建 payload**（最容易漏，因为它不碰 `deltaOfFrame`）；`describeEvents` 的
> `turn/end` 分支同理。面板因此除了贴日志别无选择。
>
> **修法：`code` 决定句子，`message` 降级成细节。**
> 1. `lib/stream.js` 的 `deltaOfFrame` 返回 `{kind:'failed', text, code}`；relay 那一跳补
>    `...(delta.code === undefined ? {} : { code: delta.code })`。
> 2. `lib/chat.js` 的 `turn/end` 分支同样带 `code`，否则**冷重放/重载后又退回原始日志**。
> 3. **新增 `extension/failure.js`**（纯函数，可脱离 DOM 测）：`failureSentence(code, t)`
>    映射 12 个宿主错误码，`failureDetail(text)` 把原话压成一行。
>    **必须放 `extension/` 而不是 `lib/`**：面板跑在 `chrome-extension://` 源，
>    **无法 import 扩展目录外的文件**（v7 踩过同一个坑）。
> 4. 面板两处都用句子：实时 toast 用 `failureSentence(payload.code, t)`
>    （**toast 是贴日志最糟的位置**：几秒消失、不能选中、不能搜索）；
>    持久行 `.failure` 放句子、`.failure-detail` 放降级原话。
>
> **没有命中的码回落到 `error.turnFailed`，不是回落到 message**：通用句子信息更少，
> 但是读者看得懂的语言、且不会在文件路径中间断掉；原话留在 `.failure-detail` 里。
> **没有 `code` 时连 detail 都不渲染。**
>
> **布局坑（截图抓到，测试抓不到）**：`.row` 是 `display:flex`，句子与细节变成**并排两列**，
> 「模型还没配置密钥」被挤成一列一个字。修法 `.row[data-kind="failed"]{flex-direction:column}`
> 并加回归测试 —— 这种错看代码看不出来。
>
> **本轮的方法突破：无头 Chrome 截图**（用户浏览器全程未碰，用户原话「不要影响到我正在使用浏览器」）：
> ```powershell
> & "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --disable-gpu `
>   --user-data-dir="$env:TEMP\panel-preview\chrome-profile" --window-size=392,812 `
>   --virtual-time-budget=8000 --screenshot="out.png" "http://127.0.0.1:3399/?s=failed"
> ```
> 配 `read_image` 读回 PNG ⇒ **像素级缺陷自己就能看见**。宿主在 `%TEMP%\panel-preview\preview.mjs`
> （复制 `extension/` 五个文件、注入最小 `chrome.*` 桩与打桩 `fetch`，3399 端口，
> `?s=chat|failed|failedBare|empty|working|approval|long|history`，`?w=` 指定面板宽度）。
> **几何要「量」不要「看」**：headless Chrome **不遵守 `--window-size` 的布局**（按 500x717
> 排版再裁图），所以右侧相对时间看着像被切掉。预览改为按 `?w=` 固定宽度，用 `--dump-dom`
> 读回 `body.scrollWidth` —— 实测 392 与 320 下都等于面板宽度，**没有溢出**；
> 历史视图在 320px 下分组、相对时间、当前会话高亮、空会话隐藏全部正常。
> **预览宿主自身的三个桩错**（不是产品缺陷，但各会浪费一轮）：`running` 来自**会话列表**
> 不是 messages 响应；`approvalPending` 每项**必须带 `sessionId`**；模型目录要包成
> `payload.catalog`。
>
> **实测**：探针发一条必然失败的请求 ⇒ health `stream.failed` 0 → **1**；回读 2 行
> `kind=user code=(无)` + **`kind=failed code=MISSING_CREDENTIAL`**；渲染为红字
> 「模型还没配置密钥」+ 灰字原话（截图确认）；无 `code` 的失败只显示「这一轮没能跑起来」。
> 用户线上 3080 全程只读，其 `stream` 出现 `failed` 字段 ⇒ 用户已重启，v15 生效。
>
> **证伪**：`failure.js` 不映射 `MISSING_CREDENTIAL` → 3 红；relay 不转发 `code` → 3 红。
> **测试 325 → 347 passed / 0 failed / 0 skipped**。其中 **7 条原本变红是对的**——
> 它们断言的正是「把日志原样贴出来」这个已错行为（含 `panel-i18n` 的死键扫描：
> 新键在 `failure.js` 里，必须把该文件加进扫描名单）。
>
> **交付：`lib/` + `extension/` 都改了 ⇒ 重启 `dsh web` + 重载 Chrome 扩展。**

> ### v15：回合失败长得像「模型没话说」，因为我第一次找错了信号（宿主 + 扩展，本次修复）
>
> **症状**：请求被拒（无 API key／路线不可达／额度用尽）时，侧边栏的「思考中…」只是停下，
> 什么也不说——已提交的输入孤零零留着，看起来像模型选择沉默。
>
> **第一次修错了，错法必须记住。** 第一版推理：end 帧带 `outcome`，成功 `{kind:'committed'}`、
> 抛出 `{kind:'abandoned'}`，所以把 `abandoned` 当失败判据，测试夹具也照这个假设造，**全绿**。
> 之后在真探针上发了一条必然失败的请求，health 报 **`ends:1, failed:0`** —— 判据从未触发。
>
> **真实形状**（解码 `session.v3.jsonl.zstd` 拿到；日志是多 zstd frame 拼接，
> **必须按 magic `28 B5 2F FD` 切分逐帧解压**，`zstdDecompressSync` 只解第一帧）：
> 19 条事件里**没有任何 `assistant/message`**；`assistant/attempt` 的 `stream` 是**一个 `finish` chunk**
> `{"type":"finish","reason":{"kind":"error","failure":{...,"code":"MISSING_CREDENTIAL"}}}`；
> `turn/end` 带 `reason={kind:'error',error:{message,code}}`。
>
> **为什么 `outcome` 承载不了失败**：`dsh-agent-loop/lib/index.js:1080-1095` 在 `finish.kind==='error'`
> 时**先** `live.settle('assistant/attempt', …)`，而 `settle()`（`:420-440`）置 `terminal=true`；
> 只有 `:1119` 的 `if (!live.ended) live.abandon()` 才发 `abandoned`，它被上面那步挡住。
> 于是失败回合发的是 `{kind:'committed'}`，**与成功逐字节相同**。
> 真正的实时信号是被我丢进 `ignored` 的那个 `finish` chunk（`dsh-llm/lib/index.js:2337`
> `adapterFailureChunk` 的注释写明：适配器抛出会转成终态 `error`/`aborted` finish chunk）。
>
> **修法两层，都建在实测形状上**：
> 1. **实时** — `lib/stream.js` 的 `deltaOfFrame` 新增 `kind:'failed'`（`chunk.type==='finish'` 且
>    `reason.kind==='error'` ⇒ `{kind:'failed', text: message}`）；relay 新增 `failed` 计数并在同一跳
>    把 `text` 一起送达（**从 `kind` 重建 payload 会第二次丢掉原因**）；面板分支**必须放在
>    `if (live === null) return` 之前**，说宿主原话、无原因时回落 `error.turnFailed`。
>    `reason.kind==='aborted'`（用户按的停止）**不算失败**。
> 2. **持久** — 失败回合不提交 assistant 消息，所以 `lib/chat.js` 的 `describeEvents` 新增 `turn/end`
>    分支：`reason.kind==='error'` 才产出 `{kind:'failed', text}` 行（`FAILURE_TEXT_MAX=160`），
>    `aborted` 与正常结束都不产出；面板画成一行 `.failure`。
>    **没有这层，重载面板后失败又消失**——同一类缺陷藏在持久层。
>
> **实测（隔离 `DSH_HOME` 的探针，用户 3080 全程未碰）**：修复后 health 由
> `{frames:3,ignored:1,…ends:1,failed:0}` 变为 `{frames:3,ignored:0,…ends:1,failed:1}`；
> 热读 2 行（`[user]` + `[failed]` 带 provider 原话）；**冷重放同样 2 行**（重启探针后）；
> 已装副本（非 junction）同样带 `failed` 字段与 2 行。
>
> **证伪三次**（先 `node --check`，并比字节数确认真的改到了）：`finish` 分支短路 → 4 红；
> `turn/end` 分支短路 → 3 红；面板 `row.kind==='failed'` 短路 → 2 红。
>
> **顺带修掉测试基础设施的盲区**：`test/dom-shim.js` 的 `matches()` 原本只认 tag/`.class`/`#id`，
> 遇到 `[data-kind="failed"]` **静默返回「不匹配」而不是报错**，断言变成对空气断言。
> 已补 `[attr]`/`[attr="value"]` 与复合选择器。**教训：选择器看不懂就静默不匹配，
> 让测试红得莫名其妙，也让本该抓 bug 的断言永远为真。**
>
> **顺带修掉一个与本插件无关、但会炸用户环境的 P0**：用户 profile 的 `cordis.patch.yml`
> 重复 insert 了 `ui-agent-team`，而官方 bundle `dsh-experimental-agent-team-web-profile`
> 自己已经 insert 了同一个 id ⇒ `duplicate loader entry id: ui-agent-team`，**下次 `dsh web`
> 重启必崩**（3080 当时跑的是旧树，侥幸）。已按用户选择删掉 profile 里重复的那段（保留
> `mcp-everything`），用隔离 `DSH_HOME` + 真实配置验证能正常启动。备份在
> `%TEMP%\cordis.patch.yml.bak-20260918-160636`。
>
> **交付：`lib/` + `extension/` 都改了 ⇒ 重启 `dsh web` + 重载 Chrome 扩展。**

> ### v14：输入法 Enter、后开面板、以及测试一直在跑半启动的面板（扩展侧，本次修复）
>
> 三处，前两处是产品缺陷，第三处是**测试自身的盲区**。
>
> 1. **中文输入法按 Enter 会发送消息**（`extension/sidepanel.js` 的 `input` keydown）。
>    写中文时按 Enter 选候选词是每一步的常规动作，所以这不是边界情况，**是每一条消息**。
>    修法：`if (event.isComposing === true || event.keyCode === 229) return`。真 Enter 仍发送
>    （有用例专门断言，免得守卫变成吃掉键）。
> 2. **问题发出之后才打开的面板永远学不到它**。`approval/asked` 是通知，不重放；面板没开／
>    在重载／在别的窗口 → 转圈的回合 + 没有按钮 = v13 要消灭的卡死换条路进来。
>    v13 已在 health 里加了 `approvalPending`，**但面板从来没读它**（加好却没人用的字段与
>    「本来就没有问题」形状相同）。现在 `refreshHealth()` → `adoptOpenApproval(payload)`：
>    认领仍开着的问题；问题已不在列表里就撤卡。
>    **必须保留的守卫**：老宿主没有 `approvalPending` 字段 ⇒ `Array.isArray` 为假是「说不了」，
>    不是「没有未决问题」；当成后者会无故撤掉通知通道刚挂上的卡片。
> 3. **`globalThis.window` 从来没在测试桩里定义**，而 `start()` 有
>    `window.addEventListener('focus', …)` ⇒ `start()` 在**挂载四个 setInterval 之前**就抛，
>    被 `start().catch(…)` 写成 toast，而**所有只碰消息区的用例照样全绿**：四个轮询从未挂上、
>    focus 监听器从未注册，320 条里没有一条发现。修法：补 `window` 桩（面板只用
>    `addEventListener`/`innerWidth`/`innerHeight` 三个成员；focus 监听器改为**记录**），
>    `setInterval` 也改为**记录回调**（否则测试无法主动触发 health 轮询，后开面板的恢复路径
>    就只能靠轮询到达）；并新增断言 `startupToast === ''`、`startupClocks === 4`、
>    focus 监听器恰好 1 个。**判据：新增功能若只能靠轮询到达，测试就必须能驱动那个轮询。**
>
> **证伪三次**（每次先 `node --check`）：去掉 IME 守卫 → 1 红；删掉 `adoptOpenApproval` 调用 →
> 2 红；删掉 `window` 桩 → **4 红**（含新启动断言，证明确实绑住了缺陷）。第一次用正则拼补丁拼出
> 语法错误（exit 1），**那一轮不算证伪**，重做才有效。
>
> **测试 315 → 320**；`npm run check:extension` exit 0。
> **交付：只改 `extension/` → 重载 Chrome 扩展即可，不需要重启 `dsh web`。**
>
> ### v13：在侧边栏里就能回答审批（宿主 + 扩展，本次修复）
>
> **用户症状（逐字）**：「dsh在等待审批，用户在浏览器插件中，不切回来看永远也不知道，然后就卡住了」——
> 侧边栏发起的回合碰到要授权的工具，整轮停住且**什么都不说**，只有切回 DSH 图形界面才看到审批框。
>
> **根因（一手）**：宿主从客户端组合审批作答方，而官方唯一的作答方是图形界面
> （`dsh-client-ui-approval/lib/client.js:282` 的 `ctx.remote.$on('approval/request', …)`）。
> 插件侧插件**可以**自己当第二个作答方（`dsh-acp/lib/index.js:1115` 就是
> `ctx.on('approval/request', (request, next) => …)`）——我们只是从来没注册过。
>
> **三条不能忘的规则**
> 1. **与图形界面赛跑，谁先答谁赢**（`Promise.race`）；输的一方收 `approval/settled` 撤卡片。
>    一个还在为已决问题提供按钮的卡片比没有卡片更糟。
> 2. **`unavailable` 不是答案**。它是「没有作答方接手」，未接图形界面时下游返回的正是它。
>    当成答案 ⇒ 面板一旦是唯一界面就**拒绝每一个请求**，把「没人回答」伪装成「用户拒绝」。
>    这是承重墙，`test/approval.test.js` 用 `race()` 断言问题此时**仍然挂着**。
> 3. **只给两个按钮**（`PANEL_OPTIONS = ['allowed-once','rejected']`）。宿主只授予
>    `allowed-once`（`dsh-user-approval/lib/index.js:30-35` 四个 outcome 里唯一算允许的），
>    「永久允许本站」是桥事后用 `persistentApproval` 决定的，写成按钮就是撒谎。
>    没有扩展连着时 relay **完全不介入**（`return next()`），没装扩展的人路径一字未变。
>
> **改动文件**：`lib/approval.js`（新）、`lib/protocol.js`（`approvalAsked`/`approvalSettled` 两条通知）、
> `lib/index.js`（`createApprovalRelay` + `attach`、`POST {action:'approval'}`、health 的 `approval`/`approvalPending`）、
> `extension/background.js`（`relayNotification` 转发两种通知）、`extension/sidepanel.js`
> （`pendingApproval`/`answering`/`drawnApproval` 状态 + `renderApproval`/`answerApproval`）、
> `extension/sidepanel.html`（`.approval*` 卡片样式）、`extension/locales.js`（7 键）。
>
> **验证**：`npm test` **315 passed / 0 failed / 0 skipped**（20 suite，新增 `test/approval.test.js` 12 条 +
> `panel-stream.test.js` 7 条）；`npm run check:extension` exit 0。
> 探针 3199 实测：health 出现 `approval` 七计数器；回答不存在的 id → `409 {"answered":false,"reason":"that question is no longer open"}`；
> 非法 outcome 同样被拒；两次后 `refused: 2`（计数确实在动）。
> **证伪**：卡片永不绘制 → 6 条红；拒绝键发 `allowed-once` → 1 条红；忙态不参与比较 → 1 条红。
> 最后一条抓到**我自己引入的 bug**（同 id 早退跳过了「按钮转禁用」的重绘 ⇒ 双击发出两次回答），已修并补用例。
>
> **交付**：`lib/` + `extension/` 都改了 → 用户要**重启 `dsh web`** + **重载 Chrome 扩展**。
> **未实测**：一次真实审批从面板作答（探针没有 provider 凭据，扩展也没连上）。
>
> ### v12：侧边栏能复制代码块和整条回答（扩展侧，本次新增）
>
> **为什么做**：此前面板**没有任何复制能力**，想拿走一段代码只能手动框选。这是每天都碰到的摩擦。
>
> **做法**
> - `extension/markdown.js`：`code` 块渲染成 `div.code-block > (div.code-head + pre)`；头行左边语言、右边「复制」。`renderBlocks(document, blocks, options)` 新增第三参 `options.copy`（标签由调用方给，渲染器**自己不造文案**），`renderMarkdown(document, text, options)` 透传。
> - `extension/sidepanel.js`：`renderRow` 的 assistant 分支给 `renderMarkdown` 传 `{copy: t('action.copy')}`，并在回答尾部追加 `div.answer-actions > button.copy[data-copy="answer"]`；新增 `copyText(text)`（只走 `globalThis.navigator?.clipboard?.writeText`，被拒返回 false）与**一个委托处理器** `transcript.addEventListener('click', …)`——按钮靠 `data-copy` + `closest` 定位，`dataset.state='copied'` + 1400ms 后还原。
> - `extension/sidepanel.html`：新增 `.code-block` / `.code-head` / `.code-lang` / `.copy` / `.copy[data-state='copied']` / `.answer-actions`（hover 与 `:focus-within` 显示，`@media (hover:none)` 常显）。
> - `extension/locales.js`：新增 `action.copy`、`action.copied`、`error.notCopied`；**删掉 3 个死键** `action.refresh`、`action.refresh.title`、`history.title`。
> - `extension/sidepanel.js` 的会话列表圆点：补 `dot.title` / `aria-label = t('session.running')`——键早就存在却没人读，那个 6px 的圆点此前没有任何文字说明。
>
> **测试**：288 → **295**。`test/markdown.test.js` 改写代码块形状用例为卡片形状（并加「没有语言也要有复制按钮、渲染器不造文案」）；`test/panel-stream.test.js` 新增 4 条真跑面板模块的用例（代码块复制 / 整条回答复制渲染文本 / 点别处不复制 / 剪贴板被拒时弹「复制失败」且按钮不变成已复制），文件里用 `Object.defineProperty(globalThis.navigator, 'clipboard', …)` 装假剪贴板；`test/panel-i18n.test.js` 新增「复制链路两端都接上」（渲染器类名 ↔ 样式表选择器）与「字典里不许有没人读的键」两条不变式。
>
> **证伪记录**：把 `transcript.addEventListener('click', …)` 改名使其失效后重跑，4 条新用例中 3 条变红（第 4 条断言「点别处不许复制」，拆掉处理器自然仍绿）；恢复后 295 全绿。
>
> **交付**：只改 `extension/` → 用户**重载 Chrome 扩展**即可，不需要重启 `dsh web`。
>
> **一个可复用的自查手段（本次新发现）**：把 `extension/sidepanel.html` + 其模块复制到一个临时目录，在 `</head>` 前注入「最小的 `chrome.*` + 打桩 `fetch`」脚本（注意桩里必须返回 `payload.catalog`，面板读的是 `catalog` 字段而不是目录本身），用 http 起静态服务打开，就能在没有 Chrome 的情况下读到面板的**真实渲染文本**。像素级仍看不到（`browser_screenshot` 的图片**不会**回传成工具结果；`read_image` 读 `~/.dsh/attachments/v1/objects/**` 里的落地文件才看得到图）。**注意**：2026-09-14 该手段用到一半被用户制止——「不要影响到我正在使用浏览器」，此后不再开标签页、不截图。

> ### v11：划词不出现的两个叠在一起的静默缺陷（扩展侧，本次修复）
>
> **症状**：页面上选中文字，侧栏没有「选中内容」chip，因此也无从知道它会不会进上下文。用户在一篇 ACM 文章上复现，当时刚重载过扩展。
>
> **链路**：`extension/content-selection.js` 上报 → service worker 转发给面板。**扩展一重载，所有已打开页面里的旧上报脚本全部失联**（还在监听，`chrome.runtime` 已作废）。Chrome 不会向已打开的页面重新注入声明式内容脚本，所以只能靠面板重新注入这个文件救活。
>
> **两个各自独立、且都静默的缺陷，把这条恢复路径废掉了两次**
> 1. `chrome.scripting.executeScript` **需要目标页面 host 权限**，而 `extension/manifest.json` 的 `host_permissions` 只有 loopback → 任何真实网页上必然抛 `Cannot access contents of the page. Extension manifest must request permission…`，被 `catch { return }` 吞掉。**只改这一处不够**，见下一条。
> 2. `extension/content-selection.js` 的「每文档只装一次」守卫是**早退**：`if (globalThis.__dshSelectionReporter === true) return`。即使注入被允许，**死掉的那一份已经占了标记**，新副本立刻 return → 什么都没装。v4 为修「重载后失联」而加的恢复路径，被同一轮加的守卫废掉。
>
> 第三处：`report()` 是 `try { chrome.runtime.sendMessage(…) } catch {}`，而 MV3 里上下文失效是 **reject 不是 throw** → 无人接管的 rejected promise（真 Chrome 里是页面控制台报错），且 `lastReported` 已把它标成「报过了」，同一段文字再也不重试。
>
> **三个缺陷形状相同：失败 ⇒ 无 chip ⇒ 与「确实没选中」完全一样。**
>
> **修法**
> - `extension/manifest.json`：`host_permissions` 补 `"http://*/*"`、`"https://*/*"`，与 `content_scripts.matches` 对齐。**不新增权限警告**（声明 `https://*/*` 内容脚本本就触发同一句）。
> - `extension/content-selection.js`：守卫改为**新副本接管**——先调旧副本的 `dispose()`，再占 `globalThis.__dshSelectionReporter`。`dispose` 只碰 DOM API，**在已作废的上下文里也能跑**；只有 `chrome.runtime.onMessage.removeListener` 需要 `try`。
> - 同文件 `report()`：throw **或** reject 都回滚 `lastReported`，下一次 `selectionchange`/`pointerup` 重试。
> - `extension/sidepanel.js` 的 `requestSelectionFromPage()`：**回包形状不对也算失败**（死端口以 `undefined` resolve 而非 reject）→ 重注入 → 再问；两次都不成且 URL 是 http(s) 时用 `error.reportStale`（「请刷新页面」）说一次（按 `tabId:url` 去重）。面板窗口获得焦点时也再问一次。
>
> **测试写法（重要）**：上报脚本是自包含 IIFE，所以测试用 `new Function` 把它跑在沙盘里，`install()` 返回**那一份副本自己的**发送记录。
> **只数监听器个数没有鉴别力：接管成功和拒绝安装都留下 1 个监听器**——第一版断言正是数个数，对修好和没修好的代码都通过。
> 证伪方式：把 `extension/content-selection.js` 换成 `git show HEAD:<上一提交>:extension/content-selection.js`，新测试**3 条变红**（旧版还会因无人接管的 rejection 直接把测试进程打崩）。
>
> **交付**：只改 `extension/` → 用户**重载 Chrome 扩展**即可，不需要重启 `dsh web`（本次没动 `lib/`）。重载后已打开的页面会自动被重新注入，**不必手动刷新每个标签页**。
>
> ### v10：侧边栏能停下跑飞的回合（一个隐藏能力 + 三处接线 + 面板侧真跑测试）
>
> **症状**：发出去就收不回来。发送中按钮只是 `disabled`，模型写 5 分钟你就等 5 分钟。
>
> **根因**：不是能力缺失，是**接线缺失**。宿主一直有 `SessionController.cancel(request)`
> （`dsh-api-session-controller/lib/index.js:2945` → `commands.cancel` `:872`：
> `agent.cancel({ kind: 'user' }, { keepInbox: true })`，找不到 agent 抛 `session/not-found`）。
> **语义是只取消活动回合、保留 pending inbox**——排队中的那条不会跟着消失。
>
> **三处接线**
> - `packages/dsh-browser-bridge/lib/index.js`：`commands` 端口加 `cancel: bind(controller,'cancel')`；
>   `serveChatRoute` 加 `action === 'cancel'` 分支（成功 200、没停下 409），**排在 `action === 'send'` 之前**。
> - `packages/dsh-browser-bridge/lib/chat.js:725`：`const cancel = async (sessionId) => …`，
>   三种失败各自返回**具名原因**（`'no session was named'` /
>   `'the harness does not expose turn cancellation, so the bridge cannot stop this turn'` / 宿主 message）；
>   `services()` 加 `cancel: typeof commands?.cancel === 'function'`。
> - `extension/sidepanel.js`：新增 `let stopping`、`drawSend()`、`stopTurn()`。
>   **发送与停止是同一个槽位的两种状态**，不是两个按钮：`sending || currentSessionRunning` 时
>   `sendButton.dataset.mode = 'stop'`、字形 `■`、`aria-label` 换掉；点它是 `POST {action:'cancel'}`。
>   原先散在 7 处的 `sendButton.disabled = …` 全部收进 `drawSend()`（`renderWorking()` 末尾也调它，
>   所以**不存在「显示在跑却不提供停止」的路径**）。取消成功才 `currentSessionRunning = false`；
>   被拒绝则**留在停止态**并 `say(t('error.notStopped', {reason}))`。
> - `extension/sidepanel.html`：`#send[data-mode='stop']` 用 `CanvasText`/`Canvas` **反色**（不是主题色），
>   加上 `:hover` 与 `:disabled` 覆盖——`#send:disabled` 与 `#send[data-mode='stop']` 同特异度，
>   靠源码顺序决定，所以必须显式写 `#send[data-mode='stop']:disabled`。
> - `extension/locales.js`：zh/en 各加 3 键（`action.stop` / `action.stop.title` / `error.notStopped`）。
>
> **实测**（探针 `dsh web --port 3199 --no-open`，用户线上 3080 全程未碰）
> | 请求 | 结果 |
> |---|---|
> | `GET /browser-bridge/health` | `chatServices.cancel = true` |
> | `cancel` 未挂载的会话 | `409 {"cancelled":false,"reason":"session \"…\" not found (not attached)"}` |
> | `cancel` 不存在的会话 | 同上，原因带 id |
> | `cancel` 不带 id | `409 {"cancelled":false,"reason":"no session was named"}` |
> | **先 `send` 再立刻 `cancel` 同一会话** | **`200 {"cancelled":true,"sessionId":"…"}`** |
>
> **必须记住的边界**：那次成功取消之后 4 秒再取消同一会话，宿主**仍然**回 `cancelled:true`——
> `agent.cancel()` 对已经没有回合的 agent 一样接受。**「宿主说停下了」不等于「刚才确实有回合在跑」**；
> 面板只在它认为有回合时才提供停止，且该回答只用来把按钮切回发送态。
>
> **测试**：`test/panel-stream.test.js` 后半段（真 import `extension/sidepanel.js`）加了 6 条——
> 空输入不可点 / 打字激活 / 发送后同一槽位变停止 / 停止发的是 cancel 而不是把输入框内容发出去 /
> 取消成功后按钮切回且等待行消失 / 被拒绝时留在停止态并把原因显示给用户 / 回合中 Enter 仍照常入队。
> **为什么和流式共用一个文件**：面板是有状态模块，第二个 suite 再 import 只会拿到缓存实例，
> 它自己的宿主板子一次都不会被调用（runner 先 import 完所有 suite 再跑）——分成两个文件时就是这么失败的。
> 288 条全过。
>
> **交付**：`lib/` 与 `extension/` 都动了 → 用户要**重启 `dsh web`** + **重载 Chrome 扩展**。
>
> ---

> ⚠️ **v9 已完成：侧边栏改成逐字流式输出。** 下面是那一轮。
>
> ---
>
> ### v9：模型边写边显示（一个通道 + 三处接线 + 一套跑了面板模块的测试）
>
> **症状**：回复整段蹦出。发送后按 `[800, 2000, 4000, 8000, 15000]ms` 重读记录 + 8 秒空闲轮询，
> 所以模型写 20 秒，人就看着 20 秒的「正在工作」扫光。
>
> **根因**：会话日志里**没有增量事件**。`dsh-session` 事件类型全集 = `assistant/attempt` /
> `assistant/message` / `feedback/message-delete` / `feedback/message-put` / `request/context` /
> `system/message` / `user/message`；一次 attempt 只在**写完之后**提交一条完整 `assistant/message`。
> 读记录不可能逐字。
>
> **唯一通道**：`dsh-agent-loop/lib/index.js:1031` —
> `const live = new AssistantStreamAttempt(..., (frame) => { this.dispatch.emit("agent/assistant-stream", { frame }) })`。
> 事件签名 `'agent/assistant-stream'(this: Scoped<Agent>, payload: { agent, frame })`
> （`dsh-tool-cordis/lib/index.js:4940`），scope 映射 `dsh-scope/lib/index.js:10`；
> 宿主自己的 web UI 在 `dsh-api-session-controller/lib/index.js:1343` 消费同一个事件。
>
> **两个形状细节**（决定整个实现）：
> - frame 带 `attemptId` 不带 sessionId；`attemptId = \`${sessionId}:${attempt}\``
>   （`dsh-agent-loop/lib/index.js:389`）→ session = 冒号前缀（`sessionOfAttempt`）。
> - frame **按 token 到达** → 按 `sessionId + kind` 聚合、80ms 一批（`DEFAULT_FLUSH_MS = 80`）。
> - chunk 字段名取自 `dsh-llm/lib/types/assembler.js:46-58`：`text-delta`/`reasoning-delta` 用
>   `chunk.text`；`tool-call-delta` 只在 `chunk.name` 存在时算一次（参数流不再发）。
>
> **线上第三种方向**：宿主→扩展请求带 `id`，扩展→宿主事件带 `event`，通知带 **`notify`**
> （`lib/protocol.js` 的 `NOTIFICATIONS.assistantDelta = 'assistant/delta'`）。
> `lib/bridge.js` 的 `BrowserConnection.notify(name, payload)` 不 live 就返回 false。
> **`extension/background.js` 的 `handleFrame` 必须在 `const id = parsed.id` 之前判断 `parsed.notify`**
> ——请求路径对没 `id` 的帧直接 return，晚一步所有通知都被丢掉。
> 之后 service worker `chrome.runtime.sendMessage({ type: 'dsh-assistant-delta', payload })` 转给面板
> （面板是独立文档，拿不到这条 socket）。
>
> **面板**（`extension/sidepanel.js`）：`let live = {sessionId,text,reasoning,tool,done}`；
> `applyDelta(payload)` 折叠帧，`renderLive()` 画**纯文本 + 光标**（`white-space: pre-wrap`）。
> **不解析 markdown**：半张表格每帧都会解析成不同的东西。让位发生在 `drawTranscript` 里
> ——「`live.done` 且行签名变了」才 `live = null` 并替换；直接在 `end` 清空会让重读 racing 时文字先消失。
> `.live` 块插在 `.working` 之前；`start` 时先 `renderWorking()` 再 `renderLive()`（否则首批 token 落在不存在的行下面）。
> 顺带修掉：`.working` 读宿主 `running` 标志，原本只在 5 秒轮询时更新 → 现在 attempt 结束时立刻 `refreshGroups()`。
>
> **降级**：没连接扩展 → 通知丢弃不排队，计数在 health 的 `stream` 字段
> （`frames` 涨而 `notifications` 不涨 = 没扩展在收；`frames` 为 0 = agent 事件没到插件）。
>
> **测试**：`test/stream.test.js` + `test/panel-stream.test.js`，后者用**新建的 `test/dom-shim.js`
> 把 `extension/sidepanel.js` 真的 import 进 Node 跑**（此前面板只有字符串匹配）。279 条全过。
>
> **弯路（重要）**：第一版 DOM 桩不支持 `append('文本')`，markdown 渲染抛错；面板那条路是
> `.catch(() => {})`，**异常被吞后与「记录没变化」完全无法区分**，症状是「live 块该消失却没消失」。
> 补上文本节点后立刻转绿。→ 死掉的 accessor / 被吞的异常 / 空结果，三者形状相同。
>
> **交付**：改了 `lib/`（宿主）+ `extension/`（扩展）→ **重启 `dsh web` 且重载 Chrome 扩展**。
> 生效判据：`http://127.0.0.1:3080/browser-bridge/health` 出现 `stream` 字段。
>
> **下一轮（v10）建议：停止按钮。** 已经查到宿主有现成命令：
> `SessionController.cancel(request)`（`dsh-api-session-controller/lib/index.js:2945`）→
> `commands.cancel`（同文件 `:872`）：
> `const agent = this.ctx.agents.get(request.sessionId); if (agent === void 0) throw new RemoteError("session/not-found", …); agent.cancel({ kind: "user" }, { keepInbox: true }); return { accepted: true }`
> —— 语义正是「取消当前 turn 但保留 inbox」。面板侧现状：发送中 `sendButton` 只是被禁用，
> 用户**没有任何办法打断**一个跑飞的回合。做法：`lib/index.js` 的 `commands` getter 加 `cancel: bind(controller,'cancel')`，
> `serveChatRoute` 加 `action:'cancel'`，面板在 `currentSessionRunning || sending` 时把 `↑` 换成停止键。
>
> ---
>
> ⚠️ **v8 已完成（历史）：`browser_screenshot` 的图片从来没到过模型。**
>
> ---
>
> ### v8：工具结果里的图片块形状是错的（一个缺陷，三层证据）
>
> **症状**：`browser_screenshot` 返回 `captured`，模型只看到
> `Screenshot of the page (jpeg).`，看不到画面。
>
> **宿主的真实契约**（三处独立证据，路径均在
> `%USERPROFILE%\.dsh\profiles\node_modules\@deepseek-ai\`）：
> 1. `dsh-llm-deepseek/lib/index.js:1452` —
>    `function collectImageRefs(content, refs) { for (const block of content) if (block.type === "image") refs.set(block.attachment.attachmentId, block.attachment); else if (block.type === "tool-result") collectImageRefs(block.content, refs); }`
>    —— 读的是 `block.attachment.attachmentId`，且**递归进 tool-result**。
> 2. `dsh-llm/lib/types/content.js:88-91` 的 `contentHasImage(content)` 同样递归进 `tool-result`。
> 3. `dsh-llm-deepseek/lib/index.js:171-185` 的 `serializeMessagesWithImages` 里有
>    `pendingToolImages` / `flushToolImages()`：**专门**把工具结果里的图片收集起来，合并成一条
>    `role:"user"` + `TOOL_RESULT_IMAGE_TEXT` 的消息。（`:128-130` 的注释写明
>    「the harness puts each tool result in its own user-role message」，所以 `:52` 的
>    `assertSupportedImageRoles`（只允许 user 角色带图）不会误伤工具结果。）
>    → **「工具返回图片」是宿主官方支持的路径，不是我们发明的。**
>
> **缺陷**：插件发的是 `{ type: 'image', mediaType, data }`，宿主定义的却是
> `ImageBlock = { type: 'image', attachment: ImageAttachmentRef }`。块上没有 `attachment`，
> 于是 `block.attachment.attachmentId` 取 `undefined`。schema 编译得过、工具返回成功，
> 所以**没有任何一层报错**——字节确实拿到了，只是永远到不了模型。
>
> **修法**（`packages/dsh-browser-bridge/lib/page-tools.js` 的 `browser_screenshot`）：
> - `execute` 改走 `store.admitPromptContent([{ type:'image', data: encoded, mediaType, name }])`
>   → `[{ type:'image', attachment }]`。该方法在 `dsh-attachment/lib/index.js:220-244`，
>   内部走 `admitEncodedImages` → 会校验**规范化 base64**（`decoded.toString('base64') === data`）。
>   注意 `admitEncodedImages` 是**自由函数** `(store, images)`，实例方法是 `admitPromptContent`。
> - `render` 只产出 `{ type:'image', attachment: value.attachment }`。
> - **base64 不再进入工具值**：此前每张截图都会把整段 base64 写进会话日志。
>   工具值现在只剩 `{ url, format, mediaType, width, height, bytes, attachment }`。
> - 新增端口 `ports.attachmentStore`（`lib/index.js` 的 `ports` 对象里），
>   **按调用解析**：`attachmentStore: () => ctx.get?.('attachments')`。附件服务比插件激活更晚
>   注册，激活时读一次会永久冻住 `undefined`——这个坑本项目已经踩过一次，别再改回去。
> - 读端口**必须**写成 `typeof attachmentStore === 'function' ? attachmentStore() : undefined`：
>   测试夹具不传这个端口，直接 `attachmentStore()` 会 `TypeError`。
> - 尺寸限额安全：`dsh-attachment-local/lib/index.js:987-998` 的默认值是
>   `maxImageBytes 20971520` / `maxImagePixels 64e6` / `maxImageDimension 8192`，
>   1280 宽的截图远在限额内。
>
> **降级路径**（都不抛异常、都不制造假块）：
> `ATTACHMENT_STORE_UNAVAILABLE`（附件服务缺失，只回文字并说明原因）、
> `EMPTY_SCREENSHOT`（空载荷不入库）、站点规则拒绝时一个字节都不入库。
>
> **测试**：新增 `packages/dsh-browser-bridge/test/screenshot.test.js`（8 条）。夹具用
> **预先记录的 `access` 授权**过 gate，而不是桩审批——这样审批接线一变，测试就会失败而不是
> 悄悄放行。其中一条按宿主**真实的那次遍历**断言：把 render 出来的 blocks 包进
> `{ type:'tool-result', toolCallId, content: blocks }` 再递归找 image，要求每个 image 都带
> `attachment.attachmentId`。**旧代码正是在这里失败。**
>
> **投递**：本修复**只动宿主**，`extension/` 未改 → 用户**只需重启 `dsh web`，
> 不用重载 Chrome 扩展**。
>
> ---
>
> ⚠️ **v5 已完成：划词附件修复。** v4/v3 内容仅作历史参考。
>
> ---
>
> ### v5：划词附件从来没进过上下文（两个互相独立的缺陷）
>
> 用户原话（逐字）：「我鼠标选中了内容，但是侧边栏没有显示，我也不知道会不会被加进上下文。」
> 随后给出会话截图：发了「翻译」，模型却回答没有可翻译的内容。
>
> **取证方式（全程靠证据，不靠推断）**：
> 1. 附件暂存队列是持久化的——`~/.dsh/storages/dsh-browser-bridge-context.json` 里
>    `session-…` 的两条附件（`kind:'tab'` 空正文 +
>    `kind:'selection'` 正文「逐字节一致」）**当时仍在队列里** → 注入从未发生。
> 2. 残留横跨三个会话（`505eb23f` / `d4d10dad` / `69e9fb87`）→ 不像竞态，像**从来没成功过**。
> 3. 探针实例（`dsh web --port 3199 --no-open`）上复现：`staged:1` 入队后 6 秒仍在队列。
> 4. 给 `ContextAttachments` 的每个 `return` 点插桩（`#note`），`GET /browser-bridge/health` 暴露
>    `contextDiagnostics.diag`，一次拿到确切错误串。
> 5. 多帧 zstd 解压（按 magic `28 B5 2F FD` 逐帧，Node 的 `zstdDecompressSync` 只解第一帧）
>    读原始会话日志，拿到事件顺序作为最终判据。
>
> **缺陷 1：注入被重入保护拒绝，而异常被吞掉。**
> `ctx.on('session/event')`（签名 `(session: Session, event: SessionEvent)`，已核对
> `dsh-tool-cordis/lib/index.js:5413`）是在会话**发布这次追加的过程中**回调的；
> 此处再调 `agent.inject()` 又要往同一会话追加，session 直接抛
> `session append cannot reenter while another append is being published`。
> 原代码 `catch { return }` 把它吞掉 → 「注入失败」与「队列本来就是空的」**完全不可区分**。
> 该缺陷自附件功能上线起就存在，三份残留附件是它的化石。
>
> **缺陷 2：投递时机晚了整整一个 step。**
> 即便不报错，`agent.inject()` 的目标是 `next-step`：日志里 `agent/inbox/spliced`(seq 16)
> 排在 `request/context`(seq 13) **之后**。模型若第一步就作答，就永远看不到附件
> ——这正是它回答「没有可翻译的内容」的原因。
>
> **修法是三层**（因为投递必须赶在 `request/context` 之前）：
> 1. `ContextAttachments#deliver` 移出事件栈（可注入的 `#schedule`，默认 `setTimeout(task, 0)`）；
> 2. 发送路径在 `chat.send()` **之前**调 `deliverBeforePrompt(sessionId)`（热会话在这一步投递完）；
> 3. 冷会话没有 agent，第 2 步必然失败。真正的时机是 **`agent/created`**：`prompt` 在 `turn/start`
>    **之前**创建 agent，此刻没有 append 在发布、队列也还在，所以 `adoptAgent(agent)` 注册的同时
>    把队列交出去。
> `session/event` 只剩兜底（扩展主动推送），并识别「已被前两层清空」不重复投递。
>
> **验证（探针 3199，两条路径分别实测）**：
>
> | 路径 | 事件顺序 |
> |---|---|
> | 热会话（先 `create` 再发送） | `inbox/spliced` seq 4–5 → `turn/start` seq 7 → **`request/context` seq 18** |
> | 冷会话（`create` 后重启探针，agent 全丢） | `inbox/spliced` seq 5 → `turn/start` seq 7 → **`request/context` seq 17** |
>
> 两条下面板都读回 `kind=context` 行；热路径一次发两个附件（划词 + 标签页）`staged:2, refused:[]`，
> 面板 3 行。`diag` 在冷路径上完整讲出过程：`deferred:no-agent` → `adopt{queued:1}` → `injected`
> → 兜底 `skip:empty-queue`（不重复投递）。
>
> 新增可观测性：`GET /browser-bridge/health` → `contextDiagnostics{agents, pending, diag}`。
> `npm test` **220 passed / 0 failed / 0 skipped**，`npm run check:extension` exit 0。
> 新增测试五条：投递不在事件栈上、发送路径先于 prompt 投递、冷会话保留队列、
> 被唤醒时 `adoptAgent` 立即交付且兜底不重发、无队列时 `adopt` 不报错。
>
> **流程教训（下个会话别重犯）**：调试期必须把 `~/.dsh/profiles/web/node_modules/dsh-browser-bridge`
> 换成指向工作区的 junction（`cmd /c mklink /J`），否则改了源码而探针仍跑旧拷贝——本轮因此白跑了两轮
> 实验（表现为 `diag` 为空、看起来像事件没触发）。**恢复正规 pnpm 安装必须是最后一步**，之后不再改代码。
>
> ### v7（本次：侧边栏加模型 / 推理强度选择器，会话级）
>
> **做了什么**：composer 从一行 `[textarea][send]` 改成 Codex 那样的两层，下面那条控制条左侧放模型选择器。
> 新增 `extension/model-menu.js`（纯函数，可测）、宿主的 `readModels`/`selectModel` 两个接口，
> 以及 `extension/sidepanel.js` 里的 `refreshCatalog` / `drawModel` / `drawModelMenu` / `setMenu` /
> `positionMenu` / `chooseModel`。
>
> **用户的明确决定**（逐字）：「这个就不用同步了，每个会话都可以选择自己的模型和推理强度不是吗？」
> —— **不要和 DSH 主界面做任何控件级同步**。技术上也不需要：`selectModel` 写该会话的 `model/selection` 事件，
> 读该会话的 `modelSelection` 投影；全局默认那层的文档原文是 *"Default model selection for an Agent
> **without** a session-specific selection"*，两边读同一份投影，天生一致。
>
> **已核实的接口（别再猜）**：
> - `SessionController.modelCatalog()` 是 **`async`**（`@deepseek-ai/dsh-api-session-controller/lib/types/catalog.js:8`）→ **必须 `await`**。
>   漏掉 await 会缓存一个 Promise：它通过 `typeof === 'object'` 检查，`JSON.stringify` 后是 `{}`，
>   于是面板拿到一份"看起来加载成功、其实一个模型都没有"的目录。**本轮真的踩了这个坑，是探针抓到的。**
> - `SessionController.selectModel({sessionId, provider, model, reasoningEffort?})` → `{selected:{provider, model, reasoningEffort?}}`；
>   失败形态有 `session/not-found`、subagent ownership 拒绝、`session/model-unavailable`。
> - 内部 `resolveAgent` 会 **resume 冷会话**，所以冷会话也能切；但**已被另一个 dsh 实例持有的会话**会返回
>   `SessionAlreadyOwnedError: session "…" is already owned by an active write handle` —— 只在两个实例并存时出现。
> - 当前选择**不需要额外读接口**：`list()` 的每个 item 已带 `projections.values.modelSelection`，
>   其 `view.next = pending ?? lastUsed`，所以跟着会话列表一起回来即可。
> - 成功后它会顺带 `agentDefaultModel.saveSelection(selected)` 写全局默认。这是宿主对**所有**调用者的行为
>   （DSH 自己切换也一样），**不要绕**：绕开就得自己往会话里追加事件，让日志和投影打架。
>
> **Codex 原版的量（取自它自己的 CSS，不是估的）**：面板 `width: calc(var(--spacing)*56)` = 224px、
> `rounded-2xl` = 16px 圆角、`p-[var(--menu-gutter,…)]` = 4px、行高 `calc(var(--spacing)*10)` = 40px、
> 行圆角 `--radius-xl` = 12px、行内边距 `6px 8px`、选中态是**行右侧的对勾**；触发按钮是「图标 + 模型名 + 强度名」，
> 且**把「Model」这个类别名用 `display:none` 藏着** —— 所以这里也**不写「模型」二字**。
>
> **验收实测（探针 3199，用户 3080 全程未碰）**：目录回到 4 个模型（`deepseek-flash` / `deepseek-v4-flash` /
> `deepseek-v4-pro` / `deepseek-v4-flash-vision-exp`）+ 默认 `deepseek-flash · max` + 无 `failures`；
> 在探针自建的会话上切到 `deepseek-v4-pro` → `{"selected":{…,"model":"deepseek-v4-pro","reasoningEffort":"high"}}`
> （宿主自己补了该模型的默认强度），而**同一份列表里其它每个会话的 `model` 字段一个都没变**；
> `reasoningEffort:"turbo"` 被宿主拒绝并给出原因；每个模型 4 档强度 `off/low/high/max`（默认 `high`）。
>
> **测试数 220 → 241**：新增 `test/model-menu.test.js` 11 条，`chat.test.js` 增 9 条，
> `panel-i18n.test.js` 增 2 条（其中一条专门断言"菜单模块不得自带翻译"，另一条断言面板确实 import 了它）。
> **改的横跨两半 → 要重载 Chrome 扩展 + 重启 `dsh web`。**

> ### v6（本次：侧边栏把表格渲染成一坨竖线）
>
> 用户截图：模型给的 Cookie 对比表在面板里变成 `| 类型 | 作用 | 能否拒绝 |` 这样的原文管道。
> 读回该会话（`session-…`）的**原始输出**确认：模型给的是
> 标准 GFM 表格，一个字符都没错。问题在渲染器——`<repo>\extension\markdown.js`
> 原本的块类型只有 code / heading / rule / quote / list / paragraph，表格每一行都掉进 paragraph，
> 几行被 `\n` 连成一个段落，HTML 再把换行折成空格。
>
> 修法：新增 `table` 块。认定条件是「一行含 `|` **且下一行是分隔行**（`|---|:--:|`）」——缺了分隔行
> 的 `a | b` 仍是普通文本，判据放宽会把散文里的竖线吃掉。`\|` 当数据不当分隔符（先换占位符再切分）；
> 单元格按表头列数补齐或截断。渲染成 `div.table-scroll > table`，靠 `overflow-x:auto` 横向滚动而
> 不是把列挤成细条——**与 Codex 面板同一种做法**（官方产物 `block-actions-hKoQC7Sq.css` 里
> `_TableScroller` 就是 `scrollbar-width:thin; overflow-x:auto`，`_TableWrapper` 是
> `width:fit-content`）。样式用面板已有的 4px 节奏 token
> （`padding: calc(var(--spacing) * 1.5) calc(var(--spacing) * 2.5)`）。
>
> 实测（把该会话原文喂给渲染器）：块序列
> `paragraph → paragraph → paragraph → table → paragraph → paragraph → paragraph`，
> 输出 `div.table-scroll > table > thead(3×th) + tbody(4×tr × 3×td)`，粗体与段落切分不受影响。
> 新增 9 条测试：转义管道、缺分隔行仍是散文、短行补齐、对齐落到单元格、单元格内行内标记、
> 表格打断段落且前后散文恢复。
>
> ⚠️ **这次改的是 `extension/` 下的文件，要重载 Chrome 扩展才生效**（不是重启 `dsh web`）。
> `chrome://extensions` 点该扩展的「重新加载」，再在侧栏重开会话。
>
> ---
>
> ⚠️ **v4 已完成，本文件里的 v3 内容仅作历史参考。** 现行状态见下面这段。
>
> ---
>
> ### v4（2026-09-11，按用户三条新抱怨 + Codex 原生设计调研重做侧边栏）
>
> 用户原话（逐字）：①「session管理做的好差，我怎么知道这一大堆符号是什么东西？而且我怎么新建会话？这里的会话和dsh本身的也不同步呢。」
> ②「整个侧边栏的UI做的也好丑，为什么有这么多提示性文字？产品设计能不能做好点？看看codex原生是怎么做的，我们要比他们更优秀！」
> ③「我就发了个11，怎么跳出来这么多莫名其妙的东西？用户体验极差！！！而且这个侧边栏这个滚动条还会自动滚到底部，我想看上面的内容，它就自己滚下去了。」
> ④「你是自己设计的吗？我觉得再自己设计前先去看看codex原生是怎么设计的」→ 先做调研再定方案。
>
> **调研**（一手证据：下载了官方 Chrome 扩展的打包产物逐层拆解，不是看博客）：
> 设计 token（4px 间距节奏、12/13/14/16px 字号、6/8/10/12/16px 圆角、`--elevation-composer`、`blur-lg 16px`）、
> 滚动策略（`flex-col-reverse` + 24px 贴底阈值 + 显式关掉 `overflow-anchor` + 上翻后补偿逻辑直接跳过）、
> 消息渲染（reasoning 一行、工具调用一行动词短语、连续相同调用合并计数）、
> 会话列表（工作区分组、归档排除、子代理不单列、空会话保留占位、标题回落首轮用户消息、每会话存草稿）、
> 以及一条关键的**否定结论**：全库没有任何 `hint/description/helper/subtitle` 样式类——原版不用常驻解释文字，
> 只有颜色 token `--color-codex-description`。这直接支持了"删掉面板里那 15 条解释性文案"的决定。
>
> **三个根因（都已修）**：
> 1. 会话列表双路合并（`sessionQuery` + `sessions.list()`）+ 标题回落链 `title || lastMessage || id.slice(0,12)`，
>    于是归档会话、子代理裸 UUID、被截断的 `[tool-result]` 全成了行。→ 改为单一数据源 `sessionController.list()`
>    （与 DSH 侧栏同一个调用）+ 同一份 `archivedSessionIds`，按工作区分组。
> 2. 转录走 `session.deriveMessages()`——**模型可见**列表，把整段系统提示当成"系统"消息渲染；
>    `blockText` 又把没有 `text` 的块渲染成 `[${type}]`。→ 改为按事件类型白名单的语义映射（`describeEvents`），
>    只保留人说过的话、模型的回答、折叠的 reasoning、一行工具调用。
> 3. `sidepanel.js:330` 无条件 `scrollTop = scrollHeight`，触发点是 8 秒轮询。→ 24px 贴底判定 +
>    不在底部就恢复原位 + 「回到底部」按钮 + 行签名去抖（签名没变完全不碰 DOM）。
>
> **顺带修掉的真实缺陷**：头部把 `/browser-bridge/health` 的 `connected`（指 Service Worker 自己的 WebSocket）
> 当成面板断连，导致 7 张截图全是「未连接」却仍能列出会话。现在头部**没有**连接状态，桥接状态降级为
> 输入区附带 chip 上的一行字。
>
> 现状：`npm test` → **198 passed, 0 failed, 0 skipped**；`npm run check:extension` → exit 0；
> 探针实例（3199）上会话分组、`messages`（8 行，与该会话 34 个事件逐一对上）、`create`、`send` 全部实测通过。
> 详见 `README.md` 的「探针实例上已跑通的部分」（该节已改为 v4 结果）。
>
> **仍未由我验证的一条**：模型真的回复。探针进程拿不到 provider key（已核实 `~/.dsh/.credentials.yaml`
> 里只有 `client-connection/browser-session`，没有任何 provider key）——必须在你的 3080 实例上重启后确认。

> 给新会话的完整上下文。读完这份就能接手，不需要旧会话的任何历史。
> 工作区：`<repo>`
>
> **交接时的已验证状态**（旧会话最后一次跑过）：
> - `npm test` → **131 passed, 0 failed, 0 skipped**
> - `npm run check:extension` → 通过（exit 0）
> - `lib/client.js` 工厂体解析 → `OK client.js factory body parses (30949 chars)`
> - 也就是说 §4.1 那批改动**语法和测试层面是干净的**，只差用户肉眼确认视觉效果。
>
> ---
>
> ### ⚠️ 后续更新（2026-09-11，同一会话继续做完）
>
> §4.3 / §4.4 / §4.5 **已完成**，并且在做的过程中挖出三个**比样式严重得多**的真实缺陷：
>
> 1. **上下文附件的入口整条没接**：宿主从未订阅扩展推的 `context/menu` 与 `selection/captured`，
>    而 `attachments.add()` 全仓库无人调用。队列、注入钩子、`browser_context` 工具全都在且有测试，
>    就是没人往里放东西——右键菜单点了没反应。已新增 `lib/ingest.js` 接线。
> 2. **`sessionController` 在插件激活时还没注册**：`ctx.get('sessionController')` 在 `apply` 时抓到
>    `undefined` 并被永久捕获，于是侧栏**既读不出记录也发不出消息**（`prompt` 一直是 unavailable）。
>    改成调用时解析，并在 health 路由加 `chatServices` 诊断。
> 3. **`prompt(request, signal)` 的第二参不是可选的**：控制器无条件调用 `signal.throwIfAborted()`，
>    传 `undefined` 会抛 `Cannot read properties of undefined`。已默认给一个不会 abort 的 signal。
>
> 现状：`npm test` → **170 passed, 0 failed**；探针实例上冷会话回放、会话列表、`send` 全部实测通过。
> 详见 `README.md` 的「探针实例上已跑通的部分（v3）」。

---

## 0. 一句话任务

把已建成的「DSH 浏览器桥接」插件的**还原度**补完。用户在评审界面时提了三条意见，另有一个我一直标注的缺口要顺手修掉：

| # | 用户原话 | 实质 |
|---|---|---|
| 1 | 「样式和原生的卡片差距很大啊」 | 设置页里我贡献的卡片与 harness 自带的四张卡样式不一致 |
| 2 | 「侧边栏聊天的也不够还原，而且还是英文」 | 扩展侧栏应该是个聊天面板（像 Codex），而且全是英文 |
| 3 | 「最底下这个东西有存在的必要吗？」 | 侧栏底部那个 `PAGE AND CONNECTION` 折叠块该不该留 |
| 4 | （无，我自己标注的） | 侧栏读不到**冷会话**的标题和历史 |

**这四条与下面 §4 的计划都已在 v3 做完**，之后又经过 v4–v8 若干轮修复（见文档顶部的分层块）。

⚠️ 本节及 §4 保留的是**当时的计划文本**，只用于理解背景。**不要把 §4 当成待办清单**——
按它做会重做已经完成的工作。要知道「现在什么状态、下一步做什么」，看文档顶部的最新块，
以及 `README.md` 的「与 Codex 能力的差距」一节。

---

## 1. 这个项目是什么

让 DSH 网页会话能操作**用户已登录的真实 Chrome**（对齐 OpenAI Codex 的 Chrome 扩展），并且把网页上选中的内容作为**可见、可移除**的上下文附件交给模型。

三件套：
- **宿主插件** `packages/dsh-browser-bridge/` —— WebSocket 桥接、`browser_*` 工具、站点策略与审批、上下文附件、浏览器端 UI
- **Chrome 扩展** `extension/` —— MV3，纯 JS，无构建；CDP 执行器 + 右键菜单 + 选区上报 + 侧栏面板
- **测试** `packages/dsh-browser-bridge/test/` —— **288 条 / 19 个 suite**，零依赖，全新克隆直接可跑

### 目录

```
<repo>\
├─ README.md                     安装/用法/工具表/策略/测试/诚实的边界声明
├─ package.json                  scripts: test, check:extension
├─ pnpm-workspace.yaml, .gitignore
├─ packages\dsh-browser-bridge\
│  ├─ package.json               dsh.bundle.patch + dsh.client{platform:web,inject:[slots]}
│  ├─ cordis.patch.yml           插入一行 {id: browser-bridge, name: dsh-browser-bridge}
│  ├─ lib\
│  │  ├─ index.js                装配：令牌、路由、工具注册、agent/session 事件接线
│  │  ├─ bridge.js               WS RPC：关联、超时、取消、断连结算
│  │  ├─ token.js  auth.js       令牌落盘 + 令牌/Origin/环回三道判据
│  │  ├─ protocol.js             双端共享方法契约 + CDP 域黑名单
│  │  ├─ policy.js               站点策略引擎（规则表、通配、最严合并、级联）
│  │  ├─ grants.js               授权表 + 敏感动作分类
│  │  ├─ context.js              上下文附件：暂存、去重、注入时机、持久化
│  │  ├─ tools.js                会话与标签页工具
│  │  ├─ page-tools.js           页面工具（统一审批门）
│  │  ├─ config.js  settings.js  设置默认值/schema + 命名空间注册
│  │  ├─ deps.js                 peer 依赖双路解析
│  │  ├─ chat.js                 侧栏对话（列表/读消息/发送）
│  │  └─ client.js               ★ 浏览器端 UI：设置卡片 + 侧栏状态/令牌行
│  └─ test\                      run.js harness.js + 19 个 suite
└─ extension\
   ├─ manifest.json              MV3；debugger/tabs/tabGroups/storage/alarms/scripting/contextMenus/sidePanel
   ├─ background.js              service worker：桥接客户端 + CDP 执行器 + 页面工具
   ├─ page-distill.js            DOM 快照蒸馏（纯函数，测试共用同一份）
   ├─ content-selection.js       选区上报
   ├─ options.html/.js           令牌与端口
   └─ sidepanel.html/.js         ★ 侧栏面板（v3 待重做）
```

---

## 2. 环境硬约束（每条都是踩过的坑，别再踩）

### 2.1 测试：`node --test` 不可用

它会为每个测试文件 fork 子进程并走**管道**捕获输出，而本机沙箱禁止建管道：

```
Error: spawn EPERM at ChildProcess.spawn (node:internal/child_process:441:11)
```

`NODE_TEST_ISOLATION=none`、`NODE_TEST_PARALLEL=0`、父进程用 `stdio:'inherit'` —— **全部无效**。

所以 `test/harness.js` 是自己写的**单进程、零依赖**装置，只暴露 `test(name, fn)`、`beforeEach`、`assert`、`runTests()`、`main()`；`test/run.js` 依次 import 所有 `*.test.js` 再跑。用 `npm test`。

新加测试请沿用这个装置，**不要引入 `node:test`**。

### 2.2 pnpm 是**复制**而不是符号链接

`dsh plugin --profile web add "file:..."` 把包**复制**进 `~/.dsh/profiles/web/node_modules/dsh-browser-bridge`。改源码后安装副本**不会**更新。

快速迭代用目录联接（改完立刻生效，探针实例直接读源码）：

```powershell
$installed = "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-browser-bridge"
if (Test-Path $installed) { cmd /c rmdir "$installed" }   # 或 Remove-Item -Recurse 若是真目录
cmd /c mklink /J "$installed" "<repo>\packages\dsh-browser-bridge"
```

交付前恢复正规安装：

```powershell
Remove-Item $installed -Recurse -Force
dsh plugin --profile web add "file:<repo>\packages\dsh-browser-bridge"
```

### 2.3 DSH 是**全局**安装

`%APPDATA%\npm\node_modules\@deepseek-ai\dsh`，版本 **0.1.5-rc.1**。

**别把这两个版本搞混**（`package.json` 的 `peerDependencies` 写 `^0.1.5-rc.2`，是对的）：

| 是什么 | 在哪 | 版本 |
|---|---|---|
| `dsh` **启动器**（CLI） | `%APPDATA%\npm\node_modules\@deepseek-ai\dsh` | `0.1.5-rc.1` |
| 插件真正解析的**宿主库** | `~/.dsh/profiles/node_modules/@deepseek-ai/*` | `0.1.5-rc.2` |

插件用的是后者（`lib/deps.js` 的双路解析），所以 peer 范围写 rc.2 与实测一致，
不存在版本冲突。文档里凡是只写「DSH 0.1.5-rc.1」的地方，说的都是那个 CLI 包。

用户的**线上实例是 3080 端口**（`dsh web`）。**绝不要动它。**

验证一律起**第二个实例**：

```powershell
# 用受管后台 job
dsh web --port 3199 --no-open
```

端口被上次探针占住时，`job_kill` 单独不够，要杀监听进程：

```powershell
$pids = (Get-NetTCPConnection -LocalPort 3199 -State Listen).OwningProcess
foreach ($procId in $pids) { Stop-Process -Id $procId -Force }
```

否则会看到 `Error: listen EADDRINUSE: address already in use 127.0.0.1:3199`。

### 2.4 Cordis 的服务访问

- `ctx.X` 读**未声明**的服务会**抛错**（不是返回 undefined）
- 探测用 `ctx.get('X')`（返回 undefined）
- 声明依赖用 `ctx.inject(['X'], cb => ...)`
- **声明一个永不出现的服务会阻塞整个插件激活**

### 2.5 没有外网

沙箱阻断出站 HTTPS，**装不了任何新 npm 依赖**。这也是为什么整个项目是手写纯 JS、零构建。

### 2.6 ~~`compress` 工具坏了~~ —— 重启后已恢复（2026-09-11）

旧会话里反复返回 `Error: session event "user/message" carries an invalid replace surfaceOp`。
用户重启 `dsh` 后**恢复正常**：现在正常压缩，且对已压缩区间返回
`seqs X..Y already compressed (block …) — nothing to reclaim` 而不是报错。

> 仍成立的两条限制：超过 20000 字符的摘要会被拒绝，`summaryMaxChars` 参数不被接受。

---

## 3. DSH 插件契约事实（都核实过）

### 3.1 客户端插件

- 必须手写 `window.__ModuleLoader__.load({id, factory})`，用 `React.createElement`（**不能用 JSX**）
- 种子表只有 9 项：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`
- **`dsh-client-ui-primitives` 里有 `IconChevronDownOutline14` 和 `StateDot`** —— 原生卡片就是用这个图标画的

### 3.2 设置卡片机制（这是「卡片不出现」的根因）

- harness 自带四张卡是**硬编码**注册进 `settings.plugin.item` 槽的，带 `key: <命名空间>`
  参考：`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-settings-plugins/lib/client.js:1785-1809`
- 配对规则在同文件 `client.js:1145`：**卡片列表 = 已注册的槽位 ∩ 服务已提供的命名空间**
- 所以：**光注册命名空间不会出现卡片**，插件必须自己注册卡片
- 槽位契约文档明说外部插件就该这么做，且卡片 owner props 故意为空
- `PluginCard` 是那个包的**内部组件、不导出** —— 贡献卡要自己渲染折叠外壳
- 卡片的**文案**来自 harness 自己的字典，外部命名空间没有条目 → 必须自己 `ctx.locale.register(NS, {zh, en})` **并且**在槽注册里传 `locale: NS`，否则 `t` 函数根本不会传进组件

### 3.3 其他

- `@deepseek-ai/dsh-tools` 的 `defineTool` 在**注册时**就拒绝没有显式 `additionalProperties` 的嵌套 `{type:'object'}`，会拖垮整棵插件树
- `SettingsProvider` 只有在自己的文档加载完**之后**才可注入（`dsh-settings/lib/index.js:238`；init 在 `dsh-settings-file/lib/index.js:178`）
- `webServer.registerUpgrade({path, handler(req, socket, head)})` 是**精确路径独立表**，与 HTTP 前缀路由不冲突
- 会话列表：`ctx.sessions.list()` **只返回内存里活着的会话**（刚启动时是空的）。全部会话要走 `ctx.sessionQuery.listSessions()`（`dsh-session-query/lib/index.js:1040`）
- 会话目录里只有 `session.v3.jsonl.zstd`

### 3.4 ★ 冷会话读取入口（修缺口 #4 用它）

`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js:899-912`：

```js
async readSessionState(sessionId) {
  const attached = this.ctx.sessions.get(sessionId);
  if (attached !== undefined) return { id: attached.id, header: attached.header, events: attached.snapshotEvents() };
  const inspected = await inspectApiSession(this.ctx, sessionId);
  return { id: inspected.meta.id, header: inspected.meta, events: inspected.events };
}
```

活会话走 `snapshotEvents()`，冷会话走 `inspectApiSession` 回放日志 —— **标题就在 `inspected.meta` 里**。

我之前误判「冷会话没有标题」，那是用错了访问器。注意它是 **async**。

---

## 4. 历史层：v3 的四步修补（**全部已完成 —— 本节只作设计与决策记录，不要照此施工**）

> ⚠️ 下面 4.2–4.5 的标题原先写的是「待办」，那是写这份文档时的状态。**四步后来都做完了**：
> 侧栏已重做成三段并全中文（xtension/locales.js）、冷会话已能读出 transcript、
> 	est/chat.test.js 与 	est/panel-i18n.test.js 已就位、探针验收已跑过。
> 保留本节是因为它记录了**当时的取舍理由**（为什么不用 MV3 _locales/、为什么侧栏不做流式、
> 为什么整页正文不自动附带）—— 这些理由今天依然成立。
> **要看待办，看文件顶部的状态块与 README 的「与 Codex 能力的差距」表。**

### 4.1 v3 第 1 步（设置卡片对齐原生令牌）—— 已完成

**`packages/dsh-browser-bridge/lib/client.js` 的卡片/字段 CSS 已对齐原生令牌**（`lib/client.js` 里 `.dshbb-card*` 在 140-175 行附近，`.dshbb-field*` 紧随其后）：

```
卡片  border: .5px solid var(--dsw-alias-border-l4)
      background: var(--dsw-alias-bg-layer-3)
      border-radius: 16px
      transition: border-color .16s, background .16s
hover/open   border-color: var(--dsw-alias-label-dimmed)
open 背景    var(--dsw-alias-bg-layer-2)
header       padding:14px 16px; gap:12px; border-radius:12px; display:flex; align-items:center
header:focus-visible  outline:2px solid var(--dsw-alias-brand-primary); outline-offset:-2px
名称          15px / 600 / 1.4, color: var(--dsw-alias-label-primary)
描述          13px / 1.5,  color: var(--dsw-alias-label-tertiary)
箭头          transition: transform .16s；展开 rotate(180deg)
body         border-top: .5px solid var(--dsw-alias-border-l2); margin: 0 16px; padding-bottom: 8px
字段（纵向）  flex-direction:column; gap:6px; padding:12px 0
            相邻字段     border-top: .5px solid var(--dsw-alias-border-l2)
            label       13px/500, var(--dsw-alias-label-primary)
            value       12px,    var(--dsw-alias-label-tertiary)
```

**关键：原生字段是纵向堆叠**（label 在上、值在下），不是我原来那种左右并排的 label/value 行。

同时**新增了** `.dshbb-line*`（紧凑行）给侧栏弹层用（弹层是小组件，不适合 12px 行内边距）。

同一轮还做了：
- 加了 `makeTranslator(props)` 模块级辅助（`t` → 英文 → 键名三级回落）
- `ZH`/`EN` 字典补了 `browserUnavailable`/`browserConnected`/`browserNotConnected`/`statusPanel` 四个键
- `Field(props)` 改成支持 `variant: 'field' | 'line'`
- `IconChevron` 用 try/catch 守卫地 require（**种子表 require 失败会整包崩**），带文字降级
- `StatusAction(props)` 接 `props.t`；其槽注册加了 `locale: LOCALE_NS`
- BridgeCard 的 token 行改用 `dshbb-field-head`（标签与按钮同行、值在下方）
- StatusAction 的字段全部换成 `variant: 'line'` 并本地化

**当时尚未验证；后来已跑通**：
pm test 279 条全过、
pm run check:extension exit 0（见 §5.1、§8）。

### 4.2 v3 第 1 步收尾 —— 已完成

```powershell
cd <repo>
node $env:TEMP\clientcheck.mjs    # 若无此文件，按 §5.1 重建（仓库里那个 .tmp-clientcheck.mjs 已删）
npm test
npm run check:extension
```

若 `clientcheck.mjs` 不存在，按 §5.1 重建。**先验证，再动第 2 步。**

还要肉眼确认（只有用户能做）：刷新 DSH 页面后，设置 → 插件里 `browser-bridge` 卡片应与其余四张**视觉一致**（圆角、边框、字号、箭头图标、展开行为）。

### 4.3 v3 第 2 步：侧栏重做（用户意见 2、3）—— 已完成

**决策（已定，别再纠结）**：

**A. 删掉底部 `PAGE AND CONNECTION` 折叠块。** 理由它混了三种东西：
| 里面装的 | 判断 | 去向 |
|---|---|---|
| 自动同步开关 | **与扩展选项页重复** | 删，只留选项页 |
| 「附件去哪」说明文字 | 不是面板的职责 | 删 |
| 当前选区 | 是输入的一部分 | 并入输入区，仅在有选区时显示一行预览 |
| 本标签页 / 受控标签页 | 属于连接状态 | 并入头部一行：`已连接 · N 个受控标签页`，点开小弹层 |

删完侧栏就是三段：**头部（连接 + 会话选择）/ 消息列表 / 输入区**。

**B. 全部中文化。** 新建 `extension/locales.js`，导出 `zh` / `en`（**zh 为键集基准**，沿用 harness 约定）与 `t(key, params)`，语言用 `chrome.i18n.getUILanguage()` 判断，非 `zh*` 回落英文。

> 为什么不用 MV3 官方 `_locales/` + `chrome.i18n.getMessage`：那需要 `manifest.json` 加 `default_locale` 和一堆 message 文件，而且**无法从 Node 单测**。一个普通模块零构建、可测，且与宿主侧 `lib/client.js` 已用的 `ctx.locale.register(NS, {zh, en})` 形状一致。

要替换的英文串（现状清单，文件：`extension/sidepanel.html` + `extension/sidepanel.js`）：
`'no session'`、`'Reload'`、`'Ask about this page…'`、`'Send'`、`'Add this page to context'`、`'Add selection to context'`、`'PAGE AND CONNECTION'`、`'Highlight text on the page to see it here.'`、`'No messages in this session yet. Sending one from here starts it.'`、`'Loading…'`、`'No tabs grouped for DSH yet.'`、五个小节标题，以及 `sidepanel.js` 里**每一句** `say(...)` 文案。

**C. 补一处真实功能差距**：Codex 侧栏提问时会**自动带上当前页上下文**，我的要求手动点。决策：侧栏发出的消息**自动附带当前活动标签页的身份（标题 + URL）** —— 成本极低、与 Codex 对齐；但**页面正文仍必须显式点选**，因为整页文本上千 token，自动带上会悄悄推高每次提问开销。这条写进 README。

**非目标**：**侧栏不做流式输出**（需要第二条协议，收益与风险不成比例）。发送后短阶梯重读 + 空闲轮询。这是**已知并写进 README 的差距**。

### 4.4 v3 第 3 步：冷会话（缺口 4）—— 已完成

改 `packages/dsh-browser-bridge/lib/chat.js`：

- `readMessages(sessionId, limit)` 改为 **async**，优先级：`ctx.sessions.get(id)` → `deriveMessages()`；否则走 `commands.readSessionState(id)` 的 `events`（**复用宿主自己的规则，不要自己解析事件**）
- 标题：优先 `readSessionState(id).header.title`；为空时回落**该会话第一条用户消息的前若干字**（比裸 id 有用得多）
- **成本控制（必须做）**：`listSessions()` 继续只用 `sessionQuery` 的廉价记录（id + updatedAt）**不解标题**；标题**只对当前选中的那个会话懒解析**，并按 id 在面板生命周期内缓存。否则面板每次轮询都会回放全部会话日志
- `lib/index.js` 的 `/browser-bridge/chat` POST 分支相应改成 `await chat.readMessages(...)`（该 handler 已经是 async）

`lib/chat.js` 现状：`createChat({sessions, query, commands})` 返回 `listSessions()`（sessionQuery 优先、活会话合并）、`readMessages()`（**只读活会话 —— 就是要修的地方**）、`send()`（调 `commands.prompt({requestId: crypto.randomUUID(), sessionId, mode:'queue', content:[{type:'text', text}]})`）。

> `send` **绝不自己拼 UserMessage** —— 消息来源类型是会话日志和压缩器认识的东西，手造会让「谁说了什么」的审计记录失真。

### 4.5 v3 第 4 步：测试与验证 —— 已完成

1. 新增 `test/chat.test.js`：消息归一化、**冷/活分支选择**（stub 出 `sessions.get` 命中与未命中两条路径）、标题回落顺序、`send` 在 commands 缺失时的 fail-closed 文案
2. 加一条**静态检查**：断言 `extension/sidepanel.js` 与 `sidepanel.html` 里不再有裸界面字符串（用一个「必须出现的 i18n 键」清单反查），防止以后漂回英文
3. 探针实例（3199）验证：
   - `GET /browser-bridge/chat` → 会话列表非空
   - `POST {action:'messages', sessionId:<一个冷会话>}` → **返回非空消息列表**（这是缺口 4 的验收点）
   - 标题非空
4. **侧栏端到端必须真跑通一次**：在探针实例上发一条消息，确认模型收到并产生回复 —— **验过了再交付**，不要只声称
5. 恢复正规 pnpm 安装（§2.2），并在 README 补上 v3 的行为说明

---

## 5. 验证工具

### 5.1 客户端 bundle 语法检查

`lib/client.js` 是浏览器端产物，`node --check` 不管用（它会在模块顶层跑 `window.__ModuleLoader__.load`）。用工厂体解析：

```powershell
@'
import { readFileSync } from 'node:fs';
const src = readFileSync('packages/dsh-browser-bridge/lib/client.js', 'utf8');
const open = src.indexOf('factory: (require) => {');
const close = Math.max(src.lastIndexOf('},\n})'), src.lastIndexOf('},\r\n})'));
if (open === -1 || close === -1) { console.log('FAIL: could not locate the factory body'); process.exit(1); }
const body = src.slice(open + 'factory: (require) => {'.length, close);
try { new Function('require', body); console.log('OK  client.js factory body parses (' + body.length + ' chars)'); }
catch (e) { console.log('FAIL client.js factory body: ' + e.message); process.exit(1); }
'@ | Set-Content -Path "$env:TEMP\clientcheck.mjs" -Encoding UTF8
node "$env:TEMP\clientcheck.mjs"
```

### 5.2 插件入口 import 检查

`lib/index.js` **从未被任何测试 import 过** —— 写错的具名导入或语法错会拖垮整个 boot。手工验证：

```powershell
node -e "import('./packages/dsh-browser-bridge/lib/index.js').then(m=>console.log('OK', Object.keys(m).join(','))).catch(e=>{console.log('FAIL',e.message);process.exit(1)})"
```

> 这个验证**抓到过**两个真实缺陷：`cannot get property "settings" without inject`（拖垮整树）和 `unsupported JSON schema: ... additionalProperties must be explicitly true or false`。**改完 `index.js` 或任何工具定义后一定要跑。**

### 5.3 探针启动前：bundle 组合检查

```powershell
dsh --profile web --dump-config | Select-String "browser-bridge" -Context 2,2
```

应看到 `- id: browser-bridge` / `name: dsh-browser-bridge`。

### 5.4 探针实例的三条路由

```powershell
# 健康（含 settingsRegistered / originRuleCount / tokenHint）
(Invoke-WebRequest http://127.0.0.1:3199/browser-bridge/health -UseBasicParsing).Content
# 令牌（仅环回可读）
(Invoke-WebRequest http://127.0.0.1:3199/api/browser-bridge/token -UseBasicParsing).Content
# 会话列表
(Invoke-WebRequest http://127.0.0.1:3199/browser-bridge/chat -UseBasicParsing).Content
```

`settingsRegistered: true` 是命名空间注册成功的标志；`false` 说明设置服务没拿到。

### 5.5 测试套件

```powershell
cd <repo>
npm test              # 288 条，19 个 suite（不需要 pnpm install）
npm run check:extension
```

Chrome 端到端是**真的**：会起 headless Chrome（`C:\Program Files\Google\Chrome\Application\chrome.exe`）跑真实 CDP —— 快照蒸馏、按 bounds 派发鼠标事件**真的触发页面 click 监听器**、`Input.insertText`、截图魔数、控制台事件。找不到 Chrome 时**跳过而非失败**。

---

## 6. 别碰的东西（已定决策，别重开）

- **站点策略**照抄 Codex 的 `browser_use` 契约：单一 `origins` 规则表（**不是**独立白名单）、四个能力位 `access`/`downloads`/`uploads`/`full_cdp_access`、最严优先、`access:deny` 级联封其余。`auto_review`/`persistent_approval`/`access_approval_lifetime` 是 managed 层专有（用户 schema 里没有，有测试锁着）
- **审批**：DSH 的 `ApprovalService.request()` 只返回一次性 `allowed-once`，没有「始终允许」。四个选项（Allow once / Allow for this site / Allow for all sites / Decline）是在 `lib/grants.js` 层实现的，**README 里如实写了，不要伪造「始终允许」按钮**
- `turn` 时长用「5 分钟无浏览器活动」近似（turn 边界在工具上下文里不可观测），误差方向**偏向重新询问**
- `browser_history`/`browser_eval`/`browser_cdp`/`browser_upload` **每次都重新问**
- `browser_eval`+`browser_cdp` 需要 `developerMode`（默认 false）；CDP 永久拒绝 `Browser, Target, Storage, SystemInfo, Cast, Extensions, ServiceWorker, WebAuthn`（**两端都查**）
- **上下文附件不在选区产生时注入**：选区变成待发附件 + composer 里可移除的 chip；在会话的 `user/message` 事件（且 `event.data.source.kind === 'user'`）上注入 `createUserMessage({... source:{kind:'plugin', plugin:'browser-bridge', form:'notice', summary: boundContextSummary(...)}})`，落在**同一个 pre-step**，不改写用户原话。`contextAutoPush` 默认 **false**
- 传输：单条环回 WS `/api/browser-bridge/ws`；令牌（query 参数优先于 `Sec-WebSocket-Protocol: dsh-bridge-token.<t>`）+ `Origin` 必须是 `chrome-extension://<32 个 a-p 字符>`（存在时）+ 绑定更宽时的环回 peer 检查。令牌在 `$DSH_HOME/storages/dsh-browser-bridge.json`（0600，原子写），`timingSafeEqual` 比较
- **请求方向只有一条**（扩展→宿主），宿主从不回调扩展。聊天走 HTTP 路由而非反向 RPC，让浏览器半边保持纯执行器
- 侧栏会话由**用户选择**，不猜 —— 「最近活跃」会偶尔把提示词投进用户没在看的会话

---

## 7. README 里已有的诚实边界（别删）

- auto-review 的**独立 reviewer agent 未实现**（需要第二条模型路由 + 断路器），只做了 `autoReview` 开关的语义等价物
- 多浏览器（Edge/Brave/Opera/Vivaldi）、内建浏览器、书签、云浏览器/手动接管、元素高亮：均未实现
- 未确证：`allowed-once` → 「该站点本会话免问」的映射；5 分钟 turn 近似；chip 的确切视觉、发送后是否留存、`@` 提及标签页的交互细节（上游无文档）
- 官方文档自身矛盾：内建浏览器是否支持登录（`browser.md` 说不支持，`chrome-extension.md` 说支持）

---

## 8. 立即上手

```powershell
git clone https://github.com/LessXi/dsh-browser-bridge.git
cd dsh-browser-bridge

# 1. 不需要任何安装。测试是零依赖的自建 runner。
npm test                 # 288 条，19 个 suite
npm run check:extension  # 8 个扩展脚本的语法预检

# 2. 起探针做实测（用户的线上实例在 3080，绝不要动它）
dsh web --port 3199 --no-open
```

**当前唯一确定的未完成项**：`README.md` 的「与 Codex 能力的差距」一节里那条——
让模型通过 `browser_screenshot` 真的看到画面，需要有 provider 凭据的实例 + 已连接的扩展。
探针两样都没有，所以只能由用户在 3080 上验收。

**改动生效范围（别搞混，这是最常犯的错）**：

| 改了什么 | 怎么生效 |
|---|---|
| `packages/dsh-browser-bridge/lib/*.js` | 用户**重启 `dsh web`** |
| `extension/*.js` `*.html` `manifest.json` | 用户在 `chrome://extensions` **重载扩展** |

改 `lib/` 时如果要用探针验证，必须先让 `~/.dsh/profiles/web/node_modules/dsh-browser-bridge`
指向工作区（junction，见 §2.2），**否则探针跑的是旧拷贝**——这个坑本轮踩过两次。

用户会用截图验收，所以**每一步先验证再交付**，不要声称未验证的东西能用。
