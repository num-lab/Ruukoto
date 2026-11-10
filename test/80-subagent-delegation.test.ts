import { delegateFromActiveTask } from "./helpers/active-subagent-source.ts";

/** Ordinary conversation delegation, source isolation, result delivery and retained SubAgent identity. */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import type { Responder } from "./helpers/mock-provider.ts";
import { toolNamesOf, afterTool, lastToolText, inputText, lastUserText, realTools, startTestRuntime, waitFor } from "./helpers/testkit.ts";

test("dev 会话：登记→非阻塞→真实受控读取→结果回传→父下一轮注入→子空闲", async () => {
  const secret = `SECRET-${Math.random().toString(36).slice(2, 8)}`;
  let absFile = "";
  const marks: string[] = [];
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派")) {
      if (afterTool(req)) return { kind: "text", text: "SUB-DONE 结论要点" };
      return { kind: "tool_calls", calls: [{ id: "s1", name: "read", arguments: { path: absFile } }] };
    }
    if (text.includes("第二条消息")) {
      // 父的下一轮：注入的 SubAgent 结果块应出现在上下文里
      marks.push(inputText(req));
      return { kind: "text", text: "收到结果" };
    }
    if (afterTool(req)) return { kind: "text", text: "已委派，等结果" };
    if (text.startsWith("分析文件")) return { kind: "tool_calls", calls: [{ id: "d1", name: "subagent_delegate", arguments: { request: "读指定文件总结要点", key: "ana1", read_paths: [absFile] } }] };
    return { kind: "text", text: "你好" };
  };
  const t = await startTestRuntime("sagent-dev", responder, { config: realTools() });
  try {
    const rt = t.runtime;
    absFile = path.join(t.work[0]!, "CLAUDE.md");
    fs.writeFileSync(absFile, `要点文件 ${secret}\n`, "utf8");
    const session = await rt.createSession({ projectName: "sdev", cwd: t.work[0]! });

    // 父任务先以 full_access 运行：子任务沿发起任务模式，工具分工仍只读
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "分析文件", modelSelection: rt.defaultSelection, accessMode: "full_access" });
    await waitFor("父任务完成", () => rt.store.getTask(parent.id)!.status === "completed");

    const works = rt.store.listWorkDelegationsBySession(session.id);
    assert.equal(works.length, 1);
    const work = works[0]!;
    const agent = rt.store.getSubAgent(work.subAgentId)!;
    assert.ok(agent.state === "running" || agent.state === "idle" || agent.state === "unverified");
    const task = rt.store.listTasksByWork(work.id)[0]!;
    assert.equal(task.accessMode, "full_access", "子任务沿发起任务模式");
    assert.equal(task.sourcePermissionVersion, parent.permissionVersion);
    assert.equal(task.subAgentId, agent.id);
    assert.equal(task.workId, work.id);
    assert.deepEqual(task.readScope?.paths.map((p) => p.path), [fs.realpathSync(absFile)]);
    assert.notEqual(task.sessionId, session.id, "独立子会话");
    assert.ok(agent.workDir !== path.resolve(t.work[0]!), "独立工作目录，不占用父 cwd");

    // 子任务的真实读取（local 后端真实 worker）：原文件未变
    await waitFor("子任务完成", () => rt.store.getTask(task.id)!.status === "completed");
    assert.equal(fs.readFileSync(path.join(t.work[0]!, "CLAUDE.md"), "utf8"), `要点文件 ${secret}\n`);
    const reply = rt.readTaskReply(task.id, 0, 4096)!;
    assert.ok(reply.text.includes("SUB-DONE"), "子任务最终回答按任务历史读取");

    // 空闲：保留身份，记录结果，不产生第二个 SubAgent
    assert.equal(rt.store.getSubAgent(agent.id)!.state, "idle");
    assert.equal(rt.store.listSubAgents().length, 1);
    assert.equal(rt.store.listWorkDelegationsBySession(session.id).length, 1);

    // 完成事件指向父会话（持久通知归属）
    const events = (rt.store.db.prepare("SELECT body FROM events WHERE session_id = ?").all(session.id) as Array<{ body: string }>)
      .map((r) => JSON.parse(r.body))
      .filter((b) => b.type === "subagent_task.completed");
    assert.equal(events.length, 1);
    assert.equal(events[0]!.workId, work.id);

    // dev 父会话不产生 wake 任务：结果经下一次模型调用注入
    assert.equal(rt.store.listTasksBySession(session.id).filter((x) => x.requestId.startsWith("wake:")).length, 0);
    const second = await rt.submit({ sessionId: session.id, requestId: "p2", input: "第二条消息", modelSelection: rt.defaultSelection });
    await waitFor("第二条完成", () => rt.store.getTask(second.id)!.status === "completed");
    assert.ok(marks.some((m) => m.includes("[SubAgent 结果]") && m.includes(work.id)), "下一次模型调用注入宿主结果资料，不伪装拥有者新请求");
  } finally {
    await t.shutdown();
  }
});

