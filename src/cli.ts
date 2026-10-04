/**
 * CLI 入口（拥有者可信入口）：任务界面、工作区、配置中心与后台启动的统一
 * 分发（issue 21）。顶层分发决策见 cli-entry.ts 的 resolveEntry。
 *
 *   ruukoto [路径] [--session <id> | --demo]   任务界面：无参进入默认会话；路径打开该工作区（每次启动新建会话）
 *   ruukoto -- <路径>                          显式工作区入口（目录与命令同名时使用，如 ruukoto -- config）
 *   ruukoto config [--offline]                 独立配置中心
 *   ruukoto server [--data-dir D] [--agent-dir A] [--execution local|container]
 *                  （默认：ruukoto = local，ruukoto-dev = container）
 *   ruukoto start                              server 的兼容别名（同一代码路径；文档推荐 server）
 *   ruukoto tui                                旧拼法：打印迁移指引后仍启动任务界面
 *   ruukoto create-project <name>
 *   ruukoto create-session <project> <cwd> [--confirm-tools a,b]
 *   ruukoto submit <session> <request-id> [--mode confirm|full_access|auto-review]
 *                  [--grant <path>:<read|read_write>[:<用途>];...] <input...>
 *   ruukoto continue <task> <request-id> [--mode ...] [--grant ...] <input...>
 *   ruukoto switch-mode <task> <confirm|full_access|auto-review> [--grant ...]
 *   ruukoto status [task]                             任务/快照查询
 *   ruukoto events                                    订阅并打印事件流
 *   ruukoto interrupt <task> | cancel <task> | resume-queue <session>
 *   ruukoto confirm <confirmation-id> approve|reject
 *   ruukoto service-grant list [--cursor C] [--limit N] | show <id> | revoke <id> --expected-version N
 *   ruukoto read-artifact <task> <artifact> [--offset N] [--length N]
 *   ruukoto credentials list
 *   ruukoto credentials add --name N --host H --header H --purpose P --secret-env VAR
 *   ruukoto credentials remove <name>
 *   ruukoto qq configure --endpoint ws://... --self-id N [--credential N] | status | enable | disable
 *   ruukoto qq group add|remove <群号> | qq inbox|outbox [--group G] [--limit N]
 *   ruukoto telegram configure --credential N --user-id U [--chat-id C] [--api-base URL] | status | enable | disable
 *   ruukoto stop
 *
 * 两条 bin 入口：ruukoto（个人 Agent）与 ruukoto-dev（Coding Agent，ADR 0017，
 * issue 01），产品身份经 RUUKOTO_PRODUCT 固定注入。数据目录默认 ~/.ruukoto
 * （ruukoto-dev 为 ~/.ruukoto-dev-agent）；控制面目录为其兄弟目录 control/
 * （socket 与拥有者令牌）。路径环境变量按产品隔离：ruukoto 读 RUUKOTO_*_DIR，
 * ruukoto-dev 读 RUUKOTO_DEV_*_DIR。管理命令都需要拥有者令牌：取
 * RUUKOTO_OWNER_TOKEN 或受控目录的 owner.token（0600，部署时以 0400 复制给
 * 拥有者）。
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { resolveEntry } from "./cli-entry.ts";
import { ControlClient, requestOutcome } from "./control/client.ts";
import { controlDirFor, defaultAgentDir, defaultDataDir, resolveClientConfig, resolveOwnerToken } from "./control/connect.ts";
import { acquireInstanceLock, INSTANCE_LOCK_EXIT_CODE, InstanceLockError } from "./core/instance-lock.ts";
import { dirEnvFor, productFromEnv, type ProductType } from "./core/product.ts";
import { SESSION_DEFAULT_MODES, isAccessMode, type AccessMode, type GrantedPath, type ModelSelection, type Session, type Task } from "./core/types.ts";

function parseArgs(argv: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (key.includes("=")) {
        const [k, v] = key.split("=", 2);
        flags[k!] = v ?? "";
      } else {
        flags[key] = argv[++i] ?? "";
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

export function defaultDirs(): { dataDir: string; agentDir: string } {
  return {
    dataDir: defaultDataDir(),
    agentDir: defaultAgentDir(),
  };
}

async function withClient<T>(fn: (client: ControlClient) => Promise<T>): Promise<T> {
  const config = resolveClientConfig();
  const client = await ControlClient.connect(config.socketPath);
  try {
    await client.authenticate(config.token);
    return await fn(client);
  } finally {
    client.close();
  }
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/** 读 JSON 文件（迁移计划等）；不存在或非法时报错退出。 */
function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`无法读取 JSON 文件 ${file}：${(err as Error).message}`);
  }
}

/** --grant <path>:<read|read_write>[:<用途>]，多个条目用 ; 分隔。 */
function parseGrants(raw: string | undefined): GrantedPath[] | undefined {
  if (!raw) return undefined;
  const entries = raw.split(";").map((s) => s.trim()).filter(Boolean);
  return entries.map((entry) => {
    const m = /^(.+?):(read|read_write)(?::(.*))?$/.exec(entry);
    if (!m) throw new Error(`--grant 条目无效：${entry}（格式 <path>:<read|read_write>[:<用途>]）`);
    return { path: m[1]!, access: m[2] as "read" | "read_write", purpose: m[3] ?? "" };
  });
}

function parseSelection(raw: string | undefined, thinking: string | undefined): ModelSelection {
  const split = raw?.indexOf("/") ?? -1;
  if (!raw || split <= 0 || split === raw.length - 1 || !thinking) throw new Error("必须指定 provider/model 和 --thinking（含 off）；旧队列恢复用 --model provider/model --thinking off 显式确认");
  return { provider: raw.slice(0, split), modelId: raw.slice(split + 1), thinkingLevel: thinking as ModelSelection["thinkingLevel"] };
}

function parseMode(raw: string | undefined): AccessMode | undefined {
  if (!raw) return undefined;
  if (isAccessMode(raw)) return raw;
  throw new Error(`--mode 无效：${raw}（${SESSION_DEFAULT_MODES.join(" | ")}）`);
}

