import { delegateFromActiveTask, messageFromActiveTask } from "./helpers/active-subagent-source.ts";
/**
 * 同项工作内 SubAgent 相互通信（agent-direction issue 13）。
 * Note: 见 .agents/notes/implemented/feature/2026-10-05-subagent-messaging.md
 * Note: 见 .agents/notes/implemented/testing/2026-10-11-await-observed-async-phases.md
 *
 * seam：Runtime 公共接口 + mock 模型 + 真实工具（realTools，local 后端）；
 * 消息登记的确定性路径直接用管理器（来源活动状态由 fixture 显式播种；
 * 工具层调用总在任务内，模型驱动用例单独覆盖）。
 *
 * 覆盖六项验收：
 * - 同项工作双向消息：协作加入（work_id 与 sub_agent_id 同现）把 B 拉入
 *   工作 W，A→B、B→A 与主 Agent→A 的消息都投递为本工作的执行任务，
 *   消息行/事件/输入带来源可追溯；工具白名单仍与工作内容一致（不扩大权限）；
 * - 主 Agent 通道：SubAgent→主 Agent 的消息在 main 经唤醒任务、在 dev 经
 *   下一次模型调用的宿主注入送达；已取消工作的消息不注入（记 work_canceled）；
 * - 范围拒绝：跨父会话、发送方不在本工作、接收方不在本工作（复用后）、
 *   已关闭（不把关闭当作重建理由）、已取消、自己、主 Agent 省略接收方、
 *   正文超限——均明确拒绝，无消息行；
 * - 复用后资格转移：B 复用于 W2 后，W 内消息被拒；迟到旧消息不进入 W2 的
 *   模型上下文；冲刷对资格已失的待投递记 moved_work，不投递；
 * - 幂等与账本：同键同参返回原记录（含工具层重放），异参冲突；冲刷重入
 *   不重复投递/事件；subagent_message 按（工作, 发送方, 键）核实 committed；
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { requireSubAgentExecution } from "@ruukoto/core/subagent-execution.ts";
import { type Responder } from "./helpers/mock-provider.ts";
import { afterTool, lastToolText, inputText, toolNamesOf, cleanupDirs, lastUserText, makeTestDirs, realTools, startTestRuntime, waitFor } from "./helpers/testkit.ts";
import { createSubAgentMessageTool, createSubAgentTools } from "@ruukoto/agent/subagent-tools.ts";
import { subagentOpCheck } from "@ruukoto/agent/subagent-ledger.ts";

/** 结果登记与 Agent 空闲在同一事务；等 resultSummary 即等 idle 可用。 */
async function waitIdle(rt: any, agentId: string): Promise<void> {
  await waitFor("Agent 空闲", () => rt.store.getSubAgent(agentId)!.state === "idle");
}

/** 事件表里的某类事件（按会话过滤）。 */
function eventsOf(rt: any, type: string, sessionId?: string): any[] {
  const rows = (sessionId
    ? rt.store.db.prepare("SELECT body FROM events WHERE session_id = ?").all(sessionId)
    : rt.store.db.prepare("SELECT body FROM events").all()) as Array<{ body: string }>;
  return rows.map((r) => JSON.parse(r.body)).filter((b) => b.type === type);
}

/** 会话内的工作内消息投递任务（请求键 smsg:<消息ID>）。 */
function deliveryTasksOf(rt: any, sessionId: string): any[] {
  return rt.store.listTasksBySession(sessionId).filter((t: any) => t.requestId.startsWith("smsg:"));
}

