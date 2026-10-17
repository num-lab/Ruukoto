import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const repository = '/Users/eitrous/.codex/worktrees/6f13/ruukoto';
const root = import.meta.dirname;
const project = path.join(root, 'mygo');
const assets = path.join(root, 'assets');
const source = path.join(repository, 'apps/desktop/out/mygo');
for (const file of ['renderer/index.html', 'sidecar.mjs', 'launch.json']) if (!fs.existsSync(path.join(source, file))) throw new Error(`先运行 npm run desktop:mygo:build，缺少 ${file}`);
fs.mkdirSync(project, { recursive: true });
fs.cpSync(source, assets, { recursive: true });
const sourceHashes = {};
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
function record(dir) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isDirectory()) record(file);
    else sourceHashes[path.relative(repository, file)] = sha(fs.readFileSync(file));
  }
}
record(source);
for (const relative of execFileSync('git', ['diff', '--name-only', '--', 'packages/', 'apps/', 'test/'], { cwd: repository, encoding: 'utf8' }).trim().split('\n').filter(Boolean)) if (fs.existsSync(path.join(repository, relative))) sourceHashes[relative] = sha(fs.readFileSync(path.join(repository, relative)));
for (const relative of ['packages/runtime/src/runtime.ts', 'packages/runtime/src/workspace-files.ts', 'test/helpers/testkit.ts', 'apps/desktop/src/renderer/inspector.ts', 'apps/desktop/src/renderer/inspector-panels.tsx']) sourceHashes[relative] = sha(fs.readFileSync(path.join(repository, relative)));
for (const file of ['main.go', 'transport.go', 'preload.js', 'go.mod', 'go.sum']) {
  const origin = path.join(repository, 'apps/desktop/mygo', file);
  sourceHashes[path.relative(repository, origin)] = sha(fs.readFileSync(origin));
  fs.copyFileSync(origin, path.join(project, file));
}
const main = path.join(project, 'main.go');
const report = `
func (d *Desktop) ReportFileTreePerf(ctx context.Context, data json.RawMessage) bool {
  if !d.trusted(ctx) || len(data) > 1024*1024 || !json.Valid(data) { return false }
  return os.WriteFile(${JSON.stringify(path.join(root, 'metrics.json'))}, append(data, '\\n'), 0600) == nil
}
`;
fs.writeFileSync(main, fs.readFileSync(main, 'utf8').replace('Title: "Ruukoto MyGo"', 'Title: "Ruukoto File Tree QA"').replace('func (d *Desktop) Request(', report + '\nfunc (d *Desktop) Request('));
fs.copyFileSync(path.join(root, 'perf.js'), path.join(assets, 'renderer/perf.js'));
const index = path.join(assets, 'renderer/index.html');
fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace('<head>', '<head>\n    <script src="/perf.js"></script>'));
fs.writeFileSync(path.join(project, 'mygo.json'), JSON.stringify({ name: 'Ruukoto File Tree QA', identifier: 'dev.ruukoto.desktop.filetree.qa', version: '0.1.0', frontendDist: path.join(assets, 'renderer'), bindings: path.join(root, 'bindings.ts'), resources: [path.join(assets, 'sidecar.mjs'), path.join(assets, 'launch.json')], out: path.join(root, 'dist'), macos: { signingIdentity: '-' } }, null, 2) + '\n');
fs.writeFileSync(path.join(root, 'source-hashes.json'), JSON.stringify({ repository, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(), createdAt: new Date().toISOString(), paths: sourceHashes }, null, 2) + '\n');
execFileSync('go', ['tool', 'mygo', 'build', '-skip-dmg', '-platform', 'darwin/arm64'], { cwd: project, stdio: 'inherit' });
const app = path.join(root, 'dist/darwin-arm64/Ruukoto File Tree QA.app');
execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
const artifacts = {};
function artifactsAt(dir) { for (const name of fs.readdirSync(dir)) { const file = path.join(dir, name); if (fs.statSync(file).isDirectory()) artifactsAt(file); else artifacts[path.relative(root, file)] = sha(fs.readFileSync(file)); } }
artifactsAt(app);
for (const file of ['perf.js', 'prepare.mjs', 'fixture.mts', 'assets/renderer/index.html']) artifacts[file] = sha(fs.readFileSync(path.join(root, file)));
fs.writeFileSync(path.join(root, 'artifact-hashes.json'), JSON.stringify(artifacts, null, 2) + '\n');
process.stdout.write(`QA app built: ${app}\n`);
