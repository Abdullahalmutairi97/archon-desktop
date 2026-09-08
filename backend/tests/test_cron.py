from pathlib import Path

from archon_server.services.cron import CronService


def test_cron_list_handles_malformed_jobs_file(tmp_path: Path):
    jobs = tmp_path / "jobs.json"
    jobs.write_text("{not json")
    service = CronService(tmp_path, "default", jobs, commands=None)

    assert service.list() == []


def test_cron_list_ignores_malformed_schedule_shape(tmp_path: Path):
    jobs = tmp_path / "jobs.json"
    jobs.write_text('{"jobs": [{"id": "x", "schedule": ["bad"]}]}')
    service = CronService(tmp_path, "default", jobs, commands=None)

    assert service.list()[0]["schedule"] is None


def test_cron_list_ignores_non_list_jobs_and_skills(tmp_path):
    from archon_server.services.cron import CronService

    jobs = tmp_path / "jobs.json"
    jobs.write_text('{"jobs": [{"id": "a", "skills": {"bad": true}}]}')
    service = CronService(tmp_path / "hermes", "default", jobs, None)

    assert service.list()[0]["skills"] == []
    jobs.write_text('{"jobs": {"bad": true}}')
    assert service.list() == []
