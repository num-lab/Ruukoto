import { delegateFromActiveTask, messageFromActiveTask } from "./helpers/active-subagent-source.ts";

/** Restart, canceled work delivery and conflicting work-copy integration use real persistence and Git with a mock model. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Runtime, type RuntimeConfig } from "@ruukoto/runtime/runtime.ts";
import { MockModelServer } from "./helpers/mock-provider.ts";
import { initGitRepo } from "./helpers/git-fixture.ts";
import { cleanupDirs, lastUserText, makeTestDirs, realTools, waitFor, writeModelsJson } from "./helpers/testkit.ts";
import { seedTestRole } from "./helpers/subagent-definition.ts";

test("restart preserves history, canceled peer delivery and conflicting work-copy results", async () => {
  const { dirs, work } = await makeTestDirs("release", 1);
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
    const file = path.join(work[0], "value.ts");
    fs.writeFileSync(file, "export const value = 1\n");
    initGitRepo(work[0]);
    await writeModelsJson(dirs, await server.start());
    seedTestRole(dirs.agentDir);
    const config: RuntimeConfig = { profile: dirs.profile, modelProvider: "mock", modelId: "mock-model", thinkingLevel: "off", ...realTools() };
    rt = await Runtime.start(config);
    const session = await rt.createSession({ projectName: "release", cwd: work[0] });
    const parent = await rt.submit({ sessionId: session.id, requestId: "seed", input: "保留这段历史", modelSelection: rt.defaultSelection });
    await waitFor("seed task completed", () => rt!.store.getTask(parent.id)!.status === "completed");
    const history = fs.readFileSync(rt.store.getSession(session.id)!.sessionFile!);
    const artifact = rt.store.listArtifactsByTask(parent.id).find((a) => a.name.includes("prompt"))!;
    assert.ok(artifact);
    const artifactBytes = fs.readFileSync(path.join(dirs.dataDir, "artifacts", `${artifact.id}.bin`));
    const seedCalls = server.calls.length;
    await rt.stop("test_restart");
    rt = await Runtime.start(config);
    assert.equal(server.calls.length, seedCalls, "restart does not replay completed work");
    assert.deepEqual(fs.readFileSync(rt.store.getSession(session.id)!.sessionFile!), history);
    assert.deepEqual(fs.readFileSync(path.join(dirs.dataDir, "artifacts", `${artifact.id}.bin`)), artifactBytes);
    assert.equal(rt.readTaskReplyText(parent.id), "联合验收完成");

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
    await rt.stop("test_restart");
    rt = undefined;
    const after = await Runtime.start(config);
    rt = after;
    assert.ok(after.store.getSubAgentMessage(sent.message.id));
    assert.ok(after.store.getWorkDelegation(patch.work.id)!.canceledAt);
    await after.stop("test_end");
    rt = undefined;

  } finally {
    release?.();
    releaseParent?.();
    await rt?.stop("test_end");
    await server.close();
    await cleanupDirs(dirs);
  }
});
