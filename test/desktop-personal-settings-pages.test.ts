import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { DesktopBridge, DesktopFailure, DesktopResult, DesktopTarget } from "../apps/desktop/src/shared/bridge.ts";
import type { PersonalMaintenanceRecord, PersonalConfigurationReceipt } from "../apps/desktop/src/shared/personal-settings.ts";
import { PersonalSettingsPageState } from "../apps/desktop/src/renderer/personal-settings-state.ts";
import type { PersonalService } from "../apps/desktop/src/renderer/personal-settings-state.ts";
import { SettingsState } from "../apps/desktop/src/renderer/settings-state.ts";

const profile = { directory: "/remote/profile", id: "sha256:" + "a".repeat(64) };
const modelRevision = "sha256:" + "b".repeat(64), libraryRevision = "sha256:" + "c".repeat(64), skillsRevision = "sha256:" + "d".repeat(64), mcpRevision = "sha256:" + "e".repeat(64);
const skillId = "00000000-0000-4000-8000-000000000001", secondSkillId = "00000000-0000-4000-8000-000000000002";
const contentRevision = "sha256:" + "f".repeat(64);
const modelConfig = { api: "openai-responses", baseUrl: "https://model.example/v1", modelId: "personal-model", apiKeyEnv: "PERSONAL_MODEL_KEY", contextWindow: 32768, maxTokens: 2048, imageInput: true };
const skill = { id: skillId, name: "远端技能", description: "技能说明", explicitOnly: true, source: "external", readOnly: true, state: "enabled", contentRevision };
const remoteTool = { name: "lookup", description: "查询资料", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, annotations: { readOnlyHint: true } };
const service = { id: "existing-service", label: "远端服务", endpoint: "https://mcp.example/tools?token=__RUUKOTO_REDACTED__", endpointRedacted: true, enabled: true, credential: { path: "/remote/secrets/mcp", sha256: "1".repeat(64) }, credentialStatus: "valid", tools: [remoteTool] };
const ok = (value: unknown): DesktopResult<unknown> => ({ ok: true, value });
const fail = (outcome: DesktopFailure["outcome"], code = "test_failure"): DesktopResult<unknown> => ({ ok: false, error: { code, outcome, message: "原档案操作未能核实，请重新读取。" } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function makeView() {
  return {
    settings: {
      product: "ruukoto", settingsProtocol: 2 as const, profile: { ...profile }, online: true,
      fileIssues: [] as { target: string; code: string; expectedRevision: string; actualRevision: string | null }[], revisions: { model: modelRevision, skills: libraryRevision, mcp: mcpRevision }, blockers: [] as unknown[],
      model: { config: { ...modelConfig }, credential: { state: "available", reference: modelConfig.apiKeyEnv } },
      skills: { sourceHost: "personal", config: null, directory: "/home/ruukoto/.agents/skills", revision: skillsRevision, skills: [{ ...skill }], offset: 0, hasMore: false, diagnostics: [] as string[], diagnosticsTruncated: false },
      mcp: { version: 4, generation: "program-managed-generation", services: [{ ...service }] as PersonalService[], offset: 0, hasMore: false }, lifecycle: { managedDevelopment: false },
    },
    maintenance: { profile: { ...profile }, online: true, writable: true, code: "maintenance_supported", reason: "原系统服务已核实。", lifecycle: { kind: "systemd", state: "running", managedDevelopment: false, originalEnvironment: "verified" } },
    operations: [] as PersonalConfigurationReceipt[], pending: null as PersonalMaintenanceRecord | null, saved: null as boolean | null, message: "已读取原档案。",
  };
}
interface Call { target: DesktopTarget; op: string; params: Record<string, unknown>; request: Record<string, unknown> }
function harness(category: "models" | "skills" | "mcp" | "computer") {
  const view = makeView(), calls: Call[] = [];
  const hooks: { read?: () => Promise<DesktopResult<unknown>>; query?: (request: Record<string, unknown>) => Promise<DesktopResult<unknown>>; apply?: (request: Record<string, unknown>) => Promise<DesktopResult<unknown>> } = {};
  const base = () => ({ product: "ruukoto", profile: view.settings.profile, online: view.settings.online });
  const bridge: Pick<DesktopBridge, "request"> = { request: async (target, op, params) => {
    const request = (params.request ?? {}) as Record<string, unknown>;
    calls.push({ target, op, params: structuredClone(params), request: structuredClone(request) });
    if (op === "desktop_personal_settings_read") return hooks.read ? hooks.read() : ok(structuredClone(view));
    if (op === "desktop_personal_settings_apply") return hooks.apply ? hooks.apply(request) : ok({ ...structuredClone(view), saved: true, message: "已保存且已启动。" });
    if (op === "desktop_personal_settings_restore") { view.settings.online = true; view.maintenance.online = true; return ok(structuredClone(view)); }
    if (op === "desktop_personal_settings_finish") { view.pending = null; return ok(structuredClone(view)); }
    assert.equal(op, "desktop_personal_settings_request");
    if (hooks.query) return hooks.query(request);
    if (request.op === "skills.list") return ok({ ...base(), ...structuredClone(view.settings.skills) });
    if (request.op === "skills.get") return ok({ ...base(), ...skill, revision: skillsRevision, body: "# 远端正文\n旧引用保留。\n" });
    if (request.op === "model.test") return ok({ ...base(), revision: modelRevision, test: { status: "passed", code: "model_connection_ok", message: "模型连接测试成功。" } });
    if (request.op === "mcp.get") return ok({ ...base(), revision: mcpRevision, service: structuredClone(service), toolsOffset: 0, toolsHasMore: false });
    if (request.op === "mcp.discover") return ok({ ...base(), revision: mcpRevision, service: structuredClone(service), tools: [structuredClone(remoteTool)] });
    if (request.op === "config.preflight") return ok({ ...base(), revision: request.expectedRevision, blockers: [], credential: { state: "available", reference: modelConfig.apiKeyEnv }, connection: "untested" });
    assert.fail(`未覆盖的设置查询：${String(request.op)}`);
  } };
  return { state: new PersonalSettingsPageState(bridge, () => {}, category), view, calls, hooks, writes: () => calls.filter(call => call.op === "desktop_personal_settings_apply") };
}

test("Personal 各页从独立管理连接读取真实档案，不依赖旧聊天实例", async () => {
  for (const category of ["models", "skills", "mcp", "computer"] as const) {
    const h = harness(category); await h.state.read();
    assert.equal(h.state.phase, "ready"); assert.equal(h.state.writable, category !== "skills"); assert.equal(h.state.dirty, false);
    assert.deepEqual(h.state.view?.settings.profile, profile);
    assert.ok(h.calls.every(call => call.target === "personal"));
    assert.equal(h.writes().length, 0);
    if (category === "models") assert.deepEqual(h.state.model, { ...modelConfig, contextWindow: "32768", maxTokens: "2048" });
    if (category === "skills") assert.equal(h.state.view?.settings.skills.directory, "/home/ruukoto/.agents/skills");
  }
});

test("模型保存先确认影响，取消不写；确认后只提交当前档案与原修订", async () => {
  const h = harness("models"); await h.state.read(); h.state.editModel("modelId", "next-model");
  assert.equal(await h.state.save(), false); assert.ok(h.state.confirmation); assert.equal(h.writes().length, 0);
  h.state.cancelConfirmation(); assert.equal(h.state.confirmation, null); assert.equal(h.state.dirty, true);
  await h.state.save(); await h.state.confirmApply();
  assert.equal(h.writes().length, 1);
  assert.deepEqual(h.writes()[0].request, { v: 1, op: "config.save", profile, target: "model", expectedRevision: modelRevision, value: { ...modelConfig, modelId: "next-model" } });
});

test("模型字段校验定位错误，输出上限必须小于上下文容量", async () => {
  const h = harness("models"); await h.state.read(); h.state.editModel("modelId", "");
  await h.state.save(); assert.ok(h.state.fieldErrors.modelId); assert.equal(h.state.confirmation, null);
  h.state.editModel("modelId", "valid"); h.state.editModel("contextWindow", "1024"); h.state.editModel("maxTokens", "1024");
  await h.state.save(); assert.ok(h.state.fieldErrors.maxTokens); assert.equal(h.writes().length, 0);
});

test("显式模型测试发送草稿，测试不保存配置", async () => {
  const h = harness("models"); await h.state.read(); h.state.editModel("modelId", "test-draft");
  await h.state.testModel();
  const request = h.calls.find(call => call.request.op === "model.test")?.request;
  assert.deepEqual(request, { v: 1, op: "model.test", profile, expectedRevision: modelRevision, value: { ...modelConfig, modelId: "test-draft" } });
  assert.equal(h.writes().length, 0); assert.equal(h.state.dirty, true); assert.equal(h.state.test?.status, "passed");
  h.state.editModel("modelId", "another-draft"); assert.equal(h.state.test, null);
});

test("Personal Skills 只读固定远端目录，检索和离开不产生草稿或保存", async () => {
  const h = harness("skills"); await h.state.read();
  assert.equal(h.state.view?.settings.skills.config, null); assert.equal(h.state.writable, false);
  assert.equal(h.state.view?.settings.skills.directory, "/home/ruukoto/.agents/skills");
  h.state.query = "不存在"; assert.equal(h.state.filtered.length, 0);
  h.state.query = "远端"; assert.equal(h.state.filtered.length, 1);
  assert.equal(h.state.dirty, false); assert.equal(await h.state.save(), false); assert.equal(h.state.confirmation, null); assert.equal(h.writes().length, 0);
  const settings = new SettingsState(() => {}); settings.show("personal", "pa-skills"); settings.form = h.state;
  settings.chooseCategory("pa-models"); assert.equal(settings.category, "pa-models"); assert.equal(settings.leave, null);
});

test("MCP 编辑保留隐藏端点和完整工具定义，本地效果独立保存且不采信readOnlyHint", async () => {
  const h = harness("mcp"); await h.state.read(); await h.state.selectService(service.id);
  h.state.editService("label", "新服务名称");
  const newTool = { name: "search", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } };
  h.state.allowTool(newTool, true); await h.state.save(); await h.state.confirmApply();
  const request = h.writes()[0].request, value = request.service as Record<string, unknown>;
  assert.equal(request.op, "mcp.save-service"); assert.equal(request.expectedRevision, mcpRevision); assert.deepEqual(request.profile, profile);
  assert.equal(value.endpoint, service.endpoint); assert.equal(value.label, "新服务名称");
  assert.deepEqual(value.tools, [remoteTool, newTool]);
  assert.deepEqual(value.toolEffects, { lookup: "unknown", search: "unknown" });
  assert.ok(!(value.tools as Record<string, unknown>[]).some(tool => "effect" in tool));
});

test("Personal MCP 显式修改效果或重绑凭据，不改远端定义也不暗中重绑同路径", async () => {
  const h = harness("mcp"); await h.state.read(); await h.state.selectService(service.id);
  h.state.editService("label", "只改名称"); await h.state.save();
  assert.equal(Object.hasOwn(h.state.confirmation!.request.service as object, "credentialRebind"), false);
  h.state.cancelConfirmation();
  h.state.toolEffect("lookup", "read"); h.state.rebindCredential();
  assert.deepEqual(h.state.service.tools, [remoteTool]);
  await h.state.save(); await h.state.confirmApply();
  const saved = h.writes()[0].request.service as Record<string, unknown>;
  assert.deepEqual(saved.toolEffects, { lookup: "read" });
  assert.equal(saved.credentialRebind, true); assert.equal(saved.credentialPath, service.credential.path);
  assert.equal(Object.hasOwn(saved, "tools"), false);
  const ordinary = harness("mcp"); ordinary.view.settings.mcp.version = 3; await ordinary.state.read(); await ordinary.state.selectService(service.id);
  ordinary.state.editService("label", "旧配置"); await ordinary.state.save();
  assert.equal(ordinary.state.confirmation, null); assert.match(ordinary.state.message, /先迁入/); assert.equal(ordinary.writes().length, 0);
});

test("Personal MCP 原调用收尾不走配置账本，丢答须先核实同一调用", async () => {
  const h = harness("mcp"); await h.state.read();
  const original = { operation: 12, service: "服务", tool: "write", effect: "effect_unknown", code: "timeout", canEnd: true, ended: false };
  let lost = true;
  h.hooks.query = async request => request.op === "mcp.operations" ? ok({ profile, operations: [{ ...original }] }) : request.op === "mcp.operation" ? ok({ profile, summary: { ...original }, text: "original arguments" }) : request.op === "mcp.end" ? lost ? fail("unknown") : ok({ profile, operation: 12, ended: true }) : assert.fail(String(request.op));
  await h.state.readMcpOperations(); h.state.prepareMcpEnd(12);
  assert.equal(h.calls.some(call => call.request.op === "mcp.end"), false);
  h.state.cancelMcpEnd(); assert.equal(h.state.mcpEndConfirmation, null);
  h.state.prepareMcpEnd(12); await h.state.confirmMcpEnd();
  assert.equal(h.state.mcpEndPending, 12); assert.equal(h.writes().length, 0);
  h.state.prepareMcpEnd(12); await h.state.confirmMcpEnd();
  assert.equal(h.calls.filter(call => call.request.op === "mcp.end").length, 1);
  await h.state.readMcpOperations(); lost = false;
  assert.deepEqual(h.calls.find(call => call.request.op === "mcp.operation")?.request, { v: 1, op: "mcp.operation", profile, expectedRevision: mcpRevision, operation: 12, offset: 0 });
  h.state.prepareMcpEnd(12); await h.state.confirmMcpEnd();
  assert.deepEqual(h.calls.find(call => call.request.op === "mcp.end")?.request, { v: 1, op: "mcp.end", profile, expectedRevision: mcpRevision, operation: 12 });
  assert.equal(h.state.mcpOperations[0].ended, true); assert.equal(h.state.mcpOperations[0].effect, "effect_unknown");
  assert.equal(h.writes().length, 0);
});

test("MCP 服务详情合并完整工具分页，未改允许列表时保存不重建 tools", async () => {
  const h = harness("mcp"), secondTool = { ...remoteTool, name: "second" }; await h.state.read();
  h.hooks.query = async request => {
    assert.equal(request.op, "mcp.get");
    assert.equal(request.limit, 1, "每页一个完整定义，避免合法大 schema 撞响应限额");
    const first = request.offset === 0;
    return ok({ product: "ruukoto", profile, online: true, revision: mcpRevision, service: { ...service, tools: [first ? remoteTool : secondTool] }, toolsOffset: request.offset, toolsHasMore: first });
  };
  await h.state.selectService(service.id);
  assert.deepEqual(h.state.service.tools, [remoteTool, secondTool]);
  assert.deepEqual(h.calls.filter(call => call.request.op === "mcp.get").map(call => call.request.offset), [0, 1]);
  h.state.editService("label", "只改名称"); await h.state.save(); await h.state.confirmApply();
  assert.equal("tools" in (h.writes()[0].request.service as Record<string, unknown>), false);
});

test("MCP 工具发现仅由显式动作发起，不保存配置或调用业务工具", async () => {
  const h = harness("mcp"); await h.state.read(); await h.state.selectService(service.id);
  assert.equal(h.calls.some(call => call.request.op === "mcp.discover"), false);
  await h.state.discover();
  assert.deepEqual(h.state.discovered, [remoteTool]); assert.equal(h.writes().length, 0);
  const request = h.calls.find(call => call.request.op === "mcp.discover")!.request;
  assert.equal(request.expectedRevision, mcpRevision); assert.deepEqual(request.profile, profile);
  assert.ok(h.calls.every(call => !call.request.op || ["mcp.get", "mcp.discover"].includes(String(call.request.op))));
});

test("MCP 服务续页不混入新修订，冲突明确要求重读", async () => {
  for (const removed of [false, true]) {
    const h = harness("mcp"); h.view.settings.mcp.hasMore = true; await h.state.read();
    h.hooks.query = async request => {
      assert.deepEqual(request, { v: 1, op: "settings.read", offset: 1, limit: 1 });
      return ok({ ...h.view.settings, revisions: { ...h.view.settings.revisions, mcp: removed ? "missing" : contentRevision }, mcp: removed ? null : { ...h.view.settings.mcp, services: [] } });
    };
    await h.state.more(); assert.equal(h.state.phase, "conflict"); assert.equal(h.state.services.length, 1); assert.match(h.state.message, /重新读取/);
  }
});

test("技能续页不混合变化的目录或版本，保留已取得列表", async () => {
  for (const changed of [{ directory: "/other/.agents/skills" }, { revision: contentRevision }]) {
    const h = harness("skills"); h.view.settings.skills.hasMore = true; await h.state.read();
    h.hooks.query = async () => ok({ product: "ruukoto", profile, online: true, ...h.view.settings.skills, ...changed, skills: [{ ...skill, id: secondSkillId }] });
    await h.state.more(); assert.equal(h.state.phase, "conflict"); assert.equal(h.state.skills.length, 1);
    assert.equal(h.state.view?.settings.skills.directory, "/home/ruukoto/.agents/skills"); assert.match(h.state.message, /已取得的列表仍保留/);
  }
});

test("新 MCP 服务要求明确认证选择，匿名选择后才能准备保存", async () => {
  const h = harness("mcp"); await h.state.read(); await h.state.selectService(null);
  h.state.editService("label", "匿名服务"); h.state.editService("endpoint", "https://mcp.example/public");
  await h.state.save(); assert.equal(h.state.confirmation, null); assert.ok(Object.keys(h.state.fieldErrors).length);
  h.state.editService("authentication", "anonymous"); await h.state.save(); assert.ok(h.state.confirmation); await h.state.confirmApply();
  const value = h.writes()[0].request.service as Record<string, unknown>;
  assert.equal(value.authentication, "anonymous"); assert.equal(value.credential, undefined); assert.equal(value.credentialPath, undefined);
});

test("无关工作、离线和无systemd不阻止配置保存", async () => {
  for (const blocked of ["busy", "offline", "readonly"] as const) {
    const h = harness("models");
    if (blocked === "busy") h.view.settings.blockers = [{ kind: "pending-work" }];
    if (blocked === "offline") h.view.settings.online = false;
    if (blocked === "readonly") h.view.maintenance.writable = false;
    await h.state.read(); h.state.editModel("modelId", "next"); await h.state.save(); await h.state.confirmApply();
    assert.equal(h.state.writable, true); assert.equal(h.writes().length, 1);
    if (blocked === "busy") assert.deepEqual(h.state.view?.settings.blockers, [{ kind: "pending-work" }]);
  }
});

test("保存丢答保持待核实，查询失败不开放重发；恢复服务与结束维护不重存", async () => {
  const h = harness("models"); await h.state.read(); h.state.editModel("modelId", "uncertain-draft");
  h.hooks.apply = async () => fail("unknown"); await h.state.save(); await h.state.confirmApply();
  assert.equal(h.state.phase, "unknown"); assert.equal(h.writes().length, 1);
  await h.state.save(); await h.state.confirmApply(); assert.equal(h.writes().length, 1);
  h.hooks.read = async () => fail("not_sent"); await h.state.read(); assert.equal(h.state.phase, "unknown");
  h.hooks.read = undefined;
  h.view.pending = { v: 1, id: "original-maintenance", profile, op: "config.save", target: "model", expectedRevision: modelRevision, requestDigest: "1".repeat(64), saveAttempted: true, stage: "saving" };
  await h.state.read(); assert.equal(h.state.phase, "unknown"); assert.equal(h.state.model.modelId, "uncertain-draft");
  await h.state.restore(); await h.state.finish();
  assert.equal(h.writes().length, 1); assert.equal(h.state.view?.pending, null);
});

test("已保存但启动失败保留事实，并提供恢复原服务的操作", async () => {
  const h = harness("models"); await h.state.read(); h.state.editModel("modelId", "saved-model");
  h.view.pending = { v: 1, id: "saved-maintenance", profile, op: "config.save", target: "model", expectedRevision: modelRevision, requestDigest: "1".repeat(64), saveAttempted: true, stage: "starting", savedRevision: contentRevision };
  h.view.saved = true; h.view.settings.online = false; h.view.maintenance.online = false;
  h.hooks.apply = async () => ok(structuredClone(h.view));
  await h.state.save(); await h.state.confirmApply();
  assert.equal(h.state.view?.saved, true); assert.equal(h.state.phase, "unknown");
  await h.state.restore(); assert.ok(h.calls.some(call => call.op === "desktop_personal_settings_restore")); assert.equal(h.writes().length, 1);
});

test("失效轮次的读取与保存响应不能覆盖原草稿或另一目标", async () => {
  const read = harness("models"), pendingRead = deferred<DesktopResult<unknown>>();
  read.hooks.read = () => pendingRead.promise;
  const reading = read.state.read(); read.state.invalidate(); pendingRead.resolve(ok(read.view)); await reading;
  assert.equal(read.state.view, null);
  const write = harness("models"); await write.state.read(); write.state.editModel("modelId", "original-draft");
  const pendingWrite = deferred<DesktopResult<unknown>>(); write.hooks.apply = () => pendingWrite.promise;
  await write.state.save(); const saving = write.state.confirmApply(); write.state.invalidate();
  pendingWrite.resolve(ok({ ...write.view, saved: true })); await saving;
  assert.equal(write.state.phase, "unknown"); assert.equal(write.state.model.modelId, "original-draft"); assert.equal(write.writes().length, 1);
});

test("技能查询应答档案不匹配时拒绝续页，原档案与列表保留", async () => {
  const h = harness("skills"); await h.state.read();
  h.hooks.query = async () => ok({ ...h.view.settings.skills, product: "ruukoto", profile: { ...profile, id: contentRevision }, online: true });
  await h.state.more();
  assert.equal(h.state.phase, "conflict"); assert.equal(h.state.skills.length, 1); assert.deepEqual(h.state.view?.settings.profile, profile); assert.equal(h.writes().length, 0);
});

test("重新读取保留冲突草稿，放弃后才能基于新修订保存", async () => {
  const h = harness("models"); await h.state.read(); h.state.editModel("modelId", "local-draft");
  h.view.settings.revisions.model = contentRevision; h.view.settings.model.config.modelId = "new-remote-model";
  await h.state.read();
  assert.equal(h.state.phase, "conflict"); assert.equal(h.state.model.modelId, "local-draft");
  assert.equal(h.state.view?.settings.model?.config.modelId, "new-remote-model");
  await h.state.save(); assert.equal(h.state.confirmation, null); assert.equal(h.writes().length, 0);
  h.state.discard(); h.state.editModel("modelId", "resolved-draft"); await h.state.save(); await h.state.confirmApply();
  assert.equal(h.writes()[0].request.expectedRevision, contentRevision);
});

test("关闭后新建页面重新读取原档案，不复用本机草稿缓存", async () => {
  const first = harness("models"); await first.state.read(); first.state.editModel("modelId", "discarded-draft"); first.state.invalidate();
  const reopened = harness("models"); reopened.view.settings.model.config.modelId = "current-remote-model"; await reopened.state.read();
  assert.equal(reopened.state.model.modelId, "current-remote-model"); assert.equal(reopened.state.dirty, false); assert.equal(reopened.calls[0].op, "desktop_personal_settings_read");
});

test("Personal 统一连接断开使在途保存待核实，迟到结果不改变原草稿", async () => {
  const h = harness("models"); await h.state.read(); h.state.editModel("modelId", "new-model");
  const settings = new SettingsState(() => {}); settings.open = true; settings.category = "pa-models"; settings.form = h.state;
  const response = deferred<DesktopResult<unknown>>(); h.hooks.apply = () => response.promise;
  await h.state.save(); const saving = h.state.confirmApply();
  settings.observe("personal", { type: "state", state: "closed" });
  response.resolve(ok({ ...h.view, saved: true }));
  assert.equal(await saving, false); assert.equal(h.state.phase, "unknown"); assert.equal(h.state.model.modelId, "new-model");
});

test("Personal 保存并继续保留原导航，维护确认取消不导航，成功后完成导航", async () => {
  const h = harness("models"); await h.state.read(); h.state.editModel("modelId", "new-model");
  const settings = new SettingsState(() => {}); settings.open = true; settings.category = "pa-models"; settings.form = h.state;
  settings.chooseCategory("pa-skills");
  const cancelled = settings.saveAndLeave(); await Promise.resolve();
  assert.ok(h.state.confirmation); assert.equal(settings.category, "pa-models"); assert.ok(settings.leave);
  h.state.cancelConfirmation(); await cancelled; assert.equal(settings.category, "pa-models");
  const continuing = settings.saveAndLeave(); await Promise.resolve();
  await h.state.confirmApply(); await continuing;
  assert.equal(settings.category, "pa-skills"); assert.equal(settings.leave, null); assert.equal(h.writes().length, 1);
});

test("旧 MCP 格式须先显式迁入，再允许新增停用服务", async () => {
  const h = harness("mcp"); h.view.settings.mcp.version = 1; await h.state.read();
  await h.state.selectService(null); assert.equal(h.state.editingService, false); assert.equal(h.writes().length, 0);
  h.state.prepareService("migrate"); assert.equal(h.state.confirmation?.request.op, "mcp.migrate");
  await h.state.confirmApply(); assert.equal(h.writes().length, 1);
});

test("Personal 三页 SSR 展示真实字段、远端来源、维护恢复与安全正文", async t => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createServer } = await import("vite"); const { default: react } = await import("@vitejs/plugin-react");
  const { fileURLToPath } = await import("node:url");
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL("../apps/desktop/src/renderer/", import.meta.url)), plugins: [react()], server: { middlewareMode: true, hmr: false }, appType: "custom" });
  t.after(() => server.close());
  const { PersonalSettingsEditor } = await server.ssrLoadModule("/personal-settings-pages.tsx");
  for (const category of ["models", "skills", "mcp"] as const) {
    const h = harness(category); await h.state.read();
    if (category === "mcp") {
      await h.state.selectService(service.id);
      const summary = { operation: 12, service: "远端服务", tool: "lookup", effect: "effect_unknown", code: "timeout", canEnd: true, ended: false };
      h.state.mcpOperations = [summary]; h.state.mcpDetail = { summary, text: "原调用参数与未知结果" };
    }
    const html = renderToStaticMarkup(createElement(PersonalSettingsEditor, { state: h.state, onConnection() {} }));
    assert.match(html, /remote\/profile/);
    assert.doesNotMatch(html, /摘要模型|默认模型|配置来源|选择工作区|Bearer 令牌|存储 API Key/);
    if (category === "models") { assert.match(html, /API 类型/); assert.match(html, /上下文上限/); assert.match(html, /凭据环境变量引用/); assert.match(html, /图片输入/); assert.match(html, /role="switch"/); }
    if (category === "skills") {
      assert.match(html, /home\/ruukoto\/\.agents\/skills/); assert.match(html, /远端技能/);
      assert.doesNotMatch(html, /选择技能库|导入|托管副本|未保存的更改|查看保存影响|保存更改/);
    }
    if (category === "mcp") { assert.match(html, /远端私有凭据文件/); assert.match(html, /允许的工具/); assert.match(html, /副作用不明/); assert.match(html, /重新绑定凭据/); assert.match(html, /刷新 MCP 调用/); assert.match(html, /结束此工作，保留结果未知/); assert.match(html, /原调用参数与未知结果/); assert.doesNotMatch(html, /副作用类别/); }
  }
  const h = harness("models"); h.view.pending = { v: 1, id: "pending", profile, op: "config.save", target: "model", expectedRevision: modelRevision, requestDigest: "1".repeat(64), saveAttempted: true, stage: "starting", savedRevision: contentRevision }; h.view.saved = true; h.view.settings.online = false; h.view.settings.model.credential.state = "unverified";
  await h.state.read();
  const html = renderToStaticMarkup(createElement(PersonalSettingsEditor, { state: h.state, onConnection() {} }));
  assert.doesNotMatch(html, /原后台模型凭据缺失或尚未核实，当前只读/); assert.match(html, /配置已保存，后台尚未启动/); assert.match(html, /恢复原服务/); assert.match(html, /结束维护/);
});

