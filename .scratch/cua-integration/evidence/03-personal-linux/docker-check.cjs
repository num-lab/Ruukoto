const assert=require('node:assert/strict');
const fs=require('node:fs');
const {execFileSync}=require('node:child_process');
const {personalCuaLinux}=require('./host.cjs');
const docker=args=>execFileSync('/usr/bin/docker',['--host','unix:///var/run/docker.sock',...args],{encoding:'utf8'}).trim();
(async()=>{
 const host=personalCuaLinux();
 const id=docker(['create','--network','none','--restart','no','--name','ruukoto-cua-lifecycle-'+Date.now(),'node:24-slim','node','-e',"require('node:fs').writeFileSync('/tmp/preserved','original-disk');setInterval(()=>{},1000)"]);
 assert.match(id,/^[0-9a-f]{64}$/);fs.writeFileSync('container-id.txt',id+'\n');
 try {
  docker(['start',id]);
  const original=await host.generation(id);fs.writeFileSync('docker-original.json',JSON.stringify(original)+'\n');
  assert.equal(await host.stop(original),true);
  const current=await host.restart(original);assert.notEqual(current.startedAt,original.startedAt);assert.equal(current.containerId,id);
  assert.equal(docker(['exec',id,'cat','/tmp/preserved']),'original-disk');
  assert.equal(await host.stopped(original),false);
  assert.equal(await host.stop(current),true);
  fs.writeFileSync('docker-result.json',JSON.stringify({status:'passed',containerId:id,original,current,preservedDisk:true,originalNotReplayed:true})+'\n');
  process.stdout.write(fs.readFileSync('docker-result.json'));
 } finally {docker(['stop','--time','1',id]);}
})().catch(e=>{fs.writeFileSync('docker-failure.txt',String(e.stack)+'\n');process.stderr.write(String(e.stack)+'\n');process.exitCode=1});
