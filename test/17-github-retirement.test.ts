/**
 * issue 17 集成测试：GitHub 专用模块退役与历史资料归档。
 *
 * 旧模块（src/agent/github/，REST 采集/草稿/发布）已删除，GitHub 经通用 MCP
 * 接入（issue 16，test/24-mcp.test.ts）。本文件覆盖退役迁移本身：
 * - 全新数据库不再创建 github_* 表；旧库（v8，含 github 数据）升级不失败、
 *   旧表保留为只读归档（不 DROP）；
 * - 旧 github_publish 审批（pending / approved 未消费）一律失效；未决发布操作
 *   按证据定终态：批准已消费或无审批记录（完全访问路径）→ effect_unknown
 *   （绝不重发），审批未消费 → canceled（可证明未发送）；终态操作原样保留；
 * - 草稿各版本正文/证据引用/发布记录导出为原任务产物（可经 read_artifact
 *   读取），绑定仅导出无秘密配置，导出清单落盘；重跑不重复产物；
 * - 旧凭据的 host/scope/秘密值不被迁移改变；同名轮换保留 scope；
 * - 旧 github_* 控制接口不可达（unknown_op）；历史 github.* 事件可重放。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  makeTestDirs,
  cleanupDirs,
  writeModelsJson,
  connectAuthedClient,
  type TestDirs,
} from "./helpers/testkit.ts";
import { MockModelServer } from "./helpers/mock-provider.ts";
import { Runtime } from "../src/runtime/runtime.ts";
import { ControlServer } from "../src/control/server.ts";
import { ControlClient } from "../src/control/client.ts";
import { Db, SCHEMA_VERSION } from "../src/core/db.ts";
import { createMockTools } from "../src/agent/mock-tools.ts";
import { GITHUB_ARCHIVE_MANIFEST_FILE } from "../src/runtime/github-retirement.ts";

// ---------- 旧库样本（v8：github_* 三张表的建表 SQL 冻结于此，退役后唯一保留处） ----------

const LEGACY_GITHUB_TABLES_SQL = `
CREATE TABLE github_repo_bindings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  api_host TEXT NOT NULL,
  scheme TEXT NOT NULL DEFAULT 'https',
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  repo_id INTEGER,
  read_credential TEXT,
  publish_credential TEXT,
  read_scopes TEXT NOT NULL,
  allow_fork_content INTEGER NOT NULL DEFAULT 0,
  config_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, api_host, owner, repo)
);
CREATE TABLE github_drafts (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  body TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  revisions TEXT NOT NULL,
  evidence_artifact_ids TEXT NOT NULL,
  config_version INTEGER NOT NULL,
  stale_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);
CREATE INDEX idx_github_drafts_task ON github_drafts (task_id);
CREATE TABLE github_publish_ops (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  draft_version INTEGER NOT NULL,
  binding_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  revisions TEXT NOT NULL,
  config_version INTEGER NOT NULL,
  permission_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  remote_id INTEGER,
  remote_url TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_github_publish_ops_draft ON github_publish_ops (draft_id, draft_version);
`;

const T0 = "2026-09-20T00:00:00.000Z";
const T1 = "2026-09-21T00:00:00.000Z";

function ghScope(publishOpId: string, draftId: string, draftVersion: number): string {
  return JSON.stringify({
    kind: "github_publish",
    publishOpId,
    draftId,
    draftVersion,
    apiHost: "api.github.com",
    owner: "o",
    repo: "r",
    repoId: 424242,
    publishKind: "pr_review_comment",
    target: { prNumber: 7 },
    bodySha256: "a".repeat(64),
    bodyBytes: 12,
    revisions: { headSha: "aaaa1111", baseSha: "bbbb2222" },
  });
}

/**
 * 构造 v8 旧库：先用当前代码建全新库（v≥9，无 github_* 表；v8 与现行 schema
 * 的唯一差异即 github_* 三张表），再补旧表与样本数据、把版本号回写为 8，
 * 模拟带 GitHub 数据的旧库升级。
 */
