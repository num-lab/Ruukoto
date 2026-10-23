import { delegateFromActiveTask, messageFromActiveTask } from "./helpers/active-subagent-source.ts";
import { product as personalProduct } from "./helpers/legacy-product.ts";
import { HOST_REVIEW_DEFINITION } from "@ruukoto/agent/subagent-roles.ts";
import { CredentialStore } from "@ruukoto/agent/execution/credentials.ts";
import type { GitHubPullRequestEvent } from "@ruukoto/channels/github/webhook.ts";
/**
 * 后台重启后恢复 SubAgent 与工作记录（agent-direction issue 15）。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-05-subagent-restart-recovery.md
 *
 * seam：Runtime 进程内重启（与 46 同法：stop("test_restart") 后重新 Runtime.start；
 * recover 与编排器启动恢复随之真实执行），mock 模型 + 真实只读工具（realTools，
 * local 后端）。崩溃前的持久形态由真实委派 + insertQueuedTask / SQL 置位播种
 * （与 82/85 同法）；排队任务从未启动，播种即终态前置，不涉及竞态。
 *
 * 覆盖验收：
 * - 排队的拥有者委派子任务重启定 interrupted(backend_restart)：不自动继续、
 *   不当作成功或新委派（零模型请求）；巡检补记一次结果，重复启动不重复登记；
 *   结果引用保持 工作/Agent/父会话/父任务 归属；SubAgent 回 idle 可继续委派；
 *   dev 父会话下一轮模型调用注入该结果（拥有者据此决定继续）。
 * - 重启时 running 的子任务：结果未知；遗留占用保留、子会话
 *   occupancy_unverified 暂停不被编排器启动恢复解除、Agent 记 unverified 且
 *   拒绝新委派（未核实前不与旧执行并发）；拥有者 resume-queue 核实后释放
 *   占用、解除暂停、Agent 回 idle 并可继续委派。
 * - 宿主固定评审（带 source_event_id）的排队子任务不中断：子会话的
 *   backend_restart 暂停由编排器启动恢复自动解除并继续执行（角色会话同口径）。
 * - 已批准但未完成的工具操作按现有账本核实（recover 的 settleAll 扫全部任务，
 *   SubAgent 任务共用同一账本表），由 43 项既有验证覆盖，本文件不重复播种。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { MockModelServer, type Responder } from "./helpers/mock-provider.ts";
import { inputText, cleanupDirs, lastUserText, makeTestDirs, realTools, waitFor, writeModelsJson } from "./helpers/testkit.ts";
import { Runtime, RuntimeApiError, type RuntimeConfig } from "@ruukoto/runtime/runtime.ts";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import { randomId, type AccessMode, type NotifyTarget, type SubAgentMessage } from "@ruukoto/core/types.ts";
import { subAgentTaskRequestId } from "@ruukoto/agent/subagent-ledger.ts";

/** 事件表里的某类事件。 */
function eventsOf(rt: Runtime, type: string): any[] {
  const rows = rt.store.db.prepare("SELECT body FROM events").all() as Array<{ body: string }>;
  return rows.map((r) => JSON.parse(r.body)).filter((b) => b.type === type);
}

const responder: Responder = (req) => {
  const text = lastUserText(req);
  if (text.includes("[SubAgent 委派")) {
    if (text.includes("REVIEW-MARK")) return { kind: "text", text: "REVIEW-DONE 评审结论" };
    if (text.includes("MARK-CONT")) return { kind: "text", text: "SUB-继续结论" };
    return { kind: "text", text: "SUB-DONE 结论" };
  }
  return { kind: "text", text: "父回复" };
};

