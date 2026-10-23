import type { OpResult } from "@ruukoto/control/ops.ts";
import type { DesktopBridge, DesktopResult } from "../shared/bridge.ts";
import type { SettingsForm, SettingsPhase } from "./settings-state.ts";

type Service = OpResult<"mcp_list">["services"][number];
type Effect = "read" | "write" | "unknown";
type Tool = { name: string; effect: Effect };
export type McpDraft = { name: string; endpoint: string; auth: "keep" | "anonymous" | "existing" | "new" | ""; credential: string; toolAllowlist: Tool[] };
type Write = "mcp_configure" | "mcp_set_enabled" | "mcp_remove" | "mcp_save_credential" | "mcp_remove_credential";
const fresh = (): McpDraft => ({ name: "", endpoint: "", auth: "", credential: "", toolAllowlist: [] });
const draftFor = (service: Service): McpDraft => ({ name: service.name, endpoint: service.endpoint ?? "", auth: "keep", credential: service.credential ?? "", toolAllowlist: service.toolAllowlist.map(entry => typeof entry === "string" ? { name: entry, effect: "read" } : { ...entry }) });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Note: 见 .agents/notes/implemented/feature/2026-10-21-code-mcp-settings.md
export class CodeMcpState implements SettingsForm {
  phase: SettingsPhase = "loading";
  reading = false;
  checking = false;
  message = "";
  fieldErrors: Record<string, string> = {};
  sources: OpResult<"mcp_sources">["sources"] = [];
  hasMoreSources = false;
  private sourceOffset = 0;
  services: Service[] = [];
  credentials: OpResult<"list_credentials"> = [];
  selectedId: string | null = null;
  editing = false;
  draft = fresh();
  private baseline = fresh();
  secret = "";
  check: OpResult<"mcp_check"> | null = null;
  pending: { op: Write; instanceId: string; projectId: string; serviceId?: string; name?: string; version?: number } | null = null;
  private generation = 0;
  constructor(private readonly bridge: Pick<DesktopBridge, "request">, readonly changed: () => void, readonly instanceId: string, readonly workspaceId: string, readonly sourceId: string, private readonly context: () => { instanceId: string | null; online: boolean }) {}
  get service(): Service | null { return this.services.find(service => service.id === this.selectedId) ?? null; }
  get conflictingService(): Service | null { return this.phase === "conflict" ? this.services.find(service => service.name === this.draft.name) ?? null : null; }
  useCurrentService(): void {
    const current = this.conflictingService;
    if (this.disabled || !current || this.selectedId) return;
    this.selectedId = current.id; this.baseline = draftFor(current); this.phase = "ready"; this.message = "已选择当前同名服务，保存将按读回版本更新；请核对草稿。"; this.changed();
  }
  get dirty(): boolean { return this.editing && (!same(this.draft, this.baseline) || !!this.secret); }
  get connected(): boolean { const current = this.context(); return current.online && current.instanceId === this.instanceId; }
  get disabled(): boolean { const current = this.context(); return this.reading || this.checking || this.phase === "loading" || this.phase === "saving" || this.phase === "unknown" || !current.online || current.instanceId !== this.instanceId || !this.sources.some(source => source.projectId === this.sourceId); }
  private async request<T>(op: string, params: Record<string, unknown>): Promise<DesktopResult<T>> {
    try { return await this.bridge.request("code", op, params) as DesktopResult<T>; }
    catch { return { ok: false, error: { code: "bridge_unavailable", outcome: "unknown", message: "未取得宿主应答，请恢复原连接后读回配置。" } }; }
  }
  invalidate(): void {
    ++this.generation; this.secret = ""; this.reading = false; this.checking = false; this.check = null;
    if (this.pending) { this.phase = "unknown"; this.message = "原来源的操作结果待核实，请恢复原 Code 实例后重新读取。"; }
  }
  discard(): void { this.secret = ""; this.draft = this.service ? draftFor(this.service) : fresh(); this.baseline = structuredClone(this.draft); this.fieldErrors = {}; if (this.phase === "conflict") this.phase = "ready"; this.changed(); }
  select(id: string | null): void {
    if (this.disabled || this.dirty) return;
    this.selectedId = id; this.editing = true; this.check = null; this.secret = ""; this.message = "";
    this.draft = id && this.service ? draftFor(this.service) : fresh(); this.baseline = structuredClone(this.draft); this.fieldErrors = {}; this.changed();
  }
  closeEditor(): void { if (this.phase === "saving" || this.phase === "unknown") return; this.discard(); this.editing = false; this.selectedId = null; this.check = null; this.changed(); }
  edit<K extends keyof McpDraft>(field: K, value: McpDraft[K]): void {
    if (this.disabled || this.service?.cua && ["endpoint", "auth", "credential"].includes(field)) return;
    this.draft = { ...this.draft, [field]: value }; delete this.fieldErrors[field];
    if (field === "auth") this.secret = "";
    if (field !== "toolAllowlist") this.check = null; this.changed();
  }
  editSecret(value: string): void { if (!this.disabled) { this.secret = value; delete this.fieldErrors.secret; this.changed(); } }
  allow(name: string, allowed: boolean): void { this.edit("toolAllowlist", allowed ? [...this.draft.toolAllowlist, { name, effect: "unknown" }] : this.draft.toolAllowlist.filter(tool => tool.name !== name)); }
  effect(name: string, effect: Effect): void { this.edit("toolAllowlist", this.draft.toolAllowlist.map(tool => tool.name === name ? { name, effect } : tool)); }
  private accepts(generation: number): boolean { const current = this.context(); return generation === this.generation && current.online && current.instanceId === this.instanceId; }
  async read(preserveDraft = this.dirty, committed = false): Promise<boolean> {
    const current = this.context();
    if (this.reading || this.phase === "saving") return false;
    if (!current.online || current.instanceId !== this.instanceId) { this.message = "请恢复原 Code 实例连接后读取配置。"; this.changed(); return false; }
    const generation = ++this.generation;
    this.reading = true; this.checking = false; this.check = null; this.changed();
    const sources = await this.request<OpResult<"mcp_sources">>("mcp_sources", { workspace_id: this.workspaceId, selected_project_id: this.sourceId, limit: 50 });
    if (!this.accepts(generation)) return false;
    if (!sources.ok) { this.reading = false; this.phase = this.pending ? "unknown" : "error"; this.message = sources.error.message + " 请重新读取配置来源。"; this.changed(); return false; }
    this.sources = sources.value.sources; this.hasMoreSources = sources.value.hasMore; this.sourceOffset = this.sources.length;
    if (!this.sources.some(source => source.projectId === this.sourceId)) { this.reading = false; this.phase = this.pending ? "unknown" : "error"; this.message = "原配置来源已不属于此工作区，请选择当前有效来源。"; this.changed(); return false; }
    const [services, credentials] = await Promise.all([
      this.request<OpResult<"mcp_list">>("mcp_list", { project_id: this.sourceId }),
      this.request<OpResult<"list_credentials">>("list_credentials", { project_id: this.sourceId }),
    ]);
    if (!this.accepts(generation)) return false;
    this.reading = false;
    if (!services.ok || !credentials.ok) { this.phase = this.pending ? "unknown" : "error"; this.message = (!services.ok ? services.error.message : !credentials.ok ? credentials.error.message : "") + " 请重新读取原配置。"; this.changed(); return false; }
    this.services = services.value.services; this.credentials = credentials.value;
    const pending = this.pending;
    if (pending?.op === "mcp_save_credential" && this.credentials.some(credential => credential.name === pending.name)) {
      this.draft = { ...this.draft, auth: "existing", credential: pending.name! };
    }
    if (committed && this.editing && !this.selectedId) this.selectedId = this.services.find(service => service.name === this.draft.name)?.id ?? null;
    if (this.editing && (!preserveDraft || committed)) { this.draft = this.service ? draftFor(this.service) : fresh(); this.baseline = structuredClone(this.draft); }
    this.secret = ""; this.pending = null;
    this.phase = preserveDraft && !committed && this.dirty ? "conflict" : "ready";
    if (this.selectedId && !this.service && !committed && pending?.op !== "mcp_remove") { this.phase = "conflict"; this.message = "原服务已删除或替换，草稿仍保留。请放弃草稿后重新选择服务，原编辑不会自动新增服务。"; }
    else if (pending) this.message = "已读回原来源的当前配置，请比较原操作是否生效；秘密内容未验证，不会自动重发。";
    this.changed(); return true;
  }
  async moreSources(): Promise<void> {
    if (this.disabled || !this.hasMoreSources) return;
    const generation = this.generation; this.reading = true; this.changed();
    const result = await this.request<OpResult<"mcp_sources">>("mcp_sources", { workspace_id: this.workspaceId, selected_project_id: this.sourceId, offset: this.sourceOffset, limit: 50 });
    if (!this.accepts(generation)) return;
    this.reading = false;
    if (result.ok) { this.sources = [...this.sources, ...result.value.sources.filter(source => !this.sources.some(existing => existing.projectId === source.projectId))]; this.sourceOffset += result.value.sources.length; this.hasMoreSources = result.value.hasMore; }
    else this.message = result.error.message + " 请重新加载更多来源。";
    this.changed();
  }
  async save(): Promise<boolean> {
    if (this.disabled || !this.editing || !this.dirty) return false;
    this.fieldErrors = {};
    if (!/^[a-z0-9][a-z0-9_-]{0,29}$/.test(this.draft.name)) this.fieldErrors.name = "服务名称使用 1–30 位小写字母、数字、下划线或连字符，首位为字母或数字。";
    if (!this.service?.cua) try { const endpoint = new URL(this.draft.endpoint); if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) || endpoint.username || endpoint.password) this.fieldErrors.endpoint = "请输入 HTTPS 端点；HTTP 仅限本机回环测试，地址不能携带用户名或密码。"; }
    catch { this.fieldErrors.endpoint = "请输入完整的 HTTPS 端点。"; }
    if (!this.draft.auth) this.fieldErrors.auth = "请选择凭据或显式选择匿名。";
    if (this.draft.auth === "existing" && !this.draft.credential) this.fieldErrors.auth = "请选择所需凭据。";
    if (this.draft.auth === "new" && (!this.secret || this.secret !== this.secret.trim() || /[\r\n]/.test(this.secret))) this.fieldErrors.secret = "请输入不含首尾空白或换行的 Bearer 令牌。";
    if (Object.keys(this.fieldErrors).length) { this.changed(); return false; }
    const expectedVersion = this.service?.configVersion ?? 0;
    if (this.draft.auth === "new") {
      const name = "mcp-" + crypto.randomUUID();
      if (!await this.write("mcp_save_credential", { project_id: this.sourceId, name, endpoint: this.draft.endpoint, secret: this.secret }, name, false)) return false;
      this.draft = { ...this.draft, auth: "existing", credential: name }; this.changed();
    }
    const service = this.service;
    const saved = await this.write("mcp_configure", { ...(this.selectedId ? { service_id: this.selectedId } : {}), project_id: this.sourceId, name: this.draft.name, ...(service?.cua ? { cua: service.cua } : { endpoint: this.draft.endpoint }), tool_allowlist: this.draft.toolAllowlist, enabled: service?.enabled ?? false, expected_version: expectedVersion, ...(this.draft.auth === "keep" ? {} : { credential: this.draft.auth === "anonymous" ? null : this.draft.credential }) });
    if (!saved && this.draft.auth === "existing") { this.message += " 已创建的 MCP 凭据仍仅限本来源；可在解除引用后清理。"; this.changed(); }
    return saved;
  }
  private async write(op: Write, params: Record<string, unknown>, name?: string, committed = true): Promise<boolean> {
    if (this.disabled) return false;
    const generation = ++this.generation;
    this.pending = { op, instanceId: this.instanceId, projectId: this.sourceId, serviceId: this.service?.id, version: this.service?.configVersion, name };
    this.phase = "saving"; this.check = null;
    const request = this.request(op, params); this.secret = ""; this.changed();
    const result = await request;
    if (!this.accepts(generation)) return false;
    if (!result.ok) {
      const unknown = result.error.outcome === "unknown" || result.error.outcome === "disconnected";
      this.phase = unknown ? "unknown" : result.error.code === "version_conflict" ? "conflict" : "error";
      if (!unknown) this.pending = null;
      this.message = unknown ? "操作结果待核实。请重新读取原来源，不会自动重发。" : `${result.error.outcome === "not_sent" ? "请求未送出。" : "操作被拒绝。"}${result.error.message}`;
      if (this.phase === "conflict") { const read = await this.read(true); this.phase = "conflict"; this.message = read ? this.selectedId && !this.service ? "原服务已删除或替换，草稿保留。请放弃草稿后重新选择，原编辑不会自动新增服务。" : "配置已被其他客户端修改。草稿已保留，请比较当前值后保存或放弃。" : "配置冲突且读回失败，请重新读取后比较草稿。"; }
      this.changed(); return false;
    }
    this.phase = "ready";
    const read = await this.read(!committed, committed);
    if (!read) { this.phase = "unknown"; this.message = "后台已应答成功，但读回失败，请核实原配置后继续。"; }
    else this.message = committed ? "已保存并读回所选来源的配置。" : "MCP 凭据已保存，仅限本来源；服务尚待保存。";
    this.changed(); return read;
  }
  async setEnabled(enabled: boolean): Promise<boolean> { return this.disabled || this.dirty || !this.service ? false : this.write("mcp_set_enabled", { service_id: this.service.id, enabled, expected_version: this.service.configVersion }); }
  async remove(): Promise<boolean> { if (this.disabled || this.dirty || !this.service) return false; const saved = await this.write("mcp_remove", { service_id: this.service.id, expected_version: this.service.configVersion }); if (saved) { this.editing = false; this.selectedId = null; this.changed(); } return saved; }
  async removeCredential(name: string): Promise<boolean> { return this.disabled || this.dirty ? false : this.write("mcp_remove_credential", { project_id: this.sourceId, name }, name); }
  async discover(): Promise<void> {
    if (this.disabled || this.dirty || !this.service) return;
    const generation = this.generation; this.checking = true; this.check = null; this.changed();
    const result = await this.request<OpResult<"mcp_check">>("mcp_check", { service_id: this.service.id });
    if (!this.accepts(generation)) return;
    this.checking = false;
    if (result.ok && result.value.service.configVersion === this.service?.configVersion) { this.check = result.value; this.message = result.value.ok ? "工具发现完成，未执行业务工具。请逐项选择允许项与本地副作用类别。" : "连接或工具发现失败，请核对地址与认证后重新检查。"; }
    else this.message = "工具发现未完成或配置已变更，请重新读取配置后检查。";
    this.changed();
  }
}
