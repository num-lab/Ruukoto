/**
 * 父级送达（架构工单 09）：模块在临时 Store 上直接构造，不起 Runtime 与模型服务；
 * 建结果唤醒用记录桩，kick 用探针。集成证据（队列循环、driver、编排器确实调用
 * 本模块）在 82、84-im-final-delivery、86。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Db } from "../src/core/db.ts";
import { Store } from "../src/core/store.ts";
import type { SubAgentMessage, Task, TaskStatus } from "../src/core/types.ts";
import { ParentDelivery, messageStateText } from "../src/runtime/parent-delivery.ts";

const SELECTION = { provider: "mock", modelId: "mock", thinkingLevel: "off" as const };

function kit() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-parent-delivery-"));
  const db = new Db(root);
  const store = new Store(db);
  const project = store.createProject("p");
  let n = 0;
  const session = () =>
    store.createSession({ projectId: project.id, cwd: root, cwdReal: root, cwdDev: 1, cwdIno: ++n, piSessionId: `pi-${n}`, confirmTools: [] });
  const mainSession = session();
  store.insertAgentRole({ id: "main", projectId: project.id, sessionId: mainSession.id, workDir: root, modelSelection: null, tools: [], createdAt: mainSession.createdAt });
  const devSession = session();
  const task = (sessionId: string, opts: { requestId?: string; status?: TaskStatus; workId?: string; subAgentId?: string; parentTaskId?: string } = {}): Task => {
    const { task } = store.insertQueuedTask({
      sessionId,
      requestId: opts.requestId ?? `r${++n}`,
      input: "x",
      modelSelection: SELECTION,
      submissionDigest: `d${++n}`,
      workId: opts.workId ?? null,
      subAgentId: opts.subAgentId ?? null,
      parentTaskId: opts.parentTaskId ?? null,
    });
    if (opts.status && opts.status !== "queued") store.transitionTask(task.id, ["queued"], opts.status, { endedAt: new Date().toISOString() });
    return store.getTask(task.id)!;
  };
  /** 父会话下一项工作：父任务 + SubAgent（独立会话）+ 工作行。 */
  const work = (parentSessionId: string) => {
    const parent = task(parentSessionId, { status: "completed" });
    const sub = session();
    const agentId = `sa${++n}`;
    const workId = `work${++n}`;
    store.insertSubAgent({ id: agentId, parentSessionId, sessionId: sub.id, workDir: root, activeWorkId: workId, currentTaskId: null, state: "idle", closedAt: null, closedBy: null, createdAt: sub.createdAt });
    store.insertWorkDelegation({ id: workId, parentSessionId, originTaskId: parent.id, subAgentId: agentId, requestKey: `k${n}`, paramsDigest: "d", canceledAt: null, canceledBy: null, cancelReason: null, writeTarget: null, createdAt: sub.createdAt });
    const exec = (status: TaskStatus = "completed") => task(sub.id, { status, workId, subAgentId: agentId, parentTaskId: parent.id });
    const cancel = () => store.cancelWorkDelegation(workId, new Date().toISOString(), "owner", null);
    return { parent, sub, agentId, workId, exec, cancel };
  };
  const message = (w: ReturnType<typeof work>, fromTaskId: string, overrides: Partial<SubAgentMessage> = {}): SubAgentMessage => {
    const msg: SubAgentMessage = {
      id: `smsg_${++n}`,
      workId: w.workId,
      parentSessionId: store.getWorkDelegation(w.workId)!.parentSessionId,
      fromSubAgentId: w.agentId,
      fromTaskId,
      toSubAgentId: null,
      requestKey: `m${n}`,
      paramsDigest: "d",
      body: `正文${n}`,
      createdAt: new Date().toISOString(),
      deliveredTaskId: null,
      deliveredAt: null,
      undeliveredReason: null,
      ...overrides,
    };
    store.insertSubAgentMessage(msg);
    return msg;
  };
  const delivery = new ParentDelivery({ store });
  const cleanup = () => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { store, mainSession, devSession, task, work, message, delivery, cleanup };
}

test("放行判定：wake: 与 smsg: 同一规则——所属工作已取消即不放行，其他任务照常", () => {
  const k = kit();
  try {
    for (const cancelAfterQueue of [false, true]) {
      const w = k.work(k.mainSession.id);
      const child = w.exec();
      const msg = k.message(w, child.id);
      const resultWake = k.task(k.mainSession.id, { requestId: `wake:${child.id}` });
      const messageWake = k.task(k.mainSession.id, { requestId: `smsg:${msg.id}` });
      if (cancelAfterQueue) w.cancel();
      assert.equal(k.delivery.wakeAdmitted(resultWake), !cancelAfterQueue, "结果唤醒");
      assert.equal(k.delivery.wakeAdmitted(messageWake), !cancelAfterQueue, "消息唤醒");
    }
    // 不是唤醒、或唤醒的子任务无工作（旧 coding 子任务）一律放行
    assert.equal(k.delivery.wakeAdmitted(k.task(k.mainSession.id)), true);
    const legacyChild = k.task(k.mainSession.id, { status: "completed" });
    assert.equal(k.delivery.wakeAdmitted(k.task(k.mainSession.id, { requestId: `wake:${legacyChild.id}` })), true);
  } finally {
    k.cleanup();
  }
});

test("消息状态文本：发给主 Agent 的消息承载唤醒被截住时补标未送达；发给 SubAgent 的不补标", () => {
  const k = kit();
  try {
    const w = k.work(k.mainSession.id);
    const child = w.exec();
    const wake = k.task(k.mainSession.id, { requestId: "smsg:x" });
    const toMain = k.message(w, child.id, { deliveredTaskId: wake.id, deliveredAt: new Date().toISOString() });
    assert.equal(messageStateText(k.store, toMain), `已投递（任务 ${wake.id}）`);
    k.store.transitionTask(wake.id, ["queued"], "canceled", { errorMessage: "work_canceled", endedAt: new Date().toISOString() });
    assert.equal(messageStateText(k.store, toMain), `已投递（任务 ${wake.id}）（工作已取消，未送达）`);
    // 发给 SubAgent 的投递任务被整项取消时仍按投递登记显示（送达规则归 SubAgent 管理器）
    const delivered = w.exec("canceled");
    k.store.db.prepare("UPDATE tasks SET error_message = 'work_canceled' WHERE id = ?").run(delivered.id);
    const toSub = k.message(w, child.id, { toSubAgentId: w.agentId, fromSubAgentId: null, deliveredTaskId: delivered.id, deliveredAt: new Date().toISOString() });
    assert.equal(messageStateText(k.store, toSub), `已投递（任务 ${delivered.id}）`);
    // 注入送达、未投递与待投递
    assert.equal(messageStateText(k.store, k.message(w, child.id, { deliveredAt: new Date().toISOString() })), "已随主会话模型调用注入送达");
    assert.equal(messageStateText(k.store, k.message(w, child.id, { undeliveredReason: "work_canceled" })), "未投递（work_canceled）");
    assert.match(messageStateText(k.store, k.message(w, child.id)), /^待投递/);
  } finally {
    k.cleanup();
  }
});