function buildLegacyDb(dirs: TestDirs): void {
  const fresh = new Db(dirs.dataDir);
  fresh.close();
  const raw = new DatabaseSync(path.join(dirs.dataDir, "ruukoto.db"));
  try {
    raw.exec(LEGACY_GITHUB_TABLES_SQL);
    const run = (sql: string, ...args: (string | number | null)[]) => raw.prepare(sql).run(...args);
    run("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'proj-1', ?)", T0);
    run(
      "INSERT INTO sessions (id, project_id, cwd, cwd_real, cwd_dev, cwd_ino, pi_session_id, created_at) VALUES ('s1', 'p1', '/tmp/w', '/tmp/w', 1, 1, 'pi-1', ?)",
      T0,
    );
    for (const t of ["t1", "t2"]) {
      run(
        "INSERT INTO tasks (id, session_id, request_id, input, status, created_at, started_at, ended_at) VALUES (?, 's1', ?, '输入', 'completed', ?, ?, ?)",
        t,
        `req-${t}`,
        T0,
        T0,
        T1,
      );
    }
    // 旧凭据（带 scope 限制；迁移不得改变 host/scope/秘密值）
    // —— 凭据在 credentials.json，由调用方写入 agentDir。
    run(
      `INSERT INTO github_repo_bindings (id, project_id, api_host, scheme, owner, repo, repo_id, read_credential, publish_credential, read_scopes, allow_fork_content, config_version, created_at, updated_at)
       VALUES ('b1', 'p1', 'api.github.com', 'https', 'o', 'r', 424242, 'gh-read', 'gh-write', '["pulls","actions","checks"]', 0, 3, ?, ?)`,
      T0,
      T0,
    );
    const draft = (
      id: string,
      version: number,
      taskId: string,
      kind: string,
      status: string,
      body: string,
      staleReason: string | null,
    ) =>
      run(
        `INSERT INTO github_drafts (id, project_id, task_id, session_id, binding_id, kind, version, status, body, body_sha256, revisions, evidence_artifact_ids, config_version, stale_reason, created_at, updated_at)
         VALUES (?, 'p1', ?, 's1', 'b1', ?, ?, ?, ?, ?, ?, '["art_ev1"]', 3, ?, ?, ?)`,
        id,
        taskId,
        kind,
        version,
        status,
        body,
        `${id}v${version}sha`,
        JSON.stringify(kind === "pr_review" ? { headSha: "aaaa1111", baseSha: "bbbb2222" } : { runId: 555, runAttempt: 2, headSha: "cccc3333" }),
        staleReason,
        T0,
        T1,
      );
    draft("d1", 1, "t1", "pr_review", "draft", "v1 正文：第 1 行变更合理。", null);
    draft("d1", 2, "t1", "pr_review", "draft", "v2 正文：补充了风险说明。", null);
    draft("d2", 1, "t2", "ci_analysis", "stale", "CI 分析正文。", "run 已重跑");
    draft("d3", 1, "t1", "pr_review", "published", "已发布正文。", null);
    const op = (
      id: string,
      draftId: string,
      draftVersion: number,
      status: string,
      remoteId: number | null = null,
      remoteUrl: string | null = null,
      errorMessage: string | null = null,
    ) =>
      run(
        `INSERT INTO github_publish_ops (id, draft_id, draft_version, binding_id, kind, target, body_sha256, revisions, config_version, permission_version, status, remote_id, remote_url, error_message, created_at, updated_at)
         VALUES (?, ?, ?, 'b1', 'pr_review_comment', '{"prNumber":7}', 'sha', '{"headSha":"aaaa1111","baseSha":"bbbb2222"}', 3, 1, ?, ?, ?, ?, ?, ?)`,
        id,
        draftId,
        draftVersion,
        status,
        remoteId,
        remoteUrl,
        errorMessage,
        T0,
        T1,
      );
    op("op1", "d1", 2, "pending"); // 批准已消费 → effect_unknown
    op("op2", "d1", 2, "pending"); // approved 未消费 → canceled
    op("op3", "d2", 1, "pending"); // pending 审批 → canceled
    op("op4", "d3", 1, "pending"); // 无审批（完全访问路径）→ effect_unknown
    op("op5", "d3", 1, "sent", 9000, "https://github.com/o/r/pull/7#review-1");
    op("op6", "d1", 1, "failed", null, null, "远端拒绝");
    op("op7", "d1", 1, "effect_unknown", null, null, "发送后超时");
    op("op8", "d2", 1, "canceled", null, null, "拥有者拒绝发布");
    const conf = (
      id: string,
      taskId: string,
      toolOpId: string,
      toolName: string,
      scope: string,
      status: string,
      consumedAt: string | null,
    ) =>
      run(
        `INSERT INTO confirmations (id, task_id, session_id, tool_op_id, tool_name, params, scope, status, created_at, responded_at, consumed_at)
         VALUES (?, ?, 's1', ?, ?, '{}', ?, ?, ?, ?, ?)`,
        id,
        taskId,
        toolOpId,
        toolName,
        scope,
        status,
        T0,
        status === "pending" ? null : T1,
        consumedAt,
      );
    conf("c1", "t1", "op1", "github_publish", ghScope("op1", "d1", 2), "approved", T1);
    conf("c2", "t1", "op2", "github_publish", ghScope("op2", "d1", 2), "approved", null);
    conf("c3", "t2", "op3", "github_publish", ghScope("op3", "d2", 1), "pending", null);
    // 非 GitHub 的 pending 审批：退役迁移不得触碰
    conf("c4", "t1", "some-op", "bash", JSON.stringify({ kind: "tool", workspaceOnly: true }), "pending", null);
    // 历史事件（github.* 类型须保持可重放）。首条事件占住 seq 1：
    // 协议设计上 since=0 表示全新连接（不重放），重放区间为 (since, seq]。
    run(
      "INSERT INTO events (task_id, session_id, body, created_at) VALUES (NULL, NULL, ?, ?)",
      JSON.stringify({ type: "project.created", projectId: "p1", name: "proj-1" }),
      T0,
    );
    run(
      "INSERT INTO events (task_id, session_id, body, created_at) VALUES ('t1', 's1', ?, ?)",
      JSON.stringify({ type: "github.draft_saved", draftId: "d1", version: 2, taskId: "t1", sessionId: "s1", kind: "pr_review", bodySha256: "x", bodyBytes: 12 }),
      T0,
    );
    run(
      "INSERT INTO events (task_id, session_id, body, created_at) VALUES ('t1', 's1', ?, ?)",
      JSON.stringify({ type: "github.publish_settled", publishOpId: "op5", draftId: "d3", status: "sent", remoteUrl: "https://github.com/o/r/pull/7#review-1", errorMessage: null }),
      T1,
    );
    // 回写为 v8：触发升级路径
    run("UPDATE meta SET value = '8' WHERE key = 'schema_version'");
  } finally {
    raw.close();
  }
  // 旧凭据：host/scope/秘密值在迁移前后必须原样
  fs.writeFileSync(
    path.join(dirs.agentDir, "credentials.json"),
    JSON.stringify(
      {
        bindings: [
          {
            name: "gh-read",
            host: "api.github.com",
            header: "Authorization",
            purpose: "GitHub 读取",
            secret: "read-secret",
            scope: { projectId: "p1", repoId: 424242, operations: ["github_read"] },
          },
          {
            name: "gh-write",
            host: "api.github.com",
            header: "Authorization",
            purpose: "GitHub 发布",
            secret: "write-secret",
            scope: { projectId: "p1", repoId: 424242, operations: ["github_publish"] },
          },
        ],
      },
      null,
      2,
    ),
  );
}

