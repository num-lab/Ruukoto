/**
 * TUI 入口：只连接已运行的后台，不创建 SDK 会话、不加载模型凭据、不直接
 * 打开后台数据库或 JSONL。
 *
 * - 非 TTY 环境不启动交互页面，提示使用已有 CLI 命令；
 * - 仅连接本机 Unix socket；远程使用沿用登录服务器后启动 TUI 的方式；
 * - 正常退出、SIGTERM、SIGHUP 与可处理的异常都关闭 socket、停止 TUI 并
 *   恢复终端（raw mode、光标、屏幕），不发送 stop 或取消任务；
 * - 进程被强杀（SIGKILL）时无法执行清理回调：终端可能停留在 alt screen
 *   或 raw mode，可用 `reset` 或 `stty sane` 恢复（见 docs/runtime.md）。
 */

import { initTheme } from "@earendil-works/pi-coding-agent";
import { resolveClientConfig } from "../control/connect.ts";
import { createDemoClient } from "./demo-session.ts";
import { ControlConnection } from "../control/connection.ts";
import { PendingRequestStore } from "../control/pending-requests.ts";
import { SubmissionGuard } from "../control/submission.ts";
import { reloadStatePathFromEnv } from "./reload-state.ts";
import { ViewState } from "./state.ts";
import { TuiApp } from "./app.ts";

export interface TuiOptions {
  sessionId?: string;
  /** 合成调试会话：不连后台，用假客户端喂出覆盖全部事件类型的静态数据。 */
  demo?: boolean;
  /** 工作区入口（issue 21）：以该目录为工作区创建/复用项目并新建会话进入。 */
  workspace?: { path: string };
}

export async function runTui(opts: TuiOptions = {}): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      "TUI 需要交互式终端（TTY）。非 TTY 环境请使用 CLI 命令：\n" +
        "  ruukoto status / events / submit / interrupt / confirm …（见 ruukoto 无参数帮助）",
    );
    return 1;
  }

  // 合成调试会话不读配置、不需要令牌（也不产生任何真实副作用）
  let config: { socketPath: string; token: string } | null = null;
  if (!opts.demo) {
    try {
      config = resolveClientConfig();
    } catch (err) {
      console.error((err as Error).message);
      return 1;
    }
  }

  // 代码块语法高亮的主题：只用包内自带的 dark 主题（不读 ~/.pi，不写文件）
  initTheme("dark");

  const state = new ViewState();
  let app: TuiApp | null = null;
  const connection = new ControlConnection(
    opts.demo
      ? { socketPath: "(demo)", token: "(demo)", clientFactory: async () => createDemoClient((text) => app?.log(text)) }
      : { socketPath: config!.socketPath, token: config!.token },
    {
      onState: (s, detail) => app?.onConnectionState(s, detail),
      onSnapshot: (result, ctx) => app?.onSnapshot(result, ctx),
      onEvent: (event, kind) => app?.onEvent(event, kind),
    },
  );
  const pendingStore = new PendingRequestStore();
  const guard = new SubmissionGuard(pendingStore, connection);

  let exitResolve: ((code: number) => void) | null = null;
  const exitPromise = new Promise<number>((resolve) => {
    exitResolve = resolve;
  });

  app = new TuiApp({
    connection,
    guard,
    pendingStore,
    state,
    initialSessionId: opts.sessionId,
    // 合成调试会话不支持创建操作，工作区入口只在真实连接下启用
    workspace: opts.demo ? undefined : opts.workspace,
    // dev 重载状态（issue 21 §5）：仅 dev 注入 RUUKOTO_RELOAD_STATE_FILE 时启用
    reloadStateFile: opts.demo ? undefined : (reloadStatePathFromEnv() ?? undefined),
    onExit: (code, message) => {
      restoreConsole();
      if (message) console.log(message);
      exitResolve?.(code);
    },
  });

  // TUI 运行期间：日志与错误不得混入正在绘制的页面，转为界面内提示
  const originalConsole = { log: console.log, error: console.error, warn: console.warn };
  const routeIntoView = (...args: unknown[]) => {
    app?.log(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  console.log = routeIntoView;
  console.error = routeIntoView;
  console.warn = routeIntoView;
  function restoreConsole(): void {
    console.log = originalConsole.log;
    console.error = originalConsole.error;
    console.warn = originalConsole.warn;
  }

  const onSignal = () => app?.quit(0);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  process.on("SIGINT", onSignal);
  const onUncaught = (err: Error) => {
    // 可处理的异常：恢复终端后退出，不留 raw mode
    restoreConsole();
    try {
      connection.close();
    } catch {
      // 忽略
    }
    console.error(`TUI 异常退出：${err.stack ?? err.message}`);
    console.error("如终端显示异常，可执行 reset 或 stty sane 恢复。");
    process.exit(1);
  };
  process.on("uncaughtException", onUncaught);

  await app.start();
  const code = await exitPromise;
  process.removeListener("SIGTERM", onSignal);
  process.removeListener("SIGHUP", onSignal);
  process.removeListener("SIGINT", onSignal);
  process.removeListener("uncaughtException", onUncaught);
  return code;
}
