"""Tests for the failure modes hit during a real SO-101 setup."""

import pytest

from pivot_sidecar.calibration import MAX_JUMP_TICKS, SETTLE_SECONDS, RangeRecorder
from pivot_sidecar.diagnose import diagnose
from pivot_sidecar.identify import MotionDetector
from pivot_sidecar.joints import EXPECTED_SPAN, JOINT_IDS, STS3215_MODEL, SWEPT_JOINTS, Role

ALL_MOTORS = {motor_id: STS3215_MODEL for motor_id in JOINT_IDS.values()}


def sweep(recorder: RangeRecorder, joint: str, low: int, high: int, start: float) -> float:
    """Move one joint from the middle to `low`, then to `high`, in small steps."""
    t = start
    for value in [*range(2047, low, -50), *range(low, high, 50), high]:
        t += 0.016
        recorder.add_sample({joint: value}, t)
    return t


class TestRangeRecorder:
    def test_ignores_glitch_reading_right_after_homing(self):
        # Real case: the leader trigger read 839 the instant after homing, but never goes below 2035.
        recorder = RangeRecorder(Role.LEADER, started_at=0.0)
        recorder.add_sample({"gripper": 839}, at=0.01)
        recorder.add_sample({"gripper": 2047}, at=SETTLE_SECONDS + 0.01)
        assert recorder.joints["gripper"].lowest == 2047

    def test_rejects_impossible_jumps(self):
        recorder = RangeRecorder(Role.FOLLOWER, started_at=0.0)
        recorder.add_sample({"elbow_flex": 2047}, at=1.0)
        recorder.add_sample({"elbow_flex": 2047 - MAX_JUMP_TICKS - 1}, at=1.016)
        recorder.add_sample({"elbow_flex": 2060}, at=1.032)
        joint = recorder.joints["elbow_flex"]
        assert (joint.lowest, joint.highest, joint.rejected) == (2047, 2060, 1)

    def test_partial_sweep_is_not_ready(self):
        # Real case: the upper arm was only moved through ~20% of its range.
        recorder = RangeRecorder(Role.FOLLOWER, started_at=0.0)
        t = 1.0
        for joint in SWEPT_JOINTS:
            span = EXPECTED_SPAN[Role.FOLLOWER][joint]
            reach = span // 10 if joint == "shoulder_lift" else span // 2
            t = sweep(recorder, joint, 2047 - reach, 2047 + reach, t)
        assert not recorder.ready
        assert recorder.least_covered() == "shoulder_lift"
        with pytest.raises(ValueError, match="shoulder_lift"):
            recorder.limits()

    def test_full_sweep_gives_limits(self):
        recorder = RangeRecorder(Role.FOLLOWER, started_at=0.0)
        t = 1.0
        for joint in SWEPT_JOINTS:
            half = EXPECTED_SPAN[Role.FOLLOWER][joint] // 2
            t = sweep(recorder, joint, 2047 - half, 2047 + half, t)
        assert recorder.ready
        mins, maxes = recorder.limits()
        assert all(maxes[j] - mins[j] >= EXPECTED_SPAN[Role.FOLLOWER][j] * 0.95 for j in SWEPT_JOINTS)


class TestMotionDetector:
    def test_picks_the_board_being_moved(self):
        detector = MotionDetector(["claw", "handle"])
        for step in range(40):
            detector.add_sample("claw", {"shoulder_pan": 2047 + step * 30})
            detector.add_sample("handle", {"shoulder_pan": 2047 + step % 2})
        assert detector.moving_port() == "claw"

    def test_waits_while_both_boards_move(self):
        detector = MotionDetector(["claw", "handle"])
        for step in range(40):
            detector.add_sample("claw", {"shoulder_pan": 2047 + step * 30})
            detector.add_sample("handle", {"shoulder_pan": 2047 + step * 25})
        assert detector.moving_port() is None

    def test_ignores_encoder_jitter(self):
        detector = MotionDetector(["claw", "handle"])
        for step in range(500):
            detector.add_sample("claw", {"shoulder_pan": 2047 + step % 3})
        assert detector.moving_port() is None


class TestDiagnose:
    def test_usb_but_no_motor_power(self):
        assert diagnose({}).status == "no_motor_power"

    def test_factory_new_motors_share_id_1(self):
        assert diagnose({1: STS3215_MODEL}).status == "ids_not_set"

    def test_preconfigured_kit_is_ready(self):
        assert diagnose(ALL_MOTORS).status == "ready"

    def test_missing_motor_names_the_joint(self):
        result = diagnose({k: v for k, v in ALL_MOTORS.items() if k != 3})
        assert result.status == "missing_motors"
        assert "elbow_flex" in result.detail
