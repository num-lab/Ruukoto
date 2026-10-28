import { useEffect, useState } from "react";
import { ChevronRight, Plus, RefreshCw } from "lucide-react";
import type { SettingsPageProps } from "./settings-dialog.tsx";
import { CodeMcpState } from "./code-mcp-state.ts";
import { SettingsButton, SettingsInput, SettingsNotice, SettingsSelect, SettingsSwitch, SettingsTag } from "./components/controls.tsx";
import { SettingsCard, SettingsGroup, SettingsList, SettingsListItem, SettingsPage, SettingsRow, SettingsSubpage } from "./components/settings.tsx";
import { Button } from "./components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";

type Confirmation = { kind: "enable" | "disable" | "remove" } | { kind: "credential"; name: string };
const effects = { read: "只读", write: "写入", unknown: "副作用不明" } as const;
const effectOptions = [{ value: "blocked", label: "不允许" }, { value: "read", label: "只读" }, { value: "write", label: "写入" }, { value: "unknown", label: "副作用不明" }];

export function Tools({ state }: { state: CodeMcpState }) {
  const names = Array.from(new Set([...state.draft.toolAllowlist.map(tool => tool.name), ...(state.check?.tools.map(tool => tool.name) ?? [])]));
  if (!names.length) return null;
  return <SettingsGroup title="允许的工具">
    <SettingsCard>
      {names.map((name, index) => {
        const allowed = state.draft.toolAllowlist.find(tool => tool.name === name);
        return state.draft.kind === "cua-mac"
          ? <SettingsRow key={name} title={name} description={effects[state.check?.tools.find(tool => tool.name === name)?.effect ?? allowed?.effect ?? "unknown"]} htmlFor={`mcp-tool-${index}`}><SettingsSwitch id={`mcp-tool-${index}`} checked={!!allowed} disabled={state.disabled} onChange={event => state.allow(name, event.target.checked)} /></SettingsRow>
          : <SettingsRow key={name} title={name} htmlFor={`mcp-tool-${index}`}><SettingsSelect id={`mcp-tool-${index}`} value={allowed ? allowed.effect : "blocked"} disabled={state.disabled} onChange={event => { const value = event.target.value; if (value === "blocked") state.allow(name, false); else if (!allowed) { state.allow(name, true); state.effect(name, value as keyof typeof effects); } else state.effect(name, value as keyof typeof effects); }} options={effectOptions} /></SettingsRow>;
      })}
    </SettingsCard>
  </SettingsGroup>;
}

