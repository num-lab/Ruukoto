import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { build as bundle } from "esbuild";
import { build as buildRenderer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { productionCspPlugin } from "../build/security.mjs";
import { TERMINAL_MODULE, vendorTerminal } from "../build/terminal.mjs";

// Note: 见 .agents/notes/implemented/architecture/2026-10-24-personal-tailscale-https.md
const builtinRequire = `import { createRequire, isBuiltin } from "node:module";
const requireBuiltin = createRequire(import.meta.url);
const require = id => {
  if (!isBuiltin(id)) throw Object.assign(new Error("MyGo 宿主拒绝加载未打包的依赖。"), { code: "desktop_module_rejected" });
  return requireBuiltin(id);
};`;

export function sidecarBuildOptions(desktop, repository, output) {
  return { entryPoints: [path.join(desktop, "src/mygo/sidecar.ts")], outfile: path.join(output, "sidecar.mjs"), bundle: true, platform: "node", format: "esm", banner: { js: builtinRequire }, target: "node24.15", plugins: [{ name: "terminal-runtime", setup: build => build.onResolve({ filter: /^node-pty$/ }, () => ({ path: TERMINAL_MODULE, external: true })) }], define: { __RUUKOTO_REPOSITORY__: JSON.stringify(repository) } };
}

const desktop = fileURLToPath(new URL("../", import.meta.url));
const repository = path.resolve(desktop, "../..");
const project = path.join(desktop, "mygo");
const output = path.join(desktop, "out/mygo");
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const mode = process.argv[2];
  if (!["build", "run"].includes(mode) || process.platform !== "darwin" || process.arch !== "arm64") {
    process.stderr.write("[ruukoto:desktop] MyGo 试验支持 macOS Apple Silicon；请运行 desktop:mygo 或 desktop:mygo:build。\n");
    process.exit(1);
  }
  try {
    execFileSync("go", ["version"], { stdio: "pipe" });
    fs.mkdirSync(output, { recursive: true });
    vendorTerminal(output);
    await bundle(sidecarBuildOptions(desktop, repository, output));
    await buildRenderer({
      configFile: false,
      root: path.join(desktop, "src/renderer"),
      plugins: [react(), tailwindcss(), productionCspPlugin()],
      build: { outDir: path.join(output, "renderer"), emptyOutDir: true, target: "safari16" },
    });
    const node = fs.realpathSync(process.execPath);
    fs.writeFileSync(path.join(output, "launch.json"), `${JSON.stringify({ node, credentialNamespace: mode === "run" ? "development" : "production", nodeSha256: createHash("sha256").update(fs.readFileSync(node)).digest("hex") })}\n`);
    execFileSync("go", ["tool", "mygo", "build", "-skip-dmg", "-platform", "darwin/arm64"], { cwd: project, env: { ...process.env, CGO_ENABLED: "1" }, stdio: "inherit" });
    const app = path.join(repository, "dist/mygo/darwin-arm64/Ruukoto MyGo.app");
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--options", "runtime", app], { stdio: "inherit" });
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
    if (mode === "run") {
      const child = spawn(path.join(app, "Contents/MacOS/Ruukoto MyGo"), [], { stdio: "inherit" });
      for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { child.kill(signal); });
      child.on("exit", code => { process.exitCode = code ?? 1; });
    }
  } catch (error) {
    process.stderr.write(`[ruukoto:desktop] MyGo 构建或启动失败：${error instanceof Error ? error.message : String(error)} 请确认 Go ≥ 1.27.1 与 Node ≥ 24.15 可用。\n`);
    process.exitCode = 1;
  }
}
