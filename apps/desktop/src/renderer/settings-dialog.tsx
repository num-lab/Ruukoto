import { useEffect, useRef } from "react";
import { Archive, ArchiveRestore, Blocks, Brain, Globe, Monitor, Moon, Puzzle, Server, Settings, Sun, SunMoon, X } from "lucide-react";
import type { DesktopAppearance, DesktopTarget } from "../shared/bridge.ts";
import type { CodeState } from "./code-state.ts";
import type { PersonalState } from "./personal-state.ts";
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
  personal: Pick<PersonalState, "view" | "status" | "identity">;
}
export interface PersonalSettingsPageProps extends Omit<SettingsPageProps, "category"> {
  category: ManagedSettingsCategory;
}
export interface SettingsContentsProps {
  settings: SettingsState;
  code: CodeState;
  personal: Pick<PersonalState, "view" | "status" | "identity">;
  appearance: DesktopAppearance;
  onAppearance: (appearance: DesktopAppearance) => void;
  pages?: Partial<Record<SettingsCategory, React.ComponentType<SettingsPageProps>>>;
}

type NavEntry =
  | { type: "section"; label: string }
  | { type: "item"; value: SettingsCategory; label: string; icon: typeof Sun };

const navigation: ReadonlyArray<NavEntry> = [
  { type: "section", label: "Desktop" },
  { type: "item", value: "appearance", label: "Appearance", icon: SunMoon },
  { type: "item", value: "code-computer", label: "Computer", icon: Monitor },
  { type: "item", value: "web-search", label: "Web search", icon: Globe },
  { type: "item", value: "personal", label: "Personal connection", icon: Server },
  { type: "item", value: "archived", label: "Archived chats", icon: Archive },
  { type: "section", label: "Code" },
  { type: "item", value: "code-models", label: "Models", icon: Brain },
  { type: "item", value: "code-skills", label: "Skills", icon: Puzzle },
  { type: "item", value: "code-mcp", label: "MCP", icon: Blocks },
  { type: "section", label: "PA" },
  { type: "item", value: "pa-models", label: "Models", icon: Brain },
  { type: "item", value: "pa-skills", label: "Skills", icon: Puzzle },
  { type: "item", value: "pa-mcp", label: "MCP", icon: Blocks },
  { type: "item", value: "pa-computer", label: "Computer", icon: Monitor },
];

const codePages: Record<`code-${ManagedSettingsCategory}`, React.ComponentType<SettingsPageProps>> = {
  "code-models": CodeModelsSettings,
  "code-skills": CodeSkillsSettings,
  "code-mcp": CodeMcpSettings,
  "code-computer": CodeComputerSettings,
};

function AppearancePage({ appearance, onAppearance }: { appearance: DesktopAppearance; onAppearance: (appearance: DesktopAppearance) => void }) {
  return (
    <SettingsPage title="Appearance" description="Choose the desktop client theme.">
      <SettingsGroup title="Interface">
        <SettingsCard>
          <SettingsRow title="Theme" description="System, Light or Dark."><SettingsSegmented label="Theme" value={appearance} onValueChange={value => onAppearance(value as DesktopAppearance)} options={[{ value: "system", label: <><Monitor aria-hidden="true" />System</> }, { value: "light", label: <><Sun aria-hidden="true" />Light</> }, { value: "dark", label: <><Moon aria-hidden="true" />Dark</> }]} /></SettingsRow>
        </SettingsCard>
      </SettingsGroup>
    </SettingsPage>
  );
}

function ArchivedPage({ code }: { code: CodeState }) {
  const sessions = code.archivedSessions();
  return (
    <SettingsPage title="Archived chats" description="Archiving only hides a chat from the sidebar; history and tasks are kept.">
      <SettingsGroup title="Archive list">
        <SettingsList label="Archived chats" empty="No archived chats.">
          {sessions.map(session => <SettingsListItem key={session.id} title={code.sessionName(session.id)} description={`${code.workspaceName(session.workspaceProjectId ?? session.projectId)} · ${session.archivedAt?.slice(0, 10)}`}>
            <SettingsButton variant="icon" aria-label={`Unarchive ${code.sessionName(session.id)}`} title="Unarchive" disabled={code.status.state !== "online"} onClick={() => void code.setArchived(session.id, false)}><ArchiveRestore /></SettingsButton>
          </SettingsListItem>)}
        </SettingsList>
      </SettingsGroup>
    </SettingsPage>
  );
}