test("dev 双向协作与来源追溯：协作加入、A→B、B→A、主 Agent 补充；工具白名单不扩大", async () => {
  let aId = "";
  let bId = "";
  let wId = "";
  let releaseSender!: () => void;
  const senderGate = new Promise<void>((resolve) => { releaseSender = resolve; });
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派")) {
      if (afterTool(req)) {
        if (text.includes("联络B")) await senderGate;
        return { kind: "text", text: "A-已通知B" };
      }
      if (text.includes("联络B")) {
        return {
          kind: "tool_calls",
          calls: [
            { id: "m1", name: "subagent_message", arguments: { work_id: wId, key: "m1", text: "A问B：材料CAP-MSG1一致吗", to_sub_agent_id: bId } },
          ],
        };
      }
      return { kind: "text", text: "分析结论" };
    }
    if (text.includes("[工作内消息")) {
      if (afterTool(req)) return { kind: "text", text: "B-已回复A" };
      if (text.includes("A问B")) {
        return {
          kind: "tool_calls",
          calls: [{ id: "r1", name: "subagent_message", arguments: { work_id: wId, key: "r1", text: "B答A：一致CAP-REPLY1", to_sub_agent_id: aId } }],
        };
      }
      if (text.includes("补充CAP-SUP1")) return { kind: "text", text: "A知悉补充CAP-SUP-ACK" };
      return { kind: "text", text: "A收到回复CAP-ACK1" };
    }
    return { kind: "text", text: "父回复" };
  };
  const t = await startTestRuntime("smsg-dev", responder, { config: realTools() });
  try {
    const rt = t.runtime;
    const fileA = path.join(t.work[0]!, "a.txt");
    const fileB = path.join(t.work[0]!, "b.txt");
    fs.writeFileSync(fileA, "资料A");
    fs.writeFileSync(fileB, "资料B");
    const session = await rt.createSession({ projectName: "mdev", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");

    // 两个独立 SubAgent：A 承担工作 W，B 承担自己的工作 W_B
    const a = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "a1", request: "调研", readPaths: ["a.txt"], materials: null, paramsDigest: "da1" });
    aId = a.agent.id;
    wId = a.work.id;
    await waitFor("A 完成", () => rt.store.getTask(a.task.id)!.resultSummary !== null);
    await waitIdle(rt, aId);
    const b = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "b1", request: "独立任务", readPaths: ["b.txt"], materials: null, paramsDigest: "db1" });
    bId = b.agent.id;
    await waitFor("B 完成", () => rt.store.getTask(b.task.id)!.resultSummary !== null);
    await waitIdle(rt, bId);

    // 协作加入：work_id 与 sub_agent_id 同现把空闲的 B 拉入工作 W（无新工作行）
    const before = rt.store.listWorkDelegationsBySession(session.id).length;
    const join = await delegateFromActiveTask(rt, {
      parentTaskId: parent.id,
      key: "j1",
      request: "加入协作",
      workId: wId,
      subAgentId: bId,
      readPaths: ["b.txt"],
      materials: null,
      paramsDigest: "dj1",
    });
    assert.equal(join.created, true);
    assert.equal(join.newWork, false, "协作加入不新建工作行");
    assert.equal(rt.store.listWorkDelegationsBySession(session.id).length, before);
    assert.equal(join.work.id, wId);
    assert.equal(join.agent.id, bId);
    assert.equal(join.task.workId, wId);
    assert.equal(join.task.subAgentId, bId, "加入任务关联协作方（工作行保持首次承接者）");
    assert.equal(rt.store.getSubAgent(bId)!.activeWorkId, wId, "B 的当前工作切到 W");
    assert.match(join.task.input, /协作方/);
    await waitFor("加入完成", () => rt.store.getTask(join.task.id)!.resultSummary !== null);
    await waitIdle(rt, bId);

    // A→B：A 的继续任务经工具发送；B 空闲即投递为本工作的执行任务
    const cont = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "c1", request: "联络B", workId: wId, readPaths: ["a.txt"], materials: null, paramsDigest: "dc1" });
    await waitFor("B 收到 A 的消息", () => deliveryTasksOf(rt, rt.store.getSubAgent(bId)!.sessionId).length === 1);
    const bDelivery = deliveryTasksOf(rt, bId === "" ? "" : rt.store.getSubAgent(bId)!.sessionId);
    assert.equal(bDelivery.length, 1, "A→B 投递为 B 的一次执行任务");
    assert.match(bDelivery[0]!.input, /\[工作内消息 · 工作 .*\]/);
    assert.match(bDelivery[0]!.input, new RegExp(`来自：SubAgent ${aId}（工作 ${wId}，执行任务 ${cont.task.id}）`));
    assert.match(bDelivery[0]!.input, /CAP-MSG1/);
    assert.match(bDelivery[0]!.input, /工具分工与资料 API 范围沿用本工作/);
    // 消息投递沿 B 首次执行钉定的 general 工具集合
    await waitFor("B 的投递任务已调用模型", () => t.server.calls.some((c) => inputText(c).includes("[工作内消息") && inputText(c).includes("A问B")));
    const bCall = t.server.calls.find((c) => inputText(c).includes("[工作内消息") && inputText(c).includes("A问B"))!;
    assert.deepEqual(toolNamesOf(bCall).sort(), [...requireSubAgentExecution(b.task.readScope?.execution).tools].sort());
    assert.ok(toolNamesOf(bCall).includes("bash"), "默认 general 的消息任务保留来源允许的 shell");

    // B→A：投递任务内经工具回复；A 忙完当前任务后由冲刷投递
    await waitFor("B 的投递任务完成", () => rt.store.getTask(bDelivery[0]!.id)!.resultSummary !== null);
    await waitIdle(rt, bId);
    assert.equal(rt.store.findActiveSubAgentTask(aId)!.id, cont.task.id, "发送后响应暂停，A 仍被联络任务占用");
    assert.equal(deliveryTasksOf(rt, rt.store.getSubAgent(aId)!.sessionId).length, 0, "忙碌的 A 尚无回复投递任务");
    const pendingReply = rt.store.listSubAgentMessagesByWork(wId).find((message) => message.fromTaskId === bDelivery[0]!.id)!;
    assert.ok(pendingReply, "B 的工具回复已登记");
    assert.deepEqual(
      [pendingReply.fromSubAgentId, pendingReply.toSubAgentId, pendingReply.deliveredTaskId, pendingReply.deliveredAt, pendingReply.undeliveredReason],
      [bId, aId, null, null, null],
    );
    const sentBeforeFlush = eventsOf(rt, "subagent_message.sent", session.id);
    assert.equal(sentBeforeFlush.length, 2);
    assert.deepEqual(
      sentBeforeFlush.map((event) => [event.fromTaskId, event.fromSubAgentId, event.toSubAgentId, event.delivery, event.taskId]),
      [[cont.task.id, aId, bId, "task", bDelivery[0]!.id], [bDelivery[0]!.id, bId, aId, "pending", null]],
      "sent 保存发送时的判定，B 回复时 A 忙碌而待投递",
    );
    releaseSender();
    await waitFor("A 的联络任务完成", () => rt.store.getTask(cont.task.id)!.resultSummary !== null);
    await waitFor("A 收到 B 的回复", () => deliveryTasksOf(rt, rt.store.getSubAgent(aId)!.sessionId).length === 1);
    const aDelivery = deliveryTasksOf(rt, rt.store.getSubAgent(aId)!.sessionId);
    assert.match(aDelivery[0]!.input, new RegExp(`来自：SubAgent ${bId}`));
    assert.match(aDelivery[0]!.input, /CAP-REPLY1/);
    await waitFor("A 的回复任务完成", () => rt.store.getTask(aDelivery[0]!.id)!.resultSummary !== null);
    assert.match(rt.store.getTask(aDelivery[0]!.id)!.resultSummary!, /CAP-ACK1/);
    await waitIdle(rt, aId);

    // 消息与来源可追溯：行、事件、发送方任务关联
    const msgs = rt.store.listSubAgentMessagesByWork(wId);
    assert.equal(msgs.length, 2);
    const forward = msgs.find((message) => message.fromTaskId === cont.task.id)!;
    const reply = msgs.find((message) => message.id === pendingReply.id)!;
    assert.ok(forward && reply);
    assert.deepEqual(
      [forward, reply].map((message) => [message.fromSubAgentId, message.toSubAgentId, message.fromTaskId, message.deliveredTaskId]),
      [[aId, bId, cont.task.id, bDelivery[0]!.id], [bId, aId, bDelivery[0]!.id, aDelivery[0]!.id]],
    );
    assert.ok(msgs.every((message) => message.deliveredAt !== null && message.undeliveredReason === null));
    assert.deepEqual(
      [bDelivery[0]!, aDelivery[0]!].map((task) => [task.requestId, task.parentTaskId, task.workId, task.subAgentId]),
      [[`smsg:${forward.id}`, cont.task.id, wId, bId], [`smsg:${reply.id}`, bDelivery[0]!.id, wId, aId]],
    );
    assert.deepEqual(eventsOf(rt, "subagent_message.sent", session.id), sentBeforeFlush, "冲刷只更新消息行与投递任务，不改写或重复发送事件");

    // 主 Agent 补充（上级向协作中的 SubAgent 发送）：投递为 A 的本工作任务
    const sup = await messageFromActiveTask(rt, { senderTaskId: parent.id, workId: wId, key: "s1", text: "补充CAP-SUP1", toSubAgentId: aId, paramsDigest: "ds1" });
    assert.equal(sup.delivery, "task");
    const aAll = deliveryTasksOf(rt, rt.store.getSubAgent(aId)!.sessionId);
    await waitFor("补充任务完成", () => rt.store.getTask(aAll[1]!.id)!.resultSummary !== null);
    assert.match(aAll[1]!.input, new RegExp(`来自：主 Agent（父会话任务 ${parent.id}）`));
    assert.match(aAll[1]!.input, /CAP-SUP1/);
    assert.match(rt.store.getTask(aAll[1]!.id)!.resultSummary!, /CAP-SUP-ACK/);
    assert.equal(rt.store.listSubAgentMessagesByWork(wId).length, 3);

    // 主 Agent 读取：part=messages 列出来源、投递状态与正文（真实装配的工具层）
    const projectId = rt.store.getSession(session.id)!.projectId;
    const tools = createSubAgentTools({
      coreStore: rt.store,
      sources: (rt as any).sources,
      delegate: (input) => delegateFromActiveTask(rt, input),
      close: (input) => rt.subagents!.close(input),
      cancelWork: (input) => rt.subagents!.cancelWork(input),
      message: (input) => messageFromActiveTask(rt, input),
      integrate: (input) => rt.subagents!.integrate(input),
      readReply: (taskId, offset, length) => rt.readTaskReply(taskId, offset, length),
      artifacts: rt.artifacts,
      taskContext: () => ({ taskId: parent.id, sessionId: session.id, projectId, hostOpId: "opm" }),
      bindCall: undefined,
      verifyHost: () => null,
    });
    const resultTool = tools.find((x) => x.name === "subagent_result")!;
    const shown = ((await resultTool.execute("sdkm", { work_id: wId, part: "messages" }, undefined as any, undefined as any, {} as any)).content[0] as any).text as string;
    assert.match(shown, new RegExp(`SubAgent ${aId} → SubAgent ${bId}`));
    assert.match(shown, /主 Agent → SubAgent/);
    assert.match(shown, /已投递（任务/);
    assert.match(shown, /CAP-SUP1/);
  } finally {
    releaseSender();
    await t.shutdown();
  }
});

