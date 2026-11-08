import { useEffect } from "react";
import type { DesktopCompactions } from "./compaction-state.ts";
import { Button } from "./components/ui/button.tsx";

const labels = { running: "正在压缩上下文", succeeded: "上下文压缩完成", noop: "没有新的可压缩内容", failed: "上下文压缩失败", cancelled: "上下文压缩已取消", interrupted: "上下文压缩已中断" };
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
    <div><span>{request ? labels[request.status] : "压缩请求待核实"}</span>{request && request.estimateBefore !== null && request.estimateAfter !== null && <span> · {request.estimateBefore.toLocaleString()} → {request.estimateAfter.toLocaleString()} tokens</span>}
      {request?.errorMessage && <p>{request.errorMessage}</p>}{state.message && <p>{state.message}</p>}</div>
    {request?.status === "running" ? <Button type="button" variant="ghost" size="sm" disabled={!online || state.stopping} onClick={() => void compactions.stop(sessionId)}>{state.stopping ? "正在核实停止" : "停止压缩"}</Button> : state.pending ? <Button type="button" variant="ghost" size="sm" disabled={!online || state.loading} onClick={() => void compactions.retry(sessionId)}>核实原压缩请求</Button> : null}
  </div>;
}
