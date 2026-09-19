# DSH Browser Bridge

让 DSH 网页会话能够操作你**已登录的真实 Chrome**：读页面、点击、输入、截图、上传文件，
并把网页上选中的内容作为**可见、可移除**的上下文附件交给模型——能力和 OpenAI Codex 的
浏览器扩展对齐，安全策略按 Codex 的 `browser_use` 契约设计。

```
┌─────────────────┐   WebSocket (token + extension origin)   ┌──────────────────┐
│  DSH web host   │ ◄───────────────────────────────────────► │ Chrome extension │
│  browser-bridge │                                           │  MV3 service     │
│  plugin         │        browser_* tools → ctx.tools        │  worker          │
└─────────────────┘                                           └────────┬─────────┘
        ▲                                                              │ chrome.debugger
        │ chips / status (same-origin HTTP)                            ▼
┌─────────────────┐                                           ┌──────────────────┐
│  DSH web GUI    │                                           │  Your Chrome     │
│  composer chips │                                           │  (signed in)     │
└─────────────────┘                                           └──────────────────┘
```

---

## ⚠️ 先读这一段

这个扩展申请了 Chrome 的 **`debugger` 权限**。这等同于**能读写你在所有网站上的数据，包括
已登录的会话**。装上它之后，只要有令牌的人（也就是这台机器上的 DSH）就能操作你登录的任何站点。

缓解措施，以及它们各自的边界：

| 措施 | 作用 | 不覆盖什么 |
|---|---|---|
| 令牌 + 扩展 Origin 校验 | 网页无法连上桥接端口（防 CSRF / DNS rebinding） | 本机上能读到令牌文件的进程 |
| 每个新域名首次审批 | 模型不能悄悄访问新站点 | 你在审批里点了「始终允许」之后不设防 |
| 敏感动作二次确认 | 提交表单/下单/删除会再问一次 | 靠文本关键词识别，可能漏判或误判 |
| 网页内容标注为不可信 | 降低提示注入的影响 | 不能消除注入 |
| `enabled: false` 一键关闭 | 立刻停掉整个桥接 | — |

**不做的事**：不读取浏览历史（除非你显式调用 `browser_history`，且每次都问）、不采集请求头或
响应体、不向任何外部服务上传任何数据。

---

## 安装

### 1. 载入扩展

Chrome **无法自动安装未发布到商店的扩展**，这一步必须你手动做一次：

1. 打开 `chrome://extensions`
2. 右上角打开**开发者模式**
3. 点**加载已解压的扩展程序**，选择本仓库的 `extension/` 目录

### 2. 安装插件到 profile

```powershell
dsh plugin --profile web add file:<本仓库路径>\packages\dsh-browser-bridge
```

这条命令会转发给 pnpm，并在成功后把 `dsh-browser-bridge` 追加进
`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`。用编辑器打开那个文件确认一下。

如果 pnpm 提示该包没有 `dsh.bundle` 而拒绝入栈，就手工把 `dsh-browser-bridge` 加到
`bundles` 数组末尾——这一步本身是幂等的。

### 3. 重启 dsh web

profile 的 patch 层是**启动时读入的静态层**，所以改完 bundles 必须重启 `dsh web`（`patchReload: live`
只覆盖运行时的 patch 变更，不覆盖 bundles 列表）。

### 4. 填令牌

1. 刷新 DSH 页面，打开 **设置 → 插件 → browser-bridge**
2. 点侧栏底部的浏览器状态点 → **Copy**，复制令牌
3. 打开扩展的选项页（`chrome://extensions` → 详情 → 扩展程序选项）
4. 粘贴令牌，端口填 DSH 地址里的端口（默认 3080），点**保存并连接**

状态点变绿即接通。

---

## 用法

### 让模型操作浏览器

直接在对话里说，模型会自己调用工具：

> 打开 example.com，读出页面标题和主要导航项

> 在这个页面上找到搜索框，输入 "dsh"，然后提交

### 把选中内容变成上下文

**只有当前选中的内容会进上下文，而且你能在发送前删掉它。**

1. 在任意网页上**划选一段文字**
2. 右键 → **Add selection to DSH context**（或从侧边栏点「Add selection to context」）
3. 回到 DSH，输入框上方出现一个 chip：`github.com · selected text · 1.2k chars ×`
4. 想在发送前撤销就点 `×`
5. 发消息时，附件随这条消息进入模型上下文，chip 消失

右键菜单还有：

| 菜单项 | 作用 |
|---|---|
| Add selection to DSH context | 把选中的文字作为附件 |
| Add this page to DSH context | 把整页可读文本作为附件——**但仅限本会话已被允许读取该站点的情形**，见下 |
| Add this tab to DSH context | 把标签页身份（标题+URL）作为附件 |
| Sync selections automatically | 扩展侧的开关；**宿主侧还要打开 `contextAutoPush`** 才会真的进上下文，两个开关默认都是关 |

**默认关闭自动同步是有意的**：划词是高频动作（复制、搜索都会划），全自动会把上下文塞满。两个开关是「一个管离开浏览器、一个管进入 harness」，都要开。

关于「Add this page」：整页正文是一次**读取**，而读取要走站点审批，审批需要一个 agent 来承接这个提问——右键点击没有 agent。所以只有当本会话**已经**被允许读取该站点时，这一项才附上正文；否则它退化成标签页身份（标题+URL），正文不读。想读正文，让模型用 `browser_read`，那条路有 agent 可以问你。

### 侧边栏

点扩展图标打开侧边面板。它是**聊天面板**，不是状态读数：

- **头部只有两个控件**：会话标题（点开是会话列表）+ `＋`（在当前工作区新建会话）。**没有常驻状态文字**——连接出问题时它显示在它真正影响的地方（输入区的附带 chip），而不是在标题栏常年挂一个红点
- **会话列表**：按工作区分组，组内按最近活动降序。数据来自 `sessionController.list()`，**和 DSH 自己的侧栏是同一个调用**，所以两边不会不同步；已归档的、子代理的会话都不出现，没说过话的空会话也不出现（当前选中的那个除外，否则刚新建就消失了）。每行显示真实标题 + 相对时间，运行中的会话带一个绿点
- **中间**：所选会话的对话记录。**只显示人说过的话和模型的回答**：系统提示、技能目录、注入的上下文、turn/step 边界、工具结果一律不出现。思考过程折成一行「思考 ⌄」，工具调用折成一行 `` pwsh · npm test``，连续同名调用合并成 `` pwsh · 3``
- **输入区**：`Enter` 发送，`Shift+Enter` 换行；上方一行 chip 显示本次发送会附带什么（当前标签页始终附带；页面上的选区在划选后出现，可以点 `×` 单独去掉）。**草稿按会话分开**，切来切去不会串
- **滚动**：只有当你本来就在底部 24px 以内（或者刚发送）时才会跟随新内容；上翻看历史时，8 秒一次的轮询不会把你拽回去。不在底部时右下角出现「回到底部」按钮
- **模型与推理强度**：输入框下方控制条的左侧是当前会话的模型，显示成 `模型名 · 推理强度`——**没有「模型」二字**，因为原版把它那个类别名用 `display:none` 藏着。点开是一个弹层：顶部一排推理强度，下面按 provider 分组的模型列表，右侧 `✓` 标出当前项。**选择属于会话**：A 会话换成 `deepseek-v4-pro` 不影响 B 会话，也不需要和 DSH 主界面做任何同步——两边读的是同一份会话投影（详见 v7）

界面语言跟随浏览器 UI 语言（`zh*` → 中文，其余 → 英文）。

**逐字流式输出**：模型一边写，侧边栏一边显示。宿主把 agent 自己的 stream 帧（`agent/assistant-stream`）合并成 80ms 一批的通知，经**同一条** websocket 推给扩展，由 service worker 转给面板——**这是这条线上第一个「宿主主动开口」的消息**，请求有 `id`、扩展事件有 `event`，通知用第三个键 `notify`，所以扩展不必猜收到的帧是哪种。

面板把流式内容画成**纯文本 + 光标**，不解析 markdown：半张表格或半个代码围栏每帧都会解析成不同的东西。attempt 一 settle，面板就重读会话记录，用**真正解析过的行替换**流式块——所以它不会变成第二行，也不会和正式回复并排。等待行（`正在工作` 那条扫光）跟随宿主的 `running` 标志，attempt 结束时会立刻重读一次，而不是等 5 秒轮询。

没连接扩展时通知直接丢弃、不排队（计数在 `contextDiagnostics` 旁边的 `stream` 里）：记录永远可以重读，半个 token 流不行。

自动同步开关**不在侧边栏**——它属于扩展选项页，侧边栏再放一个就是同一个开关的第二个副本。

---

## 工具

模型可见的工具，全部以 `browser_` 开头。

| 工具 | 能力位 | 说明 |
|---|---|---|
| `browser_status` | — | 连接状态、Chrome 版本、受控标签页数；连不上时给出可执行的排错步骤 |
| `browser_tabs` | — | 列出所有标签页，包括你自己开的 |
| `browser_open` | access | 打开 URL，默认归入 DSH 标签组 |
| `browser_select_tab` | access | 选定标签页，并可纳入本会话 |
| `browser_release_tab` | — | 把标签页交还给你（不关闭） |
| `browser_close_tab` | access | 关闭标签页；**你自己开的需要显式 `force` 才关** |
| `browser_navigate` | access | 跳转 / 后退 / 前进 / 刷新 |
| `browser_snapshot` | access | **首选**：结构化元素列表（role、name、bounds、index） |
| `browser_read` | access | 页面可读正文 + 链接 |
| `browser_screenshot` | access | 截图，作为图片进入对话 |
| `browser_click` | access | 按 snapshot index 或 CSS 选择器点击 |
| `browser_type` | access | 输入文本，可清空、可回车提交 |
| `browser_press` | access | 按键或组合键 |
| `browser_scroll` | access | 滚动或把元素滚入视野 |
| `browser_fill` | access | 直接设表单值（绕开忽略合成键的页面） |
| `browser_wait_for` | access | 等选择器或文本出现 |
| `browser_console` | access | 控制台与未捕获异常 |
| `browser_network` | access | 网络请求（不含头与正文） |
| `browser_upload` | **uploads** | 上传文件；每次都要审批 |
| `browser_history` | — | 搜索浏览历史；**每次都问，没有常驻授权** |
| `browser_eval` | **full_cdp_access** | 在页面里跑 JS；需 Developer mode，每次都要审批 |
| `browser_cdp` | **full_cdp_access** | 原始 CDP 命令；需 Developer mode，每次都要审批 |
| `browser_context` | — | 查看/移除/清空已暂存的附件 |
| `browser_selection` | — | 当前活动标签页信息，引导用 `browser_context` |

`browser_cdp` 与 `browser_eval` 走 Developer mode 通道，`Browser`、`Target`、`Storage`、
`SystemInfo`、`Extensions`、`ServiceWorker`、`WebAuthn`、`Cast` 八个域**永久拒绝**：
它们能触及其他标签页、其他配置文件和已存凭据，超出「看这个页面」的授权范围。

---

## 站点策略

策略模型照抄 Codex 的 `browser_use` 契约（`codex-rs/config/src/browser_use.rs`）：
**一张规则表 + 四个能力位 + 最严优先合并**。

### 审批的四个选项

每个新域名第一次被访问时，DSH 会弹审批：

| 选项 | 效果 |
|---|---|
| Allow once | 只这次 |
| Allow for this site | 本会话内该站点不再问（`thread`，Codex 的默认值） |
| Allow for all sites | 兜底策略改为 allow（受 `allowGlobalPersistentApproval` 约束） |
| Decline | 拒绝；**不会**自动把域名加进黑名单 |

`browser_history`、`browser_eval`、`browser_cdp`、`browser_upload` **永远重新问**，不受上面的授权影响。

### 规则表

设置里 `origins` 是一个 map，键是 origin 模式，值是能力字段：

```yaml
origins:
  "https://**.example.com":      # 主域 + 所有子域
    access: allow
  "https://admin.example.com":   # 更窄的规则
    access: deny                 # 同时封掉 uploads / downloads / full_cdp_access
  "http://localhost:5173":
    access: allow
    uploads: deny
```

- 键格式：`<scheme>://<host-pattern>[:port]`，只支持 `http` / `https`
- 通配：`*.example.com` 只匹配子域；`**.example.com` 匹配主域和所有子域；
  其他 `*` 可跨点，所以 `region*.example.com` 也匹配 `region.api.example.com`
- 多条规则命中时**取最严**：`deny` 赢、`false` 赢、`turn` 赢
- `access: deny` 会级联封掉 uploads、downloads、full CDP，并关闭自动复核

---

## 设置

`设置 → 插件 → browser-bridge`：

| 设置 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 关掉后所有 `browser_*` 工具立即拒绝 |
| `developerMode` | **false** | 开启 `browser_eval` / `browser_cdp` |
| `confirmSensitiveActions` | true | 提交/下单/删除等再问一次 |
| `origins` / `defaultOriginPolicy` | `{}` | 上面的规则表 |
| `allowHistoryAccess` | true | 关掉后 `browser_history` 直接拒绝 |
| `contextAutoPush` | **false** | 划词即时同步 |
| `contextMaxChars` | 10000 | 单条附件上限 |
| `contextPendingLimit` | 50 | 每会话暂存上限，超出丢最旧 |
| `contextTargetSessionId` | `""` | 附件投递目标；空表示跟随最近操作浏览器的会话 |
| `actionTimeoutMs` | 30000 | 单个浏览器动作超时 |
| `pageTextMaxBytes` | 200000 | 单次读取返回的页面上限 |
| `consoleBufferSize` / `networkBufferSize` | 500 | 环形缓冲条数 |
| `screenshotMaxWidth` | 1280 | 截图长边 |

以下三个是 **managed 层**（`browser-bridge-managed`），用户设置里故意不存在——
它们是部署方的天花板，用户只能收紧不能放宽：

`autoReview`、`persistentApproval`、`allowGlobalPersistentApproval`、`accessApprovalLifetime`。

---

## 文件上传

Chrome 需要你在**扩展详情页**手动打开 **「允许访问文件网址」**。扩展没法自己申请这个权限，
`browser_upload` 在没开时会失败并提示你这一步。

---

## 测试

```powershell
npm test                          # 全部 426 条
npm run check:extension           # 扩展脚本语法检查（Chrome 加载前的预检）
```

测试分四层：

| 层次 | 覆盖 |
|---|---|
| 纯逻辑单测 | 策略引擎（规则匹配、通配符、最严合并、级联）、授权表（turn/thread 过期、能力继承）、上下文附件（去重、上限、**发送前不注入**、冷会话保留、持久化与恢复）、鉴权（令牌、Origin、环回）、CDP 域黑名单、**侧边栏面板**（事件到行的语义映射、会话列表过滤与分组、Markdown 子集解析与链接安全、面板文案与滚动策略的静态断言） |
| 桥接协议单测 | RPC 请求关联、超时、取消、坏帧不致命、**断连时所有 in-flight 调用结算为错误** |
| 桥接端到端 | 真实 HTTP server + 真实 WebSocket：401/403 拒绝、握手、双向帧、事件推送、扩展消失时快速失败、扩展文件清单与协议方法覆盖 |
| Chrome 端到端 | 真实 headless Chrome + 真实 CDP：`DOMSnapshot` 蒸馏、按 bounds 模拟点击真的落到元素上、`Input.insertText` 触发 input 事件、截图是真图、控制台事件 |

### 依赖是怎么解析的（重要）

这个包**不打包任何依赖**。`lib/deps.js` 在运行时分两路解析：

1. 普通 specifier（本仓库跑过 `pnpm install` 时命中）；
2. 否则从 `$DSH_HOME/profiles/node_modules` 解析——这就是运行中的 DSH 解析插件的方式。

所以从 profile 加载时永远能工作，即使本仓库没有任何 `node_modules`。

代价是：**编辑器跳转/补全需要后者可达**——但**跑测试不需要装任何东西**：

```powershell
# 推荐：什么都不装。测试是零依赖的自建 runner（自建 harness，不用 node --test）。
npm test                 # 426 条
npm run check:extension

# 只在想要编辑器跳转时，才把 profile 的模块树接到本包上（Windows 目录联接）
cmd /c mklink /J packages\dsh-browser-bridge\node_modules "$env:USERPROFILE\.dsh\profiles\node_modules"
```

⚠️ **不要用 `pnpm install` 来「装依赖」，它装不到。** 本仓库没有 lockfile，根 `package.json`
没有 `dependencies`，而 `pnpm-workspace.yaml` 里 `autoInstallPeers: false`，peer 只声明在
`packages/dsh-browser-bridge/package.json` 的 `peerDependencies` 里——所以 `pnpm install`
不会把 `@deepseek-ai/*` 拉下来。宿主库由 `lib/deps.js` 在运行时从
`$DSH_HOME/profiles/node_modules` 解析。

**实测**：全新 `git clone`（零 `node_modules`）→ `npm test` **426 passing, 0 failing, 0 skipped**，
`npm run check:extension` exit 0。前提是这台机器上装过 DSH（宿主库要能解析到）。

**验证环境**：Node **v24.15.0**。两个 `package.json` 里的 `engines.node: ">=20"` 是**保守下限**，
没有跑过版本矩阵——别把它当成已测试过的兼容性声明。仓库也没有 lockfile 和 CI。

`packages/*/node_modules/` 已在 `.gitignore` 里——它只是本地便利，不是产物。

> 沙箱环境注意：`node --test` 会为每个文件 fork 子进程并走管道捕获输出，某些沙箱禁止建管道，
> 会以 `spawn EPERM` 在跑任何断言前失败。所以这里的测试装置是自带的、单进程、零依赖的
> （`test/harness.js`），`npm test` 在任何环境都能跑。

---

## 诚实的能力边界

### 已验证 / 未验证

**已自动化验证**：上面四层测试，426 条。包括真实 Chrome 驱动的快照、点击、输入、截图。

侧边栏那部分还有一组**静态**检查，防止语言和版式漂回去：两个字典的键必须完全一致、面板里每个
`t('…')` 的键都必须存在、HTML 里不允许残留裸文案、旧版文案一个都不许出现、**字典里不允许出现整句
话**（标签最长 6 个词，且不许有句号）、面板引用的每个元素 id 必须真的存在于 HTML、以及滚动策略的两个
分支必须在代码里（`NEAR_BOTTOM_PX = 24` 与「不在底部就恢复原位」）。

