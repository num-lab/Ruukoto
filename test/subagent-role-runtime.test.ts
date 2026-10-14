import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { ArtifactStore } from "@ruukoto/agent/artifacts.ts";
import { createLocalLauncher } from "@ruukoto/agent/execution/launchers.ts";
import { BUILTIN_SUBAGENT_ROLES, HOST_REVIEW_DEFINITION, parseSubAgentRole, subAgentRoleLibrary } from "@ruukoto/agent/subagent-roles.ts";
import { createSourceResolver } from "@ruukoto/channels/source-resolver.ts";
import { AccessScope } from "@ruukoto/core/access.ts";
import { Db } from "@ruukoto/core/db.ts";
import { requireSubAgentDefinition } from "@ruukoto/core/subagent-definition.ts";
import { Store } from "@ruukoto/core/store.ts";
import { randomId, type Task } from "@ruukoto/core/types.ts";
import { requireWorkflowRun, type WorkflowSource } from "@ruukoto/core/workflow.ts";
import { loadSubAgentRoleLibrary } from "@ruukoto/runtime/subagent-role-library.ts";
import { SubAgentManager } from "@ruukoto/runtime/subagents.ts";
import { WorkCopyManager } from "@ruukoto/runtime/work-copy.ts";
import { WorkflowCoordinator } from "@ruukoto/runtime/workflows.ts";

const selection = { provider: "fake", modelId: "source-model", thinkingLevel: "high" } as const;

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "subagent-role-runtime-")));
  const dataDir = path.join(root, "data"), agentDir = path.join(root, "agent"), cwd = path.join(root, "source");
  fs.mkdirSync(agentDir);
  fs.mkdirSync(cwd);
  fs.mkdirSync(dataDir);
  let db = new Db(dataDir), store = new Store(db);
  const stat = fs.statSync(cwd);
  const { session, parent } = store.withTx(() => {
    const project = store.createProject("roles");
    const session = store.createSession({ projectId: project.id, cwd, cwdReal: cwd, cwdDev: stat.dev, cwdIno: stat.ino, piSessionId: randomId("pi"), confirmTools: [], modelSelection: selection });
    const parent = store.insertQueuedTask({ sessionId: session.id, requestId: "source", input: "source", accessMode: "full_access", modelSelection: selection, submissionDigest: "source" }).task;
    store.transitionTask(parent.id, ["queued"], "running");
    return { session, parent };
  });
  const createManager = () => new SubAgentManager({
    store, roles: () => loadSubAgentRoleLibrary(agentDir), workRoot: path.join(root, "children"),
    workCopies: new WorkCopyManager({ worktreeRoot: path.join(root, "copies"), protectedRoots: () => [dataDir], execute: async () => { throw new Error("本用例不准备工作副本"); } }),
    sources: createSourceResolver({ store, access: new AccessScope(db), artifacts: new ArtifactStore(dataDir, store), appData: () => null }),
    resolveSelection: async () => () => {}, launcherFor: () => createLocalLauncher(), defaultModelSelection: () => ({ ...selection, modelId: "backend-default" }),
    kickSession: () => {}, resumeQueue: async () => {}, parentDelivery: { messageRecorded: () => { throw new Error("本用例不唤醒父会话"); } },
    cancelTask: async () => { throw new Error("本用例不取消任务"); }, protectedRoots: () => [dataDir], dataDir,
  });
  let manager = createManager();
  const cleanups: (() => Promise<void>)[] = [];
  t.after(async () => { for (const cleanup of cleanups) await cleanup(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return {
    root, agentDir, session, parent, get store() { return store; }, get manager() { return manager; },
    role(name: string, body: string) { fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true }); fs.writeFileSync(path.join(agentDir, "agents", `${name}.md`), `---\ndescription: ${name}职责\n---\n${body}`); },
    finish(task: Task) { store.withTx(() => { store.transitionTask(task.id, ["queued"], "running"); store.endTask(task.id, ["running"], "completed"); store.setTaskResult(task.id, "done", "{}"); manager.resultRecorded(store.getTask(task.id)!); }); },
    restart() { db.close(); db = new Db(dataDir); store = new Store(db); manager = createManager(); },
    cleanup(action: () => Promise<void>) { cleanups.push(action); },
    delegate(key: string, extra: { role?: string; workId?: string; subAgentId?: string } = {}) { return manager.delegate({ parentTaskId: parent.id, key, request: "检查资料", paramsDigest: key, ...extra }); },
  };
}

