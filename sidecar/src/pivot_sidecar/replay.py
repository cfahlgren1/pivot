"""Plays a recorded episode back on the follower.

The arm first eases from wherever it is to the episode's first pose, so it never snaps, then
follows the recorded actions on their original timing (optionally slowed down). Stopping leaves
the motors holding their position.
"""

import threading
import time
from collections.abc import Callable

from pivot_sidecar.hardware import Arm
from pivot_sidecar.recording import Episode
from pivot_sidecar.teleop import blend

EASE_SECONDS = 2.0
CONTROL_HZ = 60
STATUS_EVERY_SECONDS = 0.1


class ReplayLoop:
    def __init__(
        self, follower: Arm, episode: Episode, emit: Callable[[str, dict], None], speed: float = 0.5
    ):
        if not episode.timestamps:
            raise ValueError("This episode has no frames.")
        if not 0.1 <= speed <= 1.0:
            raise ValueError("Replay speed must be between 0.1 and 1.")
        self.follower, self.episode, self.emit, self.speed = follower, episode, emit, speed
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="replay", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=3)

    def _run(self) -> None:
        try:
            self.follower.connect()
            self._ease_to_start()
            finished = self._play()
            self.emit("replay", {"state": "done" if finished else "stopped"})
        except Exception as exc:  # reported to the UI
            self.emit("replay", {"state": "error", "message": str(exc)})
        finally:
            self.follower.disconnect(relax=False)

    def _ease_to_start(self) -> None:
        start = self.follower.read_joints()
        first = self.episode.pose(0)
        began = time.monotonic()
        while not self._stop.is_set():
            amount = min(1.0, (time.monotonic() - began) / EASE_SECONDS)
            pose = blend(start, first, amount)
            self.follower.send_joints(pose)
            self.emit("replay", {"state": "easing_in", "progress": round(amount, 2), "target": pose})
            if amount >= 1.0:
                return
            time.sleep(1 / CONTROL_HZ)

    def _play(self) -> bool:
        timestamps, duration = self.episode.timestamps, self.episode.duration
        began, last_status, frame = time.monotonic(), 0.0, 0
        while not self._stop.is_set():
            elapsed = (time.monotonic() - began) * self.speed
            while frame + 1 < len(timestamps) and timestamps[frame + 1] <= elapsed:
                frame += 1
            pose = self.episode.pose(frame)
            self.follower.send_joints(pose)
            now = time.monotonic()
            if now - last_status >= STATUS_EVERY_SECONDS:
                self.emit(
                    "replay",
                    {
                        "state": "playing",
                        "t": round(min(elapsed, duration), 2),
                        "duration": duration,
                        "target": pose,
                    },
                )
                last_status = now
            if elapsed >= duration:
                return True
            time.sleep(1 / CONTROL_HZ)
        return False