**未自动化验证，需要你手工确认一次**：
装载扩展本身。Chrome 不允许脚本安装未发布扩展，所以下面这几条只能你在
`chrome://extensions` 操作后观察：

- [ ] 扩展能载入且无报错（`chrome://extensions` 上无红色错误）
- [ ] 选项页填入令牌后「测试连接」通过
- [ ] 划词 → 右键菜单出现四项 → 点「Add selection」→ DSH 里出现 chip
- [ ] chip 点 `×` 能删掉，且再发消息时该内容**没有**进入上下文
- [ ] 新域名首次操作时 DSH 弹出审批
- [ ] 侧边栏点标题能打开会话列表，**标题是中文的真名而不是乱码或 UUID**
- [ ] 点 `＋` 能新建会话并落到当前工作区
- [ ] 侧边栏选一个**冷会话**（刚重启 dsh 后没打开过的），记录应当出现而不是空白
- [ ] 发一条消息后**只出现人说过的话和模型的回答**，没有系统提示、没有 `[tool-result]`
- [ ] 上翻看历史时，8 秒轮询不会把视图拽到底部
- [ ] 从侧边栏发一条消息，确认模型收到并回复
- [ ] **让模型截一张图**（`browser_screenshot`），确认它真的**看到了画面**，而不是只知道「截过了」。
      块形状与附件引用已由测试锁定（v8），但「一张真截图能通过附件服务的准入」这一步只能在装着
      provider 凭据的宿主上才能看到——探针实例没有凭据，跑不出模型回合

### 探针实例上已跑通的部分

用一个独立实例（`dsh web --port 3199 --no-open`，不碰你的 3080）实测：

| 检查 | 结果 |
|---|---|
| `GET /browser-bridge/chat` | 3 个分组（两个具名工作区 + 未分组），**0 条 `[tool-result]`、0 条裸 UUID、0 条归档会话** |
| 会话与 DSH 同步 | 与 DSH 侧栏同一个调用 `sessionController.list()` + 同一份 `archivedSessionIds`；归档 13 条、子代理会话全部不出现 |
| `POST {action:'messages'}`（`session-…`） | **8 行**：`user / reasoning×3 / tool×3 / assistant`，与该会话日志里的 34 个事件逐一对上。系统提示、技能目录、`tool/result`、turn/step 边界全部不产出。修复前这里是整段系统提示 |
| 同一会话的标题 | `11`（来自 header）；列表里的标题走 `projections.values.title` |
| `POST {action:'create'}` | `{created:true, sessionId:…}`，新会话落进指定工作区分组 |
| 新会话的 `messages` | **0 行**（空会话就是空的，不再拿 id 或 `lastMessage` 充当内容） |
| `POST {action:'send'}` | **HTTP 200 `accepted:true`**，`context.staged` 按附件数计 |
| 消息是否真的到达模型 | 到达会话日志：`turn/start` → 构建 `request/header`（含完整工具表）→ 调用 provider |
| **附件真的进了上下文**（v5 修复） | 会话日志里 `agent/inbox/spliced` 落在 `request/context` **之前**（seq 4–5 vs seq 18），附件随后变成 `surfaceOp:"append"` 的真实 `user/message`；面板读回 `kind=context` 行；一次发送两个附件（划词 + 标签页）`staged:2` 且两条都在 |
| `POST {action:'models'}`（v7） | 真实目录：`[deepseek-official] DeepSeek` 4 个模型（`deepseek-flash` / `deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-v4-flash-vision-exp`），默认 `deepseek-flash · max`，无 `failures`；每个模型 4 档强度 `off/low/high/max`（默认 `high`） |
| **模型选择属于会话**（v7） | 在探针新建的会话上切到 `deepseek-v4-pro` → `{"selected":{"provider":"deepseek-official","model":"deepseek-v4-pro","reasoningEffort":"high"}}`（宿主自己补上了该模型的默认强度）；**同一份列表里其它每个会话的 `model` 字段一个都没变** |
| 切换正被另一个实例持有的会话（v7） | 探针去 resume 你的 3080 正持有的会话时被拒：`SessionAlreadyOwnedError: session "…" is already owned by an active write handle`。这是**两个实例并存**才有的情况——面板连的就是持有会话的那个宿主，正常使用遇不到 |
| 非法推理强度（v7） | `reasoningEffort:"turbo"` → `{selected:false, reason:"provider \"deepseek-official\" model \"deepseek-v4-pro\" does not support reasoning effort \"turbo\""}`，面板显示成 `切换失败：<原因>` |
| **宿主加载了流式中继**（v9） | 插件树正常加载（`ctx.on('agent/assistant-stream', …)` 没有报错），`GET /browser-bridge/health` 里出现 `stream:{frames,ignored,flushes,notifications,dropped,ends,buffered}` 全 0 |

最后一步在探针上报错 `llm-deepseek: no API key for provider route "deepseek-official"`——
**这是探针进程拿不到凭据，不是插件缺陷**。已核对 `$DSH_HOME/.credentials.yaml`：里面只有一条
`client-connection/browser-session`（DSH web 客户端自己的会话凭据），**没有任何 provider key**；
你的 3080 实例的 key 只活在那个进程的环境里，第二个实例不会继承。
所以「模型真的回复」这一条要在**你自己的实例**上看：重启 `dsh web` 让新代码生效，再从侧栏发一条。

**流式输出因此也没能在探针上跑完整条链**：没有 provider 凭据就没有 assistant attempt，
`agent/assistant-stream` 一帧都不会发。探针能证明的是中继**装上了**（`stream` 计数全 0 且不报错）；
「宿主聚合 → 走 `notify` → service worker 转给面板 → 面板逐字画出来」这一段由
`test/stream.test.js`（真 socket 上的帧形状）+ `test/panel-stream.test.js`（真跑面板模块）分段覆盖，
**中间那一跳（Chrome 的 `chrome.runtime.sendMessage`）只做了结构断言，没有在真 Chrome 里点过**。

#### v38：三个不同的问题，长得一模一样（本次修复）

**症状**：扩展没连上宿主时，面板只在 chip 上写一个红色的「未连接」。

**为什么这是缺陷**：这一个词同时代表**三件完全不同的事**，而三件事的解法**互不相同**：

| 真实原因 | 怎么解决 |
|---|---|
| 从没填过令牌 | 去设置页粘贴令牌 |
| `dsh web` 没在跑 | 启动 `dsh web` |
| service worker 还没醒 | 等一秒 |

三者在屏幕上**完全一样**，用户只能猜。而「填令牌」还是唯一一个**用户必须自己去做、
别的地方都不知道**的状态 —— 扩展其实一直知道（`background.js` 里 `lastError = 'no token saved'`），
**只是从来没告诉过面板**。

**修法：宿主说「是不是」，worker 说「为什么」，面板说人话**
- `extension/background.js` 新增 `bridgeState()`，返回**代码**而不是句子：
  `{ open, connecting, reason: 'no-token' | 'connecting' | 'refused', detail, version }` ——
  措辞属于知道读者语言的那一面（面板），不属于 worker。
- 新增两条面板→worker 消息：`dsh-bridge-state`（问）与 `dsh-bridge-retry`（让它现在就连）。
  **面板自己开不了这个 socket** —— socket 属于 worker，所以面板只能请求，不能重连。
- `extension/sidepanel.js` 的 chip 变成**按钮**，写「没填令牌」或「未连接」，点一下就让 worker 重连；
  `no-token` 时直接 `openOptionsPage()` —— 这是唯一一个**有真实去处**的分支。
  chip 与站点 chip **并列出现**（「哪个页面在前」和「桥接通没通」是两件事），
  **只在宿主可达时才显示**（宿主不可达已有整块的状态面 + 重试按钮，一个问题上两个重试按钮更糟）。

**顺带修掉一个真的会卡死的分支**：`connect()` 在「没令牌」时**直接 `return`** ——
它不仅不重连，还**不挂 keepalive 闹钟**，所以 worker 可能在用户去填令牌之前就被回收，
**面板的重试按钮将没有任何东西可以应答它**。现在也走 `scheduleReconnect()`。

**测试**：`npm test` **426 passed / 0 failed**；`check:extension` exit 0。
- 面板新增 2 条（离线时 chip 说出原因、点击后确实发了 `dsh-bridge-retry` 且打开了设置页；
  只是「唤醒中」时不谎报成令牌问题、连上后 chip 消失）。
- 扩展侧新增 2 条静态断言（两条消息存在、`bridgeState()` 是唯一的裁决点、三个代码都在；
  没令牌的分支必须 `scheduleReconnect()`）。
- **夹具新增**：`host.bridgeConnected` / `host.bridgeState` / `host.runtimeMessages` / `host.openedOptions`。
  **此前 `sendMessage` 恒返回 `{}`、`openOptionsPage` 是个空函数，所以这两条路径根本不可测**。
  `bridgeConnected` 与 `bridgeState` **故意分开**：宿主只知道「是否连上」，worker 才知道「为什么」，
  合成一个字段就表达不出「连着但 worker 说自己没令牌」这个状态。

**证伪三次**：worker 不再应答 `dsh-bridge-state` → 1 红；
没令牌时不挂重连 → 1 红；chip 退回只说「未连接」 → 2 红（含死键检查）。

**交付要求**：只改 `extension/` → **重载 Chrome 扩展**即可，不需要重启 `dsh web`。

#### v37：量了一遍 7000 行会话的性能 —— **没有找到缺陷**（无代码改动）

v33 让长会话可以被往回读，但 `depth` 会一直涨。这轮把「涨到 7000 行时还跑得动吗」
**量了**，而不是猜：

**宿主读一次的成本**（用户线上 3080，会话 `session-44c33409`，**只读 GET/POST，未触碰**）：

| 请求 | 返回行数 | 最小 | 中位 | 最大 |
|---|---|---|---|---|
| `limit: 60` | 60 | 23.7ms | 25.6ms | 68.6ms |
| `limit: 1000` | 1000 | 33.5ms | 36.2ms | 38.8ms |
| `limit: 20000` | 7510 | 157.4ms | 168.1ms | 201.0ms |

⇒ **翻到最开头是 ~170ms/次**，而不是每次轮询都付：只有点「更早的内容」时才付一次。
（探针上 12 行的会话，1/4/12/60 行一律 ~2ms —— 说明成本在**日志回放**，不在切片。）

**面板侧的成本**：

| 项 | 规模 | 耗时 |
|---|---|---|
| `JSON.stringify(rows)`（每次轮询的签名比较） | 6969 行 / 487KB | **1.3ms** |
| `parseMarkdown(一条回答)` | 512KB / 21624 块 | **9.1ms** |

⇒ **两处都不是瓶颈**，而且 `drawTranscript` 只在签名变化时才碰 DOM。
**结论：不为此改代码。** 记录在此，避免下一轮重复测。

（顺带确认一个**没有**加剪裁的地方：助手回答的正文**不裁剪**——一个 400KB 的
`text` 块会原样到达面板。上面 9.1ms 就是它的真实代价，所以在可预见的规模内不需要上限。
工具行、失败信息、标题、上下文标签**都是裁剪过的**，只有回答正文不是。）

#### v36：一个「拒绝」带着授权时长回来了（本次修复）

**怎么发现的**：v34/v35 把「按钮说的话 = 实际发生的事」当作不变量之后，
我把这条不变量拿到**协议边界**上再试了一次 —— 直接给中继发一个带 `scope` 的拒绝：

```
relay.answer(id, 'rejected', 'conversation')
-> {"answered":true,"outcome":"rejected","scope":"conversation"}
scopeOf('c1') -> "conversation"          // 「不」里读出了一个时长
```

**为什么现在还没造成损害**：记录授权的那一行同时也检查了 `sensitive` / `alwaysAsk`，
而拒绝走的是 `outcome: 'denied'` 分支、根本不会记授权 —— 所以这个 scope **目前到不了授予表**。
但它已经**躺在中继里**了：同一个 `callId` 的下一个问题会把它读走。
**靠下游恰好也拦住了来掩盖上游的错误记录**，不是我想要的形状。

**修法**：只有「是」才可能带时长 ——
`const granted = outcome === 'allowed-once' && APPROVAL_SCOPES.includes(scope)`。
拒绝带 scope 是调用方 bug，现在返回里也不再回显它。

**顺带修掉一条我自己写的坏测试**：我先写的用例是
`answer(id, 'cancelled', 'once')` 然后 `await promise` —— **`PANEL_OPTIONS` 只允许
`allowed-once` / `rejected`，所以 `cancelled` 被拒绝、那个 promise 按设计永不 settle**，
测试于是挂死在顶层 await（runner 报 `Detected unsettled top-level await`）。
**这本身是个好信号：协议边界确实拒绝了这个值**，所以改成断言「被拒绝」而不是等它。

**测试**：`npm test` **422 passed / 0 failed**；`check:extension` exit 0。
证伪：把 `granted` 退回只看 `APPROVAL_SCOPES.includes(scope)` → 1 红。

**交付要求**：只改 `lib/`，扩展侧无改动 → **重启 `dsh web`** 即可。

#### v35：把两个「说了不算数」的按钮删掉了（本次修复）

**背景**：v34 把审批卡改成两个肯定的答案（`只允许一次` / `本会话允许`），
让按钮说的话等于实际发生的事。但还有**两条路径**上，「本会话允许」这个按钮
**根本不可能兑现**：

| 路径 | 为什么记不住 |
|---|---|
| `browser_eval` / `browser_cdp` / `browser_upload` | 这三个工具**每次都重新问**（`alwaysAsk: true`）——eval 和 CDP 能跑任意代码，upload 能把你的文件送出去，预授权它们等于把 sandbox 拆了 |
| 敏感操作（提交/购买/删除/上传…） | 站点被允许**读**，不等于被允许**花钱**。所以已授权的站点里这一类**再问一次** |

**量出来的**：

```
ordinary click        -> asked again = false   // 「本会话允许」兑现了
sensitive (submit)    -> asked again = true    // 「本会话允许」说了不算
```

**修法：按钮在不能兑现的时候不出现**
- 宿主在审批请求里带一个 `rememberable` 字段（= `!alwaysAsk && !sensitive`），
  **它就是那条记录规则本身**，所以面板和宿主不可能各说各话。
- 面板拿到 `rememberable: false` 时**只画一个 `只允许一次`**，并补一句
  `这一步每次都要重新确认` —— 少一个按钮如果不解释，看起来像渲染故障，而不像一条规则。
- **没有加第二道「clamp」**：我先写了「即使旧面板硬发 `scope: conversation` 也不记录」的防护，
  然后用证伪证明它**不可达**（`rememberable === false` 恰好等价于 `alwaysAsk || sensitive`，
  而这两个条件本来就各自阻断记录）。**看起来像安全网却永远不执行的代码，比没有更糟**，已删。

**顺带修掉一个「一句话描述三种危险」**：敏感提示原本是一句通用的
`这一步会改动页面或花钱，不只是读`，但 `classifySensitivity`（`lib/grants.js`）
分三类，`browser_eval` 是「在页面里执行代码」——**既不花钱也不改页面**。
现在宿主把**是哪一类**一起送过来，面板分别说：

| 宿主 reason | 面板 |
|---|---|
| `runs code in the page` | 这一步会在页面里执行代码 |
| `uploads a file` | 这一步会从你的电脑上传文件 |
| `submits or spends` / `types into a control` | 这一步可能会提交、购买或删除 |
| **认不出来的** | 回退到通用句 —— **不猜**，说少一点好过说错 |

`browser_eval` 两个提示会同时出现（「会执行代码」+「每次都要确认」），
因为它们回答的是**两个不同的问题**：有多危险 / 为什么不能一次放过。

**测试**：`npm test` **421 passed / 0 failed**；`check:extension` exit 0。

**这一轮真正的教训是「假通过」**：
我第一版把 always-ask 用例写成驱动 `browser_eval`，断言它不记录 `access` 授权——
**它确实通过了，但通过的理由是错的**（eval 同时是 sensitive，所以因为敏感而不记录，
和 always-ask 规则无关）。**证伪时把那道 guard 删掉，测试全绿**，这才暴露出来。
改法：换成普通 always-ask 的 `browser_upload`，并**补一条对照用例**
（同一个夹具下普通工具**必须**记录授权）——没有对照，用例会在一个「什么都不记录」的坏夹具上照样变绿。
另外面板用例直接喂问题、不经过宿主，所以**抓不到「宿主忘了转发 reason」**——
补了一条宿主侧断言（证伪确认会红）。

**证伪**：宿主不再标记 `rememberable` → 2 红；面板不再扣下会话按钮 → 1 红；
面板退回通用句 → 1 红；宿主不转发危险类别 → 1 红。

**交付要求**：`lib/` + `extension/` 都改了 → **重启 `dsh web` + 重载 Chrome 扩展**。

#### v34：按钮写着「允许一次」，实际给了整个会话（本次修复）

**症状**：审批卡上只有一个肯定的按钮，写着「允许一次」。按下去之后，
**同一站点在本次会话里再也不会问** —— 按钮说的话和它做的事不是一回事。

**用真实模块量出来的**（不是读代码推断）：

```js
// 出厂默认
persistentApproval     = true
accessApprovalLifetime = 'thread'
// 宿主回答 allowed-once 之后，桥记录的是：
choice   = allow-for-site
lifetime = thread
// 于是：
right after          true
after 10 min idle    true
after 1 hour idle    true
after 30 days idle   true      // 只要进程不停，它就是永久授权
```

**为什么会这样**：harness 的审批**只有一个授予词** `allowed-once`，
「这次」「本会话」「永久」这层语义**根本不在它的返回里**；
桥是在事后用一个**配置默认值**猜的。于是「允许一次」被默认值悄悄放大成了「本会话」。

**一手依据（官方原版）**：从官方扩展产物里逐条抽出的
`approvalRequestCard.*` 文案表 —— 它的卡片给的是**三个**答案：

| 官方 id | defaultMessage |
|---|---|
| `approvalRequestCard.allowOnce` | `Allow once` |
| `approvalRequestCard.allowConversation` | `Allow this conversation` |
| `approvalRequestCard.alwaysAllow` | `Always allow` |
| `approvalRequestCard.deny` | `Deny` |

