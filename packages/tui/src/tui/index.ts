/** Local task UI; closing the client never cancels backend work. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { resolveClientConfig } from "@ruukoto/control/connect.ts";
import { ensureBackend } from "@ruukoto/control/ensure-backend.ts";
import type { ProfilePaths } from "@ruukoto/core/profile.ts";
import { createDemoClient } from "./demo-session.ts";
import { ControlConnection } from "@ruukoto/control/connection.ts";
import { PendingRequestStore } from "@ruukoto/control/pending-requests.ts";
import { SubmissionGuard } from "@ruukoto/control/submission.ts";
import { RELOAD_STATE_ENV } from "./reload-state.ts";
import { ViewState } from "./state.ts";
import { TuiApp } from "./app.ts";
import { CommandHistoryStore } from "./command-history.ts";

export type TuiOptions = ({ demo: true; profile?: never } | { demo?: false; profile: ProfilePaths }) & {
  sessionId?: string;
  /** 工作区入口（issue 21）：以该目录为工作区创建/复用项目并新建会话进入。 */
  workspace?: { path: string };
}

export async function runTui(opts: TuiOptions): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      "TUI 需要交互式终端（TTY）。非 TTY 环境请使用 CLI 命令：\n" +
        "  ruukoto status / events / submit / interrupt / confirm …（见 ruukoto 无参数帮助）",
    );
    return 1;
  }

  // 合成调试会话不读配置、不需要令牌（也不产生任何真实副作用）
  let config: { token: string } | null = null;
  if (!opts.demo) {
    if (process.env[RELOAD_STATE_ENV] !== "1") {
      const ensured = await ensureBackend({ profile: opts.profile });
      if (!ensured.ok) {
        console.error(ensured.error);
        return 1;
      }
      if (ensured.spawned) console.error("已按需拉起 ruukoto 后台（关闭 TUI 不停止后台；显式停止：ruukoto stop）");
    }
    try {
      config = resolveClientConfig(opts.profile);
    } catch (err) {
      console.error((err as Error).message);
      return 1;
    }
  }

  // 代码块语法高亮的主题：只用包内自带的 dark 主题（不读 ~/.pi，不写文件）
  initTheme("dark");

  const state = new ViewState(opts.demo ? undefined : new CommandHistoryStore(opts.profile.commandHistoryPath));
  let app: TuiApp | null = null;
  const connection = new ControlConnection(
    opts.demo
      ? { token: "(demo)", clientFactory: async () => createDemoClient((text) => app?.log(text)) }
      : { profile: opts.profile, token: config!.token },
    {
      onState: (s, detail) => app?.onConnectionState(s, detail),
      onSnapshot: (result, ctx) => app?.onSnapshot(result, ctx),
      onEvent: (event, kind) => app?.onEvent(event, kind),
    },
  );
  const pendingStore = new PendingRequestStore(opts.demo ? fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-demo-pending-")) : opts.profile.tuiPendingDir);
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
    reloadStateFile: !opts.demo && process.env[RELOAD_STATE_ENV] === "1" ? opts.profile.reloadStatePath : undefined,
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
