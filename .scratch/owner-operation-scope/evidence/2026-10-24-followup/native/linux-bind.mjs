import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

assert.equal(process.platform, 'linux');
const sourceRoot = path.resolve(process.argv[2]);
const { prepareNativeLaunch } = await import(pathToFileURL(path.join(sourceRoot, 'packages/agent/src/execution/native.ts')));
const { ExecutionError } = await import(pathToFileURL(path.join(sourceRoot, 'packages/agent/src/execution/launchers.ts')));
const root = process.argv[3] ?? fs.mkdtempSync('/tmp/ruukoto-native-bind-');
const workspace = path.join(root, 'workspace'), safeGrant = path.join(root, 'grant'), safeRead = path.join(root, 'read');
const protectedRoot = path.join(root, 'private'), nested = path.join(protectedRoot, 'nested');
const source = path.join(nested, 'secret'), directoryAlias = path.join(root, 'directory-alias'), fileAlias = path.join(root, 'file-alias');
const workerPath = path.join(root, 'worker.mjs');
const config = { workerPath, dependencyRoots: [], protectedRoots: [protectedRoot] };
const spec = () => {
  const stat = fs.statSync(workspace);
  return { taskId: 'native-bind', mode: 'confirm', workspace, workspaceIdentity: { dev: stat.dev, ino: stat.ino },
    grantedPaths: [{ path: safeGrant, access: 'read', purpose: 'fixture' }], readRoots: [{ path: safeRead }] };
};

if (process.argv[3]) {
  const file = fs.statSync(fileAlias), directory = fs.statSync(directoryAlias);
  assert.equal(file.nlink, 1);
  for (const [original, alias] of [[source, fileAlias], [nested, directoryAlias]]) {
    const a = fs.statSync(original), b = fs.statSync(alias);
    assert.equal(a.dev, b.dev); assert.equal(a.ino, b.ino);
  }
  const workspaceSpec = { ...spec(), workspace: directoryAlias, workspaceIdentity: { dev: directory.dev, ino: directory.ino } };
  const grantSpec = spec(); grantSpec.grantedPaths.push({ path: directoryAlias, access: 'read', purpose: 'bind' });
  const readSpec = spec(); readSpec.readRoots.push({ path: fileAlias });
  for (const input of [workspaceSpec, grantSpec, readSpec]) {
    await assert.rejects(prepareNativeLaunch(config, input), error => error instanceof ExecutionError && error.code === 'execution_unavailable' && error.reason === 'sandbox_rejected' && error.unit === undefined);
  }
  process.stdout.write(JSON.stringify({ directoryBindRejectedAsWorkspace: true, directoryBindRejectedAsLaterGrant: true, fileBindRejectedAsLaterReadRoot: true, fileNlink: file.nlink }) + '\n');
} else {
  try {
    for (const directory of [workspace, safeGrant, safeRead, nested, directoryAlias]) fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(source, 'private'); fs.writeFileSync(fileAlias, 'empty'); fs.writeFileSync(workerPath, 'process.exit(0);');
    const result = spawnSync('/usr/bin/bwrap', ['--unshare-user', '--unshare-pid', '--unshare-net', '--die-with-parent', '--ro-bind', '/', '/',
      '--bind', root, root, '--bind', nested, directoryAlias, '--bind', source, fileAlias,
      process.execPath, '--experimental-transform-types', fileURLToPath(import.meta.url), sourceRoot, root], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(fs.statSync(fileAlias).ino, fs.statSync(source).ino);
    const input = spec(); input.grantedPaths.push({ path: directoryAlias, access: 'read', purpose: 'unmounted' }); input.readRoots.push({ path: fileAlias });
    const prepared = await prepareNativeLaunch(config, input);
    fs.rmSync(prepared.tempDir, { recursive: true, force: true });
    process.stdout.write(JSON.stringify({ platform: process.platform, release: os.release(), node: process.version, ...JSON.parse(result.stdout), afterNamespaceAllowed: true }) + '\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
