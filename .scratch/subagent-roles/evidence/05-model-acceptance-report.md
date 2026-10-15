# 05 真实模型验收

日期：2026-10-15。实际模型为既有获准的 `deepseek/deepseek-flash`（`openai-responses`），`RUN_MODEL_CHECK=1`，实际发送均 `thinkingLevel=off`。环境为 macOS arm64、Node v24.15.0，隔离源码与临时实例；未修改日常实例、既有模型配置，未发送 IM 或外部业务消息。

## 结果及依据

| 范围 | 实测事实 | 证据 |
| --- | --- | --- |
| 123 个人产品工作流 | 真实模型调用工具启动命名工作流，人工等待期间可聊天，真实 `app_data` 写入隔离临时本地数据库，唯一最终汇总；20.7 秒通过 | `records/model-123-off.log`；`instances/ruukoto-workflow-model-0WJCIZ/` |
| 123 Coding 工作流 | 在新的隔离实例中真实 write→freeze→独立 verify bash→integrate；来源 `value.txt` 最终为 `changed\n`，唯一最终汇总；41.2 秒通过 | `records/model-123-compatible.log`；`instances/ruukoto-workflow-model-m3vJ1q/` |
| 125 双产品等待 | 两产品均由真实父模型发起等待/查询，第二次等待受拥有者输入打断，子任务后台完成且唯一补报；个人28.4秒、Coding25.7秒通过 | `records/model-existing-tests.log`；两个 `ruukoto-agent-wait-model-*` 实例的 `evidence.json` |
| 双产品默认 ordinary/workflow | ordinary 只给 `request`/`key`、workflow agent 只给 `request`，实际子模型以默认 general 调用真实 bash，生成独立 cwd 内精确 proof 字节 | `records/role-model-results.json`；最终两个 `role-model-*` 实例 |
| 双产品当前字节及保护 | reviewer 真实 bash 读取 staged 文本/二进制、unstaged 文本与 untracked 二进制的当前内容/哈希；对来源绝对路径写入被系统拒绝，来源各文件及 Git index 原字节不变 | 同上 reviewer 检查、原始 tool_ops、bash stdout/stderr artifact、来源与副本文件 |
| 角色可编辑与旧对象冻结 | Coding 编辑内置 reviewer 后新定义实际 bash 新 proof；原 work 延续原 digest 与保护；新增角色 V1→V2 后新对象使用V2、旧 work 延续V1 | 同上 edited-reviewer 和 editable-added-role 检查 |
| 角色错误及修复 | 真实父模型收到坏 description 与缺失工具的明确拒绝，未创建对应工作；修复角色文件后真实 bash 产出 REPAIRED_ROLE_PROOF | 同上两个 real-parent-role-error 与 corrected-role 检查 |

最终角色探针个人产品3个检查、Coding8个检查均通过。其中 `16/44` 是各自的模型发送/usage 记录条数，不是测试用例数。123/125 的通过结论以上表各场景为准；门控代理的离线自测另列，不当作真实模型场景。

共记录 **137 次真实模型 POST 请求，137 次 HTTP 200，无传输异常**；这包括原失败夹具与预备探针产生的请求，并非137个通过用例。另有本地门控转发的2次非模型 GET `/` 返回401，分开记录。分批模型请求数：既有123/125批22、123 off旧schema批18、123修正后Coding批11、最初本地探针13、native但错误目标探针13、最终native角色探针60。原始 HTTP 记录在 `records/*fetch.jsonl`，按请求ID配对的账本在 `ledgers/http-requests.json`。

## 输入和生产版本

基线HEAD为 `5f9da455072d68180ef19fc92ad02070cea583c1` 加已合入的修补，非仅该HEAD。`records/environment-final.json` 列出160个实际生产TS输入及worker构建产物哈希；归档时全部160个与主工作区一致，4个worker构建产物自模型启动后未改变。外部依赖复用既有安装，`@ruukoto/*` 解析到私有源码。3个来源消费生产输入如下：

| 文件 | SHA256 |
| --- | --- |
| `packages/runtime/src/runtime.ts` | `b25678b16eec2780ba28359bd6b01be9a01b7afa4f417442c1849f3a7ef5d31d` |
| `packages/runtime/src/parent-delivery.ts` | `4d1236f674b7997360824da2243a7807be236b6f9d29a8e0d5eaeed3718a9995` |
| `packages/agent/src/driver.ts` | `b4eff6eea89a61896674cfe26a13414d94231b65c103aa933ae5cb14a7842674` |

