import { product as personalProduct } from "./helpers/legacy-product.ts";
/**
 * 核心群聊退役与旧群资料保全（agent-direction issue 20）。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-02-two-agent-products.md
 * Note: 见 .agents/notes/implemented/simplification/2026-10-02-retire-core-group-chat.md
 *
 * 逐条对应工单验收：
 * 1. 新核心不引导 chat、不接收群任务；QQ 拥有者私聊与 Telegram 主会话照常回复；
 * 2. 旧群历史/收件/账本/接收记录可归档查询；群会话不能转成普通开发会话绕过限制；
 * 3. 去掉 chat 角色行后隔离不扩大（原始群资料与已接收快照的授权边界保持）；
 * 4. 通知与调度中的群结果引用仍复核（撤回/篡改阻断外发并记 source_revoked）；
 * 5. 排队/在途/待发一次性收尾，只定终态不重放，重复重启幂等。
 *
 * Release-note acceptance requires manual review of docs/usage.md and README.md.
 * The seed helper writes the pre-retirement core-v24 layout directly; the historical tx upgrade
 * experiment using data from old code remains in the offline agent-direction archive, not a current smoke entry point.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import { AccessScope } from "@ruukoto/core/access.ts";
import { QqStore, qqDedupKey } from "@ruukoto/channels/qq/store.ts";
import { CORE_GROUP_CHAT_RETIRED } from "@ruukoto/core/session-identity.ts";
import { Runtime, type RuntimeConfig } from "@ruukoto/runtime/runtime.ts";
import { resolveAcceptedChatResult } from "@ruukoto/channels/chat-results.ts";
import { sha256, type SourceRef } from "@ruukoto/channels/scheduler/store.ts";
import { firstDue, parseRule } from "@ruukoto/channels/scheduler/time.ts";
import { createMockTools } from "@ruukoto/agent/mock-tools.ts";
import type { NotifyTarget } from "@ruukoto/core/types.ts";
import {
  lastUserText,
  makeTestDirs,
  startTestRuntime,
  cleanupDirs,
  waitFor,
  writeModelsJson,
} from "./helpers/testkit.ts";
import { MockModelServer, type Responder } from "./helpers/mock-provider.ts";
import { MOCK_QQ_ACCOUNT, MOCK_QQ_SECRET, startMockOneBot, type MockOneBot } from "./helpers/mock-onebot.ts";
import { FakeBotApi } from "./helpers/fake-bot-api.ts";
import { legacyGroupArchive, seedAcceptedResult } from "./helpers/legacy-group-archive.ts";
import { seedCodingRole } from "./helpers/legacy-coding.ts";

const GROUP = "100001";
const GROUP_B = "100002";
const OWNER = "880001";
const TG_TOKEN = "123456:RETIRE-TEST-TOKEN";
const TG_OWNER = 42;
const TARGET: NotifyTarget = { channel: "mock", account: "bot1", chatId: "owner-chat", configVersion: 1 };
const QQ_TIMEOUTS = { actionTimeoutMs: 400, probeIntervalMs: 100, reconnectMinMs: 30, reconnectMaxMs: 100, sweepIntervalMs: 50 };
const pause = (ms = 350) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------- 验收 1：新核心不接群任务；私聊与 Telegram 主会话继续 ----------

test("验收1：全新实例只有 main（chat/coding 已退役，issue 20/23）；群消息零新增；同连接私聊与 Telegram 照常回复", async () => {
  const onebot = await startMockOneBot({});
  const api = new FakeBotApi({ token: TG_TOKEN, ownerId: TG_OWNER });
  const apiBase = await api.start();
  const t = await startTestRuntime("retire-entry", async (req) => ({ kind: "text", text: `REPLY ${lastUserText(req).slice(-20)}` }), {
    config: {
      telegram: { pollTimeoutSec: 1, backoffMs: 50 },
      qq: QQ_TIMEOUTS,
      scheduler: { tickMs: 30 },
    },
  });
  try {
    const rt = t.runtime;
    // 只引导 main；不建 agent-chat 项目
    assert.deepEqual(rt.store.listAgentRoles().map((r) => r.id), ["main"]);
    assert.equal(rt.store.findProjectByName("agent-chat"), null, "不建 chat 项目");

    await rt.addCredentialBinding({ name: "qq", host: onebot.host, header: "authorization", purpose: "qq_onebot", secret: MOCK_QQ_SECRET });
    await rt.qqConfigure({ endpoint: onebot.url, selfId: MOCK_QQ_ACCOUNT, credential: "qq", ownerUserId: OWNER });
    await rt.qqSetEnabled(true);
    await rt.addCredentialBinding({ name: "tg", host: new URL(apiBase).host, header: "none", purpose: "telegram_bot", secret: TG_TOKEN });
    await rt.telegramConfigure({ apiBase, credential: "tg", ownerUserId: String(TG_OWNER) });
    await rt.telegramSetEnabled(true);
    await waitFor("QQ 与 Telegram 在线", () => rt.qqStatus().online === true && rt.telegramStatus().online === true);

    // 模拟 OneBot 推送群 @ 消息：收件、会话、任务、send_group_msg 与模型调用均零新增
    onebot.pushGroupMessage({
      groupId: GROUP, userId: "880009", messageId: 1,
      segments: [{ type: "at", data: { qq: MOCK_QQ_ACCOUNT } }, { type: "text", data: { text: "GROUP-MARK 谁去看展？" } }],
    });
    onebot.pushGroupMessage({
      groupId: "100099", userId: "880002", messageId: 2,
      segments: [{ type: "at", data: { qq: MOCK_QQ_ACCOUNT } }, { type: "text", data: { text: "另一条群消息" } }],
    });
    await pause();
    assert.equal(rt.qqStore.listInbox().length, 0, "收件零新增");
    assert.equal(rt.qqStore.listOutbox().length, 0, "不登记发送");
    assert.equal(rt.qqStore.listGroupSessions().length, 0, "群会话零新增");
    assert.equal((await t.client.request<any>("qq_status", {})).sessions.length, 0, "状态视图无群会话");
    assert.equal(rt.store.listTasksByStatus(["queued", "running"]).length, 0, "任务零新增");
    assert.equal(onebot.actions.filter((a) => a.action === "send_group_msg").length, 0, "send_group_msg 零调用");
    assert.equal(t.server.calls.length, 0, "模型零调用");
    assert.equal(rt.store.listProjects().filter((p) => p.name.startsWith("qq-")).length, 0, "群项目零新增");

    onebot.pushRecall({ groupId: GROUP, messageId: 1, userId: "880009" });
    await pause();
    assert.equal(rt.qqStore.listInbox().length, 0, "未登记的撤回不产生记录");

    // 同一连接上 QQ 拥有者私聊照常回复（固定目标 + 引用原消息）
    onebot.pushPrivateMessage({ userId: OWNER, messageId: 7, segments: [{ type: "text", data: { text: "PRIVATE-MARK 周五提醒我带伞" } }] });
    await waitFor("QQ 私聊已回复", () => onebot.actions.some((a) => a.action === "send_private_msg"));
    const qqReply = onebot.actions.find((a) => a.action === "send_private_msg")!;
    assert.deepEqual((qqReply.params.message as any[])[0], { type: "reply", data: { id: "7" } });

    // Telegram 主会话照常回复
    api.push({ text: "TG-MARK 周日计划" });
    await waitFor("Telegram 已回复", () => api.sends.length >= 1);
    assert.match(String(api.sends[0]!.text), /REPLY/);
  } finally {
    await t.shutdown();
    await onebot.close();
    await api.close();
  }
});

// ---------- 验收 2：归档可查；群会话不能转为开发入口 ----------

test("验收2：inbox 附接收与复核结论、outbox 账本、read_history 可读；转 dev 会话与提交全部拒绝", async () => {
  const t = await startTestRuntime("retire-archive", async () => ({ kind: "text", text: "ok" }), { config: { qq: QQ_TIMEOUTS } });
  try {
    const rt = t.runtime;
    const archive = legacyGroupArchive({ store: rt.store, qq: rt.qqStore, workRoot: t.dirs.root });
    const chatRole = archive.seedChatRole();
    const group = archive.seedGroup({ account: MOCK_QQ_ACCOUNT, groupId: GROUP });
    const done = group.seedTask({ userId: OWNER, messageId: "1", state: "completed", summary: "ARCHIVE-RESULT 周五发布", time: 1 });
    // 旧崩溃窗口形态：任务完成、回复未发（收件仍 queued，无发送记录）
    group.seedTask({ userId: OWNER, messageId: "2", state: "completed", summary: "noreply", time: 10 });
    rt.qqStore.setInboxStatus(qqDedupKey(MOCK_QQ_ACCOUNT, GROUP, "2"), "queued");
    const recalled = group.seedTask({ userId: OWNER, messageId: "3", state: "completed", summary: "x", recalled: true, time: 20 });
    const sent = group.seedPendingReply({ taskId: done.task!.id, messageId: "1" });
    const mainRole = rt.store.getAgentRole("main")!;
    const accepted = seedAcceptedResult(rt.store, { mainProjectId: mainRole.projectId, acceptedByTaskId: done.task!.id, taskId: done.task!.id, summary: "ARCHIVE-RESULT 周五发布", reason: "整理发布结论" });

    // qq inbox：状态、撤回标记、接收记录（时间/任务/理由/摘要）与当前复核结论
    const list = await t.client.request<any>("qq_inbox_list", { group_id: GROUP, limit: 20 });
    const byMessage = new Map<string, any>(list.entries.map((e: any) => [e.messageId, e]));
    assert.equal(byMessage.get("1").status, "done");
    assert.equal(byMessage.get("1").acceptance.acceptedAt, accepted.acceptedAt);
    assert.equal(byMessage.get("1").acceptance.reason, "整理发布结论");
    assert.equal(byMessage.get("1").acceptance.summary, "ARCHIVE-RESULT 周五发布");
    assert.equal(byMessage.get("1").acceptance.acceptedByTaskId, done.task!.id);
    assert.equal(byMessage.get("1").sourceProblem, null, "复核可用");
    assert.equal(byMessage.get("2").acceptance, null, "未接收无账本字段");
    assert.equal(byMessage.get("3").recalled, true, "撤回标记保留");
    assert.ok(byMessage.get("3").recalledAt, "撤回时间保留");

    // qq outbox：发送账本可查
    const outbox = await t.client.request<any>("qq_outbox_list", { group_id: GROUP, limit: 20 });
    assert.deepEqual(outbox.entries.map((e: any) => e.opId), [sent.opId]);
    assert.equal(outbox.entries[0].status, "pending", "账本原样保留（收尾定态见验收 5）");

    // 拥有者 read_history 读群会话（归档 JSONL 原样可读）
    const historyFile = path.join(t.dirs.root, "group-history.jsonl");
    fs.writeFileSync(historyFile, JSON.stringify({
      type: "message", id: "e1", parentId: null, timestamp: "2026-09-24T00:00:00Z",
      message: { role: "user", content: [{ type: "text", text: "ARCHIVE-HISTORY-SECRET" }] },
    }) + "\n");
    rt.store.setSessionFile(group.session.id, historyFile);
    const history = await t.client.request<any>("read_history", { session_id: group.session.id });
    assert.ok(JSON.stringify(history).includes("ARCHIVE-HISTORY-SECRET"), "群历史经拥有者入口可读");

    // 不能把群/角色项目变成普通开发会话
    for (const projectId of [group.projectId, chatRole.projectId]) {
      await assert.rejects(
        t.client.request("create_session", { project_id: projectId, cwd: t.work[0]! }),
        /角色或群聊项目/,
      );
    }
    // open_workspace 认领保持排除（回归）
    await assert.rejects(
      t.client.request("open_workspace", { project_id: group.projectId, cwd: t.work[0]! }),
      /角色或群聊项目不能作为工作区认领/,
    );
    // 对群会话或 chat 角色会话 submit；continue 被中断的群任务——全部拒绝
    for (const sessionId of [group.session.id, chatRole.sessionId]) {
      await assert.rejects(
        rt.submit({ sessionId, requestId: `retry-${sessionId}`, input: "继续聊", modelSelection: rt.defaultSelection }),
        (err: any) => err.code === "invalid_state" && /核心群聊已退役/.test(err.message),
      );
    }
    const interrupted = group.seedTask({ userId: OWNER, messageId: "9", state: "running" }).task!;
    rt.store.transitionTask(interrupted.id, ["running"], "interrupted", { interruptReason: "backend_restart", endedAt: new Date().toISOString() });
    await assert.rejects(
      rt.submit({ sessionId: interrupted.sessionId, requestId: "cont-9", input: "继续", modelSelection: rt.defaultSelection }),
      (err: any) => err.code === "invalid_state" && /核心群聊已退役/.test(err.message),
    );

    // main 角色缺失（异常库）时，已接收行不误报为"未接收/可用"
    const mainRow = rt.store.db.prepare("SELECT * FROM agent_roles WHERE id = 'main'").get() as any;
    rt.store.db.prepare("DELETE FROM agent_roles WHERE id = 'main'").run();
    const degraded = rt.qqListInbox({ groupId: GROUP, limit: 20 });
    const degradedRow = degraded.find((e) => e.messageId === "1")!;
    assert.equal(degradedRow.acceptance?.summary, "ARCHIVE-RESULT 周五发布", "接收账本仍可见");
    assert.match(degradedRow.sourceProblem!, /main 角色不可用/, "被阻断的来源如实标注");
    rt.store.db.prepare("INSERT INTO agent_roles (id, project_id, session_id, work_dir, model_selection, tools, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(mainRow.id, mainRow.project_id, mainRow.session_id, mainRow.work_dir, mainRow.model_selection, mainRow.tools, mainRow.created_at);
    assert.equal(rt.store.listTasksBySession(group.session.id).filter((x) => !["completed", "interrupted", "canceled", "failed"].includes(x.status)).length, 0, "不产生新任务");
  } finally {
    await t.shutdown();
  }
});

// ---------- 验收 3：去掉 chat 角色行后隔离不扩大 ----------

test("验收3：无 chat 角色行的实例中 main/coding/SubAgent 仍读不到群项目；已接收快照仅 main", async () => {
  const t = await startTestRuntime("retire-isolation", async () => ({ kind: "text", text: "ok" }), { config: { telegramDisabled: true } });
  try {
    const rt = t.runtime;
    assert.equal(rt.store.getAgentRole("chat"), null, "新核心没有 chat 角色行");
    const archive = legacyGroupArchive({ store: rt.store, qq: rt.qqStore, workRoot: t.dirs.root });
    // 群项目名故意使用普通名称，验证隔离依据是会话类别而非命名
    const group = archive.seedGroup({ account: MOCK_QQ_ACCOUNT, groupId: GROUP });
    rt.store.db.prepare("UPDATE projects SET name = 'ordinary-project' WHERE id = ?").run(group.projectId);
    const done = group.seedTask({ userId: OWNER, messageId: "1", state: "completed", summary: "GROUP-SECRET 内部排期" });
    const mainRole = rt.store.getAgentRole("main")!;
    // 旧安装保留的 coding 角色行（issue 23 起不再引导）：群项目边界照旧
    const codingRole = { id: "coding", ...seedCodingRole(rt.store, t.dirs.root) };
    seedAcceptedResult(rt.store, { mainProjectId: mainRole.projectId, acceptedByTaskId: done.task!.id, taskId: done.task!.id, summary: "GROUP-SECRET 内部排期" });

    const access = new AccessScope(rt.store.db);
    for (const role of [mainRole, codingRole]) {
      for (const category of ["history", "artifact", "memory"] as const) {
        assert.equal(
          access.canAccess({ kind: "agent", projectId: role.projectId }, group.projectId, category),
          false,
          `${role.id} 不能读群项目 ${category}`,
        );
      }
    }
    // main 的 SubAgent 以父会话项目的 {kind:"agent"} 资料身份行事（无独立
    // accessor 类别），上面对 main 的拒绝即 SubAgent 的拒绝；chat_result 作为
    // 委派资料的拒绝由 test/80 的委派链路回归保持
    // 已接收快照只对 main 开放（coding 与陌生项目均被拒）
    assert.equal(resolveAcceptedChatResult(rt.store, rt.qqStore, mainRole.projectId, done.task!.id).summary, "GROUP-SECRET 内部排期");
    assert.throws(() => resolveAcceptedChatResult(rt.store, rt.qqStore, codingRole.projectId, done.task!.id), /仅 main/);
    assert.throws(() => resolveAcceptedChatResult(rt.store, rt.qqStore, group.projectId, done.task!.id), /仅 main/);
  } finally {
    await t.shutdown();
  }
});

// ---------- 验收 4：通知与调度中的群结果引用仍复核 ----------

async function notifyHarness(prefix: string, responder: Responder) {
  const onebot = await startMockOneBot({});
  const channel = {
    online: false,
    sends: [] as Array<{ opId: string; text: string }>,
    target: () => ({ ...TARGET }),
    available() { return this.online; },
    async send(input: { opId: string; text: string }) {
      this.sends.push({ opId: input.opId, text: input.text });
      return { platformMessageId: `mock-${this.sends.length}` };
    },
  };
  const t = await startTestRuntime(prefix, responder, {
    workDirs: 1,
    config: {
      telegramDisabled: true,
      qq: QQ_TIMEOUTS,
      scheduler: { channel, tickMs: 0 },
    },
  });
  const rt = t.runtime;
  await rt.addCredentialBinding({ name: "qq", host: onebot.host, header: "authorization", purpose: "qq_onebot", secret: MOCK_QQ_SECRET });
  await rt.qqConfigure({ endpoint: onebot.url, selfId: MOCK_QQ_ACCOUNT, credential: "qq" });
  await rt.qqSetEnabled(true);
  await waitFor("QQ 在线", () => rt.qqStatus().online === true);
  const main = rt.store.getAgentRole("main")!;
  const archive = legacyGroupArchive({ store: rt.store, qq: rt.qqStore, workRoot: t.dirs.root });
  const group = archive.seedGroup({ account: MOCK_QQ_ACCOUNT, groupId: GROUP });
  /** 播种一条已接收的群结果（退役前的归档事实）。 */
  const acceptResult = (messageId: string, summary: string, g = group) => {
    const done = g.seedTask({ userId: OWNER, messageId, state: "completed", summary });
    return seedAcceptedResult(rt.store, { mainProjectId: main.projectId, acceptedByTaskId: done.task!.id, taskId: done.task!.id, summary });
  };
  return {
    ...t, rt, onebot, channel, main, archive, group, acceptResult,
    ops: () => rt.sched.listOps({ limit: 50 }).items,
    async close() { await t.shutdown(); await onebot.close(); },
  };
}

