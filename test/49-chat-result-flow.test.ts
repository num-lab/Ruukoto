/** issue 09：真实 Driver/审批/outbox 链路，模型与 QQ 均为本地 mock。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { NotifyTarget } from "../src/core/types.ts";
import { qqDedupKey } from "../src/qq/store.ts";
import type { NotifyChannel } from "../src/scheduler/runtime.ts";
import { lastUserText, pendingConfirmation, startTestRuntime, waitFor } from "./helpers/testkit.ts";
import type { RecordedRequest, Responder } from "./helpers/mock-provider.ts";
import { MOCK_QQ_ACCOUNT, MOCK_QQ_SECRET, startMockOneBot } from "./helpers/mock-onebot.ts";

const GROUP = "100001";
const USER = "880001";
const TARGET: NotifyTarget = { channel: "mock", account: "notification-bot", chatId: "fixed-owner", configVersion: 1 };
const SUMMARY = "群讨论结果：周五发布。";
const toolNames = (req: RecordedRequest) => (req.tools ?? []).map((tool: any) => tool.function?.name ?? tool.name);
type Call = { name: string; arguments: Record<string, unknown> };

/** 每个 main 请求按实际模型回合依次调用工具，群回复只返回文本。 */
function scripted(actions: (input: string) => Call[]): Responder {
  const steps = new Map<string, number>();
  return async (req) => {
    const input = lastUserText(req);
    if (input.startsWith("[qq:")) return { kind: "text", text: SUMMARY };
    const step = steps.get(input) ?? 0;
    steps.set(input, step + 1);
    const action = actions(input)[step];
    return action
      ? { kind: "tool_calls", calls: [{ id: `call-${step}`, ...action }] }
      : { kind: "text", text: "处理完成" };
  };
}

async function harness(prefix: string, responder: Responder) {
  const onebot = await startMockOneBot({});
  const channel: NotifyChannel & { online: boolean; sends: Array<{ opId: string; text: string; target: NotifyTarget }> } = {
    online: false,
    sends: [] as Array<{ opId: string; text: string; target: NotifyTarget }>,
    target: () => ({ ...TARGET }),
    available: () => channel.online,
    async send(input: { opId: string; text: string; target: NotifyTarget; signal: AbortSignal }) {
      channel.sends.push({ opId: input.opId, text: input.text, target: input.target });
      return { platformMessageId: `mock-${channel.sends.length}` };
    },
  };
  const t = await startTestRuntime(prefix, responder, {
    workDirs: 0,
    config: {
      telegramDisabled: true,
      qq: { actionTimeoutMs: 1000, probeIntervalMs: 100, reconnectMinMs: 30, reconnectMaxMs: 100, sweepIntervalMs: 50 },
      scheduler: { channel, tickMs: 0 },
    },
  });
  const rt = t.runtime;
  rt.addCredentialBinding({ name: "qq-test", host: onebot.host, header: "authorization", purpose: "qq_onebot", secret: MOCK_QQ_SECRET });
  await rt.qqConfigure({ endpoint: onebot.url, selfId: MOCK_QQ_ACCOUNT, credential: "qq-test" });
  await rt.qqGroupUpdate({ groupId: GROUP, allow: true });
  await rt.qqSetEnabled(true);
  await waitFor("本地 QQ 在线", () => rt.qqStatus().online === true);
  const main = rt.store.getAgentRole("main")!;
  return {
    ...t, onebot, channel, main,
    async group(messageId: number) {
      onebot.pushGroupMessage({ groupId: GROUP, userId: USER, messageId,
        segments: [{ type: "at", data: { qq: MOCK_QQ_ACCOUNT } }, { type: "text", data: { text: `GROUP-PRIVATE-${messageId}` } }] });
      const key = qqDedupKey(MOCK_QQ_ACCOUNT, GROUP, String(messageId));
      await waitFor("群回复完成并登记 chat 结果", () => rt.qqStore.getInbox(key)?.status === "done" && rt.store.findInboundEvent("qq_group", key)?.status === "done");
      return rt.store.getTask(rt.qqStore.getInbox(key)!.taskId!)!;
    },
    submit(input: string) {
      return rt.submit({ sessionId: main.sessionId, requestId: input, input, accessMode: "full_access", modelSelection: rt.defaultSelection });
    },
    complete(taskId: string) {
      return waitFor("main 任务完成", () => rt.store.getTask(taskId)?.status === "completed");
    },
    ops() { return rt.sched.listOps({}).items; },
    async close() { await t.shutdown(); await onebot.close(); },
  };
}