test("main 通道：SubAgent→主 Agent 经唤醒任务送达；主 Agent→SubAgent 补充", async () => {
  let aId = "";
  let wId = "";
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派")) {
      if (afterTool(req)) return { kind: "text", text: "已提问" };
      if (text.includes("问主Agent")) {
        return { kind: "tool_calls", calls: [{ id: "q1", name: "subagent_message", arguments: { work_id: wId, key: "q1", text: "请补充数据CAP-Q1" } }] };
      }
      return { kind: "text", text: "核对结论" };
    }
    if (text.includes("[工作内消息")) {
      if (afterTool(req)) return { kind: "text", text: "已答复" };
      if (text.includes("请补充数据")) {
        return {
          kind: "tool_calls",
          calls: [{ id: "a1", name: "subagent_message", arguments: { work_id: wId, key: "a1", text: "补充数据CAP-A1", to_sub_agent_id: aId } }],
        };
      }
      return { kind: "text", text: "收到CAP-GOT1" };
    }
    if (afterTool(req)) return { kind: "text", text: "已安排" };
    if (text.includes("安排核对")) {
      return { kind: "tool_calls", calls: [{ id: "d1", name: "subagent_delegate", arguments: { request: "核对材料", key: "w1", materials: [{ kind: "text", text: "材料X" }] } }] };
    }
    return { kind: "text", text: "main 回复" };
  };
  const t = await startTestRuntime("smsg-main", responder, { config: realTools() });
  try {
    const rt = t.runtime;
    const main = rt.store.getAgentRole("main")!;
    const parent = await rt.submit({ sessionId: main.sessionId, requestId: "pm1", input: "安排核对", modelSelection: rt.defaultSelection });
    await waitFor("main 父完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const work = rt.store.listWorkDelegationsBySession(main.sessionId)[0]!;
    wId = work.id;
    aId = work.subAgentId;
    await waitFor("子完成", () => rt.store.listTasksByWork(wId).some((x: any) => x.resultSummary !== null));
    await waitIdle(rt, aId);

    // SubAgent→主 Agent：唤醒任务按 smsg:<消息ID> 固定键登记
    const cont = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "c1", request: "问主Agent", workId: wId, readPaths: null, materials: [{ kind: "text", text: "材料Y" }], paramsDigest: "dc1" });
    await waitFor("消息登记", () => rt.store.listSubAgentMessagesByWork(wId).length >= 1);
    const msgs = rt.store.listSubAgentMessagesByWork(wId);
    assert.equal(msgs[0]!.toSubAgentId, null);
    await waitFor("唤醒任务已建", () => rt.store.findTaskByRequest(main.sessionId, `smsg:${msgs[0]!.id}`) !== null);
    const wake = rt.store.findTaskByRequest(main.sessionId, `smsg:${msgs[0]!.id}`)!;
    assert.equal(wake.agentId, "main");
    assert.equal(wake.accessMode, "confirm");
    assert.equal(wake.deadline, null);
    assert.match(wake.input, /\[工作内消息 · 工作 .*\]/);
    assert.match(wake.input, new RegExp(`来自：SubAgent ${aId}（工作 ${wId}，执行任务 ${cont.task.id}）`));
    assert.match(wake.input, /CAP-Q1/);
    assert.equal(rt.store.getSubAgentMessage(msgs[0]!.id)!.deliveredTaskId, wake.id);
    await waitFor("唤醒完成", () => rt.store.getTask(wake.id)!.status === "completed");

    // 主 Agent→SubAgent：唤醒轮次经工具补充后投递为 SubAgent 的本工作任务
    await waitFor("补充投递", () => deliveryTasksOf(rt, rt.store.getSubAgent(aId)!.sessionId).length === 1);
    const delivery = deliveryTasksOf(rt, rt.store.getSubAgent(aId)!.sessionId)[0]!;
    assert.match(delivery.input, new RegExp(`来自：主 Agent（父会话任务 ${wake.id}）`));
    assert.match(delivery.input, /CAP-A1/);
    await waitFor("补充任务完成", () => rt.store.getTask(delivery.id)!.resultSummary !== null);
    assert.match(rt.store.getTask(delivery.id)!.resultSummary!, /CAP-GOT1/);
    assert.equal(rt.store.listSubAgentMessagesByWork(wId).length, 2);
    assert.equal(eventsOf(rt, "subagent_message.sent", main.sessionId).length, 2);
  } finally {
    await t.shutdown();
  }
});

