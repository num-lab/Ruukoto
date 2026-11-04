import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, defineEntry } from "@earendil-works/pi-durable";
import { openPersonalFileIo, closePersonalFileIoNamespace, sealPersonalFileIoSessionClosed, personalFileIoJobs, personalFileJobStopped, personalFileIoJobLive, personalFileIoLiveJobs, personalFileIoSourceBlocker, personalFileIoWorkBlocker, personalFileIoPersistenceFailed, verifyPersonalFileIo, verifyPersonalFileIoStorage, createPersonalFileIoRecorder, PersonalFileIoDoc, PersonalFileJobDoc, PersonalFileIoLifecycle, PersonalFileIoError, type PersonalFileIo, type PersonalFileIoEvent, type PersonalFileJobContext, type PersonalFileJobMeta } from "../apps/ruukoto/src/personal-file-io.ts";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { personalControl, startPersonalServer } from "../apps/ruukoto/src/personal-control.ts";
import { savePersonalConfig } from "../apps/ruukoto/src/personal-config.ts";
import { savePersonalTools } from "../apps/ruukoto/src/personal-tools-config.ts";
import { acquirePersonalDirectory } from "../apps/ruukoto/src/personal-directory-claims.ts";
import { preparePersonalFile } from "../apps/ruukoto/src/personal-tool-io.ts";
import { parsePersonalTools } from "../apps/ruukoto/src/personal-tools-config.ts";
import { toolOperations, toolResolve, toolDecide, toolVerifyStop, toolDetail, type PersonalToolOperation } from "../apps/ruukoto/src/personal-tools.ts";
import { lockPersonalProfile } from "../apps/ruukoto/src/personal-profile.ts";
import { personalWorkResult } from "../apps/ruukoto/src/personal-work.ts";
import { personalServiceSourceBlocker } from "../apps/ruukoto/src/personal-service-operations.ts";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { restorePersonalFileIoLegacy, type PersonalFileIoLegacyRestore } from "./helpers/personal-file-io-legacy.ts";
import { PersonalMockModelServer as MockModelServer } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;
async function until(check: () => boolean | Promise<boolean>, ms = 10_000) { const end = Date.now() + ms; while (!await check()) { assert.ok(Date.now() < end, "等待文件工作线程结果超时"); await delay(5); } }

test("文件工作线程：读写请求往返返回结果，跨 64KiB 块的内容变化在复核时拒绝", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-file-io-"))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "data.bin");
  const bytes = Buffer.concat([Buffer.alloc(64 * 1024, 1), Buffer.from("尾块内容")]);
  fs.writeFileSync(target, bytes);
  const io = openPersonalFileIo(); t.after(() => io.close());
  const prepared = await io.prepare({ path: target, access: "read", protectedRoots: [] });
  assert.equal(prepared.originalSha256, createHash("sha256").update(bytes).digest("hex"));
  const read = await io.execute(prepared);
  assert.equal(read.code, "file_returned"); assert.deepEqual(read.bytes, bytes); assert.equal(read.partial, false);
  // 尾部块内的字节变化：逐块哈希在第二块上发现差异，执行拒绝且未写入。
  bytes[64 * 1024 + 3] ^= 0xff; fs.writeFileSync(target, bytes);
  const changed = await io.execute(prepared);
  assert.equal(changed.effect, "not_executed"); assert.equal(changed.code, "file_target_changed");
  const written = await io.execute(await io.prepare({ path: target, access: "read_write", content: "覆盖", protectedRoots: [] }));
  assert.equal(written.code, "file_returned"); assert.equal(fs.readFileSync(target, "utf8"), "覆盖");
});

test("文件工作线程：停顿期间主事件循环与无关短提交继续，工作线程丢失不重派写", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-file-io-stall-"))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "data"); fs.writeFileSync(target, "原文");
  const io = openPersonalFileIo({ stallMs: 300 }); t.after(() => io.close());
  let ticked = false;
  const timer = setTimeout(() => { ticked = true; }, 60); t.after(() => clearTimeout(timer));
  const prepared = await io.prepare({ path: target, access: "read", protectedRoots: [] });
  assert.equal(ticked, true);
  // 已退出工作线程：派发立即拒绝，不会悬挂等一个不可能的回复。
  await io.close();
  await assert.rejects(io.prepare({ path: target, access: "read", protectedRoots: [] }), code("file_io_closed"));
  await assert.rejects(io.execute(prepared), code("file_io_closed"));
});

test("文件工作线程：任务中退出记为丢失，缺失入口拒绝启动", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-file-io-crash-"))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const crashing = path.join(root, "crash.mjs");
  fs.writeFileSync(crashing, `import { parentPort } from "node:worker_threads";\nparentPort.on("message", () => process.exit(23));\n`);
  const target = path.join(root, "data"); fs.writeFileSync(target, "x");
  const io = openPersonalFileIo({ script: crashing });
  await assert.rejects(io.prepare({ path: target, access: "read", protectedRoots: [] }), code("file_io_worker_lost"));
  await io.close();
  assert.throws(() => openPersonalFileIo({ script: path.join(root, "missing.mjs") }), code("file_io_worker_unavailable"));
});

test("文件工作线程：宿主写入执行中工作线程丢失保留未知效果与目录占用", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-file-io-"))), directory = path.join(root, "profile"), workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const server = new MockModelServer(request => {
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "tool") return { kind: "text", text: `回执:${content}` };
    if (content.startsWith("tool:")) {
      const { name, args } = JSON.parse(content.slice(5)) as { name: string; args: Record<string, unknown> };
      return { kind: "tool_calls", calls: [{ id: "file-call", name, arguments: args }] };
    }
    return { kind: "text", text: `普通:${content}` };
  });
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await server.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_FILEIO_TEST_KEY", contextWindow: 128000, maxTokens: 8192 };
  const previous = process.env[config.apiKeyEnv]; process.env[config.apiKeyEnv] = "test-only";
  const identity = fs.statSync(workspace), tools = parsePersonalTools({ version: 1, generation: "file-io-test", workspace, identity: { dev: identity.dev, ino: identity.ino }, credentials: [] });
  let p: PersonalHarness | undefined;
  t.after(async () => { await p?.close(); await server.close(); if (previous === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = previous; fs.rmSync(root, { recursive: true, force: true }); });
  const operations = async () => p!.harness.commit(async tx => JSON.parse(JSON.stringify(await toolOperations(tx))) as PersonalToolOperation[], context);
  const mode = async (value: "auto-review" | "confirm" | "full_access") => p!.harness.commit(async tx => { const doc = await tx.doc(PersonalPermissionsDoc); doc.mode = value; doc.version++; }, context);

  // 停顿工作线程执行宿主文件请求：无关 Session 提交与宿主查询在停顿中照常完成，证明慢速准备/执行不占事务。
  // 文件工具只保留在子 Agent：读调用经委派工作驱动。
  const stalled = openPersonalFileIo({ stallMs: 400 });
  p = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, tools, fileIo: stalled });
  await mode("full_access");
  const target = path.join(workspace, "held"); fs.writeFileSync(target, "旧内容");
  await p.answer("读取停顿", "stall-read");
  const readWork = await p.work.delegate({ requestId: "stall-read-work", sourceRequestId: "stall-read", content: `tool:{"name":"read_file","args":{"path":${JSON.stringify(target)}}}` });
  await until(() => operations().then(values => values.length > 0));
  let unrelated = false;
  const commit = p.harness.commit(async tx => { (await tx.doc(PersonalPermissionsDoc)).version++; }, context).then(() => { unrelated = true; });
  assert.ok(Array.isArray(await p.work.list()));
  await until(() => unrelated);
  const observation = (await operations()).at(-1)!;
  assert.equal(observation.kind, "read_file"); assert.equal(observation.observation, undefined);
  await commit;
  await p.harness.waitForTask(readWork.taskId, context);
  assert.match(await p.harness.commit(tx => personalWorkResult(tx, readWork), context).then(value => value.text ?? ""), /file_returned/);
  assert.equal((await operations()).at(-1)!.effect, "returned");
  await p.close(); p = undefined;

  const f2 = fifoFixture(t, "rk-file-io-lost-");
  process.env.RK_FILE_IO_HOLD = target; process.env.RK_FILE_IO_PHASE = "execute"; process.env.RK_FILE_IO_STALL_MS = "30000";
  let aSpawns = 0; const aWorkers = new Map<string, Worker>();
  const realIo = openPersonalFileIo({ profile: fs.realpathSync(directory), script: FIFO_WRAPPER, workerProbe: (worker, meta) => { if ((meta.request as { path?: string }).path === target) { aSpawns++; aWorkers.set(meta.id, worker); if (meta.phase === "execute") void until(() => fs.existsSync(`${f2.marker}.${meta.id}`)).then(() => worker.terminate()).catch(() => undefined); } } });
  t.after(() => realIo.close().catch(() => undefined));
  p = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, tools, fileIo: realIo });
  await p.answer("写入丢失", "lost-write");
  await p.work.delegate({ requestId: "lost-write-work", sourceRequestId: "lost-write", content: `tool:{"name":"write_file","args":{"path":${JSON.stringify(target)},"content":"派发后丢答"}}` });
  await until(async () => { const values = await operations(); return values.some(value => value.kind === "write_file" && value.code === "file_io_worker_lost"); });
  const record = (await operations()).at(-1)!;
  assert.equal(record.kind, "write_file"); assert.equal(record.started, true);
  assert.equal(record.effect, "effect_unknown"); assert.equal(record.code, "file_io_worker_lost");
  assert.equal(record.stopped, true); assert.ok(record.directoryClaim); assert.equal(record.resolution, undefined);
  const aJobs = await p.harness.commit(tx => personalFileIoJobs(tx), context), aJob = aJobs.find(job => job.id === record.fileJob)!;
  const aExit = aWorkers.get(aJob.id)!; await until(() => aExit.threadId < 0);
  await p.answer("B查询", "b-src");
  await p.work.delegate({ requestId: "b-read", sourceRequestId: "b-src", content: `tool:{"name":"read_file","args":{"path":${JSON.stringify(f2.other)}}}` });
  await until(async () => (await operations()).some(value => value.kind === "read_file" && value.observation !== undefined && value.code === "file_returned"));
  await p.answer("B写入", "b-src-2");
  const bTarget = path.join(f2.root, "b"); fs.writeFileSync(bTarget, "旧");
  await p.work.delegate({ requestId: "b-write", sourceRequestId: "b-src-2", content: `tool:{"name":"write_file","args":{"path":${JSON.stringify(bTarget)},"content":"B写入"}}` });
  await until(async () => (await operations()).some(value => value.kind === "write_file" && value.observation !== undefined && value.code === "file_returned"));
  assert.equal(fs.readFileSync(bTarget, "utf8"), "B写入");
  assert.equal(fs.readFileSync(target, "utf8"), "旧内容");
  const stat = fs.statSync(target), retry = (record.operation + 4096) as PersonalToolOperation["operation"];
  await assert.rejects(p.harness.commit(tx => acquirePersonalDirectory(tx, { kind: "file", operation: retry }, { path: target, dev: stat.dev, ino: stat.ino }), context), code("directory_claim_busy"));
  const aSpawnCount = aSpawns, replayed = await p.work.delegate({ requestId: "lost-write-work", sourceRequestId: "lost-write", content: `tool:{"name":"write_file","args":{"path":${JSON.stringify(target)},"content":"派发后丢答"}}` });
  await delay(100);
  assert.equal(aSpawns, aSpawnCount); assert.equal(fs.readFileSync(target, "utf8"), "旧内容"); assert.ok(replayed.taskId > 0);
});

