import { useEffect, useState } from "react";
import type { SettingsState } from "./settings-state.ts";
import { PersonalConnectionState } from "./personal-connection-state.ts";
import { PersonalManagementState } from "./personal-management-state.ts";
import { Button } from "./components/ui/button.tsx";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "./components/ui/field.tsx";
import { Input } from "./components/ui/input.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs.tsx";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select.tsx";

export function PersonalConnectionSettings({ settings }: { settings: SettingsState }) {
  const [kind, setKind] = useState("management");
  return <Tabs value={kind} onValueChange={value => settings.navigate(() => setKind(value))} className="settings-target-tabs"><TabsList aria-label="PA 连接用途"><TabsTrigger value="management">设置管理</TabsTrigger><TabsTrigger value="legacy">旧聊天连接</TabsTrigger></TabsList><TabsContent value="management"><PersonalManagementSettings settings={settings} /></TabsContent><TabsContent value="legacy"><LegacyPersonalConnectionSettings settings={settings} /></TabsContent></Tabs>;
}

function PersonalManagementSettings({ settings }: { settings: SettingsState }) {
  const [state] = useState(() => new PersonalManagementState(window.ruukoto, settings.changed));
  useEffect(() => { settings.form = state; void state.read(); return () => { state.invalidate(); if (settings.form === state) settings.form = null; }; }, [settings, state]);
  useEffect(() => { const key = Object.keys(state.fieldErrors)[0]; if (key) document.getElementById(`management-${key}`)?.focus(); }, [state.fieldErrors]);
  const config = state.draft, view = state.view;
  return <form aria-label="PA 设置管理连接" aria-busy={state.phase === "saving"} onSubmit={event => { event.preventDefault(); void state.save(); }}><FieldGroup>
    <FieldDescription>通过同账户 SSH 管理新 Personal 档案。检测只读取配置；模型、Skills 与 MCP 页面使用此连接。</FieldDescription>
    {([['host', 'SSH 主机别名'], ['profileDir', '远端个人档案']] as const).map(([key, label]) => <Field key={key} data-invalid={!!state.fieldErrors[key]} data-disabled={state.disabled}><FieldLabel htmlFor={`management-${key}`}>{label}</FieldLabel><Input id={`management-${key}`} value={config[key]} onChange={event => state.edit(key, event.target.value)} disabled={state.disabled} autoComplete="off" autoCapitalize="none" spellCheck={false} required aria-invalid={!!state.fieldErrors[key]} aria-describedby={`management-${key}-help`} /><FieldDescription id={`management-${key}-help`}>{state.fieldErrors[key] || (key === "host" ? "用户名、端口与密钥由本机 SSH 配置管理。" : "选择远端 durable 档案，不能使用旧控制目录或本机路径。")}</FieldDescription></Field>)}
    <Field data-disabled={state.disabled}><FieldLabel htmlFor="management-program">程序位置</FieldLabel><Select value={config.program} onValueChange={value => state.edit("program", value)} disabled={state.disabled}><SelectTrigger id="management-program"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{["/opt/ruukoto/apps/ruukoto/bin/ruukoto.mjs", "/usr/local/bin/ruukoto"].map(program => <SelectItem key={program} value={program}>{program}{state.programs.includes(program) ? "（已检测）" : ""}</SelectItem>)}</SelectGroup></SelectContent></Select><FieldDescription>先检测，再选择远端已经安装的新 Personal 程序。</FieldDescription></Field>
    <Field data-disabled={state.disabled}><FieldLabel htmlFor="management-lifecycle">启动方式</FieldLabel><Select value={config.lifecycle} onValueChange={value => state.edit("lifecycle", value)} disabled={state.disabled}><SelectTrigger id="management-lifecycle"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="systemd">系统服务 ruukoto-backend</SelectItem><SelectItem value="cli">CLI 脱离后台</SelectItem><SelectItem value="development">受管开发实例</SelectItem></SelectGroup></SelectContent></Select><FieldDescription>CLI 原启动环境未核实、开发实例或缺部署权限时只读。系统服务需要管理员先配置精确启停权限与优雅停止策略。</FieldDescription></Field>
    <Field orientation="horizontal"><Button type="button" size="sm" variant="outline" disabled={state.disabled} onClick={() => void state.detect()}>检测程序</Button><Button type="submit" size="sm" disabled={state.disabled || !state.dirty}>保存连接</Button><Button type="button" size="sm" variant="ghost" disabled={!state.loaded || state.dirty || state.phase === "saving"} onClick={() => void state.inspect()}>核实档案与服务</Button></Field>
    {view && <><FieldDescription>档案：{view.settings.profile.directory} · {view.settings.online ? "后台在线" : "后台离线"} · {view.maintenance.writable && view.settings.online ? "支持显式停存启" : "只读"}。{view.maintenance.reason}</FieldDescription>{view.pending && <><FieldDescription>原维护阶段：{({ stopping: "停止待核实", stopped: "已停止，未保存", saving: "保存待核实", saved: "已保存", starting: "启动待核实", complete: "已完成" })[view.pending.stage]}。{view.saved === true ? "已保存事实保留。" : view.saved === null ? "请比较当前配置与原草稿。" : "本次未保存。"}</FieldDescription><Field orientation="horizontal"><Button type="button" size="sm" disabled={state.phase === "saving"} onClick={() => void state.inspect("restore")}>恢复原服务</Button><Button type="button" size="sm" variant="outline" disabled={state.phase === "saving"} onClick={() => void state.inspect("finish")}>已人工核实，结束维护</Button></Field></>}</>}
    <FieldDescription role="status">{state.message || "连接保存在本机，远端离线时也可编辑。"}</FieldDescription>
    {(!state.loaded || state.phase === "unknown") && <Button type="button" size="sm" variant="ghost" onClick={() => void state.read()}>核实本机连接</Button>}
  </FieldGroup></form>;
}

