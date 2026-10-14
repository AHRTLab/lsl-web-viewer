"""lsl-web-viewer: a browser-based live viewer and labeled recorder for Lab Streaming Layer (LSL) streams.

    lsl-web-viewer --open          # serve the page at http://localhost:8770/ and open it

The Python side discovers LSL streams, opens inlets for the ones the page subscribes to, streams
decimated data to the page over a WebSocket, and records full-rate CSV takes on disk. See README.md.
"""
from .loader import load_recording

__version__ = "0.1.0"
__all__ = ["__version__", "load_recording"]
