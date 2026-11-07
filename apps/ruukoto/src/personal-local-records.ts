import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { defineDocFamily, defineEntry, ROOT_CONVERSATION_ID, type EntryId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { PersonalPermissionsDoc } from "./personal-permissions.ts";
import type { PersonalServiceMode } from "./personal-service-operations.ts";
import { PersonalError } from "./personal-error.ts";
import type { PersonalDesktopAttachment } from "@ruukoto/view/personal-protocol.ts";
import { PersonalMediaMessageDoc, nativeMetadata, personalMediaInput } from "./personal-media.ts";

export const LocalInputDoc = defineDocFamily<{ digest: string; text?: string; attachments?: PersonalDesktopAttachment[]; work?: TaskId; permission?: { mode: PersonalServiceMode; version: number }; accepted?: EntryId }, string>({ kind: "ruukoto.local-input", scope: "session", version: 1, family: true, initial: (digest: string) => ({ digest }) });
export const LocalInputAdmission = defineEntry<{ requestId: string; digest: string; permission: { mode: PersonalServiceMode; version: number } }>("ruukoto.local-input-admission");

export const personalInputDigest = (input: string, work?: TaskId, attachments?: PersonalDesktopAttachment[]) => createHash("sha256").update(JSON.stringify(attachments?.length ? [input, work ?? null, attachments] : work === undefined ? input : [input, work])).digest("hex");

/** Pin native authority before admission; never infer permissions for an already accepted input. */
export async function personalLocalInput(tx: Tx, requestId: string, input: string, attachments?: PersonalDesktopAttachment[]) {
  const digest = personalInputDigest(input, undefined, attachments), value = await tx.doc(LocalInputDoc, requestId, digest);
  if (value.digest !== digest || value.work !== undefined || value.attachments !== undefined && !isDeepStrictEqual(value.attachments, attachments)) throw new PersonalError("input_conflict", "同一请求的正文、附件或归属不一致，请核实原输入。");
  if (attachments?.length) { value.text = input; value.attachments = attachments.map(ref => ({ ...ref })); }
  if (!value.accepted && !await tx.submissionByRequest(ROOT_CONVERSATION_ID, requestId)) {
    const permission = await tx.doc(PersonalPermissionsDoc);
    value.permission = { mode: permission.mode, version: permission.version };
    value.accepted = (await tx.appendEntry(LocalInputAdmission, ROOT_CONVERSATION_ID, { data: { requestId, digest, permission: value.permission } })).id;
  }
}

export async function personalLocalPermission(tx: Tx, requestId: string) {
  const value = await tx.doc(LocalInputDoc, requestId, "");
  if (!value.permission && value.accepted === undefined) return;
  const admission = value.accepted && await tx.entry(LocalInputAdmission, value.accepted), submission = await tx.submissionByRequest(ROOT_CONVERSATION_ID, requestId);
  const message = submission?.entry && (await tx.entry(submission.entry))?.model?.[0];
  const media = value.attachments?.length ? (await tx.doc(PersonalMediaMessageDoc, requestId, null)).message : undefined;
  const validContent = value.attachments?.length ? media?.source.platform === "desktop" && media.body === value.text && isDeepStrictEqual(nativeMetadata(media), value.attachments) && message?.role === "user" && isDeepStrictEqual(message.content, personalMediaInput(media)) && personalInputDigest(value.text!, undefined, value.attachments) === value.digest : message?.role === "user" && typeof message.content === "string" && personalInputDigest(message.content) === value.digest;
  if (!value.permission || !["auto-review", "confirm", "full_access"].includes(value.permission.mode) || !Number.isSafeInteger(value.permission.version) || value.permission.version < 1 || !admission || admission.conversationId !== ROOT_CONVERSATION_ID || !isDeepStrictEqual(admission.data, { requestId, digest: value.digest, permission: value.permission }) || !submission?.entry || admission.id >= submission.entry || !validContent) throw new PersonalError("input_permission_invalid", "原本机输入的权限接纳无法核实，未执行；请保留档案并检查原输入。");
  return value.permission;
}
