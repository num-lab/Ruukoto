import { useEffect, useState } from "react";
import { RefreshCw, SquarePen } from "lucide-react";
import type { SettingsState } from "./settings-state.ts";
import { PersonalConnectionState } from "./personal-connection-state.ts";
import { Button } from "./components/ui/button.tsx";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "./components/ui/field.tsx";
import { Input } from "./components/ui/input.tsx";

export function PersonalConnectionSettings({ settings }: { settings: SettingsState }) {
  const [state] = useState(() => new PersonalConnectionState(window.ruukoto, settings.changed));
  const [editingOrigin, setEditingOrigin] = useState(false);
  const [editingPairing, setEditingPairing] = useState(false);
  useEffect(() => { settings.form = state; void state.read(); return () => { state.invalidate(); if (settings.form === state) settings.form = null; }; }, [settings, state]);
  useEffect(() => { if (state.fieldErrors.origin) document.getElementById("personal-origin")?.focus(); }, [state.fieldErrors]);
  const paired = !!state.current?.binding;
  return <form aria-label="PA 远程连接" aria-busy={state.reading || state.phase === "saving"} onSubmit={event => { event.preventDefault(); void state.save().then(saved => { if (saved) setEditingOrigin(false); }); }}><FieldGroup>
    {editingOrigin ? <>
      <Field data-invalid={!!state.fieldErrors.origin} data-disabled={state.disabled}><FieldLabel htmlFor="personal-origin">个人 Agent 地址</FieldLabel><Input id="personal-origin" value={state.draft.origin} onChange={event => state.edit("origin", event.target.value)} placeholder="https://your-server.your-tailnet.ts.net" autoCapitalize="none" autoComplete="off" spellCheck={false} disabled={state.disabled} aria-invalid={!!state.fieldErrors.origin} aria-describedby={state.fieldErrors.origin ? "personal-origin-error" : undefined} />{state.fieldErrors.origin && <FieldDescription id="personal-origin-error" role="alert">{state.fieldErrors.origin}</FieldDescription>}</Field>
      <Field orientation="horizontal"><Button type="submit" disabled={state.disabled || !state.dirty}>保存地址</Button><Button type="button" variant="ghost" onClick={() => { state.discard(); setEditingOrigin(false); }}>取消</Button></Field>
    </> : <Field>
      <div className="settings-row"><FieldLabel>个人 Agent 地址</FieldLabel><div className="model-settings-actions"><Button type="button" variant="ghost" size="icon-sm" aria-label="编辑地址" title="编辑地址" disabled={state.disabled} onClick={() => setEditingOrigin(true)}><SquarePen /></Button><Button type="button" variant="ghost" size="icon-sm" aria-label={state.phase === "unknown" ? "核实地址" : "重新读取"} title={state.phase === "unknown" ? "核实地址" : "重新读取"} disabled={state.reading || state.phase === "saving"} onClick={() => void state.read()}><RefreshCw /></Button></div></div>
      <p className="connection-value">{state.loaded ? state.draft.origin || "未配置" : "…"}</p>
    </Field>}
    {state.current?.origin && !state.dirty && (editingPairing ? <>
      <Field><FieldLabel htmlFor="personal-pair-label">此桌面的名称</FieldLabel><Input id="personal-pair-label" value={state.label} onChange={event => { state.label = event.target.value; settings.changed(); }} disabled={state.disabled} maxLength={80} autoComplete="off" /></Field>
      <Field><FieldLabel htmlFor="personal-pair-code">服务器配对码</FieldLabel><Input id="personal-pair-code" type="password" value={state.code} onChange={event => { state.code = event.target.value; settings.changed(); }} disabled={state.disabled} maxLength={12} autoComplete="off" autoCapitalize="characters" /></Field>
      <Field orientation="horizontal"><Button type="button" disabled={state.disabled || !state.code.trim() || !state.label.trim()} onClick={() => void state.pair().then(() => { if (state.phase === "ready") setEditingPairing(false); })}>配对并连接</Button><Button type="button" variant="ghost" disabled={state.reading || state.phase === "saving"} onClick={() => void state.pair("reconcile")}>核实原配对</Button><Button type="button" variant="ghost" disabled={state.reading || state.phase === "saving"} onClick={() => void state.pair("restore")}>恢复原配对</Button><Button type="button" variant="ghost" onClick={() => { state.code = ""; settings.changed(); setEditingPairing(false); }}>取消</Button></Field>
    </> : <Field>
      <div className="settings-row"><FieldLabel>服务器配对</FieldLabel><Button type="button" variant="ghost" size="icon-sm" aria-label="编辑配对" title="编辑配对" disabled={state.disabled} onClick={() => setEditingPairing(true)}><SquarePen /></Button></div>
      <p className="connection-value">{paired ? "已配对" : "未配对"}</p>
    </Field>)}
    {state.legacy.length > 0 && <Field><FieldLabel>旧维护尚待核实</FieldLabel><FieldDescription>先在原服务器核实，再确认；原记录保持原位。</FieldDescription><ul>{state.legacy.map(filename => <li key={filename}>{filename}</li>)}</ul><Button type="button" variant="outline" disabled={state.disabled} onClick={() => void state.acknowledgeLegacy()}>已在原服务器核实</Button></Field>}
    <FieldDescription role="status">{state.reading ? "正在核实此桌面的连接…" : state.message}</FieldDescription>
  </FieldGroup></form>;
}
