import type { ReactNode, Ref } from "react";
import { Button } from "./components/ui/button.tsx";

export function IconButton({ label, children, onClick, className = "", disabled, buttonRef }: { label: string; children: ReactNode; onClick: () => void; className?: string; disabled?: boolean; buttonRef?: Ref<HTMLButtonElement> }) {
  return <Button ref={buttonRef} type="button" variant="ghost" size="icon" className={`quiet-icon ${className}`} aria-label={label} onClick={onClick} disabled={disabled}>{children}</Button>;
}
