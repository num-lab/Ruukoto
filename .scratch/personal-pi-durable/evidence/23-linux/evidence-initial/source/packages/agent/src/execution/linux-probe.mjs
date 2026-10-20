// ../../../../../../private/tmp/ruukoto-worker-23.rJsV2n/probe-entry.mjs
import assert from "node:assert/strict";
import * as fs5 from "node:fs";
import * as path5 from "node:path";
import * as net from "node:net";
import { spawn as spawn2, execFileSync } from "node:child_process";
import { randomBytes as randomBytes2, createHash as createHash2 } from "node:crypto";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { finished } from "node:stream/promises";

// packages/agent/src/execution/native.ts
import * as fs3 from "node:fs";
import * as path3 from "node:path";
import * as os from "node:os";
import { execFile as execFile2 } from "node:child_process";
import { fileURLToPath } from "node:url";

// packages/agent/src/execution/launchers.ts
var ExecutionError = class extends Error {
  constructor(code, message, unit, reason, options) {
    super(message, options);
    this.unit = unit;
    this.reason = reason;
    this.code = code;
  }
  unit;
  reason;
  code;
};

// packages/agent/src/execution/approved-ops.ts
import * as fs from "node:fs";
import * as path from "node:path";
var MAX_HTTP_RESPONSE_BYTES = 1024 * 1024;
var MAX_FILE_CONTENT_BYTES = 8 * 1024 * 1024;
var ApprovedOpError = class extends Error {
};
function identityCovers(parent, target, descendants = false) {
  if (!fs.existsSync(parent)) return false;
  const pinned = fs.statSync(parent, { bigint: true });
  const targetIdentities = /* @__PURE__ */ new Set();
  let current = path.resolve(target);
  for (; ; ) {
    if (fs.existsSync(current)) {
      const stat = fs.statSync(current, { bigint: true });
      if (stat.dev === pinned.dev && stat.ino === pinned.ino) return true;
      if (descendants) targetIdentities.add(`${stat.dev}:${stat.ino}`);
    }
    const ancestor = path.dirname(current);
    if (ancestor === current) break;
    current = ancestor;
  }
  if (!descendants || !pinned.isDirectory()) return false;
  const pending = [fs.realpathSync(parent)], visited = /* @__PURE__ */ new Set();
  while (pending.length) {
    const entry = pending.pop();
    const stat = fs.lstatSync(entry, { bigint: true });
    if (stat.isSymbolicLink()) continue;
    const key = `${stat.dev}:${stat.ino}`;
    if (targetIdentities.has(key)) return true;
    if (!stat.isDirectory() || visited.has(key)) continue;
    visited.add(key);
    pending.push(...fs.readdirSync(entry).map((name) => path.join(entry, name)));
  }
  return false;
}
function isProtectedPath(resolved, protectedRoots) {
  for (const root of protectedRoots) {
    const realRoot = path.resolve(root);
    if (resolved === realRoot || resolved.startsWith(realRoot + path.sep) || identityCovers(realRoot, resolved, true)) {
      return true;
    }
  }
  return false;
}
function assertGrantNotProtected(resolved, protectedRoots) {
  if (isProtectedPath(resolved, protectedRoots)) {
    throw new ApprovedOpError(`\u8DEF\u5F84\u4F4D\u4E8E\u63A7\u5236\u9762/\u670D\u52A1\u6570\u636E\u76EE\u5F55\u5185\uFF0C\u59CB\u7EC8\u6392\u9664\uFF1A${resolved}`);
  }
  const prefix = resolved.endsWith(path.sep) ? resolved : resolved + path.sep;
  for (const root of protectedRoots) {
    const realRoot = path.resolve(root);
    if (realRoot === resolved || realRoot.startsWith(prefix) || identityCovers(resolved, realRoot)) {
      throw new ApprovedOpError(`\u8DEF\u5F84\u662F\u63A7\u5236\u9762/\u670D\u52A1\u6570\u636E\u76EE\u5F55\u7684\u7236\u7EA7\uFF0C\u59CB\u7EC8\u6392\u9664\uFF1A${resolved}`);
    }
  }
}

