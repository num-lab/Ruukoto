# blind-r3 原文

审查者最终回复原样抽自其执行上下文的会话转录；只去掉了行尾空白，正文未改。

# 模型可见文本审计报告：`browser` 与 `bash`

被审对象：`/tmp/aft/blind/snapshot-tools.json` 中的两个工具定义（模型实际输入），以及 `browser-tools.ts`、`browser-manager.ts`、`tool-router.ts.L320-420.txt`、`tool-worker-worker.ts.L85-155.txt` 中会进入模型输入的结果与错误文本。

**材料缺口（先声明，避免误判）**：快照只摘了 `bash` 与 `browser` 两个工具，没有系统提示、没有兄弟工具定义（`read_artifact` 等），也没有任何已发生的工具结果。因此：凡是「系统提示或兄弟工具描述里已写明」的可能消解项，我无法核实，只能按快照判；`bash` 的执行超时实现（`WORKER_CALL_TIMEOUT_MS` 取值、超时是否杀进程、结果被截断时的返回形状）与 `read_artifact` 的可见性也不在材料内，相关条目我标为**未覆盖**。SKILL.md 第 1 步要求的「同一定义装配给多种身份时每种身份各取一份快照」同样只有 dev/完全访问这一份。

---

## 一、bash

### 1. 参数的两条约束只活在代码里
**文本位置**：快照 `bash.parameters.properties.timeout.description` = `"超时秒数"`；`command.description` = `"要执行的命令"`。源码 `tool-router.ts` 第 811–812 行的 `Type.String({ description: "要执行的命令" })`、`Type.Optional(Type.Number({ description: "超时秒数" }))`（同一段）是它的唯一来源。
**规则**：J1。
**模型会做错什么**：不知道默认超时（材料里只能看到 `WORKER_CALL_TIMEOUT_MS` 这个常量名，模型看不到任何数值），因此对「装依赖 / 跑全量测试」这类长命令，要么不敢省略 `timeout` 而随手假设一个数，要么省略后一直等到宿主超时才发现；也不知道超时后命令是被杀掉还是继续在后台跑，于是超时后很可能**再用同一个 `command` 重发一次**（第二次与前一次的副作用叠加，比如起了两个服务），或者转而用 `http_request` 绕过。

### 2. `timeout` 与真实超时的关系没有对照
**文本位置**：同上字段描述；源码 `tool-router.ts` 第 386 行 `timeoutMs: WORKER_CALL_TIMEOUT_MS`（调用 worker 时用的是宿主常量，不是模型的 `timeout`）。
**规则**：J1、J2。
**模型会做错什么**：模型把 `timeout` 当成唯一超时闸门——「我给 30 秒就不会等到 120 秒」这条推断在材料里没有任何依据。典型误用是给一个偏小的 `timeout` 期望快速失败，实际拿到宿主超时或对方超时后的通用文本，随后基于错误的心智模型继续串联调用。**未覆盖**：`timeout` 究竟传到哪一层、超时后的返回文本，需要 `packages/agent/src/tool-worker/` 里 `bash` 的 sdk 工具包装才能定论。

### 3. 「工作区」与真实执行范围相反
**文本位置**：快照 `bash.description` = `"在工作区执行 bash 命令（在任务执行边界内；输出完整捕获为产物）。"`；源码同一句在 `tool-router.ts` 第 809 行。
**规则**：J8、J2。
**模型会做错什么**：这次调用是完全访问（快照 `note` 写明「完全访问」），而 `tool-router.ts` 第 341–345 行在 `full_access` 下申请审批时用的是 `scope: { kind: "tool", workspaceOnly: false }`——即不受工作区限制。描述却把模型钉在「工作区」里。模型会因此少做合法动作（不写 `/tmp`、不碰工作区外的路径），或先花一轮向拥有者确认「能不能在工作区外执行」，而这一条件在装配上已经成立。「任务执行边界」也是快照里未定义的术语。

