/** 原生真实 worker 与正式按需后台；模型为模拟，文件、OS 拒绝和停止均真实。 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createLauncherFor, ExecutionError, type LaunchSpec } from "@ruukoto/agent/execution/launchers.ts";
import { ToolWorkerHost } from "@ruukoto/agent/tool-worker/host.ts";
import { ensureBackend } from "@ruukoto/control/ensure-backend.ts";
import { ControlClient } from "@ruukoto/control/client.ts";
import { probeLockHolder } from "@ruukoto/core/instance-lock.ts";
import { MockModelServer } from "../../test/helpers/mock-provider.ts";
import { authenticateClient, createProjectSession, taskStatus, waitFor, writeModelsJson } from "../../test/helpers/testkit.ts";
import { requireNoArgs } from "./gate.ts";

requireNoArgs();

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-worker-smoke-")));
const workspace = path.join(root, "work"), owner = path.join(root, "owner"), ro = path.join(root, "ro"), rw = path.join(root, "rw");
for (const dir of [workspace, owner, ro, rw]) fs.mkdirSync(dir);
for (const dir of [owner, ro, rw]) fs.writeFileSync(path.join(dir, "material"), "virtual-material\n");
fs.symlinkSync(path.join(owner, "material"), path.join(workspace, "escape"));
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const protectedRoots = [owner, repo];
const hosts: ToolWorkerHost[] = [];
const checks: string[] = [];
let safeCleanup = true, client: ControlClient | null = null;
const dirs = { root, dataDir: path.join(root, "data"), agentDir: path.join(root, "agent") };
const controlDir = path.join(root, "control");
let backendAttempted = false, backendStopped = false;
const record = (name: string): void => { checks.push(name); process.stderr.write(`[ruukoto:native-smoke] PASS ${name}\n`); };
const quote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'";
const nodeCommand = (source: string): string => `node -e ${quote(source)}`;
const textOf = (value: { content: unknown[] }): string => value.content.map(block => {
  return typeof block === "object" && block !== null && "text" in block && typeof block.text === "string" ? block.text : "";
}).join("\n");
let sequence = 0;
const spec = (extra: Partial<LaunchSpec> = {}): LaunchSpec => {
  const stat = fs.statSync(workspace);
  return { taskId: `native-smoke-${process.pid}-${++sequence}`, mode: "confirm", workspace,
    workspaceIdentity: { dev: stat.dev, ino: stat.ino }, grantedPaths: [], ...extra };
};
async function start(extra: Partial<LaunchSpec> = {}): Promise<ToolWorkerHost> {
  const host = ToolWorkerHost.create(createLauncherFor({ backend: "native", native: { protectedRoots } }, "confirm"), spec(extra));
  hosts.push(host); await host.start(); return host;
}
const call = (host: ToolWorkerHost, name: string, params: Record<string, unknown>) => host.call({
  opId: `op_${++sequence}`, sdkCallId: `sdk_${sequence}`, name, params, timeoutMs: 15_000,
});
async function stop(host: ToolWorkerHost): Promise<void> {
  const reaped = await host.stop(); safeCleanup &&= reaped;
  assert.equal(reaped, true, "原生整单元退出必须已核实");
}
async function stopBackend(): Promise<void> {
  if (!backendAttempted || backendStopped) return;
  if (!client) {
    client = await ControlClient.connect(path.join(controlDir, "control.sock"), 3000);
    await authenticateClient(client, controlDir);
  }
  const holder = probeLockHolder(path.join(dirs.dataDir, "runtime.lock"));
  assert.ok(holder.held && !holder.unverifiable && holder.pid, "停止前须核实实际后台身份");
  const pid = holder.pid;
  await client.request("stop"); client.close(); client = null;
  await waitFor("后台退出而非仅应答停止请求", () => {
    let exited = false;
    try { process.kill(pid, 0); }
    catch (error) { exited = (error as NodeJS.ErrnoException).code === "ESRCH"; }
    return exited && !fs.existsSync(path.join(controlDir, "control.sock")) &&
      !probeLockHolder(path.join(dirs.dataDir, "runtime.lock")).held;
  }, 20_000);
  const audit = new DatabaseSync(path.join(dirs.dataDir, "ruukoto.db"), { readOnly: true });
  try {
    assert.equal(audit.prepare("SELECT COUNT(*) AS count FROM occupancy").get()!.count, 0, "后台停止后未核实占用不能清理");
    assert.equal(audit.prepare("SELECT COUNT(*) AS count FROM events WHERE json_extract(body, '$.type') = 'task.tool_process_unreaped'").get()!.count, 0);
  } finally { audit.close(); }
  backendStopped = true;
}
const listener = net.createServer(socket => socket.end());
const socketListener = net.createServer(socket => socket.end());
const fakeFd = fs.openSync(path.join(owner, "material"), "r");
const fakeStat = fs.fstatSync(fakeFd);
const priorToken = process.env.RUUKOTO_VIRTUAL_OWNER_TOKEN;
process.env.RUUKOTO_VIRTUAL_OWNER_TOKEN = "virtual-token";
const model = new MockModelServer(req => {
  const done = req.messages.filter(message => message.role === "tool").length;
  if (done === 0) return { kind: "tool_calls", calls: [{ id: "product-read", name: "read", arguments: { path: "answer.txt" } }] };
  if (done === 1) return { kind: "tool_calls", calls: [{ id: "product-edit", name: "edit", arguments: { path: "answer.txt", edits: [{ oldText: "41", newText: "42" }] } }] };
  if (done === 2) return { kind: "tool_calls", calls: [{ id: "product-write", name: "write", arguments: { path: "result.txt", content: "checked\n" } }] };
  if (done === 3) return { kind: "tool_calls", calls: [{ id: "product-bash", name: "bash", arguments: { command: "grep -qx 42 answer.txt && grep -qx checked result.txt && node --version && git --version && python3 --version" } }] };
  return { kind: "text", text: "完成真实修改与检查" };
});
try {
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  await new Promise<void>(resolve => socketListener.listen(path.join(workspace, "control.sock"), resolve));
  const address = listener.address(); assert.ok(address && typeof address !== "string");
  const host = await start();
  assert.equal((await call(host, "write", { path: "answer.txt", content: "41\n" })).isError, false);
  assert.match(textOf(await call(host, "read", { path: "answer.txt" })), /41/);
  assert.equal((await call(host, "edit", { path: "answer.txt", edits: [{ oldText: "41", newText: "42" }] })).isError, false);
  assert.equal((await call(host, "bash", { command: "grep -qx 42 answer.txt && node --version && git --version && python3 --version && printf 'int main(void){return 0;}' > check.c && cc check.c -o check && ./check" })).isError, false);
  record("read/edit/write/bash、宿主 Node/Git/Python 与真实 C 编译检查");
  for (const target of [path.join(owner, "material"), path.join(workspace, "escape")]) {
    assert.equal((await call(host, "read", { path: target })).isError, true);
    assert.equal((await call(host, "write", { path: target, content: "forbidden" })).isError, true);
    for (const operation of ["readFileSync", "writeFileSync"]) {
      const source = `process.stdout.write('started\\n');try{require('node:fs').${operation}(${JSON.stringify(target)}${operation === "writeFileSync" ? ",'forbidden'" : ""});process.exit(0)}catch(e){process.stdout.write('denied:'+e.code);process.exit(1)}`;
      const result = await call(host, "bash", { command: nodeCommand(source) });
      assert.equal(result.isError, true); assert.match(textOf(result), /started[\s\S]*denied:(EPERM|EACCES|ENOENT|EROFS)/);
    }
  }
  assert.equal(fs.readFileSync(path.join(owner, "material"), "utf8"), "virtual-material\n");
  record("未授权文件、符号链接与控制材料拒绝，虚拟内容未变化");
  const tcp = `process.stdout.write('started\\n');require('node:net').connect(${address.port},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',e=>{process.stdout.write('denied:'+e.code);process.exit(1)})`;
  const unix = `process.stdout.write('started\\n');require('node:net').connect(${JSON.stringify(path.join(workspace, "control.sock"))}).on('connect',()=>process.exit(0)).on('error',e=>{process.stdout.write('denied:'+e.code);process.exit(1)})`;
  // 宿主成功对照使用本轮自建服务，不依赖互联网。
  for (const endpoint of [address.port, path.join(workspace, "control.sock")]) await new Promise<void>((resolve, reject) => {
    const socket = typeof endpoint === "number" ? net.connect(endpoint, "127.0.0.1") : net.connect(endpoint);
    socket.on("connect", () => { socket.destroy(); resolve(); }); socket.on("error", reject);
  });
  for (const source of [tcp, unix]) {
    const result = await call(host, "bash", { command: nodeCommand(source) });
    assert.equal(result.isError, true); assert.match(textOf(result), /started[\s\S]*denied:(EPERM|EACCES)/);
  }
  record("有效宿主对照下回环 TCP 与授权目录 Unix socket 均拒绝");
  const environment = `const fs=require('node:fs');if(process.env.RUUKOTO_VIRTUAL_OWNER_TOKEN||process.env.SSH_AUTH_SOCK||process.env.HOME===${JSON.stringify(os.homedir())})process.exit(1);for(let fd=3;fd<64;fd++){try{const s=fs.fstatSync(fd);if(s.dev===${fakeStat.dev}&&s.ino===${fakeStat.ino})process.exit(2)}catch{}}process.stdout.write(process.env.TMPDIR)`;
  const clean = await call(host, "bash", { command: nodeCommand(environment) }); assert.equal(clean.isError, false);
  const privateTmp = textOf(clean).trim(); assert.ok(privateTmp.includes("ruukoto-native-"));
  record("独立 HOME/TMPDIR、凭据环境与敏感 FD 不继承");
  const other = await start();
  assert.equal((await call(other, "read", { path: path.join(privateTmp, "../home") })).isError, true);
  await stop(other); await stop(host);
  const granted = await start({ grantedPaths: [{ path: ro, access: "read", purpose: "只读资料" }, { path: rw, access: "read_write", purpose: "可写资料" }] });
  assert.equal((await call(granted, "read", { path: path.join(ro, "material") })).isError, false);
  assert.equal((await call(granted, "write", { path: path.join(ro, "material"), content: "no" })).isError, true);
  assert.equal((await call(granted, "write", { path: path.join(rw, "material"), content: "authorized" })).isError, false);
  await stop(granted);
  const narrowed = await start();
  assert.equal((await call(narrowed, "read", { path: path.join(rw, "material") })).isError, true);
  await stop(narrowed); record("额外只读/读写授予与收窄后的原生重建，单元临时资料互不可见");
  const running = await start();
  const heartbeat = path.join(workspace, "heartbeat");
  const pending = call(running, "bash", { command: `${nodeCommand(`process.on('SIGTERM',()=>{});setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(heartbeat)},'h'),20)`)} & sleep 30` }).catch(() => null);
  await waitFor("真实后代心跳", () => fs.existsSync(heartbeat) && fs.statSync(heartbeat).size > 5, 10_000);
  await stop(running); await pending;
  const size = fs.statSync(heartbeat).size;
  await new Promise(resolve => setTimeout(resolve, 300)); assert.equal(fs.statSync(heartbeat).size, size);
  record("忽略信号的后台后代停止，实际心跳冻结且重复停止结论保留");
  const launcher = createLauncherFor({ backend: "native", native: { protectedRoots } }, "confirm");
  let created!: () => void, release!: () => void;
  const actualCreated = new Promise<void>(resolve => { created = resolve; });
  const handoff = new Promise<void>(resolve => { release = resolve; });
  let actualId = "";
  const starting = ToolWorkerHost.create({ kind: "native", async launch(input) {
    const unit = await launcher.launch(input); actualId = unit.entry.id; created();
    await handoff; return unit;
  } }, spec());
  hosts.push(starting); const startPromise = starting.start().catch(() => null);
  await Promise.race([actualCreated, startPromise.then(() => { throw new Error("原生单元未创建，启动窗口不可验证"); })]);
  assert.ok(actualId, "真实单元已创建，延迟的只是宿主接手");
  const cancel = starting.stop(); release();
  const reaped = await cancel; safeCleanup &&= reaped; assert.equal(reaped, true);
  await startPromise; record("真实单元创建后、宿主接手前取消并核实回收");
  const changed = await start();
  const original = path.join(root, "original-work");
  fs.renameSync(workspace, original); fs.mkdirSync(workspace);
  try {
    await assert.rejects(call(changed, "write", { path: "forbidden.txt", content: "no" }),
      error => error instanceof ExecutionError && error.code === "execution_unavailable");
    assert.equal(fs.existsSync(path.join(workspace, "forbidden.txt")), false);
    await stop(changed);
  } finally { fs.rmSync(workspace, { recursive: true }); fs.renameSync(original, workspace); }
  const grantChanged = await start({ grantedPaths: [{ path: rw, access: "read_write", purpose: "可写资料" }] });
  const originalGrant = path.join(root, "original-rw");
  fs.renameSync(rw, originalGrant); fs.mkdirSync(rw);
  try {
    await assert.rejects(call(grantChanged, "write", { path: path.join(rw, "forbidden.txt"), content: "no" }),
      error => error instanceof ExecutionError && error.code === "execution_unavailable");
    assert.equal(fs.existsSync(path.join(rw, "forbidden.txt")), false);
    await stop(grantChanged);
  } finally { fs.rmSync(rw, { recursive: true }); fs.renameSync(originalGrant, rw); }
  record("活跃工作区与读写授予目录被替换后停止且不写入新对象");

  const hardlink = path.join(workspace, "outside-alias");
  fs.linkSync(path.join(ro, "material"), hardlink);
  try {
    await assert.rejects(start({ grantedPaths: [{ path: ro, access: "read", purpose: "只读资料" }] }),
      error => error instanceof ExecutionError && error.code === "execution_unavailable" && error.reason === "sandbox_rejected");
    assert.equal(fs.readFileSync(path.join(ro, "material"), "utf8"), "virtual-material\n");
  } finally { fs.unlinkSync(hardlink); }
  const aliased = await start();
  fs.linkSync(path.join(owner, "material"), hardlink);
  try {
    await assert.rejects(call(aliased, "write", { path: hardlink, content: "forbidden" }),
      error => error instanceof ExecutionError && error.code === "execution_unavailable");
    assert.equal(fs.readFileSync(path.join(owner, "material"), "utf8"), "virtual-material\n");
    await stop(aliased);
    if (process.platform === "darwin") {
      for (const alias of ["/System/Volumes/Data" + workspace, "/System/Volumes/Data" + hardlink, path.join(workspace, "OUTSIDE-ALIAS")]) {
        if (!fs.existsSync(alias)) continue;
        await assert.rejects(start({ grantedPaths: [{ path: alias, access: "read_write", purpose: "同一目录条目别名" }] }),
          error => error instanceof ExecutionError && error.code === "execution_unavailable" && error.reason === "sandbox_rejected");
      }
    }
  } finally { fs.unlinkSync(hardlink); }
  record("预存只读硬链接在启动前拒绝，活跃单元新增未授权别名时停止且资料未改写");

  fs.mkdirSync(dirs.dataDir); fs.mkdirSync(dirs.agentDir);
  await writeModelsJson(dirs, await model.start());
  fs.writeFileSync(path.join(workspace, "answer.txt"), "41\n");
  backendAttempted = true;
  const ensured = await ensureBackend({ ...dirs, controlDir,
    spawnArgv: [path.join(repo, "apps/ruukoto-code/bin/ruukoto-code.mjs"), "server", "--data-dir", dirs.dataDir, "--agent-dir", dirs.agentDir],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, RUUKOTO_CODE_CONTROL_DIR: controlDir,
      RUUKOTO_DOCKER_PATH: "/no-docker-for-native-proof" } });
  assert.equal(ensured.ok, true, ensured.ok ? "" : ensured.error);
  assert.equal(ensured.spawned, true);
  client = await ControlClient.connect(path.join(controlDir, "control.sock"), 3000);
  await authenticateClient(client, controlDir);
  assert.equal((await client.handshake()).snapshot.execution.backend, "native");
  const { sessionId } = await createProjectSession(client, workspace);
  const task = await client.request<{ id: string }>("submit", { session_id: sessionId, request_id: "native-product",
    input: "修改并检查", access_mode: "confirm", model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" } });
  await waitFor("按需后台真实原生工具任务", async () => ["completed", "failed"].includes((await taskStatus(client!, task.id)).task.status), 60_000);
  const detail = await taskStatus(client, task.id);
  assert.equal(detail.task.status, "completed", JSON.stringify(detail.task));
  assert.equal(detail.toolOps.length, 4); assert.ok(detail.toolOps.every((op: { isError: boolean }) => !op.isError));
  assert.equal(fs.readFileSync(path.join(workspace, "answer.txt"), "utf8"), "42\n");
  await stopBackend();
  record("Docker 入口不可用时正式产品默认 native，按需后台完成四工具修改与检查");
  process.stdout.write(JSON.stringify({ platform: os.platform(), release: os.release(), arch: os.arch(), checks, pass: true, models: "mock", execution: "native" }, null, 2) + "\n");
} catch (error) {
  process.stderr.write(`[ruukoto:native-smoke] FAIL ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = error instanceof ExecutionError && error.code === "execution_unavailable" ? 2 : 1;
} finally {
  for (const host of hosts) {
    const reaped = await host.stop();
    safeCleanup &&= reaped;
  }
  if (backendAttempted && !backendStopped) {
    try { await stopBackend(); }
    catch (error) {
      safeCleanup = false;
      process.stderr.write(`[ruukoto:native-smoke] 后台退出未核实：${error instanceof Error ? error.message : String(error)}\n`);
      client?.close();
    }
  }
  await model.close();
  listener.close(); socketListener.close(); fs.closeSync(fakeFd);
  if (priorToken === undefined) delete process.env.RUUKOTO_VIRTUAL_OWNER_TOKEN; else process.env.RUUKOTO_VIRTUAL_OWNER_TOKEN = priorToken;
  if (safeCleanup) fs.rmSync(root, { recursive: true, force: true });
  else { process.stderr.write(`[ruukoto:native-smoke] 退出未核实，保留虚拟现场：${root}\n`); process.exitCode = 1; }
}
