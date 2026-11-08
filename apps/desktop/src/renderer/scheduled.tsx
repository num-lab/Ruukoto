import { useEffect, useState } from "react";
import { CalendarClock, CalendarDays, ChevronLeft, ChevronRight, Loader2, Pencil, Plus, Repeat2, Trash2 } from "lucide-react";
import type { CodeSchedulePlan, CodeScheduleRun } from "@ruukoto/core/code-scheduler.ts";
import type { CodeState } from "./code-state.ts";
import { composerModes, ModeSelector, ModelSelector } from "./composer.tsx";
import { WorkspacePicker } from "./workspace-picker.tsx";
import { configForSchedule, runStatus, scheduleProgress, scheduleReason, scheduleSummary, scheduleTime, type ScheduleDraft } from "./scheduled-state.ts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { Switch } from "./components/ui/switch.tsx";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";
import { cn } from "./lib/utils.ts";

const planStatus = (plan: CodeSchedulePlan) => ({ active: "Active", paused: "Paused", canceled: "Canceled", completed: "Completed" })[plan.status];
const permissionModes = composerModes.filter(mode => mode.value !== "plan");
const permissionLabel = (value: string) => permissionModes.find(mode => mode.value === value)?.label ?? value;
const effortLabel = (value: string) => value[0].toUpperCase() + value.slice(1);

export function scheduledWaiting(model: CodeState, run: CodeScheduleRun): string {
  if (run.closedAt) return runStatus(run);
  if (run.reason) return scheduleReason(run.reason);
  if (run.cancelRequested) return "Stopping this run";
  if (model.view.pendingApprovals().some(item => model.view.getTask(item.taskId)?.codeScheduleRunId === run.id)) return "Awaiting approval";
  if (model.view.ownerQuestions.some(item => item.status === "pending" && item.sessionId === run.sessionId)) return "Awaiting answer";
  const session = model.view.sessions.find(item => item.id === run.sessionId);
  if (session?.queueState === "paused") return "Queue paused, waiting to resume";
  if (model.view.queuedTasksFor(run.sessionId).length && !model.view.activeTaskFor(run.sessionId)) return "Waiting for workspace";
  if (model.view.backgroundProcesses.some(item => item.sessionId === run.sessionId && item.state !== "stopped")) return "Background process still running";
  return "Running";
}

function ScheduleProgressBar({ progress }: { progress: number }) {
  return <div className="scheduled-progress" role="progressbar" aria-label="Progress to next trigger" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>;
}

function ScheduleCard({ model, plan }: { model: CodeState; plan: CodeSchedulePlan }) {
  const progress = scheduleProgress(plan);
  return <Button type="button" variant="ghost" className="scheduled-card" onClick={() => void model.scheduled.open(plan.id)}>
    <span className="scheduled-card-heading"><i className={cn("scheduled-status-dot", plan.status !== "active" && "is-inactive")} aria-hidden="true" /><strong>{plan.config.title}</strong><span className="sr-only">{planStatus(plan)}</span></span>
    <p className="scheduled-card-summary">{plan.config.instructions}</p>
    <span className="scheduled-card-repeat"><Repeat2 aria-hidden="true" />{scheduleSummary(plan.config)}</span>
    <span className="scheduled-card-next"><span>{plan.reason ? scheduleReason(plan.reason) : `Next · ${scheduleTime(plan.nextDueAt, plan.config.rule.timeZone)}`}</span>{progress === null && <span>{planStatus(plan)}</span>}</span>
    {progress !== null && <ScheduleProgressBar progress={progress} />}
  </Button>;
}

function ScheduleList({ model }: { model: CodeState }) {
  const state = model.scheduled;
  return <><div className="scheduled-list-controls"><Tabs value={state.history ? "history" : "current"} onValueChange={value => { state.history = value === "history"; void state.load(); }}><TabsList aria-label="Schedule scope" className="scheduled-scope-tabs"><TabsTrigger value="current">Active</TabsTrigger><TabsTrigger value="history">Archived</TabsTrigger></TabsList></Tabs></div>
    {!state.plans.length && <div className="scheduled-empty"><CalendarClock /><p>{state.loading ? "Loading schedules…" : model.status.state !== "online" ? "Schedules can be managed once connected" : state.history ? "No past schedules yet" : "No schedules yet"}</p></div>}
    {state.plans.length > 0 && <div className="scheduled-list">{state.plans.map(item => <ScheduleCard key={item.id} model={model} plan={item} />)}</div>}
    {state.nextOffset !== null && <Button variant="ghost" disabled={state.loading} onClick={() => void state.load(true)}>More schedules</Button>}
  </>;
}