function LegacyPersonalConnectionSettings({ settings }: { settings: SettingsState }) {
  const [state] = useState(() => new PersonalConnectionState(window.ruukoto, settings.changed));
  useEffect(() => {
    settings.form = state; void state.read();
    return () => { state.invalidate(); if (settings.form === state) settings.form = null; };
  }, [settings, state]);
  useEffect(() => {
    const field = Object.keys(state.fieldErrors)[0];
    if (field) document.getElementById(field === "host" ? "personal-host" : "personal-control-dir")?.focus();
  }, [state.fieldErrors]);
  return <form aria-label="PA 远程连接" aria-busy={state.reading || state.phase === "saving"} onSubmit={event => { event.preventDefault(); void state.save(); }}><FieldGroup>
    <FieldDescription>此连接仅用于旧聊天协议；新 Personal 设置使用「设置管理」连接。</FieldDescription>
    <Field data-invalid={!!state.fieldErrors.host} data-disabled={state.disabled}><FieldLabel htmlFor="personal-host">SSH 主机别名</FieldLabel><Input id="personal-host" name="host" value={state.draft.host} onChange={event => state.edit("host", event.target.value)} placeholder="如：pa-server" disabled={state.disabled} required pattern="[A-Za-z0-9][A-Za-z0-9._\-]*" autoCapitalize="none" autoComplete="off" spellCheck={false} aria-invalid={!!state.fieldErrors.host} aria-describedby="personal-host-help personal-host-error" /><FieldDescription id="personal-host-help">使用本机 SSH 配置中的主机别名。</FieldDescription>{state.fieldErrors.host && <FieldDescription role="alert" id="personal-host-error">{state.fieldErrors.host}</FieldDescription>}</Field>
    <Field data-invalid={!!state.fieldErrors.controlDir} data-disabled={state.disabled}><FieldLabel htmlFor="personal-control-dir">远端控制目录</FieldLabel><Input id="personal-control-dir" name="controlDir" value={state.draft.controlDir} onChange={event => state.edit("controlDir", event.target.value)} disabled={state.disabled} required pattern="\/[A-Za-z0-9._\/\-]*" autoCapitalize="none" autoComplete="off" spellCheck={false} aria-invalid={!!state.fieldErrors.controlDir} aria-describedby="personal-control-dir-error" />{state.fieldErrors.controlDir && <FieldDescription role="alert" id="personal-control-dir-error">{state.fieldErrors.controlDir}</FieldDescription>}</Field>
    {state.phase === "conflict" && state.current && <FieldDescription>当前配置：{state.current.host || "未配置"} · {state.current.controlDir}。输入框保留原提交内容。</FieldDescription>}
    <FieldDescription role="status">{state.reading ? "正在读取连接配置…" : state.message || "配置保存在本机，远端离线时也可编辑。保存后连接远端 PA；用户名、端口与密钥由本机 SSH 配置管理。"}</FieldDescription>
    <Field orientation="horizontal"><Button type="submit" size="sm" disabled={state.disabled || !state.dirty}>{state.phase === "saving" ? "正在保存…" : "保存配置"}</Button>{(!state.loaded || state.phase === "unknown") && <Button type="button" variant="ghost" size="sm" disabled={state.reading || state.phase === "saving"} onClick={() => void state.read()}>{state.phase === "unknown" ? "核实保存结果" : "重新读取"}</Button>}</Field>
  </FieldGroup></form>;
}
