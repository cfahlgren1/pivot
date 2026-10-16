#!/bin/sh
# Builds a self-contained Pivot.app and a .dmg for this Mac's architecture into dist/.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

version="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' app/src-tauri/tauri.conf.json)"
arch="$(uname -m)"
app="app/src-tauri/target/release/bundle/macos/Pivot.app"
dmg="dist/Pivot_${version}_${arch}.dmg"

./scripts/build-sidecar.sh
(cd app && pnpm install --frozen-lockfile && pnpm tauri build --bundles app)

# ditto keeps the symlinks inside the frozen Python framework intact.
rm -rf "$app/Contents/Resources/pivot-sidecar"
ditto sidecar/build/dist/pivot-sidecar "$app/Contents/Resources/pivot-sidecar"

# Ad-hoc signature: required to run on Apple Silicon. Not notarized, so first launch needs right-click → Open.
codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app"

staging="$(mktemp -d)"
ditto "$app" "$staging/Pivot.app"
ln -s /Applications "$staging/Applications"
mkdir -p dist
rm -f "$dmg"
hdiutil create -volname Pivot -srcfolder "$staging" -format UDZO -ov "$dmg" >/dev/null
rm -rf "$staging"
echo "Built $dmg"
