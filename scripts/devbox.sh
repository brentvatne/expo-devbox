#!/usr/bin/env bash
# Local driver for the iOS devbox workflow (.eas/workflows/ios-devbox.yml).
#
#   ./scripts/devbox.sh start [minutes] [idle-minutes]  start a session; wait until SSH works
#   ./scripts/devbox.sh attach [run-id]   reconnect, for example after the worker restarted its tunnel
#   ./scripts/devbox.sh sync              copy local sources to the worker
#   ./scripts/devbox.sh build [--pods|--prebuild]  sync, build, launch, print logs, copy the screenshot
#   ./scripts/devbox.sh logs [pattern]    search the app console output from Metro
#   ./scripts/devbox.sh ssh [command]     run a command in ~/project on the worker, or open a shell
#   ./scripts/devbox.sh joblog            print the workflow job log
#   ./scripts/devbox.sh stop              cancel the session and wait until it has ended
#
# Requires: eas-cli (logged in) and cloudflared. Creates the key ~/.ssh/eas_devbox.
set -euo pipefail
cd "$(dirname "$0")/.."

state=.devbox
key="$HOME/.ssh/eas_devbox"
mkdir -p "$state"

saved_run() {
  cat "$state/run_id" 2> /dev/null || { echo "No devbox session. Run: $0 start" >&2; exit 1; }
}

run_field() {
  eas workflow:view "$1" --json --non-interactive 2> /dev/null |
    node -e "const r = JSON.parse(require('fs').readFileSync(0, 'utf8')); console.log($2 ?? '')" 2> /dev/null ||
    echo UNKNOWN
}

is_active() {
  [[ "$1" =~ ^(NEW|WAITING|IN_PROGRESS|ACTION_REQUIRED|UNKNOWN)$ ]]
}

fail_if_ended() {
  local status
  status=$(run_field "$1" r.status)
  if ! is_active "$status"; then
    echo "The devbox session ended with status $status. See: eas workflow:view $1" >&2
    exit 1
  fi
}

remote() {
  ssh -F "$state/ssh_config" devbox "cd ~/project && $*"
}

# Reads the tunnel host, user and host key from the job log and writes an SSH
# config for them. The last DEVBOX_SSH_HOST wins, because the worker starts a
# new tunnel, with a new host, if the old one exits.
connect() {
  local run_id=$1 job_id logs host user hostkey
  echo "Waiting for the worker to open its tunnel (run $run_id)..." >&2
  for _ in $(seq 90); do
    fail_if_ended "$run_id"
    job_id=$(run_field "$run_id" 'r.jobs?.[0]?.id')
    if [[ -n "$job_id" && "$job_id" != UNKNOWN ]]; then
      logs=$(eas workflow:logs "$job_id" --non-interactive 2> /dev/null || true)
      host=$(grep -oE 'DEVBOX_SSH_HOST=[a-z0-9.-]+' <<< "$logs" | tail -1 | cut -d= -f2 || true)
      user=$(grep -oE 'DEVBOX_SSH_USER=[A-Za-z0-9_-]+' <<< "$logs" | tail -1 | cut -d= -f2 || true)
      hostkey=$(grep -oE 'DEVBOX_SSH_HOSTKEY=ssh-ed25519 [A-Za-z0-9+/=]+' <<< "$logs" | tail -1 | cut -d= -f2- || true)
      if [[ -n "$host" && -n "$user" && -n "$hostkey" ]]; then
        echo "$host $hostkey" > "$state/known_hosts"
        cat > "$state/ssh_config" << EOF
Host devbox
  HostName $host
  User $user
  ProxyCommand cloudflared access ssh --hostname %h
  IdentityFile $key
  IdentitiesOnly yes
  StrictHostKeyChecking yes
  UserKnownHostsFile $PWD/$state/known_hosts
  ConnectTimeout 20
  ServerAliveInterval 30
  ControlMaster auto
  ControlPath ~/.ssh/cm-devbox-%C
  ControlPersist 5m
EOF
        # A new quick tunnel can take a few seconds to resolve in DNS.
        for _ in $(seq 12); do
          if ssh -F "$state/ssh_config" devbox true 2> "$state/ssh_error"; then
            echo "Connected to $user@$host." >&2
            return 0
          fi
          sleep 5
        done
        echo "Could not connect to $user@$host:" >&2
        cat "$state/ssh_error" >&2
        exit 1
      fi
    fi
    sleep 10
  done
  echo "The worker did not report an SSH host within 15 minutes. See: eas workflow:view $run_id" >&2
  exit 1
}

