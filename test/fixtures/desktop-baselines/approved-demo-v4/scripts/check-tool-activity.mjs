import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

export async function checkToolActivity(server) {
  const { ToolActivity } = await server.ssrLoadModule("/src/tool-activity.tsx");
  const { toolDetailsPreview, executionPreview, initialWorkspaces, activitySummary } = await server.ssrLoadModule("/src/demo-data.ts");
  const session = initialWorkspaces[1].sessions[0];
  const preview = toolDetailsPreview(session);
  const activity = preview.find(step => step.type === "activity");
  const original = structuredClone(session);
  toolDetailsPreview(session);
  assert.deepEqual(session, original, "工具预览不修改会话或差异快照");
  assert.equal(activitySummary(activity.items), "Read files, ran commands, edited files, wrote files");

  const render = (step, expanded = {}) => renderToStaticMarkup(createElement(ToolActivity, { step, diffs: session.diffs, stateKey: "session:main:1", expanded, onExpand() {}, onOpenFile() {}, onOpenAgent() {} }));
  const openKeys = Object.fromEntries(activity.items.map((_, index) => [`session:main:1:tool:${index}`, true]));
  const closedGroup = render({ ...activity, expanded: false });
  assert.ok(closedGroup.includes("2 failed · Read files, ran commands, edited files, wrote files"), "收起分组仍显示失败数与实际操作摘要");
  assert.ok(closedGroup.includes('data-status="error"'));
  assert.ok(!closedGroup.includes("ERR_PNPM_OUTDATED_LOCKFILE"), "收起的详情不进入初始 DOM");

  const read = { type: "activity", duration: "1s", expanded: true, items: [{ action: "Read", file: "src/example.ts", note: "lines 1–88" }] };
  const readHtml = render(read);
  assert.equal((readHtml.match(/data-slot="trace-collapsible-trigger"/g) ?? []).length, 1, "Read 只有父分组折叠，没有单条详情 trigger");
  assert.ok(readHtml.includes('aria-label="打开文件 src/example.ts"') && readHtml.includes('href="#right-sidebar"'));
  assert.ok(!readHtml.includes("lines 1–88") && !readHtml.includes('disabled=""'), "Read 路径可操作，不显示行范围");
  const failedRead = render({ ...read, items: [{ action: "Read", file: "missing.ts", error: "ENOENT <script>alert(1)</script>" }] });
  assert.equal((failedRead.match(/data-slot="trace-collapsible-trigger"/g) ?? []).length, 1, "失败 Read 也不展开");
  assert.ok(failedRead.includes("Failed to read") && failedRead.includes('data-variant="destructive"'));
  assert.ok(failedRead.includes("ENOENT &lt;script&gt;") && !failedRead.includes("<script>"), "Read 错误直接展示并转义");

  const all = render(activity, openKeys);
  const diff = session.diffs[0];
  assert.ok(all.includes(diff.lines.find(line => line.type === "add").code.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;")), "Edit 应展开已有调用的 diff");
  assert.ok(all.includes('data-slot="code-block-line" data-variant="added"') && all.includes('data-slot="code-block-line" data-variant="removed"'), "diff 区分增删行");
  assert.ok(all.includes("Keep the lockfile in sync with package.json."), "Write 展示自己的新增行");
  assert.ok(all.includes("$ pnpm --version\n10.18.0") && all.includes("$ pnpm install --frozen-lockfile\nERR_PNPM_OUTDATED_LOCKFILE"), "Bash 成功与失败均显示完整命令和结果");
  assert.ok(all.includes("Failed to run") && all.includes("Failed to read"));

  for (const action of ["Edit", "Edited", "Write"]) {
    const key = { "session:main:1:tool:0": true };
    const missing = render({ ...read, items: [{ action, file: "not-recorded.ts" }] }, key);
    assert.ok(missing.includes("暂无此调用的差异记录"), `${action} 缺差异时不可静默跳过`);
    const failed = render({ ...read, items: [{ action, file: "not-recorded.ts", error: "EACCES: denied" }] }, key);
    assert.ok(failed.includes("EACCES: denied") && failed.includes('data-variant="destructive"') && !failed.includes("暂无此调用的差异记录"), `${action} 失败优先展示真实错误`);
  }
  const empty = render({ ...read, items: [{ action: "Write", file: "empty.ts", diff: { file: "empty.ts", fullPath: "empty.ts", lines: [], add: 0, del: 0 } }] }, { "session:main:1:tool:0": true });
  assert.ok(empty.includes("无内容差异（空文件）"));
  const malicious = render({ ...read, items: [{ action: "Bash", file: "command", command: "printf '<img src=x onerror=alert(1)>'", output: "<script>unsafe</script>" }] }, { "session:main:1:tool:0": true });
  assert.ok(!malicious.includes("<img") && !malicious.includes("<script>") && malicious.includes("&lt;script&gt;unsafe"), "命令和输出按文本转义");
  for (const action of ["Run", "Build", "Bench", "Grep", "Mock", "Check", "Open"]) {
    const existing = render({ ...read, items: [{ action, file: "target", note: "existing detail" }] }, { "session:main:1:tool:0": true });
    assert.ok(existing.includes("target") && (action === "Run" ? existing.includes("$ target") : existing.includes("existing detail")), `${action} 保留原始动作和参数`);
  }
  const folded = render(activity);
  assert.ok(!folded.includes("10.18.0") && !folded.includes("ERR_PNPM_OUTDATED_LOCKFILE"), "成功和失败 Bash 默认均收起");
  assert.ok(folded.includes("ENOENT: no such file"), "失败 Read 在父分组打开时直接可见");
  assert.ok(!render({ ...read, items: [] }).includes('data-slot="trace-collapsible-trigger"'), "无工具不生成空分组");

  const thinkingSteps = executionPreview(session, "thinking");
  const workingSteps = executionPreview(session, "working");
  assert.equal(thinkingSteps.at(-1).phase, "thinking", "执行状态只能追加在消息流末尾");
  assert.equal(workingSteps.at(-1).phase, "working");
  assert.ok(thinkingSteps.every(step => step.type !== "command" || step.status !== "pending"), "执行预览不能同时等待命令审批");
  assert.deepEqual(session, original, "执行预览不修改原始历史、审批和差异");
  assert.ok(session.steps.some(step => step.type === "command" && step.status === "pending"), "离开预览后仍有原待审批记录");
  const thinkingHtml = render(thinkingSteps.at(-1));
  assert.ok(thinkingHtml.includes('role="status">Thinking') && thinkingHtml.includes("lucide-loader-circle") && thinkingHtml.includes("animate-spin"));
  assert.ok(!thinkingHtml.includes('data-slot="trace-collapsible-trigger"') && !thinkingHtml.includes("Thought for"), "Thinking 仅显示状态，不恢复思维链");
  const working = workingSteps.at(-1);
  const workingHtml = render(working);
  assert.ok(workingHtml.includes('role="status">Working') && workingHtml.includes('aria-expanded="true"'), "Working 默认显示调用行");
  assert.ok(workingHtml.includes('aria-label="Working"') && workingHtml.includes('aria-label="Running pnpm test:unit"'), "运行中展开入口有稳定可访问名称");
  assert.ok(workingHtml.includes("Read") && workingHtml.includes("Edited") && workingHtml.includes("Running") && workingHtml.includes("pnpm test:unit"), "完成与进行中的调用同时显示");
  assert.equal((workingHtml.match(/lucide-loader-circle/g) ?? []).length, 2, "Working 与进行中工具各显示旋转环");
  assert.equal((workingHtml.match(/lucide-circle-check/g) ?? []).length, 2, "完成工具保留勾选标识");
  const workingDetails = render(working, { "session:main:1:tool:2": true });
  assert.ok(workingDetails.includes("$ pnpm test:unit\nRUN  Unit tests"), "运行中 Bash 可查看命令和已有部分输出");
  for (const action of ["Read", "Edit", "Write"]) {
    const running = render({ ...read, items: [{ action, file: session.diffs[0].fullPath, status: "running", stat: "+999 -999" }] }, { "session:main:1:tool:0": true });
    assert.ok(running.includes(action === "Read" ? "Reading" : action === "Edit" ? "Editing" : "Writing"));
    assert.ok(!running.includes('data-slot="code-block-line"') && !running.includes("+999") && !running.includes("暂无此调用的差异记录"), "运行中调用不能借用旧差异或完成统计");
  }
  const recordedDiff = render({ ...read, items: [{ action: "Edit", file: "partial.ts", status: "running", diff: session.diffs[0] }] }, { "session:main:1:tool:0": true });
  assert.ok(recordedDiff.includes('data-slot="code-block-line"'), "进行中已记录的部分差异可查看");
  const failedWorking = render({ ...working, items: [{ action: "Bash", file: "pnpm test", error: "Test failed" }] });
  assert.ok(failedWorking.includes('aria-label="Working · 1 failed"'), "Working 关闭时可访问名称仍报告失败数");
  const interrupted = render({ ...read, items: [{ action: "Bash", file: "pnpm test", status: "running", error: "Process exited: 1" }] }, { "session:main:1:tool:0": true });
  assert.ok(interrupted.includes("Failed to run") && interrupted.includes("Process exited: 1") && !interrupted.includes("lucide-loader-circle"), "错误状态优先于过期 running 标记");
}
