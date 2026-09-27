# P8 — Optional enhancements

**Status:** deferred; optional. **Dependencies:** the relevant essential phases, a demonstrated user need and a scoped acceptance plan. No essential workstation feature depends on P8.

## Candidate backlog

- [ ] Simultaneous same-buffer editing: define CRDT/OT model, undo, binary-file handling, agent-write interaction, reconnect and revocation; prove behavior with concurrent editors before presenting it as collaboration.
- [ ] Additional desktop operating systems: implement OS-specific services, credential stores, native view/isolation behavior and package/update/recovery gates; do not assume Linux evidence transfers.
- [ ] External-browser or public previews: separate origin/TLS/cookie/auth and expiry design, no inherited desktop privilege, explicit sharing scope and independent threat review.
- [ ] Additional VM or remote runner providers: reuse enrollment, scoped dispatch, journal generations, leases, isolation and migration contracts rather than creating another workspace authority model.
- [ ] Broader language/debug profiles: pin extensions and test real completion/diagnostics/debugging plus resource budgets and license availability for each supported profile.
- [ ] Optional OIDC: preserve local solo availability, explicit account linking, project membership and recovery; provider identity alone does not bypass authorization.
- [ ] Richer scheduling: retain idempotent admission, fairness, quota, cancellation and side-effect-aware recovery; justify new infrastructure with measurements.
- [ ] Optional Jev/Laya advisory routing, ranking or semantic failure labeling: keep deterministic eligibility/permissions first, include uncertainty, version/hash evidence and disable safely when unavailable.

## Per-enhancement exit gate

- [ ] Create an independent issue/design with scope, dependencies, alternatives, data/permission implications, rollback and measurable success criteria.
- [ ] Implement behind an explicit flag where appropriate using existing workspace/adapter/policy/event contracts.
- [ ] Pass enhancement-specific conformance, security, migration and native tests; demonstrate value without weakening core guarantees.
- [ ] Publish a focused PR with evidence and remaining limits. Enable or release independently only after its own gates pass.

For an optional decision model, freeze an independently labeled corpus and allowed candidates before evaluation, record raw outputs and runtime/model fingerprints, and measure quality/abstention/latency/cost/consistency against a valid comparator when available. Test timeout/schema/auth/overload/stale-input behavior. Use held-out evidence for any acceptance threshold; confidence is not correctness or permission. Do not make startup, approved execution, recovery, authorization or tests depend on an advisory model.

Known blockers: requirements and measured benefit are not established for these enhancements. Local Laya's completed review did not establish reliable plan approval, and Jev inference access was unavailable in the audit. Those facts do not block P1–P7.

Follow the [roadmap workflow](README.md); no P8 work belongs in the current Phase 1A stopping boundary.