test("Personal MCP：Cua固定配置不进入HTTP编辑器，启停保留原服务", async () => {
  const h = harness("mcp"), cua = { kind: "cua-linux" as const, executable: "/usr/local/bin/cua", version: "0.7.0" as const, sha256: "a".repeat(64), sandbox: "local:desktop", sandboxId: "b".repeat(64) };
  h.hooks.query = async request => request.op === "mcp.get" ? ok({ product: "ruukoto", profile, service: { id: service.id, label: "电脑", cua, enabled: true, tools: [remoteTool] }, toolsOffset: 0, toolsHasMore: false }) : ok({ product: "ruukoto", profile });
  await h.state.read(); await h.state.selectService(service.id);
  assert.deepEqual(h.state.service.cua, cua);
  h.state.editService("endpoint", "https://replacement.example/mcp");
  h.state.allowTool({ name: "unsafe", inputSchema: {} }, true);
  assert.equal(h.state.service.endpoint, ""); assert.equal(h.state.service.tools.length, 1); assert.equal(h.state.dirty, false);
  h.state.prepareService("disable");
  assert.equal(h.state.confirmation?.request.op, "mcp.set-enabled");
  assert.equal(h.state.confirmation?.request.id, service.id);
  assert.equal(h.state.confirmation?.request.enabled, false);
});

