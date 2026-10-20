import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd(), entry = resolve(root, "apps/desktop/src/renderer/__startup_fixture.tsx");
const server = await createServer({ configFile: false, root: resolve(root, "apps/desktop/src/renderer"), plugins: [react(), tailwindcss(), { name: "startup-fixture", resolveId(id) { if (id === "/__startup_fixture.tsx" || id === entry) return entry; }, async load(id) { if (id === entry) { const source = resolve(root, ".scratch/desktop-shadcn/evidence/startup-loading-migration/browser-fixture.tsx"); this.addWatchFile(source); return readFile(source, "utf8"); } }, configureServer(vite) { vite.middlewares.use(async (req, res, next) => { if (req.url?.split("?")[0] !== "/") { next(); return; } res.setHeader("Content-Type", "text/html"); res.end(await vite.transformIndexHtml("/", '<!doctype html><html lang="zh-CN"><body><div id="root"></div><script type="module" src="/__startup_fixture.tsx"></script></body></html>')); }); } }], server: { host: "127.0.0.1", port: 63061, strictPort: true }, appType: "custom" });
await server.listen();
process.stdout.write("http://127.0.0.1:63061/\n");
process.on("SIGTERM", () => void server.close().then(() => process.exit()));
