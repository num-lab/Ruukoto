import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { electronPersonalCredentialStorage } from "../apps/desktop/src/main/personal-credential-storage.ts";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-credentials-"));
  let unavailable = false, wrongReadBack = false, rotate = false, encryptFailure = false, encryptions = 0, ready = 0;
  const crypto = {
    isAsyncEncryptionAvailable: async () => !unavailable,
    encryptStringAsync: async (value: string) => { encryptions++; if (unavailable || encryptFailure) throw new Error("SDK unavailable"); return Buffer.from(`encrypted:${value}`); },
    decryptStringAsync: async (value: Buffer) => { if (unavailable || !value.toString().startsWith("encrypted:")) throw new Error("SDK unavailable or corrupt"); return { result: wrongReadBack ? "wrong" : value.toString().slice(10), shouldReEncrypt: rotate }; },
  };
  const storage = electronPersonalCredentialStorage(root, true, crypto, async () => { ready++; });
  return { root, crypto, storage, file: path.join(root, "personal-credentials/production.v1.enc"), counts: () => ({ encryptions, ready }), unavailable: (value: boolean) => { unavailable = value; }, wrongReadBack: () => { wrongReadBack = true; }, rotate: () => { rotate = true; }, failEncrypt: () => { encryptFailure = true; }, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("缺失不访问系统存储，候选密文0600读回后可重开，开发槽独立", async () => {
  const f = fixture();
  try {
    assert.equal(await f.storage.read(), null); assert.deepEqual(f.counts(), { encryptions: 0, ready: 0 });
    await f.storage.write('{"candidate":"one"}');
    assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(f.file)).mode & 0o777, 0o700);
    const reopened = electronPersonalCredentialStorage(f.root, true, f.crypto, async () => {});
    assert.equal(await reopened.read(), '{"candidate":"one"}');
    const dev = electronPersonalCredentialStorage(f.root, false, f.crypto, async () => {});
    assert.equal(await dev.read(), null); await dev.write("development"); assert.equal(await reopened.read(), '{"candidate":"one"}');
    await reopened.remove(); assert.equal(await reopened.read(), null); assert.equal(await dev.read(), "development");
  } finally { f.clean(); }
});

test("系统拒绝或新密文读回失败保留原字节，不把错误当缺失", async () => {
  const f = fixture();
  try {
    await f.storage.write("original"); const original = fs.readFileSync(f.file);
    f.unavailable(true);
    await assert.rejects(f.storage.read(), { code: "personal_credentials_unavailable" });
    await assert.rejects(f.storage.write("replacement"), { code: "personal_credentials_unavailable" });
    assert.deepEqual(fs.readFileSync(f.file), original);
    f.unavailable(false); f.wrongReadBack();
    await assert.rejects(f.storage.write("replacement"), { code: "personal_credentials_unavailable" });
    assert.deepEqual(fs.readFileSync(f.file), original);
    assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ["production.v1.enc"]);
  } finally { f.clean(); }
});

test("损坏与符号链接不降级，重加密失败不覆盖原密文", async () => {
  const f = fixture();
  try {
    await f.storage.write("original"); const original = fs.readFileSync(f.file);
    f.rotate(); f.failEncrypt();
    await assert.rejects(f.storage.read(), { code: "personal_credentials_unavailable" });
    assert.deepEqual(fs.readFileSync(f.file), original);
    fs.writeFileSync(f.file, "corrupt"); await assert.rejects(f.storage.read(), { code: "personal_credentials_unavailable" }); assert.equal(fs.readFileSync(f.file, "utf8"), "corrupt");
    fs.unlinkSync(f.file); const target = path.join(f.root, "outside"); fs.writeFileSync(target, original, { mode: 0o600 }); fs.symlinkSync(target, f.file);
    await assert.rejects(f.storage.read(), { code: "personal_credentials_unavailable" }); assert.deepEqual(fs.readFileSync(target), original);
  } finally { f.clean(); }
});
