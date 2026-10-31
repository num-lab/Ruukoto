/** 真实 SQLite 验证队列顺序／修订、引导路由状态机与 schema 门槛；不启动 Runtime。 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Db } from "@ruukoto/core/db.ts";
import { Store, StoreConflictError } from "@ruukoto/core/store.ts";
import type { Task } from "@ruukoto/core/types.ts";

const selection = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" as const };

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "queue-guidance-"));
  const db = new Db(root), store = new Store(db), stat = fs.statSync(root);
  const project = store.withTx(() => store.createProject("q"));
  const session = store.withTx(() => store.createSession({ projectId: project.id, cwd: root, cwdReal: fs.realpathSync(root), cwdDev: stat.dev, cwdIno: stat.ino, piSessionId: "pi1", confirmTools: [] }));
  let n = 0;
  const queued = (extra: { parentTaskId?: string; resumesTaskId?: string } = {}) => store.withTx(() =>
    store.insertQueuedTask({ sessionId: session.id, requestId: `req${++n}`, input: `输入${n}`, submissionDigest: `digest${n}`, modelSelection: selection, ...extra }).task);
  const running = () => {
    const task = queued();
    store.withTx(() => store.transitionTask(task.id, ["queued"], "running", { startedAt: new Date().toISOString() }));
    return store.getTask(task.id)!;
  };
  const order = () => store.listQueuedTasksFifo(session.id).map(task => task.id);
  const queueIds = () => store.getTaskQueue(session.id).tasks.map(item => item.taskId);
  const revision = () => store.getSession(session.id)!.queueRevision;
  const conflict = (code: string) => (error: unknown) => error instanceof StoreConflictError && error.code === code;
  return { root, db, store, session, queued, running, order, queueIds, revision, conflict, cleanup: () => { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test("入队取当前最大顺序，出队与取消推进修订", () => {
  const f = fixture();
  try {
    const a = f.queued(), b = f.queued(), internal = f.queued({ parentTaskId: "host" });
    assert.deepEqual(f.order(), [a.id, b.id, internal.id]);
    assert.equal(f.revision(), 3);
    const events = () => f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE json_extract(body, '$.type') = 'session.queue_changed'").get()!.n;
    f.store.withTx(() => f.store.transitionTask(a.id, ["queued"], "running", { startedAt: new Date().toISOString() }));
    assert.equal(f.revision(), 4);
    const c = f.queued();
    assert.deepEqual(f.order(), [b.id, internal.id, c.id], "内部任务保留自身槽位，新输入追加到当前最大顺序之后");
    assert.ok(c.queueOrder > b.queueOrder);
    f.store.withTx(() => f.store.endTask(b.id, ["queued"], "canceled"));
    assert.deepEqual(f.order(), [internal.id, c.id]);
    assert.equal(events(), 6, "入队、出队与取消各自同事务提交一次队列事件");
  } finally { f.cleanup(); }
});

test("重排只置换可整理输入的槽位；修订与成员不一致拒绝", () => {
  const f = fixture();
  try {
    const a = f.queued(), internal = f.queued({ parentTaskId: "host" }), b = f.queued(), c = f.queued();
    const before = f.revision();
    const moved = f.store.withTx(() => f.store.reorderTaskQueue(f.session.id, [c.id, a.id, b.id], before));
    assert.deepEqual(moved.tasks.map(item => item.taskId), [c.id, a.id, b.id], "用户队列只投影拥有者输入");
    assert.deepEqual(f.order(), [c.id, internal.id, a.id, b.id]);
    assert.equal(f.revision(), before + 1);
    assert.throws(() => f.store.withTx(() => f.store.reorderTaskQueue(f.session.id, [c.id, a.id, b.id], before)), f.conflict("queue_conflict"), "旧修订拒绝覆盖新队列");
    assert.throws(() => f.store.withTx(() => f.store.reorderTaskQueue(f.session.id, [c.id, a.id], f.revision())), f.conflict("queue_conflict"), "成员不完整不能丢下待执行输入");
    assert.throws(() => f.store.withTx(() => f.store.reorderTaskQueue(f.session.id, [c.id, a.id, internal.id], f.revision())), f.conflict("queue_conflict"), "宿主内部输入不参与普通重排");
    const noop = f.store.withTx(() => f.store.reorderTaskQueue(f.session.id, [c.id, a.id, b.id], f.revision()));
    assert.equal(f.revision(), before + 1, "同序重排不产生新修订");
    assert.deepEqual(noop.tasks.map(item => item.taskId), [c.id, a.id, b.id]);
  } finally { f.cleanup(); }
});

test("排队输入转引导后不再独立执行；取消先收束路由", () => {
  const f = fixture();
  try {
    const target = f.running(), source = f.queued(), other = f.queued();
    const base = f.revision();
    const guidance = f.store.withTx(() => f.store.acceptTaskGuidance(source.id, target.id, true));
    assert.equal(guidance.state, "pending");
    assert.equal(guidance.targetTaskId, target.id);
    assert.equal(f.revision(), base + 1);
    assert.deepEqual(f.order(), [other.id], "待接入输入被普通调度排除但仍为 queued");
    assert.deepEqual(f.queueIds(), [other.id]);
    assert.equal(f.store.getTask(source.id)!.status, "queued");
    assert.throws(() => f.store.withTx(() => f.store.reorderTaskQueue(f.session.id, [other.id, source.id], f.revision())), f.conflict("queue_conflict"), "待接入输入不参与重排成员");
    assert.throws(() => f.store.withTx(() => f.store.transitionTask(source.id, ["queued"], "running")), f.conflict("guidance_pending"), "待接入源不能转入独立执行");
    const again = f.store.withTx(() => f.store.acceptTaskGuidance(source.id, target.id, true));
    assert.equal(again.acceptedSeq, guidance.acceptedSeq, "同源同目标重复接纳返回原路由");
    f.store.withTx(() => f.store.endTask(source.id, ["queued"], "canceled"));
    assert.equal(f.store.getTaskGuidance(source.id)!.state, "canceled", "源先取消时路由收束为接入前撤销");
  } finally { f.cleanup(); }
});

test("引导目标结束时回退队首批次；后到回退不插队", () => {
  const f = fixture();
  try {
    const target = f.running(), s1 = f.queued(), normal = f.queued(), s2 = f.queued();
    f.store.withTx(() => f.store.acceptTaskGuidance(s1.id, target.id, true));
    f.store.withTx(() => f.store.acceptTaskGuidance(s2.id, target.id, true));
    assert.deepEqual(f.order(), [normal.id]);
    f.store.withTx(() => f.store.fallbackTaskGuidance(target.id));
    assert.deepEqual(f.order(), [s1.id, s2.id, normal.id], "回退按接纳序号组成队首批次");
    const s3 = f.queued();
    f.store.withTx(() => f.store.acceptTaskGuidance(s3.id, target.id, false));
    assert.deepEqual(f.order(), [s1.id, s2.id, s3.id, normal.id], "封闭后到达的引导直接回退且不越过未执行回退");
    assert.equal(f.store.getTaskGuidance(s3.id)!.state, "fallback");
  } finally { f.cleanup(); }
});

test("接入登记把源收束为 converted_to_guidance；归属冲突不静默", () => {
  const f = fixture();
  try {
    const target = f.running(), source = f.queued();
    f.store.withTx(() => f.store.acceptTaskGuidance(source.id, target.id, true));
    const joined = f.store.withTx(() => f.store.recordTaskGuidanceEntry(source.id, target.id, "entry-1"));
    assert.equal(joined.state, "joined");
    assert.equal(joined.entryId, "entry-1");
    const ended = f.store.getTask(source.id)!;
    assert.equal(ended.status, "canceled");
    assert.equal(ended.interruptReason, "converted_to_guidance", "独立执行意图以转换收束而非拥有者取消");
    assert.equal(f.store.withTx(() => f.store.recordTaskGuidanceEntry(source.id, target.id, "entry-1")).entryId, "entry-1", "重复登记同 entry 幂等");
    assert.throws(() => f.store.withTx(() => f.store.recordTaskGuidanceEntry(source.id, target.id, "entry-other")), f.conflict("guidance_unverified"), "已接入源不能再改写 entry 归属");
    const stray = f.queued();
    f.store.withTx(() => f.store.acceptTaskGuidance(stray.id, target.id, true));
    assert.throws(() => f.store.withTx(() => f.store.recordTaskGuidanceEntry(stray.id, "task-x", "entry-y")), f.conflict("guidance_unverified"), "路由归属不符保留现场");
  } finally { f.cleanup(); }
});

test("来源资格：继续与宿主内部输入不允许转引导", () => {
  const f = fixture();
  try {
    const target = f.running(), cont = f.queued({ resumesTaskId: target.id }), internal = f.queued({ parentTaskId: "host" });
    assert.throws(() => f.store.withTx(() => f.store.acceptTaskGuidance(cont.id, target.id, true)), f.conflict("guidance_not_allowed"), "继续输入保留独立执行关系");
    assert.throws(() => f.store.withTx(() => f.store.acceptTaskGuidance(internal.id, target.id, true)), f.conflict("guidance_not_allowed"), "宿主内部输入不开放引导");
    assert.throws(() => f.store.withTx(() => f.store.acceptTaskGuidance(cont.id, cont.id, true)), f.conflict("guidance_not_allowed"), "输入不能引导自身");
    const started = f.running();
    assert.throws(() => f.store.withTx(() => f.store.acceptTaskGuidance(started.id, target.id, true)), f.conflict("already_started"), "已开始输入不能转换");
  } finally { f.cleanup(); }
});

test("v53 档案原样拒绝，不写新表与版本号", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "queue-guidance-v53-"));
  try {
    const file = path.join(root, "ruukoto.db");
    const legacy = new DatabaseSync(file);
    legacy.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version', '53');");
    legacy.close();
    assert.throws(() => new Db(root), (error: unknown) => (error as { code?: string }).code === "schema_version_unsupported");
    const check = new DatabaseSync(file, { readOnly: true });
    assert.equal(check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()!.value, "53", "拒绝前不改写版本");
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'task_guidance'").get()!.n, 0, "拒绝前不建引导表");
    check.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
