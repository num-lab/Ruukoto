import { useEffect } from "react";
import type { FlowEntry } from "@ruukoto/view/event-flow.ts";
import { CircleAlert, CircleCheck, LoaderCircle, Sparkles, Wrench } from "lucide-react";
import type { CodeState } from "./code-state.ts";
import { subAgentStateLabel } from "@ruukoto/view/state.ts";
import { activitySummary, isAgentTool } from "./activity.ts";
import { isDiffTool, parsePatch, type DiffTool } from "./diff.ts";
import { Button } from "./components/ui/button.tsx";
import { CodeBlock, CodeBlockContent, CodeBlockLine } from "./components/ui/code-block.tsx";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "./components/ui/trace.tsx";

type Expansion = { expanded: Record<string, boolean>; onExpand: (key: string, open: boolean) => void };
type Props = Expansion & { model: CodeState; sessionId: string; tools: DiffTool[]; thinking?: Extract<FlowEntry, { kind: "thinking" }>; stateKey: string; phase?: "thinking" | "working" | null };

function ToolRow({ model, sessionId, tool, expanded, onExpand }: Expansion & { model: CodeState; sessionId: string; tool: DiffTool }) {
  const inspector = model.inspector;
  const key = `${sessionId}:${tool.taskId ?? "history"}:tool:${tool.toolOpId ?? tool.toolCallId ?? tool.entryId ?? tool.key}`;
  const open = expanded[key] ?? false;
  const result = inspector.toolResult(sessionId, tool);
  const parameter = inspector.toolParams(sessionId, tool);
  const name = tool.name.toLowerCase();
  const read = name === "read", command = name === "bash";
  const unknown = tool.status === "effect_unknown";
  const failed = !unknown && (tool.status === "error" || result?.value?.isError === true);
  const task = model.view.tasks.get(tool.taskId ?? "");
  const running = tool.status === "running" && task?.status === "running" && !task.cancelRequested && model.status.state === "online" && model.view.openSession(sessionId).queueState !== "paused" && !model.view.pendingApprovals().some(approval => approval.taskId === task.id);
  const params = tool.paramsTruncated ? parameter?.value : tool.params;
  const target = command && typeof params?.command === "string" ? params.command : tool.target;
  const verb = read ? "read" : name === "edit" ? "edit" : name === "write" ? "write" : command ? "run" : name;
  const label = failed ? `Failed to ${verb}` : unknown ? "效果未知" : tool.status === "running" && !running ? "等待结果" : running ? read ? "Reading" : name === "edit" ? "Editing" : name === "write" ? "Writing" : command ? "Running" : `${tool.name} in progress` : read ? "Read" : name === "edit" ? "Edited" : name === "write" ? "Wrote" : command ? "Ran" : tool.name;
  useEffect(() => { if (open || (read && (failed || unknown))) void inspector.loadTool(sessionId, tool); }, [inspector, sessionId, tool, tool.entryId, tool.status, open, read, failed, unknown, result]);
  useEffect(() => { if (open && tool.paramsTruncated && !parameter) void inspector.loadToolParams(sessionId, tool); }, [inspector, sessionId, tool, tool.paramsTruncated, tool.toolOpId, open, parameter]);
  const line = <TraceLine status={failed ? "error" : running ? "running" : undefined}><TraceIcon>{failed || unknown || (tool.status === "running" && !running) ? <CircleAlert /> : running ? <LoaderCircle className="animate-spin" /> : <CircleCheck />}</TraceIcon><TraceTitle>{label} {read && model.target === "code" ? <a href="#right-sidebar" aria-label={`打开文件 ${tool.target}`} onClick={event => { event.preventDefault(); void inspector.openToolFile(sessionId, tool).then(opened => { if (opened === false) { model.message = "此调用没有可用的工作区预览或唯一 Read 捕获快照。"; model.refresh(); } }); }}><code>{tool.target}</code></a> : <code>{target}</code>}</TraceTitle>{!failed && !unknown && tool.status === "done" && tool.editStats && <TraceDescription><span className="text-[var(--diff-add-text)]">+{tool.editStats.added}</span> <span className="text-[var(--diff-del-text)]">−{tool.editStats.removed}</span></TraceDescription>}</TraceLine>;
  const error = result?.value?.text ?? tool.summary ?? "失败，详情不可用";
  const patch = result?.value?.patch;
  const detail = result?.error ? <p role="alert">{result.error}<Button size="sm" variant="ghost" onClick={() => void inspector.loadTool(sessionId, tool, true)}>重试</Button></p>
    : failed || unknown ? <CodeBlock size="sm" variant={failed ? "destructive" : "default"}><CodeBlockContent wrap className="max-h-64 data-wrap:wrap-anywhere">{command ? `${typeof params?.command === "string" ? `$ ${params.command}` : "完整命令尚未读取"}\n${error}` : error}</CodeBlockContent></CodeBlock>
    : isDiffTool(tool) ? result?.value && result.value.isError !== false ? <p>此调用未记录可核实的成功结果</p> : typeof patch === "string" ? <CodeBlock size="sm"><CodeBlockContent wrap className="max-h-64 data-wrap:wrap-anywhere">{patch === "" ? "无内容差异" : parsePatch(patch).filter(line => line.kind !== "header").map((line, index) => <CodeBlockLine key={index} variant={line.kind === "added" ? "added" : line.kind === "removed" ? "removed" : "default"}>{["added", "removed", "context"].includes(line.kind) ? line.text.slice(1) : line.text}</CodeBlockLine>)}</CodeBlockContent></CodeBlock> : <p>{tool.status === "running" ? "运行中" : !tool.entryId ? "等待结果落盘" : !result?.value ? "正在读取结果…" : "此调用未记录 diff"}</p>
    : <><CodeBlock size="sm"><CodeBlockContent wrap className="max-h-64 data-wrap:wrap-anywhere">{[command ? typeof params?.command === "string" ? `$ ${params.command}` : tool.paramsTruncated ? "正在读取完整命令…" : "此调用未记录完整命令" : undefined, result?.value?.text ?? (tool.status === "running" ? undefined : tool.entryId ? "正在读取结果…" : "等待结果落盘")].filter(value => value !== undefined).join("\n")}</CodeBlockContent></CodeBlock></>;
  const contents = <>{detail}{command && parameter?.error && <p role="alert">{parameter.error}<Button size="sm" variant="ghost" onClick={() => void inspector.loadToolParams(sessionId, tool, true)}>重试</Button></p>}{command && tool.paramsTruncated && !tool.toolOpId && <p>此调用未记录完整参数的读取身份。</p>}{result?.moreError && <p role="alert">{result.moreError}</p>}{result?.value?.truncated && <Button className="diff-more" size="sm" variant="ghost" disabled={result.loading} onClick={() => void inspector.moreTool(sessionId, tool)}>more</Button>}</>;
  if (read) return <div className="flex min-w-0 flex-col gap-2">{line}{(failed || unknown) && <div className="ml-6 min-w-0">{contents}</div>}</div>;
  return <TraceCollapsible open={open} onOpenChange={value => onExpand(key, value)}><TraceCollapsibleTrigger aria-label={`${label} ${target}`}>{line}</TraceCollapsibleTrigger><TraceCollapsibleContent inert={!open} aria-hidden={!open}>{contents}</TraceCollapsibleContent></TraceCollapsible>;
}

