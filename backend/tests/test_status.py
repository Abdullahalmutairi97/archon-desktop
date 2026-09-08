from archon_server.services.status import StatusService


def test_status_reports_machine_and_archon_scopes(tmp_path):
    status = StatusService(tmp_path).snapshot()

    assert 0 <= status["cpu"]["percent"] <= 100
    assert status["memory"]["used"] <= status["memory"]["total"]
    assert status["disk"]["path"] == str(tmp_path)
    assert 0 <= status["archon"]["cpu_percent"] <= 100
    assert 0 <= status["archon"]["memory_used"]
    assert 0 <= status["archon"]["memory_percent"] <= 100
    assert status["archon"]["processes"] >= 1
    assert status["archon"]["accounting"] in {"systemd-cgroup", "process-tree"}


def test_read_cgroup_cpu_ignores_malformed_lines(tmp_path):
    from archon_server.services.status import StatusService

    (tmp_path / "cpu.stat").write_text("broken\nusage_usec nope\nusage_usec 2500000\n")
    assert StatusService._read_cgroup_cpu(tmp_path) == 2.5
