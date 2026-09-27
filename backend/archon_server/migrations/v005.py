"""Immutable migration 5: bind Prime task attempts to provisioned workspace generations."""


TASK_WORKSPACE_IMMUTABLE_TRIGGER_SQL = """CREATE TRIGGER task_workspace_binding_immutable
   BEFORE UPDATE OF workspace_id,workspace_generation,cwd ON tasks
   WHEN NEW.workspace_id IS NOT OLD.workspace_id
     OR NEW.workspace_generation IS NOT OLD.workspace_generation
     OR (OLD.workspace_id IS NOT NULL AND NEW.cwd IS NOT OLD.cwd)
   BEGIN
     SELECT RAISE(ABORT, 'workspace task binding is immutable');
   END"""

TASK_WORKSPACE_INSERT_TRIGGER_SQL = """CREATE TRIGGER task_workspace_binding_valid
   BEFORE INSERT ON tasks
   WHEN (NEW.workspace_id IS NULL) != (NEW.workspace_generation IS NULL)
     OR (NEW.workspace_id IS NOT NULL AND (
       NEW.project_id IS NULL
       OR NEW.runtime_id IS NOT 'prime'
       OR NEW.profile IS NOT 'prime'
       OR NOT EXISTS (
         SELECT 1 FROM workspaces AS workspace
         WHERE workspace.workspace_id=NEW.workspace_id
           AND workspace.generation=NEW.workspace_generation
           AND workspace.root=NEW.cwd
           AND workspace.project_id IS NEW.project_id
       )
     ))
   BEGIN
     SELECT RAISE(ABORT, 'task workspace binding does not match its workspace snapshot');
   END"""

ATTEMPT_WORKSPACE_IMMUTABLE_TRIGGER_SQL = """CREATE TRIGGER task_attempt_workspace_binding_immutable
   BEFORE UPDATE OF workspace_id,workspace_generation ON task_attempts
   BEGIN
     SELECT RAISE(ABORT, 'task attempt workspace binding is immutable');
   END"""

ATTEMPT_WORKSPACE_INSERT_TRIGGER_SQL = """CREATE TRIGGER task_attempt_workspace_binding_valid
   BEFORE INSERT ON task_attempts
   WHEN (NEW.workspace_id IS NULL) != (NEW.workspace_generation IS NULL)
     OR NEW.workspace_id IS NOT (
       SELECT workspace_id FROM tasks WHERE id=NEW.task_id
     )
     OR NEW.workspace_generation IS NOT (
       SELECT workspace_generation FROM tasks WHERE id=NEW.task_id
     )
     OR EXISTS (
       SELECT 1 FROM tasks AS task WHERE task.id=NEW.task_id AND task.workspace_id IS NOT NULL
         AND (NEW.cwd IS NOT task.cwd OR NEW.project_id IS NOT task.project_id
              OR NEW.runtime_id IS NOT task.runtime_id)
     )
   BEGIN
     SELECT RAISE(ABORT, 'task attempt workspace binding does not match its task');
   END"""


def apply(conn) -> None:
    conn.execute(
        "ALTER TABLE tasks ADD COLUMN workspace_id TEXT "
        "REFERENCES workspaces(workspace_id) ON DELETE RESTRICT"
    )
    conn.execute(
        "ALTER TABLE tasks ADD COLUMN workspace_generation INTEGER "
        "CHECK(workspace_generation IS NULL OR workspace_generation > 0)"
    )
    conn.execute(
        "ALTER TABLE task_attempts ADD COLUMN workspace_id TEXT "
        "REFERENCES workspaces(workspace_id) ON DELETE RESTRICT"
    )
    conn.execute(
        "ALTER TABLE task_attempts ADD COLUMN workspace_generation INTEGER "
        "CHECK(workspace_generation IS NULL OR workspace_generation > 0)"
    )
    conn.execute(TASK_WORKSPACE_IMMUTABLE_TRIGGER_SQL)
    conn.execute(TASK_WORKSPACE_INSERT_TRIGGER_SQL)
    conn.execute(ATTEMPT_WORKSPACE_IMMUTABLE_TRIGGER_SQL)
    conn.execute(ATTEMPT_WORKSPACE_INSERT_TRIGGER_SQL)