test("文件工作线程：真实 FIFO 持住的准备不饿死无关任务", { timeout: 30_000 }, async t => {
  const f = fifoFixture(t, "rk-file-io-fifo-");
  const io = openPersonalFileIo({ script: FIFO_WRAPPER });
  const heldJob = io.prepare({ path: f.held, access: "read", protectedRoots: [] }); void heldJob.catch(() => undefined);
  t.after(async () => { f.release(1); await heldJob.catch(() => undefined); await io.close().catch(() => undefined); });
  await until(() => fs.existsSync(f.marker));
  const prepared = await io.prepare({ path: f.other, access: "read_write", content: "B写入", protectedRoots: [] });
  const write = await io.execute(prepared);
  assert.equal(write.effect, "returned"); assert.equal(fs.readFileSync(f.other, "utf8"), "B写入");
  assert.equal(fs.readFileSync(f.held, "utf8"), "x");
});

const FIFO_ENV = ["RK_FILE_IO_HOLD", "RK_FILE_IO_FIFO", "RK_FILE_IO_STALL_MS", "RK_FILE_IO_MARKER", "RK_FILE_IO_BUNDLE", "RK_FILE_IO_PHASE"] as const;
function fifoFixture(t: TestContext, prefix: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
  const fifo = path.join(root, "gate"), held = path.join(root, "held"), other = path.join(root, "other"), marker = path.join(root, "entered");
  execFileSync("mkfifo", [fifo]); fs.writeFileSync(held, "x"); fs.writeFileSync(other, "y");
  const writer = fs.openSync(fifo, fs.constants.O_RDWR);
  const previous = FIFO_ENV.map(name => process.env[name]);
  process.env.RK_FILE_IO_HOLD = held; process.env.RK_FILE_IO_FIFO = fifo; process.env.RK_FILE_IO_MARKER = marker;
  process.env.RK_FILE_IO_BUNDLE = new URL("../worker/personal-file-worker.mjs", import.meta.url).href;
  t.after(() => FIFO_ENV.forEach((name, index) => { const value = previous[index]; if (value === undefined) delete process.env[name]; else process.env[name] = value; }));
  t.after(() => { try { fs.writeSync(writer, Buffer.alloc(64)); } catch {} try { fs.closeSync(writer); } catch {} });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, fifo, held, other, marker, writer, release: (bytes = 1) => { try { fs.writeSync(writer, Buffer.alloc(bytes)); } catch {} } };
}
const FIFO_WRAPPER = fileURLToPath(new URL("./helpers/personal-file-io-fifo-worker.mjs", import.meta.url));

test("文件工作线程：四个真实持住任务占满容量，第五个拒绝且新宿主不能重置", { timeout: 60_000 }, async t => {
  const f = fifoFixture(t, "rk-file-io-cap-");
  const workers = new Map<string, Worker>(); let exits = 0;
  const io = openPersonalFileIo({ script: FIFO_WRAPPER, terminationGraceMs: 100, workerProbe: (worker, meta) => { workers.set(meta.id, worker); worker.on("exit", () => exits++); } });
  const heldJobs = [0, 1, 2, 3].map(() => io.prepare({ path: f.held, access: "read", protectedRoots: [] }).then(() => "done", error => String((error as PersonalError).code)));
  t.after(async () => { f.release(4); await Promise.allSettled(heldJobs); await io.close().catch(() => undefined); });
  await until(() => workers.size === 4 && [...workers.keys()].every(id => fs.existsSync(`${f.marker}.${id}`)));
  // A pre-read marker cannot prove a worker has entered blocking OS I/O.
  if (process.platform === "linux") {
    const tids = [...workers.keys()].map(id => fs.readFileSync(`${f.marker}.${id}`, "utf8").trim());
    assert.equal(new Set(tids).size, 4); assert.ok(tids.every(id => /^[1-9][0-9]*$/.test(id)));
    await until(() => tids.every(id => ["pipe_read", "anon_pipe_read"].includes(fs.readFileSync(`/proc/self/task/${id}/wchan`, "utf8").trim())), 10_000);
  } else {
    assert.equal(process.platform, "darwin", "File-worker OS blocking must be verified on a supported platform");
    const sample = path.join(f.root, "blocked-threads.txt");
    await until(async () => {
      await promisify(execFile)("/usr/bin/sample", [String(process.pid), "1", "10", "-file", sample], { timeout: 5_000, maxBuffer: 1024 * 1024 });
      return fs.readFileSync(sample, "utf8").split(/^    \d+ Thread_/m).filter(thread => thread.includes("node::worker::Worker::StartThread") && thread.includes("node::fs::Read(") && thread.includes("uv_fs_read") && thread.includes("read  (in libsystem_kernel.dylib)")).length === 4;
    }, 10_000);
  }
  await assert.rejects(io.prepare({ path: f.other, access: "read", protectedRoots: [] }), code("file_io_capacity_unavailable"));
  const fresh = openPersonalFileIo(); t.after(() => fresh.close().catch(() => undefined));
  await assert.rejects(fresh.prepare({ path: f.other, access: "read", protectedRoots: [] }), code("file_io_capacity_unavailable"));
  await assert.rejects(io.close(), code("file_io_stop_unverified"));
  assert.equal(exits, 0);
  await assert.rejects(io.prepare({ path: f.other, access: "read", protectedRoots: [] }), code("file_io_closed"));
  await assert.rejects(fresh.prepare({ path: f.other, access: "read", protectedRoots: [] }), code("file_io_capacity_unavailable"));
  f.release(4);
  assert.deepEqual(await Promise.all(heldJobs), ["file_io_canceled", "file_io_canceled", "file_io_canceled", "file_io_canceled"]);
  await until(() => exits === 4);
  assert.equal((await fresh.prepare({ path: f.other, access: "read", protectedRoots: [] })).access, "read");
});

test("文件工作线程：真实持住超过期限记超时，工作线程仍按实际退出计数", { timeout: 60_000 }, async t => {
  const f = fifoFixture(t, "rk-file-io-deadline-");
  const workers = new Map<string, Worker>();
  const io = openPersonalFileIo({ script: FIFO_WRAPPER, deadlineMs: 2000, terminationGraceMs: 100, workerProbe: (worker, meta) => workers.set(meta.id, worker) });
  const held = io.prepare({ path: f.held, access: "read", protectedRoots: [] }).then(() => "done", error => String((error as PersonalError).code));
  t.after(async () => { f.release(1); await held; await io.close().catch(() => undefined); });
  assert.deepEqual(await held, "file_io_timeout");
  assert.equal((await io.prepare({ path: f.other, access: "read", protectedRoots: [] })).access, "read");
  f.release(1);
  await until(() => [...workers.values()].every(worker => worker.threadId < 0));
  await io.close();
});

test("文件工作线程：外来与畸形应答拒绝并按实际退出结算一次", { timeout: 30_000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-file-io-proto-"))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "data"); fs.writeFileSync(target, "x");
  const malformed = path.join(root, "malformed.mjs");
  fs.writeFileSync(malformed, `import { parentPort } from "node:worker_threads";\nparentPort.once("message", job => { parentPort.postMessage({ id: job.id, phase: job.phase, op: job.op, ok: true, result: {} }); parentPort.close(); });\n`);
  const io = openPersonalFileIo({ script: malformed }); t.after(() => io.close());
  await assert.rejects(io.prepare({ path: target, access: "read", protectedRoots: [] }), code("file_io_protocol_invalid"));

  const foreign = path.join(root, "foreign.mjs");
  fs.writeFileSync(foreign, `import { parentPort } from "node:worker_threads";\nparentPort.once("message", job => { parentPort.postMessage({ id: "foreign-" + job.id, phase: job.phase, op: job.op, ok: true, result: {} }); parentPort.close(); });\n`);
  const io2 = openPersonalFileIo({ script: foreign }); t.after(() => io2.close());
  await assert.rejects(io2.prepare({ path: target, access: "read", protectedRoots: [] }), code("file_io_worker_lost"));
});

test("文件工作线程：预留未用释放后再执行拒绝，已用预留返回结果", { timeout: 30_000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-file-io-reserve-"))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "data"); fs.writeFileSync(target, "原文");
  const io = openPersonalFileIo(); t.after(() => io.close());
  const prepared = await io.prepare({ path: target, access: "read", protectedRoots: [] });
  const unused = await io.reserve(prepared);
  unused.assertReady(); await unused.release();
  await assert.rejects(unused.execute(), code("file_io_canceled"));
  const used = await io.reserve(prepared);
  const result = await used.execute();
  assert.equal(result.code, "file_returned"); assert.equal(result.bytes.toString("utf8"), "原文");
});

test("文件工作线程：真实持住使关闭未核实退出，实际退出后重试关闭成功", { timeout: 60_000 }, async t => {
  const f = fifoFixture(t, "rk-file-io-close-");
  const workers = new Map<string, Worker>();
  const io = openPersonalFileIo({ script: FIFO_WRAPPER, terminationGraceMs: 100, workerProbe: (worker, meta) => workers.set(meta.id, worker) });
  const held = io.prepare({ path: f.held, access: "read", protectedRoots: [] }).then(() => "done", error => String((error as PersonalError).code));
  await until(() => workers.size === 1 && fs.existsSync(f.marker));
  await assert.rejects(io.close(), code("file_io_stop_unverified"));
  f.release(1);
  assert.deepEqual(await held, "file_io_canceled");
  await until(() => [...workers.values()].every(worker => worker.threadId < 0));
  await io.close();
});

test("文件工作线程：真实持住拒绝关闭并保留档案锁，实际退出后重试关闭并安全重开", { timeout: 60_000 }, async t => {
  const f = fifoFixture(t, "rk-file-io-durable-");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-file-io-"))), directory = path.join(root, "profile"), workspace = path.join(root, "workspace");
  fs.mkdirSync(directory, { recursive: true }); fs.mkdirSync(workspace);
  const held = path.join(f.root, "held");
  const server = new MockModelServer(request => {
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "tool") return { kind: "text", text: `回执:${content}` };
    if (content.startsWith("tool:")) {
      const { name, args } = JSON.parse(content.slice(5)) as { name: string; args: Record<string, unknown> };
      return { kind: "tool_calls", calls: [{ id: "file-call", name, arguments: args }] };
    }
    return { kind: "text", text: `普通:${content}` };
  });
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await server.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_FILEIO_TEST_KEY", contextWindow: 128000, maxTokens: 8192 };
  const previous = process.env[config.apiKeyEnv]; process.env[config.apiKeyEnv] = "test-only";
  const identity = fs.statSync(workspace), tools = parsePersonalTools({ version: 1, generation: "file-io-test", workspace, identity: { dev: identity.dev, ino: identity.ino }, credentials: [] });
  let p: PersonalHarness | undefined;
  const workers = new Map<string, Worker>();
  const fileIo = openPersonalFileIo({ profile: fs.realpathSync(directory), script: FIFO_WRAPPER, terminationGraceMs: 100, workerProbe: (worker, meta) => workers.set(meta.id, worker) });
  t.after(async () => { f.release(8); await Promise.allSettled([...workers.values()].map(worker => worker.terminate())); await p?.close().catch(() => undefined); await fileIo.close().catch(() => undefined); await server.close(); if (previous === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = previous; fs.rmSync(root, { recursive: true, force: true }); });
  p = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, tools, fileIo });
  await p.harness.commit(async tx => { const doc = await tx.doc(PersonalPermissionsDoc); doc.mode = "full_access"; doc.version++; }, context);
  await p.answer("读取停顿", "stall-read");
  await p.work.delegate({ requestId: "stall-read-work", sourceRequestId: "stall-read", content: `tool:{"name":"read_file","args":{"path":${JSON.stringify(held)}}}` });
  await until(() => fs.existsSync(f.marker));

  await assert.rejects(p.close(), code("file_io_stop_unverified"));
  await p.harness.commit(async tx => { (await tx.doc(PersonalPermissionsDoc)).version++; }, context);
  await assert.rejects(openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, tools }), code("profile_busy"));
  await assert.rejects(fileIo.prepare({ path: f.other, access: "read", protectedRoots: [] }), code("file_io_closed"));

  f.release(1);
  await until(() => [...workers.values()].every(worker => worker.threadId < 0));
  await p.close(); p = undefined;
  const reopened = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, tools });
  const jobs = await reopened.harness.commit(tx => personalFileIoJobs(tx), context);
  assert.equal(jobs.length, 1); assert.equal(jobs[0]!.settle?.code, "file_io_canceled"); assert.notEqual(jobs[0]!.exit, undefined);
  await reopened.close();
});

