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

/** After submission only a location placeholder is kept; secrets never enter unverified records. */
function hideSecrets(value: unknown, field?: string): unknown {
  if (field === "apiKey") return true;
  if (field === "headers") return Object.fromEntries(Object.keys(object(value)).map(key => [key, true]));
  if (Array.isArray(value)) return value.map(item => hideSecrets(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hideSecrets(item, key)]));
  return value;
}

// Note: See .agents/notes/implemented/feature/2026-10-21-code-model-settings.md
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
    catch { return { ok: false, error: { code: "bridge_unavailable", outcome: "unknown", message: "No host response. Read back the original instance configuration." } }; }
  }
  invalidate(): void {
    ++this.generation; this.reading = false; this.testing = false; this.secret = ""; this.headerDraft = null;
    this.draft = hideSecrets(this.draft) as Catalog;
    if (this.pending) { this.phase = "unknown"; this.message = "The original instance's operation outcome is unverified. Restore the connection and read back the configuration; it won't be resent."; }
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
    if (!context.online || context.instanceId !== this.instanceId) { this.message = "Restore the original ruukoto instance connection and read the configuration."; this.changed(); return false; }
    const generation = ++this.generation, keep = !committed && (preserveDraft || this.dirty);
    this.reading = true; this.testing = false; this.changed();
    const result = await this.request("get_model_config", {});
    if (generation !== this.generation || this.context().instanceId !== this.instanceId || !this.context().online) return false;
    this.reading = false;
    if (!result.ok) { this.phase = this.pending ? "unknown" : "error"; this.message = `${result.error.message} Read the original configuration again.`; this.changed(); return false; }
    const pending = this.pending;
    // Shared response over control-plane IPC; secrets in the catalog were replaced with placeholders by the backend.
    this.view = result.value as OpResult<"get_model_config">;
    const selected = this.screen === "default" ? clone(this.view.defaultModel) : this.screen === "summary" && this.view.summaryModel ? { ...this.view.summaryModel, thinkingLevel: "off" as const } : null;
    if (!keep) { this.draft = clone(this.view.providers) as Catalog; this.selection = selected; }
    this.baselineSelection = selected;
    this.phase = keep && this.dirty ? "conflict" : "ready";
    if (pending) {
      this.message = pending.op === "remove_model_api_key" && !this.view.credentials[pending.provider ?? ""]?.configured
        ? "Read back: the selected stored entry was removed; other sources or validity weren't verified."
        : "Read back the original instance's configuration location. Compare the current value for whether the original submission took effect; secret contents and validity weren't verified and won't be resent.";
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
      if (!id || Object.hasOwn(this.draft, id)) { this.message = "Enter an unused provider identifier."; return; }
      this.draft = { ...this.draft, [id]: { api: "openai-completions", baseUrl: "", models: [] } }; this.providerId = id; this.modelIndex = null; this.screen = "catalog"; this.selection = null; this.baselineSelection = null;
    });
  }
  addModel(id = ""): void {
    if (this.disabled || !this.providerId) return;
    id = id.trim();
    if (this.models.some(model => model.id === id)) { this.message = id ? "Enter an unused model identifier." : "Enter the current model's ID first."; this.changed(); return; }
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
    if (!this.headerDraft.name.trim()) { this.fieldErrors.headers = "Enter a header name."; this.changed(); return false; }
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
      if (!location.header?.trim()) { this.fieldErrors.headers = "Enter a header name."; this.changed(); return; }
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
    if ((this.screen === "credential" || this.secret) && (!this.secret || this.secret !== this.secret.trim() || /[\r\n]/.test(this.secret))) { this.fieldErrors.apiKey = "The API key can't be empty, have leading/trailing whitespace or contain newlines."; this.changed(); return false; }
    if (this.screen === "credential") {
      return this.write("set_model_api_key", { provider: this.providerId, api_key: this.secret }, "Stored API key saved; other sources unchanged, connection validity unverified.");
    }
    if (this.screen === "default" || this.screen === "summary") {
      if (this.screen === "default" && !this.selection) { this.fieldErrors.model = "Select the backend default model."; this.changed(); return false; }
      return this.write(this.screen === "default" ? "set_default_model" : "set_summary_model", { provider: this.selection?.provider ?? null, model_id: this.selection?.modelId ?? null, ...(this.screen === "default" ? { thinking_level: this.selection!.thinkingLevel } : {}) }, "");
    }
    for (const definition of Object.values(this.draft)) {
      if (definition.baseUrl !== undefined) {
        let valid = false;
        try { valid = ["http:", "https:"].includes(new URL(String(definition.baseUrl)).protocol); }
        catch { /* Invalid addresses are left to the field hint. */ }
        if (!valid) this.fieldErrors.baseUrl = "Enter an http(s) API URL.";
      }
      const ids = new Set<string>();
      for (const [index, model] of ((Array.isArray(definition.models) ? definition.models : []) as Record<string, unknown>[]).entries()) {
        const prefix = `catalog-model-${index}-`;
        if (typeof model.id !== "string" || !model.id.trim() || ids.has(model.id)) this.fieldErrors[prefix + "id"] = "Model ID can't be empty or duplicate another model of the same provider.";
        if (typeof model.id === "string") ids.add(model.id);
        for (const field of ["contextWindow", "maxTokens"] as const) if (model[field] !== undefined && (!Number.isInteger(model[field]) || Number(model[field]) <= 0)) this.fieldErrors[prefix + field] = "Capacity must be a positive integer.";
        if (Number(model.maxTokens) > Number(model.contextWindow)) this.fieldErrors[prefix + "maxTokens"] = "Output limit can't exceed context capacity.";
      }
    }
    if (Object.keys(this.fieldErrors).length) { this.message = "Fix the marked fields and save."; this.changed(); return false; }
    // The catalog and stored credential write as two revision steps; the key isn't submitted before the first step verifies.
    const secret = this.secret, provider = this.providerId;
    const catalogChanged = !same(this.draft, this.view!.providers);
    if (catalogChanged) {
      const saved = await this.write("save_model_catalog", { providers: clone(this.draft) }, "Model catalog saved; connection test not yet run.");
      if (!saved || this.disabled || this.providerId !== provider) {
        if (secret) { this.message += " The stored API key wasn't submitted; verify the catalog and enter it again."; this.changed(); }
        return false;
      }
    }
    if (!secret) return catalogChanged;
    const saved = await this.write("set_model_api_key", { provider, api_key: secret }, "Stored API key saved; other sources unchanged, connection validity unverified.");
    if (!saved && catalogChanged) { this.message = `Model catalog saved. ${this.message}`; this.changed(); }
    return saved;
  }
  private async write(op: ModelWrite, params: Record<string, unknown>, success: string): Promise<boolean> {
    if (this.disabled) return false;
    const generation = ++this.generation;
    this.testing = false; this.testMessage = "";
    this.pending = { op, provider: this.providerId, instanceId: this.instanceId, revision: this.view!.revision };
    this.phase = "saving";
    // Input is cleared right after the request; pending only keeps linking info.
    const reply = this.request(op, { ...params, expected_revision: this.view!.revision });
    this.secret = ""; this.headerDraft = null; this.draft = hideSecrets(this.draft) as Catalog; this.changed();
    const result = await reply;
    if (generation !== this.generation || this.context().instanceId !== this.instanceId) return false;
    if (!result.ok) {
      const uncertain = result.error.outcome === "unknown" || result.error.outcome === "disconnected";
      this.phase = uncertain ? "unknown" : result.error.code === "config_conflict" ? "conflict" : "error";
      if (!uncertain) this.pending = null;
      this.message = uncertain ? "Outcome unverified; read back the original instance configuration. It won't be resent." : `${result.error.outcome === "not_sent" ? "The request wasn't sent." : "The operation was rejected."}${result.error.message}`;
      if (this.phase === "conflict") {
        const refreshed = await this.read(true);
        this.phase = "conflict";
        this.message = refreshed ? "The configuration was changed by another client. The current value was read back and your draft is kept; compare before saving or discarding." : "Configuration conflict; your draft is kept but reading the current value failed. Read again and compare — it won't be resent.";
      }
      this.changed(); return false;
    }
    this.phase = "ready";
    const refreshed = await this.read(false, true);
    this.message = refreshed ? success : "The operation got a successful response but reading back failed. Verify the original configuration — it won't be resent.";
    this.changed(); return refreshed;
  }
  async removeProvider(): Promise<boolean> {
    if (this.disabled || this.dirty || !this.providerId) return false;
    const saved = await this.write("remove_model_provider", { provider: this.providerId }, "The provider catalog entry and its stored entry were removed; environment sources are still managed by the backend launch environment.");
    if (saved) { this.providerId = null; this.modelIndex = null; this.changed(); } return saved;
  }
  async removeModel(): Promise<boolean> {
    if (this.disabled || this.modelIndex === null) return false;
    this.editProvider("models", this.models.filter((_, index) => index !== this.modelIndex));
    const saved = await this.save(); if (saved) this.modelIndex = null; return saved;
  }
  removeStoredCredential(): Promise<boolean> { return this.disabled || this.dirty || !this.providerId ? Promise.resolve(false) : this.write("remove_model_api_key", { provider: this.providerId }, "The selected stored entry was removed; other sources or validity weren't verified."); }
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
