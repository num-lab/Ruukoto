import { PersonalDirectoryClaimsDoc } from "./personal-directory-claims.ts";
import { PersonalAppDataDoc } from "./personal-app-data.ts";
import { PersonalSkillsDoc } from "./personal-skills.ts";
import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { AgentDoc, ROOT_CONVERSATION_ID, type Tx } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { PersonalError } from "./personal-error.ts";
import { PersonalToolsDoc } from "./personal-tools.ts";
import { mcpConfigurationCompatible, PersonalMcpConfigDoc } from "./personal-mcp.ts";
import { PersonalCommandsDoc, PERSONAL_COMMAND_WORK, personalCommandLegacyVersion } from "./personal-command-work.ts";
import { PersonalServiceDoc, personalServiceLegacyVersion } from "./personal-services.ts";
import { PersonalBrowserDoc } from "./personal-browser.ts";
import { effectivePersonalConfiguration } from "./personal-settings-records.ts";
import { parsePersonalMcp } from "./personal-mcp-config.ts";
import type { PersonalScheduleScope } from "./personal-scheduler-records.ts";
import { personalConfigurationVersions } from "./personal-settings-records.ts";

// Note: 见 .agents/notes/implemented/architecture/2026-10-18-personal-durable-scheduled-work.md
export async function capturePersonalScheduleScope(tx: Tx, servicePolicyPath?: string): Promise<PersonalScheduleScope> {
  const agent = await tx.doc(AgentDoc, ROOT_CONVERSATION_ID), tools = await tx.doc(PersonalToolsDoc);
  if (!Array.isArray(agent.tools) || !Array.isArray(agent.extensions)) throw new PersonalError("schedule_scope_invalid", "当前工具范围无法核实，未创建或执行计划；请查询配置。");
  let servicePolicy: { path: string; digest: string } | null = null;
  if (agent.extensions.includes("personal-service-inspect")) {
    if (!servicePolicyPath) throw new PersonalError("schedule_scope_invalid", "服务策略来源缺失，未创建或执行定时计划；请核实服务配置。");
    let bytes: Buffer;
    try { bytes = readFileSync(servicePolicyPath); } catch { throw new PersonalError("schedule_scope_invalid", "服务策略无法读取，未创建或执行定时计划；请核实服务配置。"); }
    servicePolicy = { path: servicePolicyPath, digest: createHash("sha256").update(bytes).digest("hex") };
  }
  const search = await effectivePersonalConfiguration(tx, "web-search", "*");
  const commands = agent.extensions.includes(PERSONAL_COMMAND_WORK) ? await tx.doc(PersonalCommandsDoc) : undefined, services = agent.extensions.includes("personal-service-inspect") ? await tx.doc(PersonalServiceDoc) : undefined;
  const snapshot: JsonValue = JSON.parse(JSON.stringify({ directoryClaims: PersonalDirectoryClaimsDoc.definition.version, ...(search?.config ? { webSearch: { version: search.version, config: search.config } } : {}), tools: tools.config ?? null, grants: tools.grants, grantVersion: tools.grantVersion, mcp: (await tx.doc(PersonalMcpConfigDoc)).config ?? null, commands: commands?.fingerprint ?? null, ...(commands?.configVersion ? { commandsVersion: commands.configVersion } : {}), services: services?.fingerprint ?? null, ...(services?.configVersion ? { servicesVersion: services.configVersion } : {}), servicePolicy, browser: (await tx.doc(PersonalBrowserDoc)).config ?? null, skills: (await tx.doc(PersonalSkillsDoc)).config, appData: (await tx.doc(PersonalAppDataDoc)).instanceId ?? null }));
  return { tools: [...agent.tools], extensions: [...agent.extensions], snapshot };
}

export async function verifyPersonalScheduleScope(tx: Tx, scope: PersonalScheduleScope) {
  const snapshot = scope.snapshot, policy = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot.servicePolicy : undefined;
  const policyPath = policy && typeof policy === "object" && !Array.isArray(policy) && typeof policy.path === "string" ? policy.path : undefined;
  const current = await capturePersonalScheduleScope(tx, policyPath), original = scope.snapshot, selected = current.snapshot;
  if (original && typeof original === "object" && !Array.isArray(original) && selected && typeof selected === "object" && !Array.isArray(selected)) for (const target of ["commands", "services"] as const) {
    const key = `${target}Version`;
    if (!(key in original) && key in selected && selected[key] === (target === "commands" ? personalCommandLegacyVersion(await personalConfigurationVersions(tx, target)) : personalServiceLegacyVersion(await personalConfigurationVersions(tx, target)))?.version) delete selected[key];
  }
  let comparable = scope;
  const before = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot.mcp : undefined;
  const after = current.snapshot && typeof current.snapshot === "object" && !Array.isArray(current.snapshot) ? current.snapshot.mcp : undefined;
  if (before && after && await mcpConfigurationCompatible(tx, parsePersonalMcp(before), parsePersonalMcp(after))) comparable = { ...scope, snapshot: { ...(snapshot as Record<string, JsonValue>), mcp: after } };
  if (!isDeepStrictEqual(current, comparable)) throw new PersonalError("schedule_scope_changed", "计划创建时的工具或资料范围已变更，已停止后续执行；请查询原运行和配置，核实未决效果后取消并重新创建计划。");
}