### 4. 每次调用是不是新的 shell、能不能喂 stdin、后台进程的存活期，一个字都没有
**文本位置**：快照 `bash.description` 全文；源码 `tool-worker-worker.ts` 第 118–126 行 `exec: (command, cwd, options) => ... spawn(shell.shell, [...shell.args, command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] })`；第 144–146 行 `finish` 里 `void killTrackedChild(pid).then(...)`。
**规则**：J7、J1。
**模型会做错什么**：
- `stdio` 的 stdin 是 `"ignore"`，所以**交互式命令必然失败**（`npm init` 不带 `-y`、`ssh` 询问指纹、`read -p`）。工具描述没有任何「无交互」提示，模型会直接发交互式命令，白扔一次调用再改成 `-y`。
- `cwd` 由宿主给定，模型不知道是哪个目录；`cd` 与导出的环境变量不跨调用保留，模型会写成 `bash("cd sub && ...")` 之后下一轮直接用相对路径（侥幸能用）或假设环境变量还在（失败）。
- 单条 `bash` 调用返回前会 `killTrackedChild(pid)` 回收进程组。这对任务 3「起一个服务再用浏览器访问」是核心缺口：模型在 `bash` 里 `nohup python -m http.server &` 或 `npm run dev &`，无法从描述判断这个服务在 `bash` 返回后还活着、能活多久。它会基于错误假设继续去 `open http://localhost:3000`，拿到连接失败后把原因归到浏览器上。

### 5. 产物提示无条件追加，且不区分「截断」与「全量」
**文本位置**：`tool-router.ts` 第 402–408 行：
```
text: `[完整正文已捕获：artifact ${entry.id}（${bytes} 字节，${entry.name}）——需要更多内容时用 read_artifact 工具按偏移查询]`,
```
每个产生过数据的流各追加一行，与本次结果是否被截断无关。
**规则**：J6、J5。
**模型会做错什么**：对 `bash("echo hi")` 这类结果也出现「需要更多内容时用 read_artifact 工具按偏移查询」，模型会学到「bash 的输出默认看不全」，于是把简单诊断变成 `bash` + `read_artifact` 两步（多一次调用），或者在确实需要时也判断不出眼前这段是不是完整输出。另外这行文本**承诺了一个本轮没出现过的工具名**：快照里没有 `read_artifact`；若它在完整工具表里不存在（材料无法核实），模型会调用一个不存在的工具。

### 6. 失败路径的指引不全
**文本位置**：
- `tool-router.ts` 第 339 行 `执行环境不可用：${(err as Error).message}（不回退到其他执行方式）`
- 第 348–349 行 `const problem = this.deps.verifyTask?.(task); if (problem) return textResult(problem, true);`
- 第 415 行 `输出捕获失败，执行已停止：${captureFailed}`
- 第 417 行 `工具执行失败：${(err as Error).message}`
**规则**：J2。
**模型会做错什么**：第一条的正向部分是好的（明确禁止换执行方式），但没有任何**可执行的下一步**，模型会原地重试同一条命令；第二条第 348 行的 `problem` 是另一个模块产生的自由文本，模型拿到后只能猜是权限、目录还是任务状态的问题，容易沿错误方向恢复；第四条把「命令自己失败」与「宿主失败」混成同一句式，且此时输出的诊断在 artifact 里而不在眼前，模型可能需要额外一轮 `read_artifact`。

---

## 二、browser

