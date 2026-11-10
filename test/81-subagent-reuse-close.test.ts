import { BUILTIN_SUBAGENT_ROLES, subAgentRoleLibrary } from "@ruukoto/agent/subagent-roles.ts";
import { delegateFromActiveTask, messageFromActiveTask } from "./helpers/active-subagent-source.ts";

/**
 * Continued work, idle SubAgent reuse and explicit closure preserve history and work directories.
 * Note: See .agents/notes/implemented/feature/2026-10-04-subagent-reuse-close.md
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { type Responder } from "./helpers/mock-provider.ts";
import {
  afterTool,
  lastToolText,
  inputText,
  cleanupDirs,
  connectAuthedClient,
  lastUserText,
  makeTestDirs,
  realTools,
  startTestRuntime,
  waitFor,
  writeModelsJson,
} from "./helpers/testkit.ts";
import { createMockTools } from "@ruukoto/agent/mock-tools.ts";
import { type RuntimeConfig, Runtime } from "@ruukoto/runtime/runtime.ts";
import { ControlServer } from "@ruukoto/control/server.ts";
import { createSubAgentTools } from "@ruukoto/agent/subagent-tools.ts";
import { SubAgentManager } from "@ruukoto/runtime/subagents.ts";
import { subagentOpCheck } from "@ruukoto/agent/subagent-ledger.ts";
import { WorkCopyManager } from "@ruukoto/runtime/work-copy.ts";

/** 结果登记与 Agent 空闲在同一事务；等 resultSummary 即等 idle 可用。 */
async function waitIdle(rt: Runtime, agentId: string): Promise<void> {
  await waitFor("Agent 空闲", () => rt.store.getSubAgent(agentId)!.state === "idle");
}

/** 不变式：任何时刻不存在「已关闭且有活动任务」的组合。 */
function closedWithActiveCount(rt: Runtime): number {
  return Number(
    (
      rt.store.db
        .prepare(
          `SELECT COUNT(*) AS n FROM sub_agents a JOIN tasks t ON t.sub_agent_id = a.id
           AND t.status IN ('queued','running','awaiting_confirmation') WHERE a.closed_at IS NOT NULL`,
        )
        .get() as any
    ).n,
  );
}

