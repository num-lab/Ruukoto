import type { DesktopBridge, DesktopResult } from "../shared/bridge.ts";
import type { Project } from "@ruukoto/core/types.ts";

type Credential = { name: string; host: string; header: string; purpose: string; references: unknown[] };
// 与 @ruukoto/agent web-search.ts 的 WEB_SEARCH_CREDENTIAL_NAME 一致：桌面专用 op 只写这个固定名绑定。
const WEB_SEARCH_CREDENTIAL_NAME = "web-search";
const TAVILY_CREDENTIAL_PURPOSE = "tavily_search";

/** Web 搜索页：即时操作无草稿；写入后重读核实，换实例整页重建。 */
export class CodeWebSearchState {
  phase: "loading" | "ready" | "error" = "loading";
  reading = false;
  writing = false;
  message = "";
  fieldErrors: Record<string, string> = {};
  credentials: Credential[] = [];
  secret = "";
  busyProjectId: string | null = null;
  private generation = 0;
  constructor(private readonly bridge: Pick<DesktopBridge, "request">, readonly changed: () => void, readonly instanceId: string, private readonly context: () => { instanceId: string | null; online: boolean }) {}
  /** 服务端 resolveCredential 按名称排序取第一个；此处保持同序以呈现生效凭据。 */
  get effective(): Credential | null { return this.credentials.slice().sort((a, b) => a.name.localeCompare(b.name))[0] ?? null; }
  get desktopManaged(): boolean { return this.credentials.some(credential => credential.name === WEB_SEARCH_CREDENTIAL_NAME); }
  get connected(): boolean { const current = this.context(); return current.online && current.instanceId === this.instanceId; }
  get disabled(): boolean { const current = this.context(); return this.reading || this.writing || !current.online || current.instanceId !== this.instanceId; }
  private async request<T>(op: string, params: Record<string, unknown>): Promise<DesktopResult<T>> {
    try { return await this.bridge.request("code", op, params) as DesktopResult<T>; }
    catch { return { ok: false, error: { code: "bridge_unavailable", outcome: "unknown", message: "未取得宿主应答，请恢复原连接后读取配置。" } }; }
  }
  private accepts(generation: number): boolean { const current = this.context(); return generation === this.generation && current.online && current.instanceId === this.instanceId; }
  invalidate(): void { ++this.generation; this.secret = ""; this.reading = false; this.writing = false; this.busyProjectId = null; }
  async read(): Promise<boolean> {
    if (this.reading || this.writing) return false;
    const generation = ++this.generation;
    this.reading = true; this.changed();
    const result = await this.request<Credential[]>("list_credentials", { purpose: TAVILY_CREDENTIAL_PURPOSE });
    if (!this.accepts(generation)) return false;
    this.reading = false;
    if (!result.ok) { this.phase = "error"; this.message = result.error.message + " 请重新读取。"; this.changed(); return false; }
    this.credentials = result.value;
    this.phase = "ready"; this.message = ""; this.changed();
    return true;
  }
  editSecret(value: string): void { this.secret = value; delete this.fieldErrors.secret; this.changed(); }
  async saveSecret(): Promise<boolean> {
    if (this.disabled) return false;
    this.fieldErrors = {};
    if (!this.secret || this.secret !== this.secret.trim() || /[\r\n]/.test(this.secret)) { this.fieldErrors.secret = "请输入不含首尾空白或换行的 Tavily API Key。"; this.changed(); return false; }
    return this.write("web_search_save_credential", { secret: this.secret }, "已保存 Tavily 凭据。");
  }
  async removeCredential(): Promise<boolean> {
    if (this.disabled) return false;
    return this.write("web_search_remove_credential", {}, "已移除 Tavily 凭据。");
  }
  async setProjectEnabled(project: Project, enabled: boolean): Promise<boolean> {
    if (this.disabled || project.webSearch === (enabled ? "enabled" : "disabled")) return false;
    this.busyProjectId = project.id; this.changed();
    const done = await this.write("set_project_web_search", { project_id: project.id, enabled, expected_version: project.settingsVersion }, `${project.name} 的 Web Search 已${enabled ? "启用" : "停用"}。`, false);
    this.busyProjectId = null; this.changed();
    return done;
  }
  /** 写入后重读核实；结果未知时保留原提示并要求重读，不自动重发。 */
  private async write(op: string, params: Record<string, unknown>, doneMessage: string, clearSecret = true): Promise<boolean> {
    const generation = this.generation;
    this.writing = true; this.message = ""; this.changed();
    const request = this.request(op, params);
    if (clearSecret) this.secret = "";
    const result = await request;
    if (!this.accepts(generation)) return false;
    this.writing = false;
    if (!result.ok) {
      const unknown = result.error.outcome === "unknown" || result.error.outcome === "disconnected";
      this.message = unknown ? `操作结果待核实（${result.error.message}），请重新读取；不会自动重发。` : result.error.code === "version_conflict" ? "项目设置已被其他客户端修改，请按当前值重新选择。" : result.error.message;
      this.phase = "ready"; this.changed();
      if (unknown) { const read = await this.read(); if (read) { this.message = "操作结果原未知，已读回当前配置，请核对是否生效。"; this.changed(); } }
      return false;
    }
    const read = await this.read();
    this.message = read ? doneMessage : `${doneMessage}但读回失败，请重新读取核实。`;
    this.changed();
    return true;
  }
}
