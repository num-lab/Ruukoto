Status: ready-for-agent
Depends on: 03

# tx 服务器部署

## 目标

按 `deploy/systemd/README.md` 在 tx 服务器（`ssh tx`，Ubuntu 24.04，Tencent Cloud）完成首次生产部署：三个系统身份、固定工具镜像、受保护提权入口、`ruukoto-backend.service` 常驻运行，并完成目标机验证（docs/runtime.md 验证状态表中"目标 Linux 服务器"行）。

## 目标机实况（2026-09-21 探查）

- Ubuntu 24.04.4，systemd 255，Docker 29.5.2（eitrous 在 docker 组），sudo 免密。
- 无 node/npm；nodejs.org 与 registry.npmjs.org 可达；**Docker Hub 不可达**（超时，需走镜像站）。
- uid 1002 已被 `lighthouse` 占用 → `ruukoto-exec` 改用 uid/gid 986（空闲），经 systemd drop-in + sudoers `env_keep` 传递给 root 拥有的包装脚本。
- 无 /opt/ruukoto、/var/lib/ruukoto，无 ruukoto-* 账户。

## 实施范围

- 宿主安装 Node 24（nodejs.org 官方 tarball → /usr/local，软链 /usr/bin/node 供单元与包装脚本使用）。
- 按 README 建身份与目录；rsync 代码（排除 node_modules/.git/.scratch）→ `npm ci`（完整装后以 `--omit=dev` 剪枝，先取 esbuild 打宿主 worker.mjs）。
- 宿主 worker.mjs：README 原步骤缺失（完全访问包装脚本的 `RUUKOTO_WORKER_PATH` 默认指向 /opt/ruukoto/worker/worker.mjs），补上构建步骤。
- 工具镜像：Docker Hub 不可达，先经镜像站拉 `node:24-slim` 再打 tag；按 worker-image README 恢复 Dockerfile 中 git 安装段。
- sudoers 增加 `env_keep`（uid/gid 非 1002 的部署需要）；单元增加提权入口 Environment；tx 上以 drop-in 固定 986。
- 部署后验证：控制面连通（status）、`npm run linux:probes`、容器启动器冒烟、full_access 提权链路（sudo→包装→systemd-run→worker 启动/停止）。
- 模型凭据（models.json/auth.json）属拥有者数据，不在本工单；真实模型短任务留待凭据就位后执行。

## 交付与验证

- `systemctl is-active ruukoto-backend` 为 active；owner.token 已复制给拥有者（0400）；CLI 经 `RUUKOTO_OWNER_TOKEN_FILE` 连通控制面。
- linux:probes 32 项与容器冒烟 9 项在 tx 通过；提权链路手动冒烟通过。
- 同步更新 `deploy/systemd/README.md`（缺失步骤与 tx 实况）与 `docs/runtime.md` 验证状态表。

## Comments

