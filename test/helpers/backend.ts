import * as childProcess from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { ControlClient } from "@ruukoto/control/client.ts";
import { profileChildEnv, type ProfilePaths } from "@ruukoto/core/profile.ts";
import { authenticateClient } from "./testkit.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");

export function spawnBackendRaw(args: string[], env: NodeJS.ProcessEnv = {}): childProcess.ChildProcess {
  return childProcess.spawn(tsxBin, args, { cwd: repoRoot, env: { ...process.env, RUUKOTO_OWNER_TOKEN: "", RUUKOTO_OWNER_TOKEN_FILE: "", ...env }, stdio: "ignore" });
}

export interface Backend { child: childProcess.ChildProcess; client: ControlClient }

export function killProcessTree(child: childProcess.ChildProcess): void {
  try { if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); }
  catch { /* The isolated test process group has already exited. */ }
}

export async function spawnBackend(profile: ProfilePaths): Promise<Backend> {
  const child = childProcess.spawn(process.execPath, ["--import", "tsx", "apps/ruukoto/src/main.ts", "server", "--tools", "mock"], {
    cwd: repoRoot, env: profileChildEnv(profile.selection, { ...process.env, RUUKOTO_OWNER_TOKEN: "", RUUKOTO_OWNER_TOKEN_FILE: "" }),
    stdio: ["ignore", "ignore", "pipe"], detached: true,
  });
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Backend exited (${child.exitCode ?? child.signalCode}): ${stderr.slice(0, 2000)}`);
    try {
      const client = await ControlClient.connect(profile.socketPath, 1500);
      await authenticateClient(client, profile);
      const result = await client.handshake();
      if (result.snapshot.instanceId !== profile.instanceId) { client.close(); throw new Error("Backend profile identity differs"); }
      return { child, client };
    } catch (error) {
      if (Date.now() > deadline) {
        killProcessTree(child);
        throw new Error(`Backend connection timed out: ${error instanceof Error ? error.message : String(error)}\n${stderr.slice(0, 2000)}`);
      }
      await delay(100);
    }
  }
}

export async function killBackend(backend: Backend): Promise<void> {
  backend.client.close();
  if (backend.child.exitCode !== null || backend.child.signalCode !== null) return;
  const exited = once(backend.child, "exit");
  killProcessTree(backend.child);
  await exited;
}
