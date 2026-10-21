import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolCategory } from "@ruukoto/core/types.ts";
import type { ApprovalGate } from "./approval-gate.ts";
import type { SkillLibrary } from "./skills.ts";
import type { ManagedProcessRegistry } from "./managed-processes.ts";
import type { FamilyCheck } from "./tool-op-ledger.ts";
import type { Accessor } from "@ruukoto/core/access.ts";
import type { MemorySourceRef } from "@ruukoto/core/types.ts";
import type { AgentWaitCall } from "./agent-wait-tools.ts";
import type { OwnerQuestion, OwnerQuestionItem } from "@ruukoto/core/owner-questions.ts";
import type { BackgroundProcessCalls } from "./background-process-tools.ts";

/** 一次宿主工具调用的身份；调用之间不得共享可变上下文。 */
export interface HostToolContext {
  taskId: string;
  sessionId: string;
  projectId: string;
  hostOpId: string;
}

export interface HostCall {
  readonly context: HostToolContext | null;
  release(): void;
}

/** 按 SDK 调用 ID 取得独立句柄。 */
export type HostCallBinder = (sdkCallId: string) => HostCall;

function once(fn: () => void): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    fn();
  };
}

/** 取得一次调用的独立上下文；无绑定器的模块测试可直接提供上下文。 */
export function hostCallFor(
  bindCall: HostCallBinder | undefined,
  taskContext: () => HostToolContext | null,
  sdkCallId: string,
): HostCall {
  const bound = bindCall?.(sdkCallId);
  if (!bound) return { context: taskContext(), release: () => {} };
  return { context: bound.context, release: once(() => bound.release()) };
}

export type HostToolRule = "no_effect" | "approval" | { family: string };

export interface HostToolLedger {
  names: readonly string[];
  ruleFor(name: string, params: Record<string, unknown>): HostToolRule;
  familyCheck?: FamilyCheck;
}

export interface HostToolRuntime {
  registry: ManagedProcessRegistry;
  toolClass: "dev" | "main" | "subagent";
  call: {
    taskContext(): HostToolContext | null;
    bindCall: HostCallBinder;
  };
  identity: {
    verifyMain(ctx: HostToolContext): string | null;
    verifyHost(ctx: HostToolContext): string | null;
  };
  data?: {
    recordMemory?(ctx: HostToolContext, memoryId: string): void;
    accessor(ctx: HostToolContext): Accessor;
    sessionReadable(ctx: HostToolContext, sessionId: string, category: "history" | "artifact"): boolean;
    sourceReadable(ctx: HostToolContext, ref: MemorySourceRef): boolean;
  };
  approval: {
    request: ApprovalGate["request"];
    requestStanding: ApprovalGate["requestStanding"];
  };
  effects: {
    recordArtifact(hostOpId: string, artifactId: string): void;
    markEffectUnknown(hostOpId: string): void;
  };
  skills(): SkillLibrary | null;
  agentWait?: AgentWaitCall;
  ownerQuestions?: { create(ctx: HostToolContext, questions: OwnerQuestionItem[]): OwnerQuestion };
  backgroundProcesses?: BackgroundProcessCalls;
}

export interface HostToolFamily {
  category: ToolCategory;
  names: readonly string[] | ((runtime: HostToolRuntime) => readonly string[]);
  build(runtime: HostToolRuntime): ToolDefinition[];
  ledger?: HostToolLedger;
}

export function buildHostToolSet(
  families: readonly HostToolFamily[],
  runtime: HostToolRuntime,
): { tools: ToolDefinition[]; names: ReadonlySet<string> } {
  const names = new Set<string>();
  const tools: ToolDefinition[] = [];
  for (const family of families) {
    const declaredNames = typeof family.names === "function" ? family.names(runtime) : family.names;
    for (const name of declaredNames) {
      if (names.has(name)) throw new Error(`宿主工具名重复：${name}`);
      names.add(name);
    }
    const built = family.build(runtime);
    const declared = new Set(declaredNames);
    const actual = new Set(built.map((tool) => tool.name));
    if (built.length !== actual.size || actual.size !== declared.size || [...actual].some((name) => !declared.has(name))) {
      throw new Error(`宿主工具族 ${family.category} 的工具名声明与构建结果不一致`);
    }
    tools.push(...built);
  }
  return { tools, names };
}
