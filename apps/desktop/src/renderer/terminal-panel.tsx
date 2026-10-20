import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { CodeState } from "./code-state.ts";
import type { TerminalTab } from "./inspector.ts";

// 明暗两套完整 16 色；缺省色由 xterm 内置默认补齐。
const terminalThemes = {
  dark: { background: "#171717", foreground: "#e5e5e5", cursor: "#fafafa", cursorAccent: "#171717", selectionBackground: "#ffffff33", black: "#171717", red: "#f87171", green: "#4ade80", yellow: "#facc15", blue: "#60a5fa", magenta: "#c084fc", cyan: "#22d3ee", white: "#e5e5e5", brightBlack: "#737373", brightRed: "#fca5a5", brightGreen: "#86efac", brightYellow: "#fde047", brightBlue: "#93c5fd", brightMagenta: "#d8b4fe", brightCyan: "#67e8f9", brightWhite: "#fafafa" },
  light: { background: "#ffffff", foreground: "#262626", cursor: "#171717", cursorAccent: "#ffffff", selectionBackground: "#00000022", black: "#ffffff", red: "#dc2626", green: "#16a34a", yellow: "#ca8a04", blue: "#2563eb", magenta: "#9333ea", cyan: "#0e7490", white: "#262626", brightBlack: "#a3a3a3", brightRed: "#ef4444", brightGreen: "#22c55e", brightYellow: "#eab308", brightBlue: "#3b82f6", brightMagenta: "#a855f7", brightCyan: "#06b6d4", brightWhite: "#525252" },
};
// 字体栈与全局 --font-mono 一致；必须写具体字体：xterm 用 OffscreenCanvas 的 ctx.font 测量字符尺寸，canvas 字体语法不解析 var()，回退默认比例字体会同时压错行高。
const terminalFontFamily = '"SF Mono", ui-monospace, Menlo, Monaco, Consolas, monospace';
// Note: 见 .agents/notes/implemented/feature/2026-10-20-desktop-integrated-terminal.md
export function TerminalPanel({ model, tab, active }: { model: CodeState; tab: TerminalTab; active: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const activation = useRef<() => void>(() => {});
  useEffect(() => {
    const element = container.current!;
    const terminal = new Terminal({ fontFamily: terminalFontFamily, fontSize: 13, cursorBlink: true, scrollback: 5000 });
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
      terminal.options.theme = terminalThemes[dark ? "dark" : "light"];
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
