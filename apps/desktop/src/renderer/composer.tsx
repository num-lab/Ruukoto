import { useEffect, useRef, useState } from "react";
import { ArrowUp, Brain, ChevronDown, FileCode2, ListTodo, Loader2, MessageCircleQuestion, Pause, Plus, ShieldCheck, ShieldOff, Square, X } from "lucide-react";
import { MAX_ATTACHMENTS } from "@ruukoto/core/attachments.ts";
import type { OpResult } from "@ruukoto/control/ops.ts";
import type { ModelSelection, Session, SessionDefaultMode } from "@ruukoto/core/types.ts";
import type { CodeState } from "./code-state.ts";
import { queueDecision } from "./code-writes.ts";
import { Button } from "./components/ui/button.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./components/ui/dropdown-menu.tsx";
import { ContextIndicator } from "./context-indicator.tsx";
import { IconButton } from "./ui.tsx";

export const composerModes = [
  { value: "confirm", label: "Ask for approval", icon: MessageCircleQuestion },
  { value: "auto-review", label: "Auto review", icon: ShieldCheck },
  { value: "full_access", label: "Full access", icon: ShieldOff },
  { value: "plan", label: "Plan", icon: ListTodo },
] satisfies { value: SessionDefaultMode; label: string; icon: typeof MessageCircleQuestion }[];
export function submitOnEnter(event: { key: string; shiftKey: boolean; repeat: boolean; nativeEvent: { isComposing?: boolean; keyCode?: number }; preventDefault(): void }, canSend: boolean, send: () => void): void {
  if (event.key !== "Enter" || event.shiftKey || event.repeat || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
  event.preventDefault();
  if (canSend) send();
}

type ModelOption = OpResult<"list_models">["models"][number];
const modelKey = (model: Pick<ModelSelection, "provider" | "modelId">) => JSON.stringify([model.provider, model.modelId]);
const effortLabel = (level: string) => level[0].toUpperCase() + level.slice(1);
export function selectionForModel(option: ModelOption, current: ModelSelection | null): ModelSelection | null {
  const thinkingLevel = current && option.thinkingLevels.includes(current.thinkingLevel) ? current.thinkingLevel : option.thinkingLevels[0];
  return option.available && thinkingLevel ? { provider: option.provider, modelId: option.modelId, thinkingLevel } : null;
}
export function ModeSelector({ value, modes: availableModes, disabled, onChange }: { value: SessionDefaultMode; modes: typeof composerModes; disabled: boolean; onChange: (mode: SessionDefaultMode) => void }) {
  const current = availableModes.find(mode => mode.value === value) ?? availableModes[0];
  return <Select value={value} onValueChange={next => { const mode = availableModes.find(mode => mode.value === next); if (mode) onChange(mode.value); }} disabled={disabled}><SelectTrigger className="mode-selector" aria-label="会话默认模式" aria-description={current.label}><SelectValue><current.icon className="mode-icon" aria-hidden="true" /><span className="mode-selector-label">{current.label}</span></SelectValue></SelectTrigger><SelectContent className="composer-menu" position="popper" side="top" align="start" sideOffset={6}>{availableModes.map(mode => <SelectItem key={mode.value} value={mode.value} textValue={mode.label}><mode.icon className="mode-icon" aria-hidden="true" /><span>{mode.label}</span></SelectItem>)}</SelectContent></Select>;
}
export function ModelSelector({ models, selected, loading, disabled, onChange }: { models: ModelOption[]; selected: ModelSelection | null; loading: () => void; disabled: boolean; onChange: (selection: ModelSelection) => void }) {
  const value = selected ? modelKey(selected) : "";
  const option = models.find(item => modelKey(item) === value);
  const levels = option?.thinkingLevels ?? [];
  return <DropdownMenu onOpenChange={open => { if (open) loading(); }}><DropdownMenuTrigger asChild><Button type="button" variant="ghost" className="model-selector" aria-label="会话模型" aria-description={`${option?.name ?? selected?.modelId ?? "选择模型"} · Effort: ${selected ? effortLabel(selected.thinkingLevel) : "—"}`} disabled={disabled}><Brain className="model-selector-icon" /><span className="model-selector-name">{option?.name ?? selected?.modelId ?? "选择模型"}</span>{selected && <span className="model-selector-effort">{effortLabel(selected.thinkingLevel)}</span>}<ChevronDown className="model-selector-chevron" /></Button></DropdownMenuTrigger><DropdownMenuContent className="composer-menu model-menu" side="top" align="end" sideOffset={6} aria-label="模型与 Effort"><DropdownMenuRadioGroup aria-label="会话模型" value={value} onValueChange={next => { const item = models.find(item => modelKey(item) === next); const selection = item && selectionForModel(item, selected); if (!disabled && selection) onChange(selection); }}>{selected && !option && <DropdownMenuRadioItem value={value} disabled aria-description="当前模型未在目录中，可用性未知">{selected.modelId}</DropdownMenuRadioItem>}{models.map(item => <DropdownMenuRadioItem key={modelKey(item)} value={modelKey(item)} disabled={disabled || !item.available || !item.thinkingLevels.length}>{item.name}{!item.available && " · 认证不可用"}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup><DropdownMenuSeparator /><DropdownMenuLabel>Effort</DropdownMenuLabel><DropdownMenuRadioGroup aria-label="Effort" value={selected?.thinkingLevel ?? ""} onValueChange={level => { const thinkingLevel = levels.find(item => item === level); if (!disabled && option?.available && selected && thinkingLevel) onChange({ ...selected, thinkingLevel }); }}>{selected && !levels.includes(selected.thinkingLevel) && <DropdownMenuRadioItem value={selected.thinkingLevel} disabled>{effortLabel(selected.thinkingLevel)}</DropdownMenuRadioItem>}{levels.map(level => <DropdownMenuRadioItem key={level} value={level} disabled={disabled || !option?.available}>{effortLabel(level)}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu>;
}
// Note: 见 .agents/notes/implemented/architecture/2026-10-16-desktop-current-demo.md
export function Composer({ model, session }: { model: CodeState; session: Session }) {
  const writes = model.writes;
  const draft = writes.draft(session.id);
  const input = useRef<HTMLTextAreaElement>(null);
  const [queueConfirm, setQueueConfirm] = useState(false);
  const picking = !!draft.attaching;
  const online = model.status.state === "online";
  const checking = writes.checking(session.id);
  const blocked = writes.blocked(session.id);
  const attachments = draft.attachments ?? [];
  const hasInput = !!draft.text.trim() || attachments.length > 0;
  const active = model.view.activeTaskFor(session.id);
  const stopping = !!active && !hasInput;
  const availableModes = model.target === "personal" ? composerModes.filter(mode => mode.value !== "plan") : composerModes;
  const selected = session.modelSelection;
  const decision = queueDecision(model.view, session);
  useEffect(() => { if (online) void writes.loadModels(); }, [writes, online, model.view.instanceId, writes.modelGeneration]);
  useEffect(() => { if (model.view.openSession(session.id).historyLoaded && model.view.openSession(session.id).flow.items.length === 0) input.current?.focus(); }, [model, session.id, model.view.openSession(session.id).historyLoaded]);
  useEffect(() => { void writes.preparePending(session.id); }, [writes, session.id, writes.entries, model.view.instanceId, online]);
  function send() {
    if (blocked || picking) return;
    if (stopping) { void writes.control("interrupt", session.id, active!.id); return; }
    void writes.send(session.id);
  }
  async function attach() {
    if (writes.blocked(session.id)) return;
    const instanceId = model.view.instanceId;
    draft.attaching = true; model.refresh();
    try {
      const result = await window.ruukoto.pickAttachments(session.id, model.target);
      if (instanceId !== model.view.instanceId) return;
      if (!result.ok) writes.message = result.error.message;
      else if ((draft.attachments?.length ?? 0) + result.value.length > MAX_ATTACHMENTS) writes.message = `每条输入最多附加 ${MAX_ATTACHMENTS} 个文件。`;
      else draft.attachments = [...(draft.attachments ?? []), ...result.value];
      model.refresh();
    } catch { writes.message = "未能附加文件，请重新打开应用后选择。"; model.refresh(); }
    finally { draft.attaching = false; model.refresh(); }
  }
  return <div className="composer-wrap"><div className="composer-width">
    {session.queueState === "paused" && <div className="task-notice"><Pause /><span>队列暂停 · {model.view.queuedTasksFor(session.id).length} 个任务等待继续</span><Button variant="ghost" size="sm" disabled={!online || blocked} onClick={() => {
      if (decision.kind === "select_model") { writes.message = "旧排队任务缺少模型，请先选择模型。"; model.refresh(); }
      else if (decision.kind === "confirm") setQueueConfirm(true);
      else void writes.resume(session);
    }}>恢复队列</Button></div>}
    {draft.taskId && <div className="task-notice"><span>正在继续中断的任务</span><Button variant="ghost" size="sm" disabled={checking} onClick={() => { delete draft.taskId; writes.edit(session.id, draft.text); }}>改为新任务</Button></div>}
    <form className="surface-composer composer" onSubmit={event => { event.preventDefault(); send(); }}>
      {attachments.length > 0 && <div className="attached-files" aria-label="已附加文件">{attachments.map(attachment => <span className="attachment-chip" key={attachment.id}><FileCode2 /><span>{attachment.name}</span><button type="button" disabled={checking} aria-label={`移除附件 ${attachment.name}`} onClick={() => { draft.attachments = attachments.filter(item => item.id !== attachment.id); model.refresh(); }}><X /></button></span>)}</div>}
      <Textarea ref={input} aria-label="输入消息" rows={2} readOnly={checking} value={draft.text} placeholder={draft.taskId ? "输入继续任务的指示…" : "描述你想做的事…"} onChange={event => writes.edit(session.id, event.target.value)} onKeyDown={event => submitOnEnter(event, hasInput && !blocked && !picking && !!session.modelSelection, send)} />
      <div className="composer-actions"><div className="composer-left"><IconButton className="attachment-button" label="附加文件" disabled={blocked || picking || attachments.length >= MAX_ATTACHMENTS} onClick={() => void attach()}><Plus /></IconButton><ModeSelector value={session.defaultAccessMode} modes={availableModes} disabled={blocked} onChange={mode => void writes.setMode(session, mode)} /></div>
        <div className="composer-right"><ContextIndicator context={model.context.get(session.id)} onOpen={() => void model.context.load(session.id)} /><ModelSelector models={writes.models} selected={selected} loading={() => void writes.loadModels()} disabled={blocked} onChange={selection => void writes.setModel(session, selection)} /><Button size="icon" className="send-button" type="submit" disabled={blocked || picking || (!stopping && (!hasInput || !session.modelSelection))} aria-label={checking ? "正在核实输入" : stopping ? "停止任务" : draft.taskId ? "发送并继续" : "发送消息"} aria-busy={checking}>{checking ? <Loader2 className="animate-spin" /> : stopping ? <Square fill="currentColor" /> : <ArrowUp />}</Button></div>
      </div>
    </form>
  </div><Dialog open={queueConfirm && decision.kind === "confirm"} onOpenChange={setQueueConfirm}><DialogContent className="demo-dialog"><DialogHeader><DialogTitle>恢复队列</DialogTitle><DialogDescription>{decision.kind === "confirm" ? `为 ${decision.count} 个旧任务补齐 ${decision.selection.modelId} · ${decision.selection.thinkingLevel}，然后恢复队列。` : ""}</DialogDescription></DialogHeader><DialogFooter><Button variant="ghost" onClick={() => setQueueConfirm(false)}>取消</Button><Button disabled={blocked} onClick={() => { setQueueConfirm(false); void writes.resume(session, true); }}>补齐模型并恢复</Button></DialogFooter></DialogContent></Dialog></div>;
}
