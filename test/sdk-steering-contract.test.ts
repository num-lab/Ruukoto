import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import type { UserMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createSdkSession } from "@ruukoto/agent/session-factory.ts";
import type { AttachmentReference } from "@ruukoto/core/attachments.ts";
import { parseSessionFile } from "@ruukoto/core/history.ts";
import type { Responder } from "./helpers/mock-provider.ts";
import { startAssemblyKit, waitFor } from "./helpers/testkit.ts";

interface GuidanceMessage extends UserMessage {
  ruukotoSourceTaskId: string;
  ruukotoAttachmentRefs: AttachmentReference[];
}

function sourceId(message: unknown): string | null {
  return message !== null && typeof message === "object" && "ruukotoSourceTaskId" in message && typeof message.ruukotoSourceTaskId === "string"
    ? message.ruukotoSourceTaskId : null;
}

function sourceIds(messages: readonly unknown[]): string[] {
  return messages.flatMap(message => {
    const id = sourceId(message);
    return id === null ? [] : [id];
  });
}

function historySources(sdk: AgentSession): string[] {
  const file = sdk.sessionFile;
  return file && fs.existsSync(file) ? sourceIds(parseSessionFile(file).filter(entry => entry.type === "message").map(entry => entry.message)) : [];
}

async function contractSession(responder: Responder = () => ({ kind: "text", text: "done" })) {
  const kit = await startAssemblyKit("sdk-steering", { responder });
  const { session } = kit.project();
  const sdk = await createSdkSession({
    session, sessionsDir: path.join(kit.dirs.dataDir, "sessions"), agentDir: kit.dirs.agentDir,
    modelRuntime: kit.deps.modelRuntime, model: kit.model, thinkingLevel: "off", tools: [], systemPrompt: "SDK contract check",
    hooks: { onToolCall: async () => undefined, onSessionEvent: () => undefined, bindHostApi: () => undefined },
  }).catch(async error => { await kit.close(); throw error; });
  sdk.setSteeringMode("all");
  return {
    sdk, server: kit.server,
    message(): GuidanceMessage {
      const task = kit.task(session, "same guidance");
      return {
        role: "user", content: [{ type: "text", text: task.input }], timestamp: Date.now(), ruukotoSourceTaskId: task.id,
        ruukotoAttachmentRefs: [{ id: `attachment-${task.id}`, taskId: task.id, sessionId: session.id, name: "note.txt", size: 1, mimeType: null, contentHash: "contract-check" }],
      };
    },
    async close() { await sdk.abort(); sdk.dispose(); await kit.close(); },
  };
}

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}

test("SDK steer：同文输入保留源 Task 与附件；all 在下一请求一起接入，message_end 先于 JSONL", async () => {
  const kit = await contractSession();
  try {
    const { sdk } = kit;
    const first = kit.message(), second = kit.message();
    const expected = [first.ruukotoSourceTaskId, second.ruukotoSourceTaskId];
    const beforeAppend: string[] = [], requests: string[][] = [];
    let queued = false;
    sdk.subscribe(event => {
      if (event.type !== "message_end") return;
      if (event.message.role === "assistant" && !queued) {
        queued = true;
        sdk.agent.steer(first);
        sdk.agent.steer(second);
      }
      const id = sourceId(event.message);
      if (id && !historySources(sdk).includes(id)) beforeAppend.push(id);
    });
    const originalStream = sdk.agent.streamFunction;
    sdk.agent.streamFunction = (model, context, options) => {
      const ids = sourceIds(context.messages);
      requests.push(ids);
      assert.deepEqual(historySources(sdk), ids, "请求开始前每条源输入都已进入 JSONL");
      return originalStream(model, context, options);
    };

    await sdk.prompt("original requirement");
    assert.deepEqual(requests, [[], expected]);
    assert.deepEqual(beforeAppend, expected);
    assert.deepEqual(historySources(sdk), expected);
    assert.deepEqual(sourceIds(sdk.messages), expected);
    const persisted = parseSessionFile(sdk.sessionFile!).filter(entry => sourceId(entry.message));
    assert.deepEqual(persisted.map(entry => entry.message), [first, second]);
    assert.equal(kit.server.calls.length, 2);
    assert.deepEqual(kit.server.calls[1].messages.filter(message => message.role === "user").map(message => message.content), [[{ type: "text", text: "original requirement" }], first.content, second.content]);
  } finally { await kit.close(); }
});