async function startKit(prefix: string) {
  const { dirs, work } = await makeTestDirs(prefix, 2);
  const server = new MockModelServer(responder);
  await writeModelsJson(dirs, await server.start());
  const config: RuntimeConfig = {
    product: personalProduct.runtime,
    dataDir: dirs.dataDir,
    agentDir: dirs.agentDir,
    thinkingLevel: "off",
    modelProvider: "mock",
    modelId: "mock-model",
    ...realTools(),
  };
  const rt = await Runtime.start(config);
  return {
    dirs,
    work,
    server,
    config,
    rt,
    async restart(current: Runtime): Promise<Runtime> {
      await current.stop("test_restart");
      return Runtime.start(config);
    },
    async shutdown(current: Runtime) {
      await current.stop("test_end");
      await server.close();
      await cleanupDirs(dirs);
    },
  };
}

/** 建父会话与完成的父任务，并完成首次委派（SubAgent 回到 idle）。 */
async function baseWork(kit: Awaited<ReturnType<typeof startKit>>, rt: Runtime, key: string, accessMode: AccessMode = "confirm") {
  const session = await rt.createSession({ projectName: "prec", cwd: kit.work[0]! });
  const parent = await rt.submit({ sessionId: session.id, requestId: `${key}-p1`, input: "开始", accessMode, modelSelection: rt.defaultSelection });
  await waitFor("父完成", () => rt.store.getTask(parent.id)!.status === "completed");
  const d = await delegateFromActiveTask(rt, {
    parentTaskId: parent.id,
    key,
    request: `首任务${key}`,
    readPaths: ["."],
    materials: null,
    paramsDigest: `d-${key}`,
  });
  await waitFor("首任务完成", () => rt.store.getTask(d.task.id)!.status === "completed");
  await waitFor("Agent 空闲", () => rt.store.getSubAgent(d.agent.id)!.state === "idle");
  return { session, parent, d };
}

/** 播种同一工作下的一条排队任务（崩溃前的持久形态；来源事件由参数控制）。 */
function seedQueued(rt: Runtime, d: Awaited<ReturnType<typeof baseWork>>["d"], parentTaskId: string, key: string, input: string, sourceEventId: string | null = null) {
  return rt.store.withTx(() =>
    rt.store.insertQueuedTask({
      sessionId: d.agent.sessionId,
      requestId: subAgentTaskRequestId(d.work.id, key),
      input,
      accessMode: rt.store.getTask(d.task.id)!.accessMode,
      sourcePermissionVersion: rt.store.getTask(d.task.id)!.sourcePermissionVersion,
      modelSelection: rt.defaultSelection,
      submissionDigest: `fixture-${key}`,
      parentTaskId,
      workId: d.work.id,
      subAgentId: d.agent.id,
      sourceEventId,
      readScope: rt.store.getTask(d.task.id)!.readScope,
    }).task,
  );
}

/** 启动或配置门闩窗口遗留的消息：真实持久行，补投由 Runtime 入口接线触发。 */
function seedPending(rt: Runtime, d: Awaited<ReturnType<typeof baseWork>>["d"], parentTaskId: string, marker: string): SubAgentMessage {
  const msg: SubAgentMessage = {
    id: randomId("smsg"), workId: d.work.id, parentSessionId: d.work.parentSessionId,
    fromSubAgentId: null, fromTaskId: parentTaskId, accessMode: rt.store.getTask(parentTaskId)!.accessMode, sourcePermissionVersion: rt.store.getTask(parentTaskId)!.permissionVersion, toSubAgentId: d.agent.id,
    requestKey: marker, paramsDigest: `digest-${marker}`, body: marker, createdAt: new Date().toISOString(),
    deliveredTaskId: null, deliveredAt: null, undeliveredReason: null,
  };
  rt.store.withTx(() => rt.store.insertSubAgentMessage(msg));
  return msg;
}

