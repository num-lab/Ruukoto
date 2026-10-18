/** 共享群资料与宿主 outbox 链路；群结果由播种助手按旧形态直接写入（核心群聊已退役）。 */
import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessMode, NotifyTarget } from "@ruukoto/core/types.ts";
import type { NotifyChannel } from "@ruukoto/channels/scheduler/runtime.ts";
import { resolveAcceptedChatResult } from "@ruukoto/channels/chat-results.ts";
import { sha256 } from "@ruukoto/channels/scheduler/store.ts";
import { lastUserText, startTestRuntime, waitFor } from "./helpers/testkit.ts";
import type { RecordedRequest, Responder } from "./helpers/mock-provider.ts";
import { MOCK_QQ_ACCOUNT, MOCK_QQ_SECRET, startMockOneBot } from "./helpers/mock-onebot.ts";
import { legacyGroupArchive } from "./helpers/legacy-group-archive.ts";

const GROUP = "100001";
const USER = "880001";
const TARGET: NotifyTarget = { channel: "mock", account: "notification-bot", chatId: "fixed-owner", configVersion: 1 };
const SUMMARY = "群讨论结果：周五发布。";
const toolNames = (req: RecordedRequest) => (req.tools ?? []).map((tool: any) => tool.function?.name ?? tool.name);
type Call = { name: string; arguments: Record<string, unknown> };

