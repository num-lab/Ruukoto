/**
 * main 委派 coding（daily-agent issue 05）。
 *
 * seam：Runtime 公共接口 + mock 模型（脚本化工具调用，按实际请求载荷断言）。
 * - main 经 coding_delegate 创建 coding 子任务：宿主固定目标角色、工作目录、
 *   confirm 模式与截止时间；工具只装配给 main；
 * - 结果协议（摘要/产物/测试状态/失败原因/是否需要拥有者/effect 状态）写入
 *   result_ref 并随有界唤醒回到 main；大正文经 coding_result 分页读取；
 * - 只有拥有者发起的 main 任务可委派（直接提交或 Telegram 入站）；唤醒/其他来源
 *   触发的任务被拒，coding 的伪造调用被调用门拦截；
 * - analyze 失败最多自动重试一次（重试的结果唤醒 main 一次）；draft 失败不重试；
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Runtime, type RuntimeConfig } from "../src/runtime/runtime.ts";
import { createMockTools } from "../src/agent/mock-tools.ts";
import { MockModelServer, type RecordedRequest, type Responder } from "./helpers/mock-provider.ts";
import { cleanupDirs, lastUserText, makeTestDirs, realTools, startTestRuntime, waitFor, writeModelsJson } from "./helpers/testkit.ts";

function toolNamesOf(call: { tools: Array<Record<string, unknown>> | undefined }): string[] {
  return (call.tools ?? []).map((t: any) => t?.function?.name ?? t?.name).filter((n) => typeof n === "string");
}

/** 本轮请求的最后一条是工具结果（模型拿到工具返回后的下一次调用）。 */
function afterTool(req: RecordedRequest): boolean {
  return req.messages[req.messages.length - 1]?.role === "tool";
}

function lastToolText(req: RecordedRequest): string {
  const m = req.messages[req.messages.length - 1];
  return typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");
}

test("main 委派 coding：宿主固定 confirm 模式与截止时间；工具只装配给 main", async () => {
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[委派 coding")) return { kind: "text", text: "CODING-DONE 分析结论：仓库健康\n测试：通过\n需要拥有者：否" };
    if (text.includes("[编排器]")) return { kind: "text", text: "已汇报" };
    if (afterTool(req)) return { kind: "text", text: `已交给 coding：${lastToolText(req).slice(0, 200)}` };
    return {
      kind: "tool_calls",
      calls: [{ id: "d1", name: "coding_delegate", arguments: { request: "分析仓库的测试覆盖", mode: "analyze", key: "cov1" } }],
    };
  };
  const t = await startTestRuntime("deleg-basic", responder);
  try {
    const rt = t.runtime;
    const main = rt.store.getAgentRole("main")!;
    const coding = rt.store.getAgentRole("coding")!;
    // 拥有者把 coding 会话默认设为 full_access：委派子任务仍由宿主固定为 confirm
    const codingSession = rt.store.getSession(coding.sessionId)!;
    await rt.setSessionDefaultMode({ sessionId: coding.sessionId, mode: "full_access", expectedVersion: codingSession.defaultAccessModeVersion });
    const mainSession = rt.store.getSession(main.sessionId)!;
    await rt.setSessionDefaultMode({ sessionId: main.sessionId, mode: "full_access", expectedVersion: mainSession.defaultAccessModeVersion });

    const parent = await rt.submit({ sessionId: main.sessionId, requestId: "p1", input: "帮我看看仓库测试覆盖", modelSelection: rt.defaultSelection });
    await waitFor("父任务完成", () => rt.store.getTask(parent.id)!.status === "completed");

    const children = rt.store.listTasksBySession(coding.sessionId).filter((x) => x.parentTaskId === parent.id);
    assert.equal(children.length, 1);
    const child = children[0]!;
    assert.equal(child.agentId, "coding");
    assert.equal(child.accessMode, "confirm", "不继承 coding 会话默认 full_access");
    assert.match(child.input, /^\[委派 coding · analyze\]/);
    assert.ok(child.input.includes("分析仓库的测试覆盖"));
    assert.ok(child.deadline, "宿主固定截止时间");
    assert.ok(Date.parse(child.deadline!) > Date.now());

    const mainTools = toolNamesOf(t.server.calls.find((c) => lastUserText(c).includes("帮我看看"))!);
    assert.ok(mainTools.includes("coding_delegate") && mainTools.includes("coding_result"));
    await waitFor("coding 子任务完成", () => rt.store.getTask(child.id)!.status === "completed");
    const codingTools = toolNamesOf(t.server.calls.find((c) => lastUserText(c).includes("[委派 coding"))!);
    assert.ok(!codingTools.includes("coding_delegate"), "coding 不能再委派");
    assert.ok(!codingTools.some((n) => n.startsWith("app_data_") || n.startsWith("schedule_")), "coding 无 main 私有数据工具");
    await waitFor("结果唤醒已建立", () => rt.store.findTaskByRequest(main.sessionId, `wake:${child.id}`) !== null);
    assert.equal(rt.store.findTaskByRequest(main.sessionId, `wake:${child.id}`)!.accessMode, "confirm", "子任务结果触发的唤醒不继承 main 的完全访问");
  } finally {
    await t.shutdown();
  }
});

