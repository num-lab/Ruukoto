import type { OpParams, OpResult } from "@ruukoto/control/ops.ts";
import type { HistoryEntryView } from "@ruukoto/core/history.ts";
import { HistoryRecovery } from "@ruukoto/view/history-recovery.ts";
import { ViewState } from "@ruukoto/view/state.ts";
import { utf8ByteLength } from "@ruukoto/view/utf8.ts";

export async function runRecovery() {
  const state = new ViewState(), offsets: number[] = [], pieces = ["中文", "🙂", "尾"];
  let changed = 0;
  const recovery = new HistoryRecovery({
    state, entryPageBytes: 6, completeEntry: () => true, isMissingEntry: () => false,
    changed: () => { ++changed; }, entryFailed: error => { throw error; },
    request: async (op, params) => {
      if (op !== "read_history_entry") throw new Error(`非预期读取：${op}`);
      const offset = (params as OpParams<"read_history_entry">).offset ?? 0;
      offsets.push(offset);
      const index = [0, 6, 10].indexOf(offset), text = pieces[index];
      if (text === undefined) throw new Error("UTF-8 偏移错误");
      const entry: HistoryEntryView = { entryId: "entry", taskId: null, inputPurpose: "user", parentId: null, role: "assistant", text,
        timestamp: "2026-10-23T00:00:00Z", offset, totalBytes: 13, truncated: offset + utf8ByteLength(text) < 13,
        toolCalls: [], toolCallId: null, toolName: null, isError: null, hasNonTextContent: false };
      return entry as OpResult<typeof op>;
    },
  });
  await recovery.loadEntry("session", "entry", recovery.generation, "task");
  const entry = state.openSession("session").flow.historyEntries[0];
  return { offsets, changed, text: entry.text, truncated: entry.truncated, ready: recovery.historyReady("session", "task") };
}
