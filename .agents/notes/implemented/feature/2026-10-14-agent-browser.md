# Agent Note: 用共享宿主工具接入有会话归属的 agent-browser

Status: implemented

MyGo 右栏拟使用独立的桌面工具与接管规则，见[待实施提案](../../proposed/feature/2026-10-29-mygo-agent-browser.md)；本篇 Chrome 生命周期与暂停约束保持。

## 问题

两个产品的主 Agent 要直接打开网站、操作并看截图，也要复用已有登录态。main 没有 bash/MCP；普通开发会话的 bash 和 Driver registry 按任务回收。仅安装 CLI/skill 无法覆盖 main、跨轮页面、取消核实与附接保留用户窗口。原版 v0.39.0 在 daemon 丢响应后重发命令，不能靠宿主只调用一次消除重复提交。

范围与拥有者 Q1–Q15 确认见[工单](../../../../.scratch/agent-browser/issues/01-integrate-agent-browser.md)，官方版本与实测事实见[调查](../../../../.scratch/agent-browser/research.md)和[真实生命周期证据](../../../../.scratch/agent-browser/evidence/lifecycle-probe.md)。

## 决定

两个产品共用 `browser` 宿主工具和 Runtime 持有的 `BrowserManager`，只开放完全访问的拥有者 main / 普通开发任务。装配、任务白名单、发送前、调用门和执行前复核同一资格；Plan、SubAgent、scheduled、workflow 步骤/回报、GitHub 来源及受限模式均不继承浏览器能力。动作使用上游 snapshot 引用与固定参数数组，不开放模型可改的程序、配置、profile、socket 或截图路径。

使用包含 #2085 防重发修复的官方 v0.39.1 原生资产，按平台 SHA-256 和版本核实，不引入声明 Node ≥24 的 npm wrapper，不维护补丁或自编译提交；保持宿主 Node 22/24。程序或 Chromium 缺失只拒绝浏览器调用，其他能力继续可用；拥有者准备依赖，模型任务不安装或提权。

### 生命周期与排他

Runtime 直接启动、登记并持有自有 Chrome，CLI 仅连接显式 CDP。真实探针证实原生 CLI daemon 被强杀会留下另组 Chrome，直接重开触发 SingletonLock；不能把 daemon 的进程组当作浏览器的全部归属。PID、进程组和系统启动身份共同用于回收；Chrome 正常关闭先走 CDP `Browser.close` 再查整组与 profile 关联进程，避免仅发 SIGTERM 丢失新 Cookie。附接 Chrome 不登记为宿主回收对象，只停止自己的 daemon/dashboard。

profile 按 dataDir 和会话隔离，socket 与 CLI session 使用宿主生成标识，跨任务保留页面。显式 native idle=60 分钟覆盖外部 CDP；键鼠人工输入重置计时，宿主只查进程，不发保活命令。空闲、显式关闭和后台停止保留 profile、历史与截图。冷启动核实旧执行停止后只允许显式重新启动，不恢复旧页或重放旧动作。持久 Cookie 沿 Chrome profile 保存，无 expires 的会话 Cookie 与网站登录期限不额外保证。

显式附接只接受 loopback，HTTP discovery 不跟重定向，返回 WebSocket 的地址和端口再次核实。浏览器 UUID 作为共享同 UID 锁目标，localhost/IP 与 URL 形式变化不能获得另一自动化占用；自有 Chrome 也持锁，跨产品占用一致。锁损坏、归属不符、PID 复用或启动窗口不明时保留不可用和原占用，不误杀、不用新实例掩盖旧执行。

`meta.browser_bindings_v1` 保存版本化绑定、代次、进程身份、启动占位、暂停任务、未知效果与官方 sidecar fingerprint；更新与 `browser.binding_changed` 事件同 core 事务。CDP discovery 支持取消且受总期限约束，慢流不能阻止关闭；每次命令前核实原 daemon、版本与源配置/sidecar，拒绝 CLI 自动换代，不复制上游私有 hash 算法。profile 文件与 SQLite 不承诺原子，绑定不保存 Cookie/密码正文。

### 调用、人工恢复与图片

快照的裸 eN 引用与 @eN 都规范为同一引用，再核实当前代次和新快照，避免上游显示形态与模型参数不同。单动作通过官方 stdin batch 传递，输入 `--config` 不会被全局 flags 吞掉。工具与管理器均顺序执行；在途取消停止当前 CLI 并核实后台执行单元。变更动作发出后通用失败、断线、超时或取消一律保守记 `effect_unknown`，不重发；读取失败不能伪造写入效果，未发送的新调用不继承旧调用的未知标记。动作后状态保存失败保留原未知效果；关闭保存失败仍回收已核实单位，但保留未核实结论与占用。已知 `tab_gone` 保留该码，元素动作只接受已暴露的当前代次引用且用新快照核实是否仍在，不解析诊断文本判别重试安全。

