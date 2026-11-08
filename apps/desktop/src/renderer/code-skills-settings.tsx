import { useEffect, useState } from "react";
import { Puzzle } from "lucide-react";
import type { SettingsPageProps } from "./settings-dialog.tsx";
import { CodeSkillsState } from "./code-skills-state.ts";
import { SettingsButton, SettingsNotice, SettingsSearch } from "./components/controls.tsx";
import { SettingsGroup, SettingsList, SettingsListItem, SettingsPage, SettingsRow } from "./components/settings.tsx";

export function CodeSkillsEditor({ state }: { state: CodeSkillsState }) {
  return (
    <SettingsPage title="Skills" description="Read skills from the Code backend account's $HOME/.agents/skills/.">
      <SettingsGroup title="All skills" action={<SettingsSearch className="settings-group-search" value={state.query} onChange={event => { state.query = event.target.value; state.changed(); }} placeholder="Filter by name" aria-label="Filter skills" />}>
        {!state.connected && <SettingsNotice>Code is offline or the instance changed. Restore the original instance before reading; the original operation won't be redirected to a new instance.</SettingsNotice>}
        {state.phase === "loading" && <SettingsNotice>Loading skills…</SettingsNotice>}
        <SettingsList label="Skills list" empty={state.query ? "No matching names in the fetched list." : "No skills to show."}>
          {state.filtered.map(skill => <SettingsListItem key={skill.id} title={<span className="settings-title-with-icon"><Puzzle aria-hidden="true" />{skill.name}</span>} description={`${skill.description}${skill.explicitOnly ? " · explicit invocation only" : ""}`} />)}
        </SettingsList>
        {state.hasMore && <SettingsRow title="More skills"><SettingsButton variant="ghost" disabled={state.disabled} onClick={() => void state.read(true)}>Load more skills</SettingsButton></SettingsRow>}
      </SettingsGroup>
      {!!state.diagnostics.length && <SettingsGroup title="Skill diagnostics"><div className="settings-notice"><ul>{state.diagnostics.map((diagnostic, index) => <li key={index}>{diagnostic}</li>)}</ul>{state.diagnosticsTruncated && <p>Diagnostics truncated.</p>}</div></SettingsGroup>}
      {state.message && <SettingsNotice>{state.message}</SettingsNotice>}
    </SettingsPage>
  );
}

function CodeSkillsForm({ settings, scope, code }: SettingsPageProps) {
  const [state] = useState(() => new CodeSkillsState({ request: (...args) => window.ruukoto.request(...args) }, settings.changed, scope.instanceId!, () => ({ instanceId: code.view.instanceId, online: code.status.state === "online" })));
  useEffect(() => { settings.form = state; void state.read(); return () => { state.invalidate(); if (settings.form === state) settings.form = null; }; }, [settings, state]);
  return <CodeSkillsEditor state={state} />;
}

export function CodeSkillsSettings(props: SettingsPageProps) {
  if (!props.scope.instanceId) return <SettingsPage title="Skills" description="Read skills from the Code backend account's $HOME/.agents/skills/."><SettingsNotice>Code is offline. Restore the connection before reading skills.</SettingsNotice></SettingsPage>;
  return <CodeSkillsForm {...props} />;
}