function ScheduleDetail({ model, onOpenSession }: { model: CodeState; onOpenSession: (id: string) => void }) {
  const [tab, setTab] = useState<"overview" | "runs">("overview");
  const detail = model.scheduled.detail!, plan = detail.plan, progress = scheduleProgress(plan);
  const workspace = model.view.projects.find(item => item.id === plan.config.workspaceId)?.name ?? "Workspace unavailable";
  return <><div className="scheduled-tabs" role="tablist" aria-label="Schedule details"><button role="tab" aria-selected={tab === "overview"} className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>Overview</button><button role="tab" aria-selected={tab === "runs"} className={tab === "runs" ? "active" : ""} onClick={() => setTab("runs")}>Runs</button></div>
    {tab === "overview" ? <>
      <section className="scheduled-next"><div className="scheduled-next-heading"><span>Next trigger</span><span>{planStatus(plan)}</span></div><div className="scheduled-next-time"><strong>{scheduleTime(plan.nextDueAt, plan.config.rule.timeZone)}</strong>{progress !== null && <span>{progress}%</span>}</div>{progress !== null && <ScheduleProgressBar progress={progress} />}<p>{scheduleSummary(plan.config)} · {plan.config.rule.timeZone}</p></section>
      {plan.reason && <p className="scheduled-message">{scheduleReason(plan.reason)}</p>}
      <div className="scheduled-overview"><section className="scheduled-panel"><h2>Task</h2><p>{plan.config.instructions}</p></section><section className="scheduled-panel"><h2>Run settings</h2><dl className="scheduled-meta"><div><dt>Workspace</dt><dd>{workspace}</dd></div><div><dt>Permission</dt><dd>{permissionLabel(plan.config.permission)}</dd></div><div><dt>Model</dt><dd>{plan.config.modelSelection.modelId}</dd></div><div><dt>Effort</dt><dd>{effortLabel(plan.config.modelSelection.thinkingLevel)}</dd></div></dl></section></div>
    </> : <>{!detail.runs.length && <p className="text-sec">No runs yet</p>}{detail.runs.length > 0 && <div className="scheduled-runs">{detail.runs.map(run => <Button variant="ghost" className="scheduled-run" key={run.id} onClick={() => onOpenSession(run.sessionId)}><span>{scheduleTime(run.scheduledAt, run.snapshot.rule.timeZone)}</span><span>{scheduledWaiting(model, run)}</span><ChevronRight aria-hidden="true" /></Button>)}</div>}{detail.nextRunOffset !== null && <Button variant="ghost" onClick={() => void model.scheduled.open(plan.id, true, true)}>More runs</Button>}</>}
  </>;
}

