import { useEffect, useState } from "react";
import { ChevronRight, Plus, Puzzle, RefreshCw } from "lucide-react";
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
  return <SettingsGroup title="当前模型" action={<SettingsButton variant="icon" aria-label="重新读取远端配置" title="重新读取远端配置" disabled={state.reading || state.phase === "saving"} onClick={() => void state.read()}><RefreshCw className={state.reading ? "animate-spin" : undefined} /></SettingsButton>}>
    <SettingsCard>
      <SettingsRow title="API 类型" htmlFor="pa-api"><SettingsSelect id="pa-api" value={state.model.api} disabled={state.disabled} onChange={event => state.editModel("api", event.target.value as typeof state.model.api)} options={apiOptions} /></SettingsRow>
      {([["baseUrl", "服务地址"], ["modelId", "模型标识"], ["contextWindow", "上下文上限"], ["maxTokens", "输出上限"], ["apiKeyEnv", "凭据环境变量引用"]] as const).map(([key, label]) => <TextSetting key={key} id={`pa-${key}`} title={label} value={state.model[key]} type={key === "contextWindow" || key === "maxTokens" ? "number" : "text"} disabled={state.disabled} invalid={!!state.fieldErrors[key]} description={key === "apiKeyEnv" ? "只存引用名，凭据由原后台环境提供。" : undefined} onChange={value => state.editModel(key, value)} />)}
      <SettingsRow title="图片输入" htmlFor="pa-image"><SettingsSwitch id="pa-image" checked={state.model.imageInput} disabled={state.disabled} onChange={event => state.editModel("imageInput", event.target.checked)} /></SettingsRow>
      <SettingsRow title="凭据状态" description="原后台环境状态。"><SettingsTag>{({ available: "原后台环境可用", missing: "原后台环境缺失", unverified: "原服务环境未核实" })[state.view?.settings.model?.credential.state ?? "unverified"]}</SettingsTag></SettingsRow>
      <SettingsRow title="连接测试" description="联网测试，可能产生费用。" footer={tested && state.test && <SettingsNotice>测试{state.test.status === "passed" ? "通过" : state.test.status === "failed" ? "失败" : "未核实"}。{state.test.message}</SettingsNotice>}>
        <SettingsButton disabled={state.disabled} onClick={() => { setTested(true); void state.testModel(); }}>测试当前模型</SettingsButton>
      </SettingsRow>
    </SettingsCard>
  </SettingsGroup>;
}

function SkillsEditor({ state }: { state: PersonalSettingsPageState }) {
  const library = state.view!.settings.skills;
  return <>
    <SettingsGroup title="全部技能" description={library.directory}>
      <SettingsSearch value={state.query} onChange={event => { state.query = event.target.value; state.changed(); }} placeholder="按名称检索" aria-label="检索技能" />
      <SettingsList label="技能列表" empty="没有可展示的技能。">
        {state.filtered.map(skill => <SettingsListItem key={skill.id} title={<span className="settings-title-with-icon"><Puzzle aria-hidden="true" />{skill.name}</span>} description={`${skill.description}${skill.explicitOnly ? " · 仅显式调用" : ""}`} />)}
      </SettingsList>
      {library.hasMore && <SettingsRow title="更多技能"><SettingsButton variant="ghost" disabled={state.disabled || state.dirty} onClick={() => void state.more()}>加载更多技能</SettingsButton></SettingsRow>}
    </SettingsGroup>
    {!!library.diagnostics.length && <SettingsGroup title="技能诊断"><div className="settings-notice"><ul>{library.diagnostics.map((item, index) => <li key={index}>{item}</li>)}</ul>{library.diagnosticsTruncated && <p>诊断已截断。</p>}</div></SettingsGroup>}
  </>;
}

