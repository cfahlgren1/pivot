"""Recorded episodes on disk: one folder per dataset, one JSON file per episode.

Joints use LeRobot's SO-101 names and units (degrees from the calibrated middle; gripper 0-100), so
an episode converts to a LeRobot dataset frame for frame. `action` is what the follower was told to
do, `state` is where it actually was.
"""

import json
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path

from pivot_sidecar.joints import JOINTS

EPISODE_FORMAT = "pivot-episode/1"
DATASET_FORMAT = "pivot-dataset/1"
RECORD_FPS = 30
# A safety cap; the app normally ends episodes much sooner.
MAX_EPISODE_SECONDS = 300


@dataclass
class Episode:
    task: str
    source: str
    recorded_at: str
    fps: int = RECORD_FPS
    joints: list[str] = field(default_factory=lambda: list(JOINTS))
    timestamps: list[float] = field(default_factory=list)
    action: list[list[float]] = field(default_factory=list)
    state: list[list[float]] = field(default_factory=list)

    @property
    def duration(self) -> float:
        return self.timestamps[-1] if self.timestamps else 0.0

    def pose(self, index: int) -> dict[str, float]:
        return dict(zip(self.joints, self.action[index], strict=True))

    def summary(self) -> dict:
        return {
            "task": self.task,
            "source": self.source,
            "recorded_at": self.recorded_at,
            "duration": round(self.duration, 2),
            "frames": len(self.timestamps),
        }

    def preview(self, fps: int = 15) -> dict:
        """A downsampled copy of the actions for drawing charts and animating the 3D arm."""
        step = max(1, round(self.fps / fps))
        return {
            "joints": self.joints,
            "timestamps": self.timestamps[::step],
            "action": self.action[::step],
        }

    def to_json(self) -> str:
        return json.dumps({"format": EPISODE_FORMAT, **asdict(self)}, separators=(",", ":"))

    @classmethod
    def from_json(cls, text: str) -> "Episode":
        data = json.loads(text)
        if data.pop("format", None) != EPISODE_FORMAT:
            raise ValueError("Not a Pivot episode file.")
        return cls(**data)


class EpisodeRecorder:
    """Collects frames at RECORD_FPS from a faster control loop."""

    def __init__(self, task: str, source: str, started_at: float):
        self.started_at = started_at
        self._next_sample = started_at
        self.episode = Episode(
            task=task, source=source, recorded_at=datetime.now().isoformat(timespec="seconds")
        )

    def wants_sample(self, now: float) -> bool:
        return now >= self._next_sample and now - self.started_at <= MAX_EPISODE_SECONDS

    def add(self, now: float, action: dict[str, float], state: dict[str, float]) -> None:
        self._next_sample += 1 / RECORD_FPS
        # After a stall, skip the missed slots rather than recording a burst.
        self._next_sample = max(self._next_sample, now)
        self.episode.timestamps.append(round(now - self.started_at, 4))
        self.episode.action.append([round(action.get(j, 0.0), 3) for j in self.episode.joints])
        self.episode.state.append([round(state.get(j, 0.0), 3) for j in self.episode.joints])


def dataset_slug(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    if not slug:
        raise ValueError("Give the dataset a name with at least one letter or number.")
    return slug


class RecordingStore:
    def __init__(self, root: Path):
        self.root = root

    def _dataset_dir(self, dataset: str) -> Path:
        return self.root / dataset_slug(dataset)

    def _episode_path(self, dataset: str, index: int) -> Path:
        return self._dataset_dir(dataset) / f"episode_{index:06d}.json"

    def _episode_indexes(self, folder: Path) -> list[int]:
        return sorted(int(p.stem.split("_")[1]) for p in folder.glob("episode_*.json"))

    def save(self, dataset: str, episode: Episode) -> int:
        folder = self._dataset_dir(dataset)
        folder.mkdir(parents=True, exist_ok=True)
        info = folder / "dataset.json"
        if not info.exists():
            info.write_text(
                json.dumps(
                    {
                        "format": DATASET_FORMAT,
                        "name": folder.name,
                        "task": episode.task,
                        "robot": "so101_follower",
                        "fps": episode.fps,
                        "created": episode.recorded_at,
                    },
                    indent=2,
                )
            )
        indexes = self._episode_indexes(folder)
        index = (indexes[-1] + 1) if indexes else 1
        self._episode_path(dataset, index).write_text(episode.to_json())
        return index

    def load(self, dataset: str, index: int) -> Episode:
        return Episode.from_json(self._episode_path(dataset, index).read_text())

    def delete(self, dataset: str, index: int) -> None:
        self._episode_path(dataset, index).unlink()

    def list(self) -> list[dict]:
        if not self.root.is_dir():
            return []
        datasets = []
        for folder in sorted(self.root.iterdir()):
            info_path = folder / "dataset.json"
            if not info_path.is_file():
                continue
            info = json.loads(info_path.read_text())
            episodes = [
                {"index": i, **self.load(folder.name, i).summary()} for i in self._episode_indexes(folder)
            ]
            datasets.append(
                {"name": folder.name, "task": info["task"], "path": str(folder), "episodes": episodes}
            )
        return datasets
