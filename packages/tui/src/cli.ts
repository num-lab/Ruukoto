/** CLI dispatch for the local runtime, configuration center and task interface. */

import { ControlClient,requestOutcome } from "@ruukoto/control/client.ts";
import type { OpResult } from "@ruukoto/control/ops.ts";
import { resolveClientConfig } from "@ruukoto/control/connect.ts";
import { INSTANCE_LOCK_EXIT_CODE, InstanceLockError } from "@ruukoto/core/instance-lock.ts";
import { bootstrapProfile, readProfile, selectProfile, type ProfilePaths } from "@ruukoto/core/profile.ts";
import { isSessionDefaultMode,SESSION_DEFAULT_MODES,type Artifact,type GrantedPath,type ModelSelection,type Session,type SessionDefaultMode,type Task } from "@ruukoto/core/types.ts";
import * as fs from "node:fs";
import { exportArtifact } from "./artifact-export.ts";
import { parseDirectoryFlags, resolveEntry } from "./cli-entry.ts";
import { parseWorkflowControl, type WorkflowControl } from "@ruukoto/core/workflow.ts";
import { runTui, type TuiOptions } from "./tui/index.ts";
import { runConfigTui } from "./config-tui/index.ts";
import { Runtime, type RuntimeConfig } from "@ruukoto/runtime/runtime.ts";
import { ControlServer } from "@ruukoto/control/server.ts";
import { createMockTools } from "@ruukoto/agent/mock-tools.ts";

function resolveExecutionBackend(override: string | undefined): "native" | null {
  if (override !== undefined && override !== "native") {
    process.stderr.write("[ruukoto:cli] 受限执行仅支持 native；移除 --execution / RUUKOTO_EXECUTION_BACKEND 覆盖或设置 native。\n");
    return null;
  }
  return "native";
}

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

