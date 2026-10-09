Status: resolved
Depends on: 01, 04

# main 委派 coding

## 目标

让 main 在拥有者明确提出编码、仓库、PR、测试或修改请求时自动委派 coding，并把结果带回主会话。

## 实现范围

- main 的委派工具只能创建固定 `coding` 角色的子任务。
- 委派输入固定项目、工作目录、请求正文、访问模式和资料引用；模型不能任意扩大范围。
- coding 使用独立 Project/Session/工作目录，复用现有编码工具和审批边界。
- 结果协议包含摘要、产物、测试状态、失败原因、是否需要 owner 和 effect 状态。
- 结果事件唤醒 main；大正文通过产物引用读取，不全部塞入 main 上下文。
- 读取/分析任务最多自动重试一次；写文件、发布评论和未知效果任务不自动重试。
- 第一阶段只生成分析/修改草稿，GitHub 发布仍需 owner 可信入口。

## 验证

- main 能创建 coding 子任务并在完成后收到结果；
- coding 不能读取 main 私人应用数据或修改角色权限；
- coding 任务的工作区和访问模式仍由宿主固定；
- 任务中断、超时、失败和结果未知都能回传 main；
- 现有编码、审批、产物和 TUI 回归通过。

## Comments

### 2026-09-24：实施前确认与计划

拥有者确认：① 子任务结果**不**自动发回 Telegram，遵守 ADR 0011 第 2 条（子任务唤醒不产生 owner 回复），结果回到 main 会话；② coding 只在宿主固定的角色工作目录 `agent-work/coding/` 内工作，需要仓库时自行 `git clone`，不做仓库白名单；③ `analyze` 不是只读沙箱（confirm 模式本就允许工作区内写入），只用于重试判定与结果标注。

计划（测试 seam：Runtime 公共接口 + mock 模型的脚本化工具调用与实际请求载荷，沿用 test/27）：

1. 新工具类别 `delegation`（仅 main），`src/agent/delegation-tools.ts` 两个工具：
   - `coding_delegate`：模型只给 `request / mode(analyze|draft) / key / materials?`；宿主固定目标 coding、角色工作目录、`confirm` 模式、截止时间（父任务开始 + 60 分钟，确定值以保证幂等）。`materials` 复用 `createSourceResolver` 在委派时解析为文本快照，超限拒绝不截断。只有拥有者发起的 main 任务可委派（拥有者直接提交，或 telegram 入站事件）；定时唤醒、子任务唤醒触发的任务拒绝。每个父任务最多 3 个委派。
   - `coding_result`：只读，仅限父任务在 main 会话的子任务；返回结构化结果，最终回答与产物分页读取。
   - 停止/恢复：`coding_delegate` 按子任务是否存在核实，不标 `effect_unknown`；`coding_result` 只读。
2. 编排器：`delegate()` 固定 `confirm`（不继承 coding 会话默认模式）；委派正文首行为宿主模板 `[委派 coding · <mode>]`。
3. 结果协议写入既有 `result_ref` JSON（不迁移 schema，保留 `sessionId/taskId`）：模式、产物、测试状态（coding 自报）、失败原因、是否需要拥有者（宿主判定 + 自报）、effect 状态、重试关系。唤醒文案列出这些字段并提示 `coding_result`。
4. 重试：`analyze` 且状态 `failed`（不含取消/超时/中断）、无效果未知操作、无已批准审批、本身不是重试 → 先以 `<原键>:retry` 提交一次重试（截止时间 = 首次结束 + 60 分钟），再记录首次结果并不唤醒；待唤醒扫描排除已有重试的子任务。
5. 验证：`test/39-coding-delegation.test.ts`；回归 test/27、38、14、37；`npm run typecheck`、`npm test`。tx 在国内，Linux 容器隔离不在本次执行（与 issue 04 同）。

### 2026-09-24：实现与边界验证

已实现 `coding_delegate / coding_result`，复用既有任务、产物、资料授权与审批路径，不增加依赖或 schema 迁移。子任务及结果唤醒均固定 `confirm`；结果只回 main，不继承 Telegram 自动回复授权。资料在委派时按 main 权限解析成文本快照，原始引用 ID 不传给 coding。

自动重试增加实际操作核实：只有首次失败的 `analyze`、无已批准/已消费审批、无未知效果，且已登记的工具全部属于已知只读集合并有结果，才重试一次。`bash`、MCP、写文件、记忆写入或未知工具均不自动重试；不把 `analyze` 意图当作只读保证。复用原子任务键与固定截止时间恢复，只唤醒最终结果一次。

结果包含测试自报、产物、失败原因、是否需要拥有者及效果状态。回答直接从任务历史按 UTF-8 字节分页，覆盖超过 256 KiB 的正文；产物分页保持字符边界，并拒绝无关任务产物与宿主上下文快照。回归发现并修复了 Telegram 恢复的幂等标志问题，沿用核心存储的 `result_summary` 完成标志。

实际补做了 tx Linux 验证：在独立临时目录、现有 Docker 镜像与执行 UID 下，工具容器基础冒烟 9/9、canary 隔离探针 21/21 通过。模拟核心库、main 应用数据、模型凭据、服务凭据和 owner token 均不可经 read/bash/符号链接及 `/proc/1/root` 读取；宿主 canary 环境变量、Docker socket 与网络出口不可达，工作区读写正常。现有镜像 worker 与当前源码离线打包的 SHA-256 一致，临时目录和容器已清理。此项验证实际 confirm 工具容器边界，不等同于完整委派或真实 Telegram/GitHub 部署验收。

`code-review` 以 issue 04 提交 `cfc8fdc` 为基线，独立检查 Standards 与 Spec。Standards 发现运行中中间消息被误当作最终回答，已将最终回答读取限制为 `completed`；Spec 发现重试创建被拒阻断恢复、可变资料破坏同参幂等、长自报原因漏读三项问题，均已修复并保留回归。资料幂等现按持久化的原始参数摘要核对，同参复用首次快照；长报告完整分页识别后才限制原因长度；重试不能创建时仍记录原始失败与需要拥有者原因并继续恢复。复核未发现遗留问题。

最终验证：`npm run typecheck` 通过；`npm test` 共 407 项，406 通过、0 失败、1 跳过（默认关闭的真实模型连通性测试，需 `RUN_MODEL_CHECK=1`）。包含新增的委派、权限、资料快照、结果分页、实际写入后禁止重试、停止核实与崩溃恢复回归，以及既有编码、审批、产物、Telegram、调度器和 TUI 测试。`git diff --check` 通过。
