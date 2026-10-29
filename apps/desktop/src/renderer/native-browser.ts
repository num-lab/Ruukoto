import type { DesktopUpdate, NativeBrowserApi } from "../shared/bridge.ts";

export type { NativeBrowserApi } from "../shared/bridge.ts";

// MyGo 右栏原生浏览器页（mygo-agent-browser 步骤 5）：页面由 Go 侧 browser.Manager
// 持有，前端只上报占位矩形/可见性并消费页面事实；拥有者接管与交还走可信调用。
export function nativeBrowser(): NativeBrowserApi | null {
  const candidate = window.ruukoto?.browser;
  return candidate && typeof candidate.rect === "function" ? candidate : null;
}

export interface NativePageState {
  url?: string;
  title?: string;
  owned?: boolean;
  generation?: number;
  gone?: boolean;
}

/** 每主会话一页的事实投影；browser_event update 上行。 */
export class NativeBrowserState {
  readonly pages = new Map<string, NativePageState>();

  update(update: DesktopUpdate): void {
    if (update.type !== "browser_event") return;
    const e = update.event;
    const prev = this.pages.get(e.session) ?? {};
    const next: NativePageState = { ...prev, url: e.url ?? prev.url, title: e.title ?? prev.title, generation: e.generation ?? prev.generation };
    if (e.kind === "gate") next.owned = e.owned === true;
    if (e.kind === "nav") next.url = e.url ?? prev.url;
    if (e.kind === "title") next.title = e.title ?? prev.title;
    if (e.kind === "gone" || e.kind === "closed") next.gone = true;
    this.pages.set(e.session, next);
  }
}
