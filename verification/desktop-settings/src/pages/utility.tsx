import { useState } from "react";
import { ArchiveRestore, Moon, Sun } from "lucide-react";
import { SettingsButton, SettingsSegmented, SettingsSwitch } from "../components/controls.tsx";
import { SettingsCard, SettingsGroup, SettingsList, SettingsListItem, SettingsPage, SettingsRow } from "../components/settings.tsx";
import { RefreshButton, Tag, TextSetting } from "./shared.tsx";

export function AppearancePage({ theme, onThemeChange }: { theme: "dark" | "light"; onThemeChange: (theme: "dark" | "light") => void }) {
  return (
    <SettingsPage title="外观" description="选择桌面客户端的主题。">
      <SettingsGroup title="界面">
        <SettingsCard><SettingsRow title="主题" description="浅色或深色。"><SettingsSegmented label="主题" value={theme} onValueChange={onThemeChange} options={[{ value: "light", label: <><Sun aria-hidden="true" />浅色</> }, { value: "dark", label: <><Moon aria-hidden="true" />深色</> }]} /></SettingsRow></SettingsCard>
      </SettingsGroup>
    </SettingsPage>
  );
}

export function WebSearchPage() {
  const [enabled, setEnabled] = useState(true);
  const [editing, setEditing] = useState(false);
  const [configured, setConfigured] = useState(true);
  return (
    <SettingsPage title="Web 搜索" description="管理 ruukoto 的 Tavily 凭据与实例开关。">
      <SettingsGroup title="Tavily 凭据" action={<RefreshButton label="重新读取凭据" />}>
        <SettingsCard>
          <SettingsRow title="当前凭据" description="web-search · api.tavily.com"><Tag>{configured ? "生效中" : "未配置"}</Tag></SettingsRow>
          {(!configured || editing) && <TextSetting id="web-search-secret" title="Tavily API Key" description="只显示新秘密输入，不回显已有值。" type="password" />}
          <SettingsRow title="凭据操作" description="更换或移除只改变演示状态。"><SettingsButton onClick={() => { if (!configured) setConfigured(true); else setEditing(value => !value); }}>{editing ? "取消更换" : configured ? "更换密钥" : "配置密钥"}</SettingsButton>{configured && <SettingsButton variant="ghost" onClick={() => { setConfigured(false); setEditing(false); }}>移除</SettingsButton>}{editing && <SettingsButton onClick={() => { setConfigured(true); setEditing(false); }}>保存密钥</SettingsButton>}</SettingsRow>
        </SettingsCard>
      </SettingsGroup>
      <SettingsGroup title="实例开关">
        <SettingsCard><SettingsRow title="所有项目共用" description="停用立即阻止后续调用，启用从下一任务生效。" htmlFor="web-search-toggle"><SettingsSwitch id="web-search-toggle" checked={enabled} onChange={event => setEnabled(event.target.checked)} /></SettingsRow></SettingsCard>
      </SettingsGroup>
    </SettingsPage>
  );
}



const archived = [
  { id: "release", name: "发布验收", workspace: "ruukoto", date: "2026-10-27" },
  { id: "research", name: "界面调研", workspace: "design-notes", date: "2026-10-24" },
];

export function ArchivedPage() {
  const [sessions, setSessions] = useState(archived);
  return (
    <SettingsPage title="已存档会话" description="存档只把会话从左栏隐藏，历史与任务仍保留。">
      <SettingsGroup title="存档列表" action={<RefreshButton label="重新读取存档" />}>
        <SettingsList label="已存档会话" empty="没有已存档的会话。">
          {sessions.map(session => <SettingsListItem key={session.id} title={session.name} description={`${session.workspace} · ${session.date}`}><SettingsButton variant="icon" aria-label={`取消存档 ${session.name}`} title="取消存档" onClick={() => setSessions(sessions.filter(item => item.id !== session.id))}><ArchiveRestore /></SettingsButton></SettingsListItem>)}
        </SettingsList>
      </SettingsGroup>
    </SettingsPage>
  );
}
