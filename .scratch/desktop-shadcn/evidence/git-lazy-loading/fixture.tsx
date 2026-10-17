import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { GitGraphPanel } from "../../../../apps/desktop/src/renderer/git-graph.tsx";
import "../../../../apps/desktop/src/renderer/style.css";

const commits = Array.from({ length: 405 }, (_, index) => ({ id: String(index).padStart(40, "0"), parents: index < 404 ? [String(index + 1).padStart(40, "0")] : [], subject: `提交 ${index + 1} · 自动分页验收`, author: "fixture", date: "2026-10-17T00:00:00Z", refs: [] }));
function Fixture() {
  const [count, setCount] = useState(200), [requests, setRequests] = useState(0), [loading, setLoading] = useState(false), [error, setError] = useState<string>(), [active, setActive] = useState(true);
  const fail = useRef(false), busy = useRef(false);
  const loadMore = async () => {
    if (busy.current) return;
    busy.current = true; setLoading(true); setError(undefined); setRequests(value => value + 1);
    await new Promise(resolve => setTimeout(resolve, 150));
    if (fail.current) { fail.current = false; setError("测试追加失败，请重试"); }
    else setCount(value => Math.min(commits.length, value + 200));
    busy.current = false; setLoading(false);
  };
  return <main style={{ width: 520, maxWidth: "95vw", height: "95vh", margin: "12px auto", display: "flex", flexDirection: "column", background: "var(--bg-sidebar)" }}>
    <h1 style={{ fontSize: 18, padding: 12 }}>实际 GitGraphPanel · 受控分页数据</h1>
    <p role="status" style={{ padding: 12 }}>已显示 {count} 条，分页请求 {requests} 次</p>
    <div style={{ display: "flex", gap: 12, padding: 12 }}><button onClick={() => { fail.current = true; }}>模拟下页失败</button><button onClick={() => setActive(value => !value)}>{active ? "隐藏面板" : "显示面板"}</button></div>
    <div style={{ display: active ? "flex" : "none", flex: 1, minHeight: 0 }}><GitGraphPanel name="自动懒加载验收仓库" active={active} repository={{ head: commits[0].id, commits: commits.slice(0, count), nextCursor: count < commits.length ? String(count) : null }} loading={false} loadingMore={loading} moreError={error} onLoadMore={() => void loadMore()} onRefresh={() => { setCount(200); setRequests(0); setError(undefined); }} /></div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
