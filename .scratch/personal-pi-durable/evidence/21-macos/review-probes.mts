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
import { PersonalWorkDoc, PersonalAgentsDoc, requestPersonalWorkCancel } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-work.ts";
import { PersonalDelegationDoc, listPersonalDelegations, personalDelegationProgress, cancelPersonalDelegation, type PersonalDelegationRef } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-delegation.ts";
import { personalReportResult } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-report.ts";
import { PersonalPermissionsDoc } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-permissions.ts";
import { ServiceWorkAdmission } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-service-operations.ts";
import { personalProvider, type PersonalModelConfig } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-model.ts";
import type { ServiceManagerConfig } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/service-helper.ts";
import { MockModelServer, type Responder } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/test/helpers/mock-provider.ts";

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
  fs.copyFileSync(new URL("file:///Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/test/helpers/fake-service-helper.mjs", import.meta.url), helperPath);
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
    calls: () => fs.existsSync(path.join(helper, "calls.log")) ? fs.readFileSync(path.join(helper, "calls.log"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]) : [],
    touch: (file: string, content = "") => fs.writeFileSync(path.join(helper, file), content),
  };
}
const input = (requestId: string, mode?: PersonalServiceMode, unit = UNIT, sourceRequestId = "owner") => ({ requestId, unit, sourceRequestId, ...(mode ? { mode } : {}) });
async function ready(p: PersonalHarness, ref: PersonalServiceOperationRef) { await until(async () => !!(await p.service!.status(ref)).operation.snapshot); }
async function unknown(p: PersonalHarness, ref: PersonalServiceOperationRef) { await until(async () => { const result = (await p.service!.status(ref)).operation.result; return result?.effect === "effect_unknown" && result.code !== "started"; }); }
async function finish(p: PersonalHarness, ref: PersonalServiceOperationRef) { return p.harness.waitForTask(ref.taskId, context); }

const childRestart: Responder = request => {
  if (!request.system?.includes("你是个人助手的子 Agent")) return { kind: "text", text: "主聊天继续" };
  const last = request.messages.at(-1);
  if (last?.role !== "tool") return { kind: "tool_calls", calls: [{ id: "restart", name: "service_restart", arguments: { unit: UNIT } }] };
  if ("next" in JSON.parse(String(last.content))) return { kind: "tool_calls", calls: [{ id: "read", name: "read_service_operation", arguments: { operation: (JSON.parse(String(last.content)) as { operation: number }).operation } }] };
  return { kind: "text", text: "原服务结果：" + String(last.content) };
};
async function childOperation(p: PersonalHarness) {
  let ref!: PersonalServiceOperationRef;
  await until(async () => { const item = (await p.service!.list()).items.find(item => item.operation.work); if (!item) return false; ref = item.operation.ref; return true; });
  return ref;
}

test("审查：子服务 preflight 之后的取消事实阻止检查启动", async t => {
  const f = await fixture(t, childRestart); const p = await f.open(); await p.answer("要求重启", "owner");
  const original = p.harness.commit.bind(p.harness); let armed = true;
  Object.assign(p.harness, { commit: async (change, ctx) => {
    const result = await original(change, ctx);
    if (armed && result === true) {
      armed = false;
      await original(async tx => {
        const agents = await tx.doc(PersonalAgentsDoc);
        await requestPersonalWorkCancel(tx, agents.agents[0].work!);
      }, ctx);
    }
    return result;
  } });
  const work = await p.work.delegate({ content: "重启", requestId: "race-cancel", sourceRequestId: "owner" });
  await p.harness.waitForTask(work.taskId, context);
  assert.equal(armed, false, "preflight 注入必须执行");
  assert.deepEqual(f.calls(), []);
});


test("审查：未消费 faulted 对模型明确返回失败", async t => {
  const f = await fixture(t, childRestart); const p = await f.open(); await p.answer("要求重启", "owner");
  const definition = (await p.main.agent(context)).extensions.find(e => e.name === "personal-service-operations")!.tasks![0].definition;
  const original = definition.phases.prepare;
  definition.phases.prepare = async () => { throw new Error("injected-before-consume"); };
  t.after(() => { definition.phases.prepare = original; });
  const work = await p.work.delegate({ content: "重启", requestId: "preconsume-fault", sourceRequestId: "owner" });
  await p.harness.waitForTask(work.taskId, context);
  const child = (await p.harness.conversation(work.agentId, context))!;
  const entries = (await child.entries({}, 256, undefined, context)).items;
  const results = entries.flatMap(entry => entry.model ?? []).filter(message => message.role === "toolResult" || message.role === "tool");
  const modelTools = f.server.calls.flatMap(call => call.messages.filter(m => m.role === "tool"));
  console.error("FAULTED-MODEL-RESULTS", JSON.stringify(modelTools));
  assert.match(JSON.stringify(modelTools), /faulted|not_executed|failed|未执行|故障/);
  assert.equal(f.calls().length, 0);
});


test("审查：保存成功主子工具往返快照", async t => {
 const f = await fixture(t, childRestart); const p = await f.open(); await p.answer("拥有者明确要求重启测试服务", "snapshot-owner");
 await p.harness.commit(async tx => { (await tx.doc(PersonalPermissionsDoc)).mode = "full_access"; }, context);
 const work = await p.work.delegate({content:"重启测试服务并读取原证据",requestId:"snapshot-roundtrip",sourceRequestId:"snapshot-owner"});
 await p.harness.waitForTask(work.taskId,context);
 const calls=f.server.calls.map((call,index)=>({index,role:call.system?.includes("你是个人助手的子 Agent")?"subagent":"main",systemPrompt:call.system,toolSchemas:call.tools,messages:call.messages,request:call.raw}));
 assert.equal(calls.length,4); assert.match(JSON.stringify(calls.at(-1)?.messages),/command_completed/); assert.match(JSON.stringify(calls.at(-1)?.messages),/inspect-op/);
 const child=(await p.harness.conversation(work.agentId,context))!; const entries=(await child.entries({},256,undefined,context)).items;
 fs.writeFileSync("/var/folders/y4/36h8kvvd4q52vjptp522rzfc0000gn/T/rk-review21-yx5dq91n/snapshots/after-tool-roundtrip.json",JSON.stringify({scenario:"仅本机 mock provider 和可执行 helper 桩；真实 Pi 工具调用/证据。非真实模型、systemd 或 IM。",calls,toolResults:entries.filter(entry=>entry.model?.some(message=>message.role==="toolResult"))},null,2)+"\n");
 assert.equal(f.starts(),1);
});
