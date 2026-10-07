/** 入站图片历史只存产物引用；图片正文只在发送边界恢复。 */
import type { Artifact, Task } from "../core/types.ts";
import type { Store } from "../core/store.ts";
import type { ArtifactStore } from "./artifacts.ts";

export const IMAGE_INPUT_UNSUPPORTED = "image_input_unsupported";

export interface ImageReference {
  artifactId: string;
  taskId: string;
  sessionId: string;
  mimeType: NonNullable<Artifact["mimeType"]>;
  byteCount: number;
  contentHash: string;
}

/** 继续链的图片绑定本轮用户消息，避免原交互移出上下文后丢失原图片。 */
export function taskImageReferences(task: Task, store: Store): ImageReference[] {
  const tasks = new Set<string>();
  const artifacts = new Set<string>();
  const references: ImageReference[] = [];
  let source: Task | null = task;
  while (source) {
    if (source.sessionId !== task.sessionId || tasks.has(source.id)) throw new Error("image_reference_invalid:图片继续来源不属于当前会话或存在循环");
    tasks.add(source.id);
    if (source.sourceEventId) {
      const event = store.getInboundEvent(source.sourceEventId);
      if (!event && store.listArtifactsByTask(source.id).some(artifact => artifact.mimeType)) {
        throw new Error("image_reference_invalid:图片来源事件不存在");
      }
      for (const id of event?.artifactRefs ?? []) {
        const artifact = store.getArtifact(id);
        if (!artifact) throw new Error("image_reference_invalid:来源产物不存在");
        if (!artifact.mimeType) continue;
        if (event?.taskId !== source.id || artifact.taskId !== source.id || artifact.sessionId !== task.sessionId ||
            artifact.status !== "complete" || !artifact.contentHash) {
          throw new Error("image_reference_invalid:图片产物尚未完成归属核对");
        }
        if (artifacts.has(id)) continue;
        artifacts.add(id);
        references.push({ artifactId: id, taskId: artifact.taskId, sessionId: artifact.sessionId,
          mimeType: artifact.mimeType, byteCount: artifact.byteCount, contentHash: artifact.contentHash });
      }
    }
    if (!source.resumesTaskId) break;
    source = store.getTask(source.resumesTaskId);
    if (!source) throw new Error("image_reference_invalid:图片继续来源任务不存在");
  }
  return references;
}

/** 创建带图片估算成本的视图；不读正文，压缩和 Jev 也不会接触 base64。 */
export function imageReferenceView(messages: any[], sessionId: string): any[] {
  return messages.map((message) => {
    const refs = message?.ruukotoMediaRefs;
    if (refs === undefined) return message;
    if (message.role !== "user" || !Array.isArray(refs)) throw new Error("image_reference_invalid:会话图片引用格式无效");
    const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : [...message.content];
    for (const ref of refs as ImageReference[]) {
      if (!ref || ref.sessionId !== sessionId || typeof ref.artifactId !== "string" || typeof ref.taskId !== "string" ||
          typeof ref.contentHash !== "string" || !["image/jpeg", "image/png", "image/webp"].includes(ref.mimeType) ||
          !Number.isSafeInteger(ref.byteCount) || ref.byteCount <= 0) throw new Error("image_reference_invalid:会话图片引用格式或归属无效");
      // 摘要器只读取文本，因此同时保留可找回的产物引用与视觉内容缺失说明。
      content.push({ type: "text", text: `\n[入站图片：产物 ${ref.artifactId}；${ref.mimeType}；${ref.byteCount} 字节。图片由宿主恢复为视觉输入；压缩摘要不包含图片的视觉细节。]` });
      content.push({ type: "image", mimeType: ref.mimeType, data: "", ruukotoMediaRef: ref });
    }
    return { ...message, content };
  });
}

export function hasImageInput(messages: any[]): boolean {
  return messages.some((message) => Array.isArray(message?.content) && message.content.some((part: any) => part?.type === "image"));
}

/** 最终发送视图恢复原字节，并复核历史元数据与当前不可变产物一致。 */
export function restoreImageInput(messages: any[], artifacts: ArtifactStore, store: Store): any[] {
  return messages.map((message) => {
    if (!Array.isArray(message?.content)) return message;
    return { ...message, content: message.content.map((part: any) => {
      const ref: ImageReference | undefined = part?.ruukotoMediaRef;
      if (part?.type !== "image" || !ref) return part;
      const artifact = store.getArtifact(ref.artifactId);
      if (!artifact || artifact.mimeType !== ref.mimeType || artifact.contentHash !== ref.contentHash || artifact.byteCount !== ref.byteCount) {
        throw new Error("image_reference_invalid:历史图片元数据与产物不一致");
      }
      return { ...artifacts.readImage(ref.artifactId, { taskId: ref.taskId, sessionId: ref.sessionId }), ruukotoMediaRef: ref };
    }) };
  });
}

/** prompt 快照保留稳定引用，避免同一图片的正文按模型调用重复落盘。 */
export function imageReferenceSnapshot(messages: any[]): any[] {
  return messages.map((message) => !Array.isArray(message?.content) ? message : {
    ...message, content: message.content.map((part: any) => part?.type === "image" && part.ruukotoMediaRef
      ? { type: "image_ref", ...part.ruukotoMediaRef } : part),
  });
}
