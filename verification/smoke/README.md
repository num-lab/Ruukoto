# Product Verification Entry Points

Run from a complete checkout with dependencies and native assets built. Scripts create temporary profiles and workspaces, use mock or explicitly selected real models, and clean up only after verified stopping. Run the same commands in an isolated Linux checkout; scripts 04/13/15 do not upload source over SSH or accept remote deployment arguments.

| Command | Coverage | Prerequisites |
| --- | --- | --- |
| `npm run test:native` | Native edit/check/approval/reaping, SubAgent messaging and recovery, using mock models | `npm run build`, Linux bwrap/AppArmor, a user manager and delegated cgroup scope; [native setup](../../deploy/native/README.md) |
| `npm run test:release-model -- --models /absolute/models.json --model provider/model` | Real native repair with failing/passing checks, work after TUI exit and reconnect | Build, native prerequisites, Python PTY and independently usable explicit model configuration |
| `RUN_MODEL_CHECK=1 RUN_WORKFLOW_MODELS_FILE=/absolute/models.json npx tsx --test test/123-workflow-model-acceptance.test.ts` | Workflow startup, chat while waiting, original-task questions, real tools and final reporting | Native workers and explicit compatible DeepSeek configuration; failure preserves the temporary profile |
| `npx tsx verification/smoke/smoke-26-native-worker.mts` | Actual tools/compiler, file/network denial, identity/hardlinks and startup cancellation/reaping | Build and the macOS supervisor or Linux bwrap/profile/user scope |
| `npx tsx verification/smoke/smoke-26-native-worktrees.mts` | Actual runtime/control/native repair, read-only delegation, parallel work copies and explicit integration | Build and platform native prerequisites |

`test:native` runs 04/13/15 sequentially. Exit 0 means the named checks passed, 1 means a check or cleanup failed, and 2 means invalid arguments or missing prerequisites. `test:release-model -- --help` describes its explicit inputs. Model calls can incur charges.

## Profiles and Model Configuration

All active scripts use the sole `ruukoto` entry and core's `ruukoto-single-v1` profile contract. Raw data/agent/control/pending selections go to child processes; resolved paths remain in-process. Old configuration, history and pending requests are never imported. [Issue #58](https://github.com/num-lab/Ruukoto/issues/58) owns predecessor preservation, crash recovery, client identity and integrated acceptance.

Real-model smoke copies only the selected provider/model into a temporary `0600` file. Offline configuration/authentication preflight uses the same child-environment allowlist as startup, explicit auth/model paths and no catalog refresh. Adjacent `auth.json`, daily profiles and inherited model API keys are not discovered. Thinking is off; select a model that supports it. Missing independent authentication exits 2 before model execution.

## Environment and Cleanup

Linux launchers require correct `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` for the actual backend account; restricted workers do not inherit them. Native temporary HOME/TMPDIR uses host storage without a quota. Smoke records its actual execution units and cleans only after verified stop and observed empty/removed Linux cgroups. Runtime-stop or model-server cleanup failure exits 1 and preserves the evidence directory.

Native-worktree smoke uses synthetic configuration and data. Git initialization itself runs through the native worker; work-copy creation and integration use restricted runtime entries while the parent remains active and owns its directory. Mode/grant changes, IPC and whole-unit stopping have separate probes.

Historical two-product, in-place upgrade and Personal acceptance are not active rerun commands. Git history, sealed notes and the independent pre-cutover source archive preserve that evidence. [Archived experiments](../archive/README.md) are nonexecutable records, not permission to restore privileged deployment or operate an existing service.
