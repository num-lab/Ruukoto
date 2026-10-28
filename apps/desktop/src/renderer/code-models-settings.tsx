import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { SettingsPageProps } from "./settings-dialog.tsx";
import type { SettingsScope } from "./settings-state.ts";
import { CodeModelsState, type CatalogSecretLocation } from "./code-models-state.ts";
import { SettingsButton, SettingsInput, SettingsNotice, SettingsSelect, SettingsSwitch, SettingsTag } from "./components/controls.tsx";
import { SettingsCard, SettingsGroup, SettingsList, SettingsListItem, SettingsPage, SettingsRow, SettingsSubpage } from "./components/settings.tsx";
import { Button } from "./components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";

function TextSetting({ id, title, description, type = "text", defaultValue = "", placeholder, disabled, invalid, onChange }: {
  id: string;
  title: string;
  description?: string;
  type?: "text" | "number" | "password" | "url";
  defaultValue?: string | number;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  onChange?: (value: string) => void;
}) {
  return <SettingsRow title={title} description={description} htmlFor={id}><SettingsInput id={id} type={type} defaultValue={defaultValue} placeholder={placeholder} disabled={disabled} aria-invalid={invalid} onChange={event => onChange?.(event.target.value)} autoComplete={type === "password" ? "new-password" : "off"} spellCheck={false} /></SettingsRow>;
}

const apiTypes = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai", "mistral-conversations", "azure-openai-responses", "openai-codex-responses", "bedrock-converse-stream", "google-vertex", "pi-messages"];
const apiOptions = apiTypes.map(value => ({ value, label: value }));

function credentialLocationLabel(location: { source: string; type?: string; scope?: string; modelId?: string; field?: string; header?: string }): string {
  if (location.source === "storage") return `存储条目 · ${location.type === "oauth" ? "OAuth" : location.type === "api_key" ? "API Key" : "类型未验证"}`;
  if (location.source === "catalog") return `目录 ${location.scope === "provider" ? "提供方" : `${location.scope === "modelOverrides" ? "模型覆盖" : "模型"} ${location.modelId}`} · ${location.field === "headers" ? `请求头 ${location.header}` : "apiKey"}`;
  return location.source === "runtime" ? "运行时覆盖（有效性未验证）" : "SDK 来源或有效性未验证";
}

function Notices({ state, scope, online }: { state: CodeModelsState; scope: SettingsScope; online: boolean }) {
  return <>
    {state.instanceId !== scope.instanceId && <SettingsNotice>连接实例已变化。请恢复原实例核实，或放弃草稿后重新打开此页。</SettingsNotice>}
    {!online && <SettingsNotice>Code 已离线，恢复原连接后可继续保存。</SettingsNotice>}
    {state.phase === "unknown" && <div className="settings-notice"><p>{state.message || "原操作结果待核实，不会自动重发。"}</p><SettingsButton disabled={state.reading || !online} onClick={() => void state.read()}>核实原操作结果</SettingsButton></div>}
    {state.phase === "conflict" && <div className="settings-notice"><p>当前配置已更新，草稿保留。请比较后保存或放弃。</p></div>}
    {state.message && state.phase !== "unknown" && <SettingsNotice>{state.message}</SettingsNotice>}
  </>;
}

