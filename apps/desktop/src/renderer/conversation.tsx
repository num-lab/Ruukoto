// Note: 见 .agents/notes/implemented/bug-fix/2026-10-17-desktop-transcript-rendering.md
import { Fragment, useMemo, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { FlowEntry } from "@ruukoto/view/event-flow.ts";
import type { CodeState } from "./code-state.ts";
import { isDiffTool, type DiffTool } from "./diff.ts";
import { conversationActivity, isAgentTool } from "./activity.ts";
import { AgentActivity, ToolActivity } from "./tool-activity.tsx";
import { ApprovalCards } from "./approval-cards.tsx";
import { Bubble, BubbleContent } from "./components/ui/bubble.tsx";
import { Message, MessageContent } from "./components/ui/message.tsx";
import { MessageScroller, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from "./components/ui/message-scroller.tsx";

function MessageEntry({ model, sessionId, entry, child, tools, toolCount, referencesKey }: { model: CodeState; sessionId: string; entry: Extract<FlowEntry, { kind: "message" }>; child: boolean; tools: DiffTool[]; toolCount: number; referencesKey: string }) {
  const text = child && entry.role === "user" && entry.taskId ? model.view.tasks.get(entry.taskId)?.displayInput ?? entry.text : entry.text;
  const markdown = useMemo(() => {
    const components: Components = {
      img: ({ alt }) => <span className="text-muted-foreground">[图片{alt ? `：${alt}` : ""}]</span>,
      code: ({ className, children }) => {
        const path = String(children);
        let diff: DiffTool | undefined;
        if (model.target === "code" && !className) for (let index = toolCount - 1; index >= 0; index--) if (tools[index].target === path) { diff = tools[index]; break; }
        const code = <code className={className ?? "relative rounded bg-muted px-[0.3rem] py-[0.1rem] font-mono text-[13px] font-normal wrap-anywhere"}>{diff ? path.split("/").map((segment, index) => <Fragment key={index}>{index > 0 && "/"}{index > 0 && <wbr />}{segment}</Fragment>) : children}</code>;
        return diff ? <a className="file-reference" href="#right-sidebar" onClick={event => { event.preventDefault(); const current = model.view.openSession(sessionId).flow.items.find(item => item.key === diff.key); if (current?.kind === "tool") model.inspector.openDiff(sessionId, current); }}>{code}</a> : code;
      },
    };
    return <div className="markdown"><Markdown skipHtml remarkPlugins={[remarkGfm]} components={components}>{text}</Markdown></div>;
  }, [text, model, sessionId, referencesKey]);
  const content = <>{markdown}{entry.attachments?.map(attachment => <div key={attachment.id}>［附件：{attachment.name}］</div>)}</>;
  return <Message align={entry.role === "user" ? "end" : "start"}><MessageContent>{entry.role === "user" ? <Bubble variant="muted" align="end"><BubbleContent>{content}</BubbleContent></Bubble> : content}</MessageContent></Message>;
}
// Note: 见 .agents/notes/implemented/architecture/2026-10-16-desktop-trace-migration.md
export function Conversation({ model, sessionId, child = false }: { model: CodeState; sessionId: string; child?: boolean }) {
  const scroll = useRef<HTMLDivElement>(null);
  const loadingOlder = useRef(false);
  const session = model.view.openSession(sessionId);
  const items = session.flow.items;
  const { groups, phase, tools, thinking } = conversationActivity(model.view, sessionId, model.status.state === "online", items);
  const diffTools: DiffTool[] = [];
  const references = new Map<string, { count: number; key: string }>();
  let referencesKey = "";
  for (const item of items) {
    if (item.kind === "tool" && isDiffTool(item) && model.target === "code") {
      diffTools.push(item);
      referencesKey += JSON.stringify([item.key, item.entryId, item.name, item.target]);
    } else if (item.kind === "message") references.set(item.key, { count: diffTools.length, key: referencesKey });
  }
  const executionKey = `${sessionId}:${model.view.activeTaskFor(sessionId)?.id}:execution`;
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
    {groups.map(group => {
      const entry = group[0];
      const content = entry.kind === "message" ? <MessageEntry model={model} sessionId={sessionId} entry={entry} child={child} tools={diffTools} toolCount={references.get(entry.key)!.count} referencesKey={references.get(entry.key)!.key} />  : entry.kind === "tool" || entry.kind === "thinking" ? entry.kind === "tool" && isAgentTool(entry) && entry.status !== "error" && entry.status !== "effect_unknown" ? <AgentActivity model={model} tool={entry} /> : <ToolActivity model={model} sessionId={sessionId} tools={group.filter((item): item is DiffTool => item.kind === "tool")} thinking={group.find((item): item is Extract<FlowEntry, { kind: "thinking" }> => item.kind === "thinking")} stateKey={entry.key} expanded={expanded} onExpand={onExpand} /> : entry.kind === "task" && entry.task.errorMessage ? <p className="text-muted-foreground" role="alert">{entry.task.errorMessage}</p> : null;
      return content && <MessageScrollerItem key={entry.key} messageId={entry.key} className={entry.kind === "tool" || entry.kind === "thinking" ? "trace-step" : undefined}>{content}</MessageScrollerItem>;
    })}
    <ApprovalCards model={model} sessionId={sessionId} />
    {phase && <MessageScrollerItem key={executionKey} messageId={executionKey} className="trace-step"><ToolActivity model={model} sessionId={sessionId} tools={tools} thinking={thinking} phase={phase} stateKey={executionKey} expanded={expanded} onExpand={onExpand} /></MessageScrollerItem>}
  </MessageScrollerContent></MessageScrollerViewport>{items.length === 0 && !child && !session.historyLoaded && <div className="new-session-empty pointer-events-none absolute inset-x-6 top-3" role="status">正在加载会话…</div>}</MessageScroller></MessageScrollerProvider>;
}
