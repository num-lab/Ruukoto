/**
 * 工具操作账本（架构工单 05）：工具操作的已知结果与效果未知只在这里写。
 *
 * - 结果与 `task.tool_result` 事件成对写入，落库与事件是同一句；条件更新以
 *   先写者为准，重复补记不重复发布；
 * - 效果未知：操作标记 + `task.tool_effect_unknown` + 任务标记，已标记即跳过。
 *
 * 调用方负责事务（重启恢复在恢复事务内调用，`Db.tx` 不能嵌套）。
 */

import type { Store } from "../core/store.ts";
import type { EditStats } from "../core/types.ts";

type TaskRef = { id: string; sessionId: string };

export class ToolOpLedger {
  constructor(readonly store: Store) {}

  recordResult(
    task: TaskRef,
    opId: string,
    summary: string,
    isError: boolean,
    extra: { artifactIds?: string[]; editStats?: EditStats } = {},
  ): boolean {
    if (!this.store.recordToolResult(opId, summary, isError)) return false;
    this.store.appendEvent(
      {
        type: "task.tool_result",
        taskId: task.id,
        toolOpId: opId,
        summary,
        isError,
        artifactIds: extra.artifactIds ?? [],
        ...(extra.editStats ? { editStats: extra.editStats } : {}),
      },
      { taskId: task.id, sessionId: task.sessionId },
    );
    return true;
  }

  markEffectUnknown(task: TaskRef, opId: string): boolean {
    const op = this.store.getToolOp(opId);
    if (!op || op.effectUnknown) return false;
    this.store.markToolOpEffectUnknown(opId);
    this.store.appendEvent(
      { type: "task.tool_effect_unknown", taskId: task.id, toolOpId: opId, toolName: op.toolName },
      { taskId: task.id, sessionId: task.sessionId },
    );
    this.store.setEffectUnknown(task.id);
    return true;
  }
}
