# 个人单次命令的宿主回执与恢复

Status: resolved

## 目标与边界

接续[总工单](01-migration-plan.md)、[持久执行身份](22-native-execution-identity.md)与[独立 worker](23-command-worker.md)，闭合 Linux 受限命令的实际宿主消费者。按[规格](../spec.md) A5/A6/A9 保存原执行、原临时目录和宿主完成证据，恢复只查询和停止，不重新执行。沿用已确认产品范围；不开放模型工具，不建 durable 工作、审批或菜单，不改完全访问、MCP、Coding 入口或部署。

## 方案

- 新增 `apps/ruukoto/src/personal-command-execution.ts`，接收可信宿主预先提交的具名执行引用、命令、`LaunchSpec` 和已 prepare 的输入。调用方固定使用个人自包含 worker 与空依赖准备；正式调用方仍须在调用前持久保存原工作及引用。
- 私有目录独占建立本次命令记录，请求指纹覆盖命令、完整 spec 和 prepared 输入；按路径哈希和 dev/ino 独占认领临时目录，再保存原 `tempDir` 的真实路径及 dev/ino，之后才 launch。查询与清理核对原临时目录反链，不允许不同引用共用一个临时目录。相同引用不重新启动；异参同引用拒绝。记录目录必须与全部 worker 可见范围不重叠。prepare 后、绑定前崩溃可能留下未派发临时目录，明确保留此上限。
- 等 launch 返回后安装 stdout/stderr/exit 消费，再提交完整 stdin。双流原字节落入私有文件，正常退出及双流完成后才原子发布宿主回执，包含请求指纹、退出观察及输出长度/哈希；不解析 stderr，也不按退出码推断业务效果或未执行。中断、输出/回执写失败或缺回执保持未知，保留已捕获输出。取消/超时从 launch 前监听，launch 最终返回或失败后仍按原 ref 重核停止；独立停止已登记时拒绝发布完成回执。请求、回执及双流均核对私有普通文件，拒绝链接。
- 独立读取 API 校验原引用、版本、请求/绑定及输出哈希，返回原回执或未知。独立停止 API 无论有无内存 unit 均按原 ref 调用 `stopLinuxExecution`，停止与运行结果分别返回；只有已核实退出、且原临时目录身份仍相符时才清理，不删除替换目录或命令证据。
- 新窄测试覆盖调用顺序、原字节/大输出、非零/信号、同键至多一次、取消与超时、捕获/发布失败、坏记录及目录替换；Linux 真实 bwrap/scope 验证完成回执跨进程读取、后台 SIGKILL 后无回执且不重放、原引用停止及清理。沿用 worker/native 与产品入口定向回归，执行 build 与 static，不跑全量 check。
- 同步 personal-durable/products 模块说明及决定笔记；无新命令、配置或依赖。理由见[决定](../../../.agents/notes/implemented/architecture/2026-10-17-personal-command-execution.md)。

## 进展与交接

- 当前角色：工程交接，独立终审及材料复核无未解决阻断。分支 `Eitrous/migrate-to-pi-durable`，基点 `36c2c77d0d31631d222efc816ae4f13695a11c0a`；接手工作区干净，拥有者已授权本次提交，由本次提交承载实现与证据。八个实施/测试/说明文件的哈希及内容由[本机快照](../evidence/24-macos/source-manifest.json)和[归档](../evidence/24-macos/source-final.tar.gz)持有，工单记账不在源码快照中。
- 当前成果：`runPersonalCommand` 消费可信宿主已 prepare 的个人空依赖输入，保存原请求、临时目录独占绑定与原始双流；读取回执与按原引用停止可在独立进程完成。没有新增 durable Task、配置、模型工具或菜单。
- 下一角色与动作：总工单实施者将此 API 接到原工作权限、操作准入、未知暂停与持久占用；须覆盖全部工作收尾/释放、跨来源服务调用及报告恢复。调用前先持久保存原工作与执行引用，不把回执退出观察解释成业务效果。
- 阻塞：本片无未解决阻断，无新增产品取舍；完整迁移仍未完成。恢复要求原机器、证据目录及 TMPDIR，变化时保留现场并恢复原环境。

## 验收与证据