// Note: See .agents/notes/implemented/feature/2026-10-21-desktop-settings-shell.md
// Note: See .agents/notes/implemented/feature/2026-11-07-desktop-visual-alignment.md
export function SettingsContents(props: SettingsContentsProps) {
  const { settings, code, personal, appearance, onAppearance } = props;
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
        const Icon = entry.icon;
        return <SettingsNavItem key={entry.value} selected={category === entry.value} aria-label={entry.label} onClick={() => settings.chooseCategory(entry.value)} icon={<Icon aria-hidden="true" />}>{entry.label}</SettingsNavItem>;
      })}
      action={<SettingsButton variant="icon" aria-label="Close settings" title="Close settings" onClick={() => settings.close()}><X /></SettingsButton>}
      data-density="comfortable"
    >
      <div ref={contentRef} key={`${category}:${settings.pageKey}`} className="settings-content">
        {category === "appearance" && <AppearancePage appearance={appearance} onAppearance={onAppearance} />}
        {category === "web-search" && <CodeWebSearchSettings code={code} />}
        {category === "personal" && <PersonalConnectionSettings settings={settings} personal={personal} />}
        {category === "archived" && <ArchivedPage code={code} />}
        {category.startsWith("code-") && (() => { const Page = props.pages?.[category] ?? codePages[category as `code-${ManagedSettingsCategory}`]; return <Page category={category} scope={scope} settings={settings} code={code} personal={personal} />; })()}
        {category.startsWith("pa-") && (() => { const Page = PersonalSettingsPage; const mapped = paCategory(category); return mapped ? <Page key={scope.instanceId} category={mapped} scope={scope} settings={settings} code={code} personal={personal} /> : null; })()}
      </div>
    </SettingsShell>
  );
}

export function SettingsDialog(props: SettingsContentsProps & { defaultTarget: DesktopTarget; onCloseAutoFocus: (event: Event) => void }) {
  const { settings } = props;
  const busy = settings.form?.phase === "saving" || settings.form?.phase === "unknown";
  return <><Dialog open={settings.open} onOpenChange={open => { if (open) settings.show(props.defaultTarget); else settings.close(); }}>
    <DialogTrigger asChild><Button type="button" variant="ghost" size="icon" className="quiet-icon" aria-label="Settings"><Settings /></Button></DialogTrigger>
    <DialogContent className="settings-dialog" showCloseButton={false} onCloseAutoFocus={props.onCloseAutoFocus}><DialogTitle className="sr-only">Settings</DialogTitle><DialogDescription className="sr-only">Select a category on the left to view its settings; configuration is independent of chats.</DialogDescription><SettingsContents {...props} />{settings.message && <p className="settings-notice" role="status">{settings.message}</p>}</DialogContent>
  </Dialog><Dialog open={!!settings.leave && !settings.form?.confirming} onOpenChange={open => { if (!open) settings.continueEditing(); }}><DialogContent className="app-dialog"><DialogHeader><DialogTitle>Keep unsaved changes?</DialogTitle><DialogDescription>Save and continue, or discard the draft on this page.</DialogDescription></DialogHeader><p role="status">{busy ? settings.form?.phase === "saving" ? "Saving…" : "Save outcome unverified. Keep editing and verify the original configuration." : "Changes aren't saved."}</p><DialogFooter><Button type="button" variant="ghost" onClick={() => settings.continueEditing()}>Keep editing</Button><Button type="button" variant="outline" disabled={busy} onClick={() => settings.discardAndLeave()}>Discard changes</Button><Button type="button" disabled={busy} onClick={() => void settings.saveAndLeave()}>Save and continue</Button></DialogFooter></DialogContent></Dialog></>;
}