test("恢复：重试失败后不再重试；创建重试后的崩溃窗口只补记结果与一次唤醒；委派意图按子任务核实", async () => {
  const { dirs } = await makeTestDirs("deleg-restart", 0);
  const server = new MockModelServer(async (req) => {
    if (lastUserText(req).includes("[委派 coding")) throw new Error("持续模型故障");
    return { kind: "text", text: "已汇报" };
  });
  await writeModelsJson(dirs, await server.start());
  const config: RuntimeConfig = {
    dataDir: dirs.dataDir, agentDir: dirs.agentDir, socketPath: path.join(dirs.root, "c.sock"),
    thinkingLevel: "off", modelProvider: "mock", modelId: "mock-model", toolFactory: createMockTools,
  };
  let rt = await Runtime.start(config);
  try {
    const main = rt.store.getAgentRole("main")!;
    const coding = rt.store.getAgentRole("coding")!;
    const parent = await rt.submit({ sessionId: main.sessionId, requestId: "p", input: "分析", modelSelection: rt.defaultSelection });
    await waitFor("父任务完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const child = await rt.orchestrator!.delegateCoding({ parentTaskId: parent.id, mode: "analyze", request: "分析", idempotencyKey: "r" });
    const retryKey = `${child.requestId}:retry`;
    await waitFor("重试结果回传", () => rt.store.findChildTask(parent.id, retryKey)?.resultRef != null);
    const retry = rt.store.findChildTask(parent.id, retryKey)!;
    await waitFor("失败唤醒完成", () => rt.store.findTaskByRequest(main.sessionId, `wake:${retry.id}`)?.status === "completed");
    assert.equal(retry.status, "failed");
    assert.equal(rt.store.findChildTask(parent.id, `${retryKey}:retry`), null);
    assert.equal(Date.parse(retry.deadline!) - Date.parse(rt.store.getTask(child.id)!.endedAt!), 3_600_000);

    // 重试已建、首次结果未落盘；重试结果已落盘、唤醒未提交这两个崩溃窗口。
    const wake = rt.store.findTaskByRequest(main.sessionId, `wake:${retry.id}`)!;
    rt.store.db.prepare("UPDATE tasks SET result_summary = NULL, result_ref = NULL WHERE id = ?").run(child.id);
    for (const table of ["artifacts", "tool_ops", "confirmations"]) rt.store.db.prepare(`DELETE FROM ${table} WHERE task_id = ?`).run(wake.id);
    rt.store.db.prepare("DELETE FROM tasks WHERE id = ?").run(wake.id);
    for (const [id, name, key] of [["committed", "coding_delegate", "r"], ["uncommitted", "coding_delegate", "absent"], ["read", "coding_result", ""]]) {
      rt.store.recordToolIntent({ id, taskId: parent.id, sessionId: main.sessionId, toolName: name, params: { key } });
    }
    // 模拟终态已落盘、编排器尚未处理：恢复也必须遵守禁止重放的条件。
    rt.store.setSessionQueueState(coding.sessionId, "paused", "test_fixture");
    const noRetry = [];
    for (const kind of ["unknown", "approved", "timeout", "canceled", "interrupted"] as const) {
      const task = await rt.orchestrator!.delegate({ parentTaskId: parent.id, targetRole: "coding", input: "[委派 coding · analyze]\n恢复边界", idempotencyKey: kind });
      const status = kind === "timeout" || kind === "canceled" ? "canceled" : kind === "interrupted" ? "interrupted" : "failed";
      rt.store.transitionTask(task.id, ["queued"], status, { endedAt: new Date().toISOString(), errorMessage: kind === "timeout" ? "deadline_exceeded" : kind });
      if (kind === "unknown") rt.store.setEffectUnknown(task.id);
      if (kind === "approved" || kind === "timeout") {
        const opId = `op-${kind}`;
        rt.store.recordToolIntent({ id: opId, taskId: task.id, sessionId: coding.sessionId, toolName: "read", params: {} });
        rt.store.recordToolResult(opId, "已知结果", false);
        const approval = rt.store.createConfirmation({ taskId: task.id, sessionId: coding.sessionId, toolOpId: opId, toolName: "read", params: {}, scope: { kind: "tool", workspaceOnly: true }, permissionVersion: 1 });
        if (kind === "approved") rt.store.respondConfirmation(approval.id, "approved");
        else rt.store.stalePendingConfirmations(task.id);
      }
      noRetry.push({ ...task, kind });
    }
    for (let restart = 0; restart < 2; restart++) {
      await rt.stop("test_restart");
      rt = await Runtime.start(config);
      await waitFor("唤醒补发完成", () => rt.store.findTaskByRequest(main.sessionId, `wake:${retry.id}`)?.status === "completed");
      assert.equal(rt.store.listTasksBySession(coding.sessionId).filter((c) => c.parentTaskId === parent.id).length, 2 + noRetry.length);
      assert.deepEqual(rt.store.listTasksBySession(main.sessionId).filter((c) => c.requestId.startsWith("wake:")).map((c) => c.requestId).sort(), [retry, ...noRetry].map((c) => `wake:${c.id}`).sort());
      assert.equal(JSON.parse(rt.store.getTask(child.id)!.resultRef!).retriedBy, retry.id);
      assert.match(rt.store.getToolOp("committed")!.resultSummary!, /已提交/);
      assert.match(rt.store.getToolOp("uncommitted")!.resultSummary!, /已知未提交/);
      assert.match(rt.store.getToolOp("read")!.resultSummary!, /无写入效果/);
      assert.equal(rt.store.getToolOp("committed")!.effectUnknown, false);
      for (const task of noRetry) {
        assert.equal(rt.store.findChildTask(parent.id, `${task.requestId}:retry`), null, `${task.kind} 不重试`);
        const result = JSON.parse(rt.store.getTask(task.id)!.resultRef!);
        assert.equal(result.outcome, task.kind === "timeout" ? "timeout" : task.kind === "interrupted" ? "unknown" : "failed");
        if (["unknown", "interrupted", "timeout"].includes(task.kind)) assert.equal(result.needsOwner, true);
        if (task.kind === "unknown") assert.equal(result.effect, "unknown");
      }
    }
  } finally {
    await rt.stop("test_end");
    await server.close();
    await cleanupDirs(dirs);
  }
});

test("结果协议：结构化结果随唤醒回到 main，完整回答经 coding_result 分页读取", async () => {
  const longTail = "尾部细节".repeat(25_000); // 超过旧接口的 256 KiB 上限
  const replyOffset = Buffer.byteLength(`CODING-DONE 发现两处缺陷。${longTail}`);
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("[委派 coding")) {
      return { kind: "text", text: `CODING-DONE 发现两处缺陷。${longTail}TAIL-MARK\n测试：失败\n需要拥有者：是（需要 GitHub 写权限）` };
    }
    if (text.includes("[编排器]")) {
      if (afterTool(req)) return { kind: "text", text: "已汇报" };
      const taskId = /子任务：(\S+)（/.exec(text)![1]!;
      return { kind: "tool_calls", calls: [{ id: "r1", name: "coding_result", arguments: { task_id: taskId, part: "reply", offset: replyOffset, length: 4096 } }] };
    }
    if (afterTool(req)) return { kind: "text", text: "已交给 coding" };
    return { kind: "tool_calls", calls: [{ id: "d1", name: "coding_delegate", arguments: { request: "找缺陷", mode: "analyze", key: "bug1" } }] };
  };
  const t = await startTestRuntime("deleg-result", responder);
  try {
    const rt = t.runtime;
    const main = rt.store.getAgentRole("main")!;
    const parent = await rt.submit({ sessionId: main.sessionId, requestId: "p2", input: "帮我找找缺陷", modelSelection: rt.defaultSelection });
    await waitFor("子任务已创建", () => rt.store.countDelegations(parent.id) === 1);
    const child = rt.store.findChildTask(parent.id, `deleg:${parent.id}:bug1`)!;
    await waitFor("唤醒任务完成", () =>
      rt.store.listTasksBySession(main.sessionId).some((x) => x.requestId === `wake:${child.id}` && x.status === "completed"),
    );

    const done = rt.store.getTask(child.id)!;
    assert.ok(done.resultSummary!.length < 1100, "摘要有界");
    const result = JSON.parse(done.resultRef!);
    assert.equal(result.taskId, child.id);
    assert.equal(result.mode, "analyze");
    assert.equal(result.outcome, "completed");
    assert.equal(result.tests, "failed");
    assert.equal(result.needsOwner, true);
    assert.match(result.needsOwnerReason, /GitHub 写权限/);
    assert.equal(result.effect, "none_unknown");
    assert.equal(result.failure, null);
    assert.deepEqual(result.artifactIds, []);

    const wake = rt.store.listTasksBySession(main.sessionId).find((x) => x.requestId === `wake:${child.id}`)!;
    assert.match(wake.input, /测试：失败/);
    assert.match(wake.input, /需要拥有者：是/);
    assert.match(wake.input, /coding_result/);
    assert.ok(wake.input.length < 4096, "唤醒输入有界");

    const read = t.server.calls.find((c) => afterTool(c) && lastUserText(c).includes("[编排器]"))!;
    const toolText = lastToolText(read);
    assert.ok(toolText.includes("TAIL-MARK"), "coding_result 读到摘要之外的完整回答");
  } finally {
    await t.shutdown();
  }
});

