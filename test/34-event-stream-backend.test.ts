import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { Runtime } from "../src/runtime/runtime.ts";
import { ControlServer } from "../src/control/server.ts";
import { editStatsFromResult } from "../src/core/history.ts";
import { FRAGMENT_TEXT_CAP } from "../src/core/views.ts";
import type { PersistentEvent, Task } from "../src/core/types.ts";
import type { TaskEventsPage } from "../src/control/protocol.ts";
import { makeTestDirs, writeModelsJson, cleanupDirs, connectAuthedClient, createProjectSession, waitFor, realTools } from "./helpers/testkit.ts";

const selection = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" } as const;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("真实 SDK 事件：多段思考、Edit 统计、完整 UTF-8 增量分页与中断预览", async () => {
  const { dirs, work } = await makeTestDirs("flow", 1);
  const fullText = "开头：" + "汉🙂".repeat(48_000) + "结尾";
  const source = "old\nkeep\n";
  fs.writeFileSync(path.join(work[0]!, "answer.txt"), source);
  let cancelRequestSeen = false;
  let firstReasoningSentAt = 0;
  const provider = http.createServer(async (req, res) => {
    res.on("error", () => {});
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const cancel = /CANCEL_(STREAM|TEXT)/.test(JSON.stringify(body.messages));
    const hidden = JSON.stringify(body.messages).includes("CANCEL_TEXT");
    const toolDone = body.messages.some((m: any) => m.role === "tool");
    // 请求等待只计入无公开思考的阶段，公开思考应重设实际起点。
    await sleep(80);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (delta: object, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({
      id: "flow", object: "chat.completion.chunk", created: 1, model: "mock-model",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    send({ role: "assistant", content: "" });
    if (cancel) {
      if (!hidden) send({ reasoning_content: "正在检查取消路径" });
      cancelRequestSeen = true;
      await sleep(350);
      send({ content: "取消前正文🙂" });
      await sleep(600);
    } else if (!toolDone) {
      firstReasoningSentAt = Date.now();
      send({ reasoning_content: "检查文件" });
      await sleep(280);
      send({ reasoning_content: "，准备修改" });
      send({ tool_calls: [{ index: 0, id: "edit-1", type: "function", function: {
        name: "edit", arguments: JSON.stringify({ path: "answer.txt", edits: [{ oldText: source, newText: "new\nextra\nkeep\n" }] }),
      } }] });
      send({}, "tool_calls");
      res.end("data: [DONE]\n\n");
      return;
    } else {
      send({ reasoning_content: "核对结果" });
      send({ content: fullText.slice(0, -2) });
      send({ reasoning_content: "继续核对" });
      send({ content: "结尾" });
    }
    send({}, "stop");
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address() as import("node:net").AddressInfo;
  await writeModelsJson(dirs, `http://127.0.0.1:${address.port}/v1`);
  const runtime = await Runtime.start({
    dataDir: dirs.dataDir, agentDir: dirs.agentDir, socketPath: path.join(dirs.root, "c.sock"),
    modelProvider: "mock", modelId: "mock-model", thinkingLevel: "off", ...realTools(),
  });
  await ControlServer.start(runtime);
  const client = await connectAuthedClient(runtime);
  const live: PersistentEvent[] = [];
  runtime.store.onCommitted = ((previous) => (events) => {
    live.push(...events);
    previous?.(events);
  })(runtime.store.onCommitted);
  try {
    await client.handshake();
    const { sessionId } = await createProjectSession(client, work[0]!);
    const task = await client.request<Task>("submit", { session_id: sessionId, request_id: "flow-1", input: "修改文件", model_selection: selection });
    await waitFor("任务成功", () => runtime.store.getTask(task.id)?.status === "completed", 30_000);
    const restored: PersistentEvent[] = [];
    let after = 0;
    let pages = 0;
    for (;;) {
      const page = await client.request<TaskEventsPage>("read_task_events", { task_id: task.id, after_seq: after, limit: 500 });
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 256 * 1024);
      assert.ok(page.events.every((e) => e.taskId === task.id && e.seq > after));
      restored.push(...page.events);
      pages++;
      if (page.nextAfter === null) break;
      assert.ok(page.nextAfter > after);
      after = page.nextAfter;
    }
    assert.ok(pages > 1, "分页必须受字节预算限制");
    assert.deepEqual(restored.map((e) => e.seq), live.filter((e) => e.taskId === task.id).map((e) => e.seq));
    const thoughts = restored.flatMap((e) => e.body.type === "task.thinking" ? [e.body] : []);
    const closed = thoughts.filter((e) => e.endedAt !== null);
    assert.equal(closed.length, 3, "工具前一段、第二轮两段思考");
    assert.equal(new Set(closed.map((e) => e.thinkingId)).size, 3);
    assert.deepEqual(closed.map((e) => e.text), ["检查文件，准备修改", "核对结果", "继续核对"]);
    assert.equal(closed[0]!.thinkingId, thoughts[0]!.thinkingId, "公开思考沿用等待占位的身份");
    assert.ok(Date.parse(closed[0]!.startedAt) >= firstReasoningSentAt, "公开思考起点不得早于 provider 首次公开思考");
    assert.ok(Date.parse(closed[0]!.startedAt) - Date.parse(thoughts[0]!.startedAt) >= 70, "公开思考排除请求等待");
    assert.ok(Date.parse(closed[0]!.endedAt!) - Date.parse(closed[0]!.startedAt) >= 250, "明确思考本身的耗时仍被记录");
    assert.ok(thoughts.some((e) => e.text === "检查文件，准备修改" && e.endedAt === null), "公开思考在结束前流式发出");
    const fragments = restored.flatMap((e) => e.body.type === "task.output_fragment" ? [e.body] : []);
    const segments = new Map<number, string>();
    for (const fragment of fragments) {
      assert.equal(fragment.offset, Buffer.byteLength(segments.get(fragment.contentIndex!) ?? ""));
      assert.ok(Buffer.byteLength(fragment.text) <= FRAGMENT_TEXT_CAP);
      assert.ok(fragment.startedAt);
      assert.ok(!fragment.text.includes("\uFFFD"));
      segments.set(fragment.contentIndex!, (segments.get(fragment.contentIndex!) ?? "") + fragment.text);
    }
    assert.equal(segments.size, 2, "原生 SDK 重用块索引时仍保留两段正文");
    const secondMessage = closed[1]!.messageId;
    const firstTextEvent = restored.find((e) => e.body.type === "task.output_fragment" && e.body.messageId === secondMessage)!;
    const followingThought = restored.find((e) => e.body.type === "task.thinking" && e.body.thinkingId === closed[2]!.thinkingId)!;
    assert.ok(firstTextEvent.seq < followingThought.seq, "前一段正文必须在后一段思考前冲刷");
    for (const index of [0, 1]) assert.equal(new Set(fragments.filter((f) => f.contentIndex === index).map((f) => f.startedAt)).size, 1);
    assert.equal([...segments.values()].join(""), fullText, "节流末块与超长多字节正文不可丢失");
    const preview = runtime.store.getLatestOutputFragment(task.id)!;
    assert.ok(fullText.endsWith(preview.text));
    assert.equal(preview.totalBytes, Buffer.byteLength(fullText));
    assert.equal(preview.truncated, true);
    assert.ok(preview.text.length > 2, "有界预览必须跨正文段回收前一段尾部");
    assert.ok(Buffer.byteLength(preview.text) <= FRAGMENT_TEXT_CAP);
    const result = restored.find((e) => e.body.type === "task.tool_result")!.body;
    assert.ok(result.type === "task.tool_result");
    assert.deepEqual(result.editStats, { added: 2, removed: 1 }, "相同上下文 keep 不能计入增删行数");
    const history = runtime.readHistory({ sessionId });
    assert.deepEqual(history.entries.find((e) => e.toolName === "edit")?.editStats, result.editStats);
    assert.equal(fs.readFileSync(path.join(work[0]!, "answer.txt"), "utf8"), "new\nextra\nkeep\n");
    for (const input of [{ after_seq: -1 }, { limit: 0 }, { after_seq: "1" }, { after_seq: null }, { limit: null }]) {
      await assert.rejects(client.request("read_task_events", { task_id: task.id, ...input }), (error: any) => error.code === "invalid_params");
    }
    const cancel = await client.request<Task>("submit", { session_id: sessionId, request_id: "flow-cancel", input: "CANCEL_STREAM", model_selection: selection });
    await waitFor("公开思考已开始", () => cancelRequestSeen && live.some((e) => e.taskId === cancel.id && e.body.type === "task.thinking"));
    await runtime.cancelTask(cancel.id);
    const canceled = runtime.readTaskEvents({ taskId: cancel.id });
    const thinking = canceled.events.flatMap((e) => e.body.type === "task.thinking" ? [e.body] : []);
    assert.equal(thinking.at(-1)?.endedAt !== null, true, "取消必须收束思考");
    assert.equal(runtime.store.getTask(cancel.id)?.status, "canceled");
    const next = await createProjectSession(client, work[0]!);
    const hidden = await client.request<Task>("submit", { session_id: next.sessionId, request_id: "flow-hidden", input: "CANCEL_TEXT", model_selection: selection });
    await waitFor("无公开思考后的正文", () => live.some((e) => e.taskId === hidden.id && e.body.type === "task.output_fragment"));
    await runtime.cancelTask(hidden.id);
    const hiddenEvents = runtime.readTaskEvents({ taskId: hidden.id }).events;
    const hiddenThoughts = hiddenEvents.flatMap((e) => e.body.type === "task.thinking" ? [e.body] : []);
    assert.equal(hiddenThoughts.length, 2, "无公开思考只有请求开始和正文前结束");
    assert.equal(hiddenThoughts[0]!.text, "");
    assert.ok(Date.parse(hiddenThoughts[1]!.endedAt!) - Date.parse(hiddenThoughts[0]!.startedAt) >= 300);
    const captured = runtime.store.getLatestOutputFragment(hidden.id)!;
    assert.equal(captured.text, "取消前正文🙂");
    assert.equal(captured.truncated, false);

    // 模拟后台异常后没有 Driver 的恢复路径，阶段由终态持久化统一收束。
    runtime.store.withTx(() => {
      const orphan = runtime.store.insertQueuedTask({ sessionId: next.sessionId, requestId: "orphan", input: "", modelSelection: selection, submissionDigest: "orphan" }).task;
      const startedAt = new Date().toISOString();
      runtime.store.transitionTask(orphan.id, ["queued"], "running", { startedAt });
      runtime.store.appendEvent({ type: "task.thinking", taskId: orphan.id, sessionId: next.sessionId, messageId: "orphan-message", thinkingId: "orphan-thought", startedAt, endedAt: null, text: "已捕获" }, { taskId: orphan.id, sessionId: next.sessionId });
      runtime.store.transitionTask(orphan.id, ["running"], "interrupted", { endedAt: startedAt, interruptReason: "backend_restart" });
      const last = runtime.store.getTaskEventsAfter(orphan.id, 0, 100).at(-1)!.body;
      assert.ok(last.type === "task.thinking");
      assert.equal(last.endedAt, startedAt);
    });
  } finally {
    client.close();
    await runtime.stop("test_end");
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await cleanupDirs(dirs);
  }
});

test("Edit 缺失或失败结果不推测；实际补丁中的 +/- 内容行仍计数", () => {
  assert.equal(editStatsFromResult("edit", false, undefined), undefined);
  assert.equal(editStatsFromResult("edit", undefined, { patch: "@@ -1 +1 @@\n-a\n+b\n" }), undefined);
  assert.equal(editStatsFromResult("edit", true, { patch: "@@ -1 +1 @@\n-a\n+b\n" }), undefined);
  assert.deepEqual(editStatsFromResult("edit", false, { patch: "--- a\n+++ b\n@@ -1 +1 @@\n---old\n+++new\n" }), { added: 1, removed: 1 });
});
