#!/usr/bin/env python3
"""Bomberman Online — launcher for the native Dreamcast recompilation.

The UI deliberately uses only classic Tk widgets (Frame/Label/Entry/Button/
OptionMenu/Checkbutton/Text) plus no ttk theming.  Apple's Tk 8.5.9 ships an
``aqua`` ttk theme that silently ignores ``background``/``foreground`` on many
widgets, which is why earlier ttk-based versions of this launcher rendered as
an empty grey window with invisible text.  Classic widgets are drawn by Tk
itself and honour the dark palette on every platform.

Run ``python3 tools/launcher.py --selftest`` to build the whole UI, verify that
every key widget is mapped with a sane size, print the resolved launch command,
and exit without starting the game or the build.
"""

from __future__ import annotations

import json
import os
import queue
import shlex
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

import tkinter as tk
from tkinter import filedialog, messagebox

ROOT = Path(__file__).resolve().parent.parent
DC = ROOT / "tools" / "dc.sh"
LOCAL_JSON = ROOT / ".dreamcomp" / "local.json"
GAME_TOML = ROOT / "game" / "bomberman_online.toml"
EXE = ROOT / "build" / "game" / "bomberman-online"
CACHE = ROOT / "build" / "CMakeCache.txt"
DEFAULT_BINDINGS = ROOT / "game" / "bindings.txt"
USER_BINDINGS = ROOT / ".dreamcomp" / "bindings.txt"

APP_NAME = "Bomberman Online"
APP_TAG = "Sega Dreamcast · native static recompilation"
VERSION = "launcher 2.0"

# ---------------------------------------------------------------------------
# Palette.  Every widget below is explicitly coloured from this table, so the
# look does not depend on the OS theme or on the user's light/dark preference.
# ---------------------------------------------------------------------------
BG = "#14161a"
CARD = "#1c1f26"
CARD_HI = "#22262f"
FIELD = "#0f1116"
BORDER = "#2e3440"
TEXT = "#e6e9ef"
MUTED = "#8b93a3"
DIM = "#5c6474"
ACCENT = "#e8563f"
ACCENT_HI = "#ff6a52"
ACCENT_DIM = "#7a2d22"
OK = "#43b581"
WARN = "#e0b341"
ERR = "#e05252"

DISC_TYPES = [
    ("Dreamcast images", "*.chd *.gdi *.cue *.cdi"),
    ("CHD", "*.chd"),
    ("GDI", "*.gdi"),
    ("CUE", "*.cue"),
    ("CDI", "*.cdi"),
    ("All files", "*"),
]

# name, key, scale, render aspect
RESOLUTION_PRESETS = [
    ("Native 640x480", "native", 1, None),
    ("720p  ~1280x720", "720p", 2, 1.7778),
    ("1080p ~1920x1080", "1080p", 3, 1.7778),
    ("1440p ~2560x1440", "1440p", 4, 1.7778),
    ("4K    ~3840x2160", "4k", 6, 1.7778),
    ("8K    ~7680x4320", "8k", 8, 1.7778),
]
PRESET_BY_KEY = {p[1]: p for p in RESOLUTION_PRESETS}
PRESET_BY_NAME = {p[0]: p for p in RESOLUTION_PRESETS}

CONNECTIONS = [
    ("BBA (broadband adapter)", "bba"),
    ("Modem (dial-up)", "modem"),
    ("PPPoE", "pppoe"),
]
CONN_BY_LABEL = dict(CONNECTIONS)
CONN_BY_KEY = {k: label for label, k in CONNECTIONS}

SEARCH_DIRS = [
    Path.home() / "Downloads",
    Path.home() / "Desktop",
    Path.home() / "Documents",
    ROOT,
]
DISC_SUFFIXES = {".chd", ".gdi", ".cue", ".cdi"}


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------
DEFAULTS = {
    "disc": "",
    "resolution": "native",
    "vsync": False,
    "fullscreen": False,
    "fps": False,
    "audio": True,
    "frames": "600",
    "online": False,
    "conn": "bba",
    "login": "",
    "password": "",
    "server": "",
}


def read_settings() -> dict:
    data = dict(DEFAULTS)
    try:
        stored = json.loads(LOCAL_JSON.read_text())
    except (OSError, ValueError):
        stored = {}
    if isinstance(stored, dict):
        for key in DEFAULTS:
            if key in stored:
                data[key] = stored[key]
    # Migrate the old schema, which stored a display name in "resolution" and
    # separate "scale"/"aspect" values.
    if data["resolution"] not in PRESET_BY_KEY:
        name = str(data["resolution"])
        if name in PRESET_BY_NAME:
            data["resolution"] = PRESET_BY_NAME[name][1]
        elif isinstance(stored.get("scale"), int):
            data["resolution"] = next(
                (p[1] for p in RESOLUTION_PRESETS if p[2] == stored["scale"]), "native"
            )
        else:
            data["resolution"] = "native"
    if data["conn"] not in CONN_BY_KEY:
        data["conn"] = "bba"
    return data


def write_settings(data: dict) -> None:
    try:
        LOCAL_JSON.parent.mkdir(parents=True, exist_ok=True)
        LOCAL_JSON.write_text(json.dumps(data, indent=2) + "\n")
    except OSError:
        pass


