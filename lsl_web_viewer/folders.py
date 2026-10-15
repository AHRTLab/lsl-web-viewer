"""Where recordings go: the remembered save folder, and a native "choose folder" dialog.

The page's "Change…" button asks the server to open the operating system's own folder picker (Finder on
macOS, Explorer on Windows, zenity / kdialog / Tk on Linux) on the computer running lsl-web-viewer.
That works the same in every browser, and the browser never touches the file system. The dialog runs
as a separate process, so it never blocks the server, and the choice is remembered for next time in
~/.config/lsl-web-viewer/config.json (override with $LSL_WEB_VIEWER_CONFIG).

Folder precedence at startup: --data-dir, then the remembered folder, then ./data.
Set LSL_WEB_VIEWER_NO_DIALOG=1 to skip the dialog (headless machines, tests): the page then asks for a
typed path instead.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
from pathlib import Path

log = logging.getLogger("lsl_web_viewer")
DEFAULT_DIR = Path("data")
PROMPT = "Save lsl-web-viewer recordings to:"


def config_path() -> Path:
    env = os.environ.get("LSL_WEB_VIEWER_CONFIG")
    if env:
        return Path(env).expanduser()
    base = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    return base / "lsl-web-viewer" / "config.json"


def remembered_dir() -> Path | None:
    try:
        d = json.loads(config_path().read_text()).get("data_dir")
        return Path(d) if d else None
    except (OSError, ValueError, AttributeError):
        return None


def remember_dir(d: Path) -> None:
    p = config_path()
    try:
        cfg = json.loads(p.read_text()) if p.exists() else {}
    except (OSError, ValueError):
        cfg = {}
    cfg["data_dir"] = str(d)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(cfg, indent=2) + "\n")
    except OSError as e:
        log.warning("could not remember the save folder in %s: %s", p, e)


def initial_dir(cli_dir: str | None) -> Path:
    if cli_dir:
        return Path(cli_dir).expanduser()
    return remembered_dir() or DEFAULT_DIR


def validate_dir(path: str) -> Path:
    """A folder the user chose: absolute (~ allowed), created if missing, and writable."""
    d = Path(path).expanduser()
    if not d.is_absolute():
        raise ValueError("use a full folder path, e.g. ~/Documents/recordings")
    d.mkdir(parents=True, exist_ok=True)
    probe = d / ".lsl-web-viewer-write-test"
    probe.write_text("")
    probe.unlink()
    return d.resolve()


# ------------------------------------------------------------------------------ native dialogs
def _dialog_commands(start: Path) -> list[list[str]]:
    """Folder-picker commands to try for this OS, best first. Each prints the chosen path on stdout."""
    start_s = str(start.expanduser().resolve()) if start.exists() else str(Path.home())
    if sys.platform == "darwin":
        esc = start_s.replace("\\", "\\\\").replace('"', '\\"')
        script = (f'POSIX path of (choose folder with prompt "{PROMPT}" '
                  f'default location (POSIX file "{esc}"))')
        return [["osascript", "-e", script]]
    if sys.platform.startswith("win"):
        ps = ("Add-Type -AssemblyName System.Windows.Forms; "
              "$d = New-Object System.Windows.Forms.FolderBrowserDialog; "
              f"$d.Description = '{PROMPT}'; $d.SelectedPath = '{start_s.replace(chr(39), chr(39) * 2)}'; "
              "$d.ShowNewFolderButton = $true; "
              "if ($d.ShowDialog() -eq 'OK') { [Console]::Out.Write($d.SelectedPath) } else { exit 1 }")
        return [["powershell", "-NoProfile", "-STA", "-Command", ps]]
    cmds = []
    if shutil.which("zenity"):
        cmds.append(["zenity", "--file-selection", "--directory", f"--title={PROMPT}", f"--filename={start_s}/"])
    if shutil.which("kdialog"):
        cmds.append(["kdialog", "--getexistingdirectory", start_s, "--title", PROMPT])
    return cmds


def _tk_command(start: Path) -> list[str]:
    """Universal fallback: Tk's folder dialog in a child Python (Tk must own its process's main thread)."""
    code = ("import sys, tkinter as tk; from tkinter import filedialog; r = tk.Tk(); r.withdraw(); "
            "r.attributes('-topmost', True); "
            "p = filedialog.askdirectory(initialdir=sys.argv[1], title=sys.argv[2], mustexist=False); "
            "sys.stdout.write(p or ''); sys.exit(0 if p else 1)")
    return [sys.executable, "-c", code, str(start), PROMPT]


class NoDialog(RuntimeError):
    pass


def choose_folder(start: Path, timeout: float = 600) -> Path | None:
    """Show a native folder picker on this computer. Returns the folder, or None if the user cancelled.
    Raises NoDialog when no picker is available (e.g. a headless Linux server)."""
    if os.environ.get("LSL_WEB_VIEWER_NO_DIALOG"):
        raise NoDialog("folder dialog disabled (LSL_WEB_VIEWER_NO_DIALOG); type a folder path instead")
    for cmd in [*_dialog_commands(start), _tk_command(start)]:
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        except (OSError, subprocess.TimeoutExpired) as e:
            log.debug("folder dialog %s unavailable: %s", cmd[0], e)
            continue
        out = r.stdout.strip()
        if r.returncode == 0 and out:
            return Path(out)
        err = r.stderr.strip()
        if r.returncode == 1 and (not err or "-128" in err or "User canceled" in err):
            return None  # the user pressed Cancel (osascript reports error -128; the others just exit 1)
        log.debug("folder dialog %s failed (%s): %s", cmd[0], r.returncode, r.stderr.strip()[:200])
    raise NoDialog("no folder dialog available on this computer; type a folder path instead, or restart with --data-dir")
