import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { recheckServiceInspection, PersonalInspectionDoc, PersonalPendingInspectionsDoc } from '../../../../../apps/ruukoto/src/personal-service-inspection.ts';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-inspection-cas-audit-'));
const helperPath = path.join(root, 'helper.mjs');
fs.writeFileSync(helperPath, `import fs from 'node:fs'; import path from 'node:path'; import {setTimeout as delay} from 'node:timers/promises'; const dir=path.dirname(process.argv[1]); const [verb,inspectionId,machineId]=process.argv.slice(2); fs.writeFileSync(path.join(dir,'started'),''); while(!fs.existsSync(path.join(dir,'release'))) await delay(5); process.stderr.write('RUUKOTO_SERVICE_REPLY '+JSON.stringify({v:1,verb,ok:true,inspectionId,machineId,exited:true})+'\\n');`);
const i1 = {taskId:1,conversationId:1,taskKind:'pi.tool',unit:'audit.service',machineId:'audit-machine',inspectionId:'inspect_'+'1'.repeat(24),sources:[1],generation:2,admission:3,stopped:false};
const i2 = {...i1,inspectionId:'inspect_'+'2'.repeat(24),admission:4};
let record = {inspection:structuredClone(i1)};
const pending = {tasks:[1]};
const evidence = [];
const tx = {async doc(token) { if(token.definition.kind===PersonalInspectionDoc.definition.kind) return record; assert.equal(token.definition.kind,PersonalPendingInspectionsDoc.definition.kind); return pending; },async appendEntry(token,conversationId,value) { const entry={id:20+evidence.length,kind:token.kind,conversationId,...value}; evidence.push(entry); return entry; }};
const harness = {async snapshot() {return structuredClone(record);},async commit(change) {return change(tx);}};
try {
  const running=recheckServiceInspection(harness,{helperPath,policyPath:path.join(root,'policy'),sudoPath:'/usr/bin/sudo',useSudo:false,timeouts:{stopMs:3000}},1);
  const deadline=Date.now()+3000;
  while(!fs.existsSync(path.join(root,'started'))) {assert.ok(Date.now()<deadline,'helper did not start');await delay(5);}
  record={inspection:structuredClone(i2)};
  fs.writeFileSync(path.join(root,'release'),'');
  await running;
  assert.equal(record.inspection.inspectionId,i2.inspectionId);
  assert.equal(record.inspection.stopped,false);
  assert.deepEqual(pending.tasks,[1]);
  assert.equal(evidence.length,1);
  assert.equal(evidence[0].data.inspectionId,i1.inspectionId);
  process.stdout.write('PASS: late I1 proof retains I2 occupancy and saves I1 evidence\n');
} finally {fs.rmSync(root,{recursive:true,force:true});}
