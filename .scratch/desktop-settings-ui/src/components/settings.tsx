import { ChevronLeft } from "lucide-react";
import { Children, useId, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";

export function SettingsShell({ navigation, action, footer, children, className = "", ...props }: HTMLAttributes<HTMLDivElement> & {
  navigation: ReactNode;
  action?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`settings-shell ${className}`} {...props}>
      <aside className="settings-sidebar">
        <div className="settings-sidebar-title">Settings</div>
        <nav className="settings-navigation" aria-label="Settings categories">{navigation}</nav>
        {footer}
      </aside>
      <main className="settings-main">
        {action && <div className="settings-window-action">{action}</div>}
        {children}
      </main>
    </div>
  );
}

export function SettingsNavSection({ label }: { label: string }) {
  return <div className="settings-nav-section">{label}</div>;
}

export function SettingsNavItem({ selected, icon, children, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  selected: boolean;
  icon?: ReactNode;
}) {
  return (
    <button type="button" className={`settings-nav-item ${className}`} aria-current={selected ? "page" : undefined} {...props}>
      {icon}
      <span>{children}</span>
    </button>
  );
}

export function SettingsPage({ title, description, children }: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <div className="settings-page" aria-labelledby={titleId}>
      <header className="settings-page-header">
        <h1 id={titleId}>{title}</h1>
        {description && <p>{description}</p>}
      </header>
      <div className="settings-groups">{children}</div>
    </div>
  );
}

export function SettingsSubpage({ title, description, onBack, children }: {
  title: string;
  description?: ReactNode;
  onBack: () => void;
  children: ReactNode;
}) {
  const backRef = (node: HTMLButtonElement | null) => node?.focus({ preventScroll: true });
  return (
    <div className="settings-subpage">
      <button ref={backRef} type="button" className="settings-button settings-button-ghost settings-subpage-back" onClick={onBack}><ChevronLeft aria-hidden="true" /> Back</button>
      <SettingsPage title={title} description={description}>{children}</SettingsPage>
    </div>
  );
}

export function SettingsGroup({ title, description, action, children }: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section className="settings-group" aria-labelledby={titleId}>
      <div className="settings-group-header">
        <div>
          <h2 id={titleId}>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function SettingsCard({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`settings-card ${className}`} {...props} />;
}

export function SettingsList({ label, empty, children }: {
  label: string;
  empty?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <SettingsCard>
      <ul className="settings-list" aria-label={label}>
        {children}
        {Children.count(children) === 0 && empty && <li className="settings-list-empty">{empty}</li>}
      </ul>
    </SettingsCard>
  );
}

export function SettingsListItem({ detailsId, details, ...props }: Parameters<typeof SettingsRow>[0] & { detailsId?: string; details?: ReactNode }) {
  return <li className="settings-list-item"><SettingsRow {...props} />{details && <div id={detailsId} className="settings-list-item-details">{details}</div>}</li>;
}

export function SettingsLinkRow({ title, description, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  title: string;
  description?: string;
}) {
  return (
    <button type="button" className="settings-link-row" {...props}>
      <SettingsRow title={title} description={description}><span className="settings-value">Manage</span></SettingsRow>
    </button>
  );
}

export function SettingsRow({ title, description, htmlFor, footer, children }: {
  title: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  footer?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        {htmlFor ? <label className="settings-row-title" htmlFor={htmlFor}>{title}</label> : <div className="settings-row-title">{title}</div>}
        {description && <p className="settings-row-description">{description}</p>}
      </div>
      {children && <div className="settings-row-control">{children}</div>}
      {footer && <div className="settings-row-footer">{footer}</div>}
    </div>
  );
}