function CatalogSecrets({ state }: { state: CodeModelsState }) {
  const [scope, setScope] = useState("provider"), [header, setHeader] = useState("");
  const [open, setOpen] = useState(false);
  const targets: { id: string; label: string; location: Pick<CatalogSecretLocation, "scope" | "modelId">; value: Record<string, unknown> }[] = [
    { id: "provider", label: "提供方", location: { scope: "provider" }, value: state.provider },
    ...state.models.map((model, index) => ({ id: `model:${index}`, label: `模型 ${model.id}`, location: { scope: "model" as const, modelId: String(model.id) }, value: model })),
    ...Object.entries((state.provider.modelOverrides ?? {}) as Record<string, Record<string, unknown>>).map(([id, value]) => ({ id: `override:${id}`, label: `模型覆盖 ${id}`, location: { scope: "modelOverrides" as const, modelId: id }, value })),
  ];
  const target = targets.find(item => item.id === scope) ?? targets[0];
  const headers = (target.value.headers ?? {}) as Record<string, unknown>;
  return <SettingsRow title="目录密钥与请求头" description="按提供方、模型或模型覆盖选择配置位置。" footer={open && <div className="settings-inline-panel">
    <SettingsRow title="配置位置" htmlFor="catalog-secret-scope"><SettingsSelect id="catalog-secret-scope" value={target.id} disabled={state.disabled || !!state.headerDraft} onChange={event => setScope(event.target.value)} options={targets.map(item => ({ value: item.id, label: item.label }))} /></SettingsRow>
    <SettingsRow title="目录 apiKey" htmlFor="catalog-api-key"><div className="settings-row-control"><SettingsInput id="catalog-api-key" type="password" autoComplete="new-password" disabled={state.disabled} placeholder={target.value.apiKey === true ? "已配置，输入新值替换" : "未配置"} value={typeof target.value.apiKey === "string" ? target.value.apiKey : ""} onChange={event => state.editSecret({ ...target.location, field: "apiKey" }, event.target.value)} /><SettingsButton variant="icon" aria-label="清除所选目录 apiKey" title="清除所选目录 apiKey" disabled={state.disabled || target.value.apiKey === undefined} onClick={() => state.editSecret({ ...target.location, field: "apiKey" }, null)}><Trash2 /></SettingsButton></div></SettingsRow>
    {Object.entries(headers).map(([name, value], index) => <SettingsRow key={`${target.id}:${name}`} title={`请求头 ${name}`} htmlFor={`catalog-header-${index}`}><div className="settings-row-control"><SettingsInput id={`catalog-header-${index}`} type="password" autoComplete="new-password" placeholder="已配置，输入新值替换" disabled={state.disabled} value={typeof value === "string" ? value : ""} onChange={event => state.editSecret({ ...target.location, field: "headers", header: name }, event.target.value)} /><SettingsButton variant="icon" aria-label={`清除请求头 ${name}`} title={`清除请求头 ${name}`} disabled={state.disabled} onClick={() => state.editSecret({ ...target.location, field: "headers", header: name }, null)}><Trash2 /></SettingsButton></div></SettingsRow>)}
    <SettingsRow title="新增请求头名称" htmlFor="catalog-new-header"><SettingsInput id="catalog-new-header" value={header} disabled={state.disabled} onChange={event => { setHeader(event.target.value); if (state.headerDraft) state.editNewHeader({ ...target.location, field: "headers" }, event.target.value, state.headerDraft.value); }} aria-invalid={!!state.fieldErrors.headers} /></SettingsRow>
    <SettingsRow title="新请求头值" htmlFor="catalog-new-header-value"><SettingsInput id="catalog-new-header-value" type="password" value={state.headerDraft?.value ?? ""} disabled={state.disabled} autoComplete="new-password" onChange={event => state.editNewHeader({ ...target.location, field: "headers" }, header, event.target.value)} /></SettingsRow>
    <SettingsRow title="请求头" description="仅添加演示字段，不保存实际秘密。"><SettingsButton variant="icon" aria-label="添加请求头" title="添加请求头" disabled={state.disabled || !header.trim() || !state.headerDraft?.value} onClick={() => { if (state.addHeader()) setHeader(""); }}><Plus /></SettingsButton></SettingsRow>
  </div>}>
    <SettingsButton variant="ghost" onClick={() => setOpen(value => !value)} aria-expanded={open}>{open ? "收起" : "配置"}</SettingsButton>
  </SettingsRow>;
}

