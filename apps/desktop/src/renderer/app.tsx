import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Archive, MoreHorizontal, CalendarClock, FolderClosed, FolderOpen, FolderPlus, ListFilter, Loader2, MessagesCircle, PanelLeft, PanelRight, Search, Sparkles, SquarePen, WifiOff, X } from "lucide-react";
import type { DesktopTarget } from "../shared/bridge.ts";
import { SettingsDialog } from "./settings-dialog.tsx";
import { SettingsState } from "./settings-state.ts";
import { ConnectionLoading } from "./connection-loading.tsx";
import { reorderTab, useTabOrder } from "./tab-order.ts";
import { CodeState } from "./code-state.ts";
import { Conversation } from "./conversation.tsx";
import { Composer } from "./composer.tsx";
import { NewChatDraft, showsNewChat, type NewChatDraftState } from "./new-chat.tsx";
import { InspectorHeader, InspectorPanel } from "./inspector-panel.tsx";
import { SidebarResizer } from "./sidebar-resizer.tsx";
import { IconButton } from "./ui.tsx";
import { Button } from "./components/ui/button.tsx";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "./components/ui/dropdown-menu.tsx";
import { Input } from "./components/ui/input.tsx";
import { SearchDialog } from "./search-dialog.tsx";
import { isSearchShortcut } from "./search-state.ts";

// 无已选会话时主画布默认落在这份草稿上；显示期间的修改经 onChange 物化进 newChat 状态，常量本身不被改写。
const emptyDraft: NewChatDraftState & { returnTo: string } = { workspaceId: "", text: "", mode: "confirm", modelSelection: null, attachments: [], returnTo: "" };

