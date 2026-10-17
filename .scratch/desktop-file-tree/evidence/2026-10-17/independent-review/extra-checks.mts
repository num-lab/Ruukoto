import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assertDirectoryReadNotProtected, ApprovedOpError } from '/Users/eitrous/.codex/worktrees/6f13/ruukoto/packages/agent/src/execution/approved-ops.ts';
const checkout = '/Users/eitrous/.codex/worktrees/6f13/ruukoto';
const base = fs.realpathSync(fs.mkdtempSync('/tmp/ruukoto-directory-review-'));
try {
  const workspace = path.join(base, 'workspace'), protectedRoot = path.join(base, 'protected');
  fs.mkdirSync(workspace); fs.mkdirSync(protectedRoot);
  const file = path.join(workspace, 'secret.txt'); fs.writeFileSync(file, 'fixture');
  assert.throws(() => assertDirectoryReadNotProtected(workspace, workspace, [file]), ApprovedOpError);
  const protectedFile = path.join(protectedRoot, 'secret.txt'); fs.writeFileSync(protectedFile, 'fixture');
  assert.doesNotThrow(() => assertDirectoryReadNotProtected(workspace, workspace, [protectedFile]));
  fs.symlinkSync(workspace, path.join(protectedRoot, 'ignored-symlink'));
  assert.doesNotThrow(() => assertDirectoryReadNotProtected(workspace, workspace, [protectedRoot]));
  assert.throws(() => assertDirectoryReadNotProtected(file, workspace, []), ApprovedOpError);
  assert.throws(() => assertDirectoryReadNotProtected(workspace, file, []), ApprovedOpError);
  assert.throws(() => assertDirectoryReadNotProtected(workspace, workspace, [path.parse(base).root]), ApprovedOpError);
  process.stdout.write(JSON.stringify({extraChecks: ['protected-file-descendant-rejected', 'unrelated-protected-file-allowed', 'protected-tree-symlink-not-followed', 'file-root-rejected', 'file-target-rejected', 'filesystem-protection-root-rejected'], result:'passed'}) + '\n');
  const expected = JSON.parse(fs.readFileSync('/var/folders/y4/36h8kvvd4q52vjptp522rzfc0000gn/T/ruukoto-directory-bind-result-9ekiex4h/source-hashes.json','utf8'));
  for (const [name, hash] of Object.entries(expected)) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(checkout, name))).digest('hex'), hash, name);
  process.stdout.write('Linux bind evidence source hashes match current checkout\n');
} finally { fs.rmSync(base,{recursive:true}); }
