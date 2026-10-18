import { randomUUID } from "node:crypto";
import { ROOT_CONVERSATION_ID, type EntryId, type Tx } from "@earendil-works/pi-durable";
import type { MemoryCategory } from "@ruukoto/core/types.ts";
import { PersonalError } from "./personal-error.ts";
import { changePersonalMemory, ownerPersonalMemory, readPersonalMemory, searchPersonalMemory } from "./personal-memory.ts";
import { readPersonalHistory, searchPersonalHistory } from "./personal-history.ts";
import { choose, type PersonalCliIO } from "./personal-cli.ts";
import { personalControl, PERSONAL_REQUEST_ID } from "./personal-control.ts";

export function parsePersonalMemoryControl(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("action" in value) || !["create", "revise", "revoke"].includes(String(value.action)) || !("requestId" in value) || typeof value.requestId !== "string" || !PERSONAL_REQUEST_ID.test(value.requestId)) throw new PersonalError("memory_input_invalid", "记忆操作无效，请重新从向导选择记忆；请求标识由程序管理。");
  const action = value.action as "create" | "revise" | "revoke", allowed = { create: ["category", "content", "note"], revise: ["memory", "expectedVersion", "content", "note"], revoke: ["memory", "expectedVersion"] }[action];
  if (Object.keys(value).some(key => !["action", "requestId", ...allowed].includes(key))) throw new PersonalError("memory_input_invalid", "记忆操作字段无效，请重新打开向导。");
  const category = "category" in value ? value.category : undefined, content = "content" in value ? value.content : undefined, note = "note" in value ? value.note : undefined, memory = "memory" in value ? value.memory : undefined, expectedVersion = "expectedVersion" in value ? value.expectedVersion : undefined;
  if (action === "create" && !["preference", "convention", "decision", "experience"].includes(String(category)) || action !== "revoke" && (typeof content !== "string" || !content.trim() || Buffer.byteLength(content) > 32768 || typeof note !== "string" || !note.trim() || Buffer.byteLength(note) > 32768) || action !== "create" && (typeof memory !== "number" || !Number.isSafeInteger(memory) || memory < 1 || typeof expectedVersion !== "number" || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) throw new PersonalError("memory_input_invalid", "请选择记忆和类别，填写不超过32 KiB的正文及拥有者来源说明；版本由向导管理。");
  if (action === "create") return { action, requestId: value.requestId, category: category as MemoryCategory, content: content as string, note: note as string };
  if (action === "revise") return { action, requestId: value.requestId, memory: memory as EntryId, expectedVersion: expectedVersion as number, content: content as string, note: note as string };
  return { action, requestId: value.requestId, memory: memory as EntryId, expectedVersion: expectedVersion as number };
}

export function personalMemoryControl(tx: Tx, profile: string, value: ReturnType<typeof parsePersonalMemoryControl>) {
  const operation = `local:${value.requestId}`;
  if (value.action === "create") return ownerPersonalMemory(tx, profile, operation, value.category, value.content, value.note);
  if (value.action === "revise") return changePersonalMemory(tx, profile, ROOT_CONVERSATION_ID, operation, { action: "revise", memory: value.memory, expectedVersion: value.expectedVersion, content: value.content, sources: [{ kind: "owner", note: value.note }] });
  return changePersonalMemory(tx, profile, ROOT_CONVERSATION_ID, operation, value);
}

