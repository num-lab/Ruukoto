import { useEffect, useState } from "react";
import { ChevronRight, Plus, RefreshCw } from "lucide-react";
import type { SettingsPageProps } from "./settings-dialog.tsx";
import { CodeMcpState } from "./code-mcp-state.ts";
import { SettingsButton, SettingsInput, SettingsNotice, SettingsSelect, SettingsTag } from "./components/controls.tsx";
import { SettingsCard, SettingsGroup, SettingsList, SettingsListItem, SettingsPage, SettingsRow } from "./components/settings.tsx";
import { Tools } from "./code-mcp-settings.tsx";
import { Button } from "./components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";

type Confirmation = { kind: "enable" | "disable" | "remove" };

function CuaRecovery({ state }: { state: CodeMcpState }) {
  const status = state.cuaStatus, observation = status?.observation;
  const [recovering, setRecovering] = useState(false);
  return <SettingsGroup title="本机电脑" action={<SettingsButton variant="icon" aria-label="刷新电脑状态" title="刷新电脑状态" disabled={state.reading || state.checking || !state.connected || state.phase === "saving"} onClick={() => void state.refreshCua()}><RefreshCw /></SettingsButton>}>
    <SettingsCard>
      {status && <SettingsRow title="运行状态" description={status.original ? `${status.original.toolName} · 结果待确认` : "没有正在等待恢复的电脑操作。"}><SettingsTag>{({ idle: "未连接", connecting: "连接中", active: "使用中", frozen: "待恢复", recovering: "恢复中" })[status.state]}</SettingsTag></SettingsRow>}
      {status && <SettingsRow title="停止电脑操作" description="未保存的应用状态可能丢失，磁盘文件保留。" footer={recovering && <SettingsNotice>演示状态：操作已停止，可获取新截图并确认恢复。</SettingsNotice>}>
        {(status.state === "frozen" && !status.stopped || status.state === "active" && !!state.service?.cua) && <SettingsButton disabled={state.disabled || state.dirty} onClick={() => { if (status.state === "active") void state.pauseCua(); else void state.cuaAction("stop"); setRecovering(true); }}>停止电脑操作</SettingsButton>}
        {status.stopped && !observation && <SettingsButton disabled={state.disabled || state.dirty} onClick={() => void state.cuaAction("observe")}>检查并恢复</SettingsButton>}
      </SettingsRow>}
      {observation && <SettingsRow title="恢复现场" description="真实桌面截图未接入 demo；此处仅保留确认流程。">
        <SettingsButton variant="ghost" disabled={state.disabled || state.dirty} onClick={() => void state.cuaAction("observe")}>重新截图</SettingsButton>
        <SettingsButton disabled={state.disabled || state.dirty || !state.canAcceptCua} onClick={() => void state.cuaAction("accept")}>确认恢复</SettingsButton>
      </SettingsRow>}
      {state.cuaImages.map((image, index) => <div className="file-image" key={`${observation!.id}:${image.id}`}><img src={image.source} alt={`恢复新截图 ${index + 1}`} onLoad={() => state.imageLoaded(observation!.id, image.id, true)} onError={() => state.imageLoaded(observation!.id, image.id, false)} /></div>)}
    </SettingsCard>
    {state.cuaError && <SettingsNotice>{state.cuaError}</SettingsNotice>}
  </SettingsGroup>;
}

