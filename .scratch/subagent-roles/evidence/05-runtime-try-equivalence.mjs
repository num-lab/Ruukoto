import ts from '/Users/eitrous/orca/workspaces/ruukoto/subagent-roles/node_modules/typescript/lib/typescript.js';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root='/Users/eitrous/orca/workspaces/ruukoto/subagent-roles';
const oldPath=root+'/.scratch/subagent-roles/evidence/05-runtime-before-try-narrowing.ts';
const newPath=root+'/packages/runtime/src/runtime.ts';
const source=p=>ts.createSourceFile(p,fs.readFileSync(p,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const old=source(oldPath), current=source(newPath), printer=ts.createPrinter();
const members=sf=>sf.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='Runtime').members;
const method=(sf,name)=>members(sf).find(n=>ts.isMethodDeclaration(n)&&n.name.getText(sf)===name);
const print=(sf,n)=>printer.printNode(ts.EmitHint.Unspecified,n,sf);
const a=method(old,'verifySubAgentSource'), b=method(current,'verifySubAgentSource'), helper=method(current,'subAgentSourceProblem');
const oldTry=a.body.statements.find(ts.isTryStatement), newTry=b.body.statements[0];
assert.equal(b.body.statements.length,1);
assert.ok(ts.isTryStatement(newTry));
assert.equal(newTry.tryBlock.statements.length,1);
assert.equal(print(current,newTry.tryBlock.statements[0]),'return this.subAgentSourceProblem(task, finalReport);');
assert.deepEqual(helper.body.statements.map(n=>print(current,n)),[a.body.statements[0],...oldTry.tryBlock.statements].map(n=>print(old,n)));
assert.equal(print(old,oldTry.catchClause),print(current,newTry.catchClause));
const findTry=node=>{if(ts.isTryStatement(node))return node;let found;ts.forEachChild(node,n=>{found??=findTry(n);});return found;};
const aw=method(old,'agentWaitSource'), bw=method(current,'agentWaitSource'), ot=findTry(aw), nt=findTry(bw);
assert.equal(ot.tryBlock.statements.length,3);assert.equal(nt.tryBlock.statements.length,1);
assert.equal(print(old,ot.catchClause),print(current,nt.catchClause));
const oldInitializer=ot.tryBlock.statements[0].declarationList.declarations[0].initializer;
const assignment=nt.tryBlock.statements[0].expression;
assert.ok(ts.isBinaryExpression(assignment));assert.equal(assignment.left.getText(current),'original');
assert.equal(print(old,oldInitializer),print(current,assignment.right));
const newElse=nt.parent, index=newElse.statements.indexOf(nt);
assert.equal(print(old,ot.tryBlock.statements[1]),print(current,newElse.statements[index+1]));
assert.equal(print(old,ot.tryBlock.statements[2]),print(current,newElse.statements[index+2]));
const unchanged=[];
for(const n of members(old)){
 const name=n.name?.getText(old);if(['verifySubAgentSource','agentWaitSource'].includes(name))continue;
 const other=members(current).find(x=>x.kind===n.kind&&x.name?.getText(current)===name);
 assert.ok(other,name);assert.equal(print(old,n),print(current,other),name);unchanged.push(name??ts.SyntaxKind[n.kind]);
}
assert.equal(members(current).length,members(old).length+1);
const multiple=[];
for(const file of ['packages/runtime/src/runtime.ts','packages/runtime/src/parent-delivery.ts','packages/agent/src/driver.ts']){
 const sf=source(root+'/'+file), diff=execFileSync('git',['diff','--unified=0','--',file],{cwd:root,encoding:'utf8'});
 const ranges=[...diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)].map(m=>[Number(m[1]),Number(m[1])+Number(m[2]??1)-1]);
 const visit=n=>{if(ts.isTryStatement(n)&&n.tryBlock.statements.length>1){const start=sf.getLineAndCharacterOfPosition(n.tryBlock.getStart(sf)).line+1,end=sf.getLineAndCharacterOfPosition(n.tryBlock.end).line+1;if(ranges.some(([a,b])=>a<=end&&b>=start))multiple.push({file,start,end,statements:n.tryBlock.statements.length});}ts.forEachChild(n,visit);};visit(sf);
}
assert.deepEqual(multiple,[]);
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const result={oldSha256:sha(oldPath),newSha256:sha(newPath),validationBodyStatementOrderEqual:true,typedCatchClausesEqual:true,originalSourceCallAndMovedStatementsEqual:true,otherRuntimeMembersAstEqual:unchanged.length,newPrivateHelperCount:1,multiStatementTryIntersectingChangedProduction:multiple,scope:'TypeScript AST审查不证明所有运行时行为；已另跑真实Runtime边界/恢复和原缺execution反例'};
fs.writeFileSync('/tmp/05-runtime-try-equivalence.json',JSON.stringify(result,null,2)+'\n');process.stdout.write(JSON.stringify(result,null,2)+'\n');
