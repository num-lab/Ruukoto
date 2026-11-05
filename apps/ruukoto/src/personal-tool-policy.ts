import { ROOT_CONVERSATION_ID, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import { personalBackgroundToolNames } from "./personal-background-processes.ts";
import { personalQuestionToolNames } from "./personal-questions.ts";
import { PERSONAL_TOOL_NAMES } from "./personal-tools.ts";
import { PERSONAL_APP_DATA_TOOLS } from "./personal-app-data.ts";
import { PersonalError } from "./personal-error.ts";
import { PERSONAL_MAIN_TOOL_ROUNDS, personalCoordinationTailRounds } from "./personal-coordination.ts";

// Waiting business tools execute in children; source-bound queries and controls remain in main.
// Note: See .agents/notes/implemented/feature/2026-10-21-personal-owner-questions.md
export async function personalMainToolNames(tx: Tx, conversationId: ConversationId, availableNames: readonly string[], requestId?: string) {
  const names = await personalQuestionToolNames(tx, conversationId, availableNames);
  const allowed = await personalBackgroundToolNames(tx, conversationId, names, requestId);
  if (conversationId !== ROOT_CONVERSATION_ID) return allowed;
  const migrated = allowed.filter(name => ![...PERSONAL_TOOL_NAMES, ...PERSONAL_APP_DATA_TOOLS, "publish_output", "mcp_call", "service_inspect", "service_restart", "run_command", "browser", "process_start"].includes(name));
  const rounds = await personalCoordinationTailRounds(tx, conversationId);
  if (rounds > PERSONAL_MAIN_TOOL_ROUNDS) throw new PersonalError("coordination_rounds", "本轮协调批次预算已耗尽，停止模型请求；请查询原输入状态。");
  return rounds === PERSONAL_MAIN_TOOL_ROUNDS ? [] : migrated;
}
