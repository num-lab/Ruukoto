import type { PersonalTargetConfig } from "../main/personal-config.ts";
import type { DesktopBridge, DesktopResult } from "../shared/bridge.ts";
import type { SettingsForm, SettingsPhase } from "./settings-state.ts";

const emptyConfig = (): PersonalTargetConfig => ({ host: "", controlDir: "/var/lib/ruukoto/control" });
const equal = (a: PersonalTargetConfig, b: PersonalTargetConfig) => a.host === b.host && a.controlDir === b.controlDir;

// Note: 见 .agents/notes/implemented/feature/2026-10-21-desktop-settings-shell.md
export class PersonalConnectionState implements SettingsForm {
  draft = emptyConfig();
  current: PersonalTargetConfig | null = null;
  phase: SettingsPhase = "loading";
  reading = false;
  loaded = false;
  message = "";
  fieldErrors: Partial<Record<keyof PersonalTargetConfig, string>> = {};
  pending: { target: "personal"; op: "desktop_personal_config_save"; config: PersonalTargetConfig } | null = null;
  private baseline = emptyConfig();
  private generation = 0;
  constructor(private readonly bridge: Pick<DesktopBridge, "request">, readonly changed: () => void) {}
  get dirty(): boolean { return this.loaded && !equal(this.draft, this.baseline); }
  get disabled(): boolean { return !this.loaded || this.reading || this.phase === "saving" || this.phase === "unknown"; }
  edit(key: keyof PersonalTargetConfig, value: string): void {
    if (this.disabled) return;
    this.draft = { ...this.draft, [key]: value }; this.message = ""; delete this.fieldErrors[key]; this.changed();
  }
  discard(): void { this.draft = { ...this.baseline }; this.current = null; this.fieldErrors = {}; this.changed(); }
  invalidate(): void {
    ++this.generation; this.reading = false;
    if (this.phase === "saving") { this.phase = "unknown"; this.message = "保存结果待核实，请重新读取原连接配置。"; }
  }
  private async request(op: string, params: Record<string, unknown>): Promise<DesktopResult<unknown>> {
    try { return await this.bridge.request("personal", op, params); }
    catch { return { ok: false, error: { code: "bridge_unavailable", outcome: "unknown", message: "无法取得宿主应答，请重新读取连接配置。" } }; }
  }
  async read(): Promise<void> {
    if (this.reading || this.phase === "saving") return;
    const generation = ++this.generation;
    this.reading = true; this.changed();
    const result = await this.request("desktop_personal_config_read", {});
    if (generation !== this.generation) return;
    this.reading = false;
    if (!result.ok) {
      this.phase = this.pending ? "unknown" : "error";
      this.message = `${result.error.message}${this.pending ? " 原保存结果仍待核实，请再次读取。" : " 请重新读取。"}`; this.changed(); return;
    }
    // 宿主本地配置的 IPC 响应；版本化远程配置由各管理页面持有。
    const config = (result.value as PersonalTargetConfig | null) ?? emptyConfig();
    this.current = config; this.baseline = { ...config }; this.loaded = true;
    if (this.pending && !equal(config, this.pending.config)) {
      this.phase = "conflict"; this.message = "当前连接配置与提交内容不同，请比较后继续编辑或放弃草稿。";
    } else {
      this.draft = { ...config }; this.phase = "ready";
      this.message = this.pending ? "已读回保存的配置；远端连接是否成功请查看连接状态。" : "";
    }
    this.pending = null; this.changed();
  }
  async save(): Promise<boolean> {
    if (this.disabled || !this.dirty) return false;
    this.fieldErrors = {};
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(this.draft.host)) this.fieldErrors.host = "SSH 主机别名须以字母或数字开头，只能含字母、数字、点、下划线与连字符。";
    if (!/^\/[A-Za-z0-9._/-]*$/.test(this.draft.controlDir)) this.fieldErrors.controlDir = "请输入有效的远端绝对路径。";
    if (Object.keys(this.fieldErrors).length) { this.message = "请修正标记的字段后保存。"; this.changed(); return false; }
    const generation = this.generation;
    const pending = { target: "personal", op: "desktop_personal_config_save", config: { ...this.draft } } as const;
    this.pending = pending; this.phase = "saving"; this.message = "正在保存连接配置…"; this.changed();
    const result = await this.request(pending.op, { ...pending.config });
    if (generation !== this.generation) return false;
    if (!result.ok) {
      const uncertain = result.error.outcome === "unknown" || result.error.outcome === "disconnected";
      this.phase = uncertain ? "unknown" : "error";
      if (!uncertain) this.pending = null;
      this.message = uncertain ? "保存结果待核实，请读取原连接配置；不会自动重新保存。" : `${result.error.outcome === "not_sent" ? "请求未送出。" : "保存被拒绝。"}${result.error.message}`;
      const field = result.error.code === "invalid_ssh_host" ? "host" : result.error.code === "invalid_control_dir" || result.error.code === "socket_path_too_long" ? "controlDir" : null;
      if (field) this.fieldErrors[field] = result.error.message;
      this.changed(); return false;
    }
    const config = result.value as PersonalTargetConfig;
    this.current = config; this.baseline = { ...config }; this.draft = { ...config }; this.pending = null;
    this.phase = "ready"; this.message = "配置已保存，正在连接远端 PA；连接是否成功请查看连接状态。"; this.changed(); return true;
  }
}