正式最终 `test/123-workflow-model-acceptance.test.ts` SHA256 为 `8a4de0c5f6fbb8fb228aeab49cb8f448917f8d71269bdef8f5e6f599e54eb363`。实际执行的保留档案副本为 `probe-scripts/workflow-123-off-reason.ts`，SHA256 `8753604cbe8a4d48b04e951e3e46fc1b48169751fee87aa90b72ebd5d5b70d68`；差异仅finally里的计数、保留临时档案与停止后移除临时认证副本，验收请求、工作流、断言不变。原始low、off旧schema、最终版本及各阶段角色探针均逐份保留并记录哈希。

`instances/*/data/sessions/*.jsonl` 保留模型会话原始历史；SQLite保留Task、事件、selection_records、usage、来源/角色execution及工具账本。`ledgers/model-call-input-index.json` 按137次发送列出原selection字段、usage、完整prompt-snapshot artifact路径与哈希；`data/artifacts/*.bin` 是实际完整prompt和工具stdout/stderr字节。`ledgers/tool-ops.json`/`bash-ops.json` 导出真实账本，证明工具授权与结果，而非仅模型口头描述。当前内容及proof原文件、Git index和副本工作区同样保留；`.db-wal`/`.db-shm` 若存在则一并保留。

## 原始失败与探针修正

1. 正式123原夹具要求 thinking low，现有模型不支持，双产品在Runtime.start以 `thinking_not_supported` 拒绝，各0Task、0模型请求。原日志及两个空执行实例完整保留。经授权仅夹具改为off，不修改模型配置。
2. 123 off第一次Coding中宿主verify要求passed及reason，夹具schema却禁止reason。真实模型已用bash验证并返回 `{passed:true,reason:...}`，被schema拒绝，工作流暂停 `write_result_missing`；来源仍 `base\n`、副本 `changed\n`。原 `x68SKW` Task、尝试、工具账本与字节完整保留，未恢复或换键重放。单独诊断见 `records/model-123-output-schema-diagnosis.json`。经授权仅让夹具兼容可选reason、passed仍必填且additionalProperties仍false，之后新 `m3vJ1q` 实例通过。
3. 初版独立角色探针未显式选择native，默认ordinary/workflow真实bash已通过，reviewer以native前提不足拒绝；次版native已启用但个人main Git目标在来源workspace外，被正确拒绝。两次失败探针、原结果及各13次模型请求完整保留。最终只把夹具目标放入main实际cwd，保护未放宽，新实例双产品通过。
4. 原模型verify曾先用macOS不支持的 `cat -A`，后续真实 `od`/`grep` 验证成功；原stdout/stderr及完整命令保留，未隐去不成功的命令尝试。

本报告不把上述失败算通过，也不以HTTP200替代产品断言。此前来源消费工程红绿与回归日志同包保留；最终本地范围126/126、恢复夹具5/5及check:static通过，主工作区与Linux/非作者审查结果由汇总报告单列，不在此冒充本agent重跑。

## 边界与恢复前提

只读确认了既有模型入口；本轮**未检查**真实外部MCP/IM配置、账号或平台可用性，未声称缺配置，也未验证任何真实外部平台。个人app_data是隔离临时库中的本地业务。继续外部验收需先选定平台、账号及目标，只读确认既有配置与连接，然后取得具体外部动作授权；本轮不发消息。拥有者主观交互体验仍待拥有者实际使用后确认。

最终独立角色探针在停止Runtime时，个人main的一个ordinary结果唤醒仍queued；因此不据此宣称所有standalone ordinary最终报告均已送达。唯一报告及等待/打断由125与正式123对应场景验证。模型验收只覆盖本次一个既有模型与macOS native，不能推广到其他模型、Linux真实模型或真实外部服务；无新增产品阻断事实，原失败均如实保留。

归档排除所有models/auth/credential配置、private目录、node_modules及socket；对所归档常规文件和压缩包成员按已配置凭据实际值进行内容泄漏检查，仅报告文件计数与是否命中，结果见 `safety-scan.json` 与外部归档校验文件。临时复制的模型凭据在检查与打包成功后移除，原日常配置未改动。
