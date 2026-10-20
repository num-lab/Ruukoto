import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { CodeState } from '/code-state.ts';
import { Conversation } from '/conversation.tsx';
import '/style.css';
const at='2026-10-18T00:00:00.000Z';
const task={ id: "task", sessionId: "a", requestId: "r", input: "问题", inputPurpose: "user", modelSelection: null, submissionDigest: null, status: "running", accessMode: "confirm", planMode: false, permissionVersion: 1, sourcePermissionVersion: null, grantedPaths: [], pendingAccessMode: null, interruptReason: null, cancelRequested: false, effectUnknown: false, errorMessage: null, historyEntryIds: [], resumesTaskId: null, agentId: null, parentTaskId: null, sourceEventId: null, deadline: null, resultSummary: null, resultRef: null, workId: null, subAgentId: null, readScope: null, resultDeliveredAt: null, createdAt: at, startedAt: at, endedAt: null };
let refresh=()=>{};
const model=new CodeState({request:async()=>({ok:true,value:{text:'fixture output',patch:null,writeContent:null,toolName:'bash',isError:false,truncated:false,content:null}})},()=>refresh());
model.status={type:'state',state:'online'};
const view=model.view,session=view.openSession('a'),flow=session.flow;
session.historyLoaded=true;view.tasks.set('task',task);flow.task(task);
let seq=0;
function event(body){flow.apply({seq:++seq,sessionId:'a',taskId:'task',createdAt:new Date(Date.parse(at)+seq*100).toISOString(),body});}
function thinking(){event({type:'task.thinking',taskId:'task',sessionId:'a',thinkingId:'actual',messageId:'thinking',startedAt:at,endedAt:null,text:Array.from({length:24},(_,i)=>`Recorded line ${i+1}: `+'Long reasoning content for wrapped visual lines. '.repeat(3)).join('\n')});}
thinking();
function working(){event({type:'task.tool_intent',taskId:'task',toolOpId:'read',sdkCallId:'read',toolName:'read',params:{path:'src/example.ts'}});event({type:'task.tool_result',taskId:'task',toolOpId:'read',summary:'read',isError:false,artifactIds:[]});event({type:'task.tool_intent',taskId:'task',toolOpId:'bash',sdkCallId:'bash',toolName:'bash',params:{command:'pnpm test:unit'}});}
function final(){
 for(const [contentIndex,text]of [[0,'FINAL FIRST PART. '],[1,'FINAL SECOND PART.']])event({type:'task.output_fragment',taskId:'task',sessionId:'a',messageId:'final',contentIndex,text,totalBytes:text.length,truncated:false,startedAt:new Date(Date.parse(at)+2000+contentIndex).toISOString()});
 event({type:'task.output_entry',taskId:'task',sessionId:'a',messageId:'final',entryId:'final-entry',role:'assistant',sessionFile:'/fixture/session.jsonl'});
 flow.addHistory({entryId:'final-entry',taskId:'task',inputPurpose:'user',parentId:null,role:'assistant',text:'FINAL FIRST PART. FINAL SECOND PART.',timestamp:new Date(Date.parse(at)+2000).toISOString(),offset:0,totalBytes:36,truncated:false,toolCalls:[],toolCallId:null,toolName:null,isError:false,hasNonTextContent:false});
}
function complete(){event({type:'task.tool_result',taskId:'task',toolOpId:'bash',summary:'done',isError:false,artifactIds:[]});task.status='completed';task.endedAt=new Date(Date.parse(at)+4000).toISOString();flow.task(task);}
function Fixture(){const[,draw]=useState(0);const[narrow,setNarrow]=useState(false);useEffect(()=>{function record(event){if(event.target?.parentElement?.classList.contains('execution-trace')){const output=document.getElementById('animation-probe');output.textContent+=[event.type,event.animationName,event.target.id].join(':')+';';}}document.addEventListener('animationstart',record);document.addEventListener('animationend',record);return()=>{document.removeEventListener('animationstart',record);document.removeEventListener('animationend',record);};},[]);refresh=()=>draw(n=>n+1);const action=fn=>()=>{fn();refresh();};return <div style={{height:'100vh',display:'flex',flexDirection:'column',background:'var(--background)',color:'var(--foreground)'}}><nav style={{display:'flex',gap:16,padding:12}}><button onClick={action(working)}>Working fixture</button><button onClick={action(final)}>Final history fixture</button><button onClick={action(complete)}>Complete fixture</button><button onClick={()=>setNarrow(value=>!value)}>Width fixture</button><button onClick={()=>{document.documentElement.classList.toggle('dark');refresh();}}>Theme fixture</button></nav><output id="animation-probe" style={{fontSize:11}}/><div style={{height:'calc(100vh - 48px)',display:'flex',flexDirection:'column',width:narrow?'340px':'min(720px,100%)'}}><Conversation model={model} sessionId="a"/></div></div>;}
createRoot(document.getElementById('root')).render(<Fixture/>);
