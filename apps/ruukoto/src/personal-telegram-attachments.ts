import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { copyJson } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import { defineDoc, defineDocFamily, defineEntry, defineTask, ROOT_CONVERSATION_ID, type Cursor, type EntryId, type Storage, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { PersonalError } from "./personal-error.ts";
import type { PersonalImAccess } from "./personal-im-api.ts";
import type { TelegramText } from "./personal-telegram-api.ts";
import { PersonalTelegramReceiptDoc, samePersonalEntry, type PersonalEntryIdentity, type TelegramControlInput, type TelegramReceipt, type TelegramSelection } from "./personal-telegram-records.ts";
import { telegramSourceActive } from "./personal-permissions.ts";
import { requestPersonalTelegramDisplay } from "./personal-telegram-displays.ts";
import { PersonalTelegramDisplayDoc } from "./personal-telegram-display-records.ts";
import type { PersonalTelegramSelection } from "./personal-telegram-selection.ts";

const DISPLAY_TASK = "ruukoto.telegram-attachment-display", RECEIVE_TASK = "ruukoto.telegram-attachment-input";
export const TELEGRAM_ATTACHMENT_SEND = "发送这组附件", TELEGRAM_ATTACHMENT_DISCARD = "丢弃这组附件";
type Member = { entry: EntryId; receivedAt: number; updateId: number; message: TelegramText };
type Choice = { entry: EntryId; requestId: string; revision: number; action: "send" | "discard"; taskId?: TaskId };
export type PersonalTelegramAttachmentGroup = { v: 1; key: string; groupId: string; source: PersonalEntryIdentity; members: Member[]; revision: number; updatedAt: number; state: "collecting" | "sealed" | "received" | "discarded" | "canceled" | "failed"; choice?: Choice; observation?: EntryId; receipt?: string; failure?: string };
export const PersonalTelegramAttachmentsDoc = defineDoc<{ keys: string[] }>({ kind: "ruukoto.telegram-attachments", scope: "session", version: 1, initial: () => ({ keys: [] }) });
export const PersonalTelegramAttachmentGroupDoc = defineDocFamily<{ group?: PersonalTelegramAttachmentGroup }, null>({ kind: "ruukoto.telegram-attachment-group", scope: "session", version: 1, family: true, initial: () => ({}) });
const PersonalTelegramAttachmentMessageDoc = defineDocFamily<{ group?: string; entry?: EntryId }, null>({ kind: "ruukoto.telegram-attachment-message", scope: "session", version: 1, family: true, initial: () => ({}) });
const RejectedEntry = defineEntry<{ v: 1; key: string; requestId: string; source: PersonalEntryIdentity; updateId: number; message: TelegramText; reason: "too_many" | "late" }>("ruukoto.telegram-attachment-rejected");
const MemberEntry = defineEntry<{ v: 1; key: string; groupId: string; source: PersonalEntryIdentity; receivedAt: number; updateId: number; message: TelegramText }>("ruukoto.telegram-attachment-member");
const ChoiceEntry = defineEntry<{ v: 1; group: string; revision: number; members: EntryId[]; requestId: string; source: PersonalEntryIdentity; action: "send" | "discard"; taskId?: TaskId }>("ruukoto.telegram-attachment-choice");
const ObservationEntry = defineEntry<{ v: 1; key: string; choice: EntryId; state: "received" | "failed" | "canceled"; receipt?: string; failure?: string }>("ruukoto.telegram-attachment-observation");
const invalid = () => new PersonalError("telegram_attachment_invalid", "原附件组、选择或接收记录无法核实，请保留档案并查询原消息。");
const messageKey = (source: PersonalEntryIdentity, messageId: number) => `telegram:${source.botId}:${source.ownerId}:${messageId}`;
const groupKey = (source: PersonalEntryIdentity, groupId: string) => `telegram-group:${source.botId}:${source.ownerId}:${createHash("sha256").update(JSON.stringify([source.generation, groupId])).digest("hex")}`;
const primary = (group: PersonalTelegramAttachmentGroup) => group.members[0].message;
export const personalTelegramAttachmentBody = (group: PersonalTelegramAttachmentGroup) => group.members.map(member => member.message.text).filter(text => text.length > 0).join("\n");
const count = (group: PersonalTelegramAttachmentGroup) => group.members.reduce((total, member) => total + (member.message.media?.length ?? 0), 0);
const selected = (group: PersonalTelegramAttachmentGroup): Extract<TelegramSelection, { kind: "attachment-group" }> => ({ kind: "attachment-group", group: group.key, revision: group.revision });
function validMessage(message: TelegramText, source: PersonalEntryIdentity, groupId: string) {
  return message && Number.isSafeInteger(message.id) && message.id > 0 && message.ownerId === source.ownerId && typeof message.text === "string" && Buffer.byteLength(message.text) <= 16384 && typeof message.name === "string" && message.name.length <= 128 && typeof message.direct === "boolean" && message.mediaGroupId === groupId && Array.isArray(message.media) && message.media.length === 1 && message.media.every(file => file && typeof file.identity === "string" && file.identity.length > 0 && file.identity.length <= 4096 && typeof file.fileId === "string" && file.fileId.length <= 4096 && (file.name === undefined || typeof file.name === "string") && (file.declaredMime === undefined || typeof file.declaredMime === "string") && (file.kind === undefined || ["image", "file"].includes(file.kind)) && (file.sizeBytes === undefined || typeof file.sizeBytes === "number")) && (message.replyTo === undefined || Number.isSafeInteger(message.replyTo) && message.replyTo > 0) && (message.replyBotId === undefined || typeof message.replyBotId === "string");
}

async function groupRecord(tx: Tx, key: string) {
  const group = (await tx.doc(PersonalTelegramAttachmentGroupDoc, key, null)).group;
  if (!group || group.v !== 1 || group.key !== key || !Array.isArray(group.members) || !group.members.length || group.members.length > 5) throw invalid();
  return group;
}

export async function personalTelegramInputReceipt(tx: Tx, key: string) {
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanTasks({ kind: "ruukoto.telegram-input" }, 256, cursor);
    for (const task of page.items) {
      const input = task.input;
      if (!input || typeof input !== "object" || Array.isArray(input) || input.requestId !== key) continue;
      const receipt = (await tx.doc(PersonalTelegramReceiptDoc, key, null)).receipt;
      if (!receipt || receipt.taskId !== task.id || receipt.requestId !== key) throw invalid();
      return receipt;
    }
    cursor = page.next;
  } while (cursor);
  return undefined;
}

