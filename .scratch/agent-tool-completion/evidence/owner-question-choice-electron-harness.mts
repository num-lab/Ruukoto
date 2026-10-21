import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { afterTool, lastUserText, realTools, startTestRuntime, waitFor } from "../../../test/helpers/testkit.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { ControlServer } from "@ruukoto/control/server.ts";
import { product } from "../../../apps/ruukoto-code/src/product.ts";
// 从仓库根运行；先构建桌面。隐藏窗口只用于 CDP 验收，正式源码不改。
const repository = process.cwd();
const main = path.join(repository, "apps/desktop/out/main");
const source = fs.readFileSync(path.join(main, "index.js"), "utf8");
assert.equal(source.split("new BrowserWindow({").length, 2);
const probe = path.join(main, "owner-question-choice-probe.js");
fs.writeFileSync(probe, source.replace("new BrowserWindow({", "new BrowserWindow({ show: false,").replace("focused: () => !!window?.isFocused()", "focused: () => true"));
const controlDir = fs.mkdtempSync("/tmp/oq-control-");
const t = await startTestRuntime("owner-choice-electron", req => lastUserText(req) === "ASK" && !afterTool(req) ? {kind:"tool_calls",calls:[{id:"ask",name:"ask_user",arguments:{questions:[{"question":"这次需要交付哪些内容？","multiple":true,"options":[{"label":"桌面界面","description":"同步调整交互与视觉布局。","recommended":true},{"label":"接口和存储","description":"保存并恢复所有回答。"},{"label":"相关文档","description":"补充使用说明与验收记录。"}]},{"question":"需要补充什么要求？"},{"question":"采用哪种交付方式？","options":[{"label":"直接完成","description":"完成实现和必要检查。","recommended":true},{"label":"分步确认","description":"每一步完成后先确认再继续。"}]}]}}]} : {kind:"text",text:"已收到实际回答"}, {config:{...realTools(),product:product.runtime,controlDir,socketPath:undefined}});
let rt = t.runtime;
let loseAnswer = false, lostAnswer = false, releaseAnswer = () => {};
function bindLoss() {
 const answer = rt.answerOwnerQuestion.bind(rt);
 rt.answerOwnerQuestion = async input => {
  const result = await answer(input);
  if (loseAnswer) { loseAnswer = false; lostAnswer = true; await new Promise<void>(resolve => { releaseAnswer = resolve; }); }
  return result;
 };
}
bindLoss();
const session = (await rt.openWorkspace({cwd:t.work[0],mode:"full_access",modelSelection:rt.defaultSelection})).session;
let count = 0;
async function ask() {
 const task = await rt.submit({sessionId:session.id,requestId:`ask_${++count}`,input:"ASK",modelSelection:rt.defaultSelection});
 await waitFor("问题登记",()=>rt.store.getTask(task.id)?.status==="completed");
 return rt.listOwnerQuestions(session.id).questions.find(q=>q.status==="pending");
}
const question = await ask();
const config = {product:product.runtime,dataDir:t.dirs.dataDir,agentDir:t.dirs.agentDir,socketPath:rt.socketPath(),controlDir,modelProvider:"mock",modelId:"mock-model",thinkingLevel:"off" as const,...realTools()};
for(let index=1;index<=2;index++){
 const userDir=path.join(t.dirs.root,`electron_${index}`);fs.mkdirSync(userDir);
 const code=`const {app}=require('electron'); app.setPath('userData',${JSON.stringify(userDir)}); app.setActivationPolicy('prohibited'); Object.assign(process.env,${JSON.stringify({RUUKOTO_DESKTOP_MANAGED:'1',RUUKOTO_CODE_DATA_DIR:t.dirs.dataDir,RUUKOTO_CODE_AGENT_DIR:t.dirs.agentDir,RUUKOTO_CODE_CONTROL_DIR:controlDir})}); import(${JSON.stringify(probe)});`;
 fs.writeFileSync(path.join(t.dirs.root,`desktop_${index}.cjs`),code);
}
process.stdout.write(JSON.stringify({root:t.dirs.root,dataDir:t.dirs.dataDir,agentDir:t.dirs.agentDir,controlDir:rt.controlDir(),sessionId:session.id,question})+"\n");
for await(const line of readline.createInterface({input:process.stdin})){
 const action=line.trim();
 if(action==="ask") process.stdout.write(JSON.stringify({question:await ask()})+"\n");
 else if(action==="status") process.stdout.write(JSON.stringify({lostAnswer,questions:rt.listOwnerQuestions(session.id).questions,tasks:rt.store.listTasksBySession(session.id).map(task=>({requestId:task.requestId,status:task.status,id:task.id}))})+"\n");
 else if(action==="lose-next-answer") {loseAnswer=true;process.stdout.write("LOSS_ARMED\n");}
 else if(action==="restart") {await rt.stop("desktop_reconnect");releaseAnswer();rt=await Runtime.start(config);bindLoss();await ControlServer.start(rt);process.stdout.write("RESTARTED\n");}
 else if(action==="end") break;
}
await rt.stop("desktop_end");await t.shutdown();fs.rmSync(controlDir,{recursive:true,force:true});fs.unlinkSync(probe);
