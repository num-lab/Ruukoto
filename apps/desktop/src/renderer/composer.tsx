import { useEffect, useState } from "react";
import type { ModelSelection, Session, SessionDefaultMode } from "@ruukoto/core/types.ts";
import { formatTaskStatus } from "@ruukoto/view/state.ts";
import type { CodeState } from "./code-state.ts";
import { queueDecision } from "./code-writes.ts";

const modeLabels = { confirm: "Ask for approval", full_access: "Full access", "auto-review": "Auto review", plan: "Plan" };
const modes = Object.keys(modeLabels) as SessionDefaultMode[];
export function PendingInputs({ model }: { model: CodeState }) {
  const writes = model.writes;
  return <div className="pending-inputs" aria-label="待核实输入">
    {writes.corrupt.length > 0 && <p role="alert">{writes.corrupt.length} 条记录损坏，请人工检查：{writes.pendingDir}（{writes.corrupt.join("、")}）</p>}
    {[...writes.entries.values()].map(({ record, result }) => <div key={record.requestId} className="pending-input" role="status"><span>{model.sessionName(String(record.params.session_id ?? ""))} · {result?.kind === "needs_resubmit" ? "原请求未被后台接收，且缺少模型" : result?.kind === "foreign_instance" ? "请连回原数据实例核实" : "接收结果未知，发送仍禁用"}</span>{result?.kind === "needs_resubmit" && <span><button onClick={() => void writes.restore(record.requestId)}>恢复输入</button><button onClick={() => writes.defer()}>暂不处理</button></span>}</div>)}
  </div>;
}
export function Composer({ model, session }: { model: CodeState; session: Session }) {
  const writes = model.writes;
  const draft = writes.draft(session.id);
  const [effectTask, setEffectTask] = useState<string | null>(null);
  const [queueConfirm, setQueueConfirm] = useState(false);
  useEffect(() => { void writes.loadModels(); }, [writes]);
  const modelValue = session.modelSelection ? JSON.stringify(session.modelSelection) : "";
  const choices = writes.models.flatMap(model => model.thinkingLevels.map(thinkingLevel => ({ selection: { provider: model.provider, modelId: model.modelId, thinkingLevel }, label: `${model.provider} / ${model.name} · ${thinkingLevel}${model.available ? "" : "（认证不可用）"}`, available: model.available })));
  const online = model.status.state === "online";
  const busy = writes.busy.has(session.id);
  const decision = queueDecision(model.view, session);
  const tasks = model.view.tasksFor(session.id).filter(task => ["running", "awaiting_confirmation", "queued", "interrupted"].includes(task.status));
  return <section className="composer" aria-label="发送与任务控制">
    {session.queueState === "paused" && <div className="queue-banner" role="status"><span>队列已暂停{session.queuePauseReason && ` · ${session.queuePauseReason}`}</span><button disabled={!online || busy} onClick={() => {
      if (decision.kind === "select_model") { writes.message = "旧排队任务缺少模型，请先选择模型。"; void writes.loadModels(); }
      else if (decision.kind === "confirm") setQueueConfirm(true);
      else void writes.resume(session);
    }}>恢复队列</button></div>}
    {queueConfirm && decision.kind === "confirm" && <div className="control-confirm" role="alert"><p>为 {decision.count} 个旧排队任务补齐模型：{decision.selection.provider} / {decision.selection.modelId} · {decision.selection.thinkingLevel}</p><button onClick={() => { setQueueConfirm(false); void writes.resume(session, true); }}>确认补齐并恢复</button><button onClick={() => setQueueConfirm(false)}>取消</button></div>}
    {effectTask && <div className="control-confirm" role="alert"><p>原任务有结果未知的操作。请先核实原操作，避免继续时重复执行。</p><button onClick={() => { writes.continueTask(session.id, effectTask); setEffectTask(null); }}>已核实，准备继续</button><button onClick={() => setEffectTask(null)}>取消</button></div>}
    <div className="task-controls">{tasks.map(task => <div key={task.id}><span>{formatTaskStatus(task.status)} · {task.input.slice(0, 48)}</span>{task.status === "interrupted" ? <button disabled={!online || busy || writes.blocked(session.id)} onClick={() => task.effectUnknown ? setEffectTask(task.id) : writes.continueTask(session.id, task.id)}>继续</button> : <><button disabled={!online || busy || task.status === "queued"} onClick={() => void writes.control("interrupt", session.id, task.id)}>中断</button><button disabled={!online || busy} onClick={() => void writes.control("cancel", session.id, task.id)}>取消任务</button></>}</div>)}</div>
    {draft.taskId && <div className="continue-source">正在继续中断的任务<button onClick={() => { delete draft.taskId; writes.edit(session.id, draft.text); }}>改为新任务</button></div>}
    <form onSubmit={event => { event.preventDefault(); void writes.send(session.id); }}>
      <textarea aria-label="输入消息" placeholder={draft.taskId ? "输入继续任务的指示…" : "输入消息…"} value={draft.text} onChange={event => writes.edit(session.id, event.target.value)} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void writes.send(session.id); } }} rows={3} />
      <div className="composer-toolbar"><label>模型<select aria-label="会话模型" disabled={!online || busy} value={modelValue} onFocus={() => void writes.loadModels()} onChange={event => { const choice = choices.find(choice => JSON.stringify(choice.selection) === event.target.value); if (choice?.available) void writes.setModel(session, choice.selection as ModelSelection); }}><option value="">选择模型</option>{modelValue && !choices.some(choice => JSON.stringify(choice.selection) === modelValue) && <option value={modelValue}>{session.modelSelection!.provider} / {session.modelSelection!.modelId} · {session.modelSelection!.thinkingLevel}</option>}{choices.map(choice => <option key={JSON.stringify(choice.selection)} value={JSON.stringify(choice.selection)} disabled={!choice.available}>{choice.label}</option>)}</select></label><label>模式<select aria-label="会话默认模式" disabled={!online || busy} value={session.defaultAccessMode} onChange={event => { const mode = modes.find(mode => mode === event.target.value); if (mode) void writes.setMode(session, mode); }}>{modes.map(mode => <option key={mode} value={mode}>{modeLabels[mode]}</option>)}</select></label><button className="send" type="submit" disabled={writes.blocked(session.id) || !draft.text.trim() || !session.modelSelection}>{draft.taskId ? "发送并继续" : "发送"}</button></div>
    </form>
  </section>;
}
