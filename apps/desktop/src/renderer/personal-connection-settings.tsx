import { useEffect, useState } from "react";
import { AlertTriangle, Check, Laptop, Link2, Loader2, Server } from "lucide-react";
import type { SettingsState } from "./settings-state.ts";
import type { PersonalState } from "./personal-state.ts";
import { PersonalConnectionState, type PersonalPermissionMode } from "./personal-connection-state.ts";
import { SettingsButton, SettingsInput, SettingsNotice, SettingsSelect, SettingsTag } from "./components/controls.tsx";
import { SettingsCard, SettingsGroup, SettingsPage, SettingsRow } from "./components/settings.tsx";
import { Button } from "./components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";

const connectionMeta = {
  connected: { title: "连接正常", icon: Check },
  unpaired: { title: "等待配对", icon: Link2 },
  error: { title: "连接中断", icon: AlertTriangle },
  loading: { title: "正在核实连接", icon: Loader2 },
  connecting: { title: "正在连接", icon: Loader2 },
};

export function ConnectionDiagram({ connection }: { connection: keyof typeof connectionMeta }) {
  const { title, icon: Icon } = connectionMeta[connection];
  const connector = () => <div className="connection-line"><span className="connection-line-state"><Icon aria-hidden="true" /></span></div>;
  return <section className="connection-overview" data-state={connection}>
    <div className="connection-diagram" role="img" aria-label={`此 Mac 通过 Tailscale 连接到远程 Personal Agent，当前状态：${title}`}>
      <div className="connection-node" title="此 Mac"><Laptop aria-hidden="true" /></div>
      {connector()}
      <div className="tailscale-node" title="Tailscale"><svg className="tailscale-mark" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="5" r="2.1" opacity=".35" /><circle cx="12" cy="5" r="2.1" opacity=".35" /><circle cx="19" cy="5" r="2.1" opacity=".35" /><circle cx="5" cy="12" r="2.1" /><circle cx="12" cy="12" r="2.1" /><circle cx="19" cy="12" r="2.1" /><circle cx="5" cy="19" r="2.1" opacity=".35" /><circle cx="12" cy="19" r="2.1" /><circle cx="19" cy="19" r="2.1" opacity=".35" /></svg></div>
      {connector()}
      <div className="connection-node" title="远程 Personal Agent 服务"><Server aria-hidden="true" /></div>
    </div>
  </section>;
}

export function PersonalConnectionSettings({ settings, personal }: { settings: SettingsState; personal: Pick<PersonalState, "status" | "identity"> }) {
  const [state] = useState(() => new PersonalConnectionState(window.ruukoto, settings.changed));
  useEffect(() => { settings.form = state; void state.read(); return () => { state.invalidate(); if (settings.form === state) settings.form = null; }; }, [settings, state]);
  useEffect(() => { if (state.fieldErrors.origin) document.getElementById("personal-origin")?.focus(); }, [state.fieldErrors]);
  return <PersonalConnectionEditor state={state} personal={personal} />;
}

