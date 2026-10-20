import type { AttachmentReference } from "@ruukoto/core/attachments.ts";
import type { Store } from "@ruukoto/core/store.ts";
import type { Task } from "@ruukoto/core/types.ts";

export class AttachmentReferenceError extends Error { readonly code = "attachment_reference_invalid"; }

export function taskAttachmentReferences(task: Task, store: Store): AttachmentReference[] {
  const tasks = new Set<string>();
  const references = new Map<string, AttachmentReference>();
  let source: Task | null = task;
  while (source) {
    if (source.sessionId !== task.sessionId || tasks.has(source.id)) throw new AttachmentReferenceError("附件继续来源不属于当前会话或存在循环");
    tasks.add(source.id);
    for (const ref of store.taskAttachments(source.id)) {
      const artifact = store.getArtifact(ref.id);
      if (!artifact || ref.taskId !== source.id || ref.sessionId !== task.sessionId || artifact.taskId !== ref.taskId || artifact.sessionId !== ref.sessionId || artifact.status !== "complete" || artifact.contentHash !== ref.contentHash || artifact.byteCount !== ref.size || artifact.name !== ref.name || (artifact.mimeType ?? null) !== ref.mimeType) throw new AttachmentReferenceError("附件来源或产物不一致");
      references.set(ref.id, ref);
    }
    if (!source.resumesTaskId) break;
    source = store.getTask(source.resumesTaskId);
    if (!source) throw new AttachmentReferenceError("附件继续来源任务不存在");
  }
  return [...references.values()];
}

/** 附件提示从历史稳定引用恢复，原用户文字不附加内部路径或产物说明。 */
export function attachmentReferenceView(messages: any[], allowed: (ref: AttachmentReference) => boolean): any[] {
  return messages.map(message => {
    const refs = message?.ruukotoAttachmentRefs;
    if (refs === undefined) return message;
    if (message.role !== "user" || !Array.isArray(refs)) throw new AttachmentReferenceError("历史附件引用格式无效");
    if (typeof message.content !== "string" && !Array.isArray(message.content)) throw new AttachmentReferenceError("历史附件消息正文格式无效");
    const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : [...message.content];
    for (const ref of refs as AttachmentReference[]) {
      if (!ref || typeof ref.id !== "string" || typeof ref.taskId !== "string" || typeof ref.sessionId !== "string" || typeof ref.name !== "string" || typeof ref.contentHash !== "string" || !Number.isSafeInteger(ref.size) || ref.size < 0 || !allowed(ref)) throw new AttachmentReferenceError("历史附件引用或读取范围无效");
      if (!ref.mimeType) content.push({ type: "text", text: `\n[用户附件 ${JSON.stringify(ref.name)}：产物 ${ref.id}，${ref.size} 字节。使用 read_artifact 的 artifact_id=${JSON.stringify(ref.id)} 按字节读取；文本使用 encoding=utf8，二进制使用 encoding=base64。]` });
    }
    return { ...message, content };
  });
}
