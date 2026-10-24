import { ROOT_CONVERSATION_ID, watchEvents, type AgentEvent, type AgentEventStream, type Harness, type MessageChange, type SnapshotEvent, type ToolEventCall, type ToolSlot, type NestedToolSlot, type EntryRecord } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { personalDesktopMessage, personalTimeline, personalTimelineEntry } from "./personal-history.ts";
import type { PersonalDesktopBlock, PersonalDesktopChange, PersonalDesktopEvent, PersonalDesktopFrame, PersonalDesktopLive, PersonalDesktopMessage, PersonalDesktopTool } from "@ruukoto/view/personal-protocol.ts";

const context = BACKGROUND_CONTEXT;
export const PERSONAL_DESKTOP_FRAME_LIMIT = 256 * 1024;
export const PERSONAL_DESKTOP_BUFFER_LIMIT = 1024 * 1024;
const TEXT_LIMIT = 4096;

function block(value: Extract<MessageChange, { block: unknown }>["block"]): PersonalDesktopBlock {
  if (value.type === "toolCall") { const args = JSON.stringify(value.arguments); return { type: value.type, id: value.id, name: value.name, arguments: args.slice(0, 1024), truncated: args.length > 1024 }; }
  const text = value.type === "text" ? value.text : value.thinking;
  return { type: value.type, text: text.slice(0, TEXT_LIMIT), truncated: text.length > TEXT_LIMIT };
}

function currentMessage(value: NonNullable<EntryRecord["model"]>[number]): PersonalDesktopMessage | undefined {
  const message = personalDesktopMessage(value);
  if (!message || value.role !== "assistant") return message;
  const blocks: NonNullable<PersonalDesktopMessage["blocks"]> = [];
  let bytes = 0;
  for (const [index, part] of value.content.slice(0, 32).entries()) {
    const projected = { ...block(part), index }, size = Buffer.byteLength(JSON.stringify(projected));
    if (bytes + size > 48 * 1024) break;
    blocks.push(projected); bytes += size;
  }
  return { ...message, blocks, truncated: message.truncated || blocks.length < value.content.length || blocks.some(value => value.truncated) };
}

function call(event: ToolEventCall) {
  return { toolCallId: event.toolCallId, toolName: event.toolName, ...(event.taskId === undefined ? {} : { taskId: event.taskId }), ...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }), ...(event.parentTaskId === undefined ? {} : { parentTaskId: event.parentTaskId }) };
}

function tool(slot: ToolSlot | NestedToolSlot): PersonalDesktopTool {
  return { callId: slot.callId, name: slot.name, status: slot.status, ...(slot.taskId === undefined ? {} : { taskId: slot.taskId }), ...("entry" in slot && slot.entry !== undefined ? { entry: slot.entry } : {}), ...(slot.output === undefined ? {} : { output: slot.output.slice(0, TEXT_LIMIT) }), truncated: (slot.output?.length ?? 0) > TEXT_LIMIT || (slot.droppedBytes ?? 0) > 0 || (slot.droppedLines ?? 0) > 0, ...("parentCallId" in slot ? { parentCallId: slot.parentCallId, parentTaskId: slot.parentTaskId } : {}) };
}

export function personalDesktopLive(snapshot: SnapshotEvent): PersonalDesktopLive {
  const slots = [...snapshot.tools, ...snapshot.nestedTools];
  const generation = snapshot.generation, message = generation?.message && currentMessage(generation.message);
  const result: PersonalDesktopLive = { ...(snapshot.agent.model ? { model: snapshot.agent.model } : {}), ...(snapshot.run ? { run: { inputs: [...snapshot.run.inputs.slice(0, 64)], total: snapshot.run.inputs.length } } : {}), ...(generation ? { generation: { attempt: generation.attempt, ...(message ? { message: { ...message, partial: true } } : {}), ...(generation.retry ? { retry: { at: generation.retry.at, error: generation.retry.error.slice(0, TEXT_LIMIT) } } : {}), ...(generation.deferred ? { deferred: generation.deferred } : {}) } } : {}), tools: [], toolCount: slots.length, inbox: snapshot.inbox.slice(0, 64).map(item => ({ id: item.id, mode: item.mode })), inboxCount: snapshot.inbox.length };
  let bytes = Buffer.byteLength(JSON.stringify(result));
  for (const slot of slots.slice(0, 32)) {
    const projected = tool(slot), size = Buffer.byteLength(JSON.stringify(projected));
    if (bytes + size > 96 * 1024) break;
    result.tools.push(projected); bytes += size;
  }
  return result;
}

