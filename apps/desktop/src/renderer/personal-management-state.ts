import type { PersonalManagementConfig } from "../main/personal-config.ts";
import type { PersonalManagementView } from "../shared/personal-settings.ts";
import type { DesktopBridge, DesktopResult } from "../shared/bridge.ts";
import type { SettingsForm, SettingsPhase } from "./settings-state.ts";

const defaults = (): PersonalManagementConfig => ({ host: "", profileDir: "/var/lib/ruukoto/personal-durable", program: "/opt/ruukoto/apps/ruukoto/bin/ruukoto.mjs", lifecycle: "systemd" });
const equal = (a: PersonalManagementConfig, b: PersonalManagementConfig) => JSON.stringify(a) === JSON.stringify(b);

// Note: 见 .agents/notes/implemented/feature/2026-10-21-personal-settings-ssh.md
export class PersonalManagementState implements SettingsForm {
  draft = defaults();
  private baseline = defaults();
  phase: SettingsPhase = "loading";
  loaded = false;
  message = "";
  view: PersonalManagementView | null = null;
  programs: string[] = [];
  fieldErrors: Partial<Record<keyof PersonalManagementConfig, string>> = {};
  private generation = 0;
  private submitted: PersonalManagementConfig | null = null;
  constructor(private readonly bridge: Pick<DesktopBridge, "request">, readonly changed: () => void) {}
  get dirty(): boolean { return this.loaded && !equal(this.draft, this.baseline); }
  get disabled(): boolean { return !this.loaded || this.phase === "saving" || this.phase === "unknown"; }
  edit(key: keyof PersonalManagementConfig, value: string): void {
    if (this.disabled) return;
    this.draft = { ...this.draft, [key]: value }; this.view = null; this.programs = []; this.message = ""; delete this.fieldErrors[key]; this.changed();
  }
  discard(): void { this.draft = { ...this.baseline }; this.view = null; this.changed(); }
  invalidate(): void {
    ++this.generation;
    if (this.phase === "saving") { this.phase = "unknown"; this.message = "操作结果待核实，请读取原管理连接与维护记录。"; }
  }
  private async request(op: string, params: Record<string, unknown>): Promise<DesktopResult<unknown>> {
    try { return await this.bridge.request("personal", op, params); }
    catch { return { ok: false, error: { code: "bridge_unavailable", outcome: "unknown", message: "宿主应答丢失，请查询原连接与服务状态；不会自动重发。" } }; }
  }
  async read(): Promise<void> {
    if (this.phase === "saving") return;
    const generation = ++this.generation;
    const result = await this.request("desktop_personal_management_config_read", {});
    if (generation !== this.generation) return;
    if (!result.ok) { this.phase = this.submitted ? "unknown" : "error"; this.message = result.error.message; this.changed(); return; }
    const config = result.value as PersonalManagementConfig | null;
    this.baseline = config ?? defaults(); this.loaded = true;
    if (this.submitted && !equal(this.submitted, this.baseline)) { this.phase = "conflict"; this.message = "本机管理连接与原提交不同，已保留草稿，请比较后继续编辑。"; }
    else { this.draft = { ...this.baseline }; this.phase = "ready"; this.message = this.submitted ? "已读回本机连接配置，请检测原档案与维护记录。" : ""; }
    this.submitted = null; this.changed();
  }
  private validate(): boolean {
    this.fieldErrors = {};
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(this.draft.host)) this.fieldErrors.host = "请输入本机 SSH 主机别名。";
    if (!this.draft.profileDir.startsWith("/") || /[:\x00-\x1f\x7f]/.test(this.draft.profileDir)) this.fieldErrors.profileDir = "请输入远端档案的绝对路径。";
    if (Object.keys(this.fieldErrors).length) { this.message = "请修正标记字段。"; this.changed(); return false; }
    return true;
  }
  async save(): Promise<boolean> {
    if (this.disabled || !this.dirty || !this.validate()) return false;
    const generation = this.generation;
    this.submitted = { ...this.draft }; this.phase = "saving"; this.view = null; this.changed();
    const result = await this.request("desktop_personal_management_config_save", { ...this.submitted });
    if (generation !== this.generation) return false;
    if (!result.ok) {
      this.phase = result.error.outcome === "unknown" || result.error.outcome === "disconnected" ? "unknown" : "error";
      if (this.phase !== "unknown") this.submitted = null;
      const field = result.error.code === "invalid_ssh_host" ? "host" : result.error.code === "invalid_profile_dir" || result.error.code === "socket_path_too_long" ? "profileDir" : result.error.code === "invalid_personal_program" ? "program" : result.error.code === "invalid_lifecycle" ? "lifecycle" : null;
      if (field) this.fieldErrors[field] = result.error.message;
      this.message = result.error.message; this.changed(); return false;
    }
    this.baseline = result.value as PersonalManagementConfig; this.draft = { ...this.baseline }; this.submitted = null;
    this.phase = "ready"; this.message = "管理连接已保存在本机，请检测远端；保存连接不代表配置可写。"; this.changed(); return true;
  }
  async detect(): Promise<void> {
    if (this.disabled || !this.validate()) return;
    const generation = this.generation; this.phase = "saving"; this.message = "正在检测受支持的新 Personal 程序…"; this.changed();
    const result = await this.request("desktop_personal_management_detect", { ...this.draft });
    if (generation !== this.generation) return;
    this.phase = "ready";
    this.programs = result.ok ? result.value as string[] : [];
    this.message = result.ok ? this.programs.length ? "请选择检测到的程序位置并保存连接，再检查档案与服务。" : "未找到新 Personal 设置程序，请核实 SSH 与档案并先升级安装。" : result.error.message;
    this.changed();
  }
  async inspect(action: "read" | "restore" | "finish" = "read"): Promise<void> {
    if (!this.loaded || this.dirty || this.phase === "saving") return;
    const generation = this.generation; this.phase = "saving"; this.message = action === "restore" ? "正在恢复原服务，不重发保存…" : "正在核实原档案与服务…"; this.changed();
    const result = await this.request(`desktop_personal_settings_${action}`, {});
    if (generation !== this.generation) return;
    if (!result.ok) { this.phase = action === "read" ? "error" : "unknown"; this.message = result.error.message; }
    else { this.view = result.value as PersonalManagementView; this.phase = "ready"; this.message = this.view.message; }
    this.changed();
  }
}
