import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { WorkflowScriptHost, launchScriptProcess } from "@ruukoto/agent/script-worker/host.ts";
import { SCRIPT_LIMITS, ScriptWriter, ScriptExecutionError, ScriptCallError, readScriptFrames, isScriptCall } from "@ruukoto/agent/script-worker/protocol.ts";
import { ExecutionError, type LaunchedUnit } from "@ruukoto/agent/execution/launchers.ts";

const fake = async (call: { params: unknown }) => call.params;
function run(script: string, input: unknown = null, invoke = fake, options = {}) {
  const host = new WorkflowScriptHost("fake-workflow");
  return { host, result: host.run(script, input, invoke, options) };
}

test("同步 WASM 支持串行、并发、分支和循环，四种原语仅传 JSON", async () => {
  const { host, result } = run(`
    const a = await agent("first", input);
    const values = await Promise.all([agent("a", 2), ask("b", 3)]);
    let sum = a;
    for (const value of values) { if (value > 0) sum += value; }
    await progress("progress", {sum});
    return await integrate("merge", {sum});
  `, 1);
  assert.deepEqual(await result, { value: { sum: 6 }, reaped: true });
  assert.equal(await host.stop(), true);
  assert.ok(host.identity()?.id);
});

test("宿主拒绝为解释器内错误，其他分支继续", async () => {
  const { result } = run(`
    const bad = agent("bad", {}).catch(error => error.code);
    const good = agent("good", {ok:true});
    return await Promise.all([bad, good]);
  `, null, async call => {
    if ("key" in call && call.key === "bad") throw new ScriptCallError("fake_rejected");
    return call.params;
  });
  assert.deepEqual((await result).value, ["fake_rejected", {ok:true}]);
});

test("脚本没有 Node、文件、网络、凭据、时钟、随机数和定时器", async () => {
  const { result } = run(`return [typeof process, typeof require, typeof Buffer, typeof fetch, typeof XMLHttpRequest, typeof WebAssembly, typeof Date, typeof Math.random, typeof setTimeout, agent.constructor("return typeof process")(), typeof __host];`);
  assert.deepEqual((await result).value, Array(11).fill("undefined"));
});

for (const [name, script] of [
  ["静态模块", `import x from "node:fs"; return x;`],
  ["动态模块", `return await import("node:fs");`],
  ["语法", `return (;`],
  ["调用参数", `try { await agent("", {}); } catch {} return 1;`],
  ["未等待工作", `agent("lost", {}); return 1;`],
  ["悬空 Promise", `return await new Promise(() => {});`],
  ["纯计算", `for (;;) {}`],
  ["微任务", `return await new Promise(() => { function loop() { Promise.resolve().then(loop); } loop(); });`],
  ["长内建", `return new Array(1e9) + "";`],
  ["内存", `const a=[]; for (;;) a.push(new Array(10000).fill("memory"));`],
  ["栈", `function recur() { return recur(); } return recur();`],
  ["输出", `return "x".repeat(2 * 1024 * 1024);`],
  ["并发请求", `return await Promise.all(Array.from({length: 33}, (_,i) => agent("p"+i, {})));`],
  ["日志", `for (let i=0; i<257; i++) await progress("p"+i, {}); return 1;`],
] as const) {
  test(`${name}故意失败后，进程已回收`, async () => {
    const {host, result} = run(script, null, async call => {
      if (name === "并发请求" || name === "未等待工作") return await new Promise(() => {});
      return call.params;
    }, {cpuMs: 500});
    await assert.rejects(result, error => error instanceof ScriptExecutionError);
    assert.equal(await host.stop(), true);
    assert.ok(host.identity());
  });
}

