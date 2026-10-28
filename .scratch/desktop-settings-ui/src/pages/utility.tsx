import { useState } from "react";
import { ArchiveRestore, Moon, SquarePen, Sun } from "lucide-react";
import { SettingsButton, SettingsSegmented, SettingsSwitch } from "../components/controls.tsx";
import { SettingsCard, SettingsGroup, SettingsList, SettingsListItem, SettingsPage, SettingsRow } from "../components/settings.tsx";
import { Notice, RefreshButton, Tag, TextSetting } from "./shared.tsx";

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
    <SettingsPage title="Web 搜索" description="管理 Code 的 Tavily 凭据与实例开关。">
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

export function PersonalConnectionPage() {
  const [editingOrigin, setEditingOrigin] = useState(false);
  const [editingPairing, setEditingPairing] = useState(false);
  const [paired, setPaired] = useState(false);
  const [origin, setOrigin] = useState("https://personal.example.ts.net");
  return (
    <SettingsPage title="PA 远程连接" description="连接此桌面与 Personal Agent，配置独立于聊天目标。">
      <SettingsGroup title="个人 Agent" action={<RefreshButton label="重新读取连接" />}>
        <SettingsCard>
          {editingOrigin ? <>
            <SettingsRow title="个人 Agent 地址" htmlFor="personal-origin"><input className="settings-plain-input" id="personal-origin" value={origin} onChange={event => setOrigin(event.target.value)} /></SettingsRow>
            <SettingsRow title="地址编辑" description="保存地址不代表已完成配对。"><SettingsButton onClick={() => setEditingOrigin(false)}>保存地址</SettingsButton><SettingsButton variant="ghost" onClick={() => setEditingOrigin(false)}>取消</SettingsButton></SettingsRow>
          </> : <SettingsRow title="个人 Agent 地址" description={origin}><SettingsButton variant="icon" aria-label="编辑地址" title="编辑地址" onClick={() => setEditingOrigin(true)}><SquarePen /></SettingsButton></SettingsRow>}
          {editingPairing ? <>
            <TextSetting id="personal-pair-label" title="此桌面的名称" defaultValue="MacBook Pro" />
            <TextSetting id="personal-pair-code" title="服务器配对码" description="仅演示输入，不发送配对请求。" type="password" />
            <SettingsRow title="配对操作" description="原配对结果需在原服务器核实。"><SettingsButton onClick={() => { setPaired(true); setEditingPairing(false); }}>配对并连接</SettingsButton><SettingsButton variant="ghost">恢复原配对</SettingsButton><SettingsButton variant="ghost" onClick={() => setEditingPairing(false)}>取消</SettingsButton></SettingsRow>
          </> : <SettingsRow title="服务器配对" description={paired ? "此桌面已与服务器配对。" : "尚未配对，配置仍需服务器确认。"}><Tag>{paired ? "已配对" : "未配对"}</Tag><SettingsButton onClick={() => setEditingPairing(true)}>编辑配对</SettingsButton></SettingsRow>}
        </SettingsCard>
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
