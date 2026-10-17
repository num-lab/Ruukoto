import { Fragment, useEffect, useRef, useState, type ReactNode, type Ref, type CSSProperties, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowUp, Brain, ChevronDown, ChevronRight, FileCode2, FileText, Folder, FolderTree, GitGraph, Globe, ListFilter, ListTodo, Loader2, MessageCircleQuestion, Moon, PanelLeft, PanelRight, Pause, Plus, Server, Settings2, ShieldCheck, Sparkles, Square, Sun, WifiOff, X, Zap } from "lucide-react";
import { PersonalConnectionSettings, initialPersonalConnection } from "./personal-connection-settings.tsx";
import { SidebarResizer } from "./sidebar-resizer.tsx";
import { Button } from "./components/ui/button.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./components/ui/dialog.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./components/ui/dropdown-menu.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { Input } from "./components/ui/input.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible.tsx";
import { Bubble, BubbleContent } from "./components/ui/bubble.tsx";
import { Message, MessageContent } from "./components/ui/message.tsx";
import { MessageScroller, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from "./components/ui/message-scroller.tsx";
import { ToolActivity } from "./tool-activity.tsx";
import { Item, ItemActions, ItemContent, ItemDescription, ItemHeader, ItemTitle } from "./components/ui/item.tsx";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./components/ui/hover-card.tsx";
import { Progress } from "./components/ui/progress.tsx";
import { GitGraphPanel } from "./git-graph.tsx";
import { workspaceGitRepository } from "./git-graph-data.ts";
import { BrowserPanel, FilePreview, WorkspaceFiles } from "./inspector-panels.tsx";
import { browserNavigation, fileTabId, navigateBrowser, workspaceFiles } from "./inspector-data.ts";
import { executionPreview, toolDetailsPreview, completeSubmission, initialPersonalSession, initialWorkspaces, PERSONAL_SESSION_ID, scenarios, type Session, type Step, type RightTab, type Scenario } from "./demo-data.ts";

const sessionModes = [
  { value: "confirm", label: "Ask for approval", icon: MessageCircleQuestion },
  { value: "auto-review", label: "Auto review", icon: ShieldCheck },
  { value: "full", label: "Full access", icon: Zap },
  { value: "plan", label: "Plan", icon: ListTodo },
];

function IconButton({ label, children, onClick, className = "", disabled, buttonRef }: { label: string; children: ReactNode; onClick: () => void; className?: string; disabled?: boolean; buttonRef?: Ref<HTMLButtonElement> }) {
  return <Button ref={buttonRef} type="button" variant="ghost" size="icon" className={`quiet-icon ${className}`} aria-label={label} onClick={onClick} disabled={disabled}>{children}</Button>;
}

// Note: 见 .agents/notes/implemented/feature/2026-10-16-demo-input-preview.md
export function submitOnEnter(event: ReactKeyboardEvent<HTMLTextAreaElement>, canSend: boolean, send: () => void) {
  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
  event.preventDefault();
  if (canSend && !event.repeat) send();
}

// Note: 见 .agents/notes/implemented/feature/2026-10-17-demo-tab-reorder.md
export function reorderTab<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from >= items.length || to >= items.length || from === to) return items;
  const reordered = [...items];
  const [item] = reordered.splice(from, 1);
  reordered.splice(to, 0, item);
  return reordered;
}

export function tabDragOffset(order: string[], sourceId: string, targetId: string, id: string): number {
  const index = order.indexOf(id);
  if (index < 0) return 0;
  return reorderTab(order, order.indexOf(sourceId), order.indexOf(targetId)).indexOf(id) - index;
}

function defaultRightTabs(session: Session): RightTab[] {
  return [
    ...session.diffs.slice(0, 1).map(diff => ({ id: diff.fullPath, type: "diff" as const, title: diff.file, objectId: diff.fullPath })),
    ...session.subagents.slice(0, 1).map(agent => ({ id: agent.id, type: "agent" as const, title: agent.name, objectId: agent.id })),
  ];
}

// Note: 见 .agents/notes/implemented/feature/2026-10-16-demo-context-details.md
export function ContextDetails({ context }: { context: Session["context"] }) {
  const { usedTokens, maxTokens, systemTokens, toolTokens } = context;
  const percent = usedTokens / maxTokens * 100;
  const compact = (tokens: number) => tokens.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
  return <>
    <div className="context-summary"><span>{Math.round(percent)}% <span>of context used</span></span><span>~{compact(usedTokens)} / {compact(maxTokens)}</span></div>
    <Progress value={percent} aria-label="上下文使用量" style={{ "--context-system-end": `${100 - percent + systemTokens / maxTokens * 100}%`, "--context-tools-end": `${100 - percent + (systemTokens + toolTokens) / maxTokens * 100}%` } as CSSProperties} />
    <dl className="context-breakdown">{[
      { label: "System prompt", tokens: systemTokens, className: "context-system" },
      { label: "Tool definitions", tokens: toolTokens, className: "context-tools" },
      { label: "Messages", tokens: usedTokens - systemTokens - toolTokens, className: "context-messages" },
    ].map(item => <div key={item.label}><dt><i className={item.className} aria-hidden="true" />{item.label}</dt><dd>~{compact(item.tokens)}</dd></div>)}</dl>
  </>;
}

