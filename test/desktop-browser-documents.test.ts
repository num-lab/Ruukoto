import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { pathToFileURL } from "node:url";
import type { BrowserDocumentHandle } from "../apps/desktop/src/shared/bridge.ts";
import { DesktopHost } from "../apps/desktop/src/main/host.ts";
import { browserAddress } from "../apps/desktop/src/renderer/browser-navigation.ts";
import { DesktopError } from "../apps/desktop/src/main/environment.ts";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ruukoto-browser-"));
  const directory = path.join(root, "document");
  await fs.mkdir(path.join(directory, "assets"), { recursive: true });
  await fs.writeFile(path.join(directory, "index.html"), '<!doctype html><title>本机文档</title><link rel="stylesheet" href="assets/style.css"><img src="assets/pixel.svg"><script type="module" src="assets/main.js"></script>');
  await fs.writeFile(path.join(directory, "assets/style.css"), "body { color: rgb(12, 34, 56) }");
  await fs.writeFile(path.join(directory, "assets/pixel.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>');
  await fs.writeFile(path.join(directory, "assets/main.js"), 'import { value } from "./part.js"; const data = await fetch("data.json", { credentials: "omit" }).then(r => r.json()); document.body.dataset.result = `${value}:${data.ok}`;');
  await fs.writeFile(path.join(directory, "assets/part.js"), 'export const value = "module";');
  await fs.writeFile(path.join(directory, "data.json"), '{"ok":true}');
  await fs.writeFile(path.join(root, "outside.txt"), "不能读取");
  return { root, directory, url: pathToFileURL(path.join(directory, "index.html")).href, async close() { await fs.rm(root, { recursive: true, force: true }); } };
}

function raw(url: string, target: string, headers: http.OutgoingHttpHeaders = {}, method = "GET"): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { path: target, headers, method }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    request.on("error", reject); request.end();
  });
}

test("本机 URL 在 Desktop 与 Demo 规范化，拒绝网络文件主机和编码分隔符", async () => {
  const demo = await import("../.scratch/desktop-shadcn/demo/src/inspector-data.ts");
  for (const parse of [browserAddress, demo.browserAddress]) {
    assert.equal(parse(" file:///tmp/本机 文档.html#section "), "file:///tmp/%E6%9C%AC%E6%9C%BA%20%E6%96%87%E6%A1%A3.html#section");
    assert.equal(parse("file://localhost/tmp/page.html"), "file:///tmp/page.html");
    for (const value of ["file://remote/tmp/page.html", "file:relative.html", "file:///tmp/a%2fb.html", "file:///tmp/a%5cb.html", "file:///tmp/a%00.html", "file:///tmp/%zz.html", "file:///tmp/page.html?query", "file:///", "file:////server/share", "javascript:evil", "data:text/html,evil"]) assert.equal(parse(value), null, value);
  }
});

test("Host 本地文档操作在离线 Code 与未配置 Personal 可用且不触发环境连接", async () => {
  const f = await fixture();
  let environments = 0;
  const host = new DesktopHost(f.root, path.join(f.root, "userdata"), { publish() {}, focused: () => false, notice() {}, badge() {} }, async () => { environments++; throw new DesktopError("fixture_offline", "离线测试"); });
  try {
    for (const target of ["code", "personal"]) {
      const result = await host.request(target, "desktop_browser_open", { url: f.url });
      assert.equal(result.ok, true, JSON.stringify(result));
      if (!result.ok) continue;
      assert.ok(result.value && typeof result.value === "object" && "url" in result.value && "id" in result.value);
      const document = result.value as { url: string; id: string };
      assert.match(await (await fetch(document.url)).text(), /本机文档/);
      assert.deepEqual(await host.request(target, "desktop_browser_release", { id: document.id }), { ok: true, value: undefined });
      await assert.rejects(fetch(document.url));
    }
    assert.equal(environments, 1, "仅构造时预热，没有为本地操作重连");
    assert.equal((await host.request("remote", "desktop_browser_open", { url: f.url })).ok, false);
    assert.equal((await host.request("code", "desktop_browser_open", { url: f.url, extra: true })).ok, false);
  } finally { await host.close(); await f.close(); }
});

