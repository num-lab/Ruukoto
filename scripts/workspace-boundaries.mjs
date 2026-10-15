import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
// Note: 见 .agents/notes/implemented/architecture/2026-10-11-in-repo-workspace-packages.md
const layers = {
  core: [],
  agent: ["core"],
  channels: ["core", "agent"],
  runtime: ["core", "agent", "channels"],
  control: ["core"],
  view: ["core", "control"],
  tui: ["core", "agent", "runtime", "control", "view"],
};

function owner(file) {
  const rel = path.relative(root, file).split(path.sep).join("/");
  return /^(packages|apps)\/([^/]+)\//.exec(rel)?.slice(1);
}

export default {
  rules: {
    imports: {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          relative: "跨包引用 {{target}} 必须使用包名与 exports。",
          undeclared: "{{dep}} 未在本包声明为{{kind}}依赖。",
          layer: "{{from}} 不得以{{kind}}引用 {{to}}；请注入回调或移动共用实现。",
          dynamic: "包内动态 import 必须使用静态模块字符串。",
        },
      },
      create(context) {
        const file = context.filename;
        const own = owner(file);
        if (!own) return {};
        const [kind, name] = own;
        const manifest = JSON.parse(fs.readFileSync(path.join(root, kind, name, "package.json"), "utf8"));
        const check = (node, source, typeOnly = false) => {
          if (!source || typeof source.value !== "string") {
            context.report({ node, messageId: "dynamic" });
            return;
          }
          const spec = source.value;
          if (spec.startsWith("node:")) return;
          if (spec.startsWith(".") || path.isAbsolute(spec)) {
            const target = owner(path.resolve(path.dirname(file), spec));
            if (!target || target.join("/") !== own.join("/")) context.report({ node, messageId: "relative", data: { target: spec } });
            return;
          }
          const dep = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
          if (dep === manifest.name) return;
          if (!manifest.dependencies?.[dep] && !((typeOnly || (kind === "apps" && name === "desktop")) && manifest.devDependencies?.[dep])) {
            context.report({ node, messageId: "undeclared", data: { dep, kind: typeOnly ? "类型" : "运行时" } });
          }
          if (dep.startsWith("@ruukoto/")) {
            const to = dep.slice("@ruukoto/".length);
            const allowed = kind === "apps" || (typeOnly && name !== "core") || layers[name]?.includes(to);
            if (!allowed) context.report({ node, messageId: "layer", data: { from: name, to, kind: typeOnly ? "类型" : "运行时值" } });
          } else if (dep === "ruukoto" || dep === "ruukoto-code") {
            context.report({ node, messageId: "layer", data: { from: name, to: dep, kind: typeOnly ? "类型" : "运行时值" } });
          }
        };
        const declaration = (node) => {
          if (!node.source) return;
          const typeOnly = node.importKind === "type" || node.exportKind === "type" ||
            (node.specifiers?.length > 0 && node.specifiers.every((s) => s.importKind === "type" || s.exportKind === "type"));
          check(node, node.source, typeOnly);
        };
        return {
          ImportDeclaration: declaration,
          ExportNamedDeclaration: declaration,
          ExportAllDeclaration: declaration,
          ImportExpression: (node) => check(node, node.source),
          TSImportType: (node) => check(node, node.source, true),
        };
      },
    },
  },
};
