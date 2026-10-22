# ruukoto 目标服务器部署（Linux）

个人正式入口由 Pi durable 持有运行状态，CLI 只管理同一后台；完全访问使用实际运行账户已有权限。以下安装步骤用于新的个人档案，旧后台、旧档案和生产渠道的接管按“升级与回退”另行安排。Coding 的本机 TUI、控制协议和档案不随本部署更改。

<!-- Note: 见 .agents/notes/implemented/simplification/2026-10-18-personal-product-entry.md -->

## 安装步骤

以下示例把完整 workspace 装在 `/opt/ruukoto`，新个人档案放在 `/var/lib/ruukoto/personal-durable`，以既有普通账户运行。先准备 Node ≥22.19、Git、Bash、coreutils、Python 3、dbus-user-session；Linux 命令能力另需[原生前置](../native/README.md)。模板账户、UID 和 Node 路径按实际值替换。已有同名单元、代码目录或目标档案时先核对归属，不覆盖运行中的部署。逐步执行，任一步失败先处理，不继续启动后台。

```bash
# 1. 新档案与完整workspace；确认目标未被旧资料占用
run_user=$(id -un)
run_group=$(id -gn)
run_uid=$(id -u)
node_bin=$(node -p 'process.execPath')
"$node_bin" -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major<22||(major===22&&minor<19))process.exit(1)'
test ! -e /var/lib/ruukoto/personal-durable
sudo install -d -o "$run_user" -g "$run_group" -m 0700 /var/lib/ruukoto/personal-durable
sudo rsync -a --delete --exclude node_modules --exclude .git --exclude .scratch --exclude .DS_Store ./ /opt/ruukoto/
sudo env PATH="$(dirname "$node_bin"):/usr/local/bin:/usr/bin:/bin" sh -c 'cd /opt/ruukoto && npm ci --omit=dev && npm run build'

# 2. 在运行账户的终端配置新实例；密钥由该终端的环境提供
RUUKOTO_PERSONAL_DIR=/var/lib/ruukoto/personal-durable \
  "$node_bin" /opt/ruukoto/apps/ruukoto/bin/ruukoto.mjs
# 在菜单配置模型、专用测试IM、资料及服务；完成后从菜单停止后台。

# 3. user manager：命令scope在开机和退出登录后仍需可用
sudo loginctl enable-linger "$run_user"
sudo systemctl start "user@$run_uid.service"
sudo -u "$run_user" env XDG_RUNTIME_DIR="/run/user/$run_uid" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$run_uid/bus" systemctl --user is-system-running

# 4. 安装模板前替换实际账户和Node路径
python3 - "$run_user" "$run_group" "$run_uid" "$node_bin" <<'PYCODE' | sudo tee /etc/systemd/system/ruukoto-backend.service >/dev/null
from pathlib import Path
import sys
text = Path("deploy/systemd/ruukoto-backend.service").read_text()
for name, value in zip(("RUN_USER", "RUN_GROUP", "RUN_UID", "NODE_BIN"), sys.argv[1:]):
    text = text.replace("@" + name + "@", value)
print(text, end="")
PYCODE
```

模型和已配对 IM 的凭据环境变量名由菜单保存，systemd 不继承交互 shell。启动前用 root 保护的 `EnvironmentFile` 或既有秘密管理方式向后台注入相同变量；文件只保存变量赋值，不能包含 shell 命令，不将秘密值写进单元、命令参数或仓库。配置文件与令牌不从旧 `agent/` 复制。需要代理或 SSH agent 时同样显式提供后台环境。以服务实际账户及同样环境核实命令 scope 和停止路径，登录 shell 成功不替代系统服务前提。

新安装与专用测试入口准备完成后，安装者可以执行：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ruukoto-backend
# 日常管理：连接同一新档案的本机菜单
RUUKOTO_PERSONAL_DIR=/var/lib/ruukoto/personal-durable \
  "$node_bin" /opt/ruukoto/apps/ruukoto/bin/ruukoto.mjs
