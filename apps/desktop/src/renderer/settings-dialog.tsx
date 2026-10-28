import { useEffect, useRef } from "react";
import { Archive, ArchiveRestore, Blocks, Brain, Globe, Monitor, Moon, Puzzle, RefreshCw, Server, Settings, Sun, X } from "lucide-react";
import type { DesktopTarget } from "../shared/bridge.ts";
import type { CodeState } from "./code-state.ts";
import { SettingsState, paCategory, type ManagedSettingsCategory, type SettingsCategory, type SettingsScope } from "./settings-state.ts";
import { PersonalConnectionSettings } from "./personal-connection-settings.tsx";
import { CodeModelsSettings } from "./code-models-settings.tsx";
import { CodeMcpSettings } from "./code-mcp-settings.tsx";
import { CodeComputerSettings } from "./code-computer-settings.tsx";
import { CodeWebSearchSettings } from "./code-web-search-settings.tsx";
import { CodeSkillsSettings } from "./code-skills-settings.tsx";
import { PersonalSettingsPage } from "./personal-settings-pages.tsx";
import { Button } from "./components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./components/ui/dialog.tsx";
import { SettingsButton, SettingsSegmented } from "./components/controls.tsx";
import { SettingsCard, SettingsGroup, SettingsList, SettingsListItem, SettingsNavItem, SettingsNavSection, SettingsPage, SettingsRow, SettingsShell } from "./components/settings.tsx";

export interface SettingsPageProps {
  category: SettingsCategory;
  scope: SettingsScope;
  settings: SettingsState;
  code: CodeState;
  personal: { view: { instanceId: string | null } };
}
export interface PersonalSettingsPageProps extends Omit<SettingsPageProps, "category"> {
  category: ManagedSettingsCategory;
}
export interface SettingsContentsProps {
  settings: SettingsState;
  code: CodeState;
  personal: { view: { instanceId: string | null } };
  dark: boolean;
  onDark: (dark: boolean) => void;
  pages?: Partial<Record<SettingsCategory, React.ComponentType<SettingsPageProps>>>;
}

type NavEntry =
  | { type: "section"; label: string }
  | { type: "item"; value: SettingsCategory; label: string; icon: typeof Sun };

const navigation: ReadonlyArray<NavEntry> = [
  { type: "item", value: "appearance", label: "外观", icon: Sun },
  { type: "section", label: "Code" },
  { type: "item", value: "code-models", label: "模型", icon: Brain },
  { type: "item", value: "code-skills", label: "Skills", icon: Puzzle },
  { type: "item", value: "code-mcp", label: "MCP", icon: Blocks },
  { type: "item", value: "code-computer", label: "电脑", icon: Monitor },
  { type: "section", label: "PA" },
  { type: "item", value: "pa-models", label: "模型", icon: Brain },
  { type: "item", value: "pa-skills", label: "Skills", icon: Puzzle },
  { type: "item", value: "pa-mcp", label: "MCP", icon: Blocks },
  { type: "item", value: "pa-computer", label: "电脑", icon: Monitor },
  { type: "item", value: "web-search", label: "Web 搜索", icon: Globe },
  { type: "item", value: "personal", label: "PA 远程连接", icon: Server },
  { type: "item", value: "archived", label: "已存档会话", icon: Archive },
];

const codePages: Record<`code-${ManagedSettingsCategory}`, React.ComponentType<SettingsPageProps>> = {
  "code-models": CodeModelsSettings,
  "code-skills": CodeSkillsSettings,
  "code-mcp": CodeMcpSettings,
  "code-computer": CodeComputerSettings,
};

function AppearancePage({ dark, onDark }: { dark: boolean; onDark: (dark: boolean) => void }) {
  return (
    <SettingsPage title="外观" description="选择桌面客户端的主题。">
      <SettingsGroup title="界面">
        <SettingsCard>
          <SettingsRow title="主题" description="浅色或深色。"><SettingsSegmented label="主题" value={dark ? "dark" : "light"} onValueChange={value => onDark(value === "dark")} options={[{ value: "light", label: <><Sun aria-hidden="true" />浅色</> }, { value: "dark", label: <><Moon aria-hidden="true" />深色</> }]} /></SettingsRow>
        </SettingsCard>
      </SettingsGroup>
    </SettingsPage>
  );
}