test("文件工作线程：旧版本文件操作按完成与否兼容或拒绝", { timeout: 60_000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-file-io-"))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = process.env.RUUKOTO_FILEIO_TEST_KEY; process.env.RUUKOTO_FILEIO_TEST_KEY = "test-only";
  t.after(() => { if (previous === undefined) delete process.env.RUUKOTO_FILEIO_TEST_KEY; else process.env.RUUKOTO_FILEIO_TEST_KEY = previous; });
  const open = (restored: PersonalFileIoLegacyRestore) => openPersonalHarness({ directory: restored.directory, provider: personalProvider(restored.config), modelId: restored.config.modelId, tools: restored.tools });

  for (const caseName of ["completed-read", "completed-write"] as const) {
    const restored = await restorePersonalFileIoLegacy(caseName, fs.mkdtempSync(path.join(root, `${caseName}-`)));
    const compat = await open(restored);
    const operation = (await compat.harness.commit(async tx => JSON.parse(JSON.stringify(await toolOperations(tx))) as PersonalToolOperation[], context)).at(-1)!;
    assert.equal(operation.kind, caseName === "completed-read" ? "read_file" : "write_file"); assert.equal(operation.fileIoVersion, undefined);
    assert.equal((await compat.harness.commit(async tx => (await tx.task(operation.operation))?.state.status, context)), "terminal");
    assert.equal(operation.effect, "returned"); assert.equal(fs.readFileSync(restored.target, "utf8"), caseName === "completed-write" ? "legacy-write" : "x");
    await compat.close();
  }

  // The old active WorkTask is refused before file-I/O activation.
  const pendingRead = await restorePersonalFileIoLegacy("pending-read", fs.mkdtempSync(path.join(root, "pending-read-")));
  await assert.rejects(open(pendingRead), code("task_version"));
  assert.equal(fs.readFileSync(pendingRead.target, "utf8"), "x");
  const pendingWrite = await restorePersonalFileIoLegacy("pending-write", fs.mkdtempSync(path.join(root, "pending-write-")));
  await assert.rejects(open(pendingWrite), code("task_version"));
  assert.equal(fs.readFileSync(pendingWrite.target, "utf8"), "x");
  const storage = await openNodeSqliteStorage(path.join(pendingWrite.directory, "personal.sqlite"));
  try {
    const record = await storage.findDocument({ kind: "ruukoto.directory-claims", scope: { kind: "session" } }, "current", context);
    const saved = record && await storage.document(record.id, "current", context);
    const claims = (saved?.value as { claims?: Array<{ released?: boolean }> } | undefined)?.claims ?? [];
    assert.equal(claims.length, 1); assert.equal(claims[0]!.released, undefined);
  } finally { await storage.close(context); }
});

test("文件工作线程：任务记录损坏或证据断链拒绝恢复", { timeout: 60_000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-file-io-rec-"))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "profile"); fs.mkdirSync(directory);
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: "http://127.0.0.1:1", modelId: "mock-model", apiKeyEnv: "RUUKOTO_FILEIO_TEST_KEY", contextWindow: 128000, maxTokens: 8192 };
  const previous = process.env[config.apiKeyEnv]; process.env[config.apiKeyEnv] = "test-only";
  const p = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId });
  t.after(async () => { await p.close(); if (previous === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = previous; });
  const io = openPersonalFileIo({ profile: directory }); t.after(() => io.close().catch(() => undefined));
  const record = createPersonalFileIoRecorder(() => p.harness);
  fs.writeFileSync(path.join(root, "data"), "x");
  await io.prepare({ path: path.join(root, "data"), access: "read", protectedRoots: [] }, { phase: "prepare", record });
  const meta = (await p.harness.commit(tx => personalFileIoJobs(tx), context))[0]!;
  const scanned = new Set([meta.admission, ...meta.events]);
  await p.harness.commit(tx => verifyPersonalFileIo(tx, scanned), context);

  const corrupt = async (mutate: (job: Record<string, unknown>) => void) => {
    await p.harness.commit(async tx => {
      const target = await tx.doc(PersonalFileJobDoc, meta.id, null);
      const snapshot = JSON.parse(JSON.stringify(target.job));
      try { mutate(target.job as unknown as Record<string, unknown>); await verifyPersonalFileIo(tx, scanned); } catch (error) { target.job = snapshot; if ((error as PersonalError).code === "file_io_record_invalid") return; throw error; }
      throw new Error("verify accepted a corrupt record");
    }, context);
  };
  await corrupt(job => { job.phase = "execute"; });
  await corrupt(job => { job.requestSha256 = "0".repeat(64); });
  await corrupt(job => { job.deadlineAt = Number(job.deadlineAt) + 60_000; });
  await corrupt(job => { (job.host as Record<string, unknown>).pid = -3; });
  await corrupt(job => { (job.host as Record<string, unknown>).incarnation = "not-a-uuid"; });
  await corrupt(job => { job.origin = { conversationId: 1, generation: 1, inputs: [1], sources: [1] }; });
  await corrupt(job => { (job.settle as Record<string, unknown>).code = "file_returned"; });
  await corrupt(job => { (job.settle as Record<string, unknown>).outcome = "released"; });
  await corrupt(job => { job.seq = Number(job.seq) + 1; });
  await corrupt(job => { job.events = [...(job.events as number[])].reverse(); });
  await corrupt(job => { job.exit = { code: 0, entry: meta.admission }; });
  await p.harness.commit(async tx => { const index = await tx.doc(PersonalFileIoDoc); const held = index.jobs[0]; index.jobs.length = 0; await assert.rejects(verifyPersonalFileIo(tx, scanned), code("file_io_record_invalid")); index.jobs.push(held!); }, context);
  await p.harness.commit(async tx => { const index = await tx.doc(PersonalFileIoDoc); index.jobs.push(meta.id); await assert.rejects(verifyPersonalFileIo(tx, scanned), code("file_io_record_invalid")); index.jobs.pop(); }, context);
  await p.harness.commit(async tx => {
    const newKey = randomUUID(), old = await tx.doc(PersonalFileJobDoc, meta.id, null), moved = await tx.doc(PersonalFileJobDoc, newKey, null), index = await tx.doc(PersonalFileIoDoc), saved = JSON.parse(JSON.stringify(old.job)), keys = index.jobs.slice();
    moved.job = saved; delete old.job; index.jobs[0] = newKey;
    try {
      await assert.rejects(verifyPersonalFileIo(tx, scanned), code("file_io_record_invalid"));
      await assert.rejects(personalFileJobStopped(tx, newKey), code("file_io_record_invalid"));
    } finally { old.job = saved; delete moved.job; index.jobs.length = 0; index.jobs.push(...keys); }
  }, context);
  await p.close();


  const bumped = path.join(root, "profile-bumped"); fs.mkdirSync(bumped);
  const p2 = await openPersonalHarness({ directory: bumped, provider: personalProvider(config), modelId: config.modelId });
  const io2 = openPersonalFileIo({ profile: bumped });
  await io2.prepare({ path: path.join(root, "data"), access: "read", protectedRoots: [] }, { phase: "prepare", record: createPersonalFileIoRecorder(() => p2.harness) });
  await io2.close(); await p2.close();
  const storage2 = await openNodeSqliteStorage(path.join(bumped, "personal.sqlite"));
  try {
    const record2 = await storage2.findDocument({ kind: PersonalFileIoDoc.definition.kind, scope: { kind: "session" } }, "current", context);
    await storage2.commit([{ type: "document.change", id: record2!.id, content: { version: 2, kind: "base", value: { jobs: [] } } }], context);
  } finally { await storage2.close(context); }
  await assert.rejects(openPersonalHarness({ directory: bumped, provider: personalProvider(config), modelId: config.modelId }), code("file_io_record_invalid"));


  const orphaned = path.join(root, "profile-orphaned"); fs.mkdirSync(orphaned);
  const p3 = await openPersonalHarness({ directory: orphaned, provider: personalProvider(config), modelId: config.modelId });
  const io3 = openPersonalFileIo({ profile: orphaned });
  await io3.prepare({ path: path.join(root, "data"), access: "read", protectedRoots: [] }, { phase: "prepare", record: createPersonalFileIoRecorder(() => p3.harness) });
  await io3.close(); await p3.close();
  const storage3 = await openNodeSqliteStorage(path.join(orphaned, "personal.sqlite"));
  try {
    const latest = await storage3.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "descending" }, 1, undefined, context);
    const id = Number(latest.items[0]!.id) + 1;
    await storage3.commit([{ type: "entry", value: { id: id as typeof latest.items[0]["id"], conversationId: ROOT_CONVERSATION_ID, kind: "ruukoto.file-io-lifecycle", data: { kind: "exit", jobId: randomUUID(), host: { pid: 1, startIdentity: null, incarnation: randomUUID() }, seq: 1, code: 0 } } }], context);
  } finally { await storage3.close(context); }
  await assert.rejects(openPersonalHarness({ directory: orphaned, provider: personalProvider(config), modelId: config.modelId }), code("file_io_record_invalid"));


  const relocated = path.join(root, "profile-relocated"); fs.mkdirSync(relocated);
  const p4 = await openPersonalHarness({ directory: relocated, provider: personalProvider(config), modelId: config.modelId });
  const io4 = openPersonalFileIo({ profile: relocated });
  await io4.prepare({ path: path.join(root, "data"), access: "read", protectedRoots: [] }, { phase: "prepare", record: createPersonalFileIoRecorder(() => p4.harness) });
  await io4.close();
  const meta4 = (await p4.harness.commit(tx => personalFileIoJobs(tx), context))[0]!;
  const movedKey = randomUUID();
  await p4.harness.commit(async tx => { await tx.doc(PersonalFileJobDoc, movedKey, null); }, context);
  await p4.close();
  const storage4 = await openNodeSqliteStorage(path.join(relocated, "personal.sqlite"));
  try {
    await verifyPersonalFileIoStorage(storage4);
    const original = await storage4.findDocument({ kind: PersonalFileJobDoc.definition.kind, scope: { kind: "session" }, key: meta4.id }, "current", context);
    const moved = await storage4.findDocument({ kind: PersonalFileJobDoc.definition.kind, scope: { kind: "session" }, key: movedKey }, "current", context);
    const index = await storage4.findDocument({ kind: PersonalFileIoDoc.definition.kind, scope: { kind: "session" } }, "current", context);
    const originalStored = (await storage4.document(original!.id, "current", context))!;
    assert.ok(moved); assert.ok(index);
    await storage4.commit([
      { type: "document.change", id: moved.id, content: { version: 1, kind: "base", value: { job: JSON.parse(JSON.stringify(originalStored.value.job)) } } },
      { type: "document.change", id: original!.id, content: { version: 1, kind: "base", value: {} } },
      { type: "document.change", id: index.id, content: { version: 1, kind: "base", value: { jobs: [movedKey] } } },
    ], context);
    await assert.rejects(verifyPersonalFileIoStorage(storage4), code("file_io_record_invalid"));
  } finally { await storage4.close(context); }
  const relocatedOpen = await openPersonalHarness({ directory: relocated, provider: personalProvider(config), modelId: config.modelId }).then(harness => harness.close().then(() => "opened"), error => error);
  assert.ok(relocatedOpen instanceof PersonalError && relocatedOpen.code === "file_io_record_invalid");


  const extra = path.join(root, "profile-extra"); fs.mkdirSync(extra);
  const p5 = await openPersonalHarness({ directory: extra, provider: personalProvider(config), modelId: config.modelId });
  const io5 = openPersonalFileIo({ profile: extra });
  await io5.prepare({ path: path.join(root, "data"), access: "read", protectedRoots: [] }, { phase: "prepare", record: createPersonalFileIoRecorder(() => p5.harness) });
  await io5.close();
  const meta5 = (await p5.harness.commit(tx => personalFileIoJobs(tx), context))[0]!;
  await p5.close();
  const storage5 = await openNodeSqliteStorage(path.join(extra, "personal.sqlite"));
  try {
    const jobRecord = await storage5.findDocument({ kind: PersonalFileJobDoc.definition.kind, scope: { kind: "session" }, key: meta5.id }, "current", context);
    const indexRecord = await storage5.findDocument({ kind: PersonalFileIoDoc.definition.kind, scope: { kind: "session" } }, "current", context);
    const jobStored = (await storage5.document(jobRecord!.id, "current", context))!, indexStored = (await storage5.document(indexRecord!.id, "current", context))!;
    await storage5.commit([{ type: "document.change", id: jobRecord!.id, content: { version: 1, kind: "base", value: { ...jobStored.value, bogus: true } } }], context);
    await assert.rejects(verifyPersonalFileIoStorage(storage5), code("file_io_record_invalid"));
    await storage5.commit([{ type: "document.change", id: jobRecord!.id, content: { version: 1, kind: "base", value: jobStored.value } }], context);
    await verifyPersonalFileIoStorage(storage5);
    await storage5.commit([{ type: "document.change", id: indexRecord!.id, content: { version: 1, kind: "base", value: { ...indexStored.value, bogus: true } } }], context);
    await assert.rejects(verifyPersonalFileIoStorage(storage5), code("file_io_record_invalid"));
  } finally { await storage5.close(context); }
});

