/**
 * QQ 入口集成测试（NapCat OneBot v11 正向 WebSocket）。
 *
 * 全部经进程内模拟 OneBot 服务（回环 WebSocket）+ 真实适配器/Runtime；不向
 * 真实 QQ 发送任何消息。覆盖：连接鉴权/身份核对/掉线重连、配置校验、
 * qq_group 资料身份隔离。
 *
 * 核心群聊已退役（agent-direction issue 20）：群消息@、撤群、排队、回复与
 * 补发的旧用例已删除；保留「群消息被忽略」，旧群资料的收尾与归档核查见
 * test/85-retire-core-group-chat.test.ts。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AccessScope } from "../src/core/access.ts";
import { Db } from "../src/core/db.ts";
import { Store } from "../src/core/store.ts";
import { OneBotClient, OneBotError } from "../src/qq/onebot.ts";
import {
  startTestRuntime,
  waitFor,
  makeTestDirs,
  cleanupDirs,
  type TestRuntime,
} from "./helpers/testkit.ts";
import { type Responder } from "./helpers/mock-provider.ts";
import { startMockOneBot, MOCK_QQ_SECRET, MOCK_QQ_ACCOUNT, type MockOneBot } from "./helpers/mock-onebot.ts";

const GROUP_A = "100001";
const USER_1 = "880001";
const USER_2 = "880002";

test("OneBot：在线状态独立于连接、账号切换、异步回执与停止重连", async () => {
  const onebot = await startMockOneBot({});
  const client = new OneBotClient({
    endpoint: onebot.url,
    token: MOCK_QQ_SECRET,
    onEvent() {},
    probeIntervalMs: 80,
    actionTimeoutMs: 200,
    reconnectMinMs: 5_000,
    reconnectMaxMs: 5_000,
  });
  try {
    client.start();
    client.start();
    await waitFor("登录账号与 get_status 均已核实", () => client.online);
    assert.equal(onebot.connectionCount(), 1);
    onebot.setOnline(false);
    await waitFor("get_status 发现 QQ 离线", () => !client.online);
    assert.equal(onebot.connectionCount(), 1, "QQ 离线时 WebSocket 仍可保持连接");
    onebot.setOnline(true);
    onebot.pushHeartbeat();
    await waitFor("心跳恢复在线", () => client.online);
    onebot.setOnline(false);
    onebot.pushHeartbeat();
    await waitFor("离线心跳关闭接收门", () => !client.online);
    onebot.setOnline(true);
    onebot.setAccount(USER_2);
    onebot.pushHeartbeat();
    await waitFor("重新核实切换后的登录账号", () => client.online && client.selfId === USER_2);
    onebot.setSendBehavior("async");
    await assert.rejects(client.call("send_private_msg", { user_id: Number(USER_1), message: [] }), (err: unknown) => err instanceof OneBotError && !err.definite);
    await assert.rejects(client.call("unknown_action", {}), (err: unknown) => err instanceof OneBotError && err.definite);
    onebot.dropConnections();
    await waitFor("连接断开", () => !client.online);
    const started = Date.now();
    await Promise.all([client.stop(), client.stop()]);
    assert.ok(Date.now() - started < 1_000, "停止应中断 5 秒重连退避");
    client.start();
    await waitFor("停止后只建立一个新连接", () => client.online);
    assert.equal(onebot.connectionCount(), 1);
  } finally {
    await client.stop();
    await onebot.close();
  }
});

/** 测试用压缩时限（生产默认：探测 30s / 巡检 15s / 动作 15s / 重连 1–30s）。 */
const QQ_TIMEOUTS = {
  actionTimeoutMs: 1_000,
  probeIntervalMs: 300,
  reconnectMinMs: 50,
  reconnectMaxMs: 300,
  sweepIntervalMs: 100,
};

const replyText: Responder = async () => ({ kind: "text", text: "私聊回复：收到" });

