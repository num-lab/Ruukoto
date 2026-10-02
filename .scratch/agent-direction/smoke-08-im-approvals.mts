/**
 * IM 审批的产品级冒烟（agent-direction issue 08）：真实 ruukoto 后台进程 +
 * 真实控制面 socket / SQLite / 配置操作 + 打桩模型与平台。
 *
 * 模拟（打桩，不算真实平台验收）：MockModelServer（模型）、MockOneBot（NapCat/
 * OneBot 协议）、FakeBotApi（Telegram Bot API）。真实：bin/ruukoto.mjs 后台
 * 进程（含重启）、控制面 socket、SQLite 库与 main.db 受控数据效果、QQ/Telegram
 * 配置与凭据写入、入站去重、审批通知/详情/决定、outbox 发送账本、重启恢复。
 *
 * 覆盖（与工单 08 验收标准对应）：
 *  1. QQ 私聊端到端：受控多行删除申请 → 原入口通知 → /approvals 列表 →
 *     /approval 详情 → /approve 批准 → 原操作恰好一次（main.db 行数核实）→
 *     原入口最终回答；原消息重投不重复；
 *  2. Telegram 私聊端到端：申请 → 通知 → /reject 拒绝零执行；格式错误只回用法；
 *     非 owner 消息被拒；引用中的命令不构成批准；决定消息重投读原回执；
 *  3. SQLite 直接核对：控制消息 event_kind=im_approval 且终态、通知键
 *     im-approval:<id>、回执键=控制事件 id、批准 consumed_at 恰好一次；
 *  4. 重启：待决审批停后台后一律失效、零重放；旧批准消息只回执已失效；
 *     重启后新流程正常批准执行。
 *
 * 结果约定：0 = 全部通过；1 = 有 FAIL。
 * 运行：npx tsx .scratch/agent-direction/smoke-08-im-approvals.mts
 */

import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { ControlClient } from "../../src/control/client.ts";
import { MockModelServer, type Responder } from "../../test/helpers/mock-provider.ts";
import { authenticateClient, makeTestDirs, cleanupDirs, lastUserText, waitFor, writeModelsJson } from "../../test/helpers/testkit.ts";
import { killProcessTree } from "../../test/helpers/backend.ts";
import { MOCK_QQ_ACCOUNT, MOCK_QQ_SECRET, startMockOneBot, type MockOneBot } from "../../test/helpers/mock-onebot.ts";
import { FakeBotApi } from "../../test/helpers/fake-bot-api.ts";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const startedAt = Date.now();
const QQ_OWNER = "880001";
const QQ_OTHER = "880002";
const TG_TOKEN = "123456:SMOKE08-TOKEN-X";
const TG_OWNER = 42;

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true, detail: "" });
    console.log(`PASS ${name}`);
  } catch (err) {
    results.push({ name, ok: false, detail: String((err as Error).message ?? err) });
    console.log(`FAIL ${name}: ${(err as Error).message}`);
  }
}

// ---------- 脚本化模型（唯一打桩的模型层；SEED3/SEED2 造数，DEL2-<a><b>-<TAG> → 多行删除受控操作） ----------
function smokeResponder(): Responder {
  let seed3Step = 0;
  let seeded2 = false;
  const deleted = new Set<string>();
  return async (req) => {
    const text = lastUserText(req);
    // 造数两段式必须在工具结果早退之前判定（lastUserText 不含工具结果）
    if (text.includes("SEED3")) {
      seed3Step += 1;
      if (seed3Step === 1) {
        return { kind: "tool_calls", calls: [{ id: "sd1", name: "app_data_define_table", arguments: { table: "todos", fields: [{ name: "title", type: "text" }], expected_schema_version: 0, reason: "建表" } }] };
      }
      if (seed3Step === 2) {
        return { kind: "tool_calls", calls: [{ id: "si1", name: "app_data_insert", arguments: { table: "todos", records: [{ title: "一" }, { title: "二" }, { title: "三" }], reason: "造三行" } }] };
      }
    }
    if (text.includes("SEED2") && !seeded2) {
      seeded2 = true;
      return { kind: "tool_calls", calls: [{ id: "si2", name: "app_data_insert", arguments: { table: "todos", records: [{ title: "四" }, { title: "五" }], reason: "补两行" } }] };
    }
    if (req.messages.at(-1)?.role === "tool") return { kind: "text", text: "done-smoke08" };
    const m = text.match(/DEL2-(\d)(\d)-([A-Z0-9]+)/);
    if (m && !deleted.has(m[0])) {
      deleted.add(m[0]);
      return { kind: "tool_calls", calls: [{ id: `x-${m[0]}`, name: "app_data_delete", arguments: { table: "todos", rows: [{ id: Number(m[1]), expected_version: 1 }, { id: Number(m[2]), expected_version: 1 }], reason: "清理" } }] };
    }
    return { kind: "text", text: "pong-smoke08" };
  };
}