function change(value: MessageChange): PersonalDesktopChange {
  if (value.type === "message") return { type: value.type, message: { ...currentMessage(value.message)!, partial: true } };
  if ("delta" in value) return { ...value, delta: value.delta.slice(0, TEXT_LIMIT), truncated: value.delta.length > TEXT_LIMIT };
  return { type: value.type, contentIndex: value.contentIndex, block: block(value.block) };
}

export function personalDesktopEvent(event: Exclude<AgentEvent, SnapshotEvent>): PersonalDesktopEvent | undefined {
  switch (event.type) {
    case "message_start": { const message = currentMessage(event.message); return message ? { type: event.type, message: { ...message, partial: true } } : undefined; }
    case "message_update": return { type: event.type, changes: event.changes.map(change) };
    case "message_end":
    case "entry_appended": { const entry = personalTimelineEntry(event.entry); return entry ? { type: event.type, entry } : undefined; }
    case "run_start":
    case "run_end": return { type: event.type, inputs: [...event.inputs.slice(0, 64)], total: event.inputs.length };
    case "tool_execution_start": { const args = JSON.stringify(event.args); return { type: event.type, ...call(event), arguments: args.slice(0, TEXT_LIMIT), truncated: args.length > TEXT_LIMIT }; }
    case "tool_execution_update": {
      const output = event.output;
      return { type: event.type, ...call(event), ...(output ? { output: "set" in output ? { set: output.set.slice(0, TEXT_LIMIT) } : { ...(output.trimStart === undefined ? {} : { trimStart: output.trimStart }), ...(output.append === undefined ? {} : { append: output.append.slice(0, TEXT_LIMIT) }) } } : {}), truncated: (output ? "set" in output ? output.set.length : output.append?.length ?? 0 : 0) > TEXT_LIMIT };
    }
    case "tool_execution_end": { const entry = event.entry && personalTimelineEntry(event.entry), result = event.result && JSON.stringify(event.result.structuredOutput ?? ""); return { type: event.type, ...call(event), ...(entry ? { entry } : {}), ...(result !== undefined ? { result: { text: result.slice(0, TEXT_LIMIT), truncated: result.length > TEXT_LIMIT, isError: event.result!.isError } } : {}) }; }
    case "inbox_update": return { type: event.type, items: event.items.slice(0, 64).map(item => ({ id: item.id, mode: item.mode })), total: event.items.length };
    case "submission": return { type: event.type, record: { id: event.record.id, status: event.record.status, ...("entry" in event.record && event.record.entry !== undefined ? { entry: event.record.entry } : {}), ...("answer" in event.record && event.record.answer !== undefined ? { answer: event.record.answer } : {}) } };
    case "agent_changed": return { type: event.type, ...(event.agent.model ? { model: event.agent.model } : {}) };
    case "auto_retry_start": return { type: event.type, attempt: event.attempt, at: event.at, errorMessage: event.errorMessage.slice(0, TEXT_LIMIT) };
    case "task_failed": return { type: event.type, taskId: event.taskId, kind: event.kind, message: event.message.slice(0, TEXT_LIMIT) };
    case "compaction_end": return { type: event.type, taskId: event.taskId, reason: event.reason, ...(event.error === undefined ? {} : { error: event.error.slice(0, TEXT_LIMIT) }) };
    case "usage_changed": return;
    default: return event;
  }
}

