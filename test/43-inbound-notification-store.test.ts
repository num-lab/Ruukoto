import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Db, SCHEMA_VERSION } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import type { NotifyTarget } from "@ruukoto/core/types.ts";
import { SchedulerStore } from "@ruukoto/channels/scheduler/store.ts";

const target: NotifyTarget = { channel: "mock", account: "bot", chatId: "owner", configVersion: 1 };

test("入站事件通知：同键幂等、异参冲突，发送结果未知后不重新领取", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-inbound-outbox-"));
  const db = new Db(root);
  const store = new Store(db);
  const sched = new SchedulerStore(store);
  const input = { sourceKind: "inbound_event" as const, sourceKey: "evt-review", taskId: "task-summary", hostOpId: null, target, text: "评审摘要", sourceRefs: [] };
  try {
    const first = store.withTx(() => sched.insertOp(input));
    assert.equal(first.created, true);
    const seq = store.getMaxSeq();
    const repeated = store.withTx(() => sched.insertOp(input));
    assert.equal(repeated.created, false);
    assert.deepEqual(repeated.op, first.op);
    assert.equal(store.getMaxSeq(), seq);
    assert.throws(() => store.withTx(() => sched.insertOp({ ...input, text: "替换摘要" })), { code: "request_conflict" });
    assert.throws(() => store.withTx(() => sched.insertOp({ ...input, target: { ...target, configVersion: 2 } })), { code: "request_conflict" });
    assert.equal(store.withTx(() => sched.claim(first.op.id)), true);
    assert.equal(store.withTx(() => sched.claim(first.op.id)), false);
    assert.equal(store.withTx(() => sched.markSendingUnknown()), 1);
    assert.equal(store.withTx(() => sched.markSendingUnknown()), 0);
    const afterRestart = store.withTx(() => sched.insertOp(input));
    assert.equal(afterRestart.created, false);
    assert.equal(afterRestart.op.id, first.op.id);
    assert.equal(afterRestart.op.status, "effect_unknown");
    assert.equal(store.withTx(() => sched.claim(first.op.id)), false);
    assert.deepEqual(sched.listPending(new Date().toISOString(), 10), []);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("入站事件类别：控制消息直接到终态不进入派发查询；默认 task；同键重投返回原事件（issue 08）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-event-kind-"));
  const db = new Db(root);
  const store = new Store(db);
  const base = { source: "telegram", actor: "telegram:42", targetRole: "main" as const, replyTarget: target };
  try {
    const { event, created } = store.withTx(() =>
      store.registerInboundEvent({ ...base, externalId: "1:42:1", body: "/approve abc 1", eventKind: "im_approval", terminal: "done" }),
    );
    assert.equal(created, true);
    assert.equal(event.eventKind, "im_approval");
    assert.equal(event.status, "done");
    assert.equal(event.taskId, null);
    // 控制事件不出现在待派发列表；普通事件仍按默认类别登记
    assert.deepEqual(store.listInboundByStatus(["registered"]), []);
    const { event: normal } = store.withTx(() =>
      store.registerInboundEvent({ ...base, externalId: "1:42:2", body: "普通消息" }),
    );
    assert.equal(normal.eventKind, "task");
    assert.deepEqual(store.listInboundByStatus(["registered"]).map((e) => e.id), [normal.id]);
    // 同键重投：返回原事件（类别/正文/终态不被改写），不新建
    const { event: again, created: recreated } = store.withTx(() =>
      store.registerInboundEvent({ ...base, externalId: "1:42:1", body: "/approve abc 1", eventKind: "im_approval", terminal: "done" }),
    );
    assert.equal(recreated, false);
    assert.equal(again.id, event.id);
    assert.equal(again.status, "done");
    assert.equal(store.getInboundEvent(event.id)!.eventKind, "im_approval");
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