function ScheduleForm({ model }: { model: CodeState }) {
  const state = model.scheduled, draft = state.draft!, disabled = state.blocked;
  function change(patch: Partial<ScheduleDraft>) { state.draft = { ...draft, ...patch }; state.message = null; model.refresh(); }
  const workspaces = model.view.projects.filter(project => project.rootDir !== null);
  const fallback = model.newChatSelection(null);
  useEffect(() => { if (!draft.modelSelection && fallback) { state.draft = { ...draft, modelSelection: fallback }; model.refresh(); } }, [state, draft, model, fallback?.provider, fallback?.modelId, fallback?.thinkingLevel]);
  const validation = configForSchedule(draft);
  const ready = !("error" in validation);
  return <form className="scheduled-form" onSubmit={event => { event.preventDefault(); if (ready) void state.save(); }}>
    {state.needsReview && state.detail && <section className="scheduled-conflict" role="alert"><h2>Currently saved configuration</h2><p>{state.detail.plan.config.title} · {scheduleSummary(state.detail.plan.config)}</p><p>{state.detail.plan.config.rule.timeZone} · {model.view.projects.find(project => project.id === state.detail!.plan.config.workspaceId)?.name ?? "Workspace unavailable"}</p><p>{permissionLabel(state.detail.plan.config.permission)} · {state.detail.plan.config.modelSelection.modelId} · {effortLabel(state.detail.plan.config.modelSelection.thinkingLevel)}</p><pre>{state.detail.plan.config.instructions}</pre><Button type="button" variant="ghost" disabled={disabled} onClick={() => state.reviewed()}>Reviewed the saved configuration; continue editing</Button></section>}
    <section className="scheduled-form-section"><h2>Task</h2>
      <label className="scheduled-field"><span>Name</span><Input autoFocus value={draft.title} maxLength={120} disabled={disabled} onChange={event => change({ title: event.target.value })} placeholder="e.g. Daily product brief" /></label>
      <div className="composer surface-composer scheduled-composer">
        <Textarea aria-label="Task instructions" rows={5} value={draft.instructions} maxLength={64 * 1024} disabled={disabled} onChange={event => change({ instructions: event.target.value })} placeholder="Describe the task to run…" />
        <div className="composer-actions"><div className="composer-left">
          <WorkspacePicker workspaces={workspaces} value={draft.workspaceId} disabled={disabled} onChange={workspaceId => change({ workspaceId })} />
          <ModeSelector value={draft.permission} modes={permissionModes} disabled={disabled} label="Schedule permission" onChange={permission => { if (permission !== "plan") change({ permission }); }} />
        </div><div className="composer-right"><ModelSelector models={model.writes.models} selected={draft.modelSelection} loading={() => void model.writes.loadModels()} disabled={disabled} onChange={modelSelection => change({ modelSelection })} /></div></div>
      </div>
    </section>
    <section className="scheduled-form-section"><h2>Time</h2>
      <div className="scheduled-field"><span>Repeat</span><div className="scheduled-choice-grid" role="group" aria-label="Repeat">{[{ value: "daily", label: "Daily", icon: <Repeat2 /> }, { value: "weekly", label: "Weekly", icon: <CalendarDays /> }, { value: "once", label: "Once", icon: <CalendarClock /> }].map(item => <Button key={item.value} type="button" variant="ghost" aria-pressed={draft.repeat === item.value} className={cn("scheduled-choice", draft.repeat === item.value && "is-active")} disabled={disabled} onClick={() => change({ repeat: item.value as ScheduleDraft["repeat"] })}>{item.icon}<span>{item.label}</span></Button>)}</div></div>
      {draft.repeat === "weekly" && <div className="scheduled-field"><span>Weekdays</span><div className="scheduled-weekdays" role="group" aria-label="Weekdays">{[1, 2, 3, 4, 5, 6, 7].map(day => <Button key={day} type="button" variant="ghost" aria-pressed={draft.weekdays.includes(day)} className={cn("scheduled-weekday", draft.weekdays.includes(day) && "is-active")} disabled={disabled} onClick={() => change({ weekdays: draft.weekdays.includes(day) ? draft.weekdays.filter(value => value !== day) : [...draft.weekdays, day].sort() })}>{"MTWTFSS"[day - 1]}</Button>)}</div></div>}
      <div className="scheduled-date-row">{draft.repeat === "once" && <label className="scheduled-field"><span>Date</span><Input type="date" value={draft.date} disabled={disabled} onChange={event => change({ date: event.target.value })} /></label>}<label className="scheduled-field"><span>Time</span><Input type="time" value={draft.time} disabled={disabled} onChange={event => change({ time: event.target.value })} /></label></div><p className="scheduled-timezone">{draft.timeZone}</p>
    </section>
    {"error" in validation && draft.title.trim() && draft.instructions.trim() && <p className="scheduled-message" role="alert">{validation.error}</p>}
    <div className="scheduled-form-actions"><Button type="button" variant="ghost" disabled={disabled} onClick={() => { state.draft = null; model.refresh(); }}>Cancel</Button><Button type="submit" disabled={disabled || !ready || state.needsReview}>{state.busy && <Loader2 data-icon="inline-start" className="animate-spin" />}Save schedule</Button></div>
  </form>;
}

