import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { defineDoc, defineEntry, ROOT_CONVERSATION_ID, type EntryId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { PersonalError } from "./personal-error.ts";

export type PersonalDirectory = { path: string; dev: number; ino: number };
export type PersonalClaimOwner = { kind: "background" | "command" | "file"; operation: TaskId };
export type PersonalDirectoryClaim = { owner: PersonalClaimOwner; directory: PersonalDirectory; acquired: EntryId; released?: EntryId };
export const PersonalDirectoryClaimsDoc = defineDoc<{ claims: PersonalDirectoryClaim[] }>({ kind: "ruukoto.directory-claims", scope: "session", version: 1, initial: () => ({ claims: [] }) });
const DirectoryClaim = defineEntry<{ owner: PersonalClaimOwner; directory: PersonalDirectory; action: "acquire" | "release"; acquired?: EntryId }>("ruukoto.directory-claim");

export function personalDirectoriesConflict(a: PersonalDirectory, b: PersonalDirectory): boolean {
  return a.dev === b.dev && a.ino === b.ino || a.path === b.path || a.path.startsWith(b.path.endsWith(path.sep) ? b.path : b.path + path.sep) || b.path.startsWith(a.path.endsWith(path.sep) ? a.path : a.path + path.sep);
}

// Note: 见 .agents/notes/implemented/feature/2026-10-21-personal-background-processes.md
export async function acquirePersonalDirectory(tx: Tx, owner: PersonalClaimOwner, directory: PersonalDirectory) {
  const doc = await tx.doc(PersonalDirectoryClaimsDoc), existing = doc.claims.find(value => isDeepStrictEqual(value.owner, owner));
  if (existing) {
    if (existing.released || !isDeepStrictEqual(existing.directory, directory)) throw new PersonalError("directory_claim_invalid", "原目录认领已结束或身份不符，未执行；请查询原操作。");
    return existing.acquired;
  }
  if (doc.claims.some(value => !value.released && personalDirectoriesConflict(value.directory, directory))) throw new PersonalError("directory_claim_busy", "目录仍被命令、文件写入或会话后台占用；请先停止并核实原执行，勿换工作重试。");
  const entry = await tx.appendEntry(DirectoryClaim, ROOT_CONVERSATION_ID, { data: { owner, directory, action: "acquire" } });
  doc.claims.push({ owner, directory, acquired: entry.id });
  return entry.id;
}

export async function releasePersonalDirectory(tx: Tx, owner: PersonalClaimOwner) {
  const claim = (await tx.doc(PersonalDirectoryClaimsDoc)).claims.find(value => isDeepStrictEqual(value.owner, owner));
  if (!claim) throw new PersonalError("directory_claim_invalid", "原操作缺少目录认领，已停止；请保留档案。");
  claim.released ??= (await tx.appendEntry(DirectoryClaim, ROOT_CONVERSATION_ID, { data: { owner, directory: claim.directory, action: "release", acquired: claim.acquired } })).id;
}

export async function verifyPersonalDirectoryClaims(tx: Tx, expected: Array<{ owner: PersonalClaimOwner; directory: PersonalDirectory; acquired: EntryId; active: boolean }>) {
  const claims = (await tx.doc(PersonalDirectoryClaimsDoc)).claims;
  const invalid = () => new PersonalError("directory_claim_invalid", "目录认领与原操作、来源或停止事实不符，已停止恢复；请保留档案。");
  if (!Array.isArray(claims) || claims.length !== expected.length || new Set(claims.map(value => `${value.owner.kind}:${value.owner.operation}`)).size !== claims.length) throw invalid();
  for (const claim of claims) {
    const owner = expected.find(value => isDeepStrictEqual(value.owner, claim.owner)), acquired = await tx.entry(DirectoryClaim, claim.acquired), released = claim.released && await tx.entry(DirectoryClaim, claim.released);
    if (!owner || owner.acquired !== claim.acquired || !isDeepStrictEqual(owner.directory, claim.directory) || owner.active !== !claim.released || !acquired || acquired.conversationId !== ROOT_CONVERSATION_ID || !isDeepStrictEqual(acquired.data, { owner: claim.owner, directory: claim.directory, action: "acquire" }) || claim.released && (!released || released.id <= acquired.id || !isDeepStrictEqual(released.data, { owner: claim.owner, directory: claim.directory, action: "release", acquired: claim.acquired }))) throw invalid();
  }
  const active = claims.filter(value => !value.released);
  if (active.some((a, index) => active.slice(index + 1).some(b => personalDirectoriesConflict(a.directory, b.directory)))) throw invalid();
  let conversations;
  do { const page = await tx.scanConversations({}, 256, conversations); for (const conversation of page.items) { let cursor; do { const entries = await tx.scanEntries({ conversationId: conversation.id, order: "ascending" }, 256, cursor); for (const entry of entries.items) if (DirectoryClaim.is(entry) && (conversation.id !== ROOT_CONVERSATION_ID || !claims.some(value => value.acquired === entry.id || value.released === entry.id))) throw invalid(); cursor = entries.next; } while (cursor); } conversations = page.next; } while (conversations);
}
