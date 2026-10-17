// Note: 见 .agents/notes/implemented/feature/2026-10-17-demo-git-commit-details.md
export type GitRef = { name: string; type: "branch" | "tag"; remote?: string };
export type GitCommit = { id: string; parents: string[]; subject: string; author: string; date: string; refs: GitRef[] };
export type GitRepository = { head: string | null; commits: GitCommit[] };

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