async function withClient<T>(profile: ProfilePaths, fn: (client: ControlClient) => Promise<T>): Promise<T> {
  const config = resolveClientConfig(profile);
  const client = await ControlClient.connect(config.socketPath);
  try {
    await client.authenticate(config.token, profile);
    await client.handshake();
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

function parseMode(raw: string | undefined): SessionDefaultMode | undefined {
  if (!raw) return undefined;
  if (isSessionDefaultMode(raw)) return raw;
  throw new Error(`--mode 无效：${raw}（${SESSION_DEFAULT_MODES.join(" | ")}）`);
}

export async function runCli(argv: string[]): Promise<number> {
  const parsed = parseDirectoryFlags(argv);
  const entry = parsed.error ? { kind: "help" as const, error: parsed.error } : resolveEntry(parsed.argv);
  if (entry.kind === "help") {
    if (entry.error) console.error(entry.error);
    console.error(defaultHelp());
    return entry.error === undefined ? 0 : 1;
  }
  if (entry.kind === "tui" && entry.demo) return runTaskTui({ demo: true });
  const interactive = entry.kind === "tui" || entry.kind === "workspace" || entry.kind === "config" || (entry.kind === "command" && entry.command === "mcp" && entry.argv[0] === "cua");
  if (entry.kind === "command" && entry.command === "mcp" && entry.argv.some(arg => arg === "--project" || arg.startsWith("--project="))) {
    process.stderr.write("[ruukoto:cli] MCP 按实例配置，不接受 --project。\n");
    return 1;
  }
  if (interactive && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    process.stderr.write("[ruukoto:cli] TUI 需要交互式终端（TTY）。\n");
    return 1;
  }
  if (entry.kind === "server") {
    const { flags } = parseArgs(entry.argv);
    if (flags["model"] && !/^[^/]+\/.+$/.test(flags["model"])) {
      process.stderr.write("[ruukoto:cli] --model 格式为 provider/model。\n");
      return 1;
    }
    if (flags["tools"] && !["coding", "mock"].includes(flags["tools"])) {
      process.stderr.write("[ruukoto:cli] --tools 仅接受 coding 或 mock。\n");
      return 1;
    }
  }
  const serverFlags = entry.kind === "server" ? parseArgs(entry.argv).flags : undefined;
  if ((entry.kind === "server" || entry.kind === "tui" || entry.kind === "workspace") &&
      resolveExecutionBackend(serverFlags?.["execution"] ?? process.env.RUUKOTO_EXECUTION_BACKEND) === null) return 1;
  try {
    const selection = selectProfile(parsed.directories);
    const profile = entry.kind === "command" && !(entry.command === "mcp" && entry.argv[0] === "cua")
      ? readProfile(selection)
      : await bootstrapProfile(selection);
    if (!profile) {
      process.stderr.write("[ruukoto:cli] 所选实例尚未初始化；先运行 ruukoto config --offline。\n");
      return 1;
    }
    switch (entry.kind) {
      case "tui": return await runTaskTui({ profile, sessionId: entry.sessionId });
      case "workspace": return await runTaskTui({ profile, workspace: { path: entry.path } });
      case "config": {
        return await runConfigTui({ profile, offline: entry.offline });
      }
      case "server": return await runServer(entry.argv, profile);
      case "command": return await runManagement(entry.command, entry.argv, profile);
    }
  } catch (error) {
    process.stderr.write(`[ruukoto:cli] ${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof InstanceLockError && !error.unverifiable ? INSTANCE_LOCK_EXIT_CODE : 1;
  }
}

async function runTaskTui(opts: TuiOptions): Promise<number> {
  // TUI 入口：只连接已运行的后台，不创建 SDK 会话、不加载模型凭据。
  // demo：合成调试会话，不连后台、不需要令牌、不产生真实副作用。
  if (opts.demo) {
    console.error("合成调试会话：不连接后台，数据为静态构造，仅用于调试界面渲染");
  }
  return await runTui(opts);
}

/** Foreground backend lifecycle; runtime owns the instance lock. */
async function runServer(rest: string[], profile: ProfilePaths): Promise<number> {
  const { flags } = parseArgs(rest);
  const modelFlag = flags["model"] ?? "";
  const split = modelFlag.indexOf("/");
  if (modelFlag && (split <= 0 || split === modelFlag.length - 1)) throw new Error("--model 格式为 provider/model");
  const modelProvider = split < 0 ? undefined : modelFlag.slice(0, split);
  const modelId = split < 0 ? undefined : modelFlag.slice(split + 1);
  const execFlag = resolveExecutionBackend(flags["execution"] ?? process.env.RUUKOTO_EXECUTION_BACKEND);
  if (execFlag === null) return 1;
  // 工具集：默认真实编码工具；mock 仅供模拟测试（crash 恢复集成验证使用）
  const toolsFlag = flags["tools"] ?? "coding";
  let toolFactory: RuntimeConfig["toolFactory"];
  if (toolsFlag === "mock") {
    toolFactory = (ctx) => createMockTools(ctx);
  } else if (toolsFlag === "coding") {
    toolFactory = undefined; // 运行时默认：真实编码工具（路由器 + 工具工作进程）
  } else {
    console.error(`--tools 取值无效：${toolsFlag}（coding | mock）`);
    return 1;
  }
  const runtime = await Runtime.start({
    profile,
    // 未显式指定时不传：持久默认的思考档位才能生效（显式 --thinking 优先）
    thinkingLevel: flags["thinking"] as ModelSelection["thinkingLevel"] | undefined,
    modelProvider,
    modelId,
    execution: { backend: execFlag },
    toolFactory,
    browser: { binaryPath: process.env.RUUKOTO_BROWSER_BINARY, chromePath: process.env.RUUKOTO_BROWSER_CHROME },
  });
  await ControlServer.start(runtime);
  const stopAndExit = (reason: string) => {
    void runtime.stop(reason).then(() => process.exit(0));
  };
  process.on("SIGINT", () => stopAndExit("signal_sigint"));
  process.on("SIGTERM", () => stopAndExit("signal_sigterm"));
  console.error(`ruukoto 后台已启动 dataDir=${profile.dataDir} agentDir=${profile.agentDir} controlDir=${profile.controlDir} pendingDir=${profile.pendingDir} socket=${profile.socketPath} (pid ${process.pid})`);
  return 0;
}

/** 管理命令与旧拼法 tui：保持既有手卷解析与输出，供脚本与非 TTY 使用。 */
async function runManagement(cmd: string, rest: string[], profile: ProfilePaths): Promise<number> {
  const { flags, positional } = parseArgs(rest);
  switch (cmd) {
    case "workflow":
      return runWorkflowCli(positional, flags, profile);
    case "project": {
      // 项目指令配置（issue 05 §3；拥有者入口）：set-instructions <项目id> <工作区相对路径...>
      const sub = positional[0];
      if (sub === "set-instructions") {
        const projectId = positional[1] ?? "";
        const files = positional.slice(2);
        print(await withClient(profile, (c) => c.request("set_project_instructions", { project_id: projectId, files })));
        return 0;
      }
      console.error("用法：ruukoto project set-instructions <项目id> <工作区相对路径...>（空列表 = 清除）");
      return 1;
    }
    case "models":
      print(await withClient(profile, (c) => c.request("list_models", { provider: flags["provider"], offset: Number(flags["offset"] ?? 0), limit: Number(flags["limit"] ?? 100) })));
      return 0;
    case "set-model":
      print(await withClient(profile, async (c) => {
        const session = await c.request<Session>("get_session", { session_id: positional[0] ?? "" });
        return c.request("set_session_model", { session_id: session.id, expected_version: session.modelSelectionVersion, model_selection: parseSelection(positional[1], flags["thinking"]) });
      }));
      return 0;
    case "submit":
      print(await withClient(profile, async (c) => {
        const sessionId = positional[0] ?? "";
        const requestId = positional[1] ?? "";
        const existing = await c.request<{ task: Task | null }>("find_task", { session_id: sessionId, request_id: requestId });
        const session = existing.task ? null : await c.request<Session>("get_session", { session_id: sessionId });
        const selection = flags["model"] ? parseSelection(flags["model"], flags["thinking"]) : existing.task?.modelSelection ?? session?.modelSelection;
        if (!selection) throw new Error("会话缺少模型选择，请先 set-model");
        try {
          return await c.request(cmd, { session_id: sessionId, request_id: requestId, input: positional.slice(2).join(" "), access_mode: parseMode(flags["mode"]), granted_paths: parseGrants(flags["grant"]), model_selection: selection });
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
        await withClient(profile, (c) =>
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
        await withClient(profile, async (c) => {
          const session = await c.request<Session>("get_session", { session_id: positional[0] ?? "" });
          return c.request("set_session_mode", { session_id: session.id, mode: positional[1] ?? "", expected_version: session.defaultAccessModeVersion });
        }),
      );
      return 0;
    case "status": {
      if (positional[0]) {
        print(await withClient(profile, (c) => c.request("get_task", { task_id: positional[0] })));
      } else {
        const result = await withClient(profile, (c) => c.handshake());
        print(result.snapshot);
      }
      return 0;
    }
    case "events": {
      const config = resolveClientConfig(profile);
      const client = await ControlClient.connect(config.socketPath);
      await client.authenticate(config.token, profile);
      const handshake = await client.handshake();
      console.error(`已连接（seq=${handshake.seq}），等待事件… Ctrl+C 退出`);
      client.onEvent((event) => console.log(JSON.stringify(event)));
      return 0;
    }
    case "interrupt":
      print(await withClient(profile, (c) => c.request("interrupt", { task_id: positional[0] ?? "" })));
      return 0;
    case "cancel":
      print(await withClient(profile, (c) => c.request("cancel", { task_id: positional[0] ?? "" })));
      return 0;
    case "resume-queue":
      print(await withClient(profile, (c) => c.request("resume_queue", { session_id: positional[0] ?? "", ...(flags["stop-confirmed"] === "true" ? { stop_confirmed: true } : {}) })));
      return 0;
    case "confirm":
      print(
        await withClient(profile, (c) =>
          c.request("respond_confirmation", {
            confirmation_id: positional[0] ?? "",
            decision: positional[1] ?? "",
          }),
        ),
      );
      return 0;
    case "read-artifact": {
      const output = flags["output"];
      if (output !== undefined) {
        if (!output || flags["offset"] !== undefined || flags["length"] !== undefined) {
          process.stderr.write("[ruukoto:cli] --output 需要文件路径，且不能与 --offset / --length 同用\n");
          return 1;
        }
        let artifact: Artifact;
        try {
          artifact = await withClient(profile, (c) => exportArtifact(c, positional[0] ?? "", positional[1] ?? "", output));
        } catch (error) {
          process.stderr.write(`[ruukoto:cli] 产物导出失败，目标文件未替换：${error instanceof Error ? error.message : String(error)}\n`);
          return 1;
        }
        process.stderr.write(`[ruukoto:cli] 已完整导出产物 ${artifact.id}（${artifact.byteCount} 字节）\n`);
        return 0;
      }
      const result = await withClient(profile, (c) =>
        c.request<OpResult<"read_artifact">>(
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
    case "web-search": {
      // 实例级 Web Search 开关（issue 20；拥有者入口，全实例共用）：<on|off>
      const state = positional[0] ?? "";
      if (state !== "on" && state !== "off") {
        console.error("用法：ruukoto web-search <on|off>");
        return 1;
      }
      print(await withClient(profile, (c) => c.request("set_web_search", { enabled: state === "on" })));
      return 0;
    }
    case "credentials": {
      const sub = positional[0];
      if (sub === "list") {
        print(await withClient(profile, (c) => c.request("list_credentials", {})));
        return 0;
      }
      if (sub === "add") {
        const secretEnv = flags["secret-env"];
        if (!secretEnv) throw new Error("credentials add 需要 --secret-env <环境变量名>（秘密值不进入命令行）");
        const secret = process.env[secretEnv];
        if (!secret) throw new Error(`环境变量 ${secretEnv} 为空`);
        print(
          await withClient(profile, (c) =>
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
        print(await withClient(profile, (c) => c.request("remove_credential", { name: positional[1] ?? "" })));
        return 0;
      }
      console.error("用法：ruukoto credentials list | add --name N --host H --header H --purpose P --secret-env VAR | remove <name>");
      return 1;
    }
    case "mcp": {
      if (rest.some(arg => arg === "--project" || arg.startsWith("--project="))) {
        process.stderr.write("[ruukoto:cli] MCP 已改为按实例配置，不接受 --project；请移除该参数。\n");
        return 1;
      }
      const sub = positional[0];
      if (sub === "cua") {
        return await runConfigTui({ profile });
      }
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
          await withClient(profile, (c) =>
            c.request("mcp_configure", {
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
        print(await withClient(profile, (c) => c.request("mcp_list", {})));
        return 0;
      }
      if (sub === "enable" || sub === "disable") {
        print(
          await withClient(profile, (c) =>
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
          await withClient(profile, (c) =>
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
          await withClient(profile, async (c) => {
            const list = (await c.request("mcp_list", {})) as any;
            const target = (list.services as any[]).find((s) => s.id === positional[1]);
            if (target) console.error(`连接检查：${target.name}（${target.cua?.kind ?? target.endpoint}）`);
            return c.request("mcp_check", { service_id: positional[1] ?? "" });
          }),
        );
        return 0;
      }
      console.error(
        "用法：\n" +
          "  ruukoto mcp configure --name <slug> --endpoint <url> [--credential <name>] [--tools a,b:write,c:unknown] [--disabled] [--expected-version N]\n" +
          "    （--tools 条目：name = 只读工具；name:write / name:unknown = 有副作用/副作用不明，confirm 模式逐次审批）\n" +
          "  ruukoto mcp list | enable <service-id> | disable <service-id> | remove <service-id> [--expected-version N]\n" +
          "  ruukoto mcp check <service-id>（连接检查 + 工具列表，标注允许/未允许与副作用类别）\n" +
          "  ruukoto mcp cua（打开配置界面，从 MCP 服务选择本机电脑与人工恢复）",
      );
      return 1;
    }
    case "stop":
      print(await withClient(profile, (c) => c.request("stop", {})));
      return 0;
    case "work": {
      // 工作委托与 SubAgent（agent-direction issue 11）：只读查询；委派经模型工具
      const sub = positional[0];
      if (sub === "list") {
        print(await withClient(profile, (c) => c.request("work_list", {
          session_id: flags["session"],
        })));
        return 0;
      }
      if (sub === "show" && positional[1]) {
        print(await withClient(profile, (c) => c.request("work_get", { work_id: positional[1] })));
        return 0;
      }
      // 显式关闭 SubAgent（issue 12）：有活动任务拒绝并提示先 cancel；已关闭幂等
      if (sub === "close" && positional[1]) {
        print(await withClient(profile, (c) => c.request("subagent_close", { sub_agent_id: positional[1] })));
        return 0;
      }
      // 整项取消工作（issue 14）：停止其活动与排队任务，其他工作不受影响；已取消幂等
      if (sub === "cancel" && positional[1]) {
        print(await withClient(profile, (c) => c.request("work_cancel", { work_id: positional[1], reason: flags["reason"] })));
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
    case "grant": {
      const sub = positional[0];
      if (sub === "create") {
        print(
          await withClient(profile, (c) =>
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
        print(await withClient(profile, (c) => c.request("revoke_data_grant", { grant_id: positional[1] ?? "" })));
        return 0;
      }
      if (sub === "list") {
        print(await withClient(profile, (c) => c.request("list_data_grants", { include_revoked: flags["all"] !== undefined })));
        return 0;
      }
      console.error("用法：ruukoto grant create --from <项目> --to <项目> --category <history|artifact|memory> [--purpose P]\n" +
        "      ruukoto grant list [--all] | ruukoto grant revoke <grant-id>");
      return 1;
    }
    case "history-search": {
      const cursorRaw = flags["cursor"];
      const cursor = cursorRaw ? JSON.parse(Buffer.from(cursorRaw, "base64").toString("utf8")) : undefined;
      const result = await withClient(profile, (c) =>
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
          await withClient(profile, (c) =>
            c.request("list_memories", {
              project_id: flags["project"],
              personal: flags["personal"] !== undefined,
            }),
          ),
        );
        return 0;
      }
      if (sub === "show") {
        print(await withClient(profile, (c) => c.request("get_memory", { memory_id: positional[1] ?? "" })));
        return 0;
      }
      if (sub === "save") {
        const contentFile = flags["content-file"];
        const content = contentFile
          ? fs.readFileSync(contentFile, "utf8")
          : positional.slice(1).join(" ");
        print(
          await withClient(profile, (c) =>
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
          await withClient(profile, (c) =>
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
          await withClient(profile, (c) =>
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
        await withClient(profile, (c) =>
          c.request("list_selection_records", {
            task_id: flags["task"],
            session_id: flags["session"],
            limit: flags["limit"] === undefined ? undefined : Number(flags["limit"]),
          }),
        ),
      );
      return 0;
    }
    default:
      console.error(defaultHelp());
      return 1;
  }
}

async function runWorkflowCli(positional: string[], flags: Record<string, string>, profile: ProfilePaths): Promise<number> {
  const bin = "ruukoto";
  const sub = positional[0] ?? "list", id = positional[1];
  const required = (key: string): string => {
    if (!flags[key]) throw new Error("缺少 --" + key + "；" + bin + " workflow help 查看用法");
    return flags[key];
  };
  const requestId = (): string => {
    const key = required("request-id");
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new Error("请求键须为 1–128 位字母、数字或 ._:-，原请求核实前不要换键");
    return key;
  };
  const slice = { offset: Number(flags["offset"] ?? 0), length: Number(flags["length"] ?? 16384) };
  const inputJson = (key: string, fallback?: unknown): unknown => {
    if (flags[key + "-file"] && flags[key + "-json"]) throw new Error("JSON 文件和正文二选一");
    if (flags[key + "-file"]) return readJsonFile(flags[key + "-file"]);
    if (!flags[key + "-json"]) {
      if (fallback !== undefined) return fallback;
      throw new Error("缺少 --" + key + "-json 或 --" + key + "-file");
    }
    try { return JSON.parse(flags[key + "-json"]); }
    catch { throw new Error("JSON 格式不正确，请核实参数原文"); }
  };
  let write = false, check = bin + " workflow list";
  try {
    if (sub === "definitions") { print(await withClient(profile, c => c.request("workflow_definitions", { offset: slice.offset, limit: Number(flags["limit"] ?? 50) }))); return 0; }
    if ((sub === "definition" || sub === "version") && id) {
      print(await withClient(profile, c => c.request("workflow_definition", { ...(sub === "definition" ? { name: id } : { definition_id: id }), ...slice, version_offset: Number(flags["version-offset"] ?? 0) }))); return 0;
    }
    if (sub === "list") { print(await withClient(profile, c => c.request("workflow_list", { session_id: flags["session"], offset: slice.offset, limit: Number(flags["limit"] ?? 50) }))); return 0; }
    if (sub === "show" && id) { print(await withClient(profile, c => c.request("workflow_get", { run_id: id, step_offset: Number(flags["step-offset"] ?? 0) }))); return 0; }
    if (sub === "logs" && id) { print(await withClient(profile, c => c.request("workflow_logs", { run_id: id, ...slice }))); return 0; }
    if ((sub === "step" || sub === "question") && id && positional[2]) {
      print(await withClient(profile, c => c.request(sub === "step" ? "workflow_step" : "workflow_question", { run_id: id, step_key: positional[2], ...slice }))); return 0;
    }
    if (sub === "saved") { print(await withClient(profile, c => c.request("workflow_saved", { request_id: requestId() }))); return 0; }
    if (sub === "find") { print(await withClient(profile, c => c.request("workflow_find", { session_id: required("session"), request_id: requestId() }))); return 0; }
    if (sub === "save" && id) {
      const file = required("script-file");
      const script = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(file));
      const key = requestId(), expected = flags["expected-digest"] ?? null;
      check = bin + " workflow saved --request-id " + key; write = true;
      print(await withClient(profile, c => c.request("workflow_save", { name: id, script, expected_digest: expected, request_id: key }))); return 0;
    }
    if (sub === "run" && (id || flags["script-file"])) {
      const key = requestId(), session = required("session"), input = inputJson("input", {});
      const script = flags["script-file"] ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(flags["script-file"])) : undefined;
      if (id && script !== undefined) throw new Error("名称和 --script-file 二选一");
      const title = script === undefined ? flags["title"] : required("title");
      check = bin + " workflow find --session " + session + " --request-id " + key; write = true;
      print(await withClient(profile, c => c.request("workflow_start", { session_id: session, request_id: key, name: id, script, title, description: flags["description"], input,
        max_attempts: flags["max-attempts"] === undefined ? undefined : Number(flags["max-attempts"]),
        duration_ms: flags["duration-ms"] === undefined ? undefined : Number(flags["duration-ms"]) }))); return 0;
    }
    if (sub === "answer" && id && positional[2]) {
      const key = requestId(), answer = inputJson("answer"), version = Number(required("question-version")), runVersion = Number(required("run-version"));
      check = bin + " workflow question " + id + " " + positional[2]; write = true;
      print(await withClient(profile, c => c.request("workflow_answer", { run_id: id, step_key: positional[2], question_version: version, run_version: runVersion, request_id: key, answer }))); return 0;
    }
    if (["pause", "resume", "cancel", "budget"].includes(sub) && id) {
      const key = requestId(), version = Number(required("expected-version"));
      let control: WorkflowControl;
      if (sub === "budget") control = { action: "budget", maxAttempts: Number(required("max-attempts")), durationMs: Number(required("duration-ms")) };
      else if (sub === "resume") {
        const bool = (key: string): boolean | undefined => {
          if (flags[key] === undefined) return undefined;
          if (!["true", "false"].includes(flags[key])) throw new Error("--" + key + " 必须是 true 或 false");
          return flags[key] === "true";
        };
        control = { action: "resume", clockConfirmed: bool("clock-confirmed"), stopsConfirmed: bool("stops-confirmed") };
      } else control = { action: sub === "pause" ? "pause" : "cancel" };
      control = parseWorkflowControl(control);
      check = bin + " workflow show " + id; write = true;
      print(await withClient(profile, c => c.request("workflow_control", { run_id: id, expected_version: version, request_id: key, control }))); return 0;
    }
    console.log([
      bin + " workflow definitions | definition <名称> [--version-offset N] | version <版本ID> [--offset N --length N]",
      bin + " workflow save <名称> --script-file F --request-id K [--expected-digest 当前摘要]",
      bin + " workflow run <名称> --session S --request-id K [--description 简短说明] [--input-json JSON | --input-file F]",
      bin + " workflow run --script-file F --title 名称 --session S --request-id K [--description 简短说明] [--input-json JSON]",
      bin + " workflow saved --request-id K | find --session S --request-id K",
      bin + " workflow list [--session S --offset N --limit N] | show <运行ID> [--step-offset N]",
      bin + " workflow logs <运行ID> | step <运行ID> <步骤键> | question <运行ID> <步骤键> [--offset N --length N]",
      bin + " workflow answer <运行ID> <步骤键> --run-version N --question-version N --request-id K --answer-json JSON",
      bin + " workflow pause|resume|cancel|budget <运行ID> --expected-version N --request-id K",
      "resume 可加 --clock-confirmed true --stops-confirmed true；budget 须加 --max-attempts N --duration-ms N",
      "写入应答丢失后用原键 find/saved 或 show 核实，不自动换键重发；业务回答不批准工具。",
    ].join("\n"));
    return sub === "help" ? 0 : 1;
  } catch (error) {
    const message = String((error as Error).message);
    process.stderr.write("[ruukoto:cli] " + (write && !["not_sent", "rejected"].includes(requestOutcome(error)) ? "工作流操作结果未知：" + message + "；先用 " + check + " 核实（未自动重发）" : message) + "\n");
    return 1;
  }
}

function defaultHelp(): string {
  return [
    "用法：ruukoto [路径] | --session <id> | --demo",
    "      ruukoto -- <路径>（显式工作区入口）",
    "      ruukoto config [--offline] | server [--execution native]",
    "目录选择：--data-dir D --agent-dir A --control-dir C --pending-dir P（所有入口；覆盖对应 RUUKOTO_*_DIR）",
    "管理命令：models | set-model | set-session-mode | submit | switch-mode | status | events | interrupt | cancel | resume-queue | confirm | read-artifact | credentials | mcp | stop | web-search",
    "          project set-instructions | grant | work | workflow | history-search | memory | selection-records",
    "实例使用独立的新格式目录；首次配置：ruukoto config --offline。",
  ].join("\n");
}
