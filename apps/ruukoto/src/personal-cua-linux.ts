/** 电脑 CLI 的 user scope 与既有 Docker 运行代核实，恢复事实归原 MCP 操作。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-23-cua-official-mcp.md
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { cuaProgram } from "@ruukoto/agent/mcp/cua.ts";
import { PersonalError } from "./personal-error.ts";

export type CuaLinuxGeneration = { containerId: string; startedAt: string; bootId: string; pid: number; processIdentity: string };
export type CuaCliExecution = { scope: string; description: string; invocationId: string; group: string; dev: number; ino: number };
type Program = { command: string; args: string[]; env: Record<string, string>; cwd?: string };
export type CuaLinuxCommand = (program: string, args: string[]) => Promise<string>;
const invalid = () => new PersonalError("cua_identity_unverified", "电脑原执行身份无法核实，绑定保持暂停；请保留档案并检查本地沙箱。");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const fixedEnv = (): Record<string, string> => ({ PATH: "/usr/bin:/bin", LANG: "C.UTF-8", ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}), ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}) });
const run: CuaLinuxCommand = (program, args) => new Promise((resolve, reject) => {
  if (process.platform !== "linux") { reject(new PersonalError("cua_platform_unavailable", "个人电脑入口需要 Linux 主机与本地 Docker，普通聊天仍可使用。")); return; }
  execFile(program, args, { env: fixedEnv(), encoding: "utf8", timeout: program === "/usr/bin/docker" && args[2] === "stop" ? 20_000 : 10_000, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(new PersonalError("cua_host_unavailable", "本地电脑执行核实失败，绑定保持暂停；请检查 Docker 与 user systemd。", { cause: error })) : resolve(stdout));
});
function processStart(pid: number): string {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const ticks = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19];
  if (!/^\d+$/.test(ticks ?? "")) throw invalid();
  return ticks;
}

/** 本地 Docker 控制只由宿主恢复入口调用；不继承 Docker endpoint/context 环境。 */
export function personalCuaLinux(command: CuaLinuxCommand = run) {
  const docker = (args: string[]) => command("/usr/bin/docker", ["--host", "unix:///var/run/docker.sock", ...args]);
  function verifyTarget(sandbox: string, containerId: string, home: string) {
    if (!/^local:[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(sandbox) || !path.isAbsolute(home)) throw invalid();
    const filename = path.join(home, ".cua", "sandboxes", sandbox.slice(6) + ".json"), stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.size > 1024 * 1024) throw invalid();
    const state: unknown = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (!object(state) || state.container_id !== containerId) throw invalid();
  }
  async function inspect(containerId: string) {
    if (!/^[0-9a-f]{64}$/.test(containerId)) throw invalid();
    const raw: unknown = JSON.parse(await docker(["inspect", "--type", "container", containerId]));
    const item = Array.isArray(raw) && raw.length === 1 ? raw[0] : undefined;
    if (!object(item) || item.Id !== containerId || !object(item.State) || !object(item.HostConfig) || !object(item.HostConfig.RestartPolicy) || item.HostConfig.RestartPolicy.Name !== "no" || item.HostConfig.Privileged === true || (Array.isArray(item.HostConfig.Devices) && item.HostConfig.Devices.length > 0) || item.HostConfig.NetworkMode === "host" || !["", "private"].includes(String(item.HostConfig.PidMode ?? "")) || !Array.isArray(item.Mounts) || item.Mounts.some(mount => !object(mount) || /(?:X11|wayland|docker\.sock)/i.test(String(mount.Source)))) throw invalid();
    const state = item.State;
    if (typeof state.Running !== "boolean" || typeof state.Restarting !== "boolean" || !Number.isSafeInteger(state.Pid) || typeof state.StartedAt !== "string") throw invalid();
    return { running: state.Running, restarting: state.Restarting, pid: state.Pid as number, startedAt: state.StartedAt };
  }
  async function generation(containerId: string): Promise<CuaLinuxGeneration> {
    const state = await inspect(containerId);
    if (!state.running || state.restarting || state.pid < 1) throw invalid();
    const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const processIdentity = processStart(state.pid);
    if (!/^[0-9a-f-]{36}$/.test(bootId)) throw invalid();
    const after = await inspect(containerId);
    if (after.startedAt !== state.startedAt || after.pid !== state.pid || !after.running || after.restarting) throw invalid();
    return { containerId, startedAt: state.startedAt, bootId, pid: state.pid, processIdentity };
  }
  async function stopped(original: CuaLinuxGeneration) {
    const state = await inspect(original.containerId);
    if (state.running || state.restarting || state.pid !== 0 || state.startedAt !== original.startedAt) return false;
    if (fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() !== original.bootId) return true;
    try { if (processStart(original.pid) === original.processIdentity) return false; }
    catch (error) { if (!(error instanceof Error && "code" in error && ["ENOENT", "ESRCH"].includes(String(error.code)))) throw invalid(); }
    return true;
  }
  async function stop(original: CuaLinuxGeneration) {
    if (await stopped(original)) return true;
    const before = await generation(original.containerId);
    if (JSON.stringify(before) !== JSON.stringify(original)) throw invalid();
    await docker(["stop", "--time", "10", original.containerId]);
    return stopped(original);
  }
  async function restart(original: CuaLinuxGeneration) {
    if (!await stopped(original)) throw invalid();
    await docker(["start", original.containerId]);
    const current = await generation(original.containerId);
    if (current.startedAt === original.startedAt) throw invalid();
    return current;
  }
  function prepare(program: Program) {
    const key = randomUUID(), scope = `ruukoto-cua-${key}.scope`, description = `ruukoto-cua-${key}`;
    return { scope, description, program: { ...program, command: "/usr/bin/systemd-run", args: ["--user", "--scope", "--quiet", "--unit", scope, "--property", "Delegate=yes", "--property", `Description=${description}`, program.command, ...program.args], env: { ...program.env, ...fixedEnv() } } };
  }
  async function scopeState(scope: string) {
    if (!/^ruukoto-cua-[0-9a-f-]{36}\.scope$/.test(scope)) throw invalid();
    const text = await command("/usr/bin/systemctl", ["--user", "show", scope, "--property", "LoadState,ActiveState,ControlGroup,InvocationID,Description"]);
    return Object.fromEntries(text.trim().split("\n").map(line => { const at = line.indexOf("="); if (at < 1) throw invalid(); return [line.slice(0, at), line.slice(at + 1)]; }));
  }
  async function execution(scope: string, description: string): Promise<CuaCliExecution> {
    const state = await scopeState(scope);
    if (state.LoadState !== "loaded" || state.ActiveState !== "active" || state.Description !== description || !/^[0-9a-f]{32}$/.test(state.InvocationID) || !state.ControlGroup.startsWith("/") || path.normalize(state.ControlGroup) !== state.ControlGroup || path.basename(state.ControlGroup) !== scope) throw invalid();
    const group = path.join("/sys/fs/cgroup", state.ControlGroup), stat = fs.statSync(group);
    return { scope, description, invocationId: state.InvocationID, group, dev: stat.dev, ino: stat.ino };
  }
  async function stopCli(original: CuaCliExecution): Promise<boolean> {
    const state = await scopeState(original.scope);
    if (state.LoadState === "not-found") return !fs.existsSync(original.group);
    if (state.InvocationID !== original.invocationId || state.Description !== original.description || path.join("/sys/fs/cgroup", state.ControlGroup) !== original.group) return false;
    if (["inactive", "failed"].includes(state.ActiveState) && !fs.existsSync(original.group)) return true;
    const fd = fs.openSync(original.group, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (stat.dev !== original.dev || stat.ino !== original.ino) return false;
      const kill = fs.openSync(`/proc/self/fd/${fd}/cgroup.kill`, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
      try { fs.writeSync(kill, "1"); } finally { fs.closeSync(kill); }
      for (let attempt = 0; attempt < 100; attempt++) {
        try { if (fs.readFileSync(`/proc/self/fd/${fd}/cgroup.events`, "utf8").split("\n").includes("populated 0")) return true; }
        catch (error) { if (!(error instanceof Error && "code" in error && ["ENOENT", "ENODEV"].includes(String(error.code)))) throw invalid(); if (!fs.existsSync(original.group)) return true; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return false;
    } finally { fs.closeSync(fd); }
  }
  async function stopPrepared(scope: string, description: string) {
    const state = await scopeState(scope);
    if (state.LoadState === "not-found") return true;
    if (state.Description !== description) return false;
    if (["inactive", "failed"].includes(state.ActiveState) && !state.ControlGroup) return true;
    return stopCli(await execution(scope, description));
  }
  async function protect<T>(action: () => Promise<T>): Promise<T> { try { return await action(); } catch (error) { if (error instanceof PersonalError) throw error; throw invalid(); } }
  return { generation: (id: string) => protect(() => generation(id)), stopped: (value: CuaLinuxGeneration) => protect(() => stopped(value)), stop: (value: CuaLinuxGeneration) => protect(() => stop(value)), restart: (value: CuaLinuxGeneration) => protect(() => restart(value)), prepare, execution: (scope: string, description: string) => protect(() => execution(scope, description)), stopCli: (value: CuaCliExecution) => protect(() => stopCli(value)), stopPrepared: (scope: string, description: string) => protect(() => stopPrepared(scope, description)), verifyTarget(sandbox: string, id: string, home: string) { try { verifyTarget(sandbox, id, home); } catch (error) { if (error instanceof PersonalError) throw error; throw invalid(); } }, program: cuaProgram };
}
