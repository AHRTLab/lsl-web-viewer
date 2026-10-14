"""Recording: full-rate CSV takes in the BioRadio GUI format, the marker outlet, and timed repeats."""
import asyncio
import socket
from pathlib import Path

import numpy as np
import pylsl

from lsl_web_viewer import load_recording
from lsl_web_viewer.recorder import MARKER_STREAM, safe_part

from .conftest import page

BIORADIO_SAMPLE = """# team: team 7
# label: fist
# timestamp: 20260301_101500
# sample_rate: 250
# samples: 3
# duration_sec: 0.012
# channels: EMG1,EMG2
#
timestamp,EMG1,EMG2\r
1.0,0.5,-0.5\r
1.004,0.25,-0.25\r
1.008,0.0,0.0\r
"""


def test_loader_reads_a_bioradio_gui_file(tmp_path):
    f = tmp_path / "fist_20260301_101500.csv"
    f.write_text(BIORADIO_SAMPLE, newline="")
    meta, data = load_recording(f)
    assert meta["team"] == "team 7" and meta["label"] == "fist" and meta["sample_rate"] == 250.0
    assert meta["samples"] == 3 and meta["channels"] == ["EMG1", "EMG2"]
    assert meta["columns"] == ["timestamp", "EMG1", "EMG2"]
    assert data.shape == (3, 3) and data.dtype == float and data[1, 1] == 0.25


def test_safe_part():
    assert safe_part("  team 7 ", "unknown") == "team_7"
    assert safe_part("", "unknown") == "unknown"
    assert safe_part("../../etc", "x") == "_.._etc"


async def test_two_second_take_writes_full_rate_csv_and_markers(viewer, publish, uniq, tmp_path):
    name = f"RecEMG_{uniq}"
    publish(name, "EMG", 3, 500.0, labels=["a", "b", "c"])
    # Watch the viewer's own marker outlet, as LabRecorder would.
    sid = f"lsl-web-viewer@{socket.gethostname()}:{viewer.port}"
    found = await asyncio.to_thread(pylsl.resolve_bypred, f"name='{MARKER_STREAM}' and source_id='{sid}'", 1, 10)
    assert found, "marker outlet not found"
    marker_inlet = pylsl.StreamInlet(found[0])
    await asyncio.to_thread(marker_inlet.open_stream, 5)

    async with page(viewer) as p:
        uid = await p.stream_uid(name)
        await p.send(type="subscribe", uids=[uid])
        await p.until(lambda: p.of("data"))
        await p.send(type="record_start", label="open hand", team="team 7", duration=2.0)
        await p.until(lambda: any(s["state"] == "recording" for s in p.of("rec_status")))
        saved = await p.until(lambda: p.of("saved"), timeout=15)
        await p.until(lambda: p.of("rec_status")[-1]["state"] == "done")

    files = saved[0]["files"]
    assert len(files) == 1
    path = Path(files[0])
    assert path.parent == tmp_path / "data" / "team_7" and path.name.startswith("open_hand_")
    assert path.suffix == ".csv" and name not in path.name  # one stream → no stream suffix
    head = path.read_text().splitlines()[:11]
    assert [h.split(":")[0] for h in head[:10]] == ["# team", "# label", "# timestamp", "# sample_rate",
                                                     "# samples", "# duration_sec", "# channels", "# stream",
                                                     "# lsl_uid", "#"]
    assert head[10] == "timestamp,a,b,c"
    meta, data = load_recording(path)
    assert meta["team"] == "team_7" and meta["label"] == "open_hand" and meta["stream"] == name
    assert meta["lsl_uid"] == uid and meta["channels"] == ["a", "b", "c"] and meta["sample_rate"] == 500.0
    assert abs(meta["duration_sec"] - 2.0) < 0.3
    assert data.shape[1] == 4 and meta["samples"] == len(data)
    assert 900 <= len(data) <= 1100, len(data)  # 2 s × 500 Hz, ±10 %
    assert np.all(np.diff(data[:, 0]) > 0)

    markers, stamps = await asyncio.to_thread(marker_inlet.pull_chunk, 2.0)
    values = [m[0] for m in markers]
    assert values == ["record_start:open_hand", "record_stop:open_hand"]
    assert abs((stamps[1] - stamps[0]) - meta["duration_sec"]) < 0.05


async def test_timed_takes_repeat_two_streams(viewer, publish, uniq, tmp_path):
    a, b = f"RepA_{uniq}", f"RepB_{uniq}"
    publish(a, "EMG", 2, 200.0)
    publish(b, "IMU", 4, 50.0)
    async with page(viewer) as p:
        ua, ub = await p.stream_uid(a), await p.stream_uid(b)
        await p.send(type="record_start", label="wave", team="", uids=[ua, ub],
                     duration=0.6, countdown=0.4, repeat=2, rest=0.5)
        await p.until(lambda: len(p.of("saved")) == 2, timeout=20)
        states = [s["state"] for s in p.of("rec_status")]
        await p.until(lambda: p.of("rec_status")[-1]["state"] == "done")
    for s in ("countdown", "recording", "rest"):
        assert s in states
    assert {(s["take"], s["of"]) for s in p.of("rec_status") if s["state"] == "recording"} == {(1, 2), (2, 2)}
    files = [f for m in p.of("saved") for f in m["files"]]
    assert len(files) == 4
    names = [Path(f).name for f in files]
    assert sum(a in n for n in names) == 2 and sum(b in n for n in names) == 2
    assert all(Path(f).parent == tmp_path / "data" / "unknown" for f in files)
    for f in files:
        meta, data = load_recording(f)
        assert meta["label"] == "wave" and len(data) > 0


async def test_manual_take_and_stop(viewer, publish, uniq):
    name = f"Man_{uniq}"
    publish(name, "Misc", 1, 100.0)
    async with page(viewer) as p:
        uid = await p.stream_uid(name)
        await p.send(type="subscribe", uids=[uid])
        await p.send(type="record_start", label="rest")  # no duration → manual
        await p.until(lambda: any(s["state"] == "recording" for s in p.of("rec_status")))
        await p.send(type="record_start", label="again")
        await p.until(lambda: p.of("error"))  # only one take at a time
        await asyncio.sleep(1.0)
        await p.send(type="record_stop")
        saved = await p.until(lambda: p.of("saved"))
    meta, data = load_recording(saved[0]["files"][0])
    assert meta["label"] == "rest" and 70 <= len(data) <= 160


async def test_record_without_streams_is_an_error(viewer):
    async with page(viewer) as p:
        await p.until(lambda: p.of("hello"))
        await p.send(type="record_start", label="x")
        err = await p.until(lambda: p.of("error"))
        assert "subscribe" in err[0]["message"]
