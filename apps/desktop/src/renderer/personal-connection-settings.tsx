import { useEffect, useState } from "react";
import type { PersonalTargetConfig } from "../main/personal-config.ts";
import { Button } from "./components/ui/button.tsx";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "./components/ui/field.tsx";
import { Input } from "./components/ui/input.tsx";

export function PersonalConnectionSettings() {
  const [config, setConfig] = useState<PersonalTargetConfig | null>(null);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  async function read() {
    setReady(false);
    try {
      const result = await window.ruukoto.request("personal", "desktop_personal_config_read", {});
      if (!result.ok) { setMessage(result.error.message); return; }
      setConfig(result.value as PersonalTargetConfig | null); setReady(true);
    } catch { setMessage("无法读取连接配置，请重试。"); }
  }
  useEffect(() => { void read(); }, []);
  return <form aria-label="PA 远程连接" onChange={() => setMessage("")} onSubmit={async event => {
    event.preventDefault();
    if (!ready || saving || !event.currentTarget.reportValidity()) return;
    const data = new FormData(event.currentTarget);
    setSaving(true);
    try {
      const result = await window.ruukoto.request("personal", "desktop_personal_config_save", { host: data.get("host"), controlDir: data.get("controlDir") });
      if (!result.ok) { setMessage(result.error.message); return; }
      setConfig(result.value as PersonalTargetConfig); setMessage("配置已保存。");
    } catch { setMessage("保存结果待核实，请重新读取配置后确认。"); setReady(false); }
    finally { setSaving(false); }
  }}><FieldGroup>
    <Field><FieldLabel htmlFor="personal-host">SSH 主机别名</FieldLabel><Input key={`host:${config?.host ?? ""}:${ready}`} id="personal-host" name="host" defaultValue={config?.host ?? ""} placeholder="如：pa-server" disabled={!ready || saving} required pattern="[A-Za-z0-9][A-Za-z0-9._\-]*" autoCapitalize="none" autoComplete="off" spellCheck={false} aria-describedby="personal-host-help" /><FieldDescription id="personal-host-help">使用本机 SSH 配置中的主机别名。</FieldDescription></Field>
    <Field><FieldLabel htmlFor="personal-control-dir">远端控制目录</FieldLabel><Input key={`dir:${config?.controlDir ?? ""}:${ready}`} id="personal-control-dir" name="controlDir" defaultValue={config?.controlDir ?? "/var/lib/ruukoto/control"} disabled={!ready || saving} required pattern="\/[A-Za-z0-9._\/\-]*" autoCapitalize="none" autoComplete="off" spellCheck={false} /></Field>
    <FieldDescription role="status">{message || "保存后连接远端 PA。用户名、端口与密钥由本机 SSH 配置管理。"}</FieldDescription>
    <Field orientation="horizontal"><Button type="submit" size="sm" disabled={!ready || saving}>{saving ? "正在保存…" : "保存配置"}</Button>{!ready && <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => void read()}>重新读取</Button>}</Field>
  </FieldGroup></form>;
}
