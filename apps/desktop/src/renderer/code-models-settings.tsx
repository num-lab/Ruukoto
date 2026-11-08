import { useEffect, useState } from "react";
import { ChevronRight, Plus, Trash2 } from "lucide-react";
import type { SettingsPageProps } from "./settings-dialog.tsx";
import type { SettingsScope } from "./settings-state.ts";
import { CodeModelsState, type CatalogSecretLocation } from "./code-models-state.ts";
import { SettingsButton, SettingsInput, SettingsNotice, SettingsSelect, SettingsSwitch } from "./components/controls.tsx";
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
  if (location.source === "storage") return `Stored entry · ${location.type === "oauth" ? "OAuth" : location.type === "api_key" ? "API Key" : "type unverified"}`;
  if (location.source === "catalog") return `Catalog ${location.scope === "provider" ? "provider" : `${location.scope === "modelOverrides" ? "override" : "model"} ${location.modelId}`} · ${location.field === "headers" ? `header ${location.header}` : "apiKey"}`;
  return location.source === "runtime" ? "Runtime override (validity unverified)" : "SDK source or validity unverified";
}

function Notices({ state, scope, online }: { state: CodeModelsState; scope: SettingsScope; online: boolean }) {
  return <>
    {state.reading && <SettingsNotice>Loading model configuration…</SettingsNotice>}
    {state.instanceId !== scope.instanceId && <SettingsNotice>The connected instance changed. Restore the original instance to verify, or discard the draft and reopen this page.</SettingsNotice>}
    {!online && <SettingsNotice>Code is offline; saving resumes once the connection recovers.</SettingsNotice>}
    {state.phase === "unknown" && <div className="settings-notice"><p>{state.message || "The original operation outcome is unverified; it won't be resent."}</p><SettingsButton disabled={state.reading || !online} onClick={() => void state.read()}>Verify the original operation</SettingsButton></div>}
    {state.phase === "conflict" && <div className="settings-notice"><p>The current configuration updated; your draft is kept. Compare before saving or discarding.</p></div>}
    {state.message && state.phase !== "unknown" && <SettingsNotice>{state.message}</SettingsNotice>}
    {(state.phase === "error" || state.phase === "conflict") && <SettingsButton variant="ghost" disabled={state.reading || !online} onClick={() => void state.read()}>Verify original configuration</SettingsButton>}
  </>;
}

