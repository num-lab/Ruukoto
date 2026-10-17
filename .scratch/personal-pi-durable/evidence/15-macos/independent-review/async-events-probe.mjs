import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
let child;
const originalSpawn = childProcess.spawn;
childProcess.spawn = () => child;
syncBuiltinESMExports();
const { callHelper, ServiceHelperError } = await import('./apps/ruukoto/src/service-helper.ts');
const config = { helperPath: '/unused', policyPath: '/unused', useSudo: false, sudoPath: '/unused' };
try {
  for (const first of ['spawn_failed', 'aborted']) {
    child = new EventEmitter();
    child.stdio = [null, new PassThrough(), new PassThrough()];
    child.kill = () => true;
    const controller = new AbortController();
    let settled = false;
    const promise = callHelper(config, [], { timeoutMs: 1000, signal: controller.signal, maxOutputBytes: 32 }).then(value => { settled = true; return value; }, error => { settled = true; return error; });
    if (first === 'aborted') controller.abort();
    child.emit('error', new Error('synthetic async spawn failure'));
    if (first === 'spawn_failed') controller.abort();
    await delay(15);
    assert.equal(settled, false, 'error/abort must not settle before close');
    child.stdio[1].write('tail-after-error');
    child.stdio[2].write('x'.repeat(40));
    child.emit('close', null);
    const error = await promise;
    assert.ok(error instanceof ServiceHelperError);
    assert.equal(error.code, first);
    assert.equal(error.capture.stdout.toString(), 'tail-after-error');
    assert.equal(error.capture.stdout.length + error.capture.stderr.length, 32);
    assert.equal(error.capture.truncated, true);
    process.stdout.write(JSON.stringify({ first, pendingBeforeClose: true, preservedFirstCode: true, finalBoundedCapture: true }) + '\n');
  }
} finally {
  childProcess.spawn = originalSpawn;
  syncBuiltinESMExports();
}
