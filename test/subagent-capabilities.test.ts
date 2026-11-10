import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSubAgentRole } from "@ruukoto/agent/subagent-roles.ts";
import { subAgentAccessPolicy, subAgentSourceProfile } from "@ruukoto/agent/subagent-capabilities.ts";
import { sourceAllows } from "@ruukoto/agent/tool-availability.ts";
import type { WorkflowSource } from "@ruukoto/core/workflow.ts";

test("角色只能沿来源继承或收紧权限，保护与完全访问冲突", () => {
  for (const source of ["confirm", "auto-review", "full_access"] as const) {
    for (const requested of ["inherit", "confirm", "auto-review", "full_access"] as const) {
      const definition = parseSubAgentRole("policy", `---\ndescription: 权限检查\npermissions:\n  mode: ${requested}\n---\n执行要求。`);
      const rejected = requested === "full_access" && source !== "full_access" || requested === "auto-review" && source === "confirm";
      if (rejected) assert.throws(() => subAgentAccessPolicy(source, definition), { code: "permission_increase" });
      else assert.deepEqual(subAgentAccessPolicy(source, definition), { accessMode: requested === "inherit" ? source : requested, protectSource: false });
    }
  }
  const protectedRole = parseSubAgentRole("protected", "---\ndescription: 保护来源\npermissions:\n  protect_source: true\n---\n执行要求。");
  assert.throws(() => subAgentAccessPolicy("full_access", protectedRole), { code: "source_protection_conflict" });
  const reviewer = parseSubAgentRole("review", "---\ndescription: 受限检查\npermissions:\n  mode: confirm\n  protect_source: true\n---\n执行要求。");
  assert.deepEqual(subAgentAccessPolicy("full_access", reviewer), { accessMode: "confirm", protectSource: true });
  assert.deepEqual(subAgentAccessPolicy("full_access", protectedRole, true), { accessMode: "confirm", protectSource: true });
});

test("开发会话委派继承来源编码能力，普通协作工具与工作流归属分别收窄", () => {
  const source: WorkflowSource = { product: "ruukoto", projectId: "project", sessionId: "parent", taskId: "task", permissionVersion: 1,
    accessMode: "confirm", grantedPaths: [], capabilities: ["coding", "subagent"], references: [],
    authority: { toolClass: "dev", categories: ["coding", "subagent", "browser", "workflow"], grantIds: [], configuration: "test", workspace: { path: "/work", dev: 1, ino: 1 } } };
  const ordinary = subAgentSourceProfile(source), workflow = subAgentSourceProfile(source, { workflow: true });
  assert.deepEqual(ordinary.categories, ["coding"]);
  assert.equal(sourceAllows(ordinary, "bash"), true);
  assert.equal(sourceAllows(ordinary, "subagent_message"), true);
  assert.equal(sourceAllows(workflow, "subagent_message"), false);
  for (const name of ["subagent_delegate", "workflow_start", "browser"]) assert.equal(sourceAllows(ordinary, name), false, name);
  assert.deepEqual(subAgentSourceProfile(source, { verify: true }).categories, ["coding"]);
});
