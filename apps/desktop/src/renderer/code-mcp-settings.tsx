import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import type { SettingsPageProps } from "./settings-dialog.tsx";
import { CodeMcpState } from "./code-mcp-state.ts";
import { SettingsButton, SettingsInput, SettingsNotice, SettingsSelect, SettingsSwitch, SettingsTag } from "./components/controls.tsx";
import { SettingsCard, SettingsGroup, SettingsList, SettingsListItem, SettingsPage, SettingsRow, SettingsSubpage } from "./components/settings.tsx";
import { Button } from "./components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";

type Confirmation = { kind: "enable" | "disable" | "remove" } | { kind: "credential"; name: string };
const effects = { read: "Read only", write: "Write", unknown: "Effects unknown" } as const;
const effectOptions = [{ value: "blocked", label: "Blocked" }, { value: "read", label: "Read only" }, { value: "write", label: "Write" }, { value: "unknown", label: "Effects unknown" }];

export function Tools({ state }: { state: CodeMcpState }) {
  const names = Array.from(new Set([...state.draft.toolAllowlist.map(tool => tool.name), ...(state.check?.tools.map(tool => tool.name) ?? [])]));
  if (!names.length) return null;
  return <SettingsGroup title="Allowed tools">
    <SettingsCard>
      {names.map((name, index) => {
        const allowed = state.draft.toolAllowlist.find(tool => tool.name === name);
        return state.draft.kind === "cua-mac"
          ? <SettingsRow key={name} title={name} description={effects[state.check?.tools.find(tool => tool.name === name)?.effect ?? allowed?.effect ?? "unknown"]} htmlFor={`mcp-tool-${index}`}><SettingsSwitch id={`mcp-tool-${index}`} checked={!!allowed} disabled={state.disabled} onChange={event => state.allow(name, event.target.checked)} /></SettingsRow>
          : <SettingsRow key={name} title={name} htmlFor={`mcp-tool-${index}`}><SettingsSelect id={`mcp-tool-${index}`} value={allowed ? allowed.effect : "blocked"} disabled={state.disabled} onValueChange={nextValue => { const value = nextValue; if (value === "blocked") state.allow(name, false); else if (!allowed) { state.allow(name, true); state.effect(name, value as keyof typeof effects); } else state.effect(name, value as keyof typeof effects); }} options={effectOptions} /></SettingsRow>;
      })}
    </SettingsCard>
  </SettingsGroup>;
}

