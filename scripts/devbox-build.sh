#!/usr/bin/env bash
# Builds the iOS app with Xcode, installs it on the devbox simulator, launches it,
# and prints its logs. Runs on the devbox worker. Exits non-zero when the build
# fails, the app is not running after launch, or devbox.env's checks fail.
#
#   devbox-build.sh             incremental build
#   devbox-build.sh --pods      run `pod install` first (after adding or removing
#                               native files, or editing a podspec)
#   devbox-build.sh --prebuild  install dependencies, run `expo prebuild` and
#                               `pod install` first (after changing package.json,
#                               app config or config plugins)
set -euo pipefail
cd "$(dirname "$0")/.."
state="$HOME/.devbox"
if [[ -f devbox.env ]]; then
  source devbox.env
fi

prepare_log="$state/prepare.log"
prepare() {
  echo "Running: $*"
  if ! "$@" >> "$prepare_log" 2>&1; then
    tail -30 "$prepare_log"
    echo "FAILED: $*. Full log: $prepare_log"
    exit 1
  fi
}
pod_install() { (cd ios && pod install); }

: > "$prepare_log"
case "${1:-}" in
  --prebuild)
    if [[ -f bun.lock || -f bun.lockb ]]; then
      prepare bun install
    elif [[ -f pnpm-lock.yaml ]]; then
      prepare pnpm install
    elif [[ -f yarn.lock ]]; then
      prepare yarn install
    else
      prepare npm install
    fi
    if [[ -f "$state/cng" ]]; then
      prepare npx expo prebuild --platform ios --no-install
    fi
    prepare pod_install
    ;;
  --pods)
    prepare pod_install
    ;;
esac

workspace=$(ls -d ios/*.xcworkspace | head -1)
scheme=${DEVBOX_SCHEME:-$(basename "$workspace" .xcworkspace)}
udid=$(cat "$state/sim")
derived="$state/DerivedData"
build_log="$state/xcodebuild.log"
rm -f "$state/screenshot.png"

start=$(date +%s)
if ! xcodebuild -workspace "$workspace" -scheme "$scheme" -configuration Debug \
  -sdk iphonesimulator -destination "platform=iOS Simulator,id=$udid" \
  -derivedDataPath "$derived" build > "$build_log" 2>&1; then
  if ! grep -E "(error|fatal error):" "$build_log" | sort -u | head -40; then
    tail -30 "$build_log"
  fi
  echo "BUILD FAILED after $(( $(date +%s) - start ))s. Full log: $build_log"
  exit 1
fi
echo "BUILD SUCCEEDED in $(( $(date +%s) - start ))s"

if ! curl -sf http://localhost:8081/status > /dev/null; then
  echo "Metro is not running. The worker restarts it within a minute; run the build again then."
  exit 1
fi

app=$(find "$derived/Build/Products/Debug-iphonesimulator" -maxdepth 1 -name '*.app' | head -1)
bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Info.plist")
executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Info.plist")
metro_log="$state/metro.log"
native_log="$state/native.log"
log_start=$(( $(wc -l < "$metro_log") + 1 ))

xcrun simctl install "$udid" "$app"
# Messages logged by code inside the app bundle, plus NSLog (sent from
# Foundation, with no subsystem); not the system libraries' own logging.
# `subsystem == ""` never matches, so "no subsystem" is written as no dot.
xcrun simctl spawn "$udid" log stream --style compact --predicate "process == \"$executable\" AND \
(senderImagePath CONTAINS \"/$executable.app/\" OR (senderImagePath ENDSWITH \"/Foundation\" AND NOT subsystem CONTAINS \".\"))" \
  > "$native_log" 2>&1 &
log_stream=$!
xcrun simctl launch --terminate-running-process "$udid" "$bundle_id" > /dev/null

app_output() { tail -n +"$log_start" "$metro_log" | grep -a -E '^ (LOG|WARN|ERROR) ' || true; }
# Simulator apps run as processes of the host.
app_running() { pgrep -f "/$executable.app/$executable" > /dev/null; }
status=0
if [[ -n "${DEVBOX_WAIT_FOR:-}" ]]; then
  for i in $(seq "${DEVBOX_WAIT_SECONDS:-60}"); do
    grep -q -E "$DEVBOX_WAIT_FOR" <<< "$(app_output)" && break
    (( i > 3 )) && ! app_running && break
    sleep 1
  done
else
  sleep "${DEVBOX_WAIT_SECONDS:-8}"
fi
xcrun simctl io "$udid" screenshot "$state/screenshot.png" > /dev/null 2>&1 || echo "Could not take a screenshot."
kill "$log_stream" 2> /dev/null || true

echo "App console output from this launch:"
output=$(app_output)
echo "${output:-(none)}"
echo "Native log from this launch (Apple frameworks excluded):"
native=$(grep -v -E '^(Filtering the log data|Timestamp |getpwuid_r |Child process terminated)' "$native_log" | tail -40 || true)
echo "${native:-(none)}"

if ! app_running; then
  echo "The app is not running. It may have crashed at launch."
  report=$(find "$HOME/Library/Logs/DiagnosticReports" -name "$executable*.ips" -newer "$app/Info.plist" 2> /dev/null |
    xargs ls -t 2> /dev/null | head -1 || true)
  if [[ -n "$report" ]]; then
    echo "Crash report $report:"
    # An .ips file is a JSON header line followed by the JSON report.
    tail -n +2 "$report" | node -e '
      const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
      console.log(`${r.exception?.type} (${r.exception?.signal}), ${r.termination?.indicator ?? ""}`);
      const thread = r.threads?.find((t) => t.triggered);
      for (const f of thread?.frames?.slice(0, 15) ?? []) {
        const where = f.sourceFile ? ` (${f.sourceFile}:${f.sourceLine})` : "";
        console.log(`  ${r.usedImages?.[f.imageIndex]?.name ?? "?"}  ${f.symbol ?? "?"}${where}`);
      }' || head -40 "$report"
  fi
  status=1
fi
if [[ -n "${DEVBOX_WAIT_FOR:-}" ]] && ! grep -q -E "$DEVBOX_WAIT_FOR" <<< "$output"; then
  echo "The app did not log a line matching DEVBOX_WAIT_FOR ($DEVBOX_WAIT_FOR)."
  status=1
fi
if [[ -n "${DEVBOX_FAIL_ON:-}" ]] && grep -q -E "$DEVBOX_FAIL_ON" <<< "$output"; then
  echo "The app logged a line matching DEVBOX_FAIL_ON ($DEVBOX_FAIL_ON)."
  status=1
fi
exit $status
