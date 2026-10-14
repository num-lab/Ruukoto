# blind-r1 原文

审查者最终回复原样抽自其执行上下文的会话转录；只去掉了行尾空白，正文未改。

# browser 与 bash 模型可见文本审计报告

我只读了 `/tmp/aft/blind/` 下的材料。快照里只有 browser 与 bash 两个工具的定义，没有系统提示，也没有真实的结果事件流，所以涉及结果原文的条目都是从源码推出来的。其中依赖 agent-browser 返回格式的推断，我在条目里标了"推断"。

## 一、browser 工具

**B1 参数 schema 没有任何描述，也不写每个动作接受哪些字段**
- 位置：快照 `browser.parameters.properties`。`url/ref/text/value/key/direction/pixels/ms/operation/index/full` 都只有类型，没有 `description`。字段与动作的对应只在 `browser-tools.ts:25-29` 的 `ACTION_FIELDS` 和 `:47` 的校验里：「`动作 ${action} 不接受 ${key}`」。
- 规则：J1。
- 模型会做错什么：
  - 顺手多带字段，被逐个拒绝，每次多一个来回。例如 `{action:"snapshot", full:true}`、`{action:"click", ref:"e3", text:"提交"}`、`{action:"press", ref:"e3", key:"Enter"}`（想在某个元素上按键）。
  - 用 `{action:"wait", text:"加载完成"}` 或 `{action:"wait", url:...}` 去等文字或导航，被拒；wait 只接受 `ms`。

**B2 取值约束只在校验里，模型看不到**
- 位置：`browser-tools.ts:60`「滚动方向无效」（只允许 up/down/left/right）；`:61-62` 的 `ms` 上限 25000、`pixels` 上限 100000、`index` 上限 10000；`:64`「wait 需要 ms」；`:68-70` 关于 tabs 的三条：switch/close 必须带 index，只有 new 可带 url，list/new 不接受 index。`pixels` 默认 500 只出现在 `:161`。
- 规则：J1。
- 模型会做错什么：
  - 传 `direction:"bottom"` 或 `"pagedown"`、`ms:30000`，各撞一次错。
  - 调 `{action:"tabs", operation:"switch", url:"..."}` 按 URL 切换标签，被拒。
  - 不知道 `index` 从 0 还是 1 数，切错标签以后才发现。
  - 另外几个字段语义也没写：`select.value` 是 option 的 value 还是可见文字；`fill` 是覆盖还是追加；`press.key` 用什么写法（`Enter`、`Control+a`？）。模型只能试。

**B3 `ref` 字段不说只接受快照引用，`@eN` 的错误文本不告诉下一步**
- 位置：快照 description「按快照的 eN 或 @eN 引用」；`ref` 字段无描述；`browser-tools.ts:53`「使用当前 snapshot 返回的 @e 引用」。
- 规则：J1。
- 模型会做错什么：传 CSS 选择器（`"#submit"`）、按钮文字或 `"[ref=e5]"`，每种各错一次。

**B4 "先 snapshot 再使用引用"没说页面变化后旧引用会作废，而校验也拦不住复用的编号**
- 位置：快照 description「先 snapshot 再使用引用」；`browser-tools.ts:138-140`。校验只看 eN 这个编号是否出现在一份新快照里，不核对是不是同一个元素。
- 规则：J1、J7。
- 模型会做错什么：click 触发跳转后，直接用旧快照里的 `e7` 再点。如果新页面恰好也有 `e7`（agent-browser 的编号每次从小往大重排，这点是推断），校验会通过，点到另一个元素，可能误提交。描述应当写明：任何导航、点击或输入之后都要重新 snapshot。

