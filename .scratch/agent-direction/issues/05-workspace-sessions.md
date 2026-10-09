Status: resolved

# 05 — 按工作区创建和切换开发会话

**What to build:** 拥有者打开目录后使用工作区与会话组织开发工作，一个根目录可以包含多个仓库，新入口兼容现有资料归属。

**Blocked by:** 无，可立即开始

依据：[已确认规格](../spec.md) 与 [ADR 0017](../../../docs/adr/0017-two-agent-products.md)。

## 验收标准

- [x] 通过可信入口打开目录，创建或复用工作区并新建会话，TUI 可列出、切换和恢复各工作区的会话。
- [x] 按真实目录身份判定工作区，同名目录不会合并，别名不会意外重复创建。
- [x] 一个根目录可以包含多个仓库；普通工作区列表不混入角色、群聊或内部 SubAgent 会话。
- [x] 新增工作区归属时保留旧项目兼容关系，新会话从创建、执行到历史查看形成完整路径。
- [x] 旧 API 和现有实例仍可读取，不要求一次性替换全部 Project 字段。
- [x] 完成相关端到端检查、类型检查及仓库要求的验证；同步本次行为涉及的运行说明和图解，验证记录区分模拟结果与真实环境结果。

## Comments

### 2026-10-02：实现完成

**判定与改动**

1. **工作区 = 带根目录归属的项目**（`projects.root_cwd/root_real/root_dev/root_ino`，schema v18→v19 只做加法；`idx_projects_root_real` 部分唯一索引兜底，同一真实目录至多一个工作区；`DirIdentity` 复用 realpath/dev+ino 判定、`sameDirIdentity` 提取共享）。旧项目四列为 NULL，不另建并行状态；issue 06/07 的配置与迁移继续落在这个归属上。
2. **新 op `open_workspace`**（`Runtime.openWorkspace`）：目录校验（存在/realpath/保护根）先于写入；已归属工作区直接复用；旧项目经 `project_id` 认领根目录（`project.root_attached` 事件留痕，角色/群聊项目后台兜底拒绝认领，已归属他目录拒绝改归属）；否则同事务建工作区项目+会话（自动名取根目录名、重名仅展示层去重）；每次打开都新建会话；同一请求标识重发返回原成果（同键异目录——同样按 realpath 或 dev+ino——报 request_conflict）。`create_project`/`create_session` 旧 op 行为不变（不写归属）。
3. **TUI（仅 ruukoto-code 产品）**：工作区入口改走 `open_workspace`（先按根目录归属命中，再退到遗留候选，多候选照旧先选择）；选择面板拆为工作区/旧项目两段，纯角色（main/coding/chat）与 QQ 群聊会话所在的项目及会话不进普通列表（含普通 dev 会话的混合旧项目保留，逐会话过滤）；ruukoto 产品行为不变。内部子任务是任务而非会话，本来不在列表。
4. **审查修正**（/code-review 两轴）：删除无人再用的客户端 `suggestProjectName`（命名逻辑只在后台）；重放目录比较与一般归属统一为 `sameDirIdentity`；提取 `isRootDirClash`； `workspacePickerProjects` 改为逐会话判定；补角色/群聊认领的后台拒绝。

**验证（真实环境与模拟分列）**

- **产品级冒烟** `.scratch/agent-direction/smoke-05-workspace-sessions.mts`（真实 bin/ruukoto-code.mjs 后台、真实 socket/SQLite/文件，模型打桩）：macOS 本机 **6/6**（多仓库根目录打开、符号链接与路径变体复用、同名目录去重、请求标识幂等、旧项目认领与自动归属、提交执行与历史查看）。
- **离线测试**：test/74（15/15：open_workspace 各路径、v18→v19 迁移库可读、纯函数与两产品的选择面板伪终端用例）；受影响回归 test/30/66/19/13/50/67 全过；`npx tsc --noEmit` 通过；test/67 3/3。
- **顺带修复的既有失败**（本单范围外但同仓红绿要求）：test/13 显示名期望跟进 9509cb0 的 ⏵⏵/⏸ 前缀；test/19 合成会话补齐 `session.usage_updated` 演示事件（并随本单新增 `project.root_attached`）；test/50 迁移回滚断言的目标版本号改为 SCHEMA_VERSION；test/30 取消回落用例的断言由页眉「未选择会话」的弱匹配改为真实的「选择项目」面板（页面积压赶走首帧时随机超时的根因，issue 04 曾把同一抖动记为环境问题）。
- **全量 `npm test`（最终一轮 2026-10-02）**：731 项中 **729 通过、1 跳过**（真实模型门控的既有跳过）、**1 失败**——08-approvals「DNS 在批准时固定」：本机 DNS 对不可解析名 60s 超时，干净 HEAD（e7b4d11 worktree）同路径复现，环境性既有失败与本单无关，如实记录。

