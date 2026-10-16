import { Item, ItemActions, ItemContent, ItemDescription, ItemHeader, ItemTitle } from "./components/ui/item.tsx";
import { MessageScrollerItem } from "./components/ui/message-scroller.tsx";
import { useEffect } from "react";
import type { ConfirmationRequestView } from "@ruukoto/core/views.ts";
import { Button } from "./components/ui/button.tsx";
import type { CodeState } from "./code-state.ts";

function scopeSummary(c: ConfirmationRequestView): string {
  const scope = c.scope;
  switch (scope.kind) {
    case "tool": return scope.workspaceOnly ? "在工作区运行命令" : "运行工具";
    case "file_operation": return scope.access === "read" ? "读取文件" : "修改文件";
    case "http_request": return `HTTP ${scope.method}`;
    case "mcp_tool": return `MCP ${scope.serviceName}/${scope.remoteName}`;
    case "browser_operation": return `浏览器：${scope.action}`;
    case "app_data_change": return `应用数据 ${scope.change}`;
    case "notification": return `发送通知：${scope.target.channel}/${scope.target.chatId}`;
    case "service_operation": return `服务器服务：${scope.action} ${scope.unit}`;
    case "github_publish": return `GitHub：${scope.owner}/${scope.repo}`;
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
    catch { paramsError = "审批参数无法解析，请重新读取。"; }
  }
  const command = typeof params.command === "string" ? params.command : detail?.text || JSON.stringify(params, null, 2);
  const purpose = typeof params.description === "string" ? params.description : typeof params.purpose === "string" ? params.purpose : typeof params.reason === "string" ? params.reason : null;
  return <MessageScrollerItem><Item asChild variant="muted" size="sm"><section aria-label="命令审批">
    <ItemHeader className="flex-wrap"><ItemTitle>{scopeSummary(approval)}</ItemTitle><ItemActions>
      <Button variant="ghost" size="sm" disabled={busy || !!paramsError || !detail?.complete || model.status.state !== "online"} onClick={() => void approvals.respond(approval, "reject")}>拒绝</Button>
      <Button size="sm" disabled={busy || !!paramsError || !detail?.complete || model.status.state !== "online"} onClick={() => void approvals.respond(approval, "approve")} aria-busy={busy}>批准</Button>
    </ItemActions></ItemHeader>
    <ItemContent className="min-w-0 basis-full gap-3"><pre tabIndex={0} className="command-code command-preview max-w-full overflow-x-auto rounded-lg bg-muted p-3 text-sm selectable-text"><code><span className="text-muted-foreground select-none">$ </span>{command}</code></pre>
    {purpose && <ItemDescription className="line-clamp-none">{purpose}</ItemDescription>}
    {(paramsError || detail?.error) && <p role="alert">{paramsError ?? detail?.error}<Button variant="ghost" size="sm" onClick={() => void approvals.load(approval.id)}>重试</Button></p>}
  </ItemContent></section></Item></MessageScrollerItem>;
}
export function ApprovalCards({ model, sessionId }: { model: CodeState; sessionId: string }) {
  return model.view.pendingApprovals().filter(approval => approval.sessionId === sessionId).map(approval => <ApprovalCard key={approval.id} model={model} approval={approval} />);
}
