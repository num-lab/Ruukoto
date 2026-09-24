import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Runtime, type RuntimeConfig } from "../src/runtime/runtime.ts";
import { Db } from "../src/core/db.ts";
import { CredentialStore } from "../src/agent/execution/credentials.ts";
import { GitHubEvents, parseGitHubEventsConfig, webhookSecret } from "../src/github/events.ts";
import type { GitHubPullRequestEvent } from "../src/github/webhook.ts";
import type { NotifyTarget } from "../src/core/types.ts";
import { MockModelServer } from "./helpers/mock-provider.ts";
import { cleanupDirs, lastUserText, makeTestDirs, startTestRuntime, waitFor, writeModelsJson } from "./helpers/testkit.ts";

const target: NotifyTarget = { channel: "telegram", account: "test-bot", chatId: "owner", configVersion: 1 };

test("review 恢复：父任务/子任务提交窗口、模型变化、产物与摘要通知补记保持幂等", async (t) => {
  for (const window of ["parent_only", "child_committed"] as const) await t.test(window, async () => {
    const { dirs } = await makeTestDirs(`github-${window}`, 0);
    const server = new MockModelServer(async (req) => ({ kind: "text", text: lastUserText(req).startsWith("[委派 coding") ? "草稿：需核实资料。\n测试：未运行\n需要拥有者：是（离线验证）" : "main 摘要" }));
    await writeModelsJson(dirs, await server.start());
    const credentials = new CredentialStore(dirs.agentDir);
    credentials.upsert({ name: "hook", host: "github.com", header: "x-hub-signature-256", purpose: "github_webhook", secret: "test-secret" });
    const config: RuntimeConfig = { dataDir: dirs.dataDir, agentDir: dirs.agentDir,
      modelProvider: "mock", modelId: "mock-model", thinkingLevel: "off", qqDisabled: true, telegramDisabled: true,
      githubWebhook: { port: 0, credential: "hook", repositoryIds: [42] },
      scheduler: { tickMs: 0, channel: { target: () => target, available: () => false, send: async () => { throw new Error("不应发送"); } } },
    };
    let rt = await Runtime.start(config);
    try {
      const main = rt.store.getAgentRole("main")!, coding = rt.store.getAgentRole("coding")!;
      for (const role of [main, coding]) rt.store.setSessionQueueState(role.sessionId, "paused", "backend_restart");
      const deliveryId = randomUUID();
      const payload: GitHubPullRequestEvent = { deliveryId, action: "opened", repository: { id: 42, owner: "owner", name: "repo", fullName: "owner/repo" }, number: 7,
        url: "https://github.com/owner/repo/pull/7", headSha: "a".repeat(40), baseSha: "b".repeat(40), headRef: "feature", baseRef: "main", sender: "contributor",
        title: "review", body: "", bodyTruncated: false, draft: false, state: "open", updatedAt: "2026-09-24T01:00:00Z" };
      const { event } = rt.store.withTx(() => rt.store.registerInboundEvent({ source: "github", externalId: deliveryId, actor: "contributor", targetRole: "main", body: JSON.stringify(payload), replyTarget: target }));
      const bridge = (rt.orchestrator as any).deps.bridge;
      const submit = bridge.submit;
      bridge.submit = async (input: any) => {
        if (input.agentId !== "coding") return submit(input);
        if (window === "child_committed") await submit(input);
        throw new Error("提交窗口断开");
      };
      await rt.orchestrator!.dispatchRegisteredEvents();
      const parent = rt.store.findTaskByRequest(main.sessionId, `evt:${event.id}:main`)!;
      assert.ok(parent);
      assert.equal(rt.store.getInboundEvent(event.id)!.status, "registered");
      assert.equal(rt.store.listTasksBySession(coding.sessionId).length, window === "child_committed" ? 1 : 0);
      await rt.stop("test_restart");

      // 恢复时后台默认模型已变：原父任务的提交不能拿新模型形成幂等冲突。
      const file = path.join(dirs.agentDir, "models.json"), catalog = JSON.parse(fs.readFileSync(file, "utf8"));
      catalog.providers.mock.models.push({ ...catalog.providers.mock.models[0], id: "mock-v2", name: "Mock v2" });
      fs.writeFileSync(file, JSON.stringify(catalog));
      config.modelId = "mock-v2";
      rt = await Runtime.start(config);
      await waitFor("恢复后的摘要通知", () => rt.sched.findOpBySource("inbound_event", event.id) !== null);
      const child = rt.store.listTasksBySession(coding.sessionId)[0]!;
      const wake = rt.store.findTaskByRequest(main.sessionId, `wake:${child.id}`)!;
      assert.equal(child.parentTaskId, parent.id);
      assert.equal(child.sourceEventId, event.id);
      assert.equal(wake.sourceEventId, event.id);
      assert.equal(rt.store.getInboundEvent(event.id)!.status, "done");
      const result = JSON.parse(rt.store.getTask(child.id)!.resultRef!);
      assert.equal(result.review.headSha, payload.headSha);
      const artifactId = result.review.artifactId;
      assert.ok(rt.artifacts.read(artifactId).toString().includes("草稿：需核实资料。"));
      assert.equal(rt.store.listTasksBySession(coding.sessionId).length, 1);
      assert.equal(rt.store.findTaskByRequest(main.sessionId, `evt:${event.id}:main`)!.modelSelection!.modelId, "mock-model");
      await rt.stop("test_restart");

      // 模拟文件已定稿、结果事务尚未提交；main 摘要已终态、outbox 尚未登记。
      const db = new Db(dirs.dataDir);
      db.prepare("UPDATE tasks SET result_summary = NULL, result_ref = NULL WHERE id IN (?, ?)").run(child.id, wake.id);
      db.prepare("DELETE FROM notification_ops WHERE source_kind = 'inbound_event' AND source_key = ?").run(event.id);
      db.close();
      for (let restart = 0; restart < 2; restart++) {
        rt = await Runtime.start(config);
        const restored = JSON.parse(rt.store.getTask(child.id)!.resultRef!);
        assert.equal(restored.review.artifactId, artifactId, "复用已定稿产物，不重复写报告");
        assert.equal(rt.store.listArtifactsByTask(child.id).filter((a) => a.name.startsWith("review-draft:")).length, 1);
        assert.equal(rt.store.listTasksBySession(coding.sessionId).length, 1);
        assert.equal(rt.store.listTasksBySession(main.sessionId).length, 2);
        assert.equal(rt.sched.listOps({}).items.length, 1);
        assert.equal(rt.sched.findOpBySource("inbound_event", event.id)!.status, "pending");
        await rt.stop("test_restart");
      }
      assert.equal(server.calls.filter((call) => lastUserText(call).startsWith("[委派 coding")).length, 1, "恢复不重跑 review");
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

test("报告归档：历史在第二页读取失败不得标为完整产物，需拥有者核实", async () => {
  const t = await startTestRuntime("github-partial", async () => ({ kind: "text", text: "reply" }));
  try {
    const rt = t.runtime, coding = rt.store.getAgentRole("coding")!;
    const task = await rt.submit({ sessionId: coding.sessionId, requestId: "partial", input: "报告", modelSelection: rt.defaultSelection });
    await waitFor("任务完成", () => rt.store.getTask(task.id)!.status === "completed");
    const body = { repository: { id: 42, fullName: "owner/repo" }, number: 7, url: "https://github.com/owner/repo/pull/7",
      headSha: "a".repeat(40), baseSha: "b".repeat(40), state: "open", draft: false, updatedAt: "2026-09-24T00:00:00Z" };
    const { event } = rt.store.withTx(() => rt.store.registerInboundEvent({ source: "github", externalId: randomUUID(), actor: null, targetRole: "main", body: JSON.stringify(body) }));
    rt.store.db.prepare("UPDATE tasks SET agent_id = 'coding', source_event_id = ? WHERE id = ?").run(event.id, task.id);
    const adapter = new GitHubEvents({ store: rt.store, artifacts: rt.artifacts, sched: rt.sched, target: () => null, dispatch: async () => {}, capReply: (_, text) => text,
      readReply: (_, offset) => offset === 0 ? { entryId: "e1", role: "assistant", text: "prefix", offset: 0, totalBytes: 100, truncated: true } as any : null });
    const result = adapter.resultData(rt.store.getTask(task.id)!, "completed") as any;
    assert.equal(result.needsOwner, true);
    assert.match(result.review.captureError, /未完整保存/);
    assert.equal(rt.store.getArtifact(result.review.artifactId)!.status, "partial");
    assert.ok(rt.artifacts.read(result.review.artifactId).toString().endsWith("prefix"));
    assert.equal(rt.store.listArtifactsByTask(task.id).filter((a) => a.name.startsWith("review-draft:") && a.status === "complete").length, 0);
  } finally { await t.shutdown(); }
});