function ServiceDetails({ state, confirmation, setConfirmation }: { state: CodeMcpState; confirmation: Confirmation | null; setConfirmation: (value: Confirmation | null) => void }) {
  const [endpoint, setEndpoint] = useState(state.draft.endpoint);
  const credential = state.credentials.find(credential => credential.name === state.service?.credential);
  const comparison = state.service ?? state.conflictingService;
  return (
    <div className="settings-provider-settings">
      <SettingsRow title={state.service ? "编辑服务" : "添加服务"} description="配置 MCP HTTP 服务与允许的工具。"><SettingsButton variant="ghost" disabled={state.phase === "saving" || state.phase === "unknown"} onClick={() => state.closeEditor()}>关闭编辑</SettingsButton></SettingsRow>
      <SettingsRow title="服务名称" htmlFor="mcp-name"><SettingsInput id="mcp-name" value={state.draft.name} disabled={state.disabled || !!state.service} aria-invalid={!!state.fieldErrors.name} onChange={event => state.edit("name", event.target.value)} /></SettingsRow>
      {state.fieldErrors.name && <SettingsRow title="" description={state.fieldErrors.name} />}
      <SettingsRow title="HTTPS 端点" htmlFor="mcp-endpoint"><SettingsInput id="mcp-endpoint" value={endpoint} disabled={state.disabled} aria-invalid={!!state.fieldErrors.endpoint} onChange={event => { setEndpoint(event.target.value); state.edit("endpoint", event.target.value); }} /></SettingsRow>
      {state.fieldErrors.endpoint && <SettingsRow title="" description={state.fieldErrors.endpoint} />}
      <SettingsRow title="认证" htmlFor="mcp-auth"><SettingsSelect id="mcp-auth" value={state.draft.auth} disabled={state.disabled} onChange={event => state.edit("auth", event.target.value as typeof state.draft.auth)} options={[...(state.service ? [{ value: "keep", label: "保留当前凭据" }] : []), { value: "anonymous", label: "匿名" }, { value: "existing", label: "选择已有凭据" }, { value: "new", label: "保存新的 Bearer 令牌" }]} /></SettingsRow>
      {state.fieldErrors.auth && <SettingsRow title="" description={state.fieldErrors.auth} />}
      {state.draft.auth === "keep" && state.service?.credential && !credential && <SettingsRow title="" description="当前凭据不可用，请重新选择。" />}
      {state.draft.auth === "existing" && <SettingsRow title="已有凭据" htmlFor="mcp-credential"><SettingsSelect id="mcp-credential" value={state.draft.credential} disabled={state.disabled} onChange={event => state.edit("credential", event.target.value)} options={state.credentials.map((credential, index) => ({ value: credential.name, label: `${credential.host} · ${credential.references.length ? credential.references.map(ref => ref.serviceName).join("、") : `未引用凭据 ${index + 1}`}` }))} /></SettingsRow>}
      {state.draft.auth === "new" && <SettingsRow title="Bearer 令牌" htmlFor="mcp-secret"><SettingsInput id="mcp-secret" type="password" autoComplete="off" value={state.secret} disabled={state.disabled} aria-invalid={!!state.fieldErrors.secret} onChange={event => state.editSecret(event.target.value)} /></SettingsRow>}
      {state.fieldErrors.secret && <SettingsRow title="" description={state.fieldErrors.secret} />}
      <Tools state={state} />
      <SettingsRow title="连接与工具发现" description="检查不执行业务工具，远端只读标注不自动成为本地授权。" footer={state.check && <SettingsNotice>{state.check.ok ? `发现 ${state.check.tools.length} 个工具` : state.check.error ?? `检查失败（${state.check.errorCode ?? "连接错误"}），请核实当前入口后再检查。`}</SettingsNotice>}>
        <SettingsButton disabled={state.disabled || state.dirty || !state.service} onClick={() => void state.discover()}>检查连接</SettingsButton>
      </SettingsRow>
      {state.phase === "conflict" && comparison && <SettingsRow title="后台当前值" description="草稿仍在上方，比较后决定。" footer={<pre className="settings-code-block">{JSON.stringify({ endpoint: comparison.endpoint, credential: comparison.credential ? "已引用凭据" : "匿名", enabled: comparison.enabled, tools: comparison.toolAllowlist }, null, 2)}</pre>}>
        {!state.selectedId && <SettingsButton variant="ghost" disabled={state.disabled} onClick={() => state.useCurrentService()}>以当前同名服务继续编辑</SettingsButton>}
      </SettingsRow>}
      <SettingsRow title="服务操作" description="本实例的全部工作区共用此配置。">
        {state.service && <><SettingsButton variant="ghost" disabled={state.disabled || state.dirty} onClick={() => setConfirmation({ kind: "remove" })}>删除服务</SettingsButton><SettingsButton variant="ghost" disabled={state.disabled || state.dirty} onClick={() => setConfirmation({ kind: state.service!.enabled ? "disable" : "enable" })}>{state.service.enabled ? "停用" : "启用"}</SettingsButton></>}
        <SettingsButton variant="ghost" disabled={state.disabled || !state.dirty} onClick={() => state.discard()}>放弃更改</SettingsButton>
        <SettingsButton disabled={state.disabled || !state.dirty} onClick={() => void state.save()}>{state.service ? "保存" : "保存草稿"}</SettingsButton>
      </SettingsRow>
    </div>
  );
}

function AddServicePage({ state, onBack }: { state: CodeMcpState; onBack: () => void }) {
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  return (
    <SettingsSubpage title="添加服务" description="配置 MCP HTTP 服务与允许的工具。" onBack={onBack}>
      <SettingsGroup title="服务">
        <SettingsCard>
          <SettingsRow title="服务名称" htmlFor="new-mcp-name"><SettingsInput id="new-mcp-name" value={name} onChange={event => setName(event.target.value)} placeholder="服务名称" /></SettingsRow>
          <SettingsRow title="HTTPS 端点" htmlFor="new-mcp-endpoint"><SettingsInput id="new-mcp-endpoint" type="url" value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="https://mcp.example.com" /></SettingsRow>
          <SettingsRow title="认证方式" htmlFor="new-mcp-auth"><SettingsSelect id="new-mcp-auth" options={[{ value: "anonymous", label: "匿名" }, { value: "new", label: "保存新的 Bearer 令牌" }]} /></SettingsRow>
        </SettingsCard>
      </SettingsGroup>
      <div className="settings-subpage-actions"><SettingsButton variant="ghost" onClick={onBack}>取消</SettingsButton><SettingsButton disabled={!name.trim() || !endpoint.trim()} onClick={() => { state.select(null); state.edit("name", name.trim()); state.edit("endpoint", endpoint.trim()); onBack(); }}>保存草稿</SettingsButton></div>
    </SettingsSubpage>
  );
}