test("等待宿主不耗脚本预算，取消后迟到结果不能继续脚本", async () => {
  const controller = new AbortController();
  let resolve!: (value: unknown) => void;
  let arrived!: () => void;
  const called = new Promise<void>(done => {arrived = done;});
  let calls = 0;
  const { host, result } = run(`await ask("q", {}); return await agent("late", {});`, null, async () => {
    calls++;
    arrived();
    return await new Promise(done => {resolve = done;});
  }, {signal: controller.signal, cpuMs: 100});
  await called;
  await new Promise(done => setTimeout(done, 150));
  controller.abort();
  await assert.rejects(result, {code:"script_canceled"});
  resolve(1);
  await new Promise(done => setTimeout(done, 20));
  assert.equal(calls, 1);
  assert.equal(await host.stop(), true);
});

async function splitScriptFrames(): Promise<LaunchedUnit> {
  const unit = await launchScriptProcess("split-frames");
  const stdout = Readable.from((async function* () {
    for await (const line of createInterface({ input: unit.stdout })) {
      await nextTurn();
      yield Buffer.from(`${line}\n`);
    }
  })());
  return { ...unit, stdout, exit: Promise.all([unit.exit, once(stdout, "end")]).then(([status]) => status) };
}

test("call 与 idle 分帧时，并发宿主同步工作不消耗脚本预算", async () => {
  const host = new WorkflowScriptHost("split-host-work", splitScriptFrames);
  const blocking = new Int32Array(new SharedArrayBuffer(4));
  const result = await host.run('return await Promise.all([agent("a",1), agent("b",2), agent("c",3)]);', null, async call => {
    Atomics.wait(blocking, 0, 0, 600);
    return call.params;
  }, { cpuMs: 500 });
  assert.deepEqual(result, { value: [1, 2, 3], reaped: true });
  assert.equal(await host.stop(), true);
});

for (const cancel of [false, true]) test(`idle 前的宿主请求在${cancel ? "取消" : "脚本继续无限计算"}后不派发`, async () => {
  const host = new WorkflowScriptHost("queued-host-work", splitScriptFrames);
  const controller = new AbortController();
  let calls = 0;
  const result = host.run(cancel ? 'return await agent("queued", {});' : 'agent("queued", {}); for (;;) {}', null, async () => { calls++; return null; }, {
    cpuMs: 100, signal: controller.signal, onActivity: active => { if (cancel && !active) controller.abort(); },
  });
  await assert.rejects(result, { code: cancel ? "script_canceled" : "script_cpu_limit" });
  assert.equal(calls, 0);
  assert.equal(await host.stop(), true);
});

test("启动前取消不创建进程", async () => {
  let launches = 0;
  const host = new WorkflowScriptHost("early", async () => { launches++; throw new Error("unexpected"); });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(host.run("return 1", null, fake, {signal:controller.signal}), {code:"script_canceled"});
  assert.equal(launches, 0);
  assert.equal(await host.stop(), true);
});

test("单帧 UTF-8 字节及无换行缓冲有界，非法 JSON 不被忽略", () => {
  for (const data of [Buffer.alloc(SCRIPT_LIMITS.frameBytes + 1, 120), Buffer.from("oops\n")]) {
    const stream = new PassThrough();
    let failure: unknown;
    readScriptFrames(stream, () => assert.fail("unexpected"), error => {failure=error;});
    stream.write(data);
    assert.ok(failure instanceof ScriptExecutionError);
  }
});

test("背压阻塞时，输出队列到限明确拒绝", async () => {
  const output = new Writable({write() { /* 模拟消费者不读取。 */ }});
  const writer = new ScriptWriter(output);
  const writes: Promise<void>[] = [];
  for (let i=0; i<4; i++) writes.push(writer.send("x".repeat(SCRIPT_LIMITS.frameBytes - 3)));
  assert.throws(() => writer.send("x".repeat(SCRIPT_LIMITS.frameBytes - 3)), {code:"script_queue_limit"});
  for (const write of writes) void write.catch(() => undefined);
  output.destroy(new Error("closed"));
  output.on("error", () => undefined);
});