function CatalogSecrets({ state }: { state: CodeModelsState }) {
  const [scope, setScope] = useState("provider"), [header, setHeader] = useState("");
  const [open, setOpen] = useState(false);
  const targets: { id: string; label: string; location: Pick<CatalogSecretLocation, "scope" | "modelId">; value: Record<string, unknown> }[] = [
    { id: "provider", label: "Provider", location: { scope: "provider" }, value: state.provider },
    ...state.models.map((model, index) => ({ id: `model:${index}`, label: `Model ${model.id}`, location: { scope: "model" as const, modelId: String(model.id) }, value: model })),
    ...Object.entries((state.provider.modelOverrides ?? {}) as Record<string, Record<string, unknown>>).map(([id, value]) => ({ id: `override:${id}`, label: `Override ${id}`, location: { scope: "modelOverrides" as const, modelId: id }, value })),
  ];
  const target = targets.find(item => item.id === scope) ?? targets[0];
  const headers = (target.value.headers ?? {}) as Record<string, unknown>;
  return <SettingsRow title="Catalog keys and headers" description="Choose where to configure keys, per provider, model or override." footer={open && <div className="settings-inline-panel">
    <SettingsRow title="Location" htmlFor="catalog-secret-scope"><SettingsSelect id="catalog-secret-scope" value={target.id} disabled={state.disabled || !!state.headerDraft} onValueChange={nextValue => setScope(nextValue)} options={targets.map(item => ({ value: item.id, label: item.label }))} /></SettingsRow>
    <SettingsRow title="Catalog apiKey" htmlFor="catalog-api-key"><div className="settings-row-control"><SettingsInput id="catalog-api-key" type="password" autoComplete="new-password" disabled={state.disabled} placeholder={target.value.apiKey === true ? "Configured; enter a new value to replace" : "Not configured"} value={typeof target.value.apiKey === "string" ? target.value.apiKey : ""} onChange={event => state.editSecret({ ...target.location, field: "apiKey" }, event.target.value)} /><SettingsButton variant="icon" aria-label="Clear the selected catalog apiKey" title="Clear the selected catalog apiKey" disabled={state.disabled || target.value.apiKey === undefined} onClick={() => state.editSecret({ ...target.location, field: "apiKey" }, null)}><Trash2 /></SettingsButton></div></SettingsRow>
    {Object.entries(headers).map(([name, value], index) => <SettingsRow key={`${target.id}:${name}`} title={`Header ${name}`} htmlFor={`catalog-header-${index}`}><div className="settings-row-control"><SettingsInput id={`catalog-header-${index}`} type="password" autoComplete="new-password" placeholder="Configured; enter a new value to replace" disabled={state.disabled} value={typeof value === "string" ? value : ""} onChange={event => state.editSecret({ ...target.location, field: "headers", header: name }, event.target.value)} /><SettingsButton variant="icon" aria-label={`Clear header ${name}`} title={`Clear header ${name}`} disabled={state.disabled} onClick={() => state.editSecret({ ...target.location, field: "headers", header: name }, null)}><Trash2 /></SettingsButton></div></SettingsRow>)}
    <SettingsRow title="New header name" htmlFor="catalog-new-header"><SettingsInput id="catalog-new-header" value={header} disabled={state.disabled} onChange={event => { setHeader(event.target.value); if (state.headerDraft) state.editNewHeader({ ...target.location, field: "headers" }, event.target.value, state.headerDraft.value); }} aria-invalid={!!state.fieldErrors.headers} /></SettingsRow>
    <SettingsRow title="New header value" htmlFor="catalog-new-header-value"><SettingsInput id="catalog-new-header-value" type="password" value={state.headerDraft?.value ?? ""} disabled={state.disabled} autoComplete="new-password" onChange={event => state.editNewHeader({ ...target.location, field: "headers" }, header, event.target.value)} /></SettingsRow>
    <SettingsRow title="Headers" description="Headers are written when the provider saves."><SettingsButton variant="icon" aria-label="Add header" title="Add header" disabled={state.disabled || !header.trim() || !state.headerDraft?.value} onClick={() => { if (state.addHeader()) setHeader(""); }}><Plus /></SettingsButton></SettingsRow>
  </div>}>
    <SettingsButton variant="ghost" onClick={() => setOpen(value => !value)} aria-expanded={open}>{open ? "Collapse" : "Configure"}</SettingsButton>
  </SettingsRow>;
}

