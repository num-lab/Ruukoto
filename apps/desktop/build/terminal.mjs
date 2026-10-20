import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

export const TERMINAL_MODULE = "./vendor/node-pty/lib/index.js";

// Note: 见 .agents/notes/implemented/feature/2026-10-20-desktop-integrated-terminal.md
export function vendorTerminal(output) {
  const source = path.dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
  const destination = path.join(output, "vendor/node-pty");
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  for (const name of ["lib", "package.json", "LICENSE"]) fs.cpSync(path.join(source, name), path.join(destination, name), { recursive: true, filter: file => !/\.(?:test\.js|map)$/.test(file) });
  const native = ["build/Release", `prebuilds/${process.platform}-${process.arch}`].find(directory => fs.existsSync(path.join(source, directory, "pty.node")));
  if (!native) throw new Error("node-pty 原生依赖缺失；请重新运行 npm run setup。");
  const directory = path.join(destination, "build/Release");
  fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(path.join(source, native, "pty.node"), path.join(directory, "pty.node"));
  if (process.platform === "darwin") {
    fs.copyFileSync(path.join(source, native, "spawn-helper"), path.join(directory, "spawn-helper"));
    fs.chmodSync(path.join(directory, "spawn-helper"), 0o755);
  }
}
