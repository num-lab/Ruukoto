import { product as personalProduct } from "./legacy-product.ts";
/**
 * 集成测试公共设施（沿用 issue 01 的 mock 模型 + 临时目录方式）。
 *
 * - MockModelServer：与 verification/foundation 共用的本地 OpenAI 兼容服务；
 * - 每个测试独立临时目录：dataDir（后台数据）、agentDir（models.json）、
 *   若干工作目录；结束后整体删除；
 * - startTestRuntime：进程内启动 Runtime + ControlServer，返回已连接客户端；
 * - startAssemblyKit：不起 Runtime，直接驱动模型上下文组装（context-assembly）。
 */

import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ControlClient } from "@ruukoto/control/client.ts";
import { ControlServer } from "@ruukoto/control/server.ts";
import { readOwnerToken } from "@ruukoto/control/owner-token.ts";
import { Runtime, type RuntimeConfig } from "@ruukoto/runtime/runtime.ts";
import { AccessScope } from "@ruukoto/core/access.ts";
import { Db } from "@ruukoto/core/db.ts";
import { MemoryStore } from "@ruukoto/core/memory.ts";
import { Store } from "@ruukoto/core/store.ts";
import { randomId, type SelectionRecord, type Session, type Task } from "@ruukoto/core/types.ts";
import { ArtifactStore } from "@ruukoto/agent/artifacts.ts";
import { beginContextAssembly, type ContextAssembly, type ContextAssemblyDeps, type ContextAssemblyInput } from "@ruukoto/agent/context-assembly.ts";
import { CredentialStore } from "@ruukoto/agent/execution/credentials.ts";
import { createModelCatalog } from "@ruukoto/agent/model-selection.ts";
import { createMockTools } from "@ruukoto/agent/mock-tools.ts";
import { createCodingTools } from "@ruukoto/agent/tool-router.ts";
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
    product: personalProduct.runtime,
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

export function toolNamesOf(call: Pick<RecordedRequestLike, "tools">): string[] {
  return (call.tools ?? []).map((t: any) => t?.function?.name ?? t?.name).filter((n): n is string => typeof n === "string");
}

export function afterTool(req: RecordedRequestLike): boolean {
  return req.messages.at(-1)?.role === "tool";
}

export function lastToolText(req: RecordedRequestLike): string {
  const m = req.messages.at(-1);
  return typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");
}

/** 请求中所有消息的文本串联（content 支持 string 与 parts 数组）。 */
export function inputText(req: RecordedRequestLike): string {
  return req.messages
    .map((m: any) => {
      const content = m?.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) return content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("");
      return "";
    })
    .join("\n");
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

/** 等待任务出现待审批操作（excludeIds 排除已处理的审批）。 */
export async function pendingConfirmation(client: ControlClient, taskId: string, excludeIds: string[] = []): Promise<any> {
  let found: any = null;
  await waitFor("出现待审批操作", async () => {
    const status = await taskStatus(client, taskId);
    found = status.confirmations.find((c: any) => c.status === "pending" && !excludeIds.includes(c.id)) ?? null;
    return found !== null;
  }, 60_000);
  return found;
}

