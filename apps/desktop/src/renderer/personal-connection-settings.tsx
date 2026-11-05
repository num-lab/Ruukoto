import { useEffect, useState } from "react";
import { RefreshCw, SquarePen } from "lucide-react";
import type { SettingsState } from "./settings-state.ts";
import { PersonalConnectionState, type PersonalPermissionMode } from "./personal-connection-state.ts";
import { SettingsButton, SettingsInput, SettingsNotice, SettingsSelect, SettingsTag } from "./components/controls.tsx";
import { SettingsCard, SettingsGroup, SettingsPage, SettingsRow } from "./components/settings.tsx";
import { Button } from "./components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";

export function PersonalConnectionSettings({ settings }: { settings: SettingsState }) {
  const [state] = useState(() => new PersonalConnectionState(window.ruukoto, settings.changed));
  const [editingOrigin, setEditingOrigin] = useState(false);
  const [editingPairing, setEditingPairing] = useState(false);
  useEffect(() => { settings.form = state; void state.read(); return () => { state.invalidate(); if (settings.form === state) settings.form = null; }; }, [settings, state]);
  useEffect(() => { if (state.fieldErrors.origin) document.getElementById("personal-origin")?.focus(); }, [state.fieldErrors]);
  const paired = !!state.current?.binding;
  return (
    <SettingsPage title="PA 远程连接" description="连接此桌面与 Personal Agent，配置独立于聊天目标。">
      <SettingsGroup title="个人 Agent" action={<SettingsButton variant="icon" aria-label="重新读取连接" title="重新读取连接" disabled={state.reading || state.phase === "saving"} onClick={() => void state.read()}><RefreshCw /></SettingsButton>}>
        <SettingsCard>
          {editingOrigin ? <>
            <SettingsRow title="个人 Agent 地址" htmlFor="personal-origin" error={state.fieldErrors.origin}><SettingsInput id="personal-origin" value={state.draft.origin} onChange={event => state.edit("origin", event.target.value)} placeholder="https://your-server.your-tailnet.ts.net" autoCapitalize="none" autoComplete="off" spellCheck={false} disabled={state.disabled} aria-invalid={!!state.fieldErrors.origin} /></SettingsRow>
            <SettingsRow title="地址编辑" description="保存地址不代表已完成配对。"><SettingsButton disabled={state.disabled || !state.dirty} onClick={() => void state.save().then(saved => { if (saved) setEditingOrigin(false); })}>保存地址</SettingsButton><SettingsButton variant="ghost" onClick={() => { state.discard(); setEditingOrigin(false); }}>取消</SettingsButton></SettingsRow>
          </> : <SettingsRow title="个人 Agent 地址" description={state.loaded ? state.draft.origin || "未配置" : "…"}><SettingsButton variant="icon" aria-label="编辑地址" title="编辑地址" disabled={state.disabled} onClick={() => setEditingOrigin(true)}><SquarePen /></SettingsButton></SettingsRow>}
          {state.current?.origin && !state.dirty && (editingPairing ? <>
            <SettingsRow title="此桌面的名称" htmlFor="personal-pair-label"><SettingsInput id="personal-pair-label" value={state.label} onChange={event => { state.label = event.target.value; settings.changed(); }} disabled={state.disabled} maxLength={80} autoComplete="off" /></SettingsRow>
            <SettingsRow title="服务器配对码" htmlFor="personal-pair-code"><SettingsInput id="personal-pair-code" type="password" value={state.code} onChange={event => { state.code = event.target.value; settings.changed(); }} disabled={state.disabled} maxLength={12} autoComplete="off" autoCapitalize="characters" /></SettingsRow>
            <SettingsRow title="配对操作"><SettingsButton disabled={state.disabled || !state.code.trim() || !state.label.trim()} onClick={() => void state.pair().then(() => { if (state.phase === "ready") setEditingPairing(false); })}>配对并连接</SettingsButton><SettingsButton variant="ghost" disabled={state.reading || state.phase === "saving"} onClick={() => void state.pair("reconcile")}>核实原配对</SettingsButton><SettingsButton variant="ghost" disabled={state.reading || state.phase === "saving"} onClick={() => void state.pair("restore")}>恢复原配对</SettingsButton><SettingsButton variant="ghost" onClick={() => { state.code = ""; settings.changed(); setEditingPairing(false); }}>取消</SettingsButton></SettingsRow>
          </> : <SettingsRow title="服务器配对" description={paired ? "此桌面已与服务器配对。" : "尚未配对，配置仍需服务器确认。"}><SettingsTag>{paired ? "已配对" : "未配对"}</SettingsTag><SettingsButton variant="icon" aria-label="编辑配对" title="编辑配对" disabled={state.disabled} onClick={() => setEditingPairing(true)}><SquarePen /></SettingsButton></SettingsRow>)}
        </SettingsCard>
      </SettingsGroup>
      {paired && <PersonalPermissionSettings state={state} />}
      {state.legacy.length > 0 && <SettingsGroup title="旧维护尚待核实" description="先在原服务器核实，再确认；原记录保持原位。">
        <SettingsCard>
          <SettingsRow title="待核实文件" description={state.legacy.join("、")}><SettingsButton disabled={state.disabled} onClick={() => void state.acknowledgeLegacy()}>已在原服务器核实</SettingsButton></SettingsRow>
        </SettingsCard>
      </SettingsGroup>}
      {(state.reading || state.message) && <SettingsNotice>{state.reading ? "正在核实此桌面的连接…" : state.message}</SettingsNotice>}
    </SettingsPage>
  );
}