test("范围拒绝：跨身份/跨工作/资格已失/已关闭/已取消/自发自收/参数；均无消息行", async () => {
  const responder: Responder = async (req) => {
    return { kind: "text", text: lastUserText(req).includes("[SubAgent 委派") ? "分析结论" : "父回复" };
  };
  const t = await startTestRuntime("smsg-scope", responder, { config: realTools() });
  try {
    const rt = t.runtime;
    const session = await rt.createSession({ projectName: "scope", cwd: t.work[0]! });
    const other = await rt.createSession({ projectName: "scope2", cwd: t.work[1]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    const otherParent = await rt.submit({ sessionId: other.id, requestId: "po1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed" && rt.store.getTask(otherParent.id)!.status === "completed");
    const a = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "a1", request: "调研", readPaths: ["."], materials: null, paramsDigest: "da1" });
    const b = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "b1", request: "独立任务", readPaths: ["."], materials: null, paramsDigest: "db1" });
    await waitFor("子完成", () => rt.store.getTask(a.task.id)!.resultSummary !== null && rt.store.getTask(b.task.id)!.resultSummary !== null);
    await waitIdle(rt, a.agent.id);
    await waitIdle(rt, b.agent.id);
    const W = a.work.id;
    const send = (over: Record<string, unknown>) =>
      messageFromActiveTask(rt, { senderTaskId: parent.id, workId: W, key: "k", text: "hi", paramsDigest: "d", ...over } as any);
    const count = () => rt.store.listSubAgentMessagesByWork(W).length;

    // 主 Agent 发送必须指定接收的 SubAgent
    await assert.rejects(() => send({}), /必须指定接收的 SubAgent/);
    // 跨父会话：其他会话的任务不能在该工作中发言
    await assert.rejects(() => send({ senderTaskId: otherParent.id, toSubAgentId: a.agent.id }), /只能在本工作的父会话/);
    // 发送方不在本工作：A 的任务对 B 的工作发言
    await assert.rejects(
      () => messageFromActiveTask(rt, { senderTaskId: a.task.id, workId: b.work.id, key: "k", text: "hi", paramsDigest: "d" }),
      /只能从本工作的执行任务/,
    );
    // 接收方不在本工作：B 的当前工作不是 W
    await assert.rejects(() => send({ toSubAgentId: b.agent.id }), /当前工作不是本工作/);
    // User 身份不能伪造：发送方只能是主 Agent 或本工作 SubAgent（会话其余任务）
    const fakeTask = { id: "task_none_00000000" };
    await assert.rejects(() => messageFromActiveTask(rt, { senderTaskId: fakeTask.id, workId: W, key: "k", text: "hi", paramsDigest: "d" }), /发起任务不存在/);
    // 自发自收
    await assert.rejects(
      () => messageFromActiveTask(rt, { senderTaskId: a.task.id, workId: W, key: "k", text: "hi", toSubAgentId: a.agent.id, paramsDigest: "d" }),
      /不能发送给自己/,
    );
    // 正文超限
    await assert.rejects(() => send({ toSubAgentId: a.agent.id, text: "x".repeat(4097) }), /超过 4096 字符/);
    // 幂等冲突：同键异参
    const ok = await send({ toSubAgentId: a.agent.id });
    assert.equal(ok.created, true);
    await assert.rejects(() => send({ toSubAgentId: a.agent.id, paramsDigest: "d-other" }), /幂等键冲突/);
    await waitFor("投递完成", () => rt.store.getTask(ok.message.deliveredTaskId!)!.resultSummary !== null);
    await waitIdle(rt, a.agent.id);

    // 已关闭：明确拒绝，且不把关闭当作重建 Agent 的理由（换键避免命中上方查重）
    rt.subagents!.close({ subAgentId: b.agent.id, by: "owner" });
    try {
      await send({ toSubAgentId: b.agent.id, key: "k-closed" });
      assert.fail("应拒绝");
    } catch (err) {
      assert.match((err as Error).message, /已关闭/);
      assert.match((err as Error).message, /消息未投递/);
      assert.ok(!(err as Error).message.includes("新建"), "消息路径不把关闭当作重建理由");
    }
    // 已取消的工作不能投递（换键避免命中上方查重）
    await rt.subagents!.cancelWork({ workId: W, by: "owner" });
    await assert.rejects(() => send({ toSubAgentId: a.agent.id, key: "k-canceled" }), /工作已取消/);
    assert.equal(count(), 1, "全部拒绝没有产生新消息行");
  } finally {
    await t.shutdown();
  }
});

