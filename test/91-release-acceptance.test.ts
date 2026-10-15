import { delegateFromActiveTask, messageFromActiveTask } from "./helpers/active-subagent-source.ts";
import { product as codingProduct } from "../apps/ruukoto-code/src/product.ts";
/**
 * 发布联合路径（agent-direction issue 24）：复用各票已验证的接缝，检查迁移、
 * 重启、协作取消、成果冲突与回退相互作用。Runtime / SQLite / JSONL / Git
 * 为真实执行；模型为 MockModelServer，local 工具后端无隔离，不代替权限冒烟。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Db } from "@ruukoto/core/db.ts";
import { Runtime, type RuntimeConfig } from "@ruukoto/runtime/runtime.ts";
import { applyLegacyImport, previewLegacyImport, revertLegacyImport } from "../apps/ruukoto-code/src/legacy-import.ts";
import { listLegacyImports } from "@ruukoto/core/import-support.ts";
import { MockModelServer } from "./helpers/mock-provider.ts";
import { initGitRepo } from "./helpers/git-fixture.ts";
import { cleanupDirs, lastUserText, makeTestDirs, realTools, startTestRuntime, waitFor, writeModelsJson } from "./helpers/testkit.ts";

test("迁移与重启后协作取消：迟到同级消息不重启工作，副本冲突保留成果，回退保护目标事实", async () => {
  const source = await startTestRuntime("release-src", () => ({ kind: "text", text: "迁移前的历史回答" }), { workDirs: 1 });
  const { dirs } = await makeTestDirs("release-dst", 0);
  const { dirs: cleanDirs } = await makeTestDirs("release-clean", 0);
  let release: (() => void) | undefined;
  let releaseParent: (() => void) | undefined;
  const server = new MockModelServer(async (req) => {
    const input = lastUserText(req);
    if (input.startsWith("HOLD-PARENT")) await new Promise<void>((resolve) => { releaseParent = resolve; });
    if (input.includes("HOLD-PEER")) await new Promise<void>((resolve) => { release = resolve; });
    if (input.includes("PATCH-RELEASE") && req.messages.at(-1)?.role !== "tool") {
      return { kind: "tool_calls", calls: [{ id: "patch", name: "edit", arguments: { path: "value.ts", edits: [{ oldText: "export const value = 1", newText: "export const value = 2" }] } }] };
    }
    return { kind: "text", text: "联合验收完成" };
  });
  let rt: Runtime | undefined;
  try {
    const file = path.join(source.work[0]!, "value.ts");
    fs.writeFileSync(file, "export const value = 1\n");
    initGitRepo(source.work[0]!);
    const session = await source.runtime.createSession({ projectName: "release", cwd: source.work[0]! });
    const parent = await source.runtime.submit({ sessionId: session.id, requestId: "seed", input: "保留这段历史", modelSelection: source.runtime.defaultSelection });
    await waitFor("源任务完成", () => source.runtime.store.getTask(parent.id)!.status === "completed");
    const history = fs.readFileSync(source.runtime.store.getSession(session.id)!.sessionFile!);
    const artifact = source.runtime.store.listArtifactsByTask(parent.id).find((a) => a.name.includes("prompt"))!;
    assert.ok(artifact, "源任务有 prompt 快照产物");
    const artifactBytes = fs.readFileSync(path.join(source.dirs.dataDir, "artifacts", `${artifact.id}.bin`));
    source.client.close();
    await source.runtime.stop("test_migration");
    const sourceDb = fs.readFileSync(path.join(source.dirs.dataDir, "ruukoto.db"));

    const deps = { targetDataDir: dirs.dataDir, targetAgentDir: dirs.agentDir };
    const preview = previewLegacyImport(deps, { from: source.dirs.dataDir });
    const imported = applyLegacyImport(deps, { plan: { from: source.dirs.dataDir }, source_instance_id: preview.source.instance_id, revision: preview.revision!, request_id: "release-import" });
    await writeModelsJson(dirs, await server.start());
    const config: RuntimeConfig = { dataDir: dirs.dataDir, agentDir: dirs.agentDir, product: codingProduct.runtime, modelProvider: "mock", modelId: "mock-model", thinkingLevel: "off", ...realTools() };
    rt = await Runtime.start(config);
    await rt.stop("test_restart");
    rt = await Runtime.start(config);
    assert.equal(server.calls.length, 0, "迁移与重启不重放旧任务");
    assert.deepEqual(fs.readFileSync(rt.store.getSession(session.id)!.sessionFile!), history);
    assert.deepEqual(fs.readFileSync(path.join(dirs.dataDir, "artifacts", `${artifact.id}.bin`)), artifactBytes);
    assert.equal(rt.readTaskReplyText(parent.id), "迁移前的历史回答");

    const currentParent = await rt.submit({ sessionId: session.id, requestId: "live-parent", input: "HOLD-PARENT 创建工作", modelSelection: rt.defaultSelection });
    await waitFor("父任务持有目录", () => releaseParent !== undefined);
    const manager = rt.subagents!;
    const patch = await delegateFromActiveTask({ store: rt.store, subagents: manager }, { parentTaskId: currentParent.id, key: "patch", request: "PATCH-RELEASE", target: ".", paramsDigest: "patch" });
    await waitFor("副本修改完成", () => rt!.store.getSubAgent(patch.agent.id)!.state === "idle");
    const copy = patch.work.writeTarget!;
    assert.equal(copy.kind, "worktree");
    assert.equal(fs.readFileSync(path.join(copy.path, "value.ts"), "utf8"), "export const value = 2\n");
    assert.equal(fs.readFileSync(file, "utf8"), "export const value = 1\n");

    const a = await delegateFromActiveTask({ store: rt.store, subagents: manager }, { parentTaskId: parent.id, key: "a", request: "分析", readPaths: ["value.ts"], paramsDigest: "a" });
    await waitFor("A 空闲", () => rt!.store.getSubAgent(a.agent.id)!.state === "idle");
    const b = await delegateFromActiveTask({ store: rt.store, subagents: manager }, { parentTaskId: parent.id, key: "b", request: "独立分析", readPaths: ["value.ts"], paramsDigest: "b" });
    await waitFor("B 空闲", () => rt!.store.getSubAgent(b.agent.id)!.state === "idle");
    const join = await delegateFromActiveTask({ store: rt.store, subagents: manager }, { parentTaskId: parent.id, key: "join", request: "加入协作", workId: a.work.id, subAgentId: b.agent.id, readPaths: ["value.ts"], paramsDigest: "join" });
    await waitFor("加入完成", () => rt!.store.getSubAgent(b.agent.id)!.state === "idle");
    const busy = await delegateFromActiveTask({ store: rt.store, subagents: manager }, { parentTaskId: parent.id, key: "busy", request: "HOLD-PEER", workId: a.work.id, subAgentId: b.agent.id, readPaths: ["value.ts"], paramsDigest: "busy" });
    await waitFor("B 运行中", () => release !== undefined);
    const messageInput = { senderTaskId: a.task.id, workId: a.work.id, key: "late-peer", text: "LATE-PEER-MESSAGE", toSubAgentId: b.agent.id, paramsDigest: "late-peer" };
    const sent = await messageFromActiveTask({ store: rt.store, subagents: manager }, messageInput);
    assert.equal(sent.delivery, "pending", "忙碌协作方的同级消息已登记待投递");

    await rt.cancelWork(a.work.id, { reason: "发布联合验收取消" });
    release!();
    release = undefined;
    await waitFor("协作方回空闲", () => rt!.store.getSubAgent(b.agent.id)!.state === "idle");
    assert.equal(rt.store.getTask(busy.task.id)!.status, "canceled");
    assert.equal(rt.store.getSubAgentMessage(sent.message.id)!.undeliveredReason, "work_canceled");
    await rt.cancelWork(patch.work.id);
    manager.close({ subAgentId: patch.agent.id, by: "owner" });
    const tasksBefore = rt.store.listTasksByWork(a.work.id).map((t) => t.id);
    releaseParent!();
    releaseParent = undefined;
    await waitFor("父任务完成", () => rt!.store.getTask(currentParent.id)!.status === "completed");
    const callsBefore = server.calls.length;

    await rt.stop("test_restart");
    rt = await Runtime.start(config);
    const replay = await messageFromActiveTask(rt, messageInput);
    assert.equal(replay.created, false, "同键迟到消息仅对账原记录");
    assert.equal(replay.delivery, null);
    assert.equal(replay.message.undeliveredReason, "work_canceled");
    await assert.rejects(() => messageFromActiveTask(rt!, { ...messageInput, key: "new-late-peer" }), /工作已取消/);
    await rt.subagents!.flushPendingMessages();
    assert.deepEqual(rt.store.listTasksByWork(a.work.id).map((t) => t.id), tasksBefore, "取消、重启与重放不登记新执行");
    assert.equal(server.calls.length, callsBefore, "已取消工作不会重新调用模型");
    assert.ok(!rt.store.listTasksByWork(a.work.id).some((t) => t.requestId === `smsg:${sent.message.id}`));
    assert.equal(rt.store.getSubAgentMessage(sent.message.id)!.deliveredTaskId, null);
    assert.equal(rt.store.getSubAgent(b.agent.id)!.closedAt, null, "工作取消不关闭协作方身份");
    assert.ok(rt.store.getTask(join.task.id)!.resultRef, "协作成果及归属保留");
    const dropped = rt.store.db.prepare("SELECT count(*) AS n FROM events WHERE json_extract(body, '$.type') = 'subagent_message.dropped' AND json_extract(body, '$.messageId') = ?").get(sent.message.id) as { n: number };
    assert.equal(dropped.n, 1, "取消与重启不重复登记未投递事件");

    const integrateParent = await rt.submit({ sessionId: session.id, requestId: "integrate-parent", input: "HOLD-PARENT 汇总工作", modelSelection: rt.defaultSelection });
    await waitFor("汇总父任务持有目录", () => releaseParent !== undefined);
    fs.writeFileSync(file, "export const value = 10 // 拥有者改动\n");
    await assert.rejects(rt.subagents!.integrate({ workId: patch.work.id, parentTaskId: integrateParent.id, parentSessionId: session.id }), (err: any) => err.code === "integrate_conflict" && err.message.includes("value.ts"));
    assert.equal(fs.readFileSync(file, "utf8"), "export const value = 10 // 拥有者改动\n");
    assert.equal(fs.readFileSync(path.join(copy.path, "value.ts"), "utf8"), "export const value = 2\n", "取消、关闭、重启及冲突后副本成果仍可找回");
    assert.equal(rt.store.hasIntegratedEvent(patch.work.id), false);
    releaseParent!();
    releaseParent = undefined;
    await waitFor("汇总父任务完成", () => rt!.store.getTask(integrateParent.id)!.status === "completed");
    await rt.stop("test_revert");
    rt = undefined;
    const blocked = revertLegacyImport(deps, imported.import_id);
    assert.equal(blocked.ok, false, "目标新增的协作、取消与副本成果阻止破坏性回退");
    assert.equal(blocked.status, "applied", "回退被挡时响应与实际回执一致");
    assert.equal(listLegacyImports(deps)[0]!.status, "applied");
    assert.ok(blocked.blockers!.some((b) => /新任务|新会话|新事件/.test(b)));
    assert.deepEqual(blocked.files_removed, []);
    const after = await Runtime.start(config);
    rt = after;
    assert.ok(after.store.getSubAgentMessage(sent.message.id));
    assert.ok(after.store.getWorkDelegation(patch.work.id)!.canceledAt);
    await after.stop("test_end");
    rt = undefined;

    // 同一源的另一导入目标：只启动与重启，无新工作时仍可安全回退。
    const cleanDeps = { targetDataDir: cleanDirs.dataDir, targetAgentDir: cleanDirs.agentDir };
    const cleanPreview = previewLegacyImport(cleanDeps, { from: source.dirs.dataDir });
    const cleanImport = applyLegacyImport(cleanDeps, { plan: { from: source.dirs.dataDir }, source_instance_id: cleanPreview.source.instance_id, revision: cleanPreview.revision!, request_id: "release-clean" });
    fs.copyFileSync(path.join(dirs.agentDir, "models.json"), path.join(cleanDirs.agentDir, "models.json"));
    const cleanConfig = { ...config, dataDir: cleanDirs.dataDir, agentDir: cleanDirs.agentDir };
    rt = await Runtime.start(cleanConfig);
    await rt.stop("test_restart");
    rt = await Runtime.start(cleanConfig);
    await rt.stop("test_revert");
    rt = undefined;
    const reverted = revertLegacyImport(cleanDeps, cleanImport.import_id);
    assert.equal(reverted.ok, true, JSON.stringify(reverted.blockers));
    assert.equal(reverted.status, "reverted");
    assert.equal(listLegacyImports(cleanDeps)[0]!.status, "reverted");
    const db = new Db(cleanDirs.dataDir);
    try {
      assert.equal((db.prepare("SELECT count(*) AS n FROM sessions WHERE id = ?").get(session.id) as { n: number }).n, 0, "已导入的会话被移除");
    } finally { db.close(); }
    assert.deepEqual(fs.readFileSync(path.join(source.dirs.dataDir, "ruukoto.db")), sourceDb, "全部联合路径不改源库");
    assert.deepEqual(fs.readFileSync(path.join(source.dirs.dataDir, "artifacts", `${artifact.id}.bin`)), artifactBytes);
  } finally {
    release?.();
    releaseParent?.();
    await rt?.stop("test_end");
    await server.close();
    await source.shutdown();
    await cleanupDirs(dirs);
    await cleanupDirs(cleanDirs);
  }
});
