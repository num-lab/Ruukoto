import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Globe, Hand, Loader2, Play, RotateCw, X } from "lucide-react";
import type { CodeState } from "./code-state.ts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { nativeBrowser, type NativeBrowserApi } from "./native-browser.ts";
import { browserAddress } from "./browser-navigation.ts";

// Native input follows the host's current page claim, not general task activity.
// Note: See .agents/notes/implemented/simplification/2026-11-07-idle-desktop-browser.md

/** The page is treated as occluded when the topmost elements at the host's geometric center and corners fall outside the placeholder. */
function coveredByOverlay(host: HTMLElement, rect: DOMRect): boolean {
  const points: Array<[number, number]> = [
    [rect.left + 1, rect.top + 1], [rect.right - 1, rect.top + 1],
    [rect.left + 1, rect.bottom - 1], [rect.right - 1, rect.bottom - 1],
    [rect.left + rect.width / 2, rect.top + rect.height / 2],
  ];
  return points.some(([x, y]) => {
    const top = document.elementFromPoint(x, y);
    return top !== null && !host.contains(top);
  });
}

function usePageReporter(api: NativeBrowserApi | null, sessionId: string, visible: boolean) {
  const hostRef = useRef<HTMLDivElement>(null);
  const reportRef = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!api || !el) return;
    reportRef.current = () => {
      const r = el.getBoundingClientRect();
      void api.rect(r.x, r.y, r.width, r.height).catch(() => {});
      void api.state(sessionId, visible, visible ? coveredByOverlay(el, r) : false).catch(() => {});
    };
    reportRef.current();
  }, [api, sessionId, visible]);
  useEffect(() => {
    const el = hostRef.current;
    if (!api || !el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer !== null) return;
      // Rapid layout-animation/popover geometry changes are merged into one frame before reporting; report hidden once on unmount.
      timer = setTimeout(() => { timer = null; reportRef.current(); }, 80);
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "inert", "open"] });
    window.addEventListener("resize", schedule);
    return () => {
      ro.disconnect(); mo.disconnect(); window.removeEventListener("resize", schedule);
      if (timer !== null) clearTimeout(timer);
      void api.state(sessionId, false, false).catch(() => {});
    };
  }, [api, sessionId]);
  return hostRef;
}

export function NativeBrowserPanel({ model, sessionId, visible }: { model: CodeState; sessionId: string; visible: boolean }) {
  const api = nativeBrowser();
  const page = model.browser.pages.get(sessionId);
  const hostRef = usePageReporter(api, sessionId, visible);
  const [draft, setDraft] = useState("");
  const [draftDirty, setDraftDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const agentUsing = page?.owned === true && !page.gone;
  const ownerHeld = page?.ownerHeld === true && !page.gone;
  const url = page?.url ?? "";
  const shownUrl = draftDirty ? draft : url;

  const run = (name: string, fn: () => Promise<unknown>) => {
    setBusy(name); setError(null);
    // Preload send() turns IPC failures into resolved {ok:false}; discriminate by response shape.
    void fn().then(res => {
      const r = res as { ok?: boolean; error?: { message?: string } } | null;
      if (r && r.ok === false) setError(r.error?.message ?? "The operation failed.");
    }).catch(() => setError("The call wasn't sent; try again.")).finally(() => setBusy(null));
  };
  const submit = () => {
    if (agentUsing || busy !== null) return;
    const address = browserAddress(shownUrl.trim() || url);
    if (!address) { setError("The address is invalid. Check it and try again."); setDraftDirty(false); return; }
    run("navigate", () => api!.navigate(sessionId, address));
    setDraftDirty(false);
  };

  if (!api) return null;
  return <section className="browser-panel native-browser-panel" aria-label="Built-in browser">
    <form className="browser-toolbar" onSubmit={event => { event.preventDefault(); submit(); }}>
      <Button type="button" variant="ghost" size="icon" className="quiet-icon" aria-label="Back" disabled={busy !== null || agentUsing || !page || page.gone} onClick={() => run("back", () => api.back(sessionId))}><ArrowLeft /></Button>
      <Button type="button" variant="ghost" size="icon" className="quiet-icon" aria-label="Forward" disabled={busy !== null || agentUsing || !page || page.gone} onClick={() => run("forward", () => api.forward(sessionId))}><ArrowRight /></Button>
      <Button type="button" variant="ghost" size="icon" className="quiet-icon" aria-label="Reload page" disabled={busy !== null || agentUsing || !page || page.gone} onClick={() => run("reload", () => api.reload(sessionId))}><RotateCw /></Button>
      <Input aria-label="Web address" aria-invalid={error !== null} inputMode="url" autoComplete="off" spellCheck={false} placeholder="Enter a URL" disabled={busy !== null || agentUsing} value={shownUrl} onChange={event => { setDraft(event.target.value); setDraftDirty(true); setError(null); }} />
      {ownerHeld
        ? <Button type="button" variant="ghost" size="icon" className="quiet-icon" aria-label="Hand back to Agent" title="Hand back to Agent" disabled={busy !== null} onClick={() => run("return", () => api.returnToAgent(sessionId))}><Play /></Button>
        : <Button type="button" variant="ghost" size="icon" className="quiet-icon" aria-label="Take over the browser" title="Take over the browser" disabled={busy !== null || !agentUsing} onClick={() => run("takeover", () => api.takeover(sessionId))}><Hand /></Button>}
      <Button type="button" variant="ghost" size="icon" className="quiet-icon" aria-label="Close page" disabled={busy !== null} onClick={() => run("close", () => api.close(sessionId))}><X /></Button>
    </form>
    {error && <p className="browser-error" role="alert">{error}</p>}
    <div ref={hostRef} className="native-browser-host" role="presentation" aria-label={page?.title ? `Page: ${page.title}` : "Browser page"}>
      {!page || page.gone ? <div className="file-panel-empty"><Globe /><p>{page?.gone ? "Page closed" : "Waiting for the page to open"}</p>{busy === "navigate" && <Loader2 className="animate-spin" aria-hidden="true" />}</div> : null}
    </div>
    {page?.title && <p className="native-browser-caption" title={url}>{page.title}</p>}
  </section>;
}