wait_until_ready() {
  local run_id
  run_id=$(saved_run)
  for _ in $(seq 80); do
    if ssh -F "$state/ssh_config" devbox 'test -f ~/.devbox/ready' 2> /dev/null; then
      return 0
    fi
    fail_if_ended "$run_id"
    echo "Waiting for the worker to finish its first build..." >&2
    sleep 15
  done
  echo "The worker is not ready after 20 minutes, or it is unreachable. If its tunnel restarted, run: $0 attach" >&2
  exit 1
}

cmd=${1:-}
shift || true
case "$cmd" in
  start)
    if [[ -f "$state/run_id" ]] && is_active "$(run_field "$(cat "$state/run_id")" r.status)"; then
      echo "A devbox session is already running (run $(cat "$state/run_id")). Use '$0 attach' or '$0 stop'." >&2
      exit 1
    fi
    [[ -f "$key" ]] || ssh-keygen -q -t ed25519 -N '' -C eas-devbox -f "$key"
    run_id=$(EAS_NO_VCS=1 eas workflow:run .eas/workflows/ios-devbox.yml --non-interactive --json \
      -F "ssh_public_key=$(cat "$key.pub")" -F "minutes=${1:-60}" -F "idle_minutes=${2:-15}" |
      node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).id')
    echo "$run_id" > "$state/run_id"
    # Cancel the run if this command fails, so it does not bill with nobody connected.
    trap 'if [[ -z "${started:-}" ]]; then echo "Cancelling run $run_id." >&2; eas workflow:cancel "$run_id" --non-interactive > /dev/null 2>&1 || true; fi' EXIT
    connect "$run_id"
    started=1
    echo "The worker is still preparing the project. '$0 build' waits for it." >&2
    ;;
  attach)
    run_id=${1:-$(saved_run)}
    echo "$run_id" > "$state/run_id"
    connect "$run_id"
    ;;
  sync)
    # Sends what git would track. .gitignore patterns also protect worker-only
    # files (such as a generated ios/) from --delete. rsync cannot express
    # gitignore's `!` re-includes, so those lines are dropped.
    {
      grep -v -E '^[[:space:]]*!' .gitignore 2> /dev/null || true
      git ls-files -oi --exclude-standard --directory 2> /dev/null | sed 's|^|/|' || true
    } > "$state/rsync-excludes"
    rsync -az --delete -e "ssh -F $state/ssh_config" \
      --exclude .git --exclude node_modules --exclude /.devbox --exclude /ios/Pods \
      --exclude-from="$state/rsync-excludes" \
      ./ devbox:project/
    ;;
  build)
    wait_until_ready
    "$0" sync
    rm -f "$state/screenshot.png"
    status=0
    remote "./scripts/devbox-build.sh ${1:-}" || status=$?
    if scp -q -F "$state/ssh_config" devbox:.devbox/screenshot.png "$state/screenshot.png" 2> /dev/null; then
      echo "Screenshot copied to $state/screenshot.png"
    fi
    exit $status
    ;;
  logs)
    remote "grep -a -E $(printf %q "${1:-.}") ~/.devbox/metro.log | tail -50"
    ;;
  ssh)
    if [[ $# -eq 0 ]]; then
      ssh -F "$state/ssh_config" -t devbox 'cd ~/project && exec $SHELL'
    else
      remote "$@"
    fi
    ;;
  joblog)
    eas workflow:logs "$(run_field "$(saved_run)" 'r.jobs?.[0]?.id')" --non-interactive
    ;;
  stop)
    run_id=$(saved_run)
    eas workflow:cancel "$run_id" --non-interactive
    status=0
    eas workflow:status "$run_id" --wait --non-interactive > /dev/null 2>&1 || status=$?
    case $status in
      0) echo "The session had already finished." ;;
      12) echo "The session is canceled." ;;
      *) echo "Could not confirm that run $run_id ended (exit $status). Check: eas workflow:view $run_id" >&2; exit 1 ;;
    esac
    ssh -F "$state/ssh_config" -O exit devbox 2> /dev/null || true
    ;;
  *)
    sed -n '2,13p' "$0"
    exit 1
    ;;
esac
