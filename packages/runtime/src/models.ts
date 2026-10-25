import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { InMemoryModelsStore, type Api, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  configRevision, loadDefaultModel, loadModelCatalogFile, loadSummaryModel, readModelConfigMetadata,
  removeProviderCredential, resolveConfiguredModel, restoreCatalogSecrets, restoreConfigFiles, sanitizeCatalog,
  saveDefaultModel, saveModelCatalogFile, saveSummaryModel, setProviderApiKey, snapshotConfigFiles,
  validateApiKey, validateModelCatalog, type SummaryModel, type ModelConfigMetadata,
} from "@ruukoto/agent/model-config.ts";
import { createModelCatalog, ModelSelectionError, type ModelCatalog, type ModelOption } from "@ruukoto/agent/model-selection.ts";
import { createApprovalReviewer, type ApprovalReviewer } from "@ruukoto/agent/review.ts";
import { RuntimeApiError } from "@ruukoto/core/api-error.ts";
import type { Store } from "@ruukoto/core/store.ts";
import type { ModelSelection } from "@ruukoto/core/types.ts";
import { parseModelSelection } from "@ruukoto/core/model-selection.ts";

interface RuntimeModelStack {
  modelRuntime: ModelRuntime;
  modelCatalog: ModelCatalog;
  model: Model<Api>;
  defaultSelection: ModelSelection;
  reviewer: ApprovalReviewer;
}

type CatalogProvider = Record<string, unknown> & { name?: string; models?: Array<Record<string, unknown> & { id: string; name?: string }> };

interface RuntimeModelsDeps {
  store: Store;
  config: {
    agentDir: string;
    modelProvider?: string;
    modelId?: string;
    thinkingLevel?: ModelSelection["thinkingLevel"];
    autoReview?: { timeoutMs?: number; maxTokens?: number };
  };
  countActiveCompactions(providers: string[]): number;
  publishStack(stack: Readonly<RuntimeModelStack>): void;
  flushPendingMessages(): Promise<void>;
}

/** 模型配置与模型栈的唯一持有者；任务、Driver 和配置锁由 Runtime 持有。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-23-runtime-models.md
 */
export class RuntimeModels {
  private readonly deps: RuntimeModelsDeps;
  private stack!: RuntimeModelStack;
  private gate: Set<string> | null = null;
  private gateSettled: Promise<void> = Promise.resolve();
  private closing = false;
  private readonly operations = new Set<Promise<void>>();

  constructor(deps: RuntimeModelsDeps) { this.deps = deps; }

  get current(): Readonly<RuntimeModelStack> { return this.stack; }

  async initialize(): Promise<void> { this.stack = await this.buildStack(false); }

  /** 仅等待配置准入恢复；消息冲刷可能仍在执行，不能用于停止收尾。 */
  whenConfigIdle(): Promise<void> { return this.gateSettled; }

  /** 同步封闭新操作，再等待已受理操作的事件与消息冲刷全部收尾。 */
  async close(): Promise<void> {
    this.closing = true;
    await Promise.all(this.operations);
  }

  private assertOpen(): void {
    if (this.closing) throw new RuntimeApiError("stopping", "后台正在停止");
  }

  private async manage<T>(action: () => Promise<T>): Promise<T> {
    this.assertOpen();
    let finish!: () => void;
    const completion = new Promise<void>(resolve => { finish = resolve; });
    this.operations.add(completion);
    try { return await action(); }
    finally { this.operations.delete(completion); finish(); }
  }

  list(input: { provider?: string; offset?: number; limit?: number } = {}) {
    return this.manage(() => this.current.modelCatalog.list(input));
  }

