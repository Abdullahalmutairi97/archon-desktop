from __future__ import annotations

import uvicorn

from .app import create_app
from .config import Settings
from .hardening import ensure_process_environment_is_private
from .security import validate_server_security


def main() -> None:
    settings = Settings()
    validate_server_security(settings)
    # The server holds provider credentials in its own environment, and Linux lets any
    # same-uid process read /proc/<pid>/environ. Clear the dumpable flag before the
    # listener starts; a host that refuses the call keeps running, and the evidence
    # record states that this channel is then not closed.
    ensure_process_environment_is_private()
    uvicorn.run(
        create_app(settings), host=settings.bind_host, port=settings.bind_port,
        timeout_graceful_shutdown=5, proxy_headers=False,
    )


if __name__ == "__main__":
    main()
