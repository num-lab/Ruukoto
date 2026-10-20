# 工单 23 独立实现审查

审查者：worker_review；日期：2026-10-17；对象：`.scratch/personal-pi-durable/issues/23-command-worker.md` 当前未提交实现，直接核对 `spec.md`、工单 22、仓库规则、实际源码、调用方、测试、构建与新增文档。共享工作区全程只读；构建与撤修复验证在 `/tmp/ruukoto-worker-review-mi5fn41r`，第三方依赖链接原安装，`@ruukoto/*` 指向隔离副本。

## 当前结论

代码、文档及最终工程证据无未解决阻断，无非阻断建议。先前发现的目录替换阻断已修复并独立反证；最终 Linux 七场景、清理与快照证据复核通过，本片工程验收依据充分，可以按工单 23 的既定边界结束。此结论不覆盖 durable 命令工具、完整迁移或上线。

## 已修复阻断

Node 可缓存 `process.cwd()`：worker 已开始读取 stdin 后，重命名当前目录并在原路径建立新目录，旧实现仅核对 `.` 身份、缓存 cwd 字符串与路径规范性，会在旧目录执行。审查独立脚本 `/tmp/ruukoto-review-cwd-repro.mjs` 向 worker 写入有效 JSON 加 1 MiB 尾空白，等待 write 回调及 400 ms，再替换目录并 EOF；修复前日志 `/tmp/ruukoto-review-cwd-before.log` 为 `code:0, oldInvoked:true, newInvoked:false`。作者增加 payload 路径 stat，要求它及 `.` 均为相同 dev/ino 的目录；修复后同脚本 `/tmp/ruukoto-review-cwd-after.log` 为 125、两处标记均不存在。加强测试只撤去 target stat 及比较后失败，日志 `/tmp/ruukoto-review-cwd-fixed-regression.log` 为 actual 0 !== 125，指向等待输入后替换目录断言。

## 亲自执行的验证

- 隔离副本 `npm run build:worker` 生成共享 `worker/worker.mjs` 与个人 `worker/personal-command-worker.mjs`，成功。
- 修复后 `node_modules/.bin/tsx --test test/personal-command-worker.test.ts test/101-native-execution.test.ts test/101-native-linux-scope.test.ts test/native-linux-identity.test.ts`：36/36 通过，零跳过，日志 `/tmp/ruukoto-review-final-tests.log`。前两项在 macOS 真实本机执行，Linux scope 与 identity 为离线桩，不能替代真实 Linux。
- 自包含产物复制到没有 node_modules 的临时目录仍可执行，双流二进制与 5 MiB 输出完整，EOF 前零执行，Shell stdin 关闭，非零与 TERM 退出按预期。
- esbuild metafile `/tmp/ruukoto-worker-review-final-meta.json` 中个人产物仅有 `node:fs`、`node:path`、`node:os`、`node:child_process` 四个外部导入，另将 PersonalError 内联，无 Pi 引用。
- 用原单入口 esbuild 参数另生成 Coding worker，与新双入口命令生成的 `worker/worker.mjs` 逐字节 cmp 相同；原默认 Pi 发现用例通过，显式 [] 不发现旧依赖，显式根及其父根触及保护路径时拒绝，显式 code-root/node_modules 也不享旧默认例外。
- 隔离负例撤去空白命令检查：原窄测试退出 1，日志 `/tmp/ruukoto-review-blank-command.log`。
- 隔离负例撤去 cwd 校验：原窄测试退出 1，日志 `/tmp/ruukoto-review-cwd-validation.log`。
- 隔离负例允许显式依赖享有 Coding code-root/node_modules 例外：原窄测试退出 1，Missing expected rejection，日志 `/tmp/ruukoto-review-explicit-code-exception.log`。

## 契约与文档核对

显式依赖是新增可选宿主配置，旧调用方无须变化；主 worker 和其他包 exports 未改。个人 worker 不安装模型工具、不持有 durable 权限/回执/占用，不改变正式入口。文档明确宿主先完成 launch 与流/退出消费接线，再 EOF 提交命令；命令信号映射为 128+signal，worker 自身被平台终止仍留在独立 signal；raw output、stderr 诊断和退出码包括 125 都不是可信效果回执，停止仍按原持久执行引用核实 scope。README、development、products、execution、personal-durable、pre-push-checks 与当前实现一致。

## 最终内部提取复核

作者将目录核对提取为真实类型的内部 `verifyWorkspace`，使 try 只调用一条语句；逐项比对仅把 stat 重命名为 current，路径与 current 的 dev/ino 比较、规范路径和 cwd 核对全部保留，失败所有权不变。隔离副本重新 build:worker，5 条个人 worker 窄用例全过、零跳过，同一目录替换脚本仍返回125且两处均零执行。日志 `/tmp/ruukoto-review-final-extraction-build.log`、`/tmp/ruukoto-review-final-extraction-tests.log`；metafile 已更新至最终产物，仍只有4个Node内置外部导入。

