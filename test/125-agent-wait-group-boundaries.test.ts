import { fixtureSubAgentDefinition } from "./helpers/subagent-definition.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { startTestRuntime } from "./helpers/testkit.ts";
import { registerAgentWait, endAgentWait, registerAgentReport, bindAgentReportFallback, listAgentReports, isAgentReportParked, parkAgentReportFallback, finishAgentReportFallback, getAgentReport, type AgentWaitTarget } from "@ruukoto/core/agent-wait.ts";
import type { Task } from "@ruukoto/core/types.ts";
import type { WorkflowSource } from "@ruukoto/core/workflow.ts";
import { product } from "../apps/ruukoto-code/src/product.ts";
test("不同父轮等待同原来源：停车只覆盖本轮固定目标，其他组后备仍可执行", async () => {
const t=await startTestRuntime("review-cross-group",()=>{throw new Error("不得请求模型");},{config:{product:product.runtime}});
try {
 const rt=t.runtime, store=rt.store;
 await rt.orchestrator?.stop();
 const s=await rt.createSession({projectName:"cross-group",cwd:t.work[0]});
 store.withTx(()=>store.setSessionQueueState(s.id,"paused","fixture"));
 const queued=(rid:string)=>store.insertQueuedTask({sessionId:s.id,requestId:rid,input:rid,modelSelection:rt.defaultSelection,submissionDigest:rid}).task;
 const origin=store.withTx(()=>{const task=queued("origin");store.endTask(task.id,["queued"],"completed");store.setTaskResult(task.id,"原始发起轮", "{}");return store.getTask(task.id)!;});
 const source: WorkflowSource={product:"ruukoto-code" as const,projectId:s.projectId,sessionId:s.id,taskId:origin.id,permissionVersion:origin.permissionVersion,accessMode:origin.accessMode,grantedPaths:[],capabilities:[],references:[],replyTarget:null,scheduledRunId:null};
 const child=(key:string,done:boolean)=>store.withTx(()=>{
  const sub=store.createSession({projectId:s.projectId,cwd:s.cwd,cwdReal:s.cwdReal,cwdDev:s.cwdDev,cwdIno:s.cwdIno,piSessionId:key,confirmTools:[]});
  store.insertSubAgent({ definition: fixtureSubAgentDefinition(),id:"agent-"+key,parentSessionId:s.id,sessionId:sub.id,workDir:s.cwdReal,activeWorkId:"work-"+key,currentTaskId:null,state:"idle",closedAt:null,closedBy:null,createdAt:s.createdAt});
  store.insertWorkDelegation({id:"work-"+key,parentSessionId:s.id,originTaskId:origin.id,subAgentId:"agent-"+key,requestKey:key,paramsDigest:key,canceledAt:null,canceledBy:null,cancelReason:null,writeTarget:null,createdAt:s.createdAt});
  const task=store.insertQueuedTask({sessionId:sub.id,requestId:key,input:key,modelSelection:rt.defaultSelection,submissionDigest:key,parentTaskId:origin.id,subAgentId:"agent-"+key,workId:"work-"+key}).task;
  store.transitionTask(task.id,["queued"],done?"completed":"running"); if(done)store.setTaskResult(task.id,key,"{}");return store.getTask(task.id)!;
 });
 const one=child("one",true),two=child("two",false),three=child("three",true);
 const wait=(parent: Task,targets: AgentWaitTarget[],id:string)=>store.withTx(()=>{
  registerAgentWait(store,{id,sdkCallId:id,deadline:null,taskId:parent.id,sessionId:s.id,targets,source,snapshot:{taskId:parent.id,permissionVersion:parent.permissionVersion,selectionRecordId:null,promptArtifactId:null,instructions:null,skills:null}});
  endAgentWait(store,id,"owner_input");
 });
 const parentC=store.withTx(()=>{const task=queued("parent-c");store.transitionTask(task.id,["queued"],"running");return store.getTask(task.id)!;});
 wait(parentC,[{kind:"task",taskId:three.id}],"wait-c");store.withTx(()=>store.endTask(parentC.id,["running"],"interrupted"));
 const parentA=store.withTx(()=>{const task=queued("parent-a");store.transitionTask(task.id,["queued"],"running");return store.getTask(task.id)!;});
 wait(parentA,[{kind:"task",taskId:one.id},{kind:"task",taskId:two.id}],"wait-a");store.withTx(()=>store.endTask(parentA.id,["running"],"interrupted"));
 const r1=store.withTx(()=>registerAgentReport(store,{target:{kind:"task",taskId:one.id},source,parentSessionId:s.id}));
 const r3=store.withTx(()=>registerAgentReport(store,{target:{kind:"task",taskId:three.id},source,parentSessionId:s.id}));
 const c1=store.withTx(()=>{const task=queued("canonical-a");bindAgentReportFallback(store,r1.key,task.id);return task;});
 const c3=store.withTx(()=>{const task=queued("canonical-c");bindAgentReportFallback(store,r3.key,task.id);return task;});
 await rt["routeAgentReportGroup"](r1);
 assert.equal(isAgentReportParked(store,c1.id), true);
 assert.equal(isAgentReportParked(store,c3.id), false, "本轮目标未齐不能停车另一父轮同来源后备");
 store.withTx(()=>{store.endTask(two.id,["running"],"completed");store.setTaskResult(two.id,"two","{}");});
 await rt["routeAgentReportGroup"](r1);
 assert.equal(isAgentReportParked(store,c1.id), false);
 assert.equal(isAgentReportParked(store,c3.id), false);
 assert.equal(listAgentReports(store).find(r=>r.key===r3.key)!.fallbackTaskId,c3.id);
 assert.equal(listAgentReports(store).find(r=>r.key===r3.key)!.fallbackState,"queued");
 assert.equal(listAgentReports(store).find(r=>r.key===r3.key)!.status,"pending");
 assert.equal(t.server.calls.length,0);
 store.withTx(()=>parkAgentReportFallback(store,c3.id,"group_waiting"));
 store.withTx(()=>{store.endTask(c3.id,["queued"],"canceled");finishAgentReportFallback(store,c3.id,{status:"undelivered",reason:"owner_canceled"});});
 assert.equal(getAgentReport(store,r3.key)!.status,"undelivered");
 assert.equal(getAgentReport(store,r3.key)!.fallbackState,"completed");
 assert.equal(getAgentReport(store,r3.key)!.fallbackTaskId,c3.id);
} finally { await t.shutdown(); }
});
