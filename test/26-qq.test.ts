/**
 * QQ 入口测试（NapCat OneBot v11 正向 WebSocket）。
 *
 * 经回环模拟 OneBot 验证传输状态与配置校验；归档群资料仍保持独立身份边界。
 * 私聊鉴权、登录账号核对、重连与接收边界见 test/40-qq-private.test.ts。
 * 核心群聊退役后的消息零新增、收尾与归档核查见
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
} from "./helpers/testkit.ts";
import { type Responder } from "./helpers/mock-provider.ts";
import { startMockOneBot, MOCK_QQ_SECRET, MOCK_QQ_ACCOUNT } from "./helpers/mock-onebot.ts";

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

// ---------- 归档资料身份 ----------

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