```

`serve --directory /var/lib/ruukoto/personal-durable` 是模板的前台入口，显式绝对路径优先于环境；SIGTERM/SIGINT/SIGHUP 收齐接口与 Harness 后退出。菜单可查询、停止后台；日常菜单退出不停止独立后台。档案使用独立 SQLite、0700 目录、0600 配置/日志/令牌和认证 socket，不使用旧 `RUUKOTO_DATA_DIR/AGENT_DIR/CONTROL_DIR` 或旧 owner token。worker 和依赖由完整 workspace 构建提供，单独 app tarball 不能替代安装。

## 桌面设置维护

桌面「PA 远程连接 → 设置管理」使用同一 SSH/服务账户，选择新档案及已安装程序。固定系统服务必须采用上面的 Node/bin 与 `serve --directory` 入口、`Type=simple`、`SendSIGKILL=no`、`TimeoutStopFailureMode=terminate`、`KillMode=control-group`、`KillSignal=SIGTERM`，不配置额外 ExecStop/ExecStopPost；修改后先由管理员 daemon-reload。超时保留后台与锁，不改保存、不强杀；`TimeoutStopFailureMode=abort` 即使禁用 SIGKILL 仍不受支持。

管理员按实际同账户替换并检查独立的精确授权文件：

```bash
sed "s/@RUN_USER@/$run_user/g" deploy/systemd/sudoers.d.ruukoto-settings > /tmp/ruukoto-settings.sudoers
sudo visudo -cf /tmp/ruukoto-settings.sudoers
sudo install -o root -g root -m 0440 /tmp/ruukoto-settings.sudoers /etc/sudoers.d/ruukoto-settings
sudo -n -l /usr/bin/systemctl start ruukoto-backend.service
sudo -n -l /usr/bin/systemctl stop ruukoto-backend.service
```

只授权上述固定单元的精确 start/stop，不加通配符、其他参数或自由命令；现有 `ruukoto-service` helper 继续拒绝后台自身。GUI 不安装权限或修改单元，缺前提显示只读。先在隔离部署验证，不能为验收接管旧生产同名单元。模型/IM 变量仍由原服务环境管理，维护不读取或复制 EnvironmentFile。

`ruukoto maintenance` 的 stdin 为 `{v:1,op:"inspect",lifecycle:"systemd",program:"/opt/ruukoto/apps/ruukoto/bin/ruukoto.mjs"}`；stdout 沿 settings 的产品/版本/错误封装。先读取原 `profile`，显式 stop/start 必须带回同一身份；不提供任意服务动作。CLI 原启动环境无法核实时只读，可按本节配置受支持系统服务；受管开发实例由开发入口管理。停存启丢答后先查询原配置/服务，原服务已停止时才显式恢复；不会自动重发保存或回滚。

## 升级与回退

旧个人装配升级至 durable 是一次空白实例接管：先以旧版本停止 scheduler/outbox、IM、后台与独立执行单元，停用旧单元自动重启，再核实所有原身份退出。`KillMode=control-group` 只覆盖后台单元内进程，不能证明另一 user scope 已退出；停止未核实时保留占用与现场并停止切换。

原地保留旧档案、代码/依赖版本与受保护的一致备份和清单，不移动、覆盖或删除已提交会话；不能为查阅归档启动会恢复任务和外发的旧后台。新实例使用 `/var/lib/ruukoto/personal-durable` 等独立空白目录，重新配置模型、凭据、平台绑定与服务。旧历史、记忆、应用数据、日程、审批和在途工作均不导入，旧控制协议、开发会话、工作流和 GitHub 自动评审不接入。

生产接管另行完成最终验收：核实旧接收者和发送者停止，登记平台水位及配对边界，过滤旧积压与重投；暂停窗口中未受理委托由拥有者重新提交。不要仅凭新入口构建或隔离验证通过启用生产 bot、账号或服务。durable 后续升级同样先停并核实原执行，保留完整档案与未知效果；未知版本明确拒绝，不手改格式或记录。

回退先停用并核实新实例和独立执行，原 durable 与旧档案都继续归档。只回退代码，旧版本也使用另一个空白档案并重新配置、重设平台边界；不能恢复旧备份执行其中已有入站、发送与计划。外部已执行操作不回滚，两端不同时消费同一平台。Coding 安装与升级独立，保留其原 schema、JSONL 与客户端流程。

## 服务器服务管理

个人在 Linux 停机菜单中保存 helper、策略与 sudo 的绝对路径后装配服务能力；模型不能改这些路径。主/子固定检查、子工作 restart 与独立宿主操作由 durable 保存原身份、权限和回执。完全访问免操作审批，其他模式沿原 IM 的单次批准或精确长期授权；没有 helper 或 sudo 权限明确失败，不降级任意 root 执行。

```bash
# 1. root 拥有的固定 helper、策略与标记目录
sudo install -d -m 0755 /etc/ruukoto /usr/local/libexec/ruukoto
sudo install -d -m 0700 /var/lib/ruukoto/service-ops
sudo install -m 0700 deploy/systemd/ruukoto-service.mjs /usr/local/libexec/ruukoto/ruukoto-service
sudo install -m 0644 /dev/stdin /etc/ruukoto/services.json <<JSON
{
  "machineId": "$(cat /etc/machine-id)",
  "inspectUid": $(id -u),
  "inspectGid": $(id -g),
  "services": { "ruukoto-service-test.service": { "actions": ["restart"] } }
}
JSON
# sudoers 只授权登录账户调用固定 helper；用 visudo 核实替换后的文件。
sed "s/@RUN_USER@/$(id -un)/g" deploy/systemd/sudoers.d.ruukoto | sudo tee /etc/sudoers.d/ruukoto >/dev/null
sudo chmod 0440 /etc/sudoers.d/ruukoto
sudo visudo -cf /etc/sudoers.d/ruukoto

