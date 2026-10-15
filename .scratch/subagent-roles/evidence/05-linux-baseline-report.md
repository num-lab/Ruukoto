# 工单 05 Linux 新接口基线

对象为 `5f9da455072d68180ef19fc92ad02070cea583c1`，以 `git archive` 固定全部源码、测试、构建输入及常驻文档，排除 `.scratch/` 的历史证据；需求与历史记录在主仓只读核实。验证归档 SHA-256 为 `379a9e19ad448ceccae2550464140aaffc1edd910c535ab1397d5eec8c232438`。Linux 解包前核对归档哈希，前后 616 项普通文件逐项一致，原始清单、核对输出与两个清单 JSON 均保留；符号链接随固定归档保留。远端为本次唯一 `/dev/shm/rk05-linux.ZHrgZC/repo`，归档后初始化独立 Git 夹具，夹具提交 `cbd5577154e74b8465b83ebf3a618d34514d7bf1` 仅提供安装所需检出，不充当源版本。

环境为 `ssh tx`、普通用户 eitrous / UID 1003、Linux 6.8.0-117-generic x86_64、Node 24.21.0、npm 11.19.0、Git 2.43.0、bubblewrap 0.9.0。user systemd 为 running，cgroup v2，正式 `/usr/bin/bwrap` 和 `ruukoto-bwrap` AppArmor 配置存在，内核 userns 限制保持 1。磁盘初始仅余 354MB，因此本次源码、依赖、npm 缓存和 TMPDIR 全在唯一 tmpfs 目录；没有清理其他任务、改系统配置或接触现有实例数据。

`npm run setup -- --skip-hooks` 退出 0，40.698 秒；`npm run build` 退出 0，2.003 秒。npm 11 的 esbuild/protobufjs postinstall 未批准提示原样保留，正式构建成功。实际 worker SHA-256 为 `ec4d123259d2ee502107d66c7598a5d88ad4a7551bf4ca9d3383cd3d70bdb909`，与 03 机制证据相同；脚本 worker、WASM 和三项实际编译物另存完整字节与哈希。

八文件原始组合使用 `npx tsx --test --test-concurrency=1`，完整参数见 `baseline-raw/native-suite.command.json`。最终 73/73，失败、取消、跳过均为 0，退出 0。外层命令实际耗时 617.084 秒，起止 02:58:04.584–03:08:21.669 UTC；Node 内部耗时 616.609 秒。没有修改 timeout、增加 retry 或重跑此组合。

| 文件 | 通过数 | 主要证据 |
| --- | ---: | --- |
| 101-native-linux-scope | 3 | cgroup 证据和前置失败策略；部分为注入夹具 |
| 110-workflow-workcopy | 8 | 真实 Git、冻结二进制、独立验证副本与增量汇入 |
| 112-workflow-real-steps | 13 | 双产品真实 Driver/工具、冻结验证汇入、未知效果、缺损与启动取消 |
| 125-agent-wait-resource | 9 | 真实 worker 让出重取、冷启输入及停止未核实的调用方策略 |
| 125-agent-wait | 5 | 双产品真实 worker 全链、父轮核实与唯一报告、非 Git 占用及审批 |
| subagent-workspace-snapshot | 4 | 双产品当前内容及 native 源保护、结构化工具和宿主批准拒写 |
| workflow-role-integration | 9 | 两入口同源与角色钉版、真实 bash、宿主验证限制、缺损恢复及旧接口 |
| workspace-snapshots | 22 | 真实 Git 当前 staged/unstaged/untracked/binary、子增量和失败零源写 |

另在相同源版本执行原 `test/08-approvals.test.ts`，19/19、0 跳过、退出 0，外层耗时 23.057 秒；严格保留 HTTP 批准前零调用和批准后仅一次的原断言。该文件与 scope 探针各有独立命令和日志，执行期间与主组合重叠，不相加成主组合耗时。

正式 `linux-scope-probe.mts` 退出 0，3/3，7.104 秒。活动 detached 且忽略 SIGTERM 的后代先真实写入 4 字节心跳，整 scope 停止与重复停止均 true，随后心跳冻结、manager 确认组删除。快速退出在本次观察过组，启动 reason 为 policy_missing，停止 true；入口前失败未观察过组，停止 false（5070ms），外部 manager 确认组删除后仅清理该无后代夹具，保留未核实停止结论。此探针使用生命周期程序夹具，真实的是正式 launcher、OS 与 user scope，不冒称角色授权装配或真实模型。

首次 SSH 连接在主组合中途被远端关闭，客户端退出 255；重连确认原 runner PID 2291427 继续运行、日志增长，后续没有重新启动组合。最终退出 0 来自原 runner 写入的实际子进程结果。传输故障与测试结果分列。初次含历史证据的 24MB 全归档上传曾主动中止，未解包或执行；后改传 2.65MB 验证归档并完成校验。bootstrap 末行一个哈希输出字段笔误单独更正，归档解包前断言和后续 sha256sum 校验均正确，原日志保留。

基线结束后源工作树干净，user manager 只列 init.scope；没有本次活动 native scope。复跑需要正式 bwrap/AppArmor、可用 user systemd 与 cgroup v2、可写 cgroup.kill、已构建 worker；缺前提应按 deploy/native 准备后重跑原命令，不计隔离通过。

本次模型均为本地 mock，SDK、Runtime、Driver、worker、工具、Git 与 Linux 执行边界真实运行；没有运行真实模型、真实 IM、真实 MCP/个人业务服务或部署。以上是固定源版本的 Linux 基线，后续目标摘要和来源消费补丁须分列验证，不能把补丁后的结果写成此提交原有行为。
