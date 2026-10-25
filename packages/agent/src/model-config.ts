/**
 * 模型配置文件模块（issue 21 §3/§4）：models.json / auth.json / default-model.json /
 * summary-model.json（issue 30）的读写、结构校验、修订指纹与脱敏。
 *
 * 文件级模块：不依赖 Runtime，在线后台与离线配置工具共用。
 * 配置互斥见 `acquireConfigLock`（从 core/instance-lock.ts 再导出，与本模块
 * 同为离线配置工具的入口面）：在线后台启动时持有，离线写入前必须取得。
 *
 * 秘密卫生：apiKey 只写入文件，任何返回值/事件/错误消息不得携带；
 * 展示用 sanitizeCatalog 把 apiKey 与 headers 值替换为 true，回写用
 * restoreCatalogSecrets 还原。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { getSupportedThinkingLevels, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelSelection } from "@ruukoto/core/types.ts";
import { createModelCatalog } from "./model-selection.ts";

export { acquireConfigLock } from "@ruukoto/core/instance-lock.ts";

/** models.json 的顶层结构（provider 定义透传给 SDK，不做完整类型化）。 */
export interface ModelCatalogFile {
  providers: Record<string, any>;
}

export type ModelCredentialLocation =
  | { source: "storage"; type: "api_key" | "oauth" | "unknown" }
  | { source: "catalog"; field: "apiKey" | "headers"; scope: "provider" | "model" | "modelOverrides"; modelId?: string; header?: string }
  | { source: "runtime"; type: "api_key" }
  | { source: "sdk" };

export interface ConfiguredModelMetadata {
  provider: string;
  modelId: string;
  name: string;
  thinkingLevels: ModelSelection["thinkingLevel"][] | null;
}

export interface ModelCredentialSourceMetadata {
  locations: ModelCredentialLocation[];
  verification: "unverified";
}

export interface ModelConfigMetadata {
  credentials: Record<string, { configured: boolean; type?: string }>;
  credentialSources: Record<string, ModelCredentialSourceMetadata>;
  models: ConfiguredModelMetadata[];
}

const MODELS_FILE = "models.json";
const AUTH_FILE = "auth.json";
const DEFAULT_MODEL_FILE = "default-model.json";
const SUMMARY_MODEL_FILE = "summary-model.json";
/** 参与修订指纹与回滚快照的配置文件。 */
const CONFIG_FILES = [MODELS_FILE, AUTH_FILE, DEFAULT_MODEL_FILE, SUMMARY_MODEL_FILE] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 原子写入（临时文件 + rename）：0600 文件、0700 目录，崩溃不留下半截文件。 */
function atomicWrite(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // 个别平台不支持 chmod；写入时的 mode 已生效
  }
}

// ---------- models.json ----------

export function loadModelCatalogFile(agentDir: string): ModelCatalogFile {
  const file = path.join(agentDir, MODELS_FILE);
  if (!fs.existsSync(file)) return { providers: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error("models.json 不是合法 JSON，请修复后重试");
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed["providers"])) {
    throw new Error("models.json 结构无效：顶层必须是含 providers 对象的 JSON");
  }
  return { providers: parsed["providers"] as Record<string, any> };
}

/**
 * 模型目录结构校验（中文错误列表，空数组 = 通过）。
 * 只做结构校验；协议级深度校验（api/baseUrl 能否组成可用 provider）由 SDK
 * 在重建 ModelRuntime 时完成，失败整体回滚。
 */
