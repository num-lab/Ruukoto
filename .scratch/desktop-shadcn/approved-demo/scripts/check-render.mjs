import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const server = await createServer({ server: { middlewareMode: true }, appType: "custom" });
try {
  const { sidebarWidthLimits } = await server.ssrLoadModule("/src/sidebar-resizer.tsx");
  assert.deepEqual(sidebarWidthLimits("left", 963, 310), { min: 180, max: 360 });
  assert.deepEqual(sidebarWidthLimits("left", 963, 543), { min: 180, max: 360 }, "左栏调宽应为右栏保留最小宽度，与 CSS 夹紧规则一致");
  assert.deepEqual(sidebarWidthLimits("right", 963, 200), { min: 260, max: 543 });
  assert.deepEqual(sidebarWidthLimits("left", 736, 310), { min: 180, max: 256 });
  assert.deepEqual(sidebarWidthLimits("right", 736, 0), { min: 260, max: 516 });
  assert.deepEqual(sidebarWidthLimits("right", 400, 180), { min: 260, max: 260 });
  const { App } = await server.ssrLoadModule("/src/app.tsx");
  const { activitySummary, completeSubmission, initialWorkspaces, scenarios } = await server.ssrLoadModule("/src/demo-data.ts");
  assert.equal(activitySummary([
    { action: "Edit", file: "a.ts" },
    { action: "Edited", file: "a.ts" },
    { action: "Write", file: "b.ts" },
    { action: "Read", file: "c.ts" },
    { action: "Agent", file: "Schema Auditor" },
  ]), "Edit 1 个文件 · Write 1 个文件", "活动摘要应按不同文件统计编辑和写入，不列读取与子 Agent");
  assert.equal(activitySummary([{ action: "Read", file: "a.ts" }]), "工具活动", "无编辑时不应回退到旧的文件名摘要");
  const originalSession = initialWorkspaces[1].sessions[0];
  const pending = { draft: "  核实后发送  ", attachments: [{ id: "attachment", name: "sample.ts", size: 8 }], queued: false, continuing: true };
  const waiting = { ...originalSession, draft: pending.draft, attachments: pending.attachments, continuing: true, pendingSubmission: pending };
  assert.equal(waiting.steps.length, originalSession.steps.length, "待核实时不应加入会话记录");
  const completed = completeSubmission(waiting, pending);
  assert.equal(waiting.draft, pending.draft, "核实前草稿保持原样");
  assert.equal(waiting.attachments, pending.attachments, "核实前附件应留在输入框");
  assert.equal(completed.steps.length, originalSession.steps.length + 2, "核实完成后才加入输入与模拟回复");
  assert.equal(completed.steps.at(-2).text, "核实后发送\n［模拟附件：sample.ts］");
  assert.equal(completed.draft, "");
  assert.deepEqual(completed.attachments, []);
  assert.equal(completed.pendingSubmission, null);
  assert.equal(completed.continuing, false);
  assert.equal(completeSubmission(completed, pending), completed, "重复核实不得重复提交");
  assert.equal(completeSubmission(waiting, { ...pending }), waiting, "过期核实不得改变当前输入");
  assert.equal(completeSubmission(originalSession, pending), originalSession, "其他会话不得被核实结果影响");
  const queued = { ...pending, queued: true };
  assert.match(completeSubmission({ ...waiting, pendingSubmission: queued }, queued).steps.at(-1).text, /输入已排队/);
  assert.ok(!scenarios.some(item => item.value === "unknown"), "移除未知操作预览入口");
  Object.defineProperty(globalThis, "window", { value: { innerWidth: 1160 }, configurable: true });
  const html = renderToStaticMarkup(createElement(App));
  for (const expected of ["工作区导航", "命令审批", "输入消息", "检查器", "Schema Auditor", "indexeddb.ts", "data-slot=\"tabs-trigger\""]) {
    assert.ok(html.includes(expected), `首屏缺少 ${expected}`);
  }
  assert.ok(html.includes("Edit 2 个文件"), "首屏应显示编辑文件数量");
  assert.ok(!html.includes("查看完整参数后决定"), "审批不再要求先展开参数");
  assert.ok(!html.includes('aria-label="新建会话"'), "顶部新建会话按钮应移除");
  assert.ok(html.includes('aria-label="附加文件"'), "输入区应有附件入口");
  assert.ok(html.indexOf('class="surface-sidebar canvas-header"') < html.indexOf("<main"), "会话标签区应独立于正文并位于右栏上方");
  const approval = html.match(/<section[^>]*aria-label="命令审批"[\s\S]*?<\/section>/)?.[0];
  assert.ok(approval && !/<button\b[^>]*\sdisabled(?:=|\s|>)/.test(approval), "默认审批按钮应可直接决定");
  assert.ok(html.includes('aria-label="左侧栏宽度"') && html.includes('aria-label="右侧栏宽度"'), "左右栏均应有可访问的宽度调节入口");
  assert.match(html, /<button[^>]*aria-label="设置"[^>]*aria-haspopup="dialog"/, "设置入口应打开对话窗口");
  assert.ok(!html.includes('aria-label="演示设置"'), "旧下拉菜单入口应移除");
  assert.ok(!html.includes(' title='), "不应保留原生悬浮说明");
  assert.ok(!html.includes('data-slot="tooltip'), "不应保留 Tooltip");
  const command = originalSession.steps.find(step => step.type === "command");
  assert.ok(command, "缺少审批样例");
  const previousStatus = command.status;
  try {
    for (const status of ["approved", "skipped"]) {
      command.status = status;
      assert.ok(!renderToStaticMarkup(createElement(App)).includes('aria-label="命令审批"'), `${status} 后审批卡应消失`);
    }
  } finally {
    command.status = previousStatus;
  }
  const activity = originalSession.steps.find(step => step.type === "activity");
  assert.ok(activity, "缺少活动样例");
  const previousExpanded = activity.expanded;
  try {
    activity.expanded = true;
    const expandedHtml = renderToStaticMarkup(createElement(App));
    assert.ok(!expandedHtml.includes("lines 1–88"), "Read 的行范围附注应移除");
    assert.ok(expandedHtml.includes("+38") && expandedHtml.includes("-8"), "编辑的增删统计应保留");
    assert.ok(expandedHtml.includes("HLC clock verified"), "子 Agent 附注应保留");
  } finally {
    activity.expanded = previousExpanded;
  }
  const original = await readFile("../../desktop-gui/ui-demo.html", "utf8");
  const referenceCss = original.match(/<style>([\s\S]*?)<\/style>/)?.[1];
  assert.ok(referenceCss, "原稿缺少样式");
  assert.equal((await readFile("src/reference.css", "utf8")).trim(), referenceCss.replace(/\/\*[\s\S]*?\*\//g, "").trim(), "视觉 token 与原稿不一致");
  process.stdout.write("首屏渲染与原稿样式一致性检查通过\n");
} finally {
  delete globalThis.window;
  await server.close();
}
