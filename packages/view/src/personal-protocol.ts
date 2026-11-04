export type PersonalDesktopToolCall = { id: string; name: string; arguments: string; truncated: boolean };
export type PersonalDesktopBlock = { type: "text" | "thinking"; text: string; truncated: boolean } | ({ type: "toolCall" } & PersonalDesktopToolCall);
export type PersonalDesktopMessage = { role: "user" | "assistant" | "toolResult"; text: string; thinking?: string; toolCalls?: PersonalDesktopToolCall[]; blocks?: (PersonalDesktopBlock & { index: number })[]; partial: boolean; truncated: boolean; timestamp: number; toolCallId?: string; toolName?: string; isError?: boolean };
export type PersonalTimelineEntry = PersonalDesktopMessage & { entry: number; conversation: number; kind: string; input?: { requestId: string; submission: number; status: "queued" | "placed" | "done" | "unanswered"; historyEntry?: number } };
export type PersonalTimelinePage = { through: number; items: PersonalTimelineEntry[]; nextCursor?: string };
export type PersonalDesktopApproval = { operation: number; occurrence: number; admission: number; kind: "read_file" | "write_file" | "http_request" | "web_search" | "list_files" | "search_files"; target: string; targetTruncated: boolean; approval: "pending" | "approved" | "rejected" | "unneeded"; observed: boolean; started: boolean; effect: "returned" | "not_executed" | "no_write" | "effect_unknown"; code: string; stopped: boolean; canDecide: boolean; notice?: string; work?: number; decisionEntry?: number };
export type PersonalDesktopWork = { ref: { taskId: number; agentId: number; requestId: string }; label: string; content: string; state: string; cancelRequested: boolean; stopVerified: boolean; closed: boolean; progress: { accepted: number; modelRead: number; completed: number; accounted: number }; delegation?: number };
export type PersonalDesktopDelegation = { ref: { entryId: number }; content: string; state: string; cancelRequested: boolean; total: number; active: number; unverified: number; paused: boolean; report?: { delivery: string; state: string; publication?: number } };
export type PersonalDesktopPage<T> = { items: T[]; total: number; nextOffset?: number };
export type PersonalDesktopState = { v: 1; revision: number; approvals: PersonalDesktopPage<PersonalDesktopApproval>; works: PersonalDesktopPage<PersonalDesktopWork>; delegations: PersonalDesktopPage<PersonalDesktopDelegation>; approvalUpdates?: PersonalDesktopApproval[] };
export type PersonalDesktopOperation = { v: 1; revision: number; operation: number; admission: number; summary: PersonalDesktopApproval; text: string; offset: number; nextOffset?: number };
export type PersonalDesktopTool = { callId: string; name: string; status: "pending" | "running" | "done"; taskId?: number; entry?: number; output?: string; truncated: boolean; parentCallId?: string; parentTaskId?: number };
export type PersonalDesktopLive = {
  model?: { provider: string; modelId: string };
  run?: { inputs: number[]; total: number };
  generation?: { attempt: number; message?: PersonalDesktopMessage; retry?: { at: number; error: string }; deferred?: { pollAt: number } };
  tools: PersonalDesktopTool[];
  toolCount: number;
  inbox: { id: number; mode: string }[];
  inboxCount: number;
};
export type PersonalDesktopChange =
  | { type: "text_start" | "thinking_start" | "toolcall_start" | "block"; contentIndex: number; block: PersonalDesktopBlock }
  | { type: "text_delta" | "thinking_delta"; contentIndex: number; delta: string; truncated: boolean }
  | { type: "toolcall_delta"; contentIndex: number; path: readonly (string | number)[]; delta: string; truncated: boolean }
  | { type: "message"; message: PersonalDesktopMessage };
export type PersonalDesktopEvent =
  | { type: "personal_state"; state: PersonalDesktopState }
  | { type: "run_start" | "run_end"; inputs: number[]; total: number }
  | { type: "turn_start" | "turn_end" }
  | { type: "message_start"; message: PersonalDesktopMessage }
  | { type: "message_update"; changes: PersonalDesktopChange[] }
  | { type: "message_end" | "entry_appended"; entry: PersonalTimelineEntry }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; taskId?: number; parentToolCallId?: string; parentTaskId?: number; arguments: string; truncated: boolean }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; taskId?: number; parentToolCallId?: string; parentTaskId?: number; output?: { trimStart?: number; append?: string; set?: string }; truncated: boolean }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; taskId?: number; parentToolCallId?: string; parentTaskId?: number; entry?: PersonalTimelineEntry; result?: { text: string; truncated: boolean; isError: boolean } }
  | { type: "inbox_update"; items: { id: number; mode: string }[]; total: number }
  | { type: "submission"; record: { id: number; status: string; entry?: number; answer?: number } }
  | { type: "auto_retry_start"; attempt: number; at: number; errorMessage: string }
  | { type: "auto_retry_end"; attempt: number }
  | { type: "deferred_poll"; pollAt: number }
  | { type: "agent_changed"; model?: { provider: string; modelId: string } }
  | { type: "task_failed"; taskId: number; kind: string; message: string }
  | { type: "compaction_start"; taskId: number; reason: string; blocking: boolean }
  | { type: "compaction_end"; taskId: number; reason: string; error?: string };
export type PersonalDesktopFrame = { v: 1; runId: string; subscription: string; seq: number } & (
  | { type: "snapshot"; timeline: PersonalTimelinePage; live: PersonalDesktopLive; state?: PersonalDesktopState }
  | { type: "events"; events: PersonalDesktopEvent[] }
);
