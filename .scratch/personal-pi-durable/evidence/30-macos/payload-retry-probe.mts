import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openPersonalHarness } from "../../../../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig, type RequestEvidence } from "../../../../apps/ruukoto/src/personal-model.ts";
import { MockModelServer } from "../../../../test/helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk30-payload-retry-")));
const model = new MockModelServer(() => ({ kind: "text", text: "原生重试后完成" }));
const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: "RK_PAYLOAD_RETRY_PROBE_KEY", contextWindow: 128000, maxTokens: 8192 };
process.env.RK_PAYLOAD_RETRY_PROBE_KEY = "local-probe-only";
const provider = personalProvider(config), original = provider.streamSimple.bind(provider);
let fetchAttempts = 0;
provider.streamSimple = (selected, input, settings) => original(selected, input, { ...settings, fetch: async (...args: Parameters<typeof fetch>) => {
  fetchAttempts++;
  if (fetchAttempts === 1) throw new TypeError("fetch failed");
  return globalThis.fetch(...args);
} });
let personal: Awaited<ReturnType<typeof openPersonalHarness>> | undefined;
try {
  personal = await openPersonalHarness({ directory, provider, modelId: config.modelId });
  assert.equal(await personal.answer("只测试首次HTTP发送前的传输失败", "payload-retry-probe"), "原生重试后完成");
  const entries = (await personal.main.entries({ order: "ascending" }, 256, undefined, context)).items;
  const records = entries.filter(entry => entry.kind === "ruukoto.model-request").map(entry => entry.data as RequestEvidence);
  const payloads = records.flatMap(value => value.payload === undefined ? [] : [value.payload]);
  const requests = model.calls.map(value => value.raw);
  const errors = entries.flatMap(entry => entry.model ?? []).filter(message => message.role === "assistant" && message.stopReason === "error");
  assert.equal(fetchAttempts, 2);
  assert.equal(requests.length, 1);
  assert.equal(payloads.length, 2);
  assert.deepEqual(payloads[0], payloads[1]);
  assert.deepEqual(payloads[1], requests[0]);
  assert.equal(errors.length, 1);
  const adjacent = (values: unknown[]) => values.filter((value, index) => index === 0 || !isDeepStrictEqual(value, values[index - 1]));
  assert.deepEqual(adjacent(payloads), adjacent(requests));
  for (const request of requests) assert.ok(payloads.some(payload => isDeepStrictEqual(payload, request)));
  const facts = { environment: { platform: process.platform, arch: process.arch, node: process.version }, model: "回环HTTP替身，非真实模型", injection: "首次provider.fetch在调用globalThis.fetch之前抛TypeError(fetch failed)", fetchAttempts, httpRequests: requests.length, preparedPayloads: payloads.length, adjacentPayloadsEqual: isDeepStrictEqual(payloads[0], payloads[1]), durableErrors: errors.map(message => message.role === "assistant" ? message.errorMessage : undefined), requestIds: records.filter(value => value.payload !== undefined).map(value => value.requestId), passed: true };
  fs.writeFileSync(path.join(import.meta.dirname, "payload-retry-probe-result.json"), JSON.stringify(facts, null, 2) + "\n");
  fs.writeFileSync(path.join(import.meta.dirname, "payload-retry-probe-records.json"), JSON.stringify({ records, requests }, null, 2) + "\n");
  process.stdout.write(JSON.stringify(facts) + "\n");
} finally {
  await personal?.close();
  await model.close();
  delete process.env.RK_PAYLOAD_RETRY_PROBE_KEY;
  fs.rmSync(directory, { recursive: true, force: true });
}
