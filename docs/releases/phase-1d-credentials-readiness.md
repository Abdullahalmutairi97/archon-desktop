# Phase 1D — Credentials, child environments and readiness

This increment completes the planned backend source work for P1 credentials and observability. It does not qualify an installed desktop, native credential storage, external TLS ingress or provider execution. The missing frozen v0.3.0 ASAR remains a separate P2 evidence gap.

## Behavior

- Startup refuses missing credentials before creating or migrating the database. Anonymous fixture access must be explicitly enabled on loopback; disabling workers or injecting a fake runner does not enable it.
- HTTP and terminal WebSocket authorization use the same constant-time token policy. Terminal authentication is bounded and occurs before terminal creation.
- The listener must be loopback. Remote access requires declared private HTTPS proxy configuration; forwarded headers are not trusted by default. The source validates the URL and mode, not the actual proxy deployment.
- Credentials are generated with at least 256 random bits and published once into a private external mode-0600 environment file. The helper requires the complete workspace-root list and rejects destinations inside it, existing files and symlinks. Implicit repository `.env` loading is removed. The installer preserves an existing private external file instead of silently rotating it.
- Every new subprocess receives an explicit purpose-scoped environment. Coordinator and Telegram tokens, unrelated provider secrets and ambient runtime/shell injection variables are excluded. No ambient provider key is currently registered; native file/profile authentication is retained. Controlled Hermes and voice settings remain available.
- Anonymous `/api/health` is process liveness. Authenticated `/api/readiness` combines storage checks, worker liveness/heartbeats, aggregate queue age/counts and executable availability, returning 503 when dispatch is unavailable. It reports provider credentials, native conformance and successful execution as unverified.

## Compatibility and upgrade

Read [operator setup](../operator-setup.md) before deployment. Existing repository-local `.env` configuration and direct plaintext tailnet binds no longer work. Transfer required settings through a secure editor into a private external service environment file, deliberately preserve or rotate the token, and configure the private HTTPS ingress separately. The source change does not install or restart services.

No database migration is introduced by Phase 1D. Schema version 2 and the immutable migration files from Phase 1C.2 remain unchanged. Follow the [quiescent upgrade/rollback procedure](phase-1c2-durable-attempts.md) when changing database binaries. Reverting only this increment also requires compatible service configuration and restores the earlier auth/environment limitations.

Child-environment filtering applies to newly created processes. Existing tmux servers and native agents can retain their old environments; native agents still have their OS account's filesystem authority. Provider configurations that previously depended on ambient secret variables need an explicitly supported adapter contract rather than automatic inheritance.

## Validation

The final integration run passed **542 backend tests** (one existing Starlette/AnyIO deprecation warning). Desktop checks passed **72**, with **16** unchanged frozen-ASAR-dependent skips. `npm run setup` reproduced the existing lockfile with zero reported audit vulnerabilities, and `git diff --check` passed. Workers also ran focused security, process-environment and readiness regressions. All checks use isolated fixture paths, fake runtimes and sentinel credentials. No real provider/Telegram/native agent, installer, service restart or production database was used.

The bounded GPT-6 Astra review approved the increment. Its exported Bash-function environment finding was fixed and covered by a focused regression; no remaining blockers were found.

## Remaining gates

Native desktop keyring/memory-only storage and onboarding, real Prime/Pi version conformance, private TLS deployment and release/installer qualification remain unverified. A readiness 200 proves only the documented dispatch prerequisites at the observation time. It does not establish exactly-once side effects, agent progress or a process sandbox.
