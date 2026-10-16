import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronRight, Folder, ListFilter, Moon, PanelLeft, PanelRight, Plus, Settings2, Sun, Terminal, WifiOff, X } from "lucide-react";
import type { DesktopTarget } from "../shared/bridge.ts";
import type { PersonalTargetConfig } from "../main/personal-config.ts";
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
import { Input } from "./components/ui/input.tsx";

// Note: 见 .agents/notes/implemented/architecture/2026-10-15-desktop-shadcn-demo.md
export function App() {
  const [, redraw] = useState(0);
  const [target, setTarget] = useState<DesktopTarget>("code");
  const [models] = useState(() => ({ code: new CodeState(window.ruukoto, () => redraw(value => value + 1)), personal: new CodeState(window.ruukoto, () => redraw(value => value + 1), "personal") }));
  const model = models[target];
  const [dark, setDark] = useState(true);
  const [sidebar, setSidebar] = useState(true);
  const [sidebarWidths, setSidebarWidths] = useState<{ left?: number; right?: number }>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dialog, setDialog] = useState<"workspace" | "personal" | null>(null);
  const [workspacePath, setWorkspacePath] = useState("");
  const [picking, setPicking] = useState(false);
  const [personalConfig, setPersonalConfig] = useState<PersonalTargetConfig | null>(null);
  const [host, setHost] = useState("");
  const [configReady, setConfigReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");
  const expandSidebar = useRef<HTMLButtonElement>(null);
  const inspectorToggle = useRef<HTMLButtonElement>(null);
  const { view, status } = model;
  const current = view.sessions.find(session => session.id === view.currentSessionId);
  const workspaces = (target === "code" ? view.projects : []).filter(project => project.rootDir !== null);
  const inspectorOpen = model.inspector.visible && target === "code" && !!current;
  useEffect(() => { document.documentElement.classList.toggle("dark", dark); }, [dark]);
  useEffect(() => {
    models.code.inspector.visible = window.innerWidth >= 1100;
    const unsubscribes = (["code", "personal"] as const).map(source => window.ruukoto.subscribe(source, update => { models[source].update(update); if (update.type === "navigate") setTarget(source); }));
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
  async function openPersonal() {
    setDialog("personal"); setConfigReady(false);
    try {
      const result = await window.ruukoto.request("personal", "desktop_personal_config_read", {});
      if (!result.ok) { setToast(result.error.message); return; }
      const config = result.value as PersonalTargetConfig | null;
      setPersonalConfig(config); setHost(config?.host ?? "tx"); setConfigReady(true);
    } catch { setToast("无法读取连接配置，请重新打开配置窗口后重试。"); }
  }
  async function saveDialog() {
    setSaving(true);
    try {
      if (dialog === "workspace") {
        await model.create("open_workspace", { cwd: workspacePath });
        setDialog(null);
      } else {
        const result = await window.ruukoto.request("personal", "desktop_personal_config_save", { host: host.trim(), ...(personalConfig ? { controlDir: personalConfig.controlDir } : {}) });
        if (!result.ok) { setToast(result.error.message); return; }
        setDialog(null);
      }
    } catch { setToast("连接配置结果待核实，请重新打开配置窗口读取实际值。"); }
    finally { setSaving(false); }
  }
  const settings = <Dialog open={sidebar && settingsOpen} onOpenChange={setSettingsOpen}>
    <DialogTrigger asChild><Button type="button" variant="ghost" size="icon" className="quiet-icon" aria-label="设置"><Settings2 /></Button></DialogTrigger>
    <DialogContent className="settings-dialog" onCloseAutoFocus={event => { if (!sidebar) { event.preventDefault(); expandSidebar.current?.focus(); } }}>
      <DialogDescription className="sr-only">选择左侧类别查看设置项。</DialogDescription>
      <Tabs defaultValue="appearance" orientation="vertical" className="settings-tabs"><div className="settings-navigation"><DialogTitle>设置</DialogTitle><TabsList className="settings-categories" aria-label="设置类别"><TabsTrigger value="appearance">{dark ? <Moon /> : <Sun />}外观</TabsTrigger><TabsTrigger value="target"><Terminal />运行目标</TabsTrigger></TabsList></div>
        <TabsContent value="appearance" className="settings-panel"><h2>外观</h2><div className="settings-row"><label htmlFor="settings-theme">主题</label><Select value={dark ? "dark" : "light"} onValueChange={value => setDark(value === "dark")}><SelectTrigger id="settings-theme" aria-label="主题"><SelectValue /></SelectTrigger><SelectContent position="popper" align="end" sideOffset={6}><SelectItem value="light">浅色</SelectItem><SelectItem value="dark">深色</SelectItem></SelectContent></Select></div></TabsContent>
        <TabsContent value="target" className="settings-panel"><h2>运行目标</h2><div className="settings-row"><label htmlFor="settings-target">目标</label><Select value={target} onValueChange={value => { if (value === "code" || value === "personal") setTarget(value); }}><SelectTrigger id="settings-target" aria-label="运行目标"><SelectValue /></SelectTrigger><SelectContent position="popper" align="end" sideOffset={6}><SelectItem value="code">Code</SelectItem><SelectItem value="personal">Personal</SelectItem></SelectContent></Select></div></TabsContent>
      </Tabs>
    </DialogContent>
  </Dialog>;
  const hasWork = (id: string) => !!view.activeTaskFor(id) || view.pendingApprovals().some(item => item.sessionId === id);
  const query = filter.toLocaleLowerCase();
  return <><div className="macos-window app-window native-window" style={{ "--left-preferred-width": sidebarWidths.left === undefined ? undefined : `${sidebarWidths.left}px`, "--right-preferred-width": sidebarWidths.right === undefined ? undefined : `${sidebarWidths.right}px`, "--right-reserve": inspectorOpen ? "260px" : "0px", "--visible-left-width": sidebar ? "var(--left-width)" : "0px" } as CSSProperties}>
    <aside id="left-sidebar" className={`surface-sidebar left-sidebar ${sidebar ? "" : "is-collapsed"}`} aria-label="工作区导航" aria-hidden={!sidebar} inert={!sidebar}><div className="sidebar-content"><div className="window-controls"><div className="traffic-space" aria-hidden="true" /><IconButton label="收起侧栏" onClick={toggleSidebar}><PanelLeft /></IconButton></div>
      <div className="projects-heading"><span>{target === "code" ? "工作区" : "Personal"}</span><div><IconButton label="筛选工作区与会话" disabled={target !== "code"} onClick={() => { setFilterOpen(value => !value); setFilter(""); }}><ListFilter /></IconButton><IconButton label="添加工作区" disabled={target !== "code" || picking || status.state !== "online" || !!model.pendingCreation} onClick={() => void pickWorkspace()}><Plus /></IconButton></div></div>
      {filterOpen && target === "code" && <div className="workspace-filter"><Input aria-label="筛选工作区与会话" autoFocus placeholder="筛选工作区与会话…" value={filter} onChange={event => setFilter(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { setFilterOpen(false); setFilter(""); } }} /></div>}
      <div className="workspace-tree">{target === "code" ? workspaces.filter(project => !query || project.name.toLocaleLowerCase().includes(query) || model.sessionsFor(project.id).some(session => model.sessionName(session.id).toLocaleLowerCase().includes(query))).map(project => {
        const open = expanded[project.id] ?? true;
        return <section key={project.id}><div className="workspace-row"><button onClick={() => setExpanded(items => ({ ...items, [project.id]: !open }))} aria-expanded={open || !!query}><ChevronRight className={open || query ? "rotate-90" : ""} /><Folder /><span>{project.name}</span></button><IconButton className="workspace-add" label={`在 ${project.name} 新建会话`} disabled={status.state !== "online" || !!model.pendingCreation} onClick={() => { setExpanded(items => ({ ...items, [project.id]: true })); void model.create("create_session", { project_id: project.id, cwd: project.rootDir!.cwdReal }); }}><Plus /></IconButton></div>{(open || query) && <div className="workspace-sessions">{model.sessionsFor(project.id).filter(session => !query || project.name.toLocaleLowerCase().includes(query) || model.sessionName(session.id).toLocaleLowerCase().includes(query)).map(session => <button key={session.id} className={`workspace-session ${session.id === current?.id ? "active-pill text-pri" : "text-sec hover-pill"}`} aria-current={session.id === current?.id ? "page" : undefined} onClick={() => model.openSession(session.id)}><span>{model.sessionName(session.id)}</span>{hasWork(session.id) && <i className="status-point pending" />}</button>)}</div>}</section>;
      }) : <Button variant="ghost" className="personal-row" onClick={() => void openPersonal()}><Terminal />配置 SSH 连接</Button>}</div><div className="sidebar-bottom">{settings}</div></div><SidebarResizer side="left" open={sidebar} onWidthChange={width => setSidebarWidths(items => ({ ...items, left: width }))} /></aside>
    <div className="content-area"><header className="surface-sidebar canvas-header"><div className={`session-header ${sidebar ? "" : "with-traffic-space"}`}>{!sidebar && <IconButton label="展开侧栏" buttonRef={expandSidebar} onClick={toggleSidebar}><PanelLeft /></IconButton>}<Tabs className="center-tabs" value={current?.id ?? ""} onValueChange={id => model.openSession(id)}><TabsList aria-label="已打开的会话">{model.tabs.map(id => <div className="tab-group" key={id}><TabsTrigger value={id} className="center-tab">{hasWork(id) && <i className="status-point pending" />}<span>{model.sessionName(id)}</span></TabsTrigger><button className="tab-close" aria-label={`关闭${model.sessionName(id)}`} disabled={model.tabs.length === 1} onClick={() => model.closeSession(id)}><X /></button></div>)}</TabsList></Tabs></div><div className={`inspector-header ${inspectorOpen ? "" : "is-collapsed"}`}><InspectorHeader model={model} open={inspectorOpen} /><IconButton label={inspectorOpen ? "收起右栏" : "展开右栏"} buttonRef={inspectorToggle} disabled={target !== "code" || !current} onClick={toggleInspector}><PanelRight /></IconButton></div></header>
      <div className="content-body"><main className="surface-canvas main-canvas">{target === "personal" || status.state !== "online" || !current ? <div className="empty-state"><div className="empty-symbol">{target === "personal" ? <Terminal /> : <WifiOff />}</div><h1>{target === "personal" ? "连接你的个人 Agent" : status.state === "online" ? "你的工作区" : status.state === "connecting" ? "正在连接" : "暂时无法连接"}</h1><p>{target === "personal" ? "通过 SSH 连接服务器。会话界面尚未开放。" : status.state === "online" ? "从左侧选择工作区。" : status.error?.message ?? status.detail ?? "请确认本地后台已启动，然后重新连接。"}</p>{target === "personal" ? <Button onClick={() => void openPersonal()}>配置 SSH 连接</Button> : status.state !== "online" && <Button disabled={status.state === "connecting"} onClick={() => void reconnect()}>重新连接</Button>}</div> : <><Conversation key={`conversation:${view.instanceId}:${current.id}`} model={model} sessionId={current.id} /><Composer key={`composer:${view.instanceId}:${current.id}`} model={model} session={current} /></>}</main>
      <InspectorPanel model={model} open={inspectorOpen} onWidthChange={width => setSidebarWidths(items => ({ ...items, right: width }))} />
    </div></div>
  </div>
  <Dialog open={dialog !== null} onOpenChange={open => { if (!open) setDialog(null); }}><DialogContent className="demo-dialog"><DialogHeader><DialogTitle>{dialog === "workspace" ? "添加工作区" : "Personal 连接"}</DialogTitle><DialogDescription>{dialog === "workspace" ? "添加所选目录作为工作区。" : "通过 SSH 主机别名连接服务器。"}</DialogDescription></DialogHeader>{dialog === "workspace" ? <Input aria-label="工作区目录" readOnly value={workspacePath} onClick={() => void pickWorkspace()} /> : <div className="dialog-fields"><label htmlFor="ssh-host">SSH 主机别名</label><Input id="ssh-host" disabled={!configReady || saving} value={host} onChange={event => setHost(event.target.value)} /><p>控制目录：{personalConfig?.controlDir ?? "/var/lib/ruukoto/control"}</p></div>}<DialogFooter><Button variant="ghost" disabled={saving} onClick={() => setDialog(null)}>取消</Button><Button disabled={saving || (dialog === "workspace" ? !workspacePath : !configReady || !host.trim())} onClick={() => void saveDialog()}>{dialog === "workspace" ? "添加" : "保存"}</Button></DialogFooter></DialogContent></Dialog>
  {toast && <div className="surface-card toast-pill" role="status"><i className="status-point" />{toast}</div>}
  </>;
}
