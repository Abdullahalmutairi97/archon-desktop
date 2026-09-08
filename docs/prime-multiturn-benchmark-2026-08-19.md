# Prime multi-turn CLI-parity benchmark — 2026-08-19

Three new Archon Prime sessions were created strictly sequentially. Each completed three turns before the next session began.

## Archon results

| Session scenario | Turn | Queue | First answer token | Complete | Correctness |
|---|---:|---:|---:|---:|---|
| context-reasoning | 1 | 0.31s | 3.45s | 4.71s | PASS |
| context-reasoning | 2 | 0.05s | 3.22s | 4.32s | PASS |
| context-reasoning | 3 | 0.40s | 4.75s | 6.53s | PASS |
| repository-tools | 1 | 0.41s | 5.86s | 7.58s | PASS |
| repository-tools | 2 | 0.31s | 6.33s | 8.04s | PASS |
| repository-tools | 3 | 0.33s | 7.57s | 9.22s | PASS |
| file-workflow | 1 | 0.20s | 6.50s | 7.65s | PASS |
| file-workflow | 2 | 0.22s | 8.69s | 9.56s | PASS |
| file-workflow | 3 | 0.29s | 6.12s | 7.84s | PASS |

Nine-turn aggregate: queue mean **0.28s**, first-answer median **6.12s**, completion median **7.65s**, completion range **4.32–9.56s**.

## Direct CLI controls

Equivalent first turns were run sequentially in disposable native Prime session directories.

| Scenario | Archon first token | CLI first token | Archon complete | CLI complete |
|---|---:|---:|---:|---:|
| context-reasoning | 3.45s | 3.33s | 4.71s | 4.49s |
| repository-tools | 5.86s | 7.56s | 7.58s | 8.79s |
| file-workflow | 6.50s | 8.11s | 7.65s | 9.58s |

## Verified behavior

- All **9/9** turn outputs passed independent objective checks.
- All streamed answer chunks reconstructed exactly to the stored final answer.
- Context retention passed within each session.
- Native transcript replay returned alternating user/assistant messages in order.
- Live thinking, tool start/end, answer deltas and message completion were observed.
- Repository line references and dependency constraints were independently verified.
- File create, append, read-only verification, line count and SHA-256 all passed.
- All three sessions appeared in the session list.
- Completed-task SSE replay included thinking/tool events, `message.delta`, and `message.done`.
- After a backend restart, all three transcripts remained available and session one correctly recalled `ORBIT-731`; post-restart first token was **4.00s**, completion **5.60s**.
- Backend health remained OK with two workers.

## Session IDs

- `context-reasoning`: `prime-635e16ff982d408e90e00899dcaca61e`
- `repository-tools`: `prime-28ee85c6c4b24192a074129ae6adbd4f`
- `file-workflow`: `prime-25bc3789ace549c1a29bb72778e2b94c`

## File workflow evidence

`sequence.txt` contained exactly `alpha\nbeta\ngamma\ndelta\n`. SHA-256: `927c9bb49935d22cfef1df0fd954eb8011420a9b1ec2350d65647accf201bbe9`.