**修法：按钮说的话，就是实际发生的事**
- 面板给**两个**肯定的按钮：`只允许一次` / `本会话允许`（外加 `拒绝`）。
- 两个按钮 POST 的 `scope` 不同（`once` / `conversation`），
  宿主据此决定授予时长，**不再看配置默认值**。
- `once` **什么都不记录**（不是 `lifetime: 'turn'` —— 那是个真实授予，
  在接下来 5 分钟空闲窗口内一直覆盖后续调用，仍然超出「一次」的字面意思）。
- 没有 `always` 按钮：授予表在内存里，harness 一重启就没了，
  **写「永久允许」的按钮无法兑现**。官方有，是因为它的宿主能持久化；我们记录为差距而不是假装有。

**实测（真实模块端到端）**：

| 按下的按钮 | 记录到的授予 |
|---|---|
| `只允许一次` | **`granted=false`** —— 下一次还会问 |
| `本会话允许` | `granted=true` |
| 旧面板（不带 scope） | 回退到配置默认值，行为不变 |

**测试**：`npm test` **412 passed / 0 failed**；`check:extension` exit 0。
新增 `test/grant-scope.test.js`（6 条，**直接驱动真实 `askApproval`**，
夹具不桩掉审批链路——`screenshot.test.js` 就是因为绕开 `askApproval`
才让这个缺陷从它眼皮底下过去）。
`test/approval.test.js` 新增 4 条（scope 经 harness 返回、未知 scope 不记录、
拒绝不带 scope、两个问题各留各的 scope）。
**三处按索引取按钮的测试已改为按类名命名**（`onceButton()` / `allowButton()` / `rejectButton()`）：
卡片多了一个按钮之后，`approvalButtons()[0]` **从「本会话允许」悄悄变成了「只允许一次」**，
三条测试的设置还在、断言的意思已经错了。

**证伪三次**（各命中不同断言）：宿主忽略面板的 scope → 1 红；
中继不再把 scope 带回来 → 2 红；两个按钮发同一个 scope → 1 红。

**交付要求**：`lib/` + `extension/` 都改了 → **重启 `dsh web` + 重载 Chrome 扩展**。

#### v33：一个会话有 6969 行，面板只给你看最后 60 行（本次修复）

**症状（量出来的，不是猜的）**：拿用户自己的会话 `session-44c33409`（标题「打造类似codex的dsh网页插件」）
向线上 3080 请求：

| 请求 | 返回 |
|---|---|
| `limit: 60` | 60 行 |
| `limit: 20000` | **6969 行** |

面板写死 `limit: 60`，**而且没有任何提示说明上面还有别的**，也没有任何办法往回走。
99.1% 的对话在面板里**根本不存在** —— 这不是「少了一点」，是**一段长对话被静默地截成了尾巴**。

**修法：把「页码」换成「窗口」**
- 宿主 `lib/chat.js` 的 `readMessages(sessionId, limit, before)` 新增 `before`（从末尾往前跳过多少行），
  并返回 `more`（前面还有没有）。切片从末尾算起，所以**最新的一行永远是返回的最后一行**。
- 面板不再存「已取到的行」再拼接，而是**请求一个从最新往回数的窗口**：
  `depth` 从 60 起，点一次「更早的内容」加 60。
  **这样轮询和翻页是同一个请求的两种尺寸**，不存在两段数据重叠或对不上的可能。
- 面板顶部新增一个胶囊按钮「更早的内容」（`#earlier`），
  **只在宿主说 `more` 时才出现**，加载中显示「加载中…」并禁用。

**另一个坑（必须记住）**：翻页会把新行插在**读者正在看的内容上方**，
如果只恢复原来的 `scrollTop`，读者正在读的那段会被顶到屏幕下方 ——
这正是当初轮询导致的「它自己滚下去了」，只是换了一条路来。
所以在 `drawTranscript` 里量了 `scrollHeight` 的增量，用 `grewEarlier`（一次性标记）
把 `scrollTop` 补上这个增量，**翻页后读者眼前还是同一段文字**。

**测试**：`npm test` **401 passed / 0 failed**；`check:extension` exit 0。
- 宿主新增 2 条：12 行的会话按 4 行一页往回走，**每页内容与 `more` 都断言**；
  超出开头返回空且 `more=false`（不是回绕的尾巴）；短会话**不许**声称还有更多。
- 面板新增 3 条：有更早内容时按钮出现、点一下**窗口确实从 60 变 120**、
  `more` 变 false 后按钮消失、**切换会话时窗口重置回 60**。
- 夹具新增 `host.down` / `host.reads` / `host.more`。**此前桩永远返回全部行且没有 `more` 字段，
  所以「会话比一屏长」这个状态是不可测的** —— 这也是它活了 33 轮的原因。

**证伪三次**（各自命中不同断言）：窗口不增长 → 3 红；宿主忽略 `before` → 1 红；
切换会话不重置窗口 → 6 红。

**探针实测（真实宿主，3199）**：新建会话发 3 轮后共 6 行；
`limit=1` → 1 行 `more=True`；`limit=2` → 2 行 `more=True`；
**逐行往回走到头再拼起来，与一次性读到的全文逐字节相等（`TILES EXACTLY: True`）**；
`before=999` → 0 行 `more=False`。

**交付要求**：`lib/` + `extension/` 都改了 → **重启 `dsh web` + 重载 Chrome 扩展**。

#### v32：连不上宿主时，面板把最大的一块区域留成了空白（本次修复）

**症状**（本轮用无头 Chrome 造出「第一次安装、还没启动 `dsh web`」这个状态才看见）：
屏幕最大的一块是**空白的消息区**，而唯一的解释是一行 11px 的灰字「连不上 dsh web」，
贴在输入框上方 —— **那是一个脚注的位置，不是「为什么什么都用不了」的位置**。
同时**页头写着「还没有会话」**，而真相是「问不到」—— 用户的数据好好的，
只是没人应答。第三处：输入框旁还有一行「模型列表不可用」，
于是**一个原因被说成三件坏掉的事**。

**一手依据（官方产物）**：Codex 为一个用不了的扩展准备了专门的 status surface，
它全是「标题 + 一句话 + 按钮」的结构，文案按状态分支。它的字符串表就是这个形状：

```
Install the app to use ChatGPT in {browser}
ChatGPT may take a few moments to connect once opened
Open ChatGPT to finish installation
Try again
```

**修法**
1. **新增 `#blocked` 状态面**（`sidepanel.html`）：标题 + 一句话 + 一个按钮，
   居中占据 `#stage`，背景 `Canvas` 盖住下面的空消息区。
2. **页头不再谎报**：`renderTitle()` 在宿主不可达时显示产品名 `DSH`，
   **不再显示「还没有会话」** —— 那是对用户自己数据的断言，而面板根本无法核实。
   本来先写成显示同一句错误，截图后立刻发现**同一屏把一句话说了两遍**，改成产品名。
3. **一个原因只说一次**：`renderContexts()` 在不可达时整行隐藏（不再显示「未连接」chip），
   `drawModel()` 显示中性的「选择模型」并禁用（不再显示「模型列表不可用」）。
4. **`start` 拆出 `loadEverything()`**：重试按钮走的是**和首次加载完全相同**的代码路径 ——
   给重试单写一条更薄的路径，正是最会在无人使用时漂移的那份拷贝，
   而重试恰恰发生在「面板已经确定是错的」那一刻。

**顺带删掉**：`error.hostDown` 键与 `#offline` 元素（被状态面取代）——
死键检查会强制这一步。

**测试**：**新增两条**（`panel-stream.test.js`）—— 不可达时状态面出现、标题不谎报、
chip 行与模型按钮不重复报错；宿主恢复后点「重试」状态面消失且**确实重新请求了宿主**。
夹具新增 `host.down`（让 `fetch` 抛错），此前**桩永远有应答，所以「宿主挂了」是不可测的**。

**`no dictionary entry is a sentence` 加了一处具名豁免**：`blocked.hostTitle` / `blocked.hostBody`。
面板的规则是「每条都是标签」，但**状态面里的那句话就是内容本身** ——
官方同样如此。豁免写成具名数组并**断言长度是 2**，所以它无法悄悄扩张。

**实测**：无头 Chrome 渲染 → `[chat] blocked hidden` / `[firstRun] blocked 显示且 contexts hidden`；
`firstRun` 在 392px 与 320px 下都正常。`npm test` **396 passed / 0 failed**；`check:extension` exit 0。
**证伪三次**（各自命中不同断言）：状态面永不出现 → 5 红；页头改回谎报 → 1 红；模型行改回重复报错 → 1 红。

#### v31：右键菜单在中文浏览器里是英文（本次修复）

**症状**：Chrome 自己的右键菜单里有四行英文，出现在**每一个页面、每一次右键**：

```
Add selection to DSH context
Add this page to DSH context
Add this tab to DSH context
Sync selections automatically
```

**为什么它是最后一个被发现的**：其余三处界面（面板、设置页、动态提示）都能靠截图看到 ——
**而右键菜单由 Chrome 画在浏览器自己的 UI 里，任何面板截图都照不到它**。
它只存在于 `background.js` 的 `chrome.contextMenus.create({ title })` 调用里。

**修法**：service worker 里没有面板可以借翻译器，所以直接 import
`optionsTranslator` + `pickLocale`（v30 为设置页建的那本字典），
四行标题改用 `menuSay('menu.*')`。

**用 `globalThis.chrome` 而不是裸 `chrome`**：可选链**救不了未声明的标识符** ——
裸 `chrome?.i18n` 在没有 `chrome` 的环境里是直接抛错，而不是回退到英文。
（测试不 import 这个模块，所以不会当场炸；但这是**明天就会踩到的坑**。）

**新增一条测试**：`background.js` 里不许再有 `title: '英文'` 这种固定文案，
且必须有 ≥4 行走 `menuSay`。

**实测**：`npm test` **394 passed / 0 failed**；`check:extension` exit 0。
**证伪**：把一行标题改回英文 → 2 红（该行 + 对应的键变成死键）。

#### v30：设置页是纯英文，而面板是中文（本次修复）

**症状**：侧边栏整个是中文，而**设置页 141 行 HTML + 126 行 JS 里没有一个中文字符**。
设置页不是可有可无的角落 —— **它是用户粘贴桥接令牌的必经之门**，
也是唯一讲清「`debugger` 权限等于什么」的地方，而这段话对中文用户是英文的。

**为什么一直没被发现**：整套 i18n 纪律（字典键集一致、每个 `t()` 键存在、HTML 里不许有裸文案、
字典条目不许是句子、不许有死键）**全部只扫 `sidepanel.*`**。
`options.js` 只出现在「死键」那条的搜索名单里，而它一个 `t()` 都没有，所以**永远通过**。
**一个文件被纳入检查名单，不等于被检查。**

**修法：给设置页单独一本字典**（`locales.js` 的 `options` + `optionsTranslator`），
而不是往面板字典里加键。理由是**两种界面的文案形状本来就不同**：
面板的规则是「每条都是标签」（360px 宽，放不下解释）；
设置页是**读一次、静止、全宽**的地方，那段安全警告不是噪声，它就是重点。
把「不许是句子」这条规则扩到设置页，要么误报合法文案，要么把警告压成一句什么也没说的短语。

**HTML 里不留任何文案**：22 个 `data-i18n` 节点在脚本运行前一次性填好，
键缺失时回退英文而不是留空框 —— 漏掉的键是**看得见的**，不是静默的空洞。

**新增两条测试**（`panel-i18n.test.js`）：标记里不许有 ≥2 个字母的裸单词、
每个 `data-i18n` 名都要在字典里、以及**反方向**（字典里的键必须有人画 ——
运行时才用的键从 `options.js` 的 `say('…')` 里搜）。

**实测**：无头 Chrome 以 `zh-CN` 渲染设置页（`?s=path:options-probe.html`），
整页中文，22 个节点全部填上、无空框。`npm test` **393 passed / 0 failed**。
**证伪两次**：标记里留一个英文词 → 1 红；加一个没人画的键 → 2 红。

#### v29：未分组的会话借用了上一个工作区的标题（本次修复）

**症状**：会话列表里有一批行**没有自己的分组标题** —— 它们排在「daily」那些行的下面，
读起来就是 daily 工作区的一部分，而它们实际上不属于任何已注册工作区。

**这是真实数据里的一等公民，不是边缘情况**。对着线上实例只读拉一次列表：

```
groups: 3
  group id=26162796-… title='daily'          sessions=7
  group id=64188775-… title='打造dsh插件'      sessions=2
  group id=          title=''                sessions=3   ← 三行，零标题
```

**一手依据**：DSH 自己的侧栏有同一个桶，并且**给它起了名字** ——
`dsh-client-ui-workspace/lib/client.js:842` 是
`const label = row.workspaceId === void 0 ? t("group.ungrouped") : row.label`，
`:2719` 的 `"group.ungrouped"` 就是 **`"未分组"`**。
我们的 `drawHistory()` 只在 `group.title.length > 0` 时画标题，否则**什么都不画**。

**修法**：给这个桶画上 `history.ungrouped`（`未分组` / `Ungrouped`）。
**用的是宿主的词，不是我们自己起的名字** —— 同一个概念、同一个界面里，
两边用词不同会让人以为是两回事。**一律不发明新词**也是这一轮按下 `approval.*` 那批键的同一条规则。

**顺带修正预览夹具**：`%TEMP%\panel-preview\preview.mjs` 里两个分组的 `title`
写的是**路径**（`E:\dsh\打造dsh插件`），而宿主实际发的是**注册标题**（`打造dsh插件`）。
**夹具比产品难看，恰好掩盖了这个缺陷在截图里的样子**（路径当标题时它看着「像标题」）。
已改成宿主真实形状，并补上第三个 `title: ''` 的分组。

**实测**：无头 Chrome 截图三个分组各自带正确标题（`打造dsh插件` / `daily` / `未分组`）。
`npm test` **391 passed / 0 failed**。**证伪**：把 `label.textContent` 置空 → 2 红（含新增用例与死键检查）。

#### v28：审批卡把英文开发者日志当正文念给用户（本次修复）

**症状**：一个中文面板的「需要你确认」卡片，正文是

```
the browser bridge wants to use https://dl.acm.org
```

以及更敏感的那一类：

```
https://dl.acm.org: this action spends money or changes state, which is more than reading the page
```

这正是 v16 修过的同一个缺陷 —— **把写给日志的英文散文当作界面文案** —— 只是长在 v16 没覆盖的另一条路径上。
v16 只修了**回合失败行**（`extension/failure.js`：用 `code` 选句子，原始 message 降级为细节），
审批卡从头到尾都在 `sidepanel.js:1130` 原样渲染宿主的 `reason`。

**为什么之前没看见**：预览场景里的审批夹具**没有 `reason` 字段**，于是走的是
`t('approval.wants', { tool })` 这条回退分支，渲染出干净的中文「要用 browser_read」。
而生产里 `lib/page-tools.js:198-200` **总是**设 `reason`：

```js
const reason = sensitivity.sensitive
  ? `${origin}: this action ${sensitivity.reason}, which is more than reading the page`
  : `the browser bridge wants to use ${origin}`
```

**夹具比产品干净，所以缺陷在截图里看不见** —— 这和 v24「`chrome.tabs.query` 返回空数组导致两个 chip 零覆盖」是同一类。

**修法：宿主送事实，面板自己写句子。**

1. `lib/page-tools.js` 在 `approval.request({...})` 上多送 `origin` 与 `sensitive` ——
   宿主把请求对象原样透传给 waterfall（`dsh-user-approval/lib/index.js` 转发 `req`），所以多两个字段不需要改宿主。
2. `lib/approval.js` 的 `#question()` 经新的 `factsFor(request)` 把 `origin` / `sensitive` 带进面板通知。
   **`sensitive` 优先读结构字段**，只有拿不到时才从 reason 的措辞里回退推断 —— 结构字段不会漂移。
3. `extension/sidepanel.js` 自己组句：`approval.wantsSite` = `要在 {site} 上使用 {tool}`，
   `approval.note` = `这一步会改动页面或花钱，不只是读`（只在 `sensitive` 为真时出现）。
4. 宿主的英文原话**降级为 `.approval-detail`**，且**只在没有 `site` 时**才显示 ——
   有了 site，上面那句话已经说完它要说的事，再印一遍会让同一个 URL 在一张卡里出现两次。

**顺带修掉一个我自己引入的缺陷**：`renderApproval` 的去重键原本只有 `id:answering`，
于是**同一个 id 带着更完整的字段再次到达时（健康轮询追上通知）重绘被跳过**，卡片停在信息更少的那一版。
键改为包含 `site` / `sensitive` / `reason`。**这一条是写新测试时被抓出来的**，不是事后想到的。

**实测（不靠推断）**：
- `extension/sidepanel.js` 里的去重键与卡片结构由 `test/panel-stream.test.js` 两条用例钉住
  （自带句子 + 降级细节；`sensitive` 才出提示行）。
- 探针 3199（junction 指向工作区）上跑 `facts-probe.mjs`，用 `page-tools.js` 真实构造的请求驱动中继：
  `notified: {"sessionId":"session-probe","toolName":"browser_click","reason":"https://dl.acm.org: …","callId":"call-9","origin":"https://dl.acm.org","sensitive":true,"id":"panel-1","options":["allowed-once","rejected"]}`
  → `has origin: true` / `has sensitive: true` / 作答 `{"answered":true,...,"outcome":"allowed-once"}` / `race result: allowed-once`。
- 无头 Chrome 截图三种场景：有新事实 → 全中文两行；只有英文原话（旧宿主）→ 中文句子 + 降级细节；
  两者都没有 → 「要用 browser_tool」。
- `npm test` **390 passed / 0 failed / 0 skipped**；`npm run check:extension` exit 0。
- **证伪三次**：宿主不再转发 origin → 1 红；面板改回原样渲染 `reason` → 2 红（含「字典不许有死键」）；
  去重键退回 `id:answering` → 1 红。

**交付：`lib/` + `extension/` 都改了 → 要重启 `dsh web` + 重载 Chrome 扩展。**

#### v27：切换会话时，上一个会话的东西跟着过来了（本次修复）

**v26 的结论是「状态切换时不重绘是系统性缺陷来源」，那一轮查的是 `view` 维度。
这一轮查下一个维度：切换会话。** `selectSession()` 清了 `expandedReasoning`、
`drawnSignature`、`transcript`、`stickToBottom`，但没清三样属于**被离开的那个会话**的东西：

