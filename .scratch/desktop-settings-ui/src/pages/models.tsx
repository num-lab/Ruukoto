import { useState } from "react";
import { ChevronRight, Plus, Trash2 } from "lucide-react";
import { SettingsButton, SettingsSelect, SettingsSwitch } from "../components/controls.tsx";
import { SettingsCard, SettingsGroup, SettingsList, SettingsListItem, SettingsPage, SettingsRow, SettingsSubpage } from "../components/settings.tsx";
import { apiOptions, Notice, RefreshButton, Tag, TextSetting } from "./shared.tsx";

type Provider = { id: string; name: string; baseUrl: string; models: number; credential: string };

const initialProviders: Provider[] = [
  { id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com", models: 3, credential: "存储条目 · API Key" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", models: 4, credential: "SDK 来源或有效性未验证" },
  { id: "local", name: "Local Provider", baseUrl: "http://localhost:11434/v1", models: 2, credential: "未配置" },
];

const modelOptions = [
  { value: "claude-sonnet", label: "Claude Sonnet · anthropic" },
  { value: "gpt", label: "GPT · openai" },
  { value: "local-model", label: "Local Model · local" },
];

function CatalogModel({ id, name }: { id: string; name: string }) {
  const [expanded, setExpanded] = useState(false);
  const [images, setImages] = useState(true);
  const [reasoning, setReasoning] = useState(true);
  const [customApi, setCustomApi] = useState(false);
  return (
    <SettingsCard className="settings-catalog-model">
      <SettingsRow title={name} description={`模型 ID：${id} · 连接测试未执行`}>
        <SettingsButton variant="ghost" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>{expanded ? "收起" : "编辑"}<ChevronRight className={expanded ? "is-expanded" : ""} /></SettingsButton>
      </SettingsRow>
      {expanded && <div className="settings-catalog-fields">
        <TextSetting id={`${id}-name`} title="模型名称" defaultValue={name} />
        <TextSetting id={`${id}-id`} title="模型 ID" defaultValue={id} />
        <TextSetting id={`${id}-context`} title="上下文容量" type="number" defaultValue={200000} />
        <TextSetting id={`${id}-output`} title="输出上限" type="number" defaultValue={8192} />
        <SettingsRow title="图片输入" htmlFor={`${id}-image`}><SettingsSwitch id={`${id}-image`} checked={images} onChange={event => setImages(event.target.checked)} /></SettingsRow>
        <SettingsRow title="推理能力" htmlFor={`${id}-reasoning`}><SettingsSwitch id={`${id}-reasoning`} checked={reasoning} onChange={event => setReasoning(event.target.checked)} /></SettingsRow>
        <SettingsRow title="单独指定接口" description="默认继承提供方配置。" footer={customApi && <div className="settings-inline-panel"><TextSetting id={`${id}-api`} title="API 类型" description="覆盖提供方接口类型。" /><TextSetting id={`${id}-base-url`} title="API 地址" defaultValue="https://api.example.com" /></div>}>
          <SettingsButton variant="ghost" onClick={() => setCustomApi(value => !value)} aria-expanded={customApi}>{customApi ? "收起" : "配置"}</SettingsButton>
        </SettingsRow>
        <SettingsRow title="模型操作" description="测试已保存配置会联网且可能产生费用。"><SettingsButton>测试连接</SettingsButton><SettingsButton variant="icon" aria-label={`删除模型 ${name}`} title="删除模型"><Trash2 /></SettingsButton></SettingsRow>
      </div>}
    </SettingsCard>
  );
}

