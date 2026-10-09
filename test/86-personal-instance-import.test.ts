/**
 * 旧实例个人资料迁入全新 ruukoto 实例（agent-direction issue 22，ADR 0023）。
 *
 * 测试接缝：
 * 1. 预览齐全且两侧零写入：交接清单（平台/调度/长期授权）、应用数据绑定、
 *    收尾计数、记忆分类、凭据动作、修订；源/目标门禁（源存活、产品错配、
 *    自我迁入、目标已初始化、凭据冲突）与 v30 全表登记；
 * 2. 迁移可用与档案可核查：目标启动后 main 历史/产物/应用数据/记忆注入/
 *    调度一次触发/角色行沿用；群与 GitHub 归档、发送账本逐行可查；
 * 3. 不重放：任务收尾、审批 stale、pending 发送取消、sending 置效果未知、
 *    入站落定、无重派无外发；
 * 4. 交接归属：telegram offset 与 config_version 原样、去重表随行、活动调度
 *    只在目标触发一次（旧 pending 已取消不双发）、长期授权行保留且身份链一致；
 * 5. 来源与待处理：引用 dev 的记忆不导入并列待处理、跨实例授权只进回执、
 *    MCP/Jev 缺凭据停用、模型目录/API key 不复制、未登记表拒绝；
 * 6. 中断/续跑/回退：故障注入后同计划重跑无重复、事务内故障整体回滚、
 *    同键重放/异参冲突、修订冲突、干净回退移除行/文件/凭据且源不变、
 *    导入后活动与易变行改写拒绝回退并逐项列出、回执跨进程可核实；
 * 7. v20 旧库：快照迁移只在副本上执行，源 sha 不变；
 * 8. CLI：真实 bin 入口（ruukoto 产品）preview/apply/list/revert。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Db, SCHEMA_VERSION } from "../src/core/db.ts";
import { Store } from "../src/core/store.ts";
import { randomId, type ModelSelection } from "../src/core/types.ts";
import { ControlServer } from "../src/control/server.ts";
import { Runtime } from "../src/runtime/runtime.ts";
import { AppDataStore } from "../src/agent/app-data/store.ts";
import {
  LegacyImportError,
  listLegacyImports,
} from "../src/runtime/legacy-import.ts";
import {
  applyPersonalImport,
  previewPersonalImport,
  revertPersonalImport,
} from "../src/runtime/personal-import.ts";
import {
  connectAuthedClient,
  createProjectSession,
  makeTestDirs,
  startTestRuntime,
  waitFor,
  writeModelsJson,
  type TestRuntime,
} from "./helpers/testkit.ts";
import { MockModelServer } from "./helpers/mock-provider.ts";
import { legacyGroupArchive } from "./helpers/legacy-group-archive.ts";
import { seedCodingRole } from "./helpers/legacy-coding.ts";
import { createMockTools } from "../src/agent/mock-tools.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOCK_SEL: ModelSelection = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" };
const NOW = "2026-10-03T00:00:00.000Z"; // 播种行时间一律早于导入时刻（回退阻挡项按 created_at >= 回执时间判定）
const PAST = "2026-10-04T00:00:00.000Z";

function hashTree(root: string): string {
  const entries: string[] = [];
  const walk = (dir: string) => {
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

function sha256Text(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function sha256FileOf(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function submitAndWait(client: any, sessionId: string, requestId: string, input: string): Promise<any> {
  await client.request("submit", { model_selection: MOCK_SEL, session_id: sessionId, request_id: requestId, input });
  let detail: any = null;
  await waitFor("任务终态", async () => {
    const found = await client.request("find_task", { session_id: sessionId, request_id: requestId });
    detail = found.task ? await client.request("get_task", { task_id: found.task.id }) : null;
    return detail && ["completed", "failed", "canceled", "interrupted"].includes(detail.task.status);
  });
  return detail.task;
}

function errCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof LegacyImportError) return err.code;
    throw err;
  }
  throw new Error("预期抛错但未抛");
}

interface SourceFixture {
  srcDataDir: string;
  srcAgentDir: string;
  root: string;
  work: string[];
  ids: {
    mainProj: string;
    sessMain: string;
    codingProj: string;
    sessCoding: string;
    sessChat: string;
    devProj: string;
    devSess: string;
    devTask: string;
    groupProj: string;
    groupAccount: string;
    groupId: string;
    groupSess: string;
    groupTask: string;
    subAgent: string;
    subSession: string;
    workId: string;
    taskMainDone: string;
    taskQueued: string;
    taskRunning: string;
    taskAwaiting: string;
    opUnresolved: string;
    confPending: string;
    confApproved: string;
    artGood: string;
    artMissing: string;
    memMainOk: string;
    memPersonalOk: string;
    memPersonalDevRef: string;
    memDevScope: string;
    grantInner: string;
    grantCross: string;
    mcpId: string;
    schWake: string;
    schNotify: string;
    schCanceled: string;
    runOpen: string;
    opPending: string;
    opSending: string;
    opSent: string;
    evtTelegramDone: string;
    evtRegistered: string;
    evtQueued: string;
    evtApproval: string;
    standingActive: string;
    standingRevoked: string;
    qqOutboxPending: string;
  };
  cleanup(): void;
}

/** 构造代表性源实例（ruukoto 产品）：main/coding/chat 角色会话与 QQ 群归档、
 * main 的 SubAgent 与应用数据、偏好/经验记忆与授权、MCP/Jev、平台配置与凭据、
 * 调度三态与发送账本、入站与 IM 审批事件、长期授权、GitHub 归档三表；
 * 外加一个普通 dev 项目会话（排除单位）。停止后台后保目录返回。 */
async function buildSource(prefix: string): Promise<SourceFixture> {
  const t = await startTestRuntime(prefix, async () => ({ kind: "text", text: "源回答" }));
  try {
    return await buildSourceInner(t);
  } catch (err) {
    try {
      t.client.close();
      await t.runtime.stop("fixture_error");
      await t.server.close();
    } finally {
      fs.rmSync(t.dirs.root, { recursive: true, force: true });
    }
    throw err;
  }
}