| 没清的状态 | 后果 |
|---|---|
| `live`（流式块） | **上一个会话正在输出的文字，画在新会话的转写稿上** |
| `pendingApproval`（审批卡） | 卡片跟着过来，两个按钮要回答的是新会话**从没问过**的问题 |
| `mentioned`（`@` 提及的标签页） | 那条提及会挂到**下一条消息**上，而它从没被选中过 |

`applyDelta` 有会话守卫（`payload.sessionId !== currentSessionId` 就丢弃），
**但切换会话本身不经过 `applyDelta`** —— `live` 原样留着，于是它自己的守卫形同虚设。

**为什么会漏掉**：`live` 是**唯一带着 `sessionId` 字段的状态**，而**没有任何渲染器比对它**。
字段存在、没人读 —— 这和 v23/v24 那个「短 URL 当成了 URL」是同一类：
**看起来在传递身份的信息，其实没被任何判据使用。**

**修法两层：**

1. `selectSession()` 在会话确实变了时清掉 `live` / `pendingApproval` / `mentioned`。
2. **`adoptOpenApproval` 改成只采纳当前会话的问题**。只做第 1 层不够——
   宿主的 health 报告**所有**未决问题，切换后 `adoptFromLastHealth` 会**立刻把别会话的卡重新领养回来**。
   第 2 层是证伪 `scope` 那次才逼出来的。

**测试写法**：视图切换在 v25 之前零覆盖，**会话切换在此之前也是零覆盖** ——
夹具的会话列表里只有一个会话，所以「切换」根本不可达。
这一轮给夹具加了第二个会话，并用**点击历史列表里的行**来切换（那是唯一入口）。

**证伪（五次，每次红的组合都不同）**

| 改坏什么 | 结果 |
|---|---|
| 全部不清 | **5 红** |
| 只不清 `live` | 1 红 |
| 只不清 `pendingApproval` | 1 红 |
| 只不清 `mentioned` | 3 红 |
| 采纳不按会话过滤 | 1 红 |

**测试**：383 → **386 passed / 0 failed / 0 skipped**（新增 3 条）。

**顺带踩到一个测试基础设施的坑**：`#title` 是**切换**（toggle），不是「打开历史」。
我第一版的 `switchTo` 助手按「当前是否在对话」决定点不点，结果测试若恰好停在历史视图，
它会往**反方向**切 —— 三个新测试和两个既有测试同时变红，看起来像产品坏了，
实际是助手把面板留在了错误视图。
**教训：切换型控件不能用「条件点击」伪装成「设为某值」，要么先读状态再决定点几次，
要么直接断言最终状态。**

**交付**：只改 `extension/` ⇒ **重载 Chrome 扩展**即可。

#### v26：看着「历史」视图时，正在流式输出的回答被丢掉（本次修复）

**v25 只修了一半。** 上一轮我修的是「历史视图下被问到审批」这一条，但同样的形状在面板里
**一共四处**——凡是 `view === 'chat'` 才画的东西，在历史视图下都不画，而 `showView()` 不重绘。

这一轮把四处全查了：

| 渲染器 | 历史视图下的行为 | 后果 |
|---|---|---|
| `renderWorking`（等待行） | `existing?.remove()` | 切回来「思考中…」不见了 |
| `renderLive`（流式块） | **`existing?.remove()`** | **正在流式输出的回答被丢掉** |
| `renderApproval`（审批卡） | `existing?.remove()` | v25 已修 |
| `updateToBottom`（回到底部键） | `hidden = true` | 切回来可能不显示（见下） |

**最严重的是 `renderLive`**：它不只是**不画**，而是**把已经在屏幕上的节点删掉**。
所以历史视图打开期间，模型流进来的每个字都被**丢弃**，切回来时：

- 如果回合还在跑 —— 要等下一个 token 才重新出现；
- 如果回合已经结束 —— **`refreshTranscript` 之前什么都看不到**。

**修法**：`showView()` 在**两个方向**都重绘这三个渲染器。

**为什么两个方向都要**：进入历史时若不重绘，等待行与流式块会**留在 DOM 里**
（`transcript.hidden = true` 只是隐藏，不删除），切回来时它们和新画的重复。
这一点是**证伪抓到的**——我第一版只修了「返回」方向，`noLeave` 那次证伪红了 2 条。

**顺带量掉一个我担心的东西（结论：不用改）**：`updateToBottom` 读 `transcript.scrollHeight`
与 `clientHeight`，而历史视图下它们是 0。我担心切回对话时布局还没算好、导致「回到底部」键
错误地不显示。**用真实浏览器量了**：

```
un-hide 后同一 tick: 599x529    强制回流后: 599x529
```

同一 tick 里布局就是可用的，所以这个担心不成立，**没有为它做任何改动**。

**证伪**（先 `node --check`，改完确认确实改到了）

| 改坏什么 | 结果 |
|---|---|
| 完全不重绘 | 3 红（三个测试都红） |
| 不重绘等待行 | 2 红（等待行 + 审批） |
| 只重绘「返回」方向 | 2 红（流式 + 等待行） |

**三个测试各红各的**，说明它们钉的是不同的东西。

**测试**：381 → **383 passed / 0 failed / 0 skipped**（新增 2 条：流式不丢、等待行回来）。

**交付**：只改 `extension/` ⇒ **重载 Chrome 扩展**即可。

#### v25：看着「历史」视图时被问到审批，回合永远卡住（本次修复）

**症状**：这正是你最早报的那个——「dsh 在等待审批，用户在浏览器插件中，不切回来看永远也不知道，
然后就卡住了」。v13 把审批卡片做进了侧边栏，但**只要当时面板停在「历史」视图，卡片永远不会出现**。

**根因**：卡片由健康轮询里的 `adoptOpenApproval()` 领养，而它第一行就是

```js
if (view !== 'chat') return
```

这个判断本身是**对的**——卡片属于对话，画在历史上是一张给没人看的转写稿的卡片。
**错的是另一半**：切回对话时，`showView()` **什么都不做**。而健康轮询 5 秒一次，
所以下一次领养要等最多 5 秒——**在那之前对话是冻结的**，看起来就像坏了。

**修法**：把最后一次健康回答**留着**（`lastHealth`），`showView('chat')` 时立刻重新领养一次。

```
刷新健康 → lastHealth = payload → adoptOpenApproval(payload)
切回对话 → adoptFromLastHealth() → adoptOpenApproval(lastHealth)
```

**为什么不留着等下一次轮询**：5 秒的冻结对话和「坏了」不可区分，而这正是用户报的那个症状。

**测试写法**：先点 `#title` 打开历史 → 让宿主报告一个未决问题 → 断言**历史下没有卡片**（
确认那个判断还在起作用）→ 再点一次切回 → 断言**卡片在**。**视图切换此前零覆盖。**

**证伪**（先 `node --check`，改完确认确实改到了）

| 改坏什么 | 结果 |
|---|---|
| `showView` 不再重新领养 | 1 红 |
| `refreshHealth` 不保留回答 | 1 红 |

**测试**：380 → **381 passed / 0 failed / 0 skipped**。

**本轮另一件事：验证目标被环境挡住了，如实记录。** 我原本要验证两条「看起来能工作但没被端到端验证」
的路径，探针上做不到：

- **审批**：需要一个**真的调用了需审批工具**的回合，而探针**没有 provider 凭据**（回合在调用工具前
  就因 `MISSING_CREDENTIAL` 失败），也**没有扩展连着**（`#notify` 必然失败走 `undeliverable` 分支）。
  所以 `asked`/`delivered`/`byPanel` 三个计数在探针上永远是 0。
  能验的只有防御分支，且已验：对不存在的 id 与非法 outcome 都返回 `409 {"answered":false,…}`，
  `refused` 计数从 0 正确增长到 2。
- **停止**：**实测到这个边界**——对一个**没有回合在跑**的会话按停止，宿主返回
  `{"cancelled": true}`（`cancel(request)` 里 `agent.cancel(...)` 之后**无条件** `return {accepted:true}`）。
  面板据此把按钮切回发送、清掉「思考中…」。**这不是缺陷**（用户按停止时确实期望它停下），
  但它意味着**「宿主说停下了」不等于「刚才确实有回合在跑」**——这个区别写在这里，免得以后被当成 bug 修。

**交付**：只改 `extension/` ⇒ **重载 Chrome 扩展**即可。

#### v24：`@` 提及之后的三个缺陷（本次修复）

v23 加了 `@` 提及，但它让一条**此前只有单一来源**的路径变成了两个来源。这一轮把那条路径走到底，
发现三个缺陷。**三个都是同一类**：面板说的话和它做的事不一致。

**① 提及的正是当前标签页时，面板画两个 chip，宿主只收一个。**

`@` 的候选按 recency 排序，而**当前标签页就是最近访问的那个**——所以「选到当前页」是顺手就会犯的错，
不是边界情况。两个 chip 显示两页，而宿主的去重键是 `kind + url + text`，同一个 URL 只会留下一条。
**面板承诺 2 个，实际送 1 个。**

修法：`mentionAddsSomething()` —— 提及与当前标签页**同 URL** 时不重复计入。
`renderContexts` 与 `pendingAttachments` **共用它**，所以「显示什么」与「送什么」不可能分叉。
**提及的 URL 为空时算「有内容」**（不能因为没法比较就静默丢掉一个附件）。

**② 候选行把「显示用的短 URL」当成了 URL 本身。**

`mentionRows` 返回的 `url` 曾经是 `shortUrl()` 的结果（`dl.acm.org/doi/…`），
而 `acceptMention` 把它整个存进 `mentioned` —— 于是 ① 的比较**永远不相等**，
守卫形同虚设（面板看着对，实际没生效）。

修法：拆成两个字段——`url` 是**真实 URL**（会跟着消息走），`where` 是**画出来的短形式**。
**这两个概念混在一起就是 ① 修不好的原因。**

**③ `stageRequested` 零测试覆盖。**

补了 5 条：两个标签页都到达、同页两次只留一条、拒绝时报告原因且不牵连其它附件、
无会话时全拒、未知 `kind` 降级为 `tab` 而不是丢掉。

**端到端实测（探针，真的发两个标签页附件）**

`POST {action:'send'}` 带两个 `kind:'tab'` 附件 ⇒ **`staged: 2, refused: []`**。
解开会话日志（多个 zstd frame 拼接，**必须按 magic `28 B5 2F FD` 切分逐帧解压**）确认模型**真的收到两条**：

```
[Attached from the browser by the user]
tab from github.com
Source: https://github.com/LessXi/dsh-browser-bridge — DSH Browser Bridge
...
[Attached from the browser by the user]
tab from dl.acm.org
Source: https://dl.acm.org/doi/10.1145/3809166 — Network Edge Inference
```

**顺带量到的一个数字，以及一个「不修」的判断**：每个附件 **342 字符里 338 是样板**
（`[Attached from the browser by the user]` + 三行「这是数据不是指令」+ 分隔线），
真正的内容只有 `tab from github.com` 那一行。**但它不修**——
上下文窗口是 1,000,000 tokens，这段约 100 tokens；而它是**提示词注入防护**：
页面内容是用户指过来的**不可信数据**，告诉模型「这是数据不是指令」是必要的安全措施。
**数字难看，但代价可忽略、收益是安全，所以留着。**

**证伪**（每一条都先 `node --check`，并确认补丁真的落盘）

| 改坏什么 | 结果 |
|---|---|
| `pendingAttachments` 去掉守卫 | 1 红 |
| `renderContexts` 去掉守卫 | 1 红 |
| 候选行用短 URL 当 `url` | 3 红（含 `mention.test.js` 那条） |

**测试**：372 → **380 passed / 0 failed / 0 skipped**。

**顺带修好测试基础设施的两处盲区**（都是这次才暴露的）：

- `test/dom-shim.js` **没有 `selectionStart` / `setSelectionRange`**，也没有让写 `value` 移动光标。
  真实 textarea 都做这三件事，而 `@` 提及全靠读「光标前那段文字」——
  缺了它们，每条提及测试都报一个与提及无关的 `TypeError`。
- 测试是**共享一个面板实例**的，所以前面留下的选区会让 chip 数从 2 起步。
  断言改成**比较增减量**而不是绝对值。

**交付**：只改 `extension/` ⇒ **重载 Chrome 扩展**即可。

#### v23：`@` 提及 —— 不用切标签页也能引用别的页面（本次新增）

**要解决的问题**：在此之前，能挂进消息的只有**当前标签页**。开着二十个标签页、想引用第三个时，
唯一办法是切过去——而切过去就丢掉了你正在读的那一页。

**一手依据（官方面板怎么做）**：它的候选长这样

```js
{ faviconUrl, browserFamily, lastOpened, tabId, snapshot: { title, url }, source: 'extension' }
```

菜单是**分组**的（`Tabs` / `Sites` / `Files` / `ChatGPT conversations` …），
文案里有 `{title} {url}`；排序走一个完整的模糊匹配器（`score-query-match`，9762 字节的
VS Code fuzzy scorer）。**我抄的是它的判据，不是它的算法**——一个侧栏负担不起 9.7KB 的
打分器，而子串匹配对人真正会打的几个字行为相同。

**实现**

- **新增 `extension/mention.js`**（纯函数，可脱离 DOM 测试，沿用 `model-menu.js` 的先例）：
  - `mentionAt(before)` — 从光标前的文本里认出 `@word`。`foo@bar` **不算**（那是邮箱），
    空格**关闭**它（菜单不该悬在没人正在补全的文字上）。
  - `mentionable(tab)` — **按协议白名单**：`chrome://`、`chrome-extension://`、`about:`
    一律不提供。**提供一个是「发出去才发现读不了」，比不提供更糟。**
  - `rankTabs(tabs, query, limit)` — **按 `lastAccessed` 降序**（`chrome.tabs.query`
    不保证顺序，而你想要的那个通常是你刚看过的）；**标题命中优先于 URL 命中**；
    没有 `lastAccessed` 的排**最后**而不是当成时间起点冲上去。
  - `shortUrl(url)` — `https://dl.acm.org/doi/10.1145/3809166#sec-3` → `dl.acm.org/doi/…`。
  - `mentionMenu(tabs, query)` — 返回 `state`：**`'empty'`（没有可读的标签页）和
    `'none'`（没有匹配的）分开**。两者的区别是「再打几个字也没用」，说同一句话会让人
    去找一个从来没被提供过的标签页。
  - `mentionRows(tabs)` — **两个同名候选时才显示 URL**。同一页的两个锚点是常见的，
    八行一模一样的菜单比没有菜单更糟。
- `extension/sidepanel.js`：`drawMention()` 每次按键重画（**读输入框而不是跟踪状态**，
  这样菜单不可能和文字不一致）；方向键 / Enter / Tab / Escape 在菜单打开时归它管
  （否则 Enter 会发出一条「半截提及」的消息）；`acceptMention()` 把 `@word` **整段删掉**——
  留下 `@net` 会让模型收到一个它看不懂的词，而附件已经说清了是哪个页面；
  `mentioned` 与 `currentTab` **分开**（一个是「你面前的页」，一个是「这条消息说的页」），
  两个都能挂，chip 行分开显示；**发送后清空**（不提的话它会把同一页静默挂到下一条上）。
- `extension/sidepanel.html`：`#at-menu` 及 `.at-*`（分组标签、行、14px 图标、
  标题一行 + URL 一行）。菜单**在 composer 之上**展开。
- `extension/locales.js`：zh/en 各 3 键 —— `at.list`（标签页）、`at.empty`、`at.none`。

**实测（无头 Chrome 截图 + `--dump-dom`，三条设计逐一验证）**

| 场景 | 结果 |
|---|---|
| `@` 空查询 | 6 条按 recency 排列；`chrome://extensions` **不出现** |
| 两个同名 `Pruning notes` | **都带 URL**（`example.com/pruning` / `other.example.com/pruning`） |
| 其余候选 | **不带 URL**（省下的是标题的宽度） |
| `@prun` | 从 6 条收窄到 2 条 |
| `@zzzz` | 显示「没有匹配的标签页」，**菜单不关闭** |

**证伪**（先 `node --check`，改完确认确实改到了）

| 改坏什么 | 结果 |
|---|---|
| 去掉协议白名单 | 2 红（370/2） |
| 去掉 recency 排序 | 2 红（370/2） |
| `showUrl` 恒为 false | 1 红（371/1） |

**测试**：360 → **372 passed / 0 failed / 0 skipped**（新增 `test/mention.test.js` 12 条）。
其中一条断言 `mention.js` **不引用 `document`/`window`/`chrome`/`fetch`**——
面板跑在 `chrome-extension://` 源、无法 import 扩展目录外的文件，
所以这个模块必须保持纯净才能被测。

**交付**：只改 `extension/` ⇒ **重载 Chrome 扩展**即可。

#### v21：按下发送后，自己那句话消失了（本次修复）

**症状**：按下发送，输入框清空、按钮变成停止、屏幕显示「思考中…」——
**而刚打的那句话在屏幕上不存在**。

**怎么发现的**：这一轮我本来想量端到端延迟，追发送路径时读到这段：

```js
input.value = ''                                    // 输入框立刻清空
...
for (const delay of [800, 2000, 4000, 8000, 15000]) // 到 800ms 才第一次重读
```

**中间那 800ms 没有任何东西把用户的消息画到屏幕上。** 而且不只是延迟：
如果宿主在这 800ms 内没答上（回合失败、宿主重启），**那句话就再也不出现了**。

**实测（预览宿主新增 `?s=gapsend` 场景）**：让宿主接受发送但**不让 transcript 变化**，
这就精确复现了那个窗口。1200ms 时刻的真实渲染：

| 时刻 | 修复前 | 修复后 |
|---|---|---|
| 1200ms | 输入框空、按钮=停止、「思考中…」，**消息不存在** | 消息气泡 + 「思考中…」 |

**修法：乐观回显。** 发送被接受后立刻 `drawTranscript([...rows, { kind: 'user', text }])`。

**为什么这不是「说谎」**——这一层的设计是承重的：

- `rows` 仍然只保存**宿主上次给的行**，回显只进这一帧的绘制，不进 `rows`。
- 下一次 `refreshTranscript` 会用宿主的列表**整体替换**，回显随之消失。
- 所以「宿主其实没收下这条消息」的情况下，回显活不过一次重读——**它不可能变成一条假的记录**。
- 有测试钉住这条：写入回显 → 让宿主的列表不含它 → 触发一次重读 → 断言它已消失。

