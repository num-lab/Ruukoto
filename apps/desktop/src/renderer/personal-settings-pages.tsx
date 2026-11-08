import { useEffect, useState } from "react";
import { Plus, Puzzle } from "lucide-react";
import type { PersonalSettingsPageProps } from "./settings-dialog.tsx";
import { PersonalSettingsPageState } from "./personal-settings-state.ts";
import { SettingsButton, SettingsInput, SettingsNotice, SettingsSearch, SettingsSelect, SettingsSwitch, SettingsTag } from "./components/controls.tsx";
import { SettingsCard, SettingsGroup, SettingsList, SettingsListItem, SettingsPage, SettingsRow, SettingsSubpage } from "./components/settings.tsx";
import { Button } from "./components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";

function TextSetting({ id, title, description, type = "text", value = "", placeholder, disabled, invalid, onChange }: {
  id: string;
  title: string;
  description?: string;
  type?: "text" | "number" | "password" | "url";
  value?: string | number;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  onChange?: (value: string) => void;
}) {
  return <SettingsRow title={title} description={description} htmlFor={id}><SettingsInput id={id} type={type} value={value} placeholder={placeholder} disabled={disabled} aria-invalid={invalid} onChange={event => onChange?.(event.target.value)} autoComplete={type === "password" ? "new-password" : "off"} spellCheck={false} /></SettingsRow>;
}