function ServiceFields({ state, onAdopt }: { state: CodeMcpState; onAdopt?: () => void }) {
  const credential = state.credentials.find(credential => credential.name === state.service?.credential);
  const comparison = state.service ?? state.conflictingService;
  const credentialUnavailable = state.draft.auth === "keep" && !!state.service?.credential && !credential;
  const authError = state.draft.auth === "existing" ? undefined : state.fieldErrors.auth;
  return (
    <>
      <SettingsRow title="Service name" htmlFor="mcp-name" error={state.fieldErrors.name}><SettingsInput id="mcp-name" value={state.draft.name} disabled={state.disabled || !!state.service} placeholder="Service name" aria-invalid={!!state.fieldErrors.name} onChange={event => state.edit("name", event.target.value)} /></SettingsRow>
      <SettingsRow title="HTTPS endpoint" htmlFor="mcp-endpoint" error={state.fieldErrors.endpoint}><SettingsInput id="mcp-endpoint" type="url" value={state.draft.endpoint} disabled={state.disabled} placeholder="https://mcp.example.com" aria-invalid={!!state.fieldErrors.endpoint} onChange={event => state.edit("endpoint", event.target.value)} /></SettingsRow>
      <SettingsRow title="Auth" htmlFor="mcp-auth" error={authError ?? (credentialUnavailable ? "The current credential is unavailable. Select another one." : undefined)}><SettingsSelect id="mcp-auth" value={state.draft.auth} disabled={state.disabled} aria-invalid={!!authError || credentialUnavailable} onValueChange={nextValue => state.edit("auth", nextValue as typeof state.draft.auth)} options={[{ value: "", label: "Select an auth method", disabled: true }, ...(state.service ? [{ value: "keep", label: "Keep current credential" }] : []), { value: "anonymous", label: "Anonymous" }, { value: "existing", label: "Use an existing credential" }, { value: "new", label: "Save a new Bearer token" }]} /></SettingsRow>
      {state.draft.auth === "existing" && <SettingsRow title="Existing credential" htmlFor="mcp-credential" error={state.fieldErrors.auth}><SettingsSelect id="mcp-credential" value={state.draft.credential} disabled={state.disabled} aria-invalid={!!state.fieldErrors.auth} onValueChange={nextValue => state.edit("credential", nextValue)} options={[{ value: "", label: "Select a credential", disabled: true }, ...state.credentials.map((credential, index) => ({ value: credential.name, label: `${credential.host} · ${credential.references.length ? credential.references.map(ref => ref.serviceName).join(", ") : `Unreferenced credential ${index + 1}`}` }))]} /></SettingsRow>}
      {state.draft.auth === "new" && <SettingsRow title="Bearer token" htmlFor="mcp-secret" error={state.fieldErrors.secret}><SettingsInput id="mcp-secret" type="password" autoComplete="off" value={state.secret} disabled={state.disabled} aria-invalid={!!state.fieldErrors.secret} onChange={event => state.editSecret(event.target.value)} /></SettingsRow>}
      <Tools state={state} />
      {state.service && <SettingsRow title="Connection and tool discovery" description="Checking does not execute business tools; remote read-only labels don't become local authorization." footer={state.check && <SettingsNotice>{state.check.ok ? `Found ${state.check.tools.length} tools` : state.check.error ?? `Check failed (${state.check.errorCode ?? "connection error"}); verify the current entry and check again.`}</SettingsNotice>}>
        <SettingsButton disabled={state.disabled || state.dirty} onClick={() => void state.discover()}>Check connection</SettingsButton>
      </SettingsRow>}
      {state.phase === "conflict" && comparison && <SettingsRow title="Current backend value" description="Your draft is above; compare and decide." footer={<pre className="settings-code-block">{JSON.stringify({ endpoint: comparison.endpoint, credential: comparison.credential ? "Referenced credential" : "Anonymous", enabled: comparison.enabled, tools: comparison.toolAllowlist }, null, 2)}</pre>}>
        {!state.selectedId && <SettingsButton variant="ghost" disabled={state.disabled} onClick={() => { state.useCurrentService(); onAdopt?.(); }}>Continue editing as the same-named service</SettingsButton>}
      </SettingsRow>}
    </>
  );
}

function ServiceDetails({ state, confirmation, setConfirmation }: { state: CodeMcpState; confirmation: Confirmation | null; setConfirmation: (value: Confirmation | null) => void }) {
  return (
    <div className="settings-provider-settings">
      <SettingsRow title="Edit service" description="Configure the MCP HTTP service and allowed tools."><SettingsButton variant="ghost" disabled={state.phase === "saving" || state.phase === "unknown"} onClick={() => state.closeEditor()}>Close editor</SettingsButton></SettingsRow>
      <ServiceFields state={state} />
      <SettingsRow title="Service actions" description="This configuration is shared by all workspaces of this instance.">
        {state.service && <><SettingsButton variant="ghost" disabled={state.disabled || state.dirty} onClick={() => setConfirmation({ kind: "remove" })}>Delete service</SettingsButton><SettingsButton variant="ghost" disabled={state.disabled || state.dirty} onClick={() => setConfirmation({ kind: state.service!.enabled ? "disable" : "enable" })}>{state.service.enabled ? "Disable" : "Enable"}</SettingsButton></>}
        <SettingsButton variant="ghost" disabled={state.disabled || !state.dirty} onClick={() => state.discard()}>Discard changes</SettingsButton>
        <SettingsButton disabled={state.disabled || !state.dirty} onClick={() => void state.save()}>Save</SettingsButton>
      </SettingsRow>
    </div>
  );
}