export function validateModelCatalog(data: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(data) || !isPlainObject(data["providers"])) {
    return ["providers 必须是一个对象"];
  }
  const checkHeaders = (headers: unknown, label: string): void => {
    if (headers !== undefined && (!isPlainObject(headers) || Object.values(headers).some((v) => typeof v !== "string"))) {
      // 残留的脱敏占位符（true）同样拒绝：它只能沿用同名头的原值
      errors.push(`${label}：headers 必须是字符串键值对（*** 为脱敏占位，只能保留同名头的原值）`);
    }
  };
  const checkApiKey = (apiKey: unknown, label: string): void => {
    if (apiKey !== undefined && typeof apiKey !== "string") errors.push(`${label}：apiKey 必须是字符串（脱敏视图中的 true 为占位符，请重新输入或移除该字段）`);
  };
  for (const [providerId, def] of Object.entries(data["providers"])) {
    if (!providerId.trim()) {
      errors.push("provider id 不能为空");
      continue;
    }
    if (!isPlainObject(def)) {
      errors.push(`provider ${providerId}：定义必须是对象`);
      continue;
    }
    if (def["name"] !== undefined && typeof def["name"] !== "string") {
      errors.push(`provider ${providerId}：name 必须是字符串`);
    }
    if (def["baseUrl"] !== undefined) {
      const raw = def["baseUrl"];
      let ok = typeof raw === "string";
      if (ok) {
        try {
          const url = new URL(raw as string);
          ok = url.protocol === "http:" || url.protocol === "https:";
        } catch {
          ok = false;
        }
      }
      if (!ok) errors.push(`provider ${providerId}：baseUrl 必须是 http(s) URL`);
    }
    if (def["api"] !== undefined && (typeof def["api"] !== "string" || !(def["api"] as string).trim())) {
      errors.push(`provider ${providerId}：api 必须是非空字符串`);
    }
    checkApiKey(def["apiKey"], `provider ${providerId}`);
    checkHeaders(def["headers"], `provider ${providerId}`);
    if (def["modelOverrides"] !== undefined) {
      if (!isPlainObject(def["modelOverrides"])) errors.push(`provider ${providerId}：modelOverrides 必须是对象`);
      else {
        for (const [modelId, override] of Object.entries(def["modelOverrides"])) {
          if (!isPlainObject(override)) errors.push(`provider ${providerId} 的 modelOverrides ${modelId}：必须是对象`);
          else {
            checkApiKey(override["apiKey"], `provider ${providerId} 的 modelOverrides ${modelId}`);
            checkHeaders(override["headers"], `provider ${providerId} 的 modelOverrides ${modelId}`);
          }
        }
      }
    }
    if (def["models"] !== undefined && !Array.isArray(def["models"])) {
      errors.push(`provider ${providerId}：models 必须是数组`);
      continue;
    }
    const ids = new Set<string>();
    for (const [index, model] of ((def["models"] as unknown[] | undefined) ?? []).entries()) {
      const label = `provider ${providerId} 的第 ${index + 1} 个模型`;
      if (!isPlainObject(model)) {
        errors.push(`${label}：必须是对象`);
        continue;
      }
      if (typeof model["id"] !== "string" || !(model["id"] as string).trim()) {
        errors.push(`${label}：id 必须是非空字符串`);
      } else {
        if (ids.has(model["id"])) errors.push(`${label}：id 不能重复`);
        ids.add(model["id"]);
      }
      checkApiKey(model["apiKey"], label);
      checkHeaders(model["headers"], label);
      const contextWindow = model["contextWindow"];
      const maxTokens = model["maxTokens"];
      const contextOk = contextWindow === undefined || (Number.isInteger(contextWindow) && (contextWindow as number) > 0);
      const tokensOk = maxTokens === undefined || (Number.isInteger(maxTokens) && (maxTokens as number) > 0);
      if (!contextOk) errors.push(`${label}：contextWindow 必须是正整数`);
      if (!tokensOk) errors.push(`${label}：maxTokens 必须是正整数`);
      if (contextOk && tokensOk && contextWindow !== undefined && maxTokens !== undefined && (maxTokens as number) > (contextWindow as number)) {
        errors.push(`${label}：maxTokens 不能大于 contextWindow`);
      }
    }
  }
  return errors;
}

export function saveModelCatalogFile(agentDir: string, data: ModelCatalogFile): void {
  atomicWrite(path.join(agentDir, MODELS_FILE), JSON.stringify({ providers: data.providers }, null, 2));
}

// ---------- auth.json（模型凭据；oauth 条目原样保留） ----------

