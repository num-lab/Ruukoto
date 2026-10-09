# Issue 24：Linux 实机发布验收

2026-10-06，通过 `ssh tx` 在独立上传副本 `/tmp/ruukoto-release24-src-20261006` 执行。原始源码基点 `33571b4bef0aee815b59f352032d9caadfe25be5`；长任务与最终检查前同步 root 本次 `src/`、`test/` 和运行文档，包含回退响应状态修复及限定测试资源清理与 test/91 联合验证。日常 `/opt/ruukoto` 的代码、配置、数据与现役 helper/policy/sudoers 未修改。

环境是 Ubuntu 24.04.4 LTS、Linux 6.8.0-117-generic x86_64、Node v24.21.0、systemd 255.4-1ubuntu8.15、Docker 29.5.2。真实受限 worker 镜像 `ruukoto-worker:latest` 的 ID 为 `sha256:528b75873eb5587f553e98a66d391b461321f56d97697a5a8cf9fd39bd120e33`，pi 依赖 0.85.1。SSH 登录账户 UID/GID 1003；后台 `ruukoto-backend` UID 999/GID 987；完全访问执行账户 `ruukoto-exec` UID/GID 986。测试前日常后台 MainPID=3963064，状态 active；各阶段均确认仍为同一 PID。

执行次序是本地编码与测试，随后 IM 服务管理与长期授权，再进行长任务恢复、最终汇报和协作。模型都是确定性桩；服务管理中的 QQ 是 MockOneBot，最终汇报另加 FakeBotApi 模拟 Telegram。Runtime、产品后台进程、SQLite、JSONL、控制面 socket/令牌、Docker、systemd、sudoers、helper、可控服务与文件操作均真实。没有真实 IM 测试入口；真实 QQ/Telegram 的收件、平台限流/重投与拥有者人工演练明确未实测。

可复跑的隔离准备保存在 `release-24-linux-prepare.py`，仅接受无 `.git` 的 `ruukoto-release24-src-*` 上传副本。它把服务 helper/policy/ops/sudoers 改到本次独立路径，把测试单元改为 `ruukoto-service-release24-test.service`，结束后清理本次部署；helper 实现只替换固定部署路径。旧版 smoke04 最后的容器清理改为本次已提交 task ID，新版已有限定清理时跳过，不回收其他实例的容器。此准备脚本已用当前源码的临时副本连续执行两次，核实文件名、固定入口和清理操作均正确且幂等。

```bash
rsync -az --exclude node_modules --exclude .git --exclude .idea --exclude '*.log' ./ tx:/tmp/ruukoto-release24-src-20261006/
ssh tx 'cd /tmp/ruukoto-release24-src-20261006 && npm ci --no-audit --no-fund --prefer-offline'
ssh tx 'python3 /tmp/ruukoto-release24-src-20261006/.scratch/agent-direction/release-24-linux-prepare.py /tmp/ruukoto-release24-src-20261006'
# 以下均在该远端仓库根目录执行。
node_modules/.bin/tsx .scratch/agent-direction/smoke-04-desktop-execution.mts
bash .scratch/agent-direction/release-24-linux-full-access.sh
node_modules/.bin/tsx .scratch/agent-direction/smoke09-remote.mts
node_modules/.bin/tsx .scratch/agent-direction/smoke10-remote.mts
node_modules/.bin/tsx .scratch/agent-direction/smoke-15-recover-subagents.mts
node_modules/.bin/tsx .scratch/agent-direction/smoke-18-im-final-delivery.mts
node_modules/.bin/tsx .scratch/agent-direction/smoke-13-subagent-messaging.mts
SMOKE24_BASE_TAR=/tmp/ruukoto-release24-baseline.tar node_modules/.bin/tsx .scratch/agent-direction/smoke-24-release-acceptance.mts --upgrade-only
npm test
npm run typecheck
```