test("幂等与区分：同键同参跨轮次返回原记录，异参冲突，工作/Agent/任务分别核实，限额拒绝", async () => {
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派")) return { kind: "text", text: "SUB-DONE" };
    return { kind: "text", text: "父回复" };
  };
  const t = await startTestRuntime("sagent-idem", responder, { config: realTools() });
  try {
    const rt = t.runtime;
    const session = await rt.createSession({ projectName: "sidem", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "委派", modelSelection: rt.defaultSelection });
    await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");

    const input = { parentTaskId: parent.id, key: "k1", request: "分析 A", readPaths: ["."], paramsDigest: "d1" }
    const first = await delegateFromActiveTask(rt, { ...input });
    const second = await delegateFromActiveTask(rt, { ...input });
    assert.equal(second.created, false);
    assert.equal(first.work.id, second.work.id);
    assert.equal(first.agent.id, second.agent.id);
    assert.equal(first.task.id, second.task.id);
    await waitFor("子任务完成", () => rt.store.getTask(first.task.id)!.status === "completed");

    // 后一轮父任务按同键同参（不同直接父任务）仍返回首次记录的标准由工具层
    // paramsDigest 覆盖；此处验证管理器对同 workId+同键同摘要的继续委派返回原任务
    const parent2 = await rt.submit({ sessionId: session.id, requestId: "p2", input: "继续", modelSelection: rt.defaultSelection });
    await waitFor("父2完成", () => rt.store.getTask(parent2.id)!.status === "completed");
    const digest = first.work.paramsDigest;
    const replay = await delegateFromActiveTask(rt, { parentTaskId: parent2.id, key: "k1", request: "分析 A", readPaths: ["."], paramsDigest: digest });
    assert.equal(replay.created, false);
    assert.equal(replay.task.id, first.task.id, "跨轮次同键同参不重复创建执行");
    assert.equal(replay.work.id, first.work.id);
    await assert.rejects(
      () => delegateFromActiveTask(rt, { parentTaskId: parent2.id, key: "k1", request: "分析 A 但参数不同", readPaths: ["."], paramsDigest: "other" }),
      /幂等键冲突/,
    );

    // 同工作新键 → 同一 Agent 的新一次执行；工作/Agent/任务三只 ID 分别核实。
    // 继续委派要求 Agent 空闲（issue 12）：忙时明确拒绝不排队，先等结果登记为 idle
    await waitFor("Agent 空闲", () => rt.store.getSubAgent(first.agent.id)!.state === "idle");
    const again = await delegateFromActiveTask(rt, { parentTaskId: parent2.id, key: "k2", request: "分析 B", workId: first.work.id, readPaths: ["."], paramsDigest: "d2" });
    assert.equal(again.created, true);
    assert.equal(again.newWork, false);
    assert.equal(again.agent.id, first.agent.id, "同一项工作复用同一 SubAgent");
    assert.equal(again.work.id, first.work.id);
    assert.notEqual(again.task.id, first.task.id);
    assert.equal(rt.store.listTasksByWork(first.work.id).length, 2);
    assert.equal(rt.store.listSubAgents().length, 1, "没有再造一个 Agent");
    await waitFor("二次执行完成", () => rt.store.getTask(again.task.id)!.status === "completed");

    // 限额：同一会话最多三个活动执行任务（查重先于限额）
    const k3 = await delegateFromActiveTask(rt, { parentTaskId: parent2.id, key: "k3", request: "x", readPaths: ["."], paramsDigest: "d3" });
    const k4 = await delegateFromActiveTask(rt, { parentTaskId: parent2.id, key: "k4", request: "x", readPaths: ["."], paramsDigest: "d4" });
    const k5 = await delegateFromActiveTask(rt, { parentTaskId: parent2.id, key: "k5", request: "x", readPaths: ["."], paramsDigest: "d5" });
    await assert.rejects(
      () => delegateFromActiveTask(rt, { parentTaskId: parent2.id, key: "k6", request: "x", readPaths: ["."], paramsDigest: "d6" }),
      /已达上限/,
    );
    for (const k of [k3, k4, k5]) await waitFor("排队任务完成", () => rt.store.getTask(k.task.id)!.status === "completed");
  } finally {
    await t.shutdown();
  }
});