export function personalDesktopCanSend(frameBytes: number, bufferedAmount: number) {
  return frameBytes <= PERSONAL_DESKTOP_FRAME_LIMIT && bufferedAmount + frameBytes <= PERSONAL_DESKTOP_BUFFER_LIMIT;
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-24-personal-tailscale-https.md
export function personalDesktopEvents(server: Server, harness: Harness, token: string, runId: string) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false });
  const streams = new Set<AgentEventStream>();
  const pending = new Set<Promise<void>>();
  let closing = false;
  const reject = (socket: Duplex, status: number) => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const expected = Buffer.from(`Bearer ${token}`), supplied = Buffer.from(req.headers.authorization ?? "");
    if (closing) { reject(socket, 503); return; }
    if (req.method !== "GET" || req.url !== "/events" || req.headers.origin !== undefined || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { reject(socket, 401); return; }
    let stream: AgentEventStream | undefined;
    let attached = false;
    try {
      stream = await watchEvents(harness, ROOT_CONVERSATION_ID, context);
      streams.add(stream);
      const through = stream.snapshot.entries.reduce((value, entry) => Math.max(value, entry.id), 0);
      const timeline = await harness.commit(tx => personalTimeline(tx, { through }), context);
      if (closing || socket.destroyed) return;
      const watch = stream;
      wss.handleUpgrade(req, socket, head, ws => {
        attached = true;
        const subscription = randomUUID();
        let seq = 0, ended = false;
        let pongTimeout: ReturnType<typeof setTimeout> | undefined;
        const finish = () => {
          if (ended) return;
          ended = true;
          clearInterval(heartbeat); clearTimeout(lifetime); clearTimeout(pongTimeout);
          void watch.stop().then(() => streams.delete(watch));
        };
        const send = (frame: PersonalDesktopFrame) => {
          if (ended || ws.readyState !== WebSocket.OPEN) return;
          const data = JSON.stringify(frame);
          if (!personalDesktopCanSend(Buffer.byteLength(data), ws.bufferedAmount)) { finish(); ws.close(1013, "resync_required"); return; }
          ws.send(data, error => { if (error) { finish(); ws.terminate(); } });
        };
        const heartbeat = setInterval(() => {
          if (ended || ws.readyState !== WebSocket.OPEN) return;
          ws.ping();
          pongTimeout = setTimeout(() => { finish(); ws.terminate(); }, 10_000);
        }, 30_000);
        const lifetime = setTimeout(() => { finish(); ws.close(1000, "reauthenticate"); }, 5 * 60_000);
        heartbeat.unref(); lifetime.unref();
        ws.on("pong", () => clearTimeout(pongTimeout));
        ws.on("close", finish);
        ws.on("error", () => { finish(); ws.terminate(); });
        ws.on("message", () => { finish(); ws.close(1008, "read_only"); });
        send({ v: 1, runId, subscription, seq, type: "snapshot", timeline, live: personalDesktopLive(watch.snapshot) });
        watch.start(async events => {
          if (events.some(event => event.type === "snapshot")) { finish(); ws.close(1013, "resync_required"); return; }
          const projected = events.flatMap(event => { const value = event.type !== "snapshot" && personalDesktopEvent(event); return value ? [value] : []; });
          if (projected.length) send({ v: 1, runId, subscription, seq: ++seq, type: "events", events: projected });
        });
        void watch.closed.then(() => { finish(); if (ws.readyState === WebSocket.OPEN) ws.close(1012, "backend_stopped"); });
      });
    } catch {
      process.stderr.write("[ruukoto:personal] 会话观察流未能建立，请重新连接；已接纳工作继续运行。\n");
      if (!socket.destroyed) reject(socket, 503);
    } finally {
      if (stream && !attached) { await stream.stop(); streams.delete(stream); }
    }
  }
  server.on("upgrade", (req, socket, head) => {
    const operation = upgrade(req, socket, head);
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
  });
  return { async close() {
    closing = true;
    for (const ws of wss.clients) ws.terminate();
    await Promise.all([...streams].map(stream => stream.stop()));
    await Promise.allSettled([...pending]);
    await new Promise<void>(resolve => wss.close(() => resolve()));
  } };
}
