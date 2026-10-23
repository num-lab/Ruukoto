/** 原生启动的路径、运行依赖与最小环境；两平台共用同一授权输入。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-10-native-execution-sandbox.md
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ExecutionError, type LaunchSpec, type WorkerLauncher } from "./launchers.ts";
import { assertGrantsNotProtected } from "./approved-ops.ts";
import { launchMacosNative } from "./native-macos.ts";
import { launchLinuxNative } from "./native-linux.ts";

export interface NativeLauncherConfig {
  /** 宿主构建产物；不使用 tsx 或开放源码根。 */
  workerPath?: string;
  helperPath?: string;
  /** 显式运行依赖；空列表用于自包含产物，省略时发现共享 Coding worker 的 Pi 依赖。 */
  dependencyRoots?: string[];
  /** Runtime 注入后台数据、凭据、控制面与代码根。 */
  protectedRoots?: string[];
}

export interface PreparedNativeLaunch {
  workspace: string;
  mounts: Array<{ path: string; access: "read" | "read_write" }>;
  runtimeReadRoots: string[];
  toolAliases: Array<{ path: string; target: string }>;
  env: Record<string, string>;
  tempDir: string;
  nodePath: string;
  workerPath: string;
}

export const NATIVE_WORKER_PATH = fileURLToPath(new URL("../../../../worker/worker.mjs", import.meta.url));
export const NATIVE_MACOS_HELPER_PATH = fileURLToPath(new URL("../../../../worker/native-macos-supervisor", import.meta.url));

const covers = (root: string, target: string): boolean => root === target || target.startsWith(root + path.sep);

/** 路径沙箱不能区分文件别名；同一对象权限须相同，硬链接还须全部条目已授权。 */
export function assertNativeFileLinks(mounts: PreparedNativeLaunch["mounts"]): void {
  const visited = new Set<string>();
  const directories = new Map<string, "read" | "read_write">();
  const fileEntries = new Map<string, "read" | "read_write">();
  const files = new Map<string, "read" | "read_write">();
  const links = new Map<string, Array<{ path: Buffer; access: "read" | "read_write" }>>();
  // 路径身份保留原字节；非 UTF-8 名称由工具返回具名失败，不能先被替换字符改成另一条路径。
  // Note: 见 .agents/notes/implemented/feature/2026-10-21-controlled-file-search.md
  const mountBytes = mounts.map(mount => ({ ...mount, bytes: Buffer.from(mount.path), prefix: Buffer.from(mount.path + path.sep) }));
  const pending: Array<{ path: Buffer; entryKey?: string }> = mounts.map(mount => ({ path: Buffer.from(mount.path) }));
  const reject = (): never => {
    throw new ExecutionError("execution_unavailable", "授权目录的文件别名超出范围或权限冲突；移除别名或使用独立文件副本后重试", undefined, "sandbox_rejected");
  };
  while (pending.length) {
    const { path: current, entryKey } = pending.pop()!;
    const pathKey = current.toString("latin1");
    if (visited.has(pathKey)) continue;
    visited.add(pathKey);
    const stat = fs.lstatSync(current, { bigint: true });
    const access = mountBytes.some(mount => mount.access === "read" && (current.equals(mount.bytes) || current.subarray(0, mount.prefix.length).equals(mount.prefix))) ? "read" : "read_write";
    if (stat.isDirectory()) {
      const directoryKey = `${stat.dev}:${stat.ino}`;
      const prior = directories.get(directoryKey);
      if (prior !== undefined) {
        if (prior !== access) reject();
        continue;
      }
      directories.set(directoryKey, access);
      pending.push(...fs.readdirSync(current, { encoding: "buffer" }).map(name => ({ path: Buffer.concat([current, Buffer.from(path.sep), name]), entryKey: `${directoryKey}:${name.toString("hex")}` })));
    } else if (stat.isFile()) {
      let physicalEntry = entryKey;
      if (!physicalEntry) {
        const trustedPath = current.toString("utf8");
        const parent = path.dirname(trustedPath), name = path.basename(trustedPath);
        // APFS 的大小写及 Unicode 别名不是第二个目录条目。
        if (!fs.readdirSync(parent).includes(name)) reject();
        const parentStat = fs.statSync(parent, { bigint: true });
        physicalEntry = `${parentStat.dev}:${parentStat.ino}:${Buffer.from(name).toString("hex")}`;
      }
      const prior = fileEntries.get(physicalEntry);
      if (prior !== undefined) {
        if (prior !== access) reject();
        continue;
      }
      fileEntries.set(physicalEntry, access);
      // file bind 的 nlink 仍可为 1，不能据此跳过同一对象的权限核实。
      const key = `${stat.dev}:${stat.ino}`;
      const fileAccess = files.get(key);
      if (fileAccess !== undefined && fileAccess !== access) reject();
      files.set(key, access);
      if (stat.nlink > 1n) {
        const entries = links.get(key) ?? [];
        entries.push({ path: current, access });
        links.set(key, entries);
      }
    }
  }
  for (const [key, entries] of links) {
    const mixedAccess = entries.some(entry => entry.access !== entries[0].access);
    for (const entry of entries) {
      const stat = fs.lstatSync(entry.path, { bigint: true });
      if (!stat.isFile() || `${stat.dev}:${stat.ino}` !== key || stat.nlink !== BigInt(entries.length) ||
          mixedAccess) {
        reject();
      }
    }
  }
}

