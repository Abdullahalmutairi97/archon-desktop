from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any

from fastapi import Depends, FastAPI, File, Header, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from .config import Settings
from .db import Database
from .hermes_runner import HermesRunner
from .services.backups import BackupScheduleService, BackupService
from .services.commands import CommandRunner
from .services.cron import CronService
from .services.files import FileService
from .services.logs import LogService
from .services.migration import MigrationService
from .services.models import ModelService
from .services.skills import SkillService
from .services.status import StatusService
from .services.terminal import TmuxService
from .services.voice import VoiceService
from .services.workspace import ProjectService, SessionService
from .tasks import TaskEngine, TaskStore


class TaskCreate(BaseModel):
    prompt: str = Field(min_length=1, max_length=100_000)
    cwd: str | None = None
    model: str | None = None
    provider: str | None = None
    session_id: str | None = Field(default=None, max_length=200)
    approval_mode: str = Field(default="approve", pattern="^(auto|approve|plan)$")
    chat_only: bool = False
    skills: list[str] = Field(default_factory=list)


class ModelUpdate(BaseModel):
    provider: str
    model: str


class SkillToggle(BaseModel):
    name: str
    enabled: bool


class TextWrite(BaseModel):
    path: str
    content: str


class FileDelete(BaseModel):
    path: str
    confirm: bool = False


class BackupCreate(BaseModel):
    confirm: bool = False


class BackupInspect(BaseModel):
    source: str


class BackupRestore(BaseModel):
    source: str
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
    schedule: str
    prompt: str
    name: str = ""
    deliver: str = "local"
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


