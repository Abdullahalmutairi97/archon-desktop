# Prime session benchmark — 2026-08-19

Five new sessions were submitted together through Archon Desktop's production backend (`POST /api/tasks`) in automatic mode. The backend had one worker.

| Scenario | Session | Queue | Agent runtime | Submit → complete | Correctness |
|---|---|---:|---:|---:|---|
| arithmetic | prime-4bff573857ea44cab11caa588a8ba025 | 0.46s | 6.03s | 6.50s | PASS |
| python-reasoning | prime-c062be481522498495ad1f6a33b3335a | 6.49s | 4.18s | 10.67s | PASS |
| backend-inspection | prime-6f6922c2c6a04cc695f06341cbfa17ac | 10.67s | 7.86s | 18.52s | PASS |
| structured-output | prime-9ba4aa9a4d0c4b5195553a4fa07e1ab5 | 18.52s | 4.53s | 23.05s | PASS |
| readme-inspection | prime-4f3fbae6f21042e3883b93c5bf8dc4cb | 23.05s | 6.42s | 29.47s | PASS |

## Summary

- Correctness: **5/5** objective checks passed.
- Agent runtime: mean **5.80s**, median **6.03s**, range **4.18–7.86s**.
- Batch submit-to-complete: mean **17.64s**, median **18.52s**. The fifth session completed at **29.47s** because one worker serialized the batch.
- Direct CLI control for the arithmetic prompt completed in **4.06s** and began answer deltas at **3.14s**.
- Before the fix, Archon discarded Prime's text deltas and simple sessions showed no progressive answer.
- After the fix, a continuation emitted its first answer delta at **3.80s**, completed in **4.58s**, reconstructed exactly to the final answer, and retained the previous-turn result.

## Additional checks

- Native sessions appeared in `GET /api/sessions`.
- Session transcript replay returned user/assistant turns in order.
- Live thinking deltas, tool start/end events, answer deltas and completion events were all observed in order. Tool events included target, result, duration and exit code.
- Repository facts were independently checked against `pyproject.toml` and `README.md`.
- Structured JSON output parsed and matched exactly.
- Renderer TypeScript typecheck and production renderer build passed.
- Focused `PrimeRunner` streaming test passed.

## Change made

`backend/archon_server/prime_runner.py` now forwards Prime CLI `text_delta` and `text_end` events as Archon `message.delta` and `message.done` events. This gives the desktop the same progressive final-answer stream as the CLI.

## Concurrency improvement

Production was initially limited to `ARCHON_DESKTOP_WORKER_COUNT=1`, which serialized the five-session batch. It is now set to **2**, matching the backend's documented recommendation. A two-turn simultaneous validation started both in about **0.32s** and completed them in **4.43s** and **4.90s**, with both outputs exact. Additional simultaneous turns will still queue after both workers are occupied.
