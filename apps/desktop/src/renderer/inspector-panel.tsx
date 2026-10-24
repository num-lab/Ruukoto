import { useEffect, useRef } from "react";
import { Activity, FileCode2, FileText, FolderTree, GitGraph, Globe, Plus, Sparkles, SquareTerminal, X } from "lucide-react";
import type { CodeState } from "./code-state.ts";
import { BackgroundPanel } from "./background-process-panel.tsx";
import { BrowserPanel, WorkspaceFiles, WorkspaceFile, ReadSnapshotPreview } from "./inspector-panels.tsx";
import { TerminalPanel } from "./terminal-panel.tsx";
import { Conversation } from "./conversation.tsx";
import { diffDisplay, parsePatch } from "./diff.ts";
import { SidebarResizer } from "./sidebar-resizer.tsx";
import { GitGraphPanel } from "./git-graph.tsx";
import { useTabOrder } from "./tab-order.ts";
import { IconButton } from "./ui.tsx";
import { Button } from "./components/ui/button.tsx";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs.tsx";

export function InspectorPanel({ model, terminalModel = model, open, onWidthChange }: { model: CodeState; terminalModel?: CodeState; open: boolean; onWidthChange: (width: number) => void }) {
  const inspector = model.inspector;
  const workspace = inspector.workspace();
  const active = inspector.activeTab();
  const git = active?.kind === "git" ? inspector.repositories.get(active.workspaceId) : undefined;
  const browser = inspector.tabs().find(tab => tab.kind === "browser");
  useEffect(() => { if (open && active?.kind === "git") void inspector.loadGit(active.workspaceId); }, [inspector, open, active?.id, model.view.instanceId, model.status.state]);
  const tool = inspector.selectedTool();
  const display = tool ? diffDisplay(tool, inspector.result?.value) : null;
  const agent = active?.kind === "agent" ? inspector.agents().find(item => item.sessionId === active.sessionId) : undefined;
  const lines = display?.kind === "patch" ? parsePatch(display.text).filter(line => line.kind !== "header").map(line => ({ number: line.number, marker: line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " ", code: ["added", "removed", "context"].includes(line.kind) ? line.text.slice(1) : line.text })) : display?.kind === "write" && display.text ? display.text.replace(/\n$/, "").split("\n").map((code, index) => ({ number: index + 1, marker: " ", code })) : [];
  return <aside id="right-sidebar" className={`surface-inspector right-sidebar ${open ? "" : "is-collapsed"}`} aria-label="检查器" aria-hidden={!open} inert={!open}><div className="sidebar-content">
    <div className={`right-viewport ${["browser", "files", "file", "read-snapshot", "git", "terminal", "background"].includes(active?.kind ?? "") ? "utility-viewport" : ""}`}>{terminalModel.inspector.terminalTabs().map(tab => <div key={tab.id} className="terminal-container" hidden={model !== terminalModel || active?.id !== tab.id} aria-hidden={model !== terminalModel || active?.id !== tab.id} inert={model !== terminalModel || active?.id !== tab.id}><TerminalPanel model={terminalModel} tab={tab} active={open && model === terminalModel && active?.id === tab.id} /></div>)}{browser && <div className="browser-container" hidden={active?.kind !== "browser"} aria-hidden={active?.kind !== "browser"} inert={active?.kind !== "browser"}><BrowserPanel key={`${model.view.instanceId}:${inspector.parentSessionId}:${browser.id}`} navigation={browser.navigation} target={model.target} onChange={navigation => { browser.navigation = navigation; model.refresh(); }} /></div>}{active?.kind === "browser" || active?.kind === "terminal" ? null : active?.kind === "git" ? <>{git?.value?.repository ? <GitGraphPanel key={`${model.view.instanceId}:${active.workspaceId}`} active={open && model.status.state === "online"} name={workspace?.name ?? "Git graph"} repository={git.value.repository} onRefresh={() => void inspector.loadGit(active.workspaceId, true)} loading={git.loading} onLoadMore={() => void inspector.loadMoreGit(active.workspaceId)} loadingMore={git.loadingMore} moreError={git.moreError} error={git.error} /> : <div className="file-panel-empty"><p role={git?.error ? "alert" : "status"}>{git?.error ?? (git?.value?.repository === null && !git.loading ? "此工作区没有 Git 仓库。" : model.status.state === "online" ? "正在读取 Git 仓库…" : "等待连接…")}</p><Button variant="ghost" size="sm" disabled={model.status.state !== "online"} onClick={() => void inspector.loadGit(active.workspaceId, true)}>刷新</Button></div>}</> : active?.kind === "files" ? <WorkspaceFiles model={model} workspaceId={active.workspaceId} active={open} /> : active?.kind === "read-snapshot" ? <ReadSnapshotPreview model={model} tab={active} /> : active?.kind === "file" ? <WorkspaceFile model={model} workspaceId={active.workspaceId} path={active.path} mode={active.mode} onMode={mode => { active.mode = mode; model.refresh(); }} /> : active?.kind === "background" ? <BackgroundPanel model={model} /> : agent ? <><Conversation key={`${model.view.instanceId}:${agent.sessionId}`} model={model} sessionId={agent.sessionId} child /></> : tool && display ? <><div className="diff-heading"><span>{tool.target}</span>{tool.editStats && (tool.editStats.added > 0 || tool.editStats.removed > 0) && <code><b>+{tool.editStats.added}</b><em>−{tool.editStats.removed}</em></code>}</div>{inspector.result?.error ? <div className="diff-error"><FileCode2 /><p>{inspector.result.error}</p><Button variant="ghost" size="sm" onClick={() => { inspector.result = null; void inspector.loadDiff(); model.refresh(); }}>重试</Button></div> : display.kind === "patch" || display.kind === "write" ? <><div className="diff-view selectable-text"><div className="diff-lines">{lines.map((line, index) => <div className={`diff-line ${line.marker === "+" ? "diff-line-add" : line.marker === "−" ? "diff-line-del" : ""}`} key={index}><span>{line.number}</span><span>{line.marker}</span><code>{line.code}</code></div>)}</div></div></> : <div className="diff-error"><FileCode2 /><p>{display.text}</p></div>}{inspector.result?.moreError && <p className="text-sec" role="alert">{inspector.result.moreError}</p>}{display.truncated && <button className="diff-more" disabled={inspector.result?.loading} onClick={() => void inspector.loadMore()}>more</button>}</> : <div className="new-tab-page"><p>打开</p><button className="surface-flat" onClick={() => inspector.openBrowser()}><Globe /><span>浏览器</span></button>{model.target === "code" && <><button className="surface-flat" disabled={!workspace} onClick={() => inspector.openTerminal()}><SquareTerminal /><span>终端</span></button><button className="surface-flat" disabled={!workspace} onClick={() => inspector.openFiles()}><FolderTree /><span>文件树</span></button><button className="surface-flat" disabled={!workspace} onClick={() => inspector.openGit()}><GitGraph /><span>Git graph</span></button><button className="surface-flat" onClick={() => inspector.openBackground()}><Activity /><span>后台进程</span></button></>}</div>}</div>
  </div><SidebarResizer side="right" open={open} onWidthChange={onWidthChange} /></aside>;
}

