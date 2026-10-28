import { useEffect, useState } from "react";
import { Puzzle } from "lucide-react";
import type { SettingsPageProps } from "./settings-dialog.tsx";
import { CodeSkillsState } from "./code-skills-state.ts";
import { SettingsButton, SettingsNotice, SettingsSearch, SettingsTag } from "./components/controls.tsx";
import { SettingsGroup, SettingsList, SettingsListItem, SettingsPage, SettingsRow } from "./components/settings.tsx";

export function CodeSkillsEditor({ state }: { state: CodeSkillsState }) {
  return (
    <SettingsPage title="Skills" description="管理 Code 的外部技能与托管副本。">
      <SettingsGroup title="全部技能">
        <SettingsSearch value={state.query} onChange={event => { state.query = event.target.value; state.changed(); }} placeholder="按名称检索" aria-label="检索技能" />
        {!state.connected && <SettingsNotice>Code 已离线或实例已变化，请恢复原实例后读取；原操作不会改发到新实例。</SettingsNotice>}
        {state.phase === "loading" && <SettingsNotice>正在读取技能…</SettingsNotice>}
        <SettingsList label="技能列表" empty={state.query ? "已取得的列表中没有匹配名称。" : "没有可展示的技能。"}>
          {state.filtered.map(skill => <SettingsListItem key={skill.id} title={<span className="settings-title-with-icon"><Puzzle aria-hidden="true" />{skill.name}</span>} description={`${skill.description} · ${skill.source === "managed" ? "托管副本" : "外部维护"}${skill.explicitOnly ? " · 仅显式调用" : ""}`}>
            {skill.state === "disabled" && <SettingsTag>已停用</SettingsTag>}
          </SettingsListItem>)}
        </SettingsList>
        {state.hasMore && <SettingsRow title="更多技能"><SettingsButton variant="ghost" disabled={state.disabled} onClick={() => void state.read(true)}>加载更多技能</SettingsButton></SettingsRow>}
      </SettingsGroup>
      {!!state.diagnostics.length && <SettingsGroup title="技能诊断"><div className="settings-notice"><ul>{state.diagnostics.map((diagnostic, index) => <li key={index}>{diagnostic}</li>)}</ul>{state.diagnosticsTruncated && <p>诊断已截断。</p>}</div></SettingsGroup>}
      {state.message && <SettingsNotice>{state.message}</SettingsNotice>}
    </SettingsPage>
  );
}

function CodeSkillsForm({ settings, scope, code }: SettingsPageProps) {
  const [state] = useState(() => new CodeSkillsState({ request: (...args) => window.ruukoto.request(...args), pickSkillFolder: (...args) => window.ruukoto.pickSkillFolder(...args) }, settings.changed, scope.instanceId!, () => ({ instanceId: code.view.instanceId, online: code.status.state === "online" })));
  useEffect(() => { settings.form = state; void state.read(); return () => { state.invalidate(); if (settings.form === state) settings.form = null; }; }, [settings, state]);
  return <CodeSkillsEditor state={state} />;
}

export function CodeSkillsSettings(props: SettingsPageProps) {
  if (props.settings.form instanceof CodeSkillsState && props.settings.form.pending) return <CodeSkillsForm {...props} />;
  if (!props.scope.instanceId) return <SettingsPage title="Skills" description="管理 Code 的外部技能与托管副本。"><SettingsNotice>Code 已离线，请恢复连接后管理技能。</SettingsNotice></SettingsPage>;
  return <CodeSkillsForm {...props} />;
}