test("群结果工具仅 main 可见；普通群回复不唤醒 main，未接收摘要不能申请通知", async () => {
  let taskId = "";
  const h = await harness("chat-flow-tools", scripted((input) => input === "MAIN-UNACCEPTED"
    ? [{ name: "notification_enqueue", arguments: { content: [{ kind: "chat_result", task_id: taskId }], reason: "发送群摘要" } }]
    : []));
  const rt = h.runtime;
  try {
    const group = await h.group(1);
    taskId = group.id;
    assert.equal(rt.store.listTasksBySession(h.main.sessionId).length, 0);
    assert.deepEqual(h.ops(), [], "普通群回复不登记公共通知或 owner_reply");
    assert.equal(h.onebot.actions.filter((action) => action.action === "send_group_msg").length, 1);
    assert.deepEqual(toolNames(h.server.calls.find((req) => lastUserText(req).startsWith("[qq:"))!), []);
    for (const name of ["coding", "chat"] as const) {
      const role = rt.store.getAgentRole(name)!;
      const task = await rt.submit({ sessionId: role.sessionId, requestId: name, input: `ROLE-${name}`, modelSelection: rt.defaultSelection });
      await h.complete(task.id);
      const names = toolNames(h.server.calls.find((req) => lastUserText(req) === `ROLE-${name}`)!);
      assert.ok(!names.includes("chat_result_list") && !names.includes("chat_result_accept"));
    }
    const main = await h.submit("MAIN-UNACCEPTED");
    await h.complete(main.id);
    const names = toolNames(h.server.calls.find((req) => lastUserText(req) === "MAIN-UNACCEPTED")!);
    assert.ok(names.includes("chat_result_list") && names.includes("chat_result_accept"));
    assert.match(rt.store.listToolOpsByTask(main.id)[0].resultSummary!, /尚未经 main 明确接收/);
    assert.equal(rt.store.listConfirmationsByTask(main.id).length, 0);
    assert.deepEqual(h.ops(), []);
    assert.deepEqual(h.channel.sends, []);
  } finally { await h.close(); }
});