test("Personal Cua 设置从远端选择固定目标，保存不要求路径、哈希或认证输入", async () => {
  const h = harness("mcp"); await h.state.read();
  const cua = { kind: "cua-linux" as const, executable: "/usr/local/bin/cua", version: "0.7.0" as const, sha256: "a".repeat(64), sandbox: "local:desktop", sandboxId: "b".repeat(64) };
  const screenshot = { ...remoteTool, name: "computer_screenshot" };
  h.hooks.query = async request => request.op === "mcp.cua-targets" ? ok({ product: "ruukoto", profile, targets: [{ label: "专用桌面", config: cua }], issues: [] }) : ok({ product: "ruukoto", profile, tools: [screenshot] });
  await h.state.addCua(); assert.equal(h.state.cuaTargets.length, 1); h.state.chooseCua(0);
  assert.deepEqual(h.state.service.cua, cua); assert.equal(h.state.service.label, "专用桌面");
  await h.state.discover(); h.state.allowTool(screenshot, true);
  await h.state.save(); await h.state.confirmApply();
  const saved = h.writes()[0].request.service as Record<string, unknown>;
  assert.deepEqual(saved.cua, cua); assert.equal(saved.enabled, false); assert.deepEqual(saved.tools, [screenshot]);
  assert.equal("endpoint" in saved, false); assert.equal("authentication" in saved, false);
  assert.equal(h.calls.find(call => call.request.op === "mcp.cua-targets")?.request.expectedRevision, mcpRevision);
});

