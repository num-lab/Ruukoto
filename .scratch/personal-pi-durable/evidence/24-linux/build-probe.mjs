import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const repo = '/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable';
const local = '/tmp/ruukoto-command-24.93Sjb4';
const remote = '/tmp/ruukoto-command-24.uPkbfF';
const { build } = await import(pathToFileURL(path.join(repo, 'node_modules/esbuild/lib/main.js')));
const sha = value => createHash('sha256').update(value).digest('hex');
const output = path.join(local, 'source/apps/ruukoto/src/linux-command-probe.mjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
const result = await build({
  entryPoints: [path.join(local, 'probe-entry.mjs')], bundle: true, format: 'esm',
  platform: 'node', target: 'node24', outfile: output, metafile: true,
  plugins: [{ name: 'preserve-source-module-urls', setup(builder) {
    builder.onLoad({ filter: /\.ts$/ }, async args => {
      if (!args.path.startsWith(repo + path.sep)) return undefined;
      const source = fs.readFileSync(args.path, 'utf8');
      const url = pathToFileURL(path.join(remote, 'source', path.relative(repo, args.path))).href;
      return { contents: source.replaceAll('import.meta.url', JSON.stringify(url)), loader: 'ts', resolveDir: path.dirname(args.path) };
    });
  } }],
});
fs.writeFileSync(path.join(local, 'metafile.json'), JSON.stringify(result.metafile, null, 2) + '\n');
const files = Object.keys(result.metafile.inputs).map(input => path.resolve(input)).filter(input => input.startsWith(repo + path.sep));
const records = files.map(filename => ({ path: path.relative(repo, filename), sha256: sha(fs.readFileSync(filename)) }));
const worker = path.join(repo, 'worker/personal-command-worker.mjs');
fs.mkdirSync(path.join(local, 'source/worker'), { recursive: true });
fs.copyFileSync(worker, path.join(local, 'source/worker/personal-command-worker.mjs'));
records.push({ path: 'worker/personal-command-worker.mjs', sha256: sha(fs.readFileSync(worker)) });
fs.writeFileSync(path.join(local, 'source-manifest.json'), JSON.stringify({ records, probeSha256: sha(fs.readFileSync(path.join(local, 'probe-entry.mjs'))), bundleSha256: sha(fs.readFileSync(output)), moduleUrlStrategy: 'each bundled repository TypeScript module keeps its original directory under remote source/' }, null, 2) + '\n');
process.stdout.write(JSON.stringify({ output, sourceFiles: records.length, bytes: fs.statSync(output).size }) + '\n');