test("超大输入与脚本在启动前拒绝", async () => {
  const {host, result} = run("return input", "x".repeat(SCRIPT_LIMITS.frameBytes));
  await assert.rejects(result, {code:"script_frame_limit"});
  assert.equal(host.identity(), undefined);
  await assert.rejects(run("x".repeat(SCRIPT_LIMITS.scriptBytes + 1)).result, {code:"script_source_limit"});
});

test("JSON __proto__ 在入参和返回中保持普通字段", async () => {
  const value = JSON.parse('{"__proto__":{"inherited":"unexpected"},"ok":true}');
  const {result} = run(`
    const reply = await agent("json", input);
    return [Object.keys(input), input.inherited === undefined, Object.keys(reply), reply.inherited === undefined, reply];
  `, value);
  assert.deepEqual((await result).value, [["__proto__", "ok"], true, ["__proto__", "ok"], true, value]);
  assert.equal(isScriptCall({id:1,method:["agent"],key:"a",params:null}), false);
});

test("脚本改写全局 JSON 和 Promise 不影响宿主转换及推进", async () => {
  const {result}=run(`
    JSON.parse = () => ({bad:true}); JSON.stringify = () => "false";
    const reply = await agent("x", {ok:true});
    Promise.resolve = () => { throw new Error("replaced"); };
    return reply;
  `);
  assert.deepEqual((await result).value,{ok:true});
});

test("解释器内存和栈分别拒绝分配与递归，不借计时失败代替", async () => {
  const memory = await run(`try { return new Array(10000000).fill(1).length; } catch(error) { return error.name; }`).result;
  const stack = await run(`try { function recur(){ return recur(); } recur(); } catch(error) { return error.name; }`).result;
  assert.equal(memory.value, "InternalError");
  assert.equal(stack.value, "InternalError");
});

function controlled(outcome: boolean | "throws", messages: unknown[], launchError = false, exitCode = 0) {
  const stdout = new PassThrough();
  let stops = 0;
  let finish!: () => void;
  const unit: LaunchedUnit = {
    entry: {kind:"process_group",id:"fake",label:"fake",async stop() {
      stops++; finish();
      if (outcome === "throws") throw new Error("query failed");
      return outcome;
    }},
    stdin: new Writable({write(_chunk, _encoding, callback) {
      callback();
      setImmediate(() => {for(const value of messages) stdout.write(JSON.stringify(value)+"\n"); if(messages.some(value=> typeof value === "object" && value !== null && "type" in value && value.type === "done")) finish();});
    }}),
    stdout, stderr:new PassThrough(), exit:new Promise(resolve => {finish=()=>resolve({code:exitCode,signal:null});}),
  };
  const launch = async () => {
    if (launchError) throw new ExecutionError("fake_launch_failed", "fake", unit);
    setImmediate(()=>stdout.write('{"type":"ready"}\n'));
    return unit;
  };
  return {unit, launch, stops:()=>stops};
}

for (const outcome of [false, "throws"] as const) {
  test(`结果保留，停止未核实及重复停止不变：${outcome}`, async () => {
    const fake = controlled(outcome,[{type:"done",value:42}]);
    const host = new WorkflowScriptHost("unverified",fake.launch);
    await assert.rejects(host.run("return 42",null,async()=>null),{code:"script_stop_unverified"});
    assert.equal(host.output,42);
    assert.equal(host.identity()?.id,"fake");
    assert.deepEqual(await Promise.all([host.entry().stop(),host.identity()!.stop(),host.stop()]),[false,false,false]);
    assert.equal(fake.stops(),1);
  });
}

test("已创建单元后的启动失败仍停止且保留未核实身份", async () => {
  const fake = controlled(false,[],true);
  const host = new WorkflowScriptHost("launch-failed",fake.launch);
  await assert.rejects(host.run("return 1",null,async()=>null),{code:"fake_launch_failed"});
  assert.equal(await host.stop(),false);
  assert.equal(host.identity()?.id,"fake");
  assert.equal(fake.stops(),1);
});