test("Personal Cua 恢复必须显示完整新截图，接受绑定原观察，失败或迟到onLoad不能沿用旧图", async () => {
  const h = harness("mcp"); await h.state.read();
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6LJ0AAAAASUVORK5CYII=", "base64"), id = "00000000-0000-4000-8000-000000000010", sha256 = createHash("sha256").update(bytes).digest("hex");
  const image = { id, mime: "image/png", bytes: bytes.length, sha256 };
  const operation = { operation: 12, service: "电脑", tool: "computer_click", effect: "effect_unknown", code: "timeout", cuaRecovery: "observed", cuaObservation: 34, images: [image] };
  const status = { available: true, paused: true, busy: false, operations: [operation] };
  let mode = "success";
  h.hooks.query = async request => {
    if (request.op === "mcp.cua-status") return ok({ product: "ruukoto", profile, ...status });
    if (request.op === "mcp.cua-image") return ok({ product: "ruukoto", profile, ...image, observation: 34, offset: 0, base64: bytes.toString("base64") });
    if (request.op === "mcp.cua-control") { if (mode === "failed") return fail("not_sent", "cua_observation_failed"); return ok({ product: "ruukoto", profile, ...status, operations: request.action === "accept" ? [] : [operation] }); }
    assert.fail(String(request.op));
  };
  await h.state.readCua(); await h.state.loadCuaImages(12);
  assert.equal(h.state.cuaImages.length, 1); assert.match(h.state.cuaImages[0].src, /^data:image\/png;base64,/);
  assert.equal(h.state.canAcceptCua(12, 34), false); await h.state.controlCua("accept", 12);
  assert.equal(h.calls.filter(call => call.request.action === "accept").length, 0);
  h.state.cuaImageLoaded(12, 34, id, true); assert.equal(h.state.canAcceptCua(12, 34), true);
  await h.state.controlCua("accept", 12);
  assert.deepEqual(h.calls.find(call => call.request.action === "accept")?.request, { v: 1, op: "mcp.cua-control", profile, expectedRevision: mcpRevision, action: "accept", operation: 12, observation: 34 });
  await h.state.readCua(); await h.state.loadCuaImages(12); h.state.cuaImageLoaded(12, 34, id, true);
  mode = "failed"; await h.state.controlCua("observe", 12);
  assert.equal(h.state.cuaImages.length, 0); h.state.cuaImageLoaded(12, 34, id, true); assert.equal(h.state.canAcceptCua(12, 34), false);
  await h.state.readCua(); await h.state.loadCuaImages(12); assert.equal(h.state.cuaImages.length, 0); assert.equal(h.state.canAcceptCua(12, 34), false);
  assert.equal(h.writes().length, 0, "电脑控制不触发停存启维护");
});

