import { useEffect, useState } from "react";
import { Save, SquarePen, Trash2, X } from "lucide-react";
import type { CodeState } from "./code-state.ts";
import { CodeWebSearchState } from "./code-web-search-state.ts";
import { SettingsButton, SettingsNotice, SettingsSwitch } from "./components/controls.tsx";
import { SettingsCard, SettingsGroup, SettingsPage, SettingsRow } from "./components/settings.tsx";
import { Button } from "./components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";

// Only the fixed binding owned by this page can be replaced or removed.
const WEB_SEARCH_CREDENTIAL_NAME = "web-search";

function WebSearchForm({ code }: { code: CodeState }) {
  const [, bump] = useState(0);
  const [state] = useState(() => new CodeWebSearchState({ request: (...args) => window.ruukoto.request(...args) }, () => bump(value => value + 1), code.view.instanceId!, () => ({ instanceId: code.view.instanceId, online: code.status.state === "online" })));
  useEffect(() => { void state.read(); return () => { state.invalidate(); }; }, [state]);
  return <CodeWebSearchEditor state={state} code={code} />;
}

export function CodeWebSearchEditor({ state, code }: { state: CodeWebSearchState; code: CodeState }) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const effective = state.effective;
  const secretField = state.phase === "ready" && (!effective || replacing);
  const editable = state.phase === "ready" && (!effective || effective.name === WEB_SEARCH_CREDENTIAL_NAME);
  const save = () => void state.saveSecret().then(saved => { if (saved) setReplacing(false); });
  const webSearch = code.view.webSearch;
  return (
    <SettingsPage title="Web search" description="Manage the Tavily credential and per-instance switch for Code.">
      <SettingsGroup title="Tavily credential">
        <SettingsCard className="web-search-credential-card">
          <SettingsRow title={secretField
            ? <input className="settings-plain-input web-search-key-input" id="web-search-secret" type="password" aria-label="Tavily API Key" autoComplete="new-password" value={state.secret} disabled={state.disabled} aria-invalid={!!state.fieldErrors.secret} onChange={event => state.editSecret(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); save(); } }} placeholder="Enter a new Tavily API key" />
            : <code className="web-search-credential">{state.reading ? "Loading…" : state.phase !== "ready" ? "Unverified" : effective ? "Configured · ••••••••••••" : "Not configured"}</code>}
            error={state.fieldErrors.secret} description={effective && effective.name !== WEB_SEARCH_CREDENTIAL_NAME ? "Created by the CLI; manage it with the ruukoto credentials command." : undefined}>
            <SettingsButton variant="icon" aria-label={secretField ? "Save key" : "Change key"} title={secretField ? "Save key" : "Change key"} disabled={state.disabled || !editable || secretField && !state.secret} onClick={() => { if (secretField) save(); else { setReplacing(true); state.editSecret(""); } }}>{secretField ? <Save /> : <SquarePen />}</SettingsButton>
            {replacing && <SettingsButton variant="icon" aria-label="Cancel replacement" title="Cancel replacement" disabled={state.disabled} onClick={() => { setReplacing(false); state.editSecret(""); }}><X /></SettingsButton>}
            <SettingsButton className="settings-danger-icon" variant="icon" aria-label="Remove key" title="Remove key" disabled={state.disabled || !editable || !effective} onClick={() => setConfirmRemove(true)}><Trash2 /></SettingsButton>
          </SettingsRow>
          {state.credentials.length > 1 && <SettingsRow title="Credential bindings" description={`${state.credentials.length} bindings; the first by name order applies.`} />}
        </SettingsCard>
      </SettingsGroup>
      <SettingsGroup title="Instance switch">
        <SettingsCard>
          <SettingsRow title="Shared across all projects" description="Disabling blocks later calls immediately; enabling applies from the next task." htmlFor="web-search-toggle"><SettingsSwitch id="web-search-toggle" checked={webSearch.state === "enabled"} disabled={state.disabled} onChange={event => void state.setWebSearch(event.target.checked, webSearch.version)} /></SettingsRow>
        </SettingsCard>
      </SettingsGroup>
      {state.message && <SettingsNotice>{state.message}</SettingsNotice>}
      {state.phase === "error" && <SettingsButton variant="ghost" disabled={state.disabled} onClick={() => void state.read()}>Retry reading the credential</SettingsButton>}
      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}><DialogContent className="app-dialog"><DialogHeader><DialogTitle>Remove the Tavily credential?</DialogTitle><DialogDescription>After removal, web_search calls return a not-configured error.</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="ghost" onClick={() => setConfirmRemove(false)}>Cancel</Button><Button type="button" disabled={state.disabled} onClick={() => { setConfirmRemove(false); void state.removeCredential(); }}>Remove</Button></DialogFooter></DialogContent></Dialog>
    </SettingsPage>
  );
}

export function CodeWebSearchSettings({ code }: { code: CodeState }) {
  const instanceId = code.view.instanceId;
  if (!instanceId) return <SettingsPage title="Web search" description="Manage the Tavily credential and per-instance switch for Code."><SettingsNotice>Code is offline. Restore the connection to manage Web search.</SettingsNotice></SettingsPage>;
  return <WebSearchForm key={instanceId} code={code} />;
}
