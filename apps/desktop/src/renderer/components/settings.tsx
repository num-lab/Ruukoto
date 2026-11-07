import { ChevronLeft, ChevronRight } from "lucide-react";
import { Children, useEffect, useId, useRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";

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
        <nav className="settings-navigation" aria-label="设置类别">{navigation}</nav>
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

export function SettingsPage({ title, description, overview, children }: {
  title: string;
  description?: ReactNode;
  overview?: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <div className="settings-page" aria-labelledby={titleId}>
      <header className="settings-page-header">
        <h1 id={titleId}>{title}</h1>
        {description && <p>{description}</p>}
      </header>
      {overview}
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
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { backRef.current?.focus({ preventScroll: true }); }, []);
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

export function SettingsListItem({ detailsId, details, expanded, onToggle, toggleLabel, ...props }: Parameters<typeof SettingsRow>[0] & { detailsId?: string; details?: ReactNode; expanded?: boolean; onToggle?: () => void; toggleLabel?: string }) {
  const id = useId();
  const contentId = detailsId ?? id;
  const row = <SettingsRow {...props}>{props.children}{onToggle && <ChevronRight aria-hidden="true" className={`settings-list-disclosure${expanded ? " is-expanded" : ""}`} />}</SettingsRow>;
  return <li className="settings-list-item">
    {onToggle ? <button type="button" className="settings-list-item-trigger" aria-label={toggleLabel} aria-expanded={expanded} aria-controls={contentId} onClick={onToggle}>{row}</button> : row}
    {onToggle ? <div id={contentId} hidden={!expanded} className="settings-list-item-details">{details}</div> : details && <div id={contentId} className="settings-list-item-details">{details}</div>}
  </li>;
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

export function SettingsRow({ title, description, htmlFor, footer, error, children }: {
  title: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  footer?: ReactNode;
  error?: ReactNode;
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
      {error && <p className="settings-row-error" role="alert">{error}</p>}
    </div>
  );
}
