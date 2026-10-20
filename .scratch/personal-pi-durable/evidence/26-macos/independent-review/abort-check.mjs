import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { personalCommandWork } from '/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-command-work.ts';
const root = fs.mkdtempSync(path.join('/tmp', 'rk-section-abort-review-'));
const profile = path.join(root, 'profile');
const workspace = path.join(root, 'work');
fs.mkdirSync(profile, { mode: 0o700 });
fs.mkdirSync(workspace, { mode: 0o700 });
const platform = Object.getOwnPropertyDescriptor(process, 'platform');
const readFile = fs.readFileSync;
try {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  fs.readFileSync = (target, options) => target === '/etc/machine-id' ? 'a'.repeat(32) + '\n' : readFile(target, options);
  syncBuiltinESMExports();
  const { dev, ino } = fs.statSync(workspace);
  const config = { version: 1, workspace: fs.realpathSync(workspace), identity: { dev, ino }, machineId: 'a'.repeat(32), tmpdir: fs.realpathSync(os.tmpdir()) };
  const render = personalCommandWork(profile, config).extension.sections[0].render;
  const failure = new Error('synthetic-aborted-read');
  const input = { conversationId: 10000, shown: { 'command-permission': '当前工作命令权限：完全访问。' }, read: { snapshot: async () => { throw failure; } } };
  const controller = new AbortController();
  controller.abort(failure);
  await assert.rejects(render(input, { abortSignal: controller.signal }), error => error === failure);
  process.stdout.write('aborted section read propagates original error; stale full_access section cannot replace cancellation: passed\n');
} finally {
  fs.readFileSync = readFile;
  syncBuiltinESMExports();
  Object.defineProperty(process, 'platform', platform);
  fs.rmSync(root, { recursive: true, force: true });
}