`release-24-linux-full-access.sh` 记录完整安装与清理步骤：当前源码打包 worker，root 固定路径安装，以新的只允许两个包装入口的 sudoers 文件授予后台账户启动/停止权限，包装脚本固定 UID/GID 986、worker 路径与任务单元名。后台用 `RUUKOTO_EXEC_LAUNCH_SCRIPT`/`RUUKOTO_EXEC_STOP_SCRIPT` 指向本次包装脚本。`EXIT` 清理只移除本次 wrapper/sudoers/worker。测试工作区是专用临时目录，并显式给予执行账户写权；后台 data/agent 采用部署所需的 0700 目录权限。

已完成的证据：

- smoke04 **6/6**：受限容器内修复 sum、修前失败/修后通过；外网与未挂载文件不可见、只读根拒写、工作区写入宿主可见；越界读取经单次审批消费；完全访问入口未配置时提交拒绝且不回退；中断回收真实容器。
- 完全访问 **通过**：首次 `task_004cd3ae5cc2d6b5ed86fac6`，最终完整安装/清理脚本复跑 `task_03215be5924de51ed1f16fac` 的 4 次工具操作在真实 systemd 单元内由 UID/GID **986/986** 执行，代码修复和检查成功，owner.token 与核心库读取均被系统权限拒绝。准备阶段两次夹具失败分别由测试源文件未给执行账户写权、testkit 默认 data 目录非部署权限导致，完善夹具后复跑通过，没有修改产品代码来放宽权限。
- smoke09 **14/14**，89.8 秒：模拟 QQ 私聊检查真实服务 → 通知/详情/单次批准 → 原入口结果；真实 restart 的 InvocationID 从 `21524b23cf664a51aea08497535c1a97` 变为 `3afc052cedea4c7e9a0b57f3c0340c40`，starts 1→2；命令单元 `ruukoto-service-op-op_b1f10df0aae9bf91f82aead5.service` journal 与 claim 可核实。相同 hostOpId 拒绝重放、策略/单元修订变化及越界目标零重启。真实 SIGKILL 隔离后台后的操作 `op_cc1fddfa05003157dbfc1e45` 和任务记效果未知，starts 最终为 3，恢复不再重发；拒绝不增。执行账户调用 helper、写策略、读令牌均拒绝。
- smoke10 **14/14**，118.8 秒：授权 `sp_70d6dbfd742257161a8771c2` v1，来源审批 `conf_41b29708e447b66bf74b94c4`，首任务 `task_a3a1f84f6ce90aa6ce346662`、操作 `op_8d9f6d60cc928778b28b0777`；第二独立任务 `task_5acd925bc4ad4b78cbea8525`、审批 `conf_b3761326115ce453911b7807`、操作 `op_b9b662e023078e9e5ada4375`。二者单次消费记录各异，只有长期授权相同，starts 1→2→3。真实 CLI list/show/revoke 的错误版本拒绝、v1→v2 与重复撤销幂等通过，撤销后拒绝零执行。明确重建授权后的本次重启使 starts 3→4；自动授权任务中真实终止 systemd-run，`op_79bbfce7d2895df77c450668` 记效果未知，该授权 v2/reason=effect_unknown，PID 1 已收到的重启使 starts 4→5，随后新任务重新审批，拒绝不增。初次隔离路径替换错误地改了源 unit 文件名而提前中止；修正准备脚本后完整复跑通过。
- smoke15 **8/8**，首次补齐 Linux 实机记录：真实容器读取/Runtime 重启/CLI resume-queue；排队执行 interrupted(backend_restart)，零模型调用、零容器；遗留占用记 unverified，CLI 核实后回 idle；沿 work_id 继续委派成功；评审任务自动恢复一次，重复重启不改旧结果、不产生容器。本脚本的崩溃持久形态按现有测试播种，并未声称实际 SIGKILL；实际 SIGKILL 由 smoke09/18 单列。
- smoke18 **7/7**，19.4 秒：模拟 QQ/Telegram 的受理→长任务期间继续对话→原入口最终汇报；Telegram 对 QQ 工作续派的结果仍回 QQ；离线恢复只发一次；重绑后的 pending 汇报取消且新目标零发送；真实后台 SIGKILL 与重启后恰好一份中断/未知汇报。

