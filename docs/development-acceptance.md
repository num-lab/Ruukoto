# External Development Acceptance

Offline tests establish deterministic host behavior. These checks add real model routing, native execution and client or platform evidence. Run them in isolated profiles with explicit prerequisites, and keep raw captures outside the checkout. [Development](development.md) owns setup and daily verification; [release acceptance](release-acceptance.md) records upgrade baselines.

## Native and Platform Checks

| Command | Required environment and coverage |
| --- | --- |
| `npm --prefix verification/foundation run linux:probes -- --output-dir <external-directory>` | Linux native prerequisites; bubblewrap, namespaces, seccomp and user scopes; choose a fresh directory outside the checkout |
| `npm run test:native` | Isolated Linux, built workers and native prerequisites; tools, SubAgents and recovery with mock models |
| `npm run test:model` | `~/.pi/agent/` configuration and credentials; try a short provider round trip until the first success |
| `npm run test:release-model` | Built native execution, Python PTY and explicit models; real Coding, work after TUI exit and reconnect |
| [Workflow model commands](../verification/smoke/README.md) | Explicit model configuration and native workers; tool startup, chatting while waiting, real tools and final reporting |

[Platform probes](../verification/foundation/scripts/native-isolation/README.md) report unavailable when capabilities or controls are missing. Offline tests do not replace actual OS evidence.

## Coding Input and Questions

Coding input-lifecycle acceptance uses layout `ruukoto-single-v1`, schema 59 and protocol 50 in fresh profiles. Preserve old profiles and pending request files; do not run an instance migration or switch a daily backend as part of these checks. Narrow regressions cover queue retrieval, persistent pause, same-task answers and request-bound report consumption. Real Desktop/TUI interaction, Linux stopping/restart and real models are separate evidence.

Persistent-question model acceptance uses explicit DeepSeek configuration and isolated profiles. It proves waiting, answering and asking again in the original task, plus guidance canceling a question:

```bash
RUN_MODEL_CHECK=1 RUN_OWNER_QUESTION_MODELS_FILE=/path/models.json npx tsx --test test/owner-question-model-acceptance.test.ts
```

## Coding Scheduled Work

Scheduled acceptance creates a new profile from explicit models, removes the copy afterward and verifies the source digest. It covers questioning, answers, single-file approval and finalization, with at most six requests and three minutes:

```bash
RUN_MODEL_CHECK=1 RUN_CODE_SCHEDULER_MODELS_FILE=/absolute/models.json npx tsx --test test/code-scheduler-model-acceptance.test.ts
```

## Evidence and Cleanup

See [smoke instructions](../verification/smoke/README.md) for arguments, authentication, exit codes and cleanup. Keep credentials in protected files outside the checkout. [Release acceptance](release-acceptance.md) defines current evidence boundaries. Missing model configuration is unverified, not a pass. Native isolation, real model behavior and actual client interaction need separate evidence; historical upgrade or simulated transport results do not cover them.
