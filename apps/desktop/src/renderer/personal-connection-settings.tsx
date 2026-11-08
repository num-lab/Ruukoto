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
  connected: { title: "Connected", icon: Check },
  unpaired: { title: "Awaiting pairing", icon: Link2 },
  error: { title: "Connection lost", icon: AlertTriangle },
  loading: { title: "Verifying connection", icon: Loader2 },
  connecting: { title: "Connecting", icon: Loader2 },
};

export function ConnectionDiagram({ connection }: { connection: keyof typeof connectionMeta }) {
  const { title, icon: Icon } = connectionMeta[connection];
  const connector = () => <div className="connection-line"><span className="connection-line-state"><Icon aria-hidden="true" /></span></div>;
  return <section className="connection-overview" data-state={connection}>
    <div className="connection-diagram" role="img" aria-label={`This Mac connects to the remote Personal Agent over Tailscale; current state: ${title}`}>
      <div className="connection-node" title="This Mac"><Laptop aria-hidden="true" /></div>
      {connector()}
      <div className="tailscale-node" title="Tailscale"><svg className="tailscale-mark" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="5" r="2.1" opacity=".35" /><circle cx="12" cy="5" r="2.1" opacity=".35" /><circle cx="19" cy="5" r="2.1" opacity=".35" /><circle cx="5" cy="12" r="2.1" /><circle cx="12" cy="12" r="2.1" /><circle cx="19" cy="12" r="2.1" /><circle cx="5" cy="19" r="2.1" opacity=".35" /><circle cx="12" cy="19" r="2.1" /><circle cx="19" cy="19" r="2.1" opacity=".35" /></svg></div>
      {connector()}
      <div className="connection-node" title="Remote Personal Agent service"><Server aria-hidden="true" /></div>
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
    <SettingsPage title="Personal connection" description="View this desktop's connection to the Personal Agent." overview={<ConnectionDiagram connection={state.connectionStatus(personal)} />}>
      <SettingsGroup title="Personal Agent">
        <SettingsCard>
          <SettingsRow title="Server address" description="Saving the address doesn't complete pairing." htmlFor="personal-origin" error={state.fieldErrors.origin}><SettingsInput id="personal-origin" value={state.draft.origin} onChange={event => state.edit("origin", event.target.value)} placeholder="https://your-server.your-tailnet.ts.net" autoCapitalize="none" autoComplete="off" spellCheck={false} disabled={state.disabled} aria-invalid={!!state.fieldErrors.origin} /></SettingsRow>
          {state.dirty && <SettingsRow title="Address edit"><SettingsButton variant="primary" disabled={state.disabled} onClick={() => void state.save()}>Save address</SettingsButton><SettingsButton variant="ghost" disabled={state.disabled} onClick={() => state.discard()}>Cancel</SettingsButton></SettingsRow>}
        </SettingsCard>
      </SettingsGroup>
      <SettingsGroup title="Server pairing">
        <SettingsCard>
          <SettingsRow title="This desktop's name" htmlFor="personal-pair-label"><SettingsInput id="personal-pair-label" value={state.label} onChange={event => { state.label = event.target.value; state.changed(); }} disabled={pairingDisabled} maxLength={80} autoComplete="off" /></SettingsRow>
          <SettingsRow title="Server pairing code" description="The pairing code is used only for this authorization." htmlFor="personal-pair-code"><SettingsInput id="personal-pair-code" type="password" placeholder="Enter the short-lived pairing code" value={state.code} onChange={event => { state.code = event.target.value; state.changed(); }} disabled={pairingDisabled} maxLength={12} autoComplete="off" autoCapitalize="characters" /></SettingsRow>
          <SettingsRow title="Pairing state" description={paired ? "This desktop is paired with the server." : "The configuration still needs server confirmation."}><SettingsTag>{paired ? "Paired" : "Not paired"}</SettingsTag><SettingsButton disabled={pairingDisabled || !state.code.trim() || !state.label.trim()} onClick={() => void state.pair()}>Pair and connect</SettingsButton></SettingsRow>
        </SettingsCard>
      </SettingsGroup>
      <SettingsGroup title="Maintenance">
        <SettingsCard>
          <SettingsRow title="Verify original pairing" description="Verify a server pairing operation with an unknown outcome."><SettingsButton variant="ghost" disabled={maintenanceDisabled} onClick={() => void state.pair("reconcile")}>Verify original pairing</SettingsButton></SettingsRow>
          <SettingsRow title="Restore original pairing" description="Restore a pairing the original server already confirmed."><SettingsButton variant="ghost" disabled={maintenanceDisabled} onClick={() => void state.pair("restore")}>Restore original pairing</SettingsButton></SettingsRow>
        </SettingsCard>
      </SettingsGroup>
      {paired && <PersonalPermissionSettings state={state} />}
      {state.legacy.length > 0 && <SettingsGroup title="Legacy maintenance unverified" description="Verify on the original server first, then confirm; the original record stays in place.">
        <SettingsCard><SettingsRow title="Unverified files" description={state.legacy.join(", ")}><SettingsButton disabled={state.disabled} onClick={() => void state.acknowledgeLegacy()}>Verified on the original server</SettingsButton></SettingsRow></SettingsCard>
      </SettingsGroup>}
      {(state.reading || state.message) && <SettingsNotice>{state.reading ? "Verifying this desktop's connection…" : state.message}</SettingsNotice>}
      {(state.phase === "unknown" || state.phase === "error" || state.phase === "conflict") && <SettingsButton variant="ghost" disabled={state.reading} onClick={() => void state.read()}>Verify original connection</SettingsButton>}
    </SettingsPage>
  );
}

