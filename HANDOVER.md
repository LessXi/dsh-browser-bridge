# 交接工作单：DSH 浏览器桥接插件

> **当前状态：v109 已交付并入库。** 下一节就是最新的一轮改动；下面标 v108/v107/v106/v105/v104/v103/v102/v101/v99/v98/v97/v96/v95/v94/v93/v92/v91/v90/v89/v88/v87/v86/v85/v84/v83/v82/v81/v80/v79/v78/v77/v76/v75/v74/v73/v72/v71/v70/v69/v68/v67/v66/v65/v64/v63/v61/v60/v59/v58/v57/v56/v55/v54/v53/v52/v44/v43/v42/v41/v40/v39/v38/v37/v36/v35/v34/v33/v32/v31/v30/v29/v28/v27/v14/v13/v12/v11/v10/v9/v8/v3/v4/v5/… 的段落是历史层，越往下越旧。
> 只想知道「现在能做什么、下一步做什么」，读到 v109 那一段为止即可。
>
> **环境前提：本仓库不需要 `pnpm install`。** 全新克隆后 `npm test`（713 条）与
> `npm run check:extension` 都能直接跑通——测试是零依赖的自建 runner
> （`packages/dsh-browser-bridge/test/run.js`），宿主 peer 依赖只在真实 dsh 进程里解析。
> （真浏览器 e2e 那 4 条需要机器上有 Playwright Chromium 或 Chrome for Testing；
> 没有时会**跳过并说明**，不会失败。）
>
> **要看界面**：`README.md` 的「界面」一节有 3 张主视觉海报（`docs/posters/`）与
> 15 张界面状态（`docs/screenshots/`）。`node tools/poster.mjs` 重渲海报，
> `node tools/gallery.mjs` 重渲界面状态，`node tools/preview.mjs --list` 列出全部场景。
>
> **`<repo>` 是本仓库在你机器上的位置**——文档里凡是出现 `<repo>\...` 的路径，
> 换成你自己克隆它的目录即可（例：`cd <repo>`）。
>
> **已入库**：v3→v109 的全部改动已提交并推送到 `origin/main`。工作区干净。
> （v108 是 `0bfdf20`，v107 是 `afc1ac1`，v105 是 `4b1f0aa`，v103 是 `91fa7dd`，v102 是 `77b75e3`，v101 是 `cc33dd9`，v99 是 `bff292d`，v92 是 `e3ad6ba`，v91 是 `3d96bf1`，v90 是 `767e4cd`，v80 是 `53602de`，v79 是 `5c8ee77`，v78 是 `768e653`，v77 是 `322fdc4`，v75 是 `e0ef3ee`，v74 是 `bb5af8d`。）

> ## v109：假宿主少了一个方法，于是「发送」这条路在仪器里整段不可观测

**症状**：探针按下发送，宿主日志里**明明收到了** `{"action":"send",...,"text":"ZEBRA_PROBE"}`
且回了 `accepted: true`，而屏幕上**什么都没有**：输入框里的字还在、消息没画上去、
下一次轮询之后仍然没有。看起来像「发送坏了」。

**真相不是产品，是仪器。** 面板紧接在发送被接受之后调 `clearDraft()`，而那里面是：

```js
chrome.storage.local.remove(DRAFT_PREFIX + sessionId).catch(() => {})
```

`tools/preview.mjs` 的假 `chrome.storage.local` **只有 `get` 和 `set`**。缺了 `remove`
就在这一行抛 `chrome.storage.local.remove is not a function`，而它后面**整段发送成功路径**
——清空输入框、`mentioned = null`、`renderContexts()`、`renderLive()`、`renderWorking()`、
`drawTranscript([...rows, { kind: 'user', text }])` —— 一次都没执行。

```
出错了：chrome.storage.local.remove is not a function
```

#### ★ 为什么 713 条测试全绿却没看见

面板一共用三个方法：`get`、`set`、`remove`。

| | `get` | `set` | **`remove`** |
|---|---|---|---|
| 面板实际调用 | ✓ | ✓ | **✓** |
| 测试替身（`panel-stream.test.js` 的 `makeStorage`） | ✓ | ✓ | **✓** |
| **preview 假宿主** | ✓ | ✓ | **✗** |

**只有 preview 那个替身缺它。** 所以套件测得到发送路径（替身是完整的），
而 preview 里的发送路径整段是死的——而 preview 恰恰是唯一能截图、能发真实按键、
能逐帧量耗时的那个仪器。**一个缺方法的替身，把整个仪器对这条路径变成了瞎子。**

#### 修法（`tools/preview.mjs`）

1. 补 `remove: async (...names) => { ... }`（`names.flat()` 后逐个 `delete`），与面板
   调用的三种方法对齐。
2. **顺带补上发送本身**：假宿主原来对 `send` 只回 `accepted: true`，然后继续回夹具——
   所以面板画的 echo 会被下一次轮询抹掉，「我的消息送到了吗」在仪器里不可判定。
   现在发出的文本进入 `sentMessages`，并**先于夹具**参与 `messages` 的分页返回，
   与真宿主一致。（同文件 L324 附近的 `create` 早就为完全同形的问题修过一次：
   假宿主不承认新建的会话，于是按钮看起来是死的。）

#### 修复后的读数（`.tmp-run/probe-send-path.js`）

| 读数 | 修复前 | 修复后 |
|---|---|---|
| 消息出现在屏幕上 | **false** | **true（16.5ms）** |
| 扛过下一次轮询 | **false** | **true** |
| 掉帧数 | 0 | 0 |

16.5ms 恰好一帧——读者按下发送，消息在**下一帧**就到位了。

#### 新增守卫测试

`packages/dsh-browser-bridge/test/screenshots.test.js` 的
`the preview host answers every chrome.storage method the panel calls`：
从 `extension/sidepanel.js` 里**抽出**面板真正调用的方法名，然后要求
**preview 假宿主与测试替身都实现它们**。三处一起对齐，两个替身不会再朝相反方向漂移。
变异验证：把 `remove:` 改名为 `removeXXX:` → 新测试变红并报出
「the preview's fake chrome.storage.local has no remove(), so anything the panel
does after calling it is invisible to every probe」，还原后恢复。

#### ★ 同轮的第二条结论：一条悬了两轮的「性能账」正式关闭

本轮原本要量「上翻历史会不会越来越慢」，第一版判据（「等到稳定」）量到
**每次点击都是 33ms，且完全不随窗口增长**——114 行 34.7ms、402 行 33.4ms。
这与已知的渲染曲线矛盾（第 7 轮实测 60 行 2.4ms、470 行 18.2ms）。**读数不随被测变量
变化时，先怀疑判据。** 果然：「等到稳定」要求连续两帧相同，**至少有 2 帧的固定下限**。

换成**逐帧间隔**（浏览器 60Hz 排帧，一次 18ms 的同步工作会把那一帧的间隔撑到约 33ms）
之后：

| 场景 | 行数 | 最长帧 | 掉帧 |
|---|---|---|---|
| 上翻一页 | 114 → 450 | **16.8ms** | **0** |
| 按下发送 | 60 | **16.8ms** | **0** |

**450 行的上翻，最长帧恰好一帧，一次都没掉。** 判据本身验证过：人为同步阻塞 50ms，
它读到 **49.9ms**——它能看见卡顿，而它说这里没有。

所以第 7 轮那笔「18.2ms 重建」的账**在读者的关键路径上并不成立**。`HANDOVER` 的 v72
段落早就记载过原因：**v71 量的是探针自己造的最坏情况**（把整份行集克隆一遍再
`replaceChildren`），不是面板真正走的路径。这条现在有了正面证据，不必再查第三遍。

#### 验证读数（已绿）

- `npm test` → **713 passed, 0 failed, 0 skipped**
- `npm run check:extension` → exit 0
- 画廊 15 张重渲后**只有 `SOURCES.json` 指纹变**，图片**逐字节未变**
- 判据有效性：人为阻塞 50ms → 帧间隔读到 49.9ms

#### 本轮新增探针（`.tmp-run/`，被 gitignore）

- `probe-send-path.js` —— 判据本体：消息是否上屏、是否扛过轮询、最长帧、掉帧数。
- `probe-paging-frames.js` —— 逐帧间隔判据（有分辨率），量上翻历史的成本。
- `probe-paging-cost.js`、`probe-paging-breakdown.js` —— **判据错的两版**，保留以说明为什么换掉。
- `probe-frame-judge-valid.js` —— 判据自身的有效性验证（阻塞 50ms 必须被看见）。

> ## v108：画一条回答要多久 —— 量完判定**不该修**，并把判据做成可复现的

**这一轮没有改产品代码，答案是否定的，而否定的答案同样要入库。** 第 7 轮量过 470 行
重建 18.2ms（布局 16.0ms）、第 46 轮起过三个头都没得出结论，两次都只剩一句
「成本在布局」。这轮把它量到底，并且**用读者自己的回答**而不是编的样例。

#### 一、为什么必须用真实回答

编的样例只能测到作者想到的结构，而那是**已知能跑通的那一种**。这台机器上 11261 条
真实 assistant 文本的分布是：中位 **90**、p75 136、p90 204、p95 267、p99 **2116**、
p999 3805、**最长 35159**。中位数只有 90 字符——所以「一条回答有多长」这件事，
凭直觉猜一定会猜错，而成本恰恰由长尾决定。

#### 二、读数（分开量，因为两者优化方向完全不同）

| 回答长度 | 解析 + 建节点 | **挂载 + 布局** | 合计 | 屏幕上占多高 |
|---|---|---|---|---|
| 35159 字符 | 0.6ms | **100.7ms** | 101.3ms | 19645px |
| 10123 字符 | 0.1ms | 12.5ms | 12.6ms | 6665px |
| 2 字符 | 0.3ms | 0.3ms | 0.6ms | 35px |

**`layoutShare: 99`** —— 成本 99% 在布局。所以「优化 markdown 解析器」没有杠杆
（最长的一条只要 0.6ms），「少建节点」也没有（25 个元素 vs 100.7ms）。

#### 三、★ 判定：不修，因为越线的回答只有 0.03%

按上表两点线性插值，跨一帧（16.7ms）的长度约 **11280 字符**。11261 条真实回答里
**只有 3 条（0.03%）** 超过它。

为 0.03% 的机率引入虚拟化（跳过屏外布局），代价是第 7 轮已经确认的滚动锚定行为：
`content-visibility: auto` 让 `scrollHeight` 从 38375 掉到 6594（**永久失真 82.8%**），
而 `grewEarlier` 那一支恰恰靠它。**用每一次滚动都轻微的错，换 0.03% 的机率不卡一下，
是错的交易。**

#### 四、★ 判据做成了可复现的（这轮真正的交付）

`tools/preview.mjs` 新增 `--real-answers <file.js>`：把读者自己的回答文件注入页面，
供探针量真实成本。**不改产品代码，但让这个结论以后不必重新量一遍。**

两个设计判断：

1. **回答从文件传入，不进仓库**。那是读者的对话，不是本仓库的夹具。
   `.tmp-run/extract-long-answers.mjs` 负责从真实日志抽出来（zstd 多帧逐个解压）。
2. **只注入长尾代表**（最长 + 中位 + 最短 + 次长几条），不是全量 9099 条。
   全量是 2.3MB，要作为一条 CDP 表达式传进页面——**测量本身会变成负担并干扰读数**。

#### 五、★ 一处我自己引入又修掉的错误（值得记）

第一版把 `--real-answers` 的读取放在 `bootstrapSource()` **调用之后**。标志解析正常、
文件读到了、`--probe` 也跑了，只是**注入是空的**——探针会报「没有数据」而不是报错。
这正是本仓库反复记录的**静默失效**。测试因此断言**读取位置在调用之前**
（`readAt < callAt`），而不只是断言标志存在。

另外两个坑：`bootstrapSource` 是独立函数，`realAnswers` 必须**作为参数**传入
（自由变量在运行时是 `ReferenceError`）；注释里**不能出现反引号**——那段注释在模板
字面量内部，一个反引号会提前终止模板并使整个文件解析失败。

#### 六、验证读数（已绿）

- `npm test` → **712 passed, 0 failed, 0 skipped**
- `npm run check:extension` → exit 0
- 新测试 `the preview tool can carry a real answer into the page, and does not invent one`
  （4 条断言：标志存在、文件被读取、**读取先于调用**、默认值为空）
- 通道双向实测：给文件 → `injectedCount: 7`、`longest: 35159`、`lengthsMatch: true`（逐字）；
  不给文件 → `injectedCount: 0`（**反例是关键**，只测正例的话「无论如何都注入」也会通过）
- 画廊 15 张重渲后**只有 `SOURCES.json` 指纹变**，图片**逐字节未变**——证明工具改动
  对既有渲染零影响

#### 七、本轮新增探针与工具（`.tmp-run/`，被 gitignore）

- `probe-real-answer-cost.js` —— 判据本体：走真实面板路径（**挂进 `#transcript` 并强制
  布局**），分报 `computeMs` / `layoutMs` / `heightPx`。
- `answer-length-distribution.mjs` —— 真实长度分布 + 跨帧点插值 + 越线比例。
- `extract-long-answers.mjs` —— 从真实日志抽长尾代表（zstd 多帧逐个解压再拼接）。
- `probe-real-answers-channel.js` —— 通道双向验证（正例逐字、反例缺省）。

> ## v107：浮层只盖住了像素，没盖住键盘

**症状**：宿主连不上时，面板中央出现「连不上 dsh web」的浮层。它是不透明的，盖住整个内容区。但**它只盖住了像素**——浮层之下的元素仍然留在 Tab 顺序里：Tab 把焦点移到它们上面，焦点环画在不透明浮层**下面**（读者看不见焦点在哪），而它们的按键**去不了任何地方**。

**实测**（`.tmp-run/probe-tab-under-blocked.js`，新场景 `hostDiedAfterLoad`）：
```
invisibleStops: [ '#history (380x666)', 'button.session (368x34)' ×4,
                  'button.row-button (356x34)' ×3 ]
hitsInvisibleTargets: true
```
**8 个可聚焦元素**在浮层下面。另一个探针（`.tmp-run/probe-blocked-keyboard.js`）分两层量：① 功能上按 Enter **什么都没发生**（`sessionChanged: false`、`requests: []`、标题未变）；② 视觉上 `focusRingVisible: false`、`topAtFocus: "#blocked"`。

**为什么之前没发现**：三次探针迭代都错在**判据**上——① 选择器猜错（会话行是 `button.session`，`.session-row` 不存在，报 `rowsInList: 0`）；② 判据跑在空场景上（`hostDown` 场景的列表永远是空的，因为每个请求都 `response.destroy()`，于是「浮层下的会话能不能点」在那里问不出来）；③ 判据读了我猜的状态字段（`state.currentSessionId` 是 `null`，「会话是否换了」不可观察）。**第三点最要紧：判据要读可观察量——列表里 `aria-current="true"` 的行、`#title-text` 的文本、`state.requests.length`。**

**修法**（`extension/sidepanel.js` 的 `renderOffline`）：给浮层遮住的一切设 `inert`。
```js
for (const element of [headerBar, findBar, footer]) {
  if (element !== null) element.inert = shown
}
for (const element of stage.children) {
  if (element !== surface) element.inert = shown
}
```
三个设计判断：

1. **`inert` 而不是 `tabindex="-1"` + `aria-hidden` 组合**：一个属性同时把它移出 Tab 顺序、移开指针、移出可访问性树，而且**撤销时不会留下需要按正确顺序回滚的账**。
2. **按结构枚举，不按 id**：面板自己的规则是「点名元素的规则必然漏掉下一个新增的元素」——这条规则对**被禁用的**元素同样成立。两组（stage 的孩子、stage 的兄弟）各一个循环。
3. **`#stage` 自己不在名单里**：`#blocked` 是它的孩子，把 stage 设成 inert 会连**浮层上的重试按钮**一起关掉——那是读者唯一的出路。**把出路也关掉的修法比缺陷更糟。**

**修复后读数**：`invisibleStops: []`、`hitsInvisibleTargets: false`；`inertRoots` 正确列出 `header`、`#find`、`#transcript` 等；可达元素恰好 **1 个**（重试按钮）；15 张截图逐像素**完全未变**（修复只在宿主不可达时生效）。

**★ 一条被实测否掉的方向**：我原本要「让浮层不盖住列表，把列表还给读者」。实测否决——把浮层藏起来后那一行**仍然 0 请求、什么都不做**（`.tmp-run/probe-row-without-overlay.js`）：列表数据来自宿主 HTTP（`refreshGroups` 的 `groups = understood ? payload.groups : []`），宿主死了它就属于空集。**把四个死按钮露出来只是用一个谎换另一个谎。** 这个探针的设计是这轮的关键：先用程序化点击把「浮层拦住了」与「行本身没用」分开，否则会把前者误读成后者。

**变异**（`.tmp-run/mutate-inert.mjs`）**3/3 命中**、`restoredExactly: true`：`no-inert-at-all`（回到原缺陷）、`inert-set-but-never-cleared`（**新引入的风险**：宿主恢复后面板永久瘫痪）、`surface-disables-itself`（把重试按钮也关掉）。

**★ 第一轮只有 2/3，漏的正是最要紧的那条**：`no-inert-at-all` 只破坏了第一个循环（header/find/footer），而我的断言只读 `#transcript`（由第二个循环管），于是照旧通过。**漏网的是测试覆盖不足，不是脚本问题**——补一条 `#find` 的断言即 3/3。

**★ 测试基建的真实缺口**（不修就写不出这个测试）：`packages/dsh-browser-bridge/test/dom-shim.js` 的 `byId` 把每个 id **现场造成无父节点的根**（其注释原本就写着 "Root stubs … which have no parent"），于是 `stage.children` 是**空数组**，循环体一次都不执行——断言读到 `undefined` 而不是错误的 `false`。**那是 shim 在告自己的状。** 修法是新增 `CHILDREN` 映射记录面板真正依赖的结构关系（`stage` 含 `transcript`/`history`/`earlier`/`to-bottom`/`blocked`/`contexts`/`composer`），`byId` 在首次取用时把子节点挂上。**这不是 HTML 解析器**（shim 明确拒绝写第二个 HTML 实现），只记录被读取的那两条事实。

**测试**（扩了既有测试 `the blocked surface clears itself the moment the host answers`，未新增文件）：四条断言覆盖**两个方向**——不可达时 `#transcript` 与 `#find` 必须 inert、`#blocked` **不** inert、恢复后 `#transcript` 的 inert 必须被撤掉。最后一条是防「设了不撤」的，那条路径只在宿主机恢复时才走到。

**验证读数**：`npm test` **711 passed, 0 failed, 0 skipped**（连续干净）；`npm run check:extension` exit 0。

> ## v106：输入框坐在会话列表底下，改的是你看不见的那个会话

**症状**：读者打开会话列表浏览会话，屏幕上只有列表。而面板底部**完整保留着输入框、发送键与模型选择器**。输入框提示仍是「问点什么…」，模型选择器可点、菜单能打开、选项能选。

**实测**（`.tmp-run/probe-history-model.js`，`historyOpen` 场景，真实点击）：
```
historyVisible: true      ← 屏幕上只有列表
transcriptVisible: false  ← 对话不在屏幕上
titleVisible: false       ← 唯一能说出「当前会话是谁」的元素被 renderTitle 隐藏
selectedRows: []          ← 列表里没有任何一行标出「当前」
实际请求: {"action":"select-model","sessionId":"session-a",...}
```
读者在浏览会话列表时选了模型，**改动打在一个屏幕上完全看不见的会话上**，而屏幕上没有任何东西说出这件事落到了谁身上。

**机制**：`extension/sidepanel.js` 的 `showView()` 只管两个滚动容器与标题按钮——`transcript.hidden`、`history.hidden`、`titleButton.hidden = view === 'history'`。页脚从未被它管过，而 `#composer` 里的每一个控件都作用于 `currentSessionId`。

**这个仓库自己写下了判据，只是没有贯彻到自己身上**。查找栏逻辑（`renderFind`，`sidepanel.js` 约 L2680）的注释原文：

> The arrows are hidden for the same reason — a control that cannot act on what is on screen is a control that lies about what is possible.

查找栏遵守了它——在列表上方改写占位符、隐藏上下箭头。而 composer 违反了同一个条规则。

**判据按属性枚举**（`.tmp-run/probe-view-scoped-controls.js`）：两个视图里各扫一遍全部可操作控件，报出「可见 + 可用 + 动作目标是对话」的那些。控件与「非控件的对话表面」（待发送 chip、composer 盒）分开报，因为按 `interactive` 过滤会把 chip 整个漏掉。
- 修复前：`chatControlsLiveInHistory: ['input', 'model']`，chip 亦然
- **对照组**：`findControlsInHistory` 已被正确处理 → 证明判据有效，不是恒真
- 修复后：两项皆为 `[]`，而 `chatSurfacesLiveInChat` 仍非空（**没有修过头**）

**修法**（`extension/sidepanel.js`）：
- 新增 `let chatFooterHidden = false` 与 `applyChatFooter()`，在 `showView()` 里设标志并调用
- 隐藏 `#composer`；`#contexts`（待发送 chip）同理——它是「下一条消息要带的页面」，列表上方没有下一条消息
- **隐藏而不是禁用**：灰掉的输入框仍占屏幕、仍读作「接下来该填这里」，而列表有自己的动作（开会话），那才是页脚该提供的

**★ 我自己写下了规则又违反了它**。第一版在**两处**都写 `contexts.hidden`：`applyChatFooter()` 里写一次，`renderContexts()` 里再写一次。变异脚本抓到了后果——**改掉任一处，另一处仍然生效，两个 chip 变异全部漏网（`realCaught: 2/5`）**。删掉 `applyChatFooter()` 里那次重复写入、让 `renderContexts` 成为该属性的唯一写入者之后 **5/5 命中**。这正是我在自己的注释里写的「two writers to one property is how drift begins」——写下来不等于遵守。

