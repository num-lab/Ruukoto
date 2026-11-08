import type { PersonalTargetConfig } from "../main/personal-config.ts";
import type { DesktopBridge, DesktopResult } from "../shared/bridge.ts";
import type { SettingsForm, SettingsPhase } from "./settings-state.ts";
import type { PersonalState } from "./personal-state.ts";

const emptyConfig = (): PersonalTargetConfig => ({ v: 1, origin: "" });
const equal = (a: PersonalTargetConfig, b: PersonalTargetConfig) => a.origin === b.origin;
export type PersonalPermissionMode = "confirm" | "auto-review" | "full_access";
type PermissionScope = "default" | "qq";
type Permissions = Record<PermissionScope, { mode: PersonalPermissionMode }>;
const permissionMode = (value: unknown): value is PersonalPermissionMode => value === "confirm" || value === "auto-review" || value === "full_access";

// Note: See .agents/notes/implemented/architecture/2026-10-24-personal-tailscale-https.md
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
  permissions: Permissions | null = null;
  permissionsReading = false;
  permissionsMessage = "";
  permissionConfirmation: PermissionScope | null = null;
  private permissionsConnection: PersonalTargetConfig | null = null;
  private baseline = emptyConfig();
  private generation = 0;
  constructor(private readonly bridge: Pick<DesktopBridge, "request">, readonly changed: () => void) {}
  get dirty() { return this.loaded && !equal(this.draft, this.baseline); }
  get disabled() { return !this.loaded || this.reading || this.permissionsReading || this.phase === "saving" || this.phase === "unknown"; }
  get permissionsDisabled() { return this.disabled || this.dirty || !this.permissions || !this.current?.binding; }
  get confirming() { return this.permissionConfirmation !== null; }
  connectionStatus(personal: Pick<PersonalState, "status" | "identity">): "loading" | "connecting" | "connected" | "unpaired" | "error" {
    if (this.reading || this.phase === "loading" || this.phase === "saving") return "loading";
    if (!this.loaded) return "error";
    if (this.phase === "unknown") return "loading";
    const binding = this.current?.binding;
    if (!binding) return "unpaired";
    if (personal.status.state === "connecting" || personal.status.state === "reconnecting") return "connecting";
    const identity = personal.identity;
    return personal.status.state === "online" && identity?.online && identity.origin === this.current?.origin && identity.remoteId === binding.remoteId && identity.profile.id === binding.profile.id && identity.profile.directory === binding.profile.directory ? "connected" : "error";
  }
  edit(_key: "origin", value: string) { if (this.disabled) return; this.draft = { v: 1, origin: value }; this.code = ""; this.message = ""; this.fieldErrors = {}; this.changed(); }
  discard() { this.draft = { ...this.baseline }; this.fieldErrors = {}; this.changed(); }
  invalidate() { ++this.generation; this.reading = false; this.permissionsReading = false; this.permissions = null; this.permissionsConnection = null; this.permissionConfirmation = null; this.code = ""; if (this.phase === "saving") { this.phase = "unknown"; this.message = "The original operation outcome is unverified; read the connection or verify the original pairing."; } }
  private async request<T>(op: string, params: Record<string, unknown>): Promise<DesktopResult<T>> {
    try { return await this.bridge.request("personal", op, params) as DesktopResult<T>; }
    catch { return { ok: false, error: { code: "bridge_unavailable", outcome: "unknown", message: "The host response was lost; verify the original operation. It won't be resent automatically." } }; }
  }
  async read() {
    if (this.reading || this.permissionsReading || this.phase === "saving") return;
    const generation = ++this.generation; this.reading = true; this.changed();
    this.permissions = null; this.permissionsConnection = null; this.permissionConfirmation = null;
    const result = await this.request<PersonalTargetConfig | null>("desktop_personal_config_read", {});
    if (generation !== this.generation) return;
    this.reading = false;
    if (!result.ok) { this.phase = this.pending ? "unknown" : "error"; this.message = result.error.message; this.changed(); return; }
    const config = result.value ?? emptyConfig();
    this.current = result.value; this.baseline = { ...config }; this.loaded = true;
    if (this.pending && !equal(config, this.pending)) { this.phase = "conflict"; this.message = "The current address differs from the original submission; the original draft is kept."; }
    else { this.draft = { ...config }; this.phase = "ready"; this.message = config.binding ? "This desktop is paired." : config.origin ? "Address saved. Complete the connection via the short-lived pairing the server opens." : ""; }
    this.pending = null;
    const legacy = await this.request<{ paths: string[] }>("desktop_personal_legacy_read", {});
    if (generation !== this.generation) return;
    if (legacy.ok) this.legacy = legacy.value.paths; else this.message = legacy.error.message;
    this.changed();
    if (this.current?.binding && !this.dirty) await this.readPermissions();
  }
  // Note: See .agents/notes/implemented/feature/2026-11-05-personal-setup-presets.md
  async readPermissions(): Promise<void> {
    if (!this.current?.binding || this.dirty || this.reading || this.permissionsReading || this.phase === "saving") return;
    const generation = this.generation, connection = structuredClone(this.current);
    this.permissions = null; this.permissionConfirmation = null; this.permissionsReading = true; this.changed();
    const result = await this.request<Permissions>("desktop_personal_request", { method: "GET", path: "/permissions", connection });
    if (generation !== this.generation) return;
    this.permissionsReading = false;
    if (!result.ok) { this.permissionsMessage = result.error.message; this.changed(); return; }
    if (!permissionMode(result.value?.default?.mode) || !permissionMode(result.value?.qq?.mode)) { this.permissionsMessage = "Default permissions unverified; read them again."; this.changed(); return; }
    this.permissions = result.value; this.permissionsConnection = connection; this.permissionsMessage = ""; this.changed();
  }
  async selectPermission(scope: PermissionScope, mode: PersonalPermissionMode): Promise<void> {
    if (this.permissionsDisabled || !permissionMode(mode) || this.permissions![scope].mode === mode) return;
    if (mode === "full_access") { this.permissionConfirmation = scope; this.changed(); return; }
    await this.savePermission(scope, mode);
  }
  cancelPermission(): void { this.permissionConfirmation = null; this.changed(); }
  async confirmPermission(): Promise<void> { const scope = this.permissionConfirmation; this.permissionConfirmation = null; if (scope) await this.savePermission(scope, "full_access"); }
  private async savePermission(scope: PermissionScope, mode: PersonalPermissionMode): Promise<void> {
    if (this.permissionsDisabled || !this.permissionsConnection) return;
    const generation = this.generation, connection = structuredClone(this.permissionsConnection);
    this.permissionsReading = true; this.permissionsMessage = "Verifying default permissions…"; this.changed();
    const result = await this.request("desktop_personal_request", { method: "POST", path: "/permissions", body: { mode, ...(scope === "qq" ? { scope } : {}) }, connection });
    if (generation !== this.generation) return;
    this.permissionsReading = false; this.permissions = null;
    this.permissionsMessage = result.ok ? "" : result.error.message;
    await this.readPermissions();
  }
  async save() {
    if (this.disabled || !this.dirty) return false;
    let origin: string;
    try { const url = new URL(this.draft.origin); if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("invalid_origin"); origin = url.origin; }
    catch { this.fieldErrors = { origin: "Enter a complete HTTPS address with a host and optional port." }; this.changed(); return false; }
    const generation = this.generation; this.pending = { v: 1, origin }; this.phase = "saving"; this.changed();
    const result = await this.request<PersonalTargetConfig>("desktop_personal_config_save", { origin });
    if (generation !== this.generation) return false;
    if (!result.ok) { const uncertain = result.error.outcome === "unknown" || result.error.outcome === "disconnected"; this.phase = uncertain ? "unknown" : "error"; if (!uncertain) this.pending = null; this.message = result.error.message; this.changed(); return false; }
    this.current = result.value; this.baseline = { ...result.value }; this.draft = { ...result.value }; this.pending = null; this.phase = "ready"; this.message = "Address saved. Pair or check the current connection state."; this.changed(); return true;
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
