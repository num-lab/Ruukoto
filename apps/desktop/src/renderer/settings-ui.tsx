import type { ReactNode } from "react";
import { Field, FieldLabel } from "./components/ui/field.tsx";
import { Switch } from "./components/ui/switch.tsx";

/** 设置页统一分区：标题行右侧只放分区动作，说明文字不落在正文里。 */
export function SettingsSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <section className="model-settings-section" aria-label={title}><header className="model-settings-section-heading"><h3>{title}</h3>{action}</header>{children}</section>;
}

/** 是/否配置统一用开关行：标签居左，开关居右；title 承载不进正文的补充信息。 */
export function SwitchRow({ id, label, checked, disabled, title, onCheckedChange }: { id: string; label: string; checked: boolean; disabled: boolean; title?: string; onCheckedChange: (checked: boolean) => void }) {
  return <Field orientation="horizontal" className="settings-row"><FieldLabel htmlFor={id} title={title}>{label}</FieldLabel><Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} /></Field>;
}
