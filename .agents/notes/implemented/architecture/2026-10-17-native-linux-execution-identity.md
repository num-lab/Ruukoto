# Agent Note: Linux 原生执行按持久身份停止重核

Status: implemented

## 问题

[个人迁移](../../proposed/architecture/2026-10-17-personal-pi-durable.md)要求后台重启后仍能证明外部进程停止；既有原生 launcher 的 scope、组观察和退出事实只存在内存。直接重放启动会产生第二份执行，单看原 PID 或单元 not-found 也不能排除迟到创建和脱组后代。

## 决定

为 Linux 受限执行增加独立持久认领 API，输入为宿主预先提交的执行引用和不可被 worker 读写的私有目录。原子认领发生在平台外调前，同 ID 永不再次启动。认领固定本机、boot、scope 和参数指纹；保存独立 launcher 的寿命身份。scope Description 带宿主随机 token；本次私有 started 标记、Description、InvocationID 与 launcher 的 `/proc` cgroup 成员关系全部匹配，才保存原单元及 cgroup dev/ino。停止先持久阻止迟到启动，核对原单元及 cgroup 身份后才发停止请求；未观察、同名占用和组重建不按名字杀进程，不向持久 PID/PGID 发信号。

停止仅向已核对 dev/ino 的目录 FD 下打开的原 `cgroup.kill` 写入，不按名字调用 systemctl kill/stop；核对后发生同名换代也不会杀到新组。退出证明同时要求原 launcher/整组已结束、曾观察的原 cgroup 为空或消失及单元静止；未派发或跨 boot 可单独证明无剩余执行。证据缺失、损坏、身份变化或查询失败一律保留未核实和现场。停止结果不是外部命令效果回执，后续 durable 仍须单独保存操作结果及未知暂停。

复用现有平台启动核实，Coding 默认路径不启用认领接点。本片在 `PreparedNativeLaunch` 下层工作，暂不改旧 worker 的 Pi 依赖发现，不新增工具、运行状态副本或操作框架。

## 既有笔记审计

按个人 durable、原生执行、停止核实、服务执行身份检索 active notes。[原生沙箱](../../implemented/architecture/2026-10-10-native-execution-sandbox.md)、[个人原生执行](../../implemented/architecture/2026-10-12-personal-native-sandbox.md)部分重叠，保持原权限和 Coding 路径；[固定检查认领](../../implemented/architecture/2026-10-17-service-inspection-identity.md)提供认领与停止先手参考，但其进程组观察不替代任意命令的 cgroup 证明。没有完全吸收或失效提案。

## 备选方案

- 原后台 PID 加固定 scope：改动最少，但后台寿命与单项 launcher 不同，且无法证明同组无关任务和迟到创建已经结束。
- 复制服务 helper 协议：已有认领与停止先手，但其 root 服务白名单和固定 show/restart 不适合通用工具；扩大 helper 会引入额外提权面。
- 直接重做全部 worker 和 durable 命令工具：可一次形成用户能力，但会把停止原语与权限、审批、产物和未知恢复耦合，难以单独验证强杀窗口。

## 验证

见[窄工单](../../../../.scratch/personal-pi-durable/issues/22-native-execution-identity.md)：至多一次启动、停止先手、坏证据保守拒绝、真实 Linux scope 脱组后代与后台强杀恢复。

## 后果

认领和外部进程不原子；派发后证据缺失可持续保守阻塞，不能以重新调用同 ID 修复。完全访问与远端 MCP 不在本证明范围。持久文件只保证进程崩溃场景，不承诺断电不丢最近写入。
