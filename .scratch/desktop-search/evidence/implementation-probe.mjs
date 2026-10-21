// 只访问临时合成档案；独立线程持续读取同进程 socket，测量检索对后台响应的阻塞。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { Db } from "@ruukoto/core/db.ts";
import { searchWorkspaceHistory } from "@ruukoto/core/history-search.ts";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-search-implemented-"));
const record = (id, text) => ({ type: "message", id, parentId: null, timestamp: "2026-10-21T00:00:00Z", message: { role: "assistant", content: [{ type: "text", text }] } });
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? 0;
const results = [];
try {
  for (const [label, count, perSession, body] of [["common", 100, 100, "合成Ab".repeat(128)], ["growth", 1000, 100, "合成Ab".repeat(64)], ["large-entry", 1, 1, "Aa".repeat(4 * 1024 * 1024)]]) {
    const dataDir = path.join(dir, label); fs.mkdirSync(dataDir);
    const db = new Db(dataDir);
    const candidates = [];
    let jsonlBytes = 0;
    for (let n = 0; n < count; n++) {
      const sessionId = `session-${String(n).padStart(4, "0")}`;
      const filePath = path.join(dataDir, `${sessionId}.jsonl`);
      const rows = Array.from({ length: perSession }, (_, at) => record(`${sessionId}-${at}`, body + (n === count - 1 && at === perSession - 1 ? "NEEDLE" : "")));
      const text = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
      jsonlBytes += Buffer.byteLength(text); fs.writeFileSync(filePath, text);
      candidates.push({ sessionId, filePath, historyExpected: true });
    }
    const server = net.createServer(socket => socket.on("data", data => { db.prepare("SELECT COUNT(*) FROM history_index_state").get(); socket.write(data); }));
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads'); const net=require('node:net'); const {performance}=require('node:perf_hooks'); const c=net.createConnection(workerData); let began; const samples=[]; let timer; c.on('connect',()=>{parentPort.postMessage({ready:true});ping()}); function ping(){began=performance.now();c.write('ping\\n')} c.on('data',()=>{samples.push(performance.now()-began);timer=setTimeout(ping,5)}); parentPort.on('message',()=>{clearTimeout(timer);c.end();parentPort.postMessage({samples});parentPort.close()});`, { eval: true, workerData: { host: "127.0.0.1", port: server.address().port } });
    await new Promise(resolve => worker.once("message", resolve));
    let peakRss = process.memoryUsage().rss;
    async function search(query, full) {
      const began = performance.now(); let cursor; let pages = 0; let scanned = 0; let firstHitMs = null; let firstProgressMs = null; let hits = 0;
      for (;;) {
        const page = await searchWorkspaceHistory(db, candidates, { query, cursor }); pages++; scanned += page.scanned; hits += page.hits.length;
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
        if (firstProgressMs === null) firstProgressMs = performance.now() - began;
        if (page.hits.length && firstHitMs === null) firstHitMs = performance.now() - began;
        assert.equal(page.sourceIssues.length, 0);
        if (page.complete || !full && hits) return { ms: performance.now() - began, firstProgressMs, firstHitMs, pages, hits, scanned };
        assert.ok(page.cursor); assert.notDeepEqual(page.cursor, cursor); assert.ok(pages < 5000); cursor = page.cursor;
      }
    }
    const coldLastHit = await search("needle", true);
    assert.equal(coldLastHit.hits, 1);
    const hotNoMatch = await search("absent-content", true);
    assert.equal(hotNoMatch.scanned, count * perSession);
    const first = [];
    for (let repetition = 0; repetition < 30; repetition++) first.push((await search(label === "large-entry" ? "aA" : "合", false)).firstProgressMs);
    const samples = await new Promise(resolve => { worker.once("message", value => resolve(value.samples)); worker.postMessage("stop"); });
    await new Promise(resolve => worker.once("exit", resolve));
    await new Promise(resolve => server.close(resolve));
    results.push({ label, sessions: count, messages: count * perSession, bodyMiB: count * perSession * Buffer.byteLength(body) / 1048576, jsonlMiB: jsonlBytes / 1048576, coldLastHit, hotNoMatch, firstPageP95Ms: percentile(first, .95), pingSamples: samples.length, pingP95Ms: percentile(samples, .95), pingMaxMs: Math.max(...samples), peakRssMiB: peakRss / 1048576 });
    db.close();
  }
  process.stdout.write(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0].model, results }, null, 2) + "\n");
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
