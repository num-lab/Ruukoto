# Personal Durable Conversations

## Responsibilities and Boundaries

`apps/ruukoto/src/personal-*.ts` owns the Personal product's Pi 1.3.0 durable runtime: one main conversation, persistent analysis, schedules, memory and local/IM/remote entry points. It provides command workers, browser tools, application-data access, approvals and structured owner questions. File and application SQLite operations run in fixed workers outside the host event loop and Session transactions. A stuck file job leaves unrelated file operations available while capacity remains.

Main delegates waiting business calls to SubAgents: its requests omit ordinary tools, app-data, MCP calls, service inspection/restart, commands, browser operations and process startup. Independent scheduled conversations retain their original captured scope. Main execution safeguards return handled errors before effects. Each owner input may commit at most four persisted tool-call batches; a noncompliant overrun stops the input through a durable cutoff that cancels exactly the work it admitted, appends a public marker with the cancellation registration, and notifies the original local or IM entry factually — cancellation registered is never reported as physically stopped — while a compliant model simply answers in prose once the offer is empty. While a cutoff's cancellation registration is unfinished, new main submissions are admitted durably as queued — accepted immediately, never self-placed — and the coordinator places the queue itself once registration completes; queued inputs are parked so that foreign writes such as background compaction summaries can never advance them ahead of a pending registration, and a run that ends without a boundary likewise leaves the queue to the coordinator, which applies the same final boundary its callers would have.

[Deployment](deploy.md) owns systemd configuration; [runtime](runtime.md) describes the separate Coding engine; [execution](execution.md) describes shared native primitives.

## Public Interfaces

| Command | Purpose |
| --- | --- |
| `ruukoto` / `npm start` | Guided models, backend, recent conversations, permissions and pending questions |
| `ruukoto serve` | Foreground durable backend; `--directory` fixes the profile |
| `ruukoto settings` | JSON model/MCP management and read-only fixed-root skill queries, online or offline |
| `ruukoto maintenance` | Verify and explicitly control the production service |
| `ruukoto remote` | Pair/revoke remote devices; host HTTPS/WSS with `remote serve` |

| Tool family | Tools and responsibility |
| --- | --- |
| Analysis/delegation | `background_work`: persistent children, amendments, bounded operation/decision queries, redisplay and published reports |
| Questions | `ask_user`: one to three structured questions; main admits a continuation after answers, while a child waits in its original work and tool call |
| Scheduling | `schedule_create`, `schedule_query`, `schedule_cancel`: independent timed work, with separate occurrence and future-plan cancellation |
| Memory/history | `memory`, `history_search`, `history_read`: versioned facts and history lookup |
| Files/network | `read_file`, `write_file`, `web_search`, `http_request`, `list_files`, `search_files`, `read_artifact`: child-side access within granted scope, with approvals where required |
| Browser/computer | `browser` and configured Cua tools: host-qualified child work, serial resource ownership, fresh takeover observations |
| Application data | `app_data_*`: explicitly delegated business database access; fixed SQLite worker jobs |
| Persistent processes | `process_start`, `process_status`, `process_output`, `process_stop`: work-owned startup and independent lifetime across replies |
| MCP | `mcp_tools`, `mcp_call`, `read_mcp_result`: eligible discovery, calls and original results; Pi handles transport/paging |
| Final files | `publish_output`: child-only registration of owner-requested final artifacts or successful write content; validated report publication fixes delivery membership |

## Data and State

```mermaid
stateDiagram-v2
  [*] --> MainReady
  MainReady --> AcceptedInput: Local, IM or desktop
  AcceptedInput --> Model
  Model --> WaitingForAnswer: Main ask_user
  WaitingForAnswer --> Model: Admit main continuation
  Model --> BackgroundAnalysis: background_work
  BackgroundAnalysis --> WaitingWorkQuestion: Child ask_user
  WaitingWorkQuestion --> BackgroundAnalysis: Return original answer
  BackgroundAnalysis --> ReportDraft: Covered inputs and work settled
  ReportDraft --> PublishedReport: Current coverage verified
  ReportDraft --> BackgroundAnalysis: Accepted requirements changed
  PublishedReport --> OriginalEntry: Original destination verified
  Model --> ReplyReady
  ReplyReady --> OriginalEntry: Verify destination
```

