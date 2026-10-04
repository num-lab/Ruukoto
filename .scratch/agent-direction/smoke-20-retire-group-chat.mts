/**
 * 核心群聊退役与旧群资料保全（agent-direction issue 20）升级冒烟。
 *
 * 旧数据不用播种助手伪造，而由退役前代码（HEAD 基点 e542261）真实产生：
 *   1. 以 e542261 的工作副本启动隔离 profile 的后台（容器后端）；
 *   2. 经模拟 OneBot 与模拟模型产生：两条完成并被 main 接收的群结果、一条
 *      已批准并在旧代码下送达的通知 A、一条已批准待发的通知 B（离线批准）、
 *      一条排队群任务、一条模型挂起的运行中群任务；
 *   3. 在群回复发送回执前 SIGKILL 后台（离线状态），留下一条 pending 发送；
 *   4. 篡改 B 的接收快照（归档行改动），换新代码（本仓库当前状态）在同一
 *      数据目录启动。
 * 验证工单验收第 1/2/4/5 条在真实升级路径上成立，并在第二次重启后核对幂等。
 * 撤回复核阻断已由 test/49 与 test/85 覆盖；这里在真实升级路径上验证篡改
 * 阻断（source_revoked）与真实撤回观测（归档标记 + 复核结论）。
 *
 * 模拟（打桩，不代表真实平台已验收）：MockModelServer（模型）、MockOneBot
 * （NapCat OneBot 协议）。真实 QQ 群与 NapCat 没有入口，记为未实测。
 * 真实：e542261 与当前代码两份 bin/ruukoto.mjs 后台进程、SIGKILL + 正常停止
 * + 再启动、控制面 socket 与令牌（旧代码段只经旧 CLI 驱动，控制协议 v13/v14
 * 各自匹配）、SQLite 库与 qq_inbox/qq_outbox/notification_ops 账本、Docker
 * 受限 worker（群任务真实容器执行路径）。
 *
 * 结果约定：0 = 全部通过；1 = 有 FAIL；2 = 基础设施缺失。
 * 旧代码来源：对本仓库执行 `git archive e542261`（可用 SMOKE20_BASE 覆盖）。
 * `--remote`：本机只做驱动——rsync 当前仓库与旧代码包到 tx，远端 npm ci 后
 * 在 tx 的既有受限执行环境（docker、ruukoto-worker 镜像）自包含跑完全程。
 */

import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { execFileSync, spawnSync } from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { ControlClient } from "../../src/control/client.ts";
import { MockModelServer, type Responder, type RecordedRequest } from "../../test/helpers/mock-provider.ts";
import { authenticateClient, cleanupDirs, lastUserText, makeTestDirs, waitFor, writeModelsJson } from "../../test/helpers/testkit.ts";
import { killProcessTree } from "../../test/helpers/backend.ts";
import { MOCK_QQ_ACCOUNT, MOCK_QQ_SECRET, startMockOneBot, type MockOneBot } from "../../test/helpers/mock-onebot.ts";

const BASE = process.env.SMOKE20_BASE ?? "e542261";
const IMAGE = process.env.RUUKOTO_WORKER_IMAGE ?? "ruukoto-worker:latest";
const UID = Number(process.env.RUUKOTO_CONTAINER_UID ?? (process.platform === "darwin" ? 1000 : (process.getuid?.() ?? 1000)));
const GID = Number(process.env.RUUKOTO_CONTAINER_GID ?? (process.platform === "darwin" ? 1000 : (process.getgid?.() ?? 1000)));
const startedAt = Date.now();
const SELF = ".scratch/agent-direction/smoke-20-retire-group-chat.mts";
const GROUP_A = "100001";
const GROUP_B = "100002";
const GROUP_C = "100003";
const OWNER = "880001";

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true, detail: "" });
    console.log(`PASS ${name}`);
  } catch (err) {
    results.push({ name, ok: false, detail: String((err as Error).message ?? err) });
    console.log(`FAIL ${name}: ${(err as Error).message}`);
    if (process.env.SMOKE20_DEBUG && stderr) console.log(`[后台 stderr 尾]\n${stderr.slice(-3000)}`);
  }
}

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