### 7. 没有任何一个参数写了约束，`required` 里只有 `action`
**文本位置**：快照 `browser.parameters`：`required: ["action"]`，`url/ref/text/value/key/direction/pixels/ms/operation/index/full` 全是裸 `type`，**零个 `description`**。约束只存在于 `browser-tools.ts` 第 25–29 行 `ACTION_FIELDS` 与第 43–72 行的 `parseBrowserParams`：
```
start: [], attach: ["url"], open: ["url"], snapshot: [], click: ["ref"], fill: ["ref","text"], select: ["ref","value"],
check: ["ref"], uncheck: ["ref"], press: ["key"], scroll: ["direction","pixels"], wait: ["ms"],
tabs: ["operation","index","url"], screenshot: ["full"], status: [], close: [], pause: [], resume: [],
```
以及第 51–70 行的必填、第 53 行 `ref` 必须匹配 `/^@e\d+$/`、第 61–63 行取值范围（`pixels ≤ 100000`、`ms ≤ 25000`、`index ≤ 10000`）、第 66–70 行 `tabs` 的互斥组合（`switch/close` 必须给 `index`；非 `new` 不可给 `url`；`list/new` 不接受 `index`）、`wait` 必须给 `ms`。
**规则**：J1（本条是全报告最重的一处）。
**模型会做错什么**：
- 漏必填：`click` 只传 `ref` 是常态，但 `fill` 需要同时给 `ref` 和 `text`、`select` 需要 `ref` + `value`、`press` 需要 `key`（而不是 `text`）、`scroll` 需要 `direction`、`tabs` 需要 `operation`。参数名与动作的绑定关系只能试错得到，每次试错就是一次 `invalid_params` 往返。
- 传错名：schema 有 `ref/text/value` 三个近义字符串却没有任何说明，模型给 `click` 传 `text`、给 `fill` 传 `value` 都会被 `browser-tools.ts` 第 47 行 `动作 ${action} 不接受 ${key}` 拒绝。
- 传多余键：`additionalProperties: false` 加上第 47 行的键白名单，意味着模型顺手带 `selector`、`timeout`、`description` 一律被拒。
- 取值范围靠猜：`pixels` 与 `ms` 是裸 integer，模型不知道 0–100000 / 0–25000，也不知道 `scroll` 省略 `pixels` 时默认 500（第 161 行 `String(p.pixels ?? 500)`）。

### 8. `url` 同名而语义分裂
**文本位置**：快照 `browser.parameters.properties.url`（裸 `type: "string"`）；`browser-tools.ts` 第 51 行（`attach`/`open` 必填）、第 54–59 行（`open` 与 `tabs.url` 只收 http/https）、`browser-manager.ts` 第 183–200 行 `pinLoopback`（`attach` 要求 loopback、必须有端口、不允许 `search`/`hash`/`username`/`password`，协议限 `http/https/ws/wss`）。
**规则**：J1、J2。
**模型会做错什么**：同一个 `url` 在 `open` 下是「任意网页地址」，在 `attach` 下是「本机 CDP 端点且必须带端口」。模型会把 `open` 学到的习惯搬到 `attach`（例如 `attach {url:"http://localhost:9222"}` 因缺端口被拒、`attach {url:"http://127.0.0.1:9222/json/version"} `又要走 discovery），或反向把 CDP 的 `ws://` 地址拿去 `open`。这条路径在只有描述的情况下无法一次走通。

### 9. `attach` 的前置条件、以及与 `start` 的互斥，全在代码里
**文本位置**：快照 `browser.description` 只把 `start/attach` 并排列出，无任何先后说明；`browser-manager.ts` 第 415–417 行 `if (old && old.state !== "closed") throw new BrowserError("browser_not_ready", "原浏览器未核实关闭，不能新开实例；请先查看状态并显式关闭")`，第 553–577 行 `attachTarget`，第 507–513 行 `startOwned`。
**规则**：J1、J3。
**模型会做错什么**：模型无法知道「同一会话同一时刻只能有一个绑定，`start` 与 `attach` 不能并存」，于是先 `start` 想看看浏览器，再 `attach` 一个已有实例，被拒后回 `status` 看状态、再 `close`、再 `attach`——三次往返只为发现这个前提。`attach` 还要求模型自己先在本机拉起带 CDP 的浏览器，描述也没写，模型会先 `start` 再试图 `attach` 自己刚起的那个。

