# 交接工作单：DSH 浏览器桥接插件

> **当前状态：v83 已交付并入库。** 下一节就是最新的一轮改动；下面标 v82/v81/v80/v79/v78/v77/v76/v75/v74/v73/v72/v71/v70/v69/v68/v67/v66/v65/v64/v63/v61/v60/v59/v58/v57/v56/v55/v54/v53/v52/v44/v43/v42/v41/v40/v39/v38/v37/v36/v35/v34/v33/v32/v31/v30/v29/v28/v27/v14/v13/v12/v11/v10/v9/v8/v3/v4/v5/… 的段落是历史层，越往下越旧。
> 只想知道「现在能做什么、下一步做什么」，读到 v83 那一段为止即可。
>
> **环境前提：本仓库不需要 `pnpm install`。** 全新克隆后 `npm test`（612 条）与
> `npm run check:extension` 都能直接跑通——测试是零依赖的自建 runner
> （`packages/dsh-browser-bridge/test/run.js`），宿主 peer 依赖只在真实 dsh 进程里解析。
> （真浏览器 e2e 那 4 条需要机器上有 Playwright Chromium 或 Chrome for Testing；
> 没有时会**跳过并说明**，不会失败。）
>
> **要看界面**：`README.md` 的「界面」一节有 3 张主视觉海报（`docs/posters/`）与
> 11 张界面状态（`docs/screenshots/`）。`node tools/poster.mjs` 重渲海报，
> `node tools/gallery.mjs` 重渲界面状态，`node tools/preview.mjs --list` 列出全部场景。
>
> **`<repo>` 是本仓库在你机器上的位置**——文档里凡是出现 `<repo>\...` 的路径，
> 换成你自己克隆它的目录即可（例：`cd <repo>`）。
>
> **已入库**：v3→v83 的全部改动已提交并推送到 `origin/main`。工作区干净。
> （v80 是 `53602de`，v79 是 `5c8ee77`，v78 是 `768e653`，v77 是 `322fdc4`，v75 是 `e0ef3ee`，v74 是 `bb5af8d`。）

> ## ⚠️ 两条并行版本线（2026-09-23 处理，后续轮次务必先读这段）
>
> 这个仓库曾经**从同一个基线 `2ea6baf` 长出两条互不知情的版本线**，
> 而两条线都用 `v35`、`v36`… 编号，**同一个编号在两边指不同的工作**：
>
> | | 作者 | 编号 | 规模 | 内容 |
> | --- | --- | --- | --- | --- |
> | A 线 | `xihaojiang@huaqin.com` | v35 → **v50** | 17 个提交、3531 行 | forced-colors 适配、`light-dark()` 配色实测、宽面板阅读栏上限、离线的三种含义、审批 `rememberable` 门控 |
> | B 线 | 本工作线 | v35 → **v69** | 67 轮、14413 行 | 扩展图标、`bootstrap.js` 自动取令牌、22 个新测试文件、真实 harness 端到端验证、图标几何修正 |
>
> **本文件（B 线）的 v35–v69 与 A 线的 v35–v50 是两套编号，不要互相引用。**
>
> **处理结果（用户决定）**：A 线的 17 个提交原样保存在远程分支
> **`colleague-v50`**（指向 `9153db0`，一个都没有丢），`main` 前进到 B 线的
> `a0cf1a2`。也就是说 **A 线的工作当前不在 `main` 上**。
>
> **合并是未完成的工作，不是已否决的工作。** 实测过：`git merge` 只有
> 8 个文件、24 处冲突，且多数是"两边各加各的、应当都保留"，不是语义对立：
>
> - `extension/sidepanel.html`（4 处）——配色令牌（A 线 `light-dark()` vs B 线
>   `@media (prefers-color-scheme: light)`，**A 线的机制更优**：无需媒体查询、
>   forced-colors 下天然正确）、`.approval-allow` 强调色、阅读栏上限、pill 占位
> - `extension/sidepanel.js`（3 处）——播报器元素 id（A 线 `#announce` +
>   `#announce-urgent` vs B 线 `#announcer`）、`announce()` 实现、审批按钮装配
> - `extension/locales.js`（2 处）、`extension/options.html`（1 处）、
>   `README.md`（6 处）、`packages/.../test/dom-shim.js`（4 处）、
>   `panel-stream.test.js`（3 处）、`HANDOVER.md`（1 处）
>
> **合并时唯一需要产品判断的一处**：A 线让「较宽的那个授权」带实心强调色
> （`.approval-allow { background: var(--accent) }`），B 线坚持**三个等权按钮、
> 一个都不做成默认项**，理由是给同意界面的一侧加权重是记录在案的暗黑模式
> （Chrome 自己的一次性权限界面也是扁平三按钮）。合的时候要在这两种取向之间选一个。
>
> **合并另外要处理的**：A、B 两线都独立发现了同一批缺陷（配色对比度、
> 审批问题的屏幕阅读器播报），合并时会出现"同一件事的两种实现"，
> 需要按上面的取向二选一，而不是把两份都留下。


> ### v73：关掉侧边栏再打开，正在写的那句话没了（本轮）
>
> `drafts` 是一个纯内存 `Map`（`extension/sidepanel.js`），而 `panelSessionId`
> 是持久化的。也就是说：**面板记得你在看哪个会话，却不记得你在里面打了什么。**
> 侧边栏的关闭-重开正是它最常见的用法，所以这句话丢得毫不稀奇。
>
> README 只承诺过两件事里的第一件——「草稿按会话分开，切来切去不会串」。
> 第二件从没承诺过，也从没被记下「不持久化是刻意的取舍」：同一份仓库里
> `lib/grants.js` 写着 "Deliberately not persisted"，说明这里**有写明这个
> 习惯**，草稿这里没有——是漏的，不是选的。
>
> #### 先证明确实丢，再动手
>
> 用仓库自己的 `ExtensionHost` 装置装真扩展、真打字、真重载（`.tmp-run/probe-draft-survives-reload.mjs`）：
>
> | 读数 | 修复前 |
> |---|---|
> | 输入的内容 | `"这句话在重开侧边栏之后还应该在"` |
> | 重载后输入框 | **`""`** |
> | `chrome.storage.local` 全部键 | **`[]`** |
>
> 第二个探针（`probe-draft-which-cause.mjs`）要把两种解释分开：是「草稿没持久化」，
> 还是「会话根本没恢复、所以本来就没草稿可恢复」。读数排除了后者——
> `title: "草稿探针会话"`、`rows: 2`、`storedSessionId` 正确、`inputDisabled: false`，
> 而 `inputValue: ""`。**会话恢复了，文字没恢复**，解释 A 成立。
>
> #### 两个必须先量、不能靠推理的事实
>
> 修复方案是「每次击键直接写盘、不防抖」，它成立与否取决于两件事：
>
> | 问题 | 实测读数 | 对设计的决定 |
> |---|---|---|
> | `chrome.storage.local.set` 一次多久 | 短草稿 **median 0.2ms**；4000 字符 **0.3ms** | 不防抖。防抖反而制造「计时器未到、面板已关」的丢字窗口，而写一次比一帧便宜 80 倍 |
> | 连续写入会不会乱序完成 | 串行 / 30 次连打 / 乱序混合 / **250 次连打（21.2ms）** 全部落在最后一个值 | 不必 await、不必串行化。若会乱序，界面显示 `abc` 而盘上是 `a`，那种缺陷在界面上不可见，比原本要修的还糟 |
>
> 顺带确认 `pagehide` 里发起的**异步**写入会落地（`"landed"`），
> 所以不写卸载钩子也是安全的——何况击键时写的比它更早。
>
> 探针：`.tmp-run/probe-storage-write-cost.mjs`、`probe-storage-write-order.mjs`。
>
> #### 修法与它的两个判断
>
> 新增 `setDraft` / `clearDraft` / `loadDrafts`，**四个调用点全部改走它们**，
> 不再有人直接碰 `drafts`（`drafts.set` 只剩在这三个函数内部）——两处状态要
> 同步更新，就必须只有一个入口，否则迟早有一处忘了。
>
> 1. **一个会话一个键**（`panelDraft:<sessionId>`），不是「一个键装整张表」。
>    两个窗口可能各开一个面板，单条记录会让它们各自用自己那份过期副本把
>    **别的会话**的草稿写回去——在一个窗口打字，把另一个窗口写的悄悄回退掉。
> 2. **读回放在 `loadEverything` 之前**。放后面的话，输入框先被画成空的、
>    文字下一帧才出现；变异测试证明这个顺序是被测到的（见下）。
>
> #### 验证读数
>
> | 读数 | 修复前 | 修复后 |
> |---|---|---|
> | 真实 Chrome：`afterReload.inputValue` | `""` | **`"这一句必须活过重载"`** |
> | 真实 Chrome：`draftSurvived` | `false` | **`true`** |
> | 真实 Chrome：发出后 `storedDraftAfterSend` | — | **`null`** |
> | 真实 Chrome：`sentDraftDidNotReturn` | — | **`true`** |
>
> 最后两行是**反方向的验证**：只测「活过重载」的话，一个永不删除的实现
> 也能通过，而它会让已发出的消息在重开后又回到输入框、诱导你再发一遍。
>
> `npm test` → **557 passed, 0 failed, 0 skipped**（553 → 557，新增 4 条）。
> `npm run check:extension` → exit 0。
>
> #### 变异：四个坏法全部命中（`.tmp-run/mutate-draft-persistence.mjs`）
>
> | 坏法 | 变红条数 | 命中的测试 |
> |---|---|---|
> | `no-persist`（回到纯内存 Map，即原缺陷） | 3 | storage 那条、sent 那条、reopen 那条 |
> | `no-load`（启动不读回） | 1 | **只有** reopen 那条 |
> | `load-after-draw`（读回放在画之后） | 1 | **只有** reopen 那条 |
> | `no-clear`（发出后不清） | 2 | emptied 那条、sent 那条 |
>
> `restoredExactly: true`。`no-load` 与 `load-after-draw` 各只被 reopen 那条
> 抓到，说明那条测试是承重的，不是重复覆盖。
>
> 「reopen」那条测试为此**真的加载了第二份面板模块**（换一个 URL 绕过模块缓存），
> 因为模块缓存会让第二次 `import` 直接拿到已在运行的那个实例、什么都不重跑。
> 同时必须把 `setInterval` 再打一次桩，否则第二个面板装上真的 interval，
> runner 的进程永远不退出——第一次写就是这样挂住的。
>
> #### 顺带修好的测试基础设施
>
> `packages/dsh-browser-bridge/test/panel-stream.test.js` 的 `chrome.storage.local`
> 替身原来是 `get: async (defaults) => ({ ...defaults })`、`set: async () => {}`
> ——**一个什么都不存的桩**。草稿丢了一直没被测出来，一半原因就在这里：
> 没写过的草稿和写过的草稿，读回来一模一样。现在是真存的 `makeStorage()`。
>
> #### 留给下一轮的（已确认、未做）
>
> 一个视觉/交互审查子代理对 15 张 380×720 深色截图做了逐像素测量，结论里
> **按证据强度排序**的待办：
>
> 1. **「更早的内容」胶囊遮挡正文 1725px²**（唯一「内容真的被盖住、用户读不到」
>    的缺陷）。`extension/sidepanel.html` 用给可滚动内容加 `padding-top` 来给
>    浮层让位，而滚动之后 padding 已被移出视口。实测胶囊 `{x:131,y:52,w:119,h:26}`
>    压住 `div.reasoning` `{x:10,y:64,w:360,h:18}`。`normal` 场景不溢出
>    （`scrollHeight === clientHeight`）所以从没暴露。
> 2. **`noCatalog` 状态几乎不可见**：与 `normal` 的唯一画面差别是模型标签的
>    `high` / `High` 首字母大小写——而那本身又是同一份 UI 里的大小写不一致。
> 3. **`working` 场景两行「思考」同屏**：`div.reasoning`（y352，14px）与
>    `div.working`（y384，12px）同时说同一件事，而 `sidepanel.js` 的注释**明确
>    论证过这个状态不该出现**（`hasContent` 只看 `live`，而此场景 `live === null`）。
> 4. `#model-menu` 与 `#at-menu` 不一致：圆角 16 vs 12、描边无 vs 有。
> 5. 同一弹层内两套选中语言（强度行整颗药丸染色 vs 模型行只右侧 `✓`）。
> 6. `modelMenu` 压住 composer 6531px²；22px 的 chip 里塞着 24px 的按钮（各溢出 1px）；
>    header 里 `button#title` h30 与 `button#new` h28 差 2px。
>
> **审查器盲区（重要）**：`earlier` 场景跑 `--audit` 报 `occlusions: []` 全空，
> 而同一次审查实测到 1725px² 真实遮挡——**「无遮挡」读数不能当证据用**，
> 第 1 条能在 15 张图里活到今天很可能正是因为它落在审计器盲区里。
> 另外 `working` 场景报的 `div.working` 对比度 ratio 1 是**误报**：
> `background-clip: text` 的绘制手法读成了透明文字。
>
> #### 交付截图集本身有两个缺陷（是夹具的错，不是产品的错）
>
> - `streaming.png` 与 `normal.png` **sha256 相同**：夹具（`.tmp-run/preview.mjs`）
>   注入的 `dsh-assistant-delta` 缺 `kind: 'start'`，而面板只在 `kind === 'start'`
>   时建立 live block——**产品拒绝那条 delta 是设计意图**（注释论证过：没见过
>   `start` 的 delta 不许凭空造 live block，否则会渲染出「看起来像完整回复」的片段）。
>   所以**真实流式态本轮没有视觉证据**。
> - `earlier.png` 与 `hostDown.png` **sha256 相同**：那张图画的是阻塞屏，
>   「更早的内容」胶囊根本没出现在交付的图里。成因未定位。

