/**
 * 旧实例个人资料迁入全新 ruukoto 的产品级冒烟（agent-direction issue 22，ADR 0023）。
 *
 * 模型层打桩（MockModelServer，确定性脚本），Telegram Bot API 打桩（本机 HTTP
 * stub，其余全真）：真实 bin/ruukoto.mjs 双实例后台进程、控制面 socket、SQLite、
 * JSONL 历史、产物、实例锁与离线 legacy-import CLI（ruukoto 产品方向）。
 *
 * 覆盖（与工单 22 验收的交接维度对应）：
 *  1. 真实源实例造 main 会话历史后停止；停库直写平台配置/凭据/调度三态/发送
 *     账本/入站/长期授权（旧实例形态）；
 *  2. CLI legacy-import preview --from --plan：目标零写入、计划写回绑定字段；
 *  3. CLI apply --plan：回执与备份，凭据合并进目标；再 apply 返回 replayed；
 *  4. 启动目标后台（真实进程 + telegram stub）：首次 getUpdates 恰以导入的
 *     偏移 +1 继续（不重复消费）；canned 更新恰处理一次且 owner 回复恰一条；
 *     逾期 wake / notify 调度恰触发一次（新发送恰一条），旧 pending 发送为
 *     canceled 不再外发；main 历史可读、长期授权保留；模型请求只来自新派发；
 *  5. 目标回退因有切换期间事实被拒绝并逐项列出；
 *  6. 第二目标干净 apply + revert：行/文件/凭据移除、回执 reverted、源目录
 *     逐文件 sha256 前后不变。
 *
 * 结果约定：0 = 全部通过；1 = 有 FAIL。所有路径位于临时档案，不碰日常实例。
 * 运行：npx tsx .scratch/agent-direction/smoke-22-migrate-personal-instance.mts
 * `--remote`：本机只做驱动——rsync 当前仓库到 tx:/tmp/ruukoto-smoke22-src，
 * 远端 npm ci 后在 tx（Linux）上跑同一脚本（真实数据目标平台为 Linux 服务器）。
 */

import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { ControlClient } from "../../src/control/client.ts";
import { MockModelServer } from "../../test/helpers/mock-provider.ts";
import { authenticateClient, makeTestDirs, waitFor, writeModelsJson } from "../../test/helpers/testkit.ts";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

// ---------- 远端驱动 ----------
if (process.argv.includes("--remote")) {
  const REMOTE = "tx";
  const RDIR = "/tmp/ruukoto-smoke22-src";
  const SELF = ".scratch/agent-direction/smoke-22-migrate-personal-instance.mts";
  const run = (label: string, cmd: string, args: string[], opts: { allowFail?: boolean; timeoutMs?: number } = {}) => {
    console.log(`\n=== ${label} ===`);
    const r = childProcess.spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: opts.timeoutMs ?? 600_000 });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    const code = r.status ?? (r.signal ? -1 : 1);
    if (code !== 0 && !opts.allowFail) {
      console.error(`驱动步骤失败（${label}，退出码 ${code}${r.signal ? `，信号 ${r.signal}` : ""}）`);
      process.exit(1);
    }
    return { code };
  };
  run("探测 tx 环境", "ssh", [REMOTE, "set -e && node --version"], { timeoutMs: 60_000 });
  run("记录代码状态", "bash", ["-lc", `git -C ${repoRoot} rev-parse --abbrev-ref HEAD; git -C ${repoRoot} rev-parse HEAD; git -C ${repoRoot} status --short`]);
  run("rsync 仓库到 tx", "rsync", ["-az", "--delete", "--exclude", "node_modules", "--exclude", ".git", `${repoRoot}/`, `${REMOTE}:${RDIR}/`], { timeoutMs: 300_000 });
  run("远端 npm ci", "ssh", [REMOTE, `cd ${RDIR} && npm ci --no-audit --no-fund --prefer-offline`], { timeoutMs: 600_000 });
  const remote = run("远端冒烟（Linux）", "ssh", [REMOTE, `cd ${RDIR} && node_modules/.bin/tsx ${SELF}`], { allowFail: true, timeoutMs: 900_000 });
  console.log(`\n=== 驱动结束：远端退出码 ${remote.code} ===`);
  process.exit(remote.code === 0 ? 0 : 1);
}
const MODEL = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" };
const MAIN_ANSWER = "pong-smoke22-main";
const BOT_TOKEN = "777:smoke-token";
const OWNER_USER = "42";
const OWNER_CHAT = "4242";

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

