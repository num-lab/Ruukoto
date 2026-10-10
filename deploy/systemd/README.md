# ruukoto 目标服务器部署（Linux）

三个系统身份（设计依据：[显式访问模式](../../.agents/notes/implemented/feature/2026-09-19-explicit-access-modes.md)、[工具工作进程与按任务容器](../../.agents/notes/implemented/architecture/2026-09-20-tool-worker-per-task-container.md)）：

<!-- Note: 见 .agents/notes/implemented/feature/2026-09-19-explicit-access-modes.md -->
<!-- Note: 见 .agents/notes/implemented/architecture/2026-09-20-tool-worker-per-task-container.md -->

- **拥有者**：日常登录账户，使用可信 CLI/TUI；持有拥有者令牌（0400）的副本。
- **后台**（`ruukoto-backend`）：运行控制面，持有数据目录、模型凭据与`credentials.json`；可调用容器（docker 组成员）与受保护的提权启动入口。
- **执行账户**（`ruukoto-exec`，建议 uid/gid 1002）：完全访问任务的工作进程以该身份运行。不属于拥有者/后台的组，无权读取两者的认证材料，不能修改服务代码、配置或容器管理接口。

## 安装步骤

```bash
# 1. 身份与目录（uid/gid 1002 被占用时给 ruukoto-exec 另选固定值，见第 5 步）
sudo useradd --system --home /var/lib/ruukoto --shell /usr/sbin/nologin ruukoto-backend
sudo useradd --system --home /home/ruukoto-exec --shell /usr/sbin/nologin ruukoto-exec
sudo install -d -o ruukoto-backend -g ruukoto-backend -m 0700 /var/lib/ruukoto/{data,agent,agent-work}
sudo install -d -o ruukoto-backend -g ruukoto-backend -m 0770 /var/lib/ruukoto/control
#    执行账户的 HOME（systemd-run 按 passwd 设置；npm/pip/git 需要可写 HOME），
#    并让它的 git 接受拥有者的仓库（只写入执行账户自己的全局配置；执行账户本就能
#    运行任意命令，关掉它的仓库属主检查不扩大权限）
sudo install -d -o ruukoto-exec -g ruukoto-exec -m 0700 /home/ruukoto-exec
sudo -u ruukoto-exec -H git config --global --add safe.directory '*'

# 2. 代码与依赖（/opt/ruukoto，属主 root，后台与执行账户只读）
sudo rsync -a --delete \
  --exclude node_modules --exclude .git --exclude .scratch --exclude .DS_Store \
  ./ /opt/ruukoto/
sudo -u root sh -c 'cd /opt/ruukoto && npm ci --omit=dev'
# 宿主工作进程打包产物（完全访问包装脚本的固定入口 /opt/ruukoto/worker/worker.mjs；
# esbuild 是直接运行依赖，--omit=dev 也会安装）
sudo -u root sh -c 'cd /opt/ruukoto && npm run build'

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
#      ExecStart=/usr/bin/node /opt/ruukoto/apps/ruukoto/bin/ruukoto.mjs server --model <provider/model>

# 3. 工具工作进程镜像（可信身份构建；后台仅运行）
#    目标机无法访问 Docker Hub 时，先经可用镜像站拉取并打回原名，例如：
#      sudo docker pull <镜像站>/library/node:24-slim
#      sudo docker tag <镜像站>/library/node:24-slim node:24-slim
sudo -u root sh -c 'cd /opt/ruukoto && npm run build:worker-image'
sudo usermod -aG docker ruukoto-backend   # 容器管理权限只给可信后台

# 4. 提权启动入口（root 拥有；仅后台账户经 sudoers 调用，固定参数）
sudo install -d -m 0755 /usr/local/libexec/ruukoto
sudo install -m 0700 /opt/ruukoto/deploy/systemd/ruukoto-exec-launch.sh /usr/local/libexec/ruukoto/ruukoto-exec-launch
sudo install -m 0700 /opt/ruukoto/deploy/systemd/ruukoto-exec-stop.sh /usr/local/libexec/ruukoto/ruukoto-exec-stop
sudo install -m 0440 /opt/ruukoto/deploy/systemd/sudoers.d.ruukoto /etc/sudoers.d/ruukoto

# 5. 完全访问执行入口指向受保护包装（生产配置；单元已内置 Environment）
#    RUUKOTO_EXEC_LAUNCH_SCRIPT=/usr/local/libexec/ruukoto/ruukoto-exec-launch
#    RUUKOTO_EXEC_STOP_SCRIPT=/usr/local/libexec/ruukoto/ruukoto-exec-stop
#    不设置则完全访问不可用（提交返回 execution_unavailable）。
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
#    完全访问以执行账户运行，同样需要穿越拥有者主目录，并对每个要用完全访问
#    的工作区显式授权（默认 ACL 让双方都能改对方新建的文件）。没配 ACL 的
#    工作区在完全访问下工具调用会 EACCES。穿越权限让执行账户能读到主目录下
#    other 可读的内容（0400 的拥有者令牌、0700 的 ~/.ssh 不受影响）：
sudo setfacl -m u:ruukoto-exec:--x "/home/$SUDO_USER"
sudo setfacl -R -m "u:ruukoto-exec:rwX,d:u:ruukoto-exec:rwX,d:u:$SUDO_USER:rwX" <工作区>
#    拥有者使用 CLI/TUI 时（与后台不同 UID）：
#      export RUUKOTO_DATA_DIR=/var/lib/ruukoto/data
#      export RUUKOTO_OWNER_TOKEN_FILE=~/.ruukoto-owner.token
```