**★ 测试污染（自己造成并修掉）**：`panel-stream` 共享一个面板实例。我的 chip 测试为了造一个 chip，把 `host.tab` **整个换成了** `{title:'Example Domain',...}`，于是后续测试看到的是那一页：图标测试去找一个它从未有过的图标（`the chip draws no site icon`），提及测试把同一个标签页当成第二次承诺（`the same page was promised twice`，`3 !== 2`）。改为 `{ ...host.tab, title, url }`（仓库既有写法）**并在测试末尾还原 `host.tab` 与 `host.tabUrls`**，两条既有测试恢复绿。

**测试**（`packages/dsh-browser-bridge/test/panel-stream.test.js` 新增 2 条）：
- `the composer leaves with the conversation it writes to` —— 断言往返三档（对话里可见 → 列表里隐藏 → **切回来必须恢复**）。第三档是防单向修复的：只隐藏不恢复比原缺陷更糟，读者切回来发现输入框没了。
- `a staged context does not ride under the session list` —— 先确认真的有 chip（否则这条测试什么都不证明），再断言往返。

**变异**（`.tmp-run/mutate-view-scope.mjs`）**5/5 命中**、`anchorProblems: []`、`restoredExactly: true`：`composer-stays-live-over-the-list`、`composer-never-comes-back`、`chips-ride-under-the-list`、`repaint-pops-the-chips-back`、`flag-never-set`。

**验证读数**（已绿，不必重跑）：
- `npm test` → **711 passed, 0 failed, 0 skipped**
- `npm run check:extension` → exit 0
- 真实浏览器往返：`composerPresentInChat` / `composerHiddenInHistory` / `composerBackAfterReturn` / `chipPresentInChat` / `chipHiddenInHistory` / `chipBackAfterReturn` **六项全 true**
- 画廊 15 张中**只有 `sessions.png` 真的变了**（115139 → 121278 字节；composer 从列表上方消失）。`search.png` 本次无抖动；`SOURCES.json` 指纹如常更新。

**新增探针**（`.tmp-run/`，被 gitignore）：`probe-history-live.js`（历史视图里哪些对话控件还活着）、`probe-history-model.js`（选模型打到了哪个会话——这一条给出了决定性证据）、`probe-view-scoped-controls.js`（按属性枚举两个视图的全部控件与对话表面）、`probe-chip-facts.js`（先量清事实，不假设起始视图）、`probe-chip-roundtrip.js`（往返六项检查）、`mutate-view-scope.mjs`。

## v105：输入框邀请你提问，而发送键拒绝发送

**症状**：一个还没有会话的面板，屏幕上写着「还没有会话／新建一个，就可以开始问了」+ 一个新建按钮——**同时**底下留着一个可用的输入框，提示还是「问点什么…」。读者打完一整句话，按下发送：**什么都没有发生**，字还在框里。

**实测**（`.tmp-run/probe-empty-composer.js`，`empty` 场景，派发真实点击）：

| 读数 | 值 |
|---|---|
| `sendDisabled` | **true**（没有会话，无处可发——这是对的） |
| `inputDisabled` / `inputReadOnly` | **false / false** |
| 输入后 `sendBecameEnabled` | **false** |
| 点击发送后的 `requests` | **`[]`** |
| `inputValue` | 「这个页面讲的是什么？」——**原样留着** |
| `verdict` | `the composer accepts a question and does nothing with it` |

机制（`extension/sidepanel.js` 的 `drawSend`）：`sendButton.disabled = … \|\| currentSessionId.length === 0 \|\| …`。按钮知道没有会话就不能发，**而输入框从来不知道**——`input.disabled` 在整个文件里**一次都没被赋值**，`input.placeholder` 只在启动时设过一次。两个控件对同一件事有两种认识。

**已有的那个测试其实描述过这个缺陷**（`panel-stream.test.js` 的 `with no sessions at all…`）：注释原文「the composer still invited 「问点什么…」 and the send button sat disabled with nothing on screen explaining why」——上一轮修的是**中间那块空白**，把 composer 留在了原地。

**修法**：`drawSend` 现在也管输入框的提示文字，于是两者由同一段代码决定。

```js
const composerPlaceholder = !hostReachable
  ? t('composer.needsHost')
  : currentSessionId.length === 0 ? t('composer.needsSession') : t('composer.placeholder')
if (input.placeholder !== composerPlaceholder) input.placeholder = composerPlaceholder
```

**为什么不禁用输入框**：面板已经说了要先做什么，而输入框正是做完那步之后要用的地方。灰掉一个框而不说明原因，比读者正要打的那句话信息更少。

**为什么按原因分支而不是只写一句「不能发」**：「不能发」至少有三种原因，出路各不相同——宿主没运行／还没有会话／输入框是空的。第三种由发送键天然表达，前两种要说出来。

**★ 本轮我自己引入并修掉了一个新缺陷**：第一版写成「没有会话就说『先新建一个会话…』」。而在宿主连不上的时候（`hostDown` 场景），**新建会话同样不可能成功**——输入框把读者指向了第二个也会失败的动作。是重渲画廊时看到 `host-down.png` 里那句提示发现的，随后用 `.tmp-run/probe-composer-reasons.js` 定性：`promisesTheWrongNextStep: true`。**顺序因此是按「什么才能真正解开读者」排的**：宿主可达性先于会话存在性。修后两档各自正确：`hostDown` → 「dsh web 没在运行…」，`empty` → 「先新建一个会话…」，`normal` → 「问点什么…」。

**测试**：`panel-stream.test.js` 扩了两条既有测试，而不是新加文件——它们本来就是这两个状态的家。
- `with no sessions at all, the panel says how to start one, and the button does it`：新增三条断言（提示必须是 `先新建一个会话…`、**必须不是** `问点什么…`、建好会话后必须回到 `问点什么…`）。最后一条是**防单向修复**的：只改一半会让提示永远停在「先新建一个会话…」。
- `with nothing listening, the panel says so once, and offers a way out`：新增两条（提示必须是 `dsh web 没在运行…`、必须不是 `先新建一个会话…`）。

**变异**（`.tmp-run/mutate-composer-invite.mjs`）：**5/5 命中**、`restoredExactly: true`。每条都写明**该红哪条测试**（`expects`），因为两个分支住在两条测试里——这也让「锚点写错」不会伪装成「等价变异」。

| 坏法 | 红的测试 |
|---|---|
| `placeholder-stays-an-invitation`（回到原缺陷） | `with no sessions at all…` |
| `placeholder-never-goes-back`（单向修复） | `with no sessions at all…` |
| `needs-session-string-removed`（词条缺失） | `with no sessions at all…` |
| `host-reason-dropped`（本轮引入的缺陷） | `with nothing listening…` |
| `reasons-in-the-wrong-order`（先问会话后问宿主） | `with nothing listening…` |

**画廊**：只有 `host-down.png` 真的变了（逐像素核过）。`search.png` 重渲后出现 **1 个像素**差异，位于 CSS `(7, 56.5)`——本仓库第三次遇到同一处的**焦点环抗锯齿抖动**（v93、v104 记录过），已用 `git checkout` 还原。

> ## v104：一篇长回答被整篇念给读者听，而 live region 停不下来

**症状**：回答流完时，面板把**整篇回答**塞进 `#announcer`（一个 `role="status" aria-live="polite"` 的 `sr-only` 区域）。而 live region **不能跳过、不能滚动、不能打断**——读者只能坐着听完。

**实测**（`.tmp-run/probe-announce-length.js`，5612 字符的回答）：`announcedCharacters: 5612`、`announcesWholeAnswer: true`、按中文 250 字/分估算 **22.4 分钟**。

**这不是边缘情况**。扫本机 156 个会话、**10885 条 assistant 文本**（`.tmp-run/probe-answer-lengths.mjs`）：

| 分位 | 字符数 | 朗读时长（200 词/分） |
|---|---|---|
| p50 | 89 | 0.1 分钟 |
| p75 | 136 | 0.1 分钟 |
| p90 | 204 | 0.2 分钟 |
| **p99** | **2116** | **2.1 分钟** |
| **max** | **35159** | **35.2 分钟** |

超过 1 分钟的占 **1.5%**（168 条）。中位数很小，所以「念全文」在多数时候无害——这让它一直没被发现。

**官方参考实现**（`dsh-client-ui-chat/lib/client.js` L6125-6131）：live region 里放的是**一句短状态**，四档全部如此——`chat.deepDiving`「深度求索中」、`message.stopped`「已停止」、`message.turnProcess.failed`「处理失败」、`message.turnProcess.worked`「已完成工作」（4 个字）。**从不放回答正文**；正文由读者自己在文档里读。

**修法**：播报**开头**（读者据此知道回答到了、讲的是什么）＋**省下多少字的说明**，其余留在屏幕上由读者自己按自己的节奏读。新增 `announceableAnswer(text)`（`extension/sidepanel.js`，紧接 `announce` 之后）。

三个常量，各有理由：
- `ANNOUNCE_MAX = 240`：从分布取，中位数 89 与之相差很远，所以**常见档完全不受影响**，只有长尾改变形态。
- `ANNOUNCE_MIN = 80`：低于它就不找句末边界了——三个字的「开头」不值得为它找句子边界。
- `ANNOUNCE_WORTH = 40`：**截断必须省得比那句说明多**。

**★ 边界缺陷（实现完成后才量出来）**：241 字符的回答被播报成 **244**——加了「（其余 5 字）」之后比原文还长。**为省 5 个字多说了 12 个字。** 这就是 `ANNOUNCE_WORTH` 的来由；它的成因不是疏忽，而是「截断」与「说明」被当成两件独立的事，而它们共享同一个时间预算。

| 长度 | 修复前播报 | 修复后播报 |
|---|---|---|
| 89（p50） | 89 | **89（逐字）** |
| 136（p75） | 136 | **136（逐字）** |
| 240 | 240 | **240（逐字）** |
| 241 | 241 | **241（逐字）**（不值得截） |
| 280 | 280 | **225**（截断＋说明） |
| 600 | 600 | **226** |
| 2116（p99） | 2116 | **227** |
| 5612 | 5612 | **227**（22.4 分钟 → 0.9 分钟） |

**验证**：`npm test` **709 passed, 0 failed, 0 skipped**；`check:extension` exit 0；变异 `.tmp-run/mutate-announce.mjs` **真坏法 4/4 命中、等价变异 1/1 保持绿**、`restoredExactly: true`；15 张截图重渲后**除 `SOURCES.json` 指纹外零变化**（播报只写 `sr-only` 区域，不影响任何像素）。

**★ 一条如实标注的等价变异**：`early-return-removed`（把 `if (body.length <= ANNOUNCE_MAX) return body` 改成 `<= 0`）**必须不红**——`ANNOUNCE_WORTH` 那道闸门已经让所有 ≤240 的回答逐字播报，所以 MAX 的提前返回是同一件事的另一种写法。用**算式**证明而不是靠论证：`.tmp-run/probe-max-equivalence.mjs` 对 1..4000 的每个长度跑两版实现，`differenceCount: 0`（3378 个有效长度）。脚本把 `realCaught` 与 `equivalentHeld` **分开统计**，不混成一个「命中数」。

**★ 测试缺口（第一轮变异只有 2/5，追下去是三种不同原因）**：
1. `drop-the-count` 没红 —— 断言写的是 `/有数字/`，而夹具的句子本身带编号（"Sentence 1…"），**这条断言恒真**。改成从播报里解析出 `（其余 N 字）` 的 N 并与实际丢弃量比对。
2. `bound-everything` 没红 —— 测试里的长度最长只到 241，**全都在逐字档**，看不到上限移动。补了 250（逐字）与 280（截断）两个真正跨过闸门的长度。
3. `no-worth-threshold` 没红 —— 241 字符里第 241 位恰好是**空格**，`trimEnd` 后是 240，没到触发点。

**★ 两次误判都是测试夹具的错，不是产品的错**：`answerOfLength(241)` 返回的是 240（补串循环停在了请求长度上，而句子是 34 字符），以及「241 的第 241 位是空格、`trim()` 去掉它是对的」。两次都报成「面板违约」。夹具的两处 off-by-one 已写进该函数的注释。

**新测试**（`packages/dsh-browser-bridge/test/panel-stream.test.js`，两条）：`a long answer is announced in part, and says how much it left out`、`an ordinary answer is announced whole, because bounding it would cost more`；新助手 `announcedFor(body)` 与 `answerOfLength(length)`。**`announcedFor` 必须按序推三帧**（`start` → `text` → `end`）：`applyDelta` 在会话不匹配或没有 live 块时提前返回，只推 `text` 一帧什么也测不到，而且会「因为什么都没发生」而通过。

**词典豁免**：`row.answerAnnounce`（zh `'{opening}（其余 {rest} 字）'` / en `'{opening} ({rest} more characters)'`）加入了 `packages/dsh-browser-bridge/test/panel-i18n.test.js` 的 `ALLOWED` 表（长度 6 条）。理由与该表既有的四条不同：前四条是「句子就是内容」，这一条是**前半句引用读者自己的回答**，面板管不了它的标点，词数上限也无法适用于不是面板写的文本。豁免范围刻意只有这一个键。

**探针**（`.tmp-run/`，被 gitignore）：`probe-answer-lengths.mjs`（扫真实日志得分布）、`probe-announce-length.js`、`probe-announce-short.js`（期望分组按「值不值得截」而不是「有没有超上限」）、`probe-announce-chain.js`（链条逐环诊断）、`probe-mutation-gaps.js`、`probe-max-equivalence.mjs`、`mutate-announce.mjs`。

**★ 探针自身错了两次**（都是「读数恒为 0，先怀疑判据」）：
1. 只推 `dsh-assistant-delta` 而不带 `kind`，`applyDelta` 不累加文本 → 播报 0 字符，看起来像通过。
2. `announce()` 把文本写在 `setTimeout(…, 0)` 里（两步是为了让相同文本也能播报），而探针只等 `requestAnimationFrame` → 读到的正是「已清空、尚未写入」的中间态。

**`tools/preview.mjs` 的一处工具改进**：`chrome.runtime.onMessage` 的替身现在把监听器发布到 `window.__previewState.onMessage`（原来只存在注入脚本的局部 `state` 上），探针因此能走**真实路径**投递消息。不发布它，探针就得自己编一个面板根本不监听的事件名，量到的是一条生产环境不存在的路径。


> ## v103：放大字号之后，输入框里能看到的行数反而少了一半

**症状**：读者把系统字号放大到 200%（因为字太小看不清），输入框的可视高度**没有跟着变大**——实测能看到 **3.5 行**，而默认字号下是 **7 行**。放大是为了看清，结果看到的内容少了一半。

**机制**：上限被写了两遍，而两遍的单位不同。

样式表说 `max-height: 10em`——`em` 跟着元素自己的字号走，14px 下是 140px，32px 下是 280px。脚本说 `input.style.height = Math.min(140, input.scrollHeight) + 'px'`——**一个硬编码的像素值，不跟随任何东西**，而且这个表达式在文件里出现**五次**。

按 CSS 的优先级，样式表的 `max-height` 本该赢过内联的 `height`。但**内联样式赢过样式表**，所以那个 140 是最终的：CSS 那条跟随字号的规则从来没机会生效。

```
默认字号：max-height 140px  →  Math.min(140, 内容)  →  140px  ✓ 看起来对
200%   ：max-height 280px  →  Math.min(140, 内容)  →  140px  ✗ 上限压住了
```

**为什么 43 轮没被发现**：默认字号下两个数**恰好相等**，缺陷完全不可见。这类「两条规则在默认参数下取值相同、只在读者改变参数时分开」的问题，本仓库已记录多次（v93 的 `em`/`rem` 漂移、v97 的 options 页字号），这是第三次。

**修法**（`extension/sidepanel.js`）：把上限**完全交给 CSS**，脚本只负责测量。

```js
function growInput() {
  input.style.height = 'auto'
  input.style.height = `${input.scrollHeight}px`
}
```

内联值会是内容的完整高度（长内容时实测 4008px），而 `max-height` 自己封顶——`cappedByCss: true` 在 100% 与 200% 两档都成立。上限因此**只有一处来源**，天然跟随字号。

**试过并否决的写法**：`height = min(getComputedStyle(input).maxHeight, scrollHeight)`。功能上正确，但**面板此前从不读计算样式**，而测试的 `dom-shim.js` 没有 `getComputedStyle`——实测造成 `panel-stream` **101 个测试失败**（`getComputedStyle is not defined`），只剩 52 passed。引入它就得同时给 shim 补一个新 API。让 CSS 封顶不需要任何新 API，`panel-stream` **153 passed 无需改动**。

**否决的第二个写法**：只设 `height: auto`。实测盒子停在 **28px**（1.4 行）——textarea 的 `auto` 停在 `rows="1"` 属性上，**不会按内容撑开**，所以测量是承重的（`sameAtDefault: false`）。

**唯一保留 `auto` 的地方**是发送后清空输入框（`extension/sidepanel.js`）：那时内容为空，`auto` 就是正确高度。

| 读数 | 修复前 | 修复后 |
|---|---|---|
| 默认字号 boxHeight / 可见行数 | 140px / 7 行 | 140px / 7 行（**未变**） |
| **200% boxHeight** | **140px** | **280px** |
| **200% 可见行数** | **3.5 行** | **7 行** |
| `inlineFollowed` | false | true |
| `visibleLinesShrank` | **true** | **false** |
| `cappedByCss`（两档） | —— | **true / true** |
| 内容完整性 / 内部滚动 | true / true | true / true |

**验证**：`npm test` **707 passed, 0 failed, 0 skipped**；`check:extension` exit 0；变异 `.tmp-run/mutate-input-ceiling.mjs` **5/5 命中**、每条 `suiteRan: true`、`restoredExactly: true`（`back-to-a-hard-coded-ceiling`、`ceiling-by-a-different-number`、`grow-by-fixed-steps`、`ceiling-becomes-absolute`、`send-does-not-reset-height`）；15 张截图重渲后**逐字节未变**（默认字号下完全守恒）。

**新测试**：`packages/dsh-browser-bridge/test/panel-geometry.test.js` 的 `the composer states its ceiling once, in the stylesheet`。断言的是**脚本里没有那个数**（`Math.min\(\s*(\d+)\s*,\s*input\.scrollHeight\s*\)` 必须匹配不到任何东西），因为缺陷正是「脚本里存在第二个上限」。`ceiling-by-a-different-number` 变异证明它抓的是「存在上限」而不是「等于 140」——换个数字同样变红。

**探针**（`.tmp-run/`，被 gitignore）：`probe-paste.js`（用**真实粘贴事件**而非直接赋 `value`，量内容完整性、内部滚动、两档可见行数、内联是否跟随）、`probe-grow-experiment.js`（否决 `auto`）、`probe-css-cap.js`（采纳 CSS 封顶）、`mutate-input-ceiling.mjs`（含一条锚点缩进写错导致「假等价变异」的教训——锚点没找到会报成 `anchor not found`，看起来像等价变异而不像笔误）。


> ## v102：面板给了一个它自己会拒绝执行的指令

本轮从一个已有的状态出发：宿主太旧时面板怎么办。答案比预期糟——
它**说了错的话，还给了一个按下去什么都不会发生的按钮**。

### 缺陷：第三个状态一直不存在

`extension/sidepanel.js` 的 `refreshGroups`（L3524-3529）这样判：

```js
const understood = status === 200 && Array.isArray(payload?.groups)
if (status === 200 && !understood && !hostStale) {
  hostStale = true
  say(t('error.restartHost'))
}
```

即「答了 200 但 body 里没有 `groups` 数组」= 宿主比面板旧。这个判断本身是对的。

问题在 `renderOffline`（L660）只有**两个**状态：

```js
const hostDown = !hostReachable
const noSessions = !hostDown && groups.length === 0
const shown = hostDown || noSessions
```

`hostStale` **不在其中**。旧宿主下 `hostReachable` 为真（它确实答了）、`groups`
被置为 `[]`，于是落进 `noSessions` —— 一块写着「还没有会话 / 新建一个，就可以开始
问了。」并配一个醒目「新建会话」按钮的面板。

而那个按钮的处理器（L4626）走 `newSession()`，它的**第一行**就是
`if (hostStale) { say(t('error.restartHost')); return }`。

**实测**（新场景 `staleHost` + `.tmp-run/probe-stale-host.js`，包装 `fetch` 计数）：

| 读数 | 修复前 |
|---|---|
| `createRequestsSent` | **0**——请求根本没发出 |
| `anythingChanged` | **false**——点击后界面毫无变化 |
| `toastRepeatedItself` | **true**——同一句话再弹一次，然后淡出 |
| `stillEnabled` | **true**——按钮看起来仍然可用 |
| `persistentNoticeCount`（非 toast 的持续说明） | **0** |

界面把一个它自己会拒绝执行的指令，用最醒目的样式递给读者。这不是文案问题：
读者正确地照做，得到的是零反馈。

### 修法：补上第三个状态，并且**不给按钮**

`renderOffline` 新增 `hostStaleNow`，从 `noSessions` 与播报状态里排除，
并加一支专属分支：

```js
const hostStaleNow = !hostDown && hostStale
const noSessions = !hostDown && !hostStaleNow && groups.length === 0
const shown = hostDown || hostStaleNow || noSessions
const state = hostDown ? 'host' : hostStaleNow ? 'stale' : 'empty'
```

新建的 stale 分支做两件事：说清问题是「dsh web 需要重启」（`blocked.staleTitle`
/ `blocked.staleBody`），以及 `blockedAction.hidden = true`。

