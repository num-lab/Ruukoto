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
import type { GrantedPath } from "./core/types.ts";

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
      const [modelProvider, modelId] = modelFlag.includes("/") ? modelFlag.split("/", 2) : [undefined, undefined];
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
        thinkingLevel: "off",
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
    case "submit":
      print(
        await withClient((c) =>
          c.request("submit", {
            session_id: positional[0] ?? "",
            request_id: positional[1] ?? "",
            input: positional.slice(2).join(" "),
            access_mode: parseMode(flags["mode"]),
            granted_paths: parseGrants(flags["grant"]),
          }),
        ),
      );
      return 0;
    case "continue":
      print(
        await withClient((c) =>
          c.request("continue", {
            task_id: positional[0] ?? "",
            request_id: positional[1] ?? "",
            input: positional.slice(2).join(" "),
            access_mode: parseMode(flags["mode"]),
            granted_paths: parseGrants(flags["grant"]),
          }),
        ),
      );
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
      print(await withClient((c) => c.request("resume_queue", { session_id: positional[0] ?? "" })));
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
    case "stop":
      print(await withClient((c) => c.request("stop", {})));
      return 0;
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
    "命令：start | tui | create-project | create-session | submit | continue | switch-mode | status | events |\n" +
    "      interrupt | cancel | resume-queue | confirm | read-artifact | credentials | stop\n" +
    "参数：--data-dir / --agent-dir / --execution（start）；--mode / --grant（submit/continue/switch-mode）；\n" +
    "      --session <id>（tui：直接进入指定会话，不存在则报错）\n" +
    "认证：RUUKOTO_OWNER_TOKEN、RUUKOTO_OWNER_TOKEN_FILE 或 <数据目录>/../control/owner.token"
  );
}

process.exitCode = await main(process.argv.slice(2));