  private async buildStack(validateCatalog: boolean): Promise<RuntimeModelStack> {
    const { config } = this.deps;
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(config.agentDir, "auth.json"), modelsPath: path.join(config.agentDir, "models.json"),
      modelsStore: new InMemoryModelsStore(), refreshOnCreate: false,
    });
    if (validateCatalog) {
      for (const [providerId, def] of Object.entries(loadModelCatalogFile(config.agentDir).providers)) {
        for (const definition of ((def?.models as Array<{ id?: unknown }> | undefined) ?? [])) {
          if (typeof definition?.id === "string" && !modelRuntime.getModel(providerId, definition.id)) {
            throw new RuntimeApiError("model_config_invalid", `provider ${providerId} 的模型 ${definition.id} 未通过 SDK 校验（检查 api/baseUrl 等协议字段）`);
          }
        }
      }
    }
    const configured = resolveConfiguredModel(modelRuntime, config);
    if (!configured) throw new RuntimeApiError("no_model", validateCatalog
      ? "应用该配置后将没有可用模型，已回滚"
      : "未找到可用模型：models.json 中没有 provider，或指定的 provider/model 不存在");
    const modelCatalog = await createModelCatalog(modelRuntime, config.agentDir, configured.model);
    const defaultSelection = { provider: configured.model.provider, modelId: configured.model.id, thinkingLevel: configured.thinkingLevel };
    await modelCatalog.resolve(defaultSelection);
    const reviewer = createApprovalReviewer({ modelRuntime, modelCatalog, timeoutMs: config.autoReview?.timeoutMs, maxTokens: config.autoReview?.maxTokens });
    return { modelRuntime, modelCatalog, model: configured.model, defaultSelection, reviewer };
  }

  private async rebuild(): Promise<void> {
    const stack = await this.buildStack(true);
    this.stack = stack;
    this.deps.publishStack(stack);
  }

  /** 应用门闩检查：受影响 provider 的新任务在配置应用期间拒绝进入。 */
  assertAvailable(provider: string): void {
    if (this.gate?.has(provider)) {
      throw new RuntimeApiError("model_config_busy", "模型配置正在应用，请稍后重试");
    }
  }

  /** 异步解析后，调用方必须在实际登记的同步段复核门闩和目录身份。 */
  async resolveSelection(selection: ModelSelection, requireImages = false): Promise<() => void> {
    this.assertAvailable(selection.provider);
    const catalog = this.current.modelCatalog;
    const model = await catalog.resolve(selection);
    if (requireImages && !model.input.includes("image")) throw new RuntimeApiError("image_input_unsupported", "所选模型不支持图片输入");
    return () => {
      this.assertAvailable(selection.provider);
      if (this.current.modelCatalog !== catalog) throw new RuntimeApiError("model_config_busy", "模型配置刚刚更新，请重试");
    };
  }

  /** 修订核对（乐观并发）：全部写操作按调用方读取时的修订应用。 */
  private assertConfigRevision(expected: unknown): void {
    if (typeof expected !== "string" || expected.length === 0) {
      throw new RuntimeApiError("invalid_params", "expected_revision 必须是非空字符串");
    }
    if (expected !== configRevision(this.deps.config.agentDir)) {
      throw new RuntimeApiError("config_conflict", "模型配置已被其他修改更新，请重新加载后重试");
    }
  }

  /** 门闩与占用核查之间不能让出执行；写入或重建失败回滚，解除门闩后才冲刷消息。 */
  private async applyModelConfigChange(affected: string[], fn: () => void): Promise<void> {
    this.assertOpen();
    if (this.gate) throw new RuntimeApiError("model_config_busy", "模型配置正在应用，请稍后重试");
    this.gate = new Set(affected);
    const blocked = this.deps.store.countActiveTasksByProviders(affected) + this.deps.countActiveCompactions(affected);
    if (blocked > 0) {
      this.gate = null;
      throw new RuntimeApiError(
        "model_config_blocked",
        `有 ${blocked} 个任务或压缩操作正在使用受影响的提供方，请先完成或取消这些操作`,
      );
    }
    let settle!: () => void;
    this.gateSettled = new Promise<void>((resolve) => (settle = resolve));
    const snapshot = snapshotConfigFiles(this.deps.config.agentDir);
    try {
      fn();
      await this.rebuild();
    } catch (err) {
      // 回滚：恢复旧字节并重建旧模型栈，重启后也不会静默选用部分新配置
      restoreConfigFiles(this.deps.config.agentDir, snapshot);
      await this.rebuild().catch(() => {
        // 文件已恢复；旧栈重建失败时保留原内存模型栈与本次配置失败。
      });
      const code = err instanceof RuntimeApiError || err instanceof ModelSelectionError ? err.code : "model_config_invalid";
      throw new RuntimeApiError(code, "模型配置无法应用，原配置文件已恢复；请检查提供方地址、API 类型与认证配置后重试");
    } finally {
      this.gate = null;
      settle();
      // 成功与回滚都解除门闩，既有待投递消息用原键和当前配置重新核实。
      if (!this.closing) {
        await this.deps.flushPendingMessages().catch(() => {
          process.stderr.write("[ruukoto:model-config] 模型配置应用后冲刷消息失败，请检查后台消息投递状态\n");
        });
      }
    }
  }

  /** 模型配置视图（脱敏）：目录中 apiKey 以 true 代替，凭据只报是否配置与类型。 */
  getConfig(): ModelConfigMetadata & {
    revision: string;
    providers: Record<string, any>;
    defaultModel: ModelSelection | null;
    summaryModel: SummaryModel | null;
    runtimeDefault: ModelSelection;
    runtimeOverrides: { model: boolean; thinking: boolean };
    busyProviders: string[];
  } {
    const agentDir = this.deps.config.agentDir;
    let defaultModel: ModelSelection | null = null;
    try {
      defaultModel = loadDefaultModel(agentDir);
    } catch {
      // 损坏的默认配置文件不阻塞配置视图（修订指纹仍覆盖它，保存可修复）
    }
    return {
      revision: configRevision(agentDir),
      providers: sanitizeCatalog(loadModelCatalogFile(agentDir).providers),
      ...readModelConfigMetadata(agentDir, this.current.modelRuntime, this.current.defaultSelection.provider),
      defaultModel,
      summaryModel: this.readSummaryModel(),
      runtimeDefault: this.current.defaultSelection,
      runtimeOverrides: { model: this.deps.config.modelProvider !== undefined, thinking: this.deps.config.thinkingLevel !== undefined },
      busyProviders: this.gate ? [...this.gate] : [],
    };
  }

  /** 摘要模型配置（损坏按未设置展示；修订指纹仍覆盖它，保存可修复）。 */
  private readSummaryModel(): SummaryModel | null {
    try {
      return loadSummaryModel(this.deps.config.agentDir);
    } catch {
      return null;
    }
  }

  /** 删除 provider/模型前核实引用：被持久默认、摘要模型、会话或逻辑角色引用时拒绝，先提供替代项。 */
  private assertSelectionNotReferenced(provider: string, modelId?: string): void {
    let defaultModel: ModelSelection | null = null;
    try {
      defaultModel = loadDefaultModel(this.deps.config.agentDir);
    } catch {
      // 损坏的默认配置文件不可能构成有效引用，按未配置处理
    }
    const summaryModel = this.readSummaryModel();
    const refs = this.deps.store.countProviderReferences(provider, modelId);
    const usedByDefault = defaultModel?.provider === provider && (modelId === undefined || defaultModel.modelId === modelId);
    const usedBySummary = summaryModel?.provider === provider && (modelId === undefined || summaryModel.modelId === modelId);
    if (usedByDefault || usedBySummary || refs.sessions > 0 || refs.roles > 0) {
      const target = modelId === undefined ? `提供方 ${provider}` : `模型 ${provider}/${modelId}`;
      const parts: string[] = [];
      if (usedByDefault) parts.push("后台默认模型");
      if (usedBySummary) parts.push("摘要模型");
      if (refs.sessions > 0) parts.push(`${refs.sessions} 个会话`);
      if (refs.roles > 0) parts.push(`${refs.roles} 个逻辑角色`);
      throw new RuntimeApiError("provider_in_use", `${target} 仍被引用（${parts.join("、")}），请先切换这些引用到其他可用项`);
    }
  }

  /** 保存模型目录：修订核对 → 结构校验 → 删除项引用核实 → 受影响 provider（修改/删除）受门闩应用。 */
  async saveCatalog(input: { providers: unknown; expectedRevision: unknown }): Promise<{ revision: string }> {
    return this.manage(async () => {
      this.assertConfigRevision(input.expectedRevision);
      const before: Record<string, CatalogProvider> = loadModelCatalogFile(this.deps.config.agentDir).providers;
      // 脱敏视图原样回写：占位符还原为原值，未改动的秘密不必重新输入
      const providers = restoreCatalogSecrets(input.providers, before);
      const errors = validateModelCatalog({ providers });
      if (errors.length > 0) {
        throw new RuntimeApiError("invalid_params", `模型目录结构无效：${errors.join("；")}`);
      }
      const next = { providers: providers as Record<string, CatalogProvider> };
      // Note: 见 .agents/notes/implemented/simplification/2026-10-25-configuration-checks.md
      const affected = [...new Set([...Object.keys(before), ...Object.keys(next.providers)])].filter(id => {
        if (!(id in next.providers)) return true;
        const { name: _oldName, models: oldModels = [], ...oldProvider } = before[id] ?? {};
        const { name: _newName, models: newModels = [], ...newProvider } = next.providers[id];
        if (!isDeepStrictEqual(oldProvider, newProvider)) return true;
        const remaining = new Map(newModels.map(({ name: _name, ...model }) => [model.id, model]));
        for (const { name: _name, ...model } of oldModels) {
          if (!isDeepStrictEqual(model, remaining.get(model.id))) return true;
          remaining.delete(model.id);
        }
        return [...remaining.keys()].some(modelId => this.current.modelRuntime.getModel(id, modelId) !== undefined);
      });
      // 经目录保存删除 provider/模型与 remove_model_provider 同一约束，不留悬空引用
      for (const id of Object.keys(before)) {
        if (!(id in next.providers)) {
          this.assertSelectionNotReferenced(id);
          continue;
        }
        const oldModels = new Set((((before[id]?.models as Array<{ id?: unknown }> | undefined) ?? [])).map((m) => m?.id).filter((v): v is string => typeof v === "string"));
        const newModels = new Set((((next.providers[id]?.models as Array<{ id?: unknown }> | undefined) ?? [])).map((m) => m?.id).filter((v): v is string => typeof v === "string"));
        for (const modelId of oldModels) {
          if (!newModels.has(modelId)) this.assertSelectionNotReferenced(id, modelId);
        }
      }
      await this.applyModelConfigChange(affected, () => {
        saveModelCatalogFile(this.deps.config.agentDir, next);
      });
      this.deps.store.withTx(() => this.deps.store.appendEvent({ type: "model.config_changed", kind: "catalog" }));
      return { revision: configRevision(this.deps.config.agentDir) };
    });
  }

  async setApiKey(input: { provider: unknown; apiKey: unknown; expectedRevision: unknown }): Promise<{ revision: string; configured: boolean }> {
    return this.manage(async () => {
      const provider = typeof input.provider === "string" ? input.provider.trim() : "";
      if (!provider) throw new RuntimeApiError("invalid_params", "provider 必须是非空字符串");
      const invalid = validateApiKey(input.apiKey);
      if (invalid) throw new RuntimeApiError("invalid_params", invalid);
      this.assertConfigRevision(input.expectedRevision);
      await this.applyModelConfigChange([provider], () => {
        setProviderApiKey(this.deps.config.agentDir, provider, input.apiKey as string);
      });
      this.deps.store.withTx(() => this.deps.store.appendEvent({ type: "model.config_changed", kind: "api_key", provider }));
      return { revision: configRevision(this.deps.config.agentDir), configured: true };
    });
  }

  async removeApiKey(input: { provider: unknown; expectedRevision: unknown }): Promise<{ revision: string; configured: boolean }> {
    return this.manage(async () => {
      const provider = typeof input.provider === "string" ? input.provider.trim() : "";
      if (!provider) throw new RuntimeApiError("invalid_params", "provider 必须是非空字符串");
      this.assertConfigRevision(input.expectedRevision);
      await this.applyModelConfigChange([provider], () => {
        removeProviderCredential(this.deps.config.agentDir, provider);
      });
      this.deps.store.withTx(() => this.deps.store.appendEvent({ type: "model.config_changed", kind: "api_key", provider }));
      return { revision: configRevision(this.deps.config.agentDir), configured: false };
    });
  }

  /**
   * 删除 provider：被持久默认模型、任何会话或逻辑角色引用时拒绝
   * （provider_in_use）；否则从 models.json 与 auth.json 一并移除。
   */
  async removeProvider(input: { provider: unknown; expectedRevision: unknown }): Promise<{ revision: string }> {
    return this.manage(async () => {
      const provider = typeof input.provider === "string" ? input.provider.trim() : "";
      if (!provider) throw new RuntimeApiError("invalid_params", "provider 必须是非空字符串");
      this.assertConfigRevision(input.expectedRevision);
      this.assertSelectionNotReferenced(provider);
      await this.applyModelConfigChange([provider], () => {
        const catalog = loadModelCatalogFile(this.deps.config.agentDir);
        if (provider in catalog.providers) {
          delete catalog.providers[provider];
          saveModelCatalogFile(this.deps.config.agentDir, catalog);
        }
        removeProviderCredential(this.deps.config.agentDir, provider);
      });
      this.deps.store.withTx(() => this.deps.store.appendEvent({ type: "model.config_changed", kind: "catalog", provider }));
      return { revision: configRevision(this.deps.config.agentDir) };
    });
  }

  /**
   * 设置后台默认模型（持久化到 default-model.json）：只影响之后新建的
   * 会话；既有会话钉住的选择不改写，任务不需要应用门闩。显式启动参数
   * （--model）优先于持久默认。
   */
  async setDefault(input: { provider: unknown; modelId: unknown; thinkingLevel: unknown; expectedRevision: unknown }): Promise<{ revision: string; defaultModel: ModelSelection }> {
    return this.manage(async () => {
      const selection = parseModelSelection({ provider: input.provider, modelId: input.modelId, thinkingLevel: input.thinkingLevel });
      // 必须能在当前目录中解析（成员 + 思考档位），否则新会话将拿到不可用默认
      const option = await this.catalogOption(selection.provider, selection.modelId);
      if (!option.thinkingLevels.includes(selection.thinkingLevel)) {
        throw new RuntimeApiError("invalid_params", `该模型不支持思考档位 ${selection.thinkingLevel}`);
      }
      // 门闩检查、修订核对与文件写入在同一同步段：并发保存只会有一方通过修订核对
      this.assertOpen();
      if (this.gate) throw new RuntimeApiError("model_config_busy", "模型配置正在应用，请稍后重试");
      this.assertConfigRevision(input.expectedRevision);
      saveDefaultModel(this.deps.config.agentDir, selection);
      // 与启动/重建同一解析口径：显式 --model/--thinking 运行期间持久默认只落盘，不改运行时默认
      const configured = resolveConfiguredModel(this.current.modelRuntime, this.deps.config);
      if (configured) {
        this.stack = { ...this.current, model: configured.model, defaultSelection: { provider: configured.model.provider, modelId: configured.model.id, thinkingLevel: configured.thinkingLevel } };
      }
      this.deps.store.withTx(() => this.deps.store.appendEvent({ type: "model.config_changed", kind: "default_model", provider: selection.provider }));
      return { revision: configRevision(this.deps.config.agentDir), defaultModel: selection };
    });
  }

  /** 模型必须在当前目录中（setDefault 与 setSummary 共用的核对）。 */
  private async catalogOption(provider: string, modelId: string): Promise<ModelOption> {
    let offset = 0;
    for (;;) {
      const page = await this.current.modelCatalog.list({ provider, offset, limit: 100 });
      const option = page.models.find((m) => m.provider === provider && m.modelId === modelId);
      if (option) return option;
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    throw new RuntimeApiError("invalid_params", `模型不在后台已配置的目录中：${provider}/${modelId}`);
  }

  /**
   * 设置或清除上下文压缩的摘要模型（持久化到 summary-model.json）。
   * 每次摘要读取当前配置，不按任务钉版，不需要应用门闩；provider 与 modelId 都为 null 即清除。
   */
  async setSummary(input: { provider: unknown; modelId: unknown; expectedRevision: unknown }): Promise<{ revision: string; summaryModel: SummaryModel | null }> {
    return this.manage(async () => {
      let model: SummaryModel | null = null;
      if (input.provider !== null || input.modelId !== null) {
        if (typeof input.provider !== "string" || !input.provider.trim() || typeof input.modelId !== "string" || !input.modelId.trim()) {
          throw new RuntimeApiError("invalid_params", "provider 与 model_id 必须同为非空字符串，或同为 null（清除）");
        }
        await this.catalogOption(input.provider, input.modelId);
        model = { provider: input.provider, modelId: input.modelId };
      }
      this.assertOpen();
      if (this.gate) throw new RuntimeApiError("model_config_busy", "模型配置正在应用，请稍后重试");
      this.assertConfigRevision(input.expectedRevision);
      saveSummaryModel(this.deps.config.agentDir, model);
      this.deps.store.withTx(() => this.deps.store.appendEvent({ type: "model.config_changed", kind: "summary_model", provider: model?.provider }));
      return { revision: configRevision(this.deps.config.agentDir), summaryModel: model };
    });
  }

  /**
   * 显式探测先解析认证，再发一个 1-token 请求；30 秒后中止请求，仍等待 SDK 收尾。
   * 这是唯一的联网核实入口；本地校验不暗示模型服务可用。
   */
  async testConnection(input: { provider: unknown; modelId: unknown }): Promise<{ ok: boolean; detail: string }> {
    return this.manage(async () => {
      const provider = typeof input.provider === "string" ? input.provider.trim() : "";
      const modelId = typeof input.modelId === "string" ? input.modelId.trim() : "";
      if (!provider || !modelId) throw new RuntimeApiError("invalid_params", "provider 与 model_id 必须是非空字符串");
      let model: Model<Api>;
      try {
        model = await this.current.modelCatalog.resolve({ provider, modelId, thinkingLevel: "off" });
      } catch {
        return { ok: false, detail: "无法解析所选模型，请检查后台模型目录与认证配置后重试" };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const reply = await this.current.modelRuntime.completeSimple(
          model,
          { messages: [{ role: "user", content: "ping", timestamp: Date.now() }] },
          { maxTokens: 1, signal: controller.signal },
        );
        // completeSimple 不以 reject 报错：鉴权/HTTP/中止都以 stopReason 返回
        if (reply.stopReason !== "error" && reply.stopReason !== "aborted") return { ok: true, detail: `连接成功：${provider}/${modelId}` };
      } catch {
        // SDK 错误可能反射环境、命令或运行时凭据；仅返回下方固定诊断。
      } finally {
        clearTimeout(timer);
      }
      return { ok: false, detail: controller.signal.aborted ? "连接超时（30 秒）" : "连接失败，请检查提供方地址、API 类型与认证配置后重试" };
    });
  }
}
