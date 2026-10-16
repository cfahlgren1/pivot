"""Turn a board probe into one status and a plain-English next step."""

from dataclasses import dataclass

from pivot_sidecar.joints import JOINT_IDS, STS3215_MODEL


@dataclass
class Diagnosis:
    status: str  # ready | no_motor_power | ids_not_set | missing_motors | wrong_model
    title: str
    detail: str

    def to_dict(self) -> dict:
        return {"status": self.status, "title": self.title, "detail": self.detail}


def diagnose(motors: dict[int, int]) -> Diagnosis:
    """`motors` maps responding motor IDs (at the default baudrate) to their model numbers."""
    expected = set(JOINT_IDS.values())
    found = set(motors)

    if not found:
        return Diagnosis(
            "no_motor_power",
            "No power to the motors",
            "The board is connected over USB, but no motors answer. Push the barrel plug into the "
            "board until it's fully seated, and check the cable from the board to the arm. The red "
            "PW light only means USB is connected.",
        )
    if found == {1}:
        return Diagnosis(
            "ids_not_set",
            "Motor IDs aren't set yet",
            "Only one motor ID answers, which usually means the motors are new and all share ID 1. "
            "Each motor needs its own ID before the arm can be used.",
        )
    if wrong := sorted(i for i, model in motors.items() if model != STS3215_MODEL):
        return Diagnosis(
            "wrong_model",
            "Unexpected motor type",
            f"Motor IDs {wrong} aren't STS3215 servos. SO-101 arms need STS3215 motors.",
        )
    if missing := sorted(expected - found):
        names = ", ".join(name for name, i in JOINT_IDS.items() if i in missing)
        return Diagnosis(
            "missing_motors",
            f"{len(missing)} motor{'s' if len(missing) > 1 else ''} not answering",
            f"Check the cables to: {names}. Each motor passes the signal on to the next one.",
        )
    return Diagnosis("ready", "Ready", "All 6 motors answer and already have their IDs.")
