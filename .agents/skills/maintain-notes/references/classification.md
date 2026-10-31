# Choosing A Note Class

Use the class a future contributor would search for, not the number of files changed.

| Class | Scope |
| --- | --- |
| `feature` | Observable user/model behavior and product choices |
| `bug-fix` | Defects or gaps exposed by a postmortem |
| `simplification` | Removing code, behavior or interfaces without adding capability |
| `architecture` | Shipped module structure, dependencies and runtime vocabulary |
| `process` | Tooling and policies around the code: checks, packaging, vendoring and collaboration |
| `testing` | Test strategy and infrastructure |

Architecture describes the shipped code; process describes how it is developed. Refactoring has no separate class: behavior-preserving reduction is simplification, while observable changes use the appropriate feature, bug-fix or architecture class. Local implementation detail, routine refactoring and behavior-preserving patches may need no note.

Record only real alternatives, each with its strongest case and the concrete reason it lost. A simplification's Consequences names its known limit and the signal for revisiting it. Claims of improvement need a measured baseline and an observable verification path.

`scripts/agent-note-tree.ts` in this skill owns `AGENT_NOTE_CLASSES`. Adding a class requires changing both the constant and this guidance. The taxonomy follows [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
