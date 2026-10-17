import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { build } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/node_modules/esbuild/lib/main.js";

const repo = fs.realpathSync("/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable"), local = path.dirname(fileURLToPath(import.meta.url)), remote = "/tmp/ruukoto-tools-29.6uZBBr";
const sha = value => createHash("sha256").update(value).digest("hex"), records = new Map();
fs.mkdirSync(path.join(local, "built"), { recursive: true });
const plugin = { name: "preserve-source-module-urls", setup(builder) {
  builder.onLoad({ filter: /\.ts$/ }, async args => {
    const filename = fs.realpathSync(args.path);
    if (!filename.startsWith(repo + "/") || filename.includes("/node_modules/")) return;
    const relative = path.relative(repo, filename), source = fs.readFileSync(filename, "utf8"), destination = path.join(local, "source", relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, source);
    records.set(relative, { path: relative, bytes: Buffer.byteLength(source), sha256: sha(source) });
    return { contents: source.replaceAll("import.meta.url", JSON.stringify(pathToFileURL(path.join(remote, "source", relative)).href)), loader: "ts", resolveDir: path.dirname(filename) };
  });
} };

if (process.argv[2] === "leaves") {
  for (const [name, entry] of [["io", path.join(repo, "test/personal-tool-io.test.ts")], ["search", path.join(repo, "test/web-search-transport.test.ts")]]) await build({ entryPoints: [entry], outfile: path.join(local, "built", `leaf-${name}.test.mjs`), bundle: true, platform: "node", format: "esm", target: "node24", plugins: [plugin] });
  await build({ entryPoints: [path.resolve(local, "../../../../test/personal-tool-fifo.test.ts")], outfile: path.join(local, "built/leaf-fifo.test.mjs"), bundle: true, platform: "node", format: "esm", target: "node24" });
} else {
  await build({ entryPoints: [path.join(local, "probe-entry.mjs")], outfile: path.join(local, "built/linux-tools-probe.mjs"), bundle: true, external: ["@earendil-works/*", "@modelcontextprotocol/*", "typebox"], platform: "node", format: "esm", target: "node24", plugins: [plugin], banner: { js: "import {createRequire as probeCreateRequire} from 'node:module';const require=probeCreateRequire(import.meta.url);" } });
  const worker = "worker/personal-command-worker.mjs", destination = path.join(local, "source", worker), bytes = fs.readFileSync(path.join(repo, worker));
  fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, bytes); records.set(worker, { path: worker, bytes: bytes.length, sha256: sha(bytes) });
}
const bundles = fs.readdirSync(path.join(local, "built")).map(name => { const bytes = fs.readFileSync(path.join(local, "built", name)); return { name, bytes: bytes.length, sha256: sha(bytes) }; });
fs.writeFileSync(path.join(local, process.argv[2] === "leaves" ? "leaf-source-manifest.json" : "source-manifest.json"), JSON.stringify({ remote, moduleUrlStrategy: "仓库 TypeScript 模块保留各自远端原目录 URL；Pi 与 typebox 使用原 ESM 包。", records: [...records.values()].sort((a, b) => a.path.localeCompare(b.path)), bundles }, null, 2) + "\n");
process.stdout.write(JSON.stringify({ sourceFiles: records.size, bundles }) + "\n");
