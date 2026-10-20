from pathlib import Path
import json
b=Path('/tmp/ruukoto-full-26-linux.9wDa5g');repo=Path('/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable')
s=(b/'probe-entry.mjs').read_text()
s=s.replace("if(!restore)await p.harness.commit(async tx=>{(await tx.doc(PersonalPermissionsDoc)).mode='full_access';},context);", "if(!restore)await p.harness.commit(async tx=>{(await tx.doc(PersonalPermissionsDoc)).mode=f.name==='restricted'?'confirm':'full_access';},context);")
s=s.replace("let crashArmed=f.name", "if(f.name==='restricted')f.command=f.command.replaceAll('__TEST_ROOT__',f.root).replaceAll('__TEST_URL__',process.env.RUUKOTO_FULL_TEST_URL);\n  let crashArmed=f.name")
s=s.replace("if(f.name!=='normal'){\n        await until(()=>false,'external SIGKILL',120000);\n      }", """if(f.name==='cancel-full'){
        await until(()=>fs.existsSync(path.join(f.workspace,'count'))&&fs.existsSync(path.join(f.root,'heartbeat')),'cancel after real external effect');
        const canceled=p.work.cancel(work);
        await until(async()=>{const detail=await p.commands.detail(ref,'stdout');return detail.result?.effect==='effect_unknown'&&detail.result.code!=='started'&&detail.stopped;},'cancel original execution stopped but effect unknown');
        assert.deepEqual((await p.work.list()).find(agent=>agent.id===work.agentId).work,work);
        assert.equal(await p.answer('独立聊天继续','independent'),'完成');
        const heartbeat=fs.readFileSync(path.join(f.root,'heartbeat'),'utf8');await sleep(200);assert.equal(fs.readFileSync(path.join(f.root,'heartbeat'),'utf8'),heartbeat);
        write(path.join(f.root,'cancel-before-resolution.json'),{detail:await p.commands.detail(ref,'stdout'),agents:await p.work.list(),heartbeatFrozen:true});
        await p.harness.commit(tx=>resolvePersonalCommand(tx,ref,'applied','原专属count仅一行x，取消后原setsid心跳已冻结。'),context);
        assert.equal((await bounded(canceled,'canceled work released')).state.outcome.status,'aborted');
      }else if(!['normal','restricted'].includes(f.name)){
        await until(()=>false,'external SIGKILL',120000);
      }""")
s=s.replace("assert.equal(settled.state.outcome.status,'completed');", "assert.equal(settled.state.outcome.status,f.name==='cancel-full'?'aborted':'completed');")
s=s.replace("assert.equal(op.work.permission.mode,'full_access');assert.equal(op.prepared.spec.mode,'full_access');assert.deepEqual([op.prepared.input.env,op.prepared.input.mounts,op.prepared.input.runtimeReadRoots,op.prepared.input.toolAliases],[{},[],[],[]]);", "assert.equal(op.work.permission.mode,f.name==='restricted'?'confirm':'full_access');assert.equal(op.prepared.spec.mode,op.work.permission.mode);if(f.name!=='restricted')assert.deepEqual([op.prepared.input.env,op.prepared.input.mounts,op.prepared.input.runtimeReadRoots,op.prepared.input.toolAliases],[{},[],[],[]]);")
s=s.replace("const reused=await p.work.delegate", """if(f.name==='restricted'){
      const facts=read(path.join(f.workspace,'restricted-facts.json'));
      assert.equal(facts.readDenied,true);assert.equal(facts.writeDenied,true);assert.equal(facts.networkDenied,true);assert.equal(facts.secretVisible,false);assert.equal(networkCount,0);assert.equal(fs.existsSync(path.join(f.root,'outside-written')),false);
      write(path.join(f.root,'restricted-facts-verified.json'),{...facts,networkCount});
    }
    const reused=await p.work.delegate""")
