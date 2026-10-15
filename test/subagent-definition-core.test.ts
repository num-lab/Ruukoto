import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Db, SCHEMA_VERSION } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import { canonicalJson, sha256 } from "@ruukoto/core/import-files.ts";
import { SubAgentDefinitionError, requireSubAgentDefinition, subAgentDefinitionDigest, subAgentDefinitionFromJson,
  validateSubAgentDefinition, validateSubAgentRoleCatalog } from "@ruukoto/core/subagent-definition.ts";
import { fixtureSubAgentDefinition } from "./helpers/subagent-definition.ts";

test("子代理快照严格核实完整字段、宿主用途与摘要", () => {
  const definition = fixtureSubAgentDefinition();
  assert.deepEqual(subAgentDefinitionFromJson(JSON.stringify(definition)), definition);
  const hostContent = { ...definition, kind: "host_review" as const, name: "github-review" };
  const { digest: _digest, ...content } = hostContent;
  const host = { ...content, digest: subAgentDefinitionDigest(content) };
  assert.deepEqual(validateSubAgentDefinition(host), host);
  const { raw: _raw, ...missingRaw } = definition;
  for (const corrupt of ["broken", {}, missingRaw, { ...definition, body: "被修改的正文" }, { ...definition, kind: "main" },
    { ...definition, tools: [1] }, { ...definition, permissions: { mode: "plan", protectSource: false } }, { ...definition, extra: true }]) {
    assert.throws(() => validateSubAgentDefinition(corrupt), { code: "definition_corrupt" });
  }
  assert.throws(() => subAgentDefinitionFromJson("{"), SubAgentDefinitionError);
  assert.throws(() => validateSubAgentDefinition(null), { code: "definition_missing" });
  assert.throws(() => requireSubAgentDefinition({ definition: null }), { code: "definition_missing" });
});

test("子代理目录快照连诊断固定，摘要或角色损坏即拒绝", () => {
  const content = { roles: [fixtureSubAgentDefinition()], diagnostics: [{ name: "broken", code: "invalid_frontmatter", message: "修正文件" }] };
  const catalog = { ...content, digest: sha256(canonicalJson(content)) };
  assert.deepEqual(validateSubAgentRoleCatalog(catalog), catalog);
  for (const corrupt of [{ ...catalog, diagnostics: [] }, { ...catalog, roles: [{ ...content.roles[0], body: "修改正文" }] },
    { ...catalog, diagnostics: [{ ...content.diagnostics[0], code: 1 }] }]) {
    assert.throws(() => validateSubAgentRoleCatalog(corrupt), { code: "definition_corrupt" });
  }
});

test("子代理定义随冷读取与关闭保留；坏行仍可查身份且不能执行或再次写入", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-definition-"));
  let db = new Db(root), store = new Store(db);
  try {
    const stat = fs.statSync(root), project = store.withTx(() => store.createProject("角色快照"));
    const createSession = (piSessionId: string) => store.withTx(() => store.createSession({ projectId: project.id, cwd: root, cwdReal: root,
      cwdDev: stat.dev, cwdIno: stat.ino, piSessionId, confirmTools: [] }));
    const parent = createSession("parent"), child = createSession("child"), definition = fixtureSubAgentDefinition();
    const agent = { id: "sub", definition, parentSessionId: parent.id, sessionId: child.id, workDir: root, activeWorkId: null,
      currentTaskId: null, state: "idle" as const, closedAt: null, closedBy: null, createdAt: parent.createdAt };
    store.withTx(() => store.insertSubAgent(agent));
    assert.throws(() => store.insertSubAgent({ ...agent, id: "missing", definition: null }), { code: "definition_missing" });
    assert.equal(db.prepare("SELECT definition FROM sub_agents WHERE id = 'sub'").get()!.definition, JSON.stringify(definition));
    store.withTx(() => store.closeSubAgent(agent.id, parent.createdAt, "owner"));
    db.close();
    db = new Db(root);
    store = new Store(db);
    assert.deepEqual(requireSubAgentDefinition(store.getSubAgent(agent.id)!), definition);
    assert.equal(store.getSubAgent(agent.id)!.closedBy, "owner");
    db.prepare("UPDATE sub_agents SET definition = '{' WHERE id = 'sub'").run();
    const broken = store.listSubAgents()[0];
    assert.equal(broken.id, agent.id);
    assert.equal(broken.definition, null);
    assert.equal(broken.definitionError, "definition_corrupt");
    assert.equal(store.getSessionIdentity(child.id)!.kind, "subagent");
    assert.throws(() => requireSubAgentDefinition(broken), { code: "definition_corrupt" });
    assert.throws(() => store.insertSubAgent({ ...broken, id: "broken-copy" }), { code: "definition_corrupt" });
    assert.equal(Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()!.value), SCHEMA_VERSION);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
