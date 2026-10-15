#!/usr/bin/env python3
"""Drive an interactive Claude Code session with a mod loaded, in a pseudo-terminal.

Runs one scripted session: launches `claude --plugin-dir <mod>` in a pty, plays
the steps in order, and writes each shot as text. It needs a pty but no tmux
socket.

    driver.py [--mod DIR] [--cwd DIR] [--size COLSxROWS] [--claude-args "ARGS"] STEP...

Steps, played in order:
    --send TEXT      type TEXT, then Enter
    --keys NAME      press a key: Enter, Escape, Up, Down, Tab, CtrlC
    --wait REGEX     wait until the screen matches REGEX (60s, or --timeout)
    --idle SECONDS   wait until the screen has not changed for SECONDS
    --shot NAME      write the screen to <out>/NAME.txt and <out>/NAME.ansi
    --timeout SECS   timeout for the waits that follow

In NAME.txt, a line drawn with underlines or strikethrough gets a marker line
under it: the underline's colour initial (r red, y yellow, b blue, g green,
u other) under each underlined cell, and `-` under each struck-through cell.
NAME.ansi has the colours back; `cat` it in a terminal to see the screen.
<out>/raw.log keeps every byte claude wrote.

Runs on any python3: pyte and wcwidth sit in vendor/. Exits 1 when a wait
times out, after writing the screen to <out>/timeout.txt.
"""

import argparse
import fcntl
import os
import pty
import re
import select
import shlex
import struct
import sys
import termios
import time

# pyte and wcwidth live in vendor/, so the driver needs no venv and the sandbox
# exclusion can name the plain python3 every machine has.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))
import pyte  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
KEYS = {"Enter": "\r", "Escape": "\x1b", "Up": "\x1b[A", "Down": "\x1b[B", "Tab": "\t", "CtrlC": "\x03"}
STEP_FLAGS = {"--send", "--keys", "--wait", "--idle", "--shot", "--timeout"}
COLOUR_INITIAL = {"red": "r", "yellow": "y", "blue": "b", "green": "g"}


def parse(argv):
    # Split the global options from the ordered steps: argparse loses the order.
    head, steps, i = [], [], 0
    while i < len(argv):
        if argv[i] in STEP_FLAGS:
            if i + 1 >= len(argv):
                sys.exit(f"{argv[i]} needs a value")
            steps.append((argv[i][2:], argv[i + 1]))
            i += 2
        else:
            head.append(argv[i])
            i += 1
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--mod", default=os.path.normpath(os.path.join(HERE, "../../../mods/prose-lint")))
    p.add_argument("--cwd", default=None, help="folder Claude runs in (default: a fresh temp folder)")
    p.add_argument("--out", default=None, help="where shots go (default: <cwd>/shots)")
    p.add_argument("--size", default="120x50")
    p.add_argument("--claude-args", default="", help='extra arguments for claude, as one string: "--model haiku"')
    return p.parse_args(head), steps


# pyte drops the private marker of a sequence such as CSI > 4 ; 2 m (xterm's
# modifyOtherKeys) and reads it as SGR 4, so every cell after it would show
# underlined. They set terminal modes, not how text looks, so they go.
PRIVATE_M = re.compile(rb"\x1b\[[<=>?][0-9;:]*m")


