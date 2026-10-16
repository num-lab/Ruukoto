import { useEffect, useRef } from "react";
import { FileCode2, FileText, FolderTree, Globe, Plus, Sparkles, X } from "lucide-react";
import { subAgentStateLabel } from "@ruukoto/view/state.ts";
import type { CodeState } from "./code-state.ts";
import { BrowserPanel, WorkspaceFiles, WorkspaceFile } from "./inspector-panels.tsx";
import { Conversation } from "./conversation.tsx";
import { diffDisplay, isDiffTool, parsePatch } from "./diff.ts";
import { SidebarResizer } from "./sidebar-resizer.tsx";
import { IconButton } from "./ui.tsx";
import { Button } from "./components/ui/button.tsx";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs.tsx";

export function InspectorPanel({ model, open, onWidthChange }: { model: CodeState; open: boolean; onWidthChange: (width: number) => void }) {
  const inspector = model.inspector;
  const active = inspector.activeTab();
  const browser = inspector.tabs().find(tab => tab.kind === "browser");
  const tool = inspector.selectedTool();
  const display = tool ? diffDisplay(tool, inspector.result?.value) : null;
  const agent = active?.kind === "agent" ? inspector.agents().find(item => item.sessionId === active.sessionId) : undefined;
  const tools = inspector.parentSessionId ? model.view.openSession(inspector.parentSessionId).flow.tools.filter(isDiffTool) : [];
  const lines = display?.kind === "patch" ? parsePatch(display.text).filter(line => line.kind !== "header").map(line => ({ number: line.number, marker: line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " ", code: ["added", "removed", "context"].includes(line.kind) ? line.text.slice(1) : line.text })) : display?.kind === "write" && display.text ? display.text.replace(/\n$/, "").split("\n").map((code, index) => ({ number: index + 1, marker: " ", code })) : [];
  return <aside id="right-sidebar" className={`surface-inspector right-sidebar ${open ? "" : "is-collapsed"}`} aria-label="检查器" aria-hidden={!open} inert={!open}><div className="sidebar-content">
    <div className={`right-viewport ${["browser", "files", "file"].includes(active?.kind ?? "") ? "utility-viewport" : ""}`}>{browser && <div className="browser-container" hidden={active?.kind !== "browser"} aria-hidden={active?.kind !== "browser"} inert={active?.kind !== "browser"}><BrowserPanel key={`${model.view.instanceId}:${inspector.parentSessionId}:${browser.id}`} navigation={browser.navigation} onChange={navigation => { browser.navigation = navigation; model.refresh(); }} /></div>}{active?.kind === "browser" ? null : active?.kind === "files" ? <WorkspaceFiles model={model} workspaceId={active.workspaceId} /> : active?.kind === "file" ? <WorkspaceFile model={model} workspaceId={active.workspaceId} path={active.path} mode={active.mode} onMode={mode => { active.mode = mode; model.refresh(); }} /> : agent ? <><Conversation key={`${model.view.instanceId}:${agent.sessionId}`} model={model} sessionId={agent.sessionId} child /></> : tool && display ? <><div className="diff-heading"><span>{tool.target}</span>{tool.editStats && (tool.editStats.added > 0 || tool.editStats.removed > 0) && <code><b>+{tool.editStats.added}</b><em>−{tool.editStats.removed}</em></code>}</div>{inspector.result?.error ? <div className="diff-error"><FileCode2 /><p>{inspector.result.error}</p><Button variant="ghost" size="sm" onClick={() => { inspector.result = null; void inspector.loadDiff(); model.refresh(); }}>重试</Button></div> : display.kind === "patch" || display.kind === "write" ? <><div className="diff-view selectable-text"><div className="diff-lines">{lines.map((line, index) => <div className={`diff-line ${line.marker === "+" ? "diff-line-add" : line.marker === "−" ? "diff-line-del" : ""}`} key={index}><span>{line.number}</span><span>{line.marker}</span><code>{line.code}</code></div>)}</div></div></> : <div className="diff-error"><FileCode2 /><p>{display.text}</p></div>}{inspector.result?.moreError && <p className="text-sec" role="alert">{inspector.result.moreError}</p>}{display.truncated && <button className="diff-more" disabled={inspector.result?.loading} onClick={() => void inspector.loadMore()}>more</button>}</> : <div className="new-tab-page"><p>打开</p><button className="surface-flat" onClick={() => inspector.openBrowser()}><Globe /><span>浏览器</span></button><button className="surface-flat" disabled={!inspector.workspace()} onClick={() => inspector.openFiles()}><FolderTree /><span>文件树</span></button><p>工具差异</p>{tools.length ? tools.map(item => <button className="surface-flat" key={item.key} onClick={() => inspector.openDiff(inspector.parentSessionId!, item)}><FileCode2 /><span>{item.target.split("/").at(-1) || item.name}</span>{item.editStats && <code>+{item.editStats.added} −{item.editStats.removed}</code>}</button>) : <span>暂无工具差异</span>}<p>SubAgent</p>{inspector.agents().length ? inspector.agents().map(item => <button className="surface-flat" key={item.id} onClick={() => inspector.selectChild(item.sessionId)}><Sparkles /><span>{item.definition?.name ?? "SubAgent"}</span><small>{subAgentStateLabel(item)}</small></button>) : <span>暂无 SubAgent</span>}{inspector.workError && <div className="diff-error"><p>{inspector.workError}</p><Button variant="ghost" size="sm" onClick={() => void inspector.loadWorks()}>重试</Button></div>}</div>}</div>
  </div><SidebarResizer side="right" open={open} onWidthChange={onWidthChange} /></aside>;
}

export function InspectorHeader({ model, open }: { model: CodeState; open: boolean }) {
  const inspector = model.inspector;
  const active = inspector.activeTab();
  const tabList = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = tabList.current;
    if (!list || !open) return;
    const reveal = () => list.querySelector<HTMLElement>('[data-state="active"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
    const observer = new ResizeObserver(reveal);
    observer.observe(list); reveal();
    return () => observer.disconnect();
  }, [active?.id, open, inspector.parentSessionId]);
  return <div className="right-header" aria-hidden={!open} inert={!open}><Tabs ref={tabList} className="right-tabs" value={active?.id ?? ""} onValueChange={id => inspector.selectTab(id)}><TabsList aria-label="右侧标签">{inspector.tabs().map(tab => <div className="tab-group" key={tab.id}><TabsTrigger value={tab.id} className="right-tab" aria-label={tab.kind === "file" ? `${tab.path} 文件预览` : undefined}>{tab.kind === "diff" ? <FileCode2 /> : tab.kind === "agent" ? <Sparkles /> : tab.kind === "browser" ? <Globe /> : tab.kind === "files" ? <FolderTree /> : tab.kind === "file" ? <FileText /> : <Plus />}<span>{tab.title}</span></TabsTrigger><button className="tab-close" aria-label={tab.kind === "file" ? `关闭文件预览 ${tab.path}` : `关闭右栏${tab.title}`} onClick={() => inspector.closeTab(tab.id)}><X /></button></div>)}</TabsList></Tabs><IconButton label="右栏新标签" onClick={() => inspector.newTab()}><Plus /></IconButton></div>;
}
