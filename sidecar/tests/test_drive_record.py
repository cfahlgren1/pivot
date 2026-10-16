"""Controller driving safety and the episode format, plus record → save → replay end to end."""

import json

import pytest
from test_server import Sidecar

from pivot_sidecar.drive import STALE_AFTER_SECONDS, GamepadSource
from pivot_sidecar.fake import FOLLOWER_PORT, LEADER_PORT, FakeArm, FakeRig
from pivot_sidecar.joints import Role
from pivot_sidecar.recording import Episode, EpisodeRecorder, RecordingStore, dataset_slug


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def pad(tmp_path):
    clock = Clock()
    follower = FakeArm(Role.FOLLOWER, FOLLOWER_PORT, "claw", FakeRig(calibration_dir=tmp_path))
    source = GamepadSource(follower, clock=clock)
    source.connect()
    return source, clock


def drive(source: GamepadSource, clock: Clock, seconds: float, **inputs) -> dict[str, float]:
    """Hold the given input for `seconds`, sending it every frame like the app does."""
    target = {}
    for _ in range(int(seconds * 60)):
        clock.now += 1 / 60
        source.set_input(inputs)
        target = source.target()
    return target


def test_nothing_moves_without_holding_lb(pad):
    source, clock = pad
    start = source.target()
    assert drive(source, clock, 1.0, left_x=1.0, right_trigger=1.0) == start


def test_holding_lb_moves_the_joint_under_the_stick(pad):
    source, clock = pad
    target = drive(source, clock, 1.0, left_x=1.0, hold=True)
    assert 40 < target["shoulder_pan"] < 50  # ~45 degrees per second at normal speed
    assert target["elbow_flex"] == 0.0


def test_stale_input_stops_the_arm(pad):
    source, clock = pad
    drive(source, clock, 0.5, left_y=1.0, hold=True)
    frozen = source.target()
    clock.now += STALE_AFTER_SECONDS + 0.5  # the controller (or the UI) went quiet
    assert source.target() == frozen


def test_targets_stay_inside_the_calibrated_range(pad):
    source, clock = pad
    target = drive(source, clock, 10.0, right_y=-1.0, left_trigger=1.0, hold=True)
    assert target["elbow_flex"] == -100.0
    assert target["gripper"] == 100.0


def test_controller_refuses_an_uncalibrated_arm(tmp_path):
    follower = FakeArm(Role.FOLLOWER, FOLLOWER_PORT, "claw", FakeRig(calibration_dir=tmp_path))
    follower.joint_limits = lambda: {}
    with pytest.raises(RuntimeError, match="Calibrate"):
        GamepadSource(follower).connect()


def test_small_stick_drift_is_ignored(pad):
    source, clock = pad
    start = source.target()
    assert drive(source, clock, 1.0, left_x=0.1, right_y=-0.12, hold=True) == start


def test_episode_round_trips_and_numbers_increase(tmp_path):
    recorder = EpisodeRecorder("Pick up the cube", "gamepad", started_at=0.0)
    for frame in range(90):
        now = frame / 60
        if recorder.wants_sample(now):
            pose = {"shoulder_pan": frame * 1.0, "gripper": 50.0}
            recorder.add(now, pose, pose)
    episode = recorder.episode
    assert len(episode.timestamps) == 45  # 1.5 s at 30 fps from a 60 Hz loop
    assert episode.joints[0] == "shoulder_pan"

    store = RecordingStore(tmp_path)
    assert store.save("Pick Up Cube!", episode) == 1
    assert store.save("pick-up-cube", episode) == 2
    loaded = store.load("pick-up-cube", 2)
    assert loaded.action == episode.action
    [dataset] = store.list()
    assert dataset["name"] == "pick-up-cube"
    assert [e["index"] for e in dataset["episodes"]] == [1, 2]
    store.delete("pick-up-cube", 1)
    assert [e["index"] for e in store.list()[0]["episodes"]] == [2]


def test_episode_file_is_plain_json(tmp_path):
    episode = Episode(task="t", source="leader_arm", recorded_at="2026-10-16T12:00:00")
    data = json.loads(episode.to_json())
    assert data["format"] == "pivot-episode/1"
    with pytest.raises(ValueError):
        Episode.from_json(json.dumps({"format": "something-else"}))


def test_dataset_names_must_have_content():
    assert dataset_slug("  My Task  ") == "my-task"
    with pytest.raises(ValueError):
        dataset_slug("!!!")


@pytest.fixture
def sidecar(tmp_path):
    car = Sidecar("healthy", tmp_path)
    yield car
    car.close()


def test_record_with_the_controller_then_replay(sidecar):
    follower = {"port": FOLLOWER_PORT, "arm_id": "claw"}
    sidecar.call("teleop_start", follower=follower, driver="gamepad")
    sidecar.wait_for("teleop", lambda d: d["state"] == "running")

    sidecar.call("record_start", dataset="pick-up-cube", task="Pick up the cube")
    # Controller input arrives as notifications (no id, no response), like the app sends it.
    for _ in range(40):
        sidecar.notify("teleop_input", state={"left_x": 1.0, "hold": True})
        sidecar.wait_for("teleop", lambda d: d["state"] == "running")
    recorded = sidecar.call("record_stop", dataset="pick-up-cube")["result"]
    assert recorded["frames"] > 10
    pans = [frame[0] for frame in recorded["preview"]["action"]]
    assert pans[-1] > pans[0]  # the stick moved the base

    assert sidecar.call("record_save")["result"]["index"] == 1
    sidecar.call("teleop_stop")

    [dataset] = sidecar.call("recordings_list")["result"]["datasets"]
    assert dataset["episodes"][0]["source"] == "gamepad"

    sidecar.call("replay_start", follower=follower, dataset="pick-up-cube", index=1, speed=1.0)
    assert sidecar.wait_for("replay", lambda d: d["state"] in ("done", "error"))["state"] == "done"


def test_leader_driving_still_works_and_redo_discards(sidecar):
    sidecar.call(
        "teleop_start",
        follower={"port": FOLLOWER_PORT, "arm_id": "claw"},
        leader={"port": LEADER_PORT, "arm_id": "handle"},
    )
    sidecar.wait_for("teleop", lambda d: d["state"] == "running")
    sidecar.call("record_start", dataset="wave", task="Wave")
    sidecar.wait_for("teleop", lambda d: d.get("recording_seconds", 0) > 0.5)
    assert sidecar.call("record_stop", dataset="wave")["result"]["source"] == "leader_arm"
    sidecar.call("record_discard")
    assert "error" in sidecar.call("record_save")
    assert sidecar.call("recordings_list")["result"]["datasets"] == []
