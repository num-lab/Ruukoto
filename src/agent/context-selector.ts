/**
 * 上下文选择器（issue 05 §3）：确定性、有预算约束、可替换。
 *
 * 输入：SDK 当前分支消息、系统提示、工具定义、参考块（项目指令、技能目录、
 * 继续来源与计划说明，块文本由各自来源产出）、可用记忆与预算。
 * 输出：本轮消息视图、来源引用与选择理由（供选择记录落盘）。
 *
 * 规则：
 * - 必留项：宿主系统指令、参考块（各注入一次）、当前任务原文（= 最后一条
 *   user 消息）、最新已完成的工具批次与当前任务最近一次成功 todo_write 所在
 *   批次（issue 25）；
 * - 视图顺序（issue 29，前缀稳定以命中提示缓存）：前缀参考块 / 长期记忆
 *   → 历史 → 任务级参考块 → 当前任务；块头不含版本（版本由组装写入选择记录）；
 * - 以完整交互为单位：较早的用户轮次连同其 assistant 与工具交互整体保留
 *   或移出；一次 assistant 的全部 toolCall 与对应 toolResult 不可拆分；
 * - 当前任务的工具循环按已完成批次取最近部分：最新批次必留，更早批次
 *   由近及远在预算内纳入；
 * - 超长工具结果在模型视图中替换为有界片段 + 可读取引用（历史原文不动）；
 * - 预算 = 模型 contextWindow − 输出/思考预留 − 下一批工具结果预留 −
 *   安全余量；估算用 estimateTokens（chars/4）× 校准系数，中文按字符数
 *   直接计入（chars/4 对中文不是保守上界）；
 * - 必留内容自身超预算：返回 ok=false（宿主据此暂停，不静默摘要）；
 * - 上下文压缩（issue 30，ADR 0016）：生效的压缩点作为输入——前 S 条消息换成
 *   摘要块，[S, C) 中的大工具结果换成占位说明；同一压缩点加同一组消息得到
 *   同一个视图。压缩后仍超预算才整轮移出，并在视图里加移出标记。
 *
 * 替换入口：宿主按配置选择策略函数；合法性、权限与最终预算检查始终由
 * 宿主在请求前执行（见 context-assembly 的发送前复核），策略失败不等于放行。
 */

import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { MemoryWithContent } from "../core/memory.ts";
import type { SelectionRecord, WindowSnapshot } from "../core/types.ts";

/** 选择策略版本（配置变化时递增并记录）。 */
export const SELECTOR_STRATEGY = "deterministic-v1";

export interface SelectorBudgetConfig {
  /** 模型上下文窗口总量（必须为正且来自可靠配置）。 */
  contextWindow: number;
  /** 模型单次输出上限（maxTokens）。 */
  maxTokens: number;
  /** 思考预算（按思考级别；off=0）。 */
  thinkingBudget: number;
  /** 为下一批工具结果预留。 */
  toolResultReserve: number;
  /** 估算误差安全余量（固定值）。 */
  safetyMargin: number;
  /** 校准系数：估算值 × 该系数后计入（默认 1.5，覆盖中文低估）。 */
  calibration: number;
  /** 长期记忆注入总预算（token，估算后）。 */
  memoryBudget: number;
  /** 单条工具结果在模型视图中的正文字符上限。 */
  toolResultViewChars: number;
  /** 上下文压缩高水位（issue 30）：视图估算超过 min(高水位, 输入预算) 才新建压缩点。 */
  compactionHighWater: number;
}

export const DEFAULT_BUDGET_CONFIG: Omit<SelectorBudgetConfig, "contextWindow" | "maxTokens"> = {
  thinkingBudget: 0,
  toolResultReserve: 8_000,
  safetyMargin: 2_000,
  calibration: 1.5,
  memoryBudget: 2_000,
  // 容纳 pi read/bash 的 50KB 输出与 64KB 单页加头部，只兜底真正超大的结果（issue 27）。
  // ponytail: 定值不随模型窗口变化；接入 128K 级窗口时一批多个大结果可能触发
  // context_budget_exceeded，届时改为按预算比例收紧
  toolResultViewChars: 80_000,
  compactionHighWater: 200_000,
};

export function validateBudgetConfig(config: SelectorBudgetConfig): SelectorBudgetConfig {
  const c = config;
  const bad = (field: string): never => {
    throw new SelectorConfigError(`预算配置无效：${field}（必须为正数且不超过模型上限）`);
  };
  if (!Number.isFinite(c.contextWindow) || c.contextWindow <= 0) bad("contextWindow 缺失或非正");
  if (!Number.isFinite(c.maxTokens) || c.maxTokens <= 0) bad("maxTokens 缺失或非正");
  if (c.maxTokens > c.contextWindow) bad("maxTokens 超过 contextWindow");
  for (const [k, v] of Object.entries({
    thinkingBudget: c.thinkingBudget,
    toolResultReserve: c.toolResultReserve,
    safetyMargin: c.safetyMargin,
    memoryBudget: c.memoryBudget,
    toolResultViewChars: c.toolResultViewChars,
  })) {
    if (!Number.isFinite(v) || v < 0) bad(`${k} 为负或缺失`);
  }
  if (!Number.isFinite(c.compactionHighWater) || c.compactionHighWater <= 0) bad("compactionHighWater 缺失或非正");
  if (!Number.isFinite(c.calibration) || c.calibration < 1) bad("calibration 小于 1");
  const reserved = c.maxTokens + c.thinkingBudget + c.toolResultReserve + c.safetyMargin;
  if (reserved >= c.contextWindow) bad("预留空间合计已达到或超过 contextWindow");
  return c;
}

