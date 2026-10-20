import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import path from "node:path";
const { ToolWorkerHost } = await import(pathToFileURL(path.resolve(process.argv[2])).href);
const spec = { taskId:"independent-tail-review", mode:"full_access", workspace:process.cwd(), grantedPaths:[] };
async function fixture(event, group=true) {
  const stdout=new PassThrough(), stderr=new PassThrough();
  let exited;
  const exit=new Promise(resolve=>{exited=resolve;});
  const stdin=new Writable({write(chunk, encoding, callback) {
    const request=JSON.parse(chunk.toString());
    if(request.type==="shutdown") {
      exited({code:0,signal:null});
      setImmediate(()=>{
        if(event==="success") stdout.end('{"type":"stopped","reaped":true}\n');
        if(event==="error") stdout.destroy(new Error("independent read failure"));
        if(event==="close") stdout.destroy();
      });
    }
    callback();
  }});
  const launcher={kind:"local",async launch() {
    setImmediate(()=>stdout.write('{"type":"ready","pid":123456}\n'));
    return {entry:{kind:"process_group",id:"123456",label:"pure-memory",stop:async()=>group},stdin,stdout,stderr,exit};
  }};
  return ToolWorkerHost.start(launcher,spec);
}
const success=await fixture("success");
assert.equal(await success.stop(),true,"exit 后下一宏任务的完整成功回执必须被消费");
assert.equal(await success.stop(),true);
if(process.argv[3]!=="negative") {
  for(const event of ["error","close"]) {
    const host=await fixture(event);
    const start=Date.now();
    assert.equal(await host.stop(),false);
    assert.equal(host.stopFailure.code,"worker_stop_unverified");
    assert.ok(Date.now()-start<1000,"error/close 应提前结束等待");
  }
  const host=await fixture("open");
  const start=Date.now();
  assert.equal(await host.stop(),false);
  assert.ok(Date.now()-start>=2900 && Date.now()-start<6000,"未关闭通道应在3秒预算后返回");
}
process.stdout.write(JSON.stringify({source:process.argv[2],result:"passed",cases:process.argv[3]==="negative"?1:4})+"\n");