/** 用 git archive 准备退役前代码的工作副本（不含 .git、node_modules）。 */
function stageOldTree(dest: string): void {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const tar = path.join(dest, "old.tar");
  execFileSync("git", ["-C", repoRoot, "archive", BASE, "-o", tar], { stdio: "inherit" });
  execFileSync("tar", ["-xf", tar, "-C", dest], { stdio: "inherit" });
  fs.rmSync(tar);
  const rev = execFileSync("git", ["-C", repoRoot, "rev-parse", BASE], { encoding: "utf8" }).trim();
  console.log(`旧代码副本：${BASE}（${rev.slice(0, 12)}）→ ${dest}`);
}

// ---------- 远端驱动（--remote） ----------
if (process.argv.includes("--remote")) {
  const REMOTE = "tx";
  const RDIR = "/tmp/ruukoto-smoke20-src";
  const ROLD = "/tmp/ruukoto-smoke20-old";
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
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "smoke20-old-"));
  stageOldTree(path.join(staging, "old"));
  run("rsync 当前仓库到 tx", "rsync", ["-az", "--delete", "--exclude", "node_modules", "--exclude", ".git", "--exclude", "*.log", `${repoRoot}/`, `${REMOTE}:${RDIR}/`], { timeoutMs: 300_000 });
  run("rsync 旧代码副本到 tx", "rsync", ["-az", "--delete", `${staging}/old/`, `${REMOTE}:${ROLD}/`], { timeoutMs: 300_000 });
  run("远端 npm ci（新/旧两份）", "ssh", [REMOTE, `cd ${RDIR} && npm ci --no-audit --no-fund --prefer-offline && cd ${ROLD} && npm ci --no-audit --no-fund --prefer-offline`], { timeoutMs: 900_000 });
  const remote = run("远端冒烟（Linux 受限执行环境）", "ssh", [REMOTE, `cd ${RDIR} && SMOKE20_OLD_TREE=${ROLD} node_modules/.bin/tsx ${SELF}`], { allowFail: true, timeoutMs: 1200_000 });
  console.log(`\n=== 驱动结束：远端退出码 ${remote.code} ===`);
  fs.rmSync(staging, { recursive: true, force: true });
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

const OLD_TREE = process.env.SMOKE20_OLD_TREE ?? fs.mkdtempSync(path.join(os.tmpdir(), "smoke20-old-"));
if (!fs.existsSync(path.join(OLD_TREE, "bin", "ruukoto.mjs"))) stageOldTree(OLD_TREE);
if (!fs.existsSync(path.join(OLD_TREE, "node_modules", "tsx"))) {
  console.log("旧代码副本安装依赖（npm ci）…");
  execFileSync("npm", ["ci", "--no-audit", "--no-fund", "--prefer-offline"], { cwd: OLD_TREE, stdio: "inherit", timeout: 600_000 });
}

// ---------- 脚本化模型（唯一打桩的模型层） ----------
let hangGate: Promise<void> | null = null;
let releaseHang: () => void = () => {};
const acceptTaskIds = new Map<string, string>(); // "SMOKE20-ACCEPT-A" → 群任务 id
const notifyRefs = new Map<string, string>(); // "SMOKE20-NOTIFY-A" → task_id

const responder: Responder = async (req: RecordedRequest) => {
  const text = lastUserText(req);
  const afterTool = req.messages.at(-1)?.role === "tool";
  if (text.includes("C1-HANG")) {
    if (hangGate) await hangGate;
    return { kind: "text", text: "C1-DONE 挂起后不应到达新代码" };
  }
  if (text.includes("D1-INFLIGHT")) return { kind: "text", text: "D-RESULT 回执前崩溃的结果" };
  if (text.startsWith("[qq:")) return { kind: "text", text: text.includes("RESULT-A") ? "SMOKE20-CONCLUSION-A 周五发布的群结论" : text.includes("RESULT-B") ? "SMOKE20-CONCLUSION-B 下周排期的群结论" : "SMOKE20-GROUP-OK" };
  for (const [key, taskId] of acceptTaskIds) {
    if (text.includes(key)) {
      return afterTool
        ? { kind: "text", text: `已接收 ${taskId}` }
        : { kind: "tool_calls", calls: [{ id: `acc-${key}`, name: "chat_result_accept", arguments: { task_id: taskId, reason: "整理群结论" } }] };
    }
  }
  for (const [key, taskId] of notifyRefs) {
    if (text.includes(key)) {
      return afterTool
        ? { kind: "text", text: "已提交通知审批" }
        : { kind: "tool_calls", calls: [{ id: `ntf-${key}`, name: "notification_enqueue", arguments: { content: [{ kind: "chat_result", task_id: taskId }], reason: "告知拥有者" } }] };
    }
  }
  return { kind: "text", text: "PONG 私聊回复" };
};