**证伪**

| 改坏什么 | 结果 |
|---|---|
| 去掉 `drawTranscript([...rows, ...])` | 2 红 |

**测试**：358 → **360 passed / 0 failed / 0 skipped**。
既有的 `sending swaps the same slot to stop` 断言了输入框清空、按钮变停止、
消息到达宿主——**唯独没有断言消息出现在屏幕上**，这就是缺陷活到现在的原因。

**交付**：只改 `extension/` ⇒ **重载 Chrome 扩展**即可。

#### v20：选区的完整文本在面板里根本读不到（本次修复）

**症状**：第二个 chip 写着 `选中内容 · 这种剪枝方式会移除模型中的整套架构单元，例如多层感知…`。
发送时送的是**全文**，但屏幕上只有一段截断——而且**旧 chip 没有 `title`**，
所以想知道「到底会送出去什么」，只有发出去这一条路。

**我原本以为的问题，和实测出来的是两回事。** 这一轮值得原样记下来。

我上一轮说「去掉前缀能多显示一截」。量完之后：

| 版本 | label 宽 | 字符数 | **可见** | 其中真实内容 | 悬停看全文 |
|---|---|---|---|---|---|
| 改前 | 337px | 47 | **30** | 25 字（5 字是前缀） | **不能**（无 `title`） |
| 改后 | 328px | 56 | **27** | **26 字** | **能** |

**宽度收益没有兑现，而且可见字符还少了 3 个。** 原因：旧版把文本硬截到 39 字、
剩下的交给 CSS；新版把全文交给 CSS。前缀省下的 60px，被「多出来的 17 个字」吃光了。
**净效果是内容多了 1 个字**——不是我承诺的一截。

**所以这轮真正的修复是另一件事**：`title` / `aria-label` 现在带全文，
悬停就能读到会送出去什么。**那 29 个看不见的字从此可达**，而不是靠更宽的 chip。

**顺带删掉一处双重截断**：旧代码 `text.slice(0, 39)` 是**按字符数**截断，
而 39 个 CJK 字形的宽度约是 39 个拉丁字形的两倍——这个数字从来没对上它所在的框。
结果是**先 JS 截一次、再 CSS 截一次**。现在只有 CSS 截，因为只有 CSS 知道宽度。

**改动**

- `extension/sidepanel.js`：选区 chip 的 label 直接放 `currentSelection.text`（去掉前缀、去掉 `slice`）；
  前缀的意思交给 `<span class="mark">“</span>` 一个字形（`aria-hidden`），
  chip 本身的含义由旁边的引号与 accent 底色表达。
- `chip.title` / `chip.setAttribute('aria-label', ...)` = `${t('context.selection')} · ${全文}`。
- `extension/sidepanel.html`：新增 `.chip .mark { flex: none; color: var(--tertiary); font-family: Georgia, serif; line-height: 1 }`。
- **`×` 保留**：它是唯一明确的「这次不送选区」途径，去掉它用户只能回页面重新选词。

**证伪**（先确认补丁真的落盘，再 `node --check`）

| 改坏什么 | 结果 |
|---|---|
| 把 `选中内容 · ` 前缀加回来 | 3 红（含既有的「不许给可见字段赋字面句子」断言） |
| 去掉 `chip.title` | 2 红 |

**测试**：355 → **358 passed / 0 failed / 0 skipped**。新增 3 条。
**选区 chip 在此之前零覆盖**——第一个版本的测试夹具让 `chrome.tabs.query` 返回空数组，
所以两个 chip 一个都没被测过（v19 修了 tab chip，这轮补上选区 chip）。

**交付**：只改 `extension/` ⇒ **重载 Chrome 扩展**即可。

#### v19：那个 chip 把宽度花在标签上，然后截断标题（本次修复）

**症状**：底部那行 chip 在每个截图里都写着

```
当前标签页 · Network Edge Inference for Large Language Mo…
```

**它把宽度花在「当前标签页 · 」上，然后截断读者真正要看的标题。**

**量化（无头 Chrome 的 `--dump-dom` + 探针量，不是目测）**：在 392px 面板宽度下，
chip 的 label 拿到 **360px**，而这个标题需要 **400px**——前缀正好吃掉缺的那 40px。
前置的「当前标签页 · 」自己就要 40–50px。

**一手依据（官方面板怎么做）**：`at-mention-list-D3gGVteY.css` 全文只有 154 字节：

```css
._CompactSource_3pdaq_2 { display: var(--display-icon-compact, contents) }
._LeadingSource_3pdaq_6 { display: var(--display-icon-leading, none) }
```

两个 CSS 变量控制「紧凑图标」与「前置文字」的显隐，而 `--icon-leading-size` 是
`16px`（`--icon-leading-size: calc(var(--spacing) * 5)`）。**它用图标代替文字。**

**修法**

1. `currentTab` 增加 `icon` 字段，`refreshTabs` 从 `active.favIconUrl` 取。
2. 新增 `faviconOf(tab)`，**按协议白名单**（`^(https?|data):`）而不是黑名单 `chrome:`：
   想不到的协议降级成「没有图标」，而不是降级成一个破图。
3. chip 里在有图标时先放 `<img class="site">`，label 只放标题。**完整名字没有丢**——
   它移到 `title` 与 `aria-label` 上（`${t('context.tab')} · ${title}`），
   悬停和读屏仍然完整。
4. favicon 用 `error` 回调自我移除：404 的图标不能留下一个破图方框。
5. CSS `.chip .site { width: 14px; height: 14px }` —— **14px 而不是官方的 16px**：
   chip 的文字是 12px，16px 的图标比行高更高，胶囊会鼓一个包。

**实测（无头 Chrome 截图 + `--dump-dom` 量宽）**

| 判据 | 修复前 | 修复后 |
|---|---|---|
| label 的文本 | `当前标签页 · Network Edge Inference for Large Language Models` | `Network Edge Inference for Large Language Models` |
| label 可用 / 需要 | 360 / 400 px | 300 / 325 px |
| 实际渲染 | `…Large Language Mo…` | `…Large Language Models`（**完整**） |
| 320px 窄面板 | — | 图标 + 标题（省略号截断），chip 共 300px |

**一个被自己的守卫挡住的真 bug**：`faviconOf` 第一版只认 `http(s)`，
于是**预览里那张 `data:` 图标被丢掉**——`<img>` 一个都没渲染出来。
真实 Chrome 里 `favIconUrl` 也确实可能是 `data:`（页面自己声明内联图标），
所以这是**真的过窄**，不是预览的人造问题。放宽成按协议白名单后修复。

**证伪**（先 `node --check`，改完确认确实改到了）

| 改坏什么 | 结果 |
|---|---|
| 图标分支短路 | 2 红（353/2） |
| 白名单收窄回只认 `http(s)` | 1 红（354/1）——正是 `data:` 那条 |

**测试**：352 → **355 passed / 0 failed / 0 skipped**。新增 3 条。
顺带发现测试桩的一个不真实处：它让 `chrome.tabs.query` 返回空数组，
所以 chip 从来没有被测过；一旦给上 tab，`start()` 就会去问页面要选区，
而桩的 `sendMessage` 返回 `{}` ⇒ 面板正确判定「上报脚本失联」并提示刷新。
**行为是对的，桩是错的**——改成返回 `{ text: '', url, title }`。

**交付**：只改 `extension/` ⇒ **重载 Chrome 扩展**即可。

#### v18：连点两次「＋」会建出两个会话，其中一个变成孤儿（本次修复）

**症状**：`＋` 按钮发起一个网络往返，但**期间按钮不禁用、也没有 in-flight 状态**。
连点两次 ⇒ 宿主建出**两个会话**，面板只能认领其中一个，另一个留在列表里，
**没有任何东西解释它是哪来的**。

**实测（探针，隔离 `DSH_HOME`）**：连发两次 `POST {action:'create'}` ⇒
两个不同的 sessionId，列表从 2 个会话变成 4 个。

**为什么这个必须修，而模型切换的同类竞态不修**：区别在**副作用是否永久**。

| 动作 | 重复的后果 | 是否自愈 |
|---|---|---|
| `＋` 新建会话 | **多出一个会话**（宿主每次 mint 新 id） | **否**——孤儿永久留在列表里 |
| 切换模型 | 面板本地记下过期的那次响应 | **是**——`refreshGroups` 每 5 秒从宿主读回真实状态 |

模型切换确实也有竞态（面板按「谁先回来谁写本地」，宿主按「谁后完成谁生效」，
两者顺序相反时会短暂显示错的值），但它 5 秒内自愈，而加互斥会让「换个模型」
这种本该即时的操作多一层等待。**没有证据表明它有害，就不加。**

**修法**

- 新增 `let creating = false`，`newSession()` 里 `if (creating) return`，
  并用 `try/finally` 释放——`finally` 是必要的：宿主拒绝时（老宿主 400、无工作区 500）
  若不释放，按钮就再也按不动了。
- 新增 `drawNew()`，与既有的 `drawSend()` 对称：**谁决定状态，谁负责画**。
  `newButton.disabled = creating` + `aria-busy`，让连点既无效也可读。
- 拆出 `createSession()` 承载原来的会话创建逻辑，`newSession()` 只负责守卫与重绘。
- 视觉沿用既有的 `.icon:disabled { opacity: .4 }`，不新增样式。

**证伪**（先 `node --check`，改完确认确实改到了）

| 改坏什么 | 结果 |
|---|---|
| 去掉 `if (creating) return` | 1 红（351/1）——**正是「连点不产生第二个会话」那条** |
| `drawNew` 不设 `disabled` | 1 红（351/1）——同一条 |

**测试**：349 → **352 passed / 0 failed / 0 skipped**。新增 3 条：
连点不产生第二个会话、被拒绝后按钮恢复、老宿主拒绝时也有话说。
为此给测试宿主加了 `holdCreate`/`releaseCreate`——**这是唯一能观察到 in-flight 窗口的办法**：
其他路由都是立即返回，一个只存在一个 microtask 的状态无法断言。

**交付**：只改 `extension/` ⇒ **重载 Chrome 扩展**即可。

#### v17：一个回合进行中，面板把「它在干活」说了两遍（本次修复）

**症状**：这是用户最早那句「我就发了个 11，怎么跳出来这么多莫名其妙的东西」的最后一块。
一个回合进行中，屏幕上同时有两处在报告状态：

| 阶段 | 修复前 |
|---|---|
| 刚发出、还没有 token | 「思考中…」✓ |
| 推理中 | 「思考 ⌄」**和**「思考中…」——两行说同一件事 |
| 回答开始流式输出 | `看完了。▌` **和**「思考中…」——回答已经在写了，下面还说它在思考 |

**为什么之前的截图看不见**：v16 之前我只看**已提交的行**。这个重叠只存在于流**打开的时候**，
一提交就消失了。所以本轮先在预览宿主里加了三个真实时序的场景
（`?s=waiting|thinking|streaming`，用 `dsh-assistant-delta` 按 160ms 逐条投递），
才第一次看到它。

**根因**：`renderWorking()` 与 `renderLive()` 是**两个渲染器在报告同一个事实**，
而前者只看 `currentSessionRunning`，不知道后者已经有话可说了：

```js
const wanted = view === 'chat' && (currentSessionRunning || sending)
```

**修法：每个阶段只有一个东西在说话。**

1. **`renderWorking` 让位**——只有当 `live` 还没有内容时（`live.text` 与 `live.reasoning` 都为空，
   即首个 token 之前）才画等待行。有了内容，那段内容本身就是证据。
2. **`renderLive` 接管**——推理阶段由 live 块自己说；为此把 `.live-think` 从
   「标签 + 段落」改成**一行**：标签 + 预览文字，`white-space: nowrap` + `text-overflow: ellipsis`。
   **一手依据**：官方面板把 `Thinking` 与预览放在同一行，并且它的推理预览 `maxHeightByState`
   三种状态都是 `8.75rem`——是**限高**，不是另起一行。
3. **空光标消失**——推理阶段 `.live-body` 还没有文本，`::after` 的闪烁竖线是空行上的光标，
   指不到任何东西。加 `.live-body:empty::after { display: none }`。

**顺带修掉一个我自己引入的真缺陷**（证伪时抓到的）：`sendMessage()` 设
`currentSessionRunning = true` 后调 `renderWorking()`，**但没有清上一轮的 `live`**。
上一轮的 live 靠 `end` 帧或 `done` 清掉，而用户主动发新消息时两条路都不走
（宿主重启、中途重载面板都会留下一个 stale `live`）。这个残块既会显示**上一轮的文字**，
又会因为 `hasContent` 为真而**压掉等待行**——正是「发了消息却看不出在跑」。
修法是在 `sendMessage` 里显式 `live = null; renderLive()`。

**实测（三个阶段的真实渲染，无头 Chrome 截图）**

| 场景 | 结果 |
|---|---|
| `waiting`（只有 `start`） | 一行「思考中…」，**没有空光标** |
| `thinking`（只有 reasoning） | **一行**：「思考」+ 预览，超长处以省略号截断；没有第二行 |
| `streaming`（reasoning → tool → text） | 只有 `看完了。▌`；等待行已退场 |

**证伪**（先 `node --check`，改完确认确实改到了）

| 改坏什么 | 结果 |
|---|---|
| `renderWorking` 的判据去掉 `&& !hasContent` | 3 红（346/3） |
| `sendMessage` 里去掉 `live = null` | 2 红（347/2）——**红的正是 stop 路径的两条**，说明残留 live 会压掉等待行 |

**测试**：347 → **349 passed / 0 failed / 0 skipped**。新增 3 条（三阶段各只有一处报告状态、
推理预览是单行且不能回退成多行），改写 4 条原本钉住「两行同显」的旧断言。
其中一条顺带改了语义：`a start frame shows the waiting line and no empty live block`
原本断言「live 块在等待行**上方**」，现在断言「有文本后等待行**消失**」。

**交付**：只改 `extension/` ⇒ **重载 Chrome 扩展**即可，不需要重启 `dsh web`。

#### v16：失败信息把 provider 的开发者日志原样贴给用户（本次修复）

**症状**：v15 让失败的回合开口说话了，但说的是这一句——

```
llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY
through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY
in the launching environment
```

在 360px 宽的面板里用红字铺满四行：英文、含环境变量名、含「provider route」这种词，
还教用户去改配置文件。这正是用户抱怨的「为什么有这么多提示性文字」，也是最糟的一种——
**它不是提示，是日志**。

**怎么看出来的**：本轮第一次把面板真的渲染出来看（无头 Chrome 截图 + `read_image`，
见下），`failed` 场景一眼就是这个样子。

**根因**：失败信息带着两样东西（`assistant/attempt` 的 `finish` chunk 与 `turn/end` 的
`reason.error` 都是这个形状）：

```json
{ "message": "llm-deepseek: no API key …", "code": "MISSING_CREDENTIAL" }
```

`message` 是写给读日志的人的，`code` 才是机器可判断的。原来的实现**只带了 `message`**，
`code` 在三个地方被丢掉（`deltaOfFrame`、relay 重建 payload、`describeEvents`），
面板除了把日志贴出来别无选择。

**修法：code 决定句子，message 降级成细节。**

1. `lib/stream.js` 的 `deltaOfFrame` 把 `code` 一起返回；relay 那一跳
   （`#send({sessionId, kind:'failed', …})` 是**按 `kind` 重建 payload 的**）也补上，
   否则派发路径上又丢一次——这一跳最容易漏，因为它不碰 `deltaOfFrame`。
2. `lib/chat.js` 的 `turn/end` 分支同样带上 `code`，否则**冷重放/重载后**又退回原始日志。
3. **新增 `extension/failure.js`**（纯函数，可脱离 DOM 测试）：`failureSentence(code, t)`
   把 12 个宿主错误码映射成一句人话，`failureDetail(text)` 把原始 message 压成一行。
   放在 `extension/` 而不是 `lib/`，因为面板跑在 `chrome-extension://` 源，
   **无法 import 扩展目录外的文件**（v7 踩过同一个坑）。
4. 面板两处都改：实时 toast 用 `failureSentence(payload.code, t)`（toast 几秒就消失、
   不能选中也不能搜索，是贴日志最糟的位置）；持久行 `.failure` 放句子、
   `.failure-detail` 放降级后的原话。

**词表**（zh/en 各 8 键，都是可行动的一句话，不是把错误码换个说法）：
`error.code.credential`「模型还没配置密钥」/ `quota` / `rateLimited` / `tooLong` /
`noImages` / `reasoning` / `unreachable` / `empty`。**没有命中的码回落到
`error.turnFailed`「这一轮没能跑起来」**——不是回落到原始 message：通用句子虽然信息更少，
但它是读者看得懂的语言、而且不会在文件路径中间断掉；原话留在 `.failure-detail` 里，
真要搜索时还在。**没有 `code` 时连 detail 都不渲染**（截图里第三例验证过）。

**布局坑（截图抓到的，测试抓不到）**：`.row` 是 `display:flex`，所以句子和细节
变成了**并排两列**，「模型还没配置密钥」被挤成一列一个字竖着排。
修法是 `.row[data-kind="failed"] { flex-direction: column }`，
并且为它加了一条回归测试——这种错看代码是看不出来的。

**本轮的方法突破：无头 Chrome 截图**

前三轮一直靠用户截图验证，这一轮找到了自己的眼睛：

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --disable-gpu `
  --user-data-dir="$env:TEMP\panel-preview\chrome-profile" --window-size=392,812 `
  --virtual-time-budget=8000 --screenshot="out.png" "http://127.0.0.1:3399/?s=failed"