const { dirs } = await makeTestDirs("smoke08", 0);
const controlDir = path.join(dirs.root, "control");
const model = new MockModelServer(smokeResponder());
const modelUrl = await model.start();
await writeModelsJson(dirs, modelUrl);
const onebot = await startMockOneBot({});
const api = new FakeBotApi({ token: TG_TOKEN, ownerId: TG_OWNER });
const apiBase = await api.start();

let child!: childProcess.ChildProcess;
let stderr = "";
function spawnBackend(): void {
  child = childProcess.spawn(
    process.execPath,
    [path.join(repoRoot, "bin", "ruukoto.mjs"), "server", "--data-dir", dirs.dataDir, "--agent-dir", dirs.agentDir, "--tools", "mock"],
    { cwd: repoRoot, env: { PATH: process.env.PATH, HOME: process.env.HOME, RUUKOTO_CONTROL_DIR: controlDir }, stdio: ["ignore", "ignore", "pipe"], detached: true },
  );
  stderr = "";
  child.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
}

async function connect(): Promise<ControlClient> {
  const socketPath = path.join(controlDir, "control.sock");
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`后台提前退出：${stderr.slice(0, 2000)}`);
    try {
      const client = await ControlClient.connect(socketPath, 1500);
      await authenticateClient(client, controlDir);
      await client.handshake();
      return client;
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`后台连接超时：${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

async function stopBackend(client: ControlClient): Promise<number | null> {
  await client.request("stop");
  client.close();
  return await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => resolve(null), 20_000);
    child.once("exit", (c0) => {
      clearTimeout(timer);
      resolve(c0);
    });
  });
}

const rowsOfTodos = (): number => {
  const db = new DatabaseSync(path.join(dirs.dataDir, "agent-data", "main.db"), { readOnly: true });
  try {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'todos'").get();
    if (!exists) return -1;
    return (db.prepare("SELECT COUNT(*) AS n FROM todos").get() as any).n;
  } finally {
    db.close();
  }
};
const coreDb = () => new DatabaseSync(path.join(dirs.dataDir, "ruukoto.db"), { readOnly: true });
const qqSendTexts = (ob: MockOneBot) =>
  ob.actions.filter((a) => a.action === "send_private_msg").map((a) => (a.params.message as any[]).filter((s) => s?.type === "text").map((s) => String(s.data?.text ?? "")).join(""));
const tgTexts = () => api.sends.map((s) => String(s.text));
const pushQq = (messageId: number, text: string, userId = QQ_OWNER) =>
  onebot.pushPrivateMessage({ userId, messageId, segments: [{ type: "text", data: { text } }] });
const noticeId = (text: string) => text.match(/审批 ID：(\S+)/)![1]!;

spawnBackend();
let client: ControlClient | null = null;
let firstConfId = "";
let qqConf2 = "";
let newConfId = "";
try {
  client = await connect();
  const c = client;

  // 平台配置（真实凭据写入与配置操作）
  await c.request("add_credential", { name: "qq-smoke", host: onebot.host, header: "authorization", purpose: "qq_onebot", secret: MOCK_QQ_SECRET });
  await c.request("qq_configure", { endpoint: onebot.url, self_id: MOCK_QQ_ACCOUNT, credential: "qq-smoke", owner_user_id: QQ_OWNER });
  await c.request("qq_set_enabled", { enabled: true });
  await c.request("add_credential", { name: "tg-smoke", host: new URL(apiBase).host, header: "none", purpose: "telegram_bot", secret: TG_TOKEN });
  await c.request("telegram_configure", { api_base: apiBase, credential: "tg-smoke", user_id: String(TG_OWNER) });
  await c.request("telegram_set_enabled", { enabled: true });
  await waitFor("QQ 在线", async () => ((await c.request<any>("qq_status")) as any).online === true);
  await waitFor("Telegram 在线", async () => ((await c.request<any>("telegram_status")) as any).online === true);

  // 造数（QQ 私聊进入 main 的真实任务：app_data 建表 + 三行）
  pushQq(1, "SEED3 造数");
  await waitFor("造数完成", () => rowsOfTodos() === 3);

  // ---------- 场景 1：QQ 端到端批准 ----------
  pushQq(2, "DEL2-12-QQSM 请批准");
  await waitFor("QQ 审批通知送达", () => qqSendTexts(onebot).some((t) => t.includes("【需要审批】")));
  const noticeText = qqSendTexts(onebot).find((t) => t.includes("【需要审批】"))!;
  firstConfId = noticeId(noticeText);
  const noticeVersion = Number(noticeText.match(/权限版本：v(\d+)/)![1]);
  await check("场景1a QQ：通知含工具/版本/完整 ID/命令；批准前零执行", () => {
    assert.ok(noticeText.includes("app_data_delete"));
    assert.ok(noticeText.includes(`/approve ${firstConfId} ${noticeVersion}`));
    assert.ok(noticeText.includes(`/reject ${firstConfId} ${noticeVersion}`));
    assert.ok(noticeText.includes(`/approval ${firstConfId}`));
    assert.equal(rowsOfTodos(), 3);
  });
  pushQq(3, "/approvals");
  await waitFor("QQ 列表回执", () => qqSendTexts(onebot).some((t) => t.includes("待处理审批 1 项")));
  pushQq(4, `/approval ${firstConfId}`);
  await waitFor("QQ 详情回执", () => qqSendTexts(onebot).some((t) => t.includes(`审批 ${firstConfId}`) && t.includes("参数（")));
  await check("场景1b QQ：列表/详情回执；命令零模型调用", () => {
    const list = qqSendTexts(onebot).find((t) => t.includes("待处理审批 1 项"))!;
    assert.ok(list.includes(firstConfId) && list.includes("app_data_delete"));
    const detail = qqSendTexts(onebot).find((t) => t.includes(`审批 ${firstConfId}`))!;
    assert.ok(detail.includes("范围：") && detail.includes(`/approve ${firstConfId} ${noticeVersion}`));
  });
  pushQq(5, `/approve ${firstConfId} ${noticeVersion}`);
  await waitFor("QQ 批准回执", () => qqSendTexts(onebot).some((t) => t.includes("已接受批准") && t.includes(firstConfId)));
  await waitFor("QQ 操作生效且最终回答回到原入口", () => rowsOfTodos() === 1 && qqSendTexts(onebot).some((t) => t.includes("done-smoke08")));
  await check("场景1c QQ：批准恰好执行一次", () => {
    assert.equal(rowsOfTodos(), 1, "行 1、2 被删一次");
  });
  // 平台重投同一消息：不重复处理
  pushQq(2, "DEL2-12-QQSM 请批准");
  await new Promise((r) => setTimeout(r, 800));
  await check("场景1d QQ：原消息重投不重建任务、不重复执行", () => {
    const db = coreDb();
    const n = (db.prepare("SELECT COUNT(*) AS n FROM inbound_events WHERE source = 'qq_private' AND external_id LIKE '%:2'").get() as any).n;
    db.close();
    assert.equal(n, 1, "同键只一条入站事件");
    assert.equal(rowsOfTodos(), 1);
  });

  // ---------- 场景 2：Telegram 拒绝 + 用法 + 重投 + 非 owner ----------
  pushQq(6, "SEED2 补两行");
  await waitFor("补数完成", () => rowsOfTodos() === 3);
  api.push({ text: "DEL2-34-TGSM" });
  await waitFor("Telegram 审批通知送达", () => tgTexts().some((t) => t.includes("【需要审批】")));
  const tgNotice = tgTexts().find((t) => t.includes("【需要审批】"))!;
  const tgConfId = noticeId(tgNotice);
  api.push({ text: "/approve" });
  await waitFor("Telegram 用法回执", () => tgTexts().some((t) => t.includes("用法：/approvals")));
  api.push({ text: "看到了，之后再说", replyTo: { message_id: 1, text: `/approve ${tgConfId} 1`, from: { is_bot: false } } });
  api.push({ text: `/reject ${tgConfId} 1`, from: 43, chatId: 43 });
  const tgReject = api.push({ text: `/reject ${tgConfId} 1` });
  await waitFor("Telegram 拒绝回执", () => tgTexts().some((t) => t.includes("已拒绝") && t.includes(tgConfId)));
  await new Promise((r) => setTimeout(r, 500));
  await check("场景2a Telegram：拒绝零执行；格式错误只回用法；非 owner 被拒；引用中的命令不构成批准", () => {
    assert.equal(rowsOfTodos(), 3, "拒绝与一切非法命令零执行");
    assert.ok(tgTexts().some((t) => t.includes("用法：/approvals")));
    assert.ok(!tgTexts().some((t) => t.includes("已接受批准")));
  });
  api.push({ message: tgReject });
  await new Promise((r) => setTimeout(r, 600));
  await check("场景2b Telegram：决定消息重投读原回执，不重复决定", () => {
    const db = coreDb();
    const controls = db.prepare("SELECT COUNT(*) AS n FROM inbound_events WHERE event_kind = 'im_approval' AND external_id = ?").get(`123456:${TG_OWNER}:${tgReject.message_id}`) as any;
    const confs = db.prepare("SELECT status, consumed_at FROM confirmations WHERE id = ?").get(tgConfId) as any;
    db.close();
    assert.equal(controls.n, 1, "同键控制事件只登记一次");
    assert.equal(confs.status, "rejected");
    assert.equal(confs.consumed_at, null);
  });

  // ---------- 场景 3：SQLite 直接核对 ----------
  await check("场景3 SQLite：控制事件类别/终态、通知与回执键、批准消费单一", () => {
    const db = coreDb();
    const controls = db.prepare("SELECT source, status, task_id FROM inbound_events WHERE event_kind = 'im_approval'").all() as any[];
    assert.ok(controls.length >= 4, "列表/详情/批准/拒绝/用法等控制事件已登记");
    assert.ok(controls.every((row) => row.status === "done" || row.status === "failed"));
    assert.ok(controls.every((row) => row.task_id === null));
    const notices = db.prepare("SELECT source_key, target, status FROM notification_ops WHERE source_kind = 'confirmation' AND source_key LIKE 'im-approval:%'").all() as any[];
    assert.ok(notices.length >= 2, "两平台各一条初始通知");
    const receipts = db.prepare("SELECT source_key, task_id, status FROM notification_ops WHERE source_kind = 'inbound_event'").all() as any[];
    assert.ok(receipts.length >= 3, "列表/详情/决定回执按控制事件键登记");
    const approved = db.prepare("SELECT COUNT(*) AS n FROM confirmations WHERE status = 'approved' AND consumed_at IS NOT NULL").get() as any;
    assert.equal(approved.n, 1, "恰好一次批准消费");
    const schema = (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as any).value;
    assert.equal(schema, "22", "schema v22");
    db.close();
  });

  // ---------- 场景 4：重启恢复 ----------
  pushQq(7, "DEL2-34-QQRS");
  await waitFor("重启前第二个 QQ 审批通知", () => qqSendTexts(onebot).filter((t) => t.includes("【需要审批】")).length >= 2);
  const qqNotice2 = qqSendTexts(onebot).filter((t) => t.includes("【需要审批】")).at(-1)!;
  qqConf2 = noticeId(qqNotice2);
  const stopCode = await stopBackend(c);
  client = null;
  assert.equal(stopCode, 0, "后台正常停止");
  spawnBackend();
  const c2 = await connect();
  client = c2;
  await check("场景4a 重启：待决与已批准未消费一律失效，零重放", () => {
    const db = coreDb();
    const row = db.prepare("SELECT status, consumed_at FROM confirmations WHERE id = ?").get(qqConf2) as any;
    const live = db.prepare("SELECT COUNT(*) AS n FROM confirmations WHERE status IN ('pending','approved') AND consumed_at IS NULL").get() as any;
    db.close();
    assert.equal(row.status, "stale", "待决审批恢复后失效");
    assert.equal(live.n, 0, "重启后无未消费的待决/批准");
    assert.equal(rowsOfTodos(), 3, "零重放执行");
  });
  pushQq(8, `/approve ${qqConf2} 1`);
  await waitFor("旧批准只回执已失效", () => qqSendTexts(onebot).some((t) => t.includes(qqConf2) && t.includes("已失效或已处理")));
  pushQq(9, "DEL2-34-QQNW");
  await waitFor("新代次通知", () => {
    const texts = qqSendTexts(onebot).filter((t) => t.includes("【需要审批】"));
    return texts.some((t) => ![firstConfId, qqConf2].includes(noticeId(t)));
  });
  newConfId = noticeId(qqSendTexts(onebot).filter((t) => t.includes("【需要审批】")).at(-1)!);
  pushQq(10, `/approve ${newConfId} 1`);
  await waitFor("新代次批准回执", () => qqSendTexts(onebot).some((t) => t.includes("已接受批准") && t.includes(newConfId)));
  await waitFor("新代次恰好执行一次", () => rowsOfTodos() === 1);
  await check("场景4b 重启后新流程正常批准执行", () => {
    assert.equal(rowsOfTodos(), 1, "行 3、4 恰好删除一次（剩行 5）");
  });

  const codeEnd = await stopBackend(c2);
  client = null;
  assert.equal(codeEnd, 0, "第二次后台正常停止");
} finally {
  if (client) client.close();
  if (child.exitCode === null && child.signalCode === null) killProcessTree(child);
  await model.close();
  await onebot.close();
  await api.close();
  await cleanupDirs(dirs);
}

const failed = results.filter((r) => !r.ok);
console.log("\n模拟：模型服务（MockModelServer）、NapCat OneBot（MockOneBot）、Telegram Bot API（FakeBotApi）——打桩平台，不代表真实 QQ/Telegram 已验收");
console.log("真实：bin/ruukoto.mjs 后台进程（两次拉起）、控制面 socket 与令牌、SQLite 库与 main.db 受控数据效果、QQ/Telegram 配置与凭据写入、入站去重、审批通知/详情/决定、outbox 发送账本、重启恢复");
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过（环境：${process.platform} ${process.arch}，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s）`);
if (failed.length > 0) process.exit(1);