| Data | Authority |
| --- | --- |
| Conversations, children and analysis reports | Durable SQLite under the profile, default `~/.ruukoto-durable/` |
| Questions/answers/receipts | `ruukoto.questions`: original call/work binding, immutable answers and single-use receipts |
| Memory and skills | `ruukoto.memories`, `ruukoto.skills` and entries: revisions, revocation, source/body snapshots and invocation evidence |
| Schedules | `ruukoto.schedules`: rules, runs, execution snapshots and delivery credentials |
| Business data | `agent-data/main.db` |
| MCP | `mcp.json` configuration v4 and durable operation entries |
| File I/O | Versioned job admissions and lifecycle entries: original tool/work/source, host identity, immutable input, deadline, settlement and stopping evidence |
| Work and report selections | Actual model-request evidence: received instructions, native inputs and report source/coverage |
| Interactive resources | Host work qualification, FIFO claims, acquisition and release entries with original stop evidence |
| Published reports | Immutable publication references to original answers; drafts remain inspectable in conversation history |
| Final outputs | Immutable instruction/source-bound intents and artifact bytes; report coverage/publication fixes at most eight file references |
| Telegram displays and delivery | Original card occurrences and opaque actions; exact text/file parts, ordered claims and separate callback/edit receipts |
| Native owner display | Data-only admission entry and reciprocal request/submission/history association; native model history remains unchanged |
| Native choices and recovery | Original family records, `ruukoto.desktop-action` intent/outcome receipts, immutable owner claims and fixed checks |

MCP v4 separates locally configured tool effects from remote definitions. The owner explicitly migrates configuration through management before new ordinary-service work is admitted. Save/apply receipts make migration recoverable. Existing credential references and their byte-digest semantics remain; explicit credential rebinding switches to the actual-token digest. Migration invalidates old unstarted approvals, preserves old unknown calls and keeps original computer stopping/recovery manageable.

Before each model request, skills refresh from the backend account's `$HOME/.agents/skills/` and save a full snapshot. The initial model view contains names/descriptions; `skill` loads bodies or references, and main supports `/skill:name arguments`. A child uses `run_command` to execute a script by its skill-directory path under the original work permissions. Restricted commands mount eligible directories from the original request snapshot read-only; binding evidence is recorded with command admission and intent. Source is not read by default. Current discovery is separate from old library configuration/managed state; schedules with incompatible old sources stop explicitly and require cancellation/recreation.

## Main Flows

```mermaid
sequenceDiagram
  participant Owner as QQ / Telegram / desktop
  participant Entry
  participant Harness
  participant Analysis
  participant Reply
  Owner->>Entry: Text or media
  Entry->>Harness: Persist admission and original source
  Harness->>Harness: Advance main conversation
  opt Background analysis
    Harness->>Analysis: Delegate
    Analysis-->>Harness: Report
  end
  Harness->>Reply: Create reply with fixed source/generation
  Reply->>Owner: Verify and send to original entry
```

Platform message identity deduplicates admission. Auto-review handles eligible read-only operations; sensitive actions follow the original platform's approval flow. Replies retain the original platform, account, owner and generation.

### Telegram Cards and Complete Results

Telegram sends proactive cards from the same canonical operations and questions used by native clients. Each display fixes the original admission, occurrence, private entry and opaque action tokens. A choice requires the bound owner, current generation and confirmed bot-message identity, then rechecks the original action's eligibility. Callback acknowledgement and terminal editing have separate durable receipts; their failure cannot undo a committed choice or make a stale button eligible. An explicit redisplay retains the same decision and earlier send facts.

Startup recovers saved configuration before starting card projection and resuming work. The initial projection finds pending decisions from their canonical records, including those retained across a restart.

One-shot approval direct replies accept only the exact words and listed numbers in the [Telegram delivery decision](../../.agents/notes/implemented/architecture/2026-11-06-personal-telegram-delivery.md), and require the original display to offer that approval action; other text remains ordinary chat. Question answers and applied/not-applied owner claims retain their own actions. Cua recovery uses the existing canonical recovery task with the original IM actor and captured pause/observation. An explicit `查看原电脑现场` read sends the saved observation's original images through the shared ledger; acceptance requires confirmed delivery of every image before its own admission. Inspection is separate from final publication, and the owner must open and check the images. Exact cleanup, fresh observation acceptance and explicit whole-sandbox stopping remain separate.

