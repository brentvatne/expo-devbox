#!/usr/bin/env bash
# Builds the iOS app with Xcode, installs it on the booted simulator, launches it,
# and saves a screenshot to build/screenshot.png. Runs on the devbox worker.
#
#   ./scripts/devbox-build.sh          incremental build
#   ./scripts/devbox-build.sh --pods   run `pod install` first (after adding or
#                                      removing native files, or editing a podspec)
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build

if [[ "${1:-}" == "--pods" ]]; then
  (cd ios && pod install > ../build/pods.log 2>&1) || { tail -40 build/pods.log; exit 1; }
fi

workspace=$(ls -d ios/*.xcworkspace | head -1)
scheme=$(basename "$workspace" .xcworkspace)
bundle_id=$(node -p "require('./app.json').expo.ios.bundleIdentifier")
udid=$(cat ~/.devbox-sim)
derived=build/DerivedData

start=$(date +%s)
if ! xcodebuild -workspace "$workspace" -scheme "$scheme" -configuration Debug \
  -sdk iphonesimulator -destination "platform=iOS Simulator,id=$udid" \
  -derivedDataPath "$derived" build > build/xcodebuild.log 2>&1; then
  grep -E "(error|fatal error):" build/xcodebuild.log | sort -u | head -40
  echo "BUILD FAILED after $(( $(date +%s) - start ))s. Full log: build/xcodebuild.log"
  exit 1
fi
echo "BUILD SUCCEEDED in $(( $(date +%s) - start ))s"

if ! curl -sf http://localhost:8081/status > /dev/null; then
  echo "Metro is not running. Start it with: (env -u CI npx expo start --localhost > ~/metro.log 2>&1 < /dev/null &)"
fi

log_start=$(( $(wc -l < ~/metro.log 2> /dev/null || echo 0) + 1 ))
xcrun simctl terminate "$udid" "$bundle_id" 2> /dev/null || true
xcrun simctl install "$udid" "$derived/Build/Products/Debug-iphonesimulator/$scheme.app"
xcrun simctl launch "$udid" "$bundle_id" > /dev/null
sleep "${SCREENSHOT_DELAY:-8}"
xcrun simctl io "$udid" screenshot build/screenshot.png > /dev/null 2>&1
echo "Launched $bundle_id. Screenshot: build/screenshot.png. App console output from this launch:"
tail -n +"$log_start" ~/metro.log | grep -a -E '^ (LOG|WARN|ERROR) ' || echo "(none)"
