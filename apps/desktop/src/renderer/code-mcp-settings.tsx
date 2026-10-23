import { useEffect, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import type { SettingsPageProps } from "./settings-dialog.tsx";
import { CodeMcpState } from "./code-mcp-state.ts";
import { Button } from "./components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "./components/ui/field.tsx";
import { Input } from "./components/ui/input.tsx";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select.tsx";

type Confirmation = { kind: "enable" | "disable" | "remove" } | { kind: "credential"; name: string };
const effects = { read: "只读", write: "写入", unknown: "副作用不明" } as const;

function Tools({ state }: { state: CodeMcpState }) {
  const names = Array.from(new Set([...state.draft.toolAllowlist.map(tool => tool.name), ...(state.check?.tools.map(tool => tool.name) ?? [])]));
  if (!names.length) return null;
  return <fieldset className="model-settings-section"><legend>允许的工具</legend>
    <FieldGroup>{names.map((name, index) => {
      const allowed = state.draft.toolAllowlist.find(tool => tool.name === name);
      return <Field key={name} orientation="horizontal" className="mcp-tool-row"><FieldLabel htmlFor={`mcp-tool-${index}`}>{name}</FieldLabel><Select value={allowed ? state.draft.kind === "cua-mac" ? "allowed" : allowed.effect : "blocked"} disabled={state.disabled} onValueChange={value => { if (value === "blocked") state.allow(name, false); else if (state.draft.kind === "cua-mac") state.allow(name, true); else if (!allowed) { state.allow(name, true); state.effect(name, value as keyof typeof effects); } else state.effect(name, value as keyof typeof effects); }}><SelectTrigger id={`mcp-tool-${index}`}><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="blocked">不允许</SelectItem>{state.draft.kind === "cua-mac" ? <SelectItem value="allowed">允许（{effects[state.check?.tools.find(tool => tool.name === name)?.effect ?? allowed?.effect ?? "unknown"]}）</SelectItem> : Object.entries(effects).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>;
    })}</FieldGroup>
  </fieldset>;
}

function CuaRecovery({ state }: { state: CodeMcpState }) {
  const status = state.cuaStatus, observation = status?.observation;
  return <fieldset className="model-settings-section"><legend>本机电脑</legend><div className="model-settings-actions"><Button type="button" variant="ghost" size="icon-sm" aria-label="刷新电脑状态" disabled={state.reading || state.checking || !state.connected || state.phase === "saving"} onClick={() => void state.refreshCua()}><RefreshCw /></Button>{status && <span role="status">{({ idle: "未连接", connecting: "连接中", active: "使用中", frozen: "待恢复", recovering: "恢复中" })[status.state]}</span>}</div>
    {status && <>{status.original && <p>{status.original.toolName} · 结果待确认</p>}
      <div className="model-settings-actions">{(status.state === "frozen" && !status.stopped || status.state === "active" && !!state.service?.cua) && <Button type="button" variant="outline" size="sm" disabled={state.disabled || state.dirty} onClick={() => { if (status.state === "active") void state.pauseCua(); else void state.cuaAction("stop"); }}>停止电脑操作</Button>}
        {status.stopped && !status.ownerStarted && <Button type="button" variant="outline" size="sm" disabled={state.disabled || state.dirty} onClick={() => void state.cuaAction("begin")}>已检查结果，开始恢复</Button>}
        {status.ownerStarted && !observation && <Button type="button" variant="outline" size="sm" disabled={state.disabled || state.dirty} onClick={() => void state.cuaAction("observe")}>获取截图</Button>}
      </div>
      {observation && <>{state.cuaImages.map((image, index) => <div className="file-image" key={`${observation.id}:${image.id}`}><img src={image.source} alt={`恢复新截图 ${index + 1}`} onLoad={() => state.imageLoaded(observation.id, image.id, true)} onError={() => state.imageLoaded(observation.id, image.id, false)} /></div>)}<div className="model-settings-actions"><Button type="button" variant="outline" size="sm" disabled={state.disabled || state.dirty} onClick={() => void state.cuaAction("observe")}>重新截图</Button><Button type="button" size="sm" disabled={state.disabled || state.dirty || !state.canAcceptCua} onClick={() => void state.cuaAction("accept")}>确认恢复</Button></div></>}
    </>}
    {state.cuaError && <p role="alert">{state.cuaError}</p>}
  </fieldset>;
}

export function CodeMcpEditor({ state, settings, workspaceName }: { state: CodeMcpState; settings: SettingsPageProps["settings"]; workspaceName: string }) {
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const sourceName = state.sources.find(source => source.projectId === state.sourceId)?.name ?? "读取中";
  const scopeLabel = `${workspaceName} / ${sourceName}`;
  const comparison = state.service ?? state.conflictingService;
  const selectedProgram = state.cuaTargets.findIndex(target => JSON.stringify(target.config) === JSON.stringify(state.draft.cua));
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
    <FieldGroup><Field><FieldLabel htmlFor="mcp-source">配置来源</FieldLabel><Select value={state.sources.some(source => source.projectId === state.sourceId) ? state.sourceId : ""} disabled={state.disabled && state.phase !== "error"} onValueChange={value => settings.chooseSource(value)}><SelectTrigger id="mcp-source"><SelectValue placeholder="选择配置来源" /></SelectTrigger><SelectContent><SelectGroup>{state.sources.map(source => <SelectItem key={source.projectId} value={source.projectId}>{source.name} · {source.serviceCount} 个服务{source.isWorkspace ? "（工作区自身）" : ""}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>{state.hasMoreSources && <Button type="button" variant="ghost" size="sm" disabled={state.disabled} onClick={() => void state.moreSources()}>加载更多来源</Button>}</FieldGroup>
    <div className="model-settings-section-heading"><h3>服务</h3><div className="model-settings-actions"><Button type="button" variant="ghost" size="icon-sm" aria-label="重新读取 MCP 配置" disabled={state.reading || state.phase === "saving"} onClick={() => void state.read()}><RefreshCw /></Button><Button type="button" variant="ghost" size="sm" disabled={state.disabled || state.dirty} onClick={() => state.select(null)}><Plus data-icon="inline-start" />添加服务</Button></div></div>
    {!state.connected && <p className="model-settings-notice" role="status">Code 已离线，请恢复连接。</p>}
    {state.reading && <p role="status">正在读取配置…</p>}
    <div className="mcp-service-list">{state.services.map(service => <Button key={service.id} type="button" variant="ghost" className="model-settings-row" disabled={state.disabled || state.dirty} onClick={() => state.select(service.id)}><span className="model-settings-row-copy"><span className="model-settings-row-title">{service.name} · {service.enabled ? "已启用" : "已停用"}</span><span className="model-settings-row-detail">{service.cua ? "本机 Cua Driver" : service.endpoint}</span><span className="model-settings-row-detail">{service.cua ? "本机" : service.credential ? state.credentials.some(credential => credential.name === service.credential) ? "已配置凭据" : "凭据不可用" : "匿名"} · {service.toolAllowlist.length} 个允许工具</span></span></Button>)}</div>
    {state.editing && <form onSubmit={event => { event.preventDefault(); void state.save(); }}><FieldGroup>
      <div className="model-settings-section-heading"><h3>{state.service ? "编辑服务" : "添加服务"}</h3><Button type="button" variant="ghost" size="sm" disabled={state.phase === "saving" || state.phase === "unknown"} onClick={() => state.closeEditor()}>关闭编辑</Button></div>
      <Field><FieldLabel htmlFor="mcp-kind">服务类型</FieldLabel><Select value={state.draft.kind} disabled={state.disabled || !!state.service} onValueChange={value => state.selectKind(value as typeof state.draft.kind)}><SelectTrigger id="mcp-kind"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="http">HTTPS MCP 服务</SelectItem><SelectItem value="cua-mac">本机 Cua Driver</SelectItem></SelectGroup></SelectContent></Select></Field>
      <Field data-invalid={!!state.fieldErrors.name}><FieldLabel htmlFor="mcp-name">服务名称</FieldLabel><Input id="mcp-name" value={state.draft.name} disabled={state.disabled || !!state.service} aria-invalid={!!state.fieldErrors.name} onChange={event => state.edit("name", event.target.value)} />{state.fieldErrors.name && <FieldDescription role="alert">{state.fieldErrors.name}</FieldDescription>}</Field>
      {state.draft.kind === "cua-mac" ? <Field data-invalid={!!state.fieldErrors.cua}><FieldLabel htmlFor="mcp-cua-program">已安装的 Cua Driver</FieldLabel><Select value={selectedProgram < 0 ? "" : String(selectedProgram)} disabled={state.disabled} onValueChange={value => state.selectCua(Number(value))}><SelectTrigger id="mcp-cua-program" aria-invalid={!!state.fieldErrors.cua}><SelectValue placeholder="选择本机程序" /></SelectTrigger><SelectContent><SelectGroup>{state.cuaTargets.map((target, index) => <SelectItem key={index} value={String(index)}>{target.label}</SelectItem>)}</SelectGroup></SelectContent></Select>{state.service?.cua && <p>{state.service.cua.executable}</p>}{!state.cuaTargets.length && !state.cuaIssues.length && <FieldDescription>未找到 Cua Driver，请先安装。</FieldDescription>}{state.cuaIssues.map((issue, index) => <FieldDescription key={index} role="status">{issue.message}</FieldDescription>)}{state.fieldErrors.cua && <FieldDescription role="alert">{state.fieldErrors.cua}</FieldDescription>}</Field> : <><Field data-invalid={!!state.fieldErrors.endpoint}><FieldLabel htmlFor="mcp-endpoint">HTTPS 端点</FieldLabel><Input id="mcp-endpoint" value={state.draft.endpoint} disabled={state.disabled} aria-invalid={!!state.fieldErrors.endpoint} onChange={event => state.edit("endpoint", event.target.value)} />{state.fieldErrors.endpoint && <FieldDescription role="alert">{state.fieldErrors.endpoint}</FieldDescription>}</Field>
      <Field data-invalid={!!state.fieldErrors.auth}><FieldLabel htmlFor="mcp-auth">认证</FieldLabel><Select value={state.draft.auth} disabled={state.disabled} onValueChange={value => state.edit("auth", value as typeof state.draft.auth)}><SelectTrigger id="mcp-auth" aria-invalid={!!state.fieldErrors.auth}><SelectValue placeholder="选择认证方式" /></SelectTrigger><SelectContent><SelectGroup>{state.service && <SelectItem value="keep">保留当前凭据</SelectItem>}<SelectItem value="anonymous">匿名</SelectItem><SelectItem value="existing">选择已有凭据</SelectItem><SelectItem value="new">保存新的 Bearer 令牌</SelectItem></SelectGroup></SelectContent></Select>{state.fieldErrors.auth && <FieldDescription role="alert">{state.fieldErrors.auth}</FieldDescription>}{state.draft.auth === "keep" && state.service?.credential && !credential && <FieldDescription role="alert">当前凭据不可用，请重新选择。</FieldDescription>}</Field>
      {state.draft.auth === "existing" && <Field><FieldLabel htmlFor="mcp-credential">已有凭据</FieldLabel><Select value={state.draft.credential} disabled={state.disabled} onValueChange={value => state.edit("credential", value)}><SelectTrigger id="mcp-credential"><SelectValue placeholder="选择凭据" /></SelectTrigger><SelectContent><SelectGroup>{state.credentials.map((credential, index) => <SelectItem key={credential.name} value={credential.name}>{credential.host} · {credential.references.length ? credential.references.map(ref => ref.serviceName).join("、") : `未引用凭据 ${index + 1}`}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>}
      {state.draft.auth === "new" && <Field data-invalid={!!state.fieldErrors.secret}><FieldLabel htmlFor="mcp-secret">Bearer 令牌</FieldLabel><Input id="mcp-secret" type="password" autoComplete="off" value={state.secret} disabled={state.disabled} aria-invalid={!!state.fieldErrors.secret} onChange={event => state.editSecret(event.target.value)} />{state.fieldErrors.secret && <FieldDescription role="alert">{state.fieldErrors.secret}</FieldDescription>}</Field>}
      </>}
      <Tools state={state} />
      <div className="model-settings-actions"><Button type="button" variant="outline" size="sm" disabled={state.disabled || state.dirty || !state.service} onClick={() => void state.discover()}>{state.draft.kind === "cua-mac" ? "检查权限与工具" : "检查连接"}</Button></div>
      {state.check && <p role="status">{state.check.ok ? `发现 ${state.check.tools.length} 个工具` : state.check.error ?? `检查失败（${state.check.errorCode ?? "连接错误"}），请核实当前入口后再检查。`}</p>}
      {state.check?.permissions && <p role="status">辅助功能：{state.check.permissions.accessibility ? "已授权" : "未授权"} · 屏幕录制：{state.check.permissions.screenRecording ? "已授权" : "未授权"}</p>}
      {state.phase === "conflict" && comparison && <div className="model-settings-notice"><p>后台当前值（草稿仍在上方）：</p><pre>{JSON.stringify({ endpoint: comparison.endpoint, credential: comparison.credential ? "已引用凭据" : "匿名", enabled: comparison.enabled, tools: comparison.toolAllowlist }, null, 2)}</pre>{!state.selectedId && <Button type="button" variant="outline" size="sm" disabled={state.disabled} onClick={() => state.useCurrentService()}>以当前同名服务继续编辑</Button>}</div>}
      <footer className="model-settings-footer"><div className="model-settings-actions">{state.service && <><Button type="button" variant="ghost" size="sm" disabled={state.disabled || state.dirty} onClick={() => setConfirmation({ kind: "remove" })}>删除服务</Button><Button type="button" variant="outline" size="sm" disabled={state.disabled || state.dirty} onClick={() => { if (state.service?.cua && state.service.enabled) void state.pauseCua(); else setConfirmation({ kind: state.service!.enabled ? "disable" : "enable" }); }}>{state.service.cua ? state.service.enabled ? "暂停电脑" : "继续使用电脑" : state.service.enabled ? "停用" : "启用"}</Button></>}<Button type="button" variant="ghost" size="sm" disabled={state.disabled || !state.dirty} onClick={() => state.discard()}>放弃更改</Button></div><Button type="submit" size="sm" disabled={state.disabled || !state.dirty}>{state.service ? "保存" : "保存草稿"}</Button></footer>
    </FieldGroup></form>}
    <CuaRecovery state={state} />
    {!!state.credentials.length && <fieldset className="model-settings-section"><legend>此来源的 MCP 凭据</legend>{state.credentials.map((credential, index) => <Field key={credential.name}><FieldLabel>{credential.host} · 凭据 {index + 1}</FieldLabel><FieldDescription>{credential.references.length ? credential.references.map(ref => `${ref.projectName} / ${ref.serviceName}`).join("、") : "无服务引用，可清理。"}</FieldDescription><Button type="button" variant="ghost" size="sm" disabled={state.disabled || state.dirty} onClick={() => setConfirmation({ kind: "credential", name: credential.name })}>查看并清理凭据</Button></Field>)}</fieldset>}
    {state.message && <p className="model-settings-notice" role="status">{state.message}</p>}
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open) setConfirmation(null); }}><DialogContent className="demo-dialog"><DialogHeader><DialogTitle>{confirmation?.kind === "credential" ? "删除凭据？" : confirmation?.kind === "enable" ? "启用服务？" : confirmation?.kind === "disable" ? "停用服务？" : "删除服务？"}</DialogTitle><DialogDescription>{scopeLabel}</DialogDescription></DialogHeader>{confirmation?.kind === "credential" ? <p>{affected.length ? `受影响引用：${affected.map(ref => `${ref.projectName} / ${ref.serviceName}`).join("、")}。请先更换或清除引用。` : "没有服务引用。"}</p> : <p>{state.service?.name} · {state.service?.endpoint}</p>}<DialogFooter><Button type="button" variant="ghost" onClick={() => setConfirmation(null)}>取消</Button><Button type="button" disabled={state.disabled || confirmation?.kind === "credential" && !!affected.length} onClick={() => void confirm()}>确认</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}

function CodeMcpForm({ settings, scope, code }: SettingsPageProps) {
  const sourceId = settings.selections.mcp.sourceId ?? scope.workspaceId!;
  const [workspaceName] = useState(() => code.view.projects.find(project => project.id === scope.workspaceId)?.name ?? "工作区");
  const [state] = useState(() => new CodeMcpState({ request: (...args) => window.ruukoto.request(...args) }, settings.changed, scope.instanceId!, scope.workspaceId!, sourceId, () => ({ instanceId: code.view.instanceId, online: code.status.state === "online" })));
  useEffect(() => { settings.form = state; void state.read().then(read => { if (read) void state.refreshCua(); }); return () => { state.invalidate(); if (settings.form === state) settings.form = null; }; }, [settings, state]);
  return <CodeMcpEditor state={state} settings={settings} workspaceName={workspaceName} />;
}

export function CodeMcpSettings(props: SettingsPageProps) {
  if (props.settings.form instanceof CodeMcpState && props.settings.form.pending) return <CodeMcpForm {...props} />;
  if (!props.scope.instanceId) return <FieldDescription role="status">Code 已离线，请恢复连接后管理 MCP。</FieldDescription>;
  if (!props.scope.workspaceId) return <FieldDescription role="status">请先选择或添加工作区。</FieldDescription>;
  return <CodeMcpForm {...props} />;
}
