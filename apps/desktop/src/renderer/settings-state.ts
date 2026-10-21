import type { DesktopTarget, DesktopUpdate } from "../shared/bridge.ts";
import type { CodeState } from "./code-state.ts";

export type ManagedSettingsCategory = "models" | "skills" | "mcp";
export type SettingsCategory = "appearance" | ManagedSettingsCategory | "personal" | "archived";
export interface SettingsScope {
  target: DesktopTarget;
  instanceId: string | null;
  workspaceId: string | null;
  sourceId: string | null;
}
export type SettingsPhase = "loading" | "ready" | "saving" | "conflict" | "unknown" | "error";
/** 页面保管草稿、读取修订与原提交；容器只决定能否离开。 */
export interface SettingsForm {
  readonly dirty: boolean;
  readonly phase: SettingsPhase;
  readonly confirming?: boolean;
  save(): Promise<boolean>;
  saveAndContinue?(): Promise<boolean>;
  discard(): void;
  invalidate(): void;
}
export interface SettingsSource { id: string; name: string }
export interface SettingsSources {
  instanceId: string;
  workspaceId: string;
  items: SettingsSource[];
}

// Note: 见 .agents/notes/implemented/feature/2026-10-21-desktop-settings-shell.md
export class SettingsState {
  open = false;
  category: SettingsCategory = "appearance";
  selections: Record<ManagedSettingsCategory, { target: DesktopTarget; workspaceId: string | null; sourceId: string | null }> = {
    models: { target: "code", workspaceId: null, sourceId: null },
    skills: { target: "code", workspaceId: null, sourceId: null },
    mcp: { target: "code", workspaceId: null, sourceId: null },
  };
  form: SettingsForm | null = null;
  leave: (() => void) | null = null;
  private blockedNavigation = false;
  pageKey = 0;
  private generation = 0;
  private instances: Record<DesktopTarget, string | null> = { code: null, personal: null };
  constructor(readonly changed: () => void) {}
  get message(): string {
    if (!this.blockedNavigation) return "";
    return this.form?.phase === "saving" ? "正在保存，请等待完成。" : this.form?.phase === "unknown" ? "原配置的保存结果待核实，请先核实结果。" : "";
  }
  show(target: DesktopTarget, code: CodeState, category?: SettingsCategory): void {
    if (!this.open) {
      this.instances.code = code.view.instanceId;
      const current = code.view.sessions.find(session => target === "code" && session.id === code.view.currentSessionId && session.kind === "dev" && !code.view.subAgentSessionIds.includes(session.id) && !code.view.roleSessionIds.includes(session.id));
      const workspace = code.view.projects.find(project => project.rootDir !== null && project.id === (current?.workspaceProjectId ?? current?.projectId)) ?? code.view.projects.find(project => project.rootDir !== null);
      for (const item of Object.values(this.selections)) { item.target = target; item.workspaceId = workspace?.id ?? null; item.sourceId = current && workspace?.id === (current.workspaceProjectId ?? current.projectId) ? current.projectId : workspace?.id ?? null; }
      this.open = true;
      ++this.generation;
    }
    if (category) this.navigate(() => { this.category = category; });
    this.changed();
  }
  scope(code: CodeState, personal: CodeState, sources?: SettingsSources): SettingsScope {
    const selection = this.selections[this.category as ManagedSettingsCategory] ?? this.selections.models;
    const mcp = this.category === "mcp" && selection.target === "code";
    const instanceId = (selection.target === "code" ? code : personal).view.instanceId;
    const sourceValid = !sources || sources.instanceId === instanceId && sources.workspaceId === selection.workspaceId && sources.items.some(source => source.id === selection.sourceId);
    return { target: selection.target, instanceId, workspaceId: mcp ? selection.workspaceId : null, sourceId: mcp && sourceValid ? selection.sourceId : null };
  }
  ticket(): number { return this.generation; }
  accepts(ticket: number): boolean { return this.open && ticket === this.generation; }
  private invalidate(): void { ++this.generation; this.form?.invalidate(); }
  observe(target: DesktopTarget, update: DesktopUpdate): void {
    if (update.type === "snapshot") {
      const instanceId = update.result.snapshot.instanceId;
      const changed = update.instanceChanged || (this.instances[target] !== null && this.instances[target] !== instanceId);
      this.instances[target] = instanceId;
      if (changed && target === "code") { this.selections.mcp.workspaceId = null; this.selections.mcp.sourceId = null; }
    }
    if (target === "personal" || !this.open || !["models", "skills", "mcp"].includes(this.category) || this.selections[this.category as ManagedSettingsCategory].target !== target) return;
    if (update.type !== "snapshot" && !(update.type === "state" && update.state !== "online")) return;
    this.invalidate();
    this.changed();
  }
  /** 仅保存 UI 导航续步；配置请求仍由具体页面发起。 */
  navigate(action: () => void): boolean {
    if (this.form?.phase === "saving" || this.form?.phase === "unknown") {
      this.blockedNavigation = true;
      this.changed(); return false;
    }
    if (this.form?.dirty) { this.leave = action; this.changed(); return false; }
    this.finish(action); return true;
  }
  private finish(action: () => void): void {
    this.invalidate(); ++this.pageKey; this.form = null; this.leave = null; this.blockedNavigation = false;
    action(); this.changed();
  }
  chooseCategory(category: SettingsCategory): void { if (category !== this.category) this.navigate(() => { this.category = category; }); }
  chooseTarget(category: ManagedSettingsCategory, target: DesktopTarget): void { if (this.selections[category].target !== target) this.navigate(() => { this.selections[category].target = target; }); }
  chooseWorkspace(id: string): void { if (id !== this.selections.mcp.workspaceId) this.navigate(() => { this.selections.mcp.workspaceId = id; this.selections.mcp.sourceId = id; }); }
  chooseSource(id: string): void { if (id !== this.selections.mcp.sourceId) this.navigate(() => { this.selections.mcp.sourceId = id; }); }
  close(after?: () => void): boolean { return this.navigate(() => { this.open = false; after?.(); }); }
  continueEditing(): void { this.leave = null; this.changed(); }
  discardAndLeave(): void {
    if (!this.leave || this.form?.phase === "saving" || this.form?.phase === "unknown") return;
    this.form?.discard(); this.finish(this.leave);
  }
  async saveAndLeave(): Promise<void> {
    const action = this.leave, form = this.form;
    if (!action || !form || form.phase === "saving" || form.phase === "unknown") return;
    if (await (form.saveAndContinue?.() ?? form.save()) && this.form === form && this.leave === action) this.finish(action);
  }
}
