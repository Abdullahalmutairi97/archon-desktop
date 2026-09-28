"""Debug readiness: adapter artefacts, gaps and the launch inspection.

The block must never imply a capability. It reports what is pinned and installed,
what this host cannot provide, and how the IDE service would be launched.
"""
from __future__ import annotations

import json

import pytest

from archon_server.debug_profiles import (
    BREAKPOINT_VERIFIED,
    SESSION_EXERCISED,
    describe_debug_readiness,
)

PYTHON_PROFILE = {
    "profile": "python",
    "debuggers": [{
        "extensionId": "ms-python.debugpy", "version": "2026.6.0", "state": "installed",
        "reason": None, "declaredLicence": "MIT", "pinnedInstalledSha256": "a" * 64,
    }],
}
JS_PROFILE = {"profile": "javascript-typescript", "debuggers": []}


def test_adapters_are_reported_with_their_pinned_facts():
    report = describe_debug_readiness([PYTHON_PROFILE, JS_PROFILE])
    assert report["adapters"] == [{
        "profile": "python", "extensionId": "ms-python.debugpy", "version": "2026.6.0",
        "state": "installed", "reason": None, "declaredLicence": "MIT",
        "pinnedInstalledSha256": "a" * 64,
    }]
    # A profile with no pinned adapter is reported as unsupported, not as available.
    features = {(row["profile"], row["feature"]) for row in report["unsupported"]}
    assert ("javascript-typescript", "debugging") in features
    assert (None, "dap-session-control") in features


def test_the_honesty_flags_are_constants_and_never_true():
    report = describe_debug_readiness([PYTHON_PROFILE])
    assert report["sessionExercised"] is False
    assert report["breakpointVerified"] is False
    assert SESSION_EXERCISED is False and BREAKPOINT_VERIFIED is False
    assert "no debug session" in report["note"].lower()
    # A caller cannot turn them on through the input.
    hostile = describe_debug_readiness([{**PYTHON_PROFILE, "sessionExercised": True, "breakpointVerified": True}])
    assert hostile["sessionExercised"] is False and hostile["breakpointVerified"] is False


def test_a_missing_adapter_is_reported_with_its_reason():
    profile = {"profile": "python", "debuggers": [{
        "extensionId": "ms-python.debugpy", "version": "2026.6.0", "state": "missing",
        "reason": "the pinned extension is not installed in this directory",
        "declaredLicence": "MIT", "pinnedInstalledSha256": "b" * 64,
    }]}
    row = describe_debug_readiness([profile])["adapters"][0]
    assert row["state"] == "missing"
    assert row["reason"] == "the pinned extension is not installed in this directory"


def test_the_ide_launch_is_inspected_without_claiming_isolation():
    services = [{
        "name": "code-server", "argv": ["/opt/code-server", "--bind-addr", "127.0.0.1:4173",
                                        "--auth", "none", "--disable-telemetry", "."],
        "state": "running", "ports": [{"name": "http", "port": 4173}],
        "memoryLimitMb": None, "cpuQuotaPercent": None, "tasksMax": None,
        "filesystemIsolation": "none", "networkIsolation": "host",
    }, {"name": "web", "argv": ["/bin/echo"], "state": "registered", "ports": []}]
    row = describe_debug_readiness([PYTHON_PROFILE], services=services)["codeServer"]
    assert row["registered"] is True and row["state"] == "running"
    assert row["authMode"] == "none" and row["bindAddress"] == "127.0.0.1:4173"
    assert row["ports"] == [{"name": "http", "port": 4173}]
    assert row["resourceControls"] == {
        "memoryLimitMb": None, "cpuQuotaPercent": None, "tasksMax": None,
        "filesystemIsolation": "none", "networkIsolation": "host",
    }
    assert "no confirmed resource or filesystem confinement" in row["accountNote"]
    # An unregistered IDE is reported as absent, not as running.
    assert describe_debug_readiness([PYTHON_PROFILE], services=[] )["codeServer"] is None
    assert describe_debug_readiness([PYTHON_PROFILE], services=[services[1]])["codeServer"] is None


def test_the_report_is_bounded_and_json_serialisable():
    many = [{"profile": f"p{index}", "debuggers": [
        {"extensionId": f"vendor.ext{index}", "version": "1", "state": "installed",
         "reason": None, "declaredLicence": "MIT", "pinnedInstalledSha256": "c" * 64},
    ]} for index in range(64)]
    report = describe_debug_readiness(many)
    assert len(report["adapters"]) <= 32
    json.dumps(report)
