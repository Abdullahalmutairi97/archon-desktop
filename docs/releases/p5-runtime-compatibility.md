# P5 — published runtime compatibility table

Scope: what the desktop may offer per runtime, derived from the server manifest
(`GET /api/runtimes`) and the provider authentication state
(`GET /api/local/secrets/auth-states`) instead of a hardcoded list.

The table below is the published matrix. `desktop/src/shared/domain/runtimeCompatibility.ts`
is the single place that renders it, and a test fails if the server manifest publishes a
capability key that the table does not cover, so a capability cannot silently disappear
from the interface.

## Capability matrix

| Capability | Prime (print adapter) | Pi (print adapter) | Meaning of the value |
| --- | --- | --- | --- |
| `modalities` | `prompt` | `prompt` | Request shapes the adapter accepts |
| `resume` | unsupported | unsupported | Continuing a previous native session |
| `fork` | unsupported | unsupported | Branching from a previous session |
| `steer` | unsupported | unsupported | Sending input to a running turn |
| `approval` | unsupported | unsupported | A native approval channel |
| `read_only` | unsupported | unsupported | A native read-only execution mode |
| `chat_only` | unsupported | unsupported | Text-only execution with no tools |
| `reconnect` | `task_event_replay` | `task_event_replay` | How an interrupted view recovers: replay this server's stored events, not a provider-side resume |
| `resource_formats` | `print` | `print` | Resource formats the adapter materializes |
| `transports` | `stdio` | `stdio` | How the adapter talks to the runtime |

An unsupported value is shown as `unsupported`, and a manifest that omits a key shows
`not declared`. Neither is hidden.

## Identity facts shown next to the matrix

| Field | Source | What it does not prove |
| --- | --- | --- |
| `available` | The configured executable is a file with the execute bit | That the runtime authenticates or answers |
| `availability_check` | Which check produced `available` | Anything about the provider |
| `version` | Declared by the adapter | That the binary is that version |
| `version_verified` | Never true today | `false` keeps the runtime out of "ready" |
| `executable_digest` | Read-only sha256 of the executable | Nothing about its behaviour |
| `manifest_version` | Adapter manifest revision | Nothing about conformance |
| `sandboxed` | Adapter declaration | Actual confinement |

## The rule the interface applies

1. `available: false` → **unavailable**, with the reason that the executable is not an
   executable file.
2. `version_verified !== true` → **unverified**, because the version is declared rather
   than observed.
3. No verified provider authentication state → **unverified**, with the specific reason
   (`credentials absent`, `no brokered call has succeeded yet`, or `no authentication state
   is registered`).
4. Only when the executable, the declared version and one brokered provider call were all
   observed does a runtime render as **ready**, and even then the panel states that this is
   not a claim about provider quotas, model access or native conformance.

## Limits of this evidence

- The matrix is the *adapter declaration*. It is not produced by running each capability:
  no native resume, fork, steer or approval has been exercised, and the readiness report
  for the debug flow keeps `sessionExercised`/`breakpointVerified` false.
- Authentication state is per provider, not per model or quota. `verified` means one
  brokered call reached the provider from this host.
- The panel has been tested with the real bridge contract (validated responses) and
  fixture payloads, not against a live connection in a packaged window.
