import assert from "node:assert/strict";
import { test } from "node:test";
import { layoutGitGraph as demoLayout, type GitCommit } from "../.scratch/desktop-shadcn/demo/src/git-graph-data.ts";
import { buildGitGraph, extendGitGraph, gitGraphCanExtend, gitGraphWindow, GIT_GRAPH_CHECKPOINT_ROWS } from "../apps/desktop/src/renderer/git-graph-model.ts";

function commit(id: string, parents: string[]): GitCommit {
  return { id, parents, subject: id, author: "author", date: "2026-10-17", refs: [] };
}

// 确定性伪随机，避免布局断言随运行变化。
function synthetic(count: number, chance: number, span: number): GitCommit[] {
  const commits = Array.from({ length: count }, (_value, index) => commit(`c${index}`, []));
  for (let index = 0; index < count - 1; index++) commits[index]!.parents = [commits[index + 1]!.id];
  for (let index = 0; index + 2 < count; index++) {
    if (((index * 37) % 100) / 100 >= chance) continue;
    const target = Math.min(count - 1, index + 2 + ((index * 53) % span));
    if (target !== index + 1) commits[index]!.parents.push(commits[target]!.id);
  }
  return commits;
}

test("Demo 70000条布局不展开函数参数，逐行边索引与原选择一致", () => {
  const commits: GitCommit[] = Array.from({ length: 70_000 }, (_value, index) => commit(String(index), index < 69_999 ? [String(index + 1)] : []));
  const result = demoLayout(commits);
  assert.equal(result.rows.length, commits.length); assert.equal(result.laneCount, 1);
  assert.equal(result.edgesByRow.length, commits.length);
  assert.equal(result.edgesByRow[0]!.length, 1); assert.equal(result.edgesByRow[30_000]!.length, 2); assert.equal(result.edgesByRow[69_999]!.length, 1);
  for (const row of [0, 1, 30_000, 69_999]) assert.deepEqual(result.edgesByRow[row], result.edges.filter(edge => edge.from <= row && edge.to >= row));
});

test("Demo 追加页面保留前缀lane、合并与更早父边", () => {
  const commits: GitCommit[] = [commit("merge", ["a", "b"]), commit("a", ["base"]), commit("b", ["base"]), commit("base", [])];
  const first = demoLayout(commits.slice(0, 2)), full = demoLayout(commits);
  assert.deepEqual(full.rows.slice(0, 2).map(node => node.lane), first.rows.map(node => node.lane));
  assert.equal(first.edges.filter(edge => edge.continuation).length, 2);
  assert.equal(full.edges.filter(edge => edge.continuation).length, 0);
  for (const row of full.rows) assert.deepEqual(full.edgesByRow[row.row], full.edges.filter(edge => edge.from <= row.row && edge.to >= row.row));
});

test("模型按 128 行巡检点前滚，70000 条线性历史窗口与全量一致", () => {
  const commits: GitCommit[] = Array.from({ length: 70_000 }, (_value, index) => commit(String(index), index < 69_999 ? [String(index + 1)] : []));
  const model = buildGitGraph(commits);
  assert.equal(model.processed, 70_000); assert.equal(model.laneCount, 1);
  assert.equal(model.checkpoints.length, Math.ceil(70_000 / GIT_GRAPH_CHECKPOINT_ROWS));
  const full = gitGraphWindow(model, commits, 0, 300), middle = gitGraphWindow(model, commits, 130, 170), tail = gitGraphWindow(model, commits, 69_960, 70_000);
  assert.deepEqual(middle, full.slice(130, 170));
  assert.equal(tail.length, 40);
  for (const row of tail) { assert.equal(row.lane, 0); assert.equal(row.parents.length, row.row === 69_999 ? 0 : 1); }
  assert.equal(tail[0]!.incoming.length, 1);
});

