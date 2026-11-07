import { ChevronDown, ChevronUp, Search } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";
import { useState, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";

export function SettingsButton({ variant = "secondary", type = "button", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "secondary" | "primary" | "ghost" | "icon";
}) {
  return <button type={type} className={`settings-button settings-button-${variant} ${className}`} {...props} />;
}

// Note: See .agents/notes/implemented/feature/2026-11-07-desktop-visual-alignment.md
export function SettingsSelect({ options, className = "", value, defaultValue, onValueChange, disabled, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "value" | "defaultValue" | "onChange"> & {
  options: ReadonlyArray<{ value: string; label: string; disabled?: boolean }>;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
}) {
  // Prefix every value so a selectable empty business value remains a valid Radix item.
  const encode = (value: string) => `option:${value}`;
  const [selected, setSelected] = useState(defaultValue ?? options[0]?.value ?? "");
  const current = value ?? selected;
  return (
    <SelectPrimitive.Root value={encode(current)} onValueChange={value => { const next = value.slice(7); setSelected(next); onValueChange?.(next); }} disabled={disabled}>
      <SelectPrimitive.Trigger {...props} className={`settings-select ${className}`}>
        <SelectPrimitive.Value>{options.find(option => option.value === current)?.label ?? (current || "请选择")}</SelectPrimitive.Value><SelectPrimitive.Icon asChild><ChevronDown aria-hidden="true" /></SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal><SelectPrimitive.Content className="settings-select-content" position="popper" align="start" sideOffset={4}>
        <SelectPrimitive.ScrollUpButton className="settings-select-scroll"><ChevronUp aria-hidden="true" /></SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport className="settings-select-viewport"><SelectPrimitive.Group>
          {options.map(option => <SelectPrimitive.Item key={option.value} value={encode(option.value)} disabled={option.disabled} className="settings-select-item"><SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText></SelectPrimitive.Item>)}
        </SelectPrimitive.Group></SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="settings-select-scroll"><ChevronDown aria-hidden="true" /></SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content></SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export function SettingsSwitch(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "role">) {
  return <input type="checkbox" role="switch" className="settings-switch" {...props} />;
}

export function SettingsSegmented<Value extends string>({ label, value, options, onValueChange, className = "", ...props }: Omit<HTMLAttributes<HTMLDivElement>, "onChange"> & {
  label: string;
  value: Value;
  options: ReadonlyArray<{ value: Value; label: ReactNode; disabled?: boolean }>;
  onValueChange: (value: Value) => void;
}) {
  return (
    <div className={`settings-segmented ${className}`} role="group" aria-label={label} {...props}>
      {options.map(option => (
        <button key={option.value} type="button" aria-pressed={option.value === value} disabled={option.disabled} onClick={() => onValueChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function SettingsInput({ icon, className = "", ...props }: InputHTMLAttributes<HTMLInputElement> & {
  icon?: ReactNode;
}) {
  return (
    <span className={`settings-input-shell ${className}`}>
      {icon}
      <input {...props} />
    </span>
  );
}

export function SettingsSearch({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className={`settings-search ${className}`}>
      <Search aria-hidden="true" />
      <input type="search" {...props} />
    </div>
  );
}

export function SettingsTag({ children }: { children: ReactNode }) {
  return <span className="settings-tag">{children}</span>;
}

export function SettingsNotice({ children }: { children: ReactNode }) {
  return <p className="settings-notice" role="status">{children}</p>;
}
