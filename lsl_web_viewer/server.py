"""The viewer server: one port, plain HTTP for the page (site.py) and a WebSocket at /ws.

Protocol (JSON text frames; full description in README.md):

  server → page   hello      {version, data_dir}                          once, on connect
                  streams    {streams: [row…]}                            every second (discovery.py)
                  data       {uid, t: [...], x: [[ch1…], [ch2…], …]}       ~30 Hz per subscribed stream
                  markers    {uid, t: [...], values: [...]}                as they arrive (string streams)
                  rec_status {state, label, team, take, of, remaining, elapsed, duration, uids}
                  saved      {files: [...], take, of}                      after each take is written
                  error      {message}
  page → server   subscribe    {uids: [...]}                              replaces this page's subscriptions
                  record_start {label, team, uids?, duration?, countdown?, repeat?, rest?}
                  record_stop  {}

Several pages may be open at once; each gets data only for the streams it subscribed to, and inlets
exist for the union of all subscriptions (plus the streams of a running take). Recording is shared:
every page sees the same rec_status.
"""
from __future__ import annotations

import asyncio
import json
import logging
import socket
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from websockets.asyncio.server import ServerConnection, broadcast, serve
from websockets.exceptions import ConnectionClosed

from . import __version__
from .discovery import Discovery, StreamRow
from .inlets import StreamReader
from .recorder import STOP_GRACE_SEC, Recorder
from .site import SiteServer

log = logging.getLogger("lsl_web_viewer")
WS_PATH = "/ws"
STATUS_PERIOD = 0.2  # rec_status updates while a take sequence runs


@dataclass
class Client:
    subs: set[str] = field(default_factory=set)


@dataclass
class TakePlan:
    label: str
    team: str
    uids: list[str]
    duration: float | None   # None = manual (until record_stop)
    countdown: float
    repeat: int
    rest: float


def _num(v: Any, default: float, lo: float, hi: float) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return min(max(f, lo), hi) if f == f else default


