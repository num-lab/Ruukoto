/**
 * 控制面接缝（架构工单 07）：TUI 的 op 表与服务端一致。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { TuiOp } from "../src/control/ops.ts";
import { routeResponder, startTestRuntime } from "./helpers/testkit.ts";

/** 与 TuiOps 的键一一对应（多写、少写都过不了类型检查）。 */
const TUI_OPS: Record<TuiOp, true> = {
  get_task: true, find_task: true, list_tasks: true, read_task_events: true, read_history: true, read_history_entry: true,
  get_tool_op_params: true, get_confirmation_params: true, read_artifact: true, get_session: true, list_models: true,
  set_session_model: true, set_session_mode: true, create_project: true, create_session: true, submit: true, continue: true,
  interrupt: true, cancel: true, resume_queue: true, respond_confirmation: true, list_selection_records: true,
  get_context_breakdown: true, list_prompt_requests: true, read_prompt_snapshot: true, search_history: true, list_skills: true,
  list_memories: true, get_memory: true, revoke_memory: true, restore_memory: true, qq_status: true, qq_set_enabled: true,
  qq_inbox_list: true, qq_outbox_list: true,
};

test("op 表：表里每个 op 服务端都认得（空参数只会被参数校验拒绝，不回 unknown_op）", async () => {
  const t = await startTestRuntime("tui-ops", routeResponder([]));
  try {
    for (const op of Object.keys(TUI_OPS)) {
      const code = await t.client.request(op, {}).then(() => null, (err: { code?: string }) => err.code);
      assert.notEqual(code, "unknown_op", op);
    }
  } finally {
    await t.shutdown();
  }
});
