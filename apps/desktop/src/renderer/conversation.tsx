import { useEffect, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { FlowEntry } from "@ruukoto/view/event-flow.ts";
import { formatTaskStatus } from "@ruukoto/view/state.ts";
import type { CodeState } from "./code-state.ts";
import { isDiffTool } from "./diff.ts";

// Note: 见 .agents/notes/proposed/architecture/2026-10-15-desktop-client.md
// file 页面中的相对图片也能指向工作区；图片仅显示说明，避免绕过控制面读取本机文件。
const markdownComponents: Components = { img: ({ alt }) => <span className="muted">[图片{alt ? `：${alt}` : ""}]</span> };

function Thinking({ entry }: { entry: Extract<FlowEntry, { kind: "thinking" }> }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (entry.endedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [entry.endedAt]);
  const seconds = Math.max(0, Math.round(((entry.endedAt ? Date.parse(entry.endedAt) : now) - Date.parse(entry.startedAt)) / 1000));
  return <details className="thinking"><summary>{entry.endedAt ? "思考" : "正在思考"} · {seconds} 秒</summary><div className="markdown"><Markdown skipHtml remarkPlugins={[remarkGfm]} components={markdownComponents}>{entry.text}</Markdown></div></details>;
}
function Message({ entry }: { entry: Extract<FlowEntry, { kind: "message" }> }) {
  return <article className={`message message-${entry.role}`}><div className="message-role">{entry.role === "user" ? "你" : "Ruukoto"}{entry.streaming && <span> · 正在输出</span>}</div><div className="markdown"><Markdown skipHtml remarkPlugins={[remarkGfm]} components={markdownComponents}>{entry.text}</Markdown></div>{entry.truncated && <p className="muted">正文尚未完整加载</p>}</article>;
}
export function Conversation({ model, sessionId }: { model: CodeState; sessionId: string }) {
  const scroll = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const items = model.view.openSession(sessionId).flow.items;
  const groups: FlowEntry[][] = [];
  for (const item of items) {
    if (item.kind === "tool" && groups.at(-1)?.at(-1)?.kind === "tool") groups.at(-1)!.push(item);
    else groups.push([item]);
  }
  useEffect(() => {
    const container = scroll.current;
    if (container && following.current) container.scrollTop = container.scrollHeight;
  });
  const older = async () => {
    const container = scroll.current;
    if (!container) return;
    following.current = false;
    const height = container.scrollHeight;
    const top = container.scrollTop;
    await model.loadHistory(sessionId, "prepend");
    requestAnimationFrame(() => { if (scroll.current === container) container.scrollTop = top + container.scrollHeight - height; });
  };
  return <div ref={scroll} className="conversation" onScroll={() => {
    const container = scroll.current!;
    following.current = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
  }}><div className="conversation-content">
    {model.view.openSession(sessionId).historyCursor && <button className="load-older" onClick={() => void older()}>加载更早的记录</button>}
    {groups.map(group => {
      const entry = group[0];
      if (entry.kind === "message") return <Message key={entry.key} entry={entry} />;
      if (entry.kind === "thinking") return <Thinking key={entry.key} entry={entry} />;
      if (entry.kind === "tool") return <details className="tool-group" key={entry.key}><summary>工具活动 · {group.length} 项{group.some(item => item.kind === "tool" && item.status === "running") ? " · 执行中" : ""}</summary>{group.map(item => item.kind === "tool" && <div className="tool-row" key={item.key}><div>{isDiffTool(item) ? <button className="diff-link" onClick={() => model.inspector.openDiff(sessionId, item)}>{item.name} · 查看差异</button> : <strong>{item.name}</strong>}<span className={`tool-status ${item.status}`}>{{ running: "执行中", done: "已完成", error: "失败", effect_unknown: "效果未知" }[item.status]}</span></div><pre>{item.target}</pre>{item.summary && <pre>{item.summary}</pre>}</div>)}</details>;
      if (entry.kind === "task") return <p className="task-status" key={entry.key}>{formatTaskStatus(entry.task.status)}{entry.task.errorMessage && ` · ${entry.task.errorMessage}`}</p>;
      if (entry.kind === "note") return <p className="flow-note" key={entry.key}>{entry.text}</p>;
      return null;
    })}
    {items.length === 0 && <p className="conversation-empty muted">{model.view.openSession(sessionId).historyLoaded ? "还没有对话记录。" : "正在加载会话…"}</p>}
  </div></div>;
}