export class SelectorConfigError extends Error {
  readonly code = "selector_config_invalid";
  constructor(message: string) {
    super(message);
  }
}

/**
 * 预算配置版本：生效配置的 FNV-1a 32 位哈希（正整数）。配置变化时版本
 * 随之变化，选择记录据此区分不同配置下的一轮调用。
 */
export function budgetConfigVersion(config: SelectorBudgetConfig): number {
  const json = JSON.stringify(config, Object.keys(config).sort());
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash || 1;
}

// ---------- 上下文窗口预算分解（issue 14；占比在后台统一计算，TUI 只渲染） ----------

export interface ContextBreakdownCategory {
  /** estimates 中的分类键。 */
  key: string;
  label: string;
  tokens: number;
  /** 占输入预算百分比（一位小数；预算非正时为 null）。 */
  pctOfBudget: number | null;
  /** 占总窗口百分比（无窗口快照时为 null）。 */
  pctOfWindow: number | null;
}

export interface ContextBreakdown {
  budget: number;
  estimatedTotal: number;
  /** 尚余输入空间（budget − estimatedTotal）。 */
  remainingInput: number;
  /** 总窗口与预留快照（null = 旧记录无快照或窗口值不可靠）。 */
  window: WindowSnapshot | null;
  windowUnavailableReason: string | null;
  categories: ContextBreakdownCategory[];
  /** 未分类/其他估算项（估算总量 − 已知分类合计；为 0 时省略）。 */
  other: ContextBreakdownCategory | null;
}

/**
 * 上下文分类登记（/context 分类与选择记录 estimates 的键，按此顺序展示）：参考块的
 * 分类与选择器写入的估算只能用这里的键，漏登记 typecheck 不过，不会落进「其他」。
 */
const CONTEXT_CATEGORIES = {
  systemPrompt: "系统提示",
  toolSchemas: "工具定义",
  projectInstructions: "项目指令",
  skills: "技能",
  memories: "长期记忆",
  resumedFrom: "继续来源",
  planMode: "计划模式",
  compactionSummary: "压缩摘要",
  mandatoryTurn: "当前任务",
  currentTaskBatches: "当前任务工具批次",
  historyTurns: "历史轮次",
} as const;

export type ContextCategory = keyof typeof CONTEXT_CATEGORIES;

/** 记录损坏（估算或快照自相矛盾）：调用方映射为明确错误，不展示可疑数字。 */
export class SelectionRecordCorrupt extends Error {
  readonly code = "selection_record_corrupt";
  constructor(detail: string) {
    super(`选择记录损坏：${detail}`);
  }
}

const pct = (tokens: number, denom: number | null): number | null =>
  denom !== null && denom > 0 ? Math.round((tokens / denom) * 1000) / 10 : null;

/** 输入侧预算：总窗口 − 各项预留（选择器与分解共用同一口径）。 */
function inputBudgetFor(c: WindowSnapshot): number {
  return c.contextWindow - c.maxTokens - c.thinkingBudget - c.toolResultReserve - c.safetyMargin;
}

/**
 * 由选择记录计算预算分解。分母固定为记录创建时的窗口快照；分类互斥，
 * 已用输入 + 尚余输入 + 各项预留 = 总窗口（仅舍入误差）。估算口径与
 * 选择器一致（同一校准系数），不据 provider usage 反推分类精确用量。
 */
export function selectionBreakdown(record: SelectionRecord): ContextBreakdown {
  const snapshot = record.windowSnapshot;
  let window: ContextBreakdown["window"] = null;
  let windowUnavailableReason: string | null = null;
  if (snapshot) {
    if (!Number.isFinite(snapshot.contextWindow) || snapshot.contextWindow <= 0) {
      windowUnavailableReason = "模型或 SDK 缺少可靠的上下文窗口值，无法计算总窗口占比";
    } else if (inputBudgetFor(snapshot) !== record.budget) {
      throw new SelectionRecordCorrupt(`窗口快照与输入预算不一致（记录 ${record.id}）`);
    } else {
      window = snapshot;
    }
  } else {
    windowUnavailableReason = "该记录缺少窗口快照（创建于快照上线之前），无法计算总窗口占比";
  }

  const categories: ContextBreakdownCategory[] = Object.entries(CONTEXT_CATEGORIES).map(([key, label]) => {
    const tokens = record.estimates[key] ?? 0;
    return { key, label, tokens, pctOfBudget: pct(tokens, record.budget), pctOfWindow: pct(tokens, window?.contextWindow ?? null) };
  });
  const known = categories.reduce((n, c) => n + c.tokens, 0);
  const otherTokens = record.estimatedTotal - known;
  if (otherTokens < 0) {
    throw new SelectionRecordCorrupt(`分类估算合计 ${known} 超过估算总量 ${record.estimatedTotal}（记录 ${record.id}）`);
  }
  const other: ContextBreakdownCategory | null =
    otherTokens > 0
      ? {
          key: "other",
          label: "其他（未分类）",
          tokens: otherTokens,
          pctOfBudget: pct(otherTokens, record.budget),
          pctOfWindow: pct(otherTokens, window?.contextWindow ?? null),
        }
      : null;

  return {
    budget: record.budget,
    estimatedTotal: record.estimatedTotal,
    remainingInput: record.budget - record.estimatedTotal,
    window,
    windowUnavailableReason,
    categories,
    other,
  };
}

