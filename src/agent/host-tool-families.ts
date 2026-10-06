import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolCategory } from "../core/types.ts";
import type { ApprovalGate } from "./approval-gate.ts";
import type { FamilyCheck } from "./tool-op-ledger.ts";

/** 一次宿主工具调用的身份；调用之间不得共享可变上下文。 */
export interface HostToolContext {
  taskId: string;
  sessionId: string;
  projectId: string;
  hostOpId: string;
}

export interface HostCall {
  context: HostToolContext | null;
  release(): void;
}

/** 兼容直接构造工具的旧测试替身；生产实现返回带 context 的句柄。 */
export type HostCallBinder = (sdkCallId: string) => HostCall | (() => void);

function once(fn: () => void): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    fn();
  };
}

/** 取得一次调用的独立上下文；旧测试只提供释放函数时回退到 taskContext。 */
export function hostCallFor(
  bindCall: HostCallBinder | undefined,
  taskContext: () => HostToolContext | null,
  sdkCallId: string,
): HostCall {
  const bound = bindCall?.(sdkCallId);
  if (!bound) return { context: taskContext(), release: () => {} };
  if (typeof bound === "function") return { context: taskContext(), release: once(bound) };
  return { context: bound.context, release: once(bound.release) };
}

export type HostToolRule = "no_effect" | "approval" | { family: string };

export interface HostToolLedger {
  ruleFor(name: string, params: Record<string, unknown>): HostToolRule;
  familyCheck?: FamilyCheck;
}

export interface HostToolRuntime {
  call: {
    taskContext(): HostToolContext | null;
    bindCall: HostCallBinder;
  };
  identity: {
    verifyMain(ctx: HostToolContext): string | null;
    verifyHost(ctx: HostToolContext): string | null;
  };
  approval: {
    request: ApprovalGate["request"];
    requestStanding: ApprovalGate["requestStanding"];
  };
  effects: {
    recordArtifact(hostOpId: string, artifactId: string): void;
    markEffectUnknown(hostOpId: string): void;
  };
}

export interface HostToolFamily {
  category: ToolCategory;
  names: readonly string[];
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
    for (const name of family.names) {
      if (names.has(name)) throw new Error(`宿主工具名重复：${name}`);
      names.add(name);
    }
    const built = family.build(runtime);
    const declared = new Set(family.names);
    const actual = new Set(built.map((tool) => tool.name));
    if (actual.size !== declared.size || [...actual].some((name) => !declared.has(name))) {
      throw new Error(`宿主工具族 ${family.category} 的工具名声明与构建结果不一致`);
    }
    tools.push(...built);
  }
  return { tools, names };
}