test("模型窗口与 Demo 布局逐行等价：lane、父边、穿越边与续行", () => {
  const fixtures: GitCommit[][] = [
    [commit("m1", ["a1", "b1"]), commit("a1", ["a2"]), commit("b1", ["b2"]), commit("a2", ["root"]), commit("b2", ["root"]), commit("root", [])],
    // 时钟偏移：父提交排在子提交之前，旧布局不绘制 to < from 的边。
    [commit("p1", []), commit("c1", ["p1"]), commit("p2", []), commit("c2", ["p2", "c1"]), commit("tail", [])],
    synthetic(300, 0.2, 80),
  ];
  for (const commits of fixtures) {
    const demo = demoLayout(commits), model = buildGitGraph(commits), window = gitGraphWindow(model, commits, 0, commits.length);
    assert.equal(model.laneCount, demo.laneCount);
    for (const row of window) {
      assert.equal(row.lane, demo.rows[row.row]!.lane);
      assert.deepEqual(row.parents, demo.edges.filter(edge => edge.from === row.row && edge.to >= row.row).map(edge => ({ lane: edge.toLane, continuation: edge.continuation })));
      const crossing = new Map<number, boolean>();
      for (const edge of demo.edges.filter(edge => edge.from < row.row && edge.to >= row.row)) {
        assert.equal(crossing.get(edge.toLane) ?? edge.continuation, edge.continuation);
        crossing.set(edge.toLane, edge.continuation);
      }
      assert.deepEqual([...row.incoming].sort((left, right) => left.lane - right.lane), [...crossing.entries()].map(([lane, continuation]) => ({ lane, continuation })).sort((left, right) => left.lane - right.lane));
    }
  }
});

test("模型追加等价整图构建，续行在父提交加载后变实线", () => {
  const commits = synthetic(600, 0.25, 120);
  const full = buildGitGraph(commits);
  for (const page of [1, 200, 599]) {
    const staged = buildGitGraph(commits.slice(0, page));
    assert.ok(gitGraphCanExtend(staged, commits));
    extendGitGraph(staged, commits);
    assert.equal(staged.processed, full.processed); assert.equal(staged.laneCount, full.laneCount);
    assert.deepEqual(staged.laneAt, full.laneAt); assert.deepEqual(staged.parentLanes, full.parentLanes);
    assert.deepEqual(staged.checkpoints, full.checkpoints);
    assert.deepEqual(gitGraphWindow(staged, commits, 0, 600), gitGraphWindow(full, commits, 0, 600));
  }
  const page = [commit("a", ["b"]), commit("b", ["older"])], extended = [commit("older", [])];
  const staged = buildGitGraph(page);
  assert.equal(gitGraphWindow(staged, page, 0, 2)[1]!.parents[0]!.continuation, true);
  const loaded = page.concat(extended);
  extendGitGraph(staged, loaded);
  assert.equal(gitGraphWindow(staged, loaded, 0, 3)[1]!.parents[0]!.continuation, false);
});

test("模型只在前缀首尾不变时增量，刷新换页、变短与首尾变化都重建", () => {
  const commits = synthetic(50, 0.2, 20), model = buildGitGraph(commits);
  assert.equal(gitGraphCanExtend(model, commits), true);
  assert.equal(gitGraphCanExtend(model, commits.slice(0, 10)), false);
  assert.equal(gitGraphCanExtend(model, [commit("other", []), ...commits.slice(1)]), false);
  assert.equal(gitGraphCanExtend(model, commits.slice(0, 49).concat(commit("other", []))), false);
});

test("多车道夹具的窗口仍按巡检点前滚并与全量一致", () => {
  const commits = synthetic(2_000, 0.35, 300);
  const model = buildGitGraph(commits);
  assert.ok(model.laneCount >= 10, `laneCount ${model.laneCount}`);
  const full = gitGraphWindow(model, commits, 900, 940), mid = gitGraphWindow(model, commits, 1_000, 1_040);
  assert.deepEqual(gitGraphWindow(buildGitGraph(commits), commits, 1_000, 1_040), mid);
  assert.ok(new Set(full.map(row => row.lane)).size > 1);
});
