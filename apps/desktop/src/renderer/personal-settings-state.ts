import type { OpResult } from "@ruukoto/control/ops.ts";
import type { DesktopBridge, DesktopResult } from "../shared/bridge.ts";
import type { PersonalManagementView, PersonalCuaStatus, PersonalConfigurationReceipt, PersonalMcpOperationSummary } from "../shared/personal-settings.ts";
import type { ManagedSettingsCategory, SettingsForm, SettingsPhase } from "./settings-state.ts";

export type PersonalModel = { api: "openai-completions" | "openai-responses" | "anthropic-messages"; baseUrl: string; modelId: string; apiKeyEnv: string; contextWindow: number; maxTokens: number; imageInput?: boolean };
export type PersonalTool = { name: string; description?: string; inputSchema: Record<string, unknown>; [key: string]: unknown };
export type PersonalToolEffect = "read" | "write" | "unknown";
export type PersonalService = { id: string; label: string; endpoint?: string; cua?: { kind: "cua-linux"; executable: string; version: "0.7.0"; sha256: string; sandbox: string; sandboxId: string }; credential?: { path: string; sha256: string } | { path: string; tokenSha256: string }; credentialStatus?: string; enabled?: boolean; tools: PersonalTool[]; toolEffects?: Record<string, PersonalToolEffect> };
type Skill = OpResult<"skills_list">["skills"][number];
type SkillDetail = OpResult<"skill_get">;
type SkillPreview = OpResult<"skill_import_preview">;
export type PersonalPageView = Omit<PersonalManagementView, "settings"> & { settings: PersonalManagementView["settings"] & {
  model: { config: PersonalModel; credential: { state: "available" | "missing" | "unverified"; reference: string } } | null;
  skills: { config: { version: 1; directory: string } | null; revision: string; skills: Skill[]; diagnostics: string[]; diagnosticsTruncated: boolean; hasMore: boolean; offset: number };
  mcp: { version: 1 | 2 | 3 | 4; services: (Omit<PersonalService, "tools"> & { tools: Pick<PersonalTool, "name" | "description">[] })[]; hasMore: boolean; offset: number } | null;
} };
type CuaImagePage = { observation: number; id: string; mime: string; sha256: string; bytes: number; offset: number; base64: string; nextOffset?: number };
type Directory = { purpose: "library" | "import"; directory: string; selectable: boolean; directories: { name: string; directory: string }[]; offset: number; hasMore: boolean; truncated: boolean };
type ServiceDraft = { cua?: PersonalService["cua"]; id: string; label: string; endpoint: string; authentication: "" | "anonymous" | "credential"; credentialPath: string; credentialRebind: boolean; enabled: boolean; tools: PersonalTool[]; toolEffects: Record<string, PersonalToolEffect> };
const emptyModel = () => ({ api: "openai-responses" as PersonalModel["api"], baseUrl: "", modelId: "", apiKeyEnv: "", contextWindow: "", maxTokens: "", imageInput: false });
const emptyService = (): ServiceDraft => ({ id: crypto.randomUUID(), label: "", endpoint: "", authentication: "", credentialPath: "", credentialRebind: false, enabled: false, tools: [], toolEffects: {} });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Note: 见 .agents/notes/implemented/feature/2026-10-21-desktop-personal-pages.md
// Note: 见 .agents/notes/implemented/architecture/2026-10-23-cua-official-mcp.md
export class PersonalSettingsPageState implements SettingsForm {
  phase: SettingsPhase = "loading";
  reading = false;
  message = "";
  view: PersonalPageView | null = null;
  model = emptyModel();
  library = "";
  service = emptyService();
  editingService = false;
  detail: SkillDetail | null = null;
  preview: SkillPreview | null = null;
  importDirectory = "";
  directory: Directory | null = null;
  query = "";
  test: { status: string; message?: string } | null = null;
  discovered: PersonalTool[] | null = null;
  cuaChoosing = false;
  cuaTargets: { label: string; config: NonNullable<PersonalService["cua"]> }[] = [];
  cuaIssues: { code: string; message: string }[] = [];
  cua: PersonalCuaStatus | null = null;
  cuaImages: { operation: number; observation: number; id: string; src: string; loaded: boolean }[] = [];
  cuaConfirmation: { action: "stop"; operation: number; label: string } | null = null;
  mcpOperations: PersonalMcpOperationSummary[] = [];
  mcpDetail: { summary: PersonalMcpOperationSummary; text: string; nextOffset?: number } | null = null;
  mcpNextOffset: number | undefined;
  mcpEndPending: number | null = null;
  mcpEndConfirmation: number | null = null;
  fieldErrors: Record<string, string> = {};
  confirmation: { request: Record<string, unknown>; label: string } | null = null;
  private baseline = "";
  private revision = "";
  private generation = 0;
  private toolsChanged = false;
  private uncertain = false;
  private readonly invalidatedCuaObservations = new Map<number, number>();
  private continueAfterSave: ((saved: boolean) => void) | null = null;
  constructor(private readonly bridge: Pick<DesktopBridge, "request">, readonly changed: () => void, readonly category: ManagedSettingsCategory) {}
  /** 电脑页与 MCP 页共用 mcp 配置与修订，只是各自过滤服务。 */
  private get mcpLike(): boolean { return this.category === "mcp" || this.category === "computer"; }
  get mcpNeedsMigration(): boolean { return !!this.view?.settings.mcp && this.view.settings.mcp.version !== 4; }
  private draft(): unknown { return this.category === "models" ? this.model : this.category === "skills" ? { library: this.library, preview: this.preview } : this.editingService ? this.service : null; }
  get dirty(): boolean { return !!this.view && JSON.stringify(this.draft()) !== this.baseline; }
  get disabled(): boolean { return !this.view || this.reading || this.phase === "saving" || this.phase === "unknown" || !!this.fileIssues.length || this.operations.some(item => item.status === "unknown"); }
  get confirming(): boolean { return this.cuaConfirmation !== null || this.mcpEndConfirmation !== null || this.confirmation !== null || this.continueAfterSave !== null; }
  private get target(): "model" | "skills" | "mcp" { return this.category === "models" ? "model" : this.category === "skills" ? "skills" : "mcp"; }
  get fileIssues() { return (this.view?.settings.fileIssues ?? []).filter(item => item.target === this.target || this.target === "skills" && item.target === "managed-skills"); }
  get operations(): PersonalConfigurationReceipt[] { return (this.view?.operations ?? []).filter(item => item.target === this.target && ["saved", "waiting", "failed", "unknown"].includes(item.status)); }
  private get hasUnknown(): boolean { return !!this.view?.pending; }
  get writable(): boolean { return !!this.view && this.view.settings.settingsProtocol === 2 && !this.fileIssues.length && !this.view.pending && !this.operations.some(item => item.status === "unknown" || this.confirmation?.request.op !== "settings.withdraw" && (item.status !== "saved" || this.view!.settings.online) && (this.target !== "mcp" || item.scope === "*" || this.editingService && item.scope === this.service.id)); }
  get skills(): Skill[] { return this.view?.settings.skills.skills ?? []; }
  get services() { return this.view?.settings.mcp?.services ?? []; }
  get filtered(): Skill[] { return this.skills.filter(skill => skill.name.toLocaleLowerCase().includes(this.query.trim().toLocaleLowerCase())); }
  private accepts(generation: number): boolean { return generation === this.generation; }
  invalidate(): void { ++this.generation; this.reading = false; this.cancelConfirmation(); this.discovered = null; this.test = null; this.cuaImages = []; this.cuaConfirmation = null; this.mcpOperations = []; this.mcpDetail = null; this.mcpNextOffset = undefined; this.mcpEndConfirmation = null; if (this.phase === "saving") { this.uncertain = true; this.phase = "unknown"; } }
  private adopt(): void {
    if (!this.view) return;
    const config = this.view.settings.model?.config;
    this.model = config ? { ...config, contextWindow: String(config.contextWindow), maxTokens: String(config.maxTokens), imageInput: config.imageInput ?? false } : emptyModel();
    this.library = this.view.settings.skills.config?.directory ?? "";
    this.cuaChoosing = false; this.cuaTargets = []; this.cuaIssues = []; this.cuaImages = []; this.cuaConfirmation = null; this.preview = null; this.detail = null; this.directory = null; this.service = emptyService(); this.editingService = false; this.toolsChanged = false;
    this.revision = this.view.settings.revisions[this.category === "models" ? "model" : this.category === "computer" ? "mcp" : this.category];
    this.baseline = JSON.stringify(this.draft()); this.fieldErrors = {}; this.test = null; this.discovered = null;
  }
  discard(): void { if (this.phase === "saving" || this.phase === "unknown") return; this.confirmation = null; this.adopt(); this.phase = "ready"; this.changed(); }
  private async request<T>(op: string, params: Record<string, unknown> = {}): Promise<DesktopResult<T>> {
    try { return await this.bridge.request("personal", `desktop_personal_settings_${op}`, params) as DesktopResult<T>; }
    catch { return { ok: false, error: { code: "bridge_unavailable", outcome: "unknown", message: "宿主应答丢失，请读取原档案与维护记录；不会自动重发。" } }; }
  }
  private fail(error: Extract<DesktopResult<unknown>, { ok: false }>["error"], write = false): void {
    this.uncertain ||= write && (error.outcome === "unknown" || error.outcome === "disconnected");
    this.phase = this.uncertain ? "unknown" : ["settings_revision_changed", "skills_revision_conflict", "settings_profile_changed"].includes(error.code) ? "conflict" : "error";
    this.message = error.message;
  }
  private belongs(view: PersonalPageView): boolean {
    return !this.view || same(view.settings.profile, this.view.settings.profile);
  }
  async read(): Promise<boolean> {
    if (this.reading || this.phase === "saving") return false;
    const generation = this.generation, preserve = this.dirty;
    this.reading = true; this.confirmation = null; this.changed();
    const result = await this.request<PersonalPageView>("read");
    if (!this.accepts(generation)) return false;
    this.reading = false;
    if (!result.ok) { this.fail(result.error); this.changed(); return false; }
    if (!this.belongs(result.value)) { this.phase = "conflict"; this.message = "远端档案身份已变化，请保留草稿并返回 PA 远程连接核实；不会改发到新档案。"; this.changed(); return false; }
    this.view = result.value;
    this.uncertain = this.hasUnknown;
    if (!preserve) this.adopt();
    this.phase = this.uncertain ? "unknown" : preserve ? "conflict" : "ready";
    this.message = (this.view.settings.settingsProtocol !== 2 ? "原后台尚不支持在线配置，请升级后重新读取。" : this.mcpLike && this.phase === "ready" ? "" : this.view.message) + (preserve ? " 原草稿保留，请比较当前配置；放弃更改后可基于当前值编辑。" : "");
    this.changed(); return true;
  }
  private envelope(op: string, params: Record<string, unknown> = {}, managed = false): Record<string, unknown> {
    return { v: 1, op, profile: this.view!.settings.profile, expectedRevision: managed ? this.view!.settings.skills.revision : this.revision, ...params };
  }
  private async queryRemote<T>(op: string, params: Record<string, unknown> = {}, managed = false): Promise<T | null> {
    if (this.disabled) return null;
    const generation = this.generation; this.reading = true; this.changed();
    const result = await this.request<T & { profile: PersonalPageView["settings"]["profile"] }>("request", { request: op === "settings.read" ? { v: 1, op, ...params } : this.envelope(op, params, managed) });
    if (!this.accepts(generation)) return null;
    this.reading = false;
    if (!result.ok) { this.fail(result.error); this.changed(); return null; }
    if (!same(result.value.profile, this.view!.settings.profile)) { this.phase = "conflict"; this.message = "查询应答不属于原档案，请核实管理连接。"; this.changed(); return null; }
    this.changed(); return result.value;
  }
  editModel<K extends keyof typeof this.model>(key: K, value: (typeof this.model)[K]): void { if (this.disabled) return; this.model = { ...this.model, [key]: value }; this.test = null; this.confirmation = null; delete this.fieldErrors[key]; this.changed(); }
  editLibrary(value: string): void { if (this.disabled) return; this.library = value; this.preview = null; this.confirmation = null; this.changed(); }
  private modelValue(): PersonalModel | null {
    const value = { ...this.model, contextWindow: Number(this.model.contextWindow), maxTokens: Number(this.model.maxTokens) };
    this.fieldErrors = {};
    if (!value.modelId.trim()) this.fieldErrors.modelId = "请输入模型标识。";
    if (!/^[A-Z_][A-Z0-9_]*$/.test(value.apiKeyEnv) || /^RUUKOTO_(OWNER_TOKEN|SERVICE|CODE_|DESKTOP_|.*_DIR$|PRODUCT$|EXECUTION_BACKEND$)/.test(value.apiKeyEnv)) this.fieldErrors.apiKeyEnv = "请输入专用凭据环境变量名称。";
    let url: URL | null = null;
    try { url = new URL(value.baseUrl); } catch { this.fieldErrors.baseUrl = "请输入完整服务地址。"; }
    if (url && (url.username || url.password || url.search || url.hash || url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) this.fieldErrors.baseUrl = "使用无凭据的 HTTPS 地址；回环地址可使用 HTTP。";
    if (!Number.isSafeInteger(value.contextWindow) || value.contextWindow < 1024) this.fieldErrors.contextWindow = "上下文上限至少为 1024。";
    if (!Number.isSafeInteger(value.maxTokens) || value.maxTokens < 1 || value.maxTokens >= value.contextWindow) this.fieldErrors.maxTokens = "输出上限须为正整数且小于上下文上限。";
    if (Object.keys(this.fieldErrors).length) { this.message = "请修正标记字段。"; this.changed(); return null; }
    return value;
  }
  async testModel(): Promise<void> { const value = this.modelValue(); if (!value) return; const result = await this.queryRemote<{ test: { status: string; message?: string } }>("model.test", { value }); if (result) { this.test = result.test; this.changed(); } }
  async browse(purpose: Directory["purpose"], directory: string, more = false): Promise<void> {
    const previous = this.directory;
    const result = await this.queryRemote<Directory>("skills.select-directory", { purpose, directory, offset: more && previous ? previous.offset + previous.directories.length : 0, limit: 20 }, true);
    if (result) { this.directory = result; this.changed(); }
  }
  async chooseDirectory(): Promise<void> { const directory = this.directory; if (!directory?.selectable) return; if (directory.purpose === "library") { this.editLibrary(directory.directory); this.directory = null; } else await this.previewImport(directory.directory); this.changed(); }
  async previewImport(directory: string): Promise<void> {
    const result = await this.queryRemote<SkillPreview>("skills.preview-import", { directory }, true);
    if (result) { this.preview = result; this.importDirectory = directory; this.directory = null; this.changed(); }
  }
  async selectSkill(id: string): Promise<void> { if (this.dirty) return; const detail = await this.queryRemote<SkillDetail>("skills.get", { id }, true); if (detail) { this.detail = detail; this.changed(); } }
  prepareSkill(action: "enable" | "disable" | "remove"): void {
    if (!this.detail || this.detail.readOnly || this.detail.state === "removed" || this.dirty) return;
    this.prepare(this.envelope(action === "remove" ? "skills.remove" : "skills.set-enabled", { id: this.detail.id, ...(action === "remove" ? {} : { enabled: action === "enable" }) }, true), `${action === "remove" ? "逻辑移除" : action === "enable" ? "启用" : "停用"}技能 ${this.detail.name}；包字节保留供旧引用读取`);
  }
  async selectService(id: string | null): Promise<void> {
    if (this.disabled || this.dirty) return;
    if (!id && this.category === "mcp" && this.view?.settings.mcp && this.view.settings.mcp.version !== 4) { this.message = "请先迁入 MCP 调用格式，再添加普通服务。"; this.changed(); return; }
    let service: PersonalService | null = null;
    if (id) {
      let offset = 0, hasMore = true;
      while (hasMore) {
        const result = await this.queryRemote<{ service: PersonalService; toolsOffset: number; toolsHasMore: boolean }>("mcp.get", { id, offset, limit: 1 });
        if (!result) return;
        service = service ? { ...result.service, tools: [...service.tools, ...result.service.tools] } : result.service;
        hasMore = result.toolsHasMore; offset += result.service.tools.length;
      }
    }
    this.service = service ? { id: service.id, label: service.label, endpoint: service.endpoint ?? "", ...(service.cua ? { cua: service.cua } : {}), authentication: service.credential ? "credential" : "anonymous", credentialPath: service.credential?.path ?? "", credentialRebind: false, enabled: service.enabled ?? true, tools: service.tools, toolEffects: Object.fromEntries(service.tools.map(tool => [tool.name, service.toolEffects?.[tool.name] ?? "unknown"])) } : emptyService();
    this.cuaChoosing = false; this.editingService = true; this.toolsChanged = false; this.discovered = null; this.baseline = id ? JSON.stringify(this.draft()) : "null"; this.changed();
  }
  editService<K extends keyof ServiceDraft>(key: K, value: ServiceDraft[K]): void { if (this.disabled || this.service.cua && ["endpoint", "authentication", "credentialPath", "cua"].includes(key)) return; this.service = { ...this.service, [key]: value }; this.discovered = null; this.confirmation = null; delete this.fieldErrors[key]; this.changed(); }
  allowTool(tool: PersonalTool, allowed: boolean): void { if (this.disabled || this.service.cua && !this.discovered?.some(item => item.name === tool.name) && !this.service.tools.some(item => item.name === tool.name)) return; this.service.tools = allowed ? [...this.service.tools.filter(item => item.name !== tool.name), tool] : this.service.tools.filter(item => item.name !== tool.name); this.service.toolEffects = Object.fromEntries(this.service.tools.map(item => [item.name, this.service.toolEffects[item.name] ?? "unknown"])); this.toolsChanged = true; this.confirmation = null; this.changed(); }
  toolEffect(name: string, effect: PersonalToolEffect): void { if (this.disabled || this.service.cua || !this.service.tools.some(tool => tool.name === name) || this.mcpNeedsMigration) return; this.service.toolEffects = { ...this.service.toolEffects, [name]: effect }; this.confirmation = null; this.changed(); }
  rebindCredential(): void { if (this.disabled || this.service.cua || this.service.authentication !== "credential" || this.mcpNeedsMigration) return; this.service.credentialRebind = true; this.confirmation = null; this.changed(); }
  private serviceValue(): Record<string, unknown> | null {
    if (this.service.cua) {
      if (!this.service.label.trim() || this.service.label.length > 128) { this.fieldErrors = { label: "请输入不超过 128 字的服务名称。" }; this.changed(); return null; }
      return { id: this.service.id, label: this.service.label, cua: this.service.cua };
    }
    this.fieldErrors = {};
    if (!this.service.label.trim() || this.service.label.length > 128) this.fieldErrors.label = "请输入不超过 128 字的服务名称。";
    let url: URL | null = null;
    try { url = new URL(this.service.endpoint); } catch { this.fieldErrors.endpoint = "请输入完整 HTTPS 端点。"; }
    if (url && (url.protocol !== "https:" || url.username || url.password || url.hash)) this.fieldErrors.endpoint = "使用无用户名、密码与片段的 HTTPS 端点。";
    if (!this.service.authentication) this.fieldErrors.authentication = "请选择匿名或私有凭据文件。";
    if (this.service.authentication === "credential" && !this.service.credentialPath.startsWith("/")) this.fieldErrors.credentialPath = "请输入远端私有凭据文件的绝对路径。";
    if (Object.keys(this.fieldErrors).length) { this.message = "请修正标记字段。"; this.changed(); return null; }
    const { id, label, endpoint, authentication, credentialPath, credentialRebind } = this.service;
    return { id, label, endpoint, authentication, ...(authentication === "credential" ? { credentialPath, ...(credentialRebind ? { credentialRebind: true } : {}) } : {}) };
  }
  async addCua(): Promise<void> {
    await this.selectService(null);
    if (!this.editingService || this.services.some(service => service.id === this.service.id)) return;
    this.cuaChoosing = true;
    const result = await this.queryRemote<{ targets: { label: string; config: PersonalService["cua"] }[]; issues: { code: string; message: string }[] }>("mcp.cua-targets");
    if (result) { this.cuaTargets = result.targets.filter((target): target is { label: string; config: NonNullable<PersonalService["cua"]> } => target.config?.kind === "cua-linux"); this.cuaIssues = result.issues; this.message = this.cuaTargets.length ? "" : "未发现可用 Linux 桌面沙箱，请按安装说明准备本地环境后刷新。"; this.changed(); }
  }
  chooseCua(index: number): void {
    const target = this.cuaTargets[index];
    if (!target || this.disabled) return;
    this.service = { ...emptyService(), id: this.service.id, label: target.label, cua: target.config };
    this.discovered = null; this.toolsChanged = true; this.confirmation = null; this.changed();
  }
  async readCua(): Promise<void> {
    this.cuaImages = []; this.cuaConfirmation = null;
    const result = await this.queryRemote<PersonalCuaStatus>("mcp.cua-status");
    if (result) this.cua = result;
    this.changed();
  }
  prepareCua(action: "stop", operation: number): void {
    if (this.disabled || !this.cua?.operations.some(item => item.operation === operation)) return;
    this.cuaConfirmation = { action, operation, label: "停止整个原沙箱会丢失内存及未保存的应用状态，磁盘保留。" }; this.changed();
  }
  cancelCua(): void { this.cuaConfirmation = null; this.changed(); }
  async confirmCua(): Promise<void> { const confirmation = this.cuaConfirmation; this.cuaConfirmation = null; if (confirmation) await this.controlCua(confirmation.action, confirmation.operation); }
  canAcceptCua(operation: number, observation?: number): boolean {
    const item = this.cua?.operations.find(item => item.operation === operation);
    return !!observation && this.invalidatedCuaObservations.get(operation) !== observation && item?.cuaRecovery === "observed" && item.cuaObservation === observation && !!item.images.length && item.images.every(image => this.cuaImages.some(loaded => loaded.operation === operation && loaded.observation === observation && loaded.id === image.id && loaded.loaded));
  }
  cuaImageLoaded(operation: number, observation: number, id: string, loaded: boolean): void {
    const image = this.cuaImages.find(image => image.operation === operation && image.observation === observation && image.id === id);
    if (!image) return;
    image.loaded = loaded; if (!loaded) this.message = "新截图无法显示，请重新观察；未开放电脑操作。"; this.changed();
  }
  async controlCua(action: "pause" | "resume" | "stop" | "observe" | "accept", operation?: number): Promise<void> {
    if (this.disabled) return;
    const observation = this.cua?.operations.find(item => item.operation === operation)?.cuaObservation;
    if (action === "observe" && operation !== undefined && observation !== undefined) this.invalidatedCuaObservations.set(operation, observation);
    if (action === "accept" && (operation === undefined || !this.canAcceptCua(operation, observation))) return;
    this.cuaImages = []; this.cuaConfirmation = null;
    const generation = this.generation; this.reading = true; this.changed();
    const result = await this.request<PersonalCuaStatus & { profile: PersonalPageView["settings"]["profile"] }>("request", { request: this.envelope("mcp.cua-control", { action, ...(operation === undefined ? {} : { operation }), ...(action === "accept" ? { observation } : {}) }) });
    if (!this.accepts(generation)) return;
    this.reading = false;
    if (!result.ok) { this.fail(result.error, true); this.changed(); return; }
    if (!same(result.value.profile, this.view!.settings.profile)) { this.phase = "conflict"; this.message = "电脑控制应答不属于原档案，请重新读取。"; this.changed(); return; }
    this.cua = { ...result.value, available: true };
    this.message = "";
    if (action === "observe" && operation !== undefined) await this.loadCuaImages(operation);
    this.changed();
  }
  async loadCuaImages(operation: number): Promise<void> {
    this.cuaImages = [];
    const current = this.cua?.operations.find(item => item.operation === operation), observation = current?.cuaObservation, generation = this.generation;
    if (!current || !observation || this.invalidatedCuaObservations.get(operation) === observation || current.cuaRecovery !== "observed") return;
    for (const image of current.images) {
      const chunks: Uint8Array[] = []; let offset = 0, complete = false;
      while (!complete) {
        const page: CuaImagePage | null = await this.queryRemote<CuaImagePage>("mcp.cua-image", { operation, observation, image: image.id, offset });
        if (!page || !this.accepts(generation)) return;
        if (page.observation !== observation || page.id !== image.id || page.mime !== image.mime || page.sha256 !== image.sha256 || page.bytes !== image.bytes || page.bytes > 8 * 1024 * 1024 || page.offset !== offset || !["image/png", "image/jpeg", "image/webp"].includes(page.mime)) { this.message = "新截图身份或长度不符，请重新观察。"; this.cuaImages = []; this.changed(); return; }
        let bytes: Uint8Array;
        try { bytes = Uint8Array.from(atob(page.base64), char => char.charCodeAt(0)); }
        catch { this.message = "新截图传输内容无效，请重新观察。"; this.cuaImages = []; this.changed(); return; }
        if (!bytes.length || bytes.length > 128 * 1024 || offset + bytes.length > image.bytes || page.nextOffset !== undefined && page.nextOffset !== offset + bytes.length) { this.message = "新截图分页不完整，请重新观察。"; this.cuaImages = []; this.changed(); return; }
        chunks.push(bytes); offset += bytes.length; complete = page.nextOffset === undefined;
      }
      const bytes = new Uint8Array(offset); let position = 0;
      for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.length; }
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
      if (!this.accepts(generation)) return;
      if (offset !== image.bytes || hash !== image.sha256) { this.message = "新截图完整性核实失败，请重新观察。"; this.cuaImages = []; this.changed(); return; }
      this.cuaImages.push({ operation, observation, id: image.id, src: `data:${image.mime};base64,${btoa(Array.from(bytes, value => String.fromCharCode(value)).join(""))}`, loaded: false });
    }
    this.changed();
  }
  async discover(): Promise<void> { const service = this.serviceValue(); if (!service) return; const result = await this.queryRemote<{ tools: PersonalTool[] }>("mcp.discover", { service }); if (result) { this.discovered = result.tools; this.message = ""; this.changed(); } }
  prepareService(action: "enable" | "disable" | "remove" | "migrate"): void {
    if (this.dirty) return;
    this.prepare(this.envelope(action === "migrate" ? "mcp.migrate" : action === "remove" ? "mcp.remove" : "mcp.set-enabled", action === "migrate" ? {} : { id: this.service.id, ...(action === "remove" ? {} : { enabled: action === "enable" }) }), action === "migrate" ? "迁入 MCP 调用格式；保留原服务和凭据引用，旧普通工具的副作用默认为不明" : `${action === "remove" ? "删除" : action === "enable" ? "启用" : "停用"} MCP 服务 ${this.service.label}；原调用的效果仍须核实`);
  }
  async readMcpOperations(more = false): Promise<void> {
    if (more && this.mcpNextOffset === undefined) return;
    if (!more) this.mcpDetail = null;
    if (this.mcpEndPending !== null) await this.readMcpOperation(this.mcpEndPending);
    const result = await this.queryRemote<{ operations: PersonalMcpOperationSummary[]; nextOffset?: number }>("mcp.operations", { offset: more ? this.mcpNextOffset ?? 0 : 0 });
    if (!result) return;
    this.mcpOperations = more ? [...this.mcpOperations, ...result.operations] : result.operations;
    this.mcpNextOffset = result.nextOffset;
    const current = this.mcpDetail, updated = current && this.mcpOperations.find(item => item.operation === current.summary.operation);
    if (current && updated) this.mcpDetail = { ...current, summary: updated };
    this.changed();
  }
  async readMcpOperation(operation: number, more = false): Promise<void> {
    const current = this.mcpDetail;
    if (more && (current?.summary.operation !== operation || current.nextOffset === undefined)) return;
    if (!more) { this.mcpDetail = null; this.mcpEndConfirmation = null; }
    const result = await this.queryRemote<NonNullable<PersonalSettingsPageState["mcpDetail"]>>("mcp.operation", { operation, offset: more ? current!.nextOffset : 0 });
    if (!result) return;
    if (result.summary.operation !== operation) { this.message = "原调用应答身份不符，请重新读取原调用。"; this.changed(); return; }
    this.mcpDetail = result;
    if (this.mcpEndPending === operation) this.mcpEndPending = null;
    this.changed();
  }
  private operationSummary(operation: number): PersonalMcpOperationSummary | undefined { return this.mcpDetail?.summary.operation === operation ? this.mcpDetail.summary : this.mcpOperations.find(item => item.operation === operation); }
  prepareMcpEnd(operation: number): void {
    const original = this.operationSummary(operation);
    if (this.disabled || this.mcpEndPending !== null || !original?.canEnd || original.ended || original.cuaRecovery) return;
    this.mcpEndConfirmation = operation; this.changed();
  }
  cancelMcpEnd(): void { this.mcpEndConfirmation = null; this.changed(); }
  async confirmMcpEnd(): Promise<void> {
    const operation = this.mcpEndConfirmation;
    this.mcpEndConfirmation = null;
    const original = operation === null ? undefined : this.operationSummary(operation);
    if (operation === null || this.disabled || this.mcpEndPending !== null || !original?.canEnd || original.ended || original.cuaRecovery) return;
    const generation = this.generation;
    this.mcpEndPending = operation; this.reading = true; this.changed();
    const result = await this.request<{ profile: PersonalPageView["settings"]["profile"]; operation: number; ended: true }>("request", { request: this.envelope("mcp.end", { operation }) });
    if (!this.accepts(generation)) return;
    this.reading = false;
    if (!result.ok) {
      if (result.error.outcome === "not_sent" || result.error.outcome === "rejected") this.mcpEndPending = null;
      this.fail(result.error); this.changed(); return;
    }
    if (!same(result.value.profile, this.view!.settings.profile) || result.value.operation !== operation || result.value.ended !== true) { this.message = "人工收尾应答不属于原调用，请刷新调用核实；不会自动重发。"; this.changed(); return; }
    this.mcpEndPending = null;
    this.mcpOperations = this.mcpOperations.map(item => item.operation === operation ? { ...item, canEnd: false, ended: true } : item);
    if (this.mcpDetail?.summary.operation === operation) this.mcpDetail = { ...this.mcpDetail, summary: { ...this.mcpDetail.summary, canEnd: false, ended: true } };
    this.message = "已接纳工作收尾，原调用结果仍未知；真实资源停止与最终报告由原工作继续核实。"; this.changed();
  }
  private prepare(request: Record<string, unknown>, label: string): void { if (this.disabled || !this.writable || this.phase === "conflict") { this.message = "请先核实此对象的原更改或配置冲突。"; this.changed(); return; } this.confirmation = { request, label }; this.changed(); }
  async save(): Promise<boolean> {
    if (this.disabled || !this.dirty || this.phase === "conflict") return false;
    if (this.mcpLike && !this.service.cua && this.view?.settings.mcp && this.view.settings.mcp.version !== 4) { this.message = "请先迁入 MCP 调用格式，再保存普通服务。"; this.changed(); return false; }
    if (this.category === "models") { const value = this.modelValue(); if (value) this.prepare(this.envelope("config.save", { target: "model", value }), "保存当前模型，影响后续任务"); }
    else if (this.category === "skills") {
      if (this.preview) { if (this.library !== (this.view?.settings.skills.config?.directory ?? "")) { this.message = "请先单独保存外部技能库，再重新预览导入。"; this.changed(); return false; } if (!this.preview.conflicts.length) this.prepare(this.envelope("skills.import", { id: this.preview.id, directory: this.importDirectory, contentRevision: this.preview.contentRevision }, true), `导入技能 ${this.preview.name} 到远端私有托管区；保留源目录`); }
      else this.prepare(this.envelope("config.save", { target: "skills", value: { version: 1, directory: this.library } }), "更换远端外部技能库，源目录由外部维护");
    } else { if (this.service.cua && !this.service.tools.some(tool => tool.name === "computer_screenshot")) { this.message = "电脑入口必须允许 computer_screenshot 才能观察与恢复。"; this.changed(); return false; } const service = this.serviceValue(); if (service) this.prepare(this.envelope("mcp.save-service", { service: { ...service, ...(!this.service.cua && !this.mcpNeedsMigration ? { toolEffects: this.service.toolEffects } : {}), ...(this.view?.settings.mcp?.version === 1 ? {} : { enabled: this.service.enabled }), ...(this.toolsChanged || !this.services.some(item => item.id === this.service.id) ? { tools: this.service.tools } : {}) } }), `保存 MCP 服务 ${this.service.label}${this.service.credentialRebind ? "，重新绑定凭据并使未开始的旧批准失效" : ""}`); }
    return false;
  }
  async saveAndContinue(): Promise<boolean> {
    await this.save();
    if (!this.confirmation) return false;
    return new Promise(resolve => { this.continueAfterSave = resolve; });
  }
  private savedForNavigation(saved: boolean): void { this.continueAfterSave?.(saved); this.continueAfterSave = null; }
  cancelConfirmation(): void { this.confirmation = null; this.savedForNavigation(false); this.changed(); }
  async confirmApply(): Promise<boolean> {
    if (!this.confirmation || this.disabled || !this.writable) return false;
    const request = this.confirmation.request, generation = this.generation;
    this.confirmation = null; this.phase = "saving"; this.message = "正在保存并应用配置…"; this.changed();
    const result = await this.request<PersonalPageView>("apply", { request });
    if (!this.accepts(generation)) { this.savedForNavigation(false); return false; }
    if (!result.ok) { this.fail(result.error, true); this.savedForNavigation(false); this.changed(); return false; }
    if (!this.belongs(result.value)) { this.uncertain = true; this.phase = "unknown"; this.message = "保存应答档案不匹配，请核实原服务；不会重新提交。"; this.savedForNavigation(false); this.changed(); return false; }
    this.view = result.value; this.uncertain = this.hasUnknown;
    if (result.value.saved) this.adopt();
    this.phase = this.uncertain ? "unknown" : result.value.saved ? "ready" : "error"; this.message = this.mcpLike && this.phase === "ready" ? "" : result.value.message; this.changed();
    const saved = result.value.saved === true && !this.uncertain;
    this.savedForNavigation(saved); return saved;
  }
  private async recover(action: "restore" | "finish"): Promise<void> {
    if (!this.view?.pending || this.reading || this.phase === "saving") return;
    const generation = this.generation; this.reading = true; this.changed();
    const result = await this.request<PersonalPageView>(action);
    if (!this.accepts(generation)) return;
    this.reading = false;
    if (!result.ok) { this.uncertain = true; this.fail(result.error); }
    else if (this.belongs(result.value)) { this.view = result.value; this.uncertain = this.hasUnknown; this.phase = this.uncertain ? "unknown" : this.dirty ? "conflict" : "ready"; this.message = this.mcpLike && this.phase === "ready" ? "" : this.view.message; if (!this.dirty) this.adopt(); }
    this.changed();
  }
  restore(): Promise<void> { return this.recover("restore"); }
  finish(): Promise<void> { return this.recover("finish"); }
  async checkOperation(id: string): Promise<void> {
    if (this.reading || this.phase === "saving") return;
    const generation = this.generation; this.reading = true; this.changed();
    const result = await this.request<PersonalPageView>("operation", { id });
    if (!this.accepts(generation)) return;
    this.reading = false;
    if (!result.ok) this.fail(result.error);
    else if (this.belongs(result.value)) { const preserve = this.dirty; this.view = result.value; this.uncertain = this.hasUnknown; if (!preserve) this.adopt(); this.phase = this.uncertain ? "unknown" : preserve ? "conflict" : "ready"; this.message = result.value.message; }
    this.changed();
  }
  async withdrawOperation(id: string): Promise<void> {
    const original = this.operations.find(item => item.id === id);
    if (!original || original.status === "unknown" || this.dirty || this.reading || this.phase === "saving") return;
    this.confirmation = { request: this.envelope("settings.withdraw", { id }, original.scope === "managed"), label: "撤回这项待生效更改，保留原保存记录" };
    this.changed();
  }
  async more(): Promise<void> {
    if (!this.view || this.dirty) return;
    if (this.category === "skills") {
      const previous = this.view.settings.skills;
      const result = await this.queryRemote<typeof previous>("skills.list", { offset: previous.skills.length, limit: 20 }, true);
      if (result) {
        if (result.revision !== previous.revision || !same(result.config, previous.config)) { this.phase = "conflict"; this.message = "技能库或托管清单在分页期间变化，请重新读取原配置；未混入其他来源。"; }
        else this.view.settings.skills = { ...result, skills: [...previous.skills, ...result.skills] };
        this.changed();
      }
    } else if (this.mcpLike && this.view.settings.mcp?.hasMore) {
      const previous = this.view.settings.mcp;
      const result = await this.queryRemote<PersonalPageView["settings"]>("settings.read", { offset: previous.services.length, limit: 1 });
      if (result) {
        if (result.revisions.mcp !== this.revision) { this.phase = "conflict"; this.message = "MCP 配置在分页期间变化，请重新读取原配置；未混入新修订。"; }
        else if (result.mcp) this.view.settings.mcp = { ...result.mcp, services: [...previous.services, ...result.mcp.services] };
        this.changed();
      }
    }
  }
}
