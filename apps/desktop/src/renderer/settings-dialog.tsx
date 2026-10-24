import type { ComponentType } from "react";
import { Archive, Blocks, Brain, Moon, Puzzle, Server, Settings, Sun } from "lucide-react";
import type { DesktopTarget } from "../shared/bridge.ts";
import type { CodeState } from "./code-state.ts";
import { SettingsState, type ManagedSettingsCategory, type SettingsCategory, type SettingsScope } from "./settings-state.ts";
import { PersonalConnectionSettings } from "./personal-connection-settings.tsx";
import { CodeModelsSettings } from "./code-models-settings.tsx";
import { CodeMcpSettings } from "./code-mcp-settings.tsx";
import { CodeSkillsSettings } from "./code-skills-settings.tsx";
import { PersonalSettingsPage } from "./personal-settings-pages.tsx";
import { Button } from "./components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./components/ui/dialog.tsx";
import { Field, FieldGroup, FieldLabel } from "./components/ui/field.tsx";
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
  pages?: Partial<Record<ManagedSettingsCategory, ComponentType<SettingsPageProps>>>;
}
const categories = [
  { value: "appearance", label: "外观", icon: Sun },
  { value: "models", label: "模型", icon: Brain },
  { value: "skills", label: "Skills", icon: Puzzle },
  { value: "mcp", label: "MCP", icon: Blocks },
  { value: "personal", label: "PA 远程连接", icon: Server },
  { value: "archived", label: "已存档会话", icon: Archive },
] as const;

function ManagedSettingsPage(props: SettingsContentsProps & { category: ManagedSettingsCategory }) {
  const { category, settings, code, personal } = props;
  const scope = settings.scope(code, personal);
  const Page = props.pages?.[category] ?? (scope.target === "personal" ? PersonalSettingsPage : category === "models" ? CodeModelsSettings : category === "mcp" ? CodeMcpSettings : CodeSkillsSettings);
  const blocked = settings.form?.phase === "saving" || settings.form?.phase === "unknown";
  return <Tabs value={scope.target} onValueChange={value => settings.chooseTarget(category, value as DesktopTarget)} className="settings-target-tabs"><TabsList aria-label="配置目标"><TabsTrigger value="code" disabled={blocked}>Code</TabsTrigger><TabsTrigger value="personal" disabled={blocked}>PA</TabsTrigger></TabsList><TabsContent value={scope.target}><Page key={`${category}:${settings.pageKey}`} category={category} scope={scope} settings={settings} code={code} personal={personal} /></TabsContent></Tabs>;
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
  return <><Dialog open={settings.open} onOpenChange={open => { if (open) settings.show(props.defaultTarget); else settings.close(); }}>
    <DialogTrigger asChild><Button type="button" variant="ghost" size="icon" className="quiet-icon" aria-label="设置"><Settings /></Button></DialogTrigger>
    <DialogContent className="settings-dialog" onCloseAutoFocus={props.onCloseAutoFocus}><DialogTitle className="sr-only">设置</DialogTitle><DialogDescription className="sr-only">选择左侧类别查看设置项，配置目标独立于聊天。</DialogDescription><SettingsContents {...props} />{settings.message && <p className="settings-notice" role="status">{settings.message}</p>}</DialogContent>
  </Dialog><Dialog open={!!settings.leave && !settings.form?.confirming} onOpenChange={open => { if (!open) settings.continueEditing(); }}><DialogContent className="demo-dialog"><DialogHeader><DialogTitle>保留未保存的更改？</DialogTitle><DialogDescription>保存后继续刚才的操作，或放弃本页草稿。</DialogDescription></DialogHeader><p role="status">{busy ? settings.form?.phase === "saving" ? "正在保存，请等待完成。" : "保存结果待核实，请继续编辑并核实原配置。" : "更改尚未保存。"}</p><DialogFooter><Button type="button" variant="ghost" onClick={() => settings.continueEditing()}>继续编辑</Button><Button type="button" variant="outline" disabled={busy} onClick={() => settings.discardAndLeave()}>放弃更改</Button><Button type="button" disabled={busy} onClick={() => void settings.saveAndLeave()}>保存并继续</Button></DialogFooter></DialogContent></Dialog></>;
}
