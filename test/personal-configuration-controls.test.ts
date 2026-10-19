import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDocFamily, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { savePersonalConfig } from "../apps/ruukoto/src/personal-config.ts";
import { savePersonalMcp } from "../apps/ruukoto/src/personal-mcp-config.ts";
import { savePersonalTools } from "../apps/ruukoto/src/personal-tools-config.ts";
import { savePersonalBrowser } from "../apps/ruukoto/src/personal-browser-config.ts";
import { PersonalSchedulesDoc } from "../apps/ruukoto/src/personal-scheduler-records.ts";
import { hasPendingPersonalWork } from "../apps/ruukoto/src/personal-config-idle.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { PersonalMockModelServer as MockModelServer } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;
async function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === "darwin" ? "/tmp" : tmpdir(), "rk-config-"))), directory = path.join(root, "profile"), workspace = path.join(root, "data"); fs.mkdirSync(workspace);
  const model = new MockModelServer(() => ({ kind: "text", text: "回答中".repeat(100), chunkDelayMs: 20 }));
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: "CONFIG_CONTROLS_TEST_KEY", contextWindow: 128000, maxTokens: 1024 };
  const previous = process.env[config.apiKeyEnv]; process.env[config.apiKeyEnv] = "test-only";
  await savePersonalConfig(directory, config);
  const stat = fs.statSync(workspace), tools = { version: 1 as const, generation: "tools-first", workspace, identity: { dev: stat.dev, ino: stat.ino }, credentials: [] };
  const mcp = { version: 1 as const, generation: "mcp-first", services: [] };
  const browser = { version: 1 as const, generation: "browser-first", binaryPath: "/test/agent-browser", chromePath: "/test/chrome", headed: false };
  let p: PersonalHarness | undefined;
  t.after(async () => { await p?.close(); await model.close(); fs.rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = previous; });
  return { directory, config, model, tools, mcp, browser, open: async (extra = {}) => p = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, ...extra }) };
}

test("配置闭环：合法空闲调度监督允许启用和更换能力，保存后可重开且零模型", async t => {
  const f = await fixture(t); let p = await f.open(); const requestId = randomUUID();
  await p.harness.commit(tx => p.scheduler.create(tx, { requestId, label: "未来计划", instruction: "未来再执行", rule: { kind: "once", at: new Date(Date.now() + 3600000).toISOString(), timeZone: "UTC" } }, { kind: "local", requestId }), context);
  assert.ok((await p.harness.snapshot(PersonalSchedulesDoc, context))!.supervisor);
  await p.close();
  await savePersonalMcp(f.directory, f.mcp); await savePersonalTools(f.directory, f.tools); await savePersonalBrowser(f.directory, f.browser);
  const next = { ...f.config, modelId: "next-model" }; await savePersonalConfig(f.directory, next);
  p = await f.open({ provider: personalProvider(next), modelId: next.modelId, tools: f.tools, mcp: f.mcp, browser: f.browser }); await p.close();
  const mcp = { ...f.mcp, generation: "mcp-next" }, tools = { ...f.tools, generation: "tools-next" }, browser = { ...f.browser, generation: "browser-next" };
  await savePersonalMcp(f.directory, mcp); await savePersonalTools(f.directory, tools); await savePersonalBrowser(f.directory, browser);
  p = await f.open({ provider: personalProvider(next), modelId: next.modelId, tools, mcp, browser });
  assert.equal(f.model.calls.length, 0); assert.ok((await p.harness.snapshot(PersonalSchedulesDoc, context))!.supervisor);
});

test("配置闭环：未决输入拒绝同模型换端点和能力配置，文件原样保留；同配置仍可恢复", async t => {
  const f = await fixture(t), p = await f.open(); await p.submit("旧输入", "pending-config");
  const deadline = Date.now() + 10000;
  while (!f.model.calls.length) { assert.ok(Date.now() < deadline, "等待原模型请求超时"); await new Promise(resolve => setTimeout(resolve, 5)); }
  await p.close();
  const before = fs.readFileSync(path.join(f.directory, "model.json"), "utf8");
  await savePersonalConfig(f.directory, f.config);
  for (const change of [{ baseUrl: "https://different.example/v1" }, { apiKeyEnv: "ANOTHER_MODEL_KEY" }, { api: "openai-responses" as const }, { imageInput: true }]) await assert.rejects(savePersonalConfig(f.directory, { ...f.config, ...change }), code("model_changed_pending"));
  assert.equal(fs.readFileSync(path.join(f.directory, "model.json"), "utf8"), before);
  await assert.rejects(savePersonalMcp(f.directory, f.mcp), code("mcp_config_pending"));
  await assert.rejects(savePersonalTools(f.directory, f.tools), code("tools_config_pending"));
  await assert.rejects(savePersonalBrowser(f.directory, f.browser), code("browser_config_pending"));
  for (const name of ["mcp", "tools", "browser"]) assert.equal(fs.existsSync(path.join(f.directory, `${name}.json`)), false);
});

for (const broken of ["supervisor-id", "unclosed-run", "queued-input"] as const) test(`配置空闲：${broken} 不能冒充空闲监督任务`, async t => {
  const f = await fixture(t), p = await f.open(), requestId = randomUUID();
  await p.harness.commit(tx => p.scheduler.create(tx, { requestId, label: "监督", instruction: "未来", rule: { kind: "once", at: new Date(Date.now() + 3600000).toISOString(), timeZone: "UTC" } }, { kind: "local", requestId }), context);
  await p.harness.commit(async tx => {
    if (broken === "supervisor-id") delete (await tx.doc(PersonalSchedulesDoc)).supervisor;
    else if (broken === "unclosed-run") {
      const runDoc = defineDocFamily<{ run?: { id: string } }, null>({ kind: "ruukoto.schedule-run", scope: "session", version: 1, family: true, initial: () => ({}) });
      (await tx.doc(PersonalSchedulesDoc)).runs.push("unclosed"); (await tx.doc(runDoc, "unclosed", null)).run = { id: "unclosed" };
    } else await tx.createSubmission({ conversationId: ROOT_CONVERSATION_ID, type: "input", requestId: "queued", status: "queued" });
  }, context);
  await p.close();
  const storage = await openNodeSqliteStorage(path.join(f.directory, "personal.sqlite"));
  try { assert.equal(await hasPendingPersonalWork(storage), true); } finally { await storage.close(context); }
  await assert.rejects(savePersonalConfig(f.directory, { ...f.config, modelId: "next" }), code("model_changed_pending"));
});
