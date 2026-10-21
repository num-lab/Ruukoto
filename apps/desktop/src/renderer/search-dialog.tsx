import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Archive, Loader2, Search } from "lucide-react";
import type { CodeState } from "./code-state.ts";
import { foldSearchText, relativeSearchTime } from "./search-state.ts";
import { Button } from "./components/ui/button.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Input } from "./components/ui/input.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./components/ui/dialog.tsx";

export function SearchHighlight({ text, query }: { text: string; query: string }) {
  const index = query.trim() ? foldSearchText(text).indexOf(foldSearchText(query)) : -1;
  return index < 0 ? <>{text}</> : <>{text.slice(0, index)}<mark>{text.slice(index, index + query.length)}</mark>{text.slice(index + query.length)}</>;
}
// Note: 见 .agents/notes/implemented/feature/2026-10-21-desktop-spotlight-search.md
function SearchSnippet({ text, query }: { text: string; query: string }) {
  const preview = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const node = preview.current!;
    const center = () => {
      node.scrollLeft = 0;
      const mark = node.querySelector("mark");
      if (mark && node.scrollWidth > node.clientWidth) node.scrollLeft = Math.max(0, mark.getBoundingClientRect().left - node.getBoundingClientRect().left + (mark.getBoundingClientRect().width - node.clientWidth) / 2);
    };
    center();
    const observer = new ResizeObserver(center);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text, query]);
  return <span ref={preview} className="search-snippet search-preview"><SearchHighlight text={text} query={query} /></span>;
}
// Note: 见 .agents/notes/implemented/simplification/2026-10-21-desktop-search-session-navigation.md
export function SearchDialog({ model, onOpenSession }: { model: CodeState; onOpenSession: (sessionId: string) => void }) {
  const search = model.search;
  const input = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const navigating = useRef(false);
  const [selected, setSelected] = useState("");
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const [scrolling, setScrolling] = useState(false);
  const scrollTimer = useRef<number | undefined>(undefined);
  const listId = useId();
  const sessions = search.sessions;
  const options = [...sessions.map(session => ({ key: `session:${session.sessionId}`, sessionId: session.sessionId })), ...search.hits.map(hit => ({ key: `entry:${hit.sessionId}:${hit.entryId}`, sessionId: hit.sessionId }))];
  const active = Math.max(0, options.findIndex(option => option.key === selected));
  const activeKey = options[active]?.key;
  const optionId = (key: string) => `${listId}:${key}`;
  useEffect(() => { setSelected(""); }, [search.query, search.open]);
  useEffect(() => { if (activeKey) document.getElementById(optionId(activeKey))?.scrollIntoView({ block: "nearest" }); }, [activeKey]);
  useEffect(() => {
    setScrolling(false);
    window.clearTimeout(scrollTimer.current);
    return () => window.clearTimeout(scrollTimer.current);
  }, [search.open, search.query]);
  const loadMoreEnabled = search.open && search.online && search.hasMore && !search.loading && !search.composing && search.hits.length > 0;
  useEffect(() => {
    if (!loadMoreEnabled || !viewport || !end.current) return;
    let live = true, requested = false;
    const observer = new IntersectionObserver(entries => {
      if (!live || requested || !search.open || !search.online || search.loading || search.composing || !search.hasMore || !entries.some(entry => entry.isIntersecting)) return;
      requested = true;
      search.loadMore();
    }, { root: viewport, rootMargin: "0px 0px 80px 0px" });
    observer.observe(end.current);
    return () => { live = false; observer.disconnect(); };
  }, [search, viewport, loadMoreEnabled, search.hits, search.hits.length]);
  const workspaceName = (sessionId: string) => {
    const workspaceId = search.summaries?.find(item => item.sessionId === sessionId)?.workspaceId;
    return model.view.projects.find(project => project.id === workspaceId)?.name ?? "未知工作区";
  };
  const sessionName = (sessionId: string) => search.summaries?.find(item => item.sessionId === sessionId)?.name ?? model.sessionName(sessionId);
  const archived = (sessionId: string) => !!search.summaries?.find(item => item.sessionId === sessionId)?.archivedAt;
  function choose(index: number) {
    const option = options[index];
    if (!option || search.composing) return;
    navigating.current = true;
    search.setOpen(false);
    onOpenSession(option.sessionId);
  }
  const error = !search.online ? "Code 已离线，恢复连接后可重新搜索。" : search.error ?? search.summariesError;
  return <Dialog open={search.open} onOpenChange={open => search.setOpen(open)}><DialogContent className="search-dialog" showCloseButton={false} onOpenAutoFocus={event => {
    event.preventDefault();
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    navigating.current = false;
    input.current?.focus();
  }} onCloseAutoFocus={event => { event.preventDefault(); if (navigating.current) document.querySelector<HTMLTextAreaElement>(".main-canvas textarea")?.focus(); else previousFocus.current?.focus(); }} onEscapeKeyDown={event => { if (search.composing || event.isComposing) event.preventDefault(); }}>
    <DialogTitle className="sr-only">搜索 Code 工作区</DialogTitle><DialogDescription className="sr-only">搜索全部工作区的会话与聊天内容，使用方向键选择，回车打开，Esc 或 ⌘K 关闭。</DialogDescription>
    <div className="search-input-row"><Search aria-hidden="true" /><Input ref={input} aria-label="搜索 Code 会话与聊天内容" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={listId} aria-activedescendant={activeKey ? optionId(activeKey) : undefined} placeholder="搜索会话与聊天内容…" value={search.query} onCompositionStart={() => search.setComposing(true)} onCompositionEnd={event => { search.setQuery(event.currentTarget.value); search.setComposing(false); }} onChange={event => search.setQuery(event.target.value)} onKeyDown={event => {
      if (search.composing || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if (options.length) setSelected(options[(active + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length].key); }
      if (event.key === "Enter") { event.preventDefault(); choose(active); }
    }} />{(search.loading || search.summariesLoading) && <Loader2 className="animate-spin" aria-label="正在搜索" />}<kbd>esc</kbd></div>
    <div ref={setViewport} id={listId} role="listbox" aria-label="搜索结果" className="search-results" data-scrolling={scrolling || undefined} aria-busy={search.loading || search.summariesLoading} onScroll={() => { setScrolling(true); window.clearTimeout(scrollTimer.current); scrollTimer.current = window.setTimeout(() => setScrolling(false), 700); }}>
      {sessions.length > 0 && <div role="group" aria-labelledby={`${listId}-sessions`}><h2 id={`${listId}-sessions`}>{search.query.trim() ? "会话" : "最近活动的会话"}</h2>{sessions.map((session, index) => <Button key={session.sessionId} id={optionId(options[index].key)} type="button" variant="ghost" role="option" tabIndex={-1} aria-selected={active === index} className="search-option" onMouseDown={event => event.preventDefault()} onMouseEnter={() => setSelected(options[index].key)} onClick={() => choose(index)}><span className="search-option-text"><span><span className="search-snippet"><SearchHighlight text={session.name ?? "新会话"} query={search.query} /></span>{session.archivedAt && <Badge variant="outline"><Archive data-icon="inline-start" />已存档</Badge>}</span><small className="search-snippet">{workspaceName(session.sessionId)}</small></span></Button>)}</div>}
      {search.hits.length > 0 && <div role="group" aria-labelledby={`${listId}-messages`}><h2 id={`${listId}-messages`}>聊天内容</h2>{search.hits.map((hit, offset) => {
        const index = sessions.length + offset;
        const relativeTime = hit.timestamp ? relativeSearchTime(hit.timestamp) : "";
        return <Button key={options[index].key} id={optionId(options[index].key)} type="button" variant="ghost" role="option" tabIndex={-1} aria-selected={active === index} className="search-option search-message-option" onMouseDown={event => event.preventDefault()} onMouseEnter={() => setSelected(options[index].key)} onClick={() => choose(index)}><span className="search-option-text"><span className="search-hit-heading"><span className="search-snippet"><SearchHighlight text={sessionName(hit.sessionId)} query={search.query} /></span>{archived(hit.sessionId) && <Badge variant="outline">已存档</Badge>}</span><SearchSnippet text={hit.snippet} query={search.query} /></span>{hit.timestamp && relativeTime && <time className="search-result-time" dateTime={hit.timestamp} title={new Date(hit.timestamp).toLocaleString()}>{relativeTime}</time>}</Button>;
      })}</div>}
      {search.hasMore && search.hits.length > 0 && <div ref={end} className="search-end" aria-hidden="true" />}
    </div>
    <span className="sr-only" role="status" aria-live="polite">{search.status}</span>
    {error && <p className="search-note" role="alert">{error}</p>}
  </DialogContent></Dialog>;
}
