import type { DesktopTarget, DesktopUpdate } from "../shared/bridge.ts";
import type { CodeState } from "./code-state.ts";

export type ManagedSettingsCategory = "models" | "skills" | "mcp" | "computer";
export type SettingsCategory = "appearance" | `code-${ManagedSettingsCategory}` | "web-search" | "archived";
export interface SettingsScope {
  target: DesktopTarget;
  instanceId: string | null;
}
export type SettingsPhase = "loading" | "ready" | "saving" | "conflict" | "unknown" | "error";
/** Pages own their drafts, read revisions and original submissions; the container only decides whether navigation may leave. */
export interface SettingsForm {
  readonly dirty: boolean;
  readonly phase: SettingsPhase;
  readonly confirming?: boolean;
  save(): Promise<boolean>;
  discard(): void;
  invalidate(): void;
}
/** Whether the category belongs to Code-side managed settings. */
export function isCodeCategory(category: SettingsCategory): category is `code-${ManagedSettingsCategory}` {
  return category.startsWith("code-");
}
// Note: See .agents/notes/implemented/feature/2026-10-21-desktop-settings-shell.md
// Note: See .agents/notes/implemented/feature/2026-10-25-desktop-computer-websearch-settings.md
export class SettingsState {
  open = false;
  category: SettingsCategory = "appearance";
  form: SettingsForm | null = null;
  leave: (() => void) | null = null;
  private blockedNavigation = false;
  pageKey = 0;
  private generation = 0;
  constructor(readonly changed: () => void) {}
  get message(): string {
    if (!this.blockedNavigation) return "";
    return this.form?.phase === "saving" ? "Saving…" : this.form?.phase === "unknown" ? "The original configuration save is unverified. Verify the outcome first." : "";
  }
  show(target: DesktopTarget, category?: SettingsCategory): void {
    if (!this.open) {
      this.open = true;
      ++this.generation;
      if (!category) this.category = "code-models";
    }
    if (category) this.navigate(() => { this.category = category; });
    this.changed();
  }
  scope(code: CodeState): SettingsScope {
    return { target: "code", instanceId: code.view.instanceId };
  }
  ticket(): number { return this.generation; }
  accepts(ticket: number): boolean { return this.open && ticket === this.generation; }
  private invalidate(): void { ++this.generation; this.form?.invalidate(); }
  observe(target: DesktopTarget, update: DesktopUpdate): void {
    if (!this.open) return;
    if (target !== "code" || !isCodeCategory(this.category)) return;
    if (update.type !== "snapshot" && !(update.type === "state" && update.state !== "online")) return;
    this.invalidate();
    this.changed();
  }
  /** Saves only the UI navigation continuation; configuration requests still come from the specific page. */
  navigate(action: () => void): boolean {
    if (this.form?.phase === "saving" || this.form?.phase === "unknown") {
      this.blockedNavigation = true;
      this.changed(); return false;
    }
    if (this.form?.dirty) { this.leave = action; this.changed(); return false; }
    this.finish(action); return true;
  }
  private finish(action: () => void): void {
    this.invalidate();
    ++this.pageKey; this.form = null; this.leave = null; this.blockedNavigation = false;
    action(); this.changed();
  }
  chooseCategory(category: SettingsCategory): void { if (category !== this.category) this.navigate(() => { this.category = category; }); }
  close(after?: () => void): boolean { return this.navigate(() => { this.open = false; after?.(); }); }
  continueEditing(): void { this.leave = null; this.changed(); }
  discardAndLeave(): void {
    if (!this.leave || this.form?.phase === "saving" || this.form?.phase === "unknown") return;
    this.form?.discard(); this.finish(this.leave);
  }
  async saveAndLeave(): Promise<void> {
    const action = this.leave, form = this.form;
    if (!action || !form || form.phase === "saving" || form.phase === "unknown") return;
    if (await form.save() && this.form === form && this.leave === action) this.finish(action);
  }
}
