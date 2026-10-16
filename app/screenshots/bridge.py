"""Serves the simulated sidecar over HTTP so the web UI can run in a plain browser.

GET /events streams every sidecar line as server-sent events; POST /send writes one request line.
Used by shoot.mjs to take README screenshots without the Tauri shell.
"""

import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SIDECAR = Path(__file__).resolve().parents[2] / "sidecar"
PORT = 1430

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
            lines.append(line.rstrip("\n"))
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
        sidecar.stdin.write(body.strip() + "\n")
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