interface LegacyFixture {
  runtime: Runtime;
  client: ControlClient;
  server: MockModelServer;
  dirs: TestDirs;
  dbFile: string;
  shutdown(): Promise<void>;
}

async function startLegacyRuntime(prefix: string, afterLegacyDb?: (dirs: TestDirs) => void): Promise<LegacyFixture> {
  const { dirs } = await makeTestDirs(prefix, 0);
  buildLegacyDb(dirs);
  afterLegacyDb?.(dirs);
  const server = new MockModelServer(async () => ({ kind: "text" as const, text: "done" }));
  const baseUrl = await server.start();
  await writeModelsJson(dirs, baseUrl);
  const runtime = await Runtime.start({
    dataDir: dirs.dataDir,
    agentDir: dirs.agentDir,
    socketPath: path.join(dirs.root, "c.sock"),
    thinkingLevel: "off",
    modelProvider: "mock",
    modelId: "mock-model",
    toolFactory: (ctx) => createMockTools(ctx),
  });
  await ControlServer.start(runtime);
  const client = await connectAuthedClient(runtime);
  await client.handshake();
  return {
    runtime,
    client,
    server,
    dirs,
    dbFile: path.join(dirs.dataDir, "ruukoto.db"),
    async shutdown() {
      client.close();
      await runtime.stop("test_end");
      await server.close();
      await cleanupDirs(dirs);
    },
  };
}

