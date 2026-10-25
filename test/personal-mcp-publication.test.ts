import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness, type Storage } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { personalProvider, recordedModels } from "../apps/ruukoto/src/personal-model.ts";
import { configureMcp, PersonalMcpConfigDoc, personalMcp } from "../apps/ruukoto/src/personal-mcp.ts";
import { parsePersonalMcp } from "../apps/ruukoto/src/personal-mcp-config.ts";
import { appendPersonalConfiguration, effectivePersonalConfiguration, personalConfigurationDigest, selectPersonalConfiguration } from "../apps/ruukoto/src/personal-settings-records.ts";

const context = BACKGROUND_CONTEXT;

test("MCP 配置发布：服务交错提交保留彼此实际选择，原版本重核不复用全局generation", async t => {
  const storage = new MemoryStorage(), models = recordedModels(personalProvider({ api: "openai-completions", baseUrl: "http://127.0.0.1:1", modelId: "unused", apiKeyEnv: "MCP_PUBLICATION_TEST_UNUSED", contextWindow: 4096, maxTokens: 128 }), async () => assert.fail("配置发布不调用模型"));
  const harness = await Harness.open(storage, { models, registry: createRegistry() }, context);
  t.after(() => harness.close(context));
  await harness.root(context);
  const initial = parsePersonalMcp({ version: 2, generation: "initial-publication", services: ["a", "b"].map(id => ({ id, label: id, endpoint: "http://127.0.0.1:1/mcp", enabled: true, tools: [] })) });
  const a = parsePersonalMcp({ ...initial, generation: "publish-a", services: initial.services.map(service => service.id === "a" ? { ...service, label: "a-new" } : service) });
  const b = parsePersonalMcp({ ...a, generation: "publish-b", services: a.services.map(service => service.id === "b" ? { ...service, label: "b-new" } : service) });
  const versions = [initial, a, b].map((config, index) => ({ config, version: `publication-${index}`, content: JSON.stringify(config) + "\n" }));
  await harness.commit(async tx => {
    let previousRevision: string | null = null, previousVersion: string | null = null;
    for (const value of versions) {
      const revision = personalConfigurationDigest(value.content);
      await appendPersonalConfiguration(tx, { ...value, target: "mcp", revision, previousRevision, previousVersion });
      previousRevision = revision; previousVersion = value.version;
    }
    await selectPersonalConfiguration(tx, "mcp", "*", versions[0].version);
    await configureMcp(tx, initial);
  }, context);
  const runtime = personalMcp(initial, () => harness);
  let release!: () => void, entered!: () => void, armed = true;
  const held = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
  t.after(() => release());
  const commit = storage.commit.bind(storage);
  t.mock.method(storage, "commit", async (...[writes, ctx]: Parameters<Storage["commit"]>) => {
    if (armed && writes.some(write => write.type === "entry" && write.value.kind === "ruukoto.mcp-configuration")) { armed = false; entered(); await held; }
    return commit(writes, ctx);
  });
  const publishA = runtime.update(a, "a", versions[1].version, personalConfigurationDigest(versions[1].content));
  await reached;
  const publishB = runtime.update(b, "b", versions[2].version, personalConfigurationDigest(versions[2].content));
  await new Promise<void>(resolve => setImmediate(resolve)); release();
  await Promise.all([publishA, publishB]);
  assert.deepEqual(runtime.config.services.map(service => service.label), ["a-new", "b-new"]);
  assert.deepEqual((await harness.snapshot(PersonalMcpConfigDoc, context))?.config, runtime.config);
  const selected = await harness.commit(async tx => ({ a: await effectivePersonalConfiguration(tx, "mcp", "a"), b: await effectivePersonalConfiguration(tx, "mcp", "b") }), context);
  assert.equal(selected.a?.version, versions[1].version); assert.equal(selected.b?.version, versions[2].version);
  const generations = (await harness.snapshot(PersonalMcpConfigDoc, context))!.generations;
  assert.equal((await runtime.update(a, "a", versions[1].version, personalConfigurationDigest(versions[1].content))).code, "active");
  assert.deepEqual(runtime.config.services.map(service => service.label), ["a-new", "b-new"]);
  assert.deepEqual((await harness.snapshot(PersonalMcpConfigDoc, context))!.generations, generations);
  const empty = parsePersonalMcp({ ...runtime.config, generation: "publish-empty", services: [] }), content = JSON.stringify(empty) + "\n", revision = personalConfigurationDigest(content);
  await harness.commit(tx => appendPersonalConfiguration(tx, { target: "mcp", version: "publication-empty", content, config: empty, revision, previousVersion: versions[2].version, previousRevision: personalConfigurationDigest(versions[2].content) }), context);
  await runtime.update(empty, "*", "publication-empty", revision);
  for (const scope of ["*", "a", "b"]) assert.equal((await harness.commit(tx => effectivePersonalConfiguration(tx, "mcp", scope), context))?.version, "publication-empty");
});
