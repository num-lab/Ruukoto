import { useEffect, useState } from "react";
import type { Components } from "streamdown";
import { Plus, Puzzle, RefreshCw, Search } from "lucide-react";
import type { SettingsPageProps } from "./settings-dialog.tsx";
import { CodeSkillsState } from "./code-skills-state.ts";
import { MarkdownText } from "./markdown.tsx";
import { SettingsSection } from "./settings-ui.tsx";
import { Button } from "./components/ui/button.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "./components/ui/field.tsx";
import { Input } from "./components/ui/input.tsx";

const impact = "停用或移除从后续新任务选择起生效，也阻止新的显式调用；已钉版任务及原恢复引用继续可读，历史正文保留。移除只隐藏可用项，包字节保留供旧引用读取。";

const skillComponents: Components = { a: ({ href, children }) => href && /^https?:\/\//i.test(href) ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <span>{children}</span> };

export function SkillBody({ body }: { body: string }) {
  return <div className="file-markdown selectable-text skills-body"><MarkdownText mode="static" components={skillComponents}>{body}</MarkdownText></div>;
}

export function CodeSkillsEditor({ state }: { state: CodeSkillsState }) {
  const [confirmation, setConfirmation] = useState<{ id: string; action: "enable" | "disable" | "remove" } | null>(null);
  const confirm = async () => {
    const action = confirmation; setConfirmation(null);
    if (!action || action.id !== state.selectedId) return;
    if (action.action === "remove") await state.remove();
    else await state.setEnabled(action.action === "enable");
  };
  const detail = state.detail;
  return <div className="model-settings skills-settings" aria-label="Code Skills 管理" aria-busy={state.reading || state.choosing || state.phase === "saving"}>
    <div className="skills-toolbar">
      <div className="skills-search"><Search /><Input aria-label="按名称检索" placeholder="检索技能" value={state.query} onChange={event => { state.query = event.target.value; state.changed(); }} /></div>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={state.pending ? "核实原操作结果" : "重新读取技能"} title={state.pending ? "核实原操作结果" : "重新读取技能"} disabled={!state.connected || state.reading || state.choosing || state.phase === "saving"} onClick={() => void state.read()}><RefreshCw /></Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={state.preview ? "重新选择技能目录" : "导入技能目录"} title={state.preview ? "重新选择技能目录" : "导入技能目录"} disabled={state.disabled} onClick={() => void state.choose()}><Plus /></Button>
    </div>
    {!state.connected && <p role="status">Code 已离线或实例已变化，请恢复原实例后读取；原操作不会改发到新实例。</p>}
    {state.phase === "loading" && <p role="status">正在读取技能…</p>}
    {state.choosing && <p role="status">正在选择并预览目录，尚未导入。</p>}
    <div className="skills-group">
      <h3>全部技能<span className="skills-count">{state.filtered.length}</span></h3>
      {state.filtered.length ? <ul className="skills-list" aria-label="技能列表">{state.filtered.map(skill => <li key={skill.id}><Button type="button" variant="ghost" className="skills-list-button" aria-pressed={state.selectedId === skill.id} disabled={state.disabled || state.dirty} onClick={() => void state.select(skill.id)}><span className="skills-icon" aria-hidden="true"><Puzzle /></span><span className="skills-copy"><span className="skills-title"><span className="skills-name">{skill.name}</span><Badge variant="secondary">{skill.source === "managed" ? "托管副本" : "外部维护"}</Badge>{skill.explicitOnly && <Badge variant="secondary">仅显式调用</Badge>}</span><span className="skills-description">{skill.description}</span></span>{skill.state === "disabled" && <span className="skills-state">已停用</span>}</Button></li>)}</ul> : state.phase !== "loading" && <p role="status">{state.query ? "已取得的列表中没有匹配名称。" : "没有可展示的技能。"}</p>}
      {state.hasMore && <Button type="button" variant="outline" size="sm" disabled={state.disabled} onClick={() => void state.read(true)}>加载更多技能</Button>}
    </div>
    {!!state.diagnostics.length && <SettingsSection title="技能诊断"><ul>{state.diagnostics.map((diagnostic, index) => <li key={index}>{diagnostic}</li>)}</ul>{state.diagnosticsTruncated && <FieldDescription>诊断已截断。</FieldDescription>}</SettingsSection>}
    {state.preview && <SettingsSection title="导入预览"><FieldGroup><Field><FieldLabel>{state.preview.name}</FieldLabel><FieldDescription>{state.preview.description}</FieldDescription><p>{state.preview.files} 个文件 · {state.preview.bytes} 字节{state.preview.explicitOnly && " · 仅显式调用"}</p><FieldDescription>复制到本地托管区，源目录保持原样；技能不增加工具或权限。</FieldDescription></Field>{state.preview.diagnostics.map((diagnostic, index) => <p key={index}>{diagnostic}</p>)}{!!state.preview.conflicts.length && <p role="alert">与当前来源重名，无法覆盖：{state.preview.conflicts.map(skill => `${skill.name}（${skill.source === "managed" ? "托管副本" : "外部维护"}）`).join("、")}。请修改源包名称后重新选择。</p>}{state.phase === "conflict" && <p>预览仍保留；下方与列表展示当前状态。比较后重新选择目录。</p>}<div className="model-settings-actions"><Button type="button" variant="ghost" size="sm" disabled={state.disabled} onClick={() => state.discard()}>取消导入</Button><Button type="button" size="sm" disabled={state.disabled || state.previewStale || !!state.preview.conflicts.length} onClick={() => void state.save()}>确认导入</Button></div></FieldGroup></SettingsSection>}
    {detail && <SettingsSection title={detail.name}><div className="model-settings-actions"><Badge variant="secondary">{detail.source === "managed" ? "托管副本" : "外部维护"}</Badge><span>{detail.state === "removed" ? "已逻辑移除，旧引用仍可读" : detail.state === "disabled" ? "已停用" : "已启用"}{detail.explicitOnly && " · 仅显式调用"}</span></div><p>{detail.description}</p>{detail.readOnly ? <FieldDescription>由原技能库维护，请在来源处处理诊断或变更。</FieldDescription> : detail.state !== "removed" && <div className="model-settings-actions"><Button type="button" variant="outline" size="sm" disabled={state.disabled || state.dirty} onClick={() => setConfirmation({ id: detail.id, action: detail.state === "enabled" ? "disable" : "enable" })}>{detail.state === "enabled" ? "停用" : "启用"}</Button><Button type="button" variant="ghost" size="sm" disabled={state.disabled || state.dirty} onClick={() => setConfirmation({ id: detail.id, action: "remove" })}>移除</Button></div>}<SkillBody body={detail.body} /></SettingsSection>}
    {state.message && <p className="model-settings-notice" role="status">{state.message}</p>}
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open) setConfirmation(null); }}><DialogContent className="demo-dialog"><DialogHeader><DialogTitle>确认{confirmation?.action === "remove" ? "移除" : confirmation?.action === "enable" ? "启用" : "停用"}技能</DialogTitle><DialogDescription>作用范围：本地 Code · {detail?.name}。{confirmation?.action === "enable" ? "启用后供新任务选择；仅显式调用属性保持原样。" : impact}</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="ghost" onClick={() => setConfirmation(null)}>取消</Button><Button type="button" disabled={state.disabled || state.dirty || confirmation?.id !== state.selectedId} onClick={() => void confirm()}>确认</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}

function CodeSkillsForm({ settings, scope, code }: SettingsPageProps) {
  const [state] = useState(() => new CodeSkillsState({ request: (...args) => window.ruukoto.request(...args), pickSkillFolder: (...args) => window.ruukoto.pickSkillFolder(...args) }, settings.changed, scope.instanceId!, () => ({ instanceId: code.view.instanceId, online: code.status.state === "online" })));
  useEffect(() => { settings.form = state; void state.read(); return () => { state.invalidate(); if (settings.form === state) settings.form = null; }; }, [settings, state]);
  return <CodeSkillsEditor state={state} />;
}

export function CodeSkillsSettings(props: SettingsPageProps) {
  if (props.settings.form instanceof CodeSkillsState && props.settings.form.pending) return <CodeSkillsForm {...props} />;
  if (!props.scope.instanceId) return <FieldDescription role="status">Code 已离线，请恢复连接后管理技能。</FieldDescription>;
  return <CodeSkillsForm {...props} />;
}
