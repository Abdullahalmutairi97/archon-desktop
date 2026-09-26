"""Process-local worker liveness and dispatch readiness reporting."""

from __future__ import annotations

import asyncio
import threading
import time
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any, Callable


def _utc_iso(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


class WorkerTracker:
    """Tracks this server process's worker heartbeats and current claims.

    SQLite remains authoritative for tasks and attempts. These counters reset at
    process start and describe only whether this server's dispatch loops are
    alive and responsive.
    """

    def __init__(
        self,
        clock: Callable[[], datetime] | None = None,
        monotonic: Callable[[], float] | None = None,
        *,
        heartbeat_timeout_seconds: float = 5.0,
    ) -> None:
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._monotonic = monotonic or time.monotonic
        self.heartbeat_timeout_seconds = max(0.1, float(heartbeat_timeout_seconds))
        self._lock = threading.RLock()
        self._configured_ids: tuple[str, ...] = ()
        self._workers: dict[str, dict[str, Any]] = {}

    def configure(self, worker_ids: list[str] | tuple[str, ...]) -> None:
        """Declare the expected worker ids before the app starts its tasks."""
        normalized = tuple(str(worker_id) for worker_id in worker_ids)
        if len(set(normalized)) != len(normalized) or any(not item for item in normalized):
            raise ValueError("Worker ids must be unique nonempty strings")
        with self._lock:
            self._configured_ids = normalized

    def _record(self, worker_id: str) -> dict[str, Any]:
        return self._workers.setdefault(worker_id, {
            "state": "starting",
            "last_heartbeat_at": None,
            "last_heartbeat_tick": None,
            "last_claim_at": None,
            "current_task_id": None,
            "current_attempt_id": None,
            "last_error_code": None,
        })

    def register(self, worker_id: str) -> None:
        with self._lock:
            record = self._record(worker_id)
            if record["state"] in {"stopped", "crashed"}:
                return
            record["state"] = "idle"
            self._heartbeat(record)

    def _heartbeat(self, record: dict[str, Any]) -> None:
        record["last_heartbeat_at"] = _utc_iso(self._clock())
        record["last_heartbeat_tick"] = self._monotonic()

    def heartbeat(self, worker_id: str) -> None:
        with self._lock:
            record = self._record(worker_id)
            if record["state"] in {"stopped", "crashed"}:
                return
            record["state"] = "busy" if record["current_task_id"] is not None else "idle"
            self._heartbeat(record)

    def claimed(self, worker_id: str, task_id: str, attempt_id: str) -> None:
        with self._lock:
            record = self._record(worker_id)
            if record["state"] in {"stopped", "crashed"}:
                return
            record["state"] = "busy"
            record["last_claim_at"] = _utc_iso(self._clock())
            record["current_task_id"] = task_id
            record["current_attempt_id"] = attempt_id
            self._heartbeat(record)

    def finished(self, worker_id: str) -> None:
        with self._lock:
            record = self._record(worker_id)
            record["current_task_id"] = None
            record["current_attempt_id"] = None
            if record["state"] not in {"stopped", "crashed"}:
                record["state"] = "idle"
                self._heartbeat(record)

    def stopped(self, worker_id: str, error_code: str | None = None) -> None:
        with self._lock:
            record = self._record(worker_id)
            record["state"] = "crashed" if error_code else "stopped"
            if error_code:
                # Callers provide a classification, never exception text.
                if error_code == "worker_storage_failed":
                    record["last_error_code"] = "worker_storage_failed"
                elif record["last_error_code"] is None:
                    record["last_error_code"] = "worker_loop_failed"

    def snapshot(
        self,
        worker_tasks: Mapping[str, asyncio.Task] | None,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        """Return bounded liveness details, using task state as final authority."""
        now = now or self._clock()
        tick = self._monotonic()
        task_map = worker_tasks or {}
        with self._lock:
            worker_ids = self._configured_ids or tuple(dict.fromkeys((*self._workers, *task_map)))
            items: list[dict[str, Any]] = []
            for worker_id in worker_ids:
                record = dict(self._record(worker_id))
                task = task_map.get(worker_id)
                elapsed = (
                    max(0.0, tick - record["last_heartbeat_tick"])
                    if record["last_heartbeat_tick"] is not None else None
                )
                task_alive = task is not None and not task.done()
                heartbeat_fresh = elapsed is not None and elapsed <= self.heartbeat_timeout_seconds
                state = record["state"]
                if task is not None and task.done():
                    if task.cancelled():
                        state = "stopped"
                    else:
                        try:
                            failed = task.exception() is not None
                        except asyncio.CancelledError:
                            failed = False
                        state = "crashed" if failed else "stopped"
                        if failed and record["last_error_code"] is None:
                            record["last_error_code"] = "worker_loop_failed"
                elif state not in {"stopped", "crashed"} and not heartbeat_fresh:
                    state = "stale" if record["last_heartbeat_at"] is not None else "starting"
                live = task_alive and heartbeat_fresh and state not in {"stopped", "crashed", "stale", "starting"}
                items.append({
                    "id": worker_id,
                    "state": state,
                    "live": bool(live),
                    "busy": bool(live and record["current_task_id"] is not None),
                    "last_heartbeat_at": record["last_heartbeat_at"],
                    "last_claim_at": record["last_claim_at"],
                    "current_task_id": record["current_task_id"],
                    "current_attempt_id": record["current_attempt_id"],
                    "last_error_code": record["last_error_code"],
                })
            live = sum(item["live"] for item in items)
            busy = sum(item["busy"] for item in items)
            return {
                "configured": len(worker_ids),
                "live": live,
                "busy": busy,
                "items": items,
                "process_scope": "server_process",
                "snapshot_at": _utc_iso(now),
            }


async def _heartbeat_until_worker_stops(
    worker_id: str,
    tracker: WorkerTracker,
    owner: asyncio.Task,
    interval: float,
) -> None:
    while not owner.done():
        tracker.heartbeat(worker_id)
        await asyncio.sleep(interval)


def worker_heartbeat_task(
    worker_id: str,
    tracker: WorkerTracker,
    owner: asyncio.Task,
    interval: float = 1.0,
) -> asyncio.Task:
    """Start the worker's liveness monitor; caller must cancel it on exit."""
    return asyncio.create_task(
        _heartbeat_until_worker_stops(worker_id, tracker, owner, max(0.1, interval)),
        name=f"archon-worker-heartbeat-{worker_id}",
    )


def build_readiness_snapshot(
    store,
    runtimes,
    tracker: WorkerTracker,
    worker_tasks: Mapping[str, asyncio.Task],
    *,
    configured_workers: int,
    workers_enabled: bool,
    remote_access_mode: str,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Build the authenticated, side-effect-free dispatch readiness response."""
    storage: dict[str, Any]
    queue: dict[str, Any]
    try:
        stats = store.readiness_stats()
        storage = {"status": "ready", "readable": True, "writable": True}
        queue = {
            "queued": stats["queued"],
            "running": stats["running"],
        }
        oldest_at = stats.get("oldest_queued_at")
        if oldest_at:
            try:
                oldest = datetime.fromisoformat(oldest_at.replace("Z", "+00:00"))
                if oldest.tzinfo is not None:
                    oldest = oldest.astimezone(timezone.utc)
                    snapshot_time = now or datetime.now(timezone.utc)
                    if snapshot_time.tzinfo is None:
                        snapshot_time = snapshot_time.replace(tzinfo=timezone.utc)
                    queue["oldest_queued_at"] = _utc_iso(oldest)
                    queue["oldest_queued_age_seconds"] = max(
                        0.0, (snapshot_time.astimezone(timezone.utc) - oldest).total_seconds(),
                    )
            except (TypeError, ValueError, OverflowError):
                pass
    except Exception:
        storage = {
            "status": "unavailable",
            "readable": False,
            "writable": False,
            "last_error_code": "storage_unavailable",
        }
        queue = {"queued": None, "running": None}

    worker_info = tracker.snapshot(worker_tasks, now=now)
    worker_items = worker_info["items"]
    if not workers_enabled:
        worker_items = [
            {**item, "state": "disabled", "live": False, "busy": False}
            for item in worker_items
        ]
    elif len(worker_items) < configured_workers:
        known = {item["id"] for item in worker_items}
        worker_items.extend(
            {
                "id": f"worker-{index + 1}",
                "state": "starting",
                "live": False,
                "busy": False,
                "last_heartbeat_at": None,
                "last_claim_at": None,
                "current_task_id": None,
                "current_attempt_id": None,
                "last_error_code": None,
            }
            for index in range(configured_workers)
            if f"worker-{index + 1}" not in known
        )
    live_workers = sum(bool(item["live"]) for item in worker_items)
    busy_workers = sum(bool(item["busy"]) for item in worker_items)
    workers = {
        "configured": configured_workers,
        "enabled": workers_enabled,
        "live": live_workers,
        "busy": busy_workers,
        "items": worker_items,
        "scope": "server_process",
    }

    try:
        descriptions = runtimes.describe()
    except Exception:
        descriptions = []
    runtime_info: list[dict[str, Any]] = []
    for description in descriptions:
        check_type = description.get("availability_check", "unknown")
        available = bool(description.get("available")) and check_type == "executable_file"
        item = {
            "id": description.get("id"),
            "available": available,
            "dispatch_ready": available,
            "check_type": check_type,
            "version_verified": False,
        }
        if not available:
            item["last_error_code"] = (
                "executable_unavailable" if check_type == "executable_file"
                else "executable_not_configured"
            )
        runtime_info.append(item)

    dispatch_ready = (
        storage["status"] == "ready"
        and workers_enabled
        and configured_workers > 0
        and live_workers == configured_workers
        and any(item["dispatch_ready"] for item in runtime_info)
    )
    response: dict[str, Any] = {
        "dispatch_ready": dispatch_ready,
        "execution_verified": False,
        "credentials_verified": False,
        "native_conformance_verified": False,
        "storage": storage,
        "workers": workers,
        "queue": queue,
        "runtimes": runtime_info,
        "transport": {
            "mode": remote_access_mode,
            "configuration_verified": True,
            "private_tls_verified": False,
            "verification_level": "configuration_only",
        },
    }
    return response