/** 只读查询（WAL 允许并发读；不断言写入路径）。 */
function queryAll(dbFile: string, sql: string, ...args: (string | number)[]): any[] {
  const raw = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return raw.prepare(sql).all(...args) as any[];
  } finally {
    raw.close();
  }
}

function manifestPath(dirs: TestDirs): string {
  return path.join(dirs.dataDir, GITHUB_ARCHIVE_MANIFEST_FILE);
}

// ---------- 测试 ----------

test("github 退役：全新数据库不创建旧表，启动不产生归档", async () => {
  const { dirs } = await makeTestDirs("gh-retire-fresh", 0);
  try {
    const db = new Db(dirs.dataDir);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'github_%'").all() as any[]).map((r) => r.name);
    assert.deepEqual(tables, [], "全新数据库不得创建 github_* 表");
    db.close();
  } finally {
    await cleanupDirs(dirs);
  }
});

test("github 退役：v8 旧库升级 —— 审批失效、发布操作按证据定终态、旧表保留", async () => {
  const f = await startLegacyRuntime("gh-retire");
  try {
    // schema 升级到当前版本；旧表保留为只读归档（不 DROP）
    const version = queryAll(f.dbFile, "SELECT value FROM meta WHERE key = 'schema_version'")[0]!.value;
    assert.equal(Number(version), SCHEMA_VERSION);
    const tables = queryAll(f.dbFile, "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'github_%'").map((r: any) => r.name);
    assert.deepEqual(tables.sort(), ["github_drafts", "github_publish_ops", "github_repo_bindings"]);

    // 审批：pending 与 approved 未消费 → stale；已消费原样；非 GitHub 审批不受影响
    const confs = queryAll(f.dbFile, "SELECT id, status, consumed_at FROM confirmations ORDER BY id");
    const byId = Object.fromEntries(confs.map((c: any) => [c.id, c]));
    assert.equal(byId["c1"].status, "approved", "已消费批准保持原状");
    assert.ok(byId["c1"].consumed_at, "已消费时间保留");
    assert.equal(byId["c2"].status, "stale", "approved 未消费 → 失效");
    assert.equal(byId["c3"].status, "stale", "pending → 失效");
    assert.equal(byId["c4"].status, "pending", "非 GitHub 审批不受退役影响");

    // 发布操作：按证据定终态，终态操作原样保留
    const ops = queryAll(f.dbFile, "SELECT id, status, error_message, remote_url FROM github_publish_ops ORDER BY id");
    const opById = Object.fromEntries(ops.map((o: any) => [o.id, o]));
    assert.equal(opById["op1"].status, "effect_unknown", "批准已消费 → 结果不明（绝不重发）");
    assert.match(opById["op1"].error_message, /退役/);
    assert.equal(opById["op2"].status, "canceled", "审批未消费 → 可证明未发送");
    assert.match(opById["op2"].error_message, /退役/);
    assert.equal(opById["op3"].status, "canceled");
    assert.equal(opById["op4"].status, "effect_unknown", "无审批记录（完全访问路径）→ 结果不明");
    assert.match(opById["op4"].error_message, /退役/);
    assert.equal(opById["op5"].status, "sent");
    assert.equal(opById["op5"].remote_url, "https://github.com/o/r/pull/7#review-1");
    assert.equal(opById["op6"].status, "failed");
    assert.equal(opById["op7"].status, "effect_unknown");
    assert.equal(opById["op7"].error_message, "发送后超时", "既有 effect_unknown 的原说明不被改写");
    assert.equal(opById["op8"].status, "canceled");

    // 退役事件落盘（每个被终结的 pending 操作一条 publish_settled）
    const events = queryAll(f.dbFile, "SELECT body FROM events WHERE body LIKE '%github.publish_settled%' ORDER BY seq");
    const bodies = events.map((e: any) => JSON.parse(e.body));
    const retired = bodies.filter((b) => ["op1", "op2", "op3", "op4"].includes(b.publishOpId) && typeof b.errorMessage === "string" && b.errorMessage.includes("退役"));
    assert.equal(retired.length, 4, "每个被终结的未决操作都有退役事件");
    // 历史事件原样保留
    assert.ok(bodies.some((b) => b.publishOpId === "op5" && b.status === "sent"), "历史 sent 事件保留");
  } finally {
    await f.shutdown();
  }
});

