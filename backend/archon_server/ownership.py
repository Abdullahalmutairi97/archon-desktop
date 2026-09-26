"""Durable session runtime/workspace ownership reconciliation.

Legacy profile aliases and whichever task/native file happens to sort first are
not sufficient identity evidence. This service reads every task row and every
matching native session header, then commits a verified immutable owner or a
visible review_required record.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping


RUNTIMES = frozenset({"prime", "pi"})


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _canonical_cwd(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        requested = Path(value).expanduser()
        resolved = requested.resolve(strict=True)
    except (OSError, RuntimeError, ValueError):
        return None
    if not requested.is_absolute() or requested != resolved or not resolved.is_dir():
        return None
    return str(resolved)


def _infer(
    session_id: str,
    tasks: Iterable[Mapping[str, Any]],
    headers: Iterable[Mapping[str, Any]],
    *,
    tombstoned: bool,
) -> tuple[str | None, str | None, str | None]:
    """Return (runtime, cwd, reason); reason is None only for verified facts."""
    task_rows = list(tasks)
    header_rows = list(headers)
    reasons: list[str] = []
    runtimes: set[str] = set()
    cwds: set[str] = set()

    if tombstoned:
        reasons.append("This session is tombstoned as deleted; start a new session instead.")

    missing_task_runtime = False
    missing_task_cwd = False
    for task in task_rows:
        durable_runtime = task.get("runtime_id")
        profile = task.get("profile")
        if durable_runtime is not None:
            if durable_runtime not in RUNTIMES:
                reasons.append("A task has an invalid durable runtime identity.")
            else:
                runtimes.add(str(durable_runtime))
                if profile in RUNTIMES and profile != durable_runtime:
                    reasons.append("A task's canonical profile conflicts with its durable runtime.")
        elif profile in RUNTIMES:
            runtimes.add(str(profile))
        elif isinstance(profile, str) and profile.strip():
            reasons.append("A task uses an unknown legacy runtime alias; review its owner before resuming.")
        else:
            missing_task_runtime = True

        cwd = task.get("cwd")
        if isinstance(cwd, str) and cwd.strip():
            cwds.add(cwd)
        else:
            missing_task_cwd = True

    native_headers = [row for row in header_rows if row.get("source") == "native"]
    desktop_headers = [row for row in header_rows if row.get("source") == "desktop"]
    evidence_error_messages = {
        "unreadable_file": "Native session file is unreadable.",
        "malformed_json": "Native session file contains malformed JSON.",
        "missing_header": "Native session file is missing its session header.",
        "invalid_header_id": "Native session header has a missing or invalid ID.",
        "filename_header_mismatch": "Native session filename does not match its header ID.",
    }
    for header in header_rows:
        evidence_error = header.get("evidence_error")
        if evidence_error:
            reasons.append(evidence_error_messages.get(
                str(evidence_error), "Native session file or header evidence is incomplete."
            ))
        header_id = header.get("header_id")
        if not header.get("identity_matches") or not isinstance(header_id, str) or not header_id:
            reasons.append("Native session header identity is ambiguous or disagrees with its session ID.")
        runtime_id = header.get("runtime_id")
        if runtime_id is not None:
            if runtime_id not in RUNTIMES:
                reasons.append("Native session header has an unknown runtime source.")
            else:
                runtimes.add(str(runtime_id))
        cwd = header.get("cwd")
        if isinstance(cwd, str) and cwd.strip():
            cwds.add(cwd)
        else:
            reasons.append("A native session header is missing its working directory.")

    if len(native_headers) > 1:
        reasons.append("Multiple native headers claim this session ID; review the native history.")
    if not task_rows and not native_headers:
        reasons.append("No canonical task or unique native session header verifies this session.")
    if not task_rows and native_headers:
        if len(native_headers) != 1:
            reasons.append("Native session ownership is ambiguous; review duplicate headers.")
        elif native_headers[0].get("runtime_id") != "prime" and not session_id.startswith("pi-native-"):
            reasons.append("An empty session can be resumed only from one actual Prime native header.")
        elif session_id.startswith("pi-native-") and native_headers[0].get("runtime_id") != "pi":
            reasons.append("Pi native history does not agree with its namespaced session ID.")

    if missing_task_runtime and not runtimes:
        reasons.append("Task history does not record a canonical runtime.")
    if missing_task_cwd:
        reasons.append("Task history is missing a working directory.")
    if len(runtimes) != 1:
        reasons.append("Task and native runtime evidence is missing or conflicting.")
    if len(cwds) != 1:
        reasons.append("Task and native working-directory evidence is missing or conflicting.")

    raw_cwd = next(iter(cwds)) if len(cwds) == 1 else None
    canonical_cwd = _canonical_cwd(raw_cwd)
    if raw_cwd is not None and canonical_cwd is None:
        reasons.append("The recorded working directory is no longer canonical and accessible.")

    # A Pi native history may be displayed and inspected, but never submitted as
    # a writable/resumable Archon task.
    if session_id.startswith("pi-native-") and task_rows:
        reasons.append("Native Pi history is read-only and cannot own an Archon task.")

    if reasons:
        return None, None, " ".join(dict.fromkeys(reasons))
    return next(iter(runtimes)), canonical_cwd, None


class SessionOwnershipService:
    def __init__(self, store, native_sessions):
        self.store = store
        self.native_sessions = native_sessions

    @staticmethod
    def _owner_result(
        row, *, project_binding_present: bool = False, project_id: str | None = None,
        task_count: int = 0, tombstoned: bool = False,
    ) -> dict[str, Any]:
        result = dict(row)
        result["read_only"] = str(row["session_id"]).startswith("pi-native-")
        result["project_binding_present"] = project_binding_present
        result["project_id"] = project_id
        result["task_count"] = task_count
        result["tombstoned"] = tombstoned
        return result

    def _reconcile(self, session_id: str, headers: list[dict[str, Any]]) -> dict[str, Any]:
        now = _now()
        with self.store.db.transaction() as conn:
            task_rows = [dict(row) for row in conn.execute(
                "SELECT id,profile,runtime_id,cwd,project_id,status FROM tasks WHERE session_id=? ORDER BY id",
                (session_id,),
            )]
            binding = conn.execute(
                "SELECT project_id FROM session_projects WHERE session_id=?", (session_id,),
            ).fetchone()
            tombstoned = conn.execute(
                "SELECT 1 FROM deleted_sessions WHERE session_id=?", (session_id,),
            ).fetchone() is not None
            current_row = conn.execute(
                "SELECT session_id,runtime_id,cwd,state,reason,created_at,updated_at FROM session_ownership WHERE session_id=?",
                (session_id,),
            ).fetchone()
            inferred_runtime, inferred_cwd, reason = _infer(
                session_id, task_rows, headers, tombstoned=tombstoned,
            )

            if current_row is None:
                state = "verified" if reason is None else "review_required"
                row_values = (
                    session_id, inferred_runtime if reason is None else None,
                    inferred_cwd if reason is None else None, state, reason, now, now,
                )
                conn.execute(
                    """INSERT INTO session_ownership
                       (session_id,runtime_id,cwd,state,reason,created_at,updated_at)
                       VALUES (?,?,?,?,?,?,?)""",
                    row_values,
                )
            else:
                current = dict(current_row)
                if current["state"] == "verified":
                    identity_conflict = (
                        reason is not None and (
                            bool(headers) or tombstoned or bool(task_rows)
                        )
                    )
                    if not identity_conflict and inferred_runtime is not None:
                        identity_conflict = inferred_runtime != current["runtime_id"]
                    if not identity_conflict and inferred_cwd is not None:
                        identity_conflict = inferred_cwd != current["cwd"]
                    if identity_conflict:
                        reason = reason or "New task or native evidence conflicts with the verified immutable owner."
                        conn.execute(
                            "UPDATE session_ownership SET state='review_required',reason=?,updated_at=? WHERE session_id=?",
                            (reason, now, session_id),
                        )
                    # Do not rewrite immutable runtime/cwd. If current files are
                    # temporarily absent but the durable task rows still agree,
                    # retain the already verified identity.
                    current["state"] = "review_required" if identity_conflict else "verified"
                    current["reason"] = reason if identity_conflict else None
                    current["updated_at"] = now if identity_conflict else current["updated_at"]
                elif reason is None and inferred_runtime is not None and inferred_cwd is not None:
                    # A migration may have lacked native headers. Promote only
                    # when current complete evidence resolves to its stored
                    # partial candidate, without ever consulting profile aliases.
                    matches_partial = (
                        current["runtime_id"] in (None, inferred_runtime)
                        and current["cwd"] in (None, inferred_cwd)
                    )
                    if matches_partial:
                        conn.execute(
                            "UPDATE session_ownership SET runtime_id=?,cwd=?,state='verified',reason=NULL,updated_at=? WHERE session_id=?",
                            (inferred_runtime, inferred_cwd, now, session_id),
                        )
                        current.update(runtime_id=inferred_runtime, cwd=inferred_cwd,
                                       state="verified", reason=None, updated_at=now)
                    else:
                        reason = "Current evidence conflicts with the previously recorded review candidate."
                        conn.execute(
                            "UPDATE session_ownership SET state='review_required',reason=?,updated_at=? WHERE session_id=?",
                            (reason, now, session_id),
                        )
                        current.update(state="review_required", reason=reason, updated_at=now)
                else:
                    # Preserve any partial legacy candidate, but never change it
                    # while the row remains under review.
                    if current["reason"] != reason:
                        conn.execute(
                            "UPDATE session_ownership SET reason=?,updated_at=? WHERE session_id=? AND state='review_required'",
                            (reason, now, session_id),
                        )
                        current.update(reason=reason, updated_at=now)

                result_row = current
                return self._owner_result(
                    result_row,
                    project_binding_present=binding is not None,
                    project_id=binding["project_id"] if binding is not None else None,
                    task_count=len(task_rows), tombstoned=tombstoned,
                )

            row = conn.execute(
                "SELECT session_id,runtime_id,cwd,state,reason,created_at,updated_at FROM session_ownership WHERE session_id=?",
                (session_id,),
            ).fetchone()
            return self._owner_result(
                row,
                project_binding_present=binding is not None,
                project_id=binding["project_id"] if binding is not None else None,
                task_count=len(task_rows), tombstoned=tombstoned,
            )

    def reconcile(self, session_id: str) -> dict[str, Any]:
        evidence = self.native_sessions.ownership_evidence(session_id)
        return self._reconcile(session_id, evidence)

    def reconcile_all(self) -> dict[str, dict[str, Any]]:
        evidence = self.native_sessions.owner_evidence()
        with self.store.db.connect() as conn:
            session_ids = {
                row[0] for query in (
                    "SELECT DISTINCT session_id FROM tasks WHERE session_id IS NOT NULL",
                    "SELECT session_id FROM session_projects",
                    "SELECT session_id FROM deleted_sessions",
                    "SELECT session_id FROM session_ownership",
                ) for row in conn.execute(query) if row[0]
            }
        session_ids.update(evidence)
        return {
            session_id: self._reconcile(session_id, evidence.get(session_id, []))
            for session_id in sorted(session_ids)
        }
