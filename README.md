# lsl-web-viewer

A browser-based live viewer and labeled recorder for [Lab Streaming Layer](https://labstreaminglayer.org)
(LSL) streams: Myo EMG / IMU, BioRadio, or anything else that publishes an LSL outlet.

- **See every stream on the network**: discovered automatically; tick one to view it.
- **Strip charts** per channel (2 / 5 / 10 s window, auto or fixed scale). Fast streams are decimated
  with a min/max envelope, so spikes never disappear from the display.
- **EMG streams** also get per-channel RMS bars (200 ms window) with peak hold.
- **IMU streams** (≥ 4 channels) also get a small 3D box rotated by the first four channels read as a
  quaternion `[w, x, y, z]`.
- **Marker and low-rate streams** get a value readout and a scrolling log.
- **Labeled recording at full rate**, written on the server: team and label, manual start / stop or timed
  takes (duration, 3-2-1 countdown, repeat N times, rest between repeats). The CSV format is the same as
  the AHRT Lab BioRadio data-collection GUI, so one loader reads both. Start and stop are also published on
  an LSL marker stream, so a LabRecorder XDF recorded alongside carries the labels.

**Try the demo:** https://ahrtlab.github.io/lsl-web-viewer/ (synthetic data, generated in your browser).

> lsl-web-viewer is an independent tool built *for* Lab Streaming Layer by the AHRT Lab at Rochester
> Institute of Technology. It is not part of, or endorsed by, the LSL project.

## Install

Python 3.10 or newer:

```bash
pip install "lsl-web-viewer @ git+https://github.com/AHRTLab/lsl-web-viewer@v0.1.0"
```

This installs `websockets`, `pylsl` (which ships the liblsl library on Windows, macOS and Linux x86_64)
and `numpy`. The page comes prebuilt inside the package, so Node is **not** needed to use it.

In a `requirements.txt` or `pyproject.toml` dependency list:

```
lsl-web-viewer @ git+https://github.com/AHRTLab/lsl-web-viewer@v0.1.0
```

## Use

```bash
lsl-web-viewer --open
```

This serves the viewer at http://localhost:8770/ and opens it. Tick the streams you want to see, type a
team id and a label, and press **Record** (or the `R` key when you're not typing in a field; `Esc` stops).

| option | default | |
|---|---|---|
| `--port` | `8770` | HTTP + WebSocket port. If it is busy, the tool says so; pick another one. |
| `--host` | `localhost` | Interface to bind. `0.0.0.0` lets other machines open the page (there is no authentication, so only do this on a trusted network). |
| `--open` | off | Open the page in the default browser. |
| `--data-dir` | `./data` | Where recordings go. |
| `--no-markers` | off | Don't publish the `LslWebViewerMarkers` outlet. |
| `-v` | off | Debug logging. |

`python -m lsl_web_viewer` works the same as `lsl-web-viewer`.

No device at hand? Publish synthetic streams (8-channel EMG at 200 Hz, a 10-channel IMU at 50 Hz and
a marker stream):

```bash
python -m lsl_web_viewer.fake
```

**Why does the tool serve its own page?** A page from an `https://` site may not open a connection to
`ws://localhost`. Chrome asks for local-network permission and Safari refuses outright. Serving the page
from the tool's own `http://localhost` origin avoids both, and it keeps working without internet. The
public demo site never connects to your machine; it only shows synthetic data.

## Recordings

Each take writes one CSV per recorded stream:

```
<data-dir>/<team>/<label>_<YYYYmmdd_HHMMSS>.csv              one stream
<data-dir>/<team>/<label>_<YYYYmmdd_HHMMSS>_<stream>.csv     several streams in the same take
```

The team is `unknown` if left blank, and spaces become `_`. Samples are cut by their LSL timestamps
(clock-corrected to this machine), so a 5 s take holds 5 s of samples at the stream's full rate even
when the network delivers them in bursts.

```
# team: team_7
# label: fist
# timestamp: 20260301_101500
# sample_rate: 200.0
# samples: 1000
# duration_sec: 5.000
# channels: emg1,emg2,emg3,emg4,emg5,emg6,emg7,emg8
# stream: MyoEMG
# lsl_uid: 0c5e…
#
timestamp,emg1,emg2,emg3,emg4,emg5,emg6,emg7,emg8
1403875.2131,12.0,-3.0,…
```

The first seven header lines and the column layout match the BioRadio data-collection GUI; `# stream:`
and `# lsl_uid:` are extra. `timestamp` is the LSL timestamp in seconds (`pylsl.local_clock()` domain).
Marker (string) streams are recorded the same way, with text values.

Load a recording (from either tool):

```python
from lsl_web_viewer import load_recording

meta, data = load_recording("data/team_7/fist_20260301_101500.csv")
meta["label"], meta["sample_rate"], meta["channels"]   # 'fist', 200.0, ['emg1', …]
t, x = data[:, 0], data[:, 1:]                          # timestamps, samples (one column per channel)
```

**Labels in XDF files.** While it runs, the tool publishes an LSL stream `LslWebViewerMarkers`
(type `Markers`) with `record_start:<label>` and `record_stop:<label>` at each take's exact start and
stop time. Record it with [LabRecorder](https://github.com/labstreaminglayer/App-LabRecorder) next to your
device streams and the XDF carries the labels too.

## WebSocket protocol

The page talks to the tool over `ws://<host>:<port>/ws` with JSON text messages. You can use it from
your own scripts as well (for example to start takes from an experiment script).

Server → page:

| message | fields | when |
|---|---|---|
| `hello` | `version`, `data_dir` | on connect |
| `streams` | `streams: [{uid, name, type, channels, srate, fmt, hostname, source_id, channel_labels}]` | every second |
| `data` | `uid`, `t: [...]`, `x: [[ch1...], [ch2...], ...]` (channel-major; `x[c][i]` belongs to `t[i]`; `null` = non-finite) | ~30 Hz per subscribed stream, at most 600 points/s/channel |
| `markers` | `uid`, `t: [...]`, `values: [...]` (multi-channel string samples joined with `", "`) | as string samples arrive |
| `rec_status` | `state` (`idle`, `countdown`, `recording`, `saving`, `rest`, `done`), `label`, `team`, `take`, `of`, `remaining` (s, `null` for manual takes), `elapsed`, `duration`, `uids` | 5 Hz while a take sequence runs |
| `saved` | `files: [...]` (absolute paths), `take`, `of` | after each take is written |
| `error` | `message` | e.g. record without streams |

Page → server:

| message | fields |
|---|---|
| `subscribe` | `uids: [...]`: replaces this connection's subscriptions (`[]` = none) |
| `record_start` | `label`, `team`, `uids?` (default: this connection's subscriptions), `duration?` (s; omit for a manual take), `countdown?` (s), `repeat?`, `rest?` (s) |
| `record_stop` | stops the current take (it is saved) and cancels any remaining repeats |

Several pages can be open at once; each gets data for its own subscriptions, and they share one
recorder.

```python
import asyncio, json, websockets

async def take():
    async with websockets.connect("ws://localhost:8770/ws") as ws:
        uids = []
        while not uids:  # wait for discovery to list an EMG stream
            m = json.loads(await ws.recv())
            if m["type"] == "streams":
                uids = [s["uid"] for s in m["streams"] if s["type"] == "EMG"]
        await ws.send(json.dumps({"type": "record_start", "label": "fist", "team": "p01",
                                  "uids": uids, "duration": 3, "countdown": 3, "repeat": 5, "rest": 2}))
        async for raw in ws:
            m = json.loads(raw)
            if m["type"] == "saved":
                print("saved", m["files"])
            elif m["type"] == "rec_status" and m["state"] == "done":
                break

asyncio.run(take())
```

## Development

```bash
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest                 # Python tests (real sockets, pylsl loopback outlets)

cd web
npm ci
npm run dev                                # http://127.0.0.1:5180/ (demo mode; add ?ws=ws://localhost:8770/ws for live)
npm test                                   # unit tests (ring buffer, decimation, RMS, CSV, takes)
npm run e2e                                # builds both pages, then Playwright in Google Chrome
npm run build                              # rebuild the page into lsl_web_viewer/static/ (committed)
```

- `lsl_web_viewer/`: the Python package. `discovery.py` (resolver thread), `inlets.py` (one inlet thread per
  subscribed stream, display decimation), `recorder.py` (takes, CSV, marker outlet), `server.py`
  (WebSocket protocol, take sequencing), `site.py` (serves `static/`), `loader.py`, `fake.py`, `cli.py`.
- `web/`: the page (TypeScript + canvas, three.js only for the IMU view). `npm run build` writes into
  `lsl_web_viewer/static/` with relative asset paths; `npm run build:demo` writes the public site into
  `web/dist-demo/` with base `/lsl-web-viewer/`. Same code: the page runs live when the tool's
  `<meta name="lsl-web-viewer" content="served">` is present, and in demo mode otherwise.
- `scripts/release.sh` rebuilds `static/`, runs the tests and prints the tag commands.
  `scripts/deploy.sh` publishes the demo site to the `gh-pages` branch.

## License

BSD-3-Clause, © 2026 AHRT Lab, Rochester Institute of Technology. See [LICENSE](LICENSE). The built page
bundles three.js (MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