export function loadAuthFile(agentDir: string): Record<string, any> {
  const file = path.join(agentDir, AUTH_FILE);
  if (!fs.existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error("auth.json 不是合法 JSON，请修复后重试");
  }
  if (!isPlainObject(parsed)) throw new Error("auth.json 结构无效：顶层必须是 JSON 对象");
  return parsed as Record<string, any>;
}

/** 只列配置位置与模型能力；不解析凭据，也不把旧认证快照当作当前可用性。 */
export function readModelConfigMetadata(agentDir: string, runtime: ModelRuntime, explicitProvider?: string): ModelConfigMetadata {
  // Note: 见 .agents/notes/implemented/feature/2026-10-21-code-model-settings.md
  const catalog = loadModelCatalogFile(agentDir);
  const auth = loadAuthFile(agentDir);
  const providerIds = new Set([...Object.keys(catalog.providers), ...Object.keys(auth), ...runtime.getRegisteredProviderIds()]);
  if (explicitProvider) providerIds.add(explicitProvider);
  const credentials = new Map<string, ModelConfigMetadata["credentials"][string]>();
  const credentialSources = new Map<string, ModelCredentialSourceMetadata>();
  const models: ConfiguredModelMetadata[] = [];
  for (const provider of providerIds) {
    const locations: ModelCredentialLocation[] = [];
    if (Object.hasOwn(auth, provider)) {
      const type = auth[provider]?.type;
      const storedType = type === "api_key" || type === "oauth" ? type : "unknown";
      credentials.set(provider, { configured: true, type: storedType });
      locations.push({ source: "storage", type: storedType });
    }
    const definition: unknown = catalog.providers[provider];
    const recordLocations = (value: unknown, scope: "provider" | "model" | "modelOverrides", modelId?: string): void => {
      if (!isPlainObject(value)) return;
      if (Object.hasOwn(value, "apiKey")) locations.push({ source: "catalog", scope, modelId, field: "apiKey" });
      if (isPlainObject(value["headers"])) {
        for (const header of Object.keys(value["headers"])) locations.push({ source: "catalog", scope, modelId, field: "headers", header });
      }
    };
    recordLocations(definition, "provider");
    if (isPlainObject(definition)) {
      if (Array.isArray(definition["models"])) {
        for (const model of definition["models"]) {
          if (isPlainObject(model) && typeof model["id"] === "string") recordLocations(model, "model", model["id"]);
        }
      }
      if (isPlainObject(definition["modelOverrides"])) {
        for (const [modelId, override] of Object.entries(definition["modelOverrides"])) recordLocations(override, "modelOverrides", modelId);
      }
    }
    if (runtime.getProviderAuthStatus(provider).source === "runtime") locations.push({ source: "runtime", type: "api_key" });
    const registered = runtime.getRegisteredProviderConfig(provider);
    if (registered?.apiKey !== undefined || registered?.oauth || registered?.headers || registered?.models?.some((model) => model.headers)) locations.push({ source: "sdk" });
    credentialSources.set(provider, { locations, verification: "unverified" });
    const registeredModels = runtime.getModels(provider);
    for (const model of registeredModels) models.push({ provider, modelId: model.id, name: model.name, thinkingLevels: getSupportedThinkingLevels(model) });
    if (isPlainObject(definition) && Array.isArray(definition["models"])) {
      for (const model of definition["models"]) {
        if (!isPlainObject(model) || typeof model["id"] !== "string" || registeredModels.some((entry) => entry.id === model["id"])) continue;
        models.push({ provider, modelId: model["id"], name: typeof model["name"] === "string" ? model["name"] : model["id"], thinkingLevels: null });
      }
    }
  }
  return { credentials: Object.fromEntries(credentials), credentialSources: Object.fromEntries(credentialSources), models };
}