function canonicalExisting(target: string): string {
  const real = fs.realpathSync(target);
  if (path.resolve(target) !== real) {
    throw new ExecutionError("execution_unavailable", "原生执行的授权路径必须使用已核实的真实路径", undefined, "sandbox_rejected");
  }
  return real;
}

function runFile(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(command, args, { encoding: "utf8", timeout: 5000 },
    (error, stdout) => error ? reject(error) : resolve(stdout)));
}

/** 只开放安装目录与实际动态库；PATH 别名另行保留，不开放拥有者 HOME。 */
async function runtimePaths(workerPath: string, nodePath: string, dependencyRoots?: string[]): Promise<{
  roots: string[]; aliases: PreparedNativeLaunch["toolAliases"]; pathValue: string;
}> {
  const roots = new Set<string>([workerPath, nodePath]);
  const aliases: PreparedNativeLaunch["toolAliases"] = [];
  const dirs = (process.env.PATH ?? "/usr/bin:/bin").split(path.delimiter).filter(p => path.isAbsolute(p));
  const visibleDirs = new Set<string>([path.dirname(nodePath)]);
  const systemRoots = process.platform === "darwin"
    ? ["/System/Library", "/usr/lib", "/usr/share", "/usr/bin", "/bin", "/usr/sbin", "/sbin", "/Library/Developer/CommandLineTools", "/private/var/select"]
    : ["/usr/bin", "/usr/sbin", "/usr/lib", "/usr/lib64", "/usr/libexec", "/usr/include", "/usr/share", "/bin", "/sbin", "/lib", "/lib64"];
  for (const root of systemRoots) if (fs.existsSync(root)) roots.add(fs.realpathSync(root));
  // Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-command-worker.md
  if (dependencyRoots !== undefined) {
    for (const root of dependencyRoots) roots.add(canonicalExisting(root));
  } else {
    let modulesParent = path.dirname(workerPath);
    while (modulesParent !== path.dirname(modulesParent)) {
      const modules = path.join(modulesParent, "node_modules");
      if (fs.existsSync(path.join(modules, "@earendil-works/pi-coding-agent"))) {
        roots.add(fs.realpathSync(modules));
        break;
      }
      modulesParent = path.dirname(modulesParent);
    }
    if (![...roots].some(root => path.basename(root) === "node_modules")) {
      throw new ExecutionError("execution_unavailable", "工具工作进程的运行依赖未安装：先运行 npm run setup 和 npm run build", undefined, "binary_missing");
    }
  }
  const executables = new Set<string>([nodePath]);
  for (const name of ["node", "npm", "npx", "git", "rg", "python3", "cc", "c++", "clang", "make"]) {
    const requested = dirs.map(dir => path.join(dir, name)).find(candidate => {
      try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); }
      catch { return false; } // PATH 中缺失或不可执行的工具不提供给任务。
    });
    if (!requested) continue;
    visibleDirs.add(path.dirname(requested));
    let current = requested;
    const seen = new Set<string>();
    while (fs.lstatSync(current).isSymbolicLink()) {
      if (seen.has(current)) throw new ExecutionError("execution_unavailable", "宿主工具链包含循环符号链接", undefined, "binary_missing");
      seen.add(current);
      const target = path.resolve(path.dirname(current), fs.readlinkSync(current));
      aliases.push({ path: current, target });
      current = target;
    }
    const real = fs.realpathSync(requested);
    executables.add(real);
    const installation = real.match(/^(.*\/Cellar\/[^/]+\/[^/]+)(?:\/|$)/)?.[1]
      ?? real.match(/^(.*\/(?:\.nvm\/versions\/node|\.pyenv\/versions|mise\/installs\/(?:node|python))\/[^/]+)(?:\/|$)/)?.[1];
    // 未知安装布局只提供实际可执行文件，不能由 bin 猜测并开放资料父目录。
    roots.add(installation ?? real);
    const npm = real.match(/^(.*\/node_modules\/npm)(?:\/|$)/)?.[1];
    if (npm) roots.add(npm);
  }
  if (process.platform === "darwin") {
    const pending = [...executables];
    const inspected = new Set<string>();
    while (pending.length) {
      const binary = pending.pop()!;
      if (inspected.has(binary)) continue;
      inspected.add(binary);
      // 脚本没有 Mach-O 依赖；实际可执行程序由对应安装目录提供。
      const header = fs.openSync(binary, "r");
      const magic = Buffer.alloc(4);
      try { fs.readSync(header, magic, 0, 4, 0); } finally { fs.closeSync(header); }
      if (magic.subarray(0, 2).toString() === "#!") continue;
      const listing = await runFile("/usr/bin/otool", ["-L", binary]);
      for (const line of listing.split("\n").slice(1)) {
        const library = line.trim().split(" (")[0];
        if (!path.isAbsolute(library) || !fs.existsSync(library)) continue;
        const real = fs.realpathSync(library);
        roots.add(real);
        if (library !== real) aliases.push({ path: library, target: real });
        pending.push(real);
      }
    }
    const selected = await runFile("/usr/bin/xcrun", ["--find", "clang"]).catch(() => "");
    if (selected.trim() && fs.existsSync(selected.trim())) {
      const real = fs.realpathSync(selected.trim());
      const developer = real.match(/^(.*\/(?:CommandLineTools|Xcode\.app))(?:\/|$)/)?.[1];
      if (developer) roots.add(developer);
    }
    for (const license of ["/Library/Preferences/com.apple.dt.Xcode.plist", "/Library/Preferences/com.apple.dt.CommandLineTools.plist"]) {
      if (fs.existsSync(license)) roots.add(license);
    }
  }
  const canonical = [...roots].map(root => fs.realpathSync(root));
  for (const root of canonical) {
    if (root === "/" || root === os.homedir()) {
      throw new ExecutionError("execution_unavailable", "宿主工具依赖需要开放整个文件系统或 HOME；请缩小安装与授权范围", undefined, "sandbox_rejected");
    }
  }
  for (const dir of ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]) visibleDirs.add(dir);
  return { roots: [...new Set(canonical)], aliases, pathValue: [...visibleDirs].join(path.delimiter) };
}