function CatalogModel({ state, index, remove, test }: { state: CodeModelsState; index: number; remove: () => void; test: () => void }) {
  const model = state.models[index], prefix = "catalog-model-" + index;
  const [expanded, setExpanded] = useState(false);
  const [customApi, setCustomApi] = useState(false);
  const result = state.connectionTest(String(model.id));
  const status = result ? result.ok ? "success" : "failure" : "untested";
  const statusLabel = result ? result.ok ? "Connection test succeeded" : "Connection test failed" : "Not tested";
  const edit = (field: string, value: unknown) => { delete state.fieldErrors[prefix + "-" + field]; state.editProvider("models", state.models.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item)); };
  return (
    <SettingsCard className="settings-catalog-model">
      <SettingsRow title={String(model.name || model.id || "New model")} description={`Model ID: ${model.id} · ${statusLabel}`}>
        <SettingsButton variant="ghost" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>{expanded ? "Collapse" : "Edit"}<ChevronRight className={expanded ? "is-expanded" : ""} /></SettingsButton>
      </SettingsRow>
      <div className="settings-catalog-fields" hidden={!expanded}>
        <TextSetting id={`${prefix}-name`} title="Model name" defaultValue={String(model.name ?? "")} invalid={!!state.fieldErrors[`${prefix}-name`]} onChange={value => edit("name", value || undefined)} />
        <TextSetting id={`${prefix}-id`} title="Model ID" defaultValue={String(model.id ?? "")} invalid={!!state.fieldErrors[`${prefix}-id`]} onChange={value => edit("id", value)} />
        <TextSetting id={`${prefix}-contextWindow`} title="Context capacity" type="number" defaultValue={Number(model.contextWindow ?? 0)} invalid={!!state.fieldErrors[`${prefix}-contextWindow`]} onChange={value => edit("contextWindow", value ? Number(value) : undefined)} />
        <TextSetting id={`${prefix}-maxTokens`} title="Output limit" type="number" defaultValue={Number(model.maxTokens ?? 0)} invalid={!!state.fieldErrors[`${prefix}-maxTokens`]} onChange={value => edit("maxTokens", value ? Number(value) : undefined)} />
        <SettingsRow title="Image input" htmlFor={`${prefix}-image`}><SettingsSwitch id={`${prefix}-image`} checked={Array.isArray(model.input) && model.input.includes("image")} disabled={state.disabled} onChange={event => edit("input", event.target.checked ? Array.from(new Set([...(Array.isArray(model.input) ? model.input : ["text"]), "image"])) : (Array.isArray(model.input) ? model.input : ["text"]).filter(item => item !== "image"))} /></SettingsRow>
        <SettingsRow title="Reasoning" htmlFor={`${prefix}-reasoning`}><SettingsSwitch id={`${prefix}-reasoning`} checked={model.reasoning === true} disabled={state.disabled} onChange={event => edit("reasoning", event.target.checked)} /></SettingsRow>
        <SettingsRow title="Custom endpoint" description="Inherits provider configuration by default." footer={customApi && <div className="settings-inline-panel"><SettingsRow title="API type" htmlFor={`${prefix}-api`}><SettingsSelect id={`${prefix}-api`} value={String(model.api ?? "inherit")} disabled={state.disabled} onValueChange={nextValue => edit("api", nextValue === "inherit" ? undefined : nextValue)} options={[{ value: "inherit", label: "Inherit provider" }, ...apiOptions]} /></SettingsRow><TextSetting id={`${prefix}-base-url`} title="API URL" defaultValue={String(model.baseUrl ?? "")} onChange={value => edit("baseUrl", value || undefined)} /></div>}>
          <SettingsButton variant="ghost" onClick={() => setCustomApi(value => !value)} aria-expanded={customApi}>{customApi ? "Collapse" : "Configure"}</SettingsButton>
        </SettingsRow>
        <SettingsRow title="Model actions" description="Testing a saved configuration goes online and may cost money."><SettingsButton disabled={state.disabled || state.dirty || state.testing} onClick={test}>{state.testing && state.testingModelId === model.id ? "Testing…" : "Test connection"}</SettingsButton><SettingsButton variant="icon" aria-label={`Delete model ${String(model.name || model.id || index + 1)}`} title="Delete model" disabled={state.disabled} onClick={remove}><Trash2 /></SettingsButton></SettingsRow>
      </div>
    </SettingsCard>
  );
}

