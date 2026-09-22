import * as fs from "node:fs";
import * as path from "node:path";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelSelection } from "../core/types.ts";

export class ModelSelectionError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface ModelOption {
  provider: string;
  modelId: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  thinkingLevels: ModelSelection["thinkingLevel"][];
  available: boolean;
  errorCode: string | null;
}

export interface ModelCatalog {
  resolve(selection: ModelSelection): Promise<Model<Api>>;
  list(options?: { provider?: string; offset?: number; limit?: number }): Promise<{
    models: ModelOption[]; total: number; nextOffset: number | null;
  }>;
}

/** 只纳入启动时显式配置的提供方；不把 SDK 内置全目录作为用户配置。 */
export async function createModelCatalog(runtime: ModelRuntime, agentDir: string, explicitModel?: { provider: string; id?: string; modelId?: string }): Promise<ModelCatalog> {
  const providers = new Set<string>();
  const file = path.join(agentDir, "models.json");
  if (fs.existsSync(file)) {
    try {
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const provider of Object.keys(config.providers ?? {})) providers.add(provider);
    } catch { throw new ModelSelectionError("model_config_invalid", "模型配置无法读取，请检查后台 models.json"); }
  }
  try {
    for (const credential of await runtime.listCredentials()) providers.add(credential.providerId);
  } catch { throw new ModelSelectionError("model_auth_error", "无法读取后台模型凭据配置"); }
  if (explicitModel) providers.add(explicitModel.provider);
  const models = runtime.getModels().filter((model) => providers.has(model.provider));
  const auth = async (provider: string): Promise<string | null> => {
    try { return await runtime.checkAuth(provider) ? null : "model_auth_missing"; }
    catch { return "model_auth_error"; }
  };
  return {
    async resolve(selection) {
      if (!selection || typeof selection.provider !== "string" || typeof selection.modelId !== "string" || typeof selection.thinkingLevel !== "string") {
        throw new ModelSelectionError("invalid_model_selection", "必须提供完整的提供方、模型和思考强度");
      }
      const model = models.find((m) => m.provider === selection.provider && m.id === selection.modelId);
      if (!model) throw new ModelSelectionError("model_not_found", "模型不在后台已配置的目录中");
      if (!getSupportedThinkingLevels(model).includes(selection.thinkingLevel)) {
        throw new ModelSelectionError("thinking_not_supported", "该模型不支持所选思考强度，请重新选择");
      }
      const error = await auth(model.provider);
      if (error) throw new ModelSelectionError(error, "模型认证材料不可用，请检查后台凭据配置");
      modelResponseBudget(model);
      return model;
    },
    async list(options = {}) {
      const filtered = models.filter((m) => !options.provider || m.provider === options.provider);
      const offset = Math.max(0, Math.floor(options.offset ?? 0));
      const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
      const statuses = new Map<string, string | null>();
      const result: ModelOption[] = [];
      for (const model of filtered.slice(offset, offset + limit)) {
        if (!statuses.has(model.provider)) statuses.set(model.provider, await auth(model.provider));
        const errorCode = statuses.get(model.provider)!;
        result.push({ provider: model.provider, modelId: model.id, name: model.name,
          contextWindow: model.contextWindow, maxTokens: model.maxTokens,
          thinkingLevels: getSupportedThinkingLevels(model), available: errorCode === null, errorCode });
      }
      return { models: result, total: filtered.length, nextOffset: offset + limit < filtered.length ? offset + limit : null };
    },
  };
}

/** pi 0.85.1 的响应上限包含思考；按完整上限预留，不重复扣除思考 token。 */
export function modelResponseBudget(model: Model<Api>): { contextWindow: number; maxTokens: number; thinkingBudget: number } {
  if (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0 || !Number.isFinite(model.maxTokens) || model.maxTokens <= 0 || model.maxTokens > model.contextWindow) {
    throw new ModelSelectionError("model_budget_invalid", "模型缺少可靠的上下文窗口或输出上限");
  }
  return { contextWindow: model.contextWindow, maxTokens: model.maxTokens, thinkingBudget: 0 };
}