interface QqFixture {
  t: TestRuntime;
  onebot: MockOneBot;
}

/** 启动后台 + 模拟 OneBot，完成凭据/连接配置并启用。 */
async function startQq(
  prefix: string,
  responder: Responder,
  opts: {
    selfId?: string;
    /** 凭据中的秘密值（默认与模拟服务一致；传错误值测试鉴权失败）。 */
    credentialSecret?: string;
    mockAccount?: string;
    enable?: boolean;
  } = {},
): Promise<QqFixture> {
  const onebot = await startMockOneBot({ account: opts.mockAccount });
  const t = await startTestRuntime(prefix, responder, {
    config: { qq: { ...QQ_TIMEOUTS } },
  });
  try {
    t.runtime.credentials.upsert({
      name: "qq-test",
      host: onebot.host,
      header: "authorization",
      purpose: "qq_onebot",
      secret: opts.credentialSecret ?? MOCK_QQ_SECRET,
    });
    await t.client.request("qq_configure", {
      endpoint: onebot.url,
      credential: "qq-test",
      self_id: opts.selfId ?? MOCK_QQ_ACCOUNT,
    });
    if (opts.enable !== false) await t.client.request("qq_set_enabled", { enabled: true });
    return { t, onebot };
  } catch (err) {
    await t.shutdown();
    await onebot.close();
    throw err;
  }
}

async function shutdownQq(f: QqFixture): Promise<void> {
  await f.t.shutdown();
  await f.onebot.close();
}

async function waitOnline(t: TestRuntime): Promise<void> {
  await waitFor("QQ 上线", async () => (await t.client.request<any>("qq_status", {})).online === true);
}

async function waitOffline(t: TestRuntime): Promise<void> {
  await waitFor("QQ 离线", async () => (await t.client.request<any>("qq_status", {})).online === false);
}

/** @机器人 + 文本的结构化消息段。 */
function atSegments(text: string, atTarget = MOCK_QQ_ACCOUNT): unknown[] {
  return [
    { type: "at", data: { qq: atTarget } },
    { type: "text", data: { text } },
  ];
}

function groupSends(onebot: MockOneBot): Array<{ params: Record<string, any> }> {
  return onebot.actions.filter((a) => a.action === "send_group_msg");
}

// ---------- 配置面 ----------