test("排队中的拥有者委派：重启定 interrupted、补记一次、Agent 回 idle、由拥有者决定继续", async () => {
  const kit = await startKit("recover-queued");
  let rt = kit.rt;
  try {
    const { session, parent, d } = await baseWork(kit, rt, "q1");
    const queued = seedQueued(rt, d, parent.id, "b-queued", "排队任务MARK-Q1");
    assert.equal(queued.status, "queued");

    // —— 第一次启动恢复 ——
    rt = await kit.restart(rt);
    const after = rt.store.getTask(queued.id)!;
    assert.equal(after.status, "interrupted");
    assert.equal(after.interruptReason, "backend_restart");
    assert.equal(after.startedAt, null, "排队任务从未启动");
    assert.ok(after.resultSummary !== null, "巡检补记一次结果");
    assert.ok(after.resultSummary!.includes("结果未知") || after.resultSummary!.includes("中断"), "标明中断而非成功");
    // 归属关系保持：结果引用固定 工作/Agent/父会话/父任务
    const ref = JSON.parse(after.resultRef!);
    assert.equal(ref.workId, d.work.id);
    assert.equal(ref.subAgentId, d.agent.id);
    assert.equal(ref.parentSessionId, session.id);
    assert.equal(ref.parentTaskId, parent.id);
    assert.equal(ref.outcome, "unknown");
    // 不自动继续、也不当作新委派：该任务零模型请求
    assert.equal(kit.server.calls.filter((c) => inputText(c).includes("MARK-Q1")).length, 0);
    assert.equal(eventsOf(rt, "subagent_task.result_unknown").filter((e) => e.taskId === queued.id).length, 1);
    // Agent 回 idle；子会话不因已中断任务保持暂停
    const agent = rt.store.getSubAgent(d.agent.id)!;
    assert.equal(agent.state, "idle");
    assert.equal(agent.currentTaskId, null);
    assert.equal(rt.store.getSession(d.agent.sessionId)!.queueState, "active");

    // —— 重复启动不重复登记 ——
    rt = await kit.restart(rt);
    assert.equal(rt.store.getTask(queued.id)!.resultSummary, after.resultSummary);
    assert.equal(eventsOf(rt, "subagent_task.result_unknown").filter((e) => e.taskId === queued.id).length, 1);

    // —— dev 父会话下一轮模型调用注入该结果（拥有者据此决定继续） ——
    const parent2 = await rt.submit({ sessionId: session.id, requestId: "q1-p2", input: "第二轮", modelSelection: rt.defaultSelection });
    await waitFor("父第二轮完成", () => rt.store.getTask(parent2.id)!.status === "completed");
    const marks = kit.server.calls.map((c) => inputText(c));
    assert.ok(marks.some((m) => m.includes("[SubAgent 结果]") && m.includes(d.work.id)), "中断结果注入 dev 父模型");

    // —— 空闲 Agent 沿同一工作继续委派 ——
    const d2 = await delegateFromActiveTask(rt, {
      parentTaskId: parent2.id,
      key: "q1-r2",
      request: "继续MARK-CONT",
      workId: d.work.id,
      readPaths: ["."],
      materials: null,
      paramsDigest: "d-q1-r2",
    });
    assert.equal(d2.created, true);
    assert.equal(d2.agent.id, d.agent.id);
    await waitFor("继续任务完成", () => rt.store.getTask(d2.task.id)!.status === "completed");
  } finally {
    await kit.shutdown(rt);
  }
});

