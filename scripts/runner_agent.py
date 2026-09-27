#!/usr/bin/env python3
"""Run an enrolled remote runner: claim work, execute it and acknowledge it.

Example:
  python3 scripts/runner_agent.py \
    --server http://127.0.0.1:8000 --runner-id runner-... --secret ... \
    --executable ~/.local/bin/pi --work-root ~/runner-work
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from archon_server.runner_agent import RunnerAgent, RemoteRunnerClient, make_runtime_executor  # noqa: E402


async def run(args: argparse.Namespace) -> None:
    client = RemoteRunnerClient(args.server, args.runner_id, args.secret, timeout=args.timeout)
    agent = RunnerAgent(client, make_runtime_executor(args.executable, args.work_root), max_claim=args.max_claim)
    while True:
        handled = await agent.run_once()
        if args.once:
            return
        if handled == 0:
            await asyncio.sleep(args.interval)


def main() -> int:
    parser = argparse.ArgumentParser(description="Archon remote runner agent")
    parser.add_argument("--server", required=True, help="coordinator base URL")
    parser.add_argument("--runner-id", required=True)
    parser.add_argument("--secret", required=True)
    parser.add_argument("--executable", required=True, help="runtime CLI with a non-interactive -p mode")
    parser.add_argument("--work-root", required=True, help="absolute directory remote work runs under")
    parser.add_argument("--max-claim", type=int, default=4)
    parser.add_argument("--interval", type=float, default=5.0, help="seconds to wait when no work is claimed")
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--once", action="store_true", help="run a single claim cycle and exit")
    args = parser.parse_args()
    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
