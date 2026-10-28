import { ChevronDown, Search } from "lucide-react";
import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

export function SettingsButton({ variant = "secondary", type = "button", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "secondary" | "ghost" | "icon";
}) {
  return <button type={type} className={`settings-button settings-button-${variant} ${className}`} {...props} />;
}

export function SettingsSelect({ options, className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement> & {
  options: ReadonlyArray<{ value: string; label: string; disabled?: boolean }>;
}) {
  return (
    <span className={`settings-select ${className}`}>
      <select {...props}>
        {options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
      </select>
      <ChevronDown aria-hidden="true" />
    </span>
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
