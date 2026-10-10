/**
 * 整项工作取消（agent-direction issue 14）。
 * Note: 见 .agents/notes/implemented/feature/2026-10-04-cancel-work.md
 *
 * seam：Runtime 公共接口 + mock 模型 + 真实只读工具（realTools，local 后端）；
 * 准备阶段竞争用门闩化 resolveSelection 的管理器实例（共享同一 store）取得
 * 确定性；启动窗口用延迟化 getDriver 取得确定性。
 *
 * 覆盖五项验收：
 * - 只停被取消的工作：同一父会话下工作 A 的 running（模型挂起）与排队任务
 *   全部停止，工作 B 照常完成并可继续委派；拥有者控制面与主 Agent 工具各一遍；
 * - 竞争：准备中取消报「工作已取消」零新任务；先提交的新任务出现在取消
 *   清单；已转 running 未进 Driver 的窗口里取消不被吞（工作取消与单任务
 *   cancelTask 各一例，零模型调用）；工具执行中取消（共享停止路径）标
 *   effect_unknown 不重放；自然完成竞争唯一终态且结果不被改写；
 * - 迟到结果：结果保存为事实可查；main 不建 wake（取消前已排队的 wake 被
 *   队列检查取消且不调用模型）；dev 下一轮不注入；重启巡检不补发；已取消
 *   工作不能登记新执行，同键重放只返回原记录；
 * - 身份与终态：SubAgent 未关闭（正常回收记 idle，占用注入记 unverified）；
 *   工作目录/JSONL/resultRef 保留；work_get 与 subagent_result 标明取消与
 *   发起者；重复取消幂等；跨父会话与 SubAgent 会话拒绝；账本核实正确；
 * - 迁移：v25 → v26 旧工作三列为空。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { type MockResponse, type Responder } from "./helpers/mock-provider.ts";
import { afterTool, lastToolText, inputText, cleanupDirs, lastUserText, makeTestDirs, realTools, startTestRuntime, waitFor } from "./helpers/testkit.ts";
import { createSubAgentTools } from "../src/agent/subagent-tools.ts";
import { type Runtime } from "../src/runtime/runtime.ts";
import { subagentOpCheck, subAgentTaskRequestId, SubAgentManager } from "../src/runtime/subagents.ts";
import { WorkCopyManager } from "../src/runtime/work-copy.ts";

/** 结果登记与 Agent 空闲在同一事务；等 resultSummary 即等空闲可用。 */
async function waitIdle(rt: Runtime, agentId: string): Promise<void> {
  await waitFor("Agent 空闲", () => rt.store.getSubAgent(agentId)!.state === "idle");
}

/** SQL 不变式：已取消工作下不存在 queued 任务。 */
function queuedUnderCanceledCount(rt: Runtime): number {
  return Number(
    (
      rt.store.db
        .prepare(
          `SELECT COUNT(*) AS n FROM tasks t JOIN work_delegations w ON w.id = t.work_id
           WHERE w.canceled_at IS NOT NULL AND t.status = 'queued'`,
        )
        .get() as any
    ).n,
  );
}

/** 事件表里的某类事件（按会话过滤；TUI 归属展示与审计共用）。 */
function eventsOf(rt: Runtime, type: string, sessionId?: string): any[] {
  const rows = (sessionId
    ? rt.store.db.prepare("SELECT body FROM events WHERE session_id = ?").all(sessionId)
    : rt.store.db.prepare("SELECT body FROM events").all()) as Array<{ body: string }>;
  return rows.map((r) => JSON.parse(r.body)).filter((b) => b.type === type);
}

