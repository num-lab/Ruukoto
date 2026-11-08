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
    <SettingsPage title="Web 搜索" description="管理 Code 的 Tavily 凭据与实例开关。">
      <SettingsGroup title="Tavily 凭据">
        <SettingsCard className="web-search-credential-card">
          <SettingsRow title={secretField
            ? <input className="settings-plain-input web-search-key-input" id="web-search-secret" type="password" aria-label="Tavily API Key" autoComplete="new-password" value={state.secret} disabled={state.disabled} aria-invalid={!!state.fieldErrors.secret} onChange={event => state.editSecret(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); save(); } }} placeholder="输入新的 Tavily API Key" />
            : <code className="web-search-credential">{state.reading ? "正在读取…" : state.phase !== "ready" ? "尚未核实" : effective ? "已配置 · ••••••••••••" : "未配置"}</code>}
            error={state.fieldErrors.secret} description={effective && effective.name !== WEB_SEARCH_CREDENTIAL_NAME ? "由 CLI 创建，请用 ruukoto credentials 命令管理。" : undefined}>
            <SettingsButton variant="icon" aria-label={secretField ? "保存密钥" : "修改密钥"} title={secretField ? "保存密钥" : "修改密钥"} disabled={state.disabled || !editable || secretField && !state.secret} onClick={() => { if (secretField) save(); else { setReplacing(true); state.editSecret(""); } }}>{secretField ? <Save /> : <SquarePen />}</SettingsButton>
            {replacing && <SettingsButton variant="icon" aria-label="取消更换" title="取消更换" disabled={state.disabled} onClick={() => { setReplacing(false); state.editSecret(""); }}><X /></SettingsButton>}
            <SettingsButton className="settings-danger-icon" variant="icon" aria-label="移除密钥" title="移除密钥" disabled={state.disabled || !editable || !effective} onClick={() => setConfirmRemove(true)}><Trash2 /></SettingsButton>
          </SettingsRow>
          {state.credentials.length > 1 && <SettingsRow title="凭据绑定" description={`共 ${state.credentials.length} 条绑定，取名称排序第一个生效。`} />}
        </SettingsCard>
      </SettingsGroup>
      <SettingsGroup title="实例开关">
        <SettingsCard>
          <SettingsRow title="所有项目共用" description="停用立即阻止后续调用，启用从下一任务生效。" htmlFor="web-search-toggle"><SettingsSwitch id="web-search-toggle" checked={webSearch.state === "enabled"} disabled={state.disabled} onChange={event => void state.setWebSearch(event.target.checked, webSearch.version)} /></SettingsRow>
        </SettingsCard>
      </SettingsGroup>
      {state.message && <SettingsNotice>{state.message}</SettingsNotice>}
      {state.phase === "error" && <SettingsButton variant="ghost" disabled={state.disabled} onClick={() => void state.read()}>重试读取凭据</SettingsButton>}
      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}><DialogContent className="app-dialog"><DialogHeader><DialogTitle>移除 Tavily 凭据？</DialogTitle><DialogDescription>移除后 web_search 调用会直接返回未配置错误。</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="ghost" onClick={() => setConfirmRemove(false)}>取消</Button><Button type="button" disabled={state.disabled} onClick={() => { setConfirmRemove(false); void state.removeCredential(); }}>移除</Button></DialogFooter></DialogContent></Dialog>
    </SettingsPage>
  );
}

export function CodeWebSearchSettings({ code }: { code: CodeState }) {
  const instanceId = code.view.instanceId;
  if (!instanceId) return <SettingsPage title="Web 搜索" description="管理 Code 的 Tavily 凭据与实例开关。"><SettingsNotice>Code 已离线，请恢复连接后管理 Web 搜索。</SettingsNotice></SettingsPage>;
  return <WebSearchForm key={instanceId} code={code} />;
}
