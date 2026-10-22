import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { SettingsPageProps } from "./settings-dialog.tsx";
import type { SettingsScope } from "./settings-state.ts";
import { CodeModelsState, type CatalogSecretLocation } from "./code-models-state.ts";
import { Button } from "./components/ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "./components/ui/field.tsx";
import { Input } from "./components/ui/input.tsx";
import { Item, ItemGroup } from "./components/ui/item.tsx";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select.tsx";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip.tsx";

function TextField({ state, field, label, value, edit, type = "text", prefix = "model" }: { state: CodeModelsState; field: string; label: string; value: unknown; edit: (value: string) => void; type?: "text" | "number" | "password"; prefix?: string }) {
  const error = state.fieldErrors[prefix === "model" ? field : `${prefix}-${field}`];
  return <Field data-invalid={!!error} data-disabled={state.disabled}><FieldLabel htmlFor={`${prefix}-${field}`}>{label}</FieldLabel><Input id={`${prefix}-${field}`} type={type} value={typeof value === "string" || typeof value === "number" ? value : ""} onChange={event => edit(event.target.value)} disabled={state.disabled} autoComplete={type === "password" ? "new-password" : "off"} spellCheck={false} aria-invalid={!!error} aria-describedby={error ? `${prefix}-${field}-error` : undefined} />{error && <FieldDescription role="alert" id={`${prefix}-${field}-error`}>{error}</FieldDescription>}</Field>;
}

