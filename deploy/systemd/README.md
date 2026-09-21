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
# 1. 身份与目录（uid/gid 1002 被占用时给 ruukoto-exec 另选固定值，见第 5 步）
sudo useradd --system --home /var/lib/ruukoto --shell /usr/sbin/nologin ruukoto-backend
sudo useradd --system --shell /usr/sbin/nologin ruukoto-exec
sudo install -d -o ruukoto-backend -g ruukoto-backend -m 0700 /var/lib/ruukoto/{data,agent}
sudo install -d -o ruukoto-backend -g ruukoto-backend -m 0770 /var/lib/ruukoto/control

# 2. 代码与依赖（/opt/ruukoto，属主 root，后台与执行账户只读）
sudo rsync -a --delete \
  --exclude node_modules --exclude .git --exclude .scratch --exclude .DS_Store \
  ./ /opt/ruukoto/
sudo -u root sh -c 'cd /opt/ruukoto && npm ci --omit=dev'
# 宿主工作进程打包产物（完全访问包装脚本的固定入口 /opt/ruukoto/worker/worker.mjs；
# esbuild 来自 pi-coding-agent 的传递依赖，--omit=dev 也会安装）
sudo -u root sh -c 'cd /opt/ruukoto && node_modules/.bin/esbuild src/agent/tool-worker/worker.ts \
  --bundle --format=esm --platform=node --target=node24 \
  --external:@earendil-works/* --outfile=worker/worker.mjs'

# 2b. 模型配置与凭据（启动前置；缺失时后台以 no_model 启动失败）
sudo install -o ruukoto-backend -g ruukoto-backend -m 0600 \
  <拥有者的 models.json> /var/lib/ruukoto/agent/models.json
sudo install -o ruukoto-backend -g ruukoto-backend -m 0600 \
  <拥有者的 auth.json> /var/lib/ruukoto/agent/auth.json
#    默认模型 = models.json 第一个 provider 的第一个模型；目标机网络不可达的
#    provider 排前时，在单元 drop-in 显式固定（例）：
#      # /etc/systemd/system/ruukoto-backend.service.d/20-model.conf
#      [Service]
#      ExecStart=
#      ExecStart=/usr/bin/node /opt/ruukoto/node_modules/.bin/tsx /opt/ruukoto/src/cli.ts start --model <provider/model>

# 3. 工具工作进程镜像（可信身份构建；后台仅运行）
#    目标机无法访问 Docker Hub 时，先经可用镜像站拉取并打回原名，例如：
#      sudo docker pull <镜像站>/library/node:24-slim
#      sudo docker tag <镜像站>/library/node:24-slim node:24-slim
sudo bash /opt/ruukoto/deploy/worker-image/build.sh
sudo usermod -aG docker ruukoto-backend   # 容器管理权限只给可信后台

# 4. 提权启动入口（root 拥有；仅后台账户经 sudoers 调用，固定参数）
sudo install -d -m 0755 /usr/local/libexec/ruukoto
sudo install -m 0700 /opt/ruukoto/deploy/systemd/ruukoto-exec-launch.sh /usr/local/libexec/ruukoto/ruukoto-exec-launch
sudo install -m 0700 /opt/ruukoto/deploy/systemd/ruukoto-exec-stop.sh /usr/local/libexec/ruukoto/ruukoto-exec-stop
sudo install -m 0440 /opt/ruukoto/deploy/systemd/sudoers.d.ruukoto /etc/sudoers.d/ruukoto

# 5. 完全访问执行入口指向受保护包装（生产配置；单元已内置 Environment）
#    RUUKOTO_EXEC_LAUNCH_SCRIPT=/usr/local/libexec/ruukoto/ruukoto-exec-launch
#    RUUKOTO_EXEC_STOP_SCRIPT=/usr/local/libexec/ruukoto/ruukoto-exec-stop
#    不设置则直连 systemd-run（要求后台自身具备对应权限，仅用于开发/单机验证）。
#    执行账户 uid/gid 非默认 1002 时，用 drop-in 覆盖（sudoers 已 env_keep 这两个变量）：
#      # /etc/systemd/system/ruukoto-backend.service.d/10-exec-uid.conf
#      [Service]
#      Environment=RUUKOTO_EXEC_UID=<实际uid>
#      Environment=RUUKOTO_EXEC_GID=<实际gid>
#    原生 Linux 的 bind mount 不做 uid 映射（Docker Desktop macOS 会）：容器内
#    进程必须能写任务工作区。单拥有者服务器把容器 uid/gid 设为拥有者值（同一
#    drop-in 即可）：RUUKOTO_CONTAINER_UID/GID=<拥有者 uid/gid>（默认 1000 仅
#    当工作区对 uid 1000 可写时适用）。

# 6. 后台单元
sudo install -m 0644 /opt/ruukoto/deploy/systemd/ruukoto-backend.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now ruukoto-backend

# 7. 拥有者令牌（部署后生成于控制面目录；复制给拥有者 0400）
sudo install -o "$SUDO_USER" -m 0400 /var/lib/ruukoto/control/owner.token ~/.ruukoto-owner.token
#    拥有者接入控制面 socket（control/ 为 0770 ruukoto-backend:ruukoto-backend，
#    socket 0660；加入该组即可获得 socket 通道，协议层仍要求拥有者令牌）：
sudo usermod -aG ruukoto-backend "$SUDO_USER"
#    工作区位于 0750 的拥有者主目录下时，后台需要穿越权限（只给 x，不给读）：
sudo setfacl -m u:ruukoto-backend:--x "/home/$SUDO_USER"
#    拥有者使用 CLI/TUI 时（与后台不同 UID）：
#      export RUUKOTO_DATA_DIR=/var/lib/ruukoto/data
#      export RUUKOTO_OWNER_TOKEN_FILE=~/.ruukoto-owner.token
```

## 验证状态

2026-09-21 在 tx（Ubuntu 24.04，Tencent Cloud，Docker 29.5.2，systemd 255）完成
首次部署与目标机验证：systemd 单元、sudoers 提权入口（含执行账户 uid 986 经
env_keep 传递）、容器边界冒烟 9/9（容器 uid 经 RUUKOTO_CONTAINER_UID 固定为
拥有者 uid 1003）、linux:probes 32/32、真实模型 confirm 任务端到端通过
（deepseek，容器内写文件产物落宿主工作区）。发现并修复：exec-stop 包装脚本
退出码与启动器约定相反（`exec systemctl is-active` → 反转为
`! is-active --quiet`）；目标机记录见 `.scratch/personal-agent/issues/09-tx-deploy.md`
与 `docs/runtime.md` 验证状态表。