test("边界：读范围拒绝、伪造下级委派被两处拒绝、控制面不能把子会话当用户会话", async () => {
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[SubAgent 委派")) {
      if (afterTool(req)) return { kind: "text", text: "SUB-DONE" };
      if (text.includes("伪造读")) return { kind: "tool_calls", calls: [{ id: "b1", name: "read", arguments: { path: "/etc/passwd" } }] };
      return { kind: "tool_calls", calls: [{ id: "f1", name: "subagent_delegate", arguments: { request: "伪造下级", key: "nested" } }] };
    }
    return { kind: "text", text: "父回复" };
  };
  const t = await startTestRuntime("sagent-bound", responder, { config: realTools() });
  try {
    const rt = t.runtime;
    const session = await rt.createSession({ projectName: "sbound", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p1", input: "委派", modelSelection: rt.defaultSelection });
    await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");

    // 范围外/保护根/符号链接越界：登记即拒绝
    await assert.rejects(
      () => delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "bad1", request: "x", readPaths: ["/etc"], paramsDigest: "b1" }),
      /超出父工作区/,
    );
    await assert.rejects(
      () => delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "bad2", request: "x", readPaths: [rt.config.profile.dataDir], paramsDigest: "b2" }),
      /超出父工作区|保护|始终排除/,
    );
    fs.symlinkSync("/etc", path.join(t.work[0]!, "escape"));
    await assert.rejects(
      () => delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "bad3", request: "x", readPaths: [path.join(t.work[0]!, "escape")], paramsDigest: "b3" }),
      /超出父工作区/,
    );

    // general 继承来源基础工具，仍不能创建下一层 SubAgent。
    const deleg = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "bad4", request: "伪造写", readPaths: ["."], paramsDigest: "b4" });
    await waitFor("子任务完成", () => rt.store.getTask(deleg.task.id)!.status === "completed");
    const subCall = t.server.calls.find((c) => inputText(c).includes("[SubAgent 委派"))!;
    const subTools = toolNamesOf(subCall);
    for (const name of ["read", "read_artifact", "bash", "subagent_message", "skill"]) assert.ok(subTools.includes(name), name);
    assert.ok(!subTools.some(name => ["subagent_delegate", "workflow_start", "browser"].includes(name)));
    const toolResults = t.server.calls.filter((c) => afterTool(c) && inputText(c).includes("[SubAgent 委派"));
    assert.ok(toolResults.some((c) => /not found|白名单不含 subagent_delegate/.test(lastToolText(c))), "伪造下级委派在发送/调用两处被拒，未执行");

    // 伪造 read 参数指向范围外绝对路径：worker init 钉定的读范围在调用处拒绝
    const deleg5 = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "bad5", request: "伪造读", readPaths: ["."], paramsDigest: "b5" });
    await waitFor("子任务完成", () => rt.store.getTask(deleg5.task.id)!.status === "completed");
    const reads = t.server.calls.filter((c) => afterTool(c) && inputText(c).includes("伪造读")).map(lastToolText).join("\n");
    assert.match(reads, /只读范围|No such|ENOENT/i, "伪造 read 参数不能打开 worker init 范围之外的文件");

    // 下级委派：子会话不装配委派工具；宿主提交也被封
    assert.equal(rt.store.getTask(deleg.task.id)!.status, "completed");
    await assert.rejects(
      () => rt.submit({ sessionId: deleg.agent.sessionId, requestId: "x1", input: "继续聊", modelSelection: rt.defaultSelection }),
      /SubAgent 的独立工作会话/,
    );
    await assert.rejects(
      () => rt.switchTaskMode({ taskId: deleg.task.id, mode: "full_access" }),
      /不允许切换|invalid_state/,
    );
  } finally {
    await t.shutdown();
  }
});




