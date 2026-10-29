/** 侧聊（coding-side-chat）：唯一持久绑定、冻结快照、无工具执行、普通接口排除。 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { product } from "../apps/ruukoto-code/src/product.ts";
import { parseSessionFileStrict, snapshotSessionHistory } from "@ruukoto/core/history.ts";
import { getSideChatByParent } from "@ruukoto/core/side-chat.ts";
import { TASK_START_MARKER, TASK_END_MARKER, randomId, type Session } from "@ruukoto/core/types.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { startTestRuntime, waitFor, inputText, lastUserText, routeResponder, type TestRuntime } from "./helpers/testkit.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** 与 102 分支用例同一形状：登记 sessionFile 并按行追加用户/助手消息。 */
function history(t: TestRuntime, session: Session) {
  const store = t.runtime.store;
  const file = path.join(t.dirs.dataDir, "sessions", `source_${session.piSessionId}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: session.piSessionId, timestamp: new Date().toISOString(), cwd: session.cwdReal })}\n`);
  store.setSessionFile(session.id, file);
  let parentId: string | null = null;
  const entry = (value: Record<string, unknown>) => {
    const tail = fs.readFileSync(file, "utf8").trim().split("\n").at(-1);
    parentId = tail ? (JSON.parse(tail) as { type: string; id: string }).type === "session" ? null : (JSON.parse(tail) as { id: string }).id : null;
    const id = randomUUID().slice(0, 8);
    fs.appendFileSync(file, `${JSON.stringify({ ...value, id, parentId, timestamp: new Date().toISOString() })}\n`);
    parentId = id;
    return id;
  };
  const task = (status: "completed" | "running" = "completed") => {
    const task = store.withTx(() => {
      const task = store.insertQueuedTask({ sessionId: session.id, requestId: randomId("req"), input: "来源对话", modelSelection: t.runtime.defaultSelection, submissionDigest: randomId("digest") }).task;
      if (status === "completed") store.endTask(task.id, ["queued"], status);
      else store.transitionTask(task.id, ["queued"], status);
      return store.getTask(task.id)!;
    });
    entry({ type: "custom", customType: TASK_START_MARKER, data: { taskId: task.id } });
    return task;
  };
  const user = (text: string) => entry({ type: "message", message: { role: "user", content: text, timestamp: Date.now() } });
  const assistant = (text: string) => entry({ type: "message", message: { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now(), api: "openai-completions", provider: "mock", model: "mock-model", usage, stopReason: "stop" } });
  return { file, entry, task, user, assistant };
}

function messagesOf(file: string): string[] {
  return parseSessionFileStrict(fs.readFileSync(file, "utf8")).entries.filter(entry => entry.type === "message").map(entry => {
    const content = (entry.message as { content?: unknown }).content;
    return typeof content === "string" ? content : Array.isArray(content) ? content.map((part: any) => typeof part?.text === "string" ? part.text : "").join("") : "";
  });
}

async function fixture(prefix: string, responder: Parameters<typeof startTestRuntime>[1] = async () => ({ kind: "text", text: "侧聊回复" })) {
  const t = await startTestRuntime(prefix, responder, { config: { product: product.runtime } });
  const session = (await t.runtime.openWorkspace({ cwd: t.work[0]! })).session;
  return { t, session, h: history(t, session) };
}