**为什么是「隐藏」而不是「禁用」**：重启 `dsh web` 只能在面板外完成，所以这里有
任何按钮都是面板兑现不了的承诺。禁用按钮把「你现在不能做这件事」和「这件事根本
不在这里做」混成同一种视觉。样式上「新建会话」是**实心强调色**的，比什么都显眼
——把一个空承诺做得最醒目，正是这个缺陷最坏的部分。另两个分支各补
`blockedAction.hidden = false`，因为 `hidden` 是持久状态。

### 同一个缺陷的第二个通道：读屏读者听到的是另一句话

屏幕文字改对了之后，变异 `stale-not-announced`（把 `stale` 从 `state` 三元里去掉）
**存活**——说明那条测试只验了看得见的一半。补上播报断言后它立刻变红，原因不在产品
而在我的等待方式：

`announce()`（L546）的写入排在 `setTimeout` 上（先清空、下一个宏任务再写），
而 `settle()` **只清微任务**。测试文件里早就有 `settleMacrotask()`，注释写着
「The announcer writes its sentence on a later task on purpose」——我该读它。

改用它之后 **4/4 变异全部命中**：`stale-falls-into-empty`、
`stale-action-still-shown`、`stale-says-the-wrong-thing`、`stale-not-announced`。

### 顺带修好：截图里的光标是一个随机变量（并纠正 v96 的记录）

改完 `extension/` 必须重渲画廊（v96 的指纹守卫），重渲后 `reasoning.png` 变了。
先做对照：**用 HEAD 的代码渲同一场景 → `DIFFERENT 0`**，所以确实是我的改动带来的。
再渲 4 次：得到 0、0、70、0 个差异像素，那 70 个恒定落在 CSS (30, 645..662)
的一条 17px 竖线上。

**是 composer 的文本插入符。** `longReasoningOpen` 场景里 `#input` 持有焦点，
Chromium 按墙钟闪烁它。15 张图里有 **8 张**带着它（`conversation.png`、
`sessions.png`、`approval.png`、`working.png`、`triggered.png`、`picture.png`、
`failure-recourse.png`、`conversation-light.png`），每张差异都恰好是同一个矩形。
`sessions.png` 是 747 像素而非 70，因为历史视图盖在 composer 之上，插入符沿边缘
露出两块。

后果与 v96 记录的那次一样：**每次 `node tools/gallery.mjs` 都无理由重写 8 张图，
README 的图取决于拍的那一瞬间。**

修法在**渲染工具**里，不动产品：`tools/preview.mjs` 注入
`textarea, input { caret-color: transparent !important; }`。这是相机设置不是产品
改动——面板有意保留光标（`sidepanel.html` L188 的注释：「caret still says where
the text will go」），而用 `caret-color` 而不是取消焦点是必要的：好几个场景存在的
意义就是展示聚焦状态，丢掉焦点会变成另一张图。`prefers-reduced-motion` 管不到它，
因为那是浏览器自己的行为，不是面板声明的动画。

**修复读数**：`longReasoningOpen` 连渲 5 次 **0 差异**；`historyOpen` 连渲 3 次
**0 差异**。守卫写进 `screenshots.test.js` 既有的那条确定性测试里
（`a screenshot is a function of the code, not of when it was taken`），变异
`caret-pin-removed` / `caret-pin-without-important` / `caret-pinned-on-textarea-only`
**3/3 命中**。

**同时纠正 v96 的一条记录**：v96 把 `search.png` 的一点差异记成「已记录的焦点环
抗锯齿抖动」。根因其实就是这个插入符，当时没查到，现在补上。

### 词典约束是一次真实的设计约束，不是障碍

`npm test` 报了 `no dictionary entry is a sentence`：`en:blocked.staleBody has 14
words`、`is punctuated as a sentence`。测试的豁免名单是**指名**的（`blocked.hostTitle`
/ `hostBody` / `emptyTitle` / `emptyBody`），并用 `assert.equal(ALLOWED.length, 4,
'the exempt list grew; was that intentional?')` 挡住悄悄增长。

这条规则本身是这个产品的一部分：注释记载它来自「面板读起来像帮助页」那次重写。
第三状态属于**同一块面板、同一种陈述**，所以是有意的增长——但只豁免 `staleBody`，
标题「dsh web 需要重启」短得可以做标签，仍受规则约束。名单改为 5 条并写明理由。

### 验证读数（已绿，不必重跑）

- `npm test` → **706 passed, 0 failed, 0 skipped**
- `npm run check:extension` → exit 0
- 变异一（`.tmp-run/mutate-stale-host.mjs`）：**4/4 命中**、`restoredExactly: true`
- 变异二（`.tmp-run/mutate-caret-pin.mjs`）：**3/3 命中**、`restoredExactly: true`
- 真实浏览器（`staleHost` 场景）：标题「dsh web 需要重启」、`persistentNoticeCount: 3`、
  `blocked-action.hidden: true`、`offersAnActionItWontDo: false`（修复前为 `true`）
- 画廊 15 张重渲，9 张变化，**全部可归因到那一根插入符**
- 截图：`.tmp-run/r43-fixed.png`、`.tmp-run/r43-stale.png`（修复前）

### 本轮新增探针（`.tmp-run/`，被 gitignore）

`probe-stale-host.js`（判据本体：包装 `fetch` 数请求、要求「按钮可见 + 未禁用 +
点了之后零请求」三条同时成立才算缺陷）、`why-stale-silent.js`、`whats-at-pixel.js`
（回答「这个像素是什么元素」）、`whats-at-sessions.js`、`mutate-stale-host.mjs`、
`mutate-caret-pin.mjs`。

> ## v101：一半的回合，读者从来没说过话

v91–v100 都在读**面板自己**的代码与界面。本轮换一条轴：拿本机 156 个真实会话
日志（86177 个事件、33493 行）去核对宿主对世界的理解，因为仓库夹具曾经
编码过与真实相反的世界观（v84 发现夹具把 `user/message` 写在 `turn/start`
**之前**，而真实顺序相反，696 条测试全建立在那个世界观上）。

### 缺陷：112/243 个回合在面板上「没有人说话」

宿主 `describeEvents` 的 `user/message` 分支只认 `source.kind === 'user'`，
其余 13 种 kind 全部静默丢弃。过滤本身是对的（README L316 写明「只显示人说过的
话和模型的回答」；`plugin` 319 条是 740 字符的运行时上下文模板，`skill-catalog`
84 条每条 9123 字符）。但**丢完之后读者看到的是**：模型开始说话，而上一行
没有任何人说过话。实测 **243 个回合里 112 个（46%）不是读者发起的**
（`goal` 114、`team-message` 4、`plugin` 3 作为首条）。

官方 UI 有答案：`turnTriggerDetails(node)` 把触发源渲染成**标题 + 图标**
（`message.trigger.goal`「继续执行目标」、`.team`「收到团队消息」、
`.subagent`「子任务状态更新」…），而不是把注入渲染成气泡。

### 修法

宿主在 `user/message` 分支**`appended` 守卫之后**新增 trigger 行：只给**回合的
第一条**注入消息贴标签（`labelledTurns` 保证一回合一条），并带上 `provider`
（官方靠它区分 github 与通用 webhook）。面板 `renderRow` 新增 `.trigger` 分支，
画成**居中标签**——不是气泡，因为那条消息不是对话里任何人说的。
`triggerLabel(kind, provider)` 镜像官方的分类。

### ★ 三条只有真实数据才看得见的结论

1. **`github` 从来不是 `source.kind`**。它是 `webhook` + `source.provider === 'github'`。
   我最初凭空造了一个 `github` kind，被**仓库自己的词条守卫**
   （`no dictionary entry is dead weight`）抓住——它扫描字面的 `t('…')` 调用，
   而我的映射是动态拼键，于是既报「这些键没人读」又暴露了造出来的分类。
   这条守卫的作用正好在这里：**一个没人发的 kind，看起来就是没人读的键**。
2. **`turn/end` 清标签是承重的，但第一轮变异没测到**。`labelledTurns.delete(turn)`
   删掉后 7 个变异里 6 个命中，它没红。追下去分两种可能（等价变异 vs 测试缺口），
   用探针构造「回合号被复用」的窗口后确认是**测试缺口**：同一个号码跨一个完整
   回合再用一次，只画出一个标签。补测试后 **7/7**。
3. **夹具的 `turnEndEvent` 把 `turn` 硬编码为 1**，于是 `turnEndEvent(5)` 会把 5
   当成 `reason`——写完测试立刻撞上。已给夹具加 `turn` 参数。

### ★ 四次判据错误（全在量这个标签的可见度上）

标签用 `--hit` = `color-mix(in oklab, CanvasText 12%, transparent)`。我先后写了
四个探针去量它「看不看得见」，**前三个都错在同一个地方：自己解析 `oklab`**。

| 探针 | 读数 | 真相 |
|---|---|---|
| 比计算值字符串 | 背景 `rgba(0,0,0,0.12)` vs `rgba(0,0,0,0)` → 「不同」 | 12% 黑叠在黑页面上，**合成后相同**（v96 记录过的同一陷阱） |
| 自己叠 alpha | pill `#101010`、页面 `#121212` | 把 `oklab` 的**感知亮度 L**（0.999994）当成 R 通道 |
| 让浏览器转 sRGB | 标签文字 `#060505` vs 背景 → 1.07:1「读不了」 | 仍然是解析错 |
| **逐像素读 PNG** | 背景 `#2e2e2e`、文字 `#bcbcbc`、**7.15:1** | **正确——远超 4.5:1 门槛** |

**像素是浏览器的最终答案，不经过我的手。** 前三张探针都「言之凿凿地」报告
一个不存在的可读性缺陷（1.07:1），而真实值 7.15:1 是舒适可读的。

### 修好的真实缺陷：高对比度下标签退化成小两号的正文

`forced-colors: active` 把每个 background 重绘为 `Canvas`，pill 合成后与页面
**完全相同**（实测 `rgb(0,0,0)` 对 `rgb(0,0,0)`），只剩「字号小 2px」这一个区分。
这是 v75、v96 之后**同一机制的第三次**，所以修法写在该模式块里并注明来由：
`.trigger-label { border: 1px solid CanvasText; }`——描边是该模式唯一保留的分隔手段。
普通模式实测 `labelBorderWidth: 0px`，**零影响**。

### 验证读数（已绿，不必重跑）

- `npm test` → **705 passed, 0 failed, 0 skipped**（696 → 705）
- `npm run check:extension` → exit 0
- 真实数据：156 个会话 / 86177 事件 / 33493 行 → **0 崩溃、0 未知 kind、212 个 trigger 行**
- 变异 `.tmp-run/mutate-trigger-row.mjs`：**7/7 命中**、`restoredExactly: true`
- 真实浏览器：标签 `looksInteractive: []`（无 Tab 停靠点、无 pointer 光标、无处理函数、点击不改变任何东西）→ **阴性结论**
- 画廊 15 张重渲；`docs/screenshots/triggered.png` 新增


> ## v100：面板开着一整天会怎样

v91–v99 九轮都在「读者在看的那一刻，界面对不对」这条轴上：字号、宽度、
动效、输入法、压缩行。本轮换一条完全不同的轴——**没有人在看的时候，它在做什么**。
这一轴上的缺陷不会在截图里露出来，因为截图拍的正是有人在看的那一刻。

### 三个独立机制，各自都成立

`extension/sidepanel.js` 有四个定时器：三个 5000ms（`refreshGroups` /
`refreshHealth` / `refreshTabs`）+ 一个 `POLL_MS = 8000`（`refreshTranscript`）。
一天约 **62,640 次请求**。

**① 宿主变慢时请求无限堆积。** 四个函数都是 `async`，而 `setInterval` 不等待回调
完成。探针 `.tmp-run/probe-overlap.js` 把宿主延迟到 12 秒、观察 16 秒：

| 读数 | 修复前 | 修复后 |
|---|---|---|
| `peakInFlight` | **5** | **3** |
| `/browser-bridge/chat` 单路峰值 | **3** | 2 |
| `/browser-bridge/health` 峰值 | 2 | 1 |
| `stillInFlight`（结束时仍在飞） | **5（永不回落）** | **0** |

修复后剩 3 是**设计上界**：三条不同路径各至多一个。它们彼此可以重叠（回答的是
不同问题），同一路径不能再叠（第二次问不出比第一次更新的答案）。

**② 而这个修法本身会造出一个更糟的失败模式。** 这一点是**测出来的，不是想出来的**：
`bridge()` 没有超时、没有 `AbortController`，所以对着一个挂起的宿主，请求
**永远不会落地**。加一个裸标志位，第一个这样的请求就永久占住槽位，
那条轮询**从此再也不运行**。实测 22 秒内只发出 1 个请求，再没有第二个。
**静默失效比堆积更糟**，因为堆积至少还在尝试。

所以槽位是**按时间租的，不是按信任给的**：`POLL_LEASE_MS = 30_000`，到点就收回。
`.tmp-run/probe-hung-host.js` 的完整时间线：`held` → `held-aborted`（20 秒超时触发）
→ 之后 **3 次**正常恢复。

**③ 没有人看的时候照发不误。** 全文件搜 `visibilityState`/`visibilitychange`/
`document.hidden` 只命中两处注释，**没有一处真的判断可见性**。
覆写该属性并派发真实事件后实测（`.tmp-run/probe-hidden-polling.js`）：

| 读数 | 修复前 | 修复后 |
|---|---|---|
| 隐藏期间请求数 | 8（约 **40/分钟**） | **0** |
| 可见时 | 约 50/分钟 | 约 50/分钟 |
| 回到可见之后 | 5 | **6（恢复）** |

**修法（`extension/sidepanel.js`）**：

```js
const POLL_LEASE_MS = 30_000      // 槽位按时间租，到点收回
const REQUEST_TIMEOUT_MS = 20_000 // 本地回环，正常 2–3ms，这个上限不会误伤

function runOneAtATime(task) {
  if (document.visibilityState === 'hidden') return
  const since = inFlightPolls.get(task)
  const running = typeof since === 'number' && Date.now() - since < POLL_LEASE_MS
  if (running) return
  const lease = Date.now()
  inFlightPolls.set(task, lease)
  task().catch(() => {}).finally(() => {
    if (inFlightPolls.get(task) === lease) inFlightPolls.delete(task)
  })
}
```

`signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)` 加在 `bridge()` 的 `fetch` 上。
超时值不是拍的：正常宿主实测 min 2ms / median 3ms / max 3ms（四条轮询路径全部），
20 秒是它四个数量级以上，不会对「忙」误判，只拦「永远不会回答」。
`AbortSignal.timeout` 需要 Chrome 103+，而 `manifest.json` 的
`minimum_chrome_version` 是 116。

`visibilitychange` 监听器调 `catchUpAfterBeingHidden()`，**四个轮询全跑一遍**——
它们回答不同的问题，各自都会在切走的这段时间里过期。走 `runOneAtATime` 而不是直接
调用，是让堆积守卫也挡在这里：回到可见的那一刻不能自己成为两个轮询重叠的时刻。

### ★ 两次判据错误（都在我自己写的探针里）

**一、判据把被测状态造没了。** `probe-hidden-polling.js` 第一版直接观察 12 秒，
报 `duringHidden: 8`、`pollsWhileHidden: true`——而它同时报出 `reallyHidden: false`，
因为 headless 里窗口从不隐藏。**「隐藏期间发了 8 个请求」这个读数什么都没说明**，
两次观察处在同一个状态。修法是覆写 `document.visibilityState` 并派发真实事件，
并把 `reallyHidden` 作为判据有效性的一部分报出来。

**二、判据不忠实于被替身的东西。** `probe-hung-host.js` 第一版把挂住的请求写成
`new Promise(() => {})`——一个**忽略 abort signal** 的 promise，于是它报
「一个不回答的宿主锁死了轮询」，而那是现实中到不了的状态：真实 `fetch` 在 signal
中止时**会 reject**。修法是让替身像真 fetch 一样响应中止。同一个错误在套件的
fetch 替身里又犯了一次，导致超时测试红了——**替身不响应 signal，工作正常的超时
看起来就像超时从没触发**。

### ★ 我自己写的一条变异分类错了

`.tmp-run/mutate-poll-guard.mjs` 里我先把 `POLL_LEASE_MS: 30_000 → 45_000` 标成
**等价变异**（理由「测试不依赖具体数值」），实测**报红**：那条测试把时钟推进 31 秒，
45 秒的租约落在窗口内。所以测试**确实在约束租约长度**，它是真坏法。
改判之后另找了一条真的等价变异（租约收到 5s，与 5 秒间隔相等，测试取的时点仍在同一侧）。

真坏法 **7/7 命中、等价变异 1/1 保持绿**、`restoredExactly: true`：
`no-guard-at-all`、`lease-never-expires`、`lease-cleared-unconditionally`、
`no-request-timeout`、`lease-longer-than-the-test-moves`、`polls-while-hidden`、
`never-catches-up`。

### ★ 两条测试缺口是靠变异发现的，不是靠想

第一轮 `realCaught: 2/4`，而 `suiteNeverRan: []` 证明套件真的跑起来了——
所以是**测试不足**：

| 没红的变异 | 缺什么 | 补法 |
|---|---|---|
| `lease-cleared-unconditionally` | 只挂住一个请求，两种情况行为相同 | 挂住**两个**，让两份租约可区分 |
| `no-request-timeout` | 只看「轮询有没有恢复」，而租约独自也能恢复 | 在 25s 这个**两个阈值之间**的时点问，那里只可能由请求自己结束 |

第二条的设计值得记：**两个机制覆盖同一个后果时，观察后果分不出哪个在起作用**，
必须找到它们行为分叉的那个窗口。

### 测试基建

- `packages/dsh-browser-bridge/test/dom-shim.js`：`document` 补 `visibilityState: 'visible'`（可写）。
  此前它是 `undefined`，于是**任何针对它的守卫都静默走「可见」分支**，跳过逻辑无法被测试。
- `packages/dsh-browser-bridge/test/panel-stream.test.js`：host 替身新增
  `chatRequests`（在门口计数，不是事后推断）与 `holdNextChat`（把回答时机交给测试），
  且该替身**响应 `options.signal`**——真实 fetch 就是这么做的。
- 新增 5 条测试，691 → **696** 条。

### 验证读数（已绿，不必重跑）

- `npm test` → **696 passed, 0 failed, 0 skipped**
- `npm run check:extension` → exit 0
- 真实浏览器：超时中止挂住的 fetch（`AbortError`，71ms）、不可达宿主立即 reject、
  **面板每个请求都带超时信号**（`panelSendsSignal.hasSignal: true`）
- 探针：`.tmp-run/probe-overlap.js`、`probe-hung-host.js`、`probe-hidden-polling.js`、
  `probe-timeout-real.js`、`probe-normal-latency.js`
- 变异：`.tmp-run/mutate-poll-guard.mjs`

> ## v99：面板窄到半个屏幕时还好不好用

v95/v97/v98 三轮分别在字号、输入法、动效轴上做判据。本轮选的是**宽度**：
Chrome 侧栏可以拖，宽度由读者决定，从很窄到很宽都合法，所以「在某个宽度下坏掉」
不是边缘情况，是读者随时能造出来的状态。

这个仓库已经**撞见**过两个宽度缺陷（v76 的菜单 `min-width: 200px` 在 200px 面板里
顶出右边缘 8px；以及阅读栏上限），但**没有任何判据主动扫这条轴**——两次都是碰巧。

### 结论：面板通过了，从 380px 一路窄到 168px

11 个场景 × 200px 全部 `ok: true`；380 / 300 / 240 / 200 / 168 五档全部无裁剪、
无出界、无遮挡、无可点目标不达标。168px 下 `code.` 伸出右边缘 13px，追下去是
**可横向滚动**的（`pre { overflow-x: auto }`，滚动余量 62px）——代码块按设计不折行，
超出边缘是它的正常状态，不是缺陷。

### ★ 判据错了四次，每次都把正确实现读成缺陷

这是本轮真正的工作量所在。四条假阳性，每条都差点让我去「修」一个没坏的东西：

| 读数 | 看起来像 | 实际上 | 判据修正 |
|---|---|---|---|
| 默认 380px 就报 1 处裁剪 | 面板默认宽度就坏 | `span.args` 的 `text-overflow: ellipsis` 刻意截断 | 排除 `ellipsis + nowrap` |
| 默认 380px 报「重叠 218x14」 | 两段文字压在一起 | `Range.getClientRects()` 为**同一文本节点**返回多个矩形 | 同一 owner 不比 |
| 240px 报「标题被 ⌄ 压住 7px」 | header 挤坏了 | `getClientRects()` **不遵守祖先的 `overflow: hidden`**——文字已省略，矩形仍延伸；实测 caret 与文字恒有 4px 间隙 | 文字矩形与**所有祖先裁剪框**求交 |
| 200px 报「Example Domain 被菜单压住 87x6」 | 浮层遮住正文 | 那是**读者自己打开的**菜单，点外面就关 | 按 `role="menu"/"listbox"/"dialog"` 排除可解除的层 |

第三条最危险：`#title { min-width: 0 }` 正在**按设计工作**（标题被正确省略），
而我的判据把它读成了「标题被图标压住」。**判据错的时候，正确的实现在读数里
和坏掉的一模一样。**

### ★ 一个到处报绿的判据必须证明它会报红

四条假阳性修完之后，11 个场景全部 `ok: true`。这个结果本身不可信——**一条永远
为真的断言也「全部通过」**。所以注入一个真实缺陷验证：给 `header` 加
`position: absolute; z-index: 40`（复刻 v74 那类常驻遮挡），判据立刻报红 3 处，
具体到「打造类似codex的dsh网页插件 × 更早的内容 47x15」。还原后 `git diff --numstat`
为空。

### 新增守卫测试（`test/screenshots.test.js`，+2 条 → 691）