function ComputerDetails({ state, confirmation, setConfirmation }: { state: CodeMcpState; confirmation: Confirmation | null; setConfirmation: (value: Confirmation | null) => void }) {
  const selectedProgram = state.cuaTargets.findIndex(target => JSON.stringify(target.config) === JSON.stringify(state.draft.cua));
  const comparison = state.service ?? state.conflictingService;
  return (
    <div className="settings-provider-settings">
      <SettingsRow title={state.service ? "编辑电脑" : "添加电脑"} description="配置本机 Cua Driver 与工具权限。"><SettingsButton variant="ghost" disabled={state.phase === "saving" || state.phase === "unknown"} onClick={() => state.closeEditor()}>关闭编辑</SettingsButton></SettingsRow>
      <SettingsRow title="服务名称" htmlFor="computer-name"><SettingsInput id="computer-name" value={state.draft.name} disabled={state.disabled || !!state.service} aria-invalid={!!state.fieldErrors.name} onChange={event => state.edit("name", event.target.value)} /></SettingsRow>
      {state.fieldErrors.name && <SettingsRow title="" description={state.fieldErrors.name} />}
      <SettingsRow title="已安装的 Cua Driver" description="选择本机程序。" htmlFor="computer-cua-program">
        <SettingsSelect id="computer-cua-program" value={selectedProgram < 0 ? "" : String(selectedProgram)} disabled={state.disabled} onChange={event => state.selectCua(Number(event.target.value))} options={state.cuaTargets.map((target, index) => ({ value: String(index), label: target.label }))} />
      </SettingsRow>
      {state.service?.cua && <SettingsRow title="程序路径" description={state.service.cua.executable} />}
      {!state.cuaTargets.length && !state.cuaIssues.length && <SettingsRow title="" description="未找到 Cua Driver，请先安装。" />}
      {state.cuaIssues.map((issue, index) => <SettingsRow key={index} title="" description={issue.message} />)}
      {state.fieldErrors.cua && <SettingsRow title="" description={state.fieldErrors.cua} />}
      <Tools state={state} />
      <SettingsRow title="检查权限与工具" description="辅助功能与屏幕录制分别核实。" footer={state.check && <SettingsNotice>{state.check.ok ? `发现 ${state.check.tools.length} 个工具` : state.check.error ?? `检查失败（${state.check.errorCode ?? "连接错误"}），请核实当前入口后再检查。`}</SettingsNotice>}>
        <SettingsButton disabled={state.disabled || state.dirty || !state.service} onClick={() => void state.discover()}>检查权限与工具</SettingsButton>
      </SettingsRow>
      {state.check?.permissions && <SettingsRow title="权限" description={`辅助功能：${state.check.permissions.accessibility ? "已授权" : "未授权"} · 屏幕录制：${state.check.permissions.screenRecording ? "已授权" : "未授权"}`} />}
      {state.phase === "conflict" && comparison && <SettingsRow title="后台当前值" description="草稿仍在上方，比较后决定。" footer={<pre className="settings-code-block">{JSON.stringify({ enabled: comparison.enabled, tools: comparison.toolAllowlist }, null, 2)}</pre>}>
        {!state.selectedId && <SettingsButton variant="ghost" disabled={state.disabled} onClick={() => state.useCurrentService()}>以当前同名服务继续编辑</SettingsButton>}
      </SettingsRow>}
      <SettingsRow title="电脑操作" description="启停只更新演示状态。">
        {state.service && <><SettingsButton variant="ghost" disabled={state.disabled || state.dirty} onClick={() => setConfirmation({ kind: "remove" })}>删除服务</SettingsButton><SettingsButton variant="ghost" disabled={state.disabled || state.dirty} onClick={() => { if (state.service!.enabled) void state.pauseCua(); else setConfirmation({ kind: "enable" }); }}>{state.service.enabled ? "暂停电脑" : "继续使用电脑"}</SettingsButton></>}
        <SettingsButton variant="ghost" disabled={state.disabled || !state.dirty} onClick={() => state.discard()}>放弃更改</SettingsButton>
        <SettingsButton disabled={state.disabled || !state.dirty} onClick={() => void state.save()}>{state.service ? "保存" : "保存草稿"}</SettingsButton>
      </SettingsRow>
    </div>
  );
}