test("占用未核实：保留占用与 unverified、不解除暂停；拥有者 resume-queue 后回 idle 可委派", async () => {
  const kit = await startKit("recover-occupancy");
  let rt = kit.rt;
  try {
    const { parent, d } = await baseWork(kit, rt, "q2", "full_access");
    const seeded = seedQueued(rt, d, parent.id, "b-running", "运行中任务MARK-R1");
    const pending = seedPending(rt, d, parent.id, "RECOVER-PENDING-MARK");
    const originSession = rt.store.getSession(parent.sessionId)!;
    rt.store.setSessionDefaultMode(originSession.id, "confirm", originSession.defaultAccessModeVersion);
    await rt.stop("test_restart");
    // 崩溃前的持久形态：任务已 running 且持有对其工作目录的占用（优雅 stop 会
    // 把 running 定 backend_stop 并回收占用，故在两个实例之间用新连接置位）
    {
      const db = new Db(kit.dirs.dataDir);
      const store = new Store(db);
      try {
        store.db.prepare("UPDATE tasks SET status = 'running', started_at = ? WHERE id = ?").run(new Date().toISOString(), seeded.id);
        const real = fs.realpathSync(d.agent.workDir);
        const stat = fs.statSync(real);
        const acquired = store.withTx(() =>
          store.tryAcquireOccupancy({ cwdReal: real, cwdDev: stat.dev, cwdIno: stat.ino, sessionId: d.agent.sessionId, taskId: seeded.id }),
        );
        assert.ok(acquired);
        store.setSubAgentState(d.agent.id, "running", { activeWorkId: d.work.id, currentTaskId: seeded.id });
      } finally {
        db.close();
      }
    }

    // —— 启动恢复：定 interrupted，但占用与暂停保留、Agent 记 unverified ——
    rt = await Runtime.start(kit.config);
    const after = rt.store.getTask(seeded.id)!;
    assert.equal(after.status, "interrupted");
    assert.equal(after.interruptReason, "backend_restart");
    assert.ok(after.resultSummary !== null, "结果未知已补记");
    assert.equal(rt.store.listAllOccupancy().filter((o) => o.sessionId === d.agent.sessionId).length, 1, "占用保留");
    const childSession = rt.store.getSession(d.agent.sessionId)!;
    assert.equal(childSession.queueState, "paused");
    assert.equal(childSession.queuePauseReason, "occupancy_unverified", "未核实的暂停不被编排器启动恢复解除");
    const agent = rt.store.getSubAgent(d.agent.id)!;
    assert.equal(agent.state, "unverified");
    assert.equal(agent.currentTaskId, null);
    assert.equal(kit.server.calls.filter((c) => inputText(c).includes("MARK-R1")).length, 0, "旧执行不并发重跑");
    assert.deepEqual(rt.store.getSubAgentMessage(pending.id), pending, "重启后占用未核实，消息保持 pending");
    assert.equal(rt.store.findTaskByRequest(d.agent.sessionId, `smsg:${pending.id}`), null);

    // —— 未核实前拒绝新委派 ——
    await assert.rejects(
      () =>
        delegateFromActiveTask(rt, {
          parentTaskId: parent.id,
          key: "q2-x",
          request: "拒绝",
          workId: d.work.id,
          readPaths: ["."],
          materials: null,
          paramsDigest: "d-q2-x",
        }),
      /待核实|正忙/,
    );

    // —— 拥有者核实旧执行已退出：resume-queue 释放占用、解除暂停、Agent 回 idle ——
    await rt.resumeQueue(d.agent.sessionId);
    assert.equal(rt.store.listAllOccupancy().filter((o) => o.taskId === seeded.id).length, 0, "旧执行占用已释放");
    assert.equal(rt.store.getSession(d.agent.sessionId)!.queueState, "active");
    const delivered = rt.store.getSubAgentMessage(pending.id)!;
    assert.equal(rt.store.getTask(delivered.deliveredTaskId!)!.accessMode, pending.accessMode, "恢复投递沿消息登记时模式");
    assert.equal(rt.store.getTask(delivered.deliveredTaskId!)!.sourcePermissionVersion, pending.sourcePermissionVersion);
    assert.ok(delivered.deliveredTaskId, "实际 resumeQueue 提交后自动补投");
    assert.equal(rt.store.getTask(delivered.deliveredTaskId!)!.requestId, `smsg:${pending.id}`);
    await waitFor("恢复消息执行完成", () => rt.store.getTask(delivered.deliveredTaskId!)!.resultSummary !== null);
    await waitFor("恢复消息结束后 Agent 空闲", () => rt.store.getSubAgent(d.agent.id)!.state === "idle");
    await rt.resumeQueue(d.agent.sessionId);
    assert.equal(rt.store.listTasksBySession(d.agent.sessionId).filter((t) => t.requestId === `smsg:${pending.id}`).length, 1, "重复恢复不补第二个任务");
    assert.equal(kit.server.calls.filter((c) => lastUserText(c).includes("RECOVER-PENDING-MARK")).length, 1, "恢复消息实际调用模型一次");

    // —— 回 idle 后可沿同一工作继续委派 ——
    const d2 = await delegateFromActiveTask(rt, {
      parentTaskId: parent.id,
      key: "q2-r2",
      request: "继续MARK-CONT",
      workId: d.work.id,
      readPaths: ["."],
      materials: null,
      paramsDigest: "d-q2-r2",
    });
    assert.equal(d2.created, true);
    await waitFor("继续任务完成", () => rt.store.getTask(d2.task.id)!.status === "completed");
  } finally {
    await kit.shutdown(rt);
  }
});

