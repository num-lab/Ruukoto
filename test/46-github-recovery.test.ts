import { product as personalProduct } from "./helpers/legacy-product.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Runtime, type RuntimeConfig } from "@ruukoto/runtime/runtime.ts";
import { Db } from "@ruukoto/core/db.ts";
import { CredentialStore } from "@ruukoto/agent/execution/credentials.ts";
import { GitHubEvents, parseGitHubEventsConfig, webhookSecret } from "@ruukoto/channels/github/events.ts";
import type { GitHubPullRequestEvent } from "@ruukoto/channels/github/webhook.ts";
import type { NotifyTarget } from "@ruukoto/core/types.ts";
import { MockModelServer } from "./helpers/mock-provider.ts";
import { cleanupDirs, lastUserText, makeTestDirs, startTestRuntime, waitFor, writeModelsJson } from "./helpers/testkit.ts";

const target: NotifyTarget = { channel: "telegram", account: "test-bot", chatId: "owner", configVersion: 1 };
const REVIEW_HEADER = "[SubAgent 委派 · GitHub PR 评审]";

test("review 恢复：父任务/子任务提交窗口、模型变化、产物与摘要通知补记保持幂等（通用 SubAgent）", async (t) => {
  for (const window of ["parent_only", "child_committed"] as const) await t.test(window, async () => {
    const { dirs } = await makeTestDirs(`github-${window}`, 0);
    const server = new MockModelServer(async (req) => {
      const input = lastUserText(req);
      if (input.startsWith(REVIEW_HEADER)) return { kind: "text", text: "草稿：需核实资料。" };
      if (input.startsWith("[编排器] 子任务")) {
        const lastUser = req.messages.findLastIndex((m) => m.role === "user");
        const results = req.messages.slice(lastUser + 1).filter((m) => m.role === "tool");
        if (results.length === 0) {
          const workId = /用 subagent_result 按 work_id (\S+) 读取/.exec(input)![1];
          return { kind: "tool_calls", calls: [{ id: "result", name: "subagent_result", arguments: { work_id: workId } }] };
        }
      }
      return { kind: "text", text: "main 摘要" };
    });
    await writeModelsJson(dirs, await server.start());
    const credentials = new CredentialStore(dirs.agentDir);
    credentials.upsert({ name: "hook", host: "github.com", header: "x-hub-signature-256", purpose: "github_webhook", secret: "test-secret" });
    const config: RuntimeConfig = {
    product: personalProduct.runtime, dataDir: dirs.dataDir, agentDir: dirs.agentDir,
      modelProvider: "mock", modelId: "mock-model", thinkingLevel: "off", qqDisabled: true, telegramDisabled: true,
      githubWebhook: { port: 0, credential: "hook", repositoryIds: [42] },
      scheduler: { tickMs: 0, channel: { target: () => target, available: () => false, send: async () => { throw new Error("不应发送"); } } },
    };
    let rt = await Runtime.start(config);
    const roleDir = path.join(dirs.agentDir, "agents");
    fs.mkdirSync(roleDir);
    for (const role of ["general", "reviewer"]) fs.writeFileSync(path.join(roleDir, `${role}.md`), "---\ndescription: 用户角色覆盖\ntools: [bash]\n---\nUSER_ROLE_MUST_NOT_REPLACE_REVIEW");
    try {
      const main = rt.store.getAgentRole("main")!;
      rt.store.setSessionQueueState(main.sessionId, "paused", "backend_restart");
      const deliveryId = randomUUID();
      const payload: GitHubPullRequestEvent = { deliveryId, action: "opened", repository: { id: 42, owner: "owner", name: "repo", fullName: "owner/repo" }, number: 7,
        url: "https://github.com/owner/repo/pull/7", headSha: "a".repeat(40), baseSha: "b".repeat(40), headRef: "feature", baseRef: "main", sender: "contributor",
        title: "review", body: "", bodyTruncated: false, draft: false, state: "open", updatedAt: "2026-09-24T01:00:00Z" };
      const { event } = rt.store.withTx(() => rt.store.registerInboundEvent({ source: "github", externalId: deliveryId, actor: "contributor", targetRole: "main", body: JSON.stringify(payload), replyTarget: target }));
      // 提交窗口：新版评审子任务经 SubAgentManager 登记（回执在编排器侧丢失）
      const original = rt.subagents!.delegate.bind(rt.subagents);
      (rt.subagents as any).delegate = async (input: any) => {
        if (!input.hostReview) return original(input);
        if (window === "child_committed") await original(input);
        throw new Error("提交窗口断开");
      };
      await rt.orchestrator!.dispatchRegisteredEvents();
      const parent = rt.store.findTaskByRequest(main.sessionId, `evt:${event.id}:main`)!;
      assert.ok(parent);
      assert.equal(rt.store.getInboundEvent(event.id)!.status, "registered");
      assert.equal(rt.store.listSubAgents().length, window === "child_committed" ? 1 : 0);
      assert.equal(rt.store.getAgentRole("coding"), null, "无旧 coding 路径可降级（issue 23）");
      await rt.stop("test_restart");

      // 恢复时后台默认模型已变：原父任务的提交不能拿新模型形成幂等冲突。
      const file = path.join(dirs.agentDir, "models.json"), catalog = JSON.parse(fs.readFileSync(file, "utf8"));
      catalog.providers.mock.models.push({ ...catalog.providers.mock.models[0], id: "mock-v2", name: "Mock v2" });
      fs.writeFileSync(file, JSON.stringify(catalog));
      config.modelId = "mock-v2";
      rt = await Runtime.start(config);
      await waitFor("恢复后的摘要通知", () => rt.sched.findOpBySource("inbound_event", event.id) !== null);
      assert.equal(rt.store.listSubAgents().length, 1, "恢复重提命中首次登记，不再造 SubAgent");
      const work = rt.store.listWorkDelegations()[0]!;
      const child = rt.store.listTasksByWork(work.id)[0]!;
      const fixed = rt.store.getSubAgent(child.subAgentId!)!.definition!;
      assert.equal(fixed.kind, "host_review");
      assert.deepEqual(fixed.tools, ["read", "read_artifact"]);
      assert.ok(server.calls.filter(call => lastUserText(call).startsWith(REVIEW_HEADER)).every(call => !call.system?.includes("USER_ROLE_MUST_NOT_REPLACE_REVIEW")));
      const wake = rt.store.findTaskByRequest(main.sessionId, `wake:${child.id}`)!;
      assert.equal(child.parentTaskId, parent.id);
      assert.equal(child.sourceEventId, event.id);
      assert.equal(wake.sourceEventId, event.id);
      assert.equal(rt.store.getInboundEvent(event.id)!.status, "done");
      const result = JSON.parse(rt.store.getTask(child.id)!.resultRef!);
      assert.equal(result.review.headSha, payload.headSha);
      const artifactId = result.review.artifactId;
      assert.ok(rt.artifacts.read(artifactId).toString().includes("草稿：需核实资料。"));
      assert.equal(rt.store.findTaskByRequest(main.sessionId, `evt:${event.id}:main`)!.modelSelection!.modelId, "mock-model");
      const reviewCalls = server.calls.filter((call) => lastUserText(call).startsWith(REVIEW_HEADER)).length;
      assert.equal(reviewCalls, 1, "恢复不重跑 review");
      await rt.stop("test_restart");

      // 模拟评审已定稿、结果事务尚未提交；main 摘要已终态、outbox 尚未登记。
      const db = new Db(dirs.dataDir);
      db.prepare("UPDATE tasks SET result_summary = NULL, result_ref = NULL WHERE id IN (?, ?)").run(child.id, wake.id);
      db.prepare("DELETE FROM notification_ops WHERE source_kind = 'inbound_event' AND source_key = ?").run(event.id);
      db.close();
      for (let restart = 0; restart < 2; restart++) {
        rt = await Runtime.start(config);
        const restored = JSON.parse(rt.store.getTask(child.id)!.resultRef!);
        assert.equal(restored.review.artifactId, artifactId, "复用已定稿产物，不重复写报告");
        assert.equal(rt.store.listArtifactsByTask(child.id).filter((a) => a.name.startsWith("review-draft:")).length, 1);
        assert.equal(rt.store.listSubAgents().length, 1);
        assert.equal(rt.store.listTasksBySession(main.sessionId).length, 2);
        assert.equal(rt.sched.listOps({}).items.length, 1);
        assert.equal(rt.sched.findOpBySource("inbound_event", event.id)!.status, "pending");
        await rt.stop("test_restart");
      }
      assert.equal(server.calls.filter((call) => lastUserText(call).startsWith(REVIEW_HEADER)).length, 1, "补记窗口不再调用模型评审");
    } finally {
      await rt.stop("test_end"); await server.close(); await cleanupDirs(dirs);
    }
  });
});

