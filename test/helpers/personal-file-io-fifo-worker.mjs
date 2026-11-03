import { parentPort } from "node:worker_threads";
import * as fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
const hold = process.env.RK_FILE_IO_HOLD;
const fifo = process.env.RK_FILE_IO_FIFO;
const stallMs = Number(process.env.RK_FILE_IO_STALL_MS ?? 0);
const marker = process.env.RK_FILE_IO_MARKER;
const bundle = process.env.RK_FILE_IO_BUNDLE;
const phase = process.env.RK_FILE_IO_PHASE;
parentPort.once("message", async job => {
  if (hold && marker && job?.input?.path === hold && (phase === undefined || job?.phase === phase)) {
    fs.writeFileSync(`${marker}.${job.id}`, "entered");
    fs.writeFileSync(marker, "entered");
    if (stallMs > 0) await delay(stallMs);
    else if (fifo) {
      const reader = fs.openSync(fifo, fs.constants.O_RDONLY);
      try { fs.readSync(reader, Buffer.alloc(1), 0, 1, null); }
      finally { fs.closeSync(reader); }
    }
  }
  await import(bundle);
  parentPort.emit("message", job);
});