**B5 `attach` 的 url 实际是本机 CDP 调试端点，描述读起来像"附着到某个网址"**
- 位置：快照 description「start/attach/open/snapshot」，`url` 无描述。约束在 `browser-manager.ts:186-197`（只允许 loopback、必须带端口、不能带 query），以及 `:206`「CDP discovery 返回非成功应答；不跟随重定向」、`:213`「无法连接本机 CDP discovery」、`:247`「CDP 地址必须指向带 UUID 的浏览器端点」。
- 规则：J1、J2（错误用 CDP、discovery 这类术语，又不给下一步）。
- 模型会做错什么：在 bash 起了 dev server 后调 `{action:"attach", url:"http://localhost:3000"}` 想"连上这个页面"，得到「CDP discovery 返回非成功应答」。它不知道正确做法是 `start` 再 `open`，可能继续换 URL 重试 attach，或者去 bash 里研究 CDP。

**B6 动作顺序没写：open 前要先 start；错误文本不给动作名**
- 位置：快照 description 只把动作并列；`browser-manager.ts:390`「浏览器尚未启动或已回收，请先显式启动或附接（browser_not_ready）」。
- 规则：J1、J2（"显式启动或附接"不是动作名）。
- 模型会做错什么：
  - 第一步直接 `open`，失败后才 `start`，多一个来回。
  - 不知道 `start` 之后停在 about:blank，`open` 是在当前标签里导航还是新开标签，也没写。

**B7 start 的前置条件靠宿主配置，失败文本却让模型去"准备"和"配置"**
- 位置：`browser-manager.ts:399`「请准备当前平台 agent-browser v0.39.1 官方原生程序并配置宿主路径」，以及 `:402`、`:403`、`:405`；`:409`「请先准备 Chromium 并配置宿主可执行文件路径；模型任务不会自动安装或提权」；`:411`；`:535`「请核实系统沙箱与日志准备」。
- 规则：J2（要求模型做它不能、也不该做的事；没写"停下报告拥有者"）、J5（版本号、release 属于实现细节）。
- 模型会做错什么：用 bash 跑 `brew install chromium`、`npx playwright install`，或去下载 agent-browser 二进制、改配置文件找"宿主路径"。这些调用全都白费，还可能越权改环境。

**B8 start 中途失败后，重试路径要撞墙一次才知道**
- 位置：`browser-manager.ts:548` 把 binding 置为 unavailable，但抛给模型的是原错误（比如 B7 里的那些）。再调 start 时，`:417` 返回「原浏览器未核实关闭，不能新开实例；请先查看状态并显式关闭」。
- 规则：J2。
- 模型会做错什么：第一条错误没提"需要先 close"，所以模型照常重试 start，碰到 `:417` 后才 close，再 start，至少多两次调用。

**B9 只读失败与写动作失败都会冻结浏览器，描述只写了"结果未知时不重发"**
- 位置：快照 description「结果未知时不重发」。实际进入条件分散在三处：
  - `browser-manager.ts:119-120`：带 code 的失败一律算 outcome_unknown；open、click、fill 等非只读动作，只要失败就算 outcome_unknown。
  - `:616-619`：除 `tab_gone`、`browser_action_failed`、`browser_not_sent` 外，其他错误一律把绑定置为 unavailable。
  - `browser-tools.ts:169-171`：宿主在这种情况下自动 pause。
- 规则：J3（没写宿主会自动进入这个状态，也没写进入条件）。
- 模型会做错什么：按惯常做法试探操作，比如 open 一个还没起来的本地服务、click 一个被遮挡的元素、fill 一个不是输入框的元素。推断：只要 agent-browser 对这类失败返回 `success:false`，一次失败就会让本任务后续的 snapshot 和 screenshot 全部不可用。模型无法预知"点一下试试"的代价是整个任务锁死。

**B10 outcome_unknown 的文本要求做一件当前状态下做不到的事，后续错误又互相矛盾**
- 位置：
  - `browser-manager.ts:120`「浏览器动作结果未知；已暂停自动化，请核实当前页面，不能重复旧动作」；`:127`、`:132`、`:136`、`:176` 意思相同。
  - 进入该状态后，snapshot 和 screenshot 都会走到 `:608`「浏览器连接不可用，本次动作未发送；请先核实原执行并显式关闭（browser_not_ready）」。
