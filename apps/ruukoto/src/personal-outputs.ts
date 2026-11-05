import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { copyJson, type JsonValue } from "@earendil-works/chord";
import { AgentDoc, defineDoc, defineEntry, defineExtension, defineTool, type Cursor, type EntryId, type TypedEntry, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import type { PersonalDesktopOutput, PersonalDesktopOutputChunk } from "@ruukoto/view/personal-protocol.ts";
import { loadPersonalArtifact, savePersonalArtifact, type PersonalArtifact } from "./personal-artifacts.ts";
import { PersonalError } from "./personal-error.ts";
import { toolOperations, type PersonalToolOperation } from "./personal-tools.ts";
import { browserOperations } from "./personal-browser.ts";
import { mcpOperations } from "./personal-mcp.ts";
import { mediaArtifacts } from "./personal-media.ts";
import { capturePersonalToolInstructions, personalToolOrigin, requirePersonalChildBusinessTool, verifyPersonalToolInstructions, type PersonalToolOrigin } from "./personal-tool-source.ts";
import { PersonalWorkDoc, personalWorkInspectionSource, personalWorkInstructionSources, type PersonalToolInstructions, type PersonalWorkRef } from "./personal-work.ts";
import { personalDelegation } from "./personal-delegation.ts";
import { personalSource } from "./personal-source.ts";

export const PERSONAL_OUTPUTS = "personal-outputs";
export const PERSONAL_OUTPUT_CHUNK_BYTES = 128 * 1024;
export const PERSONAL_OUTPUT_LIMIT = 8;
type OutputInput = { name: string; artifact?: string; operation?: number };
type OutputSource = { kind: "artifact"; artifact: string } | { kind: "write_file"; operation: TaskId };
type SelectedOutput = { source: OutputSource; artifact: PersonalArtifact; content?: never; mime?: never } | { source: OutputSource; content: string; mime: string; artifact?: never };
export type PersonalOutputIntent = { version: 1; tool: TaskId; origin: PersonalToolOrigin; instructions: PersonalToolInstructions; name: string; source: OutputSource; artifact: PersonalArtifact };
export const PersonalOutputIntentEntry = defineEntry<PersonalOutputIntent>("ruukoto.output-intent");
export const PersonalOutputsDoc = defineDoc<{ intents: EntryId[] }>({ kind: "ruukoto.outputs", scope: "session", version: 1, initial: () => ({ intents: [] }) });
const invalid = () => new PersonalError("output_record_invalid", "文件发布的原来源或完整记录无法核实，请保留档案并查询原工作。");
const forbidden = () => new PersonalError("output_source_forbidden", "请只发布当前工作已返回的最终产物或成功写入；原操作未重做。");
const validName = (name: string) => name.length > 0 && name.length <= 128 && name.trim().length > 0 && name !== "." && name !== ".." && !/[\x00-\x1f\x7f\\/]/.test(name);
const inputFor = (intent: PersonalOutputIntent): OutputInput => ({ name: intent.name, ...(intent.source.kind === "artifact" ? { artifact: intent.source.artifact } : { operation: intent.source.operation }) });
const writeMime = (name: string) => /\.(txt|md|csv|json|html|xml|log)$/i.test(name) ? /\.json$/i.test(name) ? "application/json" : "text/plain; charset=utf-8" : "application/octet-stream";

function sameWork(origin: PersonalToolOrigin, ref: PersonalWorkRef) { return isDeepStrictEqual(origin.work?.ref, ref); }
function successfulWrite(value: PersonalToolOperation) { return value.kind === "write_file" && value.started && value.observation !== undefined && value.stopped && value.effect === "returned" && value.code === "file_returned" && typeof value.params.content === "string"; }

async function outputSource(tx: Tx, input: OutputInput, ref: PersonalWorkRef): Promise<SelectedOutput> {
  if (!validName(input.name) || (input.artifact === undefined) === (input.operation === undefined)) throw new PersonalError("output_input_invalid", "请选择一个原产物或成功写入，并提供不含路径的文件名。");
  const tools = await toolOperations(tx);
  if (input.operation !== undefined) {
    const operation = tools.find(value => value.operation === input.operation);
    if (!operation || !sameWork(operation.origin, ref) || !successfulWrite(operation)) throw forbidden();
    return { source: { kind: "write_file", operation: operation.operation } as const, content: operation.params.content as string, mime: writeMime(input.name) };
  }
  const ordinary = tools.find(value => value.artifact?.id === input.artifact);
  if (ordinary && sameWork(ordinary.origin, ref) && ordinary.observation !== undefined && ordinary.effect === "returned" && ordinary.stopped && (ordinary.status ?? 0) < 400) return { source: { kind: "artifact", artifact: input.artifact! } as const, artifact: ordinary.artifact! };
  const browser = (await browserOperations(tx)).find(value => value.artifact?.id === input.artifact);
  if (browser && sameWork(browser.origin, ref) && browser.effect === "returned" && browser.observation !== undefined) return { source: { kind: "artifact", artifact: input.artifact! } as const, artifact: browser.artifact! };
  const image = (await mediaArtifacts(tx, ref.agentId)).find(value => value.artifact.id === input.artifact);
  if (image?.source.kind === "tool") {
    const taskId = image.source.taskId;
    const operation = (await mcpOperations(tx)).find(value => value.operation === taskId);
    if (operation && sameWork(operation.origin, ref) && operation.effect === "returned" && operation.observation !== undefined && operation.remoteEnded) return { source: { kind: "artifact", artifact: input.artifact! } as const, artifact: image.artifact };
  }
  throw forbidden();
}

export async function personalOutputIntent(tx: Tx, id: EntryId): Promise<TypedEntry<PersonalOutputIntent>> {
  const entry = await tx.entry(PersonalOutputIntentEntry, id);
  if (!entry || entry.data.version !== 1 || !validName(entry.data.name) || !Number.isSafeInteger(entry.data.tool) || entry.data.tool < 1 || !entry.data.origin?.work || !entry.data.instructions || entry.data.instructions.version !== 1 || !entry.data.source || !["artifact", "write_file"].includes(entry.data.source.kind) || entry.model !== undefined || entry.conversationId !== entry.data.origin.conversationId) throw invalid();
  return entry;
}

async function requireOutputCapacity(tx: Tx, ref: PersonalWorkRef) {
  const work = await tx.doc(PersonalWorkDoc, ref.requestId, null);
  if (!work.delegation) throw forbidden();
  const delegation = await personalDelegation(tx, work.delegation);
  let count = 0;
  for (const member of delegation.members) count += (await personalWorkOutputs(tx, member, undefined, true)).length;
  if (count >= PERSONAL_OUTPUT_LIMIT) throw new PersonalError("output_limit", "每项委托最多交付8个最终文件；本次未登记，原业务结果保留。请报告已登记文件与交付限制。");
}

// Note: See .agents/notes/implemented/architecture/2026-11-05-personal-final-outputs.md
export function personalOutputs(profile: string) {
  const tool = defineTool({ name: "publish_output", description: "拥有者要求交付文件或截图时，登记当前后台工作的最终文件，每项委托最多8个。name须为不含路径的文件名，最多128字符；artifact与operation恰选一项。artifact用当前工作已返回的原产物，不能发布其他工作或中间截图；operation用当前工作成功write_file返回的operation，复用已写完整内容，不额外读取目标。登记后宿主等待当前要求和汇总核实，再在桌面发布；登记不代表已送达。partial或超过8MiB的捕获不能完整预览或下载，须如实报告。发布或送达失败只核实原记录，不重做成功写入。", parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 128, description: "最终文件名，不含目录、斜线或控制字符。" }), artifact: Type.Optional(Type.String({ minLength: 1, description: "当前工作返回的artifact；与operation互斥。" })), operation: Type.Optional(Type.Integer({ minimum: 1, description: "当前工作已成功写入且停止已核实的write_file操作；与artifact互斥。" })) }, { additionalProperties: false }), replay: "safe", executionMode: "sequential", async execute(input, api, context) {
    try {
      requirePersonalChildBusinessTool(api, "publish_output");
      const prepared = await api.commit(async tx => {
        const index = await tx.doc(PersonalOutputsDoc);
        for (const id of index.intents) { const saved = await personalOutputIntent(tx, id); if (saved.data.tool === api.taskId) { if (!isDeepStrictEqual(inputFor(saved.data), input)) throw invalid(); return { existing: saved.id }; } }
        const agent = await tx.doc(AgentDoc, api.conversationId);
        if (!Array.isArray(agent.tools) || !agent.tools.includes("publish_output") || !Array.isArray(agent.extensions) || !agent.extensions.includes(PERSONAL_OUTPUTS)) throw forbidden();
        const instructions = await capturePersonalToolInstructions(tx, api), origin = await personalToolOrigin(tx, api, undefined, { snapshot: instructions?.snapshot });
        if (!instructions || !origin.work || !(await tx.doc(PersonalWorkDoc, origin.work.ref.requestId, null)).delegation) throw forbidden();
        await requireOutputCapacity(tx, origin.work.ref);
        const current = await outputSource(tx, input, origin.work.ref);
        const selected: SelectedOutput = current.content !== undefined ? { ...current } : { source: { ...current.source }, artifact: { ...current.artifact, identity: { ...current.artifact.identity } } };
        return { origin: copyJson(origin) as PersonalToolOrigin, instructions: copyJson(instructions) as PersonalToolInstructions, selected };
      }, context);
      if ("existing" in prepared) return { output: [{ type: "text", text: JSON.stringify({ output: prepared.existing, state: "registered" }) }] };
      const selected = prepared.selected;
      const artifact = selected.content !== undefined ? await savePersonalArtifact(profile, Buffer.from(selected.content), { mime: selected.mime }) : selected.artifact;
      loadPersonalArtifact(profile, artifact);
      const output = await api.commit(async tx => {
        const instructions = await capturePersonalToolInstructions(tx, api), origin = await personalToolOrigin(tx, api, undefined, { snapshot: instructions?.snapshot });
        if (!isDeepStrictEqual(origin, prepared.origin) || !isDeepStrictEqual(instructions, prepared.instructions) || !isDeepStrictEqual(await outputSource(tx, input, prepared.origin.work!.ref), selected)) throw forbidden();
        await requireOutputCapacity(tx, prepared.origin.work!.ref);
        const entry = await tx.appendEntry(PersonalOutputIntentEntry, api.conversationId, { data: { version: 1, tool: api.taskId, origin, instructions: prepared.instructions, name: input.name, source: selected.source, artifact } });
        (await tx.doc(PersonalOutputsDoc)).intents.push(entry.id);
        return entry.id;
      }, context);
      return { output: [{ type: "text", text: JSON.stringify({ output, state: "registered", name: input.name, bytes: artifact.bytes, partial: artifact.partial, next: artifact.partial ? "只保存了片段，无法完整交付。报告已完成的业务结果和交付限制，不重做原操作。" : "最终文件已登记，宿主核实当前要求后发布。报告实际业务结果，不重做原操作。" }) }] };
    } catch (error) { if (!(error instanceof PersonalError)) throw error; return { isError: true, output: [{ type: "text", text: `${error.code}：${error.message}` }] }; }
  } });
  return defineExtension({ name: PERSONAL_OUTPUTS, tools: [tool] });
}