test("复用与继续（dev/read_paths）：独立记录、activeWorkId 切换、上下文保留", async () => {
  let fileA = "";
  let fileB = "";
  let fileC = "";
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派")) {
      if (text.includes("分析 B")) {
        if (afterTool(req)) return { kind: "text", text: "SUB-B 结论" };
        return { kind: "tool_calls", calls: [{ id: "b1", name: "read", arguments: { path: fileB } }] };
      }
      if (text.includes("继续分析 A")) return { kind: "text", text: "SUB-A-2 继续结论" };
      if (afterTool(req)) return { kind: "text", text: "SUB-A 首轮结论" };
      return { kind: "tool_calls", calls: [{ id: "a1", name: "read", arguments: { path: fileA } }] };
    }
    return { kind: "text", text: "父回复" };
  };
  const t = await startTestRuntime("reuse-dev", responder, { config: realTools(), workDirs: 3 });
  try {
    const rt = t.runtime;
    const session = await rt.createSession({ projectName: "redev", cwd: t.work[0]! });
    fileA = path.join(t.work[0]!, "a.md");
    fileB = path.join(t.work[0]!, "b.md");
    fileC = path.join(t.work[0]!, "c.md");
    fs.writeFileSync(fileA, "A 要点\n", "utf8");
    fs.writeFileSync(fileB, "B 要点\n", "utf8");
    fs.writeFileSync(fileC, "C 要点\n", "utf8");
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");

    // 工作 A 首次委派
    const first = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "a1", request: "分析 A", readPaths: [fileA], paramsDigest: "da1" });
    assert.equal(first.newWork, true);
    await waitFor("A 首次完成", () => rt.store.getTask(first.task.id)!.resultSummary !== null);
    await waitIdle(rt, first.agent.id);
    const firstSummary = rt.store.getTask(first.task.id)!.resultSummary;
    const firstRef = rt.store.getTask(first.task.id)!.resultRef;

    // A 继续（等 idle 后）→ 同一工作同一 Agent 的新执行
    const second = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "a2", request: "继续分析 A", workId: first.work.id, readPaths: [fileA], paramsDigest: "da2" });
    assert.equal(second.created, true);
    assert.equal(second.newWork, false);
    assert.equal(second.agent.id, first.agent.id);
    assert.equal(second.work.id, first.work.id);
    assert.notEqual(second.task.id, first.task.id);
    assert.equal(rt.store.getSubAgent(first.agent.id)!.activeWorkId, first.work.id);
    await waitFor("A 继续完成", () => rt.store.getTask(second.task.id)!.resultSummary !== null);
    await waitIdle(rt, first.agent.id);

    // 复用同一 Agent 承接工作 B（新工作、独立记录）
    const third = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "b1", request: "分析 B", subAgentId: first.agent.id, readPaths: [fileB], paramsDigest: "db1" });
    assert.equal(third.created, true);
    assert.equal(third.newWork, true, "复用登记一条新工作");
    assert.equal(third.agent.id, first.agent.id, "同一 SubAgent");
    assert.notEqual(third.work.id, first.work.id, "另一条工作委托");
    assert.equal(third.work.subAgentId, first.agent.id);
    assert.notEqual(third.task.id, second.task.id);
    assert.equal(third.task.sessionId, first.task.sessionId, "同一独立子会话（上下文所在）");
    assert.deepEqual(third.task.readScope?.paths.map((p) => p.path), [fs.realpathSync(fileB)], "B 的读范围只有 B");
    assert.deepEqual(second.task.readScope?.paths.map((p) => p.path), [fs.realpathSync(fileA)], "A 继续的读范围仍是 A");
    await waitFor("B 完成", () => rt.store.getTask(third.task.id)!.resultSummary !== null);
    await waitIdle(rt, first.agent.id);
    assert.equal(rt.store.getSubAgent(first.agent.id)!.activeWorkId, third.work.id, "activeWorkId 切换到工作 B");
    assert.equal(rt.store.listSubAgents().length, 1, "没有再造 Agent");
    assert.equal(rt.store.listWorkDelegationsBySession(session.id).length, 2, "两条各自独立的工作委托");

    // A 首次结果逐字节不变（后续执行不改写旧记录）
    const firstNow = rt.store.getTask(first.task.id)!;
    assert.equal(firstNow.resultSummary, firstSummary);
    assert.equal(firstNow.resultRef, firstRef);
    assert.notEqual(rt.store.getTask(second.task.id)!.resultSummary, firstSummary);

    // 上下文保留：B 的模型请求里能看到 A 两次执行的输入与回复
    const bCall = t.server.calls.find((c) => inputText(c).includes("[SubAgent 委派") && inputText(c).includes("分析 B"))!;
    const bText = inputText(bCall);
    assert.ok(bText.includes("SUB-A 首轮结论"), "B 的上下文包含 A 首轮回复");
    assert.ok(bText.includes("SUB-A-2 继续结论"), "B 的上下文包含 A 继续的回复");
    assert.ok(bText.includes("本 SubAgent 此前承接过其他工作"), "复用任务输入带宿主说明");
    assert.ok(bText.includes(`工作 ${third.work.id}`), "任务输入写明工作 B");
    assert.ok(!bText.includes("父回复"), "子上下文不含父会话发言");
    assert.equal(closedWithActiveCount(rt), 0);
  } finally {
    await t.shutdown();
  }
});