test("qq：配置校验（端点协议/私网/凭据/账号/版本冲突）", async () => {
  const t = await startTestRuntime("qq-cfg", replyText, { config: { qq: QQ_TIMEOUTS } });
  try {
    await assert.rejects(
      t.client.request("qq_configure", { endpoint: "http://127.0.0.1:1/", self_id: MOCK_QQ_ACCOUNT }),
      /ws:\/\/ 或 wss:\/\//,
    );
    await assert.rejects(
      t.client.request("qq_configure", { endpoint: "ws://203.0.113.10:3001/", self_id: MOCK_QQ_ACCOUNT, credential: "x" }),
      /仅限回环或受控私网|凭据绑定不存在/,
    );
    await assert.rejects(
      t.client.request("qq_configure", { endpoint: "ws://192.168.1.10:3001/", self_id: MOCK_QQ_ACCOUNT }),
      /必须配置 token 凭据/,
    );
    await assert.rejects(
      t.client.request("qq_configure", { endpoint: "ws://127.0.0.1:3001/", self_id: "abc" }),
      /self_id 必须是 QQ 号数字串/,
    );
    // 凭据 host 与端点不一致 / 用途不符
    t.runtime.credentials.upsert({ name: "qq-bad-host", host: "127.0.0.1:9", header: "authorization", purpose: "qq_onebot", secret: "s" });
    t.runtime.credentials.upsert({ name: "qq-bad-purpose", host: "127.0.0.1:3001", header: "authorization", purpose: "mcp", secret: "s" });
    await assert.rejects(
      t.client.request("qq_configure", { endpoint: "ws://127.0.0.1:3001/", self_id: MOCK_QQ_ACCOUNT, credential: "qq-bad-host" }),
      /host.*不一致/,
    );
    await assert.rejects(
      t.client.request("qq_configure", { endpoint: "ws://127.0.0.1:3001/", self_id: MOCK_QQ_ACCOUNT, credential: "qq-bad-purpose" }),
      /purpose=qq_onebot/,
    );
    // 正常配置 + 期望版本冲突
    t.runtime.credentials.upsert({ name: "qq-ok", host: "127.0.0.1:3001", header: "authorization", purpose: "qq_onebot", secret: "s" });
    const config = (await t.client.request<any>("qq_configure", {
      endpoint: "ws://127.0.0.1:3001/",
      self_id: MOCK_QQ_ACCOUNT,
      credential: "qq-ok",
    })) as any;
    assert.equal(config.configVersion, 1);
    assert.equal(config.enabled, false, "配置后默认停用，需显式启用");
    assert.ok(!JSON.stringify(config).includes('"secret"'), "配置视图不得包含秘密值");
    await assert.rejects(
      t.client.request("qq_configure", { endpoint: "ws://127.0.0.1:3001/", self_id: MOCK_QQ_ACCOUNT, expected_version: 99 }),
      /版本冲突/,
    );
    // 凭据 scope 已收紧到 qq_onebot：通用 http_request 不得借用
    const cred = t.runtime.credentials.get("qq-ok")!;
    assert.ok(cred.scope?.operations?.includes("qq_onebot"));
    assert.equal(t.runtime.credentials.getForUse("qq-ok"), null, "无 scope 上下文的调用不得取得该凭据");
    const events = t.runtime.store.getEventsAfter(0).filter((e) => (e.body as any).type === "qq.config_changed");
    assert.equal(events.length, 1);
  } finally {
    await t.shutdown();
  }
});

// ---------- 连接与身份 ----------

test("qq：token 错误时不接纳事件（保持离线，不产生任务）", async () => {
  const f = await startQq("qq-bad-token", replyText, { credentialSecret: "wrong-secret" });
  try {
    await new Promise((r) => setTimeout(r, 600));
    const status = await f.t.client.request<any>("qq_status", {});
    assert.equal(status.online, false);
    f.onebot.pushGroupMessage({ groupId: GROUP_A, userId: USER_1, messageId: 1, segments: atSegments("你好") });
    await new Promise((r) => setTimeout(r, 300));
    const inbox = await f.t.client.request<any>("qq_inbox_list", {});
    assert.equal(inbox.entries.length, 0, "鉴权失败时不得接纳任何消息");
    assert.equal(groupSends(f.onebot).length, 0);
  } finally {
    await shutdownQq(f);
  }
});

test("qq：登录账号与预期不一致时不接纳事件", async () => {
  const f = await startQq("qq-wrong-account", replyText, { mockAccount: "990002" });
  try {
    await waitOnline(f.t); // 连接本身在线，但账号不是预期的 990001
    const status = await f.t.client.request<any>("qq_status", {});
    assert.equal(status.actualSelfId, "990002");
    f.onebot.pushGroupMessage({ groupId: GROUP_A, userId: USER_1, messageId: 1, segments: atSegments("你好") });
    await new Promise((r) => setTimeout(r, 300));
    const inbox = await f.t.client.request<any>("qq_inbox_list", {});
    assert.equal(inbox.entries.length, 0, "身份不匹配时不得接纳消息");
  } finally {
    await shutdownQq(f);
  }
});