async function originalReceipt(tx: Tx, group: PersonalTelegramAttachmentGroup) {
  const receipt = await personalTelegramInputReceipt(tx, messageKey(group.source, primary(group).id));
  if (receipt && (!group.choice || !isDeepStrictEqual(receipt.attachmentGroup, { key: group.key, revision: group.revision, choice: group.choice.entry }) || !samePersonalEntry(receipt, group.source) || receipt.content !== personalTelegramAttachmentBody(group) || !isDeepStrictEqual(receipt.media?.identities, group.members.flatMap(member => member.message.media!.map(file => file.identity))))) throw invalid();
  return receipt;
}

async function observe(tx: Tx, group: PersonalTelegramAttachmentGroup, state: "received" | "failed" | "canceled", failure?: string) {
  const receipt = state === "received" ? messageKey(group.source, primary(group).id) : undefined;
  if (!group.choice) throw invalid();
  if (group.observation !== undefined) { if (group.state !== state || group.receipt !== receipt || group.failure !== failure) throw invalid(); return; }
  group.observation = (await tx.appendEntry(ObservationEntry, ROOT_CONVERSATION_ID, { data: { v: 1, key: group.key, choice: group.choice.entry, state, ...(receipt === undefined ? {} : { receipt }), ...(failure === undefined ? {} : { failure }) } })).id;
  group.state = state;
  if (receipt !== undefined) group.receipt = receipt;
  if (failure !== undefined) group.failure = failure;
}

function prompt(group: PersonalTelegramAttachmentGroup) {
  const names = group.members.flatMap(member => member.message.media?.map(file => file.name ?? "图片") ?? []);
  return `附件已收集：\n${names.map((name, index) => `${index + 1}. ${JSON.stringify(name)}`).join("\n")}${count(group) > 4 ? "\n每条最多4个附件，这组未交给模型。请丢弃后重新选择。" : "\n发送后一起处理这组附件。"}`;
}