function CuaControls({ state }: { state: PersonalSettingsPageState }) {
  if (!state.cua?.available && !state.cua?.operations.length && !state.services.some(service => service.cua)) return null;
  return <SettingsGroup title="电脑" action={<SettingsButton variant="icon" aria-label="刷新电脑状态" title="刷新电脑状态" disabled={state.disabled} onClick={() => void state.readCua()}><RefreshCw /></SettingsButton>}>
    <SettingsCard>
      {state.cua?.available && <SettingsRow title="运行状态" description={state.cua.paused ? state.cua.busy ? "正在暂停" : "已暂停" : "可用"}>
        <SettingsButton disabled={state.disabled || state.cua.paused && state.cua.busy} onClick={() => void state.controlCua(state.cua!.paused ? "resume" : "pause")}>{state.cua.paused ? "继续" : "暂停"}</SettingsButton>
      </SettingsRow>}
      {state.cua?.operations.map(item => <SettingsRow key={item.operation} title={`${item.service} · ${item.tool}`} description={item.effect === "effect_unknown" ? "结果待确认" : "连接已中断"} footer={<>
        {state.cuaImages.filter(image => image.operation === item.operation && image.observation === item.cuaObservation).map((image, index) => <img key={`${image.observation}:${image.id}`} src={image.src} alt={`恢复现场新截图 ${index + 1}`} style={{ maxWidth: "100%", height: "auto" }} onLoad={() => state.cuaImageLoaded(image.operation, image.observation, image.id, true)} onError={() => state.cuaImageLoaded(image.operation, image.observation, image.id, false)} />)}
      </>}>
        {item.cuaRecovery === "frozen" && <SettingsButton disabled={state.disabled} onClick={() => state.prepareCua("stop", item.operation)}>停止沙箱</SettingsButton>}
        {(item.cuaRecovery === "stopped" || item.cuaRecovery === "begun" || item.cuaRecovery === "observed") && <>
          <SettingsButton disabled={state.disabled} onClick={() => void state.controlCua("observe", item.operation)}>{item.cuaRecovery === "observed" ? "重新截图" : "检查并恢复"}</SettingsButton>
          {item.cuaRecovery === "observed" && !state.cuaImages.some(image => image.operation === item.operation && image.observation === item.cuaObservation) && <SettingsButton variant="ghost" disabled={state.disabled} onClick={() => void state.loadCuaImages(item.operation)}>查看截图</SettingsButton>}
        </>}
        {item.cuaRecovery === "observed" && <SettingsButton disabled={state.disabled || !state.canAcceptCua(item.operation, item.cuaObservation)} onClick={() => void state.controlCua("accept", item.operation)}>确认恢复</SettingsButton>}
      </SettingsRow>)}
    </SettingsCard>
    <Dialog open={!!state.cuaConfirmation} onOpenChange={open => { if (!open) state.cancelCua(); }}><DialogContent className="demo-dialog"><DialogHeader><DialogTitle>停止沙箱？</DialogTitle><DialogDescription>未保存的应用状态会丢失，磁盘文件保留。</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="ghost" onClick={() => state.cancelCua()}>取消</Button><Button type="button" disabled={state.disabled} onClick={() => void state.confirmCua()}>停止沙箱</Button></DialogFooter></DialogContent></Dialog>
  </SettingsGroup>;
}

function ServiceTools({ state }: { state: PersonalSettingsPageState }) {
  const tools = new Map([...state.service.tools, ...(state.discovered ?? [])].map(tool => [tool.name, tool]));
  const effects = { read: "只读", write: "写入", unknown: "副作用不明" } as const;
  const effectOptions = [{ value: "blocked", label: "不允许" }, { value: "read", label: "只读" }, { value: "write", label: "写入" }, { value: "unknown", label: "副作用不明" }];
  return <SettingsGroup title="允许的工具">
    <SettingsCard>
      {[...tools.values()].map((tool, index) => {
        const allowed = state.service.tools.some(item => item.name === tool.name);
        const selection = allowed ? state.service.toolEffects[tool.name] ?? "unknown" : "blocked";
        return state.service.cua
          ? <SettingsRow key={tool.name} title={tool.name} description={tool.description} htmlFor={`pa-tool-${index}`}><SettingsSwitch id={`pa-tool-${index}`} checked={allowed} disabled={state.disabled} onChange={event => state.allowTool(tool, event.target.checked)} /></SettingsRow>
          : <SettingsRow key={tool.name} title={tool.name} description={tool.description} htmlFor={`pa-tool-${index}`}><SettingsSelect id={`pa-tool-${index}`} value={selection} disabled={state.disabled || state.mcpNeedsMigration} onChange={event => { const value = event.target.value; if (value === "blocked") state.allowTool(tool, false); else { if (!allowed) state.allowTool(tool, true); state.toolEffect(tool.name, value as keyof typeof effects); } }} options={effectOptions} /></SettingsRow>;
      })}
    </SettingsCard>
  </SettingsGroup>;
}

