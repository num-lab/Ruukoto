import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { test, type TestContext } from "node:test";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import { getBackgroundProcess, handoffBackgroundProcess, listActiveBackgroundProcesses, registerBackgroundProcess } from "@ruukoto/core/background-processes.ts";
import { RuntimeBackgroundProcesses } from "@ruukoto/runtime/background-processes.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { createBackgroundProcessFamily } from "@ruukoto/agent/background-process-tools.ts";
import { product } from "../apps/ruukoto-code/src/product.ts";
import { previewLegacyImport } from "../apps/ruukoto-code/src/legacy-import.ts";
import { waitFor } from "./helpers/testkit.ts";

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "background-failure-"))), dataDir = path.join(root, "data"), work = path.join(root, "work");
  fs.mkdirSync(dataDir); fs.mkdirSync(work);
  const db = new Db(dataDir), store = new Store(db), stat = fs.statSync(work);
  const project = store.withTx(() => store.createProject("background-failure"));
  const session = store.withTx(() => store.createSession({ projectId: project.id, cwd: work, cwdReal: work, cwdDev: stat.dev, cwdIno: stat.ino, piSessionId: "test", confirmTools: [] }));
  const task = store.withTx(() => {
    const task = store.insertQueuedTask({ sessionId: session.id, requestId: "start", input: "启动", submissionDigest: "start", accessMode: "full_access", modelSelection: null }).task;
    store.transitionTask(task.id, ["queued"], "running");
    store.tryAcquireOccupancy({ cwdReal: work, cwdDev: stat.dev, cwdIno: stat.ino, sessionId: session.id, taskId: task.id });
    store.recordToolIntent({ id: "op-start", taskId: task.id, sessionId: session.id, toolName: "process_start", params: { command: "printf must-not-replay" } });
    return store.getTask(task.id)!;
  });
  const ctx = { taskId: task.id, sessionId: session.id, projectId: project.id, hostOpId: "op-start" };
  const workspace = { path: work, dev: stat.dev, ino: stat.ino };
  const register = () => store.withTx(() => registerBackgroundProcess(store, { ...ctx, workspace, ref: { platform: process.platform === "linux" ? "linux" : "darwin", executionId: "native_" + "1".repeat(24), ...(process.platform === "linux" ? { machineId: fs.readFileSync("/etc/machine-id", "utf8").trim() } : {}) } }));
  const manager = new RuntimeBackgroundProcesses({ store, dataDir, handoff: async () => true, restore: async () => false, released: () => {}, sourceProblem: () => null });
  t.after(async () => { await manager.shutdown(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, dataDir, work, db, store, session, task, ctx, workspace, register, manager };
}

test("日志合计预算保留16MiB原始字节与partial，证据篡改拒绝读取", async t => {
  const f = fixture(t), record = f.register();
  f.manager["capture"](record);
  const bytes = Buffer.alloc(16 * 1024 * 1024 + 5, 0xff);
  f.manager["output"](record.id, "stdout", bytes);
  await waitFor("输出预算停止核实", () => getBackgroundProcess(f.store, record.id)!.state === "stopped");
  const current = getBackgroundProcess(f.store, record.id)!;
  assert.equal(current.stdoutBytes, 16 * 1024 * 1024); assert.equal(current.partial, true); assert.equal(current.reason, "output_limit");
  const page = f.manager.read({ sessionId: f.session.id, processId: record.id, stream: "stdout" });
  assert.equal(Buffer.from(page.base64, "base64").length, 32 * 1024); assert.equal(page.nextOffset, 32 * 1024);
  assert.equal(page.text.includes("�"), true, "展示解码允许替换字符，base64才是原始字节");
  fs.writeFileSync(path.join(f.dataDir, "background-logs", record.id, "stdout"), Buffer.alloc(16 * 1024 * 1024, 0));
  assert.throws(() => f.manager.read({ sessionId: f.session.id, processId: record.id, stream: "stdout" }), { code: "background_evidence_invalid" });
});

test("日志短写后磁盘失败保存已写字节并请求停止，不把失败吞成完整日志", async t => {
  const f = fixture(t), record = f.register(), capture = f.manager["capture"](record);
  const original = fs.writeSync;
  let writes = 0;
  t.mock.method(fs, "writeSync", (fd: number, bytes: Buffer, offset: number, length: number) => {
    if (fd !== capture.stdout) return original(fd, bytes, offset, length);
    if (writes++ === 0) return original(fd, bytes, offset, 3);
    throw Object.assign(new Error("模拟磁盘写入失败"), { code: "EIO" });
  });
  syncBuiltinESMExports();
  f.manager["output"](record.id, "stdout", Buffer.from("abcdef"));
  t.mock.restoreAll();
  syncBuiltinESMExports();
  await waitFor("磁盘失败停止已登记", () => getBackgroundProcess(f.store, record.id)!.state === "stopped");
  const current = getBackgroundProcess(f.store, record.id)!;
  assert.equal(current.partial, true); assert.equal(current.stdoutBytes, 3); assert.equal(current.reason, "log_write_failed");
  assert.equal(f.manager.read({ sessionId: f.session.id, processId: record.id, stream: "stdout" }).text, "abc");
});

test("已接纳启动与关闭竞争，屏障阻止迟到交接，原Task占用保留且命令未派发", async t => {
  const f = fixture(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.manager["deps"].handoff = async (_id, transfer) => {
    await gate;
    transfer({ taskId: f.task.id, permissionVersion: f.task.permissionVersion, selectionRecordId: null, promptArtifactId: null, instructions: null, skills: null });
    return true;
  };
  const starting = f.manager.start(f.ctx, "printf must-not-replay");
  const rejection = assert.rejects(starting, { code: "background_closed" });
  const closing = f.manager.closeSession(f.session.id, "close");
  release();
  await rejection;
  assert.equal((await closing).stopVerified, true);
  assert.equal(f.store.getOccupancyByDir(f.work)?.taskId, f.task.id);
  assert.equal(fs.readdirSync(path.join(f.dataDir, "background-executions")).length, 0);
});

test("恢复只结束未认领启动，工具账本区分尚未派发和停止意图接纳，离线导入拒绝后台记录", async t => {
  const f = fixture(t), record = f.register(), check = createBackgroundProcessFamily(f.store).ledger!.familyCheck!;
  assert.equal(check.verify(f.store.getToolOp("op-start")!), "not_committed");
  await f.manager.recover();
  assert.equal(getBackgroundProcess(f.store, record.id)!.state, "stopped");
  assert.equal(fs.readdirSync(path.join(f.dataDir, "background-executions")).length, 0);
  f.store.withTx(() => f.store.recordToolIntent({ id: "stop", taskId: f.task.id, sessionId: f.session.id, toolName: "process_stop", params: { process_id: record.id } }));
  assert.equal(check.verify(f.store.getToolOp("stop")!), "committed");
  f.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  assert.throws(() => previewLegacyImport({ targetDataDir: path.join(f.root, "target"), targetAgentDir: path.join(f.root, "agent") }, { from: f.dataDir }), { code: "background_processes_import_unavailable" });
});

test("宿主强杀后冷恢复核实原后台、释放占用但零重放命令", async () => {
  const fixturePath = path.resolve("test/helpers/background-crash.mts");
  const child = spawn(process.execPath, ["--import", "tsx", fixturePath], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.on("data", bytes => { output += bytes.toString(); });
  child.stderr.on("data", bytes => { errors += bytes.toString(); });
  let runtime: Runtime | undefined;
  let root: string | undefined;
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  try {
    await waitFor("独立后台启动并交接", () => output.includes("\n"), 30_000);
    const info = JSON.parse(output.slice(0, output.indexOf("\n"))) as { root: string; dataDir: string; agentDir: string; work: string; processId: string };
    root = info.root;
    child.kill("SIGKILL"); await exited;
    runtime = await Runtime.start({ product: product.runtime, dataDir: info.dataDir, agentDir: info.agentDir, socketPath: path.join(info.root, "r.sock"), modelProvider: "mock", modelId: "mock-model", thinkingLevel: "off" });
    const record = getBackgroundProcess(runtime.store, info.processId)!;
    assert.equal(record.state, "stopped", JSON.stringify(record) + errors);
    assert.equal(record.partial, true, "宿主崩溃没有完整输出流证据，保留partial");
    assert.equal(runtime.store.listAllOccupancy().length, 0);
    assert.equal(fs.readFileSync(path.join(info.work, "launches"), "utf8"), "x");
    assert.equal(listActiveBackgroundProcesses(runtime.store).length, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    await runtime?.stop("test_end");
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});
