import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import type { SettingsPageProps } from "./settings-dialog.tsx";
import { CodeMcpState } from "./code-mcp-state.ts";
import { SettingsButton, SettingsInput, SettingsNotice, SettingsSelect, SettingsTag } from "./components/controls.tsx";
import { SettingsCard, SettingsGroup, SettingsList, SettingsListItem, SettingsPage, SettingsRow, SettingsSubpage } from "./components/settings.tsx";
import { Tools } from "./code-mcp-settings.tsx";
import { Button } from "./components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";

type Confirmation = { kind: "enable" | "disable" | "remove" };

function CuaRecovery({ state }: { state: CodeMcpState }) {
  const status = state.cuaStatus, observation = status?.observation;
  return <SettingsGroup title="Local computer">
    <SettingsCard>
      {status && <SettingsRow title="Run state" description={status.original ? `${status.original.toolName} · outcome unconfirmed` : "No computer operations awaiting recovery."}><SettingsTag>{({ idle: "Disconnected", connecting: "Connecting", active: "In use", frozen: "Awaiting recovery", recovering: "Recovering" })[status.state]}</SettingsTag></SettingsRow>}
      {status && <SettingsRow title="Stop computer operations" description="Unsaved app state may be lost; disk files are kept.">
        {(status.state === "frozen" && !status.stopped || status.state === "active" && !!state.service?.cua) && <SettingsButton disabled={state.disabled || state.dirty} onClick={() => { if (status.state === "active") void state.pauseCua(); else void state.cuaAction("stop"); }}>Stop computer operations</SettingsButton>}
        {status.stopped && !observation && <SettingsButton disabled={state.disabled || state.dirty} onClick={() => void state.cuaAction("observe")}>Check and recover</SettingsButton>}
      </SettingsRow>}
      {observation && <SettingsRow title="Recover state" description="Confirm recovery after reviewing the new screenshots.">
        <SettingsButton variant="ghost" disabled={state.disabled || state.dirty} onClick={() => void state.cuaAction("observe")}>New screenshot</SettingsButton>
        <SettingsButton disabled={state.disabled || state.dirty || !state.canAcceptCua} onClick={() => void state.cuaAction("accept")}>Confirm recovery</SettingsButton>
      </SettingsRow>}
      {state.cuaImages.map((image, index) => <div className="file-image" key={`${observation!.id}:${image.id}`}><img src={image.source} alt={`Recovery screenshot ${index + 1}`} onLoad={() => state.imageLoaded(observation!.id, image.id, true)} onError={() => state.imageLoaded(observation!.id, image.id, false)} /></div>)}
    </SettingsCard>
    {state.cuaError && <SettingsNotice>{state.cuaError}</SettingsNotice>}
    {state.cuaError && <SettingsButton variant="ghost" disabled={state.reading || state.checking || !state.connected || state.phase === "saving"} onClick={() => void state.refreshCua()}>Verify computer state</SettingsButton>}
  </SettingsGroup>;
}

function ComputerDetails({ state, confirmation, setConfirmation }: { state: CodeMcpState; confirmation: Confirmation | null; setConfirmation: (value: Confirmation | null) => void }) {
  const selectedProgram = state.cuaTargets.findIndex(target => JSON.stringify(target.config) === JSON.stringify(state.draft.cua));
  const comparison = state.service ?? state.conflictingService;
  return (
    <div className="settings-provider-settings">
      <SettingsRow title={state.service ? "Edit computer" : "Add computer"} description="Configure the local Cua Driver and tool permissions."><SettingsButton variant="ghost" disabled={state.phase === "saving" || state.phase === "unknown"} onClick={() => state.closeEditor()}>Close editor</SettingsButton></SettingsRow>
      <SettingsRow title="Service name" htmlFor="computer-name" error={state.fieldErrors.name}><SettingsInput id="computer-name" value={state.draft.name} disabled={state.disabled || !!state.service} aria-invalid={!!state.fieldErrors.name} onChange={event => state.edit("name", event.target.value)} /></SettingsRow>
      <SettingsRow title="Installed Cua Driver" description="Select a local program." htmlFor="computer-cua-program" error={state.fieldErrors.cua ?? (state.cuaIssues.length ? state.cuaIssues.map(issue => issue.message).join("; ") : !state.cuaTargets.length ? "No Cua Driver found. Install one first." : undefined)}>
        <SettingsSelect id="computer-cua-program" value={selectedProgram < 0 ? "" : String(selectedProgram)} disabled={state.disabled} onValueChange={nextValue => state.selectCua(Number(nextValue))} options={state.cuaTargets.map((target, index) => ({ value: String(index), label: target.label }))} />
      </SettingsRow>
      {state.service?.cua && <SettingsRow title="Program path" description={state.service.cua.executable} />}
      <Tools state={state} />
      <SettingsRow title="Check permissions and tools" description="Accessibility and screen recording are verified separately." footer={state.check && <SettingsNotice>{state.check.ok ? `Found ${state.check.tools.length} tools` : state.check.error ?? `Check failed (${state.check.errorCode ?? "connection error"}); verify the current entry and check again.`}</SettingsNotice>}>
        <SettingsButton disabled={state.disabled || state.dirty || !state.service} onClick={() => void state.discover()}>Check permissions and tools</SettingsButton>
      </SettingsRow>
      {state.check?.permissions && <SettingsRow title="Permissions" description={`Accessibility: ${state.check.permissions.accessibility ? "granted" : "not granted"} · Screen recording: ${state.check.permissions.screenRecording ? "granted" : "not granted"}`} />}
      {state.phase === "conflict" && comparison && <SettingsRow title="Current backend value" description="Your draft is above; compare and decide." footer={<pre className="settings-code-block">{JSON.stringify({ enabled: comparison.enabled, tools: comparison.toolAllowlist }, null, 2)}</pre>}>
        {!state.selectedId && <SettingsButton variant="ghost" disabled={state.disabled} onClick={() => state.useCurrentService()}>Continue editing as the same-named service</SettingsButton>}
      </SettingsRow>}
      <SettingsRow title="Computer actions">
        {state.service && <><SettingsButton variant="ghost" disabled={state.disabled || state.dirty} onClick={() => setConfirmation({ kind: "remove" })}>Delete service</SettingsButton><SettingsButton variant="ghost" disabled={state.disabled || state.dirty} onClick={() => { if (state.service!.enabled) void state.pauseCua(); else setConfirmation({ kind: "enable" }); }}>{state.service.enabled ? "Pause computer" : "Keep using computer"}</SettingsButton></>}
        <SettingsButton variant="ghost" disabled={state.disabled || !state.dirty} onClick={() => state.discard()}>Discard changes</SettingsButton>
        <SettingsButton variant="primary" disabled={state.disabled || !state.dirty} onClick={() => void state.save()}>Save</SettingsButton>
      </SettingsRow>
    </div>
  );
}