test("qq：掉线停止接收，重连后恢复（不补发）", async () => {
  const f = await startQq("qq-reconnect", replyText);
  try {
    await waitOnline(f.t);
    f.onebot.dropConnections();
    await waitOffline(f.t);
    await waitOnline(f.t); // 自动重连
    // 断线窗口如实标记（不假定平台重投缺失消息）
    await waitFor("接收缺口事件", () =>
      f.t.runtime.store.getEventsAfter(0).some((e) => (e.body as any).type === "qq.receive_gap"),
    );
    // 重连后群消息仍被忽略（核心群聊已退役），私聊恢复见 test/40
    f.onebot.pushGroupMessage({ groupId: GROUP_A, userId: USER_1, messageId: 1, segments: atSegments("重连后") });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal((await f.t.client.request<any>("qq_inbox_list", {})).entries.length, 0);
    assert.equal(groupSends(f.onebot).length, 0);
  } finally {
    await shutdownQq(f);
  }
});

// ---------- 核心群聊退役（agent-direction issue 20） ----------

test("qq：群消息直接忽略——不登记、不建会话、不建任务、不回复、不记日志", async () => {
  const f = await startQq("qq-group-ignored", replyText);
  try {
    await waitOnline(f.t);
    f.onebot.pushGroupMessage({ groupId: GROUP_A, userId: USER_1, messageId: 1, segments: atSegments("周末聚餐谁去？") });
    f.onebot.pushGroupMessage({ groupId: "100099", userId: USER_2, messageId: 2, segments: atSegments("另一条群消息") });
    await new Promise((r) => setTimeout(r, 500));
    const rt = f.t.runtime;
    assert.equal((await f.t.client.request<any>("qq_inbox_list", { limit: 50 })).entries.length, 0, "不登记收件");
    assert.equal((await f.t.client.request<any>("qq_outbox_list", { limit: 50 })).entries.length, 0, "不登记发送");
    assert.equal(rt.qqStore.listGroupSessions().length, 0, "不建群会话映射");
    assert.equal(groupSends(f.onebot).length, 0, "不发送群回复");
    assert.equal(f.t.server.calls.length, 0, "不调用模型");
    assert.equal(rt.store.listTasksByStatus(["queued", "running"]).length, 0, "不建任务");
    const status = await f.t.client.request<any>("qq_status", {});
    assert.equal(status.sessions.length, 0, "状态视图无群会话");
    // 未登记的撤回事件：不报错、不产生任何记录
    f.onebot.pushRecall({ groupId: GROUP_A, messageId: 1, userId: USER_1 });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(rt.qqStore.listInbox().length, 0);
  } finally {
    await shutdownQq(f);
  }
});

test("qq：qq_group 资料身份——授权不放大、owner_note 不放行、仅本项目", async () => {
  const root = await makeTestDirs("qq-access", 0);
  try {
    const db = new Db(root.dirs.dataDir);
    const store = new Store(db);
    const access = new AccessScope(db);
    const projDev = store.createProject("dev-proj");
    const projQq = store.createProject("qq-proj");
    // 拥有者误配置：向 QQ 项目授予开发项目历史——qq_group 身份不得因此可读
    access.createGrant({ fromProjectId: projDev.id, toProjectId: projQq.id, category: "history" });
    assert.equal(access.canAccess({ kind: "agent", projectId: projQq.id }, projDev.id, "history"), true, "对照：普通 agent 受授权覆盖");
    assert.equal(access.canAccess({ kind: "qq_group", projectId: projQq.id }, projDev.id, "history"), false);
    assert.equal(access.canAccess({ kind: "qq_group", projectId: projQq.id }, projQq.id, "history"), true, "本项目可读");
    assert.deepEqual(access.accessibleProjects({ kind: "qq_group", projectId: projQq.id }, "history"), [projQq.id]);
    assert.equal(access.sourceRefAccessible({ kind: "qq_group", projectId: projQq.id }, { kind: "owner_note", note: "x" }), false);
    assert.equal(access.sourceRefAccessible({ kind: "agent", projectId: projQq.id }, { kind: "owner_note", note: "x" }), true, "对照：普通 agent 可读 owner_note");
    db.close();
  } finally {
    await cleanupDirs(root.dirs);
  }
});
