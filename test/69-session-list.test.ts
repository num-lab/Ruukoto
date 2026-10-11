import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { activityAgo, TwoLineSelectList } from "@ruukoto/tui/tui/session-list.ts";

const theme = { selectedPrefix: (s: string) => s, selectedText: (s: string) => s, description: (s: string) => s, scrollInfo: (s: string) => s, noMatch: (s: string) => s };

test("会话活跃间隔按秒、分钟、小时和天显示并处理未来时间", () => {
  const now = Date.parse("2026-10-01T00:00:00Z");
  for (const [seconds, expected] of [[0, "0 seconds ago"], [1, "1 second ago"], [59, "59 seconds ago"], [60, "1 minute ago"], [3599, "59 minutes ago"], [3600, "1 hour ago"], [86399, "23 hours ago"], [86400, "1 day ago"], [172800, "2 days ago"], [-1, "0 seconds ago"]] as const) {
    assert.equal(activityAgo(new Date(now - seconds * 1000).toISOString(), now), expected);
  }
});

test("会话列表每项两行、标题截断，第二行与滚动后的鼠标对应正确会话", () => {
  const sessions = Array.from({ length: 8 }, (_, i) => ({ value: `id${i}`, label: `会话${i}很长的标题不能换行`, description: `${i + 1} day${i === 0 ? "" : "s"} ago` }));
  const list = new TwoLineSelectList(sessions, 3, theme);
  const lines = list.render(14);
  assert.equal(lines.length, 9, "三项各两行，项间一空行，末尾一行滚动计数");
  assert.equal(lines[2], "");
  assert.equal(lines[5], "");
  assert.match(lines[0]!, /会话0/);
  assert.match(lines[1]!, /1 day ago/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 14));
  assert.ok(!lines[0]!.includes("不能换行"));
  const mouse = (y: number): TuiMouseEvent => ({ x: 1, y, screenX: 1, screenY: y, width: 14, height: 20, type: "click", button: "left", shift: false, alt: false, ctrl: false });
  let chosen = "";
  list.onSelect = (item) => { chosen = item.value; };
  list.handleMouse(mouse(4));
  assert.equal(chosen, "id1", "第二项时间行可选择第二项");
  for (let i = 0; i < 5; i++) list.handleInput("\x1b[B");
  const scrolled = list.render(30);
  assert.match(scrolled[0]!, /会话5/);
  assert.match(scrolled[1]!, /6 days ago/);
  list.handleMouse(mouse(1));
  assert.equal(chosen, "id5", "滚动后首项时间行映射到可见首项");
  chosen = "";
  list.handleMouse(mouse(2));
  assert.equal(chosen, "", "间隔空行不选择会话");
  list.handleMouse(mouse(8));
  assert.equal(chosen, "", "滚动计数不属于会话项");
});