test("重新确定：读范围只按本次、来源撤销拒绝与发送阻断、目录替换拒绝、跨父会话拒绝", async () => {
  let fileA = "";
  let fileB = "";
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派")) {
      if (text.includes("读取 B")) {
        if (afterTool(req)) return { kind: "text", text: "SUB-B 结论" };
        // 模型尝试读 A：worker 应按本任务的钉定范围拒绝
        return { kind: "tool_calls", calls: [{ id: "x1", name: "read", arguments: { path: fileA } }] };
      }
      return { kind: "text", text: "SUB-A 结论" };
    }
    if (text.includes("[编排器]")) return { kind: "text", text: "已汇报" };
    return { kind: "text", text: "父回复" };
  };
  const t = await startTestRuntime("reuse-rescope", responder, { config: realTools() });
  try {
    const rt = t.runtime;
    const session = await rt.createSession({ projectName: "rescope", cwd: t.work[0]! });
    fileA = path.join(t.work[0]!, "a.md");
    fileB = path.join(t.work[0]!, "b.md");
    fs.writeFileSync(fileA, "A 要点\n", "utf8");
    fs.writeFileSync(fileB, "B 要点\n", "utf8");
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");

    // —— 复用后 worker 实际拒读旧工作路径 ——
    const first = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "s1", request: "读取 A", readPaths: [fileA], paramsDigest: "ds1" });
    await waitFor("A 完成", () => rt.store.getTask(first.task.id)!.resultSummary !== null);
    await waitIdle(rt, first.agent.id);
    const reuseB = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "s2", request: "读取 B", subAgentId: first.agent.id, readPaths: [fileB], paramsDigest: "ds2" });
    assert.deepEqual(reuseB.task.readScope?.paths.map((p) => p.path), [fs.realpathSync(fileB)]);
    await waitFor("B 完成", () => rt.store.getTask(reuseB.task.id)!.resultSummary !== null);
    const toolResults = t.server.calls.filter((c) => afterTool(c) && inputText(c).includes("读取 B")).map(lastToolText).join("\n");
    assert.match(toolResults, /只读范围/, "worker 按本任务钉定范围拒读旧工作路径");

    // —— 工作目录被替换：复用明确失败（核对实际文件状态）——
    const agent = rt.store.getSubAgent(first.agent.id)!;
    await waitIdle(rt, agent.id);
    const original = fs.statSync(agent.workDir);
    fs.renameSync(agent.workDir, `${agent.workDir}-original`);
    fs.mkdirSync(agent.workDir, { recursive: true });
    const replacement = fs.statSync(agent.workDir);
    assert.notDeepEqual([replacement.dev, replacement.ino], [original.dev, original.ino]);
    await assert.rejects(
      () => delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "s3", request: "再来", subAgentId: agent.id, readPaths: [fileB], paramsDigest: "ds3" }),
      /工作目录已不存在或被替换/,
    );

    // —— 跨父会话复用拒绝 ——
    const session2 = await rt.createSession({ projectName: "other", cwd: t.work[1]! });
    const parent2 = await rt.submit({ sessionId: session2.id, requestId: "p2", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父2完成", () => rt.store.getTask(parent2.id)!.status === "completed");
    const first2 = await delegateFromActiveTask(rt, { parentTaskId: parent2.id, key: "t1", request: "x", readPaths: ["."], paramsDigest: "dt1" });
    await waitFor("会话2 A 完成", () => rt.store.getTask(first2.task.id)!.resultSummary !== null);
    await waitIdle(rt, first2.agent.id);
    await assert.rejects(
      () => delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "t9", request: "x", subAgentId: first2.agent.id, readPaths: ["."], paramsDigest: "dt9" }),
      /不属于本会话/,
      "跨父会话复用被拒绝",
    );
    assert.equal(closedWithActiveCount(rt), 0);
  } finally {
    await t.shutdown();
  }
});