- 规则：J2（"核实当前页面"没有可用工具能做；"核实原执行"是内部术语）、J4（"不能重复旧动作"没配正面做法，也没写在什么范围内有效）。
- 模型会做错什么：先 snapshot 去"核实"，失败；按 `:608` 去 close；再 start、open 重走流程，最后把刚才的提交或点击再做一遍。这正好违反"不重发"，可能重复下单或重复提交表单。正确的下一步应当明写：停止，向拥有者报告未核实的动作，等拥有者的新消息。

**B11 暂停状态的对照不完整，退出方式只对 paused 写了，没覆盖 unavailable**
- 位置：快照 description「人工登录先 pause，密码由拥有者在窗口或 dashboard 输入；新消息的新任务才能 resume」；`browser-manager.ts:607`「浏览器正在人工操作，等待拥有者的新消息继续（browser_paused）」。
- 规则：J3。描述没写以下几点：
  - 暂停期间哪些动作仍可用：只有 status、close、pause。snapshot、screenshot、wait 都会被拒。
  - pause 之后当前任务应当结束本轮，并把 dashboard 地址告诉拥有者。
  - 新任务里第一步要先调 resume。
  - 同一机制还用于"结果未知"之后的自动冻结（见 B9），这种情况同样要靠 resume 退出。
- 模型会做错什么：
  - pause 后用 `wait` 或 bash `sleep` 轮询，再 snapshot 看拥有者是否登录完，每次都失败。
  - 在新消息的任务里直接 snapshot，在 unavailable 状态下拿到 `:608` 的"显式关闭"，于是 close 掉了拥有者刚登录好的页面，而不是 resume。

**B12 resume 的错误文本在几种情况下都把问题说成"需要新消息"**
- 位置：`browser-tools.ts:129`「人工暂停后需要拥有者的新消息；先前排队的任务不能恢复自动化」，其中"先前排队的任务"是内部术语；`browser-manager.ts:590`。
- 规则：J2。
- 模型会做错什么：
  - 浏览器本来就是 ready（没有暂停），模型保险起见调 resume，拿到"需要新消息"，于是停下来请拥有者发消息，白白占用人工一轮。
  - 因 `browser_identity_unverified` 进入 unavailable、但从没暂停过（`pauseAfterSeq` 为 null），同样得到这句话。实际出路是 close，拥有者发多少消息都没用。

**B13 "窗口"与"dashboard"在描述里没有落点**
- 位置：快照 description「密码由拥有者在窗口或 dashboard 输入」。`browser-manager.ts:517` 显示只有 macOS 默认有可见窗口，其他平台是 headless。dashboard 地址只在 status 返回的大段 JSON 里，字段名 `dashboardUrl`（`:475`）。
- 规则：J3、J1。
- 模型会做错什么：
  - 在 Linux 上让拥有者"在浏览器窗口里输入"，而窗口并不存在。
  - 不知道 dashboard 地址从哪里取，没给拥有者链接，或者多调几次 status 去 JSON 里翻。

**B14 status、start、attach、pause、resume、close 的结果都是整个 BrowserBinding 的 JSON**
- 位置：`browser-tools.ts:123-134` 与 `:166` 的 `JSON.stringify(data)`；返回体字段见 `browser-manager.ts:32-55`。模型会看到 `profileDir`、`socketDir`、`cliSession`、`cdpUrl`、`targetId`、`chrome/daemon/dashboard` 的 `pid/pgid/processIdentity`、`lockDir`、三个 `*Pending` 标志、`generation`、`pauseAfterSeq`、`outcomeUnknown`、`failureCode`、`headed`。
- 规则：J5。
- 模型会做错什么：
  - 拿 `cdpUrl` 去调 `attach`，得到「该浏览器已被 Ruukoto 会话占用」或「原浏览器未核实关闭」。
  - 拿 pid 去 bash 里 `kill`，绕过关闭核实，结果是后续全部 `browser_identity_unverified`。
  - 以为 `generation` 或 `targetId` 要在后续调用里传。
  - 真正决定下一步的只有 `state`、`failureCode` 和需要转给拥有者的 `dashboardUrl`，却淹没在一堆管道字段里。

