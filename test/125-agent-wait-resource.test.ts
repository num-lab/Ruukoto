import assert from "node:assert/strict";
import fs from "node:fs";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { product as codeProduct } from "../apps/ruukoto-code/src/product.ts";
import { product as personalProduct } from "./helpers/legacy-product.ts";
import type { AgentWaitSnapshot } from "@ruukoto/core/agent-wait.ts";
import { verifyDirIdentity } from "@ruukoto/core/dir-identity.ts";
import { parseSessionFile } from "@ruukoto/core/history.ts";
import { lastUserText, realTools, startTestRuntime, toolNamesOf, waitFor } from "./helpers/testkit.ts";
import { startMockMcp, withMcpDiscovery } from "./helpers/mock-mcp.ts";

test("MCP 任务让出后重取目录仍使用首轮授权，新增工具只进入新输入", async () => {
  const mcp = await startMockMcp({ tools: [{ name: "old" }, { name: "new" }] });
  let stage = 0;
  const t = await startTestRuntime("mcp-wait-frozen", withMcpDiscovery(request => {
    if (lastUserText(request) === "NEW") return request.messages.at(-1)?.role === "user" ? { kind: "tool_calls", calls: [{ id: "new-input", name: "mcp__probe__new", arguments: {} }] } : { kind: "text", text: "new-done" };
    const current = stage++;
    if (current === 0) return { kind: "tool_calls", calls: [{ id: "old", name: "mcp__probe__old", arguments: {} }] };
    if (current === 1) return { kind: "tool_calls", calls: [{ id: "wait", name: "wait", arguments: { targets: [{ kind: "task", task_id: "reference" }] } }] };
    if (current === 2) return { kind: "tool_calls", calls: [{ id: "forbidden-new", name: "mcp__probe__new", arguments: {} }] };
    return { kind: "text", text: "old-done" };
  }), { config: { ...realTools(), product: codeProduct.runtime }, workDirs: 1 });
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "mcp-wait", cwd: t.work[0] });
    await t.client.request("mcp_configure", { name: "probe", endpoint: mcp.url, tool_allowlist: ["old"] });
    const driver = await rt["getDriver"](session);
    driver["deps"].agentWait = {
      initialPhase: () => "execution", snapshot: () => null,
      acquireResources: async task => rt.store.withTx(() => rt.store.tryAcquireOccupancy({ taskId: task.id, sessionId: session.id, cwdReal: session.cwdReal, cwdDev: session.cwdDev, cwdIno: session.cwdIno })),
      wait: async (ctx, _sdkCallId, targets) => {
        assert.equal(await driver.yieldWorkspace(ctx.taskId), true);
        rt.store.withTx(() => rt.store.releaseOccupancy(ctx.taskId));
        await t.client.request("mcp_configure", { name: "probe", endpoint: mcp.url, tool_allowlist: ["old", "new"] });
        return { reason: "result", targets: targets.map(target => ({ ...target, status: "completed", resultSummary: "reference-done" })) };
      },
    };
    const task = await rt.submit({ sessionId: session.id, requestId: "old", input: "OLD", accessMode: "full_access", modelSelection: rt.defaultSelection });
    await waitFor("原任务收尾", () => rt.store.getTask(task.id)?.status === "completed");
    assert.equal(mcp.hits.filter(hit => hit.toolName === "new").length, 0, "恢复资源不能重捕获新MCP权限");
    const next = await rt.submit({ sessionId: session.id, requestId: "new", input: "NEW", accessMode: "full_access", modelSelection: rt.defaultSelection });
    await waitFor("新输入收尾", () => rt.store.getTask(next.id)?.status === "completed");
    assert.equal(mcp.hits.filter(hit => hit.toolName === "new").length, 1);
  } finally { await t.shutdown(); await mcp.close(); }
});

