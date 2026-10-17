import { useEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent, type UIEvent } from "react";
import { GitBranch, GitGraph, RefreshCw, Tag } from "lucide-react";
import { Button } from "./components/ui/button.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible.tsx";
import { buildGitGraph, extendGitGraph, gitGraphCanExtend, gitGraphWindow, type GitGraphModel, type GitGraphWindowEdge } from "./git-graph-model.ts";
import type { GitCommit, GitRepository } from "./git-graph-data.ts";
import { GIT_GRAPH_ROW_HEIGHT, gitGraphClampScroll, gitGraphMetrics, gitGraphRenderWindow, type GitGraphExpansion } from "./git-graph-window.ts";

const rowHeight = GIT_GRAPH_ROW_HEIGHT;
const nodeY = rowHeight / 2;
const bendY = (nodeY + rowHeight) / 2;

export function GitCommitDetails({ commit }: { commit: GitCommit }) {
  return <div className="git-commit-detail-body selectable-text">
    <p>{commit.subject}</p>
    <dl><dt>作者</dt><dd>{commit.author}</dd><dt>提交时间</dt><dd><time dateTime={commit.date}>{commit.date}</time></dd><dt>短哈希</dt><dd><code>{commit.id.slice(0, 7)}</code></dd><dt>父提交</dt><dd>{commit.parents.length ? commit.parents.map(id => id.slice(0, 7)).join("、") : "根提交"}</dd></dl>
  </div>;
}

const laneX = (lane: number) => `${12 + lane * 14}`;
const laneColor = (lane: number) => `var(--git-lane-${lane % 6})`;