Owner replies, question continuations, reports, scheduled results and long card bodies share one ordered delivery ledger. It stores exact original text and sends pieces of at most 4096 UTF-16 code units without dividing a surrogate pair. Each claim rechecks source, cancellation and caller authority, persists before dispatch, and uses the pinned sender outside the short platform mutex. Later pieces require confirmed earlier text. A known text failure or uncertain send stops the remainder; a verified Telegram rate-limit rejection may delay that same piece within three total attempts. Reopen waits for the canonical delivery reference and retains confirmed message IDs or original uncertainty.

Reopen validates immutable received-entry backlinks and exact delivery ownership before continuing transport. Host faults reconcile unclaimed pieces as canceled and claimed pieces as unknown after integrity scans finish, preserving fault outcomes and committed choices. Parentless sends need an issued card or accepted original-text/recovery-image request; sharing the owner's private entry is insufficient authority.

Adding Telegram's host delivery, display and callback tasks leaves a schedule's business scope unchanged. A proven unsent historical report can deliver its complete stored result once after upgrade; its original scope and formatter admission stay intact. Business tools, configuration/material changes and original-entry generation still gate execution and every send claim.

Published final files follow the text using complete original bytes, up to 8 MiB each, with SHA-256 validation and the existing eight-file publication limit. Text and file outcomes are independent: a pending or failed attachment does not hide already confirmed text and never repeats work. `/结果` pages original results from the same private entry; explicit selection sends saved original text through a new retrieval intent while keeping old receipts unchanged. Normal long delivery advances automatically. Typing is best effort while ordinary replies are pending and establishes no acceptance or model-speed guarantee.

### Final Files and Setup

A child registers an owner-requested final file through `publish_output`, using an artifact returned by its current work or the original content of that work's successful stopped write. No extra read or business write is needed. An amendment excludes older unpublished selections; validated report coverage and publication freeze the current file IDs. Published history remains unchanged after later requirements or failed delivery.

Authenticated `/desktop/output` reads only members of that original publication in at most 128 KiB chunks. Every response rechecks the paired identity and profile. Complete output remains limited to 8 MiB; partial capture stays visible but cannot be downloaded as complete. Native clients verify metadata, full size and SHA-256. File publication, business success and delivery outcome remain distinct.

Before output capability is added to an old profile, pending work/questions, unresolved effects and retained resources must settle under the original program. The check precedes Harness activation. Existing schedules keep their captured ceiling and direct scheduled execution excludes publication. Recovery verifies original source, permission, work/request provenance and artifact bytes without rewriting historical entries.

Settings reads provide compatible installed per-model presets for the model wizard and desktop editor. Custom model fields and existing API/authentication choices remain available. The administrator entry groups Configuration, Status/Start/Stop and Advanced Management. Desktop/local/Telegram share a future-input permission default; QQ retains its own. Desktop saves bind the original connection and inspect actual values after a lost response.

### Work Questions

An eligible child's `ask_user` holds the original ToolTask while its WorkTask and acquired resources remain owned. Each independent work can have one pending batch of up to three questions, so several works can wait while main keeps responding. Answers return through the asking tool under the original work's model, permissions and source. Main's own questions retain their separate pending-return and continuation path.

Controls bind each answer to the exact question batch. Ordinary messages coordinate main; accepted amendments stay saved until the child's next model request with the answer. The asking model generation cannot execute sibling business calls, including after answer acceptance or cancellation. A later request prepares effects against the current instructions.

Answer acceptance, original tool return and WorkTask completion are separate persisted facts. A fixed receipt recovers a lost answer response without answering twice. Canceling work invalidates pending questions or records a canceled continuation for an accepted answer that has not returned. Reopen verifies the original question, work, source, answer and tool-result references before resuming a safe wait; current defaults or a replaced IM generation cannot acquire the old answer authority.

### Amendments and Final Reports

Main handles a progress question through canonical work and operation queries. Work results include current MCP, app-data, browser, process and resource state alongside command, service and ordinary-tool facts. A requested redisplay identifies the same original decision and grants no approval. An append records changed or additional requirements for the same work and SubAgent. Every accepted append makes its older unstarted operations known not executed across enabled families, including approved but unconsumed actions, while preserving their requests and decisions. The child reads the saved update at a model boundary and prepares a new exact action. Admission and consumption check what that actual request received and the current live input membership, including delayed old responses and note-only runs. Misclassifying a progress question as append has the same conservative invalidation cost; a started effect cannot be undone by an amendment.

Work result queries expose at most eight facts per family. `factsOffset` and `nextFactsOffset` page those facts independently of the answer's `offset` and `nextOffset`; summaries and delegation progress include the first fact page. When facts are paged, `factCounts` gives each family's total, pending and unknown counts across all records. A missing operation on one page does not establish that work has no pending decisions or unknown effects. Process facts show brief status; process management retains the original command and output details.