function CatalogModel({ state, index, remove, test }: { state: CodeModelsState; index: number; remove: () => void; test: () => void }) {
  const model = state.models[index], prefix = "catalog-model-" + index;
  const [expanded, setExpanded] = useState(false);
  const [customApi, setCustomApi] = useState(false);
  const result = state.connectionTest(String(model.id));
  const status = result ? result.ok ? "success" : "failure" : "untested";
  const statusLabel = result ? result.ok ? "连接测试成功" : "连接测试失败" : "未测试";
  const edit = (field: string, value: unknown) => { delete state.fieldErrors[prefix + "-" + field]; state.editProvider("models", state.models.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item)); };
  return (
    <SettingsCard className="settings-catalog-model">
      <SettingsRow title={String(model.name || model.id || "新模型")} description={`模型 ID：${model.id} · ${statusLabel}`}>
        <SettingsButton variant="ghost" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>{expanded ? "收起" : "编辑"}<ChevronRight className={expanded ? "is-expanded" : ""} /></SettingsButton>
      </SettingsRow>
      <div className="settings-catalog-fields" hidden={!expanded}>
        <TextSetting id={`${prefix}-name`} title="模型名称" defaultValue={String(model.name ?? "")} invalid={!!state.fieldErrors[`${prefix}-name`]} onChange={value => edit("name", value || undefined)} />
        <TextSetting id={`${prefix}-id`} title="模型 ID" defaultValue={String(model.id ?? "")} invalid={!!state.fieldErrors[`${prefix}-id`]} onChange={value => edit("id", value)} />
        <TextSetting id={`${prefix}-contextWindow`} title="上下文容量" type="number" defaultValue={Number(model.contextWindow ?? 0)} invalid={!!state.fieldErrors[`${prefix}-contextWindow`]} onChange={value => edit("contextWindow", value ? Number(value) : undefined)} />
        <TextSetting id={`${prefix}-maxTokens`} title="输出上限" type="number" defaultValue={Number(model.maxTokens ?? 0)} invalid={!!state.fieldErrors[`${prefix}-maxTokens`]} onChange={value => edit("maxTokens", value ? Number(value) : undefined)} />
        <SettingsRow title="图片输入" htmlFor={`${prefix}-image`}><SettingsSwitch id={`${prefix}-image`} checked={Array.isArray(model.input) && model.input.includes("image")} disabled={state.disabled} onChange={event => edit("input", event.target.checked ? Array.from(new Set([...(Array.isArray(model.input) ? model.input : ["text"]), "image"])) : (Array.isArray(model.input) ? model.input : ["text"]).filter(item => item !== "image"))} /></SettingsRow>
        <SettingsRow title="推理能力" htmlFor={`${prefix}-reasoning`}><SettingsSwitch id={`${prefix}-reasoning`} checked={model.reasoning === true} disabled={state.disabled} onChange={event => edit("reasoning", event.target.checked)} /></SettingsRow>
        <SettingsRow title="单独指定接口" description="默认继承提供方配置。" footer={customApi && <div className="settings-inline-panel"><SettingsRow title="API 类型" htmlFor={`${prefix}-api`}><SettingsSelect id={`${prefix}-api`} value={String(model.api ?? "inherit")} disabled={state.disabled} onChange={event => edit("api", event.target.value === "inherit" ? undefined : event.target.value)} options={[{ value: "inherit", label: "继承提供方" }, ...apiOptions]} /></SettingsRow><TextSetting id={`${prefix}-base-url`} title="API 地址" defaultValue={String(model.baseUrl ?? "")} onChange={value => edit("baseUrl", value || undefined)} /></div>}>
          <SettingsButton variant="ghost" onClick={() => setCustomApi(value => !value)} aria-expanded={customApi}>{customApi ? "收起" : "配置"}</SettingsButton>
        </SettingsRow>
        <SettingsRow title="模型操作" description="测试已保存配置会联网且可能产生费用。"><SettingsButton disabled={state.disabled || state.dirty || state.testing} onClick={test}>{state.testing && state.testingModelId === model.id ? "正在测试…" : "测试连接"}</SettingsButton><SettingsButton variant="icon" aria-label={`删除模型 ${String(model.name || model.id || index + 1)}`} title="删除模型" disabled={state.disabled} onClick={remove}><Trash2 /></SettingsButton></SettingsRow>
      </div>
    </SettingsCard>
  );
}

