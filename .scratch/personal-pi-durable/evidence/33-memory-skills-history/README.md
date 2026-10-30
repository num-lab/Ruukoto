# 个人记忆、技能与历史工程证据

> 本文部分原始证据已移出 Git；原路径保留用于查找原件，见[归档说明](../../../git-history-cleanup/archive.md)。

基线 `2280438`；2026-10-18，macOS arm64、Node 24.15.0。本次仅提交已验收切片，不推送、不部署，不切正式入口。源文件由 `source-manifest.json` 标识，检查原字节在 `logs.tar.gz`，`logs/` 是去除行尾空白并归一化末尾换行的展示；离线替身与真实模型/IM验收分别记账。

## 实现与覆盖

| 要求 | 实际落点与证据 |
| --- | --- |
| 记忆稳定身份、版本、来源、修订与撤销 | `personal-memory.ts`；`personal-memory.test.ts` 覆盖同键重放/异参、版本冲突、撤销、重启、来源缺失、子身份隔离、主修订子来源拒绝、当前修订丢失、payload前撤销竞态及两阶段证据提交失败零HTTP |
| 技能目录、正文版本、动态提示与显式调用 | `personal-skills.ts`、config/cli；`personal-skills.test.ts` 覆盖目录变化、不可改快照、实际加载与引用、缺文件/逃逸、safe工具重开、SDK参数规范化、未知显式调用只阻断本轮、原输入与失败/成功展开固定、坏索引与配置锁 |
| 新历史及压缩后查原文 | `personal-history.ts`；6条窄测覆盖主/子/定时归属、闭合/复用历史、256条有界检索空续页、4096字符原文、压缩后原文仍在、系统/证据data不可读和实际模型工具结果 |
| 新主/子/定时装配、请求可重建 | Harness、work、schedule-execution/scope；定时组合实际执行保存→封组查询→拒绝变更，带通用工具子身份真实委派后重开；规范输入和最终payload核实同批记忆/技能来源 |
| 最小可操作配置与控制 | 已认证本机 `/memories`、`/memory`、`/history` 与 `/history/entry`；向导选择配置技能、管理记忆、检索历史。实际HTTP用例覆盖无内部编号操作、修订/撤销、失效来源只提供撤销；损坏修订仍拒绝。IM通过主模型和保留原入站正文的 `/skill:名称` 可达，真实私聊仍待验 |
| 旧个人提示/技能需求核对 | 对照 `packages/agent/src/session-factory.ts`、subagent-roles与旧Driver；中文/拥有者语言、参考不改授权、稳定记忆、按需技能、压缩后查原文、IM简短答复纳入新提示。不搬旧编码角色、agent_wait、coding_result、worktree或角色定义库 |

记忆只自动注入本会话，主可查已登记新主/子/定时资料，子和定时只查自身。新实例不导入旧JSONL、记忆或项目Db；共享core只导出既有正文/类别校验，共享技能只复用独立解析/读取。技能配置纳入定时创建快照，正文变化从后续模型调用生效。

## 检查

- `npm run setup`：通过，两份锁文件安装及现有钩子就绪；无依赖或锁文件改动。
- 最终 `npm run check:static`：通过，含全仓lint/typecheck、笔记与文档门禁。
- 最终 `RUN_MODEL_CHECK=0 npx tsx --test test/personal-memory.test.ts test/personal-memory-controls.test.ts test/personal-skills.test.ts test/personal-history.test.ts test/personal-scheduler-integration.test.ts test/71-product-entry.test.ts`：57/57通过，0跳过，约12.6秒，见 `logs/ruukoto-33-final-verification.log`。
- 已有调用方首轮28文件：604项中590通过、13失败、1个Linux sudo用例在macOS跳过，见 `logs/ruukoto-33-callers.log`。13项来自新增参考工具后的旧工具清单、旧子配置夹具及对整段schema文本查找名称的旧断言；已同步适用清单/夹具并改为按工具name断言，未削弱权限、来源、停止或恢复检查。该首轮不记全绿。
- 对首轮失败所在文件增量复核：services/work/work-tools/cli共138项中137通过、1个Linux用例跳过，见 `logs/ruukoto-33-callers-fixed.log`；service-operations/tools共97项中96通过、1项认证HTTP应答超过既有5秒时限，见 `logs/ruukoto-33-callers-extra-fixed.log`。未改变时限或自动重试；该HTTP单项单独复跑1/1通过，约4.2秒，见 `logs/ruukoto-33-tools-http-rerun.log`，未重复出现。各组重叠，不相加。
- 来源失效撤销的最后窄测：memory及memory-controls 15/15通过，包含模型继续拒绝、可信管理ROOT例外、损坏修订仍拒绝、只撤销原版本，见 `logs/ruukoto-33-memory-repair-final.log`；已包含在最终57项中。
- `npm run change-scope -- --base 2280438` 与 `git diff --check`：通过。未跑全量 `npm run check`；没有修改原生命令、浏览器或Linux隔离原语，不将macOS离线检查记作Linux矩阵通过。

