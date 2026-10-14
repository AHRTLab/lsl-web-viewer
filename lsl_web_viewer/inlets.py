"""One inlet thread per subscribed stream.

Each `StreamReader` pulls chunks from its LSL inlet and splits them two ways:

  full rate → `Recorder.feed()` (the recorder keeps only the samples inside an active take)
  display   → batched at ~30 Hz and decimated to at most `max_rate` points/s/channel with a min/max
              envelope (each bin contributes its min and its max, so spikes survive decimation),
              then handed to the event loop as a ready-to-send `data` JSON message.

String streams (markers) are forwarded immediately as `markers` messages, never decimated.
Timestamps are LSL clock-corrected (`proc_clocksync`), so streams from other machines line up with this
machine's `pylsl.local_clock()`, which the recorder uses to cut takes. If the outlet goes away the
inlet is reopened once a second until the reader is stopped (discovery unsubscribes vanished streams).
"""
from __future__ import annotations

import asyncio
import logging
import math
import threading
import time
from typing import Any, Callable, Protocol

import numpy as np

log = logging.getLogger("lsl_web_viewer")

DISPLAY_HZ = 30.0
MAX_POINTS_PER_SEC = 600.0


class SampleSink(Protocol):
    def feed(self, uid: str, timestamps: list[float], samples: list[list[Any]]) -> None: ...


# ------------------------------------------------------------------------------------- decimation
def envelope(t: np.ndarray, x: np.ndarray, budget: int) -> tuple[np.ndarray, np.ndarray]:
    """Decimate one batch to at most `budget` points per channel with a min/max envelope.

    t: (n,) timestamps; x: (n, ch) samples. Returns (t2, x2) with x2 shaped (m, ch), m <= budget.
    A batch that already fits is returned unchanged. Otherwise the batch is cut into budget//2 bins and
    each bin contributes two points: its per-channel minimum (at the bin's first timestamp) and maximum
    (at its last timestamp).
    """
    n = len(t)
    budget = max(int(budget), 2)
    if n <= budget:
        return t, x
    bins = budget // 2
    size = math.ceil(n / bins)
    bins = math.ceil(n / size)
    pad = bins * size - n
    xp = np.concatenate([x, np.repeat(x[-1:], pad, axis=0)]) if pad else x  # repeat the last sample
    blocks = xp.reshape(bins, size, x.shape[1])
    lo, hi = np.nanmin(blocks, axis=1), np.nanmax(blocks, axis=1)
    starts = np.arange(bins) * size
    ends = np.minimum(starts + size, n) - 1
    t2 = np.empty(2 * bins)
    t2[0::2], t2[1::2] = t[starts], t[ends]
    x2 = np.empty((2 * bins, x.shape[1]))
    x2[0::2], x2[1::2] = lo, hi
    return t2, x2


def _nums(values: np.ndarray, fmt: str) -> str:
    """A JSON array of numbers (non-finite values become null), compactly formatted."""
    return "[" + ",".join(fmt % v if math.isfinite(v) else "null" for v in values.tolist()) + "]"


def data_message(uid: str, t: np.ndarray, x: np.ndarray) -> str:
    """{"type":"data","uid":…,"t":[…],"x":[[ch1…],[ch2…],…]}: x is channel-major (x[ch][i] ↔ t[i])."""
    import json

    chans = ",".join(_nums(x[:, c], "%.7g") for c in range(x.shape[1]))
    return f'{{"type":"data","uid":{json.dumps(uid)},"t":{_nums(t, "%.6f")},"x":[{chans}]}}'


# ------------------------------------------------------------------------------------- reader thread
class StreamReader(threading.Thread):
    def __init__(self, info: Any, row: dict[str, Any], loop: asyncio.AbstractEventLoop,
                 send: Callable[[str, str], None], sink: SampleSink | None = None,
                 display_hz: float = DISPLAY_HZ, max_rate: float = MAX_POINTS_PER_SEC):
        super().__init__(name=f"lsl-inlet-{row['name']}", daemon=True)
        self.info, self.row, self.loop = info, row, loop
        self.uid: str = row["uid"]
        self.send = send  # send(uid, json_text) on the event loop
        self.sink = sink
        self.is_string = row["fmt"] == "string"
        self.display_period, self.max_rate = 1.0 / display_hz, max_rate
        self._halt = threading.Event()
        self.samples_in = 0

    def stop(self) -> None:
        self._halt.set()

    def _post(self, text: str) -> None:
        try:
            self.loop.call_soon_threadsafe(self.send, self.uid, text)
        except RuntimeError:  # loop closed during shutdown
            self._halt.set()

    def _open(self) -> Any | None:
        import pylsl

        try:
            inlet = pylsl.StreamInlet(self.info, max_buflen=60, recover=True,
                                      processing_flags=pylsl.proc_clocksync)
            inlet.open_stream(timeout=2.0)
            log.info("LSL: subscribed to %s", self.row["name"])
            return inlet
        except Exception as e:
            log.info("LSL: could not open %s (%s); retrying", self.row["name"], e)
            return None

    def run(self) -> None:
        import json

        import pylsl

        inlet = None
        pend_t: list[float] = []
        pend_x: list[list[float]] = []
        last_flush = time.monotonic()
        try:
            while not self._halt.is_set():
                if inlet is None:
                    inlet = self._open()
                    if inlet is None:
                        self._halt.wait(1.0)
                        continue
                try:
                    samples, stamps = inlet.pull_chunk(timeout=0.02, max_samples=8192)
                except pylsl.LostError:
                    log.info("LSL: lost %s; waiting for it to come back", self.row["name"])
                    inlet = None
                    self._halt.wait(1.0)
                    continue
                if samples:
                    self.samples_in += len(samples)
                    if self.sink is not None:
                        self.sink.feed(self.uid, stamps, samples)
                    if self.is_string:
                        values = [", ".join(str(v) for v in s) for s in samples]
                        self._post(json.dumps({"type": "markers", "uid": self.uid,
                                               "t": [round(s, 6) for s in stamps], "values": values}))
                    else:
                        pend_t.extend(stamps)
                        pend_x.extend(samples)
                now = time.monotonic()
                if pend_t and now - last_flush >= self.display_period:
                    budget = max(2, int(self.max_rate * (now - last_flush)))
                    t2, x2 = envelope(np.asarray(pend_t, dtype=float), np.asarray(pend_x, dtype=float), budget)
                    self._post(data_message(self.uid, t2, x2))
                    pend_t, pend_x, last_flush = [], [], now
                elif not pend_t:
                    last_flush = now
        finally:
            if inlet is not None:
                try:
                    inlet.close_stream()
                except Exception:
                    pass
            log.info("LSL: unsubscribed from %s", self.row["name"])
