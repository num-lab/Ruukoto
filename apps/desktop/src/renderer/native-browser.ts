import type { DesktopUpdate, NativeBrowserApi } from "../shared/bridge.ts";

export type { NativeBrowserApi } from "../shared/bridge.ts";

// The native host owns page input; the renderer consumes its gate events.
export function nativeBrowser(): NativeBrowserApi | null {
  const candidate = window.ruukoto?.browser;
  return candidate && typeof candidate.rect === "function" ? candidate : null;
}

export interface NativePageState {
  url?: string;
  title?: string;
  owned?: boolean;
  ownerHeld?: boolean;
  generation?: number;
  gone?: boolean;
}

/** One native page per main conversation, including idle and takeover states. */
export class NativeBrowserState {
  readonly pages = new Map<string, NativePageState>();

  update(update: DesktopUpdate): void {
    if (update.type !== "browser_event") return;
    const e = update.event;
    const prev = this.pages.get(e.session) ?? {};
    if (prev.generation !== undefined && e.generation < prev.generation) return;
    const next: NativePageState = { ...prev, url: e.url ?? prev.url, title: e.title ?? prev.title, generation: e.generation ?? prev.generation };
    if (e.owned !== undefined) { next.owned = e.owned; next.ownerHeld = e.ownerHeld ?? (!next.owned && e.source === "owner"); if (next.owned) next.gone = false; }
    if (e.kind === "nav") { next.url = e.url ?? prev.url; next.gone = false; }
    if (e.kind === "title") next.title = e.title ?? prev.title;
    if (e.kind === "gone" || e.kind === "closed") { next.gone = true; next.owned = false; next.ownerHeld = false; }
    this.pages.set(e.session, next);
  }
}