// Note: 见 .agents/notes/implemented/architecture/2026-10-15-desktop-shadcn-demo.md
export function App() {
  const [startupVisible, setStartupVisible] = useState(true);
  const [, redraw] = useState(0);
  const [activeId, setActiveId] = useState("");
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const target: DesktopTarget = activeId === "personal" ? "personal" : "code";
  const [models] = useState(() => ({ code: new CodeState(window.ruukoto, () => redraw(value => value + 1)), personal: new CodeState(window.ruukoto, () => redraw(value => value + 1), "personal") }));
  const model = models[target];
  // Note: 见 .agents/notes/implemented/feature/2026-10-18-desktop-connection-loading.md
  const startupPending = models.code.status.state === "connecting" || (models.code.status.state === "online" && !models.code.view.instanceId);
  const [dark, setDark] = useState(true);
  const [sidebar, setSidebar] = useState(true);
  const [sidebarWidths, setSidebarWidths] = useState<{ left?: number; right?: number }>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const filterInput = useRef<HTMLInputElement>(null);
  const filterToggle = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (filterOpen) filterInput.current?.focus(); }, [filterOpen]);
  const [settings] = useState(() => new SettingsState(() => redraw(value => value + 1)));
  // 新对话先停在草稿页：选好工作区并发出首条消息后才真正建会话。
  const [newChat, setNewChat] = useState<(NewChatDraftState & { returnTo: string }) | null>(null);
  const [startingChat, setStartingChat] = useState(false);
  const [dialog, setDialog] = useState<"workspace" | null>(null);
  const [workspacePath, setWorkspacePath] = useState("");
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");
  const expandSidebar = useRef<HTMLButtonElement>(null);
  const inspectorToggle = useRef<HTMLButtonElement>(null);
  const { view, status } = model;
  const current = view.sessions.find(session => session.id === (target === "personal" ? view.mainSessionId : view.currentSessionId));
  const newChatOpen = showsNewChat(target, status.state === "online", !!current, !!newChat);
  const workspaces = models.code.view.projects.filter(project => project.rootDir !== null);
  const inspectorOpen = model.inspector.visible && (target === "personal" || !!current);
  useEffect(() => { document.documentElement.classList.toggle("dark", dark); }, [dark]);
  useEffect(() => {
    models.code.inspector.visible = window.innerWidth >= 1100;
    const unsubscribes = (["code", "personal"] as const).map(source => window.ruukoto.subscribe(source, update => { models[source].update(update); settings.observe(source, update); if (update.type === "navigate") { const id = source === "personal" ? "personal" : `code:${models.code.view.currentSessionId}`; if (source !== "personal") setOpenTabs(tabs => tabs.includes(id) ? tabs : [...tabs, id]); setActiveId(id); } }));
    return () => unsubscribes.forEach(unsubscribe => unsubscribe());
  }, [models, settings]);
  useEffect(() => {
    const messages = [model.readError, model.approvals.message, model.writes.message, model.questions.message, model.message].filter((message): message is string => !!message);
    if (messages.length) {
      setToast([...new Set(messages)].join(" · "));
      model.readError = null; model.approvals.message = null; model.writes.message = null; model.questions.message = null; model.message = null;
    }
  });
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (startupVisible) return;
      if (isSearchShortcut(event, !!document.querySelector('[data-slot="dialog-content"][data-state="open"]:not(.search-dialog)'), event.target instanceof Element && !!event.target.closest(".terminal-panel"))) { event.preventDefault(); if (!event.repeat && !models.code.search.composing) models.code.search.setOpen(!models.code.search.open); return; }
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.ctrlKey && !event.metaKey && (event.target instanceof Element && event.target.closest(".terminal-panel"))) return;
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
    const toggle = () => { setSidebar(value => !value); if (focusInside) window.requestAnimationFrame(() => expandSidebar.current?.focus()); };
    if (settings.open) settings.close(toggle); else toggle();
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
  // 草稿没选模型时沿用当前 Code 会话，没有会话则用后台默认模型；都无法确定才要求选择。
  function draftSelection(draft: NewChatDraftState) {
    return models.code.newChatSelection(draft.modelSelection);
  }
  async function startChat() {
    if (!newChat || startingChat) return;
    const draft = newChat;
    setStartingChat(true);
    try {
      const sessionId = await models.code.startChat({ workspaceId: draft.workspaceId, text: draft.text, attachments: draft.attachments, mode: draft.mode, modelSelection: draftSelection(draft) }, async (sessionId, tokens) => {
        const uploaded = await window.ruukoto.uploadDraftAttachments(sessionId, tokens);
        if (!uploaded.ok) throw new Error(uploaded.error.message);
        return uploaded.value;
      });
      // 创建期间草稿页可能已被收起；此时只切到新会话，不再改动草稿。
      if (sessionId) { setNewChat(null); setActiveId(`code:${sessionId}`); }
      else if (models.code.message) setToast(models.code.message);
    } finally { setStartingChat(false); }
  }
  function openSession(id: string) {
    setNewChat(null);
    const source = id === "personal" ? models.personal : models.code;
    if (id === "personal") { if (source.view.mainSessionId) source.openSession(source.view.mainSessionId); }
    else source.openSession(id.slice(5));
    // PA 是常驻视图，只切换目标，不新开标签。
    if (id !== "personal") setOpenTabs(tabs => tabs.includes(id) ? tabs : [...tabs, id]);
    setActiveId(id);
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
      const next = [...tabs.filter(id => codeTabs.includes(id)), ...codeTabs.filter(id => !tabs.includes(id))];
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
  const hasWork = (id: string) => !!models.code.view.activeTaskFor(id) || models.code.view.pendingApprovals().some(item => item.sessionId === id);
  const query = filter.toLocaleLowerCase();
  return <>{startupVisible && <ConnectionLoading pending={startupPending} onClosed={() => { setStartupVisible(false); window.requestAnimationFrame(() => { (document.querySelector<HTMLTextAreaElement>(".composer textarea") ?? expandSidebar.current)?.focus(); }); }} />}<div className="macos-window app-window native-window" inert={startupVisible} aria-busy={startupVisible} data-sidebar-open={sidebar} style={{ "--left-preferred-width": sidebarWidths.left === undefined ? undefined : `${sidebarWidths.left}px`, "--right-preferred-width": sidebarWidths.right === undefined ? undefined : `${sidebarWidths.right}px`, "--right-reserve": inspectorOpen ? "260px" : "0px", "--visible-left-width": sidebar ? "var(--left-width)" : "var(--sidebar-rail)" } as CSSProperties}>
    <Button type="button" variant="ghost" size="icon" className="quiet-icon sidebar-toggle search-toggle" aria-label="搜索 Code 工作区" title="搜索 (⌘K)" onClick={() => models.code.search.setOpen(true)}><Search /></Button><Button ref={expandSidebar} type="button" variant="ghost" size="icon" className="quiet-icon sidebar-toggle" aria-label={sidebar ? "收起侧栏" : "展开侧栏"} aria-controls="left-sidebar" aria-expanded={sidebar} onClick={toggleSidebar}><PanelLeft /></Button>
    <aside id="left-sidebar" className={`surface-sidebar left-sidebar ${sidebar ? "" : "is-collapsed"}`}><div className="sidebar-content"><div className="window-controls"><div className="traffic-space" aria-hidden="true" /></div>
      <Button type="button" variant="ghost" className={`personal-row ${target === "personal" ? "active-pill text-pri" : "text-sec"}`} aria-label="Ruukoto" onClick={() => openSession("personal")}><MessagesCircle /><span>Ruukoto</span></Button><Button type="button" variant="ghost" className="personal-row scheduled-row text-sec" aria-label="Scheduled" onClick={() => setToast("Scheduled 尚未开放")}><CalendarClock /><span>Scheduled</span></Button><Button type="button" variant="ghost" className={`personal-row new-chat-row ${newChatOpen ? "active-pill text-pri" : "text-sec"}`} aria-label="New chat" onClick={() => { if (newChatOpen) { if (newChat?.returnTo) { setActiveId(newChat.returnTo); setNewChat(null); } return; } const source = models.code.view.sessions.find(session => session.id === current?.id && target === "code"); setNewChat({ workspaceId: "", text: "", mode: source?.defaultAccessMode ?? "confirm", modelSelection: source?.modelSelection ?? null, attachments: [], returnTo: activeId }); setActiveId(""); }}><SquarePen /><span>New chat</span></Button><div className="projects-heading"><span>工作区</span><div><Button ref={filterToggle} type="button" variant="ghost" size="icon" className="quiet-icon" aria-label="筛选工作区与会话" aria-controls="workspace-filter" aria-expanded={filterOpen} onClick={() => { setFilterOpen(value => !value); setFilter(""); }}><ListFilter /></Button><IconButton label="添加工作区" disabled={picking || models.code.status.state !== "online" || !!models.code.pendingCreation} onClick={() => void pickWorkspace()}><FolderPlus /></IconButton></div></div>
      <div id="workspace-filter" className="workspace-filter" data-open={filterOpen} aria-hidden={!filterOpen} inert={!filterOpen}><div className="workspace-filter-clip"><div className="workspace-filter-inner"><Input ref={filterInput} aria-label="筛选工作区与会话" placeholder="筛选工作区与会话…" value={filter} onChange={event => setFilter(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { setFilterOpen(false); setFilter(""); filterToggle.current?.focus(); } }} /></div></div></div>
      <div className="workspace-tree">{workspaces.filter(project => !query || project.name.toLocaleLowerCase().includes(query) || models.code.sessionsFor(project.id).some(session => models.code.sessionName(session.id).toLocaleLowerCase().includes(query))).map(project => {
        const open = expanded[project.id] ?? true;
        // 创建进行中只把发起它的那行加号换成加载图标，其余行保持禁用。
        const creating = models.code.pendingCreation?.op === "create_session" && models.code.pendingCreation.params.project_id === project.id;
        return <Collapsible asChild key={project.id} open={open || !!query} onOpenChange={() => setExpanded(items => ({ ...items, [project.id]: !open }))}><section><div className="workspace-row"><CollapsibleTrigger asChild><button>{open || query ? <FolderOpen /> : <FolderClosed />}<span>{project.name}</span></button></CollapsibleTrigger><IconButton className="workspace-add" label={creating ? "正在新建会话" : `在 ${project.name} 新建会话`} disabled={models.code.status.state !== "online" || !!models.code.pendingCreation} onClick={() => { setExpanded(items => ({ ...items, [project.id]: true })); void models.code.create("create_session", { project_id: project.id, cwd: project.rootDir!.cwdReal }).then(created => { if (!created) { setToast(models.code.message ?? "创建结果待核实，请查看工作区列表后再试。"); return; } if (models.code.view.currentSessionId) openSession(`code:${models.code.view.currentSessionId}`); }); }}>{creating ? <Loader2 className="animate-spin" /> : <SquarePen />}</IconButton></div><CollapsibleContent className="workspace-collapse" inert={!open && !query} aria-hidden={!open && !query}><div className="workspace-sessions">{models.code.sessionsFor(project.id).filter(session => !query || project.name.toLocaleLowerCase().includes(query) || models.code.sessionName(session.id).toLocaleLowerCase().includes(query)).map(session => <div className={`workspace-session-row ${target === "code" && session.id === current?.id ? "is-active" : ""}`} key={session.id}><button className={`workspace-session ${target === "code" && session.id === current?.id ? "active-pill text-pri" : "text-sec hover-pill"}`} aria-current={target === "code" && session.id === current?.id ? "page" : undefined} onClick={() => openSession(`code:${session.id}`)}><span>{models.code.sessionName(session.id)}</span>{hasWork(session.id) && <i className="status-point pending" />}</button><DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="session-archive" aria-label={`会话菜单 ${models.code.sessionName(session.id)}`}><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuGroup><DropdownMenuItem aria-label={`存档 ${models.code.sessionName(session.id)}`} disabled={models.code.status.state !== "online" || models.code.writes.busy.has(session.id)} onSelect={() => void models.code.setArchived(session.id, true)}><Archive />存档会话</DropdownMenuItem></DropdownMenuGroup></DropdownMenuContent></DropdownMenu></div>)}</div></CollapsibleContent></section></Collapsible>;
      })}</div><div className="sidebar-bottom"><SettingsDialog settings={settings} code={models.code} personal={models.personal} dark={dark} onDark={setDark} defaultTarget={target} onAddWorkspace={() => settings.close(() => { void pickWorkspace(); })} onCloseAutoFocus={event => { if (!sidebar) { event.preventDefault(); expandSidebar.current?.focus(); } }} /></div></div><SidebarResizer side="left" open={sidebar} onWidthChange={width => setSidebarWidths(items => ({ ...items, left: width }))} /></aside>
    <div className="content-area"><header className="surface-sidebar canvas-header"><div className="session-header"><Tabs className="center-tabs" value={activeId} onValueChange={openSession}><TabsList aria-label="已打开的会话" {...tabOrder.list}>{openTabs.map(id => <div className="tab-group" key={id} {...tabOrder.group(id)}><TabsTrigger value={id} className="center-tab" {...tabOrder.trigger(id)}>{id === "personal" ? <Sparkles /> : hasWork(id.slice(5)) && <i className="status-point pending" />}<span>{tabTitle(id)}</span>{id !== "personal" && models.code.view.sessions.find(session => session.id === id.slice(5))?.archivedAt && <Archive aria-label="已存档" />}</TabsTrigger><button className="tab-close" aria-label={`关闭${tabTitle(id)}`} onClick={() => closeSession(id)}><X /></button></div>)}</TabsList></Tabs><span className="sr-only" role="status">{tabOrder.announcement}</span></div><div className={`inspector-header ${inspectorOpen ? "" : "is-collapsed"}`}><InspectorHeader model={model} open={inspectorOpen} /><IconButton label={inspectorOpen ? "收起右栏" : "展开右栏"} buttonRef={inspectorToggle} disabled={target === "code" && !current} onClick={toggleInspector}><PanelRight /></IconButton></div></header>
      <div className="content-body"><main className="surface-canvas main-canvas">{newChatOpen ? <NewChatDraft model={models.code} workspaces={workspaces} value={newChat ?? emptyDraft} fallbackSelection={draftSelection(newChat ?? emptyDraft)} onAddWorkspace={() => void pickWorkspace()} onChange={value => setNewChat(current => ({ ...value, returnTo: current?.returnTo ?? "" }))} onSend={() => void startChat()} starting={startingChat} blocked={!!models.code.pendingCreation} /> : status.state !== "online" || !current ? <div className="empty-state"><div className="empty-symbol">{target === "personal" ? <Sparkles /> : <WifiOff />}</div><h1>{target === "personal" ? status.state === "online" ? "PA 主会话尚未就绪" : "连接你的个人 Agent" : status.state === "connecting" ? "正在连接" : "暂时无法连接"}</h1><p>{target === "personal" ? status.error?.message ?? status.detail ?? "在设置中配置 PA 远程连接。" : status.error?.message ?? status.detail ?? "请确认本地后台已启动，然后重新连接。"}</p>{target === "personal" ? <><Button onClick={() => { setSidebar(true); settings.show(target, models.code, "personal"); }}>PA 远程连接</Button>{status.state !== "online" && <Button variant="ghost" disabled={status.state === "connecting"} onClick={() => void reconnect()}>重新连接</Button>}</> : <Button disabled={status.state === "connecting"} onClick={() => void reconnect()}>重新连接</Button>}</div> : <><Conversation key={`conversation:${target}:${view.instanceId}:${current.id}`} model={model} sessionId={current.id} /><Composer key={`composer:${target}:${view.instanceId}:${current.id}`} model={model} session={current} /></>}</main>
      <InspectorPanel model={model} terminalModel={models.code} open={inspectorOpen} onWidthChange={width => setSidebarWidths(items => ({ ...items, right: width }))} />
    </div></div>
  </div>
  {models.code.inspector.terminalStopFailures.size > 0 && <div className="terminal-stop-failures" role="alert">{[...models.code.inspector.terminalStopFailures].map(([id, failure]) => <div key={id}><p>{failure.message}</p><Button variant="outline" size="sm" disabled={failure.retrying} onClick={() => models.code.inspector.retryTerminalStop(id)}>{failure.retrying ? "正在回收…" : "重试回收终端"}</Button></div>)}</div>}
  <Dialog open={dialog !== null} onOpenChange={open => { if (!open) setDialog(null); }}><DialogContent className="demo-dialog"><DialogHeader><DialogTitle>添加工作区</DialogTitle><DialogDescription>添加所选目录作为工作区。</DialogDescription></DialogHeader><Input aria-label="工作区目录" readOnly value={workspacePath} onClick={() => void pickWorkspace()} /><DialogFooter><Button variant="ghost" disabled={saving} onClick={() => setDialog(null)}>取消</Button><Button disabled={saving || !workspacePath} onClick={() => void saveDialog()}>添加</Button></DialogFooter></DialogContent></Dialog>
  <SearchDialog model={models.code} onOpenSession={sessionId => openSession(`code:${sessionId}`)} />
  {toast && <div className="surface-card toast-pill" role="status"><i className="status-point" />{toast}</div>}
  </>;
}