test("验收4a：宿主登记的已接收群结果通知在退役后正常发送", async () => {
  const h = await notifyHarness("retire-notify-ok", async () => ({ kind: "text", text: "不应调用模型" }));
  try {
    const accepted = h.acceptResult("1", "群讨论结果：周五发布");
    const op = h.rt.store.withTx(() => {
      const snapshot = resolveAcceptedChatResult(h.rt.store, h.rt.qqStore, h.main.projectId, accepted.taskId);
      return h.rt.sched.insertOp({
        sourceKind: "confirmation", sourceKey: `host:${snapshot.taskId}`, taskId: null, hostOpId: null,
        target: { ...TARGET }, text: snapshot.summary,
        sourceRefs: [{ kind: "chat_result", ref: `chat_result:${snapshot.taskId}`, version: snapshot.acceptedAt, sha256: sha256(snapshot.summary) }],
      }).op;
    });
    await h.rt.scheduler!.tick();
    await h.rt.scheduler!.idle();
    assert.equal(op.status, "pending");
    assert.deepEqual(op.sourceRefs.map((r) => [r.kind, r.ref, r.version]), [["chat_result", `chat_result:${accepted.taskId}`, accepted.acceptedAt]]);
    assert.equal(h.rt.sched.getOp(op.id)!.status, "pending", "渠道离线等待，未完成发送");
    h.channel.online = true;
    await h.rt.scheduler!.tick();
    await h.rt.scheduler!.idle();
    assert.equal(h.rt.sched.getOp(op.id)!.status, "sent");
    assert.deepEqual(h.channel.sends.map((s) => s.text), ["群讨论结果：周五发布"]);
    assert.equal(h.server.calls.length, 0);
  } finally { await h.close(); }
});

