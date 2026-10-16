"""SO-101 joint names, register addresses, and the ranges a healthy calibration should cover."""

from enum import StrEnum


class Role(StrEnum):
    FOLLOWER = "follower"
    LEADER = "leader"


# Motor IDs 1-6, in LeRobot's order.
JOINTS = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"]
JOINT_IDS = {name: motor_id for motor_id, name in enumerate(JOINTS, start=1)}

# Wrist roll turns all the way around, so it has no end stops to record.
FULL_TURN_JOINT = "wrist_roll"
SWEPT_JOINTS = [j for j in JOINTS if j != FULL_TURN_JOINT]

STS3215_MODEL = 777
DEFAULT_BAUDRATE = 1_000_000

# Feetech STS control table (SRAM section).
ADDR_TORQUE_ENABLE = 40
ADDR_PRESENT_POSITION = 56
ADDR_PRESENT_VOLTAGE = 62
ADDR_PRESENT_TEMPERATURE = 63

# Raw-tick spans measured on a correctly calibrated Hiwonder SO-101 kit (2026-10-15).
# A joint counts as fully swept once it covers COVERAGE_TARGET of its expected span.
EXPECTED_SPAN = {
    Role.FOLLOWER: {
        "shoulder_pan": 2547,
        "shoulder_lift": 2397,
        "elbow_flex": 2190,
        "wrist_flex": 2254,
        "gripper": 1457,
    },
    Role.LEADER: {
        "shoulder_pan": 2534,
        "shoulder_lift": 2394,
        "elbow_flex": 2192,
        "wrist_flex": 2331,
        "gripper": 1229,
    },
}
COVERAGE_TARGET = 0.8
