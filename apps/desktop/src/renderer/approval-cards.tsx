import { Item, ItemActions, ItemContent, ItemDescription, ItemHeader, ItemTitle } from "./components/ui/item.tsx";
import { MessageScrollerItem } from "./components/ui/message-scroller.tsx";
import { useEffect } from "react";
import type { ConfirmationRequestView } from "@ruukoto/core/views.ts";
import { cuaBatchSummary } from "@ruukoto/view/cua-batch.ts";
import { Button } from "./components/ui/button.tsx";
import type { CodeState } from "./code-state.ts";

function scopeSummary(c: ConfirmationRequestView): string {
  const scope = c.scope;
  switch (scope.kind) {
    case "tool": return scope.workspaceOnly ? "Run a command in the workspace" : "Run a tool";
    case "file_operation": return scope.access === "read" ? "Read a file" : "Modify a file";
    case "http_request": return `HTTP ${scope.method}`;
    case "mcp_tool": return `MCP ${scope.serviceName}/${scope.remoteName}`;
    case "browser_operation": return `Browser: ${scope.action}`;
  }
}
function ApprovalCard({ model, approval }: { model: CodeState; approval: ConfirmationRequestView }) {
  const { approvals } = model;
  const detail = approvals.details.get(approval.id);
  useEffect(() => { if (!approvals.details.has(approval.id)) void approvals.load(approval.id); }, [approvals, approval.id, approval.permissionVersion, detail]);
  const busy = approvals.decisions.has(approval.id);
  let params = approval.params;
  let paramsError: string | null = null;
  if (detail?.complete) {
    try { params = JSON.parse(detail.text) as Record<string, unknown>; }
    catch { paramsError = "Couldn't parse the approval parameters. Read them again."; }
  }
  const batch = approval.scope.kind === "mcp_tool" && approval.scope.cua && approval.scope.remoteName === "run_steps" ? cuaBatchSummary(params) : null;
  const command = batch ? `Batch action (one approval binds every step):\n${batch.join("\n")}\n\nOriginal parameters:\n${JSON.stringify(params, null, 2)}`
    : typeof params.command === "string" ? params.command : detail?.text || JSON.stringify(params, null, 2);
  const purpose = typeof params.description === "string" ? params.description : typeof params.purpose === "string" ? params.purpose : typeof params.reason === "string" ? params.reason : null;
  return <MessageScrollerItem><Item asChild variant="muted" size="sm" className="approval-card"><section aria-label="Command approval">
    <ItemHeader className="flex-wrap"><ItemTitle>{scopeSummary(approval)}</ItemTitle><ItemActions>
      <Button variant="ghost" size="sm" disabled={busy || !!paramsError || !detail?.complete || model.status.state !== "online"} onClick={() => void approvals.respond(approval, "reject")}>Deny</Button>
      <Button size="sm" disabled={busy || !!paramsError || !detail?.complete || model.status.state !== "online"} onClick={() => void approvals.respond(approval, "approve")} aria-busy={busy}>Approve</Button>
    </ItemActions></ItemHeader>
    <ItemContent className="min-w-0 basis-full gap-3"><pre tabIndex={0} className="command-code command-preview max-w-full overflow-x-auto rounded-lg bg-muted p-3 text-sm selectable-text"><code><span className="text-muted-foreground select-none">$ </span>{command}</code></pre>
    {purpose && <ItemDescription className="line-clamp-none">{purpose}</ItemDescription>}
    {(paramsError || detail?.error) && <p role="alert">{paramsError ?? detail?.error}<Button variant="ghost" size="sm" onClick={() => void approvals.load(approval.id)}>Retry</Button></p>}
  </ItemContent></section></Item></MessageScrollerItem>;
}
export function ApprovalCards({ model, sessionId }: { model: CodeState; sessionId: string }) {
  return model.view.pendingApprovals().filter(approval => approval.sessionId === sessionId).map(approval => <ApprovalCard key={approval.id} model={model} approval={approval} />);
}
