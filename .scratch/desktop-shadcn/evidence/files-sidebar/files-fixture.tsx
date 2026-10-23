import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { OpResult } from "@ruukoto/control/ops.ts";
import type { DesktopResult } from "../../../../apps/desktop/src/shared/bridge.ts";
import { CodeState } from "../../../../apps/desktop/src/renderer/code-state.ts";
import { WorkspaceFiles } from "../../../../apps/desktop/src/renderer/inspector-panels.tsx";
import "../../../../apps/desktop/src/renderer/style.css";

type DirectoryReply = DesktopResult<OpResult<"list_workspace_files">>;
function Fixture() {
  const [, redraw] = useState(0), [active, setActive] = useState(true);
  const pending = useRef(new Map<string, (value: DirectoryReply) => void>());
  const [model] = useState(() => {
    const state = new CodeState({ request: async (_target, op, params) => {
      if (op !== "list_workspace_files") return { ok: false, error: { code: "fixture_unsupported", outcome: "not_sent", message: "验收仅支持目录读取。" } };
      const path = typeof params?.path === "string" ? params.path : "";
      return new Promise<DirectoryReply>(resolve => pending.current.set(path, resolve));
    } }, () => redraw(value => value + 1));
    state.status = { type: "state", state: "online" };
    state.view.projects = [{ id: "w", name: "加载反馈验收", rootDir: { cwd: "/fixture", cwdReal: "/fixture", cwdDev: 1, cwdIno: 1 }, createRequestId: null, instructionFiles: [], webSearch: "enabled", settingsVersion: 1, createdAt: "2026-10-17T00:00:00Z" }];
    return state;
  });
  const finish = (path: string, entries: OpResult<"list_workspace_files">["entries"]) => {
    pending.current.get(path)?.({ ok: true, value: { workspaceId: "w", path, entries, nextCursor: null } });
    pending.current.delete(path);
  };
  return <main style={{ width: 440, maxWidth: "95vw", height: "90vh", margin: "20px auto", display: "flex", flexDirection: "column", background: "var(--bg-sidebar)" }}>
    <h1 style={{ fontSize: 18, padding: 12 }}>正式文件树组件 · 受控读取回复</h1>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, padding: 12 }}>
      <button onClick={() => finish("", ["src", "empty", "broken"].map(name => ({ name, path: name, kind: "directory" })))}>完成根目录</button>
      <button onClick={() => finish("src", [{ name: "main.ts", path: "src/main.ts", kind: "file" }])}>完成 src</button>
      <button onClick={() => finish("empty", [])}>完成 empty</button>
      <button onClick={() => { pending.current.get("broken")?.({ ok: false, error: { code: "fixture_failure", outcome: "not_sent", message: "测试读取失败" } }); pending.current.delete("broken"); }}>失败 broken</button>
      <button onClick={() => finish("broken", [])}>完成 broken</button>
      <button onClick={() => setActive(value => !value)}>{active ? "隐藏文件树" : "显示文件树"}</button>
    </div>
    <WorkspaceFiles model={model} workspaceId="w" active={active} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