test("只停被取消的工作（dev，拥有者控制面 work_cancel）：A 的 running/queued 全部停止，B 照常完成并可继续委派", async () => {
  let releaseSlow!: () => void;
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派")) {
      if (text.includes("工作A慢分析")) {
        await new Promise<void>((res) => (releaseSlow = res));
        return { kind: "text", text: "SUB-A-迟到的回复" };
      }
      if (text.includes("工作B分析")) return { kind: "text", text: "SUB-B-DONE 结论" };
      if (text.includes("工作B继续")) return { kind: "text", text: "SUB-B-继续结论" };
      return { kind: "text", text: "SUB-DONE" };
    }
    return { kind: "text", text: "父回复" };
  };
  const t = await startTestRuntime("cancel-work-dev", responder, { config: realTools() });
  try {
    const rt = t.runtime;
    const session = await rt.createSession({ projectName: "cdev", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");

    // 工作 A：running 子任务（模型挂起）+ 直接落库的排队任务
    const a = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "a1", request: "工作A慢分析", readPaths: ["."], materials: null, paramsDigest: "da1" });
    await waitFor("A 的模型调用在途", () => typeof releaseSlow === "function" && rt.store.getTask(a.task.id)!.status === "running");
    rt.store.withTx(() =>
      rt.store.insertQueuedTask({
        sessionId: a.agent.sessionId,
        requestId: subAgentTaskRequestId(a.work.id, "a-queued"),
        input: "工作A排队任务MARK-A2",
        accessMode: "confirm",
        modelSelection: rt.defaultSelection,
        submissionDigest: "fixture-queued",
        parentTaskId: parent.id,
        workId: a.work.id,
        subAgentId: a.agent.id,
      }),
    );

    // 工作 B：同一父会话下另一 SubAgent，running 后完成
    const b = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "b1", request: "工作B分析", readPaths: ["."], materials: null, paramsDigest: "db1" });

    // 拥有者经控制面取消工作 A（CLI 同路）
    const cancelled = (await t.client.request<any>("work_cancel", { work_id: a.work.id, reason: "测试取消" })) as any;
    assert.equal(cancelled.alreadyCanceled, false);
    assert.equal(cancelled.work.canceledBy, "owner");
    assert.equal(cancelled.work.cancelReason, "测试取消");

    // A 的排队任务直接 canceled（零模型请求）
    const queuedA = rt.store.listTasksByWork(a.work.id).find((x) => x.id !== a.task.id)!;
    assert.equal(queuedA.status, "canceled");
    assert.equal(queuedA.errorMessage, "work_canceled");
    assert.equal(queuedA.startedAt, null, "排队任务未启动");
    assert.equal(t.server.calls.filter((c) => inputText(c).includes("MARK-A2")).length, 0, "排队任务零模型请求");

    // A 的 running 任务经停止路径变为 canceled（取消意图持久化，占用释放）
    assert.equal(rt.store.getTask(a.task.id)!.status, "canceled");
    assert.equal(rt.store.getTask(a.task.id)!.cancelRequested, true);
    assert.equal(rt.store.listAllOccupancy().filter((o) => o.sessionId === a.agent.sessionId).length, 0, "执行占用已回收");
    releaseSlow();

    // work_delegation.canceled 事件：queued 与 running 分别登记；refs 指向父会话
    const events = eventsOf(rt, "work_delegation.canceled", session.id);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]!.canceledTaskIds, [queuedA.id]);
    assert.deepEqual(events[0]!.stoppingTaskIds, [a.task.id]);
    assert.equal(events[0]!.workId, a.work.id);
    assert.equal(events[0]!.reason, "测试取消");

    // B 照常完成；另一项工作不受影响，A 的 Agent 未关闭
    await waitFor("B 完成", () => rt.store.getTask(b.task.id)!.resultSummary !== null);
    await waitIdle(rt, b.agent.id);
    assert.equal(rt.store.getTask(b.task.id)!.status, "completed");
    assert.equal(rt.store.getWorkDelegation(b.work.id)!.canceledAt, null);
    assert.equal(rt.store.getSubAgent(a.agent.id)!.closedAt, null, "取消不关闭 SubAgent");
    await waitIdle(rt, a.agent.id);

    // B 之后仍可继续委派
    const b2 = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "b2", request: "工作B继续", workId: b.work.id, readPaths: ["."], materials: null, paramsDigest: "db2" });
    assert.equal(b2.created, true);
    await waitFor("B 继续完成", () => rt.store.getTask(b2.task.id)!.resultSummary !== null);

    // 取消后不能沿 A 继续委派；同键同参重放返回原记录、不新建任务
    await assert.rejects(
      () => rt.subagents!.delegate({ parentTaskId: parent.id, key: "a-new", request: "继续", workId: a.work.id, readPaths: ["."], materials: null, paramsDigest: "dax" }),
      /工作已取消/,
    );
    const replay = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "a1", request: "工作A慢分析", readPaths: ["."], materials: null, paramsDigest: "da1" });
    assert.equal(replay.created, false, "同键重放返回原记录");
    assert.equal(replay.task.id, a.task.id);

    assert.equal(queuedUnderCanceledCount(rt), 0, "不变式：已取消工作下不存在 queued 任务");
  } finally {
    releaseSlow?.();
    await t.shutdown();
  }
});

