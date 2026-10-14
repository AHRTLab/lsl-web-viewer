"""Display decimation, and subscribe → decimated data over a real WebSocket."""
import numpy as np

from lsl_web_viewer.inlets import data_message, envelope

from .conftest import page


def test_envelope_passthrough_and_minmax():
    t = np.arange(10.0)
    x = np.arange(20.0).reshape(10, 2)
    t2, x2 = envelope(t, x, 20)
    assert t2 is t and x2 is x  # fits: unchanged

    t = np.linspace(0, 1, 1000, endpoint=False)
    x = np.stack([np.sin(2 * np.pi * 7 * t), np.zeros_like(t)], axis=1)
    x[503, 1] = 9.0  # a one-sample spike must survive decimation
    t2, x2 = envelope(t, x, 40)
    assert len(t2) <= 40 and x2.shape == (len(t2), 2)
    assert np.all(np.diff(t2) >= 0)
    assert x2[:, 1].max() == 9.0
    assert np.isclose(x2[:, 0].max(), x[:, 0].max()) and np.isclose(x2[:, 0].min(), x[:, 0].min())


def test_data_message_is_channel_major_json():
    import json

    m = json.loads(data_message("u1", np.array([1.0, 2.0]), np.array([[1.0, 10.0], [2.0, float("nan")]])))
    assert m == {"type": "data", "uid": "u1", "t": [1.0, 2.0], "x": [[1.0, 2.0], [10.0, None]]}


async def test_subscribe_streams_decimated_data(viewer, publish, uniq):
    name = f"WsEMG_{uniq}"
    publish(name, "EMG", 4, 2000.0)  # above the 600 points/s display budget → must be decimated
    publish(f"WsMk_{uniq}", "Markers", 1, string=True)
    async with page(viewer) as p:
        assert p.of("hello") or await p.until(lambda: p.of("hello"))
        uid = await p.stream_uid(name)
        mk = await p.stream_uid(f"WsMk_{uniq}")
        await p.send(type="subscribe", uids=[uid, mk])
        await p.until(lambda: sum(len(m["t"]) for m in p.of("data") if m["uid"] == uid) > 600, timeout=20)
        first = next(m for m in p.of("data") if m["uid"] == uid)
        t0 = first["t"][0]
        await __import__("asyncio").sleep(2.0)
        msgs = [m for m in p.of("data") if m["uid"] == uid and m["t"][0] >= t0]
        points = sum(len(m["t"]) for m in msgs)
        span = msgs[-1]["t"][-1] - t0
        assert len(first["x"]) == 4 and all(len(c) == len(first["t"]) for c in first["x"])
        assert points / span <= 600 * 1.25, f"{points / span:.0f} points/s"  # decimated (raw is 2000/s)
        assert len(msgs) / span > 15  # ~30 Hz batches
        await p.until(lambda: any(m["uid"] == mk and m["values"][0].startswith("m") for m in p.of("markers")))
        assert viewer.readers[uid].samples_in > 3000  # the reader itself sees the full rate

        await p.send(type="subscribe", uids=[])
        await p.until(lambda: not viewer.readers)  # unsubscribing closes the inlets
