import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { copyJson, type JsonValue } from "@earendil-works/chord";
import { defineDoc, defineDocFamily, defineExtension, ProviderDoc, ROOT_CONVERSATION_ID, type ConversationId, type EntryId, type Harness, type SubmissionId, type TaskId, type ToolRegistration, type Tx, type UserInput } from "@earendil-works/pi-durable";
import type { Context, ImageContent } from "@earendil-works/pi-ai";
import { imageMime } from "@ruukoto/agent/artifacts.ts";
import { savePersonalArtifact, loadPersonalArtifact, type PersonalArtifact } from "./personal-artifacts.ts";
import { PersonalTelegramReceiptDoc } from "./personal-telegram-records.ts";
import { PersonalError } from "./personal-error.ts";

export const PERSONAL_MEDIA = "personal-media";
const context = BACKGROUND_CONTEXT;
const MAX_IMAGES = 4, MAX_BYTES = 8 * 1024 * 1024, TTL_MS = 24 * 60 * 60 * 1000;
type ImageMime = "image/jpeg" | "image/png" | "image/webp";
type MediaReason = "too_many_images" | "image_too_large" | "mime_unsupported" | "mime_mismatch" | "download_unavailable" | "download_failed" | "download_interrupted" | "orphan_expired" | "image_input_unsupported";
export class PersonalMediaError extends PersonalError {
  constructor(readonly reason: MediaReason) { super(reason, "图片未被接纳，请检查图片大小、格式和入口；本条文字未单独交给模型。"); }
}
export type PersonalMediaSource = { platform: "telegram" | "qq"; accountId: string; ownerId: string; generation: string };
export type PersonalMediaDownload = { identity: string; declaredMime?: string; sizeBytes?: number; download(signal: AbortSignal): Promise<Response> };
type MediaMessage = { key: string; source: PersonalMediaSource; body: string; receivedAt: number; accepted: EntryId; identities: string[]; artifacts: PersonalArtifact[]; state: "staging" | "ready" | "rejected" | "expired" | "bound"; reason?: MediaReason; submissionId?: SubmissionId };
type ImageSource = { kind: "inbound"; requestId: string } | { kind: "tool"; taskId: TaskId };
export type PersonalImageReference = { version: 1; artifact: PersonalArtifact; conversationId: ConversationId; source: ImageSource };
type SavedImage = { ref: PersonalImageReference; entry: EntryId };
export const PersonalMediaDoc = defineDoc<{ keys: string[]; images: string[] }>({ kind: "ruukoto.media", scope: "session", version: 1, initial: () => ({ keys: [], images: [] }) });
export const PersonalMediaMessageDoc = defineDocFamily<{ message?: MediaMessage }, null>({ kind: "ruukoto.media-message", scope: "session", version: 1, family: true, initial: () => ({}) });
export const PersonalImageDoc = defineDocFamily<{ image?: SavedImage }, null>({ kind: "ruukoto.image", scope: "session", version: 1, family: true, initial: () => ({}) });
export type PersonalImageRegistrar = { supportsImages?(): boolean; registerImage(tx: Tx, artifact: PersonalArtifact, source: { conversationId: ConversationId; taskId: TaskId }): Promise<ImageContent> };
export type PersonalModelMedia = { prepare(input: Context, sessionId: string): Promise<{ input: Context; snapshot(value: unknown, actualPayload?: boolean): JsonValue; imageMappings?: JsonValue }> };
const validMime = (value: string | undefined | null): value is ImageMime => value === "image/jpeg" || value === "image/png" || value === "image/webp";
const mime = (value: string | undefined | null) => value?.split(";", 1)[0]?.trim().toLowerCase();
const invalid = () => new PersonalError("image_reference_invalid", "原图片的来源、字节或归属无法核实，已停止模型请求；请保留档案并报告拥有者。");
const block = (ref: PersonalImageReference): ImageContent => ({ type: "image", mimeType: ref.artifact.mime, data: JSON.stringify({ ruukotoImage: ref }) });
function reference(part: ImageContent): PersonalImageReference {
  let value: unknown;
  try { value = JSON.parse(part.data); } catch { throw invalid(); }
  if (!value || typeof value !== "object" || !("ruukotoImage" in value)) throw invalid();
  const ref = value.ruukotoImage as PersonalImageReference; // SDK 图片 data 是跨模型 wire 的宿主引用。
  if (!ref || ref.version !== 1 || !ref.artifact || ref.artifact.mime !== part.mimeType || ref.artifact.partial || !validMime(ref.artifact.mime) || !ref.source || !["inbound", "tool"].includes(ref.source.kind)) throw invalid();
  return ref;
}
const contains = (messages: readonly import("@earendil-works/pi-ai").Message[] | undefined, image: ImageContent) => messages?.some(message => message.role !== "assistant" && Array.isArray(message.content) && message.content.some(part => part.type === "image" && isDeepStrictEqual(part, image))) === true;