test("webhook 可信配置与凭据范围：秘密不与 HTTP/MCP 凭据共用，轮换不能绕过用途", async () => {
  const { dirs } = await makeTestDirs("github-secret", 0);
  try {
    const credentials = new CredentialStore(dirs.agentDir);
    const config = parseGitHubEventsConfig({ port: 0, credential: "hook", repositoryIds: [42, 42] });
    assert.deepEqual(config.repositoryIds, [42]);
    assert.equal(config.notifyChannel, "telegram");
    for (const bad of [{}, { ...config, repositoryIds: [] }, { ...config, port: -1 }, { ...config, notifyChannel: "attacker" }]) assert.throws(() => parseGitHubEventsConfig(bad));
    const binding = { name: "hook", host: "github.com", header: "x-hub-signature-256", purpose: "github_webhook", secret: "not-in-context" };
    credentials.upsert(binding);
    assert.equal(webhookSecret(credentials, config, true), binding.secret);
    assert.equal(credentials.getForUse("hook"), null, "通用 HTTP 不得使用秘密");
    assert.equal(credentials.getForUse("hook", { operation: "mcp" }), null);
    credentials.upsert({ ...credentials.get("hook")!, secret: "rotated" });
    assert.equal(webhookSecret(credentials, config), "rotated");
    credentials.upsert({ ...credentials.get("hook")!, purpose: "mcp" });
    assert.throws(() => webhookSecret(credentials, config), /独立/);
  } finally { await cleanupDirs(dirs); }
});

