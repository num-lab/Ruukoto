/**
 * issue 05：上下文、历史检索与长期记忆 —— 单元与集成验证。
 *
 * 覆盖：
 * - 访问范围：授权创建/撤销/范围判定（含同项目默认、伪造项目拒绝）；
 * - 历史索引：增量同步、部分尾部、损坏行、文件替换/截断重建、中文搜索、
 *   游标继续不丢不重、扫描上限如实报告；
 * - 上下文选择器：预算校验、CJK 校准、配对不可拆分、必须项超预算明确失败、
 *   工具结果视图截断不改动原文；
 * - 记忆：创建/修订/并发冲突/撤销/恢复、来源校验、个人共享范围；
 * - 集成：长会话早期消息离开上下文后配对仍有效、历史搜索找到早期内容、
 *   选择记录每次调用落库且 usage 回填、预算不足零 provider 请求 + 队列暂停、
 *   跨项目授权（无授权不可见计数/片段，撤销后代理不可读）、代理宿主工具
 *   端到端（history_search/history_read/memory_*）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { Db } from "../src/core/db.ts";
import { Store } from "../src/core/store.ts";
import { AccessScope, AccessDeniedError } from "../src/core/access.ts";
import {
  HistoryIndex,
  searchHistory,
  entrySearchText,
} from "../src/core/history-index.ts";
import {
  MemoryConflictError,
  MemoryStore,
  MemoryValidationError,
} from "../src/core/memory.ts";
import {
  DEFAULT_BUDGET_CONFIG,
  estimateMessageTokens,
  selectContext,
  validateBudgetConfig,
  type SelectorBudgetConfig,
} from "../src/agent/context-selector.ts";
import {
  cleanupDirs,
  createProjectSession,
  makeTestDirs,
  routeResponder,
  startTestRuntime,
  taskStatus,
  waitFor,
  writeModelsJson,
} from "./helpers/testkit.ts";

async function makeDbStore(prefix: string) {
  const { dirs } = await makeTestDirs(prefix, 0);
  const db = new Db(dirs.dataDir);
  const store = new Store(db);
  return { dirs, db, store };
}

// ---------- §1 访问范围 ----------

test("访问范围：同项目默认可读，跨项目默认拒绝，授权后可读，撤销后拒绝", async () => {
  const { dirs, db, store } = await makeDbStore("access");
  try {
    const access = new AccessScope(db);
    const pa = store.createProject("A");
    const pb = store.createProject("B");
    const agentA = { kind: "agent" as const, projectId: pa.id };

    assert.equal(access.canAccess(agentA, pa.id, "history"), true);
    assert.equal(access.canAccess(agentA, pb.id, "history"), false);
    assert.equal(access.canAccess({ kind: "owner" }, pb.id, "history"), true);

    const grant = access.createGrant({ fromProjectId: pb.id, toProjectId: pa.id, category: "history" });
    assert.equal(access.canAccess(agentA, pb.id, "history"), true);
    assert.equal(access.canAccess(agentA, pb.id, "artifact"), false); // 类别分开

    access.revokeGrant(grant.id);
    assert.equal(access.canAccess(agentA, pb.id, "history"), false);
  } finally {
    db.close();
    await cleanupDirs(dirs);
  }
});

test("访问范围：同项目授权/不存在项目/无效类别明确拒绝", async () => {
  const { dirs, db, store } = await makeDbStore("access-err");
  try {
    const access = new AccessScope(db);
    const pa = store.createProject("A");
    assert.throws(() => access.createGrant({ fromProjectId: pa.id, toProjectId: pa.id, category: "history" }), AccessDeniedError);
    assert.throws(() => access.createGrant({ fromProjectId: pa.id, toProjectId: "proj_nope", category: "history" }), AccessDeniedError);
    assert.throws(
      () => access.createGrant({ fromProjectId: pa.id, toProjectId: pa.id, category: "nope" as any }),
      AccessDeniedError,
    );
  } finally {
    db.close();
    await cleanupDirs(dirs);
  }
});

// ---------- §2 历史索引 ----------

function writeJsonl(file: string, entries: Array<Record<string, unknown>>): void {
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function messageEntry(id: string, parentId: string | null, role: string, text: string, timestamp = "2026-09-20T00:00:00Z") {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: { role, content: [{ type: "text", text }] },
  };
}

test("历史索引：增量同步 + 中文搜索 + 部分尾部不入索引", async () => {
  const { dirs, db } = await makeDbStore("hist-idx");
  try {
    const file = path.join(dirs.root, "s1.jsonl");
    writeJsonl(file, [
      messageEntry("e1", null, "user", "请修复登录失败的问题"),
      messageEntry("e2", "e1", "assistant", "我先查看鉴权模块"),
    ]);
    const index = new HistoryIndex(db);
    const r1 = index.sync("s1", file);
    assert.equal(r1.added, 2);
    assert.equal(r1.rebuilt, true);

    // 追加一条完整记录 + 一条未换行的部分记录
    fs.appendFileSync(file, JSON.stringify(messageEntry("e3", "e2", "user", "错误码是 401")) + "\n");
    fs.appendFileSync(file, JSON.stringify(messageEntry("e4", "e3", "assistant", "部分")).slice(0, 20));
    const r2 = index.sync("s1", file);
    assert.equal(r2.added, 1);
    assert.equal(r2.rebuilt, false);
    assert.equal(r2.hasPartialTail, true);

    const result = searchHistory(db, [{ sessionId: "s1", filePath: file }], { query: "登录失败" });
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0]!.entryId, "e1");
    assert.match(result.hits[0]!.snippet, /登录失败/);

    const r3 = searchHistory(db, [{ sessionId: "s1", filePath: file }], { query: "401", role: "user" });
    assert.equal(r3.hits.length, 1);
    assert.equal(r3.hits[0]!.entryId, "e3");
    const r4 = searchHistory(db, [{ sessionId: "s1", filePath: file }], { query: "401", role: "assistant" });
    assert.equal(r4.hits.length, 0);
  } finally {
    db.close();
    await cleanupDirs(dirs);
  }
});

test("历史索引：文件替换触发重建且不改写源文件；损坏完整行明确报错", async () => {
  const { dirs, db } = await makeDbStore("hist-rebuild");
  try {
    const file = path.join(dirs.root, "s1.jsonl");
    writeJsonl(file, [messageEntry("e1", null, "user", "旧内容")]);
    const index = new HistoryIndex(db);
    index.sync("s1", file);

    // 替换文件（新 inode）：索引重建，源文件内容不变
    const before = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file + ".tmp", JSON.stringify(messageEntry("e9", null, "user", "全新内容")) + "\n");
    fs.renameSync(file + ".tmp", file);
    const r = index.sync("s1", file);
    assert.equal(r.rebuilt, true);
    const result = searchHistory(db, [{ sessionId: "s1", filePath: file }], { query: "旧内容" });
    assert.equal(result.hits.length, 0);
    assert.equal(fs.readFileSync(file, "utf8") !== before, true);

    // 损坏的完整行：sync 明确报错
    fs.appendFileSync(file, "{not json}\n");
    assert.throws(() => index.sync("s1", file), /损坏|corrupt|JSON/i);
  } finally {
    db.close();
    await cleanupDirs(dirs);
  }
});

test("历史检索：扫描上限如实返回不完整，游标继续不丢不重", async () => {
  const { dirs, db } = await makeDbStore("hist-cursor");
  try {
    const file = path.join(dirs.root, "s1.jsonl");
    const entries = Array.from({ length: 30 }, (_, i) =>
      messageEntry(`e${i}`, i === 0 ? null : `e${i - 1}`, "user", `第 ${i} 条消息`),
    );
    writeJsonl(file, entries);
    const index = new HistoryIndex(db);
    index.sync("s1", file);

    const seen = new Set<string>();
    let cursor: { sessionId: string; byteOffset: number } | undefined;
    let pages = 0;
    for (;;) {
      const r = searchHistory(db, [{ sessionId: "s1", filePath: file }], {
        query: "消息",
        limit: 100,
        scanLimit: 7,
        cursor,
      });
      pages++;
      for (const hit of r.hits) {
        assert.equal(seen.has(hit.entryId), false, `重复命中 ${hit.entryId}`);
        seen.add(hit.entryId);
      }
      if (r.complete) break;
      assert.ok(r.cursor, "不完整时必须给游标");
      cursor = r.cursor!;
      assert.ok(pages < 20, "游标必须收敛");
    }
    assert.equal(seen.size, 30);
    assert.ok(pages > 1);
  } finally {
    db.close();
    await cleanupDirs(dirs);
  }
});

// ---------- §3 上下文选择器 ----------

function userMsg(text: string): any {
  return { role: "user", content: [{ type: "text", text }] };
}
function assistantWithCall(id: string, name: string): any {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: {} }],
    usage: { input: 0, output: 0, totalTokens: 0 },
    stopReason: "toolUse",
  };
}
function toolResultMsg(id: string, text: string): any {
  return { role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }], isError: false };
}

function budgetConfig(overrides: Partial<SelectorBudgetConfig> = {}): SelectorBudgetConfig {
  return {
    ...DEFAULT_BUDGET_CONFIG,
    contextWindow: 4000,
    maxTokens: 500,
    toolResultReserve: 200,
    safetyMargin: 100,
    memoryBudget: 0,
    ...overrides,
  };
}

test("选择器：预算配置校验（非正值、超窗、校准系数 <1 拒绝）", () => {
  assert.throws(() => validateBudgetConfig(budgetConfig({ contextWindow: 0 })));
  assert.throws(() => validateBudgetConfig(budgetConfig({ maxTokens: 300_000 })));
  assert.throws(() => validateBudgetConfig(budgetConfig({ calibration: 0.5 })));
  assert.throws(() => validateBudgetConfig(budgetConfig({ toolResultReserve: -1 })));
});

test("选择器：CJK 校准（中文不按 chars/4 低估）", () => {
  const cjk = estimateMessageTokens(userMsg("汉".repeat(400)), 1);
  // 400 个 CJK 字符 ≈ 400 token（而非 chars/4 的 100）
  assert.ok(cjk >= 400, `CJK 估算 ${cjk} 应 ≥ 400`);
});

test("选择器：交互单元完整（toolCall/toolResult 同进同出），必须项超预算明确失败", () => {
  const messages = [
    userMsg("旧问题 " + "x".repeat(600)),
    assistantWithCall("c1", "bash"),
    toolResultMsg("c1", "旧结果 " + "y".repeat(600)),
    userMsg("当前任务"),
  ];
  const result = selectContext({
    messages,
    systemPrompt: "sys",
    tools: [],
    memories: [],
    budget: budgetConfig(),
  });
  assert.equal(result.ok, true);
  const roles = result.messages.map((m: any) => m.role);
  // 旧交互整体被排除或整体保留，不得出现 toolResult 单独存在
  const toolResultIdx = roles.indexOf("toolResult");
  if (toolResultIdx !== -1) {
    assert.equal(roles[toolResultIdx - 1], "assistant");
  }
  // 当前任务（最后一条 user）必须在
  assert.equal((result.messages.at(-1) as any).role, "user");

  // 必须项本身超预算：明确失败而不是静默截断
  const huge = selectContext({
    messages: [userMsg("z".repeat(100_000))],
    systemPrompt: "sys",
    tools: [],
    memories: [],
    budget: budgetConfig(),
  });
  assert.equal(huge.ok, false);
  assert.match(huge.failure ?? "", /预算/);
});

test("选择器：超长工具结果在模型视图中截断，含可读引用，排除记录不携带正文", () => {
  const long = "A".repeat(3000) + "中".repeat(2000) + "Z".repeat(3000);
  const result = selectContext({
    messages: [userMsg("任务"), assistantWithCall("c1", "bash"), toolResultMsg("c1", long)],
    systemPrompt: "sys",
    tools: [],
    memories: [],
    budget: budgetConfig({ contextWindow: 200_000 }),
  });
  assert.equal(result.ok, true);
  const tr = result.messages.find((m: any) => m.role === "toolResult") as any;
  const text = tr.content[0].text as string;
  assert.ok(text.length < long.length);
  assert.match(text, /省略|history_read|read_artifact/);
  assert.ok(text.startsWith("A".repeat(100)));
  assert.ok(text.endsWith("Z".repeat(100)));
});

// ---------- §5 记忆 ----------

test("记忆：创建/修订/并发冲突/撤销/恢复，旧版本可查", async () => {
  const { dirs, db, store } = await makeDbStore("memory");
  try {
    const memories = new MemoryStore(db);
    const pa = store.createProject("A");

    const m = memories.create({
      projectId: pa.id,
      category: "convention",
      content: "提交信息用中文",
      sourceRefs: [{ kind: "owner_note", note: "拥有者约定" }],
      author: "owner",
    });
    assert.equal(m.currentVersion, 1);

    const v2 = memories.revise({
      memoryId: m.id,
      expectedVersion: 1,
      content: "提交信息用中文，结尾不加句号",
      sourceRefs: [{ kind: "owner_note", note: "更新" }],
      author: "owner",
    });
    assert.equal(v2.currentVersion, 2);

    // 并发冲突：过期版本号明确拒绝，不覆盖
    assert.throws(
      () =>
        memories.revise({
          memoryId: m.id,
          expectedVersion: 1,
          content: "并发写",
          sourceRefs: [{ kind: "owner_note", note: "x" }],
          author: "owner",
        }),
      MemoryConflictError,
    );
    assert.equal(memories.getCurrent(m.id)!.content, "提交信息用中文，结尾不加句号");

    memories.revoke({ memoryId: m.id, expectedVersion: 2, author: "owner" });
    assert.equal(memories.listActiveFor(pa.id).length, 0);

    const restored = memories.restore({ memoryId: m.id, fromVersion: 1, author: "owner" });
    assert.equal(restored.status, "active");
    assert.equal(restored.content, "提交信息用中文");
    assert.equal(restored.currentVersion, 3);
    assert.equal(memories.listVersions(m.id).length, 3);
  } finally {
    db.close();
    await cleanupDirs(dirs);
  }
});

test("记忆：类别/来源/大小校验；个人共享对所有项目可见", async () => {
  const { dirs, db, store } = await makeDbStore("memory-val");
  try {
    const memories = new MemoryStore(db);
    const pa = store.createProject("A");
    const pb = store.createProject("B");

    assert.throws(
      () =>
        memories.create({
          projectId: pa.id,
          category: "secret" as any,
          content: "x",
          sourceRefs: [{ kind: "owner_note", note: "x" }],
          author: "owner",
        }),
      MemoryValidationError,
    );
    assert.throws(
      () =>
        memories.create({ projectId: pa.id, category: "preference", content: "x", sourceRefs: [], author: "owner" }),
      MemoryValidationError,
    );
    assert.throws(
      () =>
        memories.create({
          projectId: pa.id,
          category: "preference",
          content: "x".repeat(40 * 1024),
          sourceRefs: [{ kind: "owner_note", note: "x" }],
          author: "owner",
        }),
      MemoryValidationError,
    );

    memories.create({
      projectId: null,
      category: "preference",
      content: "回答用中文",
      sourceRefs: [{ kind: "owner_note", note: "个人偏好" }],
      author: "owner",
    });
    assert.equal(memories.listActiveFor(pa.id).length, 1);
    assert.equal(memories.listActiveFor(pb.id).length, 1);
  } finally {
    db.close();
    await cleanupDirs(dirs);
  }
});

// ---------- 集成：长会话 + 配对 + 选择记录 ----------

test("集成：多工具轮次后早期消息离开上下文，配对保持有效，选择记录落库且 usage 回填", async () => {
  // 小窗口强制早期消息退出上下文
  const t = await startTestRuntime(
    "ctx-long",
    routeResponder([
      {
        match: /step0/,
        respond: (req) => {
          if (JSON.stringify(req.messages).includes("delayed:")) {
            return { kind: "text" as const, text: "完成" };
          }
          return { kind: "tool_calls" as const, calls: [{ id: "call_a", name: "mock_delay", arguments: { ms: 5 } }] };
        },
      },
    ]),
    {
      contextWindow: 12_000,
      config: {
        budgetOverrides: { toolResultReserve: 500, safetyMargin: 200, memoryBudget: 0 },
      },
    },
  );
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    void projectId;
    const task = (await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "r-long",
      input: "step0 开始",
    })) as any;
    await waitFor("任务完成", async () => {
      const s = await taskStatus(t.client, task.id);
      return s.task.status === "completed";
    });

    // 每次模型调用都有选择记录，usage 已回填
    const records = (await t.client.request<any>("list_selection_records", { task_id: task.id })) as any;
    assert.ok(records.records.length >= 1, "至少一条选择记录");
    for (const rec of records.records) {
      assert.equal(rec.strategy, "deterministic-v1");
      assert.ok(rec.budget > 0);
      assert.ok(rec.usage !== null, "usage 应回填");
    }

    // 发送到模型的消息里 toolCall/toolResult 配对完整
    for (const call of t.server.calls) {
      const ids = new Set<string>();
      for (const m of call.messages) {
        if (m.role === "assistant" && Array.isArray((m as any).tool_calls)) {
          for (const tc of (m as any).tool_calls) ids.add(tc.id);
        }
        if (m.role === "tool") {
          assert.ok(ids.has((m as any).tool_call_id), `toolResult ${(m as any).tool_call_id} 缺少配对 toolCall`);
        }
      }
    }
  } finally {
    await t.shutdown();
  }
});

test("集成：必须项超过预算 → 零 provider 请求、任务 interrupted、队列暂停", async () => {
  const t = await startTestRuntime("ctx-overflow", routeResponder([]), {
    contextWindow: 12_000,
    config: { budgetOverrides: { toolResultReserve: 500, safetyMargin: 200, memoryBudget: 0 } },
  });
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const task = (await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "r-huge",
      input: "x".repeat(50_000),
    })) as any;
    await waitFor("任务 interrupted", async () => {
      const s = await taskStatus(t.client, task.id);
      return s.task.status === "interrupted";
    });
    assert.equal(t.server.calls.length, 0, "预算不足时不得发出 provider 请求");
    const detail = await taskStatus(t.client, task.id);
    assert.match(detail.task.interruptReason ?? "", /context_budget_exceeded/);
    const queue = await t.client.request<any>("read_history", { session_id: sessionId, limit: 1 }).catch(() => null);
    void queue;
    // 队列已暂停：后续任务保持 queued
    const task2 = (await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "r-after",
      input: "后续",
    })) as any;
    await new Promise((r) => setTimeout(r, 300));
    const s2 = await taskStatus(t.client, task2.id);
    assert.equal(s2.task.status, "queued");
    await t.client.request("resume_queue", { session_id: sessionId });
  } finally {
    await t.shutdown();
  }
});

// ---------- 集成：跨项目授权与代理宿主工具 ----------

test("集成：无授权时代理 history_search 看不到他项目内容；授权后可读；撤销后恢复拒绝", async () => {
  const t = await startTestRuntime(
    "xproj",
    routeResponder([
      {
        match: /查找暗号|再查暗号|三查暗号/,
        respond: (req) => {
          // 该轮工具结果已返回则停止：messages 里最后一个 tool 角色消息
          // 出现在最后一个 user 消息之后（历史中的旧结果不算）。
          const msgs = req.messages as any[];
          let lastUser = -1;
          let lastTool = -1;
          msgs.forEach((m, i) => {
            if (m.role === "user") lastUser = i;
            if (m.role === "tool") lastTool = i;
          });
          if (lastTool > lastUser) {
            return { kind: "text" as const, text: "搜索完成" };
          }
          // role=user：B 的暗号原文是 user 消息；排除 A 自己的 toolResult 条目，
          // 否则授权阶段返回给 A 的片段进入 A 的历史后会被本搜索合法命中
          // （撤销不承诺撤回已发送给模型的内容），使撤销后断言依赖落盘时序。
          return {
            kind: "tool_calls" as const,
            calls: [{ id: "hs1", name: "history_search", arguments: { query: "暗号", role: "user" } }],
          };
        },
      },
    ]),
  );
  try {
    const a = await createProjectSession(t.client, t.work[0]!, { projectName: "proj-A" });
    const b = await createProjectSession(t.client, t.work[1]!, { projectName: "proj-B" });

    // 项目 B 的会话里留下"暗号"
    const taskB = (await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: b.sessionId,
      request_id: "rB",
      input: "记住暗号：蓝色灯塔",
    })) as any;
    await waitFor("B 完成", async () => (await taskStatus(t.client, taskB.id)).task.status === "completed");

    // 项目 A 的代理搜索"暗号"：无授权 → 结果不含 B 的内容
    const taskA1 = (await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: a.sessionId,
      request_id: "rA1",
      input: "查找暗号",
    })) as any;
    await waitFor("A1 完成", async () => {
      const s = await taskStatus(t.client, taskA1.id);
      return s.task.status === "completed" || s.task.status === "failed";
    });
    const ops1 = (await taskStatus(t.client, taskA1.id)).toolOps as any[];
    const searchOp1 = ops1.find((o) => o.toolName === "history_search");
    assert.ok(searchOp1, "应记录 history_search 工具操作");
    // 结果摘要按 300 字符截断：以模型实际收到的工具结果为准（不含 B 的内容）
    const a1ToolResults = t.server.calls.flatMap((c) => c.messages).filter((m: any) => m.role === "tool");
    assert.ok(a1ToolResults.length > 0, "模型应收到工具结果");
    assert.ok(
      !a1ToolResults.some((m: any) => JSON.stringify(m).includes("蓝色灯塔")),
      "无授权时不得看到他项目内容（含计数/片段）",
    );

    // 拥有者授权 B.history → A
    const grant = (await t.client.request<any>("create_data_grant", {
      from_project_id: b.projectId,
      to_project_id: a.projectId,
      category: "history",
    })) as any;

    const callCountBeforeA2 = t.server.calls.length;
    const taskA2 = (await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: a.sessionId,
      request_id: "rA2",
      input: "再查暗号",
    })) as any;
    await waitFor("A2 完成", async () => (await taskStatus(t.client, taskA2.id)).task.status === "completed");
    const ops2 = (await taskStatus(t.client, taskA2.id)).toolOps as any[];
    assert.ok(ops2.some((o) => o.toolName === "history_search"), "A2 应记录 history_search 操作");
    const a2Calls = t.server.calls.slice(callCountBeforeA2);
    const a2ToolResults = a2Calls.flatMap((c) => c.messages).filter((m: any) => m.role === "tool");
    assert.ok(
      a2ToolResults.some((m: any) => JSON.stringify(m).includes("蓝色灯塔")),
      "授权后应能搜到 B 的内容",
    );

    // 撤销后再搜：恢复不可见
    await t.client.request("revoke_data_grant", { grant_id: grant.id });
    const callCountBeforeA3 = t.server.calls.length;
    const taskA3 = (await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: a.sessionId,
      request_id: "rA3",
      input: "三查暗号",
    })) as any;
    await waitFor("A3 完成", async () => (await taskStatus(t.client, taskA3.id)).task.status === "completed");
    // 撤销后的新搜索结果不得再含 B 的内容（A2 的旧结果留在 A 自己的历史里是合法的）
    const a3Calls = t.server.calls.slice(callCountBeforeA3);
    const a3NewResults: any[] = [];
    for (const call of a3Calls) {
      const msgs = call.messages as any[];
      let lastUser = -1;
      msgs.forEach((m, i) => {
        if (m.role === "user") lastUser = i;
      });
      for (let i = lastUser + 1; i < msgs.length; i++) {
        if (msgs[i]!.role === "tool") a3NewResults.push(msgs[i]);
      }
    }
    assert.ok(
      !a3NewResults.some((m: any) => JSON.stringify(m).includes("蓝色灯塔")),
      "撤销后新搜索不得再看到他项目内容",
    );
  } finally {
    await t.shutdown();
  }
});

test("集成：代理 memory_save 写本项目记忆并在后续注入；个人共享写入被拒绝", async () => {
  const t = await startTestRuntime(
    "mem-agent",
    routeResponder([
      {
        match: /记住偏好/,
        respond: (req) => {
          const msgs = req.messages as any[];
          let lastUser = -1;
          let lastTool = -1;
          msgs.forEach((m, i) => {
            if (m.role === "user") lastUser = i;
            if (m.role === "tool") lastTool = i;
          });
          if (lastTool > lastUser) {
            return { kind: "text" as const, text: "已处理" };
          }
          return {
            kind: "tool_calls" as const,
            calls: [
              {
                id: "ms1",
                name: "memory_save",
                arguments: {
                  category: "preference",
                  content: "用户偏好简洁回答",
                  source_refs: [{ kind: "history_entry", session_id: "self", entry_id: "placeholder" }],
                },
              },
            ],
          };
        },
      },
    ]),
  );
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);
    const task = (await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "r-mem",
      input: "记住偏好",
    })) as any;
    await waitFor("完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed");

    const ops = (await taskStatus(t.client, task.id)).toolOps as any[];
    const saveOp = ops.find((o) => o.toolName === "memory_save");
    assert.ok(saveOp, "应记录 memory_save 操作");
    // 来源 entryId 是伪造的：必须被拒绝（来源必须存在且可访问）
    assert.equal(saveOp.isError, true, "伪造来源的 memory_save 必须失败");

    // 拥有者创建一条项目记忆，下个任务注入到上下文
    const session = await t.client.request<any>("get_task", { task_id: task.id });
    void session;
    await t.client.request("save_memory", {
      project_id: projectId,
      category: "convention",
      content: "本项目测试用 node:test",
      source_refs: [{ kind: "owner_note", note: "约定" }],
    });
    const task2 = (await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "r-mem2",
      input: "写个测试",
    })) as any;
    await waitFor("完成2", async () => (await taskStatus(t.client, task2.id)).task.status === "completed");
    const lastCall = t.server.calls.at(-1)!;
    const injected = JSON.stringify(lastCall.messages);
    assert.ok(injected.includes("本项目测试用 node:test"), "记忆应注入模型视图");
  } finally {
    await t.shutdown();
  }
});

// ---------- §3 选择器：工具循环修剪与前缀注入 ----------

function mkUser(text: string) {
  return { role: "user", content: text, timestamp: 1 };
}
function mkAssistantCall(id: string) {
  return { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command: "x" } }], timestamp: 1 };
}
function mkToolResult(id: string, text: string) {
  return { role: "toolResult", toolCallId: id, content: [{ type: "text", text }], timestamp: 1 };
}

function testBudget(contextWindow: number): SelectorBudgetConfig {
  return validateBudgetConfig({
    contextWindow,
    maxTokens: 100,
    thinkingBudget: 0,
    toolResultReserve: 0,
    safetyMargin: 0,
    calibration: 1,
    memoryBudget: 0,
    toolResultViewChars: 100_000,
  });
}

test("选择器：当前任务工具循环按批次修剪（任务输入与最新批次必留，配对完整）", () => {
  // 当前任务组：user + 4 个已完成批次（assistant 调用 + toolResult）
  const messages = [
    mkUser("当前任务：修复构建"),
    mkAssistantCall("c1"),
    mkToolResult("c1", `批次一${"甲".repeat(800)}`),
    mkAssistantCall("c2"),
    mkToolResult("c2", `批次二${"乙".repeat(800)}`),
    mkAssistantCall("c3"),
    mkToolResult("c3", `批次三${"丙".repeat(800)}`),
    mkAssistantCall("c4"),
    mkToolResult("c4", `批次四${"丁".repeat(800)}`),
  ];
  const batchTokens = (callId: string) => {
    const ai = messages.findIndex((m) => m.role === "assistant" && (m.content as any[])[0].id === callId);
    return estimateMessageTokens(messages[ai], 1) + estimateMessageTokens(messages[ai + 1], 1);
  };
  // 先用大窗口拿到固定开销（系统提示/工具定义）
  const wide = selectContext({ messages, systemPrompt: "", tools: [], memories: [], budget: testBudget(1_000_000) });
  assert.ok(wide.ok);
  const fixed = wide.estimates.systemPrompt + wide.estimates.toolSchemas;
  const mandatory = estimateMessageTokens(messages[0], 1) + batchTokens("c4");
  // 预算恰好再容纳批次三：批次一/二应被修剪
  const budget = fixed + mandatory + batchTokens("c3");
  const out = selectContext({
    messages,
    systemPrompt: "",
    tools: [],
    memories: [],
    budget: testBudget(budget + 100),
  });
  assert.ok(out.ok, `选择应成功：${out.failure ?? ""}`);
  const includedTexts = out.messages.map((m) => JSON.stringify(m));
  assert.ok(includedTexts.some((s) => s.includes("当前任务：修复构建")), "任务输入必留");
  assert.ok(includedTexts.some((s) => s.includes("批次四")), "最新工具批次必留");
  assert.ok(includedTexts.some((s) => s.includes("批次三")), "预算内的较近批次应保留");
  assert.ok(!includedTexts.some((s) => s.includes("批次一")), "较早批次应被修剪");
  assert.ok(!includedTexts.some((s) => s.includes("批次二")), "较早批次应被修剪");
  // 配对完整：视图内每个 toolCall 都有对应 toolResult
  const viewCallIds = new Set<string>();
  const viewResultIds = new Set<string>();
  for (const m of out.messages) {
    if (m.role === "assistant") for (const p of m.content) if (p.type === "toolCall") viewCallIds.add(p.id);
    if (m.role === "toolResult") viewResultIds.add(m.toolCallId);
  }
  assert.deepEqual([...viewResultIds].filter((id) => !viewCallIds.has(id)), []);
  assert.deepEqual([...viewCallIds].filter((id) => !viewResultIds.has(id)), []);
  // 排除原因记录为 budget
  assert.ok(out.excluded.some((e) => e.reason === "budget"));

  // 连任务输入 + 最新批次都装不下 → 明确失败（不静默丢批次）
  const failing = selectContext({
    messages,
    systemPrompt: "",
    tools: [],
    memories: [],
    budget: testBudget(fixed + mandatory - 1 + 100),
  });
  assert.equal(failing.ok, false);
  assert.match(failing.failure ?? "", /必留内容/);
});

test("选择器：项目指令与继续来源作为必留前缀注入一次，预排除记忆原样记录", () => {
  const messages = [mkUser("当前任务")];
  const out = selectContext({
    messages,
    systemPrompt: "sys",
    tools: [],
    projectInstructions: { text: "项目约定：提交信息用中文", version: "sha256:abc;artifact:art_1", problems: ["项目指令文件 missing.md：缺失"] },
    resumedFrom: { taskId: "task_old", input: "原始要求：给登录页加验证码" },
    memories: [],
    preExcludedMemories: [{ memoryId: "mem_x", version: 2, reason: "source_scope_revoked" }],
    budget: testBudget(100_000),
  });
  assert.ok(out.ok);
  const texts = out.messages.map((m) => (typeof m.content === "string" ? m.content : ""));
  assert.equal(texts.filter((s) => s.includes("项目约定：提交信息用中文")).length, 1, "项目指令只注入一次");
  assert.ok(texts[0]!.includes("[项目指令 · 版本 sha256:abc;artifact:art_1"), "指令带来源版本标记");
  assert.ok(texts[0]!.includes("missing.md：缺失"), "缺失问题明确说明");
  assert.ok(texts[1]!.includes("继续来源：本任务继续已中断任务 task_old"), "继续来源标记");
  assert.ok(texts[1]!.includes("原始要求：给登录页加验证码"), "原任务要求注入");
  assert.equal(out.instructionVersion, "sha256:abc;artifact:art_1");
  assert.deepEqual(out.excludedMemories, [{ memoryId: "mem_x", version: 2, reason: "source_scope_revoked" }]);

  // 前缀是必留项：预算被历史占满时前缀仍在，历史被排除
  const bigHistory = [mkUser(`旧轮次${"历".repeat(60_000)}`), mkAssistantCall("old1"), mkToolResult("old1", "旧结果"), mkUser("当前任务")];
  const out2 = selectContext({
    messages: bigHistory,
    systemPrompt: "sys",
    tools: [],
    projectInstructions: { text: "项目约定", version: "v1", problems: [] },
    resumedFrom: null,
    memories: [],
    budget: testBudget(20_000),
  });
  assert.ok(out2.ok);
  const texts2 = out2.messages.map((m) => String(m.content));
  assert.ok(texts2.some((s) => s.includes("[项目指令")), "预算紧张时项目指令仍必留");
  assert.ok(!texts2.some((s) => s.includes("旧轮次")), "旧交互让位");
});

// ---------- §2 历史索引：按任务过滤 ----------

test("历史检索：按任务过滤（标记范围；无结束标记延伸到文件尾）", async () => {
  const { dirs, db } = await makeDbStore("hist-task");
  try {
    const file = path.join(dirs.root, "s1.jsonl");
    const marker = (id: string, customType: string, taskId: string) => ({
      type: "custom",
      id,
      customType,
      data: { taskId },
      timestamp: "2026-09-20T00:00:00Z",
    });
    writeJsonl(file, [
      marker("m1", "ruukoto_task_start", "task_1"),
      messageEntry("e1", null, "user", "任务一的苹果"),
      marker("m2", "ruukoto_task_end", "task_1"),
      marker("m3", "ruukoto_task_start", "task_2"),
      messageEntry("e2", null, "user", "任务二的苹果"),
      // task_2 没有结束标记（崩溃）：范围延伸到文件尾
      messageEntry("e3", null, "assistant", "任务二收尾的苹果"),
    ]);
    const index = new HistoryIndex(db);
    index.sync("s1", file);

    const all = searchHistory(db, [{ sessionId: "s1", filePath: file }], { query: "苹果" });
    assert.equal(all.hits.length, 3);
    const t1 = searchHistory(db, [{ sessionId: "s1", filePath: file }], { query: "苹果", taskId: "task_1" });
    assert.deepEqual(t1.hits.map((h) => h.entryId), ["e1"]);
    const t2 = searchHistory(db, [{ sessionId: "s1", filePath: file }], { query: "苹果", taskId: "task_2" });
    assert.deepEqual(t2.hits.map((h) => h.entryId), ["e2", "e3"], "无结束标记时延伸到文件尾");
    const none = searchHistory(db, [{ sessionId: "s1", filePath: file }], { query: "苹果", taskId: "task_nope" });
    assert.equal(none.hits.length, 0);
  } finally {
    db.close();
    await cleanupDirs(dirs);
  }
});

// ---------- 集成：项目指令钉版注入 ----------

test("集成：项目指令任务开始时钉版注入一次，内容捕获为产物，缺失明确说明", async () => {
  const t = await startTestRuntime("instr", routeResponder([]));
  try {
    fs.writeFileSync(path.join(t.work[0]!, "TEAM.md"), "项目约定：提交信息用中文");
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!);

    // 路径逃逸在配置时即被拒绝
    await assert.rejects(
      t.client.request("set_project_instructions", { project_id: projectId, files: ["../escape.md"] }),
      /相对路径/,
    );

    await t.client.request("set_project_instructions", { project_id: projectId, files: ["TEAM.md", "缺失.md"] });
    const task = (await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "r-instr",
      input: "你好",
    })) as any;
    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed");

    assert.ok(t.server.calls.length >= 1, "应发出 provider 请求");
    for (const call of t.server.calls) {
      const texts = (call.messages as any[]).map((m) => JSON.stringify(m));
      assert.equal(
        texts.filter((s) => s.includes("项目约定：提交信息用中文")).length,
        1,
        "项目指令在每次调用中只注入一次",
      );
      assert.ok(texts.some((s) => s.includes("[项目指令") && s.includes("缺失.md：缺失")), "缺失文件明确说明");
    }

    // 选择记录含指令来源版本；内容可追溯至捕获产物
    const records = (await t.client.request<any>("list_selection_records", { task_id: task.id })) as any;
    assert.ok(records.records.length >= 1);
    const version = records.records[0].instructionVersion as string;
    assert.match(version, /^sha256:[0-9a-f]{16};artifact:art_/, "指令版本 = 内容哈希 + 产物 id");
    const artifactId = version.split(";artifact:")[1]!;
    const artifact = (await t.client.request<any>("read_artifact", { task_id: task.id, artifact_id: artifactId })) as any;
    const content = Buffer.from(artifact.data, "base64").toString("utf8");
    assert.ok(content.includes("项目约定：提交信息用中文"), "产物保存任务实际使用的指令内容");
  } finally {
    await t.shutdown();
  }
});

// ---------- 集成：继续任务保留原任务要求 ----------

test("集成：继续已中断任务时原任务要求作为必留参考注入", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const t = await startTestRuntime(
    "resume-link",
    routeResponder([
      { match: /原始要求/, respond: async () => { await gate; return { kind: "text" as const, text: "不应到达" }; } },
      { match: /继续/, respond: () => ({ kind: "text" as const, text: "继续完成" }) },
    ]),
  );
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const task1 = (await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "r-orig",
      input: "原始要求：给登录页加验证码",
    })) as any;
    await waitFor("任务运行中", async () => (await taskStatus(t.client, task1.id)).task.status === "running");
    await t.client.request("interrupt", { task_id: task1.id });
    await waitFor("任务中断", async () => (await taskStatus(t.client, task1.id)).task.status === "interrupted");
    release();

    const callsBefore = t.server.calls.length;
    const task2 = (await t.client.request<any>("continue", { session_id: sessionId, model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      task_id: task1.id,
      request_id: "r-cont",
      input: "继续",
    })) as any;
    await waitFor("继续任务完成", async () => (await taskStatus(t.client, task2.id)).task.status === "completed");

    const newCalls = t.server.calls.slice(callsBefore);
    assert.ok(newCalls.length >= 1, "继续任务应发出 provider 请求");
    const texts = newCalls.flatMap((c) => (c.messages as any[]).map((m) => JSON.stringify(m)));
    assert.ok(
      texts.some((s) => s.includes(`[继续来源：本任务继续已中断任务 ${task1.id}`) && s.includes("原始要求：给登录页加验证码")),
      "继续任务应注入带来源关联的原任务要求",
    );
  } finally {
    release();
    await t.shutdown();
  }
});

// ---------- 集成：派生记忆来源范围重校 ----------

test("集成：授权撤销后引用受限来源的记忆不再注入，memory_read 拒绝", async () => {
  const shared = { sessionId: "", entryId: "", memoryId: "" };
  const t = await startTestRuntime(
    "mem-src",
    routeResponder([
      {
        match: /记暗号/,
        respond: () => ({ kind: "text" as const, text: "好" }),
      },
      {
        match: /存记忆/,
        respond: (req) => {
          const msgs = req.messages as any[];
          let lastUser = -1;
          let lastTool = -1;
          msgs.forEach((m, i) => {
            if (m.role === "user") lastUser = i;
            if (m.role === "tool") lastTool = i;
          });
          if (lastTool > lastUser) return { kind: "text" as const, text: "已存" };
          return {
            kind: "tool_calls" as const,
            calls: [
              {
                id: "ms1",
                name: "memory_save",
                arguments: {
                  category: "experience",
                  content: "B 项目的暗号是蓝色灯塔（派生自 B 历史）",
                  source_refs: [{ kind: "history_entry", session_id: shared.sessionId, entry_id: shared.entryId }],
                  reason: "跨项目授权下学到",
                },
              },
            ],
          };
        },
      },
      {
        match: /读记忆/,
        respond: (req) => {
          const msgs = req.messages as any[];
          let lastUser = -1;
          let lastTool = -1;
          msgs.forEach((m, i) => {
            if (m.role === "user") lastUser = i;
            if (m.role === "tool") lastTool = i;
          });
          if (lastTool > lastUser) return { kind: "text" as const, text: "读完" };
          return {
            kind: "tool_calls" as const,
            calls: [{ id: "mr1", name: "memory_read", arguments: { memory_id: shared.memoryId } }],
          };
        },
      },
    ]),
  );
  try {
    const a = await createProjectSession(t.client, t.work[0]!, { projectName: "memA" });
    const b = await createProjectSession(t.client, t.work[1]!, { projectName: "memB" });

    const taskB = (await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: b.sessionId,
      request_id: "r-mb",
      input: "记暗号：蓝色灯塔",
    })) as any;
    await waitFor("B 完成", async () => (await taskStatus(t.client, taskB.id)).task.status === "completed");

    // 拥有者查到 B 的条目 id（作为测试构造数据）
    const found = (await t.client.request<any>("search_history", { query: "蓝色灯塔", project_id: b.projectId })) as any;
    assert.equal(found.hits.length, 1);
    shared.sessionId = b.sessionId;
    shared.entryId = found.hits[0].entryId;

    // 授权 B.history → A；A 的代理存一条引用 B 条目的记忆
    const grant = (await t.client.request<any>("create_data_grant", {
      from_project_id: b.projectId,
      to_project_id: a.projectId,
      category: "history",
    })) as any;
    const taskA1 = (await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: a.sessionId,
      request_id: "r-ma1",
      input: "存记忆",
    })) as any;
    await waitFor("A1 完成", async () => (await taskStatus(t.client, taskA1.id)).task.status === "completed");
    const memories = (await t.client.request<any>("list_memories", { project_id: a.projectId })) as any;
    assert.equal(memories.memories.length, 1, "记忆已创建");
    const memoryId = memories.memories[0].id as string;
    shared.memoryId = memoryId;

    // 撤销授权：后续任务不再注入该记忆；memory_read 拒绝
    await t.client.request("revoke_data_grant", { grant_id: grant.id });
    const callsBefore = t.server.calls.length;
    const taskA2 = (await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: a.sessionId,
      request_id: "r-ma2",
      input: "读记忆",
    })) as any;
    await waitFor("A2 完成", async () => {
      const s = await taskStatus(t.client, taskA2.id);
      return s.task.status === "completed" || s.task.status === "failed";
    });

    // 注入侧：选择记录中该记忆以 source_scope_revoked 排除；视图无 [长期记忆 前缀
    const records = (await t.client.request<any>("list_selection_records", { task_id: taskA2.id })) as any;
    assert.ok(records.records.length >= 1);
    assert.ok(
      records.records.every((r: any) =>
        r.includedMemories.every((m: any) => m.memoryId !== memoryId),
      ),
      "撤销后来源受限的记忆不得注入",
    );
    assert.ok(
      records.records.some((r: any) =>
        r.excludedMemories.some((m: any) => m.memoryId === memoryId && m.reason === "source_scope_revoked"),
      ),
      "排除原因应记为 source_scope_revoked",
    );
    const a2Texts = t.server.calls
      .slice(callsBefore)
      .flatMap((c) => (c.messages as any[]).map((m) => JSON.stringify(m)));
    assert.ok(!a2Texts.some((s) => s.includes("[长期记忆")), "撤销后不再有记忆前缀注入");

    // 读取侧：memory_read 明确拒绝
    const a2ToolResults = t.server.calls
      .slice(callsBefore)
      .flatMap((c) => (c.messages as any[]))
      .filter((m) => m.role === "tool");
    assert.ok(
      a2ToolResults.some((m) => JSON.stringify(m).includes("来源范围已撤销")),
      "memory_read 应因来源范围撤销而拒绝",
    );
  } finally {
    await t.shutdown();
  }
});

// ---------- §6 迁移：v2 → v3 ----------

test("迁移：v2 库升级到 v3 补列建表，既有数据保留", async () => {
  const { dirs } = await makeTestDirs("migrate-v2", 0);
  const dbFile = path.join(dirs.dataDir, "ruukoto.db");
  fs.mkdirSync(dirs.dataDir, { recursive: true });
  // 手工构造 v2 形状的库：projects 无 instruction_files，无 issue 05 新表
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(dbFile);
  raw.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    INSERT INTO meta VALUES ('schema_version', '2');
    INSERT INTO projects VALUES ('proj_old', '旧项目', '2026-09-01T00:00:00Z');
  `);
  raw.close();
  try {
    const db = new Db(dirs.dataDir);
    const store = new Store(db);
    // 既有数据保留，新列有默认值
    const project = store.getProject("proj_old");
    assert.ok(project);
    assert.deepEqual(project.instructionFiles, []);
    // 新列可写
    store.setProjectInstructionFiles("proj_old", ["TEAM.md"]);
    assert.deepEqual(store.getProject("proj_old")!.instructionFiles, ["TEAM.md"]);
    // 新表已建且可用
    const access = new AccessScope(db);
    const pb = store.createProject("B");
    const grant = access.createGrant({ fromProjectId: pb.id, toProjectId: "proj_old", category: "history" });
    assert.ok(grant.id);
    assert.equal((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as any).value, "7");
    db.close();
  } finally {
    await cleanupDirs(dirs);
  }
});