s=s.replace("for(const name of ['normal','no-receipt-crash','receipt-before-observation','stop-unverified'])", "for(const name of ['normal','no-receipt-crash','receipt-before-observation','stop-unverified','cancel-full','restricted'])")
# Insert alternative commands before fixture construction.
anchor="const f={name,root,workspace,profile,config,command,inputFile:path.join(root,'fixture.json')};"
assert anchor in s
canceljs="const fs=require('fs'),{spawn}=require('child_process');const code=\"const fs=require('fs');fs.appendFileSync(process.env.RUUKOTO_FULL_TEST_HEARTBEAT,'x');setInterval(()=>fs.appendFileSync(process.env.RUUKOTO_FULL_TEST_HEARTBEAT,'x'),25)\";spawn(process.execPath,['-e',code],{detached:true,stdio:'ignore'}).unref();"
quote=lambda v:"'"+v.replace("'","'\\''")+"'"
cancelcmd="printf 'x\\n' >> count; /usr/local/bin/node -e "+quote(canceljs)+"; printf started; sleep 120"
restrictedjs="const fs=require('fs'),http=require('http');let readDenied=false,writeDenied=false;try{fs.readFileSync('__TEST_ROOT__/outside-readable')}catch{readDenied=true}try{fs.writeFileSync('__TEST_ROOT__/outside-written','x')}catch{writeDenied=true}const done=networkDenied=>fs.writeFileSync('restricted-facts.json',JSON.stringify({readDenied,writeDenied,networkDenied,secretVisible:!!process.env.RUUKOTO_FULL_SYNTHETIC_SECRET}));http.get('__TEST_URL__',r=>{r.resume();r.on('end',()=>done(false))}).on('error',()=>done(true));"
restrictedcmd="printf 'x\\n' >> count; /usr/local/bin/node -e "+quote(restrictedjs)
s=s.replace(anchor,"const actualCommand=name==='cancel-full'?"+json.dumps(cancelcmd)+":name==='restricted'?"+json.dumps(restrictedcmd)+":command;\n      fs.writeFileSync(path.join(root,'outside-readable'),'outside fixture');\n      const f={name,root,workspace,profile,config,command:actualCommand,inputFile:path.join(root,'fixture.json')};")
s=s.replace("if(name==='normal'){const exit=await child.finished;assert.equal(exit.code,0,fs.readFileSync(path.join(root,'owner.stderr'),'utf8'));}", """if(['normal','cancel-full','restricted'].includes(name)){const exit=await child.finished;assert.equal(exit.code,0,fs.readFileSync(path.join(root,'owner.stderr'),'utf8'));
        if(name==='normal'){
          const copiedProfile=path.join(root,'old-profile');fs.cpSync(profile,copiedProfile,{recursive:true});fs.chmodSync(copiedProfile,0o700);
          const oldInput=path.join(root,'old-fixture.json');write(oldInput,{...f,profile:copiedProfile});
          const old=spawn(process.execPath,[path.join(path.dirname(self),'linux-command-probe-old.mjs'),oldInput],{stdio:['ignore',fs.openSync(path.join(root,'old.stdout'),'a'),fs.openSync(path.join(root,'old.stderr'),'a')]});
          const oldExit=await new Promise(resolve=>old.once('close',(code,signal)=>resolve({code,signal})));assert.equal(oldExit.code,0,fs.readFileSync(path.join(root,'old.stderr'),'utf8'));
        }
      }""")
(b/'probe-entry.mjs').write_text(s)
# old program opens only an independent copy of the new full profile, before the original fixture is removed.
old="""import assert from 'node:assert/strict';import * as fs from 'node:fs';import * as path from 'node:path';
import {openPersonalHarness} from 'REPO/apps/ruukoto/src/personal-harness.ts';
import {personalProvider} from 'REPO/apps/ruukoto/src/personal-model.ts';
import {MockModelServer} from 'REPO/test/helpers/mock-provider.ts';
const f=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),server=new MockModelServer(()=>({kind:'text',text:'unexpected'}));
const model={api:'openai-completions',baseUrl:await server.start(),modelId:'mock-model',apiKeyEnv:'RUUKOTO_OLD_TEST_KEY',contextWindow:128000,maxTokens:1024};process.env[model.apiKeyEnv]='test-only';
let p;try{let rejected;try{p=await openPersonalHarness({directory:f.profile,commands:f.config,provider:personalProvider(model),modelId:model.modelId})}catch(error){rejected={code:error.code,message:error.message}}assert.equal(rejected?.code,'command_record_invalid');assert.equal(server.calls.length,0);fs.writeFileSync(path.join(f.root,'old-refusal.json'),JSON.stringify({commit:'89b37f3',profileCopy:f.profile,rejected,modelCalls:server.calls.length,originalProfileModified:false},null,2)+'\\n');}finally{await p?.close();await server.close()}
""".replace('REPO',str(repo))
(b/'old-entry.mjs').write_text(old)
oldbuild=(b/'build-probe.mjs').read_text().replace("import { pathToFileURL }", "import {execFileSync} from 'node:child_process';\nimport { pathToFileURL }")
oldbuild=oldbuild.replace("'probe-entry.mjs'","'old-entry.mjs'").replace("linux-command-probe.mjs","linux-command-probe-old.mjs").replace("source-manifest.json","old-source-manifest.json").replace("metafile.json","old-metafile.json")
oldbuild=oldbuild.replace("const source=fs.readFileSync(args.path,'utf8')", "const source=execFileSync('git',['show','89b37f3:'+relative],{cwd:repo,encoding:'utf8'})")
# Snapshot old source instead of overwriting the new production snapshot.
oldbuild=oldbuild.replace("path.join(local,'source',relative)","path.join(local,'old-source',relative)")
oldbuild=oldbuild.replace("fs.copyFileSync(file,dest);records.push({path:relative,sha256:sha(fs.readFileSync(file))})", "fs.writeFileSync(dest,execFileSync('git',['show','89b37f3:'+relative],{cwd:repo}));records.push({path:relative,sha256:sha(fs.readFileSync(dest))})")
(b/'build-old.mjs').write_text(oldbuild)
