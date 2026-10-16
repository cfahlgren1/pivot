"""A simulated pair of SO-101 arms, for building the UI and testing without hardware.

`pivot-sidecar --fake` uses this rig. Scenarios reproduce the failures seen on real setups.
"""

import math
import time
from dataclasses import dataclass, field
from pathlib import Path

from pivot_sidecar.joints import EXPECTED_SPAN, JOINT_IDS, JOINTS, STS3215_MODEL, SWEPT_JOINTS, Role

FOLLOWER_PORT = "/dev/tty.fake-claw-arm"
LEADER_PORT = "/dev/tty.fake-handle-arm"
MIDDLE = 2047


@dataclass
class FakeRig:
    """Shared state for both simulated arms.

    scenario: "healthy", "leader_unpowered" (leader board has USB but no motor power), or
    "glitch" (the first reading after homing is garbage, like the real 839 trigger reading).
    """

    scenario: str = "healthy"
    calibration_dir: Path = field(default_factory=lambda: Path.home() / ".cache/pivot-fake")
    started: float = field(default_factory=time.monotonic)
    # The fake "user" wiggles this port while arms are being identified.
    wiggling: str | None = FOLLOWER_PORT
    leader_pose: dict[str, float] = field(default_factory=dict)

    def powered(self, port: str) -> bool:
        return not (self.scenario == "leader_unpowered" and port == LEADER_PORT)

    def now(self) -> float:
        return time.monotonic() - self.started

    def boards(self) -> list[dict]:
        return [
            {"port": FOLLOWER_PORT, "description": "Simulated claw arm", "serial": "FAKE1"},
            {"port": LEADER_PORT, "description": "Simulated handle arm", "serial": "FAKE2"},
        ]

    def idle_positions(self, port: str) -> dict[str, int]:
        t = self.now()
        positions = {}
        for i, joint in enumerate(JOINTS):
            wobble = 300 * math.sin(t * (1.1 + i * 0.3) + i) if port == self.wiggling else 0
            positions[joint] = int(MIDDLE + wobble + (i % 2))
        return positions


class FakeBoard:
    def __init__(self, port: str, rig: FakeRig):
        self.port, self._rig = port, rig

    def open(self) -> None:
        pass

    def close(self) -> None:
        pass

    def ping_all(self) -> dict[int, int]:
        if not self._rig.powered(self.port):
            return {}
        return {motor_id: STS3215_MODEL for motor_id in JOINT_IDS.values()}

    def read_status(self) -> dict:
        if not self._rig.powered(self.port):
            return {"voltages": {}, "temperatures": {}}
        ids = JOINT_IDS.values()
        return {"voltages": {i: 12.2 for i in ids}, "temperatures": {i: 46 + i % 3 for i in ids}}

    def raw_positions(self) -> dict[str, int]:
        return self._rig.idle_positions(self.port) if self._rig.powered(self.port) else {}


class FakeArm:
    def __init__(self, role: Role, port: str, arm_id: str, rig: FakeRig):
        self.role, self.port, self.arm_id, self._rig = role, port, arm_id, rig
        self._sweep_started: float | None = None
        self._first_read = False
        self._commanded: dict[str, float] = {}

    @property
    def calibration_path(self) -> Path:
        return self._rig.calibration_dir / self.role.value / f"{self.arm_id}.json"

    def connect(self) -> None:
        if not self._rig.powered(self.port):
            raise ConnectionError(f"No motors answer on {self.port}")

    def disconnect(self, relax: bool) -> None:
        self._sweep_started = None

    def begin_calibration(self) -> None:
        self._rig.wiggling = None

    def set_middle(self) -> None:
        self._sweep_started = self._rig.now()
        self._first_read = self._rig.scenario == "glitch"

    def raw_positions(self) -> dict[str, int]:
        if self._sweep_started is None:
            return {joint: MIDDLE for joint in JOINTS}
        if self._first_read:
            self._first_read = False
            return {joint: 839 for joint in JOINTS}
        # The simulated user sweeps one joint at a time, each over ~3 seconds.
        elapsed = self._rig.now() - self._sweep_started
        positions = {joint: MIDDLE for joint in JOINTS}
        for i, joint in enumerate(SWEPT_JOINTS):
            local = elapsed - i * 3.0
            if local <= 0:
                continue
            reach = min(1.0, local / 3.0) * EXPECTED_SPAN[self.role][joint] * 0.52
            positions[joint] = int(MIDDLE + reach * math.sin(local * 2.2))
        return positions

    def save_calibration(self, mins: dict[str, int], maxes: dict[str, int]) -> Path:
        import json

        path = self.calibration_path
        path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            joint: {
                "id": JOINT_IDS[joint],
                "range_min": mins.get(joint, 0),
                "range_max": maxes.get(joint, 4095),
            }
            for joint in JOINTS
        }
        path.write_text(json.dumps(data, indent=4))
        return path

    def read_joints(self) -> dict[str, float]:
        if self.role is Role.LEADER:
            t = self._rig.now()
            pose = {
                "shoulder_pan": 25 * math.sin(t * 0.5),
                "shoulder_lift": 15 * math.sin(t * 0.6 + 1),
                "elbow_flex": 20 * math.sin(t * 0.7 + 2),
                "wrist_flex": 25 * math.sin(t * 0.9 + 3),
                "wrist_roll": 0.0,
                "gripper": 50 + 50 * math.sin(t * 1.2),
            }
            self._rig.leader_pose = pose
            return pose
        return dict(self._commanded) or {joint: 0.0 for joint in JOINTS}

    def send_joints(self, joints: dict[str, float]) -> None:
        self._commanded = dict(joints)