function McpOperations({ state }: { state: PersonalSettingsPageState }) {
  return <SettingsGroup title="调用" action={<SettingsButton variant="icon" aria-label={state.mcpEndPending === null ? "刷新 MCP 调用" : "核实原调用收尾"} disabled={state.disabled} onClick={() => void state.readMcpOperations()}><RefreshCw /></SettingsButton>}>
    <SettingsCard>
      {state.mcpOperations.filter(item => !item.cuaRecovery && (item.effect === "effect_unknown" || item.ended)).map(item => <SettingsRow key={item.operation} title={`${item.service} · ${item.tool}`} description={item.ended ? "已人工收尾，结果仍未知" : "结果未知"}><SettingsButton disabled={state.disabled} onClick={() => void state.readMcpOperation(item.operation)}>查看原调用</SettingsButton></SettingsRow>)}
      {state.mcpNextOffset !== undefined && <SettingsRow title="更多调用"><SettingsButton variant="ghost" disabled={state.disabled} onClick={() => void state.readMcpOperations(true)}>加载更多调用</SettingsButton></SettingsRow>}
      {state.mcpDetail && <SettingsRow title={`${state.mcpDetail.summary.service} · ${state.mcpDetail.summary.tool}`} footer={<pre className="settings-code-block">{state.mcpDetail.text}</pre>}>
        {state.mcpDetail.nextOffset !== undefined && <SettingsButton variant="ghost" disabled={state.disabled} onClick={() => void state.readMcpOperation(state.mcpDetail!.summary.operation, true)}>下一页原调用</SettingsButton>}
        {state.mcpDetail.summary.canEnd && !state.mcpDetail.summary.ended && !state.mcpDetail.summary.cuaRecovery && <SettingsButton disabled={state.disabled || state.mcpEndPending !== null} onClick={() => state.prepareMcpEnd(state.mcpDetail!.summary.operation)}>结束此工作，保留结果未知</SettingsButton>}
      </SettingsRow>}
    </SettingsCard>
    <Dialog open={state.mcpEndConfirmation !== null} onOpenChange={open => { if (!open) state.cancelMcpEnd(); }}><DialogContent className="demo-dialog"><DialogHeader><DialogTitle>结束此工作？</DialogTitle><DialogDescription>保留原调用结果未知；本地执行停止核实后，原工作将发送最终报告。</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="ghost" onClick={() => state.cancelMcpEnd()}>取消</Button><Button type="button" disabled={state.disabled} onClick={() => void state.confirmMcpEnd()}>结束此工作，保留结果未知</Button></DialogFooter></DialogContent></Dialog>
  </SettingsGroup>;
}

