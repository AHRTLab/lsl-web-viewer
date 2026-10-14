"""Discovery over pylsl loopback: streams appear with full metadata (incl. channel labels) and disappear."""
import asyncio

from lsl_web_viewer.discovery import Discovery


async def wait_for(pred, timeout=15.0):
    async with asyncio.timeout(timeout):
        while not (v := pred()):
            await asyncio.sleep(0.05)
        return v


async def test_stream_appears_with_metadata_and_labels(publish, uniq):
    tables: list[list[dict]] = []
    d = Discovery(asyncio.get_running_loop(), tables.append, period=0.2)
    d.start()
    try:
        name = f"PyEMG_{uniq}"
        labeled = publish(name, "EMG", 3, 250.0, labels=["flex", "ext", "grip"])
        plain = publish(f"PyRaw_{uniq}", "Misc", 2, 100.0)
        find = lambda n: next((r for t in reversed(tables[-1:]) for r in t if r["name"] == n), None)  # noqa: E731
        row = await wait_for(lambda: find(name))
        assert row["type"] == "EMG" and row["channels"] == 3 and row["srate"] == 250.0
        assert row["fmt"] == "float32" and row["source_id"] == f"pytest-{name}"
        assert row["channel_labels"] == ["flex", "ext", "grip"]
        assert row["uid"] == labeled.outlet.get_info().uid() and row["hostname"]
        raw = await wait_for(lambda: find(f"PyRaw_{uniq}"))
        assert raw["channel_labels"] == ["ch1", "ch2"]
        assert d.info(row["uid"]) is not None

        plain.stop()
        del plain.outlet  # destroying the outlet takes the stream off the network
        await wait_for(lambda: tables and find(f"PyRaw_{uniq}") is None, timeout=20)
    finally:
        d.stop()
        d.join(timeout=3)