```

配合 `read_image` 读回 PNG，**像素级缺陷我自己就能看见**。`%TEMP%\panel-preview\preview.mjs`
把 `extension/` 的五个文件复制出来、注入最小 `chrome.*` 桩与打桩 `fetch`，在 3399 上提供
8 个场景（`?s=chat|failed|failedBare|empty|working|approval|long|history`）。
**用户浏览器全程未碰**（用户原话「不要影响到我正在使用浏览器」）。

**预览宿主自身的三个坑**（都是我的桩写错，不是产品缺陷，但会浪费一整轮）：

| 现象 | 真因 |
|---|---|
| 每个场景都显示「思考中…」 | `running` 来自**会话列表**（`GROUPS`）而不是 messages 响应，我的桩把它写死成 `true` |
| 审批卡片完全不出现 | `approvalPending` 的每一项**必须带 `sessionId`**（真实形状见 `lib/approval.js` 的 `pending()`） |
| 模型选择器显示「模型列表不可用」 | 面板读的是 `payload?.catalog`，我直接返回了目录本身 |

以及一个几何陷阱：**headless Chrome 不遵守 `--window-size` 的布局**（它按 500x717 排版再把
截图裁成你要的尺寸），于是右侧的相对时间看着像被切掉。预览改成按 `?w=` 固定面板宽度，
并用 `--dump-dom` 读回 `body.scrollWidth` 来**量**而不是**看**——实测 392 与 320 两个宽度下
`scrollWidth` 都等于面板宽度，**没有溢出**。顺带确认历史视图在 320px 下也正常：
分组、相对时间、当前会话高亮、空会话不显示，都成立。

**实测**

| 判据 | 实测 |
|---|---|
| 探针发一条必然失败的请求 | health `stream.failed` 由 0 → **1**（`ends:1`，`failed:1`） |
| 同一会话回读 | 2 行：`kind=user code=(无)` + **`kind=failed code=MISSING_CREDENTIAL`** |
| 渲染结果 | 红字「模型还没配置密钥」+ 灰色小字原始 message（截图确认） |
| 无 code 的失败 | 只有「这一轮没能跑起来」，**不贴原话**（截图确认） |
| 用户线上 3080 | 本轮全程只读；`stream` 出现 `failed` 字段 ⇒ 用户已重启过 `dsh web`，v15 生效且真实失败已被计数 |

**证伪**（先 `node --check`，改完确认确实改到了）

| 改坏什么 | 结果 |
|---|---|
| `failure.js` 不映射 `MISSING_CREDENTIAL` | 3 红（344/3） |
| relay 那一跳不转发 `code` | 3 红（344/3） |

**测试**：325 → **347 passed / 0 failed / 0 skipped**（新增 `test/failure.test.js` 10 条 +
改写 7 条原本钉住旧行为的断言：它们断言的正是「把日志贴出来」）。
**7 条变红是对的**——那些期望已经错了，不是测试坏了。

**交付**：`lib/` + `extension/` 都改了 ⇒ 重启 `dsh web` + 重载 Chrome 扩展。

#### v15：回合失败长得像「模型没话说」，因为我第一次找错了信号（本次修复）

**症状**：模型请求被拒（没有 API key、路线不可达、额度用尽）时，侧边栏的「思考中…」只是停下来，
什么也不说。已提交的输入孤零零地留在那儿，看起来就像模型选择沉默。

**第一次修错了**，这一段必须留着，因为错法本身很有教育意义。

v15 的第一版是这样推理的：宿主 `AssistantStreamAttempt` 的 end 帧带 `outcome`，成功是
`{kind:'committed'}`，抛出时是 `{kind:'abandoned'}`，所以「`abandoned` 就是失败」。于是我把
`deltaOfFrame` 改成读 `frame.outcome`，测试夹具也照着这个假设造。**全部通过。**

然后我在真探针上发了一条必然失败的请求（隔离 `DSH_HOME`，没有 provider 凭据），health 报：

```
stream = {"frames":3,"ignored":1,"flushes":0,"notifications":0,"dropped":2,"ends":1,"failed":0}
```

`ends: 1` 但 `failed: 0` —— **到达中继的那个 end 帧不是 `abandoned`**，我的判据从来没被触发过。

**真实形状**（解开会话日志 `session.v3.jsonl.zstd` 拿到的一手证据，日志是多个 zstd frame 拼接的，
必须按 magic `28 B5 2F FD` 切分逐帧解压）：

- 19 条事件里**没有任何 `assistant/message`**；
- `assistant/attempt`（seq 15）的 `stream` 是**一个 `finish` chunk**：
  `{"type":"finish","reason":{"kind":"error","failure":{"message":"llm-deepseek: no API key…","code":"MISSING_CREDENTIAL"}}}`；
- `turn/end`（seq 17）带 `reason = {kind:'error', error:{message, code}}`。

**为什么 `outcome` 读不出失败**：`dsh-agent-loop/lib/index.js:1080-1095` 在 `finish.kind === 'error'`
时**先** `live.settle('assistant/attempt', …)`，而 `settle()`（`:420-440`）会把 `terminal` 置为 true；
只有 `:1119` 的 `if (!live.ended) live.abandon()` 才会发 `abandoned`，而它被上面那步挡住了。
所以失败回合发的是 `{kind:'committed'}` —— **与成功逐字节相同**。`outcome` 这个字段根本无法承载
「失败」这个信息。

**真正的实时信号**是那个被我丢进 `ignored` 的 `finish` chunk。`dsh-llm/lib/index.js:2337`
`adapterFailureChunk` 的注释写得很直白：适配器抛出的错误会被转成终态的 `error` / `aborted`
finish chunk。这也解释了为什么 `ignored` 是 1 —— 丢的正是唯一有用的那一帧。

**修法（两层，都建立在实测形状上）**

1. **实时**：`deltaOfFrame` 新增 `kind: 'failed'`，对 `chunk.type === 'finish'` 且
   `reason.kind === 'error'` 返回 `{kind:'failed', text: message}`；relay 新增 `failed` 计数并在同一
   跳里把 `text` 一起送达；面板先于 `live === null` 判断处理它，**说宿主给的原话**、说不出来时回落到
   `error.turnFailed`。`reason.kind === 'aborted'`（用户自己按的停止）**不算失败**。
2. **持久**：失败回合不提交任何 assistant 消息，所以 `describeEvents` 加了 `turn/end` 分支——
   `reason.kind === 'error'` 才产出 `{kind:'failed', text}` 行，`aborted` 与正常结束都不产出。
   面板把它画成一行 `.failure`。

第 2 层是必要的：只有实时 toast 的话，**重载面板后失败又消失了**——同一类「失败长得像空结果」，
只是这次藏在持久层。

**实测（隔离 `DSH_HOME` 的探针，用户 3080 全程未碰）**

| 判据 | 实测 |
|---|---|
| 修复后 health | `{"frames":3,"ignored":0,…,"ends":1,"failed":1}` —— `ignored` 归零，那一帧不再被丢 |
| 修复前同一请求 | `ends:1, failed:0`（错判据从未触发） |
| 热读 transcript | 2 行：`[user] probe durable` + `[failed] llm-deepseek: no API key for provider route "deepseek-official"…` |
| **冷重放**（重启探针后） | 同样 2 行、同样带原因 ⇒ **重载面板也看得到** |
| 已装副本（非 junction） | `stream` 带 `failed` 字段、冷重放仍是 2 行 |

**证伪**（全部先过 `node --check`，改完比字节数确认确实改到了）

| 改坏什么 | 结果 |
|---|---|
| `deltaOfFrame` 的 `finish` 分支改回不识别 | 4 红（325/4） |
| `describeEvents` 的 `turn/end` 分支短路 | 3 红（333/3） |
| 面板 `row.kind === 'failed'` 分支短路 | 2 红（334/2） |

**顺带修掉一个测试基础设施的盲区**：`test/dom-shim.js` 的 `matches()` 只认 `tag` / `.class` / `#id`，
遇到 `[data-kind="failed"]` 这种属性选择器**返回「不匹配」而不是报错**——于是断言变成对空气断言。
已补上 `[attr]` 与 `[attr="value"]` 与复合选择器（tag+class+id+attr）。这类「选择器看不懂就静默不匹配」
的坑值得记住：它让测试红得莫名其妙，也让本该抓到 bug 的断言变成永远为真。

**交付**：`lib/` + `extension/` 都改了 ⇒ 重启 `dsh web` + 重载 Chrome 扩展。

#### v14：两个「输入法」与「后开面板」缺陷，外加测试一直在跑半启动的面板（本次修复）

这一轮从「还有什么会让商业产品显得不专业」出发，找到三处：前两处是产品缺陷，第三处是
**我的测试自己骗了自己**。

**缺陷 1：中文输入法按 Enter 会被当成「发送」**

`extension/sidepanel.js` 的 Enter 处理只有 `event.key !== 'Enter' || event.shiftKey` 两个条件。
而写中文／日文／韩文时，**按 Enter 选中候选词**是每一步都要做的动作——于是「打一句话再确认候选」
会变成「把半句话发出去」。对中文用户这不是边界情况，**是每一条消息**。

修法是补上 IME 的两个信号：`event.isComposing === true`（现代浏览器）与
`event.keyCode === 229`（老式输入法的等价信号）。真正的 Enter 仍然发送——测试里专门断言了
这一点，免得守卫变成「把键吃掉」。

**缺陷 2：问题问出去之后才打开的面板，永远不知道有这回事**

`approval/asked` 是**通知**：只投给那一刻连着的那一个面板，不会重放。于是「问题发出时面板没开／
正在重载／在另一个窗口」→ 面板显示一个转圈的回合，**没有任何按钮**，而这恰好就是 v13 要消灭的
那个卡死，只是换了条路进来。

v13 我已经在 health 里放了 `approvalPending`，**但面板从来没读它**——一个加好了却没人用的字段，
形状和「本来就没有问题」一模一样。现在 `refreshHealth()` 会调 `adoptOpenApproval(payload)`：
认领仍开着的问题，并在问题已经不在列表里时把卡片撤掉（答案是别人给的，`settled` 没收到）。

**一个不能省的判断**：老版本宿主**根本没有 `approvalPending` 字段**。`Array.isArray` 为假时是
「这个宿主说不了」，不是「没有未决问题」；当成后者会把通知通道刚刚合法挂上的卡片无故撤掉。
同一个坑 v13 已经踩过一次（`surfaceRules` 的三态），所以这次直接写成守卫。

**缺陷 3（最重要）：测试一直在测一个半启动的面板**

`globalThis.window` **从来没在测试桩里定义过**，而 `start()` 里有一句
`window.addEventListener('focus', …)`。于是 `start()` 在**挂载四个轮询之前**就抛异常、被
`start().catch(…)` 吃掉，写入一条 toast——**而所有只碰消息区的用例照样全绿**。

也就是说：四个 setInterval 从未被挂上，focus 监听器从未注册，而 300 多条测试没有一条发现。
这正是「死掉的 accessor 和空结果形状相同」的又一例：面板**看起来在工作**（消息区正常），
所以没人问它还少做了什么。

修法不只是补桩，而是**把桩补全并加一条断言**：`window` 只被用到三个成员
（`addEventListener`/`innerWidth`/`innerHeight`），focus 监听器改成被**记录**而不是丢弃；
新增用例断言 `startupToast === ''`、`startupClocks === 4`、focus 监听器恰好 1 个。
`setInterval` 也改成**记录**回调而不再丢弃，这才让测试能主动触发一次 health 轮询
（后开面板的恢复路径只能靠轮询到达）。

**证伪（三次，全部先过 `node --check`）**

| 把什么改坏 | 结果 |
|---|---|
| 去掉 IME 守卫（`if (false) return`） | **1 条红**（IME 用例） |
| 删掉 `adoptOpenApproval(payload)` 调用 | **2 条红**（认领 + 撤卡） |
| 删掉 `window` 桩（回到修复前） | **4 条红**，含新的启动断言 |

第三次格外重要：它证明**新加的启动断言确实绑住了那个隐蔽缺陷**。第一次尝试我用正则拼补丁，
拼出了语法错误（`node --check` exit 1）——那轮结果**不算证伪**，重做后才有效。

**测试**：315 → **320**（`npm test` 320 passed / 0 failed / 0 skipped）；`npm run check:extension` exit 0。
新增 5 条：启动完整性、IME 候选不发送、后开面板认领、已被别人答掉则撤卡、老宿主不误撤卡。

**交付**：只改 `extension/` → **重载 Chrome 扩展**即可，不需要重启 `dsh web`。

#### v13：在侧边栏里就能回答审批，回合不再无声卡死（本次修复）

在侧边栏发一条消息，模型一旦要碰需要授权的东西（读页面正文、点某个站点上的按钮），
**整轮就停在那里不动，而且什么都不说**。切回 DSH 图形界面才会看到一个审批框在等；
人一直待在 Chrome 里，那一轮就永远不结束。用户的原话是「不切回来看永远也不知道，然后就卡住了」。

**根因（一手，不是猜的）**

宿主把审批的作答方**从客户端组合出来**，而官方随产品发布的作答方只有一个：
`dsh-client-ui-approval/lib/client.js:282` 的 `ctx.remote.$on('approval/request', …)`，
即图形界面。插件侧插件完全可以自己当作答方——`dsh-acp/lib/index.js:1115` 就是
`ctx.on('approval/request', (request, next) => …)`——所以这不是「宿主不支持」，
而是**我们从来没注册过**。会话在等一个只有另一个窗口才会出现的问题。

**做了什么**

1. 新增 `lib/approval.js`：`ApprovalRelay.attach(ctx)` 用 `ctx.on('approval/request', …)`
   注册成第二个作答方，把问题通过 `NOTIFICATIONS.approvalAsked`（`approval/asked`）推给面板，
   面板经 `POST /browser-bridge/chat {action:'approval', id, outcome}` 作答。
   **桥接 socket 只单向承载「扩展 → 宿主」的请求**，所以回答走面板自己的 HTTP 路由。
2. **与图形界面赛跑，谁先答谁赢**（`Promise.race`）。在 DSH 窗口里干活的人，界面一点没变；
   输的那一方收到 `approval/settled` 把卡片撤掉——**一个还在为已决问题提供按钮的卡片，
   比没有卡片更糟**，按下去没反应，看起来像面板坏了。
3. **`unavailable` 不算答案**。它是宿主表示「没有作答方接手」的词，未接入图形界面时下游
   返回的正是它。若把它当成决定，面板一旦成为唯一界面就会**拒绝每一个请求**——
   于是「本来没人回答」被伪装成「用户拒绝了」。这一条是整个修复的承重墙，
   `test/approval.test.js` 用 `race()` 断言此时问题**仍然挂着**。
4. **只给两个按钮**：`PANEL_OPTIONS = ['allowed-once', 'rejected']`。宿主只授予
   `allowed-once`（`dsh-user-approval/lib/index.js:30-35` 的四个 outcome 里唯一算「允许」的），
   「永久允许本站」是桥自己在事后用 `persistentApproval` 决定的，写成按钮就是撒谎。
   ACP 同样只给两个。同时 `cancelled`/`unavailable` **不是按钮**，面板发来也一律拒绝。
5. 没有扩展连着时 `#notify` 返回 false，relay **完全不介入**（`return next()`），
   所以没装扩展的人用的是原来那条路径，一个字都没变。
6. `GET /browser-bridge/health` 暴露 `approval`（计数）与 `approvalPending`（在等的问题）：
   `delivered` 一直 0 而回合在等 ⇒ 问题根本没到插件；`delivered` 涨而 `byPanel` 不涨 ⇒
   问了但没人答。这两个计数器把「静默等待」变成可区分的状态。

**同时删掉的一条噪音**：面板此前在别处已有等待行的情况下又弹一条 toast，
这与 v4 定下的「控件说自己做什么，状态自己显示自己」相冲，已去掉。

**实测**（探针 `dsh web --port 3199 --no-open`，用户线上 3080 全程只读、未触碰）

| 请求 | 结果 |
|---|---|
| `GET /browser-bridge/health` | 出现 `approval` 七个计数器与 `approvalPending`，插件树正常加载 |
| `POST {action:'approval', id:'panel-1', outcome:'allowed-once'}`（不存在的 id） | `409 {"answered":false,"reason":"that question is no longer open"}` |
| `POST {action:'approval', …, outcome:'cancelled'}`（非法 outcome） | `409`，同样被拒 |
| 两次之后的 health | `refused: 2`，`byPanel: 0` —— 计数确实在动，不是恒定值 |

**证伪**（确认测试真的绑住行为，而不是恰好通过）

- 让卡片永不绘制 → 新增的 6 条用例**全红**（308 passed / 6 failed）。
- 让「拒绝」键发出 `allowed-once` → **恰好 1 条红**（313 / 1）。
- 让忙态不参与重绘比较 → **恰好 1 条红**（314 / 1，`the buttons go inert while an answer is in flight`）。

第三条抓到的是**我自己引入的 bug**：`renderApproval` 原本按 id 做早退，
于是「同一张卡片、按钮转为禁用」这一次重绘被整个跳过，双击会发出两次回答。
修法是把忙态并入比较键（`drawnApproval = \`${id}:${answering}\``），并补一条用例钉住它。

**未实测**：一次真实的审批从面板作答（需要「有 provider 凭据的宿主 + 已连接的扩展」，
探针两样都没有）。面板卡片本身由真跑面板模块的用例覆盖，但**那次点击没有在真 Chrome 里发生过**。

#### v12：代码块与整条回答的复制（本次新增）

侧边栏此前**没有任何复制能力**：想拿走一段代码只能手动框选，而在一条窄面板里框选会连气泡边缘
和相邻文字一起选中。这是每天都碰到的摩擦，也是「看着还不像成品」的地方。

**做了什么**

- **代码块变成一张卡片**：`extension/markdown.js` 的 `code` 块渲染成
  `div.code-block > (div.code-head + pre)`，头行左侧是语言（原版也有这一步，`code-block-language`），
  右侧是「复制」。
- **整条回答也能复制**：回答行尾部一个「复制」，默认不可见，鼠标悬停或键盘聚焦
  （`:focus-within`）时出现——原版把块级操作也挂在 hover 上（`_TableActions` 在 `:not(:hover)` 时 `opacity: 0`）。
  代码块那个按钮**常驻可见**：它很小，而且在头行里，藏起来反而找不到。
- **一个委托处理器管所有按钮**（`extension/sidepanel.js` 的 `transcript.addEventListener('click', …)`）。
  行是重建的，逐个按钮挂监听器就得每次重画后再挂一轮；委托还能让「已复制」两个字在重画之间活下来。
  按钮靠 `data-copy="code" | "answer"` 与 `closest` 定位作用域，**不靠 DOM 位置**。
- **复制的是渲染后的文本**，不是 markdown 源码：复制一条含 `**粗体**` 和反引号的回答，得到的是
  `Use bold and code here.`。
