import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import * as dns from "node:dns";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { preparePersonalFile, executePersonalFile, preparePersonalHttp, executePersonalHttp, PERSONAL_TOOL_CAPTURE_BYTES, type PersonalToolCredential } from "../apps/ruukoto/src/personal-tool-io.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { executeApprovedFileOp } from "@ruukoto/agent/execution/approved-ops.ts";

function files(t: TestContext) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-tool-io-")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, "target"), protectedRoot = path.join(directory, "private");
  fs.mkdirSync(protectedRoot);
  return { directory, target, protectedRoots: [protectedRoot] };
}

async function server(t: TestContext, listener: http.RequestListener) {
  const value = http.createServer(listener);
  value.listen(0, "127.0.0.1"); await once(value, "listening");
  const address = value.address(); assert.ok(address && typeof address === "object");
  t.after(async () => { value.closeAllConnections(); await new Promise<void>(resolve => value.close(() => resolve())); });
  return `http://127.0.0.1:${address.port}`;
}

test("个人文件：原字节有界捕获，准备记录为不含 undefined 的 JSON", t => {
  const f = files(t), bytes = Buffer.alloc(PERSONAL_TOOL_CAPTURE_BYTES + 7, 0xff);
  bytes.set([0, 1, 0xc3, 0x28]); fs.writeFileSync(f.target, bytes);
  const prepared = preparePersonalFile({ path: f.target, access: "read", protectedRoots: f.protectedRoots });
  assert.deepEqual(JSON.parse(JSON.stringify(prepared)), prepared);
  const result = executePersonalFile(prepared);
  assert.equal(result.effect, "returned"); assert.equal(result.partial, true);
  assert.deepEqual(result.bytes, bytes.subarray(0, PERSONAL_TOOL_CAPTURE_BYTES));
});

for (const mutation of ["replace", "content"] as const) test(`个人文件：等待后${mutation}拒绝原读取与写入`, t => {
  const f = files(t); fs.writeFileSync(f.target, "before");
  const read = preparePersonalFile({ path: f.target, access: "read", protectedRoots: f.protectedRoots });
  const write = preparePersonalFile({ path: f.target, access: "read_write", content: "after", protectedRoots: f.protectedRoots });
  if (mutation === "replace") { fs.renameSync(f.target, f.target + ".old"); fs.writeFileSync(f.target, "replacement"); }
  else fs.writeFileSync(f.target, "changed");
  assert.equal(executePersonalFile(read).effect, "not_executed");
  assert.equal(executePersonalFile(write).effect, "not_executed");
  assert.notEqual(fs.readFileSync(f.target, "utf8"), "after");
});

test("个人文件：保护资料和符号链接提前拒绝，完全访问钉定真实对象，新文件父目录变化拒绝", t => {
  const f = files(t); fs.writeFileSync(f.target, "text");
  const secret = path.join(f.protectedRoots[0], "credential"); fs.writeFileSync(secret, "secret");
  assert.throws(() => preparePersonalFile({ path: secret, access: "read", protectedRoots: f.protectedRoots }), PersonalError);
  const link = path.join(f.directory, "link"); fs.symlinkSync(f.target, link);
  assert.throws(() => preparePersonalFile({ path: link, access: "read", protectedRoots: f.protectedRoots }), PersonalError);
  assert.equal(executePersonalFile(preparePersonalFile({ path: link, access: "read", protectedRoots: [] })).bytes.toString(), "text");
  const parent = path.join(f.directory, "parent"); fs.mkdirSync(parent);
  const write = preparePersonalFile({ path: path.join(parent, "new"), access: "read_write", content: "new", protectedRoots: f.protectedRoots });
  fs.renameSync(parent, parent + ".old"); fs.mkdirSync(parent);
  assert.equal(executePersonalFile(write).effect, "not_executed");
  assert.equal(fs.existsSync(path.join(parent, "new")), false);
});

