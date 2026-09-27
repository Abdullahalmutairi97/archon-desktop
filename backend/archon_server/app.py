from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import stat
import threading
import uuid
from contextlib import asynccontextmanager
from collections.abc import Mapping
from pathlib import Path
from typing import Annotated, Any

from fastapi import Depends, FastAPI, File, Header, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .config import Settings
from .admission import SessionWorkspace, admit_workspace, revalidate_workspace
from .ownership import SessionOwnershipService
from .runtimes import RuntimeRegistry
from .db import Database
from .prime_runner import PrimeRunner
from .pi_runner import PiRunner
from .services.backups import BackupScheduleService, BackupService
from .services.commands import CommandRunner
from .services.cron import CronService
from .services.files import DEFAULT_READ_BYTES, MAX_READ_BYTES, FileService
from .services.logs import LogService
from .services.migration import MigrationService
from .services.models import ModelService
from .services.skills import SkillService
from .services.prime_skills import PrimeSkillService
from .services.agent_resources import AgentResourceService
from .services.status import StatusService
from .services.terminal import TmuxService
from .services.agents import AgentService
from .services.telegram import TelegramBotClient, TelegramBridge
from .services.kanban import KanbanService
from .services.voice import VoiceService
from .services.workspace import ProjectService, SessionService, PrimeSessionService
from .workspace_provisioner import WorkspaceCheckoutProvisioner
from .workspace_files import (
    DEFAULT_LIST_LIMIT,
    DEFAULT_READ_BYTES as DEFAULT_WORKSPACE_READ_BYTES,
    MAX_LIST_LIMIT,
    MAX_READ_BYTES as MAX_WORKSPACE_READ_BYTES,
    MAX_RELATIVE_PATH_LENGTH,
    MAX_SEARCH_QUERY_BYTES,
    MAX_WRITE_CHARACTERS as MAX_WORKSPACE_WRITE_CHARACTERS,
    WorkspaceFileService,
    WorkspaceFilesError,
)
from .tasks import TaskEngine, TaskStore, hash_request_payload
from .runner_journal import RunnerJournal, RunnerJournalError, UnsafeJournalPath
from .runner_ownership import RunnerOwnershipLock
from .local_pairing import LocalPairingBroker, UnixSocketPairingServer
from .services.local_codex_worker import (
    LocalCodexOutcomeUnknown,
    LocalCodexRequestRejected,
    LocalCodexWorkerClient,
    LocalCodexWorkerError,
)
from .security import token_authorized, validate_server_security
from .readiness import WorkerTracker, build_readiness_snapshot


logger = logging.getLogger(__name__)
workspace_file_write_lock = threading.Lock()
WEBSOCKET_AUTH_TIMEOUT_SECONDS = 5.0
LOCAL_TASK_RUNNER_ID = "archon-desktop-local"
LOCAL_CODEX_PROJECT_ID = re.compile(r"^codex-project:[A-Za-z0-9._:-]{1,242}$")
LOCAL_CODEX_TASK_ID = re.compile(r"^codex-task:[A-Za-z0-9._:-]{1,245}$")
LOCAL_CODEX_SESSION_ID = re.compile(r"^codex:[A-Za-z0-9._:-]{1,250}$")
LOCAL_CODEX_APPROVAL_ID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


def _prepare_private_runner_journal_dir(path: Path) -> None:
    """Create or tighten the journal directory without following its final symlink."""
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        raise UnsafeJournalPath("cannot safely open runner journal directory") from exc
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
            raise UnsafeJournalPath("runner journal directory must be owned by the current user")
        if stat.S_IMODE(info.st_mode) != 0o700:
            os.fchmod(descriptor, 0o700)
    finally:
        os.close(descriptor)


def _validate_runner_journal_state(store: TaskStore, journal: RunnerJournal) -> None:
    """Reject coordinator or journal rollback before worker recovery can claim tasks."""
    state = store.runner_generation_state(journal.runner_id)
    entries = journal.replay_unacked()
    journal_last = journal.last_sequence
    pending = {entry.runner_seq for entry in entries}

    if state is None:
        # With no coordinator receipt, every committed runner event must still
        # be available for replay. Otherwise the coordinator database was
        # restored behind an already-acknowledged journal event.
        if len(pending) != journal_last or any(
            sequence != expected
            for expected, sequence in enumerate(sorted(pending), start=1)
        ):
            raise RunnerJournalError(
                "coordinator runner state is missing committed journal history"
            )
        return

    active_generation = int(state["active_generation"])
    coordinator_last = int(state["last_runner_seq"])
    if active_generation != journal.journal_generation:
        raise RunnerJournalError("coordinator and local runner journal generations disagree")
    if coordinator_last > journal_last:
        raise RunnerJournalError("local runner journal is behind coordinator delivery state")
    future_pending = sorted(sequence for sequence in pending if sequence > coordinator_last)
    missing_count = journal_last - coordinator_last
    if len(future_pending) != missing_count or any(
        sequence != coordinator_last + offset
        for offset, sequence in enumerate(future_pending, start=1)
    ):
        raise RunnerJournalError("local runner journal cannot replay coordinator delivery gap")


def _runner_recovery_diagnostic(store: TaskStore, runner_id: str) -> str:
    """Format bounded read-only state to make a startup failure actionable."""
    try:
        report = store.runner_generation_recovery_diagnostic(runner_id)
    except Exception:
        # Preserve the original startup error if the diagnostic query also fails.
        return "read-only recovery diagnostic unavailable; recovery_action=not_performed"
    return (
        "read-only recovery diagnostic: "
        f"coordinator_generation={report['coordinator_generation']}, "
        f"coordinator_last_runner_seq={report['coordinator_last_runner_seq']}, "
        f"active_generation_receipts={report['active_generation_receipt_count']}, "
        f"receipt_history_consistent={str(report['receipt_history_consistent']).lower()}, "
        f"server_wide_uncertain_tasks={report['server_wide_uncertain_task_count']}, "
        "recovery_action=not_performed; "
        "next_step=preserve coordinator and journal copies, then verify the old runner "
        "and its native children are stopped before manual generation fencing"
    )


class TaskCreate(BaseModel):
    prompt: str = Field(min_length=1, max_length=100_000)
    cwd: str | None = Field(default=None, max_length=1000)
    model: str | None = Field(default=None, max_length=100)
    provider: str | None = Field(default=None, max_length=100)
    # A maximum-length idempotency key yields a 'prime-' + 200-char session.
    session_id: str | None = Field(default=None, max_length=206)
    project_id: str | None = Field(default=None, max_length=200)
    profile: str | None = Field(default=None, max_length=64)
    approval_mode: str = Field(default="approve", pattern="^(auto|approve|plan)$")
    chat_only: bool = False
    skills: list[Annotated[str, Field(max_length=100)]] = Field(default_factory=list, max_length=50)


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    path: str | None = Field(default=None, max_length=1000)
    description: str = Field(default="", max_length=2000)


class WorkspaceProvisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1, max_length=200)
    revision: str = Field(pattern=r"^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$")


class WorkspaceFileWriteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=1, max_length=MAX_RELATIVE_PATH_LENGTH)
    expected_content: str = Field(max_length=MAX_WORKSPACE_WRITE_CHARACTERS)
    content: str = Field(max_length=MAX_WORKSPACE_WRITE_CHARACTERS)


class SessionProjectUpdate(BaseModel):
    project_id: str | None = Field(default=None, max_length=200)


class SessionDeleteBatch(BaseModel):
    session_ids: list[str] = Field(min_length=1, max_length=500)