test("报告归档：历史在第二页读取失败不得标为完整产物，需拥有者核实（SubAgent 评审同走路径）", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const t = await startTestRuntime("github-partial", async (req) => {
    if (lastUserText(req).startsWith(REVIEW_HEADER)) await gate;
    return { kind: "text", text: "reply" };
  });
  try {
    const rt = t.runtime, main = rt.store.getAgentRole("main")!;
    const parent = await rt.submit({ sessionId: main.sessionId, requestId: "p-partial", input: "触发", modelSelection: rt.defaultSelection });
    await waitFor("任务完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const body = { repository: { id: 42, fullName: "owner/repo" }, number: 7, url: "https://github.com/owner/repo/pull/7",
      headSha: "a".repeat(40), baseSha: "b".repeat(40), state: "open", draft: false, updatedAt: "2026-09-24T00:00:00Z" };
    const { event } = rt.store.withTx(() => rt.store.registerInboundEvent({ source: "github", externalId: randomUUID(), actor: null, targetRole: "main", body: JSON.stringify(body) }));
    rt.store.withTx(() => {
      rt.store.db.prepare("UPDATE tasks SET source_event_id = ? WHERE id = ?").run(event.id, parent.id);
      rt.store.markInboundQueued(event.id, parent.id);
    });
    // 造一个 SubAgent 评审任务（独立子会话，带工作/身份与来源事件）
    const deleg = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "partial", request: "评审", paramsDigest: "p", readPaths: null, materials: null, hostReview: { sourceEventId: event.id } });
    const adapter = new GitHubEvents({ store: rt.store, artifacts: rt.artifacts, sched: rt.sched, target: () => null, dispatch: async () => {}, capReply: (_, text) => text,
      readReply: (_, offset) => offset === 0 ? { entryId: "e1", role: "assistant", text: "prefix", offset: 0, totalBytes: 100, truncated: true } as any : null });
    const result = adapter.resultData(rt.store.getTask(deleg.task.id)!, "completed") as any;
    assert.equal(result.needsOwner, true);
    assert.match(result.review.captureError, /未完整保存/);
    assert.equal(rt.store.getArtifact(result.review.artifactId)!.status, "partial");
    assert.ok(rt.artifacts.read(result.review.artifactId).toString().endsWith("prefix"));
    assert.equal(rt.store.listArtifactsByTask(deleg.task.id).filter((a) => a.name.startsWith("review-draft:") && a.status === "complete").length, 0);
    release();
    await waitFor("评审任务收尾", () => rt.store.getTask(deleg.task.id)!.resultSummary !== null);
  } finally { await t.shutdown(); }
});
