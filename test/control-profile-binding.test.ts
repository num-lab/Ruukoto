import assert from "node:assert/strict";
import { test } from "node:test";
import { ControlClient, ControlClientError } from "@ruukoto/control/client.ts";
import { resolveClientConfig } from "@ruukoto/control/connect.ts";
import { CONTROL_PROTOCOL_VERSION } from "@ruukoto/control/protocol.ts";
import { routeResponder, startTestRuntime } from "./helpers/testkit.ts";

const rejected = (code: string) => (error: unknown): boolean => error instanceof ControlClientError && error.code === code && error.outcome === "rejected";

test("control admission binds product, layout and instance before accepting owner operations", async () => {
  const fixture = await startTestRuntime("control-profile-binding", routeResponder([]));
  const profile = fixture.dirs.profile;
  const config = resolveClientConfig(profile);
  try {
    for (const binding of [
      { product: "ruukoto-code", layout: profile.layout, instanceId: profile.instanceId },
      { product: "ruukoto", layout: "legacy", instanceId: profile.instanceId },
      { product: "ruukoto", layout: profile.layout, instanceId: "different-instance" },
      {},
    ]) {
      const client = await ControlClient.connect(profile.socketPath);
      try {
        await assert.rejects(client.request("auth", { token: config.token, ...binding }), rejected("profile_mismatch"));
        await assert.rejects(client.request("create_project", { name: "must-not-exist" }), rejected("unauthorized"));
      } finally { client.close(); }
    }
    const client = await ControlClient.connect(profile.socketPath);
    try {
      await client.authenticate(config.token, profile);
      const { snapshot } = await client.handshake();
      assert.equal(CONTROL_PROTOCOL_VERSION, 50);
      assert.equal(snapshot.product, "ruukoto");
      assert.equal(snapshot.layout, profile.layout);
      assert.equal(snapshot.instanceId, profile.instanceId);
      assert.ok(!snapshot.projects.some(project => project.name === "must-not-exist"));
      for (const op of ["qq_status", "telegram_status", "schedule_list", "notification_list", "service_grant_list", "preview_workspace_migration"]) {
        await assert.rejects(client.request(op, {}), rejected("unknown_op"));
      }
    } finally { client.close(); }
  } finally { await fixture.shutdown(); }
});