export async function personalTelegramAttachmentActions(tx: Tx, source: PersonalEntryIdentity, selection: TelegramSelection): Promise<{ text: string; action: string }[]> {
  if (selection.kind === "attachment-list") return [...selection.groups.map((_group, index) => ({ text: `附件${index + 1}`, action: `附件${index + 1}` })), ...(selection.nextOffset === undefined ? [] : [{ text: "下一页", action: "下一页附件" }])];
  if (selection.kind !== "attachment-group") return [];
  const group = await groupRecord(tx, selection.group);
  if (!samePersonalEntry(group.source, source) || group.revision !== selection.revision || group.state !== "collecting") return [];
  return [...(count(group) <= 4 ? [{ text: "发送", action: TELEGRAM_ATTACHMENT_SEND }] : []), { text: "丢弃", action: TELEGRAM_ATTACHMENT_DISCARD }];
}

export async function personalTelegramAttachmentSelectionActive(tx: Tx, source: PersonalEntryIdentity, selection: TelegramSelection) {
  if (selection.kind !== "attachment-group") return true;
  const group = await groupRecord(tx, selection.group);
  return samePersonalEntry(group.source, source) && group.revision === selection.revision && group.state === "collecting";
}

async function requestDisplay(tx: Tx, group: PersonalTelegramAttachmentGroup, key = `telegram-attachments:${group.key}:${group.revision}`) {
  return requestPersonalTelegramDisplay(tx, { key, source: { ...group.source }, messageId: primary(group).id, selection: selected(group), text: prompt(group), actions: await personalTelegramAttachmentActions(tx, group.source, selected(group)), origin: group.members.at(-1)!.entry });
}

