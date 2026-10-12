/** 管理器直调用例显式播种工具调用期间的来源状态；真实模型调用不经过这里。 */
import type { Runtime } from "@ruukoto/runtime/runtime.ts";
import type { SubAgentDelegateInput, SubAgentMessageInput } from "@ruukoto/runtime/subagents.ts";

async function withActiveSource<T>(rt: Pick<Runtime, "store">, taskId: string, run: () => Promise<T>): Promise<T> {
  const source = rt.store.getTask(taskId);
  const seeded = source?.status === "completed";
  if (seeded) rt.store.db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(taskId);
  try {
    return await run();
  } finally {
    if (seeded) rt.store.db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ? AND status = 'running'").run(taskId);
  }
}

export function delegateFromActiveTask(rt: Pick<Runtime, "store" | "subagents">, input: SubAgentDelegateInput) {
  return withActiveSource(rt, input.parentTaskId, () => rt.subagents!.delegate(input));
}

export function messageFromActiveTask(rt: Pick<Runtime, "store" | "subagents">, input: SubAgentMessageInput) {
  return withActiveSource(rt, input.senderTaskId, () => rt.subagents!.message(input));
}
