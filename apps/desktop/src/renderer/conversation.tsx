import { Fragment, useRef, useState } from "react";
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

function MessageEntry({ model, sessionId, entry, child }: { model: CodeState; sessionId: string; entry: Extract<FlowEntry, { kind: "message" }>; child: boolean }) {
  const items = model.view.openSession(sessionId).flow.items;
  const tools = items.slice(0, items.findIndex(item => item.key === entry.key) + 1).filter((item): item is DiffTool => item.kind === "tool");
  const components: Components = {
    img: ({ alt }) => <span className="text-muted-foreground">[图片{alt ? `：${alt}` : ""}]</span>,
    code: ({ className, children }) => {
      const path = String(children);
      const diff = !className ? tools.findLast(tool => isDiffTool(tool) && tool.target === path) : undefined;
      const code = <code className={className ?? "relative rounded bg-muted px-[0.3rem] py-[0.1rem] font-mono text-[13px] font-normal wrap-anywhere"}>{diff ? path.split("/").map((segment, index) => <Fragment key={index}>{index > 0 && "/"}{index > 0 && <wbr />}{segment}</Fragment>) : children}</code>;
      return diff ? <a className="file-reference" href="#right-sidebar" onClick={event => { event.preventDefault(); model.inspector.openDiff(sessionId, diff); }}>{code}</a> : code;
    },
  };
  const text = child && entry.role === "user" && entry.taskId ? model.view.tasks.get(entry.taskId)?.displayInput ?? entry.text : entry.text;
  const content = <><div className="markdown"><Markdown skipHtml remarkPlugins={[remarkGfm]} components={components}>{text}</Markdown></div>{entry.attachments?.map(attachment => <div key={attachment.id}>［附件：{attachment.name}］</div>)}</>;
  return <Message align={entry.role === "user" ? "end" : "start"}><MessageContent>{entry.role === "user" ? <Bubble variant="muted" align="end"><BubbleContent>{content}</BubbleContent></Bubble> : content}</MessageContent></Message>;
}
// Note: 见 .agents/notes/implemented/architecture/2026-10-16-desktop-trace-migration.md
export function Conversation({ model, sessionId, child = false }: { model: CodeState; sessionId: string; child?: boolean }) {
  const scroll = useRef<HTMLDivElement>(null);
  const loadingOlder = useRef(false);
  const session = model.view.openSession(sessionId);
  const { groups, phase, tools } = conversationActivity(model.view, sessionId, model.status.state === "online");
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
      const content = entry.kind === "message" ? <MessageEntry model={model} sessionId={sessionId} entry={entry} child={child} />  : entry.kind === "tool" ? isAgentTool(entry) && entry.status !== "error" && entry.status !== "effect_unknown" ? <AgentActivity model={model} tool={entry} /> : <ToolActivity model={model} sessionId={sessionId} tools={group.filter((item): item is DiffTool => item.kind === "tool")} stateKey={entry.key} expanded={expanded} onExpand={onExpand} /> : entry.kind === "task" && entry.task.errorMessage ? <p className="text-muted-foreground" role="alert">{entry.task.errorMessage}</p> : null;
      return content && <MessageScrollerItem key={entry.key} messageId={entry.key} className={entry.kind === "tool" || entry.kind === "thinking" ? "trace-step" : undefined}>{content}</MessageScrollerItem>;
    })}
    <ApprovalCards model={model} sessionId={sessionId} />
    {phase && <MessageScrollerItem key={executionKey} messageId={executionKey} className="trace-step"><ToolActivity model={model} sessionId={sessionId} tools={tools} phase={phase} stateKey={executionKey} expanded={expanded} onExpand={onExpand} /></MessageScrollerItem>}
  </MessageScrollerContent></MessageScrollerViewport>{session.flow.items.length === 0 && !child && <div className="new-session-empty pointer-events-none absolute inset-x-6 top-3"><h1>{session.historyLoaded ? "开始一个新的会话" : "正在加载会话…"}</h1>{session.historyLoaded && <p>在下方描述你想完成的事。</p>}</div>}</MessageScroller></MessageScrollerProvider>;
}