function McpEditor({ state }: { state: PersonalSettingsPageState }) {
  const editing = state.editingService;
  return <>
    {state.mcpNeedsMigration && <SettingsGroup title="配置迁移" description="保留服务、凭据与旧调用；旧普通工具的副作用默认为不明。">
      <SettingsCard><SettingsRow title="旧版配置"><SettingsButton disabled={state.disabled || state.dirty} onClick={() => state.prepareService("migrate")}>更新 MCP 配置</SettingsButton></SettingsRow></SettingsCard>
    </SettingsGroup>}
    <SettingsGroup title="服务" action={<SettingsButton onClick={() => void state.selectService(null)} disabled={state.disabled || state.dirty || state.mcpNeedsMigration}><Plus />添加服务</SettingsButton>}>
      <SettingsList label="MCP 服务" empty="尚未配置 HTTP 服务。">
        {state.services.filter(service => !service.cua).map(service => <SettingsListItem key={service.id} title={service.label} description={`${service.endpoint} · ${({ anonymous: "匿名", valid: "已配置凭据", missing: "凭据缺失", invalid: "凭据无效", "not-applicable": "本地" })[service.credentialStatus ?? "anonymous"]} · ${service.tools.length} 个允许工具`} details={editing && state.service.id === service.id ? <ServiceDetails state={state} /> : undefined}>
          <SettingsTag>{service.enabled === false ? "已停用" : "已启用"}</SettingsTag>
          <SettingsButton variant="ghost" onClick={() => void state.selectService(service.id)} aria-expanded={editing && state.service.id === service.id} aria-label={`编辑 ${service.label}`}><ChevronRight /></SettingsButton>
        </SettingsListItem>)}
      </SettingsList>
      {editing && !state.services.some(service => service.id === state.service.id) && <SettingsCard className="settings-import-preview"><ServiceDetails state={state} /></SettingsCard>}
      {state.view!.settings.mcp?.hasMore && <SettingsRow title="更多服务"><SettingsButton variant="ghost" disabled={state.disabled || state.dirty} onClick={() => void state.more()}>加载更多服务</SettingsButton></SettingsRow>}
    </SettingsGroup>
    <McpOperations state={state} />
  </>;
}

function ServiceDetails({ state }: { state: PersonalSettingsPageState }) {
  return (
    <div className="settings-provider-settings">
      <SettingsRow title="编辑服务" description="配置 MCP HTTP 服务与允许的工具。" />
      <SettingsRow title="服务名称" htmlFor="pa-mcp-label"><SettingsInput id="pa-mcp-label" autoComplete="off" value={state.service.label} disabled={state.disabled} aria-invalid={!!state.fieldErrors.label} onChange={event => state.editService("label", event.target.value)} /></SettingsRow>
      {state.fieldErrors.label && <SettingsRow title="" description={state.fieldErrors.label} />}
      <SettingsRow title="HTTPS 端点" htmlFor="pa-mcp-endpoint"><SettingsInput id="pa-mcp-endpoint" autoComplete="off" value={state.service.endpoint} disabled={state.disabled} aria-invalid={!!state.fieldErrors.endpoint} onChange={event => state.editService("endpoint", event.target.value)} /></SettingsRow>
      {state.fieldErrors.endpoint && <SettingsRow title="" description={state.fieldErrors.endpoint} />}
      <SettingsRow title="认证方式" htmlFor="pa-mcp-auth"><SettingsSelect id="pa-mcp-auth" value={state.service.authentication} disabled={state.disabled} onChange={event => state.editService("authentication", event.target.value as typeof state.service.authentication)} options={[{ value: "anonymous", label: "显式匿名" }, { value: "credential", label: "远端私有凭据文件" }]} /></SettingsRow>
      {state.fieldErrors.authentication && <SettingsRow title="" description={state.fieldErrors.authentication} />}
      {state.service.authentication === "credential" && <SettingsRow title="远端私有凭据文件" description="引用无效不降级匿名，保存时可重新绑定。" htmlFor="pa-mcp-credential"><SettingsInput id="pa-mcp-credential" value={state.service.credentialPath} disabled={state.disabled} autoComplete="off" aria-invalid={!!state.fieldErrors.credentialPath} onChange={event => state.editService("credentialPath", event.target.value)} /></SettingsRow>}
      {state.fieldErrors.credentialPath && <SettingsRow title="" description={state.fieldErrors.credentialPath} />}
      {state.service.authentication === "credential" && state.services.some(item => item.id === state.service.id) && !state.mcpNeedsMigration && <SettingsRow title="凭据绑定"><SettingsButton variant="ghost" disabled={state.disabled || state.service.credentialRebind} onClick={() => state.rebindCredential()}>{state.service.credentialRebind ? "保存时重新绑定" : "重新绑定凭据"}</SettingsButton></SettingsRow>}
      <SettingsRow title="连接与工具发现" description="检查不执行业务工具，远端只读标注不自动成为本地授权。" footer={state.discovered && <SettingsNotice>发现 {state.discovered.length} 个工具，未发起真实连接。</SettingsNotice>}>
        <SettingsButton disabled={state.disabled} onClick={() => void state.discover()}>检查连接</SettingsButton>
      </SettingsRow>
      <ServiceTools state={state} />
      {state.services.some(item => item.id === state.service.id) && <SettingsRow title="服务操作" description="本实例的全部工作区共用此配置。">
        <SettingsButton variant="ghost" disabled={state.disabled || state.dirty} onClick={() => state.prepareService("remove")}>删除服务</SettingsButton>
        <SettingsButton variant="ghost" disabled={state.disabled || state.dirty || state.view!.settings.mcp?.version === 1} onClick={() => state.prepareService(state.service.enabled ? "disable" : "enable")}>{state.service.enabled ? "停用" : "启用"}</SettingsButton>
      </SettingsRow>}
    </div>
  );
}