def renderer_enabled() -> bool:
    try:
        text = CACHE.read_text()
    except OSError:
        return False
    for line in text.splitlines():
        if line.startswith("DREAM_RENDERER:BOOL="):
            return line.split("=", 1)[1].strip().upper() == "ON"
    return False


def autodetect_disc() -> str:
    """Return the most plausible Bomberman disc image, or ''."""
    candidates: list[Path] = []
    for folder in SEARCH_DIRS:
        try:
            for path in folder.iterdir():
                if path.is_file() and path.suffix.lower() in DISC_SUFFIXES:
                    candidates.append(path)
        except OSError:
            continue
    if not candidates:
        return ""
    candidates.sort(
        key=lambda p: (
            "bomberman" not in p.name.lower(),
            -p.stat().st_mtime if p.exists() else 0,
        )
    )
    return str(candidates[0])


def bindings_path() -> Path:
    return USER_BINDINGS if USER_BINDINGS.exists() else DEFAULT_BINDINGS


def read_bindings() -> str:
    path = bindings_path()
    try:
        return path.read_text()
    except OSError as exc:
        return f"# cannot read {path}: {exc}\n"


def save_bindings(text: str) -> None:
    USER_BINDINGS.parent.mkdir(parents=True, exist_ok=True)
    USER_BINDINGS.write_text(text)


# ---------------------------------------------------------------------------
# Command construction (pure, so the self-test can verify it)
# ---------------------------------------------------------------------------
def build_play_command(s: dict) -> list[str]:
    preset = PRESET_BY_KEY.get(str(s.get("resolution")), PRESET_BY_KEY["native"])
    _name, _key, scale, aspect = preset
    extra: list[str] = []
    if scale != 1:
        extra += ["--scale", str(scale)]
    if aspect is not None:
        extra += ["--render-aspect", str(aspect)]
    if s.get("vsync"):
        extra.append("--sync-display")
    if s.get("fullscreen"):
        extra.append("--fullscreen")
    if s.get("fps"):
        extra.append("--fps")
    if not s.get("audio", True):
        extra.append("--no-audio")
    if USER_BINDINGS.exists():
        extra += ["--bindings", str(USER_BINDINGS)]
    disc = str(s.get("disc") or "").strip()
    if disc:
        extra += ["--disc", disc]
    return [str(DC), "run", ".", "--window", *extra]


def build_headless_command(s: dict) -> list[str]:
    frames = str(s.get("frames") or "600").strip()
    if not frames.isdigit():
        frames = "600"
    extra = ["--frames", frames]
    disc = str(s.get("disc") or "").strip()
    if disc:
        extra += ["--disc", disc]
    return [str(DC), "report", ".", *extra]


def build_build_command() -> list[str]:
    return [str(DC), "build", "."]


def online_environment(s: dict) -> dict:
    env = os.environ.copy()
    env["BMO_ONLINE"] = "1" if s.get("online") else "0"
    env["BMO_CONN"] = str(s.get("conn") or "bba")
    for key, var in (("login", "BMO_LOGIN"), ("password", "BMO_PASSWORD"),
                     ("server", "BMO_SERVER")):
        value = str(s.get(key) or "")
        if value:
            env[var] = value
        else:
            env.pop(var, None)
    return env


# ---------------------------------------------------------------------------
# Small UI helpers
# ---------------------------------------------------------------------------
def luminance(widget: tk.Misc, colour: str) -> float:
    r, g, b = widget.winfo_rgb(colour)
    channels = []
    for value in (r, g, b):
        c = value / 65535.0
        channels.append(c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4)
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]


def contrast(widget: tk.Misc, fg: str, bg: str) -> float:
    a, b = luminance(widget, fg), luminance(widget, bg)
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)


