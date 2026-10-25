import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { configurePersonalCommands, configurePersonalServices } from "../apps/ruukoto/src/personal-cli.ts";
import { configurePersonalSkills } from "../apps/ruukoto/src/personal-skills-cli.ts";
import { configurePersonalMcp } from "../apps/ruukoto/src/personal-mcp-cli.ts";
import { personalControl, startPersonalServer, type PersonalStatus } from "../apps/ruukoto/src/personal-control.ts";
import { lockPersonalProfile } from "../apps/ruukoto/src/personal-profile.ts";
import { readPersonalSettings, savePersonalSettings } from "../apps/ruukoto/src/personal-settings.ts";
import { PersonalMockModelServer } from "./helpers/mock-provider.ts";

test("CLI配置查看：持锁后台同PID读四类配置，模型更新后status反映实际选择且零模型调用", async t => {
  const directory = fs.realpathSync(fs.mkdtempSync("/tmp/rk-online-cli-settings-"));
  const model = new PersonalMockModelServer(() => assert.fail("查看和声明式保存不能请求模型"));
  t.after(async () => { await model.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const profile = lockPersonalProfile(directory);
  const config = { api: "openai-completions", baseUrl: await model.start(), modelId: "before-update", apiKeyEnv: "RUUKOTO_ONLINE_READ_UNUSED_KEY", contextWindow: 4096, maxTokens: 128 };
  fs.writeFileSync(path.join(directory, "model.json"), JSON.stringify(config) + "\n", { mode: 0o600 });
  fs.writeFileSync(path.join(directory, "mcp.json"), JSON.stringify({ version: 2, generation: "read-fixture", services: [{ id: "read", label: "只读配置", endpoint: "http://127.0.0.1:1/mcp", enabled: true, tools: [] }] }) + "\n", { mode: 0o600 });
  profile.release();
  let backend = await startPersonalServer(directory);
  t.after(() => backend.stop());
  const before = await readPersonalSettings(directory), inode = fs.statSync(path.join(directory, "control.sock")).ino;
  assert.equal(before.online, true);
  for (const [configure, answers] of [[configurePersonalSkills, ["1"]], [configurePersonalMcp, ["2", "1"]], [configurePersonalServices, ["1"]], [configurePersonalCommands, ["1"]]] as const) {
    const pending = [...answers]; let output = "";
    await configure({ question: async () => { assert.ok(pending.length); return pending.shift()!; }, write: value => { output += value; } }, directory);
    assert.equal(pending.length, 0); assert.ok(output.length);
    assert.equal(fs.statSync(path.join(directory, "control.sock")).ino, inode);
  }
  assert.equal((await personalControl<PersonalStatus>(directory, "GET", "/status")).model, config.modelId);
  const receipt = await savePersonalSettings(directory, before, before.revisions.model, { kind: "config.save", target: "model", value: { ...config, modelId: "after-update" } });
  assert.equal(receipt.status, "active");
  assert.equal((await personalControl<PersonalStatus>(directory, "GET", "/status")).model, "after-update");
  assert.equal(fs.statSync(path.join(directory, "control.sock")).ino, inode); assert.equal(model.calls.length, 0);
  for (const [target, filename] of [["model", "model.json"], ["mcp", "mcp.json"], ["telegram", "telegram.json"], ["qq", "qq.json"], ["commands", "command.json"], ["services", "service.json"]] as const) {
    await backend.stop();
    const file = path.join(directory, filename), original = fs.existsSync(file) ? fs.readFileSync(file) : null;
    fs.writeFileSync(file, "{broken", { mode: 0o600 });
    backend = await startPersonalServer(directory);
    const current = await readPersonalSettings(directory);
    assert.ok(current.fileIssues.some(issue => issue.target === target)); assert.equal(current.online, true);
    const repairedOther = await savePersonalSettings(directory, current, current.revisions["web-search"], { kind: "config.save", target: "web-search", value: { version: 1, enabled: false } });
    assert.equal(repairedOther.status, "active"); assert.equal(model.calls.length, 0);
    await backend.stop();
    if (original) fs.writeFileSync(file, original); else fs.unlinkSync(file);
    backend = await startPersonalServer(directory);
    assert.equal((await readPersonalSettings(directory)).fileIssues.length, 0);
  }
});
