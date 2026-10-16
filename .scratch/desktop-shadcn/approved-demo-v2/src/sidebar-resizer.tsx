import { useEffect, useRef, useState, type PointerEvent } from "react";

export type SidebarSide = "left" | "right";

export function sidebarWidthLimits(side: SidebarSide, windowWidth: number, otherWidth: number) {
  const min = side === "left" ? 180 : 260;
  return { min, max: Math.max(min, Math.min(side === "left" ? 360 : 640, windowWidth - (side === "left" && otherWidth > 0 ? 260 : otherWidth) - 220)) };
}

export function SidebarResizer({ side, open, onWidthChange }: { side: SidebarSide; open: boolean; onWidthChange: (width: number) => void }) {
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [bounds, setBounds] = useState({ width: side === "left" ? 200 : 310, min: side === "left" ? 180 : 260, max: side === "left" ? 360 : 640 });
  const direction = side === "left" ? 1 : -1;

  function measure() {
    const panel = handle.current!.parentElement!;
    const appWindow = panel.closest<HTMLElement>(".app-window")!;
    const other = appWindow.querySelector<HTMLElement>(side === "left" ? ".right-sidebar" : ".left-sidebar")!;
    return { width: panel.getBoundingClientRect().width, ...sidebarWidthLimits(side, appWindow.clientWidth, other.classList.contains("is-collapsed") ? 0 : other.getBoundingClientRect().width) };
  }
  function changeWidth(width: number) {
    const { min, max } = measure();
    onWidthChange(Math.round(Math.max(min, Math.min(max, width))));
  }
  function finishResize() {
    const active = drag.current;
    drag.current = null;
    if (active && handle.current?.hasPointerCapture(active.pointerId)) handle.current.releasePointerCapture(active.pointerId);
    setDragging(false);
  }

  function finishPointer(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId === event.pointerId) finishResize();
  }

  useEffect(() => {
    const panel = handle.current!.parentElement!;
    const appWindow = panel.closest<HTMLElement>(".app-window")!;
    const observer = new ResizeObserver(() => setBounds(measure()));
    observer.observe(appWindow);
    observer.observe(panel);
    observer.observe(appWindow.querySelector(side === "left" ? ".right-sidebar" : ".left-sidebar")!);
    return () => observer.disconnect();
  }, [side]);
  useEffect(() => {
    if (!open) finishResize();
    return finishResize;
  }, [open]);

  return <div ref={handle} className={`sidebar-resize-handle resize-${side}`} role="separator" aria-label={side === "left" ? "左侧栏宽度" : "右侧栏宽度"} aria-orientation="vertical" aria-controls={`${side}-sidebar`} aria-valuemin={bounds.min} aria-valuemax={bounds.max} aria-valuenow={Math.max(bounds.min, Math.min(bounds.max, Math.round(bounds.width)))} tabIndex={0} data-dragging={dragging || undefined} onPointerDown={event => {
    if (drag.current || event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    event.currentTarget.focus();
    drag.current = { pointerId: event.pointerId, x: event.clientX, width: measure().width };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }} onPointerMove={event => {
    const active = drag.current;
    if (active?.pointerId === event.pointerId) changeWidth(active.width + (event.clientX - active.x) * direction);
  }} onPointerUp={finishPointer} onPointerCancel={finishPointer} onLostPointerCapture={finishPointer} onKeyDown={event => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    changeWidth(measure().width + (event.key === "ArrowRight" ? 16 : -16) * direction);
  }} />;
}
