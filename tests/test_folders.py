"""Save folder: startup precedence, validation, Change… (native dialog, stubbed) and typed paths over the
WebSocket, persistence, and the same-origin check that keeps other websites off the socket."""
import json
from pathlib import Path

import pytest
import websockets

from lsl_web_viewer import folders
from lsl_web_viewer.loader import load_recording

from .conftest import page


def test_initial_dir_precedence(tmp_path):
    assert folders.initial_dir(None) == folders.DEFAULT_DIR           # nothing remembered → ./data
    folders.remember_dir(tmp_path / "remembered")
    assert folders.initial_dir(None) == tmp_path / "remembered"       # remembered beats the default
    assert folders.initial_dir(str(tmp_path / "cli")) == tmp_path / "cli"   # --data-dir beats both
    assert json.loads(folders.config_path().read_text())["data_dir"] == str(tmp_path / "remembered")


def test_validate_dir(tmp_path):
    with pytest.raises(ValueError):
        folders.validate_dir("relative/path")
    d = folders.validate_dir(str(tmp_path / "new" / "deeper"))
    assert d.is_dir() and not any(d.iterdir())                        # created, probe file cleaned up


async def test_set_folder_moves_takes_and_is_remembered(viewer, publish, uniq, tmp_path):
    name = f"FolderEMG_{uniq}"
    publish(name, "EMG", 2, 200.0)
    target = tmp_path / "picked here"
    async with page(viewer) as p:
        hello = await p.until(lambda: p.of("hello"))
        assert hello[0]["data_dir"] == str((tmp_path / "data").resolve())
        await p.send(type="set_folder", path=str(target))
        folder = await p.until(lambda: p.of("folder"))
        assert folder[-1]["data_dir"] == str(target.resolve())
        uid = await p.stream_uid(name)
        await p.send(type="subscribe", uids=[uid])
        await p.send(type="record_start", label="fist", team="t1", duration=0.5)
        saved = await p.until(lambda: p.of("saved"), timeout=15)
    path = Path(saved[0]["files"][0])
    assert path.parent == target.resolve() / "t1"
    meta, data = load_recording(path)
    assert meta["label"] == "fist" and len(data) > 50
    assert folders.remembered_dir() == target.resolve()


async def test_set_folder_rejects_relative_paths_and_changes_while_recording(viewer, publish, uniq, tmp_path):
    name = f"BusyEMG_{uniq}"
    publish(name, "EMG", 1, 100.0)
    async with page(viewer) as p:
        await p.send(type="set_folder", path="not/absolute")
        err = await p.until(lambda: p.of("error"))
        assert "full folder path" in err[-1]["message"]
        uid = await p.stream_uid(name)
        await p.send(type="subscribe", uids=[uid])
        await p.send(type="record_start", label="x", duration=2.0)
        await p.until(lambda: any(s["state"] == "recording" for s in p.of("rec_status")))
        await p.send(type="set_folder", path=str(tmp_path / "elsewhere"))
        await p.until(lambda: any("stop recording" in e["message"] for e in p.of("error")))
        await p.send(type="record_stop")
    assert not (tmp_path / "elsewhere").exists()


async def test_choose_folder_uses_the_native_dialog(viewer, tmp_path, monkeypatch):
    picks = iter([tmp_path / "from dialog", None])                    # first a folder, then Cancel
    monkeypatch.setattr(folders, "choose_folder", lambda start: next(picks))
    async with page(viewer) as p:
        await p.until(lambda: p.of("hello"))
        await p.send(type="choose_folder")
        f = await p.until(lambda: p.of("folder"))
        assert f[-1]["data_dir"] == str((tmp_path / "from dialog").resolve())
        await p.send(type="choose_folder")                            # cancelled: nothing changes
        await p.until(lambda: not viewer._choosing)
        assert len(p.of("folder")) == 1 and not p.of("error")


async def test_choose_folder_without_a_dialog_asks_for_a_typed_path(viewer, monkeypatch):
    def none(start):
        raise folders.NoDialog("no folder dialog available on this computer")
    monkeypatch.setattr(folders, "choose_folder", none)
    async with page(viewer) as p:
        await p.until(lambda: p.of("hello"))
        await p.send(type="choose_folder")
        err = await p.until(lambda: p.of("error"))
        assert err[-1]["no_dialog"] is True


@pytest.mark.parametrize("origin, ok", [
    (None, True),                              # Python scripts / tests: no Origin header
    ("http://127.0.0.1:{port}", True),         # the tool's own page
    ("http://localhost:5180", True),           # `npm run dev`
    ("https://evil.example", False),           # any other website open in the same browser
    ("http://192.168.1.50:8770", False),       # another machine's page (unless it's this server's Host)
])
async def test_only_same_origin_pages_may_connect(viewer, origin, ok):
    url = f"ws://127.0.0.1:{viewer.port}/ws"
    kw = {"origin": origin.format(port=viewer.port)} if origin else {}
    if ok:
        async with websockets.connect(url, **kw) as ws:
            assert json.loads(await ws.recv())["type"] == "hello"
    else:
        with pytest.raises(websockets.InvalidStatus) as e:
            async with websockets.connect(url, **kw):
                pass
        assert e.value.response.status_code == 403
