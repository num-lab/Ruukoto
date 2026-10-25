import { useEffect, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import type { SettingsPageProps } from "./settings-dialog.tsx";
import { CodeMcpState } from "./code-mcp-state.ts";
import { SettingsSection } from "./settings-ui.tsx";
import { Tools } from "./code-mcp-settings.tsx";
import { Button } from "./components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "./components/ui/field.tsx";
import { Input } from "./components/ui/input.tsx";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select.tsx";

type Confirmation = { kind: "enable" | "disable" | "remove" };

function CuaRecovery({ state }: { state: CodeMcpState }) {
  const status = state.cuaStatus, observation = status?.observation;
  return <SettingsSection title="本机电脑" action={<Button type="button" variant="ghost" size="icon-sm" aria-label="刷新电脑状态" title="刷新电脑状态" disabled={state.reading || state.checking || !state.connected || state.phase === "saving"} onClick={() => void state.refreshCua()}><RefreshCw /></Button>}>
    {status && <div className="model-settings-actions"><span role="status">{({ idle: "未连接", connecting: "连接中", active: "使用中", frozen: "待恢复", recovering: "恢复中" })[status.state]}</span></div>}
    {status && <>{status.original && <p>{status.original.toolName} · 结果待确认</p>}
      <div className="model-settings-actions">{(status.state === "frozen" && !status.stopped || status.state === "active" && !!state.service?.cua) && <Button type="button" variant="outline" size="sm" disabled={state.disabled || state.dirty} onClick={() => { if (status.state === "active") void state.pauseCua(); else void state.cuaAction("stop"); }}>停止电脑操作</Button>}
        {status.stopped && !status.ownerStarted && <Button type="button" variant="outline" size="sm" disabled={state.disabled || state.dirty} onClick={() => void state.cuaAction("begin")}>已检查结果，开始恢复</Button>}
        {status.ownerStarted && !observation && <Button type="button" variant="outline" size="sm" disabled={state.disabled || state.dirty} onClick={() => void state.cuaAction("observe")}>获取截图</Button>}
      </div>
      {observation && <>{state.cuaImages.map((image, index) => <div className="file-image" key={`${observation.id}:${image.id}`}><img src={image.source} alt={`恢复新截图 ${index + 1}`} onLoad={() => state.imageLoaded(observation.id, image.id, true)} onError={() => state.imageLoaded(observation.id, image.id, false)} /></div>)}<div className="model-settings-actions"><Button type="button" variant="outline" size="sm" disabled={state.disabled || state.dirty} onClick={() => void state.cuaAction("observe")}>重新截图</Button><Button type="button" size="sm" disabled={state.disabled || state.dirty || !state.canAcceptCua} onClick={() => void state.cuaAction("accept")}>确认恢复</Button></div></>}
    </>}
    {state.cuaError && <p role="alert">{state.cuaError}</p>}
  </SettingsSection>;
}

export function CodeComputerEditor({ state }: { state: CodeMcpState }) {
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const comparison = state.service ?? state.conflictingService;
  const selectedProgram = state.cuaTargets.findIndex(target => JSON.stringify(target.config) === JSON.stringify(state.draft.cua));
  useEffect(() => { if (Object.keys(state.fieldErrors).length) document.querySelector<HTMLElement>('.computer-settings [aria-invalid="true"]')?.focus(); }, [state.fieldErrors]);
  const confirm = async () => {
    const action = confirmation; setConfirmation(null);
    if (action?.kind === "enable" || action?.kind === "disable") await state.setEnabled(action.kind === "enable");
    else if (action?.kind === "remove") await state.remove();
  };
  return <div className="model-settings computer-settings" aria-label="Code 电脑配置" aria-busy={state.reading || state.phase === "saving"}>
    <div className="model-settings-section-heading"><h3>服务</h3><div className="model-settings-actions"><Button type="button" variant="ghost" size="icon-sm" aria-label="重新读取电脑配置" title="重新读取电脑配置" disabled={state.reading || state.phase === "saving"} onClick={() => void state.read()}><RefreshCw /></Button><Button type="button" variant="ghost" size="icon-sm" aria-label="添加电脑" title="添加电脑" disabled={state.disabled || state.dirty} onClick={() => state.select(null)}><Plus /></Button></div></div>
    {!state.connected && <p className="model-settings-notice" role="status">Code 已离线，请恢复连接。</p>}
    {state.reading && <p role="status">正在读取配置…</p>}
    <div className="mcp-service-list">{state.services.filter(service => service.cua).map(service => <Button key={service.id} type="button" variant="ghost" className="model-settings-row" disabled={state.disabled || state.dirty} onClick={() => state.select(service.id)}><span className="model-settings-row-copy"><span className="model-settings-row-title">{service.name} · {service.enabled ? "已启用" : "已停用"}</span><span className="model-settings-row-detail">本机 Cua Driver</span><span className="model-settings-row-detail">本机 · {service.toolAllowlist.length} 个允许工具</span></span></Button>)}</div>
    {state.editing && <form onSubmit={event => { event.preventDefault(); void state.save(); }}><FieldGroup>
      <div className="model-settings-section-heading"><h3>{state.service ? "编辑电脑" : "添加电脑"}</h3><Button type="button" variant="ghost" size="sm" disabled={state.phase === "saving" || state.phase === "unknown"} onClick={() => state.closeEditor()}>关闭编辑</Button></div>
      <Field data-invalid={!!state.fieldErrors.name}><FieldLabel htmlFor="computer-name">服务名称</FieldLabel><Input id="computer-name" value={state.draft.name} disabled={state.disabled || !!state.service} aria-invalid={!!state.fieldErrors.name} onChange={event => state.edit("name", event.target.value)} />{state.fieldErrors.name && <FieldDescription role="alert">{state.fieldErrors.name}</FieldDescription>}</Field>
      <Field data-invalid={!!state.fieldErrors.cua}><FieldLabel htmlFor="computer-cua-program">已安装的 Cua Driver</FieldLabel><Select value={selectedProgram < 0 ? "" : String(selectedProgram)} disabled={state.disabled} onValueChange={value => state.selectCua(Number(value))}><SelectTrigger id="computer-cua-program" aria-invalid={!!state.fieldErrors.cua}><SelectValue placeholder="选择本机程序" /></SelectTrigger><SelectContent><SelectGroup>{state.cuaTargets.map((target, index) => <SelectItem key={index} value={String(index)}>{target.label}</SelectItem>)}</SelectGroup></SelectContent></Select>{state.service?.cua && <p>{state.service.cua.executable}</p>}{!state.cuaTargets.length && !state.cuaIssues.length && <FieldDescription>未找到 Cua Driver，请先安装。</FieldDescription>}{state.cuaIssues.map((issue, index) => <FieldDescription key={index} role="status">{issue.message}</FieldDescription>)}{state.fieldErrors.cua && <FieldDescription role="alert">{state.fieldErrors.cua}</FieldDescription>}</Field>
      <Tools state={state} />
      <div className="model-settings-actions"><Button type="button" variant="outline" size="sm" disabled={state.disabled || state.dirty || !state.service} onClick={() => void state.discover()}>检查权限与工具</Button></div>
      {state.check && <p role="status">{state.check.ok ? `发现 ${state.check.tools.length} 个工具` : state.check.error ?? `检查失败（${state.check.errorCode ?? "连接错误"}），请核实当前入口后再检查。`}</p>}
      {state.check?.permissions && <p role="status">辅助功能：{state.check.permissions.accessibility ? "已授权" : "未授权"} · 屏幕录制：{state.check.permissions.screenRecording ? "已授权" : "未授权"}</p>}
      {state.phase === "conflict" && comparison && <div className="model-settings-notice"><p>后台当前值（草稿仍在上方）：</p><pre>{JSON.stringify({ enabled: comparison.enabled, tools: comparison.toolAllowlist }, null, 2)}</pre>{!state.selectedId && <Button type="button" variant="outline" size="sm" disabled={state.disabled} onClick={() => state.useCurrentService()}>以当前同名服务继续编辑</Button>}</div>}
      <footer className="model-settings-footer"><div className="model-settings-actions">{state.service && <><Button type="button" variant="ghost" size="sm" disabled={state.disabled || state.dirty} onClick={() => setConfirmation({ kind: "remove" })}>删除服务</Button><Button type="button" variant="outline" size="sm" disabled={state.disabled || state.dirty} onClick={() => { if (state.service!.enabled) void state.pauseCua(); else setConfirmation({ kind: "enable" }); }}>{state.service.enabled ? "暂停电脑" : "继续使用电脑"}</Button></>}<Button type="button" variant="ghost" size="sm" disabled={state.disabled || !state.dirty} onClick={() => state.discard()}>放弃更改</Button></div><Button type="submit" size="sm" disabled={state.disabled || !state.dirty}>{state.service ? "保存" : "保存草稿"}</Button></footer>
    </FieldGroup></form>}
    <CuaRecovery state={state} />
    {state.message && <p className="model-settings-notice" role="status">{state.message}</p>}
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open) setConfirmation(null); }}><DialogContent className="demo-dialog"><DialogHeader><DialogTitle>{confirmation?.kind === "enable" ? "启用服务？" : confirmation?.kind === "disable" ? "停用服务？" : "删除服务？"}</DialogTitle><DialogDescription>本实例的全部工作区共用此配置。</DialogDescription></DialogHeader><p>{state.service?.name}</p><DialogFooter><Button type="button" variant="ghost" onClick={() => setConfirmation(null)}>取消</Button><Button type="button" disabled={state.disabled} onClick={() => void confirm()}>确认</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}

function CodeComputerForm({ settings, scope, code }: SettingsPageProps) {
  const [state] = useState(() => new CodeMcpState({ request: (...args) => window.ruukoto.request(...args) }, settings.changed, scope.instanceId!, () => ({ instanceId: code.view.instanceId, online: code.status.state === "online" }), "computer"));
  useEffect(() => { settings.form = state; void state.read().then(read => { if (read) void state.refreshCua(); }); return () => { state.invalidate(); if (settings.form === state) settings.form = null; }; }, [settings, state]);
  return <CodeComputerEditor state={state} />;
}

export function CodeComputerSettings(props: SettingsPageProps) {
  if (props.settings.form instanceof CodeMcpState && props.settings.form.pending) return <CodeComputerForm {...props} />;
  if (!props.scope.instanceId) return <FieldDescription role="status">Code 已离线，请恢复连接后管理电脑。</FieldDescription>;
  return <CodeComputerForm {...props} />;
}
