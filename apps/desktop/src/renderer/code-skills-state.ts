import type { OpResult } from "@ruukoto/control/ops.ts";
import type { DesktopBridge, DesktopResult, DesktopSkillPreview } from "../shared/bridge.ts";
import type { SettingsForm, SettingsPhase } from "./settings-state.ts";

type Skill = OpResult<"skills_list">["skills"][number];
type Detail = OpResult<"skill_get">;
type Write = "desktop_skill_import" | "skill_set_enabled" | "skill_remove";

// Note: 见 .agents/notes/implemented/feature/2026-10-21-desktop-code-skills.md
export class CodeSkillsState implements SettingsForm {
  phase: SettingsPhase = "loading";
  reading = false;
  choosing = false;
  message = "";
  query = "";
  skills: Skill[] = [];
  diagnostics: string[] = [];
  diagnosticsTruncated = false;
  hasMore = false;
  revision = "";
  selectedId: string | null = null;
  detail: Detail | null = null;
  preview: DesktopSkillPreview | null = null;
  previewStale = false;
  pending: { op: Write; id: string; enabled?: boolean } | null = null;
  private generation = 0;
  constructor(private readonly bridge: Pick<DesktopBridge, "request" | "pickSkillFolder">, readonly changed: () => void, readonly instanceId: string, private readonly context: () => { instanceId: string | null; online: boolean }) {}
  get dirty(): boolean { return this.preview !== null; }
  get connected(): boolean { const current = this.context(); return current.online && current.instanceId === this.instanceId; }
  get disabled(): boolean { return !this.connected || this.reading || this.choosing || this.phase === "loading" || this.phase === "saving" || this.phase === "unknown"; }
  get filtered(): Skill[] { const query = this.query.trim().toLocaleLowerCase(); return this.skills.filter(skill => skill.name.toLocaleLowerCase().includes(query)); }
  get selected(): Skill | null { return this.skills.find(skill => skill.id === this.selectedId) ?? (this.detail?.id === this.selectedId && this.detail.state !== "removed" ? this.detail : null); }
  private accepts(generation: number): boolean { return generation === this.generation && this.connected; }
  private async request<T>(op: string, params: Record<string, unknown>): Promise<DesktopResult<T>> {
    try { return await this.bridge.request("code", op, params) as DesktopResult<T>; }
    catch { return { ok: false, error: { code: "bridge_unavailable", outcome: "unknown", message: "未取得宿主应答，请恢复原 Code 连接后核实结果。" } }; }
  }
  invalidate(): void {
    ++this.generation; this.reading = false; this.choosing = false;
    if (this.preview) this.previewStale = true;
    if (this.pending) { this.phase = "unknown"; this.message = "原 Code 实例的操作结果待核实，请恢复原实例后读回。"; }
  }
  discard(): void { if (this.pending) return; this.preview = null; this.previewStale = false; this.message = ""; if (this.phase === "conflict") this.phase = "ready"; this.changed(); }
  async read(more = false): Promise<boolean> {
    if (!this.connected || this.reading || this.choosing || this.phase === "saving") { this.message = "请恢复原 Code 实例后读取技能。"; this.changed(); return false; }
    const generation = ++this.generation;
    this.reading = true; this.changed();
    const result = await this.request<OpResult<"skills_list">>("skills_list", { offset: more ? this.skills.length : 0, limit: 50 });
    if (!this.accepts(generation)) return false;
    if (!result.ok) { this.reading = false; this.phase = this.pending ? "unknown" : "error"; this.message = result.error.message + " 请重新读取原实例。"; this.changed(); return false; }
    if (more && result.value.revision !== this.revision) { this.reading = false; this.phase = "conflict"; this.message = "技能清单已变化，已取得列表与选择仍保留。请重新读取后比较。"; this.changed(); return false; }
    this.skills = more ? [...this.skills, ...result.value.skills] : result.value.skills;
    this.revision = result.value.revision; this.hasMore = result.value.hasMore;
    this.diagnostics = result.value.diagnostics; this.diagnosticsTruncated = result.value.diagnosticsTruncated;
    const pending = this.pending;
    const id = pending?.id ?? this.selectedId;
    if (id && !more) {
      const detail = await this.request<Detail>("skill_get", { skill_id: id });
      if (!this.accepts(generation)) return false;
      if (!detail.ok && detail.error.code !== "skill_not_found") { this.reading = false; this.phase = pending ? "unknown" : "error"; this.message = detail.error.message + " 请重新读回原技能。"; this.changed(); return false; }
      if (pending) {
        const applied = detail.ok && (pending.op === "desktop_skill_import" ? detail.value.contentRevision === this.preview?.contentRevision : pending.op === "skill_remove" ? detail.value.state === "removed" : detail.value.state === (pending.enabled ? "enabled" : "disabled"));
        this.message = applied ? "已读回原技能，操作已生效；没有重发。" : "已读回原实例，当前状态未显示原操作生效。请比较后重新选择操作；不会自动重发。";
        if (pending.op === "desktop_skill_import") { if (applied) this.preview = null; else this.previewStale = true; }
        this.pending = null;
        this.selectedId = id;
      }
      this.detail = detail.ok ? detail.value : null;
    }
    this.reading = false;
    this.phase = this.preview && (this.previewStale || this.preview.revision !== this.revision) ? "conflict" : "ready";
    if (this.phase === "conflict") this.message = "原导入预览与选择已保留。请比较当前清单；确认后重新选择目录生成新预览。";
    this.changed(); return true;
  }
  async select(id: string): Promise<void> {
    if (this.disabled || this.dirty) return;
    const generation = ++this.generation;
    this.selectedId = id; this.detail = null; this.reading = true; this.changed();
    const result = await this.request<Detail>("skill_get", { skill_id: id });
    if (!this.accepts(generation)) return;
    this.reading = false;
    if (result.ok) this.detail = result.value;
    else { this.phase = "error"; this.message = result.error.message + " 请重新读取技能列表。"; }
    this.changed();
  }
  async choose(): Promise<void> {
    if (this.disabled) return;
    const generation = ++this.generation;
    this.choosing = true; if (this.preview) this.previewStale = true; this.changed();
    let result: DesktopResult<DesktopSkillPreview | null>;
    try { result = await this.bridge.pickSkillFolder("code", this.instanceId); }
    catch { result = { ok: false, error: { code: "bridge_unavailable", outcome: "not_sent", message: "未取得目录预览，尚未提交导入。请恢复宿主后重新选择。" } }; }
    if (!this.accepts(generation)) return;
    this.choosing = false;
    if (result.ok && result.value) { this.preview = result.value; this.previewStale = false; this.phase = "ready"; this.message = "请核对技能名称、诊断与冲突后确认导入。"; }
    else if (!result.ok) { this.phase = "error"; this.message = result.error.message; }
    else if (this.preview) { this.phase = "conflict"; this.message = "已取消重新选择，旧预览仅供比较。请重新选择目录后确认导入。"; }
    this.changed();
  }
  async save(): Promise<boolean> {
    if (this.disabled || !this.preview || this.previewStale || this.preview.conflicts.length) return false;
    return this.write("desktop_skill_import", this.preview.id, { selection_id: this.preview.id });
  }
  async setEnabled(enabled: boolean): Promise<boolean> {
    if (this.disabled || this.dirty || !this.selected || this.selected.readOnly) return false;
    return this.write("skill_set_enabled", this.selected.id, { skill_id: this.selected.id, enabled, expected_revision: this.revision }, enabled);
  }
  async remove(): Promise<boolean> {
    if (this.disabled || this.dirty || !this.selected || this.selected.readOnly) return false;
    return this.write("skill_remove", this.selected.id, { skill_id: this.selected.id, expected_revision: this.revision });
  }
  private async write(op: Write, id: string, params: Record<string, unknown>, enabled?: boolean): Promise<boolean> {
    const generation = ++this.generation;
    this.pending = { op, id, enabled }; this.phase = "saving"; this.message = "正在保存…"; this.changed();
    const result = await this.request<Detail>(op, params);
    if (!this.accepts(generation)) return false;
    if (!result.ok) {
      const unknown = result.error.outcome === "unknown" || result.error.outcome === "disconnected";
      this.phase = unknown ? "unknown" : ["skills_revision_conflict", "skills_name_conflict"].includes(result.error.code) ? "conflict" : "error";
      if (!unknown) { this.pending = null; if (op === "desktop_skill_import") this.previewStale = true; }
      this.message = unknown ? "操作结果待核实。请读回原技能，不要再次导入或提交。" : `${result.error.outcome === "not_sent" ? "请求未送出。" : "操作被拒绝。"}${result.error.message}`;
      this.changed(); return false;
    }
    this.selectedId = id; this.detail = result.value; this.revision = result.value.revision;
    if (op === "desktop_skill_import") this.preview = null;
    this.pending = null; this.phase = "ready";
    const read = await this.read();
    this.message = read ? "已保存并读回技能。" : "后台已应答保存成功，列表读取失败，请重新读取。";
    this.changed(); return true;
  }
}