// packages/agent/src/execution/native-linux.ts
import * as fs2 from "node:fs";
import * as path2 from "node:path";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { Readable } from "node:stream";
var BWRAP = "/usr/bin/bwrap";
var SYSTEMD_RUN = "/usr/bin/systemd-run";
var SYSTEMCTL = "/usr/bin/systemctl";
var hostEnv = () => ({
  PATH: "/usr/bin:/bin",
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
  DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
  LANG: "C.UTF-8"
});
function command(program, args) {
  return new Promise((resolve3) => execFile(
    program,
    args,
    { encoding: "utf8", timeout: 5e3, env: hostEnv() },
    (error, stdout) => resolve3({ code: error ? typeof error.code === "number" ? error.code : null : 0, stdout })
  ));
}
function linuxNativeScopeEmpty(cgroup) {
  if (cgroup === null) return false;
  try {
    return fs2.readFileSync(path2.join(cgroup, "cgroup.events"), "utf8").split("\n").includes("populated 0");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && ["ENOENT", "ENODEV"].includes(String(error.code)))) return false;
    try {
      fs2.statSync(cgroup);
      return false;
    } catch (missing) {
      return missing instanceof Error && "code" in missing && missing.code === "ENOENT";
    }
  }
}
function nativeNetworkFilter(architecture) {
  const data = architecture === "x64" ? { arch: 3221225534, calls: [41, 42, 44, 46, 307, 425] } : architecture === "arm64" ? { arch: 3221225655, calls: [198, 203, 206, 211, 269, 425] } : null;
  if (!data) throw new ExecutionError("execution_unavailable", "\u539F\u751F\u7F51\u7EDC\u8FC7\u6EE4\u53EA\u652F\u6301 Linux x64 \u4E0E arm64", void 0, "sandbox_rejected");
  const instructions = [
    [32, 0, 0, 4],
    [21, 1, 0, data.arch],
    [6, 0, 0, 2147483648],
    [32, 0, 0, 0],
    [69, 0, 1, 1073741824],
    [6, 0, 0, 2147483648]
  ];
  for (const call of data.calls) instructions.push([21, 0, 1, call], [6, 0, 0, 327681]);
  instructions.push([6, 0, 0, 2147418112]);
  const buffer = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, yes, no, value], i) => {
    buffer.writeUInt16LE(code, i * 8);
    buffer[i * 8 + 2] = yes;
    buffer[i * 8 + 3] = no;
    buffer.writeUInt32LE(value, i * 8 + 4);
  });
  return buffer;
}
function linuxNativeArgs(input) {
  const args = [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    "--cap-drop",
    "ALL",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp"
  ];
  for (const root of [...input.runtimeReadRoots].sort((a, b) => a.length - b.length)) args.push("--ro-bind", root, root);
  for (const alias of ["/bin", "/sbin", "/lib", "/lib64"]) {
    if (fs2.existsSync(alias) && fs2.lstatSync(alias).isSymbolicLink()) args.push("--symlink", fs2.readlinkSync(alias), alias);
  }
  for (const alias of input.toolAliases) {
    if (!input.runtimeReadRoots.some((root) => alias.path === root || alias.path.startsWith(root + "/"))) {
      args.push("--symlink", alias.target, alias.path);
    }
  }
  args.push("--bind", input.tempDir, input.tempDir);
  for (const mount of input.mounts) args.push(mount.access === "read" ? "--ro-bind" : "--bind", mount.path, mount.path);
  for (const [key, value] of Object.entries(input.env)) args.push("--setenv", key, value);
  args.push(
    "--remount-ro",
    "/",
    "--remount-ro",
    "/tmp",
    "--remount-ro",
    "/dev",
    "--chdir",
    input.workspace,
    "--seccomp",
    "3",
    input.nodePath,
    "-e",
    "require('node:fs').writeSync(4,'started\\n');require('node:fs').closeSync(4);import(require('node:url').pathToFileURL(process.argv[1]).href)",
    input.workerPath
  );
  return args;
}
async function prerequisites() {
  for (const binary of [BWRAP, SYSTEMD_RUN, SYSTEMCTL]) {
    try {
      fs2.accessSync(binary, fs2.constants.X_OK);
    } catch {
      throw new ExecutionError("execution_unavailable", "Linux \u539F\u751F\u6267\u884C\u7F3A\u5C11 bubblewrap \u6216 user systemd\uFF1B\u89C1 deploy/native", void 0, "binary_missing");
    }
  }
  const restriction = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
  if (fs2.existsSync(restriction) && fs2.readFileSync(restriction, "utf8").trim() === "1" && !fs2.existsSync("/etc/apparmor.d/ruukoto-bwrap")) {
    throw new ExecutionError("execution_unavailable", "Linux \u539F\u751F\u6267\u884C\u7F3A\u5C11 bwrap \u7684 AppArmor userns \u914D\u7F6E\uFF1B\u6309 deploy/native \u5B89\u88C5\u540E\u91CD\u8BD5", void 0, "policy_missing");
  }
  const manager = await command(SYSTEMCTL, ["--user", "is-system-running"]);
  if (!fs2.existsSync("/sys/fs/cgroup/cgroup.controllers") || !["running", "degraded"].includes(manager.stdout.trim())) {
    throw new ExecutionError("execution_unavailable", "Linux \u539F\u751F\u6267\u884C\u9700\u8981 cgroup v2 \u4E0E\u53EF\u7528\u7684 user systemd", void 0, "policy_missing");
  }
}
async function launchLinuxNative(input, spec, tracking) {
  await prerequisites();
  const scope = tracking?.scope ?? `ruukoto-native-${randomUUID()}.scope`;
  const filterPath = path2.join(input.tempDir, "network.bpf");
  fs2.writeFileSync(filterPath, nativeNetworkFilter(process.arch), { mode: 256 });
  const filter = fs2.openSync(filterPath, "r");
  let child;
  try {
    tracking?.beforeSpawn();
    child = spawn(
      SYSTEMD_RUN,
      [
        "--user",
        "--scope",
        "--quiet",
        "--unit",
        scope,
        "--property",
        "Delegate=yes",
        ...tracking ? ["--property", `Description=${tracking.description}`] : [],
        BWRAP,
        ...linuxNativeArgs(input)
      ],
      { stdio: ["pipe", "pipe", "pipe", filter, "pipe"], env: hostEnv(), ...tracking ? { detached: true } : {} }
    );
  } finally {
    fs2.closeSync(filter);
  }
  let exited = false;
  const exit = new Promise((resolve3, reject) => {
    child.on("exit", (code, signal) => {
      exited = true;
      resolve3({ code, signal });
    });
    child.on("error", () => {
      exited = true;
      reject(new ExecutionError("execution_unavailable", "Linux \u539F\u751F\u6267\u884C\u5165\u53E3\u542F\u52A8\u5931\u8D25", void 0, "sandbox_rejected"));
    });
  });
  void exit.catch(() => void 0);
  if (child.pid === void 0) {
    await exit;
    throw new ExecutionError("execution_unavailable", "Linux \u539F\u751F\u6267\u884C\u672A\u521B\u5EFA\u5355\u5143", void 0, "sandbox_rejected");
  }
  let cgroup = null;
  let groupChanged = false;
  let stopped = null;
  const query = async () => {
    const result = await command(SYSTEMCTL, [
      "--user",
      "show",
      scope,
      "--property",
      `LoadState,ActiveState,ControlGroup${tracking ? ",InvocationID,Description" : ""}`
    ]);
    if (result.code !== 0) return null;
    const fields = new Map(result.stdout.trim().split("\n").map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1)];
    }));
    const group = fields.get("ControlGroup") ?? "";
    if (group) {
      if (!path2.isAbsolute(group) || path2.normalize(group) !== group || path2.basename(group) !== scope) {
        groupChanged = true;
        return null;
      }
      const current = path2.join("/sys/fs/cgroup", group);
      if (cgroup !== null && cgroup !== current) groupChanged = true;
      cgroup = current;
    }
    return {
      load: fields.get("LoadState") ?? "",
      active: fields.get("ActiveState") ?? "",
      group,
      invocationId: fields.get("InvocationID") ?? "",
      description: fields.get("Description") ?? ""
    };
  };
  const stop = () => stopped ??= (async () => {
    await query();
    if (cgroup && fs2.existsSync(cgroup)) {
      try {
        fs2.writeFileSync(path2.join(cgroup, "cgroup.kill"), "1");
      } catch {
      }
    }
    await command(SYSTEMCTL, ["--user", "kill", "--signal=SIGKILL", scope]);
    await command(SYSTEMCTL, ["--user", "stop", scope]);
    const deadline = Date.now() + 5e3;
    while (Date.now() < deadline) {
      const state = await query();
      const empty = !groupChanged && linuxNativeScopeEmpty(cgroup);
      if (state && exited && empty && (state.load === "not-found" || ["inactive", "failed"].includes(state.active))) return true;
      await new Promise((resolve3) => setTimeout(resolve3, 50));
    }
    return false;
  })();
  const unit = {
    entry: {
      kind: "systemd_unit",
      id: scope,
      label: `tool-worker native scope=${scope} task=${spec.taskId}`,
      stop
    },
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    exit
  };
  try {
    tracking?.spawned(child.pid);
    const marker = child.stdio[4];
    if (!(marker instanceof Readable)) throw new ExecutionError("execution_unavailable", "\u539F\u751F\u542F\u52A8\u6838\u5B9E\u901A\u9053\u4E0D\u53EF\u7528", unit, "sandbox_rejected");
    const started = new Promise((resolve3) => {
      let buffer = "";
      const timer = setTimeout(() => resolve3(false), 1e4);
      marker.setEncoding("utf8");
      marker.on("data", (chunk) => {
        buffer += chunk;
        if (buffer.includes("started\n")) {
          clearTimeout(timer);
          resolve3(true);
        }
      });
      void exit.then(() => {
        clearTimeout(timer);
        resolve3(false);
      }, () => {
        clearTimeout(timer);
        resolve3(false);
      });
    });
    if (!await started) throw new ExecutionError("execution_unavailable", "bubblewrap \u7B56\u7565\u6216 namespace \u542F\u52A8\u88AB\u62D2\u7EDD\uFF1B\u6838\u5BF9 deploy/native \u524D\u7F6E", unit, "sandbox_rejected");
    const status = await query();
    if (!status?.group || path2.basename(status.group) !== scope) {
      throw new ExecutionError("execution_unavailable", "\u65E0\u6CD5\u6838\u5B9E\u539F\u751F\u6267\u884C\u7684 user scope \u8EAB\u4EFD", unit, exited ? "worker_failed" : "policy_missing");
    }
    tracking?.observed(status);
    fs2.accessSync(path2.join(cgroup, "cgroup.kill"), fs2.constants.W_OK);
    return unit;
  } catch (error) {
    if (error instanceof ExecutionError && error.unit) throw error;
    throw new ExecutionError("execution_unavailable", "\u539F\u751F\u6267\u884C\u65E0\u6CD5\u6838\u5B9E cgroup \u56DE\u6536\u80FD\u529B", unit, "policy_missing");
  }
}

