# External Development Acceptance

Offline tests establish deterministic host behavior. These checks add real model routing, native execution and client or platform evidence. Run them in isolated profiles with explicit prerequisites, and keep raw captures outside the checkout. [Development](development.md) owns setup and daily verification; [release acceptance](release-acceptance.md) records upgrade baselines.

## Native and Platform Checks

| Command | Required environment and coverage |
| --- | --- |
| `npm --prefix verification/foundation run linux:probes -- --output-dir <external-directory>` | Linux native prerequisites; bubblewrap, namespaces, seccomp and user scopes; choose a fresh directory outside the checkout |
| `npm run test:native` | Linux, built workers and native prerequisites; Coding tools, SubAgents and recovery with mock models, not Personal durable acceptance |
| `npm run test:upgrade` | Git, dependency-install network and baseline revision; smoke-24 `--upgrade-only` with a mock model |
| `npm run test:model` | `~/.pi/agent/` configuration and credentials; try a short provider round trip until the first success |
| `npm run test:release-model` | Built native execution, Python PTY and explicit models; real Coding, work after TUI exit and reconnect |
| [Workflow model commands](../verification/smoke/README.md) | DeepSeek and native workers; shared/Coding tool startup, chatting while waiting, tools and one final report, not the new Personal entry |

[Platform probes](../verification/foundation/scripts/native-isolation/README.md) report unavailable when capabilities or controls are missing. Offline tests do not replace actual OS evidence.

## Coding Input and Questions

Coding input-lifecycle acceptance uses schema 58/protocol 49 in fresh profiles. Preserve old profiles and pending request files; do not run an instance migration or switch a daily backend as part of these checks. Narrow regressions cover queue retrieval, persistent pause, same-task answers and request-bound report consumption. Real Desktop/TUI interaction, Linux stopping/restart and real models are separate evidence.

Persistent-question model acceptance uses explicit DeepSeek configuration and isolated profiles. It proves waiting, answering and asking again in the original task, plus guidance canceling a question:

```bash
RUN_MODEL_CHECK=1 RUN_OWNER_QUESTION_MODELS_FILE=/path/models.json npx tsx --test test/owner-question-model-acceptance.test.ts
```

## Coding Scheduled Work

Scheduled acceptance creates a new profile from explicit models, removes the copy afterward and verifies the source digest. It covers questioning, answers, single-file approval and finalization, with at most six requests and three minutes:

```bash
RUN_MODEL_CHECK=1 RUN_CODE_SCHEDULER_MODELS_FILE=/absolute/models.json npx tsx --test test/code-scheduler-model-acceptance.test.ts
```

## Personal Amendments and Reports

Personal amendment acceptance creates a fresh profile, empty skill HOME and pre-existing files outside its configured workspace. It checks that progress queries and redisplay preserve a held approval, a changed requirement supersedes the old operation in the same child, one newly approved write produces a validated publication, four separate canonical queries receive an actual no-tools final request with a grounded answer, a new background requirement explicitly continues completed work, and one mixed arrangement/query batch retains its grounded model answer. It permits at most 32 model requests and six minutes, uses no IM, and reads only the explicit literal/environment credential without executing credential commands. The check prints an external evidence directory containing model-request snapshots and synthetic call/result facts, with credentials redacted. The source configuration remains unchanged; temporary profile files and credentials are removed after the harness closes.

```bash
npm run build:worker
RUN_MODEL_CHECK=1 RUN_PERSONAL_AMENDMENT_MODELS_FILE=/absolute/models.json npx tsx --test test/personal-amendment-model-acceptance.test.ts
```

Set `RUN_PERSONAL_AMENDMENT_MODEL=provider/model` if the selected file contains several models. This checks actual model routing and the ordinary file loop; native desktop cards, real IM delivery and optional execution families require their separate acceptance.

## Personal M2 Execution

M2 model acceptance creates fresh profiles with a seeded application database and a loopback MCP fixture. It checks held batch-update and MCP-write approvals, a progress query that preserves the original decision, an amendment delivered to the same child and a fresh exact approval, then natural-language cancellation and reopen without writes or MCP sends. It permits at most 32 requests and six minutes, uses the explicitly selected literal/environment credential and writes redacted request/operation evidence outside the checkout.

```bash
npm run build:worker
RUN_MODEL_CHECK=1 RUN_PERSONAL_M2_MODELS_FILE=/absolute/models.json npx tsx --test test/personal-m2-model-acceptance.test.ts
```

Set `RUN_PERSONAL_M2_MODEL=provider/model` when the file contains several models. Real isolated Linux browser, official Cua and persistent-process checks separately establish resource ownership, fresh takeover observations, exact stopping and recovery. Application-data isolation also needs a real synchronous SQLite workload with an overlapping main reply and original worker exit/receipt evidence; delaying a Promise before SQLite does not prove that property. Desktop interaction and real IM remain separate acceptance.

## Personal Final Outputs

M4 model acceptance creates an isolated profile and pre-existing file from explicit model configuration. It checks natural background delegation, an ordinary progress query while the child waits, one exact successful write, child-only `publish_output`, validated coverage/publication and complete byte/hash verification. Reopen must preserve original records without another write or model request. The check permits at most 20 requests/six minutes and saves redacted actual payloads, tool schemas/results and request-size estimates outside the checkout.

```bash
npm run build:worker
RUN_MODEL_CHECK=1 RUN_PERSONAL_M4_MODELS_FILE=/absolute/models.json npx tsx --test test/personal-m4-model-acceptance.test.ts
```

Set `RUN_PERSONAL_M4_MODEL=provider/model` when needed. Separately verify real isolated Linux file/browser output, exact 8 MiB across authenticated chunks, partial capture, cross-profile identifiers, revocation during reads, reconnect and old-source cutover with unchanged history. Both signed desktop hosts must visibly preview text/images and save through their native dialogs with matching bytes and hashes, including a chooser held beyond 60 seconds. Canceled saves and delivery failures must preserve the original business-write count. Earlier M1–M3 acceptance retains its unchanged scope; the integrated desktop gate requires these remaining paths.

## Evidence and Cleanup

See [smoke instructions](../verification/smoke/README.md) for arguments, authentication, exit codes and cleanup. Keep credentials in protected files outside the checkout. [Release acceptance](release-acceptance.md#current-rerun-entry-points) defines upgrade baselines and old names. Missing `test:model` configuration is a skip, not a pass. Model execution and installation upgrades are separate checks; Docker history and simulated IM do not prove native isolation or real IM acceptance. [Archived privileged scripts](../verification/archive/README.md) require isolation of system writes before anyone restores execution.
