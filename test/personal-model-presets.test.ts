import assert from "node:assert/strict";
import { test } from "node:test";
import { personalModelPresets } from "../apps/ruukoto/src/personal-model-presets.ts";
import { parsePersonalModel } from "../apps/ruukoto/src/personal-model.ts";

test("Personal installed presets retain each model's API, capacity and input modalities", () => {
  const presets = personalModelPresets();
  assert.deepEqual([...new Set(presets.map(preset => preset.provider))], ["OpenAI", "Anthropic", "DeepSeek"]);
  assert.equal(new Set(presets.map(preset => preset.id)).size, presets.length);
  for (const preset of presets) assert.deepEqual(parsePersonalModel(preset.config), preset.config);
  const config = (id: string) => { const preset = presets.find(preset => preset.id === id); assert.ok(preset); return preset.config; };
  assert.equal(config("openai/gpt-4.1").contextWindow, 1047576);
  assert.equal(config("openai/gpt-4o").contextWindow, 128000);
  assert.equal(config("openai/gpt-4.1").maxTokens, 32768);
  assert.equal(config("anthropic/claude-haiku-4-5").contextWindow, 200000);
  assert.equal(config("anthropic/claude-opus-5-5").contextWindow, 1000000);
  assert.equal(config("deepseek/deepseek-flash").maxTokens, 384000);
  assert.equal(config("deepseek/deepseek-flash").imageInput, true);
  assert.equal(config("deepseek/deepseek-v4-pro").imageInput, false);
  assert.equal(config("deepseek/deepseek-v4-pro").api, "openai-completions");
  assert.ok(!presets.some(preset => preset.id === "openai/gpt-4"));
  assert.ok(!presets.some(preset => preset.id === "openai/gpt-realtime-2.1"));
  assert.ok(Buffer.byteLength(JSON.stringify(presets)) < 32 * 1024);
});
