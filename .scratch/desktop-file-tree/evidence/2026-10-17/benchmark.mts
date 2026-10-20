import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { syncBuiltinESMExports } from 'node:module';
import { listWorkspaceFiles } from '@ruukoto/runtime/workspace-files.ts';
import { resolveDirIdentitySync } from '@ruukoto/core/dir-identity.ts';
const repo = process.cwd();
const temp = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'ruukoto-tree-bench-')));
const work = path.join(temp, 'work');
fs.mkdirSync(work);
fs.mkdirSync(path.join(work, 'empty'));
fs.writeFileSync(path.join(work, 'file.txt'), 'fixture');
const protectedSmall = path.join(temp, 'protected-small');
const protectedLarge = path.join(temp, 'protected-large');
fs.mkdirSync(protectedSmall);
fs.writeFileSync(path.join(protectedSmall, 'one'), 'fixture');
fs.mkdirSync(protectedLarge);
for (let d = 0; d < 50; d++) {
  const directory = path.join(protectedLarge, `d-${d}`);
  fs.mkdirSync(directory);
  for (let n = 0; n < 100; n++) fs.writeFileSync(path.join(directory, `f-${n}`), 'fixture');
}
const original = { readdirSync: fs.readdirSync, lstatSync: fs.lstatSync, statSync: fs.statSync, realpathSync: fs.realpathSync };
let current: Record<string, number> = {};
for (const name of Object.keys(original) as (keyof typeof original)[]) {
  // 仅当前临时进程计数，不读取文件正文。
  const fn = original[name];
  Object.assign(fs, { [name]: (...args: unknown[]) => { current[name] = (current[name] ?? 0) + 1; return Reflect.apply(fn, fs, args); } });
}
syncBuiltinESMExports();
let repoRootJson: string | undefined;
function run(label: string, root: string, relative: string, protectedRoots: string[], repetitions = 4) {
  const identity = resolveDirIdentitySync(root);
  const samples = [];
  for (let index = 0; index < repetitions; index++) {
    current = {};
    const before = performance.now();
    const value = listWorkspaceFiles('fixture', identity, relative, protectedRoots);
    const ms = performance.now() - before;
    assert.ok(value.entries.length <= 200);
    if (label.startsWith('repo-root')) { const json = JSON.stringify(value); if (repoRootJson === undefined) repoRootJson = json; else assert.equal(json, repoRootJson, '比较的目录返回值必须完全相同'); }
    samples.push({ ms: +ms.toFixed(3), entries: value.entries.length, truncated: value.truncated, calls: current });
  }
  process.stdout.write(JSON.stringify({ label, firstInProcess: samples[0], subsequent: samples.slice(1), startupExcluded: true, osCacheFlushed: false }) + '\n');
  return samples;
}
const baseline = run('repo-root-no-protected-control', repo, '', []);
run('repo-root-small-protected', repo, '', [protectedSmall]);
const slow = run('repo-root-5000-file-protected', repo, '', [protectedLarge]);
run('repo-runtime-src-no-protected-control', repo, 'packages/runtime/src', []);
run('empty-dir-small-protected', work, 'empty', [protectedSmall]);
run('empty-dir-5000-file-protected', work, 'empty', [protectedLarge]);
run('empty-dir-repo-as-protected', work, 'empty', [repo], 3);
const median = (samples: typeof baseline) => samples.slice(1).map(sample => sample.ms).sort((a, b) => a - b)[Math.floor((samples.length - 1) / 2)];
const baselineMs = median(baseline), slowMs = median(slow), ratio = slowMs / baselineMs;
const symptomPresent = slowMs > 20 && ratio > 10;
process.stdout.write(JSON.stringify({ signal: 'same-output-protected-tree-latency', baselineMedianMs: baselineMs, slowMedianMs: slowMs, ratio: +ratio.toFixed(1), symptomPresent }) + '\n');
Object.assign(fs, original);
syncBuiltinESMExports();
fs.rmSync(work, { recursive: true });
fs.rmSync(protectedSmall, { recursive: true });
fs.rmSync(protectedLarge, { recursive: true });
fs.rmdirSync(temp);

if (symptomPresent) process.exitCode = 1;