## 服务器服务管理（agent-direction issue 09）

设计依据：[服务管理 helper](../../.agents/notes/implemented/architecture/2026-10-03-service-management-helper.md)。

<!-- Note: 见 .agents/notes/implemented/architecture/2026-10-03-service-management-helper.md -->

main 的 `service_inspect` / `service_manage` 只经 root 拥有的 helper 触达systemd：白名单目标、固定协议、逐次审批（full_access 也不例外）。执行账户**没有**新增的 sudo/Polkit 权限，后台的新提权能力不属于执行账户已有权限。

```bash
# 1. helper 与策略（root 拥有；后台/执行账户不可写）
sudo install -d -m 0755 /etc/ruukoto
sudo install -d -m 0700 /var/lib/ruukoto/service-ops
sudo install -m 0700 /opt/ruukoto/deploy/systemd/ruukoto-service.mjs \
  /usr/local/libexec/ruukoto/ruukoto-service
# 策略：固定本机身份、执行 UID/GID、精确单元及允许动作；默认只列测试服务。
# 由拥有者在可信部署流程修改（模型不能增删目标；修改后旧批准因修订变化失效）。
sudo install -m 0644 /dev/stdin /etc/ruukoto/services.json <<EOF
{
  "machineId": "$(cat /etc/machine-id)",
  "execUid": $(id -u ruukoto-exec),
  "execGid": $(id -g ruukoto-exec),
  "services": {
    "ruukoto-service-test.service": { "actions": ["restart"] }
  }
}
EOF

# 2. 可控测试服务（root 拥有启动程序；以执行账户运行；无网络、无业务凭据、
#    Restart=no；每次启动记 InvocationID/计数仅作辅助观察）
sudo install -m 0755 /opt/ruukoto/deploy/systemd/ruukoto-service-test.sh \
  /usr/local/libexec/ruukoto/ruukoto-service-test.sh
sudo install -m 0644 /opt/ruukoto/deploy/systemd/ruukoto-service-test.service \
  /etc/systemd/system/
sudo install -d -o ruukoto-exec -g ruukoto-exec -m 0750 /var/lib/ruukoto-service-test
sudo systemctl daemon-reload && sudo systemctl start ruukoto-service-test

# 3. 后台单元 drop-in 注入部署配置（缺一则后台拒绝启动）
#    # /etc/systemd/system/ruukoto-backend.service.d/30-service-manager.conf
#    [Service]
#    Environment=RUUKOTO_SERVICE_HELPER=/usr/local/libexec/ruukoto/ruukoto-service
#    Environment=RUUKOTO_SERVICE_POLICY=/etc/ruukoto/services.json
sudo systemctl daemon-reload && sudo systemctl restart ruukoto-backend
```