1. `the header shrinks to fit a narrow panel instead of pushing controls off it`
   —— 钉住两个**经变异证明承重**的属性：`#title { min-width: 0 }`（去掉后实测
   200px 下面板里四个 header 元素全部出界，`#new` 出界 **67px**、`#find-open`
   **37px**——两个最要紧的按钮直接不在屏幕上）与 `#title-text` 的省略号截断
   （去掉后不溢出，但截断变成静默的，读者看不出标题被切过）。
2. `every floating surface can be opened and dismissed, so it never hides the conversation`
   —— 记录「浮层遮住页面是它存在的意义，遮住一行读者永远揭不开才是缺陷」这条
   区分，并钉住两个菜单的 `role`。

### 变异验证（`.tmp-run/mutate-width-guards.mjs`）

**6/6 命中**，每条红的都是期望的那条测试（`failedInstead: []`），
`restoredExactly: true`：`title-min-width-removed`、`title-flex-basis-fixed`、
`ellipsis-removed`、`caret-can-shrink`、`menu-role-dropped`、`listbox-role-dropped`。
脚本对每个变异都断言**套件真的跑起来了**（`suiteRan`）——锚点没找到、源码没改时
测试当然还是绿的，那是等价变异（v36 踩过：3 个坏法全报未命中，因为变异什么都没改）。

### 验证读数（已绿，不必重跑）

- `npm test` → **691 passed, 0 failed, 0 skipped**（689 → 691）
- `npm run check:extension` → exit 0
- 11 场景 × 200px 全部 `ok: true`；380/300/240/200/168 五档全部干净
- 判据报红验证：注入遮挡 → 3 处红；还原 → `git diff --numstat` 空
- 画廊指纹守卫未触发（本轮只改测试文件，未动 `extension/`）

### 新增探针（`.tmp-run/`，被 gitignore）

`probe-width-sweep.js`（判据本体：裁剪 / 出界 / 遮挡 / 可点目标四类，含
`visibleRect` 祖先裁剪求交与 `insideOpenOverlay` 语义排除）、
`probe-header-squeeze.js`（量 header 内容盒、每个子元素的 flex 与盒子、
`caretOverlapsTextBy`）、`probe-overflow-reach.js`（伸出边缘的元素能否滚到）、
`mutate-width-guards.mjs`。截图 `r40-*.png`。

> ## v98：读者说了不要动，模型菜单的箭头还是转了 180 度

前两轮（v97）走的是「第二个界面」，本轮换到**动效**这条轴：
读者在系统里选了「减少动态效果」，面板真的停了吗。

`extension/sidepanel.html` 里有两个 `@media (prefers-reduced-motion: reduce)` 块，
而它们**都按元素名覆盖**：L1067 覆盖 `.working` 的扫光，L1155 覆盖 `.live-body::after`
的闪烁光标。全文件只有两条 `transition` 声明，其中
`#model .caret { transition: transform .12s }`（配 `#model[aria-expanded="true"] .caret
{ transform: rotate(180deg) }`）**没有任何块碰它**。

**实测（`.tmp-run/probe-caret-motion.js`，真实 Chromium，点击后逐帧读旋转角）**：

| 读数 | `--reduced-motion reduce` | `no-preference`（对照） |
|---|---|---|
| `prefersReduce` | **true** | false |
| `intermediateFrames` | **6** | **6** |
| `rotates` | **true** | true |

**两档读数完全相同 = 这个设置对 caret 毫无作用。** 读者明确要求减少动效，
而那个箭头照转 180 度，经过 6 个中间帧。

### 判据：按属性枚举，并且必须在过渡**进行中的那一帧**读

「声明了 `transition`」不等于「读者看得见它动」——CSS 源码读不出这件事。
判据必须在中间帧上读计算出的 `transform`，看它是否既非起点也非终点
（`matrix(a,b,c,d,e,f)` 的 `a`、`b` 反解角度）。同时**必须跑两档对照**，
否则「我在某一档下看到了什么」会被误当成结论。

按属性枚举而不是按元素 id 找（v93 的教训）：`.tmp-run/probe-motion-coverage.js`
遍历整棵树收集所有动起来的元素，区分三类——无限循环的 `animation`（必须停）、
**motion 类过渡**（位移/旋转/缩放，必须停）、纯 `opacity` 过渡（保留）。

### 修法：不再点名元素

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation: none !important;
    transition-property: opacity !important;
  }
}
```

原来那条 `.live-body::after { animation: none }` 随之删除（已被覆盖），
原处留一行注释说明为什么不再需要它。

**两个设计判断**：

1. **按属性而不是按元素。** 点名元素意味着「这个文件里下一个新增的过渡默认没有覆盖」；
   点名属性意味着「默认被覆盖」。后者才是会一直成立的那一侧——caret 正是因为
   原来的规则只认识 `.working` 与 `.live-body::after` 才漏掉的。
2. **`transition-property: opacity` 而不是 `none`。** 淡入淡出**不是运动**，
   它通常正是运动的替代品；把它也去掉会让界面**闪现**而不是安定下来，
   对同一位前庭敏感的读者反而更糟。`!important` 是必要的——`#model .caret`
   自己的声明优先级是 `1,0,1`，通用选择器赢不过它。在 `prefers-reduced-motion`
   块里写 `!important`，表达的是**意图**而不是优先级绕道。

### 修复后的读数（两档都必须对）

| 读数 | reduce | no-preference |
|---|---|---|
| `intermediateFrames` | **0** | **6** |
| `rotates` | **false**（直接到位） | true |
| `motionTransitions` | **`[]`** | `["span.caret transform 0.12s"]` |
| `infiniteAnimations` | **`[]`** | `["div.working sweep 1.2s infinite"]` |
| 判定 | 全部停止 | 全部保留 |

`animatedCount` 在 `working` 场景由 3 降到 2——扫光完全停了。
caret 保留了 `opacity` 过渡：它现在**淡入**而不是旋转。

### ★ 一条测试把「手段」钉死了，于是拒绝更好的修法

`packages/dsh-browser-bridge/test/stream.test.js` 里那条测试断言的是**字面文本**
`"@media (prefers-reduced-motion: reduce) {\n        .live-body::after"`——
它要求那个光标必须由一条**点名它自己**的规则停住。我的改法覆盖面更大、不再需要点名，
于是被它判成回归。

**判据要问结果，不要问拼写。** 已改为在 `prefers-reduced-motion` 之后的文本里找
`animation: none !important`——同一个结局，不限定实现方式。变异验证：删掉那条全局
停用规则，改写后的断言**仍然变红**（24 passed / 1 failed），还原后恢复 25 passed。

### ★ 我自己的两个错误

1. **测试助手 `mediaBlock()` 只返回第一个同名块。** 这个样式表里有**两个**
   `prefers-reduced-motion` 块，助手返回了扫光那个，于是新测试读到「块里没有
   `transition-property`」而报了一个不存在的缺陷。已改为返回**全部**匹配块并拼接，
   注释写明「condition 不是位置」。
2. **断言里把属性名拿去匹配值。** 我写 `/transition-property\s*:\s*none/` 去匹配
   **刚收集到的值**（`"opacity !important"`），而值里从来不含属性名——所以这条断言
   **不可能失败**，变异 `kills-fades-too` 因此未被抓住。已改为只比较值本身
   （剥掉 `!important` 后判 `none|initial|inherit`）。补上后变异 **4/4**。
   这与 v93「断言单位而不断言值」是同一类错误。

### 变异验证（`.tmp-run/mutate-reduced-motion.mjs`）

**真坏法 4/4 命中**、**等价变异 1/1 保持绿**、`restoredExactly: true`：
`back-to-naming-elements`、`animations-only`、`kills-fades-too`、`block-removed`；
等价变异 `opacity-listed-twice`（`opacity, opacity` 层叠结果相同，必须不红）。

### 阴性结论：滚动没有可减少的运动（已量，别重复挖）

`.tmp-run/probe-scroll-motion.js`（`findJumped` 场景）：
`behavior: "auto"`、`settledOnFirstFrame: true`、`intoSettledImmediately: true`、
`smoothScrollingDetected: false`。面板没有声明 `scroll-behavior`，而
`sidepanel.js:2326` 的 `scrollIntoView({ block: 'center' })` 不带 `behavior` 参数，
故遵循计算值 `auto` = **瞬时**。

### 守恒证据

14 张已提交截图重渲后**逐字节完全相同**——改动在默认动效设置下**视觉零影响**，
只在读者真的要求减少动效时生效。

### 验证读数（已绿，不必重跑）

- `npm test` → **689 passed, 0 failed, 0 skipped**
- `npm run check:extension` → exit 0
- 真实浏览器两档：reduce `intermediateFrames: 0` / no-preference `6`

### 新增探针（`.tmp-run/`，被 gitignore）

`probe-motion-coverage.js`（按属性枚举全树动效）、`probe-caret-motion.js`（中间帧判据）、
`probe-scroll-motion.js`（滚动是否有动画）、`mutate-reduced-motion.mjs`、
`why-fade-mutation-missed.mjs`（查断言为何抓不住变异）。

> ## v97：设置页不听读者的话

本轮换到 **`extension/options.html`** —— 这是本扩展的**第二个界面**，与 `sidepanel.html` 并列。
v91/v92/v93 三轮把「读者的字号设置」这条轴走了一遍，但**只扫了 `sidepanel.html`**。
设置页从未进入这条轴，于是它是全仓库唯一一个**还在用绝对 px 写字号**的界面。

**缺陷读数**（`.tmp-run/probe-options-scaling.js`，一次求值内量两档）：根字号 16px → 32px，
**23 个文字元素 `grewCount: 0`、`frozenCount: 23`** —— 一个都没动。200% 的截图与 100% 的
截图 **sha256 完全相同**（`b9f39e8b…`）。这不是「放大得不好看」，是**完全没放大**，
违反 WCAG 1.4.4（要求 200%）。

**修法**：`:root` 新增三个 **rem** token，默认根字号下与原来的 px **完全等值**
（`--text-xs: 0.78125rem` = 12.5px、`--text-sm: 0.8125rem` = 13px、`--text-base: 0.875rem` = 14px），
所有 px 字号改引 token；`h1` 用 `1.1875rem`（=19px）。

**★ 三处 `font:` 简写里的 px 同样是承重的**：输入框与 `#result` 原本写
`font: 13px/1.4 ui-monospace, …` / `font: 12.5px/1.5 …`，简写里的字号与行高都不跟随。
必须拆成 `font-family`/`font-size`/`line-height` —— **只改 `font-size` 声明是不够的，
因为出问题的那两个元素根本没有 `font-size` 声明。**

**★ `max-width: 640px` → `40rem`**：px 写死时，200% 会把每行字数**减半**——页面服从了设置，
却因此更难读。这与本仓库 v74 记下的教训同源（让位必须画在盒子外面而不是内容里面）。

**★ 复选框不继承 `font-size`**：`label.check` 里的 `input[type=checkbox]` 是**替换元素**，
字号不继承。文字改 rem 之后，200% 下同一行里是 **28px 的字配 13px 的方块**，
读起来像一个坏掉的控件。加 `inline-size`/`block-size: 0.8125rem`（正好是 Chrome 默认画的 13px，
所以默认视图一格都不动）。

**★ 但那个方块不是可访问性缺陷，这点必须写清楚**：探针量到 `#autopush` 盒子 13×13，
看着该判 WCAG 2.2 SC 2.5.8（24×24）失败——**实测承载点击的是 `label[for=autopush]`，606×28**，
`perSideMet: true`。全页 `failingCount: 0`。这正是 v75 记录的 **Spacing 例外**。
**「盒子小于 24」不等于「目标小于 24」**，本仓库已第二次踩这条。

**守恒证据**：默认字号下改前改后 **`DIFFERENT 0 of 2952000`** —— 逐像素完全一致。
改动只在读者真的放大时才生效。

**验证读数**：`grewCount` 23/23、控件 7/7、`overflowAt100: 0`、`overflowAt200: 0`。

**★ 变异第一轮 5/6，没红的那条抓出了我自己测试的缺口**：
`body-font-size-back-to-px` 把 `font: var(--text-base)/1.55` 改回 `font: 14px/1.55`，而我的正则
`/font-size:\s*([^;]+);/g` **只看 `font-size` 声明，看不见简写里的字号**——与 v93「断言单位而不断言值」同类。
补上简写解析后 **6/6 命中**。
写这段时又踩两次：①`font: inherit`（按钮上的合法重置，根本不带字号）被我的检查误判，
必须只判**含斜杠**的简写；②`var(--text-base)` 里没有字面量 `rem`，判据必须接受**指向 token 的引用**——
「绝对长度」才是要禁的东西。

**★ v96 设的截图指纹守卫当场生效**：改完 `options.html` 跑全量，`screenshots.test.js` 立刻报
「面板变了而截图没重渲」，因为指纹包含 `extension/options.html`。按 `AGENTS.md` 的规则在同一提交里
重渲了画廊。**重渲后发现 `tool-failure.png` 真的变了一张**：旧图里有一条**竖线**，
是 `.live-body::after` 的闪烁光标恰好被拍到可见的半个周期（70 像素，位于 CSS (30, 645–662)）；
该场景并没有正在流式的回答，那条线**本来就不该在**。重渲后消失。三条读数佐证：
新图与 `--reduced-motion no-preference` 逐像素相同、旧图与它差 70 像素、两种设置各自连渲两次都稳定。

**新增探针**：`.tmp-run/probe-options-scaling.js`（两档配对，报 grew/frozen/overflow）、
`probe-options-controls.js`（控件盒子是否跟随）、`probe-options-targets.js`（按**承载点击的元素**
判 2.5.8，含 Spacing 例外）、`probe-options-set-root.js`、`mutate-options-scale.mjs`（6 真坏法全命中、
`restoredExactly: true`）。

**新增测试**（`packages/dsh-browser-bridge/test/options.test.js`，688 条）：
`every text size on the settings page is relative to the reader`（含 token 的具体值与简写检查）、
`the settings page does not pin its measure or its controls to pixels`。

> ## v96：对话被压缩了，而面板不知道

本轮换到**上下文压缩（compaction）**这条轴。前面几十轮量的都是面板自己怎么画，
这一条问的是：**宿主把对话改短了，面板看得出来吗？**

**答：看不出来，而且这不是罕见的边角。** 实测这台机器的 `~/.dsh/sessions`
（`.tmp-run/probe-compaction-reality.mjs`，逐帧解 zstd 后统计）：**156 个会话里
30 个被压缩过**，共 167 个压缩点、370 个被替换事件，最多的一个会话被压缩了
**77 次**。

**缺陷**：压缩检查点是一条 `user/message`，`source.kind === 'compact-checkpoint'`。
而 `packages/dsh-browser-bridge/lib/chat.js` 的 `describeEvents` 在 `user/message`
分支里只认识两支——`source.kind === 'user'` 与 `source.plugin === PLUGIN_ID`——
**其余静默丢弃**。被丢弃的正好是唯一解释「对话为什么变短」的那一条。

后果不是「少了一行提示」，而是**读者无法分辨两件不同的事**：「我们没聊过这个」
与「聊过，但被折走了」。翻到上面，对话就那么开始了，像是本来就只有这么长。

**★ 机制上的关键**：`appended(event)` 这道守卫在分支最前面，而它的职责就是跳过
**替换**事件——检查点恰恰是 `surfaceOp: { op: 'replace', startSeq, endSeq }`，
**它就是那个替换**。所以处理压缩必须放在守卫**之前**。放在之后，代码写得再对
也永远不会执行，而且**测试如果不专门构造这个顺序就抓不到**——变异里专门留了一条
`checkpoint-after-the-appended-guard` 守着它。

**修法**：`chat.js` 在守卫前新增 `source?.kind === 'compact-checkpoint'` 分支，
产出 `{ kind: 'compaction', text, shadowed, compactionId }`。三个字段各有理由：

- `shadowed` = `endSeq - startSeq + 1`，取自事件**自带**的区间，不是面板数出来的
  行数。留下的是残存，区间才是被替换的量。真实区间实测从 `19–311`（293 条）到
  `672–744`（73 条）不等。
- `text` 是**给人读的摘要散文**，实测 1339–6117 字符——它是被移走那段历史**唯一
  幸存的记录**，所以留着并且能展开，而不是丢掉。
- `compactionId` 是行的名字。`rowKey` 的兜底是文本，而**摘要没送到时文本是空的**
  ——两个空摘要的检查点就会共用一个行名，这正是 v71 记录过的
  「空 `callId` 让所有 tool 行变成同一行」的同一种坏法。

**面板侧**（`extension/sidepanel.js`）：`renderRow` 新增 `compaction` 分支，
画成**一条横线加中间的标签**，而不是气泡——它是一条**边界**，不是谁在此处说过的话；
画成气泡会读成「有人在这里说了这句」，恰是这行要纠正的错觉。摘要默认折叠。

**★ 本轮真实撞到、且是本仓库反复出现的同一类缺陷**：`expandedCompactions` 集合与
渲染分支都加好了，点击却什么都不发生。原因不在新代码，而在 `drawTranscript` 的
**变更签名**里只列了 `expandedReasoning` 与 `expandedFailures`——新集合没进签名，
于是点击改了集合、签名看起来**毫无变化**，函数在早返回处直接 return。
**一个没进签名的展开集，是一个「变化看起来不像变化」的集合。** 已修复，并加了变异
`signature-omits-the-open-set` 守着。

**★ 高对比度下的第二处缺陷**：分界线是用伪元素的 `background: var(--line-soft)`
画的，而 `forced-colors: active` **把每个 background 重绘为 `Canvas`**——线于是变成
背后页面的颜色。实测两半的 `background` 都是 `rgb(0,0,0)`、背后也是 `rgb(0,0,0)`，
即 8% 的黑压在全黑上。**标签还在，边界没了。** 修法用本仓库已记录的那条判据（v75）：
该模式**只保留 `border`**，所以在 `@media (forced-colors: active)` 块里改用
`border-top: 1px solid CanvasText` 并把 `height` 归零（border 自己画线，留着会变两像素）。

**★ 判据错了会把缺陷读没了（本仓库第七次同类）**：第一版探针直接比颜色**字符串**，
于是 `rgba(0,0,0,0.08)` 与 `rgb(0,0,0)` 被判为「不同」——探针报 `rulesVisible: true`，
而那条线在屏幕上是**同一种颜色**。判据必须是**合成之后**的结果，不是声明的字符串。
改成 alpha 合成后立刻读出 `beforeSameAsBackground: true`。

**★ 我自己第二个错误**：改动 `sidepanel.js` 时用 PowerShell `Set-Content` 写回过一次
文件，把行尾从 CRLF 变成了 LF。随后我用 `git show HEAD:file | Out-File ...` 去核对行尾，
**报告说 HEAD 是 CRLF**——于是我准备写一个脚本把整棵树改回 CRLF。停下来的原因是查了
`.gitattributes`：仓库写着 `* text=auto eol=lf`，**磁盘上 LF 才是对的**，而
`core.autocrlf=true` 下 `git show` 经管道出来时被重新编码了。**那是测量假象，不是发现。**
判据应该是 `git diff --numstat`：真实改动读作 `95 1`，行尾重写读作成千行对成千行。
已把这一条写进 `AGENTS.md`，因为一个把整棵树改坏的行尾脚本比它要防的问题更糟。

**★ 顺带修好一个更严重的、已存在四轮的缺陷**：`picture.png` 与截图里的产品**不一致**。
查证过程：该场景**确定性**（同代码连渲两次 sha256 相同），而**用 HEAD 的源文件**渲出来
的图与**已提交**的图差 **661756 / 1094400 像素**——所以不是本轮改坏的，是提交进去的
时候就已经是旧的。

根因：`58ed8b1`（给回答加阅读宽度、不再让面板宽度决定行长）**改了面板排版却没重渲
画廊**，其后 `3d96bf1`/`e3ad6ba`/`6c5f54c` 三个动样式的提交也都没重渲。
**README 上的图是产品声明，而它连着四个提交在说一件产品已经不再做的事。**

守卫的缺口在于：`test/screenshots.test.js` 的三条断言问的全是「文件**在不在**」
（存在、是 PNG、体积够、场景还在），**没有一条问它是不是还**像现在**的产品**。

修法：`tools/gallery.mjs` 渲染完后写出 `docs/screenshots/SOURCES.json`，记录
**渲染所依据的文件指纹**（`extension/` 下全部 js/html/css + `tools/preview.mjs`，
按路径与内容一起哈希，路径也进哈希所以改名也算变化）；`screenshots.test.js`
**自己重算**一遍这个指纹（不是读工具的函数，否则改了哈希范围两边会一起悄悄跟着变），
不一致就报「面板变了而截图没跟着重渲」，并给出重渲命令。

**变异验证**（`.tmp-run/mutate-freshness.mjs`，3/3 命中、`restoredExactly: true`）：
`a-style-changed-without-regenerating`（**这正是真实发生过的那件事**）、
`the-preview-fixture-changed`、`the-record-was-hand-edited`。

**验证读数**：
- `npm test` → **686 passed, 0 failed, 0 skipped**（672 → 686）
- `npm run check:extension` → exit 0
- 压缩变异 `.tmp-run/mutate-compaction.mjs`：**真坏法 11/11 命中**、
  **等价变异 1/1 保持绿**、三个文件 `restoredExactly: true`
- 新鲜度变异：**3/3 命中**、复原精确
- 真实浏览器：`compacted` 场景 6 行、压缩行渲染出「上下文已压缩 293 条历史记录 ⌄」；
  `compactedOpen` 点开后 caret 变 `⌃` 且摘要正文出现
- 高对比度：分界线 `beforeVia: "border"`、合成色 `rgb(255,255,255)`、`rulesVisible: true`
  （修复前 `rgb(0,0,0)` 压在 `rgb(0,0,0)` 上）
