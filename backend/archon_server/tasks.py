from __future__ import annotations

import asyncio
import hashlib
import json
import sqlite3
import uuid
import re
from datetime import datetime, timezone
from typing import Any, Callable, Protocol, Mapping

from .db import Database
from .hermes_runner import RunnerCancelled
from .runner_journal import JournalEntry, RunnerJournal
from .runtimes import RuntimeRegistry


MAX_EVENT_TEXT = 4096
MAX_RUNNER_ENVELOPE_BYTES = 64 * 1024
_PROJECT_UNSET = object()
_EVENT_TRUNCATION_MARKER = "\n…[truncated]"
_RECOVERY_GUIDANCE = (
    "Side effects are unknown. Review the workspace and agent session and confirm "
    "the previous runner has stopped before submitting another task. "
    "This task will not be retried automatically."
)


def _cap_event_text(value: str) -> str:
    if len(value) <= MAX_EVENT_TEXT:
        return value
    room = MAX_EVENT_TEXT - len(_EVENT_TRUNCATION_MARKER)
    return value[:room] + _EVENT_TRUNCATION_MARKER


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def is_quota_error(error: str) -> bool:
    """Recognise provider exhaustion without confusing ordinary task failures."""
    text = error.lower()
    return bool(re.search(r"\b(?:rate[ -]?limit|quota|usage limit|too many requests|429)\b", text))


def _runner_event_key(task_id: str, attempt_id: str, event_number: int) -> str:
    """Build a stable journal key unique to one event within a captured attempt."""
    identity = f"{task_id}\0{attempt_id}\0{event_number}".encode("utf-8")
    return "task-event-" + hashlib.sha256(identity).hexdigest()


def hash_request_payload(payload: Mapping[str, Any]) -> str:
    """Fingerprint a transport's semantic request before mutable admission.

    Mapping order is irrelevant; ordered lists and explicit null values remain
    significant. Callers must exclude credentials and transport retry metadata.
    """
    encoded = json.dumps(payload, sort_keys=True, separators=(',', ':'),
                         ensure_ascii=False, allow_nan=False).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


