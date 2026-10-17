import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import { GitBranch, GitGraph, RefreshCw, Tag } from "lucide-react";
import { Button } from "./components/ui/button.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible.tsx";
import { layoutGitGraph, type GitCommit, type GitRepository } from "./git-graph-data.ts";

export function GitCommitDetails({ commit }: { commit: GitCommit }) {
  return <div className="git-commit-detail-body selectable-text">
    <p>{commit.subject}</p>
    <dl><dt>作者</dt><dd>{commit.author}</dd><dt>提交时间</dt><dd><time dateTime={commit.date}>{commit.date}</time></dd><dt>短哈希</dt><dd><code>{commit.id.slice(0, 7)}</code></dd><dt>父提交</dt><dd>{commit.parents.length ? commit.parents.map(id => id.slice(0, 7)).join("、") : "根提交"}</dd></dl>
  </div>;
}

// Note: 见 .agents/notes/implemented/feature/2026-10-17-demo-git-graph.md
// Note: 见 .agents/notes/implemented/feature/2026-10-17-demo-git-commit-details.md
// Note: 见 .agents/notes/implemented/feature/2026-10-17-desktop-git-lazy-loading.md
export function GitGraphPanel({ name, repository, onRefresh, loading, onLoadMore, loadingMore = false, moreError, error, active }: { name: string; repository: GitRepository & { nextCursor?: string | null }; onRefresh: () => void; loading: boolean; onLoadMore?: () => void; loadingMore?: boolean; moreError?: string; error?: string; active: boolean }) {
  const viewport = useRef<HTMLDivElement>(null), end = useRef<HTMLLIElement>(null);
  const loadMore = useRef(onLoadMore);
  useEffect(() => { loadMore.current = onLoadMore; }, [onLoadMore]);
  const enabled = active && !loading && !loadingMore && !moreError && !error && !!onLoadMore;
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
  const { rows, edgesByRow, laneCount } = useMemo(() => layoutGitGraph(repository.commits), [repository.commits]);
  const shownIds = new Set(rows.map(node => node.commit.id));
  const rowHeight = 28;
  const nodeY = rowHeight / 2;
  const bendY = (nodeY + rowHeight) / 2;
  const graphWidth = laneCount * 14 + 10;
  const x = (lane: number) => 12 + lane * 14;
  const color = (lane: number) => `var(--git-lane-${lane % 6})`;
  return <section className="git-graph-panel" aria-label="Git graph">
    <div className="file-panel-heading"><GitGraph /><span>{name}</span><Button type="button" variant="ghost" size="icon" className="quiet-icon" aria-label="刷新 Git 历史" disabled={loading} onClick={onRefresh}><RefreshCw /></Button></div>
    {!rows.length ? <p className="file-panel-empty">暂无提交</p> : <div ref={viewport} className="git-graph-log selectable-text" tabIndex={0} role="region" aria-label="Git 提交历史" aria-busy={loadingMore}>
      <ol className="git-graph-body" style={{ "--git-graph-width": `${graphWidth}px`, "--git-row-height": `${rowHeight}px` } as CSSProperties}>
        {rows.map(({ commit, row, lane }) => <Collapsible asChild key={commit.id}>
          <li className="git-commit" style={{ "--git-lane-color": color(lane) } as CSSProperties}>
            <span className="sr-only">{commit.parents.length ? `父提交：${commit.parents.map(id => `${id.slice(0, 7)}${shownIds.has(id) ? "" : "（更早提交）"}`).join("、")}` : "根提交"}</span>
            <svg className="git-graph-lines" aria-hidden="true">
              {edgesByRow[row].map((edge, index) => <g key={index} fill="none" stroke={color(edge.toLane)} strokeWidth="1.5" strokeDasharray={edge.continuation ? "3 3" : undefined}>
                {edge.from === row ? <><path d={edge.fromLane === edge.toLane ? `M ${x(lane)} ${nodeY} V ${rowHeight}` : `M ${x(lane)} ${nodeY} C ${x(lane)} ${bendY} ${x(edge.toLane)} ${bendY} ${x(edge.toLane)} ${rowHeight}`} /><line x1={x(edge.toLane)} x2={x(edge.toLane)} y1={rowHeight} y2="100%" /></> : <line x1={x(edge.toLane)} x2={x(edge.toLane)} y1="0" y2={edge.to === row ? nodeY : "100%"} />}
              </g>)}
              {commit.id === repository.head && <circle cx={x(lane)} cy={nodeY} r="6" fill="none" stroke="var(--git-lane-color)" strokeWidth="1" />}
              <circle cx={x(lane)} cy={nodeY} r="3.5" fill="var(--bg-sidebar)" stroke="var(--git-lane-color)" strokeWidth="1.8" />
            </svg>
            <CollapsibleTrigger asChild><button type="button" className="git-commit-summary">
              <span className="git-commit-refs">{commit.id === repository.head && <Badge variant="outline" className="git-ref"><span className="git-ref-icon"><GitBranch aria-hidden="true" /></span><span className="git-ref-name">HEAD</span></Badge>}{commit.refs.map(ref => {
                const RefIcon = ref.type === "tag" ? Tag : GitBranch;
                return <Badge variant="outline" className="git-ref" key={`${ref.type}:${ref.remote ?? ""}:${ref.name}`}><span className="sr-only">{ref.type === "tag" ? "标签 " : ref.remote ? "远程分支 " : "分支 "}</span><span className="git-ref-icon"><RefIcon aria-hidden="true" /></span><span className="git-ref-name">{ref.name}</span>{ref.remote && <em className="git-ref-remote">{ref.remote}</em>}</Badge>;
              })}</span>
              <span className="git-commit-subject">{commit.subject}</span>
            </button></CollapsibleTrigger>
            <CollapsibleContent className="git-commit-details" role="region" aria-label={`提交详情 ${commit.subject}`}><GitCommitDetails commit={commit} /></CollapsibleContent>
          </li>
        </Collapsible>)}
        <li ref={end} aria-hidden="true" style={{ height: 1 }} />
      </ol>
    </div>}
    {(moreError || error) && <div className="browser-note" role="alert"><p>{moreError ?? error}</p>{moreError && onLoadMore && <Button type="button" variant="ghost" disabled={loading || loadingMore} onClick={onLoadMore}>重试</Button>}</div>}
  </section>;
}
