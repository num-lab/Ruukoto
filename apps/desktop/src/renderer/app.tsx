import { useEffect, useState } from "react";
import { CodeState } from "./code-state.ts";
import { Conversation } from "./conversation.tsx";

const labels = { connecting: "正在连接", online: "已连接", reconnecting: "正在重新连接", failed: "连接失败", closed: "已断开" };
export function App() {
  const [, redraw] = useState(0);
  const [model] = useState(() => new CodeState(window.ruukoto, () => redraw(value => value + 1)));
  const [selected, setSelected] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  useEffect(() => window.ruukoto.subscribe("code", update => model.update(update)), [model]);
  const { view, status } = model;
  const workspaces = view.projects.filter(project => project.rootDir !== null);
  const workspace = workspaces.find(project => project.id === selected);
  const current = view.sessions.find(session => session.id === view.currentSessionId);
  const activeWorkspace = current ? workspaces.find(project => model.sessionsFor(project.id).some(session => session.id === current.id)) : workspace;
  const reconnect = async () => {
    const result = await window.ruukoto.request("code", "reconnect", {});
    if (!result.ok) model.update({ type: "state", state: "failed", error: result.error });
  };
  const addWorkspace = async () => {
    if (model.pendingCreation) { await model.create("open_workspace", { cwd: "" }); return; }
    setPicking(true);
    const result = await window.ruukoto.pickFolder();
    setPicking(false);
    if (!result.ok) { model.message = `选择工作区失败：${result.error.message}`; redraw(value => value + 1); return; }
    if (result.value) await model.create("open_workspace", { cwd: result.value });
  };
  return <div className="desktop-shell">
    <aside className="sidebar">
      <div className="traffic-space" />
      <div className="brand">Ruukoto <span>桌面客户端</span></div>
      <nav className="target-switch" aria-label="连接目标"><button aria-current="page">Code</button><button disabled title="个人 Agent 目标尚未启用">Personal</button></nav>
      <h2>工作区 <span>{workspaces.length}</span></h2>
      <div className="workspace-list">
        {workspaces.map(project => <section key={project.id}><button className={activeWorkspace?.id === project.id ? "workspace selected" : "workspace"} onClick={() => setSelected(project.id)}><span className="folder" aria-hidden="true">▱</span><span>{project.name}<small>{project.rootDir?.cwdReal}</small></span></button><div className="session-list" aria-label={`${project.name}的会话`}>{model.sessionsFor(project.id).map(session => <button key={session.id} className={current?.id === session.id ? "session selected" : "session"} onClick={() => { setSelected(project.id); model.openSession(session.id); }}><span aria-hidden="true">◦</span>{model.sessionName(session.id)}</button>)}<button className="new-session" disabled={status.state !== "online" || !!model.pendingCreation} onClick={() => void model.create("create_session", { project_id: project.id, cwd: project.rootDir!.cwdReal })}>＋ 新建会话</button></div></section>)}
        {status.state === "online" && workspaces.length === 0 && <p className="muted px-3">暂无工作区</p>}
      </div>
      <button className="add-workspace" disabled={picking || status.state !== "online" || !!model.pendingCreation} onClick={() => void addWorkspace()}>＋ 添加工作区</button>
      <div className="connection" role="status"><i className={status.state === "online" ? "status-dot online" : "status-dot"} />{labels[status.state]}</div>
    </aside>
    <main className="canvas">
      <header className="window-heading">{activeWorkspace?.name ?? "Code"}<span>Coding Agent</span></header>
      {model.tabs.length > 0 && <nav className="session-tabs" aria-label="已打开的会话">{model.tabs.map(id => <div className="session-tab" key={id}><button aria-current={current?.id === id ? "page" : undefined} onClick={() => model.openSession(id)}>{model.sessionName(id)}</button><button aria-label={`关闭${model.sessionName(id)}`} onClick={() => model.closeSession(id)}>×</button></div>)}</nav>}
      {model.message && <p className="operation-message" role="status">{model.message}</p>}
      {model.readError && <p className="operation-message" role="alert">{model.readError}</p>}
      {current && status.state !== "failed" ? <Conversation key={`${view.instanceId}:${current.id}`} model={model} sessionId={current.id} /> : <div className="empty-state">
        <div className="app-mark" aria-hidden="true">R</div>
        <h1>{status.state === "failed" ? "暂时无法连接" : workspace?.name ?? "你的工作区"}</h1>
        {status.state === "online" ? <p className="muted">{workspace?.rootDir?.cwdReal ?? "从左侧选择工作区。"}</p> : <p className="muted">{status.error?.message ?? status.detail ?? "正在连接本机 Coding Agent…"}</p>}
        {status.error?.versions && <p className="version-info">客户端 v{status.error.versions.client} · 后台 v{status.error.versions.server}</p>}
        {status.recovery && <ol className="recovery">{status.recovery.map(step => <li key={step}>{step}</li>)}</ol>}
        {(status.state === "failed" || status.state === "reconnecting" || status.state === "closed") && <button className="reconnect" onClick={() => void reconnect()}>重新连接</button>}
      </div>}
    </main>
  </div>;
}
