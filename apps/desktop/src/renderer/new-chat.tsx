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
import { useComposerCommands, type ComposerCommandActions } from "./composer-commands.tsx";

export interface NewChatDraftState {
  requestId?: string;
  workspaceId: string;
  text: string;
  modelSelection: ModelSelection | null;
  mode: SessionDefaultMode;
  attachments: DesktopAttachment[];
  attaching?: boolean;
  attempted?: boolean;
}
// Note: See .agents/notes/implemented/feature/2026-10-20-desktop-new-chat.md
// Note: See .agents/notes/implemented/feature/2026-11-07-managed-coding-workspaces.md
/** A local Code draft is the online canvas before any conversation is selected. */
export function showsNewChat(target: DesktopTarget, online: boolean, hasCurrent: boolean, hasDraft: boolean): boolean {
  return target === "code" && (hasDraft || (online && !hasCurrent));
}
export function NewChatDraft({ model, workspaces, value, fallbackSelection, onChange, onSend, onAddWorkspace, starting, blocked, onSkills }: { model: CodeState; workspaces: Project[]; value: NewChatDraftState; fallbackSelection: ModelSelection | null; onChange: (value: NewChatDraftState) => void; onSend: (input?: string) => void; onAddWorkspace: () => void; starting: boolean; blocked: boolean } & ComposerCommandActions) {
  const writes = model.writes;
  const input = useRef<HTMLTextAreaElement>(null);
  const selected = workspaces.find(project => project.id === value.workspaceId && project.rootDir !== null && !project.managed);
  const online = model.status.state === "online";
  const busy = starting || blocked || !!value.attaching;
  const attachments = value.attachments;
  const hasInput = !!value.text.trim() || attachments.length > 0;
  // Model and mode stay local until creation binds them to the first conversation.
  const selection = value.modelSelection ?? fallbackSelection;
  const commands = useComposerCommands({ model, text: value.text, edit: text => onChange({ ...latest.current, text }), input, locked: busy || !!value.attempted, onNew: () => {}, onSkills });
  const canSend = commands.application ? !busy && !value.attempted : (!value.workspaceId || !!selected) && hasInput && !!selection && !busy && online;
  const latest = useRef(value);
  latest.current = value;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (online) void writes.loadModels(); }, [writes, online, model.view.instanceId]);
  useEffect(() => { resizeComposerInput(input.current); }, [value.text]);
  useEffect(() => {
    const resize = () => resizeComposerInput(input.current);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => { input.current?.focus(); }, []);
  function send() { if (!canSend) return; if (commands.application) { void commands.execute(); return; } onSend(commands.parsed?.kind === "skill" ? commands.parsed.input : undefined); }
  // Upload needs the identity established by the first send.
  async function attach() {
    if (value.attaching) return;
    const instanceId = model.view.instanceId;
    onChange({ ...value, attaching: true });
    try {
      const result = await window.ruukoto.pickDraftAttachments();
      if (!mounted.current || instanceId !== model.view.instanceId || value.requestId !== latest.current.requestId) return;
      if (!result.ok) writes.message = result.error.message;
      else if (latest.current.attachments.length + result.value.length > MAX_ATTACHMENTS) writes.message = `Attach at most ${MAX_ATTACHMENTS} files per message.`;
      else { onChange({ ...latest.current, attaching: false, attachments: [...latest.current.attachments, ...result.value] }); return; }
      onChange({ ...latest.current, attaching: false });
      model.refresh();
    } catch { if (!mounted.current || value.requestId !== latest.current.requestId) return; writes.message = "Couldn't attach the file. Reopen the app and choose again."; onChange({ ...latest.current, attaching: false }); model.refresh(); }
  }
  return <div className="new-chat-page"><div className="composer-wrap new-chat-wrap"><div className="composer-width">
    <WorkspacePicker workspaces={workspaces} value={value.workspaceId} allowManaged disabled={busy || !!value.attempted} onChange={workspaceId => { onChange({ ...value, workspaceId }); input.current?.focus(); }} onAdd={onAddWorkspace} />
      <form className="surface-composer composer" onSubmit={event => { event.preventDefault(); send(); }}>
        {attachments.length > 0 && <div className="attached-files" aria-label="Attached files">{attachments.map(attachment => <span className="attachment-chip" key={attachment.id}><FileCode2 /><span>{attachment.name}</span><button type="button" disabled={busy || value.attempted} aria-label={`Remove attachment ${attachment.name}`} onClick={() => onChange({ ...value, attachments: attachments.filter(item => item.id !== attachment.id) })}><X /></button></span>)}</div>}
        {commands.menu}
        <Textarea ref={input} {...commands.inputProps} aria-label="Type a message" rows={2} readOnly={starting || value.attempted} value={value.text} placeholder="Task or question" onChange={event => onChange({ ...value, text: event.target.value })} onKeyDown={event => { if (!commands.keyDown(event)) submitOnEnter(event, canSend, send); }} />
        <div className="composer-actions"><div className="composer-left"><IconButton className="attachment-button" label="Attach files" disabled={busy || !!value.attempted || attachments.length >= MAX_ATTACHMENTS} onClick={() => void attach()}><Plus /></IconButton><ModeSelector value={value.mode} modes={composerModes} disabled={busy || !!value.attempted || !online} open={commands.selector === "mode" ? true : undefined} onOpenChange={open => { if (!open) commands.closeSelector(); }} onChange={mode => onChange({ ...value, mode })} /></div>
          <div className="composer-right"><ModelSelector models={writes.models} selected={selection} loading={() => void writes.loadModels()} disabled={busy || !!value.attempted || !online} open={commands.selector === "model" ? true : undefined} onOpenChange={open => { if (!open) commands.closeSelector(); }} onChange={modelSelection => onChange({ ...value, modelSelection })} /><Button size="icon" className="send-button" type="submit" disabled={!canSend} aria-label="Send message" aria-busy={starting}>{starting ? <Loader2 className="animate-spin" /> : <ArrowUp />}</Button></div>
        </div>
      </form>
  </div></div>{commands.help}</div>;
}