test("委派入口：只有拥有者发起的 main 任务可委派；唤醒与其他来源被拒；coding 伪造调用被拦截", async () => {
  const delegateCall = (key: string) => ({ kind: "tool_calls" as const, calls: [{ id: `c-${key}`, name: "coding_delegate", arguments: { request: `请求-${key}`, mode: "analyze", key } }] });
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (afterTool(req)) return { kind: "text", text: `TOOL-ECHO ${lastToolText(req).slice(0, 300)}` };
    if (text.includes("CODING-FORGE")) return delegateCall("forge");
    if (text.includes("[委派 coding")) return { kind: "text", text: "完成\n测试：未运行\n需要拥有者：否" };
    if (text.includes("[编排器]")) return delegateCall("fromwake");
    if (text.includes("OTHER-SRC")) return delegateCall("other");
    if (text.includes("TG-OWNER")) return delegateCall("tg");
    return { kind: "text", text: "收到" };
  };
  const t = await startTestRuntime("deleg-gate", responder);
  try {
    const rt = t.runtime;
    const orch = rt.orchestrator!;
    const main = rt.store.getAgentRole("main")!;
    const coding = rt.store.getAgentRole("coding")!;
    const echoOf = (marker: string) => t.server.calls.filter((c) => afterTool(c) && lastUserText(c).includes(marker)).map(lastToolText).join("\n");

    // 非 owner 来源（如定时唤醒）的入站事件：拒绝委派
    const { event: other } = await orch.registerInboundEvent({ source: "scheduler", externalId: "o1", targetRole: "main", body: "OTHER-SRC 到点了" });
    // Telegram owner 入站：允许委派
    const { event: tg } = await orch.registerInboundEvent({ source: "telegram", externalId: "1:2:3", targetRole: "main", body: "TG-OWNER 修一下 bug" });
    await waitFor("两条入站事件完成", () =>
      rt.store.getInboundEvent(other.id)!.status !== "queued" && rt.store.getInboundEvent(tg.id)!.status !== "queued" &&
      rt.store.getInboundEvent(other.id)!.status !== "registered" && rt.store.getInboundEvent(tg.id)!.status !== "registered",
    );
    const otherTask = rt.store.getInboundEvent(other.id)!.taskId!;
    const tgTask = rt.store.getInboundEvent(tg.id)!.taskId!;
    assert.equal(rt.store.countDelegations(otherTask), 0, "非 owner 来源不能委派");
    assert.match(echoOf("OTHER-SRC"), /只有拥有者/);
    assert.equal(rt.store.countDelegations(tgTask), 1, "Telegram owner 入站可委派");

    // Telegram 委派的子任务完成后唤醒 main；唤醒任务里再委派被拒
    const child = rt.store.findChildTask(tgTask, `deleg:${tgTask}:tg`)!;
    assert.equal(child.sourceEventId, null, "子任务不继承 Telegram 自动回复授权");
    await waitFor("唤醒任务完成", () =>
      rt.store.listTasksBySession(main.sessionId).some((x) => x.requestId === `wake:${child.id}` && x.status === "completed"),
    );
    const wake = rt.store.listTasksBySession(main.sessionId).find((x) => x.requestId === `wake:${child.id}`)!;
    assert.equal(wake.sourceEventId, null, "子任务唤醒不产生 Telegram owner 回复");
    assert.equal(rt.store.countDelegations(wake.id), 0, "唤醒触发的任务不能委派");
    assert.match(echoOf("[编排器]"), /只有拥有者/);

    // coding 会话里伪造的委派调用：调用门拦截，不创建任务
    const forged = await rt.submit({ sessionId: coding.sessionId, requestId: "forge", input: "CODING-FORGE", modelSelection: rt.defaultSelection });
    await waitFor("coding 伪造任务结束", () => rt.store.getTask(forged.id)!.status === "completed");
    assert.equal(rt.store.countDelegations(forged.id), 0);
    // 装配层未注册（SDK 报 not found）；调用门是其后的兜底
    assert.match(echoOf("CODING-FORGE"), /coding_delegate not found|委派工具仅 main/);
  } finally {
    await t.shutdown();
  }
});