test("复用后资格转移：旧协作方消息被拒，迟到旧消息不进入新工作上下文；冲刷记 moved_work", async () => {
  const responder: Responder = async (req) => {
    return { kind: "text", text: lastUserText(req).includes("[SubAgent 委派") ? "分析结论" : "父回复" };
  };
  const t = await startTestRuntime("smsg-reuse", responder, { config: realTools() });
  try {
    const rt = t.runtime;
    const session = await rt.createSession({ projectName: "reuse", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const a = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "a1", request: "调研", readPaths: ["."], materials: null, paramsDigest: "da1" });
    await waitFor("A 完成", () => rt.store.getTask(a.task.id)!.resultSummary !== null);
    await waitIdle(rt, a.agent.id);
    const b = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "b1", request: "独立任务", readPaths: ["."], materials: null, paramsDigest: "db1" });
    await waitFor("B 完成", () => rt.store.getTask(b.task.id)!.resultSummary !== null);
    await waitIdle(rt, b.agent.id);
    const W = a.work.id;
    const join = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "j1", request: "加入协作", workId: W, subAgentId: b.agent.id, readPaths: ["."], materials: null, paramsDigest: "dj1" });
    await waitFor("加入完成", () => rt.store.listTasksByWork(W).some((x: any) => x.subAgentId === b.agent.id && x.resultSummary !== null));
    await waitIdle(rt, b.agent.id);

    // B 复用于 W2：当前工作切换，W 内的通信资格按当前工作重新确定
    const w2 = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "w2", request: "新工作CAP-W2", subAgentId: b.agent.id, readPaths: ["."], materials: null, paramsDigest: "dw2" });
    assert.equal(rt.store.getSubAgent(b.agent.id)!.activeWorkId, w2.work.id);
    await waitFor("W2 完成", () => rt.store.getTask(w2.task.id)!.resultSummary !== null);
    await waitIdle(rt, b.agent.id);
    await assert.rejects(
      () => messageFromActiveTask(rt, { senderTaskId: parent.id, workId: W, key: "k1", text: "旧工作CAP-OLD-MSG", toSubAgentId: b.agent.id, paramsDigest: "dk1" }),
      { code: "invalid_state", message: /当前工作不是本工作/ },
    );
    await assert.rejects(
      () => messageFromActiveTask(rt, { senderTaskId: a.task.id, workId: W, key: "k1", text: "hi", toSubAgentId: b.agent.id, paramsDigest: "dk1" }),
      /当前工作不是本工作/,
    );
    assert.equal(rt.store.listSubAgentMessagesByWork(W).filter((m: any) => m.toSubAgentId === b.agent.id).length, 0);
    // W2 的模型上下文不含旧工作消息（旧消息从未进入新工作的任务输入）
    const w2Calls = t.server.calls.filter((c) => inputText(c).includes("新工作CAP-W2"));
    assert.ok(w2Calls.length > 0 && w2Calls.every((c) => !inputText(c).includes("CAP-OLD-MSG")));

    // 冲刷守卫（单测级）：待投递消息的接收方已转做其他工作时记 moved_work 不投递。
    // 用活动任务把消息确定停于 pending；接收方随后转做其他工作，冲刷必须
    // 重核当前工作，不能让等待期间准备好的投递进入新工作上下文。
    rt.store.setSessionQueueState(rt.store.getSubAgent(b.agent.id)!.sessionId, "paused", "test_fixture");
    const busyFixture = rt.store.withTx(() =>
      rt.store.insertQueuedTask({
        sessionId: rt.store.getSubAgent(b.agent.id)!.sessionId,
        requestId: "smsg-fixture-busy",
        input: "占住",
        accessMode: "confirm",
        modelSelection: rt.defaultSelection,
        submissionDigest: "fixture-busy",
        parentTaskId: join.task.parentTaskId,
        sourcePermissionVersion: join.task.sourcePermissionVersion,
        readScope: join.task.readScope,
        workId: W,
        subAgentId: b.agent.id,
      }),
    ).task;
    rt.store.setSubAgentState(b.agent.id, "running", { activeWorkId: W, currentTaskId: busyFixture.id });
    const pending = await messageFromActiveTask(rt, { senderTaskId: parent.id, workId: W, key: "k2", text: "迟到CAP-LATE", toSubAgentId: b.agent.id, paramsDigest: "dk2" });
    assert.equal(pending.delivery, "pending");
    // 随后 B 转做其他工作（复用登记的等价结果）：冲刷判定资格已失
    rt.store.setSubAgentState(b.agent.id, "idle", { activeWorkId: w2.work.id, currentTaskId: null });
    await rt.subagents!.flushPendingMessages(session.id);
    const dropped = rt.store.getSubAgentMessage(pending.message.id)!;
    assert.equal(dropped.undeliveredReason, "moved_work");
    assert.equal(dropped.deliveredTaskId, null);
    assert.equal(eventsOf(rt, "subagent_message.dropped", session.id).at(-1)!.reason, "moved_work");
    assert.equal(deliveryTasksOf(rt, rt.store.getSubAgent(b.agent.id)!.sessionId).length, 0, "迟到旧消息没有成为 B 的执行任务");
    // 清理布置的占队任务
    const stuck = rt.store.findTaskByRequest(rt.store.getSubAgent(b.agent.id)!.sessionId, "smsg-fixture-busy")!;
    await rt.cancelTask(stuck.id);
    await rt.resumeQueue(rt.store.getSubAgent(b.agent.id)!.sessionId).catch(() => {});
  } finally {
    await t.shutdown();
  }
});

