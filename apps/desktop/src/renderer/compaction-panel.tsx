import { useEffect } from "react";
import type { DesktopCompactions } from "./compaction-state.ts";
import { Button } from "./components/ui/button.tsx";

const labels = { running: "Compacting context", succeeded: "Context compaction complete", noop: "Nothing new to compact", failed: "Context compaction failed", cancelled: "Context compaction canceled", interrupted: "Context compaction interrupted" };
export function CompactionPanel({ model, sessionId }: { model: { compactions: DesktopCompactions; status: { state: string } }; sessionId: string }) {
  const compactions = model.compactions, state = compactions.get(sessionId), request = state.request;
  const occupied = compactions.occupied(sessionId), online = model.status.state === "online";
  useEffect(() => { void compactions.load(sessionId); }, [compactions, sessionId, online]);
  useEffect(() => {
    if (!occupied || !online) return;
    const timer = window.setInterval(() => { void compactions.load(sessionId); }, 2000);
    return () => window.clearInterval(timer);
  }, [compactions, sessionId, occupied, online]);
  if (!request && !state.pending && !state.message) return null;
  return <div className="task-notice compaction-notice" role="status">
    <div><span>{request ? labels[request.status] : "Compaction request unverified"}</span>{request && request.estimateBefore !== null && request.estimateAfter !== null && <span> · {request.estimateBefore.toLocaleString("en-US")} → {request.estimateAfter.toLocaleString("en-US")} tokens</span>}
      {request?.errorMessage && <p>{request.errorMessage}</p>}{state.message && <p>{state.message}</p>}</div>
    {request?.status === "running" ? <Button type="button" variant="ghost" size="sm" disabled={!online || state.stopping} onClick={() => void compactions.stop(sessionId)}>{state.stopping ? "Verifying stop" : "Stop compaction"}</Button> : state.pending ? <Button type="button" variant="ghost" size="sm" disabled={!online || state.loading} onClick={() => void compactions.retry(sessionId)}>Verify the original compaction request</Button> : null}
  </div>;
}