test("真实 loopback 文档资源使用独立 origin、能力路径和无凭据 CORS", async () => {
  const { BrowserDocuments } = await import("../apps/desktop/src/main/browser-documents.ts");
  const f = await fixture(), documents = new BrowserDocuments([]);
  try {
    const first = await documents.open(`${f.url}#section`), second = await documents.open(f.url);
    assert.notEqual(new URL(first.url).origin, new URL(second.url).origin);
    assert.equal(new URL(first.url).hash, "#section");
    assert.equal(new URL(first.url).hostname, "127.0.0.1");
    assert.doesNotMatch(first.url, new RegExp(f.directory));
    const entry = await fetch(first.url);
    assert.match(entry.headers.get("content-type")!, /text\/html/);
    assert.equal(entry.headers.get("referrer-policy"), "no-referrer");
    assert.equal(entry.headers.get("x-content-type-options"), "nosniff");
    assert.match(await entry.text(), /本机文档/);
    for (const resource of ["assets/style.css", "assets/pixel.svg", "assets/main.js", "assets/part.js", "data.json"]) {
      const response = await fetch(new URL(resource, first.url), { headers: { Origin: "null" }, credentials: "omit" });
      assert.equal(response.status, 200, resource);
      assert.equal(response.headers.get("access-control-allow-origin"), "null");
      assert.equal(response.headers.get("access-control-allow-credentials"), null);
      assert.ok((await response.arrayBuffer()).byteLength > 0);
    }
    const preflight = await fetch(new URL("data.json", first.url), { method: "OPTIONS", headers: { Origin: "null", "Access-Control-Request-Method": "GET" } });
    assert.equal(preflight.status, 204);
    const denied = await fetch(first.url, { headers: { Origin: "https://remote.example" } });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
    assert.equal((await raw(first.url, new URL(first.url).pathname, { Host: "remote.example" })).status, 403);
    assert.equal((await fetch(first.url, { method: "POST" })).status, 405);
    await documents.release(first.id);
    await assert.rejects(fetch(first.url));
    assert.equal((await fetch(second.url)).status, 200);
    await documents.release(first.id);
  } finally { await documents.close(); await f.close(); }
});

test("资源不能越界、走链接或读取敏感元数据，失败不暴露绝对路径", async () => {
  const { BrowserDocuments } = await import("../apps/desktop/src/main/browser-documents.ts");
  const f = await fixture(), documents = new BrowserDocuments([path.join(f.directory, "protected")]);
  await fs.symlink(path.join(f.root, "outside.txt"), path.join(f.directory, "linked.txt"));
  await fs.mkdir(path.join(f.directory, ".git")); await fs.writeFile(path.join(f.directory, ".git/config"), "secret");
  for (const file of [".env.local", ".envrc", ".git-credentials"]) await fs.writeFile(path.join(f.directory, file), "secret");
  await fs.mkdir(path.join(f.directory, "protected")); await fs.writeFile(path.join(f.directory, "protected/secret.txt"), "secret");
  try {
    const document = await documents.open(f.url), prefix = new URL(document.url).pathname.split("/").slice(0, 2).join("/");
    for (const target of ["/missing/index.html", `${prefix}/../outside.txt`, `${prefix}/%2e%2e/outside.txt`, `${prefix}/assets%2f..%2foutside.txt`, `${prefix}/linked.txt`, `${prefix}/.git/config`, `${prefix}/.env.local`, `${prefix}/.envrc`, `${prefix}/.git-credentials`, `${prefix}/protected/secret.txt`, `${prefix}/assets/`, `${prefix}/%zz`]) {
      const response = await raw(document.url, target);
      assert.ok(response.status >= 400, target);
      assert.ok(!response.body.includes(f.root), target);
      assert.ok(!response.body.includes("secret"), target);
    }
    for (const file of ["linked.txt", ".env.local", ".envrc", ".git-credentials", ".git/config", "protected/secret.txt"]) await assert.rejects(documents.open(pathToFileURL(path.join(f.directory, file)).href), { code: "browser_file_unsafe" });
    await assert.rejects(documents.open(pathToFileURL(f.directory).href), { code: "browser_file_unsafe" });
  } finally { await documents.close(); await f.close(); }
});

test("单文件和累计资源预算有界，关闭与 pending open 交错不会留下 listener", async () => {
  const { BrowserDocuments, BROWSER_FILE_BYTES, BROWSER_DOCUMENT_BYTES, BROWSER_DOCUMENT_REQUESTS } = await import("../apps/desktop/src/main/browser-documents.ts");
  const f = await fixture(), documents = new BrowserDocuments([]);
  try {
    await fs.writeFile(path.join(f.directory, "large.txt"), Buffer.alloc(BROWSER_FILE_BYTES + 1, 65));
    await assert.rejects(documents.open(pathToFileURL(path.join(f.directory, "large.txt")).href), { code: "browser_file_too_large" });
    await fs.writeFile(path.join(f.directory, "budget.txt"), Buffer.alloc(BROWSER_FILE_BYTES, 65));
    const document = await documents.open(f.url);
    for (let i = 0; i < Math.floor(BROWSER_DOCUMENT_BYTES / BROWSER_FILE_BYTES); i++) {
      const response = await fetch(new URL("budget.txt", document.url));
      await response.arrayBuffer();
    }
    assert.equal((await fetch(new URL("budget.txt", document.url))).status, 429);
    const limited = await documents.open(f.url);
    for (let i = 0; i < BROWSER_DOCUMENT_REQUESTS; i++) { const response = await fetch(limited.url, { method: "HEAD" }); await response.arrayBuffer(); }
    assert.equal((await fetch(limited.url, { method: "HEAD" })).status, 429);
    const pending = documents.open(f.url), closing = documents.close();
    await assert.rejects(pending, { code: "browser_document_closed" });
    await closing;
    await assert.rejects(fetch(document.url)); await assert.rejects(fetch(limited.url));
    await assert.rejects(documents.open(f.url), { code: "browser_document_closed" });
  } finally { await documents.close(); await f.close(); }
});