- 浅色方案与普通深色方案均 `rulesVisible: true`，线仍由 `background` 画（行为未变）

**★ 一条被判定为等价的变异（如实标注，没有算进命中率）**：去掉 `height: 0` 只留
`border-top`，在高对比度下量出来的几何**完全相同**（`beforeHeight` 都是 1px、行的
24px 与线心 464 都不变）。所以「测试没红」是对的。脚本把两类分开统计
（`realCaught` 与 `equivalentHeld`），**不混成一个「命中数」**。

**新增能力**：`tools/preview.mjs` 新增 `compacted` 与 `compactedOpen` 两个场景
（夹具 `COMPACTED_MESSAGES`）；`tools/gallery.mjs` 新增第 14 张图 `compaction.png`；
`README.md` 新增「对话被压缩之后，它会告诉你少了多少」一节。

**新增探针（`.tmp-run/`，被 gitignore）**：`probe-compaction-reality.mjs`（真实日志
统计）、`probe-checkpoint-shape.mjs`（事件字段与邻域）、`probe-compaction-click.js`
（点击为何无效）、`probe-compaction-edges.js`（**合成后**比色）、`probe-rule-height.js`、
`probe-rule-height-equivalence.mjs`、`probe-shot-determinism.mjs`（场景确定性）、
`diff-committed-shots.mjs`、`mutate-compaction.mjs`、`mutate-freshness.mjs`。

> ## v95：输入法在拼字，面板却在听命令

本轮换到**输入法（IME）**这条轴。前面几轮量的是字号、尺寸、失败、搜索，而这一条
属于最日常的输入路径：写中文、日文、韩文时，**每一次输入都要先用输入法拼出候选**。
面板自己在一个处理器的注释里写着这件事「不是边缘情况，而是每条消息」——但那条
注释只守住了它自己所在的那一个处理器。

**缺陷**：`extension/sidepanel.js` 有五个 `keydown` 处理器，其中三个跑在文本框里，
而**只有一个**带输入法守卫（`input` 的 Enter，L3969 附近）。真实 Chromium 实测
（`.tmp-run/probe-ime-composition.mjs`，用 CDP 的 `Input.imeSetComposition` 建立
**真实**组合，不是给合成事件贴一个 `isComposing: true`）：

| 场景 | 修复前 | 说明 |
|---|---|---|
| 组合中按 Escape（焦点在 composer） | **`escapeLeakedWhileComposing: 1`** | 读者想取消候选，**查找栏/会话列表被关掉** |
| 组合中按 Enter（焦点在查找框） | **`findSteppedWhileComposing: 1`** | 想选字，**跳转到了下一个命中** |
| 组合中按 Enter（composer，已有守卫） | `composerSentWhileComposing: 0` | 已正确 |
| **对照**：非组合按 Enter | `isComposing: false`、`sentCount: 1` | Enter 本身正常 |
| **对照**：非组合按 Escape | `isComposing: false`、`closedLayer: 'find'` | Escape 本身正常 |

**★ 为什么必须实测才能定案**：我原本推测组合期间的 `event.key` 会是 `'Process'`——
那样 `document` 处理器在 `if (event.key !== 'Escape') return` 处早已返回，**根本不是
缺陷**。实测推翻了它：组合期间按 Escape，真实事件带的是 `key: 'Escape'`
**且** `isComposing: true`。**只读 `key` 的处理器分不出这两者。**

**修法**：新增 `imeOwnsThisKey(event)`（`sidepanel.js`，在 `atBottom()` 之前），
`event.isComposing === true || event.keyCode === 229`，放在三个文本框处理器的
**最顶部**——不是在某个分支里。`input` 处理器原有两处内联守卫**已删除**，因为顶部
那一条严格更宽（原来的写法只守了 `mention !== null` 分支里的 Enter/Tab，同一处理器
里的方向键与 Escape 没有守）。

**★ 没有改的地方，以及为什么**：`modelMenu`（L3849）与会话行按钮（L2995）也是
无守卫的 `keydown` 处理器，但它们**不跑在文本框里**，方向键不会被输入法消费。
**按属性枚举不等于见一个改一个**——把守卫加到那里只会是噪声。

**★ 我自己在验证脚本上犯的错（差点得出相反结论）**：变异脚本第一版把
`if (false) return` **插在**真实守卫**之前**，于是「变异」什么都没改，3 个坏法
全部报「未命中」。那是**等价变异**，不是测试抓不到。改成真正删除守卫后
**3/3 命中**、`restoredExactly: true`。**判据必须先证明变异真的改变了行为。**

**★ 为了让三个新测试不污染后续，我改动了两条既有断言——用差分证明没有改瞎**
文件里那条宣告测试读的是**全文件共享**的 `announcerWrites` 数组（从不重置）与
`#announcer` 区域（从不重置），所以它的判据实际上依赖「它前面有多少次 settle」。
我的测试多了一次 `settleToIdle()`，就把更早测试排队中的写入放了出来，于是它报了
一句属于**别的测试**的话（`'streaming 29'`）。改动：
- `startupAnnouncements()` 只取**启动边界**之前写入的句子（新增 `startupWriteCount`）
- 第二条断言读启动时刻捕获的 `startupAnnouncer`，与同文件既有的 `startupToast` /
  `startupFocus` 同一手法

这两处都很像「把断言改松了」。所以用 `.tmp-run/diff-assertion-rewrite.mjs` 做**差分**：
对同一批真实坏法，分别跑基线版本与我的版本，按**测试名**比较失败集合。
读数 `lostByMine: []`、`gainedByMine: ['an IME Escape …']` ——**没有丢掉任何检查，
并且多抓到一条基线抓不到的**。

**同一批差分读数里的一条阴性结论**：`drop-loadedOnce` 与 `announce-every-poll`
两个坏法，基线与我的版本**都是 0 命中**。追下去（`.tmp-run/probe-announce-trace.js`，
真实浏览器记录播报区变更）：守卫拿掉之后 `normal` 场景**依然全程沉默**
（`finalText: ''`、`changesDuringWindow: []`），因为该场景下阻塞界面根本不显示。
**所以那不是「测试漏了」，是两个等价变异。** 记录下来以免下一轮重复挖。

**验证读数（已绿，不必重跑）**
- `npm test` → **673 passed, 0 failed, 0 skipped**（671 → 673）
- `npm run check:extension` → exit 0
- `.tmp-run/mutate-ime-guard.mjs` → **3/3 命中**、`everyMutationRanItsSuite: true`、
  `restoredExactly: true`
- `.tmp-run/diff-assertion-rewrite.mjs` → `lostByMine: []`、`restoredExactly: true`

**新增探针**（`.tmp-run/`，被 gitignore）：`probe-ime-composition.mjs`（真实组合
输入，含两组对照）、`mutate-ime-guard.mjs`、`diff-assertion-rewrite.mjs`、
`probe-announce-trace.js`、`why-announce-mutation-passes.mjs`。

> ## v94：拖一下侧栏的边，正在读的那一段就被推走了


本轮换到**尺寸变化**这条轴。前三轮（v91/v92/v93）都在字号缩放上，而拖侧栏的边
是同一个「读者能改布局」的族里最常见的一个动作——面板对此**完全没有准备**。

**缺陷**：`#model-menu` 与 `#at-menu` 是 `position: fixed`，位置由 `positionMenu()`
（`extension/sidepanel.js:890`）用 `window.innerWidth` / `window.innerHeight` 算出
像素值写成内联样式；而整个面板**没有任何 `resize` 监听**（全文件搜 `resize` 只命中
一处注释）。侧栏被拖窄之后，每一行都要重新折行，转写本整体变高，而 `scrollTop`
停在原处——**文字在动，滚动位置不动**。

**实测（真实 Chromium，`tools/preview.mjs` 新增 `--resize`）**：

| | 380px（基线） | 缩到 260px（修复前） | 缩到 260px（修复后） |
|---|---|---|---|
| 视图顶端那一段文字 | 「按钮被一个透明的遮罩层挡住了…」 | **「第 195 个问题：…」** | 「按钮被一个透明的遮罩层挡住了…」 |
| 顶端行下标 | 53 | **45（退了 8 行）** | **53（未变）** |
| `scrollTop` | 4521 | **4521（一动没动）** | 5445（跟着文字走） |
| `scrollHeight` | 5109 | 6159 | 6159 |

读者正在读的回答被推出屏外，眼前换成八行之前的提问。**贴底的人同样受害**：修复前
`gapToBottom` 从 0 变成 1165，最新一条回复被推到看不见的地方。

**根因不是漏了补偿，是补偿的触发条件**：`drawTranscript`（`sidepanel.js:1697`）
本来就在重绘后按「加了多高就补多少」恢复位置，注释还写明了为什么。而
**改尺寸不是重绘**——没有一行被重新渲染，那条路径根本不会跑。`extension/sidepanel.html:390`
的 `overflow-anchor: none` 又关掉了浏览器自己的滚动锚定（注释记载：它和手写的恢复
逻辑打架），于是这个情形**两个机制都不管**。

**修法**：记录「视图顶端那一行 + 它距顶端多少」，在 resize 时放回去。
- `rememberReadingPlace()` / `restoreReadingPlace()`（`sidepanel.js`），
  状态 `let readingAnchor = null`。
- **记的是节点不是下标**：`reconcileRows` 会复用节点，而加载更早的内容是往**前面**
  插行，下标会整体平移（v71 修过同一个坑的另一面）。
- 锚点在**滚动时**就记好，不是等 resize 才去量——`resize` 监听跑起来的时候，浏览器
  已经按新宽度重排完了，旧位置已经没了。
- **贴底的情形单独处理**：那里的「位置」是转写本的末尾，不是某一行；只做偏移补偿会
  把贴底的读者落在后面。`restoreReadingPlace` 在 `stickToBottom` 时直接
  `scrollTop = scrollHeight`（赋值超出末尾会停在末尾，所以变高变矮都对）。
- 顺带 `stickToBottom = atBottom()` + `rememberReadingPlace()` + `updateToBottom()`
  一起收尾：一次重排可能把读者推过 `NEAR_BOTTOM_PX` 这条线，留下陈旧的 `stickToBottom`
  会让**下一条到达的消息**要么把已经上翻的人拽回底部，要么把贴底的人落在后面。
- 两个浮层在 resize 后重新定位（`positionMenu` / `positionMention`）。实测窄化之后
  内联 `left` 是陈旧的 `22px`（正确答案 `16px`），目前被 CSS `max-width` 挡住一半。

**★ 三条测试基建的真实缺口（不修就写不出这两条测试）**：
1. `packages/dsh-browser-bridge/test/panel-stream.test.js` 的 `globalThis.window` 替身
   **只记录 `focus` 监听，其余静默丢弃**——面板可以注册 `resize`、也可以不注册，
   没有任何断言分得出来。改为按事件名记录（`windowListeners`）。
2. `test/dom-shim.js` 的 `getBoundingClientRect()` 把 `top` 写死为 `0`，于是
   **任何「两个元素之间」的测量都无法表达**（锚点距滚动容器顶端多少，正是本轮要测的）。
   新增可写字段 `rectTop`，`top` 由它得出。
3. `test/dom-shim.js` 没有 `Node.contains`，面板用它判断「我记的那一行还在不在」。
   补上（沿 `parentNode` 上溯）。

**★ 我自己的测试错了两处，都是「我以为的状态不是实际状态」**：
- 第一版跑起来 `view = history`（上一个测试把面板留在会话列表），转写本只有 3 行。
  用既有的 `openChat()` 助手修好。
- 修好之后仍然 3 行：`host.reads.at(-1)` 带着 `end: 96`——**更早的测试把搜索窗口停在了
  会话中间**，面板画的是一段窗口而不是最新的 60 行。诊断办法是把 `host.reads` 的最后一笔
  打出来，而不是继续猜。
- 断言也错过一次：原本断言「锚点距顶端仍是 40px」，而 shim **不把 `scrollTop` 和几何
  联动**，所以在那里断言视觉结果是不忠实的。改为断言**滚动偏移恰好补上锚点移动的距离**
  （75px），并把滚动容器自己的 `rectTop` 设成 30 而非 0——否则「忘了减容器原点」这个
  错误实现照样能通过。

**验证读数（已绿，不必重跑）**
- `npm test` → **671 passed, 0 failed, 0 skipped**（669 → 671）
- `npm run check:extension` → exit 0
- `.tmp-run/mutate-resize-anchor.mjs` → **6/6 命中**、`restoredExactly: true`：
  `no-resize-listener`、`restore-does-nothing`、`anchor-never-remembered`、
  `bottom-case-dropped`、`uses-height-delta`（用 `scrollHeight` 差当位移——看起来合理，
  但两个数无关）、`forgets-scroller-origin`（不减容器 `rectTop`）。
  每条红的都是对应的那条测试，且只有它。
- 真实浏览器两条路径：读中间的人缩放后顶端文字不变（`topVisibleIndex: 53`）；
  贴底的人缩放后 `gapToBottom: 0`、`atBottom: true`、末行完整可见。

**新增工具能力**（`tools/preview.mjs`）：`--resize WxH`（加载**之后**改尺寸，走
`Emulation.setDeviceMetricsOverride` 触发真的 `resize` 事件）、`--scroll-bottom`
（先滚到最新一行，好让「贴底」这个前置条件可复现）。用法已写进文件头。

> ## v93：字号缩放轴上还剩三处「盒子装不住自己的字」
>
> v92 修掉了输入框的行高，但那只修好了**被点到名的那一个**。本轮不再逐个找，而是
> **按属性枚举**：凡是「自己带文字、自己又不是滚动容器、且祖先里有写死高度」的元素，
> 一律量 `scrollHeight - clientHeight`（内容装不下的标准信号）。
>
> 这一类为什么躲得过既有的「丢字」判据：**按钮的 `overflow` 默认是 `visible`**，
> 文字比盒子高时不被裁掉，而是**画到盒子外面**——既不「丢字」，也不一定与别的盒子
> 相交。v91/v92 的两条判据都看不见它，必须换成装载量。
>
> ### 三处缺陷（都是 200% 下才出现）
>
> | 元素 | 盒子 | 文字 | 溢出 | 机制 |
> | --- | --- | --- | --- | --- |
> | `#blocked-action`（重试按钮） | 32px | 33px | **7px** | 写死 `height: 32px` |
> | `#earlier`（更早的内容） | 26px | **66.5px** | **46px** | 写死高度 **且** 换行成 2 行 |
> | `#to-bottom`（↓） | 28px | 33px | **11px** | 写死 `height: var(--to-bottom-size)` |
>
> ### ★ `#earlier` 的真正机制不是「字变大」，是它只有半个面板宽
>
> 第一直觉是「字变大了所以装不住」。量出来才发现第二层：
> `left: 50%` + `transform: translateX(-50%)` 这个**居中惯用法**把元素左边缘放在面板
> 中线上，于是它的**可用宽度只有面板的一半**——380px 的面板里只有 190px。
> 200% 时标签需要 111.7px 文字 + 内边距，超过可用宽度就**换行成 2 行**
> （`lineBoxes: 2`），再被 26px 的固定高度裁在外面。
>
> **两种写法看起来等价，其实不等价。** 改成 `left: 0; right: 0; margin: 0 auto;
> width: fit-content` 之后可用宽度是整个面板，200% 下 `lineBoxes: 1`、`overflow: 0`，
> 而居中精度实测 `offCentreBy: 0`（16/24/32px 三档都是 0，左右空隙相等）。
>
> ### ★ token 的单位是承重部分，不是风格问题
>
> `--pill-height`（26px）与 `--to-bottom-size`（28px）不是普通常量：它们是**同一个数被
> 两处读到**——胶囊自己的高度，与 `#transcript` 的让位 `margin-top`（v74 建立的不变式）。
>
> 所以必须用 `rem` 而**不能**用 `em`：`em` 在哪个元素上就读哪个元素的字号，而胶囊是
> 12px、转写区是 13px——同一个 token 会解析成 26px 与 28.2px，让位差一个 12/13 的比例。
> **在默认根字号下这个漂移只有 2px，根本看不出来**，只有放大后才暴露。
> 改成 `1.625rem` / `1.75rem` 后，实测三档的 `slack` 恒为 **6px**（就是规则里那个 `+ 6px`
> 间距），说明两处始终解析成同一个值。
>
> ### 验证读数（已绿，不必重跑）
>
> - `npm test` → **669 passed, 0 failed, 0 skipped**（未新增测试，扩展了一条既有测试）
> - `npm run check:extension` → exit 0
> - 三个场景 `offendersAt200: 0`（`hostDown` / `findJumped` / `longReasoningOpen`）
> - **13 张已提交截图重渲后逐字节不变**——证明修复在默认字号下完全守恒
>   （`search.png` 一度报 1 像素差异，位于 CSS (7, 56.5)，是已记录的焦点环抗锯齿抖动，已还原）
> - 让位不变式：三档 `coveredAtEverySize: true`、`clearAtEverySize: true`、`reservationGrew: true`
> - 居中与默认尺寸：`bothCentredAtDefault: true`、`defaultSizesUnchanged: true`、`clippedAnywhere: false`
> - 变异 `.tmp-run/mutate-text-fit.mjs`：**6/6 命中**、`restoredExactly: true`
>
> ### ★★ 变异第一轮只有 2/6，暴露出我自己的测试有四处缺口
>
> 跑完变异发现四条**没红**，而 `suiteNeverRan: []` 证明套件真的跑起来了——所以是
> **测试不足，不是脚本坏了**：
>
> | 没红的变异 | 缺什么 |
> | --- | --- |
> | `blocked-action-wrong-denominator`（`32em/13` → `32em/14`） | 只断言了「不是 px」，**错的分母也不是 px** |
> | `pill-token-back-to-px` | 没有任何测试约束 token 的单位 |
> | `pill-token-to-em` | 同上——而这正是会让两处漂移的那个单位 |
> | `to-bottom-back-to-fixed-height` | 只覆盖了 `#earlier`，没覆盖 `#to-bottom` |
>
> 补上「具体值 + 分母 + 两处都覆盖」之后 **6/6**。
> **教训与 v92 完全一致，且这次是自己抓自己**：断言单位而不断言值，等于没断言。

> ## v92：v91 改完字号之后，输入框里的字叠在了一起
>
> **这是 v91 的续集，而且 v91 的验证没覆盖到它。** v91 把文字 token 换成 `rem`、
> 给一批盒子加了地板，但**漏了 `#input` 的 `line-height`**：它是写死的 `20px`。
>
> v91 之后，字号会跟着读者放大，行高不会——于是：
>
> | 根字号 | 字号 | 行高 | 比值 |
> | --- | --- | --- | --- |
> | 16px | 14px | 20px | 1.43 ✓ |
> | 24px | 21px | 20px | **0.95** |
> | 32px | **28px** | **20px** | **0.71** |
>
> **实测后果**（截图 `.tmp-run/r33-composer200.png`）：200% 下输入框里打三行字，
> **三行完全叠在一起**，读者读不出自己在写什么。同时 `min-height: 28px` 也没跟着涨，
> 空的输入框就已经需要滚动。
>
> **为什么 v91 没发现**：v91 的判据是「有没有字被盖住」，量的是**对话区**；
> 输入框里当时没有内容，也不是被谁盖住——它是**自己叠自己**。判据覆盖了「被别的
> 元素挡」，没覆盖「和自己重复」。这一次的判据换成「行高与字号的比」。
>
> ### 一并修掉的同类（按属性枚举，不按 id）
>
> `line-height: 20px` 只有一处，但**固定高度装文字**的还有四处：
> `#model`（28px）、`#find-input`（26px）、`.approval-actions button`（28px）、
> `.menu-effort`（26px）。全部换成地板。
>
> ### ★★ 两个只有量才能发现的坑（都真实踩到）
>
> **① `em` 的分母是元素**自己的**字号，不是根字号。**
> 我先写 `#model` 的 `min-height: 2em`，以为按根字号算。实测 **26px**——
> `#model` 自己是 13px 字号，`2em` = 26px，而它原来是 28px。
> 正确写法是 `calc(28em / 13)`。**这类错误在样式表里完全看不出来。**
>
> **② 无单位比值会被每个子元素各自重算。**
> 我把 `#model` 的 `line-height` 写成 `calc(20 / 13)`（无单位 1.538），
> `getComputedStyle(#model).lineHeight` 读到 `20px`，**看起来完全正确**。
> 但 `model-menu.png` 有 **61 个像素**变化，位置在 CSS (180.5, 681)。
> 放大 8 倍比对后两侧字形相同——我一度判断为抗锯齿，**错了**。
> 再量子元素才看清：`.caret` 是 12px 字号，无单位比值让它拿到
> **12 × 1.538 = 18.46px**，而不是原来所有子元素统一的 20px。
> 改成 `calc(20em / 13)`（**长度**）后 caret 回到 20px，61 个像素随之消失。
>
> **判据升级为**：`line-height` 必须是长度，且分母必须是该元素自己的字号。
> 只断言「不是 px」不够——错的分母也不是 px。
>
> ### 验证读数（已绿，不必重跑）
>
> - `npm test` → **669 passed, 0 failed, 0 skipped**
> - `npm run check:extension` → exit 0
> - **13 张画廊截图重渲后逐字节守恒**（`search.png` 曾有 **1 个像素**差异，位于
>   CSS (7, 56.5)，是已记录的 `#find-input` 焦点环圆角抗锯齿抖动，已还原）
> - 12 个场景 × 根字号 32px：`textUnreachableAt200: false`（全部）
> - `.tmp-run/probe-floor-values.js`：**12 项地板在默认根字号下全部 `matches: true`**
>   ——地板没有挪动任何东西
> - 变异 `.tmp-run/mutate-font-scale.mjs`：**18/18 命中**、`restoredExactly: true`
>
> ### 新断言（`packages/dsh-browser-bridge/test/panel-geometry.test.js`）
>
> 扩进既有的 `the reader’s own font size reaches the text, and the boxes grow with it`：
> ① 五个承载文字的控件不许有固定 `height`、不许有 `px` 行高；
> ② `#input` 与 `#model` 的 `line-height` 必须是**具体的那两个长度表达式**
> （分母写错也「不是 px」，所以只查单位不够）；
> ③ 地板必须是「按各自字号的 calc」，分母 12/13/14 各按元素实际字号。
>
> **变异先抓出了缺口**：`model-line-height-wrong-denominator`（`20em/13` → `20em/14`）
> 第一轮**没红**——我只断言了「不是 px」。补上具体值才命中。