function DefaultSettings({ state }: { state: CodeModelsState }) {
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
  const modelOptions = models.map((model, index) => ({ value: String(index), label: `${model.name} · ${model.provider}${model.thinkingLevels === null ? " (levels unknown)" : ""}` }));
  return <SettingsGroup title="Defaults">
    <SettingsCard>
      <SettingsRow title="Backend default model" description="Affects future new chats; explicit runtime launch args still override." htmlFor="settings-model-choice" error={state.fieldErrors.model}>
        <div className="settings-row-control">
          <SettingsSelect id="settings-model-choice" value={defaultIndex >= 0 ? String(defaultIndex) : ""} disabled={state.disabled} onValueChange={nextValue => { const model = models[Number(nextValue)]; if (model) void change("default", { provider: model.provider, modelId: model.modelId, thinkingLevel: model.thinkingLevels?.includes(effective.thinkingLevel) ? effective.thinkingLevel : model.thinkingLevels?.[0] ?? "off" }); }} options={modelOptions} />
        </div>
      </SettingsRow>
      <SettingsRow title="Effort" description="Uses the reasoning levels the selected model supports." htmlFor="settings-model-effort">
          <SettingsSelect id="settings-model-effort" aria-label="Effort" value={effective.thinkingLevel} disabled={state.disabled || !effortModel?.thinkingLevels?.length} onValueChange={nextValue => { const thinkingLevel = effortModel?.thinkingLevels?.find(level => level === nextValue); if (thinkingLevel) void change("default", { ...effective, thinkingLevel }); }} options={(effortModel?.thinkingLevels ?? []).map(level => ({ value: level, label: level }))} />
      </SettingsRow>
      <SettingsRow title="Summary model" description="Follows the task model when not set separately." htmlFor="settings-summary-model">
        <SettingsSelect id="settings-summary-model" value={currentSummary ? summaryIndex >= 0 ? String(summaryIndex) : "" : "task"} disabled={state.disabled} onValueChange={nextValue => { const model = models[Number(nextValue)]; if (nextValue === "task") void change("summary", null); else if (model) void change("summary", { provider: model.provider, modelId: model.modelId, thinkingLevel: "off" }); }} options={[{ value: "task", label: "Follow task model" }, ...modelOptions]} />
      </SettingsRow>
      {(view.runtimeOverrides.model || view.runtimeOverrides.thinking) && <SettingsRow title="" description="Explicit runtime launch args still override this default." />}
      {!models.length && <SettingsRow title="" description="No models configured yet. Add a provider and model first." />}
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
      {state.view?.busyProviders.includes(provider) && <SettingsNotice>This provider is applying configuration. Read again later.</SettingsNotice>}
      <SettingsRow title="Connection" description="Configure the display name and endpoint." />
      <TextSetting id={`${provider}-name`} title="Display name" defaultValue={String(state.provider.name ?? "")} onChange={value => state.editProvider("name", value || undefined)} />
      <SettingsRow title="API type" htmlFor="model-api"><SettingsSelect id="model-api" value={String(state.provider.api ?? "")} disabled={state.disabled} onValueChange={nextValue => state.editProvider("api", nextValue || undefined)} options={apiOptions} /></SettingsRow>
      <TextSetting id={`${provider}-url`} title="API URL" defaultValue={String(state.provider.baseUrl ?? "")} onChange={value => state.editProvider("baseUrl", value || undefined)} />
      <TextSetting id={`${provider}-key`} title="Stored API key" description={stored?.configured ? "Stored entry · API key" : "Not configured; enter a new value to save"} type="password" placeholder="Not configured; enter a new value to save" onChange={value => state.editStoredSecret(value)} />
      <SettingsRow title="Credential source" description={stored?.type === "oauth" ? "A new key replaces the OAuth stored entry; removal doesn't revoke the remote token." : "Stored entry, catalog, runtime override and SDK sources shown separately."} footer={sourcesOpen && <div className="settings-inline-panel"><ul>{sources.map((source, index) => <li key={index}>{credentialLocationLabel(source)}</li>)}</ul></div>}>
        <SettingsButton variant="ghost" onClick={() => setSourcesOpen(value => !value)} aria-expanded={sourcesOpen}>{sourcesOpen ? "Collapse" : "View all locations"}</SettingsButton>
      </SettingsRow>
      {stored?.configured && <SettingsRow title="Stored credential" description="Removal doesn't revoke the remote token."><SettingsButton variant="ghost" disabled={state.disabled || state.dirty} onClick={() => confirm("credential")}>Remove stored credential</SettingsButton></SettingsRow>}
      <SettingsRow title="Catalog models" description="Configure model capabilities, capacity and endpoint overrides." footer={<div className="settings-model-list">{state.models.map((_, index) => <CatalogModel key={index} state={state} index={index} remove={() => confirm("model", index)} test={() => void state.testConnection(String(state.models[index].id))} />)}</div>}>
        <SettingsButton variant="icon" aria-label={`Add model to ${provider}`} title="Add model" disabled={state.disabled} onClick={() => state.addModel("")}><Plus /></SettingsButton>
      </SettingsRow>
      <CatalogSecrets state={state} />
      <SettingsRow title="Provider actions" description="The configuration serves all workspaces of this instance."><SettingsButton variant="ghost" disabled={state.disabled || state.dirty} onClick={() => confirm("provider")}>Delete provider</SettingsButton><SettingsButton disabled={state.disabled || !state.dirty} onClick={save}>Save</SettingsButton></SettingsRow>
    </div>
  );
}

