import { delegateFromActiveTask } from "./helpers/active-subagent-source.ts";
import { product as personalProduct } from "../apps/ruukoto/src/product.ts";
/**
 * 编排器集成测试（issue 01 日常助手：角色、事件与子任务编排）。
 *
 * 覆盖工单验证项：
 * - 重复事件只创建一个子任务；
 * - 父任务完成前子任务结果可查询；
 * - 子任务结果能唤醒 main（有界唤醒输入）；
 * - 后台重启不会重复创建或重放外部操作（已登记未建任务可继续）；
 * - 非 main 会话不能读取 main 的 owner token 或未授权资料；
 * - 角色工具白名单（按会话类别清单装配，激活、发送前检查与调用门共用同一结论）。
 * 固定 coding 退役后的旧子任务收尾见 test/87。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Runtime, type RuntimeConfig } from "@ruukoto/runtime/runtime.ts";
import { readOwnerToken } from "@ruukoto/control/owner-token.ts";
import { createMockTools } from "@ruukoto/agent/mock-tools.ts";
import type { PersistentEvent } from "@ruukoto/core/types.ts";
import {
  toolNamesOf,
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

test("角色引导：只引导 main（chat/coding 已退役，issue 20/23）", async () => {
  const t = await startTestRuntime("orch-boot", async () => ({ kind: "text", text: "ok" }));
  try {
    const roles = t.runtime.store.listAgentRoles();
    assert.deepEqual(roles.map((r) => r.id), ["main"]);
    assert.equal(t.runtime.store.findProjectByName("agent-chat"), null, "不建 chat 项目");
    assert.equal(t.runtime.store.findProjectByName("agent-coding"), null, "不建 coding 项目");
    const main = roles[0]!;
    assert.ok(fs.existsSync(main.workDir), "角色工作目录存在");
    const session = t.runtime.store.getSession(main.sessionId)!;
    assert.equal(session.projectId, main.projectId);
    assert.equal(session.cwdReal, fs.realpathSync(main.workDir));
    // 白名单：main 无编码工具（issue 02 起含应用数据空间；agent-direction issue 09 起含
    // service 类别——装配另要求产品/Linux/显式部署配置，见 tool-availability）
    assert.deepEqual(main.tools, ["host_data", "web_search", "browser", "app_data", "scheduler", "delegation", "chat_results", "service", "skills", "subagent", "workflow"]);
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

test("子任务超时：编排器取消 SubAgent 任务并发出 subagent_task.timeout", async () => {
  const responder: Responder = async (req) => {
    if (lastUserText(req).includes("超时子任务")) {
      await new Promise((r) => setTimeout(r, 4000));
      return { kind: "text", text: "不应到达" };
    }
    return { kind: "text", text: "收到" };
  };
  const t = await startTestRuntime("orch-timeout", responder, {
    config: { orchestrator: { deadlineCheckMs: 50 } },
  });
  try {
    const rt = t.runtime;
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const parent = await rt.submit({ sessionId, requestId: "p-timeout", input: "父任务", modelSelection: rt.defaultSelection });
    await waitFor("父任务完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const { task: child } = await delegateFromActiveTask(rt, {
      parentTaskId: parent.id, key: "k3", request: "超时子任务", readPaths: ["."], materials: null, paramsDigest: "d-timeout",
    });
    await waitFor("子任务运行中", () => rt.store.getTask(child.id)!.status === "running");
    rt.store.db.prepare("UPDATE tasks SET deadline = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), child.id);
    await waitFor(
      "subagent_task.timeout 事件",
      () => eventsOf(rt, "subagent_task.timeout").some((e) => (e.body as any).taskId === child.id),
      20_000,
    );
    assert.equal(rt.store.getTask(child.id)!.status, "canceled");
    assert.ok(rt.store.getTask(child.id)!.resultSummary!.includes("超过截止时间"));
  } finally {
    await t.shutdown();
  }
});

test("重启恢复：已登记未建任务可继续，不重复创建", async () => {
  const { dirs } = await makeTestDirs("orch-restart", 0);
  const server = new MockModelServer(async () => ({ kind: "text", text: "收到" }));
  const baseUrl = await server.start();
  await writeModelsJson(dirs, baseUrl);
  const config: RuntimeConfig = {
    product: personalProduct.runtime,
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

  } finally {
    await rt.stop("test_end").catch(() => {});
    await server.close();
    await cleanupDirs(dirs);
  }
});

test("角色工具白名单：main 无编码工具，只读查阅旧 coding 结果（coding_delegate 已删除，issue 23）", async () => {
  const t = await startTestRuntime("orch-tools", async (req) => ({
    kind: "text",
    text: `完成：${lastUserText(req).slice(0, 20)}`,
  }));
  try {
    await t.runtime.orchestrator!.registerInboundEvent({ source: "test", externalId: "main-1", targetRole: "main", body: "MAIN-MARK 整理" });
    await waitFor("main 事件完成", () => t.runtime.store.getInboundEvent(
      t.runtime.store.findInboundEvent("test", "main-1")!.id,
    )!.status === "done");

    const mainCall = t.server.calls.find((c) => lastUserText(c).includes("MAIN-MARK"))!;
    const mainTools = toolNamesOf(mainCall);
    assert.ok(mainTools.includes("history_search") && mainTools.includes("web_search"));
    assert.ok(mainTools.includes("app_data_query"), "main 有应用数据工具（issue 02）");
    assert.ok(mainTools.includes("subagent_delegate") && mainTools.includes("coding_result"));
    assert.ok(!mainTools.includes("coding_delegate"), "固定 coding 委派已删除");
    assert.ok(!mainTools.includes("mock_delay"), "main 无编码工具");
  } finally {
    await t.shutdown();
  }
});

test("资料隔离：owner token 审批入口硬拒绝（保护根）；普通开发会话搜不到 main 的未授权历史", async () => {
  let readAttempts = 0;
  let searchAttempts = 0;
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("读取令牌")) {
      readAttempts++;
      if (readAttempts === 1) {
        // 结构化审批入口：保护根必须硬拒绝（不产生审批单）。
        // 注：local 执行后端无文件系统隔离（仅开发/验证），直接
        // read/bash 的边界由原生后端提供，不在本测试断言范围。
        // Note: 见 .agents/notes/implemented/architecture/2026-10-10-native-execution-sandbox.md
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
    const { sessionId: devSessionId } = await createProjectSession(t.client, t.work[0]!);

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

    // 开发会话任务尝试读取 owner token：保护根硬拒绝（审批入口不可申请，
    // 直接 read 被工作进程边界拒绝）；不产生审批单，内容不得进入历史
    const readTask = await t.runtime.submit({
      sessionId: devSessionId,
      requestId: "sec-read",
      input: "读取令牌",
      modelSelection: t.runtime.defaultSelection,
    });
    await waitFor("读取任务结束", () => t.runtime.store.getTask(readTask.id)!.status === "completed", 30_000);
    const token = readOwnerToken(t.runtime.controlDir())!;
    const devFile = t.runtime.store.getSession(devSessionId)!.sessionFile!;
    const readHistory = fs.readFileSync(devFile, "utf8");
    assert.ok(!readHistory.includes(token), "owner token 未进入开发会话历史");
    assert.ok(readHistory.includes("始终排除"), "审批入口对保护根硬拒绝");
    assert.equal(
      t.runtime.store.listConfirmationsByTask(readTask.id).length,
      0,
      "保护根读取不产生审批单",
    );

    // 开发会话任务搜索 main 的私密标记：跨项目未授权，命中 0 条
    const searchTask = await t.runtime.submit({
      sessionId: devSessionId,
      requestId: "sec-search",
      input: "搜索资料",
      modelSelection: t.runtime.defaultSelection,
    });
    await waitFor("搜索任务完成", () => t.runtime.store.getTask(searchTask.id)!.status === "completed");
    const history = fs.readFileSync(devFile, "utf8");
    // 命中的只能是开发会话自己（工具调用参数含关键词本身），
    // main 项目的未授权内容不得出现在结果中
    assert.ok(!history.includes("主会话私密内容-7712"), "main 的未授权资料未进入开发会话");
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
    product: personalProduct.runtime,
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
    const main = rt.store.getAgentRole("main")!;
    const first = await rt.submit({
      sessionId: main.sessionId,
      requestId: "occ-first",
      input: "先跑一个任务",
      modelSelection: rt.defaultSelection,
    });
    await waitFor("首个任务完成", () => rt.store.getTask(first.id)!.status === "completed");
    // 模拟崩溃遗留：占用未释放 + 会话按 occupancy_unverified 暂停
    const session = rt.store.getSession(main.sessionId)!;
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
      sessionId: main.sessionId,
      requestId: "occ-next",
      input: "后续任务",
      modelSelection: rt.defaultSelection,
    });
    await rt.stop("test_restart");

    rt = await Runtime.start(runtimeConfigFor(dirs));
    const after = rt.store.getSession(main.sessionId)!;
    assert.equal(after.queueState, "paused");
    assert.equal(after.queuePauseReason, "occupancy_unverified");
    assert.equal(rt.store.listAllOccupancy().length, 1, "旧执行未核实：占用保留");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(rt.store.listQueuedTasksFifo(main.sessionId).length, 1, "未核实前后续任务不运行");

    // 拥有者核实并恢复后才允许后续任务运行
    await rt.resumeQueue(main.sessionId);
    assert.equal(rt.store.listAllOccupancy().length, 0, "核实后遗留占用释放");
    await waitFor("后续任务完成", () => rt.store.getTask(next.id)!.status === "completed");
  } finally {
    await rt.stop("test_end").catch(() => {});
    await server.close();
    await cleanupDirs(dirs);
  }
});

test("P1：main 正常注入个人共享记忆与项目指令（chat 已退役不引导，issue 20）", async () => {
  const t = await startTestRuntime("orch-chatmem", async () => ({ kind: "text", text: "ok" }));
  try {
    // 经拥有者可信入口保存个人共享记忆（唯一标记）
    await t.client.request("save_memory", {
      project_id: null,
      category: "preference",
      content: "PERSONAL-MARK-4451 拥有者偏好",
      source_refs: [{ kind: "owner_note", note: "测试注入" }],
    });
    const role = t.runtime.store.getAgentRole("main")!;
    fs.writeFileSync(path.join(role.workDir, "RULES.md"), "INSTR-MARK-7713 项目约定");
    t.runtime.store.withTx(() => t.runtime.store.updateProjectSettings({ projectId: role.projectId, instructionFiles: ["RULES.md"] }));
    const orch = t.runtime.orchestrator!;
    await orch.registerInboundEvent({ source: "test", externalId: "main-mem", targetRole: "main", body: "MAIN-CTX-MARK 整理一下" });
    await waitFor("main 事件完成", () => t.runtime.store.getInboundEvent(
      t.runtime.store.findInboundEvent("test", "main-mem")!.id,
    )!.status === "done");

    const payloadOf = (c: { messages: unknown; system: unknown }) => JSON.stringify(c.messages) + JSON.stringify(c.system ?? "");
    const mainCall = t.server.calls.find((c) => lastUserText(c).includes("MAIN-CTX-MARK"))!;
    assert.ok(payloadOf(mainCall).includes("PERSONAL-MARK-4451"), "main 正常注入个人共享记忆");
    assert.ok(payloadOf(mainCall).includes("INSTR-MARK-7713"), "main 正常注入项目指令");
  } finally {
    await t.shutdown();
  }
});