test("关闭后的投递有明确结果：冲刷记 closed；消息错误不把关闭当作重建理由", async () => {
  const responder: Responder = async (req) => {
    return { kind: "text", text: lastUserText(req).includes("[SubAgent 委派") ? "分析结论" : "父回复" };
  };
  const t = await startTestRuntime("smsg-close", responder, { config: realTools() });
  try {
    const rt = t.runtime;
    const session = await rt.createSession({ projectName: "close", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const a = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "a1", request: "调研", readPaths: ["."], materials: null, paramsDigest: "da1" });
    await waitFor("A 完成", () => rt.store.getTask(a.task.id)!.resultSummary !== null);
    await waitIdle(rt, a.agent.id);
    const W = a.work.id;

    // 忙时登记的待投递 → Agent 关闭（与 moved_work 同一布置口径：正常路径里
    // 终态冲刷先于关闭可用，复合状态按最终状态布置）
    const b = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "b1", request: "独立任务", readPaths: ["."], materials: null, paramsDigest: "db1" });
    await waitFor("B 完成", () => rt.store.getTask(b.task.id)!.resultSummary !== null);
    await waitIdle(rt, b.agent.id);
    const join = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "j1", request: "加入协作", workId: W, subAgentId: b.agent.id, readPaths: ["."], materials: null, paramsDigest: "dj1" });
    await waitFor("加入完成", () => rt.store.listTasksByWork(W).some((x: any) => x.subAgentId === b.agent.id && x.resultSummary !== null));
    await waitIdle(rt, b.agent.id);
    rt.store.setSessionQueueState(rt.store.getSubAgent(b.agent.id)!.sessionId, "paused", "test_fixture");
    await rt.store.withTx(() =>
      rt.store.insertQueuedTask({
        sessionId: rt.store.getSubAgent(b.agent.id)!.sessionId,
        requestId: "smsg-fixture-busy2",
        input: "占住",
        accessMode: "confirm",
        modelSelection: rt.defaultSelection,
        submissionDigest: "fixture-busy2",
        parentTaskId: join.task.parentTaskId,
        sourcePermissionVersion: join.task.sourcePermissionVersion,
        readScope: join.task.readScope,
        workId: W,
        subAgentId: b.agent.id,
      }),
    );
    rt.store.setSubAgentState(b.agent.id, "running", { activeWorkId: W });
    const pending = await messageFromActiveTask(rt, { senderTaskId: parent.id, workId: W, key: "k1", text: "看到请回", toSubAgentId: b.agent.id, paramsDigest: "dk1" });
    assert.equal(pending.delivery, "pending");
    // 名额上限或异步冲刷窗口可能留下 pending；按关闭后的最终状态布置，先
    // 写关闭列再冲刷，最后清理占队任务，避免夹具清理先触发实际投递。
    // 关闭列由 store 条件写入；关闭路径的 flushPendingMessages 与本断言共用同一判定
    const closedAt = new Date().toISOString();
    assert.equal(rt.store.closeSubAgent(b.agent.id, closedAt, "owner"), true);
    await rt.subagents!.flushPendingMessages(session.id);
    const dropped = rt.store.getSubAgentMessage(pending.message.id)!;
    assert.equal(dropped.undeliveredReason, "closed:" + closedAt);
    assert.equal(eventsOf(rt, "subagent_message.dropped", session.id).at(-1)!.reason, `closed:${closedAt}`);
    const stuck = rt.store.findTaskByRequest(rt.store.getSubAgent(b.agent.id)!.sessionId, "smsg-fixture-busy2")!;
    await rt.cancelTask(stuck.id);
    assert.equal(deliveryTasksOf(rt, rt.store.getSubAgent(b.agent.id)!.sessionId).length, 0);
    // 同键重放仍返回原记录（对账的是同一条逻辑消息，不是重新创建）
    const replay = await messageFromActiveTask(rt, { senderTaskId: parent.id, workId: W, key: "k1", text: "看到请回", toSubAgentId: b.agent.id, paramsDigest: "dk1" });
    assert.equal(replay.created, false);
    assert.equal(replay.message.id, pending.message.id);
    await rt.resumeQueue(rt.store.getSubAgent(b.agent.id)!.sessionId).catch(() => {});
  } finally {
    await t.shutdown();
  }
});

