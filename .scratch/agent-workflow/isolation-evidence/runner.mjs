import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const modes = process.argv.slice(2).length ? process.argv.slice(2) : ['sync','wasm-location','wasm-capped','serial','concurrent','reject','loop','microtasks-unbounded','microtasks-one-interrupt','microtasks-batched-interrupt','microtasks-batched','builtin','memory','stack','module','authority','deferred-dispose','handle-leak'];
const rows = [];
for (const mode of modes) {
  const row = await new Promise((resolve) => {
    const child = fork(new URL('./child.mjs', import.meta.url), [mode], { silent: true, execArgv: [] });
    const row = { node: process.version, platform: process.platform, arch: process.arch, mode, stdout: '', stderr: '', killed: false };
    const timer = setTimeout(() => { row.killed = true; child.kill('SIGKILL'); }, 6000);
    let actionTimer;
    child.stdout.on('data', (data) => { row.stdout += data; });
    child.stderr.on('data', (data) => { row.stderr += data; });
    child.on('message', (message) => {
      if (message.type === 'diagnostic') (row.diagnostics ??= []).push(message);
      if (message.type === 'ready') {
        clearTimeout(timer);
        actionTimer = setTimeout(() => { row.killed = true; child.kill('SIGKILL'); }, mode === 'builtin' ? 600 : 3000);
      }
      if (message.type === 'result') row.message = message;
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(actionTimer);
      row.code = code; row.signal = signal;
      resolve(row);
    });
  });
  rows.push(row);
  process.stdout.write(`${JSON.stringify({ node: row.node, mode, code: row.code, signal: row.signal, killed: row.killed, message: row.message ? { elapsedMs: row.message.elapsedMs, interrupts: row.message.interrupts, result: row.message.result.ok !== undefined ? { ...row.message.result, value: row.message.result.value?.stack ? { ...row.message.result.value, stack: '[see raw result]' } : row.message.result.value } : '[see raw result]' } : undefined, diagnostics: row.diagnostics, stderr: row.stderr.slice(0,160) })}\n`);
}
await writeFile(new URL(`./results-${process.platform}-${process.version}${process.argv.length > 2 ? '-' + modes.join('_') : ''}.json`, import.meta.url), JSON.stringify(rows, null, 2) + '\n');
assert.ok(rows.filter((row) => !['builtin','microtasks-unbounded','microtasks-one-interrupt','microtasks-batched-interrupt'].includes(row.mode)).every((row) => row.code === 0 && row.message), 'Core case failed');
for (const row of rows) {
  if (row.mode === 'builtin') assert.equal(row.signal, 'SIGKILL');
  if (['microtasks-unbounded','microtasks-one-interrupt','microtasks-batched-interrupt'].includes(row.mode)) {
    assert.equal(row.code, 1);
    assert.ok(row.diagnostics[0].interrupts > 1);
    assert.equal(row.diagnostics[1].state, 'pending');
    assert.match(row.stderr, /list_empty/);
  }
  if (row.mode === 'handle-leak') assert.equal(row.message.result.leakDetected, true);
}
