// 真实 Runtime／control socket 上的合成档案验收，不读取日常资料或调用模型。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { product } from "../../../apps/ruukoto-code/src/product.ts";
import { PROTOCOL_VERSION } from "@ruukoto/core/types.ts";
import { startTestRuntime } from "../../../test/helpers/testkit.ts";
const percentile = values => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * .95) - 1)] ?? 0;
const wire = cursor => cursor && ({ session_id: cursor.sessionId, byte_offset: cursor.byteOffset, phase: cursor.phase, read_offset: cursor.readOffset, query_key: cursor.queryKey, source: { file_dev: cursor.source.fileDev, file_ino: cursor.source.fileIno, min_size: cursor.source.minSize } });
const results = [];
for (const [label, count, perSession, body] of [["common", 100, 100, "合成Ab".repeat(128)], ["growth", 1000, 100, "合成Ab".repeat(64)], ["large-entry", 1, 1, "Aa".repeat(4 * 1024 * 1024)]].filter(([label]) => !process.argv[2] || process.argv[2] === label)) {
  const t = await startTestRuntime(`spotlight-${label}`, async () => { throw new Error("性能探针不调用模型"); }, { config: { product: product.runtime } });
  let worker;
  try {
    const project = t.runtime.store.createProject(`synthetic-${label}`);
    const sessions = t.runtime.store.withTx(() => Array.from({ length: count }, (_, at) => t.runtime.store.createSession({ projectId: project.id, cwd: t.work[0], cwdReal: t.work[0], cwdDev: 1, cwdIno: 1, piSessionId: `synthetic-${at}`, confirmTools: [] }))).sort((a, b) => a.id.localeCompare(b.id));
    for (const [number, session] of sessions.entries()) {
      const file = path.join(t.dirs.dataDir, `${session.id}.jsonl`);
      const rows = Array.from({ length: perSession }, (_, at) => ({ type: "message", id: `${session.id}-${at}`, parentId: null, timestamp: "2026-10-21T00:00:00Z", message: { role: "assistant", content: [{ type: "text", text: body + (number === sessions.length - 1 && at === perSession - 1 ? "NEEDLE" : "") }] } }));
      fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
      t.runtime.store.setSessionFile(session.id, file);
    }
    worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');const net=require('node:net');const {performance}=require('node:perf_hooks');const socket=net.createConnection(workerData.socket);let data='',id=0,began,timer;const samples=[];socket.on('connect',()=>send('auth',{token:workerData.token}));function send(op,params){began=performance.now();socket.write(JSON.stringify({v:workerData.version,id:String(++id),op,params})+'\\n')}socket.on('data',chunk=>{data+=chunk;for(;;){const end=data.indexOf('\\n');if(end<0)break;const reply=JSON.parse(data.slice(0,end));data=data.slice(end+1);if(!reply.ok)throw Error(JSON.stringify(reply.error));if(id===1){parentPort.postMessage({ready:true})}else{samples.push({op:id%2?'get_session':'ping',ms:performance.now()-began})}timer=setTimeout(()=>send((id+1)%2?'get_session':'ping',{session_id:workerData.sessionId}),5)}});parentPort.on('message',()=>{clearTimeout(timer);socket.end();parentPort.postMessage({samples});parentPort.close()})`, { eval: true, workerData: { socket: t.runtime.socketPath(), token: fs.readFileSync(path.join(t.runtime.controlDir(), "owner.token"), "utf8").trim(), version: PROTOCOL_VERSION, sessionId: sessions[0].id } });
    await new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
    let peakRss = process.memoryUsage().rss;
    async function search(query, full) {
      const began = performance.now(); let cursor = null; let firstProgressMs = null; let firstHitMs = null; let hits = 0; let pages = 0; let scanned = 0;
      for (;;) {
        const page = await t.client.request("search_history", { scope: "workspace_chats", query, cursor: wire(cursor) });
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
        if (firstProgressMs === null) firstProgressMs = performance.now() - began;
        if (page.hits.length && firstHitMs === null) firstHitMs = performance.now() - began;
        pages++; hits += page.hits.length; scanned += page.scanned;
        assert.deepEqual(page.sourceIssues, []);
        if (page.complete || !full && hits) return { totalMs: performance.now() - began, firstProgressMs, firstHitMs, pages, hits, scanned };
        assert.ok(page.cursor); assert.notDeepEqual(page.cursor, cursor); assert.ok(pages < 5000); cursor = page.cursor;
      }
    }
    const cold = await search("needle", true); assert.equal(cold.hits, 1);
    const noMatch = await search("absent-content", true); assert.equal(noMatch.scanned, count * perSession);
    const firstPages = [], titles = [];
    for (let n = 0; n < 30; n++) {
      firstPages.push((await search(label === "large-entry" ? "aA" : "合", false)).firstProgressMs);
      const began = performance.now();
      const summaries = await t.client.request("list_session_summaries", { scope: "workspace_chats" });
      titles.push(performance.now() - began); assert.equal(summaries.length, count);
    }
    const { samples } = await new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); worker.postMessage("stop"); });
    await new Promise(resolve => worker.once("exit", resolve)); worker = null;
    const ping = samples.filter(sample => sample.op === "ping").map(sample => sample.ms);
    const status = samples.filter(sample => sample.op === "get_session").map(sample => sample.ms);
    const measured = { label, sessions: count, messages: count * perSession, bodyMiB: count * perSession * Buffer.byteLength(body) / 1048576, cold, noMatch, firstPageP95Ms: percentile(firstPages), firstPageWithDebounceP95Ms: percentile(firstPages) + 180, titleP95Ms: percentile(titles), ping: { samples: ping.length, p95Ms: percentile(ping), maxMs: Math.max(...ping) }, status: { samples: status.length, p95Ms: percentile(status), maxMs: Math.max(...status) }, peakRssMiB: peakRss / 1048576 };
    results.push(measured);
    assert.ok(measured.titleP95Ms <= 100, `${label} 标题结果超时`);
    assert.ok(measured.ping.p95Ms <= 100 && measured.ping.maxMs <= 250, `${label} ping超时`);
    assert.ok(measured.status.p95Ms <= 100 && measured.status.maxMs <= 250, `${label} 状态读取超时`);
    if (label === "common") { assert.ok(measured.firstPageWithDebounceP95Ms <= 500); assert.ok(noMatch.totalMs <= 3000); }
  } finally { if (worker) await worker.terminate(); await t.shutdown(); }
}
const sourceDigest = createHash("sha256");
for (const file of ["packages/core/src/history-index.ts", "packages/core/src/history-search.ts", "packages/runtime/src/runtime.ts", "packages/control/src/server.ts"]) sourceDigest.update(fs.readFileSync(new URL(`../../../${file}`, import.meta.url)));
process.stdout.write(JSON.stringify({ revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), sourceSha256: sourceDigest.digest("hex"), os: os.release(), filesystem: "APFS / Apple Fabric (diskutil info /System/Volumes/Data)", node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0].model, results }, null, 2) + "\n");
