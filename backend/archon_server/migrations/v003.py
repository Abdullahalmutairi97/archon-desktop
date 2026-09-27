"""Immutable migration 3: retain runner event delivery receipts."""


RUNNER_EVENT_RECEIPTS_SQL = """CREATE TABLE runner_event_receipts (
     runner_id TEXT NOT NULL,
     journal_generation INTEGER NOT NULL CHECK(journal_generation > 0),
     runner_seq INTEGER NOT NULL CHECK(runner_seq > 0),
     envelope_json TEXT NOT NULL,
     disposition TEXT NOT NULL CHECK(disposition IN ('accepted','stale')),
     event_seq INTEGER,
     created_at TEXT NOT NULL,
     PRIMARY KEY(runner_id,journal_generation,runner_seq),
     CHECK((disposition='accepted' AND event_seq IS NOT NULL AND event_seq > 0)
        OR (disposition='stale' AND event_seq IS NULL))
   )"""
RUNNER_EVENT_SEQ_INDEX_SQL = """CREATE UNIQUE INDEX idx_runner_event_receipts_event_seq
   ON runner_event_receipts(event_seq)
   WHERE event_seq IS NOT NULL"""
RUNNER_EVENT_RECEIPTS_TRIGGER_SQL = """CREATE TRIGGER runner_event_receipts_immutable
   BEFORE UPDATE ON runner_event_receipts
   BEGIN
     SELECT RAISE(ABORT, 'runner event receipts are immutable');
   END"""
RUNNER_GENERATION_STATE_SQL = """CREATE TABLE runner_generation_state (
     runner_id TEXT NOT NULL PRIMARY KEY,
     active_generation INTEGER NOT NULL CHECK(active_generation > 0),
     last_runner_seq INTEGER NOT NULL CHECK(last_runner_seq >= 0)
   )"""


def apply(conn) -> None:
    conn.execute(RUNNER_EVENT_RECEIPTS_SQL)
    conn.execute(RUNNER_EVENT_SEQ_INDEX_SQL)
    conn.execute(RUNNER_EVENT_RECEIPTS_TRIGGER_SQL)
    conn.execute(RUNNER_GENERATION_STATE_SQL)