- **失败会说话**：剪贴板被拒时按钮**不会**变成「已复制」，而是弹「复制失败」。这里只走
  `navigator.clipboard`——面板页是扩展页（安全上下文），点击是用户手势，需要它时它就在；
  不写 `document.execCommand('copy')` 兜底，因为那是一条线上永远不跑、因而永远不被测的路径。

**顺带修掉的三处**

- 会话列表里那条「正在运行」的小圆点**从来没有名字**：6 像素的点是它要传达的全部信息，
  没有 `title`/`aria-label` 时只有已经知道它含义的人看得懂。现已接上早就存在、却没人读的 `session.running`。
- 清掉三个死键：`action.refresh`、`action.refresh.title`（v4 把刷新按钮换成了「标题 + `＋`」，键留下来了）、
  `history.title`。
- 新增 `test('no dictionary entry is dead weight')`，把「字典里不许有没人读的键」钉成不变式——
  死键是「本来打算接、后来忘了」留下的痕迹，那个没名字的圆点就是这么漏掉的。

**实测**：`npm test` **295 passed, 0 failing, 0 skipped**；`npm run check:extension` exit 0。
另把面板页挂在一个 http 预览宿主里跑起来、读回它的渲染结果核对：代码块头行确实出现
`python` 与「复制」，回答尾部确实出现「复制」，表格/列表/思考行/工具行/两个 chip 都在该在的位置。

**证伪**（新测试必须能抓住功能被拆掉）：把 `transcript.addEventListener('click', …)` 的注册改名使其失效后重跑，
4 条新面板用例中 **3 条立刻变红**——第 4 条断言的是「点别处不许复制」，拆掉处理器它自然还是绿的，
这是该用例的性质，不是它没在测东西。恢复后全绿。

#### v11：划词不出现的两个叠在一起的静默缺陷（本次修复）

> 扩展版本号本次从 `0.3.0` 升到 **`0.4.0`**。重载后再看
> `http://127.0.0.1:3080/browser-bridge/health` 的 `hello.version`，是 `0.4.0` 就说明重载生效了——
> 比在 `chrome://extensions` 上肉眼确认可靠。

现象：在页面上选中文字，侧栏**没有出现「选中内容」chip**，因此也无从知道它会不会被带进上下文。用户在 ACM 的一篇文章上复现（`dl.acm.org/doi/10.1145/3809166#sec-3`，选中「结构化剪枝」，面板只显示「当前标签页」那一个 chip，且当时刚重载过扩展）。

链路是：`content-selection.js` 上报 → service worker 转发给面板。**扩展一重载，所有已打开页面里的旧上报脚本就都死了**：它还在监听，但 `chrome.runtime` 已经失效，消息发不出去。Chrome 不会往已打开的页面重新注入声明式内容脚本，所以要靠面板重新注入这个文件来救活。这条恢复路径由两个**各自独立、且都静默**的缺陷废掉：

| 缺陷 | 位置 | 后果 |
|---|---|---|
| `chrome.scripting.executeScript` **需要目标页面的 host 权限**，而 manifest 的 `host_permissions` 只有 loopback | `extension/manifest.json`（旧） | 在任何真实网页上必然抛 `Cannot access contents of the page`，被 `catch { return }` 吞掉 |
| 上报脚本的「每文档只装一次」守卫是**早退** | `extension/content-selection.js`（旧，`if (globalThis.__dshSelectionReporter === true) return`） | 即使能注入，**死掉的那一份已经占了标记**，新副本立刻 return → 什么都没装。v4 为修「重载后失联」而加的恢复路径，被同一轮加的守卫废掉 |

两个缺陷形状相同：**失败 ⇒ 无 chip ⇒ 与「确实没有选中」完全一样**。除此之外还有第三处：`report()` 用 `try { chrome.runtime.sendMessage(...) } catch {}`，而 MV3 里上下文失效是 **reject 不是 throw** → 一个没人接管的 rejected promise（真 Chrome 里是页面控制台报错），且 `lastReported` 已经把它标成「报过了」，同一段文字再也不会重试。

修法：

1. `extension/manifest.json` 的 `host_permissions` 补 `"http://*/*"`、`"https://*/*"`，与 `content_scripts.matches` 对齐。**不新增权限警告**——声明 `https://*/*` 的内容脚本本来就会触发同一句「读取和更改你在所有网站上的数据」。
2. `extension/content-selection.js`：守卫从「早退」改成**新副本接管**——新副本先调旧副本暴露的 `dispose()`，再占据 `globalThis.__dshSelectionReporter`。`dispose` 只碰 DOM API（`removeEventListener`），因此**在一个 Chrome 已经作废的上下文里也能跑**；只有 `chrome.runtime.onMessage.removeListener` 需要包 `try`。
3. 同一个文件的 `report()`：发送失败（throw **或** promise reject）时回滚 `lastReported`，让下一次 `selectionchange` / `pointerup` 重试。
4. `extension/sidepanel.js` 的 `requestSelectionFromPage()`：**回包形状不对也算失败**（死端口会以 `undefined` resolve 而不是 reject），失败 → 重新注入 → 再问一次；两次都不成且 URL 是 http(s) 时，用 `error.reportStale`（「请刷新页面」）说一次（按 `tabId:url` 去重），而不是继续静默。另外面板窗口获得焦点时也再问一次——划完词回到面板正是 chip 必须正确的那一刻。

实测（探针 3199 + 全量测试）：

| 项 | 结果 |
|---|---|
| `npm test` | **426 passing, 0 failing, 0 skipped** |
| `npm run check:extension` | exit 0 |
| **把 `content-selection.js` 换回 `git show HEAD:` 的那一版，再跑新测试** | **3 条变红**（接管、死副本被替换、失败后重试），换回新版全绿 → 测试确实能抓住这两个缺陷 |
| 旧版跑「死副本被替换」用例 | 直接把进程打崩：`Error: Extension context invalidated.` —— 无人接管的 rejection，正是线上那个缺陷的真身 |

**测试写法**：上报脚本是自包含的 IIFE（只依赖 `globalThis`/`window`/`document`/`chrome`/`location`），所以测试用 `new Function` 把它跑在一个沙盘里，`install()` 返回**那一份副本自己的**发送记录。这一点是必须的——只数监听器个数没有鉴别力：**「接管成功」和「拒绝安装」都留下 1 个监听器**。第一版断言就是数个数，对修好和没修好的代码都通过。

#### v10：侧边栏现在能停下跑飞的回合（本次新增）


**问题**：一旦发出去，就**没有任何办法打断**。发送中的按钮只是 `disabled`，模型想 5 分钟你就等 5 分钟；发错一句话、模型理解偏了、它开始跑一个你不想让它跑的命令——都只能看着。

**宿主本来就有这个能力，缺的只是接线**。`SessionController.cancel(request)`（`dsh-api-session-controller/lib/index.js:2945`）转发到 `commands.cancel`（`:872`）：取 `ctx.agents.get(sessionId)`，找不到就抛 `session/not-found`，找到就 `agent.cancel({ kind: 'user' }, { keepInbox: true })` 并返回 `{ accepted: true }`。语义是**只取消当前活动回合，保留 pending inbox**——正在排队的那条消息不会跟着一起没。

三处接线：

- `lib/index.js` 的 `commands` 端口多一个 `cancel: bind(controller, 'cancel')`；`serveChatRoute` 多一条 `action === 'cancel'` 分支，成功 200、没停下 409。
- `lib/chat.js` 多一个 `cancel(sessionId)`：空 id、宿主没暴露该命令、宿主抛错三种情况各自返回**具名原因**而不是布尔值——面板要能把原因原样说给用户听。
- 面板把它做成**同一个按钮的两种状态**，不是第二个按钮：回合在跑时 `#send` 变成 `■`（`data-mode="stop"`，用 `CanvasText`/`Canvas` 反色而不是主题色，两个状态永远不会看错），点它发 `{action:'cancel'}`；取消成功才把 `currentSessionRunning` 置否，被拒绝则**留在停止状态**并把原因显示出来——假装停下了比不停下更糟。

**实测**（探针 `dsh web --port 3199 --no-open`，用户线上 3080 全程未碰）：

| 请求 | 结果 |
|---|---|
| `GET /browser-bridge/health` | `chatServices.cancel = true`（端口在真实宿主里解析得到） |
| `POST {action:'cancel'}`，会话未挂载 | `409 {"cancelled":false,"reason":"session \"…\" not found (not attached)"}` |
| `POST {action:'cancel'}`，不存在的会话 | 同上，原因带着那个 id |
| `POST {action:'cancel'}`，不带 id | `409 {"cancelled":false,"reason":"no session was named"}` |
| **先 `send` 再立刻 `cancel` 同一会话** | **`200 {"cancelled":true,"sessionId":"…"}`** |

**一个诚实的边界**：上面那次成功的取消之后 4 秒再取消同一个会话，宿主**仍然**回 `cancelled:true`——`agent.cancel()` 对已经没有回合的 agent 也会接受。所以「宿主说停下了」不等于「刚才确实有个回合在跑」。面板只在它认为有回合时才提供停止，且这个回答只用来把按钮切回发送态，不构成任何别的声明。

**面板侧的测试**（`test/panel-stream.test.js` 后半段）真跑 `extension/sidepanel.js`：空输入时按钮不可点、打字后激活、发送后同一槽位变停止、停止发的是 `cancel` 而不是把输入框内容发出去、取消成功后按钮切回且等待行消失、被拒绝时留在停止态并把原因显示出来、以及**回合运行中按 Enter 仍然照常入队**（停止按钮不是唯一的入口）。

> **这个 suite 与流式共用同一个文件**，因为面板是有状态的模块：第二个 suite 再 `import extension/sidepanel.js` 只会拿到缓存实例，它自己的宿主板子一次都不会被调用（runner 会先把所有 suite import 完再跑）。分成两个文件时正是这样失败的。

#### v9：侧边栏逐字流式输出（本次新增）

**问题**：回复是整段蹦出来的。发送后面板按 `[800, 2000, 4000, 8000, 15000]ms` 的阶梯重读记录，再靠 8 秒空闲轮询——模型写了 20 秒，你就在那 20 秒里看着一条「正在工作」的扫光。

**根因**：会话日志里**根本没有增量事件**。`dsh-session` 的事件类型全集是 `assistant/attempt`、`assistant/message`、`feedback/message-delete`、`feedback/message-put`、`request/context`、`system/message`、`user/message`——模型的一次 attempt 只在**写完之后**提交一条完整的 `assistant/message`。任何读记录的做法都不可能做到逐字。

**真正的通道**在 agent loop 里：`dsh-agent-loop/lib/index.js:1031` 每收到一个 provider chunk 就 `this.dispatch.emit('agent/assistant-stream', { frame })`。宿主自己的 web UI 就是靠它渲染打字机的（`dsh-api-session-controller/lib/index.js:1343` 在消费同一个事件）。两个形状细节决定了实现：

- frame 带的是 `attemptId`，不是 sessionId。`attemptId = \`${sessionId}:${attempt}\``（`dsh-agent-loop/lib/index.js:389`），所以 session 从冒号前缀取，面板才能忽略不属于自己的输出。
- frame **按 token 到达**。原样转发一条回复就是几千个 websocket 帧，所以按 `sessionId + kind` 聚合，80ms 一批。

**这条线上第三个方向**。此前只有两种帧：宿主→扩展的请求（有 `id`）、扩展→宿主的事件（有 `event`）。通知是第一种**宿主主动开口且不要回答**的消息，所以给它第三个键 `notify`，扩展不用猜收到的帧是哪种：

```js
// lib/bridge.js
notify(name, payload) {
  if (!this.live) return false
  try { this.socket.send(JSON.stringify({ notify: name, payload: payload ?? null })); return true }
  catch { return false }
}
```

`extension/background.js` 的 `handleFrame` **必须在找 `id` 之前**先看 `notify`：请求路径对没有 `id` 的帧直接 return，晚一步判断就等于所有通知都被丢掉。service worker 再 `chrome.runtime.sendMessage({ type: 'dsh-assistant-delta', payload })` 转给面板（面板是独立文档，自己拿不到这条 socket）。

**面板为什么画纯文本**：半张表格或半个 ``` 围栏每帧都会解析成不同的东西，边读边重排比不流式更糟。所以流式块是 `white-space: pre-wrap` 的纯文本 + 一个光标，**attempt settle 之后重读记录、用真正解析过的行替换它**。替换发生在 `drawTranscript` 里（「已 settle 且行签名变了」才让位），不是收到 `end` 就清空——否则重读一旦racing，已经显示的文字会先消失。已实测：结束后的 DOM 里 `.live` 节点数为 0，`.answer` 只多一条。

**顺带修掉的一个可见瑕疵**：`.working` 那条扫光读的是宿主的 `running` 标志，原本只在 5 秒轮询时更新——回复都显示完了、「正在工作」还挂着最多 5 秒。现在 attempt 结束时立刻重读一次会话列表。

**降级是明确的**：没有扩展连接时通知**丢弃、不排队**（记录永远可以重读，半个 token 流不行），计数在 `/browser-bridge/health` 的 `stream` 字段里：`frames` 涨而 `notifications` 不涨，说明没有扩展在收；`frames` 就是 0，说明 agent 事件根本没到这个插件。

**测试**：`test/stream.test.js`（宿主：聚合、flush 时机、跨会话隔离、无连接降级、通知在线上的形状、两半的字面量对齐）+ `test/panel-stream.test.js`（**把面板模块真的 import 进 `test/dom-shim.js` 里跑**：一个 live 块、reasoning 让位、跨会话忽略、中途打开的面板不显示半截、settle 后被正式行替换）。面板那一半此前只有字符串匹配，没有一行在跑。

> 弯路记录：第一版 DOM 桩不支持 `append('文本')`，markdown 渲染抛错——而面板那条路是 `.catch(() => {})`，**异常被吞掉后看起来和「记录没变化」完全一样**，表现为「live 块该消失却没消失」。桩补上文本节点后测试立刻转绿。

#### v8：截图从来没送进模型（本次修复）

**症状**：`browser_screenshot` 回答 `captured`，模型却看不到图，只剩一行
`Screenshot of the page (jpeg).`。

**根因**（三处独立证据）：宿主的图片块是
`ImageBlock = { type: 'image', attachment: ImageAttachmentRef }`——
`dsh-llm-deepseek/lib/index.js:1452` 的 `collectImageRefs` 读的是
**`block.attachment.attachmentId`**；`dsh-llm/lib/types/content.js:88-91` 的
`contentHasImage` 会递归进 `tool-result`；而同一个 adapter 的
`serializeMessagesWithImages`（`dsh-llm-deepseek/lib/index.js:171-185`）
**专门**把工具结果里的图片收进 `pendingToolImages`，再合并成一条带
`TOOL_RESULT_IMAGE_TEXT` 的 user 消息。也就是说「工具返回图片」是官方支持的路径。
插件发的却是 `{ type: 'image', mediaType, data }`：**内联 base64 不是合法块形状**，
块上没有 `attachment`。schema 能编译、工具报成功，所以没有任何一层报错——
字节确实拿到了，只是永远到不了模型。

**修法**：截图先交给宿主的附件服务换成引用，块里只放引用。
`lib/page-tools.js` 的 `execute` 现在走
`store.admitPromptContent([{ type: 'image', data, mediaType, name }])` → `{ type:'image', attachment }`，
`render` 只产出 `{ type: 'image', attachment }`。
**base64 不再进入工具值**（此前每张截图都会把一大段 base64 写进会话日志），
工具值里只剩 `{ attachmentId, mediaType, width, height, bytes, url, format }`。
`ports.attachmentStore` 是**按调用解析**的 getter——附件服务比插件激活更晚出现，
激活时读一次会永久冻住 `undefined`（这个坑本项目已经踩过一次）。

**降级**（都不抛异常、不制造假块）：附件服务不可用 → `ATTACHMENT_STORE_UNAVAILABLE`，
只回文字并说明原因；空截图 → `EMPTY_SCREENSHOT`；站点规则拒绝 → 一个字节都不入库。
用 `.png` 时 `mediaType` 在两侧都保持一致。

**测试**：新增 `test/screenshot.test.js`（8 条）。其中一条按**宿主真实的那次遍历**断言——
把 render 出来的 blocks 包进 `{ type:'tool-result', content: blocks }` 再递归找 image，
要求每个 image 都带 `attachment.attachmentId`。这正是旧代码会失败的地方。

**本修复只动宿主**：扩展没有改动，所以**只需重启 `dsh web`，不用重载 Chrome 扩展**。

#### v5：附件投递的两个真实缺陷（本次修复）

在你的「翻译」会话里，划词附件卡在暂存队列里没进模型。读原始会话日志（多帧 zstd，按 magic
`28 B5 2F FD` 逐帧解压）定位到两个**互相独立**的缺陷：

1. **重入被拒绝，而异常被吞掉。** `session/event` 是在会话**发布这次追加的过程中**回调的，
   此时再调 `agent.inject()` 又要往同一个会话追加，session 直接拒绝：
   `session append cannot reenter while another append is being published`。
   原代码把这条硬失败 `catch` 掉然后 `return`，于是「注入失败」和「队列本来就是空的」看起来
   完全一样。这个缺陷从附件功能上线起就存在——三个会话里躺着的残留附件就是它的化石。
2. **投递时机晚了整整一个 step。** 即使不报错，`agent.inject()` 的目标是 `next-step`：
   附件在 `request/context` **之后**才进 inbox。模型若第一步就作答，就永远看不到附件——
   这正是它回答「没有可翻译的内容」的原因。

修法是**三层**，因为投递必须赶在 `request/context` 之前：

1. `ContextAttachments#deliver` 不再在事件栈上跑，改由可注入的 `#schedule` 推迟（关掉重入窗口）；
2. **发送路径**（面板）在 `chat.send()` **之前**调 `deliverBeforePrompt(sessionId)`——
   热会话在这一步就投递完；
3. **冷会话**没有 agent，上一步必然失败。真正的时机是 `agent/created`：`prompt` 在
   `turn/start` **之前**创建 agent，此刻没有 append 在发布、队列也还在，所以改为
   `adoptAgent(agent)`——注册的同时把队列交出去。

`session/event` 只剩兜底（扩展主动推送等），并且会正确识别「队列已被前两层清空」而不重复投递。

两条路径都在探针上实测过：

