import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Db, SchemaVersionError } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import type { McpCuaOperation } from "@ruukoto/core/types.ts";
import { ArtifactStore } from "@ruukoto/agent/artifacts.ts";
import { McpStore } from "@ruukoto/agent/mcp/store.ts";
import { CodeCuaManager } from "@ruukoto/agent/mcp/code.ts";
import { product } from "../apps/ruukoto-code/src/product.ts";
import { startTestRuntime, createProjectSession, waitFor, pendingConfirmation } from "./helpers/testkit.ts";
import type { Responder } from "./helpers/mock-provider.ts";
import { withMcpDiscovery } from "./helpers/mock-mcp.ts";

const MODEL = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" } as const;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const available = process.platform === "darwin" && fs.existsSync(new URL("../worker/native-macos-supervisor", import.meta.url));

test("Code Cua：拒绝49/50旧库且保留配置、证据、JSONL与凭据", () => {
  for (const version of [49, 50]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cua-old-schema-"));
    try {
      const db = new Db(directory), store = new McpStore(db);
      store.upsertService({ name: "http", endpoint: "https://example.com/mcp", toolAllowlist: ["read"] });
      assert.equal(db.prepare("PRAGMA table_info(mcp_services)").all().some(row => row.name === "project_id"), false);
      db.close();
      const file = path.join(directory, "ruukoto.db"), old = new DatabaseSync(file);
      old.exec("ALTER TABLE mcp_services ADD COLUMN project_id TEXT; UPDATE mcp_services SET project_id = 'old-project';");
      if (version === 49) old.exec("ALTER TABLE mcp_services DROP COLUMN cua_config; ALTER TABLE tool_ops DROP COLUMN mcp;");
      old.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(version));
      const schema = old.prepare("SELECT sql FROM sqlite_schema ORDER BY name").all();
      const rows = old.prepare("SELECT * FROM mcp_services").all();
      old.close();
      const history = path.join(directory, "session.jsonl"), credentials = path.join(directory, "credentials.json");
      fs.writeFileSync(history, '{"type":"message","content":"原会话"}\n');
      fs.writeFileSync(credentials, '{"bindings":[{"secret":"原秘密"}]}\n');
      const original = [file, history, credentials].map(file => fs.readFileSync(file));
      assert.throws(() => new Db(directory), error => error instanceof SchemaVersionError && error.code === "schema_version_unsupported");
      assert.deepEqual([file, history, credentials].map(file => fs.readFileSync(file)), original);
      const preserved = new DatabaseSync(file, { readOnly: true });
      assert.deepEqual(preserved.prepare("SELECT sql FROM sqlite_schema ORDER BY name").all(), schema);
      assert.deepEqual(preserved.prepare("SELECT * FROM mcp_services").all(), rows);
      assert.equal(preserved.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()!.value, String(version));
      preserved.close();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
});

test("Code Cua：原操作冷恢复冻结跨配置，缺停止/观察/接受均拒绝", async () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cua-cold-"))), db = new Db(directory), store = new Store(db);
  try {
    const project = store.createProject("cua"), stat = fs.statSync(directory);
    const session = store.createSession({ projectId: project.id, cwd: directory, cwdReal: directory, cwdDev: stat.dev, cwdIno: stat.ino, piSessionId: "cold", confirmTools: [] });
    const task = store.insertQueuedTask({ sessionId: session.id, requestId: "old", input: "old", modelSelection: MODEL, submissionDigest: "old" }).task;
    store.withTx(() => {
      store.recordToolIntent({ id: "old-op", taskId: task.id, sessionId: session.id, toolName: "mcp_mac_click", params: { x: 1 } });
      store.saveMcpOperation("old-op", { serviceId: "old-service", configVersion: 1, effect: "write", rawTool: { name: "click", inputSchema: {} }, modelTool: { name: "mcp_mac_click", inputSchema: {} }, arguments: { x: 1 }, execution: { executionId: "native_" + "a".repeat(24), directory, fingerprint: "b".repeat(64) }, state: "sent", request: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "click", arguments: { x: 1 } } }) });
    });
    const manager = new CodeCuaManager(store, new McpStore(db), new ArtifactStore(directory, store), directory);
    store.withTx(() => {
      store.recordToolIntent({ id: "starting-op", taskId: task.id, sessionId: session.id, toolName: "cua_connection", params: {} });
      const original = store.getToolOp("old-op")!.mcp! as McpCuaOperation;
      store.saveMcpOperation("starting-op", { ...original, effect: "read", state: "starting", request: undefined, execution: { ...original.execution, executionId: "native_" + "c".repeat(24) } });
    });
    manager.recover();
    assert.equal(store.getToolOp("starting-op")!.mcp!.state, "frozen", "启动期间重启也保留待核实身份");
    assert.ok(store.getToolOp("old-op")!.mcp!.request, "状态投影和恢复不能丢弃原请求");
    assert.equal(manager.status().state, "frozen");
    assert.throws(() => manager.assertConfigurationChange(), { code: "cua_binding_active" });
    await assert.rejects(manager.observe(), { code: "cua_recovery_precondition" });
    assert.throws(() => manager.accept("unseen"), { code: "cua_observation_changed" });
    assert.equal(store.getToolOp("old-op")!.mcp!.response, undefined);
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("Code Cua：真实产品链保存原schema和请求，持续连接、批准撤销、未知冻结及人工恢复", { skip: !available }, async t => {
  let next: { name: string; arguments: Record<string, unknown> } | null = null;
  const responder: Responder = async () => {
    const call = next; next = null;
    return call ? { kind: "tool_calls", calls: [{ id: `call-${Date.now()}`, ...call }] } : { kind: "text", text: "done" };
  };
  const runtime = await startTestRuntime("cua-code", withMcpDiscovery(responder), { config: { product: product.runtime, mcp: { callTimeoutMs: 300 } } });
  const { client, dirs } = runtime;
  const executable = path.join(dirs.root, "cua-fixture"), record = path.join(dirs.root, "calls.jsonl");
  const tools = [
    { name: "get_desktop_state", description: "观察当前画面", inputSchema: { type: "object", properties: { screenshot_out_file: { type: "string" } } } },
    { name: "click", description: "点击画面", inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, scope: { type: "string" }, mode: { type: "string" }, debug_image_out: { type: "string" }, session: { type: "string" } }, required: ["x", "y"] } },
    { name: "run_script", inputSchema: { type: "object", properties: {} } },
  ];
  fs.writeFileSync(executable, `#!${process.execPath}\nimport fs from 'node:fs';import readline from 'node:readline';const record=${JSON.stringify(record)},tools=${JSON.stringify(tools)};if(process.argv[2]==='dump-docs'){process.stdout.write(JSON.stringify({version:'0.38.0',tools:tools.map(t=>({name:t.name,description:t.description??'',input_schema:t.inputSchema}))}));process.exit(0);}fs.appendFileSync(record,JSON.stringify({start:process.pid})+'\\n');for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;let result;if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'offline-cua',version:'0.38.0'}};else if(m.method==='tools/list')result={tools};else if(m.method==='tools/call'){fs.appendFileSync(record,JSON.stringify({...m,pid:process.pid})+'\\n');if(m.params.arguments.mode==='lost')continue;if(m.params.arguments.mode==='incomplete'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{resultType:'input_required',content:[]}})+'\\n');continue;}if(m.params.arguments.mode==='error'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'known failure'}})+'\\n');continue;}result={content:m.params.name==='get_desktop_state'?[{type:'image',data:${JSON.stringify(PNG)},mimeType:'image/png'}]:[{type:'text',text:'clicked'}]};}else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}\n`, { mode: 0o700 });
  const cua = { kind: "cua-mac", executable, version: "0.38.0", sha256: createHash("sha256").update(fs.readFileSync(executable)).digest("hex") } as const;
  const calls = () => fs.existsSync(record) ? fs.readFileSync(record, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  const sent = () => calls().filter(call => call.method === "tools/call");
  let vision = false;
  const resolve = runtime.runtime.models.current.modelCatalog.resolve.bind(runtime.runtime.models.current.modelCatalog);
  runtime.runtime.models.current.modelCatalog.resolve = async selection => ({ ...await resolve(selection), input: vision ? ["text", "image"] : ["text"] });
  async function submit(sessionId: string, key: string, tool?: string, args: Record<string, unknown> = {}, mode = "full_access") {
    next = tool ? { name: `mcp__mac__${tool}`, arguments: args } : null;
    const task = await client.request<{ id: string }>("submit", { session_id: sessionId, request_id: key, input: key, model_selection: MODEL, access_mode: mode });
    return task.id;
  }
  async function done(id: string) {
    await waitFor("Cua task ended", () => ["completed", "failed", "canceled", "interrupted"].includes(runtime.runtime.store.getTask(id)!.status));
    return runtime.runtime.store.getTask(id)!;
  }
  try {
    const initial = await createProjectSession(client, runtime.work[0]);
    const projectId = initial.projectId;
    let sessionId = initial.sessionId;
    const plain = await submit(sessionId, "baseline"); await done(plain);
    let service = await client.request<{ id: string; configVersion: number }>("mcp_configure", { name: "mac", cua, tool_allowlist: ["get_desktop_state", "click", "run_script"] });
    const checked = await client.request<{ ok: boolean; tools: { name: string }[]; permissions: { accessibility: boolean; screenRecording: boolean } }>("mcp_check", { service_id: service.id });
    assert.equal(checked.ok, checked.permissions.accessibility && checked.permissions.screenRecording);
    assert.deepEqual(checked.tools.map(tool => tool.name), ["get_desktop_state", "click"]);
    assert.equal(calls().length, 0, "连接检查不创建额外电脑执行");
    const recordResult = runtime.runtime.store.recordToolResult.bind(runtime.runtime.store);
    let startupWriteFailed = false;
    runtime.runtime.store.recordToolResult = (opId, summary, isError) => {
      if (!startupWriteFailed && runtime.runtime.store.getToolOp(opId)?.toolName === "cua_connection") { startupWriteFailed = true; throw new Error("fixture startup result write failed"); }
      return recordResult(opId, summary, isError);
    };
    vision = true;
    const startupFailure = await submit(sessionId, "startup-result-failure", "get_desktop_state"); await done(startupFailure);
    runtime.runtime.store.recordToolResult = recordResult;
    try { await waitFor("初始化失败的执行停止证明", () => runtime.runtime.store.listToolOpsByTask(startupFailure).find(op => op.toolName === "cua_connection")?.mcp?.state === "closed"); }
    catch (error) {
      const operation = runtime.runtime.store.listToolOpsByTask(startupFailure).find(op => op.toolName === "cua_connection")!.mcp!;
      const receipt = path.join(operation.execution!.directory, operation.execution!.executionId, "stopped.json");
      const raw = fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt, "utf8")) : {};
      t.diagnostic(JSON.stringify({ startupStop: { state: operation.state, reason: raw.reason, reaped: raw.reaped, stdoutEof: raw.stdoutEof, stderrEof: raw.stderrEof, receipt: fs.existsSync(receipt) } }));
      throw error;
    }
    const failedStartup = runtime.runtime.store.listToolOpsByTask(startupFailure).find(op => op.toolName === "cua_connection")!;
    assert.equal(failedStartup.mcp!.state, "closed");
    assert.ok(failedStartup.mcp!.stoppedAt, "官方初始化结果落盘失败也核实原执行停止");
    assert.equal(sent().length, 0);
    await client.request("mcp_cua_stop", {});
    vision = false;
    const textOnly = await submit(sessionId, "text-model", "click", { x: 1, y: 2 }); await done(textOnly);
    assert.equal(sent().length, 0, "不支持视觉时零发送");
    await client.request("mcp_cua_stop", {});
    sessionId = (await client.request<{ id: string }>("create_session", { project_id: projectId, cwd: runtime.work[1], confirm_tools: [] })).id;
    vision = true;
    const observe = await submit(sessionId, "observe", "get_desktop_state"); await done(observe);
    const first = runtime.runtime.store.listToolOpsByTask(observe).find(op => op.mcp && op.toolName !== "cua_connection")!;
    assert.ok(first, JSON.stringify(runtime.runtime.store.getEventsAfter(0).filter(event => event.taskId === observe).map(event => event.body)));
    const otherDriver = await runtime.runtime["getDriver"](runtime.runtime.store.getSession(initial.sessionId)!);
    await otherDriver.dispose();
    const currentComputer = await client.request<{ state: string; sessionId: string }>("mcp_cua_status", {});
    assert.equal(currentComputer.state, "active", "无关会话销毁 SDK 不得停止当前电脑连接");
    assert.equal(currentComputer.sessionId, sessionId);
    const beforeOtherPause = calls().length;
    await assert.rejects(client.request("mcp_cua_stop", { service_id: "another-service" }), /当前电脑连接属于另一服务/);
    assert.equal((await client.request<{ state: string }>("mcp_cua_status", {})).state, "active");
    assert.equal(calls().length, beforeOtherPause, "其他配置的暂停不能停止当前电脑绑定");
    assert.ok(first.mcp && !("transport" in first.mcp));
    assert.ok(first.mcp.rawTool.inputSchema.properties && "screenshot_out_file" in (first.mcp!.rawTool.inputSchema.properties as object));
    assert.ok(!("screenshot_out_file" in (first.mcp!.modelTool.inputSchema.properties as object)));
    assert.equal(JSON.parse(first.mcp!.request!).params.name, "get_desktop_state");
    const request = runtime.server.calls.find(call => JSON.stringify(call.tools).includes("mcp__mac__get_desktop_state"))!;
    assert.ok(!JSON.stringify(request.tools).includes("screenshot_out_file"));
    assert.ok(!JSON.stringify(request.tools).includes("debug_image_out"));
    assert.ok(!JSON.stringify(request.tools).includes("run_script"));
    assert.match(JSON.stringify(request.tools), /连接中断或结果未知时停止电脑操作/);
    const before = runtime.runtime.store.listSelectionRecordsByTask(plain)[0].estimates;
    const after = runtime.runtime.store.listSelectionRecordsByTask(observe)[0].estimates;
    t.diagnostic(JSON.stringify({ before: { toolSchemas: before.toolSchemas, systemPrompt: before.systemPrompt }, after: { toolSchemas: after.toolSchemas, systemPrompt: after.systemPrompt } }));
    const importImage = runtime.runtime.artifacts.importImage.bind(runtime.runtime.artifacts);
    runtime.runtime.artifacts.importImage = () => { throw new Error("fixture image storage failed"); };
    const failedObservation = await submit(sessionId, "image-storage-failure", "get_desktop_state"); await done(failedObservation);
    runtime.runtime.artifacts.importImage = importImage;
    const beforeStale = sent().length;
    const stale = await submit(sessionId, "stale-observation", "click", { x: 9, y: 9 }); await done(stale);
    assert.equal(sent().length, beforeStale, "未保存的新画面不能放行下一次点击");
    const fresh = await submit(sessionId, "fresh-observation", "get_desktop_state"); await done(fresh);
    const error = await submit(sessionId, "known-error", "click", { scope: "desktop", x: 1, y: 2, mode: "error" }); await done(error);
    assert.equal((await client.request<{ state: string }>("mcp_cua_status", {})).state, "active", "完整错误应答不会冻结");
    const saveMcp = runtime.runtime.store.saveMcpOperation.bind(runtime.runtime.store);
    runtime.runtime.store.saveMcpOperation = (id, operation) => {
      if (operation.state === "sent" && !("transport" in operation) && operation.arguments.mode === "disk") throw new Error("fixture write failed");
      saveMcp(id, operation);
    };
    const disk = await submit(sessionId, "record-failure", "click", { scope: "desktop", x: 5, y: 6, mode: "disk" }, "confirm");
    const diskApproval = await pendingConfirmation(client, disk), beforeDisk = sent().length;
    await client.request("respond_confirmation", { confirmation_id: diskApproval.id, decision: "approve" }); await done(disk);
    runtime.runtime.store.saveMcpOperation = saveMcp;
    assert.equal(sent().length, beforeDisk, "原请求记录失败时零发送");
    assert.equal(runtime.runtime.store.getConfirmation(diskApproval.id)!.consumedAt, null, "批准消费与原请求保存一起回滚");
    const approved = await submit(sessionId, "approval", "click", { scope: "desktop", x: 2, y: 3 }, "confirm");
    const confirmation = await pendingConfirmation(client, approved);
    const beforeApproval = sent().length;
    await client.request("mcp_set_enabled", { service_id: service.id, enabled: false, expected_version: service.configVersion });
    await client.request("respond_confirmation", { confirmation_id: confirmation!.id, decision: "approve" });
    await done(approved);
    assert.equal(sent().length, beforeApproval, "撤销配置使旧批准失效");
    await client.request("mcp_cua_stop", {});
    service = await client.request("mcp_set_enabled", { service_id: service.id, enabled: true });
    const newObserve = await submit(sessionId, "observe-again", "get_desktop_state"); await done(newObserve);
    const lost = await submit(sessionId, "lost", "click", { scope: "desktop", x: 3, y: 4, mode: "lost" }); await done(lost);
    const oldOp = runtime.runtime.store.listToolOpsByTask(lost).find(op => op.mcp && op.toolName !== "cua_connection")!;
    assert.equal(oldOp.effectUnknown, true);
    assert.equal(oldOp.mcp!.state, "frozen");
    assert.equal((await client.request<{ state: string }>("mcp_cua_status", {})).state, "frozen");
    await assert.rejects(client.request("mcp_configure", { name: "mac", cua: { ...cua, sha256: "f".repeat(64) }, tool_allowlist: ["click"] }));
    await assert.rejects(client.request("mcp_cua_observe", {}));
    await client.request("mcp_cua_stop", {});
    await assert.rejects(client.request("mcp_cua_accept", {}));
    await client.request("mcp_cua_observe", {});
    const recovery = await client.request<{ observation: { id: string; artifactIds: string[] } }>("mcp_cua_status", {});
    assert.ok(recovery.observation.artifactIds.length);
    await client.request("mcp_cua_observe", {});
    await assert.rejects(client.request("mcp_cua_accept", { observation_id: recovery.observation.id }), /观察已变化/);
    const currentObservation = await client.request<{ observation: { id: string } }>("mcp_cua_status", {});
    service = runtime.runtime.mcpSetEnabled(service.id, false);
    await assert.rejects(client.request("mcp_cua_accept", { observation_id: currentObservation.observation.id }), /电脑配置已变化/);
    const beforeDisabledObserve = sent().length;
    await assert.rejects(client.request("mcp_cua_observe", {}), /原电脑配置已改变/);
    assert.equal(sent().length, beforeDisabledObserve, "停用时重观察零发送并废弃旧图");
    await assert.rejects(client.request("mcp_cua_accept", { observation_id: currentObservation.observation.id }), /观察已变化/);
    service = runtime.runtime.mcpSetEnabled(service.id, true);
    await client.request("mcp_cua_observe", {});
    const beforeStorageFailure = await client.request<{ observation: { id: string } }>("mcp_cua_status", {});
    runtime.runtime.artifacts.importImage = () => { throw new Error("fixture recovery image storage failed"); };
    await assert.rejects(client.request("mcp_cua_observe", {}));
    runtime.runtime.artifacts.importImage = importImage;
    await assert.rejects(client.request("mcp_cua_accept", { observation_id: beforeStorageFailure.observation.id }), /观察已变化/);
    const beforeRevocation = sent().filter(call => call.params.name === "get_desktop_state").length;
    let observationPrepared = false;
    runtime.runtime.store.saveMcpOperation = (id, operation) => {
      saveMcp(id, operation);
      if (!observationPrepared && operation.state === "prepared" && runtime.runtime.store.getToolOp(id)?.toolName === "cua_recovery_observe") {
        observationPrepared = true;
        queueMicrotask(() => runtime.runtime.mcpSetEnabled(service.id, false));
      }
    };
    await assert.rejects(client.request("mcp_cua_observe", {}), /配置已停用或变化/);
    runtime.runtime.store.saveMcpOperation = saveMcp;
    assert.equal(observationPrepared, true);
    assert.equal(sent().filter(call => call.params.name === "get_desktop_state").length, beforeRevocation, "prepared 后撤销也不得发送恢复截图请求");
    service = runtime.runtime.mcpSetEnabled(service.id, true);
    await client.request("mcp_cua_observe", {});
    const finalObservation = await client.request<{ observation: { id: string } }>("mcp_cua_status", {});
    await client.request("mcp_cua_accept", { observation_id: finalObservation.observation.id });
    assert.equal((await client.request<{ state: string }>("mcp_cua_status", {})).state, "idle");
    assert.equal(runtime.runtime.store.getToolOp(oldOp.id)!.effectUnknown, true);
    assert.equal(runtime.runtime.store.getToolOp(oldOp.id)!.mcp!.response, undefined);
    assert.equal(sent().filter(call => call.params.arguments.mode === "lost").length, 1);
    assert.equal(new Set(sent().slice(0, 2).map(call => call.pid)).size, 1, "同一连接跨任务保持进程");
    const observedAfterRecovery = await submit(sessionId, "new-work-observe", "get_desktop_state"); await done(observedAfterRecovery);
    const incomplete = await submit(sessionId, "incomplete", "click", { scope: "desktop", x: 7, y: 8, mode: "incomplete" }); await done(incomplete);
    const incompleteOp = runtime.runtime.store.listToolOpsByTask(incomplete).find(op => op.mcp && op.toolName !== "cua_connection")!;
    assert.equal(incompleteOp.effectUnknown, true);
    assert.equal(incompleteOp.mcp!.state, "frozen", "非终结应答不能开放新输入");
    assert.ok(incompleteOp.mcp!.response);
    assert.equal(sent().filter(call => call.params.arguments.mode === "incomplete").length, 1);
  } finally { await runtime.shutdown(); }
});