- 2026-09-21：AGENTS.md 要求计划与执行使用 `ponytail` skill，但当前环境未安装该 skill（已核对技能清单与 ~/.agents/skills），按 issue-tracker/triage 约定以本文件跟踪。
- 2026-09-21 部署完成（tx，Ubuntu 24.04.4，Docker 29.5.2，systemd 255，Node v24.21.0 装于 /usr/local 并软链 /usr/bin/node）。过程与偏差记录：
  - **uid 分配**：`ruukoto-backend` uid 999；`ruukoto-exec` uid/gid 986（1002 被 lighthouse 占用）。uid/gid 经 drop-in `10-exec-uid.conf` + sudoers `env_keep` 传入 root 包装脚本（sudo 默认清环境）。
  - **Docker Hub 不可达**：经 `mirror.ccs.tencentyun.com` 拉 `node:24-slim` 与 `python:3.13-slim` 并 tag 回原名；镜像按 worker-image README 恢复了 git 安装段（容器内 apt 可达），产物 `ruukoto-worker:0.85.1`(+latest)。
  - **修复 exec-stop 退出码反转**：原 `exec systemctl is-active` 使停止成功时返回非零，与启动器"退出码 0 = 已不在活动"约定相反；已改为 `! is-active --quiet` 语义并在 tx 验证（活动单元停止 rc=0、幂等 rc=0、注入参数 rc=64）。
  - **full_access 提权链路验证**：worker 经 sudo→包装→systemd-run 以 ruukoto-exec(986) 运行并握手 ready；ruukoto-exec 无 sudo 权限调用被拒。
  - **模型配置是启动前置**：缺失时后台以 `no_model` 崩溃重启循环（README 已补 2b 步）。凭据从拥有者开发机 ~/.pi/agent 复制（内容未落地展示），0600 ruukoto-backend。
  - **agentrouter.org 从 tx 不可达**（deepseek 可达）：经 drop-in `20-model.conf` 固定 `--model deepseek/deepseek-flash`。
  - **原生 Linux bind mount 无 uid 映射**（Docker Desktop macOS 代管，掩盖了两处）：① 容器 uid 1000 写不了拥有者工作区 → drop-in 固定 `RUUKOTO_CONTAINER_UID/GID=1003`（拥有者 uid），冒烟脚本同步改为按配置 uid 断言；② run-probes 工作区对 uid 1000 不可写、且 plain(root) 先建的探针文件挡住 restricted(uid 1000) 同名 touch → 工作区 chmod 0777 + 探针文件按变体分名。
  - **拥有者接入**：eitrous 加入 ruukoto-backend 组（socket 通道；协议层仍要令牌）；`/home/eitrous`（0750）经 `setfacl -m u:ruukoto-backend:--x` 给后台穿越权限（realpath 工作区所需，不给读）；令牌副本 `~/.ruukoto-owner.token` 0400；`~/.ruukoto/env` + .bashrc 标记段提供 RUUKOTO_DATA_DIR/RUUKOTO_OWNER_TOKEN_FILE 与 `ruukoto` 函数。
  - **验证结果**：容器冒烟 9/9（uid 1003）；linux:probes 32/32（报告存 `verification/foundation/results/linux-isolation-report-tx.{json,md}`）；CLI 控制面连通（status/create-project/create-session）；真实模型 confirm 任务端到端 completed（deepseek-flash，容器内创建 `e2e.txt` 落宿主工作区）；`create-session` 实测按项目 **id** 解析（文档示例的 `my-project` 易误读为名称）。
  - **待办/遗留**：TUI 真机交互与重连未在 tx 人工跑；full_access 模式未跑真实任务（仅链路冒烟）；agentrouter 类境外 provider 在 tx 网络下不可用。
- 2026-09-21 离线套件：逐文件顺序执行 17/17 通过（125 项，0 失败）。首次并行双跑（超时残留进程未死）互相拖慢并卡在 15-tui-pty；定位出该文件经 `npx` 垫片启动后台、杀垫片后孙进程持有管道使文件级挂起（macOS 上未暴露），已修复为 detached 进程组 + 整组 SIGKILL + 管道销毁，tx 与 macOS 双端回归通过。
- 2026-09-26 重新部署（[23](23-container-full-access.md)）：停服务，备份数据目录到 `/var/lib/ruukoto/data.bak-20260926`，同步当前代码，`npm ci --omit=dev`，重建宿主 `worker.mjs` 和 `ruukoto-worker` 镜像（021f8a977526），两个 drop-in 不变。启动时后台因缺少 `/var/lib/ruukoto/agent-work`（daily-agent 角色工作目录，其父目录 `/var/lib/ruukoto` 属 root）而 EACCES，崩溃重启了 8 次；补建该目录（0700 ruukoto-backend）后恢复，README 第 1 步已补上。上面遗留的「full_access 模式未跑真实任务」已由 23 的实测覆盖：任务 `task_d61c25acbacbd39bc0759d39`（完全访问，deepseek-flash）以 ruukoto-exec 运行，按 ACL 写入 `~/ruukoto-ws` 且拥有者可改，git 接受拥有者的仓库，HOME 可写，读拥有者令牌被拒，结束后执行单元 inactive，6 项全部通过。
