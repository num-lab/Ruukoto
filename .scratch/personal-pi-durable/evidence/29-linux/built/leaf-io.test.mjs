// ../../../Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/test/personal-tool-io.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import * as fs3 from "node:fs";
import * as path3 from "node:path";
import * as http2 from "node:http";
import * as dns2 from "node:dns";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";

// ../../../Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-tool-io.ts
import * as fs2 from "node:fs";
import * as path2 from "node:path";
import * as dns from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import { createHash as createHash2 } from "node:crypto";

// ../../../Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/packages/agent/src/execution/approved-ops.ts
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
var MAX_HTTP_RESPONSE_BYTES = 1024 * 1024;
var MAX_FILE_CONTENT_BYTES = 8 * 1024 * 1024;
var ApprovedOpError = class extends Error {
};
function lstatNoFollow(p) {
  return fs.lstatSync(p);
}
function identityCovers(parent, target, descendants = false) {
  if (!fs.existsSync(parent)) return false;
  const pinned = fs.statSync(parent, { bigint: true });
  const targetIdentities = /* @__PURE__ */ new Set();
  let current = path.resolve(target);
  for (; ; ) {
    if (fs.existsSync(current)) {
      const stat = fs.statSync(current, { bigint: true });
      if (stat.dev === pinned.dev && stat.ino === pinned.ino) return true;
      if (descendants) targetIdentities.add(`${stat.dev}:${stat.ino}`);
    }
    const ancestor = path.dirname(current);
    if (ancestor === current) break;
    current = ancestor;
  }
  if (!descendants || !pinned.isDirectory()) return false;
  const pending = [fs.realpathSync(parent)], visited = /* @__PURE__ */ new Set();
  while (pending.length) {
    const entry = pending.pop();
    const stat = fs.lstatSync(entry, { bigint: true });
    if (stat.isSymbolicLink()) continue;
    const key = `${stat.dev}:${stat.ino}`;
    if (targetIdentities.has(key)) return true;
    if (!stat.isDirectory() || visited.has(key)) continue;
    visited.add(key);
    pending.push(...fs.readdirSync(entry).map((name) => path.join(entry, name)));
  }
  return false;
}
function isProtectedPath(resolved, protectedRoots) {
  for (const root of protectedRoots) {
    const realRoot = path.resolve(root);
    if (resolved === realRoot || resolved.startsWith(realRoot + path.sep) || identityCovers(realRoot, resolved, true)) {
      return true;
    }
  }
  return false;
}
function assertNotProtected(resolved, protectedRoots) {
  if (isProtectedPath(resolved, protectedRoots)) {
    throw new ApprovedOpError("\u76EE\u6807\u4F4D\u4E8E\u63A7\u5236\u9762/\u670D\u52A1\u6570\u636E\u76EE\u5F55\u5185\uFF0C\u59CB\u7EC8\u6392\u9664\uFF0C\u4E0D\u56E0\u6279\u51C6\u800C\u5F00\u653E");
  }
}
function restrictedResolve(target, opts = { allowMissingLast: false }) {
  const resolved = path.resolve(target);
  const parts = resolved.split(path.sep).filter((p) => p.length > 0);
  let current = "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    current = `${current}/${part}`;
    let st;
    try {
      st = lstatNoFollow(current);
    } catch {
      const isLast = i === parts.length - 1;
      if (isLast && opts.allowMissingLast) break;
      throw new ApprovedOpError(`\u8DEF\u5F84\u89E3\u6790\u5931\u8D25\uFF1A${current} \u4E0D\u5B58\u5728\u6216\u4E0D\u53EF\u8FBE`);
    }
    if (st.isSymbolicLink()) {
      throw new ApprovedOpError(`\u8DEF\u5F84\u5305\u542B\u7B26\u53F7\u94FE\u63A5\u7EC4\u4EF6\uFF0C\u62D2\u7EDD\u53D7\u9650\u89E3\u6790\u4E4B\u5916\u7684\u64CD\u4F5C\uFF1A${current}`);
    }
  }
  return resolved;
}
function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}
function executeApprovedFileOp(req) {
  let writing = false;
  try {
    const resolved = restrictedResolve(req.path, { allowMissingLast: true });
    assertNotProtected(resolved, req.protectedRoots);
    if (req.access === "read_write") assertNotProtected(resolved, req.writeProtectedRoots ?? []);
    let st = null;
    try {
      st = lstatNoFollow(resolved);
    } catch {
    }
    if (st?.isDirectory()) throw new ApprovedOpError("\u76EE\u6807\u662F\u76EE\u5F55\uFF0C\u4E0D\u652F\u6301\u76EE\u5F55\u7EA7\u6587\u4EF6\u64CD\u4F5C");
    if (req.access === "read_write" && req.writeProtectedRoots?.length && st && st.nlink > 1) throw new ApprovedOpError("\u6765\u6E90\u4FDD\u62A4\u4EFB\u52A1\u4E0D\u80FD\u5199\u5165\u591A\u786C\u94FE\u63A5\u6587\u4EF6\uFF0C\u8BF7\u5728\u72EC\u7ACB\u5DE5\u4F5C\u76EE\u5F55\u65B0\u5EFA\u68C0\u67E5\u4EA7\u7269");
    if (req.access === "read") {
      if (!st) throw new ApprovedOpError("\u76EE\u6807\u6587\u4EF6\u4E0D\u5B58\u5728\uFF08\u8BFB\u53D6\uFF09");
      if (st.isSymbolicLink()) throw new ApprovedOpError("\u76EE\u6807\u662F\u7B26\u53F7\u94FE\u63A5\uFF0C\u62D2\u7EDD");
      const fd2 = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const opened = fs.fstatSync(fd2);
        if (!opened.isFile()) throw new ApprovedOpError("\u76EE\u6807\u4E0D\u662F\u666E\u901A\u6587\u4EF6\uFF0C\u672A\u6267\u884C");
        if (req.targetDev !== null && (opened.dev !== req.targetDev || opened.ino !== req.targetIno)) {
          throw new ApprovedOpError("\u76EE\u6807\u6587\u4EF6\u5728\u7B49\u5F85\u671F\u95F4\u5DF2\u88AB\u66FF\u6362\uFF0C\u6279\u51C6\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u7533\u8BF7");
        }
        const buf = fs.readFileSync(fd2);
        return { ok: true, message: `\u5DF2\u8BFB\u53D6 ${resolved}\uFF08${buf.length} \u5B57\u8282\uFF09`, content: buf.toString("utf8") };
      } finally {
        fs.closeSync(fd2);
      }
    }
    if (req.content === void 0) throw new ApprovedOpError("\u5199\u64CD\u4F5C\u7F3A\u5C11\u5F85\u5199\u5185\u5BB9");
    const contentBuf = Buffer.from(req.content, "utf8");
    if (contentBuf.length > MAX_FILE_CONTENT_BYTES) {
      throw new ApprovedOpError(`\u5F85\u5199\u5185\u5BB9\u8D85\u8FC7\u4E0A\u9650\uFF08${MAX_FILE_CONTENT_BYTES} \u5B57\u8282\uFF09`);
    }
    if (st) {
      if (st.isSymbolicLink()) throw new ApprovedOpError("\u76EE\u6807\u5DF2\u662F\u7B26\u53F7\u94FE\u63A5\uFF0C\u62D2\u7EDD\u5199\u5165");
      const fd2 = fs.openSync(resolved, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const opened = fs.fstatSync(fd2);
        if (!opened.isFile()) throw new ApprovedOpError("\u76EE\u6807\u4E0D\u662F\u666E\u901A\u6587\u4EF6\uFF0C\u672A\u6267\u884C");
        if (req.writeProtectedRoots?.length && opened.nlink > 1) throw new ApprovedOpError("\u6765\u6E90\u4FDD\u62A4\u4EFB\u52A1\u4E0D\u80FD\u5199\u5165\u591A\u786C\u94FE\u63A5\u6587\u4EF6\uFF0C\u8BF7\u5728\u72EC\u7ACB\u5DE5\u4F5C\u76EE\u5F55\u65B0\u5EFA\u68C0\u67E5\u4EA7\u7269");
        if (opened.dev !== req.targetDev || opened.ino !== req.targetIno) {
          throw new ApprovedOpError("\u76EE\u6807\u6587\u4EF6\u5728\u7B49\u5F85\u671F\u95F4\u5DF2\u88AB\u66FF\u6362\uFF0C\u6279\u51C6\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u7533\u8BF7");
        }
        if (req.originalSha256 !== null) {
          const original = fs.readFileSync(fd2);
          if (sha256Hex(original) !== req.originalSha256) {
            throw new ApprovedOpError("\u76EE\u6807\u6587\u4EF6\u5185\u5BB9\u4E0E\u6279\u51C6\u65F6\u7684\u539F\u6587\u7248\u672C\u4E0D\u4E00\u81F4\uFF0C\u6279\u51C6\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u7533\u8BF7");
          }
        }
        writing = true;
        fs.ftruncateSync(fd2, 0);
        let offset = 0;
        while (offset < contentBuf.length) {
          const count = fs.writeSync(fd2, contentBuf, offset, contentBuf.length - offset, offset);
          if (count === 0) throw new ApprovedOpError("\u6587\u4EF6\u5199\u5165\u672A\u80FD\u7EE7\u7EED");
          offset += count;
        }
        fs.fsyncSync(fd2);
        return { ok: true, message: `\u5DF2\u5199\u5165 ${resolved}\uFF08${contentBuf.length} \u5B57\u8282\uFF09` };
      } finally {
        fs.closeSync(fd2);
      }
    }
    const parent = path.dirname(resolved);
    const parentSt = lstatNoFollow(parent);
    if (parentSt.dev !== req.targetDev || parentSt.ino !== req.targetIno) {
      throw new ApprovedOpError("\u7236\u76EE\u5F55\u5728\u7B49\u5F85\u671F\u95F4\u5DF2\u53D8\u5316\uFF0C\u6279\u51C6\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u7533\u8BF7");
    }
    const fd = fs.openSync(
      resolved,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      420
    );
    writing = true;
    try {
      let offset = 0;
      while (offset < contentBuf.length) {
        const count = fs.writeSync(fd, contentBuf, offset, contentBuf.length - offset, offset);
        if (count === 0) throw new ApprovedOpError("\u6587\u4EF6\u5199\u5165\u672A\u80FD\u7EE7\u7EED");
        offset += count;
      }
      fs.fsyncSync(fd);
      return { ok: true, message: `\u5DF2\u521B\u5EFA ${resolved}\uFF08${contentBuf.length} \u5B57\u8282\uFF09` };
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    if (writing) return { ok: false, message: "\u6587\u4EF6\u5199\u5165\u5DF2\u5F00\u59CB\u4F46\u7ED3\u679C\u65E0\u6CD5\u6838\u5B9E\uFF0C\u672A\u81EA\u52A8\u91CD\u5199\uFF1B\u8BF7\u5148\u6838\u5B9E\u76EE\u6807\u5185\u5BB9", effectUnknown: true };
    if (err instanceof ApprovedOpError) return { ok: false, message: err.message };
    const code = err?.code;
    if (code === "EEXIST") return { ok: false, message: "\u76EE\u6807\u6587\u4EF6\u5DF2\u5B58\u5728\uFF08\u7B49\u5F85\u671F\u95F4\u88AB\u521B\u5EFA\uFF09\uFF0C\u6279\u51C6\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u7533\u8BF7" };
    if (code === "EACCES" || code === "EPERM") return { ok: false, message: `\u6267\u884C\u8EAB\u4EFD\u65E0\u6743\u9650\u64CD\u4F5C\u76EE\u6807\uFF1A${err.message}` };
    return { ok: false, message: `\u6587\u4EF6\u64CD\u4F5C\u5931\u8D25\uFF1A${err.message}` };
  }
}