test("Code Cua：窗口观察授权元素动作与批次，坐标需截图，get_guide 只读", { skip: !available }, async t => {
  let next: { name: string; arguments: Record<string, unknown> } | null = null;
  const responder: Responder = async () => {
    const call = next; next = null;
    return call ? { kind: "tool_calls", calls: [{ id: `call-${Date.now()}`, ...call }] } : { kind: "text", text: "done" };
  };
  const runtime = await startTestRuntime("cua-batch", withMcpDiscovery(responder), { config: { product: product.runtime, mcp: { callTimeoutMs: 300 } } });
  const { client, dirs } = runtime;
  const TREE = "snapshot s00000001\n- [14] AXButton \"保存\"\n- [20] AXTextField \"名称\"";
  const executable = path.join(dirs.root, "cua-fixture"), record = path.join(dirs.root, "calls.jsonl");
  const tools = [
    { name: "get_window_state", description: "观察窗口", inputSchema: { type: "object", properties: { pid: { type: "integer" }, window_id: { type: "integer" }, include_screenshot: { type: "boolean" }, screenshot_out_file: { type: "string" } }, required: ["pid", "window_id"] } },
    { name: "get_guide", description: "只读指南", inputSchema: { type: "object", properties: { topic: { type: "string" }, session: { type: "string" } } } },
    { name: "click", description: "点击", inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, pid: { type: "integer" }, window_id: { type: "integer" }, element_token: { type: "string" }, session: { type: "string" } } } },
    { name: "run_steps", description: "批次", inputSchema: { type: "object", properties: { steps: { type: "array" }, session: { type: "string" }, foreground_fallback: { type: "boolean" } } } },
  ];
  fs.writeFileSync(executable, `#!${process.execPath}\nimport fs from 'node:fs';import readline from 'node:readline';const record=${JSON.stringify(record)},tools=${JSON.stringify(tools)};if(process.argv[2]==='dump-docs'){process.stdout.write(JSON.stringify({version:'0.38.0',tools:tools.map(t=>({name:t.name,description:t.description??'',input_schema:t.inputSchema}))}));process.exit(0);}fs.appendFileSync(record,JSON.stringify({start:process.pid})+'\\n');let obs=1;for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;let result;if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'offline-cua',version:'0.38.0'}};else if(m.method==='tools/list')result={tools};else if(m.method==='tools/call'){fs.appendFileSync(record,JSON.stringify(m)+'\\n');const a=m.params.arguments;if(m.params.name==='get_window_state')result={content:[{type:'text',text:${JSON.stringify(TREE)}}],structuredContent:{pid:a.pid,window_id:a.window_id,snapshot_id:a.window_id===8?'s00000008':'s0000000'+(obs++),elements:[],truncated:false}};else if(m.params.name==='get_guide')result={content:[{type:'text',text:'topics: overview, batching'}]};else if(m.params.name==='run_steps')result={content:[{type:'text',text:'2 steps executed'}],structuredContent:{ok:true,executed:2,results:[{ok:true},{ok:true}],observation:a.window_id===8?{ok:false,error:'window_id_not_found'}:{ok:true,state:{pid:a.pid,window_id:a.window_id,snapshot_id:'s00000002',invalidated_snapshot_ids:['s00000001']}}}};else result={content:[{type:'text',text:'done'}]};}else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}\n`, { mode: 0o700 });
  const cua = { kind: "cua-mac", executable, version: "0.38.0", sha256: createHash("sha256").update(fs.readFileSync(executable)).digest("hex") } as const;
  const calls = () => fs.existsSync(record) ? fs.readFileSync(record, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  const sent = (name: string) => calls().filter(call => call.method === "tools/call" && call.params.name === name);
  const resolve = runtime.runtime.models.current.modelCatalog.resolve.bind(runtime.runtime.models.current.modelCatalog);
  runtime.runtime.models.current.modelCatalog.resolve = async selection => ({ ...await resolve(selection), input: ["text"] });
  async function submit(sessionId: string, key: string, tool?: string, args: Record<string, unknown> = {}, mode = "full_access") {
    next = tool ? { name: `mcp__mac__${tool}`, arguments: args } : null;
    const task = await client.request<{ id: string }>("submit", { session_id: sessionId, request_id: key, input: key, model_selection: MODEL, access_mode: mode });
    return task.id;
  }
  async function done(id: string) {
    await waitFor("Cua task ended", () => ["completed", "failed", "canceled", "interrupted"].includes(runtime.runtime.store.getTask(id)!.status));
    return runtime.runtime.store.getTask(id)!;
  }
  try {
    const { sessionId } = await createProjectSession(client, runtime.work[0]);
    await done(await submit(sessionId, "baseline"));
    const service = await client.request<{ id: string }>("mcp_configure", { name: "mac", cua, tool_allowlist: ["get_window_state", "get_guide", "click", "type_text", "press_key", "run_steps"] });
    const checked = await client.request<{ ok: boolean; tools: { name: string }[] }>("mcp_check", { service_id: service.id });
    assert.ok(checked.tools.some(tool => tool.name === "get_guide"), "get_guide 按允许清单出现");
    // 未观察窗口的批次整体拒绝（零发送），get_guide 只读可发
    await done(await submit(sessionId, "early-batch", "run_steps", { steps: [{ tool: "click", args: { element_token: "s00000001:14" } }], pid: 42, window_id: 7, observe: {} }));
    assert.equal(sent("run_steps").length, 0, "未观察窗口不放行批次");
    const guide = await submit(sessionId, "guide", "get_guide", { topic: "batching" }); await done(guide);
    const serialized = JSON.stringify(runtime.server.calls);
    const schemaMatch = serialized.match(/"name":"mcp__mac__run_steps".{0,4000}/);
    t.diagnostic(schemaMatch ? schemaMatch[0].slice(0, 900) : "run_steps def absent");
    const hasRestricted = serialized.includes('"maxItems":8') || serialized.includes('"maxItems": 8');
    assert.ok(hasRestricted, "模型只见受限批次 schema");
    assert.ok(!/"run_steps"[^}]*foreground_fallback/.test(serialized.replace(/\\/g, "")), "不向前台回退能力");
    assert.equal(sent("get_guide").length, 1, "get_guide 作为只读调用放行");
    // 纯文本模型也能观察并取得树内授权（不带截图的窗口观察不要求视觉模型）
    await done(await submit(sessionId, "observe", "get_window_state", { pid: 42, window_id: 7, include_screenshot: false }));
    // 树内元素单发与批次放行；坐标动作仍拒绝
    await done(await submit(sessionId, "element-click", "click", { pid: 42, window_id: 7, element_token: "s00000001:14" }));
    assert.equal(sent("click").length, 1, "已交付元素令牌放行");
    await done(await submit(sessionId, "coord-click", "click", { pid: 42, window_id: 7, x: 10, y: 20 }));
    assert.equal(sent("click").length, 1, "无截图不放行坐标动作");
    const batch = await submit(sessionId, "batch", "run_steps", { steps: [{ tool: "click", args: { element_token: "s00000001:14" } }, { tool: "type_text", args: { text: "你好" } }], pid: 42, window_id: 7, observe: { include_screenshot: false } }, "confirm");
    const approval = await pendingConfirmation(client, batch);
    await client.request("respond_confirmation", { confirmation_id: approval.id, decision: "approve" });
    await done(batch);
    assert.equal(sent("run_steps").length, 1, "一次批准发送整批");
    assert.equal(sent("run_steps")[0].params.arguments.steps.length, 2, "原样转发规范步骤");
    // 批次末尾观察（s00000002）成为新授权，旧快照令牌作废
    await done(await submit(sessionId, "stale-element", "click", { pid: 42, window_id: 7, element_token: "s00000001:14" }));
    assert.equal(sent("click").length, 1, "批次观察公告失效后旧令牌不放行");
    await done(await submit(sessionId, "new-element", "click", { pid: 42, window_id: 7, element_token: "s00000002:1" }));
    assert.equal(sent("click").length, 1, "未交付的行号不授权");
    // 批次自身结果的文本已投影；新快照行未在批次返回中出现，故 s00000002 行不可见
    // 末尾观察失败的批次：派发即撤销旧授权，观察失败后旧令牌不能继续操作（零发送）
    await done(await submit(sessionId, "observe-8", "get_window_state", { pid: 42, window_id: 8, include_screenshot: false }));
    await done(await submit(sessionId, "batch-8", "run_steps", { steps: [{ tool: "click", args: { element_token: "s00000008:14" } }], pid: 42, window_id: 8, observe: { include_screenshot: false } }));
    assert.equal(sent("run_steps").length, 2, "观察失败的批次本身仍已派发");
    await done(await submit(sessionId, "post-fail-click", "click", { pid: 42, window_id: 8, element_token: "s00000008:14" }));
    assert.equal(sent("click").length, 1, "末尾观察失败后旧令牌不放行");
    // 批次子动作不在允许列表：整批在发送前拒绝（零发送）
    await done(await submit(sessionId, "observe-7", "get_window_state", { pid: 42, window_id: 7, include_screenshot: false }));
    await done(await submit(sessionId, "denied-child", "run_steps", { steps: [{ tool: "scroll", args: { direction: "down" } }], pid: 42, window_id: 7, observe: { include_screenshot: false } }));
    assert.equal(sent("run_steps").length, 2, "未允许子动作的批次零发送");
  } finally { await runtime.shutdown(); }
});
