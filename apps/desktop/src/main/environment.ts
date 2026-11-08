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
const HOST_INJECTION = /^(?:NODE_|DYLD_|LD_)|^(?:ELECTRON_RUN_AS_NODE|ELECTRON_RENDERER_URL|RUUKOTO_DESKTOP_DEV_NONCE|RUUKOTO_DESKTOP_MYGO_USER_DATA|OPENSSL_CONF|OPENSSL_MODULES|SSL_CERT_FILE|SSL_CERT_DIR|SSLKEYLOGFILE|CODESIGN_ALLOCATE)$/;

export function hostEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !HOST_INJECTION.test(key)));
}

export interface DesktopEnvironment { env: NodeJS.ProcessEnv; node: string }
const probe = 'process.stdout.write("\\0RUUKOTO_DESKTOP\\0"+JSON.stringify({env:process.env,node:process.execPath,version:process.versions.node})+"\\0END\\0")';

function parseProbe(stdout: string): DesktopEnvironment {
  const marker = "\0RUUKOTO_DESKTOP\0";
  const start = stdout.lastIndexOf(marker);
  const end = stdout.indexOf("\0END\0", start + marker.length);
  if (start < 0 || end < 0) throw new DesktopError("node_unavailable", "No usable node found; install Node ≥ 24.15 in the login shell and reconnect.");
  let result: unknown;
  try { result = JSON.parse(stdout.slice(start + marker.length, end)); }
  catch { throw new DesktopError("shell_environment", "The login shell's environment can't be parsed; check the shell config and reconnect."); }
  if (!result || typeof result !== "object" || !("node" in result) || typeof result.node !== "string" || !path.isAbsolute(result.node) || !("env" in result) || !result.env || typeof result.env !== "object" || Object.values(result.env).some(value => typeof value !== "string")) throw new DesktopError("shell_environment", "Can't read the login environment; check the shell config and reconnect.");
  if (!("version" in result) || typeof result.version !== "string") throw new DesktopError("node_unavailable", "Can't verify the node version; install Node ≥ 24.15 and reconnect.");
  const [major, minor] = result.version.split(".").map(Number);
  if (!(major > 24 || (major === 24 && minor >= 15))) throw new DesktopError("node_unavailable", "The node version is too old; install Node ≥ 24.15 and reconnect.");
  return { node: result.node, env: result.env as NodeJS.ProcessEnv };
}

async function executeProbe(command: string, args: string[], options: ExecFileOptions): Promise<string> {
  const { signal, ...execution } = options;
  const reading = execute(command, args, { ...execution, encoding: "utf8", killSignal: "SIGKILL" });
  if (!reading.child) return (await reading).stdout;
  // execFile doesn't forward killSignal to the inner spawn's cancel path; reap the read process directly and await close.
  const cancellation = signal ? addAbortListener(signal, () => { reading.child.kill("SIGKILL"); }) : undefined;
  const closed = new Promise<void>(resolve => reading.child.once("close", () => resolve()));
  try { return (await reading).stdout; }
  finally { await closed; cancellation?.[Symbol.dispose](); }
}

export async function readLoginEnvironment(inherited: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<DesktopEnvironment> {
  let stdout: string;
  try { stdout = await executeProbe(inherited.SHELL || "/bin/zsh", ["-ilc", `node -e '${probe}'`], { env: inherited, signal, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }); }
  catch { throw new DesktopError("shell_environment", "Can't read node and the environment from the login shell; make sure the login shell can run node (≥ 24.15) and reconnect."); }
  return parseProbe(stdout);
}

export async function selectEnvironment(inherited: NodeJS.ProcessEnv, login = readLoginEnvironment, signal?: AbortSignal): Promise<DesktopEnvironment> {
  if (inherited.RUUKOTO_DESKTOP_MANAGED !== "1") return login(inherited, signal);
  let stdout: string;
  try { stdout = await executeProbe("node", ["-e", probe], { env: inherited, signal, timeout: 5000 }); }
  catch { throw new DesktopError("node_unavailable", "No node found in the dev environment; fix PATH and restart the dev launcher."); }
  return { node: parseProbe(stdout).node, env: { ...inherited } };
}

export function adoptEnvironment(env: NodeJS.ProcessEnv): void {
  const source = hostEnvironment(env);
  for (const key of Object.keys(process.env)) if (!(key in source)) delete process.env[key];
  Object.assign(process.env, source);
}

export interface CodeTargetConfig extends EnsureBackendOptions {
  product: "ruukoto-code";
  managed: boolean;
  socketPath: string;
}
export function codeTargetConfig(repository: string, source: DesktopEnvironment): CodeTargetConfig {
  const bin = path.join(repository, "apps/ruukoto-code/bin/ruukoto-code.mjs");
  if (!path.isAbsolute(repository) || !fs.existsSync(bin)) throw new DesktopError("repository_missing", "The build-time repository path is unavailable; rebuild with npm run desktop:build (Electron) or npm run desktop:mygo:build (MyGo) in the current repo.");
  const product = "ruukoto-code";
  const dataDir = path.resolve(defaultDataDir(product));
  const controlDir = path.resolve(controlDirFor(dataDir, product));
  const agentDir = path.resolve(defaultAgentDir(product));
  return { product, managed: source.env.RUUKOTO_DESKTOP_MANAGED === "1", dataDir, controlDir, agentDir, socketPath: socketPathFor(controlDir), spawnExecPath: source.node, spawnArgv: [bin, "server", "--data-dir", dataDir, "--agent-dir", agentDir], env: source.env };
}
