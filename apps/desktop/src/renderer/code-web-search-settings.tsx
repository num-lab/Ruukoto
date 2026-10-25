import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { CodeState } from "./code-state.ts";
import { CodeWebSearchState } from "./code-web-search-state.ts";
import { SettingsSection, SwitchRow } from "./settings-ui.tsx";
import { Button } from "./components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";
import { Field, FieldDescription, FieldLabel } from "./components/ui/field.tsx";
import { Input } from "./components/ui/input.tsx";

// 与 code-web-search-state 的固定绑定名一致：该名称的凭据由本页管理。
const WEB_SEARCH_CREDENTIAL_NAME = "web-search";

function WebSearchForm({ code }: { code: CodeState }) {
  const [, bump] = useState(0);
  const [state] = useState(() => new CodeWebSearchState({ request: (...args) => window.ruukoto.request(...args) }, () => bump(value => value + 1), code.view.instanceId!, () => ({ instanceId: code.view.instanceId, online: code.status.state === "online" })));
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [replacing, setReplacing] = useState(false);
  useEffect(() => { void state.read(); return () => { state.invalidate(); }; }, [state]);
  const effective = state.effective;
  const secretField = !effective || replacing;
  const webSearch = code.view.webSearch;
  return <div className="model-settings web-search-settings" aria-label="Web 搜索设置" aria-busy={state.reading || state.writing}>
    <SettingsSection title="Tavily 凭据" action={<Button type="button" variant="ghost" size="icon-sm" aria-label="重新读取凭据" title="重新读取凭据" disabled={state.reading || state.writing} onClick={() => void state.read()}><RefreshCw /></Button>}>
      {state.reading && <span role="status">正在读取…</span>}
      {state.phase === "ready" && effective && <>
        <p>{effective.name} · {effective.host}{effective.name === WEB_SEARCH_CREDENTIAL_NAME ? " · 生效中" : ""}</p>
        {effective.name === WEB_SEARCH_CREDENTIAL_NAME
          ? <div className="model-settings-actions">{!replacing && <Button type="button" variant="outline" size="sm" disabled={state.disabled} onClick={() => { setReplacing(true); state.editSecret(""); }}>更换密钥</Button>}<Button type="button" variant="ghost" size="sm" disabled={state.disabled} onClick={() => setConfirmRemove(true)}>移除</Button></div>
          : <FieldDescription>由 CLI 创建，请用 ruukoto credentials 命令管理。</FieldDescription>}
        {state.credentials.length > 1 && <FieldDescription>共 {state.credentials.length} 条绑定，取名称排序第一个生效。</FieldDescription>}
      </>}
      {state.phase === "ready" && !effective && <FieldDescription>未配置 Tavily 凭据。</FieldDescription>}
      {secretField && <Field data-invalid={!!state.fieldErrors.secret}><FieldLabel htmlFor="web-search-secret">Tavily API Key</FieldLabel><Input id="web-search-secret" type="password" autoComplete="off" value={state.secret} disabled={state.disabled} aria-invalid={!!state.fieldErrors.secret} onChange={event => state.editSecret(event.target.value)} />{state.fieldErrors.secret && <FieldDescription role="alert">{state.fieldErrors.secret}</FieldDescription>}</Field>}
      {secretField && <div className="model-settings-actions">{replacing && <Button type="button" variant="ghost" size="sm" disabled={state.disabled} onClick={() => setReplacing(false)}>取消更换</Button>}<Button type="button" size="sm" disabled={state.disabled} onClick={() => void state.saveSecret().then(saved => { if (saved) setReplacing(false); })}>保存密钥</Button></div>}
    </SettingsSection>
    <SettingsSection title="实例开关">
      <SwitchRow id="web-search-toggle" label="所有项目共用" checked={webSearch.state === "enabled"} disabled={state.disabled} onCheckedChange={checked => void state.setWebSearch(checked, webSearch.version)} />
      <FieldDescription>停用立即阻止后续调用，启用从下一任务生效。</FieldDescription>
    </SettingsSection>
    {state.message && <p className="model-settings-notice" role="status">{state.message}</p>}
    <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}><DialogContent className="demo-dialog"><DialogHeader><DialogTitle>移除 Tavily 凭据？</DialogTitle><DialogDescription>移除后 web_search 调用会直接返回未配置错误。</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="ghost" onClick={() => setConfirmRemove(false)}>取消</Button><Button type="button" disabled={state.disabled} onClick={() => { setConfirmRemove(false); void state.removeCredential(); }}>移除</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}

export function CodeWebSearchSettings({ code }: { code: CodeState }) {
  const instanceId = code.view.instanceId;
  if (!instanceId) return <FieldDescription role="status">Code 已离线，请恢复连接后管理 Web 搜索。</FieldDescription>;
  return <WebSearchForm key={instanceId} code={code} />;
}
