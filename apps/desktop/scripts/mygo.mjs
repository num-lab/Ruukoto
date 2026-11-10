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
import { devProfileFor } from "@ruukoto/tui/dev.ts";
import { profileChildEnv } from "@ruukoto/core/profile.ts";

const builtinRequire = `import { createRequire, isBuiltin } from "node:module";
const requireBuiltin = createRequire(import.meta.url);
const require = id => {
  if (!isBuiltin(id)) throw Object.assign(new Error("MyGo 宿主拒绝加载未打包的依赖。"), { code: "desktop_module_rejected" });
  return requireBuiltin(id);
};`;

export function sidecarBuildOptions(desktop, repository, output) {
  return { entryPoints: [path.join(desktop, "src/mygo/sidecar.ts")], outfile: path.join(output, "sidecar.mjs"), bundle: true, platform: "node", format: "esm", banner: { js: builtinRequire }, target: "node24.15", plugins: [{ name: "terminal-runtime", setup: build => build.onResolve({ filter: /^node-pty$/ }, () => ({ path: TERMINAL_MODULE, external: true })) }], define: { __RUUKOTO_REPOSITORY__: JSON.stringify(repository), __RUUKOTO_EXCLUSIVE_FS_SOURCE__: JSON.stringify(fs.readFileSync(path.join(repository, "packages/core/src/exclusive-fs.py"), "utf8")) } };
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
    const development = mode === "run";
    const identity = createHash("sha256").update(fs.realpathSync(repository)).digest("hex").slice(0, 16);
    const name = development ? `ruukoto Development ${identity}` : "ruukoto";
    const identifier = development ? `dev.ruukoto.desktop.mygo.development.${identity}` : "dev.ruukoto.desktop.mygo";
    const selection = development ? devProfileFor(repository) : undefined;
    const profileEnv = selection ? profileChildEnv(selection, {}) : undefined;
    fs.writeFileSync(path.join(output, "launch.json"), `${JSON.stringify({ node, mode: development ? "development" : "production", name, identifier, profileEnv, nodeSha256: createHash("sha256").update(fs.readFileSync(node)).digest("hex") })}\n`);
    const buildSource = fs.mkdtempSync(path.join(output, "build-source-"));
    try {
      fs.cpSync(project, buildSource, { recursive: true });
      const config = JSON.parse(fs.readFileSync(path.join(project, "mygo.json"), "utf8"));
      fs.writeFileSync(path.join(buildSource, "mygo.json"), JSON.stringify({ ...config, name, identifier, frontendDist: path.join(output, "renderer"), bindings: path.join(output, "bindings.ts"), resources: [path.join(output, "sidecar.mjs"), path.join(output, "launch.json"), path.join(output, "vendor")], out: path.join(repository, "dist/mygo") }));
      execFileSync("go", ["tool", "mygo", "build", "-skip-dmg", "-platform", "darwin/arm64", ...(development ? ["-debug"] : [])], { cwd: buildSource, env: { ...process.env, CGO_ENABLED: "1" }, stdio: "inherit" });
    } finally { fs.rmSync(buildSource, { recursive: true, force: true }); }
    const app = path.join(repository, `dist/mygo/darwin-arm64/${name}.app`);
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--options", "runtime", app], { stdio: "inherit" });
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
    if (mode === "run") {
      const child = spawn(path.join(app, `Contents/MacOS/${name}`), [], { stdio: "inherit" });
      for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { child.kill(signal); });
      child.on("exit", code => { process.exitCode = code ?? 1; });
    }
  } catch (error) {
    process.stderr.write(`[ruukoto:desktop] MyGo 构建或启动失败：${error instanceof Error ? error.message : String(error)} 请确认 Go ≥ 1.27.1 与 Node ≥ 24.15 可用。\n`);
    process.exitCode = 1;
  }
}