async function buildSourceInner(t: TestRuntime): Promise<SourceFixture> {
  const store = t.runtime.store;
  const db = t.runtime.store.db;
  const dataDir = t.dirs.dataDir;
  const work0 = {
    cwd: t.work[0]!,
    cwdReal: fs.realpathSync(t.work[0]!),
    dev: fs.statSync(t.work[0]!).dev,
    ino: fs.statSync(t.work[0]!).ino,
  };

  // 角色会话与项目（启动登记 main）；chat/coding 按归档形态播种（issue 20/23）
  const main = store.getAgentRole("main")!;
  const mainProj = main.projectId;
  const sessMain = main.sessionId;
  const coding = seedCodingRole(store, t.dirs.root);
  const codingProj = coding.projectId;
  const sessCoding = coding.sessionId;
  const archive = legacyGroupArchive({ store, qq: t.runtime.qqStore, workRoot: t.dirs.root });
  const sessChat = archive.seedChatRole().sessionId;

  // main 会话：完成任务 + 产物 + 检查点 + SubAgent
  const tDone = await submitAndWait(t.client, sessMain, "req-main", "主会话的一个任务");
  db.prepare(
    `INSERT INTO context_checkpoints (id, session_id, status, summarized_count, cleared_count, fingerprint, summary, summary_until,
      cleared_refs, cleared_results, summary_model, summary_status, summary_error, prompt_version, usage, estimate_before, estimate_after,
      task_id, call_index, created_at)
     VALUES (?, ?, 'superseded', 3, 1, 'fp', '摘要', NULL, '{}', 0, 'mock-model', 'ok', NULL, 'p1', NULL, 10, 5, ?, 0, ?)`,
  ).run(randomId("ckpt"), sessMain, tDone.id, NOW);
  fs.mkdirSync(path.join(dataDir, "artifacts"), { recursive: true });
  const artGood = store.withTx(() => store.createArtifact({ id: randomId("art"), taskId: tDone.id, sessionId: sessMain, name: "prompt-snapshot:main" }));
  const artBody = Buffer.from("main 提示词正文 0123456789", "utf8");
  fs.writeFileSync(path.join(dataDir, "artifacts", `${artGood.id}.bin`), artBody);
  store.withTx(() => {
    store.addArtifactBytes(artGood.id, artBody.length);
    store.setArtifactStatus(artGood.id, "complete");
  });
  const artMissing = store.withTx(() => store.createArtifact({ id: randomId("art"), taskId: tDone.id, sessionId: sessMain, name: "missing-body" }));

  const subSession = store.withTx(() =>
    store.createSession({ projectId: mainProj, cwd: work0.cwd, cwdReal: work0.cwdReal, cwdDev: work0.dev, cwdIno: work0.ino, piSessionId: randomId("pi"), confirmTools: [] }),
  );
  const sub = { id: randomId("sub"), parentSessionId: sessMain, sessionId: subSession.id, workDir: work0.cwdReal, activeWorkId: null, currentTaskId: null, state: "idle" as const, closedAt: null, closedBy: null, createdAt: NOW };
  const wk = { id: randomId("work"), parentSessionId: sessMain, originTaskId: tDone.id, subAgentId: sub.id, requestKey: "k-sub", paramsDigest: "d-sub", canceledAt: null, canceledBy: null, cancelReason: null, writeTarget: null, createdAt: NOW };
  store.withTx(() => {
    store.insertSubAgent(sub);
    store.insertWorkDelegation(wk as never);
  });
  const subTask = store.withTx(() =>
    store.insertQueuedTask({ sessionId: subSession.id, requestId: "sub-r1", input: "分析", resumesTaskId: null, modelSelection: MOCK_SEL, submissionDigest: randomId("d") }).task,
  );
  db.prepare("UPDATE tasks SET status = 'completed', work_id = ?, sub_agent_id = ?, started_at = ?, ended_at = ? WHERE id = ?").run(wk.id, sub.id, NOW, NOW, subTask.id);

  // 应用数据：main.db 与绑定 meta（runtime 启动已建库并写绑定），造一张业务表
  const appDbFile = path.join(dataDir, "agent-data", "main.db");
  const appStore = new AppDataStore(appDbFile);
  appStore.defineTable({
    table: "todos",
    fields: [{ name: "title", type: "text" }],
    expected_schema_version: 0,
    opId: "appop-1",
    reason: "演练表",
    ctx: { taskId: tDone.id, sessionId: sessMain, agentId: "main" },
  });
  appStore.close();

  // 普通 dev 项目与会话（排除单位，经 issue 21 迁移）
  const dev = await createProjectSession(t.client, t.work[0]!, { projectName: "dev-a" });
  const devTask = await submitAndWait(t.client, dev.sessionId, "req-dev", "dev 任务");

  // QQ 群归档：一个群 + 完成任务 + 遗留 pending 回复（升级收尾形态）
  const group = archive.seedGroup({ groupId: "200" });
  const gTask = group.seedTask({ messageId: "m-1", text: "旧群消息", state: "completed", summary: "群任务完成" });
  const pendingReply = group.seedPendingReply({ taskId: gTask.task!.id, messageId: "m-1" });
  await t.client.request<any>("save_memory", { project_id: group.projectId, category: "convention", content: "群项目约定", source_refs: [{ kind: "owner_note", note: "群" }] });

  // 记忆：main 项目（可导入）/ personal（可导入，同产品延续）/ personal 引用 dev（待处理）/ dev 项目（待处理）
  const m1 = await t.client.request<any>("save_memory", { project_id: mainProj, category: "preference", content: "main 项目偏好", source_refs: [{ kind: "owner_note", note: "录入" }] });
  const m2 = await t.client.request<any>("save_memory", { project_id: null, category: "preference", content: "个人偏好甲", source_refs: [{ kind: "owner_note", note: "个人" }] });
  const m3 = await t.client.request<any>("save_memory", { project_id: null, category: "experience", content: "引用 dev 历史的经验", source_refs: [{ kind: "history_entry", sessionId: dev.sessionId, entryId: "e-1" }] });
  const m4 = await t.client.request<any>("save_memory", { project_id: dev.projectId, category: "convention", content: "dev 项目约定", source_refs: [{ kind: "owner_note", note: "dev" }] });

  // 资料授权：两端都导入（main→群项目）/ 跨到 dev（只进回执）
  const g1 = await t.client.request<any>("create_data_grant", { from_project_id: group.projectId, to_project_id: mainProj, category: "history", purpose: "群内" });
  const g2 = await t.client.request<any>("create_data_grant", { from_project_id: mainProj, to_project_id: dev.projectId, category: "memory", purpose: "跨到 dev" });

  // MCP（带凭据）与 Jev（meta）挂 main 项目；目标缺凭据 → 停用导入
  await t.client.request<any>("add_credential", { name: "cred-mcp-g", host: "g.example", header: "Authorization", purpose: "mcp", secret: "mcp-secret" });
  const mcp = await t.client.request<any>("mcp_configure", { project_id: mainProj, name: "svc-g", endpoint: "https://g.example/mcp", credential: "cred-mcp-g", tool_allowlist: ["read"], enabled: true });
  store.setMetaValue(`jev.project.${mainProj}`, JSON.stringify({ enabled: true, credential: "jev-cred", configVersion: 1 }));

  // 平台凭据（必要凭据，随导入复制）+ webhook 凭据
  await t.client.request<any>("add_credential", { name: "tg-cred", host: "api.telegram.org", header: "Authorization", purpose: "telegram_bot", secret: "tg-secret" });
  await t.client.request<any>("add_credential", { name: "qq-cred", host: "qq.local", header: "Authorization", purpose: "qq_onebot", secret: "qq-secret" });
  await t.client.request<any>("add_credential", { name: "gh-hook", host: "github.com", header: "Authorization", purpose: "github_webhook", secret: "gh-secret" });

  // 平台配置（指尖端点：目标启动连接失败即重试，不阻塞测试）与去重/偏移状态
  db.prepare(
    "INSERT INTO qq_config (id, endpoint, credential_name, self_id, owner_user_id, enabled, config_version, created_at, updated_at) VALUES (1, 'ws://127.0.0.1:9', 'qq-cred', '100', '900', 1, 3, ?, ?)",
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO telegram_config (id, api_base, credential_name, owner_user_id, owner_chat_id, enabled, config_version, last_update_id, created_at, updated_at) VALUES (1, 'https://127.0.0.1:9', 'tg-cred', 'u1', 'c1', 1, 5, 41, ?, ?)",
  ).run(NOW, NOW);

  // 入站事件：telegram 完成（去重连续性）、registered（落定）、queued（落定）、IM 审批命令
  const evtTelegramDone = randomId("evt");
  db.prepare("INSERT INTO inbound_events (id, source, external_id, actor, target_role, body, reply_target, received_at, event_kind, status, task_id) VALUES (?, 'telegram', '777:c1:100', 'u1', 'main', '{\"text\":\"旧消息\"}', ?, ?, 'task', 'done', ?)")
    .run(evtTelegramDone, JSON.stringify({ channel: "telegram", account: "u1", chatId: "c1", configVersion: 5 }), PAST, tDone.id);
  const evtRegistered = randomId("evt");
  db.prepare("INSERT INTO inbound_events (id, source, external_id, actor, target_role, body, received_at, event_kind, status) VALUES (?, 'telegram', '777:c1:101', 'u1', 'main', '{\"text\":\"未派发\"}', ?, 'task', 'registered')").run(evtRegistered, PAST);
  const evtQueued = randomId("evt");
  db.prepare("INSERT INTO inbound_events (id, source, external_id, actor, target_role, body, received_at, event_kind, status) VALUES (?, 'qq_private', '100:900:201', '900', 'main', '{\"text\":\"排队\"}', ?, 'task', 'queued')").run(evtQueued, PAST);
  const evtApproval = randomId("evt");
  db.prepare("INSERT INTO inbound_events (id, source, external_id, actor, target_role, body, received_at, event_kind, status) VALUES (?, 'telegram', '777:c1:99', 'u1', 'main', '{\"cmd\":\"/approve-standing x 1\"}', ?, 'im_approval', 'done')").run(evtApproval, PAST);

  // 调度三态 + 发送账本：逾期 wake_main；daily notify（打开运行 + pending 发送）；
  // 已取消计划（关闭运行）；sending / sent / effect_unknown 各一
  const notifyTarget = JSON.stringify({ channel: "telegram", account: "u1", chatId: "c1", configVersion: 5 });
  const schWake = randomId("sch");
  db.prepare(
    `INSERT INTO schedules (id, create_key, params_digest, action, rule, payload, status, next_due_at, version, tz_data, reason, created_at, updated_at)
     VALUES (?, 'k-wake', 'd-wake', 'wake_main', ?, ?, 'active', ?, 1, 'Asia/Shanghai', '每日站会', ?, ?)`,
  ).run(schWake, JSON.stringify({ kind: "once", at: PAST, timeZone: "UTC", disambiguation: "compatible" }), JSON.stringify({ text: "演练唤醒", sourceRefs: [] }), PAST, NOW, NOW);
  const schNotify = randomId("sch");
  db.prepare(
    `INSERT INTO schedules (id, create_key, params_digest, action, rule, payload, target, approval_id, status, next_due_at, version, tz_data, reason, created_at, updated_at)
     VALUES (?, 'k-notify', 'd-notify', 'notify', ?, ?, ?, 'appr-notify', 'active', ?, 1, 'Asia/Shanghai', '每日一句', ?, ?)`,
  ).run(schNotify, JSON.stringify({ kind: "daily", time: "08:00", timeZone: "UTC", disambiguation: "compatible" }), JSON.stringify({ text: "早安", sourceRefs: [] }), notifyTarget, PAST, NOW, NOW);
  const schCanceled = randomId("sch");
  db.prepare(
    `INSERT INTO schedules (id, create_key, params_digest, action, rule, payload, status, next_due_at, version, tz_data, reason, cancel_reason, created_at, updated_at)
     VALUES (?, 'k-canceled', 'd-canceled', 'notify', ?, '{}', 'canceled', NULL, 2, 'Asia/Shanghai', '旧计划', '拥有者取消', ?, ?)`,
  ).run(schCanceled, JSON.stringify({ kind: "daily", time: "09:00", timeZone: "UTC", disambiguation: "compatible" }), NOW, NOW);
  const opPending = randomId("nop");
  const runOpen = randomId("srun");
  const opSending = randomId("nop");
  const opSent = randomId("nop");
  const opUnknown = randomId("nop");
  for (const [id, key, status, extra] of [
    [opPending, `schedule_run:${runOpen}`, "pending", ""],
    [opSending, `confirmation:task:running-stub`, "sending", "sending_at"],
    [opSent, `inbound_event:${evtTelegramDone}`, "sent", "sent"],
    [opUnknown, `confirmation:task:old-stub`, "effect_unknown", "unknown"],
  ] as Array<[string, string, string, string]>) {
    db.prepare(
      `INSERT INTO notification_ops (id, source_kind, source_key, target, text, text_sha256, status, platform_message_id, created_at, sending_at, settled_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      key.split(":")[0] === "confirmation" ? "confirmation" : key.split(":")[0] === "schedule_run" ? "schedule_run" : "inbound_event",
      key.slice(key.indexOf(":") + 1),
      notifyTarget,
      "通知正文",
      sha256Text("通知正文"),
      status,
      status === "sent" ? "pm-1" : null,
      NOW,
      status === "sending" || status === "sent" ? NOW : null,
      status === "sent" || status === "effect_unknown" ? NOW : null,
      NOW,
    );
  }
  db.prepare(
    `INSERT INTO schedule_runs (id, schedule_id, schedule_version, scheduled_for, local_time, registered_at, delay_ms, notification_op_id, closed_at)
     VALUES (?, ?, 1, ?, ?, ?, 0, ?, NULL)`,
  ).run(runOpen, schNotify, PAST, PAST, NOW, opPending);
  db.prepare(
    `INSERT INTO schedule_runs (id, schedule_id, schedule_version, scheduled_for, local_time, registered_at, delay_ms, closed_at)
     VALUES (?, ?, 2, ?, ?, ?, 0, ?)`,
  ).run(randomId("srun"), schCanceled, PAST, PAST, NOW, NOW);
  db.prepare("UPDATE schedules SET current_run_id = ? WHERE id = ?").run(runOpen, schNotify);

  // 长期授权：生效与已撤销各一（钉版目标匹配 telegram config_version=5）
  const standingActive = randomId("sp");
  const standingRevoked = randomId("sp");
  for (const [id, revoked, reason] of [
    [standingActive, null, null],
    [standingRevoked, NOW, "owner_revoked"],
  ] as Array<[string, string | null, string | null]>) {
    db.prepare(
      `INSERT INTO standing_permissions (id, version, session_id, project_id, machine_id, unit, action, policy_revision, unit_revision,
         channel, account, chat_id, actor, pinned_target, approval_id, created_by_event_id, created_at, revoked_at, revoked_reason)
       VALUES (?, 1, ?, ?, 'machine-a', 'demo.service', 'restart', 'p1', 'u1', 'telegram', 'u1', 'c1', 'u1', ?, ?, ?, ?, ?, ?)`,
    ).run(id, sessMain, mainProj, notifyTarget, `appr-${id}`, evtApproval, NOW, revoked, reason);
  }

  // GitHub 归档三表（v4 遗留形态）与 manifest；退役 meta
  store.setMetaValue("github_retirement_done", "1");

  t.client.close();
  await t.runtime.stop("test_end");
  await t.server.close();

  const post = new Db(dataDir);
  post.exec(`
    CREATE TABLE github_repo_bindings (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, api_host TEXT NOT NULL, owner TEXT NOT NULL, repo TEXT NOT NULL,
      repo_id INTEGER NOT NULL, read_credential TEXT, publish_credential TEXT, config_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE github_drafts (
      id TEXT PRIMARY KEY, version INTEGER NOT NULL, pr_number INTEGER NOT NULL, pr_url TEXT NOT NULL, pr_title TEXT NOT NULL,
      head_sha TEXT NOT NULL, body TEXT NOT NULL, body_sha256 TEXT NOT NULL, evidence_artifact_ids TEXT NOT NULL DEFAULT '[]',
      revisions TEXT NOT NULL DEFAULT '[]', kind TEXT NOT NULL, status TEXT NOT NULL, stale_reason TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE github_publish_ops (
      id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, draft_version INTEGER NOT NULL, target TEXT NOT NULL, status TEXT NOT NULL,
      remote_id TEXT, remote_url TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO github_repo_bindings (id, project_id, api_host, owner, repo, repo_id, created_at, updated_at)
      VALUES ('ghb-1', '${mainProj}', 'api.github.com', 'me', 'repo', 42, '${NOW}', '${NOW}');
    INSERT INTO github_drafts (id, version, pr_number, pr_url, pr_title, head_sha, body, body_sha256, kind, status, created_at, updated_at)
      VALUES ('ghd-1', 2, 7, 'https://github.com/me/repo/pull/7', '旧 PR', 'abc123', '评审正文', 'sha', 'review', 'stale', '${NOW}', '${NOW}');
    INSERT INTO github_publish_ops (id, draft_id, draft_version, target, status, created_at, updated_at)
      VALUES ('ghp-1', 'ghd-1', 1, '{}', 'effect_unknown', '${NOW}', '${NOW}');
  `);
  fs.writeFileSync(path.join(dataDir, "github-archive-manifest.json"), JSON.stringify({ drafts: [{ id: "ghd-1", versions: 2 }] }, null, 2));

  // 未终态任务态（后台停止后写入）：main 会话的 queued / running / awaiting_confirmation
  const pstore = new Store(post);
  const tq = pstore.withTx(() =>
    pstore.insertQueuedTask({ sessionId: sessMain, requestId: "q1", input: "排队任务", resumesTaskId: null, modelSelection: MOCK_SEL, submissionDigest: randomId("d") }).task,
  );
  const tr = pstore.withTx(() =>
    pstore.insertQueuedTask({ sessionId: sessMain, requestId: "r2", input: "运行中任务", resumesTaskId: null, modelSelection: MOCK_SEL, submissionDigest: randomId("d") }).task,
  );
  post.prepare("UPDATE tasks SET status = 'running', started_at = ? WHERE id = ?").run(NOW, tr.id);
  const opUnresolved = randomId("op");
  const ta = pstore.withTx(() =>
    pstore.insertQueuedTask({ sessionId: sessMain, requestId: "a1", input: "审批中任务", resumesTaskId: null, modelSelection: MOCK_SEL, submissionDigest: randomId("d") }).task,
  );
  post.prepare("UPDATE tasks SET status = 'awaiting_confirmation', started_at = ? WHERE id = ?").run(NOW, ta.id);
  pstore.withTx(() => {
    pstore.recordToolIntent({ id: opUnresolved, taskId: tr.id, sessionId: sessMain, toolName: "bash", params: { command: "ls" } });
  });
  const confPending = pstore.withTx(() =>
    pstore.createConfirmation({ taskId: ta.id, sessionId: sessMain, toolOpId: randomId("op"), toolName: "bash", params: { command: "ls" }, scope: { kind: "tool", workspaceOnly: true }, permissionVersion: 1 }),
  );
  const confApproved = pstore.withTx(() =>
    pstore.createConfirmation({ taskId: ta.id, sessionId: sessMain, toolOpId: randomId("op"), toolName: "bash", params: { command: "pwd" }, scope: { kind: "tool", workspaceOnly: true }, permissionVersion: 1 }),
  );
  post.prepare("UPDATE confirmations SET status = 'approved', responded_at = ? WHERE id = ?").run(NOW, confApproved.id);
  // main 会话访问模式原样保留（同产品延续，不做 21 的降级）
  post.prepare("UPDATE sessions SET default_access_mode = 'full_access' WHERE id = ?").run(sessMain);
  post.close();

  return {
    srcDataDir: dataDir,
    srcAgentDir: t.dirs.agentDir,
    root: t.dirs.root,
    work: t.work,
    ids: {
      mainProj,
      sessMain,
      codingProj,
      sessCoding,
      sessChat,
      devProj: dev.projectId,
      devSess: dev.sessionId,
      devTask: devTask.id,
      groupProj: group.projectId,
      groupAccount: group.account,
      groupId: group.groupId,
      groupSess: group.session.id,
      groupTask: gTask.task!.id,
      subAgent: sub.id,
      subSession: subSession.id,
      workId: wk.id,
      taskMainDone: tDone.id,
      taskQueued: tq.id,
      taskRunning: tr.id,
      taskAwaiting: ta.id,
      opUnresolved,
      confPending: confPending.id,
      confApproved: confApproved.id,
      artGood: artGood.id,
      artMissing: artMissing.id,
      memMainOk: m1.id ?? m1.memoryId,
      memPersonalOk: m2.id ?? m2.memoryId,
      memPersonalDevRef: m3.id ?? m3.memoryId,
      memDevScope: m4.id ?? m4.memoryId,
      grantInner: g1.id ?? g1.grantId,
      grantCross: g2.id ?? g2.grantId,
      mcpId: mcp.id ?? mcp.serviceId,
      schWake,
      schNotify,
      schCanceled,
      runOpen,
      opPending,
      opSending,
      opSent,
      evtTelegramDone,
      evtRegistered,
      evtQueued,
      evtApproval,
      standingActive,
      standingRevoked,
      qqOutboxPending: String(pendingReply.opId),
    },
    cleanup() {
      fs.rmSync(t.dirs.root, { recursive: true, force: true });
    },
  };
}

/** 目标侧启动（ruukoto 产品，mock 模型与工具）。 */
async function bootTarget(root: string, dataDir: string, agentDir: string) {
  const server = new MockModelServer(async () => ({ kind: "text", text: "目标回答" }));
  const baseUrl = await server.start();
  await writeModelsJson({ root, dataDir, agentDir } as never, baseUrl);
  const runtime = await Runtime.start({
    dataDir,
    agentDir,
    socketPath: path.join(root, "c.sock"),
    thinkingLevel: "off",
    modelProvider: "mock",
    modelId: "mock-model",
    toolFactory: (ctx) => createMockTools(ctx),
    productType: "ruukoto",
  });
  await ControlServer.start(runtime);
  const client = await connectAuthedClient(runtime);
  await client.handshake();
  return { runtime, client, server };
}

function targetDirs(prefix: string): { root: string; dataDir: string; agentDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ruukoto-pi-${prefix}-`));
  return { root, dataDir: path.join(root, "data"), agentDir: path.join(root, "agent") };
}

function depsOf(dirs: { dataDir: string; agentDir: string }) {
  return { targetDataDir: dirs.dataDir, targetAgentDir: dirs.agentDir };
}

// ---------- 1. 预览齐全且零写入；门禁与全表登记 ----------

test("预览覆盖交接清单与各项收尾，两侧零写入；门禁逐项拒绝", async () => {
  const src = await buildSource("pi1");
  const dirs = targetDirs("p1");
  try {
    const before = hashTree(src.root);
    const p = previewPersonalImport(depsOf(dirs), { from: src.srcDataDir });
    assert.equal(p.direction, "personal-into-ruukoto");
    assert.equal(p.source.product, "ruukoto");
    assert.equal(p.target.exists, false);
    assert.deepEqual(p.plan_errors, []);
    assert.ok(p.revision !== null && p.revision.startsWith("r1."));

    // 交接清单：平台、调度、长期授权
    const tg = p.handover.platforms.find((x) => x.kind === "telegram")!;
    assert.equal(tg.enabled, true);
    assert.equal(tg.credential_name, "tg-cred");
    assert.equal(tg.credential, "copy");
    assert.equal(tg.config_version, 5);
    assert.equal(tg.last_update_id, 41);
    const qq = p.handover.platforms.find((x) => x.kind === "qq")!;
    assert.equal(qq.credential_name, "qq-cred");
    assert.equal(qq.credential, "copy");
    assert.deepEqual(p.handover.webhook_credentials, [{ name: "gh-hook", action: "copy" }]);
    assert.equal(p.handover.schedules.active, 2);
    assert.equal(p.handover.schedules.canceled, 1);
    assert.equal(p.handover.schedules.open_runs, 1);
    assert.equal(p.handover.standing_permissions.active, 1);
    assert.equal(p.handover.standing_permissions.revoked, 1);

    // 应用数据与绑定
    assert.equal(p.app_data.present, true);
    assert.equal(p.app_data.tables, 1);
    assert.equal(p.app_data.audit_rows, 1);
    assert.equal(p.app_data.corrupt, false);
    assert.equal(p.app_data.binding.matches, true);

    // 收尾计数（不重放）
    assert.equal(p.closings.canceled, 1);
    assert.equal(p.closings.interrupted, 2);
    assert.equal(p.closings.stale_confirmations, 2);
    assert.equal(p.closings.full_access_kept, 1);
    assert.equal(p.outbox.canceled_pending, 1);
    assert.equal(p.outbox.effect_unknown_sending, 1);
    assert.equal(p.outbox.terminal_kept, 2);
    assert.equal(p.inbound.settled_failed, 2);
    assert.equal(p.inbound.terminal_kept, 3); // telegram done + IM 审批 done + 群归档 done
    assert.equal(p.schedule_settles.open_runs_closed, 1);

    // 会话归属与排除
    const main = p.sessions.find((s) => s.id === src.ids.sessMain)!;
    assert.equal(main.role, "main");
    assert.equal(main.full_access_kept, true);
    assert.equal(main.unfinished.length, 3);
    assert.equal(main.pending_approvals, 2);
    const sub = p.sessions.find((s) => s.id === src.ids.subSession)!;
    assert.equal(sub.sub_agent, true);
    const grp = p.sessions.find((s) => s.id === src.ids.groupSess)!;
    assert.equal(grp.group, true);
    assert.ok(p.excluded_sessions.some((s) => s.id === src.ids.devSess && s.reason.includes("issue 21")));
    assert.ok(p.excluded_projects.some((x) => x.id === src.ids.devProj));

    // 记忆、授权、MCP/Jev、凭据
    assert.ok(p.memories.import.includes(src.ids.memMainOk));
    assert.ok(p.memories.import.includes(src.ids.memPersonalOk));
    assert.ok(p.memories.pending.some((m) => m.id === src.ids.memPersonalDevRef && (m.reason ?? "").includes("未导入")));
    assert.ok(p.memories.pending.some((m) => m.id === src.ids.memDevScope));
    assert.ok(p.grants.import.includes(src.ids.grantInner));
    assert.deepEqual(p.grants.cross_instance.map((g) => g.id), [src.ids.grantCross]);
    assert.equal(p.mcp.length, 1);
    assert.equal(p.mcp[0]!.disabled, true);
    assert.equal(p.jev[0]!.disabled, true);
    assert.deepEqual(
      p.credentials.map((c) => [c.name, c.action]).sort(),
      [
        ["gh-hook", "copy"],
        ["qq-cred", "copy"],
        ["tg-cred", "copy"],
      ].sort(),
    ); // MCP 凭据不进入必要凭据（走 mcp.disabled 停用导入路径）

    // 归档与文件
    assert.equal(p.archives.qq_inbox, 1);
    assert.equal(p.archives.qq_outbox, 1);
    assert.equal(p.archives.github_repo_bindings, 1);
    assert.equal(p.archives.github_drafts, 1);
    assert.equal(p.archives.github_publish_ops, 1);
    assert.equal(p.archives.github_manifest_file, true);
    assert.ok(p.files.missing.some((f) => f.item.includes(src.ids.artMissing)));

    // 两侧零写入
    assert.equal(fs.existsSync(path.join(dirs.dataDir, "ruukoto.db")), false, "预览对目标零写入");
    assert.equal(hashTree(src.root), before, "源目录逐文件不变");

    // 未登记新表即拒绝（v30 全表登记由上方成功预览反向覆盖）
    {
      const post = new Db(src.srcDataDir);
      post.exec("CREATE TABLE z_unregistered (id TEXT)");
      post.close();
      assert.equal(errCode(() => previewPersonalImport(depsOf(dirs), { from: src.srcDataDir })), "table_policy");
      const again = new Db(src.srcDataDir);
      again.exec("DROP TABLE z_unregistered");
      again.close();
    }
    const afterRegisteredCheck = hashTree(src.root);

    // 自我迁入：同路径与目录副本（同实例 ID）都拒绝
    assert.equal(
      errCode(() => previewPersonalImport({ targetDataDir: src.srcDataDir, targetAgentDir: path.join(dirs.root, "no") }, { from: src.srcDataDir })),
      "invalid_params",
    );
    {
      const copyDirs = targetDirs("p1copy");
      fs.mkdirSync(copyDirs.dataDir, { recursive: true });
      fs.cpSync(src.srcDataDir, copyDirs.dataDir, { recursive: true });
      fs.rmSync(path.join(copyDirs.dataDir, "runtime.lock"), { recursive: true, force: true });
      assert.equal(
        errCode(() => previewPersonalImport({ targetDataDir: copyDirs.dataDir, targetAgentDir: copyDirs.agentDir }, { from: src.srcDataDir })),
        "invalid_params",
      );
      fs.rmSync(copyDirs.root, { recursive: true, force: true });
    }

    // 目标产品错配（ruukoto-code 登记目录）
    {
      const devDirs = targetDirs("p1dev");
      fs.mkdirSync(devDirs.dataDir, { recursive: true });
      const tdb = new Db(devDirs.dataDir);
      tdb.prepare("INSERT INTO meta (key, value) VALUES ('product.type', 'ruukoto-code')").run();
      tdb.close();
      assert.equal(errCode(() => previewPersonalImport(depsOf(devDirs), { from: src.srcDataDir })), "product_mismatch");
      fs.rmSync(devDirs.root, { recursive: true, force: true });
    }

    // 源后台存活拒绝（独立的存活后台；不重启夹具源——那会合法写入其目录）
    {
      const live = await startTestRuntime("pi-gate", async () => ({ kind: "text", text: "x" }));
      try {
        assert.equal(errCode(() => previewPersonalImport(depsOf(dirs), { from: live.dirs.dataDir })), "source_active");
      } finally {
        live.client.close();
        await live.runtime.stop("test_end");
        await live.server.close();
        fs.rmSync(live.dirs.root, { recursive: true, force: true });
      }
    }

    // 目标已初始化自有角色（后台启动过）→ 计划错误而非覆盖
    {
      const initDirs = targetDirs("p1init");
      fs.mkdirSync(initDirs.dataDir, { recursive: true });
      fs.mkdirSync(initDirs.agentDir, { recursive: true });
      const host = await bootTarget(initDirs.root, initDirs.dataDir, initDirs.agentDir);
      host.client.close();
      await host.runtime.stop("init");
      host.server.close();
      const bad = previewPersonalImport(depsOf(initDirs), { from: src.srcDataDir });
      assert.ok(bad.plan_errors.some((e) => e.includes("自有角色") || e.includes("已初始化")), "已初始化目标列出计划错误");
      fs.rmSync(initDirs.root, { recursive: true, force: true });
    }
    assert.equal(hashTree(src.root), afterRegisteredCheck, "门禁演练（只读路径）后源目录仍不变");
  } finally {
    src.cleanup();
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

// ---------- 2. 目标启动：可用、档案可查、交接一次、不重放 ----------

test("应用后目标启动：main 与应用数据可用，档案可查，交接恰一次且不重放", async () => {
  const src = await buildSource("pi2");
  const dirs = targetDirs("p2");
  try {
    const preview = previewPersonalImport(depsOf(dirs), { from: src.srcDataDir });
    const applied = applyPersonalImport(depsOf(dirs), {
      plan: { from: src.srcDataDir },
      source_instance_id: preview.source.instance_id,
      revision: preview.revision!,
      request_id: "imp-pi2",
    });
    assert.equal(applied.replayed, false);
    assert.ok(fs.existsSync(applied.target_backup_path), "目标备份存在");
    // 凭据已复制（含秘密值），停用项不复制
    const creds = JSON.parse(fs.readFileSync(path.join(dirs.agentDir, "credentials.json"), "utf8")) as { bindings: Array<{ name: string; secret?: string }> };
    assert.equal(creds.bindings.find((b) => b.name === "tg-cred")?.secret, "tg-secret");
    assert.equal(creds.bindings.find((b) => b.name === "gh-hook")?.secret, "gh-secret");
    assert.equal(creds.bindings.some((b) => b.name === "cred-mcp-g"), false, "MCP 凭据不复制");
    assert.equal(fs.existsSync(path.join(dirs.agentDir, "models.json")), false, "模型目录不复制");

    // 目标启动前停用平台（连接连续性由 smoke-22 的 telegram stub 证实；此处不断言外发）
    {
      const tdb = new Db(dirs.dataDir);
      tdb.exec("UPDATE qq_config SET enabled = 0; UPDATE telegram_config SET enabled = 0;");
      assert.equal((tdb.prepare("SELECT last_update_id FROM telegram_config WHERE id = 1").get() as { last_update_id: number }).last_update_id, 41, "导入保留 telegram 偏移");
      assert.equal((tdb.prepare("SELECT config_version FROM telegram_config WHERE id = 1").get() as { config_version: number }).config_version, 5, "导入保留 config_version");
      tdb.close();
    }

    const host = await bootTarget(dirs.root, dirs.dataDir, dirs.agentDir);
    try {
      const t = host.runtime;
      const store = t.store;
      // 角色行沿用（ensureRoles 幂等跳过导入行）
      assert.equal(store.getAgentRole("main")!.sessionId, src.ids.sessMain);
      assert.equal(store.getAgentRole("coding")!.sessionId, src.ids.sessCoding);
      assert.ok(store.getAgentRole("main")!.workDir.startsWith(path.dirname(path.resolve(dirs.dataDir))), "角色工作目录在目标档案内");
      const mainSession = store.getSession(src.ids.sessMain)!;
      assert.ok(mainSession.cwd.startsWith(path.join(path.dirname(path.resolve(dirs.dataDir)), "agent-work")), "main cwd 改写为目标 agent-work");
      assert.equal(mainSession.defaultAccessMode, "full_access", "访问模式原样保留（不降级）");

      // main 历史逐字节可读（目标接手后新任务继续追加同一文件，比较导入前缀）
      const srcJsonl = fs.readFileSync(path.join(src.srcDataDir, "sessions", path.basename(mainSession.sessionFile!)));
      const tgtJsonl = fs.readFileSync(mainSession.sessionFile!);
      assert.ok(tgtJsonl.length >= srcJsonl.length, "目标历史不少于源（接手后在原文件追加）");
      assert.deepEqual(tgtJsonl.subarray(0, srcJsonl.length), srcJsonl, "导入的 main 历史字节一致");
      const art = store.getArtifact(src.ids.artGood)!;
      assert.deepEqual(fs.readFileSync(path.join(dirs.dataDir, "artifacts", `${art.id}.bin`)), Buffer.from("main 提示词正文 0123456789", "utf8"));
      assert.equal(store.getArtifact(src.ids.artMissing)!.byteCount, 0, "缺失正文如实");

      // 应用数据：绑定经启动核查可用，业务表与审计回执在库
      {
        const raw = new DatabaseSync(path.join(dirs.dataDir, "agent-data", "main.db"), { readOnly: true });
        try {
          assert.equal((raw.prepare("SELECT count(*) c FROM app_tables").get() as { c: number }).c, 1, "业务表目录随迁");
          const audit = raw.prepare("SELECT task_id, session_id, op_id FROM app_audit WHERE op_id = 'appop-1'").get() as { task_id: string; session_id: string } | undefined;
          assert.ok(audit, "审计回执在库");
          assert.equal(audit!.task_id, src.ids.taskMainDone, "审计引用的任务 ID 原样（行 ID 保留不断链）");
        } finally {
          raw.close();
        }
      }
      assert.equal(
        store.db.prepare("SELECT value FROM meta WHERE key = 'app_data.main_instance_id'").get() !== undefined,
        true,
        "绑定 meta 随迁",
      );
      assert.equal(store.getMetaValue("github_retirement_done"), "1", "GitHub 退役 meta 随迁（不重复退役迁移）");

      // SubAgent 以关闭状态登记、工作委托保留
      const subRow = store.db.prepare("SELECT closed_at, closed_by, state FROM sub_agents WHERE id = ?").get(src.ids.subAgent) as { closed_at: string | null; state: string };
      assert.ok(subRow.closed_at !== null, "SubAgent 按关闭状态登记");
      assert.equal(subRow.state, "idle");
      assert.ok(store.db.prepare("SELECT 1 FROM work_delegations WHERE id = ?").get(src.ids.workId), "工作委托在库");

      // 调度一次交接：逾期 wake_main 恰派发一次（新事件 + main 新任务完成）
      await waitFor("逾期 wake_main 派发完成", () => {
        const ev = store.db
          .prepare("SELECT id, status FROM inbound_events WHERE source = 'scheduler' ORDER BY received_at DESC LIMIT 1")
          .get() as { status: string } | undefined;
        return ev !== undefined && ev.status === "done";
      });
      const schedulerEvents = store.db.prepare("SELECT count(*) c FROM inbound_events WHERE source = 'scheduler'").get() as { c: number };
      assert.equal(schedulerEvents.c, 1, "wake_main 在目标恰触发一次");
      const wakeRuns = store.db.prepare("SELECT count(*) c FROM schedule_runs WHERE schedule_id = ?").get(src.ids.schWake) as { c: number };
      assert.equal(wakeRuns.c, 1, "wake_main 的新运行恰一次");
      // 逾期 notify：新建一个运行与一个发送操作（平台停用 → 等待），旧 pending 保持 canceled 不重发
      const notifyOps = store.db.prepare("SELECT id, status, source_key FROM notification_ops WHERE source_kind = 'schedule_run'").all() as Array<{ id: string; status: string; source_key: string }>;
      const importedOp = notifyOps.find((o) => o.id === src.ids.opPending)!;
      assert.equal(importedOp.status, "canceled", "旧 pending 发送保持取消，不当作新请求重发");
      const newOps = notifyOps.filter((o) => o.id !== src.ids.opPending && o.source_key !== src.ids.runOpen);
      assert.equal(newOps.length, 1, "逾期 notify 在目标恰产生一个新发送操作");
      assert.equal(notifyOps.filter((o) => o.status === "sent").length, 0, "停用平台不外发");

      // 不重放：旧 queued/rm/awaiting 已收尾，模型只为新派发工作
      const taskOf = (id: string) => store.getTask(id)!;
      assert.equal(taskOf(src.ids.taskQueued).status, "canceled");
      assert.equal(taskOf(src.ids.taskRunning).status, "interrupted");
      assert.equal(taskOf(src.ids.taskRunning).effectUnknown, true);
      assert.equal(taskOf(src.ids.taskAwaiting).status, "interrupted");
      assert.equal(store.getConfirmation(src.ids.confPending)!.status, "stale");
      assert.equal(store.getConfirmation(src.ids.confApproved)!.status, "stale");
      const toolOp = store.db.prepare("SELECT effect_unknown FROM tool_ops WHERE id = ?").get(src.ids.opUnresolved) as { effect_unknown: number };
      assert.equal(toolOp.effect_unknown, 1);
      const importedEvent = (id: string) => (store.db.prepare("SELECT status FROM inbound_events WHERE id = ?").get(id) as { status: string }).status;
      assert.equal(importedEvent(src.ids.evtRegistered), "failed", "入站落定不重派");
      assert.equal(importedEvent(src.ids.evtQueued), "failed");
      assert.equal(importedEvent(src.ids.evtTelegramDone), "done", "终态原样");
      const runRow = store.db.prepare("SELECT closed_at FROM schedule_runs WHERE id = ?").get(src.ids.runOpen) as { closed_at: string | null };
      assert.ok(runRow.closed_at !== null, "打开运行已关闭");

      // 档案可查：群收件/待发、接收账本、GitHub 归档与 manifest
      assert.equal(store.db.prepare("SELECT count(*) c FROM qq_inbox WHERE group_id = ?").get(src.ids.groupId) !== undefined, true);
      const pendingOutbox = store.db.prepare("SELECT status FROM qq_outbox WHERE op_id = ?").get(src.ids.qqOutboxPending) as { status: string };
      assert.equal(pendingOutbox.status, "unknown", "遗留 pending 群回复按退役语义收尾（幂等，不重发）");
      assert.equal((store.db.prepare("SELECT count(*) c FROM github_drafts").get() as { c: number }).c, 1, "GitHub 草稿归档随迁");
      assert.equal((store.db.prepare("SELECT count(*) c FROM github_publish_ops").get() as { c: number }).c, 1);
      assert.ok(fs.existsSync(path.join(dirs.dataDir, "github-archive-manifest.json")), "归档 manifest 随迁");
      // 长期授权行保留且身份链一致（钉版 configVersion == 导入配置版本）
      const standing = store.db.prepare("SELECT pinned_target, revoked_at FROM standing_permissions WHERE id = ?").get(src.ids.standingActive) as { pinned_target: string; revoked_at: string | null };
      assert.equal(standing.revoked_at, null);
      assert.equal(JSON.parse(standing.pinned_target).configVersion, 5, "授权钉版与导入平台配置同代");

      // 记忆注入：main 与个人记忆注入，dev 来源的记忆不进目标
      const newTask = await submitAndWait(host.client, src.ids.sessMain, "req-target", "目标新任务");
      assert.equal(newTask.status, "completed");
      const records = store.listSelectionRecordsBySession(src.ids.sessMain, 1);
      assert.ok(records.length > 0);
      const last = records[records.length - 1]!;
      assert.ok(last.includedMemories.some((m) => m.memoryId === src.ids.memMainOk), "main 项目记忆注入");
      assert.ok(last.includedMemories.some((m) => m.memoryId === src.ids.memPersonalOk), "personal 记忆注入（同产品延续，不需选中）");
      assert.ok(
        last.includedMemories.every((m) => m.memoryId !== src.ids.memPersonalDevRef && m.memoryId !== src.ids.memDevScope),
        "无法核验来源的记忆不注入",
      );
      // dev 会话与资料未进目标
      assert.equal(store.getSession(src.ids.devSess), null, "dev 会话排除");
      assert.equal(store.getTask(src.ids.devTask), null, "dev 任务排除");
      assert.equal(store.db.prepare("SELECT 1 FROM data_grants WHERE id = ?").get(src.ids.grantCross), undefined, "跨实例授权只进回执");
      // 回执里记了跨实例授权
      const report = applied.report as { grants_cross_instance: Array<{ id: string }> };
      assert.deepEqual(report.grants_cross_instance.map((g) => g.id), [src.ids.grantCross]);
    } finally {
      host.client.close();
      await host.runtime.stop("pi2");
      host.server.close();
    }
  } finally {
    src.cleanup();
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

// ---------- 3. 中断续跑、幂等、修订与回退 ----------

test("故障注入续跑无重复；同键重放/异参冲突；修订冲突；回退与阻挡项", async () => {
  const src = await buildSource("pi3");
  try {
    // 文件复制后故障 → 同计划重跑成功且无重复
    {
      const dirs = targetDirs("p3a");
      const preview = previewPersonalImport(depsOf(dirs), { from: src.srcDataDir });
      const input = {
        plan: { from: src.srcDataDir },
        source_instance_id: preview.source.instance_id,
        revision: preview.revision!,
        request_id: "imp-p3a",
      };
      let thrown: unknown = null;
      try {
        applyPersonalImport({ ...depsOf(dirs), __testHooks: { afterFilesCopied: () => { throw new Error("boom"); } } }, input);
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown !== null, "注入故障生效");
      const applied = applyPersonalImport(depsOf(dirs), input);
      assert.equal(applied.replayed, false, "复制后故障用同一计划重跑成功");
      assert.equal(
        (new Db(dirs.dataDir).prepare("SELECT count(*) c FROM instance_imports").get() as { c: number }).c,
        1,
        "没有重复回执",
      );
      fs.rmSync(dirs.root, { recursive: true, force: true });
    }
    // 事务内故障整体回滚；同键重放与异参冲突
    {
      const dirs = targetDirs("p3b");
      const preview = previewPersonalImport(depsOf(dirs), { from: src.srcDataDir });
      const input = {
        plan: { from: src.srcDataDir },
        source_instance_id: preview.source.instance_id,
        revision: preview.revision!,
        request_id: "imp-p3b",
      };
      let thrown: unknown = null;
      try {
        applyPersonalImport({ ...depsOf(dirs), __testHooks: { insideImportTx: () => { throw new Error("boom"); } } }, input);
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown !== null);
      {
        const tdb = new Db(dirs.dataDir);
        assert.equal((tdb.prepare("SELECT count(*) c FROM projects").get() as { c: number }).c, 0, "事务内故障整体回滚");
        assert.equal((tdb.prepare("SELECT count(*) c FROM instance_imports").get() as { c: number }).c, 0);
        tdb.close();
      }
      const applied = applyPersonalImport(depsOf(dirs), input);
      assert.equal(applied.replayed, false);
      const replay = applyPersonalImport(depsOf(dirs), input);
      assert.equal(replay.replayed, true, "同键同参返回原回执");
      assert.equal(
        errCode(() => applyPersonalImport(depsOf(dirs), { ...input, plan: { from: src.srcDataDir, renames: { [src.ids.devProj]: "改名" } } })),
        "request_conflict",
        "同键异参拒绝",
      );
      fs.rmSync(dirs.root, { recursive: true, force: true });
    }
    // 预览后源/目标变化 → revision_conflict
    {
      const dirs = targetDirs("p3c");
      const preview = previewPersonalImport(depsOf(dirs), { from: src.srcDataDir });
      const post = new Db(src.srcDataDir);
      post.prepare("UPDATE tasks SET error_message = 'changed' WHERE id = ?").run(src.ids.taskQueued);
      post.close();
      assert.equal(
        errCode(() =>
          applyPersonalImport(depsOf(dirs), {
            plan: { from: src.srcDataDir },
            source_instance_id: preview.source.instance_id,
            revision: preview.revision!,
            request_id: "imp-p3c",
          }),
        ),
        "revision_conflict",
        "源变化后旧修订拒绝",
      );
      fs.rmSync(dirs.root, { recursive: true, force: true });
    }
    // 干净回退：行/事件/文件/凭据移除，回执 reverted，源不变，跨进程可核实
    {
      const dirs = targetDirs("p3d");
      const before = hashTree(src.root);
      const preview = previewPersonalImport(depsOf(dirs), { from: src.srcDataDir });
      const applied = applyPersonalImport(depsOf(dirs), {
        plan: { from: src.srcDataDir },
        source_instance_id: preview.source.instance_id,
        revision: preview.revision!,
        request_id: "imp-p3d",
      });
      const reverted = revertPersonalImport(depsOf(dirs), applied.import_id);
      assert.equal(reverted.ok, true, JSON.stringify(reverted.blockers));
      const tdb = new Db(dirs.dataDir);
      const count = (sql: string, ...params: unknown[]) => (tdb.prepare(sql).get(...(params as never[])) as { c: number }).c;
      assert.equal(count("SELECT count(*) c FROM sessions"), 0, "会话行移除");
      assert.equal(count("SELECT count(*) c FROM projects"), 0, "项目行移除");
      assert.equal(count("SELECT count(*) c FROM agent_roles"), 0, "角色行移除");
      assert.equal(count("SELECT count(*) c FROM schedules"), 0, "调度移除");
      assert.equal(count("SELECT count(*) c FROM notification_ops"), 0, "发送账本移除");
      assert.equal(count("SELECT count(*) c FROM inbound_events"), 0, "入站移除");
      assert.equal(count("SELECT count(*) c FROM standing_permissions"), 0, "授权移除");
      assert.equal(count("SELECT count(*) c FROM qq_config"), 0, "qq 配置移除");
      assert.equal(count("SELECT count(*) c FROM telegram_config"), 0, "telegram 配置移除");
      assert.equal(count("SELECT count(*) c FROM qq_inbox"), 0, "群收件移除");
      assert.equal(count("SELECT count(*) c FROM github_drafts"), 0, "GitHub 归档移除");
      assert.equal(count("SELECT count(*) c FROM meta WHERE key = 'app_data.main_instance_id'"), 0, "应用数据绑定摘除");
      assert.equal(count("SELECT count(*) c FROM instance_imports WHERE status = 'reverted'"), 1, "回执标为 reverted");
      tdb.close();
      assert.equal(fs.existsSync(path.join(dirs.dataDir, "agent-data", "main.db")), false, "应用数据文件移除");
      assert.equal(fs.existsSync(path.join(dirs.dataDir, "github-archive-manifest.json")), false, "manifest 移除");
      assert.equal(fs.readdirSync(path.join(dirs.dataDir, "artifacts")).length, 0, "产物文件移除");
      assert.equal(fs.readdirSync(path.join(dirs.dataDir, "sessions")).length, 0, "历史文件移除");
      const creds = JSON.parse(fs.readFileSync(path.join(dirs.agentDir, "credentials.json"), "utf8")) as { bindings: Array<{ name: string }> };
      assert.equal(creds.bindings.length, 0, "导入凭据摘除");
      assert.equal(hashTree(src.root), before, "源目录不变");
      // 跨进程（新连接）仍可核实回执
      const second = listLegacyImports(depsOf(dirs));
      assert.equal(second.length, 1);
      assert.equal(second[0]!.status, "reverted");
      fs.rmSync(dirs.root, { recursive: true, force: true });
    }
    // 导入后活动与易变行改写是阻挡项（逐项列出，不抹事实）
    {
      const dirs = targetDirs("p3e");
      const preview = previewPersonalImport(depsOf(dirs), { from: src.srcDataDir });
      const applied = applyPersonalImport(depsOf(dirs), {
        plan: { from: src.srcDataDir },
        source_instance_id: preview.source.instance_id,
        revision: preview.revision!,
        request_id: "imp-p3e",
      });
      const tdb = new Db(dirs.dataDir);
      // 新入站（平台在目标消费过）、telegram 偏移前进、旧 op 被标记 sent、应用数据被写
      tdb.prepare("INSERT INTO inbound_events (id, source, external_id, target_role, body, received_at, status) VALUES (?, 'telegram', '777:c1:102', 'main', '{}', ?, 'done')").run(randomId("evt"), new Date().toISOString());
      tdb.prepare("UPDATE telegram_config SET last_update_id = 42 WHERE id = 1").run();
      tdb.prepare("UPDATE notification_ops SET status = 'sent', settled_at = ? WHERE id = ?").run(new Date().toISOString(), src.ids.opPending);
      tdb.prepare("UPDATE schedules SET next_due_at = ? WHERE id = ?").run(new Date(Date.now() + 86400_000).toISOString(), src.ids.schNotify);
      tdb.close();
      // 应用数据改写（wal 变化 = 文件 sha 不符）
      fs.appendFileSync(path.join(dirs.dataDir, "agent-data", "main.db-wal"), "x");
      const refused = revertPersonalImport(depsOf(dirs), applied.import_id);
      assert.equal(refused.ok, false);
      assert.equal(refused.status, "applied", "回退被挡时响应与回执状态一致");
      const text = (refused.blockers ?? []).join("\n");
      assert.ok(text.includes("新入站事件"), "列出新入站");
      assert.ok(text.includes("telegram_config"), "列出被改写的平台配置");
      assert.ok(text.includes("notification_ops"), "列出发送事实改写");
      assert.ok(text.includes("schedules"), "列出调度推进");
      assert.ok(refused.files_removed.length === 0, "拒绝回退不删任何文件");
      // 回执仍是 applied
      const tdb2 = new Db(dirs.dataDir);
      assert.equal((tdb2.prepare("SELECT status FROM instance_imports WHERE id = ?").get(applied.import_id) as { status: string }).status, "applied");
      tdb2.close();
      fs.rmSync(dirs.root, { recursive: true, force: true });
    }
  } finally {
    src.cleanup();
  }
});

// ---------- 4. v20 旧库：快照迁移只在副本上 ----------

test("v20 旧库（个人方向）：快照迁移只在副本上执行，源 sha 不变", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-pi-v20-"));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const tRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-pi-tv20-"));
  const dirs = { root: tRoot, dataDir: path.join(tRoot, "data"), agentDir: path.join(tRoot, "agent") };
  try {
    const db = new Db(dataDir);
    const store = new Store(db);
    // v20 形态：main 角色 + 会话 + 无组织归属列
    const project = store.withTx(() => store.createProject("agent-main"));
    const session = store.withTx(() =>
      store.createSession({
        projectId: project.id,
        cwd: dataDir,
        cwdReal: fs.realpathSync(dataDir),
        cwdDev: 1,
        cwdIno: 1,
        piSessionId: "pi-v20m",
        sessionFile: path.join(dataDir, "sessions", "s_pi-v20m.jsonl"),
        confirmTools: [],
      }),
    );
    fs.mkdirSync(path.join(dataDir, "sessions"), { recursive: true });
    fs.writeFileSync(session.sessionFile!, `${JSON.stringify({ type: "message", role: "user", content: "旧 main 内容" })}\n`);
    db.prepare(
      "INSERT INTO agent_roles (id, project_id, session_id, work_dir, model_selection, tools, created_at) VALUES ('main', ?, ?, ?, NULL, '[]', ?)",
    ).run(project.id, session.id, dataDir, NOW);
    db.exec("ALTER TABLE sessions DROP COLUMN workspace_project_id");
    db.exec("UPDATE meta SET value = '20' WHERE key = 'schema_version'");
    db.close();
    const before = hashTree(root);

    const deps = depsOf(dirs);
    const preview = previewPersonalImport(deps, { from: dataDir });
    assert.equal(preview.source.schema_version_original, 20, "记录原始版本");
    assert.equal(preview.source.schema_version_current, SCHEMA_VERSION);
    assert.equal(preview.roles.length, 1);
    assert.equal(preview.roles[0]!.id, "main");
    const applied = applyPersonalImport(deps, {
      plan: { from: dataDir },
      source_instance_id: preview.source.instance_id,
      revision: preview.revision!,
      request_id: "imp-pi-v20",
    });
    assert.equal(applied.counts.agent_roles, 1);
    assert.equal(applied.counts.sessions, 1);
    assert.equal(hashTree(root), before, "旧库只在快照上迁移，源逐文件不变");
    const tdb = new Db(dirs.dataDir);
    const role = tdb.prepare("SELECT work_dir FROM agent_roles WHERE id = 'main'").get() as { work_dir: string };
    assert.ok(role.work_dir.includes("agent-work"), "角色工作目录改写为目标 agent-work");
    const sess = new Store(tdb).getSession(session.id)!;
    assert.deepEqual(fs.readFileSync(sess.sessionFile!), fs.readFileSync(path.join(dataDir, "sessions", "s_pi-v20m.jsonl")), "历史字节一致");
    tdb.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(tRoot, { recursive: true, force: true });
  }
});

// ---------- 5. CLI：真实 bin 入口（ruukoto 产品） ----------

test("CLI：ruukoto legacy-import preview/apply/list/revert 全流程", async () => {
  const src = await buildSource("pi-cli");
  const dirs = targetDirs("picli");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: os.homedir(),
    RUUKOTO_DATA_DIR: dirs.dataDir,
    RUUKOTO_AGENT_DIR: dirs.agentDir,
  };
  const run = (args: string[]) =>
    spawnSync(process.execPath, [path.join(repoRoot, "bin", "ruukoto.mjs"), ...args], {
      env,
      cwd: repoRoot,
      timeout: 180_000,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  try {
    const sourceHashBefore = hashTree(src.root);
    const planFile = path.join(dirs.root, "plan.json");
    const preview = run(["legacy-import", "preview", "--from", src.srcDataDir, "--plan", planFile]);
    assert.equal(preview.status, 0, preview.stderr);
    const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
    assert.ok(typeof plan.source_instance_id === "string" && plan.source_instance_id.length > 0);
    assert.ok(typeof plan.revision === "string" && plan.revision.startsWith("r1."));
    assert.equal(fs.existsSync(path.join(dirs.dataDir, "ruukoto.db")), false, "预览对目标零写入");
    const previewJson = JSON.parse(preview.stdout);
    assert.equal(previewJson.direction, "personal-into-ruukoto");

    const applied = run(["legacy-import", "apply", "--plan", planFile]);
    assert.equal(applied.status, 0, applied.stderr);
    const appliedJson = JSON.parse(applied.stdout);
    assert.equal(appliedJson.replayed, false);
    const replay = run(["legacy-import", "apply", "--plan", planFile]);
    assert.equal(JSON.parse(replay.stdout).replayed, true, "同一计划文件重放返回回执");

    const list = run(["legacy-import", "list"]);
    assert.equal(list.status, 0);
    const items = JSON.parse(list.stdout);
    assert.equal(items.length, 1);
    assert.equal(items[0].status, "applied");

    const reverted = run(["legacy-import", "revert", appliedJson.import_id]);
    assert.equal(reverted.status, 0, reverted.stderr);
    assert.equal(JSON.parse(reverted.stdout).ok, true);
    const listedAfter = run(["legacy-import", "list"]);
    assert.equal(JSON.parse(listedAfter.stdout)[0].status, "reverted");
    assert.equal(hashTree(src.root), sourceHashBefore, "CLI 全流程后源目录不变");
  } finally {
    src.cleanup();
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});