> ## v91：读者自己的字号设置，在这个面板里什么都做不了
>
> **缺陷是硬性的、且一直存在**：Chrome 的「字体大小」设置（以及任何改根字号的
> 手段）**对本面板完全无效**。实测（`.tmp-run/probe-text-scaling.js`）：把根字号
> 从 16px 调到 24px（+50%），正文**仍是 14px**——`rootScalesText: false`、
> `grewCount: 0`。
>
> 机制：三个文字 token 写的是 **`px` 绝对值**
> （`extension/sidepanel.html` 的 `--text-xs: 12px` 等）。`px` 不随根字号缩放，
> 所以「读者把字调大」这条路一像素都不动。**这不是审美问题**：WCAG 1.4.4 要求
> 文本能放大到 200%，而这里读者唯一的放大手段只剩页面缩放。
>
> **两条判据都单独成立过**（不是一条读数的推论）：
> - 改根字号 → 正文不动（`rootScalesText: false`）
> - 页面缩放 → 布局不破（`.tmp-run/probe-page-zoom.js`，200% 下无溢出、composer 仍在视口）
> - 而缩放判据本身**先被验证过是有效的**：`.tmp-run/probe-zoom-works.js` 量到同一个
>   `.answer` 在 zoom 前后高度 199 → 609（`zoomTookEffect: true`）。**不先验判据，
>   「什么都没变所以没坏」会被读成「缩放没问题」。**
>
> **修法（三处，缺一不可）**：
> 1. 文字 token 改 `rem`：`--text-xs: 0.75rem` / `--text-sm: 0.8125rem` /
>    `--text-base: 0.875rem`（默认根字号 16px 下与 12/13/14px **完全等值**）。
> 2. 固定高度的盒子改**地板**：`header` 的 `height: 44px` → `min-height: 44px`，
>    `.icon`/`#send` 的 28px → `min-width/min-height: 1.75rem`，`.copy` 的 24px →
>    `min-height: 1.5rem`。**字涨了盒子不涨，字就会压到邻居身上。**
> 3. 字形尺寸也改 `rem`（`.icon` 0.9375rem、`#send` 0.875rem），否则圈变大了箭头没变。
>
> ### 放大后真的坏在哪（`.tmp-run/probe-covered-text.js` 第五版判据）
>
> | 根字号 | 正文实际 | 被盖住的字 |
> | --- | --- | --- |
> | 16px（默认） | 14px | **0** |
> | 24px（150%） | 21px | **0** |
> | 32px（200%，WCAG 线） | 28px | 修复前 **20** → 修复后 **0** |
>
> 修复前 32px 下三处可见破损（截图 `.tmp-run/r32-at200.png`）：页头标题的省略号
> 与 `˅` 箭头重叠、代码块的 "json" 与「复制」按钮挤在一起、底下的 chip 压住代码块。
>
> ### ★ 判据错了**六次**（本仓库最多的一次，值得单独记）
>
> 同一件事我写了六版探针，每一版都因为漏掉一个「什么都不算」的条件而误报：
>
> | 版本 | 判据 | 错在哪 |
> | --- | --- | --- |
> | ① | 遮挡物用 `getBoundingClientRect` | 滚出滚动容器的元素**不被绘制**，布局盒却还在 → 报出「滚动区里的代码块盖住了 footer 里的 chip」这种不可能的事 |
> | ② | 改用 `elementFromPoint` | 只返回**被绘制**的元素（这一步对），但对滚出去的字符它返回「恰好画在那个位置的东西」 |
> | ③ | 加「在滚动容器可见区内」 | `visibleClip` 找的是**最近的滚动祖先**，而命中返回的 `.composer-bar` 不是滚动容器，两者不可比 |
> | ④ | 加 ellipsis 排除 | 对（标题的正常省略是真的不该报），但仍带着 ②③ 的病 |
> | ⑤ | 加几何相交验证 | 对（`notIntersecting: 0` 证明坐标没偏），但仍带着 ③ |
> | ⑥ | 只看**可达性**：字符相对容器内容的偏移是否落在 `[0, scrollHeight]`，横向是否在 `clientWidth` 内 | 正确 |
>
> 第⑥版还要再排两类：**`.sr-only`**（`clip-path: inset(50%)` 刻意移出视觉布局，
> 读屏照样读得到——把无障碍设施报成缺陷）与 **`opacity: 0`**（`.answer-actions`
> 平时透明，`elementFromPoint` 照样命中它；v75 的对比度审查器处理过同一件事）。
>
> **教训**：`elementFromPoint` 只在「这个点画的是什么」上可信；一旦要与「谁在谁
> 上面」结合，必须**同一套几何**回答，不能一半 hit-test、一半布局盒。而读者真正
> 关心的是**可达性**（能滚到吗），不是**此刻的可见性**——这两者我混了整整五版。
>
> ### 一次被判据救下的想当然
>
> `findJumped` 在 200% 下报复制按钮 64×124 盖住正文。我**先入为主**判断是
> 「文字换行了」，加了 `white-space: nowrap`。写完探针一量：
> `lineBoxes: 1`、`whiteSpace: nowrap`——**根本没换行**，我的修改是多余的。
> 真正原因是 `.answer-actions` 是 flex 容器，`align-items` 默认 `stretch`
> 把按钮拉到了容器满高。改的是 `align-items: flex-start`（那一处留下了）。
> **先量再改，不要先改再量。**
>
> ### 验证读数（已绿，不必重跑）
>
> - `npm test` → **669 passed, 0 failed, 0 skipped**（668 → 669）
> - `npm run check:extension` → exit 0
> - **默认字号下与已提交的截图逐像素比对 `DIFFERENT 0 of 1094400`**——这证明
>   本次改动在任何正常使用下**完全守恒**，是零风险改动。
> - 12 个场景 × 根字号 32px：`textUnreachableAt200: false`（全部）
> - 变异 `.tmp-run/mutate-font-scale.mjs`：**8/8 命中**、`restoredExactly: true`
>   （`text-tokens-back-to-px`、`wrong-rem-denominator`、`header-back-to-height`、
>   `copy-back-to-height`、`icon-floor-in-px`、`copy-floor-in-px`、
>   `send-box-back-to-px`、`send-glyph-fixed-in-px`）
>
> ### 新测试（`packages/dsh-browser-bridge/test/panel-geometry.test.js`）
>
> `the reader’s own font size reaches the text, and the boxes grow with it`：钉住
> ① 三个 token 必须是 `rem` 且换算回默认根字号后**必须等于原本的 px 值**
> （分母写错会静默改变每一屏）；② 四个元素不许有固定 `height`、必须有 rem 地板；
> ③ 字形尺寸必须是 `rem`。
>
> **token 用 `css.match(/--text-xs\s*:\s*([^;]+);/)` 直接读，不走 `ruleBody(':root')`**
> ——文件里有**两个** `:root` 块（L38 尺寸、L139 颜色），`ruleBody` 只返回它找到的
> 第一个匹配，今天是尺寸块、重排后就可能是颜色块。第一次写测试就是这么失败的
> （`--text-xs must be declared`）。
>
> ### 未做（已查清，方向作废）
>
> **跨会话全文搜索**看起来是缺口（156 个会话，面板只能搜当前会话或按标题筛），
> 但**在这个部署里不可用**：`sessionController.search()` 的实现第一件事就是
> `this.ctx.get('sessionQuery')`，取不到直接抛
> `"session search is unavailable: this deployment does not mount @deepseek-ai/dsh-session-query"`
> （`dsh-api-session-controller/lib/index.js`），而 `cordis.patch.yml` 的插件表里
> 没有它，磁盘上也没有那个 SQLite 派生索引。**别再往这个方向挖。**

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

> ### v90：156 个会话排在 10 屏里，而没人会滚到第 10 屏（本轮）
>
> #### 一、缺陷
>
> 会话列表**一次画出全部会话**。本机真实规模：4 个工作区、**156 个会话**（83/36/23/14），
> 按 380×720 的侧栏算是**约 10 屏**滚动。折叠之前的量
> （`.tmp-run/probe-title-legibility.js`，`historyFull` 场景）：
>
> | 读数 | 值 |
> | --- | --- |
> | 会话行 | **156** |
> | 要滚几屏 | **约 10** |
> | 标题被省略号截断 | 21 |
> | 缩小范围的入口 | 无（v30 之后有了查找栏） |
>
> **参照官方实现**：DSH 自己的会话列表（`dsh-client-ui-workspace/lib/client.js`）
> 有 `COLLAPSED_SESSION_LIMIT = 5`（L2155）与 `collapsedSessionRows()`（L2157）：
> 每个工作区只画 5 个**空闲**会话，**正在运行的与空会话永不计入预算**
> （`if (session.blank || session.running || ...) return true`），其余藏在
> 一个按钮后面，文案是 `sessions.expand`「展开其余 {n} 个会话」/ `sessions.collapse`
> 「收起」（L48/L49 中文，L156/L157 英文）。**本仓库的约定是照官方来**，
> 所以这一轮实现的是同一套规则，不是另发明一个。
>
> #### 二、修法（`extension/sidepanel.js`）
>
> - 新常量 `COLLAPSED_SESSIONS = 5`（在 `MATCH_CONTEXT_ROWS` 之后），注释写明
>   数字与规则的出处是官方会话列表。
> - 新状态 `const expandedGroups = new Set()`（在 `let sessionFilter` 之后），
>   按 `String(group.id)` 记哪些工作区被展开——**`group.id` 可以是 `null`**
>   （未注册工作区那一桶），所以键是字符串。
> - `drawHistory()` 在筛选之后折叠：空闲会话数到 5 为止，`blank`/`running` 一律放行；
>   **筛选状态下不折叠**（读者输入查询就是在找某一行，把命中藏到再一次点击后面
>   等于用一个问题回答另一个问题）。
> - 折叠按钮画在**那个组的 `role="list"` 里面**，作为最后一个 `listitem`：
>   它是这个工作区列表的末行，不是浮在工作区之间的控件；键盘读者按方向键会
>   按屏幕顺序走到它。`aria-expanded` 声明开合状态（与 `#title`、`#model`、
>   `#find-open` 同一套做法），`dataset.group` 记住它属于哪一组。
> - 文案 `sessions.expand`（`'展开其余 {count} 个会话'`）与 `sessions.collapse`
>   （`'收起'`）加进 `extension/locales.js` 的 zh/en 两张表，措辞取自官方。
> - CSS `.session-more`（`extension/sidepanel.html`，紧跟 `.session-time`）：
>   整宽、左对齐、`--faint`，因为**它是关于列表的控件，不是列表里的一项**，
>   目光要能跳过它去找真正要找的行。`hover` 时才有底色。
>
> **读数（`.tmp-run/probe-collapse.js`，同一夹具）**：折叠后 **20 行**（156→20），
> 展开后 **98 行**，再折叠回到 **20 行**——`expandAddedRows: 78`、
> `collapseRestored: true`、按钮文案 `收起`、`expandedButtonText` 正确。
>
> #### 三、★ 折叠必须付出的代价，以及它没有付出的那部分
>
> 折叠省了滚动，代价是**有些会话不在屏幕上了**。唯一不可接受的代价是
> 「读者的会话找不回来了」，所以这一条必须证明，而不是假设
> （`.tmp-run/probe-folded-findable.js`）：挑一个**只存在于尾部**、折叠状态下
> 根本没画出来的标题，用它的片段搜——
>
> | 读数 | 值 |
> | --- | --- |
> | 折叠时画出的行 | 20 |
> | 展开后总数 | 156 |
> | **被折掉的** | **116** |
> | 折回原样是否与原来一致 | `restoredMatchesOriginal: true` |
> | 只见于尾部的那条**搜得到吗** | **`foundIt: true`** |
> | 命中行是否真的画出来了 | `hitCountOnScreen: 16` |
> | 屏幕上的行是否全都匹配 | `everyRowMatches: true` |
>
> **折叠没有损失可寻性**：查找栏问的是宿主（v30 起），而宿主只认会话 id 与标题，
> 与面板画了几行无关。
>
> #### 四、★★ 折叠暴露出的真实缺陷：关掉查找栏，列表仍然被筛着
>
> 这是本轮最重要的发现，**它在折叠之前也存在，只是看不出来**。
>
> `setFind(false)` 清掉 `searchQuery`，但**没有清 `sessionFilter`**——而会话列表的
> 筛选读的正是后者。实测（`.tmp-run/probe-stale-filter.js`，156 个会话）：
>
> | 关闭方式 | 关掉之后的屏幕行数 | 未筛选时应为 |
> | --- | --- | --- |
> | 关闭按钮 | 152 | 20 |
> | 再点一次切换按钮 | 152 | 20 |
> | Escape | 152 | 20 |
>
> **三种关法全部留下一个被筛过的列表，而屏幕上没有任何东西说明为什么少了 140 行。**
> 折叠之前这个缺陷是「152 行 vs 156 行」，看起来像正常的列表；折叠之后它变成
> 「152 行 vs 20 行」——**读者关掉一个框，列表反而长了 7 倍**，这才是它露出来的原因。
>
> 修法（`extension/sidepanel.js` 的 `setFind`）：清 `sessionFilter`，并
> **在 `view === 'history'` 时 `drawHistory()`**。两件事缺一不可：只改状态不重画，
> 状态与屏幕会一直不一致到下一次别的什么触发重画为止——这个面板反复出现的
> 「状态变了、屏幕没变」正是同一形状。
>
> 复测：三种关法全部回到 **20 行**，`anyCloseLeftItFiltered: false`。
>
> #### 五、★ 我自己造成的回归：改了共享夹具没把面板放回原处
>
> 新测试替换 `host.groups` 之后，**面板会「收养」它在新列表里看到的会话**并一直留着。
> 我的夹具只含我编的会话，于是面板从真实会话切到了 `session-poll-0`，而
> **40 个测试之后的** `reopening the panel puts the draft back in the composer`
> 开始失败——它断言草稿写在 `panelDraft:${SESSION}` 下。
>
> **诊断过程**：先 `git stash` 我的测试改动 → 该测试通过（证明责任在我的改动）。
> 再在失败测试里打印 `storage.snapshot()` 的键，读到
> `["panelSessionId","panelDraft:session-poll-0"]`——**草稿写到了我的会话 id 上**。
> 这比对着报错猜快得多，也是这个仓库第 v30 轮记过的那条教训的第二次实例：
> **一个重新配置共享夹具的测试，不是在测这个行为，而是在编辑它之后的每一个测试。**
>
> 修法：新增助手 `sessionRow()`，把**当前会话那一行**放进每个自造列表里，
> 面板就不会离开它。这比在 `onCleanup` 里回滚更稳——回滚只把夹具改回去，
> 而面板已经换过会话了。
>
> #### 六、验收读数（已绿，不必重跑）
>
> - `npm test` → **668 passed, 0 failed, 0 skipped**（663 → 668；其中基线 663 是实测，
>   README 此前写的 661 是 v89 时留下的旧数，本轮一并更正）
> - `npm run check:extension` → exit 0
> - 变异 `.tmp-run/mutate-collapse.mjs`：**真坏法 2/2 命中**、等价变异 **1/1 正确不红**、
>   `restoredExactly: true`。三个变异分别是
>   `session-filter-not-cleared`（回到旧行为，命中）、
>   `expansion-not-remembered`（展开态不进模块状态，读者眼前的列表自己折回去，命中）、
>   `fold-limit-changed`（5→4，**必须不红**——断言的是「一小把」而不是具体的 5，
>   绑死这个数就会在合理调整时误报）。
> - 真实浏览器：折叠 20 行、展开 98 行、折回 20 行；关闭查找栏三种方式都回到 20 行。
> - 新增 5 条测试（`packages/dsh-browser-bridge/test/panel-stream.test.js`）：
>   `a long workspace folds its tail away, and one button brings it back`、
>   `a running session is never folded away, whatever its position`、
>   `a session folded out of sight can still be found by its title`、
>   `a folded workspace stays folded through the poll that redraws the view`、
>   `closing the find bar over the list stops narrowing it`。
>   **第四条守的是 `renderChrome` 每 8 秒重画这个视图**——展开态若存在别处，
>   读者眼前的列表会自己折回去（与 v72 的 `drawTranscript` 同一形状）。
>
> #### 七、★ 判据错了两处（都记下来）
>
> 1. **`historyFull` 夹具只有 10 个不同标题循环用**，于是「展开全部」之后
>    **没有任何标题是只在尾部出现的**，探针报 `error: "nothing was folded away"`。
>    这不是产品问题，是夹具不真实：**156 个真实会话不会共用 10 个名字**。
>    已改：前 10 行仍复用那些容易混淆的标题（那正是读者要分辨的东西），
>    其余各自带后缀。
> 2. **底部「黑田」看起来被 composer 盖住了**（截图肉眼判断）。逐字符实测
>    （`.tmp-run/probe-overlap-bottom.js`，判据是 v74 那条教训）：`coveredCount: 0`、
>    `coveredByComposer: 0`、`historyEndsAboveComposer: true`。滚动容器底边在
>    603、composer 顶边在 632——那是**视口边缘的正常裁切**，不是遮挡。
>    **截图上看不见的东西，不一定是被盖住了。**
>
> #### 八、被否决的方向
>
> - **`justify-content: flex-end` 那一类做法**在这里没有对应物：折叠改的是「画几行」，
>   不是对齐，所以不涉及。
> - **`content-visibility: auto` 跳过屏外布局**（v71 量过、收益 10.8×）在本轮不适用：
>   它对 `scrollHeight` 的失真会破坏滚动锚定，而这里的问题不是渲染慢，是**列表太长**。
>   折叠直接把行数降到 20，从根上解决。
>
> #### 九、本轮新增探针（`.tmp-run/`，被 gitignore）
>
> `probe-title-legibility.js`（156 行/10 屏/21 截断/无入口）、
> `probe-collapse.js`（折叠展开读数 + 轮询存活）、
> `probe-count-vs-rows.js`（计数与屏幕行数）、
> `probe-folded-findable.js`（**折叠未损失可寻性**）、
> `probe-stale-filter.js`（**关掉查找栏仍被筛**，三种关法）、
> `probe-overlap-bottom.js`（逐字符判据，阴性结论）、
> `probe-why-no-expand.js`（诊断夹具问题）、
> `mutate-collapse.mjs`、`normalize-eol.mjs`（行尾归一）。

