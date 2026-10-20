import { ROOT_CONVERSATION_ID, type Tx } from "@earendil-works/pi-durable";
import { PersonalError } from "./personal-error.ts";
import { personalLocalPermission } from "./personal-local-records.ts";
import { isPersonalImRequest, PersonalTelegramReceiptDoc } from "./personal-telegram-records.ts";
import { permissionSnapshot, PersonalPermissionsDoc, telegramSourceActive } from "./personal-permissions.ts";
import { personalScheduledSource, requireScheduledSourceReady } from "./personal-scheduler-records.ts";
import { verifyPersonalScheduleScope } from "./personal-schedule-scope.ts";

export async function personalSourceSubmission(tx: Tx, requestId: string) {
  return (await personalScheduledSource(tx, requestId))?.submission ?? await tx.submissionByRequest(ROOT_CONVERSATION_ID, requestId);
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-18-personal-durable-scheduled-work.md
export async function personalSource(tx: Tx, requestId: string, options?: { active?: boolean; invalidCode?: string }) {
  const scheduled = await personalScheduledSource(tx, requestId);
  if (scheduled) {
    if (options?.active) { await requireScheduledSourceReady(tx, requestId); await verifyPersonalScheduleScope(tx, scheduled.scope); }
    return { ...scheduled, scheduled: true as const };
  }
  const submission = await tx.submissionByRequest(ROOT_CONVERSATION_ID, requestId), entry = submission?.entry && await tx.entry(submission.entry);
  if (submission?.type !== "input" || !entry || entry.kind !== "pi.user" || entry.conversationId !== ROOT_CONVERSATION_ID) throw new PersonalError(options?.invalidCode ?? "source_invalid", "原工作输入无法核实，已停止操作；请查询原工作并保留档案。");
  const receipt = isPersonalImRequest(requestId) ? (await tx.doc(PersonalTelegramReceiptDoc, requestId, null)).receipt : undefined;
  const telegram = receipt && permissionSnapshot(receipt);
  if (isPersonalImRequest(requestId) && (!telegram || receipt?.submissionId !== submission.id || options?.active && !await telegramSourceActive(tx, telegram))) throw new PersonalError(options?.invalidCode ?? "source_inactive", "原拥有者入口或权限无法核实，已停止操作；请从原入口查询。");
  if (options?.active && !["placed", "done"].includes(submission.status)) throw new PersonalError(options?.invalidCode ?? "source_inactive", "原工作输入已停止，未执行后续操作；请查询原工作。");
  const permission = telegram ?? await personalLocalPermission(tx, requestId) ?? await tx.doc(PersonalPermissionsDoc);
  return { submission, entry, source: { requestId, submissionId: submission.id, entryId: entry.id }, permission: { mode: permission.mode, version: permission.version }, ...(telegram ? { telegram } : {}), scheduled: false as const };
}
