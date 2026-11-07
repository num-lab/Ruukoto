import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const { appTestBatches } = await import(new URL("../scripts/test-app.mjs", import.meta.url).href);
const FILES = ["100-worker-stop.test.ts", "101-native-macos-helper.test.ts", "background-processes-recovery.test.ts", "background-processes.test.ts", "native-macos-identity.test.ts", "125-other.test.ts"];

test("macOS 独占与其余批次完整分配每个文件一次，Linux 使用同一批次；固定独占文件缺失拒绝", () => {
  const files = [...FILES.map(file => `test/${file}`), "test/124-test-app-runner.test.ts"];
  for (const platform of ["darwin", "linux"]) {
    const batches: Array<{ files: string[]; serial: boolean }> = appTestBatches(files, platform);
    const assigned = batches.flatMap(batch => batch.files);
    assert.deepEqual(assigned.slice().sort(), files.slice().sort());
    assert.equal(new Set(assigned).size, files.length);
    assert.deepEqual(batches.map(batch => batch.serial), platform === "darwin" ? [true, false] : [false]);
    if (platform === "darwin") assert.deepEqual(batches[0].files, files.slice(0, 5));
  }
  for (const file of files.slice(0, 5)) assert.throws(() => appTestBatches(files.filter(candidate => candidate !== file), "darwin"), /Missing macOS exclusive test/);
  assert.throws(() => appTestBatches([], "linux"), /No application tests found/);
});

test("shards cover every file once and retain macOS exclusive ordering", () => {
  const files = [...FILES, "126-other.test.ts", "127-other.test.ts", "128-other.test.ts", "129-other.test.ts"].map(file => `test/${file}`);
  for (const platform of ["darwin", "linux"]) {
    assert.deepEqual(appTestBatches(files, platform, "1/1"), appTestBatches(files, platform));
    for (const total of [2, 3, 4]) {
      const shards: Array<Array<{ files: string[]; serial: boolean }>> = Array.from({ length: total }, (_, i) => appTestBatches(files, platform, `${i + 1}/${total}`));
      const assigned = shards.flatMap(batches => batches.flatMap(batch => batch.files));
      assert.deepEqual(assigned.slice().sort(), files.slice().sort());
      assert.equal(new Set(assigned).size, files.length);
      const ordinary = platform === "darwin" ? files.slice(5) : files;
      for (const [i, batches] of shards.entries()) {
        assert.deepEqual(batches.filter(batch => !batch.serial).flatMap(batch => batch.files), ordinary.filter((_, position) => position % total === i));
        assert.deepEqual(batches.filter(batch => batch.serial).flatMap(batch => batch.files), platform === "darwin" && i === 0 ? files.slice(0, 5) : []);
      }
      if (platform === "darwin") assert.equal(shards[0][0].serial, true);
    }
  }
  for (const shard of ["", "0/4", "1/0", "5/4", "1.5/4", "01/4", "1/2/3", "1/9007199254740992"]) assert.throws(() => appTestBatches(files, "linux", shard), /Invalid shard/);
  assert.throws(() => appTestBatches(files, "linux", "20/20"), /has no application tests/);
  assert.throws(() => appTestBatches(files.slice(1), "darwin", "2/4"), /Missing macOS exclusive test/);
});

type Mode = "success" | "first-failure" | "remaining-failure" | "missing" | "spawn-error" | "null-status" | "signal" | "exit-code";

