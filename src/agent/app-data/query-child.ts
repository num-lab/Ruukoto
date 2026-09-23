/**
 * 应用数据查询子进程固定入口（issue 02）：只读执行有界查询，用于真实的查询
 * 截止——Node 22.19 的 DatabaseSync 同步执行，timeout 只是数据库锁等待上限，
 * 同进程 Promise.race 不能终止执行中的查询。超时由宿主 SIGKILL 回收。
 *
 * 协议：stdin 一行 JSON 请求 → stdout 一行 JSON 响应 → 退出。
 * 只打开 main.db 的只读连接（query_only），不传 owner token、模型凭据或核心
 * 数据库句柄；请求/响应帧有界。只读查询，所有写事务留在宿主。
 */

import { AppDataStore } from "./store.ts";
import { runQuery, validateQueryRequest, type QueryResponse } from "./query.ts";
import { MAX_FRAME_BYTES } from "../tool-worker/protocol.ts";

function respond(payload: unknown): void {
  const line = JSON.stringify(payload);
  if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
    process.stdout.write(
      JSON.stringify({ ok: false, code: "result_too_large", error: "查询结果超过传输上限，请缩小投影或分页" }) + "\n",
    );
    return;
  }
  process.stdout.write(line + "\n");
}

function main(): void {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    input += chunk;
    if (Buffer.byteLength(input, "utf8") > MAX_FRAME_BYTES) {
      respond({ ok: false, code: "request_too_large", error: "查询请求超过帧上限" });
      process.exit(0);
    }
  });
  process.stdin.on("end", () => {
    try {
      const raw = JSON.parse(input) as Record<string, unknown>;
      // 测试挂点（仅宿主测试经 RunnerOptions 注入；工具调用路径不产生该字段）
      const stallMs = Number(raw.__stallMs ?? 0);
      delete raw.__stallMs;
      const finish = (): void => {
        const request = validateQueryRequest(raw); // 子进程再次校验
        const dbPath = process.env.APP_DATA_DB_FILE;
        if (!dbPath) {
          respond({ ok: false, code: "missing_db", error: "缺少应用数据库路径" });
          return;
        }
        const store = new AppDataStore(dbPath, { readOnly: true });
        try {
          const result: QueryResponse = runQuery(store, request);
          respond(result);
        } finally {
          store.close();
        }
      };
      if (stallMs > 0) {
        setTimeout(() => {
          try {
            finish();
          } catch (err) {
            respond({ ok: false, code: (err as { code?: string }).code ?? "query_failed", error: (err as Error).message });
          }
        }, stallMs);
        return;
      }
      finish();
    } catch (err) {
      respond({
        ok: false,
        code: (err as { code?: string }).code ?? "query_failed",
        error: (err as Error).message,
      });
    }
  });
}

main();