test("角色创建固定正文，编辑删除后继续、复用、消息与冷恢复沿原快照；模型继承来源", async t => {
  const f = fixture(t);
  f.role("scout", "固定的角色正文");
  const first = await f.delegate("first", { role: "scout" });
  const definition = requireSubAgentDefinition(first.agent);
  assert.equal(definition.body, "固定的角色正文");
  assert.deepEqual(first.task.modelSelection, selection);
  f.finish(first.task);
  f.role("scout", "新的角色正文");
  const replay = await f.delegate("first", { role: "scout" });
  assert.equal(replay.task.id, first.task.id);
  await assert.rejects(f.delegate("other-role", { subAgentId: first.agent.id, role: "general" }), { code: "role_conflict" });
  const continuation = await f.delegate("continue", { workId: first.work.id });
  assert.deepEqual(requireSubAgentDefinition(continuation.agent), definition);
  f.finish(continuation.task);
  fs.unlinkSync(path.join(f.agentDir, "agents", "scout.md"));
  f.restart();
  const reused = await f.delegate("reuse", { subAgentId: first.agent.id });
  assert.deepEqual(requireSubAgentDefinition(reused.agent), definition);
  f.finish(reused.task);
  const sent = await f.manager.message({ senderTaskId: f.parent.id, workId: reused.work.id, toSubAgentId: reused.agent.id, key: "message", text: "继续核对", paramsDigest: "message" });
  const delivered = f.store.getTask(sent.message.deliveredTaskId!)!;
  assert.deepEqual(delivered.modelSelection, selection);
  assert.deepEqual(requireSubAgentDefinition(f.store.getSubAgent(reused.agent.id)!), definition);
});

test("无效覆盖、未知角色与缺来源模型不登记新执行；损坏快照不能重放或复用", async t => {
  const f = fixture(t);
  f.role("general", "正文");
  fs.writeFileSync(path.join(f.agentDir, "agents", "general.md"), "没有frontmatter");
  await assert.rejects(f.delegate("bad"), { code: "role_invalid_frontmatter" });
  await assert.rejects(f.delegate("unknown", { role: "absent" }), { code: "role_unknown" });
  assert.equal(f.store.listSubAgents().length, 0);
  fs.unlinkSync(path.join(f.agentDir, "agents", "general.md"));
  f.store.db.prepare("UPDATE tasks SET model_selection = NULL WHERE id = ?").run(f.parent.id);
  await assert.rejects(f.delegate("model-missing"), { code: "model_selection_missing" });
  assert.equal(f.store.listSubAgents().length, 0);
  f.store.db.prepare("UPDATE tasks SET model_selection = ? WHERE id = ?").run(JSON.stringify(selection), f.parent.id);
  const first = await f.delegate("valid");
  f.finish(first.task);
  f.store.db.prepare("UPDATE sub_agents SET definition = ? WHERE id = ?").run("{}", first.agent.id);
  await assert.rejects(f.delegate("valid"), { code: "definition_corrupt" });
  await assert.rejects(f.delegate("reuse", { subAgentId: first.agent.id }), { code: "definition_corrupt" });
  assert.equal(f.store.listTasksByWork(first.work.id).length, 1);
  assert.equal(f.store.getSubAgent(first.agent.id)!.definitionError, "definition_corrupt");
});

test("GitHub 固定定义绕开坏用户覆盖，保留已完成来源资格与原键恢复", async t => {
  const f = fixture(t);
  f.role("general", "正文");
  fs.writeFileSync(path.join(f.agentDir, "agents", "general.md"), "坏覆盖");
  f.role("reviewer", "用户覆盖不能取代宿主定义");
  const { event } = f.store.withTx(() => f.store.registerInboundEvent({ source: "github", externalId: "event", actor: "contributor", targetRole: "main", body: "{}" }));
  f.store.db.prepare("UPDATE tasks SET status = 'completed', access_mode = 'confirm', source_event_id = ? WHERE id = ?").run(event.id, f.parent.id);
  const input = { parentTaskId: f.parent.id, key: "review", request: "固定评审", paramsDigest: "review", hostReview: { sourceEventId: event.id } };
  const review = await f.manager.delegate(input);
  assert.deepEqual(requireSubAgentDefinition(review.agent), HOST_REVIEW_DEFINITION);
  f.finish(review.task);
  f.restart();
  const replay = await f.manager.delegate(input);
  assert.equal(replay.task.id, review.task.id);
  assert.deepEqual(requireSubAgentDefinition(replay.agent), HOST_REVIEW_DEFINITION);
  f.store.db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(f.parent.id);
  await assert.rejects(f.delegate("reuse-review", { subAgentId: review.agent.id }), { code: "forbidden" });
});

