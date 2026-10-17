import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronRight, Folder, ListFilter, Moon, PanelLeft, PanelRight, Plus, Settings2, Sun, Sparkles, Server, WifiOff, X } from "lucide-react";
import type { DesktopTarget } from "../shared/bridge.ts";
import { PersonalConnectionSettings } from "./personal-connection-settings.tsx";
import { reorderTab, useTabOrder } from "./tab-order.ts";
import { CodeState } from "./code-state.ts";
import { Conversation } from "./conversation.tsx";
import { Composer } from "./composer.tsx";
import { InspectorHeader, InspectorPanel } from "./inspector-panel.tsx";
import { SidebarResizer } from "./sidebar-resizer.tsx";
import { IconButton } from "./ui.tsx";
import { Button } from "./components/ui/button.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./components/ui/dialog.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible.tsx";
import { Input } from "./components/ui/input.tsx";

// Note: 见 .agents/notes/implemented/architecture/2026-10-15-desktop-shadcn-demo.md
export function App() {
  const [, redraw] = useState(0);
  const [activeId, setActiveId] = useState("");
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const target: DesktopTarget = activeId === "personal" ? "personal" : "code";
  const [models] = useState(() => ({ code: new CodeState(window.ruukoto, () => redraw(value => value + 1)), personal: new CodeState(window.ruukoto, () => redraw(value => value + 1), "personal") }));
  const model = models[target];
  const [dark, setDark] = useState(true);
  const [sidebar, setSidebar] = useState(true);
  const [sidebarWidths, setSidebarWidths] = useState<{ left?: number; right?: number }>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const filterInput = useRef<HTMLInputElement>(null);
  const filterToggle = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (filterOpen) filterInput.current?.focus(); }, [filterOpen]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dialog, setDialog] = useState<"workspace" | null>(null);
  const [settingsCategory, setSettingsCategory] = useState("appearance");
  const [workspacePath, setWorkspacePath] = useState("");
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");
  const expandSidebar = useRef<HTMLButtonElement>(null);
  const inspectorToggle = useRef<HTMLButtonElement>(null);
  const { view, status } = model;
  const current = view.sessions.find(session => session.id === (target === "personal" ? view.mainSessionId : view.currentSessionId));
  const workspaces = models.code.view.projects.filter(project => project.rootDir !== null);
  const inspectorOpen = model.inspector.visible && (target === "personal" || !!current);
  useEffect(() => { document.documentElement.classList.toggle("dark", dark); }, [dark]);
  useEffect(() => {
    models.code.inspector.visible = window.innerWidth >= 1100;
    const unsubscribes = (["code", "personal"] as const).map(source => window.ruukoto.subscribe(source, update => { models[source].update(update); if (update.type === "navigate") { const id = source === "personal" ? "personal" : `code:${models.code.view.currentSessionId}`; setOpenTabs(tabs => tabs.includes(id) ? tabs : [...tabs, id]); setActiveId(id); } }));
    return () => unsubscribes.forEach(unsubscribe => unsubscribe());
  }, [models]);
  useEffect(() => {
    const messages = [model.readError, model.approvals.message, model.writes.message, model.message].filter((message): message is string => !!message);
    if (messages.length) {
      setToast([...new Set(messages)].join(" · "));
      model.readError = null; model.approvals.message = null; model.writes.message = null; model.message = null;
    }
  });
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "b") { event.preventDefault(); toggleSidebar(); }
      if (event.key.toLowerCase() === "j") { event.preventDefault(); toggleInspector(); }
      if (event.shiftKey && event.key.toLowerCase() === "l") { event.preventDefault(); setDark(value => !value); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // Note: 见 .agents/notes/implemented/bug-fix/2026-10-17-desktop-sidebar-toggle.md
  function toggleSidebar() {
    const focusInside = document.activeElement?.closest(".left-sidebar, .settings-dialog");
    setSettingsOpen(false);
    setSidebar(value => !value);
    if (focusInside) window.requestAnimationFrame(() => expandSidebar.current?.focus());
  }
  function toggleInspector() {
    if (document.activeElement?.closest(".right-sidebar, .right-header")) inspectorToggle.current?.focus();
    model.inspector.visible = !model.inspector.visible;
    model.refresh();
  }
  async function reconnect() {
    try {
      const result = await window.ruukoto.request(target, "reconnect", {});
      if (!result.ok) model.update({ type: "state", state: "failed", error: result.error });
    } catch { setToast("重新连接未完成，请重新打开应用后重试。"); }
  }
  async function pickWorkspace() {
    setPicking(true);
    try {
      const result = await window.ruukoto.pickFolder();
      if (!result.ok) { setToast(result.error.message); return; }
      if (result.value) { setWorkspacePath(result.value); setDialog("workspace"); }
    } catch { setToast("无法选择工作区，请重新打开应用后重试。"); }
    finally { setPicking(false); }
  }
  function openSession(id: string) {
    const source = id === "personal" ? models.personal : models.code;
    if (id === "personal") { if (source.view.mainSessionId) source.openSession(source.view.mainSessionId); }
    else source.openSession(id.slice(5));
    setOpenTabs(tabs => tabs.includes(id) ? tabs : [...tabs, id]); setActiveId(id);
  }
  function closeSession(id: string) {
    const index = openTabs.indexOf(id), rest = openTabs.filter(tab => tab !== id);
    if (id !== "personal") models.code.closeSession(id.slice(5));
    setOpenTabs(rest);
    if (activeId === id) { const next = rest[Math.max(0, index - 1)] ?? ""; if (next) openSession(next); else setActiveId(""); }
  }
  useEffect(() => {
    const codeTabs = models.code.tabs.map(id => `code:${id}`);
    setOpenTabs(tabs => {
      const next = [...tabs.filter(id => id === "personal" || codeTabs.includes(id)), ...codeTabs.filter(id => !tabs.includes(id))];
      return next.join("\0") === tabs.join("\0") ? tabs : next;
    });
  });
  useEffect(() => {
    const personal = models.personal;
    if (activeId === "personal" && personal.view.mainSessionId && personal.view.currentSessionId !== personal.view.mainSessionId) personal.openSession(personal.view.mainSessionId);
  });
  const tabTitle = (id: string) => id === "personal" ? "Ruukoto" : models.code.sessionName(id.slice(5));
  const tabOrder = useTabOrder("main", openTabs, (from, to) => setOpenTabs(tabs => reorderTab(tabs, tabs.indexOf(from), tabs.indexOf(to))), tabTitle);
  async function saveDialog() {
    setSaving(true);
    try {
      const created = await models.code.create("open_workspace", { cwd: workspacePath });
      if (!created) { setToast(models.code.message ?? "创建结果待核实，请查看工作区列表后再试。"); return; }
      if (models.code.view.currentSessionId) openSession(`code:${models.code.view.currentSessionId}`);
      setDialog(null);
    } catch { setToast("添加结果待核实，请恢复连接后查看工作区。"); }
    finally { setSaving(false); }
  }
  const settings = <Dialog open={sidebar && settingsOpen} onOpenChange={setSettingsOpen}>
    <DialogTrigger asChild><Button type="button" variant="ghost" size="icon" className="quiet-icon" aria-label="设置"><Settings2 /></Button></DialogTrigger>
    <DialogContent className="settings-dialog" onCloseAutoFocus={event => { if (!sidebar) { event.preventDefault(); expandSidebar.current?.focus(); } }}>
      <DialogDescription className="sr-only">选择左侧类别查看设置项。</DialogDescription>
      <Tabs value={settingsCategory} onValueChange={setSettingsCategory} orientation="vertical" className="settings-tabs"><div className="settings-navigation"><DialogTitle>设置</DialogTitle><TabsList className="settings-categories" aria-label="设置类别"><TabsTrigger value="appearance">{dark ? <Moon /> : <Sun />}外观</TabsTrigger><TabsTrigger value="personal"><Server />PA 远程连接</TabsTrigger></TabsList></div>
        <TabsContent value="appearance" className="settings-panel"><h2>外观</h2><div className="settings-row"><label htmlFor="settings-theme">主题</label><Select value={dark ? "dark" : "light"} onValueChange={value => setDark(value === "dark")}><SelectTrigger id="settings-theme" aria-label="主题"><SelectValue /></SelectTrigger><SelectContent position="popper" align="end" sideOffset={6}><SelectItem value="light">浅色</SelectItem><SelectItem value="dark">深色</SelectItem></SelectContent></Select></div></TabsContent>
        <TabsContent value="personal" className="settings-panel"><h2>PA 远程连接</h2><PersonalConnectionSettings /></TabsContent>
      </Tabs>
    </DialogContent>
  </Dialog>;
  const hasWork = (id: string) => !!models.code.view.activeTaskFor(id) || models.code.view.pendingApprovals().some(item => item.sessionId === id);
  const query = filter.toLocaleLowerCase();
  return <><div className="macos-window app-window native-window" data-sidebar-open={sidebar} style={{ "--left-preferred-width": sidebarWidths.left === undefined ? undefined : `${sidebarWidths.left}px`, "--right-preferred-width": sidebarWidths.right === undefined ? undefined : `${sidebarWidths.right}px`, "--right-reserve": inspectorOpen ? "260px" : "0px", "--visible-left-width": sidebar ? "var(--left-width)" : "0px" } as CSSProperties}>
    <Button ref={expandSidebar} type="button" variant="ghost" size="icon" className="quiet-icon sidebar-toggle" aria-label={sidebar ? "收起侧栏" : "展开侧栏"} aria-controls="left-sidebar" aria-expanded={sidebar} onClick={toggleSidebar}><PanelLeft /></Button>
    <aside id="left-sidebar" className={`surface-sidebar left-sidebar ${sidebar ? "" : "is-collapsed"}`} aria-label="工作区导航" aria-hidden={!sidebar} inert={!sidebar}><div className="sidebar-content"><div className="window-controls"><div className="traffic-space" aria-hidden="true" /></div>
      <Button type="button" variant="ghost" className={`personal-row ${target === "personal" ? "active-pill text-pri" : "text-sec"}`} onClick={() => openSession("personal")}><Sparkles /><span>Ruukoto</span></Button><div className="projects-heading"><span>工作区</span><div><Button ref={filterToggle} type="button" variant="ghost" size="icon" className="quiet-icon" aria-label="筛选工作区与会话" aria-controls="workspace-filter" aria-expanded={filterOpen} onClick={() => { setFilterOpen(value => !value); setFilter(""); }}><ListFilter /></Button><IconButton label="添加工作区" disabled={picking || models.code.status.state !== "online" || !!models.code.pendingCreation} onClick={() => void pickWorkspace()}><Plus /></IconButton></div></div>
      <div id="workspace-filter" className="workspace-filter" data-open={filterOpen} aria-hidden={!filterOpen} inert={!filterOpen}><div className="workspace-filter-clip"><div className="workspace-filter-inner"><Input ref={filterInput} aria-label="筛选工作区与会话" placeholder="筛选工作区与会话…" value={filter} onChange={event => setFilter(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { setFilterOpen(false); setFilter(""); filterToggle.current?.focus(); } }} /></div></div></div>
      <div className="workspace-tree">{workspaces.filter(project => !query || project.name.toLocaleLowerCase().includes(query) || models.code.sessionsFor(project.id).some(session => models.code.sessionName(session.id).toLocaleLowerCase().includes(query))).map(project => {
        const open = expanded[project.id] ?? true;
        return <Collapsible asChild key={project.id} open={open || !!query} onOpenChange={() => setExpanded(items => ({ ...items, [project.id]: !open }))}><section><div className="workspace-row"><CollapsibleTrigger asChild><button><ChevronRight className={open || query ? "rotate-90" : ""} /><Folder /><span>{project.name}</span></button></CollapsibleTrigger><IconButton className="workspace-add" label={`在 ${project.name} 新建会话`} disabled={models.code.status.state !== "online" || !!models.code.pendingCreation} onClick={() => { setExpanded(items => ({ ...items, [project.id]: true })); void models.code.create("create_session", { project_id: project.id, cwd: project.rootDir!.cwdReal }).then(created => { if (!created) { setToast(models.code.message ?? "创建结果待核实，请查看工作区列表后再试。"); return; } if (models.code.view.currentSessionId) openSession(`code:${models.code.view.currentSessionId}`); }); }}><Plus /></IconButton></div><CollapsibleContent className="workspace-collapse" inert={!open && !query} aria-hidden={!open && !query}><div className="workspace-sessions">{models.code.sessionsFor(project.id).filter(session => !query || project.name.toLocaleLowerCase().includes(query) || models.code.sessionName(session.id).toLocaleLowerCase().includes(query)).map(session => <button key={session.id} className={`workspace-session ${target === "code" && session.id === current?.id ? "active-pill text-pri" : "text-sec hover-pill"}`} aria-current={target === "code" && session.id === current?.id ? "page" : undefined} onClick={() => openSession(`code:${session.id}`)}><span>{models.code.sessionName(session.id)}</span>{hasWork(session.id) && <i className="status-point pending" />}</button>)}</div></CollapsibleContent></section></Collapsible>;
      })}</div><div className="sidebar-bottom">{settings}</div></div><SidebarResizer side="left" open={sidebar} onWidthChange={width => setSidebarWidths(items => ({ ...items, left: width }))} /></aside>
    <div className="content-area"><header className="surface-sidebar canvas-header"><div className="session-header"><Tabs className="center-tabs" value={activeId} onValueChange={openSession}><TabsList aria-label="已打开的会话" {...tabOrder.list}>{openTabs.map(id => <div className="tab-group" key={id} {...tabOrder.group(id)}><TabsTrigger value={id} className="center-tab" {...tabOrder.trigger(id)}>{id === "personal" ? <Sparkles /> : hasWork(id.slice(5)) && <i className="status-point pending" />}<span>{tabTitle(id)}</span></TabsTrigger><button className="tab-close" aria-label={`关闭${tabTitle(id)}`} onClick={() => closeSession(id)}><X /></button></div>)}</TabsList></Tabs><span className="sr-only" role="status">{tabOrder.announcement}</span></div><div className={`inspector-header ${inspectorOpen ? "" : "is-collapsed"}`}><InspectorHeader model={model} open={inspectorOpen} /><IconButton label={inspectorOpen ? "收起右栏" : "展开右栏"} buttonRef={inspectorToggle} disabled={target === "code" && !current} onClick={toggleInspector}><PanelRight /></IconButton></div></header>
      <div className="content-body"><main className="surface-canvas main-canvas">{status.state !== "online" || !current ? <div className="empty-state"><div className="empty-symbol">{target === "personal" ? <Sparkles /> : <WifiOff />}</div><h1>{target === "personal" ? status.state === "online" ? "PA 主会话尚未就绪" : "连接你的个人 Agent" : status.state === "online" ? "你的工作区" : status.state === "connecting" ? "正在连接" : "暂时无法连接"}</h1><p>{target === "personal" ? status.error?.message ?? status.detail ?? "在设置中配置 PA 远程连接。" : status.state === "online" ? "从左侧选择工作区。" : status.error?.message ?? status.detail ?? "请确认本地后台已启动，然后重新连接。"}</p>{target === "personal" ? <><Button onClick={() => { setSettingsCategory("personal"); setSidebar(true); setSettingsOpen(true); }}>PA 远程连接</Button>{status.state !== "online" && <Button variant="ghost" disabled={status.state === "connecting"} onClick={() => void reconnect()}>重新连接</Button>}</> : status.state !== "online" && <Button disabled={status.state === "connecting"} onClick={() => void reconnect()}>重新连接</Button>}</div> : <><Conversation key={`conversation:${target}:${view.instanceId}:${current.id}`} model={model} sessionId={current.id} /><Composer key={`composer:${target}:${view.instanceId}:${current.id}`} model={model} session={current} /></>}</main>
      <InspectorPanel model={model} open={inspectorOpen} onWidthChange={width => setSidebarWidths(items => ({ ...items, right: width }))} />
    </div></div>
  </div>
  <Dialog open={dialog !== null} onOpenChange={open => { if (!open) setDialog(null); }}><DialogContent className="demo-dialog"><DialogHeader><DialogTitle>添加工作区</DialogTitle><DialogDescription>添加所选目录作为工作区。</DialogDescription></DialogHeader><Input aria-label="工作区目录" readOnly value={workspacePath} onClick={() => void pickWorkspace()} /><DialogFooter><Button variant="ghost" disabled={saving} onClick={() => setDialog(null)}>取消</Button><Button disabled={saving || !workspacePath} onClick={() => void saveDialog()}>添加</Button></DialogFooter></DialogContent></Dialog>
  {toast && <div className="surface-card toast-pill" role="status"><i className="status-point" />{toast}</div>}
  </>;
}