function ComputerEditor({ state }: { state: PersonalSettingsPageState }) {
  return <>
    {state.mcpNeedsMigration && <SettingsGroup title="配置迁移" description="保留原服务、凭据与调用记录，电脑恢复仍可继续。">
      <SettingsCard><SettingsRow title="旧版配置"><SettingsButton disabled={state.disabled || state.dirty} onClick={() => state.prepareService("migrate")}>更新 MCP 配置</SettingsButton></SettingsRow></SettingsCard>
    </SettingsGroup>}
    <SettingsGroup title="服务" action={<SettingsButton onClick={() => void state.addCua()} disabled={state.disabled || state.dirty || state.view!.settings.mcp?.version === 1}><Plus />添加 Linux 桌面沙箱</SettingsButton>}>
      <SettingsList label="电脑服务" empty="尚未配置 Linux 桌面沙箱。">
        {state.services.filter(service => service.cua).map(service => <SettingsListItem key={service.id} title={service.label} description={`Linux 电脑 · ${service.cua!.sandbox} · ${service.tools.length} 个允许工具`} details={state.editingService && state.service.id === service.id ? <ComputerDetails state={state} /> : undefined}>
          <SettingsTag>{service.enabled === false ? "已停用" : "已启用"}</SettingsTag>
          <SettingsButton variant="ghost" onClick={() => void state.selectService(service.id)} aria-expanded={state.editingService && state.service.id === service.id} aria-label={`编辑 ${service.label}`}><ChevronRight /></SettingsButton>
        </SettingsListItem>)}
      </SettingsList>
      {state.editingService && !state.services.some(service => service.id === state.service.id) && <SettingsCard className="settings-import-preview"><ComputerDetails state={state} /></SettingsCard>}
      {state.view!.settings.mcp?.hasMore && <SettingsRow title="更多服务"><SettingsButton variant="ghost" disabled={state.disabled || state.dirty} onClick={() => void state.more()}>加载更多服务</SettingsButton></SettingsRow>}
    </SettingsGroup>
    <CuaControls state={state} />
  </>;
}

