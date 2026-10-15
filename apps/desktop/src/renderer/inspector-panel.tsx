import { subAgentStateLabel, formatTaskStatus } from "@ruukoto/view/state.ts";
import type { CodeState } from "./code-state.ts";
import { Conversation } from "./conversation.tsx";
import { diffDisplay, parsePatch } from "./diff.ts";

export function InspectorPanel({ model }: { model: CodeState }) {
  const inspector = model.inspector;
  const tool = inspector.selectedTool();
  const display = tool ? diffDisplay(tool, inspector.result?.value) : null;
  const agents = inspector.agents();
  const works = inspector.workDelegations();
  return <aside className="inspector" aria-label="会话详情">
    <nav className="inspector-tabs" aria-label="详情页"><button aria-current={inspector.tab === "agents" ? "page" : undefined} onClick={() => { inspector.tab = "agents"; model.refresh(); }}>SubAgent</button><button aria-current={inspector.tab === "diff" ? "page" : undefined} onClick={() => { inspector.tab = "diff"; model.refresh(); }}>差异</button></nav>
    {inspector.tab === "agents" ? <>
      <div className="delegations">
        <header><strong>工作委托</strong><button disabled={inspector.loadingWorks} onClick={() => void inspector.loadWorks()}>刷新</button></header>
        {inspector.workError && <p role="alert">{inspector.workError}</p>}
        {works.map((work, index) => <button className="work-choice" aria-pressed={inspector.workId === work.id} key={work.id} onClick={() => { void inspector.selectWork(work.id); model.refresh(); }}>工作委托 {index + 1}{work.canceledAt ? " · 已取消" : ""}</button>)}
        {works.length === 0 && <p className="muted">{inspector.loadingWorks ? "正在加载工作委托…" : "暂无工作委托。"}</p>}
        {inspector.detail && <div className="work-detail">{inspector.detail.tasks.map(task => <p key={task.id}>{formatTaskStatus(model.view.getTask(task.id)?.status ?? task.status)} · {task.input}{task.resultSummary && <small>{task.resultSummary}</small>}</p>)}</div>}
        <header><strong>SubAgent</strong></header>
        {agents.map((agent, index) => <button className="agent-choice" aria-pressed={inspector.childSessionId === agent.sessionId} key={agent.id} onClick={() => inspector.selectChild(agent.sessionId)}>SubAgent {index + 1}<span>{subAgentStateLabel(agent)}</span></button>)}
        {agents.length === 0 && <p className="muted">暂无 SubAgent。</p>}
      </div>
      {inspector.childSessionId ? <Conversation key={`${model.view.instanceId}:${inspector.childSessionId}`} model={model} sessionId={inspector.childSessionId} /> : <p className="inspector-hint muted">选择 SubAgent，查看思考、工具活动与对话记录。</p>}
    </> : <div className="diff-content">
      {tool && display ? <><header><strong>{tool.name}</strong><span>{{ status: "状态", error: "失败", effect_unknown: "效果未知", unavailable: "差异不可用", patch: "编辑差异", write: "写入内容" }[display.kind]}</span></header><p className="diff-target">{tool.target}</p>
        {inspector.result?.error && <p role="alert">{inspector.result.error}<button onClick={() => { inspector.result = null; void inspector.loadDiff(); model.refresh(); }}>重试</button></p>}
        {display.truncated && <p className="diff-truncated" role="status">结果已截断（最多 64 KiB）</p>}
        {display.kind === "patch" ? <pre className="patch" aria-label="编辑差异">{parsePatch(display.text).map((line, index) => <span className={`patch-${line.kind}`} key={index}>{line.text}{"\n"}</span>)}</pre> : display.kind === "write" ? display.text === "" ? <p>空文件（0 行）</p> : <pre className="write-content">{display.text}</pre> : (!inspector.result?.error || display.kind === "error" || display.kind === "effect_unknown") && <p className="diff-state">{display.text}</p>}
      </> : <p className="muted">点击对话中的 edit 或 write 工具，查看这次调用的差异。</p>}
    </div>}
  </aside>;
}
