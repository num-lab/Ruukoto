/** 只发现已安装的固定制品与既有本地沙箱，不安装程序或改变沙箱策略。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-23-cua-official-mcp.md
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cuaProgram, parseCuaConfig, type CuaConfig } from "./cua.ts";
import { McpError, type McpRemoteTool } from "./transport.ts";

export type CuaTargets = { targets: { label: string; config: CuaConfig }[]; issues: { code: string; message: string }[] };
type Command = (command: string, args: string[], env: Record<string, string>) => Promise<string>;
const run: Command = (command, args, env) => new Promise((resolve, reject) => {
  execFile(command, args, { env, encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => error ? reject(new McpError("cua_check_failed", "电脑程序检查失败；请核对固定版本、执行权限和本地运行前提。")) : resolve(stdout));
});
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** 宿主调用；测试替身只替换系统读取和只读命令，不进入用户配置。 */
export async function discoverCuaTargets(kind: CuaConfig["kind"], host = { platform: process.platform as string, home: os.homedir(), searchPath: process.env.PATH ?? "", command: run }): Promise<CuaTargets> {
  const result: CuaTargets = { targets: [], issues: [] }, linux = kind === "cua-linux";
  if (host.platform !== (linux ? "linux" : "darwin")) return { ...result, issues: [{ code: "cua_platform_unavailable", message: linux ? "Linux 桌面沙箱需要个人 Agent 所在的 Linux 主机；普通聊天仍可使用。" : "本机 Cua Driver 需要 macOS；普通 MCP 与聊天仍可使用。" }] };
  const name = linux ? "cua" : "cua-driver", version = linux ? "0.7.0" : "0.38.0";
  const directories = [...host.searchPath.split(path.delimiter), path.join(host.home, ".local/bin"), "/usr/local/bin", "/opt/homebrew/bin", ...(!linux ? ["/Applications/CuaDriver.app/Contents/MacOS"] : [])];
  const seen = new Set<string>();
  for (const directory of new Set(directories.filter(path.isAbsolute))) {
    let executable: string;
    try { executable = await fs.promises.realpath(path.join(directory, name)); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") continue; result.issues.push({ code: "cua_artifact_unavailable", message: "无法读取一个电脑程序候选；请检查安装目录权限。" }); continue; }
    if (seen.has(executable)) continue;
    seen.add(executable);
    try {
      const stat = await fs.promises.stat(executable);
      if (!stat.isFile()) throw new McpError("cua_artifact_unavailable", "电脑程序不是普通文件；请重新安装官方固定版本。");
      await fs.promises.access(executable, fs.constants.X_OK);
      const hash = createHash("sha256");
      for await (const bytes of fs.createReadStream(executable)) hash.update(bytes);
      const sha256 = hash.digest("hex"), env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: host.home, LANG: "C.UTF-8" };
      const reported = (await host.command(executable, ["--version"], env)).trim();
      if (!new RegExp(`^(?:${name}|cua-cli) v?${version.replaceAll(".", "\\.")}$`).test(reported)) throw new McpError("cua_version_unsupported", `电脑程序版本不匹配；请安装官方 ${name} ${version} 后重新检查。`);
      if (!linux) { result.targets.push({ label: `Cua Driver ${version} · ${executable}`, config: parseCuaConfig({ kind, executable, version, sha256 }) }); continue; }
      const states = path.join(host.home, ".cua/sandboxes");
      let files: string[];
      try { files = await fs.promises.readdir(states); }
      catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") { result.issues.push({ code: "cua_sandbox_missing", message: "尚无既有本地沙箱；请先按官方说明准备专用 Linux 桌面与本地 Docker。" }); continue; } throw error; }
      for (const filename of files.sort()) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.json$/.test(filename)) continue;
        try {
          const location = path.join(states, filename), stateStat = await fs.promises.lstat(location);
          if (!stateStat.isFile() || stateStat.isSymbolicLink() || stateStat.uid !== process.getuid?.() || stateStat.size > 1024 * 1024) throw new McpError("cua_sandbox_invalid", "既有沙箱记录无法核实；请检查所属账户与文件权限。");
          const state: unknown = JSON.parse(await fs.promises.readFile(location, "utf8"));
          if (!object(state) || typeof state.container_id !== "string" || !/^[0-9a-f]{64}$/.test(state.container_id)) throw new McpError("cua_sandbox_invalid", "既有沙箱缺少稳定的本地容器身份；请检查官方沙箱状态。");
          const raw: unknown = JSON.parse(await host.command("/usr/bin/docker", ["--host", "unix:///var/run/docker.sock", "inspect", "--type", "container", state.container_id], env));
          const container: unknown = Array.isArray(raw) && raw.length === 1 ? raw[0] : undefined;
          if (!object(container) || container.Id !== state.container_id || !object(container.HostConfig) || !object(container.HostConfig.RestartPolicy) || container.HostConfig.RestartPolicy.Name !== "no" || container.HostConfig.Privileged === true || (Array.isArray(container.HostConfig.Devices) && container.HostConfig.Devices.length > 0) || container.HostConfig.NetworkMode === "host" || !["", "private"].includes(String(container.HostConfig.PidMode ?? "")) || !Array.isArray(container.Mounts) || container.Mounts.some(mount => !object(mount) || /(?:X11|wayland|docker\.sock)/i.test(String(mount.Source)))) throw new McpError("cua_sandbox_unsafe", "既有沙箱不满足独立桌面与停止核实前提；请检查自动重启、特权、设备和宿主桌面挂载。");
          if (!object(container.State) || container.State.Running !== true || container.State.Restarting !== false) throw new McpError("cua_sandbox_stopped", "既有沙箱尚未运行；请从官方沙箱入口启动后重新检查。");
          const sandbox = `local:${filename.slice(0, -5)}`;
          result.targets.push({ label: `${sandbox} · Cua ${version}`, config: parseCuaConfig({ kind, executable, version, sha256, sandbox, sandboxId: state.container_id }) });
        } catch (error) { result.issues.push({ code: error instanceof McpError ? error.code : "cua_sandbox_unavailable", message: error instanceof McpError ? error.message : "无法核实一个既有本地沙箱；请检查状态文件与本地 Docker 连接。" }); }
      }
    } catch (error) { result.issues.push({ code: error instanceof McpError ? error.code : "cua_artifact_unavailable", message: error instanceof McpError ? error.message : "无法核实电脑程序；请检查安装、版本和执行权限。" }); }
  }
  if (!seen.size) result.issues.push({ code: "cua_artifact_missing", message: `未发现官方 ${name} ${version}；请按安装说明准备后重新检查。` });
  else if (linux && !result.targets.length && !result.issues.length) result.issues.push({ code: "cua_sandbox_missing", message: "未发现可用的既有本地 Linux 沙箱；请先按官方说明准备专用桌面。" });
  return result;
}

/** 固定 Driver 的静态工具清单不建立电脑连接，也不借用另一 daemon 的权限。 */
export async function describeCuaTools(config: CuaConfig): Promise<McpRemoteTool[]> {
  const program = await cuaProgram(config);
  const raw: unknown = JSON.parse(await run(program.command, ["dump-docs", "--type", "mcp"], program.env));
  if (!object(raw) || raw.version !== config.version || !Array.isArray(raw.tools)) throw new McpError("cua_tools_invalid", "电脑程序的固定工具清单无法核实；请检查官方制品版本。");
  return raw.tools.map((tool: unknown) => {
    if (!object(tool) || typeof tool.name !== "string" || typeof tool.description !== "string" || !object(tool.input_schema) || tool.input_schema.type !== "object") throw new McpError("cua_tools_invalid", "电脑工具定义不完整；请检查官方制品后重新发现。");
    return { name: tool.name, description: tool.description, inputSchema: tool.input_schema as McpRemoteTool["inputSchema"] };
  });
}
