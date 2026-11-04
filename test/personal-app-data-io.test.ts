import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { Worker } from "node:worker_threads";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { AppDataError } from "@ruukoto/agent/app-data/store.ts";
import { personalAppDataIo, type PersonalAppDataIo, type PersonalAppDataJob } from "../apps/ruukoto/src/personal-app-data-io.ts";

const code = (expected: string) => (error: unknown) => error instanceof AppDataError && error.code === expected;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => resolve = done); return { promise, resolve }; }
async function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "rk-app-data-io-"));
  const database = { file: path.join(directory, "main.db"), instanceId: `appdb_${randomUUID()}` };
  const runners: PersonalAppDataIo[] = [];
  const open = (options: Parameters<typeof personalAppDataIo>[0] = {}) => { const io = personalAppDataIo(options); runners.push(io); return io; };
  t.after(async () => { await Promise.all(runners.map(io => io.close())); fs.rmSync(directory, { recursive: true, force: true }); });
  const reader = open();
  await reader.run({ ...database, kind: "initialize" });
  await reader.run({ ...database, kind: "execute", opId: "define", ctx: { taskId: "define-task", sessionId: "session", agentId: "child" }, write: { name: "app_data_define_table", params: { table: "todos", fields: [{ name: "title", type: "text" }], expected_schema_version: 0, reason: "Prepare worker lifecycle fixture" } } });
  const write = (opId: string, title = opId): Extract<PersonalAppDataJob, { kind: "execute" }> => ({ ...database, kind: "execute", opId, ctx: { taskId: `${opId}-task`, sessionId: "session", agentId: "child", expectedRevision: 1 }, write: { name: "app_data_insert", params: { table: "todos", records: [{ title }], expected_schema_version: 1, reason: "Check original operation receipt" } } });
  const receipt = (opId: string) => reader.run({ ...database, kind: "receipt", opId, taskId: `${opId}-task` });
  const rows = () => reader.run({ ...database, kind: "query", request: { mode: "rows", table: "todos" } });
  const absent = async (opId: string) => { const result = await receipt(opId); assert.deepEqual(result.versions, { schemaVersion: 1, revision: 1 }); assert.equal(result.receipt, null); assert.equal(result.hasTaskReceipt, false); assert.deepEqual((await rows()).rows, []); };
  const fresh = async (io: PersonalAppDataIo) => { await io.run(write("fresh")); const result = await receipt("fresh"); assert.equal(result.receipt?.opId, "fresh"); assert.equal(result.hasTaskReceipt, true); assert.deepEqual(result.versions, { schemaVersion: 1, revision: 2 }); assert.deepEqual((await rows()).rows, [{ _id: 1, _version: 1, title: "fresh" }]); };
  return { database, open, write, reader, receipt, rows, absent, fresh };
}

test("Personal app-data IO: aborted, timed out, and terminated writes exit before rejection and permit a fresh operation", { timeout: 30000 }, async t => {
  for (const fault of ["abort", "deadline", "terminate"] as const) await t.test(fault, async t => {
    const f = await fixture(t), online = deferred();
    const events: string[] = [];
    let original!: Worker, hold = true;
    const options = { deadlineMs: 2000, stallMs: (kind: PersonalAppDataJob["kind"]) => hold && kind === "execute" ? 5000 : 0, workerProbe: (worker: Worker, job: PersonalAppDataJob) => { if (job.kind !== "execute" || job.opId !== "original") return; original = worker; worker.once("online", online.resolve); worker.once("exit", () => events.push("exit")); } };
    const io = f.open(options), canceled = withCancel(BACKGROUND_CONTEXT);
    if (fault === "deadline") options.deadlineMs = 500;
    const rejection = assert.rejects(io.run(f.write("original"), canceled.context), code(fault === "abort" ? "app_data_io_canceled" : fault === "deadline" ? "app_data_io_timeout" : "app_data_io_failed")).then(() => events.push("rejected"));
    await online.promise;
    assert.equal(io.inFlight, 1); assert.ok(original.threadId > 0);
    if (fault === "abort") canceled.cancel();
    else if (fault === "terminate") await original.terminate();
    await rejection;
    assert.deepEqual(events, ["exit", "rejected"]); assert.equal(original.threadId, -1); assert.equal(io.inFlight, 0);
    await f.absent("original");
    hold = false; options.deadlineMs = 2000;
    await f.fresh(io);
    assert.equal((await f.receipt("original")).receipt, null); assert.equal(io.inFlight, 0);
  });
});

test("Personal app-data IO: close waits for every query and writer exit before releasing the database", { timeout: 15000 }, async t => {
  const f = await fixture(t), bothOnline = deferred();
  const workers: Worker[] = [], events: string[] = [];
  let online = 0;
  const io = f.open({ stallMs: () => 5000, workerProbe: (worker, job) => { workers.push(worker); worker.once("online", () => { if (++online === 2) bothOnline.resolve(); }); worker.once("exit", () => events.push(`${job.kind}:exit`)); } });
  const rejectedWrite = assert.rejects(io.run(f.write("original")), code("app_data_io_failed"));
  const rejectedQuery = assert.rejects(io.run({ ...f.database, kind: "query", request: { mode: "rows", table: "todos" } }), code("app_data_io_failed"));
  await bothOnline.promise; assert.equal(io.inFlight, 2);
  await io.close(); events.push("closed");
  await Promise.all([rejectedWrite, rejectedQuery]);
  assert.equal(events.at(-1), "closed"); assert.equal(events.filter(event => event.endsWith(":exit")).length, 2);
  assert.ok(workers.every(worker => worker.threadId === -1)); assert.equal(io.inFlight, 0);
  await f.absent("original");
  await assert.rejects(io.run(f.write("closed-attempt")), code("app_data_io_canceled")); assert.equal(workers.length, 2);
  await f.fresh(f.reader);
});

