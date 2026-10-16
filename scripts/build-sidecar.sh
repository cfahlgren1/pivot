#!/bin/sh
# Freezes the Python sidecar into a self-contained folder that the Tauri bundle ships as a resource.
set -eu
cd "$(dirname "$0")/../sidecar"

# Heavy ML and imaging packages are excluded: the motor path never uses them (see packaging/torch_stub.py).
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
  --runtime-hook packaging/torch_stub.py \
  --exclude-module torch \
  --exclude-module torchvision \
  --exclude-module torchcodec \
  --exclude-module cv2 \
  --exclude-module PIL \
  --exclude-module av \
  --exclude-module hf_xet \
  --exclude-module safetensors \
  packaging/entry.py

# Smoke test: load every LeRobot path Pivot uses (no hardware needed; each request fails at the serial port).
# Catches LeRobot changes that need more of torch than packaging/torch_stub.py provides.
printf '%s\n' \
  '{"id":1,"method":"probe","params":{"port":"/dev/pivot-smoke"}}' \
  '{"id":2,"method":"calibrate_begin","params":{"role":"follower","port":"/dev/pivot-smoke","arm_id":"smoke"}}' \
  '{"id":3,"method":"calibrate_begin","params":{"role":"leader","port":"/dev/pivot-smoke","arm_id":"smoke"}}' |
  build/dist/pivot-sidecar/pivot-sidecar 2>/dev/null >build/smoke.jsonl
if grep -E '"type":"(ImportError|ModuleNotFoundError|AttributeError)"' build/smoke.jsonl; then
  echo "Frozen sidecar is missing a module (see above)." >&2
  exit 1
fi
