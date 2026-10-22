# 07 Linux CLI 验证记录

环境：2026-10-21，`ssh tx` 的普通账户 `eitrous`，UID/GID 1003，Linux，Node v24.21.0，systemd 255（255.4-1ubuntu8.15），user manager 查询为 running。只对本轮新建临时档案启动、停止后台，没有向既有 `ruukoto-backend.service` 发出 start/stop/restart。

源码位于 `/tmp/ruukoto07-lifecycle-dN9lAPzX`。基点 f36f7671904555a27883cea173493d1df16b5fbd，应用 `/tmp/ruukoto07-lifecycle.patch` 的维护实现，并应用测试等待预算增量 `/tmp/ruukoto07-lifecycle-test-budget.patch`；不包含后续根工作区的 `TimeoutStopFailureMode=terminate`、abort/kill 负例或 StringDecoder 变更。因此下述旧版本单测不能声称最终 systemd 实现已在 Linux 通过；CLI 脱离启动与同一进程身份、只读、停止/锁路径没有被这些后续改动改变。

首次在本轮临时源码中执行 `npm ci --omit=dev --ignore-scripts --no-audit --no-fund` 遇到 ENOSPC。仅删除本轮新目录中的未完成 node_modules 安装，未清理其他目录，空间由 61 MiB 恢复至约 648 MiB。随后只在新目录建立指向已有 `/tmp/ruukoto-personal-04.YNFVXZ7o` 依赖的软链；确认该来源应用级 `@earendil-works/pi-ai` 和 `@earendil-works/chord` 均为 1.3.0，tsx 为 4.23.13；workspace 包的链接指向本轮源码。未修改共享依赖来源。这证明当前代码在已有同版依赖下运行，不证明干净 Linux 安装成功。

## CLI 真进程验证

本地验证脚本：`/tmp/ruukoto07-linux-verify.mjs`；远端对应 `/tmp/ruukoto07-lifecycle-dN9lAPzX/verify-cli.mjs`。脚本以仅用于本轮的假模型凭据初始化 `/tmp/ruukoto07-lifecycle-dN9lAPzX/temporary-profile`，不提交模型输入、不连接 IM、不运行工具。`launch` 调用现有 `launchPersonalServer` 真正 detached 启动，`maintenance` 子进程使用正式 bin 的版本化 stdin/stdout 协议。`reconnect` 在另一个 SSH 进程中执行，并断言新 SSH 环境中没有原模型变量；按 PID 与 Linux boot/start 身份核实原后台仍存续。`stop` 只调用本临时档案的认证 HTTP `/stop`，随后确认原身份退出与档案锁可取，并再次通过正式 maintenance 入口核实离线只读。

依次独立执行的原命令及输出：

```sh
ssh -o BatchMode=yes -o ConnectTimeout=10 tx 'cd /tmp/ruukoto07-lifecycle-dN9lAPzX && node --import tsx verify-cli.mjs launch'
```

```json
{"phase":"launch","online":true,"writable":false,"code":"maintenance_environment_unverified","pid":507927}
```

```sh
ssh -o BatchMode=yes -o ConnectTimeout=10 tx 'cd /tmp/ruukoto07-lifecycle-dN9lAPzX && node --import tsx verify-cli.mjs reconnect'
```

```json
{"phase":"new-ssh-process","online":true,"sameOriginalProcess":true,"originalEnvironment":"unverified","writable":false}
```

```sh
ssh -o BatchMode=yes -o ConnectTimeout=10 tx 'cd /tmp/ruukoto07-lifecycle-dN9lAPzX && node --import tsx verify-cli.mjs stop'
```

```json
{"phase":"stop","online":false,"originalProcessExited":true,"lockAvailable":true,"writable":false}
```

三条命令退出码均为 0。本轮原后台 pid 507927 已确认退出；没有本轮残留后台进程。CLI 原环境未知保持只读，未尝试由新 SSH shell 自动恢复启动或改写配置。

## 修改前的窄测记录

```sh
ssh -o BatchMode=yes -o ConnectTimeout=10 tx 'cd /tmp/ruukoto07-lifecycle-dN9lAPzX && node --import tsx --test test/personal-maintenance.test.ts'
```

测试等待预算调整后，9 条均通过，0 失败、0 跳过，约 6.9 秒。涵盖机器请求/限额、CLI 原环境不伪证、开发受管只读、默认超时强杀拒绝、离线精确授权、缺 stop 授权、受控 systemd 停存启、停止超时保留后台与锁、真 serve 固定目录/信号/锁。systemd 用例使用受控替身；最后一条 serve 用例是实际 Linux 子进程。首次真实 serve 用例等待 2.5 秒过短，已增至 10 秒，并修正 finally 避免掩盖启动失败；调整后真实子进程约 3.3 秒完成该用例。

上述 9 条是根工作区后续 systemd 检查和 StringDecoder 变更之前的版本，只作为历史依据；最终组合的 Linux 单测须另记实际执行结果。

## 最终源码的 Linux 复核

随后将根工作区最终 `apps/ruukoto/src/personal-maintenance.ts`、`test/personal-maintenance.test.ts` 和 `deploy/systemd/ruukoto-backend.service` 分别通过 scp 复制到上述本轮临时源码的同名路径，包含 `TimeoutStopFailureMode=terminate`、abort/kill 负例和 StringDecoder；未安装到系统目录或改动真实服务。

再次执行上文相同 `ssh … node --import tsx --test test/personal-maintenance.test.ts` 命令，9/9 通过、0 失败、0 跳过，约 6.8 秒。真实 serve 子进程退出后档案锁可得。这里的 systemd 仍为受控替身，不升级为真实系统单元验收。

## 真实 systemd 缺口

只读检查原命令：

```sh
ssh -o BatchMode=yes -o ConnectTimeout=10 tx '/usr/bin/systemctl show ruukoto-backend.service --property=Id,LoadState,User,Group,MainPID,ActiveState,SubState,ExecStart,SendSIGKILL,NeedDaemonReload,FragmentPath,DropInPaths,EnvironmentFiles'
```

摘要：既有固定单元 active/running，User/Group=ruukoto-backend，SendSIGKILL=yes，ExecStart 是旧 `/opt/ruukoto/src/cli.ts start --model deepseek/deepseek-flash` 装配；与本轮 SSH 同账户、新 durable 固定 bin、显式档案和无超时强杀的部署前提不符。`sudo -n -l /usr/bin/systemctl start ruukoto-backend.service` 与 stop 的只读授权查询允许这两个固定命令，但不能据此接管不匹配的原服务。

未对该单元执行启停，没有部署新 unit/sudoers，没有使用其他名称的测试单元冒充固定单元验收。真实 systemd 停存启、服务环境、断线恢复仍待管理员准备合规固定部署后验收。
