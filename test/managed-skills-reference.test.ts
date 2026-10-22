import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { loadHostSkillLibrary, managedSkillsDirFor, ManagedSkillsStore } from "@ruukoto/agent/managed-skills.ts";
import { expandSkillCommand, readSkill } from "@ruukoto/agent/skills.ts";
import { latestAgentReferenceSnapshot, listAgentWaits } from "@ruukoto/core/agent-wait.ts";
import type { Session } from "@ruukoto/core/types.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { product as codeProduct } from "../apps/ruukoto-code/src/product.ts";
import { lastToolText, lastUserText, startTestRuntime, toolNamesOf, waitFor } from "./helpers/testkit.ts";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

test("托管校验在资源启动前失败：保留错误码、无模型调用或虚假占用，恢复后可继续", async () => {
  const t = await startTestRuntime("managed-reference-invalid", () => ({ kind: "text", text: "正常回答" }), { config: { product: codeProduct.runtime }, workDirs: 1 });
  try {
    const root = managedSkillsDirFor(t.dirs.agentDir), unknown = path.join(root, "unknown");
    fs.mkdirSync(unknown, { recursive: true, mode: 0o700 });
    const session = await t.runtime.createSession({ projectName: "invalid", cwd: t.work[0] });
    const task = await t.runtime.submit({ sessionId: session.id, requestId: "invalid", input: "检查", accessMode: "full_access", modelSelection: t.runtime.defaultSelection });
    await waitFor("无效托管区阻断任务", () => t.runtime.store.getTask(task.id)?.status === "failed");
    assert.match(t.runtime.store.getTask(task.id)?.errorMessage ?? "", /^skills_layout_invalid：/);
    assert.equal(t.server.calls.length, 0); assert.equal(t.runtime.store.listToolOpsByTask(task.id).length, 0);
    assert.equal(t.runtime.store.listAllOccupancy().some(held => held.taskId === task.id), false);
    fs.rmdirSync(unknown);
    const next = await t.runtime.submit({ sessionId: session.id, requestId: "restored", input: "继续", accessMode: "full_access", modelSelection: t.runtime.defaultSelection });
    await waitFor("恢复私有布局后可开始下一任务", () => ["completed", "failed", "interrupted"].includes(t.runtime.store.getTask(next.id)!.status));
    assert.equal(t.runtime.store.getTask(next.id)?.status, "completed"); assert.equal(t.server.calls.length, 1);
  } finally { await t.shutdown(); }
});

function holdWorkspace(runtime: Runtime, session: Session, requestId: string): string {
  return runtime.store.withTx(() => {
    const task = runtime.store.insertQueuedTask({ sessionId: session.id, requestId, input: requestId,
      modelSelection: runtime.defaultSelection, submissionDigest: requestId }).task;
    runtime.store.transitionTask(task.id, ["queued"], "running");
    assert.equal(runtime.store.tryAcquireOccupancy({ taskId: task.id, sessionId: session.id,
      cwdReal: session.cwdReal, cwdDev: session.cwdDev, cwdIno: session.cwdIno }), true);
    return task.id;
  });
}

