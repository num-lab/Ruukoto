/** 手动压缩使用真实后台、SQLite、JSONL 与控制连接；仅摘要 provider 是模拟服务。 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { test } from "node:test";
import { product } from "../apps/ruukoto-code/src/product.ts";
import { configRevision, saveSummaryModel } from "@ruukoto/agent/model-config.ts";
import { parseSessionFile } from "@ruukoto/core/history.ts";
import { reserveCompactionRequest } from "@ruukoto/core/compaction.ts";
import { TASK_END_MARKER, TASK_START_MARKER, type Session, type SessionCompactionRequest } from "@ruukoto/core/types.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { ControlServer } from "@ruukoto/control/server.ts";
import { ControlClient } from "@ruukoto/control/client.ts";
import { authenticateClient, connectAuthedClient, inputText, startTestRuntime, waitFor, type TestRuntime } from "./helpers/testkit.ts";
import type { Responder } from "./helpers/mock-provider.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function history(t: TestRuntime, session: Session) {
  const file = path.join(t.dirs.dataDir, "sessions", `manual_${session.piSessionId}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: session.piSessionId, timestamp: new Date().toISOString(), cwd: session.cwdReal })}\n`);
  t.runtime.store.setSessionFile(session.id, file);
  const task = t.runtime.store.withTx(() => {
    const task = t.runtime.store.insertQueuedTask({ sessionId: session.id, requestId: randomUUID(), input: "完成的长任务", modelSelection: t.runtime.defaultSelection, submissionDigest: randomUUID() }).task;
    t.runtime.store.endTask(task.id, ["queued"], "completed");
    return task;
  });
  let parentId: string | null = null;
  const entry = (value: Record<string, unknown>) => {
    const id = randomUUID().slice(0, 8);
    fs.appendFileSync(file, `${JSON.stringify({ ...value, id, parentId, timestamp: new Date().toISOString() })}\n`);
    parentId = id;
  };
  entry({ type: "custom", customType: TASK_START_MARKER, data: { taskId: task.id } });
  entry({ type: "message", message: { role: "user", content: "拥有者要求：保留迁移细节", timestamp: Date.now() } });
  for (let i = 0; i < 3; i++) {
    entry({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: `batch${i}`, name: "mock_delay", arguments: { ms: 1 } }], timestamp: Date.now(), api: "openai-completions", provider: "mock", model: "mock-model", usage, stopReason: "toolUse" } });
    entry({ type: "message", message: { role: "toolResult", toolCallId: `batch${i}`, toolName: "mock_delay", content: [{ type: "text", text: `阶段${i}结果`.repeat(100) }], isError: false, timestamp: Date.now() } });
  }
  entry({ type: "custom", customType: TASK_END_MARKER, data: { taskId: task.id } });
  return file;
}

async function fixture(prefix: string, respond: Responder = async req => ({ kind: "text", text: req.tools?.length ? "主任务完成" : "结构化摘要：迁移已确认，下一步验证。" }), config: Parameters<typeof startTestRuntime>[2] = {}) {
  const t = await startTestRuntime(prefix, respond, { ...config, config: { product: product.runtime, ...config.config } });
  const session = (await t.runtime.openWorkspace({ cwd: t.work[0]! })).session;
  const file = history(t, session);
  return { t, session, file };
}

async function finished(t: TestRuntime, sessionId: string, requestId: string) {
  await waitFor("手动压缩终态", () => t.runtime.getSessionCompaction({ sessionId, requestId })?.status !== "running");
  return t.runtime.getSessionCompaction({ sessionId, requestId })!;
}

test("低水位长任务主动摘要：同键只调用一次，prompt 单次生效，JSONL 不变且下一任务使用手动点", async () => {
  const { t, session, file } = await fixture("manual-success");
  try {
    const bytes = fs.readFileSync(file);
    const taskCount = t.runtime.store.listTasksBySession(session.id).length;
    const params = { session_id: session.id, request_id: "compact-one", prompt: "  迁移 细节\n保留  两个空格  " };
    const [a, b] = await Promise.all([t.client.request<SessionCompactionRequest>("compact_session", params), t.client.request<SessionCompactionRequest>("compact_session", params)]);
    assert.equal(a.requestId, b.requestId);
    const result = await finished(t, session.id, a.requestId);
    assert.equal(result.status, "succeeded");
    assert.equal(t.server.calls.length, 1);
    assert.ok(inputText(t.server.calls[0]!).includes("迁移 细节\n保留  两个空格"));
    const cp = t.runtime.store.getActiveCheckpoint(session.id)!;
    assert.equal(cp.summarizedCount, 5, "最后完整工具批次整批保留");
    assert.equal(cp.manualRequestId, a.requestId);
    assert.equal(cp.taskId, null); assert.equal(cp.callIndex, null);
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(t.runtime.store.listTasksBySession(session.id).length, taskCount);
    assert.equal(t.runtime.store.db.prepare("SELECT COUNT(*) AS n FROM tool_ops").get()!.n, 0);
    assert.equal(t.runtime.store.db.prepare("SELECT COUNT(*) AS n FROM work_delegations").get()!.n, 0);
    await assert.rejects(() => t.runtime.compactSession({ sessionId: session.id, requestId: a.requestId, prompt: "不同" }), (e: { code?: string }) => e.code === "request_conflict");
    const noop = await t.runtime.compactSession({ sessionId: session.id, requestId: "repeat", prompt: " \n " });
    assert.equal((await finished(t, session.id, noop.requestId)).status, "noop");
    assert.equal(t.server.calls.length, 1);
    await t.runtime.compactSession({ sessionId: session.id, requestId: "refocus", prompt: "只保留验证重点" });
    assert.equal((await finished(t, session.id, "refocus")).status, "succeeded");
    assert.equal(t.server.calls.length, 2);
    assert.match(inputText(t.server.calls[1]!), /结构化摘要/);
    assert.doesNotMatch(inputText(t.server.calls[1]!), /阶段0结果/);
    assert.equal(t.runtime.store.getActiveCheckpoint(session.id)!.summarizedCount, cp.summarizedCount);
    const task = await t.runtime.submit({ sessionId: session.id, requestId: "after", input: "继续验证", modelSelection: t.runtime.defaultSelection });
    await waitFor("下一任务完成", () => t.runtime.store.getTask(task.id)!.status === "completed");
    const sent = t.server.calls.at(-1)!;
    assert.match(inputText(sent), /压缩摘要/);
    assert.doesNotMatch(inputText(sent), /只保留验证重点|迁移 细节/);
    const record = t.runtime.store.db.prepare("SELECT id FROM selection_records WHERE task_id = ?").get(task.id)!;
    assert.equal(t.runtime.getContextBreakdown({ sessionId: session.id, recordId: record.id as string }).checkpoint!.manualRequestId, "refocus");
  } finally { await t.shutdown(); }
});

test("摘要占用与取消：新提交、继续、配置与另一压缩被拒，其他会话和只读分支仍可用", async () => {
  let release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const { t, session, file } = await fixture("manual-busy", async req => {
    if (!req.tools?.length) await paused;
    return { kind: "text", text: "摘要或主回复" };
  });
  try {
    const bytes = fs.readFileSync(file);
    const accepted = await t.runtime.compactSession({ sessionId: session.id, requestId: "cancel" });
    await waitFor("摘要正在请求", () => t.server.calls.length === 1);
    await assert.rejects(() => t.runtime.submit({ sessionId: session.id, requestId: "new", input: "待保留草稿", modelSelection: t.runtime.defaultSelection }), (e: { code?: string }) => e.code === "session_compaction_busy");
    await assert.rejects(() => t.runtime.compactSession({ sessionId: session.id, requestId: "another" }), (e: { code?: string }) => e.code === "session_compaction_busy");
    await assert.rejects(() => t.runtime.models.setApiKey({ provider: "mock", apiKey: "new-key", expectedRevision: configRevision(t.dirs.agentDir) }), (e: { code?: string }) => e.code === "model_config_blocked");
    const branch = await t.runtime.branchSession({ sessionId: session.id, requestId: "branch-during" });
    assert.equal(t.runtime.store.getActiveCheckpoint(branch.id), null);
    const other = (await t.runtime.openWorkspace({ cwd: t.work[1]! })).session;
    const task = await t.runtime.submit({ sessionId: other.id, requestId: "other", input: "其他会话", modelSelection: t.runtime.defaultSelection });
    await waitFor("其他会话正常完成", () => t.runtime.store.getTask(task.id)!.status === "completed");
    const result = t.runtime.interruptSessionCompaction({ sessionId: session.id, requestId: accepted.requestId });
    assert.equal(result.status, "cancelled");
    release();
    await finished(t, session.id, accepted.requestId);
    assert.equal(t.runtime.store.getActiveCheckpoint(session.id), null);
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.throws(() => t.runtime.getSessionCompaction({ sessionId: other.id, requestId: accepted.requestId }), (e: { code?: string }) => e.code === "request_conflict");
  } finally { release(); await t.shutdown(); }
});

test("接收先占会话，覆盖提交解析窗口与任务启动窗口；无历史无需模型，身份由后台拒绝", async () => {
  const { t, session } = await fixture("manual-race");
  try {
    const resolve = t.runtime.models.current.modelCatalog.resolve.bind(t.runtime.models.current.modelCatalog);
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    t.runtime.models.current.modelCatalog.resolve = async selection => { await gate; return resolve(selection); };
    const submitting = t.runtime.submit({ sessionId: session.id, requestId: "race-task", input: "提交先进入解析", modelSelection: t.runtime.defaultSelection });
    const compact = await t.runtime.compactSession({ sessionId: session.id, requestId: "race-compact" });
    release();
    await assert.rejects(() => submitting, (e: { code?: string }) => e.code === "session_compaction_busy");
    assert.equal((await finished(t, session.id, compact.requestId)).status, "succeeded");
    t.runtime.models.current.modelCatalog.resolve = resolve;
    const fresh = (await t.runtime.openWorkspace({ cwd: t.work[1]! })).session;
    const before = t.server.calls.length;
    await t.runtime.compactSession({ sessionId: fresh.id, requestId: "empty" });
    assert.equal((await finished(t, fresh.id, "empty")).status, "noop");
    assert.equal(t.server.calls.length, before);
    const task = await t.runtime.submit({ sessionId: fresh.id, requestId: "queued", input: "任务正在启动", modelSelection: t.runtime.defaultSelection });
    await assert.rejects(() => t.runtime.compactSession({ sessionId: fresh.id, requestId: "busy" }), (e: { code?: string }) => e.code === "session_busy");
    await waitFor("任务结束", () => t.runtime.store.getTask(task.id)!.status === "completed");
    const main = t.runtime.store.getAgentRole("main")!;
    await assert.rejects(() => t.runtime.compactSession({ sessionId: main.sessionId, requestId: "main" }), (e: { code?: string }) => e.code === "invalid_state");
  } finally { await t.shutdown(); }
  const personal = await startTestRuntime("manual-personal", async () => ({ kind: "text", text: "回复" }));
  try {
    const session = (await personal.runtime.createSession({ projectName: "项目", cwd: personal.work[0]! }));
    await assert.rejects(() => personal.runtime.compactSession({ sessionId: session.id, requestId: "unsupported" }), (e: { code?: string }) => e.code === "unavailable");
  } finally { await personal.shutdown(); }
});

test("失败和提交冲突保留原点，坏行及部分尾不修复；已失效旧点明确作废", async () => {
  let mode: "ok" | "empty" | "limit" | "error" = "ok";
  const { t, session, file } = await fixture("manual-failures", async () => {
    if (mode === "error") throw new Error("摘要请求私密正文");
    return { kind: "text", text: mode === "empty" ? "" : "摘要", finishReason: mode === "limit" ? "length" : "stop" };
  });
  try {
    await t.runtime.compactSession({ sessionId: session.id, requestId: "first" });
    assert.equal((await finished(t, session.id, "first")).status, "succeeded");
    const old = t.runtime.store.getActiveCheckpoint(session.id)!;
    for (const [requestId, failureMode, code] of [["empty", "empty", "summary_empty"], ["limit", "limit", "summary_output_limit"], ["error", "error", "summary_failed"]] as const) {
      mode = failureMode;
      await t.runtime.compactSession({ sessionId: session.id, requestId, prompt: "重新摘要" });
      const result = await finished(t, session.id, requestId);
      assert.equal(result.status, "failed"); assert.equal(result.errorCode, code);
      assert.doesNotMatch(result.errorMessage!, /私密正文/);
      assert.equal(t.runtime.store.getActiveCheckpoint(session.id)!.id, old.id);
    }
    mode = "ok";
    const insert = t.runtime.store.insertCheckpoint.bind(t.runtime.store);
    t.runtime.store.insertCheckpoint = () => { throw new Error("模拟提交失败"); };
    await t.runtime.compactSession({ sessionId: session.id, requestId: "commit-fail", prompt: "重写" });
    assert.equal((await finished(t, session.id, "commit-fail")).status, "failed");
    t.runtime.store.insertCheckpoint = insert;
    assert.equal(t.runtime.store.getActiveCheckpoint(session.id)!.id, old.id);
    const good = fs.readFileSync(file);
    for (const [key, tail] of [["partial", '{"type":"message"'], ["bad-line", "not-json\n"]]) {
      fs.writeFileSync(file, Buffer.concat([good, Buffer.from(tail)]));
      const broken = fs.readFileSync(file);
      await t.runtime.compactSession({ sessionId: session.id, requestId: key });
      assert.equal((await finished(t, session.id, key)).errorCode, "history_corrupt");
      assert.deepEqual(fs.readFileSync(file), broken);
      assert.equal(t.runtime.store.getActiveCheckpoint(session.id)!.id, old.id);
    }
    fs.writeFileSync(file, good);
    t.runtime.store.db.prepare("UPDATE context_checkpoints SET fingerprint = 'invalid' WHERE id = ?").run(old.id);
    await t.runtime.compactSession({ sessionId: session.id, requestId: "invalid" });
    assert.equal((await finished(t, session.id, "invalid")).errorCode, "checkpoint_invalid");
    assert.equal(t.runtime.store.getActiveCheckpoint(session.id), null);
  } finally { await t.shutdown(); }
});

test("超时/模型不可用终态保留原历史；源文件变化不提交", async () => {
  let slow = true;
  const { t, session, file } = await fixture("manual-timeout", async () => {
    if (slow) await new Promise(resolve => setTimeout(resolve, 120));
    return { kind: "text", text: "摘要" };
  }, { config: { compaction: { summaryTimeoutMs: 40 } } });
  try {
    const bytes = fs.readFileSync(file);
    await t.runtime.compactSession({ sessionId: session.id, requestId: "timeout" });
    assert.equal((await finished(t, session.id, "timeout")).errorCode, "summary_timeout");
    assert.equal(t.runtime.store.getActiveCheckpoint(session.id), null);
    saveSummaryModel(t.dirs.agentDir, { provider: "missing", modelId: "missing" });
    await t.runtime.compactSession({ sessionId: session.id, requestId: "missing" });
    assert.equal((await finished(t, session.id, "missing")).errorCode, "model_not_found");
    saveSummaryModel(t.dirs.agentDir, null);
    slow = false;
    const original = t.runtime.models.current.modelCatalog.resolve.bind(t.runtime.models.current.modelCatalog);
    t.runtime.models.current.modelCatalog.resolve = async selection => {
      fs.appendFileSync(file, "\n");
      return original(selection);
    };
    await t.runtime.compactSession({ sessionId: session.id, requestId: "changed" });
    assert.equal((await finished(t, session.id, "changed")).errorCode, "source_changed");
    assert.equal(t.runtime.store.getActiveCheckpoint(session.id), null);
    assert.deepEqual(fs.readFileSync(file).subarray(0, bytes.length), bytes);
  } finally { await t.shutdown(); }
});

test("断线与重启核实原结果，遗留在途中断不重调；取消旧请求不能取消新请求", async () => {
  const { t, session } = await fixture("manual-restart");
  let restarted: Runtime | null = null;
  try {
    await t.runtime.compactSession({ sessionId: session.id, requestId: "committed" });
    const result = await finished(t, session.id, "committed");
    t.client.close();
    const second = await connectAuthedClient(t.runtime);
    const found = await second.request<SessionCompactionRequest>("get_session_compaction", { session_id: session.id, request_id: "committed" });
    assert.deepEqual(found, result);
    second.close();
    const pending: SessionCompactionRequest = { ...result, requestId: "crashed", paramsDigest: "original", status: "running", checkpointId: null, source: null, endedAt: null };
    t.runtime.store.withTx(() => reserveCompactionRequest(t.runtime.store, pending));
    await t.runtime.stop("test_restart");
    t.runtime = restarted = await Runtime.start({ ...t.runtime.config });
    await ControlServer.start(t.runtime);
    const calls = t.server.calls.length;
    assert.equal(t.runtime.getSessionCompaction({ sessionId: session.id, requestId: "crashed" })!.status, "interrupted");
    assert.equal(t.runtime.getSessionCompaction({ sessionId: session.id, requestId: "committed" })!.status, "succeeded");
    assert.equal(t.runtime.store.getActiveCheckpoint(session.id)!.manualRequestId, "committed");
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(t.server.calls.length, calls);
    const next = await t.runtime.compactSession({ sessionId: session.id, requestId: "next", prompt: "新重点" });
    assert.equal(t.runtime.interruptSessionCompaction({ sessionId: session.id, requestId: "committed" }).status, "succeeded");
    assert.equal((await finished(t, session.id, next.requestId)).status, "succeeded");
    assert.ok(parseSessionFile(t.runtime.store.getSession(session.id)!.sessionFile!).length > 0);
  } finally { await restarted?.stop("test_end"); await t.shutdown(); }
});

test("接收与完成的广播抛错后仍核实原事务，只执行一次摘要且不留下在途孤儿", async () => {
  const { t, session } = await fixture("manual-committed-broadcast");
  const committed = t.runtime.store.onCommitted;
  try {
    t.runtime.store.onCommitted = events => {
      committed?.(events);
      if (events.some(event => event.body.type === "session.context_compaction")) throw new Error("提交后广播故障");
    };
    const accepted = await t.runtime.compactSession({ sessionId: session.id, requestId: "lost-notification" });
    assert.equal((await finished(t, session.id, accepted.requestId)).status, "succeeded");
    assert.equal(t.server.calls.length, 1);
    assert.equal((await t.runtime.compactSession({ sessionId: session.id, requestId: accepted.requestId })).status, "succeeded");
    assert.equal(t.runtime.store.getActiveCheckpoint(session.id)!.manualRequestId, accepted.requestId);
    assert.equal(t.server.calls.length, 1);
  } finally { t.runtime.store.onCommitted = committed; await t.shutdown(); }
});

test("无消息也先核实 header 身份；已有点的历史消失明确失败并作废，不误报无需压缩", async () => {
  const { t, session, file } = await fixture("manual-empty-header");
  try {
    const bytes = fs.readFileSync(file);
    const header = JSON.parse(bytes.subarray(0, bytes.indexOf(10)).toString()) as Record<string, unknown>;
    fs.writeFileSync(file, `${JSON.stringify({ ...header, id: "foreign-session" })}\n`);
    await t.runtime.compactSession({ sessionId: session.id, requestId: "foreign-header" });
    assert.equal((await finished(t, session.id, "foreign-header")).errorCode, "history_corrupt");
    assert.equal(t.server.calls.length, 0);
    fs.writeFileSync(file, bytes);
    await t.runtime.compactSession({ sessionId: session.id, requestId: "original-point" });
    assert.equal((await finished(t, session.id, "original-point")).status, "succeeded");
    fs.writeFileSync(file, `${JSON.stringify(header)}\n`);
    await t.runtime.compactSession({ sessionId: session.id, requestId: "lost-messages" });
    assert.equal((await finished(t, session.id, "lost-messages")).errorCode, "checkpoint_invalid");
    assert.equal(t.runtime.store.getActiveCheckpoint(session.id), null);
    assert.equal(t.server.calls.length, 1);
    fs.writeFileSync(file, bytes);
    await t.runtime.compactSession({ sessionId: session.id, requestId: "restored-point" });
    assert.equal((await finished(t, session.id, "restored-point")).status, "succeeded");
    t.runtime.store.db.prepare("UPDATE sessions SET session_file = NULL WHERE id = ?").run(session.id);
    await t.runtime.compactSession({ sessionId: session.id, requestId: "missing-file-record" });
    assert.equal((await finished(t, session.id, "missing-file-record")).errorCode, "checkpoint_invalid");
    assert.equal(t.runtime.store.getActiveCheckpoint(session.id), null);
  } finally { await t.shutdown(); }
});

test("摘要底层结果尚未收尾时保持会话与 provider 占用，后台等待后才关库", async () => {
  const { t, session, file } = await fixture("manual-stop-settle");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const streamSimple = t.runtime.models.current.modelRuntime.streamSimple.bind(t.runtime.models.current.modelRuntime);
  const close = t.runtime.store.db.close.bind(t.runtime.store.db);
  let awaitingResult = false;
  let closed = false;
  let summarySignal: AbortSignal | undefined;
  t.runtime.models.current.modelRuntime.streamSimple = (model, context, options) => {
    summarySignal = options?.signal;
    const stream = streamSimple(model, context, options);
    const result = stream.result.bind(stream);
    stream.result = async () => {
      const response = await result();
      awaitingResult = true;
      await gate;
      return response;
    };
    return stream;
  };
  t.runtime.store.db.close = () => { closed = true; close(); };
  try {
    const bytes = fs.readFileSync(file);
    await t.runtime.compactSession({ sessionId: session.id, requestId: "cancel-and-settle" });
    await waitFor("摘要模型结果等待收尾", () => awaitingResult);
    const committed = t.runtime.store.onCommitted;
    t.runtime.store.onCommitted = events => {
      committed?.(events);
      if (events.some(event => event.body.type === "session.context_compaction" && event.body.status === "cancelled")) throw new Error("取消已提交但广播失败");
    };
    try { assert.equal(t.runtime.interruptSessionCompaction({ sessionId: session.id, requestId: "cancel-and-settle" }).status, "cancelled"); }
    finally { t.runtime.store.onCommitted = committed; }
    assert.equal(summarySignal?.aborted, true, "取消应答丢失仍须中止底层摘要请求");
    await assert.rejects(() => t.runtime.submit({ sessionId: session.id, requestId: "before-settle", input: "等待收尾", modelSelection: t.runtime.defaultSelection }), (e: { code?: string }) => e.code === "session_compaction_busy");
    await assert.rejects(() => t.runtime.models.setApiKey({ provider: "mock", apiKey: "replacement", expectedRevision: configRevision(t.dirs.agentDir) }), (e: { code?: string }) => e.code === "model_config_blocked");
    let stopped = false;
    const stopping = t.runtime.stop("test_compaction_settle").then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false);
    assert.equal(closed, false);
    assert.equal(t.runtime.getSessionCompaction({ sessionId: session.id, requestId: "cancel-and-settle" })!.status, "cancelled");
    release();
    await stopping;
    assert.equal(closed, true);
    assert.equal(t.server.calls.length, 1);
    assert.deepEqual(fs.readFileSync(file), bytes);
  } finally { release(); await t.shutdown(); }
});

test("排队、运行、等待确认及暂停队列均拒绝压缩，不创建回执或模型请求", async () => {
  const { t, session } = await fixture("manual-busy-states");
  try {
    for (const status of ["queued", "running", "awaiting_confirmation", "paused-queued"] as const) {
      const task = t.runtime.store.withTx(() => {
        const task = t.runtime.store.insertQueuedTask({ sessionId: session.id, requestId: randomUUID(), input: "已有任务", modelSelection: t.runtime.defaultSelection, submissionDigest: randomUUID() }).task;
        if (status === "paused-queued") t.runtime.store.setSessionQueueState(session.id, "paused", "owner");
        else if (status !== "queued") t.runtime.store.transitionTask(task.id, ["queued"], status);
        return task;
      });
      await assert.rejects(() => t.runtime.compactSession({ sessionId: session.id, requestId: `busy-${status}` }), (e: { code?: string }) => e.code === "session_busy");
      assert.equal(t.runtime.getSessionCompaction({ sessionId: session.id, requestId: `busy-${status}` }), null);
      t.runtime.store.withTx(() => {
        t.runtime.store.endTask(task.id, ["queued", "running", "awaiting_confirmation"], "interrupted");
        t.runtime.store.setSessionQueueState(session.id, "active", null);
      });
    }
    assert.equal(t.server.calls.length, 0);
  } finally { await t.shutdown(); }
});

test("没有新增覆盖时无需解析不可用摘要模型；有指引需要摘要时明确失败", async () => {
  const { t, session } = await fixture("manual-noop-model");
  try {
    await t.runtime.compactSession({ sessionId: session.id, requestId: "original" });
    assert.equal((await finished(t, session.id, "original")).status, "succeeded");
    const point = t.runtime.store.getActiveCheckpoint(session.id)!;
    saveSummaryModel(t.dirs.agentDir, { provider: "missing", modelId: "missing" });
    await t.runtime.compactSession({ sessionId: session.id, requestId: "no-new-coverage" });
    assert.equal((await finished(t, session.id, "no-new-coverage")).status, "noop");
    assert.equal(t.server.calls.length, 1);
    assert.equal(t.runtime.store.getActiveCheckpoint(session.id)!.id, point.id);
    await t.runtime.compactSession({ sessionId: session.id, requestId: "needs-refocus", prompt: "迁移重点" });
    assert.equal((await finished(t, session.id, "needs-refocus")).errorCode, "model_not_found");
    assert.equal(t.runtime.store.getActiveCheckpoint(session.id)!.id, point.id);
  } finally { await t.shutdown(); }
});

test("接收事件内同步取消先取得终态，接收应答返回取消且不启动摘要", async () => {
  const { t, session } = await fixture("manual-cancel-on-accept");
  const committed = t.runtime.store.onCommitted;
  try {
    t.runtime.store.onCommitted = events => {
      committed?.(events);
      for (const event of events) {
        if (event.body.type === "session.context_compaction" && event.body.status === "running") {
          assert.equal(t.runtime.interruptSessionCompaction({ sessionId: event.body.sessionId, requestId: event.body.requestId }).status, "cancelled");
        }
      }
    };
    assert.equal((await t.runtime.compactSession({ sessionId: session.id, requestId: "cancel-before-start" })).status, "cancelled");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(t.server.calls.length, 0);
    assert.equal(t.runtime.store.getActiveCheckpoint(session.id), null);
    t.runtime.store.onCommitted = committed;
    await t.runtime.compactSession({ sessionId: session.id, requestId: "after-cancel" });
    assert.equal((await finished(t, session.id, "after-cancel")).status, "succeeded");
    assert.equal(t.server.calls.length, 1);
  } finally { t.runtime.store.onCommitted = committed; await t.shutdown(); }
});

test("真实 Coding Agent 后台摘要中 SIGKILL：重启中断原请求，旧点与历史不变且不重调模型", async () => {
  let pause = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { t, session, file } = await fixture("mc-kill", async () => {
    if (pause) await gate;
    return { kind: "text", text: "可持久核实的摘要" };
  });
  let child: ChildProcess | null = null;
  let client: ControlClient | null = null;
  const closeClient = () => { client?.close(); client = null; };
  let restarted: Runtime | null = null;
  try {
    await t.runtime.compactSession({ sessionId: session.id, requestId: "old-point" });
    assert.equal((await finished(t, session.id, "old-point")).status, "succeeded");
    const oldPoint = t.runtime.store.getActiveCheckpoint(session.id)!;
    const bytes = fs.readFileSync(file);
    await t.runtime.stop("before_crash_process");
    pause = true;
    child = spawn(process.execPath, ["--import", "tsx", "apps/ruukoto-code/src/main.ts", "start", "--data-dir", t.dirs.dataDir, "--agent-dir", t.dirs.agentDir,
      "--tools", "mock", "--model", "mock/mock-model", "--thinking", "off"], {
      detached: true, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, RUUKOTO_CODE_CONTROL_DIR: t.dirs.root },
    });
    let stderr = "";
    child.stderr!.on("data", chunk => { stderr += String(chunk); });
    await waitFor("Coding Agent 子后台启动", async () => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`子后台提前退出：${stderr}`);
      try {
        client = await ControlClient.connect(path.join(t.dirs.root, "control.sock"), 500);
        await authenticateClient(client, t.dirs.root);
        await client.handshake();
        return true;
      } catch {
        // socket 尚未监听或认证初始化尚未完成，等待同一个子进程。
        closeClient();
        return false;
      }
    });
    const accepted = await client!.request<SessionCompactionRequest>("compact_session", { session_id: session.id, request_id: "process-killed", prompt: "本次重新聚焦" });
    assert.equal(accepted.status, "running");
    await waitFor("子进程摘要已发送", () => t.server.calls.length === 2);
    assert.equal((await client!.request<SessionCompactionRequest>("get_session_compaction", { session_id: session.id, request_id: accepted.requestId })).status, "running");
    closeClient();
    const exited = new Promise<NodeJS.Signals | null>(resolve => child!.once("exit", (_code, signal) => resolve(signal)));
    process.kill(-child.pid!, "SIGKILL");
    assert.equal(await exited, "SIGKILL", stderr);
    restarted = await Runtime.start(t.runtime.config);
    assert.equal(restarted.getSessionCompaction({ sessionId: session.id, requestId: accepted.requestId })!.status, "interrupted");
    assert.equal(restarted.getSessionCompaction({ sessionId: session.id, requestId: "old-point" })!.status, "succeeded");
    assert.deepEqual(restarted.store.getActiveCheckpoint(session.id), oldPoint);
    assert.deepEqual(fs.readFileSync(file), bytes);
    const calls = t.server.calls.length;
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(t.server.calls.length, calls, "重启只核实回执，不重发摘要请求");
    assert.equal((await restarted.compactSession({ sessionId: session.id, requestId: accepted.requestId, prompt: "本次重新聚焦" })).status, "interrupted");
    assert.equal(t.server.calls.length, calls);
  } finally {
    release(); closeClient();
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child!.once("exit", () => resolve()));
      process.kill(-child.pid, "SIGKILL");
      await exited;
    }
    await restarted?.stop("test_end"); await t.shutdown();
  }
});

test("配置摘要模型单次钉版；接收后清配置与改会话模型不改原调用，下一次采用会话模型", async () => {
  let pause = true;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { t, session } = await fixture("manual-model-fixed", async () => {
    if (pause) await gate;
    return { kind: "text", text: "按固定模型生成的摘要" };
  });
  try {
    const catalog = JSON.parse(fs.readFileSync(path.join(t.dirs.agentDir, "models.json"), "utf8")) as
      { providers: Record<string, { models: Array<Record<string, unknown>> }> };
    const provider = catalog.providers.mock;
    provider.models.push({ ...provider.models[0], id: "mock-summary", name: "摘要模型" }, { ...provider.models[0], id: "mock-next", name: "后续会话模型" });
    await t.runtime.models.saveCatalog({ providers: catalog.providers, expectedRevision: configRevision(t.dirs.agentDir) });
    await t.runtime.models.setSummary({ provider: "mock", modelId: "mock-summary", expectedRevision: configRevision(t.dirs.agentDir) });
    const accepted = await t.runtime.compactSession({ sessionId: session.id, requestId: "fixed-summary" });
    await waitFor("配置摘要模型已调用", () => t.server.calls.length === 1);
    assert.equal(t.server.calls[0].raw.model, "mock-summary");
    await t.runtime.models.setSummary({ provider: null, modelId: null, expectedRevision: configRevision(t.dirs.agentDir) });
    await t.runtime.setSessionModel({ sessionId: session.id, modelSelection: { provider: "mock", modelId: "mock-next", thinkingLevel: "off" }, expectedVersion: t.runtime.getSession(session.id).modelSelectionVersion });
    await t.runtime.setSessionDefaultMode({ sessionId: session.id, mode: "plan", expectedVersion: t.runtime.getSession(session.id).defaultAccessModeVersion });
    const pinned = t.runtime.getSessionCompaction({ sessionId: session.id, requestId: accepted.requestId })!;
    assert.equal(pinned.modelSelection.modelId, "mock-model");
    assert.equal(pinned.summaryModel.modelId, "mock-summary");
    pause = false; release();
    assert.equal((await finished(t, session.id, accepted.requestId)).status, "succeeded");
    assert.equal(t.runtime.store.getActiveCheckpoint(session.id)!.summaryModel, "mock/mock-summary");
    const fallback = await t.runtime.compactSession({ sessionId: session.id, requestId: "fallback-model", prompt: "下一次重新聚焦" });
    assert.deepEqual(fallback.summaryModel, { provider: "mock", modelId: "mock-next" });
    assert.equal((await finished(t, session.id, fallback.requestId)).status, "succeeded");
    assert.equal(t.server.calls[1].raw.model, "mock-next");
    assert.equal(t.runtime.store.getActiveCheckpoint(session.id)!.summaryModel, "mock/mock-next");
  } finally { release(); await t.shutdown(); }
});
