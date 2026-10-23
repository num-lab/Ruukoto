import type { OpResult } from "@ruukoto/control/ops.ts";
import type { DesktopBridge, DesktopResult } from "../shared/bridge.ts";
import type { SettingsForm, SettingsPhase } from "./settings-state.ts";
import { FILE_PAGE_BYTES, readSnapshotFile } from "./read-snapshot.ts";

type Service = OpResult<"mcp_list">["services"][number];
type CuaConfig = NonNullable<Service["cua"]>;
type Effect = "read" | "write" | "unknown";
type Tool = { name: string; effect: Effect };
export type McpDraft = { kind: "http" | "cua-mac"; cua?: CuaConfig; name: string; endpoint: string; auth: "keep" | "anonymous" | "existing" | "new" | ""; credential: string; toolAllowlist: Tool[] };
type CuaStatus = OpResult<"mcp_cua_status">;
type CuaTargets = OpResult<"mcp_cua_targets">;
type CuaImage = { id: string; source: string; loaded: boolean };
type Write = "mcp_configure" | "mcp_set_enabled" | "mcp_remove" | "mcp_save_credential" | "mcp_remove_credential";
const fresh = (): McpDraft => ({ kind: "http", name: "", endpoint: "", auth: "", credential: "", toolAllowlist: [] });
const draftFor = (service: Service): McpDraft => ({ kind: service.cua ? "cua-mac" : "http", ...(service.cua ? { cua: service.cua } : {}), name: service.name, endpoint: service.endpoint ?? "", auth: "keep", credential: service.credential ?? "", toolAllowlist: service.toolAllowlist.map(entry => typeof entry === "string" ? { name: entry, effect: "read" } : { ...entry }) });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Note: 见 .agents/notes/implemented/feature/2026-10-21-code-mcp-settings.md
// Note: 见 .agents/notes/implemented/architecture/2026-10-23-cua-official-mcp.md
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
  cuaTargets: CuaTargets["targets"] = [];
  cuaIssues: CuaTargets["issues"] = [];
  cuaStatus: CuaStatus | null = null;
  cuaImages: CuaImage[] = [];
  cuaEvidence = "";
  cuaError = "";
  private cuaUnknown = false;
  private invalidatedObservation: string | null = null;
  pending: { op: Write; instanceId: string; projectId: string; serviceId?: string; name?: string; version?: number } | null = null;
  private generation = 0;
  constructor(private readonly bridge: Pick<DesktopBridge, "request">, readonly changed: () => void, readonly instanceId: string, readonly workspaceId: string, readonly sourceId: string, private readonly context: () => { instanceId: string | null; online: boolean }) {}
  get service(): Service | null { return this.services.find(service => service.id === this.selectedId) ?? null; }
  get canAcceptCua(): boolean { return !!this.cuaStatus?.observation && this.cuaImages.length === this.cuaStatus.observation.artifactIds.length && this.cuaImages.length > 0 && this.cuaImages.every(image => image.loaded) && !this.cuaUnknown && !this.cuaError; }
  get conflictingService(): Service | null { return this.phase === "conflict" ? this.services.find(service => service.name === this.draft.name) ?? null : null; }
  useCurrentService(): void {
    const current = this.conflictingService;
    if (this.disabled || !current || this.selectedId) return;
    this.selectedId = current.id; this.baseline = draftFor(current); this.phase = "ready"; this.message = ""; this.changed();
  }
  get dirty(): boolean { return this.editing && (!same(this.draft, this.baseline) || !!this.secret); }
  get connected(): boolean { const current = this.context(); return current.online && current.instanceId === this.instanceId; }
  get disabled(): boolean { const current = this.context(); return this.reading || this.checking || this.phase === "loading" || this.phase === "saving" || this.phase === "unknown" || !current.online || current.instanceId !== this.instanceId || !this.sources.some(source => source.projectId === this.sourceId); }
  private async request<T>(op: string, params: Record<string, unknown>): Promise<DesktopResult<T>> {
    try { return await this.bridge.request("code", op, params) as DesktopResult<T>; }
    catch { return { ok: false, error: { code: "bridge_unavailable", outcome: "unknown", message: "未取得宿主应答，请恢复原连接后读回配置。" } }; }
  }
  invalidate(): void {
    ++this.generation; this.secret = ""; this.reading = false; this.checking = false; this.check = null; this.cuaImages = [];
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
  selectKind(kind: McpDraft["kind"]): void {
    if (this.disabled || this.service) return;
    this.draft = { ...fresh(), name: this.draft.name || (kind === "cua-mac" ? "computer" : ""), kind, auth: kind === "cua-mac" ? "anonymous" : "" }; this.check = null; this.changed();
  }
  selectCua(index: number): void { const target = this.cuaTargets[index]; if (!this.disabled && target?.config.kind === "cua-mac") this.edit("cua", structuredClone(target.config)); }
  editSecret(value: string): void { if (!this.disabled) { this.secret = value; delete this.fieldErrors.secret; this.changed(); } }
  allow(name: string, allowed: boolean): void { this.edit("toolAllowlist", allowed ? [...this.draft.toolAllowlist, { name, effect: this.draft.kind === "cua-mac" ? this.check?.tools.find(tool => tool.name === name)?.effect ?? "unknown" : "unknown" }] : this.draft.toolAllowlist.filter(tool => tool.name !== name)); }
  effect(name: string, effect: Effect): void { this.edit("toolAllowlist", this.draft.toolAllowlist.map(tool => tool.name === name ? { name, effect } : tool)); }
  private accepts(generation: number): boolean { const current = this.context(); return generation === this.generation && current.online && current.instanceId === this.instanceId; }
  async read(preserveDraft = this.dirty, committed = false): Promise<boolean> {
    const current = this.context();
    if (this.reading || this.phase === "saving") return false;
    if (!current.online || current.instanceId !== this.instanceId) { this.message = "请恢复原 Code 实例连接后读取配置。"; this.changed(); return false; }
    const generation = ++this.generation;
    this.reading = true; this.checking = false; this.check = null; this.cuaImages = []; this.changed();
    const sources = await this.request<OpResult<"mcp_sources">>("mcp_sources", { workspace_id: this.workspaceId, selected_project_id: this.sourceId, limit: 50 });
    if (!this.accepts(generation)) return false;
    if (!sources.ok) { this.reading = false; this.phase = this.pending ? "unknown" : "error"; this.message = sources.error.message + " 请重新读取配置来源。"; this.changed(); return false; }
    this.sources = sources.value.sources; this.hasMoreSources = sources.value.hasMore; this.sourceOffset = this.sources.length;
    if (!this.sources.some(source => source.projectId === this.sourceId)) { this.reading = false; this.phase = this.pending ? "unknown" : "error"; this.message = "原配置来源已不属于此工作区，请选择当前有效来源。"; this.changed(); return false; }
    const [services, credentials, targets] = await Promise.all([
      this.request<OpResult<"mcp_list">>("mcp_list", { project_id: this.sourceId }),
      this.request<OpResult<"list_credentials">>("list_credentials", { project_id: this.sourceId }),
      this.request<CuaTargets>("mcp_cua_targets", {}),
    ]);
    if (!this.accepts(generation)) return false;
    this.reading = false;
    if (!services.ok || !credentials.ok) { this.phase = this.pending ? "unknown" : "error"; this.message = (!services.ok ? services.error.message : !credentials.ok ? credentials.error.message : "") + " 请重新读取原配置。"; this.changed(); return false; }
    this.services = services.value.services; this.credentials = credentials.value;
    this.cuaTargets = targets.ok ? targets.value.targets.filter(target => target.config.kind === "cua-mac") : [];
    this.cuaIssues = targets.ok ? targets.value.issues : [{ code: targets.error.code, message: targets.error.message }];
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
    if (this.draft.kind === "cua-mac" && !this.draft.cua) this.fieldErrors.cua = "请选择已检测到的本机 Cua Driver。";
    if (this.draft.kind === "http") try { const endpoint = new URL(this.draft.endpoint); if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) || endpoint.username || endpoint.password) this.fieldErrors.endpoint = "请输入 HTTPS 端点；HTTP 仅限本机回环测试，地址不能携带用户名或密码。"; }
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
    const saved = await this.write("mcp_configure", { ...(this.selectedId ? { service_id: this.selectedId } : {}), project_id: this.sourceId, name: this.draft.name, ...(this.draft.kind === "cua-mac" ? { cua: this.draft.cua } : { endpoint: this.draft.endpoint }), tool_allowlist: this.draft.toolAllowlist, enabled: service?.enabled ?? false, expected_version: expectedVersion, ...(this.draft.kind === "cua-mac" || this.draft.auth === "keep" ? {} : { credential: this.draft.auth === "anonymous" ? null : this.draft.credential }) });
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
    else this.message = "";
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
    if (result.ok && result.value.service.configVersion === this.service?.configVersion) { this.check = result.value; this.message = ""; }
    else this.message = "工具发现未完成或配置已变更，请重新读取配置后检查。";
    this.changed();
  }
  imageLoaded(observationId: string, id: string, loaded: boolean): void {
    if (this.cuaStatus?.observation?.id !== observationId) return;
    this.cuaImages = this.cuaImages.map(image => image.id === id ? { ...image, loaded } : image);
    if (!loaded) this.cuaError = "新截图无法显示，请重新读取恢复截图；当前不能接受现场。";
    this.changed();
  }
  private async readCuaImages(status: CuaStatus, generation: number): Promise<CuaImage[] | null> {
    const observation = status.observation, original = status.original;
    if (!observation || !original || !observation.artifactIds.length || observation.artifactIds.length > 4) return [];
    const images: CuaImage[] = [];
    for (const id of observation.artifactIds) {
      let bytes: Uint8Array | null = null, offset = 0, contentHash: string | null = null, mimeType: string | null = null;
      do {
        const result = await this.request<OpResult<"read_artifact">>("read_artifact", { task_id: original.taskId, session_id: original.sessionId, artifact_id: id, offset, length: FILE_PAGE_BYTES });
        if (!this.accepts(generation)) return null;
        if (!result.ok) { this.cuaError = result.error.message; return null; }
        const { artifact, encoding, data } = result.value;
        if (artifact.id !== id || artifact.taskId !== original.taskId || artifact.sessionId !== original.sessionId || artifact.status !== "complete" || !Number.isSafeInteger(artifact.byteCount) || artifact.byteCount < 1 || artifact.byteCount > 8 * 1024 * 1024 || !artifact.contentHash || !/^[0-9a-f]{64}$/.test(artifact.contentHash) || bytes && (artifact.byteCount !== bytes.length || artifact.contentHash !== contentHash || artifact.mimeType !== mimeType) || encoding !== "base64" || typeof data !== "string" || data.length > Math.ceil(Math.min(FILE_PAGE_BYTES, artifact.byteCount - offset) / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) { this.cuaError = "恢复截图的归属或完整性无法核实，请重新取得新截图。"; return null; }
        const page = Uint8Array.from(atob(data), character => character.charCodeAt(0));
        if (page.length !== Math.min(FILE_PAGE_BYTES, artifact.byteCount - offset)) { this.cuaError = "恢复截图未完整读回，请重新取得新截图。"; return null; }
        bytes ??= new Uint8Array(artifact.byteCount); contentHash = artifact.contentHash; mimeType = artifact.mimeType ?? null; bytes.set(page, offset); offset += page.length;
      } while (offset < bytes.length);
      const file = readSnapshotFile(id, bytes, bytes.length);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes))), hash = [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
      if (!this.accepts(generation)) return null;
      if (file.kind !== "image" || file.mimeType !== mimeType || hash !== contentHash) { this.cuaError = "恢复截图不是可显示的完整图片，请重新取得新截图。"; return null; }
      images.push({ id, source: file.dataUrl, loaded: false });
    }
    return images;
  }
  private async adoptCua(status: CuaStatus, generation: number): Promise<void> {
    this.cuaStatus = status; this.cuaImages = []; this.cuaEvidence = "";
    if (status.observation?.id === this.invalidatedObservation) { this.cuaError = "这张旧恢复截图已失效，请重新取得新截图后再接受现场。"; return; }
    this.invalidatedObservation = null;
    if (status.original) {
      const evidence = await this.request<OpResult<"get_tool_op_mcp">>("get_tool_op_mcp", { tool_op_id: status.original.opId, length: 8192 });
      if (!this.accepts(generation)) return;
      if (evidence.ok) this.cuaEvidence = evidence.value.text;
      else this.cuaError = evidence.error.message;
    }
    const images = await this.readCuaImages(status, generation);
    if (!this.accepts(generation) || !images) return;
    this.cuaImages = images;
  }
  async refreshCua(): Promise<void> {
    if (!this.connected || this.reading || this.checking || this.phase === "saving") return;
    const generation = ++this.generation; this.checking = true; this.cuaImages = []; this.cuaError = ""; this.changed();
    const result = await this.request<CuaStatus>("mcp_cua_status", {});
    if (!this.accepts(generation)) return;
    if (result.ok) { this.cuaUnknown = false; await this.adoptCua(result.value, generation); }
    else this.cuaError = result.error.message;
    if (!this.accepts(generation)) return;
    this.checking = false; this.changed();
  }
  async cuaAction(action: "stop" | "begin" | "observe" | "accept", serviceId?: string): Promise<void> {
    if (this.disabled || this.dirty || this.cuaUnknown || action === "accept" && !this.canAcceptCua) return;
    const observationId = this.cuaStatus?.observation?.id;
    const generation = ++this.generation; this.checking = true; this.cuaImages = []; this.cuaError = "";
    if (action === "observe" && this.cuaStatus) { this.invalidatedObservation = observationId ?? null; this.cuaStatus = { ...this.cuaStatus, observation: undefined }; }
    this.changed();
    const operation = { stop: "mcp_cua_stop", begin: "mcp_cua_begin_recovery", observe: "mcp_cua_observe", accept: "mcp_cua_accept" }[action];
    const result = await this.request<CuaStatus>(operation, action === "accept" ? { observation_id: observationId } : action === "stop" && serviceId ? { service_id: serviceId } : {});
    if (!this.accepts(generation)) return;
    if (result.ok) await this.adoptCua(result.value, generation);
    else { this.cuaUnknown = result.error.outcome === "unknown" || result.error.outcome === "disconnected"; this.cuaError = result.error.message + (this.cuaUnknown ? " 请读取电脑状态核实；不会自动重发。" : " 请核实当前电脑状态后继续。"); }
    if (!this.accepts(generation)) return;
    this.checking = false; this.changed();
  }
  async pauseCua(): Promise<void> {
    if (this.disabled || this.dirty || !this.service?.cua) return;
    const serviceId = this.service.id;
    if (this.service.enabled && !await this.setEnabled(false)) return;
    await this.cuaAction("stop", serviceId);
  }
}