test("主 Agent 工具取消（main）：subagent_cancel 取消，迟到结果保存为事实但不唤醒", async () => {
  let releaseSlow!: () => void;
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派")) {
      if (text.includes("main慢分析")) {
        await new Promise<void>((res) => (releaseSlow = res));
        return { kind: "text", text: "SUB-MAIN-迟到的回复" };
      }
      return { kind: "text", text: "SUB-DONE" };
    }
    return { kind: "text", text: "父回复" };
  };
  const t = await startTestRuntime("cancel-work-main", responder, { config: realTools() });
  try {
    const rt = t.runtime;
    const main = rt.store.getAgentRole("main")!;
    const parent = await rt.submit({ sessionId: main.sessionId, requestId: "pm1", input: "分析", modelSelection: rt.defaultSelection });
    await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");

    const work = await rt.subagents!.delegate({
      parentTaskId: parent.id,
      key: "m1",
      request: "main慢分析",
      materials: [{ kind: "text", text: "材料 M" }],
      readPaths: null,
      paramsDigest: "dm1",
    });
    await waitFor("子模型调用在途", () => typeof releaseSlow === "function");

    // 主 Agent 经真实装配的工具层取消（回报唤醒轮次也允许：工具不限定拥有者发起）
    const tools = createSubAgentTools({
      coreStore: rt.store,
      sources: (rt as any).sources,
      delegate: (input) => rt.subagents!.delegate(input),
      close: (input) => rt.subagents!.close(input),
      cancelWork: (input) => rt.subagents!.cancelWork(input),
      message: (input) => rt.subagents!.message(input),
      integrate: (input) => rt.subagents!.integrate(input),
      readReply: (taskId, offset, length) => rt.readTaskReply(taskId, offset, length),
      artifacts: rt.artifacts,
      taskContext: () => ({ taskId: parent.id, sessionId: main.sessionId, projectId: rt.store.getSession(main.sessionId)!.projectId, hostOpId: "opc" }),
      bindCall: undefined,
      verifyHost: () => null,
    });
    const cancelTool = tools.find((x) => x.name === "subagent_cancel")!;
    const resultTool = tools.find((x) => x.name === "subagent_result")!;
    const exec = (tool: any, params: any) => tool.execute("sdk1", params, undefined as any, undefined as any, {} as any);
    const reply = (await exec(cancelTool, { work_id: work.work.id, reason: "方向变了" })).content[0].text as string;
    assert.match(reply, /已取消/);
    const record = rt.store.getWorkDelegation(work.work.id)!;
    assert.equal(record.canceledBy, `agent:${parent.id}`);
    assert.equal(record.cancelReason, "方向变了");

    // 迟到结果：停止后结果登记一次（事件与 subagent_result 可查），但 main 不建 wake
    releaseSlow();
    await waitFor("结果已登记", () => rt.store.getTask(work.task.id)!.resultSummary !== null);
    assert.equal(rt.store.getTask(work.task.id)!.status, "canceled");
    assert.equal(rt.store.listTasksBySession(main.sessionId).filter((x) => x.requestId.startsWith("wake:")).length, 0, "不为已取消工作唤醒 main");
    assert.equal(eventsOf(rt, "subagent_task.failed", main.sessionId).length, 1, "终态事件保存为事实");
    const toolCalls = t.server.calls.filter((c) => inputText(c).includes("[SubAgent 委派") && inputText(c).includes("main慢分析"));
    assert.equal(toolCalls.length, 1, "停止后没有继续调用模型");

    // subagent_result 标明取消时间、发起者与原因，结果仍可读
    const shown = (await exec(resultTool, { work_id: work.work.id })).content[0].text as string;
    assert.ok(shown.includes("已取消"), "工作头部标明已取消");
    assert.ok(shown.includes(`agent:${parent.id}`), "标明取消发起者");
    assert.ok(shown.includes("方向变了"), "标明取消原因");

    // 工具操作账本：subagent_cancel 按 canceledAt 核实
    const check = subagentOpCheck(rt.store);
    assert.equal(check.verify({ taskId: parent.id, toolName: "subagent_cancel", params: { work_id: work.work.id } }), "committed");
    assert.equal(check.verify({ taskId: parent.id, toolName: "subagent_cancel", params: { work_id: "work_none" } }), "not_committed");

    // 已取消的工作不能再登记执行；同键重放只返回原记录
    await assert.rejects(
      () => rt.subagents!.delegate({ parentTaskId: parent.id, key: "m2", request: "继续", workId: work.work.id, materials: [{ kind: "text", text: "x" }], readPaths: null, paramsDigest: "dm2" }),
      /工作已取消/,
    );
    const replay = await rt.subagents!.delegate({
      parentTaskId: parent.id,
      key: "m1",
      request: "main慢分析",
      materials: [{ kind: "text", text: "材料 M" }],
      readPaths: null,
      paramsDigest: "dm1",
    });
    assert.equal(replay.created, false);
    assert.equal(queuedUnderCanceledCount(rt), 0);
  } finally {
    releaseSlow?.();
    await t.shutdown();
  }
});

