# Phase 1B — Task admission, runtimes and modes

This review increment follows Phase 1A and addresses M1.1–M1.3 of the execution baseline. It changes backend admission and launch policy without deploying or restarting any service. P1 remains open for versioned migrations, idempotency/attempt fencing, credentials and worker readiness.

## Behavior and compatibility

`/api/runtimes` describes configured Prime/Pi adapters, explicit aliases, executable-file availability and trusted execution support. It does not run a version probe, read credentials or verify provider/native conformance. Hermes roster entries are not execution registrations. Unknown profiles and unsupported modes return HTTP 409; missing executable files return 503. HTTP 202 still means the task/event transaction committed, not that a worker is available or execution succeeded.

Both native adapters require explicit `approval_mode: "auto"` (Trusted execution). `approve`, `plan` and chat-only calls are refused before acknowledgment and again at dispatch/native launch. Existing clients and Telegram that submit protected modes receive a rejection/failure; source changes must never reinterpret them as permission for trusted execution. Native Pi history remains read-only. Native restriction support requires pinned conformance evidence in a later adapter increment.

Task cwd must be an existing absolute directory within the configured scratch root or the selected project's registered folders. Scratch defaults to `archon_root` for existing solo configurations; operators can explicitly narrow `task_scratch_root`. Registered projects can live outside scratch. Resumes retain the recorded canonical cwd and original runtime even when the new-session picker changes. Explicit cwd/project conflicts, native-history disagreement, noncanonical legacy ownership and missing roots require repair rather than silent fallback.

The task, initial event and initial project relation commit together. The worker repeats policy/ownership checks, and native runners repeat preflight after lock waits and before launch. Denied queued legacy/transport tasks finish as durable failures without invoking the runner. These initial-directory checks are not an OS sandbox, do not inspect every tool effect, and cannot eliminate filesystem races after validation.

Projectless admissions persist an explicit NULL binding. Deleting a project preserves its old session bindings so queued work fails instead of becoming projectless or joining a replacement project at the same path. Once idle, those sessions require deliberate reassignment before new execution. Session reassignment and its busy-task check share one transaction; a change racing task submission causes a conflict and rolls back the new task/event.

## Validation

Final frozen validation: 306 backend tests passed (one existing AnyIO deprecation warning); 72 desktop tests passed and 16 existing ASAR-dependent checks skipped. `npm run setup` completed with zero audit vulnerabilities and existing dependency deprecation notices. `git diff --check` passed. An independent review found no introduced correctness blockers within this scope. GitHub Actions results are recorded in the PR. Regression fixtures cover aliases and denial without launch, unsupported modes, runtime-file availability, canonical/symlink/missing paths, session/project ownership, transaction rollback and queued-task revalidation. Native executable fixtures are local scripts or executable files; no real agent/provider, Telegram, cron or deployed service is invoked.

## Upgrade and rollback

Review older queued requests before enabling workers: protected modes, unknown profile names, missing cwd and invalid folders now fail closed. Register intentional aliases explicitly and repair legacy session metadata only after checking its native history and workspace. Do not bulk-convert protected requests to trusted mode. Quiesce workers before changing configuration or binaries; Phase 1A's directory-lock migration gate still applies.

No database schema migration is introduced here. Existing nullable `session_projects` records are used for admission binding. Downgrading loses these admission/mode protections and can execute prompts under unsupported policy claims; drain work and review configuration/queue state before any rollback. Atomic ownership under concurrent project/session mutation and durable attempt fencing remain Phase 1C work. Native desktop/credential behavior and missing private ASAR/source remain unverified.