// ../../../Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-error.ts
var PersonalError = class extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
    this.name = "PersonalError";
  }
  code;
};

// ../../../Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-tool-io.ts
var PERSONAL_TOOL_CAPTURE_BYTES = 8 * 1024 * 1024;
var PERSONAL_HTTP_TIMEOUT_MS = 3e4;
var inputError = () => new PersonalError("tool_input_invalid", "\u64CD\u4F5C\u53C2\u6570\u65E0\u6CD5\u6838\u5B9E\uFF0C\u672A\u6267\u884C\uFF1B\u8BF7\u4FEE\u6B63\u53C2\u6570\u540E\u91CD\u65B0\u7533\u8BF7\u3002");
var fileError = () => new PersonalError("file_target_invalid", "\u76EE\u6807\u6587\u4EF6\u6216\u4FDD\u62A4\u8303\u56F4\u65E0\u6CD5\u6838\u5B9E\uFF0C\u672A\u6267\u884C\uFF1B\u8BF7\u68C0\u67E5\u539F\u76EE\u6807\u540E\u91CD\u65B0\u7533\u8BF7\u3002");
var validText = (value, cap) => !/[\x00-\x1f\x7f]/.test(value) && Buffer.byteLength(value) <= cap;
function readFileBytes(fd, capture) {
  const hash = createHash2("sha256"), buffer = Buffer.alloc(64 * 1024), chunks = [];
  let offset = 0, captured = 0;
  for (; ; ) {
    const count = fs2.readSync(fd, buffer, 0, buffer.length, offset);
    if (!count) break;
    const chunk = buffer.subarray(0, count);
    hash.update(chunk);
    const available = capture ? Math.max(0, PERSONAL_TOOL_CAPTURE_BYTES - captured) : 0;
    if (available) {
      const copy = Buffer.from(chunk.subarray(0, available));
      chunks.push(copy);
      captured += copy.length;
    }
    offset += count;
  }
  return { hash: hash.digest("hex"), bytes: Buffer.concat(chunks, captured), partial: offset > captured };
}
function preparePersonalFile(input) {
  if (!path2.isAbsolute(input.path) || !validText(input.path, 4096) || !["read", "read_write"].includes(input.access) || input.access === "read_write" && (typeof input.content !== "string" || Buffer.byteLength(input.content) > PERSONAL_TOOL_CAPTURE_BYTES) || input.access === "read" && input.content !== void 0) throw inputError();
  try {
    const resolved = input.protectedRoots.length ? restrictedResolve(input.path, { allowMissingLast: input.access === "read_write" }) : fs2.existsSync(input.path) ? fs2.realpathSync(input.path) : path2.join(fs2.realpathSync(path2.dirname(input.path)), path2.basename(input.path));
    if (isProtectedPath(resolved, input.protectedRoots)) throw fileError();
    const existing = fs2.lstatSync(resolved, { throwIfNoEntry: false });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw fileError();
    if (!existing && input.access === "read") throw fileError();
    const identity = existing ?? fs2.lstatSync(path2.dirname(resolved));
    let originalSha256 = null;
    if (existing) {
      const fd = fs2.openSync(resolved, fs2.constants.O_RDONLY | fs2.constants.O_NOFOLLOW | fs2.constants.O_NONBLOCK);
      try {
        const opened = fs2.fstatSync(fd);
        if (!opened.isFile() || opened.dev !== identity.dev || opened.ino !== identity.ino) throw fileError();
        originalSha256 = readFileBytes(fd, false).hash;
        const after = fs2.fstatSync(fd);
        if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw fileError();
      } finally {
        fs2.closeSync(fd);
      }
    }
    return { path: resolved, access: input.access, ...input.content !== void 0 ? { content: input.content } : {}, targetDev: identity.dev, targetIno: identity.ino, originalSha256, protectedRoots: [...input.protectedRoots] };
  } catch (error) {
    if (error instanceof PersonalError) throw error;
    throw fileError();
  }
}
function createPersonalFile(request) {
  const result = (effect, code) => ({ effect, code, bytes: Buffer.alloc(0), partial: false });
  if (process.platform !== "linux" || !fs2.existsSync("/proc/self/fd")) return result("not_executed", "file_creation_unavailable");
  let created = false;
  try {
    if (request.content === void 0 || Buffer.byteLength(request.content) > PERSONAL_TOOL_CAPTURE_BYTES) return result("not_executed", "tool_input_invalid");
    const target = restrictedResolve(request.path, { allowMissingLast: true });
    if (isProtectedPath(target, request.protectedRoots) || isProtectedPath(target, request.writeProtectedRoots ?? [])) throw fileError();
    const parent = fs2.openSync(path2.dirname(target), fs2.constants.O_RDONLY | fs2.constants.O_DIRECTORY | fs2.constants.O_NOFOLLOW);
    try {
      const pinned = fs2.fstatSync(parent);
      if (!pinned.isDirectory() || pinned.dev !== request.targetDev || pinned.ino !== request.targetIno) throw fileError();
      const fd = fs2.openSync(`/proc/self/fd/${parent}/${path2.basename(target)}`, fs2.constants.O_WRONLY | fs2.constants.O_CREAT | fs2.constants.O_EXCL | fs2.constants.O_NOFOLLOW, 420);
      created = true;
      try {
        const bytes = Buffer.from(request.content);
        let offset = 0;
        while (offset < bytes.length) {
          const count = fs2.writeSync(fd, bytes, offset, bytes.length - offset, offset);
          if (count === 0) throw fileError();
          offset += count;
        }
        fs2.fsyncSync(fd);
      } finally {
        fs2.closeSync(fd);
      }
    } finally {
      fs2.closeSync(parent);
    }
    return result("returned", "file_returned");
  } catch {
    return result(created ? "effect_unknown" : "not_executed", created ? "file_effect_unknown" : "file_target_changed");
  }
}
function executePersonalFile(request) {
  if (request.access === "read_write") {
    if (request.originalSha256 === null) return createPersonalFile(request);
    const outcome = executeApprovedFileOp(request);
    return { effect: outcome.effectUnknown ? "effect_unknown" : outcome.ok ? "returned" : "not_executed", code: outcome.effectUnknown ? "file_effect_unknown" : outcome.ok ? "file_returned" : "file_target_changed", bytes: Buffer.alloc(0), partial: false };
  }
  let fd;
  try {
    const resolved = restrictedResolve(request.path);
    if (isProtectedPath(resolved, request.protectedRoots)) throw fileError();
    fd = fs2.openSync(resolved, fs2.constants.O_RDONLY | fs2.constants.O_NOFOLLOW | fs2.constants.O_NONBLOCK);
    const identity = fs2.fstatSync(fd);
    if (!identity.isFile() || identity.dev !== request.targetDev || identity.ino !== request.targetIno) throw fileError();
    const read = readFileBytes(fd, true);
    const after = fs2.fstatSync(fd);
    if (after.size !== identity.size || after.mtimeMs !== identity.mtimeMs || after.ctimeMs !== identity.ctimeMs || read.hash !== request.originalSha256) throw fileError();
    return { effect: "returned", code: "file_returned", bytes: read.bytes, partial: read.partial };
  } catch {
    return { effect: "not_executed", code: "file_target_changed", bytes: Buffer.alloc(0), partial: false };
  } finally {
    if (fd !== void 0) fs2.closeSync(fd);
  }
}
var REQUEST_HEADERS = /* @__PURE__ */ new Set(["accept", "content-type", "user-agent"]);
var RESPONSE_HEADERS = /* @__PURE__ */ new Set(["content-type", "content-length", "content-encoding", "location", "etag", "last-modified", "cache-control", "expires", "date", "retry-after"]);
var HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
function validateCredential(value, url) {
  if (!value.name || !validText(value.name, 128) || value.host.toLowerCase() !== url.host.toLowerCase() || !HEADER_NAME.test(value.header) || ["host", "content-length", "transfer-encoding", "connection", "upgrade", "trailer"].includes(value.header.toLowerCase()) || !/^[A-Z_][A-Z0-9_]*$/.test(value.env)) throw inputError();
}
async function preparePersonalHttp(input) {
  if (!HEADER_NAME.test(input.method) || !validText(input.url, 8192) || input.body !== void 0 && Buffer.byteLength(input.body) > PERSONAL_TOOL_CAPTURE_BYTES) throw inputError();
  let url;
  try {
    url = new URL(input.url);
  } catch {
    throw inputError();
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw inputError();
  const headers = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (!REQUEST_HEADERS.has(name.toLowerCase()) || !validText(value, 8192)) throw inputError();
    if (Object.hasOwn(headers, name.toLowerCase())) throw inputError();
    headers[name.toLowerCase()] = value;
  }
  let credentialSha256;
  if (input.credential) {
    validateCredential(input.credential, url);
    const secret = process.env[input.credential.env];
    if (!secret || !validText(secret, 16384)) throw new PersonalError("http_credentials_unavailable", "\u539F HTTP \u51ED\u636E\u4E0D\u53EF\u7528\uFF0C\u672A\u53D1\u9001\u8BF7\u6C42\uFF1B\u8BF7\u7531\u62E5\u6709\u8005\u68C0\u67E5\u539F\u914D\u7F6E\u3002");
    credentialSha256 = sha256Hex(secret);
  }
  let pinned;
  try {
    pinned = await dns.promises.lookup(url.hostname.replace(/^\[|\]$/g, ""));
  } catch {
    throw new PersonalError("http_target_unavailable", "\u76EE\u6807\u5730\u5740\u65E0\u6CD5\u6838\u5B9E\uFF0C\u672A\u53D1\u9001\u8BF7\u6C42\uFF1B\u8BF7\u68C0\u67E5\u76EE\u6807\u540E\u91CD\u65B0\u7533\u8BF7\u3002");
  }
  return { method: input.method.toUpperCase(), url: url.href, headers, pinnedAddress: pinned.address, pinnedFamily: pinned.family, ...input.body !== void 0 ? { body: input.body } : {}, ...input.credential ? { credential: { ...input.credential }, credentialSha256 } : {} };
}
async function executePersonalHttp(input, signal) {
  const empty = (code) => ({ effect: "not_executed", code, bytes: Buffer.alloc(0), partial: false, headers: {}, stopped: true });
  if (signal?.aborted) return empty("http_canceled");
  const headers = { ...input.headers };
  if (input.body !== void 0) headers["content-length"] = String(Buffer.byteLength(input.body));
  let secret;
  let secretForms = [];
  let url;
  try {
    url = new URL(input.url);
  } catch {
    return empty("http_target_invalid");
  }
  if (input.credential) {
    try {
      validateCredential(input.credential, url);
    } catch {
      return empty("http_credentials_invalid");
    }
    secret = process.env[input.credential.env];
    if (!secret || !validText(secret, 16384)) return empty("http_credentials_unavailable");
    if (sha256Hex(secret) !== input.credentialSha256) return empty("credentials_changed");
    secretForms = [.../* @__PURE__ */ new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)])];
    headers[input.credential.header.toLowerCase()] = secret;
  }
  return new Promise((resolve2) => {
    let request;
    let socket, closed = false, result;
    let timer;
    const chunks = [];
    let count = 0;
    const responseHeaders = {};
    let status;
    const readonly = ["GET", "HEAD"].includes(input.method) && input.body === void 0;
    const finish = (complete, code) => {
      if (!result) {
        const bytes = Buffer.concat(chunks, count), unsafe = secretForms.some((value) => {
          const needle = Buffer.from(value);
          if (bytes.includes(needle)) return true;
          if (!complete) {
            for (let length = 1; length < needle.length && length <= bytes.length; length++) if (bytes.subarray(bytes.length - length).equals(needle.subarray(0, length))) return true;
          }
          return false;
        });
        result = { effect: complete ? "returned" : readonly ? "no_write" : "effect_unknown", code: unsafe ? "credential_response_unsafe" : code, bytes: unsafe ? Buffer.alloc(0) : bytes, partial: unsafe || !complete, headers: responseHeaders, stopped: true, ...status !== void 0 ? { status } : {} };
      }
      if (closed) {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve2(result);
      }
    };
    const abort = () => {
      finish(false, "http_canceled");
      request.destroy();
    };
    try {
      const options = {
        method: input.method,
        headers,
        agent: false,
        autoSelectFamily: false,
        lookup: (_hostname, _options, callback) => callback(null, input.pinnedAddress, input.pinnedFamily)
      };
      request = (url.protocol === "https:" ? https : http).request(url, options, (response) => {
        status = response.statusCode;
        for (const [name, value] of Object.entries(response.headers)) if (RESPONSE_HEADERS.has(name) && value !== void 0) {
          const text = Array.isArray(value) ? value.join(", ") : value;
          if (!secretForms.some((value2) => text.includes(value2))) responseHeaders[name] = text;
        }
        response.on("data", (chunk) => {
          const available = PERSONAL_TOOL_CAPTURE_BYTES - count;
          if (available > 0) {
            const captured = chunk.subarray(0, available);
            chunks.push(captured);
            count += captured.length;
          }
          if (chunk.length > available) {
            finish(false, "http_response_limit");
            request.destroy();
          }
        });
        response.once("end", () => {
          finish(response.complete, response.complete ? "http_returned" : "http_response_interrupted");
          socket?.destroy();
        });
        response.once("error", () => finish(false, "http_response_interrupted"));
        response.once("aborted", () => finish(false, "http_response_interrupted"));
      });
    } catch {
      resolve2(empty("http_request_invalid"));
      return;
    }
    request.once("socket", (value) => {
      socket = value;
      socket.once("close", () => {
        closed = true;
        finish(false, "http_connection_closed");
      });
    });
    request.once("close", () => {
      if (!socket) {
        closed = true;
        finish(false, "http_connection_closed");
      }
    });
    request.once("error", () => finish(false, "http_transport_failed"));
    timer = setTimeout(() => {
      finish(false, "http_timeout");
      request.destroy();
    }, PERSONAL_HTTP_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    else request.end(input.body);
  });
}