test("真实 worker：父轮安全让出同目录，另一任务执行，重取目录后新 worker 继续写入", async () => {
  let childId = "";
  const t = await startTestRuntime("wait-resource-real", async request => {
    assert.ok(toolNamesOf(request).includes("browser"));
    const tools = request.messages.filter(message => message.role === "tool");
    if (lastUserText(request) === "CHILD") return tools.length ? { kind: "text", text: "child-done" }
      : { kind: "tool_calls", calls: [{ id: "child-write", name: "write", arguments: { path: "child.txt", content: "child\n" } }] };
    if (!tools.length) return { kind: "tool_calls", calls: [{ id: "before", name: "write", arguments: { path: "parent.txt", content: "before\n" } }] };
    if (tools.length === 1) {
      await waitFor("子任务已入队", () => Boolean(childId));
      return { kind: "tool_calls", calls: [{ id: "wait", name: "wait", arguments: { targets: [{ kind: "task", task_id: childId }] } }] };
    }
    return tools.length === 2 ? { kind: "tool_calls", calls: [{ id: "after", name: "write", arguments: { path: "parent.txt", content: "after\n" } }] }
      : { kind: "text", text: "parent-done" };
  }, { config: { ...realTools(), product: codeProduct.runtime }, workDirs: 1 });
  try {
    const rt = t.runtime;
    const session = await rt.createSession({ projectName: "wait", cwd: t.work[0] });
    const other = await rt.createSession({ projectName: "wait-other", cwd: t.work[0] });
    const driver = await rt["getDriver"](session);
    const workerIds: string[] = [];
    driver["deps"].agentWait = {
      initialPhase: () => "execution", snapshot: () => null,
      acquireResources: async task => {
        await verifyDirIdentity({ cwd: session.cwd, cwdReal: session.cwdReal, dev: session.cwdDev, ino: session.cwdIno });
        return rt.store.withTx(() => rt.store.tryAcquireOccupancy({ taskId: task.id, sessionId: session.id,
          cwdReal: session.cwdReal, cwdDev: session.cwdDev, cwdIno: session.cwdIno }));
      },
      wait: async (ctx, _sdkCallId, targets) => {
        workerIds.push(driver.router.workerIdentity()!.id);
        assert.equal(await driver.yieldWorkspace(ctx.taskId), true);
        assert.equal(driver.router.workerIdentity(), null);
        rt.store.withTx(() => rt.store.releaseOccupancy(ctx.taskId));
        rt["kickAll"]();
        await waitFor("子任务完成真实文件写入", () => rt.store.getTask(childId)?.status === "completed");
        assert.equal(rt.store.getTask(ctx.taskId)?.status, "running");
        assert.equal(fs.readFileSync(path.join(t.work[0], "child.txt"), "utf8"), "child\n");
        return { reason: "result", targets: targets.map(target => ({ ...target, status: "completed", resultSummary: "child-done" })) };
      },
    };
    driver["deps"].afterModelRequest = () => {
      const identity = driver.router.workerIdentity();
      if (identity && workerIds.length && identity.id !== workerIds.at(-1)) workerIds.push(identity.id);
    };
    const parent = await rt.submit({ sessionId: session.id, requestId: "parent", input: "PARENT", accessMode: "full_access", modelSelection: rt.defaultSelection });
    await waitFor("父任务持目录", () => rt.store.getTask(parent.id)?.status === "running");
    childId = (await rt.submit({ sessionId: other.id, requestId: "child", input: "CHILD", accessMode: "full_access", modelSelection: rt.defaultSelection })).id;
    await waitFor("父任务重新执行并结束", () => rt.store.getTask(parent.id)?.status === "completed", 30_000);
    assert.equal(fs.readFileSync(path.join(t.work[0], "parent.txt"), "utf8"), "after\n");
    assert.equal(workerIds.length, 2);
    assert.notEqual(workerIds[0], workerIds[1]);
    assert.equal(rt.store.listAllOccupancy().length, 0);
  } finally { await t.shutdown(); }
});