Delegated requirements preserve the owner's exact target, literal content and restrictions without adding verification effects. Progress and redisplay answers use concise natural language; internal identifiers, fields, tool names and versions are reserved for requested technical evidence. These instructions guide the model; actual model-request captures and scenario interaction provide separate evidence of its behavior.

A completed, stopped file-write receipt confirms the requested full UTF-8 content was written and synchronized during that execution. Its result asks the model to report the completed write, without requiring an extra read. This does not establish later filesystem contents; failed or unknown writes retain their original recovery requirements.

The WorkTask supervises every accepted note until it is answered or accounted for by failure/cancellation. Native input failure stops new dispatch; original keys reconnect after restart without replaying the instruction. Every contributing owner input must remain active, including an appended source whose coordination failed before cancellation registration. Reopen verifies each immutable note admission against its work and ordered note projection rather than silently dropping missing records.

Grouped work automatically registers host reporting intent and remains open to additions. Reports wait for main's contributing arrangements, accepted work and necessary effect/stopping checks. An owner input accepted before native placement delays publication until it is classified. Each summary pins its covered sources, notes, answers and operation facts, and the host checks coverage again before publishing. Changed requirements supersede an unpublished draft; an unchanged query lets the existing summary continue. Main stays available while the report task waits.

Only the validated publication appears as a normal desktop final answer. Internal report inputs, tool traffic, partial streaming and the raw draft stay out of that projection; history can still inspect them. Publication references the original complete answer without duplicating a model message, and the history API pages its full body. Later accepted requirements preserve published history and register a successor. If the original work already completed safely, model-facing append creates a linked new work in the same idle SubAgent under the original delegation authority; failed, canceled or unknown work cannot automatically continue.

### Desktop Observation

The authenticated snapshot/event stream projects decision and recovery cards for ordinary tools, application data, MCP/Cua, service restarts and inspections, commands, browsers and managed processes, together with owner questions, work/delegation state, actual model-read evidence and explicit publication. Public commit notifications wake bounded updates independently of main's model events. Original admission and redisplay anchors determine card placement; each operation's current state updates every occurrence. List pages contain at most eight items, and exact parameter/target bodies use immutable pages. Subscription sequence detects transport gaps, while commit revisions discard older canonical state within the same backend run.

Native owner text receives a data-only display entry in its admission transaction, including when queued. Reciprocal indices associate the original request and native submission with eventual user history. Projection validates body and identity, hides the associated raw row once covered by the display cut, and preserves entryless withdrawal as unanswered. Custom report/question/IM inputs retain their existing projection. Contradictory referenced records fail explicitly instead of moving or omitting another owner's message.

### Native Recovery Choices

`/desktop/action` binds a choice to its original family, operation, admission, displayed occurrence and stable request ID. Admission checks the source and current allowed action; one unresolved action occupies that card. `/desktop/action?requestId=...` returns the exact canonical request and outcome for response-loss inspection. The action ledger owns intent and receipts, while each family still owns its approval, question, effect and stopping records.

| Fact | Meaning |
| --- | --- |
| Original receipt | Outcome of the recorded execution; an application-data audit receipt can establish commit, while a command receipt establishes that execution returned |
| Current observation | State of the original known target now; a URL or service observation does not establish the earlier write's effect |
| Owner effect claim | Immutable applied/not-applied statement with authenticated source, time, card and optional fixed-check reference; the original unknown result remains inspectable |
| Stopping evidence | Proof about the exact original execution, independent of effect settlement and reply delivery |

Checks run as bounded host tasks against original receipts or the known target under its recorded machine, configuration, URL and credential identity. They do not repeat the write or adopt current default permissions. Eligible native effect claims need no freeform evidence; legacy evidence stays readable. Application data retains audit-receipt recovery, ordinary MCP retains end-with-unknown, and Cua retains its verified-stop and fresh-observation sequence.

Cleanup drains the recorded file job, inspection, command or service launcher, browser session, managed process or captured Cua CLI launch. It leaves unrelated work available and does not seal the file profile's admission namespace. Unknown stopping retains the original resource and directory occupancy.

### File Operation Lifecycle