type MemoryPage = Awaited<ReturnType<typeof searchPersonalMemory>>;
type MemoryDetail = Awaited<ReturnType<typeof readPersonalMemory>>;
export async function managePersonalMemory(io: PersonalCliIO, directory: string) {
  const action = await choose(io, "长期记忆", ["查找、读取或撤销记忆", "新建拥有者记忆", "返回"]);
  if (action === 2) return;
  if (action === 1) {
    const categories = ["preference", "convention", "decision", "experience"] as const, category = await choose(io, "记忆类别", ["个人偏好", "约定", "已确认决策", "经验", "返回"]);
    if (category === 4) return;
    const content = await io.question("记忆正文（/back返回）："); if (content === "/back") return;
    const note = await io.question("拥有者来源说明（/back返回）："); if (note === "/back") return;
    if (await choose(io, `保存记忆：${content}`, ["返回", "保存"]) === 0) return;
    await personalControl(directory, "POST", "/memory", { action: "create", requestId: randomUUID(), category: categories[category], content, note }); io.write("记忆已保存，后续主会话可参考。\n"); return;
  }
  const query = await io.question("查找关键词（回车列出全部，/back返回）："); if (query === "/back") return;
  let offset = 0;
  while (true) {
    const page = await personalControl<MemoryPage>(directory, "GET", `/memories?query=${encodeURIComponent(query)}&offset=${offset}`);
    const index = await choose(io, "选择记忆", [...page.items.map(item => `${item.category}：${item.revoked ? "已撤销" : item.text}`), ...(page.nextOffset === undefined ? [] : ["下一页"]), "返回"]);
    if (index === page.items.length && page.nextOffset !== undefined) { offset = page.nextOffset; continue; }
    if (index >= page.items.length) return;
    const item = page.items[index]; if (item.revoked) { io.write("此记忆已撤销，后续查询和注入不再使用；原版本仍保存在档案。\n"); continue; }
    if (item.sourceUnavailable) {
      io.write("此记忆的原来源缺失或不可用，模型已停止依赖；可撤销这条记忆，其他历史证据的恢复要求不变。\n");
      if (await choose(io, "失效记忆", ["返回列表", "撤销此记忆"]) === 1) { await personalControl(directory, "POST", "/memory", { action: "revoke", requestId: randomUUID(), memory: item.memory, expectedVersion: item.version }); io.write("记忆已撤销。\n"); }
      continue;
    }
    let cursor = 0, detail: MemoryDetail;
    do { detail = await personalControl<MemoryDetail>(directory, "GET", `/memory?memory=${item.memory}&offset=${cursor}`); io.write(`${detail.text}\n`); if (detail.nextOffset === undefined || await choose(io, "记忆正文", ["继续读取", "结束读取"]) === 1) break; cursor = detail.nextOffset; } while (true);
    if (!detail.ownerEditable) io.write("此记忆属于子或定时会话；修订须由原会话按自身可见来源提出，本机可撤销。\n");
    const selected = await choose(io, "记忆操作", detail.ownerEditable ? ["返回列表", "修订", "撤销"] : ["返回列表", "撤销"]), next = !detail.ownerEditable && selected === 1 ? 2 : selected;
    if (next === 0) continue;
    if (next === 2) {
      if (await choose(io, "撤销从后续查询和注入生效，原历史仍保留", ["返回", "撤销此记忆"]) === 0) continue;
      await personalControl(directory, "POST", "/memory", { action: "revoke", requestId: randomUUID(), memory: item.memory, expectedVersion: detail.version }); io.write("记忆已撤销。\n"); continue;
    }
    const content = await io.question("修订正文（/back返回）："); if (content === "/back") continue;
    const note = await io.question("拥有者修订来源（/back返回）："); if (note === "/back") continue;
    if (await choose(io, `保存修订：${content}`, ["返回", "保存修订"]) === 0) continue;
    await personalControl(directory, "POST", "/memory", { action: "revise", requestId: randomUUID(), memory: item.memory, expectedVersion: detail.version, content, note }); io.write("记忆修订已保存。\n");
  }
}

export async function managePersonalHistory(io: PersonalCliIO, directory: string) {
  const query = await io.question("历史关键词（/back返回）："); if (query === "/back") return;
  let cursor: string | undefined;
  while (true) {
    const page = await personalControl<Awaited<ReturnType<typeof searchPersonalHistory>>>(directory, "GET", `/history?query=${encodeURIComponent(query)}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`);
    const next = "nextCursor" in page ? page.nextCursor : undefined;
    const index = await choose(io, "选择历史原文", [...page.items.map(item => `${item.partial ? "中断片段：" : ""}${item.text}`), ...(next ? ["继续检索"] : []), "返回"]);
    if (index === page.items.length && next) { cursor = next; continue; }
    if (index >= page.items.length) return;
    let offset = 0;
    while (true) {
      const detail = await personalControl<Awaited<ReturnType<typeof readPersonalHistory>>>(directory, "GET", `/history/entry?entry=${page.items[index].entry}&offset=${offset}`); io.write(`${detail.text}\n`);
      if (detail.nextOffset === undefined || await choose(io, "历史正文", ["继续读取", "返回检索"]) === 1) break;
      offset = detail.nextOffset;
    }
  }
}
