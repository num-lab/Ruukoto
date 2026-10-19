import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd(), entry = resolve(root, "apps/desktop/src/renderer/__loading_position.tsx");
const assets = resolve(root, "apps/desktop/out/mygo/renderer/assets");
const server = await createServer({ configFile: false, root: resolve(root, "apps/desktop/src/renderer"), plugins: [react(), { name: "production-loading-position", resolveId(id) { if (id === "/__loading_position.tsx" || id === entry) return entry; }, async load(id) { if (id === entry) return (await readFile(resolve(root, ".scratch/desktop-shadcn/evidence/startup-loading-migration/browser-fixture.tsx"), "utf8")).replace('import "/style.css";', "").replace("8000", "60000"); }, configureServer(vite) { vite.middlewares.use(async (req, res, next) => { if (req.url === "/production.css") { const css = (await readdir(assets)).find(file => file.endsWith(".css")); if (!css) throw new Error("缺少 MyGo 构建 CSS"); res.setHeader("Content-Type", "text/css"); res.end(await readFile(resolve(assets, css))); return; } if (req.url?.split("?")[0] !== "/") { next(); return; } res.setHeader("Content-Type", "text/html"); res.end(await vite.transformIndexHtml("/", '<!doctype html><html lang="zh-CN"><head><link rel="stylesheet" href="/production.css"></head><body><div id="root"></div><script type="module" src="/__loading_position.tsx"></script></body></html>')); }); } }], server: { host: "127.0.0.1", port: 63062, strictPort: true }, appType: "custom" });
await server.listen();
process.stdout.write("http://127.0.0.1:63062/\n");
process.on("SIGTERM", () => void server.close().then(() => process.exit()));
