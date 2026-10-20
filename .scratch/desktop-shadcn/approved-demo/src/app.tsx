import { Fragment, useEffect, useRef, useState, type ReactNode, type Ref, type CSSProperties } from "react";
import { ArrowUp, ChevronRight, FileCode2, Folder, ListFilter, Loader2, Moon, PanelLeft, PanelRight, Pause, Plus, Settings2, Sparkles, Square, Sun, Terminal, WifiOff, X } from "lucide-react";
import { SidebarResizer } from "./sidebar-resizer.tsx";
import { Button } from "./components/ui/button.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./components/ui/dialog.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { Input } from "./components/ui/input.tsx";
import { activitySummary, completeSubmission, initialWorkspaces, scenarios, type Session, type Step, type RightTab, type Scenario } from "./demo-data.ts";

function IconButton({ label, children, onClick, className = "", disabled, buttonRef }: { label: string; children: ReactNode; onClick: () => void; className?: string; disabled?: boolean; buttonRef?: Ref<HTMLButtonElement> }) {
  return <Button ref={buttonRef} type="button" variant="ghost" size="icon" className={`quiet-icon ${className}`} aria-label={label} onClick={onClick} disabled={disabled}>{children}</Button>;
}

function defaultRightTabs(session: Session): RightTab[] {
  return [
    ...session.diffs.slice(0, 1).map(diff => ({ id: diff.fullPath, type: "diff" as const, title: diff.file, objectId: diff.fullPath })),
    ...session.subagents.slice(0, 1).map(agent => ({ id: agent.id, type: "agent" as const, title: agent.name, objectId: agent.id })),
  ];
}

