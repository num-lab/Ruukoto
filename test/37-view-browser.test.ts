import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { ESLint, Linter } from "eslint";
import globals from "globals";
import { utf8ByteLength } from "@ruukoto/view/utf8.ts";
import { runProjection } from "./fixtures/view-browser/projection.ts";
import { runRecovery } from "./fixtures/view-browser/history-recovery.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const viewSource = fileURLToPath(new URL("../packages/view/src/", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/view-browser/${name}.ts`, import.meta.url));

async function checkBrowser(entryPoints: string[]): Promise<string> {
  const result = await build({
    stdin: { contents: entryPoints.map((entry, index) => `export * as entry${index} from ${JSON.stringify(entry)};`).join("\n"), resolveDir: root },
    platform: "browser", bundle: true, format: "esm", write: false,
  });
  const source = result.outputFiles[0].text;
  const diagnostics = new Linter().verify(source, {
    languageOptions: { globals: globals.browser, sourceType: "module", ecmaVersion: "latest" },
    rules: { "no-undef": "error" },
  });
  assert.deepEqual(diagnostics, [], "浏览器产物只允许浏览器全局，包含传递依赖的所有可达分支");
  return source;
}

test("UTF-8 计数与 Buffer 对 ASCII、中文、emoji 及孤立代理项一致", () => {
  for (const text of ["", "ASCII", "中文", "🙂", "👩‍💻", "\ud800", "\udc00", "a\ud800中🙂\udc00"]) {
    assert.equal(utf8ByteLength(text), Buffer.byteLength(text), JSON.stringify(text));
  }
});

test("全部 view 模块经浏览器打包和产物全局检查，无 Node 全局仍可投影", async () => {
  const modules = readdirSync(viewSource, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".ts")).map((file) => viewSource + file);
  assert.ok(modules.length > 0);
  await checkBrowser(modules);
  const source = await checkBrowser([fixture("projection"), fixture("history-recovery")]);
  // ESM 的 VM API 需独立开启实验标记，不改变日常应用测试入口。
  const script = `
    import vm from 'node:vm';
    const context = vm.createContext({ TextEncoder });
    const module = new vm.SourceTextModule(${JSON.stringify(source)}, { context });
    await module.link(() => { throw new Error('浏览器产物必须自包含'); });
    await module.evaluate();
    process.stdout.write(JSON.stringify({ buffer: vm.runInContext('typeof Buffer', context),
      process: vm.runInContext('typeof process', context), projection: module.namespace.entry0.runProjection(), recovery: await module.namespace.entry1.runRecovery() }));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-vm-modules", "--input-type=module", "--eval", script]);
  const actual = JSON.parse(stdout);
  assert.equal(actual.buffer, "undefined");
  assert.equal(actual.process, "undefined");
  assert.deepEqual(actual.projection, runProjection());
  assert.deepEqual(actual.recovery, await runRecovery());
  assert.deepEqual(actual.recovery, { offsets: [0, 6, 10], changed: 1, text: "中文🙂尾", truncated: false, ready: true });
  assert.deepEqual(actual.projection.streamed, { text: "中文🙂", totalBytes: 10, truncated: false });
  assert.deepEqual(actual.projection.messages, [
    { text: "中文🙂", totalBytes: 10, truncated: false, streaming: false },
    { text: "中文🙂", totalBytes: 10, truncated: false, streaming: false },
  ]);
  assert.equal(actual.projection.paramsBytes, Buffer.byteLength(JSON.stringify({ command: "中文🙂" })));
  assert.equal(actual.projection.status, "awaiting_confirmation");
});

test("产物全局检查拒绝间接 Buffer 依赖及 core/views 的未执行分支", async () => {
  await assert.rejects(checkBrowser([fixture("entry")]), /Buffer.*not defined/s);
  await assert.rejects(checkBrowser([fileURLToPath(new URL("../packages/core/src/views.ts", import.meta.url))]), /Buffer.*not defined/s);
});

test("view 源码 lint 拒绝 node:* 与 Buffer", async () => {
  const eslint = new ESLint();
  for (const [source, rule] of [
    ['import { randomUUID } from "node:crypto"; export { randomUUID };', "no-restricted-imports"],
    ['export const size = Buffer.byteLength("中文🙂");', "no-restricted-globals"],
  ]) {
    const [result] = await eslint.lintText(source, { filePath: viewSource + "browser-negative.ts" });
    assert.ok(result.messages.some((message) => message.ruleId === rule), JSON.stringify(result.messages));
  }
});
