import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { build as bundle } from "esbuild";
import { build as buildRenderer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { productionCspPlugin } from "../build/security.mjs";

const desktop = fileURLToPath(new URL("../", import.meta.url));
const repository = path.resolve(desktop, "../..");
const project = path.join(desktop, "mygo");
const output = path.join(desktop, "out/mygo");
const mode = process.argv[2];
if (!["build", "run"].includes(mode) || process.platform !== "darwin" || process.arch !== "arm64") {
  process.stderr.write("[ruukoto:desktop] MyGo 试验支持 macOS Apple Silicon；请运行 desktop:mygo 或 desktop:mygo:build。\n");
  process.exit(1);
}
try {
  execFileSync("go", ["version"], { stdio: "pipe" });
  fs.mkdirSync(output, { recursive: true });
  await bundle({ entryPoints: [path.join(desktop, "src/mygo/sidecar.ts")], outfile: path.join(output, "sidecar.mjs"), bundle: true, platform: "node", format: "esm", target: "node22.19", define: { __RUUKOTO_REPOSITORY__: JSON.stringify(repository) } });
  await buildRenderer({
    configFile: false,
    root: path.join(desktop, "src/renderer"),
    plugins: [react(), tailwindcss(), productionCspPlugin()],
    build: { outDir: path.join(output, "renderer"), emptyOutDir: true, target: "safari16" },
  });
  fs.writeFileSync(path.join(output, "launch.json"), `${JSON.stringify({ node: process.execPath })}\n`);
  execFileSync("go", ["tool", "mygo", "build", "-skip-dmg", "-platform", "darwin/arm64"], { cwd: project, stdio: "inherit" });
  const app = path.join(repository, "dist/mygo/darwin-arm64/Ruukoto MyGo.app");
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  if (mode === "run") {
    const child = spawn(path.join(app, "Contents/MacOS/Ruukoto MyGo"), [], { stdio: "inherit" });
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { child.kill(signal); });
    child.on("exit", code => { process.exitCode = code ?? 1; });
  }
} catch (error) {
  process.stderr.write(`[ruukoto:desktop] MyGo 构建或启动失败：${error instanceof Error ? error.message : String(error)} 请确认 Go ≥ 1.27.1 与 Node ≥ 22.19 可用。\n`);
  process.exitCode = 1;
}
