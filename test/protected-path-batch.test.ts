import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { test, type TestContext } from "node:test";
import { ApprovedOpError, assertGrantNotProtected, assertGrantsNotProtected } from "@ruukoto/agent/execution/approved-ops.ts";

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "protected-batch-")));
  const protectedRoot = path.join(root, "private"), nested = path.join(protectedRoot, "nested"), safe = path.join(root, "safe");
  fs.mkdirSync(nested, { recursive: true }); fs.mkdirSync(safe);
  const source = path.join(nested, "source"); fs.writeFileSync(source, "private");
  const targets = ["one", "two", "three"].map(name => path.join(safe, name));
  for (const target of targets) fs.writeFileSync(target, "safe");
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, protectedRoot, nested, source, safe, targets };
}

test("批量保护核对每个保护目录只遍历一次，单目标拒绝消息保持", t => {
  const f = fixture(t), readdir = t.mock.method(fs, "readdirSync");
  syncBuiltinESMExports();
  assertGrantsNotProtected(f.targets, [f.protectedRoot]);
  assert.equal(readdir.mock.calls.filter(call => call.arguments[0] === f.protectedRoot).length, 1);
  assert.equal(readdir.mock.calls.filter(call => call.arguments[0] === f.nested).length, 1);
  assert.throws(() => assertGrantNotProtected(f.source, [f.protectedRoot]), { message: `路径位于控制面/服务数据目录内，始终排除：${f.source}` });
  assert.throws(() => assertGrantNotProtected(f.root, [f.protectedRoot]), { message: `路径是控制面/服务数据目录的父级，始终排除：${f.root}` });
});

test("批量核对拒绝后面的子文件硬链接、根与祖先；后续调用不沿用旧放行", t => {
  const f = fixture(t);
  assertGrantsNotProtected(f.targets, [f.protectedRoot]);
  fs.unlinkSync(f.targets[2]); fs.linkSync(f.source, f.targets[2]);
  assert.throws(() => assertGrantsNotProtected(f.targets, [f.protectedRoot]), ApprovedOpError);
  assert.throws(() => assertGrantsNotProtected([f.targets[0], f.protectedRoot], [f.protectedRoot]), ApprovedOpError);
  assert.throws(() => assertGrantsNotProtected([f.targets[0], f.root], [f.protectedRoot]), ApprovedOpError);
});

test("批量核对按子对象身份拒绝 nlink 为一的 bind 别名，不跟随保护树符号链接", t => {
  const f = fixture(t), original = fs.statSync;
  fs.symlinkSync(f.safe, path.join(f.protectedRoot, "outside"));
  assertGrantsNotProtected(f.targets, [f.protectedRoot]);
  // 只替换宿主 stat 的对象身份，真实 Linux file bind 另由 OS 探针证明。
  t.mock.method(fs, "statSync", (target: fs.PathLike, options?: Parameters<typeof fs.statSync>[1]) => original(target === f.targets[2] ? f.source : target, options));
  syncBuiltinESMExports();
  assert.throws(() => assertGrantsNotProtected(f.targets, [f.protectedRoot]), ApprovedOpError);
});

for (const damage of ["target", "protected_root", "directory_entries"] as const) test(`批量核对在扫描中遇到 ${damage} 变化时拒绝`, t => {
  const f = fixture(t), original = fs.readdirSync;
  let changed = false;
  t.mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
    const names = original(...args);
    if (args[0] === f.protectedRoot && !changed) {
      changed = true;
      if (damage === "target") {
        fs.renameSync(f.targets[0], f.targets[0] + "-old"); fs.writeFileSync(f.targets[0], "replacement");
      } else if (damage === "protected_root") {
        fs.renameSync(f.protectedRoot, f.protectedRoot + "-old"); fs.mkdirSync(f.nested, { recursive: true }); fs.writeFileSync(f.source, "replacement");
      } else {
        const revision = fs.statSync(f.protectedRoot);
        fs.writeFileSync(path.join(f.protectedRoot, "late"), "new entry");
        // Linux 可将同一时间片的目录变化记成相同时间，显式推进修订以测试已观察变化。
        fs.utimesSync(f.protectedRoot, revision.atime, new Date(revision.mtimeMs + 1000));
      }
    }
    return names;
  });
  syncBuiltinESMExports();
  assert.throws(() => assertGrantsNotProtected(f.targets, [f.protectedRoot]), ApprovedOpError);
  assert.equal(changed, true);
});

test("批量保护树读取失败向调用方传播，不当成没有保护对象", t => {
  const f = fixture(t), original = fs.readdirSync, failure = new Error("read-failed");
  t.mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
    if (args[0] === f.nested) throw failure;
    return original(...args);
  });
  syncBuiltinESMExports();
  assert.throws(() => assertGrantsNotProtected(f.targets, [f.protectedRoot]), error => error === failure);
});

test("批量保护根 stat 失败不被 existsSync 的 false 隐去；确定缺失的根仍按文本保护", t => {
  const f = fixture(t), originalStat = fs.statSync, originalExists = fs.existsSync;
  const missing = path.join(f.root, "missing"), failure = Object.assign(new Error("read-denied"), { code: "EACCES" });
  assert.doesNotThrow(() => assertGrantsNotProtected(f.targets, [missing]));
  t.mock.method(fs, "existsSync", (target: fs.PathLike) => target === f.protectedRoot ? false : originalExists(target));
  t.mock.method(fs, "statSync", (target: fs.PathLike, options?: Parameters<typeof fs.statSync>[1]) => {
    if (target === f.protectedRoot) throw failure;
    return originalStat(target, options);
  });
  syncBuiltinESMExports();
  assert.throws(() => assertGrantsNotProtected(f.targets, [f.protectedRoot]), error => error === failure);
});