class ControlsEditor(tk.Toplevel):
    """Plain-text binding editor with reset/save."""

    def __init__(self, parent: "Launcher"):
        super().__init__(parent)
        self.title("Remap controls")
        self.configure(bg=BG)
        self.geometry("760x600")
        self.minsize(560, 400)
        self.transient(parent)
        self.grab_set()
        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(1, weight=1)

        header = tk.Frame(self, bg=BG)
        header.grid(row=0, column=0, sticky="ew", padx=18, pady=(16, 8))
        tk.Label(header, text="Keyboard / gamepad bindings", bg=BG, fg=TEXT,
                 font=("TkDefaultFont", 14, "bold")).pack(anchor="w")
        tk.Label(
            header,
            text=("One control per line, mapped to an SDL input name. A control may have a "
                  "second slot with a .2 suffix. Press F1 in-game to rebind interactively."),
            bg=BG, fg=MUTED, justify="left", wraplength=700,
        ).pack(anchor="w", pady=(4, 0))

        body = tk.Frame(self, bg=BORDER, bd=0)
        body.grid(row=1, column=0, sticky="nsew", padx=18, pady=(0, 12))
        body.grid_columnconfigure(0, weight=1)
        body.grid_rowconfigure(0, weight=1)
        self.text = tk.Text(body, wrap="none", font=("Courier", 11), bg=FIELD, fg=TEXT,
                            insertbackground=TEXT, selectbackground=ACCENT_DIM,
                            selectforeground=TEXT, relief="flat", bd=0)
        self.text.grid(row=0, column=0, sticky="nsew", padx=1, pady=1)
        scroll = tk.Scrollbar(body, orient="vertical", command=self.text.yview,
                              bg=CARD, troughcolor=FIELD, relief="flat")
        scroll.grid(row=0, column=1, sticky="ns", pady=1, padx=(0, 1))
        self.text.configure(yscrollcommand=scroll.set)
        self.text.insert("1.0", read_bindings())

        buttons = tk.Frame(self, bg=BG)
        buttons.grid(row=2, column=0, sticky="ew", padx=18, pady=(0, 16))
        buttons.grid_columnconfigure(0, weight=1)
        self._button(buttons, "Reset to defaults", self._reset, "ghost").grid(
            row=0, column=0, sticky="w")
        self._button(buttons, "Cancel", self.destroy, "ghost").grid(
            row=0, column=1, padx=(0, 8))
        self._button(buttons, "Save", self._save, "accent").grid(row=0, column=2)

    def _button(self, parent, text, command, kind):
        return make_button(parent, text, command, kind)

    def _reset(self):
        self.text.delete("1.0", "end")
        self.text.insert("1.0", read_bindings() if DEFAULT_BINDINGS.exists()
                         else "# game/bindings.txt is missing\n")
        try:
            self.text.insert("1.0", DEFAULT_BINDINGS.read_text())
        except OSError:
            pass

    def _save(self):
        try:
            save_bindings(self.text.get("1.0", "end-1c"))
        except OSError as exc:
            messagebox.showerror("Save failed", f"Could not write bindings:\n{exc}",
                                 parent=self)
            return
        self.destroy()


def make_button(parent: tk.Misc, text: str, command, kind: str = "ghost") -> tk.Button:
    styles = {
        "accent": dict(bg=ACCENT, fg="#ffffff", activebackground=ACCENT_HI,
                       activeforeground="#ffffff"),
        "ghost": dict(bg=CARD_HI, fg=TEXT, activebackground=BORDER,
                      activeforeground=TEXT),
        "danger": dict(bg=CARD_HI, fg=ERR, activebackground=ACCENT_DIM,
                       activeforeground="#ffffff"),
    }
    style = styles.get(kind, styles["ghost"])
    return tk.Button(
        parent, text=text, command=command,
        relief="flat", bd=0, highlightthickness=0, cursor="hand2",
        padx=16, pady=8, font=("TkDefaultFont", 11),
        disabledforeground=DIM, **style,
    )


def make_toggle(parent: tk.Misc, text: str, var: tk.BooleanVar,
                command=None) -> tk.Button:
    """A checkbutton that is guaranteed visible on every Tk theme.

    Classic Checkbutton indicators are drawn natively on macOS and ignore the
    palette, so a flat toggle button is used instead: accent fill when on,
    card fill when off.
    """
    def refresh():
        if var.get():
            btn.configure(bg=ACCENT, fg="#ffffff", activebackground=ACCENT_HI,
                          activeforeground="#ffffff", text=f"● {text}")
        else:
            btn.configure(bg=CARD_HI, fg=MUTED, activebackground=BORDER,
                          activeforeground=TEXT, text=f"○ {text}")

    def toggle():
        var.set(not var.get())
        refresh()
        if command is not None:
            command()

    btn = tk.Button(parent, text=f"○ {text}", command=toggle, relief="flat", bd=0,
                    highlightthickness=0, cursor="hand2", padx=12, pady=6,
                    font=("TkDefaultFont", 10))
    refresh()
    return btn


def make_entry(parent: tk.Misc, var: tk.StringVar, width: int | None = None,
               show: str | None = None) -> tk.Entry:
    entry = tk.Entry(parent, textvariable=var, bg=FIELD, fg=TEXT,
                     insertbackground=TEXT, disabledbackground=CARD,
                     disabledforeground=DIM, readonlybackground=FIELD,
                     selectbackground=ACCENT_DIM, selectforeground=TEXT,
                     relief="flat", bd=0, highlightthickness=1,
                     highlightbackground=BORDER, highlightcolor=ACCENT)
    if width:
        entry.configure(width=width)
    if show:
        entry.configure(show=show)
    return entry


def make_option(parent: tk.Misc, var: tk.StringVar, values: list[str],
                width: int = 18) -> tk.OptionMenu:
    menu = tk.OptionMenu(parent, var, *values)
    menu.configure(bg=CARD_HI, fg=TEXT, activebackground=BORDER,
                   activeforeground=TEXT, relief="flat", bd=0,
                   highlightthickness=1, highlightbackground=BORDER,
                   highlightcolor=ACCENT, padx=10, pady=6, width=width,
                   anchor="w", font=("TkDefaultFont", 11))
    menu["menu"].configure(bg=CARD_HI, fg=TEXT, activebackground=ACCENT,
                           activeforeground="#ffffff", relief="flat", bd=0,
                           font=("TkDefaultFont", 11))
    return menu


