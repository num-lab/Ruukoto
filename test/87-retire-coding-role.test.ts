import { product as personalProduct } from "../apps/ruukoto/src/product.ts";
/**
 * 固定 coding 角色退役（agent-direction issue 23）。
 *
 * 旧数据按退役前的持久形态直接写入（coding 角色行、角色会话与委派子任务）：
 * - 全新实例不引导 coding；旧角色行保留为归档标识，角色会话拒绝新任务；
 * - 升级收尾：排队的旧子任务取消（coding_role_retired）、运行中的记结果未知、
 *   已完成未唤醒的补唤醒，各补记一次结果与 main 唤醒，子任务正文不重放给模型；
 *   重复重启不重复；
 * - coding_result 只读查阅旧子任务的结构化结果与产物，其他任务拒绝。
 */

import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import type { ModelSelection } from "@ruukoto/core/types.ts";
import { Runtime, type RuntimeConfig } from "@ruukoto/runtime/runtime.ts";
import { createMockTools } from "@ruukoto/agent/mock-tools.ts";
import { MockModelServer, type RecordedRequest } from "./helpers/mock-provider.ts";
import { cleanupDirs, lastUserText, makeTestDirs, startTestRuntime, waitFor, writeModelsJson } from "./helpers/testkit.ts";
import { completeCodingChild, seedCodingChild, seedCodingRole } from "./helpers/legacy-coding.ts";

const SELECTION: ModelSelection = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" };

test("升级收尾：在途旧 coding 子任务各补记一次结果与唤醒，不重放；角色会话拒绝新任务，重复重启不重复", async () => {
  const { dirs } = await makeTestDirs("retire-coding", 0);
  const server = new MockModelServer(async (req) => ({ kind: "text", text: `ok:${lastUserText(req).slice(0, 20)}` }));
  await writeModelsJson(dirs, await server.start());
  const config: RuntimeConfig = {
    product: personalProduct.runtime,
    dataDir: dirs.dataDir, agentDir: dirs.agentDir, socketPath: path.join(dirs.root, "c.sock"),
    thinkingLevel: "off", modelProvider: "mock", modelId: "mock-model", toolFactory: (ctx) => createMockTools(ctx),
  };
  let rt = await Runtime.start(config);
  try {
    assert.deepEqual(rt.store.listAgentRoles().map((r) => r.id), ["main"], "全新实例不引导 coding");
    const main = rt.store.getAgentRole("main")!;
    const parent = await rt.submit({ sessionId: main.sessionId, requestId: "p", input: "父任务", modelSelection: rt.defaultSelection });
    await waitFor("父任务完成", () => rt.store.getTask(parent.id)!.status === "completed");
    await rt.stop("test_upgrade");

    // 退役前的旧形态：coding 角色 + 排队/运行中/已完成未唤醒三个子任务
    const db = new Db(dirs.dataDir);
    const store = new Store(db);
    const coding = seedCodingRole(store, dirs.root);
    const parentTask = store.getTask(parent.id)!;
    const queued = seedCodingChild(store, coding.sessionId, { parent: parentTask, key: "q", mark: "LEGACY-QUEUED" });
    const running = seedCodingChild(store, coding.sessionId, { parent: parentTask, key: "r", mark: "LEGACY-RUNNING" });
    store.transitionTask(running.id, ["queued"], "running", { startedAt: new Date().toISOString() });
    const done = seedCodingChild(store, coding.sessionId, { parent: parentTask, key: "d", mark: "LEGACY-DONE" });
    const legacyRef = JSON.stringify({ sessionId: coding.sessionId, taskId: done.id, mode: "draft", outcome: "completed", tests: "passed", needsOwner: false, needsOwnerReason: null, effect: "none_unknown", failure: null, artifactIds: [] });
    completeCodingChild(store, done.id, "旧结论：草稿已生成", legacyRef);
    db.close();

    rt = await Runtime.start(config);
    const children = [queued, running, done];
    const wakes = () => rt.store.listTasksBySession(main.sessionId).filter((x) => children.some((c) => x.requestId === `wake:${c.id}`));
    await waitFor("三个唤醒完成", () => wakes().length === 3 && wakes().every((w) => w.status === "completed"));

    const q = rt.store.getTask(queued.id)!;
    assert.equal(q.status, "canceled");
    assert.match(q.errorMessage ?? "", /^coding_role_retired:/);
    assert.ok(q.resultSummary, "排队子任务补记结果");
    const r = rt.store.getTask(running.id)!;
    assert.equal(r.status, "interrupted");
    assert.match(r.resultSummary ?? "", /结果未知/);
    assert.equal(rt.store.getTask(done.id)!.resultRef, legacyRef, "旧结构化结果原样保留");
    assert.equal(JSON.parse(q.resultRef!).outcome, "failed", "补记结果写明 outcome（coding_result 可读）");
    assert.equal(JSON.parse(r.resultRef!).outcome, "unknown");
    for (const w of wakes()) assert.match(w.input, /coding_result/, "唤醒指向只读查阅入口");
    const prompts = (c: RecordedRequest) => JSON.stringify(c.messages);
    assert.ok(!server.calls.some((c) => /LEGACY-(QUEUED|RUNNING)/.test(lastUserText(c))), "旧子任务正文不重放给模型");
    assert.ok(server.calls.some((c) => prompts(c).includes(running.id)), "main 唤醒收到结果未知的子任务");

    // 旧角色行与项目保留为归档标识；角色会话拒绝新任务
    assert.deepEqual(rt.store.listAgentRoles().map((x) => x.id).sort(), ["coding", "main"]);
    assert.ok(rt.store.findProjectByName("agent-coding"));
    await assert.rejects(
      () => rt.submit({ sessionId: coding.sessionId, requestId: "new", input: "新任务", modelSelection: rt.defaultSelection }),
      /固定 coding 角色已退役/,
    );
    await rt.stop("test_restart");

    rt = await Runtime.start(config);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(wakes().length, 3, "重复重启不重复唤醒");
    assert.equal(rt.store.listTasksBySession(coding.sessionId).length, 3, "角色会话无新任务");
  } finally {
    await rt.stop("test_end").catch(() => {});
    await server.close();
    await cleanupDirs(dirs);
  }
});

