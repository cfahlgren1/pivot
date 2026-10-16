#!/bin/sh
# Freezes the Python sidecar into a self-contained folder that the Tauri bundle ships as a resource.
set -eu
cd "$(dirname "$0")/../sidecar"

# LeRobot imports the motor SDKs lazily and checks their package metadata first, so collect both explicitly.
uv run --group build pyinstaller --noconfirm --clean --onedir --name pivot-sidecar \
  --distpath build/dist --workpath build/work --specpath build \
  --collect-submodules lerobot.motors \
  --collect-submodules lerobot.robots.so_follower \
  --collect-submodules lerobot.teleoperators.so_leader \
  --collect-submodules scservo_sdk \
  --collect-submodules serial \
  --collect-submodules deepdiff \
  --copy-metadata feetech-servo-sdk \
  --copy-metadata pyserial \
  --copy-metadata deepdiff \
  packaging/entry.py