test("file-io worker: canonical namespace fence holds until checked reconciliation", { timeout: 60_000 }, async t => {
  for (const scenario of ["cold namespace close", "cold Session close", "close after a job exited"] as const) {
    await t.test(scenario, async t => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-file-io-fence-"))), profile = path.join(root, "profile"), target = path.join(root, "target");
      fs.mkdirSync(profile); fs.writeFileSync(target, "x");
      if (scenario === "close after a job exited") {
        const warm = openPersonalFileIo({ profile });
        await warm.prepare({ path: target, access: "read", protectedRoots: [] });
        await warm.close();
      }
      let spawns = 0, p: PersonalHarness | undefined, late: PersonalFileIo | undefined;
      const io = openPersonalFileIo({ profile, workerProbe: () => spawns++ });
      const config: PersonalModelConfig = { api: "openai-completions", baseUrl: "http://127.0.0.1:1", modelId: "mock-model", apiKeyEnv: "RUUKOTO_FILEIO_TEST_KEY", contextWindow: 128000, maxTokens: 8192 };
      const previous = process.env[config.apiKeyEnv]; process.env[config.apiKeyEnv] = "test-only";
      t.after(async () => { await late?.close().catch(() => undefined); await io.close().catch(() => undefined); await p?.close(); if (previous === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = previous; fs.rmSync(root, { recursive: true, force: true }); });
      if (scenario === "cold Session close") sealPersonalFileIoSessionClosed(profile); else await closePersonalFileIoNamespace(profile);
      const request = preparePersonalFile({ path: target, access: "read", protectedRoots: [] });
      await assert.rejects(io.prepare({ path: target, access: "read", protectedRoots: [] }), code("file_io_closed"));
      await assert.rejects(io.execute(request), code("file_io_closed"));
      await assert.rejects(io.reserve(request), code("file_io_closed"));
      late = openPersonalFileIo({ profile, workerProbe: () => spawns++ });
      await assert.rejects(late.prepare({ path: target, access: "read", protectedRoots: [] }), code("file_io_closed"));
      await late.close(); late = undefined;
      assert.equal(spawns, 0);
      p = await openPersonalHarness({ directory: profile, provider: personalProvider(config), modelId: config.modelId });
      late = openPersonalFileIo({ profile });
      const prepared = await late.prepare({ path: target, access: "read", protectedRoots: [] });
      const read = await late.execute(prepared);
      assert.equal(read.code, "file_returned"); assert.equal(read.effect, "returned");
      await late.close(); late = undefined;
      await p.close(); p = undefined;
    });
  }
});

test("文件工作线程：准入前强杀留下任务证据，恢复重放不再派生工作线程", { timeout: 60_000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-file-io-"))), directory = path.join(root, "profile"), workspace = path.join(root, "workspace");
  fs.mkdirSync(directory); fs.mkdirSync(workspace);
  const server = new MockModelServer(request => {
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "tool") return { kind: "text", text: `回执:${content}` };
    if (content.startsWith("tool:")) {
      const { name, args } = JSON.parse(content.slice(5)) as { name: string; args: Record<string, unknown> };
      return { kind: "tool_calls", calls: [{ id: "file-call", name, arguments: args }] };
    }
    return { kind: "text", text: `普通:${content}` };
  });
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await server.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_FILEIO_TEST_KEY", contextWindow: 128000, maxTokens: 8192 };
  const previous = process.env[config.apiKeyEnv]; process.env[config.apiKeyEnv] = "test-only";
  const target = path.join(workspace, "target"); fs.writeFileSync(target, "原文");
  let p: PersonalHarness | undefined, fileIo: PersonalFileIo | undefined, child: ReturnType<typeof spawn> | undefined;
  t.after(async () => { if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await p?.close().catch(() => undefined); await fileIo?.close().catch(() => undefined); await server.close(); if (previous === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = previous; fs.rmSync(root, { recursive: true, force: true }); });
  const script = `
    import { openPersonalHarness } from './apps/ruukoto/src/personal-harness.ts';
    import { personalProvider } from './apps/ruukoto/src/personal-model.ts';
    import { PersonalPermissionsDoc } from './apps/ruukoto/src/personal-permissions.ts';
    import { parsePersonalTools } from './apps/ruukoto/src/personal-tools-config.ts';
    import * as fs from 'node:fs';
    import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
    import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
    const input = JSON.parse(process.env.RUUKOTO_FILEIO_CRASH);
    const identity = fs.statSync(input.workspace), tools = parsePersonalTools({ version: 1, generation: "file-io-test", workspace: input.workspace, identity: { dev: identity.dev, ino: identity.ino }, credentials: [] });
    const p = await openPersonalHarness({directory:input.directory,provider:personalProvider(input.model),modelId:input.model.modelId,tools,
      openStorage: async filename => {
        const storage = await openNodeSqliteStorage(filename), commit = storage.commit.bind(storage);
        storage.commit = async (writes, context) => {
          if (writes.find(write => write.type === 'entry' && write.value.kind === 'ruukoto.tool-admission')) process.kill(process.pid, 'SIGKILL');
          return commit(writes, context);
        }; return storage;
      }});
    await p.harness.commit(async tx => { const doc = await tx.doc(PersonalPermissionsDoc); doc.mode = 'full_access'; doc.version++; }, BACKGROUND_CONTEXT);
    await p.answer('读取目标', 'crash-src');
    await p.work.delegate({requestId:'crash-work',sourceRequestId:'crash-src',content:'tool:{"name":"read_file","args":{"path":' + JSON.stringify(input.target) + '}}'});
    await new Promise(resolve => setTimeout(resolve, 15000));
  `;
  child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: new URL("..", import.meta.url), env: { ...process.env, RUUKOTO_FILEIO_CRASH: JSON.stringify({ directory, workspace, target, model: config }) }, stdio: ["ignore", "pipe", "pipe"] });
  let errors = ""; child.stderr!.on("data", value => { errors += String(value); });
  const exit = new Promise(resolve => child!.on("exit", resolve));
  await until(() => child!.exitCode !== null || child!.signalCode !== null);
  await exit;
  assert.equal(child.signalCode, "SIGKILL", errors);


  let spawns = 0;
  fileIo = openPersonalFileIo({ profile: directory, workerProbe: () => { spawns++; } });
  const identity2 = fs.statSync(workspace), tools = parsePersonalTools({ version: 1, generation: "file-io-test", workspace, identity: { dev: identity2.dev, ino: identity2.ino }, credentials: [] });
  p = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, tools, fileIo });

  await until(() => server.calls.some(request => { const last = request.messages.at(-1); return last?.role === "tool" && String(last.content).includes("file_io_"); }));
  assert.equal(spawns, 0, errors);
  const jobs = await p.harness.commit(tx => personalFileIoJobs(tx), context);
  assert.equal(jobs.length, 1); assert.equal(jobs[0]!.phase, "prepare"); assert.notEqual(jobs[0]!.dispatch, undefined); assert.notEqual(jobs[0]!.settle, undefined);
});

