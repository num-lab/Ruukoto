import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, SessionFailed, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openPersonalHarness, type PersonalHarness } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-harness.ts";
import { PersonalServiceOperationDoc, PersonalServiceOperationsDoc, resolvePersonalServiceOperation, ServiceOperationEvidence, type PersonalServiceMode, type PersonalServiceOperationRef } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-service-operations.ts";
import { listPersonalServices, personalServiceDetail } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-service-controls.ts";
import { PersonalError } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-error.ts";
import { PersonalAgentsDoc, PersonalWorkDoc, personalWorkResult, personalWorkSummary, requestPersonalWorkCancel } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-work.ts";
import { PersonalDelegationDoc, listPersonalDelegations, personalDelegationProgress, cancelPersonalDelegation, type PersonalDelegationRef } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-delegation.ts";
import { personalReportResult } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-report.ts";
import { PersonalPermissionsDoc } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-permissions.ts";
import { PERSONAL_SERVICE_WORK, personalServiceOperations, ServiceWorkAdmission } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-service-operations.ts";
import { personalProvider, type PersonalModelConfig, type RequestEvidence } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-model.ts";
import type { ServiceManagerConfig } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/service-helper.ts";
import { PersonalMockModelServer as MockModelServer, type Responder } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/test/helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const UNIT = "personal-test.service";
const OTHER = "personal-other.service";
const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!await check()) { assert.ok(Date.now() < deadline, "等待服务操作超时"); await delay(10); }
}