test("幂等与账本：同键同参返回原记录（含工具层重放），异参冲突；冲刷重入不重复", async () => {
  const responder: Responder = async (req) => {
    return { kind: "text", text: lastUserText(req).includes("[SubAgent 委派") ? "分析结论" : "父回复" };
  };
  const t = await startTestRuntime("smsg-idem", responder, { config: realTools() });
  try {
    const rt = t.runtime;
    const session = await rt.createSession({ projectName: "idem", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const a = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "a1", request: "调研", readPaths: ["."], materials: null, paramsDigest: "da1" });
    await waitFor("A 完成", () => rt.store.getTask(a.task.id)!.resultSummary !== null);
    await waitIdle(rt, a.agent.id);
    const W = a.work.id;
    const agentSession = a.agent.sessionId;

    // 忙时登记 → 多次冲刷仍只有一条逻辑消息与一个投递任务、一个事件
    rt.store.setSessionQueueState(agentSession, "paused", "test_fixture");
    await rt.store.withTx(() =>
      rt.store.insertQueuedTask({
        sessionId: agentSession,
        requestId: "smsg-fixture-busy3",
        input: "占住",
        accessMode: "confirm",
        modelSelection: rt.defaultSelection,
        submissionDigest: "fixture-busy3",
        parentTaskId: a.task.parentTaskId,
        sourcePermissionVersion: a.task.sourcePermissionVersion,
        readScope: a.task.readScope,
        workId: W,
        subAgentId: a.agent.id,
      }),
    );
    rt.store.setSubAgentState(a.agent.id, "running", { activeWorkId: W });
    const sent = await messageFromActiveTask(rt, { senderTaskId: parent.id, workId: W, key: "k1", text: "排队CAP-Q", toSubAgentId: a.agent.id, paramsDigest: "dk1" });
    assert.equal(sent.delivery, "pending");
    // 同键同参（忙碌中也返回原记录，不重复形成同一条逻辑消息）
    const again = await messageFromActiveTask(rt, { senderTaskId: parent.id, workId: W, key: "k1", text: "排队CAP-Q", toSubAgentId: a.agent.id, paramsDigest: "dk1" });
    assert.equal(again.created, false);
    assert.equal(again.message.id, sent.message.id);
    assert.equal(rt.store.listSubAgentMessagesByWork(W).length, 1);
    const stuck = rt.store.findTaskByRequest(agentSession, "smsg-fixture-busy3")!;
    await rt.cancelTask(stuck.id);
    rt.store.setSubAgentState(a.agent.id, "idle", { activeWorkId: W, currentTaskId: null });
    await rt.subagents!.flushPendingMessages(session.id);
    await rt.subagents!.flushPendingMessages(session.id); // 重入不重复
    assert.equal(deliveryTasksOf(rt, agentSession).length, 1);
    assert.equal(eventsOf(rt, "subagent_message.sent", session.id).filter((e) => e.messageId === sent.message.id).length, 1);
    const deliveredTaskId = rt.store.getSubAgentMessage(sent.message.id)!.deliveredTaskId!;
    await rt.resumeQueue(agentSession);
    await waitFor("投递完成", () => rt.store.getTask(deliveredTaskId)!.resultSummary !== null);
    assert.equal(rt.store.getTask(deliveredTaskId)!.status, "completed");
    assert.equal(t.server.calls.filter(call => lastUserText(call).includes("排队CAP-Q")).length, 1, "同一逻辑消息实际请求模型一次");
    await waitIdle(rt, a.agent.id);

    // 工具层重放（真实装配）：同一任务上下文同键同参直接返回原记录
    const messageTool = createSubAgentMessageTool({
      store: rt.store,
      message: (input) => messageFromActiveTask(rt, input),
      taskContext: () => ({ taskId: parent.id, sessionId: session.id, projectId: rt.store.getSession(session.id)!.projectId, hostOpId: "opx" }),
      bindCall: undefined,
    });
    const first = await messageTool.execute("sdk1", { work_id: W, key: "k2", text: "hi", to_sub_agent_id: a.agent.id }, undefined as any, undefined as any, {} as any);
    assert.match((first.content[0] as any).text as string, /已发送：消息/);
    const replay = await messageTool.execute("sdk2", { work_id: W, key: "k2", text: "hi", to_sub_agent_id: a.agent.id }, undefined as any, undefined as any, {} as any);
    assert.match((replay.content[0] as any).text as string, /同键同参已发送过，返回原记录/);
    assert.equal(rt.store.listSubAgentMessagesByWork(W).length, 2);

    // 工具操作账本：subagent_message 按（工作, 发送方, 键）核实
    const check = subagentOpCheck(rt.store);
    assert.equal(check.verify({ taskId: parent.id, toolName: "subagent_message", params: { work_id: W, key: "k2" } }), "committed");
    assert.equal(check.verify({ taskId: parent.id, toolName: "subagent_message", params: { work_id: W, key: "k-none" } }), "not_committed");
    // 发送方区分：同键但不同发送方（A 的任务）独立核实
    assert.equal(check.verify({ taskId: a.task.id, toolName: "subagent_message", params: { work_id: W, key: "k2" } }), "not_committed");
  } finally {
    await t.shutdown();
  }
});

