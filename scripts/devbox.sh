#!/usr/bin/env bash
# Local driver for the iOS devbox workflow (.eas/workflows/ios-devbox.yml).
#
#   ./scripts/devbox.sh start [minutes]  start a run and wait until SSH is reachable
#   ./scripts/devbox.sh attach <run-id>  connect to a run that is already up
#   ./scripts/devbox.sh sync             copy local sources to the worker
#   ./scripts/devbox.sh build [--pods]   sync, build with Xcode, launch, fetch the screenshot
#   ./scripts/devbox.sh logs [pattern]   show app console output from Metro on the worker
#   ./scripts/devbox.sh ssh [command]    run a command in ~/project on the worker
#   ./scripts/devbox.sh stop             end the run
#
# Requires: eas-cli (logged in), cloudflared, and the key ~/.ssh/eas_devbox.
set -euo pipefail
cd "$(dirname "$0")/.."

state=build/devbox
key="$HOME/.ssh/eas_devbox"
mkdir -p "$state"

remote() {
  ssh -F "$state/ssh_config" devbox "cd ~/project && $*"
}

wait_for_ssh() {
  local run_id=$1 found status host user
  echo "Waiting for the worker to open the tunnel (run $run_id)..." >&2
  for _ in $(seq 120); do
    status=0
    found=$(node scripts/devbox-host.mjs "$run_id") || status=$?
    [[ $status -eq 1 ]] && exit 1
    if [[ $status -eq 0 ]]; then
      read -r host user <<< "$found"
      cat > "$state/ssh_config" << EOF
Host devbox
  HostName $host
  User $user
  ProxyCommand cloudflared access ssh --hostname %h
  IdentityFile $key
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
  UserKnownHostsFile $PWD/$state/known_hosts
  ServerAliveInterval 30
  ControlMaster auto
  ControlPath ~/.ssh/cm-devbox-%C
  ControlPersist 10m
EOF
      rm -f "$state/known_hosts"
      # A new quick tunnel can take a few seconds to resolve in DNS.
      for _ in $(seq 12); do
        if ssh -F "$state/ssh_config" -o ConnectTimeout=20 devbox true 2> "$state/ssh_error"; then
          echo "Connected to $user@$host." >&2
          return 0
        fi
        sleep 5
      done
      echo "Could not connect to $user@$host:" >&2
      cat "$state/ssh_error" >&2
      exit 1
    fi
    sleep 10
  done
  echo "The worker did not report an SSH host. Check the run: eas workflow:view $run_id" >&2
  exit 1
}

cmd=${1:-}
shift || true
case "$cmd" in
  start)
    [[ -f "$key" ]] || ssh-keygen -q -t ed25519 -N '' -C eas-devbox -f "$key"
    run_id=$(EAS_NO_VCS=1 eas workflow:run .eas/workflows/ios-devbox.yml --non-interactive --json \
      -F "ssh_public_key=$(base64 < "$key.pub" | tr -d '\n')" -F "minutes=${1:-90}" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).id')
    echo "$run_id" > "$state/run_id"
    wait_for_ssh "$run_id"
    echo "The worker is still preparing the project. './scripts/devbox.sh build' waits for it." >&2
    ;;
  attach)
    echo "$1" > "$state/run_id"
    wait_for_ssh "$1"
    ;;
  sync)
    rsync -az --delete -e "ssh -F $state/ssh_config" \
      --exclude .git --exclude node_modules --exclude /ios --exclude /android --exclude /build \
      ./ devbox:project/
    ;;
  build)
    until ssh -F "$state/ssh_config" devbox 'test -f ~/devbox-ready'; do echo "Waiting for the first build on the worker..." >&2; sleep 15; done
    "$0" sync
    rm -f "$state/screenshot.png"
    remote "./scripts/devbox-build.sh $*"
    scp -q -F "$state/ssh_config" devbox:project/build/screenshot.png "$state/screenshot.png"
    echo "Screenshot copied to $state/screenshot.png"
    ;;
  logs)
    remote "grep -a -E '${1:-.}' ~/metro.log | tail -50"
    ;;
  ssh)
    if [[ $# -eq 0 ]]; then ssh -F "$state/ssh_config" -t devbox 'cd ~/project && exec $SHELL -l'; else remote "$@"; fi
    ;;
  stop)
    remote 'touch ~/devbox-done' || eas workflow:cancel "$(cat "$state/run_id")" --non-interactive
    ;;
  *)
    sed -n '2,11p' "$0"
    exit 1
    ;;
esac
