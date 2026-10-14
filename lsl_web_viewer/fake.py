"""Synthetic LSL streams, for trying the viewer (and testing it) without hardware.

    python -m lsl_web_viewer.fake                 # FakeEMG + FakeIMU + FakeMarkers until Ctrl+C
    python -m lsl_web_viewer.fake --seconds 30 --prefix Test

Streams:
    <prefix>EMG      type EMG, 8 channels (emg1..emg8), 200 Hz, bursts of activity every few seconds
    <prefix>IMU      type IMU, 10 channels [qw qx qy qz ax ay az gx gy gz], 50 Hz, slowly rotating
    <prefix>Markers  type Markers, 1 string channel, a "cue:<n>" marker every 2 s
"""
from __future__ import annotations

import argparse
import math
import time

import numpy as np

EMG_HZ, IMU_HZ, MARKER_PERIOD = 200, 50, 2.0
IMU_LABELS = ["qw", "qx", "qy", "qz", "ax", "ay", "az", "gx", "gy", "gz"]


def _info(name: str, kind: str, labels: list[str], srate: float, fmt: int, source_id: str):
    import pylsl

    info = pylsl.StreamInfo(name, kind, len(labels), srate, fmt, source_id)
    chans = info.desc().append_child("channels")
    for lab in labels:
        chans.append_child("channel").append_child_value("label", lab)
    return pylsl.StreamOutlet(info)


def main(argv: list[str] | None = None) -> None:
    import pylsl

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--prefix", default="Fake", help="stream name prefix (default Fake)")
    ap.add_argument("--seconds", type=float, default=0, help="stop after N seconds (0 = run forever)")
    ap.add_argument("--no-markers", action="store_true", help="don't publish the markers stream")
    args = ap.parse_args(argv)

    p = args.prefix
    emg = _info(f"{p}EMG", "EMG", [f"emg{i + 1}" for i in range(8)], EMG_HZ, pylsl.cf_float32, f"{p}-emg")
    imu = _info(f"{p}IMU", "IMU", IMU_LABELS, IMU_HZ, pylsl.cf_float32, f"{p}-imu")
    mk = None if args.no_markers else _info(f"{p}Markers", "Markers", ["marker"], 0, pylsl.cf_string, f"{p}-mk")
    print(f"publishing {p}EMG (8 ch @ {EMG_HZ} Hz), {p}IMU (10 ch @ {IMU_HZ} Hz)"
          + ("" if mk is None else f", {p}Markers"), flush=True)

    rng = np.random.default_rng(0)
    t0 = time.monotonic()
    n_emg = n_imu = n_mk = 0
    while True:
        t = time.monotonic() - t0
        if args.seconds and t >= args.seconds:
            break
        while n_emg < t * EMG_HZ:  # keep each stream on its nominal rate
            ts = n_emg / EMG_HZ
            a = max(0.0, math.sin(2 * math.pi * ts / 4.0)) ** 4      # "flexors": a burst every 4 s
            b = max(0.0, math.sin(2 * math.pi * ts / 4.0 + 2.5)) ** 4  # "extensors", phase-shifted
            amp = np.array([a] * 4 + [b] * 4) * 80 + 4
            emg.push_sample((rng.normal(0, 1, 8) * amp).tolist())
            n_emg += 1
        while n_imu < t * IMU_HZ:
            ts = n_imu / IMU_HZ
            yaw, pitch = 0.8 * math.sin(0.5 * ts), 0.4 * math.sin(0.3 * ts)
            cy, sy, cp, sp = math.cos(yaw / 2), math.sin(yaw / 2), math.cos(pitch / 2), math.sin(pitch / 2)
            q = [cy * cp, -sy * sp, cy * sp, sy * cp]  # yaw about z, then pitch about y
            imu.push_sample(q + [0.0, 0.0, 9.81, 0.0, 0.12 * math.cos(0.3 * ts), 0.4 * math.cos(0.5 * ts)])
            n_imu += 1
        if mk is not None and t >= n_mk * MARKER_PERIOD:
            n_mk += 1
            mk.push_sample([f"cue:{n_mk}"])
        time.sleep(0.002)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
