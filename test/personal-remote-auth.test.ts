import assert from "node:assert/strict";
import fs from "node:fs";
import * as path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { test, type TestContext } from "node:test";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { openPersonalRemoteAuth, personalRemoteDirectory, type PersonalRemoteAuth, type PersonalRemoteBinding } from "../apps/ruukoto/src/personal-remote-auth.ts";
import { readPersonalRemoteFile, writePersonalRemoteFile } from "../apps/ruukoto/src/personal-remote-storage.ts";

const binding: PersonalRemoteBinding = { origin: "https://pa.example.ts.net", owner: "owner@example.invalid", profile: { id: `sha256:${"a".repeat(64)}`, directory: "/var/lib/ruukoto/personal-durable" } };
const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;
const candidate = () => { const id = randomUUID(), secret = randomBytes(32).toString("base64url"); return { id, secret, authorization: `Bearer ${id}.${secret}` }; };

function fixture(t: TestContext) {
  const home = fs.realpathSync(fs.mkdtempSync("/tmp/rk-ra-")), opened: PersonalRemoteAuth[] = [];
  fs.chmodSync(home, 0o700);
  const open = (initialize = false, current = binding) => { const auth = openPersonalRemoteAuth(current, { initialize, home: () => home }); opened.push(auth); return auth; };
  t.after(() => { for (const auth of opened) auth.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const directory = personalRemoteDirectory(() => home);
  return { home, directory, filename: path.join(directory, "auth.json"), open };
}

function paired(auth: PersonalRemoteAuth, label = "Electron") {
  const original = candidate(), window = auth.openPairing(), request = { v: 1 as const, code: window.code, label };
  return { ...original, request, receipt: auth.pair(binding.owner, original.authorization, request) };
}

test("远程认证：显式初始化、私有权限、同根独占与持久实例身份", t => {
  const f = fixture(t);
  assert.throws(() => f.open(), code("remote_auth_state_missing"));
  assert.equal(fs.existsSync(f.filename), false);
  const auth = f.open(true), original = auth.identity();
  assert.equal(original.confirmed, true); assert.deepEqual(original.binding, binding);
  assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
  for (const name of ["auth.json", "owner.sqlite"]) assert.equal(fs.statSync(path.join(f.directory, name)).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(f.directory, "http.sock"), "保留原入口", { mode: 0o600 });
  assert.throws(() => f.open(true), code("remote_busy"));
  assert.equal(fs.readFileSync(path.join(f.directory, "http.sock"), "utf8"), "保留原入口");
  auth.close();
  assert.deepEqual(f.open().identity(), original);
});

test("远程认证：坏状态、未知版本、错误权限及符号链接均不重建", t => {
  const f = fixture(t), auth = f.open(true), original = fs.readFileSync(f.filename, "utf8");
  auth.close();
  for (const raw of ["{", JSON.stringify({ ...JSON.parse(original), v: 99 }), JSON.stringify({ ...JSON.parse(original), remoteId: "" })]) {
    fs.writeFileSync(f.filename, raw);
    assert.throws(() => f.open(true), code("remote_auth_state_invalid"));
    assert.equal(fs.readFileSync(f.filename, "utf8"), raw);
  }
  fs.writeFileSync(f.filename, original); fs.chmodSync(f.filename, 0o644);
  assert.throws(() => f.open(true), code("remote_auth_state_invalid"));
  fs.chmodSync(f.filename, 0o600);
  fs.renameSync(f.filename, path.join(f.home, "original.json")); fs.symlinkSync(path.join(f.home, "original.json"), f.filename);
  assert.throws(() => f.open(true), code("remote_auth_state_invalid"));
  assert.equal(fs.readFileSync(path.join(f.home, "original.json"), "utf8"), original);
});

test("远程认证：私有根与上级配置目录不跟随链接或修正宽权限", t => {
  for (const target of [".config", ".config/ruukoto-remote"]) {
    const f = fixture(t), elsewhere = path.join(f.home, "elsewhere");
    fs.mkdirSync(elsewhere, { mode: 0o700 });
    if (target.includes("/")) fs.mkdirSync(path.join(f.home, ".config"), { mode: 0o700 });
    fs.symlinkSync(elsewhere, path.join(f.home, target));
    assert.throws(() => f.open(true), code("remote_auth_state_invalid"));
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  }
  const f = fixture(t); fs.mkdirSync(f.directory, { mode: 0o700, recursive: true }); fs.chmodSync(f.directory, 0o755);
  assert.throws(() => f.open(true), code("remote_auth_state_invalid"));
  assert.equal(fs.statSync(f.directory).mode & 0o777, 0o755);
});

test("配对：原子消费、同ID同参回执、丢答恢复与摘要不含秘密", async t => {
  const f = fixture(t), auth = f.open(true), window = auth.openPairing(), a = candidate(), b = candidate();
  assert.match(window.code, /^[A-Z2-7]{12}$/); assert.ok(window.expiresAt > Date.now());
  const request = { v: 1 as const, code: window.code, label: "Electron" };
  const results = await Promise.allSettled([Promise.resolve().then(() => auth.pair(binding.owner, a.authorization, request)), Promise.resolve().then(() => auth.pair(binding.owner, b.authorization, { ...request, label: "MyGo" }))]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(auth.list().length, 1);
  const receipt = auth.authenticate(binding.owner, a.authorization);
  assert.deepEqual(auth.pair(binding.owner, a.authorization, { label: request.label, code: request.code, v: 1 }), receipt);
  assert.throws(() => auth.pair(binding.owner, a.authorization, { ...request, label: "另一安装" }), code("remote_pairing_conflict"));
  assert.throws(() => auth.pair(binding.owner, `Bearer ${a.id}.${b.secret}`, request), code("remote_credential_invalid"));
  const raw = fs.readFileSync(f.filename, "utf8");
  assert.ok(!raw.includes(a.secret)); assert.ok(!raw.includes(window.code)); assert.ok(!raw.includes(b.secret));
  auth.close();
  const restarted = f.open();
  assert.deepEqual(restarted.authenticate(binding.owner, a.authorization), receipt);
  assert.deepEqual(restarted.pair(binding.owner, a.authorization, request), receipt);
});

test("配对：五次错误累计、新窗口替换、取消、到期和重启失效均持久化", t => {
  const f = fixture(t), auth = f.open(true), a = candidate(), initial = auth.openPairing();
  for (let index = 0; index < 5; index++) assert.throws(() => auth.pair(binding.owner, index === 0 ? "bad" : a.authorization, { v: 1, code: "AAAAAAAAAAAA", label: "Electron" }), code("remote_pairing_rejected"));
  assert.equal(JSON.parse(fs.readFileSync(f.filename, "utf8")).pairing, undefined);
  assert.throws(() => auth.pair(binding.owner, a.authorization, { v: 1, code: initial.code, label: "Electron" }), code("remote_pairing_closed"));
  const old = auth.openPairing(), next = auth.openPairing();
  assert.throws(() => auth.pair(binding.owner, a.authorization, { v: 1, code: old.code, label: "Electron" }), code("remote_pairing_rejected"));
  auth.cancelPairing();
  assert.throws(() => auth.pair(binding.owner, a.authorization, { v: 1, code: next.code, label: "Electron" }), code("remote_pairing_closed"));
  const expiring = auth.openPairing(), now = Date.now;
  t.mock.method(Date, "now", () => expiring.expiresAt);
  assert.throws(() => auth.pair(binding.owner, a.authorization, { v: 1, code: expiring.code, label: "Electron" }), code("remote_pairing_closed"));
  assert.equal(JSON.parse(fs.readFileSync(f.filename, "utf8")).pairing, undefined);
  t.mock.method(Date, "now", now);
  const pending = auth.openPairing(); auth.close();
  assert.ok(JSON.parse(fs.readFileSync(f.filename, "utf8")).pairing);
  const restarted = f.open();
  assert.equal(JSON.parse(fs.readFileSync(f.filename, "utf8")).pairing, undefined);
  assert.throws(() => restarted.pair(binding.owner, a.authorization, { v: 1, code: pending.code, label: "Electron" }), code("remote_pairing_closed"));
});

test("认证与撤销：双重身份、原回执墓碑、重启不复活且其他凭据继续有效", t => {
  const f = fixture(t), auth = f.open(true), a = paired(auth), b = paired(auth, "MyGo");
  for (const owner of [undefined, "other@example.invalid", ""]) assert.throws(() => auth.authenticate(owner, a.authorization), code("remote_source_rejected"));
  for (const authorization of [undefined, "Bearer invalid", `Bearer ${a.id}.${b.secret}`]) assert.throws(() => auth.authenticate(binding.owner, authorization), code("remote_credential_invalid"));
  const revoked = auth.revoke(a.id);
  assert.equal(revoked.status, "revoked"); assert.ok(revoked.revokedAt !== undefined);
  assert.deepEqual(auth.revoke(a.id), revoked);
  assert.throws(() => auth.authenticate(binding.owner, a.authorization), code("remote_credential_revoked"));
  assert.deepEqual(auth.pair(binding.owner, a.authorization, a.request), revoked);
  assert.equal(auth.authenticate(binding.owner, b.authorization).status, "active");
  auth.close(); const restarted = f.open();
  assert.throws(() => restarted.authenticate(binding.owner, a.authorization), code("remote_credential_revoked"));
  assert.deepEqual(restarted.pair(binding.owner, a.authorization, a.request), revoked);
  assert.equal(restarted.authenticate(binding.owner, b.authorization).status, "active");
});

test("归属变化：owner、origin、档案分别持久撤销，A到B再回A不复活", t => {
  for (const changed of [{ ...binding, owner: "another@example.invalid" }, { ...binding, origin: "https://another.example.ts.net" }, { ...binding, profile: { ...binding.profile, id: `sha256:${"b".repeat(64)}` } }]) {
    const f = fixture(t), auth = f.open(true), original = paired(auth), remoteId = auth.identity().remoteId;
    auth.openPairing(); auth.close();
    const different = f.open(false, changed);
    assert.equal(different.identity().remoteId, remoteId); assert.equal(different.identity().confirmed, false);
    assert.equal(different.list()[0].status, "revoked");
    assert.throws(() => different.openPairing(), code("remote_binding_unconfirmed"));
    assert.throws(() => different.authenticate(changed.owner, original.authorization), code("remote_binding_unconfirmed"));
    different.confirmBinding(); different.close();
    const returned = f.open(false, binding);
    assert.equal(returned.identity().confirmed, false); returned.confirmBinding();
    assert.throws(() => returned.authenticate(binding.owner, original.authorization), code("remote_credential_revoked"));
    assert.equal(returned.pair(binding.owner, original.authorization, original.request).status, "revoked");
    assert.equal(returned.identity().remoteId, remoteId);
  }
});

test("运行中归属变化：先持久撤销再等待确认，恢复旧绑定仍不能复活", t => {
  const f = fixture(t), auth = f.open(true), original = paired(auth), before = fs.readFileSync(f.filename, "utf8");
  auth.updateBinding(binding); assert.equal(fs.readFileSync(f.filename, "utf8"), before);
  auth.openPairing(); auth.updateBinding({ ...binding, origin: "https://another.example.ts.net" });
  const changed = JSON.parse(fs.readFileSync(f.filename, "utf8"));
  assert.equal(changed.confirmed, false); assert.equal(changed.pairing, undefined); assert.ok(changed.credentials[0].revokedAt !== undefined);
  assert.throws(() => auth.authenticate(binding.owner, original.authorization), code("remote_binding_unconfirmed"));
  auth.confirmBinding(); auth.updateBinding(binding); auth.confirmBinding();
  assert.throws(() => auth.authenticate(binding.owner, original.authorization), code("remote_credential_revoked"));
  assert.equal(auth.pair(binding.owner, original.authorization, original.request).status, "revoked");
});

test("认证落盘失败：配对不放行、撤销不报告成功，旧记录保留且当前入口关闭", t => {
  for (const stage of ["pair", "revoke"] as const) {
    const f = fixture(t), auth = f.open(true), a = paired(auth), window = auth.openPairing(), b = candidate(), before = fs.readFileSync(f.filename, "utf8");
    const mocked = t.mock.method(fs, "renameSync", () => { throw Object.assign(new Error("fixture failure"), { code: "EIO" }); });
    syncBuiltinESMExports();
    try {
      if (stage === "pair") assert.throws(() => auth.pair(binding.owner, b.authorization, { v: 1, code: window.code, label: "MyGo" }), code("remote_auth_write_failed"));
      else assert.throws(() => auth.revoke(a.id), code("remote_auth_write_failed"));
      assert.equal(fs.readFileSync(f.filename, "utf8"), before);
      assert.throws(() => auth.authenticate(binding.owner, a.authorization), code("remote_auth_closed"));
    } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
    auth.close(); const restarted = f.open();
    assert.equal(restarted.authenticate(binding.owner, a.authorization).status, "active");
    assert.throws(() => restarted.authenticate(binding.owner, b.authorization), code("remote_credential_invalid"));
  }
});

test("认证状态运行中丢失或变化：原凭据停止准入且不自动创建空状态", t => {
  for (const change of ["missing", "corrupt"] as const) {
    const f = fixture(t), auth = f.open(true), a = paired(auth);
    if (change === "missing") fs.unlinkSync(f.filename); else fs.writeFileSync(f.filename, "broken");
    assert.throws(() => auth.authenticate(binding.owner, a.authorization), code("remote_auth_state_changed"));
    assert.throws(() => auth.list(), code("remote_auth_closed"));
    auth.close(); assert.throws(() => f.open(), code(change === "missing" ? "remote_auth_state_missing" : "remote_auth_state_invalid"));
  }
});

test("共享私有记录：路径穿越、硬链接与符号链接不读写，原始JSON可持久读回", t => {
  const f = fixture(t), auth = f.open(true), original = fs.readFileSync(f.filename, "utf8");
  writePersonalRemoteFile(f.directory, "remote.json", '{"v":1}\n');
  assert.equal(readPersonalRemoteFile(f.directory, "remote.json"), '{"v":1}\n');
  assert.equal(fs.statSync(path.join(f.directory, "remote.json")).mode & 0o777, 0o600);
  assert.throws(() => writePersonalRemoteFile(f.directory, "../auth.json", "{}"), code("remote_auth_state_invalid"));
  fs.linkSync(f.filename, path.join(f.directory, "linked.json"));
  assert.throws(() => readPersonalRemoteFile(f.directory, "linked.json"), code("remote_auth_state_invalid"));
  assert.throws(() => writePersonalRemoteFile(f.directory, "linked.json", "{}"), code("remote_auth_state_invalid"));
  fs.symlinkSync(f.filename, path.join(f.directory, "symbolic.json"));
  assert.throws(() => readPersonalRemoteFile(f.directory, "symbolic.json"), code("remote_auth_state_invalid"));
  assert.throws(() => writePersonalRemoteFile(f.directory, "symbolic.json", "{}"), code("remote_auth_state_invalid"));
  assert.equal(fs.readFileSync(f.filename, "utf8"), original); auth.close();
});

test("目录同步失败：不报告配对或撤销成功，重开以实际原回执核实", t => {
  for (const operation of ["pair", "revoke"] as const) {
    const f = fixture(t), auth = f.open(true), a = paired(auth), window = auth.openPairing(), b = candidate(), request = { v: 1 as const, code: window.code, label: "MyGo" };
    const sync = fs.fsyncSync;
    const mocked = t.mock.method(fs, "fsyncSync", (fd: number) => { if (fs.fstatSync(fd).isDirectory()) throw new Error("fixture directory sync failed"); sync(fd); });
    syncBuiltinESMExports();
    try {
      if (operation === "pair") assert.throws(() => auth.pair(binding.owner, b.authorization, request), code("remote_auth_write_failed"));
      else assert.throws(() => auth.revoke(a.id), code("remote_auth_write_failed"));
      assert.throws(() => auth.authenticate(binding.owner, a.authorization), code("remote_auth_closed"));
    } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
    auth.close(); const restarted = f.open();
    if (operation === "pair") assert.equal(restarted.pair(binding.owner, b.authorization, request).id, b.id);
    else assert.equal(restarted.pair(binding.owner, a.authorization, a.request).status, "revoked");
  }
});

test("配对提交前后进程崩溃：同一候选可核实，未提交不登记、已提交不二次发行", async t => {
  for (const stage of ["before", "after"] as const) {
    const f = fixture(t), auth = f.open(true), window = auth.openPairing(), a = candidate(), request = { v: 1 as const, code: window.code, label: "Electron" }; auth.close();
    const module = new URL("../apps/ruukoto/src/personal-remote-auth.ts", import.meta.url).href;
    const source = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {openPersonalRemoteAuth} from ${JSON.stringify(module)};const input=JSON.parse(fs.readFileSync(0,'utf8'));const auth=openPersonalRemoteAuth(input.binding,{home:()=>input.home});const window=auth.openPairing();input.request.code=window.code;process.stdout.write(JSON.stringify(input.request)+'\\n');const rename=fs.renameSync;fs.renameSync=(...args)=>{if(input.stage==='before')process.kill(process.pid,'SIGKILL');const result=rename(...args);process.kill(process.pid,'SIGKILL');return result;};syncBuiltinESMExports();auth.pair(input.binding.owner,input.authorization,input.request);`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { stdio: ["pipe", "pipe", "pipe"] });
    const closed = once(child, "exit"); let output = "";
    child.stdout!.on("data", chunk => { output += chunk; });
    child.stdin!.end(JSON.stringify({ stage, binding, home: f.home, authorization: a.authorization, request }));
    const [, signal] = await closed; assert.equal(signal, "SIGKILL");
    const submitted = JSON.parse(output), restarted = f.open();
    if (stage === "before") {
      assert.throws(() => restarted.authenticate(binding.owner, a.authorization), code("remote_credential_invalid"));
      assert.equal(restarted.list().length, 0);
    } else {
      const first = restarted.pair(binding.owner, a.authorization, submitted);
      assert.equal(first.id, a.id); assert.deepEqual(restarted.pair(binding.owner, a.authorization, submitted), first);
      assert.equal(restarted.list().length, 1);
    }
  }
});

test("认证进程崩溃：OS释放独占锁，重开保留原身份并使旧配对窗口落盘失效", async t => {
  const f = fixture(t), auth = f.open(true), identity = auth.identity(); auth.close();
  const module = new URL("../apps/ruukoto/src/personal-remote-auth.ts", import.meta.url).href;
  const source = `import {openPersonalRemoteAuth} from ${JSON.stringify(module)};const auth=openPersonalRemoteAuth(${JSON.stringify(binding)},{home:()=>${JSON.stringify(f.home)}});auth.openPairing();process.stdout.write('ready\\n');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  const closed = once(child, "exit");
  await once(child.stdout!, "data");
  assert.throws(() => f.open(), code("remote_busy"));
  child.kill("SIGKILL"); await closed;
  assert.ok(JSON.parse(fs.readFileSync(f.filename, "utf8")).pairing);
  const restarted = f.open();
  assert.deepEqual(restarted.identity(), identity);
  assert.equal(JSON.parse(fs.readFileSync(f.filename, "utf8")).pairing, undefined);
});