function ComputerDetails({ state }: { state: PersonalSettingsPageState }) {
  return (
    <div className="settings-provider-settings">
      <SettingsRow title="Linux 桌面沙箱" description="远端独立 Linux 桌面环境。" />
      {state.cuaChoosing && <SettingsRow title="既有沙箱" description="选择目标后展示工具与权限配置。">
        {state.cuaTargets.map((target, index) => <SettingsButton key={target.config.sandboxId} variant={state.service.cua?.sandboxId === target.config.sandboxId ? "secondary" : "ghost"} disabled={state.disabled} onClick={() => state.chooseCua(index)}>{target.label}</SettingsButton>)}
      </SettingsRow>}
      {state.cuaIssues.map((issue, index) => <SettingsRow key={index} title="" description={issue.message} />)}
      {(!state.cuaChoosing || state.service.cua) && <>
        <SettingsRow title="服务名称" htmlFor="pa-computer-label"><SettingsInput id="pa-computer-label" autoComplete="off" value={state.service.label} disabled={state.disabled} aria-invalid={!!state.fieldErrors.label} onChange={event => state.editService("label", event.target.value)} /></SettingsRow>
        {state.fieldErrors.label && <SettingsRow title="" description={state.fieldErrors.label} />}
        {state.service.cua && <SettingsRow title="沙箱" description={state.service.cua.sandbox} />}
        <SettingsRow title="连接与工具发现" description="检查不执行业务工具。" footer={state.discovered && <SettingsNotice>发现 {state.discovered.length} 个工具。</SettingsNotice>}>
          <SettingsButton disabled={state.disabled} onClick={() => void state.discover()}>检查连接</SettingsButton>
        </SettingsRow>
        <ServiceTools state={state} />
      </>}
      {state.services.some(item => item.id === state.service.id) && <SettingsRow title="电脑操作" description="启停只更新演示状态。">
        <SettingsButton variant="ghost" disabled={state.disabled || state.dirty} onClick={() => state.prepareService("remove")}>删除服务</SettingsButton>
        <SettingsButton variant="ghost" disabled={state.disabled || state.dirty || state.view!.settings.mcp?.version === 1} onClick={() => state.prepareService(state.service.enabled ? "disable" : "enable")}>{state.service.enabled ? "停用" : "启用"}</SettingsButton>
      </SettingsRow>}
    </div>
  );
}

const stages = { stopping: "停止待核实", stopped: "已停止，尚未保存", saving: "保存待核实", saved: "已保存", starting: "启动待核实", complete: "已完成" };

