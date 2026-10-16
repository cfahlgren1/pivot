"""JSON-lines protocol between the Pivot app and the arms.

Requests (one per line on stdin):   {"id": 1, "method": "probe", "params": {"port": "..."}}
Responses (stdout):                 {"id": 1, "result": {...}}  or  {"id": 1, "error": {"message": "..."}}
Events (stdout, unprompted):        {"event": "ranges", "data": {...}}

Only one hardware job (identify, calibration or teleoperation) runs at a time; starting one stops
the previous one.
"""

import argparse
import json
import logging
import sys
import threading
import time
from collections.abc import Callable
from datetime import datetime

from pivot_sidecar import __version__
from pivot_sidecar.calibration import RangeRecorder
from pivot_sidecar.diagnose import diagnose
from pivot_sidecar.fake import FakeArm, FakeBoard, FakeRig
from pivot_sidecar.hardware import Arm, Board, RealArm, RealBoard, list_boards
from pivot_sidecar.identify import MotionDetector
from pivot_sidecar.joints import Role
from pivot_sidecar.teleop import TeleopLoop

SAMPLE_HZ = 60
RANGES_EVENT_HZ = 15
IDENTIFY_HZ = 30


class Writer:
    def __init__(self, stream):
        self._stream = stream
        self._lock = threading.Lock()

    def send(self, message: dict) -> None:
        line = json.dumps(message, separators=(",", ":"))
        with self._lock:
            self._stream.write(line + "\n")
            self._stream.flush()

    def event(self, name: str, data: dict) -> None:
        self.send({"event": name, "data": data})


class Job:
    """A background loop the server can stop."""

    def __init__(self, name: str, target: Callable[[threading.Event], None]):
        self.name = name
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=target, args=(self.stop_event,), name=name, daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        self.thread.join(timeout=3)