/**
 * 参考块（issue 29）：来源产出的带标记内容，选择器只管位置、预算与记账。
 * 块头不含版本：版本变化不等于文本变化，版本由组装写入选择记录。
 */
export interface ReferenceBlock {
  /** 估算分类键（分类表登记的键）。 */
  category: ContextCategory;
  /** prefix = 历史之前（跨任务稳定）；task = 当前任务输入之前（只属于本任务）。 */
  placement: "prefix" | "task";
  /** 完整块文本（选择器包成 user 消息）。 */
  text: string;
}

export interface SelectorInput {
  /** SDK 当前分支消息（不可变；选择器不得修改）。 */
  messages: any[];
  systemPrompt: string;
  tools: Array<{ name: string; description?: string; parameters?: unknown }>;
  /** 本次调用的参考块（长期记忆除外），同一位置内按传入顺序排列。 */
  references?: ReferenceBlock[];
  /** 当前项目可用记忆（已按范围过滤）。 */
  memories: MemoryWithContent[];
  /** 进入选择前已被宿主排除的记忆（如来源范围已撤销）；原样记入排除。 */
  preExcludedMemories?: Array<{ memoryId: string; version: number; reason: string }>;
  budget: SelectorBudgetConfig;
  /** 上下文压缩（issue 30）：null/缺省 = 本会话不压缩（qq_group 与 chat 维持现状）。 */
  compaction?: { sessionId: string; checkpoint: CheckpointInput | null } | null;
}

/** 生效的压缩点（已核对指纹）：前 S 条由摘要替代，[S, C) 的大工具结果换成占位说明。 */
export interface CheckpointInput {
  id: string;
  summarizedCount: number;
  clearedCount: number;
  summary: string | null;
  summaryUntil: string | null;
  /** 被清理结果的 toolCallId → 条目 id（null = 建压缩点时未在会话文件中找到）。 */
  clearedRefs: Record<string, string | null>;
}

export interface SelectionExclusion {
  index: number;
  reason: string;
}

export interface SelectionDroppedUnpaired {
  index: number;
  /** 缺失配对的 toolCall id。 */
  toolCallId: string;
}

export interface SelectorOutput {
  ok: boolean;
  /** 模型视图消息（新数组；原消息对象不被修改）。 */
  messages: any[];
  /** 选入消息在原输入中的序号。 */
  includedIndices: number[];
  excluded: SelectionExclusion[];
  /**
   * 因缺失配对而从视图剔除的消息（崩溃恢复等造成的孤儿 toolCall /
   * toolResult）。原文在历史中不动；最终检查据此豁免配对核对。
   */
  droppedUnpaired: SelectionDroppedUnpaired[];
  includedMemories: Array<{ memoryId: string; version: number }>;
  excludedMemories: Array<{ memoryId: string; version: number; reason: string }>;
  /** 模型视图中被有界替换的工具结果（原输入序号 + 原/视图字符数）。 */
  cappedToolResults: Array<{ index: number; originalChars: number; viewChars: number }>;
  /** 估算明细（校准后 token；键为分类表登记的键，本次没有的分类不出现）。 */
  estimates: Record<string, number>;
  /** 输入侧可用预算（contextWindow − 预留）。 */
  budget: number;
  estimatedTotal: number;
  /** 不做预算移出时的视图估算（压缩判断用；issue 30）。 */
  unboundedTotal: number;
  /** 本次视图使用的压缩点（null = 无）。 */
  checkpointId: string | null;
  /** 由摘要块替代的前 S 条消息（不逐条记入选入或排除）。 */
  summarizedCount: number;
  /** ok=false 时的原因。 */
  failure?: string;
}

/** 可筛选的完整交互；序号始终指向原 SDK 分支，必留内容不在候选中。 */
export interface ContextCandidate {
  id: string;
  indices: number[];
  messages: any[];
}

function candidateId(indices: number[]): string {
  return `unit_${indices[0]}`;
}

/** 候选按基础策略的尝试顺序排列，包含因预算尚未进入基础视图的旧交互。 */
export function getContextCandidates(input: SelectorInput): ContextCandidate[] {
  // 摘要块不参与筛选：只取 [S, n) 内的单元
  const { groups, batches } = prepareContextGroups(input.messages, input.compaction?.checkpoint?.summarizedCount ?? 0);
  return [...[...batches].reverse(), ...groups.slice(0, -1).reverse()].map((indices) => ({
    id: candidateId(indices),
    indices: [...indices],
    messages: indices.map((index) => input.messages[index]),
  }));
}

