/** Configuration writes require an activated profile and online authentication or the offline configuration lock. */

import type { Terminal } from "@earendil-works/pi-tui";
import { ControlClient, ControlClientError } from "@ruukoto/control/client.ts";
import { resolveClientConfig } from "@ruukoto/control/connect.ts";
import type { ConnectResult } from "@ruukoto/control/protocol.ts";
import type { OpResult } from "@ruukoto/control/ops.ts";
import { verifyProfile, type ProfilePaths } from "@ruukoto/core/profile.ts";
import type { ModelSelection } from "@ruukoto/core/types.ts";
import type { AcquiredLock } from "@ruukoto/core/instance-lock.ts";
import {
  acquireConfigLock,
  configRevision,
  loadDefaultModel,
  loadModelCatalogFile,
  loadSummaryModel,
  loadModelConfigMetadata,
  removeProviderCredential,
  restoreCatalogSecrets,
  sanitizeCatalog,
  saveDefaultModel,
  saveModelCatalogFile,
  saveSummaryModel,
  setProviderApiKey,
  validateApiKey,
  validateModelCatalog,
  type SummaryModel,
} from "@ruukoto/agent/model-config.ts";
import { ConfigTuiApp, type ModelBackend, type ModelConfigView } from "./app.ts";
import { RELOAD_STATE_ENV } from "../tui/reload-state.ts";

export interface ConfigTuiOptions {
  profile: ProfilePaths;
  offline?: boolean;
  /** 测试注入：替换终端（默认 ProcessTerminal）。 */
  terminal?: Terminal;
}

/** 在线模型配置后端：get_model_config 修订作乐观并发凭证，每次变更后更新。 */
class OnlineModelBackend implements ModelBackend {
  private revision = "";
  constructor(private readonly client: ControlClient) {}

  async load(): Promise<ModelConfigView> {
    const view = await this.client.request<OpResult<"get_model_config">>("get_model_config", {});
    this.revision = String(view.revision ?? "");
    return {
      revision: this.revision,
      providers: view.providers ?? {},
      credentials: view.credentials ?? {},
      credentialSources: view.credentialSources ?? {},
      models: view.models ?? [],
      runtimeOverrides: view.runtimeOverrides ?? { model: false, thinking: false },
      defaultModel: view.defaultModel ?? null,
      summaryModel: view.summaryModel ?? null,
      busyProviders: view.busyProviders ?? [],
    };
  }

  private async mutate(op: string, params: Record<string, unknown>): Promise<void> {
    const result = await this.client.request<any>(op, { ...params, expected_revision: this.revision });
    if (typeof result?.revision === "string") this.revision = result.revision;
  }

  saveCatalog(providers: Record<string, any>): Promise<void> {
    return this.mutate("save_model_catalog", { providers });
  }

  setApiKey(provider: string, key: string): Promise<void> {
    return this.mutate("set_model_api_key", { provider, api_key: key });
  }

  removeApiKey(provider: string): Promise<void> {
    return this.mutate("remove_model_api_key", { provider });
  }

  removeProvider(provider: string): Promise<void> {
    return this.mutate("remove_model_provider", { provider });
  }

  setDefaultModel(selection: ModelSelection): Promise<void> {
    return this.mutate("set_default_model", { provider: selection.provider, model_id: selection.modelId, thinking_level: selection.thinkingLevel });
  }

  setSummaryModel(model: SummaryModel | null): Promise<void> {
    return this.mutate("set_summary_model", { provider: model?.provider ?? null, model_id: model?.modelId ?? null });
  }

  testConnection(provider: string, modelId: string): Promise<{ ok: boolean; detail: string }> {
    return this.client.request("test_model_connection", { provider, model_id: modelId });
  }
}

/** 离线后端：直接写配置文件（入口已持有配置锁；修订指纹即文件字节摘要）。 */
export class OfflineModelBackend implements ModelBackend {
  constructor(private readonly profile: ProfilePaths) {}

  private get agentDir(): string {
    verifyProfile(this.profile);
    return this.profile.agentDir;
  }