export async function personalWorkOutputs(tx: Tx, ref: PersonalWorkRef, before?: EntryId, includePending = false): Promise<EntryId[]> {
  const result: EntryId[] = [], work = await tx.doc(PersonalWorkDoc, ref.requestId, null);
  const notes = (work.notes ?? []).filter(note => before === undefined || note.admission !== undefined && note.admission < before).map(note => note.admission);
  for (const id of (await tx.doc(PersonalOutputsDoc)).intents) {
    if (before !== undefined && id >= before) continue;
    const entry = await personalOutputIntent(tx, id), intent = entry.data;
    if (!sameWork(intent.origin, ref) || !isDeepStrictEqual(intent.instructions.snapshot.notes.map(note => note.admission), notes)) continue;
    const tool = await tx.task(intent.tool);
    if (!tool || tool.kind !== "pi.tool" || tool.conversationId !== ref.agentId) throw invalid();
    if (includePending || tool.state.status === "terminal" && tool.state.outcome.status === "completed") result.push(id);
  }
  return result;
}

export async function verifyPersonalOutputs(tx: Tx, profile: string, enabled: boolean) {
  const ids = (await tx.doc(PersonalOutputsDoc)).intents;
  if (!Array.isArray(ids) || ids.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length || !enabled && ids.length) throw invalid();
  const tools = new Set<TaskId>();
  for (const id of ids) {
    const entry = await personalOutputIntent(tx, id), intent = entry.data, task = await tx.task(intent.tool), input = task?.input;
    if (!task || task.kind !== "pi.tool" || task.owner !== intent.origin.generation || task.conversationId !== intent.origin.conversationId || tools.has(task.id) || !input || typeof input !== "object" || Array.isArray(input) || typeof input.assistant !== "number") throw invalid();
    tools.add(task.id);
    const assistant = await tx.entry(input.assistant as EntryId), call = assistant?.model?.flatMap(message => message.role === "assistant" ? message.content : []).find(part => part.type === "toolCall" && part.id === input.callId);
    if (!assistant || assistant.byTaskId !== task.owner || assistant.id >= entry.id || call?.type !== "toolCall" || call.name !== "publish_output") throw invalid();
    let normalized: OutputInput;
    try { normalized = validateToolArguments(personalOutputs(profile).tools![0], { ...call, arguments: copyJson(call.arguments) as Record<string, JsonValue> }) as OutputInput; } catch { throw invalid(); }
    if (!isDeepStrictEqual(normalized, inputFor(intent))) throw invalid();
    await verifyPersonalToolInstructions(tx, intent.instructions, intent.origin, entry.id, task.id);
    const source = await personalSource(tx, intent.origin.source.requestId), work = await tx.doc(PersonalWorkDoc, intent.origin.work!.ref.requestId, null);
    const inspection = await personalWorkInspectionSource(tx, intent.origin.work!.ref, intent.origin.inputs);
    if (!isDeepStrictEqual(source.source, intent.origin.source) || !isDeepStrictEqual(work.source, intent.origin.source) || !isDeepStrictEqual(source.permission, intent.origin.permission) || !isDeepStrictEqual(source.telegram, intent.origin.telegram) || !isDeepStrictEqual(inspection.work, intent.origin.work) || !isDeepStrictEqual(await personalWorkInstructionSources(tx, intent.instructions.snapshot), intent.origin.sources)) throw invalid();
    const selected = await outputSource(tx, inputFor(intent), intent.origin.work!.ref);
    if (!isDeepStrictEqual(selected.source, intent.source)) throw invalid();
    if ("artifact" in selected ? !isDeepStrictEqual(selected.artifact, intent.artifact) : intent.artifact.partial || intent.artifact.mime !== selected.mime || Buffer.byteLength(selected.content) !== intent.artifact.bytes || createHash("sha256").update(selected.content).digest("hex") !== intent.artifact.sha256) throw invalid();
    loadPersonalArtifact(profile, intent.artifact);
  }
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanConversations({}, 256, cursor);
    for (const conversation of page.items) {
      let entries: Cursor | undefined;
      do {
        const page = await tx.scanEntries({ conversationId: conversation.id }, 256, entries);
        if (page.items.some(entry => entry.kind === PersonalOutputIntentEntry.kind && !ids.includes(entry.id))) throw invalid();
        entries = page.next;
      } while (entries);
    }
    cursor = page.next;
  } while (cursor);
}

export function personalOutputMetadata(publication: EntryId, entry: TypedEntry<PersonalOutputIntent>): PersonalDesktopOutput {
  const { name, artifact } = entry.data;
  return { v: 1, publication, output: entry.id, name, mime: artifact.mime, bytes: artifact.bytes, sha256: artifact.sha256, partial: artifact.partial };
}

export function personalOutputChunk(profile: string, publication: EntryId, entry: TypedEntry<PersonalOutputIntent>, offset: number): PersonalDesktopOutputChunk {
  const ref = entry.data.artifact;
  if (ref.partial) throw new PersonalError("output_partial", "此文件仅保存了片段或超过8MiB，无法完整交付；原业务操作未重做。");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > ref.bytes || offset % PERSONAL_OUTPUT_CHUNK_BYTES !== 0) throw new PersonalError("output_offset_invalid", "文件分页位置无效，请从原文件重新读取。");
  const bytes = loadPersonalArtifact(profile, ref), page = bytes.subarray(offset, offset + PERSONAL_OUTPUT_CHUNK_BYTES), next = offset + page.length;
  return { ...personalOutputMetadata(publication, entry), offset, base64: page.toString("base64"), ...(next < bytes.length ? { nextOffset: next } : {}) };
}