async function downloadImage(input: PersonalMediaDownload, parent?: AbortSignal): Promise<{ bytes: Buffer; mimeType: ImageMime }> {
  if (input.sizeBytes !== undefined && (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > MAX_BYTES)) throw new PersonalMediaError("image_too_large");
  if (input.declaredMime && !validMime(mime(input.declaredMime))) throw new PersonalMediaError("mime_unsupported");
  for (let attempt = 0; attempt < 3; attempt++) {
    parent?.throwIfAborted();
    const signal = AbortSignal.any([...(parent ? [parent] : []), AbortSignal.timeout(15_000)]);
    let onAbort: (() => void) | undefined;
    try {
      const canceled = new Promise<never>((_, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener("abort", onAbort, { once: true }); });
      return await Promise.race([canceled, (async () => {
        const response = await input.download(signal);
        signal.throwIfAborted();
        if (!response.ok) { if (response.status >= 400 && response.status < 500 && response.status !== 429) throw new PersonalMediaError("download_unavailable"); throw new PersonalError("media_retry", "图片下载暂时不可用。"); }
        const declared = mime(input.declaredMime), returned = mime(response.headers.get("content-type")), expected = declared ?? returned;
        const reader = response.body?.getReader();
        if (!reader) throw new PersonalMediaError("mime_mismatch");
        const cancel = () => { void reader.cancel().catch(() => { /* 取消后的网络流错误不改变拒收事实。 */ }); };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          if (!validMime(expected)) throw new PersonalMediaError("mime_unsupported");
          if (returned && returned !== "application/octet-stream" && returned !== expected) throw new PersonalMediaError("mime_mismatch");
          if (Number(response.headers.get("content-length") ?? 0) > MAX_BYTES) throw new PersonalMediaError("image_too_large");
          const chunks: Buffer[] = []; let count = 0;
          while (true) {
            signal.throwIfAborted(); const next = await reader.read(); if (next.done) break;
            count += next.value.byteLength; if (count > MAX_BYTES) throw new PersonalMediaError("image_too_large"); chunks.push(Buffer.from(next.value));
          }
          signal.throwIfAborted(); const bytes = Buffer.concat(chunks, count);
          if (imageMime(bytes) !== expected) throw new PersonalMediaError("mime_mismatch");
          return { bytes, mimeType: expected };
        } finally {
          signal.removeEventListener("abort", cancel);
          try { await reader.cancel(); } catch { /* 已读完或已取消的流没有待保留下载结果。 */ }
        }
      })()]);
    } catch (error) {
      if (parent?.aborted || error instanceof PersonalMediaError) throw error;
      if (attempt === 2) throw new PersonalMediaError("download_failed");
      await delay(250 * (attempt + 1), undefined, { signal: parent });
    } finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
  }
  throw new PersonalMediaError("download_failed");
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-07-inbound-image-staging.md
export function personalMedia(profile: string, getHarness: () => Harness, supportsImages: () => boolean = () => true, artifactReader?: ToolRegistration) {
  const staging = new Map<string, { source: PersonalMediaSource; body: string; identities: string[]; pending: Promise<MediaMessage> }>();
  const harness = () => getHarness();
  async function register(tx: Tx, ref: PersonalImageReference): Promise<ImageContent> {
    if (ref.artifact.partial || !validMime(ref.artifact.mime) || imageMime(loadPersonalArtifact(profile, ref.artifact)) !== ref.artifact.mime) throw invalid();
    const doc = await tx.doc(PersonalImageDoc, ref.artifact.id, null);
    if (doc.image) { if (!isDeepStrictEqual(doc.image.ref, ref)) throw invalid(); return block(ref); }
    const index = await tx.doc(PersonalMediaDoc);
    const entry = await tx.appendEntry(ref.conversationId, { kind: "ruukoto.image-reference", data: ref });
    doc.image = { ref, entry: entry.id }; index.images.push(ref.artifact.id);
    return block(ref);
  }
  async function verifyMessage(tx: Tx, message: MediaMessage) {
    const accepted = await tx.entry(message.accepted);
    if (!accepted || accepted.kind !== "ruukoto.media-received" || accepted.conversationId !== ROOT_CONVERSATION_ID || !isDeepStrictEqual(accepted.data, { key: message.key, source: message.source, body: message.body, identities: message.identities })) throw invalid();
  }
  async function verify(tx: Tx, ref: PersonalImageReference, sessionId?: string) {
    const saved = (await tx.doc(PersonalImageDoc, ref.artifact.id, null)).image;
    if (!saved || !isDeepStrictEqual(saved.ref, ref)) throw invalid();
    const anchor = await tx.entry(saved.entry);
    if (!anchor || anchor.conversationId !== ref.conversationId || anchor.kind !== "ruukoto.image-reference" || !isDeepStrictEqual(anchor.data, ref)) throw invalid();
    if (sessionId !== undefined && (await tx.doc(ProviderDoc, ref.conversationId)).sessionId !== sessionId) throw invalid();
    const image = block(ref);
    if (ref.source.kind === "inbound") {
      const message = (await tx.doc(PersonalMediaMessageDoc, ref.source.requestId, null)).message;
      const submission = await tx.submissionByRequest(ref.conversationId, ref.source.requestId);
      const entry = submission?.entry === undefined ? undefined : await tx.entry(submission.entry);
      if (!message || message.key !== ref.source.requestId || !["ready", "bound"].includes(message.state) || !message.artifacts.some(artifact => isDeepStrictEqual(artifact, ref.artifact)) || ref.conversationId !== ROOT_CONVERSATION_ID || !submission || submission.type !== "input" || message.submissionId !== undefined && message.submissionId !== submission.id || !entry || entry.kind !== "pi.user" || entry.conversationId !== ref.conversationId || !contains(entry.model, image)) throw invalid();
      await verifyMessage(tx, message);
      {
        const receipt = (await tx.doc(PersonalTelegramReceiptDoc, message.key, null)).receipt;
        const task = receipt && await tx.task(receipt.taskId);
        if (!receipt || (receipt.platform ?? "telegram") !== message.source.platform || receipt.requestId !== message.key || receipt.media?.key !== message.key || !isDeepStrictEqual(receipt.media.identities, message.identities) || receipt.mediaRejected || receipt.control || receipt.generation !== message.source.generation || receipt.botId !== message.source.accountId || receipt.ownerId !== message.source.ownerId || receipt.content !== message.body || receipt.accepted !== message.accepted || !task || task.kind !== "ruukoto.telegram-input" || task.conversationId !== ROOT_CONVERSATION_ID || receipt.submissionId !== undefined && receipt.submissionId !== submission.id) throw invalid();
      }
    } else {
      const task = await tx.task(ref.source.taskId), input = task?.input;
      if (!task || task.kind !== "pi.tool" || task.conversationId !== ref.conversationId || !input || typeof input !== "object" || Array.isArray(input) || input.kind !== "model" || task.state.status !== "terminal") throw invalid();
      const result = task.state.outcome.result;
      const entry = result && typeof result === "object" && !Array.isArray(result) && typeof result.entryId === "number" ? await tx.entry(result.entryId as EntryId) : undefined;
      if (!entry || entry.kind !== "pi.tool-result" || entry.conversationId !== ref.conversationId || !contains(entry.model, image) || !entry.model?.some(message => message.role === "toolResult" && message.toolCallId === input.callId)) throw invalid();
    }
    if (ref.artifact.partial || !validMime(ref.artifact.mime)) throw invalid();
    const bytes = loadPersonalArtifact(profile, ref.artifact);
    if (imageMime(bytes) !== ref.artifact.mime) throw invalid();
    return bytes;
  }
  async function reject(key: string, reason: MediaReason) {
    return harness().commit(async tx => {
      const message = (await tx.doc(PersonalMediaMessageDoc, key, null)).message;
      if (!message || message.state === "bound") throw invalid();
      message.state = reason === "orphan_expired" ? "expired" : "rejected"; message.reason = reason; return copyJson(message) as MediaMessage;
    }, context);
  }
  async function stage(input: { key: string; source: PersonalMediaSource; body: string; media: PersonalMediaDownload[] }, signal?: AbortSignal): Promise<MediaMessage> {
    const active = staging.get(input.key);
    if (active) {
      if (!isDeepStrictEqual(active.source, input.source) || active.body !== input.body || !isDeepStrictEqual(active.identities, input.media.map(value => value.identity))) throw new PersonalError("media_input_conflict", "在途图片消息的来源或内容不符，未合并；请保留档案。");
      return active.pending;
    }
    const work = async () => {
      let message = await harness().commit(async tx => {
        const doc = await tx.doc(PersonalMediaMessageDoc, input.key, null);
        if (doc.message) {
          if (!isDeepStrictEqual(doc.message.source, input.source) || doc.message.body !== input.body || !isDeepStrictEqual(doc.message.identities, input.media.map(value => value.identity))) throw new PersonalError("media_input_conflict", "原图片消息的来源或内容不符，未重新接纳；请保留档案。");
          return copyJson(doc.message) as MediaMessage;
        }
        const accepted = (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ruukoto.media-received", data: { key: input.key, source: input.source, body: input.body, identities: input.media.map(value => value.identity) } })).id;
        doc.message = { key: input.key, source: input.source, body: input.body, receivedAt: Date.now(), accepted, identities: input.media.map(value => value.identity), artifacts: [], state: "staging" };
        (await tx.doc(PersonalMediaDoc)).keys.push(input.key); return copyJson(doc.message) as MediaMessage;
      }, context);
      if (message.state !== "staging") return message;
      if (!input.media.length || input.media.length > MAX_IMAGES) return reject(input.key, "too_many_images");
      if (!supportsImages()) return reject(input.key, "image_input_unsupported");
      try {
        for (const [index, download] of input.media.entries()) {
          if (message.artifacts[index]) { loadPersonalArtifact(profile, message.artifacts[index]); continue; }
          const value = await downloadImage(download, signal); signal?.throwIfAborted();
          const artifact = await savePersonalArtifact(profile, value.bytes, { mime: value.mimeType });
          message = await harness().commit(async tx => {
            const doc = (await tx.doc(PersonalMediaMessageDoc, input.key, null)).message!;
            if (doc.state !== "staging" || doc.artifacts.length !== index) throw invalid();
            doc.artifacts.push(artifact); await register(tx, { version: 1, artifact, conversationId: ROOT_CONVERSATION_ID, source: { kind: "inbound", requestId: input.key } }); return copyJson(doc) as MediaMessage;
          }, context);
        }
        return harness().commit(async tx => { const message = (await tx.doc(PersonalMediaMessageDoc, input.key, null)).message!; message.state = "ready"; return copyJson(message) as MediaMessage; }, context);
      } catch (error) { if (signal?.aborted || !(error instanceof PersonalMediaError)) throw error; return reject(input.key, error.reason); }
    };
    const pending = work().finally(() => { staging.delete(input.key); }); staging.set(input.key, { source: copyJson(input.source) as PersonalMediaSource, body: input.body, identities: input.media.map(value => value.identity), pending }); return pending;
  }
  const modelMedia: PersonalModelMedia = { async prepare(input, sessionId) {
    const replacements = new Map<string, string>(), placeholders = new Map<string, string>(), expected = new Map<string, number>(), expectedMime = new Map<string, string>(), mappings = new Map<string, { sha256: string; references: PersonalImageReference[]; payloadReference: PersonalImageReference }>();
    const messages: Context["messages"] = [];
    for (const message of input.messages) {
      if (message.role === "assistant" || message.role === "system" || typeof message.content === "string") { messages.push(message); continue; }
      const content = [];
      for (const part of message.content) {
        if (part.type !== "image") { content.push(part); continue; }
        const ref = reference(part), bytes = await harness().commit(tx => verify(tx, ref, sessionId), context), data = bytes.toString("base64");
        expectedMime.set(data, part.mimeType); placeholders.set(part.data, data); expected.set(data, (expected.get(data) ?? 0) + 1);
        const mapping = mappings.get(data);
        if (mapping) mapping.references.push(ref);
        else { mappings.set(data, { sha256: ref.artifact.sha256, references: [ref], payloadReference: ref }); replacements.set(data, part.data); replacements.set(`data:${part.mimeType};base64,${data}`, `ruukoto-image:${part.data}`); }
        content.push({ ...part, data });
      }
      messages.push({ ...message, content });
    }
    const snapshot = (value: unknown, actualPayload = false): JsonValue => {
      const result = JSON.parse(JSON.stringify(value)) as JsonValue, seen = new Map<string, number>();
      const object = (part: unknown): part is Record<string, unknown> => !!part && typeof part === "object" && !Array.isArray(part);
      const imageData = (value: unknown, mimeType: unknown, placeholder: boolean): string => {
        if (typeof value !== "string") throw invalid();
        const data = placeholder ? placeholders.get(value) : expected.has(value) ? value : undefined;
        if (!data || mimeType !== expectedMime.get(data)) throw invalid();
        seen.set(data, (seen.get(data) ?? 0) + 1); return replacements.get(value) ?? value;
      };
      const imageUrl = (value: unknown): string => {
        if (typeof value !== "string") throw invalid();
        const replacement = replacements.get(value), data = value.slice(value.indexOf(",") + 1);
        if (!replacement || !value.startsWith("data:image/") || !expected.has(data)) throw invalid();
        seen.set(data, (seen.get(data) ?? 0) + 1); return replacement;
      };
      const content = (parts: unknown, payload: boolean) => {
        if (!Array.isArray(parts)) return;
        for (const part of parts) {
          if (!object(part)) continue;
          if (part.type === "image") {
            if (!payload) part.data = imageData(part.data, part.mimeType, true);
            else {
              if (!object(part.source) || part.source.type !== "base64") throw invalid();
              part.source.data = imageData(part.source.data, part.source.media_type, false);
            }
          } else if (payload && part.type === "image_url") {
            if (!object(part.image_url)) throw invalid(); part.image_url.url = imageUrl(part.image_url.url);
          } else if (payload && part.type === "input_image") part.image_url = imageUrl(part.image_url);
          else if (payload && part.type === "tool_result") content(part.content, true);
        }
      };
      if (object(result)) {
        const messages = actualPayload && Array.isArray(result.input) ? result.input : result.messages;
        if (Array.isArray(messages)) for (const message of messages) {
          if (!object(message)) continue;
          if (actualPayload || message.role === "user" || message.role === "toolResult") content(message.content, actualPayload);
        }
      }
      if (!isDeepStrictEqual(seen, expected)) throw invalid();
      return result;
    };
    return { input: { ...input, messages }, snapshot, ...(mappings.size ? { imageMappings: JSON.parse(JSON.stringify([...mappings.values()])) as JsonValue } : {}) };
  } };
  return { extension: defineExtension({ name: PERSONAL_MEDIA, ...(artifactReader ? { tools: [artifactReader] } : {}) }), modelMedia, stage, supportsImages, reject,
    async message(key: string) { return (await harness().snapshot(PersonalMediaMessageDoc, key, context))?.message; },
    async input(key: string): Promise<UserInput> {
      const message = (await harness().snapshot(PersonalMediaMessageDoc, key, context))?.message;
      if (!message || !["ready", "bound"].includes(message.state) || message.artifacts.length !== message.identities.length) throw invalid();
      return [{ type: "text", text: message.body || "请查看这条消息中的图片。" }, ...message.artifacts.flatMap(artifact => [{ type: "text" as const, text: `[图片产物：${artifact.id}；${artifact.mime}；${artifact.bytes}字节。宿主恢复原图为视觉输入；压缩摘要不包含图片的视觉细节。]` }, block({ version: 1, artifact, conversationId: ROOT_CONVERSATION_ID, source: { kind: "inbound", requestId: key } })])];
    },
    async bind(tx: Tx, key: string, submissionId: SubmissionId) {
      const message = (await tx.doc(PersonalMediaMessageDoc, key, null)).message, submission = await tx.submissionByRequest(ROOT_CONVERSATION_ID, key);
      if (!message || !["ready", "bound"].includes(message.state) || submission?.id !== submissionId || submission.type !== "input" || message.submissionId !== undefined && message.submissionId !== submissionId) throw invalid();
      message.state = "bound"; message.submissionId = submissionId;
    },
    mediaArtifacts,
    async registerImage(tx: Tx, artifact: PersonalArtifact, source: { conversationId: ConversationId; taskId: TaskId }) {
      const task = await tx.task(source.taskId);
      if (!task || task.kind !== "pi.tool" || task.conversationId !== source.conversationId) throw invalid();
      return register(tx, { version: 1, artifact, conversationId: source.conversationId, source: { kind: "tool", taskId: source.taskId } });
    },
    async recover() {
      const index = await harness().snapshot(PersonalMediaDoc, context);
      if (!index) return;
      for (const key of index.keys) {
        const message = (await harness().snapshot(PersonalMediaMessageDoc, key, context))?.message;
        if (!message || message.key !== key || !Number.isSafeInteger(message.receivedAt) || message.receivedAt < 0) throw invalid();
        await harness().commit(tx => verifyMessage(tx, message), context);
        if (message.state === "bound") {
          await harness().commit(async tx => { for (const artifact of message.artifacts) await verify(tx, { version: 1, artifact, conversationId: ROOT_CONVERSATION_ID, source: { kind: "inbound", requestId: key } }); }, context); continue;
        }
        const submission = await harness().commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, key), context);
        if (submission) { await harness().commit(tx => this.bind(tx, key, submission.id), context); continue; }
        if (message.state === "staging") {
          if (message.artifacts.length > 0 && message.artifacts.length === message.identities.length && message.artifacts.length <= MAX_IMAGES) {
            for (const artifact of message.artifacts) {
              if (artifact.partial || !validMime(artifact.mime) || imageMime(loadPersonalArtifact(profile, artifact)) !== artifact.mime) throw invalid();
            }
            await harness().commit(async tx => {
              for (const artifact of message.artifacts) {
                const saved = (await tx.doc(PersonalImageDoc, artifact.id, null)).image;
                if (!saved || !isDeepStrictEqual(saved.ref, { version: 1, artifact, conversationId: ROOT_CONVERSATION_ID, source: { kind: "inbound", requestId: key } })) throw invalid();
              }
              (await tx.doc(PersonalMediaMessageDoc, key, null)).message!.state = "ready";
            }, context);
          } else await reject(key, "download_interrupted");
        }
        if (Date.now() - message.receivedAt >= TTL_MS) {
          if (message.state !== "expired") await reject(key, "orphan_expired");
          for (const artifact of message.artifacts) {
            const filename = path.join(profile, "artifacts", `${artifact.id}.bin`);
            if (!fs.existsSync(filename)) continue;
            loadPersonalArtifact(profile, artifact); fs.unlinkSync(filename);
          }
        }
      }
    },
  };
}
export type PersonalMedia = ReturnType<typeof personalMedia>;
export function personalMediaRejection(reason: MediaReason): string {
  return reason === "image_input_unsupported" ? "当前模型不支持图片，本条消息未交给模型。请通过本机向导配置支持图片的模型后重新发送。" : ["download_unavailable", "download_failed", "download_interrupted"].includes(reason) ? "图片下载未完成，本条消息未交给模型。请检查入口后重新发送图片。" : "图片格式、大小或保留状态不符合要求，本条消息未交给模型。仅支持JPEG、PNG、WebP，每条最多4张、单图最多8MiB；请调整后重新发送。";
}

