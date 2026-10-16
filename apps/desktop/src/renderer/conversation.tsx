import { Fragment, useEffect, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Brain, Sparkles, Wrench } from "lucide-react";
import type { FlowEntry } from "@ruukoto/view/event-flow.ts";
import { subAgentStateLabel } from "@ruukoto/view/state.ts";
import type { CodeState } from "./code-state.ts";
import { isDiffTool, type DiffTool } from "./diff.ts";
import { activityGroups, activitySummary, isAgentTool, toolLabel } from "./activity.ts";
import { ApprovalCards } from "./approval-cards.tsx";
import { Bubble, BubbleContent } from "./components/ui/bubble.tsx";
import { Message, MessageContent } from "./components/ui/message.tsx";
import { MessageScroller, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from "./components/ui/message-scroller.tsx";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "./components/ui/trace.tsx";

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
export function Thinking({ entry }: { entry: Extract<FlowEntry, { kind: "thinking" }> }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { if (entry.endedAt) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, [entry.endedAt]);
  const seconds = Math.max(0, Math.round(((entry.endedAt ? Date.parse(entry.endedAt) : now) - Date.parse(entry.startedAt)) / 1000));
  if (!entry.text.trim()) return null;
  return <Trace><TraceCollapsible><TraceCollapsibleTrigger><TraceLine><TraceIcon><Brain /></TraceIcon><TraceTitle>Thought for {seconds}s</TraceTitle></TraceLine></TraceCollapsibleTrigger><TraceCollapsibleContent><p className="whitespace-pre-wrap text-pretty text-sm selectable-text">{entry.text}</p></TraceCollapsibleContent></TraceCollapsible></Trace>;
}
function ToolGroup({ model, sessionId, tools }: { model: CodeState; sessionId: string; tools: DiffTool[] }) {
  return <Trace><TraceCollapsible><TraceCollapsibleTrigger><TraceLine><TraceIcon><Wrench /></TraceIcon><TraceTitle>{activitySummary(tools)}</TraceTitle></TraceLine></TraceCollapsibleTrigger><TraceCollapsibleContent className="flex flex-col gap-2">{tools.map(tool => <button key={tool.key} className="min-w-0 text-left" disabled={!isDiffTool(tool)} onClick={() => model.inspector.openDiff(sessionId, tool)}><TraceLine><TraceDescription>{toolLabel(tool.name)}</TraceDescription><TraceTitle><code>{tool.target}</code></TraceTitle>{tool.editStats ? <TraceDescription><span className="text-emerald-600 dark:text-emerald-400">+{tool.editStats.added}</span> <span className="text-red-600 dark:text-red-400">−{tool.editStats.removed}</span></TraceDescription> : tool.name.toLowerCase() !== "read" && <TraceDescription>{tool.summary}</TraceDescription>}</TraceLine></button>)}</TraceCollapsibleContent></TraceCollapsible></Trace>;
}
function AgentActivity({ model, tool }: { model: CodeState; tool: DiffTool }) {
  const agent = model.inspector.agentForTool(tool);
  return <Trace><button disabled={!agent} onClick={() => agent && model.inspector.selectChild(agent.sessionId)}><TraceLine><TraceIcon><Sparkles /></TraceIcon><TraceTitle className="shrink-0">{agent?.definition?.name ?? (typeof tool.params.role === "string" ? tool.params.role : "SubAgent")}</TraceTitle>{agent && <TraceDescription className="min-w-0 shrink truncate">{subAgentStateLabel(agent)}</TraceDescription>}</TraceLine></button></Trace>;
}
// Note: 见 .agents/notes/implemented/architecture/2026-10-16-desktop-current-demo.md
export function Conversation({ model, sessionId, child = false }: { model: CodeState; sessionId: string; child?: boolean }) {
  const scroll = useRef<HTMLDivElement>(null);
  const following = useRef(false);
  const initialized = useRef(false);
  const loadingOlder = useRef(false);
  const session = model.view.openSession(sessionId);
  const groups = activityGroups(session.flow.items.filter(item => {
    if (item.kind === "thinking") return !!item.text.trim();
    if (item.kind === "message") return !!item.text.trim() || !!item.attachments?.length;
    return true;
  }));
  // 远端历史补页自行维持锚点，关闭原语的自动跟随以避免两个滚动控制者。
  useEffect(() => {
    const container = scroll.current;
    if (!container || loadingOlder.current) return;
    if (!initialized.current && session.historyLoaded) { container.scrollTop = 0; initialized.current = true; following.current = container.scrollHeight <= container.clientHeight; }
    else if (following.current) container.scrollTop = container.scrollHeight;
  });
  const older = async () => {
    const container = scroll.current;
    if (!container || !session.historyCursor || loadingOlder.current) return;
    loadingOlder.current = true; following.current = false;
    const height = container.scrollHeight, top = container.scrollTop;
    await model.loadHistory(sessionId, "prepend");
    requestAnimationFrame(() => { if (scroll.current === container) container.scrollTop = top + container.scrollHeight - height; loadingOlder.current = false; });
  };
  return <MessageScrollerProvider autoScroll={false} defaultScrollPosition="start"><MessageScroller className={child ? "conversation subagent-conversation" : "conversation"}><MessageScrollerViewport ref={scroll} className={child ? "child-scroll selectable-text" : "stream-scroll selectable-text"} preserveScrollOnPrepend={false} aria-label={child ? "子 Agent 消息" : "会话消息"} onScroll={() => {
    const container = scroll.current!;
    following.current = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
    if (container.scrollTop < 40) void older();
  }}><MessageScrollerContent className={`${child ? "subagent-stream" : "agent-stream"} native-message-stream selectable-text`}>
    {groups.map(group => {
      const entry = group[0];
      const content = entry.kind === "message" ? <MessageEntry model={model} sessionId={sessionId} entry={entry} child={child} /> : entry.kind === "thinking" ? <Thinking entry={entry} /> : entry.kind === "tool" ? isAgentTool(entry) ? <AgentActivity model={model} tool={entry} /> : <ToolGroup model={model} sessionId={sessionId} tools={group.filter((item): item is DiffTool => item.kind === "tool")} /> : entry.kind === "task" && entry.task.errorMessage ? <p className="text-muted-foreground" role="alert">{entry.task.errorMessage}</p> : null;
      return content && <MessageScrollerItem key={entry.key} messageId={entry.key} className={entry.kind === "tool" || entry.kind === "thinking" ? "trace-step" : undefined}>{content}</MessageScrollerItem>;
    })}
    <ApprovalCards model={model} sessionId={sessionId} />
    {session.flow.items.length === 0 && !child && <div className="new-session-empty"><h1>{session.historyLoaded ? "开始一个新的会话" : "正在加载会话…"}</h1>{session.historyLoaded && <p>在下方描述你想完成的事。</p>}</div>}
  </MessageScrollerContent></MessageScrollerViewport></MessageScroller></MessageScrollerProvider>;
}