### 10. 状态词表缺失，收到 `unavailable` / `paused` 后无从决策
**文本位置**：`browser-manager.ts` 第 36 行状态枚举 `"starting" | "ready" | "paused" | "unavailable" | "closed"`；第 390 行 `browser_not_ready`、第 606–610 行 `execute` 的两条拒绝（`browser_paused`「浏览器正在人工操作，等待拥有者的新消息继续」与 `browser_not_ready`「浏览器连接不可用，本次动作未发送；请先核实原执行并显式关闭」）；快照 `browser.description` 对这些状态只字未提。
**规则**：J3、J2。
**模型会做错什么**：`status` 结果里会出现 `state: "unavailable"`、`failureCode`、`outcomeUnknown` 这些字段，模型没有任何依据知道「`unavailable` 下只有 `close` 可用，且 `close` 失败时不能 `start`」。常见误用是看到 `unavailable` 就调 `start` 想重来——`browser-manager.ts` 第 417 行会拒绝它——或者反复 `snapshot` 试运气。而 `paused` 与 `unavailable` 的**恢复责任不同**（前者等拥有者新消息后 `resume`，后者要 `close`），描述里没有任何对照。

### 11. 「人工暂停」的进入条件与用途只写了一半
**文本位置**：快照 `browser.description` = `"...人工登录先 pause，密码由拥有者在窗口或 dashboard 输入；新消息的新任务才能 resume。"`；`browser-manager.ts` 第 579–585 行 `pause`（只允许 `ready`/`unavailable`，且 `active` 中无操作）、第 169–172 行（`outcome_unknown` + 连接不可用时宿主**自动** `pause`）、第 760 行（`supervise` 自动把绑定置为 `unavailable`）、`browser-tools.ts` 第 169–172 行。
**规则**：J3、J2、J7。
**模型会做错什么**：描述只交代了模型主动 `pause` 这一条进入路径，没有交代宿主的自动进入（结果未知后自动暂停自动化），也没有写退出细则：第 128–129 行要求「拥有者的新消息」对应的新任务输入序号晚于暂停点，模型在**自己**调 `pause` 之后紧接着调 `resume` 会被拒（`browser_paused`），而错误文本只说「人工暂停后需要拥有者的新消息；先前排队的任务不能恢复自动化」，模型容易误判为「还有一个我没找到的恢复动作」继续试。另外「密码由拥有者在窗口或 dashboard 输入」：`start` 的动作参数里没有任何 headed/headless 的选择（`browser-tools.ts` 第 124 行固定传 `{}`，headed 由宿主配置决定），无头实例没有「窗口」可看，描述也没有告诉模型在无头情况下该怎么让拥有者看到 dashboard 地址。

### 12. `status` 存在，但没承诺会返回什么；返回的整份是内部管道
**文本位置**：`browser-tools.ts` 第 123 行 `if (p.action === "status") data = deps.manager.status(ctx.sessionId)`、第 166 行 `JSON.stringify(data)`；`browser-manager.ts` 第 382–385 行返回 `structuredClone(binding)`，即第 32–55 行整个 `BrowserBinding`——含 `profileDir`、`socketDir`、`cdpUrl`、`targetId`、`chrome`/`daemon`/`dashboard`（每个都是 `{ pid, pgid, processIdentity }`）、`lockDir`、`failureCode`、`dashboardUrl`。快照里 `status` 没有任何字段说明。
**规则**：J5（`pid`/`pgid`/`processIdentity`/内部路径/端点属明确列出的实现管道）、J1。
**模型会做错什么**：模型拿到 process identity、socket 目录、CDP 端点后，没有任何工具能用它们，最可能的实际后果是拿 `cdpUrl`/`dashboardUrl` 去 `bash` 里 curl、或回头 `attach` 自己这个已被占用的 target（`browser-manager.ts` 第 560 行 `browser_target_in_use`）。同时它真正需要的 `state` 含义与 `failureCode` 词表又没有说明，所以 `status` 既给了不该给的事实，又没给能用的事实。