Preparation returns immutable file identity and content evidence, without holding a worker through an approval wait. Successful pre-review revalidation leaves pending owner approval intact across restart; execution still requires fresh post-approval revalidation. After approval and revalidation, the host reserves execute capacity before the short authorization/claim/start commit. The fixed worker then checks the original file again and executes once; artifacts and observations retain the original operation identity.

Capacity is four reserved, starting, live or stop-unverified workers per profile. An unused reservation releases locally; a started worker releases capacity only on its exact exit. Job deadlines are 120 seconds and termination grace is 5 seconds. A deadline or a terminate request ends the caller's wait, not proof of worker exit. Four OS-stuck workers leave file operations unavailable until actual exits, verified original-host termination or storage repair.

Stopping is unresolved from job admission, including before its worker starts. Revocation or changed requirements can terminalize an unstarted operation as known not executed while revalidation still stops independently; original decisions and later exact stop evidence remain visible.

Capacity denial before approval consumption is terminal and known not executed. The original approval remains history, but neither a freed slot nor same-key replay can execute it later. A new operation requires fresh preparation and whatever approval its normal policy requires. A lost dispatched write retains unknown effects and its directory claim; even worker exit does not release that claim until the effect is independently resolved. Interrupted preparation and reads have no write effect, but still require actual stopping evidence before their work is released.

Shutdown establishes the file-admission fence even before the first job, collects stopping and queued evidence while Session storage remains available, then closes storage and releases the profile lock. An unverified grace timeout leaves the Session, control entry and lock available for inspection and another stop request. Unexpected storage failure retains exact in-memory receipts for same-process recovery and keeps exclusion over live workers. Completed legacy file history remains verifiable; unfinished legacy operations must be handled with the original version before activation.

### Finalizing an Unknown MCP Call

When a sent write/unknown-effect call loses its reply, its source stops automatic business calls. An interrupted authorized read is a read failure instead. The owner can choose to end that work while keeping the result unknown. The work-ending path stops local execution; after member tasks and real resources are verified terminal/stopped, a final unknown-result report goes through the original-entry sending ledger.

Manual finalization adds facts; it never removes the original source's automatic-execution prohibition. New independent owner input may use the same service: its URL is not a business-resource lock. Old SSE reinspection tasks retire without networking after restart; recovery and queries read original records.

### Interactive Ownership and Persistent Processes

Original full-access work receives a host-recorded controlled identity for configured browser, computer and process capabilities. One assignment holds a managed browser or Cua sandbox resource; later assignments persist in FIFO order with their original permissions. Normal completion and cancellation close the original browser or CLI and wait for exact stopping and required effect evidence. Resource release and WorkTask completion commit together after checking notes accepted during cleanup, so an active amended work keeps its original claim. Unknown stopping keeps the work and resource owned while main answers other inputs.

Browser takeover requires an original-entry continuation choice and a new snapshot before later actions. Browser connection management targets the current child owner and binds stopping and its evidence to the captured original execution; a historical operation cannot stop or mark a reused child's later browser stopped.

Cua requires a new screenshot and acceptance of that exact observation before the owner resumes the corresponding pause, including when a paused in-flight call later succeeds. Old choices and observations cannot resume a later pause. A later connection-stop failure can be rechecked while preserving the accepted takeover. CLI cleanup reserves recovery ownership and preserves the Linux sandbox; stopping the recorded whole sandbox requires a separate explicit owner choice because memory and unsaved application state may be lost. The existing Cua connection handles one configured target at a time and refuses another while occupied or stopping. A successor for the same resource waits for cleanup or recovery to finish and rechecks its original instructions before connecting. Reopen verifies all resource participants and release evidence against immutable history.

Processes survive ordinary child replies under their original assignment and directory claims. Canceling that assignment stops only its owned managed executions, even after the WorkTask has completed. Reused SubAgents cannot manage another work's processes. Historical processes retain their original provenance; directory conflicts and unknown stopping still prevent unsafe writes.

### Application Data and Schedule Cancellation

App-data work requires explicit delegation eligibility. Fixed worker jobs open only the bound application database, perform preparation/query/write/receipt inspection, and exit before results are used. Each handle waits at most one second for a SQLite lock, including concurrent WAL recovery at opening; an expired opening wait reports busy rather than a missing or corrupt database. Inspection/query/receipt jobs request termination after two seconds, initialization/writes after ten seconds. Aborts, deadlines and profile close join the original worker; an active native SQLite call can delay exit while main remains available. A host crash ends all writer threads. Started writes recover from original audit receipts without replay. Approval records no database wait inside the Session transaction, and the application write transaction rechecks the approved revision. Receipt recheck is an independent host task.