test("github 退役：草稿各版本导出为原任务产物，清单无秘密，重跑不重复", async () => {
  const f = await startLegacyRuntime("gh-archive");
  try {
    // 归档产物：每个草稿版本一件，归属原任务，经 read_artifact 可读
    const artifacts = queryAll(f.dbFile, "SELECT id, task_id, session_id, name, status FROM artifacts WHERE name LIKE 'github-draft-archive-%' ORDER BY name");
    assert.equal(artifacts.length, 4, "d1v1/d1v2/d2v1/d3v1 各一件");
    assert.ok(artifacts.every((a: any) => a.status === "complete"));
    const d1v2 = artifacts.find((a: any) => a.name === "github-draft-archive-d1-v2")!;
    assert.equal(d1v2.task_id, "t1");
    assert.equal(d1v2.session_id, "s1");
    const read = await f.client.request<{ data: string }>("read_artifact", { task_id: "t1", artifact_id: d1v2.id });
    const text = Buffer.from(read.data, "base64").toString("utf8");
    assert.ok(text.includes("v2 正文：补充了风险说明。"), "产物含草稿正文");
    assert.ok(text.includes("d1") && text.includes("v2"), "产物记录来源 ID 与版本");
    assert.ok(text.includes("op1") && text.includes("op2"), "产物含本版本发布记录");
    assert.ok(text.includes("art_ev1"), "产物记录证据引用");

    // 导出清单：来源 ID/版本/产物对应 + 绑定无秘密配置 + 发布记录
    const manifest = JSON.parse(fs.readFileSync(manifestPath(f.dirs), "utf8"));
    assert.equal(manifest.drafts.length, 4);
    assert.ok(manifest.drafts.every((d: any) => typeof d.artifactId === "string" && d.artifactId));
    assert.equal(manifest.bindings.length, 1);
    assert.equal(manifest.bindings[0].owner, "o");
    assert.equal(manifest.bindings[0].readCredential, "gh-read", "凭据只出现绑定名");
    const manifestRaw = fs.readFileSync(manifestPath(f.dirs), "utf8");
    assert.ok(!manifestRaw.includes("read-secret") && !manifestRaw.includes("write-secret"), "清单不含秘密值");
    assert.equal(manifest.publishOps.length, 8);

    // 重跑（重启）：不重复产物、不改写终态
    const before = queryAll(f.dbFile, "SELECT COUNT(*) n FROM artifacts")[0]!.n;
    f.client.close();
    await f.runtime.stop("restart");
    const runtime2 = await Runtime.start({
      dataDir: f.dirs.dataDir,
      agentDir: f.dirs.agentDir,
      socketPath: path.join(f.dirs.root, "c.sock"),
      thinkingLevel: "off",
      modelProvider: "mock",
      modelId: "mock-model",
      toolFactory: (ctx) => createMockTools(ctx),
    });
    try {
      const after = queryAll(f.dbFile, "SELECT COUNT(*) n FROM artifacts")[0]!.n;
      assert.equal(after, before, "重跑不重复产物");
      const op1 = queryAll(f.dbFile, "SELECT status, error_message FROM github_publish_ops WHERE id = 'op1'")[0]!;
      assert.equal(op1.status, "effect_unknown", "重跑不改写终态");
    } finally {
      await runtime2.stop("test_end");
    }
  } finally {
    await f.shutdown();
  }
});