// Note: See .agents/notes/implemented/architecture/2026-11-07-personal-inbound-attachments.md
export function personalTelegramAttachments(im: PersonalImAccess, admit: (group: PersonalTelegramAttachmentGroup, signal: AbortSignal) => Promise<void>) {
  const display = defineTask<{ key: string; revision: number }, { phase: "display" }, null>({ name: DISPLAY_TASK, version: 1, initial: () => ({ phase: "display" }), phases: {
    async display(current, runtime, context) {
      for (;;) {
        const group = (await runtime.snapshot(PersonalTelegramAttachmentGroupDoc, current.input.key, context))?.group;
        if (!group) throw invalid();
        if (group.state !== "collecting" || group.revision !== current.input.revision) break;
        const due = group.updatedAt + 750;
        if (runtime.now() < due) { await runtime.sleep(due, context); continue; }
        await im.withEntry(group.source, async () => runtime.commit(async tx => {
          const group = await groupRecord(tx, current.input.key);
          if (group.state === "collecting" && group.revision === current.input.revision && im.isActive(group.source) && await telegramSourceActive(tx, group.source)) await requestDisplay(tx, group);
          return undefined;
        }, context));
        break;
      }
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
    },
  }, async abort(_current, runtime, context) { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", result: null } }), context); } });
  const receive = defineTask<{ key: string; revision: number }, { phase: "receive" }, { state: "received" | "canceled" | "failed" }>({ name: RECEIVE_TASK, version: 1, initial: () => ({ phase: "receive" }), phases: {
    async receive(current, runtime, context) {
      const saved = (await runtime.snapshot(PersonalTelegramAttachmentGroupDoc, current.input.key, context))?.group;
      if (!saved || saved.choice?.action !== "send" || saved.choice.taskId !== current.id || saved.revision !== current.input.revision) throw invalid();
      let active = false;
      await im.withEntry(saved.source, async () => runtime.commit(async tx => {
        const group = await groupRecord(tx, saved.key);
        if (await originalReceipt(tx, group)) { await observe(tx, group, "received"); return { status: "terminal", outcome: { status: "completed", result: { state: "received" } } }; }
        active = im.isActive(group.source) && await telegramSourceActive(tx, group.source);
        if (!active) { await observe(tx, group, "canceled"); return { status: "terminal", outcome: { status: "completed", result: { state: "canceled" } } }; }
        return undefined;
      }, context));
      if (!active) return;
      let failure: PersonalError | undefined;
      try { await admit(copyJson(saved) as PersonalTelegramAttachmentGroup, runtime.signal); }
      catch (error) {
        if (runtime.signal.aborted) throw error;
        if (!(error instanceof PersonalError)) process.stderr.write("[ruukoto:personal] Attachment group reception failed; the original input remains unsubmitted.\n");
        failure = error instanceof PersonalError ? error : new PersonalError("telegram_attachment_unavailable", "请检查后台状态后作为新消息重新发送。");
      }
      await im.withEntry(saved.source, async () => runtime.commit(async tx => {
        const group = await groupRecord(tx, saved.key), receipt = await originalReceipt(tx, group);
        if (receipt) {
          await observe(tx, group, "received");
          return { status: "terminal", outcome: { status: "completed", result: { state: "received" } } };
        }
        if (!im.isActive(group.source) || !await telegramSourceActive(tx, group.source)) {
          await observe(tx, group, "canceled");
          return { status: "terminal", outcome: { status: "completed", result: { state: "canceled" } } };
        }
        if (!failure) throw invalid();
        await observe(tx, group, "failed", failure.code);
        await requestPersonalTelegramDisplay(tx, { key: `telegram-attachments-failed:${group.key}`, source: { ...group.source }, messageId: primary(group).id, selection: selected(group), text: `附件接收未完成，本条文字和附件未交给模型。${failure.message}`, actions: [], origin: group.choice!.entry });
        return { status: "terminal", outcome: { status: "completed", result: { state: "failed" } } };
      }, context));
    },
  }, async abort(current, runtime, context) {
    await runtime.commit(async tx => {
      const group = await groupRecord(tx, current.input.key), receipt = await originalReceipt(tx, group);
      await observe(tx, group, receipt ? "received" : "canceled");
      return { status: "terminal", outcome: { status: "aborted", result: { state: receipt ? "received" : "canceled" } } };
    }, context);
  } });
  return { tasks: [display, receive],
    async accepts(tx: Tx, source: PersonalEntryIdentity, messageId: number, selected?: TelegramReceipt["attachmentGroup"]) {
      const association = await tx.doc(PersonalTelegramAttachmentMessageDoc, messageKey(source, messageId), null);
      if (!association.group) { if (selected) throw invalid(); return true; }
      if (!selected) return false;
      const group = await groupRecord(tx, association.group);
      if (!samePersonalEntry(group.source, source) || selected.key !== group.key || selected.revision !== group.revision || selected.choice !== group.choice?.entry || group.choice?.action !== "send" || primary(group).id !== messageId || !["sealed", "received"].includes(group.state)) throw invalid();
      return true;
    },
    async collect(tx: Tx, source: PersonalEntryIdentity, message: TelegramText, updateId: number) {
      if (!message.mediaGroupId || !validMessage(message, source, message.mediaGroupId) || source.platform || source.ownerId !== message.ownerId || !await telegramSourceActive(tx, source)) throw invalid();
      const key = groupKey(source, message.mediaGroupId), requestId = messageKey(source, message.id), association = await tx.doc(PersonalTelegramAttachmentMessageDoc, requestId, null);
      if (association.group) {
        const old = await groupRecord(tx, association.group), member = old.members.find(member => member.entry === association.entry), rejected = association.entry !== undefined ? await tx.entry(RejectedEntry, association.entry) : undefined;
        if (old.source.generation !== source.generation) return false;
        if (association.group !== key || !isDeepStrictEqual(member?.message ?? rejected?.data.message, message)) throw new PersonalError("telegram_input_conflict", "同一平台附件消息的来源或内容不符，请保留档案并检查。");
        return true;
      }
      if (await personalTelegramInputReceipt(tx, requestId)) throw new PersonalError("telegram_input_conflict", "原平台消息已归其他输入，未重新包装附件。");
      const record = await tx.doc(PersonalTelegramAttachmentGroupDoc, key, null);
      if (!record.group) {
        record.group = { v: 1, key, groupId: message.mediaGroupId, source: { ...source }, members: [], revision: 0, updatedAt: Date.now(), state: "collecting" };
        (await tx.doc(PersonalTelegramAttachmentsDoc)).keys.push(key);
      }
      const group = record.group, late = group.state !== "collecting", receivedAt = Date.now();
      if (late || group.members.length >= 5) {
        const reason = late ? "late" : "too_many", entry = (await tx.appendEntry(RejectedEntry, ROOT_CONVERSATION_ID, { data: { v: 1, key, requestId, source: { ...source }, updateId, message: copyJson(message) as TelegramText, reason } })).id;
        association.group = key; association.entry = entry;
        await requestPersonalTelegramDisplay(tx, { key: `telegram-attachments-rejected:${requestId}`, source: { ...source }, messageId: message.id, selection: selected(group), text: late ? "这个附件不在已确认的那组文件中，未交给模型。请作为新消息重新发送。" : "这组附件超过4个，本条文字和附件未交给模型。请丢弃后重新选择。", actions: [], origin: entry });
        return true;
      }
      const entry = (await tx.appendEntry(MemberEntry, ROOT_CONVERSATION_ID, { data: { v: 1, key, groupId: message.mediaGroupId, source: { ...source }, receivedAt, updateId, message: copyJson(message) as TelegramText } })).id;
      association.group = key; association.entry = entry;
      const member: Member = { entry, receivedAt, updateId, message: copyJson(message) as TelegramText };
      group.members.push(member); group.revision++; group.updatedAt = receivedAt;
      await tx.createTask(display, { key, revision: group.revision }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true });
      return true;
    },
    async control(tx: Tx, value: TelegramControlInput, previous?: PersonalTelegramSelection): Promise<boolean> {
      if (value.platform || !value.direct) return false;
      const selection = previous?.selection;
      if (value.content === "/附件" || value.content === "下一页附件" && selection?.kind === "attachment-list") {
        const keys = (await tx.doc(PersonalTelegramAttachmentsDoc)).keys, groups: PersonalTelegramAttachmentGroup[] = [];
        for (const key of keys) { const group = await groupRecord(tx, key); if (samePersonalEntry(group.source, value) && group.state === "collecting") groups.push(group); }
        const offset = value.content === "下一页附件" && selection?.kind === "attachment-list" ? selection.nextOffset ?? 0 : 0, page = groups.slice(offset, offset + 8);
        value.selection = { kind: "attachment-list", groups: page.map(group => group.key), ...(offset ? { offset } : {}), ...(offset + 8 < groups.length ? { nextOffset: offset + 8 } : {}) };
        value.reply = page.length ? `待发送附件：\n${page.map((group, index) => `${index + 1}. ${JSON.stringify(group.members[0].message.media![0].name ?? "图片")}（${count(group)}个）`).join("\n")}\n请选择一组查看并发送。` : "没有待发送的附件组。";
        return true;
      }
      if (selection?.kind === "attachment-list" && /^附件[1-8]$/.test(value.content)) {
        const key = selection.groups[Number(value.content.slice(2)) - 1], group = key && await groupRecord(tx, key);
        if (!group || !samePersonalEntry(group.source, value) || group.state !== "collecting") { value.reply = "这组附件已处理，请发送 /附件 查看待发送文件。"; return true; }
        value.selection = selected(group); value.reply = prompt(group); return true;
      }
      if (value.content !== TELEGRAM_ATTACHMENT_SEND && value.content !== TELEGRAM_ATTACHMENT_DISCARD) return false;
      if (selection?.kind !== "attachment-group") { value.reply = "请从原附件卡片选择发送或丢弃。发送 /附件 可查看待发送文件。"; return true; }
      const group = await groupRecord(tx, selection.group);
      if (!samePersonalEntry(group.source, value) || !await telegramSourceActive(tx, group.source) || group.revision !== selection.revision || group.state !== "collecting") { value.reply = "这组附件已处理或内容变化，请发送 /附件 查看当前文件。"; return true; }
      const action = value.content === TELEGRAM_ATTACHMENT_SEND ? "send" : "discard";
      if (action === "send" && count(group) > 4) { value.reply = "每条最多4个附件，这组未交给模型。请丢弃后重新选择。"; return true; }
      const taskId = action === "send" ? await tx.createTask(receive, { key: group.key, revision: group.revision }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true }) : undefined;
      const entry = (await tx.appendEntry(ChoiceEntry, ROOT_CONVERSATION_ID, { data: { v: 1, group: group.key, revision: group.revision, members: group.members.map(member => member.entry), requestId: value.requestId, source: { ...group.source }, action, ...(taskId === undefined ? {} : { taskId }) } })).id;
      group.choice = { entry, requestId: value.requestId, revision: group.revision, action, ...(taskId === undefined ? {} : { taskId }) }; group.state = action === "send" ? "sealed" : "discarded";
      value.attachmentChoice = { key: group.key, revision: group.revision, action, entry }; value.selection = selected(group);
      value.reply = action === "send" ? "正在接收这组附件，完整接收后处理。" : "这组附件已丢弃，没有交给模型。";
      return true;
    },
  };
}

export async function verifyPersonalTelegramAttachments(tx: Tx) {
  const keys = (await tx.doc(PersonalTelegramAttachmentsDoc)).keys, entries = new Set<EntryId>(), tasks = new Set<TaskId>(), messages = new Set<string>();
  if (!Array.isArray(keys) || new Set(keys).size !== keys.length) throw invalid();
  if (!await tx.conversation(ROOT_CONVERSATION_ID)) { if (keys.length) throw invalid(); return; }
  for (const key of keys) {
    const group = await groupRecord(tx, key);
    if (!group.source || group.source.platform !== undefined || !/^[1-9][0-9]{0,15}$/.test(group.source.botId) || !/^[1-9][0-9]{0,15}$/.test(group.source.ownerId) || typeof group.source.generation !== "string" || !group.source.generation || typeof group.groupId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(group.groupId) || key !== groupKey(group.source, group.groupId) || group.revision !== group.members.length || group.updatedAt !== group.members.at(-1)!.receivedAt || !Number.isSafeInteger(group.updatedAt) || !["collecting", "sealed", "received", "discarded", "canceled", "failed"].includes(group.state)) throw invalid();
    for (const member of group.members) {
      const entry = await tx.entry(MemberEntry, member.entry), requestId = messageKey(group.source, member.message.id), association = await tx.doc(PersonalTelegramAttachmentMessageDoc, requestId, null);
      if (!entry || entry.conversationId !== ROOT_CONVERSATION_ID || entry.model !== undefined || entries.has(entry.id) || messages.has(requestId) || !Number.isSafeInteger(member.receivedAt) || member.receivedAt < 0 || !validMessage(member.message, group.source, group.groupId) || !Number.isSafeInteger(member.updateId) || member.updateId < 0 || !isDeepStrictEqual(entry.data, { v: 1, key, groupId: group.groupId, source: group.source, receivedAt: member.receivedAt, updateId: member.updateId, message: member.message }) || association.group !== key || association.entry !== member.entry) throw invalid();
      entries.add(entry.id); messages.add(requestId);
    }
    if (group.state === "collecting") { if (group.choice || group.receipt || group.failure || group.observation) throw invalid(); continue; }
    const choice = group.choice, entry = choice && await tx.entry(ChoiceEntry, choice.entry), receipt = choice && (await tx.doc(PersonalTelegramReceiptDoc, choice.requestId, null)).receipt;
    if (!choice || !["send", "discard"].includes(choice.action) || choice.revision !== group.revision || !entry || entry.conversationId !== ROOT_CONVERSATION_ID || entry.model !== undefined || entry.id <= group.members.at(-1)!.entry || !isDeepStrictEqual(entry.data, { v: 1, group: key, revision: group.revision, members: group.members.map(member => member.entry), requestId: choice.requestId, source: group.source, action: choice.action, ...(choice.taskId === undefined ? {} : { taskId: choice.taskId }) }) || !receipt?.control || !receipt.direct || !samePersonalEntry(receipt, group.source) || !isDeepStrictEqual(receipt.attachmentChoice, { key, revision: group.revision, action: choice.action, entry: choice.entry })) throw invalid();
    entries.add(entry.id);
    if (choice.action === "discard") { if (group.state !== "discarded" || choice.taskId !== undefined || group.receipt || group.failure || group.observation) throw invalid(); continue; }
    const task = choice.taskId !== undefined && await tx.task(choice.taskId);
    if (count(group) > 4 || !task || task.kind !== RECEIVE_TASK || task.version !== 1 || task.conversationId !== ROOT_CONVERSATION_ID || !task.background || task.owner !== undefined || !isDeepStrictEqual(task.input, { key, revision: group.revision })) throw invalid();
    tasks.add(task.id);
    const originalKey = messageKey(group.source, primary(group).id), original = await originalReceipt(tx, group);
    if (group.state === "received" && (group.receipt !== originalKey || !original) || group.state === "failed" && (!group.failure || original) || group.state === "discarded" || group.receipt !== undefined && group.state !== "received") throw invalid();
    if (group.state === "sealed" && task.state.status === "terminal") {
      await observe(tx, group, original ? "received" : "failed", original ? undefined : "telegram_attachment_interrupted");
      if (!original && await telegramSourceActive(tx, group.source)) await requestPersonalTelegramDisplay(tx, { key: `telegram-attachments-failed:${group.key}`, source: { ...group.source }, messageId: primary(group).id, selection: selected(group), text: "附件接收中断，本条文字和附件未交给模型。请作为新消息重新发送。", actions: [], origin: group.choice!.entry });
    }
    if (group.state === "sealed") { if (group.observation || group.receipt || group.failure) throw invalid(); }
    else {
      const observation = group.observation && await tx.entry(ObservationEntry, group.observation);
      if (!observation || observation.id <= choice.entry || observation.conversationId !== ROOT_CONVERSATION_ID || !isDeepStrictEqual(observation.data, { v: 1, key, choice: choice.entry, state: group.state, ...(group.receipt === undefined ? {} : { receipt: group.receipt }), ...(group.failure === undefined ? {} : { failure: group.failure }) })) throw invalid();
      entries.add(observation.id);
    }
  }
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 256, cursor);
    for (const entry of page.items) if (RejectedEntry.is(entry)) {
      const data = entry.data, group = await groupRecord(tx, data.key), association = await tx.doc(PersonalTelegramAttachmentMessageDoc, data.requestId, null), display = (await tx.doc(PersonalTelegramDisplayDoc, `telegram-attachments-rejected:${data.requestId}`, null)).display;
      if (entry.model !== undefined || messages.has(data.requestId) || data.v !== 1 || !samePersonalEntry(group.source, data.source) || data.requestId !== messageKey(data.source, data.message.id) || !validMessage(data.message, data.source, group.groupId) || !Number.isSafeInteger(data.updateId) || data.updateId < 0 || association.group !== group.key || association.entry !== entry.id || !["too_many", "late"].includes(data.reason) || data.reason === "too_many" && (group.members.length !== 5 || entry.id <= group.members.at(-1)!.entry) || data.reason === "late" && (!group.choice || entry.id <= group.choice.entry) || !display || display.origin !== entry.id || !samePersonalEntry(display.source, data.source) || display.buttons.length) throw invalid();
      entries.add(entry.id); messages.add(data.requestId);
    }
    if (page.items.some(entry => [MemberEntry.kind, ChoiceEntry.kind, ObservationEntry.kind].includes(entry.kind) && !entries.has(entry.id))) throw invalid();
    cursor = page.next;
  } while (cursor);
  cursor = undefined;
  do { const page = await tx.scanTasks({ kind: RECEIVE_TASK }, 256, cursor); if (page.items.some(task => !tasks.has(task.id))) throw invalid(); cursor = page.next; } while (cursor);
  cursor = undefined;
  do { const page = await tx.scanTasks({ kind: DISPLAY_TASK }, 256, cursor); for (const task of page.items) { const input = task.input; if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.key !== "string" || !keys.includes(input.key) || !Number.isSafeInteger(input.revision) || Number(input.revision) < 1 || Number(input.revision) > (await groupRecord(tx, input.key)).revision || task.version !== 1 || task.conversationId !== ROOT_CONVERSATION_ID || !task.background || task.owner !== undefined) throw invalid(); } cursor = page.next; } while (cursor);
}

