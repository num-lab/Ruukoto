import type { ConnectResult } from "@ruukoto/control/protocol.ts";
import type { PersistentEvent } from "@ruukoto/core/types.ts";
import { ViewState } from "@ruukoto/view/state.ts";

const at = "2026-10-15T00:00:00Z";
const event = (seq: number, body: PersistentEvent["body"]): PersistentEvent => ({
  seq, body, sessionId: "session", taskId: "task", createdAt: at,
});

export function runProjection() {
  const snapshot: ConnectResult = {
    seq: 10, replay: [],
    snapshot: {
      instanceId: "instance", execution: { backend: "native", note: "" },
      defaultModel: { provider: "mock", id: "mock", name: "Mock", thinkingLevel: "off" },
      projects: [{ id: "project", name: "工作区", rootDir: null, createRequestId: null, instructionFiles: [], webSearch: "enabled", settingsVersion: 1, createdAt: at }],
      sessions: [{ id: "session", projectId: "project", workspaceProjectId: null, name: null, branchSource: null,
        kind: "dev", cwd: "/work", cwdReal: "/work", cwdDev: 1, cwdIno: 1, piSessionId: "pi-session", sessionFile: null,
        confirmTools: [], createRequestId: null, modelSelection: null, modelSelectionVersion: 0,
        defaultAccessMode: "confirm", defaultAccessModeVersion: 0, queueState: "active", queuePauseReason: null, createdAt: at }],
      tasks: [{ id: "task", sessionId: "session", requestId: "request", input: "中文🙂", inputPurpose: "user", modelSelection: null,
        submissionDigest: null, status: "running", accessMode: "confirm", planMode: false, permissionVersion: 1,
        sourcePermissionVersion: null, grantedPaths: [], pendingAccessMode: null, interruptReason: null,
        cancelRequested: false, effectUnknown: false, errorMessage: null, historyEntryIds: [], resumesTaskId: null,
        agentId: null, parentTaskId: null, sourceEventId: null, deadline: null, resultSummary: null, resultRef: null,
        workId: null, subAgentId: null, readScope: null, resultDeliveredAt: null, createdAt: at, startedAt: at, endedAt: null }],
      confirmations: [], artifacts: [], previews: {},
    },
  };
  const state = new ViewState();
  state.applySnapshot(snapshot, false);
  const fragment = (seq: number, text: string, offset: number) => event(seq, {
    type: "task.output_fragment", taskId: "task", sessionId: "session", messageId: "message",
    text, offset, totalBytes: 10, truncated: false, partial: true,
  });
  const first = fragment(11, "中文", 0);
  const second = fragment(12, "🙂", 6);
  for (const item of [second, first, first, second]) state.applyEvent(item, "replay");
  const streamed = state.openSession("session").flow.items.find((entry) => entry.kind === "message" && entry.role === "assistant");
  state.applyEvent(event(13, { type: "task.awaiting_confirmation", taskId: "task", confirmationId: "approval",
    toolOpId: "operation", toolName: "bash", params: { command: "中文🙂" }, scope: { kind: "tool", workspaceOnly: true } }), "live");
  state.applyEvent(event(14, { type: "task.output_entry", taskId: "task", sessionId: "session", entryId: "answer",
    sessionFile: "/history.jsonl", role: "assistant", messageId: "message" }), "replay");
  state.installHistoryPage("session", { fileAvailable: true, hasPartialTail: false, nextBefore: null, entries: [{
    entryId: "answer", taskId: "task", inputPurpose: "user", parentId: null, role: "assistant", text: "中文🙂", timestamp: at,
    offset: 0, totalBytes: 10, truncated: false, toolCalls: [], toolCallId: null, toolName: null, isError: null, hasNonTextContent: false,
  }] }, "replace");
  state.appendEntryView("session", { ...state.openSession("session").flow.historyEntries[0], text: "中", truncated: true });
  const messages = state.openSession("session").flow.items.filter((entry) => entry.kind === "message");
  return {
    streamed: streamed?.kind === "message" ? { text: streamed.text, totalBytes: streamed.totalBytes, truncated: streamed.truncated } : null,
    messages: messages.map(({ text, totalBytes, truncated, streaming }) => ({ text, totalBytes, truncated, streaming })),
    paramsBytes: state.pendingApprovals()[0]?.paramsBytes,
    status: state.activeTaskFor("session")?.status,
  };
}
