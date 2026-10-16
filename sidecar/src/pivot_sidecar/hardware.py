"""Real hardware access through LeRobot.

`Board` is a bare serial bus used before we know which arm is which: it pings motors one ID at a
time (a broadcast ping can miss motors that answer at once) and reads voltage, temperature and
raw positions. `Arm` wraps LeRobot's SO101Follower / SO101Leader so calibration files stay
compatible with `lerobot-record`, `lerobot-teleoperate` and training.
"""

from pathlib import Path
from typing import Protocol

from serial.tools import list_ports

from pivot_sidecar.joints import (
    ADDR_PRESENT_POSITION,
    ADDR_PRESENT_TEMPERATURE,
    ADDR_PRESENT_VOLTAGE,
    DEFAULT_BAUDRATE,
    FULL_TURN_JOINT,
    JOINT_IDS,
    JOINTS,
    Role,
)

# USB-serial bridges used by SO-101 controller boards (WCH CH34x, Silicon Labs CP210x, FTDI).
KNOWN_USB_VENDORS = {0x1A86, 0x10C4, 0x0403}


def list_boards() -> list[dict]:
    boards = []
    for info in list_ports.comports():
        if info.vid not in KNOWN_USB_VENDORS:
            continue
        # LeRobot's docs use /dev/tty.* on macOS; keep that form so ports match its commands.
        port = info.device.replace("/dev/cu.", "/dev/tty.")
        boards.append({"port": port, "description": info.description, "serial": info.serial_number})
    return sorted(boards, key=lambda b: b["port"])


class Board(Protocol):
    port: str

    def open(self) -> None: ...
    def close(self) -> None: ...
    def ping_all(self) -> dict[int, int]: ...
    def read_status(self) -> dict: ...
    def raw_positions(self) -> dict[str, int]: ...


class Arm(Protocol):
    role: Role
    port: str
    arm_id: str

    @property
    def calibration_path(self) -> Path: ...
    def connect(self) -> None: ...
    def disconnect(self, relax: bool) -> None: ...
    def begin_calibration(self) -> None: ...
    def set_middle(self) -> None: ...
    def raw_positions(self) -> dict[str, int]: ...
    def save_calibration(self, mins: dict[str, int], maxes: dict[str, int]) -> Path: ...
    def read_joints(self) -> dict[str, float]: ...
    def send_joints(self, joints: dict[str, float]) -> None: ...


class RealBoard:
    def __init__(self, port: str):
        from lerobot.motors.feetech import FeetechMotorsBus

        self.port = port
        self._bus = FeetechMotorsBus(port, {})

    def open(self) -> None:
        self._bus._connect(handshake=False)
        self._bus.set_baudrate(DEFAULT_BAUDRATE)

    def close(self) -> None:
        self._bus.port_handler.closePort()

    def _read(self, addr: int, length: int, motor_id: int) -> int | None:
        value, _, _ = self._bus._read(addr, length, motor_id, num_retry=1, raise_on_error=False)
        return value

    def ping_all(self) -> dict[int, int]:
        found = {}
        for motor_id in JOINT_IDS.values():
            model = self._bus.ping(motor_id, num_retry=1, raise_on_error=False)
            if model is not None:
                found[motor_id] = model
        return found

    def read_status(self) -> dict:
        voltages, temperatures = {}, {}
        for motor_id in JOINT_IDS.values():
            volts = self._read(ADDR_PRESENT_VOLTAGE, 1, motor_id)
            temp = self._read(ADDR_PRESENT_TEMPERATURE, 1, motor_id)
            if volts is not None:
                voltages[motor_id] = volts / 10
            if temp is not None:
                temperatures[motor_id] = temp
        return {"voltages": voltages, "temperatures": temperatures}

    def raw_positions(self) -> dict[str, int]:
        positions = {}
        for joint, motor_id in JOINT_IDS.items():
            value = self._read(ADDR_PRESENT_POSITION, 2, motor_id)
            if value is not None:
                positions[joint] = value
        return positions


class RealArm:
    def __init__(self, role: Role, port: str, arm_id: str):
        self.role, self.port, self.arm_id = role, port, arm_id
        if role is Role.FOLLOWER:
            from lerobot.robots.so_follower import SO101Follower, SO101FollowerConfig

            self._device = SO101Follower(SO101FollowerConfig(port=port, id=arm_id))
        else:
            from lerobot.teleoperators.so_leader import SO101Leader, SO101LeaderConfig

            self._device = SO101Leader(SO101LeaderConfig(port=port, id=arm_id))
        self._bus = self._device.bus

    @property
    def calibration_path(self) -> Path:
        return self._device.calibration_fpath

    def connect(self) -> None:
        # LeRobot's own connect() prompts on stdin when the motors and file disagree; we never do.
        self._device.connect(calibrate=False)
        if self._device.calibration and not self._device.is_calibrated:
            self._bus.write_calibration(self._device.calibration)

    def disconnect(self, relax: bool) -> None:
        if self._bus.is_connected:
            self._bus.disconnect(disable_torque=relax)

    def begin_calibration(self) -> None:
        from lerobot.motors.feetech import OperatingMode

        self._bus.disable_torque()
        for joint in JOINTS:
            self._bus.write("Operating_Mode", joint, OperatingMode.POSITION.value)

    def set_middle(self) -> None:
        self._bus.set_half_turn_homings()

    def raw_positions(self) -> dict[str, int]:
        return self._bus.sync_read("Present_Position", normalize=False, num_retry=2)

    def save_calibration(self, mins: dict[str, int], maxes: dict[str, int]) -> Path:
        from lerobot.motors import MotorCalibration

        homing = self._bus.read_calibration()
        calibration = {}
        for joint in JOINTS:
            low, high = (0, 4095) if joint == FULL_TURN_JOINT else (mins[joint], maxes[joint])
            calibration[joint] = MotorCalibration(
                id=JOINT_IDS[joint],
                drive_mode=0,
                homing_offset=homing[joint].homing_offset,
                range_min=int(low),
                range_max=int(high),
            )
        self._bus.write_calibration(calibration)
        self._device.calibration = calibration
        self._device._save_calibration()
        return self.calibration_path

    def read_joints(self) -> dict[str, float]:
        values = self._bus.sync_read("Present_Position", num_retry=2)
        return {joint: float(value) for joint, value in values.items()}

    def send_joints(self, joints: dict[str, float]) -> None:
        self._device.send_action({f"{joint}.pos": value for joint, value in joints.items()})
