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
  return <section className="background-panel" aria-label="后台进程">
    {state.message && <p className="background-note" role="status">{state.message}</p>}
    {state.endConfirm ? <div className="background-section">
      <p className="background-meta">停止并核实本次结束请求涉及的后台；保留会话和历史。</p>
      <div className="background-actions"><Button variant="ghost" size="sm" onClick={() => { state.endConfirm = false; model.refresh(); }}>返回</Button><Button size="sm" disabled={blocked} onClick={() => void state.end()}>{state.pendingEnd ? "确认按原请求核实" : "确认结束本会话后台"}</Button></div>
    </div>
    : selected ? <>
      <div className="background-section">
        <p className="background-process-line"><b>{backgroundProcessStatus(selected)}</b><code>{selected.command}</code></p>
        <p className="background-meta">stdout {selected.stdoutBytes} B · stderr {selected.stderrBytes} B{selected.partial && " · 日志不完整"}</p>
        {selected.exit && <p className="background-meta">退出观察：{selected.exit.code ?? selected.exit.signal ?? "未知"}；停止核实单独显示</p>}
        {selected.reason && <p className="background-meta">{selected.reason}</p>}
        <div className="background-actions"><Button variant="outline" size="sm" disabled={blocked || selected.stopVerified} onClick={() => void state.stop(selected)}>请求停止</Button></div>
      </div>
      <Tabs value={state.stream} onValueChange={stream => void state.read(0, stream as "stdout" | "stderr")}><TabsList aria-label="后台日志流"><TabsTrigger value="stdout">stdout</TabsTrigger><TabsTrigger value="stderr">stderr</TabsTrigger></TabsList></Tabs>
      {output && <><p className="background-meta">{output.offset}–{output.nextOffset}/{output.totalBytes} B{output.partial && " · 日志不完整"}</p><pre tabIndex={0} className="background-log" aria-label={`${state.stream} 日志`}>{state.raw ? output.base64 : output.text || "（本页无输出）"}</pre></>}
      <div className="background-actions"><Button variant="outline" size="sm" disabled={state.reading || !state.previousOffsets.length} onClick={() => state.previousOutput()}>上一页日志</Button><Button variant="outline" size="sm" disabled={state.reading || !output || output.nextOffset >= output.totalBytes} onClick={() => state.nextOutput()}>下一页日志</Button><Button variant="ghost" size="sm" onClick={() => { state.raw = !state.raw; model.refresh(); }}>{state.raw ? "显示文本" : "查看原始字节（base64）"}</Button><Button variant="ghost" size="sm" disabled={state.reading || !state.online()} onClick={() => void state.read(output?.offset ?? 0)}>刷新本页</Button></div>
      <div className="background-actions"><Button variant="ghost" size="sm" onClick={() => { state.selected = null; model.refresh(); }}>返回后台列表</Button></div>
    </>
    : <>
      <ul className="background-list">{state.processes.map(process => <li key={process.id} className="background-card">
        <div className="background-card-head">
          <div className="background-card-info"><span className="background-state" data-state={process.state}><i aria-hidden="true" />{backgroundProcessStatus(process)}</span><code className="background-command" title={process.command}>{process.command}</code></div>
          <div className="background-card-actions"><Button type="button" variant="ghost" size="icon" className="quiet-icon" aria-label={`查看日志 ${process.command}`} title="查看日志" onClick={() => state.select(process)}><ScrollText /></Button><Button type="button" variant="ghost" size="icon" className="quiet-icon background-stop" aria-label={`请求停止 ${process.command}`} title="请求停止" disabled={blocked || process.stopVerified} onClick={() => void state.stop(process)}><Square /></Button></div>
        </div>
      </li>)}</ul>
      {!state.processes.length && <div className="file-panel-empty" role={state.reading ? "status" : undefined}>{state.reading ? "正在读取后台…" : "本会话没有后台记录。"}</div>}
      <div className="background-actions"><Button variant="outline" size="sm" disabled={state.reading || !state.previousPages.length} onClick={() => state.previousPage()}>上一页</Button><span className="background-meta">{state.totalCount} 条记录</span><Button variant="outline" size="sm" disabled={state.reading || state.nextOffset === null} onClick={() => state.nextPage()}>下一页</Button><Button variant="ghost" size="sm" disabled={state.reading || !state.online()} onClick={() => void state.load()}>刷新状态</Button></div>
      <div className="background-actions"><Button variant="outline" size="sm" disabled={blocked} onClick={() => { state.endConfirm = true; model.refresh(); }}>{state.pendingEnd ? "重核原结束请求" : "结束本会话后台"}</Button></div>
    </>}
  </section>;
}
