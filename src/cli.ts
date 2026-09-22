/**
 * 最小 CLI：本机启动、连接与停止入口（拥有者可信入口）。
 *
 *   ruukoto start [--data-dir D] [--agent-dir A] [--execution local|container]
 *   ruukoto create-project <name>
 *   ruukoto create-session <project> <cwd> [--confirm-tools a,b]
 *   ruukoto submit <session> <request-id> [--mode confirm|full_access]
 *                  [--grant <path>:<read|read_write>[:<用途>];...] <input...>
 *   ruukoto continue <task> <request-id> [--mode ...] [--grant ...] <input...>
 *   ruukoto switch-mode <task> <confirm|full_access> [--grant ...]
 *   ruukoto status [task]                             任务/快照查询
 *   ruukoto events                                    订阅并打印事件流
 *   ruukoto interrupt <task> | cancel <task> | resume-queue <session>
 *   ruukoto confirm <confirmation-id> approve|reject
 *   ruukoto read-artifact <task> <artifact> [--offset N] [--length N]
 *   ruukoto credentials list
 *   ruukoto credentials add --name N --host H --header H --purpose P --secret-env VAR
 *   ruukoto credentials remove <name>
 *   ruukoto stop
 *
 * 数据目录默认 ~/.ruukoto；控制面目录为其兄弟目录 control/（socket 与拥有者
 * 令牌）。除 start 外的命令都需要拥有者令牌：取 RUUKOTO_OWNER_TOKEN 或受控
 * 目录的 owner.token（0600，部署时以 0400 复制给拥有者）。
 */