test("旧 Personal Cua begun或stopped直接检查恢复，v3格式不阻塞原身份管理", async () => {
  const h = harness("computer"); h.view.settings.mcp.version = 3; await h.state.read();
  h.hooks.query = async request => request.op === "mcp.cua-control" ? ok({ profile, available: true, paused: true, busy: false, operations: [] }) : assert.fail(String(request.op));
  for (const cuaRecovery of ["stopped", "begun"] as const) {
    h.state.cua = { available: true, paused: true, busy: false, operations: [{ operation: 12, service: "电脑", tool: "click", effect: "effect_unknown", code: "timeout", cuaRecovery, images: [] }] };
    await h.state.controlCua("observe", 12);
  }
  assert.equal(h.calls.filter(call => call.request.op === "mcp.cua-control" && call.request.action === "observe").length, 2);
  assert.equal(h.calls.some(call => call.request.action === "begin"), false); assert.equal(h.writes().length, 0);
});

test("Personal Cua 截图缺页或哈希不符不显示，目标缺安装仍可编辑普通HTTP服务", async () => {
  const h = harness("mcp"); await h.state.read();
  h.hooks.query = async () => ok({ product: "ruukoto", profile, targets: [], issues: [{ code: "cua_artifact_missing", message: "请安装官方固定版本。" }] });
  await h.state.addCua(); assert.equal(h.state.cuaTargets.length, 0); assert.equal(h.state.cuaIssues[0].code, "cua_artifact_missing");
  h.state.discard(); await h.state.selectService(null); h.state.editService("label", "HTTP"); h.state.editService("endpoint", "https://mcp.example/new"); h.state.editService("authentication", "anonymous");
  await h.state.save(); assert.ok(h.state.confirmation);
  h.state.cancelConfirmation(); h.state.discard();
  const id = "00000000-0000-4000-8000-000000000010";
  h.state.cua = { available: true, paused: true, busy: false, operations: [{ operation: 12, service: "电脑", tool: "click", effect: "effect_unknown", code: "timeout", cuaRecovery: "observed", cuaObservation: 34, images: [{ id, mime: "image/png", bytes: 3, sha256: "a".repeat(64) }] }] };
  h.hooks.query = async () => ok({ product: "ruukoto", profile, id, mime: "image/png", bytes: 3, sha256: "a".repeat(64), observation: 34, offset: 0, base64: Buffer.from("bad").toString("base64") });
  await h.state.loadCuaImages(12); assert.equal(h.state.cuaImages.length, 0); assert.equal(h.state.canAcceptCua(12, 34), false);
  assert.match(h.state.message, /完整性/);
});

