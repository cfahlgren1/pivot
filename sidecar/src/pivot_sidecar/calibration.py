"""Range recording for calibration, with the guards LeRobot's interactive version lacks.

Two failures from real setups drive this design:
- A garbage reading in the first instant after homing (e.g. 839 on a trigger that never goes below
  2035) was saved as a joint limit. We ignore a short settle window and reject impossible jumps.
- A joint was saved after being swept only ~20% of its range. We report coverage per joint and
  refuse to finish until every joint reaches the target.
"""

from dataclasses import dataclass, field

from pivot_sidecar.joints import COVERAGE_TARGET, EXPECTED_SPAN, SWEPT_JOINTS, Role

SETTLE_SECONDS = 0.3
# A hand can't move a joint more than this many raw ticks between two reads ~16 ms apart.
MAX_JUMP_TICKS = 700


@dataclass
class JointRange:
    lowest: int | None = None
    highest: int | None = None
    last: int | None = None
    rejected: int = 0

    def add(self, value: int) -> None:
        if self.last is not None and abs(value - self.last) > MAX_JUMP_TICKS:
            self.rejected += 1
            return
        self.last = value
        self.lowest = value if self.lowest is None else min(self.lowest, value)
        self.highest = value if self.highest is None else max(self.highest, value)

    @property
    def span(self) -> int:
        if self.lowest is None or self.highest is None:
            return 0
        return self.highest - self.lowest


@dataclass
class RangeRecorder:
    role: Role
    started_at: float
    joints: dict[str, JointRange] = field(default_factory=lambda: {j: JointRange() for j in SWEPT_JOINTS})

    def add_sample(self, positions: dict[str, int], at: float) -> None:
        if at - self.started_at < SETTLE_SECONDS:
            return
        for joint, joint_range in self.joints.items():
            value = positions.get(joint)
            if value is not None:
                joint_range.add(value)

    def coverage(self, joint: str) -> float:
        return min(1.0, self.joints[joint].span / EXPECTED_SPAN[self.role][joint])

    @property
    def ready(self) -> bool:
        return all(self.coverage(j) >= COVERAGE_TARGET for j in SWEPT_JOINTS)

    def least_covered(self) -> str:
        return min(SWEPT_JOINTS, key=self.coverage)

    def limits(self) -> tuple[dict[str, int], dict[str, int]]:
        if not self.ready:
            raise ValueError(f"Not every joint has been swept yet; {self.least_covered()} is lowest.")
        mins = {j: r.lowest for j, r in self.joints.items()}
        maxes = {j: r.highest for j, r in self.joints.items()}
        return mins, maxes

    def snapshot(self) -> dict:
        return {
            "joints": {
                j: {
                    "min": r.lowest,
                    "max": r.highest,
                    "position": r.last,
                    "coverage": round(self.coverage(j), 3),
                    "rejected": r.rejected,
                }
                for j, r in self.joints.items()
            },
            "ready": self.ready,
            "least_covered": self.least_covered(),
        }
