# P5 — same-uid exposure of server-held credentials

Recorded 2026-09-28 on `archonminipc`. The P5 validation bullet says: *"A forbidden
secret-backed operation fails through both the named tool and shell/direct HTTP;
broker/process isolation or upstream scopes prevent the effect."* The named-tool half
has regression coverage (binding, replay, expiry, epoch, generation, redaction). This
record answers the other half: what can a process that shares the service account still
do?

Two runs are behind it. A parallel evidence worker ran the experiments on this host and
recorded raw commands and output in `/tmp/p5-bypass/evidence.md` (scratch files only).
The checks marked **[re-verified here]** were re-run by the main session, and their
results are the ones the landed change rests on.

## Results

| Channel | Result | Verdict |
| --- | --- | --- |
| Child environment (`build_child_env` scope) | The key name and value are absent from a `services`/`prime` child environment and from its `/proc/self/environ`, while the broker resolves the value itself. | PREVENTED |
| Ledger contents | With a fake credential, the ledger holds no raw value in reference rows, grant records or any audit row, and no grant token: only the source-key name, digests and decision metadata. | PREVENTED |
| `/proc/<server pid>/environ` | **Before the change below, any process of this user read the server's environment, including the credential.** [re-verified here] The control child in `backend/tests/test_process_hardening.py` is readable; a hardened child is not. | NOT PREVENTED before, PREVENTED after |
| `/proc/<server pid>/stat` | Stays readable, which the runner supervisor needs for process-group scanning. [re-verified here] | Unaffected by the fix |
| Ledger write access | The 0600 ledger is owned by the service account, so a same-uid process can add its own reference row. [re-verified here] The broker then loaded the rewritten ledger and sent `Authorization: Bearer <the credential>` to the attacker-chosen origin `https://collector.example.net/v1/x`. | NOT PREVENTED |
| Direct HTTP to the provider origin | The worker's run reached the broker's own pinned origin from a child and got the provider's `401`; that shows the request was unauthenticated, not that any provider enforces scope. | NOT TESTABLE HERE (fake credentials) |
| Upstream credential scopes | Cannot be judged with fake credentials. | NOT TESTABLE HERE |
| Opt-in runtime sandbox | In the worker's run, the repository's own bubblewrap argv made the `/proc` read fail `EACCES` and, with `--unshare-net`, made name resolution fail. That profile is off by default and its runtime compatibility is unqualified. | AVAILABLE, NOT DEFAULT |

## Change landed

The server now clears its dumpable flag before the listener starts
(`backend/archon_server/hardening.py`, called from `main()`), which makes the kernel
deny `/proc/<pid>/environ` and `/proc/<pid>/mem` to other same-uid processes. Verified
twice:

- `backend/tests/test_process_hardening.py` starts a hardened child and an unhardened
  control: the control's environment is readable, the hardened child's is not, and the
  hardened child can still spawn a grandchild.
- End to end against the real entry point on port 8791 with a fake credential in its
  environment: the listener answered, `open("/proc/<pid>/environ")` raised
  `PermissionError` (errno 13) and the value was not readable, while `/proc/<pid>/stat`
  stayed readable for supervision.

This is a one-channel fix, not isolation. It does not change the fact that the ledger,
the pairing socket and the provider origin are all reachable by anything running as this
account.

## What the box still needs

The bullet stays open. To demonstrate it, one of these is required:

1. an enforced OS boundary around every workspace-capable process (this repository has
   the mechanics behind `ARCHON_DESKTOP_RUNTIME_ISOLATION_PROFILE=workspace-only` and in
   the workspace-service profiles, but they are off by default and the runtime profile is
   not qualified with a real provider turn), or
2. upstream credentials whose scopes make the direct-HTTP path harmless, demonstrated
   against the real provider, plus a broker ledger that a same-uid process cannot
   retarget.

Until then, do not describe the broker as preventing shell or direct-HTTP access. Its own
docstring and `docs/security.md` say capability boundary, not OS sandbox, and this record
is the evidence for that wording.