import * as path from "node:path";
import * as os from "node:os";
import { ControlClient } from "./control/client.ts";
import { controlDirFor, defaultDataDir, resolveClientConfig, resolveOwnerToken } from "./control/connect.ts";
import type { GrantedPath, ModelSelection, Session, Task } from "./core/types.ts";

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
  const base = path.join(os.homedir(), ".ruukoto");
  return {
    dataDir: defaultDataDir(),
    agentDir: process.env.RUUKOTO_AGENT_DIR ?? path.join(base, "agent"),
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

function parseMode(raw: string | undefined): "confirm" | "full_access" | undefined {
  if (!raw) return undefined;
  if (raw === "confirm" || raw === "full_access") return raw;
  throw new Error(`--mode 无效：${raw}（confirm | full_access）`);
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const { flags, positional } = parseArgs(rest);
  switch (cmd) {
    case "start": {
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
      const execFlag = flags["execution"] ?? process.env.RUUKOTO_EXECUTION_BACKEND ?? "local";
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
      const runtime = await Runtime.start({
        dataDir,
        agentDir,
        thinkingLevel: (flags["thinking"] ?? "off") as ModelSelection["thinkingLevel"],
        modelProvider,
        modelId,
        execution: { backend: execFlag },
        toolFactory,
      });
      await ControlServer.start(runtime);
      const stopAndExit = (reason: string) => {
        void runtime.stop(reason).then(() => process.exit(0));
      };
      process.on("SIGINT", () => stopAndExit("signal_sigint"));
      process.on("SIGTERM", () => stopAndExit("signal_sigterm"));
      console.error(`ruukoto 后台已启动 dataDir=${dataDir} socket=${runtime.socketPath()} (pid ${process.pid})`);
      return 0;
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
      console.error("用法：ruukoto project set-instructions <项目id> <工作区相对路径...>（空列表 = 清除）");
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
          console.error(`提交失败或接收结果未确认；请用原 request-id ${requestId} 核实，勿换键重试`);
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
      const sub = positional[0];
      if (sub === "bind") {
        print(
          await withClient((c) =>
            c.request("github_bind", {
              project_id: flags["project"] ?? "",
              owner: flags["owner"] ?? "",
              repo: flags["repo"] ?? "",
              api_host: flags["api-host"],
              scheme: flags["scheme"] === "http" ? "http" : undefined,
              read_credential: flags["read-credential"],
              publish_credential: flags["publish-credential"],
              read_scopes: (flags["scopes"] ?? "pulls,actions,checks").split(",").map((s) => s.trim()).filter(Boolean),
              allow_fork_content: flags["allow-fork-content"] !== undefined,
            }),
          ),
        );
        return 0;
      }
      if (sub === "bindings") {
        print(await withClient((c) => c.request("github_list_bindings", { project_id: flags["project"] })));
        return 0;
      }
      if (sub === "unbind") {
        print(await withClient((c) => c.request("github_unbind", { binding_id: positional[1] ?? "" })));
        return 0;
      }
      if (sub === "drafts") {
        print(
          await withClient((c) =>
            c.request("github_list_drafts", { project_id: flags["project"], task_id: flags["task"], status: flags["status"] }),
          ),
        );
        return 0;
      }
      if (sub === "draft") {
        print(
          await withClient((c) =>
            c.request("github_get_draft", {
              draft_id: positional[1] ?? "",
              version: flags["version"] === undefined ? undefined : Number(flags["version"]),
            }),
          ),
        );
        return 0;
      }
      if (sub === "publish-ops") {
        print(await withClient((c) => c.request("github_list_publish_ops", { draft_id: flags["draft"] })));
        return 0;
      }
      if (sub === "publish") {
        const kind = flags["kind"] ?? "";
        const target: Record<string, unknown> = {};
        const numFlag = kind === "pr_review_comment" ? flags["pr"] : kind === "issue_comment" ? flags["issue"] : undefined;
        if (kind !== "pr_review_comment" && kind !== "issue_comment") throw new Error("publish 需要 --kind pr_review_comment|issue_comment");
        const num = Number(numFlag);
        if (numFlag === undefined || !Number.isInteger(num) || num < 1) {
          throw new Error(`publish 需要 ${kind === "pr_review_comment" ? "--pr" : "--issue"} <正整数>`);
        }
        if (kind === "pr_review_comment") target.prNumber = num;
        else target.issueNumber = num;
        print(
          await withClient((c) =>
            c.request("github_publish", {
              draft_id: positional[1] ?? "",
              version: flags["version"] === undefined ? undefined : Number(flags["version"]),
              kind,
              target,
              access_mode: flags["access-mode"],
            }),
          ),
        );
        return 0;
      }
      console.error(
        "用法：\n" +
          "  ruukoto github bind --project <id> --owner O --repo R [--api-host H] [--read-credential N] [--publish-credential N] [--scopes pulls,actions,checks] [--allow-fork-content]\n" +
          "  ruukoto github bindings [--project <id>] | unbind <binding-id>\n" +
          "  ruukoto github drafts [--project <id>] [--task <id>] [--status draft|stale|published]\n" +
          "  ruukoto github draft <draft-id> [--version N] | publish-ops [--draft <id>]\n" +
          "  ruukoto github publish <draft-id> --kind pr_review_comment --pr <n> | --kind issue_comment --issue <n> [--version N] [--access-mode confirm|full_access]",
      );
      return 1;
    }
    case "stop":
      print(await withClient((c) => c.request("stop", {})));
      return 0;
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
      // TUI 入口：只连接已运行的后台，不创建 SDK 会话、不加载模型凭据
      const { runTui } = await import("./tui/index.ts");
      return await runTui({ sessionId: flags["session"] });
    }
    default:
      console.error(defaultHelp());
      return cmd === undefined ? 0 : 1;
  }
}

function defaultHelp(): string {
  return (
    "用法：ruukoto <command> [args]\n" +
    "命令：models | set-model <session> <provider/model> --thinking <level> | start | tui | create-project | create-session | submit | continue | switch-mode | status | events |\n" +
    "      interrupt | cancel | resume-queue | confirm | read-artifact | credentials | stop |\n" +
    "      grant | history-search | memory | selection-records\n" +
    "参数：--data-dir / --agent-dir / --execution / --model / --thinking（start）；--mode / --grant（submit/continue/switch-mode）；\n" +
    "      --session <id>（tui：直接进入指定会话，不存在则报错）\n" +
    "认证：RUUKOTO_OWNER_TOKEN、RUUKOTO_OWNER_TOKEN_FILE 或 <数据目录>/../control/owner.token"
  );
}

process.exitCode = await main(process.argv.slice(2));
