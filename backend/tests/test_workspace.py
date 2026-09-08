import json
import sqlite3
from pathlib import Path

from archon_server.db import Database
from archon_server.services.workspace import PrimeSessionService, ProjectService, SessionService


def make_state(path: Path) -> None:
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY, source TEXT, title TEXT, model TEXT, cwd TEXT,
            started_at TEXT, ended_at TEXT, message_count INTEGER, archived INTEGER DEFAULT 0
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT,
            content TEXT, timestamp TEXT, active INTEGER DEFAULT 1, compacted INTEGER DEFAULT 0
        );
        """
    )
    conn.executemany(
        "INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?)",
        [
            ("chat-1", "archon-desktop", "Desktop rebuild", "gpt-test", "/work/project", "2026-07-24T10:00:00Z", None, 2, 0),
            ("cron-1", "cron", "Daily check", "gpt-test", "/work", "2026-07-24T09:00:00Z", None, 1, 0),
            ("old-1", "cli", "Archived", "gpt-test", "/work", "2026-07-23T09:00:00Z", None, 1, 1),
        ],
    )
    conn.executemany(
        "INSERT INTO messages(session_id,role,content,timestamp,active,compacted) VALUES (?,?,?,?,?,?)",
        [
            ("chat-1", "user", "Rebuild the interface", "2026-07-24T10:00:00Z", 1, 0),
            ("chat-1", "assistant", "Done cleanly", "2026-07-24T10:01:00Z", 1, 0),
            ("chat-1", "tool", "secret tool noise", "2026-07-24T10:00:30Z", 1, 0),
            ("chat-1", "assistant", "[PRIOR CONTEXT — internal]", "2026-07-24T10:00:40Z", 1, 0),
            ("chat-1", "user", "[Your active task list was preserved across context compression]", "2026-07-24T10:00:50Z", 1, 0),
            ("chat-1", "user", "You've reached the maximum number of tool-calling iterations allowed. Please provide a final response.", "2026-07-24T10:00:55Z", 1, 0),
            ("chat-1", "user", "Make it smooth", "2026-07-24T10:01:10Z", 1, 0),
        ],
    )
    conn.commit()
    conn.close()


def make_projects(path: Path) -> None:
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT, name TEXT, description TEXT, icon TEXT, color TEXT, board_slug TEXT, primary_path TEXT, created_at TEXT, archived INTEGER DEFAULT 0);
        CREATE TABLE project_folders (project_id TEXT, path TEXT, label TEXT, is_primary INTEGER, added_at TEXT);
        """
    )
    conn.execute("INSERT INTO projects VALUES (?,?,?,?,?,?,?,?,?,?)", ("p1", "studio", "Studio", "Main product", "box", "#7158e2", None, "/work/project", "2026-07-20", 0))
    conn.execute("INSERT INTO project_folders VALUES (?,?,?,?,?)", ("p1", "/work/project", "Main", 1, "2026-07-20"))
    conn.commit()
    conn.close()


def test_database_migrates_legacy_tasks_before_session_index(tmp_path):
    path = tmp_path / "legacy.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE tasks (id TEXT PRIMARY KEY, prompt TEXT NOT NULL, cwd TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
    conn.execute("INSERT INTO tasks VALUES (?,?,?,?,?,?)", ("legacy", "keep me", "/tmp", "completed", "2026-08-27", "2026-08-27"))
    conn.commit()
    conn.close()
    Database(path)
    with sqlite3.connect(path) as conn:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(tasks)")}
        row = conn.execute("SELECT prompt FROM tasks WHERE id='legacy'").fetchone()
    assert "session_id" in columns
    assert row[0] == "keep me"


def test_task_metadata_lookup_has_session_timestamp_index(tmp_path):
    db = Database(tmp_path / "tasks.db")
    with db.connect() as conn:
        indexes = {row["name"] for row in conn.execute("PRAGMA index_list(tasks)")}
    assert "idx_tasks_session_updated" in indexes


