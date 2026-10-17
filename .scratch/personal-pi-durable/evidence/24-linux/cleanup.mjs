import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const base = '/tmp/ruukoto-command-24.uPkbfF';
const evidence = path.join(base, 'evidence');
const inputs = fs.readdirSync(evidence).filter(name => name.endsWith('-input.json')).map(name => JSON.parse(fs.readFileSync(path.join(evidence, name), 'utf8')));
const scopes = inputs.map(input => {
  const scope = `ruukoto-${input.ref.executionId}.scope`;
  const state = execFileSync('systemctl', ['--user', 'show', scope, '--property=LoadState', '--property=ActiveState', '--property=ControlGroup'], { encoding: 'utf8' }).trim();
  assert.ok(state.includes('LoadState=not-found'), state);
  assert.ok(state.includes('ControlGroup=\n') || state.endsWith('ControlGroup='), state);
  assert.equal(fs.existsSync(input.input.tempDir), false, input.input.tempDir);
  assert.equal(fs.existsSync(input.input.tempDir + '-preserved'), false, input.input.tempDir);
  return { scope, state, tempDir: input.input.tempDir, tempExists: false, movedTempExists: false };
});
const processes = [];
for (const pid of fs.readdirSync('/proc').filter(value => /^\d+$/.test(value))) {
  if (Number(pid) === process.pid || Number(pid) === process.ppid) continue;
  let command;
  try { command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); }
  catch { continue; }
  if (command.includes(path.join(base, 'fixtures'))) processes.push({ pid: Number(pid) });
}
assert.deepEqual(processes, []);
assert.equal(fs.existsSync(path.join(base, 'fixtures')), false);
const result = { timestamp: new Date().toISOString(), fixturesRemoved: true, scopes, remainingMatchingProcesses: processes };
fs.writeFileSync(path.join(evidence, 'cleanup.json'), JSON.stringify(result, null, 2) + '\n');
process.stdout.write(JSON.stringify({ scopes: scopes.length, fixturesRemoved: true, matchingProcesses: processes.length }) + '\n');