  async load(): Promise<ModelConfigView> {
    const metadata = await loadModelConfigMetadata(this.agentDir);
    const catalog = loadModelCatalogFile(this.agentDir);
    let defaultModel: ModelSelection | null = null;
    try {
      defaultModel = loadDefaultModel(this.agentDir);
    } catch {
      // 损坏的默认配置按未设置处理（保存可修复）
    }
    return {
      revision: configRevision(this.agentDir),
      providers: sanitizeCatalog(catalog.providers),
      structureErrors: validateModelCatalog(catalog),
      ...metadata,
      runtimeOverrides: { model: false, thinking: false },
      defaultModel,
      summaryModel: this.summaryModel(),
      busyProviders: [],
    };
  }

  /** 损坏的摘要模型配置按未设置处理（保存可修复）。 */
  private summaryModel(): SummaryModel | null {
    try {
      return loadSummaryModel(this.agentDir);
    } catch {
      return null;
    }
  }

  async saveCatalog(input: Record<string, any>): Promise<void> {
    const before = loadModelCatalogFile(this.agentDir).providers;
    const providers = restoreCatalogSecrets(input, before);
    const errors = validateModelCatalog({ providers });
    if (errors.length > 0) {
      throw Object.assign(new Error(`模型目录结构无效：${errors.join("；")}`), { code: "invalid_params" });
    }
    const summary = this.summaryModel();
    const removesSummaryProvider = summary && before[summary.provider] && !providers[summary.provider];
    const removesSummaryEntry = summary && ((before[summary.provider]?.models as Array<{ id?: string }> | undefined) ?? []).some((model) => model.id === summary.modelId)
      && !((providers[summary.provider]?.models as Array<{ id?: string }> | undefined) ?? []).some((model) => model.id === summary.modelId);
    if (summary && (removesSummaryProvider || removesSummaryEntry)) {
      throw Object.assign(new Error(`模型 ${summary.provider}/${summary.modelId} 仍被摘要模型引用，请先切换或清除摘要模型`), { code: "provider_in_use" });
    }
    saveModelCatalogFile(this.agentDir, { providers });
  }

  async setApiKey(provider: string, key: string): Promise<void> {
    const invalid = validateApiKey(key);
    if (invalid) throw Object.assign(new Error(invalid), { code: "invalid_params" });
    setProviderApiKey(this.agentDir, provider, key);
  }

  async removeApiKey(provider: string): Promise<void> {
    removeProviderCredential(this.agentDir, provider);
  }

  async removeProvider(provider: string): Promise<void> {
    // 离线只能核对持久化默认模型（会话引用在数据库里，在线路径才会检查）
    let defaultModel: ModelSelection | null = null;
    try {
      defaultModel = loadDefaultModel(this.agentDir);
    } catch {
      // 损坏按未配置处理
    }
    if (defaultModel?.provider === provider) {
      throw Object.assign(new Error(`提供方 ${provider} 仍被后台默认模型引用，请先切换默认模型`), { code: "provider_in_use" });
    }
    if (this.summaryModel()?.provider === provider) {
      throw Object.assign(new Error(`提供方 ${provider} 仍被摘要模型引用，请先切换或清除摘要模型`), { code: "provider_in_use" });
    }
    const catalog = loadModelCatalogFile(this.agentDir);
    delete catalog.providers[provider];
    saveModelCatalogFile(this.agentDir, catalog);
    removeProviderCredential(this.agentDir, provider);
  }

  async setDefaultModel(selection: ModelSelection): Promise<void> {
    const metadata = await loadModelConfigMetadata(this.agentDir);
    const model = metadata.models.find((item) => item.provider === selection.provider && item.modelId === selection.modelId);
    if (!model) {
      throw Object.assign(new Error(`模型不在已配置目录中：${selection.provider}/${selection.modelId}`), { code: "invalid_params" });
    }
    if (!model.thinkingLevels) {
      throw Object.assign(new Error("该模型真实思考档位未知，请连接后台读取模型元数据后设置"), { code: "invalid_params" });
    }
    if (!model.thinkingLevels.includes(selection.thinkingLevel)) {
      throw Object.assign(new Error(`该模型不支持思考档位 ${selection.thinkingLevel}`), { code: "invalid_params" });
    }
    saveDefaultModel(this.agentDir, selection);
  }