function DefaultSettings({ state, reload }: { state: CodeModelsState; reload: React.ReactNode }) {
  const view = state.view!;
  const models = view.models;
  const currentDefault = state.screen === "default" ? state.selection : view.defaultModel;
  const currentSummary = state.screen === "summary" ? state.selection : view.summaryModel;
  const defaultIndex = models.findIndex(model => model.provider === currentDefault?.provider && model.modelId === currentDefault.modelId);
  const summaryIndex = models.findIndex(model => model.provider === currentSummary?.provider && model.modelId === currentSummary.modelId);
  const effective = currentDefault ?? view.runtimeDefault;
  const effortModel = models.find(model => model.provider === effective.provider && model.modelId === effective.modelId);
  const runtimeName = models.find(model => model.provider === view.runtimeDefault.provider && model.modelId === view.runtimeDefault.modelId)?.name ?? view.runtimeDefault.modelId;
  const change = async (screen: "default" | "summary", selection: typeof state.selection) => {
    if (state.screen !== screen) state.chooseScreen(screen);
    if (state.screen !== screen || state.disabled) return;
    state.editSelection(selection);
    await state.save();
  };
  const modelOptions = models.map((model, index) => ({ value: String(index), label: `${model.name} · ${model.provider}${model.thinkingLevels === null ? "（档位未知）" : ""}` }));
  return <SettingsGroup title="默认设置" action={reload}>
    <SettingsCard>
      <SettingsRow title="后台默认模型" description="影响后续新会话，运行时显式启动参数仍覆盖此处默认。" htmlFor="settings-model-choice">
        <div className="settings-row-control">
          <SettingsSelect id="settings-model-choice" value={defaultIndex >= 0 ? String(defaultIndex) : ""} disabled={state.disabled} onChange={event => { const model = models[Number(event.target.value)]; if (model) void change("default", { provider: model.provider, modelId: model.modelId, thinkingLevel: model.thinkingLevels?.includes(effective.thinkingLevel) ? effective.thinkingLevel : model.thinkingLevels?.[0] ?? "off" }); }} options={modelOptions} />
          <SettingsSelect id="settings-model-effort" aria-label="Effort" value={effective.thinkingLevel} disabled={state.disabled || !effortModel?.thinkingLevels?.length} onChange={event => { const thinkingLevel = effortModel?.thinkingLevels?.find(level => level === event.target.value); if (thinkingLevel) void change("default", { ...effective, thinkingLevel }); }} options={(effortModel?.thinkingLevels ?? []).map(level => ({ value: level, label: level }))} />
        </div>
      </SettingsRow>
      <SettingsRow title="摘要模型" description="未单独指定时跟随任务模型。" htmlFor="settings-summary-model">
        <SettingsSelect id="settings-summary-model" value={currentSummary ? summaryIndex >= 0 ? String(summaryIndex) : "" : "task"} disabled={state.disabled} onChange={event => { const model = models[Number(event.target.value)]; if (event.target.value === "task") void change("summary", null); else if (model) void change("summary", { provider: model.provider, modelId: model.modelId, thinkingLevel: "off" }); }} options={[{ value: "task", label: "跟随任务模型" }, ...modelOptions]} />
      </SettingsRow>
      {state.fieldErrors.model && <SettingsRow title="" description={state.fieldErrors.model} />}
      {(view.runtimeOverrides.model || view.runtimeOverrides.thinking) && <SettingsRow title="" description="运行时显式启动参数仍覆盖此处默认。" />}
      {!models.length && <SettingsRow title="" description="尚无已配置模型，请先添加提供方和模型。" />}
    </SettingsCard>
  </SettingsGroup>;
}

export function ProviderSettings({ state, scope, online, save, confirm }: { state: CodeModelsState; scope: SettingsScope; online: boolean; save: () => void; confirm: (kind: "provider" | "credential" | "model", index?: number) => void }) {
  const provider = state.providerId!;
  const stored = state.view?.credentials[provider];
  const sources = state.view?.credentialSources[provider]?.locations ?? [];
  const [sourcesOpen, setSourcesOpen] = useState(false);
  return (
    <div className="settings-provider-settings">
      <Notices state={state} scope={scope} online={online} />
      {state.view?.busyProviders.includes(provider) && <SettingsNotice>此提供方正在应用配置，请稍后重新读取。</SettingsNotice>}
      <SettingsRow title="连接设置" description="配置显示名称与接口。" />
      <TextSetting id={`${provider}-name`} title="显示名称" defaultValue={String(state.provider.name ?? "")} onChange={value => state.editProvider("name", value || undefined)} />
      <SettingsRow title="API 类型" htmlFor="model-api"><SettingsSelect id="model-api" value={String(state.provider.api ?? "")} disabled={state.disabled} onChange={event => state.editProvider("api", event.target.value || undefined)} options={apiOptions} /></SettingsRow>
      <TextSetting id={`${provider}-url`} title="API 地址" defaultValue={String(state.provider.baseUrl ?? "")} onChange={value => state.editProvider("baseUrl", value || undefined)} />
      <TextSetting id={`${provider}-key`} title="存储 API Key" description={stored?.configured ? "存储条目 · API Key" : "未配置，输入新值保存"} type="password" placeholder="未配置，输入新值保存" onChange={value => state.editStoredSecret(value)} />
      <SettingsRow title="认证来源" description={stored?.type === "oauth" ? "填写新 Key 会替换 OAuth 存储条目；移除不会撤销远端令牌。" : "存储条目、目录、运行时覆盖与 SDK 来源分别显示。"} footer={sourcesOpen && <div className="settings-inline-panel"><ul>{sources.map((source, index) => <li key={index}>{credentialLocationLabel(source)}</li>)}</ul></div>}>
        <SettingsButton variant="ghost" onClick={() => setSourcesOpen(value => !value)} aria-expanded={sourcesOpen}>{sourcesOpen ? "收起" : "查看全部配置位置"}</SettingsButton>
      </SettingsRow>
      {stored?.configured && <SettingsRow title="存储凭据" description="移除不会撤销远端令牌。"><SettingsButton variant="ghost" disabled={state.disabled || state.dirty} onClick={() => confirm("credential")}>移除存储凭据</SettingsButton></SettingsRow>}
      <SettingsRow title="目录模型" description="配置模型能力、容量和接口覆盖。" footer={<div className="settings-model-list">{state.models.map((_, index) => <CatalogModel key={index} state={state} index={index} remove={() => confirm("model", index)} test={() => void state.testConnection(String(state.models[index].id))} />)}</div>}>
        <SettingsButton variant="icon" aria-label={`添加模型到 ${provider}`} title="添加模型" disabled={state.disabled} onClick={() => state.addModel("")}><Plus /></SettingsButton>
      </SettingsRow>
      <CatalogSecrets state={state} />
      <SettingsRow title="提供方操作" description="保存、删除与连接测试只演示交互。"><SettingsButton variant="ghost" disabled={state.disabled || state.dirty} onClick={() => confirm("provider")}>删除提供方</SettingsButton><SettingsButton disabled={state.disabled || !state.dirty} onClick={save}>保存</SettingsButton></SettingsRow>
    </div>
  );
}