const { dirs } = await makeTestDirs("smoke20", 0);
const controlDir = path.join(dirs.root, "control");
const model = new MockModelServer(responder);
const modelUrl = await model.start();
await writeModelsJson(dirs, modelUrl);
const onebot = await startMockOneBot({});

let child!: childProcess.ChildProcess;
let stderr = "";
function spawnBackend(tree: string): void {
  child = childProcess.spawn(
    process.execPath,
    [path.join(tree, "bin", "ruukoto.mjs"), "server", "--data-dir", dirs.dataDir, "--agent-dir", dirs.agentDir, "--execution", "container"],
    { cwd: tree, env: { PATH: process.env.PATH, HOME: process.env.HOME, RUUKOTO_CONTROL_DIR: controlDir, RUUKOTO_CONTAINER_UID: String(UID), RUUKOTO_CONTAINER_GID: String(GID) }, stdio: ["ignore", "ignore", "pipe"], detached: true },
  );
  stderr = "";
  child.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
}

/** 旧代码段只经旧 CLI（协议各自匹配）；配置与审批动作，查询一律走 SQLite。 */
function oldCli(args: string[]): string {
  const r = spawnSync(process.execPath, [path.join(OLD_TREE, "bin", "ruukoto.mjs"), ...args], {
    cwd: OLD_TREE,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, RUUKOTO_CONTROL_DIR: controlDir, QQ_ONEBOT_TOKEN: MOCK_QQ_SECRET },
    encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`旧 CLI ${args.join(" ")} 失败（${r.status}）：${(r.stderr ?? "").slice(0, 500)}`);
  return r.stdout ?? "";
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
      if (Date.now() > deadline) throw new Error(`后台连接超时：${(err as Error).message}${stderr.slice(0, 800)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

async function stopBackend(client: ControlClient): Promise<void> {
  await client.request("stop");
  client.close();
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => resolve(), 30_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

const coreDb = () => new DatabaseSync(path.join(dirs.dataDir, "ruukoto.db"), { readOnly: true });
const q = <T = any>(sql: string, ...args: unknown[]): T[] => {
  const db = coreDb();
  try { return db.prepare(sql).all(...args) as T[]; } finally { db.close(); }
};
const q1 = <T = any>(sql: string, ...args: unknown[]): T | undefined => q<T>(sql, ...args)[0];
const inboxRow = (groupId: string, messageId: string) =>
  q1<any>("SELECT * FROM qq_inbox WHERE dedup_key = ?", `${MOCK_QQ_ACCOUNT}:${groupId}:${messageId}`);
const notifyOps = () => q<any>("SELECT * FROM notification_ops WHERE source_kind IN ('confirmation','schedule_run','owner_reply') ORDER BY created_at");
const groupSends = (ob: MockOneBot) => ob.actions.filter((a) => a.action === "send_group_msg");
const privateSends = (ob: MockOneBot) => ob.actions.filter((a) => a.action === "send_private_msg");
const privateSendTexts = (ob: MockOneBot) =>
  privateSends(ob).map((a) => String((a.params.message as any[]).find((s) => s?.type === "text")?.data?.text ?? ""));
const privateReplyIds = (ob: MockOneBot) =>
  privateSends(ob).map((a) => String((a.params.message as any[]).find((s) => s?.type === "reply")?.data?.id ?? ""));

const CONCL_A = "SMOKE20-CONCLUSION-A 周五发布的群结论";
const CONCL_B = "SMOKE20-CONCLUSION-B 下周排期的群结论";

let client: ControlClient | null = null;
try {
  // ================= 阶段一：e542261 旧代码真实产生群资料 =================
  spawnBackend(OLD_TREE);
  await waitFor("旧后台控制面就绪", () => fs.existsSync(path.join(controlDir, "control.sock")), 90_000);
  oldCli(["credentials", "add", "--name", "qq-smoke", "--host", onebot.host, "--header", "authorization", "--purpose", "qq_onebot", "--secret-env", "QQ_ONEBOT_TOKEN"]);
  oldCli(["qq", "configure", "--endpoint", onebot.url, "--self-id", MOCK_QQ_ACCOUNT, "--credential", "qq-smoke", "--owner-id", OWNER]);
  for (const g of [GROUP_A, GROUP_B, GROUP_C]) oldCli(["qq", "group", "add", g]);
  oldCli(["qq", "enable"]);
  await waitFor("旧后台在线", () => onebot.connectionCount() >= 1, 90_000);
  await waitFor("角色引导完成", () => (q1<any>("SELECT id FROM agent_roles WHERE id = 'chat'") ?? null) !== null, 90_000);

  // 群 A：一条完成并被 main 接收的群结果
  onebot.pushGroupMessage({ groupId: GROUP_A, userId: "880002", messageId: 1, segments: [{ type: "at", data: { qq: MOCK_QQ_ACCOUNT } }, { type: "text", data: { text: "RESULT-A 请梳理周五发布结论" } }] });
  await waitFor("群 A 结果完成并回复", () => inboxRow(GROUP_A, "1")?.status === "done" && groupSends(onebot).length >= 1, 180_000);
  const taskA = inboxRow(GROUP_A, "1")!.task_id as string;

  // 群 B：第二条被接收的群结果
  onebot.pushGroupMessage({ groupId: GROUP_B, userId: "880002", messageId: 1, segments: [{ type: "at", data: { qq: MOCK_QQ_ACCOUNT } }, { type: "text", data: { text: "RESULT-B 请梳理下周排期" } }] });
  await waitFor("群 B 结果完成并回复", () => inboxRow(GROUP_B, "1")?.status === "done", 180_000);
  const taskB = inboxRow(GROUP_B, "1")!.task_id as string;

  const mainSession = q1<any>("SELECT session_id FROM agent_roles WHERE id = 'main'")!.session_id as string;
  acceptTaskIds.set("SMOKE20-ACCEPT-A", taskA);
  acceptTaskIds.set("SMOKE20-ACCEPT-B", taskB);
  await check("准备：两条群结果完成并被 main 接收（旧代码真实链路）", async () => {
    for (const key of ["SMOKE20-ACCEPT-A", "SMOKE20-ACCEPT-B"]) {
      oldCli(["submit", mainSession, key, key]);
      await waitFor(`${key} 完成`, () => q1<any>("SELECT status FROM tasks WHERE session_id = ? AND request_id = ?", mainSession, key)?.status === "completed", 180_000);
    }
    const acc = q<any>("SELECT task_id FROM chat_result_acceptances ORDER BY accepted_at");
    assert.deepEqual(acc.map((r) => r.task_id).sort(), [taskA, taskB].sort());
    const summaries = q<any>("SELECT summary FROM chat_result_acceptances ORDER BY accepted_at").map((r) => r.summary);
    assert.ok(summaries.includes(CONCL_A) && summaries.includes(CONCL_B));
  });

  // 群 C：运行中挂起的任务 + 其后排队任务（同群 FIFO）
  hangGate = new Promise<void>((resolve) => (releaseHang = resolve));
  onebot.pushGroupMessage({ groupId: GROUP_C, userId: "880002", messageId: 1, segments: [{ type: "at", data: { qq: MOCK_QQ_ACCOUNT } }, { type: "text", data: { text: "C1-HANG 挂起我" } }] });
  await waitFor("群 C 首条运行中", () => q1<any>("SELECT status FROM tasks WHERE id = (SELECT task_id FROM qq_inbox WHERE dedup_key = ?)", `${MOCK_QQ_ACCOUNT}:${GROUP_C}:1`)?.status === "running", 180_000);
  onebot.pushGroupMessage({ groupId: GROUP_C, userId: "880002", messageId: 2, segments: [{ type: "at", data: { qq: MOCK_QQ_ACCOUNT } }, { type: "text", data: { text: "C2-QUEUED 排在后面" } }] });
  await waitFor("群 C 第二条已排队", () => q1<any>("SELECT status FROM tasks WHERE id = (SELECT task_id FROM qq_inbox WHERE dedup_key = ?)", `${MOCK_QQ_ACCOUNT}:${GROUP_C}:2`)?.status === "queued", 120_000);

  // 通知 A：经私聊推入、在线批准（旧代码下正常送达一次——一次发送事实）。
  // 同一 main 会话同一时刻只留一个待审批：新任务启动会取代会话内未决审批。
  notifyRefs.set("SMOKE20-NOTIFY-A", taskA);
  notifyRefs.set("SMOKE20-NOTIFY-B", taskB);
  const pushNotifyAndConf = async (key: string, messageId: number): Promise<string> => {
    const before = q1<any>("SELECT COUNT(*) AS n FROM confirmations")!.n as number;
    onebot.pushPrivateMessage({ userId: OWNER, messageId, segments: [{ type: "text", data: { text: key } }] });
    let confId = "";
    await waitFor(`${key} 待审批`, () => {
      const rows = q<any>("SELECT id FROM confirmations WHERE status = 'pending' AND scope LIKE '%notification%' ORDER BY created_at");
      if ((q1<any>("SELECT COUNT(*) AS n FROM confirmations")!.n as number) > before && rows.length > 0) confId = rows.at(-1)!.id as string;
      return confId !== "";
    }, 180_000);
    return confId;
  };
  const confA = await pushNotifyAndConf("SMOKE20-NOTIFY-A", 10);
  oldCli(["confirm", confA, "approve"]);
  await waitFor("通知 A 已在旧代码下送达", () => notifyOps().some((o) => o.text === CONCL_A && o.status === "sent"), 240_000);

  // 群 A 第二条：任务完成但群回复回执前崩溃（pending 发送）
  onebot.setSendDelayMs(60_000);
  onebot.pushGroupMessage({ groupId: GROUP_A, userId: "880002", messageId: 9, segments: [{ type: "at", data: { qq: MOCK_QQ_ACCOUNT } }, { type: "text", data: { text: "D1-INFLIGHT 将完成未回执" } }] });
  await waitFor("遗留 pending 群发送已登记", () => q1<any>("SELECT status FROM qq_outbox WHERE reply_to_message_id = '9' AND group_id = ?", GROUP_A)?.status === "pending", 180_000);
  onebot.setSendDelayMs(0);

  // 通知 B：私聊推入产生待审批后断线再批准——op 必然停在 pending
  // （channel_offline）；离线批准只走控制面，此后旧代码不再回在线
  const confB = await pushNotifyAndConf("SMOKE20-NOTIFY-B", 11);
  onebot.setOnline(false);
  onebot.pushHeartbeat({ online: false });
  await new Promise((r) => setTimeout(r, 500));
  await check("准备：通知 B 经旧代码离线批准（op 离线等待）", async () => {
    oldCli(["confirm", confB, "approve"]);
    await waitFor("通知 B 已登记并离线等待", () => notifyOps().some((o) => o.text === CONCL_B), 120_000);
    const op = notifyOps().find((o) => o.text === CONCL_B)!;
    assert.equal(op.status, "pending", `状态 ${op.status}`);
    // 等 B 任务完成（释放 main 会话占用）再杀后台，保证升级后私聊队列可用
    await waitFor("通知 B 任务已完成", () =>
      q1<any>("SELECT status FROM tasks WHERE id = (SELECT task_id FROM confirmations WHERE id = ?)", confB)?.status === "completed", 240_000);
  });
  child.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 800));
  assert.notEqual(child.exitCode ?? child.signalCode, null, "旧后台已 SIGKILL");
  console.log("阶段一完成：旧代码已真实产生 接收×2/通知 A 已送达/通知 B 已批准待发/排队×1/运行中×1/pending 发送×1（离线状态下崩溃）");

  // 篡改 B 的接收快照（归档行被人为改动）——升级后发送前复核必须阻断 B，
  // 不需要真实撤回（撤回复核已由 test/49 与 test/85 覆盖，真实撤回观测见验收 2）
  {
    const db = new DatabaseSync(path.join(dirs.dataDir, "ruukoto.db"));
    db.prepare("UPDATE chat_result_acceptances SET summary = 'TAMPERED-SNAPSHOT' WHERE task_id = ?").run(taskB);
    db.close();
  }

  // ================= 阶段二：新代码升级启动 =================
  onebot.setSendDelayMs(0);
  onebot.setOnline(true);
  spawnBackend(repoRoot);
  client = await connect();
  await waitFor("新后台在线", async () => {
    try { return ((await client!.request<any>("qq_status")) as any).online === true; } catch { return false; }
  }, 120_000);

  await check("验收5-真实升级：排队群任务 canceled（reason=退役）、运行中 interrupted、pending 发送 unknown 且收件 reply_unknown、完成未回复与排队收件 skipped", () => {
    const c1 = q1<any>("SELECT status FROM tasks WHERE id = (SELECT task_id FROM qq_inbox WHERE dedup_key = ?)", `${MOCK_QQ_ACCOUNT}:${GROUP_C}:1`)!;
    assert.equal(c1.status, "interrupted");
    const c2 = q1<any>("SELECT status, error_message FROM tasks WHERE id = (SELECT task_id FROM qq_inbox WHERE dedup_key = ?)", `${MOCK_QQ_ACCOUNT}:${GROUP_C}:2`)!;
    assert.equal(c2.status, "canceled");
    assert.match(c2.error_message ?? "", /core_group_chat_retired/);
    const ob = q1<any>("SELECT status, error FROM qq_outbox WHERE reply_to_message_id = '9' AND group_id = ?", GROUP_A)!;
    assert.equal(ob.status, "unknown");
    assert.match(ob.error ?? "", /核心群聊已退役/);
    assert.equal(inboxRow(GROUP_A, "9")!.status, "reply_unknown");
    assert.equal(inboxRow(GROUP_C, "1")!.status, "skipped");
    assert.equal(inboxRow(GROUP_C, "2")!.status, "skipped");
    assert.equal(inboxRow(GROUP_A, "1")!.status, "done", "已终态归档不改写");
    assert.equal(groupSends(onebot).length, 3, "崩溃窗口的群发送不重放");
    assert.ok(!privateSendTexts(onebot).some((t) => t === CONCL_B), "崩溃时离线待发的 B 通知未被补发");
  });

  await check("验收4-真实升级：已批准待发的通知 B 在升级后复核失败取消（source_revoked 快照不匹配），不凭快照正文发送；A 的已送达事实不改写", async () => {
    await waitFor("通知 B 已取消", () => notifyOps().some((o) => o.status === "canceled" && o.text === CONCL_B), 240_000);
    const op = notifyOps().find((o) => o.text === CONCL_B)!;
    assert.match(op.error_message ?? "", /source_revoked.*快照不匹配/s, op.error_message ?? "");
    assert.ok(!privateSendTexts(onebot).some((t) => t === CONCL_B), "不凭快照继续发送（审批通知里的摘录不算送达）");
    const opA = notifyOps().find((o) => o.text === CONCL_A)!;
    assert.equal(opA.status, "sent", "旧代码已送达的 A 保持 sent，不重发不回退");
  });

  await check("验收1-真实升级：新群消息零新增；同连接私聊照常回复", async () => {
    const inboxCount = q1<any>("SELECT COUNT(*) AS n FROM qq_inbox")!.n as number;
    const taskCount = q1<any>("SELECT COUNT(*) AS n FROM tasks")!.n as number;
    const gs = groupSends(onebot).length;
    onebot.pushGroupMessage({ groupId: GROUP_A, userId: "880002", messageId: 20, segments: [{ type: "at", data: { qq: MOCK_QQ_ACCOUNT } }, { type: "text", data: { text: "NEW-GROUP 退役后还听吗" } }] });
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(q1<any>("SELECT COUNT(*) AS n FROM qq_inbox")!.n, inboxCount, "收件零新增");
    assert.equal(q1<any>("SELECT COUNT(*) AS n FROM tasks")!.n, taskCount, "任务零新增");
    assert.equal(groupSends(onebot).length, gs, "群回复零新增");
    onebot.pushPrivateMessage({ userId: OWNER, messageId: 50, segments: [{ type: "text", data: { text: "私聊继续" } }] });
    // 回复钉版原消息 id 50（崩溃遗留的 B owner_reply 补发也占一个 send，不能按计数断言）
    await waitFor("私聊回复送达", () => privateReplyIds(onebot).includes("50"), 240_000).catch((err) => {
      if (process.env.SMOKE20_DEBUG) {
        const main = q1<any>("SELECT session_id FROM agent_roles WHERE id = 'main'")!;
        console.log("[debug] main session:", JSON.stringify(q1<any>("SELECT id, queue_state, queue_pause_reason FROM sessions WHERE id = ?", main.session_id)));
        console.log("[debug] main tasks:", JSON.stringify(q<any>("SELECT id, status, request_id, error_message FROM tasks WHERE session_id = ? ORDER BY created_at DESC LIMIT 4", main.session_id)));
        console.log("[debug] inbound:", JSON.stringify(q<any>("SELECT id, source, event_kind, status, task_id FROM inbound_events ORDER BY received_at DESC LIMIT 4")));
        console.log("[debug] private sends:", JSON.stringify(privateSendTexts(onebot)), JSON.stringify(privateReplyIds(onebot)));
        console.log("[debug] qq status:", JSON.stringify(q1<any>("SELECT enabled, self_id, owner_user_id FROM qq_config")));
      }
      throw err;
    });
  });

  await check("验收2-真实升级：qq inbox 附接收记录与复核结论（A 可用，B 撤回后不可用）", async () => {
    // 真实撤回观测：退役后入口仍给已登记归档打标记
    onebot.pushRecall({ groupId: GROUP_B, messageId: 1, userId: "880002" });
    await waitFor("归档收件撤回标记", () => inboxRow(GROUP_B, "1")?.recalled === 1, 120_000);
    const list = (await client!.request<any>("qq_inbox_list", { limit: 50 })) as any;
    const byKey = new Map(list.entries.map((e: any) => [e.dedupKey, e]));
    const a = byKey.get(`${MOCK_QQ_ACCOUNT}:${GROUP_A}:1`)!;
    assert.equal(a.acceptance?.summary, CONCL_A);
    assert.equal(a.sourceProblem, null);
    const b = byKey.get(`${MOCK_QQ_ACCOUNT}:${GROUP_B}:1`)!;
    assert.ok(b.acceptance, "接收账本原样保留（含被篡改前的快照行——此处记录已被测试篡改）");
    assert.equal(b.recalled, true);
    assert.match(b.sourceProblem ?? "", /撤回/);
    assert.equal(byKey.get(`${MOCK_QQ_ACCOUNT}:${GROUP_C}:2`)!.status, "skipped");
    const outbox = (await client!.request<any>("qq_outbox_list", { limit: 50 })) as any;
    assert.ok(outbox.entries.length >= 1, "发送账本可查");
  });

  const counts = () => ({
    tasks: Object.fromEntries(q<any>("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status").map((r) => [r.status, r.n])),
    inbox: Object.fromEntries(q<any>("SELECT status, COUNT(*) AS n FROM qq_inbox GROUP BY status").map((r) => [r.status, r.n])),
    outbox: Object.fromEntries(q<any>("SELECT status, COUNT(*) AS n FROM qq_outbox GROUP BY status").map((r) => [r.status, r.n])),
    ops: Object.fromEntries(q<any>("SELECT status, COUNT(*) AS n FROM notification_ops GROUP BY status").map((r) => [r.status, r.n])),
  });

  await stopBackend(client);
  client = null;
  const before = counts();

  // ================= 阶段三：第二次重启核对幂等 =================
  spawnBackend(repoRoot);
  client = await connect();
  await new Promise((r) => setTimeout(r, 1200));
  await stopBackend(client);
  client = null;
  await check("验收5-幂等：第二次重启后任务/收件/发送/通知计数不变（不重放）", () => {
    assert.deepEqual(counts(), before);
    assert.equal(privateSendTexts(onebot).filter((t) => t === CONCL_A).length, 1, "通知不重发（审批通知摘录不算第二次送达）");
    assert.equal(groupSends(onebot).length, 3, "群回复不重放（旧代码 2 条已发 + 1 条崩溃在途，升级后零新增）");
  });
} finally {
  if (client) client.close();
  if (child && child.exitCode === null && child.signalCode === null) killProcessTree(child);
  await model.close();
  await onebot.close();
  await cleanupDirs(dirs);
  if (!process.env.SMOKE20_OLD_TREE) fs.rmSync(OLD_TREE, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log("\n模拟：模型服务（MockModelServer）、NapCat OneBot（MockOneBot）——打桩平台；真实 QQ 群与 NapCat 没有入口，未实测");
console.log("真实：退役前代码（git archive e542261）与当前代码两份后台进程、SIGKILL/正常停止/再启动、SQLite 账本、Docker 受限 worker、控制面令牌");
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过（环境：${process.platform} ${process.arch}，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s）`);
if (failed.length > 0) process.exit(1);