async function fixture(t: TestContext, respond: Responder = () => ({ kind: "text", text: "收到" })) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "rk-service-op-"));
  const helper = path.join(root, "helper");
  fs.mkdirSync(path.join(helper, "units"), { recursive: true });
  fs.mkdirSync(path.join(helper, "ops"));
  const helperPath = path.join(helper, "helper.mjs");
  fs.copyFileSync(new URL("file:///Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/test/helpers/fake-service-helper.mjs"), helperPath);
  const policyPath = path.join(helper, "services.json");
  fs.writeFileSync(policyPath, JSON.stringify({ machineId: "test-machine", inspectUid: 1, inspectGid: 1, services: { [UNIT]: { actions: ["restart"] }, [OTHER]: { actions: ["restart"] } } }));
  for (const unit of [UNIT, OTHER]) fs.writeFileSync(path.join(helper, "units", unit), "[Service]\nExecStart=/usr/bin/true\n");
  fs.writeFileSync(path.join(helper, "state.json"), JSON.stringify(Object.fromEntries([UNIT, OTHER].map(unit => [unit, { loadState: "loaded", activeState: "active", subState: "running", mainPid: 123, invocationId: "before", result: "success", activeEnterTimestamp: "2026-10-17T00:00:00Z", starts: 0 }]))));
  const service: ServiceManagerConfig = { helperPath, policyPath, useSudo: false, sudoPath: "/usr/bin/sudo", timeouts: { inspectMs: 1000, restartMs: 2000, stopMs: 1000 } };
  const server = new MockModelServer(respond);
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await server.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_SERVICE_OP_TEST_KEY", contextWindow: 128000, maxTokens: 1024 };
  const previous = process.env[config.apiKeyEnv];
  process.env[config.apiKeyEnv] = "test-only";
  const options = { directory: path.join(root, "profile"), provider: personalProvider(config), modelId: config.modelId, service, serviceOperations: true };
  let personal: PersonalHarness | undefined;
  t.after(async () => {
    await personal?.close(); await server.close();
    if (previous === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, helper, config, options, server, service,
    open: async (overrides: Partial<Omit<Parameters<typeof openPersonalHarness>[0], "directory" | "profile">> = {}) => personal = await openPersonalHarness({ ...options, ...overrides }),
    starts: (unit = UNIT) => (JSON.parse(fs.readFileSync(path.join(helper, "state.json"), "utf8")) as Record<string, { starts: number }>)[unit].starts,
    calls: () => fs.existsSync(path.join(helper, "calls.log")) ? fs.readFileSync(path.join(helper, "calls.log"), "utf8").split("\n").slice(0, -1).map(line => JSON.parse(line) as string[]) : [],
    touch: (file: string, content = "") => fs.writeFileSync(path.join(helper, file), content),
  };
}
const input = (requestId: string, mode?: PersonalServiceMode, unit = UNIT, sourceRequestId = "owner") => ({ requestId, unit, sourceRequestId, ...(mode ? { mode } : {}) });
async function ready(p: PersonalHarness, ref: PersonalServiceOperationRef) { await until(async () => !!(await p.service!.status(ref)).operation.snapshot); }
async function unknown(p: PersonalHarness, ref: PersonalServiceOperationRef) { await until(async () => { const result = (await p.service!.status(ref)).operation.result; return result?.effect === "effect_unknown" && result.code !== "started"; }); }
async function finish(p: PersonalHarness, ref: PersonalServiceOperationRef) { return p.harness.waitForTask(ref.taskId, context); }
async function childOperation(p: PersonalHarness) {
  let ref!: PersonalServiceOperationRef;
  await until(async () => { const item = (await p.service!.list()).items.find(item => item.operation.work); if (!item) return false; ref = item.operation.ref; return true; });
  return ref;
}


test("独立补充：接纳前schema错误及同callId跨轮仍可核实真实结果", async t => {
  const f = await fixture(t, request => {
    if (!request.system?.includes("你是个人助手的子 Agent")) return { kind: "text", text: "主聊天" };
    return request.messages.at(-1)?.role === "tool" ? { kind: "text", text: "原工具参数无效，结束本项" } : { kind: "tool_calls", calls: [{ id: "same-refusal-id", name: "service_restart", arguments: { unit: "invalid" } }] };
  });
  const p = await f.open(); await p.answer("参数拒绝边界", "owner");
  const first = await p.work.delegate({ content: "第一项", requestId: "first-refusal", sourceRequestId: "owner" });
  assert.equal((await p.harness.waitForTask(first.taskId, context)).state.outcome.status, "completed");
  const child = (await p.harness.conversation(first.agentId, context))!;
  const original = (await child.entries({}, 256, undefined, context)).items;
  assert.equal((await p.service!.list()).items.length, 0); assert.equal(f.starts(), 0);
  const second = await p.work.delegate({ content: "第二项", requestId: "second-refusal", sourceRequestId: "owner", agentId: first.agentId });
  assert.equal((await p.harness.waitForTask(second.taskId, context)).state.outcome.status, "completed");
  const calls = f.server.calls.filter(r => r.system?.includes("你是个人助手的子 Agent"));
  assert.equal(calls.length, 4); assert.doesNotMatch(calls[3].system!, /以下是本身份历史服务操作/);
  assert.equal(calls[3].messages.filter(m => m.role === "tool").length, 2);
  const after = (await child.entries({}, 256, undefined, context)).items;
  const requests = after.filter(e => e.kind === "ruukoto.model-request").map(e => e.data as RequestEvidence);
  assert.equal(requests.filter(e => e.payload).length, 4);
  assert.ok(requests.every(e => !JSON.stringify(e.input).includes("personal-service-facts")));
  assert.equal((await p.service!.list()).items.length, 0); assert.equal(f.starts(), 0);
  for (const e of original) assert.deepEqual(after.find(row => row.id === e.id), e);
});


test("独立补充：仅移出旧result产生missing_result时拒绝请求而不伪造当前事实", async t => {
  const f = await fixture(t, request => request.system?.includes("你是个人助手的子 Agent") ? { kind: "tool_calls", calls: [{ id: "same-restart-id", name: "service_restart", arguments: { unit: UNIT } }] } : { kind: "text", text: "主聊天" });
  const p = await f.open(); await p.answer("部分移出边界", "owner");
  const first = await p.work.delegate({ content: "第一项", requestId: "partial-first", sourceRequestId: "owner" });
  const canceled = await childOperation(p); await ready(p, canceled); await p.work.cancel(first); await p.harness.waitForTask(first.taskId, context);
  const child = (await p.harness.conversation(first.agentId, context))!;
  const original = (await child.entries({}, 256, undefined, context)).items.find(e => e.kind === "pi.tool-result" && e.model?.some(m => m.role === "toolResult" && m.toolName === "service_restart"))!;
  await p.harness.commit(tx => tx.appendEntry(child.id, { kind: "partial-result-omit", edits: [{ target: original.id, action: "omit" }] }), context);
  const before = f.server.calls.length;
  const second = await p.work.delegate({ content: "第二项", requestId: "partial-second", sourceRequestId: "owner", agentId: first.agentId });
  assert.notEqual((await p.harness.waitForTask(second.taskId, context)).state.outcome.status, "completed");
  assert.equal(f.server.calls.length, before); assert.equal(f.starts(), 0);
  const after = (await child.entries({}, 256, undefined, context)).items;
  assert.ok(after.some(e => JSON.stringify(e).includes("原服务工具结果无法核实")));
  assert.deepEqual(after.find(e => e.id === original.id), original);
});