test("打开侧聊：每父会话唯一绑定、冻结首次快照、普通列表排除", async () => {
  const { t, session, h } = await fixture("side-open");
  try {
    const first = h.task();
    h.user("第一轮问题");
    h.assistant("第一轮回答");
    // 完整 todo_write 批次留在快照里，用于证明侧聊装配不注入 [工作清单] 参考块
    h.entry({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "tc-todo", name: "todo_write", arguments: { todos: [{ content: "核对实现", status: "in_progress" }] } }], timestamp: Date.now(), api: "openai-completions", provider: "mock", model: "mock-model", usage, stopReason: "toolUse" } });
    h.entry({ type: "message", message: { role: "toolResult", toolName: "todo_write", toolCallId: "tc-todo", isError: false, content: [{ type: "text", text: "清单已更新" }], timestamp: Date.now() } });
    h.entry({ type: "custom", customType: TASK_END_MARKER, data: { taskId: first.id, status: "completed" } });

    const side = await t.client.request<Session>("open_side_chat", { session_id: session.id, request_id: "side-open-1" });
    assert.equal(side.branchSource?.number, 0);
    assert.equal(side.branchSource?.sessionId, session.id);
    assert.match(side.name ?? "", /· 侧聊$/);
    assert.deepEqual(messagesOf(side.sessionFile!), ["第一轮问题", "第一轮回答", "", "清单已更新"]);
    const identity = t.runtime.store.getSessionIdentity(side.id);
    assert.deepEqual(identity, { kind: "side", parentSessionId: session.id });

    // 首次打开之后再追加的父历史不进侧聊；重开（含新请求键）返回同一绑定
    h.user("之后的主会话消息");
    h.assistant("之后的主会话回答");
    const reopened = await t.client.request<Session>("open_side_chat", { session_id: session.id, request_id: "side-open-2" });
    assert.equal(reopened.id, side.id);
    assert.deepEqual(messagesOf(reopened.sessionFile!), ["第一轮问题", "第一轮回答", "", "清单已更新"]);

    // 原键核实与冲突：同键原样返回，键已用于其他父会话时报 request_conflict
    const found = await t.client.request<any>("find_side_chat", { request_id: "side-open-1" });
    assert.equal(found.status, "published");
    assert.equal(found.session.id, side.id);
    const other = (await t.runtime.openWorkspace({ cwd: t.work[1]! })).session;
    await assert.rejects(() => t.client.request("open_side_chat", { session_id: other.id, request_id: "side-open-1" }), (e: any) => e.code === "request_conflict");

    // 普通会话投影排除侧聊；绑定经快照下发；侧聊不能作为侧聊父会话
    const snapshot = (await t.client.handshake()).snapshot;
    assert.ok(!snapshot.sessions.some((item: any) => item.id === side.id));
    assert.deepEqual(snapshot.sideChats, [{ parentSessionId: session.id, sideSessionId: side.id }]);
    await assert.rejects(() => t.client.request("open_side_chat", { session_id: side.id, request_id: "side-on-side" }), (e: any) => e.code === "invalid_params");
    // 普通历史搜索与会话清单默认范围不含侧聊会话（TUI 选择器同源）
    const hits = await t.runtime.searchHistory({ query: "第一轮" });
    assert.ok(!hits.hits.some((hit: any) => hit.sessionId === side.id));
    const summaries = await t.client.request<any>("list_session_summaries", { project_id: session.projectId });
    assert.ok(!summaries.some((item: any) => item.sessionId === side.id));
    // 未发布绑定不下发快照：failed/prepared 不是可用侧聊，客户端须回退 open_side_chat
    t.runtime.store.db.prepare("UPDATE side_chats SET status = 'failed' WHERE parent_session_id = ?").run(session.id);
    assert.equal((await t.client.handshake()).snapshot.sideChats?.length ?? 0, 0);
    t.runtime.store.db.prepare("UPDATE side_chats SET status = 'published' WHERE parent_session_id = ?").run(session.id);
    // 侧聊装配不注入历史派生参考块（工作清单/项目指令/记忆），快照消息本身保留
    const sideTask = await t.runtime.submitSideChat({ sessionId: side.id, requestId: "side-q-open", input: "看看快照里有什么" });
    await waitFor("侧聊任务完成", () => t.runtime.store.getTask(sideTask.id)?.status === "completed");
    const call = t.server.calls.at(-1)!;
    assert.match(inputText(call), /第一轮问题/);
    assert.doesNotMatch(inputText(call), /工作清单|项目指令|长期记忆|执行资源/);
  } finally { await t.shutdown(); }
});

test("空会话起步、登记历史缺失与身份不符按损坏拒绝，不留半成品绑定", async () => {
  const { t, session } = await fixture("side-empty");
  try {
    // 尚无落盘历史：空 JSONL 起步，打开成功
    const side = await t.client.request<Session>("open_side_chat", { session_id: session.id, request_id: "side-empty" });
    assert.deepEqual(messagesOf(side.sessionFile!), []);

    // 登记过历史但文件缺失：按损坏拒绝而不是降级成空白侧聊
    const orphan = (await t.runtime.openWorkspace({ cwd: t.work[1]! })).session;
    const missing = path.join(t.dirs.dataDir, "sessions", `gone_${orphan.piSessionId}.jsonl`);
    t.runtime.store.setSessionFile(orphan.id, missing);
    await assert.rejects(() => t.client.request("open_side_chat", { session_id: orphan.id, request_id: "side-missing" }), (e: any) => e.code === "history_corrupt");
    assert.equal(getSideChatByParent(t.runtime.store, orphan.id), null);

    // 登记历史与登记 pi 身份不符同样拒绝（快照级校验由 102 分支用例覆盖）
    const alienDir = path.join(t.work[1]!, "alien-sub");
    fs.mkdirSync(alienDir);
    const alien = (await t.runtime.openWorkspace({ cwd: alienDir })).session;
    const alienFile = path.join(t.dirs.dataDir, "sessions", `alien_${alien.piSessionId}.jsonl`);
    fs.writeFileSync(alienFile, `${JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: alien.cwdReal })}\n`);
    t.runtime.store.setSessionFile(alien.id, alienFile);
    await assert.rejects(() => t.client.request("open_side_chat", { session_id: alien.id, request_id: "side-alien" }), (e: any) => e.code === "history_corrupt");
    assert.equal(getSideChatByParent(t.runtime.store, alien.id), null);
  } finally { await t.shutdown(); }
});