## 被审快照

- `apps/ruukoto/src/personal-command-worker.ts`：c13a477a2432fd1b06ad1dfb5a7d0bb85135acb9e422eb564de80fffa7519503
- `packages/agent/src/execution/native.ts`：b55cc3566101824c9406f54a173cd3a8d0f3b0e5eefd94cfe595abac589f0fe7
- `test/personal-command-worker.test.ts`：4b90e01e3962b9351db860c7a9a5fd73513c8d2dba552c784e780ab5b26c7762
- `package.json`：6b93cb1622229f73827927b8d1120efa7083f3578a9c82a32c79b633f59ace16
- 个人产物：c1d8bc3492be8253ce5bdf4ed5dc553e44da91fc3eda4be663eddd7d49e63cf3
- Coding 产物：ec4d123259d2ee502107d66c7598a5d88ad4a7551bf4ca9d3383cd3d70bdb909

未跑全量 check、真实模型/IM、durable 命令链及部署；这些没有被本片开放。最终 Linux 证据已独立只读复核，按要求未重复远端探针；worker 完成永远不能代替外部效果或整 scope 停止证明。


## 最终工程材料复核

收到最终 `.scratch/personal-pi-durable/evidence/23-linux/` 与 `23-macos/` 后只读核对，未再派发远端执行。Linux 的 59 项 artifact manifest 全部字节数/哈希相符；source-comparison 的 11 项均相同，并直接读取 tar 成员验证其中 10 个生产文件与共享工作区逐字节相同，另一个探针与单独 probe-entry 一致。最终源码 c13a477a2432fd1b06ad1dfb5a7d0bb85135acb9e422eb564de80fffa7519503、worker c1d8bc3492be8253ce5bdf4ed5dc553e44da91fc3eda4be663eddd7d49e63cf3 与已审快照一致。

直接阅读探针与 metafile：调用真实 prepareNativeLaunch，明确 dependencyRoots: []，源码根及私有认领目录列为 protectedRoots；bundle 位置保持原生模块推导 codeRoot 的层级，实际 source 无仓库 node_modules，宿主已有 npm 运行根未被误算为 Pi。主进程及两个独立 owner 都先 await launchLinuxExecution，接好原字节流与 exit/流结束消费，再 stdin.end(JSON)。探针没有 mock 原生执行或手写 prepared 输入。

七项最终场景为立即退出、二进制与 exit 37、TERM 映射 143、2 MiB stdout/1 MiB stderr、未授权文件/网络、setsid 后代且 owner 存活、setsid 后代且 owner 先 SIGKILL。独立重新核算前两种原字节输出预期 SHA-256 与 summary 相符。受限场景有同宿主可读文件和 localhost 连接的阳性对照；受限执行报告 read ENOENT、write EROFS、network EPERM，原合成文件内容不变。

两个后代场景源码明确等待 sid=pgid=pid 及活跃心跳、观察原 cgroup populated，再分别保持 owner 或先 SIGKILL 并等待其 signal 退出，之后从另一进程按保存原 ref 调用 stop。原 ref、observation、scope、summary 与各 stop 文件逐项对应；停止 true 后心跳至少冻结250ms，再重复停止 true、同 ref 再启动被 execution_claim_failed 拒绝，最后才删临时目录及 fixture。七组 stop 证据与 cleanup scope 集合一致，cleanup 记录七 scope not-found/空 ControlGroup、七 native 临时路径不存在、匹配进程与 fixture 目录为零；remote-artifact-cleanup 另记三轮远端探针目录清理。初轮依赖断言错误及中间成功轮均明确保留，没有冒充最终通过或累加场景。

核对作者本机最终 build/static 日志及实际结果：最终 build 已生成4.1kb个人产物及两 app 包，check:static 完成 lint、全 workspace/foundation 类型、notes及全部 docs 检查。首轮53例及最终受影响5例复跑日志与工单表述一致：合并为53个唯一场景，不计58。macOS source-manifest 的12个源码/测试/说明文件及2个产物的哈希均与当前文件一致，source-final.tar.gz 的12个成员与当前文件逐字节相同；总提案仅加当前worker实现引用，未改已确认取舍。

最终核对工单23与总工单下一步：本片仅交付自包含worker及依赖准备，后续仍必须接 durable 原工作权限、操作回执、未知暂停、原临时目录与持久停止占用；正式入口、完全访问、MCP、真实模型/IM及上线保持后续。方案审查记录已改为“该次仅审方案，不覆盖实现或运行测试”，历史范围与当前实现审查状态清楚；工单23已按实际结论记工程通过/resolved，总工单补齐本片证据和消费者后续。产品验收不适用的理由成立，本片没有用户入口。