function AddProviderPage({ state, onBack, onAdd }: { state: CodeModelsState; onBack: () => void; onAdd: () => void }) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  return (
    <SettingsSubpage title="添加提供方" description="配置连接、认证与模型。" onBack={onBack}>
      <SettingsGroup title="连接设置">
        <SettingsCard>
          <SettingsRow title="显示名称" htmlFor="new-provider-name"><SettingsInput id="new-provider-name" value={name} onChange={event => setName(event.target.value)} placeholder="提供方名称" /></SettingsRow>
          <SettingsRow title="API 类型" htmlFor="new-provider-api"><SettingsSelect id="new-provider-api" options={apiOptions} /></SettingsRow>
          <SettingsRow title="API 地址" htmlFor="new-provider-url"><SettingsInput id="new-provider-url" type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://api.example.com" /></SettingsRow>
          <TextSetting id="new-provider-key" title="存储 API Key" type="password" description="秘密仅用于展示输入状态，不会保存。" />
        </SettingsCard>
      </SettingsGroup>
      <div className="settings-subpage-actions"><SettingsButton variant="ghost" onClick={onBack}>取消</SettingsButton><SettingsButton disabled={!name.trim() || !baseUrl.trim()} onClick={() => { state.addProvider("custom-" + crypto.randomUUID()); state.editProvider("name", name.trim()); state.editProvider("baseUrl", baseUrl.trim()); onAdd(); }}>添加提供方</SettingsButton></div>
    </SettingsSubpage>
  );
}