export function CodeComputerEditor({ state }: { state: CodeMcpState }) {
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  useEffect(() => { if (Object.keys(state.fieldErrors).length) document.querySelector<HTMLElement>('.settings-page [aria-invalid="true"]')?.focus(); }, [state.fieldErrors]);
  const confirm = async () => {
    const action = confirmation; setConfirmation(null);
    if (action?.kind === "enable" || action?.kind === "disable") await state.setEnabled(action.kind === "enable");
    else if (action?.kind === "remove") await state.remove();
  };
  return (
    <SettingsPage title="电脑" description="管理本机 Cua Driver 与电脑操作恢复。">
      <SettingsGroup title="服务" action={<><SettingsButton variant="icon" aria-label="重新读取电脑配置" title="重新读取电脑配置" disabled={state.reading || state.phase === "saving"} onClick={() => void state.read()}><RefreshCw /></SettingsButton><SettingsButton onClick={() => setAdding(true)} disabled={state.disabled || state.dirty}><Plus />添加电脑</SettingsButton></>}>
        {adding && <SettingsCard className="settings-import-preview">
          <SettingsRow title="服务名称" htmlFor="new-computer-name"><SettingsInput id="new-computer-name" value={name} onChange={event => setName(event.target.value)} placeholder="新电脑" /></SettingsRow>
          <SettingsRow title="Cua Driver" description="选择目标后展示工具与权限配置。"><SettingsButton onClick={() => { state.select(null); state.edit("name", name.trim() || "新电脑"); setAdding(false); }}>完成配置</SettingsButton></SettingsRow>
        </SettingsCard>}
        {!state.connected && <SettingsNotice>Code 已离线，请恢复连接。</SettingsNotice>}
        {state.reading && <SettingsNotice>正在读取配置…</SettingsNotice>}
        <SettingsList label="电脑服务" empty="尚未配置本机电脑。">
          {state.services.filter(service => service.cua).map(service => <SettingsListItem key={service.id} title={service.name} description={`本机 Cua Driver · ${service.toolAllowlist.length} 个允许工具`} details={state.editing && state.selectedId === service.id ? <ComputerDetails state={state} confirmation={confirmation} setConfirmation={setConfirmation} /> : undefined}>
            <SettingsTag>{service.enabled ? "已启用" : "已暂停"}</SettingsTag>
            <SettingsButton variant="ghost" onClick={() => state.editing && state.selectedId === service.id ? state.closeEditor() : state.select(service.id)} aria-expanded={state.editing && state.selectedId === service.id} aria-label={`${state.editing && state.selectedId === service.id ? "收起" : "编辑"} ${service.name}`}><ChevronRight /></SettingsButton>
          </SettingsListItem>)}
        </SettingsList>
        {state.editing && !state.selectedId && <SettingsCard className="settings-import-preview"><ComputerDetails state={state} confirmation={confirmation} setConfirmation={setConfirmation} /></SettingsCard>}
      </SettingsGroup>
      <CuaRecovery state={state} />
      {state.message && <SettingsNotice>{state.message}</SettingsNotice>}
      <Dialog open={!!confirmation} onOpenChange={open => { if (!open) setConfirmation(null); }}><DialogContent className="demo-dialog"><DialogHeader><DialogTitle>{confirmation?.kind === "enable" ? "启用服务？" : confirmation?.kind === "disable" ? "停用服务？" : "删除服务？"}</DialogTitle><DialogDescription>本实例的全部工作区共用此配置。</DialogDescription></DialogHeader><p>{state.service?.name}</p><DialogFooter><Button type="button" variant="ghost" onClick={() => setConfirmation(null)}>取消</Button><Button type="button" disabled={state.disabled} onClick={() => void confirm()}>确认</Button></DialogFooter></DialogContent></Dialog>
    </SettingsPage>
  );
}

function CodeComputerForm({ settings, scope, code }: SettingsPageProps) {
  const [state] = useState(() => new CodeMcpState({ request: (...args) => window.ruukoto.request(...args) }, settings.changed, scope.instanceId!, () => ({ instanceId: code.view.instanceId, online: code.status.state === "online" }), "computer"));
  useEffect(() => { settings.form = state; void state.read().then(read => { if (read) void state.refreshCua(); }); return () => { state.invalidate(); if (settings.form === state) settings.form = null; }; }, [settings, state]);
  return <CodeComputerEditor state={state} />;
}

export function CodeComputerSettings(props: SettingsPageProps) {
  if (props.settings.form instanceof CodeMcpState && props.settings.form.pending) return <CodeComputerForm {...props} />;
  if (!props.scope.instanceId) return <SettingsPage title="电脑" description="管理本机 Cua Driver 与电脑操作恢复。"><SettingsNotice>Code 已离线，请恢复连接后管理电脑。</SettingsNotice></SettingsPage>;
  return <CodeComputerForm {...props} />;
}
