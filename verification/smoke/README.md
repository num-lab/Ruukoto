# Product Verification Entry Points

Run in a checkout with dependencies installed. Scripts use their own temporary profiles/workspaces, mock or explicitly selected real models and isolated execution units. Cleanup follows verified stopping. There is no SSH-upload entry: run the same commands in an isolated Linux checkout. Scripts 04/13/15 accept no arguments; legacy `--remote` reports a prerequisite error.

| Command | Real resources and substitutes | Prerequisites |
| --- | --- | --- |
| `npm run test:native` | Coding 04 native edit/check/approval/reaping, 13 SubAgent messaging, 15 recovery; local mock models; no Personal IM/scheduling/legacy composition | `npm run build`, Linux installed bwrap/profile, user manager and delegated scope/cgroup; [native setup](../../deploy/native/README.md) |
| `npm run test:upgrade` | Temporary old/new Coding installs and preservation of history/approvals/artifacts/work copies; mock model; never loads old Personal profile into new entry | npm, tar, available lockfile dependencies and Git baseline `8bccb8f` or explicit `SMOKE24_BASE_TAR` |
| `npm run test:release-model -- --models /absolute/models.json --model provider/model` | Real native code repair with before-fail/after-pass, PTY exit/continued work/reconnect; model charges possible | Build, native prerequisites, Python PTY and explicit independently usable credentials/configuration |
| [Personal durable management](../../docs/usage.md#25-personal-agent-management) | Separate-backend restart, real memory/skills/business-data and original-request evidence; no IM | Pi1.3.0, explicit model opt-in/configuration, credentials via process environment only |
| `RUN_MODEL_CHECK=1 RUN_WORKFLOW_MODELS_FILE=/absolute/models.json npx tsx --test test/123-workflow-model-acceptance.test.ts` | Declared Coding/legacy-shared DeepSeek workflow startup, chat while waiting, business answers, real tools and one final report; no real IM | Built native worker and independently callable explicit DeepSeek config; preserve profile on failure |
| `npx tsx verification/smoke/smoke-26-native-worker.mts` | Mock model, actual four tools/compiler, file/network denial, identity/hardlinks, startup cancellation/reaping | Build and macOS supervisor or Linux bwrap/profile/user scope |
| `npx tsx verification/smoke/smoke-26-native-worktrees.mts` | Mock model, actual runtime/control/native repair, scoped read-only delegation, parallel worktrees, shared-Git write denial/integration | Build and platform native prerequisites |

`test:native` runs 04/13/15 sequentially. Old Personal 18/27/28 are no longer active entry points. Exit **0** means all checks passed; **1** means a check/execution/cleanup failure; **2** means invalid arguments or missing prerequisites, never CI success. `test:release-model -- --help` describes arguments. Model and upgrade gates are independent.

## Environment and Cleanup

Personal durable OS acceptance runs separately in an isolated Linux profile; Coding smoke is not a substitute. `TMPDIR` selects temporary storage. Launchers need correct `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` for user scopes; restricted workers do not inherit those variables. Native temporary storage uses host disk without a quota, and unverified stopping retains evidence.

Real-model smoke copies only the selected provider/model from `--models` to a `0600` temporary configuration. Before TUI startup, `probeModelConfig` verifies configuration/authentication/effort/budget offline under the same child-environment allowlist, with explicit temporary auth/models paths. It neither refreshes online catalogs nor calls the model in this preflight. Headers alone do not prove SDK authentication. Adjacent `auth.json`, daily profiles and inherited model API keys are not automatically read. Thinking is off, so choose a model supporting that setting. Missing authentication exits 2 and removes temporary configuration. Real IM is always disabled.

Coding smoke records actual execution units and cleans only after verified stop and observed Linux cgroup empty/removal. Recovery cleanup separately attempts runtime stop and mock-model closure. Either failure counts as FAIL, exits 1 and preserves temporary evidence.

Native-worktree smoke accepts no arguments and uses only synthetic configuration/data. Git initialization itself runs through the native worker; work-copy creation/integration use restricted runtime entries. The parent remains active and occupies its directory during delegation. Exit 0 proves its eight checks, 1 reports actual failure, 2 native unavailability. Failure preserves evidence. Mode/grant changes, IPC and whole-unit stopping require their separate probes/worker smoke.

## Upgrade Verification

Upgrade builds both versions and checks consumed approvals, JSONL, exact artifact bytes and real modified work copies. Raw SQLite seeds exceptional unverified-stop states; the upgraded runtime must retain interruption, unknown effects, paused queues and exact occupancy. That fixture does not replace real force-kill evidence. Even a passing upgrade retains its two intentionally abnormal occupancies/profiles; it neither resumes their queues nor deletes evidence. Other unverified stops/cleanup failures exit 1.

Default baseline `8bccb8f` carries `ruukoto-code` product identity. `SMOKE24_BASE` may select another revision with the same entry, identity and current control protocol. Without Git history, supply a trusted archive:

```bash
SMOKE24_BASE_TAR=/absolute/base.tar npm run test:upgrade
```

A shallow clone missing the baseline exits 2. Historical `1aba2f1` evidence used the old `ruukoto-dev` name; current smoke does not test cross-product-name/data-identity migration and does not reinterpret old evidence as that guarantee.

Current reruns use 04/13/15 and 24, including `pty-run.py`. Historical Personal 18/27/28 remain release evidence, not executable old-product reruns. Privileged 09/10 drivers, remote orchestration/backendctl and Linux full-access 24 are retained as nonexecutable text in [archive](../archive/README.md). They depend on sudo/systemd and formerly overwrote persistent deployment paths; restoring execution requires independent exercise resources and a complete cleanup contract first.