test("启动器同步抛错也保留已创建单元", async () => {
  const fake=controlled(false,[]);
  const host=new WorkflowScriptHost("sync-launch-failed",()=>{throw new ExecutionError("fake_sync_launch", "fake", fake.unit);});
  await assert.rejects(host.run("return 1",null,async()=>null),{code:"fake_sync_launch"});
  assert.equal(await host.stop(),false);
  assert.equal(host.identity()?.id,"fake");
  assert.equal(fake.stops(),1);
});

test("启动期间取消覆盖迟到单元", async () => {
  const fake = controlled(true,[]);
  let release!: (unit:LaunchedUnit) => void;
  const host = new WorkflowScriptHost("late-launch",()=>new Promise(resolve=>{release=resolve;}));
  const controller=new AbortController();
  const result=host.run("return 1",null,async()=>null,{signal:controller.signal});
  controller.abort(); release(fake.unit);
  await assert.rejects(result,{code:"script_canceled"});
  assert.equal(await host.stop(),true);
  assert.equal(fake.stops(),1);
});

test("零请求的 idle 与损坏协议停止进程，不执行同帧迟到请求", async () => {
  for (const messages of [
    [{type:"idle",seq:1}],
    [{type:"unknown"},{type:"call",call:{id:1,method:"agent",key:"late",params:null}}],
    [{type:"call",call:{id:1,method:"agent",key:"queued",params:null}},{type:"idle",seq:1},{type:"call",call:{id:2,method:"agent",key:"late",params:null}}],
    [{type:"done",value:1},{type:"fatal",code:"script_protocol"}],
  ]) {
    const fake=controlled(true,messages);
    const host=new WorkflowScriptHost("bad-protocol",fake.launch);
    let calls=0;
    await assert.rejects(host.run("return 1",null,async()=>{calls++;return null;}),{code:"script_protocol"});
    assert.equal(calls,0);
    assert.equal(await host.stop(),true);
  }
});

test("同名运行的启动占位不覆盖", () => {
  assert.notEqual(new WorkflowScriptHost("same").entry().id, new WorkflowScriptHost("same").entry().id);
});

test("结果已到但进程异常退出保留结果并报失败", async () => {
  const fake=controlled(true,[{type:"done",value:42}],false,1);
  const host=new WorkflowScriptHost("failed-exit",fake.launch);
  await assert.rejects(host.run("return 42",null,async()=>null),{code:"script_exited"});
  assert.equal(host.output,42);
  assert.equal(await host.stop(),true);
});

test("授权拒绝不能被脚本 catch 变成成功", async () => {
  const {host,result}=run(`try { await agent("denied", {}); } catch {} return 1;`,null,async()=>{throw new ScriptExecutionError("access_denied");});
  await assert.rejects(result,{code:"access_denied"});
  assert.equal(await host.stop(),true);
});

test("超大宿主结果停止进程且不继续下一步骤", async () => {
  let calls=0;
  const {host,result}=run(`await agent("large", {}); return await agent("late", {});`,null,async()=>{calls++;return "x".repeat(SCRIPT_LIMITS.frameBytes);});
  await assert.rejects(result,{code:"script_frame_limit"});
  assert.equal(calls,1);
  assert.equal(await host.stop(),true);
});

test("转换中的无限 getter 或 toJSON 也被父进程停止", async () => {
  for(const script of [`return {toJSON(){for(;;){}}};`, `return await agent("getter", {get value(){for(;;){}}});`]) {
    const {host,result}=run(script,null,fake,{cpuMs:100});
    await assert.rejects(result,{code:"script_cpu_limit"});
    assert.equal(await host.stop(),true);
  }
});

test("32 个合法并发请求与长微任务链可以同时推进", async () => {
  const {result}=run(`
    const calls=Array.from({length:32},(_,i)=>agent("p"+i,i));
    for(let i=0;i<20000;i++) await Promise.resolve();
    return await Promise.all(calls);
  `,null,fake,{cpuMs:5000});
  assert.deepEqual((await result).value,Array.from({length:32},(_,i)=>i));
});
