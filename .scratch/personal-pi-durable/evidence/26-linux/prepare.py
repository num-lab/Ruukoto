from pathlib import Path
import json
repo=Path('/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable')
b=Path('/tmp/ruukoto-full-26-linux.9wDa5g')
r='/tmp/ruukoto-full-26.R7idsd'
old='/tmp/ruukoto-command-config-20261017-cc89'
script=(repo/'.scratch/personal-pi-durable/evidence/25-linux/build-probe.mjs').read_text().replace(old,str(repo)).replace('/tmp/ruukoto-command-25-linux-20261017',str(b)).replace('/tmp/ruukoto-command-25.sSTsx4',r)
(b/'build-probe.mjs').write_text(script)
s=(repo/'.scratch/personal-pi-durable/evidence/25-linux/probe-entry.mjs').read_text().replace(old,str(repo))
s=s.replace("import { createHash } from 'node:crypto';", "import { createHash, randomBytes } from 'node:crypto';\nimport { createServer } from 'node:http';")
s=s.replace("import { MockModelServer }", "import { PersonalPermissionsDoc } from '"+str(repo)+"/apps/ruukoto/src/personal-permissions.ts';\nimport { MockModelServer }")
s=s.replace("async function owner(f,restore=false){", """async function owner(f,restore=false){
  const secret=randomBytes(24).toString('hex');
  const controls=['RUUKOTO_OWNER_TOKEN','RUUKOTO_OWNER_TOKEN_FILE','RUUKOTO_CONTROL_DIR','RUUKOTO_CODE_CONTROL_DIR'];
  process.env.RUUKOTO_FULL_SYNTHETIC_SECRET=secret;
  for(const key of controls)process.env[key]='synthetic-internal-control';
  process.env.PATH='/synthetic-full-26:'+process.env.PATH;
  let networkCount=0;
  const network=createServer((req,res)=>{networkCount++;res.writeHead(200);res.end('full-network-ok');});
  await new Promise(resolve=>network.listen(0,'127.0.0.1',resolve));
  process.env.RUUKOTO_FULL_TEST_URL='http://127.0.0.1:'+network.address().port;
  process.env.RUUKOTO_FULL_TEST_OUTSIDE=path.join(f.root,'outside-result.json');
  process.env.RUUKOTO_FULL_TEST_HEARTBEAT=path.join(f.root,'heartbeat');
""")
s=s.replace("p=await openPersonalHarness(options);", "p=await openPersonalHarness(options);\n    if(!restore)await p.harness.commit(async tx=>{(await tx.doc(PersonalPermissionsDoc)).mode='full_access';},context);")
s=s.replace("assert.equal(nativeTask.owner,work.taskId);", "assert.equal(nativeTask.owner,work.taskId);assert.equal(op.work.permission.mode,'full_access');assert.equal(op.prepared.spec.mode,'full_access');assert.deepEqual([op.prepared.input.env,op.prepared.input.mounts,op.prepared.input.runtimeReadRoots,op.prepared.input.toolAliases],[{},[],[],[]]);\n    assert.ok(!JSON.stringify(op.prepared).includes(secret));assert.ok(!fs.readFileSync(path.join(commandRecord(f,op),'request.json'),'utf8').includes(secret));")
s=s.replace("if(f.name==='normal'){\n      assert.equal(op.result.effect", """if(f.name==='normal'){
      const facts=read(path.join(f.root,'outside-result.json'));
      assert.equal(facts.uid,process.getuid());assert.equal(facts.home,process.env.HOME);assert.equal(facts.pathPrefix,true);assert.equal(facts.secretLength,48);assert.deepEqual(facts.controls,controls.map(()=>false));assert.equal(facts.network,'full-network-ok');assert.equal(networkCount,1);
      const beat=fs.readFileSync(path.join(f.root,'heartbeat'),'utf8');await sleep(200);assert.equal(fs.readFileSync(path.join(f.root,'heartbeat'),'utf8'),beat,'setsid heartbeat must stop');
      write(path.join(f.root,'full-access-facts.json'),{...facts,networkCount,heartbeatFrozen:true,secretAbsentFromPrepared:true,secretAbsentFromRequest:true});
      assert.equal(op.result.effect""")
s=s.replace("}finally{await p?.close();await server.close();}", "}finally{await p?.close();await server.close();await new Promise(resolve=>network.close(resolve));}")
# A standalone full-access script deliberately crosses the configured initial directory and accesses loopback.
normal_js="""const fs=require('fs'),http=require('http'),{spawn}=require('child_process');const keys=['RUUKOTO_OWNER_TOKEN','RUUKOTO_OWNER_TOKEN_FILE','RUUKOTO_CONTROL_DIR','RUUKOTO_CODE_CONTROL_DIR'];http.get(process.env.RUUKOTO_FULL_TEST_URL,res=>{let network='';res.on('data',d=>network+=d);res.on('end',()=>{fs.writeFileSync(process.env.RUUKOTO_FULL_TEST_OUTSIDE,JSON.stringify({uid:process.getuid(),home:process.env.HOME,pathPrefix:process.env.PATH.startsWith('/synthetic-full-26:'),secretLength:process.env.RUUKOTO_FULL_SYNTHETIC_SECRET?.length,controls:keys.map(k=>process.env[k]!==undefined),network}));const code=\"const fs=require('fs');fs.appendFileSync(process.env.RUUKOTO_FULL_TEST_HEARTBEAT,'x');setInterval(()=>fs.appendFileSync(process.env.RUUKOTO_FULL_TEST_HEARTBEAT,'x'),25)\";const child=spawn(process.execPath,['-e',code],{detached:true,stdio:'ignore'});child.unref();const wait=setInterval(()=>{if(fs.existsSync(process.env.RUUKOTO_FULL_TEST_HEARTBEAT)){clearInterval(wait)}},10);});}).on('error',e=>{console.error(e);process.exitCode=88});"""
# shell quote the JavaScript without shell interpolation.
quoted="'"+normal_js.replace("'", "'\\''")+"'"
old_command='const command=name===\'normal\'?"printf x\\\\n >> /dev/null; printf x >> count; printf \'\\\\n\' >> count; head -c 7000 /dev/zero; printf \'\\\\000\\\\377A\'; printf \'\\\\200\\\\000Z\' >&2; exit 37"'
assert old_command in s
normal_cmd="/usr/local/bin/node -e "+quoted+"; printf x >> count; printf '\\n' >> count; head -c 7000 /dev/zero; printf '\\000\\377A'; printf '\\200\\000Z' >&2; exit 37"
s=s.replace(old_command,"const command=name==='normal'?"+json.dumps(normal_cmd))
(b/'probe-entry.mjs').write_text(s)
(b/'paths.json').write_text(json.dumps({'repo':str(repo),'local':str(b),'remote':r},indent=2)+'\n')
