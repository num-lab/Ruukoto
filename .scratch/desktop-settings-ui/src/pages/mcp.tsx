import { useState } from "react";
import { ChevronRight, Plus } from "lucide-react";
import { SettingsButton, SettingsSelect, SettingsSwitch } from "../components/controls.tsx";
import { SettingsCard, SettingsGroup, SettingsList, SettingsListItem, SettingsPage, SettingsRow, SettingsSubpage } from "../components/settings.tsx";
import { Notice, RefreshButton, Tag, TextSetting } from "./shared.tsx";

type Variant = "code" | "personal";
type Service = { id: string; name: string; endpoint: string; enabled: boolean; credential: string; tools: number };
const initialServices: Service[] = [
  { id: "docs", name: "Documentation", endpoint: "https://mcp.example.com/docs", enabled: true, credential: "已配置凭据", tools: 2 },
  { id: "search", name: "Search", endpoint: "https://mcp.example.com/search", enabled: false, credential: "匿名", tools: 1 },
];

function ToolPermissions({ cua = false }: { cua?: boolean }) {
  const [read, setRead] = useState(true);
  const [write, setWrite] = useState(false);
  if (cua) return <>
    <SettingsRow title="computer_screenshot" description="读取屏幕内容。" htmlFor="tool-screenshot"><SettingsSwitch id="tool-screenshot" checked={read} onChange={event => setRead(event.target.checked)} /></SettingsRow>
    <SettingsRow title="computer_action" description="副作用不明，逐次统一审批。" htmlFor="tool-action"><SettingsSwitch id="tool-action" checked={write} onChange={event => setWrite(event.target.checked)} /></SettingsRow>
  </>;
  return <>
    <SettingsRow title="read_resource" description="只读资源。" htmlFor="tool-read"><SettingsSelect id="tool-read" defaultValue="read" options={[{ value: "blocked", label: "不允许" }, { value: "read", label: "只读" }, { value: "write", label: "写入" }, { value: "unknown", label: "副作用不明" }]} /></SettingsRow>
    <SettingsRow title="update_resource" description="写入资源，需逐次审批。" htmlFor="tool-write"><SettingsSelect id="tool-write" defaultValue="blocked" options={[{ value: "blocked", label: "不允许" }, { value: "read", label: "只读" }, { value: "write", label: "写入" }, { value: "unknown", label: "副作用不明" }]} /></SettingsRow>
  </>;
}

function ServiceDetails({ service, variant, onChange, onRemove }: { service: Service; variant: Variant; onChange: (service: Service) => void; onRemove: () => void }) {
  const [endpoint, setEndpoint] = useState(service.endpoint);
  const [checked, setChecked] = useState(false);
  return (
    <div className="settings-provider-settings">
      <TextSetting id={`${service.id}-name`} title="服务名称" defaultValue={service.name} />
      <SettingsRow title="HTTPS 端点" htmlFor={`${service.id}-endpoint`}><input className="settings-plain-input" id={`${service.id}-endpoint`} value={endpoint} onChange={event => setEndpoint(event.target.value)} /></SettingsRow>
      {variant === "code" ? <>
        <SettingsRow title="认证" htmlFor={`${service.id}-auth`}><SettingsSelect id={`${service.id}-auth`} defaultValue={service.credential === "匿名" ? "anonymous" : "keep"} options={[{ value: "keep", label: "保留当前凭据" }, { value: "anonymous", label: "匿名" }, { value: "existing", label: "选择已有凭据" }, { value: "new", label: "保存新的 Bearer 令牌" }]} /></SettingsRow>
        <TextSetting id={`${service.id}-credential`} title="已有凭据" description={service.credential} defaultValue="mcp-docs" />
      </> : <>
        <SettingsRow title="认证方式" htmlFor={`${service.id}-auth`}><SettingsSelect id={`${service.id}-auth`} defaultValue={service.credential === "匿名" ? "anonymous" : "credential"} options={[{ value: "anonymous", label: "显式匿名" }, { value: "credential", label: "远端私有凭据文件" }]} /></SettingsRow>
        <TextSetting id={`${service.id}-credential-path`} title="远端私有凭据文件" description="引用无效不降级匿名，保存时可重新绑定。" defaultValue="/var/lib/ruukoto/credentials/mcp.json" />
      </>}
      <ToolPermissions />
      <SettingsRow title="连接与工具发现" description="检查不执行业务工具，远端只读标注不自动成为本地授权。" footer={checked && <Notice>演示状态：发现 2 个工具，未发起真实连接。</Notice>}><SettingsButton onClick={() => setChecked(true)}>检查连接</SettingsButton></SettingsRow>
      <SettingsRow title="服务操作" description="本实例的全部工作区共用此配置。"><SettingsButton variant="ghost" onClick={onRemove}>删除服务</SettingsButton><SettingsButton onClick={() => onChange({ ...service, enabled: !service.enabled })}>{service.enabled ? "停用" : "启用"}</SettingsButton><SettingsButton>保存</SettingsButton></SettingsRow>
    </div>
  );
}

