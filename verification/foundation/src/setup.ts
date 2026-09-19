/**
 * 测试公共装配：mock 模型 + 隔离目录 + SDK 会话。
 *
 * 所有验证都在封闭环境运行：临时 agentDir（无用户扩展/凭据）、本地 mock
 * 模型服务（无网络）。需要验证扩展行为时通过 inline extension factory 注入。
 */

import assert from "node:assert/strict";
import * as path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  type AgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { MockModelServer, type Responder } from "./mock-provider.ts";
import { makeTestDirs, cleanupDirs, writeModelsJson, type TestDirs } from "./helpers.ts";

export interface Setup {
  dirs: TestDirs;
  server: MockModelServer;
  session: AgentSession;
  /** 会话磁盘文件路径（懒解析，需至少一次 prompt 后有效）。 */
  sessionFile: () => string;
}

export interface SetupOptions {
  contextWindow?: number;
  extensions?: Array<{ name: string; factory: (pi: any) => void }>;
  /** 覆盖默认的会话目录（多会话场景各自独立文件时由测试自建 SessionManager）。 */
  sessionManager?: SessionManager;
  /** 通过 createAgentSession 的 customTools 注册自定义工具。 */
  customTools?: any[];
}

export async function setupSession(prefix: string, responder: Responder, options: SetupOptions = {}): Promise<Setup> {
  const dirs = await makeTestDirs(prefix);
  const server = new MockModelServer(responder);
  const baseUrl = await server.start();
  await writeModelsJson(dirs, baseUrl, options.contextWindow ?? 200_000);

  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(dirs.agentDir, "auth.json"),
    modelsPath: path.join(dirs.agentDir, "models.json"),
    modelsStore: new InMemoryModelsStore(),
    refreshOnCreate: false,
  });
  const model = modelRuntime.getModel("mock", "mock-model");
  assert.ok(model, "mock model 应该已注册");

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });

  const loader = new DefaultResourceLoader({
    cwd: dirs.cwd,
    agentDir: dirs.agentDir,
    settingsManager,
    extensionFactories: options.extensions ?? [],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: dirs.cwd,
    agentDir: dirs.agentDir,
    model,
    thinkingLevel: "off",
    modelRuntime,
    sessionManager: options.sessionManager ?? SessionManager.create(dirs.cwd, dirs.sessionDir),
    settingsManager,
    resourceLoader: loader,
    customTools: options.customTools,
  });

  return {
    dirs,
    server,
    session,
    sessionFile: () => {
      const file = (session as any).sessionFile as string | undefined;
      if (!file) throw new Error("会话文件尚未创建（需要至少一次 prompt）");
      return file;
    },
  };
}

export async function teardownSession(s: Setup): Promise<void> {
  s.session.dispose();
  await s.server.close();
  await cleanupDirs(s.dirs);
}

/** 收集事件类型序列。 */
export function eventCollector(session: AgentSession): { types: string[]; all: any[] } {
  const types: string[] = [];
  const all: any[] = [];
  session.subscribe((event: any) => {
    types.push(event.type);
    all.push(event);
  });
  return { types, all };
}
