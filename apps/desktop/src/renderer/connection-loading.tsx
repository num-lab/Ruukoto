import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./components/ui/dialog.tsx";

// Note: See .agents/notes/implemented/feature/2026-10-18-demo-connection-loading.md
export function ConnectionLoading({ pending, onClosed }: { pending: boolean; onClosed: () => void }) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (!pending) setOpen(false);
  }, [pending]);

  return <Dialog open={open}>
    <DialogContent className="connection-loading" showCloseButton={false}
      onEscapeKeyDown={event => event.preventDefault()}
      onInteractOutside={event => event.preventDefault()}
      onCloseAutoFocus={event => { event.preventDefault(); onClosed(); }}>
      <DialogTitle className="sr-only">Connecting to the backend</DialogTitle>
      <DialogDescription role="status"><Loader2 className="animate-spin" aria-hidden="true" />Connecting to the backend…</DialogDescription>
    </DialogContent>
  </Dialog>;
}
