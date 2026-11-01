import { useEffect, useState } from "react";
import { CalendarClock, CalendarDays, Check, ChevronLeft, ChevronRight, Loader2, Pause, Pencil, Play, Plus, Repeat2 } from "lucide-react";
import type { CodeSchedulePlan, CodeScheduleRun } from "@ruukoto/core/code-scheduler.ts";
import type { ModelSelection } from "@ruukoto/core/types.ts";
import type { CodeState } from "./code-state.ts";
import { composerModes, selectionForModel } from "./composer.tsx";
import { WorkspacePicker } from "./workspace-picker.tsx";
import { runStatus, scheduleProgress, scheduleReason, scheduleSummary, scheduleTime, type ScheduleDraft, type ScheduleDraftStep } from "./scheduled-state.ts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";
import { cn } from "./lib/utils.ts";

const planStatus = (plan: CodeSchedulePlan) => ({ active: "已启用", paused: "已暂停", canceled: "已取消", completed: "已结束" })[plan.status];
const permissionModes = composerModes.filter(mode => mode.value !== "plan");
const formSteps: { step: ScheduleDraftStep; label: string; question: string }[] = [
  { step: 1, label: "任务", question: "要做什么？" },
  { step: 2, label: "时间", question: "什么时候执行？" },
  { step: 3, label: "执行", question: "在哪里执行？" },
  { step: 4, label: "确认", question: "确认计划" },
];
const permissionLabel = (value: string) => permissionModes.find(mode => mode.value === value)?.label ?? value;
const effortLabel = (value: string) => value[0].toUpperCase() + value.slice(1);
const modelKey = (selection: Pick<ModelSelection, "provider" | "modelId">) => JSON.stringify([selection.provider, selection.modelId]);

export function scheduledWaiting(model: CodeState, run: CodeScheduleRun): string {
  if (run.closedAt) return runStatus(run);
  if (run.reason) return scheduleReason(run.reason);
  if (run.cancelRequested) return "正在停止本轮运行";
  if (model.view.pendingApprovals().some(item => model.view.getTask(item.taskId)?.codeScheduleRunId === run.id)) return "等待审批";
  if (model.view.ownerQuestions.some(item => item.status === "pending" && item.sessionId === run.sessionId)) return "等待回答";
  const session = model.view.sessions.find(item => item.id === run.sessionId);
  if (session?.queueState === "paused") return "队列暂停，等待恢复";
  if (model.view.queuedTasksFor(run.sessionId).length && !model.view.activeTaskFor(run.sessionId)) return "等待工作区";
  if (model.view.backgroundProcesses.some(item => item.sessionId === run.sessionId && item.state !== "stopped")) return "后台进程尚未结束";
  return "运行中";
}

function ScheduleProgressBar({ progress }: { progress: number }) {
  return <div className="scheduled-progress" role="progressbar" aria-label="到下一次触发的进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>;
}

function ScheduleCard({ model, plan }: { model: CodeState; plan: CodeSchedulePlan }) {
  const progress = scheduleProgress(plan);
  return <Button type="button" variant="ghost" className="scheduled-card" onClick={() => void model.scheduled.open(plan.id)}>
    <span className="scheduled-card-heading"><i className={cn("scheduled-status-dot", plan.status !== "active" && "is-inactive")} aria-hidden="true" /><strong>{plan.config.title}</strong><span className="sr-only">{planStatus(plan)}</span></span>
    <p className="scheduled-card-summary">{plan.config.instructions}</p>
    <span className="scheduled-card-repeat"><Repeat2 aria-hidden="true" />{scheduleSummary(plan.config)}</span>
    <span className="scheduled-card-next"><span>{plan.reason ? scheduleReason(plan.reason) : `下次 · ${scheduleTime(plan.nextDueAt, plan.config.rule.timeZone)}`}</span>{progress === null && <span>{planStatus(plan)}</span>}</span>
    {progress !== null && <ScheduleProgressBar progress={progress} />}
  </Button>;
}