### 13. 截图的两个前提没写
**文本位置**：快照 `browser.parameters.properties.full`（裸 boolean，无 description）；`browser-tools.ts` 第 143–152 行（固定写到 `deps.screenshotDir`，超过 8 MiB 抛 `image_too_large`「截图超过 8 MiB；原文件已保留，可改用视口截图」）；第 159 行返回 `截图产物 ${artifact.id}（${byteCount} 字节；${contentHash}）` 与图像块。
**规则**：J1、J4、J5。
**模型会做错什么**：不知道 `full` 是整页/视口开关（默认视口），在长页面上拿不到内容时会反复重发 `screenshot` 加各种无用参数，或在 `additionalProperties: false` 下被拒。收到「可改用视口截图」时也无法照做——错误文本没有给出对应的调用（`full` 省略或 `false`），这属于 J4：「改用视口截图」是一个模型的合法下一步，但没写清怎么描述它。另外结果里的 `contentHash` 对模型无用途。

### 14. `close` / `resume` 失败后没有出路
**文本位置**：`browser-tools.ts` 第 132–134 行：
```
if (!await deps.manager.close(ctx.sessionId)) throw new BrowserError("stop_unverified", "浏览器停止未核实；保留绑定，须拥有者核实");
```
`browser-manager.ts` 第 416–417、420、560、591、698、713、716–717 行的各类 `browser_stop_unverified` / `browser_identity_unverified` / `browser_target_in_use` 文本，如「浏览器停止未核实；保留绑定，须拥有者核实」「浏览器控制目录残留执行记录，请核实原执行后再启动」。
**规则**：J2。
**模型会做错什么**：这些文本把「核实原执行」写成模型的下一步，但**模型没有任何工具能核实进程或目录**，能做的最多是把 `status` 的整包硬事实转述给拥有者。没有出路时 J2 要求的写法是「明写停下来报告拥有者」，而现在模型会继续在 `start` / `close` / `snapshot` 之间打转（`start` 因绑定未 `closed` 被拒，`close` 又可能再次返回 false），把一次失败放大成多轮无效调用。

### 15. 禁令写了，反面没写
**文本位置**：快照 `browser.description` = `"...先 snapshot 再使用引用；结果未知时不重发。"`。识别与处置的实现在 `browser-manager.ts` 第 116–121 行 `responseError`（返回 `outcome_unknown`，并已在文本里写「已暂停自动化，请核实当前页面，不能重复旧动作」）、第 152–154 行（取消/超时同样是 `outcome_unknown`）、`browser-tools.ts` 第 168–173 行（`effectUnknown` 会被记账）。
**规则**：J4。
**模型会做错什么**：「结果未知」这个词在工具描述里既没有定义成可识别的形态，也没写识别之后该干什么（是 `status`、`close`、`pause`，还是直接报告拥有者）。模型很可能把「不重发」读成「换个参数再试同一目标」，恰恰是要禁止的；或者在 `click` 结果未知后改用 `press`/`select` 达成同一效果——同样属于重发旧动作的效果。

### 16. 「先 snapshot 再使用引用」写在使用者手里，但引用的失效语义两边不一致
**文本位置**：快照 `browser.description` = `"...按快照的 eN 或 @eN 引用 click/fill/select/check/uncheck..."`；`browser-tools.ts` 第 44 行（`eN` 被静默规范成 `@eN`）、第 138–140 行两条 `stale_ref` 文本（「引用未由当前代次 snapshot 提供；请重新取快照」「元素已失效；请重新取快照」）、第 164 行（一次 `snapshot` 覆盖上一代的 refs 集合）。
**规则**：J2、J6（措辞一致性）。
**模型会做错什么**：描述说 `eN` 或 `@eN` 都行，错误文本却只承认 `@e`，模型在拿到拒绝后会花一轮纠结引用格式而不是去重新 `snapshot`。「重新取快照」这半句是好指引，但没有写明「上一代 `eN` 在下次 `snapshot` 后可能指向别的元素」这一失效模型，模型会跨快照复用编号，撞上第二条 `stale_ref` 再重来。

