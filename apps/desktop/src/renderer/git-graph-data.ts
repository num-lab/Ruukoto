// Note: 见 .agents/notes/implemented/feature/2026-10-17-demo-git-commit-details.md
export type GitRef = { name: string; type: "branch" | "tag"; remote?: string };
export type GitCommit = { id: string; parents: string[]; subject: string; author: string; date: string; refs: GitRef[] };
export type GitRepository = { head: string | null; commits: GitCommit[] };