export function AddProviderPage({ state, onBack, onAdd }: { state: CodeModelsState; onBack: () => void; onAdd: () => void }) {
  const cancel = () => { if (state.phase === "saving" || state.phase === "unknown") return; state.closeProvider(); onBack(); };
  return (
    <SettingsSubpage title="Add provider" description="Configure connection, auth and models." onBack={cancel}>
      <SettingsGroup title="Connection">
        <SettingsCard>
          <SettingsRow title="Display name" htmlFor="new-provider-name"><SettingsInput id="new-provider-name" value={String(state.provider.name ?? "")} disabled={state.disabled} onChange={event => state.editProvider("name", event.target.value)} placeholder="Provider name" /></SettingsRow>
          <SettingsRow title="API type" htmlFor="new-provider-api"><SettingsSelect id="new-provider-api" value={String(state.provider.api ?? "")} disabled={state.disabled} onValueChange={value => state.editProvider("api", value)} options={apiOptions} /></SettingsRow>
          <SettingsRow title="API URL" htmlFor="new-provider-url" error={state.fieldErrors.baseUrl}><SettingsInput id="new-provider-url" type="url" value={String(state.provider.baseUrl ?? "")} disabled={state.disabled} aria-invalid={!!state.fieldErrors.baseUrl} onChange={event => state.editProvider("baseUrl", event.target.value)} placeholder="https://api.example.com" /></SettingsRow>
          <SettingsRow title="Stored API key" htmlFor="new-provider-key" error={state.fieldErrors.apiKey}><SettingsInput id="new-provider-key" type="password" autoComplete="new-password" value={state.secret} disabled={state.disabled} aria-invalid={!!state.fieldErrors.apiKey} onChange={event => state.editStoredSecret(event.target.value)} /></SettingsRow>
        </SettingsCard>
      </SettingsGroup>
      {state.message && <SettingsNotice>{state.message}</SettingsNotice>}
      {(state.phase === "unknown" || state.phase === "error" || state.phase === "conflict") && <SettingsButton variant="ghost" disabled={state.reading} onClick={() => void state.read()}>Verify original configuration</SettingsButton>}
      <div className="settings-subpage-actions"><SettingsButton variant="ghost" disabled={state.phase === "saving" || state.phase === "unknown"} onClick={cancel}>Cancel</SettingsButton><SettingsButton variant="primary" disabled={state.disabled || !String(state.provider.name ?? "").trim() || !String(state.provider.baseUrl ?? "").trim()} onClick={() => void state.save().then(saved => { if (saved) onAdd(); })}>Add provider</SettingsButton></div>
    </SettingsSubpage>
  );
}