test("Personal app-data IO: canceled query waits for exit and changes neither revisions nor receipts", { timeout: 15000 }, async t => {
  const f = await fixture(t), online = deferred(), canceled = withCancel(BACKGROUND_CONTEXT);
  let worker!: Worker, exited = false, hold = true;
  const io = f.open({ stallMs: kind => hold && kind === "query" ? 5000 : 0, workerProbe: current => { worker = current; current.once("online", online.resolve); current.once("exit", () => exited = true); } });
  const stopped = assert.rejects(io.run({ ...f.database, kind: "query", request: { mode: "rows", table: "todos" } }, canceled.context), code("app_data_io_canceled"));
  await online.promise; canceled.cancel(); await stopped;
  assert.equal(exited, true); assert.equal(worker.threadId, -1); assert.equal(io.inFlight, 0);
  await f.absent("original");
  hold = false;
  const result = await io.run({ ...f.database, kind: "query", request: { mode: "schema" } }); assert.equal(result.revision, 1); assert.equal(io.inFlight, 0);
});

test("Personal app-data IO: an already canceled context creates no worker or write", async t => {
  const f = await fixture(t), canceled = withCancel(BACKGROUND_CONTEXT);
  let spawns = 0;
  const io = f.open({ workerProbe: () => spawns++ }); canceled.cancel();
  await assert.rejects(io.run(f.write("original"), canceled.context), code("app_data_io_canceled"));
  assert.equal(spawns, 0); assert.equal(io.inFlight, 0); await f.absent("original"); await f.fresh(io);
});

test("Personal app-data IO: successful reply remains unusable until the exact writer exits", async t => {
  const f = await fixture(t), events: string[] = [];
  let writer!: Worker;
  const io = f.open({ workerProbe: (worker, job) => { if (job.kind !== "execute") return; writer = worker; worker.once("message", () => { events.push("reply"); assert.equal(io.inFlight, 1); }); worker.once("exit", () => events.push("exit")); } });
  await io.run(f.write("fresh")).then(() => events.push("settled"));
  assert.deepEqual(events, ["reply", "exit", "settled"]); assert.equal(writer.threadId, -1); assert.equal(io.inFlight, 0);
  const result = await f.receipt("fresh"); assert.equal(result.receipt?.opId, "fresh"); assert.equal(result.hasTaskReceipt, true); assert.deepEqual(result.versions, { schemaVersion: 1, revision: 2 });
});

test("Personal app-data IO: concurrent schema and rows reads wait for the original SQLite lock without misclassifying the database", { timeout: 15000 }, async t => {
  const f = await fixture(t), bothOnline = deferred();
  const lock = new DatabaseSync(f.database.file);
  lock.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;");
  const workers: Worker[] = [], events: string[] = [];
  let online = 0;
  const io = f.open({ workerProbe(worker, job) {
    workers.push(worker);
    worker.once("online", () => { if (++online === 2) bothOnline.resolve(); });
    worker.once("message", () => events.push(`${job.kind}:reply`));
    worker.once("exit", () => events.push(`${job.kind}:exit`));
  } });
  const results = Promise.allSettled([
    io.run({ ...f.database, kind: "query", request: { mode: "schema" } }),
    io.run({ ...f.database, kind: "query", request: { mode: "rows", table: "todos" } }),
  ]);
  try {
    await bothOnline.promise; await delay(200);
    assert.equal(events.length, 0); assert.equal(io.inFlight, 2); assert.ok(workers.every(worker => worker.threadId > 0));
  } finally { lock.close(); }
  const [schema, rows] = await results;
  assert.equal(schema.status, "fulfilled"); assert.equal(rows.status, "fulfilled");
  if (schema.status === "fulfilled" && rows.status === "fulfilled") {
    assert.equal(schema.value.mode, "schema"); assert.equal(schema.value.revision, 1);
    assert.equal(rows.value.mode, "rows"); assert.deepEqual(rows.value.rows, []);
  }
  assert.equal(events.filter(event => event.endsWith(":exit")).length, 2);
  assert.ok(workers.every(worker => worker.threadId === -1)); assert.equal(io.inFlight, 0);
  await f.absent("original"); await f.fresh(io);
});

test("Personal app-data IO: a SQLite lock that outlasts the native timeout records busy after exact exit and executes no write", { timeout: 15000 }, async t => {
  const f = await fixture(t), events: string[] = [];
  const lock = new DatabaseSync(f.database.file);
  lock.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;");
  let writer!: Worker;
  const io = f.open({ workerProbe(worker) { writer = worker; worker.once("exit", () => events.push("exit")); } });
  try {
    await assert.rejects(io.run(f.write("original")), code("app_data_io_busy")).then(() => events.push("rejected"));
    assert.deepEqual(events, ["exit", "rejected"]); assert.equal(writer.threadId, -1); assert.equal(io.inFlight, 0);
  } finally { lock.close(); }
  await f.absent("original"); await f.fresh(io);
});
