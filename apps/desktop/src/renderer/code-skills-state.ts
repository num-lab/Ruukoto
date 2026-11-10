import type { OpResult } from "@ruukoto/control/ops.ts";
import type { DesktopBridge, DesktopResult } from "../shared/bridge.ts";
import type { SettingsForm, SettingsPhase } from "./settings-state.ts";

type Skill = OpResult<"skills_list">["skills"][number];
type Detail = OpResult<"skill_get">;

// Note: See .agents/notes/implemented/feature/2026-10-21-desktop-code-skills.md
// Note: See .agents/notes/implemented/simplification/2026-10-28-home-skills-discovery.md
export class CodeSkillsState implements SettingsForm {
  phase: SettingsPhase = "loading";
  reading = false;
  message = "";
  query = "";
  skills: Skill[] = [];
  diagnostics: string[] = [];
  diagnosticsTruncated = false;
  hasMore = false;
  revision = "";
  selectedId: string | null = null;
  detail: Detail | null = null;
  private generation = 0;
  constructor(private readonly bridge: Pick<DesktopBridge, "request">, readonly changed: () => void, readonly instanceId: string, private readonly context: () => { instanceId: string | null; online: boolean }) {}
  get dirty(): boolean { return false; }
  get connected(): boolean { const current = this.context(); return current.online && current.instanceId === this.instanceId; }
  get disabled(): boolean { return !this.connected || this.reading || this.phase === "loading"; }
  get filtered(): Skill[] { const query = this.query.trim().toLocaleLowerCase(); return this.skills.filter(skill => skill.name.toLocaleLowerCase().includes(query)); }
  get selected(): Skill | null { return this.skills.find(skill => skill.id === this.selectedId) ?? (this.detail?.id === this.selectedId ? this.detail : null); }
  private accepts(generation: number): boolean { return generation === this.generation && this.connected; }
  private async request<T>(op: string, params: Record<string, unknown>): Promise<DesktopResult<T>> {
    try { return await this.bridge.request("code", op, params) as DesktopResult<T>; }
    catch { return { ok: false, error: { code: "bridge_unavailable", outcome: "unknown", message: "No host response. Restore the original ruukoto connection and read again." } }; }
  }
  invalidate(): void { ++this.generation; this.reading = false; }
  discard(): void { this.message = ""; this.changed(); }
  async save(): Promise<boolean> { return false; }
  async read(more = false): Promise<boolean> {
    if (!this.connected || this.reading) { this.message = "Restore the original ruukoto instance before reading skills."; this.changed(); return false; }
    const generation = ++this.generation;
    this.reading = true; this.changed();
    const result = await this.request<OpResult<"skills_list">>("skills_list", { offset: more ? this.skills.length : 0, limit: 50 });
    if (!this.accepts(generation)) return false;
    if (!result.ok) { this.reading = false; this.phase = "error"; this.message = result.error.message + " Read the original instance again."; this.changed(); return false; }
    if (more && result.value.revision !== this.revision) { this.reading = false; this.phase = "conflict"; this.message = "The skills catalog changed; read again. The fetched list is kept."; this.changed(); return false; }
    this.skills = more ? [...this.skills, ...result.value.skills] : result.value.skills;
    this.revision = result.value.revision; this.hasMore = result.value.hasMore;
    this.diagnostics = result.value.diagnostics; this.diagnosticsTruncated = result.value.diagnosticsTruncated;
    if (this.selectedId && !more) {
      const detail = await this.request<Detail>("skill_get", { skill_id: this.selectedId });
      if (!this.accepts(generation)) return false;
      if (!detail.ok && detail.error.code !== "skill_not_found") { this.reading = false; this.phase = "error"; this.message = detail.error.message + " Read the original skill again."; this.changed(); return false; }
      this.detail = detail.ok ? detail.value : null;
    }
    this.reading = false; this.phase = "ready"; this.message = "";
    this.changed(); return true;
  }
  async select(id: string): Promise<void> {
    if (this.disabled) return;
    const generation = ++this.generation;
    this.selectedId = id; this.detail = null; this.reading = true; this.changed();
    const result = await this.request<Detail>("skill_get", { skill_id: id });
    if (!this.accepts(generation)) return;
    this.reading = false;
    if (result.ok) this.detail = result.value;
    else { this.phase = "error"; this.message = result.error.message + " Read the skills list again."; }
    this.changed();
  }
}
