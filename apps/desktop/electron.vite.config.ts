import { fileURLToPath } from "node:url";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { productionCspPlugin } from "./build/security.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
// Note: 见 .agents/notes/proposed/architecture/2026-10-15-desktop-client.md
export default defineConfig(({ command }) => ({
  main: {
    define: { __RUUKOTO_REPOSITORY__: JSON.stringify(repository) },
    build: { externalizeDeps: false, rollupOptions: { output: { format: "es", entryFileNames: "index.js", inlineDynamicImports: true } } },
  },
  preload: {
    build: { externalizeDeps: false, rollupOptions: { output: { format: "cjs", entryFileNames: "index.cjs", inlineDynamicImports: true } } },
  },
  renderer: {
    plugins: [react(), tailwindcss(), productionCspPlugin()],
    ...(command === "serve" ? { html: { cspNonce: process.env.RUUKOTO_DESKTOP_DEV_NONCE } } : {}),
  },
}));