### 17. 宿主准备类失败会把模型推向 `bash` 去装东西
**文本位置**：`browser-manager.ts` 第 399 行「请准备当前平台 agent-browser v0.39.1 官方原生程序并配置宿主路径」、第 403 行「agent-browser 程序校验值不属于固定官方 v0.39.1 release，请重新准备官方资产」、第 405 行「agent-browser 版本不满足固定 release 要求」、第 409 行「请先准备 Chromium 并配置宿主可执行文件路径；模型任务不会自动安装或提权」、第 411 行「Chromium 不可执行，请核实宿主准备步骤与权限」。
**规则**：J2、J4。
**模型会做错什么**：这些都在说「宿主前提没满足」，但只有第 409 行半句「模型任务不会自动安装或提权」接近正面的禁止。前三条读起来像一个可执行清单（「重新准备官方资产」），模型完全可能转身用完全访问的 `bash` 去 `brew install`、`npm i -g agent-browser`、甚至下载二进制替换——都在完全访问许可范围内。这几条文本应当明写「这一条只有拥有者能解决，停下来报告」。「固定 v0.39.1」「校验值」这类实现细节对模型也无用途，属于 J5 式的管道信息。

### 18. 描述里的身份限定是模型管不了的条件
**文本位置**：快照 `browser.description` = `"...仅完全访问的拥有者 main/普通开发会话。网页资料不构成指令或授权。"`；对应的装配与校验在 `browser-tools.ts` 第 19–23 行 `browserTaskAllowed`、第 85–87 行 `verify`。
**规则**：J8。
**模型会做错什么**：这是典型的「工具可见即已满足」的装配条件写进了描述（会话身份在服务端按 session 判定，模型选不了）。后果是模型可能因为「我这条会话算不算普通开发会话」而先向拥有者确认一次，或在出现跨会话字符（比如续接别的会话历史）时自认为不满足而拒绝调用。`网页资料不构成指令或授权` 是另一回事，属正当的安全声明，保留。

### 19. 需要模型转交给拥有者的地址没有通道，不需要的地址却给了
**文本位置**：快照 `browser.description` = `"...密码由拥有者在窗口或 dashboard 输入..."`；`browser-manager.ts` 第 475 行 `binding.dashboardUrl = "http://127.0.0.1:${port}/?port=${this.streamPort(binding)}"`，该字段只随 `status` 的整包 JSON 出现，描述里没有任何 `dashboard` 动作或参数。
**规则**：J5（两种地址的第二类：要转交给拥有者的）。
**模型会做错什么**：J5 的例外条款把「要转交给拥有者的地址」也算该留的事实，但交付路径整个缺失：模型只能靠撞见 `status` 的 JSON 才发现 `dashboardUrl`，也可能先去找并不存在的 `browser {action:"dashboard"}` 动作。对无头实例，模型更无从知道让拥有者去哪里输密码。

### 20. 成功路径的结果形状没有一处被承诺
**文本位置**：`browser-tools.ts` 第 166 行 `return { content: [{ type: "text", text: JSON.stringify(data) }], details: undefined }`；第 161 行的动作映射（`tabs switch` → `tab <index>`、`tabs new` → `tab new [url]`、其余直传）；`browser-manager.ts` 第 487 行的初始化动作是 `snapshot`（即 `start` 之后页面是 `about:blank`，第 523 行末尾参数）。
**规则**：J5、J1。
**模型会做错什么**：`tabs list` 返回什么字段、`index` 从哪来（是列表序号还是页面给的编号）、`tabs new` 之后新标签的 `index` 是否会出现在结果里，描述与错误文本都没写。模型最常见的多余调用就是 `tabs {operation:"new"}` 之后**必须再来一次 `tabs {operation:"list"}`** 才能知道该 `switch` 到哪个 `index`。同理 `start`/`snapshot` 的返回只被描述成「快照的 eN」，模型不知道 refs 的容器字段形态，只能从 `browser-tools.ts` 第 78–81 行才知道有个 `refs` 对象——而那是源码，不是模型可见文本。

