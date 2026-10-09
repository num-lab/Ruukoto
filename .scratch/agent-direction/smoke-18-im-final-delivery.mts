/**
 * 异步工作最终结果送回原 IM 入口（agent-direction issue 18）的本机冒烟。
 *
 * 模拟（打桩，不代表真实 QQ/Telegram 已验收）：MockModelServer（模型）、
 * MockOneBot（NapCat/OneBot 协议）、FakeBotApi（Telegram Bot API）。
 * 真实：bin/ruukoto.mjs 后台进程（正常停止 + SIGKILL 后各一次重启）、控制面
 * socket 与令牌、SQLite 库与 notification_ops 账本、Docker 受限 worker
 * （子任务真实容器执行）、QQ/Telegram 配置与凭据写入。
 *
 * 覆盖（与工单验收对应，离线逻辑细节见 test/84）：
 *  1. QQ：受理 → 子任务挂起期间继续对话 → 最终汇报（顺序、引用原消息、键与 taskId）；
 *  2. Telegram：受理 → 汇报引用原入站消息；Telegram 轮次续派 QQ 工作，汇报仍发 QQ；
 *  3. 平台离线等待（wait_reason）后恢复只发一次；
 *  4. 重新绑定推进 configVersion：pending 汇报取消（target_changed），新目标零发送；
 *  5. 唤醒运行中 SIGKILL 再重启：只得到一份「中断」汇报。
 *
 * 结果约定：0 = 全部通过；1 = 有 FAIL；2 = docker/镜像不可用。
 * TMPDIR 可换位置。容器 uid/gid 约定同 smoke-11。
 *
 * `--remote`：本机只做驱动——rsync 当前仓库（HEAD + 未提交改动）到
 * tx:/tmp/ruukoto-smoke18-src，远端 npm ci 后在 tx 的既有受限执行环境
 * （docker）自包含跑完全程；远端退出码即结果。
 */

import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { execFileSync, spawnSync } from "node:child_process";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { ControlClient } from "../../src/control/client.ts";
import { MockModelServer, type Responder, type RecordedRequest } from "../../test/helpers/mock-provider.ts";
import { authenticateClient, makeTestDirs, cleanupDirs, lastUserText, waitFor, writeModelsJson } from "../../test/helpers/testkit.ts";
import { killProcessTree } from "../../test/helpers/backend.ts";
import { MOCK_QQ_ACCOUNT, MOCK_QQ_SECRET, startMockOneBot, type MockOneBot } from "../../test/helpers/mock-onebot.ts";
import { FakeBotApi } from "../../test/helpers/fake-bot-api.ts";

const IMAGE = process.env.RUUKOTO_WORKER_IMAGE ?? "ruukoto-worker:latest";
const UID = Number(process.env.RUUKOTO_CONTAINER_UID ?? (process.platform === "darwin" ? 1000 : (process.getuid?.() ?? 1000)));
const GID = Number(process.env.RUUKOTO_CONTAINER_GID ?? (process.platform === "darwin" ? 1000 : (process.getgid?.() ?? 1000)));
const startedAt = Date.now();
const QQ_OWNER = "880001";
const QQ_OTHER = "880002";
const TG_TOKEN = "123456:SMOKE18-TOKEN-X";
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

// ---------- 远端驱动（--remote：rsync 后在 tx 自包含执行） ----------
if (process.argv.includes("--remote")) {
  const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
  const REMOTE = "tx";
  const RDIR = "/tmp/ruukoto-smoke18-src";
  const SELF = ".scratch/agent-direction/smoke-18-im-final-delivery.mts";
  const run = (label: string, cmd: string, args: string[], opts: { allowFail?: boolean; timeoutMs?: number } = {}) => {
    console.log(`\n=== ${label} ===`);
    const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: opts.timeoutMs ?? 600_000 });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    const code = r.status ?? (r.signal ? -1 : 1);
    if (code !== 0 && !opts.allowFail) {
      console.error(`驱动步骤失败（${label}，退出码 ${code}${r.signal ? `，信号 ${r.signal}` : ""}）`);
      process.exit(1);
    }
    return { code };
  };
  run("探测 tx 环境", "ssh", [REMOTE, "set -e && node --version && docker version >/dev/null && echo docker-ok && docker image inspect ruukoto-worker:latest >/dev/null && echo image-ok"], { timeoutMs: 60_000 });
  run("记录代码状态", "bash", ["-lc", `git -C ${repoRoot} rev-parse --abbrev-ref HEAD; git -C ${repoRoot} rev-parse HEAD; git -C ${repoRoot} status --short`]);
  run("rsync 仓库到 tx", "rsync", ["-az", "--delete", "--exclude", "node_modules", "--exclude", ".git", "--exclude", ".idea", "--exclude", "*.log", `${repoRoot}/`, `${REMOTE}:${RDIR}/`], { timeoutMs: 300_000 });
  run("远端 npm ci", "ssh", [REMOTE, `cd ${RDIR} && npm ci --no-audit --no-fund --prefer-offline`], { timeoutMs: 600_000 });
  const remote = run("远端冒烟（Linux 受限执行环境）", "ssh", [REMOTE, `cd ${RDIR} && node_modules/.bin/tsx ${SELF}`], { allowFail: true, timeoutMs: 900_000 });
  console.log(`\n=== 驱动结束：远端退出码 ${remote.code} ===`);
  process.exit(remote.code === 0 ? 0 : 1);
}

