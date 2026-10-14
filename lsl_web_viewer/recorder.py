"""Server-side, full-rate recording of labeled takes.

Every StreamReader feeds every chunk to `Recorder.feed()`; while a take is open the recorder keeps the
samples whose (clock-corrected) LSL timestamp falls inside [start, stop). Cutting by timestamp instead of
by arrival time means a 2 s take holds 2 s of samples even though network delivery is bursty; the
grace period after stop lets the last in-flight chunks arrive before the file is written.

Files: <data-dir>/<team>/<label>_<YYYYmmdd_HHMMSS>.csv, or …_<stream>.csv when a take records more
than one stream. The header matches the BioRadio data-collection GUI (plus `# stream:` / `# lsl_uid:`),
so `lsl_web_viewer.load_recording()` reads both tools' files.

An LSL marker outlet `LslWebViewerMarkers` (type Markers) announces `record_start:<label>` and
`record_stop:<label>` at the take's exact start / stop timestamps, so a LabRecorder XDF recorded in
parallel carries the labels too.
"""
from __future__ import annotations

import csv
import logging
import re
import socket
import threading
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

log = logging.getLogger("lsl_web_viewer")

MARKER_STREAM = "LslWebViewerMarkers"
STOP_GRACE_SEC = 0.35  # wait this long after a take ends for late chunks before writing


def safe_part(text: str, default: str) -> str:
    """A filename-safe version of a team / label / stream name (spaces → _, no path separators)."""
    text = (text or "").strip() or default
    text = text.replace(" ", "_")
    return re.sub(r"[^\w.\-+=@]", "_", text).strip(".") or default


@dataclass
class _Track:
    row: dict[str, Any]
    t: list[float] = field(default_factory=list)
    x: list[list[Any]] = field(default_factory=list)


@dataclass
class Take:
    team: str
    label: str
    rows: dict[str, dict[str, Any]]          # uid → stream row (discovery.describe)
    start: float                             # LSL local_clock()
    wall: datetime
    stop: float | None = None
    tracks: dict[str, _Track] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.tracks = {uid: _Track(row) for uid, row in self.rows.items()}


class MarkerOutlet:
    """The LslWebViewerMarkers outlet (created lazily; recording works without it if LSL fails)."""

    def __init__(self, source_id: str | None = None) -> None:
        self._outlet: Any = None
        try:
            import pylsl

            info = pylsl.StreamInfo(MARKER_STREAM, "Markers", 1, pylsl.IRREGULAR_RATE, pylsl.cf_string,
                                    source_id or f"lsl-web-viewer@{socket.gethostname()}")
            info.desc().append_child_value("application", "lsl-web-viewer")
            self._outlet = pylsl.StreamOutlet(info)
        except Exception as e:
            log.warning("could not create the %s outlet: %s", MARKER_STREAM, e)

    def push(self, text: str, timestamp: float) -> None:
        if self._outlet is not None:
            self._outlet.push_sample([text], timestamp)


class Recorder:
    def __init__(self, data_dir: str | Path, markers: bool = True, marker_source_id: str | None = None):
        self.data_dir = Path(data_dir).expanduser()
        self._lock = threading.Lock()
        self.take: Take | None = None
        self.markers = MarkerOutlet(marker_source_id) if markers else None

    @staticmethod
    def now() -> float:
        import pylsl

        return pylsl.local_clock()

    # -------------------------------------------------------------- called from inlet threads
    def feed(self, uid: str, timestamps: list[float], samples: list[list[Any]]) -> None:
        take = self.take
        if take is None:
            return
        with self._lock:
            tr = take.tracks.get(uid)
            if tr is None:
                return
            hi = take.stop if take.stop is not None else float("inf")
            for ts, s in zip(timestamps, samples):
                if take.start <= ts < hi:
                    tr.t.append(ts)
                    tr.x.append(list(s))

    # -------------------------------------------------------------- called from the event loop
    def begin(self, team: str, label: str, rows: dict[str, dict[str, Any]]) -> Take:
        if self.take is not None:
            raise RuntimeError("a take is already recording")
        start = self.now()
        take = Take(team=safe_part(team, "unknown"), label=safe_part(label, "data"), rows=rows,
                    start=start, wall=datetime.now())
        with self._lock:
            self.take = take
        if self.markers:
            self.markers.push(f"record_start:{take.label}", start)
        log.info("recording '%s' (team %s): %s", take.label, take.team, ", ".join(r["name"] for r in rows.values()))
        return take

    def end(self) -> Take | None:
        """Close the take's time window (samples already in flight are still accepted until `finish`)."""
        take = self.take
        if take is None or take.stop is not None:
            return take
        take.stop = self.now()
        if self.markers:
            self.markers.push(f"record_stop:{take.label}", take.stop)
        return take

    def finish(self) -> list[str]:
        """Write the take's files (call STOP_GRACE_SEC after `end`). Returns the paths written."""
        with self._lock:
            take, self.take = self.take, None
        if take is None:
            return []
        return write_take(take, self.data_dir)


def write_take(take: Take, data_dir: Path) -> list[str]:
    subdir = data_dir / take.team
    subdir.mkdir(parents=True, exist_ok=True)
    ts_str = take.wall.strftime("%Y%m%d_%H%M%S")
    duration = (take.stop or take.start) - take.start
    multi = len(take.tracks) > 1
    paths: list[str] = []
    for uid, tr in take.tracks.items():
        row = tr.row
        stem = f"{take.label}_{ts_str}" + (f"_{safe_part(row['name'], 'stream')}" if multi else "")
        path = subdir / f"{stem}.csv"
        k = 2
        while path.exists():  # two takes inside the same second (short takes, no rest)
            path = subdir / f"{stem}_{k}.csv"
            k += 1
        channels = list(row["channel_labels"])
        numeric = row["fmt"] != "string"
        with open(path, "w", newline="") as f:
            writer = csv.writer(f)
            f.write(f"# team: {take.team}\n")
            f.write(f"# label: {take.label}\n")
            f.write(f"# timestamp: {ts_str}\n")
            f.write(f"# sample_rate: {row['srate']}\n")
            f.write(f"# samples: {len(tr.t)}\n")
            f.write(f"# duration_sec: {duration:.3f}\n")
            f.write(f"# channels: {','.join(channels)}\n")
            f.write(f"# stream: {row['name']}\n")
            f.write(f"# lsl_uid: {uid}\n")
            f.write("#\n")
            writer.writerow(["timestamp"] + channels)
            for ts, s in zip(tr.t, tr.x):
                writer.writerow([float(ts)] + ([float(v) for v in s] if numeric else [str(v) for v in s]))
        log.info("saved %d samples (%.1f s) of %s to %s", len(tr.t), duration, row["name"], path)
        paths.append(str(path))
    return paths