/** 离线设置仅构造 SDK 静态目录，不刷新目录或认证状态。 */
export async function loadModelConfigMetadata(agentDir: string): Promise<ModelConfigMetadata> {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: path.join(agentDir, MODELS_FILE), modelsStore: new InMemoryModelsStore(), refreshOnCreate: false });
  const configured = resolveConfiguredModel(runtime, { agentDir });
  return readModelConfigMetadata(agentDir, runtime, configured?.model.provider);
}

/** API key 格式校验：返回中文错误，null = 通过。 */
export function validateApiKey(key: unknown): string | null {
  if (typeof key !== "string" || key.length === 0) return "API key 不能为空";
  if (key !== key.trim()) return "API key 首尾不能含空白字符";
  if (/[\r\n]/.test(key)) return "API key 不能包含换行";
  return null;
}

/** 写入 provider 的 API key（保留其他 provider 与 oauth 条目）。 */
export function setProviderApiKey(agentDir: string, provider: string, key: string): void {
  if (!provider.trim()) throw new Error("provider 不能为空");
  const invalid = validateApiKey(key);
  if (invalid) throw new Error(invalid);
  const auth = loadAuthFile(agentDir);
  atomicWrite(path.join(agentDir, AUTH_FILE), JSON.stringify({ ...auth, [provider]: { type: "api_key", key } }, null, 2));
}

/** 删除 provider 的凭据条目（其他条目原样保留；不存在时不动文件）。 */
export function removeProviderCredential(agentDir: string, provider: string): void {
  const auth = loadAuthFile(agentDir);
  if (!Object.hasOwn(auth, provider)) return;
  delete auth[provider];
  atomicWrite(path.join(agentDir, AUTH_FILE), JSON.stringify(auth, null, 2));
}

// ---------- default-model.json（后台默认模型；显式启动参数优先） ----------

export function loadDefaultModel(agentDir: string): ModelSelection | null {
  const file = path.join(agentDir, DEFAULT_MODEL_FILE);
  if (!fs.existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`default-model.json 不是合法 JSON，请修复或删除后重试：${(err as Error).message}`);
  }
  const v = parsed as Partial<ModelSelection> | null;
  if (!v || typeof v.provider !== "string" || !v.provider.trim() || typeof v.modelId !== "string" || !v.modelId.trim() || typeof v.thinkingLevel !== "string") {
    return null; // 结构不完整视为未配置，启动回退到目录首个模型
  }
  return { provider: v.provider, modelId: v.modelId, thinkingLevel: v.thinkingLevel };
}

export function saveDefaultModel(agentDir: string, selection: ModelSelection): void {
  atomicWrite(path.join(agentDir, DEFAULT_MODEL_FILE), JSON.stringify(selection, null, 2));
}

// ---------- summary-model.json（上下文压缩的摘要模型，issue 30；未设置 = 用会话当前模型） ----------

export interface SummaryModel {
  provider: string;
  modelId: string;
}

/** 未设置返回 null；文件损坏或结构不完整抛错（已配置但无法解析时摘要按失败处理，不改用会话模型）。 */
export function loadSummaryModel(agentDir: string): SummaryModel | null {
  const file = path.join(agentDir, SUMMARY_MODEL_FILE);
  if (!fs.existsSync(file)) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`summary-model.json 不是合法 JSON，请修复或删除后重试：${(err as Error).message}`);
  }
  if (typeof parsed?.provider !== "string" || !parsed.provider.trim() || typeof parsed?.modelId !== "string" || !parsed.modelId.trim()) {
    throw new Error("summary-model.json 结构无效：需要 provider 与 modelId");
  }
  return { provider: parsed.provider, modelId: parsed.modelId };
}

/** null = 清除（删除文件）。 */
export function saveSummaryModel(agentDir: string, model: SummaryModel | null): void {
  const file = path.join(agentDir, SUMMARY_MODEL_FILE);
  if (model === null) fs.rmSync(file, { force: true });
  else atomicWrite(file, JSON.stringify({ provider: model.provider, modelId: model.modelId }, null, 2));
}

// ---------- 修订指纹 / 脱敏 / 回滚快照 ----------

