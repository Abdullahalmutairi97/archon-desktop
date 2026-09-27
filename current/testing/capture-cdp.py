#!/usr/bin/env python3
"""Capture a running Electron app's renderer over the Chrome DevTools Protocol.

Usage: capture-cdp.py <port> <out.png> [width] [height]

Forces a fixed device-metrics override so captures are comparable regardless of
the window's own size, then writes one PNG. Read-only against the running app.
"""
from __future__ import annotations

import asyncio
import base64
import json
import sys
import time
import urllib.request

import websockets


async def capture(port: int, out: str, width: int, height: int) -> None:
    target = None
    for _ in range(60):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=2) as response:
                pages = [item for item in json.load(response) if item.get("type") == "page"]
            if pages:
                target = pages[0]
                break
        except Exception:
            pass
        await asyncio.sleep(0.5)
    if target is None:
        raise SystemExit("no page target on the debugging port")

    async with websockets.connect(target["webSocketDebuggerUrl"], max_size=64 * 1024 * 1024) as socket:
        counter = 0

        async def call(method: str, params: dict | None = None) -> dict:
            nonlocal counter
            counter += 1
            await socket.send(json.dumps({"id": counter, "method": method, "params": params or {}}))
            while True:
                reply = json.loads(await socket.recv())
                if reply.get("id") == counter:
                    return reply

        await call("Page.enable")
        await call("Emulation.setDeviceMetricsOverride", {
            "width": width, "height": height, "deviceScaleFactor": 1, "mobile": False,
        })
        await asyncio.sleep(2.0)
        result = await call("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})
        data = result.get("result", {}).get("data")
        if not data:
            raise SystemExit("captureScreenshot returned no data")
        with open(out, "wb") as handle:
            handle.write(base64.b64decode(data))
        print(json.dumps({"out": out, "width": width, "height": height}))


if __name__ == "__main__":
    _, port_arg, out_arg, *rest = sys.argv
    asyncio.run(capture(int(port_arg), out_arg, int(rest[0]) if rest else 1440, int(rest[1]) if len(rest) > 1 else 900))