function hashTree(root: string): string {
  const entries: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else entries.push(`${path.relative(root, p)}:${createHash("sha256").update(fs.readFileSync(p)).digest("hex")}`);
    }
  };
  walk(root);
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

// ---------- telegram Bot API stub：记录全部请求，首个 getUpdates 给一条 canned 更新 ----------
interface StubCall {
  method: string;
  body: Record<string, unknown>;
}
const stubCalls: StubCall[] = [];
let cannedServed = false;
const stub = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const url = req.url ?? "";
    const body = chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
    if (url.endsWith("/getUpdates")) {
      stubCalls.push({ method: "getUpdates", body });
      const result = cannedServed
        ? []
        : [
            {
              update_id: 101,
              message: {
                message_id: 201,
                from: { id: Number(OWNER_USER) },
                chat: { id: Number(OWNER_CHAT), type: "private" },
                date: 1_800_000_000,
                text: "ping-smoke22",
              },
            },
          ];
      cannedServed = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result }));
      return;
    }
    if (url.endsWith("/sendMessage")) {
      stubCalls.push({ method: "sendMessage", body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { message_id: 900 + stubCalls.length } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
});
await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
const stubPort = (stub.address() as AddressInfo).port;
const apiBase = `http://127.0.0.1:${stubPort}`;

const { dirs: srcDirs } = await makeTestDirs("smoke22-src", 0);
const srcControl = path.join(srcDirs.root, "control");
const { dirs: dstDirs } = await makeTestDirs("smoke22-dst", 0);
const dstControl = path.join(dstDirs.root, "control");
const { dirs: dst2Dirs } = await makeTestDirs("smoke22-dst2", 0);
const model = new MockModelServer(async () => ({ kind: "text", text: MAIN_ANSWER }));
const modelUrl = await model.start();
await writeModelsJson(srcDirs, modelUrl);
await writeModelsJson(dstDirs, modelUrl);
await writeModelsJson(dst2Dirs, modelUrl);

interface Backend {
  child: childProcess.ChildProcess;
  stderr: () => string;
}
function spawnBackend(bin: string, dataDir: string, agentDir: string, controlDir: string, controlEnv: string): Backend {
  const captured: string[] = [];
  const child = childProcess.spawn(process.execPath, [path.join(repoRoot, "bin", bin), "server", "--data-dir", dataDir, "--agent-dir", agentDir, "--tools", "mock"], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, [controlEnv]: controlDir },
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  child.stderr!.on("data", (c: Buffer) => captured.push(c.toString("utf8")));
  return { child, stderr: () => captured.join("") };
}

async function connect(child: childProcess.ChildProcess, controlDir: string, stderr: () => string): Promise<ControlClient> {
  const socketPath = path.join(controlDir, "control.sock");
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`后台提前退出：${stderr().slice(0, 2000)}`);
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

async function stopBackend(client: ControlClient, backend: Backend): Promise<void> {
  await client.request("stop");
  client.close();
  await new Promise<void>((resolve) => {
    if (backend.child.exitCode !== null) return resolve();
    const timer = setTimeout(() => resolve(), 20_000);
    backend.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function dbRows(dbFile: string, sql: string, params: unknown[] = []): Array<Record<string, unknown>> {
  const db = new DatabaseSync(dbFile);
  try {
    return db.prepare(sql).all(...(params as never[])) as unknown as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  // ---------- 场景 1：真实源实例造源 ----------
  let sourceHashAfterStop = "";
  let mainSessionId = "";
  await check("1 真实源实例：main 历史 + 停库种子平台/调度/发送/授权", async () => {
    const backend = spawnBackend("ruukoto.mjs", srcDirs.dataDir, srcDirs.agentDir, srcControl, "RUUKOTO_CONTROL_DIR");
    const client = await connect(backend.child, srcControl, backend.stderr);
    mainSessionId = String(
      (dbRows(path.join(srcDirs.dataDir, "ruukoto.db"), "SELECT session_id FROM agent_roles WHERE id = 'main'")[0] as { session_id: string }).session_id,
    );
    await client.request("submit", { session_id: mainSessionId, request_id: "s1", input: "smoke22 主会话种子", model_selection: MODEL });
    await waitFor("源主会话任务终态", async () => {
      const found = await client.request("find_task", { session_id: mainSessionId, request_id: "s1" });
      return found.task && (await client.request("get_task", { task_id: found.task.id })).task.status === "completed";
    });
    await stopBackend(client, backend);

    // 停库直写旧实例形态（平台配置含偏移、调度三态、发送账本、入站、长期授权）
    const db = new DatabaseSync(path.join(srcDirs.dataDir, "ruukoto.db"));
    const NOW = "2026-10-03T00:00:00.000Z";
    const PAST = "2026-10-01T00:00:00.000Z";
    // 钉版目标的 account = botId（适配器由 token 推导），chatId = owner 私聊
    const notifyTarget = JSON.stringify({ channel: "telegram", account: "777", chatId: OWNER_CHAT, configVersion: 7 });
    db.exec(`
      INSERT INTO telegram_config (id, api_base, credential_name, owner_user_id, owner_chat_id, enabled, config_version, last_update_id, created_at, updated_at)
        VALUES (1, '${apiBase}', 'tg-smoke', '${OWNER_USER}', '${OWNER_CHAT}', 1, 7, 100, '${NOW}', '${NOW}');
      INSERT INTO qq_config (id, endpoint, credential_name, self_id, enabled, config_version, created_at, updated_at)
        VALUES (1, 'ws://127.0.0.1:9', NULL, '100', 0, 2, '${NOW}', '${NOW}');
      INSERT INTO inbound_events (id, source, external_id, actor, target_role, body, reply_target, received_at, event_kind, status)
        VALUES ('evt-old-done', 'telegram', '777:${OWNER_CHAT}:99', '${OWNER_USER}', 'main', '{"text":"旧消息"}', '${notifyTarget.replaceAll("'", "''")}', '${PAST}', 'task', 'done');
      INSERT INTO inbound_events (id, source, external_id, actor, target_role, body, received_at, event_kind, status)
        VALUES ('evt-old-registered', 'telegram', '777:${OWNER_CHAT}:100', '${OWNER_USER}', 'main', '{"text":"未派发"}', '${PAST}', 'task', 'registered');
      INSERT INTO schedules (id, create_key, params_digest, action, rule, payload, status, next_due_at, version, tz_data, reason, created_at, updated_at)
        VALUES ('sch-wake', 'k-wake', 'd1', 'wake_main', '{"kind":"once","at":"${PAST}","timeZone":"UTC","disambiguation":"compatible"}',
                '{"text":"演练唤醒","sourceRefs":[]}', 'active', '${PAST}', 1, 'UTC', '一次性唤醒', '${NOW}', '${NOW}');
      INSERT INTO schedules (id, create_key, params_digest, action, rule, payload, target, approval_id, status, next_due_at, version, tz_data, reason, created_at, updated_at)
        VALUES ('sch-notify', 'k-notify', 'd2', 'notify', '{"kind":"daily","time":"08:00","timeZone":"UTC","disambiguation":"compatible"}',
                '{"text":"早安-smoke22","sourceRefs":[]}', '${notifyTarget.replaceAll("'", "''")}', 'appr-n', 'active', '${PAST}', 1, 'UTC', '每日一句', '${NOW}', '${NOW}');
      INSERT INTO notification_ops (id, source_kind, source_key, target, text, text_sha256, status, created_at, updated_at)
        VALUES ('op-old-pending', 'schedule_run', 'run-open', '${notifyTarget.replaceAll("'", "''")}', '旧待发不重复外发', '${createHash("sha256").update("旧待发不重复外发").digest("hex")}', 'pending', '${NOW}', '${NOW}');
      INSERT INTO notification_ops (id, source_kind, source_key, target, text, text_sha256, status, sending_at, created_at, updated_at)
        VALUES ('op-old-sending', 'confirmation', 'task:old', '${notifyTarget.replaceAll("'", "''")}', '旧发送中', '${createHash("sha256").update("旧发送中").digest("hex")}', 'sending', '${NOW}', '${NOW}', '${NOW}');
      INSERT INTO schedule_runs (id, schedule_id, schedule_version, scheduled_for, local_time, registered_at, delay_ms, notification_op_id, closed_at)
        VALUES ('run-open', 'sch-notify', 1, '${PAST}', '${PAST}', '${NOW}', 0, 'op-old-pending', NULL);
      UPDATE schedules SET current_run_id = 'run-open' WHERE id = 'sch-notify';
      INSERT INTO standing_permissions (id, version, session_id, project_id, machine_id, unit, action, policy_revision, unit_revision,
          channel, account, chat_id, actor, pinned_target, approval_id, created_by_event_id, created_at)
        VALUES ('sp-1', 1, '${mainSessionId}', (SELECT project_id FROM agent_roles WHERE id = 'main'), 'machine-a', 'demo.service', 'restart',
          'p1', 'u1', 'telegram', '777', '${OWNER_CHAT}', '${OWNER_USER}', '${notifyTarget.replaceAll("'", "''")}', 'appr-sp', 'evt-old-done', '${NOW}');
    `);
    db.close();
    // 平台凭据（必要凭据随导入复制）
    fs.writeFileSync(
      path.join(srcDirs.agentDir, "credentials.json"),
      JSON.stringify(
        {
          bindings: [
            { name: "tg-smoke", host: "127.0.0.1", header: "Authorization", purpose: "telegram_bot", secret: BOT_TOKEN },
            { name: "gh-hook", host: "github.com", header: "Authorization", purpose: "github_webhook", secret: "gh-secret" },
          ],
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    sourceHashAfterStop = hashTree(srcDirs.root);
  });

  // ---------- 场景 2/3：CLI preview / apply ----------
  const planFile = path.join(dst2Dirs.root, "plan.json");
  await check("2 preview：目标零写入，计划写回绑定字段，方向 personal", () => {
    const preview = cliJson(["legacy-import", "preview", "--from", srcDirs.dataDir, "--plan", planFile]);
    assert.equal(preview.direction, "personal-into-ruukoto");
    assert.equal(preview.handover.platforms.length, 2);
    assert.equal(preview.handover.platforms.find((p: any) => p.kind === "telegram").last_update_id, 100);
    assert.equal(preview.handover.platforms.find((p: any) => p.kind === "telegram").credential, "copy");
    assert.equal(fs.existsSync(path.join(dstDirs.dataDir, "ruukoto.db")), false, "预览对目标零写入");
    assert.equal(hashTree(srcDirs.root), sourceHashAfterStop, "预览后源目录不变");
  });

  let importId = "";
  await check("3 apply：回执/备份/凭据合并；再 apply 幂等；源不变", () => {
    if (fs.existsSync(planFile)) fs.rmSync(planFile);
    const applied = cliJson(["legacy-import", "apply", "--plan", cliJson(["legacy-import", "preview", "--from", srcDirs.dataDir, "--plan", planFile]) && planFile]);
    assert.equal(applied.replayed, false);
    importId = String(applied.import_id);
    assert.ok(fs.existsSync(String(applied.target_backup_path)), "目标备份存在");
    const replay = cliJson(["legacy-import", "apply", "--plan", planFile]);
    assert.equal(replay.replayed, true);
    const creds = JSON.parse(fs.readFileSync(path.join(dstDirs.agentDir, "credentials.json"), "utf8")) as { bindings: Array<{ name: string; secret: string }> };
    assert.equal(creds.bindings.find((b) => b.name === "tg-smoke")?.secret, BOT_TOKEN, "平台凭据已合并进目标");
    assert.equal(hashTree(srcDirs.root), sourceHashAfterStop, "导入后源目录仍不变");
  });

  // ---------- 场景 4：目标启动，交接连续性 ----------
  await check("4 目标启动：偏移续消费、调度恰一次、不重放旧发送、历史与授权保留", async () => {
    const backend = spawnBackend("ruukoto.mjs", dstDirs.dataDir, dstDirs.agentDir, dstControl, "RUUKOTO_CONTROL_DIR");
    const client = await connect(backend.child, dstControl, backend.stderr);
    const dbFile = path.join(dstDirs.dataDir, "ruukoto.db");
    try {
      // 首次轮询以导入偏移 +1 继续
      await waitFor("首次 getUpdates 以 offset=101 继续", () => stubCalls.some((c) => c.method === "getUpdates" && Number(c.body.offset) === 101));
      assert.equal(stubCalls.filter((c) => c.method === "getUpdates" && Number(c.body.offset) === 100).length, 0, "不回看旧偏移");
      // canned 更新恰处理一次：一条新入站、一条完成任务、恰一条 owner 回复外发
      await waitFor("canned 更新处理完成", () => {
        const ev = dbRows(dbFile, "SELECT status FROM inbound_events WHERE source = 'telegram' AND external_id = '777:4242:201'")[0];
        return ev !== undefined && ev.status === "done";
      });
      const sends = () => stubCalls.filter((c) => c.method === "sendMessage");
      await waitFor("owner 回复外发恰一条", () => sends().filter((c) => String(c.body.text ?? "").includes(MAIN_ANSWER)).length === 1);
      // 逾期调度恰一次：wake 一个新运行 + notify 一个新发送操作外发一次
      await waitFor("notify 计划外发恰一次", () => sends().filter((c) => String(c.body.text ?? "").includes("早安-smoke22")).length === 1);
      assert.equal(
        dbRows(dbFile, "SELECT count(*) c FROM inbound_events WHERE source = 'scheduler'")[0]!.c,
        1,
        "wake_main 恰触发一次",
      );
      // 旧 pending / 发送中不重放
      const oldPending = dbRows(dbFile, "SELECT status, error_kind FROM notification_ops WHERE id = 'op-old-pending'")[0]!;
      assert.equal(oldPending.status, "canceled");
      assert.equal(oldPending.error_kind, "migration");
      assert.equal(sends().some((c) => String(c.body.text ?? "").includes("旧待发不重复外发")), false, "旧 pending 发送不再外发");
      assert.equal(dbRows(dbFile, "SELECT status FROM notification_ops WHERE id = 'op-old-sending'")[0]!.status, "effect_unknown");
      assert.equal(dbRows(dbFile, "SELECT status FROM inbound_events WHERE id = 'evt-old-registered'")[0]!.status, "failed", "旧入站落定不重派");
      // 历史与长期授权保留
      const hist = await client.request("read_history", { session_id: mainSessionId, limit: 20 });
      assert.ok(JSON.stringify(hist).includes("smoke22 主会话种子"), "main 历史可读");
      const sp = dbRows(dbFile, "SELECT revoked_at, pinned_target FROM standing_permissions WHERE id = 'sp-1'")[0]!;
      assert.equal(sp.revoked_at, null, "长期授权保留");
      assert.equal(JSON.parse(String(sp.pinned_target)).configVersion, 7, "授权钉版与导入配置同代");
      assert.equal(Number(dbRows(dbFile, "SELECT last_update_id FROM telegram_config WHERE id = 1")[0]!.last_update_id) >= 101, true, "偏移前进到已消费之后");
    } finally {
      await stopBackend(client, backend);
    }
  });

  // ---------- 场景 5：切换后事实是回退阻挡项 ----------
  await check("5 目标有切换期间事实（新入站/新发送/新运行），回退被拒绝并逐项列出", () => {
    const proc = childProcess.spawnSync(process.execPath, [repoRoot + "/bin/ruukoto.mjs", "legacy-import", "revert", importId], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, RUUKOTO_DATA_DIR: dstDirs.dataDir, RUUKOTO_AGENT_DIR: dstDirs.agentDir },
      encoding: "utf8",
      timeout: 120_000,
    });
    const out = JSON.parse(proc.stdout);
    assert.equal(out.ok, false, "回退被拒绝");
    const text = (out.blockers as string[]).join("\n");
    assert.ok(text.includes("新入站事件"), "列出新入站");
    assert.ok(text.includes("新发送操作") || text.includes("发送事实"), "列出发送事实");
    assert.equal(hashTree(srcDirs.root), sourceHashAfterStop, "回退演练后源目录仍不变");
  });

  // ---------- 场景 6：第二目标干净回退 ----------
  await check("6 第二目标干净 apply + revert：行/文件/凭据移除、回执 reverted、源不变", () => {
    const plan2 = path.join(dst2Dirs.root, "plan2.json");
    const overDir = { dataDir: dst2Dirs.dataDir, agentDir: dst2Dirs.agentDir };
    cliJson(["legacy-import", "preview", "--from", srcDirs.dataDir, "--plan", plan2], overDir);
    const applied = cliJson(["legacy-import", "apply", "--plan", plan2], overDir);
    const reverted = cliJson(["legacy-import", "revert", String(applied.import_id)], overDir);
    assert.equal(reverted.ok, true);
    assert.equal(Number(dbRows(path.join(dst2Dirs.dataDir, "ruukoto.db"), "SELECT count(*) c FROM sessions")[0]!.c), 0, "行移除");
    assert.equal(fs.readdirSync(path.join(dst2Dirs.dataDir, "sessions")).length, 0, "历史文件移除（目录本身保留）");
    const creds = JSON.parse(fs.readFileSync(path.join(dst2Dirs.agentDir, "credentials.json"), "utf8")) as { bindings: unknown[] };
    assert.equal(creds.bindings.length, 0, "凭据摘除");
    const list = cliJson(["legacy-import", "list"], overDir);
    assert.equal(list[0].status, "reverted");
    assert.equal(hashTree(srcDirs.root), sourceHashAfterStop, "全流程后源目录不变");
  });
}

function cliJson(args: string[], over?: { dataDir: string; agentDir: string }): any {
  const t = over ?? dstDirs;
  const proc = childProcess.spawnSync(process.execPath, [repoRoot + "/bin/ruukoto.mjs", ...args], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, RUUKOTO_DATA_DIR: t.dataDir, RUUKOTO_AGENT_DIR: t.agentDir },
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  assert.equal(proc.status, 0, `CLI ${args.join(" ")} 应成功（stderr: ${(proc.stderr ?? "").slice(0, 800)}）`);
  return JSON.parse(proc.stdout);
}

await main();

stub.close();
await model.close();
fs.rmSync(srcDirs.root, { recursive: true, force: true });
fs.rmSync(dstDirs.root, { recursive: true, force: true });
fs.rmSync(dst2Dirs.root, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) process.exit(1);
