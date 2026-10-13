# ruukoto 目标服务器部署（Linux）

后台、CLI/TUI 与完全访问 worker 使用实际运行账户。完全访问继承后台启动时的用户环境，具有该账户已有的文件、网络和凭据权限；内部 Ruukoto 控制变量不传给 worker。控制面仍验证拥有者令牌。受限任务使用原生沙箱，服务管理另需可选的固定 helper 与 OS 授权。

<!-- Note: 见 .agents/notes/implemented/feature/2026-10-12-full-access-current-account.md -->

## 安装步骤

以下示例把代码装在 `/opt/ruukoto`，数据装在 `/var/lib/ruukoto`，以当前既有账户运行后台。先安装 Node（最低 22.19，建议 24）、Git、Bash、coreutils、Python 3 与 dbus-user-session，并按[原生前置](../native/README.md)安装正式 bwrap/profile。后台使用宿主工具，不依赖 Docker。模板的账户、数值 UID 与 Node 绝对路径均须按实际安装值替换，不能假定 `/usr/bin/node` 是所需版本。逐步执行，任一步失败时先处理，不继续启动后台。

```bash
# 1. 数据目录与代码（不创建系统账户）
run_user=$(id -un)
run_group=$(id -gn)
run_uid=$(id -u)
node_bin=$(node -p 'process.execPath')
"$node_bin" -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major<22||(major===22&&minor<19))process.exit(1)'
sudo install -d -o "$run_user" -g "$run_group" -m 0700 /var/lib/ruukoto/{data,agent,agent-work,control}
sudo rsync -a --delete --exclude node_modules --exclude .git --exclude .scratch --exclude .DS_Store ./ /opt/ruukoto/
sudo env PATH="$(dirname "$node_bin"):/usr/local/bin:/usr/bin:/bin" sh -c 'cd /opt/ruukoto && npm ci --omit=dev && npm run build'

# 2. 模型配置与凭据（替换为实际文件路径；缺可用模型时拒绝启动）
sudo install -o "$run_user" -g "$run_group" -m 0600 <models.json> /var/lib/ruukoto/agent/models.json
sudo install -o "$run_user" -g "$run_group" -m 0600 <auth.json> /var/lib/ruukoto/agent/auth.json

# 3. user manager 开机启动并在退出登录后继续运行
sudo loginctl enable-linger "$run_user"
sudo systemctl start "user@$run_uid.service"
sudo -u "$run_user" env XDG_RUNTIME_DIR="/run/user/$run_uid" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$run_uid/bus" systemctl --user is-system-running

# 4. 后台单元：安装前替换账户占位值
python3 - "$run_user" "$run_group" "$run_uid" "$node_bin" <<'PY' | sudo tee /etc/systemd/system/ruukoto-backend.service >/dev/null
from pathlib import Path
import sys
text = Path("deploy/systemd/ruukoto-backend.service").read_text()
for name, value in zip(("RUN_USER", "RUN_GROUP", "RUN_UID", "NODE_BIN"), sys.argv[1:]):
    text = text.replace("@" + name + "@", value)
print(text, end="")
PY
sudo systemctl daemon-reload
sudo systemctl enable --now ruukoto-backend
# 单元由 systemd 设置账户 HOME；代理、SSH_AUTH_SOCK 等按需在 drop-in
# 的 Environment/EnvironmentFile 指定，worker 继承后台实际获得的环境。

# 5. 连接同一账户的后台
export RUUKOTO_DATA_DIR=/var/lib/ruukoto/data
ruukoto
```

`linger` 使该账户的 user manager 在开机后和无登录会话时继续运行；停止后台不会停止它管理的其他用户服务。受限 worker 不继承 user bus。`running` 或 `degraded` 的 manager 才能供 launcher 使用，仍需核实每个 `Delegate=yes` scope 与可写 `cgroup.kill`。正常停止和启动拒绝的检查应以服务实际账户及同样环境执行，不能用登录 shell 代替系统服务。

完全访问无需专用执行账户、启停包装、工作区 ACL 或额外 sudo 配置。账号原有的文件权限仍有效。原生临时 HOME/TMPDIR 使用宿主磁盘，没有单任务容量上限；停止核实后清理，未核实则保留现场与占用。日常入口见 [usage](../../docs/usage.md)。

## 升级与回退

先用旧版本入口停止后台并按该实例的执行单元身份核实所有旧 worker 已退出。系统服务的 `KillMode=control-group` 只覆盖该单元内进程，不能证明另一 user scope 或旧容器已退出；查询失败或停止未核实时保留占用和现场，停止版本切换。不要用全局容器清理处理旧 worker。

核实停止后备份配置、数据库、JSONL 历史、审批、产物及工作副本，保留异常占用记录。安装宿主工具与原生前置，移除启动参数、单元 drop-in 和 EnvironmentFile 中的旧 `container` / `local` 执行覆盖以及 worker 镜像、容器 UID/GID 配置，再替换检出、构建和单元。用同一原档案启动，核实档案 schema 与代码匹配，并验收受限工具、委派、调度与中断状态；档案格式规则见[操作手册](../../docs/usage.md)。

回退旧版本前也必须先停止并核实新原生单元，保留资料和待核实状态；不承诺在线无损切换或已执行操作回滚。Docker 卸载和既有 docker 组权限清理是独立运维决定，不自动执行。

## 服务器服务管理

`service_inspect` / `service_manage` 仅在个人产品、Linux 与显式 helper 配置齐备时装配。完全访问免操作审批，其他模式沿用单次批准与长期授权规则。helper 始终固定目标与修订、单次认领操作 ID，并要求已有 OS 授权；没有 helper 或 sudo 权限会明确失败，不阻碍普通完全访问执行。

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

# 3. 后台单元 drop-in（helper 与 policy 缺一拒绝启动）
# [Service]
# Environment=RUUKOTO_SERVICE_HELPER=/usr/local/libexec/ruukoto/ruukoto-service
# Environment=RUUKOTO_SERVICE_POLICY=/etc/ruukoto/services.json
# 可选 RUUKOTO_SERVICE_SUDO 指定 sudo 路径，默认 /usr/bin/sudo。
sudo systemctl daemon-reload
sudo systemctl restart ruukoto-backend
```

`inspect` 的 `systemctl show` 降到策略的非 root 检查身份，部署时填写实际启动账户 UID/GID。`restart` 在 root 的短命命令单元中执行固定 `systemctl restart`；`stop-op` 只停止该操作派生的命令单元。协议、修订与效果未知处理见 [deploy 模块](../../docs/modules/deploy.md)。命令退出码与随后服务状态分述，退出码 0 不证明业务健康，取消也不撤销已经提交给 PID 1 的重启作业。

演练清理只针对演练创建的服务、启动程序、状态目录、策略项与 helper drop-in；生产资源由拥有者核实后处理。历史平台证据见 [发布验收](../../docs/release-acceptance.md#历史验证清单)。
