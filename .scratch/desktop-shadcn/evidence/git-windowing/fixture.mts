import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../../../..");
const server = await createServer({ configFile: false, root: here, plugins: [react(), tailwindcss()], server: { host: "127.0.0.1", port: 0, fs: { allow: [repository] } }, appType: "spa" });
await server.listen();
const address = server.httpServer?.address();
if (!address || typeof address === "string") throw new Error("fixture address unavailable");
process.stdout.write(`http://127.0.0.1:${address.port}/\n`);
process.on("SIGTERM", () => void server.close().then(() => process.exit(0)));
