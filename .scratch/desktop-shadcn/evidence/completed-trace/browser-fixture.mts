import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
const root = process.cwd(), entry = resolve(root, "apps/desktop/src/renderer/__trace_fixture.tsx");
const server = await createServer({ configFile: false, root: resolve(root, "apps/desktop/src/renderer"), plugins: [react(), tailwindcss(), { name: "trace-fixture", resolveId(id) { if (id === "/__trace_fixture.tsx" || id === entry) return entry; }, async load(id) { if (id === entry) { const source = resolve(root, ".scratch/desktop-shadcn/evidence/completed-trace/browser-fixture.tsx"); this.addWatchFile(source); return readFile(source, "utf8"); } }, configureServer(vite) { vite.middlewares.use(async (req, res, next) => { if (req.url !== "/") { next(); return; } res.setHeader("Content-Type", "text/html"); res.end(await vite.transformIndexHtml("/", '<!doctype html><html class="dark"><body style="margin:0"><div id="root"></div><script type="module" src="/__trace_fixture.tsx"></script></body></html>')); }); } }], server: { host: "127.0.0.1", port: 63060, strictPort: true }, appType: "custom" });
await server.listen(); const address = server.httpServer!.address(); if (!address || typeof address === "string") throw new Error("fixture address"); process.stdout.write(`http://127.0.0.1:${address.port}\n`);
process.on("SIGTERM", () => void server.close().then(() => process.exit()));
