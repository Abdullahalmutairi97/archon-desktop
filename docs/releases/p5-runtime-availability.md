# P5 — installed runtime availability (target workstation)

Recorded 2026-09-27 on `archonminipc` (Linux x86_64, user `archonminipc`). This is
an **availability and identity** record, not a capability qualification. It
establishes that the four runtimes named by P5 exist here with pinned
identities, can start headless, and have native account material present. No
real provider turn was executed for this record, so no adapter is marked ready.

## Runtimes

| Runtime | Resolved executable | Version | sha256 (launcher bundle) |
| --- | --- | --- | --- |
| Prime | `/home/archonminipc/.local/lib/node_modules/prime-agent/dist/bundle/cli.js` (via `~/.local/bin/prime-agent`) | 0.9.3 | `08ab8c6cf076018f3a8e8eb7e2be62013bffd6083934bf368daa55a9fbc557dd` |
| Pi | `/home/archonminipc/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js` (via `~/.local/bin/pi`) | 0.87.1 | `e79626f2dd6f94aa45d30f3fa63cd84319a6eefcd150b353cfaf274366926774` |
| Codex | `/home/archonminipc/.codex/packages/standalone/releases/0.154.0-x86_64-unknown-linux-musl/bin/codex` | 0.154.0 | `3188814c35471432d4123203e0eb38e5bddc60226e3d7ddf0e59e649ea140022` |
| Hermes | `/home/archonminipc/.local/share/uv/tools/hermes-agent/bin/hermes` | 0.19.0 | `ea7ac0f83ea1f8911623417cd09cc2afa2f6714ec36d39dfb396e4a40c6814e7` |

The digest is of the resolved launcher/bundle entry point, not of the whole
installed package tree; treat it as an identity fingerprint, not a full
install-content hash.

## Headless availability

- `prime-agent --help` → OK
- `pi --help` → OK
- `codex --version` → `codex-cli 0.154.0`; `codex exec --help` → OK
- `hermes --help` → OK

## Native account material (existence only)

`~/.codex/auth.json`, `~/.prime/config.json`, `~/.pi`, and `~/.hermes/auth.json`
are present. Contents were **not** read or copied for this record.

## Host facilities

- OS keyring: `gnome-keyring-daemon` active with a session D-Bus (`DBUS_SESSION_BUS_ADDRESS` set).
- Isolation tooling present: `bwrap`, `unshare`, `systemd-run`; cgroup v2 with
  `cpuset cpu io memory pids` controllers.
- Frozen v0.3.0 baseline ASAR present and hash-exact:
  `projects/archon-desktop-v0.3.0/unified-refresh/app-v0.3.0-unified-refresh.asar`
  (`296704358` bytes,
  sha256 `36d3ae03bd6b20c4e9ea5fc690461ef972b16eb0c9433bfb1305daeb068e549b`).

## Hermes note

Hermes 0.19.0 was present only as a broken editable install referencing the
retired `/home/archon/.hermes/hermes-agent` home. It was reinstalled here as an
isolated `uv` tool from the `retired-hermes` migration backup
(`uv tool install --editable`), which provides `hermes`, `hermes-agent` and
`hermes-acp`. No Hermes gateway, dashboard, cron or systemd unit was installed
or started.

## Qualification attempt (2026-09-27)

A bounded behavioral probe was attempted and did **not** qualify any adapter:

- **Codex** 0.154.0 started a bounded `codex exec` turn (workdir `/tmp/rt-qual`, model `gpt-5.6-luna`, provider `openai`) but did not complete within 180s; an MCP transport error (Apify missing/invalid token) was observed during startup.
- **Pi** 0.87.1 `pi -p --no-session` returned `Codex error: The usage limit has been reached`.
- **Prime** and **Hermes** were not attempted after the shared provider reported its usage limit reached.

Conclusion: native behavioral qualification is blocked by unavailable provider quota on this account, not by the runtimes' presence or the adapter code. Every adapter remains **unverified** until a provider turn completes in an assigned workspace.

## Not yet established

- Any runtime completing a real provider turn in an assigned workspace.
- Adapter manifests (modalities, resume/fork/steer, approval/read-only/chat-only,
  reconnect semantics, resource formats) and conformance fixtures.
- Machine isolation controls actually enforced around a runtime.
- P2 baseline parity against the frozen ASAR.

Until those exist, each adapter stays **unverified**, never ready.
