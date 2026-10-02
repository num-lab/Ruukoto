/** daily-agent issue 09：群会话接入 chat 编排；仅使用回环 OneBot 与 mock 模型。 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createMockTools } from "../src/agent/mock-tools.ts";
import { Db } from "../src/core/db.ts";
import { QqStore, qqDedupKey, qqMessageTag } from "../src/qq/store.ts";
import { Runtime, type RuntimeConfig } from "../src/runtime/runtime.ts";
import { cleanupDirs, lastUserText, makeTestDirs, waitFor, writeModelsJson } from "./helpers/testkit.ts";
import { MockModelServer, type Responder } from "./helpers/mock-provider.ts";
import { MOCK_QQ_ACCOUNT, MOCK_QQ_SECRET, startMockOneBot, type MockOneBot } from "./helpers/mock-onebot.ts";

const GROUP_A = "100001", GROUP_B = "100002", USER = "880001";
const QQ_TIMEOUTS = { actionTimeoutMs: 1_000, probeIntervalMs: 100, reconnectMinMs: 30, reconnectMaxMs: 100, sweepIntervalMs: 50 };
const reply: Responder = async (req) => ({ kind: "text", text: `回复 ${lastUserText(req).match(/MARK-[A-Z0-9-]+/)?.[0] ?? "收到"}` });

async function harness(prefix: string, responder = reply) {
  const { dirs } = await makeTestDirs(prefix, 0);
  const onebot = await startMockOneBot({});
  const model = new MockModelServer(responder);
  await writeModelsJson(dirs, await model.start());
  const config: RuntimeConfig = {
    dataDir: dirs.dataDir, agentDir: dirs.agentDir, socketPath: path.join(dirs.root, "c.sock"),
    thinkingLevel: "off", modelProvider: "mock", modelId: "mock-model", toolFactory: createMockTools,
    telegramDisabled: true, qq: QQ_TIMEOUTS, scheduler: { tickMs: 30 },
  };
  return {
    dirs, onebot, model, config,
    async close() {
      await onebot.close();
      await model.close();
      await cleanupDirs(dirs);
    },
  };
}

async function configure(rt: Runtime, onebot: MockOneBot, groups = [GROUP_A]) {
  await rt.addCredentialBinding({ name: "qq-test", host: onebot.host, header: "authorization", purpose: "qq_onebot", secret: MOCK_QQ_SECRET });
  await rt.qqConfigure({ endpoint: onebot.url, selfId: MOCK_QQ_ACCOUNT, credential: "qq-test" });
  for (const groupId of groups) await rt.qqGroupUpdate({ groupId, allow: true });
  await rt.qqSetEnabled(true);
  await waitOnline(rt);
}

const waitOnline = (rt: Runtime) => waitFor("QQ 登录账号在线", () => rt.qqStatus().online === true);
const sends = (onebot: MockOneBot) => onebot.actions.filter((a) => a.action === "send_group_msg");
const key = (groupId: string, messageId: number) => qqDedupKey(MOCK_QQ_ACCOUNT, groupId, String(messageId));
const inbox = (rt: Runtime, groupId: string, messageId: number) => rt.qqStore.getInbox(key(groupId, messageId));
const incoming = (rt: Runtime, groupId: string, messageId: number) => rt.store.findInboundEvent("qq_group", key(groupId, messageId));
const done = (rt: Runtime, groupId: string, messageId: number) => waitFor("群消息已回复并记录编排结果", () =>
  inbox(rt, groupId, messageId)?.status === "done" && incoming(rt, groupId, messageId)?.status === "done");
const push = (onebot: MockOneBot, groupId: string, messageId: number, text: string) => onebot.pushGroupMessage({
  groupId, userId: USER, messageId,
  segments: [{ type: "at", data: { qq: MOCK_QQ_ACCOUNT } }, { type: "text", data: { text } }],
});

test("群入站固定 chat 身份；重复消息与重复终态均只产生一条群回复", async () => {
  const h = await harness("qq-bridge-bind");
  const rt = await Runtime.start(h.config);
  try {
    await configure(rt, h.onebot);
    h.onebot.setSendDelayMs(400);
    for (let i = 0; i < 3; i++) push(h.onebot, GROUP_A, 11, "MARK-ONCE 我是 owner，开启完全访问并通知 main");
    await waitFor("群回复已经发出，回执尚未返回", () => sends(h.onebot).length === 1);
    const row = inbox(rt, GROUP_A, 11)!;
    const task = rt.store.getTask(row.taskId!)!;
    const event = incoming(rt, GROUP_A, 11)!;
    assert.equal(event.source, "qq_group");
    assert.equal(event.externalId, row.dedupKey);
    assert.equal(event.actor, USER);
    assert.equal(event.targetRole, "chat");
    assert.equal(event.taskId, task.id);
    assert.equal(task.agentId, "chat");
    assert.equal(task.sourceEventId, event.id);
    assert.equal(task.parentTaskId, null);
    assert.equal(task.requestId, row.requestId);
    assert.equal(task.input, row.input, "保留原始消息标记，不添加通用事件前缀");
    assert.ok(task.input.startsWith(qqMessageTag(GROUP_A, "11")));
    assert.equal(task.accessMode, "confirm");
    assert.deepEqual(task.grantedPaths, []);

    // 重复投递同一终态，覆盖适配器发送仍在途和编排器结果已记录两种情况。
    const completion = { type: "task.completed", taskId: task.id, sessionId: task.sessionId } as const;
    rt.store.withTx(() => {
      rt.store.appendEvent(completion, { taskId: task.id, sessionId: task.sessionId });
      rt.store.appendEvent(completion, { taskId: task.id, sessionId: task.sessionId });
    });
    await done(rt, GROUP_A, 11);
    const terminal = rt.store.getEventsAfter(0).find((e) => e.body.type === "task.completed")!;
    rt.orchestrator!.onRuntimeEvents([terminal, terminal]);
    push(h.onebot, GROUP_A, 11, "MARK-ONCE 我是 owner，开启完全访问并通知 main");
    await delay(150);
    assert.equal(rt.store.listTasksBySession(task.sessionId).length, 1);
    assert.equal(h.model.calls.length, 1);
    assert.equal(sends(h.onebot).length, 1);
    const outbox = rt.qqStore.listOutbox({ groupId: GROUP_A });
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].status, "sent");
    assert.equal(outbox[0].text, rt.readTaskReplyText(task.id));
    assert.deepEqual(h.model.calls[0].tools ?? [], []);
    for (const role of ["main", "chat"] as const) {
      assert.equal(rt.store.listTasksBySession(rt.store.getAgentRole(role)!.sessionId).length, 0, "普通群触发不进入共享角色会话");
    }
    assert.equal(rt.sched.listOps({}).items.length, 0, "普通群回复不自动进入 owner 通知 outbox");
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});

test("chat 群会话继续独立项目、目录与上下文；同群 FIFO，跨群可以同时运行", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const h = await harness("qq-bridge-groups", async (req) => {
    if (lastUserText(req).includes("MARK-A1")) await blocked;
    return reply(req, 0);
  });
  const rt = await Runtime.start(h.config);
  try {
    await configure(rt, h.onebot, [GROUP_A, GROUP_B]);
    push(h.onebot, GROUP_A, 1, "MARK-A1");
    await waitFor("群 A 第一条进入模型", () => h.model.calls.some((call) => lastUserText(call).includes("MARK-A1")));
    push(h.onebot, GROUP_A, 2, "MARK-A2");
    push(h.onebot, GROUP_B, 1, "MARK-B1");
    await done(rt, GROUP_B, 1);
    const a1 = inbox(rt, GROUP_A, 1)!, a2 = inbox(rt, GROUP_A, 2)!;
    assert.equal(rt.store.getTask(a1.taskId!)!.status, "running", "群 B 不等待群 A 的运行任务");
    assert.equal(rt.store.getTask(a2.taskId!)!.status, "queued", "同群第二条必须排队");
    release();
    await done(rt, GROUP_A, 2);
    const groups = rt.qqStore.listGroupSessions();
    for (const property of ["projectId", "sessionId", "workDir"] as const) {
      assert.equal(new Set(groups.map((group) => group[property])).size, 2, `${property} 按群独立`);
    }
    for (const group of groups) {
      assert.equal(rt.store.getSession(group.sessionId)!.kind, "qq_group");
      assert.equal(rt.store.getSession(group.sessionId)!.projectId, group.projectId);
      assert.notEqual(group.sessionId, rt.store.getAgentRole("chat")!.sessionId);
    }
    const aReplies = sends(h.onebot).filter((action) => String(action.params.group_id) === GROUP_A);
    assert.deepEqual(aReplies.map((action) => (action.params.message as any[])[0].data.id), [1, 2]);
    const aContext = JSON.stringify(h.model.calls.find((call) => lastUserText(call).includes("MARK-A2"))!.messages);
    const bContext = JSON.stringify(h.model.calls.find((call) => lastUserText(call).includes("MARK-B1"))!.messages);
    assert.ok(aContext.includes("MARK-A1") && aContext.includes("MARK-A2"));
    assert.ok(!aContext.includes("MARK-B1"));
    assert.ok(!bContext.includes("MARK-A1") && !bContext.includes("MARK-A2"));
    assert.ok(h.model.calls.every((call) => (call.tools ?? []).length === 0));
  } finally {
    release();
    await rt.stop("test_end");
    await h.close();
  }
});

test("chat 入站保留撤回标记；撤回原文及对应回复不进入后续模型上下文", async () => {
  const h = await harness("qq-bridge-recall", async (req) => ({
    kind: "text", text: lastUserText(req).includes("MARK-RECALLED") ? "RECALLED-ANSWER" : "新问题回复",
  }));
  const rt = await Runtime.start(h.config);
  try {
    await configure(rt, h.onebot);
    push(h.onebot, GROUP_A, 1, "MARK-RECALLED");
    await done(rt, GROUP_A, 1);
    h.onebot.pushRecall({ groupId: GROUP_A, messageId: 1, userId: USER });
    await waitFor("撤回记录已保存", () => inbox(rt, GROUP_A, 1)?.recalled === true);
    push(h.onebot, GROUP_A, 2, "MARK-AFTER-RECALL");
    await done(rt, GROUP_A, 2);
    const messages = JSON.stringify(h.model.calls[1].messages);
    assert.ok(messages.includes("MARK-AFTER-RECALL"));
    assert.ok(!messages.includes("MARK-RECALLED"));
    assert.ok(!messages.includes("RECALLED-ANSWER"));
    assert.equal(h.onebot.actions.filter((action) => action.action === "delete_msg").length, 0);
    assert.equal(rt.qqStore.listOutbox({}).filter((op) => op.status === "sent").length, 2);
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});

test("旧 qq_inbox 恢复保留原请求、群映射与已建任务，不因补 chat 身份产生提交冲突", async (t) => {
  for (const window of ["registered", "task_committed"] as const) await t.test(window, async () => {
    const h = await harness(`qq-bridge-legacy-${window}`);
    let rt = await Runtime.start(h.config);
    try {
      await configure(rt, h.onebot);
      push(h.onebot, GROUP_A, 1, "MARK-PRIME");
      await done(rt, GROUP_A, 1);
      const group = rt.qqStore.getGroupSession(MOCK_QQ_ACCOUNT, GROUP_A)!;
      const requestId = `qq:${key(GROUP_A, 555)}`;
      const input = `${qqMessageTag(GROUP_A, "555")} 甲(${USER}): MARK-LEGACY`;
      let existingId: string | null = null;
      if (window === "task_committed") {
        rt.store.setSessionQueueState(group.sessionId, "paused", "backend_restart");
        const task = await rt.submit({ sessionId: group.sessionId, requestId, input, accessMode: "confirm", modelSelection: rt.defaultSelection });
        assert.equal(task.agentId, null, "模拟升级前没有编排身份的群任务");
        existingId = task.id;
      }
      await rt.stop("test_restart");
      // 还原旧版本的持久窗口：收件已登记，但没有回填已创建的任务。
      const db = new Db(h.dirs.dataDir);
      try {
        new QqStore(db).registerInbox({ account: MOCK_QQ_ACCOUNT, groupId: GROUP_A, userId: USER, senderName: "甲",
          messageId: "555", text: "MARK-LEGACY", taskInput: input, messageTime: null });
      } finally { db.close(); }

      rt = await Runtime.start(h.config);
      await done(rt, GROUP_A, 555);
      const row = inbox(rt, GROUP_A, 555)!;
      const task = rt.store.getTask(row.taskId!)!;
      const event = incoming(rt, GROUP_A, 555)!;
      assert.deepEqual(rt.qqStore.getGroupSession(MOCK_QQ_ACCOUNT, GROUP_A), group);
      assert.equal(row.requestId, requestId);
      assert.equal(task.requestId, requestId);
      assert.equal(task.input, input);
      assert.equal(task.agentId, "chat");
      assert.equal(task.sourceEventId, event.id);
      assert.equal(event.taskId, task.id);
      if (existingId) assert.equal(task.id, existingId, "原任务已建时直接关联，不创建替代任务");
      assert.equal(rt.store.listTasksBySession(group.sessionId).length, 2);
      await rt.stop("test_restart_again");
      rt = await Runtime.start(h.config);
      await waitOnline(rt);
      await rt.orchestrator!.dispatchRegisteredEvents();
      await delay(150);
      assert.equal(inbox(rt, GROUP_A, 555)!.taskId, task.id);
      assert.equal(rt.store.listTasksBySession(group.sessionId).length, 2);
      assert.equal(sends(h.onebot).length, 2);
      assert.equal(h.model.calls.length, 2);
    } finally {
      await rt.stop("test_end");
      await h.close();
    }
  });
});

test("群入站登记后未派发的重启：恢复原事件，撤回、停用与五分钟过期均不执行", async (t) => {
  for (const state of ["registered", "recalled", "disabled", "expired"] as const) await t.test(state, async () => {
    const h = await harness(`qq-bridge-pending-${state}`);
    let rt = await Runtime.start(h.config);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    try {
      await configure(rt, h.onebot);
      void rt.orchestrator!.serial(() => blocked);
      push(h.onebot, GROUP_A, 7, "MARK-PERSISTED");
      await waitFor("真实入站已经持久化但尚未派发", () => incoming(rt, GROUP_A, 7) !== null);
      const event = incoming(rt, GROUP_A, 7)!;
      assert.equal(event.status, "registered");
      assert.equal(event.taskId, null);
      assert.equal(h.model.calls.length, 0);
      let disabling: Promise<unknown> | undefined;
      if (state === "recalled") {
        h.onebot.pushRecall({ groupId: GROUP_A, messageId: 7, userId: USER });
        await waitFor("未派发消息的撤回已保存", () => inbox(rt, GROUP_A, 7)?.recalled === true);
      } else if (state === "disabled") {
        disabling = rt.qqSetEnabled(false);
        await waitFor("停用配置已保存", () => rt.qqStore.getConfig()?.enabled === false);
      } else if (state === "expired") {
        const old = new Date(Date.now() - 301_000).toISOString();
        rt.store.db.prepare("UPDATE qq_inbox SET created_at = ?, message_time = ? WHERE dedup_key = ?").run(old, old, key(GROUP_A, 7));
        rt.store.db.prepare("UPDATE inbound_events SET received_at = ? WHERE id = ?").run(old, event.id);
      }
      const stopping = rt.orchestrator!.stop();
      release();
      await stopping;
      await disabling;
      await rt.stop("test_restart");
      rt = await Runtime.start(h.config);
      if (state === "registered") {
        await done(rt, GROUP_A, 7);
        assert.equal(incoming(rt, GROUP_A, 7)!.id, event.id);
        const task = rt.store.getTask(inbox(rt, GROUP_A, 7)!.taskId!)!;
        assert.equal(task.sourceEventId, event.id);
        assert.equal(task.requestId, `qq:${key(GROUP_A, 7)}`);
        assert.equal(sends(h.onebot).length, 1);
        assert.equal(h.model.calls.length, 1);
      } else {
        await waitFor("失效群事件已终结", () => rt.store.getInboundEvent(event.id)?.status === "failed");
        assert.equal(inbox(rt, GROUP_A, 7)!.status, "skipped");
        assert.equal(rt.store.getInboundEvent(event.id)!.taskId, null);
        assert.equal(h.model.calls.length, 0);
        assert.equal(sends(h.onebot).length, 0);
      }
    } finally {
      release();
      await rt.stop("test_end");
      await h.close();
    }
  });
});

test("完成任务在发送登记前重启按任务补回复；已有 pending、sent、unknown 账本均不重发", async (t) => {
  for (const state of ["result_missing", "result_recorded", "pending", "sent", "unknown"] as const) await t.test(state, async () => {
    const h = await harness(`qq-bridge-terminal-${state}`);
    let rt = await Runtime.start(h.config);
    try {
      await configure(rt, h.onebot);
      push(h.onebot, GROUP_A, 1, "MARK-ORIGINAL");
      await done(rt, GROUP_A, 1);
      const original = inbox(rt, GROUP_A, 1)!;
      const taskId = original.taskId!, eventId = incoming(rt, GROUP_A, 1)!.id;
      const replyText = rt.readTaskReplyText(taskId);
      const originalOp = rt.qqStore.listOutbox({}).find((op) => op.taskId === taskId)!;
      // 恢复时会话已有较新的回答，补发必须按 taskId 查原回答。
      push(h.onebot, GROUP_A, 2, "MARK-LATER");
      await done(rt, GROUP_A, 2);
      await rt.stop("test_crash_window");

      const missingOp = state === "result_missing" || state === "result_recorded";
      const db = new Db(h.dirs.dataDir);
      try {
        db.prepare("UPDATE qq_inbox SET status = 'queued' WHERE dedup_key = ?").run(original.dedupKey);
        if (missingOp) db.prepare("DELETE FROM qq_outbox WHERE task_id = ?").run(taskId);
        else db.prepare("UPDATE qq_outbox SET status = ?, sent_message_id = NULL WHERE op_id = ?").run(state, originalOp.opId);
        if (state === "result_missing") {
          db.prepare("UPDATE tasks SET result_summary = NULL, result_ref = NULL WHERE id = ?").run(taskId);
          db.prepare("UPDATE inbound_events SET status = 'queued' WHERE id = ?").run(eventId);
        }
      } finally { db.close(); }
      h.onebot.actions.length = 0;
      h.model.calls.length = 0;

      rt = await Runtime.start(h.config);
      await waitOnline(rt);
      if (missingOp) {
        await done(rt, GROUP_A, 1);
        const sent = sends(h.onebot);
        assert.equal(sent.length, 1);
        assert.deepEqual(sent[0].params.message, [
          { type: "reply", data: { id: 1 } }, { type: "text", data: { text: replyText } },
        ]);
        assert.equal(rt.qqStore.listOutbox({}).filter((op) => op.taskId === taskId).length, 1);
      } else {
        await delay(150);
        assert.equal(sends(h.onebot).length, 0, "有发送账本时恢复不能再次调用 OneBot");
        const op = rt.qqStore.listOutbox({}).find((item) => item.taskId === taskId)!;
        assert.equal(op.opId, originalOp.opId);
        assert.equal(op.status, state === "pending" ? "unknown" : state);
      }
      assert.equal(rt.store.getInboundEvent(eventId)!.status, "done");
      assert.equal(inbox(rt, GROUP_A, 1)!.taskId, taskId);
      assert.equal(h.model.calls.length, 0, "终态恢复不得重新执行模型任务");
      await rt.stop("test_restart_again");
      rt = await Runtime.start(h.config);
      await waitOnline(rt);
      await delay(150);
      assert.equal(sends(h.onebot).length, missingOp ? 1 : 0, "再次重启不能重复补回复");
      assert.equal(h.model.calls.length, 0);
    } finally {
      await rt.stop("test_end");
      await h.close();
    }
  });
});

test("启动补发在途仍及时处理撤回，恢复扫描保留当前进程 pending", async () => {
  const h = await harness("qq-bridge-recovery-recall");
  let rt = await Runtime.start(h.config);
  try {
    await configure(rt, h.onebot);
    for (const [messageId, text] of [[1, "MARK-RECOVER"], [2, "MARK-PENDING"]] as const) {
      push(h.onebot, GROUP_A, messageId, text);
      await done(rt, GROUP_A, messageId);
    }
    const first = inbox(rt, GROUP_A, 1)!, second = inbox(rt, GROUP_A, 2)!;
    const secondEventId = incoming(rt, GROUP_A, 2)!.id;
    await rt.stop("test_crash_window");
    const db = new Db(h.dirs.dataDir);
    try {
      // 第一条由启动扫描补发；第二条在首次上线派发时接管旧完成任务，
      // child_task.completed 先发起发送，使扫描能遇到当前进程的 pending。
      for (const row of [first, second]) {
        db.prepare("UPDATE qq_inbox SET status = 'queued' WHERE dedup_key = ?").run(row.dedupKey);
        db.prepare("DELETE FROM qq_outbox WHERE task_id = ?").run(row.taskId);
      }
      db.prepare("UPDATE tasks SET agent_id = NULL, source_event_id = NULL, result_summary = NULL, result_ref = NULL WHERE id = ?")
        .run(second.taskId);
      db.prepare("UPDATE inbound_events SET status = 'registered', task_id = NULL WHERE id = ?").run(secondEventId);
    } finally { db.close(); }
    h.onebot.actions.length = 0;
    h.model.calls.length = 0;
    h.onebot.setSendDelayMs(700);

    rt = await Runtime.start(h.config);
    await waitFor("两条恢复回复已发出且尚未收到回执", () => sends(h.onebot).length === 2);
    for (const row of [first, second]) {
      assert.equal(rt.qqStore.getOutboxByTask(row.taskId!)!.status, "pending");
      assert.equal(rt.qqStore.getInbox(row.dedupKey)!.status, "queued", "当前进程 pending 不得被恢复扫描提前记为未知");
    }
    h.onebot.pushRecall({ groupId: GROUP_A, messageId: 1, userId: USER });
    await waitFor("补发尚未收到回执时撤回已落库并记录未知结果", () =>
      inbox(rt, GROUP_A, 1)?.recalled === true && inbox(rt, GROUP_A, 1)?.status === "reply_unknown" &&
      rt.qqStore.getOutboxByTask(first.taskId!)?.status === "unknown", 3_000);
    assert.doesNotMatch(rt.qqStore.getOutboxByTask(first.taskId!)!.error ?? "", /取消后平台返回/, "撤回应在迟到回执前处理");
    await waitFor("补发的迟到成功只追加事实", () =>
      rt.qqStore.getOutboxByTask(first.taskId!)!.error?.includes("取消后平台返回成功") === true);
    await done(rt, GROUP_A, 2);

    const firstTask = rt.store.getTask(first.taskId!)!;
    rt.store.withTx(() => rt.store.appendEvent(
      { type: "task.completed", taskId: firstTask.id, sessionId: firstTask.sessionId },
      { taskId: firstTask.id, sessionId: firstTask.sessionId },
    ));
    push(h.onebot, GROUP_A, 1, "MARK-RECOVER");
    await delay(150);
    const outbox = rt.qqStore.getOutboxByTask(first.taskId!)!;
    assert.equal(outbox.status, "unknown");
    assert.equal(outbox.sentMessageId, null);
    assert.equal(inbox(rt, GROUP_A, 1)!.status, "reply_unknown");
    assert.equal(rt.qqStore.listOutbox({}).length, 2);
    assert.equal(sends(h.onebot).length, 2, "迟到回执、重复消息和重复终态均不重发");
    assert.equal(h.model.calls.length, 0, "恢复已完成任务不重复调用模型");
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});

test("群 chat 的结果摘要按 Unicode 字符截断，不切开表情字符", async () => {
  const h = await harness("qq-bridge-unicode", async () => ({ kind: "text", text: "A" + "😀".repeat(1200) }));
  const rt = await Runtime.start(h.config);
  try {
    await configure(rt, h.onebot);
    push(h.onebot, GROUP_A, 1, "MARK-UNICODE");
    await done(rt, GROUP_A, 1);
    const summary = rt.store.getTask(inbox(rt, GROUP_A, 1)!.taskId!)!.resultSummary!;
    assert.equal([...summary].length, 1000);
    assert.equal(Buffer.from(summary).toString("utf8"), summary);
    assert.ok(summary.endsWith("…（截断）"));
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});

test("同毫秒群收件恢复按登记顺序执行，不按消息号或随机入站 ID 排序", async () => {
  const h = await harness("qq-bridge-fifo-tie");
  let rt = await Runtime.start(h.config);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  try {
    await configure(rt, h.onebot);
    void rt.orchestrator!.serial(() => blocked);
    push(h.onebot, GROUP_A, 20, "MARK-FIRST");
    push(h.onebot, GROUP_A, 10, "MARK-SECOND");
    await waitFor("两条收件均已登记", () => incoming(rt, GROUP_A, 20) !== null && incoming(rt, GROUP_A, 10) !== null);
    const stopping = rt.orchestrator!.stop();
    release();
    await stopping;
    await rt.stop("test_restart");

    const db = new Db(h.dirs.dataDir);
    try {
      const sameTime = new Date().toISOString();
      for (const [messageId, eventId] of [[20, "evt_z_first"], [10, "evt_a_second"]] as const) {
        db.prepare("UPDATE qq_inbox SET created_at = ? WHERE dedup_key = ?").run(sameTime, key(GROUP_A, messageId));
        db.prepare("UPDATE inbound_events SET id = ?, received_at = ? WHERE source = 'qq_group' AND external_id = ?")
          .run(eventId, sameTime, key(GROUP_A, messageId));
      }
    } finally { db.close(); }
    rt = await Runtime.start(h.config);
    await done(rt, GROUP_A, 10);
    assert.deepEqual(h.model.calls.map((call) => lastUserText(call).match(/MARK-[A-Z]+/)?.[0]), ["MARK-FIRST", "MARK-SECOND"]);
    assert.deepEqual(sends(h.onebot).map((action) => (action.params.message as any[])[0].data.id), [20, 10]);
  } finally {
    release();
    await rt.stop("test_end");
    await h.close();
  }
});
