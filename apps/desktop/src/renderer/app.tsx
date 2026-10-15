import { useEffect, useRef, useState } from "react";
import { ViewState } from "@ruukoto/view/state.ts";
import type { DesktopUpdate } from "../shared/bridge.ts";

const labels = { connecting: "正在连接", online: "已连接", reconnecting: "正在重新连接", failed: "连接失败", closed: "已断开" };
export function App() {
  const view = useRef(new ViewState());
  const [, redraw] = useState(0);
  const [status, setStatus] = useState<Extract<DesktopUpdate, { type: "state" }>>({ type: "state", state: "connecting" });
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => window.ruukoto.subscribe("code", update => {
    if (update.type === "state") setStatus(update);
    else {
      if (update.type === "snapshot") view.current.applySnapshot(update.result, update.instanceChanged);
      else view.current.applyEvent(update.event, update.kind);
      redraw(value => value + 1);
    }
  }), []);
  const workspaces = view.current.projects.filter(project => project.rootDir !== null);
  const workspace = workspaces.find(project => project.id === selected);
  const reconnect = async () => {
    const result = await window.ruukoto.request("code", "reconnect", {});
    if (!result.ok) setStatus({ type: "state", state: "failed", error: result.error });
  };
  return <div className="desktop-shell">
    <aside className="sidebar">
      <div className="traffic-space" />
      <div className="brand">Ruukoto <span>桌面客户端</span></div>
      <nav className="target-switch" aria-label="连接目标"><button aria-current="page">Code</button><button disabled title="个人 Agent 目标尚未启用">Personal</button></nav>
      <h2>工作区 <span>{workspaces.length}</span></h2>
      <div className="workspace-list">
        {workspaces.map(project => <button key={project.id} className={selected === project.id ? "workspace selected" : "workspace"} onClick={() => setSelected(project.id)}><span className="folder" aria-hidden="true">▱</span><span>{project.name}<small>{project.rootDir?.cwdReal}</small></span></button>)}
        {status.state === "online" && workspaces.length === 0 && <p className="muted px-3">暂无工作区</p>}
      </div>
      <div className="connection" role="status"><i className={status.state === "online" ? "status-dot online" : "status-dot"} />{labels[status.state]}</div>
    </aside>
    <main className="canvas">
      <header className="window-heading">{workspace?.name ?? "Code"}<span>Coding Agent</span></header>
      <div className="empty-state">
        <div className="app-mark" aria-hidden="true">R</div>
        <h1>{status.state === "failed" ? "暂时无法连接" : workspace?.name ?? "你的工作区"}</h1>
        {status.state === "online" ? <p className="muted">{workspace?.rootDir?.cwdReal ?? "从左侧选择工作区。"}</p> : <p className="muted">{status.error?.message ?? status.detail ?? "正在连接本机 Coding Agent…"}</p>}
        {status.error?.versions && <p className="version-info">客户端 v{status.error.versions.client} · 后台 v{status.error.versions.server}</p>}
        {status.recovery && <ol className="recovery">{status.recovery.map(step => <li key={step}>{step}</li>)}</ol>}
        {(status.state === "failed" || status.state === "reconnecting" || status.state === "closed") && <button className="reconnect" onClick={() => void reconnect()}>重新连接</button>}
      </div>
    </main>
  </div>;
}
