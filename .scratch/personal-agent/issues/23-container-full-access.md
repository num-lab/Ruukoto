Status: ready-for-agent

# 容器部署下完全访问任务总是失败

## 问题

按部署文档运行的后台（`RUUKOTO_EXECUTION_BACKEND=container`，并配置了 `RUUKOTO_EXEC_*`）无法执行完全访问任务，提交时返回 `execution_unavailable`。

- [cli.ts](../../../src/cli.ts) `server` 启动时只传 `execution: { backend: execFlag }`，不带 `systemd` 配置（`src/cli.ts:184`）。
- `createLauncherFor` 在 container + full_access 且 `config.systemd` 缺失时直接抛错（`src/agent/execution/launchers.ts:339-347`）。读取 `RUUKOTO_EXEC_LAUNCH_SCRIPT`、`RUUKOTO_EXEC_UID` 等环境变量的 `defaultSystemdConfig()` 只在检查通过后才被调用（`launchers.ts:348-351, 362-367`）。
- 因此 `deploy/systemd/ruukoto-backend.service` 设置的执行账户环境变量不生效。

## 证据

- `test/10-access-modes.test.ts:364-383` 断言缺少 systemd 配置时明确失败，这正是 CLI 传入的配置形态；没有测试覆盖「已按部署文档配置执行账户」的情形。
- `launchers.ts:11` 注释：目标服务器的 systemd 路径未实测。[09：目标服务器部署](09-tx-deploy.md) 的端到端记录只包含 confirm 任务。

## 背景：tx 实况

2026-09-26 在 `ssh tx` 上核对。以下几点说明只修配置，完全访问仍然不可用：

- **执行账户进不了工作区。** `/home/eitrous` 权限 0750，ACL 只有 `u:ruukoto-backend:--x`；`ruukoto-exec`（986）属于 other，没有任何权限。worker 的 init 会吞掉 mkdir 失败（`src/agent/tool-worker/worker.ts:302`），之后的工具调用都会 EACCES。
- **执行账户的 HOME 不存在。** `/home/ruukoto-exec` 未创建，而 systemd-run 按 passwd 把 HOME 设为它。
- **git 2.43。** 执行账户在拥有者的仓库里运行 git 会报 `dubious ownership`；`safe.directory` 不支持 `路径/*` 前缀匹配（2.46 起才支持）。
- **tx 跑的是旧代码。** 服务自 2026-09-21 10:57 起未重启，`/opt/ruukoto` 的代码、宿主 `worker/worker.mjs` 和 `ruukoto-worker` 镜像都是 09-21 版本；worker 在 2026-09-24 改过（issue 21，c094143）。实测前必须部署当前 main。
- 两个 drop-in：`10-exec-uid.conf`（`RUUKOTO_EXEC_UID/GID=986`、`RUUKOTO_CONTAINER_UID/GID=1003`）和 `20-model.conf`（`cli.ts start --model deepseek/deepseek-flash`）。当前 CLI 仍把 `start` 当作 `server` 的别名（`src/cli-entry.ts:114`）。
- 拥有者令牌 `/home/eitrous/.ruukoto-owner.token` 权限 0400。`~/ruukoto-ws/` 是 09 做 confirm 端到端验证时用的工作区。

## 实施范围

### 代码

- `createLauncherFor` 的 container + full_access 分支（`launchers.ts:338-351`）：先合并 `{ ...defaultSystemdConfig(), ...config.systemd }`。没有显式 `config.systemd`、合并结果又没有 `protectedEntry` 时，抛 `execution_unavailable`，错误信息写明需要 `RUUKOTO_EXEC_LAUNCH_SCRIPT` 和 `RUUKOTO_EXEC_STOP_SCRIPT` 两个变量。CLI 和 Runtime 不改。
- 直连 `systemd-run` 不能通过环境变量启用，仍只能由代码传入配置使用。
- tx 实测通过后，删掉 `launchers.ts:11` 和 `:221` 的「未实测」字样。

### 部署文档

- `deploy/systemd/README.md` 第 1 步：为执行账户建 home（`sudo install -d -o ruukoto-exec -g ruukoto-exec -m 0700 /home/ruukoto-exec`），并配置 git（`sudo -u ruukoto-exec -H git config --global --add safe.directory '*'`）。
- README 第 5 步（`:60`）和 `ruukoto-backend.service:14`：「不设置则直连 systemd-run」改为「不设置则完全访问不可用（提交返回 `execution_unavailable`）」。
- README 第 7 步，紧跟后台的 home ACL 之后，增加两条：
  - 执行账户的 home 穿越权限：`sudo setfacl -m u:ruukoto-exec:--x "/home/$SUDO_USER"`。
  - 每个要用完全访问的工作区：`sudo setfacl -R -m u:ruukoto-exec:rwX,d:u:ruukoto-exec:rwX,d:u:$SUDO_USER:rwX <工作区>`。

  同时说明两点：没配 ACL 的工作区在完全访问下会 EACCES；配了 home 穿越权限后，执行账户能读到 home 下所有 other 可读的内容（0400 的令牌和 0700 的 `~/.ssh` 不受影响）。
