// Note: 见 .agents/notes/implemented/bug-fix/2026-10-17-desktop-tab-drag-source.md
// Note: 见 .agents/notes/implemented/bug-fix/2026-10-17-desktop-tab-hover.md
import { useEffect, useState, type CSSProperties, type DragEvent, type KeyboardEvent } from "react";

export function reorderTab<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from >= items.length || to >= items.length || from === to) return items;
  const reordered = [...items];
  const [item] = reordered.splice(from, 1);
  reordered.splice(to, 0, item);
  return reordered;
}

export function tabDragOffset(order: string[], sourceId: string, targetId: string, id: string): number {
  const index = order.indexOf(id);
  if (index < 0) return 0;
  return reorderTab(order, order.indexOf(sourceId), order.indexOf(targetId)).indexOf(id) - index;
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-desktop-demo-v4.md
export function useTabOrder(scope: string, order: string[], move: (from: string, to: string) => void, title: (id: string) => string) {
  const [drag, setDrag] = useState<{ id: string; targetId?: string; previewed?: boolean } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [hoverPaused, setHoverPaused] = useState(false);
  const membership = [...order].sort().join("\0");
  useEffect(() => { setDrag(null); setHoverPaused(true); }, [scope, membership]);
  function reorder(from: string, to: string) {
    if (from === to || !order.includes(from) || !order.includes(to)) return;
    move(from, to);
    setAnnouncement(`${title(from)}已移至第 ${order.indexOf(to) + 1} 位，共 ${order.length} 个。`);
  }
  function targetAt(event: DragEvent<HTMLDivElement>) {
    const list = event.currentTarget;
    const first = list.querySelector<HTMLElement>(".tab-group");
    if (!first) return undefined;
    const gap = parseFloat(getComputedStyle(list).columnGap);
    const slot = Math.floor((event.clientX - list.getBoundingClientRect().left + gap / 2) / (first.getBoundingClientRect().width + gap));
    return order[Math.max(0, Math.min(order.length - 1, slot))];
  }
  function preview(event: DragEvent<HTMLDivElement>) {
    if (!drag) return;
    event.preventDefault(); event.dataTransfer.dropEffect = "move";
    const targetId = targetAt(event);
    if (targetId && targetId !== drag.targetId) setDrag({ ...drag, targetId, previewed: true });
  }
  return {
    announcement,
    list: {
      "data-hover-paused": hoverPaused ? "true" : undefined,
      style: { "--tab-count": Math.max(order.length, 1) } as CSSProperties,
      onPointerMove() { if (!drag) setHoverPaused(false); },
      onDragEnter: preview, onDragOver: preview,
      onDragLeave(event: DragEvent<HTMLDivElement>) {
        if (!drag?.targetId) return;
        const rect = event.currentTarget.parentElement!.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX >= rect.right || event.clientY < rect.top || event.clientY >= rect.bottom) setDrag({ ...drag, targetId: undefined });
      },
      onDrop(event: DragEvent<HTMLDivElement>) {
        if (drag) { event.preventDefault(); const to = targetAt(event); if (to) reorder(drag.id, to); }
        setDrag(null); setHoverPaused(true);
      },
    },
    group(id: string) { return {
      "data-sorting": drag ? "true" : undefined,
      "data-drag-source": drag?.previewed && drag.id === id ? "true" : undefined,
      style: { "--tab-shift": drag ? tabDragOffset(order, drag.id, drag.targetId ?? drag.id, id) : 0 } as CSSProperties,
    }; },
    trigger(id: string) { return {
      draggable: true,
      "data-dragging": drag?.id === id ? "true" : undefined,
      "aria-description": "可拖动排序，也可按 Alt+Shift+左右方向键调整顺序。",
      "aria-keyshortcuts": "Alt+Shift+ArrowLeft Alt+Shift+ArrowRight",
      onDragStart(event: DragEvent<HTMLButtonElement>) { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-ruukoto-tab", id); setHoverPaused(true); setDrag({ id }); },
      onDragEnd() { setDrag(null); setHoverPaused(true); },
      onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
        if (!event.altKey || !event.shiftKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
        event.preventDefault();
        const to = order[order.indexOf(id) + (event.key === "ArrowLeft" ? -1 : 1)];
        if (!to) return;
        setHoverPaused(true);
        reorder(id, to);
        const button = event.currentTarget; window.requestAnimationFrame(() => button.focus());
      },
    }; },
  };
}