function ScheduleList({ model }: { model: CodeState }) {
  const state = model.scheduled;
  return <><div className="scheduled-list-controls"><Tabs value={state.history ? "history" : "current"} onValueChange={value => { state.history = value === "history"; void state.load(); }}><TabsList aria-label="计划范围" className="scheduled-scope-tabs"><TabsTrigger value="current">Active</TabsTrigger><TabsTrigger value="history">Archived</TabsTrigger></TabsList></Tabs>{state.plans.length > 0 && <span className="scheduled-count">{state.plans.length} 个计划</span>}</div>
    {!state.plans.length && <div className="scheduled-empty"><CalendarClock /><p>{state.loading ? "正在读取计划…" : model.status.state !== "online" ? "连接恢复后可管理计划" : state.history ? "尚无历史计划" : "还没有定时计划"}</p></div>}
    {state.plans.length > 0 && <div className="scheduled-list">{state.plans.map(item => <ScheduleCard key={item.id} model={model} plan={item} />)}</div>}
    {state.nextOffset !== null && <Button variant="ghost" disabled={state.loading} onClick={() => void state.load(true)}>更多计划</Button>}
  </>;
}

function ScheduleDetail({ model, onOpenSession }: { model: CodeState; onOpenSession: (id: string) => void }) {
  const [tab, setTab] = useState<"overview" | "runs">("overview");
  const detail = model.scheduled.detail!, plan = detail.plan, progress = scheduleProgress(plan);
  const workspace = model.view.projects.find(item => item.id === plan.config.workspaceId)?.name ?? "工作区不可用";
  return <><div className="scheduled-tabs" role="tablist" aria-label="计划详情"><button role="tab" aria-selected={tab === "overview"} className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>概览</button><button role="tab" aria-selected={tab === "runs"} className={tab === "runs" ? "active" : ""} onClick={() => setTab("runs")}>运行记录</button></div>
    {tab === "overview" ? <>
      <section className="scheduled-next"><div className="scheduled-next-heading"><span>下次触发</span><span>{planStatus(plan)}</span></div><div className="scheduled-next-time"><strong>{scheduleTime(plan.nextDueAt, plan.config.rule.timeZone)}</strong>{progress !== null && <span>{progress}%</span>}</div>{progress !== null && <ScheduleProgressBar progress={progress} />}<p>{scheduleSummary(plan.config)} · {plan.config.rule.timeZone}</p></section>
      {plan.reason && <p className="scheduled-message">{scheduleReason(plan.reason)}</p>}
      <div className="scheduled-overview"><section className="scheduled-panel"><h2>任务内容</h2><p>{plan.config.instructions}</p></section><section className="scheduled-panel"><h2>执行设置</h2><dl className="scheduled-meta"><div><dt>工作区</dt><dd>{workspace}</dd></div><div><dt>权限</dt><dd>{permissionLabel(plan.config.permission)}</dd></div><div><dt>模型</dt><dd>{plan.config.modelSelection.modelId}</dd></div><div><dt>Effort</dt><dd>{effortLabel(plan.config.modelSelection.thinkingLevel)}</dd></div></dl></section></div>
    </> : <>{!detail.runs.length && <p className="text-sec">尚无运行记录</p>}{detail.runs.length > 0 && <div className="scheduled-runs">{detail.runs.map(run => <Button variant="ghost" className="scheduled-run" key={run.id} onClick={() => onOpenSession(run.sessionId)}><span>{scheduleTime(run.scheduledAt, run.snapshot.rule.timeZone)}</span><span>{scheduledWaiting(model, run)}</span><ChevronRight aria-hidden="true" /></Button>)}</div>}{detail.nextRunOffset !== null && <Button variant="ghost" onClick={() => void model.scheduled.open(plan.id, true, true)}>更多运行</Button>}</>}
  </>;
}