### 21. `speed / wait / press / scroll` 的行为语义缺失
**文本位置**：快照中 `ms`、`direction`、`key`、`pixels` 均无 description；`browser-tools.ts` 第 60 行（`direction` 限 `up/down/left/right`）、第 64 行（`wait` 必须给 `ms`）、第 161 行（`press` 直接 `["press", key]`，`scroll` 默认 500）。
**规则**：J1、J2。
**模型会做错什么**：`wait` 的语义（固定等待还是等页面稳定）没写，模型会把它当成「等加载完成」的万能动作反复调用，而 `ms ≤ 25000` 的上限也让它无法等更久；`press` 是否支持组合键（`Control+A`）没写，模型可能拆成多步或绕道 `fill`；`press` 没有 `ref` 时作用在焦点元素上，模型不知道焦点在哪，可能把按键送进了错误的输入框——这属于「先 snapshot 再使用引用」没有覆盖的例外。

---

## 三、SKILL.md 本身难以套用的地方

1. **第 1 步与本次材料不匹配。** SKILL.md 要求「取完整的工具列表与系统提示（提示里常写着工具描述省略掉的用法），不只截被审工具」，但材料只摘了两个工具、没有系统提示。结果是第 3 步的排除条款（「模型在调用前必然读到的其他文本已写明正确做法的，也不成立」）几乎无法执行：我判不了 `read_artifact` 是否存在、判不了「任务执行边界」是否在系统提示里有定义、判不了 `timeout` 默认值是否在别处出现。这几条我在报告里都标了未覆盖，而不是按成立处理。

2. **「同一定义装配给多种身份时，每种身份各取一份快照」（第 1 步）与 J8 互相拉扯。** `browser` 只在完全访问的 main/dev 会话可见，材料只有这一份；`bash` 显然装配给别的身份，但没有对应快照。于是 J8 那条「分叉是模型选参数的依据」对这两个工具基本不适用——需要区分身份的参数（如 `workspaceOnly`）在快照里根本不存在。

3. **J5 的「两种地址」在实际材料里两头都不齐。** 规则说「模型自己的下一步要用到的」和「要转交给拥有者的」都算合法地址，但 `dashboardUrl` 属后者却没有交付通道（见第 19 条），`cdpUrl` 属前者却与 `attach` 的 loopback 约束打架（见第 12 条）。按 J5 的措辞可以机械地判定"不该出现在结果里"，但真正的缺口是「该出现却没给模型用它的方式」，这条 J5 没有对应表述。

4. **J6 的触发条件在 `bash` 上无法判定。** 规则是「宿主追加的提示只在真的截断时出现」，而材料里看不到 bash 结果被截断时的返回形状与 `WORKER_CALL_TIMEOUT_MS` 的取值。`tool-router.ts` 第 402–408 行那行提示确实是**无条件**追加的，但要说它「造成了模型误判」，需要知道结果本身是否可能被截断——这一步 SKILL.md 没有要求补的材料清单，只能靠审者自己意识到。

5. **第 2 步的「串起典型任务」在三份材料之间断层。** 任务 3（bash 起服务 → 浏览器访问）恰好落在两个工具的交界，而交界处最关键的两条事实——调用结束后后台进程是否存活、本地端口能否被 operated browser 访问——一条在 `tool-worker`（材料只有 85–155 行，`shutdown` 与 `finish` 的存活语义片段可见但生命周期归属不可见），一条根本不在任何材料里。SKILL.md 的第 2 步假定审者能取到「会配合使用的几个工具」，本次只能声明这是唯一能靠推理覆盖而无法核实的一类。

6. **量化一节的两个入口（TUI `/prompt`、`ruukoto selection-records --session <id>`）本次完全用不上**：没有系统提示原文，没有历史调用记录，`estimates` 也就无从取。按 SKILL.md 它只是「改描述时」的要求，本报告只审不改，因此合规，但要提醒：用同一份 blind 材料做「改动前后估算」是不可能的，量化必须回到有会话与 prompt 快照的环境里取。