/** 每个 main 请求按实际模型回合依次调用工具。 */
function scripted(actions: (input: string) => Call[]): Responder {
  const steps = new Map<string, number>();
  return async (req) => {
    const input = lastUserText(req);
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
  await rt.addCredentialBinding({ name: "qq-test", host: onebot.host, header: "authorization", purpose: "qq_onebot", secret: MOCK_QQ_SECRET });
  await rt.qqConfigure({ endpoint: onebot.url, selfId: MOCK_QQ_ACCOUNT, credential: "qq-test" });
  await rt.qqSetEnabled(true);
  await waitFor("本地 QQ 在线", () => rt.qqStatus().online === true);
  const main = rt.store.getAgentRole("main")!;
  const archive = legacyGroupArchive({ store: rt.store, qq: rt.qqStore, workRoot: t.dirs.root });
  const group = archive.seedGroup({ account: MOCK_QQ_ACCOUNT, groupId: GROUP });
  return {
    ...t, onebot, channel, main, archive, group,
    /** 播种一条已完成并被正确记录的旧群结果（含收件/入站/任务与结果）。 */
    groupResult(messageId: string) {
      const seeded = group.seedTask({ userId: USER, messageId, state: "completed", summary: SUMMARY });
      return seeded.task!;
    },
    submit(input: string, accessMode: AccessMode = "full_access") {
      return rt.submit({ sessionId: main.sessionId, requestId: input, input, accessMode, modelSelection: rt.defaultSelection });
    },
    complete(taskId: string) {
      return waitFor("main 任务完成", () => rt.store.getTask(taskId)?.status === "completed");
    },
    enqueue(taskId: string) {
      return rt.store.withTx(() => {
        const accepted = resolveAcceptedChatResult(rt.store, rt.qqStore, main.projectId, taskId);
        return rt.sched.insertOp({
          sourceKind: "confirmation", sourceKey: `host:${taskId}`, taskId: null, hostOpId: null,
          target: { ...TARGET }, text: accepted.summary,
          sourceRefs: [{ kind: "chat_result", ref: `chat_result:${taskId}`, version: accepted.acceptedAt, sha256: sha256(accepted.summary) }],
        }).op;
      });
    },
    ops() { return rt.sched.listOps({}).items; },
    async close() { await t.shutdown(); await onebot.close(); },
  };
}

test("群结果工具仅 main 可见；归档群结果不唤醒 main，宿主不能引用未接收摘要", async () => {
  const h = await harness("chat-flow-tools", scripted(() => []));
  const rt = h.runtime;
  try {
    const seeded = h.groupResult("1");
    const taskId = seeded.id;
    assert.equal(rt.store.listTasksBySession(h.main.sessionId).length, 0, "归档群结果不建 main 任务");
    assert.deepEqual(h.ops(), [], "归档群结果不登记公共通知或 owner_reply");
    assert.equal(h.onebot.actions.filter((action) => action.action === "send_group_msg").length, 0, "不再有群回复");
    assert.ok(!h.server.calls.some((req) => lastUserText(req).startsWith("[qq:")), "不再有群模型调用");
    assert.equal(rt.store.getAgentRole("chat"), null, "新核心不引导 chat 角色");
    {
      // 普通开发会话（固定 coding 已退役，issue 23）没有群结果工具
      const dir = path.join(h.dirs.root, "dev-work");
      fs.mkdirSync(dir, { recursive: true });
      const dev = await rt.createSession({ projectName: "dev", cwd: dir });
      const task = await rt.submit({ sessionId: dev.id, requestId: "dev", input: "ROLE-dev", modelSelection: rt.defaultSelection });
      await h.complete(task.id);
      const names = toolNames(h.server.calls.find((req) => lastUserText(req) === "ROLE-dev")!);
      assert.ok(!names.includes("chat_result_list") && !names.includes("chat_result_accept"));
    }
    const main = await h.submit("MAIN-UNACCEPTED");
    await h.complete(main.id);
    const names = toolNames(h.server.calls.find((req) => lastUserText(req) === "MAIN-UNACCEPTED")!);
    assert.ok(names.includes("chat_result_list") && names.includes("chat_result_accept"));
    assert.throws(() => h.enqueue(taskId), /尚未经 main 明确接收/);
    assert.equal(rt.store.listConfirmationsByTask(main.id).length, 0);
    assert.deepEqual(h.ops(), []);
    assert.deepEqual(h.channel.sends, []);
  } finally { await h.close(); }
});

test("main 接收不外发；宿主通知引用固定快照并等待渠道上线", async () => {
  let taskId = "";
  const h = await harness("chat-flow-host", scripted((input) => input === "MAIN-ACCEPT" ? [
    { name: "chat_result_list", arguments: {} },
    { name: "chat_result_accept", arguments: { task_id: taskId, reason: "整理讨论结果" } },
  ] : []));
  const rt = h.runtime;
  try {
    taskId = h.groupResult("1").id;
    const accept = await h.submit("MAIN-ACCEPT");
    await h.complete(accept.id);
    const snapshot = rt.store.getAcceptedChatResult(h.main.projectId, taskId)!;
    assert.equal(snapshot.summary, SUMMARY);
    assert.deepEqual(h.ops(), [], "仅接收不建立通知");
    assert.equal(rt.store.listConfirmationsByTask(accept.id).length, 0);
    assert.deepEqual(h.channel.sends, []);
    rt.store.db.prepare("UPDATE tasks SET result_summary = ? WHERE id = ?").run("原结果后来改变", taskId);
    const op = h.enqueue(taskId);
    await rt.scheduler!.tick();
    await rt.scheduler!.idle();
    assert.equal(rt.sched.getOp(op.id)!.status, "pending");
    assert.equal(op.text, SUMMARY);
    assert.deepEqual(op.target, TARGET);
    assert.deepEqual(op.sourceRefs.map((ref) => [ref.kind, ref.ref, ref.version]), [["chat_result", `chat_result:${taskId}`, snapshot.acceptedAt]]);
    assert.deepEqual(h.channel.sends, []);
    h.channel.online = true;
    await rt.scheduler!.tick();
    await rt.scheduler!.idle();
    assert.equal(rt.sched.getOp(op.id)!.status, "sent");
    assert.deepEqual(h.channel.sends, [{ opId: op.id, text: SUMMARY, target: TARGET }]);
    assert.ok(h.ops().every((item) => item.sourceKind !== "owner_reply"));
  } finally { await h.close(); }
});

test("归档群消息在宿主登记前或待发期间撤回，都不能继续外发摘要", async () => {
  for (const phase of ["enqueue", "pending"] as const) {
    let taskId = "";
    const h = await harness(`chat-flow-recall-${phase}`, scripted((input) => input === "MAIN-ACCEPT" ? [
      { name: "chat_result_accept", arguments: { task_id: taskId, reason: "整理群摘要" } },
    ] : []));
    const rt = h.runtime;
    try {
      taskId = h.groupResult("1").id;
      await h.complete((await h.submit("MAIN-ACCEPT")).id);
      const op = phase === "pending" ? h.enqueue(taskId) : null;
      // 已退役入口仍观测撤回：归档收件打标后，宿主解析与发送复核均阻断外发。
      h.onebot.pushRecall({ groupId: GROUP, messageId: 1, userId: USER });
      await waitFor("群消息撤回已落库", () => rt.qqStore.getInboxByTask(taskId)?.recalled === true);
      if (phase === "enqueue") {
        assert.throws(() => h.enqueue(taskId), /撤回/);
        assert.deepEqual(h.ops(), [], "失效来源不能登记通知");
      }
      h.channel.online = true;
      await rt.scheduler!.tick();
      await rt.scheduler!.idle();
      if (op) {
        assert.equal(rt.sched.getOp(op.id)!.status, "canceled");
        assert.match(rt.sched.getOp(op.id)!.errorMessage!, /source_revoked.*撤回/);
      }
      assert.deepEqual(h.channel.sends, [], `${phase} 撤回后不调用通知发送器`);
      assert.ok(h.ops().every((item) => item.sourceKind !== "owner_reply"));
    } finally { await h.close(); }
  }
});