test("模块级：subagent_result 按所属父会话开窄口，其他会话/工作拒绝", async () => {
  const t = await startTestRuntime("sagent-result-gate", async () => ({ kind: "text", text: "OK" }), { config: realTools() });
  try {
    const rt = t.runtime;
    const { createProjectSession } = await import("./helpers/testkit.ts");
    const sA = await createProjectSession(t.client, t.work[0]!);
    const sB = await createProjectSession(t.client, t.work[1]!);
    await rt.submit({ sessionId: sA.sessionId, requestId: "pa", input: "x", modelSelection: rt.defaultSelection });
    await waitFor("任务完成", () => rt.store.listTasksBySession(sA.sessionId).some((x) => x.resultSummary !== null) || rt.store.listTasksBySession(sA.sessionId).length > 0);
    const parent = rt.store.listTasksBySession(sA.sessionId)[0]!;
    const deleg = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "g1", request: "读一下", readPaths: ["."], paramsDigest: "g" });

    const { createSubAgentTools } = await import("@ruukoto/agent/subagent-tools.ts");
    const binding = { secret: "sk" };
    const tools = createSubAgentTools({
      coreStore: rt.store,
      delegate: async () => {
        throw new Error("not used");
      },
      close: () => {
        throw new Error("not used");
      },
      cancelWork: async () => {
        throw new Error("not used");
      },
      message: () => {
        throw new Error("not used");
      },
      integrate: async () => {
        throw new Error("not used");
      },
      readReply: (taskId, offset, length) => rt.readTaskReply(taskId, offset, length),
      artifacts: rt.artifacts,
      taskContext: () => ({ taskId: parent.id, sessionId: sB.sessionId, projectId: (rt.store.getSession(sB.sessionId)!).projectId, hostOpId: "opx" }),
      bindCall: undefined,
      verifyHost: () => null,
    });
    void binding;
    const subagentResult = tools.find((x) => x.name === "subagent_result")!;
    await assert.rejects(
      () => subagentResult.execute("sdk1", { work_id: deleg.work.id } as any, undefined as any, undefined as any, {} as any),
      /只能读取本会话登记的工作委托/,
    );
    await assert.rejects(
      () => subagentResult.execute("sdk2", { work_id: "work_nonexistent" } as any, undefined as any, undefined as any, {} as any),
      /只能读取本会话登记的工作委托/,
    );
  } finally {
    await t.shutdown();
  }
});

test("故障注入：登记事务中途失败不留半成品，目录已清理；同键随后可正常登记", async () => {
  const t = await startTestRuntime("sagent-fault", async () => ({ kind: "text", text: "OK" }), { config: realTools() });
  try {
    const rt = t.runtime;
    const session = await rt.createSession({ projectName: "sfault", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p", input: "x", modelSelection: rt.defaultSelection });
    await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");

    rt.store.db.faultNextWrite = new Error("注入登记失败");
    await assert.rejects(
      () => delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "f1", request: "y", readPaths: ["."], paramsDigest: "f" }),
      /注入登记失败/,
    );
    assert.equal(rt.store.listWorkDelegations().length, 0, "事务失败不留工作记录");
    assert.equal(rt.store.listSubAgents().length, 0, "事务失败不留 Agent 记录");
    const leftovers = fs.existsSync(path.join(rt.config.profile.workCopyDir, "sub-agents"))
      ? fs.readdirSync(path.join(rt.config.profile.workCopyDir, "sub-agents"))
      : [];
    assert.deepEqual(leftovers, [], "本次新建目录已清理");

    const ok = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "f1", request: "y", readPaths: ["."], paramsDigest: "f" });
    assert.equal(ok.created, true, "同键随后可正常登记");
    await waitFor("恢复后任务完成", () => rt.store.getTask(ok.task.id)!.status === "completed");
  } finally {
    await t.shutdown();
  }
});

test("终态未核实退出：占用保留时 SubAgent 记 unverified，不虚称空闲", async () => {
  const t = await startTestRuntime("sagent-unverified", async () => ({ kind: "text", text: "OK" }), { config: realTools() });
  try {
    const rt = t.runtime;
    const session = await rt.createSession({ projectName: "sunv", cwd: t.work[0]! });
    const parent = await rt.submit({ sessionId: session.id, requestId: "p", input: "x", modelSelection: rt.defaultSelection });
    await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const deleg = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "u1", request: "y", readPaths: ["."], paramsDigest: "u" });
    // 冻结子队列，任务停于 queued，随后模拟：占用仍在 + 任务被中断
    rt.store.setSessionQueueState(deleg.agent.sessionId, "paused", "test_fixture");
    const subSession = rt.store.getSession(deleg.agent.sessionId)!;
    rt.store.db
      .prepare("INSERT INTO occupancy (cwd_real, cwd_dev, cwd_ino, session_id, task_id, acquired_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(subSession.cwdReal, subSession.cwdDev, subSession.cwdIno, subSession.id, deleg.task.id, new Date().toISOString());
    rt.store.withTx(() => {
      rt.store.transitionTask(deleg.task.id, ["queued"], "interrupted", { interruptReason: "backend_restart", endedAt: new Date().toISOString() });
    });
    rt.orchestrator!.onRuntimeEvents([
      {
        seq: 0,
        taskId: deleg.task.id,
        sessionId: deleg.agent.sessionId,
        body: { type: "task.interrupted", taskId: deleg.task.id, sessionId: deleg.agent.sessionId, reason: "backend_restart", cancelRequested: false, effectUnknown: false },
        createdAt: new Date().toISOString(),
      },
    ]);
    await waitFor("结果已登记", () => rt.store.getTask(deleg.task.id)!.resultSummary !== null);
    assert.equal(rt.store.getSubAgent(deleg.agent.id)!.state, "unverified", "执行单元未核实退出不虚称空闲");
  } finally {
    await t.shutdown();
  }
});