def _validate_request_id(request_id: str) -> None:
    if not isinstance(request_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', request_id):
        raise ValueError('Invalid task request id: use 1-200 letters, digits, underscores or hyphens')


def _validate_request_hash(request_hash: str) -> str:
    if not isinstance(request_hash, str) or not re.fullmatch(r'[A-Fa-f0-9]{64}', request_hash):
        raise ValueError('Invalid task request hash: expected a SHA256 hex digest')
    return request_hash.lower()


def _default_session_id(task_id: str, request_id: str | None) -> str:
    """Choose the historical task-derived id when it fits the session API."""
    if request_id is not None and len(f"prime-{request_id}") > 200:
        # Keep the task's idempotency identity untouched, but bound its session
        # identity to the 200-character limit enforced by session APIs.
        return f"prime-{hashlib.sha256(request_id.encode('ascii')).hexdigest()}"
    return f"prime-{task_id}"


def _session_identity_exists(conn: sqlite3.Connection, session_id: str) -> bool:
    # Generated ids must not alias a session that is live, tombstoned, or has
    # only retained ownership/project metadata. The write transaction serializes
    # this check with another task admission.
    for table in ("tasks", "session_projects", "session_ownership", "deleted_sessions"):
        if conn.execute(
            f"SELECT 1 FROM {table} WHERE session_id=? LIMIT 1", (session_id,),
        ).fetchone():
            return True
    return False


def _unique_generated_session_id(
    conn: sqlite3.Connection, task_id: str, request_id: str | None,
) -> str:
    """Preserve the normal id where possible, resolving any stored-id collision."""
    candidate = _default_session_id(task_id, request_id)
    if not _session_identity_exists(conn, candidate):
        return candidate

    # This also handles cross-length collisions: a short request key can equal
    # the digest suffix chosen for an earlier long key. Never truncate keys or
    # reuse an identity already present in the task/session ledger.
    identity = request_id if request_id is not None else task_id
    attempt = 0
    while True:
        material = f"{identity}\0{attempt}"
        candidate = f"prime-{hashlib.sha256(material.encode('ascii')).hexdigest()}"
        if not _session_identity_exists(conn, candidate):
            return candidate
        attempt += 1


def _require_matching_request(row, request_hash: str) -> None:
    if row['request_hash'] is None:
        raise ValueError(
            'Existing task has no request fingerprint (legacy task). '
            'Review its outcome before submitting a new request id.'
        )
    if row['request_hash'] != request_hash:
        raise ValueError('Task request id conflicts with a different request payload')


def _decode(row) -> dict[str, Any]:
    item = dict(row)
    item.pop('request_hash', None)
    try:
        skills = json.loads(item.pop("skills_json") or "[]")
    except (TypeError, json.JSONDecodeError):
        skills = []
    item["skills"] = skills if isinstance(skills, list) else []
    try:
        result = json.loads(item.pop("result_json")) if item.get("result_json") else None
    except (TypeError, json.JSONDecodeError):
        result = None
    item["result"] = result
    return item


def _decode_event(row) -> dict[str, Any]:
    try:
        data = json.loads(row["data_json"])
    except (TypeError, json.JSONDecodeError):
        data = {}
    try:
        attempt_id = row["attempt_id"]
    except (KeyError, IndexError):
        attempt_id = None
    return {"seq": row["seq"], "task_id": row["task_id"], "type": row["type"],
            "data": data, "created_at": row["created_at"], "attempt_id": attempt_id}


def _canonical_runner_envelope(task_id: str, attempt_id: str, event_type: str,
                               data: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    if not isinstance(task_id, str) or not task_id.strip() or len(task_id) > 200:
        raise ValueError("Runner event task id must be a non-empty string of at most 200 characters")
    if not isinstance(attempt_id, str) or not attempt_id.strip() or len(attempt_id) > 200:
        raise ValueError("Runner event requires a captured non-empty attempt id of at most 200 characters")
    if not isinstance(event_type, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", event_type):
        raise ValueError("Runner event type must be a safe ASCII event name of at most 128 characters")
    if event_type.startswith("task."):
        raise ValueError("Runner event type cannot use the reserved task.* namespace")
    if not isinstance(data, dict):
        raise ValueError("Runner event data must be an object")
    envelope = {
        "task_id": task_id,
        "attempt_id": attempt_id,
        "event_type": event_type,
        "data": data,
    }
    try:
        envelope_json = json.dumps(
            envelope, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False,
        )
    except (TypeError, ValueError, RecursionError) as exc:
        raise ValueError("Runner event envelope must contain only JSON values") from exc
    try:
        encoded_envelope = envelope_json.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise ValueError("Runner event envelope must contain only valid UTF-8 values") from exc
    if len(encoded_envelope) > MAX_RUNNER_ENVELOPE_BYTES:
        raise ValueError("Runner event envelope exceeds the 64 KiB limit")
    # Decode the canonical form so downstream event persistence uses the exact
    # bounded JSON value that was fingerprinted in the durable receipt.
    return envelope_json, json.loads(envelope_json)["data"]


class Runner(Protocol):
    async def run(self, task: dict[str, Any], emit) -> dict[str, Any]: ...


class TaskStore:
    def __init__(self, db: Database):
        self.db = db

    def readiness_stats(self) -> dict[str, Any]:
        """Check the existing DB is readable/writable and return queue aggregates.

        BEGIN IMMEDIATE proves the database can accept a writer without changing
        task, attempt, event, or queue state. The short timeout keeps a readiness
        poll bounded when another SQLite writer is active.
        """
        with self.db.connect() as conn:
            conn.execute("PRAGMA busy_timeout=1000")
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                """SELECT
                       SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) AS queued,
                       SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running,
                       MIN(CASE WHEN status='queued' THEN created_at END) AS oldest_queued_at
                   FROM tasks"""
            ).fetchone()
            conn.commit()
        return {
            "queued": int(row["queued"] or 0),
            "running": int(row["running"] or 0),
            "oldest_queued_at": row["oldest_queued_at"],
        }

    def bind_session_owner(self, conn, session_id: str, runtime_id: str, cwd: str | None) -> bool:
        """Bind a new verified owner, or require an exact verified match.

        The caller supplies canonical runtime identity and an already admitted
        working directory. Historical aliases and current project names are not
        consulted here.
        """
        normalized_id = session_id if isinstance(session_id, str) else ""
        if not normalized_id.strip():
            raise ValueError("Session ownership requires a session id")
        if runtime_id not in {"prime", "pi"}:
            raise ValueError("Session ownership requires canonical runtime prime or pi")
        normalized_cwd = cwd if isinstance(cwd, str) and cwd.strip() else None
        if conn.execute(
            "SELECT 1 FROM deleted_sessions WHERE session_id=?", (normalized_id,),
        ).fetchone():
            raise ValueError("Session has been deleted")
        location = conn.execute(
            "SELECT cwd FROM session_locations WHERE session_id=?", (normalized_id,),
        ).fetchone()
        if location is not None and location["cwd"] != normalized_cwd:
            raise ValueError("Session working directory conflicts with its durable location")
        owner = conn.execute(
            "SELECT runtime_id,cwd,state FROM session_ownership WHERE session_id=?", (normalized_id,),
        ).fetchone()
        if owner is not None:
            if owner["state"] != "verified":
                raise ValueError("Session ownership requires review before it can be used")
            if owner["runtime_id"] != runtime_id or owner["cwd"] != normalized_cwd:
                raise ValueError("Session runtime or working directory conflicts with its verified owner")
            return True
        now = utcnow()
        conn.execute(
            """INSERT INTO session_ownership
               (session_id,runtime_id,cwd,state,reason,created_at,updated_at)
               VALUES (?,?,?,'verified',NULL,?,?)""",
            (normalized_id, runtime_id, normalized_cwd, now, now),
        )
        return True

    def session_owner(self, session_id: str) -> dict[str, Any] | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT * FROM session_ownership WHERE session_id=?", (session_id,),
            ).fetchone()
        return dict(row) if row else None

    def submit(self, prompt: str, cwd: str | None = None, model: str | None = None,
               provider: str | None = None, skills: list[str] | None = None,
               session_id: str | None = None, approval_mode: str = "approve",
               chat_only: bool = False, profile: str | None = None,
               request_id: str | None = None, project_id: str | None | object = _PROJECT_UNSET,
               request_hash: str | None = None, runtime_id: str | None = None) -> dict[str, Any]:
        explicit_runtime_id = runtime_id is not None
        if runtime_id is None and profile in {"prime", "pi"}:
            # Internal callers that already use a canonical profile get the
            # same durable dispatch identity as HTTP admissions.
            runtime_id = profile
        if runtime_id not in {None, "prime", "pi"}:
            raise ValueError("Runtime id must be canonical: prime or pi")
        if explicit_runtime_id and profile in {"prime", "pi"} and runtime_id != profile:
            raise ValueError("Explicit runtime id must match the canonical profile")
        if request_id is None:
            if request_hash is not None:
                raise ValueError('A task request hash requires an explicit request id')
        else:
            _validate_request_id(request_id)
            if request_hash is not None:
                # Server-only override: HTTP/Telegram fingerprint their original
                # input before resolving mutable session/workspace defaults.
                request_hash = _validate_request_hash(request_hash)
            else:
                request_hash = hash_request_payload({
                    'prompt': prompt, 'cwd': cwd, 'model': model, 'provider': provider,
                    'skills': skills or [], 'session_id': session_id,
                    'approval_mode': approval_mode, 'chat_only': bool(chat_only), 'profile': profile,
                    # Keep the v1 TaskStore fingerprint for canonical profiles:
                    # runtime_id is a derived copy of that semantic field. If a
                    # caller supplies a runtime independently of its profile,
                    # bind the new identity explicitly so retries cannot change it.
                    **({'runtime_id': runtime_id} if explicit_runtime_id and profile != runtime_id else {}),
                    'project_binding': ({'specified': False} if project_id is _PROJECT_UNSET else
                                        {'specified': True, 'project_id': project_id}),
                })
        task_id = request_id if request_id is not None else uuid.uuid4().hex
        # Reserve the deterministic Prime session at enqueue time. The runner uses
        # the same id, so the UI can open it immediately instead of waiting for
        # the first worker event to finish creating session metadata.
        generated_session_id = not session_id
        session_id = session_id or _default_session_id(task_id, request_id)
        now = utcnow()
        with self.db.transaction() as conn:
            existing = (conn.execute('SELECT request_hash FROM tasks WHERE id=?', (task_id,)).fetchone()
                        if request_id is not None else None)
            if existing is not None:
                # Recheck under the write lock. A lookup before admission cannot
                # prevent two concurrent clients from submitting the same key.
                _require_matching_request(existing, request_hash)
            else:
                if generated_session_id:
                    session_id = _unique_generated_session_id(conn, task_id, request_id)
                if session_id and conn.execute(
                    "SELECT 1 FROM deleted_sessions WHERE session_id=? LIMIT 1", (session_id,)
                ).fetchone():
                    raise ValueError("Session has been deleted")
                current_binding = conn.execute(
                    "SELECT project_id FROM session_projects WHERE session_id=?", (session_id,),
                ).fetchone()
                project_snapshot = (project_id if project_id is not _PROJECT_UNSET else
                                    current_binding["project_id"] if current_binding else None)
                conn.execute(
                    """INSERT INTO tasks
                       (id,prompt,cwd,model,provider,session_id,profile,runtime_id,project_id,approval_mode,chat_only,skills_json,status,created_at,updated_at,request_hash)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?)""",
                    (task_id, prompt, cwd, model, provider, session_id, profile, runtime_id, project_snapshot,
                     approval_mode, int(chat_only), json.dumps(skills or []), now, now, request_hash),
                )
                self._append_event(conn, task_id, "task.queued", {"status": "queued"})
                if runtime_id is not None:
                    self.bind_session_owner(conn, session_id, runtime_id, cwd)
                if project_id is not _PROJECT_UNSET:
                    if current_binding is not None and current_binding['project_id'] != project_id:
                        raise ValueError("Session project changed during task admission; refresh before retrying")
                    conn.execute(
                        "INSERT INTO session_projects(session_id,project_id,updated_at) VALUES (?,?,?) "
                        "ON CONFLICT(session_id) DO NOTHING",
                        (session_id, project_id, now),
                    )
        return self.get(task_id)

    def lookup_request(self, request_id: str, request_hash: str) -> dict[str, Any] | None:
        """Find a retry before admission, without queuing or changing its task."""
        _validate_request_id(request_id)
        request_hash = _validate_request_hash(request_hash)
        with self.db.connect() as conn:
            existing = conn.execute('SELECT * FROM tasks WHERE id=?', (request_id,)).fetchone()
        if existing is None:
            return None
        _require_matching_request(existing, request_hash)
        return _decode(existing)

    def _append_event(self, conn, task_id: str, event_type: str, data: dict[str, Any],
                      *, attempt_id: str | None = None) -> int:
        cur = conn.execute(
            "INSERT INTO events(task_id,type,data_json,created_at,attempt_id) VALUES (?,?,?,?,?)",
            (task_id, event_type, json.dumps(data), utcnow(), attempt_id),
        )
        return int(cur.lastrowid)

    def append_event(self, task_id: str, event_type: str, data: dict[str, Any]) -> int:
        with self.db.transaction() as conn:
            return self._append_event(conn, task_id, event_type, data)

    def _matching_attempt(self, conn, task_id: str, attempt_id: str | None):
        if not isinstance(attempt_id, str) or not attempt_id:
            return None
        return conn.execute(
            """SELECT t.session_id,t.cwd,t.runtime_id,t.project_id,t.status,
                      a.id AS attempt_id,a.state,a.cancel_requested_at
               FROM tasks AS t JOIN task_attempts AS a
                 ON a.id=t.current_attempt_id AND a.task_id=t.id
               WHERE t.id=? AND t.current_attempt_id=? AND t.status='running'
                 AND a.state IN ('claimed','running') AND a.cancel_requested_at IS NULL""",
            (task_id, attempt_id),
        ).fetchone()

    def attempt_active(self, task_id: str, attempt_id: str | None) -> bool:
        """Return whether the captured attempt is still allowed to emit or launch."""
        with self.db.connect() as conn:
            return self._matching_attempt(conn, task_id, attempt_id) is not None

    def _attach_provisional_session(self, conn, task_id: str, existing, session_id: str,
                                    now: str) -> bool:
        announced = session_id
        if not isinstance(announced, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", announced):
            return False
        current = existing["session_id"]
        provisional = f"prime-{task_id}"
        if announced == current:
            return True
        # Canonical runtime tasks own exactly the session captured at admission.
        # Only legacy/injected tasks with the original provisional id may adopt
        # a newly created session, and only when no existing identity is merged.
        if existing["runtime_id"] in {"prime", "pi"} or current != provisional:
            return False
        if announced.startswith("pi-native-"):
            return False
        if conn.execute(
            "SELECT 1 FROM deleted_sessions WHERE session_id=?", (announced,),
        ).fetchone():
            return False

        # A runner may introduce a session only if that ID has no other task or
        # owner. Existing metadata is accepted solely when it agrees with this
        # task's frozen cwd/project; the event never authorizes a merge.
        if conn.execute(
            "SELECT 1 FROM tasks WHERE session_id=? AND id<>? LIMIT 1", (announced, task_id),
        ).fetchone():
            return False
        if conn.execute(
            "SELECT 1 FROM session_ownership WHERE session_id=?", (announced,),
        ).fetchone():
            return False
        cwd = existing["cwd"] if isinstance(existing["cwd"], str) and existing["cwd"].strip() else None
        location = conn.execute(
            "SELECT cwd FROM session_locations WHERE session_id=?", (announced,),
        ).fetchone()
        if location is not None and location["cwd"] != cwd:
            return False
        binding = conn.execute(
            "SELECT project_id FROM session_projects WHERE session_id=?", (announced,),
        ).fetchone()
        if binding is not None and binding["project_id"] != existing["project_id"]:
            return False
        if binding is None:
            conn.execute(
                "INSERT INTO session_projects(session_id,project_id,updated_at) VALUES (?,?,?)",
                (announced, existing["project_id"], now),
            )
        changed = conn.execute(
            "UPDATE tasks SET session_id=?,updated_at=? "
            "WHERE id=? AND current_attempt_id=? AND status='running' AND session_id=?",
            (announced, now, task_id, existing["attempt_id"], current),
        ).rowcount
        if not changed:
            return False
        self.db.remember_session_location(announced, cwd, "task", conn=conn)
        return True

    def append_running_event(self, task_id: str, event_type: str, data: dict[str, Any],
                             *, attempt_id: str | None = None) -> bool:
        """Persist an event only while its captured attempt remains eligible."""
        with self.db.transaction() as conn:
            attempt = self._matching_attempt(conn, task_id, attempt_id)
            if attempt is None:
                return False
            if event_type == "session" and data.get("session_id"):
                if not self._attach_provisional_session(
                    conn, task_id, attempt, str(data["session_id"]), utcnow(),
                ):
                    return False
            self._append_event(conn, task_id, event_type, data, attempt_id=attempt_id)
            return True

    @staticmethod
    def _validate_runner_id(runner_id: str) -> None:
        if not isinstance(runner_id, str) or not runner_id.strip():
            raise ValueError("runner_id must be a non-empty string")
        try:
            runner_id_bytes = runner_id.encode("utf-8")
        except UnicodeEncodeError as exc:
            raise ValueError("runner_id must be valid UTF-8") from exc
        if len(runner_id_bytes) > 256:
            raise ValueError("runner_id must be at most 256 UTF-8 bytes")

    def runner_generation_state(self, runner_id: str) -> dict[str, Any] | None:
        """Return the durable active runner generation without changing it."""
        self._validate_runner_id(runner_id)
        with self.db.connect() as conn:
            row = conn.execute(
                """SELECT runner_id,active_generation,last_runner_seq
                   FROM runner_generation_state WHERE runner_id=?""",
                (runner_id,),
            ).fetchone()
        if row is None:
            return None
        return {
            "runner_id": row["runner_id"],
            "active_generation": int(row["active_generation"]),
            "last_runner_seq": int(row["last_runner_seq"]),
        }

    def activate_runner_generation(
        self,
        runner_id: str,
        *,
        expected_generation: int,
        expected_last_runner_seq: int,
    ) -> dict[str, Any]:
        """Explicitly fence a lost/restored journal by advancing one generation.

        Callers must pass the generation and sequence from a prior state
        inspection. The compare-and-set refuses concurrent coordinator progress;
        old receipts are retained, while the new generation starts at sequence 1.
        Initial generation 1 is created by the first valid delivery instead.
        """
        self._validate_runner_id(runner_id)
        if (isinstance(expected_generation, bool) or not isinstance(expected_generation, int)
                or expected_generation < 1):
            raise ValueError("expected_generation must be a positive integer")
        if (isinstance(expected_last_runner_seq, bool)
                or not isinstance(expected_last_runner_seq, int)
                or expected_last_runner_seq < 0):
            raise ValueError("expected_last_runner_seq must be a non-negative integer")
        if expected_generation >= 2**63 - 1:
            raise ValueError("Runner journal generation cannot be advanced further")

        next_generation = expected_generation + 1
        with self.db.transaction() as conn:
            state = conn.execute(
                """SELECT active_generation,last_runner_seq FROM runner_generation_state
                   WHERE runner_id=?""",
                (runner_id,),
            ).fetchone()
            if state is None:
                raise ValueError("Runner generation state does not exist; initial generation starts on delivery")
            if (int(state["active_generation"]) != expected_generation
                    or int(state["last_runner_seq"]) != expected_last_runner_seq):
                raise ValueError("Runner generation state changed since inspection; refusing activation")
            if conn.execute(
                """SELECT 1 FROM runner_event_receipts
                   WHERE runner_id=? AND journal_generation=? LIMIT 1""",
                (runner_id, next_generation),
            ).fetchone():
                raise ValueError("Next runner generation already has receipts; refusing activation")
            updated = conn.execute(
                """UPDATE runner_generation_state
                   SET active_generation=?,last_runner_seq=0
                   WHERE runner_id=? AND active_generation=? AND last_runner_seq=?""",
                (next_generation, runner_id, expected_generation, expected_last_runner_seq),
            ).rowcount
            if updated != 1:
                raise ValueError("Runner generation state changed since inspection; refusing activation")
        return {
            "runner_id": runner_id,
            "active_generation": next_generation,
            "last_runner_seq": 0,
        }

    def _deliver_runner_journal_event(
        self,
        runner_id: str,
        journal_generation: int,
        runner_seq: int,
        *,
        task_id: str,
        attempt_id: str,
        event_type: str,
        data: dict[str, Any],
    ) -> dict[str, Any]:
        """Atomically record a runner delivery and, when current, its task event.

        ``task_id`` and ``attempt_id`` are captured by the server when it starts
        the runner; they are deliberately separate from the runner event data.
        A stale attempt still consumes its contiguous runner sequence and gets a
        durable receipt, but it cannot append a task event or keep session-binding
        side effects.
        """
        self._validate_runner_id(runner_id)
        if (isinstance(journal_generation, bool) or not isinstance(journal_generation, int)
                or journal_generation < 1):
            raise ValueError("journal_generation must be a positive integer")
        if isinstance(runner_seq, bool) or not isinstance(runner_seq, int) or runner_seq < 1:
            raise ValueError("runner sequence must be a positive integer")

        envelope_json, canonical_data = _canonical_runner_envelope(
            task_id, attempt_id, event_type, data,
        )
        receipt_key = (runner_id, journal_generation, runner_seq)

        def outcome(row) -> dict[str, Any]:
            event_seq = row["event_seq"]
            return {
                "runner_id": runner_id,
                "journal_generation": journal_generation,
                "runner_seq": runner_seq,
                "disposition": row["disposition"],
                "event_seq": int(event_seq) if event_seq is not None else None,
            }

        with self.db.transaction() as conn:
            state = conn.execute(
                "SELECT active_generation,last_runner_seq FROM runner_generation_state WHERE runner_id=?",
                (runner_id,),
            ).fetchone()
            receipt = conn.execute(
                """SELECT envelope_json,disposition,event_seq FROM runner_event_receipts
                   WHERE runner_id=? AND journal_generation=? AND runner_seq=?""",
                receipt_key,
            ).fetchone()

            if state is None:
                if receipt is not None:
                    raise ValueError("Runner delivery state is missing for an existing receipt")
                if journal_generation != 1:
                    raise ValueError("A runner must start at journal generation 1")
                if runner_seq != 1:
                    raise ValueError("Runner sequence gap: a new generation must start at sequence 1")
                conn.execute(
                    "INSERT INTO runner_generation_state(runner_id,active_generation,last_runner_seq) "
                    "VALUES (?,1,0)",
                    (runner_id,),
                )
                last_runner_seq = 0
            else:
                active_generation = int(state["active_generation"])
                if journal_generation != active_generation:
                    raise ValueError("Runner journal generation is stale or has not been activated")
                if receipt is not None:
                    if receipt["envelope_json"] != envelope_json:
                        raise ValueError("Runner event receipt conflicts with a different envelope")
                    return outcome(receipt)
                last_runner_seq = int(state["last_runner_seq"])
                if runner_seq <= last_runner_seq:
                    raise ValueError("Missing runner receipt for an already-consumed sequence")
                if runner_seq != last_runner_seq + 1:
                    raise ValueError("Runner sequence gap")

            active_attempt = self._matching_attempt(conn, task_id, attempt_id)
            disposition = "stale"
            event_seq: int | None = None
            if active_attempt is not None:
                attached = True
                announced_session = canonical_data.get("session_id")
                if event_type == "session" and announced_session:
                    # The existing attachment helper can insert project state
                    # before its guarded task update. Keep that provisional
                    # write isolated so a rejected announcement leaves only a
                    # stale receipt and does not commit partial binding state.
                    conn.execute("SAVEPOINT runner_session_attachment")
                    try:
                        attached = self._attach_provisional_session(
                            conn, task_id, active_attempt, str(announced_session), utcnow(),
                        )
                    except BaseException:
                        conn.execute("ROLLBACK TO SAVEPOINT runner_session_attachment")
                        conn.execute("RELEASE SAVEPOINT runner_session_attachment")
                        raise
                    else:
                        if not attached:
                            conn.execute("ROLLBACK TO SAVEPOINT runner_session_attachment")
                        conn.execute("RELEASE SAVEPOINT runner_session_attachment")
                if attached:
                    event_seq = self._append_event(
                        conn, task_id, event_type, canonical_data, attempt_id=attempt_id,
                    )
                    disposition = "accepted"

            now = utcnow()
            conn.execute(
                """INSERT INTO runner_event_receipts
                   (runner_id,journal_generation,runner_seq,envelope_json,disposition,event_seq,created_at)
                   VALUES (?,?,?,?,?,?,?)""",
                (*receipt_key, envelope_json, disposition, event_seq, now),
            )
            updated = conn.execute(
                """UPDATE runner_generation_state SET last_runner_seq=?
                   WHERE runner_id=? AND active_generation=? AND last_runner_seq=?""",
                (runner_seq, runner_id, journal_generation, last_runner_seq),
            ).rowcount
            if updated != 1:
                raise RuntimeError("Runner generation state changed during journal delivery")
            return {
                "runner_id": runner_id,
                "journal_generation": journal_generation,
                "runner_seq": runner_seq,
                "disposition": disposition,
                "event_seq": event_seq,
            }

    def get(self, task_id: str) -> dict[str, Any]:
        with self.db.connect() as conn:
            row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if row is None:
            raise KeyError(task_id)
        return _decode(row)

    def list(self, limit: int = 100) -> list[dict[str, Any]]:
        with self.db.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?", (max(1, min(limit, 500)),)
            ).fetchall()
        return [_decode(row) for row in rows]

    def has_running_session(self, session_id: str) -> bool:
        with self.db.connect() as conn:
            return conn.execute(
                "SELECT 1 FROM tasks WHERE session_id=? AND status IN ('queued','running','cancelling') LIMIT 1", (session_id,)
            ).fetchone() is not None

    def running_sessions(self, session_ids: list[str]) -> list[str]:
        unique_ids = list(dict.fromkeys(session_ids))
        if not unique_ids:
            return []
        placeholders = ",".join("?" for _ in unique_ids)
        with self.db.connect() as conn:
            rows = conn.execute(
                f"SELECT DISTINCT session_id FROM tasks WHERE status IN ('queued','running','cancelling') AND session_id IN ({placeholders})",
                unique_ids,
            ).fetchall()
        return [row["session_id"] for row in rows]

    def prepare_session_deletion(self, session_ids: list[str]) -> list[str]:
        """Atomically block future turns and purge idle task history.

        Returns session ids that still have accepted queued/running work; when the
        list is non-empty nothing is changed.
        """
        unique_ids = list(dict.fromkeys(session_ids))
        if not unique_ids:
            return []
        placeholders = ",".join("?" for _ in unique_ids)
        with self.db.transaction() as conn:
            active = [row["session_id"] for row in conn.execute(
                f"SELECT DISTINCT session_id FROM tasks WHERE status IN ('queued','running','cancelling') AND session_id IN ({placeholders})",
                unique_ids,
            )]
            if active:
                return active
            now = utcnow()
            conn.executemany(
                "INSERT INTO deleted_sessions(session_id,deleted_at) VALUES (?,?) "
                "ON CONFLICT(session_id) DO UPDATE SET deleted_at=excluded.deleted_at",
                [(session_id, now) for session_id in unique_ids],
            )
            conn.execute(
                f"DELETE FROM events WHERE task_id IN (SELECT id FROM tasks WHERE session_id IN ({placeholders}))",
                unique_ids,
            )
            conn.execute(f"DELETE FROM tasks WHERE session_id IN ({placeholders})", unique_ids)
            conn.execute(f"DELETE FROM session_locations WHERE session_id IN ({placeholders})", unique_ids)
            conn.execute(f"DELETE FROM session_projects WHERE session_id IN ({placeholders})", unique_ids)
        return []

    def purge_session(self, session_id: str) -> None:
        """Delete all backend task history associated with a deleted Hermes session."""
        self.purge_sessions([session_id])

    def purge_sessions(self, session_ids: list[str]) -> None:
        """Delete backend task history for a batch of deleted Hermes sessions."""
        unique_ids = list(dict.fromkeys(session_ids))
        if not unique_ids:
            return
        placeholders = ",".join("?" for _ in unique_ids)
        with self.db.transaction() as conn:
            conn.execute(
                f"DELETE FROM events WHERE task_id IN (SELECT id FROM tasks WHERE session_id IN ({placeholders}))",
                unique_ids,
            )
            conn.execute(f"DELETE FROM tasks WHERE session_id IN ({placeholders})", unique_ids)
            conn.execute(f"DELETE FROM session_locations WHERE session_id IN ({placeholders})", unique_ids)
            conn.execute(f"DELETE FROM session_projects WHERE session_id IN ({placeholders})", unique_ids)

    def events(self, task_id: str, after: int = 0, limit: int = 1000) -> list[dict[str, Any]]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """SELECT seq,task_id,type,data_json,created_at,attempt_id FROM events
                   WHERE task_id=? AND seq>? ORDER BY seq ASC LIMIT ?""",
                (task_id, after, max(1, min(limit, 5000))),
            ).fetchall()
        return [_decode_event(row) for row in rows]

    def all_events(self, after: int = 0, limit: int = 1000) -> list[dict[str, Any]]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """SELECT seq,task_id,type,data_json,created_at,attempt_id FROM events
                   WHERE seq>? ORDER BY seq ASC LIMIT ?""",
                (after, max(1, min(limit, 5000))),
            ).fetchall()
        return [_decode_event(row) for row in rows]

    def event_summaries(self, after: int = 0, limit: int = 1000) -> list[dict[str, Any]]:
        """Return log fields without loading unused event payloads."""
        with self.db.connect() as conn:
            rows = conn.execute(
                """SELECT seq, type, created_at,attempt_id FROM events
                   WHERE seq>? ORDER BY seq ASC LIMIT ?""",
                (after, max(1, min(limit, 5000))),
            ).fetchall()
        return [{"seq": row["seq"], "type": row["type"], "created_at": row["created_at"],
                 "attempt_id": row["attempt_id"]}
                for row in rows]

    def latest_event_seq(self) -> int:
        """Return the durable global event cursor without replaying the ledger."""
        with self.db.connect() as conn:
            row = conn.execute("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").fetchone()
        return int(row["seq"] if row else 0)

    def _create_attempt(self, conn, task, *, state: str, now: str,
                        started_at: str | None = None) -> str:
        attempt_id = uuid.uuid4().hex
        ordinal = conn.execute(
            "SELECT COALESCE(MAX(ordinal),0)+1 FROM task_attempts WHERE task_id=?", (task["id"],),
        ).fetchone()[0]
        conn.execute(
            """INSERT INTO task_attempts
               (id,task_id,ordinal,state,claimed_at,started_at,runtime_id,session_id,cwd,project_id)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (attempt_id, task["id"], ordinal, state, now, started_at, task["runtime_id"],
             task["session_id"], task["cwd"], task["project_id"]),
        )
        return attempt_id

    def mark_running(self, task_id: str) -> str | None:
        """Claim a queued fixture task and return the committed attempt id."""
        now = utcnow()
        with self.db.transaction() as conn:
            task = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            if task is None or task["status"] != "queued" or task["started_at"] is not None:
                return None
            if task["session_id"] and conn.execute(
                "SELECT 1 FROM tasks WHERE session_id=? AND status='running' LIMIT 1", (task["session_id"],),
            ).fetchone():
                return None
            attempt_id = self._create_attempt(conn, task, state="running", now=now, started_at=now)
            changed = conn.execute(
                """UPDATE tasks SET status='running',started_at=?,current_attempt_id=?,retry_at=NULL,
                          error=NULL,updated_at=?
                   WHERE id=? AND status='queued' AND started_at IS NULL""",
                (now, attempt_id, now, task_id),
            ).rowcount
            if not changed:
                return None
            self._append_event(conn, task_id, "task.running", {"status": "running"}, attempt_id=attempt_id)
            return attempt_id

    def mark_attempt_running(self, task_id: str, *, attempt_id: str | None = None) -> bool:
        """Record adapter invocation after validation/preflight has succeeded."""
        now = utcnow()
        with self.db.transaction() as conn:
            if self._matching_attempt(conn, task_id, attempt_id) is None:
                return False
            changed = conn.execute(
                """UPDATE task_attempts SET state='running',started_at=COALESCE(started_at,?)
                   WHERE id=? AND task_id=? AND state='claimed' AND cancel_requested_at IS NULL""",
                (now, attempt_id, task_id),
            ).rowcount
            return bool(changed)

    def defer_for_quota(self, task_id: str, retry_seconds: float, *, attempt_id: str | None = None) -> None:
        """Compatibility entry point: a quota error cannot prove no work happened.

        Keep the former call signature for integrations, but never queue a
        started task again without an explicit, reviewed new submission.
        """
        self.interrupt(task_id, "provider_limit", "Provider limit reached.", attempt_id=attempt_id)

    def claim_next(self) -> dict[str, Any] | None:
        now = utcnow()
        with self.db.transaction() as conn:
            row = conn.execute(
                """SELECT candidate.* FROM tasks AS candidate
                   WHERE candidate.status='queued'
                     AND candidate.started_at IS NULL
                     AND (candidate.retry_at IS NULL OR candidate.retry_at <= ?)
                     AND (candidate.session_id IS NULL OR NOT EXISTS (
                       SELECT 1 FROM tasks AS active
                       WHERE active.session_id=candidate.session_id AND active.status='running'
                     ))
                   ORDER BY candidate.created_at ASC LIMIT 1""", (utcnow(),)
            ).fetchone()
            if row is None:
                return None
            attempt_id = self._create_attempt(conn, row, state="claimed", now=now)
            changed = conn.execute(
                """UPDATE tasks SET status='running',started_at=COALESCE(started_at,?),retry_at=NULL,error=NULL,updated_at=?
                   ,current_attempt_id=? WHERE id=? AND status='queued' AND started_at IS NULL""",
                (now, now, attempt_id, row["id"]),
            ).rowcount
            if not changed:
                return None
            self._append_event(conn, row["id"], "task.running", {"status": "running"}, attempt_id=attempt_id)
        return self.get(row["id"])

    def set_session(self, task_id: str, session_id: str, *, attempt_id: str | None = None) -> bool:
        """Attach a session to a task while it is still running.

        COALESCE keeps whatever is already there, so a resumed task never has its
        session rewritten by a late announcement.
        """
        now = utcnow()
        with self.db.transaction() as conn:
            existing = self._matching_attempt(conn, task_id, attempt_id)
            if existing is None:
                return False
            return self._attach_provisional_session(conn, task_id, existing, session_id, now)

    def complete(self, task_id: str, result: dict[str, Any], *, attempt_id: str | None = None) -> bool:
        now = utcnow()
        event_result = dict(result)
        if isinstance(event_result.get("text"), str):
            event_result["text"] = _cap_event_text(event_result["text"])
        with self.db.transaction() as conn:
            existing = self._matching_attempt(conn, task_id, attempt_id)
            if existing is None:
                return False
            result_session = result.get("session_id")
            if result_session:
                if not self._attach_provisional_session(conn, task_id, existing, str(result_session), now):
                    raise ValueError("Runner result session does not match its admitted identity")
            changed = conn.execute(
                """UPDATE tasks SET status='completed',result_json=?,error=NULL,
                   completed_at=?,updated_at=?
                   WHERE id=? AND current_attempt_id=? AND status='running'""",
                (json.dumps(result), now, now, task_id, attempt_id),
            ).rowcount
            if not changed:
                return False
            conn.execute(
                "UPDATE task_attempts SET state='completed',finished_at=? WHERE id=? AND task_id=?",
                (now, attempt_id, task_id),
            )
            self._append_event(
                conn,
                task_id,
                "task.completed",
                {"status": "completed", "result": event_result},
                attempt_id=attempt_id,
            )
            return True

    def fail(self, task_id: str, error: str, *, attempt_id: str | None = None) -> bool:
        now = utcnow()
        with self.db.transaction() as conn:
            if self._matching_attempt(conn, task_id, attempt_id) is None:
                return False
            changed = conn.execute(
                """UPDATE tasks SET status='failed',error=?,completed_at=?,updated_at=?
                   WHERE id=? AND current_attempt_id=? AND status='running'""",
                (error[:4000], now, now, task_id, attempt_id),
            ).rowcount
            if changed:
                conn.execute(
                    "UPDATE task_attempts SET state='failed',finished_at=?,error=? WHERE id=? AND task_id=?",
                    (now, error[:4000], attempt_id, task_id),
                )
                self._append_event(conn, task_id, "task.failed", {"status": "failed", "error": error[:4000]}, attempt_id=attempt_id)
            return bool(changed)

    def cancel_queued(self, task_id: str) -> bool:
        """Cancel only an unclaimed task; a raced claim needs runner teardown."""
        now = utcnow()
        with self.db.transaction() as conn:
            changed = conn.execute(
                """UPDATE tasks SET status='cancelled',completed_at=?,updated_at=?
                   WHERE id=? AND status='queued' AND started_at IS NULL""",
                (now, now, task_id),
            ).rowcount
            if changed:
                self._append_event(conn, task_id, "task.cancelled", {"status": "cancelled"})
        return bool(changed)

    def request_cancel(self, task_id: str, *, attempt_id: str | None = None) -> bool:
        now = utcnow()
        with self.db.transaction() as conn:
            row = conn.execute(
                """SELECT a.cancel_requested_at FROM tasks AS t JOIN task_attempts AS a
                     ON a.id=t.current_attempt_id AND a.task_id=t.id
                   WHERE t.id=? AND t.current_attempt_id=? AND t.status='running'
                     AND a.state IN ('claimed','running')""",
                (task_id, attempt_id),
            ).fetchone()
            if row is None:
                return False
            if row["cancel_requested_at"] is not None:
                return True
            changed = conn.execute(
                "UPDATE task_attempts SET cancel_requested_at=? WHERE id=? AND task_id=? AND cancel_requested_at IS NULL",
                (now, attempt_id, task_id),
            ).rowcount
            if changed:
                self._append_event(
                    conn, task_id, "task.cancel_requested", {"status": "running"}, attempt_id=attempt_id,
                )
            return bool(changed)

    def cancel(self, task_id: str, *, attempt_id: str | None = None) -> bool:
        now = utcnow()
        with self.db.transaction() as conn:
            row = conn.execute(
                """SELECT a.cancel_requested_at FROM tasks AS t JOIN task_attempts AS a
                     ON a.id=t.current_attempt_id AND a.task_id=t.id
                   WHERE t.id=? AND t.current_attempt_id=? AND t.status='running'
                     AND a.state IN ('claimed','running')""",
                (task_id, attempt_id),
            ).fetchone()
            if row is None or row["cancel_requested_at"] is None:
                return False
            changed = conn.execute(
                "UPDATE tasks SET status='cancelled',completed_at=?,updated_at=? WHERE id=? AND current_attempt_id=? AND status='running'",
                (now, now, task_id, attempt_id),
            ).rowcount
            if changed:
                conn.execute(
                    "UPDATE task_attempts SET state='cancelled',finished_at=? WHERE id=? AND task_id=?",
                    (now, attempt_id, task_id),
                )
                self._append_event(conn, task_id, "task.cancelled", {"status": "cancelled"}, attempt_id=attempt_id)
            return bool(changed)

    def recover_inflight(self) -> int:
        """Record unknown outcomes without replaying potentially applied effects.

        A former version also put quota-limited tasks back into the queue after
        execution started. Only queued rows with no started_at are safe to keep
        eligible on startup. No claim is made that an orphaned runner stopped.
        """
        with self.db.transaction() as conn:
            rows = conn.execute(
                """SELECT * FROM tasks WHERE status IN ('running','cancelling')
                   OR (status='queued' AND started_at IS NOT NULL)"""
            ).fetchall()
            for row in rows:
                attempt_id = row["current_attempt_id"]
                attempt = conn.execute(
                    "SELECT id,state FROM task_attempts WHERE id=? AND task_id=?",
                    (attempt_id, row["id"]),
                ).fetchone() if attempt_id else None
                if attempt is None or attempt["state"] not in {"claimed", "running"}:
                    attempt_id = self._create_attempt(
                        conn, row, state="running", now=utcnow(),
                        started_at=row["started_at"] or utcnow(),
                    )
                    conn.execute(
                        "UPDATE tasks SET current_attempt_id=? WHERE id=?",
                        (attempt_id, row["id"]),
                    )
                self._interrupt(
                    conn, row["id"], row["status"], "server_restart", attempt_id,
                    "Server restarted before an execution outcome was recorded.",
                )
        return len(rows)

    def interrupt(self, task_id: str, reason: str, error: str, *, attempt_id: str | None = None) -> bool:
        """Finish a started task in the current clients' failed-status envelope."""
        with self.db.transaction() as conn:
            row = conn.execute(
                "SELECT status FROM tasks WHERE id=? AND current_attempt_id=?", (task_id, attempt_id),
            ).fetchone()
            if row is None or row["status"] not in {"running", "cancelling"}:
                return False
            if self._matching_attempt(conn, task_id, attempt_id) is None:
                return False
            return self._interrupt(conn, task_id, row["status"], reason, attempt_id, error)

    def _interrupt(self, conn, task_id: str, previous_status: str, reason: str,
                   attempt_id: str, error: str) -> bool:
        now = utcnow()
        recovery = {
            "reason": reason,
            "previous_status": previous_status,
            "side_effects": "unknown",
            "review_required": True,
            "automatic_retry": False,
        }
        error = f"{error[:3500]} {_RECOVERY_GUIDANCE}"
        # Use the supported terminal status/event instead of inventing an
        # interrupted status that existing clients would continue polling.
        changed = conn.execute(
            """UPDATE tasks SET status='failed',result_json=?,error=?,retry_at=NULL,
               completed_at=?,updated_at=? WHERE id=? AND current_attempt_id=? AND status=?""",
            (json.dumps({"recovery": recovery}), error, now, now, task_id, attempt_id, previous_status),
        ).rowcount
        if changed:
            conn.execute(
                "UPDATE task_attempts SET state='interrupted',finished_at=?,error=? WHERE id=? AND task_id=?",
                (now, error[:4000], attempt_id, task_id),
            )
            self._append_event(conn, task_id, "task.failed", {
                "status": "failed", "error": error, "recovery": recovery,
            }, attempt_id=attempt_id)
        return bool(changed)


class TaskEngine:
    def __init__(
        self,
        store: TaskStore,
        runner: Runner | Mapping[str, Runner],
        poll_seconds: float = 0.5,
        quota_retry_seconds: float = 18000,
        *,
        registry: RuntimeRegistry | None = None,
        preflight: Callable[[dict[str, Any]], None] | None = None,
        journal: RunnerJournal | None = None,
    ):
        self.store = store
        self.runner = runner
        self.registry = registry
        self.preflight = preflight
        self.journal = journal
        self.poll_seconds = poll_seconds
        # Retain the constructor argument for callers; started work is no longer
        # replayed automatically after a provider error.
        self.quota_retry_seconds = quota_retry_seconds
        self._stop = asyncio.Event()
        self._recovered = False

    async def run_once(self, *, worker_id: str | None = None, tracker=None) -> bool:
        # Keep the runner sequence contiguous before claiming more work. If a
        # prior coordinator delivery failed, replay must succeed before this
        # worker can emit events for another task.
        self.replay_unacked()
        task = self.store.claim_next()
        if task is None:
            return False
        attempt_id = task["current_attempt_id"]
        if worker_id is not None and tracker is not None:
            tracker.claimed(worker_id, task["id"], attempt_id)
        # This callback is adapter-only ephemeral state. It is never part of a
        # persisted task, event, or result payload.
        task["_attempt_active"] = lambda: self.store.attempt_active(task["id"], attempt_id)
        emitted_event_count = 0

        async def emit(event_type: str, data: dict[str, Any]) -> None:
            nonlocal emitted_event_count
            # Hermes announces its session id on stderr as soon as it has one,
            # long before the task finishes. Persist it the moment it arrives so
            # the row is addressable while it is still running — otherwise every
            # follow-up prompt has no session to continue and opens a new one.
            if self.journal is None:
                self.store.append_running_event(task["id"], event_type, data, attempt_id=attempt_id)
                return

            _, canonical_data = _canonical_runner_envelope(
                task["id"], attempt_id, event_type, data,
            )
            emitted_event_count += 1
            payload = {
                "task_id": task["id"],
                "attempt_id": attempt_id,
                "event_type": event_type,
                "data": canonical_data,
            }
            entry = self.journal.append(
                _runner_event_key(task["id"], attempt_id, emitted_event_count), payload,
            )
            self._deliver_journal_entry(entry)

        try:
            if self.registry is not None:
                self.registry.validate(task)
            if self.preflight is not None:
                self.preflight(task)
            runner = self._runner_for(task)
            if not self.store.mark_attempt_running(task["id"], attempt_id=attempt_id):
                raise RunnerCancelled(task["id"])
            if not self.store.attempt_active(task["id"], attempt_id):
                raise RunnerCancelled(task["id"])
            # Missing output does not prove that the runner made no side effects.
            # Each claim invokes the runner once, including transport failures.
            result = await runner.run(task, emit)
        except RunnerCancelled:
            if not self.store.cancel(task["id"], attempt_id=attempt_id):
                self.store.fail(task["id"], "Runner stopped without a durable cancellation request.",
                                attempt_id=attempt_id)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            message = str(exc)
            if is_quota_error(message):
                self.store.interrupt(task["id"], "provider_limit", message, attempt_id=attempt_id)
            elif "Daemon worker client closed" in message:
                self.store.interrupt(task["id"], "runner_disconnected", message, attempt_id=attempt_id)
            else:
                self.store.fail(task["id"], message, attempt_id=attempt_id)
        else:
            try:
                self.store.complete(task["id"], result, attempt_id=attempt_id)
            except ValueError as exc:
                # A malformed or cross-session result is a runner failure. Keep
                # the row/attempt terminal instead of killing this worker while
                # leaving its durable attempt marked running.
                self.store.fail(task["id"], str(exc), attempt_id=attempt_id)
        finally:
            if worker_id is not None and tracker is not None:
                tracker.finished(worker_id)
        return True

    def replay_unacked(self) -> int:
        """Deliver every committed journal entry before workers start.

        Each entry stays in the runner outbox unless TaskStore returns from its
        transaction with a durable receipt. Delivery or acknowledgement errors
        propagate so startup cannot silently skip pending events.
        """
        if self.journal is None:
            return 0
        entries = self.journal.replay_unacked()
        for entry in entries:
            self._deliver_journal_entry(entry)
        return len(entries)

    def _deliver_journal_entry(self, entry: JournalEntry) -> dict[str, Any]:
        journal = self.journal
        if journal is None:
            raise RuntimeError("Runner journal is not configured")
        payload = entry.payload
        if not isinstance(payload, dict):
            raise ValueError("Runner journal event payload must be an object")
        task_id = payload.get("task_id")
        attempt_id = payload.get("attempt_id")
        event_type = payload.get("event_type")
        data = payload.get("data")
        if (not isinstance(task_id, str) or not task_id
                or not isinstance(attempt_id, str) or not attempt_id
                or not isinstance(event_type, str)
                or not isinstance(data, dict)):
            raise ValueError("Runner journal event payload is malformed")
        receipt = self.store._deliver_runner_journal_event(
            entry.runner_id,
            entry.journal_generation,
            entry.runner_seq,
            task_id=task_id,
            attempt_id=attempt_id,
            event_type=event_type,
            data=data,
        )
        # _deliver_runner_journal_event returns only after the event and receipt
        # transaction commits. Acking any earlier could lose the runner event.
        if (not isinstance(receipt, dict)
                or receipt.get("runner_id") != entry.runner_id
                or receipt.get("journal_generation") != entry.journal_generation
                or receipt.get("runner_seq") != entry.runner_seq):
            raise RuntimeError("TaskStore did not return a durable runner event receipt")
        journal.acknowledge(entry.runner_seq)
        return receipt

    def _runner_for(self, task: dict[str, Any]) -> Runner:
        if self.registry is not None:
            return self.registry.runner_for(task)
        if isinstance(self.runner, Mapping):
            profile = task.get("profile")
            key = "default" if profile is None else str(profile)
            if key not in self.runner:
                raise ValueError(f"Unknown runtime profile: {key}")
            return self.runner[key]
        return self.runner

    async def cancel(self, task_id: str) -> None:
        task = self.store.get(task_id)
        if task["status"] == "queued":
            if self.store.cancel_queued(task_id):
                return
            # The worker may have claimed the task between the initial read and
            # the transactional cancellation. Re-check and cancel its process
            # instead of silently allowing the turn to run.
            task = self.store.get(task_id)
            if task["status"] != "running":
                return
        if task["status"] != "running":
            return
        attempt_id = task.get("current_attempt_id")
        if not isinstance(attempt_id, str) or not attempt_id:
            return
        if not self.store.request_cancel(task_id, attempt_id=attempt_id):
            return
        cancel = getattr(self._runner_for(task), "cancel", None)
        if cancel is None:
            raise RuntimeError("The active runner cannot cancel process groups")
        await cancel(task_id)
        self.store.cancel(task_id, attempt_id=attempt_id)

    async def run_forever(self, worker_id: str | None = None, tracker=None) -> None:
        # Multiple workers share one engine. Recover only once; repeating this
        # operation lets one worker interrupt tasks already claimed by another.
        heartbeat_task = None
        if worker_id is not None and tracker is not None:
            from .readiness import worker_heartbeat_task

            tracker.register(worker_id)
            heartbeat_task = worker_heartbeat_task(
                worker_id, tracker, asyncio.current_task(),
                interval=min(1.0, max(0.1, self.poll_seconds)),
            )
        try:
            if not self._recovered:
                self._recovered = True
                self.store.recover_inflight()
            while not self._stop.is_set():
                worked = await self.run_once(worker_id=worker_id, tracker=tracker)
                if not worked:
                    try:
                        await asyncio.wait_for(self._stop.wait(), timeout=self.poll_seconds)
                    except TimeoutError:
                        pass
        except asyncio.CancelledError:
            if worker_id is not None and tracker is not None:
                tracker.stopped(worker_id)
            raise
        except sqlite3.Error:
            if worker_id is not None and tracker is not None:
                tracker.stopped(worker_id, error_code="worker_storage_failed")
            raise
        except Exception:
            if worker_id is not None and tracker is not None:
                tracker.stopped(worker_id, error_code="worker_loop_failed")
            raise
        else:
            if worker_id is not None and tracker is not None:
                tracker.stopped(worker_id)
        finally:
            if heartbeat_task is not None:
                heartbeat_task.cancel()
                try:
                    await heartbeat_task
                except asyncio.CancelledError:
                    pass

    def stop(self) -> None:
        self._stop.set()
