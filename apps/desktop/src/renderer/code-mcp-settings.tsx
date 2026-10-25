import { useEffect, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import type { SettingsPageProps } from "./settings-dialog.tsx";
import { CodeMcpState } from "./code-mcp-state.ts";
import { SettingsSection, SwitchRow } from "./settings-ui.tsx";
import { Button } from "./components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "./components/ui/field.tsx";
import { Input } from "./components/ui/input.tsx";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select.tsx";

type Confirmation = { kind: "enable" | "disable" | "remove" } | { kind: "credential"; name: string };
const effects = { read: "只读", write: "写入", unknown: "副作用不明" } as const;

export function Tools({ state }: { state: CodeMcpState }) {
  const names = Array.from(new Set([...state.draft.toolAllowlist.map(tool => tool.name), ...(state.check?.tools.map(tool => tool.name) ?? [])]));
  if (!names.length) return null;
  return <SettingsSection title="允许的工具">
    <FieldGroup>{names.map((name, index) => {
      const allowed = state.draft.toolAllowlist.find(tool => tool.name === name);
      return state.draft.kind === "cua-mac"
        ? <SwitchRow key={name} id={`mcp-tool-${index}`} label={name} title={effects[state.check?.tools.find(tool => tool.name === name)?.effect ?? allowed?.effect ?? "unknown"]} checked={!!allowed} disabled={state.disabled} onCheckedChange={checked => state.allow(name, checked)} />
        : <Field key={name} orientation="horizontal" className="mcp-tool-row"><FieldLabel htmlFor={`mcp-tool-${index}`}>{name}</FieldLabel><Select value={allowed ? allowed.effect : "blocked"} disabled={state.disabled} onValueChange={value => { if (value === "blocked") state.allow(name, false); else if (!allowed) { state.allow(name, true); state.effect(name, value as keyof typeof effects); } else state.effect(name, value as keyof typeof effects); }}><SelectTrigger id={`mcp-tool-${index}`}><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="blocked">不允许</SelectItem>{Object.entries(effects).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>;
    })}</FieldGroup>
  </SettingsSection>;
}

export function CodeMcpEditor({ state }: { state: CodeMcpState }) {
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const comparison = state.service ?? state.conflictingService;
  const credential = state.credentials.find(credential => credential.name === state.service?.credential);
  const affected = confirmation?.kind === "credential" ? state.credentials.find(credential => credential.name === confirmation.name)?.references ?? [] : [];
  useEffect(() => { if (Object.keys(state.fieldErrors).length) document.querySelector<HTMLElement>('.mcp-settings [aria-invalid="true"]')?.focus(); }, [state.fieldErrors]);
  const confirm = async () => {
    const action = confirmation; setConfirmation(null);
    if (action?.kind === "enable" || action?.kind === "disable") await state.setEnabled(action.kind === "enable");
    else if (action?.kind === "remove") await state.remove();
    else if (action?.kind === "credential") await state.removeCredential(action.name);
  };
  return <div className="model-settings mcp-settings" aria-label="Code MCP 配置" aria-busy={state.reading || state.phase === "saving"}>
    <div className="model-settings-section-heading"><h3>服务</h3><div className="model-settings-actions"><Button type="button" variant="ghost" size="icon-sm" aria-label="重新读取 MCP 配置" title="重新读取 MCP 配置" disabled={state.reading || state.phase === "saving"} onClick={() => void state.read()}><RefreshCw /></Button><Button type="button" variant="ghost" size="icon-sm" aria-label="添加服务" title="添加服务" disabled={state.disabled || state.dirty} onClick={() => state.select(null)}><Plus /></Button></div></div>
    {!state.connected && <p className="model-settings-notice" role="status">Code 已离线，请恢复连接。</p>}
    {state.reading && <p role="status">正在读取配置…</p>}
    <div className="mcp-service-list">{state.services.filter(service => !service.cua).map(service => <Button key={service.id} type="button" variant="ghost" className="model-settings-row" disabled={state.disabled || state.dirty} onClick={() => state.select(service.id)}><span className="model-settings-row-copy"><span className="model-settings-row-title">{service.name} · {service.enabled ? "已启用" : "已停用"}</span><span className="model-settings-row-detail">{service.endpoint}</span><span className="model-settings-row-detail">{service.credential ? state.credentials.some(credential => credential.name === service.credential) ? "已配置凭据" : "凭据不可用" : "匿名"} · {service.toolAllowlist.length} 个允许工具</span></span></Button>)}</div>
    {state.editing && <form onSubmit={event => { event.preventDefault(); void state.save(); }}><FieldGroup>
      <div className="model-settings-section-heading"><h3>{state.service ? "编辑服务" : "添加服务"}</h3><Button type="button" variant="ghost" size="sm" disabled={state.phase === "saving" || state.phase === "unknown"} onClick={() => state.closeEditor()}>关闭编辑</Button></div>
      <Field data-invalid={!!state.fieldErrors.name}><FieldLabel htmlFor="mcp-name">服务名称</FieldLabel><Input id="mcp-name" value={state.draft.name} disabled={state.disabled || !!state.service} aria-invalid={!!state.fieldErrors.name} onChange={event => state.edit("name", event.target.value)} />{state.fieldErrors.name && <FieldDescription role="alert">{state.fieldErrors.name}</FieldDescription>}</Field>
      <Field data-invalid={!!state.fieldErrors.endpoint}><FieldLabel htmlFor="mcp-endpoint">HTTPS 端点</FieldLabel><Input id="mcp-endpoint" value={state.draft.endpoint} disabled={state.disabled} aria-invalid={!!state.fieldErrors.endpoint} onChange={event => state.edit("endpoint", event.target.value)} />{state.fieldErrors.endpoint && <FieldDescription role="alert">{state.fieldErrors.endpoint}</FieldDescription>}</Field>
      <Field data-invalid={!!state.fieldErrors.auth}><FieldLabel htmlFor="mcp-auth">认证</FieldLabel><Select value={state.draft.auth} disabled={state.disabled} onValueChange={value => state.edit("auth", value as typeof state.draft.auth)}><SelectTrigger id="mcp-auth" aria-invalid={!!state.fieldErrors.auth}><SelectValue placeholder="选择认证方式" /></SelectTrigger><SelectContent><SelectGroup>{state.service && <SelectItem value="keep">保留当前凭据</SelectItem>}<SelectItem value="anonymous">匿名</SelectItem><SelectItem value="existing">选择已有凭据</SelectItem><SelectItem value="new">保存新的 Bearer 令牌</SelectItem></SelectGroup></SelectContent></Select>{state.fieldErrors.auth && <FieldDescription role="alert">{state.fieldErrors.auth}</FieldDescription>}{state.draft.auth === "keep" && state.service?.credential && !credential && <FieldDescription role="alert">当前凭据不可用，请重新选择。</FieldDescription>}</Field>
      {state.draft.auth === "existing" && <Field><FieldLabel htmlFor="mcp-credential">已有凭据</FieldLabel><Select value={state.draft.credential} disabled={state.disabled} onValueChange={value => state.edit("credential", value)}><SelectTrigger id="mcp-credential"><SelectValue placeholder="选择凭据" /></SelectTrigger><SelectContent><SelectGroup>{state.credentials.map((credential, index) => <SelectItem key={credential.name} value={credential.name}>{credential.host} · {credential.references.length ? credential.references.map(ref => ref.serviceName).join("、") : `未引用凭据 ${index + 1}`}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>}
      {state.draft.auth === "new" && <Field data-invalid={!!state.fieldErrors.secret}><FieldLabel htmlFor="mcp-secret">Bearer 令牌</FieldLabel><Input id="mcp-secret" type="password" autoComplete="off" value={state.secret} disabled={state.disabled} aria-invalid={!!state.fieldErrors.secret} onChange={event => state.editSecret(event.target.value)} />{state.fieldErrors.secret && <FieldDescription role="alert">{state.fieldErrors.secret}</FieldDescription>}</Field>}
      <Tools state={state} />
      <div className="model-settings-actions"><Button type="button" variant="outline" size="sm" disabled={state.disabled || state.dirty || !state.service} onClick={() => void state.discover()}>检查连接</Button></div>
      {state.check && <p role="status">{state.check.ok ? `发现 ${state.check.tools.length} 个工具` : state.check.error ?? `检查失败（${state.check.errorCode ?? "连接错误"}），请核实当前入口后再检查。`}</p>}
      {state.check?.permissions && <p role="status">辅助功能：{state.check.permissions.accessibility ? "已授权" : "未授权"} · 屏幕录制：{state.check.permissions.screenRecording ? "已授权" : "未授权"}</p>}
      {state.phase === "conflict" && comparison && <div className="model-settings-notice"><p>后台当前值（草稿仍在上方）：</p><pre>{JSON.stringify({ endpoint: comparison.endpoint, credential: comparison.credential ? "已引用凭据" : "匿名", enabled: comparison.enabled, tools: comparison.toolAllowlist }, null, 2)}</pre>{!state.selectedId && <Button type="button" variant="outline" size="sm" disabled={state.disabled} onClick={() => state.useCurrentService()}>以当前同名服务继续编辑</Button>}</div>}
      <footer className="model-settings-footer"><div className="model-settings-actions">{state.service && <><Button type="button" variant="ghost" size="sm" disabled={state.disabled || state.dirty} onClick={() => setConfirmation({ kind: "remove" })}>删除服务</Button><Button type="button" variant="outline" size="sm" disabled={state.disabled || state.dirty} onClick={() => setConfirmation({ kind: state.service!.enabled ? "disable" : "enable" })}>{state.service.enabled ? "停用" : "启用"}</Button></>}<Button type="button" variant="ghost" size="sm" disabled={state.disabled || !state.dirty} onClick={() => state.discard()}>放弃更改</Button></div><Button type="submit" size="sm" disabled={state.disabled || !state.dirty}>{state.service ? "保存" : "保存草稿"}</Button></footer>
    </FieldGroup></form>}
    {!!state.credentials.length && <SettingsSection title="MCP 凭据">{state.credentials.map((credential, index) => <Field key={credential.name}><FieldLabel>{credential.host} · 凭据 {index + 1}</FieldLabel><FieldDescription>{credential.references.length ? credential.references.map(ref => ref.serviceName).join("、") : "无服务引用，可清理。"}</FieldDescription><Button type="button" variant="ghost" size="sm" disabled={state.disabled || state.dirty} onClick={() => setConfirmation({ kind: "credential", name: credential.name })}>查看并清理凭据</Button></Field>)}</SettingsSection>}
    {state.message && <p className="model-settings-notice" role="status">{state.message}</p>}
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open) setConfirmation(null); }}><DialogContent className="demo-dialog"><DialogHeader><DialogTitle>{confirmation?.kind === "credential" ? "删除凭据？" : confirmation?.kind === "enable" ? "启用服务？" : confirmation?.kind === "disable" ? "停用服务？" : "删除服务？"}</DialogTitle><DialogDescription>本实例的全部工作区共用此配置。</DialogDescription></DialogHeader>{confirmation?.kind === "credential" ? <p>{affected.length ? `受影响引用：${affected.map(ref => ref.serviceName).join("、")}。请先更换或清除引用。` : "没有服务引用。"}</p> : <p>{state.service?.name} · {state.service?.endpoint}</p>}<DialogFooter><Button type="button" variant="ghost" onClick={() => setConfirmation(null)}>取消</Button><Button type="button" disabled={state.disabled || confirmation?.kind === "credential" && !!affected.length} onClick={() => void confirm()}>确认</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}

function CodeMcpForm({ settings, scope, code }: SettingsPageProps) {
  const [state] = useState(() => new CodeMcpState({ request: (...args) => window.ruukoto.request(...args) }, settings.changed, scope.instanceId!, () => ({ instanceId: code.view.instanceId, online: code.status.state === "online" })));
  useEffect(() => { settings.form = state; void state.read(); return () => { state.invalidate(); if (settings.form === state) settings.form = null; }; }, [settings, state]);
  return <CodeMcpEditor state={state} />;
}

export function CodeMcpSettings(props: SettingsPageProps) {
  if (props.settings.form instanceof CodeMcpState && props.settings.form.pending) return <CodeMcpForm {...props} />;
  if (!props.scope.instanceId) return <FieldDescription role="status">Code 已离线，请恢复连接后管理 MCP。</FieldDescription>;
  return <CodeMcpForm {...props} />;
}
