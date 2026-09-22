"""Backend entry point: ``python -m app`` (dev) or the PyInstaller executable.

The server binds an ephemeral port on 127.0.0.1 and prints a single
``READY <port>`` line to stdout, which the Electron main process waits for.
"""

from __future__ import annotations

import logging
import os
import socket
import sys
import threading
import time


def _watch_parent(pid: int) -> None:
    """Exit when the Electron process disappears (e.g. it crashed or was killed)."""
    import psutil

    while True:
        time.sleep(2)
        if not psutil.pid_exists(pid):
            os._exit(0)


def main() -> None:
    # Make console output UTF-8 so Arabic log lines never crash on cp1252.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass

    logging.basicConfig(
        level=os.environ.get("TRANSCRIBER_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )

    from .config import load_settings
    from .server import create_app
    from .system_info import prepare_cuda_libraries

    settings = load_settings()
    prepare_cuda_libraries()  # before CTranslate2 touches CUDA

    if settings.parent_pid:
        threading.Thread(target=_watch_parent, args=(settings.parent_pid,), daemon=True).start()

    import uvicorn

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    port = int(os.environ.get("TRANSCRIBER_PORT", "0"))
    sock.bind(("127.0.0.1", port))  # loopback only: never exposed to the network
    port = sock.getsockname()[1]

    config = uvicorn.Config(
        create_app(settings),
        log_level="warning",
        access_log=False,
        lifespan="off",
    )
    server = uvicorn.Server(config)

    def announce() -> None:
        while not server.started:
            time.sleep(0.05)
        print(f"READY {port}", flush=True)

    threading.Thread(target=announce, daemon=True).start()
    server.run(sockets=[sock])


if __name__ == "__main__":
    main()
