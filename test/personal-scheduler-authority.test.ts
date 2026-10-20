import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalMockModelServer as MockModelServer } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
test("定时创建授权：模型的字符串星期按同一SDK规范化恢复，原工具历史保留", async t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-schedule-authority-")));
  const model = new MockModelServer(request => request.messages.at(-1)?.role === "user" && request.messages.at(-1)?.content === "创建星期计划" ? { kind: "tool_calls", calls: [{ id: "weekly-schedule", name: "schedule_create", arguments: { label: "星期计划", instruction: "只分析自足资料", rule: { kind: "weekly", time_zone: "Asia/Tokyo", time: "09:00", weekdays: ["1"] } } }] } : { kind: "text", text: "已登记" });
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_SCHEDULE_AUTHORITY_TEST_KEY", contextWindow: 128000, maxTokens: 4096 }, previous = process.env[config.apiKeyEnv]; process.env[config.apiKeyEnv] = "test-only";
  let p: PersonalHarness | undefined;
  const open = async () => p = await openPersonalHarness({ directory, modelId: config.modelId, provider: personalProvider(config) });
  t.after(async () => { await p?.close(); await model.close(); if (previous === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = previous; fs.rmSync(directory, { recursive: true, force: true }); });
  p = await open(); await p.answer("创建星期计划", "owner-weekly");
  const page = await p.harness.commit(tx => p!.scheduler.list(tx), context), plan = page.items[0]; assert.ok(plan); assert.equal(plan.rule.kind, "weekly"); if (plan.rule.kind !== "weekly") assert.fail("未保存每周规则"); assert.deepEqual(plan.rule.weekdays, [1]);
  const history = (await p.main.entries({ order: "ascending" }, 256, undefined, context)).items, call = history.flatMap(entry => entry.model ?? []).flatMap(message => message.role === "assistant" ? message.content : []).find(part => part.type === "toolCall" && part.name === "schedule_create");
  assert.ok(call?.type === "toolCall"); assert.match(JSON.stringify(call.arguments), /"weekdays":\["1"\]/);
  const calls = model.calls.length; await p.close(); p = await open();
  assert.equal(model.calls.length, calls); assert.deepEqual((await p.harness.commit(tx => p!.scheduler.get(tx, plan.id), context)).rule, plan.rule);
});
