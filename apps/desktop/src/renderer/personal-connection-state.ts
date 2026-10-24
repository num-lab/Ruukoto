import type { PersonalTargetConfig } from "../main/personal-config.ts";
import type { DesktopBridge, DesktopResult } from "../shared/bridge.ts";
import type { SettingsForm, SettingsPhase } from "./settings-state.ts";

const emptyConfig = (): PersonalTargetConfig => ({ v: 1, origin: "" });
const equal = (a: PersonalTargetConfig, b: PersonalTargetConfig) => a.origin === b.origin;

// Note: 见 .agents/notes/implemented/architecture/2026-10-24-personal-tailscale-https.md
export class PersonalConnectionState implements SettingsForm {
  draft = emptyConfig();
  current: PersonalTargetConfig | null = null;
  phase: SettingsPhase = "loading";
  reading = false;
  loaded = false;
  message = "";
  code = "";
  label = "";
  legacy: string[] = [];
  fieldErrors: { origin?: string } = {};
  pending: PersonalTargetConfig | null = null;
  private baseline = emptyConfig();
  private generation = 0;
  constructor(private readonly bridge: Pick<DesktopBridge, "request">, readonly changed: () => void) {}
  get dirty() { return this.loaded && !equal(this.draft, this.baseline); }
  get disabled() { return !this.loaded || this.reading || this.phase === "saving" || this.phase === "unknown"; }
  edit(_key: "origin", value: string) { if (this.disabled) return; this.draft = { v: 1, origin: value }; this.code = ""; this.message = ""; this.fieldErrors = {}; this.changed(); }
  discard() { this.draft = { ...this.baseline }; this.fieldErrors = {}; this.changed(); }
  invalidate() { ++this.generation; this.reading = false; this.code = ""; if (this.phase === "saving") { this.phase = "unknown"; this.message = "原操作结果待核实，请读取连接或核实原配对。"; } }
  private async request<T>(op: string, params: Record<string, unknown>): Promise<DesktopResult<T>> {
    try { return await this.bridge.request("personal", op, params) as DesktopResult<T>; }
    catch { return { ok: false, error: { code: "bridge_unavailable", outcome: "unknown", message: "宿主应答丢失，请核实原操作；不会自动重发。" } }; }
  }
  async read() {
    if (this.reading || this.phase === "saving") return;
    const generation = ++this.generation; this.reading = true; this.changed();
    const result = await this.request<PersonalTargetConfig | null>("desktop_personal_config_read", {});
    if (generation !== this.generation) return;
    this.reading = false;
    if (!result.ok) { this.phase = this.pending ? "unknown" : "error"; this.message = result.error.message; this.changed(); return; }
    const config = result.value ?? emptyConfig();
    this.current = result.value; this.baseline = { ...config }; this.loaded = true;
    if (this.pending && !equal(config, this.pending)) { this.phase = "conflict"; this.message = "当前地址与原提交不同，原草稿已保留。"; }
    else { this.draft = { ...config }; this.phase = "ready"; this.message = config.binding ? "此桌面已配对。" : config.origin ? "地址已保存，请通过服务器开启的短时配对完成连接。" : ""; }
    this.pending = null;
    const legacy = await this.request<{ paths: string[] }>("desktop_personal_legacy_read", {});
    if (generation !== this.generation) return;
    if (legacy.ok) this.legacy = legacy.value.paths; else this.message = legacy.error.message;
    this.changed();
  }
  async save() {
    if (this.disabled || !this.dirty) return false;
    let origin: string;
    try { const url = new URL(this.draft.origin); if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("invalid_origin"); origin = url.origin; }
    catch { this.fieldErrors = { origin: "请输入仅含主机与可选端口的完整 HTTPS 地址。" }; this.changed(); return false; }
    const generation = this.generation; this.pending = { v: 1, origin }; this.phase = "saving"; this.changed();
    const result = await this.request<PersonalTargetConfig>("desktop_personal_config_save", { origin });
    if (generation !== this.generation) return false;
    if (!result.ok) { const uncertain = result.error.outcome === "unknown" || result.error.outcome === "disconnected"; this.phase = uncertain ? "unknown" : "error"; if (!uncertain) this.pending = null; this.message = result.error.message; this.changed(); return false; }
    this.current = result.value; this.baseline = { ...result.value }; this.draft = { ...result.value }; this.pending = null; this.phase = "ready"; this.message = "地址已保存，请配对或查看当前连接状态。"; this.changed(); return true;
  }
  async pair(mode: "pair" | "reconcile" | "restore" = "pair") {
    if (!this.current?.origin || this.dirty || this.phase === "saving" || mode === "pair" && (!this.code.trim() || !this.label.trim())) return;
    const generation = this.generation, code = this.code, label = this.label; this.code = ""; this.phase = "saving"; this.changed();
    const op = mode === "pair" ? "desktop_personal_pair" : mode === "restore" ? "desktop_personal_pair_restore" : "desktop_personal_pair_reconcile";
    const result = await this.request(op, mode === "pair" ? { code, label } : {});
    if (generation !== this.generation) return;
    if (!result.ok) { this.phase = result.error.outcome === "unknown" || result.error.outcome === "disconnected" ? "unknown" : "error"; this.message = result.error.message; this.changed(); return; }
    this.phase = "ready"; await this.read();
  }
  async acknowledgeLegacy() {
    const generation = this.generation, result = await this.request("desktop_personal_legacy_acknowledge", { verified: true });
    if (generation !== this.generation) return;
    if (result.ok) await this.read(); else { this.message = result.error.message; this.changed(); }
  }
}