> ### v83：界面按产品介绍，不按功能罗列（本轮）
>
> **用户的批评**（原文）：「readme里面的图片放的像功能罗列，不像产品展示和介绍。
> 能不能学学苹果发布会风格？」
>
> 这个批评是准确的，而且指出的是**两类问题**：一类是展示方式（v82 的 6 组、每组两张
> 330px 小图配技术论证），另一类是它掩盖掉的一个**真实 UI 缺陷**。
>
> #### 一、真实缺陷：内容少时消息浮在顶部，输入框上方留一大片空白
>
> 归因先做了（`.tmp-run/probe-void.js`）：`normal` 场景 4 行，末行到输入框之间
> **233px 空白（占对话区 41.7%）**。但 `suspiciousRows: []`、`overflows: false`、
> `scrollHeight === clientHeight`——**没有行在占高度不画字**，就是内容本来就少。
>
> 于是这不是「缺陷」而是「产品判断」：内容少时消息该贴**顶部**（当时的做法）还是
> 贴**底部**（输入框）？
>
> 证据是主流聊天界面：iMessage、WhatsApp、Telegram、Slack 的会话都是内容从底部往上
> 堆——你刚说完的那句话就在输入框正上方，视线不用移动。顶部对齐时，读者发完消息要
> 跑到窗口顶端去找自己刚打的那句。
>
> | 场景 | 修复前末行距 composer | 修复后 |
> |---|---|---|
> | `normal` | **234px** | **16px**（就是 padding） |
> | `approval` | 132px 富余 | 16px |
> | `working` | 214px 富余 | 16px |
> | `toolFailure` | **388px 富余** | 16px |
>
> #### 二、★ 修法只有一个是对的，另一个会静默毁掉长会话
>
> 直觉写法是 `justify-content: flex-end`。**它是错的**，而且错得看不出来：
> CSS 的对齐在溢出**之后**应用，所以一个溢出的 flex 容器会把最上面几行推进
> **滚不到的区域**。60 行时实测：
>
> | 做法 | `overflows`（60 行） | 滚到顶时第一行可见 |
> |---|---|---|
> | 现状 | true | false |
> | **`justify-content: flex-end`** | **false** ← 布局把整屏以上吞了 | n/a |
> | **首行 `margin-top: auto`** | **true** | **true** |
>
> `flex-end` 下 `overflows: false` 意味着**会话的开头永久看不到了**，而短会话里两种
> 写法效果完全一样——这个缺陷只在长会话出现，正是本仓库反复记录的那类陷阱。
>
> 自动外边距（`auto`）在没有富余空间时**恰好收缩为零**，所以两种状态不打架。
>
> **最终代码形态**（`extension/sidepanel.html`，紧跟 `#transcript` 基础规则）：
>
> ```css
> #transcript > :first-child { margin-top: auto; }
> ```
>
> 必须是 `> :first-child` 而不是 `#transcript :first-child`：胶囊让位用的是
> **这个元素自己**的 `margin-top`，后代选择器会连带匹配嵌套的首个子元素，把两件事
> 缠在一起（已固化成变异 `margin-on-descendant`）。
>
> #### 三、展示方式：主视觉用 HTML 排版，不引入图像库
>
> 新增 `tools/poster.mjs`：把画廊产出的真实 PNG 放进一个真实 Chrome 渲染的 HTML
> 舞台，输出 `docs/posters/` 的 3 张主视觉。
>
> **为什么用 HTML 而不是图像合成**：本仓库零依赖且不需要依赖。截图本来就要浏览器，
> 而浏览器比任何为了旋转 PNG 而引入的库都更会排版，`--force-device-scale-factor=2`
> 还是白送的。
>
> 四条设计纪律写在 `stage()` 的注释里：径向渐变背景（纯色会让产品边缘贴在页面上）、
> 三层投影（一层读起来是「贴上去的矩形」）、强调用颜色不用加粗（行内加粗会把字距
> 挤坏）、画布固定 1000×1180 而产品在剩余空间里自适应。
>
> #### 四、★ 实测出的两条浏览器事实
>
> 1. **Chrome 的 `--screenshot` 只截窗口，不截整页。** 900px 内容 + 300px 窗口 =
>    出图 400×300（不是 400×900）。所以画布必须**先定尺寸**，让产品去适应剩余空间，
>    而不是让页面高度跟着内容长。
> 2. **`--dump-dom` 在本机不输出任何东西**（实测长度 0），所以「先用 title 报高度、
>    再按高度截图」这条路走不通——它也是上一条的替代方案，两条一起被排除了。
>
> #### 五、★ 我自己的两次判断错误（都已纠正）
>
> 1. **`conversation.png` 里那 600px 黑色空洞，我一开始当成排版缺陷**，后来归因证明是
>    「内容本来就少」（见上）。所以我没有去"修"一个不是缺陷的东西，而是改了对齐规则
>    ——那才是真问题所在。
> 2. **主视觉草稿里写过「0 需要的权限」，是假声明。** 查 `extension/manifest.json`：
>    `permissions` = `debugger`、`tabs`、`tabGroups`、`storage`、`alarms`、`scripting`，
>    `host_permissions` 含 `http://*/*` 与 `https://*/*`。**发布会风格不是可以吹牛的
>    许可**，安全声明尤其不能。改成可核对的数字（6969 行 / 60 行 / 2.4ms）。
> 3. 搜索海报标题原写「在一万行里」，而作者最长会话是 **6969 行**——同一天里犯的
>    第二次夸大，也已改成准确数字。
>
> 海报里每个数字的出处都核过：6969 行（`extension/locales.js:73`、
> `packages/dsh-browser-bridge/lib/chat.js:540`）、60 行（`extension/sidepanel.js:69`
> 的 `PAGE_ROWS`）、2.4ms（`HANDOVER.md:586`）、`SEARCH_MAX = 30`（`chat.js:73`）、
> 按站点授权（`lib/grants.js:34`）。
>
> #### 六、验证读数
>
> - `npm test` → **612 passed, 0 failed, 0 skipped**（609 → 612）
> - `npm run check:extension` → exit 0
> - 对齐修复的变异 `.tmp-run/mutate-align.mjs`：**3/3 命中**、`falsePositives: []`、
>   `restoredExactly: true`（`drop-margin-auto`、`use-flex-end`、`margin-on-descendant`）
> - 海报守卫的变异 `.tmp-run/mutate-posters.mjs`：**3/3 命中**、`restoredExactly: true`
> - README 图片引用 **14 个，0 缺失**（3 张海报 + 11 张界面状态）
> - 十二个场景对齐复测：稀疏场景 `sitsOnComposer: true`（16px），
>   `long`/`findJumped` `overflows: true` 且 `topReachable: true`
>
> #### 七、★ 一条被否掉的怀疑（别重复挖）
>
> 我一度以为「更早的内容」胶囊压住了正文——`search.png` 里第一行气泡的文字看起来被
> 切掉一半。用**逐字符**判据实测（`.tmp-run/probe-earlier-overlap.js`）：
> **`coveredCount: 0`**。那是正常的滚动裁切：那一行正好被滚到对话区上边缘之外。
>
> `earlier.png` 与 `hostDown.png` 的 sha256 相同这件事，成因仍未定位（v82 遗留），
> 本轮未处理。
>
> ### v82：把界面放进仓库，让别人看得见
>
> **这不是一个缺陷修复，是一个交付缺口。** 用户问「我们做了这么多 UI 优化，
> 项目上能不能展示呢」——查证的结果是**不能**：
>
> | 事实 | 读数 |
> |---|---|
> | 仓库里被跟踪的图片 | **8 个，全是扩展图标**（`extension/icons/icon{16,32,48,128}`） |
> | `README.md`（2743 行）里的图片引用 | **0** |
> | 本机 `.tmp-run/` 里的截图 | **255 张**，全被 `.gitignore` 的 `.tmp-*` 挡住 |
>
>
> 二十几轮的界面工作——搜索跳转、命中小标、审批卡、模型菜单、会话列表、焦点环、
> 高对比度适配——在 GitHub 上打开仓库**一张也看不到**。README 是别人决定要不要
> 装这个扩展的地方，而它 2743 行全是文字。
>
> **修法不是「截图放上去」，是让截图可复现。** 一次性产物会静默过期，所以：
>
> - `tools/preview.mjs` 从 `.tmp-run/` **搬进仓库**。它只依赖仓库内的
>   `packages/dsh-browser-bridge/lib/chat.js` 与同目录的 `audit-in-page.js`，
>   用 `HERE`/`REPO` 相对定位，搬过去即可用（已实测）。
>   顺带把 Chrome 候选路径**补齐 macOS/Linux**——原来只有 Windows 三条，
>   注释还写着 "on this machine"，与「这是仓库里的工具」矛盾。
> - 新增 `tools/gallery.mjs`：画廊**声明式**，每条写明 `file`/`scenario`/`scheme`/
>   `locale`/**为什么它在画廊里**。`node tools/gallery.mjs` 一键重渲 11 张，
>   `--check` 做存在性检查（CI 友好）。
>   它还会拒绝**小于 8KB 的产物**：什么都没画出来的场景照样 exit 0，
>   而读 README 的人分不出「空白图」和「故意的极简图」。
> - `docs/screenshots/` 11 张实拍图，README 新增「界面」一节逐张讲解。
>
> **为什么中文场景用 zh-CN 渲染**：面板的真实读者读中文，界面是给他看的。
> 唯一的例外是高对比度那张，它证明的是**系统重绘颜色后结构仍在**。
>
> **新增测试** `packages/dsh-browser-bridge/test/screenshots.test.js`（3 条，
> 606 → 609）守三件会静默烂掉的事：
>
> 1. README 引用的每张图都存在、且**签名真的是 PNG**（删文件/改名/换目录
>    只会让渲染器显示裂图，所有既有测试照旧全绿）；
> 2. gallery 声明的每张图都**已生成**、且不是空白；
> 3. gallery 点名的每个 **scenario 在 `preview.mjs` 里仍然存在**——
>    一张描述「面板再也到不了的状态」的截图，是一条悄悄失效的产品声明。
>
> **变异验证** `.tmp-run/mutate-screenshots.mjs` **6/6 命中**，每条红的都是
> 期望的那条断言：README 指向不存在的文件、gallery 声明未生成的图、
> gallery 点名被改名的 scenario、preview 里删掉该 scenario、
> 整节画廊被删空、图被换成非 PNG。
>
> **★ 自己踩的坑（已修脚本）**：变异脚本第一版只复原源码，**没复原被它覆盖的
> `conversation.png`**，跑完之后那张图留在磁盘上是一段文本
> （首字节 `74 68 69 73` = "this"）。**变异脚本破坏的东西，和它改的源码一样必须复原。**
> 已把图片加进 `originals` 并重新生成全部 11 张（首字节已核回 `89 50 4e 47`）。
>
> **验证读数**：`npm test` **609 passed / 0 failed / 0 skipped**；
> `npm run check:extension` exit 0；11 张图逐个核过签名与体量；
> README 里 11 个 `<img src>` 全部命中真实文件。

> ### v81：对话在无障碍树里有了结构
>
> v80 让键盘能进到对话里。这一轮问的是**读屏器拿到的到底是什么**。
>
> **仪器**：`preview.mjs` 新增 `--ax-tree <selector>`，用
> `Accessibility.getFullAXTree` 取平台在某个元素下**自己算出来**的子树。
> 它与既有的 `--ax` 是**两个不同的问题**：`--ax` 从作者写的 ARIA 属性出发，
> 只能确认或否认作者自己的标注；`--ax-tree` 从**内容**出发，回答「读屏器
> 被交到手里的是什么」。对话正是需要后者的场景——能不能在消息之间移动，
> 是由**没人写下来的 role** 决定的。
>
> **缺陷（实测）**：`#transcript` 暴露 **72 个节点、深度 7、`structure=false`、
> 可导航 role 为空**——一整块 `StaticText`。内容**全都在**，却**没有一处可导航**：
> 读屏用户只能从头读到尾，无法在消息之间移动。这是「文档」与「一堆字」的区别。
> `#history` 同样是 `structure=false`。
>
> **修复**：`#transcript` 为 `role="list"`，每一行是 `listitem`；会话列表每组一个
> `list`，每个会话是一个 `listitem`。实测 `structure=false → true`、
> 可导航 role `[] → ["list","listitem"]`、main 地标保留。
>
> **★ 两个靠量才发现、靠想会做错的点**：
>
> 1. **显式 role 会覆盖元素自己的隐式 role。** 把 `role="list"` 写在
>    `<main id="transcript">` 上，`main` 从计算 role 里**直接消失**——等于用
>    「跳到主内容」换「列表结构」。所以地标上移到 `#stage`（它才是主内容区，
>    任一时刻只显示一个滚动区），列表落在它下面的元素上。
> 2. **`role="listitem"` 写在会话按钮上，按钮就不再是按钮。** 实测：会话行
>    从 `button "打造类似codex的dsh网页插件 2m ago"` 变成**裸 `listitem`**
>    （整棵树里只剩 Settings 一个 button）。**列表结构不能拿控件语义去买**，
>    所以 item 与控制是两个元素：`listitem` 包着 `button`（A/B 两种形状都量过）。
>
> **瞬态行也要带 role**：`.working`（等待行）、`.live`（流式预览）、`.approval`
> （审批卡）**都是 `#transcript` 的直接子元素**，`list` 只允许 own `listitem`。
> 它们各由自己的渲染器创建，静态夹具看不到这些状态——**注入了才量得出来**
> （`working` 场景实测 `listitem` 5 个）。
>
> **推理行是 `.reasoning` 而不是 `.row`**：任何按 `.row` 遍历的规则都会漏掉它。
> v79 的搜索描边正是这么漏的；本轮 role 也差点重演，所以 row 的 role 写在
> **产出节点的那一处共用位置**，而不是写在 `renderRow` 的五个分支里。
>
> **测试缺口（本轮真正的问题）**：加 role 前后都是 **601 passed**——套件对 role
> **零覆盖**，把整段实现删掉依然全绿。新增 5 条测试后 601 → **606**：
> `every row of the conversation is one item of one list`（遍历**行种类**，
> 并单独点名推理行）、`the waiting and streaming rows are items of the same list`、
> `a session is an item that still announces itself as a button`、
> 以及 `panel-geometry` 里读标记的两条。
>
> **变异**：`.tmp-run/mutate-list-structure.mjs` **7/7 命中**，`restoredExactly: true`。
> 覆盖：`transcript-not-a-list`、`landmark-left-on-the-list-element`、
> `rows-not-items`、`waiting-row-not-an-item`、`streaming-row-not-an-item`、
> **`item-role-on-the-button`**（本轮的核心陷阱）、`no-wrapper-so-the-list-owns-buttons`。
> 每条变异写明跑哪个套件：标记/CSS 类事实归 `panel-geometry`（读源码），
> 运行时行为归 `panel-stream`（驱动模块）。**跑错套件会得到「命中」的假读数。**
>
> **读数**：`npm test` **606 passed / 0 failed / 0 skipped**、`check:extension` exit 0。
> 真实浏览器：`structure=true`、`navigable:["list","listitem"]`、`main:1`、
> 会话仍播报为 `button`；**高对比度下 role 同样被保留**（`list/listitem/main` 齐全）。
> 视觉：`.tmp-run/r19-hist-light.png`（浅色下会话列表布局未被包裹层破坏）、
> `r19-fixed-normal.png`、`r19-fixed-hist.png`、`r19-fc.png`。
>
> **一次自己造成的测试泄漏**（已修）：新测试把面板留在会话列表视图上，
> 三百行之后 `the way back to the newest rows stays on screen while parked`
> 因此变红——**看起来像别人的缺陷**。新测试末尾必须回到对话视图。
>
> **另一个假失败**：`the waiting and streaming rows...` 第一版用
> `host.running = true; await clockOf(...)` 触发等待行，报「等待行没画出来」。
> 正确驱动是既有的 `await idle()` → `host.running = true` → `startAttempt()`
> （`deliver` 帧才开始一轮）。**夹具不画不等于实现不画。**

> ### v80：键盘读者能进到对话里，也能滚动它
>
> v79 让搜索把读者带到那个词。这一轮问的是另一个基础问题：
> **一个不用鼠标的人，能不能读到这段对话。**
>
> 结论是不能，而且缺陷比"少几个快捷键"严重。
>
> #### 一、缺陷 A：滚动区域不在 Tab 顺序里，进入内容时读者被甩回窗口最旧一行
>
> 真实浏览器 + **真实按键**实测（`.tmp-run/preview.mjs --keys`，非合成事件）：
>
> ```
> 起点 #input (scrollTop 4521，读者在看最新一条)
> Tab → #model → body → #title → #find-open → #new → button.copy
>                                                      ↑ scrollTop 变成 0
> ```
>
> Tab 从输入框出发，要经过 5 个头部控件，然后**落点是「窗口内最旧那一行的复制按钮」**
> ——而落上去的瞬间 `scrollTop` 从 **4521 变成 0**。读者被从最新一条消息甩到最旧一条，
> 只为了停在一个他根本没要的按钮上。
>
> 更根本的是：**没有任何控件的行根本够不到**。用探针按「浏览器自己的可聚焦定义」枚举
> （`.tmp-run/probe-keyboard-reach.js`、`probe-tab-order.js`）：
>
> | 读数（`normal` 场景，4 行） | 值 |
> | --- | --- |
> | `stopCount`（Tab 停靠点） | 8 |
> | `stopsBeforeContent` | 5 |
> | `rowCount` / `rowsWithText` | 4 / 4 |
> | `reachableRowCount` | 2 |
> | **`unreachableRows`** | **2** |
>
> 够不到的正是**用户问题行**与**成功的工具行**——前者是对话本身，后者是过程记录。
>
> #### 二、缺陷 B：没有 PageDown，因为没有任何可聚焦的滚动容器
>
> 键盘滚动需要焦点落在滚动容器上。实测焦点停在头部按钮时 `PageDown` **什么都不做**
> （`#title` 上连按三次，`scrollTop` 恒为 4521）。
>
> 这正是 Chrome 自己的无障碍审计会报的「Scrollable region must have keyboard access」。
>
> #### 三、修法：`tabindex="0"` + 区域命名 + 焦点环
>
> `extension/sidepanel.html` 的 `#transcript` 与 `#history` 各加 `tabindex="0"`。
> 用 `0` 而非 `-1`：目的就是让 Tab 能到；它**不改变文档顺序**，所以视觉与阅读顺序不变。
>
> 注入式实验先证明这条路可行（`.tmp-run/probe-tabindex-experiment.js` + `--keys`），
> 再落到源码：
>
> | 读数 | 修复前 | 修复后 |
> | --- | --- | --- |
> | Tab 进入内容的落点 | `button.copy`（第 1 行） | **`#transcript`** |
> | 落上去时 `scrollTop` | **4521 → 0** | **4521 → 4521** |
> | `#title` 上按 PageDown | 无变化 | 见下 |
> | `#transcript` 上按 PageDown | —— | **4521 → 4586 → 4590** |
> | `#transcript` 上按 PageUp | —— | **4590 → 4322** |
>
> 焦点环走 `.scroll:focus-visible`：`outline: 2px solid Highlight; outline-offset: -2px`。
> 两处都不是随手选的：
> - **`Highlight` 而非 `--accent`**：高对比度会丢弃 `--accent` 并重绘系统色，
>   于是焦点指示器**恰好在它最要紧的模式里消失**（与 v75 的浮层边界同一课）。
> - **负偏移而非正偏移**：这个元素的边缘**就是面板的边缘**，正偏移的环画在容器之外、
>   被裁掉，聚焦与未聚焦看起来完全一样。
>
> 命名走 `aria-label`（`stage.transcript` / `stage.history`）：可聚焦但无名的区域，
> 读屏只播报「group」——读者知道自己在哪里，却不知道那是什么。
>
> #### 四、缺陷 C：Ctrl+F 什么都不做——上一轮做的搜索没有键盘入口
>
> 实测（`--keys "ctrl+f"`）：**面板毫无反应**。浏览器侧栏没有针对任意页面内容的原生查找，
> 所以读者既没得到查找栏、也没得到报错、也无从知道面板有搜索能力——
> 上一轮那个功能唯一的入口是头部一个他必须先知道存在的按钮。
>
> 修法：`document` 级 keydown 处理 `Ctrl+F`/`Cmd+F` → `setFind(true)`。
> - `preventDefault()` 在这里是安全的：本文档就是侧栏本身，没有页面级查找会被压掉。
> - **正在输入时不抢**（`TEXTAREA`/`INPUT`/`contentEditable`）：输入框里的 Ctrl+F
>   是读者自己的手势，抢走它是把便利变成障碍。
> - 同一个处理函数里补上 **Escape 关闭查找栏**（此前 Escape 管模型菜单与历史视图，
>   唯独不管这个用 Ctrl+F 打开的层），并交回焦点给 `#find-open`。
>
> 实测：焦点在 `#model` 时按 `ctrl+f` → **`#find-input` 获得焦点、`findOpen: "true"`**。
>
> #### 五、测试基建的真实缺口：shim 把所有元素都造成 `div`
>
> `test/dom-shim.js` 的 `byId` 对任何 id 都 `new Element('div')`。于是
> `active.tagName === 'TEXTAREA'` **在套件里永远为假**——「正在输入时不抢按键」这条
> 分支根本走不到，测试红了却是**shim 的错，不是面板的错**。
>
> 修法是给少数几个**回答就是标签名**的 id 配真实标签（`TAGS` 表：`input`→`TEXTAREA`、
> `find-input`→`INPUT`）。只列测试真的会问的那几个：浏览器从标记里学到这件事，
> 而这个 shim 有意不解析标记——在这里发明一个 HTML 解析器，等于要维护第二份实现。
>
> 这条缺口是**防呆断言抓出来的**：我先写了「栏必须是关的」这条守卫，它立刻变红，
> 才暴露出我的开关逻辑用了两次无条件 click（`#find-open` 是**切换**，连点两次等于没点）。
> 顺手把它收进两个幂等助手 `findBarOpen()` / `closeFindBar()`，测试不再赌上一个测试的收尾状态。
>
> #### 六、新增仪器：`--keys`（真实按键）
>
> `preview.mjs` 新增 `--keys "Tab,Tab,PageDown"`，经 CDP `Input.dispatchKeyEvent` 发送
> **可信**按键。这件事**必须**在页面外做：`dispatchEvent` 造的是不可信事件，
> 浏览器自己的默认动作（Tab 移动焦点、PageDown 滚动）**不会执行**，用探针去量它
> 就是在量自己造的事件。顺序是「主截图 → `--probe` → `--keys` → `--after-probe`」，
> 所以截图能拍到按键的结果。
>
> **仪器自检**（防止"什么都没发生"被读成"缺陷不存在"）：Tab 在 `#input` 上能移动到
> `#model`，合成事件做不到这一点——这是"按键确实可信"的证据。
>
> #### 七、验证读数（已绿，不必重跑）
>
> - `npm test` → **601 passed, 0 failed, 0 skipped**（596 → 601，新增 5 条）。
> - `npm run check:extension` → exit 0。
> - 变异 `.tmp-run/mutate-keyboard-reach.mjs`：**8/8 命中**、`restoredExactly: true`。
>   每条变异都写明跑**哪个套件**（CSS/标记类事实 → `panel-geometry`，运行时行为 → `panel-stream`）：
>   `transcript-not-focusable`、`history-not-focusable`、`ring-in-accent`、
>   `ring-outside-the-box`、`region-unnamed`、`no-ctrl-f`、`ctrl-f-fires-while-typing`、
>   `escape-ignores-find-bar`。
> - 视觉：`.tmp-run/r18-fixed-after.png`（焦点环画在容器内侧、内容已滚动）、
>   `r18-fc-after.png`（高对比度下环可见，系统青色）。
> - 回归：Escape 关历史并交回 `#title` 未变。
>
> #### 八、本轮新增探针（`.tmp-run/`，被 gitignore）
>
> `probe-keyboard-reach.js`（按浏览器自己的可聚焦定义枚举，报 `unreachableRows`）、
> `probe-tab-order.js`（把 Tab 顺序与够不到的行逐条打出来）、
> `probe-tabindex-experiment.js`（注入式实验：先证明路可走再改源码）、
> `mutate-keyboard-reach.mjs`。
>
> #### 九、对话列表同样修了（同一缺陷的第二个实例）
>
> `historyOpen` 场景实测 Tab 顺序里出现 **`section#history.scroll "Chats"`** ——
> 会话列表也进了 Tab 顺序、也有名字。它此前与 `#transcript` 是同一份 `.scroll` 类、
> 同一个缺陷，这正是"按类修而不是按 id 修"的价值。
>
> 该场景的会话只有 3 条、列表不溢出，所以"键盘滚动历史列表"在**这个夹具里驱动不出来**
> ——记在这里，免得后人把它当成漏测。

## v79：搜索能带读者到命中，也能把那个词本身标出来
>
> v78 交付了「在整个会话里搜索」。这一轮修的是它**兑现承诺的最后一步**：
> 读者敲了关键词之后，**他真的看到那个词了吗**。
>
> #### 一、缺陷 A：跳到了命中所在的行，却没让读者看到命中
>
> 推理行折叠时只画一行「思考中 ⌄」，词在折叠体里；失败的工具行同理，
> 它的 `failure` 藏在点击之后。而 `goToMatch` 只做了两件事——移动窗口、
> 给那一行加描边。于是**读者被告知「2/3」，屏幕上却一个字都不是他要找的**。
>
> 真实浏览器实测（`.tmp-run/probe-needle-visible-after-jump.js`）：
>
> | 位置 | 修复前 | 修复后 |
> | --- | --- | --- |
> | 1/3 | `needleVisible: false` | `true`（`carriedBy: bubble`） |
> | 2/3 | `needleVisible: false`，`hitRowText: "Thinking ⌄"` | `true`（`carriedBy: reasoning-body`，`Thinking ⌃`） |
> | 3/3 | `true` | `true` |
> | **`blindCount`** | **2 / 3** | **0 / 3** |
>
> **修法**：新增 `hiddenRowText(row)` 与 `revealMatch(index)`（`extension/sidepanel.js`）。
> 命中的词在**折叠的那一部分里**时，把该行加进对应的展开集并重绘；
> 词已经在屏幕上时**不动那一行**——读者没要求看的行不该自己打开。
>
> **判据**：`hiddenRowText` 只报「折叠行藏起来的那一个字段」——推理行是 `text`，
> 工具行是 `failure`。这两行各自的可见部分（推理行的开关文字、工具行的 `name`/`summary`）
> 都不在其中，所以「词在隐藏文本里吗」这个问题有确定答案。
>
> #### 二、缺陷 B：敲了关键词，面板只改了计数，没有移动
>
> `runSearch` 拿到 `searchHits` 后只调 `renderFind()`。计数变成 `1/3`，
> 而窗口停在原处——通常命中就在屏幕外，因为**面板持的是最新那几十行，
> 而搜索正是读者够到其余部分的办法**。实测第一处命中「在屏幕上哪里都没有」。
>
> **修法**：`runSearch` 在拿到非空结果后 `await goToMatch(0)`。打字就是「带我去」。
>
> #### 三、缺陷 C（本轮新发现，v78 就有）：命中在会话末尾时，算术越界
>
> `findHitKey` 用 `anchorEnd` 反推命中在窗口里的下标。宿主**会把请求的 `end`
> 钳到会话长度**（`chat.js`：`stop = Math.min(end, size)`），而面板拿着**未钳制的请求值**
> 做减法：命中在 `size-1` 时 `anchorEnd = size+12`，`offset` 变负数，
> `rows[offset]` 是 `undefined`，于是**那一处命中永远找不到**——
> 不描边、不滚动、也不展开。短会话**整个就是「末尾几行」**，所以这是常态而非边缘情形。
>
> **修法**：新增 `rowAt(index)`，取 `end = Math.min(anchorEnd, windowTotal)`，
> 并让 `findHitKey` 与 `revealMatch` **共用它**。两者原本各写一份同样的减法，
> 正是这份重复让它们一起错。
>
> #### 四、新能力：把**那个词本身**标出来（不只是它所在的行）
>
> 描边回答的是「哪一行」。在一屏放不下的长回答或代码块里，它不回答「在行内哪里」，
> 读者仍在已经是正确的那一行里逐个字找。Chrome 自带的查找会把匹配的字符标出来。
>
> **用 CSS Custom Highlight API，不改 DOM。** 行的内容是 markdown 渲染出来的，
> 用 `<mark>` 包裹文字要拆开解析器产出的嵌套结构，且每次重绘都得先拆掉上一次的。
> `CSS.highlights` 不动 DOM，由 `::highlight()` 画。**动手之前先验证过它在本机可用**：
> 注册成功、确实绘制、且注册不改变布局（`.tmp-run/r18-hl.png` 逐像素确认）。
>
> 新增 `const NEEDLE_HIGHLIGHT = 'dsh-needle'`、`drawNeedle(node)`、`needleText()`、
> `needleRanges(node, needle)`、`textNodesIn(node)`（自己递归而不用 `TreeWalker`——
> 测试 shim 不实现它，而 range 只能寻址文本节点）。命中行由新增的 `focusIndex` 记住，
> **重绘后恢复**，否则轮询一到标记就没了。
>
> #### 五、★ 两次差点写反的结论（仪器错的两个方向）
>
> 1. **「API 不绘制」是错的。** 我用自己算出来的坐标去查像素，而那个矩形比实际画出
>    高亮的字**高了约 19 CSS 像素**；同时对照用的青色方框也读到 0。
>    真因是 `.tmp-run/png-diff-lib.mjs` 的 `decodePng` 返回**按颜色类型 3 或 4 个通道**，
>    而本项目的截图是 **3 通道（colorType 2）**：两个工具写死了 `* 4` 步长，
>    在 3 通道图上越界读取——`find-colors.mjs` 把**每个越界像素都算成命中**，
>    `check-pixel-box.mjs` 把**每个越界像素都算成无差异**。
>    修法是步长取 `image.channels`。修好后同一张图：品红 1508px，盒恰好落在蓝框内部。
>    最终靠**直接看图**得到确定结论。
> 2. **「高对比度下高亮是白底白字」是错的。** 我据此把字色从 `#ffffff` 改成 `Canvas`，
>    然后发现 forced-colors 的两张截图 **sha256 完全相同**——那个模式**自己重绘
>    `::highlight()` 的颜色**，这两条声明在那里根本不起作用。而我的「修法」在**正常模式**
>    里是有害的：实测白字在强调色上是 **4.96:1**（过 AA），改成 `Canvas` 后
>    在深色方案里是 **2.74:1**（不过）。已改回 `#ffffff`，并把两条读数写进注释。
>    **教训：一个看起来更讲究的取值不等于更好的取值，量一下。**
>
> #### 六、测试基建的两个真实缺口（不修就写不出上面的测试）
>
> 1. **`dom-shim.js` 的 `textContent` setter 不建文本节点**，而是把字符串存进一个私有字段
>    （浏览器会建一个文本节点）。于是 `needleRanges` 找不到任何文本节点，
>    **标记功能在套件里完全够不到，所有声称覆盖它的测试都在断言空气**。
>    同时 `children` 改回只含元素（浏览器的语义），`childNodes` 才含文本——
>    这一改动暴露出 `#adopt` 用 `node.children` 展开 `Fragment`，
>    而 markdown 渲染器的输出**大多是文本节点**，于是它一直在悄悄丢掉这些文字
>    （症状：复制按钮拿到 `'boldcode'` 而不是 `'Use bold and code here.'`）。改用 `childNodes`。
> 2. **测试里没有 `CSS.highlights`**，`drawNeedle` 会早返回。加了 `Map` 形状的最小替身
>    （与真实平台同为 Map）与 `document.createRange`、`Element.nodeType`。
>
> #### 七、验证读数（已绿，不必重跑）
>
> - `npm test` → **596 passed, 0 failed, 0 skipped**（589 → 596）
> - `npm run check:extension` → exit 0
> - 真实浏览器：`blindCount` 2 → **0**；`rangeCount: 1`、`allTextIsNeedle: true`、
>   `allHaveArea: true`；dark 与 light **两种方案都是 rangeCount 1**
> - 变异一 `.tmp-run/mutate-reveal.mjs`：**8/8**（含一个如实标注的**等价变异**，见下）
> - 变异二 `.tmp-run/mutate-needle-css.mjs`：**4/4**，`restoredExactly: true`
> - 视觉：`.tmp-run/r18-hl.png`（dark，词被强调色填充、白字）、`r18-reasoning.png`
>   （2/3 处、`Thinking ⌃` 已展开、词在推理体里）、`r18-fc2.png`（forced-colors）、
>   `r18-light.png`（浅色）
>
> #### 八、★ 一个等价变异，记下来免得下次再查
>
> 变异 `reveal-ignores-open-state`（去掉 `revealMatch` 里的 `rowIsOpen` 检查）
> **没有任何测试能抓到，而它不是测试缺口**：要让该检查起作用，需要一个
> 「隐藏文本含 needle **且已展开**」的行，而那种情况下 `Set.add` 幂等、
> `drawTranscript` 的签名比对早返回，观察不到差别。它改变的是 `revealMatch` 的
> **返回值**——在当前实现下不影响结果，但那个返回值是「我展开了什么」的声明，
> 说 `true` 而其实没展开是错的，所以这一项保留。
> `.tmp-run/mutate-reveal.mjs` 把它的判据反过来写（**必须不红**），
> 哪天它红了就说明实现变了。
>
> ### v78：会话搜索（本轮新增能力）+ 命中高亮的两个缺陷
>
> #### 一、新能力：在整个会话里搜索，而不是在屏幕上那 60 行里搜
>
> 作者自己的一个会话有 **6969 行**，而面板只持有最新 60 行（`PAGE_ROWS = 60`），
> 所以在此之前的「找一句话」只能靠一页页往前翻——**116 次点击**。
>
> **搜索在宿主做，不在面板做。** 面板只持有 60 行，让它回答「我的对话里有没有
> 这个词」会把真实存在的词报成不存在。新增 `chat.searchMessages(sessionId, query)`
> 与纯函数 `findRows(rows, query, maximum = 30)`（导出自
> `packages/dsh-browser-bridge/lib/chat.js`）：
>
> - **字面匹配，刻意不用正则**：转写本里满是 `.`、`(`、`[`、`\`，所以 `filter(`
>   会抛、`a.b` 会误配 `axb`。读者搜的是自己敲进去的那几个字符。
> - **从后往前遍历**，最新命中在前：6969 行里从第 1 行开始列的结果没人读到底。
> - `searchableText(row)` 拼接 `text`/`name`/`summary`/`failure`，**刻意不含
>   `callId`**——那会让读者搜到一个在屏幕上不存在的字符串，结果行看起来不含他搜的词。
>
> #### 二、窗口要能命名一个**绝对位置**，不能只数「末尾往前几行」
>
> `readMessages` 的签名扩为 `(sessionId, limit, before, end)`，`end` 是**绝对行索引**
> （窗口终点），返回值新增 `total`。理由：从末尾数的 count 不是「还在被写入的对话」
> 里的位置——搜索、跳到命中、模型再追加回复，读者就会向前滑走恰好新到的行数。
>
> 面板新增 `anchorEnd`（null = 最新）。**跳到命中**只是换一个 60 行窗口；实测任意
> 60 行窗口的渲染成本都是 **2.4ms**，而「把窗口从 60 放大到命中位置」要
> **294.1ms / 43,043 DOM 节点**（6869 行时）——所以否决了放窗口那条路。
>
> #### 三、三个真实缺陷（都由真实浏览器探针发现，不是推理出来的）
>
> **① 占位符泄漏。** `locales.js` 的 `translator` 对**未匹配的 `{name}` 原样保留**。
> `renderFind` 原先只在截断时传 `more`，于是普通搜索把字面量 `1/2{more}` 显示给读者。
> 修法是**永远传 `more`**（未截断时传 `''`）。对应测试断言的是**完整字符串**而不是
> 「不含花括号」——因为另一种写错的方式（传 `undefined`）会渲染出 `1/1undefined`，
> 它没有花括号，能大摇大摆通过「只查花括号」的断言。
>
> **② 跳到命中后「回到底部」失效（严重）。** `anchorEnd` 一旦设定就一直在请求里带着，
> `scrollTop = scrollHeight` 只是把**旧窗口**拉到底。实测：`landedAtBottom: true` 但
> `reachedNewerRows: false`，最后一行停在「第 11 个问题」（共 600），**最新内容再也回不来**。
> 修法：点击时若 `anchorEnd !== null`，清空并**重新读取**，而不是滚滚动条。
>
> **③ parked 时发送，看不见自己发的消息。** 同一机制：回复落在窗口外。修法是
> `wasParked` 为真时**先清锚点再重读**——因为下面的回声是
> `drawTranscript([...rows, { user }])`，而 `rows` 还是被 park 的窗口，只清锚点会让
> 消息被画进 600 行里的第 22 行之后。
>
> #### 四、命中高亮的两个缺陷（本轮第二轮）
>
> **① 描边画在整宽的 `.row` 上，把空白也框了进去。** `.row` 是 `display: flex` 的
> 整宽容器，`.bubble` 才是 `width: fit-content` 的气泡。真实浏览器逐字符量（本仓库
> 第 9 轮的教训：`getBoundingClientRect` 给的是行盒，会把空白算进去）：
>
> | 读数 | 修复前 | 修复后 |
> | --- | --- | --- |
> | 描边落在哪个元素 | `.row` | **`.bubble`** |
> | 描边宽度 | 360px | **272px** |
> | 左侧被框住的空白 | **100px** | 12px（气泡自身的内边距） |
> | `marksEmptySpace` | `true` | **`false`** |
>
> **② 推理行根本没有高亮。** 推理行的 `className` 是 `'reasoning'`，**不是 `'row'`**
> （`renderRow`，`extension/sidepanel.js`），所以 `#transcript .row.hit` 永远匹配不到它。
> 它躲过所有检查的原因是**夹具里只有 `user`/`assistant` 两种行**——现已往
> `.tmp-run/preview.mjs` 的 `searchableMessages()` 里加了一条带 needle 的推理行。
>
> 修法：描边按**消息元素**选择，而不是按行容器——
> `#transcript .row.hit:has(> .bubble) > .bubble`、`… .row.hit > .answer`、
> `… .row.hit > .failure`、`… .reasoning.hit > .reasoning-toggle`；无消息的行
> （上下文 chip、工具行）保留整行描边，因为它本身就是整行。新加一种行只需往这个
> 列表里添一项，不需要第二条规则。
>
> #### 五、测试基建的两个真实缺口（不修就写不出上面这些测试）
>
> 1. **`hit` 类此前没有任何测试**——把整条规则删掉，套件依然是绿的。现在
>    `panel-geometry.test.js` 有两条：一条要求四种承载消息的元素各自被描边选中，
>    一条要求推理行能被选中。
> 2. **拿到声明不等于它就是判据。** 调试这条缺陷时我写过一个防呆断言
>    `assert.equal(registry.get('find').hidden, false)`，它**永远成立**——因为 DOM shim
>    不解析标记里的 `hidden` 属性（它按 id 现场造元素），所以 `#find.hidden` 无论开没开
>    都读同一个值。守卫因此跳过了点击，而测试在「把实现整段删掉」的变异下**依然是绿的**。
>    修法是让面板自己声明状态：`renderFind` 现在写
>    `findOpenButton.setAttribute('aria-expanded', String(findOpen))`（与 `#model`、
>    `#title` 一致），测试读它。
>
> #### 六、判据错误（本仓库第五、六次同类）
>
> - **变异脚本把「测试名出现在输出里」当成「那条测试红了」。** 通过的行 `✔ <name>`
>   里同样有这个名字，于是 `includes(name)` 恒真，**15 个变异里有 8 个假报命中**。
>   必须认准失败行 `✖ <name>`。
> - **探针量的元素和修复后的元素不是同一个。** 第一版 `probe-hit-bounds.js` 量
>   `.row.hit` 的盒子，而修复把描边移到了 `.bubble` 上——于是修复看起来毫无效果
>   （读数一模一样）。改成**找出描边实际画在哪个元素上**（按计算样式找）再量它。
>
> #### 七、验证读数（已绿）
>
> - `npm test` → **589 passed, 0 failed, 0 skipped**（569 → 589）
> - `npm run check:extension` → exit 0
> - 变异一（搜索实现，`.tmp-run/mutate-search.mjs`）：**15/15 命中**，`restoredExactly: true`
> - 变异二（命中高亮，`.tmp-run/mutate-hit-outline.mjs`）：**5/5 命中**，`restoredExactly: true`
> - 真实浏览器：`zebra` → `1/2` → 跳转 → `2/2`，命中在屏且含 needle，
>   初始窗口内**不含** needle（`needleWasOnScreen: false`，证明搜的不是屏幕上的 60 行）
> - 高对比度与浅色：`outlinedClass: reasoning-toggle`、`marksEmptySpace: false`
> - 两种行都有信号：`bothKindsVisible: true`（`reasoning` 由 `.reasoning-toggle` 承载，
>   `user` 由 `.bubble` 承载）
>
> 截图：`.tmp-run/r14-rh-after.png`（命中居中、描边贴合气泡）、
> `r14-find-after.png`、`r14-fc-after.png`、`r14-light-after.png`。

> ### v77：推理等级的内部 id 泄漏到触发器上，而且每次打开面板都泄漏一次（本轮）
>
> **先更正 v75/v76 留下的一条错误记录。** 那两轮记的是「`noCatalog` 态触发器
> 显示 `high`，与正常态 `High` 只差大小写」——结论对，但**把它读成了
> 「没有模型服务的 profile 才会遇到」**。实际不是：`catalog` 的初值是 `null`
> （`sidepanel.js` L234），`refreshCatalog()` 是异步的，且在 `loadEverything()`
> 里排在**最后**（L3171）；而 `refreshGroups()`（L3158）→ `renderChrome()`
> （L2235）→ `drawModel()`（L2237）**早已画过一次触发器**。
>
> 所以 `noCatalog` 只是这个回退**永久停留**的样子；**正常配置下每次打开面板
> 都会短暂出现它**。缺陷面比原来记录的大得多。
>
> **机制**：会话记录里只存原始 id（`chat.js` L319 只保留 `reasoningEffort`
> 字符串，不带给显示名），而可读名 `High` **只存在于目录里**。于是目录未读到时：
>
> | 输入 | 修复前 | 修复后 |
> | --- | --- | --- |
> | `catalog: null` + 会话选择 | `deepseek-v4-pro · high` | `deepseek-v4-pro` |
> | `catalog` 已到 + 会话选择 | `deepseek-v4-pro · High` | `deepseek-v4-pro · High` |
> | `catalog` 已到 + 模型不在列表中 | `gone-from-catalog · high` | `gone-from-catalog · high`（**不变，这是对的**） |
>
> **为什么第三行必须不变**：目录在、只是这个模型确实不在列表里，此时显示原始 id
> 是**有据可依**的（会话真的在用这个 id）。而第一行没有这个依据——可读名就在目录
> 里，只是还没读到，那是**面板自己的延迟泄漏了出去**。这一条区分是本轮最容易修错的
> 地方，变异 `unknown-model`（把两种情况一起吞掉）被**既有测试**抓住，证明没修过头。
>
> **修法**：`extension/model-menu.js` 新增 `hasNames(catalog)`（`groups` 是非空数组），
> `modelLabel` 只在有目录可查时才拼等级名。
>
> **★ 但「文字不再变化」这个说法是错的，而且我用错了判据。** 修复后第一帧是
> `deepseek-v4-pro`，目录到达后变成 `deepseek-v4-pro · High`——**文字仍然变**。
> 真正变的是**变化的性质**，这需要逐字符求最长公共前缀才看得出来
> （`.tmp-run/probe-append-vs-rewrite.mjs`）：
>
> | | 公共前缀 | 追加还是改写 | 被推翻的内容 |
> | --- | --- | --- | --- |
> | 修复后 | 15 字符 | **追加**（`isAppendOnly: true`） | `""`（空） |
> | 修复前 | 18 字符 | **改写**（`wasRewrite: true`） | `"high"` |
>
> 修复后**没有任何已显示的内容被推翻**；修复前有一个词必须被读者重新解读。
> 「闪烁」与「补充」的分别在这里，不在「变没变」。**只看「文字是否变化」会把
> 正确实现判成坏的**——这是本仓库第四次栽在同一类判据错误上。
>
> **测试**：`model-menu.test.js` 新增 2 条（13 passed）——一条按**性质**断言
> `label.includes('· ' + id) === false` 而不是断言某个具体字符串，这样将来
> 某个模型的 id 恰好不同于它的名字时仍然被覆盖。全量 `npm test` **569 passed**。
>
> **变异**（`.tmp-run/mutate-label-before-catalog.mjs`）3 种坏法全部命中、
> `restoredExactly: true`：`revert`（完全恢复旧行为）、`groups-only`
> （只问是不是数组、不问有没有内容）、`unknown-model`（过度修复）。
>
> **真实浏览器**：`noCatalog` 态触发器从 `deepseek-v4-pro · high` 变为
> `deepseek-v4-pro`（`isLowercaseId: false`）；正常态 `deepseek-v4-pro · High`
> **完全未变**，菜单仍正常打开（`rowCount: 2`）——修复是精确的。
>
> ---
>
> ### 本轮顺带核实的三条**阴性结论**（都量过，不是没测）
>
> 目标要求「商业产品水准」，所以本轮系统扫了几条此前**从未测过**的标准维度，
> 结果全部达标——记下来免得下次重复挖：
>
> 1. **对比度**：`node .tmp-run/audit-all.mjs` → **32 个场景 × 2 配色，0 findings**
>    （含 options 设置页）。这套审查器已经处理了三件容易做错的事：`Canvas` 系统色
>    背景（不是 `body` 背景色）、透明度栈合成、以及跳过 `opacity: 0` 的 `#blocked`
>    子树（否则会贡献 6 条不可能的 `ratio: 1`）。
> 2. **触摸目标**：`.tmp-run/probe-tap-targets.js` 按 WCAG 2.2 SC 2.5.8 逐个量
>    可交互元素，**4 个场景全部 `failingCount: 0`**。这里的关键是**正确实现了
>    Spacing 例外**（24px 圆不与任何其他目标相交）——直接把所有 <24px 的报成失败
>    会误报一批本来合规的密集图标按钮，从而指向错误的修复方向。
> 3. **键盘 / 减弱动效**：`prefers-reduced-motion` 覆盖了 `sweep` 与 `caret` 两处
>    动画；Escape 关闭浮层并把焦点交回触发按钮；菜单契约已在上轮补齐。
>
> **仍未修、也已确认**：`high` 恢复成 `High` 时，触发器的 `aria-label` 与 `title`
> 同样会变一次（它们由同一个 `label` 派生）。修复后这个变化是**纯追加**，读屏
> 播报的是「Select model · deepseek-v4-pro」→「Select model · deepseek-v4-pro · High」，
> 不构成需要重读的信息；但如果将来有人改动 `drawModel` 让 `aria-label` 与可见文字
> 不同步，这里会重新变成一个播报错误。

> ### v76：模型选择器声明了 menu，却没有一样兑现（历史轮）
>
> **缺陷是两处，同一类**：`#model` 触发按钮写着 `aria-haspopup="menu"`
> （`sidepanel.html`），而它打开的 `#model-menu` **没有任何 role**；
> 里面的按钮写着 `role="menuitemradio"`（`sidepanel.js` 的 `drawModelMenu`），
> 而 `menuitemradio` 是 WAI-ARIA 的**owned role**——只允许存在于 `menu`/`menubar`
> 之内，没有父容器时浏览器无部件可描述。`#at-menu` 的子项写 `role="option"`
> 而容器同样没有 role，是同类第二处。
>
> **实测**（`.tmp-run/probe-aria-context.js`，按角色配对而非按 id）：
> 修复前 `violationCount: 2`（两条 `menuitemradio` 的 owner 为 null），
> `promises[0].fulfilled: false`。**对照组是决定性的**：同一份探针里
> `radiogroup`/`radio`（容器写了 role）**零违规**——所以这不是巧合，是规则。
> `@` 弹层 `violationCount: 1`（`option` 无 `listbox` 父容器）。
>
> **修法**：角色由**填充行的同一段代码**设置，而不是写在标记里。因为空目录态
> 必须放弃这个 role（`menu` 的唯一子节点是一句话时，读屏会播报一份并不存在的
> 选项列表）。`drawModelMenu` 在有行时设 `role="menu"` + `aria-labelledby="model"`
> （`menu` 必须有可访问名），无行时设为 `none`；`drawMentionRows` 同理用 `listbox`。
> `@` 弹层取 `listbox` 而非 `menu`：它的行是过滤集里的选项、焦点留在文本框里，
> 与 `menu` 的语义不同，给两者同一个 role 会描述错其中一个。
>
> **★ 顺带修掉的第二个缺陷：菜单每 5 秒被整个重建。**
> `refreshGroups`（`sidepanel.js` L3164-3166 每 5 秒一次）→ `renderChrome()`
> → `drawModel()` → 因 `menuOpen` 为真而 `drawModelMenu()`，而它第一行是
> `replaceChildren()`。**读者站在菜单里时，那个节点每 5 秒消失一次。**
>
> 用真实浏览器实测（`MutationObserver` 挂在容器上，等真实的 5 秒定时器）：
>
> | 读数 | 修复前 | 修复后 |
> | --- | --- | --- |
> | 一次轮询的菜单增删 | **removed 5 / added 5** | **0 / 0** |
> | 焦点 | 落到 `body` | 仍在原来那一项上 |
> | 节点身份 | 被换新 | 同一个节点对象 |
>
> 修法是**签名比对**（`drawnMenuSignature`）：行是目录与当前选择的纯函数，
> 两次输入相同就没有要画的。另补 `setMenu` 的两处键盘契约——
> **打开时把焦点移进第一项**（否则方向键事件从触发按钮冒泡，而处理挂在菜单上，
> 永远收不到）、**关闭时把焦点交回触发按钮**（否则焦点留在被移除的行上，落到
> `body`，下一次 Tab 从面板顶部开始）。这与第 7 轮修 `drawTranscript` 是同一类：
> **数据刷新销毁了界面状态**。
>
> **★ 本轮测试基建修掉两个真实缺口**（否则上面的测试写不出来）：
>
> 1. `dom-shim.js` 的 `emit` **只在自己身上派发，然后直接跳到 document**，
>    跳过了中间所有祖先。而 `role="menu"` 恰恰靠**容器上的处理函数**维持方向键，
>    所以这个 shim 分不出「菜单能用」与「按键根本没人收」。现改为逐级冒泡，
>    无父节点的 stub 仍经 `ownerDocument` 抵达 document 监听器。
> 2. `openModelMenu`（`panel-stream.test.js`）用 `registry.get('model').click()`
>    打开菜单，而**点击是切换**：上一个测试留下的开着状态会被下一个关掉。
>    这条一直存在，只是此前的断言从没依赖过「菜单真的开着」。
>    现在从 `aria-expanded`（面板自己的声明）驱动，最多点三次直到它为真。
>
> **★ 一条差点被写进测试的假断言**：给上面那条轮询测试加的防呆断言
> `assert.equal(menu.hidden, false)` **立刻变红**——揭示菜单其实从来没开着。
> 若没有这条防呆，那条测试在「把签名比对整个删掉」的变异下**依然是绿的**
> （已实测）。**这正是「判据错了会把缺陷读没了」的又一例。**
>
> **验证读数**：
> - `npm test` → **567 passed, 0 failed, 0 skipped**（560 → 567，新增 7 条）
> - `npm run check:extension` → exit 0
> - 真实浏览器（`.tmp-run/probe-contract-v3.js`）：`keyboardContractHeld: true`
>   ——打开即第一项、方向键 / Home / End 全部移动焦点、一次真实 5 秒轮询
>   `removedNodes: 0` 且节点身份不变、Escape 关闭并把焦点交回 `#model`
> - 变异 6 种坏法**全部命中**且红的正是新断言、`restoredExactly: true`：
>   `no-role`、`role-always`、`no-open-focus`、`no-arrow-keys`、`no-escape-return`、
>   `always-repaint`
>
> **探针自身的三个错**（都在 `.tmp-run/` 里改正后重写）：
> 1. 用「按顺序重新盖章」的编号判断节点身份——新节点拿到同样的编号，
>    `sameIdSet` 恒真，什么也证明不了；
> 2. 在同一个元素上先按 `ArrowDown` 再按 `ArrowUp`——第一次移动后元素已变，
>    第二次按的是新元素，两次抵消，于是报「方向键无效」；
> 3. 返回的对象字面量在 `press('Escape')` **之后**求值，于是 `menuStillOpen`
>    读到的是关闭之后的状态。**对象属性在构造时求值**，状态必须在发生时快照。
>
> **留待下一轮（已实测确认，未修）**：`noCatalog` 态触发器显示
> `deepseek-v4-pro · high`，与正常态 `· High` **只差一个首字母大小写**，
> 且按钮仍可点。**更正上一轮的记录**：菜单打开后**是有说明的**
> （`.menu-note` 读到 `No model list：no model service in this profile`），
> 上一轮记的「`.menu-note` 为空」是我那个探针**没打开菜单**造成的假读数。
> 所以真正的缺口窄得多：**只有触发器这一处看不出状态**。

> ### v75：Windows 高对比度下，浮层没有任何边界（本轮）
>
> **缺陷**：`--elevation`（`sidepanel.html` L92）的第一段是 `0 0 0 1px #0000000a`——
> **一条用阴影画的发丝边**。Windows 高对比度（`forced-colors: active`）
> **丢弃 `box-shadow`**，并把每个 `background` 重绘为 `Canvas`。于是靠它分界的表面
> 与背后的页面**同色、无边**，看起来是同一层。
>
> **实测**（`.tmp-run/probe-overlay-edges.js`，模拟该特性）：
>
> | 表面 | 普通模式 | 高对比度 | 分界手段 |
> | --- | --- | --- | --- |
> | `#at-menu` | 描边 + 阴影 | 描边 | `[border]` ✓ |
> | `#model-menu` | 只有阴影 | —— | `[]` ✗ |
> | `#earlier` | 只有阴影 | —— | `[]` ✗ |
> | `#to-bottom` | 只有阴影 | —— | `[]` ✗ |
> | `#composer` | 只有阴影 | —— | `[]` ✗ |
>
> 修复前 `noSeparatorCount: 3`（另两个当时不可见），修复后 **0**。
> 最严重的是 `#model-menu`：菜单的行读起来就是背后对话的一部分。
>
> **修法**：在该模式的块里给这五个表面加 `border: 1px solid CanvasText`。
> 判据来自读数本身——`#at-menu` 是唯一幸存者，靠的正是它已有的 `border`，
> 而**描边是这个模式唯一保留的分界手段**。按**属性**枚举表面
> （「有阴影、无描边」）而不是按 id，新加的表面自动进入范围。
>
> **第二个发现：两个弹层的边框语言已经漂移。** `#model-menu` 用 `--radius-2xl`(16px)
> 且无描边，`#at-menu` 用 `--radius-xl`(12px) 且有描边——两者在样式表里相隔约 500 行、
> 各自重复写了 9 条声明，而 `#model-menu` 的注释写着「The same … as `#at-menu`」。
> 实测 `menusDisagree: true`，且 `#at-menu` 的描边与 `--elevation` 的发丝边
> **把同一条线画了两遍**（`doubledEdges: ['#at-menu']`），行圆角也一个 8px 一个 12px。
>
> **统一**：两个弹层都是 16px、都无 `border`（边由 `--elevation` 提供）、
> 行圆角都取「容器圆角 − 4px padding」= `--radius-xl`(12px)。
> 与 README L3496 记录的官方 Codex 面板一致（容器 `rounded-2xl` 16px、行 `--radius-xl` 12px）。
> 高对比度下五个表面**全部**由通用规则拿到描边，`#at-menu` 不再有「只在一种模式里存在」的边。
>
> **顺带修好测试助手的一个真实缺口**：`panel-geometry.test.js` 的
> `ruleBody(selector)` 用 `(?:^|[},])\s*SEL\s*\{` 搜索，**分不清「规则就是 `#composer`」
> 与「规则的选择器列表里含 `#composer`」**。加了一条分组规则后，两条 composer 测试失败
> 并说「`#composer` 必须有 radius / padding，found null」，而两条声明都还在文件里。
> 现改为**按选择器列表逐项比较**，并排除 `@media` 块（条件规则不该遮蔽基础规则）。
> 另有一处调用传的是整个选择器列表 `'button:focus-visible, a:focus-visible'`，
> 在旧实现下靠巧合命中，现已改为按其中一项查找。
>
> **验证读数（已绿）**：
>
> - `npm test` → **560 passed, 0 failed, 0 skipped**
> - `npm run check:extension` → exit 0
> - 高对比度下 `noSeparatorCount` 3 → **0**；普通模式**完全未变**（四个表面 `border: null`）
> - 两个弹层 `menusDisagree` true → **false**、`doubledEdges` `['#at-menu']` → **`[]`**
> - 变异 4 种坏法全部命中且红的正是新断言、`restoredExactly: true`：
>   `remove-rule`、`drop-one-surface`、`use-shadow`、`at-menu-left-out`
> - 视觉：`.tmp-run/r10-modelmenu-fc-fixed.png`（修好）、`r10-light-light.png`（浅色）、
>   `r10-at-check.png`（@ 弹层统一后）
>
> **一个被推翻的假设（别重复挖）**：变异脚本最初把「描边色由 `CanvasText` 换成
> `var(--line-soft)`」当成一种坏法，结果**没有任何测试抓到**。追下去发现原因不在测试：
> **该模式会把任何描边重绘为系统色**。证据是 `#at-menu` 源码写 `var(--line-soft)`
> 而计算色同样是 `rgb(255, 255, 255)`，与分组规则里的 `CanvasText` 完全一致
> （`.tmp-run/probe-border-color-override.js`）。所以那不是缺陷，是判据——
> 写 `CanvasText` 是**说明意图**，不是可见性的来源。
>
> **探针自身的两个错误（判据错会读没了缺陷）**：
>
> 1. 第一版 `probe-edge-survival.js` 单跑一种模式，而 forced-colors 下阴影**已经被丢弃**，
>    于是「只靠阴影分界的表面」读数恒为 0——**缺陷自己在读数里消失了**。
>    判据必须在缺陷仍然可见的维度过测量：改为一次报两种模式，按元素身份配对比较。
> 2. `probe-menu-language.js` 按 `hidden` 过滤要比较的表面，而两个弹层**从不同屏**
>    （一个模型选择、一个 `@` 提及），过滤后每次只剩一个，比较永远不发生，
>    `menusDisagree` 假读为 false。计算样式对隐藏元素同样有效，要比较的是作者写的规则。
>    同一次还发现：Chrome 的计算 `box-shadow` 把颜色写在偏移**前面**
>    （`rgba(0,0,0,.04) 0px 0px 0px 1px`），照源码顺序写的正则抓不到那条发丝边。
>
> **本轮核实过、判定不是缺陷的三项**（上一轮视觉审查的结论，逐条量过）：
>
> - 「两个弹层用两套选中语言」——**不成立**。`#at-menu` 的 `aria-selected` 跟的是
>   **键盘光标**（瞬态高亮），`#model-menu` 的 `aria-checked` 是**持久选择**；
>   语义不同，渲染不同才是对的。
> - 「两行『思考』同屏」——**夹具产物**，不是产品缺陷。`working` 场景的
>   `DEFAULT_MESSAGES` 末行是一条**历史** reasoning 行，而 `renderWorking()`
>   （`sidepanel.js` L1628）有明确守卫：live 有内容时不画 `.working`。
> - 「22px chip 塞 24px 按钮」——**不成立**。逐对父子盒子比较
>   （`.tmp-run/probe-chip-overflow.js`）只找到一处溢出：推理行的开关按钮
>   上下各外扩 3px（`symmetric: true`），是**有意的可点面积**，不是错位。
>
> **本轮核实确认、但尚未修的**：`noCatalog` 状态在界面上几乎不可辨。
> 实测（`.tmp-run/probe-nocatalog-shown.js`）触发器显示 `deepseek-v4-pro · high`，
> 与正常态 `deepseek-v4-pro · High` **只差一个首字母大小写**，
> `.menu-note` 为空、按钮未禁用。读者无法从这个界面知道「模型目录没读到」。
> 下一轮从这里开始。
>
> **新增探针**（`.tmp-run/`，被 gitignore）：`probe-floating-surfaces.js`（按属性枚举浮层）、
> `probe-edge-survival.js`（两种模式配对比较分界手段）、`probe-overlay-edges.js`
> （五个具名表面的分界读数）、`probe-menu-language.js`（两个弹层的边框语言）、
> `probe-border-color-override.js`（作者描边色是否作数）、
> `probe-nocatalog-shown.js`、`probe-chip-overflow.js`、`probe-two-thinking-rows.js`、
> `why-composer-fails.mjs`（定位 `ruleBody` 误配）、`mutate-hc-edges.mjs`。

> ### v74：浮层压住正文——把「胶囊」这个实例，改成「浮层」这一类
>
> **缺陷**：`#earlier`（「更早的内容」胶囊）是 `position: absolute; top: 8px`，相对
> `#stage` 固定在视口顶部；而给它让位的规则写的是
> `#transcript { padding-top: calc(...) }`。**`padding-top` 属于可滚动内容，一滚就
> 移出视口**，而胶囊固定在原地不动，于是它压住「正好滚过顶部的那一行」。
>
> **A/B 实测（同一把尺子，逐字符，`.tmp-run/probe-char-occlusion.js`）**：
>
> | 读数 | 修复前 `padding-top` | 修复后 `margin-top` |
> |---|---|---|
> | `#earlier` 最坏被盖字数 | **24 个字** | **0** |
> | 盖住的文字 | `"n/是MV3扩展，wser-bridge/是宿主"` | —— |
> | `#to-bottom` 最坏被盖字数 | **7 个字** | **0** |
> | 盖住的文字 | `"：Type，来"` | —— |
> | 行盒级读数（**夸大，见下**） | 3093px² | 0 |
> | `clientHeight` | 559 | **519**（视口真的短了 40px） |
> | `scrollTop: 0` 处遮挡 | 0 | 0 |
>
> 注意那一行「行盒级读数」：3093px² 是**错的尺子**量出来的（见下面「测量本身
> 错了三次」），保留在这里是为了说明它夸张了多少——真实被盖住的是 24 个字。
>
> **为什么活了这么久（已查清）**：`panel-geometry.test.js` 里那条断言把**缺陷本身**
> 钉住了——它要求让位必须是 `padding-top`，于是「通过旧修复、拒绕正确修复」，
> 正确修复反而成了回归。**把缺陷写进断言的测试比没有测试更糟。**
>
> **修法**：改成 `margin-top`。它缩短 `#transcript` 自己的盒子（`#stage` 是 flex row，
> 该元素在交叉轴被 stretch），留出的空条**永远不属于内容**，任何滚动位置都动不了它。
>
> **同一类缺陷的第二个实例**：`#to-bottom`（「回到底部」按钮）是**同一个形状**——
> 绝对定位的浮层画在可滚动容器之上，两者是兄弟。它一直在盖约 7 个字。上一轮把它
> 当成孤立的排版问题修，所以漏了它。本轮加了 `#stage:has(#to-bottom:not([hidden])) #transcript { margin-bottom: ... }`。
>
> **怎么发现漏了第二个的**：换掉判据。原来只测 `#earlier` 一个元素；本轮改成
> `probe-stage-overlays.js`——**遍历 `#stage` 的全部绝对定位子元素**（判据是定位方式，
> 不是元素 id），新加的浮层自动进入测量范围。
>
> **测量本身错了三次，每次都夸大了遮挡**（这三个都值得记住）：
> 1. 行的 `getBoundingClientRect`——行盒是**整行宽**的，右对齐的用户消息左半边全空。
> 2. `Range.getClientRects()`——**返回行盒，不是字形盒**。`<pre>` 代码块里浮层压在
>    「json」与「Copy」之间的空白上，也会被算成压住 686px² 的文字。
> 3. `elementFromPoint` 命中测试——命中的同样是整行包装元素。
>
> 只有**逐字符**（对每个字符单独 `Range.getBoundingClientRect()`）才回答得了那个唯一
> 要紧的问题：**有没有字被挡住**。前三次都是一次误报，而且第 2 次还让我短暂地
> 相信「底部不需要修」。
>
> **反馈回路检查**：`#to-bottom` 的可见性读 `clientHeight`（`updateToBottom` 与
> `atBottom` 都读），而 `margin-bottom` 会改 `clientHeight`，所以「按钮出现 → 视口变矮
> → 判定变化」是一条闭合回路。实测**不发散**：`flickers: false`、
> `clickLandedAtBottom: true`、`clickHidTheButton: true`。视口高度在 519 ↔ 473 之间
> 变化（`.tmp-run/probe-bottom-viewport-swing.js`），这是让位的成本，不是抖动。
>
> **测试**：`panel-geometry.test.js` 原来那条改为断言 `margin-top`；新增
> `the pill reservation is outside the scrollable content`（断言 `padding-top` 为
> `null`，写成「不是 padding」而非「是 margin」，保留重设计空间）；新增
> `every floating overlay over the transcript reserves its own room`——**从标记里
> 枚举** `#stage` 的子元素，判据是定位方式而非 id，所以以后新加的浮层必须一并回答
> 这个问题。两个结构性例外都写明了理由：`#blocked` 是 `inset: 0` 的不透明整屏替换
> （不是压在字上的小圆片）；`#history` 与浮层从不同屏（浮层都在 chat 视图，`#history`
> 只在历史视图可见）。
>
> **变异**（两个真实坏法全部命中）：删掉底部保留 → 该条变红；底部保留改用
> `padding-bottom` → 变红并报出 `#to-bottom reserves its room inside #transcript's
> content, where scrolling removes it`。
>
> **验证读数**：`npm test` **559 passed, 0 failed, 0 skipped**；
> `npm run check:extension` exit 0。

> ### v72：重绘一次，就把读者正在做的事丢掉（历史）
>
> 这一轮本来是去做 v71 记下的那笔账——「整体重建 18.2ms，其中布局 16.0ms，
> 而只追加一行只要 0.2ms，所以下一步是追加而非重建」。**做对了，但收获最大
> 的部分不是性能。**
>
> #### 先量，再决定做什么
>
> v71 量的是探针**自己造**的最坏情况（把整份行集克隆一遍再 `replaceChildren`），
> 不是面板真正走的路径。所以这一轮先量真实交互，再动手。量的过程中发现两件
> 比耗时严重得多的事。
>
> #### 缺陷：`replaceChildren` 销毁全部节点，连带销毁读者的交互状态
>
> `drawTranscript` 在行变化时 `transcript.replaceChildren(fragment)`，把 470 行
> 全部换成新节点。而行变化的高频来源有两个，都是最普通的操作：
>
> - **点开一行**——展开态进了 `drawnSignature`，所以点一下会重建全部行；
> - **轮询**（`POLL_MS = 8000`）返回了不同的行。
>
> 节点被销毁，浏览器就把焦点移到 `<body>`，而选中的文本一并消失。
> 真实 Chromium 量到的读数（470 行场景，`.tmp-run/probe-focus-cost.js`）：
>
> | 读数 | 修复前 | 修复后 |
> | --- | --- | --- |
> | `focusStayedOnClickedNode` | `false` | `true` |
> | `activeElementIsBody` | `true` | `false` |
> | `activePositionAfter`（焦点顺序里的位置） | `null` | `33`（原位） |
> | **`tabsToGetBack`（重按几次 Tab 才能回到原处）** | **33** | 0 |
> | `selectionSurvived`（选中的文字还在吗） | `false` | `true` |
> | `clickedNodeSurvivedRepaint` | `false` | `true` |
>
> 键盘读者按 Enter 展开一行，焦点就掉回文档根，**要重走 33 次 Tab**；
> 用鼠标选中一段文字准备复制时，一次轮询就把选择抹掉。
> 这两件事在任何截图里都看不见。
>
> #### 修法：keyed reconciliation（按行名对账），不是"少建节点"
>
> 新增 `reconcileRows(next)`（`extension/sidepanel.js`），取代
> `replaceChildren`：
>
> - 行保留节点的条件是**行名与数据都没变**（`rowKey` 管名字，`JSON.stringify(row)`
>   管数据）。数据变了就必须建新节点，否则一行会永远停在旧文字上。
> - 只变展开态时，**原地打补丁**（`applyRowOpen`）而不再建节点——这正是点击
>   走的路径，所以被点的那个按钮**自始至终是同一个节点**，焦点根本不会掉。
> - 节点用 `insertBefore` **移动**而不是重新挂载，顺序在前的行一步都不用动。
> - 数据真的变了、节点必须新建时，才用 `containsNode` 记下焦点在哪一行的哪个
>   控件上，重建后按**行名 + 控件类名**放回去。名字能这么用，是因为 v71 已经
>   把行名做成了与下标无关的稳定标识。
>
> 行节点始终是 `#transcript` 子节点的**前缀**（`.working`/`.live`/`.approval` 都
> 追加在它们后面），所以对账时两列同步前进即可，永远不会碰到瞬态节点。
>
> #### 性能：量的是面板自己的路径，不是探针造的场景
>
> | 操作（470 行、2741 节点） | 旧 | 新 | 倍数 |
> | --- | --- | --- | --- |
> | **点开一行推理** | **16.1ms**（超 16.7ms 帧预算） | **0.9ms** | **18×** |
> | `scrollHeight` | 38375 | 38375 | 守恒 |
>
> `scrollHeight` 守恒是关键：v71 否决 `content-visibility` 正是因为它让高度永久
> 失真 82.8%，而滚动锚定（`grewEarlier` 那一支）靠这个值。这次的方案不动布局，
> 所以那一支不受影响。
>
> #### 验证
>
> - `npm test` → **553 passed, 0 failed, 0 skipped**（548 → 553，新增 5 条）。
> - 变异测试（`.tmp-run/mutate-reconcile.mjs`）三个坏法全部命中，`restoredExactly: true`：
>   `replace-all`（每行都新建）→ 节点身份与焦点两条变红；
>   `no-focus-restore` → 只剩焦点那条变红；
>   `ignore-data`（复用节点只看名字）→ 数据陈旧那条变红。
> - **视觉回归 18 个场景逐像素比对，17 个完全一致**（`.tmp-run/visual-regression2.mjs`）。
>
> #### 两个"看起来像回归、其实不是"的坑（别重复挖）
>
> 1. **`historyOpen` 的字节比对会不可靠，原因不是我的改动。** 夹具把焦点放在
>    输入框上，插入符闪烁，于是同一份代码两次渲染也可能差 70 个像素。改成
>    **逐像素比对 + 报包围盒**就清楚了：差异是 `2×35` 的一个小方块，
>    位置正好在输入框里。**第一版用 sha256 比整张 PNG，把一个闪烁的光标判成了
>    回归**——判据错了，不是代码错了。
> 2. **`working` 场景不能用作视觉判据。** 同一份代码连跑 6 次得到 **5 个不同指纹**，
>    差异区域 118×27px，就是「思考中…」的动画。跑视觉回归前先确认场景是确定性的
>    （`.tmp-run/probe-determinism.mjs <scenario> <runs>`）。
>
> #### 顺带修好的测试基础设施
>
> `dom-shim.js` 补上 `isConnected`：面板要靠它区分「我点的那行还在」与「它在我
> 脚底下被换掉了」，而 shim 里这个属性是 `undefined`，于是断言在**正确实现上也会
> 失败**。这类缺口是静默的——测试会红，但红得没有意义。
>
> #### 没做、留给下一轮的
>
> - 轮询仍是 8 秒一次的全量读取（`limit: depth`）。对账已经把重绘成本降到 0.9ms，
>   但**请求本身**没优化；长会话每次仍然传 470 行回来。
> - `depth` 只增不减：上翻过的页在会话生命周期内一直保留，没有回缩。

> ### v71：用户展开的那一行，会在「加载更早的内容」之后变成另一行（本轮）
>
> 这一轮从**滚动窗口**这条轴切入。v33 把「页码」换成「窗口」时，考虑的只有
> 滚动位置；本轮发现同一个设计还有第二个受害者。
>
> #### 缺陷：展开状态按**数组下标**记，而窗口向上扩张会让下标整体平移
>
> 机制（两处代码叠加，各自都对）：
>
> - 展开态是 `Set<number>`，`renderRow(row, index)` 用 `index` 决定 `open`，
>   点击时 `add(index)` / `delete(index)`（`extension/sidepanel.js`）。
> - `loadEarlier()` 做 `depth += PAGE_ROWS`（60），而宿主 `readMessages`
>   **从末尾切片**（`end = len - skip`、`start = end - maximum`），
>   所以窗口向**上**扩张——新的行插在数组**开头**。
>
> 一叠加：同一个下标在新数组里指向另一行。**用户展开一个失败行，上翻加载更早的
> 内容，展开态就漂到 60 行之前（一页）的另一行上。**
>
> **为什么活了 38 轮**：`panel-stream.test.js` 的夹具只回答**一份固定行集**，
> 所以"窗口变宽 + 行发生位移"从测试里根本驱动不出来。同一文件里
> `switching sessions forgets which failures were open` 的注释写着
> 「The open set is keyed by row index」——团队知道索引键这件事，只为
> **切换会话**做了清除，**没有为加载更早的内容做**。
>
> **复现（端到端，真实模块）**：新增测试 `loading earlier rows keeps an open
> row open, and on the same row`。第一版**假通过**过——`hasEarlier` 只在下一次
> 读取时才更新，所以那次 `click` 是空操作，行从未位移。加了三条防呆断言
> （胶囊必须可见、`limit` 必须真的变大、更早的行必须真的到了最前面）之后才报出
> 真实失败：
>
> ```
> ✖ loading earlier rows keeps an open row open, and on the same row
>   the open row followed the index instead of the reader:
>   it now shows "failure of older0"
> ```
>
> 「显示的是 older0」正是插入的行数造成的位移——证据精确指向机制，而非"看起来不对"。
>
> #### 修法：用**行身份**代替下标
>
> 新增 `rowKey(row)`（`extension/sidepanel.js`）：tool 行用宿主的 `callId`
> （每调用唯一），其余行用「kind + 可见文本」。`renderRow(row)` 不再接收 `index`。
>
> 两个设计判断：
> - **kind 要进键**：推理块与引用它的回答可能文字完全相同，而开一个不该开另一个。
>   （实测：这个前缀在当前结构下**不承重**——展开态是两个独立的 Set，
>   回答行不查任何 Set。保留是为了语义正确，不是为了测试。）
> - **tool 行没有 `callId` 时回退到「name + summary」，不是空串**。回退到空串会让
>   所有无 id 的 tool 行塌缩成同一个键，**开一个会把同名的全打开**——这是写测试时
>   真实撞到的第一种实现，现已固化成一条变异。
>
> #### 验证
>
> | 读数 | 结果 |
> |---|---|
> | `npm test` | **548 passed, 0 failed, 0 skipped**（原 545 + 新增 3） |
> | `npm run check:extension` | exit 0 |
> | 真实 Chromium 实测 | 点开中间一个推理行 → `bodiesOpen: 1`、`expandedToggleCount: 1`，展开体文字 = 被点那行的推理文字（`openedMatchesClick: true`） |
> | 变异（`.tmp-run/mutate-row-key.mjs`） | `back-to-index`→红、`tool-key-drops-callid`→红、`tool-key-empty-callid`→红，`allCaught: true`、`restoredExactly: true` |
>
> 截图证据：`.tmp-run/r6-open-shot.png`（新场景 `longReasoningOpen`，展开的那一行
> 在 `Thinking ⌄` 下面）。
>
> #### 本轮**量过但没改**的：长会话的渲染成本（记录下来，别重复挖）
>
> 用户的真实会话有 **6969 行**（v33 实测），所以"会话变长之后面板还快吗"是真实的
> 问题。本轮新造 `long` 场景（200 轮 ≈ 470 行）并量了：
>
> | 读数 | 470 行 |
> |---|---|
> | DOM 节点总数 | **2741**（零虚拟化，全部在 DOM 里） |
> | `scrollHeight` | 38,375px |
> | 一次整体重建 | **18.2ms**（超出 16.7ms 帧预算） |
> | ├ 建节点 | 1.2ms |
> | ├ 挂载 | 1.1ms |
> | └ **布局** | **16.0ms** |
> | 只追加一行（对照） | **0.2ms（91×）** |
> | 只改一个已有节点的文本 | 0.3ms（61×） |
>
> **成本几乎全在布局，不在建节点**——这排除了"少建节点"的方向。
>
> 试过并**否决**的：
>
> | 方案 | 重建耗时 | `scrollHeight` | 结论 |
> |---|---|---|---|
> | `content-visibility: auto` + `contain-intrinsic-size: auto 84px` | 21.5 → **2.0ms（10.8×）** | 38375 → **6594** | **否决。永久失真 82.8%**，而滚动锚定（`grewEarlier` 那一支）正是靠它；把 470 行全滚一遍也不收敛 |
> | `contain: layout style` / `content` / `paint` | 16.1–17.1ms | 守恒 | 无效（既不省布局也不改高度） |
> | `overflow-wrap: break-word` / `normal` 替换 `anywhere` | 16.2–17.8ms | 守恒 | 无效 |
>
> 现在留下的读数是：**唯一有效的手段是跳过屏外布局，而它恰好破坏滚动锚定**。
> 下一步若要修，方向是"追加而非重建"（0.2ms vs 18.2ms），但那要动
> `drawTranscript` 里那套很微妙的滚动锚定，属于独立一轮的工作，本轮没有动。
>
> 探针（全部保留在 `.tmp-run/`）：`probe-long-nodes.js`、`probe-rebuild-cost.js`、
> `probe-rebuild-breakdown.js`、`probe-append-vs-rebuild.js`、`probe-content-visibility.js`、
> `probe-cv-convergence.js`、`probe-cv-reader-drift.js`、`probe-contain-options.js`、
> `probe-wrap-cost.js`、`probe-row-heights.js`、`probe-expand-marker.js`、
> `probe-reasoning-shape.js`、`probe-reasoning-shot.js`。
> 变异：`.tmp-run/mutate-row-key.mjs`。

> ### v70：Windows 高对比度下的两处状态丢失（本轮）
>
> 这一轮换了验证轴：v3→v69 的每一次实测都在**普通渲染**下进行，配色只在
> `dark` / `light` 之间切换。Windows 高对比度（`forced-colors: active`）是另一个轴，
> 而它对这套界面的作用方式完全不同——它不是"另一种配色"，是**浏览器接管颜色**：
> 作者的 `background-color`、`box-shadow` 会被替换或丢弃，`outline` 会被保留并重着色为
> 系统 Highlight。
>
> 面板大量依赖被丢弃的那两类绘制，所以这个模式下暴露了两处真实缺陷。
>
> #### 先补仪器：`preview.mjs` 此前**无法模拟这个模式**
>
> `preview.mjs` 的 `Emulation.setEmulatedMedia` 只模拟 `prefers-color-scheme`，
> 于是"高对比度下没问题"这类结论此前根本没有被测量过。本轮给它加了三个能力：
>
> | 新增 | 作用 | 验证方式 |
> | --- | --- | --- |
> | `--forced-colors none\|active` | 第二个独立轴（与配色轴正交） | `.tmp-run/probe-forced-colors-flag.js` 用 `matchMedia` 读回：`none`→`false`、`active`→`true` |
> | `--focus <selector>` | **截图之前**把焦点放到元素上 | 截图发生在探针之前（`preview.mjs` 里 capture 在 probe 前），没有这个开关，任何"焦点长什么样"的图其实都是未聚焦状态 |
> | `working` 场景 | 回合运行但还没有任何 token | 此前**没有任何场景渲染过 `.working`**，而那是每次提问都会经过的状态 |
>
> #### 缺陷一：输入框的焦点环在高对比度下完全消失（功能性）
>
> `sidepanel.html` 里 `textarea:focus-visible { outline: none }` 关掉浏览器自带 outline，
> 替代品是 `#composer:has(textarea:focus-visible) { box-shadow: ... }`——
> 而 **forced-colors 丢弃 `box-shadow`**。两头落空，键盘用户看不出焦点在哪。
>
> **证据**（`.tmp-run/probe-forced-colors.js`，7 个可聚焦控件）：
> 全部 7 个都 `lostShadowRing`；6 个按钮靠浏览器强制 outline 幸存（`survivesByOutline`）；
> **只有 `textarea#input` 是 `ownOutline:false` + `cardOutline:false` → `unindicated`**。
> 双模式对照 `.tmp-run/probe-fc-paint.js`：`composerShadowDrawn` 从 `true` 变 `false`。
>
> **修法**（`sidepanel.html`，紧随 `#composer:has(...)` 规则）：
>
> ```css
> @media (forced-colors: active) {
>   textarea:focus-visible { outline: 2px solid Highlight; outline-offset: 1px; }
> }
> ```
>
> 用真正的 `outline` 而非 shadow：该模式**保留** outline 并重着色为系统 Highlight，
> 这正是它有效的原因。范围限定在媒体查询内——普通渲染下那条 `outline: none` 是 v67
> 有意为之（圆角卡片内的方框环），必须保持不变。
> **验证**：修复后 `unindicated: []`；正常模式截图 **sha256 与修复前逐字节相同**
> （`6436ee23…`），证明普通渲染零影响。
>
> #### 缺陷二：推理强度的选中态只由会被丢弃的绘制表达（信息性）
>
> `.menu-effort[aria-checked="true"]` 与未选中项的差异**只有** `background` +
> `inset box-shadow`，两者在 forced-colors 下都被丢弃。
>
> **证据**（`.tmp-run/probe-state-paint.js`，按"会不会被丢弃"给差异分类）：
> 高对比度下唯一幸存差异是 `rgba(0,0,0,.15)` vs `rgba(0,0,0,.11)`——两个几乎一样的黑，
> `survives: []`。截图确证 `Low` 与 `High` 看起来完全一样。
> **模型行没这个问题**，因为它用 `✓` 字形（`sidepanel.js` 里 `.check` span）。
>
> **修法**：给每个 effort 按钮加 `<span class="check">`（`effort.checked ? '✓' : ''`，
> `aria-hidden="true"`，因状态已由 `aria-checked` 承载）+ `<span class="name">` 包住标签；
> CSS 上 `.menu-effort` 改 `inline-flex`，`.check` 固定 10px 宽（避免勾号出现时标签横跳）。
> **验证**：修复后 `stateCarriedOnlyByDiscardedPaint: []`，幸存差异是 `text: ✓High -> Low`。
>
> #### 一个探针误报，值得记住
>
> `probe-state-paint.js` 第一版只比样式属性，于是加上 `✓` 之后它**仍然报缺陷**——
> 因为那个勾是子节点的 `textContent`，不是任何一条 CSS。已把 `text` 加进"幸存类"判据。
> **教训：探针报错时先读被测代码的类型/机制，别先怀疑产品**（v69 已经踩过一次同类坑）。
>
> #### 测试缺口：模型菜单的 DOM 此前**一条测试都没有**
>
> `panel-stream.test.js` 的 fixture 在 `action === 'models'` 上**无条件**返回
> `{ error: 'empty-catalog' }`，所以菜单**从这个套件里根本打不开**——
> `drawModelMenu` 建的两行状态行（选中的模型、选中的推理强度）从来没被任何测试看过。
> 本轮把该响应改为可覆盖（`host.catalog`，与其他 fixture 字段一致），并补 3 条测试：
>
> 1. 选中的推理强度由**字形**标记，不只是色块；
> 2. 字形落在**正确的**那一行（勾错了比不勾更糟，它在断言一件假事）；
> 3. 两行用**同一个**约定（`.check` 槽位两边都有）。
>
> **变异验证**（`.tmp-run/mutate-effort-mark.mjs`）：`no-mark`→红、`mark-always`→红、
> `mark-unhidden`→红，`allCaught: true`、`restoredExactly: true`。
> 焦点环那条另有 `.tmp-run/mutate-focus-forced-colors.mjs`：`drop-block`→红、
> `shadow-instead`→红（后者是"看着像修好了、其实在该模式下依然不画"的写法，最难靠读代码发现）。
>
> **同时横扫了此前没扫过的轴**：`.tmp-run/height-scan.mjs` 扫**视口高度**
> （此前只扫宽度）——4 场景 × 6 高度 = **24 组合 0 broken**，`header`/`stage`/`#composer`
> 三块始终不重叠、输入框不掉出视口。高度是侧栏唯一随用户拉窗口变化的尺寸，值得单独扫。
>
> 测试：**545 passed, 0 failed, 0 skipped**（原 542 + 新增 3）。

> ### v69：插件第一次在真实 `dsh web` 进程里端到端跑通；图标的一个错误前提被推翻（本轮）
>
> 这一轮做了两件事，都是"把产品送到用户手上"这件事的前置条件。
>
> #### 一、首次在真实 harness 里验证整条链路（此前全部在测试装置内）
>
> v3→v68 的所有验证都发生在自建装置里（假宿主 + 真扩展，或真宿主 + 假扩展）。
> 这一轮第一次让**两边都是真的**：
>
> 1. 在隔离的 DSH_HOME（`F:\Projects\dsh\dsh-bridge\.tmp-home-v69`，`profiles/node_modules`
>    用目录联接共享，**不碰用户的 3080**）里建了一个只含
>    `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` + `dsh-browser-bridge` 的 profile；
> 2. `dsh --profile web --port 3199 --no-open` 起真进程；
> 3. 真 Chrome 装真 `extension/`，**storage 里只写端口、不写令牌**，模拟"刚装好扩展"。
>
> **结果（全部实测）**：
>
> | 观察 | 读数 |
> | --- | --- |
> | 插件是否激活 | `.tmp-home-v69/storages/dsh-browser-bridge.json` 被创建，令牌 64 字符 |
> | `/browser-bridge/health` | **200**，`enabled:true`、chatServices 全 `true`、`attachmentService:true` |
> | `/api/browser-bridge/token` | **200**，扩展能自己取到令牌 |
> | 扩展是否自行接通 | 从**harness 侧**看到 `connected:true`、`connections` 递增 |
> | 取的令牌是否正确 | `storageTokenIsTheHarnessOne: true`（与磁盘上的逐字相同） |
> | 是否被钉成手动 | `manualToken: false` —— 保持"自动"，harness 换令牌仍会被发现 |
>
> 探针：`.tmp-run/probe-real-harness-e2e.mjs`、`.tmp-run/probe-manual-token-after-enrol.mjs`。
>
> **一个自己踩的坑**：第一版把 `manualToken` 的判据写成"找一个 64 字符串"，
> 于是报出 `unexpected shape: boolean`。查 `background.js:355/362/372` 与
> `options.js:169-181` 才确认它的契约是**布尔标志位**（"用户是否亲手编辑过令牌"），
> 不是令牌文本——令牌文本在 `token` 键里。判据已按真实契约改写。
> **教训：探针报"意外形状"时先读被测代码的类型声明，不要先怀疑产品。**
>
> **另注**：`connections` 是**累计**连接次数（`lib/index.js:55-71` `onConnected()`
> 每次递增、断开不归零），设置页也写作「**本轮**连接次数」。看到它在没有浏览器
> 连接时仍是 8 不要当成连接泄漏。
>
> #### 二、16px 工具栏图标：一个没被验证过的前提，导致了一个没必要的缩小
>
> 用户每天点的那个图标，是 16×16 的鲸鱼。它一直是 `scale 0.70`、左偏下，
> 理由写在 `.tmp-run/measure-icons.mjs:11` 与 `finalise-icons.mjs:5`：
> "Chrome 的徽章盖在图标**右上角**"，所以要缩小避让。
>
> **这个方位是错的。** 当前 Chromium 的实现
> （`chrome/browser/ui/extensions/icon_with_badge_image_source.cc`）把徽章画在右**下**：
>
> ```cpp
> const int badge_offset_y = icon_area.height() - badge_height;
> badge_background_rect_ = gfx::Rect(icon_area.x() + badge_offset_x,
>                                    icon_area.y() + badge_offset_y, badge_width, badge_height);
> ```
>
> 按该算法把徽章叠加到真实素材上（`.tmp-run/render-badge-truth.mjs`，照抄常量
> 28×28 icon area、badge 高 14、右下对齐、圆角 3+1、1px `kClear` 外扩），
> 覆盖的是图标坐标 **x 7–12、y 7–12**；而鱼尾在**右上**，本来就不会被盖住。
> 实测两种几何被徽章抹掉的墨迹比例**完全相同（7.4%）**——避让的收益是零，
> 代价却是 16px 下鲸鱼的眼睛糊成一块蓝斑。
>
> **修法**：`.tmp-run/pick-icon16-geometry.mjs` 在正确的前提下重扫 140 个候选
> （约束只有两条：不触图标边缘、留在图标内），取墨迹最多的一档。
> 新几何为**居中 `scale 0.84`**（扫描出的 0.92 鱼尾已贴右边缘，留白不足，
> 故取 0.84）。墨迹占比 **0.195 → 0.262**，眼睛与尾鳍在真实尺寸下成形。
> 32/48/128 **未改动**——它们从不是这个错误前提的产物。
>
> 保存的证据：`.tmp-run/icon16-before-after.png`（修正前后并排，含 ×11 放大与
> 真实尺寸工具栏）、`.tmp-run/badge-truth.png`（徽章实际覆盖位置）。
>
> #### 三、新增一条会红的回归测试，并当场验证它会红
>
> 这条测试断言"16px 的墨迹占比仍在认得出是鱼的区间"（`extension-icons.test.js`）。
> **第一版写错了**：它还钉了 mark 外接框宽度 `> 0.5`，而扫描中每个候选的实测值
> 恒为 `0.5` —— 那等于把发布值当成唯一正确答案，**任何改进都会被判红**。
> 已改为只断言真正必须的性质（墨迹量、轮廓不小于下限、四周留白存在）。
>
> **变异测试（`.tmp-run/mutate-icon16.mjs`）**：
> 鱼缩到 0.45 → **红**；放大到 1.10 → **红**；移到触边 → **红**；
> 换成扫描出的更优几何 0.88 居中 → **绿**（这条是特意加的：一条把改进也判红的
> 断言是在锁定现状，不是在保护可辨识度）。
> `brokenOnesCaught: 3`、`improvementsAllowed: 1`、`allBehavedAsExpected: true`。
>
> **一次意外但有效的验证**：渲染对照图时误把旧图标写回 `extension/icons/icon16.png`，
> 重跑测试**立刻变红**（`the mark covers only 0.195 of the tile`）——
> 这条断言的防护力因此得到了一次非计划的实证。
>
> #### 四、文档与生成器同步（否则下次重跑会退回缺陷）
>
> - `README.md` §图标段落补了 **v69 更正**（原文写着"徽章所在的右上角"，已改正并给出源码依据）。
> - `HANDOVER.md` v54 段（图标首次实现处）加了指向本段的更正标记。
> - `.tmp-run/measure-icons.mjs` 顶部加醒目更正框，并注明它**已被
>   `pick-icon16-geometry.mjs` 取代、不要再用来选几何**（它内部仍是错的右上判据，保留为记录）。
> - `.tmp-run/finalise-icons.mjs`：`SCALE_BY_SIZE[16]` 由 `0.70` 改为 `0.84`，
>   新增 `OFFSET_BY_SIZE = { 16: { dx: 0.50, dy: 0.50 } }`（其余尺寸沿用 0.42/0.58）。
>   **验证方式**：重跑生成器后四个 PNG 的字节数与修复后逐位一致
>   （16=444、32=888、48=1379、128=4051），再跑图标子集 5 条全绿 ——
>   修复是**可复现**的，不是一次性的手工替换。
>
> #### 五、验证读数（全部实测）
>
> - `npm test` → **541 passed, 0 failed, 0 skipped**（v68 为 540，新增 1 条可辨识度断言）
> - `npm run check:extension` → exit 0
> - `node .tmp-run\width-scan.mjs` → **30 组合（5 宽度 × 6 场景）0 findings**
> - 面板几何/焦点环/ARIA 三项探针在 380×720 下均无发现：
>   `ringIsTheOnlyDifference: true`；7 个可聚焦元素全部可达且焦点可见
>   （`unindicated: []`，"环画在卡片上"的只有 `#input -> #composer`，是 v67 有意为之）；
>   ARIA `unnamedControls/ghostFocus/unnamedIconButtons` 均为空数组。
>
> #### 六、遗留（下一轮可做）
>
> 1. **插件仍未安装到用户的 3080 实例**。`~/.dsh/profiles/web/package.json` 的
>    `dsh.profile.bundles` 里没有 `dsh-browser-bridge`，`storages/` 也没有令牌文件
>    —— 也就是说 README 描述的功能对用户当前**不可达**。本轮已在隔离 profile 里
>    证明它装得上、跑得通（见第一节），但**没有替用户改 web profile**
>    （那是不可逆地改变他的日常环境，先问）。安装命令即 README §2：
>    `dsh plugin --profile web add file:<repo>\packages\dsh-browser-bridge`。
> 2. `.tmp-run/` 仍被 gitignore，本轮全部探针与对照图不随仓库交付。
>    图标那条断言已进仓库（`extension-icons.test.js`），但**它依赖的扫描依据
>    （`pick-icon16-geometry.mjs`）不在仓库里**。
> 3. `#input` 的 `max-height: 140px` 到顶后能滚到末尾、卡片同步长高，
>    实测非缺陷（`canScrollToEnd: true`）；三处 `transition` 未纳入
>    `prefers-reduced-motion`，属细节层级，未动。
>

>
> 这一轮做的是**首次使用体验**里最大的那道坎，而且它不是画得好不好看的问题：
> 装上扩展之后，用户必须去 DSH 设置页复制一个 64 位十六进制令牌，切到另一个窗口，
> 粘进一个**看不见内容**的框里。做错一步的报错还会指向 harness。
>
> #### 一、先量，再决定动不动手
>
> 关键事实不是推理出来的，是**在真实 Chrome 里量出来的**
> （`.tmp-run/probe-token-cors.js`，三种发起方各测一次）：
>
> | 发起方 | 结果 |
> | --- | --- |
> | 普通网页 `fetch` | `TypeError: Failed to fetch`（被 CORS 阻断） |
> | 网页 `mode:'no-cors'` | `type:opaque, status:0, leaked:false`（请求发出，读不到） |
> | **扩展页面** | `status:200, readToken:true` |
> | **扩展 service worker** | `status:200, readToken:true` |
>
> 服务器看到的请求头里 **`origin: null`**。扩展的 `http://127.0.0.1/*`
> `host_permissions` 让它能读 `lib/index.js:695-710` 的
> `/api/browser-bridge/token`——而那条路由**只做 loopback 检查，不带任何 CORS 头**。
>
> #### 二、安全论证（这是整件事成立的前提，不是附注）
>
> **自动获取令牌不扩大任何人的读取权限。** 那条路由本来就对**本机上任何进程**开放
> ——它的注释写明了「loopback-only unconditionally」，保护它的一直是浏览器的
> same-origin policy，不是保密。扩展能读它，是因为 manifest 声明了那个 host
> permission；网页读不到，是因为响应没有 `access-control-allow-origin`。
>
> 所以变的只是**所有者不必再当自己值的快递员**。红线也由此确定：
> **绝不能给该路由加 CORS 头**——那才会真的把令牌广播给用户打开的任意网页。
> 本轮 `lib/` **一行未改**，上述性质原样保留。
>
> #### 三、改了什么
>
> 新增 `extension/bootstrap.js`（`fetchBridgeToken(port, options)`，导出纯函数，
> 便于注入 fetch 测试）。流程：先读 `/browser-bridge/health`，**`enabled: false`
> 就停手并单独报「桥接被关掉了」**——用户在 DSH 里关掉桥接是明确的意思表示，
> 悄悄连上去会让那个开关变成摆设。
>
> `extension/background.js`：`connect()` 在无令牌且非手动时调用 `enrol(port)`；
> 失败**走同一条退避阶梯重试**（`scheduleReconnect()`）。
>
> `extension/options.js`：令牌字段改为「通常留空」，新增**重新取令牌**按钮；
> 三种失败各给一句对症的话（无 harness / 桥接已关 / 应答无令牌），而不是
> 一句「取不到令牌」把人打发去同时检查三件事。
>
> #### 四、自己抓到并修掉的两个真实缺陷
>
> 1. **enrol 失败后排重试**（第一版我写成直接 `return`，注释还把它论证成「不需要」）。
>    真实顺序是**先装扩展、后启动 `dsh web`**；不重试就永远发现不了 harness 起来了，
>    用户看到的是「桥接坏了，直到重启浏览器」。变异测试 B 精确命中这一条。
> 2. **自动令牌被静默提升成手动**（`extension/options.js`）：`load()` 把取到的令牌
>    写进字段，`save()` 又按「字段非空」判定为手动覆盖——于是用户**只要点一次
>    「连接」**，令牌就被钉死，此后 harness 换令牌时扩展会拿着旧的连不上且无从察觉。
>    修法：新增 `tokenEdited` 标志，只有**真实编辑事件**（`input`）才算手动；
>    「重新取令牌」是程序清空，显式重置该标志。变异测试 C 命中。
>
> #### 五、测试装置的三处修正（都是真实的坑）
>
> - `test/service-worker.js` 的 `data:` URL 加载必须把 `bootstrap.js` 也改写成绝对
>   URL，否则 `Invalid relative URL or base scheme is not hierarchical`，**整个套件
>   挂死**（不是失败）——因为相对 specifier 无法对 `data:` 基址解析。
> - `test/options.test.js` 同理；其 `chrome.storage.local.set` 原来是空操作，改为
>   **真的存取**，否则自动取到的令牌读回来是空的，页面正确却测不出来。
> - 新增 `test/bootstrap.test.js`。**它必须自己抢回真 `fetch`**：
>   `panel-stream.test.js:196` 在模块作用域永久替换 `globalThis.fetch` 且从不恢复，
>   而 `run.js` 先 import 全部套件再跑测试——那个 stub 对
>   `/browser-bridge/health` 返回**没有 `enabled` 字段**的假响应，于是「桥接已关闭」
>   这条被绕过、继续去取令牌，全量运行时它单独变红。沿用 `options.test.js` 已有
>   的 `realFetch` 模式并加了守卫（若全局已被替换则**大声报错**而不是悄悄测错）。
> - 另修 `closedPort()`：候选端口改为**随机取**。原先的固定端口会让上一个测试释放
>   的端口被下一个测试的 `listen(0)` 复用，而前一个 worker 仍在重试，打进来污染计数。
> - 负面断言（「没有发生请求」）改用**阳性信号**（health 已读 / settings 已读）作等待
>   条件，而不是固定睡眠——睡眠无法区分「它拒绝了」和「它还没跑到」。
>
> #### 六、验证读数（全部实测）
>
> - `npm test` → **540 passed, 0 failed, 0 skipped**（基线 530，新增 10 条：
>   `bootstrap.test.js` 6 条 + `options.test.js` 4 条）
> - **真实 Chrome 端到端**（`.tmp-run/probe-enrol-real-browser.js`）：清空 storage
>   的扩展自己读到 `sawHealth:1, sawToken:1`，并发起升级
>   `upgradeTokenIsRight:true`，`upgradeOrigin:chrome-extension://hajmm…`，
>   扩展自报 `tokenLength:64, manualToken:false`。
> - **变异测试三条全部有效**：去掉自动注册 → 3 条红；去掉重试 → 1 条红（精确）；
>   忽略 `manualToken` → 1 条红（精确）。
> - `node .tmp-run/audit-all.mjs` → **32 scenarios, 0 findings, 0 broken**
> - `npm run check:extension` 通过（并把新文件 `bootstrap.js` **补进了该脚本**——
>   原先没有，是新文件暴露的缺口）
>
> #### 七、同步更新
>
> `README.md`：安装第 4 步改写为「打开扩展，点一下连接」，并说明令牌字段的用途是
> 手动指定；测试数 523→540；验收清单第 2 条改为「不填令牌直接点连接，状态点变绿」。
> `package.json`：`check:extension` 补 `bootstrap.js`。
>
> #### 八、用户需要做的一件事
>
> 在 `chrome://extensions` **重载扩展**（改的是 `extension/*`，不需要重启 `dsh web`）。
> 重载后打开选项页，**不填令牌**直接点「连接」应即变绿。
>
> #### 九、遗留
>
> 1. `origin: null` 这个观测值得记一笔：扩展页面的跨域 fetch **不带 Origin 头**，
>    所以服务端现有的 `isExtensionOrigin` 校验对这条路径不适用。令牌路由只查
>    loopback 正是因此仍安全（网页的 fetch 必带 Origin，会被 CORS 挡住），
>    但**以后若有人给该路由加上依赖 Origin 的逻辑，要重新验证扩展页面的行为**。
> 2. `.tmp-run/` 仍被 gitignore（`preview.mjs` / `audit-all.mjs` / `audit-in-page.js`
>    及本轮两个探针都不随仓库交付），与 v67 遗留相同，未擅自改。

> ### v67：侧栏三处「只在图里错」的几何缺陷，以及让审计仪器长出眼睛（历史轮）
>
> 这一轮没有加功能。做的是**把侧栏渲染出来、量它、然后修**——因为本项目
> 历史上每一个 UI 缺陷都是**看出来的**，而当时的审计仪器是绿的。
>
> #### 一、仪器当时是绿的，缺陷是真的
>
> `.tmp-run/audit-all.mjs` 会跑 15 个场景 × 2 配色 × 2 个页面（侧栏 + 设置页），
> 每次都用 `audit-in-page.js` 在**面板自己的上下文里**测量对比度、点击目标、
> 溢出、裁切、flex 挤出、字号，并自报 `coverage`。**基线：32 个场景 0 findings。**
>
> 而本轮用 `preview.mjs --probe` 亲手量出三个缺陷，**它一个都没报**：
>
> | # | 缺陷 | 实测证据 | 用户可见后果 |
> |---|---|---|---|
> | A | `#input` 是面板里**唯一 radius 0** 的元素（其余盒子 6/8/10/12/16/999），聚焦时套 `outline: 2px solid rgb(66,98,240)` | `input.radius 0` vs `#composer 16`；`ringStillOnInput true` | 打开侧栏第一眼：方框蓝环嵌在圆角卡片里 |
> | B | 输入行与工具栏首项错位 | `inputTextLeft 22` vs `modelTextLeft 30`，**Δ = −8px** | 两行左边界不齐，读起来像失误 |
> | C | 「更早的内容」胶囊压住第一条消息 | 与用户气泡重叠 **2617px²**，`elementFromPoint` 确认它在最上层；且 `scrollHeight 559 = clientHeight 559` | 被遮的文字**滚不出来**，永久看不到 |
>
> C 的关键在于 **C 只在「内容不溢出」时才是缺陷**：同样的浮层在
> `earlier` 场景（`925 > 559`，可滚动）覆盖 1725px² 是**正常设计**——用户滚一下
> 就把它移出胶囊。修之前必须把这两者分开，否则修的是设计而不是缺陷。
>
> #### 二、三处修复（只动 `extension/sidepanel.html`）
>
> - **A**：`textarea:focus-visible { outline: none }`，环移到
>   `#composer:has(textarea:focus-visible) { box-shadow: var(--elevation), 0 0 0 2px var(--accent) }`。
>   用 `:has()` 是因为胶囊/输入框与卡片是**兄弟**关系，没有后代选择器能表达。
>   两处细节都是踩过的坑：`outline: none` 之后 computed `outline-width` 仍是
>   `medium`(3px)，**只有 `outline-style` 决定画不画**（第一版探针就是被这个骗了）；
>   环必须**追加**在 `--elevation` 之后，否则聚焦时卡片丢阴影。
> - **B**：`#input` 的 padding 从 `4px 0` 改成 `4px 0 4px 8px`，与 `#model` 自己的
>   8px 相加后同落 30px。
> - **C**：胶囊高度/内缩提为令牌 `--pill-height: 26px` / `--pill-inset: 8px`，并新增
>   `#stage:has(#earlier:not([hidden])) #transcript { padding-top: calc(var(--pill-inset) + var(--pill-height) + 6px) }`
>   让滚动区**为它留位**。守卫是必需的：无条件留白会让每一段普通对话顶部多一条空带，
>   那比原缺陷更糟。
>
> #### 三、给仪器补上「谁盖在谁上面」——并证明它真的会响
>
> `audit-in-page.js` 原有的 `overlaps` 检查只看 **flex row 内部**子元素挤不挤；
> 绝对定位浮层盖住滚动区内容，**没有任何容器型断言能表达**。这就是 C 溜过 32 个
> 场景的原因。新增第 7 项 `occlusions`，判据刻意收窄以免喊狼来了：
>
> - 候选只限 `position: absolute|fixed`（普通文档流永远不可能被报）；
> - 目标只限滚动区**自己的子元素**（菜单盖住 composer 是菜单的本职，不报）；
> - 矩形相交不够，还要用 `elementFromPoint` 问**浏览器谁真的画在最上面**；
> - 覆盖超过视口 80% 的层排除（`#blocked` 这类整屏状态页本就该盖住一切）；
> - **只有滚不出来的遮挡才算缺陷**（`scrollHeight > clientHeight + 2` 为假时）。
>
> 最后一条是**实测校准出来的**：同一块面板上，`more`（559=559）报永久 2617px²，
> `earlier`（925>559）报可逃逸 1725px²。只报前者。
>
> **变异测试**（`.tmp-run/probe-occlusion-selftest.js`）：把留白改回 12px 放回缺陷，
> 新检查**立刻报出 2617px²**——与修复前独立测得的数字**逐位相同**，
> 且 `scrollerScrollHeight 559 = scrollerClientHeight 559` 佐证不可滚动。
> 探针在 audit **之前**求值，所以变异能被随后的审计看到（`preview.mjs:776-809`）。
>
> 一个永远返回空数组的检查和一个真的干净的检查，输出**完全一样**——
> 这正是 `coverage` 字段存在的理由，也是这里必须做变异测试的理由。
>
> #### 四、新增回归测试：`packages/dsh-browser-bridge/test/panel-geometry.test.js`
>
> 5 条，断言的是**结构性不变量**而不是像素值（面板还要改版）：
> 编辑器自己不画环、环画在圆角卡片上且保留 elevation、composer 两行**文本起点必须相等**
> （`cardLeft + editorLeft === cardLeft + modelLeft`，抽成等式而非硬编码数字）、
> 胶囊高度只有**一个出处**（令牌）、留白规则**必须带 `:has()` 守卫**。
>
> 每条都做了变异测试，全部会变红：
>
> | 变异 | 变红的测试 |
> |---|---|
> | 把直角环放回 textarea | 「editor draws no focus ring」+「ring on the rounded card」 |
> | 去掉 `#input` 的 8px 内缩 | 「two lines of the composer agree」 |
> | 删掉 `#stage:has(...)` 留白规则 | 「pill states its height once」+「reservation is conditional」 |
>
> **测试数 525 → 530**（新增 5 条，41 个 suite）。
>
> #### 五、本轮验证读数（全部实测）
>
> - `node packages/dsh-browser-bridge/test/run.js` → **530 passed, 0 failed, 0 skipped**
> - `node .tmp-run/audit-all.mjs` → **32 scenarios, 0 findings, 0 broken**
> - 焦点环双向：`focused true / blurred false / refocused true`，且
>   `ringIsTheOnlyDifference true`（环是唯一差异，其余阴影逐字不变）
> - 负向探针 `probe-ring-snapshot.js` 的第一版**是错的**：`getComputedStyle()`
>   返回**活对象**，先取 `blurred` 再 `focus()`，读到的已是聚焦后的值，
>   于是报了一个不存在的缺陷。教训：**计算样式必须在读到的当下转成字符串快照**。
> - 面板**不抢焦点**：`blur()` 后 `activeElement` 是 `body`；`send.focus()` 无效
>   仅因 `sendDisabled: true`（正确行为）。此前一个探针疑似「面板抢焦点」，是探针误报。
>
> #### 六、顺带确认：设计系统没有漂移
>
> `probe-design-tokens.js` 从 `:root` 读令牌再逐节点比对：
> `radiusDrift 0`（圆角全部落在 6/8/10/12/16/999）。`sizeDrift` 只报出
> `#new` 的 15px 与 `code` 的 **12.88px**——后者经查是 `.answer :not(pre) > code`
> 的 `font-size: .92em`（14 × 0.92），**刻意的相对字号**，注释里已写明它必须与
> `pre code { font-size: 1em }` 分开，否则会掉到 11px（低于面板自己的字号下限）。
> `spacingDrift` 报的 6/14/5/2 是面板惯例（`--spacing` 变量本身只被用过 1 次），
> **不是缺陷**。结论：这三个不是漂移，是探针判据过严。
>
> #### 七、下一步（未做，留给下一轮）
>
> - 侧栏改动**只对扩展生效**：用户在 `chrome://extensions` 点一次「重新加载」即可看到，
>   不需要重启 `dsh web`（`lib/*.js` 才需要）。
> - `.tmp-run/` 被 `.gitignore` 忽略，所以 `occlusions` 检查**不随仓库交付**。
>   若要让它成为交付物，得把 `preview.mjs` / `audit-all.mjs` / `audit-in-page.js`
>   移出 `.tmp-run/` 并纳入版本控制——这是个独立决定，本轮没有擅自做。
> - README §诚实的能力边界 与 §与 Codex 能力的差距 两节**未改动**。
>
> ### v66：本项目第一次让真实扩展操作真实页面（本轮新增能力）
>
> 前面 65 轮里，`extension/background.js` 从来**没有在真浏览器里跑过**。所有扩展测试都是
> 假 `chrome` + 真 WebSocket 帧，只能证明**帧的形状**；CDP 参数名写错、`DOM.getBoxModel`
> 的 quad 读错偏移、`Input.dispatchMouseEvent` 落在错误的坐标空间——在假 `chrome` 下
> 全都**静默成功**：形状对，点落到别处。这一轮把这道口子堵上了。
>
> #### 一、被推翻的结论：`--load-extension` 并没有消失
>
> README:1423 / README:1674 / HANDOVER:1548-1550 / HANDOVER:3529 都记着同一句话：
> 「Chrome 137 已移除 `--load-extension`（本机 Chrome 153 实测，有头与无头都不行），
> 所以本项目测不了真 Chrome e2e」。**实测本身没错，结论推广过头了。**
>
> 该开关只在**稳定版渠道**被关掉——稳定版要保护用户不被侧载扩展打扰。而 Chromium 与
> Chrome for Testing（两者是同一份 Chromium，只是渠道不同）必须保留它，因为所有浏览器
> 自动化项目的扩展测试都靠它。`.tmp-run/probe-load-extension-matrix.mjs` 用三条独立证据
> （内容脚本隔离世界 / `service_worker` target / 按路径哈希算出的扩展页能否打开）重测：
>
> | 二进制 | service worker | 扩展页 |
> |---|---|---|
> | Playwright Chromium 153.0.8010.12 | ✅ | ✅ |
> | Puppeteer Chrome for Testing 148.0.7778.97 | ✅ | ✅ |
> | `chrome-headless-shell` 153 | ❌ | ❌ |
> | 稳定版 Chrome 153（含 `--disable-features=DisableLoadExtensionCommandLineSwitch` 重试） | ❌ | ❌ |
>
> 上一次之所以得出「不行」，是**只测了稳定版**，并且用了 `contentScriptCanSeeRuntime`
> 这个**在主世界取值**的判据。扩展 API 只在**隔离世界**里存在（内容脚本注入的世界名 `DSH`），
> 主世界读 `chrome.runtime` 拿到 `undefined` 是正常的——那不是「没注入」，是**判据错了**。
>
> #### 二、新建两个文件：装置与测试分开
>
> `packages/dsh-browser-bridge/test/extension-host.js`（装置，599 行）：
> `findChromium()` / `extensionIdFor()` / `Cdp` / `ExtensionHost` / `FixtureServer` / `openTarget()`。
> `packages/dsh-browser-bridge/test/real-browser.test.js`（4 条测试）。
>
> 起点是 `--load-extension=<repo>\extension --disable-extensions-except=<repo>\extension`，
> 然后**让扩展自己 dial 到测试进程的假宿主**——不是直接调 `handleFrame`。写入
> `chrome.storage.local` 的 port/token 触发扩展自己的 `storage.onChanged` 重连，
> 于是**真实的 `connect()` 路径**被跑到了，这是假宿主永远无法自己走通的那一段。
>
> 四条测试：
>
> 1. 扩展 dial 上来并应答 `bridge.status`；版本与 `chrome.runtime.getManifest().version`
>    **逐字比对**（不硬编码，否则下次改版本号测试还绿）；假宿主收到真实 `bridge/hello`。
> 2. `page.snapshot` 在真实页面蒸馏出元素且**带实测 bounds**；`page.read` 读到页面自己的
>    散文（`quick brown fox`）；`page.click` 按 selector 点击后，**回到页面里核对
>    `#result` 由 `idle` 变成了 `clicked`**。最后这步是任何 mock 都做不到的。
> 3. 受保护 CDP 域（`Browser.getVersion`）被拒且是 `cdp-denied`；未知方法被拒且是
>    `unknown-method`——两种拒绝不能混为一谈。
> 4. 扩展自己的页面（`options.html`）能打开、`chrome.storage` 真的能写能读能删；
>    同时**反证**普通网页里 `chrome.storage` 必须是 `undefined`。
>
> #### 三、装置里挖出来的真实缺陷（都不是猜的，是实测）
>
> **1. `/json/new` 只接受 `PUT`，`GET` 返回 405。** 三个二进制全一样：
> `405 Using unsafe HTTP verb GET to invoke /json/new. This action supports only PUT verb.`
> 我原来的 `openPage()` / `openExtensionPage()` 用的是 `GET`——**一个标签页都开不出来**。
> `.tmp-run/probe-json-new-verb.js` 实测：`GET` 后 fixture 标签页数 **0**，`PUT` 后 **1**。
> 更糟的是失败形态：调用方随后按 URL 去 `/json/list` 找「刚开的页面」，
> 要么等到超时，要么在该 URL 恰好已打开时**静默返回错误的标签页**。
> 两种失败在一份全绿的测试报告里都看不出来。
>
> **2. 按 URL 匹配标签页是不可靠的。** fixture 页 URL 与被操作的那个标签页完全相同，
> `targets().find(...)` 就在两个 URL 相同的 target 之间**任选一个**——一个读起来像
> 随机失败的硬币。改成 `pageForTab(tabId)` 走 `chrome.debugger.getTargets()` 拿扩展自己的
> tabId → targetId 映射，在源头消除歧义；`openPage` 用 `/json/new` 返回的 target id。
>
> **3. 连上 target ≠ 文档已解析。** target 一被创建就能连，此时 `document.title` 返回 `""`，
> **不报错**，所以没有重试——断言会以「options 页没有 title」的形式失败，
> 读起来像缺 `<title>`，实际是竞态。三个打开页面的方法都等 `document.readyState`。
>
> **4. 二进制的发现必须是动态的。** Playwright 与 Chrome for Testing 都装进**带版本号的
> 目录**（`chromium-1243/`、`chrome/win64-148.0.7778.97/`）。我第一版写死了字面路径，
> **在那台机器上正好命中**，任何一次升级都会让它静默全跳过。现在按安装根目录 + 正则 +
> 版本号倒序发现。`DSH_BB_CHROMIUM=<路径>` 可覆盖；给了不存在的路径返回未找到而**不回退**，
> 拿别的浏览器冒充被要求的那个比跳过更糟。
>
> **5. 全程 `--headless=new`（硬要求）。** 套件每次运行起若干浏览器实例，有头模式会在用户
> 工作期间反复抢焦点——这条是用户当场提出来的，不是我自己想到的。改无头后 4 条全绿，
> 且 Chrome 进程残留为 **0**。
>
> #### 四、防护力：三次故意破坏产品代码，恢复后逐字节一致
>
> 只让测试变绿不算数，得证明它**会红**。`extension/background.js` 每次改前先记 SHA-256
> （`5BCEB8AC…EE92`），恢复后再比对：
>
> | 破坏 | 结果 |
> |---|---|
> | `pageClick` 坐标写死成 `(0, 0)` | 点击那条**变红**（页面里 `#result` 没变成 `clicked`） |
> | `announce()` 事件名改成 `bridge/hello-disabled` | 握手那条**变红**（假宿主没收到 `bridge/hello`） |
> | `CDP_DENIED_DOMAINS` 删掉 `Browser` | 拒绝那条**变红** |
> | `/json/new` 打回 `GET` | 装置那条**变红** |
>
> 三次恢复后 `background.js` 均为 **byte-identical**，`node --check` 通过。
>
> #### 五、结果
>
> `npm test` **523 passed, 0 failed, 0 skipped**，exit 0，**34.1 秒**（含起 4 个浏览器实例）。
> `npm run check:extension` exit 0。无残留 Chrome 进程。

> ### v65：看不见屏幕的人，这个面板从头到尾没有对它说过一句话（本轮修复）

> 用键盘的人上一轮（v45）被照顾到了，这一轮查的是**用屏幕阅读器的人**。
> 结论是：面板里**一个 live region 都没有**（探针实测 `liveRegions: []`），
> 于是 23 处错误提示、阻塞性的审批提问、以及回答本身，全都静默发生。
>
> #### 一、23 处失败提示写进了一个不会被播报的元素
>
> 每一条错误都走 `say()`，它写 `#toast`。而 `#toast` 既没有 `role` 也没有
> `aria-live`，更要命的是它**在自己为空时带 `hidden`** —— 而那正是消息到达的时刻。
> 实测（`.tmp-run/probe-toast-order.js`）：先写文本再解除 `hidden`，得到
> `inTree: false` 且 `textLength: 24`，即**文本落地时元素不在无障碍树里**。
> live region 必须**在变化发生之前**就在树里，否则没有节点让阅读器去「观察到变化」。
>
> **修法**：`#toast` 改为 `role="status" aria-live="polite"`，并且**永不 `hidden`**；
> 它由样式表的 `#toast:not(:empty) { padding: … }` 控制占位，空时高度自然为 0。
> 实测三个判据：有消息时 `inAccessibilityTree: true`、空时 `layoutHeight: 0`、
> 清空后仍在树里（`stillObservableAfterClear: true`）。
>
> #### 二、transcript **不能**做 live region
>
> `transcript.replaceChildren(fragment)` 在 6 处出现，每次轮询重建整棵子树；
> 而 `.live-body` 更是**每帧 `body.textContent = live.text` 重写整个累积答案**。
> 把 transcript 设为 live region 会在每次重建时重播整段对话、每个 token 重播整个回答。
> 所以新增一个独立的、视觉隐藏的 `#announcer`（`.sr-only`），只播报三件事：
>
> | 时机 | 播报内容 | 为什么需要 |
> |---|---|---|
> | 审批提问出现 | 「要在 … 上使用 browser_read」 | 它**阻塞整个回合**，而屏幕上只是一张卡 |
> | 宿主不可达 / 无会话 | 「连不上 dsh web」/「还没有会话」 | 内容区空着，没有任何解释 |
> | 回答结束（`kind === 'end'`） | 完整回答 | **唯一**文本已定稿的时刻 |
>
> #### 三、修这个缺陷时我自己造出的第三个缺陷（本轮最有价值的部分）
>
> 加上播报后，实测 `atProbeStart: "还没有会话"` —— 一个**健康启动**也会报这个。
> 根因不是播报本身，而是 `refreshGroups` 里的顺序：
>
> ```js
> const { payload, status } = await bridge('/browser-bridge/chat')
> setHostReachable(status !== 0)   // ← 先重绘，此时 groups 还是上一轮的（空）
> groups = understood ? payload.groups : []
> ```
>
> `setHostReachable` 会重绘「没东西可显示」的面，而它**读 `groups` 来决定是哪种状态**。
> 先重绘，就从**上一轮的空列表**画出了「还没有会话」，然后数据到达再自我纠正。
> 屏幕阅读器**收不回已经播报出去的话**。修法是把赋值挪到重绘之前。
>
> 第二个自己造的问题：`renderOffline` 每次轮询都跑，宿主可能几分钟不可达，
> 于是加了「只在状态**转变**时播报」的守卫（`announcedOffline`），
> 以及在面消失时**清空播报区**（否则残留文本会让后来的读取者以为面板仍然不能用）。
>
> #### 四、测试这样写（因为两个显而易见的写法都测不到）
>
> 这个缺陷**用采样测不出来**，两个原因叠加：
> 1. 误报**先写后清**，事后采样只看到干净的空值；
> 2. `announce` 用 `setTimeout` 延迟写入，而它的回调**跑在 `setImmediate` 之前**，
>    所以 `await settle()`（只清微任务）和轮询循环都看不见那一瞬。
>
> 最终写法：**拦截 `textContent` 的 setter**，在 import `sidepanel.js` **之前**装好，
> 记录每一次写入；断言取的是**非空写入的完整历史**，而不是最终值。
> 两处细节都要对：`startupAnnouncements` 必须是**函数**而不是加载时的快照（写入还没发生）。
>
> **防护力逐项实测**（回退 → 跑 → 还原 → SHA256 逐字节一致）：
> 去掉审批播报 → 1 条红；去掉 `end` 的流式守卫 → 1 条红（报 `must be announced once, got: `）；
> **把 `setHostReachable` 挪回 `groups` 之前 → 1 条红，消息精确指出
> `said: ["还没有会话"]`**。
>
> #### 五、审计器因此要改一处（`.tmp-run/audit-in-page.js`）
>
> 新加的 `.sr-only` 区域让全量审计从 0 变成 **32 场景各 1-2 条**：
> `overflow -1..0 vs 380 p#announcer.sr-only` 与 `clipped 20 > 1`。
> 那是**这个技术本身的样子**（1×1、clip-path 裁掉），不是缺陷 ——
> 而 `display:none` 不能用来隐藏 live region，否则它又不在树里了。
> 已加 `isVisuallyHidden(element)` 豁免，**按计算样式判定而不是按类名**：
> 必须同时满足 1×1、`overflow: hidden`、`clip-path`/`clip` 非 `none`。
> **实测豁免是窄的**：塞一个真的 900px 宽元素进去，审计照旧报
> `overflow 0..900 vs 380 div#probe-wide`。
>
> #### 验证（全绿）
>
> | 项目 | 结果 |
> |---|---|
> | `npm test` | **519 passed, 0 failed, 0 skipped**，exit 0（连续 2 次） |
> | `npm run check:extension`（10 个脚本） | exit 0 |
> | UI 审计 32 场景 × 深浅两配色 | **0 findings / 0 broken** |
> | live region 实测 | 从 `[]` 变为 `#toast` + `#announcer` 两个 `role="status"` |
> | 字典 | 84/84 / 37/37 键对齐，0 死键 |
> | `chrome-profile-*` / `.bak` 残留 | 0 / 0 |
> | 用户线上实例 `dsh web --port 3080`（PID 36172） | 全程未触碰 |
>
> #### 交付
>
> 截图：`.tmp-run/v65-approval-zh.png`（已 `read_image` 目视确认：审批卡三按钮同权、
> 代码块与错误行正常、播报区按设计不可见）。
> 探针：`probe-live-regions.js`、`probe-toast-order.js`、`probe-announcer.js`、
> `probe-startup-silence.js`、`probe-announce-why.js`。
> **只改 `extension/` 与测试 → 重载 Chrome 扩展即可，不需重启 `dsh web`。**

> ### v64：状态浮层里那行「限制」永远不会出现，出现时又把浮层撑成 4 倍宽（历史轮）

> 状态浮层（页脚那个小圆点）会为 `status.hello.limitations` 里的每一条画一行。
> 那个数组**从来没被送到过**，而且就算送到，**那一行也画不对**。两个缺陷互相掩盖：
> 前一个让行不出现，后一个让人看不出它出现了会怎样。
>
> #### 一、扩展从来不发送 limitations
>
> 扩展把 limitations 建在 `status()` 里（`extension/background.js`），那回答的是
> **`bridge.status` 方法**，走 `browser_status` 工具——面板读的是另一条路。
> 面板读 `health.status.hello.limitations`，而 hello 的载荷是**硬编码的 `{ version }`**：
>
> | 环节 | 位置 | 事实 |
> |---|---|---|
> | 扩展发送 | `extension/background.js`（连接时的 `bridge/hello`） | 只发 `{ version }` |
> | 宿主保存 | `lib/index.js` 的 `StatusTracker.onHello` | 原样存，不加字段 |
> | 卡片读取 | `lib/client.js:661`、`:685-688` | 读 `status.hello.limitations` |
>
> 探针 `.tmp-run/probe-limitations-reach.mjs` 从三个源文件直接读，报
> `helloKeys: ["version"]`、`noteRowCanEverRender: false`。
> **宿主读不到的东西，扩展就永远没说过。**
>
> #### 二、就算送到了，那一行也是拿段落当标签
>
> 那一行的标签用的是 `translate('note')`——而 `note` 是字段下面那段**整句话**
> （「把令牌和端口……一起填进……选项页。其余设置……」）。
> `.dshbb-line` 是 `display:flex`，标签 `flex:none`，于是渲染成
> **1150px 的标签塞进 308px 的行**，实测：
>
> | 项目 | 数值 |
> |---|---|
> | 标签宽度 | 1150px（父容器的 **3.74 倍**） |
> | 行高 | 1270px |
> | 溢出视口 | 2 处（light 与 dark 都复现） |
>
> 只有当 limitations 真的出现时才会暴露——所以**这两个缺陷必须一起修**，
> 修好第一个才会让第二个显形。
>
> #### 修法
>
> **`extension/background.js`**：新增 `limitations()` 与 `announce()`。连接时改发
> `{ version, limitations }`。`limitations()` 里做了**真实检测**而不是无条件写死一句话：
> 调 `chrome.extension.isAllowedFileSchemeAccess()`，**只有确定返回 `false` 才出这一条**
> （API 不存在、调用失败、返回 `true` 都不出）。
> 理由写进了注释：**一行不管有没有问题都显示，等于教人不要读它**。
> 「查不出来」与「没问题」在这一行上的正确表达都是沉默。
> 该函数**自己吞掉异常**，因为同一个帧还要运 version——一个 API 不可用不该让版本号一起消失。
>
> **`lib/client.js`**：新增字典键 `limitation`（中「限制」/英 `Limitation`），
> 那一行改用它做标签；`note` 仍然只做段落。
>
> #### 新增测试（513 → 518）
>
> - **`packages/dsh-browser-bridge/test/hello-wire.test.js`（4 条，新文件）**：加载**真实的
>   `extension/background.js`** 配假 chrome、走真 WebSocket 帧，断言 greeting 里真的带了
>   limitations。四条的判据是「该出现的出现」+「**不该出现的绝不出现**」：
>   文件访问关着→恰好一条且点名那个设置；开着→**空**；API 不存在→**空**；调用失败→**空**；
>   以及失败时 version 仍要在。
> - **`test/client-render.test.js` 加 1 条**：渲染真实组件，打开浮层，断言限制**真的有那一行**
>   且**标签是「限制」而不是那段话**。
>
> **装置缺口（这一轮一半的价值）**：`test/service-worker.js` 的假宿主**把无人认领的帧丢掉了**
> （只按 `id` 匹配请求）。而 `bridge/hello` 没有 id——所以**「扩展停了某个通知」和
> 「扩展照常发」在测试里长得一模一样**。这是第二个缺陷能活下来的原因。
> 现在它记录 `notifications`，这两个套件才能读到真实载荷。
>
> **防护力逐项实测**（回退 → 跑 → 还原 → SHA256 逐字节一致）：
> 恢复「只发 version」→ **4 条红**；把 `allowed === false` 放宽成 `allowed !== true`
> （即变回无条件提示）→ **2 条红**；标签换回 `note` → **1 条红**。
>
> #### 验证（全绿）
>
> | 项目 | 结果 |
> |---|---|
> | `npm test` | **518 passed, 0 failed, 0 skipped**，exit 0（连续 3 次） |
> | `npm run check:extension`（10 个脚本） | exit 0 |
> | 浮层 7 种状态 × 深浅两配色像素审计 | 全部 **0 findings / 0 broken** |
> | `extension/locales.js` / `lib/client.js` 字典 | 84/84 / 36/36 键对齐，0 死键 |
> | `chrome-profile-*` 残留 | 0 |
> | 用户线上实例 `dsh web --port 3080`（PID 36172） | 全程未触碰 |
>
> #### 顺带修掉的装置缺陷（同一类问题第二次出现）
>
> `.tmp-run/card-preview.mjs` 的伪宿主 health 响应**自己编了字段**
> （`chromeVersion`/`controlledTabs`/`extensionVersion`），既缺 `status` 也缺
> `settingsRegistered`——于是卡片一直渲染「设置命名空间 / **未注册**」，
> **一个正常安装永远看不到的状态**，而卡片真正读的那几个字段从来没被走到过。
> 已按 `lib/index.js` 的真实响应体改写，并新增 `--state`
> （`ok`/`hostDown`/`disabled`/`unregistered`/`lastError`/`limitations`/`tokenless`），
> 让条件行第一次能被逐个渲染和测量。
> **这是 v63 芯片 fixture 的同一类错误：fixture 的形状不是真实契约的形状，
> 测试和审计量到的就是另一条代码路径。**
>
> #### 交付
>
> 截图（`.tmp-run/`）：`v64-note-fixed-light.png`、`v64-note-fixed-dark.png`（限制行）、
> `v64-status-{ok,limitations,lastError}.png`、`v64-card-{ok,lastError,tokenless,...}.png`。
> 探针：`.tmp-run/probe-limitations-reach.mjs`。
> **只改 `extension/` 与 `lib/` → 重载 Chrome 扩展 + 重启 `dsh web`。**

> ### v63：v62 改了浮层里的颜色，却从没渲染过浮层（历史轮）

> v62 在设置卡片里量了 21 处文字，把 6 条颜色声明从 `label-tertiary` 提到
> `secondary`——其中一条就在**页脚状态浮层**里。而那个浮层**只在点击之后才存在**，
> v62 的预览工具 `--open` 写死点 `.dshbb-card-header`（卡片的折叠头），
> 所以**浮层一次都没有被渲染过，v62 那条改动是未验证的**。本轮补上。
>
> #### 三个缺陷，都是「第一次看见」才暴露的
>
> | 症状 | 量出来的事实 |
> |---|---|
> | 浮层在窄侧栏里跑出屏幕 | `width:330px` 是**固定值**。300px 视口下浮层右边缘在 **362px**，里面 5 行字段跟着一起出界 |
> | composer 芯片写着协议名 | 芯片渲染 `https://github.com · 选中内容 · 1234 字`，而宿主自己的 `describeAttachment` 对同一条记录说的是 `selected text from github.com` |
>
> 第二行不是笔误，是**同一份数据在同一个仓库里被两种写法描述**。`lib/context.js`
> 的 `origin` 存的是**完整 origin**（`new URL(url).origin`，带 `https://`），
> 宿主侧的 `describeAttachment` 注释里写明了「a label names a *site*」所以它 `new URL(v).host`
> 把协议剥掉；而 `lib/client.js` 的 `chipLabel` 直接拿 `origin` 当 host 用。
>
> #### 为什么两个都逃过了测试
>
> `test/client-render.test.js` 的芯片 fixture 写的是 `origin: 'github.com'`——
> **一个裸 host**，于是它走的是「origin 非空」分支，**`new URL()` 那条路径从未被执行**。
> fixture 和真实记录形状不一致时，测试量的是另一条代码路径。
> 已改为 `origin: 'https://github.com'`，并把宿主契约写在注释里。
>
> #### 修法
>
> - `lib/client.js` 的 `.dshbb-panel` 宽度 `330px` → **`min(330px, calc(100vw - 24px))`**；
>   `.dshbb-chip` 的 `max-width: 340px` 同样加上钳制。**这是面板在 v36 就用过的写法**
>   （`extension/sidepanel.html:454`、`:915`），同一个产品里两种做法，芯片与浮层是错的那边。
> - `chipLabel` 新增 `hostOf()`，`origin` 与 `url` 都过它，与宿主 `describeAttachment` 对齐。
>
> #### 新增两条测试（512 → 513）
>
> - `no surface wider than the sidebar is pinned to a fixed width`：浮层与芯片必须
>   同时满足「没有固定 px 宽度」与「含 `calc(100vw - Npx)` 钳制」。选择器列表计数锁死。
> - 芯片那条测试补三句断言：不得含 `://`、仍须含 `github.com`。
>
> **防护力逐项实测**（回退 → 跑 → 还原 → SHA256 逐字节一致 `BA895AF6…3770`）：
> 浮层宽度改回固定 330px → **1 条红**；`chipLabel` 改回直接用 `origin` → **1 条红**。
>
> #### 预览工具的两处修正（装置缺陷，不是产品缺陷）
>
> 1. **`--open` 写死了卡片的选择器**，所以浮层无法被打开。现在按表面选控件
>    （card→`.dshbb-card-header`、status→`.dshbb-trigger`），chips 没有展开态就**明确报错**，
>    而不是静默截一张没打开的图。
> 2. **`#shell` 的 `margin: 0 auto` 把状态面居中了**，浮层锚点被推到 x=72，
>    审计于是报出产品「溢出视口」——**那是装置造的假缺陷**。真实侧栏的页脚动作贴着左边缘，
>    已改成 `margin: 0`。**修正前后都跑过审计，修正后 4 个组合（300/380 × 深浅）全部 0 findings。**
> 3. **探针必须以 IIFE 收尾**。`--probe` 走 `Runtime.evaluate`，一个裸 `return`
>    是语法错误，而 CDP **不会 reject、只会永不 settle**——症状是进程挂死而不是报错。
>    已写进探针文件头注释。
>
> #### 验证（全绿）
>
> | 项目 | 结果 |
> |---|---|
> | `npm test` | **513 passed, 0 failed, 0 skipped**，exit 0 |
> | `npm run check:extension`（10 个脚本） | exit 0 |
> | 浮层：300/380px × 深浅两配色（`--open`） | **4 组全部 0 findings** |
> | 芯片：440px 浅色 | **0 findings**，`chipShowsScheme: false` |
> | 扩展 UI 审计 32 场景 × 双配色 | **0 findings / 0 broken**（无回归） |
> | 字典 | 84/84 键对齐 |
> | TEMP `card-preview-*` / `.tmp-run` `chrome-profile-*` | 0 / 0 |
> | 用户线上实例 `dsh web --port 3080`（PID 36172） | 全程未触碰 |
>
> #### 交付截图
>
> `.tmp-run/v63-status-light-380.png`、`v63-status-light-300.png`、`v63-status-dark-380.png`、
> `v63-status-dark-300.png`、`v63-chips-light.png`——中文界面，浮层完整可见（桥接/扩展/在途调用/
> 站点规则/扩展令牌 + 复制令牌按钮），芯片显示 `github.com · 选中内容 · 1234 字`。均已目视确认。
>
> **本轮产品改动只有 `packages/dsh-browser-bridge/lib/client.js`（宽度钳制 ×2 + `chipLabel`）
> → 刷新 DSH 页面即可，扩展无需重载，也不用重启 `dsh web`。**

> ### v62：设置卡片终于能被截图了，而它第一次被拍到就露了色（本轮修复）
>
> v61 让这个浏览器端产物**第一次被渲染**，用的是自建的树形最小 React——它能断言
> 「画了什么字」，但**画不出像素**：没有 DOM 元素、没有 CSS 引擎、没有布局。于是
> v61 结尾留下的那句「设置卡片仍未被像素级审计过」就是本轮要拆的东西。它现在被拆掉了。
>
> #### 拆掉它的代价：这个产物比 `extension/` 那两个页面难渲染
>
> 它不是 HTML 文档，而是宿主 shell 加载并挂进自己 React 树的一个 bundle。要看到它
> 真实的样子，三样缺一不可，而本机三样都不在位：
>
> 1. **真实的 bundle**——就是 `lib/client.js` 自己，不是副本。
> 2. **一个 React**——本机**任何位置都没有装 React**（`@deepseek-ai/dsh`、
>    `~/.dsh/profiles/node_modules`、仓库都没有；仓库根本没有 `node_modules`）。
> 3. **真实设计 token**——卡片 CSS 全写成 `var(--dsw-alias-*)`，一个都不解析的话
>    测出来的颜色和用户看到的毫无关系。
>
> 于是新建 `.tmp-run/card-preview.mjs`（`card` / `chips` / `status` 三个表面，
> 支持 `--scheme` / `--locale` / `--open` / `--width` / `--audit` / `--probe`）与
> `.tmp-run/card/card-boot.js`（自带 DOM 版最小 React：`createElement` / `useState` /
> `useEffect` / `useRef` / `useMemo`，**渲染成真元素并执行 effect 清理**）。
> token 由 `.tmp-run/extract-tokens.mjs` 从 `dsh-client-ui-theme` 的
> `design_platform_css_default` 原文抽出（165 条定义，深/浅两套），
> **不在 Node 侧解析 var() 链，交给浏览器自己解析**——手写正则解这条链只会得到半对的颜色。
>
> #### 三个装置的坑，每一个都足以让「干净的审计」变成谎言
>
> 1. **`ensureStyles()` 是在 `apply(ctx)` 里调的，不在模块加载时。** 只取组件导出的
>    渲染方式会画出**一张没有样式表的卡片**（实测 `styleTagInjected: false`，
>    高度 25px）。所以 boot 脚本改为**驱动真实的 `apply()`**，配一个假 ctx——
>    顺带把三处 slot 注册也照宿主的方式跑了一遍（三处都带 `locale`，已断言）。
> 2. **深色主题是 `body[data-ds-dark-theme]` 属性选择器，匹配「存在」而不是「值」。**
>    我第一版写 `dataset.dsDarkTheme = 'false'`，属性照样存在，于是**浅色模式测的是
>    深色 token**（`label-tertiary` 读出 `#adb2b8`）。必须 `removeAttribute`。
> 3. **`props.t` 用的是产品自己的字典。** 我第一版手抄了一份 stub 字典，漏掉
>    `copyToken` / `note` / `connectHint` 等键——**看起来就像产品没翻译**。
>    改为从 bundle 自己的 `locale.register` 调用里捕获（36 键），
>    手抄的字典会漂移，而缺键会静默回落英文。
>
> #### 抓到的最严重的东西是**审计器自己说谎**
>
> 第一版 harness 读 `parsed.findings`——**而 `audit-in-page.js` 从来不返回这个键**。
> 它返回的是六个具名分类（`contrast` / `targets` / `overflow` / `clipped` /
> `overlaps` / `tinyText`）。于是它在**一份躺着 10 条对比度失败的报表上打印
> 「audit findings: 0」并以 exit 0 结束**。这是本项目已经写进文档的同一类错误
> （v35 的正则认不出 `oklab()`、v49 的 `findings > 0` 算成功），**第三次了**。
>
> 同一轮里还有第二次：我在 CSS 模板串的注释里写了反引号（`` `label-tertiary` ``、
> `` `.cardDesc` ``），**提前终止了模板字符串**，整个 bundle 语法错误、卡片挂不上；
> 而空文档的审计同样是「0 findings」。为此 harness 现在有三道硬闸：
> **`NOT MOUNTED`**（渲染出来是空的就当失败，不当作干净）、
> **`NO STYLESHEET`**（没注入 CSS 时量到的颜色不是用户看到的）、
> **`UNRESOLVED TOKENS`**（token 没解析就等于没量）。页面报错现在**打全文**而不是
> 第一行——`TypeError: "` 这种一行报告正是把「样式表断掉」藏起来的原因。
>
> #### 卡片第一次被拍到，露出来的色
>
> 审计 21 处文字 / 2 个控件（真实覆盖率，不是 1），浅色下 **10 条对比度失败**，
> 全部是 `--dsw-alias-label-tertiary` 在白底 **3.71:1**（12–13px 正文要求 4.5:1）。
> 独立复算确认（`.tmp-run/verify-card-contrast.mjs` 用自己的 sRGB→相对亮度实现，
> 不复用审计的数学）：3.71 属实。
>
> **但「谁该改」需要证据，不是 WCAG 说了算。** 于是查了宿主自己怎么用这个 token
> （`.tmp-run/host-token-usage.mjs` / `host-field-convention.mjs` /
> `host-trigger-chevron.mjs`，扫 65 个文件、760 条 label-token 规则），并在真实
> token 下把宿主自己的规则和候选色**放在同一页里量**
> （`.tmp-run/measure-host-contrast.mjs`）：
>
> | 角色 | 卡片原来 | 宿主的做法 | 实测（浅色） | 判定 |
> |---|---|---|---|---|
> | 卡片描述 | tertiary 13px | 宿主自己的 `.cardDesc` **就是 tertiary 13px** | 两边都是 **3.71:1** | **继承来的，不动** |
> | 字段值（含令牌） | tertiary 12px | `entryValue` / `value` 是 **primary**；卡片自己的浮层也是 primary | secondary → **5.8:1** | **我们的错，已修** |
> | 说明段（唯一的手工步骤） | tertiary 12px | 12px 的 `guideNote` / `help` 是 **secondary** | secondary → **5.8:1** | **已修** |
> | 折叠箭头 | tertiary | 18 条 chevron 规则是 secondary，13 条 tertiary | secondary → **5.8:1** | **已修** |
> | 页脚状态按钮 | tertiary 12px | 状态类 8 条 tertiary / 5 条 secondary | secondary → **5.8:1** | **已修** |
> | 芯片移除 × | tertiary | 交互图标 8 条 secondary / 8 条 primary | secondary → **5.8:1** | **已修** |
>
> 字段值选了 `secondary` 而不是宿主的 `primary`：**标签是高亮的那一半，值不该盖过它**，
> 而 secondary 已经过线（5.8:1）。描述那一行**故意保持 tertiary**——宿主自己所有
> 插件卡片都这么画，把它加重只会让这张卡片在列表里显得不合群，而不是更可读。
>
> 结果（六种组合，真实覆盖率）：
>
> | 表面 | 浅色 | 深色 | 覆盖率 |
> |---|---|---|---|
> | settings card | **1 findings** | 0 | 21 文字 / 2 控件 |
> | composer chips | 0 | 0 | 5 文字 / 2 控件 |
> | footer status | 0 | 0 | 2 文字 / 1 控件 |
>
> 唯一剩下的一条就是那条**继承自宿主**的描述（宿主自己的 `.cardDesc` 同 token 同
> 字号同比例），已作为具名豁免写进测试并计数。
>
> #### 新增一条测试（511 → 512）
>
> `packages/dsh-browser-bridge/test/client-render.test.js` 新增
> **「no text in the card is painted in the weakest label level」**：扫 CSS 里所有
> `color:var(--dsw-alias-label-tertiary)` 且带字号的行，豁免表点名
> `dshbb-card-description` 并 `assert.equal(EXEMPT.length, 1)` 锁死。
> **防护力逐项实测**（回退 → 跑 → 还原 → SHA256 与回退前逐字节一致）：
> 回退 `field-value` → 1 红并点名 `.dshbb-field-value`；再回退 `note` → 点名两条；
> 再回退 `chevron` + `trigger` → 点名 `.dshbb-trigger`。
>
> #### 验证（全绿）
>
> | 项目 | 结果 |
> |---|---|
> | `npm test` | **512 passed, 0 failed, 0 skipped**，exit 0 |
> | `npm run check:extension`（10 个脚本） | exit 0 |
> | 扩展 UI 审计 `--width 380`（32 场景 × 双配色） | **0 findings / 0 broken**（无回归） |
> | 卡片六种组合（3 表面 × 双配色） | 见上表，唯一一条是继承来的 |
> | `extension/locales.js` 字典 | 84/84 键对齐 |
> | `chrome-profile-*` / TEMP 里 `card-preview-*` | 0 / 0 |
> | 用户线上实例 `dsh web --port 3080` | 全程未触碰 |
>
> 交付截图：`.tmp-run/card-final-light.png`、`.tmp-run/card-final-dark.png`、
> `.tmp-run/c-card-light.png`、`.tmp-run/c-chips-light.png`、`.tmp-run/c-status-light.png`。
> **本轮产品改动只有 `packages/dsh-browser-bridge/lib/client.js` 的 6 条颜色声明
> → 刷新 DSH 页面即可，扩展无需重载。**
>

> ### v61：设置卡片与 composer 芯片从没被渲染过，于是它们一直是英文的（那一轮修复）
>
> **缺陷一：`ContextChips` 的 slot 注册漏了 `locale`。** 另外两处贡献
> （`settings.plugin.item`、`sidebar.footer.action`）都写了 `locale: LOCALE_NS`，
> 只有 composer 芯片那一处没写。而 slot 只在注册声明了 `locale` 时才把 `t`
> 翻译器传进 props——`lib/client.js` 自己的 `makeTranslator` 注释就是这么写的。
> 后果：**中文界面上，芯片写着 `github.com · selected text · 1234 chars`**，
> 而它就在输入框上方、每条消息都会经过的那个位置。
>
> **缺陷二：三处用户可见文案是硬编码英文**，绕过了字典：
> `'Remove {x} from context'`（芯片 × 按钮的 `aria-label`）、
> `'Remove before sending — nothing has been sent yet'`（同一个按钮的 `title`）、
> 以及状态浮层的 `aria-label: 'Browser bridge status'`。
> 前两个是屏读器念出来的内容，在纯文本遍历里根本看不见。
>
> **缺陷三：`statusPanel` 是死键。** 它在两个字典里都有译文，**没有任何地方画它**——
> 原因正是上面第三条硬编码顶替了它。**「字典里有个没人用的键」和「该用它的地方写了硬编码」
> 是同一个缺陷的两面**，这一轮才把它俩接上。
>
> **缺陷四：两处点击目标低于 WCAG 2.2 AA（2.5.8）的 24×24。**
> `.dshbb-chip-x` 是 18×18，`.dshbb-btn` 没有 `min-height`（≈22px）。
> 这两个数字与 v35 在面板里修掉的是同一个门槛，只是这个文件不在 UI 审计的覆盖范围内。
> 已改为 24×24，并给 `-3px/-2px` 的负 margin 抵消，**布局不动**。
>
> **根因：这个文件从来没被渲染过。** `test/client-inject.test.js` 用
> `new Function(source)()` 求值 bundle，但它的 `react` 桩对每个 `createElement`
> 都返回 `{ type: 'stub', args }`——**任何组件体都没有执行过**。
> 所以「卡片是英文的」这类事实在测试里不可见，而本机没有 React，
> `.tmp-run/` 的 UI 审计渲染的是 `extension/` 的两个页面，也照不到它。
>
> **新增 `packages/dsh-browser-bridge/test/client-render.test.js`（8 条，503 → 511）**：
> 自带一个最小 React 运行时（`useState` 有可用 setter、`useEffect` 会跑且**清理函数会被执行**、
> 轮询 promise settle 后再重画一轮），把真实组件渲染成可遍历的树，然后断言**人看到的东西**：
>
> 1. 两个字典键对齐；
> 2. **没有死键**（`statusPanel` 那类）；
> 3. 卡片里没有任何绕过字典的 `aria-label`/`title`（先剥掉字典本身再扫，否则会匹配到字典条目）；
> 4. **每一个画文案的 slot 都声明了 `locale`**（这一条直接抓住缺陷一）；
> 5. 中文下芯片写「选中内容 / 1234 字」，且 `aria-label` 是「从上下文移除: …」；
> 6. **没有 `t` 时回退到英文字典，而不是裸键**（`makeTranslator` 存在的理由）；
> 7. 页脚状态触发器在中文下说「浏览器：已连接」；
> 8. **四个可交互控件都 ≥24×24**（守缺陷四；之所以写在测试里而不是靠审计，
>    是因为审计渲染不到这个文件）。
>
> **两个装置纪律（都是踩过的坑，注释里写明了）**：
> * **effect 的清理函数必须执行**。`usePolled` 会 `setInterval`，我第一版的最小 React
>   丢掉了清理，**定时器吊住事件循环 → 整个 runner 静默挂死**（不是失败，是停住）。
>   现在清理收在 `unmount()`，测试用 `t.onCleanup` 注册。
> * **全局要还原成原来的 descriptor，不能 `delete`**。我第一版 `delete globalThis.fetch`，
>   而 `panel-stream.test.js` 已经装了自己的桩——删掉会让后面**无关的套件**炸掉。
>
> **顺带修掉一个会误导人的仪器**：`test/service-worker.js` 的 `awaitConnection`
> 超时文案断言「usually a cached module URL, because two suites generated the same one」，
> 把一种可能说成了结论。我在高负载下跑测试时它误报过一次，**把我推向排查缓存**，
> 而真实原因是 5 秒死线太紧。已把死线放宽到 15 秒，并把文案改成列出**两种可能**
> （缓存 URL / 机器太忙）让人自己分辨。**会误报的验证工具比慢的更糟**——这条本项目已经写过一次。
>
> **验证（全绿）**
>
> | 项目 | 结果 |
> |---|---|
> | `npm test` | **511 passed, 0 failed, 0 skipped**，exit 0（连跑 3 次一致） |
> | `npm run check:extension` | exit 0 |
> | UI 审计 `--width 380`（32 场景 × 深浅两配色） | **0 findings / 0 broken** |
> | `lib/client.js` 字典 | 36/36 键对齐，0 死键 |
> | `extension/locales.js` 字典 | 84/84 键对齐 |
> | 用户线上实例 `dsh web --port 3080`（PID 36172） | 全程未触碰 |
>
> **防护力逐项实测**（回退 → 跑 → 还原 → SHA256 一致）：
> 去掉 chips 的 `locale` → **1 条红**；芯片文案改回英文 → **1 条红**；
> `aria-label` 改回硬编码 → **3 条红**（含死键检查）；
> `statusPanel` 改回硬编码 → **1 条红**；`.dshbb-chip-x` 改回 18px → **1 条红**（同时报出宽与高）。
>
> **只改了 `packages/dsh-browser-bridge/lib/client.js`（宿主侧浏览器产物）→ 刷新 DSH 页面即可，扩展无需重载。**
>
> ### v60：标签页列表是唯一没有边界的页面内容出口（本轮修复）
>
> 规则是「网页来的文本必须说明它是数据不是指令」。`browser_tabs` 与
> `browser_selection` 没有——而它们**读起来像浏览器在报告自己的状态**，
> 实际标题列是 `document.title`（页面自己写）。它们是模型挑 `tab_id` 的唯一依据。
>
> **修法不套那句话**，那样会撒谎：这张表确实是浏览器的回答，只有几列来自页面。
> 新增 `provenanceNote(what)` 说准确的那件事。见 `lib/tools.js:55`。
>
> **`provenanceNote` 用的地方**：`lib/tools.js` 的 `browser_tabs`（`:289` 附近）
> 与 `lib/page-tools.js` 的 `browser_selection`（`:1058`）。
>
> **[已证伪，不要按它修] 「标题里放换行可伪造标签页行」不成立。**
> `.tmp-run/probe-title-newline.mjs` 在真实 Chrome 量了三处（`<title>` 内的换行、
> 运行时给 `document.title` 赋值、`Target.getTargets` 报的标题），**Chrome 自己把换行折成了空格**，
> 渲染行数 = 1。
> **但契约仍成立并已加防线**：新增 `squashOneLine(value, max)`（`lib/tools.js:78`），
> `tabLine()` 的标题/URL/组名都过它（`:227`、`:231`）。
> 防的是将来——**wire 格式由我们决定，「一行就是一行」这条规则不由我们决定**。
> 探针 `.tmp-run/probe-tab-row-integrity.mjs` 直接喂带换行的 wire 行，不依赖 Chrome 折叠。
>
> **新增测试 5 条**：`test/tab-list-integrity.test.js`。
> **防护力实测**：回退 `squashOneLine` → **3 条红**；关掉 `browser_selection` 的出处说明 → **1 条红**。
>
> **本轮验证**：`npm test` **503 passed / 0 failed**，exit 0；`check:extension` exit 0；
> UI 审计 32 场景 × 双配色 0 findings；字典 84/84；`chrome-profile-*` 残留 0。

> ### v59：`browser_cdp` 是唯一没有不可信边界的工具（本轮修复）
>
> 先查了中文用户必然遇到、英文开发者不会遇到的场景——**输入法**。
> `extension/sidepanel.js:2392` 与 `:2409` 已有 `event.isComposing === true || event.keyCode === 229`
> 双重守卫（mention 菜单的 Enter/Tab + 发送的 Enter），且注释写明了理由。**IME 已正确处理，不是缺陷。**
>
> 真问题：`browser_eval` 走 `untrusted(rendered, …)`，而**权限更高**的 `browser_cdp` 返回裸 JSON。
> `Network.getResponseBody` 是服务器正文，`DOM.getOuterHTML` 是页面自己的 HTML，
> 两者都是攻击者端到端控制的字符串。`browser_cdp` 是工具集里能力最强的一个
> （要 Developer mode + 每次都问 + `full_cdp_access`），**最强通道成了唯一没有边界的通道**。
>
> **修法**（`lib/page-tools.js`）：`const marked = untrusted(body, { url: \`tab ${hole.tabId}\`, title: \`CDP ${args.method}\` })`，
> 阈值比较与切割都改在 `marked` 上。
> **关键设计：先包标记再切上限**——注释写明「a boundary that can be truncated away is not a boundary」。
>
> **探针 `.tmp-run/probe-cdp-untrusted.mjs`** 实测：cdp 两条路径 `hasUntrustedPrefix: false`、
> 注入串原样带出；`browser_eval` 对照为 `true`。

> ### v58：削减小了却不告知——把 v57 当模式扫了一遍，抓到一个更重的（本轮修复）
>
> v57 修好 `browser_cdp` 的静默截断后，正确的问题不是「还有别的地方这样吗」而是
> 「**这个模式在别处长成了什么形状**」。扫完全部 `.slice(` / `maxBytes` / `oneLine`
> 削减点后，两处有问题，第二处比 v57 更重。
>
> **缺陷一：`browser_read` 的链接被砍两次，两次都不说。**
> `extension/background.js` 的 `pageRead` 是 `links.slice(0, 200)`，
> `lib/page-tools.js` 的 `browser_read` 再 `page.links.slice(0, 60)`。
> 探针 `.tmp-run/probe-link-truncation.mjs` 量的四档：
>
> | 页面真实链接数 | 返回给模型 | 丢掉 | 有没有说 |
> |---|---|---|---|
> | 30 | 30 | 0 | — |
> | 60 | 60 | 0 | — |
> | 61 | 60 | **1** | **没有** |
> | 200 | 60 | **140** | **没有** |
>
> `browser_read` 正是模型用来回答「这页有什么可点」的工具，所以一个读到 60 条
> 且没被告知的模型会说出「页面上没有结账入口」——而页面有 400 条。
>
> **这里有个隐蔽的坑，写在这里免得下次重踩：总数必须来自 wire，不能数数组。**
> 扩展在宿主之前就砍到 200，宿主若用 `all.length` 就会把 200 报成页面真实大小。
> 那比不报更糟：它把「我砍过」伪装成「页面就这么大」。所以扩展现在发 `linkCount`
> （切割前的真实条数），宿主优先读它，`all.length` 只作回落。
>
> **缺陷二（更重）：`browser_snapshot` 渲染全部元素、只发前 400 个。**
> `pageSnapshot` 用 `renderElements(elements, …)` 把**全部**元素写进文本，
> 却只把 `elements.slice(0, 400)` 发到 wire 上。而 `resolveTarget` 正是在那个
> **已切的数组**里 `find((candidate) => candidate.index === params.index)`。
> 于是 450 个可交互元素的页面上：模型读到 `#450` 那一行，**永远点不动它**，
> 而且收到的拒绝是「snapshot index 450 is not in this page any more; take a fresh
> snapshot」——**把一个被砍掉的帧说成页面变了**，还让模型去做一件不会有用的事。
> 修复前测试报出：`the text names index 400 but only 400 were shipped`。
>
> **修法不是加提示，而是让两半用同一个上限。**
> 新增 `extension/background.js` 的 `const ELEMENT_MAX = 400`，
> `const shippable = elements.slice(0, ELEMENT_MAX)`，
> 渲染与发送都用 `shippable`；`elementCount` **保持「页面真实总数」的原义**
> （宿主头部一直这么报告它），另加 `listedCount` ＝ 文本实际列出了几个，
> `truncated` 在两者不等时也为 true。宿主头部在两者不同时同时报出：
> `450 actionable element(s), 400 listed below, truncated`。
> `browser_read` 侧同理：`LINK_LIST_MAX = 60` 抽成具名常量，超限时写出
> `… (showing 60 of 400 links)`，`meta.links` 报真实总数。
>
> **新增测试 6 条**（498 条）：
> - `packages/dsh-browser-bridge/test/link-list.test.js`（**新文件，5 条**）：
>   全部装得下时不加提示、被砍时说真实总数、**正好等于上限不算被截断**（差一就会
>   让每个正常的满页都变成谎言）、**总数取自 wire 而非数组**、老扩展不发总数时
>   仍要有诚实计数。
> - `packages/dsh-browser-bridge/test/target-index.test.js`（**加 1 条**）：
>   450 个元素的页面，**不只断言计数，而是真的去点文本里最后一个编号**——
>   因为「模型读得到的编号就是它会去用的编号」，断言字符串会漏掉真正的伤害。
>   同时新增 `snapshotMany(count)` fixture（原来只有 `snapshotWith`，一个元素
>   表达不出「超出上限」，两个上限只在超限后才分叉）。
>
> **防护力逐项实测（回退 → 跑 → 还原 → 校验 SHA256 一致）**：
> 去掉 `showing` 提示 → **3 条红**；总数改用 `all.length` → **1 条红**；
> 元素上限改回「渲染全部、只发 400」→ **1 条红**。
>
> **验证（全绿）**：`npm test` **498 passed / 0 failed**，exit 0；
> `npm run check:extension` exit 0；UI 审计 32 场景 × 双配色 **0 findings**；
> 字典 84/84 键对齐；`chrome-profile-*` 残留 0；
> 用户线上实例 `dsh web --port 3080`（PID 36172）**全程未被触碰**。
>
> **本轮只改 `extension/background.js`、`lib/page-tools.js` 与测试 → 重载 Chrome 扩展 + 重启 `dsh web`。**
>
> ### v57：`browser_cdp` 的结果被砍断，而且不告诉你（本轮修复）
>
> 这一轮从「哪些权限申请了却没用」开始，一路证伪了四个方向（见本节末尾），
> 最后落在一个**静默**的缺陷上：模型拿到的 CDP 结果可能是半截的，而它无从得知。
>
> **缺陷：`lib/page-tools.js` 的 `browser_cdp` 静默截断到 20000 字符。**
> 原来的实现是一行：
>
> ```js
> return { text: JSON.stringify(result ?? null, null, 2).slice(0, 20_000), meta: { method: args.method } }
> ```
>
> `.slice()` 之后没有任何标记。被切掉的不是「更短的答案」，而是**一个语法上不成立的
> JSON 文档**——文本在半途停住，读者无法分辨是浏览器就这么说的，还是上游不说话了。
>
> **这不是罕见调用。** 探针 `.tmp-run/probe-cdp-truncation.mjs` 用真实注册路径
> （含审批门）量了五档 `DOMSnapshot.captureSnapshot` 响应：
>
> | CDP 响应总长 | 返回给模型 | 仍是合法 JSON | 有没有说被截断 |
> |---|---|---|---|
> | 2 411 字符 | 2 411（完整） | ✅ | — |
> | 9 111 字符 | 9 111（完整） | ✅ | — |
> | 27 111 字符 | 20 000（**截断**） | ❌ | **没有** |
> | 68 111 字符 | 20 000（**截断**） | ❌ | **没有** |
> | 183 111 字符 | 20 000（**截断**） | ❌ | **没有** |
>
> 被切断的位置是 `"string-number-446-`——连引号都没闭上。而
> `Network.getResponseBody` 同样轻松越过这条线。
>
> **修法**：抽出常量 `CDP_RESULT_MAX = 20_000`，超限时在结果尾部追加一句说明，
> 写明**真实总长**与「这只是前 20000 字符」，并提示怎么缩小调用范围；
> `meta` 同时给出 `{ truncated: true, fullLength }`。上限本身没有变——它挡的是
> 单次调用灌满上下文——变的是**上限不再撒谎**。
>
> **新增 `packages/dsh-browser-bridge/test/cdp-truncation.test.js`（4 条，488 → 492）。**
> 四条分别守：小结果完整交回且不谎称截断；超限结果带标记、标记里的总长是真的、
> 保留的前缀就是真实答案（不是重写）；**标记词不会被 payload 自己含有的
> 「truncated」误判**（所以第三条用了一个特意不含该词的 fixture）；被策略拒绝的调用
> **不会被描述成截断**（那条路径上根本没跑过 CDP）。
> **防护力已实测**：把实现回退成旧的静默 `.slice()` → **490 passed / 2 failed**；
> 还原后 SHA256 与改动前字节一致。
>
> **本轮证伪的四个方向**（记下来免得下次重跑）：
> 1. **manifest 权限有冗余？** 没有。8 个权限逐个与代码交叉核对，全部是功能必需
>    （`debugger` 7 处、`tabs` 37 处、`storage` 13 处、`contextMenus` 7 处，
>    最少的 `scripting`/`tabGroups`/`alarms`/`sidePanel` 各 1–2 处，每一处都是
>    真实路径而非防御性调用）。
> 2. **右键菜单 `page` 与 `tab` 上下文重复？** 不重复。查 MDN 的
>    `menus.ContextType` 定义：`page` 是页面上右键，`tab` 是标签栏上右键，
>    出现在两个不同位置。
> 3. **没粘令牌时不重连是个缺陷？** 不是。实测（`.tmp-run/probe-no-token-loop.mjs`）
>    这种情况下 `socketAttempts: 0`、`timersScheduled: 0`、`keepaliveAlarmsCreated: 0`，
>    worker 确实完全静默——但选项页保存令牌走 `chrome.storage.local.set`，
>    而 `background.js:2246` 的 `storage.onChanged` 监听器会调 `connect()`，
>    所以主路径是自愈的。重试一个没有令牌的连接本来就是无意义的。
> 4. **宿主侧设置卡片的字典缺测试？** 部分成立但不是缺陷。探针
>    `.tmp-run/probe-client-dict.mjs` 量出 30 个键、两语言键集完全对齐、占位符无错配；
>    唯一真死的键是 `statusPanel`。
>
> **两个探针自身犯的错（值得记住）**：探针第一版把参数写成 `tabId`，而真实参数名是
> **`tab_id`**（`tabIdOf` 对其它拼写一律返回诊断字符串）；第二版传的 `exec` 是 `{}`，
> 而 `askApproval` 在 `input.exec?.agent === undefined` 时**按 fail-closed 返回
> `unavailable`**，于是 CDP 调用根本没被执行到，探针报出的 121 字符「拒绝」文案
> 看起来却像是截断数据。**两处都是我在猜接口，而不是读实现。**

> ### v56：令牌写入失败会留下凭据残骸，而扩展从来没有图标（本轮修复）
>
> 这一轮把待办清单上最后一个零覆盖模块 `lib/token.js` 补上测试，并顺手检查了
> 从第一轮起就没有人看过的那个表面：工具栏上的图标。
>
> **缺陷一：`writeTokenState` 失败时把令牌明文留在磁盘上。**
> 原子写的形态是对的（临时文件 + rename，读方永远看不到截断的文档），但它**没有失败路径**：
> `renameSync` 抛错时那个临时文件就留在原地，而临时文件里是**完整的 64 位令牌明文**。
>
> 这不是罕见场景。在 Windows 上，**rename 覆盖一个被别的句柄打开的文件会失败并报 `EPERM`**，
> 而持有这种句柄的都是日常程序：杀毒软件、搜索索引器、编辑器。实测每失败一次就多一个
> `dsh-browser-bridge.json.<pid>.tmp`，**且因为带 pid 后缀，它们互相不会覆盖，只会累积**。
>
> **修法**：`writeTokenState` 包上 try/catch，失败时先 `rmSync(temporary, { force: true })`
> 再**把原错误抛出去**（错误仍然就地暴露，不吞掉）。清理本身也是 best-effort：
> 若临时文件根本没建出来就没什么可删，若删除也失败则原始错误更值得报告。
> 实测修复后连续 5 次失败，目录里仍只有 `state.json`，且**失败不会破坏已有令牌**。
>
> **顺带量清的一件不是缺陷的事**：`mode: 0o600` 在 Windows 上被静默忽略
> （实测文件模式是 `100666`）。我一度把它记成安全缺陷，查了 ACL 之后撤回：
> `C:\Users\hj\.dsh` 只授予 `SYSTEM` / `Administrators` / 用户本人，
> **Windows 用户目录的默认 ACL 已经提供了与 0600 等价的保护**。
> 所以这是文档准确性问题（HANDOVER §6 写着「0600」），不是漏洞。
> 测试里按平台分别断言，避免任何一侧被当成理所当然。
>
> **缺陷二：扩展从来没有图标。**
> `manifest.json` 没有 `icons`、`action` 里也没有 `default_icon`，整个 `extension/` 目录
> **除 manifest 外零资源文件**——于是工具栏画的是 Chrome 的灰色占位方块，
> 而 README 第 116 行明确写着「**点扩展图标**打开侧边面板」。
> **为什么三十多轮没人发现**：图标不被任何代码引用，所以**没有任何测试会因为它的缺失而失败**，
> 它也不产生任何报错，只是静默地显示成别的东西。
>
> **修法**：用 DSH 自己的美术资产（`dsh-web-frontend/dist/favicon.svg` 与
> `@deepseek-ai/dsh-client-ui-primitives` 的 `FISH_LOGO_PATH`，同一条鱼的轮廓），
> 生成 16/32/48/128 四个尺寸。**`manifest.icons` 不接受 SVG**——Chrome 官方文档原话是
> 「WebP and SVG files are not supported」——所以由 Chrome 自己把 SVG 栅格化成 PNG 后再入 manifest。
>
> **几何是量出来的，不是挑出来的**：`.tmp-run/measure-icons.mjs` 在真实 16px 像素网格上
> 统计「鱼覆盖多少像素」与「有多少像素落进徽章区」。所有候选的鱼尾都会进入徽章区
> （尾巴本来就在右上角），所以判据是最小化重叠同时保持可读。
> 又因为**不同尺寸的最优留白本来就不同**（像素越少，抗锯齿越吃掉边缘），
> 最终每个尺寸一个缩放值：16→70%、32→74%、48→78%、128→80%。
> `.tmp-run/icon-v2.png` 是带徽章的目视证据：16px 下鱼仍可辨（眼睛和尾巴都在），徽章不遮挡。
>
> > **⚠️ v69 更正：上面这段的徽章方位是错的。** 徽章在右**下**，不是右上；
> > 16px 的 70% 是在错误前提下选的，已改为 84%。详见 v69 段。
>
> **测试（484 → 488，新增 `test/extension-icons.test.js` 4 条）**：断言两个声明都在、
> manifest 引用的每个路径都真实存在、**每个文件是真的 PNG 且尺寸与声明相符**（读 IHDR 头）、
> SVG 源件随 PNG 一起发布、以及**图标颜色 = 面板 `--accent` = 徽章 `BADGE_CONTROLLED_COLOR`**
> （三处都画 DSH 蓝，漂移了徽章会像是渲染故障）。
> **防护力逐项实测**：删 `icons` 声明 → **2 条红**；把 48px 声明成 128px → **1 条红**；
> 颜色改成另一个蓝 → **2 条红**。
>
> **`test/token.test.js`（新增 8 条）**覆盖令牌的完整契约：路径在家目录而非用户设置、
> 64 位小写十六进制的往返与稳定性、**畸形文件读作不存在而不是让启动失败**、
> 比较只接受完全相等（大小写敏感、截断/超长都拒）、
> **非字符串一律拒绝而不是抛错**（`timingSafeEqual` 遇非 Buffer 会抛，
> 让恶意 peer 用一个数字就能制造拒绝服务）、失败写入零残留、以及按平台断言文件权限。
> **防护力实测**：回退失败清理 → **2 条红**，失败信息精确指出泄漏的文件名。

> ### v55：插件入口第一次被测试装载，立刻抓到两个真实缺陷（本轮修复）
>
> **为什么现在才抓到。** HANDOVER §5 一直记着「`lib/index.js` 从未被测试 import，
> 历史上那里抓到过两个真实缺陷」——这一轮把这句话当成了待办，而不是备忘。
> 新建 `packages/dsh-browser-bridge/test/entry.test.js`，用假 `ctx` **真的调用
> `apply()`**，于是第三个和第四个缺陷立刻显形。
>
> **缺陷一：peer 加载是 `Promise.all`，冷缓存下 100% 失败。**
> `apply()` 原来并发 import 三个 peer：
>
> ```js
> const [schemasteryModule, toolsModule, llmModule] = await Promise.all([
>   loadPeer('@deepseek-ai/schemastery'),
>   loadPeer('@deepseek-ai/dsh-tools'),
>   loadPeer('@deepseek-ai/dsh-llm'),
> ])
> ```
>
> 这三个包**互相依赖同一个 `cosmokit`**（`dsh-tools` 直接 import `schemastery`，
> `dsh-llm` 也把它列为 dependency），而 `cosmokit` 同时发布 ESM 与 CJS 入口。
> 并发导入时 CJS 那侧会 `require()` 还在求值中的 ESM 那侧，加载器直接抛：
>
> ```
> Cannot require() ES Module ...\cosmokit\lib\index.js because it is not yet fully loaded.
> This may be caused by a race condition if the module is simultaneously
> dynamically import()-ed via Promise.all(). Try await-ing the import() sequentially.
> ```
>
> **异常信息自己给出了修法，而它是确定性的、不是偶发的**：冷缓存下
> `.tmp-run\probe-peer-time.mjs` 连跑 4 次**全部失败**，改成顺序 await 后连跑 4 次**全部成功**。
>
> **顺序加载没有可测代价**（这一点必须量，否则就是拿一个潜在故障换一个现实故障）：
> 冷缓存下顺序形式 5 次是 **27.1 / 27.8 / 28.4 / 28.8 / 27.3 ms**，而**失败的并发形式
> 是 28.3 / 29.1 / 29.6 ms** —— 模块加载在加载器内部本来就是串行的，
> `Promise.all` 在这里从来没有买到并行，只买到了竞态。
>
> **热缓存会掩盖它，这是它活到今天的原因。** 真实 `dsh web` 进程在装载插件之前，
> 宿主自己已经 import 过这些 peer，缓存命中就不会重入加载器——同一探针在**热缓存下
> 4 次全过**。所以这不是「用户正在被伤害」，而是**一条潜伏路径**：任何 peer 未被预加载的
> 场合（独立实例、测试、加载顺序变化）插件激活都是必然失败。
> 修复已实测在冷、热两种缓存下都成立。
>
> **缺陷二：health 路由回显令牌前 8 位，而它自己写着「不含秘密」。**
> `BRIDGE_HEALTH_PATH` 是四条路由里**唯一不做任何鉴权**的（客户端 UI 与扩展都要在
> 拿到令牌之前轮询它，这是有意的），而它的注释写着：
>
> > Read-only and secret-free ... The token is deliberately absent
>
> 同一个响应体里却有 `tokenHint: token.slice(0, 8)`。探针
> `.tmp-run\probe-route-auth.mjs` 从**非环回地址**请求四条路由，量出：
>
> | 路由 | 环回 | 网络 | 结果 |
> |---|---|---|---|
> | `/browser-bridge/health` | 200 | **200** | 无鉴权，且返回 `tokenHint` |
> | `/browser-bridge/chat` | 200 | 403 | 正确 |
> | `/api/browser-bridge/token` | 200 | 403 | 正确 |
> | `/browser-bridge/context` | 200 | 200（GET）/ 403（DELETE） | 正确，读取有意开放 |
>
> **严重性要说清楚，不夸大**：泄露 8 个十六进制字符 = 32 bit，剩余 224 bit，
> 按每秒 10 亿次猜测也要 10^50 年——**不能靠爆破**。真正的问题是**原则**：
> 一个被刻意选定为「不鉴权」的路由，不该携带凭据的任何片段。
> **而它没有任何消费方**：`lib/client.js` 读 health 的 15 个字段，`tokenHint` 一次都没出现；
> 扩展侧的 `tokenHint` 是无关的字典键。已删除，`tokenLength` 保留（那是形状不是秘密，
> 扩展的选项页正靠它做本地长度校验）。
>
> **测试（472 → 476，新增 `test/entry.test.js` 4 条）**：
> 断言 5 条路由全部注册、25 个工具全部注册、peer 顺序加载（结构断言，
> 因为本套件跑在已经热起来的进程里，冷缓存无法在进程内重现）、
> health 响应体里**任何字段**都不匹配令牌形状、以及网络地址在读取用户数据的三条路由上被拒。
> **防护力逐项实测**：加回 `tokenHint` → 475 passed / **1 failed**；
> 恢复 `Promise.all` → 475 passed / **1 failed**（失败信息即竞态原因）。
>
> **这一轮的教训**：文档里「这里没测过」的记录不是免责声明，是待办清单。

> ### v54：面板错过了这一轮的 `start`，就永远不知道它结束了（本轮修复）
>
> **缺陷**：`applyDelta`（`extension/sidepanel.js`）里那道 `if (live === null) return`
> 守卫，把**没有 `start` 的 `end` 也一起丢掉**。而 `live` 只由 `start` 帧创建，
> 关闭侧边栏会销毁它自己的 document，service worker 发的帧没人接 —— 于是
> **在 turn 进行中打开/重开面板的人，永远收不到这一轮的 `end`**。
>
> `currentSessionRunning` 是驱动等待行（`.working`）与 composer 上「停止」按钮的
> 唯一开关（`sidepanel.js:1286` 的 `wanted = view === 'chat' && (currentSessionRunning || sending) && !hasContent`），
> 它只在 `start`、`end`、`failed` 三处被置位（`:1536`、`:1594`、`:1548`）。错过了 `start`，
> 也丢掉了 `end`，它就**永远是 `true`**：turn 早就结束，面板还在画「思考中…」，
> 按钮还是「停止」，直到下一次 `POLL_MS`（8 秒）轮询或用户自己切换会话。
>
> **本轮修的是这一半，不是别人以为的那一半。** 我先按「应该采纳增量、让流式继续」
> 去改，结果被**项目自己既有的测试拦下**：
>
> ```
> ✖ a panel opened mid-turn shows nothing live rather than a truncated tail
>     a delta without a start invented a live block
> ```
>
> 那条测试是对的，而且注释写明了理由：面板中途打开时错过的是**这一轮回答的开头**，
> 渲染后来的增量等于**给人看一段截断的、看起来却像完整回答的片段** ——
> 比「明显在加载」更糟。`lib/stream.js:24-26` 记着同一个取舍：丢一帧最多损失
> 「本次动画的剩余部分」，因为**已提交的 transcript 才是事实来源**。
> 所以丢弃增量是**有意的设计**，我改错了方向。
>
> **正确的修法**（`extension/sidepanel.js` 的 `if (live === null)` 分支）：不采纳增量，
> 但**让 `end` 落地** —— `currentSessionRunning = false` 后 `renderWorking()`、
> `refreshTranscript()`、`refreshGroups()`，让面板立刻知道自己空了。
> 取消失败的 `failed` 分支早在本轮之前就被提到守卫之前（注释记着「否则会丢掉唯一
> 说明这轮死掉的那个词」），本轮补的是它旁边同一个原因的另一半。
>
> **验证**（`.tmp-run/probe-reopen-midturn.mjs`，真实 headless Chrome + 真实面板）：
> 修复前投 `text` 帧 `changed: false`（什么都没画，正确）；投 `end` 后
> **等待行仍在**（缺陷）。修复后 `end` 使等待行消失。外来会话的帧始终不泄漏。
>
> | 项目 | 结果 |
> |---|---|
> | `npm test` | **472 passed, 0 failed, 0 skipped**，exit 0 |
> | 防护力实测（把 `end` 分支改回 `if (live === null) return`） | **恰好 1 条变红**，消息 `the panel is still drawing a turn that is over` |
> | `npm run check:extension` | exit 0 |
> | 全量审计 32 场景 × 深浅两配色 | 0 findings / 0 broken |
> | 字典 | 84/84 键对齐 |
> | 预览残留 `chrome-profile-*` | 0 |
>
> **新增 2 条测试**（`packages/dsh-browser-bridge/test/panel-stream.test.js`）：
> `a panel that missed the start still hears the turn end`（先确认等待行**真的存在**，
> 否则「end 清掉了它」在什么都没画的面上也成立 —— 这条断言在写出正确装置前
> 失败过三次）；`adopting a turn does not adopt somebody else's session`（会话守卫的对照）。
>
> **测试装置教训（本轮第三次踩到同一个坑）**：等待行由 `currentSessionRunning` 驱动，
> 它只被 **groups 时钟**（`clockOf('groups')`）设置，**不是** `pollHealth()`
> （health 时钟只管待批问题）。我先后猜错 `pollOnce`、`runningGroups()`、`host.running`
> 三个名字，真实的是 `clockOf('groups')` 与 fixture 里已有的 `host.running` 字段。
> **另外：`host.running` 必须在断言前用 `try/finally` 复原** —— 泄漏一次就让后面
> **5 条无关测试**变红（：127 的默认 fixture 会读它）。

> ### v53：页面里有 iframe 时，一半的行号是重号的

> **缺陷**：CDP 快照是**每个 frame 一份 document**，而**每份 document 的节点都从 0 开始编号**。
> `distillSnapshot`（`extension/page-distill.js`）把所有 document 的行混进同一个列表，
> 报出的 `index` 却是**它在自己文档内的位置** —— 于是同一个 `#n` 对应两个不同元素。
>
> 在 `.tmp-run/probe-iframe.mjs` 上量出（一个结账页，卡号表单在 iframe 里）：
>
> | 项 | 值 |
> |---|---|
> | 重复的 index | `13`、`18` 各出现 2 次 |
> | 歧义行占比 | **4 / 7 = 57%** |
> | `#13` 的首个匹配 | `"Apply coupon"`（页面上的按钮） |
> | `#13` 的另一个含义 | iframe 里的**卡号输入框** |
>
> `resolveTarget` 用 `find` 按 index 取值，**只返回第一个匹配**：模型说「填 #13 卡号」，
> 扩展会去点「应用优惠券」。与 v52 同类 —— 静默点错元素。
> iframe 不是边缘情况：登录框、支付表单、验证码、嵌入式编辑器都在里面。
>
> **修法**（`extension/page-distill.js`）：让 `index` 在**整份快照内全局唯一** ——
> 每进入一个 document，加上前面所有 document 的节点数（`frameOffset`/`base`）。
> 偏移量**无条件推进**（`frameOffset += nodeCount`，写在过滤之前），
> 否则一个 frame 的行全被过滤掉时，它的编号会落回上一份 document。
> 同时在行上保留 **`nodeIndex`**（它在本文档内的真实位置），供需要直接和那个文档说话的地方用。
>
> 修复后同一页面：`#13`（Apply coupon）与 `#34`（Card number）分离，
> `duplicateIndices: []`、`ambiguousShare: 0`。
>
> **端到端验证**（`.tmp-run/probe-iframe-click.mjs`，真实 Chrome、两个文档各自记录谁被点到）：
> 页面按钮 index **7**、iframe 按钮 index **22**；
> 点 iframe 按钮 → `frame: ["frame"]`、**`page: []`**；
> 点页面按钮 → `page: ["page"]`、**`frame: []`**。点击精确落在目标文档，无跨文档误点。
> 「每行都解析到不同的活节点」也已核实（`indicesAreUnique: true`、`everyRowResolved: true`）。
>
> **新增 2 条测试**，468 → **470 条**。
>
> 第 1 条在 `packages/dsh-browser-bridge/test/chrome-e2e.test.js`：
> `indices stay unique when the snapshot holds more than one document`。
> 它同时断言**名字与行的配对**：只查编号唯一性的话，一个配错文档的偏移量照样能通过。
> **防护力已实测**：把 `index: base + index` 回退成 `index` → 恰好 1 条红，
> 消息就是缺陷本身：`indices collide across documents: [3,3]`。
>
> ---
>
> ### v53 附带修掉的第二个缺陷：frame 里的行，坐标是另一个空间
>
> 查编号时顺手量到：`resolveTarget` 的**坐标退化路径**（行上没有 `backendNodeId` 时用
> `element.bounds` 直接算点）**在 frame 上是错的**。
> `layout.bounds` 是相对**它自己那份 document 的 viewport** 量的，
> 而合成点击用的是**页面坐标**。
>
> 实测（`.tmp-run/probe-frame-coords.mjs`）：iframe 位于页面 y=50，
> 框内按钮只离 frame 顶 8px → 快照报 **y=8**；把它当页面坐标点下去，
> 命中的是页面自己的「Apply coupon」。**不报错，只是点了另一个元素** ——
> 与 v53 主缺陷同类，从另一扇门进来。`extension/background.js:1679-1680` 自己写着
> 「点到模型没选的地方，比什么都没有更糟」。
>
> **关键在于主路径其实是对的**：`DOM.getBoxModel` **会**把 frame 内的节点换算成页面坐标
> （实测给 `(96,74)`，正是 frame 原点 `(13,51)` 加上框内位置后的结果）。
> 所以只有退化路径有问题。
>
> **退化的可达性也量过**（`.tmp-run/probe-backendid-coverage.mjs`，混合页面含表单、
> shadow DOM 组件、iframe）：**11 行全部带 `backendNodeId`，11/11 都能解析**。
> 也就是说这条路径在正常页面上根本走不到 —— 所以**改它比改坐标更该做**：
> 修坐标需要为每行算出它所属 frame 的页面偏移，而这条路径本该几乎不被使用。
>
> **修法**：`page-distill.js` 的行上新增 **`inFrame`**（由 document 在列表中的位置推出），
> `resolveTarget` 在 `inFrame === true` 时**拒绝**并说明原因，而不是点一个猜的位置。
> 这个字段**不进渲染输出**（模型看到的仍是 `#n role "name"`），已核实。
>
> 第 2 条测试在 `packages/dsh-browser-bridge/test/target-index.test.js`：
> `a frame-relative index is refused rather than clicked at the wrong point`。
> 它断言**一次点击都没发出**（`chrome.__clicks.length === 0`）——
> 只断言报错的话，一个「先点错再报错」的实现照样能过。
> **防护力已实测**：把 `if (element.inFrame === true)` 改成 `if (false)` → 恰好 1 条红。
>
>
> **写这条 fixture 时踩的两个坑**（都会让测试"通过"或"失败"得没有意义）：
> 1. **CDP 的 `strings` 是整份快照共享的一张表**，不是每份 document 一张。
>    我第一版给每个 document 各造了一张局部表，于是两行都读出**第一个文档的名字** ——
>    失败信息 `the rows were paired with the wrong documents` 是对的，是我的 fixture 错了。
> 2. 探针里的 `srcdoc` 必须转义 `</script>`：HTML 解析器在内联脚本块里遇到这个字面量就提前收尾，
>    **iframe 会静默变成空的**，探针于是只读到一行、看起来像产品缺陷。
>    症状与「产品真的漏掉 frame」完全一样 —— 是 `.tmp-run/diag-frame-rows.mjs`
>    把两份 document 的原始节点都打印出来才分清的。
>

> 而 `resolveTarget`（`extension/background.js`）拿到 index 后**重新拍一张快照**，
> 再在新快照里找这个序号。**页面在这中间变过任何一个节点，序号就全部错位。**
>
> 失败是**静默的**，而且比报错更糟：模型决定「点 #19，那个 Pay 按钮」，
> 而扩展去点了当前第 19 号节点 —— **可能是完全不相干的元素**。
>
> **先量**（`.tmp-run/probe-index-drift.mjs`，一个内容延迟到达的结账页 ——
> cookie 横幅和促销条在加载后 300ms 出现，这是网页的常态不是造出来的竞态）：
>
> | 项 | 值 |
> |---|---|
> | 快照时 Pay 的 index | **19** |
> | 页面变化后 Pay 的 index | **29**（漂移 10） |
> | 用旧 index 去点会命中 | **nothing**（什么都点不到） |
> | `backendNodeId` | **21 → 21，稳定** |
>
> **修法**（`extension/background.js`）：`distillSnapshot` 的行上一直带着 `backendNodeId`
> （v50 为 AX 合并加的），而它**在文档生命周期内稳定**。新增
> `resolveBackendNode(tabId, backendNodeId)`：**先 `DOM.getDocument`**（不先取，
> push 会报 `Document needs to be requested first` —— 这条是我**实测撞到**的，不是查文档得来的），
> 再 `DOM.pushNodesByBackendIdsToFrontend` 换回活节点，最后 `DOM.getBoxModel` 取真实盒子中心。
> `resolveTarget` 的 index 分支改为**优先走这条路**，拿不到时才退回按位置算 ——
> **退回不是死代码**：一个没变的页面、一个 AX 被拒的快照，都还需要它。
> 另外把「index 不在页面里了」的错误文案改成 `is not in this page any more; take a fresh snapshot`
> （原文案说 `does not name an element with visible bounds`，读起来像渲染怪癖，而实际是页面已经变了）。
>
> **修复效果实测**（`.tmp-run/probe-index-fix.mjs`，真 Chrome，页面自己记录被点的是哪个按钮）：
> | 路径 | 结果 |
> |---|---|
> | 旧 index（21）在新快照里 | **没有元素** → 点击落空 |
> | 稳定 id（23）解析 | 坐标 (92,163) |
> | 实际点击 | **`clicked:Pay`** ✅ |
>
> **新增测试 `packages/dsh-browser-bridge/test/target-index.test.js`（5 条，463 → 468）**：
> 走 `test/service-worker.js` 装置（真 background.js + 假 chrome + 真 WS 帧）。
> 五条守：按 index 点击走稳定 id 而非位置、**push 之前必须先取 document**、
> **没有稳定 id 的元素仍能按 bounds 点**（退回路径）、**浏览器拒绝解析稳定 id 时退回而不是失败**、
> index 已不在页面时报出「页面已经变了」。
> **防护力逐项实测**：不解析稳定 id → **2 条红**；不先取 document → **1 条红**。
>
> **这一轮的意义**：`index` 从「一个关于位置的猜测」变成「一个持久的引用」。
> 这类缺陷只有真实浏览器能暴露 —— 单元测试里快照不会变，所以永远看不到。
>
> **验证**：`npm test` **468 passed / 0 failed**，exit 0；`check:extension` exit 0；
> 32 场景 × 双配色审计 **0 findings**。**只改 `extension/` → 重载扩展即可。**
>
> ### v51：快照里有 16% 的行，模型读了什么也得不到（本轮优化）
>
> **起点**：v50 之后，用一个像真网页的页面（`.tmp-run/probe-realistic-snapshot.mjs`）重新量输出，
> 加了一项新指标：**完全空白的行**（名字、value、href、type 全无，渲染成 `#index role` 就没了）。
>
> 量出：**32 行里 5 行是空的（16%）**，而且要让模型找到「Pay now」得先读过 **22 行**。
>
> **根因一半是 v50 自己引入的**：把 `<label>` 的词给控件是**对的**（`#71 textbox "Email address"`），
> 但**label 那一行留了下来**，变成 `#68 label` —— 信息已被搬走，只剩一行占位。
> 实测 `derived` 版是 `#68 label "Email address"`，AX 覆盖后是 `#68 label`（名字空了）。
>
> **决定前先问 Chrome**（`.tmp-run/probe-ax-label.mjs`）：它的 AX 树里 `<label>` 是
> `role: "LabelText"`、**`name: ""`**、`ignored: false` ——
> **Chrome 也认为 label 本身没有名字，词已经归给它标注的控件了。**
>
> **修法**（`extension/page-distill.js`）：`applyAccessibleNames` 里新增
> `isInformationless(row)` + **`PROXY_ROLES = new Set(['label', 'LabelText'])`**，
> **同时满足两者才丢**。返回值新增 `dropped` 计数。
>
> **这个区分是刻意的，而且是本轮最要紧的一行**：`<label>` 是**代理**（词已归控件，丢掉不损失信息），
> 而**无名 `<button>` 是真实目标** —— 它可点，列在表里却不显示名字，**丢掉它就等于隐藏了一个能力**。
> 实测那一行留了下来，`emptyRows` 从 5 降到 1，剩下的正是它。
>
> **效果**（同一页面，同一探针）：
> | 指标 | 修复前 | 修复后 |
> |---|---|---|
> | 元素数 | 32 | **28** |
> | 空白行 | 5（16%） | **1（4%）** |
> | 「Pay now」前的行数 | 22 | **18** |
> | 渲染字符数 | 874 | **834** |
>
> **测试（改 1 条，463 条不变）**：`the browser names override the derived ones, and only where it helps`
> 现在同时断言 `dropped === 1`、label 行不在结果里、**以及无名 button 必须仍在**。
> **防护力双向实测**：不丢代理 → `an empty label proxy still occupies a row`；
> 放宽成「无信息就丢」（不分 role）→ `expected exactly one dropped proxy, dropped 2`
> —— 第二个 dropped 正是那个真实可点的无名按钮，**宽松规则会把它一起删掉**。
>
> **调研记录（本轮按新目标先看开源）**：Chrome 官方 MCP 的 `take_snapshot` 返回带 `uid` 的文本树
> （[SKILL.md](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/skills/chrome-devtools/SKILL.md)），
> Playwright 的 `ariaSnapshot` 是 YAML 树（`- role "name" [attr=value]`，
> [文档](https://playwright.dev/docs/aria-snapshots)）。**两者都是树，本插件是平铺列表** ——
> 树能让层级代替行数（一个 `<nav>` 下的 12 个链接不必各占一行）。**这是下一个方向，不是本轮改动**：
> 本轮先解决「行本身有没有信息」这个更基础的问题。
>
> **验证**：`npm test` **463 passed / 0 failed**，exit 0；`check:extension` exit 0；
> 32 场景 × 双配色审计 **0 findings**。**只改 `extension/` → 重载扩展即可。**
>
> ### v50：模型看不懂表单——可访问名是猜的（本轮重构）
>
> **缺陷**：`extension/page-distill.js` 自己推导「可访问名」——那是 **W3C 规范**
> （AccName），有参考实现（`dom-accessibility-api`），而 **Chrome 本来就实现了它**
> （屏幕阅读器读的就是它）。此前的快照测试全用**手写的小页面**（一个标题、两个输入框、一个按钮），
> 只能证明字段名对，证明不了真实页面上读不读得懂。
>
> **先量**（`.tmp-run/probe-realistic-snapshot.mjs`，一个像真网页的页面：12 个导航链接、
> 盖在内容上的 cookie 横幅、只有 aria-label 的图标按钮、带 `<label>` 的表单、价格表格）。
> 同一批节点，自算 vs Chrome：
>
> | 元素 | 自算 | Chrome |
> |---|---|---|
> | `<label for>` + `<input>` | **（空）** | `Email address` |
> | `<select>`（两个 option） | `ChinaJapanKorea` | `Country` |
> | 包裹式 `<label>` + checkbox | `onI agree to the terms` | `I agree to the terms` |
> | `aria-label` 图标按钮 | `Close the panel` | `Close the panel` |
>
> **空名字是最糟的**：模型分不出哪个输入框是邮箱、哪个是卡号，只能猜。
>
> **决定：不写完规范，去问已经实现的浏览器。**
> `.tmp-run/probe-ax-name.mjs` 证实 `Accessibility.getFullAXTree` 一次调用覆盖全页
> （**8ms / 16.6KB / 33 个 AX 节点**），且 `.tmp-run/probe-snapshot-fields.mjs` 证实
> **CDP 快照本身就带 `backendNodeId`**（`snapshot.documents[].nodes.backendNodeId`），
> 与 AX 的 `backendDOMNodeId` 直接 join。**这一步是实测的，不是凭记忆的** ——
> join 键猜错会得到「全部未匹配」，而那看起来和「没什么可改进的」一模一样。
>
> **重构**（`extension/page-distill.js`）：
> 1. `distillSnapshot` 的行上新增 `backendNodeId`（有才带）。
> 2. 新增导出 `applyAccessibleNames(elements, tree)`：按 backend id join，**覆盖名字**。
> 3. **`AX_ROLE_ALLOWLIST`** —— 第一版直接采用 Chrome 的 role，**结果更糟**：
>    `<label>` 变成 `LabelText`、`<span>` 变成 `none`，都不是模型能用的词。
>    实测发现后改为**白名单**：只在 Chrome 说得更准的地方采纳（无 `href` 的 `<a>` 不是链接、
>    `<div role="button">` 是按钮），其余保留按标签推导的角色。
> 4. `background.js` 的 `pageSnapshot` 调 `Accessibility.getFullAXTree` 并合并，
>    返回值新增 `namesFrom: 'browser' | 'derived'`。**AX 失败不是快照失败** ——
>    自算的名字仍在，只是不升级。
> 5. **`skipControlValues` 修了两个真 bug**：`makeTextReader` 调用时**根本没传这个选项**
>    （修复是死代码）；而且它若全局生效，会连「输入框自己的值就是它的名字」这条规则一起跳过。
>    正确语义是**在向下遍历时跳过控件，根节点不跳**（`read(index, depth, isRoot)`）。
>
> **测试（新增 2 条，461 → 463）**：`the browser names override the derived ones, and only where it helps`
> （含「没有 backend id 的元素不动」「AX 为 undefined/空时不抛且原样返回」）；
> `a label does not take its control value as its own text`。
> **防护力实测（含一次失败）**：AX 覆盖回退 → 1 条红；label 修复回退 → **第一次没红**。
> 根因是 fixture 里 `inputValue` 是空的，而真实复选框报 `on` ——
> **没有值就没有「值被当成标签」这回事，测试在坏代码上也能过**。
> 给 fixture 补上值后，回退版报出 `the label absorbed its control's value: "onI agree to the terms"`，
> 正是真实页面上看到的那个字符串。
>
> **验证**：`npm test` **463 passed / 0 failed**，exit 0；`check:extension` exit 0；
> 32 场景 × 双配色审计 **0 findings**；真实页面复测 `axMatched: 32/32`，四个缺陷全部转正。
> **只改 `extension/` → 重载扩展即可。**
>
> ### v49：页面弹一个 alert，所有浏览器工具都停摆（本轮修复）
>
> **缺陷**：扩展**完全没有处理网页自己的 JavaScript 对话框**（alert / confirm / prompt），
> 而 `lib/tools.js` 的超时文案里早就写着「a dialog may be open」——**代码承认了这个可能性，
> 却从不帮用户处理**。README 与 HANDOVER 里也从未提到过对话框（已核实：全文零命中）。
>
> **先量清，不推断**（`.tmp-run/probe-dialog.mjs`，真实 headless Chrome）：
> | 命令 | 基线 | 对话框弹出时 |
> |---|---|---|
> | `Runtime.evaluate` | 4ms | **4014ms 超时** |
> | `DOM.getDocument` | — | **阻塞**（快照工具全废） |
> | `Page.captureScreenshot` | — | **阻塞**（截图工具全废） |
> | `Page.handleJavaScriptDialog` | — | **2ms，可用** |
>
> 即：**页面弹一个 alert，几乎所有浏览器工具都会挂到超时**，而修复只需一条 2ms 的命令。
> 根因是对话框会**挂起该标签页的整个命令队列**。
>
> **修法**（三处，缺一不可）：
> 1. `extension/background.js` 新增模块级 `openDialogs` Map 与 `hasOpenDialog(tabId)`；
>    `enableObservers` 补上 **`Page.enable`**（**这是订阅对话框事件的前提**，不启用则
>    Chrome 根本不发 `Page.javascriptDialogOpening`）；`onEvent` 处理
>    `Page.javascriptDialogOpening` / `Page.javascriptDialogClosed`；`onDetach` 与 `detach`
>    都要清掉记录（**detach 时 Chrome 会替你应答，留着记录等于谎报标签页仍被阻塞**）。
> 2. 新增两个方法：**`page.dialogs`**（只读报告）与 **`page.dismissDialog`**（应答）。
>    `page.dialogs` **绝不能走 CDP** —— 它用 `chrome.tabs.get`（浏览器进程）而不是
>    `pageInfo` 的 `Page.getLayoutMetrics`（渲染进程）。**被阻塞的标签页答不了 CDP，
>    所以走 CDP 的报告会在它最该工作的时刻超时**。
> 3. `dismissDialog` 默认 **`accept: false`（驳回）**：扩展没读过页面问用户的那个问题，
>    替用户点「确定」是替别人做决定。页面于是走 "no" 分支。
>
> **两个等待点也改成先看对话框**：`waitForLoad` 直接返回、`pageWaitFor` 返回
> `{ satisfied: false, blockedByDialog: { type, message } }`。**不这样改，
> 它们会在一个不可能成功的标签页上把 15/20 秒预算跑满，然后报一个什么都没说的超时。**
>
> **宿主侧**：新增工具 **`browser_dialog`**（查看 / 应答）；`lib/tools.js` 的超时文案改为
> **点名对话框并给出那一个能解决问题的调用**（「call browser_dialog with the tab id」），
> 因为「check the tab」没给模型任何可做的事。`classifySensitivity` 新增该工具：
> **查看是免费的，应答算敏感操作**（会再问用户一次）。
>
> **`browser_dialog` 从 README 工具表里漏掉了** —— 这是我实现完就发现的（工具表 24 行、
> 代码 25 个）。已补，并**新增一条测试永久锁住这个不变量**：
> `tool-schema.test.js` 的「every tool the plugin registers is in the README table」
> **双向检查**（漏行 = 隐藏了能力；多行 = 承诺了不存在的工具）。
> **防护力双向实测**：删掉 `browser_dialog` 那行 → 报 `these tools exist but are not in the README table: browser_dialog`；
> 加一行假工具 → 报 `the README documents tools that do not exist: browser_teleport`。
>
> **项目自己的测试又拦了我一次**（对）：`bridge-e2e.test.js` 的
> 「every host method the extension claims to implement is dispatched」报
> `background.js does not mention: page.dialogs, page.dismissDialog`。
> 根因是 `extension/background.js` **自己有一张 `METHODS` 常量表**（每个方法名以字面量出现），
> 我只加进了 `lib/protocol.js`。已补进扩展侧那张表。
>
> **验证**：`npm test` **461 passed / 0 failed**，exit 0（455 → 461）；
> `check:extension` exit 0；32 场景 × 双配色审计 **0 findings**；字典 84/84。
> **修复效果也在真实 Chrome 里量过**（`.tmp-run/probe-dialog-fix.mjs`）：
> 事件到达（`confirm` "delete everything?"）→ 应答前**确实阻塞** → `handleJavaScriptDialog accept:false`
> **1ms** → 应答后 **2ms 恢复**且页面走到 `no` 分支 → `javascriptDialogClosed` 到达。
> **同时改 `lib/` 与 `extension/`：前者需重启 `dsh web`，后者重载扩展。**
>
> ### v48：令牌粘错了，这一页什么也不说（本轮修复）
>
> **缺陷**：设置页的令牌输入框是 `type="password"`，而它**是整个产品最容易失败的一步** ——
> 从另一个窗口复制 64 位十六进制字符、粘贴到一个看不见内容的框里。
> 粘一半、粘成大写、从错误的字段复制，**页面上没有任何反馈**：用户点「保存并连接」，
> 连接失败，**然后文案把责任推给 harness**（v42 才刚修好这件事的另一半）。
>
> **修法**（`extension/options.html` + `options.js` + `locales.js`）：
> 1. **显示/隐藏开关**：`revealButton` 上 `aria-pressed` 记录状态（标签说按钮接下来做什么，
>    pressed 说字段现在是什么，屏幕阅读器需要这一对）。
> 2. **形状提示** `#shape`：粘贴即判定，**空字段不报错**（否则每次首次访问都被红字迎接）；
>    长度不对时在句末附上**实际长度**，让人一眼看出是截断。
> 3. **`TOKEN_LENGTH = 64` 写死在扩展里**，不依赖 harness 可达 —— 需要这条提示的时刻，
>    恰恰是连接失败的时刻。宿主 health 路由确实返回 `tokenLength`，但那时可能读不到。
>
> **探针抓到我自己的一个真实缺陷**：第一版正则写了 `/^[0-9a-f]+$/i`，于是
> **64 个大写 `A` 被判为 `good`**。令牌由 `lib/token.js` 的
> `randomBytes(32).toString('hex')` 生成，**永远是小写**，宿主逐字节比较 ——
> 64 位大写字符串从来不是令牌，而从错误字段复制的典型形状正是它。已去掉 `i` 标志。
> **这是先写探针再断言的价值：`.tmp-run/probe-token-field.js` 把四种粘贴形态逐一打印出来，一眼看见 `good`。**
>
> **项目自己的测试拦了我两次**（都对）：
> 1. `panel-i18n.test.js` 的「no dictionary entry is dead weight」报 `tokenHide` 定义了却从未被画出 ——
>    因为我的写法是 `say(revealed ? 'tokenShow' : 'tokenHide')`，**三元表达式让字面量扫描看不见**。
>    已改为 `revealed ? say('tokenShow') : say('tokenHide')`，两个字面量都在。
> 2. `options.js` 的 `say('key')` 扫描是**字面量匹配**，计算出来的键它看不见 ——
>    这正是那条测试存在的意义。
>
> **装置修复（`test/options.test.js`）**：
> - `makeNode` 的 `setAttribute` 原本是**空函数**、`removeAttribute` 只动 `dataset` ——
>   `aria-pressed` 的断言会变得毫无意义（「说了状态」与「从没说过」不可区分）。已改为真实存储。
> - 新增 `fire(type)`，让 `input` 事件（粘贴真正触发的那个）可测。
> - **从 `options.html` 读 `<input>` 的声明类型**，而不是硬编码：reveal 的分支问的是
>   「字段现在是不是 `type: 'text'`」，fixture 让 `type` 保持 undefined 会让**第一次点击
>   无论标记写没写 `password` 都看起来像 reveal**。这正是我第一版测试红掉的原因
>   （`undefined !== 'password'`）。
>
> **新增测试 3 条**（`test/options.test.js`，452 → 455）：显示/隐藏与 `aria-pressed` 双向、
> 四种粘贴形态（空/20 位/64 位合法/64 位大写）、**形状提示必须是建议性的**
> （形状看着不对的令牌仍要能送去测试 —— 否则一个来自旧 harness、长度不同的令牌会变得无法验证）。
> **防护力逐项实测**：去掉 `i` 标志的修复 → **1 条红**；reveal 不切换类型 → **1 条红**。
>
> **验证**：`npm test` **455 passed / 0 failed**，exit 0；`check:extension` exit 0；
> 32 场景 × 双配色审计 **0 findings**（**options 页两个配色各 0**，22 项文字 / 6 个点击目标）；
> 两个字典都对齐（**面板 84/84 键；options 38 → 42 键**，新增 `tokenShow`/`tokenHide`/`tokenShape`/`tokenShapeWrong`）。
> **只改 `extension/` → 重载 Chrome 扩展即可**，不需重启 `dsh web`。
>
> ### v47：按下「停止」之后，浏览器还在动（本轮修复）
>
> **缺陷**：宿主取消调用时**只本地 reject**（`lib/bridge.js` 的 `onAbort`
> → `settle(new BridgeError(cancelled))`），**从不告诉扩展**。对绝大多数方法无所谓，
> 它们毫秒级就结束了；对「会等」的方法是错的：
> `page.waitFor` 默认**轮询 15 秒**，`page.navigate` 与 `tabs.open` 等待加载**最多 20 秒**。
> 用户按下停止，turn 结束了，**浏览器仍在替他操作页面**——这正是那个按钮承诺要终止的事。
>
> **修法**（三处，缺一不可）：
> 1. `lib/protocol.js` 新增通知 **`callCancelled: 'call/cancelled'`**，载荷 `{ id }`。
> 2. `lib/bridge.js` 的 `onAbort` 在 settle **之前**发这条通知（settle 会把知道 id 的
>    条目删掉）。`bridge.js` 此前**没有任何 import**，新增的 `import { NOTIFICATIONS } from './protocol.js'`
>    无循环风险——protocol.js 是零 import 的常量表。
> 3. `extension/background.js` 新增模块级 `const cancelledCalls = new Set()` 与 `wasCancelled(id)`；
>    `relayNotification` 处理 `call/cancelled`；`handleFrame` 把 id 传给 `dispatch(method, params, id)`，
>    并在 **`finally` 里 `cancelledCalls.delete(id)`**（不论成功或抛错，这个请求都不再在途；
>    留着一个已完成的 id，会被下一个复用了同一号码的请求继承）。
>    三个等待点（`waitForLoad`、`pageWaitFor`、经 `tabsOpen` 的 `waitForLoad`）每轮循环检查一次。
>
> **设计选择**：`pageWaitFor` 被取消时返回 `{ satisfied: false, cancelled: true }` 而**不是抛错**——
> 宿主已经放弃了这次调用，这个回答会被丢弃，但**测试能看见是哪条路径结束了等待**。
> 未知 id 一律忽略（不记忆）：记一个没匹配上的 id 是缓慢泄漏，而且正是「后来的调用无故被停」的成因。
>
> **验证工具教训（本轮一半价值）**：`test/bridge.test.js` 的 `FakeSocket.send` 存的是
> **原始 JSON 字符串**（`this.sent.push(text)`），不是对象。既有测试只用了 `sent.length`（计数），
> 所以这个形状差异从未暴露；我第一版断言 `frame.notify` 读到 `undefined`，报「the extension was never told」。
> **正确做法是 `socket.sent.map((t) => JSON.parse(t))`。**
>
> **测试（新增 6 条，446 → 452）**：
> - `test/call-cancel.test.js`（**新文件，4 条**）：走 `test/service-worker.js` 的既有装置
>   （真 worker + 假 chrome + 真 WS 帧）。**关键断言不是「发了通知」而是「轮询真的提前停了」**——
>   只查 wire 的测试会放过一个「记下取消然后无视它」的实现。实测：答完后再等 500ms，`polls` 不再增长。
>   另三条：取消一个 id 不停另一个、已完成的 id 被遗忘（同号复用仍能跑完）、未知 id 被忽略且 worker 仍健康。
> - `test/bridge.test.js`（2 条）：`aborting mid-flight tells the extension to stop working`（断言通知到达 wire 且 id 正确）、
>   `a call that is never aborted sends no cancellation`。
> **防护力逐项实测**：扩展侧忽略 `call/cancelled` → **1 条红**；宿主侧不发通知 → **1 条红**。
> 两道防线各自独立可测——因为取消测试直接驱动 worker，**绕过了宿主**，所以必须两边都测。
>
> **踩到的坑**：`call-cancel.test.js` 的假 `chrome` 最初缺 `runtime.onInstalled`/`onStartup`/
> `storage.onChanged`/`tabs.onCreated`，报 `Cannot read properties of undefined (reading 'addListener')`，
> 并**污染了后面 7 条无关测试**（套件共享一个进程）。比对 `chrome.*.*.addListener` 全量清单后补齐。
> 另外 `'status'` 不是真方法名，是 **`'bridge.status'`**。
>
> **验证**：`npm test` **452 passed / 0 failed**，exit 0；`check:extension` exit 0；
> 32 场景 × 双配色审计 **0 findings**；字典 84/84。
> **改的是宿主 `lib/` → 需要重启 `dsh web` 才生效**（不是重载扩展）。
>
> ### v46：模型点不动元素时，你看不到为什么（本轮修复）
>
> **缺陷**：模型调用 `browser_*` 工具失败时，面板只画一个 `✕` 加参数摘要
> （`✕ browser_click #save`），**失败原因被整条丢掉**。链路上分两处丢：宿主
> `lib/chat.js` 的 `tool/result` 分支只取一个布尔值（`row.status = toolFailed(data) ? 'error' : 'ok'`），
> 结果正文从没进过行数据。后果是**信息不对称**：模型读得到原因、能自我纠正；
> 看着屏幕的人分不清是选择器没匹配、标签页被 DevTools 占住、还是页面根本没响应 ——
> 也就无法判断该不该介入。
>
> **真实形状（关键，别猜）**：`tool/result` 的文本**不在 message.content 顶层**，而是嵌在
> `{ type:'tool-result', toolCallId, content:[{type:'text', text, isError}] }` 里，`isError` 也在内层。
> 宿主的 `collectImageRefs` 递归进去正是这个原因（见本文件 1644-1646 行）。
> **所以 `toolFailed` 的浅层检查同样漏判**——一次失败的调用会被画成绿色成功。两处都已改递归
> （`toolResultText` / `hasErrorBlock`，深度上限 4，防止畸形日志造成死循环）。
>
> **修法**：新增 `toolFailure(data)`（取自结果文本，退化到 `error.message`，再退化到 `error` 字符串，
> 归一行并截到 `TOOL_FAILURE_MAX = 200`），行上带 `failure` 字段；失败行改为**真正的 `<button>`**，
> 点击展开原因。
> **`collapseToolRuns` 也必须带上 reason**：合并连续调用时原来只取 `previous.status = row.status`，
> 失败原因会掉——合并行显示叉号却没有任何解释，正是同一个缺陷高一层复现。
>
> **截图又抓到两个审计没覆盖的缺陷**（本轮一半价值）：
> 1. **重叠**：展开的原因与调用行**画在了一起**。根因与 `failed` 行当年完全相同 ——
>    `.row` 是 flex row，两段内容并排而非堆叠。修法是 `.row[data-kind="tool"] { flex-direction: column }`。
>    实测后果：调用行被压到**父容器宽度的 18%**（66px/360px），`.args` 的 `clientW=0 scrollW=33`（文字被切）。
> 2. **点击目标 18px**：行变成可点控件后只有 **360x18**，低于 WCAG 2.2 AA 的 24px。
>    用 `min-height: 24px; margin: -3px 0` 补到 24px（负 margin 抵消，布局不动）。
> 3. **我自己引入的第三个问题**：第一版把 `div` 做成可点 —— **只有鼠标能到达**，没有 tab 停靠点、
>    没有焦点环、没有 Enter。项目的 `reasoning` 行本来就是真 button，已改为同一做法
>    （有原因才建 `<button>`，无原因仍是 `div`，避免给 tab 顺序塞一个无作用的停靠点），
>    并补上 button 重置样式（`width:100%; padding:0; border:0; background:none; text-align:left`）。
>
> **审计器新增第 5 类检查（重叠/挤压）**：这是**截图发现、审计看不见**的那一类。
> 关键教训：**第一版检查写错了，而且它会静默通过** —— 我按「兄弟节点矩形相交」写，
> 但实测该行的 `children=1`，**这种检查永远不可能触发**。改成按「水平 flex 容器的子节点
> 逃出容器 / 内部文字被切」判定后才真正生效。
> 排除两类**有意为之**的截断，否则噪音会淹没真 findings：可滚动容器（transcript 本就该滚）、
> `text-overflow: ellipsis`（有可见「…」宣告，是设计决定）。
> **校准证据**：移除 CSS 规则 → 恰好 1 条 finding（定位到 `.tool.has-reason`，子元素宽度占比 0.15/1.3）；
> 恢复 → 0 条。
> **同时把 `toolFailure` 加进 `audit-all.mjs` 的场景表**：它此前不在列表里，而**折叠状态的行
> 没有第二个子元素，任何默认场景都不可能暴露这个缺陷**。
>
> **验证**：`npm test` **446 passed / 0 failed**，exit 0（439 → 446）；
> `check:extension` exit 0；32 场景 × 双配色审计 **0 findings**；字典 84/84。
> 唯一改动 `extension/` → **重载扩展**即可，不需重启 `dsh web`。
>
> ### v45：用键盘的人走不进这个面板（扩展侧，本次修复）
>
> **起点**：性能方向先被量清了。`.tmp-run/probe-layout-scale.mjs` 测出每帧一次强制布局
> 的代价随滚动容器里的文本量线性增长（5k 字符 0.92ms / 20k 1.89ms / 63k 5.20ms /
> 135k 14.42ms），而宿主 `lib/stream.js:34` 的 `DEFAULT_FLUSH_MS = 80` 意味着最多
> 12.5 帧/秒。**一个 20k 字符的答案每帧只占 80ms 预算的 2.4%，不是用户可感知的问题**，
> 继续优化属于过度工程。三个候选修法全部被数据否决（见
> `.tmp-run/FINDINGS-performance.md`），结论已存档，不要重开。
>
> **转向**：键盘与焦点。此前的键盘检查只问「聚焦时有没有可见焦点环」，从不问焦点
> **去了哪里**。新建 `.tmp-run/probe-focus.js`（真实 headless Chrome + 真实面板）量出四个缺陷：
>
> | 行为 | 修复前 | 问题 |
> |---|---|---|
> | 面板打开时焦点 | `body` | 第一次按键落空，只能先点输入框 |
> | 会话列表 `ArrowDown` | `moved: false` | 方向键在列表里完全无效 |
> | 历史视图里按 `Escape` | `historyStillOpen: true` | 关不掉，只能找 `‹` 按钮 |
> | 模型菜单打开时焦点 | 仍在 `#model` | 方向键选不了菜单项 |
>
> **修法**（`extension/sidepanel.js`，三处）：
> 1. 新增 `focusComposer()`：`pendingApproval === null && surface.hidden` 时
>    `input.focus({ preventScroll: true })`。两个排除都是有理由的：有待批问题时用户是
>    跟着徽章进来的，目标不是打字框；`surface` 可见时没有可用的输入框，聚焦它会让
>    `document.activeElement` 指向隐藏节点、下一次 Tab 不可预测。**提取成具名函数**是因为
>    `start()` 只在 import 时跑一次，写成内联代码那两个排除分支在套件里不可达。
> 2. 会话行加 `keydown`：`ArrowDown`/`ArrowUp` 用 `next.focus()` 移动（让浏览器自带的
>    scroll-into-view 跟随，面板不必知道行落在哪）。**不循环**——从末行跳回首行会掩盖列表长度。
> 3. 文档级 `Escape` 现在也关闭历史视图并把焦点还给 `#title`。**关闭而非切换**：
>    `#title` 本身是开/关切换，让 Escape 也切换就意味着它能*打开*历史，那不是「关掉一层」的意思。
>    `#model-menu` 早已正确处理 Escape，这次是让它成为一致的模式而非孤例。
>
> **装置缺口（本轮一半价值）**：`test/dom-shim.js` 的 `focus()` 是**空函数**、
> document 的 `addEventListener` 是**空函数**——所以焦点行为在过去**根本无法被测试**。
> 已补：`focus()`/`blur()` 维护 `document.activeElement`（分离节点不可聚焦，与浏览器一致）、
> document 收 `listeners` 并带 `emit`、`Element.emit` 冒泡到 document（面板把 Escape 装在
> document 上，不冒泡就测不到）、`getElementById` 取出的元素带 `documentRef` getter
> （它们是孤立根节点，没有 `parentNode` 链，否则 `focus()` 又变回空操作）。
>
> **新增测试 3 条**（`test/panel-stream.test.js`）：方向键在会话间移动且不循环、
> Escape 关历史并把焦点还给触发器、面板打开时光标已在输入框。
> **防护力逐项实测**（回退一处→跑→还原→校验字节一致）：方向键 → 1 条红；
> Escape 关历史 → 1 条红；`focusComposer()` 调用 → 1 条红。
>
> **验证**：`npm test` **439 passed / 0 failed**，exit 0（436 → 439）；
> `check:extension` exit 0；30 场景 × 双配色审计 **0 findings**；字典 84/84 键对齐；
> 真实 Chrome 复测四个量点全部转正（`onLoadFocus: textarea#input`、`moved: true`、
> `historyStillOpen: false`、焦点回到 `#title`）。
> 只改 `extension/` 与测试 → **重载扩展**即可，不需重启 `dsh web`。
>
> ### v44：侧边栏关着的时候，审批问题没有人接（扩展侧，本次修复）
>
> **症状**：turn 停在那里等一个批准，而屏幕上没有任何东西说得出这件事。用户看到的是模型不动了。
>
> **根因**：审批问题走 `approval/asked` 通知帧 → service worker 的 `relayNotification()` →
> `chrome.runtime.sendMessage({ type: 'dsh-approval-asked' })` → 面板的 `chrome.runtime.onMessage`。
> 最后一跳是空的：**侧边栏是一个独立 document，没打开时它的 JavaScript 根本没在运行**，
> 那个监听器不存在。而侧边栏默认就是关着的。
> 修复前实测（`.tmp-run/probe-offline-approval.js`，真实 `extension/background.js` + 假 chrome）：
> `{ panelMessageAttempted: true, badgeCallsAfterApproval: 0, anythingTellsTheUser: false }`。
>
> **修法**：面板侧本来就有兜底（`extension/sidepanel.js` 每 5 秒轮询 `/browser-bridge/health`，
> 读到 `approvalPending` 就接住未决问题），所以缺的不是恢复能力，是**让人知道该打开它的信号**。
> 复用 v41 的工具栏徽章：`approval/asked` 点灯、`approval/settled` 熄灭。
> 点扩展图标会开面板（`chrome.action.onClicked` → `chrome.sidePanel.open`），所以信号可点通。
>
> **四处决定**（都在 `extension/background.js`）：
> 1. **计数而非圆点**：一轮可命中两个受控工具，徽章显示未决**数量**。
> 2. **`approval/settled` 无条件重画**：id 见没见过都重画——worker 被回收期间 settle 掉的问题它没见过，
>    宿主才是「还有什么没关」的唯一权威。
> 3. **待批压过「正在控制」**：同一标签页上两件事可同时为真而徽章只放得下一个。看不见「有请求等你」
>    就无法行动；看不见「正在被操作」只是少一行状态。受控页有待批时显示红色 `#d1453b` + 计数，
>    清空后回到自己的圆点 `#4262f0`。
> 4. **全局与按标签页都设**：「Chrome 优先显示哪一个」本项目**测不了**（Chrome 137 移除
>    `--load-extension`），所以两处都设成该位置正确的值，按标签页那轮最后跑；断线时清空
>    （问题只能从这条 socket 被回答，宿主走了 `approval/settled` 永远不来）。
>
> **测试**：新建 `packages/dsh-browser-bridge/test/approval-badge.test.js`（4 条），加载真实
> `extension/background.js` + 假 chrome + 真 WS 帧。徽章是**截图照不到**的东西——`.tmp-run/` 全部工具
> 都看不见它（同 v31 教训的反面）。
> **防护力逐项实测**（回退一处→跑→还原→校验字节一致）：`markControlled` 不读未决数 → 1 条红；
> `settled` 不重画 → 2 条红；断线不清空 → 1 条红。
>
> **验证**：`npm test` **436 passed / 0 failed**，exit 0；`check:extension` exit 0；
> 30 场景 × 双配色审计 **0 findings**；字典 84/84 键对齐（新增 `action.awaiting`）。
> 只改 `extension/` → **重载扩展**即可，不需重启 `dsh web`。
>
> ### v43：开了两个 Chrome 窗口，模型就看错了页面（扩展侧 + 宿主侧，本次修复）
>
> **症状**：用户开着两个以上 Chrome 窗口时问「这个页面……」，模型回答的是**另一个窗口**
> 里的页面，语气上毫无迟疑。`browser_selection` 报的「当前标签页」取决于标签页列表的
> 排序，而不是取决于用户在看哪个窗口。
>
> **根因**：Chrome 的 `active` 是**每个窗口各有一个**——三个窗口就有三行 `active: true`。
> 宿主 `packages/dsh-browser-bridge/lib/page-tools.js` 写的是
> `tabs.find((tab) => tab.active === true)`，`find` 返回列表里的第一个。
> 探针 `.tmp-run/probe-active-tab.js`（三个窗口各一个活动页）实测
> `activeTabCount: 3`、`hostPicksTheUsersWindow: false`。
>
> **同一个项目里两种做法**：面板 `extension/sidepanel.js:2223` 用的是
> `chrome.tabs.query({ active: true, currentWindow: true })`——带窗口限定，**是对的**；
> 宿主用裸 `find`——错的。侧边栏一直知道自己窗口的标签页，只有宿主不知道。
> `windowId` 早就在传输层上（`tabRow` 一直在发），但 `lib/tools.js` 的 `tabLine()`
> 不渲染它，模型只看得到 `[id] 标题 — url (active, detached)`。
>
> **修法**（只有扩展能问 Chrome「哪个窗口聚焦」，所以答案由扩展提供）：
> - `extension/background.js` 新增 `focusedWindowId()`：`chrome.windows.getLastFocused()`，
>   **失败一律返回 `undefined`**，不因拿不到就弄坏整个列表
> - `tabRow(tab, dshGroupId, focusedWindowId)` 新增字段 `windowFocused`。**三态是刻意的**：
>   `true` 在聚焦窗口 / `false` 不在 / `undefined` 问不到。用 `false` 冒充「问不到」
>   是在断言一件不知道的事
> - `tabsList` 每次列表算一次聚焦窗口（不是每行算一次）；`tabsSelect`/`tabsClaim`/`tabsRelease`
>   三处单行调用点也补上
> - `lib/tools.js` 的 `tabLine()` marks 加 `focused window`——这是模型挑 `tab_id` 时
>   唯一读的东西，值得这点宽度
> - `lib/page-tools.js` 新增 `activeTabOf(tabs)`，按 `windowFocused` 选并返回依据 `via`
> - 答不上来时**明说是猜的**：`via === 'first-active'` 且存在多个 active 行时，正文加一句
>   「Several windows are open and this extension could not tell which one you are looking
>   at… Confirm it with browser_tabs」。只有一个窗口时不加（不存在歧义，加了是噪音）。
>   `windowFocused` 自相矛盾（多于一行命中）时也退回旧行为而不是任选。
>
> **`browser_selection` 此前零测试覆盖**——这正是跨窗口的 `find` 能活下来的原因。
> 新增两个文件分守两半：`test/active-tab.test.js`（6 条，给定 wire 行时宿主挑得对不对）、
> `test/tab-wire.test.js`（4 条，**真实 `extension/background.js`** 配假 chrome 走真
> WebSocket 帧，断言 `windowFocused` 真的发出去了、问不到时发 `undefined` 而非 `false`）。
>
> **顺手抽出的共享装置 `test/service-worker.js`**：`badge.test.js` 那套「加载真实 service
> worker」的代码现在两个套件共用。抽取时踩到一个真实的坑：`loadServiceWorker` 靠给源码追加
> 唯一标记让 `data:` URL 不同（**`data:` URL 按整段文本匹配，`import()` 会缓存**），两个
> 套件各从 0 计数就生成同一个 URL——第二个套件拿到缓存模块，`connect()` 不再执行，测试永远
> 等不到连接。**症状是整轮静默挂死而不是失败**（runner 在一个进程里跑完所有套件，一个 suite
> 停住后面 400 多条全不跑）。修法：计数器收进共享模块（只有一个），并给等待加超时，现在
> 它会以 `the service worker never connected to the fake host on port … usually a cached
> module URL` 失败而不是拖住整轮。
>
> **验证**：`npm test` **432 passed / 0 failed**，exit 0，连跑 3 次一致；
> 三层防护力都实测（回退宿主侧选择 → 1 条红；回退 `tabLine` mark → 1 条红；
> 回退扩展侧 `windowFocused` → 2 条红）；`npm run check:extension` exit 0；
> 30 场景 × 深浅两配色审计 0 findings；字典 83/83 键对齐。
>
> ### v42：令牌填错了，设置页却让你去检查 dsh web 有没有在跑（扩展侧，本次修复）
>
> **症状**：首次安装时把令牌粘错，设置页显示的是「连不上 <端口>」加三条检查，
> 第一条是「harness 在运行（dsh web），且端口与它的网址一致」。用户于是去重启一个
> 运行得好好的进程。而代码里那句专为这种情况写的「harness 拒绝了连接——最常见的原因是
> 令牌不对或已过期」**从未显示过**。
>
> **根因**：WebSocket API **不暴露 HTTP 状态码**。宿主对坏令牌回 401，浏览器只把它变成
> `error` 事件 + code `1006` 的 `close`；`error` 总是先到，而 `probe()` 的 `finish()`
> 有「第一个结果胜出」守卫，于是 `close` 分支（写 `refused`）成了死代码。
> 实测两种情形的**事件顺序完全相同**（`error` → `close:1006`），所以「令牌错」与
> 「harness 没跑」在界面上不可区分。探针：`.tmp-run/probe-token-reject.js`。
>
> **修法**：加 `portAnswers(port)`——一次 `fetch(url, { mode: 'no-cors' })`，
> 有人应答（哪怕 404）说明端口上有监听者，那么是令牌被拒；连接被拒说明 harness 没跑。
> **故意用 opaque 响应**：只取「有没有东西应答」这一个事实，读不到内容，
> 因此**宿主不需要加 CORS 头**——health 正文带着 harness 内部状态，这页面不该读它。
> `answered` 分支的检查项里**有意去掉**了 `check1`（端口已应答，再让人去查它是在
> 把人推向已被证明没问题的方向），保留 `check2`/`check3`（后者覆盖「端口上监听的是
> 别的东西」）。`close` 分支也做了同样判别，以防某些浏览器不发 `error`。
>
> **验证**：本机 Chrome/Node 实测判据成立（`.tmp-run/probe-nocors.js`：
> up → `{type:'opaque', status:0}` resolve；down → `TypeError: Failed to fetch`）。
> 新建 `packages/dsh-browser-bridge/test/options.test.js`（**4 条**），加载**真实的
> `extension/options.js`**，配假 `chrome` + 真会回 401 的 HTTP 服务 + 真的没人监听的端口，
> 点按钮后断言出现哪一句。判定是**双向**的：既断言该出现的句子，也断言**不该出现**的
> 句子（只断言「有错误提示」的测试在修复前也是绿的）。
> **防护力已实测**：把 `refused` 分支改回永远报「连不上端口」→ **2 条变红**，
> 失败信息正是旧行为那段文字；恢复 → 全绿。
>
> **踩到的坑（与 v41 徽章测试同一个）**：`options.js` 在 `save()` **被调用时**才解析
> `chrome`，所以「import 完就还原全局」会让点击时抛
> `Cannot read properties of undefined (reading 'storage')`，且错误来自一段 `data:` URL，
> 满屏 base64 什么也说明不了。还原必须挂在 `t.onCleanup`（测试结束），不是 import 结束。
>
> **更重要的坑：套件间全局污染。** 这条测试单独跑 4 条全过，`npm test` 里却红 1 条
> （`expected the cannot-connect diagnosis, got: The harness refused the connection`）。
> 根因：**`test/panel-stream.test.js:197` 在模块顶层把 `globalThis.fetch` 换成桩且从不还原**，
> 而 `test/run.js` 是**先 import 全部套件、再统一跑测试** —— 所以测试体运行时全局 `fetch`
> 已是它的桩，对**已关闭的端口**也 resolve，判据整个翻转。
> 顺带修掉一个真实脆弱性：`options.js` 原先直接调 `fetch(...)`，改为在**调用时**经
> `globalThis.fetch` 解析并容忍其不存在（与面板 `globalThis.navigator?.clipboard` 同风格）。
> 测试侧在 import 阶段抓住真 `fetch`，并加**哨兵**（import 时对确认关闭的端口发一次请求，
> 未 reject 就抛错指名道姓），使套件顺序被改动时**响亮失败**而非静默测错分支。
> `closedPort()` 也从「绑定再释放」改为「固定高位端口 + 真实连接确认」：本机
> **Windows 动态端口范围是 1024-15000**（`netsh int ipv4 show dynamicport tcp`），
> 所以 `listen(0)` 会把刚释放的号重新发出去；而**绑定不释放也不行——被绑定的端口就是会应答**。
>
> **顺带确认过、有意不改**：`extension/background.js:319-326` 的 `close` 分支说
> 「可能是 harness 停了，**或者**令牌错了」——那是诚实的表述（面板侧**确实**无法区分），
> 且它把用户引向设置页拿到精确答案，链路完整。
>
> **改动文件**：`extension/options.js`（新增 `portAnswers`，重写 `probe` 的两个失败分支）、
> `packages/dsh-browser-bridge/test/options.test.js`（新建）、`README.md`、`HANDOVER.md`。
> **只改了 `extension/` 与测试 → 重载 Chrome 扩展即可生效，不需重启 `dsh web`。**

> ### v41：上一轮做的高亮只有 24 毫秒，人根本看不见；另外补上「这个标签页正在被控制」（扩展侧，本次修复 + 新增）
>
> **这是对 v40 的自我纠错，教训比改动本身重要。**
>
> #### 一、量出来的缺陷：高亮只存在 24ms
>
> v40 把高亮接进了 `pageClick`，顺序是
> `highlightTarget → mousePressed → mouseReleased → clearHighlight`。
> 我写了功能，**但没有量过它在屏幕上存在多久**。
>
> `.tmp-run/probe-highlight-dwell.js` 按这个顺序驱动一遍并计时：
>
> | 阶段 | 耗时 |
> |---|---|
> | `Overlay.enable` + `highlightNode` | 9ms |
> | 派发 pressed/released | 22ms |
> | `hideHighlight` | 2ms |
> | **从画出到撤掉（= 用户能看到的全部时间）** | **24ms** |
>
> 人眼要「感觉到闪了一下」需要约 **100ms**，要看清是哪个元素需要 200-400ms。
> **24ms 的功能对用户等于不存在。** 我上一轮把一个自己没量过的功能说成了能用。
>
> #### 二、修法：不阻塞动作，但保证可见时长
>
> 新增 `HIGHLIGHT_DWELL_MS = 900` 与 `scheduleHighlightClear(tabId)`：
> 动作返回后**不再等待撤除**，而是排一个定时器；下一个动作重画并**重新计时**，
> 所以连续点击是「框跟着走」而不是「闪一下又闪一下」。
>
> 修后实测（`.tmp-run/probe-highlight-dwell2.js`）：
>
> | 指标 | 修复前 | 修复后 |
> |---|---|---|
> | 动作返回耗时 | 24ms（含撤除） | **26ms**（不含撤除，没变慢） |
> | 高亮可见时长 | **24ms** | **≥900ms**（400ms 时采样仍在） |
> | 到期后 | — | 干净撤除（`goneAfterDwell: true`） |
> | 连续动作 | — | 重画并重新计时 |
>
> 两个定时器清理点：`chrome.debugger.onDetach` 与 `chrome.tabs.onRemoved` 都调
> `cancelHighlightClear(tabId)`。**这里有个坑值得记**：定时器到期会走 `clearHighlight`
> → `raw()`，而 `raw()` 会**按需 attach**，所以 detach 之后若定时器还在，
> 它会悄悄把一个刚被用户/DevTools 收走的调试会话重新打开。
> `cancelHighlightClear` 的注释写明了这一点。
>
> #### 三、新增：工具栏徽章 = 持续的「这个标签页正在被控制」
>
> 高亮回答的是「**刚刚**动的是哪个元素」，它该来该走。但它答不了用户在
> 一连串工具调用中真正会问的那个问题：「**它现在还在动这个页面吗**」——
> 连点二十次就是闪二十下，没有一个持续信号。
>
> 徽章补上这一格。它画在**浏览器自己的 UI chrome 里**，网页无法遮挡、无法改样式，
> 且**按 tab 设置**（不是全局），所以它显示在它所说的那个标签页上。
> 它挂在**真实的 debugger attach 状态**上，而不是某个定时器上，所以它不可能
> 宣称一个不存在的控制。
>
> 实现：`markControlled(tabId, controlled)`，接线在 `attach()`（亮）、
> `detach()`（灭）、以及 `chrome.debugger.onDetach`（灭）。
> **第三个接线点是关键**：那是**用户自己**打开 DevTools 夺回标签页的路径，
> 徽章若在那里不灭，就恰好变成了这个徽章存在的意义所要防止的那个谎。
>
> tooltip 用 `browserTranslator()`，**不是** `chrome.i18n.getMessage()`：
> `extension/locales.js:16-22` 记录了 MV3 的 `_locales/` 机制被否决的理由
> （无法从 Node 套件验证）。用错的话会在**每种语言下都静默返回空 tooltip**。
> 新字典键 `action.controlled`（中：「DSH 正在操作这个标签页」/ 英：`DSH is operating this tab`）。
>
> #### 四、徽章是截图照不到的东西——所以测试怎么写
>
> `.tmp-run` 里所有工具（无头渲染、审计、像素比对）**都看不见徽章**，
> 因为它画在页面之上、浏览器自己的 UI 里。这正是 v31 那条教训的另一面。
>
> **先试真实 Chrome，走不通，且原因已量清**：Chrome **137 已移除
> `--load-extension`**（本机 Chrome 153），有头与无头两种模式都加载不了
> （`.tmp-run/diag-extension-load.js` 实测：`contentScriptCanSeeRuntime: NO EXTENSION API`、
> options 页打不开、算出的扩展 id 不存在）。我没有在 headless 上继续硬撑。
>
> ⚠️ **v66 修订：那个实测对，结论推广过头了。** 该开关只在**稳定版渠道**被关掉；
> Chromium 与 Chrome for Testing 保留着它（两者都是同一份 Chromium，只是渠道不同）。
> `.tmp-run/probe-load-extension-matrix.mjs` 三条独立证据重测：Playwright Chromium 153 ✅、
> Puppeteer Chrome for Testing 148 ✅、`chrome-headless-shell` ❌、稳定版 Chrome 153 ❌。
> 所以真浏览器 e2e **能做**，`test/extension-host.js` + `test/real-browser.test.js` 已经做成了。
> 上面那次探针之所以得出「不行」，是因为**只测了稳定版**，并且用了
> `contentScriptCanSeeRuntime` 这个**在主世界取值的判据**——扩展 API 只在隔离世界里存在，
> 主世界读不到是正常的，那不是「没注入」。今天徽章仍然要单独测，但理由变了：
> 不可读的是**渲染结果**（`chrome.action` 交给浏览器 UI 画，DOM 与 CDP 都拿不到），
> 不是「扩展装不上」。
>
> **改为新建 `packages/dsh-browser-bridge/test/badge.test.js`**：用假 `chrome`
> 加载**真实的 `extension/background.js`**，并走**真实入口**——
> 起一个假宿主 WebSocket，把 port/token 写进 storage，让模块自己的顶层
> `connect()` 连上来，再从宿主侧发 `debugger.attach` / `debugger.detach` 帧，
> 最后断言 `chrome.action.*` 的**调用参数**。
> 断言按 `tabId` 校验（徽章设错标签页比不设更糟），并按 tooltip 校验可读性。
>
> **这条测试有防护力（已实测）**：把 `setBadgeText` 的清除分支拆掉
> （改成永远 `'•'`）→ **416 passed, 2 failed**，两条都红；
> 恢复 → **418 passed**。
>
> #### 五、写这条测试时踩到的三个坑（都值得留在 HANDOVER）
>
> 1. **`import()` 按 URL 缓存**：第二条测试拿到了第一条测试的模块实例
>    （还持有第一条的 `chrome`），报出的却是「worker 从没注册过 detach 监听」——
>    症状与原因完全不同。修法是给 `data:` URL 追加唯一的尾语句。
> 2. **定时器让进程不退出**：模块的重连 `setTimeout` 在 Node 里会吊住事件循环，
>    于是套件打印完结果**永不退出**。修法是给加载的源码追加一个 teardown 钩子
>    （纯测试侧，不改产品文件）。
> 3. **污染 `globalThis.chrome`**：套件共享一个进程且按文件名顺序跑，
>    `badge.test.js` 排在 `panel-stream.test.js` 之前，我的桩把后面那个套件的桩
>    顶掉了——表现为 **7 条毫不相关的面板测试**失败在 `openOptionsPage is not a function`。
>    修法是在 teardown 里恢复原值。
>
> #### 六、另一处被项目自己的测试抓到的错
>
> 我最初把 tooltip 写成 `browserTranslator()('action.controlled')`，
> 被 `panel-i18n.test.js:323` 的 **「no dictionary entry is dead weight」判红**——
> 它扫描的是字面量 `t('key')`，末尾的 `(...)` 让正则匹配不到。
> **测试是对的，我的写法偏离了项目约定**。改为先 `const t = browserTranslator()`
> 再 `t('action.controlled')`。
>
> #### 验证结果（全绿）
> | 项目 | 结果 |
> |---|---|
> | `npm test` | **418 passed, 0 failed, 0 skipped**，**exit 0**（用 `WaitForExit` 证明自行退出） |
> | `npm run check:extension`（10 个脚本） | exit 0 |
> | 字典 | 83/83 键对齐，无占位符不匹配 |
> | `--width 380` 全量审计 | **30 场景 0 findings / 0 broken** |
> | 预览残留 `chrome-profile-*` | 0 |
>
> #### 文档
> - `HANDOVER.md:3` 顶部改为「当前状态：**v41 已交付**」，在 v40 段前插入本段
> - `README.md` 在 v40 段前新增 v41 段；测试计数 415 → 418
>   （**只改当前状态**的表述，历史段里的旧计数保持原样）
>
> #### 教训（写给自己）
> **做了功能不等于做了可用的功能。** v40 的代码是对的、测试是绿的、
> 截图里框画得清清楚楚——但它在真实使用中只存在 24 毫秒。
> 我只验证了「它出现」，没有验证「它待得够久」。**任何与时间有关的界面行为，
> 都必须量出时长，而不是假设它「应该够」**。

> ### v40：模型在你浏览器里操作时，页面上什么都看不见（扩展侧，本次新增功能）
>
> **这是本轮唯一一个「新增能力」而不是「修缺陷」的版本**，起点是问：
> 「`debugger` 权限意味着这个扩展能读写你登录的所有站点，那么**缓解措施都在哪里**？」
> 答案是：**全都在侧边栏里**——令牌、每域名审批、敏感动作二次确认。
> 而**网页本身什么提示都没有**。一次点击落下、一个字段被填上，
> 用户唯一的线索是回到面板读那一行工具记录，再自己对着页面找。
>
> **技术可行性先验证，再动手**（`.tmp-run/probe-overlay.js`）：
> CDP 的 `Overlay` 域**不在** `CDP_DENIED_DOMAINS` 里（被拒的是
> Browser/Target/Storage/SystemInfo/Extensions/ServiceWorker/WebAuthn/Cast），
> 而它正是 DevTools 自己高亮元素用的机制。实测：
> `Overlay.enable` / `highlightNode` / `hideHighlight` 全部可用，
> 像素确实变化（12204 → 19816 字节），`hideHighlight` **完全还原**。
>
> **效果比预期好**：`showInfo: true` 会让 DevTools 自己画出标注浮层——
> 元素选择器、尺寸、无障碍角色（`button#save  120 × 60` / `Role: button`），
> 这是一个用户已经会读的界面，不需要教学。
>
> **实现**（`extension/background.js`）：
> - 新增 `HIGHLIGHT_CONFIG`（accent 蓝 40% 填充 + 90% 边框，`showInfo: true`）
>   与 `HIGHLIGHT_RECT`（无法命名元素时的兜底框）
> - 新增 `highlightTarget(tabId, {nodeId?, backendNodeId?, x, y})`：
>   优先 `backendNodeId`，退化到 `nodeId → DOM.describeNode`，
>   再退化到 `DOM.getNodeForLocation` 按坐标换节点（**这是让两条寻址路径
>   共用一条高亮路径的关键**），最后退化到 `highlightRect`
> - 新增 `clearHighlight(tabId)` 与 `highlightSelector(tabId, selector)`
>   （`pageFill` 走 `Runtime.evaluate`，没有坐标可复用）
> - 接入点：`pageClick`（**画在按下之前**，否则点击可能已经改了页面）、
>   `page.type` 的 selector 分支、`page.fill`
> - `resolveTarget` 现在返回 `nodeId`
> - **`highlightTarget` 里的每个失败都被吞掉**，注解写明了理由：
>   高亮是**解释**，不是动作的一步。一个没有可命名节点的目标仍然要能点，
>   一个已被关掉的标签仍然要能返回结果。否则「打开一个视觉辅助」
>   会变成「点击停止工作」。
>
> **测试（这里有一个重要教训）**：
> 在 `test/chrome-e2e.test.js` 新增一条真 Chrome 端到端。
> **第一版只断言「截图变了」，我把它拿去验证防护力时发现它证明不了任何东西**——
> 把 `contentColor`/`borderColor` 都改成 `a: 0`（全透明），测试**依然通过**，
> 因为 `showInfo` 的浮层本身就在重绘页面。
> 第二版改为**只比较元素自身的矩形区域**，并断言其中**超过一半的像素**发生变化。
> 现在再灌同样的全透明改动 → **414 passed, 1 failed**（`696/3960` 像素变了，
> 元素本体没被覆盖），恢复 → **415 passed**。
>
> **同时踩到并记录的一个工具缺陷**：`Page.captureScreenshot({clip})` 的裁切截图
> **不含 overlay 合成层**——同一个被高亮的按钮，裁切截图与未高亮时**逐字节相同**，
> 而全页截图明确显示框画在上面。这正是我第一版测试失败的原因（不是产品缺陷）。
> 最终做法：取全页截图，在**页面内的 canvas** 里解码并逐像素比对矩形区域——
> Node 没有 PNG 解码器，而页面本来就能回答这个问题。
>
> **验证结果（全绿）**
> | 项目 | 结果 |
> |---|---|
> | `npm test` | **415 passed, 0 failed, 0 skipped**，exit 0 |
> | `npm run check:extension`（10 个脚本） | exit 0 |
> | `--width 380` 全量审计 | **30 场景 0 findings / 0 broken** |
> | 预览残留 `chrome-profile-*` | 0 |
>
> **README 同步**：「与 Codex 能力的差距」表里那条
> 「元素高亮 / 『正在被控制』提示 ❌ 未实现」已改为 ✅ **已实现**，
> 并注明「官方是否有此 UI 未确证；这是本插件自己的选择」——
> 不把本插件的设计说成是对官方的复刻。测试计数 412 → 415（只改**当前状态**的
> 表述；`#### v11` 等历史段里的 412 是那一版的结果，保持原样）。

> ### v39：设置页从未进过批量审计，于是它一直带着两种问题（工具 + 设置页，本次修复）
>
> **这一轮的起点是「还有什么用户可见的表面从未被审计」**——答案是设置页
> （`extension/options.html`）。它是用户必须过的那道门（粘贴令牌），
> 但 `audit-all.mjs` 只认侧边栏的 28 个场景，**从未渲染过它**。
>
> **查出三件事，其中两件是审计器自己的缺陷**：
>
> **1. 审计器在浅色下把整页判成 `ratio: 1`（黑字压黑底）。** 截图立刻证伪：
> 浅色下文字清晰可读。根因链条：
> - `options.html` 在 `html`/`body` 上都是透明背景，所以
>   `backgroundStack(element)` 返回**空数组**；
> - `rasterize([])` 只 `clearRect` 后读像素，得到**透明黑** (0,0,0)；
> - 于是每个元素都对着黑色合成。深色下**碰巧正确**，浅色下就报出整页不可能
>   存在的 1:1。
> - `pageBackdrop` 这个兜底值确实存在，但**从未被用于空栈**——它只在
>   `opacity < 1` 的合成分支里被读到。
> 修法：空栈时用 `pageBackdrop`。注意**不能**在审计脚本里直接
> `rasterize(['Canvas'])`——那个 canvas 节点**不在文档里**，不继承
> `color-scheme`，系统色永远解析成浅色（我踩过：改成 `'Canvas'` 后深色反而全红）。
> `pageBackdrop` 走的是一张真正插进文档的临时元素，所以是对的。
>
> **2. 复选框被报成 13×13 的点击目标，是误报。**
> `options.html` 的 checkbox 包在自己的 `<label>` 里，整行才是手指要打的地方。
> 审计器现在量 `label.htmlFor === element.id` 的包装 label，并在发现里标注
> `measured: 'wrapping label'`，这样读报告的人不会去截图里找一个 13px 的盒子。
> 改成量 label 之后，**它立刻暴露出一个真实缺陷**：那行是 **298×22**，
> 高度低于 WCAG 2.2 AA (2.5.8) 要求的 24px。已加 `label.check { padding: 3px 0 }`
> 补到 28px，文字位置不变。
>
> **3. 预览把伪宿主的临时端口画进了端口框**（截图上是 `5758`，而紧挨着的说明
> 写着「通常是 3080」）。那是**预览自身的**矛盾，不是产品缺陷（`options.js:56`
> 默认值本来就是 `3080`）。原因：`chromeStub` 让注入端口压过一切，
> 这对**作为客户端的侧边栏**是必需的（否则预览会去连用户线上的 3080），
> 但设置页是**表单**，它显示字段里存的东西。已改为按 `location.pathname`
> 区分：设置页用存储值/默认值。
>
> **工具改动**（都在 `.tmp-run/`）：
> - `audit-all.mjs` 新增 `--page` 维度，默认同时审计**侧边栏与设置页**。
>   设置页没有场景（它不随面板状态变化），所以每个配色只渲染一次，
>   而不是把同一页渲 28 遍充数。
> - 新增探针 `probe-options-page.js`（量端口字段与页面文字是否自相矛盾、
>   复选框的可点区域）与 `probe-canvas-color.js`（证实 `Canvas` 系统色
>   在浅色下确实返回 `rgb(255,255,255)`，把嫌疑从「取色」排除到「合成」）。
>
> **验证**：设置页深浅两配色均 **0 findings**；`npm test` **414 passed, exit 0**；
> `npm run check:extension` exit 0。
>
> **交付要求**：只改了 `extension/` → **重载 Chrome 扩展**即可。

> ### v38：一个会话都没有时，面板中央是 559px 的空白（扩展侧，本次修复）
>
> **这一轮问的是「全新用户第一次打开面板看到什么」的下一层**：装了扩展、宿主在跑、
> 令牌也对，但**一个会话都没有**。此前 28 个预览场景里没有一个覆盖它。
>
> **量出来的**（探针 `.tmp-run/probe-empty-state.js`，380x720）：
> - `#transcript` 占了 **380×559px**，`childCount: 0`，`visibleTextInStage: []`
>   —— **整片空白，一个字都没有**；
> - 输入框占位符是「问点什么…」，**在邀请用户打字**，而 `send.disabled: true`，
>   屏幕上没有任何东西解释为什么；
> - 用户打完字按发送**不可能成功**（`sendMessage()` 见 `currentSessionId` 为空就
>   只弹一个「先选择一个会话」的 toast）。**而这正是首次使用最容易走的一条路。**
> - 唯一的出路是页头那个 `＋`（`title` 为「在当前工作区新建会话」），渲染成一个
>   无标签的字形。
>
> **修法**：复用已经验证过的 `#blocked` 状态面（标题 + 一句说明 + 一个按钮），
> 让它承载**两种**状态——宿主不可达，和没有会话。两者都是「内容区没有东西可显示」
> 的同一个位置，新造第二个面板只会与它漂移。按钮的语义由状态决定，
> 所以它在 `sidepanel.js` 的点击处理里**回读 `hostReachable`**，而不是靠哪条分支
> 最后设的旗标。
>
> **顺带修掉一个我自己引入的「口吃」**：`renderTitle()` 原来在 `currentSessionId`
> 为空时显示「还没有会话」，于是**页头和中间的标题说了同一句话**。这与 v4 记过的
> 同类错误一致（当时是宿主不可达时页头谎报「还没有会话」），已按同一决策处理：
> 没有会话可命名时页头回落到产品名 `DSH`。
>
> **两个测试工具的真实缺陷，一并修掉**：
> - `preview.mjs` 的伪宿主答完 `create` 后**仍然返回空列表**，于是「新建会话」
>   按钮看起来没反应。真实的宿主会把新会话加进列表，已改成忠实模拟。
>   这个 fixture 缺陷差点让我把**功能正常**误判成**功能坏了**。
> - `panel-stream.test.js` 的 `groupsPayload()` **无条件返回硬编码的两个会话**，
>   所以「一个会话都没有」在这个测试套件里**根本无法表达**。已改为可被
>   `host.groups` 覆盖（并在用完后 `finally` 恢复——该套件共享一个面板实例，
>   不复原会污染后面所有测试，这一条我踩到过：43 条测试变红）。
>
> **测试**：新增一条（断言状态面出现、标题不与页头重复、按钮文案、
> **点击真的发出了 create 请求**、新会话出现后状态面自清）。
> **已验证有防护力**：把 `noSessions` 强制为 `false` → **413 passed, 1 failed**；
> 恢复后 **414 passed**。
> 同时 `panel-i18n.test.js` 的「no dictionary entry is a sentence」豁免表由 2 条
> 扩到 4 条（同**一个**状态面），并保留 `assert.equal(ALLOWED.length, 4)` 的锁。
>
> **验证**：`--width 320/380` × 28 场景 × 深浅两配色，空状态两种配色各 **0 findings**；
> `npm test` **414 passed, exit 0**；`node --check extension/sidepanel.js` exit 0；
> 字典键对齐。端到端已量：按下「新建会话」→ 发出 create → 状态面消失
> （`blockedHidden: true`）→ 页头变成「新会话」→ **输入框自动获得焦点**。
>
> **交付要求**：只改了 `extension/` → **重载 Chrome 扩展**即可，不需要重启 `dsh web`。

> ### v37：装了扩展但没粘令牌的人，被面板卡在那里（扩展侧，本次修复）
>
> **这一轮的起点是问「全新用户第一次打开面板看到什么」。** 此前的 28 个场景全部是
> 「宿主在跑、桥已连上」，而**第一次真的会遇到的中间状态从未被渲染过**：
> `dsh web` 在跑、扩展已装、令牌还没粘。
>
> **关键事实（决定了修法）：这个状态下对话是能用的。** 令牌只保护 WebSocket
> 升级（`lib/index.js:388-390` 的 `authorizeBridgeRequest`），而面板发消息走的是
> HTTP `/browser-bridge/chat`（`lib/index.js:434` 起的 `register`），
> **不经过那道校验**。所以此时：转录正常渲染、composer 正常、能正常聊天，
> **只有浏览器工具用不了**。
>
> **缺陷**：面板用一个 48×22px 的灰药丸写「未连接」来概括这一切。量出来的：
> - 该药丸 **不是按钮、不可点击**（`isButton: false`, `clickable: false`），
>   `title` 就是「未连接」本身，悬停也不多说一个字；
> - **屏幕上没有任何地方出现「令牌」或「设置」**（`bodyMentionsToken: false`,
>   `bodyMentionsSettings: false`）——而这两件正是唯一的出路；
> - 设置入口只存在于**历史视图的页脚**（`sidepanel.js` 的 `session-foot`），
>   要先把标题点开、再滚到底才看得到，聊天视图里 `settingsButtonInChatView: false`；
> - `background.js:161` **早就有准确的诊断**（`no token saved — open the extension
>   options and paste the token`），但它只进 `lastError`，面板从不显示。
>
> 于是「未连接」既没说清是什么没连上（用户会以为整个面板坏了），也没给下一步。
>
> **修法**：把这个状态从「一句事实」改成「一个出口」。
> - 措辞改为**点名什么不可用**：「浏览器工具未连接」（en: `Browser tools offline`），
>   并明确对话本身是好的；
> - 同一个 chip 上加一个 **「设置」按钮**，点击 `chrome.runtime.openOptionsPage()`；
> - 状态**自清**：桥连上后 chip 变回正常形态，不需要用户去关掉它——需要手动
>   关掉的东西是警告，不是对当前状态的陈述。
>
> **顺带修掉一个我自己引入的对比度缺陷，由审计当场抓到**：那个「设置」按钮最初用
> `var(--accent)` 作文字色，实测**深色 2.82:1、浅色 3.86:1**（正文需 4.5:1）。
> 根因是 `--accent` 是给**填充背景**校准的（白字压其上），当**文字色**用就不达标——
> 与 v35 修 `--ok`/`--bad` 是同一类问题。新增 `--accent-text`
> （`color-mix(in oklab, var(--accent) 62%, CanvasText)`），混合 `CanvasText`
> 使其在白底自动加深、黑底自动变亮，一个声明服务两种配色。62% 是量出来的：
> 78% 时深色仍只有 4.28:1。
>
> **同时修掉一处语义串台**：`context.offline` 原本还被 `model.failed` 当作
> 「连不上宿主」的原因复用。改名后那句会变成「切换失败：浏览器工具未连接」，
> 而真实原因是整个宿主不可达。新增独立的 `error.unreachable`（连不上 dsh web）。
>
> **测试**：新增一条（`panel-stream.test.js`，在 `host.health = { connected: false }`
> 下断言 chip 的 `data-warn`、标签文案、按钮存在、**点下去确实调了
> `openOptionsPage()`**、以及重连后 chip 自清）。该测试**验证过有防护力**：
> 把修复回退成「未连接」后它立刻变红（411 passed, 2 failed），恢复后 413 全绿。
> 测试桩原本把 `openOptionsPage` 写成空函数，现改为计数器——空函数分不出
> 「按钮生效」和「按钮什么也没做」。
>
> **验证**：`--width 320/380` × 28 场景 × 深浅两配色 **全部 0 findings / 0 broken**；
> `npm test` **413 passed, exit 0**；`node --check extension/sidepanel.js` exit 0；
> 字典 78/78 键对齐。截图：`.tmp-run/shot-offline-zh.png`、`shot-offline-en.png`。
>
> **交付要求**：只改了 `extension/` → **重载 Chrome 扩展**即可，不需要重启 `dsh web`。

> ### v36：窄面板下发送按钮会掉出屏幕，以及设置页没被渲染过（扩展侧，本次修复）
>
> **这一轮的起点是「把宽度压到真实极限」。** v35 只量了 380 与 300，
> 这一轮把视口压到 200（≈200% 文本缩放的等效宽度）与 320（WCAG 1.4.10 重排要求），
> 立刻掉出三类缺陷 —— **全部是同一类：只用「够宽」验证过。**
>
> **一、`#model` 不肯收缩，把发送按钮挤出视口。** 200px 视口下 `#send` 的右边缘
> 落在 **233px**，即**发送按钮完全不在屏幕上**（这是面板里最不能消失的按钮）。
> 根因不是宽度写死，而是 flex 默认值：`#model` 是 flex item 却只给了 `max-width`，
> 其 `min-width` 取默认的 `auto` = min-content（实测 171px）并**拒绝收缩**，
> 于是 `flex: 0 0 auto` 的 `#send` 被顶出去。
> 修法：给 `#model` 加 `min-width: 0`。`#model-text` 本来就有 `min-width: 0` +
> ellipsis，所以退化成「模型名缩写」，这个代价是对的。
> 实测 140/160/200/240/380 五档，`#send` 右边缘全在视口内。
>
> **二、两个浮层菜单的 `min-width` 打赢了 `max-width`。** `#at-menu` 写
> `min-width: 200px`、`max-width: min(320px, calc(100vw - 24px))`；两者冲突时
> **CSS 判 min 赢**，所以在 200px 视口里菜单被钉在 200px 宽并挂到屏幕外
> （实测 right=208）。`#model-menu` 的 `min-width: 180px` 是同一个错。
> 修法：两处都改成 `min-width: min(<原值>, calc(100vw - 24px))` —— 保留下限，但让窗口更小时能退。
>
> **三、设置页（`extension/options.html`）此前从未被渲染、也从未被审计。** 本轮给
> `preview.mjs` 加了 `--page options`，第一次把它截出来看，就发现它仍用
> `--accent: #4d6bfe` —— 正是 v35 从面板改掉的那个值。白字压在其上约 4.1:1，
> 低于正文所需的 4.5:1；而且**同一个产品里同一个主操作有两种蓝**。已对齐为 `#4262f0`。
> 教训：把 `--page` 做成开关之前，我默认「面板 = 全部可见表面」，而设置页才是
> 用户为了粘贴令牌必须先过的那道门。
>
> **四、这一轮也修了验证工具本身（不改产品，但决定以后每轮快慢）。**
> `preview.mjs` 单次跑 21.8 秒，而实测内部工作只占 **1.8 秒**：
> `server.close()` **只停止接受新连接，不关闭已建立的 keep-alive 连接**，面板自己
> 打到这两个服务的连接就是这种，事件循环因此空转约 20 秒等它们超时。
> 加 `closeAllConnections()` 后单次 **21.8s → 2.0s**。
> 同时 `audit-all.mjs` 由串行改为并发（`--concurrency`，默认 **2**）：全量 56 次渲染
> **约 20 分钟 → 约 30 秒**。并发数特意只取 2 —— 试过 4，机器过载导致 CDP
> `Page.captureScreenshot` 超时，**审计把自身资源竞争报成了产品缺陷**。
> 另外把 CDP 超时从 20s 放宽到 60s（同一个原因），并修掉三处仪器缺陷：
> ①`main()` 的 `finally` 里 `process.exit` 会吞掉异常，把「Chrome 没起来」
> 报成 `no audit output (exit 0, 0B)` —— 异常现在显式 emit 并置 exit 1；
> ②`audit-all.mjs` 原先只在 `broken` 时非零退出，**findings > 0 竟然算成功**，
> 只是因为第一个量的视口恰好 0 findings 才没暴露；
> ③输出改为「先缓冲、结束前统一异步写一次再退出」——直接 `process.exit`
> 会截断管道里未写完的几 KB JSON（表现为约 1/3 的运行随机缺一条结果）。
> 调试端口也从 `Math.random()` 改为按 pid 分带：并发时两次抽到同号会让一个
> Chrome 去连另一个的调试端口（表现为 157 秒的运行）。
>
> **验证**：`--width 200/320/380` 三档 × 28 场景 × 深浅两配色 **全部 0 findings / 0 broken**；
> `npm test` **412 passed, exit 0**；`node --check extension/sidepanel.js` exit 0。
> 截图目视确认：200px 下模型名缩写为 `deepseek-v4-…`、发送按钮完整可见。
>
> **交付要求**：只改了 `extension/` → **重载 Chrome 扩展**即可，不需要重启 `dsh web`。

> ### v35：面板的配色与审批按钮层级（扩展侧，本次修复）
>
> **这一轮换了验证方式：不读代码，量像素。** 用 `.tmp-run/preview.mjs` 起真实
> headless Chrome 渲染**真实的 `extension/sidepanel.html`**（不是测试用的 DOM 桩
> ——那个桩没有 CSS 引擎、不渲染、截不了图），再用 `.tmp-run/audit-in-page.js`
> 在页面内量对比度、点击目标尺寸与横向溢出。
>
> **教训（本轮最重要的一条）：审计器自己会骗人。** 旧的对比度检查用正则解析
> `rgba?()`，**认不出 `oklab()`**，而面板的调色板全是 `color-mix` —— 于是每个元素
> 都解析失败并 `continue`。**此前那句「对比度 0 项」的真实含义是「什么都没测」。**
> 改用 1×1 canvas 栅格化取色后，同一份代码立刻报出浅色 164 项 / 深色 97 项。
> 仪器必须能自曝健康度：新增 `coverage` 字段（测了几个、跳了几个、几个色读不出来）。
>
> **一、配色只在深色下校准过。** 三档次要文字用一份百分比服务两种配色，
> 但 **alpha 合成在 sRGB 里线性、WCAG 对比度不是**：45% `CanvasText` 在白底 3.4:1、
> 在近黑底 4.5:1。修法：深浅各一套（深 68/52/56%，浅 74/60/64%），
> `--accent` `#4d6bfe`→`#4262f0`，`--ok`/`--bad` 改为与 `CanvasText` 混合以随配色自动加深/变亮。
> 数值留余量不贴阈值——背景是 `--lift` 压 `Canvas` 压窗口的叠层。
> 顺带：`.copy` 22px→**24px**，`.reasoning-toggle` 60×18 与 `.chip button` 19×18
> 用 `min-height: 24px` + 负 margin 补到 24×24（**布局不动**）；11px 硬编码统一到 `var(--text-xs)`。
> **一个静默失效的坑**：`pre code, .answer code { .92em }` 让 `pre` 内代码掉到 11.04px，
> 想用 `pre code { 1em }` 盖掉是没用的（`.answer code` 特异性更高），
> 必须写成两条不重叠的选择器。
>
> **二、审批卡把最宽的授权画成了主按钮。** `Allow this session` 是实心 accent，
> `Allow once` 是灰的，`Deny` 是白描边 —— **视觉顺序成了「宽授权 > 拒绝 > 最小授权」**。
> 修法是三个按钮**完全同权**：**Chrome 的 UX 团队对同问题做过测试**，一次性权限
> 最终定为垂直三按钮、无一强调（「提供更安全的结果」）；把同意界面一侧做醒目
> 是有名字的 dark pattern（asymmetric buttons）。按钮顺序不变（最窄在前）。
> 顺带加 `flex-wrap: wrap` 与 `padding: 0 10px`，让三个中文标签在 300px 宽也一行放下。
>
> **量出来的（探针，四种组合）**：三按钮 `background` 全 `rgb(18,18,18)`、高全 28px、
> 溢出全 false；仅 en@300 折行，中文不折。
>
> **验证**：26 次真实渲染审计 **0 findings**（修复前 浅164+深97）；`npm test` **412 passed**；
> `check:extension` exit 0。测试全按 `className` 取按钮，不依赖样式。
>
> **交付要求**：只改了 `extension/` → **重载 Chrome 扩展**即可，不需要重启 `dsh web`。

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
- **测试** `packages/dsh-browser-bridge/test/` —— **519 条 / 39 个 suite**，零依赖，全新克隆直接可跑

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
│  └─ test\                      run.js harness.js + 37 个 suite
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
npm test              # 519 条，39 个 suite（不需要 pnpm install）
npm run check:extension
```

Chrome 端到端是**真的**：会起 headless Chrome（`C:\Program Files\Google\Chrome\Application\chrome.exe`）跑真实 CDP —— 快照蒸馏、按 bounds 派发鼠标事件**真的触发页面 click 监听器**、`Input.insertText`、截图魔数、控制台事件。找不到 Chrome 时**跳过而非失败**。

**扩展侧的真 Chrome e2e：v66 起已经能做，而且做了。** 原文写的是「没有真 Chrome e2e 可用：Chrome 137 已移除 `--load-extension`」——那个实测对，结论推广过头了：该开关只在**稳定版渠道**被移除，Chromium 与 Chrome for Testing 一直保留。现在的分工是：

- `test/service-worker.js` + 假 `chrome`：加载**真实 `extension/background.js`**，走真 WebSocket 帧。测**帧的形状**、协议契约、徽章 API 的调用参数。快，无浏览器。
- `test/extension-host.js` + `test/real-browser.test.js`：**真实 Chromium 载入真实扩展**，扩展自己 dial 到测试进程的假宿主。测**CDP 参数在真浏览器里是否成立**——这是假 `chrome` 结构上测不到的：参数名写错、quad 读错偏移、坐标空间搞错，在假 `chrome` 下全都静默成功。

**全程 `--headless=new`**，因为套件每次运行会起若干浏览器实例，有头会在用户工作期间反复抢焦点。

`test/badge.test.js`（工具栏徽章）与 `test/tab-wire.test.js`（标签页 wire 形状）仍然走假 `chrome`，这是对的：徽章**渲染结果**读不到（浏览器 UI 绘制），只能断言传给 API 的参数。

真浏览器装置里几个实测出来的坑，写在这里免得重踩：

1. **`/json/new` 只接受 `PUT`**（三个二进制全一样，`GET` → `405`）。用 `GET` 时一个标签页都开不出来，而按 URL 去 `/json/list` 找「刚开的页面」要么超时、要么在该 URL 恰好已打开时**静默返回错误的标签页**——两种失败在全绿的测试报告里都看不见。
2. **不要按 URL 匹配标签页**。fixture 页 URL 与被操作标签页相同，`find()` 就在两个 target 之间任选。用 `chrome.debugger.getTargets()` 拿 tabId → targetId 映射，或用 `/json/new` 返回的 target id。
3. **连上 target ≠ 文档已解析**。`document.title` 会返回 `""` 且不报错。三个打开页面的方法都等 `document.readyState`。
4. **扩展 API 只在隔离世界里**（内容脚本注入的世界名 `DSH`）。在主世界读 `chrome.runtime` 得到「没有」是误判，不是没注入——上一版就是栽在这里。
5. **二进制的发现要动态**：Playwright 与 Chrome for Testing 都装进带版本号的目录，写死路径会在一台机器上碰巧命中、升级后静默全跳过。`DSH_BB_CHROMIUM` 可覆盖；给了不存在的路径返回未找到而**不回退**——拿别的浏览器冒充被要求的那个比跳过更糟。
6. **只认 Chromium / Chrome for Testing**，不认稳定版：稳定版跑起来会得到「0 条、全跳过」这种看起来健康的假象。找不到时跳过并说明原因。

两个必须记住的坑（假 `chrome` 那条路，仍然有效）：

1. **`data:` URL 按整段文本匹配，`import()` 会缓存**——两次加载必须生成不同的 URL，否则第二次拿到的是缓存模块（还持有上一次的 `chrome`，且已过监听器注册）。计数器已收进 `service-worker.js` 共享，**不要再在测试文件里自建一个从 0 开始的**。
2. **等待连接必须有超时**（`awaitConnection`）。runner 在**一个进程里跑完所有套件**，一个 suite 的 promise 永不 settle 就是整轮静默挂死——后面的测试一条都不跑，而且不像失败那样显眼。`host.connected` 是裸 promise，别直接 `await` 它。

---

## 6. 别碰的东西（已定决策，别重开）

- **站点策略**照抄 Codex 的 `browser_use` 契约：单一 `origins` 规则表（**不是**独立白名单）、四个能力位 `access`/`downloads`/`uploads`/`full_cdp_access`、最严优先、`access:deny` 级联封其余。`auto_review`/`persistent_approval`/`access_approval_lifetime` 是 managed 层专有（用户 schema 里没有，有测试锁着）
- **审批**：DSH 的 `ApprovalService.request()` 只返回一次性 `allowed-once`，没有「始终允许」。四个选项（Allow once / Allow for this site / Allow for all sites / Decline）是在 `lib/grants.js` 层实现的，**README 里如实写了，不要伪造「始终允许」按钮**
- `turn` 时长用「5 分钟无浏览器活动」近似（turn 边界在工具上下文里不可观测），误差方向**偏向重新询问**
- `browser_history`/`browser_eval`/`browser_cdp`/`browser_upload` **每次都重新问**
- `browser_eval`+`browser_cdp` 需要 `developerMode`（默认 false）；CDP 永久拒绝 `Browser, Target, Storage, SystemInfo, Cast, Extensions, ServiceWorker, WebAuthn`（**两端都查**）
- **上下文附件不在选区产生时注入**：选区变成待发附件 + composer 里可移除的 chip；在会话的 `user/message` 事件（且 `event.data.source.kind === 'user'`）上注入 `createUserMessage({... source:{kind:'plugin', plugin:'browser-bridge', form:'notice', summary: boundContextSummary(...)}})`，落在**同一个 pre-step**，不改写用户原话。`contextAutoPush` 默认 **false**
- 传输：单条环回 WS `/api/browser-bridge/ws`；令牌（query 参数优先于 `Sec-WebSocket-Protocol: dsh-bridge-token.<t>`）+ `Origin` 必须是 `chrome-extension://<32 个 a-p 字符>`（存在时）+ 绑定更宽时的环回 peer 检查。令牌在 `$DSH_HOME/storages/dsh-browser-bridge.json`（`timingSafeEqual` 比较，原子写且**失败时清理临时文件**——临时文件里是明文，v56 修的）。**注意 `mode: 0o600` 在 Windows 上被忽略**（实测 `100666`），那里的保护来自用户目录继承的 ACL（只有 SYSTEM/Administrators/本人），不是 mode —— 不要把它当成唯一防线
- **请求方向只有一条**（扩展→宿主），宿主从不回调扩展。聊天走 HTTP 路由而非反向 RPC，让浏览器半边保持纯执行器
- 侧栏会话由**用户选择**，不猜 —— 「最近活跃」会偶尔把提示词投进用户没在看的会话
- **标签页行必须带 `windowFocused`**（v43）。Chrome 的 `active` 是**每个窗口各一个**，所以「用户在看哪个标签页」不能靠 `tabs.find(tab => tab.active)` 回答——那只是列表顺序。该字段是**三态**：`true`/`false`/`undefined`（问不到）。**不要用 `false` 代替 `undefined`**，那是在断言一件不知道的事；也不要把它简化成布尔。宿主侧取用一律走 `lib/page-tools.js` 的 `activeTabOf()`，它会一并给出依据 `via`，答不上来时正文要**明说是猜的**
- 扩展侧 `getLastFocused` 失败**必须容忍**（返回 `undefined` 而不是抛错）：一个拿不到窗口信息的浏览器应该退化成旧行为，而不是让标签页列表整个不可用。manifest 里**没有也不需要** `windows` 权限

---

## 7. README 里已有的诚实边界（别删）

- auto-review 的**独立 reviewer agent 未实现**（需要第二条模型路由 + 断路器），只做了 `autoReview` 开关的语义等价物
- 多浏览器（Edge/Brave/Opera/Vivaldi）、内建浏览器、书签、云浏览器/手动接管：均未实现
- 元素高亮与「正在被控制」提示：**v40/v41 已实现**（`Overlay` 域浮层 + 925ms dwell + 工具栏徽章；徽章按 tab 设置，`chrome.debugger.onDetach` 也会撤下）
- 未确证：`allowed-once` → 「该站点本会话免问」的映射；5 分钟 turn 近似；chip 的确切视觉、发送后是否留存、`@` 提及标签页的交互细节（上游无文档）
- 官方文档自身矛盾：内建浏览器是否支持登录（`browser.md` 说不支持，`chrome-extension.md` 说支持）

---

## 8. 立即上手

```powershell
git clone https://github.com/LessXi/dsh-browser-bridge.git
cd dsh-browser-bridge

# 1. 不需要任何安装。测试是零依赖的自建 runner。
npm test                 # 519 条，39 个 suite
npm run check:extension  # 10 个扩展脚本的语法预检

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
