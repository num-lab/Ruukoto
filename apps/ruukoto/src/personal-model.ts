import { createModels, createProvider, lazyStream, type Api, type Model, type Provider, type StreamOptions } from "@earendil-works/pi-ai";
import type { JsonValue } from "@earendil-works/chord";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { PersonalError } from "./personal-error.ts";
import { randomUUID } from "node:crypto";

export type PersonalModelConfig = {
  api: "openai-completions" | "openai-responses" | "anthropic-messages";
  baseUrl: string;
  modelId: string;
  apiKeyEnv: string;
  contextWindow: number;
  maxTokens: number;
};

export function parsePersonalModel(value: unknown): PersonalModelConfig {
  if (typeof value !== "object" || value === null || !("api" in value) || !("baseUrl" in value) || !("modelId" in value) || !("apiKeyEnv" in value) || !("contextWindow" in value) || !("maxTokens" in value)
    || (value.api !== "openai-completions" && value.api !== "openai-responses" && value.api !== "anthropic-messages")
    || typeof value.baseUrl !== "string" || typeof value.modelId !== "string" || value.modelId.trim() === ""
    || typeof value.apiKeyEnv !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(value.apiKeyEnv)
    || typeof value.contextWindow !== "number" || !Number.isSafeInteger(value.contextWindow) || value.contextWindow < 1024
    || typeof value.maxTokens !== "number" || !Number.isSafeInteger(value.maxTokens) || value.maxTokens < 1 || value.maxTokens >= value.contextWindow) {
    throw new PersonalError("model_config_invalid", "模型配置无效，请运行配置向导重新选择模型与服务地址。");
  }
  let url: URL;
  try { url = new URL(value.baseUrl); } catch (error) {
    throw new PersonalError("model_config_invalid", "模型服务地址无效，请输入完整的 HTTPS 地址。", { cause: error });
  }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new PersonalError("model_config_invalid", "模型服务应使用不含凭据的 HTTPS 地址；本机服务可使用 HTTP。");
  }
  if (/^RUUKOTO_(OWNER_TOKEN|SERVICE|CODE_|DESKTOP_|.*_DIR$|PRODUCT$|EXECUTION_BACKEND$)/.test(value.apiKeyEnv)) {
    throw new PersonalError("model_credentials_invalid", "模型凭据不能使用内部控制、目录或服务环境变量，请重新配置凭据名称。");
  }
  return { api: value.api, baseUrl: value.baseUrl, modelId: value.modelId, apiKeyEnv: value.apiKeyEnv, contextWindow: value.contextWindow, maxTokens: value.maxTokens };
}

export function personalProvider(config: PersonalModelConfig): Provider {
  const model: Model<PersonalModelConfig["api"]> = {
    id: config.modelId, name: config.modelId, api: config.api, provider: "personal", baseUrl: config.baseUrl,
    reasoning: false, input: ["text"], contextWindow: config.contextWindow, maxTokens: config.maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  return createProvider({
    id: "personal", name: "个人模型", models: [model],
    auth: { apiKey: { name: "个人模型凭据", resolve: async () => {
      const apiKey = process.env[config.apiKeyEnv];
      if (!apiKey) throw new PersonalError("model_credentials_missing", "模型凭据未配置，请设置向导中指定的环境变量后重启。");
      return { auth: { apiKey } };
    } } },
    api: { "openai-completions": openAICompletionsApi(), "openai-responses": openAIResponsesApi(), "anthropic-messages": anthropicMessagesApi() },
  });
}

export type RequestEvidence = { requestId: string; sessionId: string; provider: string; modelId: string; input: JsonValue; reasoning: string; payload?: JsonValue };

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

// 所有生成与压缩请求都经过 provider；hook 普通异常不会阻止 durable 继续请求。
export function recordedModels(provider: Provider, record: (evidence: RequestEvidence) => Promise<void>) {
  const models = createModels();
  const prepare = async (model: Model<Api>, input: unknown, options: StreamOptions | undefined) => {
    if (!options?.sessionId) throw new PersonalError("model_source_missing", "模型请求缺少持久会话来源，已停止请求。");
    const evidence: RequestEvidence = { requestId: randomUUID(), sessionId: options.sessionId, provider: model.provider, modelId: model.id, input: json(input), reasoning: "reasoning" in options && typeof options.reasoning === "string" ? options.reasoning : "off" };
    await record(evidence);
    options.signal?.throwIfAborted();
    return {
      onPayload: async (payload: unknown) => {
        const changed = await options.onPayload?.(payload, model);
        await record({ ...evidence, payload: json(changed ?? payload) });
        options.signal?.throwIfAborted();
        return changed;
      },
    };
  };
  models.setProvider({
    ...provider,
    stream: (model, input, options) => lazyStream(model, async () => provider.stream(model, input, Object.assign({}, options, await prepare(model, input, options)))),
    streamSimple: (model, input, options) => lazyStream(model, async () => provider.streamSimple(model, input, { ...options, ...await prepare(model, input, options) })),
  });
  return models;
}
