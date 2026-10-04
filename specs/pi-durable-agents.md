# Pi Durable agents: phase 1 and the remaining plan

This is the living plan for Halo's agent runtime. **Only phase 1 is implemented in this PR.** Phases 2–6 are proposed follow-up work, not APIs available today. Pseudocode describes ownership and ordering, not exact Pi method signatures.

## System flow

### Implemented in phase 1

```diagram
UI / CLI / routines
        │
        ▼
SessionRegistry ── owns loaded HaloAgentSession instances
        │
        ▼
HaloAgentSession
        ├── Pi Durable Harness ── TursoStorage ── DatabaseClient
        ├── LLMApi ── Halo's Together-backed model
        ├── direct tools / exec ── ToolRuntime
        └── committed revisions ── SessionProjection ── UI events

WorkspaceSearch ── persisted session reader ── same SessionProjection
```

### Target after all phases

```diagram
UI / CLI / routines                  another agent's exec
        │                                   │
        │                          ToolRuntime authorization
        │                                   │
        └──────────────┬────────────────────┘
                       ▼
                ┌──────────────┐
                │ AgentManager │
                │ loaded map   │
                └──────┬───────┘
                       │ open / acquire / close
                       ▼
                ┌──────────────┐
                │ AgentThread  │── unloadRequested Stream ──→ manager
                │ Pi runtime   │
                └──┬────┬────┬─┘
                   │    │    │
                   ▼    │    ▼
                LLMApi  │  Turso thread storage
                        ▼
                    ToolRuntime
                 authority / tools / tokens
```

## Problem and solution

Halo needs durable conversations without rebuilding Pi's scheduler or maintaining a second execution journal. It also needs a clear owner for loaded conversations, so old threads can leave RAM and agents can use the same operations as humans.

Keep one durable identity per conversation. `AgentThread` will be its loaded runtime, not a separate persistent entity. `AgentManager` will own the loaded instances. Pi will own execution, checkpoints, and recovery. Halo will own product APIs, authorization, presentation, and storage integration.

## Settled decisions

- One agent is one conversation with one durable ID. Do not introduce reusable agent definitions or multiple threads per agent yet.
- The manager's map is a cache of conversations, not interchangeable workers.
- The thread owns unload eligibility, its idle timer, and a lifecycle Stream. The manager owns instance lifetime and safe reopening.
- Running or queued work, active operations, and subscribers prevent idle unloading.
- Archive hides a conversation. It does not silently abort work. An archived idle thread becomes eligible for unloading.
- Abort, archive, unload, and delete are different operations. Deletion is not part of this plan.
- UI, routines, CLI, and agent tools use the same application operations.
- Direct file tools and `exec` share authorized operations; direct tools need not generate JavaScript.
- Child agents inherit no more authority than their caller. Once created, children are independent; parent cancellation stops waiting, not child execution.
- No legacy session compatibility or automatic Pi traces. Explicit trace APIs are retained in phase 1.

## Goals and non-goals

Preserve prompting, attachments, cancellation, tool activity, history, unread state, routines, and search. Keep model access behind `LLMApi`; only Halo's Together-backed model is needed today.

Do not build a second scheduler, add arbitrary provider selection, introduce a multi-agent orchestration framework, or change the direct tool inventory silently. Current direct tools also include `bash` and `viewImage`; deciding whether to remove these is separate from unifying execution.

## Sources

