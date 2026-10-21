import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { personalBackgroundToolNames } from "./personal-background-processes.ts";
import { personalQuestionToolNames } from "./personal-questions.ts";

// Note: 见 .agents/notes/implemented/feature/2026-10-21-personal-owner-questions.md
export async function personalMainToolNames(tx: Tx, conversationId: ConversationId, availableNames: readonly string[], requestId?: string) {
  const names = await personalQuestionToolNames(tx, conversationId, availableNames);
  return personalBackgroundToolNames(tx, conversationId, names, requestId);
}
