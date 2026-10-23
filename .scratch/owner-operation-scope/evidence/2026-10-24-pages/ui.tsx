import { useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import type { ConnectResult } from "@ruukoto/control/protocol.ts";
import { CodeState } from "../../../../apps/desktop/src/renderer/code-state.ts";
import { InspectorPanel, InspectorHeader } from "../../../../apps/desktop/src/renderer/inspector-panel.tsx";
import { TooltipProvider } from "../../../../apps/desktop/src/renderer/components/ui/tooltip.tsx";
import "../../../../apps/desktop/src/renderer/style.css";

const bootstrap = await (await fetch("/_acceptance/bootstrap")).json() as { sessions: { id: string; name: string }[]; snapshot: ConnectResult };
function Fixture() {
  const [, redraw] = useState(0), [width, setWidth] = useState(440), [dark, setDark] = useState(false);
  const [model] = useState(() => {
    const state = new CodeState({ request: async (_target, op, params) => (await fetch("/_acceptance/request", { method: "POST", body: JSON.stringify({ op, params }) })).json() }, () => redraw(value => value + 1));
    state.view.applySnapshot(bootstrap.snapshot, false);
    state.status = { type: "state", state: "online" };
    state.inspector.openParent(bootstrap.sessions[0].id);
    state.inspector.newTab();
    return state;
  });
  return <TooltipProvider><main className={dark ? "dark" : ""} style={{ height: "100vh", display: "flex", flexDirection: "column", padding: 20, background: "var(--bg-main)" }}>
    <header style={{ display: "flex", flexWrap: "wrap", gap: 16, paddingBottom: 20 }}>
      {bootstrap.sessions.map(session => <button key={session.id} onClick={() => { model.inspector.openParent(session.id); model.inspector.newTab(); }}>{session.name}</button>)}
      <button onClick={() => model.inspector.newTab()}>新标签</button>
      <button onClick={() => setWidth(value => value === 440 ? 320 : 440)}>切换宽度</button>
      <button onClick={() => { setDark(value => !value); document.documentElement.classList.toggle("dark"); }}>切换主题</button>
      <button onClick={() => void fetch("/_acceptance/change")}>修改临时目录</button>
    </header>
    <div className="app-window" style={{ "--right-width": `${width}px`, width: width + 220, minWidth: 0, flex: 1 } as CSSProperties}>
      <div className="left-sidebar is-collapsed" style={{ display: "none" }} />
      <div className="content-area">
        <header className="surface-sidebar canvas-header"><div className="session-header">隔离工作区</div><div className="inspector-header"><InspectorHeader model={model} open /></div></header>
        <div className="content-body"><section className="surface-canvas main-canvas" /><InspectorPanel model={model} open onWidthChange={setWidth} /></div>
      </div>
    </div>
  </main></TooltipProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
