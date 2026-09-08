from __future__ import annotations

import uvicorn

from .app import create_app
from .config import Settings


def main() -> None:
    settings = Settings()
    uvicorn.run(
        create_app(settings), host=settings.bind_host, port=settings.bind_port,
        timeout_graceful_shutdown=5,
    )


if __name__ == "__main__":
    main()