test("main 截住排队的消息唤醒：main 本轮阻塞时 SubAgent 发消息，本轮 subagent_cancel 后消息唤醒按 work_canceled 取消、零模型调用", async () => {
  let wId = "";
  let release: (() => void) | undefined;
  const marks: string[] = [];
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派")) return { kind: "text", text: "分析结论" };
    if (text.includes("[工作内消息")) {
      marks.push(inputText(req));
      return { kind: "text", text: "不应到达" };
    }
    if (text.includes("阻塞轮")) {
      if (afterTool(req)) return { kind: "text", text: "已取消" };
      await new Promise<void>((res) => (release = res));
      return { kind: "tool_calls", calls: [{ id: "c1", name: "subagent_cancel", arguments: { work_id: wId } }] };
    }
    return { kind: "text", text: "main 回复" };
  };
  const t = await startTestRuntime("smsg-main-cancel", responder, { config: realTools() });
  try {
    const rt = t.runtime;
    const main = rt.store.getAgentRole("main")!;
    const parent = await rt.submit({ sessionId: main.sessionId, requestId: "pm1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("main 父完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const a = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "w1", request: "核对", materials: [{ kind: "text", text: "材料" }], readPaths: null, paramsDigest: "dw1" });
    wId = a.work.id;
    await waitFor("结果唤醒完成", () => rt.store.findTaskByRequest(main.sessionId, `wake:${a.task.id}`)?.status === "completed");
    await waitIdle(rt, a.agent.id);

    // main 本轮阻塞在模型调用中；SubAgent 此时发来消息，消息唤醒排在本轮之后
    const blocking = await rt.submit({ sessionId: main.sessionId, requestId: "pm2", input: "阻塞轮", modelSelection: rt.defaultSelection });
    await waitFor("main 本轮模型调用在途", () => release !== undefined);
    const sent = await messageFromActiveTask(rt, { senderTaskId: a.task.id, workId: wId, key: "late", text: "迟到消息CAP-LATE", paramsDigest: "dl" } as any);
    assert.equal(sent.delivery, "wake");
    const wake = rt.store.findTaskByRequest(main.sessionId, `smsg:${sent.message.id}`)!;
    assert.equal(wake.status, "queued");

    // main 本轮调用 subagent_cancel；本轮结束后队列门截住消息唤醒
    release!();
    await waitFor("本轮完成", () => rt.store.getTask(blocking.id)!.status === "completed");
    assert.ok(rt.store.getWorkDelegation(wId)!.canceledAt !== null);
    await waitFor("消息唤醒到达终态", () => ["canceled", "completed", "failed"].includes(rt.store.getTask(wake.id)!.status));
    assert.equal(rt.store.getTask(wake.id)!.status, "canceled");
    assert.equal(rt.store.getTask(wake.id)!.errorMessage, "work_canceled");
    assert.equal(marks.length, 0, "被截住的消息唤醒不调用模型");

    // 消息行不改（投递登记仍指向承载任务），读取时标明未送达
    assert.equal(rt.store.getSubAgentMessage(sent.message.id)!.deliveredTaskId, wake.id);
    const tools = createSubAgentTools({
      coreStore: rt.store,
      sources: (rt as any).sources,
      delegate: (input) => delegateFromActiveTask(rt, input),
      close: (input) => rt.subagents!.close(input),
      cancelWork: (input) => rt.subagents!.cancelWork(input),
      message: (input) => messageFromActiveTask(rt, input),
      integrate: (input) => rt.subagents!.integrate(input),
      readReply: (taskId, offset, length) => rt.readTaskReply(taskId, offset, length),
      artifacts: rt.artifacts,
      taskContext: () => ({ taskId: parent.id, sessionId: main.sessionId, projectId: rt.store.getSession(main.sessionId)!.projectId, hostOpId: "opmc" }),
      bindCall: undefined,
      verifyHost: () => null,
    });
    const resultTool = tools.find((x) => x.name === "subagent_result")!;
    const shown = ((await resultTool.execute("sdkmc", { work_id: wId, part: "messages" }, undefined as any, undefined as any, {} as any)).content[0] as any).text as string;
    assert.ok(shown.includes(`已投递（任务 ${wake.id}）（工作已取消，未送达）`), shown);
  } finally {
    release?.();
    await t.shutdown();
  }
});

test("dev 注入通道：SubAgent→主 Agent 随下一次模型调用送达并标记；已取消不注入", async () => {
  const marker: string[] = [];
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派")) return { kind: "text", text: "分析结论" };
    marker.push(inputText(req));
    return { kind: "text", text: "继续" };
  };
  const t = await startTestRuntime("smsg-inject", responder, { config: realTools() });
  try {
    const rt = t.runtime;
    const session = await rt.createSession({ projectName: "inject", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const a = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "a1", request: "调研", readPaths: ["."], materials: null, paramsDigest: "da1" });
    await waitFor("A 完成", () => rt.store.getTask(a.task.id)!.resultSummary !== null);
    const b = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "b1", request: "调研", readPaths: ["."], materials: null, paramsDigest: "db1" });
    await waitFor("B 完成", () => rt.store.getTask(b.task.id)!.resultSummary !== null);
    const beforeOwnerCalls = marker.length;

    // 两条发给主 Agent 的消息：一条送达注入，一条所属工作随后取消
    const m1 = await messageFromActiveTask(rt, { senderTaskId: a.task.id, workId: a.work.id, key: "p1", text: "汇报CAP-P1", paramsDigest: "dp1" } as any);
    assert.equal(m1.delivery, "inject");
    const m2 = await messageFromActiveTask(rt, { senderTaskId: b.task.id, workId: b.work.id, key: "p2", text: "汇报CAP-P2", paramsDigest: "dp2" } as any);
    await rt.subagents!.cancelWork({ workId: b.work.id, by: "owner" });
    assert.equal(rt.store.getSubAgentMessage(m2.message.id)!.undeliveredReason, "work_canceled");

    const owner2 = await rt.submit({ sessionId: session.id, requestId: "p2", input: "下一步", modelSelection: rt.defaultSelection });
    await waitFor("第二轮完成", () => rt.store.getTask(owner2.id)!.status === "completed");
    const call = marker.slice(beforeOwnerCalls).find((text) => text.includes("[工作内消息]"))!;
    assert.ok(call, "dev 下一次模型调用带 [工作内消息] 参考块");
    assert.match(call, new RegExp(`消息 ${m1.message.id} · 来自 SubAgent ${a.agent.id}（工作 ${a.work.id}`));
    assert.match(call, /CAP-P1/);
    assert.match(call, /不是拥有者的新要求，不授予额外权限/);
    assert.ok(!call.includes("CAP-P2"), "已取消工作的消息不注入");
    // 注入即送达：标记在收集事务内写入
    const done1 = rt.store.getSubAgentMessage(m1.message.id)!;
    assert.ok(done1.deliveredAt !== null && done1.deliveredTaskId === null);
    assert.equal(rt.store.getSubAgentMessage(m2.message.id)!.undeliveredReason, "work_canceled");
    // 注入不重复：再下一轮不再出现同一消息
    const owner3 = await rt.submit({ sessionId: session.id, requestId: "p3", input: "再下一步", modelSelection: rt.defaultSelection });
    await waitFor("第三轮完成", () => rt.store.getTask(owner3.id)!.status === "completed");
    const latest = marker.findLast((text) => text.includes("再下一步")) ?? marker.at(-1)!;
    assert.ok(!latest.includes(m1.message.id), "已注入消息不重复注入");
  } finally {
    await t.shutdown();
  }
});