- README 的「验证状态」和 `docs/runtime.md` 的验证状态表，按 tx 实测结果更新。

### tx 部署

拥有者在 2026-09-26 的访谈中授权本工单使用部署所需的 sudo，范围仅限以下步骤，不包括读取生产数据库：

1. 停止 `ruukoto-backend`，用 `cp -a` 把 `/var/lib/ruukoto/data` 备份到 `/var/lib/ruukoto/data.bak-<日期>`。
2. 按 README 第 2 步同步当前 main、执行 `npm ci --omit=dev`、重建宿主 `worker/worker.mjs`；按第 3 步重建 worker 镜像。
3. 按 README 的新步骤补建执行账户的 home 和 git 配置。ACL 只配 home 穿越权限和 `~/ruukoto-ws`，不碰 `~/Project` 等其他目录。
4. 启动服务，两个 drop-in 保持不变。

## 已确认范围

2026-09-26 访谈，Q1–Q9 全部按推荐：

- 配置来源：在 `launchers.ts` 内读环境变量，与 `DEFAULT_CONTAINER_CONFIG` 的做法一致。不在 CLI 里组装配置，也不加显式参数。
- 环境变量只用来启用受保护入口：两个脚本变量都设置才算已配置。直连路径加上 uid 缺省为 0，不能只靠环境变量打开；只设了一个变量的情况不单独写分支。
- 工作区访问：按工作区配 ACL。不把执行账户加入拥有者的组（违反 README 的身份设计），不强制把工作区挪到 home 之外，提交时也不预检权限（后台无法替别的 uid 判断）。
- 执行账户的 HOME 补建；`safe.directory '*'` 只作用于执行账户。
- tx 上只给 `~/ruukoto-ws` 开放权限；真实项目由拥有者按 README 自行决定。
- tx 部署由本工单负责。[28](28-container-same-path-mount.md)、[29](29-context-prefix-stability.md) 如果在本工单之后落地，直接在部署后的环境里验收；如果先落地，就由先落地的那张负责部署。
- 离线测试只覆盖 `createLauncherFor`；真实的 sudo、systemd 链路靠 tx 实测。

## 验收标准

- **离线测试**：在 `test/10-access-modes.test.ts` 中，紧挨 `:365` 的 strict 用例，新增一个 `createLauncherFor` 单元测试：
  - 临时设置两个脚本变量，`{ backend: "container" }` + `full_access` 返回 `kind === "systemd"`；
  - 只设一个变量时，抛出 `execution_unavailable`，错误信息里包含两个变量名；
  - 测试结束后恢复 env。

  原有的 strict 用例不做修改，仍然通过。
- **tx 实测**：部署后，在 `~/ruukoto-ws` 提交一次完全访问任务，让模型依次执行下列操作，并在宿主上核对：
  1. `id -un` 输出 `ruukoto-exec`；
  2. 在工作区写一个文件，宿主上能看到，eitrous 能直接修改；
  3. `git status` 成功；
  4. `touch ~/probe` 成功；
  5. `cat /home/eitrous/.ruukoto-owner.token` 失败；
  6. 任务结束后，`systemctl is-active ruukoto-exec-<任务id>` 的结果不是 active。

  不测联网：tx 本身出网受限，测出来的结果说明不了问题。实测记录追加到 [09](09-tx-deploy.md) 的 Comments。
- `npm run typecheck` 与 `npm test` 通过；README、service 单元注释和 `docs/runtime.md` 同步更新。

## 关联与后续

- [ADR 0004](../../../docs/adr/0004-tool-worker-per-task-container-exec-account.md)：执行账户与拥有者、后台分离。本工单不改变这项决策，只补齐部署前提。完全访问提供的仍是执行账户自己的权限，没配 ACL 的工作区不可用。
- [28](28-container-same-path-mount.md)：执行账户本来就使用宿主路径，28 改完后两种执行方式的路径一致，本工单不需要为此额外改动。

## Comments

### 2026-09-25：创建

在技能系统访谈（[22](22-skills.md)）中顺带发现。已核对代码与 service 单元，未在目标机复现。

### 2026-09-26：访谈确认

Q1–Q9 全部按推荐；tx 上的核对记录见「背景」。

访谈中没有单独提问、按已确认的决定推导的细节（请复核）：

- 提交时只检查配置是否存在；脚本文件是否存在，仍在 launch 时检查（`launchers.ts:248-259`），不前移到提交时。
- `defaultSystemdConfig()` 中 uid 缺省为 0 不改：走受保护入口时，uid 由包装脚本通过 sudoers `env_keep` 取得，启动器的 uid 字段用不到。
- 执行账户在完全访问下新建的子仓库归 986 所有，拥有者自己的 git 会拒绝进入该子仓库。不处理。
- 执行账户的 umask 保持 systemd 默认的 0022，共享写权限靠默认 ACL 保证。
- `executionInfo()` 对 container 后端的说明，不增加完全访问是否可用的提示。