// ---------- 基础设施门 ----------
try {
  execFileSync("docker", ["version"], { stdio: "ignore", timeout: 15_000 });
  execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore", timeout: 30_000 });
} catch {
  console.error(`基础设施缺失：需要 docker 可用且镜像 ${IMAGE} 存在（deploy/worker-image/build.sh 构建）`);
  process.exit(2);
}
console.log(`环境：${process.platform} ${process.arch}；镜像 ${IMAGE}；容器 uid:gid ${UID}:${GID}`);

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

// ---------- 脚本化模型（唯一打桩的模型层） ----------
let subGate: Promise<void> | null = null;
let releaseSub: () => void = () => {};
function armSub(): void {
  subGate = new Promise<void>((resolve) => (releaseSub = resolve));
}
let wakeLatch: Promise<void> | null = null;
function armWakeForever(): void {
  wakeLatch = new Promise<void>(() => {}); // 永不放行：用于在唤醒运行中杀后台
}
let workIdForMore = "";

const responder: Responder = async (req: RecordedRequest) => {
  const text = lastUserText(req);
  const afterTool = req.messages.at(-1)?.role === "tool";
  if (text.includes("[SubAgent 委派")) {
    if (subGate) await subGate;
    return { kind: "text", text: "SMOKE18-SUB-DONE 子任务结论" };
  }
  if (text.includes("[编排器]")) {
    if (wakeLatch) await wakeLatch;
    return { kind: "text", text: "SMOKE18-FINAL 汇总结论" };
  }
  if (text.includes("SMOKE18-MORE")) {
    if (afterTool) return { kind: "text", text: "SMOKE18-TG-ACCEPTED 二轮已受理" };
    return { kind: "tool_calls", calls: [{ id: "d9", name: "subagent_delegate", arguments: { request: "补充核对", key: "m9", work_id: workIdForMore, materials: [{ kind: "text", text: "材料 M9" }] } }] };
  }
  if (text.includes("SMOKE18-CHAT")) return { kind: "text", text: "PONG-CHAT 子任务运行中也能继续对话" };
  if (afterTool) return { kind: "text", text: "SMOKE18-ACCEPTED 已受理" };
  const m = text.match(/SMOKE18-DELEG(\d)/);
  if (m) {
    return { kind: "tool_calls", calls: [{ id: `d${m[1]}`, name: "subagent_delegate", arguments: { request: "调研要点", key: `m${m[1]}`, materials: [{ kind: "text", text: `材料 ${m[1]}` }] } }] };
  }
  return { kind: "text", text: "PONG" };
};

const { dirs } = await makeTestDirs("smoke18", 0);
const controlDir = path.join(dirs.root, "control");
const model = new MockModelServer(responder);
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
    [path.join(repoRoot, "bin", "ruukoto.mjs"), "server", "--data-dir", dirs.dataDir, "--agent-dir", dirs.agentDir, "--execution", "container"],
    { cwd: repoRoot, env: { PATH: process.env.PATH, HOME: process.env.HOME, RUUKOTO_CONTROL_DIR: controlDir, RUUKOTO_CONTAINER_UID: String(UID), RUUKOTO_CONTAINER_GID: String(GID) }, stdio: ["ignore", "ignore", "pipe"], detached: true },
  );
  stderr = "";
  child.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
}

async function connect(): Promise<ControlClient> {
  const socketPath = path.join(controlDir, "control.sock");
  const deadline = Date.now() + 90_000;
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
    const timer = setTimeout(() => resolve(null), 30_000);
    child.once("exit", (c0) => {
      clearTimeout(timer);
      resolve(c0);
    });
  });
}