// Note: 见 .agents/notes/implemented/feature/2026-10-16-demo-ai-elements.md
// Note: 见 .agents/notes/implemented/feature/2026-10-16-demo-header-model-menu.md
// Note: 见 .agents/notes/implemented/feature/2026-10-16-demo-inspector-tools.md
// Note: 见 .agents/notes/implemented/feature/2026-10-17-demo-personal-main-tab.md
export function App() {
  const [dark, setDark] = useState(true);
  const [sidebar, setSidebar] = useState(true);
  const [sidebarWidths, setSidebarWidths] = useState<{ left?: number; right?: number }>({});
  const [inspector, setInspector] = useState(() => window.innerWidth >= 1100);
  const [workspaces, setWorkspaces] = useState(initialWorkspaces);
  const [personalSession, setPersonalSession] = useState(initialPersonalSession);
  const [currentId, setCurrentId] = useState("sess-ft-1");
  const [openSessions, setOpenSessions] = useState(["sess-ft-1", "sess-nx-1", "sess-ft-2"]);
  const [rightTabs, setRightTabs] = useState<Record<string, RightTab[]>>({});
  const [rightActive, setRightActive] = useState<Record<string, string>>({});
  const [draggingTab, setDraggingTab] = useState<{ scope: "session" | "right"; id: string; sessionId: string; targetId?: string; previewed?: boolean } | null>(null);
  const [tabAnnouncement, setTabAnnouncement] = useState("");
  const [tabHoverPaused, setTabHoverPaused] = useState({ session: false, right: false });
  const [fileFolders, setFileFolders] = useState<Record<string, Record<string, boolean>>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [diffLimits, setDiffLimits] = useState<Record<string, number>>({});
  const [scenario, setScenario] = useState<Scenario>("normal");
  const [filterOpen, setFilterOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [personalConnection, setPersonalConnection] = useState(initialPersonalConnection);
  const [filter, setFilter] = useState("");
  const [dialog, setDialog] = useState<"workspace" | "resume" | null>(null);
  const [workspaceName, setWorkspaceName] = useState("");
  const [toast, setToast] = useState("");
  const expandSidebar = useRef<HTMLButtonElement>(null);
  const inspectorToggle = useRef<HTMLButtonElement>(null);
  const sessionTabList = useRef<HTMLDivElement>(null);
  const rightTabList = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const filterInput = useRef<HTMLInputElement>(null);
  const filterToggle = useRef<HTMLButtonElement>(null);
  const submissionTimers = useRef(new Map<string, number>());
  const allSessions = [personalSession, ...workspaces.flatMap(item => item.sessions)];
  const workspace = workspaces.find(item => item.sessions.some(session => session.id === currentId));
  const session = allSessions.find(item => item.id === currentId)!;
  const isPersonal = session.id === PERSONAL_SESSION_ID;
  const gitRepository = workspaceGitRepository(workspace?.id);
  const modeOption = sessionModes.find(item => item.value === session.mode)!;
  // Note: 见 .agents/notes/implemented/feature/2026-10-16-demo-context-component.md
  const contextPercent = session.context.usedTokens / session.context.maxTokens * 100;
  const tabs = rightTabs[currentId] ?? defaultRightTabs(session);
  const activeTab = tabs.find(tab => tab.id === rightActive[currentId]) ?? tabs.at(-1);
  const rightTabOrder = tabs.map(tab => tab.id).join("\n");
  const sessionTabMembership = [...openSessions].sort().join("\0");
  const rightTabMembership = tabs.map(tab => tab.id).sort().join("\0");
  useEffect(() => { setTabHoverPaused(items => ({ ...items, session: true })); }, [sessionTabMembership]);
  useEffect(() => { setTabHoverPaused(items => ({ ...items, right: true })); }, [currentId, rightTabMembership]);
  const inspectorOpen = inspector;
  const checking = !!session.pendingSubmission;
  const blocked = checking || scenario === "offline";
  const hasInput = !!session.draft.trim() || session.attachments.length > 0;
  const executionPhase = scenario === "running" ? "thinking" : scenario === "working" ? "working" : undefined;
  const stopping = !!executionPhase && !hasInput;
  const submitLabel = checking ? "正在核实输入" : stopping ? "停止任务" : session.continuing ? "发送并继续" : "发送消息";

  useEffect(() => {
    const lists = [sessionTabList.current, inspectorOpen ? rightTabList.current : null];
    const reveal = () => { for (const list of lists) list?.querySelector('[data-state="active"]')?.closest(".tab-group")?.scrollIntoView({ block: "nearest", inline: "nearest" }); };
    reveal();
    const observer = new ResizeObserver(reveal);
    for (const list of lists) if (list) observer.observe(list);
    return () => observer.disconnect();
  }, [activeTab?.id, currentId, inspectorOpen, openSessions, rightTabOrder]);
  useEffect(() => { document.documentElement.classList.toggle("dark", dark); }, [dark]);
  useEffect(() => { if (filterOpen) filterInput.current?.focus(); }, [filterOpen]);
  useEffect(() => () => { for (const timer of submissionTimers.current.values()) window.clearTimeout(timer); }, []);
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

  // Note: 见 .agents/notes/implemented/bug-fix/2026-10-17-desktop-sidebar-toggle.md
  function toggleSidebar() {
    const focusInside = document.activeElement?.closest(".left-sidebar, .settings-dialog");
    setSettingsOpen(false);
    setSidebar(value => !value);
    if (focusInside) window.requestAnimationFrame(() => expandSidebar.current?.focus());
  }
  function toggleInspector() {
    if (document.activeElement?.closest(".right-sidebar, .right-header")) inspectorToggle.current?.focus();
    setInspector(value => !value);
  }
  function updateSessionById(id: string, update: (item: Session) => Session) {
    if (id === PERSONAL_SESSION_ID) setPersonalSession(update);
    else setWorkspaces(items => items.map(ws => ({ ...ws, sessions: ws.sessions.map(item => item.id === id ? update(item) : item) })));
  }
  function updateSession(update: (item: Session) => Session) {
    updateSessionById(currentId, update);
  }
  function moveTab(scope: "session" | "right", sourceId: string, targetId: string) {
    const order = scope === "session" ? openSessions : tabs.map(tab => tab.id);
    const from = order.indexOf(sourceId), to = order.indexOf(targetId);
    if (from < 0 || to < 0 || from === to) return;
    if (scope === "session") setOpenSessions(items => reorderTab(items, items.indexOf(sourceId), items.indexOf(targetId)));
    else {
      if (activeTab) setRightActive(items => ({ ...items, [currentId]: activeTab.id }));
      setRightTabs(items => {
        const current = items[currentId] ?? defaultRightTabs(session);
        return { ...items, [currentId]: reorderTab(current, current.findIndex(tab => tab.id === sourceId), current.findIndex(tab => tab.id === targetId)) };
      });
    }
    const title = scope === "session" ? allSessions.find(item => item.id === sourceId)!.title : tabs.find(item => item.id === sourceId)!.title;
    setTabAnnouncement(`${title}已移至第 ${to + 1} 位，共 ${order.length} 个。`);
  }
  function localTabDrag(scope: "session" | "right") {
    return draggingTab?.scope === scope && (scope === "session" || draggingTab.sessionId === currentId) ? draggingTab : null;
  }
  function tabGroupProps(scope: "session" | "right", id: string) {
    const drag = localTabDrag(scope);
    const order = scope === "session" ? openSessions : tabs.map(tab => tab.id);
    return {
      "data-sorting": drag ? "true" : undefined,
      "data-drag-source": drag?.previewed && drag.id === id ? "true" : undefined,
      style: { "--tab-shift": drag ? tabDragOffset(order, drag.id, drag.targetId ?? drag.id, id) : 0 } as CSSProperties,
    };
  }
  // Note: 见 .agents/notes/implemented/feature/2026-10-17-demo-responsive-tab-width.md
  // Note: 见 .agents/notes/implemented/bug-fix/2026-10-17-desktop-tab-hover.md
  function tabListProps(scope: "session" | "right") {
    const drag = localTabDrag(scope);
    const order = scope === "session" ? openSessions : tabs.map(tab => tab.id);
    const targetAt = (event: ReactDragEvent<HTMLDivElement>) => {
      const list = event.currentTarget;
      const first = list.querySelector<HTMLElement>(".tab-group");
      if (!first) return undefined;
      const gap = parseFloat(getComputedStyle(list).columnGap);
      const slot = Math.floor((event.clientX - list.getBoundingClientRect().left + gap / 2) / (first.getBoundingClientRect().width + gap));
      return order[Math.max(0, Math.min(order.length - 1, slot))];
    };
    const previewAt = (event: ReactDragEvent<HTMLDivElement>) => {
      if (!drag) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const targetId = targetAt(event);
      if (targetId && targetId !== drag.targetId) setDraggingTab({ ...drag, targetId, previewed: true });
    };
    return {
      "data-hover-paused": tabHoverPaused[scope] ? "true" : undefined,
      style: { "--tab-count": Math.max(order.length, 1) } as CSSProperties,
      onPointerMove() { if (!draggingTab && tabHoverPaused[scope]) setTabHoverPaused(items => ({ ...items, [scope]: false })); },
      onDragEnter: previewAt,
      onDragOver: previewAt,
      onDragLeave(event: ReactDragEvent<HTMLDivElement>) {
        if (!drag?.targetId) return;
        const rect = event.currentTarget.parentElement!.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX >= rect.right || event.clientY < rect.top || event.clientY >= rect.bottom) setDraggingTab({ ...drag, targetId: undefined });
      },
      onDrop(event: ReactDragEvent<HTMLDivElement>) {
        if (drag) {
          event.preventDefault();
          const targetId = targetAt(event);
          if (targetId) moveTab(scope, drag.id, targetId);
        }
        setDraggingTab(null); setTabHoverPaused(items => ({ ...items, [scope]: true }));
      },
    };
  }
  function tabOrderProps(scope: "session" | "right", id: string) {
    const drag = localTabDrag(scope);
    return {
      draggable: true,
      "data-dragging": drag?.id === id ? "true" : undefined,
      "aria-description": "可拖动排序，也可按 Alt+Shift+左右方向键调整顺序。",
      "aria-keyshortcuts": "Alt+Shift+ArrowLeft Alt+Shift+ArrowRight",
      onDragStart(event: ReactDragEvent<HTMLButtonElement>) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-ruukoto-tab", id);
        setTabHoverPaused(items => ({ ...items, [scope]: true }));
        // 进入拖放预览后再隐藏源标签，保留浏览器捕获的原生拖影。
        setDraggingTab({ scope, id, sessionId: currentId });
      },
      onDragEnd() { setDraggingTab(null); setTabHoverPaused(items => ({ ...items, [scope]: true })); },
      onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
        if (!event.altKey || !event.shiftKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
        event.preventDefault();
        const order = scope === "session" ? openSessions : tabs.map(tab => tab.id);
        const target = order[order.indexOf(id) + (event.key === "ArrowLeft" ? -1 : 1)];
        if (!target) return;
        setTabHoverPaused(items => ({ ...items, [scope]: true }));
        moveTab(scope, id, target);
        const button = event.currentTarget;
        window.requestAnimationFrame(() => button.focus());
      },
    };
  }
  function openSession(id: string) {
    setCurrentId(id);
    setOpenSessions(items => items.includes(id) ? items : [...items, id]);
    setScenario("normal");
  }
  function closeSession(id: string) {
    if (openSessions.length === 1) return;
    const index = openSessions.indexOf(id);
    const rest = openSessions.filter(item => item !== id);
    setOpenSessions(rest);
    if (currentId === id) openSession(rest[Math.max(0, index - 1)]);
  }
  function newSession(workspaceId: string) {
    const item: Session = { id: crypto.randomUUID(), title: "新会话", status: "idle", steps: [], subagents: [], diffs: [], draft: "", attachments: [], pendingSubmission: null, model: session.model, effort: session.effort, context: { usedTokens: 0, maxTokens: session.context.maxTokens, systemTokens: 0, toolTokens: 0 }, mode: session.mode, continuing: false };
    setWorkspaces(items => items.map(ws => ws.id === workspaceId ? { ...ws, expanded: true, sessions: [...ws.sessions, item] } : ws));
    openSession(item.id);
    input.current?.focus();
  }
  function openRight(tab: RightTab) {
    if (isPersonal && ["diff", "files", "file"].includes(tab.type)) return;
    if (tab.type === "git" && !gitRepository) return;
    setInspector(true);
    const existing = tabs.find(item => item.id === tab.id);
    if (!existing) setRightTabs(items => ({ ...items, [currentId]: activeTab?.type === "new" ? tabs.map(item => item.id === activeTab.id ? tab : item) : [...tabs, tab] }));
    setRightActive(items => ({ ...items, [currentId]: tab.id }));
  }
  function openDiff(path: string) {
    if (isPersonal) return;
    const diff = session.diffs.find(item => item.fullPath === path);
    if (diff) openRight({ id: path, type: "diff", title: diff.file, objectId: path });
  }
  function openAgent(name: string) {
    const agent = session.subagents.find(item => item.name === name);
    if (agent) openRight({ id: agent.id, type: "agent", title: agent.name, objectId: agent.id });
  }
  function updateRight(id: string, update: (tab: RightTab) => RightTab) {
    setRightTabs(items => ({ ...items, [currentId]: (items[currentId] ?? defaultRightTabs(session)).map(tab => tab.id === id ? update(tab) : tab) }));
  }
  function openFiles() {
    if (!workspace) return;
    openRight({ id: `files:${workspace.id}`, type: "files", title: "文件树" });
  }
  function openFile(path: string) {
    if (!workspace) return;
    openRight({ id: fileTabId(workspace.id, path), type: "file", title: path.split("/").at(-1) ?? path, objectId: path, mode: "preview" });
  }
  function openBrowser(address?: string) {
    const existing = tabs.find(tab => tab.type === "browser");
    if (existing?.type === "browser" && address) updateRight(existing.id, tab => tab.type === "browser" ? { ...tab, navigation: navigateBrowser(tab.navigation, address) } : tab);
    openRight(existing ?? { id: "browser:main", type: "browser", title: "浏览器", navigation: browserNavigation(address ?? new URL("/browser-preview.html", window.location.origin).href) });
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
      updateSessionById(id, item => completeSubmission(item, pending));
      submissionTimers.current.delete(id);
    }, 1200);
    submissionTimers.current.set(id, timer);
  }
  function send() {
    if (blocked) return;
    if (stopping) { updateSession(item => ({ ...item, continuing: true })); setScenario("normal"); return; }
    startSubmission(!!executionPhase || scenario === "paused");
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
        const className = "relative rounded bg-muted px-[0.3rem] py-[0.1rem] font-mono text-[13px] font-normal wrap-anywhere";
        const code = <code key={index} className={className}>{diff ? value.split("/").map((segment, n) => <Fragment key={n}>{n > 0 && "/"}{n > 0 && <wbr />}{segment}</Fragment>) : value}</code>;
        return diff ? <a key={index} href="#right-sidebar" aria-label={value} onClick={event => { event.preventDefault(); openDiff(value); }}>{code}</a> : code;
      }
      return part.startsWith("**") ? <strong key={index}>{part.slice(2, -2)}</strong> : part;
    });
  }
  function renderSteps(steps: Step[], scope: string) {
    return steps.map((step, index) => {
      const key = `${currentId}:${scope}:${step.type === "activity" && step.phase ? "execution" : index}`;
      let content: ReactNode;
      if (step.type === "user") content = <Message align="end"><MessageContent><Bubble align="end" variant="muted"><BubbleContent className="whitespace-pre-wrap selectable-text">{step.text}</BubbleContent></Bubble></MessageContent></Message>;
      else if (step.type === "prose") content = <Message><MessageContent><p className="whitespace-pre-wrap text-pretty selectable-text">{renderProse(step.text)}</p></MessageContent></Message>;
      else if (step.type === "activity") content = <ToolActivity step={step} diffs={session.diffs} stateKey={key} expanded={expanded} onExpand={(id, value) => setExpanded(items => ({ ...items, [id]: value }))} onOpenFile={openFile} onOpenAgent={openAgent} />;
      else {
        if (step.type !== "command" || step.status !== "pending") return null;
        content = <Item asChild variant="muted" size="sm"><section aria-label="命令审批"><ItemHeader className="flex-wrap"><ItemTitle>在工作区运行命令</ItemTitle><ItemActions><Button variant="ghost" size="sm" onClick={() => updateSession(item => ({ ...item, steps: item.steps.map(s => s.type === "command" && s.id === step.id ? { ...s, status: "skipped" } : s) }))}>拒绝</Button><Button size="sm" onClick={() => updateSession(item => ({ ...item, steps: item.steps.map(s => s.type === "command" && s.id === step.id ? { ...s, status: "approved" } : s) }))}>批准</Button></ItemActions></ItemHeader><ItemContent className="min-w-0 basis-full gap-3"><pre tabIndex={0} className="command-preview max-w-full overflow-x-auto rounded-lg bg-muted p-3 text-sm selectable-text"><code><span className="text-muted-foreground select-none">$ </span>{step.command}</code></pre><ItemDescription className="line-clamp-none">{step.note}</ItemDescription></ItemContent></section></Item>;
      }
      return <MessageScrollerItem key={key} messageId={key} className={step.type === "activity" ? "trace-step" : undefined}>{content}</MessageScrollerItem>;
    });
  }
  const mainSteps = executionPhase ? executionPreview(session, executionPhase) : scenario === "tool-details" && !isPersonal ? toolDetailsPreview(session) : session.steps;
  const selectedAgent = activeTab?.type === "agent" ? session.subagents.find(item => item.id === activeTab.objectId) : undefined;
  const selectedDiff = activeTab?.type === "diff" ? session.diffs.find(item => item.fullPath === activeTab.objectId) : undefined;
  const availableFiles = workspace ? workspaceFiles(workspace.id) : [];
  const selectedFile = activeTab?.type === "file" ? availableFiles.find(file => file.path === activeTab.objectId) : undefined;
  const browserTab = tabs.find(tab => tab.type === "browser");
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
            <TabsTrigger value="personal-connection"><Server />PA 远程连接</TabsTrigger>
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
        <TabsContent value="personal-connection" className="settings-panel">
          <h2>PA 远程连接</h2>
          <PersonalConnectionSettings config={personalConnection} onSave={setPersonalConnection} />
        </TabsContent>
        <TabsContent value="scenarios" className="settings-panel">
          <h2>演示状态</h2>
          <div className="settings-row"><label htmlFor="settings-scenario">预览状态</label>
            <Select value={scenario} onValueChange={value => selectScenario(value as Scenario)}>
              <SelectTrigger id="settings-scenario" aria-label="预览状态"><SelectValue /></SelectTrigger>
              <SelectContent position="popper" align="end" sideOffset={6}>{scenarios.filter(item => !isPersonal || (item.value !== "tool-details" && !item.value.startsWith("diff-"))).map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </TabsContent>
      </Tabs>
    </DialogContent>
  </Dialog>;

  return <><div className="desktop-backdrop"><div className="macos-window app-window" data-sidebar-open={sidebar} style={{ "--left-preferred-width": sidebarWidths.left === undefined ? undefined : `${sidebarWidths.left}px`, "--right-preferred-width": sidebarWidths.right === undefined ? undefined : `${sidebarWidths.right}px`, "--right-reserve": inspectorOpen ? "260px" : "0px", "--visible-left-width": sidebar ? "var(--left-width)" : "0px" } as CSSProperties}>
    <Button ref={expandSidebar} type="button" variant="ghost" size="icon" className="quiet-icon sidebar-toggle" aria-label={sidebar ? "收起侧栏" : "展开侧栏"} aria-controls="left-sidebar" aria-expanded={sidebar} onClick={toggleSidebar}><PanelLeft /></Button>
    <aside id="left-sidebar" className={`surface-sidebar left-sidebar ${sidebar ? "" : "is-collapsed"}`} aria-label="工作区导航" aria-hidden={!sidebar} inert={!sidebar}><div className="sidebar-content"><div className="window-controls"><div className="traffic-lights" aria-hidden="true"><i /><i /><i /></div></div><Button type="button" variant="ghost" className={`personal-row ${isPersonal ? "active-pill text-pri" : "text-sec hover-pill"}`} aria-current={isPersonal ? "page" : undefined} onClick={() => openSession(PERSONAL_SESSION_ID)}>Ruukoto</Button><div className="projects-heading"><span>工作区</span><div><Button ref={filterToggle} type="button" variant="ghost" size="icon" className="quiet-icon" aria-label="筛选工作区与会话" aria-controls="workspace-filter" aria-expanded={filterOpen} onClick={() => { setFilterOpen(value => !value); setFilter(""); }}><ListFilter /></Button><IconButton label="添加工作区" onClick={() => setDialog("workspace")}><Plus /></IconButton></div></div><div id="workspace-filter" className="workspace-filter" data-open={filterOpen} aria-hidden={!filterOpen} inert={!filterOpen}><div className="workspace-filter-clip"><div className="workspace-filter-inner"><Input ref={filterInput} aria-label="筛选工作区与会话" placeholder="筛选工作区与会话…" value={filter} onChange={event => setFilter(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { setFilterOpen(false); setFilter(""); filterToggle.current?.focus(); } }} /></div></div></div><div className="workspace-tree">{workspaces.filter(ws => !filter || ws.name.toLowerCase().includes(filter.toLowerCase()) || ws.sessions.some(item => item.title.toLowerCase().includes(filter.toLowerCase()))).map(ws => <Collapsible asChild key={ws.id} open={ws.expanded || !!filter} onOpenChange={() => setWorkspaces(items => items.map(item => item.id === ws.id ? { ...item, expanded: !item.expanded } : item))}><section><div className="workspace-row"><CollapsibleTrigger asChild><button><ChevronRight className={ws.expanded || filter ? "rotate-90" : ""} /><Folder /><span>{ws.name}</span></button></CollapsibleTrigger><IconButton className="workspace-add" label={`在 ${ws.name} 新建会话`} onClick={() => newSession(ws.id)}><Plus /></IconButton></div><CollapsibleContent className="workspace-collapse" inert={!ws.expanded && !filter} aria-hidden={!ws.expanded && !filter}><div className="workspace-sessions">{ws.sessions.filter(item => !filter || ws.name.toLowerCase().includes(filter.toLowerCase()) || item.title.toLowerCase().includes(filter.toLowerCase())).map(item => <button key={item.id} className={`workspace-session ${item.id === currentId ? "active-pill text-pri" : "text-sec hover-pill"}`} aria-current={item.id === currentId ? "page" : undefined} onClick={() => openSession(item.id)}><span>{item.title}</span>{["awaiting", "running"].includes(item.status) && <i className="status-point pending" />}</button>)}</div></CollapsibleContent></section></Collapsible>)}</div><div className="sidebar-bottom">{settings}</div></div><SidebarResizer side="left" open={sidebar} onWidthChange={width => setSidebarWidths(items => ({ ...items, left: width }))} /></aside>

    <div className="content-area"><header className="surface-sidebar canvas-header"><div className="session-header"><Tabs ref={sessionTabList} className="center-tabs" value={currentId} onValueChange={openSession}><TabsList aria-label="已打开的会话" {...tabListProps("session")}>{openSessions.map(id => { const item = allSessions.find(s => s.id === id)!; return <div className="tab-group" key={id} {...tabGroupProps("session", id)}><TabsTrigger value={id} className="center-tab" {...tabOrderProps("session", id)}>{["awaiting", "running"].includes(item.status) && <i className="status-point pending" />}<span>{item.title}</span></TabsTrigger><button className="tab-close" aria-label={`关闭${item.title}`} disabled={openSessions.length === 1} onClick={() => closeSession(id)}><X /></button></div>; })}</TabsList></Tabs></div><div className={`inspector-header ${inspectorOpen ? "" : "is-collapsed"}`}><div className="right-header" aria-hidden={!inspectorOpen} inert={!inspectorOpen}><Tabs ref={rightTabList} className="right-tabs" value={activeTab?.id ?? ""} onValueChange={id => setRightActive(items => ({ ...items, [currentId]: id }))}><TabsList aria-label="右侧标签" {...tabListProps("right")}>{tabs.map(tab => <div className="tab-group" key={tab.id} {...tabGroupProps("right", tab.id)}><TabsTrigger value={tab.id} className="right-tab" {...tabOrderProps("right", tab.id)} aria-label={tab.type === "file" ? `${tab.objectId} 文件预览` : undefined}>{tab.type === "diff" ? <FileCode2 className="file-icon" /> : tab.type === "agent" ? <Sparkles className="agent-icon" /> : tab.type === "browser" ? <Globe /> : tab.type === "files" ? <FolderTree /> : tab.type === "git" ? <GitGraph /> : tab.type === "file" ? <FileText /> : <Plus />}<span>{tab.title}</span></TabsTrigger><button className="tab-close" aria-label={tab.type === "file" ? `关闭文件预览 ${tab.objectId}` : `关闭右栏${tab.title}`} onClick={() => closeRight(tab.id)}><X /></button></div>)}</TabsList></Tabs><IconButton label="右栏新标签" onClick={() => { const tab: RightTab = { id: crypto.randomUUID(), type: "new", title: "新标签" }; setRightTabs(items => ({ ...items, [currentId]: [...tabs, tab] })); setRightActive(items => ({ ...items, [currentId]: tab.id })); }}><Plus /></IconButton></div><IconButton label={inspector ? "收起右栏" : "展开右栏"} buttonRef={inspectorToggle} onClick={toggleInspector}><PanelRight /></IconButton></div></header><div className="content-body"><main className="surface-canvas main-canvas">
      {scenario === "offline" ? <div className="empty-state"><div className="empty-symbol"><WifiOff /></div><h1>暂时无法连接</h1><p>请确认本地后台已启动，然后重新连接。</p><Button onClick={() => setScenario("normal")}>重新连接</Button><span>前端演示，不建立真实连接。</span></div> : <><MessageScrollerProvider key={`main:${currentId}`} autoScroll defaultScrollPosition="start"><MessageScroller className="conversation"><MessageScrollerViewport className="stream-scroll selectable-text" aria-label="会话消息"><MessageScrollerContent className="agent-stream native-message-stream">{renderSteps(mainSteps, scenario === "tool-details" ? "tool-preview" : "main")}</MessageScrollerContent></MessageScrollerViewport></MessageScroller></MessageScrollerProvider>
        <div className="composer-wrap"><div className="composer-width">{scenario === "paused" && <div className="task-notice"><Pause /><span>队列暂停 · 2 个任务等待继续</span><Button variant="ghost" size="sm" onClick={() => setDialog("resume")}>恢复队列</Button></div>}{session.continuing && <div className="task-notice"><span>正在继续中断的任务</span><Button variant="ghost" size="sm" disabled={checking} onClick={() => updateSession(item => ({ ...item, continuing: false }))}>改为新任务</Button></div>}<form className="surface-composer composer" onSubmit={event => { event.preventDefault(); send(); }}><input ref={attachmentInput} type="file" multiple hidden aria-label="选择附件" onChange={event => { const attachments = Array.from(event.currentTarget.files ?? [], file => ({ id: crypto.randomUUID(), name: file.name, size: file.size })); updateSession(item => ({ ...item, attachments: [...item.attachments, ...attachments] })); event.currentTarget.value = ""; }} />{session.attachments.length > 0 && <div className="attached-files" aria-label="已附加文件">{session.attachments.map(attachment => <span className="attachment-chip" key={attachment.id}><FileCode2 /><span>{attachment.name}</span><button type="button" disabled={checking} aria-label={`移除附件 ${attachment.name}`} onClick={() => updateSession(item => ({ ...item, attachments: item.attachments.filter(file => file.id !== attachment.id) }))}><X /></button></span>)}</div>}<Textarea ref={input} aria-label="输入消息" rows={2} readOnly={checking} value={session.draft} placeholder={session.continuing ? "输入继续任务的指示…" : "描述你想做的事…"} onChange={event => updateSession(item => ({ ...item, draft: event.target.value }))} onKeyDown={event => submitOnEnter(event, hasInput && !blocked, send)} /><div className="composer-actions"><div className="composer-left"><IconButton className="attachment-button" label="附加文件" disabled={blocked} onClick={() => attachmentInput.current?.click()}><Plus /></IconButton><Select value={session.mode} onValueChange={mode => updateSession(item => ({ ...item, mode }))} disabled={blocked}><SelectTrigger className="mode-selector" aria-label="会话默认模式" aria-description={modeOption.label}><SelectValue><modeOption.icon className="mode-icon" aria-hidden="true" /><span className="mode-selector-label">{modeOption.label}</span></SelectValue></SelectTrigger><SelectContent className="composer-menu" position="popper" side="top" align="start" sideOffset={6}>{sessionModes.map(mode => <SelectItem key={mode.value} value={mode.value} textValue={mode.label}><mode.icon className="mode-icon" aria-hidden="true" /><span>{mode.label}</span></SelectItem>)}</SelectContent></Select></div><div className="composer-right"><HoverCard openDelay={10} closeDelay={100}><HoverCardTrigger asChild><Button type="button" variant="ghost" size="icon" className="context-usage" aria-label="上下文使用量" aria-description={`${session.context.usedTokens.toLocaleString("en-US")} / ${session.context.maxTokens.toLocaleString("en-US")} tokens`}><svg data-slot="context-ring" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="4" strokeOpacity="0.25" /><circle data-slot="context-ring-value" cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="4" strokeLinecap="round" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - contextPercent} transform="rotate(-90 12 12)" opacity={contextPercent === 0 ? 0 : 1} /></svg></Button></HoverCardTrigger><HoverCardContent side="top" align="start" alignOffset={-16} sideOffset={8} className="context-details"><ContextDetails context={session.context} /></HoverCardContent></HoverCard><DropdownMenu><DropdownMenuTrigger asChild><Button type="button" variant="ghost" className="model-selector" aria-label="会话模型" aria-description={`${session.model} · Effort: ${session.effort}`} disabled={blocked}><Brain className="model-selector-icon" /><span className="model-selector-name">{session.model}</span><ChevronDown className="model-selector-chevron" /></Button></DropdownMenuTrigger><DropdownMenuContent className="composer-menu model-menu" side="top" align="end" sideOffset={6} aria-label="模型与 Effort"><DropdownMenuRadioGroup aria-label="会话模型" value={session.model} onValueChange={model => updateSession(item => ({ ...item, model }))}><DropdownMenuRadioItem value="Claude 3.7 Sonnet">Claude 3.7 Sonnet</DropdownMenuRadioItem><DropdownMenuRadioItem value="o3-mini">o3-mini</DropdownMenuRadioItem><DropdownMenuRadioItem value="DeepSeek R1" disabled>DeepSeek R1 · 认证不可用</DropdownMenuRadioItem></DropdownMenuRadioGroup><DropdownMenuSeparator /><DropdownMenuLabel>Effort</DropdownMenuLabel><DropdownMenuRadioGroup aria-label="Effort" value={session.effort} onValueChange={effort => updateSession(item => ({ ...item, effort }))}><DropdownMenuRadioItem value="Low">Low</DropdownMenuRadioItem><DropdownMenuRadioItem value="Medium">Medium</DropdownMenuRadioItem><DropdownMenuRadioItem value="High">High</DropdownMenuRadioItem></DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu><Button size="icon" className="send-button" type="submit" disabled={blocked || (!stopping && !hasInput)} aria-label={submitLabel} aria-busy={checking}>{checking ? <Loader2 className="animate-spin" /> : stopping ? <Square fill="currentColor" /> : <ArrowUp />}</Button></div></div></form></div></div></>}
    </main>

    <aside id="right-sidebar" className={`surface-inspector right-sidebar ${inspectorOpen ? "" : "is-collapsed"}`} aria-label="检查器" aria-hidden={!inspectorOpen} inert={!inspectorOpen}><div className="sidebar-content"><div className={`right-viewport ${["browser", "files", "file", "git"].includes(activeTab?.type ?? "") ? "utility-viewport" : ""}`}>{browserTab && <div className="browser-container" hidden={activeTab?.type !== "browser"} aria-hidden={activeTab?.type !== "browser"} inert={activeTab?.type !== "browser"}><BrowserPanel key={`${currentId}:${browserTab.id}`} navigation={browserTab.navigation} appOrigin={window.location.origin} onChange={navigation => updateRight(browserTab.id, tab => tab.type === "browser" ? { ...tab, navigation } : tab)} /></div>}{activeTab?.type === "browser" ? null : activeTab?.type === "git" && gitRepository && workspace ? <GitGraphPanel name={workspace.name} repository={gitRepository} /> : activeTab?.type === "files" && workspace ? <WorkspaceFiles name={workspace.name} files={availableFiles} expanded={fileFolders[workspace.id] ?? {}} onExpand={(path, open) => setFileFolders(items => ({ ...items, [workspace.id]: { ...items[workspace.id], [path]: open } }))} onOpen={openFile} /> : activeTab?.type === "file" && workspace ? <FilePreview file={selectedFile} path={activeTab.objectId} mode={activeTab.mode} onMode={mode => updateRight(activeTab.id, tab => tab.type === "file" ? { ...tab, mode } : tab)} onFiles={openFiles} onUrl={openBrowser} /> : selectedAgent ? <><MessageScrollerProvider key={`child:${currentId}:${selectedAgent.id}`} autoScroll defaultScrollPosition="start"><MessageScroller className="conversation subagent-conversation"><MessageScrollerViewport aria-label="子 Agent 消息"><MessageScrollerContent className="subagent-stream native-message-stream selectable-text">{renderSteps(selectedAgent.steps, selectedAgent.id)}</MessageScrollerContent></MessageScrollerViewport></MessageScroller></MessageScrollerProvider></> : displayedDiff ? <><div className="diff-heading"><span>{displayedDiff.fullPath}</span>{(displayedDiff.add > 0 || displayedDiff.del > 0) && <code><b>+{displayedDiff.add}</b><em>−{displayedDiff.del}</em></code>}</div>{scenario === "diff-error" ? <div className="diff-error"><FileCode2 /><p>差异读取失败</p><Button variant="ghost" size="sm" onClick={() => setScenario("normal")}>重试</Button></div> : <><div className="diff-view selectable-text"><div className="diff-lines">{displayedDiff.lines.slice(0, diffLimit).map((line, index) => <div className={`diff-line ${line.type === "add" ? "diff-line-add" : line.type === "del" ? "diff-line-del" : ""}`} key={index}><span>{line.no}</span><span>{line.type === "add" ? "+" : line.type === "del" ? "−" : " "}</span><code>{line.code}</code></div>)}</div></div>{displayedDiff.lines.length > diffLimit && <button className="diff-more" onClick={() => setDiffLimits(items => ({ ...items, [diffKey]: diffLimit + 20 }))}>more</button>}</>}</> : <div className="new-tab-page"><p>打开</p><button className="surface-flat" onClick={() => openBrowser()}><Globe /><span>浏览器</span></button>{!isPersonal && <><button className="surface-flat" onClick={openFiles}><FolderTree /><span>文件树</span></button>{gitRepository && <button className="surface-flat" onClick={() => openRight({ id: `git:${workspace!.id}`, type: "git", title: "Git graph" })}><GitGraph /><span>Git graph</span></button>}</>}</div>}</div></div><SidebarResizer side="right" open={inspectorOpen} onWidthChange={width => setSidebarWidths(items => ({ ...items, right: width }))} /></aside>
  </div></div></div></div>

  <Dialog open={dialog !== null} onOpenChange={open => { if (!open) setDialog(null); }}><DialogContent className="demo-dialog"><DialogHeader><DialogTitle>{dialog === "workspace" ? "添加工作区" : "恢复队列"}</DialogTitle><DialogDescription>{dialog === "workspace" ? "添加一个模拟工作区，不访问本机文件。" : `为 2 个旧任务补齐 ${session.model}，然后恢复队列。`}</DialogDescription></DialogHeader>{dialog === "workspace" && <Input aria-label="工作区名称" placeholder="工作区名称" value={workspaceName} onChange={event => setWorkspaceName(event.target.value)} />}<DialogFooter><Button variant="ghost" onClick={() => setDialog(null)}>取消</Button><Button disabled={dialog === "workspace" ? !workspaceName.trim() || workspaces.some(ws => ws.name === workspaceName.trim()) : false} onClick={() => { if (dialog === "workspace") { const id = crypto.randomUUID(); const item: Session = { id: crypto.randomUUID(), title: "新会话", status: "idle", steps: [], subagents: [], diffs: [], draft: "", attachments: [], pendingSubmission: null, model: session.model, effort: session.effort, context: { usedTokens: 0, maxTokens: session.context.maxTokens, systemTokens: 0, toolTokens: 0 }, mode: session.mode, continuing: false }; setWorkspaces(items => [...items, { id, name: workspaceName.trim(), expanded: true, sessions: [item] }]); openSession(item.id); setWorkspaceName(""); } else if (dialog === "resume") { setScenario("normal"); setToast("演示：已补齐模型，队列已恢复"); } setDialog(null); }}>{dialog === "workspace" ? "添加" : "补齐模型并恢复"}</Button></DialogFooter></DialogContent></Dialog>
  <span className="sr-only" role="status">{tabAnnouncement}</span>
  {toast && <div className="surface-card toast-pill" role="status"><i className="status-point" />{toast}</div>}
  </>;
}
