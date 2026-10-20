# 工单 39：native batch 独立安全审查

结论：不阻断。未发现可复现的候选遗漏、代码资产例外错绑、读取错误放行或跨调用旧结果复用。真实 Linux file-bind 证据仍由根补做，本审查不将该缺证据当作代码失守。

## 固定对象与要求

审查对象为 `/tmp/ruukoto39-native-batch` 作者独立副本及 `/tmp/ruukoto39-native-batch.patch` 的 7 文件改动；只读，未改作者副本或根仓库。最终 patch SHA-256 为 `6e72961295cdef84083158955b6ecc7320f024d4cc85a2dca29fc90c652c0b0c`，与最终 `git diff --cached --binary` 逐字节相同；最终副本无 unstaged 差异。早先交接的 ed53f49e 版本已被该版本取代。

核对依据为工单 39/spec A1、A5，`2026-10-10-native-execution-sandbox.md`、`2026-10-15-current-workspace-snapshots.md` 中的来源保护和 nlink=1 file-bind 要求，以及本补丁新增的批量核对决定。只读 review 已应用 development-workflow、ponytail-review 与 error-handling。

最终核心文件 SHA-256：

- `packages/agent/src/execution/approved-ops.ts`：`3a14e1a80ac1f94f97d5848e56eb6251ed85c485a0bf44e7616233f0474362c1`。
- `packages/agent/src/execution/native.ts`：`0d43d36e8d14f4da3595daaaabeea0c07e49624b95c8c285887dacd9e4f0271d`。
- `test/protected-path-batch.test.ts`：`c60ba27687f5d5ac0b1ee0159b364d9c2e72f23de5dae142e24050b118d2169d`。

## 安全核对

`runtimePaths` 生成的候选集合、工具别名和运行依赖发现保持；调用处只将逐候选扫描替换为逐保护根批量扫描。worker 与隐式 node_modules 例外在每个保护根循环内，仅在该根精确等于当前 codeRoot 时过滤；另一个保护根仍检查同一资产，显式 dependencyRoots 仍不能借用隐式例外。

批量函数先执行双向文本范围排除，再收集候选与祖先的 dev/ino。每个保护树按既有不跟随符号链接、目录 inode 去重规则扫描，任何候选或祖先物理身份命中均拒绝，未以 nlink 快捷放行。反向父级物理关系仍逐候选检查。集合键冲突只改变报告哪个命中候选，不会消除命中。

本次调用的候选、祖先和存在的保护根身份保存在局部 Map；返回前重新 stat 比对。遍历目录在退出时核对 dev/ino/类型及 mtimeNs/ctimeNs。路径被替换、目录项修订、扫描读取错误和保护根 EACCES 向调用方传播；显式 stat 守卫避免 existsSync 的 false 隐藏保护根 EACCES。确定 ENOENT 的保护根可缺失，其文本范围仍保护。准备失败仍在创建原生单元之前由既有 ExecutionError 路径报告。

局部 Map 不跨调用或启动保留。单目标 assertGrantNotProtected/isProtectedPath 保持接口、错误与原判定范围，共用扫描算法，未将它们全部迁移为批量 API。批量核对未声称文件系统原子快照；外部特权修改、全局保护根未作为只读挂载的既有旁路与 macOS 停止不确定性均未被本补丁改写成已解决。

## 独立验证

在作者副本执行 `node --import tsx --test test/protected-path-batch.test.ts`，8/8 通过、0 跳过，约 131ms。覆盖每目录一次扫描、后一个候选硬链接、根和祖先拒绝、后续调用重新核对、模拟 nlink=1 物理别名、不跟随保护树符号链接、候选/保护根/目录项变化、遍历错误和保护根 EACCES。日志 `/tmp/ruukoto39-native-batch-independent.log`。

执行 `node --import tsx --test --test-name-pattern='原生授权规范化|受保护来源可读' test/101-native-execution.test.ts test/subagent-execution-core.test.ts`，2/2 通过、0 跳过，约 2.67s。覆盖原生入口在创建单元前的保护拒绝、逐根 codeAsset 例外、显式依赖拒绝和原单目标来源只读/宿主文件写入/多硬链接保护。日志 `/tmp/ruukoto39-native-batch-entry-independent.log`。

未重复作者 86 项集合、全量 check 或真实模型；真实 Linux nlink=1 bind 和真实 worker 联合验收由根持有后续证据。本审查只用实际读到的源与上述独立运行报告结论，未读取凭据或操作 live-profile。