test("冷启对话：不读工作区或技能、不启动 MCP，已记录指令仍进入模型，隐藏业务调用被拒绝", async context => {
  const mcp = await startMockMcp({ tools: [{ name: "read" }] });
  const t = await startTestRuntime("wait-resource-conversation", request => {
    assert.ok(!toolNamesOf(request).includes("browser"));
    assert.ok(!toolNamesOf(request).includes("write"));
    assert.ok(!toolNamesOf(request).includes("skill"));
    assert.ok(!toolNamesOf(request).some(name => name.startsWith("mcp_")));
    assert.match(JSON.stringify(request.messages), /PINNED_INSTRUCTION/);
    return request.messages.some(message => message.role === "tool") ? { kind: "text", text: "已解释目录等待" }
      : { kind: "tool_calls", calls: [{ id: "hidden-write", name: "write", arguments: { path: "attack.txt", content: "blocked" } }] };
  }, { config: { ...realTools(), product: codeProduct.runtime }, workDirs: 1 });
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "conversation", cwd: t.work[0] });
    rt.store.withTx(() => rt.store.updateProjectSettings({ projectId: session.projectId, instructionFiles: ["TEAM.md"] }));
    rt["mcp"].upsertService({ name: "blocked", endpoint: mcp.url, toolAllowlist: ["read"], enabled: true });
    const driver = await rt["getDriver"](session);
    const snapshot: AgentWaitSnapshot = { taskId: "source", permissionVersion: 0, selectionRecordId: null, promptArtifactId: null,
      instructions: { text: "PINNED_INSTRUCTION", version: "snapshot", problems: [] }, skills: null };
    driver["deps"].agentWait = { initialPhase: () => "conversation", snapshot: () => snapshot, acquireResources: async () => false,
      wait: async (_ctx, _id, targets) => ({ reason: "timeout", targets: targets.map(target => ({ ...target, status: "running" })) }) };
    const task = rt.store.withTx(() => {
      const task = rt.store.insertQueuedTask({ sessionId: session.id, requestId: "conversation", input: "解释等待", modelSelection: rt.defaultSelection, submissionDigest: "conversation", accessMode: "full_access" }).task;
      rt.store.transitionTask(task.id, ["queued"], "running");
      return rt.store.getTask(task.id)!;
    });
    const reads: string[] = [];
    for (const name of ["readFileSync", "readdirSync", "statSync", "realpathSync"] as const) {
      const original = fs[name];
      context.mock.method(fs, name, (...args: Parameters<typeof original>) => {
        const file = String(args[0]);
        if (file.startsWith(session.cwdReal + path.sep) || file.startsWith(path.join(t.dirs.agentDir, "skills"))) reads.push(`${name}:${file}`);
        return Reflect.apply(original, fs, args);
      });
    }
    syncBuiltinESMExports();
    await driver.run(task);
    context.mock.restoreAll();
    syncBuiltinESMExports();
    assert.deepEqual(reads, []);
    assert.equal(mcp.hits.length, 0);
    assert.equal(driver.router.workerIdentity(), null);
    assert.equal(rt.store.listToolOpsByTask(task.id).length, 0);
    assert.equal(rt.store.getTask(task.id)?.status, "completed");
  } finally {
    context.mock.restoreAll(); syncBuiltinESMExports();
    await t.shutdown(); await mcp.close();
  }
});

test("停止未核实：等待拒绝释放目录，下一模型请求不继续", async () => {
  const t = await startTestRuntime("wait-resource-unverified", () => ({ kind: "tool_calls", calls: [{ id: "wait", name: "wait", arguments: { targets: [{ kind: "task", task_id: "child" }] } }] }),
    { config: { ...realTools(), product: codeProduct.runtime }, workDirs: 1 });
  try {
    const rt = t.runtime;
    const session = await rt.createSession({ projectName: "unverified", cwd: t.work[0] });
    const driver = await rt["getDriver"](session);
    driver["deps"].agentWait = { initialPhase: () => "execution", snapshot: () => null, acquireResources: async () => true,
      wait: async (ctx, _id, targets) => {
        driver.registerManagedProcess(ctx.taskId, { kind: "starting", id: "unverified", label: "未核实单元", stop: async () => false });
        assert.equal(await driver.yieldWorkspace(ctx.taskId), false);
        assert.ok(rt.store.listAllOccupancy().some(held => held.taskId === ctx.taskId));
        return { reason: "attention", targets: targets.map(target => ({ ...target, status: "running", stopVerified: false })) };
      } };
    const task = await rt.submit({ sessionId: session.id, requestId: "unverified", input: "等待", accessMode: "full_access", modelSelection: rt.defaultSelection });
    await waitFor("停止未核实中断", () => rt.store.getTask(task.id)?.status === "interrupted");
    await driver.taskCompletion();
    assert.equal(t.server.calls.length, 1);
    assert.ok(rt.store.listAllOccupancy().some(held => held.taskId === task.id));
    assert.equal(rt.store.getTask(task.id)?.interruptReason, "tool_process_unreaped");
  } finally { await t.shutdown(); }
});

