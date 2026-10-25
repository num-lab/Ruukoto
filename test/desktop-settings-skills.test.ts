import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import type { OpResult } from "@ruukoto/control/ops.ts";
import { product } from "../apps/ruukoto-code/src/product.ts";
import { DesktopHost } from "../apps/desktop/src/main/host.ts";
import { adoptEnvironment } from "../apps/desktop/src/main/environment.ts";
import { CODE_SKILL_OPS, ipcResult } from "../apps/desktop/src/main/ipc.ts";
import type { DesktopBridge, DesktopResult, DesktopUpdate } from "../apps/desktop/src/shared/bridge.ts";
import { CodeSkillsState } from "../apps/desktop/src/renderer/code-skills-state.ts";
import { SettingsState } from "../apps/desktop/src/renderer/settings-state.ts";
import type { ComponentType } from "react";
import { startTestRuntime, waitFor } from "./helpers/testkit.ts";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

async function fixture(t: TestContext, shell: "electron" | "mygo" = "electron") {
  const previous = { ...process.env };
  const kit = await startTestRuntime("desktop-skills", () => ({ kind: "text", text: "ok" }), { config: { product: product.runtime } });
  const control = fs.mkdtempSync(path.join(os.tmpdir(), "rsk-"));
  fs.symlinkSync(path.join(kit.runtime.controlDir(), "owner.token"), path.join(control, "owner.token"));
  fs.symlinkSync(kit.runtime.socketPath(), path.join(control, "control.sock"));
  const env = { ...previous, RUUKOTO_DESKTOP_MANAGED: "1", RUUKOTO_CODE_CONTROL_DIR: control, RUUKOTO_CODE_DATA_DIR: kit.dirs.dataDir, RUUKOTO_CODE_AGENT_DIR: kit.dirs.agentDir };
  const updates: DesktopUpdate[] = [];
  const host = new DesktopHost(path.resolve(import.meta.dirname, ".."), path.join(kit.dirs.root, "desktop"), { publish: (target, update) => { if (target === "code") updates.push(update); }, focused: () => true, notice() {}, badge() {} }, async () => ({ env, node: process.execPath }));
  t.after(async () => { await host.close(); adoptEnvironment(previous); await kit.shutdown(); fs.rmSync(control, { recursive: true, force: true }); });
  host.subscribe("code");
  await waitFor("技能宿主就绪", () => updates.some(update => update.type === "state" && update.state === "online") && updates.some(update => update.type === "snapshot"));
  const snapshot = updates.find(update => update.type === "snapshot")!;
  assert.equal(snapshot.type, "snapshot");
  const instanceId = snapshot.type === "snapshot" ? snapshot.result.snapshot.instanceId : "";
  const context = { instanceId, online: true };
  let folder: string | null = null;
  const requests: { op: string; params: Record<string, unknown> }[] = [];
  const hooks: { before?: (op: string) => Promise<void>; after?: (op: string, result: DesktopResult<unknown>) => DesktopResult<unknown> } = {};
  const bridge: Pick<DesktopBridge, "request" | "pickSkillFolder"> = {
    request: async (target, op, params) => {
      requests.push({ op, params }); await hooks.before?.(op);
      const result = await host.request(target, op, params);
      return hooks.after?.(op, result) ?? result;
    },
    pickSkillFolder: (target, instance) => ipcResult(async () => shell === "electron" ? host.pickSkillFolder(target, instance, async () => folder) : host.previewSkillSelection(host.beginSkillSelection(target, instance), folder)),
  };
  const state = new CodeSkillsState(bridge, () => {}, instanceId, () => context);
  await state.read();
  const source = (name = "example", explicit = false) => {
    const directory = path.join(fs.realpathSync(kit.dirs.root), name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: 测试技能\ndisable-model-invocation: ${explicit}\n---\n# 正文\n旧引用可读\n<script>evil()</script>\n![远程](https://invalid.example/pixel)\n[危险](javascript:evil())\n`);
    fs.writeFileSync(path.join(directory, "reference.txt"), "旧引用字节\n");
    return directory;
  };
  const choose = async (directory: string | null) => { folder = directory; await state.choose(); };
  const list = () => kit.client.request<OpResult<"skills_list">>("skills_list", {});
  return { ...kit, host, state, requests, hooks, context, bridge, source, choose, list, instanceId };
}

for (const shell of ["electron", "mygo"] as const) {
  test(`${shell} 共用宿主：真实隔离控制面导入、启停、仅显式调用与逻辑移除`, async t => {
    const h = await fixture(t, shell);
    const source = h.source("explicit", true), raw = fs.readFileSync(path.join(source, "SKILL.md"));
    await h.choose(source);
    assert.equal((await h.list()).skills.length, 0, "预览不安装");
    assert.equal(h.state.preview?.explicitOnly, true);
    const id = h.state.preview!.id;
    assert.equal(await h.state.save(), true, h.state.message);
    assert.equal(h.state.detail?.id, id); assert.match(h.state.detail!.body, /旧引用可读/);
    assert.equal(h.state.selected?.explicitOnly, true); assert.equal(h.state.selected?.state, "enabled");
    assert.equal(await h.state.setEnabled(false), true, h.state.message);
    assert.equal(h.state.selected?.state, "disabled"); assert.equal(h.state.selected?.explicitOnly, true);
    assert.equal((await h.client.request<OpResult<"list_skills">>("list_skills", {})).skills.length, 0);
    assert.equal(await h.state.setEnabled(true), true, h.state.message);
    assert.equal(await h.state.remove(), true, h.state.message);
    assert.equal((await h.list()).skills.length, 0); assert.equal(h.state.detail?.state, "removed");
    assert.match((await h.client.request<OpResult<"skill_get">>("skill_get", { skill_id: id })).body, /旧引用可读/);
    assert.deepEqual(fs.readFileSync(path.join(source, "SKILL.md")), raw);
    const managed = path.join(h.dirs.agentDir, "managed-skills", "packages", id, "explicit");
    assert.equal(fs.readFileSync(path.join(managed, "reference.txt"), "utf8"), "旧引用字节\n");
    await h.host.request("code", "reconnect", {}); await h.state.read();
    assert.equal((await h.list()).skills.length, 0);
    const sent = h.requests.find(request => request.op === "desktop_skill_import")!;
    assert.deepEqual(Object.keys(sent.params), ["selection_id"]);
  });

  test(`${shell} 取消不写、目标与选择期间连接变化拒绝，renderer 不能伪造源路径`, async t => {
    const h = await fixture(t, shell);
    await h.choose(null); assert.equal(h.state.preview, null);
    await h.choose(h.source()); h.state.discard();
    assert.equal((await h.list()).skills.length, 0);
    assert.equal(fs.existsSync(path.join(h.dirs.agentDir, "managed-skills")), false);
    for (const op of [...CODE_SKILL_OPS, "desktop_skill_import", "skill_import", "skill_import_preview"]) {
      assert.equal((await h.host.request("personal", op, {})).ok, false, op);
    }
    for (const op of ["skill_import", "skill_import_preview"]) assert.equal((await h.host.request("code", op, { source_dir: h.source() })).ok, false);
    assert.equal((await h.host.request("code", "desktop_skill_import", { selection_id: "fake", source_dir: h.source() })).ok, false);
    assert.throws(() => h.host.beginSkillSelection("personal", h.instanceId), { code: "op_not_allowed" });
    assert.throws(() => h.host.beginSkillSelection("code", "other"), { code: "skill_target_changed" });
    const ticket = h.host.beginSkillSelection("code", h.instanceId);
    await h.host.request("code", "reconnect", {});
    await assert.rejects(h.host.previewSkillSelection(ticket, h.source()), { code: "skill_target_changed" });
    await h.choose(h.source());
    await h.host.request("code", "reconnect", {});
    assert.equal(await h.state.save(), false);
    assert.equal((await h.list()).skills.length, 0);
  });
}

test("Code Skills 外部来源只读、名称只筛已取得列表，诊断可读", async t => {
  const h = await fixture(t);
  const external = path.join(h.dirs.agentDir, "skills", "external");
  fs.mkdirSync(external, { recursive: true }); fs.writeFileSync(path.join(external, "SKILL.md"), "---\nname: external\ndescription: 外部维护\n---\n正文\n");
  fs.mkdirSync(path.join(h.dirs.agentDir, "skills", "broken")); fs.writeFileSync(path.join(h.dirs.agentDir, "skills", "broken", "SKILL.md"), "missing description");
  await h.state.read(); assert.ok(h.state.diagnostics.length);
  await h.state.select(h.state.skills[0].id);
  assert.equal(h.state.detail?.source, "external"); assert.equal(await h.state.remove(), false); assert.equal(await h.state.setEnabled(false), false);
  const rejected = await h.host.request("code", "skill_remove", { skill_id: h.state.selectedId, expected_revision: h.state.revision });
  assert.equal(rejected.ok, false); if (!rejected.ok) assert.equal(rejected.error.code, "skills_read_only");
  const count = h.requests.length; h.state.query = "nothing"; assert.equal(h.state.filtered.length, 0); h.state.query = "EXTERNAL"; assert.equal(h.state.filtered.length, 1); assert.equal(h.requests.length, count);
  await h.choose(h.source("external")); assert.equal(h.state.preview?.conflicts.length, 1); assert.equal(await h.state.save(), false);
});

test("Code Skills 清单冲突保留列表、选择与导入预览，刷新供比较且不重发", async t => {
  const h = await fixture(t);
  await h.choose(h.source("first")); await h.state.save();
  const selected = h.state.selectedId;
  await h.choose(h.source("second")); const preview = h.state.preview;
  await h.client.request("skill_set_enabled", { skill_id: selected, enabled: false, expected_revision: h.state.revision });
  assert.equal(await h.state.save(), false); assert.equal(h.state.phase, "conflict");
  assert.equal(h.state.selectedId, selected); assert.equal(h.state.preview, preview); assert.equal(h.state.skills[0].state, "enabled");
  await h.state.read(); assert.equal(h.state.skills[0].state, "disabled"); assert.equal(h.state.preview, preview); assert.equal(h.state.phase, "conflict");
  assert.equal(await h.state.save(), false);
  assert.equal(h.requests.filter(request => request.op === "desktop_skill_import").length, 2);
  await h.choose(h.source("second")); assert.equal(await h.state.save(), true);
});

test("Code Skills 导入丢答按原身份核实，查询失败保持待核实且不复制第二份", async t => {
  const h = await fixture(t);
  await h.choose(h.source()); const id = h.state.preview!.id;
  h.hooks.after = (op, result) => op === "desktop_skill_import" ? { ok: false, error: { code: "response_lost", outcome: "unknown", message: "应答丢失" } } : result;
  assert.equal(await h.state.save(), false); assert.equal(h.state.phase, "unknown");
  assert.equal((await h.list()).skills.length, 1);
  assert.equal(await h.state.save(), false); await h.state.choose();
  h.hooks.after = () => ({ ok: false, error: { code: "connection_unavailable", outcome: "not_sent", message: "离线" } });
  assert.equal(await h.state.read(), false); assert.equal(h.state.pending?.id, id); assert.equal(h.state.phase, "unknown");
  h.hooks.after = undefined; await h.state.read();
  assert.equal(h.state.phase, "ready"); assert.equal(h.state.pending, null); assert.equal(h.state.detail?.id, id);
  assert.equal(h.state.preview, null); assert.equal(h.requests.filter(request => request.op === "desktop_skill_import").length, 1);
  assert.deepEqual(fs.readdirSync(path.join(h.dirs.agentDir, "managed-skills", "packages")), [id]);
  assert.equal((await h.host.request("code", "desktop_skill_import", { selection_id: id })).ok, false, "宿主也拒绝重复消费");
});

test("Code Skills 重新选择取消或预览失败后旧预览只供比较，不能提交", async t => {
  const h = await fixture(t);
  await h.choose(h.source()); const preview = h.state.preview;
  await h.choose(null); assert.equal(h.state.preview, preview); assert.equal(h.state.previewStale, true); assert.equal(await h.state.save(), false);
  await h.choose(h.source()); const next = h.state.preview;
  await h.choose(path.join(fs.realpathSync(h.dirs.root), "missing"));
  assert.equal(h.state.preview, next); assert.equal(h.state.previewStale, true); assert.equal(await h.state.save(), false);
  assert.equal(h.requests.some(request => request.op === "desktop_skill_import"), false);
});

test("Code Skills 已选第 51 项在刷新首屏后仍可启停与移除，分页变化保留原列表", async t => {
  const h = await fixture(t);
  for (let i = 0; i < 50; i++) {
    const dir = path.join(h.dirs.agentDir, "skills", `ext-${i}`);
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ext-${i}\ndescription: 外部技能\n---\n正文\n`);
  }
  await h.choose(h.source()); await h.state.save(); const id = h.state.selectedId;
  assert.equal(h.state.skills.length, 50); assert.equal(h.state.hasMore, true); assert.equal(h.state.selected?.id, id);
  assert.equal(await h.state.setEnabled(false), true); assert.equal(h.state.detail?.state, "disabled");
  await h.state.read(true); assert.equal(h.state.skills.length, 51);
  await h.client.request("skill_set_enabled", { skill_id: id, enabled: true, expected_revision: h.state.revision });
  assert.equal(await h.state.read(true), false); assert.equal(h.state.phase, "conflict"); assert.equal(h.state.skills.length, 51);
  await h.state.read(); assert.equal(await h.state.remove(), true); assert.equal(h.state.detail?.state, "removed");
});

test("Code Skills 在途断线与迟到应答保留原关联，换实例不得读写", async t => {
  const h = await fixture(t), gate = deferred();
  await h.choose(h.source());
  h.hooks.before = async op => { if (op === "desktop_skill_import") await gate.promise; };
  const saving = h.state.save();
  h.context.online = false; h.state.invalidate(); gate.resolve(); await saving;
  assert.equal(h.state.phase, "unknown"); assert.notEqual(h.state.pending, null);
  h.context.online = true; h.context.instanceId = "other";
  assert.equal(await h.state.read(), false); assert.notEqual(h.state.pending, null);
  h.context.instanceId = h.instanceId; await h.state.read();
  assert.equal(h.state.pending, null); assert.equal(h.state.skills.length, 1);
  const reading = deferred(); h.hooks.before = async op => { if (op === "skills_list") await reading.promise; };
  const old = h.state.read(); h.state.invalidate(); h.context.instanceId = "new"; reading.resolve();
  assert.equal(await old, false); assert.equal(h.state.skills.length, 1);
});

test("Code Skills 启停和移除丢答均读回原身份，包括列表隐藏的已移除项", async t => {
  const h = await fixture(t);
  await h.choose(h.source()); await h.state.save(); const id = h.state.selectedId;
  h.hooks.after = (op, result) => ["skill_set_enabled", "skill_remove"].includes(op) ? { ok: false, error: { code: "response_lost", outcome: "disconnected", message: "应答丢失" } } : result;
  assert.equal(await h.state.setEnabled(false), false); assert.equal(h.state.phase, "unknown");
  await h.state.read(); assert.equal(h.state.phase, "ready"); assert.equal(h.state.detail?.state, "disabled");
  assert.equal(await h.state.remove(), false); assert.equal(h.state.phase, "unknown");
  await h.state.read(); assert.equal(h.state.phase, "ready"); assert.equal(h.state.selectedId, id);
  assert.equal(h.state.skills.length, 0); assert.equal(h.state.detail?.state, "removed"); assert.match(h.state.detail!.body, /旧引用可读/);
  assert.equal(h.requests.filter(request => request.op === "skill_remove").length, 1);
  assert.equal(h.requests.filter(request => request.op === "skill_set_enabled").length, 1);
});

test("Code Skills 导入丢答但后台未安装时明确读回未生效，重选前不能复制", async t => {
  const h = await fixture(t);
  await h.choose(h.source()); const original = h.state.preview!.id;
  const state = new CodeSkillsState({ ...h.bridge, request: async (target, op, params) => op === "desktop_skill_import" ? { ok: false, error: { code: "response_lost", outcome: "unknown", message: "应答丢失" } } : h.bridge.request(target, op, params) }, () => {}, h.instanceId, () => h.context);
  await state.read(); state.preview = h.state.preview;
  assert.equal(await state.save(), false); assert.equal(state.pending?.id, original);
  await state.read(); assert.equal(state.pending, null); assert.equal(state.phase, "conflict");
  assert.equal(state.preview?.id, original); assert.equal(state.previewStale, true); assert.equal(await state.save(), false);
  assert.equal((await h.list()).skills.length, 0);
});

test("Code Skills 导入草稿受关闭与目标导航保护，正文显示图片并过滤危险内容", async t => {
  const h = await fixture(t);
  await h.choose(h.source());
  const settings = new SettingsState(() => {}); settings.open = true; settings.form = h.state;
  assert.equal(settings.close(), false); assert.notEqual(settings.leave, null); settings.continueEditing();
  settings.chooseTarget("skills", "personal"); assert.equal(settings.selections.skills.target, "code");
  settings.discardAndLeave(); assert.equal(settings.selections.skills.target, "personal");
  await h.choose(h.source()); await h.state.save();
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { createServer } = await import("vite"); const { default: react } = await import("@vitejs/plugin-react");
  const server = await createServer({ configFile: false, root: path.resolve("apps/desktop/src/renderer"), plugins: [react()], server: { middlewareMode: true, hmr: false }, appType: "custom" });
  t.after(() => server.close());
  const module = await server.ssrLoadModule("/code-skills-settings.tsx");
  const Editor: ComponentType<{ state: CodeSkillsState }> = module.CodeSkillsEditor;
  const html = renderToStaticMarkup(createElement(Editor, { state: h.state }));
  assert.match(html, /后续新任务选择/); assert.match(html, /包字节保留/);
  const image = html.match(/<img\b[^>]*>/)?.[0] ?? "";
  assert.match(image, /src="https:\/\/invalid.example\/pixel"/); assert.match(image, /alt="远程"/);
  assert.doesNotMatch(html, /<script|javascript:|<iframe/);
});
