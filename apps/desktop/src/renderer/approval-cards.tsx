import type { ConfirmationRequestView } from "@ruukoto/core/views.ts";
import type { CodeState } from "./code-state.ts";

function scopeSummary(c: ConfirmationRequestView): string {
  const scope = c.scope;
  switch (scope.kind) {
    case "tool": return scope.workspaceOnly ? "工作区内工具" : "工作区外工具";
    case "file_operation": return `文件${scope.access === "read" ? "读取" : "写入"}：${scope.path}`;
    case "http_request": return `HTTP ${scope.method} ${scope.url}`;
    case "mcp_tool": return `MCP ${scope.operationCategory === "write" ? "写" : "副作用不明"}工具：${scope.serviceName}/${scope.remoteName}`;
    case "browser_operation": return `浏览器：${scope.action}（会话 ${scope.sessionId} · 代次 ${scope.generation ?? "未启动"}）`;
    case "app_data_change": return `应用数据 ${scope.change}：表 ${scope.table ?? "多表"} · 影响 ${scope.affected}`;
    case "notification": return `通知外发（单次）：${scope.target.channel}/${scope.target.chatId} · 正文 ${scope.textChars} 字符`;
    case "service_operation": return `服务器服务管理（root 提权）：${scope.action} ${scope.unit}`;
    case "github_publish": return `GitHub 发布（已退役模块历史）：${scope.owner}/${scope.repo}`;
  }
}
export function ApprovalCards({ model }: { model: CodeState }) {
  const { approvals, view } = model;
  const pending = view.pendingApprovals();
  return <section className="approval-panel" aria-label="待处理审批">
    {approvals.message && <p role="status">{approvals.message}<button className="approval-refresh" onClick={() => void approvals.refresh()}>刷新审批状态</button></p>}
    {pending.map(approval => {
      const detail = approvals.details.get(approval.id);
      const busy = approvals.decisions.has(approval.id);
      return <article className="approval-card" key={approval.id}>
        <header><strong>{approval.toolName}</strong><button onClick={() => model.openSession(approval.sessionId)}>打开所属会话</button></header>
        <p>{scopeSummary(approval)}</p>
        <small>工作目录：{view.sessions.find(session => session.id === approval.sessionId)?.cwd ?? "未知"} · 权限版本 {approval.permissionVersion}</small>
        <p className="approval-review">{approval.reviewStatus === "in_progress" ? `自动审查中 · ${approval.reviewModel ?? "未知模型"}` : approval.reviewStatus === "asked_owner" ? `自动审查转人工：${approval.reviewReason ?? "未说明原因"}` : "等待拥有者决定"}{approval.reviewPolicyVersion && ` · 策略 ${approval.reviewPolicyVersion}`}</p>
        {approval.scope.kind === "service_operation" && <p>restart 会启动原本不活动的服务，并中断该服务正在处理的工作；效果未知时不自动重发。</p>}
        <details><summary>操作范围与目标详情</summary><pre>{JSON.stringify(approval.scope, null, 2)}</pre></details>
        {detail ? <>
          <pre aria-label="审批参数">{detail.text}</pre>
          {!detail.complete && <p role="status">{detail.loading ? "正在读取完整参数，当前内容仍被截断…" : "参数不完整"}</p>}
          {detail.error && <p role="alert">{detail.error}</p>}
        </> : <p>参数{approval.paramsTruncated ? "已截断" : "摘要"}（{approval.paramsBytes} 字节），请展开完整参数后决定。</p>}
        <footer>
          <button disabled={!!detail?.loading || busy || model.status.state !== "online"} onClick={() => void approvals.load(approval.id)}>{detail?.complete ? "重新读取参数" : "查看完整参数"}</button>
          <button disabled={!detail?.complete || busy || model.status.state !== "online"} onClick={() => void approvals.respond(approval, "reject")}>拒绝</button>
          <button className="approval-approve" disabled={!detail?.complete || busy || model.status.state !== "online"} onClick={() => void approvals.respond(approval, "approve")}>{busy ? "正在核实…" : "批准本次操作"}</button>
        </footer>
      </article>;
    })}
  </section>;
}