// Note: 见 .agents/notes/proposed/architecture/2026-10-15-desktop-shadcn-demo.md
export function App() {
  const [dark, setDark] = useState(true);
  const [sidebar, setSidebar] = useState(true);
  const [sidebarWidths, setSidebarWidths] = useState<{ left?: number; right?: number }>({});
  const [inspector, setInspector] = useState(() => window.innerWidth >= 1100);
  const [workspaces, setWorkspaces] = useState(initialWorkspaces);
  const [currentId, setCurrentId] = useState("sess-ft-1");
  const [openSessions, setOpenSessions] = useState(["sess-ft-1", "sess-nx-1", "sess-ft-2"]);
  const [rightTabs, setRightTabs] = useState<Record<string, RightTab[]>>({});
  const [rightActive, setRightActive] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [diffLimits, setDiffLimits] = useState<Record<string, number>>({});
  const [scenario, setScenario] = useState<Scenario>("normal");
  const [filterOpen, setFilterOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [target, setTarget] = useState("code");
  const [dialog, setDialog] = useState<"workspace" | "personal" | "resume" | null>(null);
  const [workspaceName, setWorkspaceName] = useState("");
  const [host, setHost] = useState("tx");
  const [toast, setToast] = useState("");
  const expandSidebar = useRef<HTMLButtonElement>(null);
  const inspectorToggle = useRef<HTMLButtonElement>(null);
  const stream = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const submissionTimers = useRef(new Map<string, number>());
  const workspace = workspaces.find(item => item.sessions.some(session => session.id === currentId))!;
  const session = workspace.sessions.find(item => item.id === currentId)!;
  const tabs = rightTabs[currentId] ?? defaultRightTabs(session);
  const activeTab = tabs.find(tab => tab.id === rightActive[currentId]) ?? tabs.at(-1);
  const inspectorOpen = inspector && target === "code";
  const checking = !!session.pendingSubmission;
  const blocked = checking || scenario === "offline";
  const hasInput = !!session.draft.trim() || session.attachments.length > 0;
  const stopping = scenario === "running" && !hasInput;
  const submitLabel = checking ? "正在核实输入" : stopping ? "停止任务" : session.continuing ? "发送并继续" : "发送消息";
  const lastStream = useRef({ id: session.id, length: session.steps.length });

  useEffect(() => { document.documentElement.classList.toggle("dark", dark); }, [dark]);
  useEffect(() => () => { for (const timer of submissionTimers.current.values()) window.clearTimeout(timer); }, []);
  useEffect(() => {
    if (lastStream.current.id === session.id && lastStream.current.length < session.steps.length) stream.current?.scrollTo({ top: stream.current.scrollHeight, behavior: "smooth" });
    lastStream.current = { id: session.id, length: session.steps.length };
  }, [session.id, session.steps.length]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2800);
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
  }, []);

  function toggleSidebar() {
    const focusInside = document.activeElement?.closest(".left-sidebar, .settings-dialog");
    setSettingsOpen(false);
    setSidebar(value => !value);
    if (focusInside) window.requestAnimationFrame(() => expandSidebar.current?.focus());
  }
  function toggleInspector() {
    if (document.activeElement?.closest(".right-sidebar")) inspectorToggle.current?.focus();
    setInspector(value => !value);
  }
  function updateSession(update: (item: Session) => Session) {
    setWorkspaces(items => items.map(ws => ({ ...ws, sessions: ws.sessions.map(item => item.id === currentId ? update(item) : item) })));
  }
  function openSession(id: string) {
    setCurrentId(id);
    setOpenSessions(items => items.includes(id) ? items : [...items, id]);
    setScenario("normal");
    stream.current?.scrollTo({ top: 0 });
  }
  function closeSession(id: string) {
    if (openSessions.length === 1) return;
    const index = openSessions.indexOf(id);
    const rest = openSessions.filter(item => item !== id);
    setOpenSessions(rest);
    if (currentId === id) openSession(rest[Math.max(0, index - 1)]);
  }
  function newSession(workspaceId = workspace.id) {
    const item: Session = { id: crypto.randomUUID(), title: "新会话", status: "idle", steps: [], subagents: [], diffs: [], draft: "", attachments: [], pendingSubmission: null, model: session.model, mode: session.mode, continuing: false };
    setWorkspaces(items => items.map(ws => ws.id === workspaceId ? { ...ws, expanded: true, sessions: [...ws.sessions, item] } : ws));
    openSession(item.id);
    input.current?.focus();
  }
  function openRight(tab: RightTab) {
    setInspector(true);
    const existing = tabs.find(item => item.id === tab.id);
    if (!existing) setRightTabs(items => ({ ...items, [currentId]: activeTab?.type === "new" ? tabs.map(item => item.id === activeTab.id ? tab : item) : [...tabs, tab] }));
    setRightActive(items => ({ ...items, [currentId]: tab.id }));
  }
  function openDiff(path: string) {
    const diff = session.diffs.find(item => item.fullPath === path);
    if (diff) openRight({ id: path, type: "diff", title: diff.file, objectId: path });
  }
  function openAgent(name: string) {
    const agent = session.subagents.find(item => item.name === name);
    if (agent) openRight({ id: agent.id, type: "agent", title: agent.name, objectId: agent.id });
  }
  function closeRight(id: string) {
    const index = tabs.findIndex(item => item.id === id);
    const rest = tabs.filter(item => item.id !== id);
    const remaining: RightTab[] = rest.length ? rest : [{ id: crypto.randomUUID(), type: "new", title: "新标签" }];
    setRightTabs(items => ({ ...items, [currentId]: remaining }));
    setRightActive(items => ({ ...items, [currentId]: remaining[Math.max(0, index - 1)].id }));
  }
  function startSubmission(queued: boolean) {
    if (!hasInput || checking || submissionTimers.current.has(session.id)) return;
    const id = session.id;
    const pending = { draft: session.draft, attachments: session.attachments, continuing: session.continuing, queued };
    updateSession(item => ({ ...item, pendingSubmission: pending }));
    const timer = window.setTimeout(() => {
      setWorkspaces(items => items.map(ws => ({ ...ws, sessions: ws.sessions.map(item => item.id === id ? completeSubmission(item, pending) : item) })));
      submissionTimers.current.delete(id);
    }, 1200);
    submissionTimers.current.set(id, timer);
  }
  function send() {
    if (blocked) return;
    if (stopping) { updateSession(item => ({ ...item, continuing: true })); setScenario("normal"); return; }
    startSubmission(scenario === "running" || scenario === "paused");
  }
  function selectScenario(value: Scenario) {
    setScenario(value);
    if (value === "pending") startSubmission(false);
    if (value === "diff-truncated" && session.diffs[0]) setDiffLimits(items => ({ ...items, [`${currentId}:${session.diffs[0].fullPath}`]: 4 }));
    if (value.startsWith("diff-") && session.diffs[0]) openDiff(session.diffs[0].fullPath);
  }
  function renderProse(text: string) {
    return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, index) => {
      if (part.startsWith("`")) {
        const value = part.slice(1, -1);
        const diff = session.diffs.find(item => item.fullPath === value);
        return diff ? <button key={index} className="inline-code hover-pill" onClick={() => openDiff(value)}>{value}</button> : <code key={index} className="inline-code">{value}</code>;
      }
      return part.startsWith("**") ? <strong key={index}>{part.slice(2, -2)}</strong> : part;
    });
  }
  function renderSteps(steps: Step[], scope: string) {
    return steps.map((step, index) => {
      const key = `${currentId}:${scope}:${index}`;
      if (step.type === "user") return <div className="flex justify-end" key={key}><div className="surface-user-bubble user-bubble selectable-text">{step.text}</div></div>;
      if (step.type === "prose") return <div className="prose-message selectable-text" key={key}>{renderProse(step.text)}</div>;
      if (step.type === "activity") {
        const open = expanded[key] ?? step.expanded;
        const agents = step.items.filter(item => item.action === "Agent");
        const tools = step.items.filter(item => item.action !== "Agent");
        return <Fragment key={key}>{agents.map((item, n) => <button className="subagent-activity hover-pill" key={n} onClick={() => openAgent(item.file)}><Sparkles /><span>{item.file}</span><small>{item.note}</small></button>)}{tools.length > 0 && <div className="activity-group"><button className="activity-summary" aria-expanded={open} onClick={() => setExpanded(items => ({ ...items, [key]: !open }))}><ChevronRight className={open ? "rotate-90" : ""} /><span>{activitySummary(tools)}</span><small>· {step.duration}</small></button>{open && <div className="activity-details">{tools.map((item, n) => <button key={n} disabled={!item.diffFile && !item.openTab} onClick={() => item.diffFile ? openDiff(item.diffFile) : openAgent(item.file)}><span>{item.action}</span><code>{item.file}</code>{item.stat ? <small className="file-diff"><b>{item.stat.split(" ")[0]}</b> <em>{item.stat.split(" ")[1]}</em></small> : item.action !== "Read" && <small className="activity-note">{item.note}</small>}</button>)}</div>}</div>}</Fragment>;
      }
      if (step.type !== "command" || step.status !== "pending") return null;
      return <section key={key} className="surface-card command-card" aria-label="命令审批"><div className="command-heading"><span className="status-point pending" /><span>在工作区运行命令</span><div><Button variant="ghost" size="sm" onClick={() => updateSession(item => ({ ...item, steps: item.steps.map(s => s.type === "command" && s.id === step.id ? { ...s, status: "skipped" } : s) }))}>拒绝</Button><Button size="sm" onClick={() => updateSession(item => ({ ...item, steps: item.steps.map(s => s.type === "command" && s.id === step.id ? { ...s, status: "approved" } : s) }))}>批准</Button></div></div><div className="command-code selectable-text"><span>$</span><code>{step.command}</code></div><p>{step.note}</p></section>;
    });
  }
  const selectedAgent = activeTab?.type === "agent" ? session.subagents.find(item => item.id === activeTab.objectId) : undefined;
  const selectedDiff = activeTab?.type === "diff" ? session.diffs.find(item => item.fullPath === activeTab.objectId) : undefined;
  const displayedDiff = selectedDiff && scenario === "diff-empty" ? { ...selectedDiff, fullPath: "empty.ts", add: 0, del: 0, lines: [] } : selectedDiff;
  const diffKey = `${currentId}:${displayedDiff?.fullPath}`;
  const diffLimit = scenario === "diff-truncated" ? diffLimits[diffKey] ?? 4 : Infinity;

  const settings = <Dialog open={sidebar && settingsOpen} onOpenChange={setSettingsOpen}>
    <DialogTrigger asChild><Button type="button" variant="ghost" size="icon" className="quiet-icon" aria-label="设置"><Settings2 /></Button></DialogTrigger>
    <DialogContent className="settings-dialog" onCloseAutoFocus={event => { if (!sidebar) { event.preventDefault(); expandSidebar.current?.focus(); } }}>
      <DialogDescription className="sr-only">选择左侧类别查看设置项。</DialogDescription>
      <Tabs defaultValue="appearance" orientation="vertical" className="settings-tabs">
        <div className="settings-navigation">
          <DialogTitle>设置</DialogTitle>
          <TabsList className="settings-categories" aria-label="设置类别">
            <TabsTrigger value="appearance">{dark ? <Moon /> : <Sun />}外观</TabsTrigger>
            <TabsTrigger value="target"><Terminal />运行目标</TabsTrigger>
            <TabsTrigger value="scenarios"><Settings2 />演示状态</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="appearance" className="settings-panel">
          <h2>外观</h2>
          <div className="settings-row"><label htmlFor="settings-theme">主题</label>
            <Select value={dark ? "dark" : "light"} onValueChange={value => setDark(value === "dark")}>
              <SelectTrigger id="settings-theme" aria-label="主题"><SelectValue /></SelectTrigger>
              <SelectContent position="popper" align="end" sideOffset={6}><SelectItem value="light">浅色</SelectItem><SelectItem value="dark">深色</SelectItem></SelectContent>
            </Select>
          </div>
        </TabsContent>
        <TabsContent value="target" className="settings-panel">
          <h2>运行目标</h2>
          <div className="settings-row"><label htmlFor="settings-target">目标</label>
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger id="settings-target" aria-label="运行目标"><SelectValue /></SelectTrigger>
              <SelectContent position="popper" align="end" sideOffset={6}><SelectItem value="code">Code</SelectItem><SelectItem value="personal">Personal</SelectItem></SelectContent>
            </Select>
          </div>
        </TabsContent>
        <TabsContent value="scenarios" className="settings-panel">
          <h2>演示状态</h2>
          <div className="settings-row"><label htmlFor="settings-scenario">预览状态</label>
            <Select value={scenario} onValueChange={value => selectScenario(value as Scenario)}>
              <SelectTrigger id="settings-scenario" aria-label="预览状态"><SelectValue /></SelectTrigger>
              <SelectContent position="popper" align="end" sideOffset={6}>{scenarios.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </TabsContent>
      </Tabs>
    </DialogContent>
  </Dialog>;

  return <><div className="desktop-backdrop"><div className="macos-window app-window" style={{ "--left-preferred-width": sidebarWidths.left === undefined ? undefined : `${sidebarWidths.left}px`, "--right-preferred-width": sidebarWidths.right === undefined ? undefined : `${sidebarWidths.right}px`, "--right-reserve": inspectorOpen ? "260px" : "0px", "--visible-left-width": sidebar ? "var(--left-width)" : "0px" } as CSSProperties}>
    <aside id="left-sidebar" className={`surface-sidebar left-sidebar ${sidebar ? "" : "is-collapsed"}`} aria-label="工作区导航" aria-hidden={!sidebar} inert={!sidebar}><div className="sidebar-content"><div className="window-controls"><div className="traffic-lights" aria-hidden="true"><i /><i /><i /></div><IconButton label="收起侧栏" onClick={toggleSidebar}><PanelLeft /></IconButton></div><div className="projects-heading"><span>{target === "code" ? "工作区" : "Personal"}</span><div><IconButton label="筛选工作区与会话" onClick={() => { setFilterOpen(value => !value); setFilter(""); }}><ListFilter /></IconButton><IconButton label="添加工作区" onClick={() => setDialog("workspace")}><Plus /></IconButton></div></div>{filterOpen && <div className="workspace-filter"><Input aria-label="筛选工作区与会话" autoFocus placeholder="筛选工作区与会话…" value={filter} onChange={event => setFilter(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { setFilterOpen(false); setFilter(""); } }} /></div>}<div className="workspace-tree">{target === "code" ? workspaces.filter(ws => !filter || ws.name.toLowerCase().includes(filter.toLowerCase()) || ws.sessions.some(item => item.title.toLowerCase().includes(filter.toLowerCase()))).map(ws => <section key={ws.id}><div className="workspace-row"><button onClick={() => setWorkspaces(items => items.map(item => item.id === ws.id ? { ...item, expanded: !item.expanded } : item))} aria-expanded={ws.expanded || !!filter}><ChevronRight className={ws.expanded || filter ? "rotate-90" : ""} /><Folder /><span>{ws.name}</span></button><IconButton className="workspace-add" label={`在 ${ws.name} 新建会话`} onClick={() => newSession(ws.id)}><Plus /></IconButton></div>{(ws.expanded || filter) && <div className="workspace-sessions">{ws.sessions.filter(item => !filter || ws.name.toLowerCase().includes(filter.toLowerCase()) || item.title.toLowerCase().includes(filter.toLowerCase())).map(item => <button key={item.id} className={`workspace-session ${item.id === currentId ? "active-pill text-pri" : "text-sec hover-pill"}`} aria-current={item.id === currentId ? "page" : undefined} onClick={() => openSession(item.id)}><span>{item.title}</span>{["awaiting", "running"].includes(item.status) && <i className="status-point pending" />}</button>)}</div>}</section>) : <Button variant="ghost" className="personal-row" onClick={() => setDialog("personal")}><Terminal />配置 SSH 连接</Button>}</div><div className="sidebar-bottom">{settings}</div></div><SidebarResizer side="left" open={sidebar} onWidthChange={width => setSidebarWidths(items => ({ ...items, left: width }))} /></aside>

    <div className="content-area"><header className="surface-sidebar canvas-header">{!sidebar && <IconButton label="展开侧栏" buttonRef={expandSidebar} onClick={toggleSidebar}><PanelLeft /></IconButton>}<Tabs className="center-tabs" value={currentId} onValueChange={openSession}><TabsList aria-label="已打开的会话">{openSessions.map(id => { const item = workspaces.flatMap(ws => ws.sessions).find(s => s.id === id)!; return <div className="tab-group" key={id}><TabsTrigger value={id} className="center-tab">{["awaiting", "running"].includes(item.status) && <i className="status-point pending" />}<span>{item.title}</span></TabsTrigger><button className="tab-close" aria-label={`关闭${item.title}`} disabled={openSessions.length === 1} onClick={() => closeSession(id)}><X /></button></div>; })}</TabsList></Tabs><IconButton label={inspector ? "收起右栏" : "展开右栏"} buttonRef={inspectorToggle} onClick={toggleInspector}><PanelRight /></IconButton></header><div className="content-body"><main className="surface-canvas main-canvas">
      {target === "personal" || scenario === "offline" ? <div className="empty-state"><div className="empty-symbol">{target === "personal" ? <Terminal /> : <WifiOff />}</div><h1>{target === "personal" ? "连接你的个人 Agent" : "暂时无法连接"}</h1><p>{target === "personal" ? "通过 SSH 连接服务器。当前仅提供连接配置与审批，会话界面尚未开放。" : "请确认本地后台已启动，然后重新连接。"}</p><Button onClick={() => target === "personal" ? setDialog("personal") : setScenario("normal")}>{target === "personal" ? "配置 SSH 连接" : "重新连接"}</Button><span>前端演示，不建立真实连接。</span></div> : <><div className="stream-scroll selectable-text" ref={stream}><div className="agent-stream">{session.steps.length ? renderSteps(session.steps, "main") : <div className="new-session-empty"><h1>开始一个新的会话</h1><p>在下方描述你想完成的事。</p></div>}</div></div>
        <div className="composer-wrap"><div className="composer-width">{scenario === "paused" && <div className="task-notice"><Pause /><span>队列暂停 · 2 个任务等待继续</span><Button variant="ghost" size="sm" onClick={() => setDialog("resume")}>恢复队列</Button></div>}{session.continuing && <div className="task-notice"><span>正在继续中断的任务</span><Button variant="ghost" size="sm" disabled={checking} onClick={() => updateSession(item => ({ ...item, continuing: false }))}>改为新任务</Button></div>}<form className="surface-composer composer" onSubmit={event => { event.preventDefault(); send(); }}><input ref={attachmentInput} type="file" multiple hidden aria-label="选择附件" onChange={event => { const attachments = Array.from(event.currentTarget.files ?? [], file => ({ id: crypto.randomUUID(), name: file.name, size: file.size })); updateSession(item => ({ ...item, attachments: [...item.attachments, ...attachments] })); event.currentTarget.value = ""; }} />{session.attachments.length > 0 && <div className="attached-files" aria-label="已附加文件">{session.attachments.map(attachment => <span className="attachment-chip" key={attachment.id}><FileCode2 /><span>{attachment.name}</span><button type="button" disabled={checking} aria-label={`移除附件 ${attachment.name}`} onClick={() => updateSession(item => ({ ...item, attachments: item.attachments.filter(file => file.id !== attachment.id) }))}><X /></button></span>)}</div>}<Textarea ref={input} aria-label="输入消息" rows={2} readOnly={checking} value={session.draft} placeholder={session.continuing ? "输入继续任务的指示…" : "描述你想做的事…"} onChange={event => updateSession(item => ({ ...item, draft: event.target.value }))} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} /><div className="composer-actions"><div className="composer-left"><IconButton label="附加文件" disabled={blocked} onClick={() => attachmentInput.current?.click()}><Plus /></IconButton><Select value={session.mode} onValueChange={mode => updateSession(item => ({ ...item, mode }))} disabled={blocked}><SelectTrigger aria-label="会话默认模式"><SelectValue /></SelectTrigger><SelectContent position="popper" side="top" align="start" sideOffset={6}><SelectItem value="confirm">Ask for approval</SelectItem><SelectItem value="auto-review">Auto review</SelectItem><SelectItem value="full">Full access</SelectItem><SelectItem value="plan">Plan</SelectItem></SelectContent></Select></div><div className="composer-right"><Select value={session.model} onValueChange={model => updateSession(item => ({ ...item, model }))} disabled={blocked}><SelectTrigger aria-label="会话模型"><SelectValue /></SelectTrigger><SelectContent position="popper" side="top" align="end" sideOffset={6}><SelectItem value="Claude 3.7 Sonnet">Claude 3.7 Sonnet</SelectItem><SelectItem value="o3-mini">o3-mini</SelectItem><SelectItem value="DeepSeek R1" disabled>DeepSeek R1 · 认证不可用</SelectItem></SelectContent></Select><Button size="icon" className="send-button" type="submit" disabled={blocked || (!stopping && !hasInput)} aria-label={submitLabel} aria-busy={checking}>{checking ? <Loader2 className="animate-spin" /> : stopping ? <Square fill="currentColor" /> : <ArrowUp />}</Button></div></div></form></div></div></>}
    </main>

    <aside id="right-sidebar" className={`surface-inspector right-sidebar ${inspectorOpen ? "" : "is-collapsed"}`} aria-label="检查器" aria-hidden={!inspectorOpen} inert={!inspectorOpen}><div className="sidebar-content"><div className="right-header"><Tabs className="right-tabs" value={activeTab?.id ?? ""} onValueChange={id => setRightActive(items => ({ ...items, [currentId]: id }))}><TabsList aria-label="右侧标签">{tabs.map(tab => <div className="tab-group" key={tab.id}><TabsTrigger value={tab.id} className="right-tab">{tab.type === "diff" ? <FileCode2 className="file-icon" /> : tab.type === "agent" ? <Sparkles className="agent-icon" /> : <Plus />}<span>{tab.title}</span></TabsTrigger><button className="tab-close" aria-label={`关闭右栏${tab.title}`} onClick={() => closeRight(tab.id)}><X /></button></div>)}</TabsList></Tabs><IconButton label="右栏新标签" onClick={() => { const tab: RightTab = { id: crypto.randomUUID(), type: "new", title: "新标签" }; setRightTabs(items => ({ ...items, [currentId]: [...tabs, tab] })); setRightActive(items => ({ ...items, [currentId]: tab.id })); }}><Plus /></IconButton></div><div className="right-viewport">{selectedAgent ? <><div className="agent-meta"><i className="status-point" /><span>{selectedAgent.name}</span><small>· {selectedAgent.role}</small><code>{selectedAgent.duration}</code></div><div className="subagent-stream selectable-text">{renderSteps(selectedAgent.steps, selectedAgent.id)}</div></> : displayedDiff ? <><div className="diff-heading"><span>{displayedDiff.fullPath}</span>{(displayedDiff.add > 0 || displayedDiff.del > 0) && <code><b>+{displayedDiff.add}</b><em>−{displayedDiff.del}</em></code>}</div>{scenario === "diff-error" ? <div className="diff-error"><FileCode2 /><p>差异读取失败</p><Button variant="ghost" size="sm" onClick={() => setScenario("normal")}>重试</Button></div> : <><div className="diff-view selectable-text"><div className="diff-lines">{displayedDiff.lines.slice(0, diffLimit).map((line, index) => <div className={`diff-line ${line.type === "add" ? "diff-line-add" : line.type === "del" ? "diff-line-del" : ""}`} key={index}><span>{line.no}</span><span>{line.type === "add" ? "+" : line.type === "del" ? "−" : " "}</span><code>{line.code}</code></div>)}</div></div>{displayedDiff.lines.length > diffLimit && <button className="diff-more" onClick={() => setDiffLimits(items => ({ ...items, [diffKey]: diffLimit + 20 }))}>more</button>}</>}</> : <div className="new-tab-page"><p>工具差异</p>{session.diffs.length ? session.diffs.map(diff => <button className="surface-flat" key={diff.fullPath} onClick={() => openDiff(diff.fullPath)}><FileCode2 /><span>{diff.file}</span><code>+{diff.add} −{diff.del}</code></button>) : <span>暂无工具差异</span>}<p>SubAgent</p>{session.subagents.length ? session.subagents.map(agent => <button className="surface-flat" key={agent.id} onClick={() => openAgent(agent.name)}><Sparkles /><span>{agent.name}</span><small>{agent.duration}</small></button>) : <span>暂无 SubAgent</span>}</div>}</div></div><SidebarResizer side="right" open={inspectorOpen} onWidthChange={width => setSidebarWidths(items => ({ ...items, right: width }))} /></aside>
  </div></div></div></div>

  <Dialog open={dialog !== null} onOpenChange={open => { if (!open) setDialog(null); }}><DialogContent className="demo-dialog"><DialogHeader><DialogTitle>{dialog === "workspace" ? "添加工作区" : dialog === "personal" ? "Personal 连接" : "恢复队列"}</DialogTitle><DialogDescription>{dialog === "workspace" ? "添加一个模拟工作区，不访问本机文件。" : dialog === "personal" ? "仅预览 SSH 配置，不建立真实连接。" : `为 2 个旧任务补齐 ${session.model}，然后恢复队列。`}</DialogDescription></DialogHeader>{dialog === "workspace" && <Input aria-label="工作区名称" placeholder="工作区名称" value={workspaceName} onChange={event => setWorkspaceName(event.target.value)} />}{dialog === "personal" && <div className="dialog-fields"><label htmlFor="ssh-host">SSH 主机别名</label><Input id="ssh-host" value={host} onChange={event => setHost(event.target.value)} /><p>控制目录：/var/lib/ruukoto/control</p></div>}<DialogFooter><Button variant="ghost" onClick={() => setDialog(null)}>取消</Button><Button disabled={dialog === "workspace" ? !workspaceName.trim() || workspaces.some(ws => ws.name === workspaceName.trim()) : dialog === "personal" ? !host.trim() : false} onClick={() => { if (dialog === "workspace") { const id = crypto.randomUUID(); const item: Session = { id: crypto.randomUUID(), title: "新会话", status: "idle", steps: [], subagents: [], diffs: [], draft: "", attachments: [], pendingSubmission: null, model: session.model, mode: session.mode, continuing: false }; setWorkspaces(items => [...items, { id, name: workspaceName.trim(), expanded: true, sessions: [item] }]); openSession(item.id); setWorkspaceName(""); } else if (dialog === "resume") { setScenario("normal"); setToast("演示：已补齐模型，队列已恢复"); } else setToast("演示：配置已更新，未发起 SSH 连接"); setDialog(null); }}>{dialog === "workspace" ? "添加" : dialog === "resume" ? "补齐模型并恢复" : "预览保存"}</Button></DialogFooter></DialogContent></Dialog>
  {toast && <div className="surface-card toast-pill" role="status"><i className="status-point" />{toast}</div>}
  </>;
}
