#!/usr/bin/env python3
"""Run backend fixture tests without loading the operator's .env or history."""
from pathlib import Path
import os
import subprocess
import sys
import tempfile


def main() -> int:
    repo = Path(__file__).resolve().parents[1]
    python = repo / "backend/.venv/bin/python"
    if not python.is_file():
        print("Create backend/.venv and install './backend[dev]' first.", file=sys.stderr)
        return 2
    # Resolve test paths before changing cwd; preserve pytest options and node IDs.
    args = []
    for arg in sys.argv[1:]:
        path, separator, node = arg.partition("::")
        candidate = Path(path)
        args.append(str(candidate.resolve()) + separator + node if candidate.exists() else arg)
    if not args:
        args = [str(repo / "backend/tests")]
    env = {key: value for key, value in os.environ.items() if not key.startswith("ARCHON_DESKTOP_")}
    with tempfile.TemporaryDirectory(prefix="archon-fixture-tests-") as root:
        # Do not override worker semantics or account-home defaults: dedicated tests
        # exercise them. Mutation tests must supply explicit tmp_path/fake runners.
        for key in (
            "DATA_DIR", "PRIME_AGENT_SESSION_DIR", "PI_AGENT_SESSION_DIR",
            "PRIME_AGENT_ARTIFACT_DIR", "RESOURCE_HOME", "PRIME_RESOURCES_DIR",
            "PI_RESOURCES_DIR", "PRIME_AUTH_PATH", "PRIME_USER_SKILLS_DIR",
        ):
            env["ARCHON_DESKTOP_" + key] = str(Path(root) / key.lower())
        return subprocess.run(
            [str(python), "-m", "pytest", "-o", "addopts=", "-q", *args],
            cwd=root, env=env, check=False,
        ).returncode


if __name__ == "__main__":
    raise SystemExit(main())