test("竞争：准备阶段取消报已取消零新任务；先提交的新任务在取消清单内；自然完成竞争唯一终态", async () => {
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派")) return { kind: "text", text: "SUB-RACE" };
    return { kind: "text", text: "父回复" };
  };
  const t = await startTestRuntime("cancel-race", responder, { config: realTools() });
  try {
    const rt = t.runtime;
    const session = await rt.createSession({ projectName: "crace", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const first = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "r0", request: "首轮", readPaths: ["."], materials: null, paramsDigest: "dr0" });
    await waitFor("首轮完成", () => rt.store.getTask(first.task.id)!.resultSummary !== null);
    await waitIdle(rt, first.agent.id);

    // —— 委派已发出、尚在准备阶段的 await 中时取消：事务内报「工作已取消」，零新任务 ——
    let release!: () => void;
    const gated = new SubAgentManager({
      store: rt.store,
      workRoot: path.join(path.dirname(path.resolve(rt.config.dataDir)), "agent-work", "sub-agents"),
      workCopies: new WorkCopyManager({
        worktreeRoot: path.join(path.dirname(path.resolve(rt.config.dataDir)), "agent-work", "worktrees"),
        protectedRoots: () => rt.protectedRoots(),
      }),
      sources: (rt as any).sources,
      resolveSelection: () => new Promise<() => void>((res) => (release = () => res(() => {}))),
      launcherFor: (mode) => rt.launcherFor(mode),
      defaultModelSelection: () => rt.defaultSelection,
      kickSession: () => {},
      resumeQueue: (sessionId) => rt.resumeQueue(sessionId),
      parentDelivery: (rt as any).parentDelivery,
      cancelTask: (taskId, reason) => rt.cancelTask(taskId, reason ? { reason } : undefined),
      protectedRoots: () => rt.protectedRoots(),
      dataDir: rt.config.dataDir,
    });
    const pending = gated.delegate({ parentTaskId: parent.id, key: "r1", request: "竞争委派", workId: first.work.id, readPaths: ["."], materials: null, paramsDigest: "dr1" });
    await waitFor("委派进入准备等待", () => release !== undefined);
    await rt.subagents!.cancelWork({ workId: first.work.id, by: "owner" });
    release();
    await assert.rejects(pending, /工作已取消/, "先取消则准备在事务内报已取消");
    assert.equal(rt.store.listTasksBySession(first.agent.sessionId).length, 1, "零新任务");
    assert.equal(rt.store.listWorkDelegationsBySession(session.id).length, 1, "零新工作");

    // —— 委派先提交：新任务出现在取消的 canceledTaskIds 中 ——
    const second = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "r2", request: "第二首轮", readPaths: ["."], materials: null, paramsDigest: "dr2" });
    await waitFor("第二首轮完成", () => rt.store.getTask(second.task.id)!.resultSummary !== null);
    await waitIdle(rt, second.agent.id);
    rt.store.setSessionQueueState(second.agent.sessionId, "paused", "test_fixture"); // 冻结：胜出任务保持 queued
    const raced = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "r3", request: "先提交的任务", workId: second.work.id, readPaths: ["."], materials: null, paramsDigest: "dr3" });
    assert.equal(raced.created, true);
    const canceled = await rt.subagents!.cancelWork({ workId: second.work.id, by: "owner" });
    assert.deepEqual(
      eventsOf(rt, "work_delegation.canceled", session.id).at(-1)!.canceledTaskIds,
      [raced.task.id],
      "先登记的任务必然在取消清单内",
    );
    assert.equal(rt.store.getTask(raced.task.id)!.status, "canceled");

    // —— 自然完成与取消竞争：最终只有一个终态，已完成的结果不被改写 ——
    const third = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "r4", request: "快速完成", readPaths: ["."], materials: null, paramsDigest: "dr4" });
    const [cancelledWork] = await Promise.all([
      rt.subagents!.cancelWork({ workId: third.work.id, by: "owner" }),
      waitFor("第三首轮到达终态", () => ["completed", "canceled"].includes(rt.store.getTask(third.task.id)!.status)),
    ]);
    assert.ok(cancelledWork.work.canceledAt !== null, "工作级取消字段照常写入");
    const racedTask = rt.store.getTask(third.task.id)!;
    assert.ok(["completed", "canceled"].includes(racedTask.status));
    const terminalEvents = eventsOf(rt, "subagent_task.completed", session.id).concat(eventsOf(rt, "subagent_task.failed", session.id)).filter((e) => e.taskId === third.task.id);
    assert.equal(terminalEvents.length, 1, "只有一个终态结果被登记");
    if (racedTask.status === "completed") {
      assert.match(racedTask.resultSummary ?? "", /SUB-RACE/, "已完成的结果不被取消改写");
    }
    assert.equal(queuedUnderCanceledCount(rt), 0);
  } finally {
    await t.shutdown();
  }
});

