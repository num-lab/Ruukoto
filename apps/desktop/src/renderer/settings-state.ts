import type { DesktopTarget, DesktopUpdate } from "../shared/bridge.ts";
import type { CodeState } from "./code-state.ts";
import type { PersonalSettingsPageState } from "./personal-settings-state.ts";

export type ManagedSettingsCategory = "models" | "skills" | "mcp" | "computer";
export type SettingsCategory = "appearance" | `code-${ManagedSettingsCategory}` | `pa-${ManagedSettingsCategory}` | "web-search" | "personal" | "archived";
export interface SettingsScope {
  target: DesktopTarget;
  instanceId: string | null;
}
export type SettingsPhase = "loading" | "ready" | "saving" | "conflict" | "unknown" | "error";
/** 页面保管草稿、读取修订与原提交；容器只决定能否离开。 */
export interface SettingsForm {
  readonly dirty: boolean;
  readonly phase: SettingsPhase;
  readonly confirming?: boolean;
  save(): Promise<boolean>;
  discard(): void;
  invalidate(): void;
}
/** 把分组类别映射回 PA 页面使用的原始类别。 */
export function paCategory(category: SettingsCategory): ManagedSettingsCategory | null {
  switch (category) {
    case "pa-models": return "models";
    case "pa-skills": return "skills";
    case "pa-mcp": return "mcp";
    case "pa-computer": return "computer";
    default: return null;
  }
}
/** 判断类别是否属于 Code 侧 managed 设置。 */
export function isCodeCategory(category: SettingsCategory): category is `code-${ManagedSettingsCategory}` {
  return category.startsWith("code-");
}
/** 判断类别是否属于 PA 侧 managed 设置。 */
export function isPaCategory(category: SettingsCategory): category is `pa-${ManagedSettingsCategory}` {
  return category.startsWith("pa-");
}
// Note: 见 .agents/notes/implemented/feature/2026-10-21-desktop-settings-shell.md
// Note: 见 .agents/notes/implemented/feature/2026-10-25-desktop-computer-websearch-settings.md
export class SettingsState {
  open = false;
  category: SettingsCategory = "appearance";
  form: SettingsForm | null = null;
  readonly personalPages = new Map<string, PersonalSettingsPageState>();
  leave: (() => void) | null = null;
  private blockedNavigation = false;
  pageKey = 0;
  private generation = 0;
  constructor(readonly changed: () => void) {}
  get message(): string {
    if (!this.blockedNavigation) return "";
    return this.form?.phase === "saving" ? "正在保存，请等待完成。" : this.form?.phase === "unknown" ? "原配置的保存结果待核实，请先核实结果。" : "";
  }
  show(target: DesktopTarget, category?: SettingsCategory): void {
    if (!this.open) {
      this.open = true;
      ++this.generation;
      // 首次打开时按当前聊天目标落到对应分组。
      if (!category) this.category = target === "personal" ? "pa-models" : "code-models";
    }
    if (category) this.navigate(() => { this.category = category; });
    this.changed();
  }
  scope(code: CodeState, personal: { view: { instanceId: string | null } }): SettingsScope {
    const target: DesktopTarget = isPaCategory(this.category) ? "personal" : "code";
    const instanceId = (target === "code" ? code : personal).view.instanceId;
    return { target, instanceId };
  }
  ticket(): number { return this.generation; }
  accepts(ticket: number): boolean { return this.open && ticket === this.generation; }
  releasePersonalPage(key: string, form: PersonalSettingsPageState): void {
    if (form.dirty || form.phase === "saving" || form.phase === "unknown") this.personalPages.set(key, form);
    else this.personalPages.delete(key);
    form.leave();
    if (this.form === form) this.form = null;
  }
  private invalidate(): void { ++this.generation; this.form?.invalidate(); }
  observe(target: DesktopTarget, update: DesktopUpdate): void {
    if (!this.open) return;
    const currentTarget = isPaCategory(this.category) ? "personal" : "code";
    if (currentTarget !== target) return;
    if (!isCodeCategory(this.category) && !isPaCategory(this.category)) return;
    if (update.type !== "snapshot" && update.type !== "personal_identity" && !(update.type === "personal_frame" && update.frame.type === "snapshot") && !(update.type === "state" && update.state !== "online")) return;
    this.invalidate();
    this.changed();
  }
  /** 仅保存 UI 导航续步；配置请求仍由具体页面发起。 */
  navigate(action: () => void): boolean {
    if (this.form?.phase === "saving" || this.form?.phase === "unknown") {
      if (isPaCategory(this.category)) { this.finish(action); return true; }
      this.blockedNavigation = true;
      this.changed(); return false;
    }
    if (this.form?.dirty) { this.leave = action; this.changed(); return false; }
    this.finish(action); return true;
  }
  private finish(action: () => void): void {
    if (isPaCategory(this.category)) ++this.generation;
    else this.invalidate();
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