def test_prime_session_uses_latest_task_cwd_for_project_inference(tmp_path):
    db = Database(tmp_path / "tasks.db")
    projects = ProjectService(tmp_path / "projects.db")
    older = projects.create("Older", tmp_path / "older")
    newer = projects.create("Newer", tmp_path / "newer")
    sessions = tmp_path / "agent-sessions"
    sessions.mkdir()
    session_id = "prime-latest-cwd"
    (sessions / f"{session_id}.jsonl").write_text(json.dumps({
        "type": "session", "id": session_id, "timestamp": "2026-08-27T00:00:00Z"
    }) + "\n")
    with db.transaction() as conn:
        conn.execute("INSERT INTO tasks(id,prompt,cwd,session_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
                     ("old", "old", str(tmp_path / "older"), session_id, "completed", "2026-08-27T00:00:01Z", "2026-08-27T00:00:01Z"))
        conn.execute("INSERT INTO tasks(id,prompt,cwd,session_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
                     ("new", "new", str(tmp_path / "newer"), session_id, "completed", "2026-08-27T00:00:02Z", "2026-08-27T00:00:02Z"))
    service = PrimeSessionService(db, tmp_path / "desktop", sessions, projects=projects,
                                  agent_artifact_root=tmp_path / "artifacts")
    row = service.list()[0]
    assert row["cwd"] == str(tmp_path / "newer")
    assert row["project_id"] == newer["id"]


def test_prime_session_ignores_stale_project_assignment_and_uses_cwd(tmp_path):
    db = Database(tmp_path / "tasks.db")
    project_db = tmp_path / "projects.db"
    make_projects(project_db)
    sessions = tmp_path / "agent-sessions"
    sessions.mkdir()
    session_id = "prime-stale-project"
    (sessions / f"{session_id}.jsonl").write_text("\n".join(json.dumps(item) for item in [
        {"type": "session", "id": session_id, "cwd": "/work/project", "timestamp": "2026-08-27T00:00:00Z"},
        {"type": "message", "id": "u", "parentId": session_id, "timestamp": "2026-08-27T00:00:01Z",
         "message": {"role": "user", "content": [{"type": "text", "text": "hello there"}]}},
    ]) + "\n")
    with db.transaction() as conn:
        conn.execute("INSERT INTO session_projects(session_id,project_id,updated_at) VALUES (?,?,?)",
                     (session_id, "deleted-project", "2026-08-27T00:00:00Z"))
    service = PrimeSessionService(db, tmp_path / "desktop", sessions,
                                  projects=ProjectService(project_db),
                                  agent_artifact_root=tmp_path / "artifacts")
    assert service.list()[0]["project_id"] == "p1"


def test_project_service_lists_real_project_folders(tmp_path):
    path = tmp_path / "projects.db"
    make_projects(path)
    projects = ProjectService(path).list()
    assert projects == [{
        "id": "p1", "slug": "studio", "name": "Studio", "description": "Main product",
        "icon": "box", "color": "#7158e2", "primary_path": "/work/project",
        "folders": [{"path": "/work/project", "label": "Main", "is_primary": True}],
    }]


def test_session_service_lists_chat_sessions_and_resolves_projects(tmp_path):
    state = tmp_path / "state.db"
    projects = tmp_path / "projects.db"
    make_state(state)
    make_projects(projects)
    service = SessionService(state, ProjectService(projects))
    rows = service.list()
    assert [row["id"] for row in rows] == ["chat-1"]
    assert rows[0]["project_id"] == "p1"
    assert rows[0]["preview"] == "Make it smooth"
    assert rows[0]["last_active"] == "2026-07-24T10:01:10Z"
    assert rows[0]["message_count"] == 3  # ignores tool and internal/compaction rows


def test_session_service_returns_only_user_and_assistant_messages(tmp_path):
    state = tmp_path / "state.db"
    projects = tmp_path / "projects.db"
    make_state(state)
    make_projects(projects)
    messages = SessionService(state, ProjectService(projects)).messages("chat-1")
    assert [message["role"] for message in messages] == ["user", "assistant", "user"]
    assert "secret tool noise" not in json.dumps(messages)
    assert "tool-calling iterations" not in json.dumps(messages)


