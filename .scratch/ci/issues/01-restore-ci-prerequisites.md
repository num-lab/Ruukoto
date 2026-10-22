# 恢复 CI 环境前提与全量回归

Status: ready-for-human

## 目标与边界

拥有者于 2026-10-22 要求调查 CI 报错并修复。基点为 develop 的 94bc0932；最新 [CI](https://github.com/num-lab/Ruukoto/actions/runs/39720984008) 四格都因缺 rg 在 setup 退出。[前一轮](https://github.com/num-lab/Ruukoto/actions/runs/39457723330) 另有 Linux 缺原生执行前提、文件树 SSR 无法加载 xterm。当前样式用例已通过，不重做旧修复。

修复 CI 环境装配及全量揭示的现行契约回归，保持生产权限、原生执行边界、业务断言和四格矩阵。扩展范围仅恢复已有要求：宿主等待不计脚本预算、个人入口不加载旧 Store、测试夹具与现行协议一致。禁止用跳过用例或放宽整机 userns 限制取得通过。拥有者追加授权本地提交；不推送或部署。

## 方案

1. `.github/workflows/check.yml` 在 setup 前通过 apt / Homebrew 安装 rg；Linux 同时安装 bubblewrap，复用 `deploy/native/ruukoto-bwrap` 的按路径 AppArmor 授权，以及 `deploy/systemd/README.md` 的 user manager 与 bus 配置。前置探针确认 namespace 与 user scope 可执行，再运行原 setup / check。
2. `.scratch/desktop-shadcn/evidence/files-sidebar/file-tree-repro.mjs` 的 Vite SSR 配置让 xterm 与 fit addon 经过已有 Vite 转换，使用包声明的 ESM 入口，并同步 Inspector 新增的 terminalTabs 空列表夹具；现有文件树与新标签页断言继续执行。先用独立加载探针验证方案，不改产品 import。
3. 同步 README、开发说明、提交前检查映射和决策笔记。影响包括 CI 环境、测试入口与夹具、脚本宿主派发和个人入口的纯解析模块；原问答 API 直接重导出，既有协议与持久数据格式不变。
4. 运行前置缺 rg 的正负例、开发工具与文件树定向用例、静态检查；Linux 在 ssh tx 的独立临时检出运行原生验证及此前失败的工作流/角色用例。用完整本地 check 核实最新 setup 遮蔽的后续回归。GitHub 四格未重新执行时明确留作远端证据缺口。
5. 全量发现的脚本计时竞态按[独立修复决定](../../../.agents/notes/implemented/bug-fix/2026-10-22-workflow-host-idle-dispatch.md)处理；新真实 worker 分帧回归先红后绿，保留恶意计算与取消保护。个人提问纯解析移入 core 的独立输入模块，原 API 直接重导出，保持原错误类身份和校验行为；旧入口依赖图断言不放宽。
6. 同步过期协议常数、Plan 白名单、Demo 新事件、Desktop 查询夹具和安全错误断言；GitHub 同进程客户端预算与真实多 worker 的目标单元等待按实测调整，业务门与停止断言不变。
7. 非独占测试文件固定最多两个并行，保留用例内并发与全部成员；macOS TERM 夹具改为追加信号证据。本机全量已接近原三十分钟时限，GitHub job 改为四十五分钟以容纳环境准备；最终记录退出码、计数与耗时，四格实际耗时仍待远端核实。

## 进展与交接

当前角色：实施者。修复、独立代码审查及本地工程检查完成，按拥有者追加指示提交。工作区起始干净，改动路径见方案及本次提交；决策归属见[CI 前提笔记](../../../.agents/notes/implemented/testing/2026-10-22-ci-prerequisites.md)。下一步推送后执行 GitHub 四格环境验收；本轮不推送或部署。

## 验收与证据

- 作者已运行 PATH 隔离探针：同一个 `node scripts/check-environment.mjs` 在无 rg 时以 1 退出并复现 CI 原错误；加入 rg 后以 0 退出。
- 作者已运行 `npx tsx --test test/98-development-tools.test.ts test/43-desktop-demo.test.ts test/desktop-file-tree-loading.test.ts`：6 通过、1 失败，文件树在 xterm CommonJS named export 处失败。
- 修复后同一定向命令在 macOS / Node 24.15.0 为 7/7；原 SSR 加载通过后暴露夹具缺少 terminalTabs，同步空列表后完整断言通过。
- 独立实现审查 ci_review：无代码阻断；亲自运行文件树 1/1，并在内存分别撤除 noExternal、terminalTabs，重现导出错误和接口缺失。YAML 解析、各 run 的 Bash 语法、四格矩阵和只读权限比对均通过。
- macOS / Node 24.15.0 最终 `npm run check` 退出 0，耗时 1911.804 秒：build、check:static 全过；应用独占批次 67/67，主批次 3253 通过、24 跳过，共 3320 通过；基础验证 9 通过、1 跳过，无失败或取消。日志 `/tmp/ruukoto-ci-final-check.log`，耗时与退出码 `/tmp/ruukoto-ci-final-check-result.json`。首轮失败清单见 Comments，日志 `/tmp/ruukoto-ci-macos-check.log`。
- Linux 为 ssh tx / Node 24.21.0 的隔离源码目录，未复制历史大体积证据；因磁盘余量不足，复用匹配根锁文件的已有依赖缓存并硬链接落到本次 node_modules，workspace 链接指向本次源码。未完成干净 setup，不代表 GitHub Node 22.19/24.15 四格。
- Linux 仓库 AppArmor profile 与已加载文件一致，userns 限制仍为 1，user manager 为 running；workflow 的完整 namespace 与 Delegate=yes scope 探针均通过。测试专用 rg 从 apt 解包到源码外；放在源码内会被保护根拒绝，对照探针确认这一点，未改生产边界。
- Linux 前置命令为 `node --import tsx --test --test-reporter=tap test/101-native-execution.test.ts test/101-native-linux-scope.test.ts test/native-linux-identity.test.ts test/112-workflow-real-steps.test.ts test/122-workflow-code-acceptance.test.ts test/125-agent-wait.test.ts test/subagent-role-driver.test.ts test/workflow-role-integration.test.ts`：63 通过、1 个 macOS 专属用例跳过；另跑 `test/subagent-workspace-snapshot.test.ts` 4/4。PATH 仅在验证进程加入源码外 rg。日志 `/tmp/ruukoto-ci-20261022-linux-final.log` 与 `/tmp/ruukoto-ci-20261022-linux-snapshot.log`。
- 脚本宿主修复后 Linux 再跑 104、112、122、125、workflow-role-integration 五文件：69/69，耗时276.4秒，日志 `/tmp/ruukoto-ci-20261022-linux-script-fixed.log`。没有把另一格通过算作 GitHub 四格。
- macOS 窄测：脚本104为40/40；真实工作流112 ledger_unknown与122为2/2；问答与实际入口29/29；Web Search与GitHub16/16；83两个integrate停止阶段、86回滚和Plan固定审批4/4；PA夹具3/3；测试入口124为9/9。基础验证9通过、1个真实模型默认跳过。
- 工程验收：独立实现审查无阻断，本机全量及 Linux 定向检查通过。最终被检应用源码未再变化，收尾仅修改 CI job 时限与文档，YAML、四格矩阵、只读权限及所有 run 的 Bash 语法核实通过；`check:docs`、`verify-notes`、`git diff --check` 与变更文件末尾换行检查通过。产品验收无新的主观体验取舍：恢复既有计时、装配与展示契约；GitHub 四格、干净 Linux setup 与远端耗时仍待验收，因此保留 ready-for-human。

## Comments

2026-10-22：定位两轮 CI 日志并核对当前检出；完整原始下载日志保存在本机 /tmp，不将无关长日志入库。

2026-10-22：独立上下文 ci_review 审查上述方案，无阻断；亲自复现原 SSR 失败及两个 noExternal 后成功加载。要求 Linux 显式安装 AppArmor/user bus、向当前及后续步骤设置 runtime/bus、scope 探针带 Delegate=yes；实施已采纳。

2026-10-22：首轮 macOS 全量应用测试 3274 项，3229 通过、19 失败、24 跳过、2 取消；用作问题清单，不是最终被检版本。独立审查者逐项确认夹具修复方案、脚本 idle 派发方案和个人纯输入模块方案。脚本旧实现的真实分帧回归报 script_cpu_limit，修复后 104 全部40项通过；审查者另验过期 idle、非法迟到 call 和取消均不越过派发资格。

2026-10-22：固定文件并行2的方案经独立审查，无阻断。首次最终轮在原生独占批次发现 TERM 标记空串（66/67，退出1），未进入其他批次；监督器确实反复 TERM，夹具改追加证据的方案经独立审查，具体 truncate/write/KILL 时序没有逐系统调用追踪。

2026-10-22：最终全量退出0，1911.804秒；独立审查同意 GitHub job 时限从30改为45分钟，保留远端实际耗时缺口。清除 AGENTS 与提交前检查中约200秒的过时定值，新实测归入开发耗时记录，不以增加 job 时限延长产品执行预算。

2026-10-22：拥有者要求提交本轮修复；保留已通过的全量与定向证据，提交时执行暂存检查与静态门禁。远端矩阵尚未执行，工单状态保持 ready-for-human。
