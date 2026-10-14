"""The server serves its own page on the WebSocket port (same origin), safely."""
import asyncio
import json
import socket
import urllib.error
import urllib.request

import pytest
import websockets

from lsl_web_viewer.server import ViewerServer
from lsl_web_viewer.site import SERVED_META, STATIC_DIR, SiteServer

INDEX = b"<!doctype html>\n<html><head><title>LSL Web Viewer</title></head><body>viewer</body></html>\n"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def site_dir(tmp_path):
    root = tmp_path / "static"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_bytes(INDEX)
    (root / "assets" / "x.wasm").write_bytes(b"\x00asm" + b"\x00" * 10)
    (root / "assets" / "index.js").write_text("console.log(1)")
    (root / "assets" / "index.css").write_text("body{}")
    (tmp_path / "secret.txt").write_text("nope")
    return root


@pytest.fixture
async def served(site_dir, tmp_path):
    port = free_port()
    server = ViewerServer("127.0.0.1", port, data_dir=tmp_path / "data", site=SiteServer(site_dir), markers=False)
    async with server.serve():
        yield f"127.0.0.1:{port}"


def get(url: str):
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None
    try:
        with urllib.request.build_opener(NoRedirect).open(url, timeout=5) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


async def aget(url):
    return await asyncio.to_thread(get, url)


async def test_index_has_served_meta(served):
    status, headers, body = await aget(f"http://{served}/")
    assert status == 200 and headers["Content-Type"].startswith("text/html")
    assert SERVED_META.encode() in body and b"<title>LSL Web Viewer</title>" in body
    status, headers, _ = await aget(f"http://{served}/index.html")
    assert status == 302 and headers["Location"] == "/"


async def test_mime_types(served):
    status, headers, body = await aget(f"http://{served}/assets/x.wasm")
    assert status == 200 and headers["Content-Type"] == "application/wasm" and body.startswith(b"\x00asm")
    assert (await aget(f"http://{served}/assets/index.js"))[1]["Content-Type"] == "text/javascript"
    assert (await aget(f"http://{served}/assets/index.css"))[1]["Content-Type"] == "text/css"


@pytest.mark.parametrize("path", ["../secret.txt", "..%2Fsecret.txt", "assets/../../secret.txt",
                                  "%2e%2e/secret.txt", "missing.js"])
async def test_no_escape_and_404s(served, path):
    status, _, body = await aget(f"http://{served}/{path}")
    assert status == 404 and b"nope" not in body


async def test_ws_path_still_a_websocket(served):
    assert (await aget(f"http://{served}/ws"))[0] == 426
    async with websockets.connect(f"ws://{served}/ws") as ws:
        assert json.loads(await ws.recv())["type"] == "hello"


async def test_unknown_ws_path_closed(served):
    async with websockets.connect(f"ws://{served}/nope") as ws:
        with pytest.raises(websockets.ConnectionClosed):
            await ws.recv()
        assert ws.close_code == 4404


def test_packaged_page_is_built():
    """The committed build in lsl_web_viewer/static/ (what pip installs) exists and has its assets."""
    index = STATIC_DIR / "index.html"
    assert index.is_file(), "run: npm --prefix web run build"
    html = index.read_text()
    assert "./assets/" in html  # relative base, so it works at any path
    for ref in html.split('"'):
        if ref.startswith("./assets/"):
            assert (STATIC_DIR / ref[2:]).is_file(), ref