export function PersonalSettingsEditor({ state, onConnection }: { state: PersonalSettingsPageState; onConnection: () => void }) {
  const view = state.view;
  useEffect(() => { if (Object.keys(state.fieldErrors).length) document.querySelector<HTMLElement>('.settings-page [aria-invalid="true"]')?.focus(); }, [state.fieldErrors]);
  const title = state.category === "models" ? "模型" : state.category === "skills" ? "Skills" : state.category === "computer" ? "电脑" : "MCP";
  const description = state.category === "models" ? "管理 Personal Agent 的当前模型与凭据引用。" : state.category === "skills" ? "从 PA 后台账户的 $HOME/.agents/skills/ 读取技能。" : state.category === "computer" ? "管理远端 Linux 桌面沙箱与电脑操作恢复。" : "管理 Personal Agent 的远端 MCP 服务与凭据引用。";
  return (
    <SettingsPage title={title} description={description}>
      <div className="settings-row-control"><SettingsButton variant="ghost" disabled={state.phase === "saving" || state.phase === "unknown"} onClick={onConnection}>PA 远程连接</SettingsButton></div>
      {state.reading && <SettingsNotice>正在读取远端档案与原服务状态…</SettingsNotice>}
      {view && <>
        <SettingsRow title="档案状态" description={`${view.settings.profile.directory} · ${view.settings.online ? "在线" : "离线"}${!state.writable ? " · 只读" : ""}`} />
        {(state.category !== "mcp" && state.category !== "computer" || !state.writable) && <SettingsRow title="维护原因" description={view.maintenance.reason} />}
        {!!state.fileIssues.length && <SettingsNotice>配置文件与原保存记录不符。请保留档案并核实当前文件，恢复原文件后重新读取；其他配置仍可管理。</SettingsNotice>}
        {view.pending && <SettingsGroup title={`原维护：${stages[view.pending.stage]}`}>
          <SettingsCard>
            <SettingsRow title="保存状态" description={view.saved === true ? view.settings.online ? "配置已保存，生效状态仍需核实。" : "配置已保存，后台尚未启动。" : view.saved === false ? "本次未保存。" : "保存结果待核实，请比较当前配置与原草稿。"}>
              <SettingsButton disabled={state.reading || state.phase === "saving"} onClick={() => void state.restore()}>恢复原服务</SettingsButton>
              <SettingsButton variant="ghost" disabled={state.reading || state.phase === "saving"} onClick={() => void state.finish()}>已人工核实，结束维护</SettingsButton>
            </SettingsRow>
          </SettingsCard>
        </SettingsGroup>}
        {state.operations.map(operation => <SettingsGroup key={operation.id} title={`${operation.target === "mcp" ? state.services.find(item => item.id === operation.scope)?.label ?? "MCP 配置" : operation.target === "model" ? "模型配置" : "技能配置"} · ${operation.status === "waiting" ? "等待生效" : operation.status === "failed" ? "生效失败" : operation.status === "unknown" ? "结果待核实" : "已保存"}`}>
          <SettingsCard>
            <SettingsRow title="原更改">
              <SettingsButton disabled={state.reading || state.phase === "saving"} onClick={() => void state.checkOperation(operation.id)}>核实原更改</SettingsButton>
              {state.category !== "skills" && operation.status !== "unknown" && <SettingsButton variant="ghost" disabled={state.dirty || state.reading || state.phase === "saving"} onClick={() => void state.withdrawOperation(operation.id)}>撤回待生效更改</SettingsButton>}
            </SettingsRow>
          </SettingsCard>
        </SettingsGroup>)}
        {state.category === "models" ? <ModelEditor state={state} /> : state.category === "skills" ? <SkillsEditor state={state} /> : state.category === "computer" ? <ComputerEditor state={state} /> : <McpEditor state={state} />}
        {state.phase === "conflict" && <SettingsGroup title="当前远端配置（原草稿保留）">
          <SettingsCard>
            <SettingsRow title="配置" footer={<pre className="settings-code-block">{JSON.stringify(state.category === "models" ? view.settings.model?.config : state.category === "skills" ? view.settings.skills.directory : view.settings.mcp?.services.map(service => ({ name: service.label, endpoint: service.cua ? `Linux 电脑 ${service.cua.sandbox}` : service.endpoint, enabled: service.enabled })), null, 2)}</pre>} />
            <SettingsRow title="" description="不会自动覆盖；放弃更改后以当前配置继续。" />
          </SettingsCard>
        </SettingsGroup>}
        {state.category !== "skills" && <SettingsGroup title="操作">
          <SettingsCard>
            <SettingsRow title="未保存的更改" description="保存或放弃当前草稿。">
              <SettingsButton variant="ghost" disabled={state.disabled || !state.dirty} onClick={() => state.discard()}>放弃更改</SettingsButton>
              <SettingsButton disabled={state.disabled || !state.writable || !state.dirty || state.phase === "conflict"} onClick={() => void state.save()}>查看保存影响</SettingsButton>
            </SettingsRow>
          </SettingsCard>
        </SettingsGroup>}
      </>}
      {state.message && <SettingsNotice>{state.message}</SettingsNotice>}
      <Dialog open={!!state.confirmation} onOpenChange={open => { if (!open) state.cancelConfirmation(); }}><DialogContent className="demo-dialog"><DialogHeader><DialogTitle>保存更改？</DialogTitle><DialogDescription>Personal · {view?.settings.profile.directory}。{state.confirmation?.label}</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="ghost" onClick={() => state.cancelConfirmation()}>继续编辑</Button><Button type="button" disabled={state.disabled || !state.writable} onClick={() => void state.confirmApply()}>保存更改</Button></DialogFooter></DialogContent></Dialog>
    </SettingsPage>
  );
}

export function PersonalSettingsPage({ settings, category }: PersonalSettingsPageProps) {
  const [state] = useState(() => new PersonalSettingsPageState({ request: (...args) => window.ruukoto.request(...args) }, settings.changed, category));
  useEffect(() => { settings.form = state; void state.read(); return () => { state.invalidate(); if (settings.form === state) settings.form = null; }; }, [settings, state]);
  return <PersonalSettingsEditor state={state} onConnection={() => settings.chooseCategory("personal")} />;
}