/** 中文等多字节内容的保守估算：CJK 字符按 1 token 计，其余按 chars/4。 */
export function estimateMessageTokens(message: any, calibration: number): number {
  const base = estimateTokens(message);
  const cjk = countCjkChars(message);
  // chars/4 已把 CJK 字符按 1/4 计入；补足到每字符 1 token 的保守上界
  const conservative = base + Math.ceil((cjk * 3) / 4);
  return Math.ceil(conservative * calibration);
}

/** CJK 统一表意文字、平/片假名、谚文、全角符号。 */
function isCjkCodePoint(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x20000 && code <= 0x2a6df)
  );
}

function countCjkChars(message: any): number {
  let text = "";
  const collect = (content: unknown): void => {
    if (typeof content === "string") {
      text += content;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        const p = part as any;
        if (p?.type === "text" && typeof p.text === "string") text += p.text;
        else if (p?.type === "thinking" && typeof p.thinking === "string") text += p.thinking;
        else if ((p?.type === "toolCall" || p?.type === "tool_use" || p?.type === "tool-call") && p.arguments !== undefined) {
          try {
            text += JSON.stringify(p.arguments);
          } catch {
            // 忽略
          }
        }
      }
    }
  };
  collect(message?.content);
  if (typeof message?.command === "string") text += message.command;
  if (typeof message?.output === "string") text += message.output;
  if (typeof message?.summary === "string") text += message.summary;
  let count = 0;
  for (const ch of text) {
    if (isCjkCodePoint(ch.codePointAt(0)!)) count++;
  }
  return count;
}

function estimateTextTokens(text: string, calibration: number): number {
  let cjk = 0;
  for (const ch of text) {
    if (isCjkCodePoint(ch.codePointAt(0)!)) cjk++;
  }
  const base = Math.ceil(text.length / 4);
  return Math.ceil((base + Math.ceil((cjk * 3) / 4)) * calibration);
}

function estimateToolSchemaTokens(tools: SelectorInput["tools"], calibration: number): number {
  let json = "";
  try {
    json = JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })));
  } catch {
    json = "";
  }
  return estimateTextTokens(json, calibration);
}

/**
 * 把消息按"完整交互"分组：user 消息开启一组，后续 assistant/toolResult
 * 直到下一个 user 为止属于同一组。一次 assistant 的 toolCall 与其
 * toolResult 天然同组（不可拆分）。
 */
function groupIntoTurns(messages: any[]): number[][] {
  const groups: number[][] = [];
  let current: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const role = messages[i]?.role;
    if (role === "user" && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(i);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * 基础策略与实验共用配对清洗、完整分组和必留项，始终保留原消息序号。
 * from = 压缩点的 S：此前的消息由摘要替代，不再分组；当前任务输入必留，
 * S 伸进当前任务时原样保留（issue 30）。
 */
function prepareContextGroups(messages: any[], from = 0): {
  groups: number[][];
  /** 当前任务的单元：[0] 为任务输入，其后为已完成批次（S 之前的批次已去掉）。 */
  units: number[][];
  /** 当前任务中可修剪的工具批次（不含任务输入、最新批次与清单保底批次）。 */
  batches: number[][];
  todoUnit: number[] | undefined;
  mandatory: Set<number>;
  droppedUnpaired: SelectionDroppedUnpaired[];
} {
  const callIds = new Set<string>();
  for (const m of messages) {
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (part?.type === "toolCall" && typeof part.id === "string") callIds.add(part.id);
    }
  }
  const resultIds = new Set<string>();
  for (const m of messages) {
    if (m?.role === "toolResult" && typeof m.toolCallId === "string") resultIds.add(m.toolCallId);
  }
  // 崩溃残留的孤儿只从模型视图移出，不删历史，也不连带删掉当前任务要求。
  const droppedUnpaired: SelectionDroppedUnpaired[] = [];
  const droppedSet = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role === "assistant" && Array.isArray(m.content)) {
      const missing = m.content.find(
        (part: any) => part?.type === "toolCall" && typeof part.id === "string" && !resultIds.has(part.id),
      ) as any;
      if (missing) {
        droppedSet.add(i);
        droppedUnpaired.push({ index: i, toolCallId: missing.id });
      }
    } else if (m?.role === "toolResult" && typeof m.toolCallId === "string" && !callIds.has(m.toolCallId)) {
      droppedSet.add(i);
      droppedUnpaired.push({ index: i, toolCallId: m.toolCallId });
    }
  }
  const turns = groupIntoTurns(messages)
    .map((group) => group.filter((index) => !droppedSet.has(index)))
    .filter((group) => group.length > 0);
  const units = splitIntoUnits(turns.at(-1) ?? [], messages).filter((unit, k) => k === 0 || unit[0]! >= from);
  const history = turns.slice(0, -1).map((group) => group.filter((index) => index >= from)).filter((group) => group.length > 0);
  const groups = units.length > 0 ? [...history, units.flat()] : history;
  const mandatory = new Set<number>(units[0] ?? []);
  if (units.length > 1) for (const index of units.at(-1)!) mandatory.add(index);
  // 工作清单保底（issue 25）：当前任务最近一次成功 todo_write 所在批次与最新批次同级必留。
  // ponytail: 只在当前任务内保底；上一任务整轮被移出时模型看不到旧清单，需要时自行重写。
  // 跨任务保底另行立项（issue 25「关联与后续」）
  const todoUnit = units.slice(1).findLast((unit) => unit.some((i) => isTodoWriteSuccess(messages[i])));
  if (todoUnit) for (const index of todoUnit) mandatory.add(index);
  const batches = units.slice(1, -1).filter((unit) => unit !== todoUnit);
  return { groups, units, batches, todoUnit, mandatory, droppedUnpaired };
}

