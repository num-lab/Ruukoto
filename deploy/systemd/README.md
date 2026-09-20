# ruukoto 目标服务器部署（Linux）

三个系统身份（ADR 0003 / ADR 0004）：

- **拥有者**：日常登录账户，使用可信 CLI/TUI；持有拥有者令牌（0400）的副本。
- **后台**（`ruukoto-backend`）：运行控制面，持有数据目录、模型凭据与
  `credentials.json`；可调用容器（docker 组成员）与受保护的提权启动入口。
- **执行账户**（`ruukoto-exec`，建议 uid/gid 1002）：完全访问任务的工作进程
  以该身份运行。不属于拥有者/后台的组，无权读取两者的认证材料，不能修改
  服务代码、配置或容器管理接口。

## 安装步骤

```bash
# 1. 身份与目录
sudo useradd --system --home /var/lib/ruukoto --shell /usr/sbin/nologin ruukoto-backend
sudo useradd --system --shell /usr/sbin/nologin ruukoto-exec
sudo install -d -o ruukoto-backend -g ruukoto-backend -m 0700 /var/lib/ruukoto/{data,agent}
sudo install -d -o ruukoto-backend -g ruukoto-backend -m 0770 /var/lib/ruukoto/control

# 2. 代码与依赖（/opt/ruukoto，属主 root，后台与执行账户只读）
sudo rsync -a --delete ./ /opt/ruukoto/
sudo -u root sh -c 'cd /opt/ruukoto && npm ci --omit=dev'

# 3. 工具工作进程镜像（可信身份构建；后台仅运行）
sudo bash /opt/ruukoto/deploy/worker-image/build.sh
sudo usermod -aG docker ruukoto-backend   # 容器管理权限只给可信后台

# 4. 提权启动入口（root 拥有；仅后台账户经 sudoers 调用，固定参数）
sudo install -d -m 0755 /usr/local/libexec/ruukoto
sudo install -m 0700 /opt/ruukoto/deploy/systemd/ruukoto-exec-launch.sh /usr/local/libexec/ruukoto/ruukoto-exec-launch
sudo install -m 0700 /opt/ruukoto/deploy/systemd/ruukoto-exec-stop.sh /usr/local/libexec/ruukoto/ruukoto-exec-stop
sudo install -m 0440 /opt/ruukoto/deploy/systemd/sudoers.d.ruukoto /etc/sudoers.d/ruukoto

# 5. 完全访问执行入口指向受保护包装（生产配置，后台单元 Environment）
#    RUUKOTO_EXEC_LAUNCH_SCRIPT=/usr/local/libexec/ruukoto/ruukoto-exec-launch
#    RUUKOTO_EXEC_STOP_SCRIPT=/usr/local/libexec/ruukoto/ruukoto-exec-stop
#    设置后 systemd 启动器经 sudo 调用固定参数的包装脚本；不设置则直连
#    systemd-run（要求后台自身具备对应权限，仅用于开发/单机验证）

# 6. 后台单元
sudo install -m 0644 /opt/ruukoto/deploy/systemd/ruukoto-backend.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now ruukoto-backend

# 7. 拥有者令牌（部署后生成于控制面目录；复制给拥有者 0400）
sudo install -o "$SUDO_USER" -m 0400 /var/lib/ruukoto/control/owner.token ~/,ruukoto-owner.token
```

## 验证状态

目标服务器尚未验证：systemd 单元、sudoers 提权入口、执行账户隔离与
systemd-run 路径均需在实际部署机器上验证（本仓库 macOS 与 Docker Desktop
Linux VM 的验证记录见 `docs/runtime.md` 与 `verification/foundation/results/`）。
