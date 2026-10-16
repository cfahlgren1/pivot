"""Serves the simulated sidecar over HTTP so the web UI can run in a plain browser.

GET /events streams every sidecar line as server-sent events; POST /send writes one request line.
Used by shoot.mjs to take README screenshots without the Tauri shell. The simulated boards are shown with
the names real SO-101 boards get on macOS, so screenshots match what users see.
"""

import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SIDECAR = Path(__file__).resolve().parents[2] / "sidecar"
PORT = 1430

# Simulated name -> what a real board shows. Requests from the UI are mapped back.
REAL_NAMES = {
    "/dev/tty.fake-claw-arm": "/dev/tty.usbmodem5A7A0185481",
    "/dev/tty.fake-handle-arm": "/dev/tty.usbmodem5A7A0187091",
    "Simulated claw arm": "USB Single Serial",
    "Simulated handle arm": "USB Single Serial",
}


def rename(text: str, names: dict[str, str]) -> str:
    for old, new in names.items():
        text = text.replace(old, new)
    return text


sidecar = subprocess.Popen(
    ["uv", "run", "--quiet", "--project", str(SIDECAR), "pivot-sidecar", "--fake", *sys.argv[1:]],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    text=True,
    bufsize=1,
)
lines: list[str] = []
arrived = threading.Condition()


def pump() -> None:
    for line in sidecar.stdout:
        with arrived:
            lines.append(rename(line.rstrip("\n"), REAL_NAMES))
            arrived.notify_all()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args) -> None:
        pass

    def cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_POST(self) -> None:
        body = self.rfile.read(int(self.headers["Content-Length"])).decode()
        ports_back = {real: fake for fake, real in REAL_NAMES.items() if fake.startswith("/dev/")}
        sidecar.stdin.write(rename(body.strip(), ports_back) + "\n")
        sidecar.stdin.flush()
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_GET(self) -> None:
        self.send_response(200)
        self.cors()
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        sent = 0
        while True:
            with arrived:
                arrived.wait_for(lambda sent=sent: len(lines) > sent)
                batch = lines[sent:]
            try:
                for line in batch:
                    self.wfile.write(f"data: {line}\n\n".encode())
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return  # the page closed its event stream
            sent += len(batch)


threading.Thread(target=pump, daemon=True).start()
ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