export function InspectorHeader({ model, open }: { model: CodeState; open: boolean }) {
  const inspector = model.inspector;
  const active = inspector.activeTab();
  const order = useTabOrder(`${model.target}:${model.view.instanceId}:${inspector.parentSessionId}`, inspector.tabs().map(tab => tab.id), (from, to) => inspector.reorderTab(from, to), id => inspector.tabs().find(tab => tab.id === id)?.title ?? "标签");
  const tabList = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = tabList.current;
    if (!list || !open) return;
    const reveal = () => list.querySelector<HTMLElement>('[data-state="active"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
    const observer = new ResizeObserver(reveal);
    observer.observe(list); reveal();
    return () => observer.disconnect();
  }, [active?.id, open, inspector.parentSessionId]);
  return <div className="right-header" aria-hidden={!open} inert={!open}><Tabs ref={tabList} className="right-tabs" value={active?.id ?? ""} onValueChange={id => inspector.selectTab(id)}><TabsList aria-label="右侧标签" {...order.list}>{inspector.tabs().map(tab => <div className="tab-group" key={tab.id} {...order.group(tab.id)}><TabsTrigger value={tab.id} className="right-tab" {...order.trigger(tab.id)} aria-label={(tab.kind === "file" || tab.kind === "read-snapshot") ? `${tab.path} 文件预览` : undefined}>{tab.kind === "diff" ? <FileCode2 /> : tab.kind === "agent" ? <Sparkles /> : tab.kind === "browser" ? <Globe /> : tab.kind === "files" ? <FolderTree /> : (tab.kind === "file" || tab.kind === "read-snapshot") ? <FileText /> : tab.kind === "git" ? <GitGraph /> : tab.kind === "terminal" ? <SquareTerminal /> : tab.kind === "background" ? <Activity /> : <Plus />}<span>{tab.title}</span></TabsTrigger><button className="tab-close" aria-label={(tab.kind === "file" || tab.kind === "read-snapshot") ? `关闭文件预览 ${tab.path}` : `关闭右栏${tab.title}`} onClick={() => inspector.closeTab(tab.id)}><X /></button></div>)}</TabsList></Tabs><span className="sr-only" role="status">{order.announcement}</span><IconButton label="右栏新标签" onClick={() => inspector.newTab()}><Plus /></IconButton></div>;
}