class ViewerServer:
    def __init__(self, host: str = "localhost", port: int = 8770, data_dir: str | Path = "data",
                 site: SiteServer | None = None, markers: bool = True):
        self.host, self.port = host, port
        self.site = site if site is not None else SiteServer(ws_paths={WS_PATH})
        self.recorder = Recorder(data_dir, markers=markers,
                                 marker_source_id=f"lsl-web-viewer@{socket.gethostname()}:{port}")
        self.clients: dict[ServerConnection, Client] = {}
        self.rows: dict[str, StreamRow] = {}
        self.readers: dict[str, StreamReader] = {}
        self.discovery: Discovery | None = None
        self.status: dict[str, Any] = {"type": "rec_status", "state": "idle"}
        self._take_task: asyncio.Task[None] | None = None
        self._stop_evt = asyncio.Event()
        self._plan: TakePlan | None = None

    # ------------------------------------------------------------------ sending
    def _send_all(self, msg: dict[str, Any]) -> None:
        if self.clients:
            broadcast(list(self.clients), json.dumps(msg, separators=(",", ":")))

    def _send_stream(self, uid: str, text: str) -> None:
        """Called on the loop by StreamReader threads with a ready-made data / markers message."""
        targets = [ws for ws, c in self.clients.items() if uid in c.subs]
        if targets:
            broadcast(targets, text)

    def _set_status(self, **kw: Any) -> None:
        self.status = {"type": "rec_status", **kw}
        self._send_all(self.status)

    # ------------------------------------------------------------------ discovery + inlets
    def on_streams(self, table: list[StreamRow]) -> None:
        self.rows = {r["uid"]: r for r in table}
        for c in self.clients.values():
            c.subs &= self.rows.keys()  # a vanished stream is unsubscribed (the page re-subscribes its successor)
        self._sync_readers()
        self._send_all({"type": "streams", "streams": table})

    def _sync_readers(self) -> None:
        wanted: set[str] = set().union(*(c.subs for c in self.clients.values())) if self.clients else set()
        if self._plan is not None:
            wanted |= set(self._plan.uids)
        wanted &= self.rows.keys()
        for uid in [u for u in self.readers if u not in wanted]:
            self.readers.pop(uid).stop()
        loop = asyncio.get_running_loop()
        for uid in wanted - self.readers.keys():
            info = self.discovery.info(uid) if self.discovery else None
            if info is None:
                continue
            r = StreamReader(info, self.rows[uid], loop, self._send_stream, sink=self.recorder)
            self.readers[uid] = r
            r.start()

    # ------------------------------------------------------------------ connections
    async def handler(self, ws: ServerConnection) -> None:
        path = (ws.request.path if ws.request else "/").split("?")[0].rstrip("/") or "/"
        if path != WS_PATH:
            await ws.close(code=4404, reason=f"unknown path {path}; use {WS_PATH}")
            return
        self.clients[ws] = Client()
        try:
            await ws.send(json.dumps({"type": "hello", "version": __version__,
                                      "data_dir": str(self.recorder.data_dir.resolve())}))
            await ws.send(json.dumps({"type": "streams", "streams": list(self.rows.values())}))
            await ws.send(json.dumps(self.status))
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                if isinstance(msg, dict):
                    self._on_message(ws, msg)
        except ConnectionClosed:
            pass
        finally:
            self.clients.pop(ws, None)
            self._sync_readers()

    def _on_message(self, ws: ServerConnection, msg: dict[str, Any]) -> None:
        t = msg.get("type")
        if t == "subscribe":
            uids = msg.get("uids") or []
            self.clients[ws].subs = {u for u in uids if isinstance(u, str) and u in self.rows}
            self._sync_readers()
        elif t == "record_start":
            err = self.start_takes(msg, default_uids=self.clients[ws].subs)
            if err:
                broadcast([ws], json.dumps({"type": "error", "message": err}))
        elif t == "record_stop":
            self._stop_evt.set()

    # ------------------------------------------------------------------ takes
    def start_takes(self, msg: dict[str, Any], default_uids: set[str] | None = None) -> str | None:
        """Start a take sequence; returns an error message, or None when it started."""
        if self._take_task is not None and not self._take_task.done():
            return "already recording; stop the current take first"
        uids = [u for u in (msg.get("uids") or sorted(default_uids or ())) if u in self.rows]
        if not uids:
            return "nothing to record: subscribe to (tick) at least one stream"
        dur = msg.get("duration")
        plan = TakePlan(
            label=str(msg.get("label") or "").strip(), team=str(msg.get("team") or "").strip(), uids=uids,
            duration=_num(dur, 5.0, 0.1, 24 * 3600) if dur not in (None, "", 0) else None,
            countdown=_num(msg.get("countdown"), 0.0, 0.0, 60.0),
            repeat=int(_num(msg.get("repeat"), 1, 1, 1000)),
            rest=_num(msg.get("rest"), 0.0, 0.0, 3600.0),
        )
        if plan.duration is None:
            plan.repeat = 1  # repeats only make sense for timed takes
        self._plan = plan
        self._stop_evt.clear()
        self._sync_readers()
        self._take_task = asyncio.create_task(self._run_takes(plan))
        return None

    async def _phase(self, state: str, seconds: float | None, k: int, plan: TakePlan) -> bool:
        """Run one countdown / recording / rest phase with status ticks. False if stopped early."""
        loop = asyncio.get_running_loop()
        t0 = loop.time()
        while True:
            elapsed = loop.time() - t0
            remaining = None if seconds is None else max(0.0, seconds - elapsed)
            self._set_status(state=state, label=plan.label or "data", team=plan.team or "unknown",
                             take=k, of=plan.repeat, remaining=remaining, elapsed=round(elapsed, 2),
                             duration=plan.duration, uids=plan.uids)
            if remaining is not None and remaining <= 0:
                return True
            wait = STATUS_PERIOD if remaining is None else min(STATUS_PERIOD, remaining)
            try:
                await asyncio.wait_for(self._stop_evt.wait(), wait)
                return False
            except asyncio.TimeoutError:
                pass

    async def _run_takes(self, plan: TakePlan) -> None:
        all_files: list[str] = []
        try:
            for k in range(1, plan.repeat + 1):
                if plan.countdown > 0 and not await self._phase("countdown", plan.countdown, k, plan):
                    break
                rows = {u: self.rows[u] for u in plan.uids if u in self.rows}
                if not rows:
                    self._send_all({"type": "error", "message": "the streams to record went away"})
                    break
                self.recorder.begin(plan.team, plan.label, rows)
                finished = await self._phase("recording", plan.duration, k, plan)
                files = await self._save()
                all_files += files
                self._send_all({"type": "saved", "files": files, "take": k, "of": plan.repeat})
                if not finished:
                    break
                if k < plan.repeat and plan.rest > 0 and not await self._phase("rest", plan.rest, k, plan):
                    break
        finally:
            if self.recorder.take is not None:  # cancelled mid-take (shutdown): still save what we have
                self.recorder.end()
                all_files += await asyncio.to_thread(self.recorder.finish)
            self._plan = None
            self._set_status(state="done", label=plan.label or "data", team=plan.team or "unknown",
                             take=plan.repeat, of=plan.repeat, files=len(all_files))
            self._sync_readers()

    async def _save(self) -> list[str]:
        self.recorder.end()
        self._set_status(**{**{k: v for k, v in self.status.items() if k != "type"}, "state": "saving"})
        await asyncio.sleep(STOP_GRACE_SEC)
        try:
            return await asyncio.to_thread(self.recorder.finish)
        except OSError as e:
            self._send_all({"type": "error", "message": f"could not save: {e}"})
            return []

    # ------------------------------------------------------------------ lifecycle
    def _process_request(self, connection: Any, request: Any) -> Any:
        return self.site.handle(request)

    def serve(self) -> Any:
        """The websockets server (an async context manager). Discovery starts with `start_discovery`."""
        return serve(self.handler, self.host, self.port, max_size=2**20,
                     process_request=self._process_request)

    def start_discovery(self, period: float = 1.0) -> None:
        self.discovery = Discovery(asyncio.get_running_loop(), self.on_streams, period=period)
        self.discovery.start()

    async def close(self) -> None:
        if self._take_task is not None and not self._take_task.done():
            self._stop_evt.set()
            try:
                await asyncio.wait_for(self._take_task, 5)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                pass
        for r in self.readers.values():
            r.stop()
        if self.discovery:
            self.discovery.stop()
        for r in self.readers.values():
            r.join(timeout=1)
        self.readers.clear()

    async def run_forever(self, ready: Any = None) -> None:
        async with self.serve():
            self.start_discovery()
            if ready is not None:
                ready()
            try:
                await asyncio.Future()
            finally:
                await self.close()
