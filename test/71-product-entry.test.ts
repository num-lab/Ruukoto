import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bootstrapProfile, profileChildEnv, selectionTuple, selectProfile } from "@ruukoto/core/profile.ts";
import { devProfileFor } from "@ruukoto/tui/dev.ts";

const repository = fileURLToPath(new URL("../", import.meta.url));

test("help, demo and invalid native overrides do not initialize storage", t => {
  const home = mkdtempSync(join(tmpdir(), "ruukoto-entry-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const args of [["--help"], ["--demo"], ["server", "--execution", "local"], ["server", "--model", "invalid"]]) {
    const env = { PATH: process.env.PATH, HOME: home };
    const result = spawnSync(process.execPath, [join(repository, "apps/ruukoto/bin/ruukoto.mjs"), ...args], { env, encoding: "utf8" });
    assert.equal(result.status, args[0] === "--help" ? 0 : 1, result.stderr);
    assert.deepEqual(readdirSync(home), []);
  }
});

test("daily and checkout selections round trip every partial role override", async t => {
  const home = mkdtempSync(join(tmpdir(), "ruukoto-selection-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (let mask = 0; mask < 16; mask++) {
    const base = join(home, String(mask));
    const selection = selectProfile({
      dataDir: mask & 1 ? join(base, "custom-db") : join(base, "data"),
      ...(mask & 2 ? { agentDir: join(base, "custom-agent") } : {}),
      ...(mask & 4 ? { controlDir: join(base, "custom-control") } : {}),
      ...(mask & 8 ? { pendingDir: join(base, "custom-pending") } : {}),
    }, {}, home);
    const profile = await bootstrapProfile(selection);
    const child = selectProfile({}, profileChildEnv(selection, {}), home);
    assert.deepEqual(selectionTuple(child), selectionTuple(selection));
    assert.equal((await bootstrapProfile(child)).instanceId, profile.instanceId);
  }
  const dev = await bootstrapProfile(devProfileFor(repository, home));
  const daily = await bootstrapProfile(selectProfile({}, {}, home));
  assert.notEqual(dev.instanceId, daily.instanceId);
  assert.notEqual(dev.socketPath, daily.socketPath);
  assert.equal((await bootstrapProfile(selectProfile({}, profileChildEnv(dev.selection, {}), home))).rootDir, dev.rootDir);
});