const apiOptions = [
  { value: "openai-completions", label: "OpenAI Completions" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
];

function ModelEditor({ state }: { state: PersonalSettingsPageState }) {
  const [tested, setTested] = useState(false);
  return <SettingsGroup title="Current model">
    <SettingsCard>
      {!!state.modelPresets.length && <SettingsRow title="Model preset" htmlFor="pa-model-preset"><SettingsSelect id="pa-model-preset" value={state.modelPreset} disabled={state.disabled} onValueChange={nextValue => state.selectModelPreset(nextValue)} options={[{ value: "", label: "Custom" }, ...state.modelPresets.map(preset => ({ value: preset.id, label: `${preset.provider} · ${preset.name}` }))]} /></SettingsRow>}
      <SettingsRow title="API type" htmlFor="pa-api"><SettingsSelect id="pa-api" value={state.model.api} disabled={state.disabled} onValueChange={nextValue => state.editModel("api", nextValue as typeof state.model.api)} options={apiOptions} /></SettingsRow>
      {([["baseUrl", "Service URL"], ["modelId", "Model ID"], ["contextWindow", "Context limit"], ["maxTokens", "Output limit"], ["apiKeyEnv", "Credential env reference"]] as const).map(([key, label]) => <TextSetting key={key} id={`pa-${key}`} title={label} value={state.model[key]} type={key === "contextWindow" || key === "maxTokens" ? "number" : "text"} disabled={state.disabled} invalid={!!state.fieldErrors[key]} description={key === "apiKeyEnv" ? "Stores only the reference name; the credential comes from the original backend environment." : undefined} onChange={value => state.editModel(key, value)} />)}
      <SettingsRow title="Image input" htmlFor="pa-image"><SettingsSwitch id="pa-image" checked={state.model.imageInput} disabled={state.disabled} onChange={event => state.editModel("imageInput", event.target.checked)} /></SettingsRow>
      <SettingsRow title="Credential state" description="Original backend environment state."><SettingsTag>{({ available: "Available in the original backend", missing: "Missing from the original backend", unverified: "Original service environment unverified" })[state.view?.settings.model?.credential.state ?? "unverified"]}</SettingsTag></SettingsRow>
      <SettingsRow title="Connection test" description="Online test; may cost money." footer={tested && state.test && <SettingsNotice>Test {state.test.status === "passed" ? "passed" : state.test.status === "failed" ? "failed" : "unverified"}。{state.test.message}</SettingsNotice>}>
        <SettingsButton disabled={state.disabled} onClick={() => { setTested(true); void state.testModel(); }}>Test current model</SettingsButton>
      </SettingsRow>
    </SettingsCard>
  </SettingsGroup>;
}

function SkillsEditor({ state }: { state: PersonalSettingsPageState }) {
  const library = state.view!.settings.skills;
  return <>
    <SettingsGroup title="All skills" description={library.directory}>
      <SettingsSearch value={state.query} onChange={event => { state.query = event.target.value; state.changed(); }} placeholder="Filter by name" aria-label="Filter skills" />
      <SettingsList label="Skills list" empty="No skills to show.">
        {state.filtered.map(skill => <SettingsListItem key={skill.id} title={<span className="settings-title-with-icon"><Puzzle aria-hidden="true" />{skill.name}</span>} description={`${skill.description}${skill.explicitOnly ? " · explicit invocation only" : ""}`} />)}
      </SettingsList>
      {library.hasMore && <SettingsRow title="More skills"><SettingsButton variant="ghost" disabled={state.disabled || state.dirty} onClick={() => void state.more()}>Load more skills</SettingsButton></SettingsRow>}
    </SettingsGroup>
    {!!library.diagnostics.length && <SettingsGroup title="Skill diagnostics"><div className="settings-notice"><ul>{library.diagnostics.map((item, index) => <li key={index}>{item}</li>)}</ul>{library.diagnosticsTruncated && <p>Diagnostics truncated.</p>}</div></SettingsGroup>}
  </>;
}

function CuaControls({ state }: { state: PersonalSettingsPageState }) {
  if (!state.cua?.available && !state.cua?.operations.length && !state.services.some(service => service.cua)) return null;
  return <SettingsGroup title="Computer">
    <SettingsCard>
      {state.cua?.available && <SettingsRow title="Run state" description={state.cua.paused ? state.cua.busy ? "Pausing" : "Paused" : "Available"}>
        <SettingsButton disabled={state.disabled || state.cua.paused && state.cua.busy} onClick={() => void state.controlCua(state.cua!.paused ? "resume" : "pause")}>{state.cua.paused ? "Resume" : "Pause"}</SettingsButton>
      </SettingsRow>}
      {state.cua?.operations.map(item => <SettingsRow key={item.operation} title={`${item.service} · ${item.tool}`} description={item.cuaStopUnverified ? "Connection stop unverified" : item.cuaRecovery === "begun" || item.cuaRecovery === "observed" ? "Awaiting new observation confirmation" : item.effect === "effect_unknown" ? "Outcome unconfirmed" : "Connection lost"} footer={<>
        {state.cuaImages.filter(image => image.operation === item.operation && image.observation === item.cuaObservation).map((image, index) => <img key={`${image.observation}:${image.id}`} src={image.src} alt={`Recovery screenshot ${index + 1}`} style={{ maxWidth: "100%", height: "auto" }} onLoad={() => state.cuaImageLoaded(image.operation, image.observation, image.id, true)} onError={() => state.cuaImageLoaded(image.operation, image.observation, image.id, false)} />)}
      </>}>
        {item.cuaRecovery === "frozen" && <SettingsButton disabled={state.disabled} onClick={() => state.prepareCua("stop", item.operation)}>Stop sandbox</SettingsButton>}
        {item.cuaStopUnverified && (!item.cuaRecovery || item.cuaRecovery === "accepted") && <SettingsButton disabled={state.disabled} onClick={() => void state.controlCua("stop", item.operation)}>Verify connection stop</SettingsButton>}
        {(item.cuaRecovery === "stopped" || item.cuaRecovery === "begun" || item.cuaRecovery === "observed") && <>
          <SettingsButton disabled={state.disabled} onClick={() => void state.controlCua("observe", item.operation)}>{item.cuaRecovery === "observed" ? "New screenshot" : "Check and recover"}</SettingsButton>
          {item.cuaRecovery === "observed" && !state.cuaImages.some(image => image.operation === item.operation && image.observation === item.cuaObservation) && <SettingsButton variant="ghost" disabled={state.disabled} onClick={() => void state.loadCuaImages(item.operation)}>View screenshots</SettingsButton>}
        </>}
        {item.cuaRecovery === "observed" && <SettingsButton disabled={state.disabled || !state.canAcceptCua(item.operation, item.cuaObservation)} onClick={() => void state.controlCua("accept", item.operation)}>Confirm recovery</SettingsButton>}
      </SettingsRow>)}
    </SettingsCard>
    <Dialog open={!!state.cuaConfirmation} onOpenChange={open => { if (!open) state.cancelCua(); }}><DialogContent className="app-dialog"><DialogHeader><DialogTitle>Stop the sandbox?</DialogTitle><DialogDescription>Unsaved app state will be lost; disk files are kept.</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="ghost" onClick={() => state.cancelCua()}>Cancel</Button><Button type="button" disabled={state.disabled} onClick={() => void state.confirmCua()}>Stop sandbox</Button></DialogFooter></DialogContent></Dialog>
  </SettingsGroup>;
}

function ServiceTools({ state }: { state: PersonalSettingsPageState }) {
  const tools = new Map([...state.service.tools, ...(state.discovered ?? [])].map(tool => [tool.name, tool]));
  const effects = { read: "Read only", write: "Write", unknown: "Effects unknown" } as const;
  const effectOptions = [{ value: "blocked", label: "Blocked" }, { value: "read", label: "Read only" }, { value: "write", label: "Write" }, { value: "unknown", label: "Effects unknown" }];
  return <SettingsGroup title="Allowed tools">
    <SettingsCard>
      {[...tools.values()].map((tool, index) => {
        const allowed = state.service.tools.some(item => item.name === tool.name);
        const selection = allowed ? state.service.toolEffects[tool.name] ?? "unknown" : "blocked";
        return state.service.cua
          ? <SettingsRow key={tool.name} title={tool.name} description={tool.description} htmlFor={`pa-tool-${index}`}><SettingsSwitch id={`pa-tool-${index}`} checked={allowed} disabled={state.disabled} onChange={event => state.allowTool(tool, event.target.checked)} /></SettingsRow>
          : <SettingsRow key={tool.name} title={tool.name} description={tool.description} htmlFor={`pa-tool-${index}`}><SettingsSelect id={`pa-tool-${index}`} value={selection} disabled={state.disabled || state.mcpNeedsMigration} onValueChange={nextValue => { const value = nextValue; if (value === "blocked") state.allowTool(tool, false); else { if (!allowed) state.allowTool(tool, true); state.toolEffect(tool.name, value as keyof typeof effects); } }} options={effectOptions} /></SettingsRow>;
      })}
    </SettingsCard>
  </SettingsGroup>;
}

function McpOperations({ state }: { state: PersonalSettingsPageState }) {
  return <SettingsGroup title="Calls">
    <SettingsCard>
      {state.mcpOperations.filter(item => !item.cuaRecovery && (item.effect === "effect_unknown" || item.ended)).map(item => <SettingsRow key={item.operation} title={`${item.service} · ${item.tool}`} description={item.ended ? "Manually closed; outcome still unknown" : "Outcome unknown"}><SettingsButton disabled={state.disabled} onClick={() => void state.readMcpOperation(item.operation)}>View original call</SettingsButton></SettingsRow>)}
      {state.mcpNextOffset !== undefined && <SettingsRow title="More calls"><SettingsButton variant="ghost" disabled={state.disabled} onClick={() => void state.readMcpOperations(true)}>Load more calls</SettingsButton></SettingsRow>}
      {state.mcpDetail && <SettingsRow title={`${state.mcpDetail.summary.service} · ${state.mcpDetail.summary.tool}`} footer={<pre className="settings-code-block">{state.mcpDetail.text}</pre>}>
        {state.mcpDetail.nextOffset !== undefined && <SettingsButton variant="ghost" disabled={state.disabled} onClick={() => void state.readMcpOperation(state.mcpDetail!.summary.operation, true)}>Next page of the original call</SettingsButton>}
        {state.mcpDetail.summary.canEnd && !state.mcpDetail.summary.ended && !state.mcpDetail.summary.cuaRecovery && <SettingsButton disabled={state.disabled || state.mcpEndPending !== null} onClick={() => state.prepareMcpEnd(state.mcpDetail!.summary.operation)}>End this work; keep the unknown outcome</SettingsButton>}
      </SettingsRow>}
      {state.mcpEndPending !== null && <SettingsRow title="Original call closure unverified"><SettingsButton variant="ghost" disabled={state.disabled} onClick={() => void state.readMcpOperations()}>Verify original call closure</SettingsButton></SettingsRow>}
    </SettingsCard>
    <Dialog open={state.mcpEndConfirmation !== null} onOpenChange={open => { if (!open) state.cancelMcpEnd(); }}><DialogContent className="app-dialog"><DialogHeader><DialogTitle>End this work?</DialogTitle><DialogDescription>The original call outcome stays unknown; once the local execution stop verifies, the original work sends its final report.</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="ghost" onClick={() => state.cancelMcpEnd()}>Cancel</Button><Button type="button" disabled={state.disabled} onClick={() => void state.confirmMcpEnd()}>End this work; keep the unknown outcome</Button></DialogFooter></DialogContent></Dialog>
  </SettingsGroup>;
}

function McpEditor({ state }: { state: PersonalSettingsPageState }) {
  const editing = state.editingService;
  return <>
    {state.mcpNeedsMigration && <SettingsGroup title="Configuration migration" description="Keeps services, credentials and old calls; old normal tools default to unknown effects.">
      <SettingsCard><SettingsRow title="Legacy configuration"><SettingsButton disabled={state.disabled || state.dirty} onClick={() => void state.changeService("migrate")}>Update MCP configuration</SettingsButton></SettingsRow></SettingsCard>
    </SettingsGroup>}
    <SettingsGroup title="Services" action={<SettingsButton variant="primary" onClick={() => void state.selectService(null)} disabled={state.disabled || state.dirty || state.mcpNeedsMigration}><Plus />Add service</SettingsButton>}>
      <SettingsList label="MCP services" empty="No HTTP services configured yet.">
        {state.services.filter(service => !service.cua).map(service => <SettingsListItem key={service.id} title={service.label} description={`${service.endpoint} · ${({ anonymous: "Anonymous", valid: "Credential configured", missing: "Credential missing", invalid: "Credential invalid", "not-applicable": "Local" })[service.credentialStatus ?? "anonymous"]} · ${service.tools.length}  allowed tools`} expanded={editing && state.service.id === service.id} toggleLabel={`${editing && state.service.id === service.id ? "Collapse" : "Edit"} ${service.label}`} onToggle={() => { if (editing && state.service.id === service.id) { if (!state.dirty) state.discard(); } else void state.selectService(service.id); }} details={editing && state.service.id === service.id ? <ServiceDetails state={state} /> : undefined}>
          <SettingsTag>{service.enabled === false ? "Disabled" : "Enabled"}</SettingsTag>
        </SettingsListItem>)}
      </SettingsList>
      {editing && !state.services.some(service => service.id === state.service.id) && <SettingsCard className="settings-import-preview"><ServiceDetails state={state} /></SettingsCard>}
      {state.view!.settings.mcp?.hasMore && <SettingsRow title="More services"><SettingsButton variant="ghost" disabled={state.disabled || state.dirty} onClick={() => void state.more()}>Load more services</SettingsButton></SettingsRow>}
    </SettingsGroup>
    <McpOperations state={state} />
  </>;
}

function ServiceDetails({ state }: { state: PersonalSettingsPageState }) {
  return (
    <div className="settings-provider-settings">
      <SettingsRow title="Edit service" description="Configure the MCP HTTP service and allowed tools." />
      <SettingsRow title="Service name" htmlFor="pa-mcp-label" error={state.fieldErrors.label}><SettingsInput id="pa-mcp-label" autoComplete="off" value={state.service.label} disabled={state.disabled} aria-invalid={!!state.fieldErrors.label} onChange={event => state.editService("label", event.target.value)} /></SettingsRow>
      <SettingsRow title="HTTPS endpoint" htmlFor="pa-mcp-endpoint" error={state.fieldErrors.endpoint}><SettingsInput id="pa-mcp-endpoint" autoComplete="off" value={state.service.endpoint} disabled={state.disabled} aria-invalid={!!state.fieldErrors.endpoint} onChange={event => state.editService("endpoint", event.target.value)} /></SettingsRow>
      <SettingsRow title="Auth" htmlFor="pa-mcp-auth" error={state.fieldErrors.authentication}><SettingsSelect id="pa-mcp-auth" value={state.service.authentication} disabled={state.disabled} aria-invalid={!!state.fieldErrors.authentication} onValueChange={nextValue => state.editService("authentication", nextValue as typeof state.service.authentication)} options={[{ value: "anonymous", label: "Explicitly anonymous" }, { value: "credential", label: "Remote private credential file" }]} /></SettingsRow>
      {state.service.authentication === "credential" && <SettingsRow title="Remote private credential file" description="An invalid reference doesn't downgrade to anonymous; it can rebind on save." htmlFor="pa-mcp-credential" error={state.fieldErrors.credentialPath}><SettingsInput id="pa-mcp-credential" value={state.service.credentialPath} disabled={state.disabled} autoComplete="off" aria-invalid={!!state.fieldErrors.credentialPath} onChange={event => state.editService("credentialPath", event.target.value)} /></SettingsRow>}
      {state.service.authentication === "credential" && state.services.some(item => item.id === state.service.id) && !state.mcpNeedsMigration && <SettingsRow title="Credential binding"><SettingsButton variant="ghost" disabled={state.disabled || state.service.credentialRebind} onClick={() => state.rebindCredential()}>{state.service.credentialRebind ? "Rebinding on save" : "Rebind credential"}</SettingsButton></SettingsRow>}
      <SettingsRow title="Connection and tool discovery" description="Checking does not execute business tools; remote read-only labels don't become local authorization." footer={state.discovered && <SettingsNotice>Found {state.discovered.length} tools.</SettingsNotice>}>
        <SettingsButton disabled={state.disabled} onClick={() => void state.discover()}>Check connection</SettingsButton>
      </SettingsRow>
      <ServiceTools state={state} />
      {state.services.some(item => item.id === state.service.id) && <SettingsRow title="Service actions" description="This configuration is shared by all workspaces of this instance.">
        <SettingsButton variant="ghost" disabled={state.disabled || state.dirty} onClick={() => void state.changeService("remove")}>Delete service</SettingsButton>
        <SettingsButton variant="ghost" disabled={state.disabled || state.dirty || state.view!.settings.mcp?.version === 1} onClick={() => void state.changeService(state.service.enabled ? "disable" : "enable")}>{state.service.enabled ? "Disable" : "Enable"}</SettingsButton>
      </SettingsRow>}
    </div>
  );
}

function ComputerEditor({ state }: { state: PersonalSettingsPageState }) {
  return <>
    {state.mcpNeedsMigration && <SettingsGroup title="Configuration migration" description="Keeps the original services, credentials and call records; computer recovery can still continue.">
      <SettingsCard><SettingsRow title="Legacy configuration"><SettingsButton disabled={state.disabled || state.dirty} onClick={() => void state.changeService("migrate")}>Update MCP configuration</SettingsButton></SettingsRow></SettingsCard>
    </SettingsGroup>}
    <SettingsGroup title="Services" action={<SettingsButton variant="primary" onClick={() => void state.addCua()} disabled={state.disabled || state.dirty || state.view!.settings.mcp?.version === 1}><Plus />Add Linux desktop sandbox</SettingsButton>}>
      <SettingsList label="Computer services" empty="No Linux desktop sandbox configured yet.">
        {state.services.filter(service => service.cua).map(service => <SettingsListItem key={service.id} title={service.label} description={`Linux computer · ${service.cua!.sandbox} · ${service.tools.length} allowed tools`} expanded={state.editingService && state.service.id === service.id} toggleLabel={`${state.editingService && state.service.id === service.id ? "Collapse" : "Edit"} ${service.label}`} onToggle={() => { if (state.editingService && state.service.id === service.id) { if (!state.dirty) state.discard(); } else void state.selectService(service.id); }} details={state.editingService && state.service.id === service.id ? <ComputerDetails state={state} /> : undefined}>
          <SettingsTag>{service.enabled === false ? "Disabled" : "Enabled"}</SettingsTag>
        </SettingsListItem>)}
      </SettingsList>
      {state.editingService && !state.services.some(service => service.id === state.service.id) && <SettingsCard className="settings-import-preview"><ComputerDetails state={state} /></SettingsCard>}
      {state.view!.settings.mcp?.hasMore && <SettingsRow title="More services"><SettingsButton variant="ghost" disabled={state.disabled || state.dirty} onClick={() => void state.more()}>Load more services</SettingsButton></SettingsRow>}
    </SettingsGroup>
    <CuaControls state={state} />
  </>;
}

function ComputerDetails({ state }: { state: PersonalSettingsPageState }) {
  return (
    <div className="settings-provider-settings">
      <SettingsRow title="Linux desktop sandbox" description="A standalone remote Linux desktop environment." error={state.cuaIssues.length ? state.cuaIssues.map(issue => issue.message).join("; ") : undefined} />
      {state.cuaChoosing && <SettingsRow title="Existing sandboxes" description="Tools and permissions show once a target is chosen.">
        {state.cuaTargets.map((target, index) => <SettingsButton key={target.config.sandboxId} variant={state.service.cua?.sandboxId === target.config.sandboxId ? "secondary" : "ghost"} disabled={state.disabled} onClick={() => state.chooseCua(index)}>{target.label}</SettingsButton>)}
      </SettingsRow>}
      {(!state.cuaChoosing || state.service.cua) && <>
        <SettingsRow title="Service name" htmlFor="pa-computer-label" error={state.fieldErrors.label}><SettingsInput id="pa-computer-label" autoComplete="off" value={state.service.label} disabled={state.disabled} aria-invalid={!!state.fieldErrors.label} onChange={event => state.editService("label", event.target.value)} /></SettingsRow>
        {state.service.cua && <SettingsRow title="Sandbox" description={state.service.cua.sandbox} />}
        <SettingsRow title="Connection and tool discovery" description="Checking does not execute business tools." footer={state.discovered && <SettingsNotice>Found {state.discovered.length} tools.</SettingsNotice>}>
          <SettingsButton disabled={state.disabled} onClick={() => void state.discover()}>Check connection</SettingsButton>
        </SettingsRow>
        <ServiceTools state={state} />
      </>}
      {state.services.some(item => item.id === state.service.id) && <SettingsRow title="Computer actions">
        <SettingsButton variant="ghost" disabled={state.disabled || state.dirty} onClick={() => void state.changeService("remove")}>Delete service</SettingsButton>
        <SettingsButton variant="ghost" disabled={state.disabled || state.dirty || state.view!.settings.mcp?.version === 1} onClick={() => void state.changeService(state.service.enabled ? "disable" : "enable")}>{state.service.enabled ? "Disable" : "Enable"}</SettingsButton>
      </SettingsRow>}
    </div>
  );
}

const stages = { stopping: "Stop unverified", stopped: "Stopped, not yet saved", saving: "Save unverified", saved: "Saved", starting: "Start unverified", complete: "Completed" };

export function PersonalSettingsEditor({ state }: { state: PersonalSettingsPageState }) {
  const view = state.view;
  useEffect(() => { if (Object.keys(state.fieldErrors).length) document.querySelector<HTMLElement>('.settings-page [aria-invalid="true"]')?.focus(); }, [state.fieldErrors]);
  const title = state.category === "models" ? "Models" : state.category === "skills" ? "Skills" : state.category === "computer" ? "Computer" : "MCP";
  const description = state.category === "models" ? "Manage the Personal Agent's current model and credential references." : state.category === "skills" ? "Read skills from the PA backend account's $HOME/.agents/skills/." : state.category === "computer" ? "Manage the remote Linux desktop sandbox and computer recovery." : "Manage the Personal Agent's remote MCP services and credential references.";
  const adding = (state.category === "mcp" || state.category === "computer") && state.editingService && !state.services.some(service => service.id === state.service.id);
  const Page = adding ? SettingsSubpage : SettingsPage;
  return (
    <Page title={adding ? state.category === "computer" ? "Add Linux desktop sandbox" : "Add service" : title} description={description} onBack={() => state.discard()}>
      {state.reading && <SettingsNotice>Loading the remote archive and original service state…</SettingsNotice>}
      {view && <>
        {!view.settings.online && <SettingsNotice>The PA backend is offline; changes apply when the backend starts.</SettingsNotice>}
        {!!state.fileIssues.length && <SettingsNotice>The configuration file doesn't match the original save record. Keep the archive and verify the current file, restore it and read again; other configuration can still be managed.</SettingsNotice>}
        {view.pending && <SettingsGroup title={`Original maintenance: ${stages[view.pending.stage]}`}>
          <SettingsCard>
            <SettingsRow title="Save state" description={view.saved === true ? view.settings.online ? "Configuration saved; the effective state still needs verification." : "Configuration saved; the backend hasn't started." : view.saved === false ? "Not saved this time." : "Save outcome unverified; compare the current configuration with the original draft."}>
              <SettingsButton disabled={state.reading || state.phase === "saving"} onClick={() => void state.restore()}>Restore original service</SettingsButton>
              <SettingsButton variant="ghost" disabled={state.reading || state.phase === "saving"} onClick={() => void state.finish()}>Verified manually; end maintenance</SettingsButton>
            </SettingsRow>
          </SettingsCard>
        </SettingsGroup>}
        {state.operations.map(operation => <SettingsGroup key={operation.id} title={`${operation.target === "mcp" ? state.services.find(item => item.id === operation.scope)?.label ?? "MCP configuration" : operation.target === "model" ? "Model configuration" : "Skills configuration"} · ${operation.status === "waiting" ? "Awaiting effect" : operation.status === "failed" ? "Failed to take effect" : operation.status === "unknown" ? "Outcome unverified" : "Saved"}`}>
          <SettingsCard>
            <SettingsRow title="Original change">
              <SettingsButton disabled={state.reading || state.phase === "saving"} onClick={() => void state.checkOperation(operation.id)}>Verify original change</SettingsButton>
              {state.category !== "skills" && operation.status !== "unknown" && <SettingsButton variant="ghost" disabled={state.dirty || state.reading || state.phase === "saving"} onClick={() => void state.withdrawOperation(operation.id)}>Withdraw pending change</SettingsButton>}
            </SettingsRow>
          </SettingsCard>
        </SettingsGroup>)}
        {adding ? <SettingsGroup title="Services"><SettingsCard>{state.category === "computer" ? <ComputerDetails state={state} /> : <ServiceDetails state={state} />}</SettingsCard></SettingsGroup> : state.category === "models" ? <ModelEditor state={state} /> : state.category === "skills" ? <SkillsEditor state={state} /> : state.category === "computer" ? <ComputerEditor state={state} /> : <McpEditor state={state} />}
        {state.category !== "skills" && <SettingsGroup title="Actions">
          <SettingsCard>
            <SettingsRow title="Unsaved changes" description="Save or discard the current draft.">
              <SettingsButton variant="ghost" disabled={state.disabled || !state.dirty} onClick={() => state.discard()}>Discard changes</SettingsButton>
              <SettingsButton disabled={state.disabled || !state.writable || !state.dirty} onClick={() => void state.save()}>{state.phase === "saving" ? "Saving…" : "Save"}</SettingsButton>
            </SettingsRow>
          </SettingsCard>
        </SettingsGroup>}
      </>}
      {state.message && <SettingsNotice>{state.message}</SettingsNotice>}
      {(state.phase === "unknown" || state.phase === "error" || state.phase === "conflict" || state.fileIssues.length > 0) && <SettingsButton variant="ghost" disabled={state.reading || state.phase === "saving"} onClick={() => void state.read().then(read => { if (read && state.category === "computer") void state.readCua(); else if (read && state.category === "mcp") void state.readMcpOperations(); })}>Verify original configuration</SettingsButton>}
    </Page>
  );
}

export function PersonalSettingsPage({ settings, category, scope }: PersonalSettingsPageProps) {
  const key = `${scope.instanceId}:${category}`;
  const [state] = useState(() => settings.personalPages.get(key) ?? new PersonalSettingsPageState({ request: (...args) => window.ruukoto.request(...args) }, settings.changed, category));
  useEffect(() => {
    settings.form = state; void state.read().then(read => { if (read && category === "computer") void state.readCua(); else if (read && category === "mcp") void state.readMcpOperations(); });
    return () => settings.releasePersonalPage(key, state);
  }, [settings, state, key]);
  useEffect(() => {
    if (!state.needsRefresh) return;
    const timer = setTimeout(() => void state.read(), 2000);
    return () => clearTimeout(timer);
  });
  return <PersonalSettingsEditor state={state} />;
}
