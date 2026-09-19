/**
 * 最小 CLI：本机启动、连接与停止入口。
 *
 *   ruukoto start [--data-dir D] [--agent-dir A]     前台启动后台进程
 *   ruukoto create-project <name>
 *   ruukoto create-session <project> <cwd> [--confirm-tools a,b]
 *   ruukoto submit <session> <request-id> <input...>
 *   ruukoto continue <task> <request-id> <input...>
 *   ruukoto status [task]                             任务/快照查询
 *   ruukoto events                                    订阅并打印事件流
 *   ruukoto interrupt <task> | cancel <task> | resume-queue <session>
 *   ruukoto confirm <confirmation-id> approve|reject
 *   ruukoto stop
 *
 * 数据目录默认 ~/.ruukoto（RUUKOTO_DATA_DIR 可覆盖），socket 位于其下。
 */

import * as path from "node:path";
import * as os from "node:os";
import { ControlClient } from "./control/client.ts";

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
    dataDir: process.env.RUUKOTO_DATA_DIR ?? path.join(base, "data"),
    agentDir: process.env.RUUKOTO_AGENT_DIR ?? path.join(base, "agent"),
  };
}

async function withClient<T>(fn: (client: ControlClient) => Promise<T>): Promise<T> {
  const { dataDir } = defaultDirs();
  const socketPath = path.join(dataDir, "control.sock");
  const client = await ControlClient.connect(socketPath);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
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
      const runtime = await Runtime.start({
        dataDir,
        agentDir,
        thinkingLevel: "off",
        modelProvider,
        modelId,
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
      const { dataDir } = defaultDirs();
      const client = await ControlClient.connect(path.join(dataDir, "control.sock"));
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
    case "stop":
      print(await withClient((c) => c.request("stop", {})));
      return 0;
    default:
      console.error(defaultHelp());
      return cmd === undefined ? 0 : 1;
  }
}

function defaultHelp(): string {
  return (
    "用法：ruukoto <command> [args]\n" +
    "命令：start | create-project | create-session | submit | continue | status | events | interrupt | cancel | resume-queue | confirm | stop\n" +
    "参数：--data-dir / --agent-dir（start）；--confirm-tools（create-session）"
  );
}

process.exitCode = await main(process.argv.slice(2));
