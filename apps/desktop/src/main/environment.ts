import { execFile, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";
import { addAbortListener } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultDataDir, defaultAgentDir, controlDirFor, socketPathFor } from "@ruukoto/control/connect.ts";
import type { EnsureBackendOptions } from "@ruukoto/control/ensure-backend.ts";

const execute = promisify(execFile);
export class DesktopError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "DesktopError"; }
}
export interface DesktopEnvironment { env: NodeJS.ProcessEnv; node: string }
const probe = 'process.stdout.write("\\0RUUKOTO_DESKTOP\\0"+JSON.stringify({env:process.env,node:process.execPath,version:process.versions.node})+"\\0END\\0")';

function parseProbe(stdout: string): DesktopEnvironment {
  const marker = "\0RUUKOTO_DESKTOP\0";
  const start = stdout.lastIndexOf(marker);
  const end = stdout.indexOf("\0END\0", start + marker.length);
  if (start < 0 || end < 0) throw new DesktopError("node_unavailable", "找不到可用的 node；请在登录 shell 中安装 Node ≥ 22.19 后重新连接。");
  let result: unknown;
  try { result = JSON.parse(stdout.slice(start + marker.length, end)); }
  catch { throw new DesktopError("shell_environment", "登录 shell 返回的环境不可解析；请检查 shell 配置后重新连接。"); }
  if (!result || typeof result !== "object" || !("node" in result) || typeof result.node !== "string" || !path.isAbsolute(result.node) || !("env" in result) || !result.env || typeof result.env !== "object" || Object.values(result.env).some(value => typeof value !== "string")) throw new DesktopError("shell_environment", "无法读取登录环境；请检查 shell 配置后重新连接。");
  if (!("version" in result) || typeof result.version !== "string") throw new DesktopError("node_unavailable", "无法核实 node 版本；请安装 Node ≥ 22.19 后重新连接。");
  const [major, minor] = result.version.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) throw new DesktopError("node_unavailable", "node 版本过旧；请安装 Node ≥ 22.19 后重新连接。");
  return { node: result.node, env: result.env as NodeJS.ProcessEnv };
}

async function executeProbe(command: string, args: string[], options: ExecFileOptions): Promise<string> {
  const { signal, ...execution } = options;
  const reading = execute(command, args, { ...execution, encoding: "utf8", killSignal: "SIGKILL" });
  if (!reading.child) return (await reading).stdout;
  // execFile 未把 killSignal 转给内部 spawn 的取消路径，直接回收读取进程并等 close。
  const cancellation = signal ? addAbortListener(signal, () => { reading.child.kill("SIGKILL"); }) : undefined;
  const closed = new Promise<void>(resolve => reading.child.once("close", () => resolve()));
  try { return (await reading).stdout; }
  finally { await closed; cancellation?.[Symbol.dispose](); }
}

export async function readLoginEnvironment(inherited: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<DesktopEnvironment> {
  let stdout: string;
  try { stdout = await executeProbe(inherited.SHELL || "/bin/zsh", ["-ilc", `node -e '${probe}'`], { env: inherited, signal, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }); }
  catch { throw new DesktopError("shell_environment", "无法从登录 shell 读取 node 与环境；请确认登录 shell 能运行 node（≥ 22.19）后重新连接。"); }
  return parseProbe(stdout);
}

export async function selectEnvironment(inherited: NodeJS.ProcessEnv, login = readLoginEnvironment, signal?: AbortSignal): Promise<DesktopEnvironment> {
  if (inherited.RUUKOTO_DESKTOP_MANAGED !== "1") return login(inherited, signal);
  let stdout: string;
  try { stdout = await executeProbe("node", ["-e", probe], { env: inherited, signal, timeout: 5000 }); }
  catch { throw new DesktopError("node_unavailable", "开发环境中找不到 node；请修正 PATH 后重启开发启动器。"); }
  return { node: parseProbe(stdout).node, env: { ...inherited } };
}

export function adoptEnvironment(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
}

export interface CodeTargetConfig extends EnsureBackendOptions {
  product: "ruukoto-code";
  managed: boolean;
  socketPath: string;
}
export function codeTargetConfig(repository: string, source: DesktopEnvironment): CodeTargetConfig {
  const bin = path.join(repository, "apps/ruukoto-code/bin/ruukoto-code.mjs");
  if (!path.isAbsolute(repository) || !fs.existsSync(bin)) throw new DesktopError("repository_missing", "构建时的仓库路径不可用；请在当前仓库运行 npm run desktop:build（Electron）或 npm run desktop:mygo:build（MyGo）重建应用。");
  const product = "ruukoto-code";
  const dataDir = path.resolve(defaultDataDir(product));
  const controlDir = path.resolve(controlDirFor(dataDir, product));
  const agentDir = path.resolve(defaultAgentDir(product));
  return { product, managed: source.env.RUUKOTO_DESKTOP_MANAGED === "1", dataDir, controlDir, agentDir, socketPath: socketPathFor(controlDir), spawnExecPath: source.node, spawnArgv: [bin, "server", "--data-dir", dataDir, "--agent-dir", agentDir], env: source.env };
}