export function PersonalPermissionSettings({ state }: { state: PersonalConnectionState }) {
  const modes = [{ value: "confirm", label: "按已授权范围" }, { value: "auto-review", label: "自动审查" }, { value: "full_access", label: "完全访问" }];
  return <>
    <SettingsGroup title="默认权限" description="只影响以后新接纳的输入与新计划，已有工作保留原权限。" action={<SettingsButton variant="icon" aria-label="重新读取默认权限" disabled={state.reading || state.permissionsReading || state.phase === "saving" || state.dirty} onClick={() => void state.readPermissions()}><RefreshCw /></SettingsButton>}>
      <SettingsCard>
        {([["default", "桌面、本机与 Telegram"], ["qq", "QQ（独立默认）"]] as const).map(([scope, title]) => <SettingsRow key={scope} title={title} htmlFor={`pa-permission-${scope}`}><SettingsSelect id={`pa-permission-${scope}`} value={state.permissions?.[scope].mode ?? ""} disabled={state.permissionsDisabled} options={state.permissions ? modes : [{ value: "", label: "尚未核实" }]} onChange={event => void state.selectPermission(scope, event.target.value as PersonalPermissionMode)} /></SettingsRow>)}
        <SettingsRow title="权限范围" description="按已授权范围直接执行，超出范围时请求批准。自动审查可独立审查范围外的无凭据读取；其余超出范围操作仍请求批准。" />
      </SettingsCard>
      {(state.permissionsReading || state.permissionsMessage) && <SettingsNotice>{state.permissionsReading ? "正在核实默认权限…" : state.permissionsMessage}</SettingsNotice>}
    </SettingsGroup>
    <Dialog open={!!state.permissionConfirmation} onOpenChange={open => { if (!open) state.cancelPermission(); }}><DialogContent className="demo-dialog"><DialogHeader><DialogTitle>启用完全访问？</DialogTitle><DialogDescription>后续输入将使用后台账户的目录、网络及同账户凭据，免逐次审批；未知效果仍会暂停。</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="ghost" onClick={() => state.cancelPermission()}>取消</Button><Button type="button" disabled={state.permissionsDisabled} onClick={() => void state.confirmPermission()}>启用完全访问</Button></DialogFooter></DialogContent></Dialog>
  </>;
}