export async function prepareNativeLaunch(config: NativeLauncherConfig, spec: LaunchSpec): Promise<PreparedNativeLaunch> {
  if (spec.mode === "full_access") throw new ExecutionError("invalid_state", "原生沙箱只用于受限执行模式");
  try {
    if (!spec.workspaceIdentity) {
      throw new ExecutionError("execution_unavailable", "原生启动缺少宿主钉定的工作区目录身份", undefined, "sandbox_rejected");
    }
    const workspace = canonicalExisting(spec.workspace);
    const mounts: PreparedNativeLaunch["mounts"] = [{ path: workspace, access: "read_write" }];
    for (const grant of spec.grantedPaths) mounts.push({ path: canonicalExisting(grant.path), access: grant.access });
    for (const root of spec.readRoots ?? []) {
      const real = canonicalExisting(root.path);
      const stat = fs.statSync(real);
      if ((root.dev !== undefined && stat.dev !== root.dev) || (root.ino !== undefined && stat.ino !== root.ino)) {
        throw new ExecutionError("execution_unavailable", "原生执行的只读根身份已变化", undefined, "sandbox_rejected");
      }
      mounts.push({ path: real, access: "read" });
    }
    if (spec.workspaceIdentity) {
      const stat = fs.statSync(workspace);
      if (stat.dev !== spec.workspaceIdentity.dev || stat.ino !== spec.workspaceIdentity.ino) {
        throw new ExecutionError("execution_unavailable", "原生执行的工作区身份已变化", undefined, "sandbox_rejected");
      }
    }
    // Note: 见 .agents/notes/implemented/bug-fix/2026-10-24-read-check-overhead.md
    assertGrantsNotProtected(mounts.map(mount => mount.path), config.protectedRoots ?? []);
    for (const read of mounts.filter(m => m.access === "read")) {
      if (mounts.some(m => m.access === "read_write" && covers(read.path, m.path))) {
        throw new ExecutionError("execution_unavailable", "只读根中存在读写授权；请消除重叠授权后重试", undefined, "sandbox_rejected");
      }
    }
    assertNativeFileLinks(mounts);
    const workerPath = fs.realpathSync(config.workerPath ?? NATIVE_WORKER_PATH);
    const nodePath = fs.realpathSync(process.execPath);
    const runtime = await runtimePaths(workerPath, nodePath, config.dependencyRoots);
    const codeRoot = fs.realpathSync(fileURLToPath(new URL("../../../../", import.meta.url)));
    for (const protectedRoot of config.protectedRoots ?? []) {
      const protectedReal = path.resolve(protectedRoot);
      const roots = runtime.roots.filter(root => !(protectedReal === codeRoot &&
        (root === workerPath || (config.dependencyRoots === undefined && root === path.join(codeRoot, "node_modules")))));
      assertGrantsNotProtected(roots, [protectedReal]);
    }
    const injected = spec.env ?? {};
    for (const key of Object.keys(injected)) {
      if (!/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) {
        throw new ExecutionError("execution_unavailable", "原生执行只接受宿主固定的 Git 环境参数", undefined, "sandbox_rejected");
      }
    }
    const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-native-")));
    fs.mkdirSync(path.join(tempDir, "home"), { mode: 0o700 });
    fs.mkdirSync(path.join(tempDir, "tmp"), { mode: 0o700 });
    return { workspace, mounts: mounts.sort((a, b) => a.path.length - b.path.length),
      runtimeReadRoots: runtime.roots, toolAliases: runtime.aliases, tempDir, nodePath, workerPath,
      env: { PATH: runtime.pathValue, HOME: path.join(tempDir, "home"), TMPDIR: path.join(tempDir, "tmp"),
        LANG: process.env.LANG ?? "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1", ...injected } };
  } catch (error) {
    if (error instanceof ExecutionError) throw error;
    throw new ExecutionError("execution_unavailable", "原生执行路径或运行依赖不可用：请检查授权目录并运行 npm run build", undefined,
      (error as NodeJS.ErrnoException).code === "ENOENT" ? "binary_missing" : "sandbox_rejected");
  }
}

export function createNativeLauncher(config: NativeLauncherConfig = {}): WorkerLauncher {
  return { kind: "native", async launch(spec) {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      throw new ExecutionError("execution_unavailable", "原生受限执行只支持 macOS 与 Linux", undefined, "binary_missing");
    }
    const input = await prepareNativeLaunch(config, spec);
    const wrap = (unit: import("./launchers.ts").LaunchedUnit): void => {
      const stop = unit.entry.stop;
      unit.entry.stop = async () => {
        const reaped = await stop();
        if (reaped) fs.rmSync(input.tempDir, { recursive: true, force: true });
        return reaped;
      };
    };
    try {
      const unit = process.platform === "darwin"
        ? await launchMacosNative(input, spec, config.helperPath ?? NATIVE_MACOS_HELPER_PATH)
        : await launchLinuxNative(input, spec);
      wrap(unit);
      return unit;
    } catch (error) {
      if (error instanceof ExecutionError && error.unit) wrap(error.unit);
      else fs.rmSync(input.tempDir, { recursive: true, force: true });
      throw error;
    }
  } };
}
