import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { startTestRuntime } from "../../../../test/helpers/testkit.ts";
import type { OpResult } from "@ruukoto/control/ops.ts";

const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const kit = await startTestRuntime("directory-ui", () => { throw new Error("验收不调用模型"); }, { workDirs: 3 });
const folder = path.join(kit.work[0], "folder");
fs.mkdirSync(folder);
for (let i = 0; i < 405; i++) {
  const name = `file-${String(i).padStart(4, "0")}.txt`;
  fs.writeFileSync(path.join(kit.work[0], name), `root ${i}\n`);
  fs.writeFileSync(path.join(folder, name), `nested ${i}\n`);
}
for (const cwd of kit.work.slice(1)) execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd });
fs.writeFileSync(path.join(kit.work[1], "README.md"), "# 分页与 Git 查询验收\n");
execFileSync("git", ["add", "README.md"], { cwd: kit.work[1] });
execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "验收提交"], { cwd: kit.work[1] });
const sessions = [];
for (const [i, cwd] of kit.work.entries()) {
  const opened = await kit.client.request<OpResult<"open_workspace">>("open_workspace", { cwd, request_id: `fixture-${i}` });
  sessions.push({ id: opened.session.id, name: ["普通目录", "Git 仓库", "空仓库"][i] });
}
const calls: { op: string; params: Record<string, unknown>; elapsedMs?: number }[] = [];
const server = await createServer({ configFile: false, root: repository, plugins: [react(), tailwindcss(), {
  name: "directory-acceptance-control",
  configureServer(vite) {
    vite.middlewares.use((request, response, next) => {
      if (!request.url?.startsWith("/_acceptance/")) { next(); return; }
      const handle = async () => {
        response.setHeader("Content-Type", "application/json");
        if (request.url === "/_acceptance/bootstrap") return { sessions, snapshot: await kit.client.request("connect") };
        if (request.url === "/_acceptance/metrics") return { calls, modelCalls: kit.server.calls.length };
        if (request.url === "/_acceptance/change") {
          fs.writeFileSync(path.join(kit.work[0], "000-added.txt"), "自动刷新验收\n");
          fs.writeFileSync(path.join(folder, "000-added.txt"), "子目录刷新验收\n");
          fs.rmSync(path.join(kit.work[0], "file-0404.txt"), { force: true });
          return { changed: true };
        }
        if (request.url !== "/_acceptance/request") throw new Error("未知验收操作");
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const { op, params } = JSON.parse(Buffer.concat(chunks).toString()) as { op: string; params: Record<string, unknown> };
        if (!["work_list", "list_workspace_files", "read_workspace_file", "read_workspace_git"].includes(op)) throw new Error(`验收未开放操作 ${op}`);
        const call = { op, params, elapsedMs: 0 }, started = performance.now(); calls.push(call);
        let value: unknown;
        try { value = await kit.client.request(op, params); }
        catch (error) {
          const failure = error as Error & { code?: string };
          return { ok: false, error: { code: failure.code ?? "fixture_failed", outcome: "rejected", message: failure.message } };
        } finally { call.elapsedMs = performance.now() - started; }
        return { ok: true, value };
      };
      void handle().then(value => response.end(JSON.stringify(value)), error => { response.statusCode = 500; response.end(JSON.stringify({ error: String(error) })); });
    });
  },
}], server: { host: "127.0.0.1", port: 0, strictPort: false }, appType: "spa" });
await server.listen();
const address = server.httpServer!.address();
if (!address || typeof address === "string") throw new Error("验收服务地址不可用");
process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${address.port}/.scratch/owner-operation-scope/evidence/2026-10-24-pages/ui.html`, temporaryRoot: kit.dirs.root }) + "\n");
let closing = false;
async function close() { if (closing) return; closing = true; await server.close(); await kit.shutdown(); }
process.on("SIGINT", () => { void close(); });
process.on("SIGTERM", () => { void close(); });
