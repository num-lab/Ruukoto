import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sourceRoot = path.resolve(process.argv[2]);
const { createNativeLauncher } = await import(pathToFileURL(path.join(sourceRoot, 'packages/agent/src/execution/native.ts')));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ruukoto-native-batch-smoke-')));
const workspace = path.join(root, 'work'), grant = path.join(root, 'grant'), readRoot = path.join(root, 'read'), protectedRoot = path.join(root, 'private');
for (const target of [workspace, grant, readRoot, protectedRoot]) fs.mkdirSync(target);
fs.writeFileSync(path.join(readRoot, 'readable'), 'read');
fs.writeFileSync(path.join(protectedRoot, 'secret'), 'private');
const workerPath = path.join(root, 'worker.mjs');
fs.writeFileSync(workerPath, `import assert from 'node:assert/strict';import fs from 'node:fs';
assert.equal(fs.readFileSync(${JSON.stringify(path.join(readRoot, 'readable'))},'utf8'),'read');
fs.writeFileSync(${JSON.stringify(path.join(workspace, 'output'))},'work');
fs.writeFileSync(${JSON.stringify(path.join(grant, 'output'))},'grant');
assert.throws(()=>fs.writeFileSync(${JSON.stringify(path.join(readRoot, 'blocked'))},'blocked'));
assert.throws(()=>fs.readFileSync(${JSON.stringify(path.join(protectedRoot, 'secret'))}));
process.stdout.write('verified\\n');setInterval(()=>{},1000);
`);
const stat = fs.statSync(workspace), rows = [];
let cleanupSafe = true;
try {
  const launcher = createNativeLauncher({ workerPath, dependencyRoots: [], protectedRoots: [protectedRoot], helperPath: path.join(sourceRoot, 'worker/native-macos-supervisor') });
  for (const mode of ['confirm', 'auto-review']) {
    const unit = await launcher.launch({ taskId: `native-batch-${mode}`, mode, workspace, workspaceIdentity: { dev: stat.dev, ino: stat.ino },
      grantedPaths: [{ path: grant, access: 'read_write', purpose: 'fixture' }], readRoots: [{ path: readRoot }] });
    let stdout = '', stderr = '';
    unit.stdout.on('data', data => { stdout += data.toString(); });
    unit.stderr.on('data', data => { stderr += data.toString(); });
    try {
      const deadline = Date.now() + 10000;
      while (!stdout.includes('verified\n') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(stdout, 'verified\n', stderr);
    } finally {
      const stopped = await unit.entry.stop();
      cleanupSafe &&= stopped;
      await unit.exit;
      assert.equal(stopped, true, '真实原生停止必须核实');
    }
    rows.push({ mode, authorizedReadWrite: true, readonlyWriteDenied: true, protectedReadDenied: true, stopped: true });
  }
} finally {
  if (cleanupSafe) fs.rmSync(root, { recursive: true, force: true });
}
process.stdout.write(JSON.stringify({ platform: process.platform, release: os.release(), node: process.version, rows, cleanupSafe }) + '\n');