test("个人文件：写入成功保持字节，fsync 失败保留真实写入并报告未知", t => {
  const f = files(t);
  fs.writeFileSync(f.target, "original");
  const write = preparePersonalFile({ path: f.target, access: "read_write", content: "first", protectedRoots: f.protectedRoots });
  assert.equal(executePersonalFile(write).effect, "returned");
  const second = preparePersonalFile({ path: f.target, access: "read_write", content: "second", protectedRoots: f.protectedRoots });
  const nodeFs = awaitImportFs();
  const mocked = t.mock.method(nodeFs, "fsyncSync", () => { throw new Error("unsafe-native-detail"); });
  syncBuiltinESMExports();
  let result;
  try { result = executePersonalFile(second); } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(result.effect, "effect_unknown"); assert.equal(fs.readFileSync(f.target, "utf8"), "second");
  assert.equal(JSON.stringify(result).includes("unsafe-native-detail"), false);
});

test("个人文件：新建相对已核实目录句柄，祖先替换不能在保护目录创建", t => {
  const f = files(t), parent = path.join(f.directory, "parent"), retained = parent + ".old";
  fs.mkdirSync(parent);
  const target = path.join(parent, "new"), prepared = preparePersonalFile({ path: target, access: "read_write", content: "created", protectedRoots: f.protectedRoots });
  if (process.platform !== "linux") {
    const unsupported = executePersonalFile(prepared);
    assert.equal(unsupported.effect, "not_executed"); assert.equal(unsupported.code, "file_creation_unavailable"); assert.equal(fs.existsSync(target), false);
    return;
  }
  const nodeFs = awaitImportFs(), open = nodeFs.openSync;
  let swapped = false;
  const mocked = t.mock.method(nodeFs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    if (!swapped && String(args[0]).startsWith("/proc/self/fd/") && String(args[0]).endsWith("/new")) { swapped = true; fs.renameSync(parent, retained); fs.symlinkSync(f.protectedRoots[0], parent); }
    return open(...args);
  });
  syncBuiltinESMExports();
  let result;
  try { result = executePersonalFile(prepared); } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(swapped, true); assert.equal(result.effect, "returned");
  assert.equal(fs.readFileSync(path.join(retained, "new"), "utf8"), "created"); assert.equal(fs.existsSync(path.join(f.protectedRoots[0], "new")), false);
});

