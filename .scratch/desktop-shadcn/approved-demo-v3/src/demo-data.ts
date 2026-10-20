import type { BrowserNavigation } from "./inspector-data.ts";
import referenceData from "./reference-data.json";

export type ActivityItem = { action: string; file: string; note?: string; openTab?: string; diffFile?: string; stat?: string; command?: string; output?: string; error?: string; diff?: Diff; status?: "running" };
export type Step =
  | { type: "user" | "prose"; text: string }
  | { type: "activity"; summary: string; duration: string; expanded: boolean; items: ActivityItem[]; phase?: "thinking" | "working" }
  | { type: "command"; id: string; status: string; command: string; note: string; output: string };
export type Subagent = { id: string; name: string; role: string; status: string; duration: string; task: string; steps: Step[] };
export type Diff = { file: string; fullPath: string; add: number; del: number; lines: { type: string; no: number; code: string }[] };
export type Attachment = { id: string; name: string; size: number };
export type PendingSubmission = { draft: string; attachments: Attachment[]; queued: boolean; continuing: boolean };
export type Session = { id: string; title: string; status: string; steps: Step[]; subagents: Subagent[]; diffs: Diff[]; draft: string; attachments: Attachment[]; pendingSubmission: PendingSubmission | null; model: string; effort: string; context: { usedTokens: number; maxTokens: number; systemTokens: number; toolTokens: number }; mode: string; continuing: boolean };
export type Workspace = { id: string; name: string; expanded: boolean; sessions: Session[] };
export type RightTab = { id: string; title: string } & (
  | { type: "new" | "files" }
  | { type: "diff" | "agent"; objectId: string }
  | { type: "file"; objectId: string; mode: "preview" | "source" }
  | { type: "browser"; navigation: BrowserNavigation }
);
export type Scenario = "normal" | "tool-details" | "running" | "working" | "paused" | "pending" | "offline" | "diff-error" | "diff-empty" | "diff-truncated";
export const scenarios: { value: Scenario; label: string }[] = [
  { value: "normal", label: "默认对话与审批" },
  { value: "tool-details", label: "工具详情与错误" },
  { value: "running", label: "任务执行中 · Thinking" },
  { value: "working", label: "工具调用中 · Working" },
  { value: "paused", label: "队列已暂停" },
  { value: "pending", label: "输入接收结果待核实" },
  { value: "offline", label: "连接失败" },
  { value: "diff-error", label: "差异读取失败" },
  { value: "diff-empty", label: "写入空文件" },
  { value: "diff-truncated", label: "差异内容截断" },
];

// shortcut: 原稿活动与详情均为静态样例，迁移正式 GUI 时改接已记录的工具输入与结果。
export const initialWorkspaces: Workspace[] = (referenceData as Workspace[]).map(workspace => ({ ...workspace, sessions: workspace.sessions.map(session => ({ ...session, attachments: [], pendingSubmission: null, effort: "Medium", context: { usedTokens: 32000, maxTokens: 200000, systemTokens: 1500, toolTokens: 5300 } })) }));

// Note: 见 .agents/notes/implemented/feature/2026-10-16-demo-trace-tools.md
export function toolDetailsPreview(session: Session): Step[] {
  const diff = session.diffs[0];
  const path = diff?.fullPath ?? "README.md";
  return [
    { type: "user", text: "Inspect the workspace files and check the local dependency setup." },
    { type: "activity", summary: "", duration: "2.6s", expanded: true, items: [
      { action: "Read", file: path },
      { action: "Edited", file: path, diffFile: path },
      { action: "Write", file: "notes.txt", diff: { file: "notes.txt", fullPath: "notes.txt", add: 2, del: 0, lines: [{ type: "add", no: 1, code: "Dependency setup check" }, { type: "add", no: 2, code: "Keep the lockfile in sync with package.json." }] }, stat: "+2 -0" },
      { action: "Bash", file: "pnpm --version", command: "pnpm --version", output: "10.18.0" },
      { action: "Bash", file: "pnpm install --frozen-lockfile", command: "pnpm install --frozen-lockfile", error: 'ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with package.json' },
      { action: "Read", file: "src/missing.ts", error: "ENOENT: no such file or directory, open 'src/missing.ts'" },
    ] },
  ];
}

export function executionPreview(session: Session, phase: "thinking" | "working"): Step[] {
  const diff = session.diffs[0];
  const items: ActivityItem[] = phase === "working" ? [
    { action: "Read", file: diff?.fullPath ?? "README.md" },
    ...(diff ? [{ action: "Edited", file: diff.fullPath, diffFile: diff.fullPath, stat: `+${diff.add} -${diff.del}` }] : []),
    { action: "Bash", file: "pnpm test:unit", command: "pnpm test:unit", output: "RUN  Unit tests", status: "running" },
  ] : [];
  return [...session.steps.filter(step => step.type !== "command" || step.status !== "pending"), { type: "activity", phase, summary: "", duration: "", expanded: true, items }];
}

export function completeSubmission(session: Session, pending: PendingSubmission): Session {
  if (session.pendingSubmission !== pending) return session;
  const text = [pending.draft.trim(), ...pending.attachments.map(attachment => `［模拟附件：${attachment.name}］`)].filter(Boolean).join("\n");
  return { ...session, title: session.title === "新会话" ? text.slice(0, 32) : session.title, draft: "", attachments: [], continuing: false, pendingSubmission: null, steps: [...session.steps, { type: "user", text }, { type: "prose", text: pending.queued ? "演示：输入已排队，等待当前任务结束或恢复队列。未调用真实模型。" : "这是前端模拟回复。你可以继续检查对话排版、工具差异、SubAgent 标签与审批状态；没有调用模型或执行命令。" }] };
}

export function activitySummary(items: ActivityItem[]): string {
  const actions = new Set(items.map(item => item.action));
  const summary = [
    actions.has("Read") || actions.has("Grep") ? "read files" : "",
    ["Bash", "Run", "Build", "Bench"].some(action => actions.has(action)) ? "ran commands" : "",
    actions.has("Edit") || actions.has("Edited") ? "edited files" : "",
    actions.has("Write") ? "wrote files" : "",
  ].filter(Boolean).join(", ");
  return summary ? summary[0].toUpperCase() + summary.slice(1) : "工具活动";
}