test("取消窗口：已转 running、currentTask 尚未设置时取消不被吞（工作取消与单任务均零模型调用）", async () => {
  const t = await startTestRuntime("cancel-window", async () => ({ kind: "text" as const, text: "不应到达" }), { config: realTools() });
  try {
    const rt = t.runtime;
    const session = await rt.createSession({ projectName: "window", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");

    // 注入钩子：getDriver 延迟 200ms，打开「已转 running、currentTask 未设置」窗口
    const original = (rt as any).getDriver;
    let hold = true;
    (rt as any).getDriver = async function (sess: any) {
      if (hold) await new Promise((r) => setTimeout(r, 200));
      return original.call(this, sess);
    };
    try {
      // —— 工作取消落进窗口 ——
      const d = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "w1", request: "窗口任务W1", readPaths: ["."], materials: null, paramsDigest: "dw1" });
      await waitFor("子任务已转 running", () => rt.store.getTask(d.task.id)!.status === "running");
      await rt.subagents!.cancelWork({ workId: d.work.id, by: "owner" });
      await waitFor("窗口任务到达终态", () => ["canceled", "completed", "failed"].includes(rt.store.getTask(d.task.id)!.status));
      const windowTask = rt.store.getTask(d.task.id)!;
      assert.equal(windowTask.status, "canceled", "窗口内的取消不被吞掉");
      assert.equal(windowTask.cancelRequested, true);
      assert.equal(t.server.calls.filter((c) => inputText(c).includes("窗口任务W1")).length, 0, "零模型调用");

      // —— 普通单任务 cancelTask 落进同一窗口（回归）——
      hold = true;
      const single = await rt.submit({ sessionId: session.id, requestId: "p2", input: "窗口单任务Q1", modelSelection: rt.defaultSelection });
      await waitFor("单任务已转 running", () => rt.store.getTask(single.id)!.status === "running");
      await rt.cancelTask(single.id);
      await waitFor("单任务到达终态", () => ["canceled", "completed", "failed"].includes(rt.store.getTask(single.id)!.status));
      assert.equal(rt.store.getTask(single.id)!.status, "canceled");
      assert.equal(t.server.calls.filter((c) => inputText(c).includes("窗口单任务Q1")).length, 0, "窗口内不调用模型");
      assert.equal(queuedUnderCanceledCount(rt), 0);
    } finally {
      hold = false;
    }
  } finally {
    await t.shutdown();
  }
});

test("工具执行中取消（共享停止路径）：mock_mark 已开始时停止，操作标 effect_unknown，不重放不重试", async () => {
  // SubAgent 任务只有只读工具，无法携带带副作用的操作；取消执行路径只有一条
  // （Runtime.cancelTask → Driver 停止路径），这里用单任务覆盖该维度，工作取消
  // 复用同一路径。
  let marker = "";
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (afterTool(req)) return { kind: "text", text: "mark 完成" };
    if (text.includes("标记任务MARK")) {
      return { kind: "tool_calls", calls: [{ id: "mk1", name: "mock_mark", arguments: { path: marker, content: "M1", ms: 400 } }] };
    }
    return { kind: "text", text: "done" };
  };
  const t = await startTestRuntime("cancel-mark", responder);
  try {
    const rt = t.runtime;
    marker = path.join(t.work[0]!, "marker.txt");
    const session = await rt.createSession({ projectName: "mark", cwd: t.work[0]! });
    // full_access：不经审批，直接暴露「已开始的写操作」的停止分类
    const task = await rt.submit({ sessionId: session.id, requestId: "mk", input: "标记任务MARK", modelSelection: rt.defaultSelection, accessMode: "full_access" });
    await waitFor("mock_mark 已写入标记", () => fs.existsSync(marker) && fs.readFileSync(marker, "utf8").includes("M1"));
    await rt.cancelTask(task.id);
    await waitFor("任务到达终态", () => ["canceled", "completed"].includes(rt.store.getTask(task.id)!.status));
    await new Promise((r) => setTimeout(r, 600)); // 越过 mock_mark 的 ms，确认不重放
    assert.equal(rt.store.getTask(task.id)!.status, "canceled");
    assert.equal(fs.readFileSync(marker, "utf8"), "M1\n", "已开始的写效果保留一次，不重放");
    const op = rt.store.listToolOpsByTask(task.id).find((o) => o.toolName === "mock_mark")!;
    assert.equal(op.effectUnknown, true, "已开始、停止时结果未确认的操作标效果未知");
    assert.equal(t.server.calls.filter((c) => inputText(c).includes("标记任务MARK")).length, 1, "不重试该工具调用");
  } finally {
    await t.shutdown();
  }
});