class CollaborationMessage(BaseModel):
    sender: str
    body: str = Field(min_length=1, max_length=100_000)
    recipient: str | None = None
    kind: str = "message"


class EchoRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message: str

    @field_validator("message")
    @classmethod
    def normalize_message(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("message must not be empty")
        if len(normalized) > 200:
            raise ValueError("message must be 200 characters or fewer")
        return normalized


class LocalCodexWorkspaceRegister(BaseModel):
    model_config = ConfigDict(extra="forbid")

    root_path: str = Field(alias="rootPath", min_length=1, max_length=16_000)

    @field_validator("root_path")
    @classmethod
    def validate_root_path(cls, value: str) -> str:
        if not value.startswith("/") or "\x00" in value or any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("rootPath must be an absolute path without control characters")
        return value


class LocalCodexTurnStart(BaseModel):
    model_config = ConfigDict(extra="forbid")

    projectId: str = Field(min_length=15, max_length=256, pattern=r"^codex-project:[A-Za-z0-9._:-]+$")
    prompt: str = Field(min_length=1, max_length=8_000)
    sessionId: str | None = Field(default=None, min_length=7, max_length=256, pattern=r"^codex:[A-Za-z0-9._:-]+$")

    @field_validator("prompt")
    @classmethod
    def validate_prompt(cls, value: str) -> str:
        if not value.strip() or "\x00" in value:
            raise ValueError("prompt must not be empty")
        return value


class LocalCodexApprovalAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid")

    allow: bool


class CollaborationStatus(BaseModel):
    status: str
    task: str = ""


class CollaborationContext(BaseModel):
    value: Any


class CollaborationLock(BaseModel):
    owner: str
    reason: str = ""


class KanbanCreate(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    body: str = Field(default="", max_length=100_000)
    assignee: str | None = Field(default=None, max_length=64)
    priority: int = Field(default=0, ge=0, le=100)


class KanbanAssign(BaseModel):
    assignee: str = Field(min_length=1, max_length=64)


class KanbanComment(BaseModel):
    body: str = Field(min_length=1, max_length=20_000)


class ModelUpdate(BaseModel):
    provider: str
    model: str


class SkillToggle(BaseModel):
    name: str
    enabled: bool


class TextWrite(BaseModel):
    path: str = Field(max_length=1000)
    content: str = Field(max_length=10_000_000)


class FileDelete(BaseModel):
    path: str
    confirm: bool = False


class SessionsDelete(BaseModel):
    session_ids: list[str] = Field(min_length=1, max_length=120)


class FileMove(BaseModel):
    """Rename or copy. `path` is the source, `destination` the new path."""

    path: str = Field(max_length=1000)
    destination: str = Field(max_length=1000)


class DirCreate(BaseModel):
    path: str = Field(max_length=1000)


class BackupCreate(BaseModel):
    confirm: bool = False


class BackupInspect(BaseModel):
    source: str = Field(max_length=1000)


class BackupRestore(BaseModel):
    source: str = Field(max_length=1000)
    paths: list[str] = Field(default_factory=list)
    all_files: bool = False
    confirm: bool = False


class ScheduleUpdate(BaseModel):
    calendar: str
    confirm: bool = False


class CronAction(BaseModel):
    action: str
    confirm: bool = False


class CronCreate(BaseModel):
    schedule: str = Field(max_length=120)
    prompt: str = Field(min_length=1, max_length=100_000)
    name: str = Field(default="", max_length=300)
    deliver: str = Field(default="local", max_length=64)
    confirm: bool = False


class CronEdit(BaseModel):
    fields: dict[str, Any]
    confirm: bool = False


class TerminalCreate(BaseModel):
    label: str = "Shell"
    cwd: str = "."


class TerminalDelete(BaseModel):
    confirm: bool = False


class AudioTranscriptionRequest(BaseModel):
    data_url: str = Field(min_length=1, max_length=36_000_000)
    mime_type: str | None = Field(default=None, max_length=100)


class AudioSpeakRequest(BaseModel):
    text: str = Field(min_length=1, max_length=15_000)


def _event_cursor(after: int, last_event_id: str | None) -> int:
    """Resolve the replay cursor from query and standard SSE headers."""
    try:
        header_cursor = int(last_event_id or "0")
    except ValueError:
        header_cursor = 0
    return max(0, after, header_cursor)


def _sse_event_batch(store: TaskStore, cursor: int, limit: int = 512) -> tuple[int, list[str]]:
    """Encode one ordered event burst without adding a delay between tokens."""
    frames: list[str] = []
    for event in store.all_events(cursor, limit=limit):
        cursor = event["seq"]
        frames.append(
            f"id: {cursor}\nevent: {event['type']}\ndata: {json.dumps(event)}\n\n"
        )
    return cursor, frames


def create_app(settings: Settings | None = None, runner=None) -> FastAPI:
    settings = settings or Settings()
    validate_server_security(settings)
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    command_runner = CommandRunner()
    agents = AgentService(settings.hermes_home, settings.profile)
    kanban = KanbanService(settings.kanban_db, settings.hermes_executable, agents)
    store = TaskStore(Database(settings.database_path))
    _prepare_private_runner_journal_dir(settings.runner_journal_path.parent)
    runner_ownership = RunnerOwnershipLock(settings.runner_journal_path.parent / "server.lock")
    pairing_broker = LocalPairingBroker() if settings.local_owner_mode else None
    pairing_server = (
        UnixSocketPairingServer(
            settings.local_pairing_socket_path, pairing_broker,
            server_url=settings.local_server_url,
        )
        if pairing_broker is not None else None
    )
    local_codex_worker = (
        LocalCodexWorkerClient(
            node_executable=settings.local_codex_node_executable,
            worker_script=settings.local_codex_worker_script,
            metadata_root=settings.local_codex_metadata_root,
            home_directory=settings.local_codex_home_directory,
            codex_home_directory=settings.local_codex_home,
            codex_executable=settings.local_codex_executable,
            request_timeout_seconds=settings.local_codex_request_timeout_seconds,
            start_timeout_seconds=settings.local_codex_start_timeout_seconds,
        )
        if settings.local_codex_enabled and settings.local_codex_metadata_root is not None
        else None
    )
    coordinator_runner_state = store.runner_generation_state(LOCAL_TASK_RUNNER_ID)
    try:
        settings.runner_journal_path.lstat()
    except FileNotFoundError:
        if coordinator_runner_state is not None:
            raise RunnerJournalError(
                "local runner journal is missing while coordinator delivery state exists; "
                "no generation was advanced and no task was interrupted; "
                + _runner_recovery_diagnostic(store, LOCAL_TASK_RUNNER_ID)
            )
    try:
        journal = RunnerJournal(
            settings.runner_journal_path,
            LOCAL_TASK_RUNNER_ID,
            1,
        )
        _validate_runner_journal_state(store, journal)
    except RunnerJournalError as exc:
        raise RunnerJournalError(
            f"{exc}; {_runner_recovery_diagnostic(store, LOCAL_TASK_RUNNER_ID)}"
        ) from exc
    selected_runner = {
        "prime": PrimeRunner(
            settings.prime_executable,
            settings.data_dir / "prime-sessions",
            settings.archon_root,
            settings.prime_agent_session_dir,
        ),
        "pi": PiRunner(
            settings.pi_executable,
            settings.data_dir / "prime-sessions",
            settings.archon_root,
        ),
    }
    if runner is not None:
        selected_runner = ({('prime' if key == 'default' else key): value for key, value in runner.items()}
                           if isinstance(runner, Mapping) else {"prime": runner})
    registry = RuntimeRegistry(selected_runner, default_profile=settings.profile,
                               aliases=settings.runtime_profile_aliases)
    files = FileService(settings.archon_root)
    models = ModelService(
        settings.config_path, settings.profile_home / "provider_models_cache.json", settings.prime_auth_path
    )
    projects = ProjectService(settings.profile_home / "projects.db")
    workspace_checkout_provisioner: WorkspaceCheckoutProvisioner | None = None
    workspace_file_service = WorkspaceFileService()

    def workspace_owner_id() -> str:
        return f"local-uid:{os.geteuid()}"

    def workspace_identity(workspace: Mapping[str, Any]) -> dict[str, Any]:
        return {
            "workspace_id": workspace["workspace_id"],
            "root": workspace["root"],
            "project_id": workspace["project_id"],
            "base_revision": workspace["base_revision"],
            "head_revision": workspace["head_revision"],
            "generation": workspace["generation"],
        }

    def workspace_checkout_service() -> WorkspaceCheckoutProvisioner:
        nonlocal workspace_checkout_provisioner
        if workspace_checkout_provisioner is None:
            # The checkout location and owner are server-derived. This records a
            # Git checkout profile only; it does not establish process or OS isolation.
            workspace_checkout_provisioner = WorkspaceCheckoutProvisioner(
                database=store.db,
                projects=projects,
                workspace_root=settings.data_dir.expanduser() / "workspaces",
                owner_id=workspace_owner_id(),
                isolation_profile="git-checkout",
                prepare_workspace_root=False,
            )
        return workspace_checkout_provisioner

    sessions = SessionService(settings.profile_home / "state.db", projects, store.db)
    prime_sessions = PrimeSessionService(
        store.db,
        settings.data_dir / "prime-sessions",
        settings.prime_agent_session_dir,
        projects,
        settings.prime_agent_artifact_dir,
        settings.prime_executable,
        pi_session_root=settings.pi_agent_session_dir,
    )
    ownership = SessionOwnershipService(store, prime_sessions)

    def session_workspace(session_id: str, catalog):
        owner = ownership.reconcile(session_id)
        if owner["tombstoned"]:
            raise ValueError("Session has been deleted")
        if not owner["task_count"] and not prime_sessions.contains(session_id):
            raise HTTPException(status_code=404, detail="Session not found")
        if owner["state"] != "verified":
            reason = owner["reason"] or "Session ownership requires review before it can be used"
            raise ValueError(f"Session ownership requires review: {reason}")
        if owner["runtime_id"] not in {"prime", "pi"} or not owner["cwd"]:
            raise ValueError("Session runtime and working directory require review before use")
        if owner["project_binding_present"]:
            project_id = owner["project_id"]
        elif owner["task_count"]:
            # Existing task history without a binding is conservatively
            # projectless; a later catalog addition cannot adopt it by path.
            project_id = None
        else:
            project_id = projects.project_for_path(owner["cwd"], catalog)
        return owner, SessionWorkspace(cwd=owner["cwd"], project_id=project_id)

    def preflight(task):
        # Recheck durable inputs immediately before invoking an adapter, including
        # tasks submitted by transports which do not use the HTTP admission route.
        catalog = projects.list()
        owner, session = session_workspace(task['session_id'], catalog)
        if task.get('runtime_id') not in {'prime', 'pi'} or task['runtime_id'] != owner['runtime_id']:
            raise ValueError("Task runtime disagrees with its verified session owner")
        if task.get('cwd') != owner['cwd']:
            raise ValueError("Task working directory disagrees with its verified session owner")
        if task.get('project_id') != session.project_id:
            raise ValueError("Task project identity changed since it was queued")
        if task.get('project_id') is not None and not projects.contains(task['project_id']):
            raise ValueError("Task project is no longer active")
        admitted = admit_workspace(scratch_root=settings.task_scratch_root or settings.archon_root,
                                   projects=catalog, cwd=task.get('cwd'), session=session)
        task['cwd'] = revalidate_workspace(task.get('cwd'), admitted.authorized_roots)

    engine = TaskEngine(store, selected_runner, settings.worker_poll_seconds, settings.quota_retry_seconds,
                        registry=registry, preflight=preflight, journal=journal)
    for adapter in selected_runner.values():
        if isinstance(adapter, (PrimeRunner, PiRunner)):
            adapter.preflight = preflight
    skills = PrimeSkillService(settings.prime_bundled_skills_dir, settings.prime_user_skills_dir)
    resource_home = settings.resource_home.expanduser()
    resources = AgentResourceService({
        runtime: {'agent_dir': str(agent_dir.expanduser()), 'runtime_dir': str(runtime_dir.expanduser()),
                  'user_skills_dir': str((settings.prime_user_skills_dir if runtime == 'prime' else agent_dir / 'skills').expanduser()),
                  'builtin_skills_dir': str(settings.prime_bundled_skills_dir.expanduser()),
                  'home': str(resource_home), 'shared_dir': str(resource_home / '.agents' / 'skills'),
                  'package_roots': [str(p.expanduser()) for p in settings.resource_package_roots],
                  'mcp_config_paths': [str(p.expanduser()) for p in [settings.pi_resources_dir / 'mcp.json', settings.pi_resources_dir / 'mcp-servers.json', *settings.pi_mcp_config_paths]]}
        for runtime, agent_dir, runtime_dir in [
            ('prime', settings.prime_resources_dir, settings.prime_runtime_dir),
            ('pi', settings.pi_resources_dir, settings.pi_runtime_dir),
        ]
    }, node=settings.resource_node_executable)
    backups = BackupService(settings.backup_dir, settings.backup_script, settings.restore_script, command_runner)
    backup_schedule = BackupScheduleService(command_runner)
    cron = CronService(settings.hermes_executable, settings.profile, settings.profile_home / "cron" / "jobs.json", command_runner)
    status_service = StatusService(settings.archon_root)
    migration = MigrationService(settings.archon_root, settings.hermes_home, settings.profile)
    terminals = TmuxService(settings.archon_root, command_runner)
    logs = LogService(settings.profile_home / "logs")
    voice = VoiceService(settings.hermes_home / "hermes-agent", settings.profile_home, command_runner)
    worker_ids = [f"worker-{index + 1}" for index in range(settings.worker_count)]
    worker_tracker = WorkerTracker(
        heartbeat_timeout_seconds=max(5.0, settings.worker_poll_seconds * 4),
    )
    worker_tracker.configure(worker_ids)
    worker_tasks: dict[str, asyncio.Task] = {}
    telegram_bridge: TelegramBridge | None = None
    telegram_task: asyncio.Task | None = None

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        nonlocal worker_tasks, telegram_bridge, telegram_task
        runner_ownership.acquire()
        try:
            app.state.settings = settings
            app.state.store = store
            app.state.engine = engine
            app.state.runtimes = registry
            app.state.worker_tracker = worker_tracker
            app.state.local_codex_worker = local_codex_worker
            app.state.services = {"files": files, "models": models, "projects": projects, "sessions": prime_sessions, "ownership": ownership, "skills": skills, "resources": resources, "backups": backups, "cron": cron, "terminals": terminals, "logs": logs, "voice": voice, "agents": agents, "kanban": kanban}
            # Consume durable runner events before any worker can recover an
            # inflight task or claim queued work.
            engine.replay_unacked()
            if local_codex_worker is not None:
                await local_codex_worker.start()
                # Force the worker to finish opening and validating the
                # explicitly selected metadata root before owner pairing is
                # made available to desktop clients.
                worker_projects = await local_codex_worker.request("listProjects", {})
                if not isinstance(worker_projects, list):
                    raise RuntimeError("Local Codex worker startup validation failed")
            if pairing_server is not None:
                await pairing_server.start()
            if settings.start_worker:
                # Each worker shares the engine's one-time recovery guard and
                # claims its own row atomically.
                # compare-and-swap (UPDATE ... WHERE id=? AND status='queued', then a
                # rowcount check), so two workers can never take the same task.
                worker_tasks = {}
                for worker_id in worker_ids:
                    worker = asyncio.create_task(
                        engine.run_forever(worker_id=worker_id, tracker=worker_tracker),
                        name=f"archon-task-{worker_id}",
                    )
                    worker_tasks[worker_id] = worker

                    def record_worker_exit(task: asyncio.Task, *, stable_id: str = worker_id) -> None:
                        if task.cancelled():
                            worker_tracker.stopped(stable_id)
                            return
                        try:
                            error = task.exception()
                        except asyncio.CancelledError:
                            error = None
                        if error is None:
                            worker_tracker.stopped(stable_id)
                        else:
                            worker_tracker.stopped(stable_id, error_code="worker_loop_failed")
                            # Keep failure details out of API responses and logs.
                            logger.error("Task worker %s stopped unexpectedly (worker_loop_failed)", stable_id)

                    worker.add_done_callback(record_worker_exit)
            if settings.telegram_enabled:
                telegram_bridge = TelegramBridge(
                    store.db, store, TelegramBotClient(settings.telegram_bot_token),
                    settings.telegram_allowed_user_id,
                    default_cwd=str((settings.task_scratch_root or settings.archon_root).expanduser().resolve()),
                )
                telegram_task = asyncio.create_task(telegram_bridge.run_forever(), name="archon-telegram-bridge")
            yield
        finally:
            try:
                if pairing_server is not None:
                    try:
                        await pairing_server.close()
                    except Exception:
                        logger.exception("Local pairing server cleanup failed")
                        if pairing_broker is not None:
                            pairing_broker.clear()
                # Close Telegram intake first. If it already submitted a turn, keep the
                # engine alive until that turn completes; otherwise a queued Telegram
                # task could be stranded while the bridge waits for it forever.
                if telegram_bridge is not None:
                    telegram_bridge.stop()
                if telegram_task is not None:
                    try:
                        await telegram_task
                    except asyncio.CancelledError:
                        pass
                    except Exception:
                        # Cleanup must continue even if the optional Telegram transport
                        # failed before shutdown began.
                        logger.exception("Telegram bridge stopped unexpectedly")
                if local_codex_worker is not None:
                    try:
                        await local_codex_worker.close()
                    except Exception:
                        # Shutdown should still release the backend's owner lock.
                        logger.error("Local Codex worker cleanup failed")
                # Stop claiming new work, but let every active Prime turn finish before
                # Uvicorn exits. Cancelling workers here used to kill the child process
                # mid-session and leave Prime's session lock behind after a restart.
                engine.stop()
                for worker_id, worker in worker_tasks.items():
                    try:
                        await worker
                    except asyncio.CancelledError:
                        pass
                    except Exception:
                        worker_tracker.stopped(worker_id, error_code="worker_loop_failed")
                        # A dead worker must not prevent cleanup of its siblings.
                        logger.error("Task worker %s failed during shutdown (worker_loop_failed)", worker_id)
            finally:
                runner_ownership.release()

    app = FastAPI(title="Archon Desktop Server", version="0.2.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^(null|file://|https?://(127\.0\.0\.1|localhost)(:\d+)?)$",
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "Idempotency-Key"],
    )

    def supplied_bearer(authorization: str | None) -> str | None:
        if isinstance(authorization, str):
            scheme, separator, value = authorization.partition(" ")
            if separator and scheme.lower() == "bearer":
                return value
        return None

    def authorized_token(supplied: str | None) -> bool:
        return token_authorized(settings, supplied) or (
            pairing_broker is not None and pairing_broker.authenticate(supplied) is not None
        )

    def authorize(authorization: Annotated[str | None, Header()] = None) -> None:
        if not authorized_token(supplied_bearer(authorization)):
            raise HTTPException(status_code=401, detail="Unauthorized")

    def require_local_owner(authorization: Annotated[str | None, Header()] = None) -> dict[str, object]:
        principal = pairing_broker.authenticate(supplied_bearer(authorization)) if pairing_broker else None
        if principal is None:
            raise HTTPException(status_code=401, detail="Unauthorized")
        return principal

    protected = [Depends(authorize)]

    @app.exception_handler(PermissionError)
    async def permission_error(_request, exc: PermissionError):
        return JSONResponse(status_code=403, content={"detail": str(exc)})

    @app.exception_handler(ValueError)
    async def value_error(_request, exc: ValueError):
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    @app.exception_handler(FileNotFoundError)
    async def missing_file(_request, exc: FileNotFoundError):
        return JSONResponse(status_code=404, content={"detail": str(exc)})

    # A name collision is the caller's to resolve, not a server fault. Without
    # this it inherits OSError and surfaces as a 500.
    @app.exception_handler(FileExistsError)
    async def existing_file(_request, exc: FileExistsError):
        return JSONResponse(status_code=409, content={"detail": f"{exc} already exists"})

    @app.exception_handler(KeyError)
    async def missing_key(_request, exc: KeyError):
        return JSONResponse(status_code=404, content={"detail": str(exc)})

    @app.exception_handler(RuntimeError)
    async def runtime_error(_request, exc: RuntimeError):
        return JSONResponse(status_code=503, content={"detail": str(exc)})

    @app.get("/api/health")
    def health():
        return {"ok": True, "service": "archon-desktop-server", "version": app.version}

    @app.get("/api/local/owner")
    def local_owner(principal=Depends(require_local_owner)):
        return principal

    async def local_codex_call(method: str, params: dict[str, Any]):
        if local_codex_worker is None:
            raise HTTPException(status_code=503, detail="Local Codex is disabled")
        try:
            return await local_codex_worker.request(method, params)
        except LocalCodexOutcomeUnknown as exc:
            return JSONResponse(
                status_code=504,
                content={"detail": exc.public_message, "code": exc.code},
            )
        except LocalCodexRequestRejected as exc:
            return JSONResponse(
                status_code=409,
                content={"detail": exc.public_message, "code": exc.worker_code},
            )
        except LocalCodexWorkerError as exc:
            return JSONResponse(
                status_code=503,
                content={"detail": exc.public_message, "code": exc.code},
            )

    @app.get("/api/local/codex/projects", dependencies=[Depends(require_local_owner)])
    async def local_codex_projects():
        projects = await local_codex_call("listProjects", {})
        if isinstance(projects, JSONResponse):
            return projects
        return {"projects": projects}

    @app.get("/api/local/codex/projects/{project_id}/sessions", dependencies=[Depends(require_local_owner)])
    async def local_codex_sessions(project_id: str):
        if not LOCAL_CODEX_PROJECT_ID.fullmatch(project_id):
            raise HTTPException(status_code=400, detail="Invalid local Codex project identity")
        sessions_result = await local_codex_call("listSessions", {"projectId": project_id})
        if isinstance(sessions_result, JSONResponse):
            return sessions_result
        return {"sessions": sessions_result}

    @app.post("/api/local/codex/workspaces/register", dependencies=[Depends(require_local_owner)])
    async def local_codex_register_workspace(payload: LocalCodexWorkspaceRegister):
        return await local_codex_call("registerWorkspaceRoot", {"rootPath": payload.root_path})

    @app.post("/api/local/codex/turns", dependencies=[Depends(require_local_owner)])
    async def local_codex_start_turn(payload: LocalCodexTurnStart):
        params: dict[str, Any] = {"projectId": payload.projectId, "prompt": payload.prompt}
        if payload.sessionId is not None:
            params["sessionId"] = payload.sessionId
        return await local_codex_call("startTurn", params)

    @app.post("/api/local/codex/turns/{task_id}/cancel", dependencies=[Depends(require_local_owner)])
    async def local_codex_cancel_turn(task_id: str):
        if not LOCAL_CODEX_TASK_ID.fullmatch(task_id):
            raise HTTPException(status_code=400, detail="Invalid local Codex task identity")
        cancelled = await local_codex_call("cancelTurn", {"taskId": task_id})
        if isinstance(cancelled, JSONResponse):
            return cancelled
        return {"cancelled": cancelled}

    @app.post("/api/local/codex/approvals/{approval_id}", dependencies=[Depends(require_local_owner)])
    async def local_codex_answer_approval(approval_id: str, payload: LocalCodexApprovalAnswer):
        if not LOCAL_CODEX_APPROVAL_ID.fullmatch(approval_id):
            raise HTTPException(status_code=400, detail="Invalid local Codex approval identity")
        answered = await local_codex_call("answerApproval", {
            "approvalId": approval_id,
            "allow": payload.allow,
        })
        if isinstance(answered, JSONResponse):
            return answered
        return {"answered": answered}

    @app.get("/api/local/codex/events", dependencies=[Depends(require_local_owner)])
    async def local_codex_events(
        after: int = Query(0, ge=0, le=9_007_199_254_740_991),
        limit: int = Query(32, ge=1, le=64),
    ):
        return await local_codex_call("events", {"after": after, "limit": limit})

    @app.get("/api/readiness", dependencies=protected)
    def readiness():
        response = build_readiness_snapshot(
            store,
            registry,
            worker_tracker,
            worker_tasks,
            configured_workers=settings.worker_count,
            workers_enabled=settings.start_worker,
            remote_access_mode=settings.remote_access_mode,
        )
        return JSONResponse(
            response,
            status_code=200 if response["dispatch_ready"] else 503,
        )

    @app.post("/api/echo", dependencies=protected)
    def echo(payload: EchoRequest):
        return {"message": payload.message}

    @app.get("/api/server", dependencies=protected)
    def server_info():
        return {"profile": "prime", "archon_root": str(settings.archon_root), "prime_home": str(settings.data_dir / "prime-sessions")}

    @app.get("/api/agents", dependencies=protected)
    def list_agents():
        roster = agents.list()
        if not any((item.get("name") == "pi" or item.get("id") == "pi") for item in roster):
            roster.append({
                "name": "pi",
                "description": "Pi coding agent running on the Archon MiniPC. Select it from Archon Desktop Settings → Models.",
                "model": "",
                "provider": "pi",
                "reasoning_effort": "",
                "toolsets": ["file", "terminal", "code_execution", "skills"],
                "mcps": [],
                "orchestrator": False,
            })
        return {"agents": roster}

    @app.get("/api/runtimes", dependencies=protected)
    def list_runtimes():
        return {"runtimes": registry.describe()}

    @app.get("/api/kanban/tasks", dependencies=protected)
    def kanban_list(limit: int = Query(300, ge=1, le=1000), archived: bool = False):
        return {"cards": kanban.list(limit, archived), "stats": kanban.stats()}

    @app.post("/api/kanban/tasks", status_code=201, dependencies=protected)
    def kanban_create(payload: KanbanCreate):
        return kanban.create(payload.title, payload.body, payload.assignee, payload.priority)

    @app.get("/api/kanban/tasks/{task_id}", dependencies=protected)
    def kanban_show(task_id: str):
        return kanban.show(task_id)

    @app.get("/api/kanban/tasks/{task_id}/log", dependencies=protected)
    def kanban_log(task_id: str):
        return kanban.log(task_id)

    @app.post("/api/kanban/tasks/{task_id}/assign", dependencies=protected)
    def kanban_assign(task_id: str, payload: KanbanAssign):
        return kanban.assign(task_id, payload.assignee)

    @app.post("/api/kanban/tasks/{task_id}/comment", dependencies=protected)
    def kanban_comment(task_id: str, payload: KanbanComment):
        return kanban.comment(task_id, payload.body)

    @app.post("/api/kanban/tasks/{task_id}/{verb}", dependencies=protected)
    def kanban_action(task_id: str, verb: str):
        return kanban.action(task_id, verb)

    @app.get("/api/tasks", dependencies=protected)
    def list_tasks(limit: int = Query(100, ge=1, le=500)):
        return {"tasks": store.list(limit)}

    @app.post("/api/tasks", status_code=202, dependencies=protected)
    def create_task(payload: TaskCreate, idempotency_key: Annotated[str | None, Header()] = None):
        request_hash = None
        if idempotency_key is not None:
            request_hash = hash_request_payload(payload.model_dump())
            try:
                existing = store.lookup_request(idempotency_key, request_hash)
            except ValueError as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
            if existing is not None:
                return {"task": existing}
        if payload.session_id and payload.session_id.startswith("pi-native-"):
            raise HTTPException(status_code=409, detail="Native Pi history is read-only here. Start a new Pi conversation to work.")
        if payload.project_id and (not projects.contains(payload.project_id)):
            raise HTTPException(status_code=404, detail="Project was not found")
        try:
            catalog = projects.list()
            session = None
            if payload.session_id:
                owner, session = session_workspace(payload.session_id, catalog)
                # Existing conversations retain their original runtime when the
                # user changes the new-conversation picker.
                task_runtime = owner['runtime_id']
            else:
                task_runtime = registry.resolve(payload.profile)
            admitted = admit_workspace(
                scratch_root=settings.task_scratch_root or settings.archon_root,
                projects=catalog, cwd=payload.cwd, project_id=payload.project_id, session=session,
            )
            registry.validate({"runtime_id": task_runtime, "approval_mode": payload.approval_mode,
                               "chat_only": payload.chat_only})
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        try:
            task = store.submit(
                payload.prompt, admitted.cwd, payload.model, payload.provider, payload.skills,
                payload.session_id, payload.approval_mode, payload.chat_only,
                task_runtime, project_id=admitted.project_id, runtime_id=task_runtime,
                request_id=idempotency_key, request_hash=request_hash,
            )
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"task": task}

    @app.get("/api/tasks/{task_id}", dependencies=protected)
    def get_task(task_id: str):
        return {"task": store.get(task_id)}

    @app.get("/api/tasks/{task_id}/events", dependencies=protected)
    def task_events(task_id: str, after: int = Query(0, ge=0)):
        store.get(task_id)
        return {"events": store.events(task_id, after)}

    @app.get("/api/tasks/{task_id}/stream", dependencies=protected)
    async def task_stream(task_id: str, after: int = Query(0, ge=0)):
        async def generate():
            cursor = after
            while True:
                events = store.events(task_id, cursor)
                for event in events:
                    cursor = event["seq"]
                    yield f"id: {cursor}\nevent: {event['type']}\ndata: {json.dumps(event)}\n\n"
                task = store.get(task_id)
                if task["status"] in {"completed", "failed", "cancelled", "blocked"} and not events:
                    return
                await asyncio.sleep(0.4)
        return StreamingResponse(generate(), media_type="text/event-stream")

    @app.get("/api/events/cursor", dependencies=protected)
    def event_cursor():
        # Cold-start state is hydrated through the authoritative list routes.
        # This cursor lets Desktop subscribe only to events created afterwards
        # instead of replaying the entire durable ledger on every launch.
        return {"cursor": store.latest_event_seq()}

    @app.get("/api/events", dependencies=protected)
    async def event_stream(
        after: int = Query(0, ge=0),
        last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
    ):
        async def generate():
            cursor = _event_cursor(after, last_event_id)
            loop = asyncio.get_running_loop()
            next_keepalive = loop.time() + 15
            while True:
                cursor, frames = _sse_event_batch(store, cursor)
                if frames:
                    # Prime can emit dozens of token events in one model burst.
                    # Flush the whole available burst instead of pacing it at the
                    # database polling interval.
                    yield "".join(frames)
                    continue
                if loop.time() >= next_keepalive:
                    yield ": keepalive\n\n"
                    next_keepalive = loop.time() + 15
                await asyncio.sleep(0.1)
        return StreamingResponse(
            generate(), media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.post("/api/tasks/{task_id}/cancel", dependencies=protected)
    async def cancel_task(task_id: str):
        store.get(task_id)
        await engine.cancel(task_id)
        return {"ok": True}

    @app.get("/api/status", dependencies=protected)
    def status():
        return status_service.snapshot()

    @app.get("/api/logs", dependencies=protected)
    def get_logs(limit: int = Query(500, ge=1, le=5000), sources: str = "", level: str = ""):
        # Prime activity is represented by the durable task-event ledger, not Hermes logs.
        selected = {item.strip().lower() for item in sources.split(",") if item.strip()}
        levels = {"DEBUG": 0, "INFO": 1, "WARNING": 2, "ERROR": 3, "CRITICAL": 4}
        floor = levels.get(level.upper(), 0) if level else 0
        if selected and "prime" not in selected:
            return {"logs": []}
        events = store.event_summaries(0, limit)
        rows = []
        for event in reversed(events):
            event_level = "ERROR" if "failed" in event["type"] else "INFO"
            if levels[event_level] < floor:
                continue
            rows.append({"id": str(event["seq"]), "timestamp": event["created_at"],
              "level": event_level, "source": "prime", "component": "task", "message": event["type"]})
        return {"logs": rows}

    @app.get("/api/audio/status", dependencies=protected)
    def audio_status():
        return voice.status()

    @app.post("/api/audio/transcribe", dependencies=protected)
    async def transcribe_audio(payload: AudioTranscriptionRequest):
        return await voice.transcribe(payload.data_url, payload.mime_type)

    @app.post("/api/audio/speak", dependencies=protected)
    async def speak_audio(payload: AudioSpeakRequest):
        return await voice.speak(payload.text)

    @app.get("/api/projects", dependencies=protected)
    def get_projects():
        return {"projects": projects.list()}

    @app.get("/api/projects/{project_id}/head", dependencies=protected)
    def get_project_head(project_id: str):
        if not projects.contains(project_id):
            raise HTTPException(status_code=404, detail="Project not found")
        try:
            revision = workspace_checkout_service().head_revision(project_id=project_id)
        except (ValueError, RuntimeError) as exc:
            raise HTTPException(
                status_code=409,
                detail="Registered project source cannot be safely inspected",
            ) from exc
        return {"revision": revision}

    @app.post("/api/projects", dependencies=protected)
    def create_project(payload: ProjectCreate):
        root = settings.archon_root.expanduser().resolve()
        if payload.path:
            requested = Path(payload.path).expanduser()
            target = (root / requested).resolve() if not requested.is_absolute() else requested.resolve()
        else:
            slug = re.sub(r"[^a-z0-9]+", "-", payload.name.lower()).strip("-") or "project"
            target = (root / slug).resolve()
        # The default stays in the configured projects root, while an explicit
        # folder may point elsewhere inside the server account's home (matching
        # existing projects such as daily-projects and sandbox workspaces).
        allowed_root = root.parent
        try:
            target.relative_to(allowed_root)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"Project folder must be inside {allowed_root}") from exc
        try:
            return {"project": projects.create(payload.name, target, payload.description)}
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except OSError as exc:
            raise HTTPException(status_code=400, detail=f"Could not create project folder: {exc}") from exc

    @app.delete("/api/projects/{project_id}", dependencies=protected)
    def delete_project(project_id: str):
        if not projects.contains(project_id):
            raise HTTPException(status_code=404, detail="Project not found")
        # Preserve the session's original binding. Admission must reject a
        # removed project instead of silently reclassifying its queued work.
        if not projects.delete(project_id):
            raise HTTPException(status_code=404, detail="Project not found")
        return {"ok": True, "files_preserved": True}

    @app.get("/api/workspaces", dependencies=protected)
    def list_workspaces(limit: int = Query(100, ge=1, le=500)):
        workspaces = store.db.list_workspaces(owner_id=workspace_owner_id(), limit=limit)
        return {"workspaces": [workspace_identity(workspace) for workspace in workspaces]}

    def current_owner_workspace(workspace_id: str) -> dict[str, Any]:
        try:
            workspace = store.db.get_workspace(workspace_id)
        except (KeyError, ValueError):
            raise HTTPException(status_code=404, detail="Workspace not found") from None
        if workspace["owner_id"] != workspace_owner_id():
            raise HTTPException(status_code=404, detail="Workspace not found")
        return workspace

    @app.get("/api/workspaces/{workspace_id}", dependencies=protected)
    def get_workspace(workspace_id: str):
        workspace = current_owner_workspace(workspace_id)
        return {"workspace": workspace_identity(workspace)}

    @app.get("/api/workspaces/{workspace_id}/files", dependencies=protected)
    def list_workspace_files(
        workspace_id: str,
        path: str = Query(default="", max_length=MAX_RELATIVE_PATH_LENGTH),
        limit: int = Query(DEFAULT_LIST_LIMIT, ge=1, le=MAX_LIST_LIMIT),
    ):
        workspace = current_owner_workspace(workspace_id)
        try:
            return workspace_file_service.list_directory(workspace["root"], path, limit)
        except WorkspaceFilesError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    @app.get("/api/workspaces/{workspace_id}/files/read", dependencies=protected)
    def read_workspace_file(
        workspace_id: str,
        path: str = Query(..., min_length=1, max_length=MAX_RELATIVE_PATH_LENGTH),
        max_bytes: int = Query(DEFAULT_WORKSPACE_READ_BYTES, ge=1, le=MAX_WORKSPACE_READ_BYTES),
    ):
        workspace = current_owner_workspace(workspace_id)
        try:
            return workspace_file_service.read_text(workspace["root"], path, max_bytes)
        except WorkspaceFilesError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    @app.get("/api/workspaces/{workspace_id}/files/search", dependencies=protected)
    def search_workspace_files(
        workspace_id: str,
        q: str = Query(..., min_length=1, max_length=MAX_SEARCH_QUERY_BYTES),
    ):
        workspace = current_owner_workspace(workspace_id)
        try:
            return workspace_file_service.search_text(workspace["root"], q)
        except WorkspaceFilesError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    @app.post("/api/workspaces/{workspace_id}/files/write", dependencies=protected)
    def write_workspace_file(workspace_id: str, payload: WorkspaceFileWriteRequest):
        """Save existing text using observed-content conflict detection.

        Expected text detects changes observed before atomic replacement; it
        does not fence native or other out-of-process writers.
        """
        workspace = current_owner_workspace(workspace_id)
        root = workspace["root"]
        try:
            with workspace_file_write_lock:
                # Task cwd is canonicalized at admission, so this directory
                # boundary query refuses edits while known task work is active.
                with store.db.connect() as conn:
                    active_task = conn.execute(
                        """SELECT 1 FROM tasks
                           WHERE status IN ('queued','running','cancelling')
                             AND (cwd=? OR substr(cwd,1,length(?)+1)=? || '/')
                           LIMIT 1""",
                        (root, root, root),
                    ).fetchone()
                if active_task is not None:
                    raise HTTPException(status_code=409, detail="Workspace has an active task")
                return workspace_file_service.write_text(
                    root, payload.path, payload.expected_content, payload.content,
                )
        except WorkspaceFilesError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
        except HTTPException:
            raise
        except Exception:
            # Avoid returning filesystem/database internals or request text.
            logger.exception("Workspace file save failed")
            raise HTTPException(status_code=503, detail="Workspace file service is temporarily unavailable") from None

    @app.post("/api/workspaces", dependencies=protected)
    def provision_workspace(payload: WorkspaceProvisionRequest):
        workspace = workspace_checkout_service().provision(
            project_id=payload.project_id,
            revision=payload.revision,
            generation=1,
        )
        # Return only the persisted workspace identity and its authoritative root.
        # The endpoint creates a checkout; it does not execute code in it.
        return {"workspace": workspace_identity(workspace)}

    @app.get("/api/sessions", dependencies=protected)
    def get_sessions(limit: int = Query(120, ge=1, le=500), project_id: str | None = None):
        owners = ownership.reconcile_all()
        catalog = projects.list()
        active_project_ids = {project["id"] for project in catalog}
        rows = prime_sessions.list(limit=500)
        visible = []
        for row in rows:
            owner = owners.get(row["id"]) or ownership.reconcile(row["id"])
            row["ownership_state"] = owner["state"]
            row["ownership_reason"] = owner["reason"]
            row["runtime"] = owner["runtime_id"] if owner["state"] == "verified" else None
            row["read_only"] = bool(owner["read_only"] or row["source"] == "pi-cli")
            row["can_delete"] = True
            if owner["state"] == "verified":
                row["cwd"] = owner["cwd"]
            else:
                row["cwd"] = None
            if owner["project_binding_present"]:
                row["project_id"] = (owner["project_id"]
                                      if owner["project_id"] in active_project_ids else None)
            elif owner["state"] == "verified" and not owner["task_count"]:
                try:
                    row["project_id"] = projects.project_for_path(owner["cwd"], catalog)
                except ValueError:
                    row["project_id"] = None
                    row["project_ownership_ambiguous"] = True
            else:
                row["project_id"] = None
            if row.get("project_ownership_ambiguous"):
                row["ownership_state"] = "review_required"
                row["ownership_reason"] = (
                    "Project ownership is ambiguous because multiple registered projects "
                    "share the longest workspace root."
                )
                row["runtime"] = None
                row["cwd"] = None
            if row["runtime"] == "pi" and row["source"] != "pi-cli":
                row["source"] = "pi"
            if project_id is None or row["project_id"] == project_id:
                visible.append(row)
        return {"sessions": visible[:limit]}

    @app.put("/api/sessions/{session_id}/project", dependencies=protected)
    def assign_session_project(session_id: str, payload: SessionProjectUpdate):
        try:
            if not prime_sessions.assign_project(session_id, payload.project_id):
                raise HTTPException(status_code=404, detail="Prime session not found")
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Project not found") from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"ok": True, "session_id": session_id, "project_id": payload.project_id}

    @app.get("/api/sessions/{session_id}/messages", dependencies=protected)
    def get_session_messages(session_id: str, limit: int = Query(500, ge=1, le=2000)):
        return {"messages": prime_sessions.messages(session_id, limit=limit)}

    @app.delete("/api/sessions", dependencies=protected)
    def delete_sessions(payload: SessionDeleteBatch):
        session_ids = list(dict.fromkeys(payload.session_ids))
        missing = [session_id for session_id in session_ids if not (
            prime_sessions.contains(session_id) or sessions.contains(session_id)
        )]
        if missing:
            raise HTTPException(status_code=404, detail=f"Session not found: {missing[0]}")
        if store.running_sessions(session_ids):
            raise HTTPException(status_code=409, detail="Cancel queued or running tasks before deleting these sessions")
        for session_id in session_ids:
            if session_id.startswith("pi-native-"):
                try:
                    if not prime_sessions.delete(session_id):
                        raise HTTPException(status_code=404, detail="Session not found")
                except OSError as exc:
                    raise HTTPException(status_code=503, detail="Could not save the native Pi recovery copy; try again") from exc
        if store.prepare_session_deletion(session_ids):
            raise HTTPException(status_code=409, detail="Cancel queued or running tasks before deleting these sessions")
        for session_id in session_ids:
            if prime_sessions.contains(session_id):
                prime_sessions.delete(session_id)
            if sessions.contains(session_id):
                sessions.delete(session_id)
        return {"ok": True, "deleted": session_ids}

    @app.delete("/api/sessions/{session_id}", dependencies=protected)
    def delete_session(session_id: str):
        native_pi = session_id.startswith("pi-native-")
        is_prime = prime_sessions.contains(session_id)
        is_legacy = sessions.contains(session_id)
        if not is_prime and not is_legacy:
            raise HTTPException(status_code=404, detail="Session not found")
        if native_pi:
            if store.has_running_session(session_id):
                raise HTTPException(status_code=409, detail="Cancel queued or running tasks before deleting this session")
            try:
                if not prime_sessions.delete(session_id):
                    raise HTTPException(status_code=404, detail="Session not found")
            except OSError as exc:
                raise HTTPException(status_code=503, detail="Could not save the native Pi recovery copy; try again") from exc
        if store.prepare_session_deletion([session_id]):
            raise HTTPException(status_code=409, detail="Cancel queued or running tasks before deleting this session")
        if is_prime and not native_pi:
            prime_sessions.delete(session_id)
        if is_legacy:
            sessions.delete(session_id)
        return {"ok": True}

    @app.get("/api/models", dependencies=protected)
    def get_models():
        return models.get()

    @app.put("/api/models/default", dependencies=protected)
    def set_model(payload: ModelUpdate):
        return models.set_default(payload.provider, payload.model)

    @app.get("/api/agent-resources", dependencies=protected)
    def get_agent_resources():
        return resources.inventory()

    @app.get("/api/agent-resources/{runtime}/skills/{skill_id}", dependencies=protected)
    def inspect_agent_resource(runtime: str, skill_id: str):
        if runtime not in ('prime', 'pi'):
            raise HTTPException(status_code=400, detail="Unknown runtime")
        try:
            return resources.inspect(runtime, skill_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Skill not found in this runtime") from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Skill document cannot be previewed") from exc
        except (OSError, RuntimeError) as exc:
            raise HTTPException(status_code=503, detail="Could not read this skill") from exc

    @app.get("/api/skills", dependencies=protected)
    def get_skills():
        return {"skills": skills.list()}

    @app.put("/api/skills/toggle", dependencies=protected)
    def toggle_skill(payload: SkillToggle):
        if not payload.enabled:
            raise HTTPException(status_code=400, detail="Prime bundled skills cannot be disabled from Archon")
        return next((item for item in skills.list() if item["name"] == payload.name), None) or (_ for _ in ()).throw(KeyError(payload.name))

    @app.get("/api/skills/{name}", dependencies=protected)
    def inspect_skill(name: str):
        return skills.inspect(name)

    @app.get("/api/files", dependencies=protected)
    def list_files(path: str = Query(".", max_length=1000)):
        try:
            items = files.list_dir(path)
        except NotADirectoryError as exc:
            raise HTTPException(status_code=400, detail=f"Not a directory: {path}") from exc
        return {"root": str(settings.archon_root), "path": path, "items": items}

    @app.get("/api/files/read", dependencies=protected)
    def read_file(
        path: str = Query(..., max_length=1000),
        max_bytes: int = Query(DEFAULT_READ_BYTES, ge=1, le=MAX_READ_BYTES),
        allow_binary: bool = Query(False),
    ):
        # `allow_binary` is a read-only affordance: the reply is lossy for
        # undecodable bytes and is flagged `binary` so the caller refuses to
        # write it back. Same for `truncated` on an oversized file.
        return files.read_text(path, max_bytes, allow_binary=allow_binary)

    @app.put("/api/files/text", dependencies=protected)
    def write_text(payload: TextWrite):
        return files.write_text(payload.path, payload.content)

    @app.post("/api/files/upload", dependencies=protected)
    async def upload_file(path: str = Query(..., max_length=1000), upload: UploadFile = File(...)):
        try:
            destination = files.resolve(path)
            destination.parent.mkdir(parents=True, exist_ok=True)
        except (OSError, PermissionError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        # A per-request temporary name prevents concurrent uploads to the same
        # destination from truncating or replacing one another's partial data.
        temp = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.upload")
        total = 0
        try:
            with temp.open("wb") as handle:
                while chunk := await upload.read(1024 * 1024):
                    total += len(chunk)
                    if total > 100 * 1024 * 1024:
                        raise HTTPException(status_code=413, detail="Upload exceeds 100 MiB")
                    handle.write(chunk)
            os.replace(temp, destination)
        except HTTPException:
            temp.unlink(missing_ok=True)
            raise
        except (OSError, ValueError) as exc:
            temp.unlink(missing_ok=True)
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"path": str(destination.relative_to(settings.archon_root)), "size": total}

    @app.get("/api/files/download", dependencies=protected)
    def download_file(path: str = Query(..., max_length=1000)):
        resolved = files.resolve(path)
        return FileResponse(resolved, filename=resolved.name)

    @app.post("/api/files/rename", dependencies=protected)
    def rename_file(payload: FileMove):
        return files.rename(payload.path, payload.destination)

    @app.post("/api/files/copy", dependencies=protected)
    def copy_file(payload: FileMove):
        return files.copy(payload.path, payload.destination)

    @app.post("/api/files/mkdir", dependencies=protected)
    def make_dir(payload: DirCreate):
        return files.mkdir(payload.path)

    @app.delete("/api/files", dependencies=protected)
    def delete_file(payload: FileDelete):
        files.delete(payload.path, confirm=payload.confirm)
        return {"ok": True}

    def desktop_artifact() -> Path:
        artifact = settings.desktop_artifact
        if artifact is None or not artifact.is_file():
            raise HTTPException(status_code=404, detail="No desktop release is available")
        return artifact

    @app.get("/api/desktop/check", dependencies=protected)
    def desktop_check():
        artifact = settings.desktop_artifact
        available = artifact is not None and artifact.is_file()
        return {
            "available": available,
            "version": settings.desktop_version if available else "",
            "size": str(artifact.stat().st_size) if available else "",
            "channel": "prime",
            "notes": [],
        }

    @app.get("/api/desktop/release", dependencies=protected)
    def desktop_release():
        artifact = desktop_artifact()
        digest = hashlib.sha256()
        with artifact.open("rb") as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(block)
        return {"version": settings.desktop_version, "size": artifact.stat().st_size, "sha256": digest.hexdigest()}

    @app.get("/api/desktop/update", dependencies=protected)
    def desktop_update():
        artifact = desktop_artifact()
        return FileResponse(artifact, media_type="application/vnd.appimage", filename=artifact.name)

    @app.get("/api/backups", dependencies=protected)
    def list_backups():
        return {"backups": backups.list()}

    @app.post("/api/backups", dependencies=protected)
    async def create_backup(payload: BackupCreate):
        return await backups.create(confirm=payload.confirm)

    @app.post("/api/backups/inspect", dependencies=protected)
    async def inspect_backup(payload: BackupInspect):
        return await backups.inspect(payload.source)

    @app.post("/api/backups/restore", dependencies=protected)
    async def restore_backup(payload: BackupRestore):
        return await backups.restore(payload.source, payload.paths, confirm=payload.confirm, all_files=payload.all_files)

    @app.get("/api/backups/schedule", dependencies=protected)
    async def get_backup_schedule():
        return await backup_schedule.status()

    @app.put("/api/backups/schedule", dependencies=protected)
    async def set_backup_schedule(payload: ScheduleUpdate):
        return await backup_schedule.set_schedule(payload.calendar, confirm=payload.confirm)

    @app.get("/api/cron", dependencies=protected)
    def list_cron():
        # Surface the active Hermes profile's cron registry in Archon Desktop.
        return {"jobs": cron.list()}

    @app.post("/api/cron", dependencies=protected)
    async def create_cron(payload: CronCreate):
        return await cron.create(payload.schedule, payload.prompt, name=payload.name, deliver=payload.deliver, confirm=payload.confirm)

    @app.put("/api/cron/{job_id}", dependencies=protected)
    async def edit_cron(job_id: str, payload: CronEdit):
        return await cron.edit(job_id, payload.fields, confirm=payload.confirm)

    @app.post("/api/cron/{job_id}/action", dependencies=protected)
    async def cron_action(job_id: str, payload: CronAction):
        return await cron.action(payload.action, job_id, confirm=payload.confirm)

    @app.get("/api/migration/manifest", dependencies=protected)
    def migration_manifest():
        return migration.manifest()

    @app.get("/api/terminals", dependencies=protected)
    async def list_terminals():
        return {"terminals": await terminals.list()}

    @app.post("/api/terminals", dependencies=protected)
    async def create_terminal(payload: TerminalCreate):
        return await terminals.create(payload.label, payload.cwd)

    @app.delete("/api/terminals/{name}", dependencies=protected)
    async def kill_terminal(name: str, payload: TerminalDelete):
        await terminals.kill(name, confirm=payload.confirm)
        return {"ok": True}

    @app.websocket("/api/terminals/{name}/ws")
    async def terminal_socket(websocket: WebSocket, name: str):
        await websocket.accept()
        try:
            try:
                first = await asyncio.wait_for(
                    websocket.receive_json(), timeout=WEBSOCKET_AUTH_TIMEOUT_SECONDS,
                )
            except (TimeoutError, ValueError, json.JSONDecodeError, WebSocketDisconnect):
                try:
                    await websocket.close(code=4401)
                except Exception:
                    pass
                return
            token = first.get("token") if isinstance(first, Mapping) else None
            if not authorized_token(token):
                await websocket.close(code=4401)
                return
            await terminals.bridge(websocket, name)
        except (WebSocketDisconnect, asyncio.CancelledError):
            return
        except Exception as exc:
            try:
                await websocket.send_json({"error": str(exc)})
                await websocket.close(code=1011)
            except Exception:
                pass

    return app