test("工作流启动固定完整目录与诊断，编辑后步骤取原 general；损坏目录暂停且不补配置", async t => {
  const f = fixture(t);
  const general = parseSubAgentRole("general", "---\ndescription: 原始角色\n---\n固定正文");
  let catalog = subAgentRoleLibrary([general], [{ name: "broken", code: "role_invalid_frontmatter", message: "修正文件" }]);
  const source: WorkflowSource = { product: "ruukoto-code", projectId: f.session.projectId, sessionId: f.session.id, taskId: f.parent.id, permissionVersion: 1, accessMode: "full_access", grantedPaths: [], capabilities: [], references: [], replyTarget: null, scheduledRunId: null };
  const seen: string[] = [];
  const coordinator = new WorkflowCoordinator({ store: f.store, roles: () => catalog, workRoot: path.join(f.root, "workflow"), source: () => source, selection: () => selection, verifySource: () => true,
    agent: async context => { seen.push(requireSubAgentDefinition(f.store.getSubAgent(context.task.subAgentId!)!).body); return { output: "done" }; } });
  f.cleanup(() => coordinator.stop("test_end"));
  const input = { sourceTaskId: f.parent.id, requestKey: "workflow", script: "return await agent('first', {request:'核对资料'});", input: null };
  const run = f.store.withTx(() => coordinator.register(input));
  const fixed = structuredClone(catalog);
  catalog = subAgentRoleLibrary(BUILTIN_SUBAGENT_ROLES, []);
  assert.deepEqual(coordinator.start(input).roleCatalog, fixed);
  const deadline = Date.now() + 10_000;
  while (requireWorkflowRun(f.store, run.id).status !== "succeeded") {
    assert.ok(Date.now() < deadline, JSON.stringify(requireWorkflowRun(f.store, run.id)));
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual(seen, ["固定正文"]);
  for (const missing of [false, true]) {
    const requestKey = missing ? "missing-run" : "bad-run";
    const another = f.store.withTx(() => coordinator.register({ ...input, requestKey }));
    const damaged = { ...another, roleCatalog: missing ? undefined : { ...catalog, digest: "0".repeat(64) } };
    f.store.db.prepare("UPDATE workflow_runs SET payload = ? WHERE id = ?").run(JSON.stringify(damaged), another.id);
    coordinator.recover();
    const code = missing ? "role_catalog_missing" : "role_catalog_corrupt";
    assert.equal(requireWorkflowRun(f.store, another.id).status, "paused");
    assert.equal(requireWorkflowRun(f.store, another.id).reason, code);
    await assert.rejects(async () => coordinator.start({ ...input, requestKey }), { code });
  }
});

test("工作流固定无效 general 诊断，后来修好配置仍不能登记步骤执行", async t => {
  const f = fixture(t);
  let catalog = subAgentRoleLibrary([], [{ name: "general", code: "role_invalid_frontmatter", message: "修正文件" }]);
  const source: WorkflowSource = { product: "ruukoto-code", projectId: f.session.projectId, sessionId: f.session.id, taskId: f.parent.id, permissionVersion: 1, accessMode: "full_access", grantedPaths: [], capabilities: [], references: [], replyTarget: null, scheduledRunId: null };
  const coordinator = new WorkflowCoordinator({ store: f.store, roles: () => catalog, workRoot: path.join(f.root, "workflow"), source: () => source, selection: () => selection, verifySource: () => true, agent: async () => { throw new Error("坏角色不能执行"); } });
  f.cleanup(() => coordinator.stop("test_end"));
  const input = { sourceTaskId: f.parent.id, requestKey: "workflow", script: "return await agent('first', {request:'核对资料'});", input: null };
  const run = f.store.withTx(() => coordinator.register(input));
  catalog = subAgentRoleLibrary(BUILTIN_SUBAGENT_ROLES, []);
  coordinator.start(input);
  const deadline = Date.now() + 10_000;
  while (requireWorkflowRun(f.store, run.id).status !== "paused") {
    assert.ok(Date.now() < deadline, JSON.stringify(requireWorkflowRun(f.store, run.id)));
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(requireWorkflowRun(f.store, run.id).reason, "role_invalid_frontmatter");
  assert.equal(f.store.listSubAgents().length, 0);
});
