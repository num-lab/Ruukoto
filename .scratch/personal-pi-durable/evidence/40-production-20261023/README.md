# oracle-4c24g 正式 PA 部署（2026-10-23）

对应[切换工单](../../issues/40-production-cutover.md)。拥有者本轮明确要求在 oracle-4c24g 部署 PA，并选择先接 QQ；停止、备份、安装、配置与切换由 Agent 执行，拥有者仅从原 QQ 好友发送正式配对短语及聊天验收消息。

## 部署与运维

完整 workspace 固定为 `83712870417a906c5af5d53951379fbcd83b45b1`，排除 `.scratch` 的 git 归档 SHA-256 为 `f97a222ade12544e227290ce98fa82844ba899fa4b3deb1a915bfcfb26485280`。服务器在 `/opt/ruukoto` 执行 `npm ci --omit=dev` 与 `npm run build` 均通过，随后代码归 root 拥有。锁文件与 worker 哈希、实际服务身份和档案信息见[部署记录](deployment.json)。

正式档案为 `/var/lib/ruukoto/personal-durable`，普通账户 ubuntu（UID/GID 1001）运行，Node 为 root 拥有的 `/usr/local/bin/node`（24.15.0）；2026-10-24 与 Desktop SSH 的 shebang 入口统一。模型为已验 DeepSeek `deepseek-flash`，新个人事务目录 `/home/ubuntu/personal-workspace`；配置文件工具、Tavily 凭据引用与既有无头浏览器。未导入旧任务、会话、记忆、计划、业务数据、授权、验收 MCP 或验收技能，未启用 Telegram 或服务重启业务白名单。

`ruukoto-backend.service` 按现行模板安装，开机启用，使用普通账户、user manager/linger、明确 PATH/runtime/bus、UMask 0077 及 root:root 0600 的 `/etc/ruukoto/pa/backend.env`。保留模板的优雅停止参数，安装精确 start/stop sudoers。维护入口实际返回 `maintenance_ready`、`online=true`、`writable=true`；后台账户单独持有档案 SQLite WRITE 锁。环境文件只保存模型、QQ 与 Tavily 的凭据变量，不把值写入记录。

日常只管理同一系统服务：`ssh oracle-4c24g 'systemctl status ruukoto-backend.service --no-pager'` 查看状态，`ssh oracle-4c24g 'sudo systemctl stop ruukoto-backend.service'` 停止，`ssh oracle-4c24g 'sudo systemctl start ruukoto-backend.service'` 启动；日志用 `journalctl -u ruukoto-backend.service`。桌面设置管理选择此 SSH 别名、上述档案、`/opt/ruukoto/apps/ruukoto/bin/ruukoto.mjs` 与 systemd，先核实档案与服务。不要用旧聊天协议连接新档案。

## 旧实例保留与接管

原验收后台 PID 4103134 在停止前 tasks/inputs 均 0，通过原认证接口 `/stop` 返回 200，核实进程退出与独立 user scope 无残留。原档案 extension 1，正式空白档案 extension 2；没有用新程序打开或改写旧档案。旧档案、对应完整代码/依赖与凭据的受保护一致备份为 `/var/backups/ruukoto/pre-production-20261023T1435Z.tar.gz`（root 0600），SHA-256 `19a345f73682d5b97772b09aa66b98df631c70a488ccaf5fb3be85e5b584875e`。旧档案原地保留，244 份文件摘要经独立上下文复算全部不变，原后台为 detached 进程，无自动重启单元。

使用当前正式 QQ 向导重新配对，拥有者从 QQ 2729290885 向 bot 1529851498 发出本轮短语；新代次 `0e116730-0b6d-48e3-a78c-a3cffed9b3d7`，边界时间 `1792766070`、边界消息 `496954329`。只接纳边界之后的新消息，同秒及之前不执行；QQ 没有离线补拉，断线期间未受理的委托需重新提交。NapCat 仍在原回环 3001，没有第二个 PA 消费者。

## 验证与处置

- 安装、完整构建、单元语法、sudoers 语法、固定服务维护检查通过；旧档案指纹与备份哈希经独立复核。
- [命令 worker 检查](command-worker-tests.log) 5/5 通过；[Linux 原生边界探针](native-probes.json) 54 pass、0 fail、0 unavailable，原报告同时保留于远端 `/tmp/ruukoto-pa-native-probes/`。
- 使用同一普通账户、同样 PATH/runtime/bus 从临时系统服务运行[真实 Linux 后台检查](real-background-test.log)，1/1 通过，覆盖真实 scope、跨轮保留、停止核实与认领释放；未触碰生产档案。
- 初次实际模型请求与 QQ「你好」均 unanswered，持久任务记录明确为 DeepSeek HTTP 401；旧验收凭据已失效。只读 `/models` 同样返回 401，不能将 QQ 在线视作聊天通过。
- 本机既有个人模型配置的同提供方凭据经 `/models` 返回 200 后，通过私有临时文件安全传输并更新 root 环境文件，临时密钥文件随即删除。正常停止生产 PID 3017314 并核实退出，再启动 PID 3019474；InvocationID 更换、NRestarts 0、档案身份保持。修正后新请求 `03206ca1-ef8a-413c-acf3-e8d217fa8d0b` 得到真实 `done` 回答「PA 部署自检通过」，未重放旧失败输入。
- 独立上下文 deployment_review 亲自复核 328 份运行源码与当前检出逐字节一致、模板/账户/锁/权限/唯一后台、旧档案 244 份摘要、备份哈希、实际检查日志、重启前后身份及模型结果。当前部署结构、归档、停止/启动及模型无阻断；拥有者已在修复后发送新消息并明确确认收到 QQ 回复，本轮部署与 QQ 实际收发验收完成。
- 最后只读核实与独立复核均确认 QQ 最新新消息 `delivery=sent`，旧失败仍为 `unanswered`；服务保持 enabled、active/running、原 PID 3019474、NRestarts 0，后台无活动任务或输入。实际状态与拥有者收件确认已补入部署记录。

