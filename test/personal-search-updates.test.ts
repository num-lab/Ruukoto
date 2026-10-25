import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc } from "@earendil-works/pi-durable";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider } from "../apps/ruukoto/src/personal-model.ts";
import { toolOperations } from "../apps/ruukoto/src/personal-tools.ts";
import { type PersonalWebSearchConfig } from "../apps/ruukoto/src/personal-tools-config.ts";
import { appendPersonalConfiguration, personalConfigurationDigest, personalConfigurationVersions } from "../apps/ruukoto/src/personal-settings-records.ts";
import { capturePersonalScheduleScope, verifyPersonalScheduleScope } from "../apps/ruukoto/src/personal-schedule-scope.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { PersonalMockModelServer } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
async function save(p: PersonalHarness, directory: string, config: PersonalWebSearchConfig, version: string) {
  const content = JSON.stringify(config) + "\n", revision = personalConfigurationDigest(content);
  await p.harness.commit(async tx => { const previous = (await personalConfigurationVersions(tx, "web-search")).at(-1); await appendPersonalConfiguration(tx, { target: "web-search", version, revision, previousRevision: previous?.revision ?? null, previousVersion: previous?.version ?? null, config, content }); }, context);
  fs.writeFileSync(path.join(directory, "web-search.json"), content, { mode: 0o600 });
  return p.updateWebSearch(config, version, revision);
}

test("搜索独立更新：无资料目录可用，停用保留在途原证据并收窄后续请求与旧计划", async t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "standalone-search-")));
  const model = new PersonalMockModelServer(request => {
    const last = request.messages.at(-1), value = String(last?.content);
    if (last?.role === "user" && value.startsWith("search:")) return { kind: "tool_calls", calls: [{ id: "search", name: "web_search", arguments: { query: value.slice(7) } }] };
    return { kind: "text", text: last?.role === "tool" ? value : "正常聊天" };
  });
  const key = "RUUKOTO_SEARCH_MODEL_KEY", previous = process.env[key], oldSearchKey = process.env.STANDALONE_SEARCH_KEY;
  process.env[key] = "test-only"; process.env.STANDALONE_SEARCH_KEY = "original-search-secret";
  const config = { api: "openai-completions" as const, baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: key, contextWindow: 128000, maxTokens: 1024 };
  let p: PersonalHarness | undefined, release!: () => void, received!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { received = resolve; });
  const originalFetch = globalThis.fetch; let searches = 0;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(input) !== "https://api.tavily.com/search") return originalFetch(input, init);
    searches++; assert.equal(new Headers(init?.headers).get("authorization"), "Bearer original-search-secret"); received(); await held;
    return new Response(JSON.stringify({ results: [{ url: "https://example.com/result", title: "搜索结果", content: "原搜索正文" }], original: true }), { status: 200, headers: { "content-type": "application/json" } });
  });
  t.after(async () => { release(); await p?.close(); await model.close(); fs.rmSync(directory, { recursive: true, force: true }); if (previous === undefined) delete process.env[key]; else process.env[key] = previous; if (oldSearchKey === undefined) delete process.env.STANDALONE_SEARCH_KEY; else process.env.STANDALONE_SEARCH_KEY = oldSearchKey; });
  p = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId });
  const enabled: PersonalWebSearchConfig = { version: 1, generation: "search-enabled", enabled: true, apiKeyEnv: "STANDALONE_SEARCH_KEY" };
  await save(p, directory, enabled, "search-enabled");
  const agent = await p.harness.snapshot(AgentDoc, p.main.id, context);
  assert.ok(Array.isArray(agent?.tools) && agent.tools.includes("web_search"));
  assert.ok(Array.isArray(agent?.tools) && !agent.tools.includes("read_file") && !agent.tools.includes("http_request"));
  p.suspendSettings("web-search", "*");
  assert.match(await p.answer("search:待核实保存", "suspended-search"), /search_settings_waiting/); assert.equal(searches, 0);
  assert.equal(await p.answer("搜索等待时聊天", "chat-during-search-settings"), "正常聊天");
  p.resumeSettings("web-search", "*");
  const scope = await p.harness.commit(tx => capturePersonalScheduleScope(tx), context);
  const pending = p.answer("search:持有请求", "in-flight"); await started;
  await save(p, directory, { ...enabled, generation: "search-disabled", enabled: false }, "search-disabled");
  release(); assert.match(await pending, /example.com/); assert.equal(searches, 1);
  assert.match(await p.answer("search:后续拒绝", "disabled-search"), /search_credentials_missing/); assert.equal(searches, 1);
  assert.equal(await p.answer("正常聊天", "unrelated-chat"), "正常聊天");
  const operations = await p.harness.commit(async tx => JSON.parse(JSON.stringify(await toolOperations(tx))), context);
  assert.equal(operations[0].effect, "returned"); assert.equal(operations[0].searchConfig.generation, "search-enabled"); assert.equal(operations[0].config, undefined);
  await save(p, directory, { ...enabled, generation: "search-reenabled" }, "search-reenabled");
  await assert.rejects(p.harness.commit(tx => verifyPersonalScheduleScope(tx, scope), context), (error: unknown) => error instanceof PersonalError && error.code === "schedule_scope_changed");
  await p.close(); p = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId });
  assert.equal(await p.answer("重启保留历史", "reopened"), "正常聊天");
});