test("SDK abort：未取出的 steer 留在队列，公开清理后不会带进下一次 prompt", async () => {
  const response = deferred();
  const kit = await contractSession(async (_request, index) => {
    if (index === 0) await response.promise;
    return { kind: "text", text: "done" };
  });
  try {
    const { sdk } = kit;
    const running = sdk.prompt("original requirement");
    await waitFor("SDK 首次请求", () => kit.server.calls.length === 1);
    const message = kit.message();
    sdk.agent.steer(message);
    await sdk.abort();
    await running;
    assert.equal(sdk.agent.hasQueuedMessages(), true, "abort 不清除尚未消费的 steer");
    assert.deepEqual(sourceIds(sdk.agent.peekQueuedMessages()), [message.ruukotoSourceTaskId]);
    assert.deepEqual(historySources(sdk), []);
    sdk.agent.clearSteeringQueue();
    assert.equal(sdk.agent.hasQueuedMessages(), false);
    response.resolve();
    await sdk.prompt("next requirement");
    assert.deepEqual(historySources(sdk), []);
    assert.equal(kit.server.calls.length, 2);
  } finally { response.resolve(); await kit.close(); }
});

// 这是现有 SDK 的反例，不是产品取消／回退的验收通过。Note: 见 .agents/notes/proposed/feature/2026-10-28-coding-message-control.md
for (const abort of [false, true]) {
  test(`SDK 限制：已取出未落历史的输入不能由 ${abort ? "abort + clearQueue" : "clearQueue"} 撤回`, async () => {
    const kit = await contractSession();
    const preparing = deferred(), release = deferred();
    let running: Promise<void> | undefined;
    try {
      const { sdk } = kit;
      const message = kit.message();
      let queued = false;
      sdk.subscribe(event => {
        if (event.type === "message_end" && event.message.role === "assistant" && !queued) {
          queued = true;
          sdk.agent.steer(message);
        }
      });
      const originalPrepare = sdk.agent.prepareNextTurnWithContext;
      assert.ok(originalPrepare, "实际 AgentSession 默认安装异步的下一轮准备");
      sdk.agent.prepareNextTurnWithContext = async (turn, signal) => {
        preparing.resolve();
        await release.promise;
        return originalPrepare(turn, signal);
      };
      running = sdk.prompt("original requirement");
      await Promise.race([preparing.promise, running.then(() => assert.fail("未到达下一轮准备窗口"))]);
      assert.equal(sdk.agent.hasQueuedMessages(), false, "SDK 已将输入取到局部批次");
      assert.deepEqual(sdk.agent.peekQueuedMessages(), []);
      assert.deepEqual(historySources(sdk), [], "源输入尚未进入权威历史");
      const stopping = abort ? sdk.abort() : Promise.resolve();
      sdk.clearQueue();
      release.resolve();
      await Promise.all([running, stopping]);
      assert.deepEqual(historySources(sdk), [message.ruukotoSourceTaskId], "清理后仍落 user 历史，不能据队列为空判断已撤回");
      assert.deepEqual(sourceIds(sdk.messages), [message.ruukotoSourceTaskId]);
      if (!abort) assert.equal(kit.server.calls.length, 2, "未中止时仍进入下一模型请求");
    } finally {
      release.resolve();
      try { await running; }
      finally { await kit.close(); }
    }
  });
}

for (const stopAt of ["turn_start", "first_start", "first_end"] as const) {
  test(`SDK 同步停止守卫：${stopAt} 后只保留已落历史的源，refreshContext 清除内存残留`, async () => {
    const kit = await contractSession();
    try {
      const { sdk } = kit;
      const first = kit.message(), second = kit.message();
      let queued = false, stopped = false, blocked = false;
      sdk.subscribe(event => {
        if ((event.type === "message_start" || event.type === "message_end") && sourceId(event.message) && sdk.agent.signal?.aborted) {
          blocked = true;
          throw new Error("guidance_stopped_before_append");
        }
        if (event.type === "message_end" && event.message.role === "assistant" && !queued) {
          queued = true;
          sdk.agent.steer(first);
          sdk.agent.steer(second);
        }
      });
      // Agent 的监听位于 SDK 监听之后，固定 start→end 与两条输入之间的停止窗口。
      sdk.agent.subscribe(event => {
        if (stopped || !queued) return;
        const stop = stopAt === "turn_start" ? event.type === "turn_start"
          : event.type === (stopAt === "first_start" ? "message_start" : "message_end") && sourceId(event.message) === first.ruukotoSourceTaskId;
        if (stop) { stopped = true; sdk.agent.abort(); }
      });
      await sdk.prompt("original requirement");
      const expected = stopAt === "first_end" ? [first.ruukotoSourceTaskId] : [];
      assert.equal(blocked, true);
      assert.deepEqual(historySources(sdk), expected);
      assert.equal(kit.server.calls.length, 1, "停止后没有下一次模型请求");
      sdk.clearQueue();
      sdk.refreshContext();
      assert.deepEqual(sourceIds(sdk.messages), expected, "内存按权威历史重建，不带入未落盘的 user");
    } finally { await kit.close(); }
  });
}