function fixture(mode: Mode, { files = FILES, selected = files, platform = "darwin" }: { files?: string[]; selected?: string[]; platform?: string } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-test-app-"));
  const trace = path.join(root, "trace");
  fs.mkdirSync(path.join(root, "scripts")); fs.mkdirSync(path.join(root, "test")); fs.mkdirSync(path.join(root, "node_modules", "tsx"), { recursive: true });
  fs.copyFileSync(new URL("../scripts/test-app.mjs", import.meta.url), path.join(root, "scripts", "test-app.mjs"));
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
  fs.writeFileSync(path.join(root, "node_modules", "tsx", "package.json"), '{"type":"module","exports":"./index.mjs"}\n');
  fs.writeFileSync(path.join(root, "node_modules", "tsx", "index.mjs"), 'import {register} from "node:module"; register(new URL("./loader.mjs",import.meta.url));\n');
  fs.writeFileSync(path.join(root, "node_modules", "tsx", "loader.mjs"), 'import {readFile} from "node:fs/promises"; export async function load(url,context,nextLoad){return url.endsWith(".test.ts") ? {format:"module",source:await readFile(new URL(url),"utf8"),shortCircuit:true} : nextLoad(url,context);}\n');
  for (const [index, file] of files.entries()) {
    const failed = mode === "first-failure" ? index === 0 : mode === "remaining-failure" && index === files.length - 1;
    fs.writeFileSync(path.join(root, "test", file), `import assert from "node:assert/strict"; import * as fs from "node:fs"; import {test} from "node:test";
process.once("exit",()=>fs.appendFileSync(${JSON.stringify(trace)},${JSON.stringify("exit:" + file + "\n")}));
test(${JSON.stringify(file)},()=>{assert.equal(process.env.RUN_MODEL_CHECK,"0"); assert.equal(process.env.RUN_BACKGROUND_BROWSER_CHECK,"0"); const prior=fs.existsSync(${JSON.stringify(trace)}) ? fs.readFileSync(${JSON.stringify(trace)},"utf8") : ""; assert.equal(prior,${JSON.stringify(selected.slice(0, selected.indexOf(file)).map(name => "start:" + name + "\nexit:" + name + "\n").join(""))}); fs.appendFileSync(${JSON.stringify(trace)},${JSON.stringify("start:" + file + "\n")}); assert.equal(${String(failed)},false,"夹具故意失败");});
`);
  }
  let preload = `Object.defineProperty(process,"platform",{value:${JSON.stringify(platform)}});\n`;
  if (mode === "missing") fs.rmSync(path.join(root, "test", FILES[1]));
  if (mode === "spawn-error" || mode === "signal" || mode === "exit-code") {
    const executable = path.join(root, "child");
    if (mode === "signal") fs.writeFileSync(executable, "#!/bin/sh\nkill -TERM $$\n", { mode: 0o755 });
    if (mode === "exit-code") fs.writeFileSync(executable, "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    preload += `Object.defineProperty(process,"execPath",{value:${JSON.stringify(executable)}});\n`;
  }
  if (mode === "null-status") preload += 'import childProcess from "node:child_process"; import {syncBuiltinESMExports} from "node:module"; childProcess.spawnSync=()=>({status:null,signal:null}); syncBuiltinESMExports();\n';
  const preloadPath = path.join(root, "preload.mjs"); fs.writeFileSync(preloadPath, preload);
  const env: NodeJS.ProcessEnv = { ...process.env, RUN_MODEL_CHECK: "1", RUN_BACKGROUND_BROWSER_CHECK: "1" };
  // A standalone CLI must not inherit node:test's recursive-test marker.
  delete env.NODE_TEST_CONTEXT;
  return {
    run: (args: string[] = []) => spawnSync(process.execPath, ["--import", preloadPath, "scripts/test-app.mjs", ...args], { cwd: root, env, encoding: "utf8" }),
    trace: () => fs.existsSync(trace) ? fs.readFileSync(trace, "utf8") : "",
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("实际 CLI 等独占文件进程退出后执行其余批次，每份测试一次且固定关闭真实模型", () => {
  const f = fixture("success");
  try {
    const result = f.run(); assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(f.trace(), FILES.map(file => "start:" + file + "\nexit:" + file + "\n").join(""));
  } finally { f.cleanup(); }
});

test("CLI selects shards on both platforms and rejects invalid or empty selections before execution", () => {
  for (const [platform, shard, selected] of [["darwin", "1/2", FILES], ["darwin", "2/2", ["126-other.test.ts"]], ["linux", "4/4", ["126-other.test.ts"]]] as const) {
    const f = fixture("success", { files: [...FILES, "126-other.test.ts"], selected: [...selected], platform });
    try {
      const result = f.run([`--shard=${shard}`]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(f.trace(), selected.map(file => `start:${file}\nexit:${file}\n`).join(""));
    } finally { f.cleanup(); }
  }
  for (const args of [["--shard=0/4"], ["--shard=2/2"], ["--shard="], ["--other"], ["--shard=1/2", "--shard=2/2"]]) {
    const f = fixture("success");
    try { assert.equal(f.run(args).status, 1); assert.equal(f.trace(), ""); } finally { f.cleanup(); }
  }
});

for (const mode of ["first-failure", "remaining-failure", "missing", "spawn-error", "null-status", "signal", "exit-code"] as const) test(`实际 CLI ${mode} 不吞失败或跳批报成功`, () => {
  const f = fixture(mode);
  try {
    const result = f.run(["--shard=1/2"]);
    if (mode === "signal") { assert.equal(result.signal, "SIGTERM"); assert.equal(result.status, null); }
    else { assert.equal(result.status, mode === "exit-code" ? 7 : 1, result.stdout + result.stderr); assert.equal(result.signal, null); }
    if (mode === "first-failure") assert.ok(!f.trace().includes(FILES.at(-1)!), "独占批次失败后，其余批次不得执行");
    if (mode === "remaining-failure") assert.ok(f.trace().includes("start:" + FILES.at(-1)!), "不能跳过失败的第二批");
    if (["missing", "spawn-error", "null-status", "signal", "exit-code"].includes(mode)) assert.equal(f.trace(), "");
    if (mode === "missing") assert.match(result.stderr, /101-native-macos-helper/);
    if (mode === "spawn-error") assert.match(result.stderr, /ENOENT/);
    if (mode === "null-status") assert.match(result.stderr, /no exit status/);
  } finally { f.cleanup(); }
});