function isTodoWriteSuccess(message: any): boolean {
  return message?.role === "toolResult" && message.toolName === "todo_write" && message.isError === false;
}

/** 工具结果消息在模型视图中的有界替换（原文不动；附读取指引）。 */
function capToolResultView(
  message: any,
  maxChars: number,
): { message: any; capped: boolean; originalChars: number } {
  // skill 结果是拥有者提供的完整正文（已有 64 KiB 上限），不做首尾截取
  if (message?.role !== "toolResult" || message.toolName === "skill" || !Array.isArray(message.content)) {
    return { message, capped: false, originalChars: 0 };
  }
  let changed = false;
  let originalChars = 0;
  const content = message.content.map((part: any) => {
    if (part?.type === "text" && typeof part.text === "string" && part.text.length > maxChars) {
      changed = true;
      originalChars += part.text.length;
      const head = part.text.slice(0, Math.floor(maxChars / 2));
      const tail = part.text.slice(part.text.length - Math.floor(maxChars / 2));
      return {
        ...part,
        text: `${head}\n…[中间省略 ${part.text.length - maxChars} 字符；完整正文在会话历史与产物中，可用 history_read / read_artifact 按来源读取]…\n${tail}`,
      };
    }
    return part;
  });
  if (!changed) return { message, capped: false, originalChars: 0 };
  return { message: { ...message, content }, capped: true, originalChars };
}

// ---------- 上下文压缩（issue 30） ----------

/** 摘要提示要求的全文上限（约 4,000 字）；规划时摘要块按此上限估算。 */
const SUMMARY_MAX_CHARS = 4_000;
/** 第一层清理阈值：正文超过此字符数（或含图片）的工具结果换成占位说明。 */
const CLEAR_MIN_CHARS = 2_000;
const CLEAR_EXEMPT_TOOLS = new Set(["skill", "todo_write"]);

function textChars(message: any): number {
  return Array.isArray(message?.content)
    ? message.content.reduce((n: number, p: any) => n + (p?.type === "text" && typeof p.text === "string" ? p.text.length : 0), 0)
    : 0;
}

/** 第一层清理的对象：正文超过阈值或含图片的工具结果；skill 与 todo_write 豁免。 */
export function isClearableToolResult(message: any): boolean {
  return (
    message?.role === "toolResult" &&
    !CLEAR_EXEMPT_TOOLS.has(message.toolName) &&
    Array.isArray(message.content) &&
    (textChars(message) > CLEAR_MIN_CHARS || message.content.some((p: any) => p?.type === "image"))
  );
}

/** 占位说明：toolCallId 与 isError 不变，配对不受影响；注明找回原文的方法。 */
function clearedToolResultView(message: any, sessionId: string, entryId: string | null | undefined): any {
  const where = entryId ? `history_read session_id=${sessionId} entry_id=${entryId}` : "原文需重新执行工具获取";
  const text = `[已清理 · ${message.toolName ?? "unknown"} · 原 ${textChars(message)} 字符 · ${message.isError ? "失败" : "成功"} · ${where}]`;
  return { ...message, content: [{ type: "text", text }] };
}

function isoOf(timestamp: unknown): string {
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "未知时间";
}

function summaryBlock(checkpoint: CheckpointInput): any | null {
  if (!checkpoint.summary || checkpoint.summarizedCount <= 0) return null;
  return {
    role: "user",
    content: `[压缩摘要 · 较早的 ${checkpoint.summarizedCount} 条消息 · 至 ${checkpoint.summaryUntil ?? "未知时间"}]\n${checkpoint.summary}\n[/压缩摘要]`,
    timestamp: 0,
  };
}

function evictionMarker(count: number, first: unknown, last: unknown): any {
  return { role: "user", content: `[较早的 ${count} 轮交互未进入本次上下文 · ${isoOf(first)} 至 ${isoOf(last)}]`, timestamp: 0 };
}


/**
 * 模型视图的逐条变换：[from, clearTo) 中可清理的工具结果换成占位说明，其余按
 * 单条上限有界替换。视图只取决于消息本身与压缩点（issue 27、30）。
 */