人工登录先 pause，通过有头窗口或官方 loopback dashboard 输入密码与验证码；Linux 经 SSH 转发。dashboard 不配置额外模型聊天。暂停保存接受事件的顺序屏障；原任务和暂停前已排队输入不能解除暂停，IM 沿原消息登记顺序而非异步准备后的排队顺序，拥有者暂停后的新消息才能 resume；先只读 snapshot 核实连接，换代清旧引用，再继续新动作。未知结果也只登记等待新任务核实，不把 unavailable 变为可自动操作。切换有效权限先关闭本任务使用的浏览器并重算白名单；排队任务不关闭同会话另一活动任务的浏览器。

截图由宿主分配路径，校验实际 MIME、8 MiB 上限、字节数与 SHA-256，再用既有 ArtifactStore 提升为不可变图片，返回视觉块与工具产物引用。实际模型输入沿既有 JSONL 和 prompt 快照重建；纯文本模型在图片发送前失败，落盘失败或超限不宣称已看图。完整取回沿[产物导出决定](2026-10-14-artifact-file-export.md)，不扩控制协议。

### 与既有决定的关系

已按 browser、MCP、工具族、原生执行、完全访问和图片检索笔记：本篇吸收此前同路径提案，没有另一浏览器提案。[两个产品](../architecture/2026-10-02-two-agent-products.md)、[MCP 客户端](../architecture/2026-09-23-mcp-client.md)、[当前账户完全访问](2026-10-12-full-access-current-account.md)、[个人原生执行](../architecture/2026-10-12-personal-native-sandbox.md)和[读取图片](../bug-fix/2026-10-12-read-images.md)部分重叠，继续持有原契约；本篇只增加浏览器归属与调用，不扩大 MCP 或受限权限。产物导出独立持有文件取回，两篇互链。

## 关联提案

Coding 本地预览服务的跨轮存活与后台观测浏览器见[会话后台](2026-10-21-coding-background-processes.md)；[后台生命周期提案](../../proposed/feature/2026-10-14-bash-background-lifecycle.md)的个人接入仍未落地。本篇继续持有 Chrome 的归属和生命周期，服务由独立后台执行持有。

个人 Pi 1.3.0 的独立装配见[浏览器与图片归属](../architecture/2026-10-18-personal-browser-media.md)；本篇继续持有既有共享装配与权限/媒体规则，个人 durable 的绑定、接纳和恢复由该篇持有。

## 备选方案

CLI + skill 最省代码，也能服务普通开发会话，但不能覆盖 main 的直接调用、跨轮归属或附接回收，所以采用专属宿主工具。

官方 stdio MCP 可复用工具定义和图片块，但仓库只开放远程 HTTP，main 没有 MCP；扩通用本地传输会增加配置、存储和权限面，官方 MCP 还复用 CLI daemon，不解决生命周期。出现多个本地服务需求时再讨论该传输。

每任务新建并关闭浏览器贴近 registry，停止简单；但违反跨轮保留页面。由 CLI 自行管理 Chrome 最贴近上游默认，但 daemon 强杀不收 Chrome；因此 Runtime 持有 Chrome，CLI 仅做已登记目标的连接。

最小补丁或直接构建官方修复提交可提前交付，但拥有者已选择正式 release；现在固定官方 v0.39.1 并用执行后丢响应的真实计数验证。自动 restore 能保留会话 Cookie，但可能导航加载来源页，状态文件还有独立权限与全局目录边界；首版保留 Chromium profile，不增加 Cookie/密码导出或页面重放。

## 后果

浏览器跨轮占用内存与持久磁盘，回收保留登录资料但丢失页面现场；profile 是同账户敏感资料，不自动删除或跨档案共享。不能无准备接管任意 Chrome，真实网站可要求验证码、硬件认证或拒绝自动化，受控页面通过不代表所有网站可用。

固定 native 行为、指纹与 hash 是升级边界，上游升级需重跑探针；停止未核实会保守保留占用，需要拥有者核实。Linux 探针的临时依赖与关闭 sandbox 仅用于校准，生产仍需磁盘、系统库和可用 sandbox。真实模型另有双产品视觉验收证据，拥有者人工体验仍待；离线 SDK 图片断言不冒充真实模型结论。

## 验证

`test/browser-lifecycle.test.ts` 覆盖单发 batch、结构码、取消、loopback、附接冷恢复、PID/锁不符、启动窗口和指纹变化；`test/browser-tools.test.ts` 经真实 Runtime/SDK/账本验证双产品图片历史、权限切换、在途取消、引用失效及截图失败。macOS Node 22/24 和 Linux 的真实浏览器事实、原始环境缺口及可复现脚本见工单证据；导出单独由双产品正式 bin 和控制面分页验证。

相关决定：[Coding会话后台](2026-10-21-coding-background-processes.md)为本地预览服务另定生命周期，在后台占用目录时沿仍有效的完全访问来源开放浏览器；个人接入继续由[提案](../../proposed/feature/2026-10-14-bash-background-lifecycle.md)持有。