Canceling one scheduled occurrence records its original owner authority, cancels its derived work and leaves future triggers intact. Canceling the plan also stops future triggers. A later plan cancellation preserves an earlier run cancellation entry. Unknown effects and unverified resources keep the original run occupied until their existing verification paths settle.

## Invariants and Failure Handling

- One instance owns one exclusive durable Harness; local, IM and desktop entries share its conversation facts.
- IM approvals/questions require the bound owner in the original platform/private chat. Native may inspect or cancel an IM question but cannot answer it; an answer grants no tool approval or permission increase.
- Restart recovery reconciles pending work without repeating completed facts or replaying unknown external effects.
- Accepted follow-up instructions keep the original work's SubAgent and stable native keys: the same task steers each accepted note into that conversation in admission order, supervises every submission through completion, cancellation or failure, and reports each note's real state instead of replaying it under a new key.
- A local empty model answer without persisted handoff facts reports an error while retaining the original native history.
- Unstarted operations across enabled families require the instructions actually present in their recorded model request; a later append cannot leave an older action executable.
- Report publication and external send claims verify their covered requirements independently. Published history stays immutable, and an already-started send keeps its original outcome identity across successor reports.
- Desktop approval remains the original native/IM operation decision. Display, redisplay and client reconnection grant no authority; native cannot approve an IM-origin item.
- Sending retains destination and outcome identity across connection failures. An inconclusive sent operation is not automatically retried as if unsent.
- Telegram display, callback acknowledgement, card editing and delivery facts do not grant or replace canonical business authority. Pending pieces stop on source or requirement changes; started sends retain their observations.

## Design Rationale

- [Personal product entry](../../.agents/notes/implemented/simplification/2026-10-18-personal-product-entry.md)
- [Personal tailscale https](../../.agents/notes/implemented/architecture/2026-10-24-personal-tailscale-https.md)
- [Personal token atomic publish](../../.agents/notes/implemented/bug-fix/2026-10-24-personal-token-atomic-publish.md)
- [Detach terminal from task runtime](../../.agents/notes/implemented/architecture/2026-09-19-detach-terminal-from-task-runtime.md)
- [Mcp host responsibilities](../../.agents/notes/implemented/simplification/2026-10-26-mcp-host-responsibilities.md)
- [Home skills discovery](../../.agents/notes/implemented/simplification/2026-10-28-home-skills-discovery.md)
- [Personal file operations worker](../../.agents/notes/implemented/architecture/2026-11-02-personal-file-io-worker.md)
- [Per-job bounded file-I/O workers](../../.agents/notes/implemented/architecture/2026-11-03-personal-file-io-jobs.md)
- [Personal main handoff yield](../../.agents/notes/implemented/architecture/2026-11-02-personal-main-handoff.md)
- [Personal bounded main coordination](../../.agents/notes/implemented/architecture/2026-11-03-personal-coordination-cutoff.md)
- [Personal same-SubAgent work-note supervision](../../.agents/notes/implemented/architecture/2026-11-02-personal-work-note-supervision.md)
- [Personal work amendments and canonical decision queries](../../.agents/notes/implemented/architecture/2026-11-04-personal-work-amendments.md)
- [Personal foundation integration and failure evidence](../../.agents/notes/implemented/bug-fix/2026-11-04-personal-foundation-integration.md)
- [Personal validated report publication](../../.agents/notes/implemented/architecture/2026-11-04-personal-report-publication.md)
- [Personal desktop file loop](../../.agents/notes/implemented/feature/2026-11-04-personal-desktop-file-loop.md)
- [Personal execution across waiting capabilities](../../.agents/notes/implemented/architecture/2026-11-04-personal-m2-execution.md)
- [Personal work questions](../../.agents/notes/implemented/feature/2026-11-05-personal-work-questions.md)
- [Personal desktop canonical choices](../../.agents/notes/implemented/feature/2026-11-05-personal-desktop-decisions.md)
- [Personal native recovery facts](../../.agents/notes/implemented/architecture/2026-11-05-personal-desktop-recovery.md)
- [Personal final-file publication](../../.agents/notes/implemented/architecture/2026-11-05-personal-final-outputs.md)
- [Personal Telegram cards and complete delivery](../../.agents/notes/implemented/architecture/2026-11-06-personal-telegram-delivery.md)
- [Personal setup presets and administration](../../.agents/notes/implemented/feature/2026-11-05-personal-setup-presets.md)
