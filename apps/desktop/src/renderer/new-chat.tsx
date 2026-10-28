import { useEffect, useRef } from "react";
import { ArrowUp, FileCode2, Loader2, Plus, X } from "lucide-react";
import { MAX_ATTACHMENTS } from "@ruukoto/core/attachments.ts";
import type { ModelSelection, Project, SessionDefaultMode } from "@ruukoto/core/types.ts";
import type { DesktopAttachment, DesktopTarget } from "../shared/bridge.ts";
import type { CodeState } from "./code-state.ts";
import { ModeSelector, ModelSelector, composerModes, resizeComposerInput, submitOnEnter } from "./composer.tsx";
import { Button } from "./components/ui/button.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { WorkspacePicker } from "./workspace-picker.tsx";
export { filterWorkspaces } from "./workspace-picker.tsx";
import { IconButton } from "./ui.tsx";

export interface NewChatDraftState {
  workspaceId: string;
  text: string;
  modelSelection: ModelSelection | null;
  mode: SessionDefaultMode;
  attachments: DesktopAttachment[];
  attaching?: boolean;
}
// Note: 见 .agents/notes/implemented/feature/2026-10-20-desktop-new-chat.md
/** 主画布何时落在新对话草稿页：Code 目标有草稿，或在线但没有已选会话（启动后未打开、关掉全部标签）；空态页只留给离线与 PA 主会话未就绪。 */
export function showsNewChat(target: DesktopTarget, online: boolean, hasCurrent: boolean, hasDraft: boolean): boolean {
  return target === "code" && (hasDraft || (online && !hasCurrent));
}
export function NewChatDraft({ model, workspaces, value, fallbackSelection, onChange, onSend, onAddWorkspace, starting, blocked }: { model: CodeState; workspaces: Project[]; value: NewChatDraftState; fallbackSelection: ModelSelection | null; onChange: (value: NewChatDraftState) => void; onSend: () => void; onAddWorkspace: () => void; starting: boolean; blocked: boolean }) {
  const writes = model.writes;
  const input = useRef<HTMLTextAreaElement>(null);
  // 没有根目录的旧项目不能作为工作区；只有带根目录的项目才允许开始对话。
  const selected = workspaces.find(project => project.id === value.workspaceId && project.rootDir !== null);
  const online = model.status.state === "online";
  const busy = starting || blocked || !!value.attaching;
  const attachments = value.attachments;
  const hasInput = !!value.text.trim() || attachments.length > 0;
  // 草稿没显式选模型时沿用当前会话或后台默认值，与既有新会话的继承规则一致。
  const selection = value.modelSelection ?? fallbackSelection;
  const canSend = !!selected && hasInput && !!selection && !busy && online;
  useEffect(() => { if (online) void writes.loadModels(); }, [writes, online, model.view.instanceId]);
  useEffect(() => { resizeComposerInput(input.current); }, [value.text]);
  useEffect(() => {
    const resize = () => resizeComposerInput(input.current);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => { input.current?.focus(); }, []);
  function send() { if (canSend) onSend(); }
  // 会话还没建，附件只登记本机文件；建好后由 startChat 补做上传。
  async function attach() {
    if (value.attaching) return;
    const instanceId = model.view.instanceId;
    onChange({ ...value, attaching: true });
    try {
      const result = await window.ruukoto.pickDraftAttachments();
      if (instanceId !== model.view.instanceId) return;
      if (!result.ok) writes.message = result.error.message;
      else if (value.attachments.length + result.value.length > MAX_ATTACHMENTS) writes.message = `每条输入最多附加 ${MAX_ATTACHMENTS} 个文件。`;
      else onChange({ ...value, attachments: [...value.attachments, ...result.value] });
      model.refresh();
    } catch { writes.message = "未能附加文件，请重新打开应用后选择。"; model.refresh(); }
    finally { onChange({ ...value, attaching: false }); }
  }
  return <div className="new-chat-page"><div className="composer-wrap new-chat-wrap"><div className="composer-width">
    <WorkspacePicker workspaces={workspaces} value={value.workspaceId} disabled={busy} onChange={workspaceId => { onChange({ ...value, workspaceId }); input.current?.focus(); }} onAdd={onAddWorkspace} />
      <form className="surface-composer composer" onSubmit={event => { event.preventDefault(); send(); }}>
        {attachments.length > 0 && <div className="attached-files" aria-label="已附加文件">{attachments.map(attachment => <span className="attachment-chip" key={attachment.id}><FileCode2 /><span>{attachment.name}</span><button type="button" disabled={busy} aria-label={`移除附件 ${attachment.name}`} onClick={() => onChange({ ...value, attachments: attachments.filter(item => item.id !== attachment.id) })}><X /></button></span>)}</div>}
        <Textarea ref={input} aria-label="输入消息" rows={2} value={value.text} placeholder="Task or question" onChange={event => onChange({ ...value, text: event.target.value })} onKeyDown={event => submitOnEnter(event, canSend, send)} />
        <div className="composer-actions"><div className="composer-left"><IconButton className="attachment-button" label="附加文件" disabled={busy || attachments.length >= MAX_ATTACHMENTS} onClick={() => void attach()}><Plus /></IconButton><ModeSelector value={value.mode} modes={composerModes} disabled={busy} onChange={mode => onChange({ ...value, mode })} /></div>
          <div className="composer-right"><ModelSelector models={writes.models} selected={selection} loading={() => void writes.loadModels()} disabled={busy} onChange={modelSelection => onChange({ ...value, modelSelection })} /><Button size="icon" className="send-button" type="submit" disabled={!canSend} aria-label="发送消息" aria-busy={starting}>{starting ? <Loader2 className="animate-spin" /> : <ArrowUp />}</Button></div>
        </div>
      </form>
  </div></div></div>;
}