// Note: 见 .agents/notes/implemented/feature/2026-10-21-code-model-settings.md
export function CodeModelsEditor({ state, scope, online }: { state: CodeModelsState; scope: SettingsScope; online: boolean }) {
  const provider = state.providerId;
  const stored = provider ? state.view?.credentials[provider] : null;
  const providerIds = Array.from(new Set([...Object.keys(state.draft), ...Object.keys(state.view?.credentialSources ?? {})]));
  const [adding, setAdding] = useState(false);
  const [confirmation, setConfirmation] = useState<{ kind: "provider" | "model" | "credential"; index?: number } | null>(null);
  useEffect(() => { if (Object.keys(state.fieldErrors).length) document.querySelector<HTMLElement>('.settings-page [aria-invalid="true"]')?.focus(); }, [state.fieldErrors]);
  const save = async () => { if (await state.save()) state.selectProvider(null); };
  const reload = <SettingsButton variant="icon" aria-label="重新读取配置" title="重新读取配置" disabled={state.reading || state.phase === "saving" || !online} onClick={() => void state.read()}><RefreshCw className={state.reading ? "animate-spin" : undefined} /></SettingsButton>;
  const confirmAction = async () => {
    const action = confirmation; setConfirmation(null);
    if (action?.kind === "provider") await state.removeProvider();
    else if (action?.kind === "credential") await state.removeStoredCredential();
    else if (action?.kind === "model") state.editProvider("models", state.models.filter((_, index) => index !== action.index));
  };
  if (adding) return <AddProviderPage state={state} onBack={() => setAdding(false)} onAdd={() => setAdding(false)} />;
  return <>
    <SettingsPage title="模型" description="管理 Code 默认模型、提供方与模型目录。">
      {!state.view ? <SettingsNotice>{state.reading ? "正在读取模型配置…" : state.message || "Code 已离线，恢复连接后读取配置。"}</SettingsNotice> : <>
        <DefaultSettings state={state} reload={reload} />
        <SettingsGroup title="提供方" description="配置连接、认证与目录模型。" action={<SettingsButton onClick={() => setAdding(true)} disabled={state.disabled || state.dirty}><Plus />添加提供方</SettingsButton>}>
          <SettingsList label="模型提供方" empty="还没有提供方，请先添加。">
            {providerIds.map(id => <SettingsListItem key={id} title={String(state.draft[id]?.name ?? id)} description={typeof state.draft[id]?.baseUrl === "string" ? state.draft[id].baseUrl as string : "未设置 API 地址"} detailsId={`${id}-settings`} details={provider === id ? <ProviderSettings state={state} scope={scope} online={online} save={() => void save()} confirm={(kind, index) => setConfirmation({ kind, index })} /> : undefined}>
              <span className="settings-value">{state.view!.models.filter(model => model.provider === id).length} 个模型</span>
              <SettingsButton variant="icon" className="settings-disclosure" aria-label={`${provider === id ? "收起" : "配置"} ${String(state.draft[id]?.name ?? id)}`} aria-expanded={provider === id} aria-controls={`${id}-settings`} onClick={() => provider === id ? state.closeProvider() : state.selectProvider(id)}><ChevronRight /></SettingsButton>
            </SettingsListItem>)}
          </SettingsList>
        </SettingsGroup>
        {!provider && <><Notices state={state} scope={scope} online={online} />{(state.dirty || state.phase === "saving" || state.phase === "unknown") && <SettingsGroup title="操作"><SettingsCard><SettingsRow title="未保存的更改" description="保存或放弃当前草稿。"><SettingsButton variant="ghost" disabled={state.disabled || !state.dirty} onClick={() => state.discard()}>放弃更改</SettingsButton><SettingsButton disabled={state.disabled || !state.dirty} onClick={() => void state.save()}>保存更改</SettingsButton></SettingsRow></SettingsCard></SettingsGroup>}</>}
      </>}
    </SettingsPage>
    <Dialog open={confirmation !== null} onOpenChange={open => { if (!open) setConfirmation(null); }}><DialogContent className="demo-dialog"><DialogHeader><DialogTitle>确认所选操作？</DialogTitle><DialogDescription>{confirmation?.kind === "credential" ? "仅移除本提供方的存储条目" + (stored?.type === "oauth" ? "（OAuth，不撤销远端令牌）" : "") + "，目录、环境等来源仍可能生效。" : confirmation?.kind === "provider" ? "删除提供方目录及其存储条目；被默认、摘要、会话或角色引用时后台拒绝删除。" : "保存提供方时移除此模型；存在引用时后台拒绝保存。"}</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="ghost" onClick={() => setConfirmation(null)}>取消</Button><Button type="button" disabled={state.disabled} onClick={() => void confirmAction()}>确认</Button></DialogFooter></DialogContent></Dialog>
  </>;
}

function CodeModelsForm({ settings, scope, code }: SettingsPageProps) {
  const [state] = useState(() => new CodeModelsState({ request: (...args) => window.ruukoto.request(...args) }, settings.changed, scope.instanceId!, () => ({ instanceId: code.view.instanceId, online: code.status.state === "online" })));
  useEffect(() => { settings.form = state; void state.read(); return () => { state.invalidate(); if (settings.form === state) settings.form = null; }; }, [settings, state]);
  return <CodeModelsEditor state={state} scope={scope} online={code.status.state === "online"} />;
}

export function CodeModelsSettings(props: SettingsPageProps) {
  if (!props.scope.instanceId) return <SettingsPage title="模型" description="管理 Code 默认模型、提供方与模型目录。"><SettingsNotice>Code 已离线，请恢复后台连接后管理模型。</SettingsNotice></SettingsPage>;
  return <CodeModelsForm {...props} />;
}
