import type { ComponentType } from "react";
import { Archive, Blocks, Brain, Moon, Puzzle, Server, Settings, Sun } from "lucide-react";
import type { DesktopTarget } from "../shared/bridge.ts";
import type { CodeState } from "./code-state.ts";
import { SettingsState, type ManagedSettingsCategory, type SettingsCategory, type SettingsScope, type SettingsSources } from "./settings-state.ts";
import { PersonalConnectionSettings } from "./personal-connection-settings.tsx";
import { CodeModelsSettings } from "./code-models-settings.tsx";
import { Button } from "./components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./components/ui/dialog.tsx";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "./components/ui/field.tsx";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs.tsx";

export interface SettingsPageProps {
  category: ManagedSettingsCategory;
  scope: SettingsScope;
  settings: SettingsState;
  code: CodeState;
  personal: CodeState;
}
export interface SettingsContentsProps {
  settings: SettingsState;
  code: CodeState;
  personal: CodeState;
  dark: boolean;
  onDark: (dark: boolean) => void;
  onAddWorkspace: () => void;
  pages?: Partial<Record<ManagedSettingsCategory, ComponentType<SettingsPageProps>>>;
  mcpSources?: SettingsSources;
}
const categories = [
  { value: "appearance", label: "外观", icon: Sun },
  { value: "models", label: "模型", icon: Brain },
  { value: "skills", label: "Skills", icon: Puzzle },
  { value: "mcp", label: "MCP", icon: Blocks },
  { value: "personal", label: "PA 远程连接", icon: Server },
  { value: "archived", label: "已存档会话", icon: Archive },
] as const;