test("冷启对话等待期间放宽 MCP 配置，取得目录后的首次选择不扩大原任务权限", async () => {
  const mcp = await startMockMcp({ tools: [{ name: "old" }, { name: "new" }] });
  const t = await startTestRuntime("cold-mcp-scope", (_request, index) => {
    if (index === 0) return { kind: "tool_calls", calls: [{ id: "wait", name: "wait", arguments: { targets: [{ kind: "task", task_id: "reference" }] } }] };
    if (index === 1) return { kind: "tool_calls", calls: [{ id: "search", name: "tool_search", arguments: { query: "mcp__probe__new" } }] };
    if (index === 2) return { kind: "tool_calls", calls: [{ id: "blocked", name: "mcp__probe__new", arguments: {} }] };
    return { kind: "text", text: "原任务未执行新增工具" };
  }, { config: { ...realTools(), product: codeProduct.runtime }, workDirs: 1 });
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "scope", cwd: t.work[0] });
    await t.client.request("mcp_configure", { name: "probe", endpoint: mcp.url, tool_allowlist: ["old"] });
    const driver = await rt["getDriver"](session);
    driver["deps"].agentWait = {
      initialPhase: () => "conversation", snapshot: () => null,
      wait: async (_ctx, _id, targets) => { assert.equal(mcp.hits.length, 0); return { reason: "result", targets: targets.map(target => ({ ...target, status: "completed" })) }; },
      acquireResources: async task => {
        await t.client.request("mcp_configure", { name: "probe", endpoint: mcp.url, tool_allowlist: ["old", "new"] });
        return rt.store.withTx(() => rt.store.tryAcquireOccupancy({ taskId: task.id, sessionId: session.id, cwdReal: session.cwdReal, cwdDev: session.cwdDev, cwdIno: session.cwdIno }));
      },
    };
    const task = rt.store.withTx(() => {
      const queued = rt.store.insertQueuedTask({ sessionId: session.id, requestId: "cold", input: "等待目录", modelSelection: rt.defaultSelection, submissionDigest: "cold", accessMode: "full_access" }).task;
      rt.store.transitionTask(queued.id, ["queued"], "running");
      return rt.store.getTask(queued.id)!;
    });
    await driver.run(task);
    assert.equal(rt.store.getTask(task.id)?.status, "completed");
    assert.equal(mcp.hits.filter(hit => hit.rpcMethod === "tools/call").length, 0);
    assert.ok(t.server.calls.every(request => !toolNamesOf(request).includes("mcp__probe__new")));
  } finally { await t.shutdown(); await mcp.close(); }
});