**复跑步骤**

- 冒烟：`npx tsx .scratch/agent-direction/smoke-05-workspace-sessions.mts`（TMPDIR 可换工作区位置）。
- 离线：`npx tsx --test test/74-workspace-sessions.test.ts test/30-workspace-entry.test.ts test/66-control-seam.test.ts`；全量 `npm test`。

**同步**：`docs/runtime.md`（工作区入口与选择面板改写、数据布局 schema v19、验证状态表两行）、`docs/visual/control-protocol.html`（open_workspace op、project.root_attached 事件、工作区入口幂等键段落、op 计数更正为实际 79）、`docs/visual/storage-layout.html`（v19 与 root_* 归属说明）。

**与验收标准对应**

1. 可信入口打开目录复用/创建工作区并新建会话 → open_workspace + TUI 入口（test/30/74、冒烟 1/2/6）；TUI 列出/切换/恢复 → 工作区/旧项目面板与会话过滤（test/74 两产品用例）。
2. 真实目录身份判定 → root_* 归属 + sameDirIdentity + 唯一索引（test/74 别名/同名、冒烟 2/4）。
3. 根目录可多仓库 → 冒烟 1/test/74；普通列表排除角色群聊 → workspacePickerProjects + 认领后台拒绝（test/74）。
4. 保留旧项目兼容 → 认领路径 + 旧会话可读（test/74 adopt、冒烟 5）。
5. 旧 API/实例可读 → 旧 op 不变（test/74 legacy-ops）+ v18→v19 迁移（test/74 migrate）。
6. 端到端/类型检查/仓库验证、模拟与真实分列 → 上节。

### 2026-10-02：develop 最近五次提交评审

[评审记录](../review-develop-2026-10-02.md) 确认本工单存在三个待修复的 P2 问题：R1 旧项目认领绕过 dev+ino 身份去重，R2 SQLite 根目录冲突检测误用索引名，R5 混合旧项目的目录候选与后台认领条件不一致。三项均已通过临时复现确认，修复建议与验收条件见记录；本次仅登记评审结果。

### 2026-10-02：评审 P2 修复（R1/R2/R5）

- R1：attachProjectRoot 落库前先按 findProjectByRoot 目录身份去重——同一目录身份已归属他项目即 duplicate（含 realpath 不同、dev+ino 相同的挂载别名，冲突后不留归属与事件）；同项目相同身份幂等返回。
- R2：isRootDirClash 改按列名匹配（node:sqlite 对部分唯一索引实际报 UNIQUE constraint failed: projects.root_real，非索引名），与 isCreateRequestIdClash 同款；同 realpath 冲突经控制面返回 duplicate（outcome=rejected，不进入应答丢失处理），事务回滚不留新会话与归属。
- R5：findWorkspaceProjects 排除会话不全是普通 dev 的项目（与 runtime.openWorkspace 认领防御同款条件）——混合旧项目不作目录候选，路径入口不再自动发出必遭拒绝的认领请求；混合旧项目中普通会话的查看与切换（workspacePickerProjects）保持不变；纯角色、纯群聊项目仍受后台保护。
- 回归测试：test/74「attachProjectRoot：相同 dev+ino 的挂载别名认领冲突；同项目相同身份幂等」「认领已被占用的同 realpath 根目录返回 duplicate，不留会话与归属」「混合旧项目（dev 与群聊并存）不可认领，目录打开直接新建工作区」「findWorkspaceProjects：混合旧项目（dev 与角色/群聊并存）不充当目录候选」。

### 2026-10-02：第二轮评审

R1、R2、R5 已在 `87f1e63` 修复并通过复查；本轮补充验证了挂载别名身份冲突、真实 SQLite 异常转换，以及混合旧项目经真实 TUI 打开的完整路径。本工单未发现新增的可确认问题，验证范围见[评审记录](../review-develop-2026-10-02.md)。