// Note: 见 .agents/notes/implemented/feature/2026-10-17-demo-git-graph.md
// Note: 见 .agents/notes/implemented/feature/2026-10-17-demo-git-commit-details.md
// Note: 见 .agents/notes/implemented/feature/2026-10-17-desktop-git-lazy-loading.md
// Note: 见 .agents/notes/implemented/feature/2026-10-18-desktop-git-graph-windowing.md
export function GitGraphPanel({ name, repository, onRefresh, loading, onLoadMore, loadingMore = false, moreError, error, active }: { name: string; repository: GitRepository & { nextCursor?: string | null }; onRefresh: () => void; loading: boolean; onLoadMore?: () => void; loadingMore?: boolean; moreError?: string; error?: string; active: boolean }) {
  const viewport = useRef<HTMLDivElement>(null), end = useRef<HTMLLIElement>(null);
  const modelRef = useRef<GitGraphModel | null>(null), detailNodes = useRef(new Map<string, HTMLElement>()), detailCallbacks = useRef(new Map<string, (node: HTMLElement | null) => void>());
  const frame = useRef(0), pendingScroll = useRef(0), firstCommitId = useRef<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0), [viewportSize, setViewportSize] = useState({ height: 0, width: 0 }), [contentWidth, setContentWidth] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set()), [extraHeights, setExtraHeights] = useState<ReadonlyMap<string, number>>(() => new Map()), [focusId, setFocusId] = useState<string | null>(null);
  const commits = repository.commits;
  const model = useMemo(() => {
    const previous = modelRef.current;
    if (previous && gitGraphCanExtend(previous, commits)) return modelRef.current = extendGitGraph(previous, commits);
    return modelRef.current = buildGitGraph(commits);
  }, [commits]);
  const loadMore = useRef(onLoadMore);
  useEffect(() => { loadMore.current = onLoadMore; }, [onLoadMore]);
  const enabled = active && !loading && !loadingMore && !moreError && !error && !!onLoadMore, hasCommits = commits.length > 0;
  useEffect(() => {
    if (!enabled || !repository.nextCursor || !viewport.current || !end.current) return;
    let live = true, requested = false;
    const observer = new IntersectionObserver(entries => {
      if (!live || requested || !entries.some(entry => entry.isIntersecting)) return;
      requested = true;
      loadMore.current?.();
    }, { root: viewport.current, rootMargin: "0px 0px 224px 0px" });
    observer.observe(end.current);
    return () => { live = false; observer.disconnect(); };
  }, [enabled, repository.nextCursor]);
  useEffect(() => {
    const node = viewport.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const height = node.clientHeight, width = node.clientWidth;
      if (!Number.isFinite(height) || height <= 0) return;
      setViewportSize(previous => previous.height === height && previous.width === width ? previous : { height, width });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node); measure();
    return () => observer.disconnect();
  }, [hasCommits]);
  useEffect(() => () => { if (frame.current) cancelAnimationFrame(frame.current); }, []);
  useEffect(() => {
    const firstId = commits[0]?.id ?? null;
    if (firstId !== firstCommitId.current) { firstCommitId.current = firstId; setContentWidth(0); }
    setExpanded(previous => { const next = new Set([...previous].filter(id => model.rowById.has(id))); return next.size === previous.size ? previous : next; });
    setExtraHeights(previous => { const next = new Map([...previous].filter(([id]) => model.rowById.has(id))); return next.size === previous.size ? previous : next; });
    setFocusId(current => current !== null && !model.rowById.has(current) ? null : current);
  }, [model, commits]);
  const expansions = useMemo(() => {
    const list: GitGraphExpansion[] = [];
    for (const id of expanded) {
      const row = model.rowById.get(id), extra = extraHeights.get(id);
      if (row !== undefined && extra) list.push({ row, extra });
    }
    return list.sort((left, right) => left.row - right.row);
  }, [expanded, extraHeights, model]);
  const metrics = useMemo(() => gitGraphMetrics(commits.length, expansions), [commits.length, expansions]);
  useEffect(() => {
    const node = viewport.current;
    if (!node || !Number.isFinite(node.scrollTop) || !Number.isFinite(node.clientHeight)) return;
    const clamped = gitGraphClampScroll(node.scrollTop, metrics.totalHeight, node.clientHeight);
    if (clamped !== node.scrollTop) node.scrollTop = clamped;
    setScrollTop(current => current === clamped ? current : clamped);
  }, [metrics.totalHeight, commits.length, viewportSize.height]);
  const focusedRow = focusId === null ? null : model.rowById.get(focusId) ?? null;
  const plan = useMemo(() => gitGraphRenderWindow(metrics, scrollTop, viewportSize.height, focusedRow), [metrics, scrollTop, viewportSize.height, focusedRow]);
  const windowRows = useMemo(() => gitGraphWindow(model, commits, plan.first, plan.last), [model, commits, plan.first, plan.last]);
  const pinnedRows = useMemo(() => plan.pinned ? gitGraphWindow(model, commits, plan.pinned.row, plan.pinned.row + 1) : [], [model, commits, plan.pinned]);
  // 展开行重新进入窗口时要重测：窗口范围或行重新渲染都会改变 DOM 高度。
  useEffect(() => {
    let changed = false;
    const next = new Map(extraHeights);
    for (const id of expanded) {
      const node = detailNodes.current.get(id);
      if (!node) continue;
      const height = node.scrollHeight;
      if (height > 0 && next.get(id) !== height) { next.set(id, height); changed = true; }
    }
    if (changed) setExtraHeights(next);
  }, [model, commits, expanded, extraHeights, viewportSize.width, plan.first, plan.last]);
  // 标题与被渲染行提供自然宽度；缓存单调最大值并放进流内标尺，滚到短行窗口后仍保留横向滚动与哨兵宽度。
  useEffect(() => {
    const node = viewport.current;
    if (!node || typeof node.querySelectorAll !== "function") return;
    let maximum = 0;
    for (const row of node.querySelectorAll<HTMLElement>(".git-commit")) {
      const button = row.querySelector<HTMLElement>(".git-commit-summary"), subject = row.querySelector<HTMLElement>(".git-commit-subject");
      if (!button || !subject) continue;
      maximum = Math.max(maximum, subject.getBoundingClientRect().right - button.getBoundingClientRect().left + 4);
    }
    if (maximum > contentWidth + 1) setContentWidth(maximum);
  }, [windowRows, pinnedRows, viewportSize.width, contentWidth]);
  // 焦点行滚出窗口后由旁路行保留；窗口换行会移除原 DOM，必要时把焦点接回旁路行。
  useEffect(() => {
    if (!focusId) return;
    const node = viewport.current;
    if (!node || typeof node.contains !== "function") return;
    const active = document.activeElement;
    if (active && node.contains(active)) return;
    const row = [...node.querySelectorAll<HTMLElement>(".git-commit")].find(item => item.dataset.commitId === focusId);
    row?.querySelector<HTMLElement>(".git-commit-summary")?.focus({ preventScroll: true });
  }, [focusId, plan.pinned, windowRows]);
  // 宽度变化或展开行重新测量会改变窗口上方的总高度；保持可视内容位置，浏览器锚定已关闭。
  const anchor = useRef({ first: 0, top: 0 });
  useEffect(() => {
    const top = metrics.top(plan.first), previous = anchor.current;
    if (previous.first === plan.first && viewport.current && Number.isFinite(viewport.current.scrollTop) && top !== previous.top) viewport.current.scrollTop += top - previous.top;
    anchor.current = { first: plan.first, top };
  }, [metrics, plan.first]);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    pendingScroll.current = event.currentTarget.scrollTop;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => { frame.current = 0; setScrollTop(pendingScroll.current); });
  };
  const detailRef = (id: string) => {
    let callback = detailCallbacks.current.get(id);
    if (!callback) {
      callback = node => { if (node) detailNodes.current.set(id, node); else detailNodes.current.delete(id); };
      detailCallbacks.current.set(id, callback);
    }
    return callback;
  };
  const toggle = (id: string, open: boolean) => setExpanded(previous => { const next = new Set(previous); if (open) next.add(id); else next.delete(id); return next; });
  const blurRow = (event: FocusEvent<HTMLButtonElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.closest("ol")?.contains(next)) return;
    setFocusId(null);
  };
  const show = (row: { row: number; lane: number; incoming: GitGraphWindowEdge[]; parents: GitGraphWindowEdge[] }, pinnedTop?: number) => {
    const commit = commits[row.row]!;
    return <Collapsible asChild key={commit.id} open={expanded.has(commit.id)} onOpenChange={next => toggle(commit.id, next)}>
      <li className="git-commit" data-commit-id={commit.id} aria-setsize={commits.length} aria-posinset={row.row + 1} style={{ "--git-lane-color": laneColor(row.lane), ...(pinnedTop === undefined ? {} : { position: "absolute" as const, top: `${pinnedTop}px`, left: 0, right: 0 }) } as CSSProperties}>
        <span className="sr-only">{commit.parents.length ? `父提交：${commit.parents.map(id => `${id.slice(0, 7)}${model.rowById.has(id) ? "" : "（更早提交）"}`).join("、")}` : "根提交"}</span>
        <svg className="git-graph-lines" aria-hidden="true">
          {row.incoming.map((edge, index) => <g key={`incoming:${index}`} fill="none" stroke={laneColor(edge.lane)} strokeWidth="1.5" strokeDasharray={edge.continuation ? "3 3" : undefined}><line x1={laneX(edge.lane)} x2={laneX(edge.lane)} y1="0" y2={edge.lane === row.lane ? nodeY : "100%"} /></g>)}
          {row.parents.map((edge, index) => <g key={`parent:${index}`} fill="none" stroke={laneColor(edge.lane)} strokeWidth="1.5" strokeDasharray={edge.continuation ? "3 3" : undefined}><path d={edge.lane === row.lane ? `M ${laneX(row.lane)} ${nodeY} V ${rowHeight}` : `M ${laneX(row.lane)} ${nodeY} C ${laneX(row.lane)} ${bendY} ${laneX(edge.lane)} ${bendY} ${laneX(edge.lane)} ${rowHeight}`} /><line x1={laneX(edge.lane)} x2={laneX(edge.lane)} y1={rowHeight} y2="100%" /></g>)}
          {commit.id === repository.head && <circle cx={laneX(row.lane)} cy={nodeY} r="6" fill="none" stroke="var(--git-lane-color)" strokeWidth="1" />}
          <circle cx={laneX(row.lane)} cy={nodeY} r="3.5" fill="var(--bg-sidebar)" stroke="var(--git-lane-color)" strokeWidth="1.8" />
        </svg>
        <CollapsibleTrigger asChild><button type="button" className="git-commit-summary" onFocus={() => setFocusId(commit.id)} onBlur={blurRow}>
          <span className="git-commit-refs">{commit.id === repository.head && <Badge variant="outline" className="git-ref"><span className="git-ref-icon"><GitBranch aria-hidden="true" /></span><span className="git-ref-name">HEAD</span></Badge>}{commit.refs.map(ref => {
            const RefIcon = ref.type === "tag" ? Tag : GitBranch;
            return <Badge variant="outline" className="git-ref" key={`${ref.type}:${ref.remote ?? ""}:${ref.name}`}><span className="sr-only">{ref.type === "tag" ? "标签 " : ref.remote ? "远程分支 " : "分支 "}</span><span className="git-ref-icon"><RefIcon aria-hidden="true" /></span><span className="git-ref-name">{ref.name}</span>{ref.remote && <em className="git-ref-remote">{ref.remote}</em>}</Badge>;
          })}</span>
          <span className="git-commit-subject">{commit.subject}</span>
        </button></CollapsibleTrigger>
        <CollapsibleContent className="git-commit-details" role="region" aria-label={`提交详情 ${commit.subject}`}><div ref={detailRef(commit.id)}><GitCommitDetails commit={commit} /></div></CollapsibleContent>
      </li>
    </Collapsible>;
  };
  return <section className="git-graph-panel" aria-label="Git graph">
    <div className="file-panel-heading"><GitGraph /><span>{name}</span><Button type="button" variant="ghost" size="icon" className="quiet-icon" aria-label="刷新 Git 历史" disabled={loading} onClick={onRefresh}><RefreshCw /></Button></div>
    {!commits.length ? <p className="file-panel-empty">暂无提交</p> : <div ref={viewport} className="git-graph-log selectable-text" tabIndex={0} role="region" aria-label="Git 提交历史" aria-busy={loadingMore} onScroll={onScroll}>
      <ol className="git-graph-body" style={{ "--git-graph-width": `${model.laneCount * 14 + 10}px`, "--git-row-height": `${rowHeight}px` } as CSSProperties}>
        <li aria-hidden="true" style={{ height: 0, width: contentWidth }} />
        <li aria-hidden="true" style={{ height: metrics.top(plan.first) }} />
        {plan.pinned?.before && pinnedRows[0] && show(pinnedRows[0], metrics.top(pinnedRows[0].row))}
        {windowRows.map(row => show(row))}
        {plan.pinned && !plan.pinned.before && pinnedRows[0] && show(pinnedRows[0], metrics.top(pinnedRows[0].row))}
        <li aria-hidden="true" style={{ height: Math.max(0, metrics.totalHeight - metrics.top(plan.last)) }} />
        <li ref={end} aria-hidden="true" style={{ height: 1 }} />
      </ol>
    </div>}
    {(moreError || error) && <div className="browser-note" role="alert"><p>{moreError ?? error}</p>{moreError && onLoadMore && <Button type="button" variant="ghost" disabled={loading || loadingMore} onClick={onLoadMore}>重试</Button>}</div>}
  </section>;
}