test("受信文件写入：新建与改写完成所有短写，零字节写入保留未知", t => {
  const f = files(t), nodeFs = awaitImportFs(), original = nodeFs.writeSync;
  const requests = ["existing", "new"].map(name => {
    const target = path.join(f.directory, name);
    if (name === "existing") fs.writeFileSync(target, "old");
    return preparePersonalFile({ path: target, access: "read_write", content: "complete-new-data", protectedRoots: f.protectedRoots });
  });
  let zero = false;
  const mocked = t.mock.method(nodeFs, "writeSync", (fd: number, bytes: NodeJS.ArrayBufferView, offset: number, length: number, position: number) => zero ? 0 : original(fd, bytes, offset, Math.min(2, length), position));
  syncBuiltinESMExports();
  try {
    for (const request of requests) { assert.equal(executeApprovedFileOp(request).ok, true); assert.equal(fs.readFileSync(request.path, "utf8"), "complete-new-data"); }
    const request = preparePersonalFile({ path: requests[0].path, access: "read_write", content: "replacement", protectedRoots: f.protectedRoots });
    zero = true;
    const outcome = executeApprovedFileOp(request);
    assert.equal(outcome.ok, false); assert.equal(outcome.effectUnknown, true);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

const require = createRequire(import.meta.url);
function awaitImportFs(): typeof import("node:fs") { return require("node:fs") as typeof import("node:fs"); }

test("个人 HTTP：捕获二进制、过滤敏感响应头且只发一次不跟随重定向", async t => {
  let calls = 0;
  const expected = Buffer.from([0, 0xff, 0xc3, 0x28]);
  const target = await server(t, (_req, res) => { calls++; res.writeHead(302, { location: "/next", "set-cookie": "private", authorization: "private", "content-type": "application/octet-stream" }); res.end(expected); });
  const prepared = await preparePersonalHttp({ method: "get", url: target });
  assert.equal(prepared.pinnedAddress, "127.0.0.1");
  const result = await executePersonalHttp(prepared);
  assert.equal(result.effect, "returned"); assert.equal(result.stopped, true); assert.equal(result.partial, false);
  assert.equal(result.status, 302); assert.equal(calls, 1); assert.deepEqual(result.bytes, expected);
  assert.equal(result.headers.location, "/next"); assert.equal(result.headers["set-cookie"], undefined); assert.equal(result.headers.authorization, undefined);
});

test("个人 HTTP：超限保留有界原字节并关闭原连接", async t => {
  const target = await server(t, (_req, res) => { res.end(Buffer.alloc(PERSONAL_TOOL_CAPTURE_BYTES + 7, 0xff)); });
  const result = await executePersonalHttp(await preparePersonalHttp({ method: "GET", url: target }));
  assert.equal(result.effect, "no_write"); assert.equal(result.code, "http_response_limit"); assert.equal(result.partial, true); assert.equal(result.stopped, true);
  assert.equal(result.bytes.length, PERSONAL_TOOL_CAPTURE_BYTES); assert.ok(result.bytes.every(byte => byte === 0xff));
});

test("个人 HTTP：连接使用审批前固定地址，不重新解析目标域名", async t => {
  const target = await server(t, (_req, res) => res.end("pinned"));
  const resolver = t.mock.method(dns.promises, "lookup", async () => ({ address: "127.0.0.1", family: 4 }));
  const prepared = await preparePersonalHttp({ method: "GET", url: target.replace("127.0.0.1", "approval-target.invalid") });
  resolver.mock.mockImplementation(async () => { throw new Error("must-not-resolve-again"); });
  const result = await executePersonalHttp(prepared);
  assert.equal(result.effect, "returned"); assert.equal(result.bytes.toString(), "pinned"); assert.equal(resolver.mock.callCount(), 1);
});

test("个人 HTTP：中断保留片段，GET 无写入效果，POST 与带正文 GET 保持未知", async t => {
  let calls = 0;
  const target = await server(t, (_req, res) => { calls++; res.writeHead(200, { "content-length": "20" }); res.write(Buffer.from([0, 255, 1]), () => { setTimeout(() => res.destroy(), 10); }); });
  for (const [method, body, effect] of [["GET", undefined, "no_write"], ["POST", "content", "effect_unknown"], ["GET", "content", "effect_unknown"]] as const) {
    const result = await executePersonalHttp(await preparePersonalHttp({ method, url: target, ...(body !== undefined ? { body } : {}) }));
    assert.equal(result.effect, effect, method); assert.equal(result.partial, true); assert.equal(result.stopped, true); assert.deepEqual(result.bytes, Buffer.from([0, 255, 1]), method);
  }
  assert.equal(calls, 3);
});

test("个人 HTTP：取消等待 socket 关闭，不重复写；开始前取消不发送", async t => {
  let calls = 0;
  let received!: () => void; const pending = new Promise<void>(resolve => { received = resolve; });
  const target = await server(t, (_req, res) => { calls++; res.write("part"); received(); });
  const controller = new AbortController();
  const prepared = await preparePersonalHttp({ method: "POST", url: target, body: "content" });
  const active = executePersonalHttp(prepared, controller.signal); await pending; controller.abort();
  const result = await active;
  assert.equal(result.effect, "effect_unknown"); assert.equal(result.stopped, true); assert.equal(result.code, "http_canceled");
  assert.equal((await executePersonalHttp(prepared, controller.signal)).effect, "not_executed"); assert.equal(calls, 1);
});

test("个人 HTTP：拒绝 URL 凭据和私带秘密头，固定凭据仅执行时注入，秘密回显不出结果", async t => {
  const secret = 'unique/+host?"secret-123'; process.env.PERSONAL_TOOL_TEST_TOKEN = secret;
  t.after(() => { delete process.env.PERSONAL_TOOL_TEST_TOKEN; });
  const received: string[] = [];
  const forms = [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)];
  const target = await server(t, (req, res) => { received.push(req.headers.authorization ?? ""); res.writeHead(200, { location: `/next?token=${forms[(received.length - 1) % forms.length]}` }); res.end(received.length === 1 ? "safe" : forms[received.length - 2]); });
  const forbiddenHeaders: Record<string, string>[] = [{ authorization: secret }, { cookie: secret }, { "x-api-key": secret }, { host: "other" }];
  for (const headers of forbiddenHeaders) await assert.rejects(preparePersonalHttp({ method: "GET", url: target, headers }), PersonalError);
  await assert.rejects(preparePersonalHttp({ method: "GET", url: target.replace("http://", "http://name:password@") }), PersonalError);
  const credential: PersonalToolCredential = { name: "test", host: new URL(target).host, header: "authorization", env: "PERSONAL_TOOL_TEST_TOKEN" };
  const prepared = await preparePersonalHttp({ method: "GET", url: target, credential });
  assert.equal(JSON.stringify(prepared).includes(secret), false);
  const safe = await executePersonalHttp(prepared);
  assert.equal(safe.bytes.toString(), "safe"); assert.equal(JSON.stringify(safe).includes(secret), false); assert.equal(safe.headers.location, undefined);
  for (const _form of forms) {
    const echoed = await executePersonalHttp(prepared);
    assert.equal(echoed.code, "credential_response_unsafe"); assert.equal(echoed.effect, "returned"); assert.equal(echoed.partial, true); assert.equal(echoed.bytes.length, 0);
    assert.equal(echoed.headers.location, undefined); assert.equal(JSON.stringify(echoed).includes(secret), false);
  }
  assert.deepEqual(received, [secret, secret, secret, secret]);
  process.env.PERSONAL_TOOL_TEST_TOKEN = "rotated-host-secret";
  const changed = await executePersonalHttp(prepared);
  assert.equal(changed.effect, "not_executed"); assert.equal(changed.code, "credentials_changed"); assert.equal(received.length, 4);
  delete process.env.PERSONAL_TOOL_TEST_TOKEN;
  assert.equal((await executePersonalHttp(prepared)).effect, "not_executed"); assert.equal(received.length, 4);
});

test("个人 HTTP：截断和中断落在秘密中间时不保留秘密前缀", async t => {
  const secret = "private-response-token"; process.env.PERSONAL_TOOL_TEST_TOKEN = secret;
  t.after(() => { delete process.env.PERSONAL_TOOL_TEST_TOKEN; });
  const target = await server(t, (req, res) => {
    if (req.url === "/cap") res.end(Buffer.concat([Buffer.alloc(PERSONAL_TOOL_CAPTURE_BYTES - 5, 120), Buffer.from(secret)]));
    else { res.writeHead(200, { "content-length": "100" }); res.write(secret.slice(0, 5), () => { setTimeout(() => res.destroy(), 10); }); }
  });
  const credential = { name: "test", host: new URL(target).host, header: "authorization", env: "PERSONAL_TOOL_TEST_TOKEN" };
  for (const pathname of ["/cap", "/partial"]) {
    const result = await executePersonalHttp(await preparePersonalHttp({ method: "GET", url: target + pathname, credential }));
    assert.equal(result.code, "credential_response_unsafe"); assert.equal(result.bytes.length, 0); assert.equal(result.partial, true); assert.equal(result.stopped, true);
  }
});

test("受信文件写入：截短已开始后异常不能报告未执行", t => {
  const { directory } = files(t), target = path.join(directory, "truncate");
  fs.writeFileSync(target, "原文");
  const prepared = preparePersonalFile({ path: target, access: "read_write", content: "新文", protectedRoots: [] });
  const nodeFs = createRequire(import.meta.url)("node:fs") as typeof fs, original = fs.ftruncateSync;
  const mock = t.mock.method(nodeFs, "ftruncateSync", (fd: number, length?: number) => { original(fd, length); throw new Error("截短后磁盘错误"); });
  syncBuiltinESMExports();
  try { assert.equal(executeApprovedFileOp(prepared).effectUnknown, true); assert.equal(fs.readFileSync(target, "utf8"), ""); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
});