test("github 退役：旧控制接口不可达；旧凭据不被迁移改变；历史事件可重放", async () => {
  const f = await startLegacyRuntime("gh-entries");
  try {
    // 旧写/读入口全部不可达
    for (const op of ["github_bind", "github_unbind", "github_list_bindings", "github_list_drafts", "github_get_draft", "github_list_publish_ops", "github_publish"]) {
      await assert.rejects(f.client.request(op, {}), new RegExp(`未知操作.*${op}`), `${op} 应不可达`);
    }
    // 旧凭据：host/scope/秘密值原样（不扩大用途、不复制到新主机）
    const creds = JSON.parse(fs.readFileSync(path.join(f.dirs.agentDir, "credentials.json"), "utf8"));
    const write = creds.bindings.find((b: any) => b.name === "gh-write");
    assert.equal(write.host, "api.github.com");
    assert.equal(write.secret, "write-secret");
    assert.deepEqual(write.scope, { projectId: "p1", repoId: 424242, operations: ["github_publish"] });
    // 同名轮换保留 scope（不清空限制字段）
    await f.client.request("add_credential", { name: "gh-write", host: "api.github.com", header: "Authorization", purpose: "GitHub 发布", secret: "rotated-secret" });
    const rotated = f.runtime.credentials.get("gh-write")!;
    assert.equal(rotated.secret, "rotated-secret");
    assert.deepEqual(rotated.scope, { projectId: "p1", repoId: 424242, operations: ["github_publish"] }, "轮换不得清空 scope");

    // 历史 github.* 事件经控制协议重放（旧事件可显示为归档记录）
    const client2 = await connectAuthedClient(f.runtime);
    try {
      const { replay } = await client2.handshake(1);
      const types = replay.map((e) => e.body.type);
      assert.ok(types.includes("github.draft_saved"), "重放含历史 github 事件");
      assert.ok(types.includes("github.publish_settled"), "重放含历史/退役 publish_settled 事件");
    } finally {
      client2.close();
    }
  } finally {
    await f.shutdown();
  }
});

test("github 退役：上次导出中断留下 partial 产物时，重跑补齐完整导出且不改写中断记录", async () => {
  // 模拟上次导出在 begin 后中断：同名 partial 产物行（无正文文件，不读取）
  const f = await startLegacyRuntime("gh-archive-resume", (dirs) => {
    const raw = new DatabaseSync(path.join(dirs.dataDir, "ruukoto.db"));
    raw
      .prepare("INSERT INTO artifacts (id, task_id, session_id, name, byte_count, status, created_at) VALUES ('art_partial', 't1', 's1', 'github-draft-archive-d1-v1', 10, 'partial', ?)")
      .run(T0);
    raw.close();
  });
  try {
    const rows = queryAll(f.dbFile, "SELECT id, status FROM artifacts WHERE name = 'github-draft-archive-d1-v1' ORDER BY created_at");
    const complete = rows.filter((r: any) => r.status === "complete");
    assert.equal(complete.length, 1, "重跑补齐完整导出");
    assert.ok(rows.some((r: any) => r.id === "art_partial" && r.status === "partial"), "中断的 partial 产物原样保留（不实称完整）");
    const manifest = JSON.parse(fs.readFileSync(manifestPath(f.dirs), "utf8"));
    assert.equal(manifest.drafts.find((d: any) => d.draftId === "d1" && d.version === 1).artifactId, complete[0]!.id, "清单指向完整产物");
    const read = await f.client.request<{ data: string }>("read_artifact", { task_id: "t1", artifact_id: complete[0]!.id });
    assert.ok(Buffer.from(read.data, "base64").toString("utf8").includes("v1 正文"), "补齐的导出含草稿正文");
  } finally {
    await f.shutdown();
  }
});
