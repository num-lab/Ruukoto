import { useState } from "react";
import { Button } from "./components/ui/button.tsx";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "./components/ui/field.tsx";
import { Input } from "./components/ui/input.tsx";

type PersonalConnectionConfig = { host: string; controlDir: string };
export const initialPersonalConnection: PersonalConnectionConfig = { host: "", controlDir: "/var/lib/ruukoto/control" };

// Note: 见 .agents/notes/implemented/feature/2026-10-17-demo-personal-connection-settings.md
export function PersonalConnectionSettings({ config, onSave }: { config: PersonalConnectionConfig; onSave: (config: PersonalConnectionConfig) => void }) {
  const [saved, setSaved] = useState(false);
  return <form aria-label="PA 远程连接" onChange={() => setSaved(false)} onSubmit={event => {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    const data = new FormData(event.currentTarget);
    onSave({ host: data.get("host")?.toString() ?? "", controlDir: data.get("controlDir")?.toString() ?? "" });
    setSaved(true);
  }}><FieldGroup>
    <Field><FieldLabel htmlFor="personal-host">SSH 主机别名</FieldLabel><Input id="personal-host" name="host" defaultValue={config.host} placeholder="如：pa-server" required pattern="[A-Za-z0-9][A-Za-z0-9._\-]*" autoCapitalize="none" autoComplete="off" spellCheck={false} aria-describedby="personal-host-help" /><FieldDescription id="personal-host-help">使用本机 SSH 配置中的主机别名。</FieldDescription></Field>
    <Field><FieldLabel htmlFor="personal-control-dir">远端控制目录</FieldLabel><Input id="personal-control-dir" name="controlDir" defaultValue={config.controlDir} required pattern="\/[A-Za-z0-9._\/\-]*" autoCapitalize="none" autoComplete="off" spellCheck={false} /></Field>
    <FieldDescription role="status">{saved && "配置已保存。"}仅在本次演示中保存，不建立真实 SSH 连接。</FieldDescription>
    <Field orientation="horizontal"><Button type="submit" size="sm">保存配置</Button></Field>
  </FieldGroup></form>;
}