test("自动重试：analyze 失败只重试一次且只唤醒一次；draft 失败不重试直接唤醒", async () => {
  let analyzeAttempts = 0;
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("请求-an")) {
      analyzeAttempts++;
      if (analyzeAttempts === 1) throw new Error("模型故障（首次）");
      return { kind: "text", text: "重试成功\n测试：通过\n需要拥有者：否" };
    }
    if (text.includes("请求-dr")) throw new Error("模型故障（草稿）");
    if (text.includes("[编排器]")) return { kind: "text", text: "已汇报" };
    // mock 每轮只发一个工具调用：按已有工具结果数依次委派两次
    const done = req.messages.filter((m) => m.role === "tool").length;
    if (done === 0) return { kind: "tool_calls", calls: [{ id: "a", name: "coding_delegate", arguments: { request: "请求-an", mode: "analyze", key: "an" } }] };
    if (done === 1) return { kind: "tool_calls", calls: [{ id: "b", name: "coding_delegate", arguments: { request: "请求-dr", mode: "draft", key: "dr" } }] };
    return { kind: "text", text: "已委派" };
  };
  const t = await startTestRuntime("deleg-retry", responder);
  try {
    const rt = t.runtime;
    const main = rt.store.getAgentRole("main")!;
    const parent = await rt.submit({ sessionId: main.sessionId, requestId: "p4", input: "两件事", modelSelection: rt.defaultSelection });
    await waitFor("两个委派已创建", () => rt.store.countDelegations(parent.id) === 2);
    const an = rt.store.findChildTask(parent.id, `deleg:${parent.id}:an`)!;
    const dr = rt.store.findChildTask(parent.id, `deleg:${parent.id}:dr`)!;
    const wakes = () => rt.store.listTasksBySession(main.sessionId).filter((x) => x.requestId.startsWith("wake:"));

    await waitFor("重试子任务完成并唤醒", () => {
      const retry = rt.store.findChildTask(parent.id, `deleg:${parent.id}:an:retry`);
      return retry !== null && wakes().some((w) => w.requestId === `wake:${retry.id}` && w.status === "completed");
    }, 30_000);
    await waitFor("草稿失败唤醒", () => wakes().some((w) => w.requestId === `wake:${dr.id}` && w.status === "completed"), 30_000);

    const retry = rt.store.findChildTask(parent.id, `deleg:${parent.id}:an:retry`)!;
    assert.equal(rt.store.getTask(an.id)!.status, "failed");
    assert.equal(JSON.parse(rt.store.getTask(an.id)!.resultRef!).retriedBy, retry.id);
    assert.equal(retry.accessMode, "confirm");
    assert.equal(retry.input, an.input, "重试沿用同一正文");
    assert.equal(rt.store.getTask(retry.id)!.status, "completed");
    assert.equal(rt.store.findChildTask(parent.id, `deleg:${parent.id}:dr:retry`), null, "draft 不重试");
    assert.equal(rt.store.getTask(dr.id)!.status, "failed");

    // 首次失败不唤醒；重试与草稿各唤醒一次
    assert.deepEqual(wakes().map((w) => w.requestId).sort(), [`wake:${dr.id}`, `wake:${retry.id}`].sort());
    const retryWake = wakes().find((w) => w.requestId === `wake:${retry.id}`)!;
    assert.match(retryWake.input, /自动重试后/);
    const drWake = wakes().find((w) => w.requestId === `wake:${dr.id}`)!;
    assert.match(drWake.input, /子任务失败/);
    assert.match(drWake.input, /失败原因/);
    assert.equal(rt.store.countDelegations(parent.id), 2, "重试不计入委派上限");
  } finally {
    await t.shutdown();
  }
});

