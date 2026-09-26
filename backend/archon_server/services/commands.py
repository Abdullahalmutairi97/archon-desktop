from __future__ import annotations

import asyncio
from pathlib import Path

from ..child_env import build_child_env


class CommandRunner:
    async def run(
        self,
        argv,
        *,
        cwd: str | Path | None = None,
        timeout: float = 300,
        detach_stdio: bool = False,
        env: dict[str, str] | None = None,
        environment_scope: str = "operations",
    ) -> dict:
        output = asyncio.subprocess.DEVNULL if detach_stdio else asyncio.subprocess.PIPE
        process = await asyncio.create_subprocess_exec(
            *(str(value) for value in argv),
            cwd=str(cwd) if cwd else None,
            stdin=asyncio.subprocess.DEVNULL if detach_stdio else None,
            stdout=output,
            stderr=output if detach_stdio else asyncio.subprocess.PIPE,
            env=build_child_env(environment_scope, overrides=env),
        )
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
        except TimeoutError:
            process.kill()
            await process.wait()
            raise RuntimeError(f"Command timed out after {timeout:g}s")
        return {
            "returncode": process.returncode,
            "stdout": stdout.decode(errors="replace") if stdout else "",
            "stderr": stderr.decode(errors="replace") if stderr else "",
        }