class Launcher(tk.Tk):
    def __init__(self, selftest: bool = False):
        super().__init__()
        self.selftest = selftest
        self.title(f"{APP_NAME} — Launcher")
        self.configure(bg=BG)
        self.geometry("1000x780")
        self.minsize(880, 660)
        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(7, weight=1)

        self.settings = read_settings()
        self.proc: subprocess.Popen[str] | None = None
        self.events: queue.Queue[tuple[str, object]] = queue.Queue()
        self.key_widgets: dict[str, tk.Widget] = {}

        # ----- variables
        self.disc_var = tk.StringVar(value=self.settings["disc"])
        self.resolution_var = tk.StringVar(
            value=PRESET_BY_KEY[self.settings["resolution"]][0])
        self.vsync_var = tk.BooleanVar(value=bool(self.settings["vsync"]))
        self.fullscreen_var = tk.BooleanVar(value=bool(self.settings["fullscreen"]))
        self.fps_var = tk.BooleanVar(value=bool(self.settings["fps"]))
        self.audio_var = tk.BooleanVar(value=bool(self.settings["audio"]))
        self.frames_var = tk.StringVar(value=str(self.settings["frames"]))
        self.online_var = tk.BooleanVar(value=bool(self.settings["online"]))
        self.conn_var = tk.StringVar(
            value=CONN_BY_KEY.get(str(self.settings["conn"]), CONNECTIONS[0][0]))
        self.login_var = tk.StringVar(value=str(self.settings["login"]))
        self.password_var = tk.StringVar(value=str(self.settings["password"]))
        self.server_var = tk.StringVar(value=str(self.settings["server"]))
        self.status_var = tk.StringVar(value="")
        self.busy_var = tk.StringVar(value="")
        self.disc_hint_var = tk.StringVar(value="")

        self._build_ui()
        self._refresh_state()
        self._update_disc_hint()

        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self.bind("<Control-Return>", lambda _e: self._play())
        self.bind("<Control-b>", lambda _e: self._build())
        self.bind("<Escape>", lambda _e: self._stop())
        self.after(120, self._drain_events)
        self.after(200, self._raise_window)

        self.log_line(f"{APP_NAME} {VERSION}")
        if not self.disc_var.get():
            guess = autodetect_disc()
            if guess:
                self.disc_var.set(guess)
                self._update_disc_hint()
                self.log_line(f"auto-detected disc: {guess}")

    # ------------------------------------------------------------------ UI
    def _card(self, parent, row: int, pady=(0, 12)) -> tk.Frame:
        shell = tk.Frame(parent, bg=BORDER, bd=0)
        shell.grid(row=row, column=0, sticky="ew", padx=16, pady=pady)
        inner = tk.Frame(shell, bg=CARD, bd=0)
        inner.pack(fill="both", expand=True, padx=1, pady=1)
        return inner

    def _section(self, parent, text: str) -> tk.Label:
        return tk.Label(parent, text=text.upper(), bg=CARD, fg=MUTED,
                        font=("TkDefaultFont", 9, "bold"), anchor="w")

    def _build_ui(self) -> None:
        # ---- header -------------------------------------------------------
        header = tk.Frame(self, bg=BG)
        header.grid(row=0, column=0, sticky="ew", padx=16, pady=(14, 10))
        header.grid_columnconfigure(1, weight=1)

        mark = tk.Frame(header, bg=ACCENT, width=44, height=44)
        mark.grid(row=0, column=0, rowspan=2, sticky="w")
        mark.grid_propagate(False)
        tk.Label(mark, text="B", bg=ACCENT, fg="#ffffff",
                 font=("TkDefaultFont", 22, "bold")).place(relx=0.5, rely=0.5,
                                                           anchor="center")

        tk.Label(header, text=APP_NAME, bg=BG, fg=TEXT,
                 font=("TkDefaultFont", 22, "bold"), anchor="w").grid(
            row=0, column=1, sticky="sw", padx=(12, 0))
        tk.Label(header, text=APP_TAG, bg=BG, fg=MUTED,
                 font=("TkDefaultFont", 11), anchor="w").grid(
            row=1, column=1, sticky="nw", padx=(12, 0))

        chips = tk.Frame(header, bg=BG)
        chips.grid(row=0, column=2, rowspan=2, sticky="e")
        self.build_chip = tk.Label(chips, text="", bg=CARD, fg=MUTED,
                                   font=("TkDefaultFont", 9, "bold"),
                                   padx=10, pady=5)
        self.build_chip.pack(side="left", padx=(0, 6))
        self.render_chip = tk.Label(chips, text="", bg=CARD, fg=MUTED,
                                    font=("TkDefaultFont", 9, "bold"),
                                    padx=10, pady=5)
        self.render_chip.pack(side="left")

        # ---- disc ---------------------------------------------------------
        disc = self._card(self, 1, pady=(0, 10))
        disc.grid_columnconfigure(1, weight=1)

        self._section(disc, "Disc image").grid(row=0, column=0, columnspan=3,
                                               sticky="w", padx=14, pady=(12, 2))
        self.disc_entry = make_entry(disc, self.disc_var)
        self.disc_entry.grid(row=1, column=0, columnspan=2, sticky="ew",
                             padx=(14, 8), pady=(0, 2), ipady=7)
        self.key_widgets["disc_entry"] = self.disc_entry

        self.disc_hint = tk.Label(disc, textvariable=self.disc_hint_var, bg=CARD,
                                  fg=DIM, anchor="w", font=("TkDefaultFont", 9))
        self.disc_hint.grid(row=2, column=0, columnspan=2, sticky="ew",
                            padx=14, pady=(0, 12))

        side = tk.Frame(disc, bg=CARD)
        side.grid(row=1, column=2, rowspan=2, sticky="ne", padx=(0, 14), pady=(0, 12))
        browse = make_button(side, "Browse…", self._choose_disc, "ghost")
        browse.pack(fill="x", pady=(0, 6))
        detect = make_button(side, "Auto-detect", self._detect_disc, "ghost")
        detect.pack(fill="x")
        self.key_widgets["browse"] = browse

        # ---- primary actions ---------------------------------------------
        actions = tk.Frame(self, bg=BG)
        actions.grid(row=2, column=0, sticky="ew", padx=16, pady=(0, 12))
        actions.grid_columnconfigure(0, weight=3)
        for col in range(1, 5):
            actions.grid_columnconfigure(col, weight=1)

        self.play_btn = make_button(actions, "▶  Play", self._play, "accent")
        self.play_btn.configure(font=("TkDefaultFont", 13, "bold"), pady=11)
        self.play_btn.grid(row=0, column=0, sticky="ew", padx=(0, 6))
        self.key_widgets["play"] = self.play_btn

        self.headless_btn = make_button(actions, "Headless report", self._headless)
        self.headless_btn.grid(row=0, column=1, sticky="ew", padx=6)
        self.key_widgets["headless"] = self.headless_btn

        self.build_btn = make_button(actions, "Build", self._build)
        self.build_btn.grid(row=0, column=2, sticky="ew", padx=6)
        self.key_widgets["build"] = self.build_btn

        self.controls_btn = make_button(actions, "Remap controls", self._show_controls)
        self.controls_btn.grid(row=0, column=3, sticky="ew", padx=6)
        self.key_widgets["controls"] = self.controls_btn

        self.stop_btn = make_button(actions, "■  Stop", self._stop, "danger")
        self.stop_btn.configure(state="disabled")
        self.stop_btn.grid(row=0, column=4, sticky="ew", padx=(6, 0))
        self.key_widgets["stop"] = self.stop_btn

        # ---- settings (display | online) ---------------------------------
        settings = self._card(self, 3, pady=(0, 12))
        settings.grid_columnconfigure(0, weight=1, uniform="s")
        settings.grid_columnconfigure(1, weight=1, uniform="s")

        display = tk.Frame(settings, bg=CARD)
        display.grid(row=0, column=0, sticky="nsew", padx=14, pady=12)
        display.grid_columnconfigure(1, weight=1)
        self._section(display, "Display").grid(row=0, column=0, columnspan=3,
                                               sticky="w", pady=(0, 8))
        tk.Label(display, text="Resolution", bg=CARD, fg=TEXT).grid(
            row=1, column=0, sticky="w", pady=4)
        self.res_menu = make_option(
            display, self.resolution_var, [p[0] for p in RESOLUTION_PRESETS], width=20)
        self.res_menu.grid(row=1, column=1, sticky="w", padx=(10, 0), pady=4)
        self.key_widgets["resolution"] = self.res_menu

        tk.Label(display, text="Headless frames", bg=CARD, fg=TEXT).grid(
            row=2, column=0, sticky="w", pady=4)
        self.frames_spin = tk.Spinbox(
            display, from_=1, to=1000000, increment=60,
            textvariable=self.frames_var, width=10, bg=FIELD, fg=TEXT,
            insertbackground=TEXT, buttonbackground=CARD_HI, relief="flat",
            bd=0, highlightthickness=1, highlightbackground=BORDER,
            highlightcolor=ACCENT, justify="left")
        self.frames_spin.grid(row=2, column=1, sticky="w", padx=(10, 0), pady=4,
                              ipady=3)
        self.key_widgets["frames"] = self.frames_spin

        toggles = tk.Frame(display, bg=CARD)
        toggles.grid(row=3, column=0, columnspan=2, sticky="ew", pady=(10, 0))
        for text, var in (("vSync", self.vsync_var),
                          ("Fullscreen", self.fullscreen_var),
                          ("Show FPS", self.fps_var),
                          ("Sound", self.audio_var)):
            btn = make_toggle(toggles, text, var)
            btn.pack(side="left", padx=(0, 6))
            self.key_widgets[f"toggle_{text}"] = btn

        online = tk.Frame(settings, bg=CARD)
        online.grid(row=0, column=1, sticky="nsew", padx=14, pady=12)
        online.grid_columnconfigure(1, weight=1)
        self._section(online, "Online multiplayer").grid(row=0, column=0,
                                                         columnspan=3, sticky="w",
                                                         pady=(0, 8))

        self.online_toggle = make_toggle(online, "Enabled", self.online_var,
                                         command=self._sync_online_state)
        self.online_toggle.grid(row=1, column=0, columnspan=2, sticky="w", pady=(0, 8))
        self.key_widgets["online_toggle"] = self.online_toggle

        tk.Label(online, text="Connection", bg=CARD, fg=TEXT).grid(
            row=2, column=0, sticky="w", pady=4)
        self.conn_menu = make_option(
            online, self.conn_var, [label for label, _k in CONNECTIONS], width=20)
        self.conn_menu.grid(row=2, column=1, sticky="w", padx=(10, 0), pady=4)
        self.key_widgets["connection"] = self.conn_menu

        tk.Label(online, text="Login", bg=CARD, fg=TEXT).grid(
            row=3, column=0, sticky="w", pady=4)
        self.login_entry = make_entry(online, self.login_var)
        self.login_entry.grid(row=3, column=1, sticky="ew", padx=(10, 0), pady=4,
                              ipady=5)
        self.key_widgets["login"] = self.login_entry

        tk.Label(online, text="Password", bg=CARD, fg=TEXT).grid(
            row=4, column=0, sticky="w", pady=4)
        self.password_entry = make_entry(online, self.password_var, show="•")
        self.password_entry.grid(row=4, column=1, sticky="ew", padx=(10, 0), pady=4,
                                 ipady=5)

        tk.Label(online, text="Server", bg=CARD, fg=TEXT).grid(
            row=5, column=0, sticky="w", pady=4)
        self.server_entry = make_entry(online, self.server_var)
        self.server_entry.grid(row=5, column=1, sticky="ew", padx=(10, 0), pady=4,
                               ipady=5)

        self.online_note = tk.Label(
            online,
            text="Credentials are passed as BMO_* environment variables. The runtime "
                 "does not consume them yet.",
            bg=CARD, fg=DIM, justify="left", wraplength=420,
            font=("TkDefaultFont", 9))
        self.online_note.grid(row=6, column=0, columnspan=2, sticky="w", pady=(8, 0))

        # ---- log ----------------------------------------------------------
        log_shell = tk.Frame(self, bg=BORDER, bd=0)
        log_shell.grid(row=7, column=0, sticky="nsew", padx=16, pady=(0, 8))
        log_shell.grid_columnconfigure(0, weight=1)
        log_shell.grid_rowconfigure(1, weight=1)
        log_head = tk.Frame(log_shell, bg=CARD)
        log_head.grid(row=0, column=0, sticky="ew")
        tk.Label(log_head, text="OUTPUT", bg=CARD, fg=MUTED,
                 font=("TkDefaultFont", 9, "bold")).pack(side="left", padx=12, pady=7)
        tk.Button(log_head, text="Clear", command=self._clear_log, bg=CARD, fg=MUTED,
                  activebackground=CARD_HI, activeforeground=TEXT, relief="flat",
                  bd=0, highlightthickness=0, cursor="hand2",
                  font=("TkDefaultFont", 9)).pack(side="right", padx=8)

        self.log = tk.Text(log_shell, height=10, wrap="none", state="disabled",
                           font=("Courier", 10), bg=FIELD, fg="#c8cdd8",
                           insertbackground=TEXT, selectbackground=ACCENT_DIM,
                           selectforeground="#ffffff", relief="flat", bd=0,
                           highlightthickness=0)
        self.log.grid(row=1, column=0, sticky="nsew", padx=1, pady=(0, 1))
        scroll = tk.Scrollbar(log_shell, orient="vertical", command=self.log.yview,
                              bg=CARD, troughcolor=FIELD, relief="flat",
                              activebackground=BORDER)
        scroll.grid(row=1, column=1, sticky="ns", pady=(0, 1), padx=(0, 1))
        self.log.configure(yscrollcommand=scroll.set)
        self.key_widgets["log"] = self.log

        # ---- status bar ---------------------------------------------------
        status = tk.Frame(self, bg=BG)
        status.grid(row=8, column=0, sticky="ew", padx=16, pady=(0, 12))
        status.grid_columnconfigure(0, weight=1)
        self.status_label = tk.Label(status, textvariable=self.status_var, bg=BG,
                                     fg=MUTED, anchor="w", font=("TkDefaultFont", 10))
        self.status_label.grid(row=0, column=0, sticky="w")
        self.busy_label = tk.Label(status, textvariable=self.busy_var, bg=BG,
                                   fg=ACCENT, anchor="e", font=("TkDefaultFont", 10))
        self.busy_label.grid(row=0, column=1, sticky="e")
        tk.Label(status, text=VERSION, bg=BG, fg=DIM, anchor="e",
                 font=("TkDefaultFont", 9)).grid(row=0, column=2, sticky="e",
                                                 padx=(14, 0))

    # ------------------------------------------------------------------ state
    def _collect(self) -> dict:
        preset = PRESET_BY_NAME.get(self.resolution_var.get(), RESOLUTION_PRESETS[0])
        return {
            "disc": self.disc_var.get().strip(),
            "resolution": preset[1],
            "vsync": self.vsync_var.get(),
            "fullscreen": self.fullscreen_var.get(),
            "fps": self.fps_var.get(),
            "audio": self.audio_var.get(),
            "frames": self.frames_var.get().strip() or "600",
            "online": self.online_var.get(),
            "conn": CONN_BY_LABEL.get(self.conn_var.get(), "bba"),
            "login": self.login_var.get().strip(),
            "password": self.password_var.get(),
            "server": self.server_var.get().strip(),
        }

    def _persist(self) -> None:
        self.settings = self._collect()
        write_settings(self.settings)

    def _update_disc_hint(self) -> None:
        path = Path(self.disc_var.get().strip()) if self.disc_var.get().strip() else None
        if path is None:
            self.disc_hint_var.set("No disc selected — Browse… or Auto-detect.")
            self.disc_hint.configure(fg=WARN)
        elif path.is_file():
            size = path.stat().st_size / (1024 * 1024)
            self.disc_hint_var.set(f"{path.name}  ·  {size:,.1f} MiB  ·  {path.parent}")
            self.disc_hint.configure(fg=OK)
        else:
            self.disc_hint_var.set(f"File not found: {path}")
            self.disc_hint.configure(fg=ERR)

    def _refresh_state(self) -> None:
        built = EXE.exists()
        render = renderer_enabled()
        has_disc = bool(self.disc_var.get().strip())

        self.build_chip.configure(
            text="BUILD READY" if built else "NOT BUILT",
            fg=OK if built else ERR)
        self.render_chip.configure(
            text="RENDERER ON" if render else "HEADLESS BUILD",
            fg=OK if render else WARN)

        running = self._proc_alive()
        for name in ("play", "headless", "build", "controls"):
            self.key_widgets[name].configure(state="disabled" if running else "normal")
        self.stop_btn.configure(state="normal" if running else "disabled")

        bits = [
            f"disc: {'set' if has_disc else 'missing'}",
            f"binary: {'present' if built else 'missing'}",
            f"renderer: {'on' if render else 'off'}",
        ]
        if not built:
            bits.append("press Build to compile")
        elif not render:
            bits.append("configured headless — rebuild for a window")
        self.status_var.set("   •   ".join(bits))

    def _sync_online_state(self) -> None:
        state = "normal" if self.online_var.get() else "disabled"
        for widget in (self.conn_menu, self.login_entry, self.password_entry,
                       self.server_entry):
            widget.configure(state=state)

    def _set_busy(self, text: str) -> None:
        self.busy_var.set(text)

    # ------------------------------------------------------------------ log
    def log_line(self, text: str) -> None:
        stamp = time.strftime("%H:%M:%S")
        self.log.configure(state="normal")
        for line in text.rstrip("\n").splitlines() or [""]:
            self.log.insert("end", f"[{stamp}] {line}\n")
        self.log.see("end")
        self.log.configure(state="disabled")

    def _clear_log(self) -> None:
        self.log.configure(state="normal")
        self.log.delete("1.0", "end")
        self.log.configure(state="disabled")

    # ------------------------------------------------------------------ process
    def _proc_alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def _start(self, label: str, cmd: list[str], env: dict | None = None) -> None:
        if self._proc_alive():
            messagebox.showinfo("Busy", "A task is already running. Stop it first.",
                                parent=self)
            return
        self._persist()
        self._set_busy(f"{label} running…")
        self.log_line(f"$ {shlex.join(cmd)}")
        self.proc = subprocess.Popen(
            cmd, cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL, text=True, bufsize=1, env=env,
            start_new_session=True,
        )
        threading.Thread(target=self._pump, args=(self.proc,), daemon=True).start()
        self._refresh_state()

    def _pump(self, proc: subprocess.Popen[str]) -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            self.events.put(("line", line))
        self.events.put(("done", proc.wait()))

    def _drain_events(self) -> None:
        try:
            while True:
                kind, value = self.events.get_nowait()
                if kind == "line":
                    self.log_line(str(value))
                else:
                    self.proc = None
                    self._set_busy("")
                    self.log_line(f"process exited with code {value}")
                    self._refresh_state()
        except queue.Empty:
            pass
        self.after(120, self._drain_events)

    def _stop(self) -> None:
        if not self._proc_alive() or self.proc is None:
            self.log_line("nothing to stop")
            return
        self.log_line("stopping…")
        try:
            os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            self.proc.terminate()

    # ------------------------------------------------------------------ actions
    def _choose_disc(self) -> None:
        initial = Path(self.disc_var.get()).parent if self.disc_var.get() else Path.home()
        path = filedialog.askopenfilename(
            parent=self, title="Choose a Dreamcast disc image",
            initialdir=str(initial) if initial.is_dir() else str(Path.home()),
            filetypes=DISC_TYPES)
        if not path:
            return
        self.disc_var.set(path)
        self._update_disc_hint()
        self._refresh_state()
        self.log_line(f"disc set: {path}")

    def _detect_disc(self) -> None:
        guess = autodetect_disc()
        if not guess:
            messagebox.showwarning(
                "No disc found",
                "No .chd/.gdi/.cue/.cdi image was found in Downloads, Desktop, "
                "Documents, or the port folder.\n\nUse Browse… to pick one.",
                parent=self)
            return
        self.disc_var.set(guess)
        self._update_disc_hint()
        self._refresh_state()
        self.log_line(f"auto-detected disc: {guess}")

    def _play(self) -> None:
        settings = self._collect()
        self._persist()
        if not EXE.exists():
            messagebox.showerror(
                "Not built", "The game binary is missing.\n\nPress Build first.",
                parent=self)
            return
        if not renderer_enabled():
            messagebox.showerror(
                "Headless build",
                "This build was configured with DREAM_RENDERER=OFF, so it cannot open a "
                "window.\n\nRebuild with the renderer enabled (Build), or use "
                "Headless report.",
                parent=self)
            return
        if not settings["disc"]:
            messagebox.showerror(
                "No disc image", "Choose a disc image first.", parent=self)
            return
        if not Path(settings["disc"]).is_file():
            messagebox.showerror(
                "Disc not found", f"File does not exist:\n{settings['disc']}",
                parent=self)
            return
        if os.environ.get("BMO_LAUNCHER_DRY_RUN") == "1":
            self.log_line("dry run — not launching")
            self.log_line(shlex.join(build_play_command(settings)))
            return
        self.log_line("launching game…")
        self._start("game", build_play_command(settings), env=online_environment(settings))

    def _headless(self) -> None:
        settings = self._collect()
        self._persist()
        if not EXE.exists():
            messagebox.showerror(
                "Not built", "The game binary is missing.\n\nPress Build first.",
                parent=self)
            return
        self.log_line("running headless report…")
        self._start("headless report", build_headless_command(settings))

    def _build(self) -> None:
        self.log_line("building…")
        self._start("build", build_build_command())

    def _show_controls(self) -> None:
        ControlsEditor(self)

    def _raise_window(self) -> None:
        try:
            self.deiconify()
            self.lift()
            self.focus_force()
        except tk.TclError:
            pass

    def _on_close(self) -> None:
        if self._proc_alive():
            if not messagebox.askyesno(
                    "Quit", "A task is still running. Stop it and quit?", parent=self):
                return
            self._stop()
            if self.proc is not None:
                try:
                    self.proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)
                    except OSError:
                        pass
        self._persist()
        self.destroy()