test("冷启对话恢复：取得目录后同一 SDK 发现 MCP 并继续同一任务", async () => {
  const mcp = await startMockMcp({ tools: [{ name: "read", result: { content: [{ type: "text", text: "MCP_RESULT" }] } }] });
  const t = await startTestRuntime("wait-resource-mcp-restore", (request, index) => {
    if (index === 0) {
      assert.ok(!toolNamesOf(request).some(name => name.startsWith("mcp_")));
      return { kind: "tool_calls", calls: [{ id: "wait", name: "wait", arguments: { targets: [{ kind: "task", task_id: "child" }] } }] };
    }
    if (index === 1) {
      assert.ok(toolNamesOf(request).includes("tool_search"));
      assert.ok(!toolNamesOf(request).includes("mcp__restored__read"));
      assert.ok(toolNamesOf(request).includes("write"));
      return { kind: "tool_calls", calls: [{ id: "discover", name: "tool_search", arguments: { query: "mcp__restored__read" } }] };
    }
    if (index === 2) {
      assert.ok(toolNamesOf(request).includes("mcp__restored__read"));
      return { kind: "tool_calls", calls: [{ id: "mcp", name: "mcp__restored__read", arguments: {} }] };
    }
    assert.match(JSON.stringify(request.messages), /MCP_RESULT/);
    return { kind: "text", text: "恢复后完成" };
  }, { config: { ...realTools(), product: codeProduct.runtime }, workDirs: 1 });
  try {
    const rt = t.runtime;
    const session = await rt.createSession({ projectName: "restore", cwd: t.work[0] });
    rt["mcp"].upsertService({ name: "restored", endpoint: mcp.url, toolAllowlist: ["read"], enabled: true });
    const driver = await rt["getDriver"](session);
    driver["deps"].agentWait = { initialPhase: () => "conversation", snapshot: () => null,
      acquireResources: async task => rt.store.withTx(() => rt.store.tryAcquireOccupancy({ taskId: task.id, sessionId: session.id,
        cwdReal: session.cwdReal, cwdDev: session.cwdDev, cwdIno: session.cwdIno })),
      wait: async (_ctx, _id, targets) => {
        assert.equal(mcp.hits.length, 0);
        return { reason: "result", targets: targets.map(target => ({ ...target, status: "completed" })) };
      } };
    const task = rt.store.withTx(() => {
      const task = rt.store.insertQueuedTask({ sessionId: session.id, requestId: "cold", input: "等待再读取", modelSelection: rt.defaultSelection, submissionDigest: "cold", accessMode: "full_access" }).task;
      rt.store.transitionTask(task.id, ["queued"], "running");
      return rt.store.getTask(task.id)!;
    });
    await driver.run(task);
    assert.equal(rt.store.getTask(task.id)?.status, "completed");
    assert.equal(mcp.hits.filter(hit => hit.rpcMethod === "tools/call").length, 1);
    assert.equal(rt.store.listSelectionRecordsByTask(task.id).length, 4);
    assert.equal(rt.store.listAllOccupancy().length, 0);
  } finally { await t.shutdown(); await mcp.close(); }
});

for (const failed of [false, true]) test(`父级注入 ${failed ? "请求失败不消费" : "成功响应后消费一次"}`, async () => {
  const t = await startTestRuntime("wait-injection-accept", request => {
    assert.match(JSON.stringify(request.messages), /RECORDED_CHILD_RESULT/);
    if (failed) throw new Error("provider_failed");
    return { kind: "text", text: "已采用子结果" };
  }, { config: { product: codeProduct.runtime }, workDirs: 1 });
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "injection", cwd: t.work[0] });
    const child = rt.store.withTx(() => rt.store.insertQueuedTask({ sessionId: session.id, requestId: "source-result", input: "子结果", modelSelection: rt.defaultSelection, submissionDigest: "child" }).task);
    rt.store.withTx(() => {
      rt.store.setTaskResult(child.id, "RECORDED_CHILD_RESULT", "{}");
      rt.store.transitionTask(child.id, ["queued"], "completed");
    });
    const driver = await rt["getDriver"](session);
    let accepted = 0, rechecked = 0;
    driver["deps"].parentInjection = () => ({ results: [rt.store.getTask(child.id)!], messages: [] });
    // 此处隔离 Driver 的消费时机，来源资格由真实 Runtime 边界用例验证。
    driver["deps"].parentInjectionRecheck = (sessionId, resultTaskIds, messageIds) => {
      assert.equal(sessionId, session.id);
      assert.deepEqual(resultTaskIds, [child.id]);
      assert.deepEqual(messageIds, []);
      rechecked++;
      return null;
    };
    driver["deps"].parentInjectionAccepted = (_taskId, ids, entryId, messageIds) => {
      assert.equal(t.server.calls.length, 1);
      assert.deepEqual(ids, [child.id]);
      assert.deepEqual(messageIds, []);
      assert.ok(entryId);
      accepted++;
    };
    const parent = await rt.submit({ sessionId: session.id, requestId: "parent", input: "使用结果", modelSelection: rt.defaultSelection });
    await waitFor("父级注入请求收尾", () => ["completed", "failed"].includes(rt.store.getTask(parent.id)!.status), 30_000);
    assert.equal(t.server.calls.length, 1);
    assert.ok(rechecked > 0);
    assert.equal(accepted, failed ? 0 : 1);
    assert.equal(rt.store.getTask(parent.id)?.status, failed ? "failed" : "completed");
  } finally { await t.shutdown(); }
});