| 路径 | 事件顺序 |
|---|---|
| 热会话（先 `create` 再发送） | `inbox/spliced` seq 4–5 → `turn/start` seq 7 → **`request/context` seq 18** |
| 冷会话（`create` 后重启探针，agent 全丢） | `inbox/spliced` seq 5 → `turn/start` seq 7 → **`request/context` seq 17** |

两条下面板都读回 `kind=context` 行（`上下文 · selected text from example.com, N chars`）。

`GET /browser-bridge/health` 新增 `contextDiagnostics`：`agents`（当前注册了活 agent 的会话）、
`pending`（仍有暂存附件的会话）、`diag`（最近 40 次投递决策，含每一条 `skip:` 的原因——
`deferred:no-agent` / `adopt` / `deliver:empty` / `skip:inject-threw`）。
排查「附件没生效」先看这里；`skip:inject-threw` 就是从上线起一直在发生的那个重入错误。

#### v7：侧边栏的模型 / 推理强度选择器（本次新增）

输入框下方多了一条控制条，左侧是当前会话的模型。每一处几何都对着 Codex 原版量出来，而不是自己估：

| 量 | Codex 原版的字面值（取自它自己的 CSS） | 这里的实现 |
|---|---|---|
| 面板宽 | `width: calc(var(--spacing) * 56)` = 224px | `max-width: 224px`、`min-width: 180px` |
| 面板圆角 / 内边距 | `rounded-2xl` = 16px、`p-[var(--menu-gutter,…)]` = 4px | `--radius-2xl`、`4px` |
| 行高 / 行圆角 | `--menu-item-height: calc(var(--spacing)*10)` = 40px、`--radius-xl` = 12px | 40px、`--radius-xl` |
| 行内边距 | `calc(var(--spacing)*1.5) calc(var(--spacing)*2)` = 6px 8px | 6px 8px |
| 选中态 | 行右侧的对勾 | 行右侧 `✓` |
| 触发按钮 | 「图标 + 模型名 + 强度名」，且类别名 `_ComposerDropdownLabelCategory` 默认 `display:none` | `模型名 · 强度名`，**没有「模型」二字** |

两处与 DSH 自己的选择器（`@deepseek-ai/dsh-client-ui-model-selection`）不同，都是有意为之：

1. **不做二级面板**。DSH 是「两个 cell → 二级面板」，选一次要点三次。这里是一个弹层：顶部一排推理强度、
   下面按 provider 分组的模型列表，**任一项单击即生效**（两次）。
2. **不写「模型」标题**。原版把它藏起来，这是"没有多余文字"的一手依据，而不是审美偏好。

**选择属于会话，而且这不需要任何同步代码**：`selectModel` 写的是该会话的 `model/selection` 事件，
读的是该会话的 `modelSelection` 投影（`view: { lastUsed, next: pending ?? lastUsed }`）；
全局默认那一层的文档原文就是 *"Default model selection for an Agent **without** a session-specific selection"*。
面板和 DSH 主界面读同一份投影，所以天生一致。

**一个真实缺陷，是探针抓到的**：`SessionController.modelCatalog()` 在宿主侧是 `async`
（`@deepseek-ai/dsh-api-session-controller/lib/types/catalog.js:8`），第一版漏了 `await`，缓存下来的是一个 Promise ——
它通过了 `typeof === 'object'` 检查，序列化后变成 `{}`，面板拿到的是一份"看起来加载成功、其实一个模型都没有"的目录。
我的测试桩当时写成了同步函数，正好掩盖了它（`docs` 里那条"桩必须复现宿主真实前置条件"的教训又应验一次）；
现在桩改成 `async`，并加了一条"目录必须是 await 之后的值、非对象必须被拒"的断言。

**没有做的事**：不与 DSH 主界面做控件级同步；subagent 会话的模型不可选（宿主会拒绝）；
新建会话时不能预设模型（`create` 不接受模型参数）。另外 `selectModel` 会顺带把选择存成全局默认，
这是宿主对**所有**调用者的行为（DSH 自己切换也一样），绕开它就得自己往会话里追加事件，让日志和投影打架。

#### v6：侧边栏把表格渲染成竖线（本次修复）

截图里模型给的对比表变成了一坨 `|`：

```
| 类型 | 作用 | 能否拒绝 |
|---|---|---|
| 必要（Strictly necessary） | 登录、购物车、安全校验 | 不能关，否则网站没法用 |
```

先读回该会话（`session-…`）的**原始输出**：模型给的是一张标准 GFM 表格，一个字符都没错。
问题在渲染器——`extension/markdown.js` 的块类型原本只有 code / heading / rule / quote / list /
paragraph，表格的每一行都掉进 paragraph，几行被 `\n` 连成一个段落，HTML 再把换行折成空格。

修法是给这个子集加一个 `table` 块：

- **认定条件**：一行含 `|`，且**下一行是分隔行**（`|---|:--:|`）。缺了分隔行的 `a | b` 仍是普通
  文本——判据放宽会把散文里的竖线吃掉，那比不渲染更糟。
- `\|` 是数据不是分隔符（先换成占位符再切分）；单元格按表头列数补齐或截断，短行不丢表。
- 渲染成 `div.table-scroll > table`：靠 `overflow-x: auto` 横向滚动，而不是把列挤成细条。
  **和 Codex 面板同一种做法**——官方产物 `block-actions-hKoQC7Sq.css` 里 `_TableScroller` 就是
  `scrollbar-width: thin; overflow-x: auto`，`_TableWrapper` 是 `width: fit-content`。
- 样式沿用面板已有的 4px 节奏 token：`padding: calc(var(--spacing) * 1.5) calc(var(--spacing) * 2.5)`。

实测（把该会话原文喂给渲染器）：块序列为
`paragraph → paragraph → paragraph → table → paragraph → paragraph → paragraph`，
输出 `div.table-scroll > table > thead(3×th) + tbody(4×tr × 3×td)`，粗体与段落切分不受影响。
新增 9 条测试：转义管道、缺分隔行仍是散文、短行补齐、对齐落到单元格、单元格内的行内标记、
表格打断段落且前后散文恢复。

> 这次改的是 `extension/` 下的文件，所以**要重载 Chrome 扩展**才生效（不是重启 `dsh web`）。
> `chrome://extensions` 里点该扩展的「重新加载」，然后在侧栏重新打开那个会话。

### 面板到底有多快（实测，不是估计）

这一节回答一个会被反复问的问题：**「面板为什么感觉慢 / 慢在哪」**。数字取自探针实例
（`dsh web --port 3199 --no-open`，与 `dsh web` 同一台机器、同一个 loopback），
每条路由跑 7 次取分布。

| 路由 | 触发时机 | 最小 | 中位 | 最大 |
|---|---|---|---|---|
| `GET /browser-bridge/chat` | 会话列表，每 5s | 8.6ms | 10.3ms | 40.4ms |
| `GET /browser-bridge/health` | 连接状态，每 5s | 1.1ms | 1.2ms | 2.6ms |
| `POST {action:'messages'}` | 读会话，每 8s | 1.2ms | 1.4ms | 18.6ms |
| `POST {action:'models'}` | 模型目录，开面板一次 | 1.1ms | 1.2ms | 2.0ms |

**结论：宿主不是瓶颈。** 全部往返都在毫秒级，最慢的一项（会话列表 10ms）也远低于
人能感知的阈值。**从「按下发送」到「第一个字出现」的时间几乎全部来自模型本身。**

**一次发送引起 7 次 transcript 重读**（实测：`at=0, 1200, 3200, 6436, 7200, 14200, 14436`，
从按下发送起算）。来源是 `for (const delay of [800, 2000, 4000, 8000, 15000])`
这 5 个定时器，加上 `end` 帧触发的一次，加上发送被接受时的一次。

**7 次看起来浪费，但它不造成任何可见影响**——`drawTranscript` 在数据没变时
`signature === drawnSignature` **直接 return，不碰 DOM**（这条优化从面板第一版就在）。
定时器的职责是「流式失效时的兜底」：对没有流式的旧宿主，它们仍然是唯一的更新途径。

> 这 5 个定时器**不建议**为了「省几次请求」删掉：它们换来的是「旧宿主也能用」，
> 而代价是每次发送 7 个毫秒级的 loopback 请求 + 7 次 JSON 序列化比较。

### 与 Codex 能力的差距

| 能力 | 状态 |
|---|---|
| auto-review 的**独立 reviewer agent** | ❌ 未实现。官方定义是「用一个独立 reviewer agent 替换人工审批」+ 断路器（连续 3 次拒绝 / 最近 50 次内 10 次拒绝中断本轮）。这需要第二条模型路由和独立策略。本实现只提供 `autoReview` 开关的**语义等价物**（关闭后一律问你），README 不假装有 reviewer agent |
| 多浏览器（Edge / Brave / Opera / Vivaldi） | ❌ 未实现。官方靠原生消息宿主 + `openai-bundled` 插件市场分发；本扩展只用 `chrome.*` API，代码结构留了适配层但没有实现 |
| 内建浏览器（localhost 用） | ❌ 不实现。DSH 有自己的 GUI，Chrome 本来就能开 localhost |
| 书签读写 | ❌ 不实现（官方给了权限但无明确场景） |
| 云浏览器 / 手动接管 | ❌ Codex Cloud 独有 |
| 元素高亮 / 「正在被控制」提示 | ❌ 未实现（官方是否有此 UI 亦未确证） |
| 侧边栏**流式输出** | ✅ 已实现（v9）。宿主用 `agent/assistant-stream` 帧合并成 80ms 一批的通知，走 `notify` 键推给 service worker 再转给面板。面板画纯文本+光标，attempt settle 后用解析过的正式行替换。**限于：** 只有模型输出是流式的；附件/`@` 状态仍是轮询 |
| 侧边栏自动带上**整页正文** | ❌ 有意不做。发送时自动附带的是当前标签页的**身份**（标题+URL），正文要显式加入：整页文本上千 token，自动带上会让每次提问都悄悄变贵 |
| **`@` 提及标签页** | ✅ 已实现（v23）。打 `@` 打开候选，按最近访问排序、按标题/URL 过滤、同名时用 URL 区分、按协议白名单排除读不了的页。**限于：** 只提及**标签页**；官方还有 `Sites` / `Files` / `ChatGPT conversations` / `Mac apps` 等分组，本实现没有那些数据源 |

### 未确证的实现假设

- `approval.request()` 返回 `allowed-once` 时，**时长由面板上按下的那个按钮决定**
  （`scope: 'once'` 不记录任何授予；`scope: 'conversation'` 记为 `thread`）。
  **（v34 更新）** 这一条以前写的是「本实现把它记为『本会话该站点免问』」——
  那正是缺陷本身：面板只有一个写着「允许一次」的按钮，却按配置默认值记成了会话级授权。
  现在两个按钮各自带 `scope`，宿主读 `scope` 而不是读 `persistentApproval` 默认值。
  旧面板或图形界面不带 `scope` 时，才回退到配置默认值（这条回退路径有测试）。
- **没有「永久允许」按钮**，而官方原版有（`approvalRequestCard.alwaysAllow`）。
  原因是能力而不是取舍：授予表在内存里（`lib/grants.js` 明确「Deliberately not persisted」），
  harness 一重启就没了，写「永久允许」的按钮无法兑现。要补上它得先让授予落盘，
  并且要处理「重启后如何确认还是同一个人在看同一个任务」这个问题。
- `turn` 时长的近似：turn 边界在工具上下文里不可观测，所以用「5 分钟无浏览器活动」近似。
  误差方向是**偏向重新询问**，不会偏向放宽授权。
  **注意**：`scope: 'once'` **不走这条近似**——它什么都不记录，
  因为一个 `turn` 授予在 5 分钟窗口内仍然覆盖后续调用，那已经超出「一次」的字面意思。
- chip 的确切视觉、发送后是否留存、`@` 提及标签页的交互细节——这三条官方文档没有明确记载，
  本实现按「显式加入 + 可见 + 可 X 掉」的语义做，以你的实际体验为准。
  **（v23 更新）** 其中 `@` 提及现已实现；官方产物里能读到的是它的**候选字段与分组名**，
  以及它用一个 9.7KB 的 fuzzy scorer 排序——本实现按标题/URL 子串匹配，因为那是侧栏负担得起、
  而行为对真实输入相同的做法。
- **会话服务是「调用时解析」而不是「激活时解析」**：`sessions` / `sessionQuery` / `sessionController`
  都用 `ctx.get` 读而不是 `inject`，为的是没有会话服务的 profile 里浏览器半边照样能用。代价是
  它们可能在插件激活时还没注册——实测 `sessionController` 就是如此，激活时抓到 `undefined` 会让
  面板既不显示记录也拒绝发送。所以三个都改成每次调用时解析，并加了 `lib/ingest.js` 之外的一处
  诊断：`GET /browser-bridge/health` 的 `chatServices` 会如实报告哪些端口真的拿到了。
- **冷会话的回放按 id 缓存整个插件生命周期**：冷会话是「本进程没挂着」的会话，没有东西在写它，
  所以一次回放就够；面板每 8 秒读一次记录，不缓存的话就是每分钟把日志从磁盘回放十几次。
  发消息时丢弃该缓存——唯一会让它过期的事。
- **面板的附件走 `send` 请求体，不走事件通道**：右键菜单那条路是「先发事件、再等用户发消息」，
  没有东西和它竞争；面板的附件若也那样发，就会和紧随其后的 prompt 抢两条 socket，
  偶尔把上下文挂到**下一条**消息上。所以面板把附件放在同一个 `send` 请求里，宿主在投递前先暂存。

### 官方文档自身矛盾

`browser.md` 说内建浏览器「不支持登录」，`chrome-extension.md` 说它「supports sign-in」。
两处冲突无法调和，本实现不涉及内建浏览器，因此不受影响——记录下来以免以后误引。

---

## 卸载

```powershell
dsh plugin --profile web remove dsh-browser-bridge
```

然后重启 `dsh web`，并在 `chrome://extensions` 移除扩展。

插件留下的两份状态文件可以直接删除：

- `~/.dsh/storages/dsh-browser-bridge.json`（令牌）
- `~/.dsh/storages/dsh-browser-bridge-context.json`（暂存的上下文附件）

---

## 排错

| 症状 | 原因与处理 |
|---|---|
| DSH 状态点一直红、提示「扩展未连接」 | 扩展选项页点「测试连接」。检查 dsh web 是否在跑、端口是否一致、令牌是否复制全了 |
| 扩展载入报错 | 看 `chrome://extensions` 的错误详情；先跑 `npm run check:extension` |
| 工具报「请先关闭该标签页的 DevTools」 | Chrome 一个标签页只允许一个调试器会话 |
| `browser_upload` 失败 | 需要在扩展详情页打开「允许访问文件网址」 |
| `browser_eval` / `browser_cdp` 报需要 Developer mode | 到 设置 → 插件 → browser-bridge 打开 `developerMode` |
| `browser_*` 报某站点被拒绝 | 该域名命中了规则表里的 `deny`，去设置里改 |
| 侧栏显示「还没有会话」，点 `＋` 报 `HTTP 400` | **宿主还是旧代码。** 扩展在 `chrome://extensions` 点一下重载就换了，宿主得重启 `dsh web`——两边路由形状必须一致。面板遇到这种不一致会直接提示「请重启 dsh web（宿主是旧版本）」，看到这句就是这个原因 |
| 划词后 chip 没出现 | 先看是不是**刚重载过扩展**：旧页面的上报脚本已失效，面板会在打开/切标签页/重新聚焦时自动重注入，注入不成就显示「请刷新页面」（v11 修）。仍然不行时：右键菜单里确认用的是 `Add selection to DSH context`；另外确认 DSH 里至少有一个会话 |
| 重启 dsh 后暂存的附件还在但目标会话没了 | 附件按会话暂存；找不到目标会话时 `contextTargetSessionId` 可以指定一个 |
| 发了消息，但面板里没有 `上下文 · …` 那一行 | 附件没进上下文。先看 `GET /browser-bridge/health` 的 `contextDiagnostics.diag`：`skip:inject-threw` 是注入被拒（v5 已修），`skip:no-agent` 是会话还没有活 agent（会留到唤醒它的那条消息）。`pending` 里出现该会话说明附件还卡着 |

---

## 目录结构

```
packages/dsh-browser-bridge/
├─ cordis.patch.yml       # 向 web profile 插入一行宿主行
├─ package.json           # dsh.bundle.patch + dsh.client
├─ lib/
│  ├─ index.js            # 装配：路由、工具注册、agent/session 事件接线
│  ├─ bridge.js           # WebSocket RPC：关联、超时、取消、断连结算
│  ├─ token.js            # 令牌落盘与常量时间比较
│  ├─ auth.js             # 令牌 + Origin + 环回三道判据
│  ├─ protocol.js         # 双端共享的方法契约、CDP 域黑名单
│  ├─ policy.js           # 站点策略引擎（规则表、通配、最严合并）
│  ├─ grants.js           # 授权表 + 敏感动作分类
│  ├─ context.js          # 上下文附件：暂存、去重、注入时机、持久化
│  ├─ tools.js            # 会话与标签页工具
│  ├─ page-tools.js       # 页面工具（统一审批门）
│  ├─ config.js           # 设置默认值与 schema 描述
│  ├─ settings.js         # 设置命名空间注册
│  ├─ deps.js             # peer 依赖双路解析（本地 → $DSH_HOME/profiles/node_modules）
│  ├─ chat.js             # 侧栏对话：会话列表（与 DSH 同源）、事件→行的语义映射、投递
│  ├─ ingest.js           # 右键菜单/选区落成上下文附件
│  └─ client.js           # 浏览器端 UI（手写 __ModuleLoader__ 包装）
└─ test/                  # 426 条，含真实 Chrome 端到端

extension/
├─ manifest.json
├─ background.js          # service worker：WS 客户端 + CDP 执行器
├─ page-distill.js        # DOM 快照蒸馏（纯函数，测试共用同一份）
├─ content-selection.js   # 选区上报
├─ locales.js             # 侧栏文案（zh 是键集真源）+ 相对时间
├─ markdown.js            # 最小 Markdown 渲染器，含表格（纯解析 + DOM 装配，无 innerHTML）
├─ model-menu.js          # 模型/推理强度弹层的纯函数（放在 extension/ 是因为侧栏 import 不到目录外）
├─ options.html/.js       # 令牌与端口
└─ sidepanel.html/.js     # 侧边栏
```