def test_prime_session_title_uses_first_meaningful_content_and_stays_compact():
    title = PrimeSessionService._content_title([
        "Hi",
        "Can you fix the activity page and add accurate MiniPC and Archon-only usage readings?",
        "This later follow-up must not replace the session name",
    ])
    assert title == "Fix the activity page and add accurate MiniPC and Archon-only usage…"
    assert len(title) <= 73
    assert len(PrimeSessionService._content_title(["word " * 100])) <= 73


def test_prime_session_service_discovers_native_agent_jsonl(tmp_path):
    agent_sessions = tmp_path / "agent-sessions"
    agent_sessions.mkdir()
    session_id = "01a0198a-557f-7211-b307-571850f70815"
    records = [
        {"type": "session", "id": session_id, "parentId": None, "timestamp": "2026-08-19T10:21:31Z", "cwd": "/work/project"},
        {"type": "model_change", "id": "model", "parentId": session_id, "timestamp": "2026-08-19T10:21:32Z", "modelId": "gpt-test"},
        {"type": "message", "id": "u1", "parentId": "model", "timestamp": "2026-08-19T10:22:00Z", "message": {"role": "user", "content": [{"type": "text", "text": "Continue this exact session"}]}},
        {"type": "message", "id": "thinking", "parentId": "u1", "timestamp": "2026-08-19T10:22:00Z", "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "internal"}]}},
        {"type": "message", "id": "call", "parentId": "thinking", "timestamp": "2026-08-19T10:22:00Z", "message": {"role": "assistant", "content": [{"type": "toolCall", "name": "shell", "arguments": {"command": "pytest"}}]}},
        {"type": "message", "id": "tool", "parentId": "call", "timestamp": "2026-08-19T10:22:00Z", "message": {"role": "toolResult", "content": [{"type": "text", "text": "hidden tool output"}]}},
        {"type": "message", "id": "a1", "parentId": "tool", "timestamp": "2026-08-19T10:22:01Z", "message": {"role": "assistant", "content": [{"type": "text", "text": "Ready"}]}},
    ]
    (agent_sessions / f"{session_id}.jsonl").write_text("\n".join(json.dumps(row) for row in records) + "\n")
    artifact_root = tmp_path / "artifacts"
    (artifact_root / session_id).mkdir(parents=True)
    (artifact_root / session_id / "tool.log").write_text("artifact")
    stopped = tmp_path / "stopped"
    prime = tmp_path / "prime-agent"
    prime.write_text(
        "#!/bin/sh\n"
        f"if [ \"$1\" = list ]; then printf '%s\n' '{{\"sessions\":[{{\"id\":\"agent-1\",\"sessionId\":\"{session_id}\"}}]}}'; "
        f"else printf '%s' \"$2\" > {stopped}; printf '%s\n' '{{\"success\":true}}'; fi\n"
    )
    prime.chmod(0o755)
    service = PrimeSessionService(
        Database(tmp_path / "tasks.db"), tmp_path / "archon-sessions", agent_sessions,
        agent_artifact_root=artifact_root, prime_executable=prime,
    )

    rows = service.list()
    assert [row["id"] for row in rows] == [session_id]
    assert rows[0]["title"] == "Continue this exact session"
    assert rows[0]["cwd"] == "/work/project"
    assert rows[0]["message_count"] == 2  # user + visible assistant reply
    messages = service.messages(session_id)
    # Full native sync retains every Prime message record in original order.
    assert [(m["role"], m["content"]) for m in messages] == [
        ("user", "Continue this exact session"),
        ("assistant", "internal"),
        ("assistant", 'shell\n{\n  "command": "pytest"\n}'),
        ("toolResult", "hidden tool output"),
        ("assistant", "Ready"),
    ]
    assert [m["kind"] for m in messages] == ["text", "thinking", "tool", "tool_result", "text"]
    assert service.contains(session_id)
    assert service.delete(session_id)
    assert not (agent_sessions / f"{session_id}.jsonl").exists()
    assert not (artifact_root / session_id).exists()
    assert stopped.read_text() == "agent-1"
    assert service.list() == []



def test_prime_session_splits_reasoning_from_final_text_in_same_message(tmp_path):
    session_id = "cli-mixed-final"
    agent_sessions = tmp_path / "agent" / "sessions"
    agent_sessions.mkdir(parents=True)
    records = [
        {"type": "session", "id": session_id, "parentId": None, "timestamp": "2026-08-22T01:00:00Z", "cwd": "/work"},
        {"type": "message", "id": "user", "parentId": session_id, "timestamp": "2026-08-22T01:00:01Z", "message": {"role": "user", "content": [{"type": "text", "text": "Can you use this file?"}]}},
        {"type": "message", "id": "answer", "parentId": "user", "timestamp": "2026-08-22T01:00:02Z", "message": {"role": "assistant", "content": [
            {"type": "thinking", "thinking": "**Checking file access**"},
            {"type": "text", "text": "The file is not available at that path."},
        ]}},
    ]
    (agent_sessions / f"{session_id}.jsonl").write_text("\n".join(json.dumps(row) for row in records) + "\n")
    service = PrimeSessionService(
        Database(tmp_path / "tasks.db"), tmp_path / "desktop", agent_sessions,
        agent_artifact_root=tmp_path / "artifacts",
    )

    messages = service.messages(session_id)
    assert [(message["kind"], message["content"]) for message in messages] == [
        ("text", "Can you use this file?"),
        ("thinking", "**Checking file access**"),
        ("text", "The file is not available at that path."),
    ]
    row = service.list()[0]
    assert row["message_count"] == 2  # reasoning is activity, not a conversation message
    assert row["source"] == "prime-cli"


def test_project_service_resolves_symlinked_cwd_to_project(tmp_path):
    service = ProjectService(tmp_path / "projects.db")
    root = tmp_path / "workspace" / "project"
    project = service.create("Symlink Project", root)
    alias = tmp_path / "alias"
    alias.symlink_to(root, target_is_directory=True)
    assert service.project_for_path(str(alias / "src")) == project["id"]


def test_project_service_creates_folder_and_resolves_nested_sessions(tmp_path):
    service = ProjectService(tmp_path / "projects.db")
    root = tmp_path / "workspace" / "new-project"
    project = service.create("New Project", root, "Created from Archon")

    assert root.is_dir()
    assert project["name"] == "New Project"
    assert project["primary_path"] == str(root.resolve())
    assert service.project_for_path(str(root / "src")) == project["id"]
    assert service.contains(project["id"])
    assert service.delete(project["id"])
    assert root.is_dir()  # Removing a project never removes its files.
    assert service.list() == []


def test_active_branch_ignores_trailing_metadata_record(tmp_path):
    sessions = tmp_path / "agent-sessions"
    sessions.mkdir()
    session_id = "trailing-model-change"
    records = [
        {"type": "session", "id": "root", "timestamp": "2026-08-27T00:00:00Z"},
        {"type": "message", "id": "u", "parentId": "root", "timestamp": "2026-08-27T00:00:01Z",
         "message": {"role": "user", "content": [{"type": "text", "text": "keep this"}]}},
        {"type": "message", "id": "a", "parentId": "u", "timestamp": "2026-08-27T00:00:02Z",
         "message": {"role": "assistant", "content": [{"type": "text", "text": "reply"}]}},
        {"type": "model_change", "id": "model", "modelId": "new-model", "timestamp": "2026-08-27T00:00:03Z"},
    ]
    (sessions / f"{session_id}.jsonl").write_text("\n".join(json.dumps(row) for row in records) + "\n")
    service = PrimeSessionService(Database(tmp_path / "tasks.db"), tmp_path / "desktop", sessions,
                                  agent_artifact_root=tmp_path / "artifacts")
    assert [(item["role"], item["content"]) for item in service.messages(session_id)] == [
        ("user", "keep this"), ("assistant", "reply")
    ]


def test_prime_session_service_projects_only_active_jsonl_branch(tmp_path):
    agent_sessions = tmp_path / "agent-sessions"
    agent_sessions.mkdir()
    session_id = "branch-session"
    records = [
        {"type": "session", "id": "root", "parentId": None, "timestamp": "2026-08-19T10:00:00Z", "cwd": "/work"},
        {"type": "message", "id": "user", "parentId": "root", "timestamp": "2026-08-19T10:00:01Z", "message": {"role": "user", "content": [{"type": "text", "text": "choose"}]}},
        {"type": "message", "id": "old-answer", "parentId": "user", "timestamp": "2026-08-19T10:00:02Z", "message": {"role": "assistant", "content": [{"type": "text", "text": "old branch"}]}},
        {"type": "message", "id": "active-answer", "parentId": "user", "timestamp": "2026-08-19T10:00:03Z", "message": {"role": "assistant", "content": [{"type": "text", "text": "active branch"}]}},
    ]
    path = agent_sessions / f"{session_id}.jsonl"
    path.write_text("\n".join(json.dumps(row) for row in records) + "\n{malformed tail")
    service = PrimeSessionService(
        Database(tmp_path / "tasks.db"), tmp_path / "archon-sessions", agent_sessions,
        agent_artifact_root=tmp_path / "artifacts",
    )

    assert [(message["role"], message["content"]) for message in service.messages(session_id)] == [
        ("user", "choose"), ("assistant", "active branch")
    ]
    # A renamed native file is exposed once under its canonical header ID,
    # while legacy filename lookup remains usable for direct resume calls.
    assert [row["id"] for row in service.list()] == ["root"]
    assert service.list()[0]["message_count"] == 2


def test_prime_session_service_discovers_nested_native_cli_subagent(tmp_path):
    sessions = tmp_path / "agent" / "sessions"
    sessions.mkdir(parents=True)
    artifacts = tmp_path / "agent" / "session-artifacts"
    session_id = "nested-cli-session"
    path = artifacts / "parent-session" / "sub-child" / f"{session_id}.jsonl"
    path.parent.mkdir(parents=True)
    path.write_text("\n".join(json.dumps(row) for row in [
        {"type": "session", "id": session_id, "parentId": None, "timestamp": "2026-08-20T00:00:00Z", "cwd": "/work/nested"},
        {"type": "message", "id": "u", "parentId": session_id, "timestamp": "2026-08-20T00:00:01Z", "message": {"role": "user", "content": [{"type": "text", "text": "nested prompt"}]}},
        {"type": "message", "id": "a", "parentId": "u", "timestamp": "2026-08-20T00:00:02Z", "message": {"role": "assistant", "content": [{"type": "text", "text": "nested reply"}]}},
    ]) + "\n")
    service = PrimeSessionService(Database(tmp_path / "tasks.db"), tmp_path / "desktop", sessions, agent_artifact_root=artifacts)
    assert service.contains(session_id)
    assert service.list()[0]["id"] == session_id
    assert [(m["role"], m["content"]) for m in service.messages(session_id)] == [("user", "nested prompt"), ("assistant", "nested reply")]


def test_prime_session_service_merges_multiple_desktop_native_runs_chronologically(tmp_path):
    session_id = "prime-logical-session"
    root = tmp_path / "desktop" / session_id
    root.mkdir(parents=True)
    first = [
        {"type": "session", "id": "run-one", "timestamp": "2026-08-20T23:46:00Z"},
        {"type": "message", "id": "old-user", "parentId": "run-one", "timestamp": "2026-08-20T23:46:01Z", "message": {"role": "user", "content": [{"type": "text", "text": "original prompt"}]}},
        {"type": "message", "id": "old-reply", "parentId": "old-user", "timestamp": "2026-08-20T23:46:02Z", "message": {"role": "assistant", "content": [{"type": "text", "text": "original reply"}]}},
    ]
    followup = [
        {"type": "session", "id": "run-two", "timestamp": "2026-08-20T23:48:00Z"},
        {"type": "message", "id": "question", "parentId": "run-two", "timestamp": "2026-08-20T23:48:01Z", "message": {"role": "user", "content": [{"type": "text", "text": "?"}]}},
        {"type": "message", "id": "answer", "parentId": "question", "timestamp": "2026-08-20T23:48:02Z", "message": {"role": "assistant", "content": [{"type": "text", "text": "Hi"}]}},
    ]
    (root / "a.jsonl").write_text("\n".join(json.dumps(x) for x in first) + "\n")
    (root / "b.jsonl").write_text("\n".join(json.dumps(x) for x in followup) + "\n")
    service = PrimeSessionService(Database(tmp_path / "tasks.db"), tmp_path / "desktop", tmp_path / "agent", agent_artifact_root=tmp_path / "artifacts")
    assert [(m["role"], m["content"]) for m in service.messages(session_id)] == [
        ("user", "original prompt"), ("assistant", "original reply"), ("user", "?"), ("assistant", "Hi"),
    ]
    assert service.list()[0]["message_count"] == 4


def test_prime_session_recovers_completed_reply_missing_from_native_jsonl(tmp_path):
    session_id = "prime-missing-final"
    root = tmp_path / "desktop" / session_id
    root.mkdir(parents=True)
    records = [
        {"type": "session", "id": "run", "timestamp": "2026-08-21T00:00:00Z"},
        {"type": "message", "id": "u", "parentId": "run", "timestamp": "2026-08-21T00:00:01Z", "message": {"role": "user", "content": [{"type": "text", "text": "why?"}]}},
        {"type": "message", "id": "thinking", "parentId": "u", "timestamp": "2026-08-21T00:00:02Z", "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "Drafting the answer"}]}},
    ]
    (root / "run.jsonl").write_text("\n".join(json.dumps(row) for row in records) + "\n")
    locations = Database(tmp_path / "tasks.db")
    service = PrimeSessionService(locations, tmp_path / "desktop", tmp_path / "agent", agent_artifact_root=tmp_path / "artifacts")
    with locations.transaction() as conn:
        conn.execute(
            "INSERT INTO tasks(id,prompt,session_id,approval_mode,chat_only,skills_json,status,result_json,created_at,updated_at,started_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            ("task-1", "why?", session_id, "auto", 0, "[]", "completed", json.dumps({"text": "Because this is the durable final reply."}), "2026-08-21T00:00:01Z", "2026-08-21T00:00:03Z", "2026-08-21T00:00:01Z", "2026-08-21T00:00:03Z"),
        )
    messages = service.messages(session_id)
    assert [(m["kind"], m["content"]) for m in messages] == [
        ("text", "why?"), ("thinking", "Drafting the answer"), ("text", "Because this is the durable final reply."),
    ]
    assert len(messages) == 3
    assert service.list()[0]["message_count"] == 2


def test_agent_files_ignores_non_object_jsonl_records(tmp_path):
    from archon_server.services.workspace import PrimeSessionService

    sessions = tmp_path / "sessions"
    sessions.mkdir()
    (sessions / "s.jsonl").write_text("[1, 2, 3]\n{\"type\": \"session\", \"id\": \"s1\"}\n")
    service = PrimeSessionService(None, tmp_path / "projects", sessions, agent_artifact_root=tmp_path / "artifacts")

    assert service._agent_files()["s1"].name == "s.jsonl"


def test_cross_session_80_message_transcript_order_and_isolation(tmp_path):
    agent_root = tmp_path / "agent"
    agent_root.mkdir()
    records_by_session = {}
    for session_index in range(2):
        session_id = f"prime-cross-{session_index}"
        records = [{"type": "session", "id": session_id, "parentId": None,
                    "timestamp": f"2026-08-27T10:0{session_index}:00Z", "cwd": "/work"}]
        for turn in range(40):
            records.extend([
                {"type": "message", "id": f"u-{session_index}-{turn}",
                 "parentId": records[-1]["id"], "timestamp": f"2026-08-27T10:0{session_index}:{turn:02d}Z",
                 "message": {"role": "user", "content": [{"type": "text", "text": f"prompt {session_index}-{turn}"}]}},
                {"type": "message", "id": f"a-{session_index}-{turn}",
                 "parentId": f"u-{session_index}-{turn}", "timestamp": f"2026-08-27T10:0{session_index}:{turn:02d}Z",
                 "message": {"role": "assistant", "content": [{"type": "text", "text": f"answer {session_index}-{turn}"}]}},
            ])
        (agent_root / f"{session_id}.jsonl").write_text("\n".join(json.dumps(row) for row in records) + "\n")
        records_by_session[session_id] = records

    service = PrimeSessionService(Database(tmp_path / "tasks.db"), tmp_path / "desktop", agent_root,
                                  agent_artifact_root=tmp_path / "artifacts")
    sessions = service.list()
    assert {row["id"] for row in sessions} == set(records_by_session)
    assert sum(row["message_count"] for row in sessions) == 160
    for session_id in records_by_session:
        messages = service.messages(session_id, limit=None)
        assert len(messages) == 80
        assert all(session_id.split("-")[-1] in message["content"] for message in messages)
        for index in range(0, 80, 2):
            assert messages[index]["role"] == "user"
            assert messages[index + 1]["role"] == "assistant"


def test_cross_session_multi_use_case_80_messages_and_projects(tmp_path):
    agent_root = tmp_path / "agent"
    agent_root.mkdir()
    projects = ProjectService(tmp_path / "projects.db")
    project_specs = [("coding", "Implement a parser"), ("debugging", "Find this timeout"),
                     ("writing", "Draft release notes"), ("research", "Compare approaches")]
    project_rows = [projects.create(name, tmp_path / name) for name, _ in project_specs]
    session_ids = []
    for session_index, (use_case, question) in enumerate(project_specs):
        session_id = f"prime-usecase-{session_index}"
        session_ids.append(session_id)
        records = [{"type": "session", "id": session_id, "parentId": None,
                    "timestamp": f"2026-08-27T12:0{session_index}:00Z",
                    "cwd": str(tmp_path / use_case)}]
        for turn in range(20):
            user_id = f"u-{session_index}-{turn}"
            answer_id = f"a-{session_index}-{turn}"
            records.extend([
                {"type": "message", "id": user_id, "parentId": records[-1]["id"],
                 "timestamp": f"2026-08-27T12:0{session_index}:{turn:02d}Z",
                 "message": {"role": "user", "content": [{"type": "text",
                     "text": f"{use_case} {turn}: {question}"}]}},
                {"type": "message", "id": answer_id, "parentId": user_id,
                 "timestamp": f"2026-08-27T12:0{session_index}:{turn:02d}Z",
                 "message": {"role": "assistant", "content": [
                     {"type": "thinking", "thinking": f"{use_case} checking"},
                     {"type": "text", "text": f"{use_case} answer {turn}"},
                     {"type": "toolCall", "name": "inspect", "arguments": {"turn": turn, "use_case": use_case}},
                 ]}},
            ])
        (agent_root / f"{session_id}.jsonl").write_text(
            "\n".join(json.dumps(row) for row in records) + "\n")

    service = PrimeSessionService(Database(tmp_path / "tasks.db"), tmp_path / "desktop", agent_root,
                                  agent_artifact_root=tmp_path / "artifacts", projects=projects)
    rows = service.list()
    assert {row["id"] for row in rows} == set(session_ids)
    assert sum(row["message_count"] for row in rows) == 160
    for session_index, session_id in enumerate(session_ids):
        messages = service.messages(session_id, limit=None)
        # 20 prompts and 20 final answers; reasoning/tool blocks must not
        # reorder or replace the visible conversational turns.
        assert len(messages) == 80
        assert [m["role"] for m in messages[::4]] == ["user"] * 20
        assert [m["kind"] for m in messages[1:4]] == ["thinking", "text", "tool"]
        assert all(project_specs[session_index][0] in message["content"] for message in messages)
        row = next(item for item in rows if item["id"] == session_id)
        assert row["project_id"] == project_rows[session_index]["id"]


def test_messages_preserves_repeated_ledger_turns(tmp_path):
    db = Database(tmp_path / "tasks.db")
    now = "2026-08-27T12:00:00+00:00"
    with db.transaction() as conn:
        for index in range(2):
            conn.execute(
                "INSERT INTO tasks(id,prompt,session_id,status,result_json,created_at,updated_at,completed_at) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (f"repeat-{index}", "same prompt", "prime-repeat", "completed",
                 json.dumps({"text": "same answer"}), now, now, now),
            )
    service = PrimeSessionService(db, tmp_path / "desktop", tmp_path / "agent",
                                  agent_artifact_root=tmp_path / "artifacts")
    messages = service.messages("prime-repeat", limit=None)
    assert [(item["role"], item["content"]) for item in messages] == [
        ("user", "same prompt"), ("assistant", "same answer"),
        ("user", "same prompt"), ("assistant", "same answer"),
    ]
