import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PersonalDesktopFrame, PersonalTimelineEntry } from "@ruukoto/view/personal-protocol.ts";
import { WebSocket } from "ws";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider } from "../apps/ruukoto/src/personal-model.ts";
import { parsePersonalTools } from "../apps/ruukoto/src/personal-tools-config.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { PersonalOutputsDoc } from "../apps/ruukoto/src/personal-outputs.ts";
import { personalTimeline } from "../apps/ruukoto/src/personal-history.ts";
import { personalDesktopEvents, PERSONAL_DESKTOP_FRAME_LIMIT } from "../apps/ruukoto/src/personal-desktop-events.ts";
import { PersonalMockModelServer } from "./helpers/mock-provider.ts";
import { isolateSkillHome } from "./helpers/skill-home.ts";

const context = BACKGROUND_CONTEXT;
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!await check()) { assert.ok(Date.now() < deadline, "Escaped output frames did not arrive"); await delay(5); }
}
function timelineEntries(frames: PersonalDesktopFrame[]): PersonalTimelineEntry[] {
  return frames.flatMap(frame => frame.type === "snapshot" ? frame.timeline.items : frame.events.flatMap(event => event.type === "entry_appended" || event.type === "message_end" ? [event.entry] : []));
}

test("Eight maximally escaped final-file descriptors survive live publication and WebSocket reconnect", { timeout: 30_000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-output-frames-"))), workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { mode: 0o700 });
  // Lone surrogates consume six JSON bytes each; names reject control characters.
  const name = "\ud800".repeat(128), mime = '"'.repeat(256), reportText = "\u0000".repeat(4096), content = Buffer.from("ORIGINAL_FINAL_BYTES");
  let fetches = 0, publishedCalls = 0, reportReady = false, releaseReport!: () => void;
  const reportGate = new Promise<void>(resolve => { releaseReport = resolve; });
  const artifactServer = http.createServer((request, response) => {
    assert.equal(request.url, "/artifact"); fetches++;
    response.writeHead(200, { "content-type": mime }); response.end(content);
  });
  const server = http.createServer(), clients: WebSocket[] = [];
  let p: PersonalHarness | undefined, events: ReturnType<typeof personalDesktopEvents> | undefined;
  const apiKeyEnv = "PERSONAL_OUTPUT_FRAMES_TEST_KEY", previous = process.env[apiKeyEnv]; process.env[apiKeyEnv] = "offline-only";
  let artifactUrl = "";
  const model = new PersonalMockModelServer(async request => {
    if (request.system?.includes("你是个人助手的子 Agent")) {
      const results = request.messages.filter(message => message.role === "tool").map(message => JSON.parse(String(message.content)) as { artifact?: string });
      if (!results.length) return { kind: "tool_calls", calls: [{ id: "source", name: "http_request", arguments: { url: artifactUrl } }] };
      if (publishedCalls < 8) {
        const artifact = results.find(result => result.artifact)?.artifact; assert.ok(artifact);
        return { kind: "tool_calls", calls: [{ id: `publish-${++publishedCalls}`, name: "publish_output", arguments: { name, artifact } }] };
      }
      return { kind: "text", text: "The requested final files are registered." };
    }
    if (String(request.messages.findLast(message => message.role === "user")?.content).startsWith("宿主委托汇总参考")) {
      reportReady = true; await reportGate; return { kind: "text", text: reportText };
    }
    if (request.messages.at(-1)?.role === "tool") return { kind: "text", text: "Background work arranged." };
    return { kind: "tool_calls", calls: [{ id: "delegate", name: "background_work", arguments: { action: "delegate", content: "Fetch the requested artifact once and deliver eight named final files." } }] };
  });
  t.after(async () => {
    releaseReport(); for (const client of clients) client.terminate();
    await events?.close(); await new Promise<void>(resolve => server.close(() => resolve()));
    await p?.close(); await model.close(); await new Promise<void>(resolve => artifactServer.close(() => resolve()));
    if (previous === undefined) delete process.env[apiKeyEnv]; else process.env[apiKeyEnv] = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  isolateSkillHome(t);
  artifactServer.listen(0, "127.0.0.1"); await once(artifactServer, "listening");
  const address = artifactServer.address(); assert.ok(address && typeof address !== "string"); artifactUrl = `http://127.0.0.1:${address.port}/artifact`;
  const config = { api: "openai-completions" as const, baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv, contextWindow: 128000, maxTokens: 8192 };
  const identity = fs.statSync(workspace), tools = parsePersonalTools({ version: 1, generation: randomUUID(), workspace, identity: { dev: identity.dev, ino: identity.ino }, credentials: [] });
  p = await openPersonalHarness({ directory: path.join(root, "profile"), provider: personalProvider(config), modelId: config.modelId, tools });
  await p.harness.commit(async tx => { const permission = await tx.doc(PersonalPermissionsDoc); permission.mode = "full_access"; permission.version++; }, context);
  await p.answer("Deliver eight final files from the original artifact.", "escaped-output-owner");
  await until(() => reportReady);
  const ids = (await p.harness.snapshot(PersonalOutputsDoc, context))!.intents;
  assert.equal(ids.length, 8); assert.equal(fetches, 1);
  assert.equal((await p.harness.commit(tx => personalTimeline(tx, {}), context)).items.some(entry => entry.outputs?.length), false);
  events = personalDesktopEvents(server, p.harness, "test-token", randomUUID());
  const socketPath = path.join(root, "desktop.sock"); server.listen(socketPath); await once(server, "listening");
  const sizes: number[] = [];
  const connect = () => {
    const client = new WebSocket(`ws+unix:${socketPath}:/events`, { headers: { authorization: "Bearer test-token" } }), frames: PersonalDesktopFrame[] = [];
    clients.push(client);
    client.on("message", data => { const text = data.toString(); sizes.push(Buffer.byteLength(text)); frames.push(JSON.parse(text) as PersonalDesktopFrame); });
    return { client, frames };
  };
  const live = connect(); await once(live.client, "open"); await until(() => live.frames.length > 0);
  assert.equal(timelineEntries(live.frames).some(entry => entry.outputs?.length), false);
  releaseReport();
  await until(() => timelineEntries(live.frames).some(entry => entry.outputs?.length === 8));
  const publication = timelineEntries(live.frames).find(entry => entry.outputs?.length === 8)!;
  assert.deepEqual(publication.outputs, ids.map(output => ({ v: 1, publication: publication.entry, output, name, mime, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex"), partial: false })));
  assert.equal(publication.text, reportText); assert.equal(live.client.readyState, WebSocket.OPEN);
  assert.ok(live.frames.some(frame => frame.type === "events" && timelineEntries([frame]).some(entry => entry.entry === publication.entry)));
  const replay = connect(); await once(replay.client, "open"); await until(() => replay.frames.length > 0);
  assert.equal(replay.frames[0].type, "snapshot");
  assert.deepEqual(timelineEntries(replay.frames).find(entry => entry.entry === publication.entry), publication);
  assert.equal(replay.client.readyState, WebSocket.OPEN); assert.equal(fetches, 1); assert.equal(publishedCalls, 8);
  assert.ok(sizes.every(bytes => bytes <= PERSONAL_DESKTOP_FRAME_LIMIT));
  for (const { frames } of [live, replay]) assert.ok(frames.every((frame, index) => frame.seq === index));
  t.diagnostic(JSON.stringify({ outputs: ids.length, maxFrameBytes: Math.max(...sizes), frames: sizes.length, limit: PERSONAL_DESKTOP_FRAME_LIMIT, sourceRequests: fetches }));
});
