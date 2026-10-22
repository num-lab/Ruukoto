import type { OpResult } from "@ruukoto/control/ops.ts";
import type { DesktopBridge, DesktopResult } from "../shared/bridge.ts";
import type { PersonalManagementView } from "../shared/personal-settings.ts";
import type { ManagedSettingsCategory, SettingsForm, SettingsPhase } from "./settings-state.ts";

export type PersonalModel = { api: "openai-completions" | "openai-responses" | "anthropic-messages"; baseUrl: string; modelId: string; apiKeyEnv: string; contextWindow: number; maxTokens: number; imageInput?: boolean };
export type PersonalTool = { name: string; description?: string; inputSchema: Record<string, unknown>; [key: string]: unknown };
export type PersonalService = { id: string; label: string; endpoint: string; credential?: { path: string; sha256: string }; credentialStatus?: string; enabled?: boolean; tools: PersonalTool[] };
type Skill = OpResult<"skills_list">["skills"][number];
type SkillDetail = OpResult<"skill_get">;
type SkillPreview = OpResult<"skill_import_preview">;
export type PersonalPageView = Omit<PersonalManagementView, "settings"> & { settings: PersonalManagementView["settings"] & {
  model: { config: PersonalModel; credential: { state: "available" | "missing" | "unverified"; reference: string } } | null;
  skills: { config: { version: 1; directory: string } | null; revision: string; skills: Skill[]; diagnostics: string[]; diagnosticsTruncated: boolean; hasMore: boolean; offset: number };
  mcp: { version: 1 | 2; services: (Omit<PersonalService, "tools"> & { tools: Pick<PersonalTool, "name" | "description">[] })[]; hasMore: boolean; offset: number } | null;
} };
type Directory = { purpose: "library" | "import"; directory: string; selectable: boolean; directories: { name: string; directory: string }[]; offset: number; hasMore: boolean; truncated: boolean };
type ServiceDraft = { id: string; label: string; endpoint: string; authentication: "" | "anonymous" | "credential"; credentialPath: string; enabled: boolean; tools: PersonalTool[] };
const emptyModel = () => ({ api: "openai-responses" as PersonalModel["api"], baseUrl: "", modelId: "", apiKeyEnv: "", contextWindow: "", maxTokens: "", imageInput: false });
const emptyService = (): ServiceDraft => ({ id: crypto.randomUUID(), label: "", endpoint: "", authentication: "", credentialPath: "", enabled: false, tools: [] });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Note: 见 .agents/notes/implemented/feature/2026-10-21-desktop-personal-pages.md
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
  fieldErrors: Record<string, string> = {};
  confirmation: { request: Record<string, unknown>; label: string } | null = null;
  private baseline = "";
  private revision = "";
  private generation = 0;
  private toolsChanged = false;
  private uncertain = false;
  private continueAfterSave: ((saved: boolean) => void) | null = null;
  constructor(private readonly bridge: Pick<DesktopBridge, "request">, readonly changed: () => void, readonly category: ManagedSettingsCategory) {}
  private draft(): unknown { return this.category === "models" ? this.model : this.category === "skills" ? { library: this.library, preview: this.preview } : this.editingService ? this.service : null; }
  get dirty(): boolean { return !!this.view && JSON.stringify(this.draft()) !== this.baseline; }
  get disabled(): boolean { return !this.view || this.reading || this.phase === "saving" || this.phase === "unknown"; }
  get confirming(): boolean { return this.confirmation !== null || this.continueAfterSave !== null; }
  get writable(): boolean { return !!this.view && this.view.settings.online && this.view.maintenance.writable && this.view.settings.model?.credential.state === "available" && !this.view.settings.lifecycle.managedDevelopment && !this.view.pending && !this.view.settings.blockers.length; }
  get skills(): Skill[] { return this.view?.settings.skills.skills ?? []; }
  get services() { return this.view?.settings.mcp?.services ?? []; }
  get filtered(): Skill[] { return this.skills.filter(skill => skill.name.toLocaleLowerCase().includes(this.query.trim().toLocaleLowerCase())); }
  private accepts(generation: number): boolean { return generation === this.generation; }
  invalidate(): void { ++this.generation; this.reading = false; this.cancelConfirmation(); this.discovered = null; this.test = null; if (this.phase === "saving") { this.uncertain = true; this.phase = "unknown"; } }
  private adopt(): void {
    if (!this.view) return;
    const config = this.view.settings.model?.config;
    this.model = config ? { ...config, contextWindow: String(config.contextWindow), maxTokens: String(config.maxTokens), imageInput: config.imageInput ?? false } : emptyModel();
    this.library = this.view.settings.skills.config?.directory ?? "";
    this.preview = null; this.detail = null; this.directory = null; this.service = emptyService(); this.editingService = false; this.toolsChanged = false;
    this.revision = this.view.settings.revisions[this.category === "models" ? "model" : this.category];
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
    this.uncertain = !!this.view.pending;
    if (!preserve) this.adopt();
    this.phase = this.uncertain ? "unknown" : preserve ? "conflict" : "ready";
    this.message = this.view.message + (preserve ? " 原草稿保留，请比较当前配置；放弃更改后可基于当前值编辑。" : "");
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
    if (!id && this.view?.settings.mcp?.version === 1) { this.message = "请先显式迁入服务启停格式，再添加停用服务。"; this.changed(); return; }
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
    this.service = service ? { id: service.id, label: service.label, endpoint: service.endpoint, authentication: service.credential ? "credential" : "anonymous", credentialPath: service.credential?.path ?? "", enabled: service.enabled ?? true, tools: service.tools } : emptyService();
    this.editingService = true; this.toolsChanged = false; this.discovered = null; this.baseline = id ? JSON.stringify(this.draft()) : "null"; this.changed();
  }
  editService<K extends keyof ServiceDraft>(key: K, value: ServiceDraft[K]): void { if (this.disabled) return; this.service = { ...this.service, [key]: value }; this.discovered = null; this.confirmation = null; delete this.fieldErrors[key]; this.changed(); }
  allowTool(tool: PersonalTool, allowed: boolean): void { if (this.disabled) return; this.service.tools = allowed ? [...this.service.tools.filter(item => item.name !== tool.name), tool] : this.service.tools.filter(item => item.name !== tool.name); this.toolsChanged = true; this.confirmation = null; this.changed(); }
  private serviceValue(): Record<string, unknown> | null {
    this.fieldErrors = {};
    if (!this.service.label.trim() || this.service.label.length > 128) this.fieldErrors.label = "请输入不超过 128 字的服务名称。";
    let url: URL | null = null;
    try { url = new URL(this.service.endpoint); } catch { this.fieldErrors.endpoint = "请输入完整 HTTPS 端点。"; }
    if (url && (url.protocol !== "https:" || url.username || url.password || url.hash)) this.fieldErrors.endpoint = "使用无用户名、密码与片段的 HTTPS 端点。";
    if (!this.service.authentication) this.fieldErrors.authentication = "请选择匿名或私有凭据文件。";
    if (this.service.authentication === "credential" && !this.service.credentialPath.startsWith("/")) this.fieldErrors.credentialPath = "请输入远端私有凭据文件的绝对路径。";
    if (Object.keys(this.fieldErrors).length) { this.message = "请修正标记字段。"; this.changed(); return null; }
    const { id, label, endpoint, authentication, credentialPath } = this.service;
    return { id, label, endpoint, authentication, ...(authentication === "credential" ? { credentialPath } : {}) };
  }
  async discover(): Promise<void> { const service = this.serviceValue(); if (!service) return; const result = await this.queryRemote<{ tools: PersonalTool[] }>("mcp.discover", { service }); if (result) { this.discovered = result.tools; this.message = `已发现 ${result.tools.length} 个工具，未执行业务工具。`; this.changed(); } }
  prepareService(action: "enable" | "disable" | "remove" | "migrate"): void {
    if (this.dirty) return;
    this.prepare(this.envelope(action === "migrate" ? "mcp.migrate" : action === "remove" ? "mcp.remove" : "mcp.set-enabled", action === "migrate" ? {} : { id: this.service.id, ...(action === "remove" ? {} : { enabled: action === "enable" }) }), action === "migrate" ? "迁入支持服务启停的配置格式，保留服务与允许列表" : `${action === "remove" ? "删除" : action === "enable" ? "启用" : "停用"} MCP 服务 ${this.service.label}；原调用的效果仍须核实`);
  }
  private prepare(request: Record<string, unknown>, label: string): void { if (this.disabled || !this.writable || this.phase === "conflict") { this.message = "当前只读、存在配置冲突或仍有未决事项，请先核实原配置与服务。"; this.changed(); return; } this.confirmation = { request, label }; this.changed(); }
  async save(): Promise<boolean> {
    if (this.disabled || !this.dirty || this.phase === "conflict") return false;
    if (this.category === "models") { const value = this.modelValue(); if (value) this.prepare(this.envelope("config.save", { target: "model", value }), "保存当前模型，影响后续任务"); }
    else if (this.category === "skills") {
      if (this.preview) { if (this.library !== (this.view?.settings.skills.config?.directory ?? "")) { this.message = "请先单独保存外部技能库，再重新预览导入。"; this.changed(); return false; } if (!this.preview.conflicts.length) this.prepare(this.envelope("skills.import", { id: this.preview.id, directory: this.importDirectory, contentRevision: this.preview.contentRevision }, true), `导入技能 ${this.preview.name} 到远端私有托管区；保留源目录`); }
      else this.prepare(this.envelope("config.save", { target: "skills", value: { version: 1, directory: this.library } }), "更换远端外部技能库，源目录由外部维护");
    } else { const service = this.serviceValue(); if (service) this.prepare(this.envelope("mcp.save-service", { service: { ...service, ...(this.view?.settings.mcp?.version === 1 ? {} : { enabled: this.service.enabled }), ...(this.toolsChanged || !this.services.some(item => item.id === this.service.id) ? { tools: this.service.tools } : {}) } }), `保存 MCP 服务 ${this.service.label}`); }
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
    this.confirmation = null; this.phase = "saving"; this.message = "正在预检、停止、保存并启动原服务…"; this.changed();
    const result = await this.request<PersonalPageView>("apply", { request });
    if (!this.accepts(generation)) { this.savedForNavigation(false); return false; }
    if (!result.ok) { this.fail(result.error, true); this.savedForNavigation(false); this.changed(); return false; }
    if (!this.belongs(result.value)) { this.uncertain = true; this.phase = "unknown"; this.message = "保存应答档案不匹配，请核实原服务；不会重新提交。"; this.savedForNavigation(false); this.changed(); return false; }
    this.view = result.value; this.uncertain = !!result.value.pending;
    if (result.value.saved) this.adopt();
    this.phase = this.uncertain ? "unknown" : result.value.saved ? "ready" : "error"; this.message = result.value.message; this.changed();
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
    else if (this.belongs(result.value)) { this.view = result.value; this.uncertain = !!this.view.pending; this.phase = this.uncertain ? "unknown" : this.dirty ? "conflict" : "ready"; this.message = this.view.message; if (!this.dirty) this.adopt(); }
    this.changed();
  }
  restore(): Promise<void> { return this.recover("restore"); }
  finish(): Promise<void> { return this.recover("finish"); }
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
    } else if (this.category === "mcp" && this.view.settings.mcp?.hasMore) {
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