- 独立方案审查 `command_plan` 于 2026-10-17 直接核对规格、原生 launcher/worker 与本方案，补齐完整输入指纹、私有文件核对及取消末次停止后无未解决阻断；亲跑 verify-notes 通过。
- 本机 macOS 27.0.1 / Node 24.15.0：`npm run setup`、`npm run build`、`npm run check:static` 通过；六文件基线 67/67；最后仅补强独立停止的离线灵敏度，受影响 adapter 最终复跑 14/14，合并覆盖 67 个唯一场景，含旧 worker/native 身份/策略及两产品入口。源码未改变共享 launcher 或 Coding 装配；新宿主用例使用真实 Node worker 和系统调用桩，不当作 macOS 沙箱或 Linux OS 证据。[测试](../evidence/24-macos/tests-final.log)、[构建](../evidence/24-macos/build-final.log)、[静态](../evidence/24-macos/static-final.log)保存实际输出；末轮测试补强及互链/TMPDIR 前提补充后，最终 static 再次通过。
- Linux tx / Linux 6.8.0-117 / Node 24.21.0 / bwrap 0.9.0 / systemd 255：真实 prepare、空依赖 worker 与 user scope 最终七项通过。覆盖二进制/非零与新进程读回执、3 MiB 双流、timeout/cancel 的 setsid 后代、独立新进程停止与活 run 并发无回执、owner SIGKILL 后无回执/不重放、原临时目录替换保留。原 scope 全部 not-found、原目录/fixture/匹配进程为零，远端专属目录已删除。十个运行文件与本机一致；[Linux 导航](../evidence/24-linux/README.md)保存源码/探针/原始记录/清理与全部历史轮次。未做 Linux npm 安装或全产品构建。
- 独立实现审查 `command_plan` 亲跑 worker/native 三文件 31/31 及新 adapter 14/14；在隔离副本重现两项阻断：不同 ref 共用 temp 时快者会删慢者目录，独立停止后普通退出码仍会发布完成回执。修复为私有目录的 temp 路径哈希/dev/ino 独占反链及发布前停止标记检查。最新源码隔离反证确认两者修复，并核实缺 request 拒读/不清理、缺 receipt 保持未知/不重跑、坏 temp 反链拒清理。[隔离材料](../evidence/24-macos/independent-review/README.md)不修改共享源码；最终代码无未解决阻断。仓库独立停止窄用例另模拟 systemd-run 的 137/null 退出；隔离撤去停止标记检查时以 Missing expected rejection 预期失败，最终单例由审查者亲验通过。
- 原失败：本机新测试首轮 9/11，通过后复核发现重复调用先检查已清理 temp 而返回通用登记失败，现先拒绝已认领引用；另一项夹具嵌套 mock 恢复残留导致下一用例 prepare 失败，改为显式夹具接点。最终 14/14。Linux 首轮六项通过；新增独立停止探针曾同步等待新进程而堵塞 owner 事件循环，导致 launcher 未回收、停止保守 false，改异步等待后最终七项通过；初始与中间材料均保留，不累计通过数。
- 最终材料复核：`command_plan` 独立核对本机最新测试哈希、Linux 十文件及源码归档与当前工作区一致；records.tar.gz 中 70 份最终材料长度/哈希一致，两个正常回执的请求指纹和双流哈希、七项 temp/ref 反链逐项成立；其余五项中断无回执，probe 时序与清理证据相符。工单、笔记及文档范围一致；末轮只改测试与记账，Linux 生产源码未变，沿用真实 OS 证据。
- 工程验收：通过。产品验收：不适用，本片没有新增用户入口。真实模型/IM、durable 命令权限/暂停/占用、完全访问、MCP 及完整迁移继续由总工单持有；拥有者已授权本次提交，未授权推送或部署。

## Comments

2026-10-17：拥有者指示接手总工单；先闭合 worker 的宿主消费者，避免把退出码、stderr 或内存句柄消失当作业务效果与停止证明。

2026-10-17：独立方案/实现审查后补齐临时目录独占与独立停止门禁；本机 67 项和 Linux 七项真实场景通过，交最终材料复核。

2026-10-17：最终材料独立复核通过；补强后的独立停止单例由审查者亲跑，撤门禁必红。工程交回总工单，未提交、推送或部署。

2026-10-17：拥有者指示提交；独立核对本机八文件 manifest/归档与 Linux 十文件 manifest/已测归档均与当前工作区相符，沿用已验实现与审查结论，仅更新提交交接记账；未推送或部署。
