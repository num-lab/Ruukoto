import { execFileSync } from "node:child_process";
import { verifyDirIdentitySync, type DirIdentity } from "@ruukoto/core/dir-identity.ts";
import type { IPty, IPtyForkOptions } from "node-pty";
import type { DesktopTerminalId, DesktopTerminalUpdate } from "../shared/bridge.ts";
import { DesktopError } from "./environment.ts";

export type TerminalPty = Pick<IPty, "pid" | "write" | "resize" | "pause" | "resume" | "onData" | "onExit">;
export type PtyFactory = (shell: string, args: string[], options: IPtyForkOptions) => TerminalPty;
interface TerminalEntry { pty: TerminalPty; pending: Buffer; timer?: ReturnType<typeof setTimeout>; flushing: boolean; exited: boolean; stopping?: Promise<void>; exit?: { exitCode: number; signal?: number } }

function dimensions(cols: unknown, rows: unknown): asserts cols is number {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || Number(cols) < 2 || Number(cols) > 500 || Number(rows) < 1 || Number(rows) > 300) throw new DesktopError("invalid_params", "终端尺寸无效，请重新打开终端。");
}
function processTable() {
  let output: string;
  try { output = execFileSync("/bin/ps", ["-eo", "pid=,ppid=,pgid=,stat="], { encoding: "utf8", timeout: 1000, maxBuffer: 4 * 1024 * 1024 }); }
  catch { throw new DesktopError("terminal_stop_failed", "无法核实终端进程，请在系统活动监视器中检查后重新打开应用。"); }
  return output.trim().split("\n").map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) throw new DesktopError("terminal_stop_failed", "无法核实终端进程，请在系统活动监视器中检查后重新打开应用。");
    return { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), state: match[4] };
  });
}
function signalGroups(groups: Set<number>, signal: NodeJS.Signals): void {
  for (const group of groups) {
    try { process.kill(-group, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new DesktopError("terminal_stop_failed", "终端进程回收失败，请在系统活动监视器中检查仍运行的命令。"); }
  }
}

// Note: 见 .agents/notes/implemented/feature/2026-10-20-desktop-integrated-terminal.md
export class TerminalManager {
  private readonly entries = new Map<DesktopTerminalId, TerminalEntry>();
  private closed = false;
  constructor(private readonly factory: PtyFactory, private readonly publish: (update: DesktopTerminalUpdate) => void | Promise<void>, private readonly stopProcess = async (pid: number) => {
    // shortcut: 仅追踪停止时仍在树内的后代，需覆盖主动脱离进程时改用OS监督器。
    const table = processTable(), root = table.find(row => row.pid === pid);
    if (!root) return;
    if (root.group !== pid) throw new DesktopError("terminal_stop_failed", "终端进程组无法核实，请在系统活动监视器中检查仍运行的命令。");
    const members = new Set([pid]);
    let previous = 0;
    while (previous !== members.size) { previous = members.size; for (const row of table) if (members.has(row.parent)) members.add(row.pid); }
    const groups = new Set(table.filter(row => members.has(row.pid)).map(row => row.group));
    if (groups.has(table.find(row => row.pid === process.pid)?.group ?? process.pid)) throw new DesktopError("terminal_stop_failed", "终端进程组与应用重叠，请在系统活动监视器中检查仍运行的命令。");
    signalGroups(groups, "SIGTERM");
    // shell 退出不代表前台作业已退出，保留已核实进程组的升级回收。
    await new Promise(resolve => setTimeout(resolve, 500));
    signalGroups(groups, "SIGKILL");
    await new Promise(resolve => setTimeout(resolve, 100));
    if (processTable().some(row => groups.has(row.group) && !row.state.startsWith("Z"))) throw new DesktopError("terminal_stop_failed", "终端仍有进程运行，请在系统活动监视器中检查后重新打开应用。");
  }) {}

  open(id: unknown, root: DirIdentity, cols: unknown, rows: unknown, env: NodeJS.ProcessEnv): { id: DesktopTerminalId; cwd: string } {
    if (this.closed) throw new DesktopError("terminal_closed", "终端宿主已关闭，请重新打开应用。");
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) throw new DesktopError("invalid_params", "终端引用无效，请重新打开终端。");
    if (this.entries.has(id)) throw new DesktopError("terminal_exists", "终端已打开，请切换到原标签。");
    if (this.entries.size >= 8) throw new DesktopError("terminal_limit", "最多同时打开 8 个终端，请先关闭一个标签。");
    dimensions(cols, rows);
    let cwd: string;
    try { cwd = verifyDirIdentitySync(root).cwdReal; }
    catch { throw new DesktopError("terminal_workspace_changed", "工作区目录已失效或被替换，请重新添加工作区后再打开终端。"); }
    let pty: TerminalPty;
    try { pty = this.factory(env.SHELL || "/bin/zsh", ["-l"], { cwd, cols, rows: Number(rows), env: { ...env, TERM: "xterm-256color" }, name: "xterm-256color" }); }
    catch { throw new DesktopError("terminal_open_failed", "终端启动失败，请检查默认 shell 或重新构建桌面应用。"); }
    const entry: TerminalEntry = { pty, pending: Buffer.alloc(0), flushing: false, exited: false };
    this.entries.set(id, entry);
    pty.onData(data => {
      entry.pending = Buffer.concat([entry.pending, Buffer.from(data)]);
      if (entry.pending.length >= 64 * 1024) pty.pause();
      if (!entry.timer && !entry.flushing) entry.timer = setTimeout(() => { entry.timer = undefined; void this.flush(id, entry); }, 16);
    });
    pty.onExit(exit => { entry.exited = true; entry.exit = exit; if (entry.timer) clearTimeout(entry.timer); entry.timer = undefined; void this.flush(id, entry); });
    return { id, cwd };
  }
  private async flush(id: DesktopTerminalId, entry: TerminalEntry): Promise<void> {
    if (entry.flushing) return;
    entry.flushing = true;
    try {
      while (entry.pending.length) {
        const data = entry.pending.subarray(0, 64 * 1024); entry.pending = entry.pending.subarray(data.length);
        await this.publish({ type: "terminal", id, kind: "output", data: data.toString("base64") });
        if (entry.pending.length) await new Promise(resolve => setTimeout(resolve, 16));
      }
      if (entry.exit) { await this.publish({ type: "terminal", id, kind: "exit", ...entry.exit }); if (!entry.stopping) this.entries.delete(id); }
      else entry.pty.resume();
    } catch { process.stderr.write("[ruukoto:desktop] 终端输出未送达，请关闭终端标签后重新打开。\n"); void this.kill(id).catch(error => this.report(error)); }
    finally { entry.flushing = false; }
  }
  private entry(id: unknown): TerminalEntry {
    if (typeof id !== "string" || !this.entries.has(id)) throw new DesktopError("terminal_missing", "终端已结束，请重新打开终端。");
    const entry = this.entries.get(id)!;
    if (entry.exited || entry.stopping) throw new DesktopError("terminal_closed", "终端正在关闭或已结束，请重新打开终端。");
    return entry;
  }
  input(id: unknown, data: unknown): void {
    if (typeof data !== "string" || Buffer.byteLength(data) > 64 * 1024) throw new DesktopError("invalid_params", "终端输入过长，请分段粘贴。");
    try { this.entry(id).pty.write(data); }
    catch (error) { if (error instanceof DesktopError) throw error; throw new DesktopError("terminal_input_failed", "终端输入失败，请关闭标签后重新打开终端。"); }
  }
  resize(id: unknown, cols: unknown, rows: unknown): void {
    dimensions(cols, rows);
    try { this.entry(id).pty.resize(cols, Number(rows)); }
    catch (error) { if (error instanceof DesktopError) throw error; throw new DesktopError("terminal_resize_failed", "终端尺寸更新失败，请关闭标签后重新打开终端。"); }
  }
  kill(id: unknown): Promise<void> {
    if (typeof id !== "string") throw new DesktopError("invalid_params", "终端引用无效，请重新打开终端。");
    const entry = this.entries.get(id);
    if (!entry) return Promise.resolve();
    entry.stopping ??= this.stopProcess(entry.pty.pid).then(() => { this.entries.delete(id); }).catch(error => { entry.stopping = undefined; throw error; });
    return entry.stopping;
  }
  report(error: unknown): void { process.stderr.write(`[ruukoto:desktop] ${error instanceof DesktopError ? error.message : "终端回收失败，请检查仍运行的命令。"}\n`); }
  async reset(): Promise<void> { const results = await Promise.allSettled([...this.entries.keys()].map(id => this.kill(id))); for (const result of results) if (result.status === "rejected") { this.report(result.reason); throw result.reason; } }
  close(): Promise<void> { this.closed = true; return this.reset(); }
}