class Session:
    def __init__(self, argv, cwd, cols, rows, raw_path):
        self.screen = pyte.Screen(cols, rows)
        self.stream = pyte.ByteStream(self.screen)
        self.raw = open(raw_path, "wb")
        # The tail of a read that may be an escape sequence cut in two.
        self.pending = b""
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(cwd)
            os.environ["TERM"] = "xterm-256color"
            os.execvp(argv[0], argv)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.changed = time.time()

    def pump(self, seconds):
        end = time.time() + seconds
        while (left := end - time.time()) > 0:
            ready, _, _ = select.select([self.fd], [], [], left)
            if not ready:
                return
            try:
                data = os.read(self.fd, 65536)
            except OSError:
                raise SystemExit("claude exited")
            if not data:
                raise SystemExit("claude exited")
            self.raw.write(data)
            self.raw.flush()
            data = self.pending + data
            cut = data.rfind(b"\x1b")
            if cut != -1 and not re.search(rb"[@-~]", data[cut + 2 :]):
                data, self.pending = data[:cut], data[cut:]
            else:
                self.pending = b""
            self.stream.feed(PRIVATE_M.sub(b"", data))
            self.changed = time.time()

    def type(self, text):
        # A character at a time: one write of the whole text can land as a paste,
        # which the prompt shows as "[Pasted text]" instead of the words.
        for ch in text:
            os.write(self.fd, ch.encode())
            self.pump(0.005)
        self.pump(0.3)

    def text(self):
        return "\n".join(line.rstrip() for line in self.screen.display)

    def marked(self):
        out = []
        for y in range(self.screen.lines):
            row = self.screen.buffer[y]
            chars = [row[x] for x in range(self.screen.columns)]
            out.append("".join(c.data for c in chars).rstrip())
            marks = "".join(
                "-" if c.strikethrough else colour_initial(c.fg) if c.underscore else " " for c in chars
            ).rstrip()
            if marks:
                out.append(marks)
        return "\n".join(out)

    def ansi(self):
        out = []
        for y in range(self.screen.lines):
            row = self.screen.buffer[y]
            line = []
            for x in range(self.screen.columns):
                c = row[x]
                codes = []
                if c.bold:
                    codes.append("1")
                if c.underscore:
                    codes.append("4")
                if c.strikethrough:
                    codes.append("9")
                if c.fg != "default":
                    codes.append(sgr_fg(c.fg))
                line.append(f"\x1b[0;{';'.join(codes)}m{c.data}" if codes else f"\x1b[0m{c.data}")
            out.append("".join(line).rstrip() + "\x1b[0m")
        return "\n".join(out)


def colour_initial(fg):
    # Claude Code draws in 24-bit colour (pyte keeps it as "e5484d"), so a
    # named colour is rare; the strongest channel names it.
    if fg in COLOUR_INITIAL:
        return COLOUR_INITIAL[fg]
    if not re.fullmatch(r"[0-9a-fA-F]{6}", fg):
        return "u"
    r, g, b = (int(fg[i : i + 2], 16) for i in (0, 2, 4))
    if r > 150 and g > 150 and b < 100:
        return "y"
    if max(r, g, b) - min(r, g, b) < 40:
        return "u"
    return "r" if r == max(r, g, b) else "g" if g == max(r, g, b) else "b"


def sgr_fg(fg):
    names = ["black", "red", "green", "brown", "blue", "magenta", "cyan", "white"]
    if fg in names:
        return str(30 + names.index(fg))
    if fg == "yellow":
        return "33"
    if re.fullmatch(r"[0-9a-fA-F]{6}", fg):
        return f"38;2;{int(fg[0:2], 16)};{int(fg[2:4], 16)};{int(fg[4:6], 16)}"
    return "39"


def main():
    opts, steps = parse(sys.argv[1:])
    cwd = opts.cwd or os.path.join(os.environ.get("TMPDIR", "/tmp"), f"prose-lint-run-{os.getpid()}")
    os.makedirs(cwd, exist_ok=True)
    out = opts.out or os.path.join(cwd, "shots")
    os.makedirs(out, exist_ok=True)
    cols, rows = (int(n) for n in opts.size.split("x"))
    argv = ["claude", "--plugin-dir", os.path.abspath(opts.mod), *shlex.split(opts.claude_args)]
    print(f"cwd {cwd}\nshots {out}\n$ {' '.join(argv)}", flush=True)
    s = Session(argv, cwd, cols, rows, os.path.join(out, "raw.log"))
    timeout = 60.0
    try:
        for kind, value in steps:
            print(f"> {kind} {value}", flush=True)
            if kind == "send":
                s.type(value)
                s.type("\r")
            elif kind == "keys":
                s.type(KEYS[value])
            elif kind == "timeout":
                timeout = float(value)
            elif kind == "wait":
                end = time.time() + timeout
                while not re.search(value, s.text()):
                    if time.time() > end:
                        write(out, "timeout", s)
                        sys.exit(f"timed out after {timeout:g}s waiting for /{value}/; screen in {out}/timeout.txt")
                    s.pump(0.2)
            elif kind == "idle":
                end = time.time() + timeout
                while time.time() - s.changed < float(value):
                    if time.time() > end:
                        break
                    s.pump(0.2)
            elif kind == "shot":
                write(out, value, s)
                print(f"  wrote {out}/{value}.txt", flush=True)
    finally:
        try:
            os.kill(s.pid, 15)
        except ProcessLookupError:
            pass


def write(out, name, s):
    with open(os.path.join(out, f"{name}.txt"), "w") as f:
        f.write(s.marked() + "\n")
    with open(os.path.join(out, f"{name}.ansi"), "w") as f:
        f.write(s.ansi() + "\n")


if __name__ == "__main__":
    main()
