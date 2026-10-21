import { useEffect, useState } from "react";
import type { SettingsState } from "./settings-state.ts";
import { PersonalConnectionState } from "./personal-connection-state.ts";
import { Button } from "./components/ui/button.tsx";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "./components/ui/field.tsx";
import { Input } from "./components/ui/input.tsx";

export function PersonalConnectionSettings({ settings }: { settings: SettingsState }) {
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
    <FieldDescription>此连接使用旧控制协议；新 Personal 的设置管理尚未接入。</FieldDescription>
    <Field data-invalid={!!state.fieldErrors.host} data-disabled={state.disabled}><FieldLabel htmlFor="personal-host">SSH 主机别名</FieldLabel><Input id="personal-host" name="host" value={state.draft.host} onChange={event => state.edit("host", event.target.value)} placeholder="如：pa-server" disabled={state.disabled} required pattern="[A-Za-z0-9][A-Za-z0-9._\-]*" autoCapitalize="none" autoComplete="off" spellCheck={false} aria-invalid={!!state.fieldErrors.host} aria-describedby="personal-host-help personal-host-error" /><FieldDescription id="personal-host-help">使用本机 SSH 配置中的主机别名。</FieldDescription>{state.fieldErrors.host && <FieldDescription role="alert" id="personal-host-error">{state.fieldErrors.host}</FieldDescription>}</Field>
    <Field data-invalid={!!state.fieldErrors.controlDir} data-disabled={state.disabled}><FieldLabel htmlFor="personal-control-dir">远端控制目录</FieldLabel><Input id="personal-control-dir" name="controlDir" value={state.draft.controlDir} onChange={event => state.edit("controlDir", event.target.value)} disabled={state.disabled} required pattern="\/[A-Za-z0-9._\/\-]*" autoCapitalize="none" autoComplete="off" spellCheck={false} aria-invalid={!!state.fieldErrors.controlDir} aria-describedby="personal-control-dir-error" />{state.fieldErrors.controlDir && <FieldDescription role="alert" id="personal-control-dir-error">{state.fieldErrors.controlDir}</FieldDescription>}</Field>
    {state.phase === "conflict" && state.current && <FieldDescription>当前配置：{state.current.host || "未配置"} · {state.current.controlDir}。输入框保留原提交内容。</FieldDescription>}
    <FieldDescription role="status">{state.reading ? "正在读取连接配置…" : state.message || "配置保存在本机，远端离线时也可编辑。保存后连接远端 PA；用户名、端口与密钥由本机 SSH 配置管理。"}</FieldDescription>
    <Field orientation="horizontal"><Button type="submit" size="sm" disabled={state.disabled || !state.dirty}>{state.phase === "saving" ? "正在保存…" : "保存配置"}</Button>{(!state.loaded || state.phase === "unknown") && <Button type="button" variant="ghost" size="sm" disabled={state.reading || state.phase === "saving"} onClick={() => void state.read()}>{state.phase === "unknown" ? "核实保存结果" : "重新读取"}</Button>}</Field>
  </FieldGroup></form>;
}
