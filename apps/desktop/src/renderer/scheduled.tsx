import { useEffect, useState } from "react";
import { CalendarClock, ChevronLeft, Loader2, Plus } from "lucide-react";
import type { CodeSchedulePlan, CodeScheduleRun } from "@ruukoto/core/code-scheduler.ts";
import type { CodeState } from "./code-state.ts";
import { ModeSelector, ModelSelector, composerModes } from "./composer.tsx";
import { WorkspacePicker } from "./workspace-picker.tsx";
import { runStatus, scheduleReason, scheduleSummary, scheduleTime, type ScheduleDraft } from "./scheduled-state.ts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "./components/ui/field.tsx";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";
import { cn } from "./lib/utils.ts";

const planStatus = (plan: CodeSchedulePlan) => ({ active: "已启用", paused: "已暂停", canceled: "已取消", completed: "已结束" })[plan.status];
const permissionModes = composerModes.filter(mode => mode.value !== "plan");
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
function ScheduleForm({ model }: { model: CodeState }) {
  const state = model.scheduled, draft = state.draft!, disabled = state.blocked;
  function change(patch: Partial<ScheduleDraft>) { state.draft = { ...draft, ...patch }; state.message = null; model.refresh(); }
  const workspaces = model.view.projects.filter(project => project.rootDir !== null);
  const fallback = model.newChatSelection(null);
  useEffect(() => { if (!draft.modelSelection && fallback) { state.draft = { ...draft, modelSelection: fallback }; model.refresh(); } }, [state, draft, model, fallback?.provider, fallback?.modelId, fallback?.thinkingLevel]);
  return <form className="scheduled-form" onSubmit={event => { event.preventDefault(); void state.save(); }}>
    {state.needsReview && state.detail && <section className="scheduled-conflict" role="alert"><h2>当前已保存配置</h2><p>{state.detail.plan.config.title} · {scheduleSummary(state.detail.plan.config)}</p><p>{state.detail.plan.config.rule.timeZone} · {model.view.projects.find(project => project.id === state.detail!.plan.config.workspaceId)?.name ?? "工作区不可用"}</p><p>{permissionModes.find(mode => mode.value === state.detail!.plan.config.permission)?.label} · {state.detail.plan.config.modelSelection.modelId} · {state.detail.plan.config.modelSelection.thinkingLevel}</p><pre>{state.detail.plan.config.instructions}</pre><Button type="button" variant="outline" disabled={disabled} onClick={() => state.reviewed()}>已核对当前配置，继续编辑</Button></section>}
    <FieldGroup>
    <Field><FieldLabel htmlFor="schedule-title">Title</FieldLabel><Input id="schedule-title" autoFocus value={draft.title} maxLength={120} disabled={disabled} onChange={event => change({ title: event.target.value })} required /></Field>
    <Field><FieldLabel htmlFor="schedule-repeat">Schedule</FieldLabel><div className="scheduled-time-controls"><Select value={draft.repeat} disabled={disabled} onValueChange={value => { if (value === "once" || value === "daily" || value === "weekly") change({ repeat: value }); }}><SelectTrigger id="schedule-repeat" aria-label="Repeat"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="once">一次性</SelectItem><SelectItem value="daily">每天</SelectItem><SelectItem value="weekly">每周</SelectItem></SelectGroup></SelectContent></Select>
      {draft.repeat === "once" && <Input type="date" aria-label="执行日期" value={draft.date} disabled={disabled} required onChange={event => change({ date: event.target.value })} />}<Input type="time" aria-label="执行时间" value={draft.time} disabled={disabled} required onChange={event => change({ time: event.target.value })} /></div>
      {draft.repeat === "weekly" && <fieldset className="scheduled-weekdays"><legend className="sr-only">每周执行日期</legend>{[1, 2, 3, 4, 5, 6, 7].map(day => <label key={day}><input type="checkbox" disabled={disabled} checked={draft.weekdays.includes(day)} onChange={event => change({ weekdays: event.target.checked ? [...draft.weekdays, day].sort() : draft.weekdays.filter(value => value !== day) })} /><span>周{"一二三四五六日"[day - 1]}</span></label>)}</fieldset>}
      <FieldDescription>{draft.timeZone}</FieldDescription></Field>
    <Field><FieldLabel htmlFor="schedule-instructions">Instructions</FieldLabel><Textarea id="schedule-instructions" rows={6} value={draft.instructions} maxLength={64 * 1024} disabled={disabled} required onChange={event => change({ instructions: event.target.value })} /></Field>
    <Field><FieldLabel>Workspace</FieldLabel><WorkspacePicker workspaces={workspaces} value={draft.workspaceId} disabled={disabled} onChange={workspaceId => change({ workspaceId })} /></Field>
    <Field><FieldLabel>Permission</FieldLabel><ModeSelector label="计划权限" value={draft.permission} modes={permissionModes} disabled={disabled} onChange={permission => { if (permission !== "plan") change({ permission }); }} /></Field>
    <Field><FieldLabel>Model / Effort</FieldLabel><ModelSelector models={model.writes.models} selected={draft.modelSelection} loading={() => void model.writes.loadModels()} disabled={disabled} onChange={modelSelection => change({ modelSelection })} /></Field>
  </FieldGroup><div className="scheduled-form-actions"><Button type="button" variant="ghost" disabled={disabled} onClick={() => { state.draft = null; model.refresh(); }}>取消</Button><Button type="submit" disabled={disabled || state.needsReview}>{state.busy && <Loader2 data-icon="inline-start" className="animate-spin" />}保存计划</Button></div></form>;
}
export function Scheduled({ model, onOpenSession }: { model: CodeState; onOpenSession: (id: string) => void }) {
  const state = model.scheduled, detail = state.detail, plan = detail?.plan;
  const [confirmation, setConfirmation] = useState<"cancel" | "unknown" | null>(null);
  const active = detail?.activeRun;
  const unknown = !!active && (active.reason === "effect_unknown" || plan?.reason === "effect_unknown");
  const [confirmRun, setConfirmRun] = useState<CodeScheduleRun | null>(null);
  useEffect(() => { void state.load(); void model.writes.loadModels(); }, [state, model, model.view.instanceId, model.status.state]);
  function resume() { if (unknown && active) { setConfirmRun(active); setConfirmation("unknown"); } else void state.control("resume"); }
  function closeDetail() { state.selectedId = null; state.detail = null; state.draft = null; model.refresh(); }
  const hasDetail = !!state.draft || !!state.selectedId;
  return <div className="scheduled-page"><header className="scheduled-header"><div>{hasDetail && <Button type="button" variant="ghost" size="icon" aria-label="返回计划列表" disabled={state.busy || state.entries.some(entry => entry.record.instanceId === model.view.instanceId)} onClick={closeDetail}><ChevronLeft /></Button>}<h1><CalendarClock />{state.draft ? state.selectedId ? "编辑计划" : "新建计划" : plan?.config.title ?? "Scheduled"}</h1></div>{!state.draft && <Button type="button" variant="outline" disabled={state.blocked} onClick={() => state.create()}><Plus data-icon="inline-start" />新建计划</Button>}</header>
    {state.message && <p className="scheduled-message" role="status">{state.message}</p>}
    {state.entries.some(entry => entry.record.instanceId !== model.view.instanceId) && <p className="scheduled-message" role="status">其他实例的原保存记录仍保留，请连回原实例核实。</p>}
    {state.entries.some(entry => entry.record.instanceId === model.view.instanceId) && <p className="scheduled-message" role="status">原保存结果待核实，连接恢复后将按原请求查询。</p>}
    {state.draft ? <ScheduleForm model={model} /> : hasDetail ? !plan ? <p role="status">正在读取计划…</p> : <div className="scheduled-detail"><div className="scheduled-plan-meta"><span>{planStatus(plan)}</span><span>{scheduleSummary(plan.config)} · {plan.config.rule.timeZone}</span><span>{model.view.projects.find(item => item.id === plan.config.workspaceId)?.name ?? "工作区不可用"}</span><span>下次执行 · {scheduleTime(plan.nextDueAt, plan.config.rule.timeZone)}</span></div>
      {plan.reason && <p className="scheduled-message">{scheduleReason(plan.reason)}</p>}<div className="scheduled-plan-actions"><Button variant="outline" disabled={state.blocked || plan.status === "canceled"} onClick={() => state.edit()}>编辑</Button>{plan.status === "active" ? <Button variant="outline" disabled={state.blocked} onClick={() => void state.control("pause")}>暂停</Button> : plan.status === "paused" && <Button variant="outline" disabled={state.blocked} onClick={resume}>恢复</Button>}<Button variant="ghost" disabled={state.blocked || plan.status === "canceled"} onClick={() => setConfirmation("cancel")}>取消计划</Button></div>
      <section className="scheduled-instructions"><h2>Instructions</h2><p>{plan.config.instructions}</p></section><section><h2>运行记录</h2>{!detail.runs.length && <p className="text-sec">尚无运行记录</p>}<div className="scheduled-runs">{detail.runs.map(run => <Button variant="ghost" className="scheduled-run" key={run.id} onClick={() => onOpenSession(run.sessionId)}><span>{scheduleTime(run.scheduledAt, run.snapshot.rule.timeZone)}</span><span>{scheduledWaiting(model, run)}</span><span>打开会话</span></Button>)}</div>{detail.nextRunOffset !== null && <Button variant="ghost" onClick={() => void state.open(plan.id, true, true)}>更多运行</Button>}</section></div> : <><div className="scheduled-list-controls"><Button variant={state.history ? "ghost" : "secondary"} onClick={() => { state.history = false; void state.load(); }}>当前计划</Button><Button variant={state.history ? "secondary" : "ghost"} onClick={() => { state.history = true; void state.load(); }}>历史</Button><Button variant="ghost" disabled={state.loading || model.status.state !== "online"} onClick={() => void state.load()}>刷新</Button></div>
      {!state.plans.length && <div className="scheduled-empty"><CalendarClock /><p>{state.loading ? "正在读取计划…" : model.status.state !== "online" ? "连接恢复后可管理计划" : state.history ? "尚无历史计划" : "还没有定时计划"}</p></div>}<div className="scheduled-list">{state.plans.map(item => <Button type="button" variant="ghost" key={item.id} className="scheduled-card" onClick={() => void state.open(item.id)}><span className="scheduled-card-title">{item.config.title}</span><span>{planStatus(item)}</span><span>{scheduleSummary(item.config)}</span><span>{model.view.projects.find(project => project.id === item.config.workspaceId)?.name ?? "工作区不可用"}</span><span className={cn("scheduled-card-next", item.reason && "text-sec")}>{item.reason ? scheduleReason(item.reason) : `下次 · ${scheduleTime(item.nextDueAt, item.config.rule.timeZone)}`}</span>{state.latestRuns.get(item.id) && <span className="scheduled-card-next">最近运行 · {scheduledWaiting(model, state.latestRuns.get(item.id)!)}</span>}</Button>)}</div>{state.nextOffset !== null && <Button variant="ghost" disabled={state.loading} onClick={() => void state.load(true)}>更多计划</Button>}</>}
    <Dialog open={confirmation !== null} onOpenChange={open => { if (!open) setConfirmation(null); }}><DialogContent className="demo-dialog"><DialogHeader><DialogTitle>{confirmation === "cancel" ? "取消计划" : "允许未来新周期"}</DialogTitle><DialogDescription>{confirmation === "cancel" ? "取消将停止当前整项运行并阻止未来执行。已有修改与历史会保留。" : "请先检查原运行记录。确认后保留本轮未知结果，仅允许未来新周期；旧操作不会重试。"}</DialogDescription></DialogHeader><DialogFooter><Button variant="ghost" onClick={() => setConfirmation(null)}>返回</Button><Button disabled={state.blocked} onClick={() => { const action = confirmation; setConfirmation(null); if (action === "cancel") void state.control("cancel"); else if (confirmRun) void state.control("resume", confirmRun); }}>{confirmation === "cancel" ? "取消整项运行与计划" : "保留未知结果并恢复"}</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
