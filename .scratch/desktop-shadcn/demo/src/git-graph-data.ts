// Note: 见 .agents/notes/implemented/feature/2026-10-17-demo-git-commit-details.md
export type GitRef = { name: string; type: "branch" | "tag"; remote?: string };
export type GitCommit = { id: string; parents: string[]; subject: string; author: string; date: string; refs: GitRef[] };
export type GitRepository = { head: string | null; commits: GitCommit[] };

const repositories: Record<string, GitRepository> = {
  "ws-fumo": { head: "a93e4f1", commits: [
    { id: "a93e4f1", parents: ["7d2c9b4", "c24d8e6"], subject: "Merge offline pass caching", author: "Demo", date: "2026-10-17", refs: [{ name: "main", type: "branch" }] },
    { id: "7d2c9b4", parents: ["e68b2a9"], subject: "Keep departure times in Asia/Tokyo", author: "Demo", date: "2026-10-17", refs: [{ name: "main", type: "branch", remote: "origin" }] },
    { id: "e68b2a9", parents: ["4b7a1d0"], subject: "Refine the pass timeline", author: "Demo", date: "2026-10-16", refs: [] },
    { id: "c24d8e6", parents: ["4b7a1d0"], subject: "Reconcile HLC timestamps on reconnect", author: "Demo", date: "2026-10-16", refs: [{ name: "offline-cache", type: "branch" }] },
    { id: "4b7a1d0", parents: ["18f03c2"], subject: "Cache reserved seat segments", author: "Demo", date: "2026-10-15", refs: [{ name: "v0.3.0", type: "tag" }] },
    { id: "18f03c2", parents: [], subject: "Create Fumotravel workspace", author: "Demo", date: "2026-10-14", refs: [] },
  ] },
  "ws-nexus": { head: "b7e3a19", commits: [
    { id: "b7e3a19", parents: ["9ac421e"], subject: "Reuse stdio connections in the pool", author: "Demo", date: "2026-10-17", refs: [{ name: "main", type: "branch" }, { name: "main", type: "branch", remote: "origin" }] },
    { id: "9ac421e", parents: ["d2f187b"], subject: "Back off reconnect attempts", author: "Demo", date: "2026-10-16", refs: [] },
    { id: "d2f187b", parents: [], subject: "Add JSON-RPC transport", author: "Demo", date: "2026-10-15", refs: [] },
  ] },
  "ws-menubar": { head: null, commits: [] },
};

// Note: 见 .agents/notes/implemented/feature/2026-10-17-demo-git-graph.md
// shortcut: 仓库资格与提交均为样例，迁移正式 Desktop 时接只读仓库探测与历史。
export function workspaceGitRepository(workspaceId: string | undefined): GitRepository | undefined {
  return workspaceId && Object.hasOwn(repositories, workspaceId) ? repositories[workspaceId] : undefined;
}

export function layoutGitGraph(commits: GitCommit[]) {
  const lanes: (string | null)[] = [];
  const positions = new Map<string, { row: number; lane: number }>();
  const rows = commits.map((commit, row) => {
    let lane = lanes.indexOf(commit.id);
    if (lane < 0) lane = lanes.indexOf(null);
    if (lane < 0) lane = lanes.length;
    lanes[lane] = null;
    positions.set(commit.id, { row, lane });
    const parents = commit.parents.map((id, index) => {
      let parentLane = lanes.indexOf(id);
      if (parentLane < 0) {
        parentLane = index === 0 && lanes[lane] === null ? lane : lanes.indexOf(null);
        if (parentLane < 0) parentLane = lanes.length;
        lanes[parentLane] = id;
      }
      return parentLane;
    });
    return { commit, row, lane, parents };
  });
  const edges = rows.flatMap(node => node.commit.parents.map((id, index) => {
    const parent = positions.get(id);
    return { from: node.row, fromLane: node.lane, to: parent?.row ?? commits.length, toLane: parent?.lane ?? node.parents[index], continuation: !parent };
  }));
  let laneCount = 1;
  for (const row of rows) laneCount = Math.max(laneCount, row.lane + 1);
  const edgesByRow: typeof edges[] = Array.from({ length: rows.length }, () => []);
  for (const edge of edges) {
    laneCount = Math.max(laneCount, edge.toLane + 1);
    for (let row = edge.from; row <= Math.min(edge.to, rows.length - 1); row++) edgesByRow[row].push(edge);
  }
  return { rows, edges, edgesByRow, laneCount };
}
