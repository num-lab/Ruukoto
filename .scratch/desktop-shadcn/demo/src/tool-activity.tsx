import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Bot, Brain, CircleAlert, FilePenLine, FilePlus2, FileText, ListChecks, LoaderCircle, Search, Terminal, Wrench } from "lucide-react";
import { CodeBlock, CodeBlockContent, CodeBlockLine } from "./components/ui/code-block.tsx";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "./components/ui/trace.tsx";
import { type ActivityItem, type Diff, type Step } from "./demo-data.ts";

type Activity = Extract<Step, { type: "activity" }>;
type Props = { step: Activity; diffs: Diff[]; stateKey: string; expanded: Record<string, boolean>; onExpand: (key: string, open: boolean) => void; onOpenFile: (path: string) => void; onOpenAgent: (name: string) => void };

// Note: 见 .agents/notes/implemented/feature/2026-10-16-demo-trace-tools.md
export function ToolActivity({ step, diffs, stateKey, expanded, onExpand, onOpenFile, onOpenAgent }: Props) {
  const textRef = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => { if (step.phase === "thinking" && textRef.current) textRef.current.scrollTop = textRef.current.scrollHeight; }, [step.phase, step.thinking?.text]);
  const text = step.thinking?.text.trim() ? <p ref={textRef} className="reasoning-content whitespace-pre-wrap wrap-anywhere selectable-text" tabIndex={0} role="region" aria-label="思考内容">{step.thinking.text}</p> : null;
  const thoughtKey = `${stateKey}:reasoning`, thoughtOpen = expanded[thoughtKey] ?? false;
  const thought = text && <TraceCollapsible open={thoughtOpen} onOpenChange={value => onExpand(thoughtKey, value)}><TraceCollapsibleTrigger><TraceLine><TraceIcon><Brain /></TraceIcon><TraceTitle>Thought for {step.thinking!.duration}</TraceTitle></TraceLine></TraceCollapsibleTrigger><TraceCollapsibleContent inert={!thoughtOpen} aria-hidden={!thoughtOpen}>{text}</TraceCollapsibleContent></TraceCollapsible>;
  if (step.phase === "thinking") return <Trace><TraceLine status="running" className="text-foreground"><TraceIcon><LoaderCircle className="animate-spin" /></TraceIcon><TraceTitle role="status">Thinking</TraceTitle></TraceLine>{text && <div className="ml-6 text-muted-foreground">{text}</div>}</Trace>;
  function renderTool(item: ActivityItem, index: number) {
    const key = `${stateKey}:tool:${index}`;
    const detailOpen = expanded[key] ?? false;
    const failed = item.error !== undefined;
    const running = item.status === "running" && !failed;
    const read = item.action === "Read";
    const edit = item.action === "Edit" || item.action === "Edited";
    const write = item.action === "Write";
    const command = item.command ?? (["Bash", "Run"].includes(item.action) ? item.file : undefined);
    const diff = item.diff ?? (running ? undefined : diffs.find(diff => diff.fullPath === (item.diffFile ?? item.file)));
    const Icon = read ? FileText : edit ? FilePenLine : write ? FilePlus2 : command ? Terminal : item.action === "Grep" ? Search : Wrench;
    const verb = read ? "read" : edit ? "edit" : write ? "write" : command ? "run" : item.action.toLowerCase();
    const label = failed ? `Failed to ${verb}` : running ? read ? "Reading" : edit ? "Editing" : write ? "Writing" : command ? "Running" : `${item.action} in progress` : read ? "Read" : edit ? "Edited" : write ? "Wrote" : command ? "Ran" : item.action;
    const line = <TraceLine status={failed ? "error" : running ? "running" : undefined}><TraceIcon>{failed ? <CircleAlert /> : running ? <LoaderCircle className="animate-spin" /> : <Icon />}</TraceIcon>{read ? <TraceTitle>{label} <a href="#right-sidebar" aria-label={`打开文件 ${item.file}`} onClick={event => { event.preventDefault(); onOpenFile(item.file); }}><code>{item.file}</code></a></TraceTitle> : <TraceTitle>{label} <code>{command ?? item.file}</code></TraceTitle>}{!failed && !running && item.stat && <TraceDescription><span className="text-[var(--diff-add-text)]">{item.stat.split(" ")[0]}</span> <span className="text-[var(--diff-del-text)]">{item.stat.split(" ")[1]}</span></TraceDescription>}</TraceLine>;
    const error = failed && <CodeBlock size="sm" variant="destructive"><CodeBlockContent wrap className="max-h-64 data-wrap:wrap-anywhere">{item.error}</CodeBlockContent></CodeBlock>;
    if (read) return <div key={key} className="flex min-w-0 flex-col gap-2">{line}{error && <div className="ml-6 min-w-0">{error}</div>}</div>;

    const detail = edit || write
      ? failed ? error : running && !diff ? null : diff ? <CodeBlock size="sm"><CodeBlockContent wrap className="max-h-64 data-wrap:wrap-anywhere">{diff.lines.length ? diff.lines.map((line, n) => <CodeBlockLine key={n} variant={line.type === "add" ? "added" : line.type === "del" ? "removed" : "default"}>{line.code}</CodeBlockLine>) : "无内容差异（空文件）"}</CodeBlockContent></CodeBlock> : <p>暂无此调用的差异记录</p>
      : command ? <CodeBlock size="sm" variant={failed ? "destructive" : "default"}><CodeBlockContent wrap className="max-h-64 data-wrap:wrap-anywhere">{[`$ ${command}`, item.output, item.error].filter(value => value !== undefined).join("\n")}</CodeBlockContent></CodeBlock>
      : failed ? error : (item.output ?? item.note) !== undefined ? <CodeBlock size="sm"><CodeBlockContent wrap className="max-h-64 data-wrap:wrap-anywhere">{item.output ?? item.note}</CodeBlockContent></CodeBlock> : null;
    if (!detail) return <div key={key}>{line}</div>;
    return <TraceCollapsible key={key} open={detailOpen} onOpenChange={value => onExpand(key, value)}><TraceCollapsibleTrigger aria-label={running ? `${label} ${command ?? item.file}` : undefined}>{line}</TraceCollapsibleTrigger><TraceCollapsibleContent inert={!detailOpen} aria-hidden={!detailOpen}>{detail}</TraceCollapsibleContent></TraceCollapsible>;
  }

  return <Trace>{thought}{step.items.map((item, index) => item.action === "Agent" ? <button type="button" key={`${stateKey}:tool:${index}`} onClick={() => onOpenAgent(item.file)}><TraceLine><TraceIcon><Bot /></TraceIcon><TraceTitle className="shrink-0">{item.file}</TraceTitle><TraceDescription className="min-w-0 shrink truncate">{item.note}</TraceDescription></TraceLine></button> : renderTool(item, index))}</Trace>;
}

// Note: 见 .agents/notes/implemented/feature/2026-10-18-completed-trace.md
export function ExecutionTrace({ completed, failed, duration, stateKey, expanded, onExpand, children }: Pick<Props, "expanded" | "onExpand"> & { completed: boolean; failed: boolean; duration?: string; stateKey: string; children: ReactNode }) {
  const open = !completed || (expanded[stateKey] ?? false);
  return <Trace><TraceCollapsible className="execution-trace" data-completed={completed} open={open} onOpenChange={value => onExpand(stateKey, value)}>{completed && <TraceCollapsibleTrigger aria-label={open ? "收起执行记录" : "展开执行记录"}><TraceLine status={failed ? "error" : undefined}><TraceIcon>{failed ? <CircleAlert /> : <ListChecks />}</TraceIcon><TraceTitle>{duration ? `Worked for ${duration}` : "Worked"}</TraceTitle></TraceLine></TraceCollapsibleTrigger>}<TraceCollapsibleContent className="execution-trace-content" inert={!open} aria-hidden={!open}>{children}</TraceCollapsibleContent></TraceCollapsible></Trace>;
}