test("renderer 本地加载只安装当前请求，取消后的迟到能力立即释放", async () => {
  const { startBrowserDocument } = await import("../apps/desktop/src/renderer/browser-document.ts");
  const released: string[] = [], updates: unknown[] = [];
  let finish!: (value: { ok: true; value: { id: string; url: string } }) => void;
  const pending = new Promise<{ ok: true; value: { id: string; url: string } }>(resolve => { finish = resolve; });
  const stop = startBrowserDocument((_target, op, params) => {
    if (op === "desktop_browser_open") return pending;
    released.push(String(params.id)); return Promise.resolve({ ok: true, value: undefined });
  }, "personal", "file:///tmp/document.html", state => updates.push(state));
  stop(); finish({ ok: true, value: { id: "late", url: "http://127.0.0.1:12345/token/index.html" } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(released, ["late"]); assert.deepEqual(updates, []);
});

test("Host.close 拦截在途本地打开，关闭后的请求不能创建监听", async () => {
  const f = await fixture();
  const host = new DesktopHost(f.root, path.join(f.root, "userdata"), { publish() {}, focused: () => false, notice() {}, badge() {} }, async () => { throw new DesktopError("fixture_offline", "离线测试"); });
  try {
    const pending = host.request("personal", "desktop_browser_open", { url: f.url });
    await host.close();
    const result = await pending;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "browser_document_closed");
    const closed = await host.request("code", "desktop_browser_open", { url: f.url });
    assert.equal(closed.ok, false);
  } finally { await host.close(); await f.close(); }
});

test("能力存量与资源并发有界，撤销等待已开始的文件读取", async t => {
  const { BrowserDocuments } = await import("../apps/desktop/src/main/browser-documents.ts");
  const native = await import("node:fs");
  const f = await fixture(), documents = new BrowserDocuments([]);
  let unblock!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  try {
    const opened: BrowserDocumentHandle[] = [];
    for (let i = 0; i < 8; i++) opened.push(await documents.open(f.url));
    await assert.rejects(documents.open(f.url), { code: "browser_document_limit" });
    let started = 0, ready!: () => void;
    const reading = new Promise<void>(resolve => { ready = resolve; });
    const original = native.promises.open;
    t.mock.method(native.promises, "open", async (...args: Parameters<typeof original>) => {
      if (String(args[0]).endsWith("data.json")) { if (++started === 16) ready(); await blocked; }
      return original(...args);
    });
    const requests = Array.from({ length: 16 }, (_, index) => fetch(new URL("data.json", opened[index % 2].url)));
    const outcomes = Promise.allSettled(requests);
    await reading;
    assert.equal((await fetch(new URL("data.json", opened[0].url))).status, 429);
    let released = false;
    const releasing = documents.release(opened[0].id).then(() => { released = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(released, false, "撤销尚在等待已开始的读取");
    unblock(); await releasing; await outcomes;
    await assert.rejects(fetch(opened[0].url));
  } finally { unblock(); t.mock.restoreAll(); await documents.close(); await f.close(); }
});

test("renderer 当前能力卸载只释放一次，明确失败能显示并安全重试", async () => {
  const { startBrowserDocument } = await import("../apps/desktop/src/renderer/browser-document.ts");
  const released: string[] = [], updates: unknown[] = [];
  const stop = startBrowserDocument((_target, op, params) => {
    if (op === "desktop_browser_open") return Promise.resolve({ ok: true, value: { id: "active", url: "http://127.0.0.1:12345/token/index.html" } });
    released.push(String(params.id)); return Promise.resolve({ ok: true, value: undefined });
  }, "code", "file:///tmp/document.html", state => updates.push(state));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updates.length, 1); stop(); stop();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(released, ["active"]);
  startBrowserDocument(async () => ({ ok: false, error: { code: "browser_file_not_found", outcome: "not_sent", message: "文件已不存在" } }), "code", "file:///tmp/missing.html", state => updates.push(state));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(updates[1], { error: "文件已不存在" });
});