test("文件工作线程：预留票据并发单次派发，过期释放槽位，应答证据先于结果交付", { timeout: 60_000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-file-io-ticket-"))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "data"); fs.writeFileSync(target, "原文");


  const short = openPersonalFileIo({ deadlineMs: 400 }); t.after(() => short.close().catch(() => undefined));
  const prepared = await short.prepare({ path: target, access: "read", protectedRoots: [] });
  const expired = await short.reserve(prepared);
  await delay(600);
  assert.equal(personalFileIoJobLive(expired.id), false);
  assert.throws(() => expired.assertReady(), code("file_io_timeout"));
  await assert.rejects(expired.execute(), code("file_io_timeout"));


  let ioExits = 0;
  const io = openPersonalFileIo({ workerProbe: worker => worker.on("exit", () => ioExits++) }); t.after(() => io.close());
  let spawns = 0; const probed = openPersonalFileIo({ workerProbe: () => spawns++ }); t.after(() => probed.close());
  const prepared2 = await probed.prepare({ path: target, access: "read", protectedRoots: [] });
  const ticket = await probed.reserve(prepared2);
  const first = ticket.execute();
  await assert.rejects(ticket.execute(), code("file_io_canceled"));
  await assert.rejects(ticket.release(), code("file_io_canceled"));
  assert.equal((await first).code, "file_returned");
  await until(() => spawns === 2);
  await probed.close();


  let gate!: () => void; const blocker = new Promise<void>(resolve => gate = resolve);
  const events: string[] = [];
  const record = (event: PersonalFileIoEvent) => { events.push(event.kind); return event.kind === "result" ? blocker : Promise.resolve(); };
  const done = io.execute(prepared2, { phase: "execute", record });
  await until(() => events.includes("result"));
  await until(() => ioExits === 1);
  let settled = false; void done.then(() => settled = true, () => settled = true);
  await delay(50); assert.equal(settled, false);
  gate();
  assert.equal((await done).code, "file_returned");
  assert.deepEqual(events, ["admit", "starting", "dispatch", "result", "settle", "exit"]);
  assert.equal(events.filter(kind => kind === "result").length, 1);


  let exited = false;
  const stall = openPersonalFileIo({ stallMs: 300, deadlineMs: 250, workerProbe: worker => worker.on("exit", () => exited = true) }); t.after(() => stall.close().catch(() => undefined));
  await assert.rejects(stall.prepare({ path: target, access: "read", protectedRoots: [] }), code("file_io_timeout"));
  await until(() => exited);
  const healthy = openPersonalFileIo(); t.after(() => healthy.close().catch(() => undefined));
  assert.equal((await healthy.prepare({ path: target, access: "read", protectedRoots: [] })).access, "read");

  let entrySpawns = 0; const entryEvents: string[] = [];
  const entryAbort = openPersonalFileIo({ workerProbe: () => entrySpawns++ }); t.after(() => entryAbort.close().catch(() => undefined));
  const controller = new AbortController(); controller.abort();
  const entryPrepared = await entryAbort.prepare({ path: target, access: "read", protectedRoots: [] });
  const entrySpawnsBefore = entrySpawns;
  const entryJob = entryAbort.execute(entryPrepared, { phase: "execute", record: event => { entryEvents.push(event.kind); return Promise.resolve(); }, signal: controller.signal });
  await assert.rejects(entryJob, code("file_io_canceled"));
  assert.equal(entrySpawns, entrySpawnsBefore);
  await until(() => entryEvents.length === 4); assert.deepEqual(entryEvents, ["admit", "no-dispatch", "release", "settle"]);

  const fenced = path.join(root, "fenced"); fs.mkdirSync(fenced);
  let admitGate!: () => void; const admitBlocker = new Promise<void>(resolve => admitGate = resolve);
  const admitEvents: string[] = []; let admitSpawns = 0;
  const deadlineHeld = openPersonalFileIo({ profile: fenced, deadlineMs: 300, workerProbe: () => admitSpawns++ }); t.after(() => deadlineHeld.close().catch(() => undefined));
  const admitPrepared = await deadlineHeld.prepare({ path: target, access: "read", protectedRoots: [] });
  const admitSpawnsBefore = admitSpawns;
  const reserving = deadlineHeld.reserve(admitPrepared, { phase: "execute", record: event => { admitEvents.push(event.kind); return event.kind === "admit" ? admitBlocker : Promise.resolve(); } });
  await until(() => admitEvents.length === 1);
  await assert.rejects(reserving, code("file_io_timeout"));
  assert.equal(admitSpawns, admitSpawnsBefore); assert.equal(personalFileIoLiveJobs(fenced), false);
  admitGate();
  await until(() => admitEvents.length === 4); assert.deepEqual(admitEvents, ["admit", "no-dispatch", "release", "settle"]);
  await deadlineHeld.close();

  const dispatched = path.join(root, "dispatched"); fs.mkdirSync(dispatched);
  let dispatchGate!: () => void; const dispatchBlocker = new Promise<void>(resolve => dispatchGate = resolve);
  const dispatchEvents: string[] = []; const dispatchWorkers: Worker[] = []; let dispatchExits = 0;
  const dispatchHeld = openPersonalFileIo({ profile: dispatched, workerProbe: worker => { dispatchWorkers.push(worker); worker.on("exit", () => dispatchExits++); } }); t.after(() => dispatchHeld.close().catch(() => undefined));
  const controller2 = new AbortController();
  const dispatchTicket = await dispatchHeld.reserve(await dispatchHeld.prepare({ path: target, access: "read_write", content: "改写", protectedRoots: [] }), { phase: "execute", record: event => { dispatchEvents.push(event.kind); return event.kind === "dispatch" ? dispatchBlocker : Promise.resolve(); }, signal: controller2.signal });
  const dispatchJob = dispatchTicket.execute();
  await until(() => dispatchEvents.includes("dispatch") && dispatchWorkers.length === 2); controller2.abort();
  const dispatchError = await dispatchJob.then(() => { throw new Error("unexpected success"); }, error => error as PersonalFileIoError);
  assert.equal(dispatchError.code, "file_io_canceled"); assert.equal(dispatchError.dispatched, false);
  dispatchGate();
  await until(() => dispatchExits === 2);
  await delay(100);
  assert.equal(fs.readFileSync(target, "utf8"), "原文");
  assert.deepEqual(dispatchEvents, ["admit", "starting", "dispatch", "no-dispatch", "settle", "terminate", "exit"]);
  await dispatchHeld.close();

  const fencedSettle = path.join(root, "fenced-settle"); fs.mkdirSync(fencedSettle);
  const settling = openPersonalFileIo({ profile: fencedSettle }); t.after(() => settling.close().catch(() => undefined));
  const ticket2 = await settling.reserve(await settling.prepare({ path: target, access: "read", protectedRoots: [] }));
  assert.equal(personalFileIoJobLive(ticket2.id), true);
  await assert.rejects(settling.execute(await settling.prepare({ path: target, access: "read", protectedRoots: [] }), { phase: "execute", record: event => event.kind === "settle" ? Promise.reject(new Error("rejected")) : Promise.resolve() }), code("file_io_persistence_failed"));
  await assert.rejects(ticket2.execute(), code("file_io_persistence_failed"));
  await settling.close().catch(() => undefined);
});

test("文件工作线程：执行预留准入后强杀，恢复按未执行结算且不再派生工作线程", { timeout: 60_000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-file-io-"))), directory = path.join(root, "profile"), workspace = path.join(root, "workspace");
  fs.mkdirSync(directory); fs.mkdirSync(workspace);
  const server = new MockModelServer(request => {
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "tool") return { kind: "text", text: `回执:${content}` };
    if (content.startsWith("tool:")) {
      const { name, args } = JSON.parse(content.slice(5)) as { name: string; args: Record<string, unknown> };
      return { kind: "tool_calls", calls: [{ id: "file-call", name, arguments: args }] };
    }
    return { kind: "text", text: `普通:${content}` };
  });
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await server.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_FILEIO_TEST_KEY", contextWindow: 128000, maxTokens: 8192 };
  const previous = process.env[config.apiKeyEnv]; process.env[config.apiKeyEnv] = "test-only";
  const target = path.join(workspace, "target"); fs.writeFileSync(target, "原文");
  let p: PersonalHarness | undefined, fileIo: PersonalFileIo | undefined, child: ReturnType<typeof spawn> | undefined;
  t.after(async () => { if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await p?.close().catch(() => undefined); await fileIo?.close().catch(() => undefined); await server.close(); if (previous === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = previous; fs.rmSync(root, { recursive: true, force: true }); });

  const script = `
    import { openPersonalHarness } from './apps/ruukoto/src/personal-harness.ts';
    import { personalProvider } from './apps/ruukoto/src/personal-model.ts';
    import { PersonalPermissionsDoc } from './apps/ruukoto/src/personal-permissions.ts';
    import { parsePersonalTools } from './apps/ruukoto/src/personal-tools-config.ts';
    import * as fs from 'node:fs';
    import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
    import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
    const input = JSON.parse(process.env.RUUKOTO_FILEIO_CRASH);
    const identity = fs.statSync(input.workspace), tools = parsePersonalTools({ version: 1, generation: "file-io-test", workspace: input.workspace, identity: { dev: identity.dev, ino: identity.ino }, credentials: [] });
    const p = await openPersonalHarness({directory:input.directory,provider:personalProvider(input.model),modelId:input.model.modelId,tools,
      openStorage: async filename => {
        const storage = await openNodeSqliteStorage(filename), commit = storage.commit.bind(storage);
        storage.commit = async (writes, context) => {
          if (writes.find(write => write.type === 'entry' && write.value.kind === 'ruukoto.file-io-admission' && write.value.data?.phase === 'execute')) { await commit(writes, context); process.kill(process.pid, 'SIGKILL'); }
          return commit(writes, context);
        }; return storage;
      }});
    await p.harness.commit(async tx => { const doc = await tx.doc(PersonalPermissionsDoc); doc.mode = 'full_access'; doc.version++; }, BACKGROUND_CONTEXT);
    await p.answer('读取目标', 'crash-src');
    await p.work.delegate({requestId:'crash-work',sourceRequestId:'crash-src',content:'tool:{"name":"read_file","args":{"path":' + JSON.stringify(input.target) + '}}'});
    await new Promise(resolve => setTimeout(resolve, 15000));
  `;
  child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: new URL("..", import.meta.url), env: { ...process.env, RUUKOTO_FILEIO_CRASH: JSON.stringify({ directory, workspace, target, model: config }) }, stdio: ["ignore", "pipe", "pipe"] });
  let errors = ""; child.stderr!.on("data", value => { errors += String(value); });
  const exit = new Promise(resolve => child!.on("exit", resolve));
  await until(() => child!.exitCode !== null || child!.signalCode !== null);
  await exit;
  assert.equal(child.signalCode, "SIGKILL", errors);


  let spawns = 0;
  fileIo = openPersonalFileIo({ profile: directory, workerProbe: () => { spawns++; } });
  const identity2 = fs.statSync(workspace), tools = parsePersonalTools({ version: 1, generation: "file-io-test", workspace, identity: { dev: identity2.dev, ino: identity2.ino }, credentials: [] });
  p = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, tools, fileIo });
  await until(() => server.calls.some(request => { const last = request.messages.at(-1); return last?.role === "tool" && String(last.content).includes("file_io_"); }));
  assert.equal(spawns, 0, errors);
  const ops = () => p!.harness.commit(async tx => JSON.parse(JSON.stringify(await toolOperations(tx))) as PersonalToolOperation[], context);
  const operation = (await ops()).at(-1)!;
  assert.equal(operation.kind, "read_file"); assert.equal(operation.started, false);
  assert.equal(operation.effect, "not_executed"); assert.match(operation.code, /^file_io_/);
  assert.equal(fs.readFileSync(target, "utf8"), "原文");
  const jobs = await p.harness.commit(tx => personalFileIoJobs(tx), context);
  const attempt = jobs.find(job => job.phase === "execute")!;
  assert.ok(attempt); assert.equal(attempt.dispatch, undefined); assert.notEqual(attempt.hostEnded, undefined);

  await p.work.delegate({ requestId: "crash-work-2", sourceRequestId: "crash-src", content: `tool:{"name":"read_file","args":{"path":${JSON.stringify(target)}}}` });
  await until(async () => (await ops()).some(value => value.observation !== undefined && value.code === "file_returned"));
  assert.ok(spawns > 0);
});

