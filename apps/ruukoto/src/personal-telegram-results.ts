import { isDeepStrictEqual } from "node:util";
import type { Tx } from "@earendil-works/pi-durable";
import { PersonalError } from "./personal-error.ts";
import { PersonalImDeliveriesDoc, PersonalImDeliveryDoc, personalImDeliveryRecord, personalImDeliveryResult, requestPersonalImDelivery, type PersonalImDeliveryInput, type PersonalImDeliveryRef } from "./personal-im-delivery.ts";
import { PersonalTelegramReceiptDoc, samePersonalEntry, type TelegramControlInput, type TelegramSelection } from "./personal-telegram-records.ts";
import { telegramSelection, telegramSourceActive } from "./personal-permissions.ts";
import { PersonalTelegramDisplayDoc } from "./personal-telegram-display-records.ts";
import { personalImControlAccepted } from "./personal-recovery-claims.ts";

const invalid = () => new PersonalError("im_retrieval_invalid", "原结果读取来源无法核实，请从原私聊重新查询。");
const eligible = (key: string) => ["telegram-reply:", "report:", "question:", "schedule:"].some(prefix => key.startsWith(prefix));
const choice = (content: string) => /^[1-8]$/.test(content) ? Number(content) - 1 : undefined;
function segments(menu: TelegramSelection | undefined, content: string, record: Awaited<ReturnType<typeof personalImDeliveryRecord>>) {
  if (menu?.kind !== "result") return;
  const segment = /^原文 ([1-9][0-9]*)$/.exec(content);
  const indices = content === "全部原文" ? record.parts.filter(part => part.kind === "text").map(part => part.index) : segment ? [Number(segment[1]) - 1] : [];
  if (!indices.length || indices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= record.parts.length || record.parts[index].kind !== "text")) return;
  return { indices, text: indices.map(index => { const part = record.parts[index]; return part.kind === "text" ? part.text : ""; }).join("") };
}

async function resultPage(tx: Tx, value: TelegramControlInput, offset: number) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw invalid();
  const refs: PersonalImDeliveryRef[] = [];
  for (const key of (await tx.doc(PersonalImDeliveriesDoc)).keys.slice().reverse()) {
    const saved = (await tx.doc(PersonalImDeliveryDoc, key, null)).delivery;
    if (!saved) throw invalid();
    const record = await personalImDeliveryRecord(tx, saved.ref);
    if (!samePersonalEntry(record.input.source, value) || !eligible(key) || record.input.retrieval || record.input.keyboard) continue;
    refs.push({ ...record.ref });
  }
  return { refs: refs.slice(offset, offset + 8), offset, ...(offset + 8 < refs.length ? { nextOffset: offset + 8 } : {}) };
}

// Note: See .agents/notes/implemented/architecture/2026-11-06-personal-telegram-delivery.md
export async function personalTelegramResultControl(tx: Tx, value: TelegramControlInput, selected?: Awaited<ReturnType<typeof telegramSelection>>) {
  if (value.platform) return false;
  const prior = selected ?? await telegramSelection(tx, value), menu = prior?.selection;
  const index = choice(value.content);
  const listAction = value.content === "更多结果" || index !== undefined;
  const readAction = value.content === "全部原文" || /^原文 /.test(value.content);
  if (!["/结果", "重新显示"].includes(value.content) && !(menu?.kind === "result-list" && listAction) && !(menu?.kind === "result" && readAction)) return false;
  if (!value.direct || !await telegramSourceActive(tx, value)) return false;
  if (value.content === "重新显示") {
    const original = prior && (await tx.doc(PersonalTelegramDisplayDoc, prior.requestId, null)).display;
    if (!original) { value.reply = "请直接回复原卡片「重新显示」，或从原操作菜单查询。"; return true; }
    value.redisplay = { display: original.key }; value.reply = original.text;
    return true;
  }
  if (value.content === "/结果" || value.content === "更多结果" && menu?.kind === "result-list" && menu.nextOffset !== undefined) {
    const page = await resultPage(tx, value, value.content === "更多结果" && menu?.kind === "result-list" ? menu.nextOffset! : 0);
    value.selection = { kind: "result-list", ...page };
    const rows: string[] = [];
    for (const [index, ref] of page.refs.entries()) {
      const record = await personalImDeliveryRecord(tx, ref), state = personalImDeliveryResult(record).textState;
      rows.push(`${index + 1}. ${Array.from(record.input.text).slice(0, 96).join("")}\n${record.parts.filter(part => part.kind === "text").length}段，${({ sent: "已送达", effect_unknown: "部分发送待核实", failed: "发送失败", canceled: "发送已停止", pending: "等待发送", sending: "正在发送", none: "没有文本" })[state]}`);
    }
    value.reply = page.refs.length ? `已保存的结果：\n${rows.join("\n\n")}\n回复本消息选择结果编号${page.nextOffset === undefined ? "。" : "，或「更多结果」。"}` : "当前私聊没有已保存的结果。";
    return true;
  }
  const ref = menu?.kind === "result-list" && index !== undefined ? menu.refs[index] : menu?.kind === "result" ? menu.ref : undefined;
  if (!ref) { value.reply = "请发送 /结果 选择已保存的原文。"; return true; }
  const record = await personalImDeliveryRecord(tx, ref);
  if (!samePersonalEntry(record.input.source, value) || !eligible(record.input.key) || record.input.retrieval) throw invalid();
  if (menu?.kind === "result-list") {
    const count = record.parts.filter(part => part.kind === "text").length;
    value.selection = { kind: "result", ref };
    value.reply = `原结果保留了${count}段。回复本消息「全部原文」或「原文 1」选择一段。这里只读取原文，工作不会重做。`;
    return true;
  }
  const read = segments(menu, value.content, record);
  if (!read) { value.reply = "请选择原结果中实际存在的段落。"; return true; }
  value.reply = read.text;
  value.multipart = await requestPersonalImDelivery(tx, { key: `telegram-retrieval:${value.requestId}`, source: { botId: value.botId, ownerId: value.ownerId, generation: value.generation }, messageId: value.messageId, text: read.text, retrieval: { delivery: { ...ref }, segments: read.indices } });
  return true;
}

