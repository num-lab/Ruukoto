import { ScrollText, Square } from "lucide-react";
import { backgroundProcessStatus } from "@ruukoto/view/background-processes.ts";
import type { CodeState } from "./code-state.ts";
import { Button } from "./components/ui/button.tsx";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs.tsx";

// Note: See .agents/notes/implemented/feature/2026-10-24-desktop-background-tab.md
export function BackgroundPanel({ model }: { model: CodeState }) {
  const state = model.background;
  const blocked = state.busy || !state.online();
  const selected = state.selected, output = state.output;
  return <section className="background-panel" aria-label="Background processes">
    {state.message && <p className="background-note" role="status">{state.message}</p>}
    {state.endConfirm ? <div className="background-section">
      <p className="background-meta">Stop and verify the background involved in this end request; the chat and history are kept.</p>
      <div className="background-actions"><Button variant="ghost" size="sm" onClick={() => { state.endConfirm = false; model.refresh(); }}>Back</Button><Button size="sm" disabled={blocked} onClick={() => void state.end()}>{state.pendingEnd ? "Verify the original request" : "End this chat's background"}</Button></div>
    </div>
    : selected ? <>
      <div className="background-section">
        <p className="background-process-line"><b>{backgroundProcessStatus(selected)}</b><code>{selected.command}</code></p>
        <p className="background-meta">stdout {selected.stdoutBytes} B · stderr {selected.stderrBytes} B{selected.partial && " · incomplete log"}</p>
        {selected.exit && <p className="background-meta">Exit observation: {selected.exit.code ?? selected.exit.signal ?? "unknown"}; stop verification shown separately</p>}
        {selected.reason && <p className="background-meta">{selected.reason}</p>}
        <div className="background-actions"><Button variant="outline" size="sm" disabled={blocked || selected.stopVerified} onClick={() => void state.stop(selected)}>Request stop</Button></div>
      </div>
      <Tabs value={state.stream} onValueChange={stream => void state.read(0, stream as "stdout" | "stderr")}><TabsList aria-label="Background log stream"><TabsTrigger value="stdout">stdout</TabsTrigger><TabsTrigger value="stderr">stderr</TabsTrigger></TabsList></Tabs>
      {output && <><p className="background-meta">{output.offset}–{output.nextOffset}/{output.totalBytes} B{output.partial && " · incomplete log"}</p><pre tabIndex={0} className="background-log" aria-label={`${state.stream} log`}>{state.raw ? output.base64 : output.text || "(no output on this page)"}</pre></>}
      <div className="background-actions"><Button variant="outline" size="sm" disabled={state.reading || !state.previousOffsets.length} onClick={() => state.previousOutput()}>Previous log page</Button><Button variant="outline" size="sm" disabled={state.reading || !output || output.nextOffset >= output.totalBytes} onClick={() => state.nextOutput()}>Next log page</Button><Button variant="ghost" size="sm" onClick={() => { state.raw = !state.raw; model.refresh(); }}>{state.raw ? "Show text" : "View raw bytes (base64)"}</Button><Button variant="ghost" size="sm" disabled={state.reading || !state.online()} onClick={() => void state.read(output?.offset ?? 0)}>Refresh this page</Button></div>
      <div className="background-actions"><Button variant="ghost" size="sm" onClick={() => { state.selected = null; model.refresh(); }}>Back to background list</Button></div>
    </>
    : <>
      <ul className="background-list">{state.processes.map(process => <li key={process.id} className="background-card">
        <div className="background-card-head">
          <div className="background-card-info"><span className="background-state" data-state={process.state}><i aria-hidden="true" />{backgroundProcessStatus(process)}</span><code className="background-command" title={process.command}>{process.command}</code></div>
          <div className="background-card-actions"><Button type="button" variant="ghost" size="icon" className="quiet-icon" aria-label={`View log ${process.command}`} title="View log" onClick={() => state.select(process)}><ScrollText /></Button><Button type="button" variant="ghost" size="icon" className="quiet-icon background-stop" aria-label={`Request stop ${process.command}`} title="Request stop" disabled={blocked || process.stopVerified} onClick={() => void state.stop(process)}><Square /></Button></div>
        </div>
      </li>)}</ul>
      {!state.processes.length && <div className="file-panel-empty" role={state.reading ? "status" : undefined}>{state.reading ? "Loading background…" : "No background records in this chat."}</div>}
      <div className="background-actions"><Button variant="outline" size="sm" disabled={state.reading || !state.previousPages.length} onClick={() => state.previousPage()}>Previous page</Button><span className="background-meta">{state.totalCount} records</span><Button variant="outline" size="sm" disabled={state.reading || state.nextOffset === null} onClick={() => state.nextPage()}>Next page</Button><Button variant="ghost" size="sm" disabled={state.reading || !state.online()} onClick={() => void state.load()}>Refresh state</Button></div>
      <div className="background-actions"><Button variant="outline" size="sm" disabled={blocked} onClick={() => { state.endConfirm = true; model.refresh(); }}>{state.pendingEnd ? "Re-verify the original end request" : "End this chat's background"}</Button></div>
    </>}
  </section>;
}
