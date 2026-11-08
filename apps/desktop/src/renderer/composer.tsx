import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowUp, Brain, Check, FileCode2, ListTodo, Loader2, MessageCircleQuestion, Play, Plus, ShieldCheck, ShieldOff, Square, Waypoints, X } from "lucide-react";
import { MAX_ATTACHMENTS } from "@ruukoto/core/attachments.ts";
import type { OpResult } from "@ruukoto/control/ops.ts";
import type { ModelSelection, Session, SessionDefaultMode, ThinkingLevel } from "@ruukoto/core/types.ts";
import type { CodeState } from "./code-state.ts";
import { queueDecision } from "./code-writes.ts";
import { Button } from "./components/ui/button.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./components/ui/dropdown-menu.tsx";
import { ContextIndicator } from "./context-indicator.tsx";
import { QueuePanel } from "./queue-panel.tsx";
import { IconButton } from "./ui.tsx";
import { useComposerCommands, type ComposerCommandActions } from "./composer-commands.tsx";
import { CompactionPanel } from "./compaction-panel.tsx";

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
export function ModeSelector({ value, modes: availableModes, disabled, onChange, label = "Chat default mode", open, onOpenChange }: { value: SessionDefaultMode; modes: typeof composerModes; disabled: boolean; onChange: (mode: SessionDefaultMode) => void; label?: string; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const [localOpen, setLocalOpen] = useState(false);
  const current = availableModes.find(mode => mode.value === value) ?? availableModes[0];
  return <Select open={open ?? localOpen} onOpenChange={next => { setLocalOpen(next); onOpenChange?.(next); }} value={value} onValueChange={next => { const mode = availableModes.find(mode => mode.value === next); if (mode) onChange(mode.value); }} disabled={disabled}><SelectTrigger className="mode-selector" aria-label={label} aria-description={current.label}><SelectValue><current.icon className="mode-icon" aria-hidden="true" /><span className="mode-selector-label">{current.label}</span></SelectValue></SelectTrigger><SelectContent className="composer-menu" position="popper" side="top" align="start" sideOffset={6}>{availableModes.map(mode => <SelectItem key={mode.value} value={mode.value} textValue={mode.label}><mode.icon className="mode-icon" aria-hidden="true" /><span>{mode.label}</span></SelectItem>)}</SelectContent></Select>;
}
// Note: See .agents/notes/implemented/feature/2026-11-07-desktop-visual-alignment.md
export function EffortSlider({ levels, current, disabled, onChange }: { levels: ThinkingLevel[]; current: ThinkingLevel | null; disabled: boolean; onChange: (level: ThinkingLevel) => void }) {
  const [preview, setPreview] = useState<ThinkingLevel | null>(null);
  const dragging = useRef<"idle" | "active" | "canceled">("idle");
  const stops = levels.length ? levels : current ? [current] : [];
  const displayed = preview ?? current;
  const position = displayed !== null ? stops.indexOf(displayed) : -1;
  useEffect(() => { if (dragging.current === "active") dragging.current = "canceled"; setPreview(null); }, [current, disabled, levels.join(",")]);
  useEffect(() => {
    const cancel = () => { if (dragging.current === "active") dragging.current = "canceled"; setPreview(null); };
    window.addEventListener("blur", cancel);
    return () => window.removeEventListener("blur", cancel);
  }, []);
  if (!stops.length) return null;
  const locked = disabled || levels.length < 2;
  return <div className="effort-panel">
    <div className="effort-header"><span>Effort</span><strong>{displayed ? effortLabel(displayed) : "—"}</strong></div>
    <div className="effort-slider-wrap" data-disabled={locked || undefined} style={{ "--effort-progress": Math.max(0, position) / Math.max(1, stops.length - 1) } as CSSProperties}>
      <div className="effort-rail" aria-hidden="true"><div className="effort-fill" /></div>
      {position >= 0 && <span className="effort-thumb" aria-hidden="true" />}
      {stops.map((level, index) => <span key={level} className="effort-dot" aria-hidden="true" style={{ left: `calc(13px + (100% - 26px) * ${index / Math.max(1, stops.length - 1)})` }} />)}
      <DropdownMenuItem asChild onSelect={event => event.preventDefault()} disabled={locked}>
        <input type="range" role="slider" className="effort-range" aria-label="Effort" aria-valuetext={displayed ? effortLabel(displayed) : "Not selected"} min={0} max={Math.max(1, stops.length - 1)} step={1} value={Math.max(0, position)} disabled={locked}
          onChange={event => { const level = stops[Number(event.target.value)]; if (!locked && level) { if (dragging.current === "active") setPreview(level); else if (dragging.current === "idle" && level !== current) onChange(level); } }}
          onPointerDown={event => { event.stopPropagation(); if (!locked) dragging.current = "active"; }}
          onPointerUp={event => { const level = stops[Number(event.currentTarget.value)], active = dragging.current === "active"; dragging.current = "idle"; setPreview(null); if (active && !locked && level && level !== current) onChange(level); }}
          onPointerCancel={() => { dragging.current = "idle"; setPreview(null); }}
          onKeyDown={event => {
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) return;
            // Radix handles these keys on the same node, so stop its roving focus before changing the range.
            event.preventDefault(); event.stopPropagation();
            const next = event.key === "Home" ? 0 : event.key === "End" ? stops.length - 1 : position + (["ArrowRight", "ArrowUp", "PageUp"].includes(event.key) ? 1 : -1);
            const level = stops[Math.max(0, Math.min(stops.length - 1, next))];
            if (!locked && level && level !== current) onChange(level);
          }} />
      </DropdownMenuItem>
    </div>
  </div>;
}
export function ModelSelector({ models, selected, loading, disabled, onChange, open: commandedOpen, onOpenChange }: { models: ModelOption[]; selected: ModelSelection | null; loading: () => void; disabled: boolean; onChange: (selection: ModelSelection) => void; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const [localOpen, setOpen] = useState(false);
  const open = commandedOpen ?? localOpen;
  const value = selected ? modelKey(selected) : "";
  const option = models.find(item => modelKey(item) === value);
  const levels = option?.thinkingLevels ?? [];
  return <DropdownMenu open={open} onOpenChange={next => { setOpen(next); onOpenChange?.(next); if (next) loading(); }}><DropdownMenuTrigger asChild><Button type="button" variant="ghost" className="model-selector" aria-label="Chat model" aria-description={`${option?.name ?? selected?.modelId ?? "Select a model"} · Effort: ${selected ? effortLabel(selected.thinkingLevel) : "—"}`} disabled={disabled}><Brain className="model-selector-icon" />{open ? <span className="model-selector-name">Select Model</span> : <><span className="model-selector-name">{option?.name ?? selected?.modelId ?? "Select a model"}</span>{selected && <span className="model-selector-effort">{effortLabel(selected.thinkingLevel)}</span>}</>}</Button></DropdownMenuTrigger><DropdownMenuContent className="composer-menu model-menu" side="top" align="end" sideOffset={6} aria-label="Model and effort"><DropdownMenuRadioGroup aria-label="Chat model" value={value} onValueChange={next => { const item = models.find(item => modelKey(item) === next); const selection = item && selectionForModel(item, selected); if (!disabled && selection) onChange(selection); }}>{selected && !option && <DropdownMenuRadioItem className="model-option" value={value} disabled aria-description="The current model is not in the catalog; availability unknown">{selected.modelId}<Check className="model-option-check" aria-hidden="true" /></DropdownMenuRadioItem>}{models.map(item => <DropdownMenuRadioItem className="model-option" key={modelKey(item)} value={modelKey(item)} disabled={disabled || !item.available || !item.thinkingLevels.length}>{item.name}{!item.available && " · Auth unavailable"}{modelKey(item) === value && <Check className="model-option-check" aria-hidden="true" />}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup><DropdownMenuSeparator /><EffortSlider levels={levels} current={selected?.thinkingLevel ?? null} disabled={disabled || !option?.available} onChange={level => { if (selected) onChange({ ...selected, thinkingLevel: level }); }} /></DropdownMenuContent></DropdownMenu>;
}
export function composerInputHeight(scrollHeight: number, viewportHeight: number, minHeight = 48): number {
  return Math.max(minHeight, Math.min(scrollHeight, Math.floor(viewportHeight / 3)));
}

export function resizeComposerInput(input: HTMLTextAreaElement | null, minHeight = 48): void {
  if (!input) return;
  const max = Math.max(minHeight, Math.floor(window.innerHeight / 3));
  input.style.maxHeight = `${max}px`;
  input.style.height = "auto";
  input.style.height = `${composerInputHeight(input.scrollHeight, window.innerHeight, minHeight)}px`;
  input.style.overflowY = input.scrollHeight > max ? "auto" : "hidden";
}

// Note: See .agents/notes/implemented/architecture/2026-10-16-desktop-current-demo.md
export function Composer({ model, session, onNew, onSkills }: { model: CodeState; session: Session } & ComposerCommandActions) {
  const writes = model.writes;
  const draft = writes.draft(session.id);
  const input = useRef<HTMLTextAreaElement>(null);
  const [queueConfirm, setQueueConfirm] = useState(false);
  const [stopConfirm, setStopConfirm] = useState(false);
  const [guidance, setGuidance] = useState(false);
  const picking = !!draft.attaching;
  const online = model.status.state === "online";
  const checking = writes.checking(session.id);
  const blocked = writes.blocked(session.id);
  const scheduled = !!session.codeScheduleActive;
  const commands = useComposerCommands({ model, session, text: draft.text, edit: text => writes.edit(session.id, text), input, locked: writes.checking(session.id) || writes.busy.has(session.id) || picking, onNew, onSkills });
  const inputLocked = scheduled;
  const attachments = draft.attachments ?? [];
  const hasInput = !!draft.text.trim() || attachments.length > 0;
  const active = model.view.activeTaskFor(session.id);
  const stopping = !!active && !hasInput;
  // Guidance uses the active ordinary Task.
  const canSteer = !!active && !scheduled && session.queueState !== "paused";
  const availableModes = model.target === "personal" ? composerModes.filter(mode => mode.value !== "plan") : composerModes;
  const selected = session.modelSelection;
  const decision = queueDecision(model.view, session);
  const hasQueue = model.view.queuedTasksFor(session.id).length > 0;
  const resuming = session.queueState === "paused" && hasQueue && !hasInput && !active && !scheduled;
  const canSend = commands.application ? !checking && !writes.busy.has(session.id) && !picking : !blocked && !picking && !model.compactions.occupied(session.id) && (stopping || resuming || !inputLocked && hasInput && !!selected);
  useEffect(() => { if (online) void writes.loadModels(); }, [writes, online, model.view.instanceId, writes.modelGeneration]);
  useEffect(() => { resizeComposerInput(input.current); }, [draft.text]);
  useEffect(() => {
    const resize = () => resizeComposerInput(input.current);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => { if (model.view.openSession(session.id).historyLoaded && model.view.openSession(session.id).flow.items.length === 0) input.current?.focus(); }, [model, session.id, model.view.openSession(session.id).historyLoaded]);
  useEffect(() => { void writes.preparePending(session.id); }, [writes, session.id, writes.entries, model.view.instanceId, online]);
  useEffect(() => { if (online) void model.compactions.load(session.id); }, [model, session.id, online, model.view.instanceId]);
  function send() {
    if (!canSend) return;
    if (commands.application) { void commands.execute(); return; }
    if (stopping) { void writes.control("interrupt", session.id, active!.id); return; }
    if (resuming) {
      if (writes.stopConfirmationNeeded(session.id)) setStopConfirm(true);
      else if (decision.kind === "select_model") { writes.message = "The queued task has no model. Select a model first."; model.refresh(); }
      else if (decision.kind === "confirm") setQueueConfirm(true);
      else void writes.resume(session);
      return;
    }
    if (commands.parsed?.kind === "skill") writes.edit(session.id, commands.parsed.input);
    void writes.send(session.id, { guidance: guidance && canSteer });
    setGuidance(false);
  }
  async function attach() {
    if (writes.blocked(session.id)) return;
    const instanceId = model.view.instanceId;
    draft.attaching = true; model.refresh();
    try {
      const result = await window.ruukoto.pickAttachments(session.id, model.target);
      if (instanceId !== model.view.instanceId) return;
      if (!result.ok) writes.message = result.error.message;
      else if ((draft.attachments?.length ?? 0) + result.value.length > MAX_ATTACHMENTS) writes.message = `Attach at most ${MAX_ATTACHMENTS} files per message.`;
      else draft.attachments = [...(draft.attachments ?? []), ...result.value];
      model.refresh();
    } catch { writes.message = "Couldn't attach the file. Reopen the app and choose again."; model.refresh(); }
    finally { draft.attaching = false; model.refresh(); }
  }
  return <div className="composer-wrap"><div className="composer-width">
    <CompactionPanel model={model} sessionId={session.id} />
    {scheduled && <div className="task-notice"><span>Scheduled manages timed runs; you can send ordinary messages after this round.</span></div>}
    {writes.recallPending(session.id) && <div className="task-notice"><span>Recall outcome unverified</span><Button variant="ghost" size="sm" disabled={!online || writes.busy.has(session.id)} onClick={() => void writes.retryRecall(session.id)}>Verify the original recall request</Button></div>}
    {writes.recallState(session.id)?.open?.phase === "blocked" && <div className="task-notice"><span>Recall stop outcome unverified; the queue stays paused</span><Button variant="ghost" size="sm" disabled={!online || blocked} onClick={() => void writes.verifyRecall(session.id)}>Verify again</Button></div>}
    <div className={hasQueue ? "composer-stack surface-composer has-queue" : "composer-stack surface-composer"}>
      <QueuePanel model={model} session={session} />
      <form className="composer" onSubmit={event => { event.preventDefault(); send(); }}>
        {attachments.length > 0 && <div className="attached-files" aria-label="Attached files">{attachments.map(attachment => <span className="attachment-chip" key={attachment.id}><FileCode2 /><span>{attachment.name}</span><button type="button" disabled={checking} aria-label={`Remove attachment ${attachment.name}`} onClick={() => { draft.attachments = attachments.filter(item => item.id !== attachment.id); model.refresh(); }}><X /></button></span>)}</div>}
        {commands.menu}
        <Textarea ref={input} {...commands.inputProps} aria-label="Type a message" rows={2} readOnly={checking} value={draft.text} placeholder="Task or question" onChange={event => writes.edit(session.id, event.target.value)} onKeyDown={event => { if (!commands.keyDown(event)) submitOnEnter(event, canSend && !stopping, send); }} />
        <div className="composer-actions"><div className="composer-left"><IconButton className="attachment-button" label="Attach files" disabled={blocked || picking || inputLocked || attachments.length >= MAX_ATTACHMENTS} onClick={() => void attach()}><Plus /></IconButton><ModeSelector value={session.defaultAccessMode} modes={availableModes} disabled={blocked || scheduled} open={commands.selector === "mode" ? true : undefined} onOpenChange={open => { if (!open) commands.closeSelector(); }} onChange={mode => void writes.setMode(session, mode)} /></div>
          <div className="composer-right"><ContextIndicator context={model.context.get(session.id)} onOpen={() => void model.context.load(session.id)} /><ModelSelector models={writes.models} selected={selected} loading={() => void writes.loadModels()} disabled={blocked || scheduled} open={commands.selector === "model" ? true : undefined} onOpenChange={open => { if (!open) commands.closeSelector(); }} onChange={selection => void writes.setModel(session, selection)} />{canSteer && <IconButton className={guidance ? "steer-toggle is-on" : "steer-toggle"} label={guidance ? "Guidance mode: will steer the current task (click to cancel)" : "Send as guidance: steer the task at the next boundary"} disabled={blocked || picking} onClick={() => setGuidance(!guidance)}><Waypoints /></IconButton>}<Button size="icon" className="send-button" type="submit" disabled={!canSend} aria-label={checking ? "Verifying input" : stopping ? "Stop task" : resuming ? "Resume queue" : guidance && canSteer ? "Send as guidance" : "Send message"} aria-busy={checking}>{checking ? <Loader2 className="animate-spin" /> : stopping ? <Square fill="currentColor" /> : resuming ? <Play fill="currentColor" /> : <ArrowUp />}</Button></div>
        </div>
      </form>
    </div>
  </div>{commands.help}<Dialog open={queueConfirm && resuming && decision.kind === "confirm"} onOpenChange={setQueueConfirm}><DialogContent className="app-dialog"><DialogHeader><DialogTitle>Resume queue</DialogTitle><DialogDescription>{decision.kind === "confirm" ? `Fill in ${decision.selection.modelId} · ${decision.selection.thinkingLevel} for ${decision.count} queued task(s), then resume the queue.` : ""}</DialogDescription></DialogHeader><DialogFooter><Button variant="ghost" onClick={() => setQueueConfirm(false)}>Cancel</Button><Button disabled={!canSend || !resuming} onClick={() => { if (!canSend || !resuming) return; setQueueConfirm(false); void writes.resume(session, true); }}>Fill model and resume</Button></DialogFooter></DialogContent></Dialog><Dialog open={stopConfirm && resuming} onOpenChange={setStopConfirm}><DialogContent className="app-dialog"><DialogHeader><DialogTitle>Verify the old run stopped</DialogTitle><DialogDescription>Verify in the runtime environment that the old task and its managed processes have exited. Confirming releases the held occupation and resumes the queue.</DialogDescription></DialogHeader><DialogFooter><Button variant="ghost" onClick={() => setStopConfirm(false)}>Go verify</Button><Button disabled={!canSend || !resuming} onClick={() => { if (!canSend || !resuming) return; setStopConfirm(false); void writes.resume(session, true, true); }}>Verified stopped; resume</Button></DialogFooter></DialogContent></Dialog></div>;
}
