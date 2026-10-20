// Note: 见 .agents/notes/implemented/bug-fix/2026-10-17-desktop-file-tree-refresh.md
import type { DesktopInspector } from "./inspector.ts";

interface FilesRefreshHost extends Pick<EventTarget, "addEventListener" | "removeEventListener"> {
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(id: number): void;
}

export function startFilesRefresh(inspector: DesktopInspector, workspaceId: string, host: FilesRefreshHost = window): () => void {
  let stopped = false, running = false, timer: number | undefined;
  const controller = new AbortController();
  const refresh = async () => {
    if (stopped || running) return;
    running = true;
    if (timer !== undefined) host.clearTimeout(timer);
    try { await inspector.refreshDirectories(workspaceId, controller.signal); }
    finally {
      running = false;
      if (!stopped) timer = host.setTimeout(() => void refresh(), 3000);
    }
  };
  const focus = () => { void refresh(); };
  host.addEventListener("focus", focus);
  void refresh();
  return () => { stopped = true; controller.abort(); if (timer !== undefined) host.clearTimeout(timer); host.removeEventListener("focus", focus); };
}
