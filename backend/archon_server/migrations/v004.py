"""Immutable migration 4: persist explicit workspace and native-session identity."""


WORKSPACES_SQL = """CREATE TABLE workspaces (
     workspace_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(workspace_id)) BETWEEN 1 AND 200),
     root TEXT NOT NULL UNIQUE CHECK(length(trim(root)) > 0),
     owner_id TEXT NOT NULL CHECK(length(trim(owner_id)) BETWEEN 1 AND 200),
     project_id TEXT CHECK(project_id IS NULL OR length(trim(project_id)) BETWEEN 1 AND 200),
     base_revision TEXT CHECK(base_revision IS NULL OR length(trim(base_revision)) BETWEEN 1 AND 256),
     head_revision TEXT CHECK(head_revision IS NULL OR length(trim(head_revision)) BETWEEN 1 AND 256),
     generation INTEGER NOT NULL CHECK(generation > 0),
     isolation_profile TEXT NOT NULL CHECK(length(trim(isolation_profile)) BETWEEN 1 AND 128),
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )"""

WORKSPACE_SESSIONS_SQL = """CREATE TABLE workspace_native_sessions (
     native_session_id TEXT NOT NULL CHECK(length(trim(native_session_id)) BETWEEN 1 AND 200),
     workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
     runtime_id TEXT NOT NULL CHECK(runtime_id IN ('prime','pi')),
     cwd TEXT NOT NULL CHECK(length(trim(cwd)) > 0),
     mapped_at TEXT NOT NULL,
     PRIMARY KEY(runtime_id,native_session_id)
   )"""

WORKSPACE_SESSIONS_INDEX_SQL = """CREATE INDEX idx_workspace_native_sessions_workspace
   ON workspace_native_sessions(workspace_id)"""

WORKSPACE_IDENTITY_TRIGGER_SQL = """CREATE TRIGGER workspace_id_root_immutable
   BEFORE UPDATE OF workspace_id,root ON workspaces
   BEGIN
     SELECT RAISE(ABORT, 'workspace id and authoritative root are immutable');
   END"""

WORKSPACE_GENERATION_TRIGGER_SQL = """CREATE TRIGGER workspace_generation_fenced
   BEFORE UPDATE ON workspaces
   WHEN (NEW.generation != OLD.generation AND NEW.generation != OLD.generation + 1)
     OR ((NEW.owner_id IS NOT OLD.owner_id OR NEW.project_id IS NOT OLD.project_id
          OR NEW.base_revision IS NOT OLD.base_revision OR NEW.head_revision IS NOT OLD.head_revision
          OR NEW.isolation_profile IS NOT OLD.isolation_profile)
         AND NEW.generation != OLD.generation + 1)
   BEGIN
     SELECT RAISE(ABORT, 'workspace identity changes require the next generation');
   END"""

WORKSPACE_SESSION_IMMUTABLE_TRIGGER_SQL = """CREATE TRIGGER workspace_native_session_immutable
   BEFORE UPDATE ON workspace_native_sessions
   BEGIN
     SELECT RAISE(ABORT, 'workspace native-session mappings are immutable');
   END"""


def apply(conn) -> None:
    # Earlier versions lack enough evidence to bind a native session to both
    # an authoritative workspace root and owner. Preserve that history without
    # manufacturing workspace or native-session mappings during migration.
    conn.execute(WORKSPACES_SQL)
    conn.execute(WORKSPACE_SESSIONS_SQL)
    conn.execute(WORKSPACE_SESSIONS_INDEX_SQL)
    conn.execute(WORKSPACE_IDENTITY_TRIGGER_SQL)
    conn.execute(WORKSPACE_GENERATION_TRIGGER_SQL)
    conn.execute(WORKSPACE_SESSION_IMMUTABLE_TRIGGER_SQL)
