import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { assertElectronStartup } from "../apps/desktop/src/main/startup.ts";
import { adoptEnvironment, codeTargetConfig, hostEnvironment } from "../apps/desktop/src/main/environment.ts";

const repository = path.resolve(import.meta.dirname, "..");
test("宿主不采用登录环境的注入与TLS覆盖，Code显式环境保留", () => {
  const previous = { ...process.env };
  const source = { env: { ...process.env, NODE_OPTIONS: "--import=/untrusted.mjs", NODE_TLS_REJECT_UNAUTHORIZED: "0", NODE_PATH: "/untrusted", DYLD_INSERT_LIBRARIES: "/untrusted.dylib", ELECTRON_RENDERER_URL: "https://untrusted", SSL_CERT_FILE: "/untrusted.pem", RUUKOTO_CODE_DATA_DIR: "/original-code", PATH: process.env.PATH }, node: process.execPath };
  try {
    process.env.NODE_OPTIONS = "--require=/already-present";
    adoptEnvironment(source.env);
    for (const key of ["NODE_OPTIONS", "NODE_PATH", "NODE_TLS_REJECT_UNAUTHORIZED", "DYLD_INSERT_LIBRARIES", "ELECTRON_RENDERER_URL", "SSL_CERT_FILE"]) assert.equal(process.env[key], undefined, key);
    assert.equal(process.env.RUUKOTO_CODE_DATA_DIR, source.env.RUUKOTO_CODE_DATA_DIR);
    const config = codeTargetConfig(repository, source);
    assert.equal(config.env, source.env);
    assert.equal(config.env?.NODE_OPTIONS, "--import=/untrusted.mjs");
    assert.equal(hostEnvironment(source.env).PATH, source.env.PATH);
  } finally { adoptEnvironment(previous); }
});

test("生产Electron在读取Host前拒绝调试参数及外部renderer", () => {
  for (const arg of ["--inspect=0", "--inspect_brk", "--remote-debugging-port=9222", "--remote_debugging_pipe", "--js-flags=--expose-gc", "--import=/tmp/module.mjs", "--user-data-dir=/tmp/override", "--app=/tmp/override", "-e"]) assert.throws(() => assertElectronStartup(true, "/missing", "/missing", [arg], {}), { code: "desktop_startup_rejected" }, arg);
  for (const key of ["ELECTRON_RENDERER_URL", "RUUKOTO_DESKTOP_MYGO_USER_DATA", "RUUKOTO_DESKTOP_MANAGED"]) assert.throws(() => assertElectronStartup(true, "/missing", "/missing", [], { [key]: "override" }), { code: "desktop_startup_rejected" }, key);
  assert.doesNotThrow(() => assertElectronStartup(false, "/development", "/development", ["--inspect"], { ELECTRON_RENDERER_URL: "http://localhost" }));
});

test("Electron整包签名校验覆盖unpacked原生资源，失败先于Host加载", { skip: process.platform !== "darwin" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-startup-"));
  const bundle = path.join(root, "Fixture.app");
  const executable = path.join(bundle, "Contents/MacOS/Fixture");
  const appPath = path.join(bundle, "Contents/Resources/app.asar");
  const native = path.join(bundle, "Contents/Resources/app.asar.unpacked/pty.node");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.mkdirSync(path.dirname(native), { recursive: true });
  fs.copyFileSync("/usr/bin/true", executable);
  fs.writeFileSync(appPath, "fixture archive");
  fs.writeFileSync(native, "sealed native fixture");
  fs.writeFileSync(path.join(bundle, "Contents/Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.ruukoto.startup.fixture</string><key>CFBundleExecutable</key><string>Fixture</string></dict></plist>');
  try {
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", bundle], { stdio: "pipe" });
    assert.doesNotThrow(() => assertElectronStartup(true, executable, appPath, ["-psn_0_1"], {}));
    fs.writeFileSync(native, "replaced native fixture");
    let loaded = false;
    assert.throws(() => { assertElectronStartup(true, executable, appPath, ["-psn_0_1"], {}); loaded = true; }, { code: "desktop_integrity" });
    assert.equal(loaded, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