## 尚未覆盖

本轮不启用或验收 Telegram，不把旧回环代理当作可用入口。无头浏览器与 Tavily 只配置现有程序/凭据引用，未做本轮真实业务验收；未新增 MCP、技能或业务服务白名单。未跑全仓检查，本地只修改工单与部署证据。39 已披露并由拥有者接受的三项历史未归因失败仍保持原结论，本轮成功不构成归因或修复。

回退遵循现行[部署说明](../../../../deploy/systemd/README.md#升级与回退)：先停并核实新实例和独立执行，保留两份档案；旧代码也使用另一个空白档案与新配对边界，不启动归档以恢复旧任务或积压。

## Desktop 检测修复（2026-10-24）

真实 Controller 连跑两次成功、第三次 `management_ssh`；使用真实 DesktopHost、登录环境和拥有者保存的 MyGo 配置复现 `{ok:true,value:[]}`，同路径再次又能检测到 `/opt/ruukoto/apps/ruukoto/bin/ruukoto.mjs`。程序存在且可执行，SSH 间歇失败被原 Host 捕获并转换为空清单，界面因此误报未找到。没有把该误报当作程序缺失，也未修改 SSH 服务或防火墙策略；SSH 间歇中断仍未归因。

现 Host 缓存首个结构化探测错误，全部候选失败时透传给既有界面；任何候选成功仍返回成功列表，不加协议、配置字段、自动重试或原始 stderr 外发。三项真 Host → renderer 回归在原实现观察到全失败场景报红，修改后全失败、失败→成功、成功→失败均通过。Personal SSH 六文件定向检查 116 通过、0 失败、1 项 Linux 专用用例在 macOS 跳过；`npm run check:static` 与 `npm run desktop:mygo:build`（含签名核实）通过，日志见[定向检查](desktop-tests.log)、[静态检查](desktop-static.log)与[MyGo 构建](desktop-mygo-build.log)。新 sidecar SHA-256 为 `290d5954e674fe75ad4582aeb8332e14720cc1b1d830c73ebd2be1c3e65f8921`，对应本机未提交修复，不改变服务器应用源码版本。

另外，原单位指定 home 中的 Node，而非交互 SSH 的 shebang 使用 root 拥有的 `/usr/local/bin/node`，虽版本与 SHA-256 相同，规范路径不同仍被维护身份检查正确拒绝为只读。通过原版本维护入口在 blockers 为空时停止并核实旧 PID 3019474 与档案锁，再备份单元为 `/etc/systemd/system/ruukoto-backend.service.pre-desktop-20261024`，仅把 ExecStart 和 PATH 优先级统一到 root 全局 Node，daemon-reload 后正常启动 PID 3041190。原样 shebang `maintenance inspect` 已返回 `maintenance_ready`、`online=true`、`writable=true`，档案身份不变。这项配置修复只解决维护身份不一致，不声称解决 SSH 间歇中断。

独立上下文 deployment_review 完成方案和实际实现复核，亲跑新三场景并只读验证正式维护入口，无阻断。新 MyGo 已构建；实际新窗口仍需拥有者保留未发送草稿后关闭并重开，检测、保存连接并核实服务。未新调模型、未改模型/QQ 配置，未跑全仓检查或 Electron 原生体验。

## Desktop 切页读取冲突修复（2026-10-24）

拥有者重开后在连接核实和 PA 模型/Skills/MCP 页面看到「原维护操作仍在进行，请等待后核实」。实际没有本机 pending 维护文件，正式服务仍 online、blockers 为空；首页旧聊天「尚未配置」属于另一连接状态，已说明新 PA 暂不接 Desktop 聊天。

真实 Controller、假 SSH 的 inspect 明确握手、两个实际页面状态与连接核实稳定复现：旧页面自动查询未完成就切页，invalidate 只淘汰旧页面应答，新读取被同一控制器的互斥拒绝，并非锁未释放。新两项回归在原实现分别出现截图原文和共同读取中的伪 `management_busy`，修改后 2/2 通过；它们覆盖三入口共用一套查询、旧页淘汰、读取期间 apply 仍拒绝且没有 stop/save、新读取共同失败保持 SSH 错误、失败后可重新查询、关闭拒绝且不外调。

Controller 仅为 `read()` 共享进行中的 Promise，成功或失败后清引用，缓存命中前仍核关闭；`request/apply/restore/finish` 的互斥与权限、原请求和写入未知处理不变。没有排队重发写入，也未合并模型测试/发现等不同查询。独立上下文 deployment_review 复核实际 diff 并亲跑两项新回归，无阻断。

[七文件定向检查](read-tests.log) 146 通过、0 失败、1 项 Linux 专用用例在 macOS 跳过；[静态检查](read-static.log)与[MyGo 构建及签名](read-mygo-build.log)通过。额外只读连接真实服务器，用实际 Controller、两个页面状态与连接核实执行相同并发过程，[真实结果](live-page-reads.json)为旧应答丢弃、新页和连接核实均 ready、online/writable=true、maintenance_ready；没有模型请求、保存或服务启停。

最新 sidecar SHA-256 为 `ac186995b33bb9c6904eed85301c54d6ea77d623f72a107b304daba85ecf1bad`，替代上节本机旧构建；应用路径仍为 `dist/mygo/darwin-arm64/Ruukoto MyGo.app`。真实新原生窗口需拥有者保留未发内容后重开确认；SSH 间歇中断及不同查询的互斥不声称由此次读取合并解决。
