import assert from 'node:assert/strict';
import { setImmediate as immediate } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { newQuickJSWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core';
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync';

const mode = process.argv[2];
const wasmPath = createRequire(new URL('../../../packages/agent/package.json', import.meta.url)).resolve('@jitl/quickjs-wasmfile-release-sync/wasm');
const cappedMemory = mode === 'wasm-capped' ? new WebAssembly.Memory({ initial: 256, maximum: 512 }) : undefined;
const variant = mode === 'wasm-location' ? newVariant(RELEASE_SYNC, { wasmLocation: wasmPath }) : mode === 'wasm-capped' ? newVariant(RELEASE_SYNC, { wasmMemory: cappedMemory }) : RELEASE_SYNC;
const QuickJS = await newQuickJSWASMModuleFromVariant(variant);
const runtime = QuickJS.newRuntime();
runtime.setMemoryLimit(8 * 1024 * 1024);
runtime.setMaxStackSize(64 * 1024);
const context = runtime.newContext();
const deferreds = new Set();
let finished = false;
let interrupts = 0;
let deadline = Date.now() + 100;
runtime.setInterruptHandler(() => { interrupts++; return Date.now() >= deadline; });
process.send({ type: 'ready' });
const begin = performance.now();

function take(result) {
  const handle = result.error ?? result.value;
  let value;
  try { value = context.dump(handle); } finally { if (handle.alive) handle.dispose(); }
  return { ok: !result.error, value };
}
function run(source, options) { return take(context.evalCode(source, 'guest.js', options)); }
function jobs(count = 100) {
  const result = runtime.executePendingJobs(count);
  if (result.error) return take(result);
  return { ok: true, count: result.value };
}
function installAgent() {
  context.newFunction('agent', (input) => {
    const request = context.getString(input);
    const deferred = context.newPromise();
    deferreds.add(deferred);
    setTimeout(() => {
      if (finished) return;
      const value = request === 'fail' ? context.newError({ name: 'FakeAgentError', message: 'rejected' }) : context.newString(request.toUpperCase());
      try { request === 'fail' ? deferred.reject(value) : deferred.resolve(value); }
      finally { value.dispose(); deferreds.delete(deferred); deferred.dispose(); }
    }, request === 'b' ? 5 : 10);
    return deferred.handle;
  }).consume((handle) => context.setProp(context.global, 'agent', handle));
}
async function settle(source) {
  installAgent();
  deadline = Date.now() + 2000;
  const result = context.evalCode(source);
  assert.equal(result.error, undefined);
  const handle = result.value;
  let state;
  try {
    for (let i = 0; i < 3000; i++) {
      const job = jobs();
      if (!job.ok) return job;
      state = context.getPromiseState(handle);
      if (state.type === 'fulfilled') return take({ value: state.value });
      if (state.type === 'rejected') return take({ error: state.error });
      await immediate();
    }
    throw new Error('Guest promise never settled');
  } finally { if (handle.alive) handle.dispose(); }
}

let result;
try {
  if (mode === 'sync') {
    result = run('1 + 1'); assert.deepEqual(result, { ok: true, value: 2 });
    assert.equal(typeof QuickJS.dispose, 'undefined');
    result.moduleDispose = typeof QuickJS.dispose;
    result.wasmBytes = QuickJS.getWasmMemory().buffer.byteLength;
  } else if (mode === 'wasm-location') {
    result = run('1 + 1'); assert.deepEqual(result, { ok: true, value: 2 });
    result.wasmPath = wasmPath;
  } else if (mode === 'wasm-capped') {
    result = run('1 + 1'); assert.deepEqual(result, { ok: true, value: 2 });
    assert.equal(QuickJS.getWasmMemory(), cappedMemory);
    assert.throws(() => cappedMemory.grow(257), RangeError);
    result.bytes = cappedMemory.buffer.byteLength; result.maxBytes = 512 * 65536;
  } else if (mode === 'serial') {
    result = await settle('(async () => [await agent("a"), await agent("b")])()');
    assert.deepEqual(result, { ok: true, value: ['A', 'B'] });
  } else if (mode === 'concurrent') {
    result = await settle('(async () => await Promise.all([agent("a"), agent("b")]))()');
    assert.deepEqual(result, { ok: true, value: ['A', 'B'] });
  } else if (mode === 'reject') {
    result = await settle('(async () => await agent("fail"))()');
    assert.equal(result.ok, false); assert.equal(result.value.name, 'FakeAgentError');
  } else if (mode === 'loop') {
    result = run('while (true) {}');
    assert.equal(result.ok, false); assert.equal(result.value.message, 'interrupted');
  } else if (['microtasks-unbounded','microtasks-one-interrupt','microtasks-batched-interrupt'].includes(mode)) {
    const handle = context.evalCode('Promise.resolve().then(function next() { return Promise.resolve().then(next); })').unwrap();
    if (mode === 'microtasks-unbounded') result = jobs(-1);
    else {
      let total = 0;
      let last;
      while (runtime.hasPendingJob()) {
        last = jobs(mode === 'microtasks-one-interrupt' ? 1 : 64);
        if (!last.ok) break;
        total += last.count;
      }
      result = { ...last, total };
    }
    process.send({ type: 'diagnostic', phase: 'after-jobs', result, elapsedMs: performance.now() - begin, interrupts });
    const state = context.getPromiseState(handle);
    process.send({ type: 'diagnostic', phase: 'promise-state', state: state.type, value: state.type === 'pending' ? null : take(state) });
    handle.dispose();
    result.pendingBeforeDispose = state.type === 'pending';
  } else if (mode === 'microtasks-batched') {
    const handle = context.evalCode('Promise.resolve().then(function next() { return Promise.resolve().then(next); })').unwrap();
    deadline = Date.now() + 5000;
    let cancel = false;
    let total = 0;
    const timer = setTimeout(() => { cancel = true; }, 20);
    while (!cancel) {
      const job = jobs(64); assert.equal(job.ok, true); total += job.count;
      await immediate();
    }
    clearTimeout(timer);
    handle.dispose();
    result = { ok: true, cancelObserved: cancel, jobs: total };
    assert.ok(total > 0);
  } else if (mode === 'builtin') {
    runtime.setMemoryLimit(640 * 1024);
    result = run('new Array(1_000_000_000) + ""');
    assert.equal(result.ok, false);
  } else if (mode === 'memory') {
    runtime.setMemoryLimit(640 * 1024);
    result = run('const values = []; for(let i=0; i<1000000; i++) values.push("item" + i)');
    assert.equal(result.ok, false); assert.equal(result.value.message, 'out of memory');
  } else if (mode === 'stack') {
    result = run('function recurse() { recurse() }; recurse()');
    assert.equal(result.ok, false); assert.match(result.value.message, /stack/);
  } else if (mode === 'module') {
    result = {};
    for (const name of ['node:fs', 'std', 'os', './file.js', 'https://example.com/x.js']) {
      const outcome = run(`import value from ${JSON.stringify(name)}`, { type: 'module' });
      assert.equal(outcome.ok, false); result[name] = outcome;
    }
  } else if (mode === 'authority') {
    result = run('({ process: typeof process, require: typeof require, fetch: typeof fetch, Buffer: typeof Buffer, Deno: typeof Deno, Bun: typeof Bun, WebAssembly: typeof WebAssembly, hostConstructor: Function("return typeof process")() })');
    assert.equal(result.ok, true);
    assert.ok(Object.values(result.value).every((value) => value === 'undefined'));
  } else if (mode === 'deferred-dispose') {
    const deferred = context.newPromise();
    deferred.dispose(); deferred.dispose();
    deferred.resolve(); deferred.reject();
    assert.equal(deferred.alive, false);
    result = { ok: true, idempotent: true, lateSettleNoop: true };
  } else if (mode === 'handle-leak') {
    const leaked = context.newObject();
    try { context.dispose(); runtime.dispose(); result = { ok: true, leakDetected: false }; }
    catch (error) { result = { ok: true, leakDetected: true, name: error.name, message: error.message }; }
    process.send({ type: 'result', mode, result, elapsedMs: performance.now() - begin, interrupts });
    process.exit(0);
  } else throw new Error(`Unknown mode ${mode}`);
} finally {
  finished = true;
  for (const deferred of deferreds) deferred.dispose();
  context.dispose(); runtime.dispose();
}
process.send({ type: 'result', mode, result, elapsedMs: performance.now() - begin, interrupts });
process.disconnect();