function ScheduleForm({ model }: { model: CodeState }) {
  const state = model.scheduled, draft = state.draft!, disabled = state.blocked, step = state.draftStep;
  function change(patch: Partial<ScheduleDraft>) { state.draft = { ...draft, ...patch }; state.message = null; model.refresh(); }
  const workspaces = model.view.projects.filter(project => project.rootDir !== null);
  const fallback = model.newChatSelection(null);
  const availableModels = model.writes.models.filter(option => option.available && option.thinkingLevels.length > 0);
  const selectedModel = availableModels.find(option => draft.modelSelection && modelKey(option) === modelKey(draft.modelSelection));
  useEffect(() => { if (!draft.modelSelection && fallback) { state.draft = { ...draft, modelSelection: fallback }; model.refresh(); } }, [state, draft, model, fallback?.provider, fallback?.modelId, fallback?.thinkingLevel]);
  const stepReady = step === 1 ? !!draft.title.trim() && !!draft.instructions.trim()
    : step === 2 ? /^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time) && (draft.repeat !== "once" || !!draft.date) && (draft.repeat !== "weekly" || draft.weekdays.length > 0)
    : step === 3 ? !!draft.workspaceId && !!draft.modelSelection
    : true;
  function next() { if (step < 4 && stepReady && !disabled) state.setDraftStep((step + 1) as ScheduleDraftStep); }
  return <form className="scheduled-form" onSubmit={event => { event.preventDefault(); if (step === 4) void state.save(); }}>
    {state.needsReview && state.detail && <section className="scheduled-conflict" role="alert"><h2>当前已保存配置</h2><p>{state.detail.plan.config.title} · {scheduleSummary(state.detail.plan.config)}</p><p>{state.detail.plan.config.rule.timeZone} · {model.view.projects.find(project => project.id === state.detail!.plan.config.workspaceId)?.name ?? "工作区不可用"}</p><p>{permissionLabel(state.detail.plan.config.permission)} · {state.detail.plan.config.modelSelection.modelId} · {effortLabel(state.detail.plan.config.modelSelection.thinkingLevel)}</p><pre>{state.detail.plan.config.instructions}</pre><Button type="button" variant="ghost" disabled={disabled} onClick={() => state.reviewed()}>已核对当前配置，继续编辑</Button></section>}
    <div className="scheduled-steps" aria-label="计划步骤">{formSteps.map(item => <div key={item.step} className={cn("scheduled-step", item.step === step && "is-active", item.step < step && "is-done")} aria-current={item.step === step ? "step" : undefined}><span>{item.step < step ? <Check aria-hidden="true" /> : item.step}</span><span className="scheduled-step-label">{item.label}</span></div>)}</div>
    <section className="scheduled-form-panel"><h2>{formSteps[step - 1].question}</h2>
      {step === 1 && <><label className="scheduled-field"><span>计划名称</span><Input autoFocus value={draft.title} maxLength={120} disabled={disabled} onChange={event => change({ title: event.target.value })} placeholder="例如：每日产品简报" /></label><label className="scheduled-field"><span>任务内容</span><Textarea rows={6} value={draft.instructions} maxLength={64 * 1024} disabled={disabled} onChange={event => change({ instructions: event.target.value })} placeholder="描述要完成的任务" /></label></>}
      {step === 2 && <><div className="scheduled-field"><span>重复</span><div className="scheduled-choice-grid" role="group" aria-label="重复">{[{ value: "daily", label: "每天", icon: <Repeat2 /> }, { value: "weekly", label: "每周", icon: <CalendarDays /> }, { value: "once", label: "一次性", icon: <CalendarClock /> }].map(item => <Button key={item.value} type="button" variant="ghost" aria-pressed={draft.repeat === item.value} className={cn("scheduled-choice", draft.repeat === item.value && "is-active")} disabled={disabled} onClick={() => change({ repeat: item.value as ScheduleDraft["repeat"] })}>{item.icon}<span>{item.label}</span></Button>)}</div></div>
        {draft.repeat === "weekly" && <div className="scheduled-field"><span>星期</span><div className="scheduled-weekdays" role="group" aria-label="星期">{[1, 2, 3, 4, 5, 6, 7].map(day => <Button key={day} type="button" variant="ghost" aria-pressed={draft.weekdays.includes(day)} className={cn("scheduled-weekday", draft.weekdays.includes(day) && "is-active")} disabled={disabled} onClick={() => change({ weekdays: draft.weekdays.includes(day) ? draft.weekdays.filter(value => value !== day) : [...draft.weekdays, day].sort() })}>{"一二三四五六日"[day - 1]}</Button>)}</div></div>}
        <div className="scheduled-date-row">{draft.repeat === "once" && <label className="scheduled-field"><span>日期</span><Input type="date" value={draft.date} disabled={disabled} onChange={event => change({ date: event.target.value })} /></label>}<label className="scheduled-field"><span>时间</span><Input type="time" value={draft.time} disabled={disabled} onChange={event => change({ time: event.target.value })} /></label></div><p className="scheduled-timezone">{draft.timeZone}</p></>}
      {step === 3 && <><label className="scheduled-field"><span>工作区</span><WorkspacePicker workspaces={workspaces} value={draft.workspaceId} disabled={disabled} onChange={workspaceId => change({ workspaceId })} /></label>
        <label className="scheduled-field"><span>权限</span><select className="scheduled-select" value={draft.permission} disabled={disabled} onChange={event => change({ permission: event.target.value as ScheduleDraft["permission"] })}>{permissionModes.map(mode => <option key={mode.value} value={mode.value}>{mode.label}</option>)}</select></label>
        <label className="scheduled-field"><span>模型</span><select className="scheduled-select" value={draft.modelSelection ? modelKey(draft.modelSelection) : ""} disabled={disabled || !availableModels.length} onChange={event => { const option = availableModels.find(item => modelKey(item) === event.target.value); const modelSelection = option && selectionForModel(option, draft.modelSelection); if (modelSelection) change({ modelSelection }); }}>{!draft.modelSelection && <option value="">选择模型</option>}{draft.modelSelection && !selectedModel && <option value={modelKey(draft.modelSelection)}>{draft.modelSelection.modelId}</option>}{availableModels.map(option => <option key={modelKey(option)} value={modelKey(option)}>{option.name}</option>)}</select></label>
        <label className="scheduled-field"><span>Effort</span><select className="scheduled-select" value={draft.modelSelection?.thinkingLevel ?? ""} disabled={disabled || !selectedModel} onChange={event => { if (draft.modelSelection) change({ modelSelection: { ...draft.modelSelection, thinkingLevel: event.target.value as ModelSelection["thinkingLevel"] } }); }}>{!draft.modelSelection && <option value="">选择 Effort</option>}{(selectedModel?.thinkingLevels ?? (draft.modelSelection ? [draft.modelSelection.thinkingLevel] : [])).map(level => <option key={level} value={level}>{effortLabel(level)}</option>)}</select></label></>}
      {step === 4 && <div className="scheduled-review"><div className="scheduled-review-title"><strong>{draft.title}</strong><p>{draft.instructions}</p></div><div className="scheduled-review-grid"><div><span>时间</span><strong>{draft.repeat === "daily" ? `每天 ${draft.time}` : draft.repeat === "weekly" ? `每周${draft.weekdays.map(day => "一二三四五六日"[day - 1]).join("、")} · ${draft.time}` : `一次性 · ${draft.date} ${draft.time}`}</strong></div><div><span>工作区</span><strong>{workspaces.find(project => project.id === draft.workspaceId)?.name ?? "工作区不可用"}</strong></div><div><span>执行</span><strong>{draft.modelSelection ? `${draft.modelSelection.modelId} · ${effortLabel(draft.modelSelection.thinkingLevel)}` : "—"}<br />{permissionLabel(draft.permission)}</strong></div></div></div>}
    </section>
    <div className="scheduled-form-actions"><Button type="button" variant="ghost" disabled={disabled} onClick={() => { if (step === 1) { state.draft = null; model.refresh(); } else state.setDraftStep((step - 1) as ScheduleDraftStep); }}>{step === 1 ? "取消" : "上一步"}</Button><Button type={step === 4 ? "submit" : "button"} disabled={disabled || !stepReady || step === 4 && state.needsReview} onClick={step === 4 ? undefined : next}>{state.busy && <Loader2 data-icon="inline-start" className="animate-spin" />}{step === 4 ? "保存计划" : <>继续<ChevronRight data-icon="inline-end" /></>}</Button></div>
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
  function closeDetail() { state.selectedId = null; state.detail = null; state.draft = null; state.draftStep = 1; model.refresh(); }
  const hasDetail = !!state.draft || !!state.selectedId;
  return <div className={cn("scheduled-page", state.draft && "is-form")}><header className="scheduled-header"><div>{hasDetail && <Button type="button" variant="ghost" size="icon" className="scheduled-back" aria-label="返回计划列表" disabled={state.busy || state.entries.some(entry => entry.record.instanceId === model.view.instanceId)} onClick={closeDetail}><ChevronLeft /></Button>}<h1>{state.draft ? state.selectedId ? "编辑计划" : "新建计划" : plan?.config.title ?? "Scheduled"}</h1></div>{!state.draft && !hasDetail && <Button type="button" disabled={state.blocked} onClick={() => state.create()}><Plus data-icon="inline-start" />新建计划</Button>}{!state.draft && plan && <div className="scheduled-header-actions"><Button variant="secondary" disabled={state.blocked || plan.status === "canceled"} onClick={() => state.edit()}><Pencil data-icon="inline-start" />编辑</Button>{plan.status === "active" ? <Button variant="secondary" disabled={state.blocked} onClick={() => void state.control("pause")}><Pause data-icon="inline-start" />暂停</Button> : plan.status === "paused" && <Button variant="secondary" disabled={state.blocked} onClick={resume}><Play data-icon="inline-start" />恢复</Button>}<Button variant="destructive" disabled={state.blocked || plan.status === "canceled"} onClick={() => setConfirmation("cancel")}>取消计划</Button></div>}</header>
    {state.message && <p className="scheduled-message" role="status">{state.message}</p>}
    {state.entries.some(entry => entry.record.instanceId !== model.view.instanceId) && <p className="scheduled-message" role="status">其他实例的原保存记录仍保留，请连回原实例核实。</p>}
    {state.entries.some(entry => entry.record.instanceId === model.view.instanceId) && <p className="scheduled-message" role="status">原保存结果待核实，连接恢复后将按原请求查询。</p>}
    {state.draft ? <ScheduleForm model={model} /> : hasDetail ? !plan ? <p role="status">正在读取计划…</p> : <ScheduleDetail key={plan.id} model={model} onOpenSession={onOpenSession} /> : <ScheduleList model={model} />}
    <Dialog open={confirmation !== null} onOpenChange={open => { if (!open) setConfirmation(null); }}><DialogContent className="demo-dialog"><DialogHeader><DialogTitle>{confirmation === "cancel" ? "取消计划" : "允许未来新周期"}</DialogTitle><DialogDescription>{confirmation === "cancel" ? "取消将停止当前整项运行并阻止未来执行。已有修改与历史会保留。" : "请先检查原运行记录。确认后保留本轮未知结果，仅允许未来新周期；旧操作不会重试。"}</DialogDescription></DialogHeader><DialogFooter><Button variant="ghost" onClick={() => setConfirmation(null)}>返回</Button><Button disabled={state.blocked} onClick={() => { const action = confirmation; setConfirmation(null); if (action === "cancel") void state.control("cancel"); else if (confirmRun) void state.control("resume", confirmRun); }}>{confirmation === "cancel" ? "取消整项运行与计划" : "保留未知结果并恢复"}</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