for (const product of [codeProduct.runtime, personalProduct.runtime]) test(`汇总参考输入 ${product.type}：JSONL 可重建分组，原输入与请求摘要不改写`, async () => {
  const reportContext = { text: "[汇总依据] GROUP_FACTS：子任务 one 与工作流 two 共用一次最终总结。", reportKeys: ["task:one", "workflow:two:1"] };
  let reportTaskId = "";
  const t = await startTestRuntime("report-context-record", (request, index) => {
    if (index === 1) {
      assert.match(JSON.stringify(request.messages), /GROUP_FACTS/);
      const task = t.runtime.store.getTask(reportTaskId)!;
      assert.equal(task.input, "CANONICAL_REPORT_INPUT");
      const session = t.runtime.store.getSession(task.sessionId)!;
      const marker = parseSessionFile(session.sessionFile!).findLast(entry => entry.type === "custom" && entry.customType === "ruukoto_agent_report_context");
      assert.deepEqual(marker?.data, { taskId: reportTaskId, ...reportContext });
      assert.deepEqual(toolNamesOf(request), []);
    }
    return { kind: "text", text: index === 0 ? "来源会话" : "唯一汇总" };
  }, { config: { product }, workDirs: 1 });
  try {
    const rt = t.runtime;
    const session = product.type === "ruukoto" ? rt.store.getSession(rt.store.getAgentRole("main")!.sessionId)!
      : await rt.createSession({ projectName: "report-context", cwd: t.work[0] });
    const seed = await rt.submit({ sessionId: session.id, requestId: "seed", input: "来源会话", modelSelection: rt.defaultSelection });
    await waitFor("原会话已落盘", () => rt.store.getTask(seed.id)?.status === "completed");
    const driver = await rt["getDriver"](session);
    driver["deps"].reportContext = task => task.requestId === "report" ? reportContext : null;
    driver["deps"].allowTaskTool = () => false;
    const report = await rt.submit({ sessionId: session.id, requestId: "report", input: "CANONICAL_REPORT_INPUT", modelSelection: rt.defaultSelection });
    reportTaskId = report.id;
    const digest = rt.store.getTask(report.id)!.submissionDigest;
    await waitFor("汇总完成", () => rt.store.getTask(report.id)?.status === "completed");
    assert.equal(rt.store.getTask(report.id)?.submissionDigest, digest);
    assert.equal(rt.store.listSelectionRecordsByTask(report.id).length, 1);
  } finally { await t.shutdown(); }
});

test("汇总参考输入：JSONL marker 写入失败时不发模型请求", async context => {
  const t = await startTestRuntime("report-context-failed", () => ({ kind: "text", text: "来源会话" }), { config: { product: codeProduct.runtime }, workDirs: 1 });
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "report-failed", cwd: t.work[0] });
    const seed = await rt.submit({ sessionId: session.id, requestId: "seed", input: "来源会话", modelSelection: rt.defaultSelection });
    await waitFor("原会话已落盘", () => rt.store.getTask(seed.id)?.status === "completed");
    const driver = await rt["getDriver"](session);
    driver["deps"].reportContext = () => ({ text: "GROUP_FACTS", reportKeys: ["task:one", "task:two"] });
    const original = fs.appendFileSync;
    context.mock.method(fs, "appendFileSync", (...args: Parameters<typeof original>) => {
      if (String(args[1]).includes("ruukoto_agent_report_context")) throw new Error("模拟 marker 落盘失败");
      return Reflect.apply(original, fs, args);
    });
    syncBuiltinESMExports();
    const report = await rt.submit({ sessionId: session.id, requestId: "report", input: "原汇总输入", modelSelection: rt.defaultSelection });
    await waitFor("汇总明确失败", () => rt.store.getTask(report.id)?.status === "failed");
    assert.equal(t.server.calls.length, 1);
  } finally { context.mock.restoreAll(); syncBuiltinESMExports(); await t.shutdown(); }
});
