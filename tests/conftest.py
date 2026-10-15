"""Shared fixtures: free ports, uniquely named pylsl loopback outlets pushing at their nominal rate, and a
running ViewerServer. Stream names carry a random suffix so concurrent LSL traffic on the network
(other tests, real devices) never gets mixed up with ours."""
from __future__ import annotations

import asyncio
import json
import math
import socket
import threading
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Callable

import pytest

pylsl = pytest.importorskip("pylsl")

from lsl_web_viewer.server import ViewerServer  # noqa: E402


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Publisher(threading.Thread):
    """A pylsl outlet that pushes a sine per channel at `srate` (or strings for a marker stream)."""

    def __init__(self, name: str, kind: str = "EMG", channels: int = 4, srate: float = 200.0,
                 labels: list[str] | None = None, string: bool = False):
        super().__init__(daemon=True)
        fmt = pylsl.cf_string if string else pylsl.cf_float32
        self.info = pylsl.StreamInfo(name, kind, channels, srate if not string else 0, fmt, f"pytest-{name}")
        if labels:
            chans = self.info.desc().append_child("channels")
            for lab in labels:
                chans.append_child("channel").append_child_value("label", lab)
        self.outlet = pylsl.StreamOutlet(self.info)
        self.srate, self.channels, self.string = srate, channels, string
        self._halt = threading.Event()

    def run(self) -> None:
        t0, n = time.monotonic(), 0
        while not self._halt.is_set():
            t = time.monotonic() - t0
            if self.string:
                self.outlet.push_sample([f"m{n}"])
                n += 1
                self._halt.wait(0.2)
                continue
            while n < t * self.srate:
                self.outlet.push_sample([math.sin(2 * math.pi * 5 * n / self.srate + c) for c in range(self.channels)])
                n += 1
            time.sleep(0.002)

    def stop(self) -> None:
        self._halt.set()
        self.join(timeout=2)


@pytest.fixture
def uniq() -> str:
    return uuid.uuid4().hex[:8]


@pytest.fixture
def publish():
    pubs: list[Publisher] = []

    def make(*a: Any, **k: Any) -> Publisher:
        p = Publisher(*a, **k)
        p.start()
        pubs.append(p)
        return p

    yield make
    for p in pubs:
        p.stop()


@pytest.fixture
async def viewer(tmp_path) -> AsyncIterator[ViewerServer]:
    port = free_port()
    server = ViewerServer("127.0.0.1", port, data_dir=tmp_path / "data")
    async with server.serve():
        server.start_discovery(period=0.3)
        try:
            yield server
        finally:
            await server.close()


class Page:
    """A minimal stand-in for the browser page: collects every message by type."""

    def __init__(self, ws: Any):
        self.ws = ws
        self.msgs: list[dict[str, Any]] = []
        self.task = asyncio.create_task(self._pump())

    async def _pump(self) -> None:
        async for raw in self.ws:
            self.msgs.append(json.loads(raw))

    def of(self, kind: str) -> list[dict[str, Any]]:
        return [m for m in self.msgs if m.get("type") == kind]

    async def send(self, **msg: Any) -> None:
        await self.ws.send(json.dumps(msg))

    async def until(self, pred: Callable[[], Any], timeout: float = 15.0) -> Any:
        async with asyncio.timeout(timeout):
            while not (v := pred()):
                await asyncio.sleep(0.05)
            return v

    async def stream_uid(self, name: str, timeout: float = 15.0) -> str:
        def find() -> str | None:
            for m in reversed(self.of("streams")):
                for r in m["streams"]:
                    if r["name"] == name:
                        return r["uid"]
            return None
        return await self.until(find, timeout)


@asynccontextmanager
async def page(server: ViewerServer) -> AsyncIterator[Page]:
    import websockets

    async with websockets.connect(f"ws://127.0.0.1:{server.port}/ws", max_size=2**22) as ws:
        p = Page(ws)
        try:
            yield p
        finally:
            p.task.cancel()


@pytest.fixture(autouse=True)
def _isolated_config(tmp_path, monkeypatch):
    """Never touch the real ~/.config/lsl-web-viewer from tests."""
    monkeypatch.setenv("LSL_WEB_VIEWER_CONFIG", str(tmp_path / "config.json"))
