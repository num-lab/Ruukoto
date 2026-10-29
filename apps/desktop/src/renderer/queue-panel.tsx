import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, ListOrdered, Waypoints } from "lucide-react";
import type { Session } from "@ruukoto/core/types.ts";
import type { CodeState } from "./code-state.ts";
import { Button } from "./components/ui/button.tsx";

/**
 * 紧凑排队面板（coding-message-control）：按持久 queue_order 展示，
 * 上移/下移经 queue_reorder（修订乐观并发），「转为引导」经 steer_task。
 * 顺序与资格集合一律取服务端 task_queue 回执；/continue 与问题回答续接
 * 可重排但不出现在 steerableTaskIds，按钮按此禁用。
 */
export function QueuePanel({ model, session }: { model: CodeState; session: Session }) {
  const [open, setOpen] = useState(false);
  const [announce, setAnnounce] = useState("");
  const queued = model.view.queuedTasksFor(session.id);
  const detail = model.writes.queueDetail(session.id);
  const online = model.status.state === "online";
  const blocked = model.writes.blocked(session.id);
  const count = queued.length;

  useEffect(() => {
    // 事件驱动的刷新在 writes.update 内；本 effect 只覆盖会话切换/上线/冷恢复出现排队项
    if (online && count > 0) void model.writes.loadQueue(session.id);
  }, [model.writes, session.id, online, count]);

  useEffect(() => { if (count === 0) setOpen(false); }, [count]);
  if (count === 0) return null;

  const reorderable = detail?.reorderableTaskIds ?? [];
  const steerable = detail?.steerableTaskIds ?? [];
  const busy = !online || blocked;

  // 首尾禁用与位置反馈都以可重排集合的下标为准——queued 里可能混有不可重排项
  async function move(taskId: string, delta: -1 | 1) {
    const order = detail?.reorderableTaskIds ?? [];
    const target = order[order.indexOf(taskId) + delta];
    await model.writes.moveQueued(session.id, taskId, delta);
    const pos = target ? queued.findIndex(task => task.id === target) + 1 : 0;
    if (pos > 0) setAnnounce(`已移动到第 ${pos} 位，共 ${count} 项`);
  }

  return <div className="queue-panel surface-composer">
    <button type="button" className="queue-panel-toggle" aria-expanded={open} aria-label={`排队输入 ${count} 项`} onClick={() => setOpen(!open)}>
      <ListOrdered className="queue-panel-icon" aria-hidden="true" />
      <span>排队 · {count}</span>
      <ChevronDown className={open ? "queue-panel-chevron is-open" : "queue-panel-chevron"} aria-hidden="true" />
    </button>
    <span className="sr-only" role="status" aria-live="polite">{announce}</span>
    {open && <ul className="queue-panel-list" aria-label="排队输入列表">
      {queued.map((task, index) => {
        const order = reorderable.indexOf(task.id);
        const canMove = order >= 0;
        const canSteer = steerable.includes(task.id);
        return <li key={task.id}
          className="queue-panel-item"
          tabIndex={0}
          aria-label={`第 ${index + 1} 位：${task.displayInput ?? task.input}`}
          onKeyDown={event => {
            if (event.key === "ArrowUp" && canMove && order > 0) { event.preventDefault(); void move(task.id, -1); }
            else if (event.key === "ArrowDown" && canMove && order < reorderable.length - 1) { event.preventDefault(); void move(task.id, 1); }
          }}>
          <span className="queue-panel-pos" aria-hidden="true">{index + 1}</span>
          <span className="queue-panel-text">{task.displayInput ?? task.input}</span>
          <span className="queue-panel-actions">
            <Button type="button" variant="ghost" size="icon" className="queue-panel-btn" disabled={busy || !canMove || order === 0} aria-label={`上移第 ${index + 1} 项`} onClick={() => void move(task.id, -1)}><ChevronUp /></Button>
            <Button type="button" variant="ghost" size="icon" className="queue-panel-btn" disabled={busy || !canMove || order >= reorderable.length - 1} aria-label={`下移第 ${index + 1} 项`} onClick={() => void move(task.id, 1)}><ChevronDown /></Button>
            {canSteer && <Button type="button" variant="ghost" size="icon" className="queue-panel-btn queue-panel-steer" disabled={busy} aria-label={`把第 ${index + 1} 项转为引导`} title="转为引导：接入当前任务下一边界" onClick={() => void model.writes.steerQueued(session.id, task.id)}><Waypoints /></Button>}
          </span>
        </li>;
      })}
    </ul>}
  </div>;
}
