import assert from "node:assert/strict";
import { test } from "node:test";
import { layoutGitGraph as desktopLayout, type GitCommit } from "../apps/desktop/src/renderer/git-graph-data.ts";
import { layoutGitGraph as demoLayout } from "../.scratch/desktop-shadcn/demo/src/git-graph-data.ts";

for (const [name, layout] of [["Desktop", desktopLayout], ["Demo", demoLayout]] as const) {
  test(`${name} 70000条布局不展开函数参数，逐行边索引与原选择一致`, () => {
    const commits: GitCommit[] = Array.from({ length: 70_000 }, (_value, index) => ({ id: String(index), parents: index < 69_999 ? [String(index + 1)] : [], subject: "commit", author: "author", date: "2026-10-17", refs: [] }));
    const result = layout(commits);
    assert.equal(result.rows.length, commits.length); assert.equal(result.laneCount, 1);
    assert.equal(result.edgesByRow.length, commits.length);
    assert.equal(result.edgesByRow[0].length, 1); assert.equal(result.edgesByRow[30_000].length, 2); assert.equal(result.edgesByRow[69_999].length, 1);
    for (const row of [0, 1, 30_000, 69_999]) assert.deepEqual(result.edgesByRow[row], result.edges.filter(edge => edge.from <= row && edge.to >= row));
  });

  test(`${name} 追加页面保留前缀lane、合并与更早父边`, () => {
    const commits: GitCommit[] = [
      { id: "merge", parents: ["a", "b"], subject: "merge", author: "author", date: "2026-10-17", refs: [] },
      { id: "a", parents: ["base"], subject: "a", author: "author", date: "2026-10-17", refs: [] },
      { id: "b", parents: ["base"], subject: "b", author: "author", date: "2026-10-17", refs: [] },
      { id: "base", parents: [], subject: "base", author: "author", date: "2026-10-17", refs: [] },
    ];
    const first = layout(commits.slice(0, 2)), full = layout(commits);
    assert.deepEqual(full.rows.slice(0, 2).map(node => node.lane), first.rows.map(node => node.lane));
    assert.equal(first.edges.filter(edge => edge.continuation).length, 2);
    assert.equal(full.edges.filter(edge => edge.continuation).length, 0);
    for (const row of full.rows) assert.deepEqual(full.edgesByRow[row.row], full.edges.filter(edge => edge.from <= row.row && edge.to >= row.row));
  });
}