const personalCua = () => ({ kind: "cua-linux" as const, executable: "/usr/local/bin/cua", version: "0.7.0" as const, sha256: "a".repeat(64), sandbox: "local:desktop", sandboxId: "b".repeat(64) });
const cuaService = { id: "cua-service", label: "远端电脑", cua: personalCua(), enabled: true, tools: [structuredClone(remoteTool)] };

test("Personal 电脑页共用 MCP 修订与保存入口，只编辑 CUA 服务", async () => {
  const h = harness("computer");
  h.view.settings.mcp.services.push(structuredClone(cuaService));
  h.hooks.query = async request => {
    assert.equal(request.op, "mcp.get");
    return ok({ product: "ruukoto", profile, service: structuredClone(cuaService), toolsOffset: 0, toolsHasMore: false });
  };
  await h.state.read();
  assert.deepEqual(h.state.services.map(item => item.id), ["existing-service", "cua-service"], "状态层保留全量服务，过滤在页面渲染");
  await h.state.selectService(cuaService.id);
  assert.deepEqual(h.state.service.cua, cuaService.cua);
  h.state.prepareService("disable");
  assert.equal(h.state.confirmation?.request.op, "mcp.set-enabled");
  assert.equal(h.state.confirmation?.request.expectedRevision, mcpRevision);
  assert.equal(h.state.confirmation?.request.id, cuaService.id);
});

