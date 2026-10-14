"""Read a recording CSV back into Python.

The format is shared with the BioRadio data-collection GUI, so one loader reads both tools' files:

    # team: <team>
    # label: <label>
    # timestamp: <YYYYmmdd_HHMMSS>
    # sample_rate: <Hz>
    # samples: <n>
    # duration_sec: <s>
    # channels: <ch1>,<ch2>,...
    # stream: <LSL stream name>        (lsl-web-viewer only)
    # lsl_uid: <LSL stream uid>        (lsl-web-viewer only)
    #
    timestamp,<ch1>,<ch2>,...
    <t>,<v1>,<v2>,...

    meta, data = load_recording("data/team1/fist_20260101_120000.csv")
    data[:, 0]   # timestamps;  data[:, 1:] the channels, in meta["channels"] order
"""
from __future__ import annotations

import csv
from pathlib import Path
from typing import Any

import numpy as np

_NUMERIC_META = {"sample_rate": float, "samples": int, "duration_sec": float}


def load_recording(path: str | Path) -> tuple[dict[str, Any], np.ndarray]:
    """Return (metadata, data). `data` has one row per sample: [timestamp, ch1, ch2, ...].

    Metadata values are strings except sample_rate / duration_sec (float), samples (int) and channels
    (a list). meta["columns"] is the CSV header row. Numeric files give a float64 array; files with
    text values (marker streams) give an object array of strings with a float timestamp column.
    """
    meta: dict[str, Any] = {}
    rows: list[list[str]] = []
    with open(path, newline="") as f:
        lines = iter(f)
        for line in lines:
            if not line.startswith("#"):
                header = next(csv.reader([line]))
                break
            key, sep, value = line[1:].strip().partition(":")
            if not sep:
                continue  # the bare "#" separator line
            key, value = key.strip(), value.strip()
            if key in _NUMERIC_META:
                try:
                    meta[key] = _NUMERIC_META[key](value)
                except ValueError:
                    meta[key] = value
            elif key == "channels":
                meta[key] = value.split(",") if value else []
            else:
                meta[key] = value
        else:
            header = []
        rows = [r for r in csv.reader(lines) if r]
    meta["columns"] = header
    if not rows:
        return meta, np.empty((0, len(header)))
    try:
        data = np.array(rows, dtype=float)
    except ValueError:  # string (marker) stream: keep text, but make the timestamps numbers
        data = np.array(rows, dtype=object)
        data[:, 0] = data[:, 0].astype(float)
    return meta, data