/**
 * 配置修订：models.json + auth.json + default-model.json + summary-model.json 的 sha256。
 * 每个文件按「文件名:长度」前缀后接字节（缺失记 -1），不同文件切分拼出相同字节不会同修订。
 */
export function configRevision(agentDir: string): string {
  const hash = createHash("sha256");
  for (const name of CONFIG_FILES) {
    let bytes: Buffer | null = null;
    try {
      bytes = fs.readFileSync(path.join(agentDir, name));
    } catch {
      // 缺失文件只记标记
    }
    hash.update(`${name}:${bytes ? bytes.length : -1}\n`);
    if (bytes) hash.update(bytes);
  }
  return hash.digest("hex");
}

/** 秘密位置：apiKey 的值与 headers 的每个值（provider 级与模型级）。 */
const isSecretKey = (key: string): boolean => key === "apiKey" || key === "headers";

/** 深拷贝并把秘密位置的值替换为 true（响应/事件永不携带秘密）。 */
export function sanitizeCatalog<T>(data: T, secret = false): T {
  if (Array.isArray(data)) return data.map((item) => sanitizeCatalog(item, secret)) as T;
  if (isPlainObject(data)) {
    return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, sanitizeCatalog(value, secret || isSecretKey(key))])) as T;
  }
  return (secret ? true : data) as T;
}

/**
 * sanitizeCatalog 的逆操作：回写载荷中秘密位置的占位 true 还原为 before
 * 同位置的原值（数组元素按 id 对齐，找不到再按下标）。无原值可还原的
 * 占位符原样保留，由 validateModelCatalog 拒绝，不会当作秘密落盘。
 */
export function restoreCatalogSecrets<T>(next: T, before: unknown, secret = false): T {
  if (secret && next === true) return (typeof before === "string" ? before : next) as T;
  if (Array.isArray(next)) {
    const prev = Array.isArray(before) ? before : [];
    return next.map((item, i) => {
      const match = isPlainObject(item) && item["id"] !== undefined ? prev.find((p) => isPlainObject(p) && p["id"] === item["id"]) : undefined;
      return restoreCatalogSecrets(item, match ?? prev[i], secret);
    }) as T;
  }
  if (isPlainObject(next)) {
    const prev = isPlainObject(before) ? before : {};
    return Object.fromEntries(Object.entries(next).map(([key, value]) => [key, restoreCatalogSecrets(value, prev[key], secret || isSecretKey(key))])) as T;
  }
  return next;
}

/** 配置文件中的秘密值（存储 key、OAuth token 与目录秘密位置），用于错误文本脱敏。 */
export function configSecrets(agentDir: string): string[] {
  const out: string[] = [];
  const collect = (data: unknown, secret: boolean): void => {
    if (Array.isArray(data)) data.forEach((item) => collect(item, secret));
    else if (isPlainObject(data)) for (const [key, value] of Object.entries(data)) collect(value, secret || isSecretKey(key));
    else if (secret && typeof data === "string" && data) out.push(data);
  };
  try {
    for (const entry of Object.values(loadAuthFile(agentDir))) {
      if (entry?.type === "api_key" && typeof entry.key === "string" && entry.key) out.push(entry.key);
      if (entry?.type === "oauth") {
        for (const key of ["access", "refresh"]) if (typeof entry[key] === "string" && entry[key]) out.push(entry[key]);
      }
    }
  } catch {
    // 读取失败按无可脱敏处理
  }
  try {
    collect(loadModelCatalogFile(agentDir).providers, false);
  } catch {
    // 同上
  }
  return out;
}

/** 配置文件的字节快照（按文件名；应用失败时整体回滚，不留下部分新配置）。 */
export type ConfigSnapshot = Record<(typeof CONFIG_FILES)[number], Buffer | null>;

export function snapshotConfigFiles(agentDir: string): ConfigSnapshot {
  const read = (name: string): Buffer | null => {
    try {
      return fs.readFileSync(path.join(agentDir, name));
    } catch {
      return null;
    }
  };
  return Object.fromEntries(CONFIG_FILES.map((name) => [name, read(name)])) as ConfigSnapshot;
}

