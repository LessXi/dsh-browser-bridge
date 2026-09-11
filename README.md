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

**没有流式输出**：发送后按短阶梯重读记录 + 空闲轮询。这是已知差距，见文末。

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
npm test                          # 全部 241 条
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

代价是：**编辑器、`node --check`、以及从本仓库直接跑测试需要后者可达**。两种做法都行：

```powershell
# A. 本地安装依赖（会覆盖下面的联接，也是最干净的方式）
pnpm install

# B. 或者临时把 profile 的模块树接到本包上（Windows 目录联接）
cmd /c mklink /J packages\dsh-browser-bridge\node_modules "$env:USERPROFILE\.dsh\profiles\node_modules"
```

`packages/*/node_modules/` 已在 `.gitignore` 里——它只是本地便利，不是产物。

> 沙箱环境注意：`node --test` 会为每个文件 fork 子进程并走管道捕获输出，某些沙箱禁止建管道，
> 会以 `spawn EPERM` 在跑任何断言前失败。所以这里的测试装置是自带的、单进程、零依赖的
> （`test/harness.js`），`npm test` 在任何环境都能跑。

---

## 诚实的能力边界

### 已验证 / 未验证

**已自动化验证**：上面四层测试，241 条。包括真实 Chrome 驱动的快照、点击、输入、截图。

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

### 探针实例上已跑通的部分

用一个独立实例（`dsh web --port 3199 --no-open`，不碰你的 3080）实测：

| 检查 | 结果 |
|---|---|
| `GET /browser-bridge/chat` | 3 个分组（两个具名工作区 + 未分组），**0 条 `[tool-result]`、0 条裸 UUID、0 条归档会话** |
| 会话与 DSH 同步 | 与 DSH 侧栏同一个调用 `sessionController.list()` + 同一份 `archivedSessionIds`；归档 13 条、子代理会话全部不出现 |
| `POST {action:'messages'}`（`session-……`） | **8 行**：`user / reasoning×3 / tool×3 / assistant`，与该会话日志里的 34 个事件逐一对上。系统提示、技能目录、`tool/result`、turn/step 边界全部不产出。修复前这里是整段系统提示 |
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

最后一步在探针上报错 `llm-deepseek: no API key for provider route "deepseek-official"`——
**这是探针进程拿不到凭据，不是插件缺陷**。已核对 `$DSH_HOME/.credentials.yaml`：里面只有一条
`client-connection/browser-session`（DSH web 客户端自己的会话凭据），**没有任何 provider key**；
你的 3080 实例的 key 只活在那个进程的环境里，第二个实例不会继承。
所以「模型真的回复」这一条要在**你自己的实例**上看：重启 `dsh web` 让新代码生效，再从侧栏发一条。

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

### 与 Codex 能力的差距

| 能力 | 状态 |
|---|---|
| auto-review 的**独立 reviewer agent** | ❌ 未实现。官方定义是「用一个独立 reviewer agent 替换人工审批」+ 断路器（连续 3 次拒绝 / 最近 50 次内 10 次拒绝中断本轮）。这需要第二条模型路由和独立策略。本实现只提供 `autoReview` 开关的**语义等价物**（关闭后一律问你），README 不假装有 reviewer agent |
| 多浏览器（Edge / Brave / Opera / Vivaldi） | ❌ 未实现。官方靠原生消息宿主 + `openai-bundled` 插件市场分发；本扩展只用 `chrome.*` API，代码结构留了适配层但没有实现 |
| 内建浏览器（localhost 用） | ❌ 不实现。DSH 有自己的 GUI，Chrome 本来就能开 localhost |
| 书签读写 | ❌ 不实现（官方给了权限但无明确场景） |
| 云浏览器 / 手动接管 | ❌ Codex Cloud 独有 |
| 元素高亮 / 「正在被控制」提示 | ❌ 未实现（官方是否有此 UI 亦未确证） |
| 侧边栏**流式输出** | ❌ 未实现。面板用「发送后短阶梯重读 + 8 秒空闲轮询」，所以回复是整段出现而不是逐字。做流式要第二套协议（追加式事件流 + 断线重连续传），在这个尺寸的面板里收益与风险不成比例 |
| 侧边栏自动带上**整页正文** | ❌ 有意不做。发送时自动附带的是当前标签页的**身份**（标题+URL），正文要显式加入：整页文本上千 token，自动带上会让每次提问都悄悄变贵 |

### 未确证的实现假设

- `approval.request()` 返回 `allowed-once` 时，本实现把它记为「本会话该站点免问」（`thread`）。
  这是 Codex 的产品默认值，但 DSH 的一次性授权语义与「记住」之间需要这一层映射，映射规则
  写在 `lib/grants.js` 顶部注释里。
- `turn` 时长的近似：turn 边界在工具上下文里不可观测，所以用「5 分钟无浏览器活动」近似。
  误差方向是**偏向重新询问**，不会偏向放宽授权。
- chip 的确切视觉、发送后是否留存、`@` 提及标签页的交互细节——这三条官方文档没有明确记载，
  本实现按「显式加入 + 可见 + 可 X 掉」的语义做，以你的实际体验为准。
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
| 划词后 chip 没出现 | 右键菜单里确认用的是 `Add selection to DSH context`（选中上下文才有这一项）；另外确认 DSH 里至少有一个会话 |
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
│  ├─ chat.js             # 侧栏对话：会话列表（与 DSH 同源）、事件→行的语义映射、投递
│  ├─ ingest.js           # 右键菜单/选区落成上下文附件
│  └─ client.js           # 浏览器端 UI（手写 __ModuleLoader__ 包装）
└─ test/                  # 241 条，含真实 Chrome 端到端

extension/
├─ manifest.json
├─ background.js          # service worker：WS 客户端 + CDP 执行器
├─ page-distill.js        # DOM 快照蒸馏（纯函数，测试共用同一份）
├─ content-selection.js   # 选区上报
├─ locales.js             # 侧栏文案（zh 是键集真源）+ 相对时间
├─ markdown.js            # 最小 Markdown 渲染器，含表格（纯解析 + DOM 装配，无 innerHTML）
├─ options.html/.js       # 令牌与端口
└─ sidepanel.html/.js     # 侧边栏
```