test("验收4b/4c/4d：撤回与归档篡改阻断待发通知与调度运行（source_revoked 及原因），不只凭快照正文继续", async () => {
  const h = await notifyHarness("retire-notify-blocked", async () => ({ kind: "text", text: "ok" }));
  try {
    const rt = h.rt;
    /** 宿主直接登记待发通知，验证发送前的来源复核。 */
    const accepted = (messageId: string, summary: string, g?: typeof h.group) => {
      const a = h.acceptResult(messageId, summary, g);
      const ref: SourceRef = { kind: "chat_result", ref: `chat_result:${a.taskId}`, version: a.acceptedAt, sha256: sha256(summary) };
      return { a, ref };
    };
    const enqueueNotify = (ref: SourceRef, text: string) =>
      rt.store.withTx(() => rt.sched.insertOp({
        sourceKind: "confirmation", sourceKey: `approval-test-${ref.ref}`, taskId: null, hostOpId: null,
        target: { ...TARGET }, text, sourceRefs: [ref],
      }).op);

    // 4b：撤回已登记消息 → 待发通知发送前复核失败（发送渠道上线后才领取）
    const r1 = accepted("11", "结果一");
    const op1 = enqueueNotify(r1.ref, r1.a.summary);
    h.onebot.pushRecall({ groupId: GROUP, messageId: 11, userId: OWNER });
    await waitFor("撤回已落库", () => rt.qqStore.getInbox(qqDedupKey(MOCK_QQ_ACCOUNT, GROUP, "11"))!.recalled);
    h.channel.online = true;
    await rt.scheduler!.tick();
    await rt.scheduler!.idle();
    assert.equal(rt.sched.getOp(op1.id)!.status, "canceled");
    assert.match(rt.sched.getOp(op1.id)!.errorMessage!, /source_revoked：.*撤回/);
    assert.equal(h.channel.sends.length, 0, "撤回不凭接收快照正文继续发送");

    // 4d：调度运行的发送前复核同样阻断（撤回；先于映射删除执行，避免相互污染）
    const r3 = accepted("13", "结果三");
    const rule = parseRule({ kind: "once", at: "2026-09-24T09:00:00Z", time_zone: "UTC" });
    rt.store.withTx(() => rt.sched.insertSchedule({
      createKey: "notify-sched", paramsDigest: "test", createTaskId: null, createOpId: null,
      projectId: rt.store.getAgentRole("main")!.projectId, createPermissionVersion: 1, accessMode: "confirm", rule,
      instruction: r3.a.summary, sourceRefs: [r3.ref], target: { ...TARGET }, nextDueAt: firstDue(rule, Date.now()), tzData: "test", reason: "test",
    }, "test"));
    h.onebot.pushRecall({ groupId: GROUP, messageId: 13, userId: OWNER });
    await waitFor("撤回已落库", () => rt.qqStore.getInbox(qqDedupKey(MOCK_QQ_ACCOUNT, GROUP, "13"))!.recalled);
    await rt.scheduler!.tick();
    await rt.scheduler!.idle();
    await rt.scheduler!.tick();
    await rt.scheduler!.idle();
    const runOps = h.ops().filter((op) => op.sourceKind === "schedule_run");
    assert.equal(runOps.length, 1, "调度运行登记一条发送");
    assert.equal(runOps[0]!.status, "sent", "资料已撤回使任务未启动，固定目标仅收到通用失败诊断");
    assert.doesNotMatch(runOps[0]!.text, /结果三/);

    // 4c：删除归档会话映射 → 复核失败并说明原因
    const groupB = h.archive.seedGroup({ account: MOCK_QQ_ACCOUNT, groupId: GROUP_B });
    const r2 = accepted("12", "结果二", groupB);
    const op2 = enqueueNotify(r2.ref, r2.a.summary);
    rt.store.db.prepare("DELETE FROM qq_sessions WHERE session_id = ?").run(groupB.session.id);
    await rt.scheduler!.tick();
    await rt.scheduler!.idle();
    assert.equal(rt.sched.getOp(op2.id)!.status, "canceled");
    assert.match(rt.sched.getOp(op2.id)!.errorMessage!, /source_revoked：.*映射不匹配/);
    assert.equal(h.channel.sends.length, 1, "只发送未启动运行的通用失败诊断");
    assert.doesNotMatch(h.channel.sends[0].text, /结果一|结果二|结果三/, "已撤销资料不进入诊断");
  } finally { await h.close(); }
});