test("查看与关闭：总览、主 Agent 工具关闭与幂等、关闭后拒绝与保留、归属核实", async () => {
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派")) return { kind: "text", text: "SUB-VIEW" };
    return { kind: "text", text: "父回复" };
  };
  const t = await startTestRuntime("reuse-view", responder, { config: realTools() });
  try {
    const rt = t.runtime;
    const session = await rt.createSession({ projectName: "view", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const first = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "v1", request: "分析", readPaths: ["."], paramsDigest: "dv1" });
    await waitFor("A 完成", () => rt.store.getTask(first.task.id)!.resultSummary !== null);
    await waitIdle(rt, first.agent.id);

    // 主 Agent 查看（subagent_result 总览，经真实装配的工具层）
    const projectId = rt.store.getSession(session.id)!.projectId;
    const tools = createSubAgentTools({
      coreStore: rt.store,
      delegate: (input) => delegateFromActiveTask(rt, input),
      close: (input) => rt.subagents!.close(input),
      cancelWork: (input) => rt.subagents!.cancelWork(input),
      message: (input) => messageFromActiveTask(rt, input),
      integrate: (input) => rt.subagents!.integrate(input),
      readReply: (taskId, offset, length) => rt.readTaskReply(taskId, offset, length),
      artifacts: rt.artifacts,
      taskContext: () => ({ taskId: parent.id, sessionId: session.id, projectId, hostOpId: "opv" }),
      bindCall: undefined,
      verifyHost: () => null,
    });
    const resultTool = tools.find((x) => x.name === "subagent_result")!;
    const closeTool = tools.find((x) => x.name === "subagent_close")!;
    const exec = (tool: any, params: any) => tool.execute("sdk1", params, undefined as any, undefined as any, {} as any);
    const overview = (await exec(resultTool, {})).content[0].text as string;
    assert.ok(overview.includes(first.agent.id) && overview.includes("idle"), "总览列出 SubAgent 与状态");
    assert.ok(overview.includes(first.work.id), "总览列出当前/名下工作");

    // 主 Agent 关闭（回报唤醒轮次也允许；by 记录发起任务）
    const closed = (await exec(closeTool, { sub_agent_id: first.agent.id })).content[0].text as string;
    assert.match(closed, /已关闭/);
    let agent = rt.store.getSubAgent(first.agent.id)!;
    assert.ok(agent.closedAt !== null);
    assert.equal(agent.closedBy, `agent:${parent.id}`);
    assert.equal(agent.state, "idle", "关闭不改执行状态列");

    // 重复关闭幂等
    const again = (await exec(closeTool, { sub_agent_id: first.agent.id })).content[0].text as string;
    assert.match(again, /幂等|此前已关闭/);

    // subagent.closed 事件（refs 指向父会话，供 TUI 归属展示）
    const closeEvents = (rt.store.db.prepare("SELECT body FROM events WHERE session_id = ?").all(session.id) as Array<{ body: string }>)
      .map((r) => JSON.parse(r.body))
      .filter((b) => b.type === "subagent.closed");
    assert.equal(closeEvents.length, 1);
    assert.equal(closeEvents[0]!.closedBy, `agent:${parent.id}`);
    assert.equal(closeEvents[0]!.taskId, parent.id);

    // 关闭后新委派报已关闭；同键同参重放返回原记录、不新增任务
    const taskCount = rt.store.listTasksBySession(first.agent.sessionId).length;
    await assert.rejects(
      () => delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "v2", request: "x", subAgentId: agent.id, readPaths: ["."], paramsDigest: "dv2" }),
      /已关闭/,
    );
    await assert.rejects(
      () => delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "v9", request: "x", workId: first.work.id, readPaths: ["."], paramsDigest: "dv9" }),
      /已关闭/,
      "沿原工作的继续委派同样被拒绝",
    );
    const replay = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "v1", request: "分析", readPaths: ["."], paramsDigest: "dv1" });
    assert.equal(replay.created, false, "同键同参重放返回原记录");
    assert.equal(replay.task.id, first.task.id);
    assert.equal(rt.store.listTasksBySession(first.agent.sessionId).length, taskCount, "零新增任务");

    // 关闭后历史、产物与目录仍可读
    assert.ok(fs.existsSync(agent.workDir), "工作目录保留");
    assert.notEqual(rt.store.getSession(agent.sessionId), null, "子会话记录保留");
    const byWork = (await exec(resultTool, { work_id: first.work.id })).content[0].text as string;
    assert.ok(byWork.includes("已关闭"), "按工作读取标明已关闭");
    assert.ok(byWork.includes("SUB-VIEW"), "结果摘要仍可读");
    const reply = (await exec(resultTool, { work_id: first.work.id, part: "reply" })).content[0].text as string;
    assert.ok(reply.includes("SUB-VIEW"), "最终回答仍可读");

    // 拥有者查看（work_get 自然带上关闭两列）
    const shown = (await t.client.request<any>("work_get", { work_id: first.work.id })) as any;
    assert.ok(shown.agent.closedAt !== null && shown.agent.closedBy === `agent:${parent.id}`);

    // 其他父会话（冒充 agent: 来源）不能关闭；SubAgent 自身由 verifyHost 拒绝（不装配）
    const session2 = await rt.createSession({ projectName: "view2", cwd: t.work[1]! });
    const parent2 = await rt.submit({ sessionId: session2.id, requestId: "p2", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父2完成", () => rt.store.getTask(parent2.id)!.status === "completed");
    const second = await delegateFromActiveTask(rt, { parentTaskId: parent2.id, key: "w1", request: "x", readPaths: ["."], paramsDigest: "dw1" });
    await waitFor("会话2 A 完成", () => rt.store.getTask(second.task.id)!.resultSummary !== null);
    await waitIdle(rt, second.agent.id);
    assert.throws(
      () => rt.subagents!.close({ subAgentId: second.agent.id, by: `agent:${parent.id}`, parentSessionId: session.id }),
      /不属于本会话/,
      "其他父会话的 Agent 不能以主 Agent 身份关闭",
    );

    // 拥有者经控制面关闭（CLI 同路）：成功且幂等
    const ownClose = (await t.client.request<any>("subagent_close", { sub_agent_id: second.agent.id })) as any;
    assert.equal(ownClose.alreadyClosed, false);
    assert.equal(rt.store.getSubAgent(second.agent.id)!.closedBy, "owner");
    const ownAgain = (await t.client.request<any>("subagent_close", { sub_agent_id: second.agent.id })) as any;
    assert.equal(ownAgain.alreadyClosed, true);

    // 工具操作账本：subagent_close 按 closedAt 核实
    const check = subagentOpCheck(rt.store);
    assert.equal(check.verify({ taskId: parent2.id, toolName: "subagent_close", params: { sub_agent_id: second.agent.id } }), "committed");
    assert.equal(check.verify({ taskId: parent2.id, toolName: "subagent_close", params: { sub_agent_id: "sagent_none" } }), "not_committed");
    assert.equal(closedWithActiveCount(rt), 0);
  } finally {
    await t.shutdown();
  }
});

