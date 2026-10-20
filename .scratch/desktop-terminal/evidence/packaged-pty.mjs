import assert from "node:assert/strict";
import { createRequire } from "node:module";
const modulePath = process.argv[2];
assert.ok(modulePath, "传入应用包内node-pty绝对路径");
const pty = createRequire(import.meta.url)(modulePath).spawn("/bin/bash", ["-lc", "printf 'PACKAGED_中文'; stty size"], { cols: 100, rows: 30, cwd: "/tmp", env: { ...process.env, TERM: "xterm-256color" } });
let text = "";
pty.onData(data => { text += data; });
const deadline = setTimeout(() => { pty.kill("SIGKILL"); process.exitCode = 1; }, 5000);
pty.onExit(({ exitCode }) => {
  clearTimeout(deadline); assert.equal(exitCode, 0); assert.ok(text.includes("PACKAGED_中文")); assert.ok(text.includes("30 100"));
  process.stdout.write(JSON.stringify({ runtime: process.versions.electron ? "Electron" : "Node", modulePath, output: text, exitCode }) + "\n");
});
