# ruukoto 目标服务器部署（Linux）

后台、CLI/TUI 与完全访问 worker 使用实际登录账户。完全访问继承后台启动时的用户环境，具有该账户已有的文件、网络和凭据权限；内部 Ruukoto 控制变量不传给 worker。控制面仍验证拥有者令牌。受限任务使用容器，服务管理另需可选的固定 helper 与 OS 授权。

<!-- Note: 见 .agents/notes/implemented/feature/2026-10-12-full-access-current-account.md -->

## 安装步骤

以下示例把代码装在 `/opt/ruukoto`，数据装在 `/var/lib/ruukoto`。模板中的 `@RUN_USER@` / `@RUN_GROUP@` 在安装时替换为执行这些命令的登录账户。Node 24 与 Docker 须已安装；完全访问本身无需 Docker，容器仅用于受限任务。

```bash
# 1. 数据目录与代码（不创建系统账户）
run_user=$(id -un)
run_group=$(id -gn)
sudo install -d -o "$run_user" -g "$run_group" -m 0700 /var/lib/ruukoto/{data,agent,agent-work,control}
sudo rsync -a --delete --exclude node_modules --exclude .git --exclude .scratch --exclude .DS_Store ./ /opt/ruukoto/
sudo sh -c 'cd /opt/ruukoto && npm ci --omit=dev && npm run build'

# 2. 模型配置与凭据（替换为实际文件路径；缺可用模型时拒绝启动）
sudo install -o "$run_user" -g "$run_group" -m 0600 <models.json> /var/lib/ruukoto/agent/models.json
sudo install -o "$run_user" -g "$run_group" -m 0600 <auth.json> /var/lib/ruukoto/agent/auth.json

# 3. 受限任务的固定镜像与容器管理权限
sudo sh -c 'cd /opt/ruukoto && npm run build:worker-image'
sudo usermod -aG docker "$run_user"
# 重新登录后生效。原生 Linux bind mount 不做 UID 映射，容器 UID/GID
# 须能读写工作区；在单元 drop-in 设置 RUUKOTO_CONTAINER_UID/GID 为登录账户值。

# 4. 后台单元：安装前替换账户占位值
sed -e "s/@RUN_USER@/$run_user/g" -e "s/@RUN_GROUP@/$run_group/g" deploy/systemd/ruukoto-backend.service | sudo tee /etc/systemd/system/ruukoto-backend.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now ruukoto-backend
# 单元由 systemd 设置账户 HOME；代理、SSH_AUTH_SOCK 等按需在 drop-in
# 的 Environment/EnvironmentFile 指定，worker 继承后台实际获得的环境。

# 5. 连接同一账户的后台
export RUUKOTO_DATA_DIR=/var/lib/ruukoto/data
ruukoto
```

完全访问无需专用执行账户、启停包装、工作区 ACL 或额外 sudo 配置。账号原有的文件权限仍有效。Coding Agent 的受限原生前置见 [deploy/native](../native/README.md)，日常入口与升级见 [usage](../../docs/usage.md)。

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
