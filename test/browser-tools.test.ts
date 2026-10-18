import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { product as codeProduct } from "../apps/ruukoto-code/src/product.ts";
import { product as personalProduct } from "./helpers/legacy-product.ts";
import { BrowserError, BrowserManager, type BrowserBinding } from "@ruukoto/agent/browser-manager.ts";
import { browserParams, browserTaskAllowed } from "@ruukoto/agent/browser-tools.ts";
import { parseSessionFile } from "@ruukoto/core/history.ts";
import type { Task } from "@ruukoto/core/types.ts";
import { createProjectSession, startTestRuntime, taskStatus, toolNamesOf, waitFor } from "./helpers/testkit.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
function binding(sessionId: string, generation = "fixture-generation"): BrowserBinding {
  return { sessionId, generation, kind: "owned", state: "ready", profileDir: "/fixture/profile", socketDir: "/fixture/socket", cliSession: "fixture",
    cdpUrl: "ws://127.0.0.1:9222/devtools/browser/fixture", targetId: "fixture", chrome: null, daemon: null, dashboard: null,
    chromePending: false, daemonPending: false, dashboardPending: false, lockDir: null, pauseTaskId: null, pauseAfterSeq: null, outcomeUnknown: false,
    failureCode: null, dashboardUrl: null, headed: false };
}

// 替身只覆盖平台执行；真实 SDK、身份门、授权账本、JSONL 和产物仍走共享 Runtime。
function platformFixture(command: BrowserManager["command"], status: BrowserManager["status"] = sessionId => binding(sessionId)) {
  const oldCommand = BrowserManager.prototype.command, oldStatus = BrowserManager.prototype.status;
  BrowserManager.prototype.command = command;
  BrowserManager.prototype.status = status;
  return () => { BrowserManager.prototype.command = oldCommand; BrowserManager.prototype.status = oldStatus; };
}

test("browser 模型参数不能覆盖宿主管理参数，标签与等待参数保留明确范围", () => {
  assert.deepEqual(browserParams({ action: "fill", ref: "@e1", text: "--config" }), { action: "fill", ref: "@e1", text: "--config" });
  assert.deepEqual(browserParams({ action: "fill", ref: "e1", text: "--config" }), { action: "fill", ref: "@e1", text: "--config" });
  for (const params of [{ action: "start", profile: "/tmp/other" }, { action: "snapshot", url: "https://example.com" },
    { action: "click", ref: "--cdp" }, { action: "open", url: "javascript:alert(1)" }, { action: "wait", ms: -1 },
    { action: "tabs", operation: "switch" }, { action: "tabs", operation: "list", index: 1 }, { action: "screenshot", full: "true" }]) {
    assert.throws(() => browserParams(params), { code: "invalid_params" });
  }
});