export async function verifyPersonalTelegramResultControl(tx: Tx, value: TelegramControlInput) {
  const menu = value.selection;
  if (!value.redisplay && menu?.kind !== "result-list" && menu?.kind !== "result" && !value.multipart?.key.startsWith("telegram-retrieval:")) return;
  if (value.platform || !value.direct || !value.control || value.accepted === undefined || !await personalImControlAccepted(tx, value) || value.permission || value.submissionId !== undefined) throw invalid();
  const prior = await telegramSelection(tx, value), selected = prior?.selection;
  if (value.redisplay) {
    const original = (await tx.doc(PersonalTelegramDisplayDoc, value.redisplay.display, null)).display;
    if (value.content !== "重新显示" || menu || !original || prior?.requestId !== original.key || !samePersonalEntry(original.source, value) || value.reply !== original.text || original.admission >= value.accepted || value.questionAnswer || value.questionCancel || value.toolDecision || value.toolResolution || value.toolStop || value.mcpDecision || value.mcpResolution || value.mcpEnded || value.cuaAction || value.appDataDecision || value.appDataRecheck || value.serviceDecision || value.serviceResolution || value.serviceStop || value.commandResolution || value.commandStop || value.browserResolution || value.browserStop || value.browserResume || value.backgroundAction || value.scheduleCreate || value.scheduleCancel || value.scheduleRunCancel || value.inspectionStop) throw invalid();
  } else if (menu?.kind === "result-list") {
    const offset = menu.offset ?? 0;
    if (!Array.isArray(menu.refs) || menu.refs.length > 8 || new Set(menu.refs.map(ref => ref.key)).size !== menu.refs.length || !Number.isSafeInteger(offset) || offset < 0 || menu.nextOffset !== undefined && menu.nextOffset !== offset + 8 || (value.content === "/结果" ? offset !== 0 : value.content !== "更多结果" || selected?.kind !== "result-list" || selected.nextOffset !== offset)) throw invalid();
    for (const ref of menu.refs) { const record = await personalImDeliveryRecord(tx, ref); if (!samePersonalEntry(record.input.source, value) || !eligible(record.input.key) || record.input.keyboard || record.input.retrieval || record.admission >= value.accepted) throw invalid(); }
  } else if (menu?.kind === "result") {
    const index = choice(value.content);
    if (selected?.kind !== "result-list" || index === undefined || !isDeepStrictEqual(selected.refs[index], menu.ref)) throw invalid();
  } else if (value.multipart) {
    const current = await personalImDeliveryRecord(tx, value.multipart), original = selected?.kind === "result" ? await personalImDeliveryRecord(tx, selected.ref) : undefined, read = original && segments(selected, value.content, original);
    if (selected?.kind !== "result" || !read || !current.input.retrieval || !isDeepStrictEqual(current.input.retrieval, { delivery: selected.ref, segments: read.indices }) || current.input.messageId !== value.messageId || current.input.text !== read.text || value.reply !== read.text || current.input.key !== `telegram-retrieval:${value.requestId}`) throw invalid();
  }
}

export async function authorizePersonalTelegramRetrieval(tx: Tx, input: PersonalImDeliveryInput) {
  const value = (await tx.doc(PersonalTelegramReceiptDoc, input.key.slice("telegram-retrieval:".length), null)).receipt;
  if (!input.key.startsWith("telegram-retrieval:") || !value?.multipart || !input.retrieval || !samePersonalEntry(value, input.source) || value.messageId !== input.messageId || value.reply !== input.text) throw invalid();
  const delivery = await personalImDeliveryRecord(tx, value.multipart);
  if (delivery.parent !== undefined || !isDeepStrictEqual(delivery.input, input) || !value.accepted || delivery.admission >= value.accepted) throw invalid();
  await verifyPersonalTelegramResultControl(tx, value);
  return await telegramSourceActive(tx, input.source);
}