export function readMarkerCount(file: string): number {
  try {
    const text = fs.readFileSync(file, "utf8");
    return text.split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

// ---------- 模型上下文组装（进程内，不起 Runtime） ----------

const MOCK_SELECTION = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" } as const;
/** pi 对 mock 响应（prompt 100 / completion 10，零单价）给出的 usage。 */
const MOCK_USAGE = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/**
 * 模型上下文组装的夹具：临时目录里的真实 Db/Store、记忆、产物与凭据；模型栈指向
 * MockModelServer（组装只有摘要会发请求，server.calls 即摘要请求）。deps 可按测试改写
 * budgetOverrides / jev / compaction，组装实例持有同一个对象。
 */
export async function startAssemblyKit(prefix: string, opts: { responder?: Responder; contextWindow?: number; workDirs?: number } = {}) {
  const { dirs, work } = await makeTestDirs(prefix, opts.workDirs ?? 1);
  const server = new MockModelServer(opts.responder ?? (() => ({ kind: "text", text: "摘要" })));
  await writeModelsJson(dirs, await server.start(), opts.contextWindow ?? 200_000);
  const db = new Db(dirs.dataDir);
  const store = new Store(db);
  const loadModels = async () => {
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(dirs.agentDir, "auth.json"),
      modelsPath: path.join(dirs.agentDir, "models.json"),
      modelsStore: new InMemoryModelsStore(),
      refreshOnCreate: false,
    });
    return { modelRuntime, modelCatalog: await createModelCatalog(modelRuntime, dirs.agentDir) };
  };
  const deps: ContextAssemblyDeps = {
    store, memories: new MemoryStore(db), access: new AccessScope(db),
    artifacts: new ArtifactStore(dirs.dataDir, store), credentials: new CredentialStore(dirs.agentDir),
    agentDir: dirs.agentDir, ...(await loadModels()),
  };
  const model = await deps.modelCatalog.resolve(MOCK_SELECTION);
  const sdk = (tools: any[] = []) => ({ systemPrompt: "sys", tools, model });
  const taskOf = new WeakMap<ContextAssembly, Task>();
  return {
    dirs, work, server, store, deps, model, sdk,
    /** 重读 models.json 换上新模型栈（同 driver.updateModelDeps）。 */
    async reloadModels() {
      Object.assign(deps, await loadModels());
    },
    project(cwd = work[0]!): { projectId: string; session: Session } {
      const stat = fs.statSync(cwd);
      return store.withTx(() => {
        const project = store.createProject(randomId("p"));
        const session = store.createSession({
          projectId: project.id, cwd, cwdReal: fs.realpathSync(cwd), cwdDev: stat.dev, cwdIno: stat.ino,
          piSessionId: randomId("pi"), confirmTools: [],
        });
        return { projectId: project.id, session };
      });
    },
    task(session: Session, input: string, resumesTaskId: string | null = null): Task {
      return store.withTx(() => store.insertQueuedTask({
        sessionId: session.id, requestId: randomId("r"), input, resumesTaskId, modelSelection: MOCK_SELECTION, submissionDigest: randomId("d"),
      }).task);
    },
    /** 任务开始建组装实例；缺省为普通开发会话（不受限、非计划模式、不读技能）。 */
    begin(task: Task, session: Session, extra: Partial<ContextAssemblyInput> = {}): ContextAssembly {
      const assembly = beginContextAssembly({
        task, session, accessor: { kind: "agent", projectId: session.projectId }, restricted: false, plan: false, skills: null, ...extra,
      }, deps);
      taskOf.set(assembly, task);
      return assembly;
    },
    /**
     * 一次模型调用：assemble → prepareSend（发送内容即视图）→ afterSend 补记 usage。
     * 返回视图与这次的选择记录；被拦下时抛 prepareSend 的错误。
     */
    async send(assembly: ContextAssembly, messages: any[], opts: { tools?: any[]; usage?: Record<string, unknown> } = {}): Promise<{ view: any[]; record: SelectionRecord }> {
      const view = (await assembly.assemble(messages, sdk(opts.tools)))?.messages ?? messages;
      assembly.prepareSend(model, { systemPrompt: "sys", messages: view, tools: opts.tools ?? [] }, {});
      assembly.afterSend({ result: async () => ({ usage: opts.usage ?? MOCK_USAGE }) });
      await new Promise((resolve) => setImmediate(resolve));
      return { view, record: store.listSelectionRecordsByTask(taskOf.get(assembly)!.id).at(-1)! };
    },
    async close() {
      db.close();
      await server.close();
      await cleanupDirs(dirs);
    },
  };
}