**B15 截图结果给了两个标识，错误文本提到模型拿不到的文件**
- 位置：`browser-tools.ts:159`「截图产物 ${id}（${byteCount} 字节；${contentHash}）」；`:152`「截图超过 8 MiB；原文件已保留，可改用视口截图」；快照 description「截图同时返回不可变产物与视觉块」。
- 规则：J5（sha256 是第二个标识；"不可变"属于实现性质）、J2（"原文件已保留"无法据以行动；"视口截图"没对上参数，实际是去掉 `full`）。
- 模型会做错什么：
  - 试图引用哈希，或去 bash 里找"原文件"。
  - 超限后不知道应该改成 `full:false` 重试，或换着参数多试几次。

**B16 open 只支持 http/https，描述没写**
- 位置：`browser-tools.ts:57-58`「网页 URL 无法解析」「网页 URL 只支持 http/https」；`url` 字段无描述。
- 规则：J1。
- 模型会做错什么：测试本地 HTML 文件时先试 `file:///…/index.html`，被拒，然后转去 bash 起静态服务器，接着落入 S2 的陷阱。

**B17 浏览器跨任务存活、会因空闲被回收，描述都没写**
- 位置：`browser-manager.ts:299`「Runtime 跨任务持有；profile 保留」；`:323` 空闲 1 小时超时；`:759` daemon 退出后自动 close。快照 description 对生命周期只字未提。
- 规则：J7。
- 模型会做错什么：
  - 每个任务结束时主动 close，丢掉拥有者刚登录的会话；或者每个任务开头都 start（这条是幂等的，无害）。
  - 隔一小时后直接 snapshot 拿到「已回收」，不明白为什么页面状态没了。
  - 不知道 cookie 会保存在 profile 里，可以复用。

**B18 能力与会话资格的说明占用描述篇幅**
- 位置：快照 description「仅完全访问的拥有者 main/普通开发会话。」
- 规则：J8。工具出现在列表里，就说明资格已满足，模型据此做不了任何事。

**B19 access_denied 的文本把几种原因混在一起**
- 位置：`browser-tools.ts:86`「浏览器仅开放当前完全访问的拥有者会话」。任务不在 running、已请求取消、projectId 不符时，都返回这一句。`:112`「浏览器调用身份或权限已变化」没给下一步。
- 规则：J2。
- 模型会做错什么：任务正被取消时，模型得到"仅开放完全访问会话"，以为要请拥有者切换访问模式，向拥有者提出一个无关的请求，或者继续重试。

**B20 browser_busy 没给下一步**
- 位置：`browser-manager.ts:496`「同一浏览器一次只执行一个操作」。
- 规则：J2。
- 模型会做错什么：不知道该等待还是重试，可能立即重发同一个写动作。如果前一个动作就是自己发出去的，这就违背了"不重发"。

**B21 每条错误都附带原始 code，与描述里的措辞不一致**
- 位置：`browser-tools.ts:173` 给每条错误追加「（${code}）」，比如 `outcome_unknown`、`browser_not_ready`、`stale_ref`；描述用的是"结果未知"。
- 规则：J2（用内部术语指代状态）。影响较轻：模型要自己把 `outcome_unknown` 对上"结果未知"，而 `browser_not_ready` 同时代表"未启动"和"冻结后需关闭"两种完全不同的处境（`:390`、`:608`），code 反而让人误判。

## 二、bash 工具

**S1 后台进程在调用返回时整组被杀，或者让调用一直挂到超时**
- 位置：`tool-worker-worker.ts:121-126` 用 `detached: true` 建立独立进程组；`:142-148` 在 `close` 之后执行 `killTrackedChild(pid)`，注释写「主 Shell 退出后仍核实原组，后台子进程不能丢失停止归属」。快照 description 只有「在工作区执行 bash 命令（在任务执行边界内；输出完整捕获为产物）」。
- 规则：J7。
- 模型会做错什么，以"起服务再用浏览器访问"为例：
  - `python -m http.server 8000 &`：后台子进程继承了 stdout 管道，`close` 迟迟不触发，调用一直挂到超时，然后整组被杀。
  - `nohup npm run dev > log 2>&1 &`：立即返回，但同一进程组马上被回收。
  - 两种情况下，之后的 `browser open http://127.0.0.1:8000` 都连不上。按 B9，这次 open 失败很可能（推断）让浏览器进入结果未知并冻结，整条测试链路在同一任务内无法恢复。
  - 模型还会反复 `curl` 或 `ps` 排查"服务为什么没起来"。`setsid` 能逃出进程组，这一点模型无从得知。

