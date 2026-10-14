"""Stream discovery (runs in a thread, because pylsl is blocking).

A `pylsl.ContinuousResolver` watches the network for every LSL stream. Once a second the current table
is handed to the event loop (`on_streams`), so the page sees streams appear and disappear. The
resolver only returns each stream's short header, so the first time a uid is seen we open a throwaway
inlet to fetch the full header and read the channel labels from <desc><channels><channel><label>.
"""
from __future__ import annotations

import asyncio
import logging
import threading
from typing import Any, Callable

log = logging.getLogger("lsl_web_viewer")

FORMATS = {1: "float32", 2: "double64", 3: "string", 4: "int32", 5: "int16", 6: "int8", 7: "int64"}
StreamRow = dict[str, Any]


def channel_labels(info: Any) -> list[str]:
    """Labels from the stream's <desc><channels><channel><label>, else ch1..chN."""
    n = info.channel_count()
    labels: list[str] = []
    try:
        ch = info.desc().child("channels").child("channel")
        while not ch.empty() and len(labels) < n:
            labels.append(ch.child_value("label").strip())
            ch = ch.next_sibling()
    except Exception:  # a malformed desc never stops discovery
        labels = []
    if len(labels) != n or not all(labels):
        return [f"ch{i + 1}" for i in range(n)]
    return labels


def describe(info: Any) -> StreamRow:
    """The row the page sees for one stream (also the metadata the recorder writes)."""
    return {
        "uid": info.uid(),
        "name": info.name(),
        "type": info.type(),
        "channels": info.channel_count(),
        "srate": info.nominal_srate(),
        "fmt": FORMATS.get(info.channel_format(), str(info.channel_format())),
        "hostname": info.hostname(),
        "source_id": info.source_id(),
        "channel_labels": channel_labels(info),
    }


class Discovery(threading.Thread):
    """Publishes the stream table every `period` seconds; keeps each stream's StreamInfo for inlets."""

    def __init__(self, loop: asyncio.AbstractEventLoop, on_streams: Callable[[list[StreamRow]], None],
                 period: float = 1.0, forget_after: float = 3.0):
        super().__init__(name="lsl-discovery", daemon=True)
        self.loop, self.on_streams = loop, on_streams
        self.period, self.forget_after = period, forget_after
        self._halt = threading.Event()
        self._lock = threading.Lock()
        self.infos: dict[str, Any] = {}   # uid → the resolver's pylsl.StreamInfo (for opening inlets)
        self.rows: dict[str, StreamRow] = {}

    def stop(self) -> None:
        self._halt.set()

    def info(self, uid: str) -> Any | None:
        with self._lock:
            return self.infos.get(uid)

    def table(self) -> list[StreamRow]:
        with self._lock:
            return sorted(self.rows.values(), key=lambda r: (r["name"].lower(), r["hostname"], r["uid"]))

    def _full_info(self, short: Any) -> Any:
        import pylsl

        try:
            inlet = pylsl.StreamInlet(short, max_buflen=1, recover=False)
            try:
                return inlet.info(timeout=2.0)
            finally:
                inlet.close_stream()
                del inlet
        except Exception as e:  # unreachable host, timeout: fall back to the short header
            log.debug("could not fetch the full header of %s: %s", short.name(), e)
            return short

    def run(self) -> None:
        import pylsl

        resolver = pylsl.ContinuousResolver(forget_after=self.forget_after)
        while not self._halt.is_set():
            seen: dict[str, Any] = {}
            for short in resolver.results():
                seen[short.uid()] = short
            new = [u for u in seen if u not in self.infos]
            for uid in new:
                full = self._full_info(seen[uid])
                row = describe(full)
                with self._lock:  # inlets open from the resolver's info: the full header lacks its endpoints
                    self.infos[uid], self.rows[uid] = seen[uid], row
                log.info("LSL: found %s (%s, %d ch @ %g Hz) on %s", row["name"], row["type"],
                         row["channels"], row["srate"], row["hostname"])
            with self._lock:
                for uid in [u for u in self.infos if u not in seen]:
                    log.info("LSL: %s went away", self.rows[uid]["name"])
                    del self.infos[uid], self.rows[uid]
            table = self.table()
            try:
                self.loop.call_soon_threadsafe(self.on_streams, table)
            except RuntimeError:  # the event loop already closed (shutting down)
                return
            self._halt.wait(self.period)