test("竞争：准备阶段被关闭→事务内已关闭；先提交→关闭 busy、取消后可关闭；并发复用一胜一负", async () => {
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派")) return { kind: "text", text: "SUB-RACE" };
    return { kind: "text", text: "父回复" };
  };
  const t = await startTestRuntime("reuse-race", responder, { config: realTools() });
  try {
    const rt = t.runtime;
    const session = await rt.createSession({ projectName: "race", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const base = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "r0", request: "首轮", readPaths: ["."], paramsDigest: "dr0" });
    await waitFor("首轮完成", () => rt.store.getTask(base.task.id)!.resultSummary !== null);
    await waitIdle(rt, base.agent.id);

    // —— 委派已发出、尚在 await 准备阶段时同步关闭：事务内报已关闭，零新任务 ——
    let release!: () => void;
    const gated = new SubAgentManager({ roles: () => subAgentRoleLibrary(BUILTIN_SUBAGENT_ROLES, []),
      store: rt.store,
      workRoot: path.join(rt.config.profile.workCopyDir, "sub-agents"),
      workCopies: new WorkCopyManager({
        worktreeRoot: path.join(rt.config.profile.workCopyDir, "worktrees"),
        protectedRoots: () => rt.protectedRoots(),
      }),
      sources: (rt as any).sources,
      resolveSelection: () => new Promise<() => void>((res) => (release = () => res(() => {}))),
      launcherFor: (mode) => rt.launcherFor(mode),
      kickSession: () => {},
      resumeQueue: (sessionId) => rt.resumeQueue(sessionId),
      parentDelivery: (rt as any).parentDelivery,
      cancelTask: (taskId, reason) => rt.cancelTask(taskId, reason ? { reason } : undefined),
      protectedRoots: () => rt.protectedRoots(),
    });
    const pending = delegateFromActiveTask({ store: rt.store, subagents: gated }, { parentTaskId: parent.id, key: "r1", request: "竞争委派", subAgentId: base.agent.id, readPaths: ["."], paramsDigest: "dr1" });
    await waitFor("委派进入准备等待", () => release !== undefined);
    rt.subagents!.close({ subAgentId: base.agent.id, by: "owner" });
    release();
    await assert.rejects(pending, /已关闭/, "先关闭则准备在事务内报已关闭");
    assert.equal(rt.store.listTasksBySession(base.agent.sessionId).length, 1, "零新任务");
    assert.equal(rt.store.listWorkDelegationsBySession(session.id).length, 1, "零新工作");
    assert.equal(closedWithActiveCount(rt), 0);

    // —— 委派先提交：关闭报有活动任务；拥有者取消后可以关闭 ——
    const second = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "r2", request: "第二首轮", readPaths: ["."], paramsDigest: "dr2" });
    await waitFor("第二首轮完成", () => rt.store.getTask(second.task.id)!.resultSummary !== null);
    await waitIdle(rt, second.agent.id);
    rt.store.setSessionQueueState(second.agent.sessionId, "paused", "test_fixture"); // 冻结：任务停在 queued
    const busy = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "r3", request: "活动任务", subAgentId: second.agent.id, readPaths: ["."], paramsDigest: "dr3" });
    assert.equal(busy.created, true);
    await assert.rejects(
      () => t.client.request<any>("subagent_close", { sub_agent_id: second.agent.id }),
      new RegExp(`活动任务 ${busy.task.id}`),
      "先提交则关闭报有活动任务（给出任务 id）",
    );
    assert.equal(rt.store.getSubAgent(second.agent.id)!.closedAt, null, "竞争失败侧状态不被污染");
    await rt.cancelTask(busy.task.id);
    await waitFor("取消后空闲", () => rt.store.getSubAgent(second.agent.id)!.state === "idle" && rt.store.getTask(busy.task.id)!.resultSummary !== null);
    await rt.resumeQueue(second.agent.sessionId);
    const afterCancel = (await t.client.request<any>("subagent_close", { sub_agent_id: second.agent.id })) as any;
    assert.equal(afterCancel.alreadyClosed, false, "ruukoto cancel 之后可以关闭");
    assert.equal(closedWithActiveCount(rt), 0);

    // —— 两个复用请求并发指向同一空闲 Agent：一个成功、一个报正忙 ——
    const third = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "r4", request: "第三首轮", readPaths: ["."], paramsDigest: "dr4" });
    await waitFor("第三首轮完成", () => rt.store.getTask(third.task.id)!.resultSummary !== null);
    await waitIdle(rt, third.agent.id);
    rt.store.setSessionQueueState(third.agent.sessionId, "paused", "test_fixture"); // 冻结：胜出任务保持活动
    const [w1, w2] = await Promise.allSettled([
      delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "r5", request: "并发一", subAgentId: third.agent.id, readPaths: ["."], paramsDigest: "dr5" }),
      delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "r6", request: "并发二", subAgentId: third.agent.id, readPaths: ["."], paramsDigest: "dr6" }),
    ]);
    const fulfilled = [w1, w2].filter((r) => r.status === "fulfilled");
    const rejected = [w1, w2].filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "只有一个复用登记成功");
    assert.equal(rejected.length, 1);
    assert.match((rejected[0] as PromiseRejectedResult).reason.message, /正忙|活动任务/, "另一个报正忙，不排队");
    assert.equal(rt.store.listTasksBySession(third.agent.sessionId).length, 2, "只有首轮 + 胜出的一次执行");
    assert.equal(closedWithActiveCount(rt), 0);
    await rt.resumeQueue(third.agent.sessionId);
    await waitFor("胜出任务完成", () => rt.store.listTasksBySession(third.agent.sessionId).every((x) => x.resultSummary !== null));
  } finally {
    await t.shutdown();
  }
});