export function CodeComputerEditor({ state }: { state: CodeMcpState }) {
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const adding = state.editing && !state.selectedId;
  useEffect(() => { if (Object.keys(state.fieldErrors).length) document.querySelector<HTMLElement>('.settings-page [aria-invalid="true"]')?.focus(); }, [state.fieldErrors]);
  const confirm = async () => {
    const action = confirmation; setConfirmation(null);
    if (action?.kind === "enable" || action?.kind === "disable") await state.setEnabled(action.kind === "enable");
    else if (action?.kind === "remove") await state.remove();
  };
  const recovery = (state.phase === "unknown" || state.phase === "error" || state.phase === "conflict") && <SettingsButton variant="ghost" disabled={state.reading || !state.connected} onClick={() => void state.read()}>Verify original configuration</SettingsButton>;
  if (adding) return <SettingsSubpage title="Add computer" description="Configure the computer service and tool permissions." onBack={() => state.closeEditor()}>
    <SettingsGroup title="Computer">
      <SettingsCard><ComputerDetails state={state} confirmation={confirmation} setConfirmation={setConfirmation} /></SettingsCard>
    </SettingsGroup>
    {state.message && <SettingsNotice>{state.message}</SettingsNotice>}
    {recovery}
  </SettingsSubpage>;
  return (
    <SettingsPage title="Computer" description="Manage the local Cua Driver and computer recovery.">
      <SettingsGroup title="Services" action={<SettingsButton variant="primary" onClick={() => state.select(null)} disabled={state.disabled || state.dirty}><Plus />Add computer</SettingsButton>}>
        {!state.connected && <SettingsNotice>Code is offline. Restore the connection.</SettingsNotice>}
        {state.reading && <SettingsNotice>Loading configuration…</SettingsNotice>}
        <SettingsList label="Computer services" empty="No local computer configured yet.">
          {state.services.filter(service => service.cua).map(service => <SettingsListItem key={service.id} title={service.name} description={`Local Cua Driver · ${service.toolAllowlist.length} allowed tools`} expanded={state.editing && state.selectedId === service.id} toggleLabel={`${state.editing && state.selectedId === service.id ? "Collapse" : "Edit"} ${service.name}`} onToggle={() => state.editing && state.selectedId === service.id ? state.closeEditor() : state.select(service.id)} details={state.editing && state.selectedId === service.id ? <ComputerDetails state={state} confirmation={confirmation} setConfirmation={setConfirmation} /> : undefined}>
            <SettingsTag>{service.enabled ? "Enabled" : "Paused"}</SettingsTag>
          </SettingsListItem>)}
        </SettingsList>
      </SettingsGroup>
      <CuaRecovery state={state} />
      {state.message && <SettingsNotice>{state.message}</SettingsNotice>}
      {recovery}
      <Dialog open={!!confirmation} onOpenChange={open => { if (!open) setConfirmation(null); }}><DialogContent className="app-dialog"><DialogHeader><DialogTitle>{confirmation?.kind === "enable" ? "Enable service?" : confirmation?.kind === "disable" ? "Disable service?" : "Delete service?"}</DialogTitle><DialogDescription>This configuration is shared by all workspaces of this instance.</DialogDescription></DialogHeader><p>{state.service?.name}</p><DialogFooter><Button type="button" variant="ghost" onClick={() => setConfirmation(null)}>Cancel</Button><Button type="button" disabled={state.disabled} onClick={() => void confirm()}>Confirm</Button></DialogFooter></DialogContent></Dialog>
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
  if (!props.scope.instanceId) return <SettingsPage title="Computer" description="Manage the local Cua Driver and computer recovery."><SettingsNotice>Code is offline. Restore the connection to manage computers.</SettingsNotice></SettingsPage>;
  return <CodeComputerForm {...props} />;
}
