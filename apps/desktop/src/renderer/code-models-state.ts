import type { ModelSelection } from "@ruukoto/core/types.ts";
import type { OpResult } from "@ruukoto/control/ops.ts";
import type { DesktopBridge, DesktopResult } from "../shared/bridge.ts";
import type { SettingsForm, SettingsPhase } from "./settings-state.ts";

type Catalog = Record<string, Record<string, unknown>>;
export interface CatalogSecretLocation { scope: "provider" | "model" | "modelOverrides"; modelId?: string; field: "apiKey" | "headers"; header?: string }
type Screen = "catalog" | "default" | "summary" | "credential";
type ModelWrite = "save_model_catalog" | "set_model_api_key" | "remove_model_api_key" | "remove_model_provider" | "set_default_model" | "set_summary_model";
const clone = <T,>(value: T): T => structuredClone(value);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** 提交后仅保留位置占位，秘密不进入待核实记录。 */
function hideSecrets(value: unknown, field?: string): unknown {
  if (field === "apiKey") return true;
  if (field === "headers") return Object.fromEntries(Object.keys(object(value)).map(key => [key, true]));
  if (Array.isArray(value)) return value.map(item => hideSecrets(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hideSecrets(item, key)]));
  return value;
}

// Note: 见 .agents/notes/implemented/feature/2026-10-21-code-model-settings.md
export class CodeModelsState implements SettingsForm {
  view: OpResult<"get_model_config"> | null = null;
  draft: Catalog = {};
  phase: SettingsPhase = "loading";
  reading = false;
  message = "";
  testMessage = "";
  testing = false;
  testingModelId: string | null = null;
  private testResults: Record<string, { revision: string; ok: boolean; detail: string }> = {};
  fieldErrors: Record<string, string> = {};
  providerId: string | null = null;
  modelIndex: number | null = null;
  screen: Screen = "catalog";
  secret = "";
  headerDraft: { location: CatalogSecretLocation; name: string; value: string } | null = null;
  selection: ModelSelection | null = null;
  pending: { op: ModelWrite; provider: string | null; instanceId: string; revision: string } | null = null;
  private generation = 0;
  private baselineSelection: ModelSelection | null = null;
  constructor(private readonly bridge: Pick<DesktopBridge, "request">, readonly changed: () => void, readonly instanceId: string, private readonly context: () => { instanceId: string | null; online: boolean }) {}
  get revision(): string | null { return this.view?.revision ?? null; }
  get dirty(): boolean { return !!this.view && (!same(this.draft, this.view.providers) || !!this.secret || !!this.headerDraft?.value || !same(this.selection, this.baselineSelection)); }
  get disabled(): boolean { const context = this.context(); return !this.view || this.reading || this.phase === "saving" || this.phase === "unknown" || !context.online || context.instanceId !== this.instanceId; }
  get provider(): Record<string, unknown> { return this.providerId ? this.draft[this.providerId] ?? {} : {}; }
  get models(): Record<string, unknown>[] { return Array.isArray(this.provider.models) ? this.provider.models as Record<string, unknown>[] : []; }
  get model(): Record<string, unknown> { return this.modelIndex === null ? {} : this.models[this.modelIndex] ?? {}; }
  private async request(op: string, params: Record<string, unknown>): Promise<DesktopResult<unknown>> {
    try { return await this.bridge.request("code", op, params); }
    catch { return { ok: false, error: { code: "bridge_unavailable", outcome: "unknown", message: "未取得宿主应答，请读回原实例配置。" } }; }
  }
  invalidate(): void {
    ++this.generation; this.reading = false; this.testing = false; this.secret = ""; this.headerDraft = null;
    this.draft = hideSecrets(this.draft) as Catalog;
    if (this.pending) { this.phase = "unknown"; this.message = "原实例的操作结果待核实，请恢复原连接后读回配置，不会自动重发。"; }
  }
  discard(): void {
    if (this.view) this.draft = clone(this.view.providers) as Catalog;
    this.secret = ""; this.headerDraft = null; this.selection = clone(this.baselineSelection); this.fieldErrors = {}; this.changed();
  }
  closeProvider(): void {
    this.discard(); this.providerId = null; this.modelIndex = null; this.screen = "catalog"; this.selection = null; this.baselineSelection = null;
    if (!this.pending) { this.message = ""; this.phase = this.view ? "ready" : "loading"; }
    this.changed();
  }
  async read(preserveDraft = false, committed = false): Promise<boolean> {
    if (this.reading || this.phase === "saving") return false;
    const context = this.context();
    if (!context.online || context.instanceId !== this.instanceId) { this.message = "请恢复原 Code 实例连接后读取配置。"; this.changed(); return false; }
    const generation = ++this.generation, keep = !committed && (preserveDraft || this.dirty);
    this.reading = true; this.testing = false; this.changed();
    const result = await this.request("get_model_config", {});
    if (generation !== this.generation || this.context().instanceId !== this.instanceId || !this.context().online) return false;
    this.reading = false;
    if (!result.ok) { this.phase = this.pending ? "unknown" : "error"; this.message = `${result.error.message} 请重新读取原配置。`; this.changed(); return false; }
    const pending = this.pending;
    // 控制面 IPC 的共享响应，目录中的秘密已由后台替换为占位符。
    this.view = result.value as OpResult<"get_model_config">;
    const selected = this.screen === "default" ? clone(this.view.defaultModel) : this.screen === "summary" && this.view.summaryModel ? { ...this.view.summaryModel, thinkingLevel: "off" as const } : null;
    if (!keep) { this.draft = clone(this.view.providers) as Catalog; this.selection = selected; }
    this.baselineSelection = selected;
    this.phase = keep && this.dirty ? "conflict" : "ready";
    if (pending) {
      this.message = pending.op === "remove_model_api_key" && !this.view.credentials[pending.provider ?? ""]?.configured
        ? "已读回：所选存储条目已移除；其他来源或有效性未验证。"
        : "已读回原实例的配置位置。原提交是否生效请比较当前值；秘密内容及有效性未验证，不会自动重发。";
    }
    this.pending = null; this.changed(); return true;
  }
  private navigate(action: () => void): void {
    if (this.disabled) return;
    if (this.dirty) return;
    ++this.generation; this.testing = false;
    this.message = ""; this.testMessage = ""; this.fieldErrors = {}; action(); this.changed();
  }
  selectProvider(id: string | null): void { this.navigate(() => { this.providerId = id; this.modelIndex = null; this.screen = "catalog"; this.selection = null; this.baselineSelection = null; }); }
  selectModel(index: number | null): void { this.navigate(() => { this.modelIndex = index; }); }
  chooseScreen(screen: Screen): void {
    this.navigate(() => {
      this.screen = screen;
      this.selection = screen === "default" ? clone(this.view!.defaultModel) : screen === "summary" && this.view!.summaryModel ? { ...this.view!.summaryModel, thinkingLevel: "off" } : null;
      this.baselineSelection = clone(this.selection);
    });
  }
  editSelection(selection: ModelSelection | null): void { if (!this.disabled) { this.selection = selection; this.message = ""; this.changed(); } }
  addProvider(id: string): void {
    this.navigate(() => {
      id = id.trim();
      if (!id || Object.hasOwn(this.draft, id)) { this.message = "请输入未占用的提供方标识。"; return; }
      this.draft = { ...this.draft, [id]: { api: "openai-completions", baseUrl: "", models: [] } }; this.providerId = id; this.modelIndex = null; this.screen = "catalog"; this.selection = null; this.baselineSelection = null;
    });
  }
  addModel(id = ""): void {
    if (this.disabled || !this.providerId) return;
    id = id.trim();
    if (this.models.some(model => model.id === id)) { this.message = id ? "请输入未占用的模型标识。" : "请先填写当前模型的 ID。"; this.changed(); return; }
    this.editProvider("models", [...this.models, { id, ...(id ? { name: id } : {}), contextWindow: 128000, maxTokens: 4096, input: ["text"], reasoning: false }]);
    this.modelIndex = this.models.length - 1;
  }
  editProvider(field: string, value: unknown): void { if (!this.disabled && this.providerId) { this.draft = { ...this.draft, [this.providerId]: { ...this.provider, [field]: value } }; delete this.fieldErrors[field]; this.message = ""; this.changed(); } }
  editModel(field: string, value: unknown): void {
    if (this.modelIndex === null) return;
    delete this.fieldErrors[`catalog-model-${this.modelIndex}-${field}`];
    this.editProvider("models", this.models.map((model, index) => index === this.modelIndex ? { ...model, [field]: value } : model));
  }
  editStoredSecret(value: string): void { if (!this.disabled) { this.secret = value; this.fieldErrors = {}; this.changed(); } }
  editNewHeader(location: CatalogSecretLocation, name: string, value: string): void { if (!this.disabled) { this.headerDraft = value ? { location, name, value } : null; this.changed(); } }
  addHeader(): boolean {
    if (!this.headerDraft) return true;
    if (!this.headerDraft.name.trim()) { this.fieldErrors.headers = "请输入请求头名称。"; this.changed(); return false; }
    this.editSecret({ ...this.headerDraft.location, field: "headers", header: this.headerDraft.name.trim() }, this.headerDraft.value);
    this.headerDraft = null; this.changed(); return true;
  }
  editSecret(location: CatalogSecretLocation, value: string | null): void {
    if (this.disabled || !this.providerId) return;
    const provider = clone(this.provider);
    const original = this.view?.providers[this.providerId];
    const originalTarget = location.scope === "model" ? (original?.models as Record<string, unknown>[] | undefined)?.find(model => model.id === location.modelId)
      : location.scope === "modelOverrides" ? object(object(original?.modelOverrides)[location.modelId ?? ""]) : original;
    const target = location.scope === "model" ? (provider.models as Record<string, unknown>[] | undefined)?.find(model => model.id === location.modelId)
      : location.scope === "modelOverrides" ? object(object(provider.modelOverrides)[location.modelId ?? ""]) : provider;
    if (!target) return;
    if (location.field === "headers") {
      if (!location.header?.trim()) { this.fieldErrors.headers = "请输入请求头名称。"; this.changed(); return; }
      let headers = { ...object(target.headers) };
      const originalHeaders = object(originalTarget?.headers);
      if (value === null || value === "" && !Object.hasOwn(originalHeaders, location.header)) delete headers[location.header];
      else headers = { ...headers, [location.header]: value === "" ? originalHeaders[location.header] : value };
      target.headers = headers;
    } else if (value === null || value === "" && originalTarget?.apiKey === undefined) delete target.apiKey;
    else target.apiKey = value === "" ? originalTarget?.apiKey : value;
    this.draft = { ...this.draft, [this.providerId]: provider }; this.message = ""; this.changed();
  }
  async save(): Promise<boolean> {
    if (this.disabled || !this.dirty) return false;
    this.fieldErrors = {};
    if (!this.addHeader()) return false;
    if ((this.screen === "credential" || this.secret) && (!this.secret || this.secret !== this.secret.trim() || /[\r\n]/.test(this.secret))) { this.fieldErrors.apiKey = "API Key 不能为空、首尾不能有空白或包含换行。"; this.changed(); return false; }
    if (this.screen === "credential") {
      return this.write("set_model_api_key", { provider: this.providerId, api_key: this.secret }, "已保存存储 API Key；其他来源保持不变，连接有效性未验证。");
    }
    if (this.screen === "default" || this.screen === "summary") {
      if (this.screen === "default" && !this.selection) { this.fieldErrors.model = "请选择后台默认模型。"; this.changed(); return false; }
      return this.write(this.screen === "default" ? "set_default_model" : "set_summary_model", { provider: this.selection?.provider ?? null, model_id: this.selection?.modelId ?? null, ...(this.screen === "default" ? { thinking_level: this.selection!.thinkingLevel } : {}) }, "");
    }
    for (const definition of Object.values(this.draft)) {
      if (definition.baseUrl !== undefined) {
        let valid = false;
        try { valid = ["http:", "https:"].includes(new URL(String(definition.baseUrl)).protocol); }
        catch { /* 无效地址留给字段提示。 */ }
        if (!valid) this.fieldErrors.baseUrl = "请输入 http(s) API 地址。";
      }
      const ids = new Set<string>();
      for (const [index, model] of ((Array.isArray(definition.models) ? definition.models : []) as Record<string, unknown>[]).entries()) {
        const prefix = `catalog-model-${index}-`;
        if (typeof model.id !== "string" || !model.id.trim() || ids.has(model.id)) this.fieldErrors[prefix + "id"] = "模型 ID 不能为空，且不能与同一提供方的其他模型重复。";
        if (typeof model.id === "string") ids.add(model.id);
        for (const field of ["contextWindow", "maxTokens"] as const) if (model[field] !== undefined && (!Number.isInteger(model[field]) || Number(model[field]) <= 0)) this.fieldErrors[prefix + field] = "容量必须为正整数。";
        if (Number(model.maxTokens) > Number(model.contextWindow)) this.fieldErrors[prefix + "maxTokens"] = "输出上限不能大于上下文容量。";
      }
    }
    if (Object.keys(this.fieldErrors).length) { this.message = "请修正标记字段后保存。"; this.changed(); return false; }
    // 目录与存储凭据分两次修订写入，首步核实前不提交 Key。
    const secret = this.secret, provider = this.providerId;
    const catalogChanged = !same(this.draft, this.view!.providers);
    if (catalogChanged) {
      const saved = await this.write("save_model_catalog", { providers: clone(this.draft) }, "模型目录已保存；连接测试尚未执行。");
      if (!saved || this.disabled || this.providerId !== provider) {
        if (secret) { this.message += " 存储 API Key 尚未提交，请核实目录后重新输入。"; this.changed(); }
        return false;
      }
    }
    if (!secret) return catalogChanged;
    const saved = await this.write("set_model_api_key", { provider, api_key: secret }, "已保存存储 API Key；其他来源保持不变，连接有效性未验证。");
    if (!saved && catalogChanged) { this.message = `模型目录已保存。${this.message}`; this.changed(); }
    return saved;
  }
  private async write(op: ModelWrite, params: Record<string, unknown>, success: string): Promise<boolean> {
    if (this.disabled) return false;
    const generation = ++this.generation;
    this.testing = false; this.testMessage = "";
    this.pending = { op, provider: this.providerId, instanceId: this.instanceId, revision: this.view!.revision };
    this.phase = "saving";
    // 发出请求后立即清空输入；pending 只保留关联信息。
    const reply = this.request(op, { ...params, expected_revision: this.view!.revision });
    this.secret = ""; this.headerDraft = null; this.draft = hideSecrets(this.draft) as Catalog; this.changed();
    const result = await reply;
    if (generation !== this.generation || this.context().instanceId !== this.instanceId) return false;
    if (!result.ok) {
      const uncertain = result.error.outcome === "unknown" || result.error.outcome === "disconnected";
      this.phase = uncertain ? "unknown" : result.error.code === "config_conflict" ? "conflict" : "error";
      if (!uncertain) this.pending = null;
      this.message = uncertain ? "操作结果待核实，请读回原实例配置；不会自动重发。" : `${result.error.outcome === "not_sent" ? "请求未送出。" : "操作被拒绝。"}${result.error.message}`;
      if (this.phase === "conflict") {
        const refreshed = await this.read(true);
        this.phase = "conflict";
        this.message = refreshed ? "配置已被其他客户端修改。已读回当前值，草稿仍保留；请比较后保存或放弃。" : "配置冲突，草稿仍保留，但当前值读取失败。请重新读取后比较，不会自动重发。";
      }
      this.changed(); return false;
    }
    this.phase = "ready";
    const refreshed = await this.read(false, true);
    this.message = refreshed ? success : "操作已得到成功应答，但读回失败。请核实原配置，不会自动重发。";
    this.changed(); return refreshed;
  }
  async removeProvider(): Promise<boolean> {
    if (this.disabled || this.dirty || !this.providerId) return false;
    const saved = await this.write("remove_model_provider", { provider: this.providerId }, "提供方目录和该提供方存储条目已移除；环境等来源仍由后台启动环境管理。");
    if (saved) { this.providerId = null; this.modelIndex = null; this.changed(); } return saved;
  }
  async removeModel(): Promise<boolean> {
    if (this.disabled || this.modelIndex === null) return false;
    this.editProvider("models", this.models.filter((_, index) => index !== this.modelIndex));
    const saved = await this.save(); if (saved) this.modelIndex = null; return saved;
  }
  removeStoredCredential(): Promise<boolean> { return this.disabled || this.dirty || !this.providerId ? Promise.resolve(false) : this.write("remove_model_api_key", { provider: this.providerId }, "已移除所选存储条目；其他来源或有效性未验证。"); }
  connectionTest(modelId: string): { ok: boolean; detail: string } | null {
    const result = this.testResults[JSON.stringify([this.providerId, modelId])];
    return !this.dirty && result?.revision === this.revision ? result : null;
  }
  async testConnection(modelId: string): Promise<void> {
    if (this.disabled || this.dirty || this.testing || !this.providerId) return;
    const generation = this.generation, key = JSON.stringify([this.providerId, modelId]), revision = this.view!.revision;
    delete this.testResults[key];
    this.testing = true; this.testingModelId = modelId; this.testMessage = ""; this.changed();
    const result = await this.request("test_model_connection", { provider: this.providerId, model_id: modelId });
    if (generation !== this.generation) return;
    this.testing = false;
    const tested = result.ok ? result.value as OpResult<"test_model_connection"> : { ok: false, detail: result.error.message };
    this.testResults[key] = { revision, ok: tested.ok, detail: tested.detail };
    this.testMessage = tested.ok ? "" : tested.detail;
    this.changed();
  }
}
