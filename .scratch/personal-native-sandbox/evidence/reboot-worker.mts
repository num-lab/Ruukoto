/** VM 开机后的真实 native worker；不加载模型和 Runtime，沿用现有 launcher。 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createLauncherFor } from "@ruukoto/agent/execution/launchers.ts";
import { linuxNativeScopeEmpty } from "@ruukoto/agent/execution/native-linux.ts";
import { ToolWorkerHost } from "@ruukoto/agent/tool-worker/host.ts";

const root = "/var/lib/ruukoto-native-reboot-worker", workspace = path.join(root, "workspace");
fs.mkdirSync(workspace, { recursive: true });
const stat = fs.statSync(workspace), bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
assert.equal(process.getuid!(), Number(execFileSync("id", ["-u", "ruukoto-native-check"], { encoding: "utf8" }).trim()));
assert.ok(fs.readFileSync("/proc/self/cgroup", "utf8").includes("/system.slice/ruukoto-native-reboot-worker.service"));
const host = ToolWorkerHost.create(createLauncherFor({ backend: "native" }, "confirm"), {
  taskId: `reboot-${bootId}`, mode: "confirm", workspace, workspaceIdentity: { dev: stat.dev, ino: stat.ino }, grantedPaths: [],
});
let cgroup = "", workerIdentity = "";
try {
  await host.start();
  const scope = host.identity()!.id;
  cgroup = execFileSync("systemctl", ["--user", "show", scope, "--property=ControlGroup", "--value"], { encoding: "utf8" }).trim();
  assert.ok(cgroup && path.basename(cgroup) === scope);
  assert.equal((await host.call({ opId: "boot-write", sdkCallId: "boot-write", name: "write", params: { path: "boot-id.txt", content: bootId + "\n" } })).isError, false);
  const identity = await host.call({ opId: "boot-bash", sdkCallId: "boot-bash", name: "bash", params: {
    command: `set -eu; test -f boot-id.txt; test -z "\${DBUS_SESSION_BUS_ADDRESS-}"; test -z "\${XDG_RUNTIME_DIR-}"; test "$(id -u)" = ${process.getuid!()}; id`,
  } });
  assert.equal(identity.isError, false);
  workerIdentity = identity.content.map(block => typeof block === "object" && block !== null && "text" in block && typeof block.text === "string" ? block.text : "").join("\n").slice(0, 512);
  assert.match(workerIdentity, new RegExp(`uid=${process.getuid!()}\\b`));
  assert.equal(fs.readFileSync(path.join(workspace, "boot-id.txt"), "utf8"), bootId + "\n");
} finally { assert.equal(await host.stop(), true); }
assert.equal(linuxNativeScopeEmpty(path.join("/sys/fs/cgroup", cgroup)), true);
const result = { pass: true, bootId, uid: process.getuid!(), workerIdentity, cgroup, time: new Date().toISOString(),
  userState: execFileSync("loginctl", ["show-user", String(process.getuid!()), "-p", "Linger", "-p", "Sessions", "-p", "State"], { encoding: "utf8" }).trim() };
assert.match(result.userState, /^Sessions=$/m);
assert.match(result.userState, /^Linger=yes$/m);
fs.appendFileSync(path.join(root, "results.jsonl"), JSON.stringify(result) + "\n");
process.stdout.write(JSON.stringify(result) + "\n");
