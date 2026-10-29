# 技能脚本直接执行：实现检查记录

对象：`packages/agent/src/skills.ts`、`packages/agent/src/execution/skill-roots.ts`（新）、`packages/agent/src/tool-router.ts`、`packages/agent/src/driver.ts`、`packages/agent/src/context-assembly.ts`、`apps/ruukoto/src/personal-skills.ts`、`apps/ruukoto/src/personal-model.ts`（未改，沿用现有 `personalModelRequestSelection`）、`apps/ruukoto/src/personal-command-work.ts` 及对应测试与文档。

## 实施范围

- 模型可见文本：技能目录、技能块（任务钉版/显式展开）、引用包装与两产品工具描述的旧禁令替换为按会话命令工具措辞的执行说明（Coding `bash`、个人子 Agent `run_command`、主会话委派）；技能块附真实目录；`skillBlockLegacy`/`expandSkillCommandLegacy` 冻结旧格式，历史展开只精确接受新旧两种可重建格式。
- 共享选择 `selectSkillReadRoots`：逐候选 realpath+dev/ino、按真实路径去重、覆盖保持原权限、HOME/可写根/受保护/缺失/非目录/漂移/别名逐技能隔离；文件别名按最终授权集合核实，合法跨根硬链接不误伤，先消元后逐个隔离；原挂载自身失效原样上抛。
- Coding：`ToolRouterDeps.skillRoots` 由 Driver 供当前任务钉版技能库；`launchSpecFor` 在算完基础 spec（含验证降为 confirm）后按最终 mode 非 full_access 追加根；根与身份进入 worker key，变化先核实停止再重建；不可用根诊断追加进工具结果。
- Personal：受限 `run_command` 接纳时经 `personalModelRequestSelection` 定位原请求 `skills.snapshotEntry`，`personalSkillLibraryAt` 核实原库后选择根，`CommandAdmission.skills`/`Command.skills`（snapshotEntry+roots+unavailable）入证据；`prepared.spec.readRoots` 与 `input.mounts` 携带同一批根；恢复精确校验命令、接纳、执行意图、快照归属与旧无字段记录。

## 检查结果（本机 macOS，离线模拟）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 静态检查 | `npm run check:static` | 通过（typecheck/lint/md-wrap/md-links/doc-refs/doc-budgets/notes） |
| worker 产物 | `npm run build:worker` | 通过；skill-roots 为宿主侧代码，bundle 无变化 |
| 技能集成（源码不进上下文、bash 直执、显式 path 可读） | `npx tsx --test test/56-skills.test.ts` | 7/7 |
| 系统提示措辞 | `npx tsx --test test/59-system-prompt.test.ts` | 全过（旧禁令断言已替换） |
| 原生挂载与技能根选择（去重/覆盖/HOME/受保护/缺失/漂移/别名隔离/合法跨根链接/原挂载失效上抛） | `npx tsx --test test/native-mount-protection.test.ts` | 7/7 |
| worker 生命周期（技能根并入 spec 与 key、目录身份变化先停再建、停止未核实拒绝替代、full_access 不追加/验证降 confirm 仍补根） | `npx tsx --test test/100-worker-stop.test.ts` | 42/42 |
| Personal 技能（快照、旧格式展开接受、伪造拒绝、措辞断言） | `npx tsx --test test/personal-skills.test.ts` | 15/15 |
| Personal 命令持久恢复（技能快照绑定、spec/mounts 证据、root-identity/snapshot 篡改拒绝、legacy 无字段恢复） | `npx tsx --test test/personal-command-work.test.ts` | 51/51 |
| 原生执行与工具资格 | `npx tsx --test test/101-native-execution.test.ts test/62-tool-availability.test.ts test/subagent-source-capabilities.test.ts` | 32/32 |

## 实现中修正

- `selectSkillReadRoots` 初版在消元后直接逐个接纳，互相依赖的合法跨根硬链接对会被双双拒绝；先对剩余集合整体复核，整体干净即全部采纳（`native-mount-protection` 对应用例会捕获回归）。
- 漂移候选在 realpath 去重前判定，避免符号链接占位导致真实目录被静默去重。

## 审查后修正（独立实现审查的非阻断意见）

- 零候选提前返回：无技能任务不再为每次受限调用付整树 realpath 与别名核实，原挂载失效仍由启动前原生校验上抛。
- `covers` 前缀判定漏掉文件系统根本身（`/` + sep 前缀永不命中）：改为 `real === path.parse(real).root` 显式判定，homedir 先 realpath。
- 去重名额移到候选全部检查通过后才占用：同真实路径的被拒候选各自保留 unavailable 诊断，不再静默跳过。
- 补直接断言：验证步骤把 spec 降为 confirm 时仍补技能根、真正 full_access 不追加（`100-worker-stop` 新用例）。

## 未验证缺口（按工单验收保留）

- macOS/Linux 真实原生沙箱下的受限技能脚本执行（写拒绝、包外拒绝）仅由单元/集成层断言挂载与 spec，真实 `ssh tx` 平台验证未做。
- 两产品真实模型闭环（模型是否按新指引直接执行脚本而不读源码）未跑；需 `RUN_MODEL_CHECK=1` 与隔离档案/HOME。
- 代表性技能库的全库根扫描启动成本未观察。