> ### v89：会话列表说「236 天前」，而没人会去算那是哪天
>
> #### 一、缺陷
>
> `extension/locales.js` 的 `relativeTime` 最后一档是 `time.days`，天数上不封顶。
> 一个两个月前的会话显示「61 天前」——读者要的是**哪一天**，而把天数换算成日期
> 是标签本该替他做的工作。
>
> **为什么它压在关键路径上**：会话列表的时间列是这个界面最常被读的标签之一，
> 而**大多数行都落在这一档**。本机真实会话（`C:\Users\hj\.dsh\sessions`）：
>
> | 口径 | 读数 |
> | --- | --- |
> | 全部 `session.*.zstd` | 156 个；`<1h` 9、`1-24h` 7、`1-2d` 24、`2-4d` 2、`4-7d` 55、`>7d` 59 |
> | **真正用过的**（>10KB，排除 80 个 320B 空会话头） | 76 个：**超过 1 天 60 个（79%）**，中位 119.4h（约 5 天） |
>
> **★ 一条我先搞错、必须记下的判据**：我最初的直方图显示「最旧恰好 168 小时」，
> 我据此推断存在 7 天保留策略，于是自己往夹具里塞了一条「236 天前」的会话——
> **那是假的**。查下去发现 `sessions` 目录本身创建于 168.26 小时前：
> **「最旧 7 天」是 DSH 在这台机器上的安装年龄，不是保留策略**，而天数会随安装
> 年龄线性增长。所以夹具改成**同龄**的 61 天（8 月 → 7 月 25 日），不再编造。
>
> #### 二、修法
>
> 一周以上改印**日历日期**，并且**只在不同年时才写年份**（同年写年份会吃掉会话
> 标题需要的宽度，而列表绝大多数是同年；跨年时年份正是把两行区分开的那件事）。
>
> ```
> const days = Math.round(hours / 24)
> if (days < 7) return t('time.days', { count: days })
> return calendarDate(when, locale, now)
> ```
>
> `relativeTime` 新增第 4 个参数 `locale`（默认 `'en'`）；面板调用点
> `extension/sidepanel.js:2761` 传 `locale`（该常量在同文件 L45 由
> `pickLocale(chrome.i18n.getUILanguage())` 得到）。
>
> **为什么用 `Intl` 而不是手写格式**：两种语言在顺序、分隔符、月份是数字还是名称上
> 全都不一样，这个项目没有理由自己重新实现一遍 CLDR。**但「用到再说」不行**——
> 本项目此前**从未用过 `Intl`**（grep 全无匹配），所以先实测两个加载环境
> （面板 + Node 测试 runner）是否给出**同样的字符串**：18 个格式/输出组合**逐条一致**
> （`resolvedZh: 'zh'`、`resolvedEn: 'en'`，两个环境都是完整 ICU，时区同为
> `Asia/Shanghai`）。否则测试守的是 A、读者看到的是 B。
>
> **边界取 7 天**的理由：两种读法在这里交叉——之下计数更容易与「我是不是正在用它」
> 比较，之上计数是没人换算的数字。同时 7 天的计数标签只有 4 个字符宽，改成日期
> 不会让时间列变宽。
>
> #### 三、夹具此前够不到这一档
>
> `tools/preview.mjs` 的 `ws-1.sessions` 原本只有 90_000ms（2 分钟）、8 分钟、
> `updatedAt: 0` 三条——**day 档从未被渲染过**，所以这个缺陷在 13 张截图里一张都
> 看不见。已新增 `session-d`（7 天，真实中位数）与 `session-e`（61 天）。
>
> `tools/gallery.mjs` 的 `sessions.png` 条目 `why` 同步改为
> 「minutes for the ones just used, a day for the older ones」。
>
> #### 四、★ 变异暴露了一个真实的测试缺口
>
> `.tmp-run/mutate-date-tier.mjs`（7 种坏法，判据认准失败行的 `✖ ` 前缀）：
>
> | 变异 | 结果 |
> | --- | --- |
> | `no-date-tier`（永远数天数，即缺陷本身） | 命中 |
> | `boundary-too-low`（3 天就改日期） | 命中 |
> | `boundary-too-high`（30 天才改） | 命中 |
> | `always-year`（同年也写年份） | 命中 |
> | `never-year`（跨年不写年份） | 命中 |
> | `hardcoded-en`（两种语言同一格式） | 命中 |
> | **`ignore-locale-arg`（面板丢掉 locale）** | **未命中 → 已补测试** |
>
> 最后一条是**真实缺口**，不是脚本问题：`locale` 默认值是 `'en'`，所以面板调用点
> 丢掉它以后**每条既有断言依然全绿**，而中文界面的会话列表会显示 `Sep 16`。
> `panel-i18n.test.js` 测的是 `relativeTime` 本身，**看不见调用点**。
> 已补测试 `the session list hands its language to the date formatter`：
> 用正则取出 `sidepanel.js` 里每个 `relativeTime(...)` 实参并断言末位是 `locale`。
> 补完后 **7/7 命中**、`restoredExactly: true`。
>
> 另有 `test('the two languages really do format dates differently')`：若将来把两种
> 语言都路由到同一个硬编码格式，上面的等值断言仍会通过，而一种语言会静默读成另一种。
>
> #### 五、验证读数
>
> - `npm test` → **661 passed, 0 failed, 0 skipped**（657 → 661）
> - `npm run check:extension` → exit 0
> - 真实浏览器（`historyOpen` 场景，380px dark）：`2 分钟前 / 8 分钟前 / 9月17日 / 7月25日`；
>   英文浅色：`2m ago / 8m ago / Sep 17 / Jul 25`；**240px 窄面板**日期仍放得下、
>   标题正常省略号截断
> - 逐档穷举（`.tmp-run/probe-date-tier.mjs`）：`6 天前` → `9月16日`（边界正确）；
>   `1月15日` vs `2025年1月15日`（年份规则正确）；最小日期档 `Sep 16`、最宽 `Aug 19, 2025`
>
> **★ 重新渲染时的两条判据（避免把副作用混进提交）**：`node tools/gallery.mjs`
> 重渲 13 张后，`picture.png` 也差 25 个像素、`search.png` 差 1 个。
> 逐像素定位（`.tmp-run/compare-pngs.mjs`）后判定**不是回归**：`search.png` 的 1 像素在
> CSS (7, 56.5)，正是本仓库记录过的 `#find-input` 焦点环圆角抗锯齿抖动；
> `picture.png` 的 25 像素全落在文字笔画边缘（`.tmp-run/crop-diff.ps1` 放大 4 倍肉眼
> 确认两侧一致）。关键证据：**用改动前的 `tools/preview.mjs` 能逐字节重现已提交的
> `picture.png`（DIFFERENT 0）**，说明差异来自夹具里的新增会话行而非产品代码。
> 两张都已 `git checkout` 还原，提交里只有 `sessions.png`。

> ### v88：面板拉宽之后，一行可以长到 118 个汉字
>
> 前二十七轮所有截图与探针都跑在 380px。这一轮第一次系统扫**宽度轴**，
> 结果同时得到一条阴性结论和一条真缺陷。
>
> #### 一、宽度轴是稳的（阴性结论，63 个组合）
>
> `.tmp-run/width-sweep.mjs`：9 个场景 × 7 个宽度（200/260/320/380/450/600/900）
> = **63 个组合，0 处断裂**（`documentOverflowsX`、越界、永久裁切、塌陷四项判据）。
>
> 这个读数**三次才拿到**，前两次都是**判据错**，不是代码错：
>
> | 误报 | 真相 |
> |---|---|
> | 63/63 全报 "no reading" | 我的解析器只读到第一个 `\n  `，而探针输出是**多行缩进 JSON**。要按花括号配对找结尾。 |
> | `#announcer` 在所有宽度都"裁掉 276px" | 它是 `.sr-only`（`width:1px`、`overflow:hidden`、`clip-path:inset(50%)`）——**屏幕阅读器专用区域本来就该溢出**。 |
> | `pre` 在 200px 下"裁掉 30px" | 代码块是 `overflow-x: auto`，**读者滚得到**。只有 `overflow: hidden` 才是永久裁切。 |
>
> 教训与之前几次相同：**判据错了会把设计判断报成缺陷**。这次差点就为了
> `.sr-only` 去"修"一个辅助技术特性。
>
> #### 二、真缺陷：助手正文没有任何阅读栏上限
>
> `.answer` 上**没有 `max-width`**（样式表 8 条 max-width 声明无一匹配），
> 它的宽度**由内容决定**——`#transcript` 是 `display: flex; flex-direction: column`，
> 子项在没有上限时收缩到内容宽度。于是**面板有多宽，行就有多宽**。
>
> 判据也是三次才立住，前两次都不够决定性：
> ①量 `.answer` 的盒子得 687px —— 那只是**现有文字恰好排出的宽度**，没证明长文字会更宽；
> ②量 `.answer > p` 的当前最长行得 34.8 汉字 —— 而夹具的段落**本来就没那么长**。
> ③最终：**注入一段确定足够长的文字**，并配**对照组**（用户气泡，它一直有
> `min(456px, 100%)`）。同一把尺子下差异才可判定（`.tmp-run/probe-long-paragraph.js`）：
>
> | 面板宽度 | 助手正文 | 用户气泡（对照） |
> |---|---|---|
> | 380px | 332px / 23.7 汉字 | 336px / 24 汉字 |
> | 600px | 552px / 39.4 汉字 | 420px / 30 汉字 |
> | 900px | 852px / **60.9 汉字** | 420px / 30 汉字 |
> | 1400px | 1347px / **96.2 汉字** | 420px / 30 汉字 |
> | 1800px | 1652px / **118 汉字** | 420px / 30 汉字 |
>
> 超过约 40 个汉字，眼睛就会丢掉下一行的行首——这正是阅读栏存在的理由。
>
> #### 三、第二个实例：工具自己的报错原文
>
> 按**属性**枚举（「直接持有文字、没有 max-width、行宽超限」）而不是按 id，
> 抓到同一缺陷的第二处：`.tool-failure` 在 1400px 面板下**一行 208 个等宽字符**
> （380px 下是 53）。它是 `white-space: pre-wrap`，所以是折行而不是滚动——
> 行被拉得极长。修法用同一个 token。
>
> #### 四、★ 我自己引入过一次回归，而当时的测试全绿
>
> token 第一版取 `52ch`。**`ch` 在自定义属性里是按使用它的元素字体解析的**：
> 同一个 `52ch` 在 `.answer`（14px 正文）上算出 **427px**，在 `.tool-failure`
> （12px 等宽）上算出 **343px**——一个数给出两个宽度，而窄的那个把报错原文
> **削到比它在常规面板下已有的宽度还窄**。已改为绝对长度。
>
> 改成固定的 427px 之后，关于正文的**每一条**断言都通过，但它仍然是一次回归：
> 代码块也被一起限住了，一条 **666px 的代码行**在 900px 面板下**以前放得下、
> 之后要横向滚 241px**。这是我用 `.tmp-run/probe-wide-code.js` 才发现的。
>
> 最终值 **500px**，且是**推导**出来的而不是挑出来的：
> 等宽字体实测 **6.00px/字符**，所以 80 列 = 480px 文本；`pre` 算上自己的边框
> 比 `.answer` 窄 2px，逐步试出**放得下 80 列的最小 `.answer` 宽度是 485px**
> （`.tmp-run/probe-measure-exact.js`，从 460 到 570 每 5px 读一次 `pre.clientWidth`）。
> 80 列不是随手借来的惯例：**本仓库自己 40409 行源码的 p90 是 81 列**。
> 正文侧 500px ≈ 36 汉字 / 72 英文字符，两边都在舒适区，且贴近用户气泡一直用的 456px。
> 两者相差 15px 以内，冲突时**代码优先**——正文每行少一个字没有代价，
> 代码行要滚动则每次阅读都要多一个手势。
>
> #### 五、验证读数
>
> - `npm test` → **657 passed, 0 failed, 0 skipped**（656 → 657）
> - `npm run check:extension` → exit 0
> - 宽度轴复扫 → **0 / 63 断裂**
> - **380px 下与已提交的 `docs/screenshots/conversation.png` 逐像素零差异**
>   （`DIFFERENT 0 of 1094400`）——证明改动只在宽面板生效
> - 变异 `.tmp-run/mutate-measure.mjs` → **5/5 命中**、`preciseRate 5/5`（每条只被新测试抓到）、
>   `restoredExactly: true`。其中 `prose-only-measure`（回到 427px）就是上面那次真实回归。
>
> #### 六、本轮顺带否掉的一件事（别重复挖）
>
> 上一轮作业写着「`tool/ptc-dispatch` 里的图片仍不显示」。**那条假设是错的**，
> 三支探针把它逐层否掉：
> - `parentCallId` **1297/1297** 命中某个 `tool/call`（父工具全部是 `run_code`，子工具 `read_image` 58 次）；
> - 带图的 ptc 事件 **60 个，其父调用的 `tool/result` 一个都不存在**；
> - **决定性判据**：`attachmentId` 是**内容寻址的 sha256**，同一个 id 就是同一张图。
>   逐个比对 → `fullyDuplicated: 60/60`、`hasUnseenImage: 0`——**全部已经在
>   `user/message` 上画过了**（v86 实现）。
>
> 所以画它会让每张图显示两遍。**这是「该不画」，不是「还没画」。**
>
> #### 七、`.answer` caps 的副作用清单（已知且接受）
>
> 代码块现在与正文同宽（500px）。超过 80 列的代码行需要横向滚动——
> 380px 面板下本来就要滚（336px），900px 下从「放得下」变成滚 168px。
> 本仓库 p99 是 117 列、max 317 列，这些行在任何面板宽度下都要滚。

> ### v87：工具产出的图片，以及一个**从没跑过**的测试文件（已完成）
>
> 两件事，第二件比第一件严重。
>
> #### 一、工具行画出了它产出的图片
>
> `tool/result` 的图片此前完全不显示——而这是数量上的主要来源。要定形状，
> 先量了三件事（`.tmp-run/probe-tool-image-shape.mjs`，扫 40 份真实日志、72262 个事件）：
>
> | 问题 | 读数 |
> | --- | --- |
> | 图片出现在哪一侧 | `tool/result` **254** 次；`tool/call` **0** 次（14068 个调用） |
> | 藏在第几层 | 顶层 191 次；`tool-result` 块内 **63** 次 |
> | 一次调用产出几张 | **全部为 1**（254/254） |
> | 会被 `collapseToolRuns` 并起来吗 | **不会**（带图的 254 段摘要全不相同） |
> | 同一 callId 收到几条 result | **1 条**（我的第一个探针报「57 个收到 2 条」，是**探针自己的 bug**：`resultsPerCall` 声明在文件循环之外，跨会话累加了） |
>
> 修法：`imageBlocks(content, depth = 1)` 增加 `depth`（默认 1，保持 `user/message`
> 的既有语义），`tool/result` 分支用 **depth 2**——`toolResultText` 早就在同一处
> 递归两层，注释写着「a reader that stops at the outer block finds nothing」。
> 图片**累积**而不像 `status` 那样赋值：状态是被最后一次结果**了结**的，而图片是
> 这次调用**产出**的，后来一条不带图的结果并不能取消它。`collapseToolRuns`
> 也把图片带过合并（量到的数据里不会发生，守的是形状）。
> 面板侧：`row.kind === 'tool'` 分支在失败详情之后 append `renderImages(shots)`；
> CSS 加 `.row[data-kind="tool"]:has(> .shots)`（列向、`flex-start`，工具行是左对齐的）。
>
> #### ★ 二、`image.test.js` **从来没有在 `npm test` 里跑过**
>
> 这个文件第一行是 `import test from 'node:test'`，而本仓库用的是自建 harness
> （`test/harness.js`）——`node:test` 注册的测试，自建 runner **收不到**。
> 后果：文件被 `run.js` 正常 import（44 个套件里就有它），**却贡献 0 条测试**，
> 它的断言一次都没执行过。上一轮报告「624 passed」时，那个文件的 **32 条**测试
> **不在这个数字里**；上一轮记的「新增 23 条」也从未参与统计。
>
> 改成 `import { assert, main, test } from './harness.js'` 之后，**当场 8 条变红**：
> `t.after is not a function`——本 harness 的清理接口叫 `t.onCleanup`，`t.after`
> 是 `node:test` 的名字。**也就是说：那 8 条路由测试（含「非本机拒绝 403」
> 「不当作文档下发」「缓存永久」「缺参数 400」）从写下的那一刻起就是坏的，
> 只是没人跑过它们。** 修完之后 `image` 单套件 32 passed。
>
> **判据读数**：`npm test` 624 → **656 passed**（多出的 32 条就是它）。
>
> #### 三、给 runner 加了一道守卫（这才是修复的重点）
>
> `test/run.js` 现在逐个 import 套件时比对 `registeredCount()`，注册数为 0 的
> 文件**点名报错并 exit 1**：
>
> ```
> test/run: 1 suite(s) registered no tests: image.test.js
> Each *.test.js must import { test } from the local harness, not node:test.
> ```
>
> 已实测：把 `image.test.js` 的 import 换回 `node:test`，这条守卫命中、
> 退出码 1、总数退回 624 ——**证明那 32 条确实不在里面**。
> 一个注册不了测试的套件文件不是「通过的套件」，它是一份没人读的报告。
>
> #### 四、量过但**没有采纳**的一处改动（别重复挖）
>
> 追一个「同一命令渲染出两种图」的抖动时，先定位到 `header`：`height: 44px` 是
> border-box，减去 1px 下边框后内容盒 **43px（奇数）**，28px 的图标居中落在
> **y=7.5**。改成 45px 后落在 y=8，读数确实变整数。**但改完抖动仍在**，
> 所以又量了「半像素到底糊不糊」（`.tmp-run/icon-sharpness.mjs`，56x62 的图标区）：
> **两个版本都是 53 个灰度层次、130 个中间调像素、3.74%**——在
> `devicePixelRatio: 2` 下**没有可测差异**。于是**已还原**（只留下一条注释说明
> 为什么这个数不动）：为了买不到的东西把仓库里 13 张图全部重渲一遍是错的。
>
> #### ★ 五、那次抖动的真正成因（已定位，**未修**）
>
> 逐像素读颜色（`.tmp-run/pixel-rgba.mjs`）：物理 (14,115) 上两次取值
> **250 vs 244**（差 6/255），左邻恒为深色 18、右邻恒为白 255 —— 是**抗锯齿的
> 覆盖值**。该坐标 = CSS (7, 57.5)，而 `#find-input` 的盒子是 `left: 8`，
> `outline-offset: -1px` ⇒ **焦点环的外沿正好在 x=7**（`:focus-visible`
> 实测为 true，`2px solid rgb(255,255,255)`，`border-radius: 6px`）。
> 也就是说：**圆角描边的斜边上，覆盖率取整偶尔会落到另一侧**，
> 约 **10 次渲染出现 1 次**（实测 9:1）。
> 这条**没有修**：它是 Chromium 光栅化圆角的方式，不是本仓库的代码缺陷；
> 记录在此是为了下次再见到「截图哈希偶尔不同」时不必重查一遍。
>
> #### 六、验证读数（已绿）
>
> - `npm test` → **656 passed, 0 failed, 0 skipped**；`check:extension` exit 0
> - `image` 单套件 → **32 passed**
> - 变异 `.tmp-run/mutate-tool-images.mjs` → **5/5 命中**、`restoredExactly: true`
>   （`tool-result-images-ignored`、`only-the-outer-level-is-read`、
>   `assign-instead-of-accumulate`、`duplicates-are-not-deduped`、
>   `merge-drops-the-pictures`）
> - 真实浏览器（`picture` 场景）→ `everyToolImageDrawn: true`、
>   `rowsWithImages: 1`、`naturalWidth: 1280`、`userShots: 2`（读者自己的没受影响）
> - 面板侧变异（把 `wrapper.append(renderImages(shots))` 去掉）→
>   `rowsWithImages: 0`、`everyToolImageDrawn: false`，**探针确实会红**
> - `picture.png` 重渲 3 次逐字节一致；其余 12 张未变