helper 协议（应答 = stderr 上唯一一条 `RUUKOTO_SERVICE_REPLY ` 前缀单行 JSON——不用fd3：sudo 默认关闭 fd ≥3（closefrom=3）导致 fd3 在生产必然断开；fd1 与 stderr 其余内容为原始 systemctl/命令输出证据，restart 路径 systemd-run --pipe 会把命令单元的stderr 混入 stderr，机器调用方按前缀行提取）：

- `inspect <unit>`：白名单内服务状态的固定字段与策略/单元定义修订指纹；systemctl show 显式降到策略执行 UID/GID（应答含实际执行身份 uid/gid）。
- `restart <hostOpId> <policyRev> <unitRev> <unit>`：原子认领（mkdir，同ID 拒绝再次启动，标记持久保留）→ 核对本机、白名单、策略与已加载单元修订（NeedDaemonReload=yes 拒绝）→ `systemd-run --pipe --wait` 短命命令单元（`ruukoto-service-op-<hostOpId>.service`，KillMode=control-group，RuntimeMaxSec=120）内以 root 执行固定的 `systemctl --system restart`（应答含实际执行身份 root 与退出码；派发后的意外失败按已启动上报，由调用方记效果未知，绝不重写为已知未执行）。

  `systemd-run` spawn 结果如实区分（agent-direction issue 10 修正，验收覆盖）：只有可证明命令根本未启动（ENOENT/EACCES/ENOTDIR）才报 `launched:false`（可信的未派发证明，调用方记已知未执行并消耗本次批准）；启动后的错误（缓冲超限等）与被信号杀死一律报 `ok:false, launched:true`（「可能已派发」，不猜退出码——调用方记效果未知、不自动重发、同目标长期授权失效）。
- `stop-op <hostOpId>`：先阻断后续启动（认领/stop-requested 标记），再停派生命令单元；只有查询确认 LoadState/ActiveState/MainPID/ControlPID 全部退出才报告 exited（权限错误、bus 不可达、查询失败都不当作已退出）。

清理演练：停止并 disable 测试服务，删除单元/启动程序/状态目录（`/var/lib/ruukoto-service-test`）、策略项与 helper 配置 drop-in。

## 验证状态

2026-09-21 在 tx（Ubuntu 24.04，Tencent Cloud，Docker 29.5.2，systemd 255）完成首次部署与目标机验证：systemd 单元、sudoers 提权入口（含执行账户 uid 986 经env_keep 传递）、容器边界冒烟 9/9（容器 uid 经 RUUKOTO_CONTAINER_UID 固定为拥有者 uid 1003）、linux:probes 32/32、真实模型 confirm 任务端到端通过（deepseek，容器内写文件产物落宿主工作区）。发现并修复：exec-stop 包装脚本退出码与启动器约定相反（`exec systemctl is-active` → 反转为`! is-active --quiet`）；目标机记录见 `.scratch/personal-agent/issues/09-tx-deploy.md`与 [docs/release-acceptance.md](../../docs/release-acceptance.md#历史验证清单) 的历史验证清单。

2026-09-26（issue 23）：修复容器后端下完全访问总是 `execution_unavailable`，重新部署当前代码后在 tx 实测一次完全访问任务：以 `ruukoto-exec` 运行、按 ACL写工作区且拥有者可改、git 接受拥有者仓库、HOME 可写、读拥有者令牌被拒、结束后执行单元回收。部署中发现并补上 `agent-work` 目录（角色工作目录，缺失时后台启动失败）。