class Server:
    def __init__(self, writer: Writer, rig: FakeRig | None):
        self.writer, self.rig = writer, rig
        self.job: Job | None = None
        self.calibrating: tuple[Arm, RangeRecorder | None] | None = None
        self.teleop: TeleopLoop | None = None

    # ── factories ──────────────────────────────────────────────
    def board(self, port: str) -> Board:
        return FakeBoard(port, self.rig) if self.rig else RealBoard(port)

    def arm(self, role: str, port: str, arm_id: str) -> Arm:
        role = Role(role)
        return FakeArm(role, port, arm_id, self.rig) if self.rig else RealArm(role, port, arm_id)

    def stop_everything(self) -> None:
        if self.job:
            self.job.stop()
            self.job = None
        if self.teleop:
            self.teleop.stop(relax=False)
            self.teleop = None
        if self.calibrating:
            self.calibrating[0].disconnect(relax=True)
            self.calibrating = None

    # ── methods ────────────────────────────────────────────────
    def hello(self) -> dict:
        return {
            "version": __version__,
            "fake": self.rig is not None,
            "scenario": self.rig and self.rig.scenario,
        }

    def list_boards(self) -> dict:
        return {"boards": self.rig.boards() if self.rig else list_boards()}

    def probe(self, port: str) -> dict:
        board = self.board(port)
        board.open()
        try:
            motors = board.ping_all()
            status = board.read_status() if motors else {"voltages": {}, "temperatures": {}}
        finally:
            board.close()
        return {"port": port, "motors": motors, **status, "diagnosis": diagnose(motors).to_dict()}

    def identify_start(self, ports: list[str]) -> dict:
        self.stop_everything()
        if self.rig:
            self.rig.wiggling = self.rig.boards()[0]["port"]
        detector = MotionDetector(ports)

        def run(stop: threading.Event) -> None:
            boards = [self.board(p) for p in ports]
            for b in boards:
                b.open()
            try:
                while not stop.is_set():
                    for b in boards:
                        detector.add_sample(b.port, b.raw_positions())
                    self.writer.event(
                        "identify", {"motion": {p: round(m) for p, m in detector.motion.items()}}
                    )
                    if moving := detector.moving_port():
                        other = next(p for p in ports if p != moving)
                        self.writer.event("identified", {"follower": moving, "leader": other})
                        return
                    time.sleep(1 / IDENTIFY_HZ)
            finally:
                for b in boards:
                    b.close()

        self.job = Job("identify", run)
        return {"started": True}

    def identify_stop(self) -> dict:
        self.stop_everything()
        return {"stopped": True}

    def calibration_info(self, role: str, port: str, arm_id: str) -> dict:
        path = self.arm(role, port, arm_id).calibration_path
        if not path.is_file():
            return {"exists": False, "path": str(path)}
        modified = datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="minutes")
        return {"exists": True, "path": str(path), "modified": modified}

    def calibrate_begin(self, role: str, port: str, arm_id: str) -> dict:
        self.stop_everything()
        arm = self.arm(role, port, arm_id)
        arm.connect()
        arm.begin_calibration()
        self.calibrating = (arm, None)
        return {"relaxed": True}

    def calibrate_set_middle(self) -> dict:
        if not self.calibrating:
            raise RuntimeError("Calibration hasn't started.")
        arm = self.calibrating[0]
        arm.set_middle()
        recorder = RangeRecorder(arm.role, started_at=time.monotonic())
        self.calibrating = (arm, recorder)

        def run(stop: threading.Event) -> None:
            last_event = 0.0
            while not stop.is_set():
                now = time.monotonic()
                recorder.add_sample(arm.raw_positions(), now)
                if now - last_event >= 1 / RANGES_EVENT_HZ:
                    self.writer.event("ranges", recorder.snapshot())
                    last_event = now
                time.sleep(1 / SAMPLE_HZ)

        self.job = Job("ranges", run)
        return {"recording": True}

    def calibrate_finish(self) -> dict:
        if not self.calibrating or not self.calibrating[1]:
            raise RuntimeError("Save the middle position first.")
        arm, recorder = self.calibrating
        mins, maxes = recorder.limits()
        if self.job:
            self.job.stop()
            self.job = None
        path = arm.save_calibration(mins, maxes)
        arm.disconnect(relax=True)
        self.calibrating = None
        return {"path": str(path), "mins": mins, "maxes": maxes}

    def calibrate_cancel(self) -> dict:
        self.stop_everything()
        return {"cancelled": True}

    def teleop_start(self, follower: dict, leader: dict) -> dict:
        self.stop_everything()
        self.teleop = TeleopLoop(
            self.arm("follower", follower["port"], follower["arm_id"]),
            self.arm("leader", leader["port"], leader["arm_id"]),
            self.writer.event,
        )
        self.teleop.start()
        return {"started": True}

    def teleop_stop(self, relax: bool = False) -> dict:
        if self.teleop:
            self.teleop.stop(relax=relax)
            self.teleop = None
        return {"stopped": True, "relaxed": relax}

    # ── dispatch ───────────────────────────────────────────────
    METHODS = {
        "hello",
        "list_boards",
        "probe",
        "identify_start",
        "identify_stop",
        "calibration_info",
        "calibrate_begin",
        "calibrate_set_middle",
        "calibrate_finish",
        "calibrate_cancel",
        "teleop_start",
        "teleop_stop",
    }

    def handle(self, request: dict) -> None:
        request_id, method = request.get("id"), request.get("method")
        if method not in self.METHODS:
            self.writer.send({"id": request_id, "error": {"message": f"Unknown method: {method}"}})
            return
        try:
            result = getattr(self, method)(**request.get("params", {}))
            self.writer.send({"id": request_id, "result": result})
        except Exception as exc:
            logging.exception("%s failed", method)
            self.writer.send({"id": request_id, "error": {"message": str(exc), "type": type(exc).__name__}})


def main() -> None:
    parser = argparse.ArgumentParser(description="Pivot hardware sidecar (JSON lines on stdin/stdout).")
    parser.add_argument("--fake", action="store_true", help="Use simulated arms instead of real hardware.")
    parser.add_argument("--scenario", default="healthy", choices=["healthy", "leader_unpowered", "glitch"])
    args = parser.parse_args()

    # Protocol messages own stdout; anything else LeRobot prints goes to stderr.
    writer = Writer(sys.stdout)
    sys.stdout = sys.stderr
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(levelname)s %(name)s: %(message)s")

    server = Server(writer, FakeRig(scenario=args.scenario) if args.fake else None)
    writer.event("ready", server.hello())
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
            except json.JSONDecodeError as exc:
                writer.send({"id": None, "error": {"message": f"Bad JSON: {exc}"}})
                continue
            # Requests run one at a time; anything long-running lives in a background Job.
            server.handle(request)
    finally:
        server.stop_everything()


if __name__ == "__main__":
    main()
