# Agent Note: 桌面环境预热与后台轻量就绪探测

Status: implemented

## 问题

登录 shell 的环境读取等到前端订阅才开始，无法与窗口加载重叠；ensureBackend 探测认证后执行 connect，正式连接再次获取完整快照。已有后台且历史较多时，这份重复快照增加连接等待。

## 决定

DesktopHost 创建时预热现有环境读取，每个应用进程复用一次结果；配置、Node 与令牌仍来自原来的登录 shell 或受管启动器环境。连接消费环境失败后才清空缓存，显式重新连接可以重试。预热错误不产生未处理拒绝，首次连接仍看到原错误。退出向直接读取子进程发送 SIGKILL 并等待 close，避免忽略 SIGTERM 的 shell 延迟退出，关闭后不采用环境或创建连接。

开发启动器先用 socket 可连性拒绝接管已有实例，包括停止中或不能完成认证的实例；等待自己启动的后台就绪仍要求认证 ping。后台就绪探测使用认证后的 ping，只有 pong=true 且 stopping=false 才算就绪；正式连接仍完整握手并安装快照。明确拒绝或仍可连接的 socket 不重复拉起。停止中的后台报告专属错误，畸形响应安全失败；保持令牌优先级、严格版本、探测超时、并发实例锁与退出归属。

历史检索：[桌面客户端](../../proposed/architecture/2026-10-15-desktop-client.md)和 [MyGo 宿主](../../implemented/architecture/2026-10-17-desktop-mygo-experiment.md)部分重叠，保留其环境来源与宿主边界；[后台与终端](../../implemented/architecture/2026-09-19-detach-terminal-from-task-runtime.md)的探测握手规则被本决定部分取代，其他锁与生命周期规则沿用；[两个产品](../../implemented/architecture/2026-10-02-two-agent-products.md)与[开发启动器](../../implemented/process/2026-10-09-dev-launchers.md)的产品归属、路径与受管环境规则不变。

## 备选方案

- 持久缓存或只读非交互 shell 可省掉更多环境等待，但会改变凭据与登录配置来源；保留原读取方式，仅提前开始。
- 在探测中直接复用正式连接能少一次 socket/auth，但会改变 ensureBackend 的进程启动职责和多个调用方的连接所有权；先用既有 ping 去掉重复快照。
- 同步优化后台冷启动与快照 SQL 可减少更多时间，但属于后续性能阶段，本轮不纳入。

## 验证

回归检查用受控环境加载器核实预热先于订阅且只读取一次、失败可见且可重试、退出取消并不采用迟到结果；用真实控制面与线协议桩核实探测不调用 connect、正式连接快照一次，停止、错误版本、认证拒绝与中断不破坏启动规则。真实 MyGo 与测量证据归[工单](../../../../.scratch/desktop-connection/issues/01-startup-preparation.md)，注明窗口、fixture 与环境成本。

## 后果

窗口很快加载完时只能重叠部分 shell 时间，不能承诺完全消除等待。轻量探测不证明完整快照一定成功；正式连接继续报告快照错误。登录脚本自身启动的后台进程仍由用户 shell 配置负责，宿主只取消其直接拥有的读取进程。
