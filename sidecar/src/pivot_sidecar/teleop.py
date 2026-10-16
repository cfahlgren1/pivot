"""Teleoperation with a soft start and recovery from dropped reads, optionally recording episodes.

LeRobot's `lerobot-teleoperate` snaps the follower to the leader's pose on the first frame and
exits on the first failed bus read. Here the follower eases into the pose over a second, and a
brief dropout is retried, then the arms are reconnected, before giving up. Targets come from a
Source: the leader arm or a game controller.
"""

import threading
import time
from collections.abc import Callable

from pivot_sidecar.drive import Source
from pivot_sidecar.hardware import Arm
from pivot_sidecar.recording import Episode, EpisodeRecorder

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
    def __init__(self, follower: Arm, source: Source, emit: Callable[[str, dict], None], fps: int = 60):
        self.follower, self.source, self.emit, self.fps = follower, source, emit, fps
        self._stop = threading.Event()
        self._relax_on_stop = False
        self._recorder: EpisodeRecorder | None = None
        self._thread = threading.Thread(target=self._run, name="teleop", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self, relax: bool) -> None:
        self._relax_on_stop = relax
        self._stop.set()
        self._thread.join(timeout=3)

    @property
    def recording(self) -> bool:
        return self._recorder is not None

    def start_recording(self, task: str) -> None:
        if self._recorder:
            raise RuntimeError("Already recording.")
        self._recorder = EpisodeRecorder(task, self.source.name, started_at=time.monotonic())

    def stop_recording(self) -> Episode:
        recorder, self._recorder = self._recorder, None
        if not recorder:
            raise RuntimeError("Not recording.")
        return recorder.episode

    def _run(self) -> None:
        try:
            self.follower.connect()
            self.source.connect()
            self._soft_start()
            self._loop()
        except Exception as exc:  # reported to the UI; the loop owns the arms until it ends
            self.emit("teleop", {"state": "error", "message": str(exc)})
        finally:
            self._recorder = None
            self.follower.disconnect(relax=self._relax_on_stop)
            self.source.disconnect()
            self.emit("teleop", {"state": "stopped"})

    def _soft_start(self) -> None:
        start = self.follower.read_joints()
        began = time.monotonic()
        while not self._stop.is_set():
            amount = min(1.0, (time.monotonic() - began) / SOFT_START_SECONDS)
            target = self.source.target()
            self.follower.send_joints(blend(start, target, amount))
            self.emit("teleop", {"state": "easing_in", "progress": round(amount, 2), "target": target})
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
                action = self.source.target()
                self.follower.send_joints(action)
                recorder = self._recorder
                if recorder and recorder.wants_sample(frame_start):
                    recorder.add(frame_start, action, self.follower.read_joints())
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
                status = {"state": "running", "hz": round(hz, 1), "target": action, **self.source.status()}
                if self._recorder:
                    status["recording_seconds"] = round(now - self._recorder.started_at, 1)
                self.emit("teleop", status)
                frames, window_start, last_status = 0, now, now
            time.sleep(max(0.0, period - (time.monotonic() - frame_start)))

    def _reconnect(self) -> None:
        self.emit("teleop", {"state": "reconnecting"})
        self.source.disconnect()
        self.follower.disconnect(relax=False)
        self.follower.connect()
        self.source.connect()
