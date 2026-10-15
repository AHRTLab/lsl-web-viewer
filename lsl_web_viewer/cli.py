"""lsl-web-viewer command line.

    lsl-web-viewer                         # http://localhost:8770/
    lsl-web-viewer --open                  # ... and open it in the default browser
    lsl-web-viewer --port 8780 --data-dir ~/recordings
"""
from __future__ import annotations

import argparse
import asyncio
import errno
import logging
import signal
import sys
import webbrowser

from . import __version__
from . import folders
from .server import ViewerServer

log = logging.getLogger("lsl_web_viewer")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        prog="lsl-web-viewer",
        description="Live browser viewer and labeled recorder for Lab Streaming Layer (LSL) streams.")
    ap.add_argument("--port", type=int, default=8770, help="HTTP + WebSocket port (default 8770)")
    ap.add_argument("--host", default="localhost",
                    help="interface to bind (default localhost; 0.0.0.0 to allow other machines)")
    ap.add_argument("--open", action="store_true", help="open the page in the default browser")
    ap.add_argument("--data-dir", default=None,
                    help="where recordings are saved (default: the folder last chosen on the page, else ./data); "
                         "the page's Change… button picks another folder while running")
    ap.add_argument("--no-markers", action="store_true",
                    help="don't publish the LslWebViewerMarkers outlet (record_start / record_stop)")
    ap.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    ap.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    try:
        import pylsl  # noqa: F401  (fail early with a useful message, before the server starts)
    except Exception as e:  # ImportError, or liblsl failing to load
        print(f"lsl-web-viewer: pylsl is not usable ({e.__class__.__name__}: {e}).\n"
              "  pip install pylsl   (it bundles liblsl on Windows / macOS / Linux x86_64)", file=sys.stderr)
        return 1

    shown = "localhost" if args.host in ("0.0.0.0", "::", "") else args.host
    url = f"http://{shown}:{args.port}/"
    server = ViewerServer(args.host, args.port, data_dir=folders.initial_dir(args.data_dir), markers=not args.no_markers)

    def ready() -> None:
        log.info("lsl-web-viewer %s: open %s  (recordings → %s; Ctrl+C to quit)",
                 __version__, url, server.recorder.data_dir.resolve())
        if args.open:
            webbrowser.open(url)

    def on_term(*_: object) -> None:  # `kill` / service stop: shut down like Ctrl+C (an open take is saved)
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, on_term)
    try:
        asyncio.run(server.run_forever(ready))
    except KeyboardInterrupt:
        pass
    except OSError as e:
        if e.errno in (errno.EADDRINUSE, getattr(errno, "WSAEADDRINUSE", -1)) or "address already in use" in str(e).lower():
            print(f"lsl-web-viewer: port {args.port} is already in use (is another lsl-web-viewer running?).\n"
                  f"  Try a different one: lsl-web-viewer --port {args.port + 1}", file=sys.stderr)
            return 2
        raise
    return 0