test("宿主固定评审排队任务：不中断，启动恢复自动解除子会话暂停并继续执行", async () => {
  const kit = await startKit("recover-review");
  let rt = kit.rt;
  try {
    await rt.stop("fixture_configure_review");
    new CredentialStore(kit.dirs.agentDir).upsert({ name: "hook", host: "github.com", header: "x-hub-signature-256", purpose: "github_webhook", secret: "fixture-secret" });
    const target: NotifyTarget = { channel: "telegram", account: "fixture-bot", chatId: "owner", configVersion: 1 };
    kit.config.githubWebhook = { port: 0, credential: "hook", repositoryIds: [42] };
    kit.config.scheduler = { tickMs: 0, channel: { target: () => target, available: () => false, send: async () => { throw new Error("恢复夹具不发送外部消息"); } } };
    rt = await Runtime.start(kit.config);
    const payload: GitHubPullRequestEvent = { deliveryId: "recover-review", action: "opened", repository: { id: 42, owner: "owner", name: "repo", fullName: "owner/repo" }, number: 7,
      url: "https://github.com/owner/repo/pull/7", headSha: "a".repeat(40), baseSha: "b".repeat(40), headRef: "feature", baseRef: "main", sender: "contributor",
      title: "REVIEW-MARK", body: "恢复固定评审", bodyTruncated: false, draft: false, state: "open", updatedAt: "2026-09-24T01:00:00Z" };
    const event = rt.store.withTx(() => rt.store.registerInboundEvent({ source: "github", externalId: payload.deliveryId, actor: payload.sender, targetRole: "main", body: JSON.stringify(payload), replyTarget: target })).event;
    const kick = rt["kick"].bind(rt), delegate = rt.subagents!.delegate.bind(rt.subagents);
    rt["kick"] = sessionId => {
      if (rt.store.getSessionIdentity(sessionId)?.kind === "subagent") rt.store.setSessionQueueState(sessionId, "paused", "backend_restart");
      else kick(sessionId);
    };
    rt.subagents!.delegate = async input => {
      if (input.hostReview) await waitFor("可信固定评审接收父轮完成", () => rt.store.getTask(input.parentTaskId)?.status === "completed");
      return delegate(input);
    };
    try { await rt.orchestrator!.dispatchRegisteredEvents(); }
    finally { rt["kick"] = kick; rt.subagents!.delegate = delegate; }
    const work = rt.store.listWorkDelegations()[0]!, agent = rt.store.getSubAgent(work.subAgentId)!;
    const d = { agent }, seeded = rt.store.listTasksByWork(work.id)[0]!;
    assert.equal(rt.store.getTask(work.originTaskId)!.status, "completed");
    assert.equal(agent.definition!.digest, HOST_REVIEW_DEFINITION.digest);
    assert.equal(seeded.sourceEventId, event.id); assert.equal(seeded.readScope?.execution, undefined);
    assert.equal(seeded.status, "queued");
    const callsBefore = kit.server.calls.length;
    await rt.stop("test_restart");

    rt = await Runtime.start(kit.config);
    await waitFor("评审任务完成", () => rt.store.getTask(seeded.id)!.status === "completed", 20_000);
    assert.equal(rt.store.getSession(d.agent.sessionId)!.queueState, "active", "启动恢复自动解除暂停");
    assert.equal(
      kit.server.calls.slice(callsBefore).filter((c) => inputText(c).includes("REVIEW-MARK")).length,
      1,
      "评审任务继续执行且只执行一次",
    );
    await waitFor("Agent 空闲", () => rt.store.getSubAgent(d.agent.id)!.state === "idle");
  } finally {
    await kit.shutdown(rt);
  }
});