test("main 接收不外发；群摘要通知在 full_access 下仍需审批，批准与发送沿用固定快照", async () => {
  let taskId = "";
  const h = await harness("chat-flow-approved", scripted((input) => {
    if (input === "MAIN-ACCEPT") return [
      { name: "chat_result_list", arguments: {} },
      { name: "chat_result_accept", arguments: { task_id: taskId, reason: "整理讨论结果" } },
    ];
    return input === "MAIN-NOTIFY" ? [{ name: "notification_enqueue", arguments: { content: [{ kind: "chat_result", task_id: taskId }], reason: "告知拥有者" } }] : [];
  }));
  const rt = h.runtime;
  try {
    taskId = (await h.group(1)).id;
    const accept = await h.submit("MAIN-ACCEPT");
    await h.complete(accept.id);
    const snapshot = rt.store.getAcceptedChatResult(h.main.projectId, taskId)!;
    assert.equal(snapshot.summary, SUMMARY);
    assert.deepEqual(h.ops(), [], "仅接收不建立通知");
    assert.equal(rt.store.listConfirmationsByTask(accept.id).length, 0);
    assert.deepEqual(h.channel.sends, []);
    const notify = await h.submit("MAIN-NOTIFY");
    const confirmation = await pendingConfirmation(h.client, notify.id);
    assert.equal(rt.store.getTask(notify.id)!.accessMode, "full_access");
    assert.equal(confirmation.scope.kind, "notification");
    assert.equal(rt.store.getConfirmation(confirmation.id)!.params.text, SUMMARY);
    assert.deepEqual(confirmation.scope.target, TARGET);
    assert.deepEqual(h.ops(), [], "批准前未登记通知");
    rt.store.db.prepare("UPDATE tasks SET result_summary = ? WHERE id = ?").run("原结果后来改变", taskId);
    await h.client.request("respond_confirmation", { confirmation_id: confirmation.id, decision: "approve" });
    await h.complete(notify.id);
    await rt.scheduler.idle();
    const [op] = h.ops();
    assert.equal(op.status, "pending");
    assert.equal(op.text, SUMMARY);
    assert.deepEqual(op.target, TARGET);
    assert.deepEqual(op.sourceRefs.map((ref) => [ref.kind, ref.ref, ref.version]), [["chat_result", `chat_result:${taskId}`, snapshot.acceptedAt]]);
    assert.ok(rt.store.getConfirmation(confirmation.id)!.consumedAt);
    assert.deepEqual(h.channel.sends, []);
    h.channel.online = true;
    await rt.scheduler.tick();
    await rt.scheduler.idle();
    assert.equal(rt.sched.getOp(op.id)!.status, "sent");
    assert.deepEqual(h.channel.sends, [{ opId: op.id, text: SUMMARY, target: TARGET }]);
    assert.ok(h.ops().every((item) => item.sourceKind !== "owner_reply"));
  } finally { await h.close(); }
});

test("群消息在审批期间或批准后发送前撤回，都不能继续外发摘要", async () => {
  for (const phase of ["approval", "pending"] as const) {
    let taskId = "";
    const h = await harness(`chat-flow-recall-${phase}`, scripted((input) => input === "MAIN-ACCEPT-NOTIFY" ? [
      { name: "chat_result_accept", arguments: { task_id: taskId, reason: "整理群摘要" } },
      { name: "notification_enqueue", arguments: { content: [{ kind: "chat_result", task_id: taskId }], reason: "发送摘要" } },
    ] : []));
    const rt = h.runtime;
    try {
      taskId = (await h.group(1)).id;
      const task = await h.submit("MAIN-ACCEPT-NOTIFY");
      const confirmation = await pendingConfirmation(h.client, task.id);
      if (phase === "pending") {
        await h.client.request("respond_confirmation", { confirmation_id: confirmation.id, decision: "approve" });
        await h.complete(task.id);
        await rt.scheduler.idle();
        assert.equal(h.ops()[0].status, "pending");
      }
      h.onebot.pushRecall({ groupId: GROUP, messageId: 1, userId: USER });
      await waitFor("群消息撤回已落库", () => rt.qqStore.getInboxByTask(taskId)?.recalled === true);
      if (phase === "approval") {
        await h.client.request("respond_confirmation", { confirmation_id: confirmation.id, decision: "approve" });
        await h.complete(task.id);
        assert.deepEqual(h.ops(), [], "审批期间撤回使通知登记失败");
        assert.equal(rt.store.getConfirmation(confirmation.id)!.consumedAt, null);
        assert.match(rt.store.listToolOpsByTask(task.id).find((op) => op.toolName === "notification_enqueue")!.resultSummary!, /通知资料已失效.*撤回/);
      }
      h.channel.online = true;
      await rt.scheduler.tick();
      await rt.scheduler.idle();
      if (phase === "pending") {
        assert.equal(h.ops()[0].status, "canceled");
        assert.match(h.ops()[0].errorMessage!, /source_revoked.*撤回/);
      }
      assert.deepEqual(h.channel.sends, [], `${phase} 撤回后不调用通知发送器`);
      assert.ok(h.ops().every((op) => op.sourceKind !== "owner_reply"));
    } finally { await h.close(); }
  }
});