## 实际模型可见文本

`before-requests.json` 来自基线隔离副本，`after-requests.json` 来自当前实现；均是空记忆/空技能目录的实际OpenAI兼容mock payload，含主、子、独立定时初轮与封组汇总四种身份。`estimates.json` 用实际system字符串、完整tools JSON的字符数除4向上取整，只作估算，不作为窗口上限。配置/目录正文、参考、显式展开与实际工具结果的非空路径另外由窄测逐项核实。

| 身份 | systemPrompt前→后 | toolSchemas前→后 |
| --- | --- | --- |
| 主 | 51→107 | 1090→1799 |
| 子 | 38→69 | 1→709 |
| 定时初轮 | 48→78 | 290→999 |
| 定时汇总 | 48→78 | 290→999 |

## 独立审查

`plan_review` 在实施前直接核对规格、当前来源与provider/装配，细化方案通过；原生两阶段记录失败及payload改写8/8探针通过。实施审查由不同上下文直接读取实际差异：`plan_review` 审技能、接线、控制、文档与smoke；`skills_audit` 审非其所写的memory/history/control及文档。

发现并返修：子新建工具顺序导致重开不符；在线记忆当前revision丢失仍可能发请求；技能SDK规范化参数恢复比较不符；未知显式技能历史毒化后续聊天；本机对子/定时记忆展示必失败修订；smoke只计工具次数而未证明重启后查原记忆；来源失效记忆无法从管理列表撤销。最终均有窄反例，未降低验收标准。

`plan_review` 亲跑真实mock子委派重开、定时保存/封组只读/拒绝变更及provider payload前撤销零HTTP；最后亲跑SDK规范化、未知命令后的普通/重启3条，通过。`skills_audit` 亲跑memory10/10、history/control8/8，通过。管理撤销最后补审由 `plan_review` 亲跑真实文本产物丢失、只撤销向导与坏revision拒绝3/3，并核对管理例外只能ROOT、模型路径仍拒绝。终审无未解决阻断；独立亲跑结果不与作者检查合并计数。

## 外部验收与限制

`npx tsx verification/smoke/smoke-personal-durable.mts` 本轮实际退出2：缺少显式 `RUN_MODEL_CHECK=1`、`RUN_PERSONAL_MODELS_FILE`、`RUN_PERSONAL_MODEL`，零真实模型请求。入口已覆盖模型memory.create→独立进程重启→memory.search/read同条记忆→skill任务，并按原assistant/pi.tool/成功结果及重启边界核实；静态与缺前提门已验，不声称实际模型效果通过。

真实模型、QQ/Telegram自然语言与显式技能、本机实际操作者体验、Linux/CI矩阵仍待拥有者或35/37/39在专用档案补证。首次配置、权限与服务等其他能力的既有待验状态不由本单代签。撤销停止未来查询/参考，不擦除已发请求或原历史；来源失效项可在线撤销，但其他图片或工具证据仍缺失时，相关请求/重启仍须恢复原证据。没有跨产品同步、旧资料导入、检索平台或全档案磁盘配额；注入只选最近256条中的至多16项、32KiB，更多记忆用有界查询读取。
