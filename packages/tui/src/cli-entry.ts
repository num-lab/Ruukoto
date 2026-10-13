/**
 * CLI 顶层分发决策（issue 21）：纯函数、无副作用、不碰文件系统，供 cli.ts
 * 消费与单元测试。
 *
 * 优先级：命令名 > 路径。首参为已知命令（含兼容别名 start、旧拼法 tui）
 * 按命令分发；首参为 `--` 标志按默认任务界面入口严格解析（布尔不吞下一
 * token）；其余首参一律视为工作区路径（存在性由 TUI 侧校验）。`-- <路径>`
 * 为显式工作区入口，用于打开与命令同名的目录（如 config；./config 亦可）。
 */

import { parseArgs } from "node:util";

export type CliEntry =
  | { kind: "tui"; sessionId?: string; demo?: boolean }
  | { kind: "workspace"; path: string }
  | { kind: "config"; offline: boolean }
  | { kind: "server"; argv: string[] }
  | { kind: "legacy"; command: string; argv: string[] }
  | { kind: "help"; error?: string };

/** 管理命令与旧拼法 tui：保持既有手卷解析与输出，供脚本与非 TTY 使用。 */
const LEGACY_COMMANDS = new Set([
  "create-project",
  "project",
  "create-session",
  "models",
  "set-model",
  "submit",
  "continue",
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
  "github",
  "mcp",
  "stop",
  "qq",
  "telegram",
  "schedule",
  "notify",
  "grant",
  "service-grant",
  "work",
  "history-search",
  "memory",
  "selection-records",
  "legacy-import",
  "tui",
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
  if (first === "server" || first === "start") return { kind: "server", argv: rest };
  if (first === "config") return configEntry(rest);
  if (LEGACY_COMMANDS.has(first)) return { kind: "legacy", command: first, argv: rest };

  // 其余首参一律视为工作区路径（存在性由 TUI 侧校验）
  if (rest.some((a) => a.startsWith("--"))) {
    return { kind: "help", error: `--session/--demo 不能与路径同用：${argv.join(" ")}` };
  }
  if (rest.length > 0) {
    return { kind: "help", error: `工作区入口只接受一个路径：${argv.join(" ")}` };
  }
  return { kind: "workspace", path: first };
}
