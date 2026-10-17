// Note: 见 .agents/notes/implemented/feature/2026-10-18-desktop-git-graph-windowing.md
import type { GitCommit } from "./git-graph-data.ts";

// 每页 200 条，窗口从最近巡检点前滚最多这么多行；巡检点只复制车道槽位，不复制边。
export const GIT_GRAPH_CHECKPOINT_ROWS = 128;

export interface GitGraphCheckpoint {
  row: number;
  lanes: readonly (string | null)[];
  laneCount: number;
}

export interface GitGraphModel {
  processed: number;
  firstId: string | null;
  lastId: string | null;
  laneAt: number[];
  parentLanes: number[][];
  rowById: Map<string, number>;
  laneCount: number;
  checkpoints: GitGraphCheckpoint[];
}

export interface GitGraphWindowEdge {
  lane: number;
  continuation: boolean;
}

export interface GitGraphWindowRow {
  row: number;
  lane: number;
  incoming: GitGraphWindowEdge[];
  parents: GitGraphWindowEdge[];
}

export function buildGitGraph(commits: readonly GitCommit[]): GitGraphModel {
  return extendGitGraph({ processed: 0, firstId: null, lastId: null, laneAt: [], parentLanes: [], rowById: new Map(), laneCount: 0, checkpoints: [] }, commits);
}

// 追加页只在前缀与首尾提交不变时成立；刷新换页或变短必须重建。
export function gitGraphCanExtend(model: GitGraphModel, commits: readonly GitCommit[]): boolean {
  if (commits.length < model.processed) return false;
  if (model.processed === 0) return true;
  return commits[0]?.id === model.firstId && commits[model.processed - 1]?.id === model.lastId;
}

function advance(lanes: (string | null)[], commits: readonly GitCommit[], model: GitGraphModel, row: number): void {
  lanes[model.laneAt[row]!] = null;
  const parentLanes = model.parentLanes[row]!, parents = commits[row]!.parents;
  for (let index = 0; index < parentLanes.length; index++) lanes[parentLanes[index]!] = parents[index] ?? null;
}

export function extendGitGraph(model: GitGraphModel, commits: readonly GitCommit[]): GitGraphModel {
  if (!gitGraphCanExtend(model, commits)) throw new Error("git_graph_prefix_mismatch");
  const checkpoint = model.checkpoints.at(-1);
  const lanes = checkpoint ? [...checkpoint.lanes] : [];
  let laneCount = checkpoint?.laneCount ?? 0;
  for (let row = checkpoint?.row ?? 0; row < model.processed; row++) advance(lanes, commits, model, row);
  for (let row = model.processed; row < commits.length; row++) {
    if (row % GIT_GRAPH_CHECKPOINT_ROWS === 0) model.checkpoints.push({ row, lanes: [...lanes], laneCount });
    const commit = commits[row]!;
    let lane = lanes.indexOf(commit.id);
    if (lane < 0) lane = lanes.indexOf(null);
    if (lane < 0) lane = lanes.length;
    lanes[lane] = null;
    const parentLanes: number[] = [];
    for (let index = 0; index < commit.parents.length; index++) {
      const id = commit.parents[index]!;
      let parentLane = lanes.indexOf(id);
      if (parentLane < 0) {
        parentLane = index === 0 && lanes[lane] === null ? lane : lanes.indexOf(null);
        if (parentLane < 0) parentLane = lanes.length;
        lanes[parentLane] = id;
      }
      parentLanes.push(parentLane);
    }
    model.laneAt.push(lane);
    model.parentLanes.push(parentLanes);
    model.rowById.set(commit.id, row);
    model.laneCount = Math.max(model.laneCount, lane + 1);
    for (const parentLane of parentLanes) model.laneCount = Math.max(model.laneCount, parentLane + 1);
    model.processed = row + 1;
  }
  if (commits.length) {
    model.firstId = commits[0]!.id;
    model.lastId = commits[commits.length - 1]!.id;
  }
  return model;
}

// 只产出窗口行的节点车道与穿越边；续行表示父提交尚未加载，虚线语义与旧 edgesByRow 一致。
export function gitGraphWindow(model: GitGraphModel, commits: readonly GitCommit[], start: number, end: number): GitGraphWindowRow[] {
  const first = Math.max(0, Math.min(start, end)), last = Math.max(first, Math.min(end, model.processed, commits.length));
  if (first >= last) return [];
  const checkpoint = model.checkpoints[Math.floor(first / GIT_GRAPH_CHECKPOINT_ROWS)]!;
  const lanes = [...checkpoint.lanes];
  for (let row = checkpoint.row; row < first; row++) advance(lanes, commits, model, row);
  const rows: GitGraphWindowRow[] = [];
  for (let row = first; row < last; row++) {
    const commit = commits[row]!;
    const incoming: GitGraphWindowEdge[] = [];
    for (let lane = 0; lane < lanes.length; lane++) {
      const id = lanes[lane];
      if (id === null || id === undefined) continue;
      const target = model.rowById.get(id);
      // 时钟偏移可能让父提交排在子提交之前；旧布局对 to < from 的边不绘制，这里同样跳过。
      if (target !== undefined && target < row) continue;
      incoming.push({ lane, continuation: target === undefined });
    }
    const parents: GitGraphWindowEdge[] = [];
    commit.parents.forEach((id, index) => {
      const target = model.rowById.get(id);
      if (target !== undefined && target < row) return;
      parents.push({ lane: model.parentLanes[row]![index]!, continuation: target === undefined });
    });
    rows.push({ row, lane: model.laneAt[row]!, incoming, parents });
    advance(lanes, commits, model, row);
  }
  return rows;
}
