import { RuntimeApiError } from "./api-error.ts";
import type { ModelSelection } from "./types.ts";

/** 先核对结构，再进行幂等核实；模型能力与认证只检查尚未接收的请求。 */
export function parseModelSelection(value: unknown): ModelSelection {
  const v = value as Partial<ModelSelection> | null;
  if (!v || typeof v.provider !== "string" || !v.provider.trim() || typeof v.modelId !== "string" || !v.modelId.trim()
    || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(v.thinkingLevel as string)) {
    throw new RuntimeApiError("invalid_params", "model_selection 必须包含 provider、modelId 和合法 thinkingLevel");
  }
  return { provider: v.provider, modelId: v.modelId, thinkingLevel: v.thinkingLevel! };
}
