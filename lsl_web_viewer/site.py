"""Serves the viewer page on the same port as the WebSocket (http://localhost:8770/).

Why same-origin: a page on https (e.g. GitHub Pages) may not open ws://localhost. Chrome asks for
local-network permission and Safari silently refuses, so the tool serves its own copy of the page over
plain http://localhost, and the page connects back to ws://<its own host>/ws.

The page is the Vite build committed in lsl_web_viewer/static/ (rebuild with `npm --prefix web run
build`). index.html gets a <meta name="lsl-web-viewer" content="served"> injected, which is how the page
knows it is live (no meta → demo mode with synthetic data; see web/src/main.ts).
"""
from __future__ import annotations

import mimetypes
import os
from pathlib import Path
from urllib.parse import unquote, urlsplit

from websockets.datastructures import Headers
from websockets.http11 import Request, Response

STATIC_DIR = Path(__file__).resolve().parent / "static"
SERVED_META = '<meta name="lsl-web-viewer" content="served">'

TYPES = {".wasm": "application/wasm", ".js": "text/javascript", ".mjs": "text/javascript",
         ".json": "application/json", ".html": "text/html; charset=utf-8", ".css": "text/css",
         ".svg": "image/svg+xml", ".map": "application/json", ".png": "image/png", ".ico": "image/x-icon",
         ".txt": "text/plain; charset=utf-8"}

NOT_BUILT = (b"<!doctype html><html><head><title>lsl-web-viewer</title></head><body>"
             b"<p>The page has not been built. Run <code>npm --prefix web install && npm --prefix web run build"
             b"</code> in the repository, or install a release: <code>pip install lsl-web-viewer</code>.</p>"
             b"</body></html>")


class SiteServer:
    """Answers plain-HTTP requests on the server port; WebSocket upgrades pass through untouched."""

    def __init__(self, root: Path = STATIC_DIR, ws_paths: set[str] | None = None):
        self.root = Path(root).resolve()
        self.ws_paths = ws_paths or {"/ws"}

    def _response(self, status: int, reason: str, body: bytes, ctype: str,
                  extra: dict[str, str] | None = None) -> Response:
        h = Headers()
        h["Content-Type"] = ctype
        h["Content-Length"] = str(len(body))
        h["Cache-Control"] = "no-cache"
        for k, v in (extra or {}).items():
            h[k] = v
        return Response(status, reason, h, body)

    def handle(self, request: Request) -> Response | None:
        if request.headers.get("Upgrade", "").lower() == "websocket":
            return None  # a WebSocket handshake: let the server's handler take it
        path = unquote(urlsplit(request.path).path)
        if path in self.ws_paths:
            return self._response(426, "Upgrade Required", b"This is a WebSocket endpoint.\n", "text/plain")
        if path == "/index.html":
            return self._response(302, "Found", b"", "text/plain", {"Location": "/"})
        rel = path.lstrip("/") or "index.html"
        f = (self.root / rel).resolve()
        if f.is_dir():
            f = f / "index.html"
        inside = str(f).startswith(str(self.root) + os.sep)
        if rel == "index.html" and not f.is_file():
            return self._response(200, "OK", NOT_BUILT, TYPES[".html"])
        if not inside or not f.is_file():
            return self._response(404, "Not Found", b"Not found\n", "text/plain")
        body = f.read_bytes()
        ctype = TYPES.get(f.suffix.lower()) or mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        if f.name == "index.html":
            body = body.replace(b"<head>", b"<head>\n    " + SERVED_META.encode(), 1)
        return self._response(200, "OK", body, ctype)
