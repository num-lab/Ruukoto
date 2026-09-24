/**
 * 编排器集成测试（issue 01 日常助手：角色、事件与子任务编排）。
 *
 * 覆盖工单验证项：
 * - 重复事件只创建一个子任务；
 * - 父任务完成前子任务结果可查询；
 * - 子任务结果能唤醒 main（有界唤醒输入）；
 * - 后台重启不会重复创建或重放外部操作（已登记未建任务可继续）；
 * - coding、chat 不能读取 main 的 owner token 或未授权资料；
 * - 角色工具白名单（装配/发送前检查/调用门三层）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Runtime, type RuntimeConfig } from "../src/runtime/runtime.ts";
import { readOwnerToken } from "../src/control/owner-token.ts";
import { createMockTools } from "../src/agent/mock-tools.ts";
import type { PersistentEvent } from "../src/core/types.ts";
import {
  cleanupDirs,
  createProjectSession,
  lastUserText,
  makeTestDirs,
  realTools,
  startTestRuntime,
  waitFor,
  writeModelsJson,
} from "./helpers/testkit.ts";
import { MockModelServer, type Responder } from "./helpers/mock-provider.ts";

function eventsOf(runtime: Runtime, type: string): PersistentEvent[] {
  return runtime.store.getEventsAfter(0).filter((e) => e.body.type === type);
}

function toolNamesOf(call: { tools: Array<Record<string, unknown>> | undefined }): string[] {
  return (call.tools ?? []).map((t: any) => t?.function?.name ?? t?.name).filter((n) => typeof n === "string");
}

test("角色引导：main/coding/chat 绑定独立项目、会话与工作目录", async () => {
  const t = await startTestRuntime("orch-boot", async () => ({ kind: "text", text: "ok" }));
  try {
    const roles = t.runtime.store.listAgentRoles();
    assert.deepEqual(roles.map((r) => r.id).sort(), ["chat", "coding", "main"]);
    const projectIds = new Set(roles.map((r) => r.projectId));
    const sessionIds = new Set(roles.map((r) => r.sessionId));
    assert.equal(projectIds.size, 3);
    assert.equal(sessionIds.size, 3);
    for (const role of roles) {
      assert.ok(fs.existsSync(role.workDir), `角色工作目录存在：${role.id}`);
      const session = t.runtime.store.getSession(role.sessionId)!;
      assert.equal(session.projectId, role.projectId);
      assert.equal(session.cwdReal, fs.realpathSync(role.workDir));
    }
    // 白名单：main 无编码工具（issue 02 起含应用数据空间），coding 全量，chat 空
    assert.deepEqual(roles.find((r) => r.id === "main")!.tools, ["host_data", "web_search", "app_data", "scheduler"]);
    assert.deepEqual(roles.find((r) => r.id === "coding")!.tools, ["coding", "host_data", "web_search", "mcp"]);
    assert.deepEqual(roles.find((r) => r.id === "chat")!.tools, []);
  } finally {
    await t.shutdown();
  }
});

test("重复事件只创建一个子任务", async () => {
  const t = await startTestRuntime("orch-dedup", async (req) => ({
    kind: "text",
    text: `已处理：${lastUserText(req).slice(0, 30)}`,
  }));
  try {
    const orch = t.runtime.orchestrator!;
    const first = await orch.registerInboundEvent({
      source: "test",
      externalId: "e1",
      actor: "tester",
      targetRole: "main",
      body: "UNIQUE-EVENT-MARK 请处理",
    });
    assert.equal(first.created, true);
    const dup = await orch.registerInboundEvent({
      source: "test",
      externalId: "e1",
      actor: "tester",
      targetRole: "main",
      body: "UNIQUE-EVENT-MARK 请处理",
    });
    assert.equal(dup.created, false);
    assert.equal(dup.event.id, first.event.id);

    await waitFor("事件处理完成", () => t.runtime.store.getInboundEvent(first.event.id)!.status === "done");
    const mainRole = t.runtime.store.getAgentRole("main")!;
    const tasks = t.runtime.store
      .listTasksBySession(mainRole.sessionId)
      .filter((x) => x.sourceEventId === first.event.id);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.agentId, "main");
    assert.equal(tasks[0]!.status, "completed");
    // 结果摘要已记录在任务上
    assert.ok(tasks[0]!.resultSummary!.includes("已处理"));
  } finally {
    await t.shutdown();
  }
});

test("子任务完成：结果记录、child_task.completed 事件与有界唤醒 main", async () => {
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("分析请求-42")) return { kind: "text", text: "分析结论：仓库健康" };
    return { kind: "text", text: "收到" };
  };
  const t = await startTestRuntime("orch-wake", responder);
  try {
    const orch = t.runtime.orchestrator!;
    const mainRole = t.runtime.store.getAgentRole("main")!;
    const parent = await t.runtime.submit({
      sessionId: mainRole.sessionId,
      requestId: "parent-1",
      input: "整理一下仓库状态",
      modelSelection: t.runtime.defaultSelection,
    });
    await waitFor("父任务完成", () => t.runtime.store.getTask(parent.id)!.status === "completed");

    const child = await orch.delegate({
      parentTaskId: parent.id,
      targetRole: "coding",
      input: "分析请求-42",
      idempotencyKey: "k1",
    });
    assert.equal(child.agentId, "coding");
    assert.equal(child.parentTaskId, parent.id);
    // 重复委派（同一幂等键）返回同一子任务
    const dup = await orch.delegate({
      parentTaskId: parent.id,
      targetRole: "coding",
      input: "分析请求-42",
      idempotencyKey: "k1",
    });
    assert.equal(dup.id, child.id);

    await waitFor("子任务结果已记录", () => {
      const c = t.runtime.store.getTask(child.id)!;
      return c.status === "completed" && c.resultSummary !== null;
    });
    const done = t.runtime.store.getTask(child.id)!;
    assert.ok(done.resultSummary!.includes("分析结论"));
    assert.equal(JSON.parse(done.resultRef!).taskId, child.id);

    await waitFor("child_task.completed 事件", () =>
      eventsOf(t.runtime, "child_task.completed").some((e) => (e.body as any).taskId === child.id),
    );

    // 唤醒 main：父任务会话收到有界唤醒输入（幂等键 wake:<childId>）
    await waitFor("唤醒任务完成", () =>
      t.runtime.store
        .listTasksBySession(mainRole.sessionId)
        .some((x) => x.requestId === `wake:${child.id}` && x.status === "completed"),
    );
    const wake = t.runtime.store
      .listTasksBySession(mainRole.sessionId)
      .find((x) => x.requestId === `wake:${child.id}`)!;
    assert.ok(wake.input.includes("子任务已完成"));
    assert.ok(wake.input.includes(child.id));
    assert.ok(wake.input.includes("分析结论"));
    assert.ok(wake.input.length < 4096, "唤醒输入有界");
  } finally {
    await t.shutdown();
  }
});

test("父任务完成前子任务结果可查询", async () => {
  let parentCalls = 0;
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("父任务-阻塞")) {
      parentCalls++;
      return parentCalls === 1
        ? { kind: "tool_calls", calls: [{ id: "pc1", name: "mock_delay", arguments: { ms: 2500 } }] }
        : { kind: "text", text: "父任务完成" };
    }
    return { kind: "text", text: "子任务结果正文" };
  };
  const t = await startTestRuntime("orch-query", responder);
  try {
    const orch = t.runtime.orchestrator!;
    const codingRole = t.runtime.store.getAgentRole("coding")!;
    const parent = await t.runtime.submit({
      sessionId: codingRole.sessionId,
      requestId: "p-block",
      input: "父任务-阻塞",
      modelSelection: t.runtime.defaultSelection,
    });
    await waitFor("父任务运行中", () => t.runtime.store.getTask(parent.id)!.status === "running");

    const child = await orch.delegate({
      parentTaskId: parent.id,
      targetRole: "chat",
      input: "群聊摘要请求",
      idempotencyKey: "k2",
    });
    await waitFor("子任务结果已记录", () => t.runtime.store.getTask(child.id)!.resultSummary !== null);
    // 父任务仍在运行，子任务结果已可查询
    assert.equal(t.runtime.store.getTask(parent.id)!.status, "running");
    const view = t.runtime.store.getTask(child.id)!;
    assert.equal(view.status, "completed");
    assert.ok(view.resultSummary!.includes("子任务结果正文"));

    await waitFor("父任务完成", () => t.runtime.store.getTask(parent.id)!.status === "completed", 20_000);
  } finally {
    await t.shutdown();
  }
});

test("子任务超时：编排器取消并发出 child_task.timeout，唤醒带超时摘要", async () => {
  let childCalls = 0;
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("超时子任务")) {
      childCalls++;
      return childCalls === 1
        ? { kind: "tool_calls", calls: [{ id: "tc1", name: "mock_delay", arguments: { ms: 5000 } }] }
        : { kind: "text", text: "不应到达" };
    }
    return { kind: "text", text: "收到" };
  };
  const t = await startTestRuntime("orch-timeout", responder, {
    config: { orchestrator: { deadlineCheckMs: 50 } },
  });
  try {
    const orch = t.runtime.orchestrator!;
    const mainRole = t.runtime.store.getAgentRole("main")!;
    const parent = await t.runtime.submit({
      sessionId: mainRole.sessionId,
      requestId: "p-timeout",
      input: "父任务",
      modelSelection: t.runtime.defaultSelection,
    });
    await waitFor("父任务完成", () => t.runtime.store.getTask(parent.id)!.status === "completed");

    const child = await orch.delegate({
      parentTaskId: parent.id,
      targetRole: "coding",
      input: "超时子任务",
      idempotencyKey: "k3",
      deadline: new Date(Date.now() + 300).toISOString(),
    });
    await waitFor(
      "child_task.timeout 事件",
      () => eventsOf(t.runtime, "child_task.timeout").some((e) => (e.body as any).taskId === child.id),
      20_000,
    );
    assert.equal(t.runtime.store.getTask(child.id)!.status, "canceled");
    assert.ok(t.runtime.store.getTask(child.id)!.resultSummary!.includes("超过截止时间"));

    await waitFor(
      "唤醒任务完成",
      () =>
        t.runtime.store
          .listTasksBySession(mainRole.sessionId)
          .some((x) => x.requestId === `wake:${child.id}` && x.status === "completed"),
      20_000,
    );
    const wake = t.runtime.store
      .listTasksBySession(mainRole.sessionId)
      .find((x) => x.requestId === `wake:${child.id}`)!;
    assert.ok(wake.input.includes("超时"));
  } finally {
    await t.shutdown();
  }
});

test("重启恢复：已登记未建任务可继续；中断子任务记结果未知，不重复创建、不重放", async () => {
  const { dirs } = await makeTestDirs("orch-restart", 0);
  let delayCalls = 0;
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("重启子任务")) {
      delayCalls++;
      return delayCalls === 1
        ? { kind: "tool_calls", calls: [{ id: "rc1", name: "mock_delay", arguments: { ms: 3000 } }] }
        : { kind: "text", text: "子任务完成" };
    }
    return { kind: "text", text: "收到" };
  };
  const server = new MockModelServer(responder);
  const baseUrl = await server.start();
  await writeModelsJson(dirs, baseUrl);
  const config: RuntimeConfig = {
    dataDir: dirs.dataDir,
    agentDir: dirs.agentDir,
    socketPath: path.join(dirs.root, "c.sock"),
    thinkingLevel: "off",
    modelProvider: "mock",
    modelId: "mock-model",
    toolFactory: (ctx) => createMockTools(ctx),
  };

  let rt = await Runtime.start(config);
  try {
    // 模拟崩溃窗口：事件已登记但尚未建任务（直接落库，不经编排器派发）
    const { event } = rt.store.withTx(() =>
      rt.store.registerInboundEvent({
        source: "test",
        externalId: "boot-1",
        actor: null,
        targetRole: "main",
        body: "启动恢复标记 ALPHA",
      }),
    );
    const mainSessionId = rt.store.getAgentRole("main")!.sessionId;
    await rt.stop("test_restart");

    // 重启①：恢复已登记事件并建任务（幂等键 evt:<eventId>）
    rt = await Runtime.start(config);
    await waitFor("事件已处理", () => rt.store.getInboundEvent(event.id)!.status === "done");
    const eventTasks = rt.store
      .listTasksBySession(mainSessionId)
      .filter((x) => x.sourceEventId === event.id);
    assert.equal(eventTasks.length, 1);
    // 角色身份跨重启稳定（引导幂等）
    assert.equal(rt.store.getAgentRole("main")!.sessionId, mainSessionId);

    // 运行中子任务被停止中断 → 重启后结果未知，不重复创建
    const parent = await rt.submit({
      sessionId: mainSessionId,
      requestId: "p-restart",
      input: "父任务",
      modelSelection: rt.defaultSelection,
    });
    await waitFor("父任务完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const child = await rt.orchestrator!.delegate({
      parentTaskId: parent.id,
      targetRole: "coding",
      input: "重启子任务",
      idempotencyKey: "k4",
    });
    await waitFor("子任务运行中", () => rt.store.getTask(child.id)!.status === "running");
    await rt.stop("test_restart");

    rt = await Runtime.start(config);
    await waitFor(
      "child_task.result_unknown 事件",
      () => eventsOf(rt, "child_task.result_unknown").some((e) => (e.body as any).taskId === child.id),
    );
    const interrupted = rt.store.getTask(child.id)!;
    assert.equal(interrupted.status, "interrupted");
    assert.ok(interrupted.resultSummary!.includes("结果未知"));
    // 不重复创建、不重放：同一委派幂等键仍只有一个任务
    const codingRole = rt.store.getAgentRole("coding")!;
    const childTasks = rt.store
      .listTasksBySession(codingRole.sessionId)
      .filter((x) => x.requestId === `deleg:${parent.id}:k4`);
    assert.equal(childTasks.length, 1);
    // main 收到有界唤醒（结果未知）
    await waitFor("唤醒任务完成", () =>
      rt.store
        .listTasksBySession(mainSessionId)
        .some((x) => x.requestId === `wake:${child.id}` && x.status === "completed"),
    );
    const wake = rt.store
      .listTasksBySession(mainSessionId)
      .find((x) => x.requestId === `wake:${child.id}`)!;
    assert.ok(wake.input.includes("结果未知"));
    assert.ok(wake.input.length < 4096, "唤醒输入有界");
  } finally {
    await rt.stop("test_end").catch(() => {});
    await server.close();
    await cleanupDirs(dirs);
  }
});

test("角色工具白名单：chat 空工具、main 无编码工具、coding 全量", async () => {
  const t = await startTestRuntime("orch-tools", async (req) => ({
    kind: "text",
    text: `完成：${lastUserText(req).slice(0, 20)}`,
  }));
  try {
    const orch = t.runtime.orchestrator!;
    await orch.registerInboundEvent({ source: "test", externalId: "chat-1", targetRole: "chat", body: "CHAT-MARK 群聊" });
    await orch.registerInboundEvent({ source: "test", externalId: "main-1", targetRole: "main", body: "MAIN-MARK 整理" });
    const mainRole = t.runtime.store.getAgentRole("main")!;
    const parent = await t.runtime.submit({
      sessionId: mainRole.sessionId,
      requestId: "p-tools",
      input: "父任务",
      modelSelection: t.runtime.defaultSelection,
    });
    const child = await orch.delegate({
      parentTaskId: parent.id,
      targetRole: "coding",
      input: "CODING-MARK 分析",
      idempotencyKey: "k5",
    });

    await waitFor("chat 事件完成", () => t.runtime.store.getInboundEvent(
      t.runtime.store.findInboundEvent("test", "chat-1")!.id,
    )!.status === "done");
    await waitFor("main 事件完成", () => t.runtime.store.getInboundEvent(
      t.runtime.store.findInboundEvent("test", "main-1")!.id,
    )!.status === "done");
    await waitFor("coding 子任务完成", () => t.runtime.store.getTask(child.id)!.status === "completed");

    const chatCall = t.server.calls.find((c) => lastUserText(c).includes("CHAT-MARK"))!;
    assert.ok(chatCall, "chat 任务已调用模型");
    assert.equal(toolNamesOf(chatCall).length, 0, "chat 空工具集合");

    const mainCall = t.server.calls.find((c) => lastUserText(c).includes("MAIN-MARK"))!;
    const mainTools = toolNamesOf(mainCall);
    assert.ok(mainTools.includes("history_search") && mainTools.includes("web_search"));
    assert.ok(mainTools.includes("app_data_query"), "main 有应用数据工具（issue 02）");
    assert.ok(!mainTools.includes("mock_delay"), "main 无编码工具");

    const codingCall = t.server.calls.find((c) => lastUserText(c).includes("CODING-MARK"))!;
    const codingTools = toolNamesOf(codingCall);
    assert.ok(codingTools.includes("mock_delay"), "coding 有编码工具");
    assert.ok(codingTools.includes("history_search") && codingTools.includes("web_search"));
  } finally {
    await t.shutdown();
  }
});

test("资料隔离：owner token 审批入口硬拒绝（保护根）；coding 搜不到 main 的未授权历史", async () => {
  let readAttempts = 0;
  let searchAttempts = 0;
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("读取令牌")) {
      readAttempts++;
      if (readAttempts === 1) {
        // 结构化审批入口：保护根必须硬拒绝（不产生审批单）。
        // 注：local 执行后端无文件系统隔离（ADR 0004，仅开发/验证），直接
        // read/bash 的边界由容器后端提供，不在本测试断言范围。
        return {
          kind: "tool_calls",
          calls: [{ id: "sec1", name: "request_file_access", arguments: { path: tokenPathHolder.path, operation: "read", reason: "测试越界读取" } }],
        };
      }
      return { kind: "text", text: "读取被拒绝，结束" };
    }
    if (text.includes("搜索资料")) {
      searchAttempts++;
      if (searchAttempts === 1) {
        return { kind: "tool_calls", calls: [{ id: "sec3", name: "history_search", arguments: { query: "SECRET-MARK" } }] };
      }
      return { kind: "text", text: "搜索完成" };
    }
    return { kind: "text", text: "收到" };
  };
  const tokenPathHolder = { path: "" };
  const t = await startTestRuntime("orch-sec", responder, { config: realTools() });
  try {
    tokenPathHolder.path = fs.realpathSync(path.join(t.runtime.controlDir(), "owner.token"));
    const orch = t.runtime.orchestrator!;
    const codingRole = t.runtime.store.getAgentRole("coding")!;

    // main 会话产生含私密标记的历史
    await orch.registerInboundEvent({
      source: "test",
      externalId: "iso-1",
      targetRole: "main",
      body: "SECRET-MARK 主会话私密内容-7712",
    });
    await waitFor("main 事件完成", () =>
      t.runtime.store.getInboundEvent(t.runtime.store.findInboundEvent("test", "iso-1")!.id)!.status === "done",
    );

    // coding 任务尝试读取 owner token：保护根硬拒绝（审批入口不可申请，
    // 直接 read 被工作进程边界拒绝）；不产生审批单，内容不得进入历史
    const readTask = await t.runtime.submit({
      sessionId: codingRole.sessionId,
      requestId: "sec-read",
      input: "读取令牌",
      modelSelection: t.runtime.defaultSelection,
    });
    await waitFor("读取任务结束", () => t.runtime.store.getTask(readTask.id)!.status === "completed", 30_000);
    const token = readOwnerToken(t.runtime.controlDir())!;
    const codingFile = t.runtime.store.getSession(codingRole.sessionId)!.sessionFile!;
    const readHistory = fs.readFileSync(codingFile, "utf8");
    assert.ok(!readHistory.includes(token), "owner token 未进入 coding 会话历史");
    assert.ok(readHistory.includes("始终排除"), "审批入口对保护根硬拒绝");
    assert.equal(
      t.runtime.store.listConfirmationsByTask(readTask.id).length,
      0,
      "保护根读取不产生审批单",
    );

    // coding 任务搜索 main 的私密标记：跨项目未授权，命中 0 条
    const searchTask = await t.runtime.submit({
      sessionId: codingRole.sessionId,
      requestId: "sec-search",
      input: "搜索资料",
      modelSelection: t.runtime.defaultSelection,
    });
    await waitFor("搜索任务完成", () => t.runtime.store.getTask(searchTask.id)!.status === "completed");
    const history = fs.readFileSync(codingFile, "utf8");
    // 命中的只能是 coding 自己的会话（工具调用参数含关键词本身），
    // main 项目的未授权内容不得出现在结果中
    assert.ok(!history.includes("主会话私密内容-7712"), "main 的未授权资料未进入 coding 会话");
    const hitLine = history.split("\n").find((l) => l.includes("命中") && l.includes("已覆盖范围内"));
    assert.ok(hitLine, "搜索工具已执行");
    assert.ok(!hitLine!.includes("主会话私密内容"), "命中结果不含 main 的内容");
  } finally {
    await t.shutdown();
  }
});

// ---------- 评审修复回归（2026-09-23 提交评审：3×P1 + 3×P2） ----------

function runtimeConfigFor(dirs: { dataDir: string; agentDir: string; root: string }): RuntimeConfig {
  return {
    dataDir: dirs.dataDir,
    agentDir: dirs.agentDir,
    socketPath: path.join(dirs.root, "c.sock"),
    thinkingLevel: "off",
    modelProvider: "mock",
    modelId: "mock-model",
    toolFactory: (ctx) => createMockTools(ctx),
  };
}

test("P1：occupancy_unverified 的角色会话不自动恢复（保留占用，拥有者核实后才放行）", async () => {
  const { dirs } = await makeTestDirs("orch-occ", 0);
  const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
  const baseUrl = await server.start();
  await writeModelsJson(dirs, baseUrl);
  let rt = await Runtime.start(runtimeConfigFor(dirs));
  try {
    const coding = rt.store.getAgentRole("coding")!;
    const first = await rt.submit({
      sessionId: coding.sessionId,
      requestId: "occ-first",
      input: "先跑一个任务",
      modelSelection: rt.defaultSelection,
    });
    await waitFor("首个任务完成", () => rt.store.getTask(first.id)!.status === "completed");
    // 模拟崩溃遗留：占用未释放 + 会话按 occupancy_unverified 暂停
    const session = rt.store.getSession(coding.sessionId)!;
    const acquired = rt.store.tryAcquireOccupancy({
      cwdReal: session.cwdReal,
      cwdDev: session.cwdDev,
      cwdIno: session.cwdIno,
      sessionId: session.id,
      taskId: first.id,
    });
    assert.ok(acquired, "遗留占用已登记");
    rt.store.setSessionQueueState(session.id, "paused", "occupancy_unverified");
    const next = await rt.submit({
      sessionId: coding.sessionId,
      requestId: "occ-next",
      input: "后续任务",
      modelSelection: rt.defaultSelection,
    });
    await rt.stop("test_restart");

    rt = await Runtime.start(runtimeConfigFor(dirs));
    const after = rt.store.getSession(coding.sessionId)!;
    assert.equal(after.queueState, "paused");
    assert.equal(after.queuePauseReason, "occupancy_unverified");
    assert.equal(rt.store.listAllOccupancy().length, 1, "旧执行未核实：占用保留");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(rt.store.listQueuedTasksFifo(coding.sessionId).length, 1, "未核实前后续任务不运行");

    // 拥有者核实并恢复后才允许后续任务运行
    await rt.resumeQueue(coding.sessionId);
    assert.equal(rt.store.listAllOccupancy().length, 0, "核实后遗留占用释放");
    await waitFor("后续任务完成", () => rt.store.getTask(next.id)!.status === "completed");
  } finally {
    await rt.stop("test_end").catch(() => {});
    await server.close();
    await cleanupDirs(dirs);
  }
});

test("P1：chat 不注入个人共享记忆与项目指令（main 正常注入）", async () => {
  const t = await startTestRuntime("orch-chatmem", async () => ({ kind: "text", text: "ok" }));
  try {
    // 经拥有者可信入口保存个人共享记忆（唯一标记）
    await t.client.request("save_memory", {
      project_id: null,
      category: "preference",
      content: "PERSONAL-MARK-4451 拥有者偏好",
      source_refs: [{ kind: "owner_note", note: "测试注入" }],
    });
    const orch = t.runtime.orchestrator!;
    await orch.registerInboundEvent({ source: "test", externalId: "chat-mem", targetRole: "chat", body: "CHAT-CTX-MARK 打个招呼" });
    await orch.registerInboundEvent({ source: "test", externalId: "main-mem", targetRole: "main", body: "MAIN-CTX-MARK 整理一下" });
    await waitFor("chat 事件完成", () => t.runtime.store.getInboundEvent(
      t.runtime.store.findInboundEvent("test", "chat-mem")!.id,
    )!.status === "done");
    await waitFor("main 事件完成", () => t.runtime.store.getInboundEvent(
      t.runtime.store.findInboundEvent("test", "main-mem")!.id,
    )!.status === "done");

    const payloadOf = (c: { messages: unknown; system: unknown }) => JSON.stringify(c.messages) + JSON.stringify(c.system ?? "");
    const chatCall = t.server.calls.find((c) => lastUserText(c).includes("CHAT-CTX-MARK"))!;
    assert.ok(chatCall, "chat 任务已调用模型");
    assert.ok(!payloadOf(chatCall).includes("PERSONAL-MARK-4451"), "个人共享记忆不得进入 chat 上下文");
    const mainCall = t.server.calls.find((c) => lastUserText(c).includes("MAIN-CTX-MARK"))!;
    assert.ok(payloadOf(mainCall).includes("PERSONAL-MARK-4451"), "main 正常注入个人共享记忆");
  } finally {
    await t.shutdown();
  }
});

test("P1：结果已落库但唤醒缺失时重启补发（原幂等键），重复恢复不重复投递", async () => {
  const { dirs } = await makeTestDirs("orch-wake-rcv", 0);
  const server = new MockModelServer(async (req) => ({ kind: "text", text: `ok:${lastUserText(req).slice(0, 20)}` }));
  const baseUrl = await server.start();
  await writeModelsJson(dirs, baseUrl);
  let rt = await Runtime.start(runtimeConfigFor(dirs));
  try {
    const orch = rt.orchestrator!;
    const main = rt.store.getAgentRole("main")!;
    const parent = await rt.submit({ sessionId: main.sessionId, requestId: "pw", input: "父任务", modelSelection: rt.defaultSelection });
    await waitFor("父任务完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const child = await orch.delegate({ parentTaskId: parent.id, targetRole: "coding", input: "子任务", idempotencyKey: "wk1" });
    await waitFor("唤醒完成", () =>
      rt.store.listTasksBySession(main.sessionId).some((x) => x.requestId === `wake:${child.id}` && x.status === "completed"),
    );
    // 模拟“结果已落库、唤醒未提交”的崩溃窗口：抹掉唤醒任务行（结果保留）
    const wake = rt.store.listTasksBySession(main.sessionId).find((x) => x.requestId === `wake:${child.id}`)!;
    for (const table of ["artifacts", "tool_ops", "confirmations"] as const) {
      rt.store.db.prepare(`DELETE FROM ${table} WHERE task_id = ?`).run(wake.id);
    }
    rt.store.db.prepare("DELETE FROM tasks WHERE id = ?").run(wake.id);
    await rt.stop("test_restart");

    rt = await Runtime.start(runtimeConfigFor(dirs));
    await waitFor("唤醒补发完成", () =>
      rt.store.listTasksBySession(main.sessionId).some((x) => x.requestId === `wake:${child.id}` && x.status === "completed"),
    );
    const wakes = () => rt.store.listTasksBySession(main.sessionId).filter((x) => x.requestId === `wake:${child.id}`);
    assert.equal(wakes().length, 1, "只补发一个唤醒任务");
    await rt.stop("test_restart");

    rt = await Runtime.start(runtimeConfigFor(dirs));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(wakes().length, 1, "重复恢复不重复投递");
  } finally {
    await rt.stop("test_end").catch(() => {});
    await server.close();
    await cleanupDirs(dirs);
  }
});

test("P2：委派幂等键在父任务范围内唯一——同参返回原任务，异参（换角色/换正文）冲突", async () => {
  const t = await startTestRuntime("orch-deleg", async () => ({ kind: "text", text: "ok" }));
  try {
    const orch = t.runtime.orchestrator!;
    const main = t.runtime.store.getAgentRole("main")!;
    const parent = await t.runtime.submit({ sessionId: main.sessionId, requestId: "pd", input: "父任务", modelSelection: t.runtime.defaultSelection });
    const c1 = await orch.delegate({ parentTaskId: parent.id, targetRole: "coding", input: "同一份正文", idempotencyKey: "dup1" });
    const c2 = await orch.delegate({ parentTaskId: parent.id, targetRole: "coding", input: "同一份正文", idempotencyKey: "dup1" });
    assert.equal(c2.id, c1.id, "同键同参返回原任务");
    await assert.rejects(
      () => orch.delegate({ parentTaskId: parent.id, targetRole: "chat", input: "同一份正文", idempotencyKey: "dup1" }),
      /幂等键冲突/,
      "同键换角色（会话不同）必须冲突",
    );
    await assert.rejects(
      () => orch.delegate({ parentTaskId: parent.id, targetRole: "coding", input: "另一份正文", idempotencyKey: "dup1" }),
      /幂等键冲突/,
      "同键换正文必须冲突",
    );
    // 冲突未产生第二个子任务：父任务名下仍只有一个
    await waitFor("子任务完成", () => t.runtime.store.getTask(c1.id)!.status === "completed");
    const children = t.runtime.store.listTasksBySession(t.runtime.store.getAgentRole("coding")!.sessionId)
      .filter((x) => x.parentTaskId === parent.id);
    assert.equal(children.length, 1);
  } finally {
    await t.shutdown();
  }
});

test("P2：截止时间统一为 UTC 表示——不同时区写法等价幂等，未到/已到两侧边界正确", async () => {
  const t = await startTestRuntime("orch-tz", async () => ({ kind: "text", text: "ok" }));
  try {
    const orch = t.runtime.orchestrator!;
    const main = t.runtime.store.getAgentRole("main")!;
    const parent = await t.runtime.submit({ sessionId: main.sessionId, requestId: "ptz", input: "父任务", modelSelection: t.runtime.defaultSelection });
    const c1 = await orch.delegate({
      parentTaskId: parent.id,
      targetRole: "coding",
      input: "带截止",
      idempotencyKey: "tz1",
      deadline: "2038-01-19T03:14:07Z",
    });
    assert.equal(t.runtime.store.getTask(c1.id)!.deadline, "2038-01-19T03:14:07.000Z", "入库为 UTC ISO");
    // 等价的 -08:00 写法 → 同一时刻，幂等去重为同一子任务
    const c2 = await orch.delegate({
      parentTaskId: parent.id,
      targetRole: "coding",
      input: "带截止",
      idempotencyKey: "tz1",
      deadline: "2038-01-18T19:14:07-08:00",
    });
    assert.equal(c2.id, c1.id, "等价时刻不同时区写法去重");
    const now = new Date().toISOString();
    assert.ok(!t.runtime.store.listOverdueTasks(now).some((x) => x.id === c1.id), "远未到期不误判");
    const c3 = await orch.delegate({
      parentTaskId: parent.id,
      targetRole: "coding",
      input: "已过期",
      idempotencyKey: "tz2",
      deadline: new Date(Date.now() - 60_000).toISOString(),
    });
    assert.ok(t.runtime.store.listOverdueTasks(now).some((x) => x.id === c3.id), "已到期正确选中");
  } finally {
    await t.shutdown();
  }
});

test("P2：旧提交摘要兼容——升级前已接收请求同参重试返回原任务，异参仍冲突", async () => {
  const t = await startTestRuntime("orch-legacy", async () => ({ kind: "text", text: "ok" }));
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const first = await t.runtime.submit({
      sessionId,
      requestId: "legacy-1",
      input: "原始输入",
      modelSelection: t.runtime.defaultSelection,
    });
    // 把任务摘要改写为 v11 前的旧格式（无编排字段），模拟升级前已接收的任务
    const legacyDigest = createHash("sha256").update(JSON.stringify({
      input: "原始输入",
      accessMode: "confirm",
      grantedPaths: [],
      resumesTaskId: null,
      modelSelection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
    })).digest("hex");
    t.runtime.store.db.prepare("UPDATE tasks SET submission_digest = ? WHERE id = ?").run(legacyDigest, first.id);
    // 同参重试：返回原任务，不误判 request_conflict
    const retry = await t.runtime.submit({
      sessionId,
      requestId: "legacy-1",
      input: "原始输入",
      modelSelection: t.runtime.defaultSelection,
    });
    assert.equal(retry.id, first.id);
    // 异参仍冲突（同键异参校验不放宽）
    await assert.rejects(
      () => t.runtime.submit({ sessionId, requestId: "legacy-1", input: "改动后的输入", modelSelection: t.runtime.defaultSelection }),
      /提交参数不同/,
    );
  } finally {
    await t.shutdown();
  }
});
