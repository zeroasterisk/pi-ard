#!/usr/bin/env python3
"""
Record a real terminal session of installing and using pi-ard in Pi, as an asciicast v2 file.

Everything shown is genuine I/O: a real bash in a real PTY runs `pi install`, then the
interactive Pi TUI talks to a real model and queries the live Hugging Face registry. The
recorder only types keystrokes, and it types each one after the screen shows what a person
would wait for (a prompt, a dialog), so nothing is scripted output.

Adapted from zeroasterisk/ard-plugin-exploration scripts/record_real_pty_session.py.

  PI_CODING_AGENT_DIR=<agent dir with a model configured> python3 demo/record.py [out.cast]

No Google Cloud and no OpenCode: any Pi-supported model works (configure it in models.json).
"""
import fcntl, json, os, pty, re, select, struct, subprocess, sys, termios, threading, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "demo" / "pi-ard.cast"
COLS, ROWS = 110, 34
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b[=>]")


class Session:
    def __init__(self):
        self.events, self.buf, self.lock = [], "", threading.Lock()
        self.master, slave = pty.openpty()
        for fd in (self.master, slave):
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
        env = {**os.environ, "TERM": "xterm-256color", "COLUMNS": str(COLS), "LINES": str(ROWS),
               "PS1": "\\[\\033[1;32m\\]you@laptop\\[\\033[0m\\]:\\[\\033[1;34m\\]~/project\\[\\033[0m\\]$ ",
               "PI_TELEMETRY": "0"}
        self.proc = subprocess.Popen(["/bin/bash", "--norc", "--noprofile"], stdin=slave, stdout=slave,
                                     stderr=slave, cwd=os.environ.get("DEMO_CWD", str(ROOT)), env=env, close_fds=True)
        os.close(slave)
        self.t0 = time.time()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        while True:
            try:
                r, _, _ = select.select([self.master], [], [], 0.05)
                if r:
                    data = os.read(self.master, 65536)
                    if not data:
                        return
                    text = data.decode("utf-8", errors="replace")
                    with self.lock:
                        self.events.append([round(time.time() - self.t0, 3), "o", text])
                        self.buf += ANSI.sub("", text)
            except OSError:
                return

    def wait(self, pattern, timeout=180):
        """Block until the (ANSI-stripped) output since the last mark matches `pattern`."""
        rx, end = re.compile(pattern), time.time() + timeout
        while time.time() < end:
            with self.lock:
                if rx.search(self.buf):
                    return
            time.sleep(0.1)
        with self.lock:
            tail = self.buf[-1500:]
        raise TimeoutError(f"waiting for {pattern!r}; screen tail:\n{tail}")

    def mark(self):
        with self.lock:
            self.buf = ""

    def type(self, text, delay=0.04, enter=True):
        self.mark()
        for ch in text:
            os.write(self.master, ch.encode())
            time.sleep(delay)
        if enter:
            time.sleep(0.4)
            os.write(self.master, b"\r")

    def key(self, seq):
        self.mark()
        os.write(self.master, seq)

    def save(self, path):
        header = {"version": 2, "width": COLS, "height": ROWS, "timestamp": int(self.t0),
                  "title": "pi-ard: Agentic Resource Discovery in Pi",
                  "env": {"TERM": "xterm-256color", "SHELL": "/bin/bash"}}
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w") as f:
            f.write(json.dumps(header) + "\n")
            for e in self.events:
                f.write(json.dumps(e) + "\n")


PROMPT = r"you@laptop.*\$ $"
s = Session()
try:
    s.wait(r"\$ ")
    s.type("clear"); s.wait(PROMPT)
    pi = os.environ.get("PI_BIN", "pi")

    s.type("# 1. Install the package"); s.wait(PROMPT)
    s.type(f"{pi} install {os.environ.get('PI_ARD_SRC', 'git:github.com/zeroasterisk/pi-ard')}"); s.wait(PROMPT, 240)
    s.type(f"{pi} list"); s.wait(PROMPT)
    time.sleep(1.5)

    s.type("# Optional: which publishers count as trusted (default: huggingface.co only)"); s.wait(PROMPT)
    s.type("cat ~/.pi/agent/pi-ard/config.json"); s.wait(PROMPT)
    time.sleep(2.5)

    s.type("# 2. Start Pi and ask for things in plain language"); s.wait(PROMPT)
    s.type(pi, enter=True)
    s.wait(r"(?s)(claude|model|\bpi\b).*", 60)
    time.sleep(3)

    s.type("/ard"); s.wait(r"trustedDomains", 60)
    time.sleep(3)

    s.type("Find a Hugging Face skill for fine-tuning a language model. List the top 3, don't install.")
    s.wait(r"ard_search", 120)
    s.wait(r"huggingface-llm-trainer|trl-training", 180)
    time.sleep(8)

    s.type("Install the huggingface-llm-trainer skill.")
    s.wait(r"Install skill", 240)          # Pi's confirm dialog, raised by ard_install
    time.sleep(4)                          # let a viewer read it
    s.key(b"\r")                           # answer the dialog (default selection: Yes)
    s.wait(r"installed: skill", 120)
    time.sleep(10)

    s.type("Now add the official Hugging Face MCP server for this session.")
    s.wait(r"Add MCP server", 240)
    time.sleep(4)
    s.key(b"\r")
    s.wait(r"mcp-ready", 120)
    time.sleep(10)

    s.type("/quit"); s.wait(PROMPT, 30)
    s.type("ls ~/.pi/agent/skills/ && head -3 ~/.pi/agent/skills/huggingface-llm-trainer/SKILL.md | cut -c1-100")
    s.wait(r"description:"); s.wait(PROMPT)
    time.sleep(4)
finally:
    s.save(OUT)
    try:
        s.proc.terminate()
    except Exception:
        pass
    print(f"wrote {OUT} ({len(s.events)} events, {s.events[-1][0] if s.events else 0}s)")
