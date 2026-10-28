import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { CodeState } from "./code-state.ts";
import { CodeWebSearchState } from "./code-web-search-state.ts";
import { SettingsButton, SettingsInput, SettingsNotice, SettingsSwitch, SettingsTag } from "./components/controls.tsx";
import { SettingsCard, SettingsGroup, SettingsPage, SettingsRow } from "./components/settings.tsx";
import { Button } from "./components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";

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
  return (
    <SettingsPage title="Web 搜索" description="管理 Code 的 Tavily 凭据与实例开关。">
      <SettingsGroup title="Tavily 凭据" action={<SettingsButton variant="icon" aria-label="重新读取凭据" title="重新读取凭据" disabled={state.reading || state.writing} onClick={() => void state.read()}><RefreshCw /></SettingsButton>}>
        <SettingsCard>
          {state.reading && <SettingsRow title="" description="正在读取…" />}
          {state.phase === "ready" && effective && <SettingsRow title="当前凭据" description={`${effective.name} · ${effective.host}`}>
            <SettingsTag>{effective.name === WEB_SEARCH_CREDENTIAL_NAME ? "生效中" : "未配置"}</SettingsTag>
          </SettingsRow>}
          {state.phase === "ready" && effective && effective.name === WEB_SEARCH_CREDENTIAL_NAME && <SettingsRow title="凭据操作" description="更换或移除只改变演示状态。">
            {!replacing && <SettingsButton disabled={state.disabled} onClick={() => { setReplacing(true); state.editSecret(""); }}>更换密钥</SettingsButton>}
            <SettingsButton variant="ghost" disabled={state.disabled} onClick={() => setConfirmRemove(true)}>移除</SettingsButton>
          </SettingsRow>}
          {state.phase === "ready" && effective && effective.name !== WEB_SEARCH_CREDENTIAL_NAME && <SettingsRow title="" description="由 CLI 创建，请用 ruukoto credentials 命令管理。" />}
          {state.credentials.length > 1 && <SettingsRow title="" description={`共 ${state.credentials.length} 条绑定，取名称排序第一个生效。`} />}
          {state.phase === "ready" && !effective && <SettingsRow title="" description="未配置 Tavily 凭据。" />}
          {secretField && <SettingsRow title="Tavily API Key" description="只显示新秘密输入，不回显已有值。" htmlFor="web-search-secret"><SettingsInput id="web-search-secret" type="password" autoComplete="off" value={state.secret} disabled={state.disabled} aria-invalid={!!state.fieldErrors.secret} onChange={event => state.editSecret(event.target.value)} /></SettingsRow>}
          {state.fieldErrors.secret && <SettingsRow title="" description={state.fieldErrors.secret} />}
          {secretField && <SettingsRow title="密钥操作" description="保存后生效。">
            {replacing && <SettingsButton variant="ghost" disabled={state.disabled} onClick={() => setReplacing(false)}>取消更换</SettingsButton>}
            <SettingsButton disabled={state.disabled} onClick={() => void state.saveSecret().then(saved => { if (saved) setReplacing(false); })}>保存密钥</SettingsButton>
          </SettingsRow>}
        </SettingsCard>
      </SettingsGroup>
      <SettingsGroup title="实例开关">
        <SettingsCard>
          <SettingsRow title="所有项目共用" description="停用立即阻止后续调用，启用从下一任务生效。" htmlFor="web-search-toggle"><SettingsSwitch id="web-search-toggle" checked={webSearch.state === "enabled"} disabled={state.disabled} onChange={event => void state.setWebSearch(event.target.checked, webSearch.version)} /></SettingsRow>
        </SettingsCard>
      </SettingsGroup>
      {state.message && <SettingsNotice>{state.message}</SettingsNotice>}
      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}><DialogContent className="demo-dialog"><DialogHeader><DialogTitle>移除 Tavily 凭据？</DialogTitle><DialogDescription>移除后 web_search 调用会直接返回未配置错误。</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="ghost" onClick={() => setConfirmRemove(false)}>取消</Button><Button type="button" disabled={state.disabled} onClick={() => { setConfirmRemove(false); void state.removeCredential(); }}>移除</Button></DialogFooter></DialogContent></Dialog>
    </SettingsPage>
  );
}

export function CodeWebSearchSettings({ code }: { code: CodeState }) {
  const instanceId = code.view.instanceId;
  if (!instanceId) return <SettingsPage title="Web 搜索" description="管理 Code 的 Tavily 凭据与实例开关。"><SettingsNotice>Code 已离线，请恢复连接后管理 Web 搜索。</SettingsNotice></SettingsPage>;
  return <WebSearchForm key={instanceId} code={code} />;
}