const coreDb = () => new DatabaseSync(path.join(dirs.dataDir, "ruukoto.db"), { readOnly: true });
const reportRows = (): any[] => {
  const db = coreDb();
  try {
    return db.prepare("SELECT source_key, task_id, target, text, status, error_message, wait_reason FROM notification_ops WHERE source_kind = 'owner_reply' AND source_key LIKE '%#work:%' ORDER BY created_at").all() as any[];
  } finally {
    db.close();
  }
};
const qqTexts = (ob: MockOneBot) =>
  ob.actions.filter((a) => a.action === "send_private_msg").map((a) => (a.params.message as any[]).find((s) => s?.type === "text")?.data?.text ?? "");
const qqReplyIds = (ob: MockOneBot) =>
  ob.actions.filter((a) => a.action === "send_private_msg").map((a) => (a.params.message as any[]).find((s) => s?.type === "reply")?.data?.id ?? null);
const pushQq = (messageId: number, text: string, userId = QQ_OWNER) =>
  onebot.pushPrivateMessage({ userId, messageId, segments: [{ type: "text", data: { text } }] });

spawnBackend();
let client: ControlClient | null = null;
let baseSends = 0;
try {
  client = await connect();
  const c = client;
  await c.request("add_credential", { name: "qq-smoke", host: onebot.host, header: "authorization", purpose: "qq_onebot", secret: MOCK_QQ_SECRET });
  await c.request("qq_configure", { endpoint: onebot.url, self_id: MOCK_QQ_ACCOUNT, credential: "qq-smoke", owner_user_id: QQ_OWNER });
  await c.request("qq_set_enabled", { enabled: true });
  await c.request("add_credential", { name: "tg-smoke", host: new URL(apiBase).host, header: "none", purpose: "telegram_bot", secret: TG_TOKEN });
  await c.request("telegram_configure", { api_base: apiBase, credential: "tg-smoke", user_id: String(TG_OWNER) });
  await c.request("telegram_set_enabled", { enabled: true });
  await waitFor("QQ 在线", async () => ((await c.request<any>("qq_status")) as any).online === true);
  await waitFor("Telegram 在线", async () => ((await c.request<any>("telegram_status")) as any).online === true);

  // ---------- 场景 1：QQ 受理 → 继续对话 → 最终汇报 ----------
  armSub();
  pushQq(1, "SMOKE18-DELEG1 请调研");
  await waitFor("QQ 受理回复", () => qqTexts(onebot).some((t) => t.includes("SMOKE18-ACCEPTED")), 120_000);
  pushQq(2, "SMOKE18-CHAT 子任务还在跑");
  await waitFor("QQ 继续对话得到回复", () => qqTexts(onebot).some((t) => t.includes("PONG-CHAT")), 120_000);
  releaseSub();
  await waitFor("QQ 最终汇报送达", () => qqTexts(onebot).some((t) => t.includes("最终汇报")), 180_000);
  await check("场景1 QQ：受理在前、续聊居中、汇报在后；汇报引用原消息；键与 taskId", () => {
    const texts = qqTexts(onebot);
    const idx = (mark: string) => texts.findIndex((t) => t.includes(mark));
    assert.ok(idx("SMOKE18-ACCEPTED") < idx("PONG-CHAT") && idx("PONG-CHAT") < idx("[工作"), texts.join(" | "));
    const report = texts[idx("[工作")]!;
    const work1 = reportRows()[0]!;
    const workId = /\[工作 (\S+) 最终汇报\]/.exec(report)![1]!;
    workIdForMore = workId;
    assert.equal(report, `[工作 ${workId} 最终汇报]\nSMOKE18-FINAL 汇总结论`);
    assert.equal(qqReplyIds(onebot)[idx("[工作")], "1", "汇报引用工作发起消息（msg 1）");
    assert.equal(work1.status, "sent");
    const db = coreDb();
    const origin = db.prepare("SELECT t.source_event_id AS ev FROM tasks t JOIN work_delegations w ON w.origin_task_id = t.id WHERE w.id = ?").get(workId) as any;
    const execs = (db.prepare("SELECT id FROM tasks WHERE work_id = ?").all(workId) as any[]).map((r) => r.id);
    const wakeTask = db.prepare("SELECT input FROM tasks WHERE id = ?").get(work1.task_id) as any;
    db.close();
    assert.equal(work1.source_key.split("#")[0], origin.ev, "发送键前缀 = 工作发起任务的来源事件");
    assert.ok(execs.some((id) => work1.source_key.endsWith(`:${id}`)), "发送键尾部 = 本次收尾的执行任务");
    assert.match(wakeTask.input, /子任务：/, "taskId 为收尾唤醒任务");
    assert.match(wakeTask.input, /\[最终汇报\]/, "唤醒输入附收尾汇报规则");
  });

  // ---------- 场景 2：Telegram 受理→汇报引用原消息；Telegram 轮次续派仍发 QQ ----------
  const tg1 = api.push({ text: "SMOKE18-DELEG2 请调研", from: TG_OWNER });
  await waitFor("Telegram 受理回复", () => api.sends.some((s) => s.text.includes("SMOKE18-ACCEPTED")), 120_000);
  await waitFor("Telegram 最终汇报送达", () => api.sends.some((s) => s.text.includes("[工作")), 180_000);
  await check("场景2a Telegram：汇报引用原入站消息", () => {
    const report = api.sends.find((s) => s.text.includes("[工作"))!;
    assert.equal(report.text, `[工作 ${/\[工作 (\S+) 最终汇报\]/.exec(report.text)![1]} 最终汇报]\nSMOKE18-FINAL 汇总结论`);
    assert.equal(report.reply_parameters?.message_id, tg1.message_id, "汇报引用工作发起消息");
  });
  armSub();
  api.push({ text: "SMOKE18-MORE 按 QQ 的工作再补一轮", from: TG_OWNER });
  await waitFor("Telegram 二轮受理", () => api.sends.some((s) => s.text.includes("SMOKE18-TG-ACCEPTED")), 120_000);
  releaseSub();
  await waitFor("二轮收尾汇报送达 QQ", () => reportRows().length === 3 && qqTexts(onebot).filter((t) => t.includes(`工作 ${workIdForMore} 最终汇报`)).length === 2, 180_000);
  await check("场景2b Telegram 轮次续派：第二份汇报仍发 QQ，Telegram 零汇报", () => {
    const keys = reportRows().map((r) => r.source_key);
    assert.equal(new Set(keys).size, 3, "每次收尾键各异（QQ 一轮/ TG 一轮 QQ 工作二轮/ TG 工作）");
    const tgWorkReports = reportRows().filter((r) => JSON.parse(r.target).channel === "qq_private" && r.source_key.includes(workIdForMore));
    assert.equal(tgWorkReports.length, 2, "QQ 工作的两份汇报都在 QQ");
    assert.ok(!api.sends.some((s) => s.text.includes(workIdForMore)), "Telegram 零工作汇报");
  });

  // ---------- 场景 3：平台离线等待后恢复只发一次 ----------
  armSub();
  pushQq(3, "SMOKE18-DELEG3 请调研");
  await waitFor("第三轮受理回复", () => qqTexts(onebot).filter((t) => t.includes("SMOKE18-ACCEPTED")).length === 2, 120_000);
  onebot.setOnline(false);
  onebot.pushHeartbeat({ online: false });
  await waitFor("QQ 已离线", async () => ((await c.request<any>("qq_status")) as any).online === false, 60_000);
  releaseSub();
  await waitFor("离线期间汇报登记为等待", () => reportRows().some((r) => r.status === "pending" && r.wait_reason && r.wait_reason.includes("channel_offline")), 180_000);
  await check("场景3a 离线等待：pending 记 channel_offline 等待原因", () => {
    const waiting = reportRows().find((r) => r.status === "pending")!;
    assert.match(waiting.wait_reason, /channel_offline/);
  });
  const pendingKey = reportRows().find((r) => r.status === "pending")!.source_key;
  onebot.setOnline(true);
  onebot.pushHeartbeat();
  await waitFor("QQ 恢复在线", async () => ((await c.request<any>("qq_status")) as any).online === true, 60_000);
  await waitFor("恢复后该汇报送达", () => reportRows().some((r) => r.source_key === pendingKey && r.status === "sent"), 120_000);
  baseSends = qqTexts(onebot).filter((t) => t.includes("最终汇报")).length;
  await new Promise((r) => setTimeout(r, 1200));
  await check("场景3b 恢复后只发一次（含等待窗口无重发）", () => {
    assert.equal(qqTexts(onebot).filter((t) => t.includes("最终汇报")).length, baseSends);
  });

  // ---------- 场景 4：重新绑定后取消、不改发 ----------
  armSub();
  pushQq(4, "SMOKE18-DELEG4 请调研", QQ_OWNER);
  await waitFor("第四轮受理回复", () => qqTexts(onebot).filter((t) => t.includes("SMOKE18-ACCEPTED")).length === 3, 120_000);
  onebot.setOnline(false);
  onebot.pushHeartbeat({ online: false });
  await waitFor("QQ 已离线", async () => ((await c.request<any>("qq_status")) as any).online === false, 60_000);
  releaseSub();
  await waitFor("第四份汇报登记为 pending", () => reportRows().filter((r) => r.status === "pending").length === 1, 180_000);
  const held = reportRows().find((r) => r.status === "pending")!;
  await c.request("qq_configure", { endpoint: onebot.url, self_id: MOCK_QQ_ACCOUNT, credential: "qq-smoke", owner_user_id: QQ_OTHER });
  onebot.setOnline(true);
  onebot.pushHeartbeat();
  await waitFor("QQ 重新在线", async () => ((await c.request<any>("qq_status")) as any).online === true, 60_000);
  await waitFor("旧目标汇报被取消", () => reportRows().filter((r) => r.status === "pending").length === 0, 120_000);
  await check("场景4 重新绑定：pending 汇报按 target_changed 取消、新目标零发送", () => {
    const row = reportRows().find((r) => r.source_key === held.source_key)!;
    assert.equal(row.status, "canceled");
    assert.match(row.error_message ?? "", /target_changed/);
    const toOther = onebot.actions.filter((a) => a.action === "send_private_msg" && String(a.params.user_id) === QQ_OTHER);
    assert.equal(toOther.length, 0, "新 owner 零发送");
  });

  // ---------- 场景 5：唤醒运行中 SIGKILL，重启后只得到一份「中断」汇报 ----------
  await c.request("qq_configure", { endpoint: onebot.url, self_id: MOCK_QQ_ACCOUNT, credential: "qq-smoke", owner_user_id: QQ_OWNER });
  onebot.pushHeartbeat();
  await waitFor("换绑回原 owner 后 QQ 在线（连接代次重建完成）", async () => ((await c.request<any>("qq_status")) as any).online === true, 60_000);
  armWakeForever();
  const wakeCallsBefore = model.calls.filter((r) => lastUserText(r).includes("[编排器]")).length;
  pushQq(5, "SMOKE18-DELEG5 请调研", QQ_OWNER);
  await waitFor("第五轮受理回复", () => qqTexts(onebot).filter((t) => t.includes("SMOKE18-ACCEPTED")).length === 4, 120_000);
  await waitFor("唤醒模型调用已开始（挂住）", () => model.calls.filter((r) => lastUserText(r).includes("[编排器]")).length > wakeCallsBefore, 180_000);
  child.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 800));
  assert.notEqual(child.exitCode ?? child.signalCode, null, "后台已被 SIGKILL 终止");
  const killsBefore = reportRows().length;
  spawnBackend();
  const c5 = await connect();
  client = c5;
  await waitFor("QQ 重连在线", async () => {
    try {
      return ((await client!.request<any>("qq_status")) as any).online === true;
    } catch {
      return false;
    }
  }, 120_000);
  await waitFor("「中断」汇报送达", () => reportRows().length === killsBefore + 1 && reportRows().at(-1)!.status === "sent", 180_000);
  await check("场景5 唤醒中断：重启后恰好一份固定「中断/未知」汇报", () => {
    const row = reportRows().at(-1)!;
    assert.match(row.text, /最终汇报.*(被后台重启中断|失败或已取消|超时)/s, `正文：${row.text}`);
    assert.equal(reportRows().filter((r) => r.source_key === row.source_key).length, 1, "同一收尾只有一份");
  });

  const codeEnd = await stopBackend(c5);
  client = null;
  assert.equal(codeEnd, 0, "末次后台正常停止");
} finally {
  if (client) client.close();
  if (child && child.exitCode === null && child.signalCode === null) killProcessTree(child);
  await model.close();
  await onebot.close();
  await api.close();
  await cleanupDirs(dirs);
}

const failed = results.filter((r) => !r.ok);
console.log("\n模拟：模型服务（MockModelServer）、NapCat OneBot（MockOneBot）、Telegram Bot API（FakeBotApi）——打桩平台，不代表真实 QQ/Telegram 已验收");
console.log("真实：bin/ruukoto.mjs 后台进程（正常停止 + SIGKILL 各一次重启）、控制面 socket 与令牌、SQLite 库与 notification_ops 账本、Docker 受限 worker、QQ/Telegram 配置与凭据写入");
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过（环境：${process.platform} ${process.arch}，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s）`);
if (failed.length > 0) process.exit(1);