def create_app(settings: Settings | None = None, runner=None) -> FastAPI:
    settings = settings or Settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    command_runner = CommandRunner()
    store = TaskStore(Database(settings.database_path))
    engine = TaskEngine(store, runner or HermesRunner(settings.hermes_executable, settings.profile, settings.archon_root), settings.worker_poll_seconds)
    files = FileService(settings.archon_root)
    models = ModelService(settings.config_path, settings.profile_home / "provider_models_cache.json")
    projects = ProjectService(settings.profile_home / "projects.db")
    sessions = SessionService(settings.profile_home / "state.db", projects)
    skills = SkillService(settings.skills_dir, settings.config_path)
    backups = BackupService(settings.backup_dir, settings.backup_script, settings.restore_script, command_runner)
    backup_schedule = BackupScheduleService(command_runner)
    cron = CronService(settings.hermes_executable, settings.profile, settings.profile_home / "cron" / "jobs.json", command_runner)
    status_service = StatusService(settings.archon_root)
    migration = MigrationService(settings.archon_root, settings.hermes_home, settings.profile)
    terminals = TmuxService(settings.archon_root, command_runner)
    logs = LogService(settings.profile_home / "logs")
    voice = VoiceService(settings.hermes_home / "hermes-agent", settings.profile_home, command_runner)
    worker_task: asyncio.Task | None = None

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        nonlocal worker_task
        app.state.settings = settings
        app.state.store = store
        app.state.engine = engine
        app.state.services = {"files": files, "models": models, "projects": projects, "sessions": sessions, "skills": skills, "backups": backups, "cron": cron, "terminals": terminals, "logs": logs, "voice": voice}
        if settings.start_worker:
            worker_task = asyncio.create_task(engine.run_forever(), name="archon-task-worker")
        yield
        engine.stop()
        if worker_task:
            worker_task.cancel()
            try:
                await worker_task
            except asyncio.CancelledError:
                pass

    app = FastAPI(title="Archon Desktop Server", version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^(null|file://|https?://(127\.0\.0\.1|localhost)(:\d+)?)$",
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

    def authorize(authorization: Annotated[str | None, Header()] = None) -> None:
        supplied = authorization[7:] if authorization and authorization.startswith("Bearer ") else ""
        if not settings.auth_token or not hmac.compare_digest(supplied, settings.auth_token):
            raise HTTPException(status_code=401, detail="Unauthorized")

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

    @app.exception_handler(KeyError)
    async def missing_key(_request, exc: KeyError):
        return JSONResponse(status_code=404, content={"detail": str(exc)})

    @app.exception_handler(RuntimeError)
    async def runtime_error(_request, exc: RuntimeError):
        return JSONResponse(status_code=503, content={"detail": str(exc)})

    @app.get("/api/health")
    def health():
        return {"ok": True, "service": "archon-desktop-server", "version": app.version}

    @app.get("/api/server", dependencies=protected)
    def server_info():
        return {"profile": settings.profile, "archon_root": str(settings.archon_root), "hermes_home": str(settings.hermes_home)}

    @app.get("/api/tasks", dependencies=protected)
    def list_tasks(limit: int = Query(100, ge=1, le=500)):
        return {"tasks": store.list(limit)}

    @app.post("/api/tasks", status_code=202, dependencies=protected)
    def create_task(payload: TaskCreate):
        if payload.session_id:
            sessions.messages(payload.session_id, limit=1)
        return {"task": store.submit(
            payload.prompt, payload.cwd, payload.model, payload.provider, payload.skills,
            payload.session_id, payload.approval_mode, payload.chat_only,
        )}

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

    @app.get("/api/events", dependencies=protected)
    async def event_stream(
        after: int = Query(0, ge=0),
        last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
    ):
        async def generate():
            cursor = _event_cursor(after, last_event_id)
            while True:
                events = store.all_events(cursor)
                for event in events:
                    cursor = event["seq"]
                    yield f"id: {cursor}\nevent: {event['type']}\ndata: {json.dumps(event)}\n\n"
                if not events:
                    yield ": keepalive\n\n"
                await asyncio.sleep(0.4)
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
        selected = [item.strip() for item in sources.split(",") if item.strip()] or None
        return {"logs": logs.list(limit=limit, sources=selected, minimum_level=level or None)}

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

    @app.get("/api/sessions", dependencies=protected)
    def get_sessions(limit: int = Query(120, ge=1, le=500), project_id: str | None = None):
        return {"sessions": sessions.list(limit=limit, project_id=project_id)}

    @app.get("/api/sessions/{session_id}/messages", dependencies=protected)
    def get_session_messages(session_id: str, limit: int = Query(500, ge=1, le=2000)):
        return {"messages": sessions.messages(session_id, limit=limit)}

    @app.get("/api/models", dependencies=protected)
    def get_models():
        return models.get()

    @app.put("/api/models/default", dependencies=protected)
    def set_model(payload: ModelUpdate):
        return models.set_default(payload.provider, payload.model)

    @app.get("/api/skills", dependencies=protected)
    def get_skills():
        return {"skills": skills.list()}

    @app.put("/api/skills/toggle", dependencies=protected)
    def toggle_skill(payload: SkillToggle):
        return skills.set_enabled(payload.name, payload.enabled)

    @app.get("/api/skills/{name}", dependencies=protected)
    def inspect_skill(name: str):
        return skills.inspect(name)

    @app.get("/api/files", dependencies=protected)
    def list_files(path: str = Query(".")):
        return {"root": str(settings.archon_root), "path": path, "items": files.list_dir(path)}

    @app.get("/api/files/read", dependencies=protected)
    def read_file(path: str):
        return files.read_text(path)

    @app.put("/api/files/text", dependencies=protected)
    def write_text(payload: TextWrite):
        return files.write_text(payload.path, payload.content)

    @app.post("/api/files/upload", dependencies=protected)
    async def upload_file(path: str, upload: UploadFile = File(...)):
        destination = files.resolve(path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temp = destination.with_name(f".{destination.name}.upload")
        total = 0
        with temp.open("wb") as handle:
            while chunk := await upload.read(1024 * 1024):
                total += len(chunk)
                if total > 100 * 1024 * 1024:
                    temp.unlink(missing_ok=True)
                    raise ValueError("Upload exceeds 100 MiB")
                handle.write(chunk)
        os.replace(temp, destination)
        return {"path": str(destination.relative_to(settings.archon_root)), "size": total}

    @app.get("/api/files/download", dependencies=protected)
    def download_file(path: str):
        resolved = files.resolve(path)
        return FileResponse(resolved, filename=resolved.name)

    @app.delete("/api/files", dependencies=protected)
    def delete_file(payload: FileDelete):
        files.delete(payload.path, confirm=payload.confirm)
        return {"ok": True}

    def desktop_artifact() -> Path:
        artifact = settings.desktop_artifact
        if artifact is None or not artifact.is_file():
            raise HTTPException(status_code=404, detail="No desktop release is available")
        return artifact

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
            first = await asyncio.wait_for(websocket.receive_json(), timeout=10)
            token = str(first.get("token", ""))
            if not settings.auth_token or not hmac.compare_digest(token, settings.auth_token):
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