export async function verifyPersonalTelegramAttachmentStorage(storage: Storage, context: Context) {
  const index = await storage.findDocument({ kind: PersonalTelegramAttachmentsDoc.definition.kind, scope: { kind: "session" } }, "current", context), saved = index && await storage.document(index.id, "current", context);
  if (index && (!saved || saved.version !== 1 || !Array.isArray(saved.value.keys) || saved.value.keys.some(key => typeof key !== "string") || new Set(saved.value.keys).size !== saved.value.keys.length)) throw invalid();
  const keys = saved?.value.keys ?? [], groups = new Set<string>(), messages = new Map<string, { group: string; entry: EntryId }>();
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanDocuments({ kind: PersonalTelegramAttachmentGroupDoc.definition.kind, scope: { kind: "session" }, at: "current" }, 256, cursor, context);
    for (const record of page.items) {
      const saved = await storage.document(record.id, "current", context);
      if (record.key === undefined || !saved || saved.version !== 1) throw invalid();
      if (saved.value.group === undefined) continue;
      const group = saved.value.group as PersonalTelegramAttachmentGroup;
      if (!Array.isArray(keys) || !keys.includes(record.key) || !group || typeof group !== "object" || Array.isArray(group) || group.key !== record.key || !group.source || !Array.isArray(group.members) || !group.members.length || group.members.length > 5) throw invalid();
      groups.add(record.key);
      for (const member of group.members) {
        if (!member || !validMessage(member.message, group.source, group.groupId)) throw invalid();
        const key = messageKey(group.source, member.message.id);
        if (messages.has(key)) throw invalid();
        messages.set(key, { group: group.key, entry: member.entry });
      }
    }
    cursor = page.next;
  } while (cursor);
  if (!Array.isArray(keys) || keys.some(key => typeof key !== "string" || !groups.has(key))) throw invalid();
  if (!await storage.conversation(ROOT_CONVERSATION_ID, context)) { if (groups.size) throw invalid(); return; }
  cursor = undefined;
  do {
    const page = await storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 256, cursor, context);
    for (const entry of page.items) if (RejectedEntry.is(entry)) {
      const data = entry.data;
      if (!data || !groups.has(data.key) || typeof data.requestId !== "string" || messages.has(data.requestId)) throw invalid();
      messages.set(data.requestId, { group: data.key, entry: entry.id });
    }
    cursor = page.next;
  } while (cursor);
  cursor = undefined;
  const indexed = new Set<string>();
  do {
    const page = await storage.scanDocuments({ kind: PersonalTelegramAttachmentMessageDoc.definition.kind, scope: { kind: "session" }, at: "current" }, 256, cursor, context);
    for (const record of page.items) {
      const saved = await storage.document(record.id, "current", context);
      if (record.key === undefined || !saved || saved.version !== 1) throw invalid();
      if (saved.value.group === undefined && saved.value.entry === undefined) continue;
      if (!isDeepStrictEqual(saved.value, messages.get(record.key))) throw invalid();
      indexed.add(record.key);
    }
    cursor = page.next;
  } while (cursor);
  if ([...messages.keys()].some(key => !indexed.has(key))) throw invalid();
}

export async function verifyPersonalTelegramAttachmentReceipt(tx: Tx, receipt: TelegramReceipt) {
  if (receipt.attachmentGroup) {
    const group = await groupRecord(tx, receipt.attachmentGroup.key);
    if (receipt.platform || receipt.control || receipt.callback || receipt.attachmentChoice || primary(group).id !== receipt.messageId || group.choice?.action !== "send" || !["sealed", "received"].includes(group.state) || !isDeepStrictEqual(await originalReceipt(tx, group), receipt)) throw invalid();
  }
  if (receipt.attachmentChoice) {
    const group = await groupRecord(tx, receipt.attachmentChoice.key);
    if (receipt.platform || !receipt.control || !receipt.direct || group.choice?.requestId !== receipt.requestId || !samePersonalEntry(group.source, receipt) || !isDeepStrictEqual(receipt.attachmentChoice, { key: group.key, revision: group.revision, action: group.choice.action, entry: group.choice.entry }) || receipt.content !== (group.choice.action === "send" ? TELEGRAM_ATTACHMENT_SEND : TELEGRAM_ATTACHMENT_DISCARD)) throw invalid();
  }
}
