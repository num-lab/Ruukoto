import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Archive, MoreHorizontal, CalendarClock, FolderClosed, FolderOpen, FolderPlus, Info, ListFilter, Loader2, MessageCircle, MessagesCircle, PanelLeft, PanelRight, Search, Sparkles, SquarePen, WifiOff, X } from "lucide-react";
import type { DesktopTarget } from "../shared/bridge.ts";
import { SettingsDialog } from "./settings-dialog.tsx";
import { SettingsState } from "./settings-state.ts";
import { ConnectionLoading } from "./connection-loading.tsx";
import { reorderTab, useTabOrder } from "./tab-order.ts";
import { CodeState } from "./code-state.ts";
import { PersonalState } from "./personal-state.ts";
import { PersonalChat } from "./personal-chat.tsx";
import { Conversation } from "./conversation.tsx";
import { Scheduled } from "./scheduled.tsx";
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

// The empty canvas stays local; the first edit materializes its draft.
const emptyDraft: NewChatDraftState & { returnTo: string } = { workspaceId: "", text: "", mode: "confirm", modelSelection: null, attachments: [], returnTo: "" };

// Note: See .agents/notes/implemented/architecture/2026-10-15-desktop-shadcn-demo.md
export function App() {
  const [startupVisible, setStartupVisible] = useState(true);
  const [, redraw] = useState(0);
  const [activeId, setActiveId] = useState("");
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const target: DesktopTarget = activeId === "personal" ? "personal" : "code";
  const [models] = useState(() => ({ code: new CodeState(window.ruukoto, () => redraw(value => value + 1)), personal: new PersonalState(window.ruukoto, () => redraw(value => value + 1)) }));
  const model = models.code;
  // Note: See .agents/notes/implemented/feature/2026-10-18-desktop-connection-loading.md
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
  // A new chat acquires its workspace only on first send.
  const [scheduledOpen, setScheduledOpen] = useState(false);
  const [newChat, setNewChat] = useState<(NewChatDraftState & { returnTo: string }) | null>(null);
  const activeChatDraft = useRef(newChat);
  activeChatDraft.current = newChat;
  const [startingChat, setStartingChat] = useState(false);
  const [dialog, setDialog] = useState<"workspace" | null>(null);
  const [workspacePath, setWorkspacePath] = useState("");
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");
  const expandSidebar = useRef<HTMLButtonElement>(null);
  const inspectorToggle = useRef<HTMLButtonElement>(null);
  const { view } = model;
  const status = target === "personal" ? models.personal.status : model.status;
  const current = view.sessions.find(session => session.id === view.currentSessionId);
  const newChatOpen = !scheduledOpen && showsNewChat(target, status.state === "online", !!current, !!newChat);
  const workspaces = models.code.view.projects.filter(project => project.rootDir !== null && !project.managed);
  const inspectorOpen = !scheduledOpen && target === "code" && model.inspector.visible && !!current;
  useEffect(() => {
    if (target === "code" && !newChat && !scheduledOpen && current) setActiveId(`code:${current.id}`);
  }, [target, newChat, scheduledOpen, current?.id]);
  useEffect(() => { document.documentElement.classList.toggle("dark", dark); }, [dark]);
  useEffect(() => {
    models.personal.start();
    const unsubscribes = (["code", "personal"] as const).map(source => window.ruukoto.subscribe(source, update => { models[source].update(update); settings.observe(source, update); if (update.type === "navigate") { activeChatDraft.current = null; setNewChat(null); setScheduledOpen(false); const id = source === "personal" ? "personal" : `code:${models.code.view.currentSessionId}`; if (source !== "personal") setOpenTabs(tabs => tabs.includes(id) ? tabs : [...tabs, id]); setActiveId(id); } }));
    return () => { unsubscribes.forEach(unsubscribe => unsubscribe()); models.personal.dispose(); };
  }, [models, settings]);
  useEffect(() => {
    const recovered = models.code.recoveredChats.find(draft => !models.code.writes.checking(draft.sessionId ?? "") && !models.code.view.sessions.some(session => session.id === draft.sessionId && session.archivedAt));
    if (!recovered || newChat || startingChat || activeId || scheduledOpen) return;
    if (models.code.resumePreparedChat(recovered)) { setActiveId(`code:${recovered.sessionId}`); return; }
    setNewChat({ requestId: recovered.requestId, workspaceId: recovered.workspaceId, text: recovered.text, mode: recovered.mode, modelSelection: recovered.modelSelection, attachments: recovered.attachments, attempted: true, returnTo: "" });
  });
  useEffect(() => {
    const messages = [model.readError, model.approvals.message, model.writes.message, model.questions.message, model.message, models.personal.message].filter((message): message is string => !!message);
    if (messages.length) {
      setToast([...new Set(messages)].join(" · "));
      model.readError = null; model.approvals.message = null; model.writes.message = null; model.questions.message = null; model.message = null; models.personal.message = null;
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
  // Note: See .agents/notes/implemented/bug-fix/2026-10-17-desktop-sidebar-toggle.md
  function toggleSidebar() {
    const focusInside = document.activeElement?.closest(".left-sidebar, .settings-dialog");
    const toggle = () => { setSidebar(value => !value); if (focusInside) window.requestAnimationFrame(() => expandSidebar.current?.focus()); };
    if (settings.open) settings.close(toggle); else toggle();
  }
  function toggleInspector() {
    if (target === "personal") return;
    if (document.activeElement?.closest(".right-sidebar, .right-header")) inspectorToggle.current?.focus();
    model.inspector.visible = !model.inspector.visible;
    model.refresh();
  }
  async function reconnect() {
    try {
      const result = await window.ruukoto.request(target, "reconnect", {});
      if (!result.ok) models[target].update({ type: "state", state: "failed", error: result.error });
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
  // An unselected model follows the current Code conversation, then the backend default.
  function draftSelection(draft: NewChatDraftState) {
    return models.code.newChatSelection(draft.modelSelection);
  }
  async function startChat(input?: string) {
    if (!newChat || startingChat) return;
    const draft = { ...newChat, text: input ?? newChat.text, requestId: newChat.requestId ?? crypto.randomUUID(), modelSelection: draftSelection(newChat), attempted: true };
    activeChatDraft.current = draft;
    setNewChat(draft);
    setStartingChat(true);
    try {
      const sessionId = await models.code.startChat(draft, async (sessionId, tokens) => {
        const uploaded = await window.ruukoto.uploadDraftAttachments(sessionId, tokens);
        if (!uploaded.ok) throw new Error(uploaded.error.message);
        return uploaded.value;
      }, () => activeChatDraft.current?.requestId === draft.requestId);
      // A later draft or navigation owns the canvas after the original send started.
      if (sessionId) { if (activeChatDraft.current?.requestId === draft.requestId) { setNewChat(null); setActiveId(`code:${sessionId}`); } }
      else {
        if (models.code.chatNotCreated) setNewChat(current => current?.requestId === draft.requestId ? { ...current, attempted: false } : current);
        if (models.code.message) setToast(models.code.message);
      }
    } finally { setStartingChat(false); }
  }
  function restoreChat(draft: typeof models.code.recoveredChats[number]) {
    setScheduledOpen(false);
    if (models.code.resumePreparedChat(draft)) { activeChatDraft.current = null; setNewChat(null); setActiveId(`code:${draft.sessionId}`); return; }
    const restored = { requestId: draft.requestId, workspaceId: draft.workspaceId, text: draft.text, mode: draft.mode, modelSelection: draft.modelSelection, attachments: draft.attachments, attempted: true, returnTo: activeId };
    activeChatDraft.current = restored;
    setNewChat(restored);
    setActiveId("");
  }
  function beginChat() {
    setScheduledOpen(false);
    const source = models.code.view.sessions.find(session => session.id === current?.id && target === "code");
    const draft = { requestId: crypto.randomUUID(), workspaceId: "", text: "", mode: source?.defaultAccessMode ?? "confirm", modelSelection: source?.modelSelection ?? null, attachments: [], returnTo: activeId };
    activeChatDraft.current = draft;
    setNewChat(draft);
    setActiveId("");
  }
  function openSession(id: string) {
    setScheduledOpen(false);
    activeChatDraft.current = null;
    setNewChat(null);
    if (id !== "personal") models.code.openSession(id.slice(5));
    else models.personal.visible();
    // Personal keeps one persistent view when switching targets.
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
  const query = filter.toLocaleLowerCase();
  const sessionRow = (session: typeof view.sessions[number]) => <div className={`workspace-session-row ${target === "code" && session.id === current?.id ? "is-active" : ""}`} key={session.id}><button className={`workspace-session ${target === "code" && session.id === current?.id ? "active-pill text-pri" : "text-sec hover-pill"}`} aria-current={target === "code" && session.id === current?.id ? "page" : undefined} onClick={() => openSession(`code:${session.id}`)}><span>{models.code.sessionName(session.id)}</span>{models.code.sessionNeedsDecision(session.id) && <Info className="session-pending" aria-label="有待决定事项" />}</button><DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="session-archive" aria-label={`会话菜单 ${models.code.sessionName(session.id)}`}><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuGroup>{models.code.recoveredChats.some(draft => draft.sessionId === session.id) && <DropdownMenuItem onSelect={() => { void models.code.pendingChat(session.id).then(draft => { if (draft) restoreChat(draft); }); }}><SquarePen />恢复首条消息</DropdownMenuItem>}<DropdownMenuItem aria-label={`打开文件夹 ${models.code.sessionName(session.id)}`} onSelect={() => void models.code.revealWorkspace(session.workspaceProjectId ?? session.projectId)}><FolderOpen />打开文件夹</DropdownMenuItem><DropdownMenuItem aria-label={`存档 ${models.code.sessionName(session.id)}`} disabled={models.code.status.state !== "online" || models.code.writes.busy.has(session.id)} onSelect={() => void models.code.setArchived(session.id, true)}><Archive />存档会话</DropdownMenuItem></DropdownMenuGroup></DropdownMenuContent></DropdownMenu></div>;
  const managedSessions = models.code.managedSessions().filter(session => !query || "no workspace".includes(query) || models.code.sessionName(session.id).toLocaleLowerCase().includes(query));
  return <>{startupVisible && <ConnectionLoading pending={startupPending} onClosed={() => { setStartupVisible(false); window.requestAnimationFrame(() => { (document.querySelector<HTMLTextAreaElement>(".composer textarea") ?? expandSidebar.current)?.focus(); }); }} />}<div className="macos-window app-window native-window" inert={startupVisible} aria-busy={startupVisible} data-sidebar-open={sidebar} style={{ "--left-preferred-width": sidebarWidths.left === undefined ? undefined : `${sidebarWidths.left}px`, "--right-preferred-width": sidebarWidths.right === undefined ? undefined : `${sidebarWidths.right}px`, "--right-reserve": inspectorOpen ? "260px" : "0px", "--visible-left-width": sidebar ? "var(--left-width)" : "var(--sidebar-rail)" } as CSSProperties}>
    <aside id="left-sidebar" className={`surface-sidebar left-sidebar ${sidebar ? "" : "is-collapsed"}`}><div className="sidebar-content"><div className="window-controls"><div className="traffic-space" aria-hidden="true" /></div>
      <Button type="button" variant="ghost" className={`personal-row ${target === "personal" ? "active-pill text-pri" : "text-sec"}`} aria-label="Ruukoto" onClick={() => openSession("personal")}><MessagesCircle /><span>Ruukoto</span></Button><Button type="button" variant="ghost" className={`personal-row scheduled-row ${scheduledOpen ? "active-pill text-pri" : "text-sec"}`} aria-label="Scheduled" onClick={() => { activeChatDraft.current = null; setScheduledOpen(true); setNewChat(null); setActiveId(""); }}><CalendarClock /><span>Scheduled</span></Button><Button type="button" variant="ghost" className={`personal-row new-chat-row ${newChatOpen ? "active-pill text-pri" : "text-sec"}`} aria-label="New chat" onClick={() => { if (newChatOpen && !newChat?.attempted) { if (newChat?.returnTo) { activeChatDraft.current = null; setActiveId(newChat.returnTo); setNewChat(null); } return; } beginChat(); }}><SquarePen /><span>New chat</span></Button><Button type="button" variant="ghost" className="personal-row search-row text-pri" aria-label="搜索 Code 工作区" title="搜索 (⌘K)" onClick={() => models.code.search.setOpen(true)}><Search /><span>Search</span></Button><div className="projects-heading"><span>工作区</span><div><Button ref={filterToggle} type="button" variant="ghost" size="icon" className="quiet-icon" aria-label="筛选工作区与会话" aria-controls="workspace-filter" aria-expanded={filterOpen} onClick={() => { setFilterOpen(value => !value); setFilter(""); }}><ListFilter /></Button><IconButton label="添加工作区" disabled={picking || models.code.status.state !== "online" || !!models.code.pendingCreation} onClick={() => void pickWorkspace()}><FolderPlus /></IconButton></div></div>
      <div id="workspace-filter" className="workspace-filter" data-open={filterOpen} aria-hidden={!filterOpen} inert={!filterOpen}><div className="workspace-filter-clip"><div className="workspace-filter-inner"><Input ref={filterInput} aria-label="筛选工作区与会话" placeholder="筛选工作区与会话…" value={filter} onChange={event => setFilter(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { setFilterOpen(false); setFilter(""); filterToggle.current?.focus(); } }} /></div></div></div>
      <div className="workspace-tree">{models.code.recoveredChats.filter(draft => !draft.sessionId).map(draft => <Button variant="ghost" key={draft.requestId} className="workspace-session" onClick={() => restoreChat(draft)}><SquarePen /><span>恢复首条消息</span></Button>)}{workspaces.filter(project => !query || project.name.toLocaleLowerCase().includes(query) || models.code.sessionsFor(project.id).some(session => models.code.sessionName(session.id).toLocaleLowerCase().includes(query))).map(project => {
        const open = expanded[project.id] ?? true;
        // Only the initiating row displays the creation spinner.
        const creating = models.code.pendingCreation?.op === "create_session" && models.code.pendingCreation.params.project_id === project.id;
        return <Collapsible asChild key={project.id} open={open || !!query} onOpenChange={() => setExpanded(items => ({ ...items, [project.id]: !open }))}><section><div className="workspace-row"><CollapsibleTrigger asChild><button>{open || query ? <FolderOpen /> : <FolderClosed />}<span>{project.name}</span></button></CollapsibleTrigger><IconButton className="workspace-add" label={creating ? "正在新建会话" : `在 ${project.name} 新建会话`} disabled={models.code.status.state !== "online" || !!models.code.pendingCreation} onClick={() => { setExpanded(items => ({ ...items, [project.id]: true })); void models.code.create("create_session", { project_id: project.id, cwd: project.rootDir!.cwdReal }).then(created => { if (!created) { setToast(models.code.message ?? "创建结果待核实，请查看工作区列表后再试。"); return; } if (models.code.view.currentSessionId) openSession(`code:${models.code.view.currentSessionId}`); }); }}>{creating ? <Loader2 className="animate-spin" /> : <SquarePen />}</IconButton></div><CollapsibleContent className="workspace-collapse" inert={!open && !query} aria-hidden={!open && !query}><div className="workspace-sessions">{models.code.sessionsFor(project.id).filter(session => !query || project.name.toLocaleLowerCase().includes(query) || models.code.sessionName(session.id).toLocaleLowerCase().includes(query)).map(sessionRow)}</div></CollapsibleContent></section></Collapsible>;
      })}{managedSessions.length > 0 && <Collapsible asChild open={(expanded["$managed"] ?? true) || !!query} onOpenChange={open => setExpanded(items => ({ ...items, "$managed": open }))}><section><div className="workspace-row"><CollapsibleTrigger asChild><button>{(expanded["$managed"] ?? true) || query ? <FolderOpen /> : <FolderClosed />}<span>No workspace</span></button></CollapsibleTrigger><IconButton className="workspace-add" label="New chat without workspace" onClick={beginChat}><SquarePen /></IconButton></div><CollapsibleContent className="workspace-collapse"><div className="workspace-sessions">{managedSessions.map(sessionRow)}</div></CollapsibleContent></section></Collapsible>}</div><div className="sidebar-bottom"><SettingsDialog settings={settings} code={models.code} personal={models.personal} dark={dark} onDark={setDark} defaultTarget={target} onCloseAutoFocus={event => { if (!sidebar) { event.preventDefault(); expandSidebar.current?.focus(); } }} /></div></div><SidebarResizer side="left" open={sidebar} onWidthChange={width => setSidebarWidths(items => ({ ...items, left: width }))} /></aside>
    <div className="content-area"><header className="surface-sidebar canvas-header"><div className="session-header"><Tabs className="center-tabs" value={activeId} onValueChange={openSession}><TabsList aria-label="已打开的会话" {...tabOrder.list}>{openTabs.map(id => <div className="tab-group" key={id} {...tabOrder.group(id)}><TabsTrigger value={id} className="center-tab" {...tabOrder.trigger(id)}><span className="tab-leading-icon-wrap">{id === "personal" ? <Sparkles className="tab-leading-icon" aria-hidden="true" /> : <MessageCircle className="tab-leading-icon" aria-hidden="true" />}{id !== "personal" && models.code.sessionNeedsDecision(id.slice(5)) && <i className="status-point pending tab-pending-dot" />}</span><span>{tabTitle(id)}</span>{id !== "personal" && models.code.view.sessions.find(session => session.id === id.slice(5))?.archivedAt && <Archive aria-label="已存档" />}</TabsTrigger><button className="tab-close" aria-label={`关闭${tabTitle(id)}`} onClick={() => closeSession(id)}><X /></button></div>)}</TabsList></Tabs><span className="sr-only" role="status">{tabOrder.announcement}</span></div><div className={`inspector-header ${inspectorOpen ? "" : "is-collapsed"}`}>{target === "code" && !scheduledOpen && <><InspectorHeader model={model} open={inspectorOpen} /><IconButton className="inspector-toggle" label={inspectorOpen ? "收起右栏" : "展开右栏"} buttonRef={inspectorToggle} disabled={!current} onClick={toggleInspector}><PanelRight /></IconButton></>}</div></header>
      <div className="content-body"><main className="surface-canvas main-canvas">{scheduledOpen ? <Scheduled model={models.code} onOpenSession={id => openSession(`code:${id}`)} /> : target === "personal" ? <PersonalChat model={models.personal} onConnect={() => { setSidebar(true); settings.show("personal", "personal"); }} /> : newChatOpen ? <NewChatDraft model={models.code} workspaces={workspaces} value={newChat ?? emptyDraft} fallbackSelection={draftSelection(newChat ?? emptyDraft)} onAddWorkspace={() => void pickWorkspace()} onChange={value => setNewChat(current => ({ ...value, returnTo: current?.returnTo ?? "" }))} onSend={input => void startChat(input)} onSkills={() => settings.show("code", "code-skills")} starting={startingChat} blocked={!!models.code.pendingCreation} /> : !current ? <div className="empty-state"><div className="empty-symbol"><WifiOff /></div><h1>{status.state === "connecting" ? "正在连接" : "暂时无法连接"}</h1><p>{status.error?.message ?? status.detail ?? "请确认本地后台已启动，然后重新连接。"}</p><Button disabled={status.state === "connecting"} onClick={() => void reconnect()}>重新连接</Button></div> : <>{status.state !== "online" && <div className="task-notice" role="status"><span>{status.error?.message ?? status.detail ?? "Code 连接已断开；输入仍保留。"}</span><Button variant="ghost" size="sm" disabled={status.state === "connecting"} onClick={() => void reconnect()}>重新连接</Button></div>}<Conversation key={`conversation:code:${view.instanceId}:${current.id}`} model={model} sessionId={current.id} /><Composer key={`composer:code:${view.instanceId}:${current.id}`} model={model} session={current} onNew={beginChat} onSkills={() => settings.show("code", "code-skills")} /></>}</main>
      <InspectorPanel model={model} terminalModel={models.code} open={inspectorOpen} onWidthChange={width => setSidebarWidths(items => ({ ...items, right: width }))} />
    </div></div>
    <Button ref={expandSidebar} type="button" variant="ghost" size="icon" className="quiet-icon sidebar-toggle" aria-label={sidebar ? "收起侧栏" : "展开侧栏"} aria-controls="left-sidebar" aria-expanded={sidebar} onClick={toggleSidebar}><PanelLeft /></Button>
  </div>
  {models.code.inspector.terminalStopFailures.size > 0 && <div className="terminal-stop-failures" role="alert">{[...models.code.inspector.terminalStopFailures].map(([id, failure]) => <div key={id}><p>{failure.message}</p><Button variant="outline" size="sm" disabled={failure.retrying} onClick={() => models.code.inspector.retryTerminalStop(id)}>{failure.retrying ? "正在回收…" : "重试回收终端"}</Button></div>)}</div>}
  <Dialog open={dialog !== null} onOpenChange={open => { if (!open) setDialog(null); }}><DialogContent className="demo-dialog"><DialogHeader><DialogTitle>添加工作区</DialogTitle><DialogDescription>添加所选目录作为工作区。</DialogDescription></DialogHeader><Input aria-label="工作区目录" readOnly value={workspacePath} onClick={() => void pickWorkspace()} /><DialogFooter><Button variant="ghost" disabled={saving} onClick={() => setDialog(null)}>取消</Button><Button disabled={saving || !workspacePath} onClick={() => void saveDialog()}>添加</Button></DialogFooter></DialogContent></Dialog>
  <SearchDialog model={models.code} onOpenSession={sessionId => openSession(`code:${sessionId}`)} />
  {toast && <div className="surface-card toast-pill" role="status"><i className="status-point" />{toast}</div>}
  </>;
}
