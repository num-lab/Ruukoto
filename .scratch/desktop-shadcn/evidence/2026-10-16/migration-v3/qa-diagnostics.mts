import * as fs from 'node:fs';
import * as path from 'node:path';
import { ControlClient } from '/Users/eitrous/.codex/worktrees/6f13/ruukoto/packages/control/src/client.ts';
import { authenticateClient } from '/Users/eitrous/.codex/worktrees/6f13/ruukoto/test/helpers/testkit.ts';
const m=JSON.parse(fs.readFileSync('prepared.json','utf8'));
const client=await ControlClient.connect(path.join(m.controlDir,'control.sock'));
await authenticateClient(client,m.controlDir);
try {
  const snapshot=await client.handshake();
  const status=JSON.parse(fs.readFileSync('backend-status.json','utf8'));
  const taskId=status.live.at(-1).id;
  const events=await client.request('read_task_events',{task_id:taskId,after_seq:0,limit:100});
  const task=await client.request('get_task',{task_id:taskId});
  const history=await client.request('read_history',{session_id:m.liveSessionId,limit:50});
  const tools=[];
  for(const entry of history.entries.filter(x=>x.role==='toolResult')) tools.push(await client.request('read_history_entry',{session_id:m.liveSessionId,entry_id:entry.entryId,length:65536}));
  fs.writeFileSync(process.argv[2] ?? 'working-result-diagnostic.json',JSON.stringify({capturedAt:new Date().toISOString(),taskId,task,events,history,toolEntries:tools},null,2)+'\n');
} finally {client.close();}
