import { checkToolActivity } from "./check-tool-activity.mjs";
import { checkInspector } from "./check-inspector.mjs";
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
  const { PersonalConnectionSettings, initialPersonalConnection } = await server.ssrLoadModule("/src/personal-connection-settings.tsx");
  assert.deepEqual(initialPersonalConnection, { host: "", controlDir: "/var/lib/ruukoto/control" }, "连接设置不预填服务器，目录沿用后台默认值");
  const connectionForm = renderToStaticMarkup(createElement(PersonalConnectionSettings, { config: initialPersonalConnection, onSave() {} }));
  for (const [name, valid, invalid] of [
    ["host", ["pa-server", "pa_server.test", "127.0.0.1"], ["", "-pa", "user@host", "pa server", "pa;cmd"]],
    ["controlDir", ["/var/lib/ruukoto/control", "/srv/pa-test_1/control", "/"], ["", "relative/control", "/pa:bad", "/pa server"]],
  ]) {
    const input = [...connectionForm.matchAll(/<input\b[^>]*>/g)].map(match => match[0]).find(tag => tag.includes(`name="${name}"`));
    assert.ok(input?.includes('required=""'), `连接字段 ${name} 必填`);
    const pattern = input.match(/pattern="([^"]+)"/)?.[1];
    assert.ok(pattern, `连接字段 ${name} 缺少原生校验`);
    const rule = new RegExp(`^(?:${pattern})$`, "v");
    for (const value of valid) assert.ok(rule.test(value), `${name} 应允许 ${value}`);
    for (const value of invalid) assert.ok(!rule.test(value), `${name} 应拒绝 ${value}`);
  }
  assert.ok(connectionForm.includes('for="personal-host"') && connectionForm.includes('for="personal-control-dir"'), "连接字段都有可访问标签");
  assert.ok(connectionForm.includes('aria-describedby="personal-host-help"') && connectionForm.includes('type="submit"'), "帮助文本与保存操作应可访问");
  assert.ok(connectionForm.includes('role="status"'), "保存反馈在对话框内由读屏播报");
  const savedForm = renderToStaticMarkup(createElement(PersonalConnectionSettings, { config: { host: "pa-saved", controlDir: "/srv/ruukoto/control" }, onSave() {} }));
  assert.ok(savedForm.includes('value="pa-saved"') && savedForm.includes('value="/srv/ruukoto/control"'), "重新挂载表单使用已保存配置");
  const { App, ContextDetails, reorderTab, tabDragOffset, submitOnEnter } = await server.ssrLoadModule("/src/app.tsx");
  const tabIds = ["a", "b", "c"];
  assert.deepEqual(reorderTab(tabIds, 0, 2), ["b", "c", "a"], "标签可以向后移动到目标位置");
  assert.deepEqual(reorderTab(tabIds, 2, 0), ["c", "a", "b"], "标签可以向前移动到目标位置");
  const previewIds = ["a", "b", "c", "d"];
  assert.deepEqual(previewIds.map(id => tabDragOffset(previewIds, "a", "c", id)), [2, -1, -1, 0], "向后拖动时中间标签向前避让，末项不动");
  assert.deepEqual(previewIds.map(id => tabDragOffset(previewIds, "d", "b", id)), [0, 1, 1, -2], "向前拖动时中间标签向后避让，首项不动");
  for (const [source, target] of [["a", "a"], ["missing", "c"], ["a", "missing"]]) assert.deepEqual(previewIds.map(id => tabDragOffset(previewIds, source, target, id)), [0, 0, 0, 0], "取消或无效来源不产生避让");
  assert.equal(tabDragOffset(previewIds, "a", "c", "missing"), 0, "缺失标签不参与避让");
  assert.deepEqual(previewIds, ["a", "b", "c", "d"], "拖动预览不提交标签顺序");
  assert.deepEqual(tabIds, ["a", "b", "c"], "排序不修改原数组");
  for (const [from, to] of [[1, 1], [-1, 0], [0, -1], [3, 0], [0, 3]]) assert.equal(reorderTab(tabIds, from, to), tabIds, "同位置或缺失标签不改变顺序");
  const tabObjects = [{ id: "a", navigation: { address: "about:blank" } }, { id: "b" }];
  const movedObjects = reorderTab(tabObjects, 0, 1);
  assert.equal(movedObjects[1], tabObjects[0], "右栏排序保留页面对象和导航状态");
  for (const [overrides, canSend, expectedPrevented, expectedSent] of [
    [{}, true, true, 1],
    [{ shiftKey: true }, true, false, 0],
    [{ nativeEvent: { isComposing: true, keyCode: 13 } }, true, false, 0],
    [{ nativeEvent: { isComposing: false, keyCode: 229 } }, true, false, 0],
    [{ repeat: true }, true, true, 0],
    [{ key: "a" }, true, false, 0],
    [{}, false, true, 0],
  ]) {
    let prevented = false;
    let sent = 0;
    submitOnEnter({ key: "Enter", shiftKey: false, repeat: false, nativeEvent: { isComposing: false, keyCode: 13 }, preventDefault() { prevented = true; }, ...overrides }, canSend, () => sent++);
    assert.equal(prevented, expectedPrevented, "Enter 默认换行与输入法分支");
    assert.equal(sent, expectedSent, "只有可发送的单次 Enter 才提交");
  }
  const { activitySummary, completeSubmission, executionPreview, initialPersonalSession, initialWorkspaces, PERSONAL_SESSION_ID, scenarios } = await server.ssrLoadModule("/src/demo-data.ts");
  assert.equal(activitySummary([
    { action: "Edit", file: "a.ts" },
    { action: "Edited", file: "a.ts" },
    { action: "Write", file: "b.ts" },
    { action: "Read", file: "c.ts" },
    { action: "Agent", file: "Schema Auditor" },
  ]), "Read files, edited files, wrote files", "摘要只列实际出现的活动类型，不显示数量、文件名或子 Agent");
  assert.equal(activitySummary([
    { action: "Read", file: "a.ts" },
    { action: "Run", file: "npm test" },
    { action: "Edited", file: "a.ts" },
    { action: "Write", file: "b.ts" },
  ]), "Read files, ran commands, edited files, wrote files");
  for (const [actions, expected] of [
    [["Read", "Grep"], "Read files"],
    [["Run", "Build", "Bench"], "Ran commands"],
    [["Edit", "Edited"], "Edited files"],
    [["Write"], "Wrote files"],
    [["Agent", "Mock", "Check", "Open"], "工具活动"],
    [[], "工具活动"],
  ]) {
    assert.equal(activitySummary(actions.map(action => ({ action, file: "sample" }))), expected);
  }
  assert.equal(initialPersonalSession.id, PERSONAL_SESSION_ID);
  assert.ok(!initialWorkspaces.some(workspace => workspace.sessions.some(session => session.id === PERSONAL_SESSION_ID)), "PA 主会话独立于工作区，不参与新建或筛选");
  assert.deepEqual(initialPersonalSession.steps, [], "PA 不编造对话样例");
  assert.deepEqual(initialPersonalSession.diffs, []);
  for (const phase of ["thinking", "working"]) {
    const activity = executionPreview(initialPersonalSession, phase).at(-1);
    assert.equal(activity.phase, phase);
    assert.deepEqual(activity.items, [], "PA 执行预览不注入 Code 的文件和命令样例");
  }
  const originalSession = initialWorkspaces[1].sessions[0];
  assert.equal(originalSession.steps[0].type, "user");
  assert.ok(initialWorkspaces.flatMap(workspace => workspace.sessions).every(session => [...session.steps, ...session.subagents.flatMap(agent => agent.steps)].every(step => step.type !== "thought")), "主／子消息流均不再装配思考数据");
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
  assert.equal(completed.effort, originalSession.effort, "核实提交不应改变 Effort");
  assert.equal(completed.context, originalSession.context, "核实提交不应伪造上下文用量");
  assert.equal(completeSubmission(completed, pending), completed, "重复核实不得重复提交");
  assert.equal(completeSubmission(waiting, { ...pending }), waiting, "过期核实不得改变当前输入");
  assert.equal(completeSubmission(originalSession, pending), originalSession, "其他会话不得被核实结果影响");
  const personalCompleted = completeSubmission({ ...initialPersonalSession, pendingSubmission: pending }, pending);
  assert.equal(personalCompleted.id, PERSONAL_SESSION_ID, "发送仍归属同一 PA 主会话");
  assert.equal(personalCompleted.title, "Ruukoto", "发送不会重命名固定入口");
  assert.equal(personalCompleted.steps.at(-2).text, completed.steps.at(-2).text);
  assert.equal(personalCompleted.steps.at(-1).text, "这是前端模拟回复，没有调用真实模型。", "PA 模拟回复不介绍 Code 的差异或审批");
  assert.deepEqual(initialPersonalSession.steps, [], "发送不得修改初始主会话");
  const queued = { ...pending, queued: true };
  assert.match(completeSubmission({ ...waiting, pendingSubmission: queued }, queued).steps.at(-1).text, /输入已排队/);
  assert.ok(!scenarios.some(item => item.value === "unknown"), "移除未知操作预览入口");
  Object.defineProperty(globalThis, "window", { value: { innerWidth: 1160 }, configurable: true });
  const html = renderToStaticMarkup(createElement(App));
  assert.match(html, /class="desktop-backdrop" inert="" aria-busy="true"/, "启动连接时底层先隔离，Portal 交互与退出由浏览器检查");
  const personalEntry = html.match(/<button\b[^>]*class="[^"]*personal-row[^>]*>Ruukoto<\/button>/)?.[0];
  assert.ok(personalEntry?.includes('type="button"'), "工作区上方提供独立 Ruukoto 按钮");
  assert.ok(html.indexOf(personalEntry) < html.indexOf('class="projects-heading"'), "Ruukoto 行位于工作区标题上方");
  assert.match(html, /id="workspace-filter"[^>]*data-open="false"[^>]*aria-hidden="true"[^>]*inert=""/, "收起的筛选区域仍挂载且不可交互");
  assert.match(html, /aria-controls="workspace-filter" aria-expanded="false"/, "筛选按钮暴露开合状态");
  const composerRight = html.slice(html.indexOf('class="composer-right"'), html.indexOf("</form>"));
  const contextPosition = composerRight.indexOf('aria-label="上下文使用量"');
  const modelPosition = composerRight.indexOf('aria-label="会话模型"');
  const sendPosition = composerRight.indexOf('aria-label="发送消息"');
  assert.ok(contextPosition >= 0 && contextPosition < modelPosition && modelPosition < sendPosition, "输入区顺序应为 Context、模型菜单、发送");
  assert.ok(!composerRight.includes('class="effort-selector"') && !composerRight.includes('aria-label="Effort"'), "Effort 应收进模型菜单，输入区不再有独立选择框");
  const modelTrigger = [...composerRight.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]).find(button => button.includes('aria-label="会话模型"'));
  assert.ok(modelTrigger?.includes('aria-haspopup="menu"') && modelTrigger.includes('type="button"'), "模型入口应打开原生菜单而非提交表单");
  assert.ok(modelTrigger.includes("lucide-brain") && modelTrigger.includes('aria-description="Claude 3.7 Sonnet · Effort: Medium"'), "紧凑入口仍应提供当前模型和 Effort");
  assert.match(composerRight, /aria-description="32,000 \/ 200,000 tokens"/, "Context 关闭详情时仍应保留可访问用量");
  const contextTrigger = [...composerRight.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]).find(button => button.includes('aria-label="上下文使用量"'));
  assert.ok(contextTrigger?.includes('data-slot="hover-card-trigger"') && contextTrigger.includes('type="button"'), "Context 应使用原生 Hover Card 入口并避免提交表单");
  assert.equal(contextTrigger.replace(/<[^>]+>/g, "").trim(), "", "Context 入口只显示环形图标，不显示百分比数字");
  assert.ok(contextTrigger.includes('data-slot="context-ring"') && !contextTrigger.includes("animate-spin"));
  const attachmentTrigger = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]).find(button => button.includes('aria-label="附加文件"'));
  assert.ok(attachmentTrigger?.includes("attachment-button") && attachmentTrigger.includes('type="button"'), "附件样式仅应用于原有非提交按钮");
  const previousMode = originalSession.mode;
  try {
    for (const [mode, label, icon] of [["confirm", "Ask for approval", "message-circle-question"], ["auto-review", "Auto review", "shield-check"], ["full", "Full access", "zap"], ["plan", "Plan", "list-todo"]]) {
      originalSession.mode = mode;
      const modeHtml = renderToStaticMarkup(createElement(App));
      const modeTrigger = [...modeHtml.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]).find(button => button.includes('aria-label="会话默认模式"'));
      assert.ok(modeTrigger?.includes(`aria-description="${label}"`) && modeTrigger.includes(label), "图标入口始终保留当前模式的可访问名称");
      assert.ok(modeTrigger.includes(`lucide-${icon}`) && modeTrigger.includes("mode-selector-label"), `模式 ${mode} 应显示对应图标`);
    }
  } finally {
    originalSession.mode = previousMode;
  }
  const { Progress } = await server.ssrLoadModule("/src/components/ui/progress.tsx");
  assert.equal(originalSession.effort, "Medium");
  const previousContext = originalSession.context;
  const previousPending = originalSession.pendingSubmission;
  try {
    for (const [usedTokens, percent] of [[0, 0], [32000, 16], [100000, 50], [200000, 100]]) {
      originalSession.context = { usedTokens, maxTokens: 200000, systemTokens: usedTokens ? 1500 : 0, toolTokens: usedTokens ? 5300 : 0 };
      const details = renderToStaticMarkup(createElement(ContextDetails, { context: originalSession.context }));
      assert.ok(details.includes(`${percent}%`) && details.includes("of context used"));
      assert.ok(details.includes('aria-valuenow="' + percent + '"'));
      for (const label of ["System prompt", "Tool definitions", "Messages"]) assert.ok(details.includes(label));
      assert.ok(details.includes(`--context-system-end:${100 - percent + originalSession.context.systemTokens / 200000 * 100}%`), "色标应位于原生 Indicator 的可见末段");
      assert.ok(details.includes(`--context-tools-end:${100 - percent + (originalSession.context.systemTokens + originalSession.context.toolTokens) / 200000 * 100}%`));
      assert.ok(!details.includes("NaN") && !details.includes("Infinity"));
      if (!usedTokens) assert.equal((details.match(/<dd>~0<\/dd>/g) ?? []).length, 3, "空上下文三类用量均为零");
      if (usedTokens === 32000) assert.ok(details.includes("~1.5K") && details.includes("~5.3K") && details.includes("~25.2K"), "分类应合计为32K");
      const contextHtml = renderToStaticMarkup(createElement(App));
      assert.ok(contextHtml.includes(`aria-description="${usedTokens.toLocaleString("en-US")} / 200,000 tokens"`), "Context 的可访问用量应随数据变化");
      const arc = contextHtml.match(/<circle[^>]*data-slot="context-ring-value"[^>]*>/)?.[0];
      assert.ok(arc?.includes(`stroke-dashoffset="${100 - percent}"`) && arc.includes(`opacity="${percent === 0 ? 0 : 1}"`), "环形进度应随用量变化，0 用量不留下圆头点");
      assert.ok(!contextHtml.includes(`<span>${percent}%</span>`), "不应显示百分比数字");
      const progressHtml = renderToStaticMarkup(createElement(Progress, { value: percent, "aria-label": "上下文使用量" }));
      assert.ok(progressHtml.includes(`aria-valuenow="${percent}"`) && progressHtml.includes(`translateX(-${100 - percent}%)`), "原生 Progress 的读屏数值应与填充一致");
    }
    originalSession.pendingSubmission = pending;
    const blockedHtml = renderToStaticMarkup(createElement(App));
    for (const name of ["会话模型"]) {
      const trigger = [...blockedHtml.matchAll(/<button\b[^>]*>/g)].map(match => match[0]).find(button => button.includes(`aria-label="${name}"`));
      assert.ok(trigger?.includes('disabled=""'), `核实时 ${name} 应禁用`);
    }
  } finally {
    originalSession.context = previousContext;
    originalSession.pendingSubmission = previousPending;
  }
  const referenceDetails = renderToStaticMarkup(createElement(ContextDetails, { context: { usedTokens: 18700, maxTokens: 1000000, systemTokens: 1500, toolTokens: 5300 } }));
  assert.ok(referenceDetails.includes("2%") && referenceDetails.includes("18.7K") && referenceDetails.includes("1M") && referenceDetails.includes("11.9K"), "详情使用紧凑约数格式，百分比四舍五入");
  assert.ok(html.includes("Thought for") && !html.includes("思考过程"), "历史思考单独平铺，可展开正文");
  const toolTriggers = [...html.matchAll(/<button\b[^>]*data-slot="trace-collapsible-trigger"[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]).filter(button => button.includes("Read files"));
  assert.equal(toolTriggers.length, 0, "主／子消息流均取消工具摘要分组");
  for (const slot of ["message-scroller", "message-scroller-viewport", "message-scroller-content", "message-scroller-item", "message", "message-content", "bubble", "bubble-content", "trace", "trace-line", "trace-collapsible", "item", "item-actions"]) {
    assert.ok(html.includes(`data-slot="${slot}"`), `消息流未接入官方 ${slot} 组件`);
  }
  assert.equal((html.match(/role="log"/g) ?? []).length, 2, "主会话与子 Agent 应有独立的消息流");
  assert.ok(!html.includes('data-slot="message-scroller-button"'), "不新增跳转按钮");
  for (const expected of ["工作区导航", "命令审批", "输入消息", "检查器", "Schema Auditor", "indexeddb.ts", "data-slot=\"tabs-trigger\""]) {
    assert.ok(html.includes(expected), `首屏缺少 ${expected}`);
  }
  assert.ok(html.includes("Read <a") && html.includes("Edited <code>"), "首屏直接显示读取和编辑调用");
  assert.ok(!html.includes("查看完整参数后决定"), "审批不再要求先展开参数");
  assert.ok(!html.includes('aria-label="新建会话"'), "顶部新建会话按钮应移除");
  assert.ok(html.includes('aria-label="附加文件"'), "输入区应有附件入口");
  assert.ok(html.indexOf('class="surface-sidebar canvas-header"') < html.indexOf("<main"), "会话标签区应独立于正文并位于右栏上方");
  assert.equal((html.match(/class="[^"]*sidebar-toggle\b/g) ?? []).length, 1, "侧栏始终只有一个折叠按钮");
  assert.ok(html.indexOf('sidebar-toggle') < html.indexOf('<aside id="left-sidebar"'), "折叠按钮放在稳定层，不随侧栏隐藏");
  assert.match(html, /aria-controls="left-sidebar" aria-expanded="true"/, "同一按钮持有展开状态");
  const header = html.match(/<header\b[\s\S]*?<\/header>/)?.[0];
  const inspector = html.match(/<aside id="right-sidebar"[\s\S]*?<\/aside>/)?.[0];
  for (const [name, count] of [["已打开的会话", 3], ["右侧标签", 2]]) {
    const list = [...header.matchAll(/<div\b[^>]*role="tablist"[^>]*>/g)].map(match => match[0]).find(tag => tag.includes(`aria-label="${name}"`));
    assert.match(list?.match(/style="([^"]*)"/)?.[1] ?? "", new RegExp(`(?:^|;)--tab-count:${count}(?:;|$)`), `${name} 按自身数量计算动态等宽`);
  }
  for (const className of ["center-tab", "right-tab"]) {
    const triggers = [...header.matchAll(/<button\b[^>]*>/g)].map(match => match[0]).filter(button => (button.match(/class="([^"]*)"/)?.[1].split(/\s+/) ?? []).includes(className));
    assert.ok(triggers.length > 0 && triggers.every(button => button.includes('draggable="true"') && button.includes('aria-keyshortcuts="Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"')), `${className} 均接入拖动和键盘排序`);
  }
  assert.ok(header?.includes('aria-label="右侧标签"') && header.includes('aria-label="右栏新标签"'), "右侧 tab 与加号应移到窗口顶部");
  assert.ok(inspector && !inspector.includes('aria-label="右侧标签"'), "检查器内容不应保留第二排 tab");
  window.innerWidth = 837;
  const narrowHtml = renderToStaticMarkup(createElement(App));
  const hiddenHeader = narrowHtml.match(/<div class="right-header"[^>]*>/)?.[0];
  assert.ok(hiddenHeader?.includes('aria-hidden="true"') && hiddenHeader.includes('inert=""'), "收起右栏时顶部 tab 也应隐藏且不可聚焦");
  assert.ok(narrowHtml.includes('aria-label="展开右栏"'), "收起后右栏开关应保持可用");
  window.innerWidth = 1160;
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
  assert.equal((await readFile("src/reference.css", "utf8")).trim(), referenceCss.replace(/\/\*[\s\S]*?\*\//g, "").replace(/[ \t]+$/gm, "").trim(), "原稿样式快照与来源不一致");
  await checkInspector(server);
  await checkToolActivity(server);
  process.stdout.write("首屏渲染与原稿样式来源检查通过\n");
} finally {
  delete globalThis.window;
  await server.close();
}