**S2 cwd、环境变量与 stdin 的语义没写**
- 位置：快照 bash description；`tool-worker-worker.ts:121-125` 每次都新 spawn，`stdio: ["ignore", …]`。
- 规则：J7、J1。
- 模型会做错什么：
  - 上一次 `cd sub && …`，下一次以为还在 `sub` 里；`export FOO=…` 以为下次还在。
  - 跑会交互的命令，比如 `git commit` 不带 `-m` 会打开编辑器，`npm init`、`sudo`、`create-*` 会提问。读到 EOF 后失败，或挂到超时，之后再改参数重跑。

**S3 `timeout` 参数缺少默认值、上限和超时后的行为**
- 位置：快照 `bash.parameters.properties.timeout.description`「超时秒数」；宿主另有上限 `WORKER_CALL_TIMEOUT_MS`（`tool-router.ts:386`，具体数值看不到）。超时后得到的是 `:417`「工具执行失败：${message}」。
- 规则：J1、J7。
- 模型会做错什么：
  - 长构建传 `timeout: 3600`，被宿主上限提前截断，拿到一条笼统的"工具执行失败"，分不清是超时、被杀还是命令自己出错，于是原样重跑。
  - 或者不敢设超时，结果一个卡住的命令占满时间。

**S4 每个输出流都无条件追加"完整正文已捕获"提示**
- 位置：`tool-router.ts:402-407`「[完整正文已捕获：artifact ${id}（${bytes} 字节，${name}）——需要更多内容时用 read_artifact 工具按偏移查询]」。stdout、stderr 各追加一条，与输出是否被截断无关。
- 规则：J6、J5（字节数和流名称属于管道信息；这里真正需要的标识只有 artifact id）。
- 模型会做错什么：
  - 输出只有一行，也会看到两条提示。模型会去调 read_artifact 再读一遍，多一个调用；或者把提示当背景噪音忽略，等到真的截断时也不读。
  - 提示本身没说"可见部分是否已截断、截断了多少"，模型无法判断要不要补读。
  - 快照里看不到 read_artifact 工具（快照只列了两个工具，可能是摘录）。如果本会话确实没装配它，这条提示指向一个不存在的工具，同时违反 J2。

**S5 "任务执行边界"是模型无法据以行动的术语**
- 位置：快照 bash description「在任务执行边界内」。
- 规则：J8、J2。
- 模型会做错什么：不知道边界指什么：能否联网，能否写工作区外的路径，有没有沙箱。要么先写一堆探测命令（`touch /tmp/x`、`curl example.com`），要么误以为不能联网而放弃本可完成的事。

**S6 执行环境不可用的错误没给下一步**
- 位置：`tool-router.ts:339`「执行环境不可用：${message}（不回退到其他执行方式）」。
- 规则：J2。
- 模型会做错什么："不回退"是给实现者看的。模型不知道该停下报告还是稍后重试，会立即重试几次，或改用别的工具绕路（比如用 browser 去读文件）。

**S7 输出捕获失败时，原始错误直接给了模型，也没说命令可能已部分生效**
- 位置：`tool-router.ts:394`、`:415`「输出捕获失败，执行已停止：${captureFailed}」。`captureFailed` 是文件系统错误的原始 message（`:375`），可能带内部路径和 errno。
- 规则：J2（磁盘满或没权限时，正确做法是停下报告拥有者，文本没写）、J5（内部路径）。
- 模型会做错什么："执行已停止"会让模型以为命令没生效，于是重跑一个已经执行到一半的、非幂等的命令，比如迁移、`git push` 或批量删除。磁盘问题下重跑还会再失败一次。