export function CodeMcpEditor({ state }: { state: CodeMcpState }) {
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [adding, setAdding] = useState(false);
  const affected = confirmation?.kind === "credential" ? state.credentials.find(credential => credential.name === confirmation.name)?.references ?? [] : [];
  useEffect(() => { if (Object.keys(state.fieldErrors).length) document.querySelector<HTMLElement>('.settings-page [aria-invalid="true"]')?.focus(); }, [state.fieldErrors]);
  const confirm = async () => {
    const action = confirmation; setConfirmation(null);
    if (action?.kind === "enable" || action?.kind === "disable") await state.setEnabled(action.kind === "enable");
    else if (action?.kind === "remove") await state.remove();
    else if (action?.kind === "credential") await state.removeCredential(action.name);
  };
  if (adding) return <AddServicePage state={state} onBack={() => setAdding(false)} />;
  return (
    <SettingsPage title="MCP" description="管理当前 Code 实例共用的 HTTP 服务。">
      <SettingsGroup title="服务" action={<SettingsButton onClick={() => setAdding(true)} disabled={state.disabled || state.dirty}><Plus />添加服务</SettingsButton>}>
        {!state.connected && <SettingsNotice>Code 已离线，请恢复连接。</SettingsNotice>}
        {state.reading && <SettingsNotice>正在读取配置…</SettingsNotice>}
        <SettingsList label="MCP 服务" empty="尚未配置 HTTP 服务。">
          {state.services.filter(service => !service.cua).map(service => <SettingsListItem key={service.id} title={service.name} description={`${service.endpoint} · ${service.credential ? state.credentials.some(credential => credential.name === service.credential) ? "已配置凭据" : "凭据不可用" : "匿名"} · ${service.toolAllowlist.length} 个允许工具`} details={state.editing && state.selectedId === service.id ? <ServiceDetails state={state} confirmation={confirmation} setConfirmation={setConfirmation} /> : undefined}>
            <SettingsTag>{service.enabled ? "已启用" : "已停用"}</SettingsTag>
            <SettingsButton variant="ghost" onClick={() => state.editing && state.selectedId === service.id ? state.closeEditor() : state.select(service.id)} aria-expanded={state.editing && state.selectedId === service.id} aria-label={`${state.editing && state.selectedId === service.id ? "收起" : "编辑"} ${service.name}`}><ChevronRight /></SettingsButton>
          </SettingsListItem>)}
        </SettingsList>
        {state.editing && !state.selectedId && <SettingsCard className="settings-import-preview"><ServiceDetails state={state} confirmation={confirmation} setConfirmation={setConfirmation} /></SettingsCard>}
      </SettingsGroup>
      {!!state.credentials.length && <SettingsGroup title="MCP 凭据" description="凭据只写入所属后端，列表不显示秘密。">
        <SettingsCard>
          {state.credentials.map((credential, index) => <SettingsRow key={credential.name} title={`${credential.host} · 凭据 ${index + 1}`} description={credential.references.length ? credential.references.map(ref => ref.serviceName).join("、") : "无服务引用，可清理。"}><SettingsButton variant="ghost" disabled={state.disabled || state.dirty} onClick={() => setConfirmation({ kind: "credential", name: credential.name })}>查看并清理凭据</SettingsButton></SettingsRow>)}
        </SettingsCard>
      </SettingsGroup>}
      {state.message && <SettingsNotice>{state.message}</SettingsNotice>}
      <Dialog open={!!confirmation} onOpenChange={open => { if (!open) setConfirmation(null); }}><DialogContent className="demo-dialog"><DialogHeader><DialogTitle>{confirmation?.kind === "credential" ? "删除凭据？" : confirmation?.kind === "enable" ? "启用服务？" : confirmation?.kind === "disable" ? "停用服务？" : "删除服务？"}</DialogTitle><DialogDescription>本实例的全部工作区共用此配置。</DialogDescription></DialogHeader>{confirmation?.kind === "credential" ? <p>{affected.length ? `受影响引用：${affected.map(ref => ref.serviceName).join("、")}。请先更换或清除引用。` : "没有服务引用。"}</p> : <p>{state.service?.name} · {state.service?.endpoint}</p>}<DialogFooter><Button type="button" variant="ghost" onClick={() => setConfirmation(null)}>取消</Button><Button type="button" disabled={state.disabled || confirmation?.kind === "credential" && !!affected.length} onClick={() => void confirm()}>确认</Button></DialogFooter></DialogContent></Dialog>
    </SettingsPage>
  );
}

function CodeMcpForm({ settings, scope, code }: SettingsPageProps) {
  const [state] = useState(() => new CodeMcpState({ request: (...args) => window.ruukoto.request(...args) }, settings.changed, scope.instanceId!, () => ({ instanceId: code.view.instanceId, online: code.status.state === "online" })));
  useEffect(() => { settings.form = state; void state.read(); return () => { state.invalidate(); if (settings.form === state) settings.form = null; }; }, [settings, state]);
  return <CodeMcpEditor state={state} />;
}

export function CodeMcpSettings(props: SettingsPageProps) {
  if (props.settings.form instanceof CodeMcpState && props.settings.form.pending) return <CodeMcpForm {...props} />;
  if (!props.scope.instanceId) return <SettingsPage title="MCP" description="管理当前 Code 实例共用的 HTTP 服务。"><SettingsNotice>Code 已离线，请恢复连接后管理 MCP。</SettingsNotice></SettingsPage>;
  return <CodeMcpForm {...props} />;
}