export function AgentActivity({ model, tool }: { model: CodeState; tool: DiffTool }) {
  const agent = model.inspector.agentForTool(tool);
  return <Trace><button disabled={!agent} onClick={() => agent && model.inspector.selectChild(agent.sessionId)}><TraceLine><TraceIcon><Sparkles /></TraceIcon><TraceTitle className="shrink-0">{agent?.definition?.name ?? (typeof tool.params.role === "string" ? tool.params.role : "SubAgent")}</TraceTitle>{agent && <TraceDescription className="min-w-0 shrink truncate">{subAgentStateLabel(agent)}</TraceDescription>}</TraceLine></button></Trace>;
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-16-desktop-trace-migration.md
export function ToolActivity({ model, sessionId, tools, thinking, stateKey, phase, expanded, onExpand }: Props) {
  const text = thinking?.text.trim() ? <p className="reasoning-content whitespace-pre-wrap wrap-anywhere selectable-text">{thinking.text}</p> : null;
  if (phase === "thinking") return <Trace><TraceLine status="running" className="text-foreground"><TraceIcon><LoaderCircle className="animate-spin" /></TraceIcon><TraceTitle role="status">Thinking</TraceTitle></TraceLine>{text && <div className="ml-6 text-muted-foreground">{text}</div>}</Trace>;
  const thoughtKey = `${thinking?.key}:reasoning`, thoughtOpen = expanded[thoughtKey] ?? false;
  const thought = text && thinking && <TraceCollapsible open={thoughtOpen} onOpenChange={value => onExpand(thoughtKey, value)}><TraceCollapsibleTrigger><TraceLine><TraceIcon><CircleCheck /></TraceIcon><TraceTitle>{thinking.endedAt ? `Thought for ${Number(((Date.parse(thinking.endedAt) - Date.parse(thinking.startedAt)) / 1000).toFixed(1))}s` : "Thought"}</TraceTitle></TraceLine></TraceCollapsibleTrigger><TraceCollapsibleContent inert={!thoughtOpen} aria-hidden={!thoughtOpen}>{text}</TraceCollapsibleContent></TraceCollapsible>;
  if (!tools.length && phase !== "working") return <Trace>{thought}</Trace>;
  const working = phase === "working";
  const open = expanded[stateKey] ?? working;
  const failures = tools.filter(tool => tool.status !== "effect_unknown" && (tool.status === "error" || model.inspector.toolResult(sessionId, tool)?.value?.isError === true)).length;
  return <Trace><TraceCollapsible open={open} onOpenChange={value => onExpand(stateKey, value)}><TraceCollapsibleTrigger aria-label={working ? `Working${failures ? ` · ${failures} failed` : ""}` : undefined}><TraceLine status={failures ? "error" : working ? "running" : undefined} className={working ? "text-foreground" : undefined}><TraceIcon>{working ? <LoaderCircle className="animate-spin" /> : <Wrench />}</TraceIcon><TraceTitle role={working ? "status" : undefined}>{working ? "Working" : `${failures ? `${failures} failed · ` : ""}${activitySummary(tools)}`}</TraceTitle>{working && failures > 0 && <TraceDescription>· {failures} failed</TraceDescription>}</TraceLine></TraceCollapsibleTrigger><TraceCollapsibleContent inert={!open} aria-hidden={!open}><Trace>{thought}{tools.map(tool => isAgentTool(tool) && tool.status !== "error" && tool.status !== "effect_unknown" ? <AgentActivity key={tool.key} model={model} tool={tool} /> : <ToolRow key={tool.toolCallId ?? tool.key} model={model} sessionId={sessionId} tool={tool} expanded={expanded} onExpand={onExpand} />)}</Trace></TraceCollapsibleContent></TraceCollapsible></Trace>;
}