// ../../../Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/test/personal-tool-io.test.ts
function files(t) {
  const directory = fs3.realpathSync(fs3.mkdtempSync(path3.join(tmpdir(), "rk-tool-io-")));
  t.after(() => fs3.rmSync(directory, { recursive: true, force: true }));
  const target = path3.join(directory, "target"), protectedRoot = path3.join(directory, "private");
  fs3.mkdirSync(protectedRoot);
  return { directory, target, protectedRoots: [protectedRoot] };
}
async function server(t, listener) {
  const value = http2.createServer(listener);
  value.listen(0, "127.0.0.1");
  await once(value, "listening");
  const address = value.address();
  assert.ok(address && typeof address === "object");
  t.after(async () => {
    value.closeAllConnections();
    await new Promise((resolve2) => value.close(() => resolve2()));
  });
  return `http://127.0.0.1:${address.port}`;
}
test("\u4E2A\u4EBA\u6587\u4EF6\uFF1A\u539F\u5B57\u8282\u6709\u754C\u6355\u83B7\uFF0C\u51C6\u5907\u8BB0\u5F55\u4E3A\u4E0D\u542B undefined \u7684 JSON", (t) => {
  const f = files(t), bytes = Buffer.alloc(PERSONAL_TOOL_CAPTURE_BYTES + 7, 255);
  bytes.set([0, 1, 195, 40]);
  fs3.writeFileSync(f.target, bytes);
  const prepared = preparePersonalFile({ path: f.target, access: "read", protectedRoots: f.protectedRoots });
  assert.deepEqual(JSON.parse(JSON.stringify(prepared)), prepared);
  const result = executePersonalFile(prepared);
  assert.equal(result.effect, "returned");
  assert.equal(result.partial, true);
  assert.deepEqual(result.bytes, bytes.subarray(0, PERSONAL_TOOL_CAPTURE_BYTES));
});
for (const mutation of ["replace", "content"]) test(`\u4E2A\u4EBA\u6587\u4EF6\uFF1A\u7B49\u5F85\u540E${mutation}\u62D2\u7EDD\u539F\u8BFB\u53D6\u4E0E\u5199\u5165`, (t) => {
  const f = files(t);
  fs3.writeFileSync(f.target, "before");
  const read = preparePersonalFile({ path: f.target, access: "read", protectedRoots: f.protectedRoots });
  const write = preparePersonalFile({ path: f.target, access: "read_write", content: "after", protectedRoots: f.protectedRoots });
  if (mutation === "replace") {
    fs3.renameSync(f.target, f.target + ".old");
    fs3.writeFileSync(f.target, "replacement");
  } else fs3.writeFileSync(f.target, "changed");
  assert.equal(executePersonalFile(read).effect, "not_executed");
  assert.equal(executePersonalFile(write).effect, "not_executed");
  assert.notEqual(fs3.readFileSync(f.target, "utf8"), "after");
});
test("\u4E2A\u4EBA\u6587\u4EF6\uFF1A\u4FDD\u62A4\u8D44\u6599\u548C\u7B26\u53F7\u94FE\u63A5\u63D0\u524D\u62D2\u7EDD\uFF0C\u5B8C\u5168\u8BBF\u95EE\u9489\u5B9A\u771F\u5B9E\u5BF9\u8C61\uFF0C\u65B0\u6587\u4EF6\u7236\u76EE\u5F55\u53D8\u5316\u62D2\u7EDD", (t) => {
  const f = files(t);
  fs3.writeFileSync(f.target, "text");
  const secret = path3.join(f.protectedRoots[0], "credential");
  fs3.writeFileSync(secret, "secret");
  assert.throws(() => preparePersonalFile({ path: secret, access: "read", protectedRoots: f.protectedRoots }), PersonalError);
  const link = path3.join(f.directory, "link");
  fs3.symlinkSync(f.target, link);
  assert.throws(() => preparePersonalFile({ path: link, access: "read", protectedRoots: f.protectedRoots }), PersonalError);
  assert.equal(executePersonalFile(preparePersonalFile({ path: link, access: "read", protectedRoots: [] })).bytes.toString(), "text");
  const parent = path3.join(f.directory, "parent");
  fs3.mkdirSync(parent);
  const write = preparePersonalFile({ path: path3.join(parent, "new"), access: "read_write", content: "new", protectedRoots: f.protectedRoots });
  fs3.renameSync(parent, parent + ".old");
  fs3.mkdirSync(parent);
  assert.equal(executePersonalFile(write).effect, "not_executed");
  assert.equal(fs3.existsSync(path3.join(parent, "new")), false);
});
test("\u4E2A\u4EBA\u6587\u4EF6\uFF1A\u5199\u5165\u6210\u529F\u4FDD\u6301\u5B57\u8282\uFF0Cfsync \u5931\u8D25\u4FDD\u7559\u771F\u5B9E\u5199\u5165\u5E76\u62A5\u544A\u672A\u77E5", (t) => {
  const f = files(t);
  fs3.writeFileSync(f.target, "original");
  const write = preparePersonalFile({ path: f.target, access: "read_write", content: "first", protectedRoots: f.protectedRoots });
  assert.equal(executePersonalFile(write).effect, "returned");
  const second = preparePersonalFile({ path: f.target, access: "read_write", content: "second", protectedRoots: f.protectedRoots });
  const nodeFs = awaitImportFs();
  const mocked = t.mock.method(nodeFs, "fsyncSync", () => {
    throw new Error("unsafe-native-detail");
  });
  syncBuiltinESMExports();
  let result;
  try {
    result = executePersonalFile(second);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(result.effect, "effect_unknown");
  assert.equal(fs3.readFileSync(f.target, "utf8"), "second");
  assert.equal(JSON.stringify(result).includes("unsafe-native-detail"), false);
});
test("\u4E2A\u4EBA\u6587\u4EF6\uFF1A\u65B0\u5EFA\u76F8\u5BF9\u5DF2\u6838\u5B9E\u76EE\u5F55\u53E5\u67C4\uFF0C\u7956\u5148\u66FF\u6362\u4E0D\u80FD\u5728\u4FDD\u62A4\u76EE\u5F55\u521B\u5EFA", (t) => {
  const f = files(t), parent = path3.join(f.directory, "parent"), retained = parent + ".old";
  fs3.mkdirSync(parent);
  const target = path3.join(parent, "new"), prepared = preparePersonalFile({ path: target, access: "read_write", content: "created", protectedRoots: f.protectedRoots });
  if (process.platform !== "linux") {
    const unsupported = executePersonalFile(prepared);
    assert.equal(unsupported.effect, "not_executed");
    assert.equal(unsupported.code, "file_creation_unavailable");
    assert.equal(fs3.existsSync(target), false);
    return;
  }
  const nodeFs = awaitImportFs(), open = nodeFs.openSync;
  let swapped = false;
  const mocked = t.mock.method(nodeFs, "openSync", (...args) => {
    if (!swapped && String(args[0]).startsWith("/proc/self/fd/") && String(args[0]).endsWith("/new")) {
      swapped = true;
      fs3.renameSync(parent, retained);
      fs3.symlinkSync(f.protectedRoots[0], parent);
    }
    return open(...args);
  });
  syncBuiltinESMExports();
  let result;
  try {
    result = executePersonalFile(prepared);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(swapped, true);
  assert.equal(result.effect, "returned");
  assert.equal(fs3.readFileSync(path3.join(retained, "new"), "utf8"), "created");
  assert.equal(fs3.existsSync(path3.join(f.protectedRoots[0], "new")), false);
});
test("\u53D7\u4FE1\u6587\u4EF6\u5199\u5165\uFF1A\u65B0\u5EFA\u4E0E\u6539\u5199\u5B8C\u6210\u6240\u6709\u77ED\u5199\uFF0C\u96F6\u5B57\u8282\u5199\u5165\u4FDD\u7559\u672A\u77E5", (t) => {
  const f = files(t), nodeFs = awaitImportFs(), original = nodeFs.writeSync;
  const requests = ["existing", "new"].map((name) => {
    const target = path3.join(f.directory, name);
    if (name === "existing") fs3.writeFileSync(target, "old");
    return preparePersonalFile({ path: target, access: "read_write", content: "complete-new-data", protectedRoots: f.protectedRoots });
  });
  let zero = false;
  const mocked = t.mock.method(nodeFs, "writeSync", (fd, bytes, offset, length, position) => zero ? 0 : original(fd, bytes, offset, Math.min(2, length), position));
  syncBuiltinESMExports();
  try {
    for (const request2 of requests) {
      assert.equal(executeApprovedFileOp(request2).ok, true);
      assert.equal(fs3.readFileSync(request2.path, "utf8"), "complete-new-data");
    }
    const request = preparePersonalFile({ path: requests[0].path, access: "read_write", content: "replacement", protectedRoots: f.protectedRoots });
    zero = true;
    const outcome = executeApprovedFileOp(request);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.effectUnknown, true);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});
var require2 = createRequire("file:///tmp/ruukoto-tools-29.6uZBBr/source/test/personal-tool-io.test.ts");
function awaitImportFs() {
  return require2("node:fs");
}
test("\u4E2A\u4EBA HTTP\uFF1A\u6355\u83B7\u4E8C\u8FDB\u5236\u3001\u8FC7\u6EE4\u654F\u611F\u54CD\u5E94\u5934\u4E14\u53EA\u53D1\u4E00\u6B21\u4E0D\u8DDF\u968F\u91CD\u5B9A\u5411", async (t) => {
  let calls = 0;
  const expected = Buffer.from([0, 255, 195, 40]);
  const target = await server(t, (_req, res) => {
    calls++;
    res.writeHead(302, { location: "/next", "set-cookie": "private", authorization: "private", "content-type": "application/octet-stream" });
    res.end(expected);
  });
  const prepared = await preparePersonalHttp({ method: "get", url: target });
  assert.equal(prepared.pinnedAddress, "127.0.0.1");
  const result = await executePersonalHttp(prepared);
  assert.equal(result.effect, "returned");
  assert.equal(result.stopped, true);
  assert.equal(result.partial, false);
  assert.equal(result.status, 302);
  assert.equal(calls, 1);
  assert.deepEqual(result.bytes, expected);
  assert.equal(result.headers.location, "/next");
  assert.equal(result.headers["set-cookie"], void 0);
  assert.equal(result.headers.authorization, void 0);
});
test("\u4E2A\u4EBA HTTP\uFF1A\u8D85\u9650\u4FDD\u7559\u6709\u754C\u539F\u5B57\u8282\u5E76\u5173\u95ED\u539F\u8FDE\u63A5", async (t) => {
  const target = await server(t, (_req, res) => {
    res.end(Buffer.alloc(PERSONAL_TOOL_CAPTURE_BYTES + 7, 255));
  });
  const result = await executePersonalHttp(await preparePersonalHttp({ method: "GET", url: target }));
  assert.equal(result.effect, "no_write");
  assert.equal(result.code, "http_response_limit");
  assert.equal(result.partial, true);
  assert.equal(result.stopped, true);
  assert.equal(result.bytes.length, PERSONAL_TOOL_CAPTURE_BYTES);
  assert.ok(result.bytes.every((byte) => byte === 255));
});
test("\u4E2A\u4EBA HTTP\uFF1A\u8FDE\u63A5\u4F7F\u7528\u5BA1\u6279\u524D\u56FA\u5B9A\u5730\u5740\uFF0C\u4E0D\u91CD\u65B0\u89E3\u6790\u76EE\u6807\u57DF\u540D", async (t) => {
  const target = await server(t, (_req, res) => res.end("pinned"));
  const resolver = t.mock.method(dns2.promises, "lookup", async () => ({ address: "127.0.0.1", family: 4 }));
  const prepared = await preparePersonalHttp({ method: "GET", url: target.replace("127.0.0.1", "approval-target.invalid") });
  resolver.mock.mockImplementation(async () => {
    throw new Error("must-not-resolve-again");
  });
  const result = await executePersonalHttp(prepared);
  assert.equal(result.effect, "returned");
  assert.equal(result.bytes.toString(), "pinned");
  assert.equal(resolver.mock.callCount(), 1);
});
test("\u4E2A\u4EBA HTTP\uFF1A\u4E2D\u65AD\u4FDD\u7559\u7247\u6BB5\uFF0CGET \u65E0\u5199\u5165\u6548\u679C\uFF0CPOST \u4E0E\u5E26\u6B63\u6587 GET \u4FDD\u6301\u672A\u77E5", async (t) => {
  let calls = 0;
  const target = await server(t, (_req, res) => {
    calls++;
    res.writeHead(200, { "content-length": "20" });
    res.write(Buffer.from([0, 255, 1]), () => {
      setTimeout(() => res.destroy(), 10);
    });
  });
  for (const [method, body, effect] of [["GET", void 0, "no_write"], ["POST", "content", "effect_unknown"], ["GET", "content", "effect_unknown"]]) {
    const result = await executePersonalHttp(await preparePersonalHttp({ method, url: target, ...body !== void 0 ? { body } : {} }));
    assert.equal(result.effect, effect, method);
    assert.equal(result.partial, true);
    assert.equal(result.stopped, true);
    assert.deepEqual(result.bytes, Buffer.from([0, 255, 1]), method);
  }
  assert.equal(calls, 3);
});
test("\u4E2A\u4EBA HTTP\uFF1A\u53D6\u6D88\u7B49\u5F85 socket \u5173\u95ED\uFF0C\u4E0D\u91CD\u590D\u5199\uFF1B\u5F00\u59CB\u524D\u53D6\u6D88\u4E0D\u53D1\u9001", async (t) => {
  let calls = 0;
  let received;
  const pending = new Promise((resolve2) => {
    received = resolve2;
  });
  const target = await server(t, (_req, res) => {
    calls++;
    res.write("part");
    received();
  });
  const controller = new AbortController();
  const prepared = await preparePersonalHttp({ method: "POST", url: target, body: "content" });
  const active = executePersonalHttp(prepared, controller.signal);
  await pending;
  controller.abort();
  const result = await active;
  assert.equal(result.effect, "effect_unknown");
  assert.equal(result.stopped, true);
  assert.equal(result.code, "http_canceled");
  assert.equal((await executePersonalHttp(prepared, controller.signal)).effect, "not_executed");
  assert.equal(calls, 1);
});
test("\u4E2A\u4EBA HTTP\uFF1A\u62D2\u7EDD URL \u51ED\u636E\u548C\u79C1\u5E26\u79D8\u5BC6\u5934\uFF0C\u56FA\u5B9A\u51ED\u636E\u4EC5\u6267\u884C\u65F6\u6CE8\u5165\uFF0C\u79D8\u5BC6\u56DE\u663E\u4E0D\u51FA\u7ED3\u679C", async (t) => {
  const secret = 'unique/+host?"secret-123';
  process.env.PERSONAL_TOOL_TEST_TOKEN = secret;
  t.after(() => {
    delete process.env.PERSONAL_TOOL_TEST_TOKEN;
  });
  const received = [];
  const forms = [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)];
  const target = await server(t, (req, res) => {
    received.push(req.headers.authorization ?? "");
    res.writeHead(200, { location: `/next?token=${forms[(received.length - 1) % forms.length]}` });
    res.end(received.length === 1 ? "safe" : forms[received.length - 2]);
  });
  const forbiddenHeaders = [{ authorization: secret }, { cookie: secret }, { "x-api-key": secret }, { host: "other" }];
  for (const headers of forbiddenHeaders) await assert.rejects(preparePersonalHttp({ method: "GET", url: target, headers }), PersonalError);
  await assert.rejects(preparePersonalHttp({ method: "GET", url: target.replace("http://", "http://name:password@") }), PersonalError);
  const credential = { name: "test", host: new URL(target).host, header: "authorization", env: "PERSONAL_TOOL_TEST_TOKEN" };
  const prepared = await preparePersonalHttp({ method: "GET", url: target, credential });
  assert.equal(JSON.stringify(prepared).includes(secret), false);
  const safe = await executePersonalHttp(prepared);
  assert.equal(safe.bytes.toString(), "safe");
  assert.equal(JSON.stringify(safe).includes(secret), false);
  assert.equal(safe.headers.location, void 0);
  for (const _form of forms) {
    const echoed = await executePersonalHttp(prepared);
    assert.equal(echoed.code, "credential_response_unsafe");
    assert.equal(echoed.effect, "returned");
    assert.equal(echoed.partial, true);
    assert.equal(echoed.bytes.length, 0);
    assert.equal(echoed.headers.location, void 0);
    assert.equal(JSON.stringify(echoed).includes(secret), false);
  }
  assert.deepEqual(received, [secret, secret, secret, secret]);
  process.env.PERSONAL_TOOL_TEST_TOKEN = "rotated-host-secret";
  const changed = await executePersonalHttp(prepared);
  assert.equal(changed.effect, "not_executed");
  assert.equal(changed.code, "credentials_changed");
  assert.equal(received.length, 4);
  delete process.env.PERSONAL_TOOL_TEST_TOKEN;
  assert.equal((await executePersonalHttp(prepared)).effect, "not_executed");
  assert.equal(received.length, 4);
});
test("\u4E2A\u4EBA HTTP\uFF1A\u622A\u65AD\u548C\u4E2D\u65AD\u843D\u5728\u79D8\u5BC6\u4E2D\u95F4\u65F6\u4E0D\u4FDD\u7559\u79D8\u5BC6\u524D\u7F00", async (t) => {
  const secret = "private-response-token";
  process.env.PERSONAL_TOOL_TEST_TOKEN = secret;
  t.after(() => {
    delete process.env.PERSONAL_TOOL_TEST_TOKEN;
  });
  const target = await server(t, (req, res) => {
    if (req.url === "/cap") res.end(Buffer.concat([Buffer.alloc(PERSONAL_TOOL_CAPTURE_BYTES - 5, 120), Buffer.from(secret)]));
    else {
      res.writeHead(200, { "content-length": "100" });
      res.write(secret.slice(0, 5), () => {
        setTimeout(() => res.destroy(), 10);
      });
    }
  });
  const credential = { name: "test", host: new URL(target).host, header: "authorization", env: "PERSONAL_TOOL_TEST_TOKEN" };
  for (const pathname of ["/cap", "/partial"]) {
    const result = await executePersonalHttp(await preparePersonalHttp({ method: "GET", url: target + pathname, credential }));
    assert.equal(result.code, "credential_response_unsafe");
    assert.equal(result.bytes.length, 0);
    assert.equal(result.partial, true);
    assert.equal(result.stopped, true);
  }
});
test("\u53D7\u4FE1\u6587\u4EF6\u5199\u5165\uFF1A\u622A\u77ED\u5DF2\u5F00\u59CB\u540E\u5F02\u5E38\u4E0D\u80FD\u62A5\u544A\u672A\u6267\u884C", (t) => {
  const { directory } = files(t), target = path3.join(directory, "truncate");
  fs3.writeFileSync(target, "\u539F\u6587");
  const prepared = preparePersonalFile({ path: target, access: "read_write", content: "\u65B0\u6587", protectedRoots: [] });
  const nodeFs = createRequire("file:///tmp/ruukoto-tools-29.6uZBBr/source/test/personal-tool-io.test.ts")("node:fs"), original = fs3.ftruncateSync;
  const mock = t.mock.method(nodeFs, "ftruncateSync", (fd, length) => {
    original(fd, length);
    throw new Error("\u622A\u77ED\u540E\u78C1\u76D8\u9519\u8BEF");
  });
  syncBuiltinESMExports();
  try {
    assert.equal(executeApprovedFileOp(prepared).effectUnknown, true);
    assert.equal(fs3.readFileSync(target, "utf8"), "");
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});