test("侧聊提交：无工具执行、固定父模型、生成中拒绝新提交、普通 submit 拒绝", async () => {
  const releaseSlowRef = { release: null as null | (() => void) };
  const { t, session } = await fixture("side-submit", routeResponder([
    { match: /侧聊慢问题/, respond: () => new Promise(resolve => { releaseSlowRef.release = () => resolve({ kind: "text", text: "侧聊慢回答" }); }) },
  ]));
  try {
    const side = await t.client.request<Session>("open_side_chat", { session_id: session.id, request_id: "side-submit-open" });

    // 普通提交入口不接受侧聊会话
    await assert.rejects(() => t.client.request("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" }, session_id: side.id, request_id: "ordinary-submit", input: "走错入口" }), (e: any) => e.code === "invalid_state");

    // 提交跑通且模型请求不携带任何工具、系统提示为侧聊提示
    const task = await t.client.request<any>("submit_side_chat", { session_id: side.id, request_id: "side-q1", input: "侧聊第一个问题" });
    await waitFor("侧聊任务完成", () => t.runtime.store.getTask(task.id)?.status === "completed");
    const call = t.server.calls.at(-1)!;
    assert.equal((call.tools ?? []).length, 0);
    assert.equal(lastUserText(call), "侧聊第一个问题");
    assert.match(String((call as any).system ?? ""), /侧聊/);

    // 同请求键重复提交幂等返回原任务
    const again = await t.client.request<any>("submit_side_chat", { session_id: side.id, request_id: "side-q1", input: "侧聊第一个问题" });
    assert.equal(again.id, task.id);
    await assert.rejects(() => t.client.request("submit_side_chat", { session_id: side.id, request_id: "side-q1", input: "不同的输入" }), (e: any) => e.code === "request_conflict");

    // 生成中拒绝第二条（side_busy）；父会话仍可正常提交且队列不暂停
    const slow = await t.client.request<any>("submit_side_chat", { session_id: side.id, request_id: "side-q2", input: "侧聊慢问题" });
    await waitFor("侧聊慢任务进入执行", () => ["running"].includes(t.runtime.store.getTask(slow.id)?.status ?? ""));
    await assert.rejects(() => t.client.request("submit_side_chat", { session_id: side.id, request_id: "side-q3", input: "生成中插队" }), (e: any) => e.code === "side_busy");
    const parentTask = await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" }, session_id: session.id, request_id: "parent-q1", input: "主会话问题" });
    await waitFor("主任务完成", () => t.runtime.store.getTask(parentTask.id)?.status === "completed");
    assert.equal(t.runtime.store.getSession(session.id)?.queueState, "active");
    assert.equal(t.runtime.store.getSession(side.id)?.queueState, "active");
    releaseSlowRef.release?.();
    await waitFor("侧聊慢任务完成", () => t.runtime.store.getTask(slow.id)?.status === "completed");
    const sideCalls = t.server.calls.filter(req => lastUserText(req) === "侧聊慢问题");
    assert.equal(sideCalls.length, 1);
    assert.equal((sideCalls[0]!.tools ?? []).length, 0);
    // 侧聊历史独立累积：父任务消息不进侧聊文件
    const sideText = fs.readFileSync(side.sessionFile!, "utf8");
    assert.match(sideText, /侧聊第一个问题/);
    assert.doesNotMatch(sideText, /主会话问题/);
  } finally { releaseSlowRef.release?.(); await t.shutdown(); }
});

test("侧聊 queued 任务跨重启中断且队列不暂停；绑定与历史保留", async () => {
  const { t, session } = await fixture("side-restart");
  let restarted: Runtime | null = null;
  try {
    const side = await t.client.request<Session>("open_side_chat", { session_id: session.id, request_id: "side-restart-open" });
    // 直插库模拟「已接纳未启动」窗口：不 kick 队列，任务保持 queued
    const queued = t.runtime.store.withTx(() => t.runtime.store.insertQueuedTask({
      sessionId: side.id, requestId: "side-restart-queued", input: "重启前排队的侧聊", modelSelection: t.runtime.defaultSelection,
      submissionDigest: randomId("digest"), accessMode: "confirm", planMode: false, grantedPaths: [],
    }).task);
    await t.runtime.stop("test_restart");
    restarted = await Runtime.start(t.runtime.config);
    const task = restarted.store.getTask(queued.id);
    assert.equal(task?.status, "interrupted");
    assert.equal(task?.interruptReason, "backend_restart");
    assert.equal(restarted.store.getSession(side.id)?.queueState, "active");
    // 重开返回同一会话与同一冻结历史
    const reopened = await restarted.openSideChat({ sessionId: session.id, requestId: "side-restart-reopen" });
    assert.equal(reopened.id, side.id);
    assert.equal(restarted.store.getSessionIdentity(side.id)?.kind, "side");
  } finally { await restarted?.stop("test_end"); await t.shutdown(); }
});

test("产品能力关闭时侧聊不可用", async () => {
  const t = await startTestRuntime("side-disabled", async () => ({ kind: "text", text: "x" }));
  try {
    const session = (await t.runtime.openWorkspace({ cwd: t.work[0]! })).session;
    await assert.rejects(() => t.runtime.openSideChat({ sessionId: session.id, requestId: "side-off" }), (e: any) => e.code === "unavailable");
    await assert.rejects(() => t.client.request("open_side_chat", { session_id: session.id, request_id: "side-off-client" }), (e: any) => e.code === "unavailable");
  } finally { await t.shutdown(); }
});
