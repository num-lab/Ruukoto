import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider } from "../apps/ruukoto/src/personal-model.ts";
import { parsePersonalMcp, type PersonalMcpConfig } from "../apps/ruukoto/src/personal-mcp-config.ts";
import { mcpConfigurationCompatible, PersonalMcpConfigDoc } from "../apps/ruukoto/src/personal-mcp.ts";
import { capturePersonalScheduleScope, verifyPersonalScheduleScope } from "../apps/ruukoto/src/personal-schedule-scope.ts";
import { appendPersonalConfiguration, personalConfigurationDigest, personalConfigurationVersions, selectPersonalConfiguration } from "../apps/ruukoto/src/personal-settings-records.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";

const context = BACKGROUND_CONTEXT;
const original = parsePersonalMcp({ version: 2, generation: "baseline", services: [{ id: "a", label: "原服务 A", enabled: true, endpoint: "http://127.0.0.1:1/mcp", tools: [{ name: "read", inputSchema: { type: "object" } }] }, { id: "b", label: "原服务 B", enabled: true, endpoint: "http://127.0.0.1:2/mcp", tools: [{ name: "read", inputSchema: { type: "object" } }] }] });
async function save(p: PersonalHarness, config: PersonalMcpConfig, version: string) {
  const content = JSON.stringify(config) + "\n", revision = personalConfigurationDigest(content);
  await p.harness.commit(async tx => { const previous = (await personalConfigurationVersions(tx, "mcp")).at(-1); await appendPersonalConfiguration(tx, { target: "mcp", version, revision, previousRevision: previous?.revision ?? null, previousVersion: previous?.version ?? null, config, content }); }, context);
  return revision;
}

test("MCP 保存链：实际计划校验允许离线连续改名，实质变化后改回仍拒绝", async t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "mcp-label-chain-")));
  let p: PersonalHarness | undefined;
  const config = { api: "openai-completions" as const, baseUrl: "http://127.0.0.1:3/v1", modelId: "mock-model", apiKeyEnv: "RUUKOTO_MCP_UPDATE_TEST_KEY", contextWindow: 128000, maxTokens: 1024 };
  t.after(async () => { await p?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  p = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, mcp: original });
  await save(p, original, "baseline"); await p.harness.commit(tx => selectPersonalConfiguration(tx, "mcp", "*", "baseline"), context);
  const scope = await p.harness.commit(tx => capturePersonalScheduleScope(tx), context);
  const first = parsePersonalMcp({ ...original, generation: "label-one", services: original.services.map(service => ({ ...service, label: `${service.label} 新名` })) });
  await save(p, first, "label-one");
  const second = parsePersonalMcp({ ...first, generation: "label-two", services: first.services.map(service => ({ ...service, label: `${service.label} 再改名` })) });
  const secondRevision = await save(p, second, "label-two");
  await p.updateMcp(second, "*", "label-two", secondRevision);
  await p.harness.commit(tx => verifyPersonalScheduleScope(tx, scope), context);
  await p.close();
  p = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, mcp: second });
  await p.harness.commit(tx => verifyPersonalScheduleScope(tx, scope), context);
  const changed = parsePersonalMcp({ ...second, generation: "endpoint-change", services: second.services.map(service => service.id === "a" ? { ...service, endpoint: "http://127.0.0.1:4/mcp" } : service) });
  await save(p, changed, "endpoint-change");
  const reverted = parsePersonalMcp({ ...second, generation: "endpoint-reverted" }), revision = await save(p, reverted, "endpoint-reverted");
  await p.updateMcp(reverted, "*", "endpoint-reverted", revision);
  await assert.rejects(p.harness.commit(tx => verifyPersonalScheduleScope(tx, scope), context), (error: unknown) => error instanceof PersonalError && error.code === "schedule_scope_changed");
  assert.equal(await p.harness.commit(tx => mcpConfigurationCompatible(tx, original, reverted, "b", "baseline"), context), true);
  assert.equal(await p.harness.commit(tx => mcpConfigurationCompatible(tx, original, reverted, "a", "baseline"), context), false);
});

test("MCP 对象发布：B 保存不顺带发布 A 的候选", async t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "mcp-scope-update-")));
  const config = { api: "openai-completions" as const, baseUrl: "http://127.0.0.1:3/v1", modelId: "mock-model", apiKeyEnv: "RUUKOTO_MCP_UPDATE_TEST_KEY", contextWindow: 128000, maxTokens: 1024 };
  const p = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, mcp: original });
  t.after(async () => { await p.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await save(p, original, "baseline"); await p.harness.commit(tx => selectPersonalConfiguration(tx, "mcp", "*", "baseline"), context);
  const a = parsePersonalMcp({ ...original, generation: "pending-a", services: original.services.map(service => service.id === "a" ? { ...service, endpoint: "http://127.0.0.1:4/mcp" } : service) });
  await save(p, a, "pending-a");
  const b = parsePersonalMcp({ ...a, generation: "published-b", services: a.services.map(service => service.id === "b" ? { ...service, label: "新的服务 B" } : service) });
  const revision = await save(p, b, "published-b");
  const result = await p.updateMcp(b, "b", "published-b", revision);
  assert.equal(result.effectiveRevision, revision);
  const effective = await p.harness.snapshot(PersonalMcpConfigDoc, context);
  assert.equal(effective?.config?.services.find(service => service.id === "a")?.endpoint, original.services[0].endpoint);
  assert.equal(effective?.config?.services.find(service => service.id === "b")?.label, "新的服务 B");
});
