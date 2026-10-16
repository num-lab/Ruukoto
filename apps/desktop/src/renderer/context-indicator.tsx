import type { CSSProperties } from "react";
import type { DesktopContextState } from "./context-state.ts";
import { Button } from "./components/ui/button.tsx";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./components/ui/hover-card.tsx";
import { Progress } from "./components/ui/progress.tsx";

const compact = (tokens: number) => tokens.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
const bounded = (percent: number) => Math.max(0, Math.min(100, percent));

// Note: 见 .agents/notes/implemented/architecture/2026-10-16-desktop-current-demo.md
export function ContextDetails({ context }: { context: DesktopContextState }) {
  const data = context.value?.display;
  const percent = data?.usedPercent ?? null;
  const progress = percent === null ? null : bounded(percent);
  const style = data && progress !== null ? { "--context-system-end": `${100 - progress + (data.usedTokens ? data.systemTokens / data.usedTokens * progress : 0)}%`, "--context-tools-end": `${100 - progress + (data.usedTokens ? (data.systemTokens + data.toolTokens) / data.usedTokens * progress : 0)}%` } as CSSProperties : undefined;
  return <>
    <div className="context-summary"><span>{percent === null ? "—" : `${Math.round(percent)}%`} <span>of context used</span></span><span>{data ? `~${compact(data.usedTokens)}` : "—"} / {data?.maxTokens === null || data?.maxTokens === undefined ? "—" : compact(data.maxTokens)}</span></div>
    <Progress value={progress} aria-label="上下文使用量" aria-valuetext={percent === null ? "上下文容量未知" : undefined} style={style} />
    <dl className="context-breakdown">{[
      { label: "System prompt", tokens: data?.systemTokens, className: "context-system" },
      { label: "Tool definitions", tokens: data?.toolTokens, className: "context-tools" },
      { label: "Messages", tokens: data?.messageTokens, className: "context-messages" },
    ].map(item => <div key={item.label}><dt><i className={item.className} aria-hidden="true" />{item.label}</dt><dd>{item.tokens === undefined ? "—" : `~${compact(item.tokens)}`}</dd></div>)}</dl>
    {context.error && <p className="text-xs text-muted-foreground" role="alert">{context.error}</p>}
  </>;
}

export function ContextIndicator({ context, onOpen }: { context: DesktopContextState; onOpen: () => void }) {
  const data = context.value?.display;
  const percent = data?.usedPercent ?? null;
  const description = data ? `${data.usedTokens.toLocaleString("en-US")} / ${data.maxTokens === null ? "未知" : data.maxTokens.toLocaleString("en-US")} tokens` : context.loading ? "正在读取上下文使用量" : context.missing ? "暂无已记录的模型上下文" : "上下文使用量未知";
  return <HoverCard openDelay={10} closeDelay={100} onOpenChange={open => { if (open) onOpen(); }}><HoverCardTrigger asChild><Button type="button" variant="ghost" size="icon" className="context-usage" aria-label="上下文使用量" aria-description={description} aria-busy={context.loading}><svg data-slot="context-ring" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="4" strokeOpacity="0.25" />{percent !== null && <circle data-slot="context-ring-value" cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="4" strokeLinecap="round" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - bounded(percent)} transform="rotate(-90 12 12)" opacity={percent === 0 ? 0 : 1} />}</svg></Button></HoverCardTrigger><HoverCardContent side="top" align="start" alignOffset={-16} sideOffset={8} className="context-details"><ContextDetails context={context} /></HoverCardContent></HoverCard>;
}