function ProviderDetails({ provider }: { provider: Provider }) {
  const [sources, setSources] = useState(false);
  const [catalogSecrets, setCatalogSecrets] = useState(false);
  const [models, setModels] = useState([{ id: "sonnet", name: "Claude Sonnet" }, { id: "haiku", name: "Claude Haiku" }]);
  return (
    <div className="settings-provider-settings">
      <SettingsRow title="连接设置" description="配置显示名称与接口。" />
      <TextSetting id={`${provider.id}-name`} title="显示名称" defaultValue={provider.name} />
      <SettingsRow title="API 类型" htmlFor={`${provider.id}-api`}><SettingsSelect id={`${provider.id}-api`} defaultValue={provider.id === "anthropic" ? "anthropic-messages" : "openai-completions"} options={apiOptions} /></SettingsRow>
      <TextSetting id={`${provider.id}-url`} title="API 地址" defaultValue={provider.baseUrl} />
      <TextSetting id={`${provider.id}-key`} title="存储 API Key" description={provider.credential} type="password" placeholder="未配置，输入新值保存" />
      <SettingsRow title="认证来源" description="存储条目、目录、运行时覆盖与 SDK 来源分别显示。" footer={sources && <Notice>{provider.credential} · 目录与运行时来源未验证。</Notice>}>
        <SettingsButton variant="ghost" onClick={() => setSources(value => !value)} aria-expanded={sources}>{sources ? "收起" : "查看全部配置位置"}</SettingsButton>
      </SettingsRow>
      <SettingsRow title="目录模型" description="配置模型能力、容量和接口覆盖。" footer={<div className="settings-model-list">{models.map(model => <CatalogModel key={model.id} {...model} />)}</div>}>
        <SettingsButton variant="icon" aria-label={`添加模型到 ${provider.name}`} title="添加模型" onClick={() => setModels([...models, { id: `model-${models.length + 1}`, name: "新模型" }])}><Plus /></SettingsButton>
      </SettingsRow>
      <SettingsRow title="目录密钥与请求头" description="按提供方、模型或模型覆盖选择配置位置。" footer={catalogSecrets && <div className="settings-inline-panel">
        <SettingsRow title="配置位置" htmlFor={`${provider.id}-secret-scope`}><SettingsSelect id={`${provider.id}-secret-scope`} options={[{ value: "provider", label: "提供方" }, { value: "model", label: "模型 sonnet" }, { value: "override", label: "模型覆盖 sonnet" }]} /></SettingsRow>
        <TextSetting id={`${provider.id}-catalog-key`} title="目录 apiKey" type="password" placeholder="未配置" />
        <TextSetting id={`${provider.id}-header`} title="新增请求头名称" placeholder="Authorization" />
        <TextSetting id={`${provider.id}-header-value`} title="新请求头值" type="password" />
        <SettingsRow title="请求头" description="仅添加演示字段，不保存实际秘密。"><SettingsButton variant="icon" aria-label="添加请求头" title="添加请求头"><Plus /></SettingsButton></SettingsRow>
      </div>}>
        <SettingsButton variant="ghost" onClick={() => setCatalogSecrets(value => !value)} aria-expanded={catalogSecrets}>{catalogSecrets ? "收起" : "配置"}</SettingsButton>
      </SettingsRow>
      <SettingsRow title="提供方操作" description="保存、删除与连接测试只演示交互。"><SettingsButton variant="ghost">删除提供方</SettingsButton><SettingsButton>保存</SettingsButton></SettingsRow>
    </div>
  );
}

function AddProviderPage({ onBack, onAdd }: { onBack: () => void; onAdd: (provider: Provider) => void }) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  return (
    <SettingsSubpage title="添加提供方" description="配置连接、认证与模型。" onBack={onBack}>
      <SettingsGroup title="连接设置">
        <SettingsCard>
          <SettingsRow title="显示名称" htmlFor="new-provider-name"><input className="settings-plain-input" id="new-provider-name" value={name} onChange={event => setName(event.target.value)} placeholder="提供方名称" /></SettingsRow>
          <SettingsRow title="API 类型" htmlFor="new-provider-api"><SettingsSelect id="new-provider-api" options={apiOptions} /></SettingsRow>
          <SettingsRow title="API 地址" htmlFor="new-provider-url"><input className="settings-plain-input" id="new-provider-url" type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://api.example.com" /></SettingsRow>
          <TextSetting id="new-provider-key" title="存储 API Key" type="password" description="秘密仅用于展示输入状态，不会保存。" />
        </SettingsCard>
      </SettingsGroup>
      <div className="settings-subpage-actions"><SettingsButton variant="ghost" onClick={onBack}>取消</SettingsButton><SettingsButton disabled={!name.trim() || !baseUrl.trim()} onClick={() => onAdd({ id: `custom-${Date.now()}`, name: name.trim(), baseUrl: baseUrl.trim(), models: 0, credential: "未配置" })}>添加提供方</SettingsButton></div>
    </SettingsSubpage>
  );
}