# 2. 可控测试服务（当前账户，无网络、无业务凭据、Restart=no）
sudo install -m 0755 deploy/systemd/ruukoto-service-test.sh /usr/local/libexec/ruukoto/ruukoto-service-test.sh
sed -e "s/@RUN_USER@/$(id -un)/g" -e "s/@RUN_GROUP@/$(id -gn)/g" deploy/systemd/ruukoto-service-test.service | sudo tee /etc/systemd/system/ruukoto-service-test.service >/dev/null
sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 0750 /var/lib/ruukoto-service-test
sudo systemctl daemon-reload
sudo systemctl start ruukoto-service-test

# 3. 停止后台后，在同一新档案的菜单配置服务路径
# helper: /usr/local/libexec/ruukoto/ruukoto-service
# policy: /etc/ruukoto/services.json
# sudo: /usr/bin/sudo
# 保存后重新启动；service配置不安装或重启服务。

```

`inspect` 的 `systemctl show` 降到策略的非 root 检查身份，部署时填写实际启动账户 UID/GID。`restart` 在 root 的短命命令单元中执行固定 `systemctl restart`；`stop-op` 只停止该操作派生的命令单元。协议、修订与效果未知处理见 [deploy 模块](../../docs/modules/deploy.md)。命令退出码与随后服务状态分述，退出码 0 不证明业务健康，取消也不撤销已经提交给 PID 1 的重启作业。

`inspect-op` / `stop-inspect` 为个人 durable 的固定检查提供持久身份协议。它要求调用侧预存机器与检查归属，并为检查创建独立进程组；允许 sudo 监护与 helper 同组。升级 helper 不会自动启用该能力，也不扩大 sudoers 的固定路径授权。

演练清理只针对演练创建的服务、启动程序、状态目录、策略项与 helper drop-in；生产资源由拥有者核实后处理。历史平台证据见 [发布验收](../../docs/release-acceptance.md#历史验证清单)。