test("文件工作线程：参数化强杀窗口的恢复结算与原占用", { timeout: 300_000 }, async t => {
  const windows = [
    { name: "start", events: ["host-ended", "no-dispatch", "settle"], starting: false, dispatch: false, noDispatch: true, result: false, outcome: "released", code: "file_io_canceled", effect: "not_executed", written: false, blocker: false },
    { name: "pre-dispatch", events: ["starting", "host-ended", "no-dispatch", "settle"], starting: true, dispatch: false, noDispatch: true, result: false, outcome: "released", code: "file_io_canceled", effect: "not_executed", written: false, blocker: false },
    { name: "post-dispatch", events: ["starting", "dispatch", "host-ended", "settle"], starting: true, dispatch: true, noDispatch: false, result: false, outcome: "error", code: "file_io_worker_lost", effect: "effect_unknown", written: false, blocker: true },
    { name: "result", events: ["starting", "dispatch", "result", "host-ended", "settle"], starting: true, dispatch: true, noDispatch: false, result: true, outcome: "result", code: "file_returned", effect: "effect_unknown", written: true, blocker: true },
  ] as const;
  for (const w of windows) await t.test(`窗口 ${w.name}`, { timeout: 90_000 }, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-file-io-"))), directory = path.join(root, "profile"), workspace = path.join(root, "workspace");
    fs.mkdirSync(directory); fs.mkdirSync(workspace);
    const server = new MockModelServer(request => {
      const last = request.messages.at(-1), content = String(last?.content);
      if (last?.role === "tool") return { kind: "text", text: `回执:${content}` };
      if (content.startsWith("tool:")) {
        const { name, args } = JSON.parse(content.slice(5)) as { name: string; args: Record<string, unknown> };
        return { kind: "tool_calls", calls: [{ id: "file-call", name, arguments: args }] };
      }
      return { kind: "text", text: `普通:${content}` };
    });
    const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await server.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_FILEIO_TEST_KEY", contextWindow: 128000, maxTokens: 8192 };
    const previous = process.env[config.apiKeyEnv]; process.env[config.apiKeyEnv] = "test-only";
    const target = path.join(workspace, "target"); fs.writeFileSync(target, "原文");
    const targetB = path.join(workspace, "target-b"); fs.writeFileSync(targetB, "原文B");
    let p: PersonalHarness | undefined, fileIo: PersonalFileIo | undefined, child: ReturnType<typeof spawn> | undefined;
    t.after(async () => { if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await p?.close().catch(() => undefined); await fileIo?.close().catch(() => undefined); await server.close(); if (previous === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = previous; fs.rmSync(root, { recursive: true, force: true }); });
    const script = `
      import { openPersonalHarness } from './apps/ruukoto/src/personal-harness.ts';
      import { personalProvider } from './apps/ruukoto/src/personal-model.ts';
      import { PersonalPermissionsDoc } from './apps/ruukoto/src/personal-permissions.ts';
      import { parsePersonalTools } from './apps/ruukoto/src/personal-tools-config.ts';
      import * as fs from 'node:fs';
      import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
      import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
      const input = JSON.parse(process.env.RUUKOTO_FILEIO_CRASH);
      const identity = fs.statSync(input.workspace), tools = parsePersonalTools({ version: 1, generation: "file-io-test", workspace: input.workspace, identity: { dev: identity.dev, ino: identity.ino }, credentials: [] });
      let executeJob;
      const p = await openPersonalHarness({directory:input.directory,provider:personalProvider(input.model),modelId:input.model.modelId,tools,
        openStorage: async filename => {
          const storage = await openNodeSqliteStorage(filename), commit = storage.commit.bind(storage);
          storage.commit = async (writes, context) => {
            for (const write of writes) if (write.type === 'entry' && write.value.kind === 'ruukoto.file-io-admission' && write.value.data?.phase === 'execute') executeJob = write.value.data.id;
            const kind = input.window === 'result' ? 'result' : 'dispatch';
            const hit = writes.some(write => write.type === 'entry' && (input.window === 'start' ? write.value.kind === 'ruukoto.tool-start' : write.value.kind === 'ruukoto.file-io-lifecycle' && write.value.data?.jobId === executeJob && write.value.data?.kind === kind));
            if (!hit) return commit(writes, context);
            if (input.window === 'pre-dispatch') { process.kill(process.pid, 'SIGKILL'); await new Promise(() => {}); }
            const out = await commit(writes, context);
            if (input.window !== 'pre-dispatch') process.kill(process.pid, 'SIGKILL');
            return out;
          }; return storage;
        }});
      await p.harness.commit(async tx => { const doc = await tx.doc(PersonalPermissionsDoc); doc.mode = 'full_access'; doc.version++; }, BACKGROUND_CONTEXT);
      await p.answer('写入目标', 'crash-src');
      await p.work.delegate({requestId:'crash-work',sourceRequestId:'crash-src',content:'tool:{"name":"write_file","args":{"path":' + JSON.stringify(input.target) + ',"content":"改写"}}'});
      await new Promise(resolve => setTimeout(resolve, 15000));
    `;
    child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: new URL("..", import.meta.url), env: { ...process.env, RUUKOTO_FILEIO_CRASH: JSON.stringify({ directory, workspace, target, model: config, window: w.name }) }, stdio: ["ignore", "pipe", "pipe"] });
    let errors = ""; child.stderr!.on("data", value => { errors += String(value); });
    const exit = new Promise(resolve => child!.on("exit", resolve));
    await until(() => child!.exitCode !== null || child!.signalCode !== null);
    await exit;
    assert.equal(child.signalCode, "SIGKILL", errors);

    let spawns = 0;
    fileIo = openPersonalFileIo({ profile: directory, workerProbe: () => { spawns++; } });
    const identity2 = fs.statSync(workspace), tools = parsePersonalTools({ version: 1, generation: "file-io-test", workspace, identity: { dev: identity2.dev, ino: identity2.ino }, credentials: [] });
    p = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, tools, fileIo });
    const ops = () => p!.harness.commit(async tx => JSON.parse(JSON.stringify(await toolOperations(tx))) as PersonalToolOperation[], context);
    await until(async () => (await ops()).some(value => value.observation !== undefined));
    assert.equal(spawns, 0, errors);
    const operation = (await ops()).at(-1)!;
    assert.equal(operation.kind, "write_file"); assert.equal(operation.started, true);
    assert.equal(operation.effect, w.effect); assert.equal(operation.code, "interrupted"); assert.equal(operation.stopped, true);
    assert.notEqual(operation.directoryClaim, undefined);
    assert.equal(fs.readFileSync(target, "utf8"), w.written ? "改写" : "原文");
    const jobs = await p.harness.commit(tx => personalFileIoJobs(tx), context);
    const attempt = jobs.find(job => job.phase === "execute")!;
    assert.ok(attempt);
    assert.equal(attempt.starting !== undefined, w.starting); assert.equal(attempt.dispatch !== undefined, w.dispatch);
    assert.equal(attempt.noDispatch !== undefined, w.noDispatch); assert.equal(attempt.released, undefined);
    assert.notEqual(attempt.hostEnded, undefined); assert.equal(attempt.exit, undefined); assert.equal(attempt.result !== undefined, w.result);
    assert.equal(attempt.settle?.outcome, w.outcome); assert.equal(attempt.settle?.code, w.code);
    assert.equal(attempt.seq, attempt.events.length);
    const lifecycle = await p.harness.commit(async tx => Promise.all(attempt.events.map(id => tx.entry(PersonalFileIoLifecycle, id))), context);
    assert.deepEqual(lifecycle.map(entry => entry!.data.kind), [...w.events]);
    if (w.blocker) {
      assert.ok(await p.harness.commit(tx => personalServiceSourceBlocker(tx, "crash-src"), context));
      await p.harness.commit(tx => toolResolve(tx, operation.operation, w.written ? "applied" : "not_applied", "独立核实原文件实际效果"), context);
      assert.equal(await p.harness.commit(tx => personalServiceSourceBlocker(tx, "crash-src"), context), undefined);
    } else {
      assert.equal(await p.harness.commit(tx => personalServiceSourceBlocker(tx, "crash-src"), context), undefined);
      await assert.rejects(p.harness.commit(tx => toolResolve(tx, operation.operation, "applied", "不应需核实"), context), code("tool_resolution_invalid"));
    }
    const replayed = await p.work.delegate({ requestId: "crash-work", sourceRequestId: "crash-src", content: `tool:{"name":"write_file","args":{"path":${JSON.stringify(target)},"content":"改写"}}` });
    assert.equal(replayed.taskId, operation.origin.work?.ref.taskId);
    assert.equal(spawns, 0);
    await p.answer("新来源", "b-src");
    const bTarget = w.effect === "not_executed" ? target : targetB;
    await p.work.delegate({ requestId: "crash-work-b", sourceRequestId: "b-src", content: `tool:{"name":"write_file","args":{"path":${JSON.stringify(bTarget)},"content":"B写"}}` });
    await until(() => fs.readFileSync(bTarget, "utf8") === "B写");
    assert.ok(spawns > 0);
  });
});

test("文件工作线程：真实控制后台下任一阶段持住不冻结无关链路", { timeout: 240_000 }, async t => {
  for (const phase of ["prepare", "revalidate", "execute"] as const) await t.test(`阶段 ${phase}`, { timeout: 60_000 }, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-p-"))), directory = path.join(root, "p"), workspace = path.join(root, "w"), fifo = path.join(root, "g"), marker = path.join(root, "entered");
    fs.mkdirSync(directory); fs.mkdirSync(workspace); execFileSync("mkfifo", [fifo]);
    const aTarget = path.join(workspace, "a"), bRead = path.join(workspace, "br"), bWrite = path.join(workspace, "b");
    fs.writeFileSync(aTarget, "旧A"); fs.writeFileSync(bRead, "x"); fs.writeFileSync(bWrite, "旧B");
    const writer = fs.openSync(fifo, fs.constants.O_RDWR);
    const server = new MockModelServer(request => {
      const last = request.messages.at(-1), content = String(last?.content);
      if (last?.role === "tool") return { kind: "text", text: `回执:${content}` };
      if (content.startsWith("tool:")) { const { name, args } = JSON.parse(content.slice(5)) as { name: string; args: Record<string, unknown> }; return { kind: "tool_calls", calls: [{ id: "file-call", name, arguments: args }] }; }
      if (content.startsWith("委派:")) return { kind: "tool_calls", calls: [{ id: "delegate", name: "background_work", arguments: { action: "delegate", content: content.slice(3) } }] };
      return { kind: "text", text: `普通:${content}` };
    });
    const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await server.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_FILEIO_TEST_KEY", contextWindow: 128000, maxTokens: 8192 };
    const previousKey = process.env[config.apiKeyEnv]; process.env[config.apiKeyEnv] = "test-only";
    const previous = FIFO_ENV.map(name => process.env[name]);
    process.env.RK_FILE_IO_HOLD = aTarget; process.env.RK_FILE_IO_FIFO = fifo; process.env.RK_FILE_IO_MARKER = marker;
    process.env.RK_FILE_IO_PHASE = phase; process.env.RK_FILE_IO_BUNDLE = new URL("../worker/personal-file-worker.mjs", import.meta.url).href;
    const identity = fs.statSync(workspace), tools = parsePersonalTools({ version: 1, generation: "file-io-test", workspace, identity: { dev: identity.dev, ino: identity.ino }, credentials: [] });
    await savePersonalConfig(directory, config); await savePersonalTools(directory, tools);
    const fileIo = openPersonalFileIo({ profile: directory, script: FIFO_WRAPPER });
    let backend: Awaited<ReturnType<typeof startPersonalServer>> | undefined;
    t.after(async () => {
      try { fs.writeSync(writer, Buffer.alloc(64)); } catch {} try { fs.closeSync(writer); } catch {}
      await backend?.stop().catch(() => undefined); await fileIo.close().catch(() => undefined); await server.close();
      FIFO_ENV.forEach((name, index) => { const value = previous[index]; if (value === undefined) delete process.env[name]; else process.env[name] = value; });
      if (previousKey === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = previousKey;
      fs.rmSync(root, { recursive: true, force: true });
    });
    backend = await startPersonalServer(directory, { fileIo });
    await personalControl(directory, "POST", "/permissions", { mode: "full_access" });
    const aId = randomUUID(), mainId = randomUUID(), bReadId = randomUUID(), bWriteId = randomUUID();
    const input = (requestId: string, value: string) => personalControl(directory, "POST", "/inputs", { requestId, input: value });
    const status = async (requestId: string) => (await personalControl<{ status: string; answer?: string }>(directory, "GET", `/input?requestId=${requestId}`)).status;
    await input(aId, `委派:tool:{"name":"write_file","args":{"path":${JSON.stringify(aTarget)},"content":"A写"}}`);
    await until(() => fs.existsSync(marker));

    await input(mainId, "主查询");
    await until(async () => (await status(mainId)) === "done");
    assert.ok((await personalControl(directory, "GET", "/status")) !== undefined);
    assert.ok(Array.isArray((await personalControl<{ items: unknown[] }>(directory, "GET", "/works")).items));
    const permissions = await personalControl<{ default: { mode: string } }>(directory, "GET", "/permissions");
    assert.equal(permissions.default.mode, "full_access");
    await input(bReadId, `委派:tool:{"name":"read_file","args":{"path":${JSON.stringify(bRead)}}}`);
    await until(async () => (await status(bReadId)) === "done");
    await input(bWriteId, `委派:tool:{"name":"write_file","args":{"path":${JSON.stringify(bWrite)},"content":"B写"}}`);
    await until(() => fs.readFileSync(bWrite, "utf8") === "B写", 45_000);
    assert.equal(fs.readFileSync(aTarget, "utf8"), "旧A");

    fs.writeSync(writer, Buffer.alloc(64));
    await until(() => fs.readFileSync(aTarget, "utf8") === "A写", 30_000);
    fs.closeSync(writer);
    await backend.stop(); backend = undefined;
    await fileIo.close();
  });
});

const STORAGE_FAILURE = defineEntry<{ marker: true }>("ruukoto.test-file-storage-failure");

