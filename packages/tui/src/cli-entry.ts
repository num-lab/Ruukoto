/** Pure entry parsing; directory flags are removed before command dispatch. */

import { parseArgs } from "node:util";
import type { ProfileDirectoryOptions } from "@ruukoto/core/profile.ts";

export function parseDirectoryFlags(argv: string[]): { argv: string[]; directories: ProfileDirectoryOptions; error?: string } {
  const directories: ProfileDirectoryOptions = {};
  const rest: string[] = [];
  const keys = { "data-dir": "dataDir", "agent-dir": "agentDir", "control-dir": "controlDir", "pending-dir": "pendingDir" } as const;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") { rest.push(...argv.slice(i)); break; }
    const match = /^--(data-dir|agent-dir|control-dir|pending-dir)(?:=(.*))?$/.exec(arg);
    if (!match) { rest.push(arg); continue; }
    const value = match[2] ?? argv[++i];
    if (!value || value.startsWith("--")) return { argv: rest, directories, error: `${match[1]} 需要目录路径` };
    directories[keys[match[1] as keyof typeof keys]] = value;
  }
  return { argv: rest, directories };
}

export type CliEntry =
  | { kind: "tui"; sessionId?: string; demo?: boolean }
  | { kind: "workspace"; path: string }
  | { kind: "config"; offline: boolean }
  | { kind: "server"; argv: string[] }
  | { kind: "command"; command: string; argv: string[] }
  | { kind: "help"; error?: string };

const MANAGEMENT_COMMANDS = new Set([
  "project",
  "models",
  "set-model",
  "submit",
  "switch-mode",
  "set-session-mode",
  "status",
  "events",
  "interrupt",
  "cancel",
  "resume-queue",
  "confirm",
  "read-artifact",
  "credentials",
  "mcp",
  "stop",
  "grant",
  "work",
  "workflow",
  "history-search",
  "memory",
  "web-search",
  "selection-records",
]);

function flagError(err: unknown): CliEntry {
  return { kind: "help", error: `参数错误：${(err as Error).message}` };
}

/** 默认任务界面入口的标志解析：--session <id> / --demo，严格模式。 */
function tuiEntry(argv: string[]): CliEntry {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        session: { type: "string" },
        demo: { type: "boolean" },
      },
      allowPositionals: true,
      strict: true,
    });
    if (positionals.length > 0) {
      return { kind: "help", error: `--session/--demo 不能与路径同用：${positionals.join(" ")}` };
    }
    return { kind: "tui", sessionId: values.session, demo: values.demo };
  } catch (err) {
    return flagError(err);
  }
}

/** 配置中心入口的标志解析：--offline，严格模式。 */
function configEntry(rest: string[]): CliEntry {
  try {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { offline: { type: "boolean" } },
      allowPositionals: true,
      strict: true,
    });
    if (positionals.length > 0) {
      return { kind: "help", error: `config 不接受位置参数：${positionals.join(" ")}` };
    }
    return { kind: "config", offline: values.offline ?? false };
  } catch (err) {
    return flagError(err);
  }
}

export function resolveEntry(argv: string[]): CliEntry {
  const [first, ...rest] = argv;
  if (first === "--help" || first === "-h" || first === "help") return { kind: "help" };

  // 无参：默认任务界面（沿用既有默认会话选择）
  if (first === undefined) return { kind: "tui" };

  // `-- <路径>`：显式工作区入口
  if (first === "--") {
    if (rest.length === 0) return { kind: "help", error: "`--` 后需跟一个工作区路径" };
    if (rest.length > 1) return { kind: "help", error: `工作区入口只接受一个路径：${rest.join(" ")}` };
    return { kind: "workspace", path: rest[0]! };
  }

  // 首参为标志：默认任务界面入口
  if (first.startsWith("--")) return tuiEntry(argv);

  // 命令名优先于路径
  if (first === "server") return { kind: "server", argv: rest };
  if (first === "config") return configEntry(rest);
  if (MANAGEMENT_COMMANDS.has(first)) return { kind: "command", command: first, argv: rest };

  // 其余首参一律视为工作区路径（存在性由 TUI 侧校验）
  if (rest.some((a) => a.startsWith("--"))) {
    return { kind: "help", error: `--session/--demo 不能与路径同用：${argv.join(" ")}` };
  }
  if (rest.length > 0) {
    return { kind: "help", error: `工作区入口只接受一个路径：${argv.join(" ")}` };
  }
  return { kind: "workspace", path: first };
}