export function PersonalPermissionSettings({ state }: { state: PersonalConnectionState }) {
  const modes = [{ value: "confirm", label: "Authorized scope" }, { value: "auto-review", label: "Auto review" }, { value: "full_access", label: "Full access" }];
  return <>
    <SettingsGroup title="Default permissions" description="Only affects newly accepted input and new plans; existing work keeps its permissions.">
      <SettingsCard>
        {([["default", "Desktop, local and Telegram"], ["qq", "QQ (independent default)"]] as const).map(([scope, title]) => <SettingsRow key={scope} title={title} htmlFor={`pa-permission-${scope}`}><SettingsSelect id={`pa-permission-${scope}`} value={state.permissions?.[scope].mode ?? ""} disabled={state.permissionsDisabled} options={state.permissions ? modes : [{ value: "", label: "Unverified" }]} onValueChange={nextValue => void state.selectPermission(scope, nextValue as PersonalPermissionMode)} /></SettingsRow>)}
        <SettingsRow title="Permission scope" description="Authorized-scope operations run directly; out-of-scope operations request approval. Auto review can independently review credential-free reads outside the scope; other out-of-scope operations still request approval." />
      </SettingsCard>
      {(state.permissionsReading || state.permissionsMessage) && <SettingsNotice>{state.permissionsReading ? "Verifying default permissions…" : state.permissionsMessage}</SettingsNotice>}
      {!state.permissions && state.permissionsMessage && <SettingsButton variant="ghost" disabled={state.reading || state.permissionsReading || state.phase === "saving" || state.dirty} onClick={() => void state.readPermissions()}>Verify default permissions</SettingsButton>}
    </SettingsGroup>
    <Dialog open={!!state.permissionConfirmation} onOpenChange={open => { if (!open) state.cancelPermission(); }}><DialogContent className="app-dialog"><DialogHeader><DialogTitle>Enable full access?</DialogTitle><DialogDescription>Later input will use the backend account's directories, network and same-account credentials without per-operation approval; unknown effects still pause.</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="ghost" onClick={() => state.cancelPermission()}>Cancel</Button><Button type="button" disabled={state.permissionsDisabled} onClick={() => void state.confirmPermission()}>Enable full access</Button></DialogFooter></DialogContent></Dialog>
  </>;
}
