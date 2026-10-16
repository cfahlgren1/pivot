"""Tell two boards apart by watching which one the user is moving.

Replaces "unplug the follower and see which port disappears", which silently swaps the arms if
the user unplugs the wrong one.
"""

from dataclasses import dataclass, field

# Encoder jitter on a still arm stays within a couple of ticks.
NOISE_TICKS = 4
# Total motion needed before we commit, and how much more the moving board must show.
DECIDE_TICKS = 600
DOMINANCE = 4.0


@dataclass
class MotionDetector:
    ports: list[str]
    motion: dict[str, float] = field(init=False)
    _last: dict[str, dict[str, int]] = field(init=False, default_factory=dict)

    def __post_init__(self) -> None:
        self.motion = {port: 0.0 for port in self.ports}

    def add_sample(self, port: str, positions: dict[str, int]) -> None:
        previous = self._last.get(port)
        self._last[port] = positions
        if previous is None:
            return
        for joint, value in positions.items():
            delta = abs(value - previous.get(joint, value))
            if delta > NOISE_TICKS:
                self.motion[port] += delta

    def moving_port(self) -> str | None:
        ranked = sorted(self.ports, key=lambda p: self.motion[p], reverse=True)
        top, rest = ranked[0], ranked[1:]
        if self.motion[top] < DECIDE_TICKS:
            return None
        if any(self.motion[top] < DOMINANCE * max(self.motion[p], 1.0) for p in rest):
            return None
        return top