function SettingsScopeFields({ category, settings, code, personal, onAddWorkspace, mcpSources }: SettingsContentsProps & { category: ManagedSettingsCategory }) {
  const scope = settings.scope(code, personal);
  const blocked = settings.form?.phase === "saving" || settings.form?.phase === "unknown";
  const workspaces = code.view.projects.filter(project => project.rootDir !== null);
  const sources = mcpSources?.instanceId === scope.instanceId && mcpSources.workspaceId === scope.workspaceId ? mcpSources.items : null;
  const source = sources ? sources.find(source => source.id === scope.sourceId) : code.view.projects.find(project => project.id === scope.sourceId);
  if (scope.target !== "code" || category !== "mcp") return null;
  return <FieldGroup className="settings-scope">
      <Field><FieldLabel htmlFor="settings-workspace">工作区</FieldLabel>{workspaces.length ? <Select value={scope.workspaceId ?? ""} disabled={blocked} onValueChange={value => settings.chooseWorkspace(value)}><SelectTrigger id="settings-workspace"><SelectValue placeholder="选择工作区" /></SelectTrigger><SelectContent><SelectGroup>{workspaces.map(project => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}</SelectGroup></SelectContent></Select> : <><FieldDescription>先添加工作区，再管理该工作区的 MCP。</FieldDescription><Button type="button" variant="outline" size="sm" disabled={code.status.state !== "online" || blocked} onClick={onAddWorkspace}>添加工作区</Button></>}</Field>
      {scope.workspaceId && <Field><FieldLabel htmlFor="settings-source">配置来源</FieldLabel>{sources && (sources.length > 1 || sources.length === 1 && !source) ? <Select value={scope.sourceId ?? ""} disabled={blocked} onValueChange={value => { if (sources.some(source => source.id === value)) settings.chooseSource(value); }}><SelectTrigger id="settings-source"><SelectValue placeholder="选择配置来源" /></SelectTrigger><SelectContent><SelectGroup>{sources.map(source => <SelectItem key={source.id} value={source.id}>{source.name}</SelectItem>)}</SelectGroup></SelectContent></Select> : <p id="settings-source">{source?.name ?? "尚未选择来源"}</p>}<FieldDescription>写入所选原配置来源；工作区组织归属不迁移配置。{!sources && "配置来源列表尚未接入。"}</FieldDescription></Field>}
  </FieldGroup>;
}

function UnavailableSettingsPage({ scope, code, settings }: SettingsPageProps) {
  return <div className="settings-availability"><p className="settings-hint" role="status">此类别的配置管理尚未接入，当前只读。{scope.target === "personal" ? "新 Personal 管理连接尚未接入，旧 PA 连接不能用于这些设置。" : code.status.state !== "online" ? "本地 Code 已离线，请恢复后台连接后使用。" : ""}</p>{scope.target === "personal" && <Button type="button" variant="outline" size="sm" onClick={() => settings.chooseCategory("personal")}>查看 PA 远程连接</Button>}</div>;
}

function ManagedSettingsPage(props: SettingsContentsProps & { category: ManagedSettingsCategory }) {
  const { category, settings, code, personal } = props;
  const scope = settings.scope(code, personal, props.mcpSources);
  if (category === "mcp" && scope.target === "code" && !props.mcpSources) scope.sourceId = null;
  const Page = props.pages?.[category] ?? (category === "models" && scope.target === "code" ? CodeModelsSettings : UnavailableSettingsPage);
  const blocked = settings.form?.phase === "saving" || settings.form?.phase === "unknown";
  return <Tabs value={scope.target} onValueChange={value => settings.chooseTarget(category, value as DesktopTarget)} className="settings-target-tabs"><TabsList aria-label="配置目标"><TabsTrigger value="code" disabled={blocked}>Code</TabsTrigger><TabsTrigger value="personal" disabled={blocked}>PA</TabsTrigger></TabsList><TabsContent value={scope.target}><SettingsScopeFields {...props} /><Page key={`${category}:${settings.pageKey}`} category={category} scope={scope} settings={settings} code={code} personal={personal} /></TabsContent></Tabs>;
}

// Note: 见 .agents/notes/implemented/feature/2026-10-21-desktop-settings-shell.md
export function SettingsContents(props: SettingsContentsProps) {
  const { settings, code, personal, dark, onDark } = props;
  return <Tabs value={settings.category} onValueChange={value => settings.chooseCategory(value as SettingsCategory)} orientation="vertical" className="settings-tabs"><div className="settings-navigation"><h2 id="settings-navigation-title">设置</h2><TabsList className="settings-categories" aria-label="设置类别">{categories.map(item => { const Icon = item.value === "appearance" && dark ? Moon : item.icon; return <TabsTrigger key={item.value} value={item.value}><Icon />{item.label}</TabsTrigger>; })}</TabsList></div>
    {categories.map(item => <TabsContent key={item.value} value={item.value} className="settings-panel"><h2>{item.label}</h2>
      {item.value === "appearance" ? <FieldGroup><Field orientation="horizontal" className="settings-row"><FieldLabel htmlFor="settings-theme">主题</FieldLabel><Select value={dark ? "dark" : "light"} onValueChange={value => onDark(value === "dark")}><SelectTrigger id="settings-theme"><SelectValue /></SelectTrigger><SelectContent position="popper" align="end" sideOffset={6}><SelectGroup><SelectItem value="light">浅色</SelectItem><SelectItem value="dark">深色</SelectItem></SelectGroup></SelectContent></Select></Field></FieldGroup>
        : item.value === "personal" ? <PersonalConnectionSettings settings={settings} />
          : item.value === "archived" ? <><p className="settings-hint">存档只把这些会话从左栏隐藏，历史与任务仍保留。</p>{code.archivedSessions().length ? <ul className="archived-sessions">{code.archivedSessions().map(session => <li key={session.id}><div><span>{code.sessionName(session.id)}</span><small>{code.view.projects.find(project => project.id === (session.workspaceProjectId ?? session.projectId))?.name ?? "未知工作区"} · {session.archivedAt?.slice(0, 10)}</small></div><Button type="button" variant="ghost" size="sm" className="unarchive-button" aria-label={`取消存档 ${code.sessionName(session.id)}`} disabled={code.status.state !== "online"} onClick={() => void code.setArchived(session.id, false)}><Archive /><span>取消存档</span></Button></li>)}</ul> : <p className="settings-hint">没有已存档的会话。</p>}</>
            : <ManagedSettingsPage {...props} category={item.value} />}
    </TabsContent>)}
  </Tabs>;
}

export function SettingsDialog(props: SettingsContentsProps & { defaultTarget: DesktopTarget; onCloseAutoFocus: (event: Event) => void }) {
  const { settings } = props;
  const busy = settings.form?.phase === "saving" || settings.form?.phase === "unknown";
  return <><Dialog open={settings.open} onOpenChange={open => { if (open) settings.show(props.defaultTarget, props.code); else settings.close(); }}>
    <DialogTrigger asChild><Button type="button" variant="ghost" size="icon" className="quiet-icon" aria-label="设置"><Settings /></Button></DialogTrigger>
    <DialogContent className="settings-dialog" onCloseAutoFocus={props.onCloseAutoFocus}><DialogTitle className="sr-only">设置</DialogTitle><DialogDescription className="sr-only">选择左侧类别查看设置项，配置目标独立于聊天。</DialogDescription><SettingsContents {...props} />{settings.message && <p className="settings-notice" role="status">{settings.message}</p>}</DialogContent>
  </Dialog><Dialog open={!!settings.leave} onOpenChange={open => { if (!open) settings.continueEditing(); }}><DialogContent className="demo-dialog"><DialogHeader><DialogTitle>保留未保存的更改？</DialogTitle><DialogDescription>保存后继续刚才的操作，或放弃本页草稿。</DialogDescription></DialogHeader><p role="status">{busy ? settings.form?.phase === "saving" ? "正在保存，请等待完成。" : "保存结果待核实，请继续编辑并核实原配置。" : "更改尚未保存。"}</p><DialogFooter><Button type="button" variant="ghost" onClick={() => settings.continueEditing()}>继续编辑</Button><Button type="button" variant="outline" disabled={busy} onClick={() => settings.discardAndLeave()}>放弃更改</Button><Button type="button" disabled={busy} onClick={() => void settings.saveAndLeave()}>保存并继续</Button></DialogFooter></DialogContent></Dialog></>;
}