test("迟到结果：取消前排队的 wake 被队列检查取消且零模型调用；dev 下一轮不注入；同键重放返回原记录", async () => {
  const marks: string[] = [];
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派")) return { kind: "text", text: "SUB-LATE 结论" };
    if (text.includes("[编排器]")) {
      marks.push(inputText(req));
      return { kind: "text", text: "不应到达" };
    }
    if (text.includes("dev下一轮")) {
      marks.push(inputText(req));
      return { kind: "text", text: "收到" };
    }
    return { kind: "text", text: "父回复" };
  };
  const t = await startTestRuntime("cancel-late", responder, { config: realTools() });
  try {
    const rt = t.runtime;
    // —— main：取消前已排队的 wake 被队列检查取消 ——
    const main = rt.store.getAgentRole("main")!;
    const parent = await rt.submit({ sessionId: main.sessionId, requestId: "pm1", input: "分析", modelSelection: rt.defaultSelection });
    await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const work = await rt.subagents!.delegate({
      parentTaskId: parent.id,
      key: "w1",
      request: "main早完成分析",
      materials: [{ kind: "text", text: "材料 L" }],
      readPaths: null,
      paramsDigest: "dw1",
    });
    rt.store.setSessionQueueState(main.sessionId, "paused", "test_fixture"); // 冻结 main 队列：wake 保持排队
    await waitFor("子任务完成且 wake 已建", () => {
      return rt.store.getTask(work.task.id)!.resultSummary !== null && rt.store.findTaskByRequest(main.sessionId, `wake:${work.task.id}`) !== null;
    });
    const wake = rt.store.findTaskByRequest(main.sessionId, `wake:${work.task.id}`)!;
    assert.equal(wake.status, "queued");
    await rt.subagents!.cancelWork({ workId: work.work.id, by: "owner" });
    const callsBefore = t.server.calls.length;
    await rt.resumeQueue(main.sessionId);
    await waitFor("wake 被队列检查取消", () => rt.store.getTask(wake.id)!.status === "canceled");
    assert.equal(rt.store.getTask(wake.id)!.errorMessage, "work_canceled");
    assert.equal(t.server.calls.length, callsBefore, "被取消的 wake 不调用模型");
    assert.equal(marks.length, 0);

    // —— dev：取消后下一轮上下文不含该结果 ——
    const session = await rt.createSession({ projectName: "cdev2", cwd: t.work[1]! });
    const dparent = await rt.submit({ sessionId: session.id, requestId: "pd1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("dev 父完成", () => rt.store.getTask(dparent.id)!.status === "completed");
    const dwork = await rt.subagents!.delegate({ parentTaskId: dparent.id, key: "d1", request: "dev迟到结果", readPaths: ["."], materials: null, paramsDigest: "dd1" });
    await waitFor("dev 子任务完成", () => rt.store.getTask(dwork.task.id)!.resultSummary !== null);
    await rt.subagents!.cancelWork({ workId: dwork.work.id, by: "owner" });
    const dnext = await rt.submit({ sessionId: session.id, requestId: "pd2", input: "dev下一轮", modelSelection: rt.defaultSelection });
    await waitFor("dev 下一轮完成", () => rt.store.getTask(dnext.id)!.status === "completed");
    assert.ok(!marks.some((m) => m.includes("[SubAgent 结果]") && m.includes(dwork.work.id)), "已取消工作的结果不再注入父模型");

    // dev 父会话一直没有 wake 任务；这条规则同样覆盖取消前建成的 wake
    assert.equal(rt.store.listTasksBySession(session.id).filter((x) => x.requestId.startsWith("wake:")).length, 0);
    assert.equal(queuedUnderCanceledCount(rt), 0);
  } finally {
    await t.shutdown();
  }
});

test("身份与终态：取消不关闭 SubAgent（idle/unverified）；历史与目录保留；展示、幂等、归属与账本；跨重启保持", async () => {
  const latches = new Map<string, () => void>();
  const hang = async (mark: string): Promise<MockResponse> => {
    await new Promise<void>((res) => latches.set(mark, res));
    return { kind: "text", text: "迟到回复" };
  };
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派")) {
      if (text.includes("hang分析")) return hang("hang");
      if (text.includes("重启巡检挂起")) return hang("restart");
      return { kind: "text", text: "SUB-KEEP 保留结论" };
    }
    return { kind: "text", text: "父回复" };
  };
  const t = await startTestRuntime("cancel-identity", responder, { config: realTools(), workDirs: 3 });
  try {
    const rt = t.runtime;
    const session = await rt.createSession({ projectName: "ident", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");

    // —— 运行中取消：正常回收记 idle；不关闭；目录与 resultRef 保留 ——
    const a = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "i1", request: "hang分析", readPaths: ["."], materials: null, paramsDigest: "di1" });
    await waitFor("A 模型调用在途", () => latches.has("hang"));
    await rt.cancelWork(a.work.id, { reason: "不再需要A" });
    latches.get("hang")!();
    await waitFor("A 结果登记", () => rt.store.getTask(a.task.id)!.resultSummary !== null);
    await waitIdle(rt, a.agent.id);
    const agentA = rt.store.getSubAgent(a.agent.id)!;
    assert.equal(agentA.closedAt, null, "取消不关闭 SubAgent");
    assert.equal(agentA.state, "idle", "正常回收记空闲");
    assert.ok(fs.existsSync(agentA.workDir), "工作目录保留");
    assert.ok(rt.store.getTask(a.task.id)!.resultRef, "resultRef 保留");
    const subSession = rt.store.getSession(agentA.sessionId)!;
    assert.ok(subSession.sessionFile && fs.existsSync(subSession.sessionFile), "会话 JSONL 保留");

    // work_get（work show 同数据）自然带上取消三列；重复取消幂等
    const shown = (await t.client.request<any>("work_get", { work_id: a.work.id })) as any;
    assert.equal(shown.work.canceledBy, "owner");
    assert.equal(shown.work.cancelReason, "不再需要A");
    const again = await rt.cancelWork(a.work.id);
    assert.equal(again.alreadyCanceled, true, "重复取消幂等");
    assert.equal(eventsOf(rt, "work_delegation.canceled").filter((e) => e.workId === a.work.id).length, 1, "幂等不产生第二条取消事件");

    // —— 终态后取消：已完成的结果与产物保留可读 ——
    const c = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "i2", request: "保留分析", readPaths: ["."], materials: null, paramsDigest: "di2" });
    await waitFor("C 完成", () => rt.store.getTask(c.task.id)!.resultSummary !== null);
    await waitIdle(rt, c.agent.id);
    const refBefore = rt.store.getTask(c.task.id)!.resultRef;
    await rt.cancelWork(c.work.id);
    assert.equal(rt.store.getTask(c.task.id)!.status, "completed", "已完成的任务不被改写");
    assert.equal(rt.store.getTask(c.task.id)!.resultRef, refBefore);
    const reply = rt.readTaskReply(c.task.id, 0, 4096);
    assert.ok(reply && reply.text.includes("SUB-KEEP"), "最终回答仍可读");

    // —— 归属核实：其他父会话与 SubAgent 会话都不能取消 ——
    const session2 = await rt.createSession({ projectName: "ident2", cwd: t.work[1]! });
    const parent2 = await rt.submit({ sessionId: session2.id, requestId: "p2", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父2完成", () => rt.store.getTask(parent2.id)!.status === "completed");
    const other = await rt.subagents!.delegate({ parentTaskId: parent2.id, key: "o1", request: "别人的工作", readPaths: ["."], materials: null, paramsDigest: "do1" });
    await waitFor("会话2工作完成", () => rt.store.getTask(other.task.id)!.resultSummary !== null);
    await assert.rejects(
      () => rt.subagents!.cancelWork({ workId: other.work.id, by: `agent:${parent.id}`, parentSessionId: session.id }),
      /不属于本会话/,
      "其他父会话的主 Agent 不能取消",
    );
    await assert.rejects(
      () => rt.subagents!.cancelWork({ workId: a.work.id, by: `agent:${a.task.id}`, parentSessionId: a.agent.sessionId }),
      /不属于本会话/,
      "SubAgent 会话不能取消其承接的工作",
    );

    // —— 占用注入：无法核实时记 unverified，取消同样不关闭 ——
    const u = await rt.subagents!.delegate({ parentTaskId: parent2.id, key: "u1", request: "占用工作", readPaths: ["."], materials: null, paramsDigest: "du1" });
    rt.store.setSessionQueueState(u.agent.sessionId, "paused", "test_fixture");
    const uSession = rt.store.getSession(u.agent.sessionId)!;
    rt.store.db
      .prepare("INSERT INTO occupancy (cwd_real, cwd_dev, cwd_ino, session_id, task_id, acquired_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(uSession.cwdReal, uSession.cwdDev, uSession.cwdIno, uSession.id, u.task.id, new Date().toISOString());
    rt.store.withTx(() => {
      rt.store.transitionTask(u.task.id, ["queued"], "interrupted", { interruptReason: "backend_restart", endedAt: new Date().toISOString() });
    });
    rt.orchestrator!.onRuntimeEvents([
      {
        seq: 0,
        taskId: u.task.id,
        sessionId: u.agent.sessionId,
        body: { type: "task.interrupted", taskId: u.task.id, sessionId: u.agent.sessionId, reason: "backend_restart", cancelRequested: false, effectUnknown: false },
        createdAt: new Date().toISOString(),
      },
    ]);
    await waitFor("U 结果登记", () => rt.store.getTask(u.task.id)!.resultSummary !== null);
    assert.equal(rt.store.getSubAgent(u.agent.id)!.state, "unverified", "执行单元未核实退出记待核实");
    await rt.cancelWork(u.work.id);
    const agentU = rt.store.getSubAgent(u.agent.id)!;
    assert.equal(agentU.closedAt, null, "取消不改变关闭列");
    assert.equal(agentU.state, "unverified", "取消不虚构核实结论");

    // —— 账本核实 ——
    const check = subagentOpCheck(rt.store);
    assert.equal(check.verify({ taskId: parent.id, toolName: "subagent_cancel", params: { work_id: c.work.id } }), "committed");
    assert.equal(check.verify({ taskId: parent2.id, toolName: "subagent_cancel", params: { work_id: other.work.id } }), "not_committed");
    assert.equal(queuedUnderCanceledCount(rt), 0);

    // —— main：子任务挂起时取消 → 迟到结果登记、从未建 wake ——
    const main = rt.store.getAgentRole("main")!;
    const mparent = await rt.submit({ sessionId: main.sessionId, requestId: "pm1", input: "分析", modelSelection: rt.defaultSelection });
    await waitFor("main 父完成", () => rt.store.getTask(mparent.id)!.status === "completed");
    const mw = await rt.subagents!.delegate({
      parentTaskId: mparent.id,
      key: "mr1",
      request: "重启巡检挂起",
      materials: [{ kind: "text", text: "M" }],
      readPaths: null,
      paramsDigest: "dmr1",
    });
    await waitFor("重启巡检工作模型调用在途", () => latches.has("restart"));
    await rt.cancelWork(mw.work.id);
    latches.get("restart")!();
    await waitFor("迟到结果已登记", () => rt.store.getTask(mw.task.id)!.resultSummary !== null);
    assert.equal(rt.store.getTask(mw.task.id)!.status, "canceled");
    assert.equal(rt.store.findTaskByRequest(main.sessionId, `wake:${mw.task.id}`), null, "已取消工作不建 wake");

    // —— 重启：取消状态保持，巡检不为已取消工作补发 wake ——
    const callsAtStop = t.server.calls.length;
    await rt.stop("test_restart");
    const { Runtime } = await import("../src/runtime/runtime.ts");
    const rt2 = await Runtime.start(rt.config);
    try {
      const rWork = rt2.store.getWorkDelegation(a.work.id)!;
      assert.ok(rWork.canceledAt !== null && rWork.canceledBy === "owner", "取消状态跨重启保持");
      assert.equal(rt2.store.getSubAgent(a.agent.id)!.closedAt, null, "关闭状态跨重启保持（未关闭）");
      assert.equal(rt2.store.listRoleTasksPendingWake().length, 0, "巡检清单不含已取消工作的子任务（本必有 NOT EXISTS 过滤）");
      await new Promise((r) => setTimeout(r, 500)); // 给巡检与队列循环一个周期
      assert.equal(rt2.store.findTaskByRequest(rt2.store.getAgentRole("main")!.sessionId, `wake:${mw.task.id}`), null, "重启后不补发 wake");
      assert.equal(t.server.calls.length, callsAtStop, "重启后没有新模型调用");
      assert.equal(queuedUnderCanceledCount(rt2), 0);
    } finally {
      await rt2.stop("test_end");
    }
  } finally {
    for (const release of latches.values()) release();
    await t.shutdown();
  }
});