function AddServicePage({ variant, onBack, onAdd }: { variant: Variant; onBack: () => void; onAdd: (service: Service) => void }) {
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [auth, setAuth] = useState(variant === "code" ? "anonymous" : "credential");
  return (
    <SettingsSubpage title="添加服务" description="配置 MCP HTTP 服务与允许的工具。" onBack={onBack}>
      <SettingsGroup title="服务">
        <SettingsCard>
          <SettingsRow title="服务名称" htmlFor="new-mcp-name"><input className="settings-plain-input" id="new-mcp-name" value={name} onChange={event => setName(event.target.value)} placeholder="服务名称" /></SettingsRow>
          <SettingsRow title="HTTPS 端点" htmlFor="new-mcp-endpoint"><input className="settings-plain-input" id="new-mcp-endpoint" type="url" value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="https://mcp.example.com" /></SettingsRow>
          <SettingsRow title="认证方式" htmlFor="new-mcp-auth"><SettingsSelect id="new-mcp-auth" value={auth} onChange={event => setAuth(event.target.value)} options={variant === "code" ? [{ value: "anonymous", label: "匿名" }, { value: "new", label: "保存新的 Bearer 令牌" }] : [{ value: "anonymous", label: "显式匿名" }, { value: "credential", label: "远端私有凭据文件" }]} /></SettingsRow>
          {variant === "code"
            ? auth === "new" && <TextSetting id="new-mcp-secret" title="Bearer 令牌" description="令牌只写入所属后端。" type="password" placeholder="Bearer 令牌" />
            : auth === "credential" && <TextSetting id="new-mcp-credential-path" title="远端私有凭据文件" description="引用无效不降级匿名，保存时可重新绑定。" defaultValue="/var/lib/ruukoto/credentials/mcp.json" />}
          <ToolPermissions />
        </SettingsCard>
      </SettingsGroup>
      <div className="settings-subpage-actions"><SettingsButton variant="ghost" onClick={onBack}>取消</SettingsButton><SettingsButton disabled={!name.trim() || !endpoint.trim()} onClick={() => onAdd({ id: `service-${Date.now()}`, name: name.trim(), endpoint: endpoint.trim(), enabled: true, credential: auth === "anonymous" ? "匿名" : "已配置凭据", tools: 2 })}>保存</SettingsButton></div>
    </SettingsSubpage>
  );
}

function McpServices({ variant, description }: { variant: Variant; description: string }) {
  const [services, setServices] = useState(initialServices);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  if (adding) return <AddServicePage variant={variant} onBack={() => setAdding(false)} onAdd={service => { setServices([...services, service]); setAdding(false); }} />;
  return (
    <SettingsPage title="MCP" description={description}>
      <SettingsGroup title="服务" action={<SettingsButton onClick={() => setAdding(true)}><Plus />添加服务</SettingsButton>}>
        <SettingsList label="MCP 服务" empty="尚未配置 HTTP 服务。">
          {services.map(service => <SettingsListItem key={service.id} title={service.name} description={`${service.endpoint} · ${service.credential} · ${service.tools} 个允许工具`} details={selected === service.id ? <ServiceDetails service={service} variant={variant} onChange={updated => setServices(services.map(item => item.id === service.id ? updated : item))} onRemove={() => setServices(services.filter(item => item.id !== service.id))} /> : undefined}>
            <Tag>{service.enabled ? "已启用" : "已停用"}</Tag>
            <SettingsButton variant="ghost" onClick={() => setSelected(selected === service.id ? null : service.id)} aria-expanded={selected === service.id} aria-label={`${selected === service.id ? "收起" : "编辑"} ${service.name}`}><ChevronRight /></SettingsButton>
          </SettingsListItem>)}
        </SettingsList>
      </SettingsGroup>
      {variant === "code" ? <SettingsGroup title="MCP 凭据" description="凭据只写入所属后端，列表不显示秘密。">
        <SettingsCard><SettingsRow title="mcp.example.com · 凭据 1" description="Documentation 正在引用，请先更换或清除引用。"><SettingsButton variant="ghost">查看并清理凭据</SettingsButton></SettingsRow></SettingsCard>
      </SettingsGroup> : <SettingsGroup title="调用" action={<RefreshButton label="刷新 MCP 调用" />}>
        <SettingsCard><SettingsRow title="Documentation · read_resource" description="结果未知，原调用记录保持可查。"><SettingsButton>查看原调用</SettingsButton></SettingsRow><SettingsRow title="调用管理" description="可结束此工作并保留结果未知，不自动重发。"><SettingsButton variant="ghost">结束此工作，保留结果未知</SettingsButton></SettingsRow></SettingsCard>
      </SettingsGroup>}
    </SettingsPage>
  );
}

export function CodeMcpPage() {
  return <McpServices variant="code" description="管理当前 Code 实例共用的 HTTP 服务。" />;
}

export function PersonalMcpPage() {
  return <McpServices variant="personal" description="管理 Personal Agent 的远端 MCP 服务与凭据引用。" />;
}
