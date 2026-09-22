/**
 * 集成测试公共设施（沿用 issue 01 的 mock 模型 + 临时目录方式）。
 *
 * - MockModelServer：本地 OpenAI 兼容服务（从 verification/foundation 复制）；
 * - 每个测试独立临时目录：dataDir（后台数据）、agentDir（models.json）、
 *   若干工作目录；结束后整体删除；
 * - startTestRuntime：进程内启动 Runtime + ControlServer，返回已连接客户端。
 */

import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ControlClient } from "../../src/control/client.ts";
import { ControlServer } from "../../src/control/server.ts";
import { readOwnerToken } from "../../src/control/owner-token.ts";
import { Runtime, type RuntimeConfig } from "../../src/runtime/runtime.ts";
import { createMockTools } from "../../src/agent/mock-tools.ts";
import { createCodingTools } from "../../src/agent/tool-router.ts";
import { MockModelServer, type Responder } from "./mock-provider.ts";

export interface TestDirs {
  root: string;
  dataDir: string;
  agentDir: string;
}

export async function makeTestDirs(prefix: string, workDirs = 2): Promise<{ dirs: TestDirs; work: string[] }> {
  const root = await mkdtemp(path.join(tmpdir(), `ruukoto-it-${prefix}-`));
  const dirs: TestDirs = {
    root,
    dataDir: path.join(root, "data"),
    agentDir: path.join(root, "agent"),
  };
  await mkdir(dirs.dataDir, { recursive: true });
  await mkdir(dirs.agentDir, { recursive: true });
  const work: string[] = [];
  for (let i = 0; i < workDirs; i++) {
    const dir = path.join(root, `work-${i}`);
    await mkdir(dir, { recursive: true });
    work.push(dir);
  }
  return { dirs, work };
}

export async function cleanupDirs(dirs: TestDirs): Promise<void> {
  await rm(dirs.root, { recursive: true, force: true });
}

export async function writeModelsJson(dirs: TestDirs, baseUrl: string, contextWindow = 200_000): Promise<void> {
  const models = {
    providers: {
      mock: {
        name: "Mock",
        baseUrl,
        apiKey: "mock-key",
        api: "openai-completions",
        models: [
          {
            id: "mock-model",
            name: "Mock Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow,
            maxTokens: Math.min(1024, contextWindow),
            compat: { supportsUsageInStreaming: true },
          },
        ],
      },
    },
  };
  await writeFile(path.join(dirs.agentDir, "models.json"), JSON.stringify(models, null, 2));
}

export interface TestRuntime {
  runtime: Runtime;
  client: ControlClient;
  server: MockModelServer;
  dirs: TestDirs;
  work: string[];
  shutdown(): Promise<void>;
}

/** 进程内启动完整后台（Runtime + 控制面），返回已认证并 connect 的客户端。 */
export async function startTestRuntime(
  prefix: string,
  responder: Responder,
  opts: { contextWindow?: number; workDirs?: number; config?: Partial<RuntimeConfig> } = {},
): Promise<TestRuntime> {
  const { dirs, work } = await makeTestDirs(prefix, opts.workDirs ?? 2);
  const server = new MockModelServer(responder);
  const baseUrl = await server.start();
  await writeModelsJson(dirs, baseUrl, opts.contextWindow ?? 200_000);

  const runtime = await Runtime.start({
    dataDir: dirs.dataDir,
    agentDir: dirs.agentDir,
    // macOS 的 Unix socket 路径长度有限：测试用短路径
    socketPath: path.join(dirs.root, "c.sock"),
    thinkingLevel: "off",
    modelProvider: "mock",
    modelId: "mock-model",
    // 测试默认使用模拟工具（issue 02 场景）；真实编码工具测试显式传 realTools()
    toolFactory: (ctx) => createMockTools(ctx),
    ...opts.config,
  });
  await ControlServer.start(runtime);
  const client = await connectAuthedClient(runtime);
  await client.handshake();

  return {
    runtime,
    client,
    server,
    dirs,
    work,
    async shutdown() {
      client.close();
      await runtime.stop("test_end");
      await server.close();
      await cleanupDirs(dirs);
    },
  };
}

/** 以控制面目录中的拥有者令牌完成认证。 */
export async function authenticateClient(client: ControlClient, controlDir: string): Promise<void> {
  const token = readOwnerToken(controlDir);
  if (!token) throw new Error("测试环境缺少拥有者令牌");
  await client.authenticate(token);
}

/** 连接控制面并以控制面目录中的拥有者令牌完成认证。 */
export async function connectAuthedClient(runtime: Runtime): Promise<ControlClient> {
  const client = await ControlClient.connect(runtime.socketPath());
  await authenticateClient(client, runtime.controlDir());
  return client;
}

/** 真实编码工具配置（read/edit/write/bash + 审批操作 + 产物查询，经工具工作进程）。 */
export function realTools(): Pick<RuntimeConfig, "toolFactory"> {
  return { toolFactory: (ctx) => createCodingTools(ctx.router) };
}

// ---------- mock 路由辅助 ----------

export interface RecordedRequestLike {
  messages: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>> | undefined;
}

/** 取请求里最后一条 user 消息的文本（pi 会带 system，extract 已滤掉）。 */
export function lastUserText(req: RecordedRequestLike): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role !== "user") continue;
    const content = m.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
        .join("");
    }
    return String(content ?? "");
  }
  return "";
}

/**
 * 按任务输入路由 mock 响应：routes 依序匹配最后一条 user 消息文本。
 * 未命中时返回 "done:<text>"，避免意外挂死。
 */
export function routeResponder(
  routes: Array<{ match: RegExp; respond: (req: RecordedRequestLike, text: string) => any }>,
): Responder {
  return async (req) => {
    const text = lastUserText(req);
    for (const route of routes) {
      if (route.match.test(text)) return route.respond(req, text);
    }
    return { kind: "text", text: `done:${text.slice(0, 40)}` };
  };
}

export async function waitFor(
  desc: string,
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时: ${desc}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

export async function createProjectSession(
  client: ControlClient,
  cwd: string,
  opts: { projectName?: string; confirmTools?: string[] } = {},
): Promise<{ projectId: string; sessionId: string }> {
  const project = (await client.request<any>("create_project", {
    name: opts.projectName ?? `proj-${path.basename(cwd)}-${Math.random().toString(36).slice(2, 8)}`,
  })) as any;
  const session = (await client.request<any>("create_session", {
    project_id: project.id,
    cwd,
    confirm_tools: opts.confirmTools ?? [],
  })) as any;
  return { projectId: project.id, sessionId: session.id };
}

/** 读取任务当前状态（get_task）。 */
export async function taskStatus(client: ControlClient, taskId: string): Promise<any> {
  return client.request<any>("get_task", { task_id: taskId });
}

export function readMarkerCount(file: string): number {
  try {
    const text = fs.readFileSync(file, "utf8");
    return text.split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}