test("v25 → v26 迁移：旧工作委托保留、取消三列为空；账本核实与条件写入正确", async () => {
  const { dirs } = await makeTestDirs("cancel-migrate", 0);
  try {
    const { Db, SCHEMA_VERSION } = await import("../src/core/db.ts");
    const { Store } = await import("../src/core/store.ts");
    let db = new Db(dirs.dataDir);
    db.exec(`
      ALTER TABLE work_delegations DROP COLUMN canceled_at;
      ALTER TABLE work_delegations DROP COLUMN canceled_by;
      ALTER TABLE work_delegations DROP COLUMN cancel_reason;
      UPDATE meta SET value = '25' WHERE key = 'schema_version';
      INSERT INTO projects (id, name, created_at) VALUES ('old-proj', 'old', '2026-01-01T00:00:00Z');
      INSERT INTO sessions (id, project_id, cwd, cwd_real, cwd_dev, cwd_ino, pi_session_id, created_at) VALUES ('old-sess', 'old-proj', '/tmp/old', '/tmp/old', 1, 1, 'pi-old', '2026-01-01T00:00:00Z');
      INSERT INTO sessions (id, project_id, cwd, cwd_real, cwd_dev, cwd_ino, pi_session_id, created_at) VALUES ('old-sub-sess', 'old-proj', '/tmp/oldsub', '/tmp/oldsub', 1, 2, 'pi-old-sub', '2026-01-01T00:00:00Z');
      INSERT INTO sub_agents (id, parent_session_id, session_id, work_dir, active_work_id, current_task_id, state, closed_at, closed_by, created_at)
        VALUES ('old-agent', 'old-sess', 'old-sub-sess', '/tmp/oldsub', 'old-work', NULL, 'idle', NULL, NULL, '2026-01-01T00:00:00Z');
      INSERT INTO work_delegations (id, parent_session_id, origin_task_id, sub_agent_id, request_key, params_digest, created_at)
        VALUES ('old-work', 'old-sess', 'old-task', 'old-agent', 'k1', 'd1', '2026-01-01T00:00:00Z');
    `);
    db.close();

    db = new Db(dirs.dataDir);
    const store = new Store(db);
    assert.equal((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as any).value, String(SCHEMA_VERSION));
    const cols = (db.prepare("PRAGMA table_info(work_delegations)").all() as Array<{ name: string }>).map((c) => c.name);
    for (const c of ["canceled_at", "canceled_by", "cancel_reason"]) assert.ok(cols.includes(c), `迁移后补列 ${c}`);
    const work = store.getWorkDelegation("old-work")!;
    assert.equal(work.canceledAt, null, "旧工作三列为空（未取消）");
    assert.equal(work.canceledBy, null);
    assert.equal(work.cancelReason, null);

    const check = subagentOpCheck(store);
    assert.equal(check.verify({ taskId: "old-task", toolName: "subagent_cancel", params: { work_id: "old-work" } }), "not_committed");
    assert.equal(store.cancelWorkDelegation("old-work", "2026-01-02T00:00:00Z", "owner", "旧工作取消"), true);
    assert.equal(check.verify({ taskId: "old-task", toolName: "subagent_cancel", params: { work_id: "old-work" } }), "committed");
    assert.equal(store.cancelWorkDelegation("old-work", "2026-01-03T00:00:00Z", "owner", null), false, "条件写入幂等");
    db.close();
  } finally {
    await cleanupDirs(dirs);
  }
});