**S8 主动取消与工具失败的错误文本无法区分**
- 位置：`tool-router.ts:352`「aborted by host」，经 `:417` 变成「工具执行失败：aborted by host」。
- 规则：J2。
- 模型会做错什么：任务被拥有者取消时，模型看到的是"工具执行失败"，可能当作偶发错误再跑一次。

## 三、跨工具的组合路径

**X1 "bash 起服务、浏览器访问"这条典型路径，只看文本无法走通**
- 涉及 S1、S2、B5、B6、B9、B10、B16。
- 规则：J7、J3、J2。
- 模型最可能的调用序列如下，其中第 3 步之后的冻结是推断：
  1. bash `npm run dev &`：挂到超时，或者服务立即被杀。
  2. browser `attach http://localhost:5173`：CDP 错误。
  3. browser `start` 后 `open http://localhost:5173`：连接失败，进入 outcome_unknown，浏览器冻结。
  4. browser `snapshot`：browser_not_ready，被要求"显式关闭"。
  5. browser `close`、`start`、`open`：服务仍然不在，再次冻结。

  这里没有任何一段文本告诉模型：服务要用 `setsid` 或其他脱离进程组的方式启动；导航失败会冻结浏览器；冻结之后应当停下报告。

## 四、SKILL.md 本身难以套用的地方

1. **"不读源码下结论"与 J1 的检查方法冲突。** 前提要求以快照为准，但步骤 2 要找出"哪些值会被拒"，J1 要判断约束"只在校验代码里"，这两项都只能读源码才能确认。SKILL.md 应当写明：快照决定模型看到了什么，源码只用来确认实际行为和拒绝条件。
2. **步骤 1 要求的事件流材料本次没有。** 结果和错误原文要从同一会话的事件流取。本次只有源码，agent-browser 的 snapshot、click 结果长什么样，以及 approval 的 `grant.text`、`verifyTask` 的 problem 文本都看不到。J5、J2 只能部分判定。SKILL.md 没说缺少事件流时怎样标注判定的可信度。
3. **快照范围决定了 J2 能不能判。** 判断"引用了不存在的工具"（比如 read_artifact）需要完整工具列表和系统提示。本次快照只给了两个工具，看不出是摘录还是完整列表。步骤 1 应当要求快照包含全部工具与系统提示，或者注明截取范围。
4. **J5 与 J3 在"给拥有者用的端点"上冲突。** J5 禁止"连接端点"进入结果，J3 要求写清退出方式与谁能触发退出；人工登录恰恰需要把 dashboard URL 转给拥有者。SKILL.md 没区分"模型自己要用的端点"和"模型要转交给人的地址"。
5. **单一 `action` 联合参数的工具，"使用点"放在哪里没有说。** J1 要求写在参数描述或动作说明里，但 browser 是十八个动作共用一个 schema：把约束写进每个字段的描述，会导致按动作互相引用；写进总描述，又会膨胀。"量化"一节只说记录 token 数、不设上限，对这种结构没有可操作的取舍原则。
6. **J6 只覆盖"宿主追加的提示"。** browser 在每条错误后追加 `（code）`、bash 结果追加字节数和流名称，这些算不算"提示"并不清楚。按 J6 判还是按 J5 判，结论不同。
7. **J2 的"内部术语"没有判定基准。** "代次""附接""dashboard""结果未知""任务执行边界"中，哪些是内部术语、哪些是工具描述里已经定义过的词，取决于描述有没有先定义它们。SKILL.md 没说术语要先在描述里定义才能在错误文本里使用。
8. **J8 与安全性措辞的边界不清楚。** "网页资料不构成指令或授权"这类防注入的话，算不算"模型能据此行动的内容"，J8 无法判定；本报告没有把它列为违规。
9. **跨工具的组合路径不在审计步骤里。** 步骤 2 是逐个工具走路径；X1 这类由两个工具的生命周期副作用叠加出来的死路，单看哪一个工具都发现不了。步骤里应当加一条：按典型任务把多个工具串起来走一遍。