// Note: See .agents/notes/implemented/feature/2026-10-21-code-model-settings.md
export function CodeModelsEditor({ state, scope, online }: { state: CodeModelsState; scope: SettingsScope; online: boolean }) {
  const provider = state.providerId;
  const stored = provider ? state.view?.credentials[provider] : null;
  const providerIds = Array.from(new Set([...Object.keys(state.draft), ...Object.keys(state.view?.credentialSources ?? {})]));
  const [adding, setAdding] = useState(false);
  const [confirmation, setConfirmation] = useState<{ kind: "provider" | "model" | "credential"; index?: number } | null>(null);
  useEffect(() => { if (Object.keys(state.fieldErrors).length) document.querySelector<HTMLElement>('.settings-page [aria-invalid="true"]')?.focus(); }, [state.fieldErrors]);
  const save = async () => { if (await state.save()) state.selectProvider(null); };
  const confirmAction = async () => {
    const action = confirmation; setConfirmation(null);
    if (action?.kind === "provider") await state.removeProvider();
    else if (action?.kind === "credential") await state.removeStoredCredential();
    else if (action?.kind === "model") state.editProvider("models", state.models.filter((_, index) => index !== action.index));
  };
  if (adding) return <AddProviderPage state={state} onBack={() => setAdding(false)} onAdd={() => setAdding(false)} />;
  return <>
    <SettingsPage title="Models" description="Manage the Code default model, providers and model catalog.">
      {!state.view ? <Notices state={state} scope={scope} online={online} /> : <>
        <DefaultSettings state={state} />
        <SettingsGroup title="Providers" action={<SettingsButton variant="primary" onClick={() => { state.addProvider("custom-" + crypto.randomUUID()); setAdding(true); }} disabled={state.disabled || state.dirty}><Plus />Add provider</SettingsButton>}>
          <SettingsList label="Model providers" empty="No providers yet. Add one first.">
            {providerIds.map(id => <SettingsListItem key={id} title={String(state.draft[id]?.name ?? id)} description={typeof state.draft[id]?.baseUrl === "string" ? state.draft[id].baseUrl as string : "No API URL set"} detailsId={`${id}-settings`} expanded={provider === id} toggleLabel={`${provider === id ? "Collapse" : "Configure"} ${String(state.draft[id]?.name ?? id)}`} onToggle={() => provider === id ? state.closeProvider() : state.selectProvider(id)} details={provider === id ? <ProviderSettings state={state} scope={scope} online={online} save={() => void save()} confirm={(kind, index) => setConfirmation({ kind, index })} /> : undefined}>
              <span className="settings-value">{state.view!.models.filter(model => model.provider === id).length}  models</span>
            </SettingsListItem>)}
          </SettingsList>
        </SettingsGroup>
        {!provider && <><Notices state={state} scope={scope} online={online} />{(state.dirty || state.phase === "saving" || state.phase === "unknown") && <SettingsGroup title="Actions"><SettingsCard><SettingsRow title="Unsaved changes" description="Save or discard the current draft."><SettingsButton variant="ghost" disabled={state.disabled || !state.dirty} onClick={() => state.discard()}>Discard changes</SettingsButton><SettingsButton disabled={state.disabled || !state.dirty} onClick={() => void state.save()}>Save changes</SettingsButton></SettingsRow></SettingsCard></SettingsGroup>}</>}
      </>}
    </SettingsPage>
    <Dialog open={confirmation !== null} onOpenChange={open => { if (!open) setConfirmation(null); }}><DialogContent className="app-dialog"><DialogHeader><DialogTitle>Confirm the selected action?</DialogTitle><DialogDescription>{confirmation?.kind === "credential" ? "Removes only this provider's stored entry" + (stored?.type === "oauth" ? " (OAuth; the remote token isn't revoked)" : "") + "; catalog, environment and other sources may still apply." : confirmation?.kind === "provider" ? "Deletes the provider catalog and its stored entry; the backend rejects deletion when referenced by a default, summary, chat or role." : "Removes this model when the provider saves; the backend rejects the save while references exist."}</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="ghost" onClick={() => setConfirmation(null)}>Cancel</Button><Button type="button" disabled={state.disabled} onClick={() => void confirmAction()}>Confirm</Button></DialogFooter></DialogContent></Dialog>
  </>;
}

function CodeModelsForm({ settings, scope, code }: SettingsPageProps) {
  const [state] = useState(() => new CodeModelsState({ request: (...args) => window.ruukoto.request(...args) }, settings.changed, scope.instanceId!, () => ({ instanceId: code.view.instanceId, online: code.status.state === "online" })));
  useEffect(() => { settings.form = state; void state.read(); return () => { state.invalidate(); if (settings.form === state) settings.form = null; }; }, [settings, state]);
  return <CodeModelsEditor state={state} scope={scope} online={code.status.state === "online"} />;
}

export function CodeModelsSettings(props: SettingsPageProps) {
  if (!props.scope.instanceId) return <SettingsPage title="Models" description="Manage the Code default model, providers and model catalog."><SettingsNotice>Code is offline. Restore the backend connection to manage models.</SettingsNotice></SettingsPage>;
  return <CodeModelsForm {...props} />;
}
