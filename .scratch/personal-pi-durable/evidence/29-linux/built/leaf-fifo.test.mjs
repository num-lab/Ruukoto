// test/personal-tool-fifo.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs3 from "node:fs";
import nodeFs from "node:fs";
import * as os from "node:os";
import * as path3 from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

// apps/ruukoto/src/personal-tool-io.ts
import * as fs2 from "node:fs";
import * as path2 from "node:path";
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

// apps/ruukoto/src/personal-error.ts
var PersonalError = class extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
    this.name = "PersonalError";
  }
  code;
};

// apps/ruukoto/src/personal-tool-io.ts
var PERSONAL_TOOL_CAPTURE_BYTES = 8 * 1024 * 1024;
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

// test/personal-tool-fifo.test.ts
var operations = ["prepare", "read", "approved-read"];
var operation = process.argv[2];
if (operations.some((value) => value === operation)) {
  const filename = process.argv[3], prepared = operation === "prepare" ? void 0 : preparePersonalFile({ path: filename, access: "read", protectedRoots: [] });
  const open = nodeFs.openSync;
  let swapped = false;
  nodeFs.openSync = (target, ...args) => {
    if (!swapped && target === filename) {
      swapped = true;
      fs3.renameSync(filename, filename + ".original");
      execFileSync("mkfifo", [filename]);
    }
    return open(target, ...args);
  };
  syncBuiltinESMExports();
  if (operation === "prepare") assert.throws(() => preparePersonalFile({ path: filename, access: "read", protectedRoots: [] }), PersonalError);
  else if (operation === "read") assert.equal(executePersonalFile(prepared).effect, "not_executed");
  else assert.equal(executeApprovedFileOp(prepared).ok, false);
  assert.equal(swapped, true);
} else {
  for (const operation2 of operations) test(`\u6587\u4EF6\u7ADE\u6001\uFF1A${operation2} \u6253\u5F00\u524D\u6362\u6210\u771F\u5B9E FIFO\uFF0C\u7ACB\u5373\u62D2\u7EDD\u800C\u4E0D\u963B\u585E\u5BBF\u4E3B`, () => {
    const root = fs3.realpathSync(fs3.mkdtempSync(path3.join(os.tmpdir(), "rk29-fifo-"))), filename = path3.join(root, "target"), self = fileURLToPath(import.meta.url);
    fs3.writeFileSync(filename, "original");
    try {
      const child = spawnSync(process.execPath, [...self.endsWith(".ts") ? ["--import", "tsx"] : [], self, operation2, filename], { encoding: "utf8", timeout: 5e3 });
      assert.equal(child.error, void 0, `${child.error?.message}
${child.stderr}`);
      assert.equal(child.status, 0, child.stderr);
      assert.equal(fs3.readFileSync(filename + ".original", "utf8"), "original");
    } finally {
      fs3.rmSync(root, { recursive: true, force: true });
    }
  });
}