/** 列表只核对持久归属；读取与导出仍须按产物原文件身份和哈希核实。 */
export async function mediaArtifacts(tx: Tx, conversationId: ConversationId = ROOT_CONVERSATION_ID) {
  const result: { artifact: PersonalArtifact; conversationId: ConversationId; source: ImageSource }[] = [];
  for (const id of (await tx.doc(PersonalMediaDoc)).images) {
    const saved = (await tx.doc(PersonalImageDoc, id, null)).image;
    if (!saved) throw invalid();
    const ref = saved.ref;
    if (conversationId !== ROOT_CONVERSATION_ID && ref.conversationId !== conversationId) continue;
    const anchor = await tx.entry(saved.entry);
    if (!anchor || anchor.conversationId !== ref.conversationId || anchor.kind !== "ruukoto.image-reference" || !isDeepStrictEqual(anchor.data, ref)) throw invalid();
    if (ref.source.kind === "inbound") {
      const message = (await tx.doc(PersonalMediaMessageDoc, ref.source.requestId, null)).message;
      if (!message || !message.artifacts.some(artifact => isDeepStrictEqual(artifact, ref.artifact))) throw invalid();
      if (message.state !== "bound") continue;
      if ((await tx.submissionByRequest(ref.conversationId, ref.source.requestId))?.id !== message.submissionId) throw invalid();
    } else {
      const task = await tx.task(ref.source.taskId);
      if (!task || task.kind !== "pi.tool" || task.conversationId !== ref.conversationId) throw invalid();
    }
    result.push({ artifact: copyJson(ref.artifact) as PersonalArtifact, conversationId: ref.conversationId, source: copyJson(ref.source) as ImageSource });
  }
  return result;
}