async function main(argv: string[]): Promise<number> {
  // 产品身份（issue 01）：两条 bin 入口注入 RUUKOTO_PRODUCT；非法取值在所有入口
  // 之前快速失败，不以错误产品触碰数据目录
  let product: ProductType;
  try {
    product = productFromEnv();
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
  const entry = resolveEntry(argv);
  switch (entry.kind) {
    case "help":
      if (entry.error) console.error(entry.error);
      console.error(defaultHelp());
      return entry.error === undefined ? 0 : 1;
    case "tui":
      return runTaskTui({ sessionId: entry.sessionId, demo: entry.demo });
    case "workspace":
      return runTaskTui({ workspace: { path: entry.path } });
    case "config": {
      const { runConfigTui } = await import("./config-tui/index.ts");
      return await runConfigTui({ offline: entry.offline });
    }
    case "server":
      try {
        return await runServer(entry.argv, product);
      } catch (err) {
        // 锁冲突收口为退出码（语义见 INSTANCE_LOCK_EXIT_CODE）：已确认竞争=42 等胜者复用；
        // 无法核实持锁身份=普通失败，保留锁供人工处理
        if (err instanceof InstanceLockError) {
          console.error(err.message);
          return err.unverifiable ? 1 : INSTANCE_LOCK_EXIT_CODE;
        }
        throw err;
      }
    case "legacy":
      return runLegacy(entry.command, entry.argv, product);
  }
}

/** 任务 TUI 调用参数：workspace 由 TUI 侧实现后并入其 Options（issue 21 接口契约）。 */
type TaskTuiOpts = Parameters<typeof import("./tui/index.ts")["runTui"]>[0] & { workspace?: { path: string } };

async function runTaskTui(opts: TaskTuiOpts): Promise<number> {
  // TUI 入口：只连接已运行的后台，不创建 SDK 会话、不加载模型凭据。
  // demo：合成调试会话，不连后台、不需要令牌、不产生真实副作用。
  const { runTui } = await import("./tui/index.ts");
  if (opts.demo) {
    console.error("合成调试会话：不连接后台，数据为静态构造，仅用于调试界面渲染");
  }
  return await runTui(opts);
}

/** server/start：前台启动后台（单实例锁、信号处理、优雅停止；启动失败非零退出）。 */
async function runServer(rest: string[], product: ProductType): Promise<number> {
  const { flags } = parseArgs(rest);
  const { Runtime } = await import("./runtime/runtime.ts");
  const { ControlServer } = await import("./control/server.ts");
  const dirs = defaultDirs();
  const dataDir = flags["data-dir"] ?? dirs.dataDir;
  const agentDir = flags["agent-dir"] ?? dirs.agentDir;
  const modelFlag = flags["model"] ?? "";
  const split = modelFlag.indexOf("/");
  if (modelFlag && (split <= 0 || split === modelFlag.length - 1)) throw new Error("--model 格式为 provider/model");
  const modelProvider = split < 0 ? undefined : modelFlag.slice(0, split);
  const modelId = split < 0 ? undefined : modelFlag.slice(split + 1);
  // 默认执行后端按产品区分（ADR 0017，agent-direction issue 04）：Coding Agent
  // 的受限执行以已验证的容器边界为默认，不在生产入口静默降级；个人 Agent 的
  // CLI 默认仍为 local，生产部署经 --execution container 或环境变量显式启用。
  // 这里覆盖的是 CLI 生产入口；库层默认（local）供测试与开发实例按各自入口使用。
  const execFlag = flags["execution"] ?? process.env.RUUKOTO_EXECUTION_BACKEND ?? (product === "ruukoto-dev" ? "container" : "local");
  if (execFlag !== "local" && execFlag !== "container") {
    console.error(`--execution 取值无效：${execFlag}（local | container；容器外完全访问经 systemd 由后端配置启用）`);
    return 1;
  }
  if (execFlag === "local") {
    console.error("警告：local 执行后端无隔离，仅用于开发/验证；生产部署请使用 --execution container 并完成 systemd 执行账户配置");
  }
  // 工具集：默认真实编码工具；mock 仅供模拟测试（crash 恢复集成验证使用）
  const toolsFlag = flags["tools"] ?? "coding";
  let toolFactory: import("./runtime/runtime.ts").RuntimeConfig["toolFactory"];
  if (toolsFlag === "mock") {
    const { createMockTools } = await import("./agent/mock-tools.ts");
    toolFactory = (ctx) => createMockTools(ctx);
  } else if (toolsFlag === "coding") {
    toolFactory = undefined; // 运行时默认：真实编码工具（路由器 + 工具工作进程）
  } else {
    console.error(`--tools 取值无效：${toolsFlag}（coding | mock）`);
    return 1;
  }
  // 服务器服务管理（agent-direction issue 09）：显式部署配置才装配；只配置
  // 一半是部署错误，直接拒绝启动而不是静默降级为无能力
  const serviceHelper = process.env.RUUKOTO_SERVICE_HELPER;
  const servicePolicy = process.env.RUUKOTO_SERVICE_POLICY;
  if ((serviceHelper && !servicePolicy) || (!serviceHelper && servicePolicy)) {
    console.error("RUUKOTO_SERVICE_HELPER 与 RUUKOTO_SERVICE_POLICY 必须同时设置（见 deploy/systemd/README.md）");
    return 1;
  }
  const runtime = await Runtime.start({
    dataDir,
    agentDir,
    // 路径环境变量按产品隔离（issue 01）：ruukoto-dev 只读 RUUKOTO_DEV_CONTROL_DIR
    controlDir: dirEnvFor(product, "CONTROL"),
    productType: product,
    // 未显式指定时不传：持久默认的思考档位才能生效（显式 --thinking 优先）
    thinkingLevel: flags["thinking"] as ModelSelection["thinkingLevel"] | undefined,
    modelProvider,
    modelId,
    execution: { backend: execFlag },
    toolFactory,
    service: serviceHelper ? { helperPath: serviceHelper, policyPath: servicePolicy! } : undefined,
    // dev 开发实例（issue 21 §1）：RUUKOTO_DISABLE_QQ=1 停用真实 QQ 通道
    qqDisabled: process.env.RUUKOTO_DISABLE_QQ === "1",
    // 同上（issue 04）：RUUKOTO_DISABLE_TELEGRAM=1 停用真实 Telegram 通道
    telegramDisabled: process.env.RUUKOTO_DISABLE_TELEGRAM === "1",
    // 显式文件参数，不从环境继承；开发实例不会自动接纳生产 webhook。
    githubWebhook: flags["github-webhook-config"]
      ? JSON.parse(fs.readFileSync(flags["github-webhook-config"], "utf8"))
      : undefined,
  });
  await ControlServer.start(runtime);
  const stopAndExit = (reason: string) => {
    void runtime.stop(reason).then(() => process.exit(0));
  };
  process.on("SIGINT", () => stopAndExit("signal_sigint"));
  process.on("SIGTERM", () => stopAndExit("signal_sigterm"));
  console.error(`${product} 后台已启动 dataDir=${dataDir} socket=${runtime.socketPath()} (pid ${process.pid})`);
  const webhook = runtime.githubWebhookAddress();
  if (webhook) console.error(`GitHub webhook http://${webhook.address}:${webhook.port}/github/webhook`);
  return 0;
}

/** 管理命令与旧拼法 tui：保持既有手卷解析与输出，供脚本与非 TTY 使用。 */
async function runLegacy(cmd: string, rest: string[], product: ProductType): Promise<number> {
  const { flags, positional } = parseArgs(rest);
  switch (cmd) {
    case "legacy-import": {
      // 跨实例导入（agent-direction issue 21，ADR 0022）：只在 ruukoto-dev 产品下可用；
      // 离线执行（不走控制面），持目标实例锁运行，源实例全程只读
      if (product !== "ruukoto-dev") {
        console.error("legacy-import 只在 ruukoto-dev 产品下可用（bin/ruukoto-dev.mjs）；个人 Agent 侧的资料迁移见后续工单");
        return 1;
      }
      return runLegacyImport(positional, flags);
    }
    case "create-project":
      print(await withClient((c) => c.request("create_project", { name: positional[0] ?? "" })));
      return 0;
    case "project": {
      // 项目指令配置（issue 05 §3；拥有者入口）：set-instructions <项目id> <工作区相对路径...>
      const sub = positional[0];
      if (sub === "set-instructions") {
        const projectId = positional[1] ?? "";
        const files = positional.slice(2);
        print(await withClient((c) => c.request("set_project_instructions", { project_id: projectId, files })));
        return 0;
      }
      // Web Search 项目开关（issue 20；拥有者入口）：web-search <项目id> <on|off>
      if (sub === "web-search") {
        const projectId = positional[1] ?? "";
        const state = positional[2] ?? "";
        if (!projectId || (state !== "on" && state !== "off")) {
          console.error("用法：ruukoto project web-search <项目id> <on|off>");
          return 1;
        }
        print(await withClient((c) => c.request("set_project_web_search", { project_id: projectId, enabled: state === "on" })));
        return 0;
      }
      // 旧数据 → 工作区组织迁移（agent-direction issue 07）：migration-preview 只读，
      // --plan 校验选择并把绑定最终选择的修订写回计划文件；migration-apply 按计划文件应用
      if (sub === "migration-preview") {
        const projectId = positional[1] ?? "";
        if (!projectId) {
          console.error("用法：ruukoto project migration-preview <项目id> [--plan <文件>] [--limit N]");
          return 1;
        }
        const planFile = flags["plan"];
        const plan = planFile ? readJsonFile(planFile) : undefined;
        const limit = flags["limit"] ? Number(flags["limit"]) : undefined;
        const preview = await withClient((c) =>
          c.request<{ instance_id: string; revision: string | null; plan_errors: string[] }>("preview_workspace_migration", {
            project_id: projectId,
            plan,
            limit,
          }),
        );
        if (planFile && preview.revision) {
          // 把绑定最终选择的修订写回计划文件（选择内容不动），供 migration-apply 使用
          fs.writeFileSync(
            planFile,
            JSON.stringify(
              { ...(plan as Record<string, unknown>), project_id: projectId, instance_id: preview.instance_id, revision: preview.revision },
              null,
              2,
            ) + "\n",
          );
        }
        print(preview);
        return preview.plan_errors.length > 0 ? 1 : 0;
      }
      if (sub === "migration-apply") {
        const planFile = flags["plan"];
        if (!planFile) {
          console.error(
            "用法：ruukoto project migration-apply --plan <文件> [--request-id <id>]\n" +
              "  计划文件由 migration-preview --plan 生成；回退：{ \"project_id\": \"…\", \"instance_id\": \"…\", \"action\": \"revert\", \"revert_request_id\": \"…\" }",
          );
          return 1;
        }
        const saved = readJsonFile(planFile) as Record<string, unknown>;
        const { project_id, instance_id, revision, ...plan } = saved;
        // 缺省请求键按计划文件内容派生：同一文件重发即原键核实（不重复执行），可用 --request-id 覆盖
        const requestId = flags["request-id"] ?? `mig_${createHash("sha256").update(JSON.stringify(saved)).digest("hex").slice(0, 24)}`;
        print(
          await withClient((c) =>
            c.request("apply_workspace_migration", {
              project_id: typeof project_id === "string" ? project_id : "",
              instance_id: typeof instance_id === "string" ? instance_id : "",
              request_id: requestId,
              plan,
              expected_revision: typeof revision === "string" ? revision : undefined,
            }),
          ),
        );
        return 0;
      }
      console.error("用法：ruukoto project set-instructions <项目id> <工作区相对路径...>（空列表 = 清除）；ruukoto project web-search <项目id> <on|off>；ruukoto project migration-preview <项目id> [--plan <文件>] [--limit N]；ruukoto project migration-apply --plan <文件> [--request-id <id>]");
      return 1;
    }
    case "create-session": {
      const confirmTools = (flags["confirm-tools"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      print(
        await withClient((c) =>
          c.request("create_session", {
            project_id: positional[0] ?? "",
            cwd: positional[1] ?? "",
            confirm_tools: confirmTools,
          }),
        ),
      );
      return 0;
    }
    case "models":
      print(await withClient((c) => c.request("list_models", { provider: flags["provider"], offset: Number(flags["offset"] ?? 0), limit: Number(flags["limit"] ?? 100) })));
      return 0;
    case "set-model":
      print(await withClient(async (c) => {
        const session = await c.request<Session>("get_session", { session_id: positional[0] ?? "" });
        return c.request("set_session_model", { session_id: session.id, expected_version: session.modelSelectionVersion, model_selection: parseSelection(positional[1], flags["thinking"]) });
      }));
      return 0;
    case "submit":
    case "continue":
      print(await withClient(async (c) => {
        const source = cmd === "continue" ? await c.request<{ task: Task }>("get_task", { task_id: positional[0] ?? "" }) : null;
        const sessionId = source?.task.sessionId ?? positional[0] ?? "";
        const requestId = positional[1] ?? "";
        const existing = await c.request<{ task: Task | null }>("find_task", { session_id: sessionId, request_id: requestId });
        if (existing.task && !existing.task.modelSelection) {
          console.error("旧任务已接收，关联原任务；旧记录无法还原完整提交参数");
          return existing.task;
        }
        const session = existing.task ? null : await c.request<Session>("get_session", { session_id: sessionId });
        const selection = flags["model"] ? parseSelection(flags["model"], flags["thinking"]) : existing.task?.modelSelection ?? session?.modelSelection;
        if (!selection) throw new Error("会话缺少模型选择，请先 set-model");
        try {
          return await c.request(cmd, { session_id: sessionId, ...(source ? { task_id: source.task.id } : {}), request_id: requestId, input: positional.slice(2).join(" "), access_mode: parseMode(flags["mode"]), granted_paths: parseGrants(flags["grant"]), model_selection: selection });
        } catch (err) {
          console.error(
            requestOutcome(err) === "rejected"
              ? `提交被拒绝：${(err as Error).message}`
              : `提交失败或接收结果未确认；请用原 request-id ${requestId} 核实，勿换键重试`,
          );
          throw err;
        }
      }));
      return 0;
    case "switch-mode":
      print(
        await withClient((c) =>
          c.request("switch_mode", {
            task_id: positional[0] ?? "",
            mode: positional[1] ?? "",
            granted_paths: parseGrants(flags["grant"]),
          }),
        ),
      );
      return 0;
    case "set-session-mode":
      print(
        await withClient(async (c) => {
          const session = await c.request<Session>("get_session", { session_id: positional[0] ?? "" });
          return c.request("set_session_mode", { session_id: session.id, mode: positional[1] ?? "", expected_version: session.defaultAccessModeVersion });
        }),
      );
      return 0;
    case "status": {
      if (positional[0]) {
        print(await withClient((c) => c.request("get_task", { task_id: positional[0] })));
      } else {
        const result = await withClient((c) => c.handshake());
        print(result.snapshot);
      }
      return 0;
    }
    case "events": {
      const controlDir = controlDirFor(defaultDataDir());
      const client = await ControlClient.connect(path.join(controlDir, "control.sock"));
      await client.authenticate(resolveOwnerToken(controlDir));
      const handshake = await client.handshake();
      console.error(`已连接（seq=${handshake.seq}），等待事件… Ctrl+C 退出`);
      client.onEvent((event) => console.log(JSON.stringify(event)));
      return 0;
    }
    case "interrupt":
      print(await withClient((c) => c.request("interrupt", { task_id: positional[0] ?? "" })));
      return 0;
    case "cancel":
      print(await withClient((c) => c.request("cancel", { task_id: positional[0] ?? "" })));
      return 0;
    case "resume-queue":
      print(await withClient((c) => c.request("resume_queue", { session_id: positional[0] ?? "", ...(flags["model"] ? { model_selection: parseSelection(flags["model"], flags["thinking"]) } : {}) })));
      return 0;
    case "confirm":
      print(
        await withClient((c) =>
          c.request("respond_confirmation", {
            confirmation_id: positional[0] ?? "",
            decision: positional[1] ?? "",
          }),
        ),
      );
      return 0;
    case "read-artifact": {
      const result = await withClient((c) =>
        c.request<{ artifact: { id: string; name: string; byteCount: number; status: string }; data: string }>(
          "read_artifact",
          {
            task_id: positional[0] ?? "",
            artifact_id: positional[1] ?? "",
            offset: flags["offset"] === undefined ? undefined : Number(flags["offset"]),
            length: flags["length"] === undefined ? undefined : Number(flags["length"]),
          },
        ),
      );
      console.error(
        `artifact ${result.artifact.id}（${result.artifact.name}，共 ${result.artifact.byteCount} 字节，${result.artifact.status}）`,
      );
      process.stdout.write(Buffer.from(result.data, "base64"));
      return 0;
    }
    case "credentials": {
      const sub = positional[0];
      if (sub === "list") {
        print(await withClient((c) => c.request("list_credentials", {})));
        return 0;
      }
      if (sub === "add") {
        const secretEnv = flags["secret-env"];
        if (!secretEnv) throw new Error("credentials add 需要 --secret-env <环境变量名>（秘密值不进入命令行）");
        const secret = process.env[secretEnv];
        if (!secret) throw new Error(`环境变量 ${secretEnv} 为空`);
        print(
          await withClient((c) =>
            c.request("add_credential", {
              name: flags["name"] ?? "",
              host: flags["host"] ?? "",
              header: flags["header"] ?? "",
              purpose: flags["purpose"] ?? "",
              secret,
            }),
          ),
        );
        return 0;
      }
      if (sub === "remove") {
        print(await withClient((c) => c.request("remove_credential", { name: positional[1] ?? "" })));
        return 0;
      }
      console.error("用法：ruukoto credentials list | add --name N --host H --header H --purpose P --secret-env VAR | remove <name>");
      return 1;
    }
    case "github": {
      // issue 17：专用 GitHub 模块已退役。旧命令不再执行业务操作，只保留静态迁移提示。
      console.error(
        "GitHub 专用模块已退役（issue 17）：PR/issue/CI 等操作请改用通用 MCP 服务（ruukoto mcp configure …，见 docs/runtime.md「MCP 服务」）。\n" +
          "历史草稿与发布记录已归档为原任务产物（清单：<数据目录>/github-archive-manifest.json）；旧待审批/待发布操作已失效，不会发送。",
      );
      return 1;
    }
    case "mcp": {
      const sub = positional[0];
      if (sub === "configure") {
        // --tools 条目：name = 只读工具；name:write / name:unknown = 有副作用/副作用不明（逐次审批）
        const toolAllowlist = (flags["tools"] ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((entry) => {
          const idx = entry.lastIndexOf(":");
          if (idx === -1) return entry;
          const effect = entry.slice(idx + 1);
          if (!["read", "write", "unknown"].includes(effect)) {
            throw new Error(`--tools 条目 ${entry} 的副作用类别必须是 read | write | unknown`);
          }
          return { name: entry.slice(0, idx), effect };
        });
        print(
          await withClient((c) =>
            c.request("mcp_configure", {
              project_id: flags["project"] ?? "",
              name: flags["name"] ?? "",
              endpoint: flags["endpoint"] ?? "",
              credential: flags["credential"],
              tool_allowlist: toolAllowlist,
              enabled: flags["disabled"] !== undefined ? false : undefined,
              expected_version: flags["expected-version"] === undefined ? undefined : Number(flags["expected-version"]),
            }),
          ),
        );
        return 0;
      }
      if (sub === "list") {
        print(await withClient((c) => c.request("mcp_list", { project_id: flags["project"] })));
        return 0;
      }
      if (sub === "enable" || sub === "disable") {
        print(
          await withClient((c) =>
            c.request("mcp_set_enabled", {
              service_id: positional[1] ?? "",
              enabled: sub === "enable",
              expected_version: flags["expected-version"] === undefined ? undefined : Number(flags["expected-version"]),
            }),
          ),
        );
        return 0;
      }
      if (sub === "remove") {
        print(
          await withClient((c) =>
            c.request("mcp_remove", {
              service_id: positional[1] ?? "",
              expected_version: flags["expected-version"] === undefined ? undefined : Number(flags["expected-version"]),
            }),
          ),
        );
        return 0;
      }
      if (sub === "check") {
        // 检查连接前明确展示将联系的服务（端点），再发请求
        print(
          await withClient(async (c) => {
            const list = (await c.request("mcp_list", {})) as any;
            const target = (list.services as any[]).find((s) => s.id === positional[1]);
            if (target) console.error(`连接检查：${target.name}（${target.endpoint}）`);
            return c.request("mcp_check", { service_id: positional[1] ?? "" });
          }),
        );
        return 0;
      }
      console.error(
        "用法：\n" +
          "  ruukoto mcp configure --project <id> --name <slug> --endpoint <url> [--credential <name>] [--tools a,b:write,c:unknown] [--disabled] [--expected-version N]\n" +
          "    （--tools 条目：name = 只读工具；name:write / name:unknown = 有副作用/副作用不明，confirm 模式逐次审批）\n" +
          "  ruukoto mcp list [--project <id>] | enable <service-id> | disable <service-id> | remove <service-id> [--expected-version N]\n" +
          "  ruukoto mcp check <service-id>（连接检查 + 工具列表，标注允许/未允许与副作用类别）",
      );
      return 1;
    }
    case "stop":
      print(await withClient((c) => c.request("stop", {})));
      return 0;
    case "qq": {
      // QQ 群聊入口（issue 07，NapCat OneBot v11）：token 凭据先经
      // credentials add --purpose qq_onebot 登记，再以 --credential 引用名称
      const sub = positional[0];
      if (sub === "configure") {
        print(
          await withClient((c) =>
            c.request("qq_configure", {
              endpoint: flags["endpoint"] ?? "",
              // --no-credential 显式清除凭据引用；缺省 --credential 则保留现有
              credential: flags["no-credential"] !== undefined ? null : flags["credential"],
              self_id: flags["self-id"] ?? "",
              owner_user_id: flags["no-owner"] !== undefined ? null : flags["owner-id"],
              max_reply_chars: flags["max-reply-chars"] === undefined ? undefined : Number(flags["max-reply-chars"]),
              expected_version: flags["expected-version"] === undefined ? undefined : Number(flags["expected-version"]),
            }),
          ),
        );
        return 0;
      }
      if (sub === "status") {
        print(await withClient((c) => c.request("qq_status", {})));
        return 0;
      }
      if (sub === "enable" || sub === "disable") {
        print(
          await withClient((c) =>
            c.request("qq_set_enabled", {
              enabled: sub === "enable",
              expected_version: flags["expected-version"] === undefined ? undefined : Number(flags["expected-version"]),
            }),
          ),
        );
        return 0;
      }
      if (sub === "group") {
        const action = positional[1];
        if (action === "add" || action === "remove") {
          print(
            await withClient((c) =>
              c.request("qq_group_update", {
                group_id: positional[2] ?? "",
                allow: action === "add",
                expected_version: flags["expected-version"] === undefined ? undefined : Number(flags["expected-version"]),
              }),
            ),
          );
          return 0;
        }
        console.error("用法：ruukoto qq group add <群号> | remove <群号>");
        return 1;
      }
      if (sub === "inbox" || sub === "outbox") {
        print(
          await withClient((c) =>
            c.request(sub === "inbox" ? "qq_inbox_list" : "qq_outbox_list", {
              group_id: flags["group"],
              limit: flags["limit"] === undefined ? undefined : Number(flags["limit"]),
            }),
          ),
        );
        return 0;
      }
      console.error(
        "用法：\n" +
          "  ruukoto qq configure --endpoint ws://127.0.0.1:3001 --self-id <QQ号> [--credential <名称> | --no-credential] [--owner-id <拥有者QQ号> | --no-owner] [--max-reply-chars N] [--expected-version N]\n" +
          "    （owner 私聊需 token；仅接好友纯文本，共享 main 会话；--no-owner 关闭私聊）\n" +
          "    （token 先经 ruukoto credentials add --name N --host H --header authorization --purpose qq_onebot --secret-env VAR 登记）\n" +
          "  ruukoto qq status | enable | disable\n" +
          "  ruukoto qq group add <群号> | remove <群号>\n" +
          "  ruukoto qq inbox [--group <群号>] [--limit N] | outbox [--group <群号>] [--limit N]",
      );
      return 1;
    }
    case "telegram": {
      // Telegram owner 入口（issue 04）：bot token 先经
      // credentials add --purpose telegram_bot 登记，再以 --credential 引用名称
      const sub = positional[0];
      const expected_version = flags["expected-version"] === undefined ? undefined : Number(flags["expected-version"]);
      if (sub === "configure") {
        print(await withClient((c) => c.request("telegram_configure", {
          credential: flags["credential"] ?? "",
          user_id: flags["user-id"] ?? "",
          chat_id: flags["chat-id"],
          api_base: flags["api-base"],
          expected_version,
        })));
        return 0;
      }
      if (sub === "status") {
        print(await withClient((c) => c.request("telegram_status", {})));
        return 0;
      }
      if (sub === "enable" || sub === "disable") {
        print(await withClient((c) => c.request("telegram_set_enabled", { enabled: sub === "enable", expected_version })));
        return 0;
      }
      console.error(
        "用法：\n" +
          "  ruukoto telegram configure --credential <名称> --user-id <owner user_id> [--chat-id <chat_id>] [--api-base https://...] [--expected-version N]\n" +
          "    （token 先经 ruukoto credentials add --name N --host api.telegram.org --header none --purpose telegram_bot --secret-env VAR 登记）\n" +
          "  ruukoto telegram status | enable | disable",
      );
      return 1;
    }
    case "schedule":
    case "notify": {
      // 调度计划与通知发送账本（issue 03）：列表/详情/取消；审批仍在 TUI
      const sub = positional[0];
      const isSchedule = cmd === "schedule";
      const idKey = isSchedule ? "schedule_id" : "op_id";
      if (sub === "list") {
        print(await withClient((c) => c.request(isSchedule ? "schedule_list" : "notification_list", {
          status: flags["status"],
          cursor: flags["cursor"],
          limit: flags["limit"] === undefined ? undefined : Number(flags["limit"]),
        })));
        return 0;
      }
      if (sub === "show" && positional[1]) {
        print(await withClient((c) => c.request(isSchedule ? "schedule_get" : "notification_get", { [idKey]: positional[1] })));
        return 0;
      }
      if (sub === "cancel" && positional[1]) {
        print(await withClient((c) => c.request(isSchedule ? "schedule_cancel" : "notification_cancel", {
          [idKey]: positional[1],
          reason: flags["reason"] ?? "",
          ...(isSchedule ? { expected_version: flags["expected-version"] === undefined ? undefined : Number(flags["expected-version"]) } : {}),
        })));
        return 0;
      }
      console.error(
        "用法：\n" +
          "  ruukoto schedule list [--status active|completed|canceled] [--cursor C] [--limit N] | show <id> | cancel <id> --expected-version N --reason R\n" +
          "  ruukoto notify list [--status pending|sending|sent|failed|effect_unknown|canceled] [--cursor C] [--limit N] | show <op-id> | cancel <op-id> --reason R",
      );
      return 1;
    }
    case "work": {
      // 工作委托与 SubAgent（agent-direction issue 11）：只读查询；委派经模型工具
      const sub = positional[0];
      if (sub === "list") {
        print(await withClient((c) => c.request("work_list", {
          session_id: flags["session"],
        })));
        return 0;
      }
      if (sub === "show" && positional[1]) {
        print(await withClient((c) => c.request("work_get", { work_id: positional[1] })));
        return 0;
      }
      // 显式关闭 SubAgent（issue 12）：有活动任务拒绝并提示先 cancel；已关闭幂等
      if (sub === "close" && positional[1]) {
        print(await withClient((c) => c.request("subagent_close", { sub_agent_id: positional[1] })));
        return 0;
      }
      // 整项取消工作（issue 14）：停止其活动与排队任务，其他工作不受影响；已取消幂等
      if (sub === "cancel" && positional[1]) {
        print(await withClient((c) => c.request("work_cancel", { work_id: positional[1], reason: flags["reason"] })));
        return 0;
      }
      console.error(
        "用法：\n" +
          "  ruukoto work list [--session <会话ID>]\n" +
          "  ruukoto work show <工作ID>\n" +
          "  ruukoto work close <SubAgentID>\n" +
          "  ruukoto work cancel <工作ID> [--reason R]",
      );
      return 1;
    }
    case "service-grant": {
      // 长期操作授权（agent-direction issue 10）：入口停用后的遗留目录管理；
      // 目录权限不能用于放行旧授权；创建首版只经原 IM 待审批请求
      const sub = positional[0];
      if (sub === "list") {
        print(await withClient((c) => c.request("service_grant_list", {
          cursor: flags["cursor"],
          limit: flags["limit"] === undefined ? undefined : Number(flags["limit"]),
        })));
        return 0;
      }
      if (sub === "show" && positional[1]) {
        print(await withClient((c) => c.request("service_grant_get", { permission_id: positional[1] })));
        return 0;
      }
      if (sub === "revoke" && positional[1]) {
        print(await withClient((c) => c.request("service_grant_revoke", {
          permission_id: positional[1],
          expected_version: flags["expected-version"] === undefined ? undefined : Number(flags["expected-version"]),
        })));
        return 0;
      }
      console.error(
        "用法：\n" +
          "  ruukoto service-grant list [--cursor C] [--limit N]\n" +
          "  ruukoto service-grant show <授权ID>\n" +
          "  ruukoto service-grant revoke <授权ID> --expected-version N",
      );
      return 1;
    }
    case "grant": {
      const sub = positional[0];
      if (sub === "create") {
        print(
          await withClient((c) =>
            c.request("create_data_grant", {
              from_project_id: flags["from"] ?? "",
              to_project_id: flags["to"] ?? "",
              category: flags["category"] ?? "",
              purpose: flags["purpose"],
            }),
          ),
        );
        return 0;
      }
      if (sub === "revoke") {
        print(await withClient((c) => c.request("revoke_data_grant", { grant_id: positional[1] ?? "" })));
        return 0;
      }
      if (sub === "list") {
        print(await withClient((c) => c.request("list_data_grants", { include_revoked: flags["all"] !== undefined })));
        return 0;
      }
      console.error("用法：ruukoto grant create --from <项目> --to <项目> --category <history|artifact|memory> [--purpose P]\n" +
        "      ruukoto grant list [--all] | ruukoto grant revoke <grant-id>");
      return 1;
    }
    case "history-search": {
      const cursorRaw = flags["cursor"];
      const cursor = cursorRaw ? JSON.parse(Buffer.from(cursorRaw, "base64").toString("utf8")) : undefined;
      const result = await withClient((c) =>
        c.request<{ hits: unknown[]; complete: boolean; cursor: unknown; scanned: number; unindexedSessionIds: string[] }>(
          "search_history",
          {
            query: positional[0] ?? "",
            project_id: flags["project"],
            session_id: flags["session"],
            task_id: flags["task"],
            role: flags["role"],
            since: flags["since"],
            until: flags["until"],
            limit: flags["limit"] === undefined ? undefined : Number(flags["limit"]),
            scan_limit: flags["scan-limit"] === undefined ? undefined : Number(flags["scan-limit"]),
            cursor,
          },
        ),
      );
      print(result);
      if (!result.complete) {
        console.error(
          `结果不完整（已扫描 ${result.scanned} 条）。继续游标：${Buffer.from(JSON.stringify(result.cursor)).toString("base64")}`,
        );
      }
      if (result.unindexedSessionIds.length > 0) {
        console.error(`未建立索引的会话（历史未落盘）：${result.unindexedSessionIds.join(", ")}`);
      }
      return 0;
    }
    case "memory": {
      const sub = positional[0];
      if (sub === "list") {
        print(
          await withClient((c) =>
            c.request("list_memories", {
              project_id: flags["project"],
              personal: flags["personal"] !== undefined,
            }),
          ),
        );
        return 0;
      }
      if (sub === "show") {
        print(await withClient((c) => c.request("get_memory", { memory_id: positional[1] ?? "" })));
        return 0;
      }
      if (sub === "save") {
        const contentFile = flags["content-file"];
        const content = contentFile
          ? (await import("node:fs")).readFileSync(contentFile, "utf8")
          : positional.slice(1).join(" ");
        print(
          await withClient((c) =>
            c.request("save_memory", {
              memory_id: flags["id"],
              expected_version: flags["expected-version"] === undefined ? undefined : Number(flags["expected-version"]),
              project_id: flags["personal"] !== undefined ? null : (flags["project"] ?? null),
              category: flags["category"] ?? "",
              content,
              source_refs: JSON.parse(flags["source-refs"] ?? "null") ?? [
                { kind: "owner_note", note: flags["source-note"] ?? "拥有者经 CLI 录入" },
              ],
              reason: flags["reason"],
            }),
          ),
        );
        return 0;
      }
      if (sub === "revoke") {
        print(
          await withClient((c) =>
            c.request("revoke_memory", {
              memory_id: positional[1] ?? "",
              expected_version: Number(flags["expected-version"] ?? "0"),
              reason: flags["reason"],
            }),
          ),
        );
        return 0;
      }
      if (sub === "restore") {
        print(
          await withClient((c) =>
            c.request("restore_memory", {
              memory_id: positional[1] ?? "",
              from_version: Number(flags["from-version"] ?? "0"),
              reason: flags["reason"],
            }),
          ),
        );
        return 0;
      }
      console.error(
        "用法：ruukoto memory list [--project <id> | --personal]\n" +
          "      ruukoto memory show <id>\n" +
          "      ruukoto memory save <内容...> --category <preference|convention|decision|experience> [--project <id> | --personal]\n" +
          "        [--id <id> --expected-version N（修订）] [--content-file F] [--source-refs JSON] [--source-note N] [--reason R]\n" +
          "      ruukoto memory revoke <id> --expected-version N [--reason R]\n" +
          "      ruukoto memory restore <id> --from-version N [--reason R]",
      );
      return 1;
    }
    case "selection-records": {
      print(
        await withClient((c) =>
          c.request("list_selection_records", {
            task_id: flags["task"],
            session_id: flags["session"],
            limit: flags["limit"] === undefined ? undefined : Number(flags["limit"]),
          }),
        ),
      );
      return 0;
    }
    case "tui": {
      // 旧拼法（已迁移到无参 ruukoto / ruukoto --session <id> / ruukoto --demo）：
      // 打印迁移指引后仍按旧行为启动任务界面。
      console.error(
        "ruukoto tui 为旧拼法，请改用：无参 ruukoto（默认会话）、ruukoto --session <id>、ruukoto --demo；本次仍按旧拼法启动",
      );
      return await runTaskTui({ sessionId: flags["session"], demo: flags["demo"] !== undefined });
    }
    default:
      console.error(defaultHelp());
      return 1;
  }
}

/**
 * 跨实例导入（agent-direction issue 21，ADR 0022）：旧 ruukoto 实例的开发资料
 * 迁入 ruukoto-dev 档案。目标侧离线执行（不走控制面）：预览/应用都要求目标后台
 * 已停止，持目标实例锁运行；源实例全程只读，源后台存活时拒绝。
 *   legacy-import preview --from <源数据目录> [--plan <文件>]
 *   legacy-import apply --plan <文件> [--request-id <id>]
 *   legacy-import revert <导入ID>
 *   legacy-import list
 */
async function runLegacyImport(positional: string[], flags: Record<string, string>): Promise<number> {
  const mod = await import("./runtime/legacy-import.ts");
  const dirs = defaultDirs();
  const deps = {
    targetDataDir: flags["data-dir"] ?? dirs.dataDir,
    targetAgentDir: flags["agent-dir"] ?? dirs.agentDir,
  };
  const sub = positional[0];
  const lockIfDirExists = (dir: string) => (fs.existsSync(dir) ? acquireInstanceLock(dir) : null);
  try {
    if (sub === "preview") {
      const from = flags["from"] ?? "";
      if (!from) {
        console.error("用法：ruukoto-dev legacy-import preview --from <源数据目录> [--plan <文件>] [--data-dir D] [--agent-dir A]");
        return 1;
      }
      const planFile = flags["plan"];
      let plan: Record<string, unknown> | undefined;
      if (planFile && fs.existsSync(planFile)) plan = readJsonFile(planFile) as Record<string, unknown>;
      const lock = lockIfDirExists(deps.targetDataDir);
      try {
        const preview = mod.previewLegacyImport(deps, { from, plan });
        if (planFile) {
          // 把绑定最终选择的修订与源实例写回计划文件（renames/personal_memories 选择不动），供 apply 使用
          fs.writeFileSync(
            planFile,
            JSON.stringify(
              {
                ...(plan ?? {}),
                from: preview.plan.from,
                renames: preview.plan.renames,
                personal_memories: preview.plan.personal_memories,
                source_instance_id: preview.source.instance_id,
                revision: preview.revision,
              },
              null,
              2,
            ) + "\n",
          );
        }
        print(preview);
        return preview.plan_errors.length > 0 ? 1 : 0;
      } finally {
        lock?.release();
      }
    }
    if (sub === "apply") {
      const planFile = flags["plan"];
      if (!planFile) {
        console.error("用法：ruukoto-dev legacy-import apply --plan <文件> [--request-id <id>]（计划文件由 preview --plan 生成）");
        return 1;
      }
      const saved = readJsonFile(planFile) as Record<string, unknown>;
      const { source_instance_id, revision, from, renames, personal_memories } = saved;
      if (typeof from !== "string" || from === "") {
        console.error("计划文件缺少 from（源数据目录）");
        return 1;
      }
      // 缺省请求键按计划文件内容派生：同一文件重发即原键核实（不重复执行），可用 --request-id 覆盖
      const requestId = flags["request-id"] ?? `imp_${createHash("sha256").update(JSON.stringify(saved)).digest("hex").slice(0, 24)}`;
      fs.mkdirSync(deps.targetDataDir, { recursive: true, mode: 0o700 });
      const lock = acquireInstanceLock(deps.targetDataDir);
      try {
        const result = mod.applyLegacyImport(deps, {
          plan: {
            from,
            renames: renames as Record<string, string> | undefined,
            personal_memories: personal_memories as string[] | undefined,
          },
          source_instance_id: typeof source_instance_id === "string" ? source_instance_id : "",
          revision: typeof revision === "string" ? revision : "",
          request_id: requestId,
        });
        print(result);
        return 0;
      } finally {
        lock.release();
      }
    }
    if (sub === "revert") {
      const importId = positional[1] ?? "";
      if (!importId) {
        console.error("用法：ruukoto-dev legacy-import revert <导入ID>（导入 ID 见 legacy-import list）");
        return 1;
      }
      const lock = lockIfDirExists(deps.targetDataDir);
      try {
        const result = mod.revertLegacyImport(deps, importId);
        print(result);
        return result.ok ? 0 : 1;
      } finally {
        lock?.release();
      }
    }
    if (sub === "list") {
      const lock = lockIfDirExists(deps.targetDataDir);
      try {
        print(mod.listLegacyImports(deps));
        return 0;
      } finally {
        lock?.release();
      }
    }
    console.error(
      "用法：ruukoto-dev legacy-import preview --from <源数据目录> [--plan <文件>] | apply --plan <文件> [--request-id <id>] | revert <导入ID> | list",
    );
    return 1;
  } catch (err) {
    if (err instanceof InstanceLockError) {
      console.error(err.message);
      return err.unverifiable ? 1 : INSTANCE_LOCK_EXIT_CODE;
    }
    if (err instanceof mod.LegacyImportError) {
      console.error(`错误[${err.code}]：${err.message}`);
      return 1;
    }
    throw err;
  }
}

function defaultHelp(): string {
  return (
    "产品：ruukoto（个人 Agent）与 ruukoto-dev（Coding Agent）两条入口共用本 CLI（ADR 0017）。\n" +
    "      ruukoto-dev 使用独立档案目录（默认 ~/.ruukoto-dev-agent，环境变量 RUUKOTO_DEV_*_DIR），\n" +
    "      不启动 QQ/Telegram 连接与个人调度；路径环境变量按产品隔离（RUUKOTO_*_DIR / RUUKOTO_DEV_*_DIR）。\n" +
    "用法：ruukoto [路径] [--session <id> | --demo]      任务界面：无参进入默认会话；路径打开该工作区（每次启动新建会话）\n" +
    "      ruukoto -- <路径>                             显式工作区入口（目录与命令同名时用，如 ruukoto -- config）\n" +
    "      ruukoto config [--offline]                    独立配置中心\n" +
    "      ruukoto server [启动参数]                     前台启动后台（start 为兼容别名，文档推荐 server）\n" +
    "管理命令：models | set-model <session> <provider/model> --thinking <level> | set-session-mode <session> <confirm|full_access|auto-review> |\n" +
    "      create-project | create-session | submit | continue | switch-mode | status | events |\n" +
    "      interrupt | cancel | resume-queue | confirm | read-artifact | credentials | mcp | qq | telegram | stop |\n" +
    "      grant | service-grant list/show/revoke | work list/show/close | history-search | memory | selection-records |\n" +
    "      project set-instructions | project web-search | project migration-preview | project migration-apply\n" +
    "      legacy-import（仅 ruukoto-dev）：旧 ruukoto 实例开发资料迁入 Coding Agent，离线执行，\n" +
    "      要求目标后台已停止、源后台已停止；preview --from <源数据目录> [--plan 文件] | apply --plan 文件 | revert <导入ID> | list\n" +
    "参数：--data-dir / --agent-dir / --execution / --model / --thinking / --github-webhook-config（server）；--mode / --grant（submit/continue/switch-mode）；\n" +
    "      --session <id>（任务界面：直接进入指定会话，不存在则报错）；--demo（合成调试会话，不连后台）\n" +
    "旧拼法：ruukoto tui 仍可用，请迁移到无参 ruukoto / ruukoto --session <id> / ruukoto --demo\n" +
    "认证：RUUKOTO_OWNER_TOKEN、RUUKOTO_OWNER_TOKEN_FILE 或 <数据目录>/../control/owner.token"
  );
}

process.exitCode = await main(process.argv.slice(2));
