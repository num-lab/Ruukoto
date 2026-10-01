import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { contextDisplayRow, formatContextTokens } from "../src/tui/context-format.ts";

const color = (index: number, text: string) => `\x1b[38;5;${index}m${text}\x1b[0m`;

test("上下文 token 单位：小写 k/m，精度随数量变化且最高仅 m", () => {
  const examples: Array<[number, string]> = [
    [0, "0k"], [1, "0.001k"], [10, "0.01k"], [99, "0.099k"], [100, "0.1k"],
    [663, "0.663k"], [1000, "1k"], [3659, "3.7k"], [114000, "114k"],
    [999949, "999.9k"], [999950, "1m"], [1000000, "1m"], [2541000, "2.5m"], [2000000000, "2000m"],
  ];
  for (const [tokens, expected] of examples) assert.equal(formatContextTokens(tokens), expected, String(tokens));
});

test("上下文长条：按原色段比例适配终端宽度，保留分色", () => {
  const bar = color(75, "██") + color(79, "███") + color(131, "████");
  const expanded = contextDisplayRow(bar, 18);
  for (const [index, count] of [[75, 4], [79, 6], [131, 8]]) {
    assert.ok(expanded.includes(`\x1b[38;5;${index}m${"█".repeat(count)}\x1b`), `颜色 ${index} 应有 ${count} 列`);
  }
  assert.equal(stripTerminalSequences(contextDisplayRow(bar, 9)), "█".repeat(9));
  for (const width of [1, 2, 3, 7, 11, 27, 100]) {
    const resized = contextDisplayRow(bar, width);
    assert.equal(visibleWidth(resized), width, `宽度 ${width} 必须铺满且不溢出`);
    assert.equal(stripTerminalSequences(resized), "█".repeat(width));
  }
  const narrow = contextDisplayRow(color(75, "█") + color(79, "█") + color(131, "█".repeat(100)), 2);
  assert.equal(visibleWidth(narrow), 2, "极窄终端不强制给每个色段一列");
  for (const lengths of [[1, 1, 1000], [1000, 1, 1], [1, 1, 1, 1, 1, 1], [7, 11, 3, 2]]) {
    const uneven = lengths.map((length, i) => color(75 + i, "█".repeat(length))).join("");
    for (let width = 0; width <= 12; width++) {
      assert.equal(visibleWidth(contextDisplayRow(uneven, width)), width, `${lengths} 在 ${width} 列无负值或溢出`);
    }
  }
});

test("上下文图例：仅转换分类裸 token 数，不修改百分比或已格式化单位", () => {
  const row = `${color(75, "■")} 系统提示 663 (0.1%)  ${color(79, "■")} 工具定义 3659 (0.4%)  ${color(131, "■")} 尚余输入 1000000`;
  const expected = `${color(75, "■")} 系统提示 0.663k (0.1%)  ${color(79, "■")} 工具定义 3.7k (0.4%)  ${color(131, "■")} 尚余输入 1m`;
  assert.equal(contextDisplayRow(row, 10), expected, "图例格式化不按长条处理或删去分类");
  assert.equal(contextDisplayRow(expected, 100), expected, "重复渲染不重复变换已有 k/m");
  const ordinary = "请求耗时 663 秒，版本 3659，预算 1000000 (0.4%)";
  assert.equal(contextDisplayRow(ordinary, 80), ordinary);
  assert.equal(contextDisplayRow("Context Usage", 80), "Context Usage");
});
