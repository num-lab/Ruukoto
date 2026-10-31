// Note: 见 .agents/notes/implemented/bug-fix/2026-10-17-desktop-transcript-rendering.md
// Note: 见 .agents/notes/implemented/feature/2026-10-21-coding-owner-questions.md
// Note: 见 .agents/notes/implemented/feature/2026-10-28-desktop-message-actions.md
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, GitBranch, Loader2, Undo2 } from "lucide-react";
import type { Components } from "streamdown";
import type { FlowEntry } from "@ruukoto/view/event-flow.ts";
import type { CodeState } from "./code-state.ts";
import { isDiffTool, type DiffTool } from "./diff.ts";
import { MarkdownText } from "./markdown.tsx";
import { conversationActivity, conversationSections, executionDuration, isAgentTool } from "./activity.ts";
import { AgentActivity, ExecutionTrace, ToolActivity } from "./tool-activity.tsx";
import { OwnerQuestionCard, OwnerQuestionCards } from "./owner-question-cards.tsx";
import { ApprovalCards } from "./approval-cards.tsx";
import { Bubble, BubbleContent } from "./components/ui/bubble.tsx";
import { Button } from "./components/ui/button.tsx";
import { Message, MessageContent } from "./components/ui/message.tsx";
import { MessageScroller, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from "./components/ui/message-scroller.tsx";

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    // 宿主统一拒绝网页权限；退回不依赖权限的选区复制。
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-9999px";
  document.body.appendChild(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (!copied) throw new Error("复制消息失败");
}

function MessageEntry({ model, sessionId, entry, child, branchable, tools, toolCount, referencesKey }: { model: CodeState; sessionId: string; entry: Extract<FlowEntry, { kind: "message" }>; child: boolean; branchable: boolean; tools: DiffTool[]; toolCount: number; referencesKey: string }) {
  const text = child && entry.role === "user" && entry.taskId ? model.view.tasks.get(entry.taskId)?.displayInput ?? entry.text : entry.text;
  const [copied, setCopied] = useState(false);
  const markdown = useMemo(() => {
    const components: Components = {
      inlineCode: ({ children }) => {
        const path = String(children);
        let diff: DiffTool | undefined;
        if (model.target === "code") for (let index = toolCount - 1; index >= 0; index--) if (tools[index].target === path) { diff = tools[index]; break; }
        const code = <code className="relative rounded bg-muted px-[0.3rem] py-[0.1rem] font-mono text-[13px] font-normal wrap-anywhere">{diff ? path.split("/").map((segment, index) => <Fragment key={index}>{index > 0 && "/"}{index > 0 && <wbr />}{segment}</Fragment>) : children}</code>;
        return diff ? <a className="file-reference" href="#right-sidebar" onClick={event => { event.preventDefault(); const current = model.view.openSession(sessionId).flow.items.find(item => item.key === diff.key); if (current?.kind === "tool") model.inspector.openDiff(sessionId, current); }}>{code}</a> : code;
      },
    };
    return <div className="markdown"><MarkdownText components={components}>{text}</MarkdownText></div>;
  }, [text, model, sessionId, referencesKey]);
  const content = <>{markdown}{entry.attachments?.map(attachment => <div key={attachment.id}>［附件：{attachment.name}］</div>)}</>;
  const task = entry.taskId ? model.view.tasks.get(entry.taskId) : undefined;
  const completed = entry.role === "assistant" && !entry.streaming && task?.status === "completed" && (!!entry.text.trim() || !!entry.attachments?.length);
  const showCopy = !!text.trim() && (entry.role === "user" || completed);
  const showBranch = completed && branchable;
  // Only the server-selected candidate message exposes the recall action.
  const recallCandidate = entry.role === "user" && !!entry.taskId && model.writes.recallState(sessionId)?.candidate?.kind === "task" && model.writes.recallState(sessionId)?.candidate?.taskId === entry.taskId;
  const pendingHere = model.pendingBranch?.sessionId === sessionId && model.pendingBranch?.taskId === entry.taskId;
  const copy = async () => {
    try {
      await copyText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      model.message = "复制消息失败，请手动选择正文复制。";
      model.refresh();
    }
  };
  const actions = (showCopy || showBranch || recallCandidate) && <div className={`flex items-center gap-0.5 -mt-0.5 -ml-1.5 text-muted-foreground ${entry.role === "user" ? "self-end" : ""}`} role="group" aria-label="消息操作">
    {showCopy && <Button type="button" variant="ghost" size="icon-xs" aria-label="复制消息" title={entry.truncated ? "正文尚未读取完整" : "复制消息"} disabled={entry.truncated} onClick={() => void copy()}>{copied ? <Check /> : <Copy />}</Button>}
    {showBranch && <Button type="button" variant="ghost" size="icon-xs" aria-label="从当前任务建立分支" title="从当前任务建立分支" disabled={model.status.state !== "online" || !!model.pendingCreation || (!!model.pendingBranch && !pendingHere)} onClick={() => void model.branch(sessionId, entry.taskId!)}>{pendingHere ? <Loader2 className="animate-spin" /> : <GitBranch />}</Button>}
    {recallCandidate && <Button type="button" variant="ghost" size="icon-xs" aria-label="撤回此输入并编辑" title="撤回此输入并编辑" disabled={model.writes.blocked(sessionId)} onClick={() => void model.writes.recall(sessionId, entry.taskId!)}><Undo2 /></Button>}
  </div>;
  return <Message align={entry.role === "user" ? "end" : "start"}><MessageContent>{entry.role === "user" ? <><Bubble variant="muted" align="end"><BubbleContent>{content}</BubbleContent></Bubble>{actions}</> : <>{content}{actions}</>}</MessageContent></Message>;
}
// Note: 见 .agents/notes/implemented/architecture/2026-10-16-desktop-trace-migration.md
export function Conversation({ model, sessionId, child = false }: { model: CodeState; sessionId: string; child?: boolean }) {
  const scroll = useRef<HTMLDivElement>(null);
  // Load the recall candidate on entry; message_recall.changed and task.queued drive subsequent updates.
  useEffect(() => { void model.writes.loadRecallState(sessionId); }, [model, sessionId]);
  const loadingOlder = useRef(false);
  const session = model.view.openSession(sessionId);
  const items = session.flow.items;
  const positionedQuestions = !child && model.target === "code" ? model.view.ownerQuestions.filter(question => question.sessionId === sessionId && items.some(item => item.kind === "tool" && item.toolOpId === question.hostOpId && !!item.entryId)) : [];
  const { timeline, activeKey, phase } = conversationActivity(model.view, sessionId, model.status.state === "online", items);
  const diffTools: DiffTool[] = [];
  const references = new Map<string, { count: number; key: string }>();
  let referencesKey = "";
  for (const item of items) {
    if (item.kind === "tool" && isDiffTool(item) && model.target === "code") {
      diffTools.push(item);
      referencesKey += JSON.stringify([item.key, item.entryId, item.name, item.target]);
    } else if (item.kind === "message") references.set(item.key, { count: diffTools.length, key: referencesKey });
  }
  const taskId = model.view.activeTaskFor(sessionId)?.id;
  const branchable = !child && !model.view.roleSessionIds.includes(sessionId) && !model.view.subAgentSessionIds.includes(sessionId) && !model.view.sessions.find(item => item.id === sessionId)?.codeScheduleRunId;
  const sections = conversationSections(model.view, items, timeline, phase && !activeKey && taskId ? { taskId, phase } : undefined, id => model.historyReady(sessionId, id));
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const onExpand = (key: string, open: boolean) => setExpanded(items => ({ ...items, [key]: open }));
  const older = async () => {
    if (!session.historyCursor || loadingOlder.current) return;
    loadingOlder.current = true;
    try { await model.loadHistory(sessionId, "prepend"); }
    finally { loadingOlder.current = false; }
  };
  return <MessageScrollerProvider autoScroll defaultScrollPosition="start"><MessageScroller className={child ? "conversation subagent-conversation" : "conversation"}><MessageScrollerViewport ref={scroll} className={child ? "child-scroll selectable-text" : "stream-scroll selectable-text"} preserveScrollOnPrepend aria-label={child ? "子 Agent 消息" : "会话消息"} onScroll={() => {
    const container = scroll.current!;
    if (container.scrollTop < 40) void older();
  }}><MessageScrollerContent className={`${child ? "subagent-stream" : "agent-stream"} native-message-stream selectable-text`}>
    {sections.map(section => {
      const contents = section.groups.map(group => {
        const entry = group[0];
        return <Fragment key={entry.key}>{entry.kind === "message" ? <MessageEntry model={model} sessionId={sessionId} entry={entry} child={child} branchable={branchable} tools={diffTools} toolCount={references.get(entry.key)!.count} referencesKey={references.get(entry.key)!.key} /> : entry.kind === "tool" || entry.kind === "thinking" ? entry.kind === "tool" && isAgentTool(entry) && entry.status !== "error" && entry.status !== "effect_unknown" && entry.key !== activeKey ? <AgentActivity model={model} tool={entry} /> : <ToolActivity model={model} sessionId={sessionId} tools={group.filter((item): item is DiffTool => item.kind === "tool")} thinking={group.find((item): item is Extract<FlowEntry, { kind: "thinking" }> => item.kind === "thinking")} phase={entry.key === activeKey ? phase : undefined} expanded={expanded} onExpand={onExpand} /> : entry.kind === "task" && entry.task.errorMessage ? <p className="text-muted-foreground" role="alert">{entry.task.errorMessage}</p> : null}{positionedQuestions.filter(question => group.some(item => item.kind === "tool" && item.toolOpId === question.hostOpId)).map(question => <OwnerQuestionCard key={question.id} model={model} question={question} />)}</Fragment>;
      });
      const hasTrace = section.tailPhase || section.groups.some(group => group[0].kind === "tool" || group[0].kind === "thinking");
      const failed = section.groups.some(group => group.some(item => item.kind === "tool" && (item.status === "error" || model.inspector.toolResult(sessionId, item)?.value?.isError === true)));
      return <MessageScrollerItem key={section.key} messageId={section.key} className={hasTrace ? "trace-step" : undefined}>{hasTrace ? <ExecutionTrace stateKey={`${sessionId}:${section.key}`} completed={section.completed} failed={failed} duration={executionDuration(model.view.tasks.get(section.taskId ?? "")?.startedAt, model.view.tasks.get(section.taskId ?? "")?.endedAt)} expanded={expanded} onExpand={onExpand}>{contents}{section.tailPhase && <ToolActivity model={model} sessionId={sessionId} tools={[]} phase={section.tailPhase} expanded={expanded} onExpand={onExpand} />}</ExecutionTrace> : contents}</MessageScrollerItem>;
    })}
    <ApprovalCards model={model} sessionId={sessionId} />
    {!child && <OwnerQuestionCards model={model} sessionId={sessionId} positioned={positionedQuestions.map(question => question.id)} />}
  </MessageScrollerContent></MessageScrollerViewport>{items.length === 0 && !child && !session.historyLoaded && <div className="new-session-empty pointer-events-none absolute inset-x-6 top-3" role="status">正在加载会话…</div>}</MessageScroller></MessageScrollerProvider>;
}
