import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSubAgentRole } from "@ruukoto/agent/subagent-roles.ts";
import { subAgentAccessPolicy, subAgentSourceProfile } from "@ruukoto/agent/subagent-capabilities.ts";
import { sourceAllows } from "@ruukoto/agent/tool-availability.ts";
import type { AccessMode } from "@ruukoto/core/types.ts";
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

test("main 的受控委派提供编码能力，普通协作工具与工作流归属分别收窄", () => {
  const source: WorkflowSource = { product: "ruukoto", projectId: "project", sessionId: "parent", taskId: "task", permissionVersion: 1,
    accessMode: "confirm" as AccessMode, grantedPaths: [], capabilities: ["app_data", "subagent"], references: [], replyTarget: null, scheduledRunId: null,
    authority: { toolClass: "main", categories: ["app_data", "subagent", "browser", "workflow"], grantIds: [], configuration: "test", workspace: { path: "/work", dev: 1, ino: 1 } } };
  const ordinary = subAgentSourceProfile(source), workflow = subAgentSourceProfile(source, { workflow: true });
  assert.deepEqual(ordinary.categories, ["app_data", "coding"]);
  assert.equal(sourceAllows(ordinary, "bash"), true);
  assert.equal(sourceAllows(ordinary, "subagent_message"), true);
  assert.equal(sourceAllows(workflow, "subagent_message"), false);
  for (const name of ["subagent_delegate", "workflow_start", "browser", "coding_delegate", "todo_write"]) assert.equal(sourceAllows(ordinary, name), false, name);
  assert.deepEqual(subAgentSourceProfile(source, { verify: true }).categories, ["coding"]);
});