function Section({ title, description, action, children }: { title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return <section className="model-settings-section" aria-label={title}><header className="model-settings-section-heading"><div><h3>{title}</h3>{description && <p>{description}</p>}</div>{action}</header>{children}</section>;
}

const apiTypes = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai", "mistral-conversations", "azure-openai-responses", "openai-codex-responses", "bedrock-converse-stream", "google-vertex", "pi-messages"];
function ApiField({ state, value, edit, id = "model-api", inherit = false }: { state: CodeModelsState; value: unknown; edit: (value: string | undefined) => void; id?: string; inherit?: boolean }) {
  const current = typeof value === "string" ? value : "";
  const options = current && !apiTypes.includes(current) ? [current, ...apiTypes] : apiTypes;
  return <Field><FieldLabel htmlFor={id}>API 类型</FieldLabel><Select value={current || "inherit"} disabled={state.disabled} onValueChange={value => edit(value === "inherit" ? undefined : value)}><SelectTrigger id={id}><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="inherit">{inherit ? "继承提供方" : "自动"}</SelectItem>{options.map(api => <SelectItem key={api} value={api}>{api}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>;
}

function SettingsRow({ title, detail, value, disabled, onClick }: { title: string; detail?: string; value?: string; disabled: boolean; onClick: () => void }) {
  return <Item role="listitem" className="model-settings-list-item" size="sm"><Button type="button" variant="ghost" className="model-settings-row" aria-label={title} disabled={disabled} onClick={onClick}><span className="model-settings-row-copy"><span className="model-settings-row-title">{title}</span>{detail && <span className="model-settings-row-detail">{detail}</span>}</span>{value && <span className="model-settings-row-value">{value}</span>}<ChevronRight aria-hidden="true" /></Button></Item>;
}

function credentialLocationLabel(location: { source: string; type?: string; scope?: string; modelId?: string; field?: string; header?: string }): string {
  if (location.source === "storage") return `存储条目 · ${location.type === "oauth" ? "OAuth" : location.type === "api_key" ? "API Key" : "类型未验证"}`;
  if (location.source === "catalog") return `目录 ${location.scope === "provider" ? "提供方" : `${location.scope === "modelOverrides" ? "模型覆盖" : "模型"} ${location.modelId}`} · ${location.field === "headers" ? `请求头 ${location.header}` : "apiKey"}`;
  return location.source === "runtime" ? "运行时覆盖（有效性未验证）" : "SDK 来源或有效性未验证";
}

function CatalogSecrets({ state }: { state: CodeModelsState }) {
  const [scope, setScope] = useState("provider"), [header, setHeader] = useState("");
  const targets: { id: string; label: string; location: Pick<CatalogSecretLocation, "scope" | "modelId">; value: Record<string, unknown> }[] = [
    { id: "provider", label: "提供方", location: { scope: "provider" }, value: state.provider },
    ...state.models.map((model, index) => ({ id: `model:${index}`, label: `模型 ${model.id}`, location: { scope: "model" as const, modelId: String(model.id) }, value: model })),
    ...Object.entries((state.provider.modelOverrides ?? {}) as Record<string, Record<string, unknown>>).map(([id, value]) => ({ id: `override:${id}`, label: `模型覆盖 ${id}`, location: { scope: "modelOverrides" as const, modelId: id }, value })),
  ];
  const target = targets.find(item => item.id === scope) ?? targets[0];
  const headers = (target.value.headers ?? {}) as Record<string, unknown>;
  return <Collapsible className="model-settings-disclosure"><CollapsibleTrigger asChild><Button type="button" variant="ghost" className="model-settings-disclosure-trigger">目录密钥与请求头<ChevronDown aria-hidden="true" /></Button></CollapsibleTrigger><CollapsibleContent><FieldGroup className="model-settings-disclosure-body">
    <Field><FieldLabel htmlFor="catalog-secret-scope">配置位置</FieldLabel><Select value={target.id} disabled={state.disabled || !!state.headerDraft} onValueChange={setScope}><SelectTrigger id="catalog-secret-scope"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{targets.map(item => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
    <Field><FieldLabel htmlFor="catalog-api-key">目录 apiKey</FieldLabel><div className="model-settings-secret-row"><Input id="catalog-api-key" type="password" autoComplete="new-password" disabled={state.disabled} placeholder={target.value.apiKey === true ? "已配置，输入新值替换" : "未配置"} value={typeof target.value.apiKey === "string" ? target.value.apiKey : ""} onChange={event => state.editSecret({ ...target.location, field: "apiKey" }, event.target.value)} /><Button type="button" variant="ghost" size="icon-sm" aria-label="清除所选目录 apiKey" title="清除所选目录 apiKey" disabled={state.disabled || target.value.apiKey === undefined} onClick={() => state.editSecret({ ...target.location, field: "apiKey" }, null)}><Trash2 /></Button></div></Field>
    {Object.entries(headers).map(([name, value], index) => <Field key={`${target.id}:${name}`}><FieldLabel htmlFor={`catalog-header-${index}`}>请求头 {name}</FieldLabel><div className="model-settings-secret-row"><Input id={`catalog-header-${index}`} type="password" autoComplete="new-password" placeholder="已配置，输入新值替换" disabled={state.disabled} value={typeof value === "string" ? value : ""} onChange={event => state.editSecret({ ...target.location, field: "headers", header: name }, event.target.value)} /><Button type="button" variant="ghost" size="icon-sm" aria-label={`清除请求头 ${name}`} title={`清除请求头 ${name}`} disabled={state.disabled} onClick={() => state.editSecret({ ...target.location, field: "headers", header: name }, null)}><Trash2 /></Button></div></Field>)}
    <FieldGroup className="model-settings-grid"><Field data-invalid={!!state.fieldErrors.headers}><FieldLabel htmlFor="catalog-new-header">新增请求头名称</FieldLabel><Input id="catalog-new-header" value={header} disabled={state.disabled} onChange={event => { setHeader(event.target.value); if (state.headerDraft) state.editNewHeader({ ...target.location, field: "headers" }, event.target.value, state.headerDraft.value); }} aria-invalid={!!state.fieldErrors.headers} />{state.fieldErrors.headers && <FieldDescription role="alert">{state.fieldErrors.headers}</FieldDescription>}</Field><Field><FieldLabel htmlFor="catalog-new-header-value">新请求头值</FieldLabel><Input id="catalog-new-header-value" type="password" value={state.headerDraft?.value ?? ""} disabled={state.disabled} autoComplete="new-password" onChange={event => state.editNewHeader({ ...target.location, field: "headers" }, header, event.target.value)} /></Field></FieldGroup>
    <div className="model-settings-actions"><Button type="button" variant="outline" size="sm" disabled={state.disabled || !header.trim() || !state.headerDraft?.value} onClick={() => { if (state.addHeader()) setHeader(""); }}><Plus data-icon="inline-start" />添加请求头</Button></div>
  </FieldGroup></CollapsibleContent></Collapsible>;
}

function DefaultSettings({ state, reload }: { state: CodeModelsState; reload: ReactNode }) {
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
  return <Section title="默认设置" action={reload}><FieldGroup>
    <Field orientation="horizontal" className="model-settings-default-row" data-invalid={!!state.fieldErrors.model}><FieldLabel htmlFor="settings-model-choice">后台默认模型</FieldLabel><div className="model-settings-default-controls"><Select value={defaultIndex >= 0 ? String(defaultIndex) : ""} disabled={state.disabled} onValueChange={value => { const model = models[Number(value)]; if (model) void change("default", { provider: model.provider, modelId: model.modelId, thinkingLevel: model.thinkingLevels?.includes(effective.thinkingLevel) ? effective.thinkingLevel : model.thinkingLevels?.[0] ?? "off" }); }}><SelectTrigger id="settings-model-choice" aria-invalid={!!state.fieldErrors.model}><SelectValue placeholder={currentDefault ? currentDefault.modelId : `自动 · ${runtimeName}`} /></SelectTrigger><SelectContent><SelectGroup>{models.map((model, index) => <SelectItem key={`${model.provider}/${model.modelId}`} value={String(index)} disabled={!model.thinkingLevels?.length}>{model.name} · {model.provider}{model.thinkingLevels === null ? "（档位未知）" : ""}</SelectItem>)}</SelectGroup></SelectContent></Select><Select value={effective.thinkingLevel} disabled={state.disabled || !effortModel?.thinkingLevels?.length} onValueChange={value => { const thinkingLevel = effortModel?.thinkingLevels?.find(level => level === value); if (thinkingLevel) void change("default", { ...effective, thinkingLevel }); }}><SelectTrigger id="settings-model-effort" aria-label="Effort"><SelectValue placeholder="档位未知" /></SelectTrigger><SelectContent><SelectGroup>{effortModel?.thinkingLevels?.map(level => <SelectItem key={level} value={level}>{level}</SelectItem>)}</SelectGroup></SelectContent></Select></div></Field>
    <Field orientation="horizontal" className="model-settings-default-row"><FieldLabel htmlFor="settings-summary-model">摘要模型</FieldLabel><Select value={currentSummary ? summaryIndex >= 0 ? String(summaryIndex) : "" : "task"} disabled={state.disabled} onValueChange={value => { const model = models[Number(value)]; if (value === "task") void change("summary", null); else if (model) void change("summary", { provider: model.provider, modelId: model.modelId, thinkingLevel: "off" }); }}><SelectTrigger id="settings-summary-model"><SelectValue placeholder={currentSummary?.modelId ?? "跟随任务模型"} /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="task">跟随任务模型</SelectItem>{models.map((model, index) => <SelectItem key={`${model.provider}/${model.modelId}`} value={String(index)}>{model.name} · {model.provider}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
    {state.fieldErrors.model && <FieldDescription role="alert">{state.fieldErrors.model}</FieldDescription>}
    {(view.runtimeOverrides.model || view.runtimeOverrides.thinking) && <FieldDescription>此处保存持久默认值，运行时选择仍受显式启动参数影响。</FieldDescription>}
    {!models.length && <FieldDescription>尚无已配置模型，请先添加提供方和模型。</FieldDescription>}
  </FieldGroup></Section>;
}

function ModelFields({ state, index, remove, test }: { state: CodeModelsState; index: number; remove: () => void; test: () => void }) {
  const model = state.models[index], prefix = "catalog-model-" + index;
  const [open, setOpen] = useState(true);
  useEffect(() => { const errors = Object.keys(state.fieldErrors); if (errors.some(field => field.startsWith(prefix + "-"))) { if (!open) setOpen(true); else if (errors[0]?.startsWith(prefix + "-")) document.getElementById(errors[0])?.focus(); } }, [state.fieldErrors, prefix, open]);
  const edit = (field: string, value: unknown) => { delete state.fieldErrors[prefix + "-" + field]; state.editProvider("models", state.models.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item)); };
  const result = state.connectionTest(String(model.id));
  const status = result ? result.ok ? "success" : "failure" : "untested";
  const statusLabel = result ? result.ok ? "连接测试成功" : "连接测试失败" : "未测试";
  return <Collapsible open={open} onOpenChange={setOpen} className="model-settings-model"><Tooltip><TooltipTrigger asChild><CollapsibleTrigger asChild><Button type="button" variant="ghost" className="model-settings-disclosure-trigger"><span className="model-settings-model-name">{String(model.name || model.id || "新模型")}<span className={"model-settings-test-dot " + status} role="img" aria-label={statusLabel} title={result?.ok === false ? result.detail : statusLabel} /></span><ChevronDown aria-hidden="true" /></Button></CollapsibleTrigger></TooltipTrigger><TooltipContent>{result?.ok === false ? result.detail : statusLabel}</TooltipContent></Tooltip><CollapsibleContent><FieldGroup>
    <FieldGroup className="model-settings-grid"><TextField state={state} prefix={prefix} field="id" label="模型 ID" value={model.id} edit={value => edit("id", value)} /><TextField state={state} prefix={prefix} field="name" label="模型名称" value={model.name} edit={value => edit("name", value || undefined)} /></FieldGroup>
    <FieldGroup className="model-settings-grid">{(["contextWindow", "maxTokens"] as const).map(field => <TextField key={field} state={state} prefix={prefix} field={field} label={field === "contextWindow" ? "上下文容量" : "输出上限"} type="number" value={model[field]} edit={value => edit(field, value ? Number(value) : undefined)} />)}{(["image", "reasoning"] as const).map(field => <Field key={field}><FieldLabel htmlFor={prefix + "-" + field}>{field === "image" ? "图片输入" : "推理能力"}</FieldLabel><Select value={String(field === "image" ? Array.isArray(model.input) && model.input.includes("image") : model.reasoning === true)} disabled={state.disabled} onValueChange={value => edit(field === "image" ? "input" : "reasoning", field === "image" ? value === "true" ? Array.from(new Set([...(Array.isArray(model.input) ? model.input : ["text"]), "image"])) : (Array.isArray(model.input) ? model.input : ["text"]).filter(item => item !== "image") : value === "true")}><SelectTrigger id={prefix + "-" + field}><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="false">不支持</SelectItem><SelectItem value="true">支持</SelectItem></SelectGroup></SelectContent></Select></Field>)}</FieldGroup>
    <Collapsible><CollapsibleTrigger asChild><Button type="button" variant="ghost" size="sm">单独指定接口<ChevronDown aria-hidden="true" /></Button></CollapsibleTrigger><CollapsibleContent><FieldGroup className="model-settings-disclosure-body"><ApiField state={state} id={prefix + "-api"} inherit value={model.api} edit={value => edit("api", value)} /><TextField state={state} prefix={prefix} field="baseUrl" label="API 地址" value={model.baseUrl} edit={value => edit("baseUrl", value || undefined)} /></FieldGroup></CollapsibleContent></Collapsible>
    <div className="model-settings-model-actions"><Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="sm" disabled={state.disabled || state.dirty || state.testing} onClick={test}>{state.testing && state.testingModelId === model.id ? "正在测试…" : "测试连接"}</Button></TooltipTrigger><TooltipContent>测试已保存配置，会联网且可能产生费用。</TooltipContent></Tooltip><Button type="button" variant="ghost" size="icon-sm" aria-label={"删除模型 " + String(model.name || model.id || index + 1)} title="删除模型" disabled={state.disabled} onClick={remove}><Trash2 /></Button></div>
  </FieldGroup></CollapsibleContent></Collapsible>;
}

function Notices({ state, scope, online }: { state: CodeModelsState; scope: SettingsScope; online: boolean }) {
  return <>
    {state.instanceId !== scope.instanceId && <p className="model-settings-notice" role="alert">连接实例已变化。请恢复原实例核实，或放弃草稿后重新打开此页。</p>}
    {!online && <p className="model-settings-notice" role="status">Code 已离线，恢复原连接后可继续保存。</p>}
    {state.phase === "unknown" && <div className="model-settings-notice" role="status"><p>{state.message || "原操作结果待核实，不会自动重发。"}</p><Button type="button" variant="outline" size="sm" disabled={state.reading || !online} onClick={() => void state.read()}>核实原操作结果</Button></div>}
    {state.phase === "conflict" && <div className="model-settings-notice" role="status"><p>当前配置已更新，草稿保留。请比较后保存或放弃。</p><Collapsible><CollapsibleTrigger asChild><Button type="button" variant="ghost" size="sm">查看当前配置<ChevronDown aria-hidden="true" /></Button></CollapsibleTrigger><CollapsibleContent><pre>{JSON.stringify(state.screen === "default" ? state.view?.defaultModel : state.screen === "summary" ? state.view?.summaryModel : state.providerId ? state.view?.providers[state.providerId] : state.view?.providers, null, 2)}</pre></CollapsibleContent></Collapsible></div>}
    {state.message && state.phase !== "unknown" && <p className="model-settings-notice" role="status">{state.message}</p>}
  </>;
}

export function ProviderSettings({ state, scope, online, save, confirm }: { state: CodeModelsState; scope: SettingsScope; online: boolean; save: () => void; confirm: (kind: "provider" | "credential" | "model", index?: number) => void }) {
  const provider = state.providerId!;
  const stored = state.view?.credentials[provider];
  const sources = state.view?.credentialSources[provider]?.locations ?? [];
  return <TooltipProvider><form className="model-settings model-settings-provider" aria-label="提供方配置" aria-busy={state.reading || state.phase === "saving"} onSubmit={event => { event.preventDefault(); save(); }}>
    <div className="model-settings-dialog-body">
      <Notices state={state} scope={scope} online={online} />
      {state.view?.busyProviders.includes(provider) && <p className="model-settings-notice" role="status">此提供方正在应用配置，请稍后重新读取。</p>}
      <Section title="连接设置"><FieldGroup><FieldGroup className="model-settings-grid"><TextField state={state} field="name" label="显示名称" value={state.provider.name} edit={value => state.editProvider("name", value || undefined)} /><ApiField state={state} value={state.provider.api} edit={value => state.editProvider("api", value)} /></FieldGroup><TextField state={state} field="baseUrl" label="API 地址" value={state.provider.baseUrl} edit={value => state.editProvider("baseUrl", value || undefined)} /></FieldGroup></Section>
      <Section title="认证"><FieldGroup><TextField state={state} field="apiKey" label="存储 API Key" type="password" value={state.secret} edit={value => state.editStoredSecret(value)} />{stored?.type === "oauth" && <FieldDescription>填写新 Key 会替换 OAuth 存储条目；移除不会撤销远端令牌。</FieldDescription>}</FieldGroup><div className="model-settings-actions">{stored?.configured && <Button type="button" variant="ghost" size="sm" disabled={state.disabled || state.dirty} onClick={() => confirm("credential")}>移除存储凭据</Button>}<Collapsible className="model-settings-sources"><CollapsibleTrigger asChild><Button type="button" variant="ghost" size="sm">查看全部配置位置<ChevronDown aria-hidden="true" /></Button></CollapsibleTrigger><CollapsibleContent><ul>{sources.map((source, index) => <li key={index}>{credentialLocationLabel(source)}</li>)}</ul></CollapsibleContent></Collapsible></div></Section>
      <Section title="模型" action={<Button type="button" variant="ghost" size="sm" disabled={state.disabled} onClick={() => state.addModel("")}><Plus data-icon="inline-start" />添加模型</Button>}><div className="model-settings-models">{state.models.map((_, index) => <ModelFields key={index} state={state} index={index} remove={() => confirm("model", index)} test={() => void state.testConnection(String(state.models[index].id))} />)}</div>{!state.models.length && <p className="model-settings-hint">还没有目录模型。</p>}</Section>
      <CatalogSecrets state={state} />
    </div>
    <footer className="model-settings-footer">{Object.hasOwn(state.view?.providers ?? {}, provider) && <Button type="button" variant="ghost" size="sm" className="model-settings-delete" disabled={state.disabled || state.dirty} onClick={() => confirm("provider")}>删除提供方</Button>}<Button type="submit" size="sm" disabled={state.disabled || !state.dirty}>保存</Button></footer>
  </form></TooltipProvider>;
}

// Note: 见 .agents/notes/implemented/feature/2026-10-21-code-model-settings.md
export function CodeModelsEditor({ state, scope, online }: { state: CodeModelsState; scope: SettingsScope; online: boolean }) {
  const [creating, setCreating] = useState(false);
  const [confirmation, setConfirmation] = useState<{ kind: "provider" | "model" | "credential"; index?: number } | null>(null);
  const provider = state.providerId;
  const stored = provider ? state.view?.credentials[provider] : null;
  const providerIds = Array.from(new Set([...Object.keys(state.draft), ...Object.keys(state.view?.credentialSources ?? {})]));
  useEffect(() => { if (Object.keys(state.fieldErrors).length) document.querySelector<HTMLElement>('.model-settings [aria-invalid="true"]')?.focus(); }, [state.fieldErrors]);
  const save = async () => { if (await state.save()) state.selectProvider(null); };
  const reload = <Button type="button" variant="ghost" size="icon-sm" aria-label="重新读取配置" title="重新读取配置" disabled={state.reading || state.phase === "saving" || !online} onClick={() => void state.read()}><RefreshCw className={state.reading ? "animate-spin" : undefined} /></Button>;
  const confirmAction = async () => {
    const action = confirmation; setConfirmation(null);
    if (action?.kind === "provider") await state.removeProvider();
    else if (action?.kind === "credential") await state.removeStoredCredential();
    else if (action?.kind === "model") state.editProvider("models", state.models.filter((_, index) => index !== action.index));
  };
  return <><div className="model-settings model-settings-overview" aria-label="Code 模型配置" aria-busy={state.reading || state.phase === "saving"}>
    {!state.view ? <p className="model-settings-notice" role="status">{state.reading ? "正在读取模型配置…" : state.message || "Code 已离线，恢复连接后读取配置。"}</p> : <>
      <DefaultSettings state={state} reload={reload} />
      <Section title="提供方" action={<Button type="button" variant="ghost" size="sm" disabled={state.disabled || state.dirty} onClick={() => { state.addProvider("custom-" + crypto.randomUUID()); setCreating(true); }}><Plus data-icon="inline-start" />添加提供方</Button>}><ItemGroup className="model-settings-list">{providerIds.map(id => <SettingsRow key={id} title={String(state.draft[id]?.name ?? id)} detail={typeof state.draft[id]?.baseUrl === "string" ? state.draft[id].baseUrl as string : "未设置 API 地址"} value={String(state.view!.models.filter(model => model.provider === id).length) + " 个模型"} disabled={state.disabled || state.dirty} onClick={() => { state.selectProvider(id); setCreating(false); }} />)}</ItemGroup>{!providerIds.length && <p className="model-settings-hint">还没有提供方。</p>}</Section>
      {!provider && <><Notices state={state} scope={scope} online={online} />{(state.dirty || state.phase === "saving" || state.phase === "unknown") && <footer className="model-settings-footer"><div className="model-settings-actions"><Button type="button" variant="ghost" size="sm" disabled={state.disabled || !state.dirty} onClick={() => state.discard()}>放弃更改</Button><Button type="button" size="sm" disabled={state.disabled || !state.dirty} onClick={() => void state.save()}>保存更改</Button></div></footer>}</>}
    </>}
  </div>
  <Dialog open={provider !== null} onOpenChange={open => { if (!open) state.closeProvider(); }}><DialogContent className="demo-dialog model-settings-dialog" onInteractOutside={event => event.preventDefault()}><DialogHeader><DialogTitle>{creating ? "添加提供方" : "编辑提供方"}</DialogTitle><DialogDescription>配置连接、认证与模型。</DialogDescription></DialogHeader>{provider && <ProviderSettings state={state} scope={scope} online={online} save={() => void save()} confirm={(kind, index) => setConfirmation({ kind, index })} />}</DialogContent></Dialog>
  <Dialog open={confirmation !== null} onOpenChange={open => { if (!open) setConfirmation(null); }}><DialogContent className="demo-dialog"><DialogHeader><DialogTitle>确认所选操作？</DialogTitle><DialogDescription>{confirmation?.kind === "credential" ? "仅移除本提供方的存储条目" + (stored?.type === "oauth" ? "（OAuth，不撤销远端令牌）" : "") + "，目录、环境等来源仍可能生效。" : confirmation?.kind === "provider" ? "删除提供方目录及其存储条目；被默认、摘要、会话或角色引用时后台拒绝删除。" : "保存提供方时移除此模型；存在引用时后台拒绝保存。"}</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="ghost" onClick={() => setConfirmation(null)}>取消</Button><Button type="button" disabled={state.disabled} onClick={() => void confirmAction()}>确认</Button></DialogFooter></DialogContent></Dialog></>;
}

function CodeModelsForm({ settings, scope, code }: SettingsPageProps) {
  const [state] = useState(() => new CodeModelsState({ request: (...args) => window.ruukoto.request(...args) }, settings.changed, scope.instanceId!, () => ({ instanceId: code.view.instanceId, online: code.status.state === "online" })));
  useEffect(() => { settings.form = state; void state.read(); return () => { state.invalidate(); if (settings.form === state) settings.form = null; }; }, [settings, state]);
  return <CodeModelsEditor state={state} scope={scope} online={code.status.state === "online"} />;
}

export function CodeModelsSettings(props: SettingsPageProps) {
  if (!props.scope.instanceId) return <FieldDescription role="status">Code 已离线，请恢复后台连接后管理模型。</FieldDescription>;
  return <CodeModelsForm {...props} />;
}
