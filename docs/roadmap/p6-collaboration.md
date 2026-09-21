# P6 — Genuine collaboration for friends

**Status:** not started. **Dependencies:** P3–P5 and demonstrated policy/isolation boundaries. Identity/policy code may begin earlier; enabling team use cannot. **Outcome:** named users coordinate work, review changes and access only granted projects/services.

## Scope

Expand P3's solo identity foundation into users, devices, invitations and project roles. Use one private coordinator with local-disk SQLite and individual desktops. Tailnet reachability does not grant application membership. Preserve existing reviewed read-only snapshot export as a separate feature; recipient copies cannot be revoked.

## Checklist

- [ ] Add owner/maintainer/contributor/viewer roles, device/session revocation and explicit grants; keep host administration a separate operator capability.
- [ ] Use single-use expiring invitation tokens and atomic consumption into pending membership/device records. Grant access only after owner confirmation of intended person/device fingerprint; expired pending enrollment needs a new invite.
- [ ] Use protected device keys and standard signed challenge/short-lived session mechanisms. Store digests; reject replay and invalid audience. Device-associated bearer tokens remain replayable if stolen until expiry/revocation.
- [ ] Authorize every object/action/channel against principal, device, project membership, grants, revision and policy epoch. Unknown scope denies; cross-project IDs never grant access.
- [ ] Add consistent project snapshots plus filtered event replay using a server scan cursor. Gaps in global sequence numbers are normal after filtering and disclose no unauthorized payload.
- [ ] Add task assignment/progress, workspace creation/ownership/takeover, comments and change sets with explicit actors and revisions.
- [ ] Keep concurrent writers in separate roots. Enforce full writer quiescence before handoff; Git worktrees alone are not a security boundary.
- [ ] Bind review to source head/diff and tests to the actual proposed merge result plus source/target identities. Target movement invalidates checks; revalidate under integration lock before an atomic non-force update. Resolve conflicts in a dedicated workspace.
- [ ] Add per-service preview grants and terminal view/control leases. Viewers receive a read-only viewer, never a writable IDE disguised by hidden menus.
- [ ] Reauthorize API/file/Git/job/approval/resource/gateway and SSE/WS traffic. Revoke matching streams, queued jobs and active control/execution leases on membership/device changes.
- [ ] Target connected channel closure within 2 seconds; renew runner authorization every 5 seconds and stop affected privileged execution after 15-second lease loss. A supervisor enforces cancellation even when the agent blocks.
- [ ] Document the trade-off: coordinator partition can stop execution; desktop disconnect does not. Revocation cannot undo past effects or downloaded snapshots.
- [ ] Remove legacy shared-token paths from team authority, maintain security audit events and configure private HTTPS routing without public preview ports.

## Validation and exit

- [ ] Two real identities on separate desktops accept/confirm an invitation, assign work, edit via agent/IDE, submit exact diff/tests, review and merge with synchronized visible state.
- [ ] Two agents editing the same filename in distinct workspaces preserve both changes; conflicts and stale reviews are explicit.
- [ ] Role/action and object-ID tampering tests cover HTTP, SSE, WS, IDE, preview, files, tools and direct ports. Invitation consume/race/replay tests pass.
- [ ] Revocation during IDE/terminal/SSE/preview use and pending approval closes active/new access within measured targets; partitioned execution stops at lease expiry.
- [ ] Terminal reconnect, failure recovery, hostile preview, full IDE handoff and resource bypass scenarios pass with real identities/scoped runners as well as CI fixtures.
- [ ] Restore drill preserves ownership/grants and revoked authority remains revoked. Every event/action is attributable to the correct actor/attempt.

Known blockers: proven lower-phase isolation, a two-device/private-network environment, intended member count and actual Tailscale entitlement, native channel revocation and isolation support. Same-buffer CRDT editing is P8; multiple writable editor tabs do not establish it.

Publish incremental PRs under the [roadmap workflow](README.md). Do not enable team access while boundary or native tests remain unverified.
