import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { parsePersonalModel, type PersonalModelConfig } from "./personal-model.ts";

export type PersonalModelPreset = { id: string; provider: string; name: string; config: PersonalModelConfig };

// Note: See .agents/notes/implemented/feature/2026-11-05-personal-setup-presets.md
export function personalModelPresets(): PersonalModelPreset[] {
  const presets: PersonalModelPreset[] = [];
  for (const [provider, apiKeyEnv, models] of [["OpenAI", "OPENAI_API_KEY", OPENAI_MODELS], ["Anthropic", "ANTHROPIC_API_KEY", ANTHROPIC_MODELS], ["DeepSeek", "DEEPSEEK_API_KEY", DEEPSEEK_MODELS]] as const) {
    for (const model of Object.values(models)) {
      if (model.id === "gpt-realtime-2.1" || model.api !== "openai-completions" && model.api !== "openai-responses" && model.api !== "anthropic-messages" || model.contextWindow < 1024 || model.maxTokens < 1 || model.maxTokens >= model.contextWindow) continue;
      presets.push({ id: `${model.provider}/${model.id}`, provider, name: model.name, config: parsePersonalModel({ api: model.api, baseUrl: model.baseUrl, modelId: model.id, apiKeyEnv, contextWindow: model.contextWindow, maxTokens: model.maxTokens, imageInput: model.input.includes("image") }) });
    }
  }
  return presets;
}
