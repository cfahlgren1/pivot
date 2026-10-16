"""Where teleoperation targets come from: the leader arm, or a game controller.

With a controller, each stick drives a joint at a speed proportional to how far it's pushed (joint
mode). Nothing moves unless the hold-to-move button (LB) is held and input is fresh, so a dropped
controller or a frozen UI leaves the arm holding still. Targets never leave the calibrated range.
"""

import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

from pivot_sidecar.hardware import Arm
from pivot_sidecar.joints import JOINTS

# Input older than this is ignored, so the arm stops if the controller or the UI goes quiet.
STALE_AFTER_SECONDS = 0.25
DEADZONE = 0.15
# Degrees per second at full stick, and gripper percent per second at full trigger, at "normal".
JOINT_SPEED = 45.0
GRIPPER_SPEED = 80.0
SPEEDS = {"slow": 0.4, "normal": 1.0, "fast": 1.8}


class Source(Protocol):
    """Produces the follower's next joint targets."""

    name: str

    def connect(self) -> None: ...
    def disconnect(self) -> None: ...
    def target(self) -> dict[str, float]: ...
    def status(self) -> dict: ...


class LeaderSource:
    name = "leader_arm"

    def __init__(self, leader: Arm):
        self.leader = leader

    def connect(self) -> None:
        self.leader.connect()

    def disconnect(self) -> None:
        self.leader.disconnect(relax=True)

    def target(self) -> dict[str, float]:
        return self.leader.read_joints()

    def status(self) -> dict:
        return {}


@dataclass
class GamepadInput:
    """One controller reading. Sticks are -1..1 with up and right positive; triggers are 0..1."""

    left_x: float = 0.0
    left_y: float = 0.0
    right_x: float = 0.0
    right_y: float = 0.0
    left_trigger: float = 0.0
    right_trigger: float = 0.0
    hold: bool = False
    roll_left: bool = False
    roll_right: bool = False

    @classmethod
    def from_dict(cls, data: dict) -> "GamepadInput":
        return cls(**{key: data[key] for key in cls.__dataclass_fields__ if key in data})


def deadzone(value: float) -> float:
    if abs(value) < DEADZONE:
        return 0.0
    # Rescale so motion starts from zero at the edge of the deadzone instead of jumping.
    sign = 1.0 if value > 0 else -1.0
    return sign * (abs(value) - DEADZONE) / (1 - DEADZONE)


class GamepadSource:
    """Joint mode: left stick = base and upper arm, right stick = wrist and elbow, triggers = claw."""

    name = "gamepad"

    def __init__(self, follower: Arm, speed: str = "normal", clock: Callable[[], float] = time.monotonic):
        self.follower, self.clock = follower, clock
        self.speed = SPEEDS[speed]
        self._input = GamepadInput()
        self._input_at = float("-inf")
        self._targets: dict[str, float] = {}
        self._limits: dict[str, tuple[float, float]] = {}
        self._last_step: float | None = None

    def connect(self) -> None:
        # The follower is already connected by the loop; start from where it is so nothing jumps.
        self._limits = self.follower.joint_limits()
        if missing := [joint for joint in JOINTS if joint not in self._limits]:
            # Without limits nothing would stop a stick from driving a joint into its end stop.
            raise RuntimeError(
                f"Calibrate the claw arm before driving it with a controller (no range for {missing[0]})."
            )
        self._targets = self.follower.read_joints()
        self._last_step = self.clock()

    def disconnect(self) -> None:
        pass

    def set_input(self, data: dict) -> None:
        self._input = GamepadInput.from_dict(data)
        self._input_at = self.clock()

    def set_speed(self, speed: str) -> None:
        self.speed = SPEEDS[speed]

    @property
    def moving_allowed(self) -> bool:
        return self._input.hold and self.clock() - self._input_at < STALE_AFTER_SECONDS

    def target(self) -> dict[str, float]:
        now = self.clock()
        dt = 0.0 if self._last_step is None else min(now - self._last_step, 0.1)
        self._last_step = now
        if not self.moving_allowed:
            return dict(self._targets)

        pad = self._input
        roll = (1.0 if pad.roll_right else 0.0) - (1.0 if pad.roll_left else 0.0)
        joint_rates = {
            "shoulder_pan": deadzone(pad.left_x),
            "shoulder_lift": deadzone(pad.left_y),
            "elbow_flex": deadzone(pad.right_y),
            "wrist_flex": deadzone(pad.right_x),
            "wrist_roll": roll,
        }
        for joint, rate in joint_rates.items():
            self._move(joint, rate * JOINT_SPEED * self.speed * dt)
        # Right trigger closes the claw, left trigger opens it.
        grip = deadzone(pad.left_trigger) - deadzone(pad.right_trigger)
        self._move("gripper", grip * GRIPPER_SPEED * self.speed * dt)
        return dict(self._targets)

    def _move(self, joint: str, delta: float) -> None:
        if joint not in self._targets or not delta:
            return
        low, high = self._limits[joint]
        self._targets[joint] = min(high, max(low, self._targets[joint] + delta))

    def status(self) -> dict:
        return {"holding": self.moving_allowed}
