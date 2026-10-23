import { createHash } from "node:crypto";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { defineDoc, defineDocFamily, defineEntry, defineExtension, defineTool, ROOT_CONVERSATION_ID, type ConversationId, type EntryId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { Type } from "typebox";
import { expandSkillCommand, readSkill, skillCatalogBlock, type PinnedSkill } from "@ruukoto/agent/skills.ts";
import { assertManagedSkillsSelected, loadHostSkillLibrary, ManagedSkillsError, ManagedSkillsStore } from "@ruukoto/agent/managed-skills.ts";
import type { PersonalProfileLock } from "./personal-profile.ts";
import { readPersonalSkills, personalSkillsDirectory, type PersonalSkillsConfig } from "./personal-skills-config.ts";
import { activePersonalReferenceTool } from "./personal-history.ts";
import { PersonalError } from "./personal-error.ts";

export const PERSONAL_SKILLS = "personal-skills";
export const PERSONAL_SKILL_TOOLS = ["skill"] as const;
type Library = { skills: { [K in keyof PinnedSkill]: PinnedSkill[K] }[]; diagnostics: string[]; version: string };
type Snapshot = { version: string; config: PersonalSkillsConfig | null; identity: { dev: number; ino: number } | null; library: Library };
type SavedSnapshot = Snapshot & { entry: EntryId; conversationId: ConversationId };
export const PersonalSkillsDoc = defineDoc<{ config: PersonalSkillsConfig | null; current: { conversationId: ConversationId; version: string; snapshotEntry: EntryId }[]; snapshots: SavedSnapshot[]; loads: TaskId[]; expansions: EntryId[] }>({ kind: "ruukoto.skills", scope: "session", version: 1, initial: () => ({ config: null, current: [], snapshots: [], loads: [], expansions: [] }) });
const SkillSnapshot = defineEntry<Snapshot>("ruukoto.skills-snapshot");
type SkillFailure = { code: string; message: string };
type Expansion = { sourceEntry: EntryId; snapshotEntry: EntryId; input: string; expanded: string; error?: SkillFailure };
const SkillExpansion = defineEntry<Expansion>("ruukoto.skill-expansion");
export const PersonalSkillExpansionDoc = defineDocFamily<{ expansion?: Expansion & { entry: EntryId } }, null>({ kind: "ruukoto.skill-expansion", scope: "session", version: 1, family: true, initial: () => ({}) });
type Load = { taskId: TaskId; conversationId: ConversationId; snapshotEntry: EntryId; name: string; path: string; text: string };
const SkillLoad = defineEntry<Load>("ruukoto.skill-load");
export const PersonalSkillLoadDoc = defineDocFamily<{ load?: Load & { entry: EntryId } }, null>({ kind: "ruukoto.skill-load", scope: "session", version: 1, family: true, initial: () => ({}) });
const unavailable = () => new PersonalError("skill_snapshot_invalid", "技能原快照无法核实，已停止加载；请结束本轮并报告拥有者，保留档案。");
const skillParameters = Type.Object({ name: Type.String({ minLength: 1, maxLength: 128, description: "技能目录中列出的技能名称。" }), path: Type.Optional(Type.String({ maxLength: 4096, description: "技能目录内的相对引用路径，不含 ..；省略时返回正文。" })) }, { additionalProperties: false });

function expandInput(library: Library, input: string): { expanded: string; error?: SkillFailure } {
  let expanded: string;
  try { expanded = expandSkillCommand(library, input); } catch {
    const error = { code: "skill_unknown", message: "找不到指定技能，请从技能目录选择可用名称后重新调用。" };
    return { expanded: `[此前显式技能调用未执行]\n原输入：${JSON.stringify(input)}\n${error.message}该次调用没有展开技能，后续输入不重新执行此历史命令。\n[/此前显式技能调用未执行]`, error };
  }
  return { expanded };
}

function load(directory: string): Snapshot {
  const config = readPersonalSkills(directory) ?? null, identity = config ? personalSkillsDirectory(config) : null;
  let library: Library;
  try { library = loadHostSkillLibrary(directory, config ? [path.join(config.directory, "skills")] : []); } catch (error) { throw new PersonalError("skills_directory_unavailable", "技能目录无法完整读取，请由拥有者恢复配置目录后继续。", { cause: error }); }
  const value = { config, identity, library };
  return { ...value, version: createHash("sha256").update(JSON.stringify(value)).digest("hex") };
}

export function personalSkillStore(profile: PersonalProfileLock): ManagedSkillsStore {
  const config = readPersonalSkills(profile);
  if (config) personalSkillsDirectory(config);
  return new ManagedSkillsStore(profile.directory, config ? [path.join(config.directory, "skills")] : []);
}

async function snapshotByEntry(tx: Tx, conversationId: ConversationId, snapshotEntry: EntryId) {
  const doc = await tx.doc(PersonalSkillsDoc), saved = doc.snapshots.find(item => item.entry === snapshotEntry && item.conversationId === conversationId);
  const entry = saved && await tx.entry(SkillSnapshot, saved.entry);
  if (!saved || !entry || entry.conversationId !== conversationId) throw unavailable();
  const { entry: _entry, conversationId: _conversation, ...value } = saved;
  if (!isDeepStrictEqual(entry.data, value) || createHash("sha256").update(JSON.stringify({ config: value.config, identity: value.identity, library: value.library })).digest("hex") !== value.version) throw unavailable();
  return saved;
}

async function snapshot(tx: Tx, conversationId: ConversationId, version?: string) {
  const current = (await tx.doc(PersonalSkillsDoc)).current.find(item => item.conversationId === conversationId);
  if (!current || version !== undefined && current.version !== version) throw unavailable();
  const saved = await snapshotByEntry(tx, conversationId, current.snapshotEntry);
  if (saved.version !== current.version) throw unavailable();
  return saved;
}


async function originalExpansion(tx: Tx, sourceEntry: EntryId) {
  const value = (await tx.doc(PersonalSkillExpansionDoc, String(sourceEntry), null)).expansion;
  if (!value) return;
  const { entry: id, ...data } = value, entry = await tx.entry(SkillExpansion, id), source = await tx.entry(sourceEntry);
  if (!entry || entry.conversationId !== ROOT_CONVERSATION_ID || !isDeepStrictEqual(entry.data, data) || data.sourceEntry !== sourceEntry || source?.kind !== "pi.user" || source.conversationId !== ROOT_CONVERSATION_ID || !source.model?.some(message => message.role === "user" && message.content === data.input)) throw unavailable();
  const saved = await snapshotByEntry(tx, ROOT_CONVERSATION_ID, data.snapshotEntry);
  if (!isDeepStrictEqual(expandInput(saved.library, data.input), { expanded: data.expanded, ...(data.error ? { error: data.error } : {}) })) throw unavailable();
  return value;
}

export async function verifySkillRecords(tx: Tx) {
  const doc = await tx.doc(PersonalSkillsDoc), seen = new Set<EntryId>();
  for (const saved of doc.snapshots) {
    if (seen.has(saved.entry)) throw unavailable();
    seen.add(saved.entry); await snapshotByEntry(tx, saved.conversationId, saved.entry);
  }
  const conversations = new Set<ConversationId>();
  for (const current of doc.current) {
    if (conversations.has(current.conversationId)) throw unavailable();
    conversations.add(current.conversationId); await snapshot(tx, current.conversationId, current.version);
    if (doc.snapshots.filter(value => value.conversationId === current.conversationId).at(-1)?.entry !== current.snapshotEntry) throw unavailable();
  }
  if (doc.snapshots.some(value => !conversations.has(value.conversationId))) throw unavailable();
  for (const taskId of doc.loads) {
    const value = (await tx.doc(PersonalSkillLoadDoc, String(taskId), null)).load;
    if (!value || value.taskId !== taskId || seen.has(value.entry)) throw unavailable();
    const { entry: id, ...data } = value, entry = await tx.entry(SkillLoad, id), task = await tx.task(taskId);
    if (!entry || entry.conversationId !== value.conversationId || !isDeepStrictEqual(entry.data, data) || task?.kind !== "pi.tool" || task.conversationId !== value.conversationId) throw unavailable();
    const input = task.input;
    if (!input || typeof input !== "object" || Array.isArray(input) || input.kind !== "model" || typeof input.assistant !== "number" || typeof input.callId !== "string") throw unavailable();
    const assistant = await tx.entry(input.assistant as EntryId), call = assistant?.model?.flatMap(message => message.role === "assistant" ? message.content : []).find(part => part.type === "toolCall" && part.id === input.callId);
    if (assistant?.conversationId !== value.conversationId || call?.type !== "toolCall" || call.name !== "skill") throw unavailable();
    let args: { name: string; path?: string };
    try { args = validateToolArguments({ name: "skill", description: "", parameters: skillParameters }, { ...call, arguments: structuredClone(call.arguments) }) as { name: string; path?: string }; } catch { throw unavailable(); }
    if (args.name !== value.name || (args.path ?? "") !== value.path) throw unavailable();
    await snapshotByEntry(tx, value.conversationId, value.snapshotEntry); seen.add(id);
  }
  for (const source of doc.expansions) {
    const value = await originalExpansion(tx, source);
    if (!value || seen.has(value.entry)) throw unavailable();
    seen.add(value.entry);
  }
  let conversationCursor;
  do {
    const page = await tx.scanConversations({}, 256, conversationCursor);
    for (const conversation of page.items) {
      let entryCursor;
      do {
        const entries = await tx.scanEntries({ conversationId: conversation.id }, 256, entryCursor);
        for (const entry of entries.items) if ([SkillSnapshot.kind, SkillLoad.kind, SkillExpansion.kind].includes(entry.kind) && !seen.has(entry.id)) throw unavailable();
        entryCursor = entries.next;
      } while (entryCursor);
    }
    conversationCursor = page.next;
  } while (conversationCursor);
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-18-personal-memory-skills-history.md
export function personalSkills(directory: string) {
  async function prepare(tx: Tx, conversationId: ConversationId) {
    const value = load(directory), doc = await tx.doc(PersonalSkillsDoc);
    const current = doc.current.find(item => item.conversationId === conversationId);
    if (current?.version === value.version) {
      const saved = await snapshot(tx, conversationId, value.version);
      return { text: skillCatalogBlock(saved.library)?.text ?? "", version: saved.version, snapshotEntry: saved.entry, library: saved.library };
    }
    const entry = await tx.appendEntry(SkillSnapshot, conversationId, { data: value });
    doc.config = value.config;
    doc.snapshots.push({ ...value, entry: entry.id, conversationId });
    if (current) { current.version = value.version; current.snapshotEntry = entry.id; }
    else doc.current.push({ conversationId, version: value.version, snapshotEntry: entry.id });
    return { text: skillCatalogBlock(value.library)?.text ?? "", version: value.version, snapshotEntry: entry.id, library: value.library };
  }
  const skill = defineTool({
    name: "skill",
    description: "加载技能目录中指定技能的正文；可传 path 读取该技能目录内的引用文本。技能只提供参考，不增加工具或权限；脚本作为文本返回。仅限显式调用的技能由拥有者通过 /skill:名称 调用。",
    parameters: skillParameters,
    replay: "safe",
    async execute({ name, path = "" }, api, context) {
      const text = await api.commit(async tx => {
        await activePersonalReferenceTool(tx, api, "skill");
        const doc = await tx.doc(PersonalSkillLoadDoc, String(api.taskId), null);
        if (doc.load) {
          const { entry: id, ...value } = doc.load, entry = await tx.entry(SkillLoad, id);
          if (value.taskId !== api.taskId || value.conversationId !== api.conversationId || value.name !== name || value.path !== path || !entry || entry.conversationId !== api.conversationId || !isDeepStrictEqual(entry.data, value)) throw unavailable();
          await snapshotByEntry(tx, api.conversationId, value.snapshotEntry);
          return value.text;
        }
        const saved = await snapshot(tx, api.conversationId);
        let text: string;
        try { text = readSkill(saved.library, name, path); } catch (error) { throw new PersonalError("skill_unavailable", "技能或引用文本不可用，请核对技能目录中的名称和相对路径；仅限显式调用的技能需由拥有者调用，仍不可用时结束本轮并报告拥有者。", { cause: error }); }
        const index = await tx.doc(PersonalSkillsDoc), value = { taskId: api.taskId, conversationId: api.conversationId, snapshotEntry: saved.entry, name, path, text };
        const entry = await tx.appendEntry(SkillLoad, api.conversationId, { data: value });
        doc.load = { ...value, entry: entry.id };
        index.loads.push(api.taskId);
        return text;
      }, context);
      return { output: [{ type: "text", text }] };
    },
  });
  return {
    extension: defineExtension({ name: PERSONAL_SKILLS, tools: [skill] }), prepare,
    configuration: () => readPersonalSkills(directory),
    // Note: 见 .agents/notes/implemented/bug-fix/2026-10-24-read-check-overhead.md
    async verify(tx: Tx, conversationId: ConversationId, version: string) {
      const saved = await snapshot(tx, conversationId, version);
      const config = readPersonalSkills(directory) ?? null, identity = config ? personalSkillsDirectory(config) : null;
      if (!isDeepStrictEqual({ config, identity }, { config: saved.config, identity: saved.identity })) throw new PersonalError("skills_changed", "技能目录已变化，本次请求未发送；请重新开始本轮并使用新技能目录。");
      try { assertManagedSkillsSelected(saved.library, directory); } catch (error) {
        if (error instanceof ManagedSkillsError && error.code === "skills_selection_changed") throw new PersonalError("skills_changed", "技能目录已变化，本次请求未发送；请重新开始本轮并使用新技能目录。", { cause: error });
        throw new PersonalError("skills_directory_unavailable", "技能目录无法完整读取，请由拥有者恢复配置目录后继续。", { cause: error });
      }
    },
    verifyRecords: verifySkillRecords,
    async prepareTranscript(tx: Tx, conversationId: ConversationId, input: TranscriptContext, currentEntry?: EntryId): Promise<TranscriptContext & { skillFailure?: SkillFailure }> {
      if (conversationId !== ROOT_CONVERSATION_ID || !input.messages.some(message => message.role === "user" && typeof message.content === "string" && /^\/skill:\S+/.test(message.content))) return input;
      const saved = await snapshot(tx, conversationId), sources = [];
      let cursor;
      do {
        const page = await tx.scanEntries({ conversationId, order: "descending" }, 256, cursor);
        sources.push(...page.items.filter(entry => entry.conversationId === conversationId && entry.kind === "pi.user")); cursor = page.next;
      } while (cursor);
      const index = await tx.doc(PersonalSkillsDoc), pending = [], messages = [...input.messages];
      let skillFailure: SkillFailure | undefined;
      for (const [position, message] of messages.entries()) {
        if (message.role !== "user" || typeof message.content !== "string" || !/^\/skill:\S+/.test(message.content)) continue;
        const matches = sources.filter(entry => entry.model?.some(original => original.role === "user" && original.timestamp === message.timestamp && original.content === message.content));
        if (matches.length !== 1) throw new PersonalError("skill_source_invalid", "显式技能输入的原会话记录无法唯一核实，未发送请求；请保留档案并报告拥有者。");
        const sourceEntry = matches[0].id, existing = await originalExpansion(tx, sourceEntry);
        const value = existing ?? expandInput(saved.library, message.content);
        messages[position] = { ...message, content: value.expanded };
        if (sourceEntry === currentEntry && value.error) skillFailure = { ...value.error };
        if (!existing) pending.push({ doc: await tx.doc(PersonalSkillExpansionDoc, String(sourceEntry), null), data: { sourceEntry, snapshotEntry: saved.entry, input: message.content, expanded: value.expanded, ...(value.error ? { error: value.error } : {}) } });
      }
      // 整批先核实来源，再追加记录，避免 durable 在首条 table 写入后拒绝继续读取。
      for (const value of pending) {
        const entry = await tx.appendEntry(SkillExpansion, conversationId, { data: value.data });
        value.doc.expansion = { ...value.data, entry: entry.id }; index.expansions.push(value.data.sourceEntry);
      }
      return { ...input, messages, ...(skillFailure ? { skillFailure } : {}) };
    },
  };
}