test("登记失败清理（visual-docs-review 工单 03）：正文超长与登记冲突不留目录/快照", async () => {
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派")) return { kind: "text", text: "SUB-CLEAN" };
    return { kind: "text", text: "父回复" };
  };
  const t = await startTestRuntime("reuse-cleanup", responder, { config: realTools() });
  try {
    const rt = t.runtime;
    const session = await rt.createSession({ projectName: "clean", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const workRoot = path.join(rt.config.profile.workCopyDir, "sub-agents");
    const huge = "x".repeat(9000);

    // —— 首次委派正文超长：新建目录连同快照一并删除 ——
    await assert.rejects(
      () => delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "c1", request: huge, readPaths: ["."], paramsDigest: "dc1" }),
      /超过 8192 字符/,
    );
    assert.deepEqual(fs.existsSync(workRoot) ? fs.readdirSync(workRoot) : [], [], "首次委派失败不留目录");

    // —— 沿原工作委派正文超长：目录保留，本次快照文件删除 ——
    const first = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "c2", request: "正常", readPaths: ["."], paramsDigest: "dc2" });
    await waitFor("首轮完成", () => rt.store.getTask(first.task.id)!.resultSummary !== null);
    await waitIdle(rt, first.agent.id);
    fs.writeFileSync(path.join(first.agent.workDir, "keep.txt"), "既有内容", "utf8");
    await assert.rejects(
      () => delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "c3", request: huge, workId: first.work.id, readPaths: ["."], paramsDigest: "dc3" }),
      /超过 8192 字符/,
    );
    assert.ok(fs.existsSync(first.agent.workDir), "沿用目录保留");
    assert.equal(fs.readFileSync(path.join(first.agent.workDir, "keep.txt"), "utf8"), "既有内容", "已有内容不动");
    assert.deepEqual(
      fs.readdirSync(first.agent.workDir).filter((f) => f.endsWith("-c3.txt")),
      [],
      "沿原工作委派失败不留本次快照",
    );

    assert.equal(closedWithActiveCount(rt), 0);
  } finally {
    await t.shutdown();
  }
});