for (const rollback of [false, true]) {
  test(`模型配置${rollback ? "回滚" : "成功应用"}后：实际 Runtime 解除门闩并补投 pending 消息一次`, async context => {
    const kit = await startKit(`recover-config-${rollback ? "rollback" : "apply"}`);
    const rt = kit.rt;
    let release!: () => void;
    try {
      const { parent, d } = await baseWork(kit, rt, "config");
      const pending = seedPending(rt, d, parent.id, "CONFIG-PENDING-MARK");
      const configFile = path.join(kit.dirs.agentDir, "models.json");
      const original = fs.readFileSync(configFile, "utf8");
      const changed = JSON.parse(original);
      changed.providers.mock.models[0].name = "配置应用后的模型";
      let entered = false;
      const create = ModelRuntime.create.bind(ModelRuntime);
      context.mock.method(ModelRuntime, "create", async (...args: Parameters<typeof ModelRuntime.create>) => {
        context.mock.restoreAll();
        entered = true;
        await new Promise<void>(resolve => { release = resolve; });
        if (rollback) throw new Error("CONFIG-ROLLBACK-FAULT");
        return create(...args);
      });
      const applying = rt.models.saveCatalog({ providers: changed.providers, expectedRevision: rt.models.getConfig().revision });
      const settled = applying.then(() => null, (err: Error) => err);
      await waitFor("配置门闩窗口", () => entered && release !== undefined);
      await assert.rejects(() => messageFromActiveTask(rt, {
        senderTaskId: parent.id, workId: d.work.id, key: "during-config", text: "门闩内的新消息",
        toSubAgentId: d.agent.id, paramsDigest: "during-config",
      }), { code: "model_config_busy" });
      assert.equal(rt.store.listSubAgentMessagesByWork(d.work.id).length, 1, "门闩拒绝新消息不新增记录");
      await rt.subagents!.flushPendingMessages(d.work.parentSessionId);
      assert.deepEqual(rt.store.getSubAgentMessage(pending.id), pending, "门闩中既有消息保持 pending");
      assert.equal(rt.store.findTaskByRequest(d.agent.sessionId, `smsg:${pending.id}`), null);

      release();
      const error = await settled;
      if (rollback) {
        assert.ok(error instanceof RuntimeApiError);
        assert.equal(error.code, "model_config_invalid");
        assert.doesNotMatch(error.message, /CONFIG-ROLLBACK-FAULT/);
        assert.equal(fs.readFileSync(configFile, "utf8"), original, "失败恢复原配置字节");
      } else {
        assert.equal(error, null);
        assert.equal(JSON.parse(fs.readFileSync(configFile, "utf8")).providers.mock.models[0].name, changed.providers.mock.models[0].name);
      }
      const delivered = rt.store.getSubAgentMessage(pending.id)!;
      assert.ok(delivered.deliveredTaskId, "配置入口本身在解除门闩后触发补投");
      assert.equal(delivered.undeliveredReason, null);
      await waitFor("配置恢复后的消息执行完成", () => rt.store.getTask(delivered.deliveredTaskId!)!.resultSummary !== null);
      await rt.subagents!.flushPendingMessages();
      assert.equal(rt.store.listTasksBySession(d.agent.sessionId).filter((t) => t.requestId === `smsg:${pending.id}`).length, 1);
      assert.equal(kit.server.calls.filter((c) => lastUserText(c).includes("CONFIG-PENDING-MARK")).length, 1, "自动补投实际调用模型一次");
    } finally {
      release?.();
      context.mock.restoreAll();
      await kit.shutdown(rt);
    }
  });
}