function ArchivedPage({ code }: { code: CodeState }) {
  const sessions = code.archivedSessions();
  return (
    <SettingsPage title="已存档会话" description="存档只把会话从左栏隐藏，历史与任务仍保留。">
      <SettingsGroup title="存档列表" action={<SettingsButton variant="icon" aria-label="重新读取存档" title="重新读取存档"><RefreshCw /></SettingsButton>}>
        <SettingsList label="已存档会话" empty="没有已存档的会话。">
          {sessions.map(session => <SettingsListItem key={session.id} title={code.sessionName(session.id)} description={`${code.view.projects.find(project => project.id === (session.workspaceProjectId ?? session.projectId))?.name ?? "未知工作区"} · ${session.archivedAt?.slice(0, 10)}`}>
            <SettingsButton variant="icon" aria-label={`取消存档 ${code.sessionName(session.id)}`} title="取消存档" disabled={code.status.state !== "online"} onClick={() => void code.setArchived(session.id, false)}><ArchiveRestore /></SettingsButton>
          </SettingsListItem>)}
        </SettingsList>
      </SettingsGroup>
    </SettingsPage>
  );
}

// Note: 见 .agents/notes/implemented/feature/2026-10-21-desktop-settings-shell.md
export function SettingsContents(props: SettingsContentsProps) {
  const { settings, code, personal, dark, onDark } = props;
  const scope = settings.scope(code, personal);
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    contentRef.current?.querySelector<HTMLElement>(".settings-page")?.scrollTo({ top: 0, behavior: "instant" });
  }, [settings.category, settings.pageKey]);

  const category = settings.category;
  return (
    <SettingsShell
      navigation={navigation.map(entry => {
        if (entry.type === "section") return <SettingsNavSection key={`section-${entry.label}`} label={entry.label} />;
        const Icon = entry.value === "appearance" && dark ? Moon : entry.icon;
        return <SettingsNavItem key={entry.value} selected={category === entry.value} aria-label={entry.label} onClick={() => settings.chooseCategory(entry.value)} icon={<Icon aria-hidden="true" />}>{entry.label}</SettingsNavItem>;
      })}
      action={<SettingsButton variant="icon" aria-label="关闭设置" title="关闭设置" onClick={() => settings.close()}><X /></SettingsButton>}
      data-density="comfortable"
    >
      <div ref={contentRef} key={`${category}:${settings.pageKey}`} className="settings-content">
        {category === "appearance" && <AppearancePage dark={dark} onDark={onDark} />}
        {category === "web-search" && <CodeWebSearchSettings code={code} />}
        {category === "personal" && <PersonalConnectionSettings settings={settings} />}
        {category === "archived" && <ArchivedPage code={code} />}
        {category.startsWith("code-") && (() => { const Page = props.pages?.[category] ?? codePages[category as `code-${ManagedSettingsCategory}`]; return <Page category={category} scope={scope} settings={settings} code={code} personal={personal} />; })()}
        {category.startsWith("pa-") && (() => { const Page = PersonalSettingsPage; const mapped = paCategory(category); return mapped ? <Page category={mapped} scope={scope} settings={settings} code={code} personal={personal} /> : null; })()}
      </div>
    </SettingsShell>
  );
}

export function SettingsDialog(props: SettingsContentsProps & { defaultTarget: DesktopTarget; onCloseAutoFocus: (event: Event) => void }) {
  const { settings } = props;
  const busy = settings.form?.phase === "saving" || settings.form?.phase === "unknown";
  return <><Dialog open={settings.open} onOpenChange={open => { if (open) settings.show(props.defaultTarget); else settings.close(); }}>
    <DialogTrigger asChild><Button type="button" variant="ghost" size="icon" className="quiet-icon" aria-label="设置"><Settings /></Button></DialogTrigger>
    <DialogContent className="settings-dialog" showCloseButton={false} onCloseAutoFocus={props.onCloseAutoFocus}><DialogTitle className="sr-only">设置</DialogTitle><DialogDescription className="sr-only">选择左侧类别查看设置项，配置目标独立于聊天。</DialogDescription><SettingsContents {...props} />{settings.message && <p className="settings-notice" role="status">{settings.message}</p>}</DialogContent>
  </Dialog><Dialog open={!!settings.leave && !settings.form?.confirming} onOpenChange={open => { if (!open) settings.continueEditing(); }}><DialogContent className="demo-dialog"><DialogHeader><DialogTitle>保留未保存的更改？</DialogTitle><DialogDescription>保存后继续刚才的操作，或放弃本页草稿。</DialogDescription></DialogHeader><p role="status">{busy ? settings.form?.phase === "saving" ? "正在保存，请等待完成。" : "保存结果待核实，请继续编辑并核实原配置。" : "更改尚未保存。"}</p><DialogFooter><Button type="button" variant="ghost" onClick={() => settings.continueEditing()}>继续编辑</Button><Button type="button" variant="outline" disabled={busy} onClick={() => settings.discardAndLeave()}>放弃更改</Button><Button type="button" disabled={busy} onClick={() => void settings.saveAndLeave()}>保存并继续</Button></DialogFooter></DialogContent></Dialog></>;
}