export function Scheduled({ model, onOpenSession }: { model: CodeState; onOpenSession: (id: string) => void }) {
  const state = model.scheduled, detail = state.detail, plan = detail?.plan;
  const [confirmation, setConfirmation] = useState<"cancel" | "unknown" | null>(null);
  const active = detail?.activeRun;
  const unknown = !!active && (active.reason === "effect_unknown" || plan?.reason === "effect_unknown");
  const [confirmRun, setConfirmRun] = useState<CodeScheduleRun | null>(null);
  const [, refreshProgress] = useState(0);
  useEffect(() => { const timer = window.setInterval(() => refreshProgress(value => value + 1), 60_000); return () => window.clearInterval(timer); }, []);
  useEffect(() => { void state.load(); void model.writes.loadModels(); }, [state, model, model.view.instanceId, model.status.state]);
  function resume() { if (unknown && active) { setConfirmRun(active); setConfirmation("unknown"); } else void state.control("resume"); }
  function closeDetail() { state.selectedId = null; state.detail = null; state.draft = null; model.refresh(); }
  const hasDetail = !!state.draft || !!state.selectedId;
  return <div className={cn("scheduled-page", state.draft && "is-form")}><header className="scheduled-header"><div>{hasDetail && <Button type="button" variant="ghost" size="icon" className="scheduled-back" aria-label="Back to schedule list" disabled={state.busy || state.entries.some(entry => entry.record.instanceId === model.view.instanceId)} onClick={closeDetail}><ChevronLeft /></Button>}<h1>{state.draft ? state.selectedId ? "Edit schedule" : "New schedule" : plan?.config.title ?? "Scheduled"}</h1></div>{!state.draft && !hasDetail && <Button type="button" disabled={state.blocked} onClick={() => state.create()}><Plus data-icon="inline-start" />New schedule</Button>}{!state.draft && plan && <div className="scheduled-header-actions"><Button type="button" variant="ghost" size="icon" className="quiet-icon" aria-label="Edit schedule" title="Edit schedule" disabled={state.blocked || plan.status === "canceled"} onClick={() => state.edit()}><Pencil /></Button><Switch className="schedule-switch" aria-label={plan.status === "active" ? "Pause schedule" : "Enable schedule"} title={plan.status === "active" ? "Pause schedule" : "Enable schedule"} checked={plan.status === "active"} disabled={state.blocked || plan.status !== "active" && plan.status !== "paused"} onCheckedChange={enabled => { if (enabled) resume(); else void state.control("pause"); }} /><Button type="button" variant="ghost" size="icon" className="quiet-icon is-danger" aria-label="Cancel schedule" title="Cancel schedule" disabled={state.blocked || plan.status === "canceled"} onClick={() => setConfirmation("cancel")}><Trash2 /></Button></div>}</header>
    {state.message && <p className="scheduled-message" role="status">{state.message}</p>}
    {state.entries.some(entry => entry.record.instanceId !== model.view.instanceId) && <p className="scheduled-message" role="status">Original save records from other instances are kept. Reconnect to the original instance to verify.</p>}
    {state.entries.some(entry => entry.record.instanceId === model.view.instanceId) && <p className="scheduled-message" role="status">The original save outcome is unverified; the original request will be queried once connected.</p>}
    {state.draft ? <ScheduleForm model={model} /> : hasDetail ? !plan ? <p role="status">Loading schedule…</p> : <ScheduleDetail key={plan.id} model={model} onOpenSession={onOpenSession} /> : <ScheduleList model={model} />}
    <Dialog open={confirmation !== null} onOpenChange={open => { if (!open) setConfirmation(null); }}><DialogContent className="app-dialog"><DialogHeader><DialogTitle>{confirmation === "cancel" ? "Cancel schedule" : "Allow future cycles"}</DialogTitle><DialogDescription>{confirmation === "cancel" ? "Canceling stops the current run and blocks future runs. Existing changes and history are kept." : "Check the original run record first. Confirming keeps this run's unknown outcome and only allows future cycles; the old operation won't be retried."}</DialogDescription></DialogHeader><DialogFooter><Button variant="ghost" onClick={() => setConfirmation(null)}>Back</Button><Button disabled={state.blocked} onClick={() => { const action = confirmation; setConfirmation(null); if (action === "cancel") void state.control("cancel"); else if (confirmRun) void state.control("resume", confirmRun); }}>{confirmation === "cancel" ? "Cancel the run and schedule" : "Keep the unknown outcome and resume"}</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
