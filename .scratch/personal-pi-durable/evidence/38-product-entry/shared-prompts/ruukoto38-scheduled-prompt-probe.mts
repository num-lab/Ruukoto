import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { ArtifactStore } from "/tmp/ruukoto38-pack-20261018-1/packages/agent/src/artifacts.ts";
import { parseRule, firstDue } from "/tmp/ruukoto38-pack-20261018-1/packages/channels/src/scheduler/time.ts";
import { startTestRuntime, waitFor } from "/tmp/ruukoto38-pack-20261018-1/test/helpers/testkit.ts";
const phase = process.argv[2];
const identity = process.argv[3] ?? "scheduled";
assert.ok(phase === "before" || phase === "after");
assert.ok(identity === "scheduled" || identity === "main");
const suffix = identity === "main" ? "-main" : "";
const target = { channel: "telegram", account: "1", chatId: "42", configVersion: 1 };
const clock = { now: Date.parse("2026-10-12T00:00:00Z") };
const t = await startTestRuntime("wfprompt", () => ({ kind: "text", text: "ROOT-ACK" }), { config: {
  qqDisabled: true, scheduler: { now: () => clock.now, tickMs: 0,
    channel: { target: () => target, send: async () => ({ platformMessageId: "sent" }) } },
} });
try {
  const rt = t.runtime, main = rt.store.getAgentRole("main")!;
  let taskId: string;
  if (identity === "main") {
    taskId = (await rt.submit({ sessionId: main.sessionId, requestId: "main-prompt", input: "启动工作流", accessMode: "full_access", modelSelection: rt.defaultSelection })).id;
  } else {
    const rule = parseRule({ kind: "once", at: "2026-10-12T00:00:01Z", time_zone: "UTC" });
    const schedule = rt.store.withTx(() => rt.sched.insertSchedule({ createKey: "workflow", paramsDigest: "workflow", createTaskId: null, createOpId: null,
      projectId: main.projectId, createPermissionVersion: 1, accessMode: "full_access", rule, instruction: "启动工作流", sourceRefs: [], target,
      nextDueAt: firstDue(rule, clock.now), tzData: "test", reason: "test" }, "test"));
    clock.now += 1000;
    await rt.scheduler!.tick();
    taskId = rt.sched.listRuns(schedule.id, 1)[0].rootTaskId!;
  }
  await waitFor("根请求完成", () => rt.store.getTask(taskId)!.status === "completed");
  const root = rt.store.getTask(taskId)!;
  assert.equal(root.status, "completed");
  assert.equal(t.server.calls.length, 1);
  const selection = rt.store.listSelectionRecordsByTask(root.id)[0];
  assert.ok(selection.promptArtifactId);
  const artifact = rt.store.getArtifact(selection.promptArtifactId)!;
  const snapshot = JSON.parse(new ArtifactStore(rt.config.dataDir, rt.store).read(artifact.id, 0, artifact.byteCount).toString("utf8"));
  const request = t.server.calls[0];
  const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const result = { phase, identity: rt.store.getSessionIdentity(root.sessionId),
    driverSha256: sha256("/tmp/ruukoto38-pack-20261018-1/packages/agent/src/driver.ts"),
    sessionFactorySha256: sha256("/tmp/ruukoto38-pack-20261018-1/packages/agent/src/session-factory.ts"),
    selection, snapshot, wireRequest: request.raw };
  fs.writeFileSync(`/tmp/ruukoto38-scheduled-prompt-${phase}${suffix}.json`, JSON.stringify(result, null, 2) + "\n");
  assert.equal(snapshot.systemPrompt, request.system);
  const reportText = identity === "main" ? "宿主向计划固定目标回报一次最终结果" : "宿主向创建时固定的目标发送一次最终回报，无目标则保存结果";
  assert.ok(snapshot.systemPrompt.includes(reportText));
  assert.equal(snapshot.systemPrompt.includes("notification_enqueue"), phase === "before");
  assert.equal(snapshot.systemPrompt.includes("service_manage"), phase === "before");
  process.stdout.write(JSON.stringify({ phase, identity, systemPrompt: selection.estimates.systemPrompt, toolSchemas: selection.estimates.toolSchemas,
    toolNames: request.tools?.map(tool => (tool.function as { name: string }).name), driverSha256: result.driverSha256, sessionFactorySha256: result.sessionFactorySha256 }) + "\n");
} finally { await t.shutdown(); }