function createViewer(
  messages: any[],
  config: SelectorBudgetConfig,
  clear: { from: number; to: number; sessionId: string; refs: Record<string, string | null> } | null,
) {
  const cache = new Map<number, any>();
  const capped = new Map<number, { originalChars: number; viewChars: number }>();
  const viewOf = (index: number): any => {
    const cached = cache.get(index);
    if (cached) return cached;
    let message: any;
    if (clear && index >= clear.from && index < clear.to && isClearableToolResult(messages[index])) {
      message = clearedToolResultView(messages[index], clear.sessionId, clear.refs[messages[index].toolCallId]);
    } else {
      const result = capToolResultView(messages[index], config.toolResultViewChars);
      message = result.message;
      if (result.capped) {
        capped.set(index, {
          originalChars: result.originalChars,
          viewChars: (message.content as any[]).reduce((n, p) => n + (typeof p?.text === "string" ? p.text.length : 0), 0),
        });
      }
    }
    cache.set(index, message);
    return message;
  };
  const tokensOf = (index: number): number => estimateMessageTokens(viewOf(index), config.calibration);
  return { viewOf, tokensOf, capped };
}

/**
 * 确定性选择策略（默认实现）。
 * 不修改输入；输出新消息数组（被替换视图的消息为浅拷贝）。
 */
