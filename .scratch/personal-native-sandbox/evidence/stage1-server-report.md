# Linux 常驻原生执行：第一阶段报告

阶段出口通过。真实系统服务、实际账户与隔离 VM 的内核重启证据分列如下；模型和通知渠道均为受控替身。此阶段使用既有 native 库入口，不声称个人正式入口已经完成后端切换。在线个人实例未切换、未重启，最后核实 PID 3963064 仍为 active。

## 环境与来源

服务器为 `ssh tx`：Ubuntu 24.04.4 LTS、Linux 6.8.0-117-generic、systemd 255、Node `/usr/local/bin/node` v24.21.0、cgroup v2。验证账户 `ruukoto-native-check` 为 UID 996 / GID 985，独立源快照位于 `/tmp/ruukoto-native-stage1-20261012/repo`；源自基点 `c4ed540280233ee38e49dfe16bcea825004349c5`，测试新增文件随后独立复制。第三方依赖以只读 bind 复用，`@ruukoto` 的相对链接只指向隔离源码；实际解析结果为该路径下的 `packages/runtime/src/runtime.ts`。

隔离 VM 使用[Ubuntu 官方最小镜像](https://cloud-images.ubuntu.com/minimal/releases/noble/release/) `ubuntu-24.04-minimal-cloudimg-amd64.img`，SHA-256 为 `2f119f50bf29fe40e73b69ae2a736e8210d8146796f036e0324315b6b3a777df`，与下载的官方 SHA256SUMS 一致。来宾为 Ubuntu 24.04.5、Linux 6.8.0-146-generic、systemd 255，服务账户 UID 999 / GID 991。最终 QEMU TCG 配置为 2 vCPU、768 MiB 来宾内存，宿主 QEMU 单元限制为 CPUQuota=200% / MemoryMax=1536M；tx 本机没有重启。依赖复制到来宾 ext4，锁版本和 SDK 未改，仅未复制其他架构的 esbuild 二进制。

两个环境均使用正式 `/usr/bin/bwrap` 与按路径 AppArmor profile，保持 `kernel.apparmor_restrict_unprivileged_userns=1`，未设置 bwrap setuid。VM 内没有 Docker。完整元数据见[VM 元数据](stage1-vm-metadata.log.gz)，账户、运行时环境和后代证据见下面原始记录。

## 真实结果

| 验证 | 结果与原始证据 |
| --- | --- |
| 指定账户的系统服务，无登录冷启动 | UID 996 的 `service-start` 记录 `State=lingering`、空 `Sessions`、`Linger=yes`，进程位于 `/system.slice/ruukoto-native-stage1.service`，user runtime dir 与 bus 均为 `/run/user/996`；[记录](stage1-tx-results.jsonl) |
| 正式 SDK worker 与真实边界 | 以该系统服务账户运行 smoke-26-native-worker，10/10 通过，含四工具、工具链、文件/网络/环境/FD 边界、授予收窄及硬链接拒绝；[journal](stage1-tx-journal.log) |
| 完整原生探针 | 同账户、同 user bus 环境的独立系统服务运行正式 bwrap 探针，54 pass、0 fail、0 unavailable；[JSON](stage1-tx-native-probes.json)、[表格](stage1-tx-native-probes.md) |
| 正常停止、脱离组后代、启动中取消 | SDK bash 创建 `setsid` 后代，自报 PGID 等于其 PID、持续写心跳；停止返回 true 后心跳冻结，已登记的 scope cgroup 为空/移除。真实单元创建后、宿主接手前取消也返回 true；[记录](stage1-tx-results.jsonl) |
| 无登录定时运行 | 02:52:39 UTC 的 `scheduled-report` 核实独立定时根任务、修改委派的真实 SubAgent、成功 write 操作、实际 boot ID 文件内容和占用清零，报告时 `Sessions` 为空；[记录](stage1-tx-results.jsonl) |
| 退出登录后定时运行 | 02:55:41 服务启动时 `Sessions=253867`，真实 SSH 会话于 02:55:51 退出；02:56:16 以同服务 PID 完成真实定时委派，核实成功操作和文件，`State=lingering`、空 `Sessions`；[登录记录](stage1-tx-logout.log)、[运行记录](stage1-tx-results.jsonl) |
| 后台被 SIGKILL 与自动重启 | `systemctl kill --signal=SIGKILL --kill-whom=main ruukoto-native-stage1.service`。旧 scope `ruukoto-native-140aa799-e222-49fc-930e-4dc26ae5e78c.scope` 从 active 转 not-found/inactive；心跳 802→804 后稳定 804。恢复后任务为 `interrupted/backend_restart`，任务与 bash 操作均 `effectUnknown=true`，保留原目录占用，原会话暂停 `occupancy_unverified`，未重放；[任务](stage1-tx-recovery.json)、[SQLite](stage1-tx-occupancy.json.gz)、[journal](stage1-tx-journal.log) |
| 缺 user runtime/user manager | 在独立系统服务中使用不存在的 runtime dir 与 bus，拒绝为 `execution_unavailable/policy_missing`，停止核实 true；[journal](stage1-tx-journal.log) |
| 缺 cgroup 委派 | 新账户 UID 995 的独立 `user@995.service` 设 `Delegate=no`，systemd 因 `init.scope` 创建权限被拒而无法启动 manager。同账户的独立系统服务运行原 launcher，拒绝为 `execution_unavailable/policy_missing`，停止返回 true；没有 native scope 或 UID 995 残留 PID，没有回退。记录后仅清理该新账户、单元 drop-in 和临时资料，UID 996 及在线实例保持运行；[原始记录](stage1-tx-no-delegate.log) |
| 缺 bwrap/profile | 只在隔离 VM 临时移走正式二进制或卸载并移走 profile，得到 `execution_unavailable/binary_missing` 或 `policy_missing`；随后恢复原文件和 profile，整机 userns 加固仍为 1；[记录](stage1-vm-prerequisite-refusals.log)、[脚本](vm-negative-prerequisites.sh) |
| 真正重启后的无人登录自动原生单元 | 校准后的冷启动 boot ID 为 `598d51e4-00c0-4a91-86a2-3b29b83191b0`，自动 oneshot 成功。来宾内执行 `sudo reboot` 后变为 `ba2237e4-e5d9-4eae-8213-0d41032d106a`；04:04:03 自动 Starting、04:04:47 pass、04:04:48 Finished/exit 0。服务与 worker 均 UID 999，worker 原文 `uid=999 gid=991 groups=991`，`Linger=yes`、空 `Sessions`；真实 write/bash、user bus 不进入 worker、已知 scope 的 cgroupEmpty 均通过。worker-ready 30 秒与 namespace marker 10 秒均未改；[结果](stage1-vm-reboot-results.jsonl)、[journal](stage1-vm-journal.log)、[原始源码](reboot-worker.mts) |

## 保留的失败与未充分结果

02:45、02:49 的首次定时通知只有根任务结果，委派缺少分析对象，不能作为 native 子任务通过证据。它们保留在原始 JSONL 中。修正为明确的修改委派后，增加子任务、成功操作、文件和占用断言，以 02:52:39 和 02:56:16 的结果为准。

最初仅更换 DBUS_SESSION_BUS_ADDRESS 的反例仍能启动，因为 user systemd 使用了有效 XDG runtime dir。该尝试记为失败反例设计；同时更换 runtime dir 后获得实际拒绝。

1 vCPU / 宿主 QEMU 1 GiB 限制的 TCG 中，完整 Runtime 的静态导入、并发初始化和首次自动 worker 有失败，分别为 `worker_failed` 或 `sandbox_rejected`；当时原始错误在 Host 映射中被遮掉，SDK stderr 未提供文本，停止后的 exit 记录为 SIGKILL 或 code 0，不能据此认定 CPU 为根因。原 journal 保留；同一来宾后续手动通过不记为自动启动通过。宿主 QEMU 出现约 365 MiB swap 压力，随后调整验证环境资源，并停止并发完整 Runtime 验证。最终使用独立最小 worker 包装证明冷启动与真正 reboot 自动运行，未将它与 tx 的 Runtime/调度证据混称为同一脚本。共享 Host 的 typed cause 修复和对应测试由主代理另外记录。

真实 QQ/Telegram 外发、真实模型、生产切换未测；模型与通知渠道替身不能证明这些外部平台。缺 cgroup 委派的真实负例命中 manager 不可用；没有另建“manager 仍可用但 scope 委派失败或 cgroup.kill 不可写”及 cgroup v1 的真实环境，这些具体拒绝分支另由共享定向测试覆盖。

## 复跑步骤与保留资源

以独立空档案和独立系统服务运行[服务 smoke](../../../verification/smoke/smoke-27-native-service.mts)。脚本拒绝已有且未标记的非空目录；每次服务启动的 direct proof 使用独立目录，保留的异常占用不会被替代执行绕过。后台与工具 worker 使用已有 launcher/Runtime，未增加第二套执行或审批框架。

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin ruukoto-native-check
sudo loginctl enable-linger ruukoto-native-check
run_uid=$(id -u ruukoto-native-check)
sudo systemd-run --unit=ruukoto-native-isolated \
  --property=User=ruukoto-native-check --property=Group=ruukoto-native-check \
  --property=WorkingDirectory=<隔离检出绝对路径> \
  --property=Environment=PATH=/usr/local/bin:/usr/bin:/bin \
  --property=Environment=XDG_RUNTIME_DIR=/run/user/$run_uid \
  --property=Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$run_uid/bus \
  --property=Requires=user@$run_uid.service --property=After=user@$run_uid.service \
  --property=Restart=on-failure --property=RestartSec=3 --property=KillMode=control-group \
  -- /usr/local/bin/node --import tsx verification/smoke/smoke-27-native-service.mts service <独立空档案绝对路径>
```

服务模式自动创建一次真实时钟定时计划。`heartbeat <档案>` 提交持续写入任务，`cancel <档案>` 验证正常取消，`status <档案>` 查询恢复后的原任务。强杀前记录当前 scope/cgroup 和心跳大小，强杀后同时核实后代与 SQLite 状态，不能只读 backend PID。`prerequisite <独立空档案>` 用于故意缺前置的服务环境。

VM 的初始材料为[cloud-init](vm-cloud-init.yml)与[初始服务安装脚本](vm-install-service.sh)，一次性公钥须替换成复跑者新生成的公钥。最终自动重启验证使用[最小 worker 安装脚本](vm-install-reboot-worker.sh)与 `reboot-worker.mts`，Node/源码/依赖均在 `/opt/ruukoto`；只在可销毁 VM 内运行负例脚本。QEMU 使用官方镜像的独立 qcow2 overlay，virtio 网络仅将 SSH 转发到宿主 `127.0.0.1:22276`，只读 9p export 设置 `multidevs=remap`；最终运行依赖位于来宾 ext4。内核 reboot 必须发生在来宾，比较前后 boot ID，并查询 enabled oneshot 的自动运行记录，不能以重启 backend service 代替。

本阶段没有修改 tx 在线单元、生产档案、既有 Docker/组权限或整机 sysctl。为隔离 VM 安装的 QEMU 工具、新验证账户、linger、只读依赖挂载与源快照均按本次唯一目录识别；后续阶段仍需复用 UID 996 与依赖，因此由最终验证统一清理。VM 证据复制后停止来宾和 QEMU，释放 VM 内存与 overlay；不可删除待核实的 worker 临时现场来掩盖占用。

脚本 `tsc`、定向 ESLint、shell `sh -n`、`git diff --check` 通过；部署 README 的文档检查通过，替换账户/UID/实际 Node 路径后的后台模板经 tx `systemd-analyze verify` 通过。未运行全量仓库检查。