test("文件工作线程：期限按阶段分类记超时，占用保留到真实退出为止", { timeout: 300_000 }, async t => {
  for (const phase of ["prepare", "revalidate", "execute"] as const)
    await t.test(`阶段 ${phase}`, { timeout: 90_000 }, async t => {
      const f = fifoFixture(t, `rk-file-io-dl-${phase}-`);
      const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), `rk-file-io-dlp-${phase}-`))), directory = path.join(root, "profile"), workspace = path.join(root, "workspace"), outside = path.join(root, "outside");
      fs.mkdirSync(directory); fs.mkdirSync(workspace); fs.mkdirSync(outside);
      const aTarget = path.join(phase === "revalidate" ? outside : workspace, "a"), bTarget = path.join(workspace, "b");
      fs.writeFileSync(aTarget, "原文"); fs.writeFileSync(bTarget, "旧B");
      process.env.RK_FILE_IO_HOLD = aTarget; process.env.RK_FILE_IO_PHASE = phase;
      const server = new MockModelServer(request => {
        const last = request.messages.at(-1), content = String(last?.content);
        if (last?.role === "tool") return { kind: "text", text: `回执:${content}` };
        if (content.startsWith("tool:")) { const { name, args } = JSON.parse(content.slice(5)) as { name: string; args: Record<string, unknown> }; return { kind: "tool_calls", calls: [{ id: "file-call", name, arguments: args }] }; }
        return { kind: "text", text: `普通:${content}` };
      });
      const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await server.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_FILEIO_TEST_KEY", contextWindow: 128000, maxTokens: 8192 };
      const previousKey = process.env[config.apiKeyEnv]; process.env[config.apiKeyEnv] = "test-only";
      const identity = fs.statSync(workspace), tools = parsePersonalTools({ version: 1, generation: "file-io-test", workspace, identity: { dev: identity.dev, ino: identity.ino }, credentials: [] });
      const probes: Array<[Worker, PersonalFileJobMeta]> = [];
      const fileIo = openPersonalFileIo({ profile: fs.realpathSync(directory), script: FIFO_WRAPPER, deadlineMs: 2000, terminationGraceMs: 100, workerProbe: (worker, meta) => probes.push([worker, meta]) });
      let p: PersonalHarness | undefined;
      t.after(async () => { await p?.close().catch(() => undefined); await fileIo.close().catch(() => undefined); await server.close(); if (previousKey === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = previousKey; fs.rmSync(root, { recursive: true, force: true }); });
      p = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, tools, fileIo });
      const ops = async () => p!.harness.commit(async tx => JSON.parse(JSON.stringify(await toolOperations(tx))) as PersonalToolOperation[], context);
      const heldJob = async () => (await p!.harness.commit(tx => personalFileIoJobs(tx), context)).find(job => job.phase === phase && (job.request as { path?: string }).path === aTarget);
      const heldProbe = () => probes.find(([, meta]) => meta.phase === phase && (meta.request as { path?: string }).path === aTarget);
      await p.harness.commit(async tx => { const doc = await tx.doc(PersonalPermissionsDoc); doc.mode = phase === "revalidate" ? "confirm" : "full_access"; doc.version++; }, context);
      await p.answer("A", "a-src");
      const aWork = await p.work.delegate({ requestId: "a-work", sourceRequestId: "a-src", content: `tool:{"name":"write_file","args":{"path":${JSON.stringify(aTarget)},"content":"A写"}}` });
      let decided: PersonalToolOperation | undefined;
      if (phase === "revalidate") {
        await until(async () => (await ops()).some(value => value.kind === "write_file" && value.approval === "pending"));
        const pending = (await ops()).at(-1)!;
        await p.harness.commit(tx => toolDecide(tx, pending.operation, "approved", directory), context);
        decided = (await ops()).at(-1)!;
        assert.equal(decided.approval, "approved"); assert.notEqual(decided.decisionEntry, undefined);
      }
      await until(() => heldProbe() !== undefined && fs.existsSync(`${f.marker}.${heldProbe()![1].id}`));
      await until(async () => (await heldJob())?.settle !== undefined && (await heldJob())?.terminate !== undefined);
      await until(async () => phase === "prepare" || (await ops()).at(-1)?.code === "file_io_timeout");
      const settled = (await heldJob())!;
      assert.equal(settled.settle?.outcome, "timeout"); assert.equal(settled.settle?.code, "file_io_timeout");
      assert.notEqual(settled.terminate, undefined); assert.equal(settled.exit, undefined); assert.equal(settled.result, undefined);
      assert.equal(fs.readFileSync(aTarget, "utf8"), "原文");
      assert.notEqual(await p.harness.commit(tx => personalServiceSourceBlocker(tx, "a-src"), context), undefined);
      assert.notEqual(await p.harness.commit(tx => personalFileIoWorkBlocker(tx, aWork.taskId), context), undefined);
      await assert.rejects(p.work.delegate({ requestId: "a-again", sourceRequestId: "a-src", content: `tool:{"name":"read_file","args":{"path":${JSON.stringify(f.other)}}}` }), code("work_source_paused"));
      if (phase === "prepare") {
        assert.equal((await ops()).some(value => value.prepared.kind === "file" && value.prepared.request.path === aTarget), false);
      } else {
        const record = (await ops()).at(-1)!;
        if (phase === "revalidate") {
          assert.equal(record.started, false); assert.equal(record.effect, "not_executed"); assert.equal(record.code, "file_io_timeout");
          assert.equal(record.approval, "approved"); assert.equal(record.decisionEntry, decided!.decisionEntry); assert.equal(record.stopped, false);
          assert.equal(record.startEntry, undefined); assert.equal(record.directoryClaim, undefined); assert.notEqual(record.observation, undefined);
          await assert.rejects(p.harness.commit(tx => toolDecide(tx, record.operation, "approved", directory), context), code("tool_decision_invalid"));
        } else {
          assert.equal(record.started, true); assert.equal(record.effect, "effect_unknown"); assert.equal(record.code, "file_io_timeout");
          assert.equal(record.stopped, false); assert.equal(record.fileJob, settled.id); assert.equal(record.fileJobUnverified, true);
          assert.ok(record.directoryClaim); assert.notEqual(record.startEntry, undefined);
          assert.equal((await p.harness.commit(tx => toolDetail(tx, record.operation), context)).summary.canVerifyStop, false);
          await p.answer("B", "b-src");
          await p.work.delegate({ requestId: "b-read", sourceRequestId: "b-src", content: `tool:{"name":"read_file","args":{"path":${JSON.stringify(f.other)}}}` });
          await until(async () => (await ops()).some(value => value.kind === "read_file" && value.observation !== undefined && value.code === "file_returned"));
          await p.answer("B写", "b-src-2");
          await p.work.delegate({ requestId: "b-write", sourceRequestId: "b-src-2", content: `tool:{"name":"write_file","args":{"path":${JSON.stringify(bTarget)},"content":"B写"}}` });
          await until(() => fs.readFileSync(bTarget, "utf8") === "B写");
          await p.harness.commit(tx => toolResolve(tx, record.operation, "not_applied", "期限超时后目标未写入"), context);
          assert.notEqual((await ops()).find(value => value.operation === record.operation)!.resolution, undefined);
          assert.notEqual(await p.harness.commit(tx => personalServiceSourceBlocker(tx, "a-src"), context), undefined);
          const stat = fs.statSync(aTarget);
          await assert.rejects(p.harness.commit(tx => acquirePersonalDirectory(tx, { kind: "file", operation: (record.operation + 4096) as PersonalToolOperation["operation"] }, { path: aTarget, dev: stat.dev, ino: stat.ino }), context), code("directory_claim_busy"));
          await assert.rejects(p.harness.commit(tx => toolVerifyStop(tx, record.operation, "独立核实停止证据"), context), code("file_io_stop_unverified"));
        }
      }
      assert.notEqual(await p.harness.commit(async tx => (await tx.task(aWork.taskId))?.state.status, context), "terminal");
      f.release(1);
      await until(async () => (await heldJob())?.exit !== undefined);
      await until(async () => (await p!.harness.commit(tx => personalServiceSourceBlocker(tx, "a-src"), context)) === undefined);
      await p.harness.waitForTask(aWork.taskId, context);
      assert.equal(await p.harness.commit(async tx => (await tx.task(aWork.taskId))?.state.status, context), "terminal");
      assert.equal(fs.readFileSync(aTarget, "utf8"), "原文");
      await p.close(); p = undefined;
    });
});

test("文件工作线程：宿主注入IPC的迟到有效应答不覆盖原结算", { timeout: 90_000 }, async t => {
  for (const mode of ["deadline", "cancel"] as const)
    await t.test(mode === "deadline" ? "期限先行" : "取消先行", { timeout: 45_000 }, async t => {
      const f = fifoFixture(t, `rk-file-io-late-${mode}-`);
      process.env.RK_FILE_IO_PHASE = "execute";
      const controller = new AbortController(), workers = new Map<string, Worker>(), metas = new Map<string, PersonalFileJobMeta>();
      const io = openPersonalFileIo({ script: FIFO_WRAPPER, deadlineMs: 800, terminationGraceMs: 100, workerProbe: (worker, meta) => { workers.set(meta.id, worker); metas.set(meta.id, meta); } });
      t.after(async () => { f.release(4); await io.close().catch(() => undefined); });
      const prepared = await io.prepare({ path: f.held, access: "read", protectedRoots: [] });
      const events: string[] = [];
      const job = io.execute(prepared, { phase: "execute", ...(mode === "cancel" ? { signal: controller.signal } : {}), record: event => { events.push(event.kind); return Promise.resolve(); } }).then(() => "resolved", (error: unknown) => String((error as PersonalError).code));
      await until(() => [...metas.values()].some(meta => meta.phase === "execute" && fs.existsSync(`${f.marker}.${meta.id}`)));
      const meta = [...metas.values()].find(meta => meta.phase === "execute")!, worker = workers.get(meta.id)!;
      if (mode === "cancel") controller.abort();
      assert.equal(await job, mode === "cancel" ? "file_io_canceled" : "file_io_timeout");
      await until(() => events.includes("settle") && events.includes("terminate"));
      assert.ok(worker.threadId > 0);
      worker.emit("message", { id: meta.id, phase: "execute", op: "execute", ok: true, result: { effect: "returned", code: "file_returned", bytes: new TextEncoder().encode("原文"), partial: false } });
      await until(() => events.includes("result"));
      assert.equal(events.filter(kind => kind === "settle").length, 1);
      f.release(1);
      await until(() => events.includes("exit") && worker.threadId < 0);
      assert.deepEqual(events, ["admit", "starting", "dispatch", "settle", "terminate", "result", "exit"]);
      const follow = await io.execute(await io.prepare({ path: f.other, access: "read", protectedRoots: [] }));
      assert.equal(follow.code, "file_returned");
      await io.close();
    });
});