# ---------------------------------------------------------------------------
# Self-test: proves the UI is laid out and the commands are right, without
# launching the game or the compiler.
# ---------------------------------------------------------------------------
def run_selftest() -> int:
    os.environ["BMO_LAUNCHER_DRY_RUN"] = "1"
    app = Launcher(selftest=True)
    app.update_idletasks()
    app.update()
    app.after(80, app.update)
    app.update()

    failures: list[str] = []
    print(f"window: {app.winfo_width()}x{app.winfo_height()} at "
          f"{app.winfo_rootx()},{app.winfo_rooty()} mapped={app.winfo_ismapped()}")

    print("\n-- widgets --")
    for name, widget in app.key_widgets.items():
        mapped = widget.winfo_ismapped()
        width, height = widget.winfo_width(), widget.winfo_height()
        x, y = widget.winfo_rootx(), widget.winfo_rooty()
        state = ""
        try:
            state = str(widget.cget("state"))
        except tk.TclError:
            pass
        print(f"{name:16} mapped={str(mapped):5} {width:4}x{height:<4} "
              f"@ {x:5},{y:4} state={state}")
        if not mapped:
            failures.append(f"{name} is not mapped")
        if width < 8 or height < 8:
            failures.append(f"{name} has degenerate size {width}x{height}")

    print("\n-- text visibility --")
    disc = app.disc_entry.get()
    print(f"disc entry text: {disc!r}")
    if app.disc_var.get() and disc != app.disc_var.get():
        failures.append("disc entry does not show the selected path")
    ratio = contrast(app.disc_entry, TEXT, FIELD)
    print(f"entry contrast: {ratio:.1f}:1")
    if ratio < 4.5:
        failures.append(f"entry contrast too low ({ratio:.1f}:1)")

    print(f"resolution menu: {app.resolution_var.get()!r}")
    if app.resolution_var.get() not in PRESET_BY_NAME:
        failures.append("resolution menu does not contain the selected preset")

    print(f"online state: {app.online_var.get()} "
          f"connection={app.conn_var.get()!r}")
    conn_state = str(app.login_entry.cget("state"))
    print(f"login entry state when online={app.online_var.get()}: {conn_state}")
    expected = "normal" if app.online_var.get() else "disabled"
    if conn_state != expected:
        failures.append(f"online fields should be {expected}, got {conn_state}")

    print("\n-- resolved commands --")
    settings = app._collect()
    for label, cmd in (("play", build_play_command(settings)),
                       ("headless", build_headless_command(settings)),
                       ("build", build_build_command())):
        print(f"{label:9} {shlex.join(cmd)}")
        if not Path(cmd[0]).exists():
            failures.append(f"{label}: {cmd[0]} is missing")

    # Exercise the button callbacks in dry-run mode; they must not raise.
    print("\n-- callbacks (dry run) --")
    for name in ("play", "headless"):
        try:
            app.key_widgets[name].invoke()
            print(f"{name}.invoke() ok")
        except Exception as exc:  # noqa: BLE001 - self-test wants any failure
            failures.append(f"{name}.invoke() raised {exc!r}")
    app._detect_disc()
    print(f"auto-detect -> {app.disc_var.get()!r}")

    app.destroy()

    print("\n-- result --")
    if failures:
        for failure in failures:
            print(f"FAIL: {failure}")
        return 1
    print("PASS: all widgets mapped, coloured, and commands resolved")
    return 0


def main(argv: list[str]) -> int:
    if "--selftest" in argv:
        return run_selftest()
    if "--version" in argv:
        print(VERSION)
        return 0
    if not DC.exists():
        print(f"missing {DC}", file=sys.stderr)
        return 1
    if not GAME_TOML.exists():
        print(f"missing {GAME_TOML}", file=sys.stderr)
        return 1
    app = Launcher()
    app.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
