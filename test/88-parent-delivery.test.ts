/**
 * 父级送达（架构工单 09）：模块在临时 Store 上直接构造，不起 Runtime 与模型服务；
 * 建结果唤醒用记录桩。集成证据（队列循环、driver、编排器确实调用
 * 本模块）在 82、84-im-final-delivery、86。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import type { AccessMode, SubAgentMessage, Task, TaskStatus } from "@ruukoto/core/types.ts";
import { ParentDelivery, type ParentDeliveryDeps, type WorkReport } from "@ruukoto/runtime/parent-delivery.ts";
import { messageStateText } from "@ruukoto/agent/subagent-message.ts";
import type { ChildOutcome } from "@ruukoto/runtime/orchestrator.ts";

const SELECTION = { provider: "mock", modelId: "mock", thinkingLevel: "off" as const };

const requestIdIsWake = (requestId?: string) => Boolean(requestId?.startsWith("wake:") || requestId?.startsWith("smsg:"));

/** 结局 → 子任务的持久终态（超时 = 截止取消，结果未知 = 中断）。 */
const OUTCOMES: Array<{ outcome: ChildOutcome; status: TaskStatus; errorMessage?: string; text: string }> = [
  { outcome: "completed", status: "completed", text: "已完成" },
  { outcome: "failed", status: "failed", errorMessage: "boom", text: "失败" },
  { outcome: "timeout", status: "canceled", errorMessage: "deadline_exceeded", text: "超时" },
  { outcome: "unknown", status: "interrupted", text: "结果未知" },
];

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
  const task = (
    sessionId: string,
    opts: { requestId?: string; accessMode?: AccessMode; status?: TaskStatus; workId?: string; subAgentId?: string; parentTaskId?: string; sourceEventId?: string | null; errorMessage?: string } = {},
  ): Task => {
    const { task } = store.insertQueuedTask({
      sessionId,
      requestId: opts.requestId ?? `r${++n}`,
      input: "x",
      accessMode: opts.accessMode,
      modelSelection: SELECTION,
      submissionDigest: `d${++n}`,
      workId: opts.workId ?? null,
      subAgentId: opts.subAgentId ?? null,
      parentTaskId: opts.parentTaskId ?? null,
      sourceEventId: opts.sourceEventId ?? null,
      agentId: sessionId === mainSession.id && requestIdIsWake(opts.requestId) ? "main" : null,
    });
    if (opts.status && opts.status !== "queued") {
      store.transitionTask(task.id, ["queued"], opts.status, { endedAt: new Date().toISOString(), errorMessage: opts.errorMessage ?? null });
    }
    return store.getTask(task.id)!;
  };
  /** 父会话下一项工作：父任务 + SubAgent（独立会话）+ 工作行。 */
  const work = (parentSessionId: string, sourceEventId: string | null = null) => {
    const parent = task(parentSessionId, { status: "completed", sourceEventId });
    const sub = session();
    const agentId = `sa${++n}`;
    const workId = `work${++n}`;
    store.insertSubAgent({ id: agentId, parentSessionId, sessionId: sub.id, workDir: root, activeWorkId: workId, currentTaskId: null, state: "idle", closedAt: null, closedBy: null, createdAt: sub.createdAt });
    store.insertWorkDelegation({ id: workId, parentSessionId, originTaskId: parent.id, subAgentId: agentId, requestKey: `k${n}`, paramsDigest: "d", canceledAt: null, canceledBy: null, cancelReason: null, writeTarget: null, createdAt: sub.createdAt });
    const exec = (status: TaskStatus = "completed", opts: { errorMessage?: string; sourceEventId?: string | null } = {}) =>
      task(sub.id, { status, workId, subAgentId: agentId, parentTaskId: parent.id, ...opts });
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
      accessMode: store.getTask(fromTaskId)!.accessMode,
      sourcePermissionVersion: store.getTask(fromTaskId)!.permissionVersion,
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
  /** 记录桩：按请求键插入排队任务（与 submit 一样幂等），记录每次调用。 */
  const submits: Array<Parameters<ParentDeliveryDeps["submit"]>[0]> = [];
  const reports: WorkReport[] = [];
  const replies = new Map<string, string>();
  const delivery = new ParentDelivery({
    store,
    submit: async (input) => {
      submits.push(input);
      return store.insertQueuedTask({ ...input, submissionDigest: input.requestId }).task;
    },
    defaultModelSelection: () => SELECTION,
    readReply: (taskId) => replies.get(taskId) ?? null,
    isReviewEvent: (event) => event.source === "github",
    resultNotice: () => null,
    sendWorkReport: (report) => reports.push(report),
  });
  const inbound = (source: string) =>
    store.withTx(() => store.registerInboundEvent({ source, externalId: `x${++n}`, actor: null, targetRole: "main", body: "b" })).event;
  const cleanup = () => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { store, mainSession, devSession, task, work, message, delivery, submits, reports, replies, inbound, cleanup };
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
    // SubAgent 子会话的 smsg: 投递任务不归放行判定（整项取消在登记事务内直接取消它们）
    const sw = k.work(k.mainSession.id);
    const toSub = k.message(sw, sw.exec().id, { toSubAgentId: sw.agentId, fromSubAgentId: null });
    sw.cancel();
    assert.equal(k.delivery.wakeAdmitted(k.task(sw.sub.id, { requestId: `smsg:${toSub.id}`, workId: sw.workId, subAgentId: sw.agentId })), true);
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

test("结果送达矩阵：父会话 × 结局 × 取消 → 结果唤醒、注入清单与放行判定", async () => {
  const k = kit();
  try {
    for (const parentKind of ["main", "dev"] as const) {
      for (const o of OUTCOMES) {
        for (const cancel of ["none", "before_result", "after_wake"] as const) {
          const label = `${parentKind}/${o.outcome}/${cancel}`;
          const w = k.work(parentKind === "main" ? k.mainSession.id : k.devSession.id);
          const child = w.exec(o.status, { errorMessage: o.errorMessage });
          k.store.setTaskResult(child.id, `摘要-${label}`, "{}");
          if (cancel === "before_result") w.cancel();
          const before = k.submits.length;
          await k.delivery.resultRecorded(k.store.getTask(child.id)!, o.outcome, `摘要-${label}`);
          const built = k.submits.slice(before);
          if (parentKind === "main" && cancel !== "before_result") {
            assert.equal(built.length, 1, `${label}：建一次结果唤醒`);
            assert.equal(built[0]!.requestId, `wake:${child.id}`);
            assert.equal(built[0]!.agentId, "main");
            assert.equal(built[0]!.accessMode, "confirm");
            assert.equal(built[0]!.sourceEventId, null);
            assert.match(built[0]!.input, new RegExp(`子任务${o.text}`));
            assert.match(built[0]!.input, new RegExp(`摘要：摘要-${label}`));
            const wake = k.store.findTaskByRequest(k.mainSession.id, `wake:${child.id}`)!;
            if (cancel === "after_wake") w.cancel();
            assert.equal(k.delivery.wakeAdmitted(wake), cancel === "none", `${label}：放行判定`);
          } else {
            assert.equal(built.length, 0, `${label}：不建结果唤醒`);
            if (cancel === "after_wake") w.cancel();
          }
          // 候选装配不消费；Driver 核实模型已接受后才移出后续候选。
          const injected = k.delivery.takeInjection(parentKind === "main" ? k.mainSession.id : k.devSession.id).results.map((t) => t.id);
          assert.deepEqual(injected, parentKind === "dev" && cancel === "none" ? [child.id] : [], `${label}：注入清单`);
          if (injected.length) {
            assert.equal(k.store.getTask(child.id)!.resultDeliveredAt, null);
            k.delivery.acceptInjection(w.parent.id, injected, `accepted-${child.id}`);
          }
          assert.deepEqual(k.delivery.takeInjection(k.devSession.id).results, [], `${label}：注入不重复`);
        }
      }
    }
  } finally {
    k.cleanup();
  }
});

test("消息送达方向：main 在消息事务内建消息唤醒并写投递登记；普通开发会话待注入", () => {
  const k = kit();
  try {
    const mw = k.work(k.mainSession.id);
    const mchild = mw.exec();
    const mmsg = k.message(mw, mchild.id);
    const verified = { ...SELECTION, modelId: "verified-before-transaction" };
    assert.equal(k.store.withTx(() => k.delivery.messageRecorded(mmsg, k.store.getWorkDelegation(mw.workId)!, verified)), "wake");
    const wake = k.store.findTaskByRequest(k.mainSession.id, `smsg:${mmsg.id}`)!;
    assert.deepEqual(wake.modelSelection, verified, "使用事务外已核实的选择，不重新取默认模型");
    assert.equal(wake.agentId, "main");
    assert.equal(wake.accessMode, "confirm");
    assert.equal(wake.deadline, null);
    assert.match(wake.input, new RegExp(`来自：SubAgent ${mw.agentId}（工作 ${mw.workId}，执行任务 ${mchild.id}）`));
    assert.equal(k.store.getSubAgentMessage(mmsg.id)!.deliveredTaskId, wake.id);
    // 重入幂等：同一请求键不建第二个唤醒
    k.store.withTx(() => k.delivery.messageRecorded(mmsg, k.store.getWorkDelegation(mw.workId)!, verified));
    assert.equal(k.store.listTasksBySession(k.mainSession.id).filter((t) => t.requestId === `smsg:${mmsg.id}`).length, 1);
    assert.deepEqual(k.delivery.takeInjection(k.mainSession.id).messages, [], "main 不走注入");

    const dw = k.work(k.devSession.id);
    const dchild = dw.exec();
    const dmsg = k.message(dw, dchild.id);
    assert.equal(k.store.withTx(() => k.delivery.messageRecorded(dmsg, k.store.getWorkDelegation(dw.workId)!, null)), "inject");
    assert.equal(k.store.findTaskByRequest(k.devSession.id, `smsg:${dmsg.id}`), null);
    // 注入：同事务标记已投递（无承载任务），已取消工作的消息不注入
    const canceled = k.work(k.devSession.id);
    const cmsg = k.message(canceled, canceled.exec().id);
    canceled.cancel();
    assert.deepEqual(k.delivery.takeInjection(k.devSession.id).messages.map((m) => m.id), [dmsg.id]);
    const done = k.store.getSubAgentMessage(dmsg.id)!;
    assert.ok(done.deliveredAt !== null && done.deliveredTaskId === null);
    assert.equal(k.store.getSubAgentMessage(cmsg.id)!.deliveredAt, null);
    assert.deepEqual(k.delivery.takeInjection(k.devSession.id).messages, []);
  } finally {
    k.cleanup();
  }
});

test("启动巡检：只补缺失的结果唤醒；消息由 SubAgentManager 冲刷", async () => {
  const k = kit();
  try {
    const result = (parentSessionId: string) => {
      const w = k.work(parentSessionId);
      const child = w.exec("canceled", { errorMessage: "deadline_exceeded" });
      k.store.setTaskResult(child.id, "摘要", "{}");
      return { w, child };
    };
    const missing = result(k.mainSession.id);
    const canceled = result(k.mainSession.id);
    canceled.w.cancel();
    result(k.devSession.id);
    await k.delivery.sweep();
    assert.deepEqual(k.submits.map((x) => x.requestId), [`wake:${missing.child.id}`]);
    assert.match(k.submits[0]!.input, /子任务超时/, "结局按持久状态推导");
    assert.equal(k.store.listTasksBySession(k.mainSession.id).filter((t) => t.requestId.startsWith("smsg:")).length, 0, "消息唤醒由管理器负责");
    assert.equal(k.store.listTasksBySession(k.devSession.id).filter((t) => t.requestId.startsWith("wake:")).length, 0);

    await k.delivery.sweep();
    assert.equal(k.submits.length, 1, "重复巡检不重复补建");
  } finally {
    k.cleanup();
  }
});

test("最终汇报：来源（IM / TUI / GitHub 评审）× 取消 → 是否到期、发送键与正文；唤醒说明随来源", async () => {
  const k = kit();
  try {
    const cases = [
      { source: "telegram", canceled: false, due: true },
      { source: "qq_private", canceled: false, due: true },
      { source: "telegram", canceled: true, due: false },
      { source: null, canceled: false, due: false },
      { source: "github", canceled: false, due: false },
    ];
    for (const c of cases) {
      const label = `${c.source ?? "tui"}/${c.canceled ? "canceled" : "live"}`;
      const event = c.source ? k.inbound(c.source) : null;
      const w = k.work(k.mainSession.id, event?.id ?? null);
      // GitHub 评审：执行任务自身带来源事件（结果唤醒保留来源与截止时间）
      const child = w.exec("completed", { sourceEventId: c.source === "github" ? event!.id : null });
      k.store.setTaskResult(child.id, "摘要", "{}");
      const before = k.submits.length;
      await k.delivery.resultRecorded(k.store.getTask(child.id)!, "completed", "摘要");
      if (c.source === "github") {
        assert.equal(k.submits[before]!.sourceEventId, event!.id, `${label}：评审唤醒保留来源`);
        assert.ok(k.submits[before]!.deadline !== null, `${label}：评审唤醒有截止时间`);
      }
      const wake = k.store.findTaskByRequest(k.mainSession.id, `wake:${child.id}`)!;
      k.store.transitionTask(wake.id, ["queued"], "completed", { endedAt: new Date().toISOString() });
      k.replies.set(wake.id, `汇报正文-${label}`);
      if (c.canceled) w.cancel();
      const reports = k.reports.length;
      k.delivery.wakeTerminal(wake, "completed");
      const sent = k.reports.slice(reports);
      if (c.due) {
        assert.equal(sent.length, 1, `${label}：到期汇报一次`);
        assert.equal(sent[0]!.key, `${event!.id}#work:${w.workId}:${child.id}`);
        assert.equal(sent[0]!.wakeTaskId, wake.id);
        assert.equal(sent[0]!.text, `[工作 ${w.workId} 最终汇报]\n汇报正文-${label}`);
        assert.match(k.submits[before]!.input, /\[最终汇报\]/, `${label}：唤醒说明收尾规则`);
      } else {
        assert.equal(sent.length, 0, `${label}：不汇报`);
        if (!c.canceled) assert.doesNotMatch(k.submits[before]!.input, /\[最终汇报\]/, `${label}：无唤醒说明`);
      }
    }

    // 非完成结局：正文说明汇报轮次的结局，不读回答
    const event = k.inbound("telegram");
    const w = k.work(k.mainSession.id, event.id);
    const child = w.exec();
    const wake = k.task(k.mainSession.id, { requestId: `wake:${child.id}`, status: "interrupted" });
    k.delivery.wakeTerminal(wake, "unknown");
    assert.equal(k.reports.at(-1)!.text, `[工作 ${w.workId} 最终汇报] 汇报轮次被后台重启中断，结果未知，详情见 TUI。`);
    // 不是结果唤醒（消息唤醒、普通任务）不触发汇报
    const count = k.reports.length;
    k.delivery.wakeTerminal(k.task(k.mainSession.id, { requestId: `smsg:x`, status: "completed" }), "completed");
    k.delivery.wakeTerminal(k.task(k.mainSession.id, { status: "completed" }), "completed");
    assert.equal(k.reports.length, count);
  } finally {
    k.cleanup();
  }
});

test("最终汇报到期：仍有活动执行任务或其他执行任务的结果唤醒未出结果时不到期，后终态的唤醒汇报一次", () => {
  const k = kit();
  try {
    const event = k.inbound("telegram");
    const w = k.work(k.mainSession.id, event.id);
    const first = w.exec();
    const second = w.exec("running");
    const firstWake = k.task(k.mainSession.id, { requestId: `wake:${first.id}`, status: "completed" });
    k.delivery.wakeTerminal(firstWake, "completed");
    assert.equal(k.reports.length, 0, "仍有活动执行任务");

    k.store.transitionTask(second.id, ["running"], "completed", { endedAt: new Date().toISOString() });
    const secondWake = k.task(k.mainSession.id, { requestId: `wake:${second.id}`, status: "running" });
    k.store.setTaskResult(firstWake.id, "汇报", "{}");
    k.delivery.wakeTerminal(firstWake, "completed");
    assert.equal(k.reports.length, 0, "另一执行任务的结果唤醒尚无结果");

    k.store.transitionTask(secondWake.id, ["running"], "completed", { endedAt: new Date().toISOString() });
    k.delivery.wakeTerminal(secondWake, "completed");
    assert.equal(k.reports.length, 1);
    assert.equal(k.reports[0]!.key, `${event.id}#work:${w.workId}:${second.id}`, "键含本次收尾的执行任务");
  } finally {
    k.cleanup();
  }
});

test("迟到结果唤醒与消息唤醒沿触发任务快照，不读取主会话后来默认值", async () => {
  const k = kit();
  try {
    const w = k.work(k.mainSession.id);
    const child = k.task(w.sub.id, { status: "completed", accessMode: "full_access", parentTaskId: w.parent.id, workId: w.workId, subAgentId: w.agentId });
    k.store.setTaskResult(child.id, "完成", "{}");
    const msg = k.message(w, child.id);
    const session = k.store.getSession(k.mainSession.id)!;
    k.store.setSessionDefaultMode(session.id, "confirm", session.defaultAccessModeVersion);
    await k.delivery.resultRecorded(k.store.getTask(child.id)!, "completed", "完成");
    const resultWake = k.store.findTaskByRequest(k.mainSession.id, `wake:${child.id}`)!;
    assert.equal(resultWake.accessMode, "full_access");
    assert.equal(resultWake.parentTaskId, child.id);
    assert.equal(resultWake.sourcePermissionVersion, child.permissionVersion);
    k.store.withTx(() => k.delivery.messageRecorded(msg, k.store.getWorkDelegation(w.workId)!, SELECTION));
    const messageWake = k.store.getTask(k.store.getSubAgentMessage(msg.id)!.deliveredTaskId!)!;
    assert.equal(messageWake.accessMode, "full_access");
    assert.equal(messageWake.sourcePermissionVersion, msg.sourcePermissionVersion);
    assert.deepEqual(k.store.listConfirmationsByTask(resultWake.id), []);
  } finally { k.cleanup(); }
});
