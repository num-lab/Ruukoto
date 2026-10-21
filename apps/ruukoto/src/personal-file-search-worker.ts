/** 检索只在原生执行单元内读取资料，宿主只接收有界原字节和结果。
 * Note: 见 .agents/notes/implemented/feature/2026-10-21-personal-file-search.md
 */
import { runFileSearch, type SearchRoot } from "@ruukoto/agent/tool-worker/file-search.ts";
import { fileSearchParams, type FileSearchName } from "@ruukoto/agent/file-search.ts";
import { killProcessGroup } from "@ruukoto/agent/managed-processes.ts";

const send = (value: object) => process.stdout.write(JSON.stringify(value) + "\n");
try {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("input_limit");
    chunks.push(Buffer.from(chunk));
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { name: FileSearchName; params: Record<string, unknown>; cwd: string; executable?: string; roots: SearchRoot[] | null };
  if (!["list_files", "search_files"].includes(input.name) || typeof input.cwd !== "string" || input.roots !== null && !Array.isArray(input.roots)) throw new Error("input_invalid");
  fileSearchParams(input.name, input.params);
  const result = await runFileSearch({ ...input, signal: new AbortController().signal,
    onData: (stream, bytes) => send({ type: "data", stream, bytes: bytes.toString("base64") }),
    track: () => undefined, stop: killProcessGroup });
  send({ type: "result", result });
} catch {
  send({ type: "failed", code: "file_search_worker_failed" });
  process.exitCode = 1;
}