// ---------- 验收 5：升级收尾明确且幂等 ----------

/** 用播种助手写满各形态旧数据后关闭 Db；随后多次启动/停止同一数据目录。 */
test("验收5：排队/在途/待发/未派发事件一次性收尾只定终态；三次启动幂等", async () => {
  const { dirs } = await makeTestDirs("retire-finalize", 1);
  const onebot = await startMockOneBot({});
  const model = new MockModelServer(async () => ({ kind: "text", text: "不应有模型调用" }));
  await writeModelsJson(dirs, await model.start());
  const ids: Record<string, string> = {};
  try {
    {
      const db = new Db(dirs.dataDir);
      const store = new Store(db);
      const qq = new QqStore(db);
      const archive = legacyGroupArchive({ store, qq, workRoot: dirs.root });
      archive.seedChatRole();
      const group = archive.seedGroup({ account: MOCK_QQ_ACCOUNT, groupId: GROUP });
      // 排队群任务
      ids.queued = group.seedTask({ messageId: "1", state: "queued" }).task!.id;
      // 模型挂起的运行中群任务（recover() 定 interrupted）
      ids.running = group.seedTask({ messageId: "2", state: "running" }).task!.id;
      // 已登记未派发的事件
      ids.eventRegistered = group.seedTask({ messageId: "3", state: "eventRegistered" }).event!.id;
      // 登记后崩溃窗口（仅收件）
      group.seedTask({ messageId: "4", state: "inboxOnly" });
      // 完成但未回复的收件（任务完成、收件仍 queued、无发送记录）
      ids.doneNoReply = group.seedTask({ messageId: "5", state: "completed" }).task!.id;
      qq.setInboxStatus(qqDedupKey(MOCK_QQ_ACCOUNT, GROUP, "5"), "queued");
      // 发送回执前崩溃：遗留 pending 发送
      const donePending = group.seedTask({ messageId: "6", state: "completed" }).task!;
      qq.setInboxStatus(qqDedupKey(MOCK_QQ_ACCOUNT, GROUP, "6"), "queued");
      ids.pendingOutbox = group.seedPendingReply({ taskId: donePending.id, messageId: "6" }).opId;
      ids.pendingTask = donePending.id;
      // 已终态归档：不得被收尾改写
      const doneOk = group.seedTask({ messageId: "7", state: "completed", summary: "已送达结论" }).task!;
      ids.doneTask = doneOk.id;
      const groupB = archive.seedGroup({ account: MOCK_QQ_ACCOUNT, groupId: GROUP_B });
      ids.otherDone = groupB.seedTask({ messageId: "1", state: "completed" }).task!.id;
      db.close();
    }

    const counts = () => {
      const db = new Db(dirs.dataDir);
      const store = new Store(db);
      const events = (type: string) => store.getEventsAfter(0).filter((e) => (e.body as any).type === type).length;
      const snap = {
        canceled: (db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'canceled'").get() as any).n,
        interrupted: (db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'interrupted'").get() as any).n,
        inboxByStatus: Object.fromEntries((db.prepare("SELECT status, COUNT(*) AS n FROM qq_inbox GROUP BY status").all() as any[]).map((r) => [r.status, r.n])),
        outboxByStatus: Object.fromEntries((db.prepare("SELECT status, COUNT(*) AS n FROM qq_outbox GROUP BY status").all() as any[]).map((r) => [r.status, r.n])),
        inboundByStatus: Object.fromEntries((db.prepare("SELECT status, COUNT(*) AS n FROM inbound_events GROUP BY status").all() as any[]).map((r) => [r.status, r.n])),
        // 每次启动固定写 backend.recovered/backend.started，不计入幂等对比；
        // 只核对退役收尾产生的事实与终态
        inboxSkippedEvents: events("inbound.skipped"),
        taskCanceledEvents: events("task.canceled"),
        childResultEvents: events("child_task.failed"),
      };
      db.close();
      return snap;
    };

    const startOnce = async () => {
      const rt = await Runtime.start({
    product: personalProduct.runtime,
        dataDir: dirs.dataDir, agentDir: dirs.agentDir, socketPath: path.join(dirs.root, "c.sock"),
        thinkingLevel: "off", modelProvider: "mock", modelId: "mock-model",
        toolFactory: (ctx) => createMockTools(ctx),
        telegramDisabled: true,
        qqDisabled: true, // 收尾不依赖适配器/连接
      } as RuntimeConfig);
      // 让启动恢复（入站作废 + 结果补记）完成
      await pause(500);
      return rt;
    };

    // 第一次启动（升级路径）：启动收尾 + 恢复闸门
    {
      const rt = await startOnce();
      await rt.stop("upgrade_round");
    }
    {
      const db = new Db(dirs.dataDir);
      const store = new Store(db);
      const qq = new QqStore(db);
      const queued = store.getTask(ids.queued)!;
      assert.equal(queued.status, "canceled", "排队群任务取消");
      assert.match(queued.errorMessage!, /core_group_chat_retired/, "取消原因=退役");
      const running = store.getTask(ids.running)!;
      assert.equal(running.status, "interrupted", "运行中任务结果未知，不重放");
      const event = store.getInboundEvent(ids.eventRegistered)!;
      assert.equal(event.status, "failed", "已登记未派发事件作废");
      assert.ok(
        store.getEventsAfter(0).some((e) => (e.body as any).type === "inbound.skipped" && (e.body as any).eventId === ids.eventRegistered && String((e.body as any).reason).startsWith("core_group_chat_retired")),
        "inbound.skipped 记录退役原因",
      );
      const inbox = (m: string) => qq.getInbox(qqDedupKey(MOCK_QQ_ACCOUNT, GROUP, m))!;
      assert.equal(inbox("3").status, "skipped");
      assert.equal(inbox("4").status, "skipped", "登记后崩溃窗口记 skipped");
      assert.equal(inbox("5").status, "skipped", "完成但未回复不补发，记 skipped");
      assert.equal(inbox("1").status, "skipped");
      assert.equal(inbox("2").status, "skipped");
      assert.equal(inbox("6").status, "reply_unknown", "pending 发送的收件记 reply_unknown");
      assert.equal(qq.getOutboxByTask(ids.pendingTask)!.status, "unknown", "遗留发送定 unknown");
      assert.match(qq.getOutboxByTask(ids.pendingTask)!.error!, /核心群聊已退役/);
      assert.equal(inbox("7").status, "done", "已终态归档不改写");
      assert.equal(store.getTask(ids.doneTask)!.status, "completed");
      assert.equal(qq.getInbox(qqDedupKey(MOCK_QQ_ACCOUNT, GROUP_B, "1"))!.status, "done");
      assert.ok(
        store.getEventsAfter(0).some((e) => (e.body as any).type === "child_task.result_unknown" && (e.body as any).taskId === ids.running) &&
        store.getEventsAfter(0).some((e) => (e.body as any).type === "child_task.failed" && (e.body as any).taskId === ids.queued),
        "被收尾的群任务由启动巡检补记结果事件（结果未知/失败）",
      );
      db.close();
    }
    // 收尾后不能再续跑被中断的群任务
    {
      const rt = await startOnce();
      await assert.rejects(
        rt.submit({ sessionId: rt.store.getTask(ids.running)!.sessionId, requestId: "resume-run", input: "继续", modelSelection: rt.defaultSelection }),
        (err: any) => err.code === "invalid_state" && /核心群聊已退役/.test(err.message),
        "被中断的群任务不能续跑",
      );
      await rt.stop("check_done");
    }

    // 再重启两次：任务、收件、发送与事件计数不变（幂等，不重放）
    const first = counts();
    {
      const rt = await startOnce();
      await rt.stop("round_2");
    }
    {
      const rt = await startOnce();
      await rt.stop("round_3");
    }
    const third = counts();
    assert.deepEqual(third, first, "重复升级/重启不重放、不再改动");
    assert.equal(onebot.actions.length, 0, "send_group_msg 等动作零调用");
    assert.equal(model.calls.length, 0, "模型调用零新增");
  } finally {
    await onebot.close();
    await model.close();
    await cleanupDirs(dirs);
  }
});