for (const cancelFirst of [true, false]) {
  test(`SDK 边界预留：取消${cancelFirst ? "先赢且不新增请求" : "等待接入，准备期间迟到输入同批进入"}`, async () => {
    const kit = await contractSession();
    const preparing = deferred(), release = deferred(), joined = deferred();
    let running: Promise<void> | undefined;
    try {
      const { sdk } = kit;
      const first = kit.message(), late = kit.message(), canceledLate = kit.message();
      const pending = new Map([[first.ruukotoSourceTaskId, first]]), joining = new Set<string>();
      const cancel = async (id: string) => {
        if (joining.has(id)) await joined.promise;
        if (historySources(sdk).includes(id)) return "joined";
        pending.delete(id);
        return "canceled";
      };
      const originalFinish = sdk.agent.finishTurn;
      sdk.agent.finishTurn = async (turn, signal) => {
        const decision = await originalFinish?.(turn, signal);
        if (decision?.action === "end" || signal?.aborted || turn.message.stopReason === "error" || turn.message.stopReason === "aborted") return decision || undefined;
        for (const id of pending.keys()) joining.add(id);
        return pending.size > 0 ? { action: "continue" } : decision || undefined;
      };
      const originalPrepare = sdk.agent.prepareNextTurnWithContext;
      assert.ok(originalPrepare);
      sdk.agent.prepareNextTurnWithContext = async (turn, signal) => {
        const next = await originalPrepare(turn, signal);
        preparing.resolve();
        await release.promise;
        for (const [id, message] of pending) { joining.add(id); sdk.agent.steer(message); }
        return next || undefined;
      };
      const originalRequest = sdk.agent.prepareRequest;
      sdk.agent.prepareRequest = async (request, signal) => {
        const next = await originalRequest?.(request, signal);
        for (const id of historySources(sdk)) pending.delete(id);
        if (joining.size > 0) { joining.clear(); joined.resolve(); }
        return next || undefined;
      };
      if (cancelFirst) assert.equal(await cancel(first.ruukotoSourceTaskId), "canceled");
      running = sdk.prompt("original requirement");
      if (cancelFirst) {
        await running;
        assert.equal(kit.server.calls.length, 1);
        assert.deepEqual(historySources(sdk), []);
      } else {
        await Promise.race([preparing.promise, running.then(() => assert.fail("未到达边界准备"))]);
        let answered = false;
        const cancellation = cancel(first.ruukotoSourceTaskId).then(result => { answered = true; return result; });
        await Promise.resolve();
        assert.equal(answered, false, "预留不算接入；取消等待实际历史结果");
        pending.set(late.ruukotoSourceTaskId, late);
        pending.set(canceledLate.ruukotoSourceTaskId, canceledLate);
        assert.equal(await cancel(canceledLate.ruukotoSourceTaskId), "canceled");
        release.resolve();
        await running;
        assert.equal(await cancellation, "joined");
        assert.equal(kit.server.calls.length, 2);
        assert.deepEqual(historySources(sdk), [first.ruukotoSourceTaskId, late.ruukotoSourceTaskId]);
      }
    } finally {
      release.resolve();
      joined.resolve();
      try { await running; }
      finally { await kit.close(); }
    }
  });
}

test("SDK 写失败：refreshContext 不重读 JSONL，必须丢弃污染 manager 并从原文件重新打开", async () => {
  const kit = await contractSession();
  try {
    const { sdk } = kit;
    await sdk.prompt("original requirement");
    const file = sdk.sessionFile!, saved = `${file}.saved`, bytes = fs.readFileSync(file);
    const message = kit.message();
    fs.renameSync(file, saved);
    fs.mkdirSync(file);
    try { assert.throws(() => sdk.sessionManager.appendMessage(message)); }
    finally { fs.rmdirSync(file); fs.renameSync(saved, file); }
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.deepEqual(historySources(sdk), []);
    sdk.refreshContext();
    assert.deepEqual(sourceIds(sdk.messages), [message.ruukotoSourceTaskId], "刷新仍保留 manager 中未落盘的 entry");
    const reopened = SessionManager.open(file);
    assert.deepEqual(sourceIds(reopened.buildSessionProjection().messages), []);
    assert.deepEqual(fs.readFileSync(file), bytes, "重新打开不修改已提交历史");
  } finally { await kit.close(); }
});
