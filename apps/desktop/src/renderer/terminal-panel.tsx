import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { CodeState } from "./code-state.ts";
import type { TerminalTab } from "./inspector.ts";

// Note: 见 .agents/notes/implemented/feature/2026-10-20-desktop-integrated-terminal.md
export function TerminalPanel({ model, tab, active }: { model: CodeState; tab: TerminalTab; active: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const activation = useRef<() => void>(() => {});
  useEffect(() => {
    const element = container.current!;
    const terminal = new Terminal({ fontFamily: '"SFMono-Regular", Menlo, monospace', fontSize: 13, cursorBlink: true, scrollback: 5000 });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(element);
    let disposed = false, ready = false;
    const fail = (message: string) => { if (disposed) return; tab.error = message; terminal.options.disableStdin = true; model.refresh(); };
    const unsubscribe = model.inspector.listenTerminal(tab.id, update => {
      if (update.kind === "output") terminal.write(Uint8Array.from(atob(update.data), character => character.charCodeAt(0)));
      else { tab.exitCode = update.exitCode; terminal.options.disableStdin = true; model.refresh(); }
    });
    const resize = () => {
      if (element.getBoundingClientRect().width <= 0 || element.getBoundingClientRect().height <= 0) return;
      fit.fit();
      if (ready && tab.exitCode === undefined) void model.inspector.sendTerminal(tab, "desktop_terminal_resize", { cols: terminal.cols, rows: terminal.rows }).then(() => { if (tab.error) fail(tab.error); });
    };
    const theme = () => {
      const dark = document.documentElement.classList.contains("dark");
      terminal.options.theme = dark ? { background: "#171717", foreground: "#e5e5e5", cursor: "#fafafa", selectionBackground: "#ffffff33" } : { background: "#ffffff", foreground: "#262626", cursor: "#171717", selectionBackground: "#00000022" };
    };
    activation.current = () => { resize(); if (element.getBoundingClientRect().width > 0) terminal.focus(); };
    const observer = new ResizeObserver(resize); observer.observe(element);
    const appearance = new MutationObserver(theme); appearance.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    theme(); resize();
    void model.inspector.startTerminal(tab, terminal.cols, terminal.rows).then(opened => { if (disposed) return; ready = opened; if (opened) resize(); });
    const input = terminal.onData(data => { if (ready && tab.exitCode === undefined) void model.inspector.sendTerminal(tab, "desktop_terminal_input", { data }).then(() => { if (tab.error) fail(tab.error); }); });
    return () => { disposed = true; activation.current = () => {}; unsubscribe(); input.dispose(); observer.disconnect(); appearance.disconnect(); terminal.dispose(); };
  }, [model, tab]);
  useEffect(() => { if (active) activation.current(); }, [active]);
  return <section className="terminal-panel" aria-label={tab.title}><div className="terminal-heading" title={tab.cwd}>{tab.cwd}</div>{tab.error && <p role="alert" className="terminal-status">{tab.error}</p>}{tab.exitCode !== undefined && <p className="terminal-status" role="status">终端已退出（{tab.exitCode}）</p>}<div ref={container} className="terminal-screen" /></section>;
}
