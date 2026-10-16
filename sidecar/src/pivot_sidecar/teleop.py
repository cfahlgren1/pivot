"""Leader → follower teleoperation with a soft start and recovery from dropped reads.

LeRobot's `lerobot-teleoperate` snaps the follower to the leader's pose on the first frame and
exits on the first failed bus read. Here the follower eases into the pose over a second, and a
brief dropout is retried, then the arm is reconnected, before giving up.
"""

import threading
import time
from collections.abc import Callable

from pivot_sidecar.hardware import Arm

SOFT_START_SECONDS = 1.0
STATUS_EVERY_SECONDS = 0.1
# Consecutive failed frames before reconnecting (~0.25 s at 60 Hz), and reconnects before giving up.
FAILURES_BEFORE_RECONNECT = 15
MAX_RECONNECTS = 3


def blend(start: dict[str, float], target: dict[str, float], amount: float) -> dict[str, float]:
    return {
        joint: start.get(joint, value) + (value - start.get(joint, value)) * amount
        for joint, value in target.items()
    }


class TeleopLoop:
    def __init__(self, follower: Arm, leader: Arm, emit: Callable[[str, dict], None], fps: int = 60):
        self.follower, self.leader, self.emit, self.fps = follower, leader, emit, fps
        self._stop = threading.Event()
        self._relax_on_stop = False
        self._thread = threading.Thread(target=self._run, name="teleop", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self, relax: bool) -> None:
        self._relax_on_stop = relax
        self._stop.set()
        self._thread.join(timeout=3)

    def _run(self) -> None:
        try:
            self.leader.connect()
            self.follower.connect()
            self._soft_start()
            self._loop()
        except Exception as exc:  # reported to the UI; the loop owns the arms until it ends
            self.emit("teleop", {"state": "error", "message": str(exc)})
        finally:
            self.follower.disconnect(relax=self._relax_on_stop)
            self.leader.disconnect(relax=True)
            self.emit("teleop", {"state": "stopped"})

    def _soft_start(self) -> None:
        start = self.follower.read_joints()
        began = time.monotonic()
        while not self._stop.is_set():
            amount = min(1.0, (time.monotonic() - began) / SOFT_START_SECONDS)
            target = self.leader.read_joints()
            self.follower.send_joints(blend(start, target, amount))
            self.emit("teleop", {"state": "easing_in", "progress": round(amount, 2), "leader": target})
            if amount >= 1.0:
                return
            time.sleep(1 / self.fps)

    def _loop(self) -> None:
        period = 1 / self.fps
        failures, reconnects = 0, 0
        frames, window_start, last_status = 0, time.monotonic(), 0.0
        while not self._stop.is_set():
            frame_start = time.monotonic()
            try:
                action = self.leader.read_joints()
                self.follower.send_joints(action)
                failures = 0
                frames += 1
            except (ConnectionError, OSError, RuntimeError) as exc:
                failures += 1
                if failures == 1:
                    self.emit("teleop", {"state": "retrying", "message": str(exc)})
                if failures >= FAILURES_BEFORE_RECONNECT:
                    reconnects += 1
                    if reconnects > MAX_RECONNECTS:
                        raise ConnectionError(
                            f"Lost the arms after {MAX_RECONNECTS} reconnects: {exc}"
                        ) from exc
                    self._reconnect()
                    failures = 0
                continue

            now = time.monotonic()
            if now - last_status >= STATUS_EVERY_SECONDS:
                hz = frames / max(now - window_start, 1e-6)
                self.emit("teleop", {"state": "running", "hz": round(hz, 1), "leader": action})
                frames, window_start, last_status = 0, now, now
            time.sleep(max(0.0, period - (time.monotonic() - frame_start)))

    def _reconnect(self) -> None:
        self.emit("teleop", {"state": "reconnecting"})
        for arm in (self.leader, self.follower):
            arm.disconnect(relax=False)
            arm.connect()
