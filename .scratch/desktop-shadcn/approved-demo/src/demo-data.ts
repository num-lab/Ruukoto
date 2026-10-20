import referenceData from "./reference-data.json";

export type ActivityItem = { action: string; file: string; note?: string; openTab?: string; diffFile?: string; stat?: string };
export type Step =
  | { type: "user" | "prose"; text: string }
  | { type: "activity"; summary: string; duration: string; expanded: boolean; items: ActivityItem[] }
  | { type: "command"; id: string; status: string; command: string; note: string; output: string };
export type Subagent = { id: string; name: string; role: string; status: string; duration: string; task: string; steps: Step[] };
export type Diff = { file: string; fullPath: string; add: number; del: number; lines: { type: string; no: number; code: string }[] };
export type Attachment = { id: string; name: string; size: number };
export type PendingSubmission = { draft: string; attachments: Attachment[]; queued: boolean; continuing: boolean };
export type Session = { id: string; title: string; status: string; steps: Step[]; subagents: Subagent[]; diffs: Diff[]; draft: string; attachments: Attachment[]; pendingSubmission: PendingSubmission | null; model: string; mode: string; continuing: boolean };
export type Workspace = { id: string; name: string; expanded: boolean; sessions: Session[] };
export type RightTab = { id: string; type: "new" | "diff" | "agent"; title: string; objectId?: string };
export type Scenario = "normal" | "running" | "paused" | "pending" | "offline" | "diff-error" | "diff-empty" | "diff-truncated";
export const scenarios: { value: Scenario; label: string }[] = [
  { value: "normal", label: "默认对话与审批" },
  { value: "running", label: "任务执行中" },
  { value: "paused", label: "队列已暂停" },
  { value: "pending", label: "输入接收结果待核实" },
  { value: "offline", label: "连接失败" },
  { value: "diff-error", label: "差异读取失败" },
  { value: "diff-empty", label: "写入空文件" },
  { value: "diff-truncated", label: "差异内容截断" },
];

// shortcut: 使用原稿的静态样例，迁移正式 GUI 时改接现有状态层。
export const initialWorkspaces: Workspace[] = (referenceData as Workspace[]).map(workspace => ({ ...workspace, sessions: workspace.sessions.map(session => ({ ...session, attachments: [], pendingSubmission: null })) }));

export function completeSubmission(session: Session, pending: PendingSubmission): Session {
  if (session.pendingSubmission !== pending) return session;
  const text = [pending.draft.trim(), ...pending.attachments.map(attachment => `［模拟附件：${attachment.name}］`)].filter(Boolean).join("\n");
  return { ...session, title: session.title === "新会话" ? text.slice(0, 32) : session.title, draft: "", attachments: [], continuing: false, pendingSubmission: null, steps: [...session.steps, { type: "user", text }, { type: "prose", text: pending.queued ? "演示：输入已排队，等待当前任务结束或恢复队列。未调用真实模型。" : "这是前端模拟回复。你可以继续检查对话排版、工具差异、SubAgent 标签与审批状态；没有调用模型或执行命令。" }] };
}

export function activitySummary(items: ActivityItem[]): string {
  const edited = new Set(items.filter(item => item.action === "Edit" || item.action === "Edited").map(item => item.file)).size;
  const written = new Set(items.filter(item => item.action === "Write").map(item => item.file)).size;
  return [edited ? `Edit ${edited} 个文件` : "", written ? `Write ${written} 个文件` : ""].filter(Boolean).join(" · ") || "工具活动";
}
