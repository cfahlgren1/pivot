# Pivot

Set up SO-101 robot arms one step at a time, from plugging in to teleoperation, without a terminal.

Pivot is a desktop app (Tauri) with a Python sidecar that drives the arms through
[LeRobot](https://github.com/huggingface/lerobot). Calibration files are saved where LeRobot
expects them, so `lerobot-record`, `lerobot-teleoperate` and training use them unchanged.

## What it handles that the command line doesn't

| Problem on a real setup | What Pivot does |
| --- | --- |
| Which USB port is which arm? The unplug test is easy to get backwards. | Asks you to move the claw arm and watches which board responds. |
| Motor setup is unnecessary on pre-assembled kits. | Pings each motor; skips ID setup when all six already answer. |
| A broadcast ping reports "no motors" on a healthy arm. | Pings motor IDs one at a time. |
| A board with USB but no motor power looks "on" (red PW light). | Detects it and says to push the barrel plug in. |
| A garbage reading right after homing gets saved as a joint limit. | Ignores a settle window and rejects physically impossible jumps. |
| A joint swept only partway still gets saved. | Range rings show coverage per joint; saving waits until each reaches 80%. |
| The follower snaps to the leader's pose when teleoperation starts. | Eases into the pose over a second. |
| One missed read ends teleoperation. | Retries, then reconnects, before giving up. |

## Layout

```
sidecar/   Python hardware sidecar (JSON lines over stdin/stdout), tests, simulated arms
app/       Tauri shell (src-tauri/) and the web UI (src/)
docs/      Design mockups
scripts/   Dev helpers
```

## Development

Requirements: [uv](https://docs.astral.sh/uv/), Node 20+ with pnpm, and Rust (the repo pins 1.96).

```sh
# Sidecar
cd sidecar
uv sync
uv run pytest            # logic + end-to-end protocol tests against simulated arms

# App, with simulated arms (no hardware needed)
cd app
pnpm install
PIVOT_SIDECAR_ARGS="--fake" pnpm tauri dev

# Other simulated scenarios: leader_unpowered, glitch
PIVOT_SIDECAR_ARGS="--fake --scenario leader_unpowered" pnpm tauri dev

# Real arms: plug both boards in, then
pnpm tauri dev
```

The sidecar can also be driven by hand:

```sh
cd sidecar
echo '{"id":1,"method":"list_boards"}' | uv run pivot-sidecar --fake
```

## Status

Prototype. Works end to end against simulated arms; hardware testing is in progress.

Not yet: setting motor IDs on new motors (use `lerobot-setup-motors`), automatic calibration
for the claw arm, cameras and recording, packaged builds that bundle Python.