- [[packages/workspace-server/src/agent/HaloAgentSession.ts#HaloAgentSession]] — loaded Pi runtime and prompt/watch behavior.
- [[packages/workspace-server/src/sessions/SessionRegistry.ts#SessionRegistry]] — loaded sessions and product summaries.
- [[packages/workspace-server/src/agent/SessionProjection.ts#SessionProjection]] — committed-state projection shared with search.
- [[packages/workspace-server/src/storage/TursoStorage.ts#TursoStorage]] — durable protocol and consistent persisted reads.
- [[packages/workspace-server/src/agent/runtime/ToolRuntime.ts#ToolRuntime]] — authority, Executor, integrations, and credentials.
- [[packages/workspace-server/src/routines/RoutineRunner.ts#RoutineRunner]] — automation and interrupted-run recovery.
- [[packages/workspace-server/src/llm/LLMApi.ts]] — inference boundary.
- [Pi Durable announcement](https://earendil.com/posts/pi-durable/).

## Phase 1 — Pi 1.0 and Durable baseline: implemented

This PR migrates the runtime and storage. It does **not** implement automatic unloading or the new agent-management API. Startup still opens saved sessions; search already reads storage without opening a runtime.

```callstack
 WorkspaceServer.start [[packages/workspace-server/src/server/WorkspaceServer.ts#WorkspaceServer.start]]
 ├── TursoSessionRepo
 ├── SessionRegistry
 ├── RoutineRunner.recover [[phase1-server:new:308-309]]
 └── SessionRegistry.start [[phase1-server:new:310-311]]
     └── HaloAgentSession.attach
         ├── Harness.open(TursoStorage)
         ├── configure current model and cwd
         ├── bootstrap committed projection
         └── subscribeCommits → SessionProjection → session events
```

```ts
onCommittedRevision(publication):
  previous = snapshot
  projection.apply(publication) // whole revision, synchronously
  snapshot = projection.snapshot()
  emitNewEntries(previous, snapshot)
  emitFinishedRunBeforeReplacementStarts(previous, snapshot)
  emitActiveMessageAndToolUpdates(previous, snapshot)

activeRunId = firstInputSubmissionId // stable across model/tool rounds
```

- [x] Pin Pi and Chord to 1.0.0 and use Pi's provider/model APIs.
- [x] Retain the Turso adapter and shared DatabaseClient; replace obsolete session storage with native durable records.
- [x] Project live updates and persisted history consistently, retaining full visible history after compaction.
- [x] Persist input settlement order so completed run identity survives restart and steering.
- [x] Preserve prompt retry deduplication, tool progress, parallel tools, and unsafe-tool recovery semantics.
- [x] Keep client tool activity in model-call order even when parallel results arrive out of order.
- [x] Abort interrupted routine sessions before ordinary session resumption.
- [x] Deliver fatal storage failures to clients rather than leaving a stale running state.
- [x] Remove automatic Pi tracing and legacy entry import/dual-write paths.

**Data reset:** applying the migration discards old conversations and clears their links from routine history. It preserves unrelated workspace data. It has only been applied to disposable local test data here.

### Verification evidence and limitations

- All-package lint, format, typecheck, and unit tasks passed: 53 tasks without cache reuse.
- Latest workspace-server E2Es passed: 118 tests. The full run exposed tool-activity ordering after restoring parallel execution; the client projection now preserves model-call order, with a regression covering out-of-order completion.
- Final Electron run: 110 passed, 4 failed. All four failures also reproduced on an untouched `origin/main` checkout: heading removal with Backspace, one-character formatting reveal, Markdown find-selection restoration (intermittent), and specific attachment-error text. The earlier long-note scrolling timeout passed in the final full run. This is not a green full suite; the PR records these exceptions explicitly.
- Real Together inference was exercised through Electron: write/read a file, restart the full dev stack, recall the conversation, then read through `exec`. The resulting screenshot was inspected.
- Full all-package E2Es ran without cache reuse. Other package results: client 7 passed, extension tools 4 passed, logger 2 passed, control-plane 20 passed / 1 skipped. Only the Electron task failed.

### Actual phase-1 wiring diff

```source-diff:phase1-server:packages/workspace-server/src/server/WorkspaceServer.ts
diff --git a/packages/workspace-server/src/server/WorkspaceServer.ts b/packages/workspace-server/src/server/WorkspaceServer.ts
index a1950f76..50f27216 100644
--- a/packages/workspace-server/src/server/WorkspaceServer.ts
+++ b/packages/workspace-server/src/server/WorkspaceServer.ts
@@ -214,7 +214,7 @@ export class WorkspaceServer {
         });
     });
     const sessionRepo = new TursoSessionRepo(database);
-    const search = new WorkspaceSearch({ workspace, database });
+    const search = new WorkspaceSearch({ workspace, repo: sessionRepo });
     cleanup.defer(async () => {
       const closed = await sessionRepo.close();
       if (closed instanceof Error)
@@ -285,8 +285,6 @@ export class WorkspaceServer {
       environment: config.environment,
       repo: sessionRepo,
       llmApi: host.llmApi,
-      traces,
-      model: host.llmApi.model,
       filesystem,
       layout: workspace.layout,
       toolRuntime,
@@ -307,6 +305,10 @@ export class WorkspaceServer {
       logger: host.logger,
     });
     cleanup.defer(async () => await routineRunner.stop());
+    const recoveredRoutines = await routineRunner.recover();
+    if (recoveredRoutines instanceof Error) return recoveredRoutines;
+    const recovered = await sessions.start();
+    if (recovered instanceof Error) return recovered;
     const routineScheduler = new RoutineScheduler({
       routines,
       runner: routineRunner,
```

## Phase 2 — Explicit manager and thread ownership: planned

Refactor existing owners rather than adding services alongside them. Separate the mechanical rename from behavior changes; keep transport names unchanged initially.

```callstack
 sessionsRouter / RoutineRunner
-└── SessionRegistry → HaloAgentSession
+└── AgentManager → AgentThread
```

```ts
class AgentManager:
  loaded: Map<AgentId, AgentThread>
  new({ requestId }) -> AgentId
  prompt({ agentId, requestId, message }) -> SubmissionId
  events(agentId) -> Stream<Snapshot | Event>
  abort(agentId)
  list() -> AgentSummary[]

class AgentThread:
  static open(storage, llmApi, toolRuntime)
  prompt(message)
  events() // snapshot first, then changes
  abort()
  close()
```

- [ ] Rename the loaded-runtime and manager owners and update their consumers, preserving behavior.
- [ ] Keep thread instances internal to the manager instead of handing indefinitely retained instances to callers.
- [ ] In a separate behavior change, make prompt acknowledgement mean durable acceptance; completion is observed through events.
- [ ] Preserve idempotent prompt admission and add idempotent creation before exposing agent creation to tools.
- [ ] Verify through workspace-server E2Es and `pnpm run check-affected`.

## Phase 3 — Read idle conversations without loading them: planned

Search already uses the native reader. Extend the same boundary to catalog summaries and saved history; sidebar reads must not open every runtime.

```callstack
 list / saved history
-└── loaded session → readSummary / readSnapshot
+└── session repository → persisted projection
 live conversation
 └── manager → loaded thread → committed projection
```

```ts
list():
  return storage.listSummaries() // no Harness.open and no scheduling

history(agentId):
  return project(await storage.read(agentId))

onLoadedThreadCommit(agentId, revision):
  publishSummary(projectSummary(revision))
```

- [ ] Define one summary projection for loaded and persisted sessions.
- [ ] Remove the registry's requirement that every listed session be open.
- [ ] Keep summary changes observable without retaining per-thread UI subscriptions.
- [ ] Verify list/search/history cannot dispatch model or tool work; run server E2Es and affected checks.

## Phase 4 — Thread-requested unloading and selective recovery: planned

The thread emits `unloadRequested`, not `unloaded`. Its eligibility may change before the manager handles that event. Recheck atomically with acquisition.

```diagram
AgentThread                           AgentManager
     │                                      │
     │ idle timer expires; eligible         │
     ├── Stream: unloadRequested ──────────→│
     │                                      │ serialize with acquisition
     │←──── tryBeginUnload() ────────────────┤
     │                                      │
     │ false: new work/subscriber arrived   │ keep loaded
     │ true: state becomes closing          │ close, then remove
```

```ts
thread.canUnload():
  return !hasPendingWork && inFlightOperations == 0 && subscribers == 0

thread.onIdleTimeout():
  if canUnload(): lifecycle.append({ type: "unloadRequested" })

manager.onUnloadRequested(agentId, thread):
  lifecycleQueue(agentId).run(async () => {
    if loaded.get(agentId) !== thread: return
    if !thread.tryBeginUnload(): return
    await thread.close()
    loaded.delete(agentId)
  })

manager.prompt(input):
  using lease = await acquire(input.agentId) // same lifecycle coordination
  return await lease.thread.prompt(input)

manager.start():
  await recoverInterruptedRoutines()
  for agentId in storage.findThreadsWithPendingWork():
    (await open(agentId)).resume()
```

Keep model calls and tool execution outside lifecycle queues. A thread closing unsuccessfully must not admit a replacement storage owner until resource release is known. Idle timeout length is a tunable implementation choice, not a new product setting.

- [ ] Add thread-owned idle timer, operation/subscriber accounting, and lifecycle Stream.
- [ ] Coordinate opens and closes per agent; reject stale-instance unload requests.
- [ ] Add archive-triggered eligibility without aborting work, and resume only unfinished conversations at startup.
- [ ] Verify acquire-versus-close races, simultaneous opens, reconnect, shutdown, and restart through consumer APIs.
- [ ] Run focused server/Electron lifecycle tests and affected checks.

## Phase 5 — One authorized tool operation path: planned

```callstack
 direct read/write/edit/patch and exec
-├── direct wrapper → authority + shared file implementation
-└── Executor wrapper → authority + shared file implementation
+├── direct wrapper → ToolRuntime.invoke
+└── Executor invocation → ToolRuntime.invoke
```

```ts
directRead(args, context):
  return toolRuntime.invoke("files.read", args, context)

exec.tools.files.read(args):
  return toolRuntime.invoke("files.read", args, trustedExecutionContext)
```

Context carries agent identity, effective permissions, cancellation, and tool-call correlation. Credentials remain owned by ToolRuntime. Executor supplies JavaScript composition, not a separate authorization policy.

- [ ] Route both surfaces through the same authorized operations, one operation family per small commit.
- [ ] Preserve tool schemas, content formatting, error semantics, progress, and file-access boundaries.
- [ ] Keep current direct tools until a separate product decision removes one.
- [ ] Verify equivalent outcomes and denied operations through direct tools and exec; run affected checks.

## Phase 6 — Agents can start and message agents: planned

```callstack
 agent exec
 └── Executor plugin
+    └── ToolRuntime authorization
+        └── AgentManager.new / prompt / events / abort
```

```ts
// Agent-authored code; caller identity is injected, never trusted from args.
child = await tools.agent.new({ requestId: stableCreationId })
await tools.agent.prompt({
  agentId: child.id,
  requestId: stableMessageId,
  message: "Investigate the report",
})

// Host side
newChild(input, caller):
  authorize(caller, "agents.create")
  permissions = noBroaderThan(caller.permissions)
  return manager.newIdempotently(input.requestId, permissions)
```

Use trusted per-call context and register the plugin at server composition; do not give models control over caller identity. Authorization applies to reading and controlling other conversations as well as creation. The precise exec-friendly result-waiting shape must be chosen here; creation itself returns promptly and waiting remains cancellable.

- [ ] Expose manager operations as an authorized Executor plugin without a second agent service.
- [ ] Propagate caller identity and effective permissions; ensure cross-agent read/control checks.
- [ ] Guarantee retries/recovery cannot duplicate child creation or messages.
- [ ] Keep children independent after creation; do not implicitly cascade parent cancellation.
- [ ] Verify tool-driven creation, messaging, access denial, cancellation, and restart. Run full checks and relevant E2Es.

## Delivery boundaries

The current PR includes phase 1 and this plan only. Deliver phases 2–6 separately, splitting each into working, reviewable changes (roughly 200 changed lines where practical). No phase requires a new compatibility layer. Keep this document updated as behavior actually lands.