export function PersonalConnectionEditor({ state, personal }: { state: PersonalConnectionState; personal: Pick<PersonalState, "status" | "identity"> }) {
  const paired = !!state.current?.binding;
  const pairingDisabled = state.disabled || !state.current?.origin || state.dirty;
  const maintenanceDisabled = state.reading || state.permissionsReading || state.phase === "saving" || !state.current?.origin || state.dirty;
  return (
    <SettingsPage title="PA 远程连接" description="查看此桌面与 Personal Agent 的连接。" overview={<ConnectionDiagram connection={state.connectionStatus(personal)} />}>
      <SettingsGroup title="个人 Agent">
        <SettingsCard>
          <SettingsRow title="服务器地址" description="保存地址不代表已完成配对。" htmlFor="personal-origin" error={state.fieldErrors.origin}><SettingsInput id="personal-origin" value={state.draft.origin} onChange={event => state.edit("origin", event.target.value)} placeholder="https://your-server.your-tailnet.ts.net" autoCapitalize="none" autoComplete="off" spellCheck={false} disabled={state.disabled} aria-invalid={!!state.fieldErrors.origin} /></SettingsRow>
          {state.dirty && <SettingsRow title="地址编辑"><SettingsButton variant="primary" disabled={state.disabled} onClick={() => void state.save()}>保存地址</SettingsButton><SettingsButton variant="ghost" disabled={state.disabled} onClick={() => state.discard()}>取消</SettingsButton></SettingsRow>}
        </SettingsCard>
      </SettingsGroup>
      <SettingsGroup title="服务器配对">
        <SettingsCard>
          <SettingsRow title="此桌面的名称" htmlFor="personal-pair-label"><SettingsInput id="personal-pair-label" value={state.label} onChange={event => { state.label = event.target.value; state.changed(); }} disabled={pairingDisabled} maxLength={80} autoComplete="off" /></SettingsRow>
          <SettingsRow title="服务器配对码" description="配对码仅用于本次授权。" htmlFor="personal-pair-code"><SettingsInput id="personal-pair-code" type="password" placeholder="输入短时配对码" value={state.code} onChange={event => { state.code = event.target.value; state.changed(); }} disabled={pairingDisabled} maxLength={12} autoComplete="off" autoCapitalize="characters" /></SettingsRow>
          <SettingsRow title="配对状态" description={paired ? "此桌面已与服务器配对。" : "配置仍需服务器确认。"}><SettingsTag>{paired ? "已配对" : "未配对"}</SettingsTag><SettingsButton disabled={pairingDisabled || !state.code.trim() || !state.label.trim()} onClick={() => void state.pair()}>配对并连接</SettingsButton></SettingsRow>
        </SettingsCard>
      </SettingsGroup>
      <SettingsGroup title="维护">
        <SettingsCard>
          <SettingsRow title="核实原配对" description="确认结果未知的服务器配对操作。"><SettingsButton variant="ghost" disabled={maintenanceDisabled} onClick={() => void state.pair("reconcile")}>核实原配对</SettingsButton></SettingsRow>
          <SettingsRow title="恢复原配对" description="恢复原服务器已经确认的配对。"><SettingsButton variant="ghost" disabled={maintenanceDisabled} onClick={() => void state.pair("restore")}>恢复原配对</SettingsButton></SettingsRow>
        </SettingsCard>
      </SettingsGroup>
      {paired && <PersonalPermissionSettings state={state} />}
      {state.legacy.length > 0 && <SettingsGroup title="旧维护尚待核实" description="先在原服务器核实，再确认；原记录保持原位。">
        <SettingsCard><SettingsRow title="待核实文件" description={state.legacy.join("、")}><SettingsButton disabled={state.disabled} onClick={() => void state.acknowledgeLegacy()}>已在原服务器核实</SettingsButton></SettingsRow></SettingsCard>
      </SettingsGroup>}
      {(state.reading || state.message) && <SettingsNotice>{state.reading ? "正在核实此桌面的连接…" : state.message}</SettingsNotice>}
      {(state.phase === "unknown" || state.phase === "error" || state.phase === "conflict") && <SettingsButton variant="ghost" disabled={state.reading} onClick={() => void state.read()}>核实原连接</SettingsButton>}
    </SettingsPage>
  );
}

export function PersonalPermissionSettings({ state }: { state: PersonalConnectionState }) {
  const modes = [{ value: "confirm", label: "按已授权范围" }, { value: "auto-review", label: "自动审查" }, { value: "full_access", label: "完全访问" }];
  return <>
    <SettingsGroup title="默认权限" description="只影响以后新接纳的输入与新计划，已有工作保留原权限。">
      <SettingsCard>
        {([["default", "桌面、本机与 Telegram"], ["qq", "QQ（独立默认）"]] as const).map(([scope, title]) => <SettingsRow key={scope} title={title} htmlFor={`pa-permission-${scope}`}><SettingsSelect id={`pa-permission-${scope}`} value={state.permissions?.[scope].mode ?? ""} disabled={state.permissionsDisabled} options={state.permissions ? modes : [{ value: "", label: "尚未核实" }]} onValueChange={nextValue => void state.selectPermission(scope, nextValue as PersonalPermissionMode)} /></SettingsRow>)}
        <SettingsRow title="权限范围" description="按已授权范围直接执行，超出范围时请求批准。自动审查可独立审查范围外的无凭据读取；其余超出范围操作仍请求批准。" />
      </SettingsCard>
      {(state.permissionsReading || state.permissionsMessage) && <SettingsNotice>{state.permissionsReading ? "正在核实默认权限…" : state.permissionsMessage}</SettingsNotice>}
      {!state.permissions && state.permissionsMessage && <SettingsButton variant="ghost" disabled={state.reading || state.permissionsReading || state.phase === "saving" || state.dirty} onClick={() => void state.readPermissions()}>核实默认权限</SettingsButton>}
    </SettingsGroup>
    <Dialog open={!!state.permissionConfirmation} onOpenChange={open => { if (!open) state.cancelPermission(); }}><DialogContent className="demo-dialog"><DialogHeader><DialogTitle>启用完全访问？</DialogTitle><DialogDescription>后续输入将使用后台账户的目录、网络及同账户凭据，免逐次审批；未知效果仍会暂停。</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="ghost" onClick={() => state.cancelPermission()}>取消</Button><Button type="button" disabled={state.permissionsDisabled} onClick={() => void state.confirmPermission()}>启用完全访问</Button></DialogFooter></DialogContent></Dialog>
  </>;
}
