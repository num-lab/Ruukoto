import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import type { OpResult } from "@ruukoto/control/ops.ts";
import { handleRequest } from "../apps/desktop/src/main/ipc.ts";
import type { DesktopBridge, DesktopResult, DesktopTarget } from "../apps/desktop/src/shared/bridge.ts";
import { CodeSkillsState } from "../apps/desktop/src/renderer/code-skills-state.ts";
import { SettingsState } from "../apps/desktop/src/renderer/settings-state.ts";

type Skill = OpResult<"skills_list">["skills"][number];
const revision = "sha256:" + "a".repeat(64);
const skill = (name: string, explicitOnly = false): Skill => ({ id: `external:${name}`, name, description: `${name}的任务指引`, explicitOnly, source: "external", readOnly: true, state: "enabled", contentRevision: revision });
const ok = (value: unknown): DesktopResult<unknown> => ({ ok: true, value });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const context = { instanceId: "original", online: true };
  const data: { page: OpResult<"skills_list">; before?: () => Promise<void>; fail?: boolean } = { page: { directory: "/home/code/.agents/skills", revision, skills: [skill("example", true)], offset: 0, hasMore: false, diagnostics: ["broken/SKILL.md：缺少描述"], diagnosticsTruncated: false } };
  const calls: { target: DesktopTarget; op: string; params: Record<string, unknown> }[] = [];
  const bridge: Pick<DesktopBridge, "request"> = { request: async (target, op, params) => {
    calls.push({ target, op, params }); await data.before?.();
    if (data.fail) return { ok: false, error: { code: "connection_unavailable", outcome: "not_sent", message: "连接不可用" } };
    if (op === "skills_list") return ok(structuredClone(data.page));
    assert.equal(op, "skill_get");
    const selected = data.page.skills.find(item => item.id === params.skill_id);
    return selected ? ok({ revision: data.page.revision, ...selected, body: "# 技能正文\n引用说明。" }) : { ok: false, error: { code: "skill_not_found", outcome: "rejected", message: "技能已不在当前目录" } };
  } };
  return { state: new CodeSkillsState(bridge, () => {}, "original", () => context), context, data, calls };
}

test("Code Skills 只读列表与详情、检索和诊断可用，关闭或切页无需保存", async () => {
  const h = fixture(); await h.state.read();
  assert.equal(h.state.skills[0].readOnly, true); assert.equal(h.state.skills[0].explicitOnly, true);
  assert.deepEqual(h.state.diagnostics, h.data.page.diagnostics);
  await h.state.select(h.state.skills[0].id); assert.match(h.state.detail!.body, /技能正文/);
  const count = h.calls.length; h.state.query = "nothing"; assert.equal(h.state.filtered.length, 0);
  h.state.query = "EXAMPLE"; assert.equal(h.state.filtered.length, 1); assert.equal(h.calls.length, count);
  assert.equal(h.state.dirty, false); assert.equal(await h.state.save(), false); assert.equal(h.calls.length, count);
  const settings = new SettingsState(() => {}); settings.open = true; settings.form = h.state;
  settings.chooseCategory("pa-skills"); assert.equal(settings.category, "pa-skills"); assert.equal(settings.leave, null);
  assert.ok(h.calls.every(call => call.target === "code" && ["skills_list", "skill_get"].includes(call.op)));
});

test("Code Skills 分页目录变化保留原列表，重新读取后采用新版本", async () => {
  const h = fixture(); h.data.page.hasMore = true; await h.state.read();
  h.data.page = { ...h.data.page, skills: [skill("second")], offset: 1, hasMore: false };
  await h.state.read(true); assert.equal(h.state.skills.length, 2); assert.equal(h.calls.at(-1)!.params.offset, 1);
  h.data.page = { ...h.data.page, revision: "sha256:" + "b".repeat(64), skills: [skill("changed")], offset: 0 };
  assert.equal(await h.state.read(true), false); assert.equal(h.state.phase, "conflict"); assert.deepEqual(h.state.skills.map(item => item.name), ["example", "second"]);
  await h.state.read(); assert.equal(h.state.phase, "ready"); assert.deepEqual(h.state.skills.map(item => item.name), ["changed"]);
});

test("Code Skills 离线与迟到读取不覆盖原实例，恢复后可重新读取", async () => {
  const h = fixture(); await h.state.read();
  h.data.fail = true; assert.equal(await h.state.read(), false); assert.equal(h.state.phase, "error"); assert.equal(h.state.skills[0].name, "example");
  h.data.fail = false;
  const gate = deferred(); h.data.before = () => gate.promise;
  const reading = h.state.read(); h.state.invalidate(); h.context.instanceId = "other";
  h.data.page.skills = [skill("other-instance")]; gate.resolve();
  assert.equal(await reading, false); assert.equal(h.state.skills[0].name, "example");
  const count = h.calls.length; assert.equal(await h.state.read(), false); assert.equal(h.calls.length, count);
  h.context.instanceId = "original"; h.data.before = undefined; await h.state.read(); assert.equal(h.state.skills[0].name, "other-instance");
});

test("桌面技能写操作在两目标均拒绝，不转发到后台", async () => {
  let calls = 0;
  for (const target of ["code", "personal"]) for (const op of ["desktop_skill_import", "skill_import", "skill_import_preview", "skill_set_enabled", "skill_remove"]) {
    const result = await handleRequest(target, op, {}, async () => { calls++; }, async () => { calls++; });
    assert.equal(result.ok, false, `${target}:${op}`); if (!result.ok) assert.equal(result.error.code, "op_not_allowed");
  }
  assert.equal(calls, 0);
});

test("Code Skills 页面仅显示固定目录、列表和诊断，没有技能管理操作", async t => {
  const h = fixture(); await h.state.read();
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { createServer } = await import("vite"); const { default: react } = await import("@vitejs/plugin-react");
  const server = await createServer({ configFile: false, root: path.resolve("apps/desktop/src/renderer"), plugins: [react()], server: { middlewareMode: true, hmr: false }, appType: "custom" });
  t.after(() => server.close());
  const { CodeSkillsEditor } = await server.ssrLoadModule("/code-skills-settings.tsx");
  const html = renderToStaticMarkup(createElement(CodeSkillsEditor, { state: h.state }));
  assert.match(html, /\$HOME\/\.agents\/skills\//); assert.match(html, /按名称检索/); assert.match(html, /example/); assert.match(html, /缺少描述/);
  assert.doesNotMatch(html, /导入|选择技能|停用|启用|删除|保存更改|托管副本/);
});