export function CodeModelsPage() {
  const [providers, setProviders] = useState(initialProviders);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  if (adding) return <AddProviderPage onBack={() => setAdding(false)} onAdd={provider => { setProviders([...providers, provider]); setAdding(false); }} />;
  return (
    <SettingsPage title="模型" description="管理 Code 默认模型、提供方与模型目录。">
      <SettingsGroup title="默认设置" action={<RefreshButton label="重新读取配置" />}>
        <SettingsCard>
          <SettingsRow title="后台默认模型" description="影响后续新会话，运行时显式启动参数仍覆盖此处默认。" htmlFor="default-model"><SettingsSelect id="default-model" options={modelOptions} /></SettingsRow>
          <SettingsRow title="Effort" description="使用所选模型支持的推理档位。" htmlFor="model-effort"><SettingsSelect id="model-effort" defaultValue="medium" options={["off", "minimal", "low", "medium", "high", "xhigh"].map(value => ({ value, label: value }))} /></SettingsRow>
          <SettingsRow title="摘要模型" description="未单独指定时跟随任务模型。" htmlFor="summary-model"><SettingsSelect id="summary-model" options={[{ value: "task", label: "跟随任务模型" }, ...modelOptions]} /></SettingsRow>
        </SettingsCard>
      </SettingsGroup>
      <SettingsGroup title="提供方" description="配置连接、认证与目录模型。" action={<SettingsButton onClick={() => setAdding(true)}><Plus />添加提供方</SettingsButton>}>
        <SettingsList label="模型提供方" empty="还没有提供方，请先添加。">
          {providers.map(provider => <SettingsListItem key={provider.id} title={provider.name} description={`${provider.baseUrl} · ${provider.models} 个模型`} detailsId={`${provider.id}-settings`} details={selected === provider.id ? <ProviderDetails provider={provider} /> : undefined}>
            <SettingsButton variant="icon" className="settings-disclosure" aria-label={`${selected === provider.id ? "收起" : "配置"} ${provider.name}`} aria-expanded={selected === provider.id} aria-controls={`${provider.id}-settings`} onClick={() => setSelected(selected === provider.id ? null : provider.id)}><ChevronRight /></SettingsButton>
          </SettingsListItem>)}
        </SettingsList>
      </SettingsGroup>
    </SettingsPage>
  );
}

export function PersonalModelsPage() {
  const [imageInput, setImageInput] = useState(true);
  const [tested, setTested] = useState(false);
  return (
    <SettingsPage title="模型" description="管理 Personal Agent 的当前模型与凭据引用。">
      <SettingsGroup title="当前模型" action={<RefreshButton label="重新读取远端配置" />}>
        <SettingsCard>
          <SettingsRow title="API 类型" htmlFor="pa-api"><SettingsSelect id="pa-api" options={apiOptions.slice(0, 3)} /></SettingsRow>
          <TextSetting id="pa-base-url" title="服务地址" defaultValue="https://api.example.com/v1" />
          <TextSetting id="pa-model-id" title="模型标识" defaultValue="example-model" />
          <TextSetting id="pa-context" title="上下文上限" type="number" defaultValue={200000} />
          <TextSetting id="pa-output" title="输出上限" type="number" defaultValue={8192} />
          <TextSetting id="pa-key-env" title="凭据环境变量引用" description="只存引用名，凭据由原后台环境提供。" defaultValue="EXAMPLE_API_KEY" />
          <SettingsRow title="图片输入" htmlFor="pa-image"><SettingsSwitch id="pa-image" checked={imageInput} onChange={event => setImageInput(event.target.checked)} /></SettingsRow>
          <SettingsRow title="凭据状态" description="原后台环境状态。"><Tag>原服务环境未核实</Tag></SettingsRow>
          <SettingsRow title="连接测试" description="联网测试，可能产生费用。" footer={tested && <Notice>演示状态：未发起真实模型请求。</Notice>}><SettingsButton onClick={() => setTested(true)}>测试当前模型</SettingsButton></SettingsRow>
        </SettingsCard>
      </SettingsGroup>
    </SettingsPage>
  );
}