export function AddServicePage({ state, onCancel, onSaved }: { state: CodeMcpState; onCancel: () => void; onSaved: () => void }) {
  const save = async () => {
    state.edit("name", state.draft.name.trim()); state.edit("endpoint", state.draft.endpoint.trim());
    if (await state.save()) onSaved();
  };
  return (
    <SettingsSubpage title="Add service" description="Configure the MCP HTTP service and allowed tools." onBack={onCancel}>
      {!state.connected && <SettingsNotice>ruukoto is offline. Restore the connection.</SettingsNotice>}
      <SettingsGroup title="Services">
        <SettingsCard><ServiceFields state={state} onAdopt={onSaved} /></SettingsCard>
      </SettingsGroup>
      {state.message && <SettingsNotice>{state.message}</SettingsNotice>}
      {(state.phase === "unknown" || state.phase === "error" || state.phase === "conflict") && <SettingsButton variant="ghost" disabled={state.reading || !state.connected} onClick={() => void state.read()}>Verify original configuration</SettingsButton>}
      <div className="settings-subpage-actions"><SettingsButton variant="ghost" disabled={state.phase === "saving" || state.phase === "unknown"} onClick={onCancel}>Cancel</SettingsButton><SettingsButton variant="primary" disabled={state.disabled || !state.dirty} onClick={() => void save()}>Save</SettingsButton></div>
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
  const cancelAdd = () => { if (state.phase === "saving" || state.phase === "unknown") return; state.closeEditor(); setAdding(false); };
  if (adding) return <AddServicePage state={state} onCancel={cancelAdd} onSaved={() => setAdding(false)} />;
  return (
    <SettingsPage title="MCP" description="Manage HTTP services shared by this ruukoto instance.">
      <SettingsGroup title="Services" action={<SettingsButton variant="primary" onClick={() => { state.select(null); setAdding(true); }} disabled={state.disabled || state.dirty}><Plus />Add service</SettingsButton>}>
        {!state.connected && <SettingsNotice>ruukoto is offline. Restore the connection.</SettingsNotice>}
        {state.reading && <SettingsNotice>Loading configuration…</SettingsNotice>}
        <SettingsList label="MCP services" empty="No HTTP services configured yet.">
          {state.services.filter(service => !service.cua).map(service => <SettingsListItem key={service.id} title={service.name} description={`${service.endpoint} · ${service.credential ? state.credentials.some(credential => credential.name === service.credential) ? "Credential configured" : "Credential unavailable" : "Anonymous"} · ${service.toolAllowlist.length} allowed tools`} expanded={state.editing && state.selectedId === service.id} toggleLabel={`${state.editing && state.selectedId === service.id ? "Collapse" : "Edit"} ${service.name}`} onToggle={() => state.editing && state.selectedId === service.id ? state.closeEditor() : state.select(service.id)} details={state.editing && state.selectedId === service.id ? <ServiceDetails state={state} confirmation={confirmation} setConfirmation={setConfirmation} /> : undefined}>
            <SettingsTag>{service.enabled ? "Enabled" : "Disabled"}</SettingsTag>
          </SettingsListItem>)}
        </SettingsList>
      </SettingsGroup>
      {!!state.credentials.length && <SettingsGroup title="MCP credentials">
        <SettingsCard>
          {state.credentials.map((credential, index) => <SettingsRow key={credential.name} title={`${credential.host} · Credential ${index + 1}`} description={credential.references.length ? credential.references.map(ref => ref.serviceName).join(", ") : "No service references; safe to clean up."}><SettingsButton variant="ghost" disabled={state.disabled || state.dirty} onClick={() => setConfirmation({ kind: "credential", name: credential.name })}>View and clean up credential</SettingsButton></SettingsRow>)}
        </SettingsCard>
      </SettingsGroup>}
      {state.message && <SettingsNotice>{state.message}</SettingsNotice>}
      {(state.phase === "unknown" || state.phase === "error" || state.phase === "conflict") && <SettingsButton variant="ghost" disabled={state.reading || !state.connected} onClick={() => void state.read()}>Verify original configuration</SettingsButton>}
      <Dialog open={!!confirmation} onOpenChange={open => { if (!open) setConfirmation(null); }}><DialogContent className="app-dialog"><DialogHeader><DialogTitle>{confirmation?.kind === "credential" ? "Delete credential?" : confirmation?.kind === "enable" ? "Enable service?" : confirmation?.kind === "disable" ? "Disable service?" : "Delete service?"}</DialogTitle><DialogDescription>This configuration is shared by all workspaces of this instance.</DialogDescription></DialogHeader>{confirmation?.kind === "credential" ? <p>{affected.length ? `Affected references: ${affected.map(ref => ref.serviceName).join(", ")}. Replace or clear them first.` : "No service references."}</p> : <p>{state.service?.name} · {state.service?.endpoint}</p>}<DialogFooter><Button type="button" variant="ghost" onClick={() => setConfirmation(null)}>Cancel</Button><Button type="button" disabled={state.disabled || confirmation?.kind === "credential" && !!affected.length} onClick={() => void confirm()}>Confirm</Button></DialogFooter></DialogContent></Dialog>
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
  if (!props.scope.instanceId) return <SettingsPage title="MCP" description="Manage HTTP services shared by this ruukoto instance."><SettingsNotice>ruukoto is offline. Restore the connection to manage MCP.</SettingsNotice></SettingsPage>;
  return <CodeMcpForm {...props} />;
}