- smoke13 **6/6**：真实 Runtime/控制面/SQLite/受限 worker 与 CLI，协作加入工作 `work_567c8521df0d1750abfd0d85`；双向消息投递、来源核实、上级消息注入、同键幂等与无残余容器；Agent B 复用为 `work_ff26822b50324c9348fd0b9a` 后，旧协作关系失效，owner 显式关闭后投递明确拒绝；CLI 显示 4 条消息，重启保留而不重放。
- 双产品独立升级 **4/4**：`SMOKE24_BASE_TAR` 输入 root 从 `1aba2f1` 导出的旧源码包，两份独立真实 npm 安装与后台运行；逐端停止、替换 src/bin/package 并 npm ci 升级，另一端进程/实例身份不变且完成本地任务；升级前历史仍可查；个人端离线后编码端继续完成任务。升级任务模型为桩，后台与安装/持久化/停止真实；此次使用 `--execution local`，执行隔离由此前 smoke04 与完全访问单列。
- `npm run typecheck` **通过**。Linux 全量 test/08 的不可解析 DNS 用例已通过（231.7ms），没有 macOS 上 nonexistent.invalid 被映射为测试地址的问题。

Linux 全量首轮 **915 项，909 通过、5 失败、1 跳过**，494.3 秒。失败逐项诊断后修复，不直接归为环境失败：16/81 删除后重建目录的夹具在 Linux 复用同一 dev/ino，最小探针 20/20 复用、干净 `33571b4` 两个同用例 0/2；改为 rename 保留旧目录，新增不同身份断言后两文件 macOS/Linux 各 **39/39**，产品安全断言未弱化。83 的 running 早于模型 responder 安装门闩，当前与干净版本均复现 release 未初始化，等待门闩就绪后一行修复，双平台各 **14/14**。32 的仓库 basename 硬编码由明确命名 fixture 解决；33 另由 root 修复实际 UI 的产品门控，并加强短路径/长路径都有效的断言。

最终源码同步后（含上述五项修复），Linux `npm test` **915 项：914 通过、0 失败、1 跳过**，479.3 秒；退出码 0。`npm run typecheck` 再次通过。全量包含 test/67 图解与 test/91 迁移/重启/协作取消/冲突/回退联合检查，后者 15.9 秒通过。

清理前核实测试源码/基线目录下没有残余 Node 进程。测试服务已停用并卸载，专用 helper/policy/ops/sudoers/worker 包装入口、隔离 data/agent/control、上传源码副本及本次三份基线 tar 均已删除；核查明确路径剩余为 `[]`，活跃测试容器为 `[]`。仅清理本次明确路径，既有 `/opt/ruukoto`、现役 `/usr/local/libexec/ruukoto`、`/etc/ruukoto`、原 sudoers 与通用测试资料保留。最后日常后台仍 **MainPID=3963064、ActiveState=active**；现役 helper/policy/sudoers 的 root 属主、0700/0644/0440 权限与 2026-10-03 修改时间没有变化。

执行日志保存于 `.scratch/agent-direction/release-24-linux-logs/`。

关键可审阅日志：

- [最终 Linux 全量结尾](release-24-linux-logs/release24-linux-npm-test-final-tail.log)
- [最终类型检查](release-24-linux-logs/release24-linux-typecheck-final.log)
- [首轮失败与数字](release-24-linux-logs/release24-linux-npm-test-first-failures.log)
- [干净基线目录身份失败](release-24-linux-logs/release24-linux-identity-baseline.log)
- [修复后 Linux 目录身份两文件](release-24-linux-logs/release24-linux-identity-fixed-tail.log)
- [资源与日常 PID 清理核查](release-24-linux-logs/release24-linux-cleanup.log)
