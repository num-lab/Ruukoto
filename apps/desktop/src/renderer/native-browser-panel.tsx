import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Globe, Hand, Loader2, RotateCw, X } from "lucide-react";
import type { CodeState } from "./code-state.ts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { nativeBrowser, type NativeBrowserApi } from "./native-browser.ts";
import { browserAddress } from "./browser-navigation.ts";

// MyGo 右栏原生浏览器面板（mygo-agent-browser 步骤 5）：本组件只占位，
// 真实页面是 Go 侧叠加的原生 WebView。矩形/可见性经可信调用上报；
// 拥有者接管后导航被闸门拒绝，须先显式接管，交还后 Agent 重新观察。

/** 宿主几何中心与四角的顶层元素不在占位内即视为被弹层遮挡。 */
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
      // 布局动画/弹层频繁变更合并到一帧后上报；卸载时补一次隐藏。
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
  const ownerHeld = page?.owned === false;
  const url = page?.url ?? "";
  const shownUrl = draftDirty ? draft : url;

  const run = (name: string, fn: () => Promise<unknown>) => {
    setBusy(name); setError(null);
    void fn().catch((e: unknown) => setError((e as Error).message ?? String(e))).finally(() => setBusy(null));
  };
  const submit = () => {
    const address = browserAddress(shownUrl.trim() || url);
    if (!address) { setError("地址无效，请检查后重试。"); setDraftDirty(false); return; }
    run("navigate", () => api!.navigate(sessionId, address));
    setDraftDirty(false);
  };

  if (!api) return null;
  return <section className="browser-panel native-browser-panel" aria-label="内置浏览器">
    <form className="browser-toolbar" onSubmit={event => { event.preventDefault(); submit(); }}>
      <Button type="button" variant="ghost" size="icon" className="quiet-icon" aria-label="后退" disabled={busy !== null || ownerHeld} onClick={() => run("back", () => api.back(sessionId))}><ArrowLeft /></Button>
      <Button type="button" variant="ghost" size="icon" className="quiet-icon" aria-label="前进" disabled={busy !== null || ownerHeld} onClick={() => run("forward", () => api.forward(sessionId))}><ArrowRight /></Button>
      <Button type="button" variant="ghost" size="icon" className="quiet-icon" aria-label="刷新网页" disabled={busy !== null || ownerHeld} onClick={() => run("reload", () => api.reload(sessionId))}><RotateCw /></Button>
      <Input aria-label="网页地址" aria-invalid={error !== null} inputMode="url" autoComplete="off" spellCheck={false} placeholder="输入网址" value={shownUrl} onChange={event => { setDraft(event.target.value); setDraftDirty(true); setError(null); }} />
      {ownerHeld
        ? <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => run("return", () => api.returnToAgent(sessionId))}><Hand />交还 Agent</Button>
        : <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => run("takeover", () => api.takeover(sessionId))}><Hand />接管</Button>}
      <Button type="button" variant="ghost" size="icon" className="quiet-icon" aria-label="关闭页面" disabled={busy !== null} onClick={() => run("close", () => api.close(sessionId))}><X /></Button>
    </form>
    {ownerHeld && <p className="browser-gate-note" role="status">你已接管页面：Agent 停止操作并在等待交还；导航与输入由你控制。</p>}
    {error && <p className="browser-error" role="alert">{error}{/page_owned|not_owned/.test(error) ? "（先接管再操作）" : ""}</p>}
    <div ref={hostRef} className="native-browser-host" role="presentation" aria-label={page?.title ? `页面：${page.title}` : "浏览器页面"}>
      {!page || page.gone ? <div className="file-panel-empty"><Globe /><p>{page?.gone ? "页面已关闭" : "等待页面打开"}</p>{busy === "navigate" && <Loader2 className="animate-spin" aria-hidden="true" />}</div> : null}
    </div>
    {page?.title && <p className="native-browser-caption" title={url}>{page.title}</p>}
  </section>;
}