for (const row of [{ product: personalProduct.runtime, main: true }, { product: personalProduct.runtime, main: false }, { product: codeProduct.runtime, main: false }]) {
  for (const supportsImages of [true, false]) {
    test(`browser 截图：${row.product.type}/${row.main ? "main" : "dev"}/${supportsImages ? "视觉" : "仅文本"} 模型与历史使用同一图片`, async () => {
      const restore = platformFixture(async (_sessionId, args) => {
        assert.equal(args[0], "screenshot"); fs.writeFileSync(args[1], PNG); return { data: { path: args[1] } };
      });
      const t = await startTestRuntime("browser-picture", req => req.messages.some(message => message.role === "tool")
        ? { kind: "text", text: "图片已读取" } : { kind: "tool_calls", calls: [{ id: "browser-shot", name: "browser", arguments: { action: "screenshot" } }] },
      { workDirs: 1, config: { product: row.product } });
      try {
        const resolve = t.runtime.modelCatalog.resolve.bind(t.runtime.modelCatalog);
        t.runtime.modelCatalog.resolve = async selection => ({ ...await resolve(selection), input: supportsImages ? ["text", "image"] : ["text"] });
        const sessionId = row.main ? t.runtime.store.getAgentRole("main")!.sessionId : (await createProjectSession(t.client, t.work[0])).sessionId;
        const task = await t.client.request<Task>("submit", { session_id: sessionId, request_id: "picture", input: "截图并看图", model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" }, access_mode: "full_access" });
        await waitFor("截图任务结束", () => ["completed", "failed"].includes(t.runtime.store.getTask(task.id)!.status), 30_000);
        const detail = await taskStatus(t.client, task.id);
        const artifact = detail.artifacts.find((entry: { name: string }) => entry.name === "browser-screenshot");
        assert.ok(artifact); assert.equal(artifact.status, "complete");
        const raw = await t.client.request<{ data: string }>("read_artifact", { task_id: task.id, artifact_id: artifact.id });
        assert.deepEqual(Buffer.from(raw.data, "base64"), PNG);
        const history = parseSessionFile(t.runtime.store.getSession(sessionId)!.sessionFile!);
        assert.ok(JSON.stringify(history).includes(PNG.toString("base64")));
        const op = t.runtime.store.listToolOpsByTask(task.id).find(op => op.toolName === "browser")!;
        assert.equal(op.authorization?.source, "full_access");
        if (supportsImages) {
          assert.equal(detail.task.status, "completed"); assert.equal(t.server.calls.length, 2);
          const images = t.server.calls[1].messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === "image_url");
          assert.deepEqual(images.map(part => part.image_url.url), [`data:image/png;base64,${PNG.toString("base64")}`]);
          const selection = t.runtime.store.listSelectionRecordsByTask(task.id)[1];
          const snapshot = await t.client.request<{ data: string }>("read_artifact", { task_id: task.id, artifact_id: selection.promptArtifactId });
          assert.ok(Buffer.from(snapshot.data, "base64").toString().includes(PNG.toString("base64")));
        } else {
          assert.equal(detail.task.status, "failed"); assert.match(detail.task.errorMessage, /image_input_unsupported/); assert.equal(t.server.calls.length, 1);
        }
      } finally { await t.shutdown(); restore(); }
    });
  }
}

for (const mode of ["confirm", "auto-review", "plan"] as const) {
  test(`browser ${mode} 伪造调用在执行意图和平台操作之前拒绝`, async () => {
    let sent = 0;
    const restore = platformFixture(async () => { sent++; return { data: {} }; });
    const t = await startTestRuntime("browser-restricted", req => req.messages.some(message => message.role === "tool")
      ? { kind: "text", text: "停止" } : { kind: "tool_calls", calls: [{ id: "forged", name: "browser", arguments: { action: "open", url: "https://example.com" } }] }, { workDirs: 1 });
    try {
      const { sessionId } = await createProjectSession(t.client, t.work[0]);
      const task = await t.client.request<Task>("submit", { session_id: sessionId, request_id: "forged", input: "尝试浏览器", model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" }, access_mode: mode });
      await waitFor("受限任务结束", () => ["completed", "failed"].includes(t.runtime.store.getTask(task.id)!.status), 30_000);
      assert.equal(sent, 0); assert.equal(t.runtime.store.listToolOpsByTask(task.id).filter(op => op.toolName === "browser").length, 0);
      assert.ok(!toolNamesOf(t.server.calls[0]).includes("browser"));
      const real = t.runtime.store.getTask(task.id)!;
      assert.equal(browserTaskAllowed(t.runtime.store, { ...real, accessMode: "full_access", parentTaskId: "other" }), false);
      assert.equal(browserTaskAllowed(t.runtime.store, { ...real, accessMode: "full_access", subAgentId: "other" }), false);
    } finally { await t.shutdown(); restore(); }
  });
}

test("browser 导航丢应答沿真实账本记效果未知，调用只发送一次", async () => {
  let sent = 0;
  const restore = platformFixture(async () => { sent++; throw new BrowserError("outcome_unknown", "测试丢应答", true); });
  const t = await startTestRuntime("browser-unknown", req => req.messages.some(message => message.role === "tool")
    ? { kind: "text", text: "结果未知，停止操作" } : { kind: "tool_calls", calls: [{ id: "once", name: "browser", arguments: { action: "open", url: "https://example.com" } }] }, { workDirs: 1 });
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]);
    const task = await t.client.request<Task>("submit", { session_id: sessionId, request_id: "once", input: "导航", model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" }, access_mode: "full_access" });
    await waitFor("未知结果任务结束", () => ["completed", "failed"].includes(t.runtime.store.getTask(task.id)!.status), 30_000);
    assert.equal(sent, 1); assert.equal(t.runtime.store.getTask(task.id)!.effectUnknown, true);
    assert.ok(t.runtime.store.listToolOpsByTask(task.id).find(op => op.toolName === "browser")!.effectUnknown);
  } finally { await t.shutdown(); restore(); }
});

for (const invalidation of ["missing", "generation"] as const) {
  test(`browser ${invalidation} 失效引用不会发送点击`, async () => {
    let generation = "first", snapshots = 0, clicks = 0, round = 0;
    const restore = platformFixture(async (_session, args) => {
      if (args[0] === "snapshot") return { data: { refs: ++snapshots === 1 ? { e1: {} } : {} } };
      clicks++; return { data: {} };
    }, session => binding(session, generation));
    const t = await startTestRuntime("browser-ref", () => {
      if (round++ === 0) return { kind: "tool_calls", calls: [{ id: "snapshot", name: "browser", arguments: { action: "snapshot" } }] };
      if (round === 2) {
        if (invalidation === "generation") generation = "second";
        return { kind: "tool_calls", calls: [{ id: "click", name: "browser", arguments: { action: "click", ref: "@e1" } }] };
      }
      return { kind: "text", text: "引用失效，停止" };
    }, { workDirs: 1 });
    try {
      const { sessionId } = await createProjectSession(t.client, t.work[0]);
      const task = await t.client.request<Task>("submit", { session_id: sessionId, request_id: "ref", input: "点击", access_mode: "full_access", model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" } });
      await waitFor("引用任务结束", () => ["completed", "failed"].includes(t.runtime.store.getTask(task.id)!.status));
      assert.equal(clicks, 0); assert.equal(snapshots, invalidation === "generation" ? 1 : 2);
      assert.ok(JSON.stringify(t.server.calls.at(-1)).includes("stale_ref"));
      assert.equal(t.runtime.store.getTask(task.id)!.effectUnknown, false);
    } finally { await t.shutdown(); restore(); }
  });
}

for (const failure of ["large", "invalid", "write"] as const) {
  test(`browser 截图 ${failure} 失败不发送图片或伪造完整产物`, async () => {
    const restore = platformFixture(async (_session, args) => {
      fs.writeFileSync(args[1], failure === "large" ? Buffer.alloc(8 * 1024 * 1024 + 1) : failure === "invalid" ? Buffer.from("not-an-image") : PNG);
      return { data: {} };
    });
    const t = await startTestRuntime("browser-picture-fail", req => req.messages.some(message => message.role === "tool") ? { kind: "text", text: "截图失败" }
      : { kind: "tool_calls", calls: [{ id: "shot", name: "browser", arguments: { action: "screenshot" } }] }, { workDirs: 1 });
    try {
      if (failure === "write") {
        fs.mkdirSync(path.join(t.dirs.dataDir, "browser"), { recursive: true });
        fs.writeFileSync(path.join(t.dirs.dataDir, "browser", "screenshots"), "block");
      }
      const { sessionId } = await createProjectSession(t.client, t.work[0]);
      const task = await t.client.request<Task>("submit", { session_id: sessionId, request_id: "shot", input: "截图", access_mode: "full_access", model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" } });
      await waitFor("截图失败任务结束", () => ["completed", "failed"].includes(t.runtime.store.getTask(task.id)!.status));
      const detail = await taskStatus(t.client, task.id);
      assert.ok(!detail.artifacts.some((artifact: { name: string }) => artifact.name === "browser-screenshot"));
      const request = JSON.stringify(t.server.calls.at(-1));
      assert.ok(request.includes(failure === "large" ? "image_too_large" : failure === "invalid" ? "invalid_image" : "artifact_write_failed"));
      assert.ok(!request.includes("image_url"));
    } finally { await t.shutdown(); restore(); }
  });
}

test("browser 模式切换在动作边界先核实关闭，再删除工具且拒绝旧响应中的调用", async () => {
  let sent = 0, closed = 0, release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const restore = platformFixture(async () => { sent++; return { data: {} }; });
  const oldClose = BrowserManager.prototype.close;
  BrowserManager.prototype.close = async () => { closed++; return true; };
  const t = await startTestRuntime("browser-mode-switch", async (_req, index) => {
    if (index === 0) { await hold; return { kind: "tool_calls", calls: [{ id: "old-mode", name: "browser", arguments: { action: "open", url: "https://example.com" } }] }; }
    return { kind: "text", text: "权限已收窄" };
  }, { workDirs: 1 });
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]);
    const task = await t.client.request<Task>("submit", { session_id: sessionId, request_id: "switch", input: "导航", access_mode: "full_access", model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" } });
    await waitFor("浏览器模型请求进入", () => t.server.calls.length === 1);
    await t.client.request("switch_mode", { task_id: task.id, mode: "confirm" }); release();
    await waitFor("切换任务结束", () => ["completed", "failed", "interrupted"].includes(t.runtime.store.getTask(task.id)!.status));
    assert.equal(sent, 0); assert.equal(closed, 1);
    assert.equal(t.runtime.store.getTask(task.id)!.accessMode, "confirm");
    assert.equal(t.runtime.store.listToolOpsByTask(task.id).filter(op => op.toolName === "browser").length, 0);
    assert.ok(!toolNamesOf(t.server.calls.at(-1)!).includes("browser"));
  } finally { release(); await t.shutdown(); BrowserManager.prototype.close = oldClose; restore(); }
});

test("browser 在途取消核实关闭并保留未知效果，不发送第二次", async () => {
  let sent = 0, closed = 0;
  const restore = platformFixture(async (_session, _args, signal) => {
    sent++;
    return await new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new BrowserError("outcome_unknown", "已发出动作取消", true)), { once: true }));
  });
  const oldClose = BrowserManager.prototype.close;
  BrowserManager.prototype.close = async () => { closed++; return true; };
  const t = await startTestRuntime("browser-cancel", () => ({ kind: "tool_calls", calls: [{ id: "inflight", name: "browser", arguments: { action: "open", url: "https://example.com" } }] }), { workDirs: 1 });
  try {
    // 直接导航避免元素预读；取消发生在真实执行意图和授权已提交之后。
    const { sessionId } = await createProjectSession(t.client, t.work[0]);
    const task = await t.client.request<Task>("submit", { session_id: sessionId, request_id: "cancel", input: "导航", access_mode: "full_access", model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" } });
    await waitFor("浏览器动作已发送", () => sent === 1);
    await t.client.request("cancel", { task_id: task.id });
    await waitFor("取消任务结束", () => ["canceled", "interrupted"].includes(t.runtime.store.getTask(task.id)!.status));
    assert.equal(sent, 1); assert.equal(closed, 1); assert.equal(t.server.calls.length, 1);
    assert.equal(t.runtime.store.getTask(task.id)!.effectUnknown, true);
  } finally { await t.shutdown(); BrowserManager.prototype.close = oldClose; restore(); }
});

test("browser 排队任务的模式切换不关闭同会话活动任务的浏览器", async () => {
  let closed = 0, release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const oldClose = BrowserManager.prototype.close;
  BrowserManager.prototype.close = async () => { closed++; return true; };
  const t = await startTestRuntime("browser-queued-mode", async (_req, index) => {
    if (index === 0) await hold;
    return { kind: "text", text: "完成" };
  }, { workDirs: 1 });
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]);
    const input = { session_id: sessionId, input: "任务", access_mode: "full_access", model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" } };
    const active = await t.client.request<Task>("submit", { ...input, request_id: "active" });
    await waitFor("活动模型请求", () => t.server.calls.length === 1);
    const queued = await t.client.request<Task>("submit", { ...input, request_id: "queued" });
    assert.equal(queued.status, "queued");
    await t.client.request("switch_mode", { task_id: queued.id, mode: "confirm" });
    assert.equal(closed, 0); assert.equal(t.runtime.store.getTask(active.id)!.status, "running");
    release();
    await waitFor("两个任务完成", () => [active, queued].every(task => t.runtime.store.getTask(task.id)!.status === "completed"));
  } finally { release(); await t.shutdown(); BrowserManager.prototype.close = oldClose; }
});

test("browser 等待审批时切到完全访问立即激活，下一模型请求与执行门一致", async () => {
  let sent = 0;
  const restore = platformFixture(async () => { sent++; return { data: {} }; });
  const t = await startTestRuntime("browser-awaiting-mode", (_req, index) => index === 0
    ? { kind: "tool_calls", calls: [{ id: "gate", name: "mock_gate", arguments: { note: "等待" } }] }
    : index === 1 ? { kind: "tool_calls", calls: [{ id: "enabled", name: "browser", arguments: { action: "open", url: "https://example.com" } }] }
    : { kind: "text", text: "完成" }, { workDirs: 1 });
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0], { confirmTools: ["mock_gate"] });
    const task = await t.client.request<Task>("submit", { session_id: sessionId, request_id: "upgrade", input: "导航", access_mode: "confirm", model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" } });
    await waitFor("任务等待审批", () => t.runtime.store.getTask(task.id)!.status === "awaiting_confirmation");
    await t.client.request("switch_mode", { task_id: task.id, mode: "full_access" });
    await waitFor("升权任务完成", () => t.runtime.store.getTask(task.id)!.status === "completed");
    assert.equal(sent, 1); assert.ok(toolNamesOf(t.server.calls[1]).includes("browser"));
    const authorization = t.runtime.store.listToolOpsByTask(task.id).find(op => op.toolName === "browser")!.authorization;
    assert.equal(authorization?.source, "full_access"); assert.equal(authorization?.permissionVersion, 2);
  } finally { await t.shutdown(); restore(); }
});

test("browser 人工暂停前已接受的排队输入不能 resume，之后的新消息才可恢复", async () => {
  let current: BrowserBinding, resumed = 0, release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const restore = platformFixture(async () => ({ data: {} }), () => structuredClone(current));
  const oldPause = BrowserManager.prototype.pause, oldResume = BrowserManager.prototype.resume;
  BrowserManager.prototype.pause = async (_session, taskId, afterSeq) => { current.state = "paused"; current.pauseTaskId = taskId; current.pauseAfterSeq = afterSeq!; return structuredClone(current); };
  BrowserManager.prototype.resume = async () => { resumed++; current.state = "ready"; current.generation = "after-manual"; return structuredClone(current); };
  const t = await startTestRuntime("browser-pause-barrier", async (_req, index) => {
    if (index === 0) { await hold; return { kind: "tool_calls", calls: [{ id: "pause", name: "browser", arguments: { action: "pause" } }] }; }
    if (index === 2 || index === 4) return { kind: "tool_calls", calls: [{ id: `resume-${index}`, name: "browser", arguments: { action: "resume" } }] };
    return { kind: "text", text: "完成" };
  }, { workDirs: 1 });
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]); current = binding(sessionId);
    const input = { session_id: sessionId, input: "人工操作", access_mode: "full_access", model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" } };
    const first = await t.client.request<Task>("submit", { ...input, request_id: "pause" });
    await waitFor("暂停请求在途", () => t.server.calls.length === 1);
    const queued = await t.client.request<Task>("submit", { ...input, request_id: "before-pause" }); release();
    await waitFor("先前排队任务完成", () => t.runtime.store.getTask(queued.id)!.status === "completed");
    assert.equal(resumed, 0); assert.equal(current.state, "paused");
    assert.ok(t.runtime.store.getTaskInputSeq(queued)! <= current.pauseAfterSeq!);
    assert.ok(JSON.stringify(t.server.calls[3]).includes("browser_paused"));
    const later = await t.client.request<Task>("submit", { ...input, request_id: "after-pause" });
    await waitFor("新消息任务完成", () => t.runtime.store.getTask(later.id)!.status === "completed");
    assert.equal(resumed, 1); assert.equal(current.state, "ready");
    assert.ok(t.runtime.store.getTaskInputSeq(later)! > current.pauseAfterSeq!);
    const event = t.runtime.store.withTx(() => t.runtime.store.registerInboundEvent({ source: "telegram", externalId: "synthetic", actor: "owner", targetRole: "main", body: "消息" })).event;
    const messageSeq = t.runtime.store.getMaxSeq();
    t.runtime.store.withTx(() => t.runtime.store.appendEvent({ type: "task.started", taskId: first.id, sessionId }, { taskId: first.id, sessionId }));
    assert.equal(t.runtime.store.getTaskInputSeq({ id: later.id, sourceEventId: event.id }), messageSeq);
    assert.equal(t.runtime.store.getTaskInputSeq({ id: later.id, sourceEventId: "missing" }), null);
  } finally { release(); await t.shutdown(); BrowserManager.prototype.pause = oldPause; BrowserManager.prototype.resume = oldResume; restore(); }
});

