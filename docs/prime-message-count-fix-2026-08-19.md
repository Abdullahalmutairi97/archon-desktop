# Prime visible-message count correction — 2026-08-19

## Defect

Prime JSONL session badges counted every message-shaped record, including private thinking, tool calls, and tool results, while the transcript rendered only textual user/assistant messages. Before correction, 29 of 65 sessions disagreed; the active session reported over 500 records for roughly 55 visible messages.

## Correction

- `PrimeSessionService.list()` now counts the same projection returned by `messages()`: non-empty textual `user` and `assistant` messages only.
- The renderer refreshes sessions whenever the Sessions surface mounts, keeping native sessions advanced outside Archon current without continuous polling.

## Verification

- Focused backend tests: 6 passed, including internal thinking/tool exclusion.
- Production comparison: 65 sessions checked, 0 list/transcript count mismatches.
- MiniPC and MainPC packages: identical 73-file SHA-256 manifests.
- Final ASAR: `6f676adb837c048f7ea898ddcbcc37903c651fc90ae9127b161672e16645a0c8`.
- MainPC runtime: one main process and one sandboxed renderer.