export function restoreConfigFiles(agentDir: string, snapshot: ConfigSnapshot): void {
  for (const name of CONFIG_FILES) {
    const file = path.join(agentDir, name);
    const content = snapshot[name];
    if (content === null) fs.rmSync(file, { force: true });
    else atomicWrite(file, content);
  }
}

// ---------- 默认模型解析与探测（Runtime 启动/重建、开发启动器、离线配置 UI 共用） ----------

/**
 * 解析默认模型：显式配置（--model / modelProvider+modelId）优先；其次
 * <agentDir>/default-model.json 持久化的后台默认（issue 21 §3）；否则取
 * models.json 第一个 provider 的第一个模型。不得使用 getModels()[0]——
 * pi 内置 provider 注册表也出现在那里，会静默选中无关的云端模型。
 * 返回模型与生效的思考档位（显式 thinkingLevel 配置始终优先）。
 */
export function resolveConfiguredModel(
  modelRuntime: ModelRuntime,
  config: { agentDir: string; modelProvider?: string; modelId?: string; thinkingLevel?: ModelSelection["thinkingLevel"] },
): { model: any; thinkingLevel: ModelSelection["thinkingLevel"] } | undefined {
  if (config.modelProvider) {
    const model = modelRuntime.getModel(config.modelProvider, config.modelId ?? "");
    return model ? { model, thinkingLevel: config.thinkingLevel ?? "off" } : undefined;
  }
  try {
    const persisted = loadDefaultModel(config.agentDir);
    if (persisted) {
      const model = modelRuntime.getModel(persisted.provider, persisted.modelId);
      if (model) {
        // 目录变化后持久化的思考档位可能不再受支持：回退到配置默认，不阻断启动
        const thinkingLevel = getSupportedThinkingLevels(model).includes(persisted.thinkingLevel)
          ? persisted.thinkingLevel
          : "off";
        return { model, thinkingLevel: config.thinkingLevel ?? thinkingLevel };
      }
      // 持久默认指向已删除的模型：回退到目录首个模型
    }
  } catch {
    // default-model.json 损坏按未配置处理，回退到目录首个模型
  }
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(config.agentDir, "models.json"), "utf8")) as {
      providers?: Record<string, { models?: Array<{ id: string }> }>;
    };
    const entry = Object.entries(raw.providers ?? {}).find(([, def]) => (def.models?.length ?? 0) > 0);
    if (!entry) return undefined;
    const [providerId, def] = entry as [string, { models: Array<{ id: string }> }];
    const model = modelRuntime.getModel(providerId, def.models[0]!.id);
    return model ? { model, thinkingLevel: config.thinkingLevel ?? "off" } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 探测配置目录是否有可用模型：与 Runtime.start 同一路径——同一默认解析，
 * 再经模型目录核实凭据、思考档位与预算。不联网刷新目录，不修改任何文件。
 */
export async function probeModelConfig(agentDir: string): Promise<{ ok: boolean; detail: string; selection?: ModelSelection }> {
  try {
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, AUTH_FILE),
      modelsPath: path.join(agentDir, MODELS_FILE),
      modelsStore: new InMemoryModelsStore(),
      refreshOnCreate: false,
    });
    const configured = resolveConfiguredModel(modelRuntime, { agentDir });
    if (!configured) return { ok: false, detail: "未找到可用模型：models.json 中没有可解析的 provider/模型" };
    const selection: ModelSelection = { provider: configured.model.provider, modelId: configured.model.id, thinkingLevel: configured.thinkingLevel };
    try {
      const catalog = await createModelCatalog(modelRuntime, agentDir, configured.model);
      await catalog.resolve(selection);
    } catch {
      return { ok: false, detail: "默认模型不可用，请检查模型目录、认证配置与思考档位后重试", selection };
    }
    return { ok: true, detail: `默认模型 ${selection.provider}/${selection.modelId} 可用`, selection };
  } catch {
    return { ok: false, detail: "模型配置无法加载，请检查 models.json 与 auth.json 后重试" };
  }
}
