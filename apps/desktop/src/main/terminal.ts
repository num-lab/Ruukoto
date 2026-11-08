import { execFileSync } from "node:child_process";
import { verifyDirIdentitySync, type DirIdentity } from "@ruukoto/core/dir-identity.ts";
import type { IPty, IPtyForkOptions } from "node-pty";
import type { DesktopTerminalId, DesktopTerminalUpdate } from "../shared/bridge.ts";
import { DesktopError } from "./environment.ts";

export type TerminalPty = Pick<IPty, "pid" | "write" | "resize" | "pause" | "resume" | "onData" | "onExit">;
export type PtyFactory = (shell: string, args: string[], options: IPtyForkOptions) => TerminalPty;
interface TerminalEntry { pty: TerminalPty; pending: Buffer; timer?: ReturnType<typeof setTimeout>; flushing: boolean; exited: boolean; stopping?: Promise<void>; exit?: { exitCode: number; signal?: number } }

function dimensions(cols: unknown, rows: unknown): asserts cols is number {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || Number(cols) < 2 || Number(cols) > 500 || Number(rows) < 1 || Number(rows) > 300) throw new DesktopError("invalid_params", "Invalid terminal size; reopen the terminal.");
}
function processTable() {
  let output: string;
  try { output = execFileSync("/bin/ps", ["-eo", "pid=,ppid=,pgid=,stat="], { encoding: "utf8", timeout: 1000, maxBuffer: 4 * 1024 * 1024 }); }
  catch { throw new DesktopError("terminal_stop_failed", "The terminal process can't be verified; check Activity Monitor and reopen the app."); }
  return output.trim().split("\n").map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) throw new DesktopError("terminal_stop_failed", "The terminal process can't be verified; check Activity Monitor and reopen the app.");
    return { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), state: match[4] };
  });
}
function signalGroups(groups: Set<number>, signal: NodeJS.Signals): void {
  for (const group of groups) {
    try { process.kill(-group, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new DesktopError("terminal_stop_failed", "Terminal process cleanup failed; check still-running commands in Activity Monitor."); }
  }
}

// Note: See .agents/notes/implemented/feature/2026-10-20-desktop-integrated-terminal.md
export class TerminalManager {
  private readonly entries = new Map<DesktopTerminalId, TerminalEntry>();
  private closed = false;
  constructor(private readonly factory: PtyFactory, private readonly publish: (update: DesktopTerminalUpdate) => void | Promise<void>, private readonly stopProcess = async (pid: number) => {
    // shortcut: only tracks descendants still in the tree when stopping; covering self-detaching processes needs an OS supervisor.
    const table = processTable(), root = table.find(row => row.pid === pid);
    if (!root) return;
    if (root.group !== pid) throw new DesktopError("terminal_stop_failed", "The terminal process group can't be verified; check still-running commands in Activity Monitor.");
    const members = new Set([pid]);
    let previous = 0;
    while (previous !== members.size) { previous = members.size; for (const row of table) if (members.has(row.parent)) members.add(row.pid); }
    const groups = new Set(table.filter(row => members.has(row.pid)).map(row => row.group));
    if (groups.has(table.find(row => row.pid === process.pid)?.group ?? process.pid)) throw new DesktopError("terminal_stop_failed", "The terminal process group overlaps the app; check still-running commands in Activity Monitor.");
    signalGroups(groups, "SIGTERM");
    // The shell exiting doesn't mean the foreground job exited; keep the verified process group's escalated cleanup.
    await new Promise(resolve => setTimeout(resolve, 500));
    signalGroups(groups, "SIGKILL");
    await new Promise(resolve => setTimeout(resolve, 100));
    if (processTable().some(row => groups.has(row.group) && !row.state.startsWith("Z"))) throw new DesktopError("terminal_stop_failed", "The terminal still has running processes; check Activity Monitor and reopen the app.");
  }) {}

  open(id: unknown, root: DirIdentity, cols: unknown, rows: unknown, env: NodeJS.ProcessEnv): { id: DesktopTerminalId; cwd: string } {
    if (this.closed) throw new DesktopError("terminal_closed", "The terminal host closed; reopen the app.");
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) throw new DesktopError("invalid_params", "Invalid terminal reference; reopen the terminal.");
    if (this.entries.has(id)) throw new DesktopError("terminal_exists", "The terminal is already open; switch to the original tab.");
    if (this.entries.size >= 8) throw new DesktopError("terminal_limit", "At most 8 terminals can be open; close a tab first.");
    dimensions(cols, rows);
    let cwd: string;
    try { cwd = verifyDirIdentitySync(root).cwdReal; }
    catch { throw new DesktopError("terminal_workspace_changed", "The workspace directory expired or was replaced; re-add the workspace before opening the terminal."); }
    let pty: TerminalPty;
    try { pty = this.factory(env.SHELL || "/bin/zsh", ["-l"], { cwd, cols, rows: Number(rows), env: { ...env, TERM: "xterm-256color" }, name: "xterm-256color" }); }
    catch { throw new DesktopError("terminal_open_failed", "The terminal failed to start; check the default shell or rebuild the desktop app."); }
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
    } catch { process.stderr.write("[ruukoto:desktop] Terminal output wasn't delivered; close the terminal tab and reopen it.\n"); void this.kill(id).catch(error => this.report(error)); }
    finally { entry.flushing = false; }
  }
  private entry(id: unknown): TerminalEntry {
    if (typeof id !== "string" || !this.entries.has(id)) throw new DesktopError("terminal_missing", "The terminal ended; reopen it.");
    const entry = this.entries.get(id)!;
    if (entry.exited || entry.stopping) throw new DesktopError("terminal_closed", "The terminal is closing or already ended; reopen it.");
    return entry;
  }
  input(id: unknown, data: unknown): void {
    if (typeof data !== "string" || Buffer.byteLength(data) > 64 * 1024) throw new DesktopError("invalid_params", "The terminal input is too long; paste it in chunks.");
    try { this.entry(id).pty.write(data); }
    catch (error) { if (error instanceof DesktopError) throw error; throw new DesktopError("terminal_input_failed", "Terminal input failed; close the tab and reopen the terminal."); }
  }
  resize(id: unknown, cols: unknown, rows: unknown): void {
    dimensions(cols, rows);
    try { this.entry(id).pty.resize(cols, Number(rows)); }
    catch (error) { if (error instanceof DesktopError) throw error; throw new DesktopError("terminal_resize_failed", "Terminal resize failed; close the tab and reopen the terminal."); }
  }
  kill(id: unknown): Promise<void> {
    if (typeof id !== "string") throw new DesktopError("invalid_params", "Invalid terminal reference; reopen the terminal.");
    const entry = this.entries.get(id);
    if (!entry) return Promise.resolve();
    entry.stopping ??= this.stopProcess(entry.pty.pid).then(() => { this.entries.delete(id); }).catch(error => { entry.stopping = undefined; throw error; });
    return entry.stopping;
  }
  report(error: unknown): void { process.stderr.write(`[ruukoto:desktop] ${error instanceof DesktopError ? error.message : "Terminal cleanup failed; check still-running commands."}\n`); }
  async reset(): Promise<void> { const results = await Promise.allSettled([...this.entries.keys()].map(id => this.kill(id))); for (const result of results) if (result.status === "rejected") { this.report(result.reason); throw result.reason; } }
  close(): Promise<void> { this.closed = true; return this.reset(); }
}
