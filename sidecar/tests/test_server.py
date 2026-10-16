"""End-to-end protocol tests against the simulated rig, through the real stdin/stdout process."""

import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

from pivot_sidecar.fake import FOLLOWER_PORT, LEADER_PORT


class Sidecar:
    def __init__(self, scenario: str, home: Path):
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "pivot_sidecar.server", "--fake", "--scenario", scenario],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            env={"HOME": str(home), "PATH": "/usr/bin:/bin"},
        )
        self.next_id = 0
        self.events: list[dict] = []
        assert self.read()["event"] == "ready"

    def read(self) -> dict:
        line = self.proc.stdout.readline()
        assert line, "sidecar exited"
        return json.loads(line)

    def call(self, method: str, **params) -> dict:
        self.next_id += 1
        self.proc.stdin.write(json.dumps({"id": self.next_id, "method": method, "params": params}) + "\n")
        self.proc.stdin.flush()
        while True:
            message = self.read()
            if message.get("id") == self.next_id:
                return message
            self.events.append(message)

    def notify(self, method: str, **params) -> None:
        self.proc.stdin.write(json.dumps({"method": method, "params": params}) + "\n")
        self.proc.stdin.flush()

    def wait_for(self, event: str, until, timeout: float = 30) -> dict:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            message = self.read()
            if message.get("event") == event and until(message["data"]):
                return message["data"]
        raise TimeoutError(event)

    def close(self) -> None:
        self.proc.stdin.close()
        self.proc.wait(timeout=5)


@pytest.fixture
def sidecar(request, tmp_path):
    car = Sidecar(getattr(request, "param", "healthy"), tmp_path)
    yield car
    car.close()


def test_full_setup_flow(sidecar):
    boards = sidecar.call("list_boards")["result"]["boards"]
    ports = [b["port"] for b in boards]
    assert ports == [FOLLOWER_PORT, LEADER_PORT]

    for port in ports:
        assert sidecar.call("probe", port=port)["result"]["diagnosis"]["status"] == "ready"

    sidecar.call("identify_start", ports=ports)
    identified = sidecar.wait_for("identified", lambda d: True)
    assert identified == {"follower": FOLLOWER_PORT, "leader": LEADER_PORT}

    sidecar.call("calibrate_begin", role="follower", port=FOLLOWER_PORT, arm_id="claw")
    early = sidecar.call("calibrate_finish")
    assert "error" in early  # can't save before the middle position

    sidecar.call("calibrate_set_middle")
    sidecar.wait_for("ranges", lambda d: d["ready"])
    saved = sidecar.call("calibrate_finish")["result"]
    assert Path(saved["path"]).is_file()

    info = sidecar.call("calibration_info", role="follower", port=FOLLOWER_PORT, arm_id="claw")["result"]
    assert info["exists"]

    sidecar.call(
        "teleop_start",
        follower={"port": FOLLOWER_PORT, "arm_id": "claw"},
        leader={"port": LEADER_PORT, "arm_id": "handle"},
    )
    running = sidecar.wait_for("teleop", lambda d: d["state"] == "running")
    assert running["hz"] > 20
    assert sidecar.call("teleop_stop", relax=True)["result"]["relaxed"]


@pytest.mark.parametrize("sidecar", ["leader_unpowered"], indirect=True)
def test_unpowered_board_explains_the_fix(sidecar):
    result = sidecar.call("probe", port=LEADER_PORT)["result"]
    assert result["diagnosis"]["status"] == "no_motor_power"
    assert "barrel plug" in result["diagnosis"]["detail"]


@pytest.mark.parametrize("sidecar", ["glitch"], indirect=True)
def test_glitch_reading_never_becomes_a_limit(sidecar):
    sidecar.call("calibrate_begin", role="leader", port=LEADER_PORT, arm_id="handle")
    sidecar.call("calibrate_set_middle")
    sidecar.wait_for("ranges", lambda d: d["ready"])
    saved = sidecar.call("calibrate_finish")["result"]
    assert 839 not in saved["mins"].values()