test("Personal 电脑页 SSR 只呈现 Linux 沙箱与恢复控制，MCP 页不再显示 Cua", async t => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createServer } = await import("vite"); const { default: react } = await import("@vitejs/plugin-react");
  const { fileURLToPath } = await import("node:url");
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL("../apps/desktop/src/renderer/", import.meta.url)), plugins: [react()], server: { middlewareMode: true, hmr: false }, appType: "custom" });
  t.after(() => server.close());
  const { PersonalSettingsEditor } = await server.ssrLoadModule("/personal-settings-pages.tsx");
  const computer = harness("computer"); computer.view.settings.mcp.services.push(structuredClone(cuaService)); await computer.state.read();
  const computerHtml = renderToStaticMarkup(createElement(PersonalSettingsEditor, { state: computer.state, onConnection() {} }));
  assert.match(computerHtml, /Linux 桌面沙箱/); assert.match(computerHtml, /Linux 电脑/); assert.match(computerHtml, /local:desktop/);
  assert.doesNotMatch(computerHtml, /添加 HTTP 服务|远端私有凭据文件|HTTPS 端点|远端服务/);
  const mcp = harness("mcp"); mcp.view.settings.mcp.services.push(structuredClone(cuaService)); await mcp.state.read();
  const mcpHtml = renderToStaticMarkup(createElement(PersonalSettingsEditor, { state: mcp.state, onConnection() {} }));
  assert.match(mcpHtml, /添加服务/); assert.match(mcpHtml, /远端服务/);
  assert.doesNotMatch(mcpHtml, /Linux 桌面沙箱|Linux 电脑|远端电脑/);
});