test("analyze 已执行工作区写入后失败，不自动重试", async () => {
  const t = await startTestRuntime("deleg-write", async (req) => {
    const text = lastUserText(req);
    if (text.includes("[编排器]")) return { kind: "text", text: "已汇报" };
    if (text.includes("[委派 coding")) {
      if (afterTool(req)) throw new Error("写入后模型故障");
      return { kind: "tool_calls", calls: [{ id: "write", name: "write", arguments: { path: "draft.txt", content: "保留这次修改" } }] };
    }
    if (afterTool(req)) return { kind: "text", text: "已委派" };
    return { kind: "tool_calls", calls: [{ id: "d", name: "coding_delegate", arguments: { request: "分析代码", mode: "analyze", key: "write" } }] };
  }, { config: realTools() });
  try {
    const rt = t.runtime;
    const main = rt.store.getAgentRole("main")!;
    const coding = rt.store.getAgentRole("coding")!;
    const parent = await rt.submit({ sessionId: main.sessionId, requestId: "p", input: "检查代码", modelSelection: rt.defaultSelection });
    await waitFor("写入任务结果回传", () => {
      const child = rt.store.findChildTask(parent.id, `deleg:${parent.id}:write`);
      return child?.resultRef != null;
    });
    assert.equal(fs.readFileSync(path.join(coding.workDir, "draft.txt"), "utf8"), "保留这次修改");
    assert.equal(rt.store.findChildTask(parent.id, `deleg:${parent.id}:write:retry`), null);
    const child = rt.store.findChildTask(parent.id, `deleg:${parent.id}:write`)!;
    await waitFor("失败唤醒完成", () => rt.store.listTasksBySession(main.sessionId).some((w) => w.requestId === `wake:${child.id}` && w.status === "completed"));
  } finally {
    await t.shutdown();
  }
});

