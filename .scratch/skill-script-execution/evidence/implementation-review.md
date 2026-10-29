# 技能脚本直接执行：独立实现审查记录

对象：`.scratch/skill-script-execution/issues/01-execute-without-source.md` 的实现（HEAD=a138b910 之上的暂存 diff，25 个文件）。审查者为独立执行上下文（subagent ef32ce0a），亲读工单、决策笔记 `2026-10-29-skill-script-execution.md`、实现检查记录、方案审查记录、实际 diff 与相关源码，并亲自重跑验收相关测试。

## 结论

通过，无阻断意见。实现与确认方案逐项吻合，失败路径方向保守正确，测试为真实行为断言而非恒真断言，外部验收缺口如实记录。

## 逐项验收核对

| 验收要求 | 结论 |
| --- | --- |
| 无源码预读即可用脚本 | 通过：`skillBlock` 附真实目录与按会话命令工具措辞的执行说明；56-skills e2e 真实 bash 执行脚本，断言源码标记不进模型请求、同包资源可读、原工作区可写、显式 path 读取仍返回源码；仅显式调用资格未变 |
| 正常工作与权限 | 通过：技能根经 `LaunchSpec.readRoots` 进只读 mount；HOME/祖先经 realpath 拒绝；已授权覆盖保持原权限；`base.mode !== "full_access"` 才追加，验证降 confirm 路径成立 |
| 根故障隔离与 worker 生命周期 | 通过：坏根逐技能隔离进 unavailable；原挂载失效原样上抛；dev/ino 入 worker key，身份变化先核实停止再重建，停止未核实拒绝替代 |
| Personal 原请求绑定 | 通过：经 `personalModelRequestSelection` 固定原 `skills.snapshotEntry`（不取 current），roots/unavailable 入 `CommandAdmission.skills` 证据，冷恢复精确校验，篡改用例真实拒绝，旧无字段记录走旧校验 |
| 历史兼容 | 通过：`skillBlockLegacy` 与 HEAD 字节逐一比对一致；展开只接受新旧可重建格式，伪造拒绝 |
| 模型可见输入可重建 | 通过：目录行随加载/展开持久化，Coding 诊断进工具结果，Personal unavailable 进命令证据 |
| 计划与调用方 | 通过：`new ToolRouter` 唯一生产调用点已接线；`personal-model.ts` 未改够用；无遗漏调用方 |
| 越界检查 | 通过：未新增执行工具/配置开关/模板语法；worker bundle 无需变 |

## 非阻断意见（不阻止交付）

1. 每次受限工具调用都全树 realpath+别名核实（零候选也扫）——**已修**：零候选提前返回。
2. `covers` 前缀判定漏掉 `/`（`/`+sep 永不命中），homedir 未 realpath——**已修**。
3. `seen.add` 早于检查导致同路径被拒候选静默跳过、诊断不全——**已修**：去重名额移到检查通过后。
4. 边缘画像（无 bash 也不可委派的会话）catalog 说「可委派」而技能块说「可用 bash」，措辞互相矛盾——未修，良性（调用不存在的工具即失败），主路径正确。
5. `specDiagnostics` 追加到所有经 worker 的工具结果（含 read/search），「本次命令环境」措辞对非命令结果略不贴——未修。
6. 证据计数偏差（56-skills 8/8→实测 7/7，personal-command-work 58/58→实测 51/51）——**已修**。
7. 验证降 confirm 无直接用例——**已修**：`100-worker-stop` 新增直接断言（full_access 不追加；验证降 confirm 仍补根）。
8. 原挂载失效以原生 fs 错误上抛未包 `code`——未修，符合「原样上抛」意图。
9. 56-skills.test.ts 旧措辞注释残留——**已修**。

## 未覆盖项与证据缺口（保留）

- macOS/Linux 真实原生沙箱下的受限执行（只读根写拒绝、包外拒绝、网络拒绝）未验证——实现方如实记为缺口。
- 两产品真实模型闭环（模型是否按新指引直接执行而不读源码）未跑，需 `RUN_MODEL_CHECK=1` 与隔离档案/HOME。
- 代表性技能库的全库根扫描启动成本未观察。

## 审查者实际执行的检查

| 命令 | 结果 |
| --- | --- |
| `git diff --cached` / `git status` / `git show HEAD:` 字节比对 | 25 文件亲读；旧展开格式一致 |
| `npx tsx --test test/native-mount-protection.test.ts test/59-system-prompt.test.ts` | 9/9 |
| `npx tsx --test test/56-skills.test.ts` | 7/7（含真实 bash e2e） |
| `npx tsx --test test/100-worker-stop.test.ts` | 41/41（审查时点） |
| `npx tsx --test test/personal-skills.test.ts` | 15/15 |
| `npx tsx --test test/personal-command-work.test.ts` | 51/51 |
| `npx tsx --test test/101-native-execution.test.ts test/62-tool-availability.test.ts test/subagent-source-capabilities.test.ts` | 32/32 |
| `npm run typecheck` / `npm run verify-notes` / `npm run check:docs` / `npm run lint` | 全部通过 |