test("coding_result 只读兼容：读旧子任务结构化结果与交付产物，UTF-8 分页不损坏；其他任务拒绝", async () => {
  const queries: Array<Record<string, unknown>> = [];
  let next = 0;
  const t = await startTestRuntime("retire-coding-read", async (req) => {
    if (lastUserText(req) !== "RESULT-CASES") return { kind: "text", text: "ok" };
    const params = queries[next++];
    return params ? { kind: "tool_calls", calls: [{ id: `r${next}`, name: "coding_result", arguments: params }] } : { kind: "text", text: "已读取" };
  });
  try {
    const rt = t.runtime;
    const main = rt.store.getAgentRole("main")!;
    const coding = seedCodingRole(rt.store, t.dirs.root);
    const parent = await rt.submit({ sessionId: main.sessionId, requestId: "p", input: "分析", modelSelection: rt.defaultSelection });
    await waitFor("父任务完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const child = seedCodingChild(rt.store, coding.sessionId, { parent, key: "a", mark: "旧草稿" });
    const deliverable = rt.artifacts.begin({ taskId: child.id, sessionId: coding.sessionId, name: "草稿" });
    const artifactText = "﻿" + "中".repeat(100) + "TAIL";
    rt.artifacts.append(deliverable.id, Buffer.from(artifactText));
    rt.artifacts.complete(deliverable.id);
    completeCodingChild(rt.store, child.id, "旧结论", JSON.stringify({
      sessionId: coding.sessionId, taskId: child.id, mode: "draft", outcome: "completed", tests: "passed",
      needsOwner: false, needsOwnerReason: null, effect: "none_unknown", failure: null, artifactIds: [deliverable.id],
    }));
    const settled = seedCodingChild(rt.store, coding.sessionId, { parent, key: "s", mark: "退役收尾" });
    rt.store.transitionTask(settled.id, ["queued"], "canceled", { errorMessage: "coding_role_retired:x", endedAt: new Date().toISOString() });
    rt.store.setTaskResult(settled.id, "子任务失败", JSON.stringify({ sessionId: coding.sessionId, taskId: settled.id, outcome: "failed" }));
    const alien = rt.store.insertQueuedTask({ sessionId: coding.sessionId, requestId: "alien", input: "其他任务", modelSelection: SELECTION, submissionDigest: "alien", agentId: "coding" }).task;
    queries.push(
      { task_id: child.id },
      { task_id: alien.id, part: "result" },
      { task_id: child.id, part: "artifact", artifact_id: deliverable.id, length: 256 },
      { task_id: child.id, part: "artifact", artifact_id: deliverable.id, offset: 255, length: 256 },
      { task_id: settled.id },
    );
    const read = await rt.submit({ sessionId: main.sessionId, requestId: "read", input: "RESULT-CASES", modelSelection: rt.defaultSelection });
    await waitFor("结果读取完成", () => rt.store.getTask(read.id)!.status === "completed");
    const returns = t.server.calls
      .filter((c) => lastUserText(c) === "RESULT-CASES" && c.messages[c.messages.length - 1]?.role === "tool")
      .map((c) => {
        const m = c.messages[c.messages.length - 1];
        return typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");
      });
    assert.match(returns[0]!, /模式 draft · 测试 passed/);
    assert.match(returns[0]!, new RegExp(deliverable.id));
    assert.match(returns[1]!, /只能读取本会话委派/);
    assert.match(returns[2]!, /继续用 offset=255/);
    assert.match(returns[3]!, /TAIL/);
    assert.match(returns[4]!, /结果：failed · 固定 coding 退役收尾补记/);
    assert.match(returns[4]!, /原因：coding_role_retired/);
    assert.equal(returns.slice(2, 4).map((r) => r.slice(r.indexOf("\n") + 1)).join(""), artifactText, "包括 BOM 在内的正文可完整拼接");
  } finally {
    await t.shutdown();
  }
});