export function selectContext(input: SelectorInput, decisions?: ReadonlyMap<string, boolean>): SelectorOutput {
  const config = validateBudgetConfig(input.budget);
  const { calibration } = config;
  const budget = inputBudgetFor(config);

  const estimates = {} as Record<ContextCategory, number>;
  estimates.systemPrompt = estimateTextTokens(input.systemPrompt, calibration);
  estimates.toolSchemas = estimateToolSchemaTokens(input.tools, calibration);

  const excluded: SelectionExclusion[] = [];
  const includedMemories: SelectorOutput["includedMemories"] = [];
  const excludedMemories: SelectorOutput["excludedMemories"] = [...(input.preExcludedMemories ?? [])];

  // 参考块（标记的参考消息，不冒充新的拥有者指令；各自只注入一次）：前缀块与
  // 长期记忆在历史之前；任务级块只属于当前任务，放在当前任务输入之前，不打断
  // 其前整段历史的提示缓存（issue 29）。
  const asMessage = (text: string) => ({ role: "user", content: text, timestamp: 0 });
  const references = input.references ?? [];
  const prefixMessages = references.filter((b) => b.placement === "prefix").map((b) => asMessage(b.text));
  const taskMessages = references.filter((b) => b.placement === "task").map((b) => asMessage(b.text));
  for (const block of references) {
    estimates[block.category] = (estimates[block.category] ?? 0) + estimateMessageTokens(asMessage(block.text), calibration);
  }

  // 记忆：单独预算，按输入顺序（项目优先、更新时间倒序、id 稳定）截取
  let memoryUsed = 0;
  for (const memory of input.memories) {
    const text = formatMemory(memory);
    const tokens = estimateTextTokens(text, calibration);
    if (memoryUsed + tokens > config.memoryBudget) {
      excludedMemories.push({ memoryId: memory.id, version: memory.currentVersion, reason: "memory_budget" });
      continue;
    }
    memoryUsed += tokens;
    includedMemories.push({ memoryId: memory.id, version: memory.currentVersion });
    prefixMessages.push(asMessage(text));
  }
  estimates.memories = memoryUsed;

  const messages = input.messages;
  const compaction = input.compaction ?? null;
  const checkpoint = compaction?.checkpoint ?? null;
  const from = checkpoint?.summarizedCount ?? 0;

  const { groups, batches, mandatory, droppedUnpaired } = prepareContextGroups(messages, from);
  if (decisions) {
    const ids = new Set([...batches, ...groups.slice(0, -1)].map(candidateId));
    for (const [id, keep] of decisions) {
      if (!ids.has(id) || typeof keep !== "boolean") throw new SelectorConfigError("筛选结果包含无效候选");
    }
  }
  const exclusionReason = (indices: number[]): string =>
    decisions?.get(candidateId(indices)) === false ? "jev_rejected" : "budget";

  // 视图消息缓存（[S, C) 按第一层清理，其余有界替换；记录被替换的片段范围供选择记录落盘）
  const { viewOf, tokensOf, capped: cappedByIndex } = createViewer(
    messages,
    config,
    checkpoint ? { from, to: checkpoint.clearedCount, sessionId: compaction!.sessionId, refs: checkpoint.clearedRefs } : null,
  );

  // 摘要块（issue 30）：替代前 S 条消息，位于参考块之后、历史之前
  const summary = checkpoint ? summaryBlock(checkpoint) : null;
  estimates.compactionSummary = summary ? estimateMessageTokens(summary, calibration) : 0;

  let mandatoryTokens = 0;
  for (const index of mandatory) mandatoryTokens += tokensOf(index);
  estimates.mandatoryTurn = mandatoryTokens;

  // 必留合计 = 此刻已写入的各项估算之和（失败文案逐项列出，数字总能对上）
  const fixed = Object.values(estimates).reduce((n, tokens) => n + tokens, 0);
  let unboundedTotal = fixed;
  for (const unit of [...batches, ...groups.slice(0, -1)]) for (const index of unit) unboundedTotal += tokensOf(index);
  if (fixed > budget) {
    const listed = (Object.keys(CONTEXT_CATEGORIES) as ContextCategory[])
      .filter((key) => estimates[key] > 0)
      .map((key) => `${CONTEXT_CATEGORIES[key]} ${estimates[key]}`);
    return {
      ok: false,
      messages: [],
      includedIndices: [],
      excluded: messages.map((_, index) => ({ index, reason: "budget_exceeded_mandatory" })),
      droppedUnpaired,
      includedMemories,
      excludedMemories,
      cappedToolResults: [],
      estimates,
      budget,
      estimatedTotal: fixed,
      unboundedTotal,
      checkpointId: checkpoint?.id ?? null,
      summarizedCount: from,
      failure: `必留内容（${listed.join(" + ")} = ${fixed}）超过输入预算 ${budget}`,
    };
  }

  // 压缩会话预留移出标记的空间，确定移出后换成实际估算（不压缩的会话维持现状，不加标记）
  // 最长标记：六位轮数，时间戳 ISO 定长
  const markerReserve = compaction ? estimateMessageTokens(evictionMarker(999_999, 0, 0), calibration) : 0;
  const evicted: number[][] = [];
  // 当前任务的较早工具批次：由近及远纳入（装不下即停，保持最近性）
  let used = fixed + markerReserve;
  const included = new Set<number>(mandatory);
  for (let u = batches.length - 1; u >= 0; u--) {
    const unit = batches[u]!;
    if (decisions?.get(candidateId(unit)) === false) {
      for (const index of unit) excluded.push({ index, reason: "jev_rejected" });
      continue;
    }
    let unitTokens = 0;
    for (const index of unit) unitTokens += tokensOf(index);
    if (used + unitTokens > budget) {
      for (let rest = u; rest >= 0; rest--) {
        const reason = exclusionReason(batches[rest]!);
        if (reason === "budget") evicted.push(batches[rest]!);
        for (const index of batches[rest]!) excluded.push({ index, reason });
      }
      break;
    }
    used += unitTokens;
    for (const index of unit) included.add(index);
  }
  estimates.currentTaskBatches = used - fixed - markerReserve;

  // 从近到远装入其余完整交互：一旦某组装不下，更老的组也不再尝试
  // （保持"最近的完整交互"语义，避免挑拣远旧碎片造成因果断裂）
  for (let g = groups.length - 2; g >= 0; g--) {
    const group = groups[g]!;
    if (decisions?.get(candidateId(group)) === false) {
      for (const index of group) excluded.push({ index, reason: "jev_rejected" });
      continue;
    }
    let groupTokens = 0;
    for (const index of group) groupTokens += tokensOf(index);
    if (used + groupTokens > budget) {
      for (let rest = g; rest >= 0; rest--) {
        const reason = exclusionReason(groups[rest]!);
        if (reason === "budget") evicted.push(groups[rest]!);
        for (const index of groups[rest]!) excluded.push({ index, reason });
      }
      break;
    }
    used += groupTokens;
    for (const index of group) included.add(index);
  }
  used -= markerReserve;
  // 移出标记（issue 30 §7）：整轮移出只作兜底，注明移出的轮数与时间范围
  let marker: any = null;
  if (compaction && evicted.length > 0) {
    const indices = evicted.flat();
    marker = evictionMarker(evicted.length, messages[Math.min(...indices)]?.timestamp, messages[Math.max(...indices)]?.timestamp);
    used += estimateMessageTokens(marker, calibration);
  }
  estimates.historyTurns = used - fixed - estimates.currentTaskBatches;

  const includedIndices = messages.map((_, i) => i).filter((i) => included.has(i));
  // 当前任务输入（最后一组的首条）必留，任务级块插在它之前
  const taskStart = includedIndices.indexOf(groups.at(-1)?.[0] ?? -1);
  const view = includedIndices.map((i) => viewOf(i));
  view.splice(taskStart < 0 ? view.length : taskStart, 0, ...taskMessages);
  // 前缀参考块与记忆 → 摘要块 → 移出标记 → [S, n) 的历史 → 任务级参考块 → 当前任务
  const viewWithPrefixes = [...prefixMessages, ...(summary ? [summary] : []), ...(marker ? [marker] : []), ...view];
  const cappedToolResults = includedIndices
    .filter((i) => cappedByIndex.has(i))
    .map((i) => ({ index: i, ...cappedByIndex.get(i)! }));

  return {
    ok: true,
    messages: viewWithPrefixes,
    includedIndices,
    excluded: excluded.sort((a, b) => a.index - b.index),
    droppedUnpaired,
    includedMemories,
    excludedMemories,
    cappedToolResults,
    estimates,
    budget,
    estimatedTotal: used,
    unboundedTotal,
    checkpointId: checkpoint?.id ?? null,
    summarizedCount: from,
  };
}

export interface CompactionPlan {
  /** 新的 S / C（S ≤ C，都落在单元边界）。 */
  summarizedCount: number;
  clearedCount: number;
  /** H' = min(高水位, 输入预算)。 */
  highWater: number;
  estimateBefore: number;
  /** 只做第一层（S 不动）时的估算。 */
  layerOneEstimate: number;
}

