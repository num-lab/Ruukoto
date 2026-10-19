import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CodeState } from '/code-state.ts';
import { ToolActivity } from '/tool-activity.tsx';
import { FilePreview } from '/inspector-panels.tsx';
import { ToolActivity as DemoActivity } from '/@fs/Users/eitrous/.codex/worktrees/6f13/ruukoto/.scratch/desktop-shadcn/demo/src/tool-activity.tsx';
import '/style.css';

const model = new CodeState({ request: async () => ({ ok: false, error: { code: 'fixture', message: '没有网络调用', outcome: 'not_sent' } }) }, () => {});
const at = '2026-10-18T08:00:00.000Z', flow = model.view.openSession('fixture').flow;
const first = Array.from({ length: 24 }, (_, index) => `记录第 ${index + 1} 行。`).join('\n');
let seq = 0, offset = 0;
function append(text) {
  flow.apply({ seq: ++seq, sessionId: 'fixture', taskId: 'task', createdAt: at, body: { type: 'task.thinking', sessionId: 'fixture', taskId: 'task', thinkingId: 'thought', messageId: 'message', text, offset, startedAt: at, endedAt: null } });
  offset += new TextEncoder().encode(text).length;
}
append(first);
const content = '文件开头\n' + ('完整文件内容 '.repeat(1500) + '\n').repeat(120) + 'FILE_PREVIEW_END_完整末尾';
function Fixture() {
  const [revision, draw] = useState(0), [following, setFollowing] = useState(true), [file, showFile] = useState(false);
  const thinking = flow.items.find(entry => entry.kind === 'thinking');
  const [expanded, setExpanded] = useState({});
  const onExpand = (key, open) => setExpanded(current => ({ ...current, [key]: open }));
  return <div style={{ height: '100vh', background: 'var(--background)', color: 'var(--foreground)' }}>
    <nav style={{ display: 'flex', gap: 16, padding: 12 }}><button onClick={() => { append(`\n追加第 ${revision + 1} 批\n` + '最新内容\n'.repeat(20) + `LATEST_${revision + 1}`); draw(revision + 1); }}>追加思考</button><button onClick={() => setFollowing(false)}>结束思考</button><button onClick={() => showFile(value => !value)}>显示完整文件</button><button onClick={() => document.documentElement.classList.toggle('dark')}>切换主题</button></nav>
    {file ? <div style={{ height: 'calc(100vh - 48px)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}><FilePreview file={{ path: 'large.txt', kind: 'text', content, size: new TextEncoder().encode(content).length }} path="large.txt" mode="source" onMode={() => {}} onFiles={() => {}} onUrl={() => {}} /></div> : <main id="outer-scroll" style={{ height: 480, overflowY: 'auto', padding: 16 }}><div style={{ height: 180 }}>主消息流位置标记</div><div id="desktop-reasoning" style={{ maxWidth: 600 }}><ToolActivity model={model} sessionId="fixture" tools={[]} thinking={thinking} phase={following ? 'thinking' : null} expanded={expanded} onExpand={onExpand} /></div><div id="demo-reasoning" style={{ maxWidth: 600, marginTop: 20 }}><DemoActivity step={{ type: 'activity', phase: following ? 'thinking' : undefined, items: [], thinking: { text: thinking.text, duration: '5s' } }} diffs={[]} stateKey="demo" expanded={expanded} onExpand={onExpand} onOpenFile={() => {}} onOpenAgent={() => {}} /></div><div style={{ height: 1000 }}>后续消息流位置标记</div></main>}
  </div>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
