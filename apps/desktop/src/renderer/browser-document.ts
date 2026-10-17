import type { BrowserDocumentHandle, DesktopBridge, DesktopTarget } from "../shared/bridge.ts";

export type BrowserDocumentState = { document: BrowserDocumentHandle } | { error: string };
function documentHandle(value: unknown): BrowserDocumentHandle | null {
  if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" || !("url" in value) || typeof value.url !== "string") return null;
  let url: URL;
  try { url = new URL(value.url); }
  catch { return null; }
  return url.protocol === "http:" && url.hostname === "127.0.0.1" && !!url.port && !url.username && !url.password ? { id: value.id, url: url.href } : null;
}

// Note: 见 .agents/notes/implemented/feature/2026-10-17-desktop-local-browser.md
export function startBrowserDocument(request: DesktopBridge["request"], target: DesktopTarget, url: string, changed: (state: BrowserDocumentState) => void): () => void {
  let active = true, document: BrowserDocumentHandle | null = null;
  const release = async (id: string) => {
    try {
      const result = await request(target, "desktop_browser_release", { id });
      if (!result.ok && active) changed({ error: result.error.message });
      // 卸载后无可更新的组件；传输已断开的遗留能力由宿主退出统一回收。
    } catch { if (active) changed({ error: "本地预览连接已关闭，请重新打开文档。" }); }
  };
  void (async () => {
    let result: Awaited<ReturnType<DesktopBridge["request"]>>;
    try { result = await request(target, "desktop_browser_open", { url }); }
    catch { if (active) changed({ error: "本地预览连接已关闭，请重新打开文档。" }); return; }
    if (!result.ok) { if (active) changed({ error: result.error.message }); return; }
    document = documentHandle(result.value);
    if (!document) { if (active) changed({ error: "本地预览返回了无效地址，请重新打开应用。" }); return; }
    if (!active) { await release(document.id); return; }
    changed({ document });
  })();
  return () => { if (!active) return; active = false; if (document) void release(document.id); };
}