test("退役技能配置的异常和待核实更改保留记录，不阻止只读技能分页", async () => {
  const models = harness("models"), skills = harness("skills");
  const issue = { target: "managed-skills", code: "settings_file_unverified", expectedRevision: skillsRevision, actualRevision: null };
  models.view.settings.fileIssues = [issue]; skills.view.settings.fileIssues = [issue];
  const id = "00000000-0000-4000-8000-000000000008";
  skills.view.operations = [{ v: 2, id, profile, target: "skills", scope: "managed", requestDigest: "1".repeat(64), status: "unknown", savedRevision: null, effectiveRevision: null, code: "settings_file_unverified", relatedOperations: [] }];
  skills.view.pending = { v: 1, id: "legacy-import", profile, op: "skills.import", target: "skills", expectedRevision: skillsRevision, requestDigest: "1".repeat(64), saveAttempted: true, stage: "starting" };
  skills.view.settings.skills.hasMore = true;
  await models.state.read(); await skills.state.read();
  assert.equal(models.state.writable, true); assert.equal(skills.state.writable, false); assert.equal(skills.state.disabled, false); assert.equal(skills.state.phase, "ready");
  assert.deepEqual(skills.state.view!.settings.fileIssues, [issue]); assert.equal(skills.state.operations[0].id, id); assert.equal(skills.state.fileIssues.length, 0);
  skills.hooks.query = async () => ok({ profile, ...skills.view.settings.skills, skills: [{ ...skill, id: secondSkillId }], offset: 1, hasMore: false });
  await skills.state.more(); assert.equal(skills.state.skills.length, 2);
  await skills.state.withdrawOperation(id); assert.equal(skills.state.confirmation, null); assert.equal(skills.writes().length, 0);
  const settings = new SettingsState(() => {}); settings.show("personal", "pa-skills"); settings.form = skills.state;
  settings.chooseCategory("pa-models"); assert.equal(settings.category, "pa-models");
});

test("v2待核实原操作只锁本目标，导航后其他配置可保存且原键仍可见", async () => {
  const models = harness("models"), skills = harness("skills"), id = "00000000-0000-4000-8000-000000000009";
  const operation: PersonalConfigurationReceipt = { v: 2, id, profile, target: "model", scope: "*", requestDigest: "1".repeat(64), status: "unknown", savedRevision: null, effectiveRevision: null, code: "settings_file_unverified", relatedOperations: [] };
  models.view.operations = [operation]; skills.view.operations = [operation];
  await models.state.read(); assert.equal(models.state.writable, false); assert.equal(models.state.disabled, true);
  const settings = new SettingsState(() => {}); settings.show("personal", "pa-models"); settings.form = models.state;
  settings.chooseCategory("pa-skills"); assert.equal(settings.category, "pa-skills");
  await skills.state.read(); assert.equal(skills.state.writable, false); assert.equal(skills.state.disabled, false);
  await skills.state.save(); await skills.state.confirmApply();
  assert.equal(skills.writes().length, 0); assert.equal(skills.state.view?.operations?.[0].id, id);
  await models.state.read(); assert.equal(models.state.operations[0].id, id); assert.equal(models.writes().length, 0);
});

test("MCP A等待不锁B，撤回使用原更改与当前文件修订且保留保存记录", async () => {
  const h = harness("mcp"), id = "00000000-0000-4000-8000-000000000003";
  h.view.operations = [{ v: 2, id, profile, target: "mcp", scope: service.id, requestDigest: "1".repeat(64), status: "waiting", savedRevision: mcpRevision, effectiveRevision: libraryRevision, code: "mcp_busy", relatedOperations: [] }];
  await h.state.read(); assert.equal(h.state.writable, true);
  await h.state.selectService(service.id); assert.equal(h.state.writable, false);
  await h.state.withdrawOperation(id); assert.ok(h.state.confirmation); assert.equal(h.state.writable, true);
  await h.state.confirmApply();
  assert.deepEqual(h.writes()[0].request, { v: 1, op: "settings.withdraw", profile, expectedRevision: mcpRevision, id });
  assert.equal(h.state.view?.operations?.[0].savedRevision, mcpRevision);
});

test("旧后台显示升级要求并保留可编辑草稿，不回退停存启", async () => {
  const h = harness("models"); delete (h.view.settings as { settingsProtocol?: number }).settingsProtocol;
  await h.state.read(); h.state.editModel("modelId", "saved-draft"); await h.state.save();
  assert.equal(h.state.writable, false); assert.match(h.state.message, /原更改|升级/); assert.equal(h.writes().length, 0); assert.equal(h.state.model.modelId, "saved-draft");
});
