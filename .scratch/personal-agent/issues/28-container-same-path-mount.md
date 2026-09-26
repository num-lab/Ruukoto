Status: ready-for-agent
Depends on: 03, 21

# 容器按宿主原路径挂载工作区与授予路径

## 目标

受限模式下，工具看到的路径与宿主一致：系统提示里的 cwd、拥有者给出的绝对路径、`request_file_access` 用的宿主路径，在容器内外都能直接使用。

## 背景

2026-09-26 核对：

- 系统提示末尾的 `Current working directory:` 由 pi 按 `session.cwdReal`（宿主路径）生成（`src/agent/session-factory.ts:96`）。
- 容器启动器把工作区挂到 `/workspace` 并设为工作目录（`src/agent/execution/launchers.ts:65, 181-184`），工作进程的初始 cwd 在容器模式下也取 `/workspace`（`src/agent/tool-worker/host.ts:105`）；授予路径挂到 `/granted/<i>`（`launchers.ts:188-191`），模型不知道这个映射。
- 宿主不转换工具参数（`src/agent/tool-router.ts:311` 原样交给工作进程），pi 对绝对路径原样使用（`node_modules/@earendil-works/pi-coding-agent/dist/utils/paths.js:82-86`），所以模型写宿主绝对路径会 ENOENT。`request_file_access` 则在宿主解析路径（`src/agent/tool-router.ts:443-470`），要求的是宿主路径。
- tx 生产使用容器后端（`RUUKOTO_EXECUTION_BACKEND=container`）；完全访问在容器部署下目前总是失败（[23](23-container-full-access.md)），所以 tx 上的编码工具调用都在容器内执行。
- 在 tx 上用启动器同款参数（`--user 1002:1002`、`--cap-drop ALL`、`no-new-privileges`、`--read-only`、tmpfs `/tmp`、`--network none`）验证了 `-v X:X -w X`：`/tmp` 下的嵌套路径与不存在的深层路径都能挂载、可写，根文件系统仍然只读，写入对宿主可见。
- 顺带发现：`assertGrantNotProtected`（`src/agent/execution/approved-ops.ts:78-88`）判断祖先时用的是 `resolved + path.sep`，遇到 `/` 会变成 `//`，于是 `/` 被放行（脚本验证：`/` 放行，`/var` 拒绝）。工作区创建（`src/runtime/runtime.ts:1016`）与授予路径（`:1421`）都经过这个函数。

## 实施范围

- 容器启动器：工作区 `-v <ws>:<ws>`、`-w <ws>`；授予路径 `-v <p>:<p>[:ro]`，只读属性不变。删除 `CONTAINER_WORKSPACE`（连同 `src/agent/tool-router.ts:35` 的未使用导入），`ToolWorkerHost` 对所有启动器都以 `spec.workspace` 作为工作进程的初始 cwd。
- `assertGrantNotProtected` 把 `/` 视为所有保护根的祖先，予以拒绝；只在这个共享函数里修一次。
- `docs/runtime.md`「执行边界」写明按宿主原路径挂载。

## 已确认范围

2026-09-26 访谈确认（Q3、Q10 按推荐）：

- 按宿主原路径挂载。不在系统提示中改报 `/workspace`：系统提示会随访问模式变化，缓存失效，历史里的路径前后不一致，授予路径仍不可见。也不在路由层翻译路径：bash 命令里的路径无法翻译。
- 隔离不变：容器内只能看到挂载点，往上的父目录是空的。服务代码目录本身、它的子级与祖先都会被保护根检查拒绝，不会盖住镜像内的 `/opt/ruukoto/worker`。
- `/` 的修复并入本工单。

## 验收标准

- 离线测试：`assertGrantNotProtected("/")` 拒绝；以 `/` 为工作区创建会话返回 `invalid_params`。
- tx 实测：扩展 `verification/foundation/scripts/linux-isolation/container-worker-smoke.mts`，新增三项检查并在 tx 运行通过：bash `pwd` 输出宿主工作区路径；按宿主绝对路径读取工作区文件成功；只读授予路径在其宿主路径下可读、不可写。原有检查（工作区外宿主文件不可见、根文件系统只读、无 capabilities、容器回收）仍然通过。
- tx 部署后，一次请求确认模式的任务中，模型按系统提示给出的宿主绝对路径 read 成功。

`npm run typecheck` 与 `npm test` 通过；`docs/runtime.md` 同步更新。

## 关联与后续

- [03](03-tools-and-access.md) 与 [ADR 0004](../../../docs/adr/0004-tool-worker-per-task-container-exec-account.md) 规定的容器执行边界（ADR 未规定挂载路径，本工单与之不冲突）；[24](24-system-prompt-discovery.md) 的系统提示 cwd 行。[23](23-container-full-access.md) 修好后，完全访问在执行账户下同样使用宿主路径，两种执行方式一致。

## Comments

### 2026-09-26：创建与访谈确认

prompt 组装优化访谈 Q3、Q10 按推荐确认；tx 上的验证记录见「背景」。

访谈中没有单独提问、按已确认的决定推导的细节（请复核）：

- 授予路径位于工作区内部时，同路径挂载会形成嵌套挂载，只读授予会让该子目录在容器内变为只读；以前挂在 `/granted/<i>` 时不存在这种重叠。按授予的读写属性执行即可，不做特殊处理。
- 工作区或授予路径与镜像系统目录（如 `/usr`、`/etc`）重叠时，容器启动或工作进程就绪会失败并明确报错，不做额外拦截。
- `verification/foundation/scripts/linux-isolation/run-probes.sh` 与 `probe.py` 是自带挂载的独立探针，仍用 `/workspace`，不改。
- 容器启动参数目前没有离线测试（现有测试只覆盖 docker 缺失，`test/07-real-tools.test.ts:196`、`test/22-auto-review.test.ts:939`），以 tx 冒烟脚本为准。