> ### v86：读者发的图片在面板里根本不存在（已完成）
>
> #### 一、缺陷：一条只有图片的消息**连一行都不产生**
>
> `packages/dsh-browser-bridge/lib/chat.js` 的 `describeEvents` 里，`user/message`
> 分支是 `const text = textBlocks(data?.content)` 然后 `if (text.length > 0)`。
> 而 `textBlocks`（同文件 L129）**只取 `block.type === 'text'`**，其余静默跳过。
>
> 后果分两档，第二档更糟：
> - 带说明的图片：气泡照常画，**图片消失**，读者看到一条只有文字的消息；
> - **只有图片、没有文字**的消息：`text` 为空 → **整个 row 都不 push**，
>   于是下面的回答看起来像在回答空气，而读者明明发过东西。
>
> 面板因此展示了一个**与真实对话不同的对话**。
>
> #### 二、形状与规模（先量再定架构，两个数决定方案）
>
> `image` block 的真实形状（`user/message` 的 `data.content[]` 直接含它）：
>
> ```json
> {"type":"image","attachment":{"attachmentId":"sha256:bb6f4704…84eba",
>  "mediaType":"image/png","bytes":112836,"width":760,"height":1440,"name":"v65-approval-zh.png"}}
> ```
>
> **官方 seam**：`@deepseek-ai/dsh-attachment` 的 `AttachmentStore`
> （`lib/types/index.d.ts:18`），cordis 注入名 `ctx.attachments`。读图正主是
> `readImage(ref, signal?): Promise<StoredImageAttachment>`（L74-81，文档原文
> 「Read one image and verify that bytes still match the recorded reference」），
> 它**自己做 sha256 + 字节数 + mediaType + 宽高四项校验**，所以项目不必自己散列
> 或解析 PNG 头。`attachmentId` 的文档原文是
> 「Opaque storage identifier; never a filesystem path or bearer URL」。
>
> **★ 本项目早就持有这个 store**，只是**只写不读**：`lib/index.js:293` 的
> `attachmentStore: () => ctx.get?.('attachments')` 供截图工具写入
> （`lib/page-tools.js:563` 的 `admitPromptContent`）。读图就在同一个对象上。
>
> **规模实测**（`.tmp-run/probe-attachment-sizes.mjs`，扫真实附件库）：231 个对象、
> min 404 B / p25 49.7 KB / **median 99.2 KB** / p75 146 KB / **p90 1.38 MB** /
> **max 3.63 MB**，总量 78.9 MB；`over1MB: 25`。
>
> **★ 这否定了「把字节内联进行数据」这条最省事的路**：60 行窗口若全是图，
> base64 膨胀后 **84.4 MB**——而面板**每 5 秒轮询一次**（`refreshGroups`），
> 也就是每 5 秒 84 MB。所以形态只能是「行里带引用，字节按需单独取」。
>
> #### 三、授权：不透明 id 也是一张通行证
>
> 新端点 `GET /browser-bridge/image?sessionId=…&attachmentId=…`
> （`lib/config.js` 的 `BRIDGE_IMAGE_PATH`）。
>
> **它先确认这张图确实被该会话引用过**，否则 404 且**根本不碰存储**
> （`chat.js` 的 `readImage`：在 `readThrough(sessionId)` 的行里找这个 id）。
> 官方远程通路划的是同一条线（`dsh-api-session-controller/lib/index.js:821`
> 的 `referencedImage(source.events, attachmentId)`，未命中抛
> `ATTACHMENT_NOT_REFERENCED`）。少了这道检查，任何 id 都能取到全部 231 张图，
> 包括读者**没有打开过**的对话里的。
>
> **响应头里有两道不能省的防线**（`lib/index.js` 的 `serveImageRoute`）：
> `x-content-type-options: nosniff` 与
> `content-security-policy: default-src 'none'; sandbox`。存的可能是一张 SVG，
> 而它来自读者自己的对话——没有这两条，它就是一个**在本源执行脚本**的内联文档。
> 另加 `cache-control: private, max-age=31536000, immutable`，因为 id 是内容地址、
> 字节不可能变，浏览器可以留着解码后的副本。
>
> loopback-only，与其余路由一致；`GET`/`HEAD` 之外的 405 带 `allow: GET, HEAD`。
> 用 `readImage(ref, never())` —— 控制器的读取器会无条件调
> `signal.throwIfAborted()`，传 `undefined` 会抛。
>
> #### 四、面板：两条**只能靠真实浏览器发现**的布局事实
>
> 渲染在 `extension/sidepanel.js` 的 `renderImages()`，样式在 `sidepanel.html`。
>
> **① `width: 100%` 在 `.shot` 上是循环依赖。** `.shots` 是
> `align-items: flex-end` 的**列向** flex，子项收缩到内容宽度，所以百分比宽度
> 相对的是一个**由内容决定大小**的容器——塌成图片的原始尺寸。
> 实测第一版：`.shot` 的盒子是 **`w:2, h:2`**（图片原始大小），而不是 320。
> 宽度必须来自镜像自身的 `width`/`height` 属性 + `max-width`。
>
> **② 760×1440 的手机截图在 380px 宽的面板里高 606px。** 一张图占掉 720px 窗口的
> **84%**，三张就是三屏滚动、中间没有一句对话。所以缩略图封顶
> `min(320px, 44vh)`，实测竖图 **167×317**、横图 **318×167**，都还看得清；
> 点一下用**浏览器自己的看图器**打开原图（`chrome.tabs.create`）——
> 它有缩放、平移、保存，自己写一个 lightbox 只是更差的复制品。
>
> 空间**在字节到达前**就按引用的 `width`/`height` 预留（`figure.style.aspectRatio`
> 与 `img.width/height`），否则图片加载时会把对话往下顶。
>
> **`.shot` 必须有可见描边**：高对比度会丢弃 `box-shadow`，而缩略图的边界正是
> 靠它——这也是 v75 那条规则（按**属性**枚举会分界的表面，不按 id）的继续。
>
> #### 五、行身份：`rowKey` 必须带上图片 id
>
> `rowKey` 原本是 `kind + 可见文本`，而**纯图片消息的文本是空串**——两条这样的
> 消息会共用一个键。已加入 attachment id。
>
> **但这条改动是等价变异，已如实标注**：键只有两个消费者，两者都要求「该行能成为
> 搜索命中」或「两行的 `data` 不同」——①`reconcileRows` 的节点配发还比较
> `data`（整行 JSON，两条消息的 id 不同，data 就不同）；②`findHitKey`/
> `restoreHitFocus` 只对搜索命中调用，而 `searchableText` 只收集
> `text`/`name`/`summary`/`failure`，纯图片行返回**空串**。
> 判据实验 `.tmp-run/probe-key-equivalence.mjs` 用**真实 matcher** 求证：
> `textOfImageOnly: ""`、`hitsOnImageOnly: 0`、`captionRowIsSearchable: 1`。
> 所以变异 `image-only-rows-share-a-key` **必须不红**；红了说明实现变了、判定要重做。
>
> #### 六、验证读数（已绿，不必重跑）
>
> - `npm test` → **624 passed, 0 failed, 0 skipped**（620 → 624；新增
>   `packages/dsh-browser-bridge/test/image.test.js`，23 条）
> - `npm run check:extension` → exit 0
> - 变异一 `.tmp-run/mutate-images.mjs`：**真坏法 6/6 命中**，
>   等价变异 1/1 **正确地不红**，`realMissed: []`、`restoredExactly: true`
> - 变异二 `.tmp-run/mutate-image-route.mjs`：**8/8 命中**、`restoredExactly: true`
>   （`no-loopback-check`、`no-required-params`、`errors-become-500`、`no-nosniff`、
>   `no-csp-sandbox`、`no-immutable-cache`、`head-sends-the-body`、`post-allowed`）
> - 真实浏览器（`tools/preview.mjs picture` + `.tmp-run/probe-picture-draw.js`）：
>   `shotCount: 2`、`imgCount: 2`、`anyImageDecoded: true`、
>   `naturalWidth: 760 / 1200`（**夹具按声明尺寸出图**，否则测出来的尺寸不代表真实
>   行为）、`shotsWithoutImage: 0`
> - 视觉：`.tmp-run/r26-picture4.png`（深色）、`r26-light.png`、`r26-fc.png`
>   （高对比度下缩略图描边仍在）
> - `entry.test.js` 的路由清单断言**被这次新增抓到**（`/browser-bridge/image`
>   不在期望里），已更新——这条断言正是为「某条路由停止注册」而写的
>
> #### 七、★ 本轮自己犯的三个错（都记下来）
>
> 1. **`callRoute` 少了等一个宏任务。** 注册的 handler 是**同步**的，把真正的工作
>    派发到一个只 `.catch()` 的 promise 上——所以从 handler 返回**不代表响应已经写完**。
>    第一版每个路由测试都读到 `status: null`，于是**所有否定断言都因为错误的原因
>    通过**（403/400/404 全都"对"了）。已加 `await new Promise(r => setTimeout(r, 0))`。
>    **这是本轮最危险的一处**：一批断言全绿而它们什么都没验证。
> 2. **夹具出了一张 32×60 的图，却声明成 760×1440。** 浏览器按 `<img>` 的
>    固有尺寸**和**声明的 `width`/`height` 一起布局，所以小图放大与真尺寸图
>    渲染不同——缩略图会**因为错误的原因**看起来正确，任何尺寸缺陷都藏在夹具后面。
>    已改为 `declaredSize(scenario, id)` 从夹具自己的引用里读回尺寸再出图，
>    **字节与声明不可能不一致**。渐变在真实尺寸下 deflate 后只有 27 KB，所以
>    按真实尺寸生成并不贵（真截图约 500 KB，那才不能进源码）。
> 3. **`require` 写在 ES module 里。** `.tmp-run/probe-attachment-sizes.mjs` 第一版
>    用了 `require('node:fs')`，直接 `ReferenceError`。顶层 import。
>
> #### 八、留给下一轮（本轮已查清，未做）
>
> - **`tool/result` 里的图片**（真实日志里 252 次引用）与 `tool/ptc-dispatch`
>   （60 次，工具名 `read_image` 58 次）目前**仍不显示**。它们是**工具产出的**图，
>   不是读者发的，语义不同（`browser_screenshot` 的截图落在这一支），
>   所以值得单独一轮，而不该顺手塞进 `renderRow` 的 user 分支。
> - 真实日志里 `user/message` 含 image 的 71 个事件中，**只有 11 个**是
>   `source.kind === 'user'`（真人发的），另外 60 个是 `source.kind === 'plugin'`。
>   本轮只处理真人那一支（`chat.js:455` 的门控），与既有语义一致。
> - `agent/inbox/spliced`（75 次引用）与 `user/message` 是否为同一条消息的投递副本
>   未查证。
>
> #### 九、本轮新增的探针与工具（`.tmp-run/`，被 gitignore）
>
> `probe-attachment-sizes.mjs`、`probe-image-blocks.mjs`（**含一个死循环 bug 的
> 修正**：帧边界必须从 `index + 4` 起搜，否则首帧在 offset 0 时 `indexOf` 又返回 0、
> 索引不前进）、`probe-key-equivalence.mjs`、`probe-picture-draw.js`、
> `probe-png-size.mjs`、`why-image-route.mjs`、`mutate-images.mjs`、
> `mutate-image-route.mjs`。截图 `r26-*.png`。
>
> `tools/preview.mjs` 新增 `picture` 场景与 `mockImage()` / `declaredSize()`。

> ### v85：截图必须只取决于代码，不取决于拍它的时刻
>
> #### 一、缺陷：同一份代码渲染出**不同的图**
>
> `working` 场景（那一行「思考中…」）连跑两次得到**不同的文件**：
> 第一次 `bd63eb68…` / 100983 字节，第二次 `0dde4556…` / 101026 字节，**差 43 字节**。
> 对照 `normal` 与 `streaming` 两次完全相同（`1ce63e8e224d` / 99190 字节）。
>
> 为什么这要紧：`docs/screenshots/*.png` 是 README 直接引用的**产品声明**，
> 而 `test/screenshots.test.js` 只能守「文件存在」与「不是空白」。
> **一张会自己变的图显示不了回归——因为每一次渲染都是一次回归**；
> 而且每次 `node tools/gallery.mjs` 都产生无意义的字节改动污染 diff，
> 审阅者看到的是一堆二进制变化，读不出哪一张真的不一样了。
>
> #### 二、修法：按**产品真实支持的设置**渲染，不是给截图开后门
>
> 面板**早就支持** `prefers-reduced-motion: reduce`，规则在
> `extension/sidepanel.html`：`.working { animation: none; color: var(--tertiary); background: none; -webkit-background-clip: initial; }`
> ——它把渐变换成实色，**字照样看得见**。所以：
>
> - `tools/preview.mjs` 的 `Emulation.setEmulatedMedia` 的 `features` 加入
>   `{ name: 'prefers-reduced-motion', value: reducedMotion }`（与已有的
>   `prefers-color-scheme`、`forced-colors` 同一机制）。
> - 新增 CLI 参数 `--reduced-motion reduce|no-preference`，**默认 `reduce`**。
>   要看动效本身用 `--reduced-motion no-preference`。
>
> 向系统请求减少动效的读者拿到的就是这份渲染，所以图仍然是产品的图。
>
> #### 三、验证：判据是**跑真 gallery 两次**
>
> 不逐个场景测——README 的图来自 `tools/gallery.mjs`，不是来自单场景调用，
> 所以直接量那个契约（`.tmp-run/probe-gallery-twice.mjs`）：
>
> | 读数 | 结果 |
> | --- | --- |
> | 12 张界面图，两次渲染 | **`unstable: []`（逐字节相同）** |
> | 3 张海报，两次渲染 | **`unstable: []`** |
> | gallery 两次退出码 | 0 / 0（各约 26.7s） |
> | 与已提交版本对照 | 只有 `working.png` 变化——那正是本次改动的产物 |
>
> 另有一处**判据错误**值得记：第一版探针用 `stdout.indexOf('{')` 解析 preview 的输出，
> 抓到的是它先打印的 `dom: {...}`，于是每个读数都是 `null`，脚本报「那行没有文字、
> 不可见、动画还在跑」。**探针错了会把好实现报成坏的**，和把坏的报成好的一样糟。
> 拆成两个脚本后：`probe-gallery-twice.mjs` 管可复现性，
> `probe-working-legibility.mjs` 管可读性（认准 `  probe: ` 标记行）。
>
> 可读性实测（两档必须**区分得开**，否则说明参数根本没接上）：
>
> | 读数 | `reduce`（默认） | `no-preference` |
> | --- | --- | --- |
> | `color` | `oklab(… / 0.56)` 实色 | `rgba(0, 0, 0, 0)` 透明 |
> | `usesGradientText` | false | true |
> | `animationName` | `none` | `sweep` |
> | `hasText` / `visible` | true / true | true / true |
>
> #### 四、新守卫测试与变异
>
> `packages/dsh-browser-bridge/test/screenshots.test.js` 新增
> `a screenshot is a function of the code, not of when it was taken`，
> 钉住三件会**独立**失效的事：默认值必须是 `reduce`、
> 该值必须真的交给浏览器（解析了却没人用比没有参数更糟，因为看起来修好了）、
> reduce 规则里必须**说出用什么颜色**（丢掉渐变却不说颜色 = 文字透明，
> 而这种图**仍然"可复现"**，只是复现的是一张看不见字的图）。
>
> `.tmp-run/mutate-reproducible-shot.mjs`：**3/3 命中**、`restoredExactly: true`
> （`default-back-to-no-preference`、`flag-never-wired`、`invisible-under-reduce`）。
>
> #### 五、一处澄清：v82 的「可复现」与本轮不同
>
> v82 说的可复现是**「可以重新生成」**（工具入库、声明式画廊、拒绝 <8KB 产物）。
> 本轮说的是**「逐字节相同」**。前者保证截图不会静默过期，后者保证
> 「图变了」这件事本身有意义。两件都要有。
>
> #### 六、读数
>
> - `npm test` → **621 passed, 0 failed, 0 skipped**（620 → 621）
> - `npm run check:extension` → exit 0
>
> ### v84：失败行有了出路——但出路不是「重试」
>
> #### 一、缺陷：一次回合死掉之后，读者拿不回自己的问题
>
> `failed` 行只画「一句红字 + 一段 detail」，**没有任何控件**。实测
> （`.tmp-run/probe-failure-exit.js`，`failed` 场景）：`failureCount: 2`、
> `controlsOnFailure: []`、`anyFailureOffersAction: false`，而
> `composerAfterFailure.hasText: false`——读者的提问还在屏幕上，要重试**必须凭记忆重打**。
>
> 更刺眼的是：面板认识的 8 种失败文案里，**三种在说「稍后再试」**
> （`error.code.rateLimited`、`error.code.quota`、`error.code.unreachable`），
> 而面板没给任何「再试」的手段。对照：`#blocked` 界面**早就有** retry 按钮
> （`extension/sidepanel.js` 的 `blockedAction`），设计语言已经存在，只是没覆盖到失败行。
>
> #### 二、★ 为什么不能做成「重试」按钮（三条硬约束，都查过出处）
>
> | 约束 | 证据 |
> | --- | --- |
> | **宿主没有「重新生成」能力** | bridge 用到的 `commands.*` 只有 `cancel`/`create`/`inspect`/`list`/`modelCatalog`/`prompt`/`readSessionState`/`selectModel`，没有 retry；`llm/retry` 是**事件**不是命令 |
> | **失败行是自动重试耗尽后的终态** | `llm/retry` 是回合内事件；失败行来自 `turn/end` + `reason.kind === 'error'`（`chat.js` 的 `case 'turn/end'`，注释原文「A turn that died commits no assistant message」） |
> | **面板无法知道原问题是否带附件** | `chat.js` 的用户行只存 `const text = textBlocks(...)`，没有 attachments 字段；`mentioned` 在发送成功后清空（`sidepanel.js`）。**静默重发 = 发出一个与原问题不同的消息**（少了模型本该看的页面），比留下重复提问更糟——那是一封被篡改的信 |
>
> 所以**唯一诚实的出路是把提问还回输入框**：面板不写对话、不伪造内容，读者自己决定要不要再发。
>
> #### 三、★★ 实现的关键：提问怎么找到「它属于哪个回合」
>
> 「从失败行往上找最近一条 user 行」是**错的**。夹具里失败行的上方就是一条 assistant 行
> （`tools/preview.mjs` 的 `FAILED_MESSAGES`），实测该判据在第一个失败行上就
> `immediatelyFollowsQuestion: false`。
>
> 真正可靠的连接点是**回合号**。而这里**仓库里的测试夹具与真实会话顺序相反**，
> 所以不能靠夹具定方案，只能读磁盘上的真实日志：
>
> ```powershell
> # ~/.dsh/sessions 下的 session.v*.jsonl.zstd
> # ★ 这个文件是**一连串独立的 zstd 帧**（每次 append 一帧），
> #   对整份文件调一次 zstdDecompressSync 只得到会话头 209 字节。
> node -e "…数帧魔数 28 b5 2f fd，逐帧解…"
> ```
>
> 真实日志（16749 个事件，`.tmp-run/probe-real-event-order.mjs`）给出的事实：
>
> | 事实 | 读数 |
> | --- | --- |
> | `user/message` **不带** `turn` | 135 条里 0 条有；dataKeys 只有 `content`/`id`/`role`/`source` |
> | **真实顺序是 `turn/start` 在前** | seq2857 `turn/start`(turn=3) → seq2871 `user/message`(source.kind='user') → seq2873 `assistant/message`(turn=3) |
> | 仓库夹具写的顺序**相反** | `chat.test.js` 的旧写法是 `userEvent` 在 `turnStartEvent` 之前 |
> | 一个回合里**真会出现多条用户消息** | `session-4b30482c` 实测 `turn3:[user,user,user,plugin]` |
> | `turn/end` 与下一个 `turn/start` 之间**从无** user/message | 5 个日志、107 个回合，全部为 0 |
>
> 所以规则是：**当前打开的回合（最后一个 `turn/start`）接收提问，且第一条为准**。
>
> #### 四、实现
>
> 宿主侧（`packages/dsh-browser-bridge/lib/chat.js` 的 `describeEvents`）：
> - 新增 `turnOf(event)`（`data.turn` 是整数才作数，否则 null——猜错会把别人的问题递给读者）
> - 新增 `case 'turn/start'` 记录 `openTurn`
> - `user/message` 且 `source.kind === 'user'` 时，`if (openTurn !== null && !questionByTurn.has(openTurn))` 登记提问
>   （**只有读者打的字才有资格被交还**——goal 回合、压缩通知、nudge 都不算）
> - `case 'turn/end'` 里取走该回合的提问（取走即删除）、`openTurn = null`，失败行带上 `question` 字段
>
> 面板侧（`extension/sidepanel.js`）：失败行在 `question` 非空时多画一个 `.failure-again` 按钮，
> 提问写在 `wrapper.dataset.question` 上（处理函数读行，不闭包行对象——行每次重绘都会换新节点）；
> 点击后把提问**放在已打文字之前**、光标落到末尾、`setDraft` 存草稿、`drawSend()` 让发送键可用。
> 文案 `failure.putBack`（zh「把问题放回输入框」/ en「Put the question back」）刻意不叫「重试」。
>
> #### 五、★ 两个 CSS 判断（都量过）
>
> - **`.failure-again` 必须写 `align-self: flex-start`**：`.row` 是 flex 容器，flex 子项会被
>   blockify（`inline-flex` 失效）并在交叉轴被拉伸，按钮从「控件」变成「横幅」——
>   实测**中文 114px 的标签拿到整行 340px 的宽度**（截图 `.tmp-run/r23-after.png`）。
>   修复后 114px、`hugsItsText: true`。
> - 描边用 `var(--line-soft)`、焦点环用 `Highlight`。高对比度实测
>   （`.tmp-run/probe-failure-again-contrast.js`）：`forcedColorsActive: true`、
>   `hasSeparatingEdge: true`、`colorIsSystem: true`（`rgb(255,255,255)`）、
>   `meetsTapTarget: true`（24px）。
>
> #### 六、★ 测试基础设施的一个真实缺口（不修就写不出面板侧测试）
>
> `packages/dsh-browser-bridge/test/dom-shim.js` 的 `click()` 原本发出的是**裸 `{}`**，
> **没有 `target`**。而面板用的是**事件委托**——处理函数从 `event.target` 往上 `closest()`
> 找控件，复制按钮与这个新按钮都是这么写的。于是所有委托处理器在套件里**静默地什么都不做**，
> 读起来像「这个功能没实现」，而不是「事件没有 target」。
>
> 修法：`click()` 改为 `this.emit('click', { target: this })`。这一改同时让既有的复制按钮
> 委托路径第一次被真实覆盖。
>
> #### 七、一处**测试哲学**的修正
>
> `packages/dsh-browser-bridge/test/failure.test.js` 原本把失败行的 `rows.push({...})`
> **整行源码文本**钉死。本轮那次 push 因为要多带一个 `question` 字段而变成多行，测试立刻变红，
> 而它要守的契约（`code` 有没有传到行里）**一点没变**。
> **一个会被空白改红的断言教不了任何东西**，而它被「修好」的方式是粘贴新文本——那正是它停止
> 被阅读的起点。已改为匹配契约、不匹配缩进。
>
> #### 八、变异验证（`.tmp-run/mutate-question-turn.mjs`）
>
> **4/4 真坏法命中**，`falsePositives: []`，`restoredExactly: true`：
> `question-from-fixture-order`（照旧夹具顺序实现——夹具对、真实错，**本轮最要紧的一条**）、
> `any-user-message-becomes-the-question`、`last-question-wins`、`question-not-cleared-on-turn-end`。
>
> 另有 1 条**如实标注的等价变异** `turn-end-does-not-close-the-turn`：真实日志里
> `turn/end` 与下一个 `turn/start` 之间从无 user/message（107 个回合全为 0），
> 所以两种写法对所有真实输入等价，**它必须不红**——红了说明实现变了，需要重新判定。
> 命中判据分两类统计（`realTotal` 与 `equivalentTotal`），不混成一个「命中数」。
>
> #### 九、验证读数（已绿，不必重跑）
>
> - `npm test` → **619 passed, 0 failed, 0 skipped**（612 → 619）
> - `npm run check:extension` → exit 0
> - 真实浏览器（`.tmp-run/probe-failure-put-back.js`，`failed` 场景）：`gotTheQuestion: true`、
>   `gotTheAssistantLineInstead: false`、`caretAtEnd: true`、`sendEnabled: true`、
>   `typedTextSurvived: true`、`questionComesFirst: true`、`usedItsOwnQuestion: true`
> - 高对比度：`hasSeparatingEdge: true`、`colorIsSystem: true`、`meetsTapTarget: true`
> - 截图：`.tmp-run/r23-zh.png`（中文修复后）、`r23-fc.png`（高对比度）
>
> #### 十、本轮新增探针（`.tmp-run/`，被 gitignore）
>
> `probe-real-event-order.mjs`（真实会话的事件顺序与回合归并）、`probe-mutation-equivalence.mjs`
> （哪些变异是等价的）、`probe-failure-exit.js`（失败行有无出路）、`probe-failure-put-back.js`
> （放回输入框的端到端判据）、`probe-failure-button-box.js`（按钮盒子与触控目标）、
> `probe-failure-again-contrast.js`（高对比度）、`why-put-back-fails.mjs`（定位 shim 缺口）、
> `mutate-question-turn.mjs`（变异）。
>
> #### 十一、留给下一轮
>
> - **附件仍然丢了**：`question` 只带文字。要让「重发」真的等价于原消息，宿主侧得把
>   附件引用也存进用户行（`chat.js` 的 `user/message` 分支现在只取 `textBlocks`）。
>   在那之前，面板给的是「把文字放回去」，而不是「重发那条消息」——这是当前唯一诚实的边界。
> - `HANDOVER.md` 的 v82 段记着「`earlier.png` 与 `hostDown.png` 的 sha256 相同」。
>   **实测这条已过时**：当前 11 张 `docs/screenshots/*.png` 哈希**全部互不相同**
>   （那两个文件在 v82 已被替换）。这条线索关闭。

> ### v83：界面按产品介绍，不按功能罗列
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