test("browser 失败后人工等待的保存失败不掩盖原未知效果报告", async () => {
  const restore = platformFixture(async () => { throw new BrowserError("outcome_unknown", "原动作结果未知", true); }, session => ({ ...binding(session), state: "unavailable" }));
  const oldPause = BrowserManager.prototype.pause;
  BrowserManager.prototype.pause = async () => { throw new BrowserError("browser_state_unavailable", "存储失败"); };
  const t = await startTestRuntime("browser-unknown-storage", req => req.messages.some(message => message.role === "tool") ? { kind: "text", text: "人工核实" }
    : { kind: "tool_calls", calls: [{ id: "unknown", name: "browser", arguments: { action: "open", url: "https://example.com" } }] }, { workDirs: 1 });
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]);
    const task = await t.client.request<Task>("submit", { session_id: sessionId, request_id: "storage", input: "导航", access_mode: "full_access", model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" } });
    await waitFor("未知效果任务完成", () => t.runtime.store.getTask(task.id)!.status === "completed");
    assert.equal(t.runtime.store.getTask(task.id)!.effectUnknown, true); assert.ok(JSON.stringify(t.server.calls[1]).includes("outcome_unknown"));
  } finally { await t.shutdown(); BrowserManager.prototype.pause = oldPause; restore(); }
});