test("不自动关闭：TUI 退出与空闲不动；重启后空闲 Agent 仍可复用、关闭状态保持", async () => {
  const { dirs, work } = await makeTestDirs("reuse-idle", 1);
  const server = new (await import("./helpers/mock-provider.ts")).MockModelServer(async () => ({ kind: "text" as const, text: "OK" }));
  const baseUrl = await server.start();
  await writeModelsJson(dirs, baseUrl);
  const config: RuntimeConfig = {
    profile: dirs.profile,
    thinkingLevel: "off",
    modelProvider: "mock",
    modelId: "mock-model",
    toolFactory: (ctx) => createMockTools(ctx),
  };
  let rt = await Runtime.start(config);
  await ControlServer.start(rt);
  let agentId = "";
  let agentSessionId = "";
  try {
    const session = await rt.createSession({ projectName: "idle", cwd: work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "开始", modelSelection: rt.defaultSelection });
    await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const first = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "i1", request: "分析", readPaths: null, paramsDigest: "di1" });
    await waitFor("A 完成", () => rt.store.getTask(first.task.id)!.resultSummary !== null);
    await waitIdle(rt, first.agent.id);
    agentId = first.agent.id;
    agentSessionId = first.agent.sessionId;

    // 控制面客户端断开（相当于 TUI 退出）：不影响 SubAgent 存续
    const client = await connectAuthedClient(rt);
    await client.handshake();
    client.close();
    const callsBefore = server.calls.length;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(rt.store.getSubAgent(agentId)!.closedAt, null, "终态、退出与空闲都不自动关闭");
    assert.equal(server.calls.length, callsBefore, "空闲不要求继续调用模型");
    assert.equal((rt as any).drivers.has(agentSessionId), false, "空闲不保留 Driver（进程与连接已释放）");

    // 重启后台：空闲状态与可复用性保持
    await rt.stop("test_restart");
    rt = await Runtime.start(config);
    await ControlServer.start(rt);
    const agent = rt.store.getSubAgent(agentId)!;
    assert.equal(agent.state, "idle");
    assert.equal(agent.closedAt, null);
    const parent2 = rt.store.getTask(parent.id)!;
    const reuse = await delegateFromActiveTask(rt, { parentTaskId: parent2.id, key: "i2", request: "重启后再用", subAgentId: agentId, readPaths: null, paramsDigest: "di2" });
    assert.equal(reuse.created, true, "重启后空闲 Agent 仍可复用");
    await waitFor("复用完成", () => rt.store.getTask(reuse.task.id)!.resultSummary !== null);
    await waitIdle(rt, agentId);

    // 关闭状态跨重启保持
    rt.subagents!.close({ subAgentId: agentId, by: "owner" });
    await rt.stop("test_restart");
    rt = await Runtime.start(config);
    await ControlServer.start(rt);
    assert.ok(rt.store.getSubAgent(agentId)!.closedAt !== null, "关闭状态跨重启保持");
    await assert.rejects(
      () => delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "i3", request: "x", subAgentId: agentId, readPaths: null, paramsDigest: "di3" }),
      /已关闭/,
    );
    assert.equal(closedWithActiveCount(rt), 0);
  } finally {
    await rt.stop("test_end");
    await server.close();
    await cleanupDirs(dirs);
  }
});
