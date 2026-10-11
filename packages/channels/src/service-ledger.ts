import type { HostToolLedger } from "@ruukoto/agent/host-tool-families.ts";


export const SERVICE_TOOL_NAMES = ["service_inspect", "service_manage"] as const;

export const SERVICE_LEDGER: HostToolLedger = {
  names: SERVICE_TOOL_NAMES,
  ruleFor: (name) => name === "service_inspect" ? "no_effect" : "approval",
};
