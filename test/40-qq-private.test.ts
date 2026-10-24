import { product as personalProduct } from "./helpers/legacy-product.ts";
/** daily-agent issue 06：真实 Runtime + mock 模型 + 回环 OneBot，不接触真实 QQ。 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { createMockTools } from "@ruukoto/agent/mock-tools.ts";
import { Db } from "@ruukoto/core/db.ts";
import { Runtime, type RuntimeConfig } from "@ruukoto/runtime/runtime.ts";
import { cleanupDirs, lastUserText, makeTestDirs, waitFor, writeModelsJson } from "./helpers/testkit.ts";
import { MockModelServer, type Responder } from "./helpers/mock-provider.ts";
import { MOCK_QQ_ACCOUNT, MOCK_QQ_SECRET, startMockOneBot, type MockOneBot } from "./helpers/mock-onebot.ts";

const OWNER = "880001";
const OTHER = "880002";

const QQ_TIMEOUTS = { actionTimeoutMs: 400, probeIntervalMs: 100, reconnectMinMs: 50, reconnectMaxMs: 150, sweepIntervalMs: 80 };
const reply: Responder = async (req) => ({ kind: "text", text: `REPLY ${lastUserText(req).match(/MARK-[A-Z0-9-]+/g)?.at(-1) ?? "none"}` });

async function harness(prefix: string, responder = reply, scheduler: RuntimeConfig["scheduler"] = {}) {
  const { dirs } = await makeTestDirs(prefix, 0);
  const onebot = await startMockOneBot({});
  const model = new MockModelServer(responder);
  await writeModelsJson(dirs, await model.start());
  const config: RuntimeConfig = {
    product: personalProduct.runtime,
    dataDir: dirs.dataDir, agentDir: dirs.agentDir, socketPath: path.join(dirs.root, "c.sock"),
    thinkingLevel: "off", modelProvider: "mock", modelId: "mock-model", toolFactory: createMockTools,
    telegramDisabled: true, qq: QQ_TIMEOUTS, scheduler: { tickMs: 30, sendTimeoutMs: 1_000, ...scheduler },
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

async function configure(rt: Runtime, onebot: MockOneBot, opts: { owner?: string | null; secret?: string; selfId?: string } = {}) {
  await rt.addCredentialBinding({ name: "qq-test", host: onebot.host, header: "authorization", purpose: "qq_onebot", secret: opts.secret ?? MOCK_QQ_SECRET });
  await rt.qqConfigure({ endpoint: onebot.url, selfId: opts.selfId ?? MOCK_QQ_ACCOUNT, credential: "qq-test", ownerUserId: opts.owner === undefined ? OWNER : opts.owner });
  await rt.qqSetEnabled(true);
}

const mainTasks = (rt: Runtime) => rt.store.listTasksBySession(rt.store.getAgentRole("main")!.sessionId);
const replyOps = (rt: Runtime) => rt.sched.listOps({ limit: 50 }).items.filter((op) => op.sourceKind === "owner_reply");
const sends = (onebot: MockOneBot, action = "send_private_msg") => onebot.actions.filter((item) => item.action === action);
const waitOnline = (rt: Runtime) => waitFor("QQ 已核实登录账号在线", () => {
  const status = rt.qqStatus();
  return status.online === true && status.actualSelfId === status.selfId;
});
const push = (onebot: MockOneBot, messageId: number, text: string, userId = OWNER) =>
  onebot.pushPrivateMessage({ userId, messageId, segments: [{ type: "text", data: { text } }] });
const pause = (ms = 220) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("私聊配置必须有 token 和固定 owner；停用、换 owner、清除 owner 使旧发送与排队任务失效", async () => {
  const h = await harness("qq-private-config", reply, { tickMs: 0 });
  const rt = await Runtime.start(h.config);
  try {
    await assert.rejects(rt.qqConfigure({ endpoint: h.onebot.url, selfId: MOCK_QQ_ACCOUNT, ownerUserId: OWNER }), /token|凭据/);
    await assert.rejects(rt.qqConfigure({ endpoint: h.onebot.url, selfId: MOCK_QQ_ACCOUNT, ownerUserId: "abc" }), /owner|QQ/);
    await configure(rt, h.onebot, { owner: null });
    await waitOnline(rt);
    push(h.onebot, 99, "MARK-NO-OWNER");
    await pause();
    assert.equal(mainTasks(rt).length, 0, "只启用群通道时不接私聊");

    for (const [index, change] of ["disable", "replace", "clear"].entries()) {
      await configure(rt, h.onebot);
      await waitOnline(rt);
      push(h.onebot, index + 1, `MARK-HOLD-${index}`);
      await waitFor("回复待发送", () => replyOps(rt).some((op) => op.text === `REPLY MARK-HOLD-${index}` && op.status === "pending"));
      const op = replyOps(rt).find((item) => item.text === `REPLY MARK-HOLD-${index}`)!;
      if (change === "disable") await rt.qqSetEnabled(false);
      else await rt.qqConfigure({ endpoint: h.onebot.url, credential: "qq-test", selfId: MOCK_QQ_ACCOUNT, ownerUserId: change === "replace" ? OTHER : null });
      await rt.scheduler!.tick();
      await waitFor("旧回复取消", () => rt.sched.getOp(op.id)?.status === "canceled");
      assert.equal(rt.sched.getOp(op.id)!.target.chatId, OWNER, "旧操作不得改发新 owner");
    }
    assert.equal(sends(h.onebot).length, 0);

    await configure(rt, h.onebot);
    await waitOnline(rt);
    const main = rt.store.getAgentRole("main")!;
    rt.store.setSessionQueueState(main.sessionId, "paused", "test_fixture");
    push(h.onebot, 4, "MARK-QUEUED-OLD-OWNER");
    await waitFor("旧 owner 任务排队", () => mainTasks(rt).some((task) => task.input.includes("MARK-QUEUED") && task.status === "queued"));
    const queued = mainTasks(rt).find((task) => task.input.includes("MARK-QUEUED"))!;
    await rt.qqConfigure({ endpoint: h.onebot.url, selfId: MOCK_QQ_ACCOUNT, ownerUserId: OTHER });
    await rt.resumeQueue(main.sessionId);
    await waitFor("旧配置下任务失效", () => rt.store.getTask(queued.id)?.status === "canceled");
    assert.ok(!h.model.calls.some((call) => lastUserText(call).includes("MARK-QUEUED")));
    await waitOnline(rt);
    push(h.onebot, 4, "MARK-NEW-OWNER", OTHER);
    await waitFor("新 owner 可复用相同消息 ID", () => replyOps(rt).some((op) => op.text === "REPLY MARK-NEW-OWNER"));
    await rt.scheduler!.tick();
    await waitFor("新 owner 回复已发送", () => sends(h.onebot).length === 1);
    assert.equal(String(sends(h.onebot)[0]!.params.user_id), OTHER);
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});

test("启动配置停用的 QQ 入口按停用处理：排队任务按 qq_private_unavailable 取消，main 队列后面的任务照常运行", async () => {
  const h = await harness("qq-private-startup-disabled", reply, { tickMs: 0 });
  let rt = await Runtime.start(h.config);
  let queuedId = "";
  try {
    await configure(rt, h.onebot);
    await waitOnline(rt);
    const main = rt.store.getAgentRole("main")!;
    rt.store.setSessionQueueState(main.sessionId, "paused", "test_fixture");
    push(h.onebot, 1, "MARK-BEFORE-DISABLE");
    await waitFor("QQ 任务排队", () => mainTasks(rt).some((task) => task.input.includes("MARK-BEFORE-DISABLE") && task.status === "queued"));
    queuedId = mainTasks(rt).find((task) => task.input.includes("MARK-BEFORE-DISABLE"))!.id;
  } finally {
    await rt.stop("test_end");
  }
  h.config.qqDisabled = true;
  rt = await Runtime.start(h.config);
  try {
    assert.equal((rt.qqStatus() as { disabledByConfig?: boolean }).disabledByConfig, true);
    const main = rt.store.getAgentRole("main")!;
    const tui = await rt.submit({ sessionId: main.sessionId, requestId: "after-qq", input: "MARK-TUI-AFTER", accessMode: "confirm", modelSelection: rt.defaultSelection });
    await rt.resumeQueue(main.sessionId);
    await waitFor("后面的 TUI 任务照常完成", () => rt.store.getTask(tui.id)?.status === "completed");
    const canceled = rt.store.getTask(queuedId)!;
    assert.equal(canceled.status, "canceled");
    assert.match(canceled.errorMessage ?? "", /^qq_private_unavailable:/);
    assert.ok(!h.model.calls.some((call) => lastUserText(call).includes("MARK-BEFORE-DISABLE")), "停用入口的任务不调用模型");
    assert.equal(h.onebot.connectionCount(), 0, "启动停用后不连接 NapCat");
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});

test("重启恢复已登记未建任务；补登只取原任务回答；sending 记未知且重投不重复", async () => {
  const h = await harness("qq-private-recover", reply, { tickMs: 0 });
  let rt = await Runtime.start(h.config);
  try {
    await configure(rt, h.onebot);
    await waitOnline(rt);
    for (const [id, marker] of [[1, "MARK-A"], [2, "MARK-B"]] as const) {
      push(h.onebot, id, marker);
      await waitFor(`${marker} 已入账`, () => replyOps(rt).some((op) => op.text === `REPLY ${marker}`));
    }
    const taskA = mainTasks(rt).find((task) => task.input.includes("MARK-A"))!;
    const opA = replyOps(rt).find((op) => op.taskId === taskA.id)!;
    const opB = replyOps(rt).find((op) => op.text === "REPLY MARK-B")!;
    const { event: registered } = rt.store.withTx(() => rt.store.registerInboundEvent({
      source: "qq_private", externalId: `${MOCK_QQ_ACCOUNT}:${OWNER}:3`, actor: `qq_private:${OWNER}`, targetRole: "main", body: "[QQ 私聊] MARK-C",
      replyTarget: opA.target,
    }));
    await rt.stop("test_restart");
    const db = new Db(h.config.dataDir);
    db.prepare("DELETE FROM notification_ops WHERE id = ?").run(opA.id);
    db.prepare("UPDATE tasks SET result_summary = NULL, result_ref = NULL WHERE id = ?").run(taskA.id);
    db.prepare("UPDATE notification_ops SET status = 'sending' WHERE id = ?").run(opB.id);
    db.close();

    rt = await Runtime.start(h.config);
    await waitOnline(rt);
    await waitFor("已登记消息恢复完成", () => rt.store.getInboundEvent(registered.id)?.status === "done");
    await rt.scheduler!.tick();
    await waitFor("原任务与恢复任务发送完成", () => replyOps(rt).filter((op) => op.status === "sent").length === 2);
    assert.equal(rt.sched.getOp(opB.id)!.status, "effect_unknown");
    assert.equal(replyOps(rt).find((op) => op.taskId === taskA.id)!.text, "REPLY MARK-A", "main 后续回答不能替换 A 的回答");
    assert.deepEqual(sends(h.onebot).map((item) => (item.params.message as any[]).find((segment) => segment.type === "text").data.text).sort(), ["REPLY MARK-A", "REPLY MARK-C"]);
    for (const [id, marker] of [[1, "MARK-A"], [2, "MARK-B"], [3, "MARK-C"]] as const) push(h.onebot, id, marker);
    await pause(300);
    await rt.scheduler!.tick();
    assert.equal(mainTasks(rt).length, 3);
    assert.equal(replyOps(rt).length, 3);
    assert.equal(sends(h.onebot).length, 2, "sending 与已发送操作均不自动重放");
  } finally {
    await rt.stop("test_end");
    await h.close();
  }
});
