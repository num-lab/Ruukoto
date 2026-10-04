Status: ready-for-agent

# 07 — 运行文档、README 与部署文档里与代码不符的说法

**What to fix:** 把下列说法改成与当前代码一致。只改文档，不改行为；如果某条判断应该改代码而不是改文档，拆出独立工单。

来源：2026-10-03 可视化文档的更新与独立核查。核查时都以代码为准，`docs/visual/` 已按代码写。

## 清单

**docs/runtime.md**

- [ ] 「数据布局」写 ruukoto.db 是 schema v21，代码 `SCHEMA_VERSION` 是 24；目录清单漏了 `agent-work/`、`github-archive-manifest.json`、`spawn.log`、`tui/commands.sqlite`；`artifacts/` 的位置写得像在数据目录外。
- [ ] pending 目录写 0600，代码是目录 0700、文件 0600（`src/control/pending-requests.ts`）。README 两处同样要改。
- [ ] 「架构要点 · 工具可用性」的 main 清单漏了服务管理（`service`），见 `tool-availability.ts` 的 `SESSION_TOOL_CATEGORIES.main`。
- [ ] 「架构要点 · 审批闸门」没提 `service_manage` 也用审批记录快照作执行参数。
- [ ] 「自动重试与恢复」列出的只读集合比代码窄。重试门用的是 `tool-op-ledger.ts` 的 `hasNoWriteEffect`，覆盖 RULES 表里所有判为 no_effect 的工具。
- [ ] 「上下文选择」的视图顺序漏了继续来源与计划说明之间的 `[SubAgent 结果]` 块；系统提示写「四份之一」，代码 `SYSTEM_PROMPTS` 已有五份（多了 subagent）；上下文压缩的适用范围没写 SubAgent 子会话同样不压缩。
- [ ] 「通用 SubAgent 委派」需要改正四处：
  - 资料快照不在模型上下文里，而是子目录里的 `materials-<key>.txt`，由 SubAgent 自己 `read`；
  - 结果在父会话下一个任务开始时注入，并且先标记 `result_delivered_at` 再注入，不是「下一次父模型调用」；
  - 来源引用在登记事务与每次发送前核实，没有单独的启动核实，`verify` 只复核 `task_result` / `artifact` 两类；
  - ~~补写：重启后 SubAgent 子会话里排队的任务不会自动恢复（与 agent-direction 工单 15 的评论一致）。~~已被工单 15 的实施取代（2026-10-05）：代码行为已改为「拥有者/主 Agent 委派的排队执行任务重启定 interrupted(backend_restart)、不自动继续，SubAgent 补记结果后回可用；宿主固定评审的排队任务由编排器启动恢复自动继续；resume-queue 是 unverified 回 idle 的出口」，runtime.md「通用 SubAgent 委派 · 后台重启恢复」与「崩溃恢复」已按新行为描述，本项不再适用。
- [ ] 「结果协议」写普通取消「保留原因并归入 failed」。实际只有排队中取消会把原因写进 error_message；执行中取消的原因在 interrupt_reason，只进 failure 字段。
- [ ] 「Telegram · 发送」写「2xx 回执 → sent」，代码要求 `res.ok && json.ok`。另外，「429 按 retry_after」实际对任何带 retry_after 的错误都生效。
- [ ] 「IM 审批」：
  - 长期授权的查看与撤销同样先过当前入口身份核实；
  - 收件时没有钉版目标的命令不登记回执；
  - `/approve`、`/reject`、`/approve-standing` 成功后的回执不立即唤醒发送循环，要等下一轮扫描。
- [ ] 「漏过周期」列的未完成运行状态，漏了新闻运行的 pending / searching。
- [ ] 令牌变量的说法要改：runtime.md 说导出 `RUUKOTO_OWNER_TOKEN*` 的 shell「对两个产品都有认证能力」，实际两个后台各自生成令牌，导出的令牌只对来源产品有效。

**README.md**

- [ ] 「异常恢复」第 2 条说有排队任务的会话要拥有者 `resume-queue`。实际编排器会自动恢复以 `backend_restart` 暂停的角色会话，QQ 适配器会自动恢复群会话；只有普通开发会话和 SubAgent 子会话需要手动恢复。
- [ ] 「异常恢复」第 4 条说 continue「默认回到请求确认模式」，代码用的是会话默认访问模式。
- [ ] 目录清单补上 agent 目录下的 `summary-model.json` 与 `skills/`。

**ADR 与 CONTEXT.md**

- [ ] ADR 0017 与 runtime.md 写「受限后端缺失时拒绝启动受限任务」，读起来像提交时就拒绝。实际上受限任务照常入队，到启动工作进程时才失败。行为本身的问题见本目录工单 02，这里只改措辞。
- [ ] ADR 0020 §5 写「worktree 复用」「12–15」，worktree 属于 16–17。CONTEXT.md 把同级通信写成工单 12，实际是 13。
- [ ] CONTEXT.md「参考块」定义没有收录 `[SubAgent 结果]` 块。
- [ ] ADR 0008 的审批入口名 `Driver.awaitApproval`，现在是 `ApprovalGate.request`。

**部署文档**

- [ ] `deploy/systemd/README.md` 第 1 步没有建 `qq-work/`。不能靠把 `/var/lib/ruukoto` 改归后台账户来解决，否则服务 helper 会以 `deployment_invalid` 拒绝。应直接 `install -d` 建出 `qq-work`。
- [ ] `deploy/worker-image/README.md` 说「git 未装入」，Dockerfile 已经安装。README 与 Dockerfile 注释还把容器 uid/gid 1000 写成固定值，实际取自 `RUUKOTO_CONTAINER_UID/GID`。
- [ ] `src/cli.ts` 顶部注释说「数据目录默认 ~/.ruukoto」，实际 `~/.ruukoto` 是档案根，数据目录默认在它下面的 `data/`。

## 验收标准

- [ ] 清单逐条完成，或在本工单 Comments 里说明为什么保留原文。
- [ ] 改完后 `npx tsx --test test/67-visual-docs.test.ts` 仍然通过（文档措辞改动不应影响图解页）。