test("文件工作线程：停止未核实前关闭保留锁，证据放行后关闭与重开正常", { timeout: 180_000 }, async t => {
  const responder = (request: { messages: Array<{ role?: string; content?: unknown }> }) => {
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "tool") return { kind: "text" as const, text: `回执:${content}` };
    if (content.startsWith("tool:")) { const { name, args } = JSON.parse(content.slice(5)) as { name: string; args: Record<string, unknown> }; return { kind: "tool_calls" as const, calls: [{ id: "file-call", name, arguments: args }] }; }
    if (content.startsWith("委派:")) return { kind: "tool_calls" as const, calls: [{ id: "delegate", name: "background_work", arguments: { action: "delegate", content: content.slice(3) } }] };
    return { kind: "text" as const, text: `普通:${content}` };
  };
  await t.test("工作线程持住", { timeout: 90_000 }, async t => {
    const f = fifoFixture(t, "rk-file-io-srv-");
    const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-file-io-srv-"))), directory = path.join(root, "profile"), workspace = path.join(root, "workspace");
    fs.mkdirSync(directory); fs.mkdirSync(workspace);
    const aTarget = path.join(workspace, "a"); fs.writeFileSync(aTarget, "原文");
    process.env.RK_FILE_IO_HOLD = aTarget; process.env.RK_FILE_IO_PHASE = "prepare";
    const server = new MockModelServer(responder);
    const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await server.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_FILEIO_TEST_KEY", contextWindow: 128000, maxTokens: 8192 };
    const previousKey = process.env[config.apiKeyEnv]; process.env[config.apiKeyEnv] = "test-only";
    const identity = fs.statSync(workspace), tools = parsePersonalTools({ version: 1, generation: "file-io-test", workspace, identity: { dev: identity.dev, ino: identity.ino }, credentials: [] });
    await savePersonalConfig(directory, config); await savePersonalTools(directory, tools);
    const workers: Worker[] = [];
    const fileIo = openPersonalFileIo({ profile: directory, script: FIFO_WRAPPER, terminationGraceMs: 100, workerProbe: worker => workers.push(worker) });
    let backend: Awaited<ReturnType<typeof startPersonalServer>> | undefined;
    t.after(async () => { await backend?.stop().catch(() => undefined); await fileIo.close().catch(() => undefined); await server.close(); if (previousKey === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = previousKey; fs.rmSync(root, { recursive: true, force: true }); });
    backend = await startPersonalServer(directory, { fileIo });
    await personalControl(directory, "POST", "/permissions", { mode: "full_access" });
    const aId = randomUUID(), qId = randomUUID();
    await personalControl(directory, "POST", "/inputs", { requestId: aId, input: `委派:tool:{"name":"write_file","args":{"path":${JSON.stringify(aTarget)},"content":"A写"}}` });
    await until(() => workers.length > 0 && fs.existsSync(f.marker));
    await assert.rejects(backend.stop(), code("file_io_stop_unverified"));
    assert.ok((await personalControl(directory, "GET", "/status")) !== undefined);
    await personalControl(directory, "POST", "/inputs", { requestId: qId, input: "普通查询" });
    await until(async () => (await personalControl<{ status: string }>(directory, "GET", `/input?requestId=${qId}`)).status === "done");
    await assert.rejects(fileIo.prepare({ path: f.other, access: "read", protectedRoots: [] }), code("file_io_closed"));
    assert.throws(() => lockPersonalProfile(directory), code("profile_busy"));
    f.release(1);
    await until(() => workers.every(worker => worker.threadId < 0));
    await backend.stop(); backend = undefined;
    const reopened = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, tools });
    await reopened.close();
  });
  await t.test("回执证据持住", { timeout: 90_000 }, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-file-io-gate-"))), directory = path.join(root, "profile"), workspace = path.join(root, "workspace");
    fs.mkdirSync(directory); fs.mkdirSync(workspace);
    const aTarget = path.join(workspace, "a"); fs.writeFileSync(aTarget, "原文");
    const server = new MockModelServer(responder);
    const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await server.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_FILEIO_TEST_KEY", contextWindow: 128000, maxTokens: 8192 };
    const previousKey = process.env[config.apiKeyEnv]; process.env[config.apiKeyEnv] = "test-only";
    const identity = fs.statSync(workspace), tools = parsePersonalTools({ version: 1, generation: "file-io-test", workspace, identity: { dev: identity.dev, ino: identity.ino }, credentials: [] });
    const workers: Worker[] = [];
    let releaseGate!: () => void; const gate = new Promise<void>(resolve => releaseGate = resolve); let heldResults = 0;
    const inner = openPersonalFileIo({ profile: fs.realpathSync(directory), terminationGraceMs: 100, workerProbe: worker => workers.push(worker) });
    const wrap = (ctx?: PersonalFileJobContext): PersonalFileJobContext | undefined => ctx?.record === undefined ? ctx : { ...ctx, record: async (event: PersonalFileIoEvent) => { if (ctx.phase === "execute" && event.kind === "result") { heldResults++; await gate; } await ctx.record!(event); } };
    const fileIo: PersonalFileIo = { prepare: (input, ctx) => inner.prepare(input, wrap(ctx)), execute: (request, ctx) => inner.execute(request, wrap(ctx)), reserve: (request, ctx) => inner.reserve(request, wrap(ctx)), close: () => inner.close() };
    let p: PersonalHarness | undefined;
    t.after(async () => { releaseGate(); await p?.close().catch(() => undefined); await fileIo.close().catch(() => undefined); await server.close(); if (previousKey === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = previousKey; fs.rmSync(root, { recursive: true, force: true }); });
    p = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, tools, fileIo });
    await p.harness.commit(async tx => { const doc = await tx.doc(PersonalPermissionsDoc); doc.mode = "full_access"; doc.version++; }, context);
    await p.answer("A", "a-src");
    await p.work.delegate({ requestId: "a-work", sourceRequestId: "a-src", content: `tool:{"name":"write_file","args":{"path":${JSON.stringify(aTarget)},"content":"A写"}}` });
    const ops = async () => p!.harness.commit(async tx => JSON.parse(JSON.stringify(await toolOperations(tx))) as PersonalToolOperation[], context);
    await until(() => heldResults === 1 && workers.length > 0 && workers.every(worker => worker.threadId < 0));
    assert.equal((await ops()).at(-1)!.observation, undefined);
    await assert.rejects(p.close(), code("file_io_stop_unverified"));
    assert.throws(() => lockPersonalProfile(directory), code("profile_busy"));
    releaseGate();
    await until(async () => (await ops()).at(-1)!.observation !== undefined);
    await p.close(); p = undefined;
    const reopened = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, tools });
    const jobs = await reopened.harness.commit(tx => personalFileIoJobs(tx), context);
    const execute = jobs.find(job => job.phase === "execute")!;
    assert.equal(execute.result?.ok, true); assert.equal(execute.settle?.outcome, "result"); assert.notEqual(execute.exit, undefined);
    await reopened.close();
  });
});

test("文件工作线程：会话故障保留内存回执，重开时按原宿主对账且不造新停止证据", { timeout: 120_000 }, async t => {
  const f = fifoFixture(t, "rk-file-io-sess-");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-file-io-sess-"))), directory = path.join(root, "profile"), workspace = path.join(root, "workspace");
  fs.mkdirSync(directory); fs.mkdirSync(workspace);
  const aTarget = path.join(workspace, "a"), bTarget = path.join(workspace, "b");
  fs.writeFileSync(aTarget, "原文"); fs.writeFileSync(bTarget, "旧B");
  process.env.RK_FILE_IO_HOLD = aTarget; process.env.RK_FILE_IO_PHASE = "execute";
  const server = new MockModelServer(request => {
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "tool") return { kind: "text", text: `回执:${content}` };
    if (content.startsWith("tool:")) { const { name, args } = JSON.parse(content.slice(5)) as { name: string; args: Record<string, unknown> }; return { kind: "tool_calls", calls: [{ id: "file-call", name, arguments: args }] }; }
    return { kind: "text", text: `普通:${content}` };
  });
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await server.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_FILEIO_TEST_KEY", contextWindow: 128000, maxTokens: 8192 };
  const previousKey = process.env[config.apiKeyEnv]; process.env[config.apiKeyEnv] = "test-only";
  const identity = fs.statSync(workspace), tools = parsePersonalTools({ version: 1, generation: "file-io-test", workspace, identity: { dev: identity.dev, ino: identity.ino }, credentials: [] });
  const workers = new Map<string, Worker>(); let aSpawns = 0;
  const fileIo = openPersonalFileIo({ profile: fs.realpathSync(directory), script: FIFO_WRAPPER, terminationGraceMs: 100, workerProbe: (worker, meta) => { workers.set(meta.id, worker); if (meta.phase === "execute" && (meta.request as { path?: string }).path === aTarget) aSpawns++; } });
  let failed = false, p: PersonalHarness | undefined;
  t.after(async () => { await p?.close().catch(() => undefined); await fileIo.close().catch(() => undefined); await server.close(); if (previousKey === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = previousKey; fs.rmSync(root, { recursive: true, force: true }); });
  p = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, tools, fileIo, openStorage: async filename => {
    const storage = await openNodeSqliteStorage(filename), commit = storage.commit.bind(storage);
    storage.commit = async (writes, ctx) => { if (!failed && writes.some(write => write.type === "entry" && write.value.kind === "ruukoto.test-file-storage-failure")) { failed = true; throw new Error("ruukoto-test-storage-failure"); } return commit(writes, ctx); };
    return storage;
  } });
  const ops = async () => p!.harness.commit(async tx => JSON.parse(JSON.stringify(await toolOperations(tx))) as PersonalToolOperation[], context);
  await p.harness.commit(async tx => { const doc = await tx.doc(PersonalPermissionsDoc); doc.mode = "full_access"; doc.version++; }, context);
  await p.answer("A", "a-src");
  const aWork = await p.work.delegate({ requestId: "a-work", sourceRequestId: "a-src", content: `tool:{"name":"write_file","args":{"path":${JSON.stringify(aTarget)},"content":"A写"}}` });
  await until(async () => aSpawns === 1 && fs.existsSync(`${f.marker}.${(await p!.harness.commit(tx => personalFileIoJobs(tx), context)).find(job => job.phase === "execute" && (job.request as { path?: string }).path === aTarget)?.id}`));
  const aJob = (await p.harness.commit(tx => personalFileIoJobs(tx), context)).find(job => job.phase === "execute" && (job.request as { path?: string }).path === aTarget)!;
  const aWorker = workers.get(aJob.id)!, originHost = JSON.parse(JSON.stringify(aJob.host)) as typeof aJob.host;
  assert.notEqual(aJob.dispatch, undefined); assert.equal(aJob.settle, undefined); assert.equal(aJob.exit, undefined);
  await assert.rejects(p.harness.commit(async tx => { await tx.appendEntry(STORAGE_FAILURE, ROOT_CONVERSATION_ID, { data: { marker: true } }); }, context));
  assert.equal(failed, true);
  await p.harness.closed.catch(() => undefined);
  assert.throws(() => lockPersonalProfile(directory), code("profile_busy"));
  assert.ok(aWorker.threadId > 0);
  const waited = await Promise.race([p.harness.waitForTask(aWork.taskId, context).then(() => "settled", (error: unknown) => String((error as PersonalError).code ?? error)), delay(5000).then(() => "hung")]);
  assert.notEqual(waited, "hung"); assert.notEqual(waited, "settled");
  f.release(1);
  await until(() => aWorker.threadId < 0);
  await p.close(); p = undefined;
  const fileIo2 = openPersonalFileIo({ profile: fs.realpathSync(directory) });
  t.after(() => fileIo2.close().catch(() => undefined));
  const p2 = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, tools, fileIo: fileIo2 });
  t.after(() => p2.close().catch(() => undefined));
  assert.equal(personalFileIoPersistenceFailed(fs.realpathSync(directory)), false);
  const recovered = (await p2.harness.commit(tx => personalFileIoJobs(tx), context)).find(job => job.id === aJob.id)!;
  assert.equal(recovered.seq, 5); assert.equal(recovered.events.length, 5);
  assert.equal(recovered.settle?.outcome, "canceled"); assert.equal(recovered.settle?.code, "file_io_closed");
  assert.notEqual(recovered.terminate, undefined); assert.equal(recovered.exit?.code, 1);
  assert.equal(recovered.hostEnded, undefined); assert.equal(recovered.result, undefined); assert.deepEqual(recovered.host, originHost);
  const op = (await p2.harness.commit(async tx => JSON.parse(JSON.stringify(await toolOperations(tx))) as PersonalToolOperation[], context)).find(value => value.started)!;
  assert.equal(op.effect, "effect_unknown"); assert.equal(op.code, "interrupted"); assert.equal(op.stopped, true); assert.ok(op.directoryClaim);
  assert.equal(fs.readFileSync(aTarget, "utf8"), "原文"); assert.equal(aSpawns, 1);
  const stat = fs.statSync(aTarget);
  await assert.rejects(p2.harness.commit(tx => acquirePersonalDirectory(tx, { kind: "file", operation: (op.operation + 4096) as PersonalToolOperation["operation"] }, { path: aTarget, dev: stat.dev, ino: stat.ino }), context), code("directory_claim_busy"));
  await p2.answer("B", "b-src");
  await p2.work.delegate({ requestId: "b-write", sourceRequestId: "b-src", content: `tool:{"name":"write_file","args":{"path":${JSON.stringify(bTarget)},"content":"B写"}}` });
  await until(() => fs.readFileSync(bTarget, "utf8") === "B写");
  await p2.harness.commit(tx => toolResolve(tx, op.operation, "not_applied", "会话故障后原写未发生"), context);
  assert.equal(await p2.harness.commit(tx => personalServiceSourceBlocker(tx, "a-src"), context), undefined);
  await until(async () => (await p2.harness.commit(tx => personalFileIoJobs(tx), context)).every(job => job.exit !== undefined));
  await p2.close(); await fileIo2.close();
});