// packages/agent/src/execution/native.ts
var NATIVE_WORKER_PATH = fileURLToPath(new URL("../../../../worker/worker.mjs", import.meta.url));
var NATIVE_MACOS_HELPER_PATH = fileURLToPath(new URL("../../../../worker/native-macos-supervisor", import.meta.url));
var covers = (root, target) => root === target || target.startsWith(root + path3.sep);
function assertNativeFileLinks(mounts) {
  const visited = /* @__PURE__ */ new Set();
  const directories = /* @__PURE__ */ new Map();
  const fileEntries = /* @__PURE__ */ new Map();
  const files = /* @__PURE__ */ new Map();
  const links = /* @__PURE__ */ new Map();
  const pending = mounts.map((mount) => ({ path: mount.path }));
  const reject = () => {
    throw new ExecutionError("execution_unavailable", "\u6388\u6743\u76EE\u5F55\u7684\u6587\u4EF6\u522B\u540D\u8D85\u51FA\u8303\u56F4\u6216\u6743\u9650\u51B2\u7A81\uFF1B\u79FB\u9664\u522B\u540D\u6216\u4F7F\u7528\u72EC\u7ACB\u6587\u4EF6\u526F\u672C\u540E\u91CD\u8BD5", void 0, "sandbox_rejected");
  };
  while (pending.length) {
    const { path: current, entryKey } = pending.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    const stat = fs3.lstatSync(current, { bigint: true });
    const access = mounts.some((mount) => mount.access === "read" && covers(mount.path, current)) ? "read" : "read_write";
    if (stat.isDirectory()) {
      const directoryKey = `${stat.dev}:${stat.ino}`;
      const prior = directories.get(directoryKey);
      if (prior !== void 0) {
        if (prior !== access) reject();
        continue;
      }
      directories.set(directoryKey, access);
      pending.push(...fs3.readdirSync(current).map((name) => ({ path: path3.join(current, name), entryKey: `${directoryKey}:${name}` })));
    } else if (stat.isFile()) {
      let physicalEntry = entryKey;
      if (!physicalEntry) {
        const parent = path3.dirname(current), name = path3.basename(current);
        if (!fs3.readdirSync(parent).includes(name)) reject();
        const parentStat = fs3.statSync(parent, { bigint: true });
        physicalEntry = `${parentStat.dev}:${parentStat.ino}:${name}`;
      }
      const prior = fileEntries.get(physicalEntry);
      if (prior !== void 0) {
        if (prior !== access) reject();
        continue;
      }
      fileEntries.set(physicalEntry, access);
      const key = `${stat.dev}:${stat.ino}`;
      const fileAccess = files.get(key);
      if (fileAccess !== void 0 && fileAccess !== access) reject();
      files.set(key, access);
      if (stat.nlink > 1n) {
        const entries = links.get(key) ?? [];
        entries.push({ path: current, access });
        links.set(key, entries);
      }
    }
  }
  for (const [key, entries] of links) {
    const mixedAccess = entries.some((entry) => entry.access !== entries[0].access);
    for (const entry of entries) {
      const stat = fs3.lstatSync(entry.path, { bigint: true });
      if (!stat.isFile() || `${stat.dev}:${stat.ino}` !== key || stat.nlink !== BigInt(entries.length) || mixedAccess) {
        reject();
      }
    }
  }
}
function canonicalExisting(target) {
  const real = fs3.realpathSync(target);
  if (path3.resolve(target) !== real) {
    throw new ExecutionError("execution_unavailable", "\u539F\u751F\u6267\u884C\u7684\u6388\u6743\u8DEF\u5F84\u5FC5\u987B\u4F7F\u7528\u5DF2\u6838\u5B9E\u7684\u771F\u5B9E\u8DEF\u5F84", void 0, "sandbox_rejected");
  }
  return real;
}
function runFile(command2, args) {
  return new Promise((resolve3, reject) => execFile2(
    command2,
    args,
    { encoding: "utf8", timeout: 5e3 },
    (error, stdout) => error ? reject(error) : resolve3(stdout)
  ));
}
async function runtimePaths(workerPath2, nodePath, dependencyRoots) {
  const roots = /* @__PURE__ */ new Set([workerPath2, nodePath]);
  const aliases = [];
  const dirs = (process.env.PATH ?? "/usr/bin:/bin").split(path3.delimiter).filter((p) => path3.isAbsolute(p));
  const visibleDirs = /* @__PURE__ */ new Set([path3.dirname(nodePath)]);
  const systemRoots = process.platform === "darwin" ? ["/System/Library", "/usr/lib", "/usr/share", "/usr/bin", "/bin", "/usr/sbin", "/sbin", "/Library/Developer/CommandLineTools", "/private/var/select"] : ["/usr/bin", "/usr/sbin", "/usr/lib", "/usr/lib64", "/usr/libexec", "/usr/include", "/usr/share", "/bin", "/sbin", "/lib", "/lib64"];
  for (const root of systemRoots) if (fs3.existsSync(root)) roots.add(fs3.realpathSync(root));
  if (dependencyRoots !== void 0) {
    for (const root of dependencyRoots) roots.add(canonicalExisting(root));
  } else {
    let modulesParent = path3.dirname(workerPath2);
    while (modulesParent !== path3.dirname(modulesParent)) {
      const modules = path3.join(modulesParent, "node_modules");
      if (fs3.existsSync(path3.join(modules, "@earendil-works/pi-coding-agent"))) {
        roots.add(fs3.realpathSync(modules));
        break;
      }
      modulesParent = path3.dirname(modulesParent);
    }
    if (![...roots].some((root) => path3.basename(root) === "node_modules")) {
      throw new ExecutionError("execution_unavailable", "\u5DE5\u5177\u5DE5\u4F5C\u8FDB\u7A0B\u7684\u8FD0\u884C\u4F9D\u8D56\u672A\u5B89\u88C5\uFF1A\u5148\u8FD0\u884C npm run setup \u548C npm run build", void 0, "binary_missing");
    }
  }
  const executables = /* @__PURE__ */ new Set([nodePath]);
  for (const name of ["node", "npm", "npx", "git", "python3", "cc", "c++", "clang", "make"]) {
    const requested = dirs.map((dir) => path3.join(dir, name)).find((candidate) => {
      try {
        fs3.accessSync(candidate, fs3.constants.X_OK);
        return fs3.statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
    if (!requested) continue;
    visibleDirs.add(path3.dirname(requested));
    let current = requested;
    const seen = /* @__PURE__ */ new Set();
    while (fs3.lstatSync(current).isSymbolicLink()) {
      if (seen.has(current)) throw new ExecutionError("execution_unavailable", "\u5BBF\u4E3B\u5DE5\u5177\u94FE\u5305\u542B\u5FAA\u73AF\u7B26\u53F7\u94FE\u63A5", void 0, "binary_missing");
      seen.add(current);
      const target = path3.resolve(path3.dirname(current), fs3.readlinkSync(current));
      aliases.push({ path: current, target });
      current = target;
    }
    const real = fs3.realpathSync(requested);
    executables.add(real);
    const installation = real.match(/^(.*\/Cellar\/[^/]+\/[^/]+)(?:\/|$)/)?.[1] ?? real.match(/^(.*\/(?:\.nvm\/versions\/node|\.pyenv\/versions|mise\/installs\/(?:node|python))\/[^/]+)(?:\/|$)/)?.[1];
    roots.add(installation ?? real);
    const npm = real.match(/^(.*\/node_modules\/npm)(?:\/|$)/)?.[1];
    if (npm) roots.add(npm);
  }
  if (process.platform === "darwin") {
    const pending = [...executables];
    const inspected = /* @__PURE__ */ new Set();
    while (pending.length) {
      const binary = pending.pop();
      if (inspected.has(binary)) continue;
      inspected.add(binary);
      const header = fs3.openSync(binary, "r");
      const magic = Buffer.alloc(4);
      try {
        fs3.readSync(header, magic, 0, 4, 0);
      } finally {
        fs3.closeSync(header);
      }
      if (magic.subarray(0, 2).toString() === "#!") continue;
      const listing = await runFile("/usr/bin/otool", ["-L", binary]);
      for (const line of listing.split("\n").slice(1)) {
        const library = line.trim().split(" (")[0];
        if (!path3.isAbsolute(library) || !fs3.existsSync(library)) continue;
        const real = fs3.realpathSync(library);
        roots.add(real);
        if (library !== real) aliases.push({ path: library, target: real });
        pending.push(real);
      }
    }
    const selected = await runFile("/usr/bin/xcrun", ["--find", "clang"]).catch(() => "");
    if (selected.trim() && fs3.existsSync(selected.trim())) {
      const real = fs3.realpathSync(selected.trim());
      const developer = real.match(/^(.*\/(?:CommandLineTools|Xcode\.app))(?:\/|$)/)?.[1];
      if (developer) roots.add(developer);
    }
    for (const license of ["/Library/Preferences/com.apple.dt.Xcode.plist", "/Library/Preferences/com.apple.dt.CommandLineTools.plist"]) {
      if (fs3.existsSync(license)) roots.add(license);
    }
  }
  const canonical = [...roots].map((root) => fs3.realpathSync(root));
  for (const root of canonical) {
    if (root === "/" || root === os.homedir()) {
      throw new ExecutionError("execution_unavailable", "\u5BBF\u4E3B\u5DE5\u5177\u4F9D\u8D56\u9700\u8981\u5F00\u653E\u6574\u4E2A\u6587\u4EF6\u7CFB\u7EDF\u6216 HOME\uFF1B\u8BF7\u7F29\u5C0F\u5B89\u88C5\u4E0E\u6388\u6743\u8303\u56F4", void 0, "sandbox_rejected");
    }
  }
  for (const dir of ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]) visibleDirs.add(dir);
  return { roots: [...new Set(canonical)], aliases, pathValue: [...visibleDirs].join(path3.delimiter) };
}
async function prepareNativeLaunch(config, spec) {
  if (spec.mode === "full_access") throw new ExecutionError("invalid_state", "\u539F\u751F\u6C99\u7BB1\u53EA\u7528\u4E8E\u53D7\u9650\u6267\u884C\u6A21\u5F0F");
  try {
    if (!spec.workspaceIdentity) {
      throw new ExecutionError("execution_unavailable", "\u539F\u751F\u542F\u52A8\u7F3A\u5C11\u5BBF\u4E3B\u9489\u5B9A\u7684\u5DE5\u4F5C\u533A\u76EE\u5F55\u8EAB\u4EFD", void 0, "sandbox_rejected");
    }
    const workspace = canonicalExisting(spec.workspace);
    const mounts = [{ path: workspace, access: "read_write" }];
    for (const grant of spec.grantedPaths) mounts.push({ path: canonicalExisting(grant.path), access: grant.access });
    for (const root of spec.readRoots ?? []) {
      const real = canonicalExisting(root.path);
      const stat = fs3.statSync(real);
      if (root.dev !== void 0 && stat.dev !== root.dev || root.ino !== void 0 && stat.ino !== root.ino) {
        throw new ExecutionError("execution_unavailable", "\u539F\u751F\u6267\u884C\u7684\u53EA\u8BFB\u6839\u8EAB\u4EFD\u5DF2\u53D8\u5316", void 0, "sandbox_rejected");
      }
      mounts.push({ path: real, access: "read" });
    }
    if (spec.workspaceIdentity) {
      const stat = fs3.statSync(workspace);
      if (stat.dev !== spec.workspaceIdentity.dev || stat.ino !== spec.workspaceIdentity.ino) {
        throw new ExecutionError("execution_unavailable", "\u539F\u751F\u6267\u884C\u7684\u5DE5\u4F5C\u533A\u8EAB\u4EFD\u5DF2\u53D8\u5316", void 0, "sandbox_rejected");
      }
    }
    for (const mount of mounts) assertGrantNotProtected(mount.path, config.protectedRoots ?? []);
    for (const read of mounts.filter((m) => m.access === "read")) {
      if (mounts.some((m) => m.access === "read_write" && covers(read.path, m.path))) {
        throw new ExecutionError("execution_unavailable", "\u53EA\u8BFB\u6839\u4E2D\u5B58\u5728\u8BFB\u5199\u6388\u6743\uFF1B\u8BF7\u6D88\u9664\u91CD\u53E0\u6388\u6743\u540E\u91CD\u8BD5", void 0, "sandbox_rejected");
      }
    }
    assertNativeFileLinks(mounts);
    const workerPath2 = fs3.realpathSync(config.workerPath ?? NATIVE_WORKER_PATH);
    const nodePath = fs3.realpathSync(process.execPath);
    const runtime = await runtimePaths(workerPath2, nodePath, config.dependencyRoots);
    const codeRoot2 = fs3.realpathSync(fileURLToPath(new URL("../../../../", import.meta.url)));
    for (const root of runtime.roots) {
      for (const protectedRoot of config.protectedRoots ?? []) {
        const protectedReal = path3.resolve(protectedRoot);
        const codeAsset = protectedReal === codeRoot2 && (root === workerPath2 || config.dependencyRoots === void 0 && root === path3.join(codeRoot2, "node_modules"));
        if (!codeAsset) assertGrantNotProtected(root, [protectedReal]);
      }
    }
    const injected = spec.env ?? {};
    for (const key of Object.keys(injected)) {
      if (!/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) {
        throw new ExecutionError("execution_unavailable", "\u539F\u751F\u6267\u884C\u53EA\u63A5\u53D7\u5BBF\u4E3B\u56FA\u5B9A\u7684 Git \u73AF\u5883\u53C2\u6570", void 0, "sandbox_rejected");
      }
    }
    const tempDir = fs3.realpathSync(fs3.mkdtempSync(path3.join(os.tmpdir(), "ruukoto-native-")));
    fs3.mkdirSync(path3.join(tempDir, "home"), { mode: 448 });
    fs3.mkdirSync(path3.join(tempDir, "tmp"), { mode: 448 });
    return {
      workspace,
      mounts: mounts.sort((a, b) => a.path.length - b.path.length),
      runtimeReadRoots: runtime.roots,
      toolAliases: runtime.aliases,
      tempDir,
      nodePath,
      workerPath: workerPath2,
      env: {
        PATH: runtime.pathValue,
        HOME: path3.join(tempDir, "home"),
        TMPDIR: path3.join(tempDir, "tmp"),
        LANG: process.env.LANG ?? "C.UTF-8",
        GIT_CONFIG_NOSYSTEM: "1",
        ...injected
      }
    };
  } catch (error) {
    if (error instanceof ExecutionError) throw error;
    throw new ExecutionError(
      "execution_unavailable",
      "\u539F\u751F\u6267\u884C\u8DEF\u5F84\u6216\u8FD0\u884C\u4F9D\u8D56\u4E0D\u53EF\u7528\uFF1A\u8BF7\u68C0\u67E5\u6388\u6743\u76EE\u5F55\u5E76\u8FD0\u884C npm run build",
      void 0,
      error.code === "ENOENT" ? "binary_missing" : "sandbox_rejected"
    );
  }
}

// packages/agent/src/execution/native-linux-identity.ts
import * as fs4 from "node:fs";
import * as path4 from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { execFile as execFile3 } from "node:child_process";
var UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
var HEX32 = /^[0-9a-f]{32}$/;
var HEX64 = /^[0-9a-f]{64}$/;
var unavailable = (message) => new ExecutionError("execution_identity_invalid", message);
var isMissing = (error) => error instanceof Error && "code" in error && ["ENOENT", "ESRCH"].includes(String(error.code));
var covers2 = (root, target) => root === target || target.startsWith(root + path4.sep);
function privatePath(target, directory) {
  const stat = fs4.lstatSync(target);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 63 || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) {
    throw unavailable("\u539F\u6267\u884C\u8BC1\u636E\u76EE\u5F55\u6216\u6587\u4EF6\u4E0D\u53EF\u4FE1\uFF1B\u4FDD\u7559\u5360\u7528\u5E76\u6838\u5B9E\u539F\u6863\u6848");
  }
  return stat;
}
function location(directory, ref) {
  if (!/^native_[0-9a-f]{24}$/.test(ref.executionId) || !HEX32.test(ref.machineId)) throw unavailable("\u539F\u6267\u884C\u5F15\u7528\u975E\u6CD5\uFF1B\u4FDD\u7559\u5360\u7528\u5E76\u6838\u5B9E\u539F\u6863\u6848");
  privatePath(directory, true);
  if (fs4.realpathSync(directory) !== directory) throw unavailable("\u6267\u884C\u8BC1\u636E\u76EE\u5F55\u987B\u4F7F\u7528\u771F\u5B9E\u8DEF\u5F84");
  if (fs4.readFileSync("/etc/machine-id", "utf8").trim() !== ref.machineId) throw unavailable("\u539F\u6267\u884C\u4E0D\u5C5E\u4E8E\u672C\u673A\uFF1B\u4FDD\u7559\u5360\u7528\u5E76\u6838\u5B9E\u539F\u673A\u5668");
  const bootId = fs4.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!UUID.test(bootId)) throw unavailable("\u65E0\u6CD5\u6838\u5B9E\u672C\u673A\u542F\u52A8\u8EAB\u4EFD\uFF1B\u4FDD\u7559\u5360\u7528");
  return { claimDir: path4.join(directory, ref.executionId), bootId, scope: `ruukoto-${ref.executionId}.scope` };
}
function record(claimDir, name) {
  const target = path4.join(claimDir, name);
  privatePath(target, false);
  const value = JSON.parse(fs4.readFileSync(target, "utf8"));
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}
function writeRecord(claimDir, name, value) {
  fs4.writeFileSync(path4.join(claimDir, name), JSON.stringify(value) + "\n", { flag: "wx", mode: 384 });
}
function readClaim(claimDir, ref, scope) {
  privatePath(claimDir, true);
  const raw = record(claimDir, "claim.json");
  if (!raw || raw.version !== 1 || !raw.ref || typeof raw.ref !== "object") return null;
  const saved = raw.ref;
  if (saved.executionId !== ref.executionId || saved.machineId !== ref.machineId || raw.scope !== scope || typeof raw.bootId !== "string" || !UUID.test(raw.bootId) || typeof raw.token !== "string" || !HEX32.test(raw.token) || typeof raw.fingerprint !== "string" || !HEX64.test(raw.fingerprint) || !["launch", "stop"].includes(String(raw.claimedBy))) return null;
  return raw;
}
function processIdentity(pid) {
  const source = fs4.readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = source.slice(source.lastIndexOf(") ") + 2).trim().split(/\s+/);
  const processGroup = Number(fields[2]);
  if (!Number.isSafeInteger(processGroup) || processGroup !== pid || !/^\d+$/.test(fields[19] ?? "")) throw unavailable("\u65E0\u6CD5\u6838\u5B9E\u72EC\u7ACB\u542F\u52A8\u5668\u8EAB\u4EFD\uFF1B\u4FDD\u7559\u6267\u884C\u5360\u7528");
  return { pid, startTime: fields[19], processGroup };
}
function launcherExited(raw) {
  if (!raw || !Number.isSafeInteger(raw.pid) || Number(raw.pid) <= 0 || raw.processGroup !== raw.pid || typeof raw.startTime !== "string" || !/^\d+$/.test(raw.startTime)) return false;
  let current;
  try {
    current = processIdentity(Number(raw.pid));
  } catch (error) {
    if (!isMissing(error)) return false;
    current = { pid: 0, processGroup: 0, startTime: "" };
  }
  if (current.startTime === raw.startTime) return false;
  try {
    process.kill(-Number(raw.processGroup), 0);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
}
function observation(raw, scope) {
  if (!raw || typeof raw.group !== "string" || !path4.isAbsolute(raw.group) || path4.normalize(raw.group) !== raw.group || !raw.group.startsWith("/sys/fs/cgroup/") || path4.basename(raw.group) !== scope || typeof raw.invocationId !== "string" || !HEX32.test(raw.invocationId) || /^0+$/.test(raw.invocationId) || !Number.isSafeInteger(raw.dev) || !Number.isSafeInteger(raw.ino)) return null;
  return raw;
}
async function unitState(scope) {
  return new Promise((resolve3) => execFile3(
    "/usr/bin/systemctl",
    ["--user", "show", scope, "--property", "LoadState,ActiveState,ControlGroup,InvocationID,Description"],
    { encoding: "utf8", timeout: 5e3, maxBuffer: 1024 * 1024, env: {
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS
    } },
    (error, stdout) => {
      if (error) {
        resolve3(null);
        return;
      }
      const fields = {};
      for (const line of stdout.trim().split("\n")) {
        const index = line.indexOf("=");
        if (index <= 0 || Object.hasOwn(fields, line.slice(0, index))) {
          resolve3(null);
          return;
        }
        fields[line.slice(0, index)] = line.slice(index + 1);
      }
      resolve3(fields);
    }
  ));
}
async function launchLinuxExecution(directory, ref, input, spec) {
  let claimDir;
  let claim;
  try {
    const locationInfo = location(directory, ref);
    claimDir = locationInfo.claimDir;
    if (spec.mode === "full_access") throw unavailable("\u6301\u4E45\u539F\u751F\u6267\u884C\u53EA\u652F\u6301\u53D7\u9650\u6A21\u5F0F");
    for (const root of [input.tempDir, ...input.mounts.map((mount) => mount.path), ...input.runtimeReadRoots, ...input.toolAliases.flatMap((alias) => [alias.path, alias.target])]) {
      if (covers2(root, directory) || covers2(directory, root)) throw unavailable("\u6267\u884C\u8BC1\u636E\u76EE\u5F55\u4E0E\u5DE5\u4F5C\u8FDB\u7A0B\u53EF\u89C1\u8303\u56F4\u91CD\u53E0\uFF1B\u8BF7\u4F7F\u7528\u72EC\u7ACB\u4FDD\u62A4\u76EE\u5F55");
    }
    claim = {
      version: 1,
      ref,
      bootId: locationInfo.bootId,
      scope: locationInfo.scope,
      claimedBy: "launch",
      token: randomBytes(16).toString("hex"),
      fingerprint: createHash("sha256").update(JSON.stringify({ input, spec })).digest("hex")
    };
    fs4.mkdirSync(claimDir, { mode: 448 });
    writeRecord(claimDir, "claim.json", claim);
  } catch (error) {
    if (error instanceof ExecutionError) throw error;
    throw new ExecutionError("execution_claim_failed", "\u6267\u884C\u8EAB\u4EFD\u8BA4\u9886\u5931\u8D25\u6216\u5DF2\u88AB\u8BA4\u9886\uFF1B\u672A\u542F\u52A8\u65B0\u6267\u884C", void 0, void 0, { cause: error });
  }
  let attempted = false;
  let launcher;
  const stop = async () => (await stopLinuxExecution(directory, ref)).exited;
  try {
    const unit = await launchLinuxNative(input, spec, {
      scope: claim.scope,
      description: `ruukoto-execution-${claim.token}`,
      beforeSpawn() {
        if (fs4.existsSync(path4.join(claimDir, "stop-requested"))) throw unavailable("\u539F\u6267\u884C\u5DF2\u8BF7\u6C42\u505C\u6B62\uFF1B\u672A\u542F\u52A8\u65B0\u6267\u884C");
        attempted = true;
      },
      spawned(pid) {
        launcher = processIdentity(pid);
        writeRecord(claimDir, "launcher.json", launcher);
      },
      observed(state) {
        if (!launcher || state.description !== `ruukoto-execution-${claim.token}` || !fs4.readFileSync(`/proc/${launcher.pid}/cgroup`, "utf8").split("\n").includes(`0::${state.group}`)) throw unavailable("\u539F\u6267\u884C\u7684\u5355\u5143\u5F52\u5C5E\u65E0\u6CD5\u6838\u5B9E\uFF1B\u4FDD\u7559\u5360\u7528");
        const group = path4.join("/sys/fs/cgroup", state.group);
        const stat = fs4.statSync(group);
        const saved = observation({ group, invocationId: state.invocationId, dev: stat.dev, ino: stat.ino }, claim.scope);
        if (!saved) throw unavailable("\u539F\u6267\u884C\u7684\u5355\u5143\u8EAB\u4EFD\u65E0\u6CD5\u6838\u5B9E\uFF1B\u4FDD\u7559\u5360\u7528");
        writeRecord(claimDir, "observation.json", saved);
      }
    });
    unit.entry.stop = stop;
    return unit;
  } catch (error) {
    if (error instanceof ExecutionError && error.unit) {
      error.unit.entry.stop = stop;
      throw error;
    }
    if (!attempted) {
      try {
        writeRecord(claimDir, "not-dispatched.json", { token: claim.token });
      } catch (proofError) {
        throw new ExecutionError(
          "execution_identity_invalid",
          "\u539F\u6267\u884C\u542F\u52A8\u5931\u8D25\u4E14\u672A\u6D3E\u53D1\u8BC1\u636E\u65E0\u6CD5\u4FDD\u5B58\uFF1B\u4FDD\u7559\u5360\u7528\u4E0E\u73B0\u573A",
          void 0,
          void 0,
          { cause: new AggregateError([error, proofError], "\u542F\u52A8\u4E0E\u8BC1\u636E\u5199\u5165\u5747\u5931\u8D25") }
        );
      }
    }
    if (error instanceof ExecutionError) throw error;
    throw new ExecutionError("execution_unavailable", "\u539F\u6267\u884C\u542F\u52A8\u5931\u8D25\uFF1B\u4FDD\u7559\u8BA4\u9886\u5E76\u6838\u5B9E\u505C\u6B62", void 0, void 0, { cause: error });
  }
}
async function stopLinuxExecution(directory, ref) {
  const result = (exited) => ({ ref, exited });
  try {
    const { claimDir, bootId, scope } = location(directory, ref);
    let created = false;
    try {
      fs4.mkdirSync(claimDir, { mode: 448 });
      created = true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    if (created) writeRecord(claimDir, "claim.json", { version: 1, ref, bootId, scope, claimedBy: "stop", token: randomBytes(16).toString("hex"), fingerprint: "0".repeat(64) });
    privatePath(claimDir, true);
    try {
      fs4.mkdirSync(path4.join(claimDir, "stop-requested"), { mode: 448 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    privatePath(path4.join(claimDir, "stop-requested"), true);
    const claim = readClaim(claimDir, ref, scope);
    if (!claim) return result(false);
    if (claim.claimedBy === "stop" || claim.bootId !== bootId) return result(true);
    const optionalRecord = (name) => {
      try {
        return record(claimDir, name);
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    };
    if (optionalRecord("not-dispatched.json")?.token === claim.token) return result(true);
    const deadline = Date.now() + 5e3;
    do {
      const saved = observation(optionalRecord("observation.json"), scope);
      if (!saved) return result(false);
      const state = await unitState(scope);
      if (!state) return result(false);
      const sameUnit = state.InvocationID === saved.invocationId && state.Description === `ruukoto-execution-${claim.token}`;
      const inactive = state.LoadState === "not-found" || sameUnit && state.LoadState === "loaded" && ["inactive", "failed"].includes(state.ActiveState);
      let directoryFd;
      try {
        directoryFd = fs4.openSync(saved.group, fs4.constants.O_RDONLY | fs4.constants.O_DIRECTORY | fs4.constants.O_NOFOLLOW);
      } catch (error) {
        if (!isMissing(error)) return result(false);
      }
      try {
        if (directoryFd === void 0) {
          if (inactive && launcherExited(optionalRecord("launcher.json"))) return result(true);
          return result(false);
        }
        const stat = fs4.fstatSync(directoryFd);
        if (stat.dev !== saved.dev || stat.ino !== saved.ino) return result(false);
        if (!inactive) {
          if (!sameUnit || path4.join("/sys/fs/cgroup", state.ControlGroup ?? "") !== saved.group) return result(false);
          const killFd = fs4.openSync(`/proc/self/fd/${directoryFd}/cgroup.kill`, fs4.constants.O_WRONLY | fs4.constants.O_NOFOLLOW);
          try {
            fs4.writeSync(killFd, "1");
          } finally {
            fs4.closeSync(killFd);
          }
        }
        if (linuxNativeScopeEmpty(`/proc/self/fd/${directoryFd}`) && inactive && launcherExited(optionalRecord("launcher.json"))) return result(true);
      } catch {
        return result(false);
      } finally {
        if (directoryFd !== void 0) fs4.closeSync(directoryFd);
      }
      await new Promise((resolve3) => setTimeout(resolve3, 50));
    } while (Date.now() < deadline);
    return result(false);
  } catch (error) {
    if (error instanceof ExecutionError) throw error;
    throw new ExecutionError("execution_identity_invalid", "\u539F\u6267\u884C\u8BC1\u636E\u65E0\u6CD5\u6838\u5B9E\uFF1B\u4FDD\u7559\u5360\u7528\u4E0E\u73B0\u573A", void 0, void 0, { cause: error });
  }
}

// ../../../../../../private/tmp/ruukoto-worker-23.rJsV2n/probe-entry.mjs
var self = fileURLToPath2(import.meta.url);
var codeRoot = fileURLToPath2(new URL("../../../../", import.meta.url));
var workerPath = path5.join(codeRoot, "worker/personal-command-worker.mjs");
var base = process.argv[3] ?? path5.dirname(codeRoot);
var evidence = path5.join(base, "evidence");
var sha = (value) => createHash2("sha256").update(value).digest("hex");
var sleep = (ms) => new Promise((resolve3) => setTimeout(resolve3, ms));
var quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
var waitFor = async (predicate, description) => {
  const deadline = Date.now() + 15e3;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`\u7B49\u5F85\u8D85\u65F6\uFF1A${description}`);
    await sleep(20);
  }
};
var write = (target, value) => fs5.writeFileSync(target, JSON.stringify(value, null, 2) + "\n");
var attach = (unit) => {
  const stdout = [], stderr = [];
  unit.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  unit.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  unit.stdin.on("error", (error) => {
    throw error;
  });
  const completion = Promise.all([unit.exit, finished(unit.stdout), finished(unit.stderr)]).then(([exit]) => ({
    ...exit,
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr)
  }));
  return { completion };
};
if (process.argv[2] === "owner") {
  const fixture = process.argv[4];
  const input = JSON.parse(fs5.readFileSync(path5.join(fixture, "input.json"), "utf8"));
  const prepared = await prepareNativeLaunch({ workerPath, dependencyRoots: [], protectedRoots: [codeRoot, input.claims] }, input.spec);
  write(path5.join(fixture, "prepared.json"), prepared);
  const unit = await launchLinuxExecution(input.claims, input.ref, prepared, input.spec);
  const collected = attach(unit);
  unit.stdin.end(JSON.stringify(input.payload));
  void collected.completion.then((result) => write(path5.join(fixture, "unit-exit.json"), {
    code: result.code,
    signal: result.signal,
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8")
  }));
  write(path5.join(fixture, "ready.json"), { scope: unit.entry.id, owner: process.pid });
  setInterval(() => {
  }, 1e3);
} else {
  fs5.mkdirSync(evidence, { recursive: true });
  const machineId = fs5.readFileSync("/etc/machine-id", "utf8").trim();
  const results = [];
  const fixtureRoot = path5.join(base, "fixtures");
  fs5.mkdirSync(fixtureRoot, { recursive: true, mode: 448 });
  write(path5.join(evidence, "environment.json"), {
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    uid: process.getuid(),
    kernel: execFileSync("uname", ["-a"], { encoding: "utf8" }).trim(),
    bwrap: execFileSync("/usr/bin/bwrap", ["--version"], { encoding: "utf8" }).trim(),
    systemd: execFileSync("/usr/bin/systemctl", ["--version"], { encoding: "utf8" }).split("\n")[0],
    userManager: execFileSync("/usr/bin/systemctl", ["--user", "is-system-running"], { encoding: "utf8" }).trim(),
    cgroupVersion: fs5.existsSync("/sys/fs/cgroup/cgroup.controllers") ? 2 : null,
    worker: { path: workerPath, sha256: sha(fs5.readFileSync(workerPath)) },
    probe: { path: self, sha256: sha(fs5.readFileSync(self)) },
    codeRoot,
    hasNodeModules: fs5.existsSync(path5.join(codeRoot, "node_modules"))
  });
  const fixture = (name) => {
    const directory = fs5.realpathSync(fs5.mkdtempSync(path5.join(fixtureRoot, name + "-")));
    const workspace = path5.join(directory, "work"), claims = path5.join(directory, "claims");
    fs5.mkdirSync(workspace, { mode: 448 });
    fs5.mkdirSync(claims, { mode: 448 });
    const { dev, ino } = fs5.statSync(workspace);
    const ref = { executionId: `native_${randomBytes2(12).toString("hex")}`, machineId };
    const spec = { taskId: `real-personal-worker-${name}`, mode: "confirm", workspace, workspaceIdentity: { dev, ino }, grantedPaths: [] };
    return { directory, workspace, claims, ref, spec, workspacePayload: { path: workspace, dev, ino } };
  };
  const finish = async (f, prepared, name) => {
    const stopped = await stopLinuxExecution(f.claims, f.ref);
    assert.equal(stopped.exited, true, `\u6E05\u7406\u524D\u5FC5\u987B\u6838\u5B9E\u539F scope \u5DF2\u505C\u6B62\uFF1A${name}`);
    const again = await stopLinuxExecution(f.claims, f.ref);
    assert.equal(again.exited, true, "\u91CD\u590D\u505C\u6B62\u5E94\u4FDD\u6301\u5DF2\u6838\u5B9E");
    await assert.rejects(launchLinuxExecution(f.claims, f.ref, prepared, f.spec), { code: "execution_claim_failed" });
    const claimDir = path5.join(f.claims, f.ref.executionId);
    const observed = fs5.existsSync(path5.join(claimDir, "observation.json")) ? JSON.parse(fs5.readFileSync(path5.join(claimDir, "observation.json"), "utf8")) : null;
    write(path5.join(evidence, `${name}-stop.json`), { ref: f.ref, observation: observed, stopped, repeated: again, sameRefRejected: true, tempDir: prepared.tempDir });
    fs5.rmSync(prepared.tempDir, { recursive: true, force: true });
    fs5.rmSync(f.directory, { recursive: true, force: true });
  };
  const run = async (name, command2, verify) => {
    const f = fixture(name);
    const prepared = await prepareNativeLaunch({ workerPath, dependencyRoots: [], protectedRoots: [codeRoot, f.claims] }, f.spec);
    assert.ok(!prepared.runtimeReadRoots.some((root) => root.includes("node_modules")));
    assert.ok(!prepared.runtimeReadRoots.includes(codeRoot));
    write(path5.join(evidence, `${name}-input.json`), { command: command2, spec: f.spec, prepared, payload: { command: command2, workspace: f.workspacePayload } });
    try {
      const unit = await launchLinuxExecution(f.claims, f.ref, prepared, f.spec);
      const collected = attach(unit);
      unit.stdin.end(JSON.stringify({ command: command2, workspace: f.workspacePayload }));
      const result = await collected.completion;
      verify(result, f);
      results.push({
        name,
        scope: unit.entry.id,
        code: result.code,
        signal: result.signal,
        stdoutBytes: result.stdout.length,
        stdoutSha256: sha(result.stdout),
        stderrBytes: result.stderr.length,
        stderrSha256: sha(result.stderr),
        stdoutUtf8: result.stdout.length < 1e3 ? result.stdout.toString("utf8") : void 0,
        stderrUtf8: result.stderr.length < 1e3 ? result.stderr.toString("utf8") : void 0
      });
    } finally {
      await finish(f, prepared, name);
    }
  };
  try {
    await run("immediate", "exit 0", (result) => {
      assert.equal(result.code, 0);
      assert.equal(result.stdout.length, 0);
      assert.equal(result.stderr.length, 0);
    });
    await run("binary-nonzero", "printf '\\000\\377A'; printf '\\200\\000Z' >&2; exit 37", (result) => {
      assert.equal(result.code, 37);
      assert.deepEqual(result.stdout, Buffer.from([0, 255, 65]));
      assert.deepEqual(result.stderr, Buffer.from([128, 0, 90]));
    });
    await run("signal", "kill -TERM $$", (result) => {
      assert.equal(result.code, 143);
    });
    await run("large-output", "python3 -I -c 'import os; os.write(1,bytes(range(256))*8192); os.write(2,bytes(reversed(range(256)))*4096)'", (result) => {
      assert.equal(result.code, 0);
      assert.deepEqual(result.stdout, Buffer.concat(Array(8192).fill(Buffer.from(Array.from({ length: 256 }, (_, i) => i)))));
      assert.deepEqual(result.stderr, Buffer.concat(Array(4096).fill(Buffer.from(Array.from({ length: 256 }, (_, i) => 255 - i)))));
    });
    const outside = path5.join(base, "unauthorized-fixture.txt");
    const secret = "synthetic-unauthorized-" + randomBytes2(12).toString("hex");
    fs5.writeFileSync(outside, secret, { mode: 384 });
    const server = net.createServer((socket) => socket.end("host-positive-control"));
    await new Promise((resolve3) => server.listen(0, "127.0.0.1", resolve3));
    const port = server.address().port;
    const positive = await new Promise((resolve3, reject) => {
      const socket = net.connect(port, "127.0.0.1");
      let content = "";
      socket.on("data", (bytes) => {
        content += bytes;
      });
      socket.on("error", reject);
      socket.on("end", () => resolve3(content));
    });
    assert.equal(positive, "host-positive-control");
    try {
      const python = `import json,socket,os
r={}
for op in ['read','write']:
 try:
  f=open(${JSON.stringify(outside)},'r' if op=='read' else 'w');f.close();r[op]='unexpected-success'
 except OSError as e:r[op]=e.errno
try:
 s=socket.socket(socket.AF_INET,socket.SOCK_STREAM);s.connect(('127.0.0.1',${port}));r['network']='unexpected-success'
except OSError as e:r['network']=e.errno
print(json.dumps(r,sort_keys=True))
`;
      await run("restricted", `python3 -I -c ${quote(python)}`, (result) => {
        assert.equal(result.code, 0);
        const report = JSON.parse(result.stdout.toString("utf8"));
        assert.ok(Number.isInteger(report.read));
        assert.ok(Number.isInteger(report.write));
        assert.equal(report.network, 1);
        assert.equal(fs5.readFileSync(outside, "utf8"), secret);
        assert.ok(!result.stdout.includes(Buffer.from(secret)));
      });
      write(path5.join(evidence, "restricted-positive-control.json"), { hostFileAccessible: fs5.readFileSync(outside, "utf8") === secret, hostNetworkConnected: positive, fixtureContentSha256: sha(secret), networkAddress: "127.0.0.1", port });
    } finally {
      server.close();
      fs5.rmSync(outside);
    }
    for (const crash of [false, true]) {
      const name = crash ? "descendant-owner-sigkill" : "descendant-owner-live";
      const f = fixture(name), heart = path5.join(f.workspace, "heart"), identity = path5.join(f.workspace, "child-identity.json");
      const python = `import os,time,json
os.setsid()
open(${JSON.stringify(identity)},'w').write(json.dumps({'pid':os.getpid(),'ppid':os.getppid(),'pgid':os.getpgid(0),'sid':os.getsid(0)}))
f=open(${JSON.stringify(heart)},'a',buffering=1)
while True:
 f.write('tick\\n');time.sleep(.02)
`;
      const command2 = `python3 -I -c ${quote(python)} & wait`;
      write(path5.join(f.directory, "input.json"), { ...f, command: command2, payload: { command: command2, workspace: f.workspacePayload } });
      write(path5.join(evidence, `${name}-input.json`), { command: command2, ref: f.ref, spec: f.spec, payload: { command: command2, workspace: f.workspacePayload } });
      const owner = spawn2(process.execPath, [self, "owner", base, f.directory], { stdio: ["ignore", "pipe", "pipe"] });
      let errorText = "";
      owner.stderr.on("data", (bytes) => {
        errorText += bytes;
      });
      owner.stdout.resume();
      const ownerExit = new Promise((resolve3) => owner.once("exit", (code, signal) => resolve3({ code, signal })));
      let prepared;
      try {
        await waitFor(() => fs5.existsSync(path5.join(f.directory, "ready.json")) || owner.exitCode !== null, "owner ready");
        assert.ok(fs5.existsSync(path5.join(f.directory, "ready.json")), errorText);
        prepared = JSON.parse(fs5.readFileSync(path5.join(f.directory, "prepared.json"), "utf8"));
        await waitFor(() => fs5.existsSync(heart) && fs5.statSync(heart).size > 20 && fs5.existsSync(identity), "setsid \u5FC3\u8DF3");
        const child = JSON.parse(fs5.readFileSync(identity, "utf8"));
        assert.equal(child.sid, child.pid);
        assert.equal(child.pgid, child.pid);
        const ready = JSON.parse(fs5.readFileSync(path5.join(f.directory, "ready.json"), "utf8"));
        const observation2 = JSON.parse(fs5.readFileSync(path5.join(f.claims, f.ref.executionId, "observation.json"), "utf8"));
        assert.ok(fs5.readFileSync(path5.join(observation2.group, "cgroup.events"), "utf8").includes("populated 1"));
        if (crash) {
          owner.kill("SIGKILL");
          assert.deepEqual(await ownerExit, { code: null, signal: "SIGKILL" });
        }
        const stopped = await stopLinuxExecution(f.claims, f.ref);
        assert.equal(stopped.exited, true, JSON.stringify({ stopped, errorText }));
        const size = fs5.statSync(heart).size;
        await sleep(250);
        assert.equal(fs5.statSync(heart).size, size, "\u539F\u5F15\u7528\u505C\u6B62\u540E setsid \u5FC3\u8DF3\u987B\u51BB\u7ED3");
        results.push({
          name,
          ref: f.ref,
          scope: ready.scope,
          owner: ready.owner,
          ownerKilledBeforeStop: crash,
          child,
          observation: observation2,
          stopped,
          heartbeatBytes: size,
          heartbeatFrozenForMs: 250,
          ownerErrors: errorText
        });
      } finally {
        owner.kill("SIGKILL");
        await ownerExit;
        prepared ??= JSON.parse(fs5.readFileSync(path5.join(f.directory, "prepared.json"), "utf8"));
        await finish(f, prepared, name);
      }
    }
    write(path5.join(evidence, "summary.json"), {
      passed: true,
      results,
      cleaned: true,
      effectReceiptClaimed: false,
      limitations: ["\u672A\u6267\u884C durable \u547D\u4EE4\u4E1A\u52A1\u94FE\u3001\u5B8C\u5168\u8BBF\u95EE\u3001MCP\u3001\u771F\u5B9E\u6A21\u578B\u6216 IM", "\u672A\u8FD0\u884C Linux \u5168\u4EA7\u54C1\u6784\u5EFA\u6216\u5168\u91CF\u6D4B\u8BD5\uFF1B\u672C\u63A2\u9488\u4F7F\u7528\u7EAF Node bundle \u548C\u5DF2\u6784\u5EFA\u7684\u81EA\u5305\u542B worker"]
    });
    fs5.rmdirSync(fixtureRoot);
    write(path5.join(evidence, "cleanup.json"), { fixturesRemoved: !fs5.existsSync(fixtureRoot), temporaryNativeDirs: "\u6BCF\u9879\u4EC5\u5728\u539F\u5F15\u7528\u505C\u6B62\u8BC1\u660E\u4E3A true \u540E\u5220\u9664", remainingCaseDirectories: [] });
    process.stdout.write(JSON.stringify({ passed: true, cases: results.length, evidence, cleaned: true }) + "\n");
  } catch (error) {
    write(path5.join(evidence, "failure.json"), { message: error.message, stack: error.stack, results, remainingCaseDirectories: fs5.existsSync(fixtureRoot) ? fs5.readdirSync(fixtureRoot) : [] });
    throw error;
  }
}