/**
 * 规划新压缩点（issue 30 §3）。before = 按生效压缩点的选择结果；不超过 H'、
 * 必留内容超预算或降幅不到 0.2 H' 时返回 null（不建压缩点，也不调用摘要模型）。
 * summaryBlockedBelow：摘要失败后的冷却，视图估算低于此值时只规划第一层。
 */
export function planCompaction(input: SelectorInput, before: SelectorOutput, summaryBlockedBelow?: number): CompactionPlan | null {
  const compaction = input.compaction;
  if (!compaction || !before.ok) return null;
  const config = input.budget;
  const highWater = Math.min(config.compactionHighWater, before.budget);
  if (before.unboundedTotal <= highWater) return null;
  const messages = input.messages;
  const current = compaction.checkpoint;
  const s0 = current?.summarizedCount ?? 0;
  const c0 = current?.clearedCount ?? 0;
  const { groups, units, todoUnit } = prepareContextGroups(messages, s0);
  const planUnits = [...groups.slice(0, -1), ...units];
  if (planUnits.length === 0) return null;
  const now = createViewer(messages, config, current ? { from: s0, to: c0, sessionId: compaction.sessionId, refs: current.clearedRefs } : null);
  const sum = (indices: number[], tokens: (i: number) => number): number => indices.reduce((n, i) => n + tokens(i), 0);

  // 保护尾部：由新到旧累计到 0.15 H' 的完整单元，至少含最新批次；必留单元（清单保底批次）同样不进覆盖范围
  let tail = 0;
  let limit = planUnits.at(-1)![0]!;
  for (let u = planUnits.length - 1; u >= 0; u--) {
    limit = planUnits[u]![0]!;
    tail += sum(planUnits[u]!, now.tokensOf);
    if (tail >= 0.15 * highWater) break;
  }
  if (todoUnit && todoUnit[0]! < limit) limit = todoUnit[0]!;

  // 第一层：C 推到保护尾部开头（条目 id 此时未解析，占位长度差几个 token，不影响规划）
  const clearedCount = Math.max(c0, limit);
  const cleared = createViewer(messages, config, { from: s0, to: clearedCount, sessionId: compaction.sessionId, refs: current?.clearedRefs ?? {} });
  const planIndices = planUnits.flat();
  let layerOneEstimate = before.unboundedTotal;
  for (const i of planIndices) if (i >= c0 && i < clearedCount) layerOneEstimate -= now.tokensOf(i) - cleared.tokensOf(i);

  // 第二层：取能压到低水位的最小单元边界（S ≤ C；任务输入原样保留，不计降幅）
  let summarizedCount = s0;
  let estimate = layerOneEstimate;
  const allowSummary = summaryBlockedBelow === undefined || before.unboundedTotal >= summaryBlockedBelow;
  if (allowSummary && layerOneEstimate > 0.5 * highWater) {
    const summaryMax = estimateMessageTokens(summaryBlock({
      id: "", summarizedCount: 999_999, clearedCount: 0, summary: "字".repeat(SUMMARY_MAX_CHARS),
      summaryUntil: new Date(0).toISOString(), clearedRefs: {},
    }), config.calibration);
    const delta = summaryMax - (before.estimates.compactionSummary ?? 0);
    const taskInput = new Set(units[0] ?? []);
    const bounds = [...new Set([...planUnits.map((u) => u[0]!).filter((b) => b > s0 && b < clearedCount), ...(clearedCount > s0 ? [clearedCount] : [])])];
    let removed = 0;
    let k = 0;
    for (const bound of bounds.sort((a, b) => a - b)) {
      for (; k < planIndices.length && planIndices[k]! < bound; k++) {
        if (!taskInput.has(planIndices[k]!)) removed += cleared.tokensOf(planIndices[k]!);
      }
      summarizedCount = bound;
      estimate = layerOneEstimate - removed + delta;
      if (estimate <= 0.5 * highWater) break;
    }
  }
  if (before.unboundedTotal - estimate < 0.2 * highWater) return null;
  return { summarizedCount, clearedCount, highWater, estimateBefore: before.unboundedTotal, layerOneEstimate };
}

/**
 * 把当前任务组拆成不可拆分的单元：任务输入（leading 非 assistant 消息）
 * 为一个单元；此后每个 assistant 消息连同其后的 toolResult 为一个批次单元。
 */
function splitIntoUnits(group: number[], messages: any[]): number[][] {
  const units: number[][] = [];
  let current: number[] = [];
  for (const index of group) {
    if (messages[index]?.role === "assistant" && current.length > 0) {
      units.push(current);
      current = [];
    }
    current.push(index);
  }
  if (current.length > 0) units.push(current);
  return units;
}

function formatMemory(memory: MemoryWithContent): string {
  const scope = memory.scope === "personal" ? "个人共享" : "本项目";
  return [
    `[长期记忆 ${memory.id} v${memory.currentVersion} · ${memory.category} · ${scope}]`,
    memory.content,
    `[/长期记忆 ${memory.id}]`,
  ].join("\n");
}