for (const state of ["disabled", "removed"] as const) test(`托管技能 ${state}：ended wait 旧证据及同轮恢复可读，后续内部对话与重启不复活`, async () => {
  let originPhase = 0, runId = "";
  const newRequests: string[] = [];
  let preview: ReturnType<ManagedSkillsStore["preview"]>;
  const t = await startTestRuntime(`managed-reference-${state}`, request => {
    const input = lastUserText(request);
    if (input === "REFERENCE_ORIGIN") {
      assert.ok(toolNamesOf(request).includes("skill"));
      assert.match(JSON.stringify(request.messages), /\[技能目录\]/);
      switch (originPhase++) {
        case 0: return { kind: "tool_calls", calls: [{ id: "start", name: "workflow_start", arguments: {
          title: "等待中的引用来源", script: 'await ask("hold",{prompt:"保持等待"}); return "done";', input: null, key: "hold",
        } }] };
        case 1:
          runId = (JSON.parse(lastToolText(request)) as { run: { id: string } }).run.id;
          return { kind: "tool_calls", calls: [{ id: "wait", name: "agent_wait", arguments: { targets: [{ kind: "workflow", run_id: runId }], timeout_ms: 1 } }] };
        case 2:
          assert.equal(new ManagedSkillsStore(t.dirs.agentDir).get(preview.id).state, state);
          return { kind: "tool_calls", calls: [{ id: "body", name: "skill", arguments: { name: "managed-reference" } }] };
        case 3:
          assert.match(lastToolText(request), /REFERENCE-BODY/);
          return { kind: "tool_calls", calls: [{ id: "reference", name: "skill", arguments: { name: "managed-reference", path: "refs/guide.md" } }] };
        default:
          assert.match(lastToolText(request), /REFERENCE-GUIDE/);
          return { kind: "text", text: "同一任务恢复后仍可读取钉版技能" };
      }
    }
    assert.ok(input.startsWith("REFERENCE_NEW"), input);
    assert.ok(!toolNamesOf(request).includes("skill"));
    assert.ok(!JSON.stringify(request.messages).includes("[技能目录]"), "新参考块不复活旧托管选择，历史正文仍保留");
    newRequests.push(input);
    return { kind: "text", text: "旧技能已从本次选择中排除" };
  }, { config: { product: codeProduct.runtime }, workDirs: 1 });
  let restarted: Runtime | null = null;
  try {
    const managed = new ManagedSkillsStore(t.dirs.agentDir), sourcePath = path.join(t.dirs.root, "managed-reference");
    fs.mkdirSync(path.join(sourcePath, "refs"), { recursive: true });
    const source = fs.realpathSync(sourcePath), raw = "---\nname: managed-reference\ndescription: MANAGED-REFERENCE-DESCRIPTION\n---\nREFERENCE-BODY 见 refs/guide.md\n";
    fs.writeFileSync(path.join(source, "SKILL.md"), raw);
    fs.writeFileSync(path.join(source, "refs/guide.md"), "REFERENCE-GUIDE\n");
    preview = managed.preview(source);
    managed.import({ id: preview.id, sourceDir: preview.sourceDir, contentRevision: preview.contentRevision, expectedRevision: preview.revision });
    const runtime = t.runtime, session = await runtime.createSession({ projectName: "reference", cwd: t.work[0] });
    const blocker = await runtime.createSession({ projectName: "blocker", cwd: t.work[0] });
    const driver = await runtime["getDriver"](session), agentWait = driver["deps"].agentWait!;
    const originalWait = agentWait.wait;
    // 真实等待已落盘结束，清单在同轮重取目录之前变化，用例守住恢复不重新扫描技能。
    agentWait.wait = async (...args) => {
      const result = await originalWait(...args);
      const wait = listAgentWaits(runtime.store, { taskId: args[0].taskId }).at(-1)!;
      assert.equal(wait.phase, "ended");
      assert.equal(wait.snapshot.skills?.skills[0]?.id, preview.id);
      const expectedRevision = managed.list().revision;
      if (state === "disabled") managed.setEnabled({ id: preview.id, enabled: false, expectedRevision });
      else managed.remove({ id: preview.id, expectedRevision });
      return result;
    };
    const origin = await runtime.submit({ sessionId: session.id, requestId: "origin", input: "REFERENCE_ORIGIN", accessMode: "full_access", modelSelection: runtime.defaultSelection });
    await waitFor("原任务恢复后读完钉版正文与引用", () => {
      const current = runtime.store.getTask(origin.id)!;
      assert.ok(!["failed", "interrupted", "canceled"].includes(current.status), current.errorMessage ?? current.interruptReason ?? current.status);
      return current.status === "completed";
    }, 30_000);
    const wait = listAgentWaits(runtime.store, { taskId: origin.id }).at(-1)!;
    assert.equal(wait.phase, "ended");
    const snapshot = latestAgentReferenceSnapshot(runtime.store, session.id)!;
    assert.deepEqual(snapshot, wait.snapshot);
    assert.ok(snapshot.skills?.version);
    assert.ok(snapshot.selectionRecordId && snapshot.promptArtifactId);
    const savedSnapshot = hash(JSON.stringify(snapshot)), savedWait = hash(JSON.stringify(wait));
    const historyFile = runtime.store.getSession(session.id)!.sessionFile!, oldHistory = fs.readFileSync(historyFile);
    const oldHistoryHash = hash(oldHistory), oldSelection = hash(JSON.stringify(runtime.store.listSelectionRecordsByTask(origin.id)));
    const promptHashes = runtime.store.listSelectionRecordsByTask(origin.id).map(record => {
      assert.ok(record.promptArtifactId);
      const artifact = runtime.store.getArtifact(record.promptArtifactId)!;
      return { id: artifact.id, bytes: artifact.byteCount, hash: hash(runtime.artifacts.read(artifact.id, 0, artifact.byteCount)) };
    });
    const pinned = snapshot.skills!.skills.find(skill => skill.id === preview.id)!;
    const oldDirectory = pinned.dir;
    function verifyOldEvidence(current: Runtime) {
      assert.equal(hash(JSON.stringify(latestAgentReferenceSnapshot(current.store, session.id))), savedSnapshot);
      assert.equal(hash(JSON.stringify(listAgentWaits(current.store, { taskId: origin.id }).at(-1))), savedWait);
      assert.equal(hash(fs.readFileSync(historyFile).subarray(0, oldHistory.length)), oldHistoryHash);
      assert.equal(hash(JSON.stringify(current.store.listSelectionRecordsByTask(origin.id))), oldSelection);
      for (const prompt of promptHashes) assert.equal(hash(current.artifacts.read(prompt.id, 0, prompt.bytes)), prompt.hash);
      assert.equal(pinned.dir, oldDirectory);
      assert.equal(fs.readFileSync(path.join(pinned.dir, "SKILL.md"), "utf8"), raw);
      assert.match(readSkill(snapshot.skills, "managed-reference"), /REFERENCE-BODY/);
      assert.match(readSkill(snapshot.skills, "managed-reference", "refs/guide.md"), /REFERENCE-GUIDE/);
      assert.equal(fs.readFileSync(path.join(source, "SKILL.md"), "utf8"), raw);
      assert.equal(loadHostSkillLibrary(t.dirs.agentDir).skills.length, 0);
      assert.throws(() => expandSkillCommand(loadHostSkillLibrary(t.dirs.agentDir), "/skill:managed-reference"), /未知技能/);
    }
    async function verifyNewSelection(current: Runtime, label: string) {
      const blockerTaskId = holdWorkspace(current, blocker, `block-${label}`);
      const next = await current.submit({ sessionId: session.id, requestId: `next-${label}`, input: `REFERENCE_NEW_${label}`, accessMode: "full_access", modelSelection: current.defaultSelection });
      await waitFor("新任务通过 ended wait 参考进入内部对话", () => ["completed", "failed", "interrupted"].includes(current.store.getTask(next.id)!.status));
      assert.equal(current.store.getTask(next.id)?.status, "completed", current.store.getTask(next.id)?.errorMessage ?? "新任务未完成");
      const records = current.store.listSelectionRecordsByTask(next.id);
      assert.equal(records.length, 1);
      assert.equal(records[0].skillVersion, "", "新选择记录保存当前清单过滤结果");
      const before = t.server.calls.length;
      const explicit = await current.submit({ sessionId: session.id, requestId: `explicit-${label}`, input: "/skill:managed-reference", accessMode: "full_access", modelSelection: current.defaultSelection });
      await waitFor("新显式调用明确拒绝", () => ["completed", "failed", "interrupted"].includes(current.store.getTask(explicit.id)!.status));
      assert.equal(current.store.getTask(explicit.id)?.status, "failed");
      assert.match(current.store.getTask(explicit.id)?.errorMessage ?? "", /未知技能/);
      assert.equal(t.server.calls.length, before, "失败的显式展开不发送模型请求");
      verifyOldEvidence(current);
      current.store.withTx(() => current.store.endTask(blockerTaskId, ["running"], "completed"));
    }
    await verifyNewSelection(runtime, "before_restart");
    const config = runtime.config;
    t.client.close();
    await runtime.stop("reference_restart");
    restarted = await Runtime.start(config);
    verifyOldEvidence(restarted);
    await verifyNewSelection(restarted, "after_restart");
    assert.deepEqual(newRequests, ["REFERENCE_NEW_before_restart", "REFERENCE_NEW_after_restart"]);
  } finally {
    if (restarted) await restarted.stop("reference_test_end");
    await t.shutdown();
  }
});
