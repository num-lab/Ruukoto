/**
 * 模型配置文件模块（issue 21 §3/§4）：models.json / auth.json / default-model.json
 * 的读写、结构校验、修订指纹与脱敏。
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
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelSelection } from "../core/types.ts";

export { acquireConfigLock } from "../core/instance-lock.ts";

/** models.json 的顶层结构（provider 定义透传给 SDK，不做完整类型化）。 */
export interface ModelCatalogFile {
  providers: Record<string, any>;
}

const MODELS_FILE = "models.json";
const AUTH_FILE = "auth.json";
const DEFAULT_MODEL_FILE = "default-model.json";

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
  } catch (err) {
    throw new Error(`models.json 不是合法 JSON，请修复或删除后重试：${(err as Error).message}`);
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
    if (def["apiKey"] !== undefined && typeof def["apiKey"] !== "string") {
      // 脱敏占位符（true）回写必须拒绝，防止把占位符当作 key 落盘
      errors.push(`provider ${providerId}：apiKey 必须是字符串（脱敏视图中的 true 为占位符，请重新输入或移除该字段）`);
    }
    checkHeaders(def["headers"], `provider ${providerId}`);
    if (def["models"] !== undefined && !Array.isArray(def["models"])) {
      errors.push(`provider ${providerId}：models 必须是数组`);
      continue;
    }
    for (const [index, model] of ((def["models"] as unknown[] | undefined) ?? []).entries()) {
      const label = `provider ${providerId} 的第 ${index + 1} 个模型`;
      if (!isPlainObject(model)) {
        errors.push(`${label}：必须是对象`);
        continue;
      }
      if (typeof model["id"] !== "string" || !(model["id"] as string).trim()) {
        errors.push(`${label}：id 必须是非空字符串`);
      }
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
  } catch (err) {
    throw new Error(`auth.json 不是合法 JSON，请修复或删除后重试：${(err as Error).message}`);
  }
  if (!isPlainObject(parsed)) throw new Error("auth.json 结构无效：顶层必须是 JSON 对象");
  return parsed as Record<string, any>;
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
  auth[provider] = { type: "api_key", key };
  atomicWrite(path.join(agentDir, AUTH_FILE), JSON.stringify(auth, null, 2));
}

/** 删除 provider 的凭据条目（其他条目原样保留；不存在时不动文件）。 */
export function removeProviderCredential(agentDir: string, provider: string): void {
  const auth = loadAuthFile(agentDir);
  if (!(provider in auth)) return;
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

// ---------- 修订指纹 / 脱敏 / 回滚快照 ----------

/** 配置修订：models.json + auth.json + default-model.json 字节拼接的 sha256（缺失文件跳过）。 */
export function configRevision(agentDir: string): string {
  const hash = createHash("sha256");
  for (const name of [MODELS_FILE, AUTH_FILE, DEFAULT_MODEL_FILE]) {
    try {
      hash.update(fs.readFileSync(path.join(agentDir, name)));
    } catch {
      // 缺失文件不参与指纹
    }
  }
  return hash.digest("hex");
}

/** 目录条目的思考档位候选（SDK 权威校验为 getSupportedThinkingLevels；此为基础档启发式，服务端保存时仍会再校验）。 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;

export function thinkingLevelsForCatalogModel(model: { reasoning?: unknown }): string[] {
  return model.reasoning ? [...THINKING_LEVELS] : ["off"];
}

/** 秘密位置：apiKey 的值与 headers 的每个值（provider 级与模型级）。 */
const isSecretKey = (key: string): boolean => key === "apiKey" || key === "headers";

/** 深拷贝并把秘密位置的值替换为 true（响应/事件永不携带秘密）。 */
export function sanitizeCatalog<T>(data: T, secret = false): T {
  if (Array.isArray(data)) return data.map((item) => sanitizeCatalog(item, secret)) as T;
  if (isPlainObject(data)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) out[key] = sanitizeCatalog(value, secret || isSecretKey(key));
    return out as T;
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
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(next)) out[key] = restoreCatalogSecrets(value, prev[key], secret || isSecretKey(key));
    return out as T;
  }
  return next;
}

/** 配置文件中的全部秘密值（auth.json 的 key 与目录秘密位置的值），用于错误文本脱敏。 */
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

/** 三个配置文件的字节快照（应用失败时整体回滚，不留下部分新配置）。 */
export interface ConfigSnapshot {
  models: Buffer | null;
  auth: Buffer | null;
  defaultModel: Buffer | null;
}

export function snapshotConfigFiles(agentDir: string): ConfigSnapshot {
  const read = (name: string): Buffer | null => {
    try {
      return fs.readFileSync(path.join(agentDir, name));
    } catch {
      return null;
    }
  };
  return { models: read(MODELS_FILE), auth: read(AUTH_FILE), defaultModel: read(DEFAULT_MODEL_FILE) };
}

export function restoreConfigFiles(agentDir: string, snapshot: ConfigSnapshot): void {
  const restore = (name: string, content: Buffer | null): void => {
    const file = path.join(agentDir, name);
    if (content === null) {
      fs.rmSync(file, { force: true });
      return;
    }
    atomicWrite(file, content);
  };
  restore(MODELS_FILE, snapshot.models);
  restore(AUTH_FILE, snapshot.auth);
  restore(DEFAULT_MODEL_FILE, snapshot.defaultModel);
}

// ---------- 探测（开发启动器 / 离线配置 UI 用；Runtime.start 有自己的启动路径） ----------

/**
 * 探测配置目录是否有可用模型：解析默认模型（default-model.json → 目录首个
 * provider 的首个模型）并核对其凭据。不联网刷新目录，不修改任何文件。
 */
export async function probeModelConfig(agentDir: string): Promise<{ ok: boolean; detail: string; selection?: ModelSelection }> {
  try {
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, AUTH_FILE),
      modelsPath: path.join(agentDir, MODELS_FILE),
      modelsStore: new InMemoryModelsStore(),
      refreshOnCreate: false,
    });
    let selection: ModelSelection | null = null;
    const persisted = loadDefaultModel(agentDir);
    if (persisted && modelRuntime.getModel(persisted.provider, persisted.modelId)) selection = persisted;
    if (!selection) {
      const catalog = loadModelCatalogFile(agentDir);
      for (const [providerId, def] of Object.entries(catalog.providers)) {
        const first = (def?.models as Array<{ id?: unknown }> | undefined)?.[0];
        if (typeof first?.id === "string" && modelRuntime.getModel(providerId, first.id)) {
          selection = { provider: providerId, modelId: first.id, thinkingLevel: "off" };
          break;
        }
      }
    }
    if (!selection) return { ok: false, detail: "未找到可用模型：models.json 中没有可解析的 provider/模型" };
    let authed = false;
    try {
      authed = Boolean(await modelRuntime.checkAuth(selection.provider));
    } catch {
      authed = false;
    }
    if (!authed) return { ok: false, detail: `提供方 ${selection.provider} 缺少可用凭据，请配置 API key`, selection };
    return { ok: true, detail: `默认模型 ${selection.provider}/${selection.modelId} 可用`, selection };
  } catch (err) {
    return { ok: false, detail: `模型配置不可用：${(err as Error).message}` };
  }
}
