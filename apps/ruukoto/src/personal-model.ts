import { createModels, createProvider, lazyStream, normalizeContext, type Api, type Context, type TranscriptContext, type Model, type Provider, type StreamOptions } from "@earendil-works/pi-ai";
import type { JsonValue } from "@earendil-works/chord";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { PersonalError } from "./personal-error.ts";
import type { PersonalModelMedia } from "./personal-media.ts";
import { randomUUID } from "node:crypto";
import type { ConversationId, EntryId, TaskId, Tx } from "@earendil-works/pi-durable";

export type PersonalModelConfig = {
  api: "openai-completions" | "openai-responses" | "anthropic-messages";
  baseUrl: string;
  modelId: string;
  apiKeyEnv: string;
  contextWindow: number;
  maxTokens: number;
  imageInput?: boolean;
};

export function parsePersonalModel(value: unknown): PersonalModelConfig {
  if (typeof value !== "object" || value === null || !("api" in value) || !("baseUrl" in value) || !("modelId" in value) || !("apiKeyEnv" in value) || !("contextWindow" in value) || !("maxTokens" in value)
    || (value.api !== "openai-completions" && value.api !== "openai-responses" && value.api !== "anthropic-messages")
    || typeof value.baseUrl !== "string" || typeof value.modelId !== "string" || value.modelId.trim() === ""
    || typeof value.apiKeyEnv !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(value.apiKeyEnv)
    || typeof value.contextWindow !== "number" || !Number.isSafeInteger(value.contextWindow) || value.contextWindow < 1024
    || ("imageInput" in value && typeof value.imageInput !== "boolean")
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
  return { api: value.api, baseUrl: value.baseUrl, modelId: value.modelId, apiKeyEnv: value.apiKeyEnv, contextWindow: value.contextWindow, maxTokens: value.maxTokens, ...("imageInput" in value ? { imageInput: value.imageInput as boolean } : {}) };
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-25-personal-request-configuration.md
export function personalProvider(config: PersonalModelConfig, version?: string): Provider {
  const provider = version === undefined ? "personal" : `personal-${version}`;
  const model: Model<PersonalModelConfig["api"]> = {
    id: config.modelId, name: config.modelId, api: config.api, provider, baseUrl: config.baseUrl,
    reasoning: false, input: config.imageInput ? ["text", "image"] : ["text"], contextWindow: config.contextWindow, maxTokens: config.maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  return createProvider({
    id: provider, name: "个人模型", models: [model],
    auth: { apiKey: { name: "个人模型凭据", resolve: async () => {
      const apiKey = process.env[config.apiKeyEnv];
      if (!apiKey) throw new PersonalError("model_credentials_missing", "模型凭据未配置，请设置向导中指定的环境变量后重启。");
      return { auth: { apiKey } };
    } } },
    api: { "openai-completions": openAICompletionsApi(), "openai-responses": openAIResponsesApi(), "anthropic-messages": anthropicMessagesApi() },
  });
}

export type PersonalReferenceSelection = { conversationId: ConversationId; generation?: TaskId; configurations?: { commands: string | null; services: string | null; webSearch?: string | null; mcp?: { service: string; version: string | null }[] }; memory: { memory: EntryId; version: number; revision: EntryId }[]; skills: { version: string; snapshotEntry: EntryId } };
export type RequestEvidence = { requestId: string; sessionId: string; provider: string; modelId: string; input: JsonValue; reasoning: string; payload?: JsonValue; imageMappings?: JsonValue; references?: PersonalReferenceSelection };

export async function personalModelRequestSelection(tx: Tx, toolId: TaskId): Promise<PersonalReferenceSelection | undefined> {
  const tool = await tx.task(toolId), input = tool?.input;
  if (tool?.kind !== "pi.tool" || !input || typeof input !== "object" || Array.isArray(input) || input.kind !== "model" || typeof input.assistant !== "number") throw new PersonalError("model_tool_source_invalid", "工具缺少原模型响应身份，未开始操作；请保留档案并查询原输入。");
  const assistant = await tx.entry(input.assistant as EntryId);
  if (assistant?.kind !== "pi.assistant" || assistant.byTaskId !== tool.owner || assistant.conversationId !== tool.conversationId) throw new PersonalError("model_tool_source_invalid", "工具的原模型响应无法核实，未开始操作；请保留档案并查询原输入。");
  let cursor;
  do {
    const page = await tx.scanEntries({ conversationId: tool.conversationId, maxEntryId: assistant.id, order: "descending" }, 256, cursor);
    for (const entry of page.items) {
      const data = entry.data;
      if (entry.kind !== "ruukoto.model-request" || !data || typeof data !== "object" || Array.isArray(data)) continue;
      const refs = data.references;
      if (!refs || typeof refs !== "object" || Array.isArray(refs) || refs.generation !== tool.owner) continue;
      if (refs.conversationId !== tool.conversationId || !refs.configurations || typeof refs.configurations !== "object" || Array.isArray(refs.configurations) || ![refs.configurations.commands, refs.configurations.services].every(value => value === null || typeof value === "string") || !Array.isArray(refs.memory) || !refs.skills || typeof refs.skills !== "object" || Array.isArray(refs.skills) || typeof refs.skills.version !== "string" || typeof refs.skills.snapshotEntry !== "number") throw new PersonalError("model_selection_invalid", "原模型请求的配置选择无法核实，未开始操作；请保留档案并查询原输入。");
      return refs as PersonalReferenceSelection;
    }
    cursor = page.next;
  } while (cursor);
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

// 所有生成与压缩请求都经过 provider；hook 普通异常不会阻止 durable 继续请求。
export function recordedModels(provider: Provider, record: (evidence: RequestEvidence) => Promise<void>, media?: PersonalModelMedia, prepareInput?: (input: TranscriptContext, options: StreamOptions | undefined) => Promise<{ input: TranscriptContext; references: PersonalReferenceSelection }>) {
  const models = createModels();
  const prepare = async (model: Model<Api>, original: Context, options: StreamOptions | undefined) => {
    if (!options?.sessionId) throw new PersonalError("model_source_missing", "模型请求缺少持久会话来源，已停止请求。");
    const references = prepareInput ? await prepareInput(normalizeContext(original), options) : undefined;
    const input = references?.input ?? original;
    const images = input.messages.some(message => message.role !== "assistant" && Array.isArray(message.content) && message.content.some(part => part.type === "image"));
    if (images && !model.input.includes("image")) throw new PersonalError("image_input_unsupported", "当前模型不支持图片，未发送缺图请求；请由拥有者选择支持图片的模型。");
    if (images && !media) throw new PersonalError("image_reference_invalid", "原图片的持久来源无法核实，已停止模型请求；请保留档案。");
    const prepared = media ? await media.prepare(input, options.sessionId) : { input, snapshot: json, imageMappings: undefined };
    const evidence: RequestEvidence = { requestId: randomUUID(), sessionId: options.sessionId, provider: model.provider, modelId: model.id, input: prepared.snapshot(input), ...(references ? { references: references.references } : {}), ...(prepared.imageMappings ? { imageMappings: prepared.imageMappings } : {}), reasoning: "reasoning" in options && typeof options.reasoning === "string" ? options.reasoning : "off" };
    await record(evidence);
    options.signal?.throwIfAborted();
    return { input: prepared.input, options: {
      onPayload: async (payload: unknown) => {
        const changed = await options.onPayload?.(payload, model);
        await record({ ...evidence, payload: prepared.snapshot(changed ?? payload, true) });
        options.signal?.throwIfAborted();
        return changed;
      },
    } };
  };
  const setRecordedProvider = (provider: Provider) => models.setProvider({
    ...provider,
    stream: (model, input, options) => lazyStream(model, async () => { const prepared = await prepare(model, input, options); return provider.stream(model, normalizeContext(prepared.input), Object.assign({}, options, prepared.options)); }),
    streamSimple: (model, input, options) => lazyStream(model, async () => { const prepared = await prepare(model, input, options); return provider.streamSimple(model, normalizeContext(prepared.input), { ...options, ...prepared.options }); }),
  });
  setRecordedProvider(provider);
  return Object.assign(models, { setRecordedProvider });
}
