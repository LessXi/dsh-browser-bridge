# 交接工作单：DSH 浏览器桥接插件（v3 还原度修补）

> ⚠️ **v5 已完成（本轮）：划词附件修复。** 现行状态见这一段，v4/v3 内容仅作历史参考。
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
>    `session-…-…` 的两条附件（`kind:'tab'` 空正文 +
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
> 读回该会话（`session-…-…`）的**原始输出**确认：模型给的是
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

第 1 条**已经改了一大半**（见 §4）。第 2、3、4 条**完全没动**。

---

## 1. 这个项目是什么

让 DSH 网页会话能操作**用户已登录的真实 Chrome**（对齐 OpenAI Codex 的 Chrome 扩展），并且把网页上选中的内容作为**可见、可移除**的上下文附件交给模型。

三件套：
- **宿主插件** `packages/dsh-browser-bridge/` —— WebSocket 桥接、`browser_*` 工具、站点策略与审批、上下文附件、浏览器端 UI
- **Chrome 扩展** `extension/` —— MV3，纯 JS，无构建；CDP 执行器 + 右键菜单 + 选区上报 + 侧栏面板
- **测试** `packages/dsh-browser-bridge/test/` —— 127 条，全绿

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
│  │  └─ client.js               ★ 浏览器端 UI（v3 正在改这里）
│  └─ test\                      run.js harness.js + 9 个 suite
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

`%APPDATA%\npm\node_modules\@deepseek-ai\dsh`，版本 **0.1.5-rc.1**。peer 依赖在它内嵌的 `node_modules` 里。

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

## 4. 已完成 vs 待办

### 4.1 已完成（v3 第 1 步的一半）

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

**⚠️ 这些改动尚未验证**（改完还没跑过解析检查和测试）。

### 4.2 待办 —— v3 第 1 步收尾

```powershell
cd <repo>
node $env:TEMP\clientcheck.mjs    # 若无此文件，见 §5.1 自建
npm test
npm run check:extension
```

若 `clientcheck.mjs` 不存在，按 §5.1 重建。**先验证，再动第 2 步。**

还要肉眼确认（只有用户能做）：刷新 DSH 页面后，设置 → 插件里 `browser-bridge` 卡片应与其余四张**视觉一致**（圆角、边框、字号、箭头图标、展开行为）。

### 4.3 待办 —— v3 第 2 步：侧栏重做（用户意见 2、3）

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

### 4.4 待办 —— v3 第 3 步：冷会话（缺口 4）

改 `packages/dsh-browser-bridge/lib/chat.js`：

- `readMessages(sessionId, limit)` 改为 **async**，优先级：`ctx.sessions.get(id)` → `deriveMessages()`；否则走 `commands.readSessionState(id)` 的 `events`（**复用宿主自己的规则，不要自己解析事件**）
- 标题：优先 `readSessionState(id).header.title`；为空时回落**该会话第一条用户消息的前若干字**（比裸 id 有用得多）
- **成本控制（必须做）**：`listSessions()` 继续只用 `sessionQuery` 的廉价记录（id + updatedAt）**不解标题**；标题**只对当前选中的那个会话懒解析**，并按 id 在面板生命周期内缓存。否则面板每次轮询都会回放全部会话日志
- `lib/index.js` 的 `/browser-bridge/chat` POST 分支相应改成 `await chat.readMessages(...)`（该 handler 已经是 async）

`lib/chat.js` 现状：`createChat({sessions, query, commands})` 返回 `listSessions()`（sessionQuery 优先、活会话合并）、`readMessages()`（**只读活会话 —— 就是要修的地方**）、`send()`（调 `commands.prompt({requestId: crypto.randomUUID(), sessionId, mode:'queue', content:[{type:'text', text}]})`）。

> `send` **绝不自己拼 UserMessage** —— 消息来源类型是会话日志和压缩器认识的东西，手造会让「谁说了什么」的审计记录失真。

### 4.5 待办 —— v3 第 4 步：测试与验证

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
const close = src.lastIndexOf('},\n})');
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
npm test              # 127 条，9 个 suite
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
cd <repo>

# 1. 验证上一轮未验证的改动
node $env:TEMP\clientcheck.mjs          # 若无，见 §5.1
npm test
npm run check:extension

# 2. 起探针（用户线上实例在 3080，不要动）
dsh web --port 3199 --no-open           # 用受管后台 job

# 3. 按 §4.3 → §4.4 → §4.5 顺序做
```

**顺序建议**：先确认 §4.2 的卡片视觉（需要用户刷新确认），再做 §4.3 侧栏（用户意见 2、3），最后 §4.4 冷会话 + §4.5 验证。

用户会用截图验收，所以**每一步先验证再交付**，不要声称未验证的东西能用。