  async setSummaryModel(model: SummaryModel | null): Promise<void> {
    if (model) {
      const metadata = await loadModelConfigMetadata(this.agentDir);
      if (!metadata.models.some((item) => item.provider === model.provider && item.modelId === model.modelId)) {
        throw Object.assign(new Error(`模型不在目录中：${model.provider}/${model.modelId}`), { code: "invalid_params" });
      }
    }
    saveSummaryModel(this.agentDir, model);
  }
}

export async function runConfigTui(opts: ConfigTuiOptions): Promise<number> {
  if (!opts.terminal && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    console.error("配置中心需要交互式终端（TTY）。非 TTY 环境请使用管理命令（见 ruukoto 无参数帮助）。");
    return 1;
  }

  verifyProfile(opts.profile);
  let mode: "online" | "offline" = "offline";
  let client: ControlClient | null = null;
  let snapshot: ConnectResult["snapshot"] | null = null;
  if (!opts.offline) {
    const config = resolveClientConfig(opts.profile);
    try {
      client = await ControlClient.connect(config.socketPath, 3000);
    } catch (err) {
      const cause = err instanceof ControlClientError && err.code === "connection_error" ? err.cause : undefined;
      if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT" && cause.code !== "ECONNREFUSED") throw err;
      console.error(`后台未运行，进入离线配置：${opts.profile.agentDir}`);
    }
    if (client) {
      try {
        await client.authenticate(config.token, opts.profile);
        snapshot = (await client.handshake()).snapshot;
        mode = "online";
      } catch (error) {
        client.close();
        throw error;
      }
    }
  }

  // 2) 离线进入：必须持有配置锁（socket 不可达不能证明后台已停）
  const agentDir = opts.profile.agentDir;
  let lock: AcquiredLock | null = null;
  let modelBackend: ModelBackend;
  if (mode === "online") {
    modelBackend = new OnlineModelBackend(client!);
  } else {
    try {
      verifyProfile(opts.profile);
      lock = acquireConfigLock(agentDir);
    } catch (err) {
      console.error(
        "配置目录正被后台或另一配置进程占用（socket 不可达不能证明后台已停），拒绝离线写入。\n" +
          `请停止占用方后重试，或先连接后台使用在线配置。详情：${(err as Error).message}`,
      );
      return 1;
    }
    modelBackend = new OfflineModelBackend(opts.profile);
  }

  // 3) 界面生命周期：控制台输出转入界面提示行；退出路径恢复终端并释放资源
  let app: ConfigTuiApp | null = null;
  const originalConsole = { log: console.log, error: console.error, warn: console.warn };
  const routeIntoView = (...args: unknown[]) => {
    app?.log(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  console.log = routeIntoView;
  console.error = routeIntoView;
  console.warn = routeIntoView;
  const restoreConsole = (): void => {
    console.log = originalConsole.log;
    console.error = originalConsole.error;
    console.warn = originalConsole.warn;
  };

  let resolveExit: ((code: number) => void) | null = null;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    restoreConsole();
    client?.close();
    lock?.release();
  };

  app = new ConfigTuiApp({
    mode,
    modelBackend,
    agentDir,
    client: client ?? undefined,
    snapshot: snapshot ?? undefined,
    terminal: opts.terminal,
    reloadStateFile: process.env[RELOAD_STATE_ENV] === "1" ? opts.profile.reloadStatePath : undefined,
    onExit: (code) => {
      cleanup();
      resolveExit?.(code);
    },
  });

  const onSignal = () => app?.quit(0);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  process.on("SIGINT", onSignal);
  const onUncaught = (err: Error) => {
    cleanup();
    console.error(`配置中心异常退出：${err.stack ?? err.message}`);
    console.error("如终端显示异常，可执行 reset 或 stty sane 恢复。");
    process.exit(1);
  };
  process.on("uncaughtException", onUncaught);

  try {
    await app.start();
    return await exitPromise;
  } finally {
    cleanup();
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGHUP", onSignal);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("uncaughtException", onUncaught);
    console.error("已退出配置中心");
  }
}
