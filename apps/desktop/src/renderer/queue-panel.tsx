import { useEffect, useState, type CSSProperties, type DragEvent } from "react";
import { ChevronDown, GripVertical, ListOrdered, Undo2, Waypoints } from "lucide-react";
import type { Session } from "@ruukoto/core/types.ts";
import type { CodeState } from "./code-state.ts";
import { queueOrderAfterMove } from "./code-writes.ts";
import { Button } from "./components/ui/button.tsx";

type QueueDrag = { taskId: string; targetId: string; placement: "before" | "after"; rowHeight: number };

/**
 * Display the compact queue in persisted queue_order.
 * Drag and arrow keys use revision-checked queue_reorder; conversion to guidance uses steer_task.
 * Order and eligibility come from the server's task_queue receipt. Continuations and question answers
 * can be reordered but are absent from steerableTaskIds, so their guidance action is disabled.
 */
export function QueuePanel({ model, session, defaultOpen = false }: { model: CodeState; session: Session; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [announce, setAnnounce] = useState("");
  const [drag, setDrag] = useState<QueueDrag | null>(null);
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
  const previewOrder = drag ? queueOrderAfterMove(reorderable, drag.taskId, drag.targetId, drag.placement) : null;
  let previewCursor = 0;
  const previewVisible = previewOrder ? queued.map(task => reorderable.includes(task.id) ? previewOrder[previewCursor++]! : task.id) : null;

  async function move(taskId: string, delta: -1 | 1) {
    const order = detail?.reorderableTaskIds ?? [];
    const target = order[order.indexOf(taskId) + delta];
    await model.writes.moveQueued(session.id, taskId, delta);
    const pos = target ? queued.findIndex(task => task.id === target) + 1 : 0;
    if (pos > 0) setAnnounce(`已移动到第 ${pos} 位，共 ${count} 项`);
  }

  async function drop(taskId: string, targetId: string, placement: "before" | "after") {
    const next = queueOrderAfterMove(reorderable, taskId, targetId, placement);
    await model.writes.reorderQueued(session.id, taskId, targetId, placement);
    if (!next) return;
    let cursor = 0;
    const visible = queued.map(task => reorderable.includes(task.id) ? next[cursor++]! : task.id);
    const pos = visible.indexOf(taskId) + 1;
    if (pos > 0) setAnnounce(`已移动到第 ${pos} 位，共 ${count} 项`);
  }

  function updateDrop(event: DragEvent<HTMLLIElement>, taskId: string, canMove: boolean): "before" | "after" | null {
    if (!drag || busy || !canMove || drag.taskId === taskId) return null;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const placement = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
    if (drag.targetId !== taskId || drag.placement !== placement) setDrag({ ...drag, targetId: taskId, placement });
    return placement;
  }

  return <div className={open ? "queue-panel is-open" : "queue-panel"}>
    <button type="button" className="queue-panel-toggle" aria-expanded={open} aria-label={`排队输入 ${count} 项`} onClick={() => setOpen(!open)}>
      <ListOrdered className="queue-panel-icon" aria-hidden="true" />
      <span className="queue-summary">排队 <span className="queue-count">{count}</span></span>
      {!open && <span className="queue-next">{queued[0].displayInput ?? queued[0].input}</span>}
      <ChevronDown className={open ? "queue-panel-chevron is-open" : "queue-panel-chevron"} aria-hidden="true" />
    </button>
    <span className="sr-only" role="status" aria-live="polite">{announce}</span>
    {open && <ul className="queue-panel-list" aria-label="排队输入列表" onDragLeave={event => {
      const next = event.relatedTarget;
      if (!(next instanceof Node) || !event.currentTarget.contains(next)) setDrag(null);
    }}>
      {queued.map((task, index) => {
        const order = reorderable.indexOf(task.id);
        const canMove = order >= 0;
        const canSteer = steerable.includes(task.id);
        const canRecall = model.writes.recallState(session.id)?.candidate?.taskId === task.id;
        const previewIndex = previewVisible?.indexOf(task.id) ?? index;
        const dragging = drag?.taskId === task.id;
        const style: CSSProperties = drag && !dragging && previewIndex !== index ? { transform: `translateY(${(previewIndex - index) * drag.rowHeight}px)` } : {};
        const input = task.displayInput ?? task.input;
        return <li key={task.id}
          className={`queue-panel-item${dragging ? " is-dragging" : ""}${drag?.targetId === task.id && !dragging ? " drop-target" : ""}`}
          tabIndex={0}
          draggable={canMove && !busy}
          aria-label={`第 ${index + 1} 位：${input}${canMove ? "，可拖拽或用方向键调整顺序" : ""}`}
          style={style}
          onDragStart={event => {
            if (!canMove || busy) { event.preventDefault(); return; }
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", task.id);
            setDrag({ taskId: task.id, targetId: task.id, placement: "before", rowHeight: event.currentTarget.offsetHeight });
          }}
          onDragOver={event => { updateDrop(event, task.id, canMove); }}
          onDrop={event => {
            if (!drag) return;
            const placement = updateDrop(event, task.id, canMove);
            const taskId = drag.taskId;
            setDrag(null);
            if (!placement) return;
            void drop(taskId, task.id, placement);
          }}
          onDragEnd={() => setDrag(null)}
          onKeyDown={event => {
            if (event.key === "ArrowUp" && canMove && order > 0) { event.preventDefault(); void move(task.id, -1); }
            else if (event.key === "ArrowDown" && canMove && order < reorderable.length - 1) { event.preventDefault(); void move(task.id, 1); }
          }}>
          <span className="queue-panel-drag" aria-hidden="true">{canMove && <GripVertical />}</span>
          <span className="queue-panel-pos" aria-hidden="true">{index + 1}</span>
          <span className="queue-panel-text">{input}</span>
          {(canSteer || canRecall) && <span className="queue-panel-actions">
            {canSteer && <Button type="button" variant="ghost" size="icon" className="queue-panel-btn queue-panel-steer" draggable={false} disabled={busy} aria-label={`把第 ${index + 1} 项转为引导`} title="转为引导：接入当前任务下一边界" onClick={() => void model.writes.steerQueued(session.id, task.id)}><Waypoints /></Button>}
            {canRecall && <Button type="button" variant="ghost" size="icon" className="queue-panel-btn" draggable={false} disabled={busy} aria-label={`撤回第 ${index + 1} 项并编辑`} title="撤回此输入并编辑" onClick={() => void model.writes.recall(session.id, task.id)}><Undo2 /></Button>}
          </span>}
        </li>;
      })}
    </ul>}
  </div>;
}
