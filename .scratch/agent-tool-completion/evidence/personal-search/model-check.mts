import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openPersonalHarness } from "../../../../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, parsePersonalModel, type RequestEvidence } from "../../../../apps/ruukoto/src/personal-model.ts";
import { parsePersonalTools } from "../../../../apps/ruukoto/src/personal-tools-config.ts";
import { toolOperations } from "../../../../apps/ruukoto/src/personal-tools.ts";

type SourceProvider = { api: string; baseUrl: string; apiKey: string; models: Array<{ id: string; api?: string; contextWindow?: number; maxTokens?: number }> };
assert.equal(process.env.RUN_MODEL_CHECK, "1");
const raw = JSON.parse(fs.readFileSync(process.env.RUN_PERSONAL_MODELS_FILE!, "utf8")) as { providers: Record<string, SourceProvider> };
const provider = raw.providers.deepseek, model = provider.models.find(value => value.id === "deepseek-flash")!;
assert.ok(model && provider.apiKey && !provider.apiKey.startsWith("!"));
const envName = "PERSONAL_SEARCH_ACCEPTANCE_KEY", previous = process.env[envName];
process.env[envName] = process.env[provider.apiKey] ?? provider.apiKey;
const root = fs.realpathSync(fs.mkdtempSync("/tmp/rk-real-search-")), directory = path.join(root, "profile"), workspace = path.join(root, "data");
fs.mkdirSync(workspace);
const marker = `SEARCH_${randomUUID().replaceAll("-", "")}`;
fs.writeFileSync(path.join(workspace, "source.txt"), `OBSERVE_TARGET ${marker}\n`);
fs.writeFileSync(path.join(workspace, "other.txt"), "ordinary reference\n");
const stat = fs.statSync(workspace), tools = parsePersonalTools({ version: 1, generation: randomUUID(), workspace, identity: { dev: stat.dev, ino: stat.ino }, credentials: [] });
const config = parsePersonalModel({ api: model.api ?? provider.api, baseUrl: provider.baseUrl, modelId: model.id, apiKeyEnv: envName, contextWindow: model.contextWindow ?? 128000, maxTokens: Math.min(model.maxTokens ?? 4096, 4096) });
let personal: Awaited<ReturnType<typeof openPersonalHarness>> | undefined;
try {
  personal = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, tools });
  const answer = await personal.answer("请先调用list_files列出默认资料目录的文件，再调用search_files字面查找OBSERVE_TARGET，最后调用read_file读命中文件。最终只回复该行的SEARCH_开头随机校验码。", "search-real-owner");
  assert.ok(answer.includes(marker), "模型未返回实际文件中的校验码");
  const operations = await personal.harness.commit(async tx => JSON.parse(JSON.stringify(await toolOperations(tx))), BACKGROUND_CONTEXT);
  for (const kind of ["list_files", "search_files", "read_file"]) assert.ok(operations.some((value: { kind: string; effect: string }) => value.kind === kind && value.effect === "returned"), `缺实际${kind}`);
  const entries = (await personal.main.entries({ order: "ascending" }, 256, undefined, BACKGROUND_CONTEXT)).items;
  const requests = entries.filter(value => value.kind === "ruukoto.model-request").map(value => value.data as RequestEvidence);
  const payloads = requests.filter(value => value.payload !== undefined);
  const output = path.dirname(new URL(import.meta.url).pathname);
  fs.writeFileSync(path.join(output, "model-requests.json"), JSON.stringify(requests, null, 2) + "\n");
  fs.writeFileSync(path.join(output, "model-operations.json"), JSON.stringify(operations, null, 2) + "\n");
  fs.writeFileSync(path.join(output, "model-summary.json"), JSON.stringify({ model: `deepseek/${model.id}`, answer, actualRequests: payloads.length, operations: operations.map((value: { kind: string; effect: string; stopped: boolean }) => ({ kind: value.kind, effect: value.effect, stopped: value.stopped })), estimates: payloads.map(value => { const input = value.input as { messages: Array<{ role: string; content?: string; sections?: Record<string, string>; toolsAdded?: unknown[] }> }; const systems = input.messages.filter(message => message.role === "system"); return { toolSchemas: Math.ceil(JSON.stringify(systems.flatMap(message => message.toolsAdded ?? [])).length / 4), systemPrompt: Math.ceil(systems.flatMap(message => [message.content ?? "", ...Object.values(message.sections ?? {})]).join("\n").length / 4) }; }) }, null, 2) + "\n");
  process.stdout.write(`personal-search real model passed; requests=${payloads.length}\n`);
} finally {
  await personal?.close();
  if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous;
  fs.rmSync(root, { recursive: true, force: true });
}
