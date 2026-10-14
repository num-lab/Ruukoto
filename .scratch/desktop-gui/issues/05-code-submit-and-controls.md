# Code：提交、模型、会话默认模式、中断／取消／继续、恢复队列

Status: plan-review

## 目标与边界

实现[规格 R9](../spec.md)中的写操作：输入框提交、按会话切换模型、切换会话默认模式、中断／取消／继续、队列暂停横幅与恢复。

## 方案

1. 提交走主进程的 `SubmissionGuard` 与 `PendingRequestStore`（按目标分开存放在应用数据目录），保证应答丢失后按原 `request_id` 核实，不换键重复提交；`submit` 不作为普通透传 op。
2. 模型选择用 `list_models` 与 `set_session_model`（带 `expected_version`）；提交携带当前会话的 `model_selection`。
3. 模式选择放在模型选择旁，调用 `set_session_mode`；标签沿用 TUI 的英文名。
4. `interrupt`、`cancel`、`continue` 对应任务操作；会话 `session.queue_paused` 时显示横幅，“恢复”调用 `resume_queue`；旧排队任务缺模型时，先让拥有者补选，与 TUI 一致。
5. 请求失败按四类结果分类显示：`unknown` 与 `disconnected` 提示“结果未知”，不自动重发。
6. 放行名单加入本单调用的 op。

## 进展与交接

- 当前：方案已经拥有者确认，待独立方案审查；实现未开始。
- 下一步：方案审查者核对 TUI 中恢复队列补选模型的流程，确认桌面端复用同一组 op。
- 基点：`develop` @ `4611eff`。依赖 04。
- 阻塞：04 未完成。

## 验收与证据

工程待验证。单测：主进程提交路径在应答丢失后按原 `request_id` 核实；放行名单随新增 op 更新。

人工检查（外部验收）：提交后流式显示；切换模型与模式后下一次提交生效，TUI 同步看到变化；中断、取消、继续各一次；重启后台后出现暂停横幅，恢复后队列继续。

## Comments

2026-10-15：拥有者完成 grilling 并确认整体方案，本单由规划阶段建立。