test("委派输入：资料只传快照，超限及越权引用被拒；幂等键与每父三次上限生效", async () => {
  let calls: Array<Record<string, unknown>> = [];
  let next = 0;
  const t = await startTestRuntime("deleg-input", async (req) => {
    const text = lastUserText(req);
    if (!text.includes("INPUT-CASES") || text.includes("[编排器]") || text.includes("[委派 coding")) return { kind: "text", text: "完成" };
    const params = calls[next++];
    return params ? { kind: "tool_calls", calls: [{ id: `d${next}`, name: "coding_delegate", arguments: params }] } : { kind: "text", text: "已处理" };
  });
  try {
    const rt = t.runtime;
    const main = rt.store.getAgentRole("main")!;
    const coding = rt.store.getAgentRole("coding")!;
    const seed = await rt.submit({ sessionId: main.sessionId, requestId: "seed", input: "不应传给coding的完整历史", modelSelection: rt.defaultSelection });
    await waitFor("资料任务完成", () => rt.store.getTask(seed.id)!.status === "completed");
    const material = rt.artifacts.begin({ taskId: seed.id, sessionId: main.sessionId, name: "选定资料" });
    rt.artifacts.append(material.id, Buffer.from("SHARED-SNAPSHOT"));
    rt.artifacts.complete(material.id);
    const alien = await rt.submit({ sessionId: coding.sessionId, requestId: "private", input: "独立任务", modelSelection: rt.defaultSelection });
    await waitFor("独立任务完成", () => rt.store.getTask(alien.id)!.status === "completed");
    const privateArtifact = rt.artifacts.begin({ taskId: alien.id, sessionId: coding.sessionId, name: "未授权资料" });
    rt.artifacts.append(privateArtifact.id, Buffer.from("PRIVATE-ARTIFACT"));
    rt.artifacts.complete(privateArtifact.id);
    const first = { request: "检查快照", mode: "draft", key: "one", materials: [{ kind: "artifact", artifact_id: material.id }], accessMode: "full_access", targetRole: "main", cwd: "/" };
    calls = [
      first, first, { ...first, request: "换正文" },
      { request: "x".repeat(8192), mode: "analyze", key: "long" },
      { request: "越权", mode: "draft", key: "private", materials: [{ kind: "artifact", artifact_id: privateArtifact.id }] },
      { request: "保留的宿主后缀", mode: "draft", key: "one:retry" },
      ...["two", "three", "four"].map((key) => ({ request: key, mode: "draft", key })),
      first,
    ];
    const parent = await rt.submit({ sessionId: main.sessionId, requestId: "cases", input: "INPUT-CASES", modelSelection: rt.defaultSelection });
    await waitFor("输入校验任务完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const children = rt.store.listTasksBySession(coding.sessionId).filter((c) => c.parentTaskId === parent.id);
    assert.equal(children.length, 3);
    const child = rt.store.findChildTask(parent.id, `deleg:${parent.id}:one`)!;
    assert.equal(child.accessMode, "confirm");
    assert.match(child.input, /SHARED-SNAPSHOT/);
    assert.ok(!child.input.includes(material.id), "coding 只获得选定资料文本，不传原始引用ID");
    assert.ok(!child.input.includes("不应传给coding的完整历史"));
    const returns = t.server.calls.filter((c) => lastUserText(c) === "INPUT-CASES" && afterTool(c)).map(lastToolText);
    assert.equal(returns.length, calls.length);
    assert.match(returns[2]!, /幂等键冲突/);
    assert.match(returns[3]!, /超过 8192/);
    assert.match(returns[4]!, /不在 main 可读范围/);
    assert.match(returns[5]!, /key 必须/);
    assert.match(returns[8]!, /上限 3/);
    assert.ok(returns[9]!.includes(child.id), "达到上限后同键仍返回原任务");
  } finally {
    await t.shutdown();
  }
});

test("可变资料：同参重复委派复用首次快照，变更原始请求仍冲突", async () => {
  let step = 0;
  const params = { request: "检查记录", mode: "draft", key: "snapshot", materials: [{ kind: "app_data", table: "notes", row_id: 1, field: "text" }] };
  const calls = [
    { name: "app_data_define_table", arguments: { table: "notes", fields: [{ name: "text", type: "text" }], expected_schema_version: 0, reason: "记录资料" } },
    { name: "app_data_insert", arguments: { table: "notes", records: [{ text: "首次快照" }], reason: "记录资料" } },
    { name: "coding_delegate", arguments: params },
    { name: "app_data_update", arguments: { table: "notes", rows: [{ id: 1, expected_version: 1, set: { text: "后续变更" } }], reason: "更新资料" } },
    { name: "coding_delegate", arguments: params },
    { name: "coding_delegate", arguments: { ...params, request: "新请求" } },
  ];
  const t = await startTestRuntime("deleg-mutable", async (req) => {
    if (lastUserText(req) !== "MUTABLE") return { kind: "text", text: "完成" };
    const call = calls[step++];
    return call
      ? { kind: "tool_calls", calls: [{ id: `d${step}`, ...call }] }
      : { kind: "text", text: "已处理" };
  });
  try {
    const rt = t.runtime;
    const main = rt.store.getAgentRole("main")!;
    const parent = await rt.submit({ sessionId: main.sessionId, requestId: "p", input: "MUTABLE", modelSelection: rt.defaultSelection });
    await waitFor("资料重复委派结束", () => rt.store.getTask(parent.id)!.status === "completed");
    const replies = t.server.calls.filter((c) => lastUserText(c) === "MUTABLE" && afterTool(c)).map(lastToolText);
    const child = rt.store.findChildTask(parent.id, `deleg:${parent.id}:snapshot`)!;
    assert.match(replies[4]!, /已委派 coding/);
    assert.ok(replies[4]!.includes(child.id));
    assert.match(replies[5]!, /幂等键冲突/);
    assert.match(child.input, /首次快照/);
    assert.ok(!child.input.includes("后续变更"));
    assert.equal(rt.store.countDelegations(parent.id), 1);
  } finally {
    await t.shutdown();
  }
});

test("结果读取：仅允许 main 的 coding 子任务及其交付产物，UTF-8 分页不损坏字符", async () => {
  const queries: Array<Record<string, unknown>> = [];
  let next = 0;
  const t = await startTestRuntime("deleg-artifacts", async (req) => {
    if (lastUserText(req) !== "RESULT-CASES") return { kind: "text", text: "完成\n测试：未运行\n需要拥有者：否" };
    const params = queries[next++];
    return params ? { kind: "tool_calls", calls: [{ id: `r${next}`, name: "coding_result", arguments: params }] } : { kind: "text", text: "已读取" };
  });
  try {
    const rt = t.runtime;
    const main = rt.store.getAgentRole("main")!;
    const coding = rt.store.getAgentRole("coding")!;
    const parent = await rt.submit({ sessionId: main.sessionId, requestId: "p", input: "分析", modelSelection: rt.defaultSelection });
    await waitFor("父任务完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const child = await rt.orchestrator!.delegateCoding({ parentTaskId: parent.id, mode: "draft", request: "生成草稿", idempotencyKey: "a" });
    await waitFor("子任务唤醒完成", () => rt.store.findTaskByRequest(main.sessionId, `wake:${child.id}`)?.status === "completed");
    const alien = await rt.submit({ sessionId: coding.sessionId, requestId: "alien", input: "其他拥有者任务", modelSelection: rt.defaultSelection });
    await waitFor("独立任务完成", () => rt.store.getTask(alien.id)!.status === "completed");
    const deliverable = rt.artifacts.begin({ taskId: child.id, sessionId: coding.sessionId, name: "草稿" });
    const artifactText = "\uFEFF" + "中".repeat(100) + "TAIL";
    rt.artifacts.append(deliverable.id, Buffer.from(artifactText));
    rt.artifacts.complete(deliverable.id);
    const privateArtifact = rt.artifacts.begin({ taskId: alien.id, sessionId: coding.sessionId, name: "私有" });
    rt.artifacts.append(privateArtifact.id, Buffer.from("SECRET"));
    rt.artifacts.complete(privateArtifact.id);
    const snapshot = rt.store.listArtifactsByTask(child.id).find((a) => a.name.startsWith("prompt-snapshot:"))!;
    queries.push(
      { task_id: alien.id, part: "reply" },
      { task_id: child.id, part: "artifact", artifact_id: privateArtifact.id },
      { task_id: child.id, part: "artifact", artifact_id: snapshot.id },
      { task_id: child.id, part: "artifact", artifact_id: deliverable.id, length: 256 },
      { task_id: child.id, part: "artifact", artifact_id: deliverable.id, offset: 255, length: 256 },
    );
    const read = await rt.submit({ sessionId: main.sessionId, requestId: "read", input: "RESULT-CASES", modelSelection: rt.defaultSelection });
    await waitFor("结果读取完成", () => rt.store.getTask(read.id)!.status === "completed");
    const returns = t.server.calls.filter((c) => lastUserText(c) === "RESULT-CASES" && afterTool(c)).map(lastToolText);
    assert.match(returns[0]!, /只能读取 main 委派/);
    assert.match(returns[1]!, /不属于该子任务/);
    assert.match(returns[2]!, /不属于该子任务|不属于交付产物/);
    assert.match(returns[3]!, /继续用 offset=255/);
    assert.ok(!returns[3]!.includes("�"));
    assert.match(returns[4]!, /TAIL/);
    assert.ok(!returns[4]!.includes("�"));
    assert.equal(returns.slice(3).map((r) => r.slice(r.indexOf("\n") + 1)).join(""), artifactText, "包括 BOM 在内的正文可完整拼接");
  } finally {
    await t.shutdown();
  }
});

test("结果自报：以最后的报告为准；需要拥有者的长原因不会突破唤醒上限", async () => {
  const t = await startTestRuntime("deleg-report", async (req) => {
    const text = lastUserText(req);
    if (!text.includes("[委派 coding")) return { kind: "text", text: "收到" };
    return { kind: "text", text: text.endsWith("long")
      ? `分析\n测试：失败\n需要拥有者：是（${"x".repeat(3500)}）`
      : "报告格式示例：\n需要拥有者：是（这是引用）\n分析结束\n测试：通过\n需要拥有者：否" };
  });
  try {
    const rt = t.runtime;
    const main = rt.store.getAgentRole("main")!;
    const parent = await rt.submit({ sessionId: main.sessionId, requestId: "p", input: "检查", modelSelection: rt.defaultSelection });
    await waitFor("父任务完成", () => rt.store.getTask(parent.id)!.status === "completed");
    for (const key of ["last", "long"]) {
      const child = await rt.orchestrator!.delegateCoding({ parentTaskId: parent.id, mode: "analyze", request: key, idempotencyKey: key });
      await waitFor("自报结果回传", () => rt.store.findTaskByRequest(main.sessionId, `wake:${child.id}`)?.status === "completed");
      const result = JSON.parse(rt.store.getTask(child.id)!.resultRef!);
      assert.equal(result.needsOwner, key === "long");
      const wake = rt.store.findTaskByRequest(main.sessionId, `wake:${child.id}`)!;
      assert.ok(wake.input.length < 4096, `唤醒输入长度 ${wake.input.length}`);
    }
  } finally {
    await t.shutdown();
  }
});

test("停止：委派已提交但回执缺失时按子任务核实，不标效果未知", async () => {
  const t = await startTestRuntime("deleg-stop", async (req) => {
    const text = lastUserText(req);
    if (text.includes("[委派 coding") || text.includes("[编排器]")) return { kind: "text", text: "完成" };
    if (afterTool(req)) return { kind: "text", text: "已委派，正在整理上下文".repeat(20), chunkDelayMs: 200 };
    return { kind: "tool_calls", calls: [{ id: "d", name: "coding_delegate", arguments: { request: "检查", mode: "draft", key: "stop" } }] };
  });
  try {
    const rt = t.runtime;
    const main = rt.store.getAgentRole("main")!;
    const parent = await rt.submit({ sessionId: main.sessionId, requestId: "p", input: "停止边界", modelSelection: rt.defaultSelection });
    await waitFor("委派执行成功，父任务仍在回复", () => rt.store.listToolOpsByTask(parent.id).some((op) => op.toolName === "coding_delegate" && op.resultSummary !== null));
    const op = rt.store.listToolOpsByTask(parent.id).find((op) => op.toolName === "coding_delegate")!;
    // 只抹掉账本回执，模拟 SDK 收到结果而结果事务尚未提交的窗口。
    rt.store.db.prepare("UPDATE tool_ops SET result_summary = NULL, recorded_result_at = NULL WHERE id = ?").run(op.id);
    await rt.interruptTask(parent.id);
    assert.equal(rt.store.getTask(parent.id)!.effectUnknown, false);
    assert.equal(rt.store.getToolOp(op.id)!.effectUnknown, false);
    assert.match(rt.store.getToolOp(op.id)!.resultSummary!, /已提交/);
    assert.equal(rt.store.countDelegations(parent.id), 1);
  } finally {
    await t.shutdown();
  }
});

test("最终回答：运行中的中间文字不可读取，完成后分页始终来自同一回答", async () => {
  const { createServer } = await import("node:http");
  const { dirs } = await makeTestDirs("deleg-final-reply", 0);
  const intermediate = "尚未完成：" + "检查中".repeat(80);
  const finalReply = "最终结论：" + "汉🙂".repeat(70) + "\n测试：通过\n需要拥有者：否";
  const toolReplies = new Map<string, string>();
  let releaseReply!: () => void;
  const replyGate = new Promise<void>((resolve) => { releaseReply = resolve; });
  let waitingForReply = false;
  // 同一模型轮次同时返回文字和工具调用，下一轮等待读取检查完成后才给最终回答。
  const provider = createServer(async (req, res) => {
    res.on("error", () => {});
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const recorded: RecordedRequest = { messages: body.messages, tools: body.tools, system: null, raw: body };
    const input = lastUserText(recorded);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (delta: object, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({
      id: "final-reply", object: "chat.completion.chunk", created: 1, model: "mock-model",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    const call = (name: string, args: Record<string, unknown>) => {
      send({ tool_calls: [{ index: 0, id: "call", type: "function", function: { name, arguments: JSON.stringify(args) } }] });
      send({}, "tool_calls");
    };
    send({ role: "assistant", content: "" });
    if (input.includes("[委派 coding") && !afterTool(recorded)) {
      send({ content: intermediate });
      call("memory_list", {});
    } else if (input.includes("[委派 coding")) {
      waitingForReply = true;
      await replyGate;
      send({ content: finalReply }, "stop");
    } else if (input === "DELEGATE-FINAL" && !afterTool(recorded)) {
      call("coding_delegate", { request: "检查代码", mode: "draft", key: "final" });
    } else if (input.startsWith("READ-REPLY:") && !afterTool(recorded)) {
      call("coding_result", JSON.parse(input.slice("READ-REPLY:".length)));
    } else {
      if (input.startsWith("READ-REPLY:")) toolReplies.set(input, lastToolText(recorded));
      send({ content: "已处理" }, "stop");
    }
    res.end("data: [DONE]\n\n");
  });
  let runtime: Runtime | undefined;
  try {
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address() as import("node:net").AddressInfo;
    await writeModelsJson(dirs, `http://127.0.0.1:${address.port}/v1`);
    const rt = runtime = await Runtime.start({
      dataDir: dirs.dataDir, agentDir: dirs.agentDir, socketPath: path.join(dirs.root, "c.sock"),
      thinkingLevel: "off", modelProvider: "mock", modelId: "mock-model", toolFactory: createMockTools,
    });
    const main = rt.store.getAgentRole("main")!;
    const coding = rt.store.getAgentRole("coding")!;
    const parent = await rt.submit({ sessionId: main.sessionId, requestId: "p", input: "DELEGATE-FINAL", modelSelection: rt.defaultSelection });
    await waitFor("父任务完成", () => rt.getTaskDetail(parent.id)?.task.status === "completed");
    const child = rt.findTaskByRequest({ sessionId: coding.sessionId, requestId: `deleg:${parent.id}:final` }).task!;
    await waitFor("中间回答已落盘，最终回答仍在等待", () => waitingForReply &&
      rt.getTaskDetail(child.id)!.task.historyEntryIds.some((entryId) =>
        rt.readHistoryEntry({ sessionId: child.sessionId, entryId }).text === intermediate,
      ),
    );
    const readThroughMain = async (offset: number, requestId: string): Promise<string> => {
      const input = `READ-REPLY:${JSON.stringify({ task_id: child.id, part: "reply", offset, length: 256 })}`;
      const task = await rt.submit({ sessionId: main.sessionId, requestId, input, modelSelection: rt.defaultSelection });
      await waitFor("main 已读取回答", () => rt.getTaskDetail(task.id)?.task.status === "completed");
      const reply = toolReplies.get(input);
      assert.ok(reply, "mock 模型应收到 coding_result 的真实返回");
      return reply;
    };
    assert.equal(rt.getTaskDetail(child.id)!.task.status, "running");
    const pendingReply = await readThroughMain(0, "running");
    assert.match(pendingReply, /暂无最终回答/);
    assert.ok(!pendingReply.includes(intermediate));
    assert.equal(rt.readTaskReply(child.id), null);
    assert.equal(rt.readTaskReplyText(child.id), null);

    releaseReply();
    await waitFor("子任务完成", () => rt.getTaskDetail(child.id)?.task.status === "completed");
    let offset = 0;
    let entryId: string | undefined;
    let joined = "";
    while (offset < Buffer.byteLength(finalReply)) {
      const page = rt.readTaskReply(child.id, offset, 256);
      assert.ok(page);
      entryId ??= page.entryId;
      assert.equal(page.entryId, entryId, "每页必须属于同一条最终回答");
      assert.equal(page.offset, offset);
      assert.equal(page.totalBytes, Buffer.byteLength(finalReply));
      assert.ok(page.text.length > 0);
      const reply = await readThroughMain(offset, `completed-${offset}`);
      assert.equal(reply.slice(reply.indexOf("\n") + 1), page.text);
      joined += page.text;
      offset += Buffer.byteLength(page.text);
    }
    assert.equal(joined, finalReply, "分页拼接必须完整还原最终回答");
    assert.equal(rt.readTaskReplyText(child.id), finalReply);
  } finally {
    releaseReply();
    await runtime?.stop("test_end");
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await cleanupDirs(dirs);
  }
});
